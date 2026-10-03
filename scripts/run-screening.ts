#!/usr/bin/env node
/**
 * Screening-CLI (STX-05-04) — die Matrix wird zu Jobs.
 *
 *   npm run screening                                  # --dry-run (Default): nur Matrix
 *   npm run screening -- --templates=ema-adx-trend      # Teilmenge der Templates
 *   npm run screening -- --timeframes=1h,4h             # Teilmenge der Timeframes
 *   npm run screening -- --limit-cells=50 --execute     # echter Pilotlauf (50 Zellen)
 *   npm run screening -- --run-id=<uuid> --execute      # vorhandenen Lauf fortsetzen
 *
 * ── Sicherheitsmodell: zwei Schalter, ein Bound ───────────────────────────
 * **`--dry-run` ist der Default.** Ohne `--execute` wird ausschließlich die
 * Matrix gebaut und ausgegeben — kein `createOrGetRun`, kein `upsertCells`,
 * kein Backtest, keine Kerze durch die Engine. Ein echter Lauf braucht das
 * explizite `--execute`.
 *
 * **`--max-cells` ist hart.** Wird die Kombinatorik größer, bricht der Lauf ab
 * (`{ok:false}`) — es wird nichts still gekürzt. `--limit-cells` ist die
 * **sichtbare** Kürzung für Pilotläufe: sie schneidet die ersten N Zellen der
 * stabil sortierten Matrix ab und landet als eigene Run-Identität im
 * `ssr1:`-Hash (ein breiterer Lauf ist ein neuer Lauf).
 *
 * ── Datenquellen (lokal, kein Netzwerk) ───────────────────────────────────
 * Instrumente aus der Universe-Registry, Kerzen aus dem `HistoricalStore`
 * (`data/history/candles.ndjson`), Bewertung aus `scanUniverse()` — derselbe
 * reine, netzfreie Scan, den auch `npm run scan` fährt. Der Scan liefert
 * gleichzeitig das optionale Scan-Gate der Matrix ( Ablehnungen ⇒ `BLOCKED`).
 *
 * Metrik-Zuordnung (CLI-Ebene, **keine** neue Formel-Wahrheit — jede Zeile
 * referenziert ihre bestehende Quelle):
 *
 * | Matrix-Slot | Quelle | Wert |
 * |---|---|---|
 * | `dataQuality.candles` | Store-Reihe (Instrument × Timeframe, `ts ≤ asOf`) | Kerzenzahl |
 * | `dataQuality.score` | Serien-Abdeckung: vorhandene ÷ erwartete Kerzen im Span | [0,1] |
 * | `liquidity` | `InstrumentScore.factors.liquidity` (normiert) | [0,1] |
 * | `freshness` | lineare Rampe `1 − Alter/Stale-Schwelle` (`DEFAULT_STALE_HOURS`, `src/marketdata/quality.ts`) | [0,1] |
 * | `strategyFit` | Cross-Sectional-Rang (Punkt-in-Zeit); fehlt er ⇒ Neutral 0,5 | [0,1] |
 * | `volatilityOpportunity` | `InstrumentScore.factors.volatility` (normiert) | [0,1] |
 * | `correlationPenalty` | `InstrumentScore.factors.correlation` (normiert) | [0,1] |
 *
 * ── Backtest-Pfad ─────────────────────────────────────────────────────────
 * Ausschließlich `runMultiAssetBacktest()` (Engine-Pfad); der Screening-Pfad
 * bleibt davon getrennt. Die Entscheidung aus 00-01 / `BENCH-BASELINE.md` §6
 * basierte auf der historischen Prä-Cache-Messung von `backtestRule()`
 * (121,7×, 7 500 Zellen in 0,44 Kernstunden für die Engine). Seit `v0.11.0`
 * nutzt auch `backtestRule()` den Indicator-Cache. `src/screening/**` und sein
 * Aufrufpfad bleiben unverändert. Details: `src/screening/backtestAdapter.ts`.
 *
 * Exit-Codes: 0 = Lauf grün (oder Dry-Run), 1 = Lauf fachlich nicht grün
 * (Fehler, abgebrochen, `maxCells` verletzt), 2 = Bedienfehler.
 */

