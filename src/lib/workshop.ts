/**
 * Workshop: Missionen anlegen, Agenten einzeln ausführen, Prompts iterieren,
 * Trefferquote messen — die UI-Pendants zu Handbuch Kapitel 5 und 6.
 *
 * Diese Datei enthält bewusst NUR reine Funktionen (keine DB-, keine
 * Next.js-Abhängigkeiten), damit API-Routen und Tests dieselbe Logik teilen.
 * Guardrails werden hier NICHT geändert und NICHT neu erfunden —
 * Missions-Budgets werden gegen die existierenden LIMIT_CEILINGS
 * (src/lib/riskGuard.ts) geprüft, Prompts sind die weiche Schicht.
 */
import { LIMIT_CEILINGS } from "./riskGuard";
import { sanitizeSymbol, STATIC_PRICES } from "./marketData";

/**
 * Symbole, die der Paper-Broker kennt (Handbuch 5.3).
 * Quelle der Wahrheit ist STATIC_PRICES in marketData.ts — dort ergänzen,
 * dann kennt die UI das Symbol automatisch (Autocomplete + Validierung).
 */
export const MISSION_SYMBOLS: readonly string[] = Object.keys(STATIC_PRICES).sort();

/** Erlaubte Missions-Status (siehe DB-Schema `missions.status`). */
export const MISSION_STATUSES = ["PENDING", "ACTIVE", "COMPLETED", "KILLED"] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

/** Feldgrenzen für Missions-Formular (Titel/Ziel sind weiche Qualität, Länge hart). */
export const MISSION_TEXT_LIMITS = {
  titleMin: 3,
  titleMax: 120,
  objectiveMin: 10,
  objectiveMax: 2000,
} as const;

/** Prompt-Grenzen für den Prompt-Editor (Handbuch 6.3). */
export const PROMPT_LIMITS = {
  min: 20,
  max: 8000,
} as const;

export type MissionInput = {
  title: string;
  objective: string;
  symbol: string;
  riskBudget: number;
  maxPositionPct: number;
  status: MissionStatus;
};

export type ValidationResult<T> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; error: string };

function parseNumber(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return Number(raw.trim().replace(",", "."));
  return Number.NaN;
}

/**
 * Validiert und normalisiert Missions-Eingaben (Handbuch 5.1–5.3).
 * Risiko- und Positions-Fenster kommen aus LIMIT_CEILINGS — dieselben Grenzen,
 * gegen die riskGuard zur Laufzeit klemmt. Eine Mission mit 90 % Risiko wird
 * hier abgelehnt und nicht erst vom Broker blockiert.
 */
