/**
 * Validierungsschemata für alle Schritte des Agenten-Zyklus (Task 06).
 *
 * Garantiert:
 *   - Strikt typisierte Outputs für alle 8 Tages-Steps und den Weekly Review.
 *   - Ungültige oder bösartige LLM-Ausgaben werden zurückgewiesen.
 *   - Saubere Fallbacks für jeden Schritt.
 */

import { MAX_SHORTLIST_LIMIT } from "./types";
import type { ConfluenceSnapshot } from "@/confluence/types";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Macro Analyst Schemata
// ─────────────────────────────────────────────────────────────────────────────

export interface MacroAssetSnapshot {
  price?: number;
  change24hPct?: number;
  trend?: "UP" | "DOWN" | "SIDEWAYS";
  note?: string;
}

export interface MacroStepOutput {
  view: "BULLISH" | "BEARISH" | "NEUTRAL";
  regime: "RISK_ON" | "RISK_OFF" | "MIXED";
  volatilityRegime: "LOW" | "NORMAL" | "HIGH" | "EXTREME";
  assets: {
    btc?: MacroAssetSnapshot;
    eth?: MacroAssetSnapshot;
    dxy?: MacroAssetSnapshot;
    spx?: MacroAssetSnapshot;
    nasdaq?: MacroAssetSnapshot;
    gold?: MacroAssetSnapshot;
    bonds?: MacroAssetSnapshot;
    [key: string]: MacroAssetSnapshot | undefined;
  };
  thesis: string;
  confidence: number;
}

