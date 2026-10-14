// src/worker.ts — HTTP API + UI for the monopoly scorecard, and the background scoring Workflow.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { ScoreParams, WorkerEnv } from "../alchemy.run.ts";
import { edgar, EdgarError, type Cache } from "./scoring/edgar.ts";
import type { Scorecard } from "./scoring/score.ts";

const HOUR = 3_600_000;
/** Scores older than this are re-queued when viewed (the nightly run normally keeps them fresh). */
const STALE_MS = 36 * HOUR;
/** Don't automatically retry a ticker whose last job failed more recently than this. */
const ERROR_BACKOFF_MS = 10 * 60_000;
/** Nightly re-scores: companies released per batch, and the pause between batches. */
const PACE_BATCH = 10;
const PACE_DELAY = "10 seconds";
const ACTIVE = new Set(["queued", "running", "paused", "waiting", "waitingForPause", "unknown"]);
const TERMINAL = new Set(["complete", "errored", "terminated"]);

/**
 * Edge cache (Workers Cache) for reads. Scores only change when a job writes a new one, and every
 * write purges the tags below, so the edge can hold responses for a long time. Browsers always
 * revalidate (max-age=0) so they never show a score the edge has already replaced. The TTL only
 * bounds staleness if a purge is ever missed.
 */
const EDGE_TTL_S = 6 * 3600;
const WATCHLIST_TAG = "watchlist";
const scoreTag = (t: string) => `score:${t}`;
const cacheFor = (tags: string[]) => ({
  "cache-control": `public, max-age=0, s-maxage=${EDGE_TTL_S}`,
  "cache-tag": tags.join(","),
});
const NO_STORE = { "cache-control": "no-store" };

interface Summary {
  ticker: string;
  name: string;
  total: number;
  rating: string;
  ttmRoic: number | null;
  gated: boolean;
  asOf: string;
  computedAt: string;
}

interface Job {
  id: string;
  startedAt: string;
  /** Saved once the job reaches a terminal state, so later reads skip the Workflow status call. */
  status?: string;
  error?: string;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = NO_STORE) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

/** Drop cached reads that show `ticker`'s score and the watchlist. Best effort: the TTL is the backstop. */
async function purgeScore(cache: CacheContext | undefined, ticker: string) {
  try {
    await cache?.purge({ tags: [scoreTag(ticker), WATCHLIST_TAG] });
  } catch (e) {
    console.warn(`cache purge failed for ${ticker}`, e);
  }
}

const normalize = (ticker: string) => ticker.trim().toUpperCase().replace(/\./g, "-");
const scoreKey = (t: string) => `scores/${t}.json`;
const jobKey = (t: string) => `jobs/${t}.json`;

const r2Cache = (bucket: R2Bucket): Cache => ({
  async get(key, maxAgeMs) {
    const obj = await bucket.get(key);
    if (!obj) return null;
    if (Date.now() - obj.uploaded.getTime() > maxAgeMs) return null;
    return obj.text();
  },
  async put(key, body) {
    await bucket.put(key, body);
  },
});

const summarize = (c: Scorecard): Summary => ({
  ticker: c.ticker,
  name: c.name,
  total: c.total,
  rating: c.rating,
  ttmRoic: c.ttmRoic,
  gated: c.gated,
  asOf: c.asOf,
  computedAt: c.computedAt,
});

async function readJson<T>(bucket: R2Bucket, key: string): Promise<{ value: T; uploaded: Date } | null> {
  const obj = await bucket.get(key);
  return obj ? { value: (await obj.json()) as T, uploaded: obj.uploaded } : null;
}

