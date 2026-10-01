/**
 * STX-05-02 — Matrix-Builder: Strategie × Instrument × Timeframe.
 *
 * Erzeugt aus dem Template-Katalog, den injizierten Datenanbindungen und
 * (optional) dem Scanner-Ergebnis die **Candidate Matrix**: genau eine Zelle
 * je Kombination (Template, Instrument, tf ∈ template.supportedTimeframes) —
 * die Zelle, mit der die Analyse „Strategie × Markt“ beschreibt.
 *
 * ── Zweck ─────────────────────────────────────────────────────────────────
 * Die Zelle ist der `StrategyMarketCandidate` aus 05-01. Ihre `priority`
 * (ergeben aus `scoreCandidate()`) entscheidet die Reihenfolge der folgenden
 * Schritte; die **stabile Sortierung** (priority desc, dann templateId,
 * instrumentId, timeframe) macht 05-03/05-04 idempotent. `status`/`reasons`
 * kommen aus der Frühklassifikation von 05-01 (`classifyCandidate`) plus den
 * Gates dieses Moduls (warmup, Scan) — dieser Builder erzeugt bewusst
 * **keine** `BACKTEST`/`VALIDATED`/`PAPER`-Übergänge (das ist 05-04).
 *
 * ── Reinheit: kein IO in der Kernfunktion ─────────────────────────────────
 * `buildCandidateMatrix()` führt KEINEN IO aus: keine DB, kein Store, kein
 * Netzwerk, keine Datei, keine eigene Uhr — `now` ist injiziert (Muster
 * `ScanDataProvider` in `src/scanner/pipeline.ts`). Alle Datenquellen sind
 * synchron injizierte Funktionen und werden je Schlüssel (Instrument bzw.
 * Instrument×Timeframe) **genau einmal** aufgerufen; die Memoization ist
 * rein beschleunigend und verändert das Ergebnis nicht. Gleiche Eingabe ⇒
 * byte-identische Zellen.
 *
 * ── Harte Grenzen (fail-closed) ──────────────────────────────────────────
 * {@link MatrixLimits} begrenzt Instrumente, Templates, Timeframes je
 * Template und die Gesamtzellzahl (Default + Override, jedes Feld als
 * positive Ganzzahl validiert). `maxCells` ist ein DoS-/Kosten-Guard,
 * **kein** Tuning-Knopf: Wird die Kombinatorik überschritten, liefert der
 * Builder `{ok:false, errors:["matrix too large: N > 5000"]}` — es wird
 * **nicht** still gekürzt. Die Prüfung läuft **vor** jedem injizierten
 * Datenzugriff; ein übergroßer Auftrag kostet daher nichts.
 *
 * ── Zeitzustand (Warmup) ─────────────────────────────────────────────────
 * Eine Zelle wird nur dann nicht-gesperrt erzeugt, wenn
 * `requiredWarmupCandles(tf) ≤` die verfügbaren Kerzen der Reihe
 * (Instrument × Timeframe) sind. Zu wenig ⇒ die Zelle entsteht **trotzdem**,
 * aber mit `status: "BLOCKED"` und `reasons: ["warmup: 29 < 100"]` — nie
 * still übersprungen. Diese Datenlage ist in der Praxis die eigentliche
 * Mengenbegrenzung (STX-Report L12: `RULE_BACKTEST_MIN_BARS`), nicht die
 * Strategiezahl.
 *
 * ── Timeframe-Filter ─────────────────────────────────────────────────────
 * Eine Zelle entsteht nur, wenn `tf ∈ template.supportedTimeframes`. Erst
 * dieser Filter macht die Template-Entscheidungen aus 03-03 (kein Intraday)
 * und 03-07 (kein `1d`) überhaupt durchsetzbar — ohne ihn würde jede
 * Strategie auf jedem Takt „getestet“.
 *
 * ── Scan (optional, lesend) ───────────────────────────────────────────────
 * Ohne `scan` kennt der Builder keine Scan-Ablehnungen; die Zellen tragen
 * dann ausschließlich die Frühstatus (`DISCOVERED`) bzw. `BLOCKED` aus der
 * Datenlage (warmup/Schwellen). Mit `scan` wird das Scanner-Ergebnis
 * **gelesen**, nicht fortgeschrieben: ist ein Instrument nicht Teil des
 * Scans oder hat der Eignungsfilter (`checkEligibility`) es abgelehnt,
 * entsteht die Zelle als `BLOCKED` mit dem Scan-Grund — sichtbar in
 * `blockedByReason`, nie still verschwiegen. Der Scanner selbst bleibt
 * unverändert (nur gelesen).
 *
 * ── Cross-Sectional-Rang (optionaler Faktor, keine zweite Eligibility) ────
 * `crossSectionalMomentum` ist ein optionaler Scanner-Faktor und **kein**
 * Faktor-Default. Er speist hier `strategyFit` (die einzige im Input
 * verfügbare, belastbare Passungsquelle ohne IO): Perzentil des
 * Point-in-Time-Querschnitts. Fehlt der Rang — kein injizierter Kontext,
 * ungültige Werte oder ein Snapshot aus der **Zukunft** (`ctx.asOf > now`,
 * PIT-Verbot von Lookahead) —, wird `strategyFit` mit dem dokumentierten
 * Neutralwert **0.5** belegt (`CROSS_SECTIONAL_MOMENTUM_NEUTRAL`, Median
 * des Querschnitts): nie 0, nie still „schlecht“. Das ist die bestehende
 * Konvention des Scanners, hier nicht neu erfunden.
 */

