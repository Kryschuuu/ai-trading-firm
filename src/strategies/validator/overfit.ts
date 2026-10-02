/**
 * STX-06-02 — Overfit- & Robustheitsauswertung (Phase 6, Finding STX-17).
 *
 * ── Die Frage ───────────────────────────────────────────────────────────────
 * Funktioniert die **Strategie** — oder funktioniert das **Parameterset**, das
 * man ausgewählt hat? Der Walk-Forward-Lauf (`src/backtest/walkforward.ts`)
 * liefert mit `FreezeArtifact.scoreTable` bereits einen vollständigen
 * Nachbarschafts-Scan: eine Score-Zeile je Kandidat und Fenster, mit
 * `passedGates`, `rejectionReason` und vollen Metriken. Was fehlte, war die
 * Auswertung — die **Breite** des stabilen Bereichs, nicht der Optimum-Punkt.
 *
 * „19 von 20 Parametervarianten funktionieren" ist ein Plateaubefund und trägt
 * eine Strategie. „19 von 20 sind ein Ausreißer, den 1 nicht" ist Fragilität.
 * `robustShare` macht genau diesen Unterschied maschinenlesbar.
 *
 * ── Reine Funktionen, keine IO ──────────────────────────────────────────────
 * Keine Uhr, keine Datei, keine DB, kein Zufall, kein LLM: Alle vier
 * Auswertungen lesen ausschließlich die übergebenen Strukturen. Dieselbe
 * Eingabe liefert byte-identisch dieselbe Ausgabe — damit ist jede Zahl in
 * einem Report (06-04) reproduzierbar. `walkforward.ts` wird **gelesen**, nie
 * geändert; Kandidaten entstehen weiterhin nur in `runWalkForward`
 * (`WalkForwardCandidate[]`), dieses Modul erzeugt keine.
 *
 * ── `UNKNOWN` ist ein Ergebnis, kein Fehler ─────────────────────────────────
 * Ohne Score-Tabelle (kein Walk-Forward gelaufen) gibt es keine Plateau-Aussage
 * — und ausdrücklich **nicht** das Urteil „robust, weil nur ein Kandidat
 * geprüft wurde". Ein einzelner Kandidat ist kein Nachbarschafts-Scan: weniger
 * als zwei Kandidaten ⇒ `UNKNOWN` mit Grund. Dieselbe Regel gilt für die
 * IS/OOS-Lücke (ein Aggregat ohne Fenster ist keine Aussage, nie „OK aus 0
 * Werten") und für die Holdout-Integrität (fehlende Artefakte ⇒ `UNKNOWN`).
 *
 * ── Multiple Testing: warum n > 20 blockiert (bitte nicht „wegoptimieren") ──
 * Ein Kandidatenraum ist ein multiples Testproblem, und die Selektion nimmt das
 * **Maximum** über n Varianten. Selbst wenn keine einzige echte Edge existiert,
 * wächst der erwartete Bestwert unter der Null mit √(2·ln n)
 * Standardfehlern (n = 5 ⇒ ≈ 1.79, n = 20 ⇒ ≈ 2.45, n = 50 ⇒ ≈ 2.80), und die
 * Wahrscheinlichkeit, dass mindestens eine Variante rein zufällig „besteht"
 * (nominal 5 % je Test, Unabhängigkeit unterstellt), ist 1 − 0.95ⁿ
 * (n = 5 ⇒ ≈ 23 %, n = 20 ⇒ ≈ 64 %, n = 50 ⇒ ≈ 92 %). Deshalb: ≤ 5 ohne
 * Zuschlag, 6…20 ⇒ `WARNING` im Report, > 20 ⇒ `BLOCKING`. Das ist keine
 * Übervorsicht — bei 50 Kandidaten ist der beste per Zufall gut, bis ein
 * Plateau **und** ein unberührter Holdout das Gegenteil zeigen. Die Grenzen
 * stehen in {@link MULTIPLE_TESTING_THRESHOLDS} und dürfen nur mit Begründung
 * verschoben werden.
 *
 * ── Dokumentierte Abweichungen von der Prompt-Skizze ────────────────────────
 * 1. `trainOosGap({ is, oos })` statt eines einzelnen `WalkForwardAggregate`:
 *    Die Lücke braucht **beide** Seiten; ein Aggregat trägt genau einen Sharpe.
 * 2. `plateauMetrics(scoreTable, options?)`: eine flache Tabelle ist genau
 *    **ein** Fenster (z. B. `FreezeArtifact.scoreTable`). Die Auswertung über
 *    alle Fenster übergibt die Tabellen je Fenster in Fenster-Reihenfolge
 *    (`freezeArtifacts.map(f => f.scoreTable)`). Eine flache Verkettung mehrerer
 *    Fenster wird abgelehnt: Fenstergrenzen sind ohne `windowIndex` in
 *    `CandidateScoreRow` nicht rekonstruierbar (erkannt an doppelter
 *    `candidateId` innerhalb einer Tabelle) — lieber ein Fehler als ein falscher
 *    Median.
 * 3. `robustShare`/`neverShare` sind `null`, wenn nicht auswertbar; Kennzahlen
 *    ohne Stichprobe sind `null`, nie `0` (Konvention aus dem 06-04-Prompt).
 * 4. `holdoutIntegrity(holdout, freeze, reference?)`: „unverändert" ist nur
 *    gegen eine Referenz prüfbar. Ohne sie wird `candlesHash` auf Existenz und
 *    sha256-Form geprüft und als `UNVERIFIED` ausgewiesen — nicht
 *    stillschweigend als sauber.
 * 5. `TrainOosGap.verdict` kennt `UNKNOWN` als vierten Wert (Aggregat ohne
 *    Fenster); 06-04 behandelt das wie fehlende Datenlage.
 * 6. Additive Felder (`candidateCount`, `windowCount`, `status`, `summary`,
 *    `thresholds`, `evidence`) machen die Zahl im Report auswertbar; der
 *    Prompt-Shape bleibt enthalten.
 *
 * ── Gesperrt (Prompt) ───────────────────────────────────────────────────────
 * Keine Änderung an `walkforward.ts`, keine neue Kandidatengenerierung, keine
 * LLM-Auswertung (06-05), keine MC-/Cost-Stress-Auswertung (06-03).
 */

