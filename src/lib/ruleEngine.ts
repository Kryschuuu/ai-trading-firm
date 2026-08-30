/**
 * Regel-Engine des Mikro-Zyklus — DIE Datei, die bewusst NICHTS über LLMs
 * weiß (kein Import von ollama/llmProvider/engine) und keine Datenbank
 * braucht. Sie ist die deterministische, im Code verankerte Ausführungsebene
 * zwischen Makro-Zyklus (CEO/Research) und Broker.
 *
 * Sicherheitsmodell („Code entscheidet“):
 *   - Der Makro-Zyklus (LLM) liefert nur einen *Vorschlag* (RuleSpecInput).
 *   - `sanitizeRuleSpec()` baut daraus ein NORMALISIERTES Objekt, das nur
 *     felder der Whitelist enthält — unbekannte Keys, Prototype-Pollution,
 *     Strings statt Zahlen, exotische Operatoren werden verworfen.
 *   - Jeder numerische Wert wird gegen `RULE_CEILINGS` geklemmt, die aus
 *     `LIMIT_CEILINGS` (`riskGuard.ts`) abgeleitet sind. Eine bösartige oder
 *     halluzinierte Regel kann NIE mehr Risiko fordern, als der Code zulässt.
 *   - `compileRuleSpec()` erzeugt beim Cache-Load einen planen Evaluator
 *     (Closure). Im Hot-Path (jeder Preis-Tick) wird KEIN JSON geparst und
 *     keine Funktion geholt — nur Zahlenvergleiche.
 *
 * Hot-Path-Latenzbudget: evaluate < 1 µs pro Regel-Comparator; Snapshot-
 * Berechnung über 120 Kerzen < 100 µs; bewusste NULL DB-/Netzwerk-IO.
 */

import { ema, rsi, atrPct } from "./indicators";
import { LIMIT_CEILINGS, riskAdjustedSize } from "./riskGuard";
import { tryNormalizeVenueSymbol } from "../symbols/normalize";

// ─────────────────────────────────────────────────────────────────────────────
// Typen
// ─────────────────────────────────────────────────────────────────────────────