export function validateMacroOutput(input: unknown): { valid: boolean; data?: MacroStepOutput; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Macro output must be an object" };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.view !== "string" || typeof obj.regime !== "string") {
    return { valid: false, error: "Macro output: view and regime are required string properties" };
  }

  const viewRaw = obj.view.toUpperCase();
  if (!["BULLISH", "BEARISH", "NEUTRAL"].includes(viewRaw)) {
    return { valid: false, error: `Macro output: invalid view "${obj.view}"` };
  }
  const view = viewRaw as MacroStepOutput["view"];

  const regimeRaw = obj.regime.toUpperCase();
  if (!["RISK_ON", "RISK_OFF", "MIXED"].includes(regimeRaw)) {
    return { valid: false, error: `Macro output: invalid regime "${obj.regime}"` };
  }
  const regime = regimeRaw as MacroStepOutput["regime"];

  const volatilityRegime =
    typeof obj.volatilityRegime === "string" &&
    ["LOW", "NORMAL", "HIGH", "EXTREME"].includes(obj.volatilityRegime.toUpperCase())
      ? (obj.volatilityRegime.toUpperCase() as MacroStepOutput["volatilityRegime"])
      : "NORMAL";

  const thesis = typeof obj.thesis === "string" ? obj.thesis.slice(0, 500) : "Keine Makro-These vorhanden";
  const confidence =
    typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
      ? Math.max(0, Math.min(1, obj.confidence))
      : 0.5;

  const assets: MacroStepOutput["assets"] = {};
  if (obj.assets && typeof obj.assets === "object" && !Array.isArray(obj.assets)) {
    for (const [k, v] of Object.entries(obj.assets as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const item = v as Record<string, unknown>;
        assets[k.toLowerCase()] = {
          price: typeof item.price === "number" ? item.price : undefined,
          change24hPct: typeof item.change24hPct === "number" ? item.change24hPct : undefined,
          trend: typeof item.trend === "string" && ["UP", "DOWN", "SIDEWAYS"].includes(item.trend.toUpperCase())
            ? (item.trend.toUpperCase() as "UP" | "DOWN" | "SIDEWAYS")
            : "SIDEWAYS",
          note: typeof item.note === "string" ? item.note.slice(0, 200) : undefined,
        };
      }
    }
  }

  return {
    valid: true,
    data: {
      view,
      regime,
      volatilityRegime,
      assets,
      thesis,
      confidence,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Market Selection Schemata
// ─────────────────────────────────────────────────────────────────────────────

export interface DailyCandidate {
  instrumentId: string;
  rank: number;
  score: number;
  assetClass: string;
  selectionRationale: string;
}

export interface SelectionStepOutput {
  candidates: DailyCandidate[];
  selectedCount: number;
  asOf: string;
}

export function validateSelectionOutput(input: unknown): { valid: boolean; data?: SelectionStepOutput; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Selection output must be an object" };
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.candidates)) {
    return { valid: false, error: "Selection output: candidates must be an array" };
  }
  const rawList = obj.candidates;

  const candidates: DailyCandidate[] = [];
  for (let i = 0; i < rawList.length && i < MAX_SHORTLIST_LIMIT; i++) {
    const item = rawList[i] as Record<string, unknown>;
    if (typeof item.instrumentId === "string" && item.instrumentId) {
      candidates.push({
        instrumentId: item.instrumentId.trim(),
        rank: typeof item.rank === "number" ? item.rank : i + 1,
        score: typeof item.score === "number" ? item.score : 50,
        assetClass: typeof item.assetClass === "string" ? item.assetClass : "unknown",
        selectionRationale: typeof item.selectionRationale === "string" ? item.selectionRationale.slice(0, 200) : "Auswahl via Scanner & Makro",
      });
    }
  }

  return {
    valid: true,
    data: {
      candidates,
      selectedCount: candidates.length,
      asOf: typeof obj.asOf === "string" ? obj.asOf : new Date().toISOString(),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Technical Analyst Schemata
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministischer MTF-Konfluenzsnapshot je Analyse (RMA-P2-03, v1.62.0).
 *
 * Der Snapshot ist die AUTORITATIVE, codeseitig berechnete Deterministik
 * (`mtf-confluence@1`) — kein LLM-Feld. Er wird vom technischen Step NACH
 * dem LLM-Aufruf serverseitig angehängt; ein `confluence`-Feld in der
 * LLM-Antwort verwirft der Validator (kein Override-Pfad: das Modell darf
 * den Snapshot erläutern, aber nicht überschreiben).
 */
export type TechnicalConfluenceAttachment = ConfluenceSnapshot;

/** Aggregierte Konfluenz-Metadaten des technischen Steps (Artefakt). */
export interface TechnicalConfluenceMeta {
  /** Formelversion (z. B. `mtf-confluence@1`). */
  formulaVersion: string;
  /** Config-Schema-Version. */
  configVersion: number;
  /** Gemeinsamer Entscheidungszeitpunkt (ISO-UTC). */
  asOf: string;
  /** Snapshots je Status (Zähler, keine IDs). */
  computed: number;
  ok: number;
  degraded: number;
  abstained: number;
}

export interface InstrumentTechnicalAnalysis {
  instrumentId: string;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  technicalScore: number;
  rsi?: number;
  atr?: number;
  trend: string;
  keyLevels: {
    support: number;
    resistance: number;
  };
  thesis: string;
  /**
   * Deterministischer Konfluenzsnapshot (RMA-P2-03, additiv, optional).
   * Fehlt bei `CONFLUENCE_ENABLED=false` (Rollback-Pfad) — Alt-Artefakte
   * ohne Feld bleiben lesbar, neue Konsumenten behandeln `undefined` als
   * „kein Snapshot" (nie als neutralen Score).
   */
  confluence?: TechnicalConfluenceAttachment;
}

/**
 * Planungs- und Fit-Metadaten des Technical Steps (CYCLE-BATCH-01, additiv).
 *
 * Der Block ist die Antwort auf die Frage „warum hat der Analyst für dieses
 * Instrument nur NEUTRAL/50 geliefert?": er zeigt, ob ein Batch abgeschnitten
 * oder ausgefallen ist, statt die Zahl als Analyse aussehen zu lassen.
 */
export interface TechnicalPromptFitMeta {
  /** Veranschlagtes Eingabebudget in Tokens (`num_ctx` − `num_predict` − Puffer). */
  inputTokens: number;
  /** Davon abgeleitete Zeichenkappe je Aufruf. */
  inputChars: number;
  /** Erlaubte Fertigungsänge des Modells (`num_predict`). */
  maxOutputTokens: number;
  /** Kandidaten je Aufruf, die das Ausgabebudget zulässt. */
  maxItemsPerBatch: number;
  /** Was begrenzt hat: Budget, Env-Override oder keins von beiden. */
  constrainedBy: "env-batch-size" | "output" | "input" | "unbounded";
  /** Tatsächliche Zahl der LLM-Aufrufe (1 = Prompt passte in ein Fenster). */
  calls: number;
  /** Nebenläufigkeit der Aufrufe. */
  concurrency: number;
  /** `true`, wenn die Voll-Snapshots aus dem Prompt entfernt wurden (Redundanz zu `lines`). */
  droppedFullSnapshots: boolean;
  /** Batches, deren Antwort unbrauchbar war und neutral überdeckt wurde. */
  failedBatches: number;
  /** Instrumente, deren Analyse deshalb auf dem deterministischen Fallback sitzt. */
  fallbackInstruments: number;
  /** Empfohlenes `LLM_MAX_TOKENS`, damit alles in EINEN Aufruf gepasst hätte. */
  recommendedMaxOutputTokens: number;
  /** `true`, wenn mindestens ein Kandidat ohne Analyse aus dem Lauf herausgeht. */
  incomplete: boolean;
}

export interface TechnicalStepOutput {
  analyses: InstrumentTechnicalAnalysis[];
  analyzedCount: number;
  /** Aggregierte Konfluenz-Metadaten (additiv, optional, s. o.). */
  confluenceMeta?: TechnicalConfluenceMeta;
  /** Prompt-Fit/Batch-Plan (additiv, optional) — siehe {@link TechnicalPromptFitMeta}. */
  promptFit?: TechnicalPromptFitMeta;
}

export function validateTechnicalOutput(input: unknown): { valid: boolean; data?: TechnicalStepOutput; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Technical output must be an object" };
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.analyses)) {
    return { valid: false, error: "Technical output: analyses must be an array" };
  }
  const rawList = obj.analyses;

  const analyses: InstrumentTechnicalAnalysis[] = [];
  for (let i = 0; i < rawList.length && i < MAX_SHORTLIST_LIMIT; i++) {
    const item = rawList[i] as Record<string, unknown>;
    if (typeof item.instrumentId === "string" && item.instrumentId) {
      const bias = typeof item.bias === "string" && ["BULLISH", "BEARISH", "NEUTRAL"].includes(item.bias.toUpperCase())
        ? (item.bias.toUpperCase() as InstrumentTechnicalAnalysis["bias"])
        : "NEUTRAL";

      const keyLevels = item.keyLevels && typeof item.keyLevels === "object"
        ? {
            support: typeof (item.keyLevels as Record<string, unknown>).support === "number" ? Number((item.keyLevels as Record<string, unknown>).support) : 0,
            resistance: typeof (item.keyLevels as Record<string, unknown>).resistance === "number" ? Number((item.keyLevels as Record<string, unknown>).resistance) : 0,
          }
        : { support: 0, resistance: 0 };

      // RMA-P2-03: Ein `confluence`-Feld der LLM-Antwort wird hier bewusst
      // NICHT übernommen (kein Override-Pfad). Der technische Step hängt den
      // autoritativen Snapshot nach der Validierung serverseitig an.
      analyses.push({
        instrumentId: item.instrumentId.trim(),
        bias,
        technicalScore: typeof item.technicalScore === "number" ? item.technicalScore : 50,
        rsi: typeof item.rsi === "number" ? item.rsi : undefined,
        atr: typeof item.atr === "number" ? item.atr : undefined,
        trend: typeof item.trend === "string" ? item.trend : "neutral",
        keyLevels,
        thesis: typeof item.thesis === "string" ? item.thesis.slice(0, 300) : "TA neutral",
      });
    }
  }

  // Die Meta-Blöcke stammen vom CODE (Konfluenz-Zähler, Prompt-Fit-Plan),
  // nicht vom Modell. Wer sie hier nicht durchlässt, verliert sie doppelt:
  // die Engine schreibt das VALIDIERTE Output in `stepOutputs` — Nachfolger
  // und Tages-Artefakt sehen also genau das, was diese Funktion zurückgibt.
  // `confluenceMeta` war auf diesem Weg bereits verloren. Die Sanitizer unten
  // lassen darum nur bekannte, endliche Werte zu: ein Modell kann über diesen
  // Pfad nichts einschleusen, was nicht in die Metrik passt.
  const confluenceMeta = normalizeConfluenceMeta(obj.confluenceMeta);
  const promptFit = normalizePromptFit(obj.promptFit);

  return {
    valid: true,
    data: {
      analyses,
      analyzedCount: analyses.length,
      ...(confluenceMeta ? { confluenceMeta } : {}),
      ...(promptFit ? { promptFit } : {}),
    },
  };
}

/** Endliche Zahl oder Fallback — für Zähler, die das Artefakt ehrlich zeigt. */
function finiteOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolOr(value: unknown): boolean {
  return value === true;
}

function normalizeConfluenceMeta(raw: unknown): TechnicalConfluenceMeta | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const m = raw as Record<string, unknown>;
  return {
    formulaVersion: typeof m.formulaVersion === "string" ? m.formulaVersion.slice(0, 40) : "mtf-confluence@1",
    configVersion: Math.max(1, Math.trunc(finiteOr(m.configVersion, 1))),
    asOf: typeof m.asOf === "string" ? m.asOf.slice(0, 40) : "",
    computed: Math.max(0, Math.trunc(finiteOr(m.computed, 0))),
    ok: Math.max(0, Math.trunc(finiteOr(m.ok, 0))),
    degraded: Math.max(0, Math.trunc(finiteOr(m.degraded, 0))),
    abstained: Math.max(0, Math.trunc(finiteOr(m.abstained, 0))),
  };
}

