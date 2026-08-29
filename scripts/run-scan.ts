/**
 * Scan-Skript des Markt-Scanners (Task 04).
 *
 *   npm run scan                      # Scan + Artefakte für heute
 *   npm run scan -- --date=2026-08-27 # Artefaktordner explizit setzen
 *   npm run scan -- --dry             # nur rechnen, nichts schreiben
 *   npm run scan -- --sync-first      # MarketDataSyncService (Netzwerk) VOR dem Scan
 *
 * Liest Instrumente aus der Registry (Task 01) und Kerzen aus dem
 * Historical Store (Task 03) — **lokal, ohne Netzwerk, ohne LLM** — und legt
 * `artifacts/YYYY-MM-DD/universe.json` (+ `weekly.json`) ab.
 *
 * `--sync-first` ist der einzige Netzwerk-Schritt und lebt außerhalb von
 * `scanUniverse()`. Ohne vorherigen Sync (`npm run market-sync`) bleibt der
 * Historical Store leer und der Trichter lehnt alles mit `min-candles` ab.
 */
import { spawnSync } from "node:child_process";
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
const syncFirst = args.includes("--sync-first");
const dateArg = args.find((a) => a.startsWith("--date="))?.slice("--date=".length);
const venueArg = args.find((a) => a.startsWith("--venue="))?.slice("--venue=".length);
if (dateArg && !ARTIFACT_DATE_RE.test(dateArg)) {
  console.error(`[scanner] --date erwartet YYYY-MM-DD, war "${dateArg.slice(0, 20)}"`);
  process.exit(1);
}

if (syncFirst) {
  const venue = venueArg ? ["--venue=" + venueArg] : [];
  const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/run-market-sync.ts", ...venue], {
    stdio: "inherit",
    env: process.env,
  });
  if (child.status !== 0) {
    console.error("[scanner] --sync-first: market-sync fehlgeschlagen — Scan wird nicht gestartet");
    process.exit(child.status ?? 1);
  }
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

// Readiness ZUERST — trennt Infrastruktur (Warmup/Datenfehler) von Fachlogik.
const { readiness } = scan;
if (readiness.status === "READY") {
  console.log(`[scanner] Readiness: READY · ${readiness.warmed}/${readiness.instruments} gewärmt (≥ ${readiness.requiredCandles} Kerzen)`);
} else if (readiness.status === "WARMING") {
  console.log(
    `[scanner] Readiness: WARMING · ${readiness.warmed}/${readiness.instruments} gewärmt, ` +
      `${readiness.missing} ohne genügend Historie (benötigt ${readiness.requiredCandles} Kerzen). ` +
      `Behebung: npm run market-sync`
  );
  for (const o of readiness.worstOffenders) {
    console.log(`[scanner]   warmup fehlt: ${o.instrumentId} — ${o.candles}/${readiness.requiredCandles} Kerzen`);
  }
} else {
  console.log(`[scanner] Readiness: ERROR · ${readiness.error}`);
  for (const f of readiness.failures.slice(0, 10)) {
    console.log(`[scanner]   datenfehler: ${f.instrumentId} — ${f.reason}`);
  }
}

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
