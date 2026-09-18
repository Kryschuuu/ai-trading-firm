/**
 * Auto-Circuit-Breaker (GAP-10, D2, v1.45.0) — die Firma hält sich SELBST an,
 * wenn eine harte Grenze reißt.
 *
 * Warum: `maxEquityDrawdownPct`/`dailyLossLimitPct` blockieren heute nur NEUE
 * Orders. Ein Bug, ein Datenfehler oder eine Verlustserie um 3 Uhr nachts
 * lässt offene Positionen aber weiterlaufen. Der Brecher schaltet deshalb die
 * BESTEHENDE Kill-Switch-Infrastruktur scharf:
 *
 *     killSwitch.pull(reason)  +  `kill_switches`-Zeile (best effort)
 *                              +  Audit `KILL_SWITCH` (CRITICAL, maschinen-
 *                                 lesbarer Grund `auto-circuit-breaker:…`)
 *                              +  Alert über den Alert-Adapter (D3)
 *
 * Auslöser (im Monitor-Tick NACH der Equity-Berechnung geprüft):
 *   a) `drawdownPct >= maxEquityDrawdownPct`
 *   b) Tagesverlust `>= dailyLossLimitPct` (Anteil des Startkapitals)
 *   c) `RISK_MAX_CONSECUTIVE_LOSSES` Verlust-Closes in Folge (Default 5,
 *      Bounds [2, 50])
 *
 * ── Latching (Flatter-Schutz) ───────────────────────────────────────────────
 * Der Brecher ist LATCHING: Einmal ENGAGE bleibt ENGAGE, bis ein Mensch den
 * Not-Halt über den MANUELLEN Disarm-Pfad löst (Permission `live.gate` +
 * CSRF + single-use Challenge-Nonce — unverändert, siehe
 * `src/app/api/firm/kill/route.ts`). Es gibt hier bewusst KEINE Auto-Re-Arm-
 * Logik, keine Hysterese, keinen Timer: Der Auslösewert wird beim Auslösen im
 * Audit fixiert (`metric`, `value`, `limit`, `triggeredAt`), damit auch
 * spätere Ticks das Bild nicht rückwirkend verändern.
 *
 * Erst wenn der Kill-Switch MANUELL entschärft wurde (`killSwitch.isArmed()`
 * ist false, während der Latch noch steht), fällt der Latch und der Brecher
 * darf erneut greifen. Das ist keine Auto-Re-Arm-Logik: Der Mensch entschärft,
 * der Brecher erinnert sich nur, dass er schon einmal ausgelöst hat.
 *
 * Flag `AUTO_CIRCUIT_BREAKER` (Default **on**): Harte Grenzen sind die letzte
 * Verteidigungslinie; „aus“ ist ein bewusster, dokumentierter Betriebs-
 * entscheid (z. B. Fehlersuche) — der CHANGELOG nennt die Verhaltensänderung.
 *
 * Grundregeln: Paper-only (der Brecher nutzt den bestehenden Kill-Switch,
 * baut ihn nicht um), Fail-closed (im Zweifel armieren ist die sichere
 * Richtung; unbekannte Verlustserie armiert NICHT), keine neuen
 * Runtime-Dependencies, deterministisch (rein rechnende `evaluate…`-Funktion
 * plus injizierbare Effekt-Hooks für Tests).
 */
import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { killSwitches, positions } from "@/db/schema";
import { writeAuditRecord } from "./auditSink";
import { emitAlert, type Alert } from "./alerts";
import { killSwitch } from "./riskGuard";
import { state } from "./stateRegistry";
import { structuredLog } from "./logger";

/** Env-Namen (zentral, für Doku/Tests). */
export const CIRCUIT_BREAKER_ENV = {
  ENABLED: "AUTO_CIRCUIT_BREAKER",
  MAX_CONSECUTIVE_LOSSES: "RISK_MAX_CONSECUTIVE_LOSSES",
} as const;

/** Bounds der Verlustserie (kleiner als 2 wäre kein „Serie“-Schutz). */
export const MAX_CONSECUTIVE_LOSSES_BOUNDS = { min: 2, max: 50 } as const;

/** Default: 5 Verluste in Folge (Prompt-Vorgabe). */
export const MAX_CONSECUTIVE_LOSSES_DEFAULT = 5;

/** Maschinenlesbares Präfix aller Auto-Breaker-Gründe. */
export const CIRCUIT_BREAKER_REASON_PREFIX = "auto-circuit-breaker";

