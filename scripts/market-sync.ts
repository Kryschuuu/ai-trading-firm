/**
 * Market-Data-Sync CLI (MDSYNC-001) — Warmup vor dem deterministischen Scan.
 *
 *   npm run market:sync                                        # BITUNIX, Default-Profile
 *   npm run market:sync -- --venue=BITUNIX --timeframes=5m,15m,30m,1h
 *   npm run market:sync -- --symbols=BTCUSDT,ETHUSDT --candle-limit=200
 *   npm run market:sync -- --dry-run --json                      # volles Budget, keine Persistenz
 *
 * Der Sync ist der EINZIGE Netzwerk-Schritt der Pipeline. Er läuft bewusst
 * VOR `npm run scan`: `scanUniverse()` führt niemals Netzwerk-I/O aus, sondern
 * liest ausschließlich, was dieser Lauf in `InstrumentRegistry` und
 * `HistoricalStore` (`data/history/candles.ndjson`) persistiert hat.
 *
 * Aufgerufen werden ausschließlich öffentliche Market-Data-Endpunkte
 * (trading_pairs, tickers, depth, kline). Kein PrivateClient, keine API-Keys,
 * keine Signatur. Geloggt werden Zähler — niemals Symbole, URLs oder Header.
 *
 * Exit-Codes: 0 sauberer Lauf · 1 degradierter/abgebrochener Lauf · 2 Bedienfehler.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SUPPORTED_TIMEFRAMES, HistoricalStore, type SupportedTimeframe } from "../src/lib/marketdata/historicalStore";
import { InstrumentRegistry } from "../src/universe/registry";
import {
  defaultRequiredWarmupCandles,
  InsufficientCandleLimitError,
  MAX_CANDLE_LIMIT,
  MAX_CONCURRENCY,
  MAX_INSTRUMENTS_CEILING,
  normalizeSyncSymbol,
  SYNC_CANDLE_LIMIT,
  UnsupportedVenueError,
  type SyncLogger,
  type SyncResult,
} from "../src/marketdata";
import { clearMarketDataErrors, saveMarketDataErrors } from "../src/marketdata/dataErrors";
import { loadScannerConfig } from "../src/scanner/config";
import {
  collectMarketDataReadiness,
  scannerCandleCounts,
  type MarketDataReadinessReport,
} from "../src/ops/marketDataReadiness";
import { resolveDataDir } from "../src/universe/store";
import type { EnvLike } from "../src/brokers/bitunix/config";
import { runMarketSyncDetailed, type MarketSyncRunOptions } from "./lib/market-sync";

/** Vom CLI verstandene Switches ohne Wert. */
const VALUE_FLAGS = [
  "venue",
  "timeframes",
  "candle-limit",
  "max-instruments",
  "symbols",
  "concurrency",
] as const;
const BOOLEAN_FLAGS = ["strict", "dry-run", "json", "no-manifest", "status", "help"] as const;

export interface ParsedCli {
  options: MarketSyncRunOptions;
  dryRun: boolean;
  json: boolean;
  /** `false` ⇒ kein Datenfehler-Manifest schreiben (`--no-manifest`). */
  manifest: boolean;
  /** `true` ⇒ nur Readiness lesen (`--status`), kein Sync, keine Requests. */
  status: boolean;
}

export type ParseResult =
  | { ok: true; parsed: ParsedCli }
  | { ok: false; help: boolean; error: string };

/**
 * Hilfetext. Jede Option hat genau einen explanatory Satz; `required` ist der
 * JETZT geltende Warmup-Bedarf — die Zahl wird nicht im Text hartcodiert,
 * damit die Hilfe nach einer Config-Änderung nicht lügt.
 */