/** Strukturell kompatible Kerze (marketData.Candle — Importfreiheit!). */
export interface CandleLike {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Felder, die eine Regel abfragen darf. Alles, was ein LLM sonst noch
 * erfindet (orderId, apiKey, executable, …), fällt durch die Whitelist.
 */
export const RULE_FIELDS = {
  price: "number",
  rsi14: "number",
  ema9: "number",
  ema21: "number",
  ema50: "number",
  trend: "trend",
  atrPct: "number",
  volume: "number",
  volumeMa20: "number",
  volumeRatio: "number",
  changePct24h: "number",
  priceVsEma21Pct: "number",
  priceVsEma50Pct: "number",
} as const;

export type RuleField = keyof typeof RULE_FIELDS;
export type TrendValue = "UP" | "DOWN" | "FLAT";

export type RuleOp =
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "eq"
  | "between"
  | "in";

export interface RuleCondition {
  logic: "all" | "any";
  conditions: RuleConditionItem[];
}

export interface RuleConditionItem {
  field: RuleField;
  op: RuleOp;
  /** Zahl (lt/lte/gt/gte/eq), [lo,hi] (between), String (trend eq) oder Array (in). */
  value: number | string | number[] | string[];
}

/**
 * Ausführungs-Action der Regel. Bewusst minimal & hart geklemmt: Die Regel
 * darf nie mehr Notional oder Risiko fordern, als die Guardrails erlauben.
 */
export interface RuleAction {
  side: "LONG";
  stopLossPct: number;
  takeProfitRR: number;
  riskBudgetPct: number;
  maxPositionPct: number;
  positionSizeMode: "risk";
}

/** Ausführungsfenster: wann/wie oft die Regel feuern darf. */
export interface RuleWindow {
  timeframe: "5m" | "15m" | "30m" | "1h";
  validFrom: string | null;
  validUntil: string | null;
  maxExecutionsPerDay: number;
  cooldownMinutes: number;
  volumeWindow: number;
}

/** Normalisierter Regelstand (genau so liegt er in `trade_rules`). */
export interface RuleSpec {
  name: string;
  symbol: string;
  missionId: string | null;
  condition: RuleCondition;
  action: RuleAction;
  window: RuleWindow;
  rationale: string;
  sourceRole: "CEO" | "RESEARCH" | "MANUAL";
  riskScore: number;
}

/** Rohform, wie sie ein LLM (oder ein Mensch) liefern darf. */
export type RuleSpecInput = Record<string, unknown>;

/** Der Snapshot, gegen den der Mikro-Executor bewertet. */
export interface RuleSnapshot {
  symbol: string;
  ts: number;
  price: number;
  rsi14: number;
  ema9: number;
  ema21: number;
  ema50: number;
  trend: TrendValue;
  atrPct: number | null;
  volume: number;
  volumeMa20: number;
  volumeRatio: number;
  changePct24h: number | null;
  priceVsEma21Pct: number;
  priceVsEma50Pct: number;
}

export type ValidationResult =
  | { ok: true; spec: RuleSpec }
  | { ok: false; errors: string[] };

export type CompiledRule = {
  evaluate: (snap: RuleSnapshot) => boolean;
  fields: RuleField[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Harte Code-Grenzen für Regeln — abgeleitet aus den Guardrail-Ceilings
// ─────────────────────────────────────────────────────────────────────────────

export const RULE_CEILINGS = {
  /** Stop-Loss in % des Einstiegskurses (deckungsgleich mit defaultStopLossPct). */
  stopLossPct: [
    LIMIT_CEILINGS.defaultStopLossPct[0] * 100,
    LIMIT_CEILINGS.defaultStopLossPct[1] * 100,
  ] as const,
  takeProfitRR: LIMIT_CEILINGS.takeProfitRR,
  riskBudgetPct: LIMIT_CEILINGS.maxRiskPerTrade,
  maxPositionPct: LIMIT_CEILINGS.maxPositionPct,
  fixedNotional: LIMIT_CEILINGS.maxNotionalPerOrder,
  maxExecutionsPerDay: [1, 10] as const,
  cooldownMinutes: [0, 1440] as const,
  volumeWindow: [5, 200] as const,
  maxConditions: 12,
  maxConditionItems: 24,
} as const;

/** Nur LONG — Shorts sind global gesperrt, eine Regel darf das nicht ändern. */
export const RULE_ALLOWED_SIDE = "LONG" as const;

const NUMERIC_FIELDS = new Set<RuleField>(
  (Object.keys(RULE_FIELDS) as RuleField[]).filter((f) => RULE_FIELDS[f] === "number")
);
const TREND_FIELDS = new Set<RuleField>(
  (Object.keys(RULE_FIELDS) as RuleField[]).filter((f) => RULE_FIELDS[f] === "trend")
);

const NUMERIC_OPS: RuleOp[] = ["lt", "lte", "gt", "gte", "eq", "between", "in"];
const TREND_OPS: RuleOp[] = ["eq", "in"];

const ALLOWED_TIMEFRAMES = new Set<RuleWindow["timeframe"]>(["5m", "15m", "30m", "1h"]);
const ALLOWED_SOURCE_ROLES = new Set<RuleSpec["sourceRole"]>(["CEO", "RESEARCH", "MANUAL"]);

// ─────────────────────────────────────────────────────────────────────────────
// Hilfen
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function finiteNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function clamp(v: number, [min, max]: readonly [number, number]): number {
  return Math.min(Math.max(v, min), max);
}

/**
 * Symbolnormalisierung über die zentrale, venue-aware SSoT (SYM-007).
 *
 * Regeln adressieren Ausführungssymbole des PAPER-Pfads — daher Venue
 * `PAPER` (striktes Default-Profil, keine Venue-Native-Aliasregeln). Die
 * Engine arbeitet danach ausschließlich mit der kanonischen Form (`BTC/USD`).
 *
 * WICHTIG (Ticket §3.3): Diese Änderung ersetzt NUR das frühere lokale
 * Symbol-Regex durch `tryNormalizeVenueSymbol()`. Die Sicherheitsgrenzen —
 * `RULE_ALLOWED_SIDE = "LONG"`, die numerischen Operatoren, die
 * Trend-Operatoren und alle Ceilings — sind ausdrücklich unverändert.
 * `BTC/USD` wird seither akzeptiert (vorher still verworfen); Injection-
 * Zeichen wie `; & ? " '` werden weiterhin zuverlässig abgelehnt.
 */
function normalizeSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const res = tryNormalizeVenueSymbol("PAPER", raw);
  return res.ok ? res.value.canonical : null;
}

/** Stabile String-Vergleichsform für Dedup (keys sortiert, keine Reihung). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** Nicht-kryptographischer, aber deterministischer FNV-1a-Hash (Idempotenz). */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, "0");
}