/** Auslöser-Metriken (stabil, `metricLabel`-konform). */
export type CircuitBreakerMetric = "drawdown" | "dailyLoss" | "consecutiveLosses";

export interface CircuitBreakerConfig {
  /** `AUTO_CIRCUIT_BREAKER` — Default on. */
  enabled: boolean;
  /** `RISK_MAX_CONSECUTIVE_LOSSES` — Bounds [2, 50]. */
  maxConsecutiveLosses: number;
}

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || String(value).trim() === "") return fallback;
  switch (String(value).trim().toLowerCase()) {
    case "true":
    case "1":
    case "yes":
    case "on":
      return true;
    case "false":
    case "0":
    case "no":
    case "off":
      return false;
    default:
      // Unbekannter Wert ⇒ Default (on) + laute Warnung: ein Tippfehler darf
      // den Brecher nicht still abschalten (fail-loud, sichere Richtung).
      console.warn(`[circuit-breaker] ${name}="${String(value).slice(0, 40)}" ist kein on/off → Default ${fallback ? "on" : "off"}`);
      return fallback;
  }
}

/** Lädt die Breaker-Konfiguration (Bounds-Clamp mit Warnung, Muster `env`). */
export function loadCircuitBreakerConfig(
  env: Record<string, string | undefined> = process.env,
): CircuitBreakerConfig {
  const enabled = parseBoolean(env[CIRCUIT_BREAKER_ENV.ENABLED], true, CIRCUIT_BREAKER_ENV.ENABLED);
  const rawLosses = Number(env[CIRCUIT_BREAKER_ENV.MAX_CONSECUTIVE_LOSSES]);
  let maxConsecutiveLosses = MAX_CONSECUTIVE_LOSSES_DEFAULT;
  if (Number.isFinite(rawLosses) && String(env[CIRCUIT_BREAKER_ENV.MAX_CONSECUTIVE_LOSSES] ?? "").trim() !== "") {
    maxConsecutiveLosses = Math.trunc(
      Math.min(Math.max(rawLosses, MAX_CONSECUTIVE_LOSSES_BOUNDS.min), MAX_CONSECUTIVE_LOSSES_BOUNDS.max),
    );
    if (maxConsecutiveLosses !== Math.trunc(rawLosses)) {
      console.warn(
        `[circuit-breaker] ${CIRCUIT_BREAKER_ENV.MAX_CONSECUTIVE_LOSSES}=${rawLosses} außerhalb der Bounds ` +
          `[${MAX_CONSECUTIVE_LOSSES_BOUNDS.min}, ${MAX_CONSECUTIVE_LOSSES_BOUNDS.max}] → geklemmt auf ${maxConsecutiveLosses}`,
      );
    }
  }
  return { enabled, maxConsecutiveLosses };
}

/** Alle Eingangsgrößen des Auslösers (alle Werte serverseitig berechnet). */
export interface CircuitBreakerInput {
  /** Drawdown gegenüber Startkapital (0.18 = 18 % im Minus). */
  drawdownPct: number;
  maxEquityDrawdownPct: number;
  /** Tagesverlust als Anteil des Startkapitals (0.06 = 6 % im Minus). */
  dailyLossPct: number;
  dailyLossLimitPct: number;
  /**
   * Anzahl verlustbringender Closes unmittelbar vor dem Tick. Fehlt der Wert,
   * liest `checkCircuitBreaker()` ihn (begrenzte DB-Abfrage) — die reine
   * Prüffunktion behandelt „unbekannt“ als 0 (kein Serien-Trigger).
   */
  consecutiveLosses?: number;
  /** Schwelle; fehlt sie, gilt die Config (`RISK_MAX_CONSECUTIVE_LOSSES`). */
  maxConsecutiveLosses?: number;
}

export interface CircuitBreakerTrigger {
  metric: CircuitBreakerMetric;
  value: number;
  limit: number;
  /** `auto-circuit-breaker:<metrik>:<wert>` — maschinenlesbar, im Audit fixiert. */
  reason: string;
}

/**
 * Wert-Format im Grund (maschinenlesbar, stabil):
 *   drawdown/dailyLoss → Dezimalanteil mit 4 Nachkommastellen (`0.1830`)
 *   consecutiveLosses  → ganze Zahl (`5`)
 */
export function formatBreakerValue(metric: CircuitBreakerMetric, value: number): string {
  if (!Number.isFinite(value)) return "unknown";
  return metric === "consecutiveLosses" ? String(Math.trunc(value)) : value.toFixed(4);
}

