/**
 * Scan-Skript des Markt-Scanners (Task 04).
 *
 *   npm run scan                      # Scan + Artefakte für heute
 *   npm run scan -- --date=2026-08-27 # Artefaktordner explizit setzen
 *   npm run scan -- --dry             # nur rechnen, nichts schreiben
 *
 * Liest Instrumente aus der Registry (Task 01) und Kerzen aus dem
 * Historical Store (Task 03) — **lokal, ohne Netzwerk, ohne LLM** — und legt
 * `artifacts/YYYY-MM-DD/universe.json` (+ `weekly.json`) ab.
 */
import { HistoricalStore } from "../src/lib/marketdata/historicalStore";
import { loadScannerConfig } from "../src/scanner/config";
import { scanUniverse } from "../src/scanner/pipeline";
import { classifyWeekly } from "../src/scanner/weekly";
import {
  ARTIFACT_DATE_RE,
  artifactDateOf,
  latestArtifactDate,
  readWeeklyArtifact,
  writeDailyArtifact,
  writeWeeklyArtifact,
} from "../src/scanner/artifacts";
import { historicalStoreProvider, loadAllInstruments } from "../src/scanner/service";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const dateArg = args.find((a) => a.startsWith("--date="))?.slice("--date=".length);
if (dateArg && !ARTIFACT_DATE_RE.test(dateArg)) {
  console.error(`[scanner] --date erwartet YYYY-MM-DD, war "${dateArg.slice(0, 20)}"`);
  process.exit(1);
}

const config = loadScannerConfig();
const instruments = loadAllInstruments();
const store = new HistoricalStore();
const data = historicalStoreProvider(store, config.factors.correlation.benchmarkInstrumentId);

const scan = scanUniverse({ instruments, data, asOf: new Date(), config });
const date = dateArg ?? artifactDateOf(scan.asOf);

console.log(
  `[scanner] gescannt ${scan.stats.scanned} · geeignet ${scan.funnel.eligible.length} · ` +
    `interessant ${scan.funnel.interesting.length} · daily ${scan.funnel.daily.length} · ` +
    `deep ${scan.funnel.deep.length} · ${scan.stats.durationMs.toFixed(0)} ms`
);
for (const [rule, count] of Object.entries(scan.rejectionsByRule).sort()) {
  console.log(`[scanner]   abgelehnt (${rule}): ${count}`);
}

if (dry) {
  console.log("[scanner] --dry: keine Artefakte geschrieben");
} else {
  const previousDate = latestArtifactDate();
  const previous = previousDate && previousDate !== date ? readWeeklyArtifact(previousDate) : null;
  const daily = writeDailyArtifact(scan, { date });
  const weekly = writeWeeklyArtifact(classifyWeekly({ scan, instruments, previous }), { date });
  console.log(`[scanner] Artefakt: ${daily.path}`);
  console.log(
    `[scanner] Weekly: ${weekly.path} — CORE ${weekly.review.summary.CORE}, ` +
      `ROTATION ${weekly.review.summary.ROTATION}, DISCOVERY ${weekly.review.summary.DISCOVERY}, ` +
      `EXCLUDED ${weekly.review.summary.EXCLUDED}`
  );
}
