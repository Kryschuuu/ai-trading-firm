/**
 * Scan-Skript des Markt-Scanners (Task 04).
 *
 *   npm run scan                      # Scan + Artefakte für heute
 *   npm run scan -- --date=2026-08-27 # Artefaktordner explizit setzen
 *   npm run scan -- --dry             # nur rechnen, nichts schreiben
 *   npm run scan -- --sync            # MarketDataSyncService (Netzwerk) VOR dem Scan
 *   npm run scan -- --sync --timeframes=5m,15m --candle-limit=200
 *
 * `--sync` (Alias: `--sync-first`) ist voreingestellt AUS: ohne ihn ist dieser
 * Aufruf rein lokal. Der Sync bleibt damit ein expliziter, separater Schritt.
 *
 * Liest Instrumente aus der Registry (Task 01) und Kerzen aus dem
 * Historical Store (Task 03) — **lokal, ohne Netzwerk, ohne LLM** — und legt
 * `artifacts/YYYY-MM-DD/universe.json` (+ `weekly.json`) ab.
 *
 * Ohne vorherigen Sync (`npm run market:sync`) bleibt der Historical Store leer
 * und der Trichter lehnt alles mit `min-candles` ab — genau der Defekt, den der
 * persistent Sync behebt (docs/MARKET_DATA_PIPELINE.md).
 *
 * `--sync` ist der einzige Netzwerkschritt dieses Skripts und liegt AUSSERHALB
 * von `scanUniverse()` — der Scanner selbst führt niemals Netzwerk-I/O aus.
 * Ohne `--sync` geht null Netzwerk-Request ab (test-erzwungen:
 * `test/marketdata/adapters/bitunix.test.ts` → „run-scan without --sync
 * performs zero network calls“, Guard-Server-Subprozess).
 *
 * MDERR-006: Sync-Fehler werden als Datenfehler-Manifest persistiert und in
 * `scanUniverse()` als `dataErrors` gereicht → Readiness `ERROR` und
 * `data-unavailable`-Rejections statt `min-candles`. Der Scan läuft auch bei
 * Fehlern (Artefakte bleiben erzeugbar), beendet sich aber mit Exit 1.
 */
import { HistoricalStore } from "../src/lib/marketdata/historicalStore";
import { loadMarketDataErrors, saveMarketDataErrors, clearMarketDataErrors } from "../src/marketdata/dataErrors";
import { saveVenueSyncStatus } from "../src/marketdata/syncStatus";
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
import { runMarketSync } from "./lib/market-sync";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  // `--sync` ist der Ticket-Name, `--sync-first` der bestehende — beide akzeptiert.
  const syncFirst = args.includes("--sync") || args.includes("--sync-first");
  const valueOf = (name: string): string | undefined =>
    args.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
  const syncOptions = {
    ...(valueOf("timeframes")
      ? { timeframes: valueOf("timeframes")!.split(",").map((t) => t.trim()).filter(Boolean) as never[] }
      : {}),
    ...(valueOf("candle-limit") ? { candleLimit: Number(valueOf("candle-limit")) } : {}),
    ...(valueOf("max-instruments") ? { maxInstruments: Number(valueOf("max-instruments")) } : {}),
    ...(valueOf("concurrency") ? { concurrency: Number(valueOf("concurrency")) } : {}),
  };
  const dateArg = args.find((a) => a.startsWith("--date="))?.slice("--date=".length);
  const venueArg = args.find((a) => a.startsWith("--venue="))?.slice("--venue=".length);
  if (dateArg && !ARTIFACT_DATE_RE.test(dateArg)) {
    console.error(`[scanner] --date erwartet YYYY-MM-DD, war "${dateArg.slice(0, 20)}"`);
    process.exit(1);
  }

  let syncErrorCount = 0;
  if (syncFirst) {
    const venue = (venueArg ?? "BITUNIX").trim().toUpperCase();
    const result = await runMarketSync(venue, syncOptions);
    syncErrorCount = result.failures.length;
    // OPS-011: Sync-Status je Venue persistieren (Quelle der Ops-Sektion
    // „Market Data“ — letzter Lauf, degraded-Flag, Fehler nach Ursache).
    saveVenueSyncStatus(result);
    if (syncErrorCount > 0) {
      // MDERR-006: Fehler manifestieren und Scan TROTZDEM ausführen — der
      // Scanner übersetzt sie in DATA_UNAVAILABLE/Readiness ERROR statt in
      // eine stille min-candles-Aussortierung (Exit-Code unten = 1).
      saveMarketDataErrors(result.failures);
      console.error(
        `[scanner] --sync: ${syncErrorCount} Marktdaten-Fehler — ` +
          `Manifest geschrieben, Scan läuft mit Readiness ERROR (kein Marktausschluss).`
      );
    } else {
      clearMarketDataErrors();
    }
  }

  const config = loadScannerConfig();
  const instruments = loadAllInstruments();
  const store = new HistoricalStore();
  const data = historicalStoreProvider(store, config.factors.correlation.benchmarkInstrumentId);

  const dataErrors = loadMarketDataErrors();
  const scan = scanUniverse({
    instruments,
    data,
    asOf: new Date(),
    config,
    ...(dataErrors.size > 0 ? { dataErrors } : {}),
  });
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

  // MDERR-006: Sync-Fehler sind sichtbar (Readiness ERROR, Manifest) — der
  // Scan ist trotzdem gelaufen, der Exit-Code bleibt aber fehlerhaft (1).
  if (syncFirst && syncErrorCount > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("[scanner] Fehlgeschlagen:", e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200));
  process.exit(1);
});