async function watchlist(bucket: R2Bucket): Promise<Summary[]> {
  const rows: Summary[] = [];
  let cursor: string | undefined;
  do {
    const list = await bucket.list({ prefix: "scores/", cursor, include: ["customMetadata"] });
    for (const o of list.objects) {
      const s = o.customMetadata?.summary;
      if (s) rows.push(JSON.parse(s));
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return rows;
}

async function startJob(env: WorkerEnv, ticker: string, fresh: boolean): Promise<Job> {
  const instance = await env.SCORE_WORKFLOW.create({ params: { ticker, fresh } });
  const job = { id: instance.id, startedAt: new Date().toISOString() };
  await env.Bucket.put(jobKey(ticker), JSON.stringify(job));
  return job;
}

/**
 * Background scoring. With a ticker: fetch that company's filings, then parse and score them.
 * Without one (the nightly schedule): queue a fresh re-score for every company on the watchlist.
 */
export class ScoreWorkflow extends WorkflowEntrypoint<WorkerEnv, ScoreParams> {
  async run(event: Readonly<WorkflowEvent<ScoreParams>>, step: WorkflowStep) {
    const env = this.env;
    const ticker = event.payload?.ticker ? normalize(event.payload.ticker) : undefined;

    if (!ticker) {
      const tickers = await step.do("list watchlist", async () =>
        (await watchlist(env.Bucket)).map((s) => normalize(s.ticker)),
      );
      // One instance per company, released a few at a time so SEC sees ≲3 requests/second
      // (its limit is 10/s per caller). 1,000 companies take about 17 minutes.
      for (let i = 0; i < tickers.length; i += PACE_BATCH) {
        if (i > 0) await step.sleep(`pace ${i}`, PACE_DELAY);
        const chunk = tickers.slice(i, i + PACE_BATCH);
        await step.do(`queue re-scores ${i}`, async () => {
          const instances = await env.SCORE_WORKFLOW.createBatch(chunk.map((t) => ({ params: { ticker: t, fresh: true } })));
          await Promise.all(
            instances.map((inst, j) =>
              env.Bucket.put(jobKey(chunk[j]!), JSON.stringify({ id: inst.id, startedAt: new Date().toISOString() })),
            ),
          );
          return instances.length;
        });
      }
      return { queued: tickers.length };
    }

    const sec = edgar(env.SEC_USER_AGENT, r2Cache(env.Bucket));

    // Network only: SEC hiccups are retried here without redoing any parsing.
    const fetched = await step.do(
      "fetch filings",
      { retries: { limit: 4, delay: "15 seconds", backoff: "exponential" }, timeout: "5 minutes" },
      async () => {
        try {
          return await sec.prefetch(ticker, event.payload?.fresh ?? false);
        } catch (e) {
          if (e instanceof EdgarError && e.status === 404) throw new NonRetryableError(e.message);
          throw e;
        }
      },
    );

    // CPU: parse XBRL + filing text and compute the scorecard. Reads only from the R2 cache.
    return await step.do(
      "score",
      { retries: { limit: 2, delay: "10 seconds", backoff: "constant" }, timeout: "5 minutes" },
      async () => {
        const card = await sec.score(fetched.ticker);
        const summary = summarize(card);
        await env.Bucket.put(scoreKey(ticker), JSON.stringify(card), {
          customMetadata: { summary: JSON.stringify(summary) },
        });
        const job = await readJson<Job>(env.Bucket, jobKey(ticker));
        if (job?.value.id === event.instanceId) {
          await env.Bucket.put(jobKey(ticker), JSON.stringify({ ...job.value, status: "complete" }));
        }
        await purgeScore(this.ctx.cache, ticker);
        return summary;
      },
    );
  }
}

/**
 * The job's current state. A terminal state saved in R2 is used as is; otherwise the Workflow is asked,
 * and the first time a job is seen finished its state is saved and the cached reads are purged.
 */
async function jobState(env: WorkerEnv, ctx: ExecutionContext, ticker: string, job: Job): Promise<Job & { status: string }> {
  if (job.status && TERMINAL.has(job.status)) return { ...job, status: job.status };
  try {
    const st = await (await env.SCORE_WORKFLOW.get(job.id)).status();
    const next = { ...job, status: st.status, error: st.error?.message.replace(/^NonRetryableError:\s*/, "") };
    if (TERMINAL.has(st.status)) {
      await env.Bucket.put(jobKey(ticker), JSON.stringify(next));
      // Awaited, not waitUntil: the UI refetches the watchlist as soon as this poll reports completion.
      await purgeScore(ctx.cache, ticker);
    }
    return next;
  } catch {
    return { ...job, status: "unknown" };
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Only /api/* reaches this handler first (assets.runWorkerFirst); anything else is the Foldkit app.
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

    // GET /api/score/:ticker[?refresh=1 | ?job=<id>]
    // Returns the stored scorecard (if any) and the background job's state, starting a job when the
    // score is missing, stale, or a refresh was asked for. A settled score is edge-cached; while a job
    // runs the UI polls with ?job=<id>, a separate URL that is never cached.
    const m = path.match(/^\/api\/score\/([A-Za-z0-9.\-]{1,10})$/);
    if (m) {
      const ticker = normalize(m[1]!);
      const refresh = url.searchParams.get("refresh") === "1";
      const isPoll = url.searchParams.has("job");
      const [card, prev] = await Promise.all([
        readJson<Scorecard>(env.Bucket, scoreKey(ticker)),
        readJson<Job>(env.Bucket, jobKey(ticker)),
      ]);

      let job = prev ? await jobState(env, ctx, ticker, prev.value) : null;
      const active = job !== null && ACTIVE.has(job.status) && Date.now() - Date.parse(job.startedAt) < HOUR;
      const recentFailure =
        job?.status === "errored" && Date.now() - Date.parse(job.startedAt) < ERROR_BACKOFF_MS && !refresh;
      const stale = !card || Date.now() - card.uploaded.getTime() > STALE_MS;

      // Polls only report progress; they never start another job.
      if (!isPoll && !active && !recentFailure && (refresh || stale)) {
        job = { ...(await startJob(env, ticker, refresh)), status: "queued" };
      }
      const isSettled = !refresh && !isPoll && !stale && !(job && ACTIVE.has(job.status));
      return json({ ticker, card: card?.value ?? null, job }, 200, isSettled ? cacheFor([scoreTag(ticker)]) : NO_STORE);
    }

    // GET /api/scores — every scored company, ranked by score, ties broken by TTM ROIC.
    if (path === "/api/scores") {
      const rows = await watchlist(env.Bucket);
      rows.sort((a, b) => b.total - a.total || (b.ttmRoic ?? -Infinity) - (a.ttmRoic ?? -Infinity));
      return json(rows, 200, cacheFor([WATCHLIST_TAG]));
    }

    return json({ error: "Not found" }, 404);
  },
};