/** Baut den maschinenlesbaren Grund `auto-circuit-breaker:<metrik>:<wert>`. */
export function circuitBreakerReason(metric: CircuitBreakerMetric, value: number): string {
  return `${CIRCUIT_BREAKER_REASON_PREFIX}:${metric}:${formatBreakerValue(metric, value)}`;
}

/**
 * Rein deterministische Auslöse-Prüfung — erster Treffer gewinnt, Reihenfolge
 * nach Eingriffstiefe (Drawdown → Tagesverlust → Verlustserie). Kein IO,
 * keine Uhr, keine Mutation: genau deshalb ohne Infrastruktur testbar.
 */
export function evaluateCircuitBreaker(input: CircuitBreakerInput): CircuitBreakerTrigger | null {
  const first = (
    metric: CircuitBreakerMetric,
    value: number,
    limit: number,
    hit: boolean,
  ): CircuitBreakerTrigger | null =>
    hit ? { metric, value, limit, reason: circuitBreakerReason(metric, value) } : null;

  // „Unbekannt“ (NaN/fehlend) ist kein Serien-Trigger: Auf Basis einer nicht
  // gelesenen Zahl zu armieren wäre geraten, nicht fail-closed.
  const losses = Number(input.consecutiveLosses);
  const lossLimit = Number(input.maxConsecutiveLosses);
  const lossesKnown = Number.isFinite(losses) && Number.isFinite(lossLimit);

  return (
    first("drawdown", input.drawdownPct, input.maxEquityDrawdownPct, input.drawdownPct >= input.maxEquityDrawdownPct) ??
    first("dailyLoss", input.dailyLossPct, input.dailyLossLimitPct, input.dailyLossPct >= input.dailyLossLimitPct) ??
    (lossesKnown
      ? first("consecutiveLosses", losses, lossLimit, losses >= lossLimit)
      : null)
  );
}

/** Fixierter Auslösezustand (latching) — bis zum manuellen Disarm. */
export interface CircuitBreakerLatch {
  metric: CircuitBreakerMetric;
  value: number;
  limit: number;
  reason: string;
  /** Zeitpunkt des Auslösens (ISO) — im Audit fixiert. */
  at: string;
}

/** Aktueller Latch-Zustand (null = nicht ausgelöst). */
export function circuitBreakerLatch(): CircuitBreakerLatch | null {
  return state.circuitBreakerLatch.get() ?? null;
}

/** Nur für Tests: Latch entfernen. */
export function resetCircuitBreakerForTests(): void {
  state.circuitBreakerLatch.reset();
}

/**
 * Zählt die Verlust-Closes in Folge (firmenweit, jüngste zuerst).
 *
 * Quelle ist `positions` (`status = CLOSED`, `realized_pnl < 0`) — dieselbe
 * Tabelle, aus der Engine und Monitor ihre Serien lesen. Die Abfrage ist auf
 * `limit` Zeilen begrenzt (max. 50): mehr als die Schwelle kann nie nötig
 * sein, und ein unbegrenzter Read wäre ein Lastrisiko im Tick.
 */
export async function countConsecutiveLosses(limit = MAX_CONSECUTIVE_LOSSES_DEFAULT): Promise<number> {
  const bounded = Math.min(
    Math.max(Math.trunc(Number.isFinite(limit) ? limit : MAX_CONSECUTIVE_LOSSES_DEFAULT), 1),
    MAX_CONSECUTIVE_LOSSES_BOUNDS.max,
  );
  const rows = await db
    .select({ pnl: positions.realizedPnl })
    .from(positions)
    .where(eq(positions.status, "CLOSED"))
    .orderBy(desc(positions.updatedAt))
    .limit(bounded);
  let count = 0;
  for (const row of rows) {
    if (Number(row.pnl ?? 0) < 0) count++;
    else break;
  }
  return count;
}

/** Effekt-Hooks (Tests injizieren sie; Produktion nutzt die Defaults). */
export interface CircuitBreakerDeps {
  now?: () => number;
  config?: CircuitBreakerConfig;
  /** Audit-Schreiber (Default: `writeAuditRecord`, security-Klasse). */
  audit?: (detail: Record<string, unknown>) => Promise<{ durable: boolean; error: string | null }>;
  /** Alert-Versand (Default: `emitAlert` über den Alert-Adapter). */
  emit?: (alert: Alert) => Promise<unknown>;
  /** Persistenz der Auslösung im `kill_switches`-Log (Default: DB-Insert). */
  recordKillSwitch?: (row: { reason: string; triggeredBy: string; armed: boolean }) => Promise<void>;
  /** Verlustserien-Zähler (Default: DB-Abfrage). */
  countLosses?: (limit: number) => Promise<number>;
}