export function buildHelpText(required: number = defaultRequiredWarmupCandles()): string {
  return `market-sync — persistente Marktdaten-Synchronisation (nur Public-Endpunkte)

Verwendung:
  npm run market:sync -- [Optionen]

Optionen:
  --venue=NAME
        Venue, die synchronisiert wird (Default: BITUNIX). Unbekannte Venues
        brechen ab, bevor ein Request abgeht.
  --timeframes=LISTE
        Kommagetrennte Kerzen-Periodizitäten des Backfills (Default:
        5m,15m,30m,1h). Erlaubt sind nur ${SUPPORTED_TIMEFRAMES.join(", ")} —
        ein ungültiger Wert würde Reihen verschiedener Länge mischen.
  --candle-limit=N
        Anzahl je Timeframe zu ladender Kerzen. Muss >= requiredWarmupCandles
        sein (aktuell ${required} bei Default-Faktoren: EMA50 → 50 Kerzen,
        Momentum-Lookback 60 → 61 Kerzen), sonst bleibt der Scanner im Zustand
        WARMING. Default: max(${SYNC_CANDLE_LIMIT}, requiredWarmupCandles);
        hartes Maximum ${MAX_CANDLE_LIMIT} (Payload-Schutz).
  --max-instruments=N
        Sicherheits-Cap der Instrumente je Venue (Default 250, hartes Maximum
        ${MAX_INSTRUMENTS_CEILING}). Gekappt wird deterministisch nach 24h-Volumen
        absteigend, bei Gleichstand oder fehlenden Tickern alphabetisch nach
        Symbol — nie nach Ankunftsreihenfolge der Venue.
  --symbols=A,B
        Allowlist venue-nativer Symbole; nur diese Instrumente werden
        angereichert und zurückgefüllt. Format [A-Z0-9] plus /. - = _, max. 32
        Zeichen — alles andere wird abgelehnt, bevor es in eine URL gelangt.
  --concurrency=N
        Parallelität der Instrumenten-Bearbeitung (Default 4, hart begrenzt auf
        ${MAX_CONCURRENCY}). Der Token-Bucket des HTTP-Layers (8 req/s) bleibt
        autoritativ: Parallelität erzeugt Requests, kein Recht auf mehr.
  --strict
        Abbruch beim ersten Fehler statt degradiertem Lauf (Exit 1); bereits
        persistierte Daten bleiben erhalten (Append-only + Dedup).
  --dry-run
        Volles Request-Budget, aber KEINE Persistenz: Registry und Historical
        Store werden in ein temporäres Verzeichnis geschrieben und verworfen.
  --json
        SyncResult als JSON auf stdout (für Automatisierung); Zählerzeilen entfallen.
  --no-manifest
        Kein Datenfehler-Manifest (data/market-data-errors.json) schreiben.
  --status
        Readiness des persistenten Warmups abfragen (nur lesen, kein Request,
        keine Registry-Schreibpfade). Exit 0 = Scanner bereit, Exit 1 = Warmup
        fehlt oder unvollständig. Kombinierbar mit --json, nicht mit Sync-Flags.
  --help
        Diese Hilfe.

Exit-Codes:
  0  sauberer Lauf (auch mit übersprungenen Instrumenten)
  1  degradierter Lauf: mindestens ein isolierter Fehler, Datenlage ist partiel
     (Details im Manifest data/market-data-errors.json)
  2  Bedienfehler: unbekannte/ungültige Option, nicht freigeschaltete Venue
     oder --candle-limit unter dem Warmup-Bedarf — es ging kein Request raus

Beispiel:
  BITUNIX_ENABLED=true npm run market:sync -- --venue=BITUNIX --timeframes=5m,15m,30m,1h`;
}