const PROMPT_FIT_CONSTRAINED = new Set(["env-batch-size", "output", "input", "unbounded"]);

function normalizePromptFit(raw: unknown): TechnicalPromptFitMeta | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const m = raw as Record<string, unknown>;
  const constrained = PROMPT_FIT_CONSTRAINED.has(String(m.constrainedBy))
    ? (String(m.constrainedBy) as TechnicalPromptFitMeta["constrainedBy"])
    : "unbounded";
  return {
    inputTokens: Math.max(0, Math.trunc(finiteOr(m.inputTokens, 0))),
    inputChars: Math.max(0, Math.trunc(finiteOr(m.inputChars, 0))),
    maxOutputTokens: Math.max(0, Math.trunc(finiteOr(m.maxOutputTokens, 0))),
    maxItemsPerBatch: Math.max(1, Math.trunc(finiteOr(m.maxItemsPerBatch, 1))),
    constrainedBy: constrained,
    calls: Math.max(0, Math.trunc(finiteOr(m.calls, 0))),
    concurrency: Math.max(1, Math.trunc(finiteOr(m.concurrency, 1))),
    droppedFullSnapshots: boolOr(m.droppedFullSnapshots),
    failedBatches: Math.max(0, Math.trunc(finiteOr(m.failedBatches, 0))),
    fallbackInstruments: Math.max(0, Math.trunc(finiteOr(m.fallbackInstruments, 0))),
    recommendedMaxOutputTokens: Math.max(0, Math.trunc(finiteOr(m.recommendedMaxOutputTokens, 0))),
    incomplete: boolOr(m.incomplete),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. News Analyst Schemata
// ─────────────────────────────────────────────────────────────────────────────

export interface InstrumentNewsAnalysis {
  instrumentId: string;
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  impactScore: number;
  riskFlags: string[];
  summary: string;

  // RMA-P2-05: Kalibrierbarer strukturierter Sentiment-Envelope
  forecastId?: string;
  entityId?: string;
  symbol?: string;
  direction?: "BULLISH" | "BEARISH" | "NEUTRAL" | null;
  status?: "ACTIVE" | "ABSTAIN";
  probability?: number | null;
  confidence?: number;
  abstain?: boolean;
  abstainReason?: string | null;
  horizon?: "4h" | "24h" | "72h";
  horizonMinutes?: number;
  eventType?: string;
  sourceCount?: number;
  rawSourceCount?: number;
  coverage?: number;
  sourceEventTime?: Date | null;
  sourceEarliestAt?: Date | null;
  sourceLatestAt?: Date | null;
  asOf?: Date;
  validUntil?: Date;
  promptVersion?: number;
  model?: string;
  schemaVersion?: string;
  sourceDeduplicationHash?: string;
  contentHash?: string;
  ledgerForecastId?: string | null;
  view?: "BULLISH" | "BEARISH" | "NEUTRAL";
  thesis?: string;
}

export interface NewsStepOutput {
  analyses: InstrumentNewsAnalysis[];
  systemicRisk: {
    level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    headline: string;
    affectedSectors: string[];
  };
  /** Batch-Plan des News-Schritts (additiv, optional, CYCLE-BATCH-01). */
  promptFit?: NewsPromptFitMeta;
}

/**
 * Planungs-Metadaten des News-Schritts (CYCLE-BATCH-01, additiv).
 *
 * Der systemische Risiko-Block ist je Batch eine *Ganzmarkt*-Aussage. Viele
 * Batches liefern viele Aussagen — gemerged wird nach Schwere (MAX), nicht
 * nach Mehrheitsvotum: wer bei vier Batches dreimal LOW und einmal CRITICAL
 * liest, hat ein CRITICAL-Problem. `systemicRiskSource` sagt, ob der Wert vom
 * Modell kam oder aus dem Fallback stammen musste.
 */
export interface NewsPromptFitMeta {
  inputTokens: number;
  inputChars: number;
  maxOutputTokens: number;
  maxItemsPerBatch: number;
  constrainedBy: "env-batch-size" | "output" | "input" | "unbounded";
  calls: number;
  concurrency: number;
  failedBatches: number;
  fallbackInstruments: number;
  /** Headlines, die wegen des Batches in MEHREREN Prompts standen (systemische). */
  systemicHeadlines: number;
  systemicRiskSource: "model" | "fallback";
  incomplete: boolean;
}

export function validateNewsOutput(input: unknown): { valid: boolean; data?: NewsStepOutput; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "News output must be an object" };
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.analyses)) {
    return { valid: false, error: "News output: analyses must be an array" };
  }
  const rawList = obj.analyses;

  const analyses: InstrumentNewsAnalysis[] = [];
  for (let i = 0; i < rawList.length && i < MAX_SHORTLIST_LIMIT; i++) {
    const item = rawList[i] as Record<string, unknown>;
    if (typeof item.instrumentId === "string" && item.instrumentId) {
      const instrumentId = item.instrumentId.trim();
      const isAbstain = item.status === "ABSTAIN" || item.abstain === true;

      const rawSentiment = typeof item.sentiment === "string" && ["BULLISH", "BEARISH", "NEUTRAL"].includes(item.sentiment.toUpperCase())
        ? (item.sentiment.toUpperCase() as InstrumentNewsAnalysis["sentiment"])
        : "NEUTRAL";

      const impactScore = typeof item.impactScore === "number" && Number.isFinite(item.impactScore)
        ? Math.max(0, Math.min(100, item.impactScore))
        : 50;
      const riskFlags = Array.isArray(item.riskFlags) ? item.riskFlags.map(String).slice(0, 5) : [];
      const summary = typeof item.summary === "string" ? item.summary.slice(0, 500) : "Keine wesentlichen Nachrichten";

      if (isAbstain) {
        // Enthaltung: Direktionale Wahrscheinlichkeit ist NULL, nicht fälschlich neutral
        analyses.push({
          instrumentId,
          sentiment: "NEUTRAL",
          impactScore,
          riskFlags,
          summary,
          status: "ABSTAIN",
          abstain: true,
          abstainReason: typeof item.abstainReason === "string" ? item.abstainReason : "NO_SOURCES",
          direction: null,
          probability: null,
          confidence: 0,
          coverage: typeof item.coverage === "number" && Number.isFinite(item.coverage) ? Math.max(0, Math.min(1, item.coverage)) : 0,
          sourceCount: typeof item.sourceCount === "number" ? Math.max(0, item.sourceCount) : 0,
          rawSourceCount: typeof item.rawSourceCount === "number" ? Math.max(0, item.rawSourceCount) : 0,
          horizon: typeof item.horizon === "string" && ["4h", "24h", "72h"].includes(item.horizon) ? (item.horizon as "4h" | "24h" | "72h") : "24h",
          forecastId: typeof item.forecastId === "string" ? item.forecastId : undefined,
          view: "NEUTRAL",
          thesis: summary,
        });
      } else {
        const direction = typeof item.direction === "string" && ["BULLISH", "BEARISH", "NEUTRAL"].includes(item.direction.toUpperCase())
          ? (item.direction.toUpperCase() as "BULLISH" | "BEARISH" | "NEUTRAL")
          : rawSentiment;

        const confidence = typeof item.confidence === "number" && Number.isFinite(item.confidence)
          ? Math.max(0, Math.min(1, item.confidence))
          : Math.abs(impactScore - 50) / 50;

        let probability: number | null = null;
        if (typeof item.probability === "number" && Number.isFinite(item.probability)) {
          probability = Math.max(0.01, Math.min(0.99, item.probability));
        } else {
          const sign = direction === "BULLISH" ? 1 : direction === "BEARISH" ? -1 : 0;
          probability = Math.max(0.01, Math.min(0.99, Number((0.5 + sign * confidence / 2).toFixed(6))));
        }

        analyses.push({
          instrumentId,
          sentiment: direction,
          impactScore,
          riskFlags,
          summary,
          status: "ACTIVE",
          abstain: false,
          abstainReason: null,
          direction,
          probability,
          confidence,
          coverage: typeof item.coverage === "number" && Number.isFinite(item.coverage) ? Math.max(0, Math.min(1, item.coverage)) : 1.0,
          sourceCount: typeof item.sourceCount === "number" ? Math.max(0, item.sourceCount) : 1,
          rawSourceCount: typeof item.rawSourceCount === "number" ? Math.max(0, item.rawSourceCount) : 1,
          horizon: typeof item.horizon === "string" && ["4h", "24h", "72h"].includes(item.horizon) ? (item.horizon as "4h" | "24h" | "72h") : "24h",
          forecastId: typeof item.forecastId === "string" ? item.forecastId : undefined,
          view: direction,
          thesis: summary,
        });
      }
    }
  }

  const rawSys = (obj.systemicRisk && typeof obj.systemicRisk === "object" ? obj.systemicRisk : {}) as Record<string, unknown>;
  const level = typeof rawSys.level === "string" && ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(rawSys.level.toUpperCase())
    ? (rawSys.level.toUpperCase() as NewsStepOutput["systemicRisk"]["level"])
    : "LOW";

  const promptFit = normalizeNewsPromptFit(obj.promptFit);

  return {
    valid: true,
    data: {
      analyses,
      systemicRisk: {
        level,
        headline: typeof rawSys.headline === "string" ? rawSys.headline.slice(0, 200) : "Ruhige systemische Nachrichtenlage",
        affectedSectors: Array.isArray(rawSys.affectedSectors) ? rawSys.affectedSectors.map(String).slice(0, 12) : [],
      },
      // CYCLE-BATCH-01: dieselbe Handoff-Regel wie beim Technical Step — die
      // Engine schreibt das validierte Output in `stepOutputs`, was hier
      // fehlt, sieht weder das Artefakt noch ein Nachfolgeschritt.
      ...(promptFit ? { promptFit } : {}),
    },
  };
}

