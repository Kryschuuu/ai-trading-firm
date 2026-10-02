/**
 * STX-05-04 — Screening-Runner: die Matrix wird zu Jobs.
 *
 * ── Zweck ─────────────────────────────────────────────────────────────────
 * `buildCandidateMatrix()` (05-02) liefert eine **stabil sortierte** Liste von
 * `StrategyMarketCandidate`-Zellen. Dieses Modul macht daraus einen
 * **persistierten Lauf**: genau ein `strategy_screening_runs`-Row und je Zelle
 * ein `strategy_market_results`-Row — mit einem Backtest als Job zwischen
 * Matrix und Zelle, wo einer verlangt wird.
 *
 * Der Runner ist ein **Adapter**, kein Rechenkern: Er besitzt weder eine Engine
 * noch eine Datenquelle. Beides ist injiziert (`backtest`,
 * `resolveStrategyVersion`, `store`), damit derselbe Lauf im Test mit einem
 * Stub und im Betrieb mit dem echten Engine-Pfad fährt. Genau deshalb ist die
 * Budget-Zusicherung messbar: 50 Zellen mit Stub kosten Millisekunden, nicht
 * die Laufzeit einer Engine.
 *
 * ── Wahl des Backtest-Pfads (verbindlich, 00-01) ───────────────────────────
 * {@link SCREENING_BACKTEST_PATH} ist die Konstante dieser Entscheidung. Sie
 * steht in [`BENCH-BASELINE.md`](../../docs/audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md)
 * §6 (Prompt 00-01, Finding STX-12) und ist **nicht** neu zu entscheiden:
 * `backtestRule()` ist O(n²) (Exponent 1,99; 26,0 s je Zelle bei 17 520 Kerzen),
 * `runMultiAssetBacktest()` ist O(n) (Exponent 1,01; 213,5 ms je Zelle) — der
 * Engine-Pfad ist **121,7×** schneller und trägt die 7 500-Zellen-Matrix in
 * 0,44 Kernstunden. Über `backtestRule()` wären es 54,14 Kernstunden; ein
 * `worker_threads`-Pool würde daran nichts ändern (Parallelisierung auf O(n²)
 * skaliert die Zeit nicht herunter, sie verteilt sie — und vervielfacht den
 * Speicher). Der Runner ruft den Engine-Pfad deshalb **nur** über den
 * injizierten Port; `src/screening/backtestAdapter.ts` ist die
 * Produktiv-Verdrahtung.
 *
 * ── CPU-Last: seriell im Prozess ──────────────────────────────────────────
 * Die Backtests laufen **sequenziell** in diesem Prozess (serielles Schloss um
 * den CPU-Abschnitt). Begrenzt wird ausschließlich die **I/O**-Nebenläufigkeit
 * ({@link SCREENING_DEFAULT_CONCURRENCY}, p-limit-Muster wie
 * `src/marketdata/sync.ts`): Versionsauflösung und Zell-Persistenz. Ein
 * paralleles Scheduling der Engine wäre erst mit einem Pilot-Beleg
 * gerechtfertigt (STX-12) — und ist für 05-04 ausdrücklich gesperrt.
 *
 * ── Harte Grenzen ─────────────────────────────────────────────────────────
 * `maxCells` (Default aus 05-02: {@link MAX_MATRIX_CELLS}) wird **vor** jedem
 * DB-Zugriff und vor jedem Backtest geprüft. Über dem Limit gibt es
 * `{ok:false}` mit exakter Meldung — es wird **nicht** still gekürzt.
 *
 * Die drei Caps des Regel-Backtest-Pfads (`RULE_BACKTEST_MIN_BARS = 100`,
 * `RULE_BACKTEST_TRADE_CAP = 200`, `RULE_BACKTEST_EQUITY_CAP = 120`,
 * `src/lib/ruleBacktest.ts`) sind die **Vergleichbarkeitshülle** einer Zelle:
 * ein Lauf darüber ist mit dem API-/Referenzpfad nicht vergleichbar. Eine
 * solche Zelle wird `BLOCKED` mit Grund `caps exceeded` — **nicht** gekappt
 * abgelegt. Ein gekapptes Ergebnis würde eine Screening-Aussage über Zahlen
 * treffen, die der Referenzpfad nie geliefert hätte.
 *
 * ── Fortschritt, Abbruch, Fortsetzung ─────────────────────────────────────
 * `cells_done` ist der **zusammenhängende** erledigte Prefix der stabilen
 * Matrixreihenfolge. Ein Abbruch (Signal, Fehler) schreibt `ABORTED` bzw.
 * `FAILED` und lässt den Stand stehen; `resumeRunId` setzt genau dort fort.
 * Bereits geschriebene Zellen werden nie überschrieben (`upsertCells` ist
 * insert-only): ein Lauf mit anderem Inhalt ist wegen des `ssr1:`-Run-Hashes
 * ein **neuer** Lauf.
 */