/** Kanonische Signatur einer Regel (ohne Fenster-/Zeitfelder). */
export function ruleSignature(spec: RuleSpec): string {
  return fnv1a(
    stableStringify({
      symbol: spec.symbol,
      condition: spec.condition,
      action: spec.action,
    })
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Validierung + Normalisierung + Klemmung
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wandelt eine rohe (LLM-/Menschen-)Spezifikation in eine NORMALISIERTE,
 * geklemmte Regel um. Fehler: Liste menschenlesbar. Erfolg: nur Whitelist-
 * Felder, nur endliche Zahlen, alle Risikowerte geklemmt.
 */
export function sanitizeRuleSpec(input: RuleSpecInput | null | undefined, fallbackSourceRole: RuleSpec["sourceRole"] = "MANUAL"): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["Regel-Spezifikation ist kein Objekt."] };

  // Symbol
  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) errors.push(`symbol ungültig: ${String(input.symbol).slice(0, 40)}`);

  // Name
  const name =
    typeof input.name === "string" && input.name.trim().length > 0
      ? input.name.trim().slice(0, 120)
      : `Regel ${symbol ?? "?"}`;

  // rationale
  const rationale =
    typeof input.rationale === "string" ? input.rationale.trim().slice(0, 600) : "";

  // missionId
  const missionId =
    typeof input.missionId === "string" && input.missionId.trim() ? input.missionId.trim() : null;

  // sourceRole
  const sourceRoleRaw = typeof input.sourceRole === "string" ? input.sourceRole.toUpperCase() : fallbackSourceRole;
  const sourceRole = ALLOWED_SOURCE_ROLES.has(sourceRoleRaw as RuleSpec["sourceRole"])
    ? (sourceRoleRaw as RuleSpec["sourceRole"])
    : fallbackSourceRole;

  // riskScore [0,1]
  const riskScore = clamp(finiteNumber(input.riskScore) ?? 0.5, [0, 1]);

  // ── Bedingungen ───────────────────────────────────────────────────────────
  const condRaw = isRecord(input.condition) ? input.condition : {};
  const logicRaw = typeof condRaw.logic === "string" ? condRaw.logic.toLowerCase() : "all";
  const logic: RuleCondition["logic"] = logicRaw === "any" ? "any" : "all";
  const conditions: RuleConditionItem[] = [];

  if (Array.isArray(condRaw.conditions)) {
    for (const itemRaw of condRaw.conditions.slice(0, RULE_CEILINGS.maxConditions)) {
      if (!isRecord(itemRaw)) {
        errors.push("Bedingung ist kein Objekt.");
        continue;
      }
      // Feldname case-insensitiv auf die Whitelist mappen (rsi14 == RSI14).
      const fieldKey = String(itemRaw.field ?? "")
        .replace(/[\s-]+/g, "")
        .toLowerCase();
      const field = Object.keys(RULE_FIELDS).find(
        (k) => k.toLowerCase() === fieldKey
      ) as RuleField | undefined;
      if (!field) {
        errors.push(`unbekanntes Feld: ${String(itemRaw.field).slice(0, 40)}`);
        continue;
      }
      const op = String(itemRaw.op ?? "").toLowerCase() as RuleOp;
      const allowedOps = NUMERIC_FIELDS.has(field) ? NUMERIC_OPS : TREND_OPS;
      if (!allowedOps.includes(op)) {
        errors.push(`Operator ${String(itemRaw.op).slice(0, 20)} nicht erlaubt für ${field}.`);
        continue;
      }
      const item = normalizeConditionItem(field, op, itemRaw.value);
      if (!item) {
        errors.push(`Wert für ${field} ${op} ist ungültig.`);
        continue;
      }
      conditions.push(item);
    }
  }
  if (conditions.length === 0) {
    errors.push("Mindestens eine gültige Bedingung erforderlich.");
  }

  // ── Action (Klemmung gegen Code-Ceilings) ─────────────────────────────────
  const actionRaw = isRecord(input.action) ? input.action : {};
  const stopLossPct = clamp(finiteNumber(actionRaw.stopLossPct) ?? 5, RULE_CEILINGS.stopLossPct);
  const takeProfitRR = clamp(finiteNumber(actionRaw.takeProfitRR) ?? 1.5, RULE_CEILINGS.takeProfitRR);
  const riskBudgetPct = clamp(finiteNumber(actionRaw.riskBudgetPct) ?? 0.02, RULE_CEILINGS.riskBudgetPct);
  const maxPositionPct = clamp(finiteNumber(actionRaw.maxPositionPct) ?? 0.25, RULE_CEILINGS.maxPositionPct);
  const sideRaw = String(actionRaw.side ?? "LONG").toUpperCase();
  if (sideRaw !== RULE_ALLOWED_SIDE) {
    errors.push(`side=${sideRaw} nicht erlaubt — nur LONG (Shorts sind im Code gesperrt).`);
  }

  // ── Fenster ───────────────────────────────────────────────────────────────
  const windowRaw = isRecord(input.window) ? input.window : {};
  const timeframeRaw = String(windowRaw.timeframe ?? "15m").toLowerCase();
  const timeframe = ALLOWED_TIMEFRAMES.has(timeframeRaw as RuleWindow["timeframe"])
    ? (timeframeRaw as RuleWindow["timeframe"])
    : "15m";
  const maxExecutionsPerDay = clamp(
    finiteNumber(windowRaw.maxExecutionsPerDay) ?? 3,
    RULE_CEILINGS.maxExecutionsPerDay
  );
  const cooldownMinutes = clamp(
    finiteNumber(windowRaw.cooldownMinutes) ?? 60,
    RULE_CEILINGS.cooldownMinutes
  );
  const volumeWindow = Math.trunc(
    clamp(finiteNumber(windowRaw.volumeWindow) ?? 20, RULE_CEILINGS.volumeWindow)
  );

  const validFrom = isValidIso(windowRaw.validFrom) ? String(windowRaw.validFrom) : null;
  const validUntil = isValidIso(windowRaw.validUntil) ? String(windowRaw.validUntil) : null;
  if (validFrom && validUntil && new Date(validFrom).getTime() >= new Date(validUntil).getTime()) {
    errors.push("validFrom muss vor validUntil liegen.");
  }

  if (errors.length > 0 || !symbol) {
    return { ok: false, errors };
  }

  const spec: RuleSpec = {
    name,
    symbol,
    missionId,
    condition: { logic, conditions },
    action: {
      side: RULE_ALLOWED_SIDE,
      stopLossPct: Number(stopLossPct.toFixed(2)),
      takeProfitRR: Number(takeProfitRR.toFixed(2)),
      riskBudgetPct: Number(riskBudgetPct.toFixed(4)),
      maxPositionPct: Number(maxPositionPct.toFixed(4)),
      positionSizeMode: "risk",
    },
    window: {
      timeframe,
      validFrom,
      validUntil,
      maxExecutionsPerDay: Math.trunc(maxExecutionsPerDay),
      cooldownMinutes: Math.trunc(cooldownMinutes),
      volumeWindow,
    },
    rationale,
    sourceRole,
    riskScore,
  };
  return { ok: true, spec };
}