export function validateMissionInput(raw: unknown): ValidationResult<MissionInput> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Missionsdaten fehlen (JSON-Objekt erwartet)." };
  }
  const body = raw as Record<string, unknown>;
  const warnings: string[] = [];

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title.length < MISSION_TEXT_LIMITS.titleMin || title.length > MISSION_TEXT_LIMITS.titleMax) {
    return {
      ok: false,
      error: `Titel: ${MISSION_TEXT_LIMITS.titleMin}–${MISSION_TEXT_LIMITS.titleMax} Zeichen erforderlich.`,
    };
  }

  const objective = typeof body.objective === "string" ? body.objective.trim() : "";
  if (objective.length < MISSION_TEXT_LIMITS.objectiveMin) {
    return { ok: false, error: `Ziel: mindestens ${MISSION_TEXT_LIMITS.objectiveMin} Zeichen — eine Mission braucht prüfbare Regeln.` };
  }
  if (objective.length > MISSION_TEXT_LIMITS.objectiveMax) {
    return { ok: false, error: `Ziel: maximal ${MISSION_TEXT_LIMITS.objectiveMax} Zeichen.` };
  }
  // Weiche Qualitätshinweise (Handbuch 5.2) — blockieren nicht, warnen nur.
  if (/^(maximiere|maximize|erziel|handle (clever|gut)|sei vorsichtig)/i.test(objective)) {
    warnings.push("Das Ziel klingt vage („maximiere …“ / „handle clever …“). Besser: prüfbare Regeln wie „Nur Long über der 20-Tage-Linie, Stop 5 %“.");
  }

  const symbol = sanitizeSymbol(typeof body.symbol === "string" ? body.symbol : null);
  if (!symbol) {
    return { ok: false, error: `Symbol: ungültiges Format. Erlaubt (Paper-Broker): ${MISSION_SYMBOLS.join(", ")}.` };
  }
  if (!MISSION_SYMBOLS.includes(symbol)) {
    return {
      ok: false,
      error: `Symbol ${symbol} kennt der Paper-Broker nicht. Verfügbar: ${MISSION_SYMBOLS.join(", ")} (Handbuch 5.3).`,
    };
  }

  const [riskMin, riskMax] = LIMIT_CEILINGS.maxRiskPerTrade;
  const riskBudget = parseNumber(body.riskBudget);
  if (!Number.isFinite(riskBudget) || riskBudget < riskMin || riskBudget > riskMax) {
    return {
      ok: false,
      // API-Vertrag ist ein Bruchteil (0.02 = 2 %); das Dashboard-Formular
      // rechnet Prozent → Bruchteil. Die Meldung nennt beides, damit ein
      // direkter API-Aufruf mit „2“ nicht rätselt.
      error: `Risikobudget: Bruchteil zwischen ${riskMin} und ${riskMax} erwartet (entspricht ${(riskMin * 100).toFixed(1)}–${(riskMax * 100).toFixed(1)} %; Prozent zuerst durch 100 teilen).`,
    };
  }

  const [posMin, posMax] = LIMIT_CEILINGS.maxPositionPct;
  const maxPositionPct = parseNumber(body.maxPositionPct);
  if (!Number.isFinite(maxPositionPct) || maxPositionPct < posMin || maxPositionPct > posMax) {
    return {
      ok: false,
      error: `Max. Positionsgröße: Bruchteil zwischen ${posMin} und ${posMax} erwartet (entspricht ${(posMin * 100).toFixed(0)}–${(posMax * 100).toFixed(0)} %; Prozent zuerst durch 100 teilen).`,
    };
  }

  const statusRaw = typeof body.status === "string" ? body.status.toUpperCase() : "PENDING";
  if (!(MISSION_STATUSES as readonly string[]).includes(statusRaw)) {
    return { ok: false, error: `Status: erlaubt sind ${MISSION_STATUSES.join(", ")}.` };
  }

  return { ok: true, value: { title, objective, symbol, riskBudget, maxPositionPct, status: statusRaw as MissionStatus }, warnings };
}

/** Kanonische UUID (Drizzle `defaultRandom`). Verhindert, dass ungültige IDs
 *  erst im Postgres-Treiber als Fehler landen. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(raw: string): boolean {
  return UUID_RE.test(raw);
}

export type PromptInput = { agentId: string; systemPrompt: string };

/**
 * Validiert eine Prompt-Änderung (Handbuch 6.3). Prompts sind die weiche
 * Schicht: Änderungen wirken sofort (stehen in der DB), Guardrails bleiben
 * unberührt (Code-Schicht). Warnung, wenn das JSON-Format fehlt — kleine
 * Modelle verlieren sonst die Struktur.
 */
export function validatePromptInput(raw: unknown): ValidationResult<PromptInput> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Prompt-Daten fehlen (JSON-Objekt erwartet)." };
  }
  const body = raw as Record<string, unknown>;
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  if (!isUuid(agentId)) {
    return { ok: false, error: "agentId fehlt oder hat kein UUID-Format." };
  }
  const systemPrompt = typeof body.systemPrompt === "string" ? body.systemPrompt.trim() : "";
  if (systemPrompt.length < PROMPT_LIMITS.min) {
    return { ok: false, error: `systemPrompt: mindestens ${PROMPT_LIMITS.min} Zeichen.` };
  }
  if (systemPrompt.length > PROMPT_LIMITS.max) {
    return { ok: false, error: `systemPrompt: maximal ${PROMPT_LIMITS.max} Zeichen — kürzere Prompts halten kleine Modelle strukturierter (Handbuch 6.4).` };
  }
  const warnings: string[] = [];
  if (!/json/i.test(systemPrompt)) {
    warnings.push("Der Prompt erwähnt „JSON“ nicht. Ohne Format-Anweisung liefern kleine Modelle häufig Prosa → HOLD mit „kein gültiges JSON“.");
  }
  if (!systemPrompt.includes("{")) {
    warnings.push("Der Prompt enthält kein Beispiel-Objekt. Ein einziges vollständiges JSON-Beispiel wirkt Wunder (Handbuch 6.4).");
  }
  return { ok: true, value: { agentId, systemPrompt }, warnings };
}