import {
  RULE_BACKTEST_EQUITY_CAP,
  RULE_BACKTEST_MIN_BARS,
  RULE_BACKTEST_TRADE_CAP,
} from "@/lib/ruleBacktest";
import { metricLabel, telemetry } from "@/lib/telemetry";
import { DEFAULT_MATRIX_LIMITS, MAX_MATRIX_CELLS, type MatrixLimits } from "./matrix";
import {
  createOrGetRun,
  setRunStatus,
  upsertCells,
  type CreateScreeningRunInput,
  type RunRow,
  type ScreeningCellInput,
  type ScreeningRunCounts,
} from "./store";
import {
  SCREENING_CELL_RESULTS,
  type CandidateStatus,
  type ScreeningCellResult,
  type ScreeningRunKind,
  type ScreeningRunStatus,
  type StrategyMarketCandidate,
} from "./types";

// ───────────────────────────────────────────────────────────────────────────
// 1) Pfad-Entscheidung aus 00-01 (Konstante, kein Entscheidungspunkt im Code)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Backtest-Pfad des Screening-Runners — **verbindlich** aus 00-01.
 *
 * Quelle: `docs/audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md`
 * §6 (Prompt 00-01, Finding STX-12, Release `v0.6.0`). Die Messung hat
 * `runMultiAssetBacktest()` mit **121,7×** Vorsprung und Exponent ≈ 1 gegen
 * `backtestRule()` mit Exponent ≈ 2 entschieden; die Roadmap-Gates G5/G6
 * (ROADMAP.md §Phase 5) hängen daran. Ein Wechsel dieses Werts ist eine
 * **Architekturentscheidung** und braucht eine neue Messung — nicht einen
 * neuen Default.
 */
export const SCREENING_BACKTEST_PATH = "multiAsset" as const;
export type ScreeningBacktestPath = typeof SCREENING_BACKTEST_PATH;

/** Nebenläufigkeit des I/O-Pfads (Default); die CPU bleibt seriell. */
export const SCREENING_DEFAULT_CONCURRENCY = 4;
/** Harte Obergrenze der I/O-Nebenläufigkeit (Repo-Muster `src/marketdata/`). */
export const SCREENING_MAX_CONCURRENCY = 8;
/**
 * Fortschritt wird erst nach dieser vielen Zellen **zwischen**geschrieben; auf
 * Abbruch/Ende immer exakt. Das hält 5 000 Zellen von 5 000
 * Fortschritts-Transaktionen frei, ohne den Stand zu verlieren.
 */
export const SCREENING_PROGRESS_EVERY = 25;

// ───────────────────────────────────────────────────────────────────────────
// 2) Injectionsports
// ───────────────────────────────────────────────────────────────────────────

/**
 * Persistenz-Port des Runners. Default ist der Store aus 05-03
 * ({@link defaultScreeningStore}); Tests injizieren einen In-Memory-Stub.
 * Bewusst **ohne** DELETE- und ohne Zell-UPDATE-Pfad — genau wie `store.ts`.
 */
export interface ScreeningStorePort {
  createOrGetRun(input: CreateScreeningRunInput): Promise<RunRow>;
  upsertCells(runId: string, cells: readonly ScreeningCellInput[]): Promise<number>;
  setRunStatus(
    runId: string,
    status: ScreeningRunStatus,
    counts?: ScreeningRunCounts,
  ): Promise<RunRow>;
}

/** Produktiv-Port: die Funktionen aus `src/screening/store.ts`. */
export const defaultScreeningStore: ScreeningStorePort = {
  createOrGetRun: (input) => createOrGetRun(input),
  upsertCells: (runId, cells) => upsertCells(runId, cells),
  setRunStatus: (runId, status, counts) => setRunStatus(runId, status, counts),
};

/** Belegte Größen eines Zell-Backtests — Grundlage der Caps-Prüfung. */
export interface ScreeningBacktestCounts {
  /** Verarbeitete Kerzen; `null` = unbekannt (fail-closed, nie 0). */
  bars: number | null;
  /** Erzeugte Trades; `null` = unbekannt. */
  trades: number | null;
  /** Punkte der Equity-Kurve; `null` = unbekannt. */
  equityPoints: number | null;
}

