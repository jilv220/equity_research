// Best-effort extraction of the filing-text metrics (E1, E2, C2).
// Every result carries the evidence it was read from, so it can be checked against the filing.
import type { TextInputs } from "./score.ts";

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "’", lsquo: "‘", mdash: "—", ndash: "–" };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<ix:header>[\s\S]*?<\/ix:header>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[\s ]+/g, " ");
}

const clip = (s: string, n = 320) => (s.length > n ? s.slice(0, n) + "…" : s).trim();

// ---------------------------------------------------------------------------
// Inline XBRL
// ---------------------------------------------------------------------------
interface Context {
  dims: Record<string, string>;
  start?: string;
  end?: string;
}

function parseContexts(html: string): Map<string, Context> {
  const out = new Map<string, Context>();
  const re = /<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g;
  for (const m of html.matchAll(re)) {
    const body = m[2]!;
    const dims: Record<string, string> = {};
    for (const d of body.matchAll(/<xbrldi:explicitMember[^>]*dimension="([^"]+)"[^>]*>\s*([^<\s]+)\s*</g)) dims[d[1]!] = d[2]!;
    for (const d of body.matchAll(/<xbrldi:typedMember[^>]*dimension="([^"]+)"[^>]*>([\s\S]*?)<\/xbrldi:typedMember>/g)) dims[d[1]!] = htmlToText(d[2]!).trim();
    out.set(m[1]!, {
      dims,
      start: body.match(/<(?:xbrli:)?startDate>\s*([^<\s]+)/)?.[1],
      end: body.match(/<(?:xbrli:)?endDate>\s*([^<\s]+)/)?.[1] ?? body.match(/<(?:xbrli:)?instant>\s*([^<\s]+)/)?.[1],
    });
  }
  return out;
}

interface IxFact {
  name: string;
  contextRef: string;
  text: string;
  value?: number;
}

const attr = (tag: string, a: string) => tag.match(new RegExp(`\\b${a}="([^"]*)"`))?.[1];

function ixFacts(html: string, kind: "nonFraction" | "nonNumeric", names: string[]): IxFact[] {
  const out: IxFact[] = [];
  // Facts nest (e.g. a name inside a text block), so match each opening tag to its own closing tag by depth.
  const tags = new RegExp(`<(/?)ix:${kind}\\b([^>]*)>`, "g");
  for (const m of html.matchAll(new RegExp(`<ix:${kind}\\b([^>]*)>`, "g"))) {
    const tag = m[1]!;
    const name = attr(tag, "name");
    if (!name || !names.includes(name)) continue;
    const start = m.index! + m[0].length;
    tags.lastIndex = start;
    let depth = 1;
    let end = html.length;
    for (let t = tags.exec(html); t; t = tags.exec(html)) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) {
        end = t.index;
        break;
      }
    }
    const text = htmlToText(html.slice(start, end)).trim();
    let value: number | undefined;
    if (kind === "nonFraction") {
      const raw = Number(text.replace(/[,\s$]/g, ""));
      const scale = Number(attr(tag, "scale") ?? 0);
      value = Number.isFinite(raw) ? raw * 10 ** scale * (attr(tag, "sign") === "-" ? -1 : 1) : undefined;
    }
    out.push({ name, contextRef: attr(tag, "contextRef") ?? "", text, value });
  }
  return out;
}

const days = (a: string, b: string) => Math.abs(Date.parse(b) - Date.parse(a)) / 86_400_000;

// ---------------------------------------------------------------------------
// C2: customer concentration from the latest 10-K
// ---------------------------------------------------------------------------
const TYPE_AXIS = "us-gaap:ConcentrationRiskByTypeAxis";
const BENCH_AXIS = "us-gaap:ConcentrationRiskByBenchmarkAxis";

