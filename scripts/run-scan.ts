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
 *
 * Exit-Codes (v1.37.0): echte Läufe (ohne `--dry`) beenden sich mit Exit 1,
 * wenn die Readiness nicht READY ist (WARMING/ERROR) — stille „erfolgreiche“
 * Leerläufe in der Automatisierung waren der Kernbefund der Code-Revision.
 * `--dry` bleibt eine reine Vorschau und wird nie über die Readiness
 * fehlschlagen (hermetische/CI-Probeläufe).
 */
import { HistoricalStore } from "../src/lib/marketdata/historicalStore";
import {
  loadMarketDataErrors,
  saveMarketDataErrors,
  clearMarketDataErrors,
} from "../src/marketdata/dataErrors";
import { qualityStrictDataErrorsForScan } from "../src/marketdata/quality";
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
import {
  historicalStoreProvider,
  loadAllInstruments,
} from "../src/scanner/service";
import { runMarketSync } from "./lib/market-sync";
import { perpDataSyncEnabled } from "../src/perpdata/config";
import {
  PERP_DERIVATIVE_CACHE_FILE,
  getPerpDataService,
  loadPerpConfig,
  perpDerivativeContextsFromCache,
} from "../src/perpdata/index";
import { toConsoleAscii } from "../src/lib/consoleFormat";

/**
 * Einzige Druckstelle dieses CLI — ASCII-sicher (v1.39.1): deutsche Logzeilen
 * mit Umlauten/`·`/`—` erscheinen auf Windows-Konsolen mit Legacy-Codepage
 * sonst als Mojibake. Gleiche Übersetzungsstelle wie `market:sync`.
 */
function say(line: string): void {
  console.log(toConsoleAscii(line));
}

