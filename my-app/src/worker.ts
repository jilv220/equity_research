// src/worker.ts — HTTP API + UI for the monopoly scorecard, and the background scoring Workflow.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { ScoreParams, WorkerEnv } from "../alchemy.run.ts";
import { edgar, EdgarError, type Cache } from "./scoring/edgar.ts";
import type { Scorecard } from "./scoring/score.ts";
import { page } from "./ui.ts";

const HOUR = 3_600_000;
/** Scores older than this are re-queued when viewed (the nightly run normally keeps them fresh). */
const STALE_MS = 36 * HOUR;
/** Don't automatically retry a ticker whose last job failed more recently than this. */
const ERROR_BACKOFF_MS = 10 * 60_000;
/** Nightly re-scores: companies released per batch, and the pause between batches. */
const PACE_BATCH = 10;
const PACE_DELAY = "10 seconds";
const ACTIVE = new Set(["queued", "running", "paused", "waiting", "waitingForPause", "unknown"]);

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
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

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
        return summary;
      },
    );
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

    if (path === "/" || path === "/index.html") {
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // GET /api/score/:ticker[?refresh=1]
    // Returns the stored scorecard (if any) and the background job's state, starting a job when the
    // score is missing, stale, or a refresh was asked for. The UI polls this until the job finishes.
    const m = path.match(/^\/api\/score\/([A-Za-z0-9.\-]{1,10})$/);
    if (m) {
      const ticker = normalize(m[1]!);
      const refresh = url.searchParams.get("refresh") === "1";
      const [card, prev] = await Promise.all([
        readJson<Scorecard>(env.Bucket, scoreKey(ticker)),
        readJson<Job>(env.Bucket, jobKey(ticker)),
      ]);

      let job: (Job & { status: string; error?: string }) | null = null;
      if (prev) {
        try {
          const st = await (await env.SCORE_WORKFLOW.get(prev.value.id)).status();
          job = { ...prev.value, status: st.status, error: st.error?.message };
        } catch {
          job = { ...prev.value, status: "unknown" };
        }
      }
      const active = job !== null && ACTIVE.has(job.status) && Date.now() - Date.parse(job.startedAt) < HOUR;
      const recentFailure =
        job?.status === "errored" && Date.now() - Date.parse(job.startedAt) < ERROR_BACKOFF_MS && !refresh;
      const stale = !card || Date.now() - card.uploaded.getTime() > STALE_MS;

      if (!active && !recentFailure && (refresh || stale)) {
        job = { ...(await startJob(env, ticker, refresh)), status: "queued" };
      }
      return json({ ticker, card: card?.value ?? null, job });
    }

    // GET /api/scores — every scored company, ranked by score, ties broken by TTM ROIC.
    if (path === "/api/scores") {
      const rows = await watchlist(env.Bucket);
      rows.sort((a, b) => b.total - a.total || (b.ttmRoic ?? -Infinity) - (a.ttmRoic ?? -Infinity));
      return json(rows);
    }

    return json({ error: "Not found" }, 404);
  },
};
