/**
 * STX-06-01 — Deterministischer Annahmen-Audit (Phase 6, Finding STX-17).
 *
 * ── Was dieses Modul entscheidet ────────────────────────────────────────────
 * Jede Strategie behauptet **durch ihre Existenz**, dass bestimmte Annahmen
 * gelten (`StrategyTemplate.assumptions`, STX-03-01). Dieses Modul prüft, ob
 * diese Annahmen im **konkreten Lauf belegt** sind — nicht, ob sie sinnvoll
 * sind (das entscheidet ein Mensch), und nicht, ob die Strategie Geld verdient
 * (das messen 06-02/06-03). Die Frage ist eng: *Hält der Backtest die
 * Bedingungen ein, unter denen die Strategie überhaupt eine Aussage ist?*
 *
 * Der Audit läuft deshalb **vor** jeder Metrik-Auswertung. Ein Lauf mit
 * `feeModel = {0, 0}` hat keinen informativen Sharpe — die Zahl ist dann nicht
 * klein, sie ist bedeutungslos. `assumptionGate()` ist die ausdrückliche Naht
 * dafür: 06-02/06-04 dürfen Metriken nur auswerten, wenn das Gate `allow`
 * liefert.
 *
 * ── Reine Funktion, injizierte Fakten ───────────────────────────────────────
 * Keine IO, keine Uhr, keine DB, kein Zufall: `auditAssumptions()` liest
 * ausschließlich die injizierten `*Facts`-Objekte. Dieselbe Eingabe liefert
 * byte-identisch dieselbe Ausgabe — damit ist der Audit selbst hashbar und in
 * einem Report (06-04) reproduzierbar. Wer den Audit füttert, ist verantwortlich
 * für die Herkunft der Fakten (`MultiAssetBacktestResult`, `FreezeArtifact`,
 * `BacktestEngineConfig`, `RuleSnapshot`-Reihen); dieses Modul erfindet keinen
 * einzigen Wert. **Fehlende Fakten sind `UNKNOWN`, nie `HOLDS`.**
 *
 * ── `UNKNOWN` ist ein Ergebnis, kein Fehler ─────────────────────────────────
 * Ein nicht prüfbarer Lauf ist **kein Beweis gegen die Strategie**. Deshalb
 * liefert `TRADES_SUFFICIENT` unter {@link MC_MIN_SAMPLE_TRADES} `UNKNOWN` und
 * nicht `VIOLATED`: 7 Trades widerlegen keine Marktthese, sie tragen nur keine
 * Aussage. Dieselbe Logik gilt für jeden fehlenden Fakt. `UNKNOWN` senkt den
 * Gesamtstatus auf `INCONCLUSIVE` — niemals auf `FAIL`.
 *
 * ── Die `critical`-Regel (Auftrag Punkt 4) ──────────────────────────────────
 * Jede Template-Annahme mit `critical: true`, deren zugehörige Prüfung
 * `VIOLATED` **oder** `UNKNOWN` ist, macht das Gesamtergebnis zu
 * `INCONCLUSIVE` — ausdrücklich nicht zu `FAIL`. Der Grund steht im Prompt:
 * Ohne ihre tragende Annahme ist das Ergebnis wertlos, aber wertlos ist nicht
 * dasselbe wie widerlegt. `FAIL` bleibt dem Fall vorbehalten, in dem der Lauf
 * eine nicht-kritische Annahme **nachweislich** bricht und sonst prüfbar ist.
 *
 * Zuordnung Prüfung → Template-Annahme: {@link ASSUMPTION_CHECK_CATEGORIES}
 * mappt jede Prüfung auf die Annahme-**Kategorien**, zu denen sie etwas
 * aussagen kann. Die Richtung ist dabei bewusst asymmetrisch:
 *   - `VIOLATED`/`UNKNOWN` **widersprechen** einer kritischen Annahme der
 *     gemappten Kategorie (belastbar: `makerFee = 0` widerlegt jede kritische
 *     COST-Annahme).
 *   - `HOLDS` **beweist umgekehrt keine** Template-Annahme. „`WARMUP_MET`
 *     hält" heißt: die Kerzenzahl reicht. Es heißt nicht: „`bbw-kalibrierung`
 *     ist belegt". Kritische Annahmen, zu deren Kategorie **keine** Prüfung
 *     etwas sagt (heute: `REGIME`), stehen deshalb in `uncoveredCritical` —
 *     als Fakt, ohne den Status zu ändern. Ihre Auswertung gehört 06-04
 *     (Regime-Seite: `evaluateRegimeOos`, ADR-009), nicht diesem Modul.
 *
 * ── Gelesene Konstanten, keine zweiten Wahrheiten ───────────────────────────
 * | Wert | Quelle |
 * |---|---|
 * | Mindeststichprobe (30 Trades) | `MC_MIN_SAMPLE_TRADES` (`src/backtest/montecarlo.ts`) |
 * | Trade-/Equity-Deckel (200/120) | `RULE_BACKTEST_TRADE_CAP`/`RULE_BACKTEST_EQUITY_CAP` (`src/lib/ruleBacktest.ts`) |
 * | Timeframe-Dauern | `SUPPORTED_TIMEFRAME_MS` (`src/lib/marketdata/timeframes.ts`) |
 * | Feld-Semantik `changePct24h` | `RULE_FIELD_LABELS` (`src/lib/ruleFieldCatalog.ts`) |
 * | Kategorien der Annahmen | `StrategyAssumption["category"]` (`src/strategies/types.ts`) |
 *
 * Beide Konstanten-Module sind importzeitfrei von IO (verifiziert: der Import
 * läuft ohne `DATABASE_URL`); sie werden **gelesen**, nicht kopiert — eine
 * zweite Zahl an dieser Stelle wäre genau der Drift, den der Katalog
 * (STX-03-02) und `tests/adrVocabulary.test.ts` verhindern sollen.
 *
 * ── Die elf Prüfungen ───────────────────────────────────────────────────────
 * Die ersten zehn sind die Pflichtprüfungen des Prompts, in dessen Reihenfolge;
 * `FILLS_MODELLED` kommt als elfte hinzu, weil die §3.4-Checkliste des
 * Ausbaudokuments „instant fills" nennt und `executionModel` der einzige Ort
 * ist, an dem das Repo diese Annahme beweisen kann (`legacy` = Fill am
 * Kerzenschluss ohne Latenz/Queue, `paper` = FillSimulator mit Spread,
 * Partial Fills und Funding, `event_replay` = Latenz + Depth-Impact +
 * Order-TTL + punktgenaue Funding-Ereignisse). Ohne sie bliebe die Kategorie
 * `EXECUTION` — bei vier der sechs Templates **kritisch** — ungeprüft.
 *
 * Bewusst **nicht** geprüft (und deshalb auch nicht behauptet): Funding
 * (`replayFunding.ts`) und Survivorship/Universe-Mitgliedschaft. Beide
 * bräuchten Instrument-Fakten (Perpetual ja/nein, Point-in-Time-Universum),
 * die `AuditInput` nicht trägt; eine Zahl aus dem Nichts wäre hier schlimmer
 * als ein `UNKNOWN`. Beides ist Aufgabe von 06-04, wenn die Fakten liegen.
 *
 * ── Gesperrt (Prompt) ───────────────────────────────────────────────────────
 * Keine Änderung an `montecarlo.ts`, `walkforward.ts`, `marketRegime.ts`
 * (alle drei werden höchstens gelesen), keine LLM-Auswertung (06-05), keine
 * Metrik-Auswertung (06-02/06-03) und **keine Erzeugung** von Annahmen: Dieses
 * Modul prüft ausschließlich die deklarierten.
 */