import { BROKER_VENUE_IDS, type BrokerVenueId } from "@/contracts/broker";
import type { CrossSectionalRankContext } from "@/crossSectional/types";
import {
  SUPPORTED_TIMEFRAMES,
  isSupportedTimeframe,
  type SupportedTimeframe,
} from "@/lib/marketdata/historicalStore";
import { RULE_BACKTEST_MIN_BARS } from "@/lib/ruleBacktest";
import { CROSS_SECTIONAL_MOMENTUM_NEUTRAL } from "@/scanner/factors/crossSectionalMomentum";
import type { FilterRejection } from "@/scanner/filters";
import type { ScanResult } from "@/scanner/pipeline";
import { isStrategyTemplateId, type StrategyTemplateId } from "@/strategies/catalog";
import type { StrategyTemplate } from "@/strategies/types";
import type { MarketInstrument } from "@/universe/types";
import {
  DEFAULT_SCREENING_PRIORITY_CONFIG,
  type ScreeningPriorityConfig,
} from "./config";
import { classifyCandidate, scoreCandidate } from "./priority";
import type { StrategyMarketCandidate } from "./types";

// ───────────────────────────────────────────────────────────────────────────
// 1) Harte Grenzen (fail-closed, Default + Override)
// ───────────────────────────────────────────────────────────────────────────

/** Harte Obergrenze der Matrix über die Instrumente (500 = Funnel-Ebene 3). */
export const MAX_MATRIX_INSTRUMENTS = 500;
/** Harte Obergrenze der Matrix über die Templates. */
export const MAX_MATRIX_TEMPLATES = 16;
/** Harte Obergrenze der Timeframes je Template. */
export const MAX_MATRIX_TIMEFRAMES_PER_TEMPLATE = 3;
/**
 * HARTE Obergrenze der Gesamtzellzahl (DoS-/Kosten-Guard, kein
 * Tuning-Knopf). Über dem Limit gibt es `{ok:false}`, kein stilles Kürzen.
 */
export const MAX_MATRIX_CELLS = 5_000;

/** Grenzen des Matrix-Bauers — jedes Feld positive Ganzzahl, sonst Fehler. */
export interface MatrixLimits {
  maxInstruments: number;
  maxTemplates: number;
  maxTimeframesPerTemplate: number;
  maxCells: number;
}

/** Fail-closed Defaultwerte; Caller überschreibt per Spread (Default + Override). */
export const DEFAULT_MATRIX_LIMITS: MatrixLimits = Object.freeze({
  maxInstruments: MAX_MATRIX_INSTRUMENTS,
  maxTemplates: MAX_MATRIX_TEMPLATES,
  maxTimeframesPerTemplate: MAX_MATRIX_TIMEFRAMES_PER_TEMPLATE,
  maxCells: MAX_MATRIX_CELLS,
});