import { randomUUID } from "node:crypto";
import {
  MAX_MATRIX_CELLS,
  SCREENING_DEFAULT_CONCURRENCY,
  SCREENING_MAX_CONCURRENCY,
  runScreening,
  type ScreeningCellOutcome,
} from "../src/screening/runner";
import {
  SCREENING_MAX_CANDLES_PER_CELL,
  createMultiAssetBacktestPort,
  nativeSymbolOfInstrument,
} from "../src/screening/backtestAdapter";
import {
  DEFAULT_MATRIX_LIMITS,
  MAX_MATRIX_INSTRUMENTS,
  buildCandidateMatrix,
  type QualitySample,
} from "../src/screening/matrix";
import {
  DEFAULT_SCREENING_PRIORITY_CONFIG,
  type ScreeningPriorityConfig,
} from "../src/screening/config";
import { SCREENING_CELL_RESULTS } from "../src/screening/types";
import { APP_VERSION } from "../src/lib/version";
import {
  HistoricalStore,
  SUPPORTED_TIMEFRAME_MS,
  isSupportedTimeframe,
} from "../src/lib/marketdata/historicalStore";
import {
  DEFAULT_STALE_HOURS,
  evaluateStaleSeries,
  type StaleSeriesState,
} from "../src/marketdata/quality";
import { loadScannerConfig } from "../src/scanner/config";
import { scanUniverse } from "../src/scanner/pipeline";
import { historicalStoreProvider, loadAllInstruments } from "../src/scanner/service";
import { STRATEGY_TEMPLATES, isStrategyTemplateId } from "../src/strategies/catalog";
import { compileTemplate } from "../src/strategies/compiler";
import {
  createVersion,
  ensureDefinition,
  getVersionByFingerprint,
} from "../src/strategies/service";
import { toConsoleAscii } from "../src/lib/consoleFormat";
import type { SupportedTimeframe } from "../src/lib/marketdata/historicalStore";

// ───────────────────────────────────────────────────────────────────────────
// 1) Argument-Parsing (rein, ohne Side-Effects)
// ───────────────────────────────────────────────────────────────────────────

/** Aufgelöste Optionen eines CLI-Aufrufs. */
export interface ScreeningCliOptions {
  /** `true` nur mit `--execute`; Default `false` (= Dry-Run). */
  execute: boolean;
  /** Template-Teilmenge; `null` = alle Katalog-Templates. */
  templates: readonly string[] | null;
  /** Timeframe-Teilmenge; `null` = Template-Default. */
  timeframes: readonly SupportedTimeframe[] | null;
  maxInstruments: number;
  maxCells: number;
  /** Erste N Zellen (Pilot); `null` = alle. */
  limitCells: number | null;
  concurrency: number;
  /** Gemeinsamer PIT-Cutoff (UTC-ISO). */
  asOf: string;
  /** Vorhandenen Lauf fortsetzen. */
  runId: string | null;
  /** Harte Kerzenobergrenze je Zelle. */
  maxCandles: number;
  help: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USAGE = `Screening-CLI (STX-05-04) — Strategie x Markt-Matrix als Jobs.

Aufruf:
  npm run screening [Optionen]

Sicherheit:
  --dry-run             Default AN: nur Matrix bauen + ausgeben, KEIN Backtest,
                        keine DB-Schreibzugriffe. Implizit, wenn --execute fehlt.
  --execute             Echten Lauf fahren (Run + Zellen + Backtest). Ohne dies
                        bleibt jeder Aufruf eine Vorschau.
  --max-cells=N         Harte Obergrenze der Zellzahl (Default ${MAX_MATRIX_CELLS}).
                        Ueber dem Limit bricht der Lauf ab — nichts wird gekuerzt.
  --limit-cells=N       ERSTE N Zellen der stabil sortierten Matrix (Pilotlaeufe).
                        Sichtbare Kuerzung; ein breiterer Lauf ist ein neuer Lauf.
  --run-id=UUID         Vorhandenen Lauf fortsetzen (ab seinem cells_done-Stand).

Auswahl:
  --templates=a,b       Template-Teilmenge (Default: alle ${STRATEGY_TEMPLATES.length} Katalog-Templates)
  --timeframes=1h,4h    Timeframe-Teilmenge (Default: Template-Default)
  --max-instruments=N   Harte Instrumentengrenze (Default ${MAX_MATRIX_INSTRUMENTS})
  --as-of=ISO           Gemeinsamer Point-in-Time-Cutoff (Default: jetzt)

Technik:
  --concurrency=N       I/O-Nebenlaeufigkeit (Default ${SCREENING_DEFAULT_CONCURRENCY}, max ${SCREENING_MAX_CONCURRENCY}).
                        Die Backtests selbst laufen SERIELL im Prozess.
  --max-candles=N       Kerzenobergrenze je Zelle (Default ${SCREENING_MAX_CANDLES_PER_CELL})

Beispiele:
  npm run screening -- --limit-cells=50 --execute     # Pilotlauf (50 Zellen)
  npm run screening -- --templates=rsi-mean-reversion --timeframes=1h,4h
  npm run screening -- --run-id=<uuid> --execute      # fortsetzen

Doku: docs/STRATEGY_SCREENING.md · Pfad-Entscheidung: remediation/BENCH-BASELINE.md §6`;

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

function positiveInt(raw: string, flag: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    return null;
  }
  return n;
}