import { MC_MIN_SAMPLE_TRADES } from "@/backtest/montecarlo";
import type { BacktestExecutionModel, SlippageModel } from "@/backtest/types";
import {
  RULE_BACKTEST_EQUITY_CAP,
  RULE_BACKTEST_TRADE_CAP,
} from "@/lib/ruleBacktest";
import { RULE_FIELD_LABELS } from "@/lib/ruleFieldCatalog";
import { SUPPORTED_TIMEFRAME_MS } from "@/lib/marketdata/timeframes";
import type { SupportedTimeframe } from "@/lib/marketdata/historicalStore";
import type { RuleField, RuleSpec } from "@/lib/ruleEngine";

import type { StrategyAssumption, StrategyTemplate } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Vokabular
// ─────────────────────────────────────────────────────────────────────────────

/** Versionierung der Prüflogik (Teil eines späteren Report-Hashs, 06-04). */
export const ASSUMPTION_AUDIT_VERSION = "asm1" as const;

/** Ergebnis einer Einzelprüfung. `UNKNOWN` = im Lauf nicht belegbar. */
export type AssumptionCheckStatus = "HOLDS" | "VIOLATED" | "UNKNOWN";

/**
 * Gewicht einer Prüfung. `BLOCKING`-Verletzungen können den Gesamtstatus auf
 * `FAIL` ziehen; `WARNING`-Verletzungen werden berichtet, entscheiden aber
 * nicht über `PASS`/`FAIL` (wohl aber über die `critical`-Regel — dort zählt
 * der Status, nicht die Schwere).
 */
export type AssumptionSeverity = "BLOCKING" | "WARNING";

/**
 * Gesamtergebnis des Audits.
 *
 * | Wert | Bedeutung |
 * |---|---|
 * | `PASS` | Alle Prüfungen `HOLDS` — der Lauf darf metrisch ausgewertet werden. |
 * | `FAIL` | Eine `BLOCKING`-Prüfung ist verletzt, ohne dass eine kritische Template-Annahme betroffen ist: Der Lauf ist nachweislich kaputt. |
 * | `INCONCLUSIVE` | Eine kritische Annahme ist verletzt **oder** nicht prüfbar (oder eine Prüfung blieb `UNKNOWN`): Der Lauf trägt keine Aussage — weder dafür noch dagegen. |
 */
export type AssumptionVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

/** Kategorien aus dem Template-Vertrag (STX-03-01) — kein eigenes Vokabular. */
export type AssumptionCategory = StrategyAssumption["category"];

/**
 * Stabile IDs der Prüfungen. Die ersten zehn sind die Pflichtprüfungen des
 * Prompts STX-06-01 in dessen Reihenfolge, `FILLS_MODELLED` ist die
 * begründete Ergänzung (Modul-Header).
 *
 * Schreibweise: Der Prompt nennt `CAPS_RESpected` — offenkundig ein
 * Tippfehler für `CAPS_RESPECTED`; die ID folgt dem Vokabular-Stil der
 * übrigen neun (SCREAMING_SNAKE) und ist hiermit festgelegt.
 */
export const ASSUMPTION_CHECK_IDS = [
  "FEE_NONZERO",
  "SLIPPAGE_NONZERO",
  "SPREAD_MEASURED",
  "DEPTH_SUFFICIENT",
  "WARMUP_MET",
  "TRADES_SUFFICIENT",
  "CAPS_RESPECTED",
  "LEAKAGE_PROTECTED",
  "INTRADAY_ONLY",
  "CHANGE_PCT_SEMANTICS",
  "FILLS_MODELLED",
] as const;

export type AssumptionCheckId = (typeof ASSUMPTION_CHECK_IDS)[number];

/**
 * Annahme-Kategorien, zu denen eine Prüfung etwas aussagen kann.
 *
 * Nur in **eine** Richtung belastbar (siehe Modul-Header): Eine verletzte
 * oder nicht prüfbare Prüfung widerspricht einer kritischen Annahme der
 * gemappten Kategorien; eine gehaltene Prüfung beweist keine Annahme.
 */
export const ASSUMPTION_CHECK_CATEGORIES: Readonly<
  Record<AssumptionCheckId, readonly AssumptionCategory[]>
> = {
  FEE_NONZERO: ["COST"],
  SLIPPAGE_NONZERO: ["COST"],
  SPREAD_MEASURED: ["COST", "LIQUIDITY"],
  DEPTH_SUFFICIENT: ["LIQUIDITY"],
  WARMUP_MET: ["DATA"],
  TRADES_SUFFICIENT: ["MARKET"],
  CAPS_RESPECTED: ["DATA"],
  LEAKAGE_PROTECTED: ["DATA"],
  INTRADAY_ONLY: ["DATA"],
  CHANGE_PCT_SEMANTICS: ["DATA"],
  FILLS_MODELLED: ["EXECUTION"],
} as const;

/**
 * Regelschwere je Prüfung. `INTRADAY_ONLY` ist die einzige Ausnahme: Auf
 * `1h` stuft die Prüfung auf `WARNING` ab, weil `VWAP_PCT_RELIABLE_TIMEFRAMES`
 * (STX-03-07) `1h` zur konservativen Intraday-Menge zählt, der UTC-Tagesanker
 * dort aber erst ab der zweiten Kerze des Tages trägt (STX-01). Ab `2h`
 * bleibt es `BLOCKING`.
 */
export const ASSUMPTION_CHECK_SEVERITY: Readonly<
  Record<AssumptionCheckId, AssumptionSeverity>