const LIMIT_KEYS = [
  "maxInstruments",
  "maxTemplates",
  "maxTimeframesPerTemplate",
  "maxCells",
] as const;

/**
 * Löst die Grenzen auf: fehlende Felder fallen auf die Defaultwerte zurück
 * (die Grenzen bleiben damit immer wirksam), ungültige Felder erzeugen einen
 * Fehler — nie wird ein Grenzwert still gezogen oder gekappt.
 */
function resolveMatrixLimits(raw: MatrixLimits | undefined): {
  limits: MatrixLimits;
  errors: string[];
} {
  const errors: string[] = [];
  const limits: MatrixLimits = { ...DEFAULT_MATRIX_LIMITS };
  if (raw === undefined) return { limits, errors };
  if (raw === null || typeof raw !== "object") {
    return { limits, errors: ["limits: MatrixLimits-Objekt erforderlich"] };
  }
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

// ───────────────────────────────────────────────────────────────────────────
// 2) Injizierte Datenanbindungen (Contract-Typen)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Stichprobe der Datenqualität je (Instrument, Timeframe).
 *
 * Der Builder braucht zwei Dinge aus einer Hand: den gebundenen
 * Qualitätsscore **und** die Anzahl verfügbarer Kerzen — letztere ist die
 * Grundlage der Warmup-Prüfung (Zeitzustand). `score: null` bedeutet
 * „unbekannt“, nie 0 (Repo-Konvention); eine unbekannte Kerzenzahl
 * (undefined/NaN/∞) fällt fail-closed in den warmup-Gate.
 */
export interface QualitySample {
  /** Datenqualität [0,1]; null = unbekannt (nie 0!). */
  score: number | null;
  /** Verfügbare Kerzen der Reihe (Instrument × Timeframe). */
  candles: number;
}

/**
 * Liquiditätsstichprobe eines Instruments.
 *
 * Nur `score` fließt in die Zelle ein. `spreadPct`/`bookDepthUsd` sind Teil
 * des Provider-Vertrags (Provenanz für spätere Schritte), werden hier aber
 * **nicht** zu einem Score umgerechnet — eine erfundene Formel wäre eine
 * zweite Wahrheit über Liquidität; unknown bleibt unknown.
 */
export interface LiquiditySample {
  score: number | null;
  spreadPct: number | null;
  bookDepthUsd: number | null;
}

// ───────────────────────────────────────────────────────────────────────────
// 3) Warmup-Bedarf (Zeitzustand)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Warmup-Bedarf einer Screening-Zelle — die einzige Warmup-Wahrheit dieses
 * Moduls (kein zweites Harter-Konstanten-Durcheinander).
 *
 * Der Bedarf ist **bar-basiert** und für alle Timeframes gleich, mit
 * bestehender Quelle: `RULE_BACKTEST_MIN_BARS` aus `src/lib/ruleBacktest.ts`
 * (L12 des STX-Reports — „die Warmup-Verfügbarkeit ist der eigentliche
 * Filter“). Kein eigener Wert, keine eigene Tabelle. Die Signatur bleibt
 * `tf`-parametrisch, weil (a) die Allowlist hier mitvalidiert wird und
 * (b) 05-04 mit dem span-basierten Multi-Asset-Pfad eine kalibrierbare
 * Stelle braucht, falls dort je Timeframe ein anderer Bedarf entsteht —
 * dann wird diese Funktion angepasst, nicht der Runner.
 *
 * @throws {Error} bei unbekanntem Timeframe (defensive Absicherung; der
 *   Builder prüft die Allowlist vorab und wirft hier nie).
 */
export function requiredWarmupCandles(tf: SupportedTimeframe): number {
  if (!isSupportedTimeframe(tf)) {
    throw new Error(`requiredWarmupCandles: unbekannter Timeframe „${String(tf)}“`);
  }
  return RULE_BACKTEST_MIN_BARS;
}

// ───────────────────────────────────────────────────────────────────────────
// 4) Ein-/Ausgabe
// ───────────────────────────────────────────────────────────────────────────

/** Eingabe des Matrix-Bauers — alle Datenanbindungen sind injiziert. */
export interface MatrixInput {
  /** Kandidaten-Instrumente (bereits vorgewählt, z. B. aus dem Scan-Funnel). */
  instruments: readonly MarketInstrument[];
  /** Template-Katalog (z. B. `STRATEGY_TEMPLATES`). */
  templates: readonly StrategyTemplate[];
  /**
   * Optional: Scanner-Ergebnis. Mit Scan werden Scan-Ablehnungen als
   * `BLOCKED`-Grund in die Zelle übernommen (lesend, kein Scanner-Umbau).
   * Ohne Scan gibt es keine Scan-Gründe — nur Frühstatus + Datenlage.
   */
  scan?: ScanResult;
  /**
   * Optionaler Cross-Sectional-Rang je Instrument-ID (Point-in-Time).
   * `null`/fehlend ⇒ `strategyFit` = Neutralwert 0.5 (nie 0).
   */
  crossSectional?: (id: string) => CrossSectionalRankContext | null;
  /** Datenqualität + verfügbare Kerzen je (Instrument, Timeframe). */
  dataQuality: (instr: MarketInstrument, tf: SupportedTimeframe) => QualitySample;
  /** Liquiditätsstichprobe je Instrument. */
  liquidity: (instr: MarketInstrument) => LiquiditySample;
  /** Frische [0,1] je (Instrument, Timeframe); null = unbekannt. */
  freshness: (instr: MarketInstrument, tf: SupportedTimeframe) => number | null;
  /** Cluster-/Korrelationszuschlag [0,1]; null = Zusatzanalyse nicht durchgeführt. */
  correlation: (instr: MarketInstrument) => number | null;
  /** Volatilitäts-Chancenklasse [0,1] je (Instrument, Timeframe). */
  volatilityOpportunity: (
    instr: MarketInstrument,
    tf: SupportedTimeframe,
  ) => number | null;
  /** Injizierte Zeit (Unix-Epoch ms) — keine eigene Uhr im Builder. */
  now: number;
  /** Harte Bounds (Default + Override), siehe {@link MatrixLimits}. */
  limits: MatrixLimits;
  /** Prioritätskonfiguration; Default: `DEFAULT_SCREENING_PRIORITY_CONFIG`. */
  config?: ScreeningPriorityConfig;
}

/** Kennzahlen eines Matrix-Laufs (deterministisch, keine Laufzeitmessung). */
export interface MatrixStats {
  /** Anzahl verschiedener Instrumente in den Zellen. */
  instruments: number;
  /** Anzahl verschiedener Templates in den Zellen. */
  templates: number;
  /** Anzahl verschiedener Timeframes in den Zellen. */
  timeframes: number;
  /** Anzahl erzeugter Zellen (auch BLOCKED zählen — nichts wird übersprungen). */
  cells: number;
  /** Anzahl BLOCKED-Zellen je Grund (jeder Grund einer blockierten Zelle zählt). */
  blockedByReason: Record<string, number>;
}

/** Ergebnis des Matrix-Bauers. `errors` ist genau dann leer, wenn `ok`. */
export interface MatrixResult {
  ok: boolean;
  /** Stabil sortierte Zellen; leer, wenn `ok === false`. */
  cells: StrategyMarketCandidate[];
  stats: MatrixStats;
  errors: string[];
}

// ───────────────────────────────────────────────────────────────────────────
// 5) Hilfsfunktionen (rein)
// ───────────────────────────────────────────────────────────────────────────

/** Kanonische Rangfolge der Timeframes (aufsteigend nach Dauer, Allowlist). */
const TIMEFRAME_RANK: ReadonlyMap<string, number> = new Map(
  SUPPORTED_TIMEFRAMES.map((tf, index) => [tf, index] as const),
);

/** Normalisiert injizierte Metriken: nur `number` bleibt Zahl, Rest ⇒ null. */
function asMetric(value: number | null): number | null {
  return typeof value === "number" ? value : null;
}

/** Sortierfähige Priorität: nur endliche Zahlen sind sortierbar, sonst „unten“. */
function sortablePriority(priority: number | null): number | null {
  return priority !== null && Number.isFinite(priority) ? priority : null;
}

/**
 * Stabile Sortierung der Zellen: `priority` absteigend (unbekannt = ganz
 * unten), danach `templateId` asc, `instrumentId` asc, `timeframe` asc
 * (kanonische Allowlist-Reihenfolge). Eindeutige Zell-Schlüssel
 * (templateId, instrumentId, timeframe) machen die Ordnung total — das ist
 * die Idempotenz-Bedingung für 05-03/05-04.
 */
function compareCells(a: StrategyMarketCandidate, b: StrategyMarketCandidate): number {
  const pa = sortablePriority(a.priority);
  const pb = sortablePriority(b.priority);
  if (pa !== pb) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pb - pa; // absteigend
  }
  if (a.templateId !== b.templateId) return a.templateId < b.templateId ? -1 : 1;
  if (a.instrumentId !== b.instrumentId) return a.instrumentId < b.instrumentId ? -1 : 1;
  return (
    (TIMEFRAME_RANK.get(a.timeframe) ?? Number.MAX_SAFE_INTEGER) -
    (TIMEFRAME_RANK.get(b.timeframe) ?? Number.MAX_SAFE_INTEGER)
  );
}