import type {
  CandidateScoreRow,
  FreezeArtifact,
  HoldoutReport,
  WalkForwardAggregate,
} from "@/backtest/walkforward";

// ─────────────────────────────────────────────────────────────────────────────
// Vokabular
// ─────────────────────────────────────────────────────────────────────────────

/** Versionierung der Auswertungslogik (Teil eines späteren Report-Hashs, 06-04). */
export const OVERFIT_AUDIT_VERSION = "ovf1" as const;

/** Vollständigkeitsstatus einer Auswertung. `UNKNOWN` heißt „nicht auswertbar". */
export type OverfitStatus = "OK" | "UNKNOWN";

// ─────────────────────────────────────────────────────────────────────────────
// Kleine, deterministische Helfer
// ─────────────────────────────────────────────────────────────────────────────

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Zahl ohne Ballast: `2` statt `2.00`, `0.95` statt `0.9500000000000001`. */
function fmt(value: number, digits = 2): string {
  return Number(value.toFixed(digits)).toString();
}

/** Deutsche Prozentangabe aus einem Anteil 0…1. */
function pctText(share: number): string {
  return `${fmt(share * 100, 1)} %`;
}

/** Median (bei gerader Anzahl das Mittel der beiden mittleren Werte). */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) Plateau statt Optimum
// ─────────────────────────────────────────────────────────────────────────────

/** Eine Score-Tabelle eines Walk-Forward-Fensters (`FreezeArtifact.scoreTable`). */
export type WindowScoreTable = readonly CandidateScoreRow[];

/**
 * Eingabe von {@link plateauMetrics}: **eine** Fenster-Tabelle oder die
 * Tabellen **aller** Fenster in Fenster-Reihenfolge
 * (`freezeArtifacts.map(f => f.scoreTable)`). `null`/leer ⇒ `UNKNOWN`.
 */
export type PlateauScoreInput =
  | WindowScoreTable
  | readonly WindowScoreTable[];

export interface PlateauOptions {
  /**
   * Der tatsächlich gewählte Kandidat (`FreezeArtifact.selectedCandidateId` des
   * **letzten** Fensters; das ist der Kandidat, der in den Holdout wandert).
   * Ohne Angabe wird der Erstplatzierte der letzten Tabelle verwendet — bei
   * sortierten `FreezeArtifact.scoreTable`-Daten ist das derselbe Kandidat.
   * `null` schaltet die Rangauswertung ausdrücklich ab; ein unbekannter Name
   * wird abgewiesen.
   */
  selectedCandidateId?: string | null;
}

/** Ergebnis der Plateau-Auswertung (Prompt-Shape + additive Diagnosefelder). */
export interface PlateauMetrics {
  /**
   * Anteil der Kandidaten, die in **allen** Fenstern die Gates bestanden haben
   * (`passedGates === true` in jeder Zeile und in jedem Fenster vertreten).
   * `null`, wenn nicht auswertbar — nie eine erfundene 0.
   */
  robustShare: number | null;
  /** Anteil der Kandidaten, die in **keinem** Fenster bestanden haben. */
  neverShare: number | null;
  /** Anzahl stabiler Kandidaten (in allen Fenstern bestanden). */
  stableCount: number;
  /** Median der Rangfolge des gewählten Kandidaten über die Fenster. */
  selectedRankMedian: number | null;
  /** 0..1: wie stabil ist der gewählte Kandidat relativ zur Menge? */
  selectionStability: number | null;
  /** Anzahl der im Scan enthaltenen Kandidaten (Feldgröße des Plateaus). */
  candidateCount: number;
  /** Anzahl der ausgewerteten Fenster. */
  windowCount: number;
  /** Der gewählte Kandidat, dessen Rang ausgewertet wurde (oder `null`). */
  selectedCandidateId: string | null;
  /** Vollständigkeitsgrenze (Auftrag Punkt 5): ohne Scan kein Robustheitsurteil. */
  status: OverfitStatus;
  /** Immer gesetzt und immer mit Zahl (Repo-Konvention). */
  summary: string;
}