/** Auftrag eines Zell-Backtests an den injizierten Pfad. */
export interface ScreeningBacktestRequest {
  /** Die Zelle der Matrix (stabil sortiert, unverändert übernommen). */
  cell: StrategyMarketCandidate;
  /** Aufgelöste `strategy_versions.id` — Pflicht für die Zellpersistenz. */
  strategyVersionId: string;
  /** Gemeinsamer PIT-Cutoff des Laufs (normalisierte UTC-ISO-Zeit). */
  asOf: string;
  /** Index in der stabilen Matrixreihenfolge (0-basiert). */
  index: number;
}

/**
 * Ergebnis eines Zell-Backtests.
 *
 * `counts` ist die **Wahrheit über die Größe** des Laufs; der Runner leitet
 * daraus die Vergleichbarkeit ab und speichert bei einem Verstoß **nichts**.
 * `metrics` bleibt `null`, solange nichts belastbar gemessen wurde —
 * unbekannt ist kein Score von 0.
 */
export interface ScreeningBacktestOutcome {
  /** Persistierter `backtest_runs.id`; `null`, wenn nichts persistiert wurde. */
  backtestRunId: string | null;
  /** Belastbare Kennzahlen; `null` = unbekannt. */
  metrics: Readonly<Record<string, unknown>> | null;
  counts: ScreeningBacktestCounts;
  /**
   * Klassifizierter Fehlercode (bounded, z. B. `candles:too-few`). Er zählt
   * die Zelle als `failed`; die Zelle selbst bleibt ohne Metriken.
   */
  error?: string | null;
}

/**
 * Backtest-Port. Produktiv: `createMultiAssetBacktestPort()` aus
 * `src/screening/backtestAdapter.ts` (Engine-Pfad, siehe
 * {@link SCREENING_BACKTEST_PATH}). Tests: Stub ohne Engine.
 */
export interface ScreeningBacktestPort {
  run(request: ScreeningBacktestRequest): Promise<ScreeningBacktestOutcome>;
}

/** Auflösung der Strategieversion je Zelle (04-02-Service im Produktivpfad). */
export type ScreeningVersionResolver = (
  cell: StrategyMarketCandidate,
  index: number,
) => string | null | Promise<string | null>;

// ───────────────────────────────────────────────────────────────────────────
// 3) Ein-/Ausgabe
// ───────────────────────────────────────────────────────────────────────────

/** Eingabe von {@link runScreening}. */
export interface ScreeningRunInput {
  /** Stabil sortierte Zellen aus `buildCandidateMatrix()` (05-02). */
  cells: readonly StrategyMarketCandidate[];
  runKind: ScreeningRunKind;
  /** Gemeinsamer Point-in-Time-Cutoff (ISO, Epoch-ms oder Date). */
  asOf: Date | string | number;
  /** Code-Version des Laufs (`APP_VERSION`) — Teil der Run-Identität. */
  codeVersion: string;
  dataVersion?: string | null;
  /**
   * Vollständige, aufgelöste Laufkonfiguration (Prioritätsgewichte **und**
   * Matrix-/Job-Limits). Sie gehört zur Run-Identität (`ssr1:`-Hash) — ein
   * partieller Override oder ein Dateiname genügt nicht.
   */
  config: Readonly<Record<string, unknown>>;
  /** Harte Grenzen; fehlende Felder fallen auf die Defaults aus 05-02 zurück. */
  limits?: Partial<MatrixLimits>;
  /** I/O-Nebenläufigkeit (Default {@link SCREENING_DEFAULT_CONCURRENCY}). */
  concurrency?: number;
  /**
   * Vorhandenen Lauf fortsetzen. Der Runner leitet den Run über den
   * `ssr1:`-Hash auf; die ID ist ein **Konsistenzcheck**: passt sie nicht zum
   * Inhalt, bricht der Lauf ab (ein anderer Inhalt ist ein neuer Lauf).
   */
  resumeRunId?: string | null;
  /** Strategieversions-ID je Zelle; `null` ⇒ Zelle nicht persistierbar. */
  resolveStrategyVersion: ScreeningVersionResolver;
  /** Backtest-Pfad (Engine im Betrieb, Stub im Test). */
  backtest: ScreeningBacktestPort;
  store?: ScreeningStorePort;
  /**
   * `true` = reine Matrix-/Discovery-Persistenz **ohne** Backtest. Der
   * Backtest-Port wird dann nicht aufgerufen (Kosten-/Laufzeit-Gate).
   */
  skipBacktest?: boolean;
  /** Abbruchsignal des Aufrufers (SIGINT im CLI). */
  shouldAbort?: () => boolean;
}