function isValidIso(v: unknown): v is string {
  if (typeof v !== "string" || v.trim() === "") return false;
  const t = Date.parse(v);
  return Number.isFinite(t);
}

function normalizeConditionItem(field: RuleField, op: RuleOp, raw: unknown): RuleConditionItem | null {
  if (TREND_FIELDS.has(field)) {
    if (op === "in") {
      if (!Array.isArray(raw)) return null;
      const values = raw
        .map((v) => String(v).toUpperCase())
        .filter((v): v is TrendValue => v === "UP" || v === "DOWN" || v === "FLAT");
      if (values.length === 0) return null;
      return { field, op, value: [...new Set(values)] };
    }
    // eq
    const v = String(raw ?? "").toUpperCase();
    if (v !== "UP" && v !== "DOWN" && v !== "FLAT") return null;
    return { field, op: "eq", value: v };
  }

  if (op === "between") {
    if (!Array.isArray(raw) || raw.length !== 2) return null;
    const lo = finiteNumber(raw[0]);
    const hi = finiteNumber(raw[1]);
    if (lo === null || hi === null || lo > hi) return null;
    return { field, op, value: [lo, hi] };
  }
  if (op === "in") {
    if (!Array.isArray(raw)) return null;
    const numbers = raw.map(finiteNumber).filter((n): n is number => n !== null);
    if (numbers.length === 0) return null;
    return { field, op, value: [...new Set(numbers)] };
  }
  const num = finiteNumber(raw);
  if (num === null) return null;
  return { field, op, value: num };
}