/** Leere Stats für Fehlerpfade (kein Teil-Ergebnis, kein stilles Kürzen). */
function emptyStats(): MatrixStats {
  return { instruments: 0, templates: 0, timeframes: 0, cells: 0, blockedByReason: {} };
}

function fail(errors: string[]): MatrixResult {
  return { ok: false, cells: [], stats: emptyStats(), errors };
}

/** Vorbereitetes Template: validierte ID + duplikatfreie Timeframe-Liste. */
interface PreparedTemplate {
  readonly id: StrategyTemplateId;
  readonly template: StrategyTemplate;
  readonly timeframes: readonly SupportedTimeframe[];
}

/**
 * Validiert ein Template gegen die Grenzen und die Allowlist und liefert die
 * Timeframe-Liste in kanonischer Reihenfolge (Duplikate sind Fehler, weil
 * sie doppelte Zellen erzeugen würden).
 */
function prepareTemplate(
  template: StrategyTemplate,
  limits: MatrixLimits,
  errors: string[],
): PreparedTemplate | null {
  const id = template.id;
  if (!isStrategyTemplateId(id)) {
    errors.push(`unbekannte Template-ID „${String(id)}“`);
    return null;
  }
  const raw = template.supportedTimeframes;
  if (!Array.isArray(raw)) {
    errors.push(`Template „${id}“: supportedTimeframes fehlt oder ist kein Array`);
    return null;
  }
  if (raw.length === 0) {
    errors.push(`Template „${id}“: supportedTimeframes darf nicht leer sein`);
    return null;
  }
  if (raw.length > limits.maxTimeframesPerTemplate) {
    errors.push(
      `Template „${id}“: ${raw.length} Timeframes überschreiten das Limit ${limits.maxTimeframesPerTemplate}`,
    );
    return null;
  }
  const seen = new Set<SupportedTimeframe>();
  const timeframes: SupportedTimeframe[] = [];
  for (const tf of raw) {
    if (!isSupportedTimeframe(tf)) {
      errors.push(`Template „${id}“: unbekannter Timeframe „${String(tf)}“`);
      return null;
    }
    if (seen.has(tf)) {
      errors.push(`Template „${id}“: doppelter Timeframe „${tf}“`);
      return null;
    }
    seen.add(tf);
    timeframes.push(tf);
  }
  // Kanonische Reihenfolge (Allowlist = aufsteigend nach Dauer) — die
  // deklarierte Reihenfolge des Templates darf die Sortierung nicht prägen.
  timeframes.sort((a, b) => (TIMEFRAME_RANK.get(a) ?? 0) - (TIMEFRAME_RANK.get(b) ?? 0));
  return { id, template, timeframes };
}

