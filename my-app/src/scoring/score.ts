// The strict monopoly scorecard: fixed formulas on GAAP line items, hard thresholds.
import {
  addYears,
  fiscalYearEnds,
  series,
  ttm,
  Series,
  type CompanyFacts,
  type Fact,
} from "./facts.ts";

export const TAX_RATE = 0.21;
export const HURDLE = 0.12;
export const GATE_ROIC = 0.08;
export const GATE_CAP = 50;

// ---------------------------------------------------------------------------
// Line items → XBRL concepts (priority order). This mapping IS the formula's
// definition of each line item; change it here and every company changes alike.
// ---------------------------------------------------------------------------
export const LINE_ITEMS = {
  revenue: [
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
    "SalesRevenueGoodsNet",
    "SalesRevenueServicesNet",
  ],
  grossProfit: ["GrossProfit"],
  costOfRevenue: [
    "CostOfRevenue",
    "CostOfGoodsAndServicesSold",
    "CostOfGoodsSold",
    "CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization",
  ],
  operatingIncome: ["OperatingIncomeLoss"],
  // Fallbacks for filers with no operating-income subtotal (see operatingIncomeSeries).
  pretaxIncome: [
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
  ],
  nonoperatingIncome: ["NonoperatingIncomeExpense"],
  interestExpense: ["InterestExpenseNonoperating", "InterestExpense", "InterestExpenseDebt"],
  interestIncome: ["InvestmentIncomeInterest", "InvestmentIncomeInterestAndDividend"],
  otherNonoperating: ["OtherNonoperatingIncomeExpense"],
  netIncome: ["NetIncomeLoss"],
  rnd: [
    "ResearchAndDevelopmentExpense",
    "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost",
  ],
  sga: ["SellingGeneralAndAdministrativeExpense"],
  sellingMarketing: ["SellingAndMarketingExpense"],
  generalAdmin: ["GeneralAndAdministrativeExpense"],
  ocf: [
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
  ],
  sbc: ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
  buybacks: ["PaymentsForRepurchaseOfCommonStock"],
  dividends: ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"],
  dna: [
    "DepreciationDepletionAndAmortization",
    "DepreciationAndAmortization",
    "DepreciationAmortizationAndAccretionNet",
  ],
  equity: [
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    "StockholdersEquity",
  ],
  debtTotal: [
    "LongTermDebt",
    "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities",
  ],
  debtNoncurrent: ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations"],
  debtCurrent: ["LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent"],
  shortTermBorrowings: ["ShortTermBorrowings"],
  commercialPaper: ["CommercialPaper"],
  cashAndSti: ["CashCashEquivalentsAndShortTermInvestments"],
  cash: [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    "Cash",
  ],
  sti: [
    "ShortTermInvestments",
    "MarketableSecuritiesCurrent",
    "AvailableForSaleSecuritiesDebtSecuritiesCurrent",
  ],
} as const;

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------
type Band = { label: string; points: number; test: (v: number) => boolean };

/** Higher is better; lower bound inclusive (ground rule 4). */
const atLeast = (cuts: [number, number][], floorLabel: string): Band[] => [
  ...cuts.map(([min, points], i) => ({
    label: i === 0 ? `≥${fmtCut(min)}` : `${fmtCut(min)}–${fmtCut(cuts[i - 1]![0])}`,
    points,
    test: (v: number) => v >= min,
  })),
  { label: floorLabel, points: 0, test: () => true },
];

/** Lower is better; the table writes these as ≤x / x–y / >z, so each band's upper bound is inclusive. */
const atMost = (cuts: [number, number][], ceilLabel: string): Band[] => [
  ...cuts.map(([max, points], i) => ({
    label: i === 0 ? `≤${fmtCut(max)}` : `${fmtCut(cuts[i - 1]![0])}–${fmtCut(max)}`,
    points,
    test: (v: number) => v <= max,
  })),
  { label: ceilLabel, points: 0, test: () => true },
];

let cutUnit = "";
const fmtCut = (n: number) => `${n}${cutUnit}`;
const withUnit = <T,>(unit: string, f: () => T): T => {
  cutUnit = unit;
  try {
    return f();
  } finally {
    cutUnit = "";
  }
};

