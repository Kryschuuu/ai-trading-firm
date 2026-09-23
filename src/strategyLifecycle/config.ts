/**
 * Feature-Flags & Bounds der Strategy-Lifecycle (RMA-P1-05, v1.73.0).
 *
 * Rollout ist feature-geflaggt:
 *   - `off`     (Default): Gate-Prüfung ist ein No-Order-Blocker (kein
 *               Verhaltensbruch für bestehende Paper-/Live-Pfade); State-
 *               Machine und Evidenz-Persistenz bleiben lesbar.
 *   - `monitor`: Gates werden bewertet und auditiert, blockieren aber NICHT
 *               (Rollout-Beobachtung in Paper/Monitor).
 *   - `enforce`: Live-Orders ohne autorisierte Strategieversion/Lifecycle-
 *               Zustand werden abgelehnt (fail-closed).
 *
 * Unbekannter Modus- Wert ⇒ `off` + Warnung (bewusster, rückwärtskompatibler
 * Rollout-Default — kein stilles Enforcen).
 */

export const STRATEGY_LIFECYCLE_MODE_FLAG = "STRATEGY_LIFECYCLE_MODE";
export const STRATEGY_LIFECYCLE_COOLDOWN_FLAG = "STRATEGY_LIFECYCLE_RECOVERY_COOLDOWN_MS";
export const STRATEGY_LIFECYCLE_MIN_FACTOR_FLAG = "STRATEGY_LIFECYCLE_MIN_RISK_FACTOR";

export const STRATEGY_LIFECYCLE_MODES = ["off", "monitor", "enforce"] as const;
export type StrategyLifecycleMode = (typeof STRATEGY_LIFECYCLE_MODES)[number];

export const STRATEGY_LIFECYCLE_BOUNDS = {
  recoveryCooldownMs: [0, 30 * 24 * 60 * 60 * 1000] as const,
  minRiskFactor: [0.05, 1] as const,
} as const;

export const STRATEGY_LIFECYCLE_DEFAULTS = {
  mode: "off" as StrategyLifecycleMode,
  recoveryCooldownMs: 6 * 60 * 60 * 1000,
  minRiskFactor: 0.25,
};

export interface StrategyLifecycleConfig {
  readonly mode: StrategyLifecycleMode;
  readonly recoveryCooldownMs: number;
  readonly minRiskFactor: number;
}

function clamp(v: number, [min, max]: readonly [number, number], fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(Math.max(v, min), max);
}

/**
 * Liest die Konfiguration aus einer Env-Quelle. Unbekannte Modi ⇒ `off`
 * (Warnung auf stderr, nie still `enforce`).
 */
export function strategyLifecycleConfig(
  env: Record<string, string | undefined> = process.env
): StrategyLifecycleConfig {
  const rawMode = (env[STRATEGY_LIFECYCLE_MODE_FLAG] ?? "").trim().toLowerCase();
  let mode: StrategyLifecycleMode = STRATEGY_LIFECYCLE_DEFAULTS.mode;
  if (rawMode !== "") {
    if ((STRATEGY_LIFECYCLE_MODES as readonly string[]).includes(rawMode)) {
      mode = rawMode as StrategyLifecycleMode;
    } else {
      console.warn(
        `[strategy-lifecycle] unbekannter ${STRATEGY_LIFECYCLE_MODE_FLAG}="${rawMode.slice(0, 20)}" → off (fail-safe Default)`
      );
    }
  }

  const cooldownRaw = Number(env[STRATEGY_LIFECYCLE_COOLDOWN_FLAG]);
  const recoveryCooldownMs =
    env[STRATEGY_LIFECYCLE_COOLDOWN_FLAG] === undefined ||
    env[STRATEGY_LIFECYCLE_COOLDOWN_FLAG] === ""
      ? STRATEGY_LIFECYCLE_DEFAULTS.recoveryCooldownMs
      : clamp(cooldownRaw, STRATEGY_LIFECYCLE_BOUNDS.recoveryCooldownMs, STRATEGY_LIFECYCLE_DEFAULTS.recoveryCooldownMs);

  const factorRaw = Number(env[STRATEGY_LIFECYCLE_MIN_FACTOR_FLAG]);
  const minRiskFactor =
    env[STRATEGY_LIFECYCLE_MIN_FACTOR_FLAG] === undefined ||
    env[STRATEGY_LIFECYCLE_MIN_FACTOR_FLAG] === ""
      ? STRATEGY_LIFECYCLE_DEFAULTS.minRiskFactor
      : clamp(factorRaw, STRATEGY_LIFECYCLE_BOUNDS.minRiskFactor, STRATEGY_LIFECYCLE_DEFAULTS.minRiskFactor);

  return Object.freeze({ mode, recoveryCooldownMs, minRiskFactor });
}

/** true = Gates bewerten (monitor ODER enforce). */
export function lifecycleGatesActive(mode: StrategyLifecycleMode): boolean {
  return mode === "monitor" || mode === "enforce";
}

/** true = Gates blockieren Live-Orders. */
export function lifecycleEnforce(mode: StrategyLifecycleMode): boolean {
  return mode === "enforce";
}