/**
 * Spiegelt die deterministische Sortierkette, mit der `runWalkForward` die
 * Score-Tabelle sortiert (Kommentar „Deterministisches Sortieren mit
 * Tie-Breaker" in `walkforward.ts`): Gates vor Score, dann NetPnl ↓,
 * Trades ↓, Max-Drawdown ↑, Kandidaten-ID ↑. `walkforward.ts` bleibt gesperrt
 * (dieser Prompt liest die Strukturen) — die Rangfolge wird deshalb hier
 * gespiegelt; eine Änderung der Kette dort **muss** diese Funktion mitziehen
 * (`compareScoreRows` ist die einzige Stelle, die davon abhängt).
 */
export function compareScoreRows(a: CandidateScoreRow, b: CandidateScoreRow): number {
  if (a.passedGates !== b.passedGates) return a.passedGates ? -1 : 1;
  if (a.score !== b.score) return b.score - a.score;
  if (a.metrics.netPnl !== b.metrics.netPnl) return b.metrics.netPnl - a.metrics.netPnl;
  if (a.metrics.trades !== b.metrics.trades) return b.metrics.trades - a.metrics.trades;
  if (a.metrics.maxDrawdownPct !== b.metrics.maxDrawdownPct) {
    return a.metrics.maxDrawdownPct - b.metrics.maxDrawdownPct;
  }
  return a.candidateId.localeCompare(b.candidateId);
}

function normalizeScoreTables(input: PlateauScoreInput | null | undefined): WindowScoreTable[] {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new Error(
      "overfit:plateau-invalid-input — scoreTable muss eine Fenster-Tabelle oder ein Array von Fenster-Tabellen sein.",
    );
  }
  if (input.length === 0) return [];

  const first: unknown = input[0];
  const nested = Array.isArray(first);
  const tables = (nested ? input : [input]) as WindowScoreTable[];

  for (const table of tables) {
    if (!Array.isArray(table)) {
      throw new Error(
        "overfit:plateau-invalid-input — jede Fenster-Tabelle muss ein Array von CandidateScoreRow sein.",
      );
    }
    const seen = new Set<string>();
    for (const row of table) {
      if (!row || !isNonEmptyString(row.candidateId)) {
        throw new Error(
          "overfit:plateau-invalid-row — jede Score-Zeile braucht eine nicht-leere candidateId.",
        );
      }
      if (seen.has(row.candidateId)) {
        throw new Error(
          `overfit:plateau-window-flattened — candidateId "${row.candidateId}" doppelt in einer Fenster-Tabelle; ` +
            "das sieht nach verketteten Fenstern aus. Bitte die Tabellen je Fenster (verschachtelt) übergeben.",
        );
      }
      seen.add(row.candidateId);
    }
  }
  return tables;
}

/**
 * Wertet den Nachbarschafts-Scan des Walk-Forwards als **Plateau** aus: wie
 * breit ist der Bereich stabiler Kandidaten — nicht wie gut ist der eine
 * Gewinner. Reine Funktion, keine IO, keine Uhr.
 *
 * - `robustShare` = Anteil der Kandidaten mit `passedGates` in **allen**
 *   Fenstern (ein Kandidat, der in einem Fenster fehlt, ist dort nicht
 *   bestanden — er zählt nicht als stabil).
 * - `neverShare` = Anteil der Kandidaten, die in keinem Fenster bestanden.
 * - `selectedRankMedian` / `selectionStability` beschreiben den gewählten
 *   Kandidaten: Rangfolge nach {@link compareScoreRows}, Stabilität als
 *   `1 − (Median-Rang − 1) / (Feldgröße − 1)` (1 = immer Erster, 0 = immer Letzter).
 *
 * Vollständigkeitsgrenze (Auftrag Punkt 5): ohne Tabelle, ohne Fenster, mit
 * weniger als zwei Kandidaten oder mit einer leeren Fenster-Tabelle liefert die
 * Funktion `status: "UNKNOWN"` samt Grund in `summary` — ausdrücklich nicht
 * „robust, weil nur ein Kandidat geprüft wurde".
 */