// All percentage metrics are stored as fractions; bands use percent units for readability.
const BANDS = {
  A1: withUnit("%", () => atLeast([[30, 10], [20, 7], [12, 4], [8, 2]], "<8%")),
  A3: withUnit("%", () => atLeast([[70, 6], [55, 4], [40, 2]], "<40%")),
  A4: withUnit(" pts", () => atMost([[2, 6], [5, 4], [10, 2]], ">10 pts")),
  B1: withUnit("", () => atLeast([[1.5, 5], [1.1, 3], [0.9, 1]], "<0.9")),
  B2: withUnit(" pts", () => atLeast([[2, 5], [0, 3], [-2, 1]], "<−2 pts")),
  B3: withUnit("%", () => atLeast([[15, 5], [10, 3], [5, 1]], "<5%")),
  B4: withUnit("%", () => atMost([[8, 5], [12, 3], [18, 1]], ">18%")),
  B5: withUnit("%", () => atLeast([[20, 5], [10, 3], [5, 1]], "<5%")),
  C2: withUnit("%", () => [
    { label: "0%", points: 5, test: (v: number) => v === 0 },
    { label: "<20%", points: 3, test: (v: number) => v < 20 },
    { label: "20–40%", points: 1, test: (v: number) => v <= 40 },
    { label: ">40%", points: 0, test: () => true },
  ]),
  D1: withUnit("%", () => atLeast([[35, 5], [25, 3], [15, 1]], "<15%")),
  D2: withUnit("", () => atLeast([[1.2, 5], [1.0, 3], [0.8, 1]], "<0.8")),
  E2: withUnit("%", () => atLeast([[10, 3], [1, 2], [0.1, 1]], "<0.1%")),
  E3: withUnit("%", () => atMost([[3, 3], [6, 2], [10, 1]], ">10%")),
  F1: withUnit("%", () => atLeast([[30, 5], [20, 3], [10, 1]], "<10%")),
  F2: withUnit("%", () => atMost([[25, 5], [50, 3], [75, 1]], ">75%")),
};

const band = (bands: Band[], v: number) => bands.find((b) => b.test(v))!;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------
export type Unit = "pct" | "ratio" | "pts" | "count" | "x" | "text";

export interface Metric {
  id: string;
  name: string;
  formula: string;
  value: number | null;
  unit: Unit;
  display: string;
  band: string;
  points: number;
  max: number;
  inputs: Record<string, string>;
  note?: string;
  evidence?: string;
  source?: string;
}

export interface Section {
  id: string;
  name: string;
  max: number;
  points: number;
  metrics: Metric[];
}

export interface TextInputs {
  founder: { points: number; band: string; detail: string; evidence?: string; source?: string };
  insiderPct: { value: number | null; detail: string; evidence?: string; source?: string };
  customerConcentrationPct: { value: number | null; detail: string; evidence?: string; source?: string };
}