export interface CircuitBreakerOutcome {
  /** Flag-Zustand (`AUTO_CIRCUIT_BREAKER`). */
  enabled: boolean;
  /** true = in DIESEM Aufruf neu scharfgeschaltet. */
  engaged: boolean;
  /** true = der Brecher ist (weiterhin) gesperrt (latching). */
  latched: boolean;
  reason: string | null;
  trigger: CircuitBreakerTrigger | null;
  /** Audit-Beleg (durable = in `audit_log` oder Spool). */
  audit: { durable: boolean; error: string | null } | null;
  /** Kurzbeschreibung des Alert-Versands (Fehler werden nie geworfen). */
  alert: { sent: boolean; suppressed: boolean; errors: string[] } | null;
  /** Nicht-fatale Probleme (Zählfehler, Kill-Switch-Log-Insert, …). */
  errors: string[];
}

function isoNow(now: number): string {
  return new Date(now).toISOString();
}

/**
 * Prüft und vollzieht den Auto-Circuit-Breaker.
 *
 * Ablauf (jeder Schritt fail-soft, außer der Scharfschaltung selbst):
 *   1. Flag aus        → no-op (kein Engage, kein Audit, kein Alert).
 *   2. Latch + armed   → no-op (latching: ein Tick ändert nichts mehr).
 *   3. Latch + disarmed→ Latch fällt (der Mensch hat MANUELL entschärft) und
 *                        die Prüfung läuft wieder normal.
 *   4. Auslöser        → Latch setzen (synchron, vor jedem `await` — parallele
 *                        Ticks können nicht doppelt armieren), Kill-Switch
 *                        ziehen, `kill_switches`-Zeile, Audit, Alert.
 *
 * Der Rückgabewert beschreibt den Zustand; geworfen wird nie — ein
 * Beobachtungsfehler darf den Tick nicht abbrechen (der Kill-Switch-Pull
 * selbst ist synchron und kann nicht fehlschlagen).
 */