/** Reines Parsing — kein I/O, damit es in Tests direkt prüfbar ist. */
export function parseSyncArgs(argv: readonly string[]): ParseResult {
  const help = argv.includes("--help") || argv.includes("-h");
  const usage = (message: string): ParseResult => ({ ok: false, help, error: message });
  // Hilfe ZUERST: sie ist kein Bedienfehler und muss ohne jede weitere
  // Validierung durchgehen (auch `-h`, auch mit Tippfehlern im Rest).
  if (help) return { ok: false, help: true, error: "Hilfe angefordert." };

  for (const arg of argv) {
    if (!arg.startsWith("--")) return usage(`Erwartet --option=value, war "${arg}".`);
    const name = arg.slice(2).split("=")[0];
    if (!(VALUE_FLAGS as readonly string[]).includes(name) && !(BOOLEAN_FLAGS as readonly string[]).includes(name)) {
      return usage(`Unbekannte Option "--${name}". --help zeigt die erlaubten.`);
    }
  }

  /**
   * Boolean-Schalter: `--flag`, `--flag=true|false` (auch 1/0). Ein Wert wie
   * `--json=vielleicht` wird abgelehnt statt still als „an“ gelesen — eine
   * falsch interpretierte Automatisierungs-Flag ist schlimmer als ein Abbruch.
   */
  const boolOf = (name: string, fallback: boolean): boolean | string => {
    const inline = argv.find((a) => a.startsWith(`--${name}=`));
    if (inline === undefined) return argv.includes(`--${name}`) || fallback;
    const raw = inline.slice(name.length + 3).trim().toLowerCase();
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    return `--${name} akzeptiert nur true/false (oder die Flag ohne Wert), war "${raw}".`;
  };

  const take = (name: (typeof VALUE_FLAGS)[number]): string | undefined => {
    const inline = argv.find((a) => a.startsWith(`--${name}=`));
    if (inline !== undefined) return inline.slice(name.length + 3);
    const idx = argv.indexOf(`--${name}`);
    if (idx < 0) return undefined;
    const next = argv[idx + 1];
    return next && !next.startsWith("--") ? next : "";
  };

  const options: MarketSyncRunOptions = { venue: "BITUNIX" };

  const venueRaw = take("venue");
  if (venueRaw !== undefined) {
    const venue = venueRaw.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(venue)) {
      return usage(`--venue "${venueRaw.slice(0, 40)}" verletzt das Format [A-Z0-9][A-Z0-9_-]{0,31}.`);
    }
    options.venue = venue;
  }

  const tfRaw = take("timeframes");
  if (tfRaw !== undefined) {
    const list = tfRaw.split(",").map((t) => t.trim()).filter(Boolean);
    if (list.length === 0) return usage("--timeframes erwartet mindestens einen Wert, z. B. --timeframes=5m,15m.");
    const invalid = list.filter((t) => !(SUPPORTED_TIMEFRAMES as readonly string[]).includes(t));
    if (invalid.length > 0) {
      return usage(
        `--timeframes: ungültige(r) ${invalid.map((v) => `"${v}"`).join(", ")}. ` +
          `Erlaubt sind ausschließlich ${SUPPORTED_TIMEFRAMES.join(", ")}.`
      );
    }
    if (new Set(list).size !== list.length) return usage(`--timeframes enthält Duplikate: ${list.join(",")}.`);
    options.timeframes = list as SupportedTimeframe[];
  }

  const positiveInt = (flag: string, raw: string, ceiling: number): number | string => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) return `${flag} muss eine positive Ganzzahl sein, war "${raw}".`;
    if (value > ceiling) return `${flag}=${value} übersteigt die harte Obergrenze ${ceiling} (Payload-/Budget-Schutz).`;
    return value;
  };

  const limitRaw = take("candle-limit");
  if (limitRaw !== undefined) {
    const parsed = positiveInt("--candle-limit", limitRaw, MAX_CANDLE_LIMIT);
    if (typeof parsed === "string") return usage(parsed);
    options.candleLimit = parsed;
  }

  const maxRaw = take("max-instruments");
  if (maxRaw !== undefined) {
    const parsed = positiveInt("--max-instruments", maxRaw, MAX_INSTRUMENTS_CEILING);
    if (typeof parsed === "string") return usage(parsed);
    options.maxInstruments = parsed;
  }

  const symbolsRaw = take("symbols");
  if (symbolsRaw !== undefined) {
    const parts = symbolsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return usage("--symbols erwartet eine kommagetrennte Liste, z. B. --symbols=BTCUSDT,ETHUSDT.");
    const normalized: string[] = [];
    for (const part of parts) {
      const value = normalizeSyncSymbol(part);
      if (!value) {
        return usage(
          `--symbols: "${part.slice(0, 40)}" verletzt die Symbol-Allowlist (erlaubt: ` +
            `Großbuchstaben, Ziffern und /. - = _ in begrenzter Anzahl, max. 32 Zeichen).`
        );
      }
      if (!normalized.includes(value)) normalized.push(value);
    }
    options.symbols = normalized;
  }

  const concurrencyRaw = take("concurrency");
  if (concurrencyRaw !== undefined) {
    const value = Number(concurrencyRaw);
    if (!Number.isInteger(value) || value < 1) {
      return usage(`--concurrency muss eine Ganzzahl ≥ 1 sein, war "${concurrencyRaw}".`);
    }
    if (value > MAX_CONCURRENCY) {
      return usage(
        `--concurrency=${value} übersteigt die harte Grenze ${MAX_CONCURRENCY} ` +
          `(Public-Budget 8 req/s — mehr Parallelität ändert die Rate nicht, nur den Burst).`
      );
    }
    options.concurrency = value;
  }

  const strict = boolOf("strict", false);
  if (typeof strict === "string") return usage(strict);
  if (strict) options.strict = true;

  const dryRun = boolOf("dry-run", false);
  if (typeof dryRun === "string") return usage(dryRun);
  const json = boolOf("json", false);
  if (typeof json === "string") return usage(json);
  const noManifest = boolOf("no-manifest", false);
  if (typeof noManifest === "string") return usage(noManifest);
  const status = boolOf("status", false);
  if (typeof status === "string") return usage(status);
  // `--status` liest nur; welche Venue man synchronisieren würde, ist dort
  // ohne Bedeutung — ein ignoriertes Flag wäre eine stille Fehlaussage.
  if (status) {
    const extra = argv.filter((a) => /^--(venue|timeframes|symbols|candle-limit|max-instruments|concurrency|strict)=/.test(a));
    if (extra.length > 0) {
      return usage(`--status kombiniert keine Sync-Optionen (weggelassen: ${extra.map((a) => a.split("=")[0]).join(", ")}).`);
    }
  }

  return {
    ok: true,
    parsed: {
      options,
      dryRun,
      json,
      manifest: !noManifest,
      status,
    },
  };
}