// ───────────────────────────────────────────────────────────────────────────
// 6) Matrix-Bau
// ───────────────────────────────────────────────────────────────────────────

/**
 * Baut die Candidate Matrix (STX-05-02).
 *
 * Rein außer den injizierten Funktionen: kein IO, keine eigene Uhr, keine
 * Mutation der Eingaben. Fehlschläge sind **immer** `{ok:false}` mit
 * benannten Fehlern — es gibt keinen stillen Kürzungs-, Default- oder
 * Teilergebnis-Pfad.
 *
 * @example
 * ```ts
 * const result = buildCandidateMatrix({
 *   instruments, templates: STRATEGY_TEMPLATES, scan,
 *   dataQuality: (i, tf) => ({ score: qualityOf(i.id, tf), candles: countOf(i.id, tf) }),
 *   liquidity: (i) => liquidityOf(i.id),
 *   freshness: (i, tf) => freshnessOf(i.id, tf),
 *   correlation: (i) => correlationOf(i.id),
 *   volatilityOpportunity: (i, tf) => volOpportunityOf(i.id, tf),
 *   now: Date.now(),
 *   limits: DEFAULT_MATRIX_LIMITS,
 * });
 * if (result.ok) result.cells[0]; // höchste Priorität, stabil sortiert
 * ```
 */
