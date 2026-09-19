/**
 * Turn-Budget-Hartdeckel (GAP-08, v1.49.0).
 *
 * Die Routing-Schicht deckelt Tagesverbräuche (Provider/Agent/global,
 * `BudgetTracker`) und Einzelaufrufe (`LLM_MAX_TOKENS`, `LLM_TIMEOUT_MS`).
 * Die Lücke dazwischen: EIN Agenten-Turn kann MEHRERE LLM-Aufrufe enthalten
 * (Hauptaufruf + Eskalations-Retry + Plausibilitäts-Retry). Diese Klasse
 * deckelt den Turn als Ganzes — Token-SUMME und Wall-Clock:
 *
 *   LLM_MAX_TOKENS_PER_TURN (Default 20000, Bounds [1000, 200000])
 *   LLM_MAX_TURN_MS         (Default 120000, Bounds [10000, 900000])
 *
 * Überschreitung → sauberer Abbruch mit strukturiertem Fehler
 * (`TurnBudgetExceededError`, Code `LLM_TURN_BUDGET_EXCEEDED`) + Routing-Audit
 * (`llm-budget:tokens` / `llm-budget:time`, Outcome `budget_blocked` → landet
 * als Sicherheitsklasse in `audit_log`). Teil-Results werden NIEMALS als
 * Erfolg zurückgegeben: Der Fehler propagiert durch den Agenten-Port bis zur
 * Step-Engine (sichtbarer Step-Fehlschlag + `CYCLE_STEP_FAILED`/`CYCLE_FAILED`).
 *
 * Zählung (dokumentierte Näherung): Je `routeChat()`-Aufruf wird der
 * gemeldete Verbrauch (`usage.totalTokens`) gebucht. Provider-interne Retries
 * innerhalb von `chatLlm()` sind unsichtbar und zählen nicht — Cloud-Provider
 * melden ihren Verbrauch zuverlässig, lokale Modelle kosten 0. Die Zeit wird
 * an Aufrufgrenzen geprüft (vor jedem `routeChat`, nicht kontinuierlich).
 *
 * Die Uhr ist injizierbar (Tests) und defaultet auf `Date.now`.
 */

import { envNumber } from "@/lib/env";

/** Token-Summe je Turn (Bounds [1000, 200000]). Kein Vorgängerwert — neu. */
export const LLM_MAX_TOKENS_PER_TURN_DEFAULT = 20000;
export const LLM_MAX_TOKENS_PER_TURN_MIN = 1000;
export const LLM_MAX_TOKENS_PER_TURN_MAX = 200000;

/** Wall-Clock je Turn in ms (Bounds [10000, 900000]). */
export const LLM_MAX_TURN_MS_DEFAULT = 120000;
export const LLM_MAX_TURN_MS_MIN = 10000;
export const LLM_MAX_TURN_MS_MAX = 900000;

export interface TurnBudgetConfig {
  maxTokensPerTurn: number;
  maxTurnMs: number;
}

export function loadTurnBudgetConfig(
  env: Record<string, string | undefined> = process.env,
): TurnBudgetConfig {
  // `envNumber` (GAP-02-Muster): ungesetzt/leer → Default; ungültig oder
  // außerhalb der Bounds → Default/Clamp MIT Warnung (fail-laut, nie still).
  // Beide Flags sind ganzzahlig (`Math.trunc` nach dem lauten Clamp).
  return {
    maxTokensPerTurn: Math.trunc(
      envNumber(
        "LLM_MAX_TOKENS_PER_TURN",
        LLM_MAX_TOKENS_PER_TURN_DEFAULT,
        LLM_MAX_TOKENS_PER_TURN_MIN,
        LLM_MAX_TOKENS_PER_TURN_MAX,
        env,
      ),
    ),
    maxTurnMs: Math.trunc(
      envNumber(
        "LLM_MAX_TURN_MS",
        LLM_MAX_TURN_MS_DEFAULT,
        LLM_MAX_TURN_MS_MIN,
        LLM_MAX_TURN_MS_MAX,
        env,
      ),
    ),
  };
}

export type TurnBudgetExceededReason = "tokens" | "time";

