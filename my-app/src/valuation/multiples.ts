// Daily P/E, P/B and P/S history from split-adjusted prices and point-in-time SEC fundamentals.
// Each filing's numbers take effect on the day it was filed, so every day's multiple uses only what
// the market could have known then. Percentiles are computed by the client from this series.
import { days, fiscalYearEnds, series, ttm, type CompanyFacts, type RawFact } from "../scoring/facts.ts";
import { LINE_ITEMS } from "../scoring/score.ts";
import type { DailyPrices } from "./prices.ts";

export interface ValuationSeries {
  ticker: string;
  computedAt: string;
  /** Trading days, ascending, from the first day fundamentals and a share count are both known. */
  dates: string[];
  close: number[];
  /** Multiples per day; null when the denominator is ≤ 0 or no recent filing covers the day. */
  pe: (number | null)[];
  pb: (number | null)[];
  ps: (number | null)[];
  notes: string[];
}

/** A filing's fundamentals stop being used once they're older than this (a missed filing, a delisting gap). */
const MAX_AGE_DAYS = 400;

/** First (original) filing date of each period end across `concepts`, from 10-K / 10-Q facts. */
function firstFiled(cf: CompanyFacts, concepts: readonly string[], unit = "USD"): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of concepts) {
    for (const f of cf.facts["us-gaap"]?.[c]?.units[unit] ?? []) {
      if (!f.form.startsWith("10-K") && !f.form.startsWith("10-Q")) continue;
      const prev = out.get(f.end);
      if (!prev || f.filed < prev) out.set(f.end, f.filed);
    }
  }
  return out;
}

/** Product of split ratios strictly after `date`: converts a share count on that date to today's basis. */
const splitFactorAfter = (splits: DailyPrices["splits"], date: string) =>
  splits.filter((s) => s.date > date).reduce((a, s) => a * s.ratio, 1);

interface Snapshot<T> {
  /** The day the market could first know this (the filing date). */
  effective: string;
  value: T;
}

/** Latest snapshot effective on or before each successive date. Dates must be visited in ascending order. */
function cursor<T>(snaps: Snapshot<T>[]) {
  let i = -1;
  return (date: string): Snapshot<T> | undefined => {
    while (i + 1 < snaps.length && snaps[i + 1]!.effective <= date) i++;
    return i >= 0 ? snaps[i] : undefined;
  };
}

/**
 * Share counts on today's split basis, effective from their filing date. The 10-K/10-Q cover count
 * (dei:EntityCommonStockSharesOutstanding) is preferred; filers that only report it per share class
 * (absent from companyfacts) fall back to diluted weighted-average shares.
 */