const NEWS_FIT_SOURCES = new Set(["model", "fallback"]);

function normalizeNewsPromptFit(raw: unknown): NewsPromptFitMeta | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const m = raw as Record<string, unknown>;
  return {
    inputTokens: Math.max(0, Math.trunc(finiteOr(m.inputTokens, 0))),
    inputChars: Math.max(0, Math.trunc(finiteOr(m.inputChars, 0))),
    maxOutputTokens: Math.max(0, Math.trunc(finiteOr(m.maxOutputTokens, 0))),
    maxItemsPerBatch: Math.max(1, Math.trunc(finiteOr(m.maxItemsPerBatch, 1))),
    constrainedBy: PROMPT_FIT_CONSTRAINED.has(String(m.constrainedBy))
      ? (String(m.constrainedBy) as NewsPromptFitMeta["constrainedBy"])
      : "unbounded",
    calls: Math.max(0, Math.trunc(finiteOr(m.calls, 0))),
    concurrency: Math.max(1, Math.trunc(finiteOr(m.concurrency, 1))),
    failedBatches: Math.max(0, Math.trunc(finiteOr(m.failedBatches, 0))),
    fallbackInstruments: Math.max(0, Math.trunc(finiteOr(m.fallbackInstruments, 0))),
    systemicHeadlines: Math.max(0, Math.trunc(finiteOr(m.systemicHeadlines, 0))),
    systemicRiskSource: NEWS_FIT_SOURCES.has(String(m.systemicRiskSource))
      ? (String(m.systemicRiskSource) as NewsPromptFitMeta["systemicRiskSource"])
      : "fallback",
    incomplete: m.incomplete === true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Risk Manager Schemata
// ─────────────────────────────────────────────────────────────────────────────

export interface RiskStepOutput {
  approvedCandidates: string[];
  rejectedCandidates: Array<{
    instrumentId: string;
    reason: string;
  }>;
  correlationWarnings: string[];
  maxPositionPct: number;
  riskBudgetPerTrade: number;
  rationale: string;
}

export function validateRiskOutput(input: unknown): { valid: boolean; data?: RiskStepOutput; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Risk output must be an object" };
  }
  const obj = input as Record<string, unknown>;

  const approvedCandidates = Array.isArray(obj.approvedCandidates)
    ? obj.approvedCandidates.map(String).slice(0, MAX_SHORTLIST_LIMIT)
    : [];

  const rejectedCandidates: RiskStepOutput["rejectedCandidates"] = [];
  if (Array.isArray(obj.rejectedCandidates)) {
    for (const item of obj.rejectedCandidates) {
      if (item && typeof item === "object") {
        const r = item as Record<string, unknown>;
        if (typeof r.instrumentId === "string" && r.instrumentId) {
          rejectedCandidates.push({
            instrumentId: r.instrumentId.trim(),
            reason: typeof r.reason === "string" ? r.reason.slice(0, 200) : "Risiko-Limit überschritten",
          });
        }
      }
    }
  }

  const correlationWarnings = Array.isArray(obj.correlationWarnings)
    ? obj.correlationWarnings.map(String).slice(0, 10)
    : [];

  const maxPositionPct = typeof obj.maxPositionPct === "number" && Number.isFinite(obj.maxPositionPct)
    ? Math.min(0.25, Math.max(0.01, obj.maxPositionPct))
    : 0.1;

  const riskBudgetPerTrade = typeof obj.riskBudgetPerTrade === "number" && Number.isFinite(obj.riskBudgetPerTrade)
    ? Math.min(0.02, Math.max(0.001, obj.riskBudgetPerTrade))
    : 0.01;

  const rationale = typeof obj.rationale === "string" ? obj.rationale.slice(0, 500) : "Risikoprüfung abgeschlossen";

  return {
    valid: true,
    data: {
      approvedCandidates,
      rejectedCandidates,
      correlationWarnings,
      maxPositionPct,
      riskBudgetPerTrade,
      rationale,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Research Schemata (Proposals only!)
// ─────────────────────────────────────────────────────────────────────────────

export interface TradeSetupProposal {
  instrumentId: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskScore: number;
  timeframe: string;
  thesis: string;
  /** Explizite Markierung: Rein unverbindlicher Vorschlag */
  isProposal: true;
}

export interface ResearchStepOutput {
  setups: TradeSetupProposal[];
  totalSetups: number;
  disclaimer: "PROPOSAL_ONLY_NO_ORDERS_PLACED";
}

export function validateResearchOutput(input: unknown): { valid: boolean; data?: ResearchStepOutput; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Research output must be an object" };
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.setups)) {
    return { valid: false, error: "Research output: setups must be an array" };
  }
  const rawList = obj.setups;

  const setups: TradeSetupProposal[] = [];
  for (let i = 0; i < rawList.length && i < MAX_SHORTLIST_LIMIT; i++) {
    const item = rawList[i] as Record<string, unknown>;
    if (typeof item.instrumentId === "string" && item.instrumentId) {
      const side = typeof item.side === "string" && item.side.toUpperCase() === "SHORT" ? "SHORT" : "LONG";
      const entryPrice = typeof item.entryPrice === "number" && item.entryPrice > 0 ? item.entryPrice : 100;
      const stopLoss = typeof item.stopLoss === "number" && item.stopLoss > 0
        ? item.stopLoss
        : side === "LONG" ? entryPrice * 0.95 : entryPrice * 1.05;
      const takeProfit = typeof item.takeProfit === "number" && item.takeProfit > 0
        ? item.takeProfit
        : side === "LONG" ? entryPrice * 1.1 : entryPrice * 0.9;

      setups.push({
        instrumentId: item.instrumentId.trim(),
        side,
        entryPrice,
        stopLoss,
        takeProfit,
        riskScore: typeof item.riskScore === "number" ? Math.max(0, Math.min(1, item.riskScore)) : 0.5,
        timeframe: typeof item.timeframe === "string" ? item.timeframe : "4h",
        thesis: typeof item.thesis === "string" ? item.thesis.slice(0, 300) : "Research-Setup-Vorschlag",
        isProposal: true,
      });
    }
  }

  return {
    valid: true,
    data: {
      setups,
      totalSetups: setups.length,
      disclaimer: "PROPOSAL_ONLY_NO_ORDERS_PLACED",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Backtest Verification Schemata
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifikations-Status EINES Setups (GAP-01, v1.51.0):
 *   - `"OK"` — Kennzahlen wurden gegen echte Kerzen gemessen.
 *   - `"DATA_UNAVAILABLE"` — zu wenige Kerzen (< 5): KEINE Bewertung,
 *     `verified=false`, Kennzahlen neutral-null (fail-closed statt der
 *     früheren erfundenen Mindestbewertung).
 */
export type VerifiedSetupStatus = "OK" | "DATA_UNAVAILABLE";

export interface VerifiedSetupResult {
  setup: TradeSetupProposal;
  verified: boolean;
  verdict: "PASSED" | "FAILED";
  status: VerifiedSetupStatus;
  metrics: {
    maxDrawdownPct: number;
    profitFactor: number;
    sharpeRatio: number;
    sortinoRatio: number;
    regimeRobustness: number;
  };
  failureReasons?: string[];
}

export interface BacktestStepOutput {
  verifiedSetups: VerifiedSetupResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    /** Setups mit `status: "DATA_UNAVAILABLE"` (Teilmenge von `failed`). */
    unavailable: number;
  };
}

export function validateBacktestOutput(input: unknown): { valid: boolean; data?: BacktestStepOutput; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Backtest output must be an object" };
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.verifiedSetups)) {
    return { valid: false, error: "Backtest output: verifiedSetups must be an array" };
  }
  const rawList = obj.verifiedSetups;

  const verifiedSetups: VerifiedSetupResult[] = [];
  let passedCount = 0;
  let failedCount = 0;
  let unavailableCount = 0;

  for (const item of rawList) {
    if (item && typeof item === "object") {
      const v = item as Record<string, unknown>;
      const rawMetrics = (v.metrics && typeof v.metrics === "object" ? v.metrics : {}) as Record<string, unknown>;
      const metrics = {
        maxDrawdownPct: typeof rawMetrics.maxDrawdownPct === "number" ? rawMetrics.maxDrawdownPct : 0,
        profitFactor: typeof rawMetrics.profitFactor === "number" ? rawMetrics.profitFactor : 1,
        sharpeRatio: typeof rawMetrics.sharpeRatio === "number" ? rawMetrics.sharpeRatio : 0,
        sortinoRatio: typeof rawMetrics.sortinoRatio === "number" ? rawMetrics.sortinoRatio : 0,
        regimeRobustness: typeof rawMetrics.regimeRobustness === "number" ? rawMetrics.regimeRobustness : 0.5,
      };

      const verified = Boolean(v.verified);
      if (verified) passedCount++;
      else failedCount++;

      // GAP-01 (v1.51.0): DATA_UNAVAILABLE-Status übernehmen (Default OK —
      // Alt-Artefakte ohne Status bleiben lesbar), Zähler mitführen.
      const status: VerifiedSetupStatus =
        v.status === "DATA_UNAVAILABLE" ? "DATA_UNAVAILABLE" : "OK";
      if (status === "DATA_UNAVAILABLE") unavailableCount++;

      const rawSetup = (v.setup && typeof v.setup === "object" ? v.setup : {}) as Record<string, unknown>;
      const setup: TradeSetupProposal = {
        instrumentId: typeof rawSetup.instrumentId === "string" ? rawSetup.instrumentId : "UNKNOWN",
        side: rawSetup.side === "SHORT" ? "SHORT" : "LONG",
        entryPrice: typeof rawSetup.entryPrice === "number" ? rawSetup.entryPrice : 100,
        stopLoss: typeof rawSetup.stopLoss === "number" ? rawSetup.stopLoss : 95,
        takeProfit: typeof rawSetup.takeProfit === "number" ? rawSetup.takeProfit : 110,
        riskScore: typeof rawSetup.riskScore === "number" ? rawSetup.riskScore : 0.5,
        timeframe: typeof rawSetup.timeframe === "string" ? rawSetup.timeframe : "4h",
        thesis: typeof rawSetup.thesis === "string" ? rawSetup.thesis : "Setup",
        isProposal: true,
      };

      verifiedSetups.push({
        setup,
        verified,
        verdict: verified ? "PASSED" : "FAILED",
        status,
        metrics,
        failureReasons: Array.isArray(v.failureReasons) ? v.failureReasons.map(String) : undefined,
      });
    }
  }

  return {
    valid: true,
    data: {
      verifiedSetups,
      summary: {
        total: verifiedSetups.length,
        passed: passedCount,
        failed: failedCount,
        unavailable: unavailableCount,
      },
    },
  };
}