export async function checkCircuitBreaker(
  input: CircuitBreakerInput,
  deps: CircuitBreakerDeps = {},
): Promise<CircuitBreakerOutcome> {
  const config = deps.config ?? loadCircuitBreakerConfig();
  const now = deps.now ?? Date.now;
  const errors: string[] = [];
  const base: CircuitBreakerOutcome = {
    enabled: config.enabled,
    engaged: false,
    latched: false,
    reason: null,
    trigger: null,
    audit: null,
    alert: null,
    errors,
  };

  if (!config.enabled) return base;

  const latch = circuitBreakerLatch();
  if (latch) {
    if (killSwitch.isArmed()) {
      // Latching: Zustand bleibt, wie er ist — kein zweites Engage, kein
      // zweiter Alert, keine Zustandsänderung durch spätere Ticks.
      return {
        ...base,
        latched: true,
        reason: latch.reason,
        trigger: { metric: latch.metric, value: latch.value, limit: latch.limit, reason: latch.reason },
      };
    }
    // Manuell entschärft (Disarm-Pfad mit Challenge-Nonce, unverändert):
    // Der Latch fällt, der Brecher darf erneut greifen.
    state.circuitBreakerLatch.reset();
  }

  // Verlustserie nur lesen, wenn sie nicht schon mitgeliefert wurde und die
  // Auslöser a/b nicht ohnehin greifen — die DB-Abfrage ist der teuerste Teil.
  const lossLimit = Number.isFinite(Number(input.maxConsecutiveLosses))
    ? Number(input.maxConsecutiveLosses)
    : config.maxConsecutiveLosses;
  let consecutiveLosses = Number(input.consecutiveLosses);
  const drawdownHit = input.drawdownPct >= input.maxEquityDrawdownPct;
  const dailyLossHit = input.dailyLossPct >= input.dailyLossLimitPct;
  if (!Number.isFinite(consecutiveLosses) && !drawdownHit && !dailyLossHit) {
    try {
      const counter = deps.countLosses ?? countConsecutiveLosses;
      consecutiveLosses = await counter(lossLimit);
    } catch (e) {
      consecutiveLosses = Number.NaN;
      const message = e instanceof Error ? e.message : "Verlustserie nicht lesbar";
      errors.push(`Verlustserie nicht lesbar: ${message}`);
      structuredLog("warn", "circuit_breaker_count_failed", { reason: message });
    }
  }

  const trigger = evaluateCircuitBreaker({
    ...input,
    maxConsecutiveLosses: lossLimit,
    consecutiveLosses,
  });
  if (!trigger) return base;

  // Latch SYNCHRON setzen — vor dem ersten `await`, damit parallele Ticks
  // (Single-Flight hin oder her) nicht zweimal armieren können.
  const at = isoNow(now());
  state.circuitBreakerLatch.set({ ...trigger, at });

  // ENGAGE: bestehender Kill-Switch-Pfad (in-memory Flag = Wirksamkeit).
  killSwitch.pull(trigger.reason);
  const engaged: CircuitBreakerOutcome = {
    ...base,
    engaged: true,
    latched: true,
    reason: trigger.reason,
    trigger,
  };

  // Revisionssicheres Log der Mutation (best effort, Lücke wird gemeldet).
  try {
    const record =
      deps.recordKillSwitch ??
      ((row: { reason: string; triggeredBy: string; armed: boolean }) =>
        db.insert(killSwitches).values(row).then(() => undefined));
    await record({ reason: trigger.reason, triggeredBy: "AUTO_CIRCUIT_BREAKER", armed: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "kill_switches-Insert fehlgeschlagen";
    errors.push(`kill_switches: ${message}`);
  }

  const detail = {
    reason: trigger.reason,
    trigger: "AUTO_CIRCUIT_BREAKER",
    metric: trigger.metric,
    value: trigger.value,
    limit: trigger.limit,
    triggeredAt: at,
    drawdownPct: input.drawdownPct,
    dailyLossPct: input.dailyLossPct,
    consecutiveLosses: Number.isFinite(consecutiveLosses) ? consecutiveLosses : null,
  };
  try {
    const audit =
      deps.audit ??
      ((d: Record<string, unknown>) =>
        writeAuditRecord({ event: "KILL_SWITCH", level: "CRITICAL", detail: d, auditClass: "security" }).then(
          (outcome) => ({ durable: outcome.durable, error: outcome.error }),
        ));
    engaged.audit = await audit(detail);
    if (engaged.audit && !engaged.audit.durable) {
      const { flagMissedAudit } = await import("./auditSink");
      flagMissedAudit("KILL_SWITCH", { ...detail, via: "circuit-breaker" });
      errors.push("Audit nicht durable — als Lücke gemeldet");
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Audit fehlgeschlagen";
    engaged.audit = { durable: false, error: message };
    errors.push(`Audit: ${message}`);
  }

  // Alert (D3): derselbe Grund, aber menschenlesbar; Debounce verhindert Flut.
  try {
    const emit = deps.emit ?? emitAlert;
    const result = (await emit({
      code: `circuit-breaker:${trigger.metric}`,
      severity: "critical",
      message: `Auto-Circuit-Breaker ausgelöst: ${describeTrigger(trigger)} — Not-Halt aktiv, Re-Arm nur manuell.`,
      meta: {
        reason: trigger.reason,
        metric: trigger.metric,
        value: trigger.value,
        limit: trigger.limit,
        triggeredAt: at,
      },
      at,
    })) as { sent?: boolean; suppressed?: boolean; errors?: string[] } | undefined;
    engaged.alert = {
      sent: result?.sent === true,
      suppressed: result?.suppressed === true,
      errors: Array.isArray(result?.errors) ? (result!.errors as string[]) : [],
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Alert fehlgeschlagen";
    engaged.alert = { sent: false, suppressed: false, errors: [message] };
    errors.push(`Alert: ${message}`);
  }

  return engaged;
}

/** Menschenlesbare Beschreibung des Auslösers (für Alert/Log). */
export function describeTrigger(trigger: CircuitBreakerTrigger): string {
  switch (trigger.metric) {
    case "drawdown":
      return `Drawdown ${(trigger.value * 100).toFixed(2)} % ≥ Limit ${(trigger.limit * 100).toFixed(2)} %`;
    case "dailyLoss":
      return `Tagesverlust ${(trigger.value * 100).toFixed(2)} % ≥ Limit ${(trigger.limit * 100).toFixed(2)} %`;
    case "consecutiveLosses":
      return `${Math.trunc(trigger.value)} Verlust-Closes in Folge ≥ Limit ${Math.trunc(trigger.limit)}`;
  }
}