export function customerConcentration(tenK: string, fyEnd: string, source: string): TextInputs["customerConcentrationPct"] {
  const contexts = parseContexts(tenK);
  const facts = ixFacts(tenK, "nonFraction", ["us-gaap:ConcentrationRiskPercentage1"]);
  // Per customer, the % of revenue: [unsegmented facts, facts that also carry a business-segment axis].
  const plain = new Map<string, number>();
  const segmented = new Map<string, number>();
  for (const f of facts) {
    const c = contexts.get(f.contextRef);
    if (!c || f.value === undefined || !c.start || !c.end) continue;
    if (days(c.end, fyEnd) > 4 || days(c.start, c.end) < 350) continue;
    if (c.dims[TYPE_AXIS] !== "us-gaap:CustomerConcentrationRiskMember") continue;
    if (!/Revenue|Sales/i.test(c.dims[BENCH_AXIS] ?? "")) continue;
    const customerAxis = Object.keys(c.dims).find((k) => /MajorCustomers|Customer/i.test(k) && k !== TYPE_AXIS);
    if (!customerAxis) continue;
    const rest = Object.keys(c.dims).filter((k) => k !== TYPE_AXIS && k !== BENCH_AXIS && k !== customerAxis);
    // Geographic or product axes make it a % of something narrower than total revenue: skip.
    const target = rest.length === 0 ? plain : rest.length === 1 && /Segment/i.test(rest[0]!) ? segmented : null;
    if (!target) continue;
    const customer = c.dims[customerAxis]!;
    target.set(customer, Math.max(target.get(customer) ?? 0, f.value * 100));
  }
  const usingSegmented = plain.size === 0 && segmented.size > 0;
  const major = [...(usingSegmented ? segmented : plain)].filter(([, p]) => p >= 10);
  if (major.length > 0) {
    const total = major.reduce((a, [, p]) => a + p, 0);
    return {
      value: total,
      detail:
        `Tagged in the 10-K (ConcentrationRiskPercentage1, customer concentration vs revenue, FY ending ${fyEnd}).` +
        (usingSegmented ? " Facts carry a segment axis (customer attributed to a segment); read as % of total revenue." : ""),
      evidence: major.map(([c, p]) => `${c.replace(/^[a-z-]+:/, "").replace(/Member$/, "")}: ${p.toFixed(1)}%`).join(" · "),
      source,
    };
  }

  // Nothing tagged. If the text still discloses a ≥10% customer, don't award 5 points on an absence of tags.
  const text = htmlToText(tenK);
  const CONCENTRATION =
    /\b(?:customer|customers|distributor|distributors)\b.*?\b(\d{2}(?:\.\d+)?)\s?%\s+of\s+(?:our\s+)?(?:total\s+|net\s+|consolidated\s+)*(?:revenue|revenues|net sales|sales)\b/i;
  let hit: RegExpMatchArray | null = null;
  for (const sentence of text.split(/(?<=[a-z)][.;])\s+(?=[A-Z])/)) {
    if (sentence.length > 600) continue;
    const m = sentence.match(CONCENTRATION);
    // "No customer accounted for more than 10%…" is a disclosure of no concentration.
    if (m && !/\b(no|not|none|neither)\b/i.test(sentence)) {
      hit = [sentence, m[1]!] as unknown as RegExpMatchArray;
      break;
    }
  }
  if (hit && Number(hit[1]) >= 10) {
    return {
      value: null,
      detail: "10-K text discloses a ≥10% customer but the amounts aren't XBRL-tagged; scored 0 pending manual review.",
      evidence: clip(hit[0]),
      source,
    };
  }
  return {
    value: 0,
    detail: "No customer ≥10% of revenue tagged or found in the 10-K text: 0% (none disclosed).",
    source,
  };
}

// ---------------------------------------------------------------------------
// Shares outstanding from the 10-K cover page (one fact per share class)
// ---------------------------------------------------------------------------
export interface CoverShares {
  total: number;
  classes: number;
  date: string;
}

export function coverShares(tenK: string): CoverShares | undefined {
  const contexts = parseContexts(tenK);
  const facts = ixFacts(tenK, "nonFraction", ["dei:EntityCommonStockSharesOutstanding"]);
  const byClass = new Map<string, { v: number; date: string }>();
  for (const f of facts) {
    if (f.value === undefined) continue;
    const c = contexts.get(f.contextRef);
    const cls = Object.values(c?.dims ?? {}).join("|") || "common";
    byClass.set(cls, { v: f.value, date: c?.end ?? "" });
  }
  if (byClass.size === 0) return undefined;
  const vals = [...byClass.values()];
  return { total: vals.reduce((a, x) => a + x.v, 0), classes: byClass.size, date: vals[0]!.date };
}