> = {
  FEE_NONZERO: "BLOCKING",
  SLIPPAGE_NONZERO: "BLOCKING",
  SPREAD_MEASURED: "BLOCKING",
  // Tiefe bestimmt die **tragbare Positionsgröße**, nicht den Preis pro Trade;
  // ein zu dünnes Buch ist ein Kapazitätsbefund, kein Kostenfehler.
  DEPTH_SUFFICIENT: "WARNING",
  WARMUP_MET: "BLOCKING",
  TRADES_SUFFICIENT: "BLOCKING",
  CAPS_RESPECTED: "BLOCKING",
  LEAKAGE_PROTECTED: "BLOCKING",
  INTRADAY_ONLY: "BLOCKING",
  // STX-14 ist eine Semantik-Falle, kein Messfehler: Das Feld ist korrekt
  // berechnet, nur sein Name verspricht etwas anderes.
  CHANGE_PCT_SEMANTICS: "WARNING",
  // `legacy` ist der eingefrorene, dokumentierte Default-Pfad der gesamten
  // Bestandskörperschaft — ein Modellierungsgap, kein Datenfehler.
  FILLS_MODELLED: "WARNING",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Schwellen
// ─────────────────────────────────────────────────────────────────────────────

/** Konfigurierbare Grenzen des Audits (das „X %" des Prompts). */
export interface AssumptionThresholds {
  /**
   * Anteil der Snapshots ohne `spreadPct` in Prozent, ab dem der Spread als
   * **nicht gemessen** gilt (`>=`, nicht `>`).
   */
  maxMissingSpreadPct: number;
  /** Dasselbe für `bookDepthUsd`. */
  maxMissingBookDepthPct: number;
  /**
   * Minimales Verhältnis von Orderbuch-Tiefe zu Positionsnotional. `1` heißt:
   * Die abriegelnde Buchseite muss die Position einmal tragen.
   */
  minDepthToNotionalRatio: number;
}

export const DEFAULT_ASSUMPTION_THRESHOLDS: Readonly<AssumptionThresholds> = {
  maxMissingSpreadPct: 20,
  maxMissingBookDepthPct: 20,
  minDepthToNotionalRatio: 1,
};

/** Harte Grenzen der Schwellen — außerhalb wird geworfen, nicht geklemmt. */
export const ASSUMPTION_THRESHOLD_BOUNDS = {
  missingPct: [0, 100] as const,
  depthRatio: [0, 1_000] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Injizierte Fakten
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Orderbuch-Fakten **eines** Snapshots (`RuleSnapshot.spreadPct` /
 * `.bookDepthUsd`). Bewusst nur die beiden geprüften Größen: Der Audit braucht
 * keine Kerzen und keine Indikatoren, also bekommt er keine.
 */
export interface SnapshotFacts {
  /** Relativer Spread in Prozent; `null` = kein Orderbuch gemessen. */
  spreadPct: number | null;
  /** Abriegelnde Buchtiefe in Quote-Währung; `null` = keine belastbare Tiefe. */
  bookDepthUsd: number | null;
}

/**
 * Kerzen-/Snapshot-Fakten des Laufs. `null` heißt überall „nicht gemessen" —
 * niemals `0`.
 */
export interface CandleFacts {
  /** Anzahl der im Lauf ausgewerteten Kerzen; `null` = nicht erhoben. */
  bars: number | null;
  /**
   * Warmup-Bedarf in Kerzen. Der Aufrufer berechnet ihn aus der einzigen
   * Quelle (`requiredWarmupCandles(scannerConfig)`, `src/scanner/warmup.ts`)
   * bzw. aus `BacktestEngineConfig.warmupBars`. Fehlt er, ist `WARMUP_MET`
   * `UNKNOWN` — dieses Modul leitet keinen Bedarf aus dem Timeframe ab.
   */
  requiredWarmupCandles?: number | null;
  /**
   * Snapshot-Reihe des Laufs. `undefined`/`null` = keine Snapshot-Fakten
   * injiziert (`UNKNOWN`); ein **leeres** Array = der Lauf trug keine einzige
   * Orderbuch-Beobachtung (`VIOLATED`, denn dann wurde nichts gemessen).
   */
  snapshots?: readonly SnapshotFacts[] | null;
}

/** Ergebnis-Fakten eines Backtest-/Walk-Forward-Laufs. */
export interface BacktestRunFacts {
  /** Abgeschlossene Trades; `null` = nicht gemessen. */
  trades: number | null;
  /** Punkte der Equity-Kurve; `null` = nicht gemessen. */
  equityPoints: number | null;
  /** Gezahlte Gebühren in Kontowährung; `null` = nicht gemessen. */
  feesPaid?: number | null;
  /** Gezahlte Slippage in Kontowährung; `null` = nicht gemessen. */
  slippagePaid?: number | null;
  /** Kumuliertes Funding in Kontowährung; `null` = nicht gemessen/kein Perp. */
  fundingPaid?: number | null;
  /** `true`, wenn der Lauf Out-of-Sample-Fenster ausgewertet hat. */
  outOfSample: boolean;
  /** Anzahl der Walk-Forward-Fenster; `0`/`null` = kein Walk-Forward. */
  walkForwardWindows?: number | null;
  /**
   * Embargo zwischen In- und Out-of-Sample in Millisekunden
   * (`FreezeArtifact.cutoffs.embargoMs`). `null`/fehlend = nicht gesetzt —
   * das Freeze-Artefakt lässt den Schlüssel weg, wenn er falsy ist, „nicht
   * gesetzt" und „0" sind dort also nicht unterscheidbar (fail-closed).
   */
  embargoMs?: number | null;
  /** Purge vor dem Cutoff in Millisekunden (`cutoffs.purgeMs`). */
  purgeMs?: number | null;
}

/** Konfigurations-Fakten des Laufs (`BacktestEngineConfig`-Ausschnitt). */
export interface RunConfigFacts {
  /** Ausführungspfad der Engine (`legacy` | `paper` | `event_replay`). */
  executionModel?: BacktestExecutionModel | null;
  /**
   * Takt der **Kerzenreihe** des Laufs. Fehlt er, weicht der Audit auf
   * `version.window.timeframe` aus; weichen beide voneinander ab, nennt die
   * Evidenz beide — maßgeblich ist der Kerzentakt, denn daraus wird
   * `vwapPct` berechnet.
   */
  timeframe?: SupportedTimeframe | null;
  /** Slippage-Modell; `null`/fehlend = nicht angegeben (`UNKNOWN`). */
  slippageModel?: SlippageModel | null;
  /** Fester Slippage in Basispunkten (Modell `fixed`). */
  fixedSlippageBps?: number | null;
  /** Multiplikator auf den relativen Spread (Modell `spread_relative`). */
  spreadSlippageFactor?: number | null;
  /** Gebührenmodell in Dezimalform; `null`/fehlend = nicht angegeben. */
  feeModel?: { makerFee: number; takerFee: number } | null;
  /** Startkapital in Kontowährung — Basis der Positionsgrößen-Prüfung. */
  initialCapital?: number | null;
  /** Override der Schwellen; fehlende Keys bleiben auf Default. */
  thresholds?: Partial<AssumptionThresholds> | null;
}

/** Vollständige Eingabe des Audits. */
export interface AuditInput {
  /** Das geprüfte Template (Quelle von `assumptions` und `requiredFields`). */
  template: StrategyTemplate;
  /** Die **sanierte** Regel des Laufs (`sanitizeRuleSpec()`-Ausgabe, 03-09). */
  version: RuleSpec;
  /** Ergebnis-Fakten des Laufs. */
  run: BacktestRunFacts;
  /** Kerzen-/Snapshot-Fakten; fehlen sie, bleiben die Datenprüfungen `UNKNOWN`. */
  candles?: CandleFacts | null;
  /** Konfigurations-Fakten des Laufs. */
  config: RunConfigFacts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ergebnis
// ─────────────────────────────────────────────────────────────────────────────

/** Eine geprüfte Annahme. */
export interface AssumptionCheck {
  /** Stabile Prüf-ID aus {@link ASSUMPTION_CHECK_IDS}. */
  assumptionId: AssumptionCheckId;
  status: AssumptionCheckStatus;
  /**
   * Klartext **mit Zahl** — immer. Kein „vielleicht", kein „könnte": Jede
   * Evidenz nennt die gemessenen Werte und die Grenze, an der entschieden
   * wurde (`tests/strategyValidation.assumptions.test.ts` erzwingt das).
   */
  evidence: string;
  severity: AssumptionSeverity;
  /**
   * IDs der Template-Annahmen, denen diese Prüfung zugeordnet ist
   * (Kategorie-Mapping {@link ASSUMPTION_CHECK_CATEGORIES}). Leer, wenn das
   * Template in diesen Kategorien nichts deklariert.
   */
  templateAssumptions: readonly string[];
}

/** Ergebnis des Audits. */
export interface AssumptionAudit {
  /** Alle Prüfungen in fester Reihenfolge ({@link ASSUMPTION_CHECK_IDS}). */
  checks: readonly AssumptionCheck[];
  /** `status === "VIOLATED"`. */
  violated: readonly AssumptionCheck[];
  /** `status === "UNKNOWN"` — nicht prüfbar, kein Gegenbeweis. */
  unknown: readonly AssumptionCheck[];
  /** Gesamtergebnis nach der `critical`-Regel (Auftrag Punkt 4). */
  verdict: AssumptionVerdict;
  /** Prüfungen mit `severity === "BLOCKING"` und `status !== "HOLDS"`. */
  blocking: readonly AssumptionCheck[];
  /**
   * IDs der **kritischen** Template-Annahmen, die durch eine `VIOLATED`- oder
   * `UNKNOWN`-Prüfung betroffen sind — die Begründung für `INCONCLUSIVE`.
   */
  criticalFindings: readonly string[];
  /**
   * IDs der kritischen Template-Annahmen, zu deren Kategorie **keine** Prüfung
   * etwas aussagt (heute: `REGIME`). Ändert den Status nicht — der Audit
   * behauptet nur, was er misst.
   */
  uncoveredCritical: readonly string[];
  /** Ein Satz Klartext mit den Zählungen (für Log/Report). */
  summary: string;
  /** Prüflogik-Version ({@link ASSUMPTION_AUDIT_VERSION}). */
  auditVersion: typeof ASSUMPTION_AUDIT_VERSION;
}

/** Gate für die nachgelagerte Metrik-Auswertung (06-02/06-04). */
export interface AssumptionGate {
  allow: boolean;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kleine, deterministische Helfer
// ─────────────────────────────────────────────────────────────────────────────

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Zahl ohne Ballast: `2` statt `2.00`, `33.3` statt `33.333333`. */
function fmt(value: number, digits = 2): string {
  return Number(value.toFixed(digits)).toString();
}

/** Prozentanteil (0…100) mit einer Nachkommastelle. */
function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return (part / total) * 100;
}

/** Deutsche Prozentangabe für die Evidenz. */
function pctText(part: number, total: number): string {
  return `${fmt(pct(part, total), 1)} %`;
}

function resolveThresholds(
  override: Partial<AssumptionThresholds> | null | undefined,
): AssumptionThresholds {
  const merged: AssumptionThresholds = {
    ...DEFAULT_ASSUMPTION_THRESHOLDS,
    ...(override ?? {}),
  };
  const [minPct, maxPct] = ASSUMPTION_THRESHOLD_BOUNDS.missingPct;
  for (const key of ["maxMissingSpreadPct", "maxMissingBookDepthPct"] as const) {
    const value = merged[key];
    if (!isFiniteNumber(value) || value < minPct || value > maxPct) {
      throw new Error(
        `auditAssumptions: Schwelle „${key}" muss eine Zahl in [${minPct}, ${maxPct}] sein ` +
          `(ist ${String(value)}).`,
      );
    }
  }
  const [minRatio, maxRatio] = ASSUMPTION_THRESHOLD_BOUNDS.depthRatio;
  const ratio = merged.minDepthToNotionalRatio;
  if (!isFiniteNumber(ratio) || ratio < minRatio || ratio > maxRatio) {
    throw new Error(
      `auditAssumptions: Schwelle „minDepthToNotionalRatio" muss eine Zahl in [${minRatio}, ${maxRatio}] sein ` +
        `(ist ${String(ratio)}).`,
    );
  }
  return merged;
}

/** Felder, die die **Regel** tatsächlich abfragt (`compileRuleSpec`-äquivalent). */
function ruleFieldsOf(spec: RuleSpec): RuleField[] {
  const items = Array.isArray(spec?.condition?.conditions) ? spec.condition.conditions : [];
  const fields = items
    .map((item) => item?.field)
    .filter((field): field is RuleField => typeof field === "string" && field.length > 0);
  return [...new Set(fields)];
}

/**
 * Anteil der Snapshots, deren `bookDepthUsd` die geforderte Tiefe verfehlt.
 * `null` zählt dabei **nicht** als zu dünn — fehlende Tiefe ist der eigene
 * Befund (`maxMissingBookDepthPct`), nicht derselbe noch einmal.
 */
function thinDepthShare(
  snapshots: readonly SnapshotFacts[],
  minDepth: number,
): { thin: number; measured: number } {
  let thin = 0;
  let measured = 0;
  for (const snap of snapshots) {
    const depth = snap?.bookDepthUsd;
    if (!isFiniteNumber(depth)) continue;
    measured += 1;
    if (depth < minDepth) thin += 1;
  }
  return { thin, measured };
}

// ─────────────────────────────────────────────────────────────────────────────
// Kontext der Prüffunktionen
// ─────────────────────────────────────────────────────────────────────────────

interface AuditContext {
  template: StrategyTemplate;
  version: RuleSpec;
  run: BacktestRunFacts;
  candles: CandleFacts | null;
  config: RunConfigFacts;
  thresholds: AssumptionThresholds;
  /** `template.requiredFields` (deklarierter Bedarf des Artefakts). */
  templateFields: readonly RuleField[];
  /** Felder der kompilierten Regel (tatsächlich ausgewertet). */
  ruleFields: readonly RuleField[];
  /** Kritische Template-Annahmen je Kategorie. */
  criticalByCategory: ReadonlyMap<AssumptionCategory, readonly string[]>;
}

type CheckDraft = {
  status: AssumptionCheckStatus;
  evidence: string;
  severity?: AssumptionSeverity;
};

/** Kosten-Evidenz aus den gemessenen Laufwerten (nur Zusatzinformation). */
function measuredCostText(run: BacktestRunFacts): string {
  const fees = isFiniteNumber(run.feesPaid) ? `${fmt(run.feesPaid)} USD Gebühren` : "keine Gebührensumme";
  const slip = isFiniteNumber(run.slippagePaid)
    ? `${fmt(run.slippagePaid)} USD Slippage`
    : "keine Slippage-Summe";
  return `gemessen ${fees}, ${slip}`;
}

// ── 1) FEE_NONZERO ──────────────────────────────────────────────────────────
function checkFee(ctx: AuditContext): CheckDraft {
  const fee = ctx.config.feeModel;
  const maker = fee?.makerFee;
  const taker = fee?.takerFee;
  const readable = [maker, taker].filter(isFiniteNumber).length;
  if (!fee || readable < 2) {
    return {
      status: "UNKNOWN",
      evidence:
        `Gebührenmodell unvollständig: ${readable} von 2 Werten lesbar ` +
        `(makerFee = ${String(maker ?? "fehlt")}, takerFee = ${String(taker ?? "fehlt")}).`,
    };
  }
  // `<= 0` statt `=== 0` (Prompt): Eine negative Gebühr ist in diesem Repo
  // nicht messbar — ein Rebate wäre erfunden. Fail-closed.
  if ((maker as number) <= 0 && (taker as number) <= 0) {
    return {
      status: "VIOLATED",
      evidence:
        `makerFee = ${fmt((maker as number) * 100, 4)} % und takerFee = ${fmt((taker as number) * 100, 4)} % ` +
        `⇒ 0 bp Kosten pro Trade; ${measuredCostText(ctx.run)}.`,
    };
  }
  return {
    status: "HOLDS",
    evidence:
      `makerFee = ${fmt((maker as number) * 100, 4)} %, takerFee = ${fmt((taker as number) * 100, 4)} % ` +
      `(= ${fmt((taker as number) * 10_000, 1)} bp Taker); ${measuredCostText(ctx.run)}.`,
  };
}

// ── 2) SLIPPAGE_NONZERO ─────────────────────────────────────────────────────
function checkSlippage(ctx: AuditContext): CheckDraft {
  const model = ctx.config.slippageModel;
  if (!model) {
    return {
      status: "UNKNOWN",
      evidence:
        `0 Slippage-Modelle angegeben (slippageModel fehlt) — ${measuredCostText(ctx.run)}.`,
    };
  }
  if (model === "none") {
    return {
      status: "VIOLATED",
      evidence: `slippageModel = "none" ⇒ 0 bp Slippage im Lauf; ${measuredCostText(ctx.run)}.`,
    };
  }
  if (model === "fixed") {
    const bps = ctx.config.fixedSlippageBps;
    if (!isFiniteNumber(bps)) {
      return {
        status: "UNKNOWN",
        evidence:
          `slippageModel = "fixed" ohne fixedSlippageBps (0 von 1 Werten lesbar) — ` +
          `Slippage-Höhe nicht belegbar.`,
      };
    }
    if (bps <= 0) {
      return {
        status: "VIOLATED",
        evidence: `slippageModel = "fixed" mit fixedSlippageBps = ${fmt(bps, 2)} ⇒ 0 bp Slippage.`,
      };
    }
    return {
      status: "HOLDS",
      evidence:
        `slippageModel = "fixed" mit ${fmt(bps, 2)} bp (${fmt(bps / 100, 4)} %) pro Fill; ` +
        `${measuredCostText(ctx.run)}.`,
    };
  }
  // "spread_relative"
  const factor = ctx.config.spreadSlippageFactor;
  if (!isFiniteNumber(factor)) {
    return {
      status: "UNKNOWN",
      evidence:
        `slippageModel = "spread_relative" ohne spreadSlippageFactor (0 von 1 Werten lesbar).`,
    };
  }
  if (factor <= 0) {
    return {
      status: "VIOLATED",
      evidence:
        `slippageModel = "spread_relative" mit Faktor ${fmt(factor, 2)} ⇒ 0 bp Slippage ` +
        `(Spread wird nicht belastet).`,
    };
  }
  return {
    status: "HOLDS",
    evidence:
      `slippageModel = "spread_relative" mit Faktor ${fmt(factor, 2)} auf den gemessenen Spread; ` +
      `${measuredCostText(ctx.run)}.`,
  };
}

// ── 3) SPREAD_MEASURED ──────────────────────────────────────────────────────
function checkSpread(ctx: AuditContext): CheckDraft {
  const snapshots = ctx.candles?.snapshots;
  const limit = ctx.thresholds.maxMissingSpreadPct;
  if (!snapshots) {
    return {
      status: "UNKNOWN",
      evidence:
        `0 Snapshot-Fakten injiziert — Spread-Messung nicht prüfbar (Grenze ${fmt(limit, 1)} %).`,
    };
  }
  const total = snapshots.length;
  const missing = snapshots.filter((s) => !isFiniteNumber(s?.spreadPct)).length;
  if (total === 0) {
    return {
      status: "VIOLATED",
      evidence:
        `0 Snapshots im Lauf tragen eine Spread-Messung — der Spread wurde nie gemessen ` +
        `(Grenze ${fmt(limit, 1)} % fehlende Werte).`,
    };
  }
  const measuredValues = snapshots
    .map((s) => s?.spreadPct)
    .filter((v): v is number => isFiniteNumber(v))
    .sort((a, b) => a - b);
  const median =
    measuredValues.length > 0
      ? measuredValues[Math.floor((measuredValues.length - 1) / 2)]
      : null;
  const medianText = median === null ? "kein Median (0 Messwerte)" : `Median ${fmt(median, 4)} %`;
  if (pct(missing, total) >= limit) {
    return {
      status: "VIOLATED",
      evidence:
        `spreadPct fehlt in ${missing} von ${total} Snapshots (${pctText(missing, total)} ≥ Grenze ` +
        `${fmt(limit, 1)} %); ${medianText}.`,
    };
  }
  return {
    status: "HOLDS",
    evidence:
      `spreadPct in ${total - missing} von ${total} Snapshots gemessen ` +
      `(${pctText(missing, total)} fehlen < Grenze ${fmt(limit, 1)} %); ${medianText}.`,
  };
}

// ── 4) DEPTH_SUFFICIENT ─────────────────────────────────────────────────────
function checkDepth(ctx: AuditContext): CheckDraft {
  const snapshots = ctx.candles?.snapshots;
  const limit = ctx.thresholds.maxMissingBookDepthPct;
  const ratio = ctx.thresholds.minDepthToNotionalRatio;
  const capital = ctx.config.initialCapital;
  const maxPositionPct = isFiniteNumber(ctx.version?.action?.maxPositionPct)
    ? ctx.version.action.maxPositionPct
    : null;
  const notional =
    isFiniteNumber(capital) && capital > 0 && maxPositionPct !== null && maxPositionPct > 0
      ? capital * maxPositionPct
      : null;
  const notionalText =
    notional === null
      ? `Positionsnotional nicht ableitbar (initialCapital = ${String(capital ?? "fehlt")}, ` +
        `maxPositionPct = ${String(maxPositionPct ?? "fehlt")})`
      : `Positionsnotional ${fmt(notional)} USD, geforderte Tiefe ${fmt(notional * ratio)} USD`;

  if (!snapshots) {
    return {
      status: "UNKNOWN",
      evidence:
        `0 Snapshot-Fakten injiziert — Buchtiefe nicht prüfbar (Grenze ${fmt(limit, 1)} %); ${notionalText}.`,
    };
  }
  const total = snapshots.length;
  if (total === 0) {
    return {
      status: "VIOLATED",
      evidence:
        `0 Snapshots im Lauf tragen eine Tiefenmessung — die Buchtiefe trägt die Position ` +
        `nicht belegt (Grenze ${fmt(limit, 1)} %); ${notionalText}.`,
    };
  }
  const missing = snapshots.filter((s) => !isFiniteNumber(s?.bookDepthUsd)).length;
  const missingShare = pct(missing, total);
  const { thin, measured } = notional === null ? { thin: 0, measured: 0 } : thinDepthShare(snapshots, notional * ratio);
  const thinShare = measured > 0 ? pct(thin, measured) : 0;
  const detail =
    `bookDepthUsd fehlt in ${missing} von ${total} Snapshots (${fmt(missingShare, 1)} %, Grenze ` +
    `${fmt(limit, 1)} %)` +
    (notional === null
      ? `; ${notionalText}`
      : `; ${thin} von ${measured} gemessenen Tiefen unter ${fmt(notional * ratio)} USD (${fmt(thinShare, 1)} %); ${notionalText}`);

  if (missingShare >= limit || thinShare >= limit) {
    return { status: "VIOLATED", evidence: `${detail}.` };
  }
  return { status: "HOLDS", evidence: `${detail}.` };
}

// ── 5) WARMUP_MET ───────────────────────────────────────────────────────────
function checkWarmup(ctx: AuditContext): CheckDraft {
  const bars = ctx.candles?.bars;
  const required = ctx.candles?.requiredWarmupCandles;
  if (!isFiniteNumber(bars) && !isFiniteNumber(required)) {
    return {
      status: "UNKNOWN",
      evidence: `0 von 2 Werten lesbar: Kerzenzahl und Warmup-Bedarf fehlen.`,
    };
  }
  if (!isFiniteNumber(required)) {
    return {
      status: "UNKNOWN",
      evidence:
        `Warmup-Bedarf fehlt (0 Kerzen gefordert angegeben); gemessen ${fmt(bars as number, 0)} Kerzen — ` +
        `ohne Bedarf keine Aussage (Quelle: requiredWarmupCandles()).`,
    };
  }
  if (!isFiniteNumber(bars)) {
    return {
      status: "UNKNOWN",
      evidence: `Kerzenzahl fehlt (0 Kerzen nachgewiesen) bei Bedarf ${fmt(required, 0)} Kerzen.`,
    };
  }
  if (bars < required) {
    return {
      status: "VIOLATED",
      evidence:
        `${fmt(bars, 0)} Kerzen < Bedarf ${fmt(required, 0)} Kerzen ` +
        `(${fmt(required - bars, 0)} Kerzen fehlen) — Indikatoren laufen im Padding.`,
    };
  }
  return {
    status: "HOLDS",
    evidence:
      `${fmt(bars, 0)} Kerzen ≥ Bedarf ${fmt(required, 0)} Kerzen ` +
      `(Puffer ${fmt(bars - required, 0)} Kerzen).`,
  };
}

// ── 6) TRADES_SUFFICIENT ────────────────────────────────────────────────────
function checkTrades(ctx: AuditContext): CheckDraft {
  const trades = ctx.run.trades;
  if (!isFiniteNumber(trades)) {
    return {
      status: "UNKNOWN",
      evidence: `Trade-Zahl fehlt (0 Trades nachgewiesen) — Minimum ${MC_MIN_SAMPLE_TRADES} Trades.`,
    };
  }
  if (trades < MC_MIN_SAMPLE_TRADES) {
    // Auftrag: ausdrücklich UNKNOWN, nie VIOLATED. Zu wenig Stichprobe ist
    // kein Gegenbeweis — dieselbe Logik wie `montecarlo.ts` (Abweisung statt
    // Scheingenauigkeit).
    return {
      status: "UNKNOWN",
      evidence:
        `${fmt(trades, 0)} Trades < Minimum ${MC_MIN_SAMPLE_TRADES} Trades ` +
        `(${fmt(MC_MIN_SAMPLE_TRADES - trades, 0)} fehlen) — Stichprobe nicht interpretierbar, ` +
        `kein VIOLATED.`,
    };
  }
  return {
    status: "HOLDS",
    evidence:
      `${fmt(trades, 0)} Trades ≥ Minimum ${MC_MIN_SAMPLE_TRADES} Trades ` +
      `(+${fmt(trades - MC_MIN_SAMPLE_TRADES, 0)} über der Grenze).`,
  };
}

// ── 7) CAPS_RESPECTED ───────────────────────────────────────────────────────
function checkCaps(ctx: AuditContext): CheckDraft {
  const trades = ctx.run.trades;
  const equity = ctx.run.equityPoints;
  if (!isFiniteNumber(trades) || !isFiniteNumber(equity)) {
    return {
      status: "UNKNOWN",
      evidence:
        `Deckel nicht prüfbar: ${isFiniteNumber(trades) ? fmt(trades, 0) : "keine"} Trades, ` +
        `${isFiniteNumber(equity) ? fmt(equity, 0) : "keine"} Equity-Punkte gemeldet ` +
        `(Deckel ${RULE_BACKTEST_TRADE_CAP}/${RULE_BACKTEST_EQUITY_CAP}).`,
    };
  }
  const overTrades = trades > RULE_BACKTEST_TRADE_CAP;
  const overEquity = equity > RULE_BACKTEST_EQUITY_CAP;
  const detail =
    `${fmt(trades, 0)} Trades (Deckel ${RULE_BACKTEST_TRADE_CAP}), ` +
    `${fmt(equity, 0)} Equity-Punkte (Deckel ${RULE_BACKTEST_EQUITY_CAP})`;
  if (overTrades || overEquity) {
    return {
      status: "VIOLATED",
      evidence:
        `${detail} — der Lauf liegt über mindestens einem Deckel ` +
        `(${[overTrades ? "trade_cap" : null, overEquity ? "equity_cap" : null]
          .filter(Boolean)
          .join(", ")}): Die ausgewertete Stichprobe ist ein Ausschnitt.`,
    };
  }
  return { status: "HOLDS", evidence: `${detail} — beide Deckel eingehalten.` };
}

// ── 8) LEAKAGE_PROTECTED ────────────────────────────────────────────────────
function checkLeakage(ctx: AuditContext): CheckDraft {
  const windows = isFiniteNumber(ctx.run.walkForwardWindows) ? (ctx.run.walkForwardWindows as number) : 0;
  const oos = ctx.run.outOfSample === true || windows > 0;
  if (!oos) {
    return {
      status: "HOLDS",
      evidence:
        `0 OOS-Fenster ausgewertet (walkForwardWindows = ${fmt(windows, 0)}) — ` +
        `Embargo/Purge nicht erforderlich, kein Look-ahead-Pfad im Lauf.`,
    };
  }
  const embargo = ctx.run.embargoMs;
  const purge = ctx.run.purgeMs;
  const missing: string[] = [];
  if (!isFiniteNumber(embargo) || (embargo as number) < 0) missing.push("embargoMs");
  if (!isFiniteNumber(purge) || (purge as number) < 0) missing.push("purgeMs");
  if (missing.length > 0) {
    return {
      status: "VIOLATED",
      evidence:
        `${fmt(windows, 0)} OOS-Fenster ohne ${missing.join(" und ")} ` +
        `(${missing.length} von 2 Leakage-Schutzparametern fehlen) — ` +
        `filterCandlesWithLeakageProtection() lief ohne Cutoff-Schutz.`,
    };
  }
  return {
    status: "HOLDS",
    evidence:
      `${fmt(windows, 0)} OOS-Fenster mit embargoMs = ${fmt(embargo as number, 0)} ` +
      `(${fmt((embargo as number) / 3_600_000, 2)} h) und purgeMs = ${fmt(purge as number, 0)} ` +
      `(${fmt((purge as number) / 3_600_000, 2)} h) — 2 von 2 Schutzparametern gesetzt.`,
  };
}

// ── 9) INTRADAY_ONLY ────────────────────────────────────────────────────────
function checkIntradayOnly(ctx: AuditContext): CheckDraft {
  const limitMs = SUPPORTED_TIMEFRAME_MS["1h"];
  const inTemplate = ctx.templateFields.includes("vwapPct");
  const inRule = ctx.ruleFields.includes("vwapPct");
  const usage = `${inTemplate ? 1 : 0} von ${ctx.templateFields.length} Pflichtfeldern, ` +
    `${inRule ? 1 : 0} von ${ctx.ruleFields.length} Regelbedingungen`;
  if (!inTemplate && !inRule) {
    return {
      status: "HOLDS",
      evidence:
        `vwapPct wird nicht genutzt (${usage}) — der UTC-Tagesanker ist für diese Strategie nicht tragend.`,
    };
  }
  const engineTf = ctx.config.timeframe ?? null;
  const ruleTf = ctx.version?.window?.timeframe ?? null;
  const effective: SupportedTimeframe | null = engineTf ?? ruleTf;
  const mismatch =
    engineTf && ruleTf && engineTf !== ruleTf
      ? ` (Achtung: Regel deklariert ${ruleTf}, Lauf nutzt ${engineTf})`
      : "";
  if (!effective) {
    return {
      status: "UNKNOWN",
      evidence:
        `vwapPct wird genutzt (${usage}), aber 0 Timeframes sind angegeben — ` +
        `Tragfähigkeit des UTC-Ankers nicht prüfbar (Grenze ${fmt(limitMs, 0)} ms).`,
    };
  }
  const tfMs = SUPPORTED_TIMEFRAME_MS[effective];
  if (tfMs >= limitMs) {
    return {
      // `1h` zählt zu VWAP_PCT_RELIABLE_TIMEFRAMES (STX-03-07), liefert aber
      // vor der zweiten Kerze des UTC-Tags null (STX-01) — daher WARNING.
      severity: effective === "1h" ? "WARNING" : "BLOCKING",
      status: "VIOLATED",
      evidence:
        `vwapPct wird genutzt (${usage}) auf Timeframe ${effective} = ${fmt(tfMs, 0)} ms ` +
        `≥ ${fmt(limitMs, 0)} ms (1 h)${mismatch} — der UTC-Tagesanker trägt dort nicht ` +
        `durchgehend (STX-01).`,
    };
  }
  return {
    status: "HOLDS",
    evidence:
      `vwapPct wird genutzt (${usage}) auf Timeframe ${effective} = ${fmt(tfMs, 0)} ms ` +
      `< ${fmt(limitMs, 0)} ms (1 h)${mismatch} — Intraday-Anker trägt.`,
  };
}

// ── 10) CHANGE_PCT_SEMANTICS ────────────────────────────────────────────────
function checkChangePct(ctx: AuditContext): CheckDraft {
  const inTemplate = ctx.templateFields.includes("changePct24h");
  const inRule = ctx.ruleFields.includes("changePct24h");
  const usage = `${inTemplate ? 1 : 0} von ${ctx.templateFields.length} Pflichtfeldern, ` +
    `${inRule ? 1 : 0} von ${ctx.ruleFields.length} Regelbedingungen`;
  if (!inTemplate && !inRule) {
    return {
      status: "HOLDS",
      evidence:
        `changePct24h wird nicht als Tageswert gelesen (${usage} nutzen das Feld) — ` +
        `die Perioden-Semantik ist nicht betroffen.`,
    };
  }
  return {
    status: "VIOLATED",
    evidence:
      `changePct24h wird genutzt (${usage}): ${RULE_FIELD_LABELS.changePct24h} — ` +
      `kein 24-h-Wert, sondern eine Periodendifferenz (STX-14).`,
  };
}

// ── 11) FILLS_MODELLED (Ergänzung zu den zehn Pflichtprüfungen) ─────────────
function checkFills(ctx: AuditContext): CheckDraft {
  const model = ctx.config.executionModel;
  if (!model) {
    return {
      status: "UNKNOWN",
      evidence: `0 Ausführungspfade angegeben (executionModel fehlt) — Fill-Modell nicht belegbar.`,
    };
  }
  if (model === "legacy") {
    return {
      status: "VIOLATED",
      evidence:
        `executionModel = "legacy" ⇒ Fill instant am Kerzenschluss (0 ms Latenz, ` +
        `0 Partial-Fill-Stufen, 0 Order-TTL) — die §3.4-Annahme „instant fills" gilt im Lauf.`,
    };
  }
  if (model === "paper") {
    return {
      status: "HOLDS",
      evidence:
        `executionModel = "paper" ⇒ FillSimulator mit Spread-Fill, Partial Fills und ` +
        `Funding-Accrual (1 Kosten-Code-Pfad mit dem PaperBroker); ohne Latenz/Order-TTL.`,
    };
  }
  return {
    status: "HOLDS",
    evidence:
      `executionModel = "event_replay" ⇒ Order-Lifecycle mit Latenz, Depth-Impact, ` +
      `Order-TTL, Partial Fills und punktgenauen Funding-Ereignissen (4 Friktionsquellen).`,
  };
}

const CHECK_BUILDERS: Readonly<Record<AssumptionCheckId, (ctx: AuditContext) => CheckDraft>> = {
  FEE_NONZERO: checkFee,
  SLIPPAGE_NONZERO: checkSlippage,
  SPREAD_MEASURED: checkSpread,
  DEPTH_SUFFICIENT: checkDepth,
  WARMUP_MET: checkWarmup,
  TRADES_SUFFICIENT: checkTrades,
  CAPS_RESPECTED: checkCaps,
  LEAKAGE_PROTECTED: checkLeakage,
  INTRADAY_ONLY: checkIntradayOnly,
  CHANGE_PCT_SEMANTICS: checkChangePct,
  FILLS_MODELLED: checkFills,
};

// ─────────────────────────────────────────────────────────────────────────────
// Hauptfunktion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prüft die deklarierten Annahmen eines Templates gegen die Fakten eines Laufs.
 *
 * Rein und deterministisch: keine IO, keine Uhr, keine DB, keine Mutation der
 * Eingaben. Liefert immer **alle** Prüfungen in fester Reihenfolge — auch die
 * gehaltenen, denn ein Report muss zeigen, was geprüft wurde, nicht nur, was
 * auffiel.
 *
 * @throws {Error} wenn eine injizierte Schwelle außerhalb
 *   {@link ASSUMPTION_THRESHOLD_BOUNDS} liegt (fail-closed, kein stilles Klemmen).
 */
export function auditAssumptions(input: AuditInput): AssumptionAudit {
  if (!input || typeof input !== "object") {
    throw new Error("auditAssumptions: Eingabe fehlt (0 Felder lesbar).");
  }
  const { template, version, run, candles, config } = input;
  if (!template || !Array.isArray(template.assumptions)) {
    throw new Error("auditAssumptions: template.assumptions fehlt (0 Annahmen lesbar).");
  }
  if (!version) {
    throw new Error("auditAssumptions: version (RuleSpec) fehlt.");
  }
  if (!run) {
    throw new Error("auditAssumptions: run (BacktestRunFacts) fehlt.");
  }
  if (!config) {
    throw new Error("auditAssumptions: config (RunConfigFacts) fehlt.");
  }

  const thresholds = resolveThresholds(config.thresholds);
  const criticalByCategory = new Map<AssumptionCategory, string[]>();
  for (const assumption of template.assumptions) {
    if (!assumption || assumption.critical !== true) continue;
    const list = criticalByCategory.get(assumption.category) ?? [];
    list.push(assumption.id);
    criticalByCategory.set(assumption.category, list);
  }

  const ctx: AuditContext = {
    template,
    version,
    run,
    candles: candles ?? null,
    config,
    thresholds,
    templateFields: template.requiredFields ?? [],
    ruleFields: ruleFieldsOf(version),
    criticalByCategory,
  };

  const checks: AssumptionCheck[] = ASSUMPTION_CHECK_IDS.map((id) => {
    const draft = CHECK_BUILDERS[id](ctx);
    const categories = ASSUMPTION_CHECK_CATEGORIES[id];
    const templateAssumptions = categories.flatMap((category) => {
      const ids = template.assumptions
        .filter((assumption) => assumption?.category === category)
        .map((assumption) => assumption.id);
      return ids;
    });
    return {
      assumptionId: id,
      status: draft.status,
      evidence: draft.evidence,
      severity: draft.severity ?? ASSUMPTION_CHECK_SEVERITY[id],
      templateAssumptions: [...new Set(templateAssumptions)],
    };
  });

  const violated = checks.filter((check) => check.status === "VIOLATED");
  const unknown = checks.filter((check) => check.status === "UNKNOWN");
  const blocking = checks.filter(
    (check) => check.severity === "BLOCKING" && check.status !== "HOLDS",
  );

  // critical-Regel (Auftrag Punkt 4): VIOLATED **oder** UNKNOWN einer Prüfung,
  // die einer kritischen Template-Annahme zugeordnet ist.
  const criticalIds = new Set([...criticalByCategory.values()].flat());
  const criticalFindings: string[] = [];
  for (const check of [...violated, ...unknown]) {
    for (const id of check.templateAssumptions) {
      if (criticalIds.has(id)) criticalFindings.push(id);
    }
  }
  const uniqueCritical = [...new Set(criticalFindings)];

  const coveredCategories = new Set<AssumptionCategory>(
    ASSUMPTION_CHECK_IDS.flatMap((id) => [...ASSUMPTION_CHECK_CATEGORIES[id]]),
  );
  const uncoveredCritical = template.assumptions
    .filter(
      (assumption) =>
        assumption?.critical === true && !coveredCategories.has(assumption.category),
    )
    .map((assumption) => assumption.id);

  const verdict: AssumptionVerdict =
    uniqueCritical.length > 0
      ? "INCONCLUSIVE"
      : blocking.some((check) => check.status === "VIOLATED")
        ? "FAIL"
        : unknown.length > 0
          ? "INCONCLUSIVE"
          : "PASS";

  const summary =
    `${template.id} v${template.version}: ${checks.length} Prüfungen — ` +
    `${checks.length - violated.length - unknown.length} HOLDS, ${violated.length} VIOLATED, ` +
    `${unknown.length} UNKNOWN; ${uniqueCritical.length} kritische Annahme(n) betroffen, ` +
    `${uncoveredCritical.length} kritische Annahme(n) ohne Prüfungsbezug ⇒ ${verdict}.`;

  return {
    checks,
    violated,
    unknown,
    verdict,
    blocking,
    criticalFindings: uniqueCritical,
    uncoveredCritical,
    summary,
    auditVersion: ASSUMPTION_AUDIT_VERSION,
  };
}

/**
 * Naht für die Reihenfolge-Vorschrift des Prompts (Punkt 5): Metriken
 * (06-02/06-03) dürfen erst ausgewertet werden, wenn der Annahmen-Audit `PASS`
 * liefert. `FAIL` **und** `INCONCLUSIVE` sperren — ein Lauf mit verletzter
 * Gebührenannahme hat keinen informativen Sharpe, und ein nicht prüfbarer Lauf
 * ist kein Beweis.
 */
export function assumptionGate(audit: AssumptionAudit): AssumptionGate {
  if (audit.verdict === "PASS") {
    return {
      allow: true,
      reason:
        `${audit.checks.length} von ${audit.checks.length} Annahmen-Prüfungen HOLDS ` +
        `(0 VIOLATED, 0 UNKNOWN) — Metrik-Auswertung freigegeben.`,
    };
  }
  if (audit.verdict === "FAIL") {
    const ids = audit.violated.map((check) => check.assumptionId).join(", ");
    return {
      allow: false,
      reason:
        `${audit.violated.length} BLOCKING-Prüfung(en) verletzt (${ids}) — ` +
        `der Lauf ist nachweislich kaputt, Metriken wären bedeutungslos.`,
    };
  }
  const ids = [...audit.criticalFindings, ...audit.unknown.map((c) => c.assumptionId)];
  return {
    allow: false,
    reason:
      `${audit.unknown.length} Prüfung(en) nicht belegbar, ${audit.criticalFindings.length} ` +
      `kritische Annahme(n) betroffen (${[...new Set(ids)].join(", ") || "keine"}) — ` +
      `Ergebnis INCONCLUSIVE, kein Beweis für oder gegen die Strategie.`,
  };
}