/** Ergebnis einer einzelnen verarbeiteten Zelle. */
export interface ScreeningCellOutcome {
  index: number;
  cell: StrategyMarketCandidate;
  /** Status, mit dem die Zelle persistiert wurde (bzw. worden wäre). */
  status: CandidateStatus;
  reasons: readonly string[];
  /** Bounded Telemetrie-Token (siehe `SCREENING_CELL_RESULTS`). */
  result: ScreeningCellResult;
  backtestRunId: string | null;
  /** `false` = nicht geschrieben (z. B. keine Strategieversion auflösbar). */
  persisted: boolean;
}

/** Zusammenfassung eines Screening-Laufs. */
export interface ScreeningRunResult {
  ok: boolean;
  /** Lauf-UUID; `null`, wenn der Lauf vor `createOrGetRun` abgebrochen ist. */
  runId: string | null;
  runKind: ScreeningRunKind;
  asOf: string;
  cellsTotal: number;
  cellsDone: number;
  cells: readonly ScreeningCellOutcome[];
  /** Zählung je Ergebnis-Token (geschlossenes Vokabular). */
  summary: Readonly<Record<ScreeningCellResult, number>>;
  /** BLOCKED-Zellen je Grund (Matrix-Gates + `caps exceeded`). */
  blockedByReason: Readonly<Record<string, number>>;
  /** Zellen, die an den Caps scheiterten — je Cap und gesamt. */
  caps: {
    /** Anzahl der an irgendeinem Cap gescheiterten Zellen. */
    exceededCells: number;
    /** Anzahl je Cap-Token (`min_bars` | `trade_cap` | `equity_cap`). */
    byCap: Readonly<Partial<Record<ScreeningCapToken, number>>>;
  };
  /** `true` = Lauf über ein Abbruchsignal beendet (Status `ABORTED`). */
  aborted: boolean;
  errors: readonly string[];
  wallClockMs: number;
}

// ───────────────────────────────────────────────────────────────────────────
// 4) Caps (Vergleichbarkeitshülle)
// ───────────────────────────────────────────────────────────────────────────

/** Bounded Tokens der Cap-Verletzung (kein Freitext, kein Instrument). */
export const SCREENING_CAP_TOKENS = ["min_bars", "trade_cap", "equity_cap"] as const;
export type ScreeningCapToken = (typeof SCREENING_CAP_TOKENS)[number];

/** Ergebnis der Caps-Prüfung einer Zelle. */
export interface ScreeningCapsCheck {
  ok: boolean;
  /** Verletzte Caps; leer, wenn `ok`. */
  exceeded: readonly ScreeningCapToken[];
}

/**
 * Prüft einen Zell-Lauf gegen die Hülle des Regel-Backtest-Pfads.
 *
 * Rein und deterministisch: gleiche `counts` ⇒ gleiches Ergebnis. Unbekannte
 * Größen (`null`) sind **fail-closed** ein Verstoß — eine unbekannte Trade-Zahl
 * ist nicht „unter 200“, sie ist unbekannt. Genau dieses fail-closed-Verhalten
 * ist der Grund, warum der Runner kein gekapptes Ergebnis ablegt: es gäbe
 * keinen Weg, die Kappung von der Wirklichkeit zu unterscheiden.
 */
export function checkScreeningCaps(counts: ScreeningBacktestCounts): ScreeningCapsCheck {
  const exceeded: ScreeningCapToken[] = [];
  if (counts.bars === null || counts.bars < RULE_BACKTEST_MIN_BARS) exceeded.push("min_bars");
  if (counts.trades === null || counts.trades > RULE_BACKTEST_TRADE_CAP) exceeded.push("trade_cap");
  if (counts.equityPoints === null || counts.equityPoints > RULE_BACKTEST_EQUITY_CAP) {
    exceeded.push("equity_cap");
  }
  return { ok: exceeded.length === 0, exceeded };
}

/** Grund einer an den Caps gescheiterten Zelle — stabiler Token in `reasons`. */
export const SCREENING_CAPS_REASON = "caps exceeded";

// ───────────────────────────────────────────────────────────────────────────
// 5) Hilfsfunktionen (rein)
// ───────────────────────────────────────────────────────────────────────────

