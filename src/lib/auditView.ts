/**
 * Menschlich lesbare Aufbereitung des Audit-Trails (`audit_log`) und des
 * Protokolls (`agent_messages`) für das Dashboard.
 *
 * Warum diese Datei existiert:
 *   Die UI zeigte bisher `JSON.stringify(detail).slice(0, 70)` — also
 *   abgeschnittene Roh-JSON ohne Beschriftung ("ceoRaw", "fill", "via").
 *   Ein Operator konnte nicht erkennen, OB eine Ablehnung ein Fehler oder
 *   korrektes Systemverhalten ist.
 *
 * Dieses Modul ist bewusst **rein**: kein DB-Import, kein React, keine
 * Seiteneffekte. Jede Funktion ist damit in `tests/auditView.test.ts`
 * deterministisch prüfbar und läuft identisch auf Server und Client.
 *
 * Drei Bausteine:
 *   1. KATALOG   — Event-Code → deutscher Titel + fachliche Erklärung.
 *   2. FELDER    — technischer Feldname → deutsches Label + Formatierer.
 *   3. PRÜFUNG   — logische Plausibilitätschecks (Widersprüche, Muster).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Typen
// ─────────────────────────────────────────────────────────────────────────────

/** Zeile aus `audit_log`, wie sie die API ausliefert (ISO-Zeitstempel). */
export type AuditEntryDto = {
  id: string;
  createdAt: string;
  event: string;
  level: string;
  detail?: unknown;
  missionId?: string | null;
  agentId?: string | null;
};

export type FactTone = "neutral" | "good" | "warn" | "bad";

/** Ein beschrifteter Wert ("Richtung: LONG — Kaufposition"). */
export type AuditFact = {
  label: string;
  value: string;
  /** Zusatzkontext, z. B. warum ein Wert auffällt. */
  hint?: string;
  tone?: FactTone;
  /** Monospace für IDs, Signaturen, Modell-Tags. */
  mono?: boolean;
};

/** Eine zusammengehörige Gruppe von Fakten (z. B. "Orderausführung (fill)"). */
export type AuditSection = {
  title: string;
  note?: string;
  facts: AuditFact[];
};

export type IssueSeverity = "info" | "warn" | "error";

/** Ergebnis der logischen Prüfung eines Eintrags. */
export type AuditIssue = {
  severity: IssueSeverity;
  title: string;
  detail: string;
};

export type AuditTone = "info" | "warn" | "critical";

export type AuditView = {
  id: string;
  /** ISO-Zeitstempel (Sortierung/Keys). */
  at: string;
  /** "27.08.2026, 14:56:14 UTC" — eindeutig, keine Zeitzonen-Rätsel. */
  atLabel: string;
  /** "vor 4 Minuten" — für den schnellen Blick. */
  relative: string;
  event: string;
  /** Deutscher Titel, z. B. "Order abgelehnt". */
  eventLabel: string;
  /** Fachliche Erklärung: Was bedeutet dieses Event im System? */
  eventDescription: string;
  level: string;
  /** "Information" | "Warnung" | "Kritisch". */
  levelLabel: string;
  tone: AuditTone;
  /** Ein-Zeilen-Zusammenfassung für den eingeklappten Zustand. */
  headline: string;
  /** Warum ist das passiert — in einem Satz, ohne Fachchinesisch. */
  explanation: string;
  sections: AuditSection[];
  issues: AuditIssue[];
  /** Vollständiger DB-Eintrag als JSON — nie gekürzt. */
  raw: string;
};

export type AuditTrailSummary = {
  total: number;
  info: number;
  warn: number;
  critical: number;
  issues: number;
  contradictions: number;
};

type Rec = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Basis-Helfer
// ─────────────────────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Rec {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function record(value: unknown): Rec {
  return isRecord(value) ? value : {};
}

/** Deutsche Zahlendarstellung (1.234,56) — das Dashboard ist deutsch. */
export function formatNumber(value: number, maxDigits = 2): string {
  return value.toLocaleString("de-DE", { maximumFractionDigits: maxDigits });
}

/**
 * Preise/Mengen OHNE Rundungsverlust: 14.367645 → "14,367645", 104.36 → "104,36".
 * `toLocaleString` füllt keine Nullen auf, liefert aber die volle Genauigkeit —
 * abgeschnittene Mengen ("14,3676") waren einer der gemeldeten Fehler.
 */
export function formatQuantity(value: number): string {
  const abs = Math.abs(value);
  const digits = abs > 0 && abs < 0.000001 ? 12 : 8;
  return value.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

/** Geldbeträge mit Vorzeichen: +32,90 / −12,40. */
export function formatSigned(value: number, maxDigits = 2): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toLocaleString("de-DE", { maximumFractionDigits: maxDigits })}`;
}

/** "1,3 s" / "840 ms". */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  return ms >= 1000 ? `${(ms / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} s` : `${Math.round(ms)} ms`;
}

/**
 * Eindeutiger Zeitstempel: "27.08.2026, 14:56:14 UTC".
 * UTC statt lokaler Zeit, weil Audit-Zeiten sonst je nach Browser/Server
 * unterschiedlich aussehen und nicht mehr vergleichbar sind.
 */
export function formatTimestampUtc(value: string | Date | null | undefined, now: Date = new Date()): string {
  const date = value instanceof Date ? value : text(value) ? new Date(value as string) : null;
  if (!date || !Number.isFinite(date.getTime())) return "Zeitstempel fehlt";
  void now;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}, ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`
  );
}

/** "vor 4 Minuten" / "in 2 Stunden" — robust gegen fehlende Zeitstempel. */
export function formatRelative(value: string | Date | null | undefined, now: Date = new Date()): string {
  const date = value instanceof Date ? value : text(value) ? new Date(value as string) : null;
  if (!date || !Number.isFinite(date.getTime())) return "ohne Zeitangabe";
  const diffMs = now.getTime() - date.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  let out: string;
  if (abs < 45_000) out = "gerade eben";
  else if (abs < hour) out = `${Math.round(abs / minute)} Minuten`;
  else if (abs < day) out = `${Math.round(abs / hour)} Stunden`;
  else if (abs < 30 * day) out = `${Math.round(abs / day)} Tagen`;
  else out = `${Math.round(abs / (30 * day))} Monaten`;
  if (out === "gerade eben") return future ? "in wenigen Sekunden" : out;
  return future ? `in ${out}` : `vor ${out}`;
}

/** "ceoRaw" → "Ceo Raw"? Nein: bekannte Namen kommen aus dem Wörterbuch. */
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return spaced.length > 0 ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

/**
 * Erkennt abgeschnittene JSON-Strings.
 * Die Engine protokolliert Modellantworten bewusst gekürzt
 * (`ceoRun.raw.slice(0, 500)`) — die UI muss das sagen, statt einen
 * "kaputten" Eintrag zu zeigen.
 */