// ─────────────────────────────────────────────────────────────────────────────
// Kompilierung (einmal beim Cache-Load, nie im Hot-Path)
// ─────────────────────────────────────────────────────────────────────────────

/** Feld-Zugriffe als planer Ausdruck — kein Property-Lookup mit Strings im Hot-Path. */
function accessor(field: RuleField): (s: RuleSnapshot) => number | string | null {
  switch (field) {
    case "price": return (s) => s.price;
    case "rsi14": return (s) => s.rsi14;
    case "ema9": return (s) => s.ema9;
    case "ema21": return (s) => s.ema21;
    case "ema50": return (s) => s.ema50;
    case "trend": return (s) => s.trend;
    case "atrPct": return (s) => s.atrPct;
    case "volume": return (s) => s.volume;
    case "volumeMa20": return (s) => s.volumeMa20;
    case "volumeRatio": return (s) => s.volumeRatio;
    case "changePct24h": return (s) => s.changePct24h;
    case "priceVsEma21Pct": return (s) => s.priceVsEma21Pct;
    case "priceVsEma50Pct": return (s) => s.priceVsEma50Pct;
  }
}

function compileItem(item: RuleConditionItem): (s: RuleSnapshot) => boolean {
  const get = accessor(item.field);
  const value = item.value;
  switch (item.op) {
    case "lt": {
      const v = value as number;
      return (s) => {
        const x = get(s);
        return x != null && (x as number) < v;
      };
    }
    case "lte": {
      const v = value as number;
      return (s) => {
        const x = get(s);
        return x != null && (x as number) <= v;
      };
    }
    case "gt": {
      const v = value as number;
      return (s) => {
        const x = get(s);
        return x != null && (x as number) > v;
      };
    }
    case "gte": {
      const v = value as number;
      return (s) => {
        const x = get(s);
        return x != null && (x as number) >= v;
      };
    }
    case "eq": {
      return (s) => {
        const x = get(s);
        return typeof value === "string" ? x === value : x != null && x === value;
      };
    }
    case "between": {
      const [lo, hi] = value as number[];
      return (s) => {
        const x = get(s);
        return x != null && (x as number) >= lo && (x as number) <= hi;
      };
    }
    case "in": {
      const values = value as (number | string)[];
      const numeric = typeof values[0] === "number";
      const set = new Set(values);
      return (s) => {
        const x = get(s);
        if (x == null) return false;
        return numeric ? set.has(x as number) : set.has(x as string);
      };
    }
  }
}

/**
 * Kompiliert eine normalisierte Regel zu einem schnellen Evaluator.
 * Wirft bei nicht-normalisierten Eingaben (defensive Programmierung).
 */