const LIMIT_KEYS = [
  "maxInstruments",
  "maxTemplates",
  "maxTimeframesPerTemplate",
  "maxCells",
] as const;

/** Normalisiert den Cutoff auf UTC-ISO (identisch zu `screeningAsOf`). */
function normalizeAsOf(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("screening runner: asOf ist kein gültiger Zeitpunkt");
  }
  return date.toISOString();
}

/** Löst die harten Grenzen auf: Default + Override, ungültig ⇒ Fehler. */
function resolveRunLimits(raw: Partial<MatrixLimits> | undefined): {
  limits: MatrixLimits;
  errors: string[];
} {
  const limits: MatrixLimits = { ...DEFAULT_MATRIX_LIMITS };
  if (raw === undefined) return { limits, errors: [] };
  const errors: string[] = [];
  for (const key of LIMIT_KEYS) {
    const value = raw[key];
    if (value === undefined) continue; // nicht gesetzt ⇒ Default
    if (!Number.isSafeInteger(value) || value < 1) {
      errors.push(`limits.${key}: muss eine positive Ganzzahl sein`);
      continue;
    }
    limits[key] = value;
  }
  return { limits, errors };
}

/** Nebenläufigkeit: Default, hart gedeckelt, mindestens 1. */
function resolveConcurrency(value: number | undefined): number {
  if (value === undefined) return SCREENING_DEFAULT_CONCURRENCY;
  if (!Number.isSafeInteger(value) || value < 1) return SCREENING_DEFAULT_CONCURRENCY;
  return Math.min(value, SCREENING_MAX_CONCURRENCY);
}

/**
 * Bounded Map (p-limit-Muster, wie `mapBounded` in `src/cycle/promptBudget.ts`):
 * höchstens `limit` Tasks gleichzeitig, Ergebnisse in **Eingabereihenfolge**.
 * Kein `Promise.all` über alle Zellen — das würde bei 5 000 Zellen 5 000
 * parallele DB-Zugriffe in den Pool legen.
 */