// ── Trefferquote (Handbuch 6.4) ──────────────────────────────────────────────

/** Grundform eines Turn-Ergebnisses, wie ihn POST /api/firm/run liefert. */
export type TurnOutcomeLike = {
  ok: boolean;
  error?: string;
  result?: {
    status?: string;
    source?: string;
    decision?: {
      type?: string;
      reason?: string;
    };
  };
};

/** Kategorien der Trefferquote. INVALID_JSON = HOLD wegen unlesbarer Antwort. */
export const OUTCOME_CATEGORIES = ["TRADE", "HOLD", "INVALID_JSON", "ERROR", "OTHER"] as const;
export type OutcomeCategory = (typeof OUTCOME_CATEGORIES)[number];

/** Exakte Begründung, mit der parseDecision unlesbare Antworten markiert. */
export const INVALID_JSON_REASON = "kein gültiges JSON";

/**
 * Ordnet ein einzelnes Lauf-Ergebnis in eine Trefferquote-Kategorie ein.
 * TRADE/HOLD aus decision.type; „kaputtes JSON“ wird an der Begründung
 * erkannt (parseDecision: „Antwort des Modells war kein gültiges JSON.“);
 * REPORT/APPROVE/REJECT/KILL zählen als OTHER, API-Fehler als ERROR.
 */
export function classifyTurnOutcome(run: TurnOutcomeLike): OutcomeCategory {
  if (!run.ok) return "ERROR";
  const decision = run.result?.decision;
  const type = String(decision?.type ?? "").toUpperCase();
  const reason = String(decision?.reason ?? "");
  if (type === "TRADE") return "TRADE";
  if (type === "HOLD") {
    return reason.toLowerCase().includes(INVALID_JSON_REASON.toLowerCase()) ? "INVALID_JSON" : "HOLD";
  }
  if (["REPORT", "APPROVE", "REJECT", "KILL"].includes(type)) return "OTHER";
  return "ERROR";
}

export type RunStats = {
  total: number;
  counts: Record<OutcomeCategory, number>;
  /** Anteil in Prozent je Kategorie (0–100, gerundet auf eine Nachkommastelle). */
  pct: Record<OutcomeCategory, number>;
  /** true, wenn „kaputtes JSON“ gehäuft auftritt → Debugging-Tipps anzeigen. */
  showJsonTips: boolean;
};

/** Ab wann die Debug-Tipps eingeblendet werden: mindestens 2 Fälle und ≥ 20 %. */
export const JSON_TIPS_MIN_COUNT = 2;
export const JSON_TIPS_MIN_SHARE = 0.2;

export function aggregateOutcomes(outcomes: OutcomeCategory[]): RunStats {
  const counts = { TRADE: 0, HOLD: 0, INVALID_JSON: 0, ERROR: 0, OTHER: 0 } as Record<OutcomeCategory, number>;
  for (const o of outcomes) {
    if (OUTCOME_CATEGORIES.includes(o)) counts[o] += 1;
  }
  const total = outcomes.length;
  const pct = { TRADE: 0, HOLD: 0, INVALID_JSON: 0, ERROR: 0, OTHER: 0 } as Record<OutcomeCategory, number>;
  for (const key of OUTCOME_CATEGORIES) {
    pct[key] = total === 0 ? 0 : Number(((counts[key] / total) * 100).toFixed(1));
  }
  const share = total === 0 ? 0 : counts.INVALID_JSON / total;
  return {
    total,
    counts,
    pct,
    showJsonTips: counts.INVALID_JSON >= JSON_TIPS_MIN_COUNT && share >= JSON_TIPS_MIN_SHARE,
  };
}

/** Debug-Tipps aus Handbuch 6.4 für den Fall gehäuften „kaputten JSONs“. */
export const JSON_DEBUG_TIPS: readonly string[] = [
  "Format erzwingen — passiert bereits automatisch (format: \"json\" bzw. response_format), aber nur, wenn der Server es unterstützt.",
  "Prompt kürzen — kleine Modelle verlieren bei langen System-Prompts die Struktur.",
  "Beispiel mitgeben — ein einziges vollständiges JSON-Beispiel wirkt Wunder.",
  "Modell wechseln — qwen2.5 ist bei JSON verlässlicher als die meisten 3B-Alternativen.",
];