export function buildCandidateMatrix(input: MatrixInput): MatrixResult {
  // ── Phase 1: Eingabe-Guards, Grenzen, injizierte Zeit, Config ───────────
  if (input === null || typeof input !== "object") {
    return fail(["input: MatrixInput erforderlich"]);
  }
  const errors: string[] = [];
  const { limits, errors: limitErrors } = resolveMatrixLimits(input.limits);
  errors.push(...limitErrors);

  if (!Number.isFinite(input.now)) {
    errors.push("now: muss eine endliche Zahl (Unix-Epoch ms) sein");
  }

  const config = input.config ?? DEFAULT_SCREENING_PRIORITY_CONFIG;
  // Config-Vorabprüfung mit gültigen Probe-Metriken: übrig bleiben genau die
  // Config-Fehler (fail-closed, bevor eine einzige Zelle gebaut wird).
  const probe = scoreCandidate(
    {
      templateId: "ema-adx-trend",
      templateVersion: 1,
      strategyClass: "trend",
      instrumentId: "PAPER:PROBE",
      venue: "PAPER",
      timeframe: "1h",
      dataQuality: 0.5,
      liquidity: 0.5,
      freshness: 0.5,
      strategyFit: 0.5,
      volatilityOpportunity: 0.5,
      correlationPenalty: null,
      priority: null,
      status: "DISCOVERED",
      reasons: [],
    },
    config,
  );
  if (!probe.ok) errors.push(...probe.errors);

  const instruments = input.instruments;
  const templates = input.templates;
  if (!Array.isArray(instruments)) errors.push("instruments: Array erforderlich");
  if (!Array.isArray(templates)) errors.push("templates: Array erforderlich");

  const scan = input.scan ?? null;
  if (input.scan !== undefined && input.scan !== null) {
    if (!(input.scan.byId instanceof Map) || !Array.isArray(input.scan.rejections)) {
      errors.push("scan: ScanResult mit byId (Map) und rejections (Array) erforderlich");
    }
  }

  if (errors.length > 0) return fail(errors);

  // ── Phase 2: Nicht-leer, Karten, Duplikate, Allowlists ──────────────────
  if (instruments.length === 0) errors.push("instruments: keine Instrumente übergeben");
  if (templates.length === 0) errors.push("templates: keine Templates übergeben");
  if (instruments.length > limits.maxInstruments) {
    errors.push(`zu viele Instrumente: ${instruments.length} > ${limits.maxInstruments}`);
  }
  if (templates.length > limits.maxTemplates) {
    errors.push(`zu viele Templates: ${templates.length} > ${limits.maxTemplates}`);
  }

  const seenInstruments = new Set<string>();
  for (const instrument of instruments) {
    const id = instrument?.id;
    if (typeof id !== "string" || id.length === 0) {
      errors.push("Instrument ohne ID");
      continue;
    }
    if (seenInstruments.has(id)) {
      errors.push(`doppelte Instrument-ID „${id}“`);
      continue;
    }
    seenInstruments.add(id);
    if (!(BROKER_VENUE_IDS as readonly string[]).includes(instrument.venue)) {
      errors.push(
        `Instrument „${id}“: Venue „${String(instrument.venue)}“ ist keine BrokerVenueId`,
      );
    }
  }

  const seenTemplates = new Set<StrategyTemplateId>();
  const prepared: PreparedTemplate[] = [];
  for (const template of templates) {
    const preparedTemplate = prepareTemplate(template, limits, errors);
    if (!preparedTemplate) continue;
    if (seenTemplates.has(preparedTemplate.id)) {
      errors.push(`doppelte Template-ID „${preparedTemplate.id}“`);
      continue;
    }
    seenTemplates.add(preparedTemplate.id);
    prepared.push(preparedTemplate);
  }

  if (errors.length > 0) return fail(errors);

  // ── Phase 3: Kombinatorik gegen den DoS-Guard (vor jedem Datenzugriff) ──
  const prospectiveCells = prepared.reduce(
    (sum, t) => sum + t.timeframes.length * instruments.length,
    0,
  );
  if (prospectiveCells > limits.maxCells) {
    return fail([`matrix too large: ${prospectiveCells} > ${limits.maxCells}`]);
  }
  if (prospectiveCells === 0) return fail(["leere Matrix: 0 Zellen"]);

  // ── Phase 4: Zellen bauen (injizierte Funktionen je Schlüssel 1×) ───────
  const qualityCache = new Map<string, QualitySample>();
  const liquidityCache = new Map<string, LiquiditySample>();
  const freshnessCache = new Map<string, number | null>();
  const correlationCache = new Map<string, number | null>();
  const volatilityCache = new Map<string, number | null>();
  const strategyFitCache = new Map<string, number>();
  const scanReasonCache = new Map<string, string | null>();

  const rejectionById = new Map<string, FilterRejection>();
  if (scan) {
    for (const rejection of scan.rejections) {
      // Bei (theoretisch) mehrfachen Ablehnungen gewinnt die erste —
      // deterministisch in der Reihenfolge des Scanner-Ergebnisses.
      if (!rejectionById.has(rejection.instrumentId)) {
        rejectionById.set(rejection.instrumentId, rejection);
      }
    }
  }

  /** Scan-Gate je Instrument: kein Grund, „nicht ausgewertet“ oder Ablehnung. */
  const scanBlockReason = (instrument: MarketInstrument): string | null => {
    if (!scan) return null;
    const cached = scanReasonCache.get(instrument.id);
    if (cached !== undefined) return cached;
    let reason: string | null;
    if (!scan.byId.has(instrument.id)) {
      reason = "scan: nicht im Scan-Ergebnis";
    } else {
      const rejection = rejectionById.get(instrument.id);
      reason = rejection ? `scan ${rejection.ruleId}: ${rejection.message}` : null;
    }
    scanReasonCache.set(instrument.id, reason);
    return reason;
  };

  const cells: StrategyMarketCandidate[] = [];

  for (const { id: templateId, template, timeframes } of prepared) {
    for (const instrument of instruments) {
      // ── Instrument-Ebene: einmal je Instrument aufrufen ──
      const instrKey = instrument.id;
      let liquidity = liquidityCache.get(instrKey);
      if (liquidity === undefined) {
        liquidity = input.liquidity(instrument) ?? {
          score: null,
          spreadPct: null,
          bookDepthUsd: null,
        };
        liquidityCache.set(instrKey, liquidity);
      }

      let correlation = correlationCache.get(instrKey);
      if (correlation === undefined) {
        correlation = asMetric(input.correlation(instrument));
        correlationCache.set(instrKey, correlation);
      }

      let strategyFit = strategyFitCache.get(instrKey);
      if (strategyFit === undefined) {
        const ctx = input.crossSectional?.(instrument.id) ?? null;
        const valid =
          ctx !== null &&
          Number.isFinite(ctx.percentile) &&
          ctx.percentile > 0 &&
          ctx.percentile <= 1 &&
          Number.isFinite(ctx.composite) &&
          Number.isInteger(ctx.rank) &&
          ctx.rank >= 1 &&
          Number.isFinite(ctx.asOf) &&
          // PIT: ein Snapshot aus der Zukunft darf nie in eine Entscheidung
          // fließen — fehlend/ungültig/futur ⇒ Neutralwert 0.5, nie 0.
          ctx.asOf <= input.now;
        strategyFit = valid ? ctx.percentile : CROSS_SECTIONAL_MOMENTUM_NEUTRAL;
        strategyFitCache.set(instrKey, strategyFit);
      }

      const scanReason = scanBlockReason(instrument);

      for (const tf of timeframes) {
        const pairKey = `${instrKey} ${tf}`;
        let quality = qualityCache.get(pairKey);
        if (quality === undefined) {
          quality = input.dataQuality(instrument, tf) ?? {
            score: null,
            candles: Number.NaN,
          };
          qualityCache.set(pairKey, quality);
        }
        let freshness = freshnessCache.get(pairKey);
        if (freshness === undefined) {
          freshness = asMetric(input.freshness(instrument, tf));
          freshnessCache.set(pairKey, freshness);
        }
        let volatilityOpportunity = volatilityCache.get(pairKey);
        if (volatilityOpportunity === undefined) {
          volatilityOpportunity = asMetric(input.volatilityOpportunity(instrument, tf));
          volatilityCache.set(pairKey, volatilityOpportunity);
        }

        // ── Zeitzustand: warmup-Gate (Blocken statt Überspringen) ──
        const required = requiredWarmupCandles(tf);
        const available = quality.candles;
        const warmupOk = Number.isFinite(available) && available >= required;

        // ── Priorität (05-01) ──
        const metrics = {
          templateId,
          templateVersion: template.version,
          strategyClass: template.class,
          instrumentId: instrument.id,
          venue: instrument.venue as BrokerVenueId,
          timeframe: tf,
          dataQuality: asMetric(quality.score),
          liquidity: asMetric(liquidity.score),
          freshness,
          strategyFit,
          volatilityOpportunity,
          correlationPenalty: correlation,
        } as const;
        const scored = scoreCandidate(
          { ...metrics, priority: null, status: "DISCOVERED", reasons: [] },
          config,
        );

        // Reihenfolge der Gründe: Scan-Gate → warmup-Gate → Score-Begründung.
        const gateReasons: string[] = [];
        if (scanReason) gateReasons.push(scanReason);
        if (!warmupOk) gateReasons.push(`warmup: ${String(available)} < ${required}`);
        const scoreReasons = scored.ok ? [] : [`priority: ${scored.errors.join("; ")}`];
        const reasons = [...gateReasons, ...scoreReasons];

        const candidate: StrategyMarketCandidate = {
          ...metrics,
          priority: scored.ok ? scored.priority : null,
          status: "DISCOVERED",
          reasons,
        };

        // ── Status (05-01): Frühklassifikation, Gates haben Vorrang ──
        const classified = classifyCandidate(candidate, config);
        let status = classified.status;
        let finalReasons = classified.reasons;
        if (classified.status !== "BLOCKED" && gateReasons.length > 0) {
          // Scan-/warmup-Gate erzwingt BLOCKED; die DISCOVERED-Notiz der
          // Frühklassifikation ist dann kein Blockgrund und entfällt (die
          // Gate-Gründe stehen bereits in `reasons`).
          status = "BLOCKED";
          finalReasons = reasons;
        }

        cells.push({ ...candidate, status, reasons: finalReasons });
      }
    }
  }

  // ── Phase 5: stabile Sortierung + Stats ─────────────────────────────────
  cells.sort(compareCells);

  const instrumentIds = new Set<string>();
  const templateIds = new Set<StrategyTemplateId>();
  const timeframeSet = new Set<SupportedTimeframe>();
  const blockedByReason = new Map<string, number>();
  for (const cell of cells) {
    instrumentIds.add(cell.instrumentId);
    templateIds.add(cell.templateId);
    timeframeSet.add(cell.timeframe);
    if (cell.status === "BLOCKED") {
      for (const reason of cell.reasons) {
        blockedByReason.set(reason, (blockedByReason.get(reason) ?? 0) + 1);
      }
    }
  }

  return {
    ok: true,
    cells,
    stats: {
      instruments: instrumentIds.size,
      templates: templateIds.size,
      timeframes: timeframeSet.size,
      cells: cells.length,
      blockedByReason: Object.fromEntries(blockedByReason),
    },
    errors: [],
  };
}
