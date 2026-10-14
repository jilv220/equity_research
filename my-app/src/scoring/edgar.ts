// SEC EDGAR access + the end-to-end "ticker → scorecard" pipeline.
import type { CompanyFacts } from "./facts.ts";
import { scoreCompany, type Scorecard, type TextInputs } from "./score.ts";
import { coverShares, customerConcentration, proxyMetrics, type CoverShares } from "./text.ts";

export interface Cache {
  get(key: string, maxAgeMs: number): Promise<string | null>;
  put(key: string, body: string): Promise<void>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FOREVER = Number.MAX_SAFE_INTEGER;

export class EdgarError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export function edgar(userAgent: string, cache: Cache) {
  const get = async (url: string, key: string, maxAgeMs: number): Promise<string> => {
    const hit = await cache.get(key, maxAgeMs);
    if (hit !== null) return hit;
    const res = await fetch(url, { headers: { "User-Agent": userAgent, Accept: "*/*" } });
    if (!res.ok) throw new EdgarError(`SEC returned ${res.status} for ${url}`, res.status === 404 ? 404 : 502);
    const body = await res.text();
    await cache.put(key, body);
    return body;
  };

  const cikFor = async (ticker: string) => {
    const map = JSON.parse(await get("https://www.sec.gov/files/company_tickers.json", "sec/company_tickers.json", 7 * DAY)) as Record<
      string,
      { cik_str: number; ticker: string; title: string }
    >;
    const t = ticker.toUpperCase().replace(/\./g, "-");
    const row = Object.values(map).find((r) => r.ticker === t);
    if (!row) throw new EdgarError(`Unknown ticker ${ticker}`, 404);
    return { cik: row.cik_str, ticker: row.ticker };
  };

  const pad = (cik: number) => String(cik).padStart(10, "0");

  type Submissions = {
    name: string;
    sic: string;
    sicDescription: string;
    filings: { recent: Record<"form" | "accessionNumber" | "primaryDocument" | "reportDate" | "filingDate", string[]> };
  };

  /** Company identity plus its latest 10-K and proxy. `fresh` bypasses the 12h cache. */
  const filings = async (ticker: string, fresh: boolean) => {
    const { cik, ticker: t } = await cikFor(ticker);
    const subs = JSON.parse(
      await get(`https://data.sec.gov/submissions/CIK${pad(cik)}.json`, `sec/submissions/${cik}.json`, fresh ? 0 : 12 * HOUR),
    ) as Submissions;
    const recent = subs.filings.recent;
    const latest = (forms: string[]) => {
      const i = recent.form.findIndex((f) => forms.includes(f));
      if (i < 0) return undefined;
      const accn = recent.accessionNumber[i]!;
      const doc = recent.primaryDocument[i]!;
      return {
        form: recent.form[i]!,
        accn,
        filed: recent.filingDate[i]!,
        url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accn.replace(/-/g, "")}/${doc}`,
      };
    };
    return { cik, t, subs, tenK: latest(["10-K", "10-K/A"]), proxy: latest(["DEF 14A"]) };
  };

  const factsUrl = (cik: number) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${pad(cik)}.json`;

  return {
    /** Network-only: pull every document `score` needs into the cache. Cheap on CPU, safe to retry. */
    async prefetch(ticker: string, fresh = false) {
      const { cik, t, tenK, proxy } = await filings(ticker, fresh);
      await get(factsUrl(cik), `sec/companyfacts/${cik}.json`, fresh ? 0 : 12 * HOUR);
      if (tenK) await get(tenK.url, `sec/docs/${tenK.accn}.htm`, FOREVER);
      if (proxy) await get(proxy.url, `sec/docs/${proxy.accn}.htm`, FOREVER);
      return { ticker: t, cik, tenK: tenK?.accn ?? null, proxy: proxy?.accn ?? null };
    },

    /** Parse and score. After `prefetch` this reads only from the cache. */
    async score(ticker: string): Promise<Scorecard> {
      const { cik, t, subs, tenK, proxy } = await filings(ticker, false);
      const facts = JSON.parse(await get(factsUrl(cik), `sec/companyfacts/${cik}.json`, 12 * HOUR)) as CompanyFacts;

      // Score once with placeholder text inputs to learn the latest FY end, then read the filings.
      const placeholder: TextInputs = {
        founder: { points: 0, band: "no data", detail: "" },
        insiderPct: { value: null, detail: "" },
        customerConcentrationPct: { value: null, detail: "" },
      };
      const probe = scoreCompany({ ticker: t, facts, sic: subs.sic, sicDescription: subs.sicDescription, text: placeholder });
      if (probe.excluded) return probe;

      const text: TextInputs = { ...placeholder };
      let shares: CoverShares | undefined;
      if (tenK) {
        const src = `${tenK.form} filed ${tenK.filed}: ${tenK.url}`;
        const key = `extract/10k/${tenK.accn}/${probe.latestFy}.json`;
        const cached = await cache.get(key, FOREVER);
        let r: { c2: TextInputs["customerConcentrationPct"]; shares?: CoverShares };
        if (cached) r = JSON.parse(cached);
        else {
          const doc = await get(tenK.url, `sec/docs/${tenK.accn}.htm`, FOREVER);
          r = { c2: customerConcentration(doc, probe.latestFy, src), shares: coverShares(doc) };
          await cache.put(key, JSON.stringify(r));
        }
        text.customerConcentrationPct = r.c2;
        shares = r.shares;
      } else {
        text.customerConcentrationPct = { value: null, detail: "No 10-K on file." };
      }

      if (proxy) {
        const src = `DEF 14A filed ${proxy.filed}: ${proxy.url}`;
        const key = `extract/proxy/${proxy.accn}/${shares?.total ?? "na"}.json`;
        const cached = await cache.get(key, FOREVER);
        const r = cached
          ? (JSON.parse(cached) as Pick<TextInputs, "founder" | "insiderPct">)
          : proxyMetrics(await get(proxy.url, `sec/docs/${proxy.accn}.htm`, FOREVER), subs.name || facts.entityName, shares, src);
        if (!cached) await cache.put(key, JSON.stringify(r));
        text.founder = r.founder;
        text.insiderPct = r.insiderPct;
      } else {
        text.founder = { points: 0, band: "no data", detail: "No DEF 14A on file (e.g. foreign private issuer)." };
        text.insiderPct = { value: null, detail: "No DEF 14A on file." };
      }

      return scoreCompany({ ticker: t, facts, sic: subs.sic, sicDescription: subs.sicDescription, text });
    },
  };
}
