// Valuation percentiles: where today's P/E, P/B and P/S sit within the stock's own history.
// Pure functions over the API's daily series; the view calls `breakdown`, which is memoized because
// every render (e.g. each keystroke in the ticker input) would otherwise recompute it.
import type { Valuation } from './api'

export const VALUATION_WINDOWS = ['1Y', '5Y', '10Y', 'All'] as const
export type ValuationWindow = (typeof VALUATION_WINDOWS)[number]

export const MULTIPLES = ['pe', 'pb', 'ps'] as const
export type Multiple = (typeof MULTIPLES)[number]
export type SeriesKey = 'composite' | Multiple

const WINDOW_YEARS: Record<ValuationWindow, number | null> = { '1Y': 1, '5Y': 5, '10Y': 10, All: null }

/** A percentile needs at least this many daily observations… */
const MIN_OBSERVATIONS = 60
/** …and, for a fixed window, at least this share of the window's trading days. */
const MIN_COVERAGE = 0.5
/** Upper bound on plotted points; longer ranges are sampled evenly. */
const CHART_POINTS = 240

export interface Reading {
  /** Today's multiple, or null when it isn't meaningful (e.g. negative earnings). */
  value: number | null
  /** 0 = cheapest in the window, 100 = most expensive; null without enough history. */
  percentile: number | null
}

export interface Breakdown {
  asOf: string
  composite: number | null
  readings: Record<Multiple, Reading>
  chart: { dates: ReadonlyArray<string>; series: Record<SeriesKey, ReadonlyArray<number | null>> }
}

const minusYears = (date: string, years: number) => `${globalThis.Number(date.slice(0, 4)) - years}${date.slice(4)}`

/** First index whose date is ≥ `date` (dates ascending). */
const lowerBound = (dates: ReadonlyArray<string>, date: string) => {
  let lo = 0
  let hi = dates.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (dates[mid]! < date) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Percentile rank of values[at] among values[from..at], ties counted as half. */
const percentileAt = (values: ReadonlyArray<number | null>, from: number, at: number, fixedWindow: boolean) => {
  const current = values[at]
  if (current === null || current === undefined) return null
  let below = 0
  let equal = 0
  let n = 0
  for (let i = from; i <= at; i++) {
    const v = values[i]
    if (v === null || v === undefined) continue
    n++
    if (v < current) below++
    else if (v === current) equal++
  }
  const enough = n >= MIN_OBSERVATIONS && (!fixedWindow || n >= MIN_COVERAGE * (at - from + 1))
  return enough ? ((below + equal / 2) / n) * 100 : null
}

const mean = (xs: ReadonlyArray<number | null>) => {
  const present = xs.filter((x): x is number => x !== null)
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0) / present.length
}

const compute = (v: Valuation, window: ValuationWindow): Breakdown => {
  const last = v.dates.length - 1
  const years = WINDOW_YEARS[window]
  const lookbackStart = (i: number) => (years === null ? 0 : lowerBound(v.dates, minusYears(v.dates[i]!, years)))
  const percentiles = (i: number) => {
    const from = lookbackStart(i)
    return MULTIPLES.map(m => percentileAt(v[m], from, i, years !== null))
  }

  const today = percentiles(last)
  const readings = Object.fromEntries(
    MULTIPLES.map((m, k) => [m, { value: v[m][last] ?? null, percentile: today[k] ?? null }]),
  ) as Record<Multiple, Reading>

  // Chart: each point's percentile against its own trailing window (expanding from the start for All).
  const first = lookbackStart(last)
  const step = Math.max(1, Math.ceil((last - first + 1) / CHART_POINTS))
  const dates: string[] = []
  const series: Record<SeriesKey, (number | null)[]> = { composite: [], pe: [], pb: [], ps: [] }
  const sampled: number[] = []
  for (let i = first; i < last; i += step) sampled.push(i)
  sampled.push(last) // always end on today, so the chart's last point matches the cards
  for (const at of sampled) {
    const p = percentiles(at)
    dates.push(v.dates[at]!)
    MULTIPLES.forEach((m, k) => series[m].push(p[k] ?? null))
    series.composite.push(mean(p))
  }

  return { asOf: v.dates[last]!, composite: mean(today), readings, chart: { dates, series } }
}

const memo = new WeakMap<Valuation, Map<ValuationWindow, Breakdown>>()

/** Percentile breakdown for `window`; null when there's no price history at all. */
export const breakdown = (v: Valuation, window: ValuationWindow): Breakdown | null => {
  if (v.dates.length === 0) return null
  const byWindow = memo.get(v) ?? new Map<ValuationWindow, Breakdown>()
  memo.set(v, byWindow)
  const hit = byWindow.get(window)
  if (hit) return hit
  const result = compute(v, window)
  byWindow.set(window, result)
  return result
}

/** Plain-language band for a percentile. */
export const valuationBand = (p: number): { label: string; tone: 'good' | 'muted' | 'mid' | 'bad' } =>
  p < 20
    ? { label: 'Cheap', tone: 'good' }
    : p < 40
      ? { label: 'Below average', tone: 'good' }
      : p < 60
        ? { label: 'Average', tone: 'muted' }
        : p < 80
          ? { label: 'Above average', tone: 'mid' }
          : { label: 'Expensive', tone: 'bad' }