/** Obergrenze des Readiness-Scans (Schutz gegen unendliche Registry-Seiten). */
const STATUS_SCAN_PAGE_SIZE = 1000;

export interface StatusRunDeps {
  /** Read-only-Registry (Default: `data/universe`, ohne Seed-Schreibpfad). */
  registry?: InstrumentRegistry;
  /** Historischer Store (Default: `data/history/candles.ndjson`). */
  history?: HistoricalStore;
  json?: boolean;
  logger?: (line: string) => void;
}

/**
 * Liest den Readiness-Zustand des persistenten Warmups — dieselbe Aggregation
 * wie das Operations Center (`collectMarketDataReadiness`), damit CLI und UI
 * nie zwei Meinungen über „gewärmt“ haben.
 *
 * Exit 0, wenn der Scanner mindestens ein vollständiges Instrument hat;
 * Exit 1, wenn Warmup fehlt (das ist ein Zustand, der Behandlung braucht —
 * cron-/deploy-Tauglichkeit verlangt einen unterscheidbaren Code).
 */
export function runMarketSyncStatus(
  deps: StatusRunDeps = {}
): { exitCode: number; lines: string[]; report: MarketDataReadinessReport | null } {
  const emit = deps.logger ?? ((line: string) => console.log(line));
  try {
    // autoSave:false + explizites load(): ein Status-Kommando schreibt nie —
    // auch nicht den Seed in eine leere Registry (sonst wäre „leer“ nie lesbar).
    const registry =
      deps.registry ??
      new InstrumentRegistry({ dir: resolveDataDir(undefined), autoSave: false });
    if (!deps.registry) registry.load();
    const history = deps.history ?? new HistoricalStore();
    const config = loadScannerConfig();
    const page = registry.query({ pageSize: STATUS_SCAN_PAGE_SIZE });
    const instruments = page.items;
    const counts = scannerCandleCounts(history, instruments, config.factors.correlation.benchmarkInstrumentId);
    const report = collectMarketDataReadiness({
      instruments,
      candleCounts: counts,
      config,
      // registry.size, nicht items.length: der Scan ist gekappt, die Größe nicht.
      registrySize: registry.size,
    });

    if (deps.json) {
      emit(JSON.stringify(report));
      return { exitCode: report.scannerReady ? 0 : 1, lines: [JSON.stringify(report)], report };
    }

    const lines = [
      `[market-sync] status: ${report.venue} · Registry ${report.registryCount} · Discovery (24h) ${report.discoveredCount}`,
      `[market-sync] Warmup: ${report.dataReadyCount}/${report.registryCount} bereit · ${report.warmingCount} im Warmup · ${report.candlesLoaded} Kerzen geladen (≥ ${report.candlesRequired} je Instrument)`,
      `[market-sync] Enrichment: tickers ${report.tickerReadyCount}/${report.registryCount} · orderbooks ${report.spreadReadyCount}/${report.registryCount}`,
      `[market-sync] Scanner bereit: ${report.scannerReady ? "ja" : "nein"}`,
    ];
    if (!report.scannerReady) {
      lines.push(
        report.registryCount === 0
          ? "[market-sync] Behebung: npm run universe:seed && npm run market:sync -- --venue=BITUNIX"
          : "[market-sync] Behebung: npm run market:sync -- --dry-run und dann ohne --dry-run ausführen"
      );
    }
    for (const line of lines) emit(line);
    return { exitCode: report.scannerReady ? 0 : 1, lines, report };
  } catch (e) {
    const line = `[market-sync] status nicht lesbar: ${describeSyncError(e)}`;
    emit(line);
    return { exitCode: 1, lines: [line], report: null };
  }
}

/**
 * Führt den CLI aus und liefert Exit-Code + Zeilen (testbar, ohne
 * `process.exit`-Side-Effect). Bei `--dry-run` werden Registry und Store in
 * ein temporäres Verzeichnis geschrieben und danach verworfen.
 */