/**
 * Reines Parsing der CLI-Argumente. Bedienfehler werden **abgelehnt**, bevor
 * irgendein Request, Store-Zugriff oder DB-Zugriff möglich ist.
 */
export function parseScreeningArgs(
  argv: readonly string[],
): { ok: true; parsed: ScreeningCliOptions } | { ok: false; error: string } {
  let execute = false;
  let dryRunExplicit = false;
  let templates: string[] | null = null;
  let timeframes: SupportedTimeframe[] | null = null;
  let maxInstruments = MAX_MATRIX_INSTRUMENTS;
  let maxCells = MAX_MATRIX_CELLS;
  let limitCells: number | null = null;
  let concurrency = SCREENING_DEFAULT_CONCURRENCY;
  let asOf: string | null = null;
  let runId: string | null = null;
  let maxCandles = SCREENING_MAX_CANDLES_PER_CELL;
  let help = false;

  const valueOf = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRunExplicit = true;
      continue;
    }
    const m = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!m) return fail(`unbekanntes Argument "${arg.slice(0, 60)}" (erwartet --flag=wert).`);
    const [, name, raw] = m;
    switch (name) {
      case "templates": {
        const ids = raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (ids.length === 0) return fail("--templates: mindestens eine Template-ID erwartet.");
        for (const id of ids) {
          if (!isStrategyTemplateId(id)) {
            return fail(
              `--templates: unbekannte Template-ID "${id.slice(0, 40)}". Erlaubt: ${STRATEGY_TEMPLATES.map((t) => t.id).join(", ")}`,
            );
          }
        }
        templates = [...new Set(ids)];
        break;
      }
      case "timeframes": {
        const tfs = raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (tfs.length === 0) return fail("--timeframes: mindestens einen Timeframe erwartet.");
        for (const tf of tfs) {
          if (!isSupportedTimeframe(tf)) {
            return fail(`--timeframes: unbekannter Timeframe "${tf.slice(0, 20)}".`);
          }
        }
        timeframes = [...new Set(tfs)] as SupportedTimeframe[];
        break;
      }
      case "max-instruments": {
        const n = positiveInt(raw, "--max-instruments");
        if (n === null) return fail(`--max-instruments="${raw.slice(0, 20)}" ist keine positive Ganzzahl.`);
        maxInstruments = n;
        break;
      }
      case "max-cells": {
        const n = positiveInt(raw, "--max-cells");
        if (n === null) return fail(`--max-cells="${raw.slice(0, 20)}" ist keine positive Ganzzahl.`);
        maxCells = n;
        break;
      }
      case "limit-cells": {
        const n = positiveInt(raw, "--limit-cells");
        if (n === null) return fail(`--limit-cells="${raw.slice(0, 20)}" ist keine positive Ganzzahl.`);
        limitCells = n;
        break;
      }
      case "concurrency": {
        const n = positiveInt(raw, "--concurrency");
        if (n === null) return fail(`--concurrency="${raw.slice(0, 20)}" ist keine positive Ganzzahl.`);
        concurrency = Math.min(n, SCREENING_MAX_CONCURRENCY);
        break;
      }
      case "as-of": {
        const ms = Date.parse(raw);
        if (!Number.isFinite(ms)) {
          return fail(`--as-of="${raw.slice(0, 40)}" ist keine gueltige Zeit (ISO-8601 erwartet).`);
        }
        asOf = new Date(ms).toISOString();
        break;
      }
      case "run-id": {
        const id = raw.trim();
        if (!UUID_RE.test(id)) {
          return fail(`--run-id="${id.slice(0, 40)}" ist keine UUID.`);
        }
        runId = id.toLowerCase();
        break;
      }
      case "max-candles": {
        const n = positiveInt(raw, "--max-candles");
        if (n === null) return fail(`--max-candles="${raw.slice(0, 20)}" ist keine positive Ganzzahl.`);
        maxCandles = n;
        break;
      }
      default:
        return fail(`unbekanntes Argument "--${name}" (erwartet --flag=wert).`);
    }
  }

  if (execute && dryRunExplicit) {
    return fail("--execute und --dry-run widersprechen sich: ohne --execute ist jeder Lauf ein Dry-Run.");
  }
  if (help) {
    return {
      ok: true,
      parsed: {
        execute: false,
        templates: null,
        timeframes: null,
        maxInstruments,
        maxCells,
        limitCells: null,
        concurrency,
        asOf: new Date().toISOString(),
        runId: null,
        maxCandles,
        help: true,
      },
    };
  }

  return {
    ok: true,
    parsed: {
      execute,
      templates,
      timeframes,
      maxInstruments,
      maxCells,
      limitCells,
      concurrency,
      asOf: asOf ?? new Date().toISOString(),
      runId,
      maxCandles,
      help: false,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 2) Ausgabe (ASCII-sicher wie die uebrigen CLIs dieses Repos)
// ───────────────────────────────────────────────────────────────────────────

function say(line: string): void {
  console.log(toConsoleAscii(line));
}

function sayError(line: string): void {
  console.error(toConsoleAscii(line));
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

function formatPriority(priority: number | null): string {
  return priority === null ? "-" : priority.toFixed(4);
}

function formatReasons(reasons: readonly string[]): string {
  return reasons.length === 0 ? "-" : reasons.join(" | ").slice(0, 60);
}

/** Tableau der Zellen — Priorität zuerst, dann Identität, Status, Gründe. */
export function formatScreeningTable(rows: readonly ScreeningCellOutcome[]): string {
  const head = `${pad("priority", 9)} ${pad("template", 20)} ${pad("instrument", 20)} ${pad("tf", 4)} ${pad("status", 9)} ${pad("result", 11)} reasons`;
  const lines = [head, "-".repeat(head.length)];
  for (const row of rows) {
    lines.push(
      `${pad(formatPriority(row.cell.priority), 9)} ${pad(row.cell.templateId, 20)} ` +
        `${pad(row.cell.instrumentId, 20)} ${pad(row.cell.timeframe, 4)} ` +
        `${pad(row.status, 9)} ${pad(row.result, 11)} ${formatReasons(row.reasons)}`,
    );
  }
  return lines.join("\n");
}

/** Zusammenfassung nach Status — plus die gebundene Ergebnis-Zaehlung. */
export function formatScreeningSummary(result: {
  summary: Readonly<Record<string, number>>;
  blockedByReason: Readonly<Record<string, number>>;
  caps: { exceededCells: number; byCap: Readonly<Record<string, number>> };
}): string {
  const lines: string[] = ["", "Zusammenfassung nach Ergebnis:"];
  for (const key of SCREENING_CELL_RESULTS) {
    lines.push(`  ${pad(key, 12)} ${result.summary[key] ?? 0}`);
  }
  const blocked = Object.entries(result.blockedByReason).sort((a, b) => b[1] - a[1]);
  if (blocked.length > 0) {
    lines.push("", "BLOCKED-Gründe:");
    for (const [reason, count] of blocked) lines.push(`  ${pad(reason, 40)} ${count}`);
  }
  if (result.caps.exceededCells > 0) {
    lines.push("", `an Caps gescheitert: ${result.caps.exceededCells}`);
    for (const [cap, count] of Object.entries(result.caps.byCap)) {
      lines.push(`  ${pad(cap, 12)} ${count}`);
    }
  }
  return lines.join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// 3) Datenanbindung (lokal, injizierbar)
// ───────────────────────────────────────────────────────────────────────────

/** Serie einer Instrument×Timeframe-Reihe: Kerzen (PIT) + Stale-Zustand. */
interface SeriesFacts {
  candles: number;
  /** Serien-Abdeckung [0,1]; `null` = keine Historie (unknown, nie 0). */
  coverage: number | null;
  /** Frische [0,1] gegen die Stale-Schwelle; `null` = unbekannt. */
  freshness: number | null;
  lastTs: number | null;
}

/**
 * Baut die Fakten je Reihe **einmal** und cached sie: der HistoricalStore
 * liest pro `query()` die ganze Datei neu, 500 Instrumente × 3 Timeframes
 * dürfen nicht 1 500 Dateilesen kosten.
 */
function createSeriesFacts(
  store: HistoricalStore,
  asOfMs: number,
): (instrumentId: string, timeframe: SupportedTimeframe) => SeriesFacts {
  const cache = new Map<string, SeriesFacts>();
  const staleByKey = new Map<string, StaleSeriesState>();
  for (const state of evaluateStaleSeries(store.readAll(), DEFAULT_STALE_HOURS, asOfMs)) {
    staleByKey.set(`${state.instrumentId}\u0000${state.timeframe}`, state);
  }
  return (instrumentId, timeframe) => {
    const key = `${instrumentId}\u0000${timeframe}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const entries = store.query({ instrumentId, timeframe, to: asOfMs });
    const stale = staleByKey.get(key);
    // Abdeckung: vorhandene ÷ im Span erwartete Kerzen. Eine Reihe ohne
    // Historie hat keine Abdeckung — unknown, nicht 0.
    let coverage: number | null = null;
    if (entries.length > 0) {
      const spanMs = entries[entries.length - 1].ts - entries[0].ts;
      const barMs = SUPPORTED_TIMEFRAME_MS[timeframe];
      const expected = barMs > 0 ? Math.floor(spanMs / barMs) + 1 : entries.length;
      coverage = Math.max(0, Math.min(1, entries.length / Math.max(1, expected)));
    }
    // Frische: lineare Rampe auf die Stale-Schwelle des Qualitäts-Layers.
    let freshness: number | null = null;
    if (stale) {
      const thresholdMs = DEFAULT_STALE_HOURS[timeframe] * 3_600_000;
      freshness = thresholdMs > 0 ? Math.max(0, 1 - stale.ageMs / thresholdMs) : null;
    }
    const facts: SeriesFacts = {
      candles: entries.length,
      coverage,
      freshness,
      lastTs: entries.length > 0 ? entries[entries.length - 1].ts : null,
    };
    cache.set(key, facts);
    return facts;
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 4) Lauf
// ───────────────────────────────────────────────────────────────────────────

/** Ergebnis eines CLI-Laufs (Exit-Code getrennt, damit Tests nicht exitsen). */
export interface ScreeningCliOutcome {
  exitCode: number;
  /** Lauf-UUID; `null` im Dry-Run und bei Abbruch vor `createOrGetRun`. */
  runId: string | null;
  /** Zellen des Tableaus (Dry-Run: Matrix-Zellen als Outcomes). */
  rows: readonly ScreeningCellOutcome[];
  /** Zusammenfassung nach Ergebnis-Token. */
  summary: Readonly<Record<string, number>>;
  cellsTotal: number;
  cellsDone: number;
  errors: readonly string[];
}

/**
 * Abbruch-Flag aus SIGINT/SIGTERM (einmalig). Ohne Handler würde der Prozess
 * mitten im `upsertCells`-Chunk sterben und den Lauf im `RUNNING`-Stand
 * zuruecklassen; mit Handler endet er als `ABORTED` und ist fortsetzbar.
 */
function createAbortFlag(): { shouldAbort: () => boolean; dispose: () => void } {
  let requested = false;
  const onSignal = (): void => {
    requested = true;
    sayError("[screening] Abbruch angefordert — Lauf endet als ABORTED (--run-id setzt fort).");
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return {
    shouldAbort: () => requested,
    dispose: () => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    },
  };
}

/** Dry-Run-Sicht auf die Matrix: jede Zelle ein Outcome ohne Persistenz. */
function dryRunRows(
  cells: readonly import("../src/screening/types").StrategyMarketCandidate[],
): ScreeningCellOutcome[] {
  return cells.map((cell, index) => ({
    index,
    cell,
    status: cell.status,
    reasons: cell.reasons,
    result: cell.status === "BLOCKED" ? "blocked" : "discovered",
    backtestRunId: null,
    persisted: false,
  }));
}

/**
 * Führt den CLI-Lauf aus und liefert einen Exit-Code statt `process.exit()` —
 * so bleibt das Modul in Tests importierbar.
 */
export async function runScreeningCli(argv: readonly string[]): Promise<ScreeningCliOutcome> {
  const parsed = parseScreeningArgs(argv);
  if (!parsed.ok) {
    sayError(`[screening] FEHLER: ${parsed.error}`);
    sayError("[screening] Nutzung: npm run screening -- --help");
    return { exitCode: 2, runId: null, rows: [], summary: {}, cellsTotal: 0, cellsDone: 0, errors: [parsed.error] };
  }
  const options = parsed.parsed;
  if (options.help) {
    say(USAGE);
    return { exitCode: 0, runId: null, rows: [], summary: {}, cellsTotal: 0, cellsDone: 0, errors: [] };
  }

  const asOfMs = Date.parse(options.asOf);
  const store = new HistoricalStore();
  const facts = createSeriesFacts(store, asOfMs);

  // 1) Instrumente (harte Grenze VOR dem Scan — der Scan ist die teure Stufe).
  const instruments = loadAllInstruments(options.maxInstruments);
  if (instruments.length === 0) {
    sayError("[screening] Keine Instrumente in der Registry — `npm run universe:seed` ausfuehren.");
    return {
      exitCode: 1,
      runId: null,
      rows: [],
      summary: {},
      cellsTotal: 0,
      cellsDone: 0,
      errors: ["universe: keine Instrumente"],
    };
  }

  // 2) Lokaler Scan (netzfrei) — Bewertung + optionales Scan-Gate.
  const scanConfig = loadScannerConfig();
  const data = historicalStoreProvider(store, scanConfig.factors.correlation.benchmarkInstrumentId, instruments);
  const scan = scanUniverse({ instruments, data, asOf: asOfMs, config: scanConfig });

  // 3) Templates + Timeframe-Filter.
  const selectedTemplates = STRATEGY_TEMPLATES.filter((t) => options.templates === null || options.templates.includes(t.id));
  const templates = selectedTemplates
    .map((t) =>
      options.timeframes === null
        ? t
        : { ...t, supportedTimeframes: t.supportedTimeframes.filter((tf) => options.timeframes!.includes(tf)) },
    )
    // Ein Template ohne verbleibenden Timeframe erzeugt keine Zelle — es wird
    // gemeldet, nicht als Fehler des Builders behandelt.
    .filter((t) => t.supportedTimeframes.length > 0);

  if (templates.length === 0) {
    sayError(
      `[screening] Nach --timeframes=${options.timeframes?.join(",")} bleibt kein Template mit unterstuetztem Timeframe.`,
    );
    return {
      exitCode: 2,
      runId: null,
      rows: [],
      summary: {},
      cellsTotal: 0,
      cellsDone: 0,
      errors: ["timeframes: kein Template bedient"],
    };
  }

  // 4) Matrix bauen (rein; Gates und Grenzen laufen VOR jedem Datenzugriff).
  // `crossSectional` bleibt bewusst ungesetzt: Der Scanner-Faktor
  // `crossSectionalMomentum` ist KEIN Point-in-Time-Snapshot und hat keine
  // `snapshotId`. Einen Kontext daraus zu bauen wäre eine erfundene Provenienz;
  // der Matrix-Bauer setzt dann seinen dokumentierten Neutralwert 0,5.
  const matrix = buildCandidateMatrix({
    instruments,
    templates,
    scan,
    dataQuality: (instr, tf): QualitySample => {
      const f = facts(instr.id, tf);
      return { score: f.coverage, candles: f.candles };
    },
    liquidity: (instr) => {
      const factor = scan.byId.get(instr.id)?.factors.liquidity;
      return {
        score: factor?.available ? factor.normalized : null,
        spreadPct: null,
        bookDepthUsd: null,
      };
    },
    freshness: (instr, tf) => facts(instr.id, tf).freshness,
    correlation: (instr) => {
      const factor = scan.byId.get(instr.id)?.factors.correlation;
      return factor?.available ? factor.normalized : null;
    },
    volatilityOpportunity: (instr) => {
      const factor = scan.byId.get(instr.id)?.factors.volatility;
      return factor?.available ? factor.normalized : null;
    },
    now: asOfMs,
    limits: {
      ...DEFAULT_MATRIX_LIMITS,
      maxInstruments: options.maxInstruments,
      maxCells: options.maxCells,
    },
    config: DEFAULT_SCREENING_PRIORITY_CONFIG,
  });

  if (!matrix.ok) {
    for (const error of matrix.errors) sayError(`[screening] Matrix: ${error}`);
    return {
      exitCode: 1,
      runId: null,
      rows: [],
      summary: {},
      cellsTotal: 0,
      cellsDone: 0,
      errors: matrix.errors,
    };
  }

  // 5) Sichtbare Kürzung für Pilotläufe (nach dem Matrix-Bau, vor dem Lauf).
  let cells = matrix.cells;
  if (options.limitCells !== null && options.limitCells < cells.length) {
    say(
      `[screening] --limit-cells=${options.limitCells}: ${cells.length} Zellen auf die ersten ${options.limitCells} gekuerzt (stabile Reihenfolge).`,
    );
    cells = cells.slice(0, options.limitCells);
  }

  say(
    `[screening] Matrix: ${matrix.stats.cells} Zellen · ${matrix.stats.instruments} Instrumente · ` +
      `${matrix.stats.templates} Templates · ${matrix.stats.timeframes} Timeframes · as-of ${options.asOf}`,
  );

  // 6) Dry-Run ist der Default: ausgeben, nichts schreiben.
  if (!options.execute) {
    const rows = dryRunRows(cells);
    say("");
    say(formatScreeningTable(rows));
    const summary: Record<string, number> = {};
    for (const row of rows) summary[row.result] = (summary[row.result] ?? 0) + 1;
    say(
      formatScreeningSummary({
        summary,
        blockedByReason: matrix.stats.blockedByReason,
        caps: { exceededCells: 0, byCap: {} },
      }),
    );
    say("");
    say("[screening] --dry-run (Default): keine Persistenz, kein Backtest. Echter Lauf: --execute");
    return { exitCode: 0, runId: null, rows, summary, cellsTotal: cells.length, cellsDone: 0, errors: [] };
  }

  // 7) Echter Lauf: Versionen auflösen + Engine-Pfad.
  const codeVersion = APP_VERSION;
  const resolveStrategyVersion = async (
    cell: import("../src/screening/types").StrategyMarketCandidate,
  ): Promise<string | null> => {
    const symbol = nativeSymbolOfInstrument(cell.instrumentId);
    const compiled = compileTemplate({
      templateId: cell.templateId,
      symbol,
      timeframe: cell.timeframe,
      codeVersion,
    });
    if (!compiled.ok) return null;
    const existing = await getVersionByFingerprint(compiled.fingerprint);
    if (existing) return existing.id;
    const template = STRATEGY_TEMPLATES.find((t) => t.id === cell.templateId);
    if (!template) return null;
    const definition = await ensureDefinition({
      templateId: template.id,
      name: template.name,
      description: template.description,
    });
    const created = await createVersion({
      definitionId: definition.id,
      templateId: template.id,
      symbol,
      timeframe: cell.timeframe,
      codeVersion,
    });
    return created.versionId;
  };

  const backtest = createMultiAssetBacktestPort({ store, maxCandlesPerCell: options.maxCandles, codeVersion });

  // Ctrl-C bricht den Lauf **sauber** ab: der Runner landet den Stand als
  // `ABORTED`, `cells_done` bleibt konsistent und `--run-id` setzt dort fort.
  const abort = createAbortFlag();

  const run = await runScreening({
    shouldAbort: abort.shouldAbort,
    cells,
    runKind: "BACKTEST_BATCH",
    asOf: options.asOf,
    codeVersion,
    dataVersion: null,
    config: {
      priority: DEFAULT_SCREENING_PRIORITY_CONFIG,
      limits: {
        maxInstruments: options.maxInstruments,
        maxCells: options.maxCells,
        maxTimeframesPerTemplate: DEFAULT_MATRIX_LIMITS.maxTimeframesPerTemplate,
        limitCells: options.limitCells,
        maxCandlesPerCell: options.maxCandles,
      },
      concurrency: options.concurrency,
      backtestPath: "multiAsset",
    },
    limits: { maxInstruments: options.maxInstruments, maxCells: options.maxCells },
    concurrency: options.concurrency,
    resumeRunId: options.runId,
    resolveStrategyVersion,
    backtest,
  });
  abort.dispose();

  say("");
  say(formatScreeningTable(run.cells));
  say(formatScreeningSummary(run));
  say("");
  say(
    `[screening] Lauf ${run.runId ?? "-"}: ${run.cellsDone}/${run.cellsTotal} Zellen · ` +
      `Status ${run.ok ? "DONE" : run.aborted ? "ABORTED" : "FAILED"} · ${run.wallClockMs} ms`,
  );
  if (run.cellsTotal > 0 && run.wallClockMs > 0) {
    say(`[screening] Durchsatz: ${((run.cellsDone / run.wallClockMs) * 1000).toFixed(2)} Zellen/s`);
  }
  for (const error of run.errors) sayError(`[screening] ${error}`);
  if (!run.ok) {
    // Nur mit Lauf-ID ist ein Fortsetzen adressierbar; ein Lauf, der nie
    // angelegt wurde, braucht keinen Resume-Hinweis.
    sayError(
      run.runId
        ? `[screening] Lauf nicht grün — Zellen stehen, fortsetzbar mit --run-id=${run.runId}`
        : "[screening] Lauf nicht grün — es wurde kein Lauf angelegt.",
    );
  }

  return {
    exitCode: run.ok ? 0 : 1,
    runId: run.runId,
    rows: run.cells,
    summary: run.summary,
    cellsTotal: run.cellsTotal,
    cellsDone: run.cellsDone,
    errors: run.errors,
  };
}

/** Direktstart (`npm run screening`) — Import bleibt side-effect-frei. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const outcome = await runScreeningCli(argv);
  return outcome.exitCode;
}

if (typeof process !== "undefined" && /(^|\/)run-screening\.[cm]?[jt]s$/.test(process.argv?.[1] ?? "")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      sayError(`[screening] Fehlgeschlagen: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`);
      process.exit(1);
    });
}