export function plateauMetrics(
  scoreTable: PlateauScoreInput | null | undefined,
  options: PlateauOptions = {},
): PlateauMetrics {
  const tables = normalizeScoreTables(scoreTable);
  const windowCount = tables.length;

  const byCandidate = new Map<string, { windows: number; rows: number; passed: number }>();
  const ranksById = new Map<string, number[]>();
  let maxFieldSize = 0;

  for (const table of tables) {
    maxFieldSize = Math.max(maxFieldSize, table.length);
    const sorted = [...table].sort(compareScoreRows);
    for (let index = 0; index < sorted.length; index++) {
      const row = sorted[index];
      const entry = byCandidate.get(row.candidateId) ?? { windows: 0, rows: 0, passed: 0 };
      entry.windows += 1;
      entry.rows += 1;
      if (row.passedGates) entry.passed += 1;
      byCandidate.set(row.candidateId, entry);
      const ranks = ranksById.get(row.candidateId) ?? [];
      ranks.push(index + 1);
      ranksById.set(row.candidateId, ranks);
    }
  }

  const candidateCount = byCandidate.size;
  let stableCount = 0;
  let neverCount = 0;
  for (const entry of byCandidate.values()) {
    if (entry.windows === windowCount && entry.passed === entry.rows) stableCount += 1;
    if (entry.passed === 0) neverCount += 1;
  }

  const hasEmptyWindow = tables.some((table) => table.length === 0);
  const complete = windowCount >= 1 && candidateCount >= 2 && !hasEmptyWindow;

  // Gewählter Kandidat: explizit, sonst der Erstplatzierte des letzten Fensters.
  let selectedCandidateId: string | null = null;
  if (options.selectedCandidateId !== undefined && options.selectedCandidateId !== null) {
    if (!byCandidate.has(options.selectedCandidateId)) {
      throw new Error(
        `overfit:plateau-selected-unknown — selectedCandidateId "${options.selectedCandidateId}" kommt in keiner Fenster-Tabelle vor.`,
      );
    }
    selectedCandidateId = options.selectedCandidateId;
  } else if (options.selectedCandidateId === undefined && windowCount > 0) {
    const last = [...tables[windowCount - 1]].sort(compareScoreRows);
    selectedCandidateId = last.length > 0 ? last[0].candidateId : null;
  }

  const selectedRanks = selectedCandidateId ? ranksById.get(selectedCandidateId) ?? [] : [];
  const rankMedianRaw = median(selectedRanks);
  const selectedRankMedian = rankMedianRaw === null ? null : Number(rankMedianRaw.toFixed(2));
  const selectionStability =
    selectedRankMedian === null || maxFieldSize <= 1
      ? null
      : Number(clamp01(1 - (selectedRankMedian - 1) / (maxFieldSize - 1)).toFixed(4));

  const robustShare = complete ? Number((stableCount / candidateCount).toFixed(4)) : null;
  const neverShare = complete ? Number((neverCount / candidateCount).toFixed(4)) : null;

  let summary: string;
  if (!complete) {
    if (windowCount === 0) {
      summary =
        "Keine Score-Tabelle übergeben (0 Fenster, 0 Kandidaten) — ohne Walk-Forward gibt es keine " +
        "Plateau-Aussage; ein einzelner Kandidat oder eine leere Menge ist nicht „robust“.";
    } else if (hasEmptyWindow) {
      summary =
        `${windowCount} Fenster, aber mindestens eine Fenster-Tabelle ist leer ` +
        `(${tables.filter((table) => table.length === 0).length} von ${windowCount}) — es wurde nicht für jeden ` +
        "Kandidaten in jedem Fenster entschieden ⇒ UNKNOWN.";
    } else {
      summary =
        `Nur ${candidateCount} Kandidat(en) in ${windowCount} Fenster(n) — ein einzelner Kandidat ist kein ` +
        "Nachbarschafts-Scan und wird nicht als robust gewertet ⇒ UNKNOWN.";
    }
  } else {
    const parts = [
      `${candidateCount} Kandidaten in ${windowCount} Fenster(n)`,
      `${stableCount} stabil (robustShare ${pctText(robustShare ?? 0)})`,
      `${neverCount} in keinem Fenster bestanden (neverShare ${pctText(neverShare ?? 0)})`,
    ];
    if (selectedCandidateId === null) {
      parts.push("kein gewählter Kandidat angegeben — Rangauswertung aus (0 Ränge)");
    } else if (selectedRankMedian === null) {
      parts.push(`gewählter Kandidat "${selectedCandidateId}" ohne Rang (0 Fenster)`);
    } else {
      parts.push(
        `gewählter Kandidat "${selectedCandidateId}": Median-Rang ${fmt(selectedRankMedian)} (Feld ${maxFieldSize}), ` +
          `Stabilität ${fmt(selectionStability ?? 0, 4)}`,
      );
    }
    summary = `${parts.join("; ")} ⇒ ${stableCount > 0 ? "Plateau" : "kein stabiler Kandidat"} (${stableCount}/${candidateCount}).`;
  }

  return {
    robustShare,
    neverShare,
    stableCount,
    selectedRankMedian,
    selectionStability,
    candidateCount,
    windowCount,
    selectedCandidateId,
    status: complete ? "OK" : "UNKNOWN",
    summary,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) IS/OOS-Lücke
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Konfigurierbare Grenzen der IS/OOS-Lücke.
 *
 * - `suspectGap = 0.5` (Default): Eine annualisierte Sharpe-Lücke **über** 0.5
 *   zwischen In- und Out-of-Sample ist größer als das, was Sampling-Rauschen
 *   bei 30-Tage-Fenstern typischerweise erklärt; die Selektion hat sich dann an
 *   IS-Eigenheiten angepasst statt an eine stabile Kante.
 * - `brokenOosAtOrBelow = 0` (Default): Ein OOS-Sharpe ≤ 0 heißt, die
 *   eingefrorene Konfiguration verdient ihr Risiko out-of-sample nicht — das
 *   entscheidet **immer**, unabhängig davon, wie gut IS aussah.
 *
 * Beide Grenzen sind konfigurierbar, aber die Defaults sind die Spezifikation.
 */
export interface TrainOosGapThresholds {
  /** Lücke (IS − OOS), ab der `SUSPECT` gilt (strikt `>`). */
  suspectGap: number;
  /** OOS-Sharpe, bis zu dem `BROKEN` gilt (einschließlich, `<=`). */
  brokenOosAtOrBelow: number;
}

export const DEFAULT_TRAIN_OOS_GAP_THRESHOLDS: Readonly<TrainOosGapThresholds> = {
  suspectGap: 0.5,
  brokenOosAtOrBelow: 0,
};

/** Harte Grenzen der Schwellen — außerhalb wird geworfen, nicht geklemmt. */
export const TRAIN_OOS_GAP_BOUNDS = {
  suspectGap: [0, 100] as const,
  brokenOosAtOrBelow: [-100, 100] as const,
};

export interface TrainOosGapInput {
  /** Aggregat der IS-Fenster (`WalkForwardReport.aggregateIs`). */
  is: WalkForwardAggregate;
  /** Aggregat der OOS-Fenster (`WalkForwardReport.aggregateOos`). */
  oos: WalkForwardAggregate;
  /** Override der Grenzen; fehlende Keys bleiben auf Default. */
  thresholds?: Partial<TrainOosGapThresholds> | null;
}

/** Urteil der IS/OOS-Lücke. `UNKNOWN` = Aggregat ohne Fenster (keine Aussage). */
export type TrainOosGapVerdict = "OK" | "SUSPECT" | "BROKEN" | "UNKNOWN";

export interface TrainOosGap {
  isSharpe: number;
  oosSharpe: number;
  /** `isSharpe − oosSharpe`; `null`, wenn kein OOS-Fenster vorliegt. */
  gap: number | null;
  verdict: TrainOosGapVerdict;
  /** Wirksame Grenzen (Defaults oder Override) — für den Report sichtbar. */
  thresholds: TrainOosGapThresholds;
  /** Immer mit Zahl. */
  evidence: string;
}

function resolveGapThresholds(
  override: Partial<TrainOosGapThresholds> | null | undefined,
): TrainOosGapThresholds {
  const merged: TrainOosGapThresholds = {
    ...DEFAULT_TRAIN_OOS_GAP_THRESHOLDS,
    ...(override ?? {}),
  };
  const [suspectMin, suspectMax] = TRAIN_OOS_GAP_BOUNDS.suspectGap;
  if (!isFiniteNumber(merged.suspectGap) || merged.suspectGap < suspectMin || merged.suspectGap > suspectMax) {
    throw new Error(
      `overfit:train-oos-gap-threshold — suspectGap muss eine Zahl in [${suspectMin}, ${suspectMax}] sein (ist ${String(merged.suspectGap)}).`,
    );
  }
  const [brokenMin, brokenMax] = TRAIN_OOS_GAP_BOUNDS.brokenOosAtOrBelow;
  if (
    !isFiniteNumber(merged.brokenOosAtOrBelow) ||
    merged.brokenOosAtOrBelow < brokenMin ||
    merged.brokenOosAtOrBelow > brokenMax
  ) {
    throw new Error(
      `overfit:train-oos-gap-threshold — brokenOosAtOrBelow muss eine Zahl in [${brokenMin}, ${brokenMax}] sein (ist ${String(merged.brokenOosAtOrBelow)}).`,
    );
  }
  return merged;
}

function requireAggregate(value: WalkForwardAggregate | null | undefined, side: string): WalkForwardAggregate {
  if (!value || typeof value !== "object") {
    throw new Error(`overfit:train-oos-gap-input — Aggregat "${side}" fehlt.`);
  }
  for (const field of ["sharpeRatio", "windows"] as const) {
    if (!isFiniteNumber(value[field])) {
      throw new Error(
        `overfit:train-oos-gap-input — ${side}.${field} muss eine endliche Zahl sein (ist ${String(value[field])}).`,
      );
    }
  }
  return value;
}

/**
 * Bewertet die Lücke zwischen In-Sample- und Out-of-Sample-Sharpe.
 *
 * **`isSharpe` allein entscheidet nie:** Ein brillantes IS kann eine kaputte OOS
 * nicht heilen (Regel `oosSharpe <= brokenOosAtOrBelow` ⇒ `BROKEN`) und eine
 * schwache IS-Seite allein bricht nichts. Die IS-Zahl geht ausschließlich als
 * Minuend in die Lücke ein — die Aussage trägt immer die OOS-Seite.
 *
 * `UNKNOWN`, wenn eines der Aggregate 0 Fenster hat: 0 Werte sind keine
 * Aussage (nie „OK aus 0 Werten"). `gap` ist dann `null`.
 */
export function trainOosGap(input: TrainOosGapInput): TrainOosGap {
  if (!input || typeof input !== "object") {
    throw new Error("overfit:train-oos-gap-input — Eingabe fehlt.");
  }
  const thresholds = resolveGapThresholds(input.thresholds);
  const isAggregate = requireAggregate(input.is, "is");
  const oosAggregate = requireAggregate(input.oos, "oos");
  const isSharpe = isAggregate.sharpeRatio;
  const oosSharpe = oosAggregate.sharpeRatio;

  if (isAggregate.windows <= 0 || oosAggregate.windows <= 0) {
    return {
      isSharpe,
      oosSharpe,
      gap: null,
      verdict: "UNKNOWN",
      thresholds,
      evidence:
        `${fmt(isAggregate.windows, 0)} IS-Fenster und ${fmt(oosAggregate.windows, 0)} OOS-Fenster — ` +
        "ohne OOS-Fenster gibt es keine Lückenaussage; 0 Werte sind kein OK.",
    };
  }

  const gap = Number((isSharpe - oosSharpe).toFixed(4));
  const verdict: TrainOosGapVerdict =
    oosSharpe <= thresholds.brokenOosAtOrBelow
      ? "BROKEN"
      : gap > thresholds.suspectGap
        ? "SUSPECT"
        : "OK";

  let evidence: string;
  if (verdict === "BROKEN") {
    evidence =
      `OOS-Sharpe ${fmt(oosSharpe)} ≤ ${fmt(thresholds.brokenOosAtOrBelow)} ⇒ BROKEN ` +
      `(Lücke ${fmt(gap)}); IS-Sharpe ${fmt(isSharpe)} aus ${fmt(isAggregate.windows, 0)} Fenster(n) kann das nicht heilen.`;
  } else if (verdict === "SUSPECT") {
    evidence =
      `IS-Sharpe ${fmt(isSharpe)} − OOS-Sharpe ${fmt(oosSharpe)} = ${fmt(gap)} > Grenze ${fmt(thresholds.suspectGap)} ⇒ SUSPECT ` +
      `(${fmt(oosAggregate.windows, 0)} OOS-Fenster).`;
  } else {
    evidence =
      `Lücke ${fmt(gap)} ≤ Grenze ${fmt(thresholds.suspectGap)} und OOS-Sharpe ${fmt(oosSharpe)} > ${fmt(thresholds.brokenOosAtOrBelow)} ` +
      `⇒ OK (${fmt(isAggregate.windows, 0)} IS-, ${fmt(oosAggregate.windows, 0)} OOS-Fenster).`;
  }

  return { isSharpe, oosSharpe, gap, verdict, thresholds, evidence };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) Multiple Testing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grenzen der Multiplizitätswarnung. Sie sind **nicht** konfigurierbar, weil
 * sie keine Modellannahme, sondern eine Eigenschaft der Selektion sind: Das
 * Maximum über einen Suchraum wächst mit dessen Größe (Begründung im
 * Modul-Header). Wer diese Zahlen ändern will, ändert die Aussagekraft der
 * Validierung — das braucht einen eigenen, begründeten Beschluss (06-04).
 */
export const MULTIPLE_TESTING_THRESHOLDS = {
  /** Bis einschließlich 5 Kandidaten: kein Multiplizitäts-Zuschlag. */
  reportAbove: 5,
  /** Ab 21 Kandidaten: `BLOCKING`. */
  blockingAbove: 20,
} as const;

export type MultipleTestingLevel = "NONE" | "WARNING" | "BLOCKING";

export interface MultipleTestingWarning {
  level: MultipleTestingLevel;
  /** `true` genau dann, wenn `level === "BLOCKING"` (Bequemlichkeit für 06-04 Schritt 7). */
  blocking: boolean;
  nCandidates: number;
  /** Immer mit Zahl: Familienfehler und erwarteter Maximal-Sharpe unter der Null. */
  evidence: string;
}

/** Prompt-Name des Ergebnisses von {@link multipleTestingWarning}. */
export type Warning = MultipleTestingWarning;

/**
 * Warnt vor dem Selektionseffekt eines Kandidatenraums — und blockiert ab 21
 * Kandidaten. Die statistische Begründung steht ausführlich im Modul-Header
 * („Multiple Testing: warum n > 20 blockiert") und wird **nicht** wegoptimiert:
 * Bei 50 Kandidaten ist der beste per Zufall gut.
 */
export function multipleTestingWarning(nCandidates: number): MultipleTestingWarning {
  if (!isFiniteNumber(nCandidates) || !Number.isInteger(nCandidates) || nCandidates < 1) {
    throw new Error(
      `overfit:multiple-testing-invalid — nCandidates muss eine ganze Zahl ≥ 1 sein (ist ${String(nCandidates)}).`,
    );
  }

  const level: MultipleTestingLevel =
    nCandidates > MULTIPLE_TESTING_THRESHOLDS.blockingAbove
      ? "BLOCKING"
      : nCandidates > MULTIPLE_TESTING_THRESHOLDS.reportAbove
        ? "WARNING"
        : "NONE";

  // Illustration unter der Null: Familienfehler bei nominal 5 % je Test
  // (Unabhängigkeit unterstellt) und erwarteter Bestwert von n Standard-
  // normalen ≈ √(2·ln n) Standardfehler.
  const familyError = 1 - Math.pow(0.95, nCandidates);
  const expectedMax = nCandidates > 1 ? Math.sqrt(2 * Math.log(nCandidates)) : 0;

  let evidence: string;
  if (level === "NONE") {
    evidence =
      `${nCandidates} Kandidat(en) ≤ ${MULTIPLE_TESTING_THRESHOLDS.reportAbove} — kein Multiplizitäts-Zuschlag: ` +
      `Familienfehler (nominal 5 % je Test) 1 − 0.95^${nCandidates} = ${pctText(familyError)}.`;
  } else if (level === "WARNING") {
    evidence =
      `${nCandidates} Kandidaten > ${MULTIPLE_TESTING_THRESHOLDS.reportAbove} (≤ ${MULTIPLE_TESTING_THRESHOLDS.blockingAbove}): ` +
      `Familienfehler ${pctText(familyError)}, erwarteter Bestwert unter der Null ≈ ${fmt(expectedMax)} Standardfehler ` +
      `(√(2·ln ${nCandidates})) — im Report ausweisen, nicht als Einzelbeleg lesen.`;
  } else {
    evidence =
      `${nCandidates} Kandidaten > ${MULTIPLE_TESTING_THRESHOLDS.blockingAbove} ⇒ BLOCKING: erwarteter Bestwert unter der Null ` +
      `≈ ${fmt(expectedMax)} Standardfehler, Familienfehler ${pctText(familyError)} — der beste Kandidat ist per Zufall gut. ` +
      "Kein PASS ohne multiplizitätsfeste Evidenz (Plateau + OOS + unberührter Holdout).";
  }

  return { level, blocking: level === "BLOCKING", nCandidates, evidence };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) Holdout-Integrität
// ─────────────────────────────────────────────────────────────────────────────

export type IntegrityStatus = "CLEAN" | "CONTAMINATED" | "UNKNOWN";

/**
 * Befund einer Einzelprüfung. `UNVERIFIED` ist die ehrliche Zwischenstufe für
 * „Struktur geprüft, Unverändertheit nicht gegenprüfbar" und beeinflusst den
 * Gesamtstatus **nicht** (er bleibt `CLEAN`, wenn sonst nichts auffällt).
 */
export type IntegrityFindingStatus = IntegrityStatus | "UNVERIFIED";

export const INTEGRITY_CHECK_IDS = [
  "HOLDOUT_AFTER_OOS",
  "SELECTION_FROZEN",
  "CANDLES_HASH",
] as const;

export type IntegrityCheckId = (typeof INTEGRITY_CHECK_IDS)[number];

export interface IntegrityFinding {
  id: IntegrityCheckId;
  status: IntegrityFindingStatus;
  /** Immer mit Zahl. */
  evidence: string;
}

/** Optionaler Referenzstand für „`candlesHash` unverändert". */
export interface HoldoutIntegrityReference {
  /** Erwarteter sha256 der IS-Kerzenreihe (64 Hex), z. B. aus einem zweiten Dump. */
  candlesHash?: string | null;
}

export interface IntegrityCheck {
  status: IntegrityStatus;
  /**
   * Ableitung für die Gate-Kette (06-04 Schritt 2): `CONTAMINATED` **und**
   * `UNKNOWN` ⇒ `INCONCLUSIVE`. `CLEAN` ⇒ `CLEAR` ist ausdrücklich **kein
   * PASS** — die übrigen Gates entscheiden.
   */
  verdict: "CLEAR" | "INCONCLUSIVE";
  /** Die drei Prüfungen in fester Reihenfolge {@link INTEGRITY_CHECK_IDS}. */
  checks: readonly IntegrityFinding[];
  /** Immer mit Zahl. */
  reason: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Prüft, ob der Holdout wirklich unberührt ist — die drei Bedingungen des
 * Prompts in fester Reihenfolge:
 *
 * 1. `holdout.from >= freeze.oosTo`: Der Holdout beginnt **nach** allen
 *    IS/OOS-Entscheidungen; eine Überlappung wäre Kontamination.
 * 2. `holdout.candidateId === freeze.selectedCandidateId`: keine Auswahl
 *    **nach** dem Holdout — der Holdout bewertet genau den eingefrorenen
 *    Kandidaten.
 * 3. `freeze.dataManifest.candlesHash`: vorhanden, sha256-förmig und — falls
 *    `reference.candlesHash` übergeben wird — unverändert.
 *
 * `freeze` ist das **letzte** Freeze-Artefakt (`freezeArtifacts.at(-1)`): dessen
 * `selectedCandidateId` ist der Kandidat, der in den Holdout wandert. Fehlende
 * Artefakte/Felder ⇒ `UNKNOWN` (nie „clean aus 0 Prüfungen").
 */
export function holdoutIntegrity(
  holdout: HoldoutReport | null | undefined,
  freeze: FreezeArtifact | null | undefined,
  reference?: HoldoutIntegrityReference | null,
): IntegrityCheck {
  const checks: IntegrityFinding[] = [];

  // 1) Zeitliche Trennung
  const holdoutFrom = holdout?.from;
  const holdoutTo = holdout?.to;
  const oosTo = freeze?.oosTo;
  if (
    !holdout ||
    !freeze ||
    !isFiniteNumber(holdoutFrom) ||
    !isFiniteNumber(holdoutTo) ||
    !isFiniteNumber(oosTo) ||
    holdoutTo <= holdoutFrom
  ) {
    checks.push({
      id: "HOLDOUT_AFTER_OOS",
      status: "UNKNOWN",
      evidence:
        "Holdout-Zeitraum oder OOS-Ende fehlt (0 belastbare Zeitpunkte) — die Trennung ist nicht prüfbar.",
    });
  } else if (holdoutFrom >= oosTo) {
    checks.push({
      id: "HOLDOUT_AFTER_OOS",
      status: "CLEAN",
      evidence:
        `Holdout beginnt bei ${holdoutFrom} ≥ OOS-Ende ${oosTo} (Abstand ${holdoutFrom - oosTo} ms, ` +
        `${fmt((holdoutFrom - oosTo) / 86_400_000, 2)} Tage).`,
    });
  } else {
    checks.push({
      id: "HOLDOUT_AFTER_OOS",
      status: "CONTAMINATED",
      evidence:
        `Holdout beginnt bei ${holdoutFrom}, OOS-Ende ist ${oosTo} — Überlappung ${oosTo - holdoutFrom} ms ` +
        "vor dem Cutoff; der Holdout war nicht unberührt.",
    });
  }

  // 2) Eingefrorene Auswahl
  const holdoutCandidate = holdout?.candidateId;
  const frozenCandidate = freeze?.selectedCandidateId;
  if (!holdout || !freeze || !isNonEmptyString(holdoutCandidate) || !isNonEmptyString(frozenCandidate)) {
    checks.push({
      id: "SELECTION_FROZEN",
      status: "UNKNOWN",
      evidence: "Holdout- oder Freeze-Kandidat fehlt (0 Kandidaten-IDs) — keine Auswahl-prüfbare Aussage.",
    });
  } else if (holdoutCandidate === frozenCandidate) {
    checks.push({
      id: "SELECTION_FROZEN",
      status: "CLEAN",
      evidence: `Holdout und Freeze nennen denselben Kandidaten "${frozenCandidate}" — keine Auswahl nach dem Holdout.`,
    });
  } else {
    checks.push({
      id: "SELECTION_FROZEN",
      status: "CONTAMINATED",
      evidence:
        `Holdout nutzt "${holdoutCandidate}", eingefroren war "${frozenCandidate}" — der Holdout hat (re)selektiert.`,
    });
  }

  // 3) Datenintegrität (candlesHash)
  const expected = reference?.candlesHash ?? null;
  const candlesHash = freeze?.dataManifest?.candlesHash;
  if (!freeze) {
    checks.push({
      id: "CANDLES_HASH",
      status: "UNKNOWN",
      evidence: "Kein Freeze-Artefakt übergeben (0 Hashes) — der Datenstand ist nicht prüfbar.",
    });
  } else if (!isNonEmptyString(candlesHash)) {
    checks.push({
      id: "CANDLES_HASH",
      status: "UNKNOWN",
      evidence: "freeze.dataManifest.candlesHash fehlt (0 Hashzeichen) — der Datenstand ist nicht prüfbar.",
    });
  } else if (!SHA256_HEX.test(candlesHash)) {
    checks.push({
      id: "CANDLES_HASH",
      status: "UNKNOWN",
      evidence: `freeze.dataManifest.candlesHash ist kein sha256 (${candlesHash.length} statt 64 Hex-Zeichen).`,
    });
  } else if (expected !== null) {
    if (!isNonEmptyString(expected) || !SHA256_HEX.test(expected)) {
      checks.push({
        id: "CANDLES_HASH",
        status: "UNKNOWN",
        evidence: "Referenz-Hash übergeben, aber nicht sha256-förmig (0 vergleichbare Zeichen) — nicht prüfbar.",
      });
    } else if (expected === candlesHash) {
      checks.push({
        id: "CANDLES_HASH",
        status: "CLEAN",
        evidence: `Kerzen-Hash stimmt mit der Referenz überein (${candlesHash.slice(0, 12)}…, 64 Hex) — Datenstand unverändert.`,
      });
    } else {
      checks.push({
        id: "CANDLES_HASH",
        status: "CONTAMINATED",
        evidence:
          `Kerzen-Hash weicht von der Referenz ab (${candlesHash.slice(0, 12)}… vs. ${expected.slice(0, 12)}…) — ` +
          "die Kerzenreihe wurde nach dem Freeze verändert.",
      });
    }
  } else {
    checks.push({
      id: "CANDLES_HASH",
      status: "UNVERIFIED",
      evidence:
        `Kerzen-Hash vorhanden (${candlesHash.slice(0, 12)}…, 64 Hex, 0 Vergleiche) — ohne Referenz-Hash ist ` +
        "„unverändert“ nicht beweisbar; der Freeze-Hash siegelt ihn nicht nachprüfbar.",
    });
  }

  const status: IntegrityStatus = checks.some((check) => check.status === "CONTAMINATED")
    ? "CONTAMINATED"
    : checks.some((check) => check.status === "UNKNOWN")
      ? "UNKNOWN"
      : "CLEAN";

  const count = (value: IntegrityFindingStatus): number =>
    checks.filter((check) => check.status === value).length;

  const reason =
    `Holdout-Integrität ${status}: ${checks.length} Prüfungen — ` +
    `${count("CLEAN")} CLEAN, ${count("CONTAMINATED")} CONTAMINATED, ${count("UNKNOWN")} UNKNOWN, ` +
    `${count("UNVERIFIED")} UNVERIFIED; ` +
    (status === "CONTAMINATED"
      ? `Kontamination belegt ⇒ ${holdout?.candidateId ?? "?"} nicht bewertbar (INCONCLUSIVE).`
      : status === "UNKNOWN"
        ? "Pflichtfakten fehlen (0 vollständige Prüfsätze) ⇒ INCONCLUSIVE, nicht CLEAN."
        : "Cutoff und Kandidat unverändert; CLEAN ist kein PASS.");

  return {
    status,
    verdict: status === "CLEAN" ? "CLEAR" : "INCONCLUSIVE",
    checks,
    reason,
  };
}