/** Strukturierter Turn-Abbruch — wird NIE in einen Fallback umgewandelt. */
export class TurnBudgetExceededError extends Error {
  readonly code = "LLM_TURN_BUDGET_EXCEEDED" as const;
  readonly reason: TurnBudgetExceededReason;
  readonly tokensUsed: number;
  readonly tokensMax: number;
  readonly elapsedMs: number;
  readonly maxMs: number;

  constructor(
    reason: TurnBudgetExceededReason,
    snapshot: { tokensUsed: number; tokensMax: number; elapsedMs: number; maxMs: number },
  ) {
    super(
      reason === "tokens"
        ? `Turn-Budget überschritten (tokens: ${snapshot.tokensUsed}/${snapshot.tokensMax}). Turn abgebrochen.`
        : `Turn-Budget überschritten (time: ${snapshot.elapsedMs}/${snapshot.maxMs} ms). Turn abgebrochen.`,
    );
    this.name = "TurnBudgetExceededError";
    this.reason = reason;
    this.tokensUsed = snapshot.tokensUsed;
    this.tokensMax = snapshot.tokensMax;
    this.elapsedMs = snapshot.elapsedMs;
    this.maxMs = snapshot.maxMs;
  }
}

/** Audit-Label im Routing-Audit (`audit_log`, Event `MODEL_ROUTING`). */
export function turnBudgetAuditLabel(reason: TurnBudgetExceededReason): string {
  return reason === "tokens" ? "llm-budget:tokens" : "llm-budget:time";
}

export type TurnBudgetClock = () => number;

/**
 * Zählt Token-Verbrauch und Zeit EINES Turns. `consume()`/`checkTime()`
 * werfen bei Überschreitung — exakt am Limit (`used === max`) ist noch OK.
 */
export class TurnBudget {
  readonly config: TurnBudgetConfig;
  private readonly clock: TurnBudgetClock;
  private readonly startedAt: number;
  private used = 0;

  constructor(
    config?: Partial<TurnBudgetConfig>,
    clock: TurnBudgetClock = () => Date.now(),
  ) {
    const base = loadTurnBudgetConfig();
    this.config = {
      maxTokensPerTurn: config?.maxTokensPerTurn ?? base.maxTokensPerTurn,
      maxTurnMs: config?.maxTurnMs ?? base.maxTurnMs,
    };
    this.clock = clock;
    this.startedAt = this.clock();
  }

  get tokensUsed(): number {
    return this.used;
  }

  get elapsedMs(): number {
    return Math.max(0, this.clock() - this.startedAt);
  }

  private snapshot(): {
    tokensUsed: number;
    tokensMax: number;
    elapsedMs: number;
    maxMs: number;
  } {
    return {
      tokensUsed: this.used,
      tokensMax: this.config.maxTokensPerTurn,
      elapsedMs: this.elapsedMs,
      maxMs: this.config.maxTurnMs,
    };
  }

  /** Bucht Token-Verbrauch (≤ 0/NaN wird ignoriert, nie Negativbuchung). */
  consume(tokens: number): void {
    const n =
      typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0
        ? Math.trunc(tokens)
        : 0;
    this.used += n;
    if (this.used > this.config.maxTokensPerTurn) {
      throw new TurnBudgetExceededError("tokens", this.snapshot());
    }
  }

  /** Prüft die Wall-Clock (Aufrufgrenze — kein kontinuierlicher Timer). */
  checkTime(): void {
    if (this.elapsedMs > this.config.maxTurnMs) {
      throw new TurnBudgetExceededError("time", this.snapshot());
    }
  }
}

/** Erzeugt ein Turn-Budget (Env-Konfiguration, injizierbare Uhr für Tests). */
export function createTurnBudget(
  opts: {
    env?: Record<string, string | undefined>;
    clock?: TurnBudgetClock;
    config?: Partial<TurnBudgetConfig>;
  } = {},
): TurnBudget {
  const base = loadTurnBudgetConfig(opts.env ?? process.env);
  return new TurnBudget(
    { ...base, ...(opts.config ?? {}) },
    opts.clock ?? (() => Date.now()),
  );
}