/** ASCII-sichere stderr-Zeile (Fehlerpfade). */
function sayError(line: string): void {
  console.error(toConsoleAscii(line));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  // `--sync` ist der Ticket-Name, `--sync-first` der bestehende — beide akzeptiert.
  const syncFirst = args.includes("--sync") || args.includes("--sync-first");
  const valueOf = (name: string): string | undefined =>
    args.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
  const syncOptions = {
    ...(valueOf("timeframes")
      ? {
          timeframes: valueOf("timeframes")!
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean) as never[],
        }
      : {}),
    ...(valueOf("candle-limit")
      ? { candleLimit: Number(valueOf("candle-limit")) }
      : {}),
    ...(valueOf("max-instruments")
      ? { maxInstruments: Number(valueOf("max-instruments")) }
      : {}),
    ...(valueOf("concurrency")
      ? { concurrency: Number(valueOf("concurrency")) }
      : {}),
  };
  const dateArg = args
    .find((a) => a.startsWith("--date="))
    ?.slice("--date=".length);
  const venueArg = args
    .find((a) => a.startsWith("--venue="))
    ?.slice("--venue=".length);
  if (dateArg && !ARTIFACT_DATE_RE.test(dateArg)) {
    sayError(`[scanner] --date erwartet YYYY-MM-DD, war "${dateArg.slice(0, 20)}"`);
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
      // Ehrliche Berichterstattung wie `market:sync` (v1.39.1): benennt,
      // was im Manifest landete (Instrument-Fehler vs. Batch-Buckets).
      const { persisted, batch } = saveMarketDataErrors(result.failures);
      const persistedNote =
        persisted + batch > 0
          ? `${persisted} Instrument-Fehler, ${batch} Batch-Fehler im Manifest`
          : "Manifest ohne zuordenbare Einträge";
      sayError(
        `[scanner] --sync: ${syncErrorCount} Marktdaten-Fehler (${persistedNote}) — ` +
          `Scan läuft mit Readiness ERROR (kein Marktausschluss).`,
      );
    } else {
      clearMarketDataErrors();
    }
  }

  // RMA-P2-02: Perp-Sync (Funding / Open Interest / Liquidationen) als eigener
  // Schritt NACH dem Kerzen-Sync — nur mit `--sync` und nur, wenn
  // `PERP_DATA_SYNC_ENABLED=true`. Derivatedaten sind eine Anreicherung: ein
  // Fehler hier ändert die Readiness des Scans nicht (dafür ist der Kerzenpfad
  // zuständig), der Derivatekontext bleibt dann leer und die Funding-/OI-
  // Faktoren laufen bei ihrem Neutralwert — nie mit erfundenen 0-Sätzen.
  if (syncFirst && perpDataSyncEnabled()) {
    try {
      const perpService = getPerpDataService();
      const perpVenue = (venueArg ?? "").trim().toUpperCase();
      const synced = await perpService.sync({
        mode: "INCREMENTAL",
        ...(perpVenue ? { venues: [perpVenue] } : {}),
      });
      const refreshed = await perpService.refreshDerivativeCache();
      say(
        `[scanner] --sync: Perp ${synced.totals.fetched} gelesen / ${synced.totals.written} geschrieben` +
          (synced.totals.duplicates > 0 ? `, ${synced.totals.duplicates} Duplikat(e)` : "") +
          `, ${synced.totals.failures} Fehlbefund(e); Derivat-Artefakt: ` +
          (refreshed.written
            ? `${refreshed.available}/${refreshed.entries} Instrument(e) mit Wert`
            : `nicht aktualisiert (${refreshed.reason})`),
      );
      for (const entry of synced.venues) {
        if (entry.skipped !== null) say(`[scanner] --sync: Perp ${entry.venue} übersprungen — ${entry.message}`);
      }
    } catch (error) {
      sayError(
        `[scanner] --sync: Perp-Sync fehlgeschlagen (${
          error instanceof Error ? error.message.slice(0, 160) : "unbekannter Fehler"
        }) — Scan läuft ohne Derivatekontext.`,
      );
    }
  }

  const config = loadScannerConfig();
  const instruments = loadAllInstruments();
  const store = new HistoricalStore();
  // Derivatekontext (RMA-P2-02) aus dem Artefakt der kanonischen Ablage:
  // as-of-gelesen, staleness-begrenzt, nur bei `PERP_DATA_ENABLED`. `null`
  // bedeutet „kein Kontext“ — die Faktoren bleiben neutral.
  const perpContext = perpDerivativeContextsFromCache({
    nowMs: Date.now(),
    maxAgeMs: loadPerpConfig().maxStaleMs.funding,
  });
  // Instrumente mitreichen: die konfigurierte Benchmark-ID (Default
  // BITUNIX:BTCUSDT) wird venue-agnostisch gegen den tatsächlichen
  // Store-Bestand aufgelöst, sonst bleibt der Korrelationsfaktor „unbekannt“.
  const data = historicalStoreProvider(
    store,
    config.factors.correlation.benchmarkInstrumentId,
    instruments,
    perpContext.map,
  );
  if (perpContext.map !== null) {
    say(`[scanner] Derivatekontext: ${perpContext.entries} Instrument(e) aus ${PERP_DERIVATIVE_CACHE_FILE}.`);
  } else if (perpContext.reason === "FILE_STALE" || perpContext.reason === "EMPTY") {
    say(
      `[scanner] Derivat-Artefakt zu alt oder leer (${perpContext.reason}) — Funding-/OI-Faktoren bleiben neutral. ` +
        `Behebung: npm run perp:sync -- --mode=incremental`,
    );
  }

  const dataErrors = loadMarketDataErrors();
  // GAP-07 (strict-Modus): Instrumente mit INVALID-Befunden im Qualitäts-
  // Report zählen wie DATA_UNAVAILABLE (existierende Stale-Fallback-Kette:
  // data-unavailable-Ablehnung, nie min-candles). `log` (Default) ändert
  // nichts — der Scan bleibt byte-identisch.
  for (const [id, reason] of qualityStrictDataErrorsForScan()) {
    if (!dataErrors.has(id)) dataErrors.set(id, reason);
  }
  const scan = scanUniverse({
    instruments,
    data,
    asOf: new Date(),
    config,
    // Readiness-Scope „data“: kuratierte Seed-Instrumente auf Venues ohne
    // laufenden Sync blockieren den READY-Zustand der versorgten Venue nicht.
    readinessScopeVenues: "data",
    ...(dataErrors.size > 0 ? { dataErrors } : {}),
  });
  const date = dateArg ?? artifactDateOf(scan.asOf);

  say(
    `[scanner] gescannt ${scan.stats.scanned} · geeignet ${scan.funnel.eligible.length} · ` +
      `interessant ${scan.funnel.interesting.length} · daily ${scan.funnel.daily.length} · ` +
      `deep ${scan.funnel.deep.length} · ${scan.stats.durationMs.toFixed(0)} ms`,
  );

  // Readiness ZUERST — trennt Infrastruktur (Warmup/Datenfehler) von Fachlogik.
  const { readiness } = scan;
  const scopeNote =
    "outOfScope" in readiness && readiness.outOfScope > 0
      ? ` · ${readiness.outOfScope} ohne Sync-Venue (außer Scope)`
      : "";
  if (readiness.status === "READY") {
    say(
      `[scanner] Readiness: READY · ${readiness.warmed}/${readiness.instruments} gewärmt ` +
        `(≥ ${readiness.requiredCandles} Kerzen)${scopeNote}`,
    );
  } else if (readiness.status === "WARMING") {
    say(
      `[scanner] Readiness: WARMING · ${readiness.warmed}/${readiness.instruments} gewärmt, ` +
        `${readiness.missing} ohne genügend Historie (benötigt ${readiness.requiredCandles} Kerzen)${scopeNote}. ` +
        `Behebung: npm run market:sync`,
    );
    for (const o of readiness.worstOffenders) {
      say(
        `[scanner]   warmup fehlt: ${o.instrumentId} — ${o.candles}/${readiness.requiredCandles} Kerzen`,
      );
    }
  } else {
    say(`[scanner] Readiness: ERROR · ${readiness.error}`);
    for (const f of readiness.failures.slice(0, 10)) {
      say(`[scanner]   datenfehler: ${f.instrumentId} — ${f.reason}`);
    }
  }

  for (const [rule, count] of Object.entries(scan.rejectionsByRule).sort()) {
    say(`[scanner]   abgelehnt (${rule}): ${count}`);
  }

  if (dry) {
    say("[scanner] --dry: keine Artefakte geschrieben");
  } else {
    const previousDate = latestArtifactDate();
    const previous =
      previousDate && previousDate !== date
        ? readWeeklyArtifact(previousDate)
        : null;
    const daily = writeDailyArtifact(scan, { date });
    const weekly = writeWeeklyArtifact(
      classifyWeekly({ scan, instruments, previous }),
      { date },
    );
    say(`[scanner] Artefakt: ${daily.path}`);
    say(
      `[scanner] Weekly: ${weekly.path} — CORE ${weekly.review.summary.CORE}, ` +
        `ROTATION ${weekly.review.summary.ROTATION}, DISCOVERY ${weekly.review.summary.DISCOVERY}, ` +
        `EXCLUDED ${weekly.review.summary.EXCLUDED}`,
    );
  }

  // MDERR-006: Sync-Fehler sind sichtbar (Readiness ERROR, Manifest) — der
  // Scan ist trotzdem gelaufen, der Exit-Code bleibt aber fehlerhaft (1).
  // Ebenso WARMING auf einem ECHTEN Lauf: ein Automatisierungslauf
  // (Cron/Systemd), der „erfolgreich“ einen leeren Trichter produziert, ist
  // der Kernbefund dieser Code-Revision — ein nicht bereiter Datenbestand
  // muss als Fehler sichtbar werden. Leere Sichten bei READY (echtes
  // Fachsignal „keine Chance“) bleiben Exit 0. `--dry` ist eine reine
  // Vorschau ohne Schreibvertrag und bleibt bewusst Exit 0 (sonst würde
  // jeder hermetische Probelauf auf einem leeren Datenbestand fehlschlagen).
  if (
    !dry &&
    ((syncFirst && syncErrorCount > 0) || readiness.status !== "READY")
  ) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  sayError(
    "[scanner] Fehlgeschlagen: " +
      (e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)),
  );
  process.exit(1);
});