export function compileRuleSpec(spec: RuleSpec): CompiledRule {
  const items = spec.condition.conditions.map(compileItem);
  const fields = spec.condition.conditions.map((c) => c.field);
  const evaluate =
    spec.condition.logic === "any"
      ? (s: RuleSnapshot) => items.some((fn) => fn(s))
      : (s: RuleSnapshot) => items.every((fn) => fn(s));
  return { evaluate, fields: [...new Set(fields)] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot-Berechnung (deterministisch, keine IO)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Baut aus Kerzen (hist. Daten oder Rolling-Buffer des Mikro-Executors) den
 * vollständigen Rule-Snapshot. Kein Netzwerk, keine DB — reine Arithmetik.
 */
export function buildSnapshotFromCandles(
  symbol: string,
  candles: CandleLike[],
  volumeWindow = 20
): RuleSnapshot | null {
  if (candles.length < 25) return null;
  const closes = candles.map((c) => c.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, Math.min(50, closes.length));
  const price = closes[closes.length - 1];
  const priceVsEma21 = e21[e21.length - 1] > 0 ? ((price - e21[e21.length - 1]) / e21[e21.length - 1]) * 100 : 0;
  const priceVsEma50 = e50[e50.length - 1] > 0 ? ((price - e50[e50.length - 1]) / e50[e50.length - 1]) * 100 : 0;

  const volWindow = clamp(Math.trunc(volumeWindow), RULE_CEILINGS.volumeWindow);
  const volumes = candles.slice(-volWindow).map((c) => c.volume);
  const volume = volumes[volumes.length - 1] ?? 0;
  const volumeMa20 = volumes.reduce((a, b) => a + b, 0) / Math.max(volumes.length, 1);

  const trendRel = Math.abs(e9[e9.length - 1] - e21[e21.length - 1]) / price;
  let trend: TrendValue = "FLAT";
  if (trendRel >= 0.001) trend = e9[e9.length - 1] > e21[e21.length - 1] ? "UP" : "DOWN";

  const changeBase = candles.length > 1 ? closes[Math.max(0, closes.length - 97)] : price;
  const changePct24h = changeBase > 0 ? ((price - changeBase) / changeBase) * 100 : null;

  return {
    symbol: symbol.toUpperCase(),
    ts: candles[candles.length - 1].time,
    price,
    rsi14: Number(rsi(closes).toFixed(2)),
    ema9: e9[e9.length - 1],
    ema21: e21[e21.length - 1],
    ema50: e50[e50.length - 1],
    trend,
    atrPct: atrPct(candles) != null ? Number((atrPct(candles as never)! * 100).toFixed(2)) : null,
    volume,
    volumeMa20,
    volumeRatio: volumeMa20 > 0 ? volume / volumeMa20 : 0,
    changePct24h: changePct24h != null ? Number(changePct24h.toFixed(2)) : null,
    priceVsEma21Pct: Number(priceVsEma21.toFixed(2)),
    priceVsEma50Pct: Number(priceVsEma50.toFixed(2)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fensterprüfung (Zeitfenster + Tages-/Cooldown-Limits) — pure Logik
// ─────────────────────────────────────────────────────────────────────────────

export function isWindowOpen(spec: RuleSpec, atMs: number): boolean {
  if (spec.window.validFrom && atMs < new Date(spec.window.validFrom).getTime()) return false;
  if (spec.window.validUntil && atMs > new Date(spec.window.validUntil).getTime()) return false;
  return true;
}

/** Berliner Tages-Key (deterministisch, ohne time.ts-Import: pure Logik). */
export function berlinDayKeyOf(atMs: number): string {
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(atMs));
}

// ─────────────────────────────────────────────────────────────────────────────
// Backtest (deterministisch, ohne LLM, ohne DB)
// ─────────────────────────────────────────────────────────────────────────────

export type BacktestTrade = {
  entryIndex: number;
  entryPrice: number;
  exitIndex: number;
  exitPrice: number;
  side: "LONG";
  pnl: number;
  pnlPct: number;
  reason: "STOP_LOSS" | "TAKE_PROFIT";
  entryAt: number;
  exitAt: number;
};

export type BacktestResult = {
  symbol: string;
  timeframe: string;
  bars: number;
  warmup: number;
  signals: number;
  trades: BacktestTrade[];
  stats: {
    trades: number;
    wins: number;
    losses: number;
    pnl: number;
    pnlPct: number;
    profitFactor: number | null;
    maxDrawdownPct: number;
    exposurePct: number;
    startingEquity: number;
  };
};

/**
 * Historische Simulation: Signal am Kerzenschluss, Einstieg zum Schlusskurs,
 * Stop/Take-Profit über Folgekerzen (Stop hat bei Gleichzeitigkeit Vorrang).
 * Bewusst einfach & konservativ — das ist ein Papier-Referenz-Backtest,
 * keine Rendite-Versprechen.
 */
export function backtestRule(
  spec: RuleSpec,
  candles: CandleLike[],
  opts?: { startingEquity?: number; warmup?: number }
): BacktestResult {
  const compiler = compileRuleSpec(spec);
  const startingEquity = opts?.startingEquity ?? 10_000;
  const warmup = opts?.warmup ?? 30;

  let equity = startingEquity;
  let peakEquity = startingEquity;
  let maxDrawdown = 0;
  const trades: BacktestTrade[] = [];
  let signals = 0;
  let barsInPosition = 0;

  interface OpenTrade {
    entryIndex: number;
    entryPrice: number;
    qty: number;
    stop: number;
    target: number;
  }
  let open: OpenTrade | null = null;

  for (let i = warmup; i < candles.length; i++) {
    // Position unterwegs → Exits zuerst (Stop vor TP bei Gleichzeitigkeit).
    if (open) {
      const c = candles[i];
      const stopHit = c.low <= open.stop;
      const targetHit = c.high >= open.target;
      const reason = stopHit ? "STOP_LOSS" : targetHit ? "TAKE_PROFIT" : null;
      if (reason) {
        const exitPrice = reason === "STOP_LOSS" ? open.stop : open.target;
        const pnl = open.qty * (exitPrice - open.entryPrice);
        equity += pnl;
        peakEquity = Math.max(peakEquity, equity);
        maxDrawdown = Math.max(maxDrawdown, ((peakEquity - equity) / peakEquity) * 100);
        trades.push({
          entryIndex: open.entryIndex,
          entryPrice: Number(open.entryPrice.toFixed(4)),
          exitIndex: i,
          exitPrice: Number(exitPrice.toFixed(4)),
          side: "LONG",
          pnl: Number(pnl.toFixed(2)),
          pnlPct: Number(((pnl / equity) * 100).toFixed(2)),
          reason,
          entryAt: candles[open.entryIndex].time,
          exitAt: c.time,
        });
        barsInPosition += i - open.entryIndex;
        open = null;
      } else {
        barsInPosition += 1;
      }
    }

    // Signalprüfung auf aktueller (geschlossener) Kerze.
    const snap = buildSnapshotFromCandles(spec.symbol, candles.slice(0, i + 1), spec.window.volumeWindow);
    if (!snap) continue;
    const windowOpen = isWindowOpen(spec, snap.ts);
    if (!windowOpen || open) continue;
    if (compiler.evaluate(snap)) {
      signals++;
      const stopPct = spec.action.stopLossPct / 100;
      const notional = riskAdjustedSize(equity, stopPct, spec.action.riskBudgetPct);
      const capped = Math.min(notional, equity * spec.action.maxPositionPct);
      const entryPrice = candles[i].close;
      const qty = entryPrice > 0 ? capped / entryPrice : 0;
      if (qty <= 0) continue;
      const stop = entryPrice * (1 - stopPct);
      const target = entryPrice * (1 + spec.action.takeProfitRR * stopPct);
      open = { entryIndex: i, entryPrice, qty, stop, target };
    }
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const pnl = Number(trades.reduce((a, t) => a + t.pnl, 0).toFixed(2));
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const evaluatedBars = Math.max(candles.length - warmup, 1);

  return {
    symbol: spec.symbol,
    timeframe: spec.window.timeframe,
    bars: candles.length,
    warmup,
    signals,
    trades,
    stats: {
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      pnl,
      pnlPct: Number(((pnl / startingEquity) * 100).toFixed(2)),
      profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : null,
      maxDrawdownPct: Number(maxDrawdown.toFixed(2)),
      exposurePct: Number(((barsInPosition / evaluatedBars) * 100).toFixed(1)),
      startingEquity,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON-Schema für den LLM-Output des Makro-Zyklus (weiche Schicht)
// ─────────────────────────────────────────────────────────────────────────────

/** Beschreibt die erwartete Regel-Form für ollama/OpenAI structured output. */
export const RULE_LLM_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    name: { type: "string" },
    symbol: { type: "string" },
    rationale: { type: "string" },
    condition: {
      type: "object",
      properties: {
        logic: { type: "string", enum: ["all", "any"] },
        conditions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: {
                type: "string",
                enum: Object.keys(RULE_FIELDS),
              },
              op: {
                type: "string",
                enum: ["lt", "lte", "gt", "gte", "eq", "between", "in"],
              },
              value: { type: ["number", "array"] },
            },
            required: ["field", "op", "value"],
          },
        },
      },
      required: ["logic", "conditions"],
    },
    action: {
      type: "object",
      properties: {
        side: { type: "string", enum: ["LONG"] },
        stopLossPct: { type: "number" },
        takeProfitRR: { type: "number" },
        riskBudgetPct: { type: "number" },
        maxPositionPct: { type: "number" },
      },
      required: ["side", "stopLossPct"],
    },
    window: {
      type: "object",
      properties: {
        timeframe: { type: "string", enum: ["5m", "15m", "30m", "1h"] },
        validFrom: { type: ["string", "null"] },
        validUntil: { type: ["string", "null"] },
        maxExecutionsPerDay: { type: "number" },
        cooldownMinutes: { type: "number" },
        volumeWindow: { type: "number" },
      },
      required: ["timeframe"],
    },
    riskScore: { type: "number" },
  },
  required: ["symbol", "condition", "action"],
};
