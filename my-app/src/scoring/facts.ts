// XBRL fact extraction from SEC companyfacts JSON.
// Turns raw tagged facts into fiscal-year series, TTM values and balance-sheet instants.

export interface RawFact {
  start?: string;
  end: string;
  val: number;
  accn: string;
  fy: number;
  fp: string;
  form: string;
  filed: string;
  frame?: string;
}

export interface CompanyFacts {
  cik: number;
  entityName: string;
  facts: Record<string, Record<string, { units: Record<string, RawFact[]> }>>;
}

export interface Fact extends RawFact {
  concept: string;
}

const DAY = 86_400_000;

export const days = (a: string, b: string) =>
  Math.round((Date.parse(b) - Date.parse(a)) / DAY);

const near = (a: string, b: string, tol: number) => Math.abs(days(a, b)) <= tol;

const isAnnual = (f: Fact) => f.start !== undefined && days(f.start, f.end) >= 350 && days(f.start, f.end) <= 380;

const periodicForm = (form: string) => form.startsWith("10-K") || form.startsWith("10-Q");

/**
 * A line item resolved from one or more XBRL concepts, in priority order.
 * Per reporting period the highest-priority concept wins; within a concept
 * the most recently filed value wins (so restatements replace originals).
 */
export class Series {
  readonly label: string;
  readonly facts: Fact[];
  constructor(label: string, facts: Fact[]) {
    this.label = label;
    this.facts = facts;
  }

  get empty() {
    return this.facts.length === 0;
  }

  /** Duration value for an exact period (start/end within a few days). */
  duration(start: string, end: string, tol = 4): Fact | undefined {
    return this.facts.find(
      (f) => f.start !== undefined && near(f.start, start, tol) && near(f.end, end, tol),
    );
  }

  /** Annual (fiscal-year) value ending on `end`. */
  annual(end: string): Fact | undefined {
    return this.facts.find((f) => isAnnual(f) && f.form.startsWith("10-K") && near(f.end, end, 4));
  }

  /** Balance-sheet value at `date`. */
  instant(date: string, tol = 4): Fact | undefined {
    let best: Fact | undefined;
    for (const f of this.facts) {
      if (f.start !== undefined) continue;
      const d = Math.abs(days(f.end, date));
      if (d <= tol && (!best || d < Math.abs(days(best.end, date)))) best = f;
    }
    return best;
  }

  /** All fiscal-year end dates this series reports, ascending. */
  annualEnds(): string[] {
    const ends = new Set<string>();
    for (const f of this.facts) if (isAnnual(f) && f.form.startsWith("10-K")) ends.add(f.end);
    return [...ends].sort();
  }

  /** Latest period end of any duration fact. */
  latestDurationEnd(): string | undefined {
    let latest: string | undefined;
    for (const f of this.facts) if (f.start !== undefined && (!latest || f.end > latest)) latest = f.end;
    return latest;
  }
}

export function series(cf: CompanyFacts, label: string, concepts: string[], unit = "USD"): Series {
  const gaap = cf.facts["us-gaap"] ?? {};
  const byPeriod = new Map<string, Fact>();
  for (const concept of concepts) {
    const raw = gaap[concept]?.units[unit];
    if (!raw) continue;
    const latest = new Map<string, Fact>();
    for (const r of raw) {
      if (!periodicForm(r.form)) continue;
      const key = `${r.start ?? ""}|${r.end}`;
      const prev = latest.get(key);
      if (!prev || r.filed > prev.filed) latest.set(key, { ...r, concept });
    }
    for (const [key, f] of latest) if (!byPeriod.has(key)) byPeriod.set(key, f);
  }
  return new Series(label, [...byPeriod.values()]);
}

/** Fiscal years as a consecutive run of FY end dates (oldest first). A gap breaks the run. */
export function fiscalYearEnds(s: Series): string[] {
  const ends = s.annualEnds();
  const run: string[] = [];
  for (let i = ends.length - 1; i >= 0; i--) {
    const e = ends[i]!;
    if (run.length > 0) {
      const gap = days(e, run[0]!);
      if (gap < 350 || gap > 380) break;
    }
    run.unshift(e);
  }
  return run;
}

export const addYears = (date: string, n: number) => {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
};

const addDays = (date: string, n: number) =>
  new Date(Date.parse(date + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);

export interface TTM {
  value: number;
  method: string;
}

/**
 * Trailing-twelve-month value at `asOf` = sum of the last four reported quarters,
 * computed as latest FY + current YTD − prior-year YTD (identical to summing quarters,
 * and works for cash-flow items that are only reported year-to-date).
 */
export function ttm(s: Series, asOf: string, fyEnds: string[]): TTM | undefined {
  const fyAtAsOf = fyEnds.find((e) => near(e, asOf, 4));
  if (fyAtAsOf) {
    const a = s.annual(fyAtAsOf);
    return a && { value: a.val, method: `FY ending ${a.end}` };
  }
  const lastFy = [...fyEnds].reverse().find((e) => e < asOf);
  if (!lastFy) return undefined;
  const fy = s.annual(lastFy);
  const ytd = s.duration(addDays(lastFy, 1), asOf);
  const prevFy = [...fyEnds].reverse().find((e) => e < lastFy);
  const priorYtd = prevFy ? s.duration(addDays(prevFy, 1), addYears(asOf, -1), 8) : undefined;
  if (!fy || !ytd || !priorYtd) return undefined;
  return {
    value: fy.val + ytd.val - priorYtd.val,
    method: `FY ${lastFy} + YTD to ${asOf} − YTD to ${priorYtd.end}`,
  };
}