export function isTruncatedJson(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return false;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fachwörterbücher
// ─────────────────────────────────────────────────────────────────────────────

/** Rollen der Firma (src/lib/seed.ts) — inklusive Analystenteam. */
export const ROLE_LABELS: Record<string, string> = {
  CEO: "CEO (Strategie & Freigabe)",
  RESEARCH: "Research (Marktanalyse)",
  EXECUTOR: "Executor (Orderausführung)",
  APPROVER: "Approver (Freigabe-Instanz)",
  RISK_MANAGER: "Risk Manager (Risikoprüfung)",
  BACKTEST: "Backtest (Historienprüfung)",
  TECHNICAL_ANALYST: "Technical Analyst (Charttechnik)",
  MACRO_ANALYST: "Macro Analyst (Marktumfeld)",
  NEWS_ANALYST: "News Analyst (Nachrichtenlage)",
  SWING_RESEARCHER: "Swing Researcher (Mehrtages-Setups)",
  SCOUT: "Scout (Penny-Screener)",
  DILIGENCE: "Diligence (Penny-Prüfung)",
};

/**
 * Rollen mit Handelsmandat (src/lib/engine.ts): nur diese beiden dürfen
 * überhaupt eine Order auslösen. Grundlage für die Widerspruchs-Prüfung.
 */
export const TRADING_ROLES = ["EXECUTOR", "RESEARCH"] as const;

export const SIDE_LABELS: Record<string, string> = {
  LONG: "LONG — Kaufposition (Gewinn bei steigenden Kursen)",
  SHORT: "SHORT — Verkaufsposition (Gewinn bei fallenden Kursen)",
};

export const FILL_STATUS_LABELS: Record<string, string> = {
  FILLED: "Gefüllt — der Auftrag wurde ausgeführt",
  REJECTED: "Abgelehnt — der Auftrag wurde nicht ausgeführt",
  PENDING: "Wartend",
  OPEN: "Offen",
  CLOSED: "Geschlossen",
};

export const DECISION_LABELS: Record<string, string> = {
  TRADE: "TRADE — handeln",
  HOLD: "HOLD — abwarten, keine Order",
  REPORT: "REPORT — Bericht ohne Handlung",
  APPROVE: "APPROVE — Vorschlag freigeben",
  REJECT: "REJECT — Vorschlag ablehnen",
  KILL: "KILL — Not-Halt angefordert",
};

export const SOURCE_LABELS: Record<string, string> = {
  ollama: "Lokales LLM (Ollama)",
  fallback: "Deterministische Regel-Engine (kein LLM)",
  monitor: "Marktmonitor (Scheduler-Tick)",
  agent: "Agent (Stammdaten)",
  snapshot: "Protokoll-Snapshot",
  system: "System",
  dashboard: "Dashboard (manuelle Änderung)",
  "workshop-ui": "Workshop (manuelle Eingabe)",
  orphaned: "Archivierter Agent",
  SIGMA: "LLM-Regelentwurf",
  FALLBACK: "Deterministische Regel-Engine",
  MANUAL: "Manuell angelegt",
};

export const REGIME_LABELS: Record<string, string> = {
  NORMAL: "NORMAL — ruhiger Markt, volles Risikobudget",
  ELEVATED: "ELEVATED — erhöhte Volatilität, Budget reduziert",
  EXTREME: "EXTREME — Stressphase, Budget stark reduziert",
};

export const VERDICT_LABELS: Record<string, string> = {
  APPROVE: "APPROVE — Regel freigegeben",
  REVISE: "REVISE — Regel überarbeiten",
  REJECT: "REJECT — Regel abgelehnt",
};

/**
 * Ablehnungs- und Blockgründe der Guardrail-Kette.
 * Ein Grund, der hier fehlt, wird in der UI als "unbekannter Grund"
 * gekennzeichnet — so fällt eine neue, undokumentierte Ursache sofort auf.
 */
export const BLOCK_REASON_LABELS: Record<string, string> = {
  KILL_SWITCH_ARMED: "Not-Halt aktiv",
  ROLE_NOT_ALLOWED_TO_TRADE: "Rolle ohne Handelsmandat",
  NO_QUOTE: "Kein Kurs verfügbar",
  POSITION_ALREADY_OPEN: "Position im Symbol bereits offen",
  INSUFFICIENT_CASH: "Zu wenig freies Kapital",
  DAILY_LOSS_LIMIT: "Tagesverlust-Limit erreicht",
  COOLDOWN_AFTER_LOSSES: "Cooldown nach Verlustserie",
  SHORT_DISABLED: "Short-Handel deaktiviert",
  INVALID_SYMBOL: "Ungültiges Symbol",
  STOP_LOSS_HIT: "Stop-Loss ausgelöst",
  TAKE_PROFIT_HIT: "Take-Profit erreicht",
  MISSION_KILLED: "Mission beendet",
  MAX_POSITION_PCT: "Positionsgröße über Limit",
  NO_STOP_LOSS: "Order ohne Pflicht-Stop-Loss",
  MAX_CONCURRENCY: "Maximale Anzahl offener Positionen erreicht",
};

export const BLOCK_REASON_EXPLANATIONS: Record<string, string> = {
  KILL_SWITCH_ARMED:
    "Der Not-Halt ist aktiv. Bis ein Mensch ihn entschärft, wird keine einzige Order ausgeführt — das ist die härteste Sicherheitsschicht des Systems und arbeitet korrekt.",
  ROLE_NOT_ALLOWED_TO_TRADE:
    "Nur Research und Executor dürfen Orders auslösen (src/lib/engine.ts). Alle anderen Rollen liefern Ideen, die die Pipeline an die zuständige Rolle weitergibt. Diese Ablehnung ist kein Fehler, sondern gelebtes Rollen-Mandat.",
  NO_QUOTE:
    "Für das Symbol gab es weder einen Live-Kurs noch einen Fallback-Preis. Ohne Kurs wird nicht geraten, sondern abgebrochen.",
  POSITION_ALREADY_OPEN:
    "In diesem Symbol ist bereits eine Position offen. Nachkäufe sind gesperrt, damit parallele Läufe dieselbe Idee nicht mehrfach aufblähen.",
  INSUFFICIENT_CASH: "Das freie Kapital reicht für die gewünschte Ordergröße nicht aus. Hebel ist verboten.",
  DAILY_LOSS_LIMIT:
    "Der realisierte Tagesverlust hat das konfigurierte Limit erreicht. Neueröffnungen sind bis zum nächsten Tag gestoppt — Schutz vor Rachetrades.",
  COOLDOWN_AFTER_LOSSES:
    "Nach mehreren Verlusten in Folge pausiert das System bewusst (Cooldown), statt Verlusten hinterherzulaufen.",
  SHORT_DISABLED: "Die Risikokonfiguration erlaubt nur Long-Positionen; der Short-Vorschlag wurde deshalb verworfen.",
  INVALID_SYMBOL:
    "Das vom Modell genannte Symbol steht nicht auf der Whitelist. Unbekannte Symbole werden abgewiesen, damit Modell-Output keine Sonderzeichen einschleust.",
  STOP_LOSS_HIT:
    "Der Kurs hat den Stop-Loss erreicht; der Monitor hat die Position automatisch glattgestellt. Verlust ist einkalkuliert, kein Systemfehler.",
  TAKE_PROFIT_HIT:
    "Der Kurs hat das Take-Profit-Ziel erreicht; der Monitor hat den Gewinn realisiert.",
  MISSION_KILLED: "Die zugehörige Mission wurde beendet, bevor der Auftrag ausgeführt werden konnte.",
  MAX_POSITION_PCT: "Die Ordergröße hätte das konfigurierte Positions-Limit überschritten.",
  NO_STOP_LOSS: "Jede Order braucht zwingend einen Stop-Loss. Ohne ihn wird nicht gehandelt.",
  MAX_CONCURRENCY: "Die maximale Anzahl gleichzeitig offener Positionen ist erreicht.",
};

/** Deutsche Beschriftung technischer Feldnamen. */
export const FIELD_LABELS: Record<string, string> = {
  // Allgemein
  at: "Zeitpunkt",
  timestamp: "Zeitpunkt",
  createdAt: "Angelegt am",
  event: "Ereignis",
  level: "Stufe",
  reason: "Grund",
  reasons: "Gründe",
  message: "Fehlermeldung",
  status: "Status",
  via: "Quelle der Änderung",
  source: "Quelle",
  by: "Ausgelöst von",
  actor: "Akteur",
  action: "Aktion",
  symbol: "Symbol",
  missionId: "Mission (ID)",
  agentId: "Agent (ID)",
  // Agenten-Entscheidung
  role: "Rolle",
  model: "KI-Modell",
  latencyMs: "Antwortzeit",
  decision: "Entscheidung",
  type: "Entscheidungstyp",
  side: "Richtung",
  qty: "Menge",
  stopLossPct: "Stop-Loss (%)",
  riskScore: "Risiko-Score",
  // Order / Fill
  order: "Auftrag",
  fill: "Orderausführung",
  fills: "Orderausführungen",
  orderId: "Order-ID",
  fillPrice: "Füllpreis",
  stopLoss: "Stop-Loss (Kurs)",
  takeProfit: "Take-Profit (Kurs)",
  riskNotional: "Orderwert (Notional)",
  limitPrice: "Limit-Kurs",
  raw: "Roheingabe des Modells",
  // Positions-Exits
  entry: "Einstiegskurs",
  exit: "Ausstiegskurs",
  triggerPrice: "Auslösekurs",
  realizedPnl: "Realisierter Gewinn/Verlust",
  realizedToday: "Realisierter Tages-P&L",
  drawdownPct: "Drawdown",
  flatten: "Positionen glattgestellt",
  closed: "Geschlossene Positionen",
  // Risiko
  factor: "Risiko-Multiplikator",
  prevRegime: "Vorheriges Regime",
  regime: "Volatilitäts-Regime",
  triggered: "Ausgelöste Indikatoren",
  baseMaxRiskPerTrade: "Basis-Risiko pro Trade",
  effectiveMaxRiskPerTrade: "Wirksames Risiko pro Trade",
  dailyLossLimitPct: "Tagesverlust-Limit",
  dayPnl: "Tages-P&L",
  consecLosses: "Verluste in Folge",
  // Konfiguration
  key: "Konfigurationsschlüssel",
  before: "Wert vorher",
  after: "Wert nachher",
  effective: "Wirksamer Wert",
  requested: "Angefragter Wert",
  clamped: "Auf Grenzwert geklemmt",
  namespace: "Namensraum",
  // Regeln / Makro-Zyklus
  ruleId: "Regel-ID",
  ruleKey: "Regel-Familie (ruleKey)",
  version: "Version",
  signature: "Signatur",
  sourceMode: "Entstehung",
  sourceRole: "Erstellt von (Rolle)",
  ceoVerdict: "CEO-Verdikt",
  ceoRaw: "CEO-Entscheidung (Rohantwort)",
  warnings: "Hinweise",
  superseded: "Ersetzte Versionen",
  previousVersionId: "Vorherige Version (ID)",
  price: "Kurs",
  evalMicros: "Auswertedauer",
  startedProcess: "Prozess neu gestartet",
  trades: "Anzahl Trades",
  pnl: "Gewinn/Verlust",
  profitFactor: "Profit-Faktor",
  from: "Von Version",
  to: "Auf Version",
  // Missionen
  title: "Missionstitel",
  objective: "Ziel",
  riskBudget: "Risikobudget",
  maxPositionPct: "Max. Positionsgröße",
  // Agenten-Prompt
  agent: "Agent",
  oldLength: "Prompt-Länge vorher (Zeichen)",
  newLength: "Prompt-Länge nachher (Zeichen)",
  // Universe
  created: "Neu angelegt",
  updated: "Aktualisiert",
  removed: "Entfernt",
  rejected: "Abgelehnt",
  ids: "Betroffene Instrumente",
  changed: "Geänderte Instrumente",
  proposalId: "Vorschlag (ID)",
};

/** Kurzer Kontext für ausgewählte Felder (Tooltip-Charakter). */
export const FIELD_HINTS: Record<string, string> = {
  latencyMs: "Zeit zwischen Prompt und fertiger Modellantwort.",
  riskScore: "Selbsteinschätzung des Modells (0 = harmlos, 1 = maximal riskant).",
  stopLossPct: "Abstand des Stop-Loss vom Einstieg in Prozent.",
  factor: "1,00 = volles Risiko. Werte unter 1 reduzieren das Risiko pro Trade.",
  signature: "Hash über Symbol + Bedingung + Aktion — macht Regeln idempotent.",
  clamped: "Der gewünschte Wert lag außerhalb der harten Grenzen und wurde angepasst.",
  evalMicros: "Reine Auswertezeit der Regel-Engine im Mikro-Executor.",
};

// ─────────────────────────────────────────────────────────────────────────────
// Event-Katalog
// ─────────────────────────────────────────────────────────────────────────────

export type AuditCategory = "agent" | "order" | "risk" | "mission" | "rule" | "system" | "universe";

type EventSpec = {
  label: string;
  description: string;
  category: AuditCategory;
  /** Erwartete Stufe — Abweichungen werden als Hinweis gekennzeichnet. */
  expectedLevel?: string;
  headline?: (d: Rec) => string;
  explain?: (d: Rec) => string | null;
  sections?: (d: Rec) => AuditSection[];
  check?: (d: Rec) => AuditIssue[];
};

const roleLabel = (value: unknown): string => {
  const key = text(value)?.toUpperCase();
  if (!key) return "unbekannte Rolle";
  return ROLE_LABELS[key] ? `${key} — ${ROLE_LABELS[key]}` : key;
};

const decisionLabel = (value: unknown): string => {
  const key = text(value)?.toUpperCase();
  return key ? (DECISION_LABELS[key] ?? key) : "keine Entscheidung";
};

const sourceLabel = (value: unknown): string => {
  const key = text(value);
  return key ? (SOURCE_LABELS[key] ?? key) : "nicht protokolliert";
};

const reasonLabel = (value: unknown): string => {
  const key = text(value)?.toUpperCase();
  return key ? (BLOCK_REASON_LABELS[key] ?? key) : "kein Grund angegeben";
};

const symbolOf = (d: Rec): string => text(d.symbol) ?? "";

/**
 * Modell-Tag lesbar machen: "qwen2.5:3b-instruct-q4_K_M" →
 * "qwen2.5:3b-instruct-q4_K_M (Qwen 2.5, 3 Mrd. Parameter, 4-Bit-Quantisierung)".
 * Unbekannte Tags bleiben unverändert — nichts wird erfunden.
 */
export function describeModel(tag: unknown): string | null {
  const raw = text(tag);
  if (!raw) return null;
  const [family, variant] = raw.split(":");
  if (!variant) return null;
  const size = variant.match(/(\d+(?:[.,]\d+)?)\s*b/i);
  const quant = variant.match(/q(\d)_?(\w+)/i);
  const parts: string[] = [];
  if (family) parts.push(`Familie ${family}`);
  if (size) parts.push(`${size[1].replace(".", ",")} Mrd. Parameter`);
  if (quant) parts.push(`${quant[1]}-Bit-Quantisierung`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * CEO-Rohantwort auswerten — auch wenn sie abgeschnitten protokolliert wurde.
 * Die Engine speichert nur die ersten 500 Zeichen; ein JSON.parse scheitert
 * dann. Deshalb zusätzlich eine fehlertolerante Regex-Suche nach verdict/reason.
 */
export function parseCeoVerdict(raw: unknown): {
  verdict: string | null;
  reason: string | null;
  rule: unknown;
  parseable: boolean;
  truncated: boolean;
} {
  const value = text(raw);
  if (!value) return { verdict: null, reason: null, rule: null, parseable: false, truncated: false };

  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) {
      return {
        verdict: text(parsed.verdict)?.toUpperCase() ?? null,
        reason: text(parsed.reason),
        rule: parsed.rule ?? null,
        parseable: true,
        truncated: false,
      };
    }
  } catch {
    /* abgeschnittene Antwort — Regex-Fallback unten */
  }

  const verdict = value.match(/"verdict"\s*:\s*\\?"?([A-Za-z_]+)\\?"?/)?.[1]?.toUpperCase() ?? null;
  const reasonMatch = value.match(/"reason"\s*:\s*\\?"((?:[^"\\]|\\.)*?)(?:\\?"|$)/);
  const reason = reasonMatch ? reasonMatch[1].replace(/\\(["\\/])/g, "$1") : null;
  const hasRule = /"rule"\s*:\s*null/.test(value);
  return {
    verdict,
    reason,
    rule: hasRule ? null : undefined,
    parseable: false,
    truncated: isTruncatedJson(value),
  };
}

/** Gemeinsamer Baustein: Fakten aus einem Record, mit Wörterbuch. */
function recordToFacts(source: Rec): AuditFact[] {
  const facts: AuditFact[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined) continue;
    if (isRecord(value) || (Array.isArray(value) && value.some(isRecord))) {
      // Verschachtelte Objekte bekommen eigene Sektionen (siehe genericSections).
      continue;
    }
    facts.push(factFor(key, value));
  }
  return facts;
}

function factFor(key: string, value: unknown): AuditFact {
  const label = FIELD_LABELS[key] ?? humanizeKey(key);
  const hint = FIELD_HINTS[key];
  const formatted = formatKnownValue(key, value);
  return { label, value: formatted, hint, mono: MONO_FIELDS.has(key), tone: toneForValue(key, value) };
}

const MONO_FIELDS = new Set([
  "ruleId", "ruleKey", "signature", "orderId", "proposalId", "missionId", "agentId",
  "model", "key", "previousVersionId", "ids",
]);

const TIME_FIELDS = new Set(["at", "timestamp", "createdAt"]);
/**
 * Anteile im Intervall [0,1] (0.02 = 2 %) — werden als Prozent angezeigt.
 * `stopLossPct` gehört bewusst NICHT dazu: die Engine speichert dort bereits
 * Prozentpunkte (5 = 5 %), eine Multiplikation würde 500 % anzeigen.
 */
const FRACTION_FIELDS = new Set([
  "riskBudget",
  "maxPositionPct",
  "drawdownPct",
  "dailyLossLimitPct",
  "baseMaxRiskPerTrade",
  "effectiveMaxRiskPerTrade",
]);
/** Bereits in Prozentpunkten gespeicherte Felder (5 = 5 %). */
const PERCENT_FIELDS = new Set(["stopLossPct"]);
const PRICE_FIELDS = new Set(["entry", "exit", "fillPrice", "stopLoss", "takeProfit", "triggerPrice", "limitPrice", "price"]);
const MONEY_FIELDS = new Set(["realizedPnl", "realizedToday", "dayPnl", "pnl", "riskNotional"]);

/** Formatierung nach Feldbedeutung — sonst landen rohe Zahlen in der UI. */
function formatKnownValue(key: string, value: unknown): string {
  if (typeof value === "boolean") return value ? "ja" : "nein";

  if (TIME_FIELDS.has(key)) {
    const raw = text(value);
    return raw ? formatTimestampUtc(raw) : String(value ?? "—");
  }

  const upperKey = key.toUpperCase();

  if (key === "side" || upperKey === "SIDE") {
    const code = text(value)?.toUpperCase();
    return code ? (SIDE_LABELS[code] ?? code) : "—";
  }
  if (key === "status") {
    const code = text(value)?.toUpperCase();
    return code ? (FILL_STATUS_LABELS[code] ?? code) : "—";
  }
  if (key === "type" && text(value)) {
    return decisionLabel(value);
  }
  if (key === "verdict" || key === "ceoVerdict") {
    const code = text(value)?.toUpperCase();
    return code ? (VERDICT_LABELS[code] ?? code) : "—";
  }
  if (key === "regime" || key === "prevRegime") {
    const code = text(value)?.toUpperCase();
    return code ? (REGIME_LABELS[code] ?? code) : "—";
  }
  if (key === "source" || key === "sourceMode" || key === "via" || key === "namespace") {
    const code = text(value);
    return code ? (SOURCE_LABELS[code] ?? code) : "—";
  }
  if (key === "role" || key === "sourceRole") return roleLabel(value);
  if (key === "model") {
    const raw = text(value);
    if (!raw) return "—";
    const described = describeModel(raw);
    return described ? `${raw} — ${described}` : raw;
  }
  if (key === "reason") {
    const code = text(value)?.toUpperCase();
    if (code && BLOCK_REASON_LABELS[code]) return `${BLOCK_REASON_LABELS[code]} (${code})`;
    return text(value) ?? String(value ?? "—");
  }
  if (key === "latencyMs") return formatDuration(num(value)) ?? "—";
  if (key === "evalMicros") {
    const micros = num(value);
    if (micros === null) return "—";
    return micros >= 1000 ? `${formatNumber(micros / 1000, 2)} ms` : `${Math.round(micros)} µs`;
  }
  if (key === "factor") {
    const factor = num(value);
    if (factor === null) return "—";
    const pct = Math.round((1 - factor) * 100);
    return factor >= 1
      ? `${formatNumber(factor, 2)}× — volles Risiko, keine Reduktion`
      : `${formatNumber(factor, 2)}× — Risiko um ${pct} % reduziert`;
  }
  if (FRACTION_FIELDS.has(key)) {
    const fraction = num(value);
    if (fraction === null) return "—";
    return `${formatNumber(fraction * 100, 2)} %`;
  }
  if (PERCENT_FIELDS.has(key)) {
    const percent = num(value);
    if (percent === null) return "—";
    return `${formatNumber(percent, 2)} %`;
  }
  if (key === "riskScore") {
    const score = num(value);
    if (score === null) return "—";
    return `${formatNumber(score, 2)} von 1,00`;
  }
  if (key === "qty") {
    const qty = num(value);
    return qty === null ? String(value ?? "—") : `${formatQuantity(qty)} Stück`;
  }
  if (key === "profitFactor") {
    const pf = num(value);
    if (pf === null) return "nicht berechnet (zu wenig Trades)";
    return `${formatNumber(pf, 2)} (> 1 = Gewinn erwirtschaftet)`;
  }
  if (PRICE_FIELDS.has(key)) {
    const price = num(value);
    return price === null ? String(value ?? "—") : `${formatQuantity(price)} USD`;
  }
  if (MONEY_FIELDS.has(key)) {
    const amount = num(value);
    return amount === null ? String(value ?? "—") : `${formatSigned(amount)} USD`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "keine";
    return value.map((item) => (isRecord(item) ? JSON.stringify(item) : String(item))).join(", ");
  }
  const str = text(value);
  return str ?? String(value ?? "—");
}

function toneForValue(key: string, value: unknown): FactTone | undefined {
  if (key === "status") {
    const code = text(value)?.toUpperCase();
    if (code === "FILLED" || code === "OPEN") return "good";
    if (code === "REJECTED" || code === "KILLED") return "bad";
  }
  if (MONEY_FIELDS.has(key)) {
    const amount = num(value);
    if (amount !== null) return amount > 0 ? "good" : amount < 0 ? "bad" : "neutral";
  }
  if (key === "clamped" && value === true) return "warn";
  return undefined;
}

/**
 * Generische Sektionen aus einem Detail-Objekt: flache Werte in die
 * Hauptsektion, verschachtelte Objekte/Arrays in eigene, überschriebene
 * Sektionen. So geht kein Feld verloren — auch nicht aus unbekannten Events.
 */
export function genericSections(detail: Rec, mainTitle = "Details"): AuditSection[] {
  const main: AuditFact[] = [];
  const nested: AuditSection[] = [];

  for (const [key, value] of Object.entries(detail)) {
    if (value === null || value === undefined) continue;
    if (isRecord(value)) {
      const facts = recordToFacts(value);
      nested.push({
        title: `${FIELD_LABELS[key] ?? humanizeKey(key)} (${key})`,
        facts: facts.length > 0 ? facts : [{ label: "Inhalt", value: "leeres Objekt" }],
      });
      // Verschachtelte Objekte zusätzlich vollständig ausweisen.
      continue;
    }
    if (Array.isArray(value)) {
      const objects = value.filter(isRecord);
      if (objects.length > 0) {
        objects.forEach((item, index) => {
          nested.push({
            title: `${FIELD_LABELS[key] ?? humanizeKey(key)} ${index + 1} von ${objects.length} (${key})`,
            facts: recordToFacts(item),
          });
        });
        const primitives = value.filter((item) => !isRecord(item));
        if (primitives.length > 0) main.push(factFor(key, primitives));
      } else if (value.length > 0) {
        main.push(factFor(key, value));
      } else {
        main.push({ label: FIELD_LABELS[key] ?? humanizeKey(key), value: "keine" });
      }
      continue;
    }
    main.push(factFor(key, value));
  }

  const sections: AuditSection[] = [];
  if (main.length > 0) sections.push({ title: mainTitle, facts: main });
  return [...sections, ...nested];
}

/** Kuratierte Sektionen; fehlende/unbekannte Felder werden ergänzt. */
function curatedSections(spec: EventSpec, detail: Rec): AuditSection[] {
  const curated = spec.sections ? spec.sections(detail) : [];
  if (curated.length === 0) return genericSections(detail);

  const covered = new Set<string>();
  for (const section of curated) for (const fact of section.facts) covered.add(fact.label);
  // Alles, was der Kurator nicht beschriftet hat, landet in "Weitere Felder".
  const rest = genericSections(detail, "Weitere protokollierte Felder");
  const remaining = rest
    .map((section) => ({ ...section, facts: section.facts.filter((fact) => !covered.has(fact.label)) }))
    .filter((section) => section.facts.length > 0);
  return [...curated, ...remaining];
}

function fillSection(fill: Rec, title = "Orderausführung (fill)"): AuditSection {
  const status = text(fill.status)?.toUpperCase();
  // H3: volles Order-Status-Spektrum (NEW → PARTIALLY_FILLED → FILLED | CANCELED
  // | REJECTED | UNKNOWN). NEW/UNKNOWN bedeuten: kein Fill — keine Position buchen.
  const statusNote =
    status === "REJECTED"
      ? "Der Broker hat den Auftrag nicht ausgeführt."
      : status === "NEW"
        ? "Vom Broker angenommen, aber noch kein Fill — es wurde keine Position eingebucht."
        : status === "PARTIALLY_FILLED"
          ? "Teilweise gefüllt — nur die gefüllte Menge mit echtem Durchschnittspreis verbuchen."
          : status === "CANCELED"
            ? "Der Auftrag wurde storniert."
            : status === "UNKNOWN"
              ? "Status unbekannt (z. B. Timeout) — wie kein Fill behandeln, kein 0-Einstieg."
              : undefined;
  const statusTone: FactTone | undefined =
    status === "FILLED"
      ? "good"
      : status === "REJECTED" || status === "CANCELED"
        ? "bad"
        : status === "NEW" || status === "UNKNOWN" || status === "PARTIALLY_FILLED"
          ? "warn"
          : undefined;
  return {
    title,
    note: statusNote,
    facts: [
      { label: "Symbol", value: text(fill.symbol) ?? "—" },
      { label: "Richtung", value: formatKnownValue("side", fill.side), tone: fill.side === "SHORT" ? "warn" : "good" },
      { label: "Menge", value: formatKnownValue("qty", fill.qty) },
      {
        label: "Status",
        value: formatKnownValue("status", status),
        tone: statusTone,
      },
      { label: "Füllpreis", value: formatKnownValue("fillPrice", fill.fillPrice) },
      { label: "Stop-Loss (Kurs)", value: formatKnownValue("stopLoss", fill.stopLoss) },
      { label: "Take-Profit (Kurs)", value: formatKnownValue("takeProfit", fill.takeProfit) },
      { label: "Order-ID", value: text(fill.orderId) ?? "—", mono: true },
      ...(num(fill.realizedPnl) !== null
        ? [
            {
              label: "Realisierter Gewinn/Verlust",
              value: formatKnownValue("realizedPnl", fill.realizedPnl),
              tone: toneForValue("realizedPnl", fill.realizedPnl) as FactTone,
            },
          ]
        : []),
      ...(text(fill.reason)
        ? [{ label: "Ablehnungsgrund", value: formatKnownValue("reason", fill.reason), tone: "bad" as FactTone }]
        : []),
    ],
  };
}

function orderSection(order: Rec): AuditSection {
  return {
    title: "Auftrag vor der Ausführung (order)",
    facts: [
      { label: "Symbol", value: text(order.symbol) ?? "—" },
      { label: "Richtung", value: formatKnownValue("side", order.side) },
      { label: "Menge", value: formatKnownValue("qty", order.qty) },
      { label: "Orderwert (Notional)", value: formatKnownValue("riskNotional", order.riskNotional) },
      { label: "Stop-Loss (Kurs)", value: formatKnownValue("stopLoss", order.stopLoss) },
      { label: "Take-Profit (Kurs)", value: formatKnownValue("takeProfit", order.takeProfit) },
    ],
  };
}

function decisionSection(decision: Rec): AuditSection {
  const facts: AuditFact[] = [
    { label: "Entscheidungstyp", value: decisionLabel(decision.type) },
  ];
  if (text(decision.symbol)) facts.push({ label: "Symbol", value: String(decision.symbol) });
  if (text(decision.side)) facts.push({ label: "Richtung", value: formatKnownValue("side", decision.side) });
  if (num(decision.stopLossPct) !== null) facts.push({ label: "Stop-Loss (%)", value: formatKnownValue("stopLossPct", decision.stopLossPct) });
  if (num(decision.riskScore) !== null) facts.push({ label: "Risiko-Score", value: formatKnownValue("riskScore", decision.riskScore), hint: FIELD_HINTS.riskScore });
  if (text(decision.reason)) facts.push({ label: "Begründung des Modells", value: String(decision.reason) });
  return { title: "Entscheidung (geparst)", facts };
}

function missionSection(detail: Rec): AuditSection {
  const facts: AuditFact[] = [];
  if (text(detail.title)) facts.push({ label: "Missionstitel", value: String(detail.title) });
  if (text(detail.symbol)) facts.push({ label: "Symbol", value: String(detail.symbol) });
  if (num(detail.riskBudget) !== null) facts.push({ label: "Risikobudget", value: formatKnownValue("riskBudget", detail.riskBudget), hint: "Anteil des Kontos, der pro Trade riskiert werden darf." });
  if (num(detail.maxPositionPct) !== null) facts.push({ label: "Max. Positionsgröße", value: formatKnownValue("maxPositionPct", detail.maxPositionPct) });
  if (text(detail.via)) facts.push({ label: "Quelle der Änderung", value: formatKnownValue("via", detail.via) });
  return { title: "Missionsdaten", facts };
}

// ── Katalog ─────────────────────────────────────────────────────────────────

export const AUDIT_EVENT_CATALOG: Record<string, EventSpec> = {
  AGENT_DECISION: {
    label: "Agent-Entscheidung",
    category: "agent",
    expectedLevel: "INFO",
    description:
      "Ein KI-Agent hat die Mission analysiert und eine Entscheidung abgegeben. Das ist ein Vorschlag: Ausgeführt wird er erst, wenn alle Guardrails (Not-Halt, Rollen-Mandat, Positionsgröße, Stop-Loss, Broker) zustimmen.",
    headline: (d) => {
      const decision = record(d.decision);
      const role = text(d.role)?.toUpperCase();
      const type = text(decision.type)?.toUpperCase();
      const symbol = text(decision.symbol);
      return [
        role ? `${role} entscheidet` : "Agent entscheidet",
        type ? (DECISION_LABELS[type]?.split(" — ")[0] ?? type) : "ohne Typ",
        symbol ? `für ${symbol}` : "",
      ]
        .filter(Boolean)
        .join(" ");
    },
    explain: (d) => {
      const decision = record(d.decision);
      const type = text(decision.type)?.toUpperCase();
      const source = sourceLabel(d.source);
      const latency = formatDuration(num(d.latencyMs));
      const parts = [`Quelle: ${source}`];
      if (latency) parts.push(`Antwortzeit ${latency}`);
      if (type === "TRADE") parts.push("Ein TRADE-Vorschlag wird anschließend von der Engine validiert — erst dann entsteht eine Order.");
      if (type === "HOLD") parts.push("Der Agent sieht kein tragfähiges Setup; es wird bewusst nicht gehandelt.");
      if (type === "KILL") parts.push("Der Agent hat den Not-Halt angefordert — die Positionen werden glattgestellt.");
      if (text(d.source)?.toLowerCase() === "fallback") {
        parts.push("Das lokale LLM war nicht erreichbar; die deterministische Regel-Engine hat entschieden.");
      }
      return parts.join(". ") + ".";
    },
    sections: (d) => {
      const sections: AuditSection[] = [
        {
          title: "Agent",
          facts: [
            { label: "Rolle", value: roleLabel(d.role) },
            { label: "KI-Modell", value: formatKnownValue("model", d.model), mono: true },
            ...(describeModel(d.model) ? [{ label: "Modell-Einordnung", value: describeModel(d.model) as string }] : []),
            { label: "Quelle", value: sourceLabel(d.source), hint: "ollama = lokales Modell, fallback = Regel-Engine ohne LLM." },
            { label: "Antwortzeit", value: formatDuration(num(d.latencyMs)) ?? "nicht protokolliert", hint: FIELD_HINTS.latencyMs },
          ],
        },
      ];
      if (isRecord(d.decision)) sections.push(decisionSection(record(d.decision)));
      return sections;
    },
    check: (d) => {
      const issues: AuditIssue[] = [];
      const decision = record(d.decision);
      const type = text(decision.type)?.toUpperCase();
      const role = text(d.role)?.toUpperCase();
      if (!type) {
        issues.push({
          severity: "warn",
          title: "Entscheidungstyp fehlt",
          detail:
            "Das Modell hat kein verwertbares {\"type\": …} geliefert. Die Engine behandelt das als HOLD — gehandelt wird nicht.",
        });
      }
      if (role && !(TRADING_ROLES as readonly string[]).includes(role) && type === "TRADE") {
        issues.push({
          severity: "info",
          title: `${role} darf nicht handeln`,
          detail:
            "Diese Rolle hat kein Handelsmandat — Orders auslösen dürfen ausschließlich Research und Executor. Der Vorschlag wird in Schicht 2 (Rollen-Prüfung) gestoppt und als ORDER_REJECTED protokolliert. Erwartetes Verhalten.",
        });
      }
      if (type === "KILL") {
        issues.push({
          severity: "warn",
          title: "Not-Halt angefordert",
          detail:
            "Ein Agent hat KILL entschieden. Bis zur manuellen Entschärfung werden keine Orders mehr ausgeführt — die Begründung des Modells sollte geprüft werden.",
        });
      }
      return issues;
    },
  },

  ORDER_SENT: {
    label: "Order ausgeführt",
    category: "order",
    expectedLevel: "INFO",
    description:
      "Der Broker hat den Auftrag angenommen und gefüllt. Die Position ist offen und wird ab jetzt vom Monitor überwacht (Stop-Loss / Take-Profit).",
    headline: (d) => {
      const fill = record(d.fill);
      const order = record(d.order);
      const side = text(fill.side)?.toUpperCase() ?? text(order.side)?.toUpperCase();
      const qty = num(fill.qty) ?? num(order.qty);
      const symbol = text(fill.symbol) ?? text(order.symbol) ?? "unbekanntes Symbol";
      const price = num(fill.fillPrice);
      return [
        side === "SHORT" ? "SHORT" : "LONG",
        qty !== null ? formatQuantity(qty) : "?",
        symbol,
        price !== null ? `@ ${formatQuantity(price)} USD` : "",
      ]
        .filter(Boolean)
        .join(" ");
    },
    explain: () =>
      "Der Auftrag hat alle fünf Schichten passiert (Not-Halt, Rollen-Mandat, Positionsgröße, Pflicht-Stop-Loss, Broker-Guardrails) und wurde gefüllt.",
    sections: (d) => {
      const sections: AuditSection[] = [];
      if (isRecord(d.fill)) sections.push(fillSection(record(d.fill)));
      if (isRecord(d.order)) sections.push(orderSection(record(d.order)));
      return sections;
    },
    check: (d) => {
      const fill = record(d.fill);
      const status = text(fill.status)?.toUpperCase();
      if (status && status !== "FILLED") {
        return [
          {
            severity: "error",
            title: "Widerspruch: Event meldet Ausführung, Fill ist nicht gefüllt",
            detail: `Das Event heißt ORDER_SENT, der Broker-Status lautet aber ${status}. Entweder wurde das falsche Event geschrieben oder die Fill-Verarbeitung ist fehlerhaft — das muss im Code geklärt werden.`,
          },
        ];
      }
      if (!isRecord(d.fill) && !isRecord(d.order)) {
        return [
          {
            severity: "warn",
            title: "Keine Orderdetails protokolliert",
            detail: "Weder Auftrag noch Ausführung sind gespeichert — der Trade ist nicht nachvollziehbar.",
          },
        ];
      }
      const stopLoss = num(record(d.fill).stopLoss) ?? num(record(d.order).stopLoss);
      if (stopLoss === null) {
        return [
          {
            severity: "warn",
            title: "Order ohne Stop-Loss ausgeführt",
            detail: "Der Stop-Loss ist Pflicht (RISK_LIMITS.requireStopLoss). Eine gefüllte Order ohne Stop-Loss deutet auf eine Lücke in der Validierung hin.",
          },
        ];
      }
      return [];
    },
  },

  ORDER_REJECTED: {
    label: "Order abgelehnt",
    category: "order",
    expectedLevel: "WARN",
    description:
      "Ein Auftrag wurde vor der Ausführung gestoppt. Ablehnungen sind im Normalfall KEIN Fehler: Sie belegen, dass eine Sicherheitsschicht gegriffen hat. Die Begründung entscheidet, ob Handlungsbedarf besteht.",
    headline: (d) => {
      const reason = reasonLabel(d.reason ?? record(d.fill).reason);
      const role = text(d.role)?.toUpperCase();
      return role ? `${reason} — ausgelöst von ${role}` : reason;
    },
    explain: (d) => {
      const code = text(d.reason)?.toUpperCase() ?? text(record(d.fill).reason)?.toUpperCase();
      if (code && BLOCK_REASON_EXPLANATIONS[code]) return BLOCK_REASON_EXPLANATIONS[code];
      if (code) return `Der Ablehnungsgrund ${code} ist im Regelkatalog der UI nicht hinterlegt — bitte prüfen, ob eine neue Guardrail ergänzt wurde.`;
      return "Kein Ablehnungsgrund protokolliert.";
    },
    sections: (d) => {
      const facts: AuditFact[] = [];
      const code = text(d.reason)?.toUpperCase() ?? text(record(d.fill).reason)?.toUpperCase();
      if (code) {
        facts.push({
          label: "Ablehnungsgrund",
          value: reasonLabel(code),
          tone: "bad",
          hint: BLOCK_REASON_EXPLANATIONS[code],
        });
      }
      if (text(d.role)) facts.push({ label: "Rolle", value: roleLabel(d.role) });
      if (num(d.dayPnl) !== null) facts.push({ label: "Tages-P&L", value: formatKnownValue("dayPnl", d.dayPnl) });
      if (num(d.consecLosses) !== null) facts.push({ label: "Verluste in Folge", value: formatKnownValue("consecLosses", d.consecLosses) });
      if (text(d.symbol)) facts.push({ label: "Symbol", value: String(d.symbol) });
      if (text(d.raw)) facts.push({ label: "Roheingabe des Modells", value: String(d.raw), mono: true });
      const sections: AuditSection[] = facts.length > 0 ? [{ title: "Ablehnung", facts }] : [];
      if (isRecord(d.fill)) sections.push(fillSection(record(d.fill)));
      if (isRecord(d.order)) sections.push(orderSection(record(d.order)));
      return sections;
    },
    check: (d) => {
      const issues: AuditIssue[] = [];
      const code = text(d.reason)?.toUpperCase() ?? text(record(d.fill).reason)?.toUpperCase();
      const role = text(d.role)?.toUpperCase();

      if (!code) {
        issues.push({
          severity: "warn",
          title: "Ablehnung ohne Grund",
          detail: "Ohne Grundcode ist nicht nachvollziehbar, welche Schicht blockiert hat.",
        });
      } else if (!BLOCK_REASON_LABELS[code]) {
        issues.push({
          severity: "warn",
          title: `Unbekannter Ablehnungsgrund ${code}`,
          detail: "Der Code steht nicht im Katalog der UI. Entweder wurde eine neue Guardrail ergänzt (Katalog nachziehen) oder der Grund ist falsch gesetzt.",
        });
      }

      if (code === "ROLE_NOT_ALLOWED_TO_TRADE") {
        if (role && (TRADING_ROLES as readonly string[]).includes(role)) {
          issues.push({
            severity: "error",
            title: `Widerspruch: ${role} IST handelsberechtigt`,
            detail:
              "Die Engine lehnt wegen fehlenden Mandats ab, obwohl Research und Executor handeln dürfen. Das deutet auf einen Fehler in der Rollen-Prüfung oder auf eine falsch gespeicherte Agentenrolle hin.",
          });
        } else if (role) {
          issues.push({
            severity: "info",
            title: "Korrekt nach Rollen-Mandat",
            detail: `${role} liefert Ideen, darf aber keine Orders geben. Die Pipeline delegiert die Ausführung an Research/Executor — kein Fehler.`,
          });
        }
      }
      return issues;
    },
  },

  TAKE_PROFIT_HIT: {
    label: "Take-Profit erreicht",
    category: "order",
    expectedLevel: "INFO",
    description:
      "Der Kurs hat das vorab festgelegte Gewinnziel erreicht. Der Monitor hat die Position automatisch geschlossen und den Gewinn realisiert.",
    headline: (d) => {
      const side = text(d.side)?.toUpperCase();
      const symbol = symbolOf(d);
      const entry = num(d.entry);
      const exit = num(d.exit);
      const pnl = num(d.realizedPnl);
      return [
        side ?? "Position",
        symbol,
        entry !== null && exit !== null ? `${formatQuantity(entry)} → ${formatQuantity(exit)}` : "",
        pnl !== null ? `${formatSigned(pnl)} USD` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    },
    explain: () =>
      "Geplanter Exit: Das Take-Profit-Ziel wurde im Markt erreicht, die Position ist geschlossen. Das ist der normale Gewinnpfad des Systems.",
    sections: (d) => [
      {
        title: "Positionsabschluss",
        facts: [
          { label: "Symbol", value: symbolOf(d) || "—" },
          { label: "Richtung", value: formatKnownValue("side", d.side) },
          { label: "Menge", value: formatKnownValue("qty", d.qty) },
          { label: "Einstiegskurs", value: formatKnownValue("entry", d.entry) },
          { label: "Ausstiegskurs", value: formatKnownValue("exit", d.exit) },
          { label: "Auslösekurs", value: formatKnownValue("triggerPrice", d.triggerPrice), hint: "Kurs des Ticks, der den Exit ausgelöst hat." },
          { label: "Realisierter Gewinn/Verlust", value: formatKnownValue("realizedPnl", d.realizedPnl), tone: (num(d.realizedPnl) ?? 0) >= 0 ? "good" : "bad" },
        ],
      },
    ],
    check: (d) => {
      const side = text(d.side)?.toUpperCase();
      const entry = num(d.entry);
      const exit = num(d.exit);
      const pnl = num(d.realizedPnl);
      if (side && entry !== null && exit !== null) {
        const profitable = side === "SHORT" ? exit < entry : exit > entry;
        if (!profitable) {
          return [
            {
              severity: "error",
              title: "Widerspruch: Take-Profit unter Einstieg",
              detail: `Bei ${side} liegt der Ausstieg (${formatQuantity(exit)}) nicht über dem Einstieg (${formatQuantity(entry)}). Ein Take-Profit-Exit in diese Richtung ist rechnerisch ein Verlust — Exit-Logik oder Preisquelle prüfen.`,
            },
          ];
        }
      }
      if (pnl !== null && pnl < 0) {
        return [
          {
            severity: "warn",
            title: "Take-Profit mit negativem Ergebnis",
            detail: `Realisiert wurden ${formatSigned(pnl)} USD (inkl. Gebühren/Slippage). Der Exit-Preis passte, die Kosten haben den Gewinn aufgezehrt.`,
          },
        ];
      }
      return [];
    },
  },

  STOP_LOSS_HIT: {
    label: "Stop-Loss ausgelöst",
    category: "order",
    expectedLevel: "INFO",
    description:
      "Der Kurs hat die Verlustgrenze erreicht. Der Monitor hat die Position automatisch glattgestellt — der Verlust ist einkalkuliert und Teil der Risikostrategie.",
    headline: (d) => {
      const side = text(d.side)?.toUpperCase();
      const symbol = symbolOf(d);
      const entry = num(d.entry);
      const exit = num(d.exit);
      const pnl = num(d.realizedPnl);
      return [
        side ?? "Position",
        symbol,
        entry !== null && exit !== null ? `${formatQuantity(entry)} → ${formatQuantity(exit)}` : "",
        pnl !== null ? `${formatSigned(pnl)} USD` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    },
    explain: () =>
      "Der Stop-Loss ist die Pflicht-Absicherung jeder Position. Dass er auslöst, ist erwartetes Verhalten und kein Fehler.",
    sections: (d) => [
      {
        title: "Positionsabschluss",
        facts: [
          { label: "Symbol", value: symbolOf(d) || "—" },
          { label: "Richtung", value: formatKnownValue("side", d.side) },
          { label: "Menge", value: formatKnownValue("qty", d.qty) },
          { label: "Einstiegskurs", value: formatKnownValue("entry", d.entry) },
          { label: "Ausstiegskurs", value: formatKnownValue("exit", d.exit) },
          { label: "Auslösekurs", value: formatKnownValue("triggerPrice", d.triggerPrice) },
          { label: "Realisierter Gewinn/Verlust", value: formatKnownValue("realizedPnl", d.realizedPnl), tone: "bad" },
        ],
      },
    ],
    check: (d) => {
      const side = text(d.side)?.toUpperCase();
      const entry = num(d.entry);
      const exit = num(d.exit);
      if (side && entry !== null && exit !== null) {
        const losing = side === "SHORT" ? exit > entry : exit < entry;
        if (!losing) {
          return [
            {
              severity: "error",
              title: "Widerspruch: Stop-Loss über Einstieg",
              detail: `Bei ${side} liegt der Ausstieg (${formatQuantity(exit)}) nicht unter dem Einstieg (${formatQuantity(entry)}). Ein Stop-Loss-Exit in diese Richtung wäre ein Gewinn — Exit-Logik prüfen.`,
            },
          ];
        }
      }
      return [];
    },
  },

  MISSION_CREATED: {
    label: "Mission erstellt",
    category: "mission",
    expectedLevel: "INFO",
    description:
      "Ein neuer Handelsauftrag (Mission) wurde angelegt. Missionen definieren Symbol, Ziel und Risikobudget — ohne aktive Mission handelt die Firma nicht.",
    headline: (d) => `„${text(d.title) ?? "ohne Titel"}“ · Quelle: ${sourceLabel(d.via)}`,
    explain: () => "Die Mission liegt jetzt im Backlog und wird von der Pipeline bzw. vom Makro-Zyklus bearbeitet.",
    sections: (d) => [missionSection(d)],
  },

  MISSION_UPDATED: {
    label: "Mission aktualisiert",
    category: "mission",
    expectedLevel: "INFO",
    description: "Eine bestehende Mission wurde geändert (Titel, Ziel, Symbol, Risikobudget oder Status).",
    headline: (d) => `„${text(d.title) ?? "ohne Titel"}“ · Quelle: ${sourceLabel(d.via)}`,
    explain: () => "Änderungen wirken sofort auf nachfolgende Läufe; bereits offene Positionen bleiben unberührt.",
    sections: (d) => [missionSection(d)],
  },

  RULE_MACRO_REJECTED: {
    label: "Makro-Regel abgelehnt",
    category: "rule",
    expectedLevel: "WARN",
    description:
      "Der CEO-Agent hat einen Regelentwurf des Research-Agenten abgelehnt. Die Regel wird NICHT aktiviert. Fail-safe: Ist die CEO-Antwort nicht auswertbar, gilt automatisch REJECT.",
    headline: (d) => {
      const parsed = parseCeoVerdict(d.ceoRaw);
      const verdict = text(d.ceoVerdict)?.toUpperCase() ?? parsed.verdict;
      const symbol = symbolOf(d);
      return [
        "CEO lehnt Regel",
        symbol ? `für ${symbol}` : "",
        verdict ? `(Verdikt: ${verdict})` : "",
      ]
        .filter(Boolean)
        .join(" ");
    },
    explain: (d) => {
      const parsed = parseCeoVerdict(d.ceoRaw);
      if (parsed.reason) return `Begründung des CEO: ${parsed.reason}`;
      if (text(d.reason)) return `Begründung des CEO: ${text(d.reason)}`;
      if (parsed.truncated) return "Die CEO-Antwort wurde gekürzt protokolliert (max. 500 Zeichen); die vollständige Antwort steht im Protokoll des Agenten-Turns.";
      return "Keine Begründung ausgewertet — es greift das Fail-safe-Verdikt REJECT.";
    },
    sections: (d) => {
      const parsed = parseCeoVerdict(d.ceoRaw);
      const facts: AuditFact[] = [];
      if (symbolOf(d)) facts.push({ label: "Symbol", value: symbolOf(d) });
      if (parsed.verdict) facts.push({ label: "CEO-Verdikt", value: formatKnownValue("verdict", parsed.verdict), tone: "bad" });
      if (parsed.reason) facts.push({ label: "Begründung des CEO", value: parsed.reason });
      if (text(d.reason) && text(d.reason) !== parsed.reason) facts.push({ label: "Protokollierter Grund", value: String(d.reason) });
      facts.push({
        label: "Auswertbarkeit der CEO-Antwort",
        value: parsed.parseable ? "vollständig als JSON lesbar" : parsed.truncated ? "gekürzt gespeichert — teilweise lesbar" : "nicht als JSON lesbar",
        tone: parsed.parseable ? "good" : "warn",
        hint: "Die Engine speichert Modellantworten begrenzt; das Fail-safe-Verdikt REJECT schützt vor unverstandenen Antworten.",
      });
      if (parsed.rule !== undefined) {
        facts.push({ label: "Mitgelieferte Regel", value: parsed.rule === null ? "keine" : JSON.stringify(parsed.rule), mono: true });
      }
      return [{ title: "CEO-Entscheidung", facts }];
    },
    check: (d) => {
      const parsed = parseCeoVerdict(d.ceoRaw);
      const issues: AuditIssue[] = [];
      if (!parsed.verdict) {
        issues.push({
          severity: "warn",
          title: "CEO-Antwort nicht auswertbar",
          detail: "Aus der Rohantwort ließ sich kein Verdikt lesen. Die Engine wertet das als REJECT (Fail-safe) — die Regel bleibt inaktiv, es entsteht kein Risiko.",
        });
      } else if (parsed.verdict !== "REJECT") {
        issues.push({
          severity: "error",
          title: `Widerspruch: Verdikt ${parsed.verdict} protokolliert als Ablehnung`,
          detail: "Die CEO-Antwort enthält kein REJECT, das Event lautet aber RULE_MACRO_REJECTED. Die Verdikt-Auswertung im Makro-Zyklus prüfen.",
        });
      }
      if (parsed.truncated) {
        issues.push({
          severity: "info",
          title: "Antwort gekürzt protokolliert",
          detail: "Die Engine speichert nur die ersten 500 Zeichen der CEO-Antwort. Für die vollständige Antwort den Agenten-Turn im Protokoll öffnen.",
        });
      }
      return issues;
    },
  },

  RULE_MACRO_CYCLE: {
    label: "Makro-Zyklus abgeschlossen",
    category: "rule",
    expectedLevel: "INFO",
    description:
      "Der Makro-Zyklus (Research → CEO → Risiko-Gate → Persistierung) ist erfolgreich durchgelaufen und hat eine Regelversion erzeugt.",
    headline: (d) => {
      const symbol = symbolOf(d);
      const version = num(d.version);
      const status = text(d.status);
      return [
        "Regel",
        symbol ? `für ${symbol}` : "",
        version !== null ? `v${version}` : "",
        status ? `(${status})` : "",
      ]
        .filter(Boolean)
        .join(" ");
    },
    explain: (d) => {
      const verdict = text(d.ceoVerdict)?.toUpperCase();
      return verdict ? `CEO-Verdikt: ${formatKnownValue("verdict", verdict)}.` : "Der Zyklus wurde ohne CEO-Verdikt protokolliert.";
    },
    sections: (d) => [
      {
        title: "Regelstand",
        facts: [
          { label: "Symbol", value: symbolOf(d) || "—" },
          { label: "Regel-ID", value: text(d.ruleId) ?? "—", mono: true },
          { label: "Version", value: num(d.version) !== null ? `v${num(d.version)}` : "—" },
          { label: "Status", value: text(d.status) ?? "—" },
          { label: "Entstehung", value: formatKnownValue("sourceMode", d.sourceMode) },
          { label: "CEO-Verdikt", value: formatKnownValue("verdict", d.ceoVerdict) },
          { label: "Signatur", value: text(d.signature) ?? "—", mono: true, hint: FIELD_HINTS.signature },
          { label: "Hinweise", value: formatKnownValue("warnings", d.warnings) },
        ],
      },
    ],
  },

  RULE_RISK_GATE: {
    label: "Risiko-Gate blockiert Regel",
    category: "rule",
    expectedLevel: "WARN",
    description:
      "Eine Regel wurde vom harten Risiko-Gate gestoppt — unabhängig vom LLM. Diese Schicht kann kein Modell überstimmen.",
    headline: (d) => `Regel für ${symbolOf(d) || "unbekanntes Symbol"} blockiert`,
    explain: (d) => {
      const reasons = Array.isArray(d.reasons) ? d.reasons.map(String) : [];
      return reasons.length > 0 ? `Blockierende Gründe: ${reasons.join("; ")}.` : "Keine Gründe protokolliert.";
    },
    sections: (d) => [
      {
        title: "Gate-Prüfung",
        facts: [
          { label: "Symbol", value: symbolOf(d) || "—" },
          { label: "Gründe", value: formatKnownValue("reasons", d.reasons), tone: "bad" },
          { label: "Signatur", value: text(d.signature) ?? "—", mono: true },
        ],
      },
    ],
  },

  RULE_MACRO_ERROR: {
    label: "Fehler im Makro-Zyklus",
    category: "rule",
    expectedLevel: "CRITICAL",
    description: "Der Makro-Zyklus ist mit einer Ausnahme abgebrochen. Es wurde keine Regel angelegt oder geändert.",
    headline: (d) => text(d.message)?.slice(0, 120) ?? "Unbekannter Fehler",
    explain: () => "Der Zyklus ist fehlgeschlagen, nicht blockiert. Die Ursache steht in der Fehlermeldung; die Regelbasis bleibt unverändert.",
    sections: (d) => [{ title: "Fehler", facts: [{ label: "Fehlermeldung", value: text(d.message) ?? "keine Angabe", tone: "bad" }] }],
    check: (d) =>
      text(d.message)
        ? []
        : [{ severity: "warn", title: "Fehler ohne Meldung", detail: "Ohne Meldung ist die Ursache nicht diagnostizierbar — Logging prüfen." }],
  },

  RULE_CREATED: {
    label: "Regel angelegt",
    category: "rule",
    expectedLevel: "INFO",
    description: "Eine neue Regelversion wurde als Entwurf (DRAFT) persistiert. Regeln sind unveränderlich — jede Änderung erzeugt eine neue Version.",
    headline: (d) => `${symbolOf(d) || "Regel"} v${num(d.version) ?? "?"} angelegt`,
    sections: (d) => [
      {
        title: "Regelversion",
        facts: [
          { label: "Symbol", value: symbolOf(d) || "—" },
          { label: "Regel-ID", value: text(d.ruleId) ?? "—", mono: true },
          { label: "Regel-Familie (ruleKey)", value: text(d.ruleKey) ?? "—", mono: true },
          { label: "Version", value: num(d.version) !== null ? `v${num(d.version)}` : "—" },
          { label: "Erstellt von (Rolle)", value: roleLabel(d.sourceRole) },
          { label: "Entstehung", value: formatKnownValue("sourceMode", d.sourceMode) },
          { label: "Signatur", value: text(d.signature) ?? "—", mono: true },
        ],
      },
    ],
  },

  RULE_ACTIVATED: {
    label: "Regel aktiviert",
    category: "rule",
    expectedLevel: "WARN",
    description:
      "Eine Regelversion wurde scharf geschaltet. Der Mikro-Executor handelt ab jetzt nach ihr; ältere Versionen desselben Symbols werden ersetzt (superseded).",
    headline: (d) => `${symbolOf(d) || "Regel"} v${num(d.version) ?? "?"} aktiv`,
    explain: (d) => {
      const by = text(d.by);
      const superseded = Array.isArray(d.superseded) ? d.superseded : [];
      return [
        by ? `Aktiviert von ${by}.` : null,
        superseded.length > 0 ? `${superseded.length} ältere Version(en) ersetzt.` : null,
      ]
        .filter(Boolean)
        .join(" ");
    },
    sections: (d) => [
      {
        title: "Aktivierung",
        facts: [
          { label: "Symbol", value: symbolOf(d) || "—" },
          { label: "Regel-ID", value: text(d.ruleId) ?? "—", mono: true },
          { label: "Version", value: num(d.version) !== null ? `v${num(d.version)}` : "—" },
          { label: "Ausgelöst von", value: text(d.by) ?? "—" },
          { label: "Ersetzte Versionen", value: formatKnownValue("superseded", d.superseded), mono: true },
        ],
      },
    ],
  },

  RULE_PAUSED: {
    label: "Regel pausiert",
    category: "rule",
    expectedLevel: "WARN",
    description: "Eine aktive Regel wurde pausiert. Der Mikro-Executor überspringt sie, bis sie wieder aktiviert wird.",
    headline: (d) => `Regel v${num(d.version) ?? "?"} pausiert`,
    sections: (d) => [
      {
        title: "Pause",
        facts: [
          { label: "Regel-ID", value: text(d.ruleId) ?? "—", mono: true },
          { label: "Version", value: num(d.version) !== null ? `v${num(d.version)}` : "—" },
          { label: "Ausgelöst von", value: text(d.by) ?? "—" },
        ],
      },
    ],
  },

  RULE_ARCHIVED: {
    label: "Regel archiviert",
    category: "rule",
    expectedLevel: "INFO",
    description: "Eine Regel wurde endgültig archiviert und nimmt nicht mehr am Handel teil. Die Historie bleibt erhalten.",
    headline: (d) => `Regel v${num(d.version) ?? "?"} archiviert`,
    sections: (d) => [
      {
        title: "Archivierung",
        facts: [
          { label: "Regel-ID", value: text(d.ruleId) ?? "—", mono: true },
          { label: "Version", value: num(d.version) !== null ? `v${num(d.version)}` : "—" },
          { label: "Ausgelöst von", value: text(d.by) ?? "—" },
        ],
      },
    ],
  },

  RULE_REJECTED: {
    label: "Regel zurückgewiesen",
    category: "rule",
    expectedLevel: "WARN",
    description: "Eine Regelversion wurde nachträglich zurückgewiesen (z. B. nach Review) und nimmt nicht am Handel teil.",
    headline: (d) => `Regel v${num(d.version) ?? "?"} zurückgewiesen`,
    sections: (d) => [
      {
        title: "Zurückweisung",
        facts: [
          { label: "Regel-ID", value: text(d.ruleId) ?? "—", mono: true },
          { label: "Version", value: num(d.version) !== null ? `v${num(d.version)}` : "—" },
          { label: "Grund", value: text(d.reason) ?? "—" },
          { label: "Ausgelöst von", value: text(d.by) ?? "—" },
        ],
      },
    ],
  },

  RULE_ROLLED_BACK: {
    label: "Regel-Rollback",
    category: "rule",
    expectedLevel: "CRITICAL",
    description: "Eine aktive Regelversion wurde zurückgenommen und durch die vorherige Version ersetzt.",
    headline: (d) => `Rollback ${text(d.version) ?? ""}`.trim(),
    sections: (d) => [
      {
        title: "Rollback",
        facts: [
          { label: "Von Version (ID)", value: text(d.from) ?? "—", mono: true },
          { label: "Auf Version (ID)", value: text(d.to) ?? "—", mono: true },
          { label: "Versionswechsel", value: text(d.version) ?? "—" },
          { label: "Ausgelöst von", value: text(d.by) ?? "—" },
        ],
      },
    ],
  },

  RULE_TRIGGERED: {
    label: "Regel ausgelöst",
    category: "rule",
    expectedLevel: "INFO",
    description: "Der Mikro-Executor hat eine aktive Regel ausgewertet, sie hat ausgelöst und eine Order erzeugt.",
    headline: (d) => `${symbolOf(d) || "Symbol"} @ ${formatKnownValue("price", d.price)}`,
    explain: (d) => {
      const micros = num(d.evalMicros);
      return micros !== null
        ? `Die Regelauswertung dauerte ${formatKnownValue("evalMicros", micros)} — der Executor läuft als separater Prozess ohne LLM.`
        : "Der Executor arbeitet deterministisch und ohne LLM-Aufruf.";
    },
    sections: (d) => [
      {
        title: "Auslösung",
        facts: [
          { label: "Symbol", value: symbolOf(d) || "—" },
          { label: "Regel-ID", value: text(d.ruleId) ?? "—", mono: true },
          { label: "Version", value: num(d.version) !== null ? `v${num(d.version)}` : "—" },
          { label: "Kurs", value: formatKnownValue("price", d.price) },
          { label: "Order-ID", value: text(d.orderId) ?? "—", mono: true },
          { label: "Auswertedauer", value: formatKnownValue("evalMicros", d.evalMicros), hint: FIELD_HINTS.evalMicros },
          { label: "Prozess neu gestartet", value: formatKnownValue("startedProcess", d.startedProcess) },
        ],
      },
    ],
  },

  RULE_BACKTESTED: {
    label: "Regel zurückgetestet",
    category: "rule",
    expectedLevel: "INFO",
    description: "Eine Regel wurde gegen historische Daten getestet. Das Ergebnis ist eine Entscheidungsgrundlage, keine Handelsgarantie.",
    headline: (d) => {
      const trades = num(d.trades);
      const pnl = num(d.pnl);
      return [
        symbolOf(d) || "Regel",
        trades !== null ? `${trades} Trades` : "ohne Trades",
        pnl !== null ? `${formatSigned(pnl)} USD` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    },
    sections: (d) => [
      {
        title: "Backtest-Ergebnis",
        facts: [
          { label: "Symbol", value: symbolOf(d) || "—" },
          { label: "Regel-ID", value: text(d.ruleId) ?? "—", mono: true },
          { label: "Anzahl Trades", value: num(d.trades) !== null ? String(num(d.trades)) : "—" },
          { label: "Gewinn/Verlust", value: formatKnownValue("pnl", d.pnl), tone: toneForValue("pnl", d.pnl) },
          { label: "Profit-Faktor", value: formatKnownValue("profitFactor", d.profitFactor) },
        ],
      },
    ],
    check: (d) => {
      const trades = num(d.trades);
      if (trades !== null && trades < 10) {
        return [
          {
            severity: "info",
            title: "Wenige Trades im Testzeitraum",
            detail: `Nur ${trades} Trades — die Kennzahlen (Profit-Faktor, Trefferquote) sind statistisch nicht belastbar.`,
          },
        ];
      }
      return [];
    },
  },

  RISK_ADAPTIVE: {
    label: "Risiko angepasst",
    category: "risk",
    expectedLevel: "INFO",
    description:
      "Das adaptive Risikosystem hat den Marktzustand bewertet und das Risiko pro Trade angepasst. Es reduziert bei erhöhter Volatilität — erhöhen kann es nie.",
    headline: (d) => {
      const factor = num(d.factor);
      const regime = text(d.regime)?.toUpperCase();
      const prev = text(d.prevRegime)?.toUpperCase();
      return [
        prev && regime && prev !== regime ? `${prev} → ${regime}` : regime ? `Regime ${regime}` : "",
        factor !== null ? formatKnownValue("factor", factor) : "",
      ]
        .filter(Boolean)
        .join(" · ");
    },
    explain: (d) => {
      const factor = num(d.factor);
      const reason = text(d.reason);
      const parts: string[] = [];
      if (factor !== null && factor >= 1) parts.push("Keine Reduktion: Der Markt gilt als ruhig (Regime NORMAL), das volle Risikobudget bleibt bestehen.");
      else if (factor !== null) parts.push(`Das Risikobudget pro Trade wurde auf ${Math.round(factor * 100)} % des Basiswerts gesenkt.`);
      if (reason) parts.push(`Auslöser: ${reason}`);
      return parts.length > 0 ? `${parts.join(" ")} ` : "Keine Bewertung protokolliert.";
    },
    sections: (d) => [
      {
        title: "Risikobewertung",
        facts: [
          { label: "Zeitpunkt", value: formatTimestampUtc(text(d.at)) },
          { label: "Vorheriges Regime", value: formatKnownValue("prevRegime", d.prevRegime) },
          { label: "Volatilitäts-Regime", value: formatKnownValue("regime", d.regime) },
          { label: "Risiko-Multiplikator", value: formatKnownValue("factor", d.factor), hint: FIELD_HINTS.factor },
          { label: "Basis-Risiko pro Trade", value: formatKnownValue("baseMaxRiskPerTrade", d.baseMaxRiskPerTrade), hint: "Konfiguriertes Limit ohne Volatilitätsanpassung." },
          { label: "Wirksames Risiko pro Trade", value: formatKnownValue("effectiveMaxRiskPerTrade", d.effectiveMaxRiskPerTrade), hint: "Das tatsächlich geltende Limit für neue Orders." },
          { label: "Ausgelöste Indikatoren", value: formatKnownValue("triggered", d.triggered) },
          { label: "Begründung", value: text(d.reason) ?? "—" },
        ],
      },
    ],
    check: (d) => {
      const issues: AuditIssue[] = [];
      const factor = num(d.factor);
      const regime = text(d.regime)?.toUpperCase();
      if (factor !== null && factor > 1) {
        issues.push({
          severity: "error",
          title: "Widerspruch: Risiko erhöht",
          detail: `Faktor ${formatNumber(factor, 2)}× übersteigt 1,00. Das adaptive System darf Risiken nur senken (Grenzen 0,02–1,00) — Konfiguration oder Klemmung prüfen.`,
        });
      }
      if (factor !== null && factor >= 1 && regime && regime !== "NORMAL") {
        issues.push({
          severity: "warn",
          title: `Regime ${regime}, aber keine Reduktion`,
          detail: "Bei ELEVATED/EXTREME erwartet man einen Faktor unter 1. Vermutlich sind die Faktoren in der Konfiguration auf 1,00 gesetzt.",
        });
      }
      const triggered = Array.isArray(d.triggered) ? d.triggered : [];
      if (regime && regime !== "NORMAL" && triggered.length === 0 && text(d.reason) === null) {
        issues.push({
          severity: "info",
          title: "Regime ohne nachvollziehbaren Auslöser",
          detail: "Weder Indikatoren noch eine Begründung sind protokolliert — die Bewertung ist nicht rekonstruierbar.",
        });
      }
      return issues;
    },
  },

  KILL_SWITCH: {
    label: "Not-Halt ausgelöst",
    category: "risk",
    expectedLevel: "CRITICAL",
    description:
      "Der Not-Halt (Kill-Switch) ist scharf. Es wird keine Order mehr ausgeführt, bis ein Mensch ihn bewusst entschärft. Das ist die härteste Sicherheitsschicht des Systems.",
    headline: (d) => {
      const reason = text(d.reason);
      const by = text(d.by);
      if (reason) return `Grund: ${reasonLabel(reason)}`;
      if (by) return `Ausgelöst von ${by}`;
      if (num(d.drawdownPct) !== null) return `Drawdown ${formatKnownValue("drawdownPct", d.drawdownPct)}`;
      return "Not-Halt aktiv";
    },
    explain: (d) => {
      const reason = text(d.reason)?.toUpperCase();
      if (reason && BLOCK_REASON_EXPLANATIONS[reason]) return BLOCK_REASON_EXPLANATIONS[reason];
      if (num(d.drawdownPct) !== null) return "Der Drawdown hat die konfigurierte Grenze überschritten; das System schützt das verbleibende Kapital.";
      return "Der Not-Halt wurde ausgelöst — Handeln ist erst nach manueller Entschärfung wieder möglich.";
    },
    sections: (d) => [
      {
        title: "Not-Halt",
        facts: [
          { label: "Grund", value: text(d.reason) ? reasonLabel(d.reason) : "nicht angegeben" },
          { label: "Ausgelöst von", value: text(d.by) ?? "System" },
          ...(num(d.drawdownPct) !== null ? [{ label: "Drawdown", value: formatKnownValue("drawdownPct", d.drawdownPct) }] : []),
          ...(num(d.realizedToday) !== null ? [{ label: "Realisierter Tages-P&L", value: formatKnownValue("realizedToday", d.realizedToday), tone: "bad" as FactTone }] : []),
          ...(num(d.dailyLossLimitPct) !== null ? [{ label: "Tagesverlust-Limit", value: formatKnownValue("dailyLossLimitPct", d.dailyLossLimitPct) }] : []),
          ...(num(d.equity) !== null
            ? [{ label: "Kontostand (Equity)", value: `${formatQuantity(num(d.equity) as number)} USD` }]
            : []),
          ...(typeof d.flatten === "boolean" ? [{ label: "Positionen glattgestellt", value: formatKnownValue("flatten", d.flatten) }] : []),
        ],
      },
    ],
  },

  KILL_SWITCH_DISARMED: {
    label: "Not-Halt entschärft",
    category: "risk",
    expectedLevel: "WARN",
    description: "Ein Mensch hat den Not-Halt bewusst entschärft. Die Firma darf wieder handeln — dieser Schritt wird revisionssicher protokolliert.",
    headline: (d) => (text(d.reason) ? `Begründung: ${text(d.reason)}` : "ohne Begründung"),
    sections: (d) => [{ title: "Entschärfung", facts: [{ label: "Begründung", value: text(d.reason) ?? "nicht angegeben" }] }],
  },

  FLATTEN_ALL: {
    label: "Alle Positionen glattgestellt",
    category: "risk",
    expectedLevel: "CRITICAL",
    description: "Alle offenen Positionen wurden geschlossen (Notfall-Runbook oder Not-Halt mit Flatten).",
    headline: (d) => `${num(d.closed) ?? 0} Position(en) geschlossen`,
    sections: (d) => {
      const sections: AuditSection[] = [
        {
          title: "Glattstellung",
          facts: [
            { label: "Grund", value: text(d.reason) ?? "nicht angegeben" },
            { label: "Geschlossene Positionen", value: num(d.closed) !== null ? String(num(d.closed)) : "—" },
          ],
        },
      ];
      const fills = Array.isArray(d.fills) ? d.fills.filter(isRecord) : [];
      fills.forEach((fill, index) => {
        sections.push(fillSection(fill, `Geschlossene Position ${index + 1} von ${fills.length} (fills)`));
      });
      return sections;
    },
  },

  APPROVAL_REQUIRED: {
    label: "Freigabe erforderlich",
    category: "order",
    expectedLevel: "WARN",
    description:
      "REQUIRE_HUMAN_APPROVAL ist aktiv: Die Order liegt als Vorschlag und wartet auf die Freigabe eines Menschen. Ohne Freigabe wird nicht gehandelt.",
    headline: (d) => {
      const order = record(d.order);
      return [
        text(order.symbol) ?? "Order",
        text(order.side)?.toUpperCase() ?? "",
        num(order.qty) !== null ? formatQuantity(num(order.qty) as number) : "",
      ]
        .filter(Boolean)
        .join(" ");
    },
    sections: (d) => {
      const sections: AuditSection[] = [
        { title: "Freigabe", facts: [{ label: "Vorschlag (ID)", value: text(d.proposalId) ?? "—", mono: true }] },
      ];
      if (isRecord(d.order)) sections.push(orderSection(record(d.order)));
      return sections;
    },
  },

  CONFIG_CHANGED: {
    label: "Konfiguration geändert",
    category: "system",
    expectedLevel: "WARN",
    description:
      "Ein Risiko- oder Volatilitätsparameter wurde geändert. Änderungen sind begrenzt (harte Obergrenzen im Code) und werden revisionssicher protokolliert.",
    headline: (d) => `${text(d.key) ?? "Parameter"}: ${formatKnownValue("before", d.before)} → ${formatKnownValue("after", d.after)}`,
    explain: (d) => {
      const clamped = d.clamped === true || d.clamped === "true";
      return clamped
        ? "Der angefragte Wert lag außerhalb der harten Grenzen und wurde auf den erlaubten Wert geklemmt."
        : "Der neue Wert gilt ab dem nächsten Lauf; offene Positionen werden nicht nachträglich verändert.";
    },
    sections: (d) => [
      {
        title: "Änderung",
        facts: [
          { label: "Konfigurationsschlüssel", value: text(d.key) ?? "—", mono: true },
          { label: "Namensraum", value: formatKnownValue("namespace", d.namespace) },
          { label: "Wert vorher", value: formatKnownValue("before", d.before) },
          { label: "Wert nachher", value: formatKnownValue("after", d.after) },
          ...(d.effective !== undefined ? [{ label: "Wirksamer Wert", value: formatKnownValue("effective", d.effective) }] : []),
          { label: "Angefragter Wert", value: formatKnownValue("requested", d.requested) },
          { label: "Auf Grenzwert geklemmt", value: formatKnownValue("clamped", d.clamped), tone: d.clamped === true ? ("warn" as FactTone) : undefined },
          { label: "Quelle der Änderung", value: formatKnownValue("source", d.source) },
        ],
      },
    ],
    check: (d) =>
      text(d.key) && text(d.before) !== null && text(d.after) !== null && String(d.before) === String(d.after)
        ? [
            {
              severity: "info",
              title: "Keine tatsächliche Änderung",
              detail: "Vorher- und Nachher-Wert sind identisch; der Eintrag ist nur eine Bestätigung.",
            },
          ]
        : [],
  },

  AGENT_PROMPT_UPDATED: {
    label: "Agenten-Prompt geändert",
    category: "agent",
    expectedLevel: "INFO",
    description: "Der System-Prompt eines Agenten wurde im Workshop geändert. Prompt-Änderungen verändern das Verhalten aller folgenden Entscheidungen.",
    headline: (d) => `${text(d.agent) ?? "Agent"} (${text(d.role) ?? "Rolle"}) — Prompt angepasst`,
    sections: (d) => [
      {
        title: "Prompt-Änderung",
        facts: [
          { label: "Agent", value: text(d.agent) ?? "—" },
          { label: "Rolle", value: roleLabel(d.role) },
          { label: "Prompt-Länge vorher (Zeichen)", value: num(d.oldLength) !== null ? String(num(d.oldLength)) : "—" },
          { label: "Prompt-Länge nachher (Zeichen)", value: num(d.newLength) !== null ? String(num(d.newLength)) : "—" },
          { label: "Quelle der Änderung", value: formatKnownValue("via", d.via) },
        ],
      },
    ],
  },

  ERROR: {
    label: "Lauf fehlgeschlagen",
    category: "system",
    expectedLevel: "CRITICAL",
    description:
      "Ein Lauf (gesamte Pipeline oder einzelner Agent) ist mit einer Ausnahme abgebrochen. Es wurde keine Order ausgeführt; offene Positionen bleiben unverändert.",
    headline: (d) => firstSentence(text(d.message) ?? "Unbekannter Fehler", 120),
    explain: (d) => {
      const scope = text(d.scope);
      return scope
        ? `Der Fehler trat im Bereich „${scope}“ auf. Ein Abbruch ist kein Block: Die Ursache steht in der Fehlermeldung, die Handelslogik wurde nicht umgangen.`
        : "Ein Abbruch ist kein Block: Die Ursache steht in der Fehlermeldung, die Handelslogik wurde nicht umgangen.";
    },
    sections: (d) => [
      {
        title: "Fehler",
        facts: [
          { label: "Fehlermeldung", value: text(d.message) ?? "keine Angabe", tone: "bad" },
          { label: "Betroffener Bereich", value: text(d.scope) ?? (text(d.agentId) ? "Agenten-Lauf" : "nicht angegeben") },
          { label: "Agent (ID)", value: text(d.agentId) ?? "—", mono: true },
        ],
      },
    ],
    check: (d) =>
      text(d.message)
        ? []
        : [{ severity: "warn", title: "Fehler ohne Meldung", detail: "Ohne Meldung ist die Ursache nicht diagnostizierbar — Logging prüfen." }],
  },

  UNIVERSE_MUTATION: {
    label: "Marktuniversum geändert",
    category: "universe",
    expectedLevel: "INFO",
    description:
      "Die Instrumenten-Registry wurde geändert (Instrumente angelegt, aktualisiert oder entfernt). Das Universum definiert, welche Märkte die Firma überhaupt kennt.",
    headline: (d) => {
      const created = num(d.created) ?? 0;
      const updated = num(d.updated) ?? 0;
      const removed = num(d.removed) ?? 0;
      return `${text(d.action) ?? "Änderung"}: ${created} neu, ${updated} aktualisiert, ${removed} entfernt`;
    },
    sections: (d) => [
      {
        title: "Registry-Änderung",
        facts: [
          { label: "Aktion", value: text(d.action) ?? "—" },
          { label: "Quelle", value: text(d.source) ?? "—" },
          { label: "Akteur", value: text(d.actor) ?? "system" },
          { label: "Neu angelegt", value: num(d.created) !== null ? String(num(d.created)) : "0" },
          { label: "Aktualisiert", value: num(d.updated) !== null ? String(num(d.updated)) : "0" },
          { label: "Entfernt", value: num(d.removed) !== null ? String(num(d.removed)) : "0" },
          { label: "Abgelehnt", value: num(d.rejected) !== null ? String(num(d.rejected)) : "0" },
          { label: "Betroffene Instrumente", value: formatKnownValue("ids", d.ids), mono: true },
          { label: "Zeitpunkt", value: text(d.timestamp) ? formatTimestampUtc(text(d.timestamp)) : "—" },
        ],
      },
    ],
    check: (d) => {
      const rejected = num(d.rejected) ?? 0;
      return rejected > 0
        ? [
            {
              severity: "warn",
              title: `${rejected} Einträge abgelehnt`,
              detail: "Ein Teil der übergebenen Instrumente wurde von der Validierung verworfen (z. B. ungültige Venue/Symbol-Kombination).",
            },
          ]
        : [];
    },
  },
  PORTFOLIO_RISK_GUARD: {
    label: "Portfolio-Risk-Guard-Entscheidung",
    category: "risk",
    expectedLevel: "INFO",
    description:
      "Jede Entscheidung der Portfolio-Risk-Guard (Task 05). Gewichte entstehen ausschließlich im " +
      "deterministischen Optimizer und laufen danach durch die feste Kette Portfolio Optimizer → " +
      "Risk Guard → Position Limits → Correlation Limits. Dieses Ereignis dokumentiert eine einzelne " +
      "Maßnahme (Kappung, Entfernen, Umverteilung, Cluster-Skalierung) oder den Abschluss eines Laufs — " +
      "inklusive Maschine-lesbarem Code, der wirksamen Grenze und den Werten vor/nach der Maßnahme.",
    headline: (d) => {
      const stage = text(d.stage) ?? "risk-guard";
      const code = text(d.code) ?? "RISK_GUARD_SUMMARY";
      const before = num(d.before);
      const after = num(d.after);
      const delta =
        before !== null && after !== null ? `: ${(before * 100).toFixed(2)} % → ${(after * 100).toFixed(2)} %` : "";
      return `${stage} · ${code}${delta}`;
    },
    sections: (d) => [
      {
        title: "Guard-Entscheidung",
        facts: [
          { label: "Stufe der Kette", value: text(d.stage) ?? "—" },
          { label: "Maßnahme", value: text(d.action) ?? "—" },
          { label: "Code", value: text(d.code) ?? "—", mono: true },
          { label: "Optimizer-Modus", value: text(d.mode) ?? "—", mono: true },
          { label: "Wirksame Grenze", value: num(d.limit) !== null ? `${((num(d.limit) ?? 0) * 100).toFixed(2)} %` : "—" },
          { label: "Vorher", value: num(d.before) !== null ? `${((num(d.before) ?? 0) * 100).toFixed(2)} %` : "—" },
          { label: "Nachher", value: num(d.after) !== null ? `${((num(d.after) ?? 0) * 100).toFixed(2)} %` : "—" },
          { label: "Betroffene Symbole", value: formatKnownValue("symbols", d.symbols), mono: true },
          { label: "Gründe", value: formatKnownValue("reasons", d.reasons) },
          { label: "Herkunft", value: text(d.source) ?? "—" },
          { label: "Zeitpunkt", value: text(d.timestamp) ? formatTimestampUtc(text(d.timestamp)) : "—" },
        ],
      },
      ...(num(d.iterations) !== null
        ? [
            {
              title: "Solver",
              facts: [
                { label: "Konvergiert", value: d.converged === false ? "nein" : "ja" },
                { label: "Iterationen", value: String(num(d.iterations) ?? 0) },
              ],
            },
          ]
        : []),
    ],
    check: (d) => {
      const findings: { severity: "warn"; title: string; detail: string }[] = [];
      if (d.converged === false) {
        findings.push({
          severity: "warn",
          title: "Optimizer nicht konvergiert",
          detail:
            "Das Iterationslimit wurde erreicht, bevor die Toleranz (1e-9) unterschritten war. Das Ergebnis ist numerisch nicht abgesichert — Grenzen prüfen, Iterationslimit erhöhen oder Kovarianzschätzung verbessern.",
        });
      }
      const code = text(d.code) ?? "";
      if (code.endsWith("_INFEASIBLE") || code === "RISK_GUARD_REJECTION") {
        findings.push({
          severity: "warn",
          title: "Portfolio verworfen",
          detail:
            "Die Limits lassen sich nicht erfüllen — es wurden keine Gewichte freigegeben. Limits anpassen, mehr Instrumente zulassen oder Cash-Rest erlauben.",
        });
      }
      return findings;
    },
  },
  BROKER_FACTORY: {
    label: "Broker-Factory-Aufruf",
    category: "system",
    expectedLevel: "INFO",
    description:
      "Aufruf der Broker-Factory in einem Modus ungleich „paper“ (Task 02, " +
      "Broker-Capability-Modell). Jeder nicht-Paper-Zugriff auf einen Broker " +
      "ist ein Sicherheitsrelevantes Ereignis und wird lückenlos protokolliert: " +
      "Venue, Modus, Ergebnis (OK = Adapter geliefert / DENIED = abgewiesen) " +
      "und bei Ablehnung die fehlende Capability bzw. den Fehlercode.",
    headline: (d) => {
      const venue = text(d.venue) ?? "—";
      const mode = text(d.mode) ?? "—";
      const outcome = text(d.outcome) ?? "—";
      return `${venue} · ${mode} → ${outcome === "OK" ? "Adapter geliefert" : "abgewiesen"}`;
    },
    sections: (d) => [
      {
        title: "Factory-Entscheidung",
        facts: [
          { label: "Venue", value: text(d.venue) ?? "—", mono: true },
          { label: "Modus", value: text(d.mode) ?? "—", mono: true },
          { label: "Ergebnis", value: text(d.outcome) ?? "—" },
          { label: "Fehlende Capability", value: text(d.capability) ?? "—" },
          { label: "Fehlercode", value: text(d.errorCode) ?? "—", mono: true },
        ],
      },
    ],
    check: (d) => {
      const outcome = text(d.outcome) ?? "";
      if (outcome === "OK" && (d.capability != null || d.errorCode != null)) {
        return [
          {
            severity: "warn",
            title: "Widersprüchlicher Factory-Eintrag",
            detail:
              "outcome=OK, aber capability/errorCode ist hinterlegt — die Factory-Audit-Logik sollte nur bei Ablehnung diese Felder setzen.",
          },
        ];
      }
      return [];
    },
  },
  LIVE_GATE: {
    label: "Live-Trading-Gate",
    category: "system",
    expectedLevel: "INFO",
    description:
      "Ereignis der zentralen Live-Trading-State-Machine (Task 11): jeder " +
      "Übergang (advance), jeder Deny, jeder Kill-Switch-Griff, jeder " +
      "Enforce-Entscheid des Enforcers sowie Crash-Recovery. Die Einträge " +
      "sind hash-verkettet (prevHash/hash) — Manipulation wird über die " +
      "Kettenprüfung sichtbar. Details: docs/LIVE_TRADING.md.",
    headline: (d) => {
      const venue = text(d.venue) ?? "—";
      const action = text(d.action) ?? "—";
      const result = text(d.result) ?? "—";
      const fromTo = [text(d.from), text(d.to)].filter(Boolean).join("→");
      return `Live-Gate ${venue} · ${action} ${fromTo ? `(${fromTo}) ` : ""}→ ${result}`;
    },
    sections: (d) => [
      {
        title: "Gate-Entscheidung",
        facts: [
          { label: "Venue/Scope", value: text(d.venue) ?? "—", mono: true },
          { label: "Aktion", value: text(d.action) ?? "—", mono: true },
          { label: "Ergebnis", value: text(d.result) ?? "—" },
          { label: "Von → Nach", value: [text(d.from), text(d.to)].filter(Boolean).join(" → ") || "—" },
          { label: "Actor", value: text(d.actor) ?? "—", mono: true },
          { label: "Policy", value: text(d.policyVersion) ?? "—", mono: true },
          { label: "Audit-Seq", value: text(d.seq) ?? "—" },
          { label: "Hash", value: text(d.hash) ?? "—", mono: true },
        ],
      },
    ],
    check: (d) => {
      const result = text(d.result) ?? "";
      if (result === "KILLED") {
        return [
          {
            severity: "warn",
            title: "Kill-Switch aktiv",
            detail:
              "Kill-Griff protokolliert — Live ist systemweit bzw. venue-scoped gesperrt; Freigabe nur über kompletten Neudurchlauf der State-Machine.",
          },
        ];
      }
      return [];
    },
  },
  BROKER_CONTROL_PLANE: {
    label: "Broker-Control-Plane",
    category: "system",
    expectedLevel: "INFO",
    description:
      "Ereignis der Broker Control Plane (Task 08): Credentials gespeichert/geaendert/geloescht, " +
      "Verbindungstests, Permission-Proben und Zustandsuebergaenge der 6 Ebenen " +
      "(connection, marketDiscovery, permissions, paper, testnet, live). " +
      "Protokolliert werden nur actor, venue, action, result und errorCode — niemals Secrets.",
    headline: (d) => {
      const venue = text(d.venue) ?? "—";
      const action = text(d.action) ?? "—";
      const result = text(d.result) ?? "—";
      return `${venue} · ${action} → ${result === "OK" ? "erfolgreich" : "abgewiesen/fehlgeschlagen"}`;
    },
    sections: (d) => [
      {
        title: "Control-Plane-Aktion",
        facts: [
          { label: "Akteur", value: text(d.actor) ?? "—", mono: true },
          { label: "Venue", value: text(d.venue) ?? "—", mono: true },
          { label: "Aktion", value: text(d.action) ?? "—", mono: true },
          { label: "Ergebnis", value: text(d.result) ?? "—" },
          { label: "Fehlercode", value: text(d.errorCode) ?? "—", mono: true },
        ],
      },
    ],
    check: (d) => {
      // Live darf in der Control Plane nie aktiv werden — jede Meldung mit
      // liveEnabled=true waere ein Widerspruch zum Hard-Gate.
      const meta = record(d.meta);
      if (meta.liveEnabled === true || meta.live === "active") {
        return [
          {
            severity: "error",
            title: "Live-Ebene aktiv in Control-Plane-Audit",
            detail:
              "Die Live-Ebene der Control Plane darf bis zum Gate-Task (task-11) niemals aktiv sein — Eintrag pruefen.",
          },
        ];
      }
      return [];
    },
  },
  BITUNIX_PRIVATE_CALL: {
    label: "Bitunix-Privat-API",
    category: "system",
    expectedLevel: "INFO",
    description:
      "Privater, signierter REST-Aufruf an Bitunix (Account, Positionen oder Place-Order). " +
      "Der Live-Adapter sendet Place-Order nie (LiveTradingGateError bis task-11). " +
      "Protokolliert werden nur Methode, Pfad und Ergebnis — niemals Body, Query, Key oder Signatur.",
    headline: (d) => {
      const method = text(d.method) ?? "—";
      const path = text(d.path) ?? "—";
      const outcome = text(d.outcome) ?? "—";
      return `${method} ${path} → ${outcome}`;
    },
    sections: (d) => [
      {
        title: "Privater Call",
        facts: [
          { label: "Methode", value: text(d.method) ?? "—", mono: true },
          { label: "Pfad", value: text(d.path) ?? "—", mono: true },
          { label: "Ergebnis", value: text(d.outcome) ?? "—" },
          { label: "Fehlercode", value: text(d.errorCode) ?? "—", mono: true },
        ],
      },
    ],
  },
  ALPACA_PRIVATE_CALL: {
    label: "Alpaca-Privat-API",
    category: "system",
    expectedLevel: "INFO",
    description:
      "Privater, Basic-Auth-geschützter REST-Aufruf an Alpaca (Account, Positionen, " +
      "Assets-Discovery oder Place-Order). Der Live-Adapter sendet Place-Order nie " +
      "(LiveTradingGateError bis task-11 öffnet). Protokolliert werden nur Methode, Pfad " +
      "und Ergebnis — niemals Body, Query, Key oder Secret.",
    headline: (d) => {
      const method = text(d.method) ?? "—";
      const path = text(d.path) ?? "—";
      const outcome = text(d.outcome) ?? "—";
      return `${method} ${path} → ${outcome}`;
    },
    sections: (d) => [
      {
        title: "Privater Call",
        facts: [
          { label: "Methode", value: text(d.method) ?? "—", mono: true },
          { label: "Pfad", value: text(d.path) ?? "—", mono: true },
          { label: "Ergebnis", value: text(d.outcome) ?? "—" },
          { label: "Fehlercode", value: text(d.errorCode) ?? "—", mono: true },
        ],
      },
    ],
  },
};

/** Fallback für unbekannte Events — nie leer, nie abgeschnitten. */
const UNKNOWN_EVENT_SPEC = (event: string): EventSpec => ({
  label: humanizeKey(event.toLowerCase()),
  category: "system",
  description:
    "Dieses Ereignis ist im UI-Katalog nicht hinterlegt. Alle protokollierten Felder werden unten unverändert und vollständig angezeigt — bitte den Katalog in src/lib/auditView.ts ergänzen.",
  headline: (d) => {
    const reason = text(d.reason) ?? text(d.message) ?? text(d.title) ?? text(d.symbol);
    return reason ?? "keine Zusammenfassung verfügbar";
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Stufe / Tönung
// ─────────────────────────────────────────────────────────────────────────────

export const LEVEL_LABELS: Record<string, string> = {
  INFO: "Information",
  WARN: "Warnung",
  CRITICAL: "Kritisch",
  ERROR: "Fehler",
  DEBUG: "Debug",
};

export function auditTone(level: string): AuditTone {
  const upper = level?.toUpperCase();
  if (upper === "CRITICAL" || upper === "ERROR" || upper === "FATAL") return "critical";
  if (upper === "WARN" || upper === "WARNING") return "warn";
  return "info";
}

export function levelLabel(level: string): string {
  const upper = level?.toUpperCase() ?? "";
  return LEVEL_LABELS[upper] ?? (upper || "ohne Stufe");
}

// ─────────────────────────────────────────────────────────────────────────────
// Ein Eintrag → Ansicht
// ─────────────────────────────────────────────────────────────────────────────

function rawJson(entry: AuditEntryDto): string {
  const safe = {
    id: entry.id,
    created_at: entry.createdAt,
    event: entry.event,
    level: entry.level,
    detail: entry.detail ?? null,
    mission_id: entry.missionId ?? null,
    agent_id: entry.agentId ?? null,
  };
  try {
    return JSON.stringify(safe, null, 2);
  } catch {
    return String(entry.detail ?? "");
  }
}

export function describeAuditEntry(entry: AuditEntryDto, now: Date = new Date()): AuditView {
  const detail = record(entry.detail);
  const event = entry.event ?? "UNBEKANNT";
  const spec = AUDIT_EVENT_CATALOG[event] ?? UNKNOWN_EVENT_SPEC(event);
  const tone = auditTone(entry.level);

  const issues: AuditIssue[] = [];
  if (Object.keys(detail).length === 0) {
    issues.push({
      severity: "warn",
      title: "Keine Detaildaten",
      detail: "Zu diesem Ereignis wurde kein Payload gespeichert — die Nachvollziehbarkeit ist eingeschränkt.",
    });
  }
  if (spec.expectedLevel && entry.level && entry.level.toUpperCase() !== spec.expectedLevel) {
    issues.push({
      severity: "info",
      title: `Ungewöhnliche Stufe ${entry.level.toUpperCase()}`,
      detail: `${event} wird normalerweise als ${spec.expectedLevel} protokolliert. Die abweichende Stufe kann auf einen Sonderfall im Code hindeuten.`,
    });
  }
  try {
    issues.push(...(spec.check ? spec.check(detail) : []));
  } catch {
    issues.push({ severity: "info", title: "Prüfung nicht möglich", detail: "Die Plausibilitätsprüfung konnte für diesen Payload nicht ausgeführt werden." });
  }

  let sections: AuditSection[] = [];
  try {
    sections = curatedSections(spec, detail);
  } catch {
    sections = genericSections(detail);
  }

  let headline = "";
  try {
    headline = spec.headline ? spec.headline(detail) : "";
  } catch {
    headline = "";
  }
  if (!headline) {
    const firstSection = sections[0];
    headline = firstSection?.facts[0] ? `${firstSection.facts[0].label}: ${firstSection.facts[0].value}` : "keine Zusammenfassung verfügbar";
  }

  let explanation = "";
  try {
    explanation = spec.explain ? (spec.explain(detail) ?? spec.description) : spec.description;
  } catch {
    explanation = spec.description;
  }

  return {
    id: entry.id,
    at: entry.createdAt,
    atLabel: formatTimestampUtc(entry.createdAt, now),
    relative: formatRelative(entry.createdAt, now),
    event,
    eventLabel: spec.label,
    eventDescription: spec.description,
    level: entry.level,
    levelLabel: levelLabel(entry.level),
    tone,
    headline,
    explanation,
    sections,
    issues,
    raw: rawJson(entry),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Muster über mehrere Einträge (Sequenz-Prüfung)
// ─────────────────────────────────────────────────────────────────────────────

/** Fenster für Mustererkennung: Wiederholungen innerhalb dieser Spanne zählen. */
const PATTERN_WINDOW_MS = 10 * 60 * 1000;

/** Ab dieser Anzahl gleicher Ablehnungen im Fenster wird ein Muster gemeldet. */
const REPEAT_THRESHOLD = 3;

function sortNewestFirst(entries: readonly AuditEntryDto[]): AuditEntryDto[] {
  return [...entries].sort((a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
    return 0;
  });
}

/**
 * Beschreibt eine ganze Liste und ergänzt Muster-Prüfungen, die erst im
 * Kontext mehrerer Einträge sichtbar werden:
 *   - dieselbe Ablehnung mehrfach in kurzer Folge
 *   - mehrfach angelegte Missionen mit identischem Titel
 *   - TRADE-Entscheidungen einer Rolle ohne Handelsmandat
 */
export function describeAuditTrail(entries: readonly AuditEntryDto[], now: Date = new Date()): AuditView[] {
  const ordered = sortNewestFirst(entries);
  const views = new Map<string, AuditView>();
  for (const entry of ordered) views.set(entry.id, describeAuditEntry(entry, now));

  // 1) Wiederholte Ablehnungen mit identischem Grund.
  const rejections = ordered.filter((entry) => entry.event === "ORDER_REJECTED");
  rejections.forEach((entry, index) => {
    const code = text(record(entry.detail).reason)?.toUpperCase() ?? "";
    if (!code) return;
    const at = new Date(entry.createdAt).getTime();
    if (!Number.isFinite(at)) return;
    const group = rejections.filter((other) => {
      const otherCode = text(record(other.detail).reason)?.toUpperCase();
      const otherAt = new Date(other.createdAt).getTime();
      return otherCode === code && Number.isFinite(otherAt) && Math.abs(otherAt - at) <= PATTERN_WINDOW_MS;
    });
    if (group.length < REPEAT_THRESHOLD) return;
    // Nur beim jüngsten Eintrag der Gruppe melden (sonst dreifache Warnung).
    const newest = group.reduce((best, candidate) =>
      new Date(candidate.createdAt).getTime() > new Date(best.createdAt).getTime() ? candidate : best
    );
    if (newest.id !== entry.id) return;
    const view = views.get(entry.id);
    if (!view) return;
    view.issues.push({
      severity: "warn",
      title: `Muster: ${group.length}× gleiche Ablehnung innerhalb von 10 Minuten`,
      detail: `Die Pipeline versucht wiederholt denselben Weg und wird von "${reasonLabel(code)}" gestoppt. Das System verhält sich sicher, aber die Läufe kosten Zeit und Token — Ursache (Rolle, Symbol oder Limit) prüfen.`,
    });
    void index;
  });

  // 2) Doppelte Missionstitel.
  const missions = ordered.filter((entry) => entry.event === "MISSION_CREATED");
  missions.forEach((entry) => {
    const title = text(record(entry.detail).title);
    if (!title) return;
    const duplicates = missions.filter((other) => text(record(other.detail).title) === title);
    if (duplicates.length < 2) return;
    const newest = duplicates.reduce((best, candidate) =>
      new Date(candidate.createdAt).getTime() > new Date(best.createdAt).getTime() ? candidate : best
    );
    if (newest.id !== entry.id) return;
    const view = views.get(entry.id);
    view?.issues.push({
      severity: "warn",
      title: `Missionstitel ${duplicates.length}× vergeben`,
      detail: `„${title}“ wurde ${duplicates.length}× angelegt. Prüfen, ob versehentlich dupliziert wurde — parallele Missionen auf dasselbe Symbol konkurrieren um dasselbe Risikobudget.`,
    });
  });

  // 3) Wiederholte TRADE-Vorschläge ohne Handelsmandat (Pipeline-Rauschen).
  const tradeProposals = ordered.filter((entry) => {
    if (entry.event !== "AGENT_DECISION") return false;
    const detail = record(entry.detail);
    return text(record(detail.decision).type)?.toUpperCase() === "TRADE";
  });
  tradeProposals.forEach((entry) => {
    const role = text(record(entry.detail).role)?.toUpperCase();
    if (!role || (TRADING_ROLES as readonly string[]).includes(role)) return;
    const sameRole = tradeProposals.filter((other) => text(record(other.detail).role)?.toUpperCase() === role);
    if (sameRole.length < REPEAT_THRESHOLD) return;
    const newest = sameRole.reduce((best, candidate) =>
      new Date(candidate.createdAt).getTime() > new Date(best.createdAt).getTime() ? candidate : best
    );
    if (newest.id !== entry.id) return;
    const view = views.get(entry.id);
    view?.issues.push({
      severity: "info",
      title: `Muster: ${sameRole} schlägt wiederholt Trades vor`,
      detail: `${sameRole} hat ${sameRole.length}× TRADE vorgeschlagen, obwohl nur Research/Executor handeln dürfen. Die Vorschläge werden korrekt verworfen; sinnvoller wäre, diese Rolle auf REPORT/HOLD zu prompten.`,
    });
  });

  return ordered.map((entry) => views.get(entry.id) as AuditView);
}

/** Kopfzeilen-Zusammenfassung für die Liste (Zähler für Stufen und Befunde). */
export function summarizeAuditTrail(views: readonly AuditView[]): AuditTrailSummary {
  const summary: AuditTrailSummary = { total: views.length, info: 0, warn: 0, critical: 0, issues: 0, contradictions: 0 };
  for (const view of views) {
    if (view.tone === "critical") summary.critical += 1;
    else if (view.tone === "warn") summary.warn += 1;
    else summary.info += 1;
    summary.issues += view.issues.length;
    summary.contradictions += view.issues.filter((issue) => issue.severity === "error").length;
  }
  return summary;
}

/** Alle bekannten Event-Codes (für Filter-Dropdowns). */
export function knownAuditEvents(): string[] {
  return Object.keys(AUDIT_EVENT_CATALOG).sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Protokoll (agent_messages) — Ein-Zeilen-Zusammenfassung
// ─────────────────────────────────────────────────────────────────────────────

/** Minimale Form des Protokoll-DTOs (src/lib/types.ts ProtocolEntryDto). */
export type ProtocolEntryLike = {
  id: string;
  at: string;
  kind: "turn" | "analysis" | "system" | "message";
  messageType: string;
  actor?: { name?: string; role?: string; source?: string } | null;
  content?: string;
  decision?: { type?: string; symbol?: string; side?: string; stopLossPct?: number; reason?: string; riskScore?: number } | null;
  analysis?: { view?: string | null; confidence?: number | null; thesis?: string | null } | null;
  trace?: {
    source?: string | null;
    model?: string | null;
    latencyMs?: number | null;
    prompt?: string | null;
    rawResponse?: string | null;
    provider?: string | null;
  } | null;
  raw?: unknown;
};

const PROTOCOL_KIND_LABELS: Record<ProtocolEntryLike["kind"], string> = {
  turn: "Agenten-Entscheidung",
  analysis: "Analystenbericht",
  system: "Systemmeldung",
  message: "Nachricht",
};

export function protocolKindLabel(kind: ProtocolEntryLike["kind"]): string {
  return PROTOCOL_KIND_LABELS[kind] ?? "Nachricht";
}

/**
 * Ein-Zeilen-Zusammenfassung eines Protokolleintrags — dieselbe Idee wie die
 * Audit-Headline: erst verstehen, dann aufklappen.
 */
export function summarizeProtocolEntry(entry: ProtocolEntryLike): string {
  const parts: string[] = [];
  if (entry.kind === "turn" && entry.decision) {
    const type = entry.decision.type?.toUpperCase();
    parts.push(decisionLabel(type));
    if (entry.decision.symbol) parts.push(String(entry.decision.symbol));
    if (entry.decision.side) parts.push(entry.decision.side.toUpperCase());
    if (num(entry.decision.stopLossPct) !== null) parts.push(`Stop-Loss ${formatNumber(num(entry.decision.stopLossPct) as number, 1)} %`);
    if (entry.decision.reason) parts.push(`„${entry.decision.reason}“`);
    return parts.join(" · ");
  }
  if (entry.kind === "analysis") {
    const view = entry.analysis?.view ?? null;
    if (view) parts.push(`Einstufung ${view}`);
    if (entry.analysis?.confidence !== null && entry.analysis?.confidence !== undefined) {
      parts.push(`Konfidenz ${Math.round(entry.analysis.confidence * 100)} %`);
    }
    const thesis = entry.analysis?.thesis ?? entry.content ?? "";
    if (thesis) parts.push(firstSentence(thesis));
    return parts.length > 0 ? parts.join(" · ") : "Analystenbericht ohne Einstufung";
  }
  if (entry.content && entry.content.trim().length > 0) return firstSentence(entry.content);
  return `${protocolKindLabel(entry.kind)} ohne Textinhalt`;
}

/** Erster Satz, auf Wortgrenze gekürzt — Lesbarkeit statt harter Schnitt. */
export function firstSentence(value: string, maxLength = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  const boundary = normalized.lastIndexOf(" ", maxLength);
  const cut = boundary > maxLength * 0.6 ? boundary : maxLength;
  return `${normalized.slice(0, cut).trimEnd()} …`;
}

/** Vollständiger Roh-Eintrag des Protokolls als JSON (DB-Zeile, ungekürzt). */
export function protocolRawJson(entry: ProtocolEntryLike): string {
  try {
    return JSON.stringify(entry.raw ?? entry, null, 2);
  } catch {
    return String(entry.content ?? "");
  }
}
