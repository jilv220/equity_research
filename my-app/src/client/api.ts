// Wire schemas for the Worker's JSON API (see src/worker.ts and src/scoring/score.ts).
import { Schema } from 'effect'

export const Metric = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  formula: Schema.String,
  value: Schema.NullOr(Schema.Number),
  unit: Schema.String,
  display: Schema.String,
  band: Schema.String,
  points: Schema.Number,
  max: Schema.Number,
  inputs: Schema.Record(Schema.String, Schema.String),
  note: Schema.optionalKey(Schema.String),
  evidence: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String),
})
export type Metric = typeof Metric.Type

export const Section = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  max: Schema.Number,
  points: Schema.Number,
  metrics: Schema.Array(Metric),
})
export type Section = typeof Section.Type

export const Scorecard = Schema.Struct({
  ticker: Schema.String,
  cik: Schema.Number,
  name: Schema.String,
  sic: Schema.String,
  sicDescription: Schema.String,
  asOf: Schema.String,
  latestFy: Schema.String,
  fiscalYears: Schema.Array(Schema.String),
  excluded: Schema.optionalKey(Schema.String),
  sections: Schema.Array(Section),
  rawTotal: Schema.Number,
  gated: Schema.Boolean,
  total: Schema.Number,
  rating: Schema.String,
  ttmRoic: Schema.NullOr(Schema.Number),
  computedAt: Schema.String,
})
export type Scorecard = typeof Scorecard.Type

export const Job = Schema.Struct({
  id: Schema.String,
  startedAt: Schema.String,
  status: Schema.String,
  error: Schema.optionalKey(Schema.String),
})
export type Job = typeof Job.Type

export const ScoreResponse = Schema.Struct({
  ticker: Schema.String,
  card: Schema.OptionFromNullOr(Scorecard),
  job: Schema.OptionFromNullOr(Job),
})
export type ScoreResponse = typeof ScoreResponse.Type

export const Summary = Schema.Struct({
  ticker: Schema.String,
  name: Schema.String,
  total: Schema.Number,
  rating: Schema.String,
  ttmRoic: Schema.NullOr(Schema.Number),
  gated: Schema.Boolean,
  asOf: Schema.String,
  computedAt: Schema.String,
})
export type Summary = typeof Summary.Type

export const Watchlist = Schema.Array(Summary)

export const ErrorBody = Schema.Struct({ error: Schema.String })

/** Workflow statuses that mean the background job is still going. */
const ACTIVE_JOB_STATUSES: ReadonlyArray<string> = [
  'queued',
  'running',
  'paused',
  'waiting',
  'waitingForPause',
  'unknown',
]

export const isJobActive = (job: Job): boolean =>
  ACTIVE_JOB_STATUSES.includes(job.status)

/** Daily valuation multiples (see src/valuation/multiples.ts). Columnar: index i is one trading day. */
export const Valuation = Schema.Struct({
  ticker: Schema.String,
  computedAt: Schema.String,
  dates: Schema.Array(Schema.String),
  close: Schema.Array(Schema.Number),
  pe: Schema.Array(Schema.NullOr(Schema.Number)),
  pb: Schema.Array(Schema.NullOr(Schema.Number)),
  ps: Schema.Array(Schema.NullOr(Schema.Number)),
  notes: Schema.Array(Schema.String),
})
export type Valuation = typeof Valuation.Type