export async function mapScreeningBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  const width = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length));
  let next = 0;
  const runners: Promise<void>[] = [];
  for (let w = 0; w < width; w++) {
    runners.push(
      (async () => {
        for (;;) {
          const index = next++;
          if (index >= items.length) return;
          results[index] = await worker(items[index], index);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}

/**
 * Serielles Schloss für den CPU-Abschnitt: die Engine läuft **nur** einen Lauf
 * gleichzeitig, egal wie viel I/O-Nebenläufigkeit der Pool hat. Ein Fehler im
 * vorigen Task blockiert den nächsten nicht.
 */
function createSerialLock(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  const swallow = (): void => {};
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task, task);
    tail = result.then(swallow, swallow);
    return result;
  };
}

/** Leere Zusammenfassung über dem geschlossenen Vokabular. */
function emptySummary(): Record<ScreeningCellResult, number> {
  return {
    discovered: 0,
    backtested: 0,
    blocked: 0,
    capped: 0,
    failed: 0,
    skipped: 0,
  };
}

/**
 * Baut die Store-Zeile einer Zelle. `status`/`reasons`/`metrics` werden nur
 * gesetzt, wenn der Lauf sie **belastbar** ermittelt hat — sonst bleiben die
 * Werte der Matrix (05-02) unverändert.
 */
function toCellInput(
  cell: StrategyMarketCandidate,
  strategyVersionId: string,
  backtestRunId: string | null,
  override: {
    status?: CandidateStatus;
    reasons?: readonly string[];
    metrics?: Readonly<Record<string, unknown>> | null;
  } = {},
): ScreeningCellInput {
  return {
    strategyVersionId,
    instrumentId: cell.instrumentId,
    venue: cell.venue,
    timeframe: cell.timeframe,
    templateId: cell.templateId,
    status: override.status ?? cell.status,
    priority: cell.priority,
    reasons: override.reasons ?? cell.reasons,
    backtestRunId,
    metrics: override.metrics ?? {},
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 6) Runner
// ───────────────────────────────────────────────────────────────────────────

/**
 * Führt einen Screening-Lauf aus: Matrix-Zellen ⇒ persistierte Zellen,
 * optional mit Backtest-Job dazwischen.
 *
 * Reihenfolge je Zelle: Strategieversion auflösen (I/O, bounded) ⇒ wenn nötig
 * Backtest (CPU, seriell) ⇒ Caps prüfen ⇒ `upsertCells` (I/O, bounded) ⇒
 * Fortschritt. Der Lauf selbst wird über `createOrGetRun` **einmal** angelegt.
 *
 * Nie geworfen wird für fachliche Ergebnisse: `maxCells`-Verstoß, Cap-Verstoß,
 * fehlende Version und Abbruch landen als `{ok:false}` bzw. als Zell-Status im
 * Ergebnis. Nur ein ungültiger Cutoff oder ein defekter Store brechen den Lauf
 * mit einem Fehler ab.
 */
export async function runScreening(input: ScreeningRunInput): Promise<ScreeningRunResult> {
  const startedAt = Date.now();
  const store = input.store ?? defaultScreeningStore;
  const concurrency = resolveConcurrency(input.concurrency);
  const summary = emptySummary();
  const blockedByReason = new Map<string, number>();
  const byCap = new Map<ScreeningCapToken, number>();
  const outcomes: ScreeningCellOutcome[] = [];
  const errors: string[] = [];

  const countBlocked = (reasons: readonly string[]): void => {
    for (const reason of reasons) {
      blockedByReason.set(reason, (blockedByReason.get(reason) ?? 0) + 1);
    }
  };

  // ── 1) Harte Grenzen VOR jedem DB-Zugriff und vor jedem Backtest ────────
  const { limits, errors: limitErrors } = resolveRunLimits(input.limits);
  let asOf: string;
  try {
    asOf = normalizeAsOf(input.asOf);
  } catch (e) {
    return {
      ok: false,
      runId: null,
      runKind: input.runKind,
      asOf: "",
      cellsTotal: input.cells.length,
      cellsDone: 0,
      cells: [],
      summary,
      blockedByReason: {},
      caps: { exceededCells: 0, byCap: {} },
      aborted: false,
      errors: [e instanceof Error ? e.message : String(e)],
      wallClockMs: Date.now() - startedAt,
    };
  }
  if (limitErrors.length > 0) {
    return {
      ok: false,
      runId: null,
      runKind: input.runKind,
      asOf,
      cellsTotal: input.cells.length,
      cellsDone: 0,
      cells: [],
      summary,
      blockedByReason: {},
      caps: { exceededCells: 0, byCap: {} },
      aborted: false,
      errors: limitErrors,
      wallClockMs: Date.now() - startedAt,
    };
  }
  if (input.cells.length > limits.maxCells) {
    // Kein stilles Kürzen: der Lauf existiert noch nicht einmal.
    return {
      ok: false,
      runId: null,
      runKind: input.runKind,
      asOf,
      cellsTotal: input.cells.length,
      cellsDone: 0,
      cells: [],
      summary,
      blockedByReason: {},
      caps: { exceededCells: 0, byCap: {} },
      aborted: false,
      errors: [
        `matrix too large: ${input.cells.length} > ${limits.maxCells} — Abbruch ohne Kürzung ` +
          `(--max-cells ist hart; --limit-cells kürzt bewusst und sichtbar)`,
      ],
      wallClockMs: Date.now() - startedAt,
    };
  }

  // ── 2) Lauf anlegen (idempotent über den ssr1:-Hash) ───────────────────
  let run: RunRow;
  try {
    run = await store.createOrGetRun({
      runKind: input.runKind,
      cells: input.cells,
      asOf,
      codeVersion: input.codeVersion,
      dataVersion: input.dataVersion ?? null,
      config: input.config,
    });
  } catch (e) {
    return {
      ok: false,
      runId: null,
      runKind: input.runKind,
      asOf,
      cellsTotal: input.cells.length,
      cellsDone: 0,
      cells: [],
      summary,
      blockedByReason: {},
      caps: { exceededCells: 0, byCap: {} },
      aborted: false,
      errors: [`createOrGetRun fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`],
      wallClockMs: Date.now() - startedAt,
    };
  }

  const buildResult = (status: ScreeningRunStatus, done: number): ScreeningRunResult => ({
    ok: status === "DONE" && errors.length === 0,
    runId: run.id,
    runKind: input.runKind,
    asOf,
    cellsTotal: input.cells.length,
    cellsDone: done,
    cells: [...outcomes].sort((a, b) => a.index - b.index),
    summary,
    blockedByReason: Object.fromEntries(blockedByReason),
    caps: { exceededCells: summary.capped, byCap: Object.fromEntries(byCap) },
    aborted: status === "ABORTED",
    errors,
    wallClockMs: Date.now() - startedAt,
  });

  const safeStatus = async (status: ScreeningRunStatus, done: number): Promise<void> => {
    try {
      await store.setRunStatus(run.id, status, { cellsDone: done });
    } catch (e) {
      errors.push(`${status} nicht schreibbar: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Konsistenzcheck des Fortsetzungs-Hinweises: derselbe Inhalt ⇒ dieselbe ID.
  if (input.resumeRunId !== undefined && input.resumeRunId !== null) {
    if (input.resumeRunId !== run.id) {
      await safeStatus("ABORTED", run.cellsDone);
      errors.push(
        `resume: --run-id ${input.resumeRunId} gehört nicht zu diesem Inhalt ` +
          `(Hash ${run.candidateSetHash} ⇒ Lauf ${run.id}). Ein anderer Inhalt ist ein neuer Lauf.`,
      );
      return buildResult("ABORTED", run.cellsDone);
    }
  }

  // ── 3) Fortsetzung: erledigter Prefix der stabilen Reihenfolge ──────────
  const alreadyDone = Math.max(0, Math.min(run.cellsDone, input.cells.length));
  for (let i = 0; i < alreadyDone; i++) {
    const cell = input.cells[i];
    outcomes.push({
      index: i,
      cell,
      status: cell.status,
      reasons: cell.reasons,
      result: "skipped",
      backtestRunId: null,
      persisted: true,
    });
    summary.skipped += 1;
    telemetry.screening.cells.inc({ result: "skipped" });
    countBlocked(cell.status === "BLOCKED" ? cell.reasons : []);
  }
  const pending = input.cells.slice(alreadyDone);

  let cellsDone = alreadyDone;
  let aborted = false;
  let failed = false;
  const cpuLock = createSerialLock();

  const flushProgress = async (final: boolean): Promise<void> => {
    const processed = cellsDone - alreadyDone;
    if (!final && processed > 0 && processed % SCREENING_PROGRESS_EVERY !== 0) return;
    try {
      const row = await store.setRunStatus(run.id, "RUNNING", { cellsDone });
      // Monotonie des Stores respektieren: nie weniger melden als gespeichert.
      cellsDone = Math.max(cellsDone, row.cellsDone);
    } catch (e) {
      failed = true;
      errors.push(`Fortschritt nicht schreibbar: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** Zählt ein Zellergebnis in Zusammenfassung **und** gebundenen Zähler. */
  const tally = (result: ScreeningCellResult, reasons: readonly string[]): void => {
    summary[result] += 1;
    telemetry.screening.cells.inc({ result });
    countBlocked(reasons);
  };

  /**
   * Einzelner Zell-Insert. Ein Fehler hier ist ein **Lauf**fehler (der Store
   * hat keine Transaktion aufgemacht), nicht ein Zellergebnis: die Zelle wird
   * als nicht geschrieben gemeldet, der Lauf endet als FAILED.
   */
  const persist = async (row: ScreeningCellInput, index: number): Promise<number> => {
    try {
      return await store.upsertCells(run.id, [row]);
    } catch (e) {
      failed = true;
      errors.push(
        `Zelle ${index}: nicht persistierbar (${e instanceof Error ? e.message : String(e)})`,
      );
      return 0;
    }
  };

  try {
    await store.setRunStatus(run.id, "RUNNING", { cellsDone });

    await mapScreeningBounded(pending, concurrency, async (cell, offset) => {
      const index = alreadyDone + offset;
      if (input.shouldAbort?.()) {
        aborted = true;
        return;
      }

      // a) Strategieversion auflösen (I/O, bounded). Ohne Version keine Zelle:
      //    der FK ist Pflicht, und der Store erfindet keine Version.
      let strategyVersionId: string | null = null;
      try {
        strategyVersionId = await input.resolveStrategyVersion(cell, index);
      } catch (e) {
        errors.push(
          `Zelle ${index}: Version nicht auflösbar (${e instanceof Error ? e.message : String(e)})`,
        );
      }
      if (strategyVersionId === null) {
        outcomes.push({
          index,
          cell,
          status: cell.status,
          reasons: [...cell.reasons, "strategy version unresolved"],
          result: "failed",
          backtestRunId: null,
          persisted: false,
        });
        tally("failed", []);
        cellsDone += 1;
        await flushProgress(false);
        return;
      }

      // b) Bereits gesperrte Zelle: kein Backtest, kein Job. Die Gründe
      //    (warmup/Scan/Schwellen) kommen unverändert aus 05-02.
      if (cell.status === "BLOCKED") {
        const inserted = await persist(
          toCellInput(cell, strategyVersionId, null),
          index,
        );
        outcomes.push({
          index,
          cell,
          status: "BLOCKED",
          reasons: cell.reasons,
          result: "blocked",
          backtestRunId: null,
          persisted: inserted > 0,
        });
        tally("blocked", cell.reasons);
        cellsDone += 1;
        await flushProgress(false);
        return;
      }

      // c) Optionaler Backtest — CPU, seriell im Prozess.
      if (input.skipBacktest === true) {
        const inserted = await persist(
          toCellInput(cell, strategyVersionId, null),
          index,
        );
        outcomes.push({
          index,
          cell,
          status: cell.status,
          reasons: cell.reasons,
          result: "discovered",
          backtestRunId: null,
          persisted: inserted > 0,
        });
        tally("discovered", []);
        cellsDone += 1;
        await flushProgress(false);
        return;
      }

      let outcome: ScreeningBacktestOutcome;
      try {
        outcome = await cpuLock(() =>
          input.backtest.run({ cell, strategyVersionId, asOf, index }),
        );
      } catch (e) {
        errors.push(
          `Zelle ${index}: Backtest fehlgeschlagen (${e instanceof Error ? e.message : String(e)})`,
        );
        outcomes.push({
          index,
          cell,
          status: cell.status,
          reasons: [...cell.reasons, "backtest failed"],
          result: "failed",
          backtestRunId: null,
          persisted: false,
        });
        tally("failed", []);
        cellsDone += 1;
        await flushProgress(false);
        return;
      }

      // d) Caps: ein Lauf darüber ist nicht vergleichbar ⇒ BLOCKED, kein
      //    gekapptes Ergebnis.
      const caps = checkScreeningCaps(outcome.counts);
      if (outcome.error || !caps.ok) {
        const reasons = [...cell.reasons];
        if (!caps.ok) {
          reasons.push(SCREENING_CAPS_REASON);
          for (const token of caps.exceeded) {
            byCap.set(token, (byCap.get(token) ?? 0) + 1);
          }
        }
        if (outcome.error) reasons.push(`backtest: ${metricLabel(outcome.error, "OTHER")}`);
        const inserted = await persist(
          toCellInput(cell, strategyVersionId, null, {
            status: "BLOCKED",
            reasons,
            metrics: null,
          }),
          index,
        );
        outcomes.push({
          index,
          cell,
          status: "BLOCKED",
          reasons,
          result: caps.ok ? "failed" : "capped",
          backtestRunId: null,
          persisted: inserted > 0,
        });
        tally(caps.ok ? "failed" : "capped", reasons);
        cellsDone += 1;
        await flushProgress(false);
        return;
      }

      // e) Vergleichbarer Lauf: Metriken + Backtest-Link in die Zelle.
      const inserted = await persist(
        toCellInput(cell, strategyVersionId, outcome.backtestRunId, {
          status: "BACKTEST",
          metrics: outcome.metrics,
        }),
        index,
      );
      outcomes.push({
        index,
        cell,
        status: "BACKTEST",
        reasons: cell.reasons,
        result: "backtested",
        backtestRunId: outcome.backtestRunId,
        persisted: inserted > 0,
      });
      tally("backtested", []);
      cellsDone += 1;
      await flushProgress(false);
    });
  } catch (e) {
    // Unerwarteter Laufzeitfehler (z. B. Store ohne Transaktion): Stand
    // sichern, dann FAILED — nicht DONE, nicht schweigen.
    failed = true;
    errors.push(`Lauf abgebrochen: ${e instanceof Error ? e.message : String(e)}`);
  }

  await flushProgress(true);

  // ── 4) Abschlussstatus ─────────────────────────────────────────────────
  if (aborted) {
    await safeStatus("ABORTED", cellsDone);
    errors.push("Lauf abgebrochen (Signal) — mit --run-id fortsetzbar");
    return buildResult("ABORTED", cellsDone);
  }
  if (failed) {
    await safeStatus("FAILED", cellsDone);
    return buildResult("FAILED", cellsDone);
  }
  await safeStatus("DONE", cellsDone);
  return buildResult("DONE", cellsDone);
}

/** Re-Export der harten Zellgrenze aus 05-02 (Default von `--max-cells`). */
export { MAX_MATRIX_CELLS };

/** Geschlossenes Vokabular der Zellergebnisse (Label-Dimension der Metrik). */
export { SCREENING_CELL_RESULTS };
export type { ScreeningCellResult };
