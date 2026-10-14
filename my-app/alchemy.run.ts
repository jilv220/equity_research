// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Bucket } from "./src/bucket.ts";

// SEC EDGAR requires every request to identify the caller: "<app name> <contact email>".
// https://www.sec.gov/os/accessing-edgar-data
const SEC_USER_AGENT = "EquityResearchPlatform lyuji.ba@pm.me";

export interface ScoreParams {
  /** Ticker to score. Omitted on scheduled runs, which re-score the whole watchlist. */
  ticker?: string;
  /** Bypass the 12h cache of SEC data. */
  fresh?: boolean;
}

// Scoring runs as a durable background job: fetch filings (network, retried) → parse and score (CPU).
// The nightly schedule re-scores every company on the watchlist.
export const ScoreWorkflow = Cloudflare.Workflow<ScoreParams>("ScoreWorkflow", {
  className: "ScoreWorkflow",
  schedules: ["0 6 * * *"],
});

// The Foldkit client (index.html + src/client) is built by Vite and served as static assets;
// src/worker.ts runs first for /api/* and hosts the ScoreWorkflow. Every other path serves the app.
export const Worker = Cloudflare.Website.Foldkit("Worker", {
  main: "./src/worker.ts",
  env: { Bucket, SEC_USER_AGENT, SCORE_WORKFLOW: ScoreWorkflow },
  assets: { runWorkerFirst: ["/api/*"] },
  // Edge-cache /api reads; responses opt in with Cache-Control and are purged by Cache-Tag on re-score.
  cache: { enabled: true, crossVersionCache: true },
});

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const bucket = yield* Bucket;
    const worker = yield* Worker;

    return {
      bucketName: bucket.bucketName,
      url: worker.url,
    };
  }),
);