// ---------------------------------------------------------------------------
// E1 / E2: proxy statement (DEF 14A)
// ---------------------------------------------------------------------------
// A person's name: "Mr. Chesky" (honorific + surname) or "Jen-Hsun Huang" / "Mark A. Stevens" (2–4 words).
// Case-sensitive on purpose: capitalisation is what separates names from prose.
const WORD = String.raw`[A-Z][a-z][a-zA-Z'’]*(?:-[A-Z][a-zA-Z'’]+)?`;
const NAME = String.raw`(?:(?:Mr|Ms|Mrs|Dr)\.\s(${WORD})|(${WORD}(?:\s(?:[A-Z]\.|${WORD})){0,2}\s${WORD}))`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Case-insensitive literal without the i flag (which would break NAME's capitalisation test). */
const ci = (s: string) => esc(s).replace(/[a-z]/gi, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`);
// Words that end up glued in front of names when tables are flattened to text.
const NOT_NAME = /^(?:Appendix|Financial|Operating|Technology|Strategy|Product|None|Other|Current|Public|Company|Companies|Boards?|Committees?|Director|Directors|Since|Independent|Age|Name|Position|Our|The|Former|Chief|Executive|Officer|Chair|Chairman|President|Founder|Member|Members|Lead|Left|Right|To|And|Class|Nominee|Nominees|Biographies)$/;
const trimName = (raw: string) => {
  const words = raw.split(/\s+/);
  let i = 0;
  while (i < words.length - 1 && NOT_NAME.test(words[i]!)) i++;
  return words.slice(i).join(" ");
};

interface Founder {
  name: string;
  chair: boolean;
  evidence: string;
}

/**
 * People the proxy names as founders of THIS company. The founder title must be attached to a
 * name ("Brian Chesky, Co-Founder and CEO", "Mr. Huang founded NVIDIA") and must not be followed
 * by another organisation ("Founder and CEO, Calico"; "co-founded Daisy Systems").
 */
function findFounders(text: string, shortName: string): Founder[] {
  const co = ci(shortName);
  const company = String.raw`(?:${co}|[Tt]he [Cc]ompany|[Oo]ur [Cc]ompany|us)\b`;
  const title = String.raw`(?:Chief Executive Officer|CEO|Executive Chair(?:man)?|Chair(?:man|woman|person)?(?: of the Board)?|President|Director|Chief [A-Z][a-z]+ Officer)`;
  const titles = String.raw`(?:${title}\s*(?:,|and|&)\s*)*`;
  const founderWord = String.raw`(?:[Cc]o-?)?[Ff]ounder`;
  const patterns = [
    // "Jen-Hsun Huang founded NVIDIA", "Mr. Chesky co-founded our Company"
    String.raw`${NAME},?\s+(?:(?:who|has|had|also|originally|in\s+\d{4})\s+)*(?:[Cc]o-?)?founded\s+${company}`,
    // "Brian Chesky* 44 Chief Executive Officer, Co-Founder, and Chairman", "Larry Page Co-Founder 53", "Bill Gates, Microsoft Co-founder"
    String.raw`${NAME}\*?\s*,?\s*(?:\(?\d+\)?\s+)?(?:is\s+)?(?:our\s+|a\s+)?${titles}(?:${co}\s+)?${founderWord}\b`,
    // "our co-founder, Brian Chesky", "our Founder and CEO, Mark Zuckerberg"
    String.raw`\b[Oo]ur\s+${founderWord}(?:\s*(?:,|and|&)\s*${titles}${title})?,?\s+${NAME}`,
  ].map((p) => new RegExp(p, "g"));

  // After a founder title: "Founder and CEO, Calico" / "co-founder of Netscape" / "Co-Founder and General Partner of a16z".
  const elsewhere = new RegExp(
    String.raw`^(?:[^.;•]{0,60}?\b(?:of|at)\s+(?!the Board\b|the Company\b|our\b|${co}\b)[A-Z]|\s*(?:and\s+${title}\s*)?,\s+(?!and\b|${title}|(?:[Cc]o-?)?[Ff]ounder)[A-Z])`,
  );
  // Chair must be the person's own title: in the matched title run, or right after the founder title.
  const chairTitle = String.raw`(?:Executive\s+)?Chair(?:man|woman|person)?\b(?!\s+of\s+the\s+[A-Z][a-z]+\s+Committee)`;
  const chairAfter = new RegExp(String.raw`^\s*(?:,|and|&)\s*(?:and\s+)?(?:${title}\s*(?:,|and|&)\s*(?:and\s+)?)*${chairTitle}`);

  const out = new Map<string, Founder>();
  patterns.forEach((re, idx) => {
    for (const m of text.matchAll(re)) {
      const raw = m[1] ?? m[2];
      if (!raw) continue;
      const name = trimName(raw);
      if (NOT_NAME.test(name.split(" ").at(-1)!)) continue;
      const end = m.index! + m[0].length;
      const after = text.slice(end, end + 80);
      if (idx > 0 && elsewhere.test(after)) continue;
      const window = text.slice(Math.max(0, m.index! - 60), end + 80);
      const chair = (idx === 1 && new RegExp(chairTitle).test(m[0].slice(raw.length))) || chairAfter.test(after);
      const prev = out.get(name);
      if (!prev || (chair && !prev.chair)) out.set(name, { name, chair, evidence: clip(window) });
    }
  });
  return [...out.values()];
}

/**
 * Largest per-class percentage in a beneficial-ownership row that starts with `name`
 * (only numbers and markers between). Tables print percentages as "46.5%" or bare "46.5".
 */
function holderPct(text: string, name: string): number | undefined {
  let best: number | undefined;
  for (const m of text.matchAll(new RegExp(`\\b${esc(name)}\\b(?:\\s*\\(\\d+\\))?([\\s\\d,.()\\-—–*%]{0,200})`, "g"))) {
    for (const p of m[1]!.matchAll(/(?<![\d,.])(\d{1,2}(?:\.\d+)?)\s?%|(?<![\d,.])(\d{1,2}\.\d+)(?![\d,])/g)) {
      const v = Number(p[1] ?? p[2]);
      if (best === undefined || v > best) best = v;
    }
  }
  return best;
}

export function proxyMetrics(
  proxy: string,
  companyName: string,
  shares: CoverShares | undefined,
  source: string,
): Pick<TextInputs, "founder" | "insiderPct"> {
  const text = htmlToText(proxy);
  const shortName = companyName.replace(/[^A-Za-z0-9 &-]/g, "").split(" ")[0]!;

  // CEO = Principal Executive Officer from the pay-versus-performance XBRL, latest period.
  const contexts = parseContexts(proxy);
  // Some filers tag other executives' names as PeoName under a NonPeoNeoMember dimension; drop those.
  const peos = ixFacts(proxy, "nonNumeric", ["ecd:PeoName"])
    .map((f) => ({ name: f.text.replace(/^(Mr|Ms|Mrs|Dr)\.?\s+/, ""), ctx: contexts.get(f.contextRef) }))
    .filter((p) => p.name && !Object.values(p.ctx?.dims ?? {}).some((m) => /NonPeoNeo/i.test(m)))
    .map((p) => ({ name: p.name, end: p.ctx?.end ?? "" }));
  peos.sort((a, b) => (a.end < b.end ? 1 : -1));
  let ceo = peos[0]?.name;
  let ceoHow = "PEO tagged in the pay-versus-performance XBRL";
  if (!ceo) {
    // Fallback: the name most often written as "<Name>, ... Chief Executive Officer".
    const counts = new Map<string, number>();
    const re = /\b([A-Z][a-zA-Z'’-]+(?:\s(?:[A-Z]\.|[A-Z][a-zA-Z'’-]+)){1,3}),?\s+(?:our\s+|the\s+)?(?:(?:Chairman|Chair|President)(?:\s+of\s+the\s+Board)?,?\s+(?:and\s+)?)*Chief Executive Officer/g;
    for (const m of text.matchAll(re)) {
      const name = m[1]!.replace(/^(Mr|Ms|Mrs|Dr)\.?\s+/, "");
      if (/^(Our|The|As|Former|Interim|Executive|Chairman|Chair|President|Vice)\b/.test(name)) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const top = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (top) {
      ceo = top[0];
      ceoHow = `name most often written as "…, Chief Executive Officer" in the proxy (${top[1]}×)`;
    }
  }

  let founder: TextInputs["founder"];
  const found = findFounders(text, shortName);
  const lastName = (n: string) => n.replace(/,?\s+(Jr|Sr|II|III|IV)\.?$/i, "").split(/\s+/).at(-1)!;
  if (!ceo) {
    founder = { points: 0, band: "no data", detail: "CEO could not be identified from the proxy; founder status not determinable.", source };
  } else {
    const last = lastName(ceo);
    const asCeo = found.find((f) => lastName(f.name) === last);
    const others = found.filter((f) => lastName(f.name) !== last);
    const asChair = others.find((f) => f.chair);
    const asHolder = others
      .map((f) => ({ f, pct: holderPct(text, f.name) }))
      .find((x) => x.pct !== undefined && x.pct >= 5);
    if (asCeo) {
      founder = { points: 4, band: "Founder is CEO", detail: `CEO ${ceo} (${ceoHow}) is described as a founder of the company.`, evidence: asCeo.evidence, source };
    } else if (asChair) {
      founder = { points: 2, band: "Founder is chair", detail: `CEO ${ceo} is not a founder; founder ${asChair.name} is chair.`, evidence: asChair.evidence, source };
    } else if (asHolder) {
      founder = { points: 2, band: "Founder ≥5% holder", detail: `CEO ${ceo} is not a founder; founder ${asHolder.f.name} holds ${asHolder.pct!.toFixed(1)}% of a share class.`, evidence: asHolder.f.evidence, source };
    } else {
      founder = {
        points: 0,
        band: "Neither",
        detail: `CEO ${ceo} (${ceoHow}) is not described as a founder` +
          (found.length ? `; founders found (${found.map((f) => f.name).join(", ")}) are neither chair nor ≥5% holders.` : "; no founder of the company named in the proxy."),
        source,
      };
    }
  }

  // Insider ownership: "directors and executive officers as a group" row of the beneficial-ownership table.
  let insiderPct: TextInputs["insiderPct"] = {
    value: null,
    detail: "Beneficial-ownership 'as a group' row not found in the proxy.",
    source,
  };
  for (const m of text.matchAll(/as a group/gi)) {
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 400);
    // The row: an optional "(N persons)" note, then only numbers, footnote markers, dashes, * and %.
    const row = after.match(/^\s*(?:\((?:\d+|[a-z]+)\s+(?:persons?|individuals?|people)\))?\s*,?([\s\d,.()\-—–*%]|less than (?:one|1)(?: percent|%))*/i);
    const cells = row?.[0] ?? "";
    const counts = [...cells.matchAll(/(?<![\d.])\d{1,3}(?:,\d{3})+(?![\d.])|(?<![\d.,])\d{5,}(?![\d.,])/g)].map((x) => Number(x[0].replace(/,/g, "")));
    const explicit = cells.match(/(?<![\d,.])(\d{1,3}(?:\.\d+)?)\s?%/);
    if (counts.length === 0 && !explicit) continue;
    const evidence = clip(text.slice(Math.max(0, m.index! - 120), m.index! + m[0].length + cells.length + 10));
    const multiClass = (shares?.classes ?? 1) > 1;
    if (explicit && !multiClass) {
      insiderPct = { value: Number(explicit[1]), detail: "Percent of class from the proxy's 'as a group' row.", evidence, source };
    } else if (counts.length && shares) {
      // One class: the largest count (tables often show owned / options / total). Several classes:
      // add the per-class counts, unless one of them is already the total of the others.
      const max = Math.max(...counts);
      const rest = counts.reduce((a, b) => a + b, 0) - max;
      const held = !multiClass || Math.abs(max - rest) <= 0.02 * max ? max : max + rest;
      insiderPct = {
        value: (held / shares.total) * 100,
        detail: `${held.toLocaleString("en-US")} shares held by the group ÷ ${shares.total.toLocaleString("en-US")} shares outstanding` +
          ` (${shares.classes} class${shares.classes > 1 ? "es" : ""}, 10-K cover as of ${shares.date}).`,
        evidence,
        source,
      };
    } else if (explicit) {
      insiderPct = { value: Number(explicit[1]), detail: "Percent of the first class listed (shares outstanding unavailable).", evidence, source };
    } else {
      insiderPct = { value: null, detail: "Group row found but shares outstanding couldn't be read from the 10-K cover.", evidence, source };
    }
    break;
  }

  return { founder, insiderPct };
}
