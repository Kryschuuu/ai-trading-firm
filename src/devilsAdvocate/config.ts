/**
 * Konfiguration und Schwellenwerte für den Devil's-Advocate-Agenten (RMA-P3-03, v1.66.0).
 */

import type { DevilsAdvocateConfig } from "./types";

export const DEVILS_ADVOCATE_ENABLED_ENV = "DEVILS_ADVOCATE_ENABLED" as const;
export const DEVILS_ADVOCATE_SHADOW_ENV = "DEVILS_ADVOCATE_SHADOW" as const;

export const DEFAULT_DEVILS_ADVOCATE_CONFIG: DevilsAdvocateConfig = {
  enabled: true,
  shadowMode: false,
  scaleDownThreshold: 0.40,
  humanReviewThreshold: 0.70,
  scaleDownFactor: 0.50,
  maxRiskBudgetPct: 0.02,
};

function parseBooleanEnv(val: string | undefined, fallback: boolean): boolean {
  if (val === undefined || val === "") return fallback;
  const lower = val.trim().toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes" || lower === "on") return true;
  if (lower === "false" || lower === "0" || lower === "no" || lower === "off") return false;
  return fallback;
}

function parseNumberEnv(val: string | undefined, fallback: number, min: number, max: number): number {
  if (val === undefined || val === "") return fallback;
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

export function loadDevilsAdvocateConfig(env: Record<string, string | undefined> = process.env): DevilsAdvocateConfig {
  const enabled = parseBooleanEnv(env[DEVILS_ADVOCATE_ENABLED_ENV], DEFAULT_DEVILS_ADVOCATE_CONFIG.enabled);
  const shadowMode = parseBooleanEnv(env[DEVILS_ADVOCATE_SHADOW_ENV], DEFAULT_DEVILS_ADVOCATE_CONFIG.shadowMode);

  const scaleDownThreshold = parseNumberEnv(
    env.DEVILS_ADVOCATE_SCALE_DOWN_THRESHOLD,
    DEFAULT_DEVILS_ADVOCATE_CONFIG.scaleDownThreshold,
    0.1,
    0.9
  );

  const humanReviewThreshold = parseNumberEnv(
    env.DEVILS_ADVOCATE_HUMAN_REVIEW_THRESHOLD,
    DEFAULT_DEVILS_ADVOCATE_CONFIG.humanReviewThreshold,
    scaleDownThreshold,
    1.0
  );

  const scaleDownFactor = parseNumberEnv(
    env.DEVILS_ADVOCATE_SCALE_DOWN_FACTOR,
    DEFAULT_DEVILS_ADVOCATE_CONFIG.scaleDownFactor,
    0.1,
    0.9
  );

  return {
    enabled,
    shadowMode,
    scaleDownThreshold,
    humanReviewThreshold,
    scaleDownFactor,
    maxRiskBudgetPct: DEFAULT_DEVILS_ADVOCATE_CONFIG.maxRiskBudgetPct,
  };
}