export async function runMarketSyncCli(
  argv: readonly string[],
  deps: { env?: EnvLike; now?: () => Date } = {}
): Promise<{ exitCode: number; lines: string[]; result: SyncResult | null }> {
  const parsed = parseSyncArgs(argv);
  if (!parsed.ok) {
    const lines = parsed.help ? [buildHelpText()] : [`[market-sync] ${parsed.error}`, "", buildHelpText()];
    for (const line of lines) console.log(line);
    return { exitCode: parsed.help ? 0 : 2, lines, result: null };
  }
  const { options, dryRun, json, manifest, status } = parsed.parsed;
  if (status) {
    const outcome = runMarketSyncStatus({ json });
    return { exitCode: outcome.exitCode, lines: outcome.lines, result: null };
  }
  const lines: string[] = [];
  const logger: SyncLogger = (_level, line) => {
    lines.push(line);
    if (!json) console.log(line);
  };

  // Dry-Run: echte Requests, aber temporäre Senken. Ein "trockener" Lauf, der
  // in data/ schreibt, wäre kein Dry-Run.
  let tmpDir: string | null = null;
  let registry: InstrumentRegistry | undefined;
  let history: HistoricalStore | undefined;
  if (dryRun) {
    tmpDir = mkdtempSync(path.join(tmpdir(), "market-sync-dry-"));
    registry = new InstrumentRegistry({ dir: path.join(tmpDir, "universe"), autoSave: true });
    history = new HistoricalStore(path.join(tmpDir, "history"));
  }

  try {
    const { result } = await runMarketSyncDetailed({
      ...options,
      // Der Logger entscheidet, ob gedruckt wird (--json unterdrückt die
      // Zählerzeilen, sammelt sie aber für den Rückgabewert).
      logger,
      ...(deps.env ? { env: deps.env } : {}),
      ...(registry ? { registry } : {}),
      ...(history ? { history } : {}),
    });

    if (dryRun) {
      const line =
        `[market-sync] DRY-RUN: ${result.synced} Instrumente geplant, ` +
        `${Object.values(result.candlesByTimeframe).reduce((sum, s) => sum + (s?.bars ?? 0), 0)} Bars — ` +
        `nichts in data/ geschrieben.`;
      lines.push(line);
      console.log(line);
    } else if (manifest) {
      if (result.failures.length > 0) {
        saveMarketDataErrors(result.failures);
        const line =
          `[market-sync] ${result.failures.length} Marktdaten-Fehler — Manifest geschrieben ` +
          `(data/market-data-errors.json)`;
        lines.push(line);
        console.error(line);
      } else {
        clearMarketDataErrors();
      }
    }

    if (json) {
      const jsonLine = JSON.stringify(result);
      lines.push(jsonLine);
      console.log(jsonLine);
    }
    return { exitCode: result.failures.length > 0 ? 1 : 0, lines, result };
  } catch (e) {
    const line = `[market-sync] ${describeSyncError(e)}`;
    lines.push(line);
    console.error(line);
    return { exitCode: usageExitCode(e), lines, result: null };
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Fehlermeldung mit Behebungshinweis — URLs/Pfade/Secrets werden entfernt. */
export function describeSyncError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error ?? "unknown error");
  if (error instanceof UnsupportedVenueError) {
    message = `${error.message} Bekannte Sync-Venues werden von registerAdapters() geregelt (MARKET_SYNC_VENUES).`;
  }
  if (error instanceof InsufficientCandleLimitError) {
    message = `${error.message} Hinweis: requiredWarmupCandles = ${defaultRequiredWarmupCandles()}.`;
  }
  return message.replace(/https?:\/\/\S+/gi, "[url]").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
}

/**
 * Bedienfehler (Parsing, Gate, Warmup) ⇒ 2; Laufabbruch mit Datenfehlern ⇒ 1.
 * Die Unterscheidung ist Betriebsrelevant: 2 bedeutet „Konzept falsch
 * aufgerufen“, 1 bedeutet „Venue/Antwort hatte Fehler, Datenlage ist partiel“.
 */
function usageExitCode(error: unknown): number {
  if (error instanceof UnsupportedVenueError) return 2;
  if (error instanceof InsufficientCandleLimitError) return 2;
  if (error instanceof Error && error.message.includes("nicht freigeschaltet")) return 2;
  return 1;
}

/** Direktstart (npm run market:sync) — Import bleibt sideefektfrei. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const { exitCode } = await runMarketSyncCli(argv);
  return exitCode;
}

if (typeof process !== "undefined" && /(^|\/)market-sync\.[cm]?[jt]s$/.test(process.argv?.[1] ?? "")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(`[market-sync] failed: ${describeSyncError(e)}`);
      process.exit(1);
    });
}