function shareSnapshots(cf: CompanyFacts, splits: DailyPrices["splits"]): { snaps: Snapshot<number>[]; source: string } {
  const byAccn = new Map<string, RawFact & { total: number }>();
  for (const f of cf.facts.dei?.EntityCommonStockSharesOutstanding?.units.shares ?? []) {
    if (!f.form.startsWith("10-K") && !f.form.startsWith("10-Q")) continue;
    // Several classes in one filing without dimensions: sum them.
    const prev = byAccn.get(f.accn);
    byAccn.set(f.accn, prev && prev.end === f.end ? { ...prev, total: prev.total + f.val } : { ...f, total: f.val });
  }
  const cover = [...byAccn.values()].map((f) => ({ effective: f.filed, value: f.total * splitFactorAfter(splits, f.end) }));
  if (cover.length >= 4) return { snaps: cover.sort((a, b) => a.effective.localeCompare(b.effective)), source: "cover-page shares outstanding" };

  // Next: balance-sheet shares outstanding (all classes combined, e.g. GOOGL), as originally filed.
  const original = new Map<string, RawFact>();
  for (const f of cf.facts["us-gaap"]?.CommonStockSharesOutstanding?.units.shares ?? []) {
    if (f.start || (!f.form.startsWith("10-K") && !f.form.startsWith("10-Q"))) continue;
    const prev = original.get(f.end);
    if (!prev || f.filed < prev.filed) original.set(f.end, f);
  }
  const balance = [...original.values()].map((f) => ({ effective: f.filed, value: f.val * splitFactorAfter(splits, f.end) }));
  if (balance.length >= 4) return { snaps: balance.sort((a, b) => a.effective.localeCompare(b.effective)), source: "balance-sheet shares outstanding" };

  // Last resort: diluted weighted-average shares, as originally filed, shortest period per end.
  const best = new Map<string, RawFact>();
  for (const f of cf.facts["us-gaap"]?.WeightedAverageNumberOfDilutedSharesOutstanding?.units.shares ?? []) {
    if (!f.start || (!f.form.startsWith("10-K") && !f.form.startsWith("10-Q"))) continue;
    const prev = best.get(f.end);
    const shorter = prev && days(f.start, f.end) < days(prev.start!, prev.end);
    if (!prev || shorter || (days(f.start, f.end) === days(prev.start!, prev.end) && f.filed < prev.filed)) best.set(f.end, f);
  }
  const weighted = [...best.values()].map((f) => ({ effective: f.filed, value: f.val * splitFactorAfter(splits, f.end) }));
  return { snaps: weighted.sort((a, b) => a.effective.localeCompare(b.effective)), source: "diluted weighted-average shares" };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

export function valuationSeries(ticker: string, cf: CompanyFacts, prices: DailyPrices): ValuationSeries {
  const revenue = series(cf, "revenue", [...LINE_ITEMS.revenue]);
  const netIncome = series(cf, "netIncome", [...LINE_ITEMS.netIncome]);
  const equity = series(cf, "equity", [...LINE_ITEMS.equity]);
  const fyEnds = fiscalYearEnds(revenue.empty ? netIncome : revenue);

  // Fundamentals at each reported period end, effective from that period's original filing date.
  const filed = firstFiled(cf, [...LINE_ITEMS.revenue, ...LINE_ITEMS.netIncome]);
  const ends = [...filed.keys()].filter((e) => netIncome.facts.some((f) => f.start !== undefined && f.end === e)).sort();
  const fundamentals: Snapshot<{ end: string; ni?: number; rev?: number; eq?: number }>[] = ends
    .map((end) => ({
      effective: filed.get(end)!,
      value: {
        end,
        ni: ttm(netIncome, end, fyEnds)?.value,
        rev: ttm(revenue, end, fyEnds)?.value,
        eq: equity.instant(end, 8)?.val,
      },
    }))
    .filter((s) => s.value.ni !== undefined || s.value.rev !== undefined || s.value.eq !== undefined)
    .sort((a, b) => a.effective.localeCompare(b.effective));

  const shares = shareSnapshots(cf, prices.splits);
  const fundAt = cursor(fundamentals);
  const sharesAt = cursor(shares.snaps);

  const out: ValuationSeries = {
    ticker,
    computedAt: new Date().toISOString(),
    dates: [],
    close: [],
    pe: [],
    pb: [],
    ps: [],
    notes: [`Market cap = split-adjusted close × ${shares.source}. Each filing's figures apply from its filing date.`],
  };

  prices.dates.forEach((date, i) => {
    const f = fundAt(date);
    const s = sharesAt(date);
    if (!f || !s || days(f.value.end, date) > MAX_AGE_DAYS) return;
    const cap = prices.close[i]! * s.value;
    const multiple = (den: number | undefined) => (den !== undefined && den > 0 ? round(cap / den) : null);
    out.dates.push(date);
    out.close.push(round(prices.close[i]!));
    out.pe.push(multiple(f.value.ni));
    out.pb.push(multiple(f.value.eq));
    out.ps.push(multiple(f.value.rev));
  });
  if (out.dates.length === 0) out.notes.push("No overlap between price history and filed fundamentals.");
  return out;
}
