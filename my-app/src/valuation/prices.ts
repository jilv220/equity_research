// Daily share prices. SEC filings carry none, so this is the one non-filing input, used only by the
// valuation panel (never the scorecard). Source: Yahoo Finance's public chart endpoint (unofficial,
// no key). Kept behind this module so another provider can be swapped in.

export interface DailyPrices {
  /** Trading days, ascending (YYYY-MM-DD). */
  dates: string[];
  /** Split-adjusted closes: every price is on today's share basis. */
  close: number[];
  /** Stock splits, ascending. `ratio` is new shares per old share (10 for a 10-for-1). */
  splits: { date: string; ratio: number }[];
}

export class PriceError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

const day = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

/** Raw response body for the full daily history of `ticker` (SEC-style, e.g. BRK-B). */
export async function fetchDailyPrices(ticker: string): Promise<string> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d&events=split`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
  if (!res.ok) throw new PriceError(`Yahoo Finance returned ${res.status} for ${ticker}`, res.status === 404 ? 404 : 502);
  return res.text();
}

export function parseDailyPrices(body: string): DailyPrices {
  type Chart = {
    chart: {
      result?: {
        timestamp?: number[];
        indicators: { quote: { close: (number | null)[] }[] };
        events?: { splits?: Record<string, { date: number; numerator: number; denominator: number }> };
      }[];
      error?: { description?: string } | null;
    };
  };
  const r = (JSON.parse(body) as Chart).chart.result?.[0];
  if (!r?.timestamp) throw new PriceError("Yahoo Finance returned no price history", 404);
  const closes = r.indicators.quote[0]?.close ?? [];
  const dates: string[] = [];
  const close: number[] = [];
  r.timestamp.forEach((t, i) => {
    const c = closes[i];
    if (c !== null && c !== undefined && c > 0) {
      dates.push(day(t));
      close.push(c);
    }
  });
  const splits = Object.values(r.events?.splits ?? {})
    .filter((s) => s.numerator > 0 && s.denominator > 0)
    .map((s) => ({ date: day(s.date), ratio: s.numerator / s.denominator }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { dates, close, splits };
}
