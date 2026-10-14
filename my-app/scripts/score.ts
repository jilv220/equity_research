// Score tickers locally against live EDGAR data: node scripts/score.ts NVDA MSFT [--json]
// Uses a file cache in .cache/ (or $SCORE_CACHE_DIR).
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { edgar, type Cache } from "../src/scoring/edgar.ts";

const dir = process.env.SCORE_CACHE_DIR ?? ".cache";
const cache: Cache = {
  async get(key, maxAgeMs) {
    const p = join(dir, key);
    try {
      const s = await stat(p);
      if (Date.now() - s.mtimeMs > maxAgeMs) return null;
      return await readFile(p, "utf8");
    } catch {
      return null;
    }
  },
  async put(key, body) {
    const p = join(dir, key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  },
};

const ua = process.env.SEC_USER_AGENT ?? "EquityResearchPlatform dev-contact@example.com";
const args: string[] = process.argv.slice(2);
const json = args.includes("--json");
const sec = edgar(ua, cache);

for (const t of args.filter((a) => !a.startsWith("--"))) {
  try {
    const card = await sec.score(t);
    if (json) {
      console.log(JSON.stringify(card, null, 2));
      continue;
    }
    console.log(`\n${card.ticker} — ${card.name} (SIC ${card.sic}) as of ${card.asOf}, latest FY ${card.latestFy}`);
    if (card.excluded) {
      console.log(`  ${card.excluded}`);
      continue;
    }
    for (const s of card.sections) {
      console.log(`  ${s.id}. ${s.name}: ${s.points.toFixed(1)}/${s.max}`);
      for (const m of s.metrics) {
        console.log(`     ${m.id} ${m.name.padEnd(26)} ${String(m.display).padEnd(16)} ${m.band.padEnd(16)} ${m.points}/${m.max}${m.note ? "  — " + m.note : ""}`);
        if (m.evidence) console.log(`        evidence: ${m.evidence}`);
      }
    }
    console.log(`  Raw ${card.rawTotal.toFixed(1)}${card.gated ? " → gated to ≤50" : ""} = ${card.total} (${card.rating})`);
  } catch (e) {
    console.log(`\n${t}: ERROR ${(e as Error).message}`);
  }
}