export interface Scorecard {
  ticker: string;
  cik: number;
  name: string;
  sic: string;
  sicDescription: string;
  asOf: string;
  latestFy: string;
  fiscalYears: string[];
  excluded?: string;
  sections: Section[];
  rawTotal: number;
  gated: boolean;
  total: number;
  rating: string;
  ttmRoic: number | null;
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const pct = (v: number | null, dp = 1) => (v === null ? "n/a" : `${(v * 100).toFixed(dp)}%`);
const usd = (v: number | undefined | null) => {
  if (v === undefined || v === null) return "n/a";
  const a = Math.abs(v);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a.toFixed(0);
  return `${v < 0 ? "−" : ""}$${s}`;
};
const cagr = (start: number, end: number, years: number) => Math.pow(end / start, 1 / years) - 1;

const metric = (
  m: Omit<Metric, "band" | "points" | "display"> & { display?: string },
  bands: Band[] | null,
  scale = 100,
): Metric => {
  if (m.value === null || !bands)
    return { display: m.display ?? "n/a", band: m.value === null ? "no data" : "", points: 0, ...m };
  const b = band(bands, m.value * scale);
  return {
    display:
      m.display ??
      (m.unit === "pct" ? pct(m.value) : m.unit === "pts" ? `${(m.value * 100).toFixed(2)} pts` : m.value.toFixed(2)),
    band: b.label,
    points: b.points,
    ...m,
  };
};

const unscored = (id: string, name: string, formula: string, max: number, unit: Unit, note: string, inputs: Record<string, string> = {}): Metric => ({
  id,
  name,
  formula,
  value: null,
  unit,
  display: "n/a",
  band: "no data",
  points: 0,
  max,
  inputs,
  note,
});

/** A metric that doesn't apply to this kind of company: max 0, so it drops out of the total. */
const notApplicable = (id: string, name: string, formula: string, unit: Unit, note: string): Metric => ({
  ...unscored(id, name, formula, 0, unit, note),
  band: "not applicable",
});

/**
 * Operating income, falling back per period when OperatingIncomeLoss isn't tagged
 * (e.g. LLY never tags it; JNJ stopped in 2015):
 *   1. OperatingIncomeLoss
 *   2. Pre-tax income − non-operating income (expense)
 *   3. Pre-tax income + interest expense − interest income − other non-operating income (expense):
 *      the same split as 2, for filers that tag the pieces but not the total (JNJ).
 * Derived facts carry a "derived: …" concept so the scorecard can say how the number was built.
 */
function operatingIncomeSeries(S: (key: keyof typeof LINE_ITEMS) => Series): Series {
  const reported = S("operatingIncome");
  const pretax = S("pretaxIncome");
  const nonop = S("nonoperatingIncome");
  const intExp = S("interestExpense");
  const intInc = S("interestIncome");
  const other = S("otherNonoperating");
  const derived: Fact[] = [];
  for (const p of pretax.facts) {
    if (p.start === undefined || reported.duration(p.start, p.end)) continue;
    const n = nonop.duration(p.start, p.end);
    if (n) {
      derived.push({ ...p, val: p.val - n.val, concept: "derived: pre-tax income − non-operating income" });
      continue;
    }
    const ie = intExp.duration(p.start, p.end);
    if (ie) {
      const ii = intInc.duration(p.start, p.end)?.val ?? 0;
      const o = other.duration(p.start, p.end)?.val ?? 0;
      derived.push({ ...p, val: p.val + ie.val - ii - o, concept: "derived: pre-tax income + net interest expense − other non-operating income" });
    }
  }
  return derived.length === 0 ? reported : new Series(reported.label, [...reported.facts, ...derived]);
}

const EXCLUDED_SIC: [number, number, string][] = [
  [6011, 6036, "bank"],
  [6211, 6211, "broker-dealer"],
  [6311, 6399, "insurer"],
  [6798, 6798, "REIT"],
];

export const ratingFor = (score: number) =>
  score >= 80 ? "Monopoly" : score >= 60 ? "Strong moat" : score >= 40 ? "Contested" : "Competitive market";

// ---------------------------------------------------------------------------
// The scorecard
// ---------------------------------------------------------------------------
export function scoreCompany(args: {
  ticker: string;
  facts: CompanyFacts;
  sic: string;
  sicDescription: string;
  text: TextInputs;
}): Scorecard {
  const { facts: cf, text } = args;
  const S = (key: keyof typeof LINE_ITEMS) => series(cf, key, [...LINE_ITEMS[key]]);

  const revenue = S("revenue");
  const opInc = operatingIncomeSeries(S);
  const fyEnds = fiscalYearEnds(revenue.empty ? opInc : revenue);
  const latestFy = fyEnds.at(-1) ?? "";
  const lastEnd = revenue.latestDurationEnd() ?? latestFy;
  const asOf = lastEnd > latestFy ? lastEnd : latestFy;

  const base = {
    ticker: args.ticker,
    cik: cf.cik,
    name: cf.entityName,
    sic: args.sic,
    sicDescription: args.sicDescription,
    asOf,
    latestFy,
    fiscalYears: fyEnds.slice(-11),
    computedAt: new Date().toISOString(),
  };

  const sicNum = Number(args.sic);
  const exchange = sicNum === 6200;
  const excl = EXCLUDED_SIC.find(([lo, hi]) => sicNum >= lo && sicNum <= hi);
  if (excl) {
    return {
      ...base,
      excluded: `Excluded: SIC ${args.sic} (${args.sicDescription}) is a ${excl[2]}; ROIC is not meaningful (ground rule 6).`,
      sections: [],
      rawTotal: 0,
      gated: false,
      total: 0,
      rating: "Excluded",
      ttmRoic: null,
    };
  }

  // ---- derived line items -------------------------------------------------
  const grossProfitS = S("grossProfit");
  const cogsS = S("costOfRevenue");
  const grossProfitAnnual = (end: string): number | undefined => {
    const gp = grossProfitS.annual(end)?.val;
    if (gp !== undefined) return gp;
    const r = revenue.annual(end)?.val;
    const c = cogsS.annual(end)?.val;
    return r !== undefined && c !== undefined ? r - c : undefined;
  };
  const grossProfitTtm = () => {
    const gp = ttm(grossProfitS, asOf, fyEnds);
    if (gp) return { value: gp.value, how: "GrossProfit" };
    const r = ttm(revenue, asOf, fyEnds);
    const c = ttm(cogsS, asOf, fyEnds);
    return r && c ? { value: r.value - c.value, how: "Revenue − cost of revenue" } : undefined;
  };

  const sgaS = S("sga");
  const smS = S("sellingMarketing");
  const gaS = S("generalAdmin");
  const sgaTtm = () => {
    const v = ttm(sgaS, asOf, fyEnds);
    if (v) return v.value;
    const sm = ttm(smS, asOf, fyEnds);
    const ga = ttm(gaS, asOf, fyEnds);
    return sm && ga ? sm.value + ga.value : undefined;
  };

  const equityS = S("equity");
  const debtTotalS = S("debtTotal");
  const debtNcS = S("debtNoncurrent");
  const debtCurS = S("debtCurrent");
  const stbS = S("shortTermBorrowings");
  const cpS = S("commercialPaper");
  const cashStiS = S("cashAndSti");
  const cashS = S("cash");
  const stiS = S("sti");

  const tol = 8;
  const debtAt = (d: string) => {
    const total = debtTotalS.instant(d, tol)?.val;
    const nc = debtNcS.instant(d, tol)?.val;
    const cur = debtCurS.instant(d, tol)?.val;
    const lt = total ?? (nc !== undefined || cur !== undefined ? (nc ?? 0) + (cur ?? 0) : 0);
    return lt + (stbS.instant(d, tol)?.val ?? 0) + (cpS.instant(d, tol)?.val ?? 0);
  };
  const cashAt = (d: string) => {
    const combined = cashStiS.instant(d, tol)?.val;
    if (combined !== undefined) return combined;
    const c = cashS.instant(d, tol)?.val;
    if (c === undefined) return undefined;
    return c + (stiS.instant(d, tol)?.val ?? 0);
  };
  const investedCapitalAt = (d: string) => {
    const e = equityS.instant(d, tol)?.val;
    const c = cashAt(d);
    if (e === undefined || c === undefined) return undefined;
    return debtAt(d) + e - c;
  };

  /** ROIC = OI × (1 − t) ÷ average(opening, closing) invested capital. null when not computable or IC ≤ 0. */
  const roic = (oi: number | undefined, open: string, close: string) => {
    const a = investedCapitalAt(open);
    const b = investedCapitalAt(close);
    if (oi === undefined || a === undefined || b === undefined) return { value: null, a, b };
    const avg = (a + b) / 2;
    if (avg <= 0) return { value: null, a, b, nonPositive: true };
    return { value: (oi * (1 - TAX_RATE)) / avg, a, b };
  };

  const T = (key: keyof typeof LINE_ITEMS) => ttm(S(key), asOf, fyEnds)?.value;
  const revTtm = ttm(revenue, asOf, fyEnds)?.value;
  const oiTtm = ttm(opInc, asOf, fyEnds)?.value;
  // How the TTM operating income was built, when any period in it was derived.
  const oiDerivedHow = [...new Set(
    opInc.facts.filter((f) => f.concept.startsWith("derived") && (f.end === asOf || f.end === latestFy)).map((f) => f.concept.slice("derived: ".length)),
  )];
  const oiNote = oiDerivedHow.length > 0 ? `No operating-income line tagged: operating income = ${oiDerivedHow.join("; ")}.` : undefined;
  const ttmLabel = `TTM to ${asOf}`;

  const lastN = (n: number) => (fyEnds.length >= n ? fyEnds.slice(-n) : null);
  const ratio = (num: number | undefined, den: number | undefined) =>
    num === undefined || den === undefined || den === 0 ? null : num / den;

  // ---- A. Monopoly profits --------------------------------------------------
  const a1r = roic(oiTtm, addYears(asOf, -1), asOf);
  const A1 = metric(
    {
      id: "A1",
      name: "ROIC (TTM)",
      formula: "Operating income × 0.79 ÷ avg(total debt + total equity − cash & ST investments)",
      value: a1r.value,
      unit: "pct",
      max: 10,
      inputs: {
        [`Operating income (${ttmLabel})`]: usd(oiTtm),
        [`Invested capital ${addYears(asOf, -1)}`]: usd(a1r.a),
        [`Invested capital ${asOf}`]: usd(a1r.b),
      },
      note: [a1r.nonPositive ? "Average invested capital ≤ 0: ROIC not meaningful, scored 0." : "", oiNote ?? ""].filter(Boolean).join(" ") || undefined,
    },
    BANDS.A1,
  );

  // Years that are missing (short history or untagged data) simply don't count toward the total.
  let A2: Metric;
  const fy11 = fyEnds.slice(-11);
  const years = fy11.slice(1).map((end, i) => ({ end, r: roic(opInc.annual(end)?.val, fy11[i]!, end) }));
  const scorable = years.filter((y) => y.r.value !== null || y.r.nonPositive);
  if (scorable.length === 0) {
    A2 = unscored("A2", "Excess-return duration", "Count of last 10 FYs with ROIC ≥ 12%", 8, "count",
      years.length === 0
        ? `Needs at least 2 consecutive fiscal year-ends (1 FY + opening balance); ${fyEnds.length} available.`
        : "ROIC not computable for any of the last 10 FYs (missing tagged data).");
  } else {
    const count = years.filter((y) => y.r.value !== null && y.r.value >= HURDLE).length;
    const missing = years.filter((y) => y.r.value === null && !y.r.nonPositive);
    const notes = [
      years.length < 10 ? `Only ${years.length} FYs of history; the other ${10 - years.length} count as 0.` : "",
      missing.length > 0 ? `ROIC not computable for FY ending ${missing.map((y) => y.end).join(", ")} (missing tagged data); counted as 0.` : "",
    ].filter(Boolean);
    A2 = {
      id: "A2",
      name: "Excess-return duration",
      formula: "Count of last 10 FYs with ROIC ≥ 12%; 0.8 pts each",
      value: count,
      unit: "count",
      display: `${count} of 10 years`,
      band: `${count} × 0.8`,
      points: Math.min(8, count * 0.8),
      max: 8,
      inputs: Object.fromEntries(years.map((y) => [`FY ${y.end}`, y.r.nonPositive ? "IC ≤ 0" : y.r.value === null ? "n/a" : pct(y.r.value)])),
      note: notes.length > 0 ? notes.join(" ") : undefined,
    };
  }

  const gpTtm = grossProfitTtm();
  const A3 = metric(
    {
      id: "A3",
      name: "Gross margin (TTM)",
      formula: "Gross profit ÷ revenue",
      value: ratio(gpTtm?.value, revTtm),
      unit: "pct",
      max: 6,
      inputs: { [`Gross profit (${gpTtm?.how ?? "n/a"})`]: usd(gpTtm?.value), Revenue: usd(revTtm) },
    },
    BANDS.A3,
  );

  let A4: Metric;
  const fy5 = lastN(5);
  const gms = fy5?.map((e) => ratio(grossProfitAnnual(e), revenue.annual(e)?.val));
  if (!fy5 || !gms || gms.some((g) => g === null)) {
    A4 = unscored("A4", "Gross margin stability", "Population std. dev. of annual gross margin, last 5 FYs", 6, "pts",
      "Needs gross margin for each of the last 5 fiscal years.");
  } else {
    const xs = gms.map((g) => g! * 100);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    A4 = metric(
      {
        id: "A4",
        name: "Gross margin stability",
        formula: "Population std. dev. of annual gross margin, last 5 FYs (percentage points)",
        value: sd / 100,
        unit: "pts",
        max: 6,
        inputs: Object.fromEntries(fy5.map((e, i) => [`FY ${e}`, `${xs[i]!.toFixed(2)}%`])),
      },
      BANDS.A4,
    );
  }

  // ---- B. Moat signals ------------------------------------------------------
  let B1: Metric;
  const fy6 = lastN(6);
  if (!fy6) {
    B1 = unscored("B1", "Operating leverage", "5-yr operating income CAGR ÷ 5-yr revenue CAGR", 5, "ratio", "Needs 6 fiscal years.");
  } else {
    const [s, e] = [fy6[0]!, fy6[5]!];
    const oi0 = opInc.annual(s)?.val, oi5 = opInc.annual(e)?.val;
    const r0 = revenue.annual(s)?.val, r5 = revenue.annual(e)?.val;
    const inputs = {
      [`Operating income FY ${s}`]: usd(oi0), [`Operating income FY ${e}`]: usd(oi5),
      [`Revenue FY ${s}`]: usd(r0), [`Revenue FY ${e}`]: usd(r5),
    };
    if (oi0 === undefined || oi5 === undefined || r0 === undefined || r5 === undefined) {
      B1 = unscored("B1", "Operating leverage", "5-yr operating income CAGR ÷ 5-yr revenue CAGR", 5, "ratio", "Missing endpoint data.", inputs);
    } else if (oi0 <= 0 || oi5 <= 0) {
      B1 = { ...unscored("B1", "Operating leverage", "5-yr operating income CAGR ÷ 5-yr revenue CAGR", 5, "ratio", "Operating income ≤ 0 at an endpoint: scores 0.", inputs), band: "OI ≤ 0" };
    } else {
      const rc = cagr(r0, r5, 5);
      const oc = cagr(oi0, oi5, 5);
      inputs["OI CAGR"] = pct(oc);
      inputs["Revenue CAGR"] = pct(rc);
      B1 = rc <= 0
        ? { ...unscored("B1", "Operating leverage", "5-yr operating income CAGR ÷ 5-yr revenue CAGR", 5, "ratio", "Revenue CAGR ≤ 0: ratio not meaningful, scores 0.", inputs), band: "rev CAGR ≤ 0" }
        : metric({ id: "B1", name: "Operating leverage", formula: "5-yr operating income CAGR ÷ 5-yr revenue CAGR", value: oc / rc, unit: "ratio", max: 5, inputs }, BANDS.B1, 1);
    }
  }

  const fy4 = lastN(4);
  let B2: Metric;
  let B5: Metric;
  if (!fy4) {
    B2 = unscored("B2", "Pricing power", "3-yr gross profit CAGR − 3-yr revenue CAGR", 5, "pts", "Needs 4 fiscal years.");
    B5 = unscored("B5", "Demand growth", "3-yr revenue CAGR", 5, "pct", "Needs 4 fiscal years.");
  } else {
    const [s, e] = [fy4[0]!, fy4[3]!];
    const r0 = revenue.annual(s)?.val, r3 = revenue.annual(e)?.val;
    const g0 = grossProfitAnnual(s), g3 = grossProfitAnnual(e);
    const rc = r0 !== undefined && r3 !== undefined && r0 > 0 && r3 > 0 ? cagr(r0, r3, 3) : null;
    B5 = metric({ id: "B5", name: "Demand growth", formula: "3-yr revenue CAGR", value: rc, unit: "pct", max: 5,
      inputs: { [`Revenue FY ${s}`]: usd(r0), [`Revenue FY ${e}`]: usd(r3) } }, BANDS.B5);
    const b2inputs = { [`Gross profit FY ${s}`]: usd(g0), [`Gross profit FY ${e}`]: usd(g3), "Revenue CAGR": pct(rc) };
    if (g0 === undefined || g3 === undefined || rc === null) {
      B2 = unscored("B2", "Pricing power", "3-yr gross profit CAGR − 3-yr revenue CAGR", 5, "pts", "Missing gross profit or revenue history.", b2inputs);
    } else if (g0 <= 0 || g3 <= 0) {
      B2 = { ...unscored("B2", "Pricing power", "3-yr gross profit CAGR − 3-yr revenue CAGR", 5, "pts", "Gross profit ≤ 0 at an endpoint: scores 0.", b2inputs), band: "GP ≤ 0" };
    } else {
      const gc = cagr(g0, g3, 3);
      b2inputs["Gross profit CAGR"] = pct(gc);
      B2 = metric({ id: "B2", name: "Pricing power", formula: "3-yr gross profit CAGR − 3-yr revenue CAGR (percentage points)", value: gc - rc, unit: "pts", max: 5, inputs: b2inputs }, BANDS.B2);
    }
  }

  const rndS = S("rnd");
  const rndTtm = rndS.empty ? 0 : ttm(rndS, asOf, fyEnds)?.value;
  const B3 = metric({ id: "B3", name: "Technology intensity", formula: "R&D expense ÷ revenue (TTM)", value: ratio(rndTtm, revTtm), unit: "pct", max: 5,
    inputs: { "R&D": usd(rndTtm), Revenue: usd(revTtm) }, note: rndS.empty ? "No R&D line item ever reported: R&D = 0." : undefined }, BANDS.B3);

  const sga = sgaTtm();
  const B4 = exchange
    ? notApplicable("B4", "Brand / pull demand", "SG&A ÷ revenue (TTM)", "pct",
      "Not applicable to exchanges (SIC 6200): they report costs by nature, so nearly all opex is overhead and the ratio says nothing about brand.")
    : metric({ id: "B4", name: "Brand / pull demand", formula: "SG&A ÷ revenue (TTM)", value: ratio(sga, revTtm), unit: "pct", max: 5,
      inputs: { "SG&A": usd(sga), Revenue: usd(revTtm) } }, BANDS.B4);

  // ---- C. Durability --------------------------------------------------------
  let C1: Metric;
  if (!fy11) {
    C1 = unscored("C1", "Revenue resilience", "Count of last 10 FYs with YoY revenue decline", 5, "count", `Needs 11 fiscal years of revenue; ${fyEnds.length} available.`);
  } else {
    const revs = fy11.map((e) => revenue.annual(e)?.val);
    if (revs.some((r) => r === undefined)) {
      C1 = unscored("C1", "Revenue resilience", "Count of last 10 FYs with YoY revenue decline", 5, "count", "Missing a fiscal year of revenue.");
    } else {
      const declines = fy11.slice(1).filter((_, i) => revs[i + 1]! < revs[i]!);
      const n = declines.length;
      C1 = {
        id: "C1", name: "Revenue resilience", formula: "Count of last 10 FYs with YoY revenue decline",
        value: n, unit: "count", display: `${n} decline${n === 1 ? "" : "s"}`,
        band: n === 0 ? "0" : n === 1 ? "1" : n === 2 ? "2" : "≥3",
        points: n === 0 ? 5 : n === 1 ? 3 : n === 2 ? 1 : 0, max: 5,
        inputs: Object.fromEntries(fy11.map((e, i) => [`FY ${e}`, usd(revs[i])])),
      };
    }
  }

  const cc = text.customerConcentrationPct;
  const C2 = cc.value === null
    ? { ...unscored("C2", "Customer concentration", "Σ % of revenue from customers each ≥ 10%", 5, "pct", cc.detail), evidence: cc.evidence, source: cc.source }
    : { ...metric({ id: "C2", name: "Customer concentration", formula: "Σ % of revenue from customers each ≥ 10% (latest 10-K)", value: cc.value / 100, unit: "pct", max: 5,
        inputs: {}, note: cc.detail, evidence: cc.evidence, source: cc.source }, BANDS.C2) };

  const dnaS = S("dna");
  const dnaTtm = ttm(dnaS, asOf, fyEnds)?.value;
  const ebitda = oiTtm !== undefined && dnaTtm !== undefined ? oiTtm + dnaTtm : undefined;
  const debtNow = debtAt(asOf);
  const cashNow = cashAt(asOf);
  const netDebt = cashNow === undefined ? undefined : debtNow - cashNow;
  const c3inputs = { "Total debt": usd(debtNow), "Cash & ST investments": usd(cashNow), "Net debt": usd(netDebt),
    "EBITDA (OI + D&A, TTM)": usd(ebitda) };
  let C3: Metric;
  if (netDebt === undefined) {
    C3 = unscored("C3", "Balance sheet", "(Total debt − cash & ST investments) ÷ TTM EBITDA", 5, "x", "Cash not reported at the as-of date.", c3inputs);
  } else if (netDebt < 0) {
    C3 = { id: "C3", name: "Balance sheet", formula: "(Total debt − cash & ST investments) ÷ TTM EBITDA", value: netDebt, unit: "x",
      display: "Net cash", band: "Net cash", points: 5, max: 5, inputs: c3inputs };
  } else if (ebitda === undefined) {
    C3 = unscored("C3", "Balance sheet", "(Total debt − cash & ST investments) ÷ TTM EBITDA", 5, "x", "D&A not reported: EBITDA not computable.", c3inputs);
  } else if (ebitda <= 0) {
    C3 = { id: "C3", name: "Balance sheet", formula: "(Total debt − cash & ST investments) ÷ TTM EBITDA", value: null, unit: "x",
      display: "neg. EBITDA", band: "negative EBITDA", points: 0, max: 5, inputs: c3inputs };
  } else {
    const x = netDebt / ebitda;
    C3 = { id: "C3", name: "Balance sheet", formula: "(Total debt − cash & ST investments) ÷ TTM EBITDA", value: x, unit: "x",
      display: `${x.toFixed(2)}×`, band: x <= 1 ? "0–1×" : x <= 2.5 ? "1–2.5×" : ">2.5×", points: x <= 1 ? 3 : x <= 2.5 ? 1 : 0, max: 5, inputs: c3inputs };
  }

  // ---- D. Cash generation ---------------------------------------------------
  const ocfTtm = T("ocf");
  const niTtm = T("netIncome");
  const D1 = metric({ id: "D1", name: "Operating cash flow margin", formula: "Operating cash flow ÷ revenue (TTM)", value: ratio(ocfTtm, revTtm), unit: "pct", max: 5,
    inputs: { "Operating cash flow": usd(ocfTtm), Revenue: usd(revTtm) } }, BANDS.D1);
  const D2 = niTtm !== undefined && niTtm <= 0
    ? { ...unscored("D2", "Earnings quality", "Operating cash flow ÷ net income (TTM)", 5, "ratio", "Net income ≤ 0: scores 0.", { "Operating cash flow": usd(ocfTtm), "Net income": usd(niTtm) }), band: "NI ≤ 0" }
    : metric({ id: "D2", name: "Earnings quality", formula: "Operating cash flow ÷ net income (TTM)", value: ratio(ocfTtm, niTtm), unit: "ratio", max: 5,
        inputs: { "Operating cash flow": usd(ocfTtm), "Net income": usd(niTtm) } }, BANDS.D2, 1);

  // ---- E. Foundations and alignment -----------------------------------------
  const E1: Metric = {
    id: "E1", name: "Founder status", formula: "From proxy: founder is CEO 4 · founder is chair or ≥5% holder 2 · neither 0",
    value: text.founder.points, unit: "text", display: text.founder.band, band: text.founder.band, points: text.founder.points, max: 4,
    inputs: {}, note: text.founder.detail, evidence: text.founder.evidence, source: text.founder.source,
  };
  const ins = text.insiderPct;
  const E2 = ins.value === null
    ? { ...unscored("E2", "Insider ownership", "Officers & directors as a group, % of shares outstanding", 3, "pct", ins.detail), evidence: ins.evidence, source: ins.source }
    : metric({ id: "E2", name: "Insider ownership", formula: "Officers & directors as a group, % of shares outstanding (proxy)", value: ins.value / 100, unit: "pct", max: 3,
        inputs: {}, note: ins.detail, evidence: ins.evidence, source: ins.source, display: `${ins.value.toFixed(2)}%` }, BANDS.E2);
  const sbcTtm = T("sbc");
  const E3 = metric({ id: "E3", name: "Dilution discipline", formula: "Stock-based compensation ÷ revenue (TTM)", value: ratio(sbcTtm, revTtm), unit: "pct", max: 3,
    inputs: { "Stock-based comp": usd(sbcTtm), Revenue: usd(revTtm) } }, BANDS.E3);

  // ---- F. Definite optimism -------------------------------------------------
  const capexTtm = T("capex");
  const F1 = metric({ id: "F1", name: "Reinvestment intensity", formula: "(Capex + R&D) ÷ revenue (TTM)",
    value: capexTtm === undefined || rndTtm === undefined ? null : ratio(capexTtm + rndTtm, revTtm), unit: "pct", max: 5,
    inputs: { Capex: usd(capexTtm), "R&D": usd(rndTtm), Revenue: usd(revTtm) } }, BANDS.F1);

  let F2: Metric;
  const fy3 = lastN(3);
  const ocfS = S("ocf"), bbS = S("buybacks"), divS = S("dividends");
  if (!fy3) {
    F2 = unscored("F2", "Capital return restraint", "Σ(buybacks + dividends) ÷ Σ operating cash flow, last 3 FYs", 5, "pct", "Needs 3 fiscal years.");
  } else {
    const rows = fy3.map((e) => ({ e, ocf: ocfS.annual(e)?.val, bb: bbS.annual(e)?.val ?? 0, dv: divS.annual(e)?.val ?? 0 }));
    const inputs = Object.fromEntries(rows.map((r) => [`FY ${r.e}`, `returned ${usd(r.bb + r.dv)} / OCF ${usd(r.ocf)}`]));
    if (rows.some((r) => r.ocf === undefined)) {
      F2 = unscored("F2", "Capital return restraint", "Σ(buybacks + dividends) ÷ Σ operating cash flow, last 3 FYs", 5, "pct", "Missing operating cash flow.", inputs);
    } else {
      const ocf3 = rows.reduce((a, r) => a + r.ocf!, 0);
      const ret3 = rows.reduce((a, r) => a + r.bb + r.dv, 0);
      F2 = ocf3 <= 0
        ? { ...unscored("F2", "Capital return restraint", "Σ(buybacks + dividends) ÷ Σ operating cash flow, last 3 FYs", 5, "pct", "3-yr operating cash flow ≤ 0: scores 0.", inputs), band: "OCF ≤ 0" }
        : metric({ id: "F2", name: "Capital return restraint", formula: "Σ(buybacks + dividends) ÷ Σ operating cash flow, last 3 FYs", value: ret3 / ocf3, unit: "pct", max: 5, inputs,
            note: "Untagged buybacks/dividends count as 0." }, BANDS.F2);
    }
  }

  // Section max is the sum of its metrics' maxes, so not-applicable metrics (max 0) shrink it.
  const sec = (id: string, name: string, metrics: Metric[]): Section => ({
    id, name, max: metrics.reduce((a, m) => a + m.max, 0), metrics, points: metrics.reduce((a, m) => a + m.points, 0),
  });
  const sections = [
    sec("A", "Monopoly profits", [A1, A2, A3, A4]),
    sec("B", "Moat signals", [B1, B2, B3, B4, B5]),
    sec("C", "Durability", [C1, C2, C3]),
    sec("D", "Cash generation", [D1, D2]),
    sec("E", "Foundations and alignment", [E1, E2, E3]),
    sec("F", "Definite optimism", [F1, F2]),
  ];
  // Rescale to 100 when some metrics don't apply.
  const maxTotal = sections.reduce((a, s) => a + s.max, 0);
  const rawTotal = (sections.reduce((a, s) => a + s.points, 0) * 100) / maxTotal;
  const gated = a1r.value === null || a1r.value < GATE_ROIC;
  const total = Math.round((gated ? Math.min(rawTotal, GATE_CAP) : rawTotal) * 10) / 10;

  return { ...base, sections, rawTotal, gated, total, rating: ratingFor(total), ttmRoic: a1r.value };
}
