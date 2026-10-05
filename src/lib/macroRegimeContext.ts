/**
 * Point-in-time reader for the latest completed macro cycle artifact.
 *
 * The cycle stores artifacts under `artifacts/YYYY-MM-DD/daily/`, not
 * `data/cycle/`. This reader follows the configured artifact root/index and
 * uses the newest indexed daily run only when that run is recent and completed.
 * Missing, stale, failed, malformed, or skipped macro output is neutral
 * (factor 1); macro context can never increase risk.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveRuntimePath } from "./appPaths";

const DATE_FOLDER_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MACRO_CONTEXT_MAX_AGE_MS = 24 * 60 * 60_000;
const FUTURE_CLOCK_SKEW_MS = 5 * 60_000;

interface MacroArtifactIndex {
  dailyRuns?: Array<{
    date?: unknown;
    status?: unknown;
    startedAt?: unknown;
    completedAt?: unknown;
  }>;
}

/** Converts a recognized macro volatility regime to a non-increasing factor. */
export function macroVolatilityFactor(regime: unknown): number {
  switch (typeof regime === "string" ? regime.trim().toUpperCase() : "") {
    case "EXTREME":
      return 0.5;
    case "HIGH":
      return 0.75;
    case "LOW":
    case "NORMAL":
    default:
      return 1;
  }
}

function readJson(filePath: string): unknown {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Reads the latest valid macro regime from the cycle artifact index.
 * `rootDir` and `nowMs` are injectable for deterministic tests.
 */
export function readLatestMacroVolatilityFactor(options: { rootDir?: string; nowMs?: number } = {}): number {
  try {
    const root = resolveRuntimePath(
      options.rootDir ?? process.env.CYCLE_ARTIFACTS_DIR ?? process.env.SCANNER_ARTIFACTS_DIR ?? "artifacts",
    );
    const index = readJson(path.join(root, "index.json")) as MacroArtifactIndex | null;
    if (!index || !Array.isArray(index.dailyRuns)) return 1;

    const nowMs = options.nowMs ?? Date.now();
    if (!Number.isFinite(nowMs)) return 1;
    const latest = index.dailyRuns
      .filter((run) => run && typeof run.date === "string" && DATE_FOLDER_RE.test(run.date))
      .map((run) => {
        const hasCompletedAt = run.completedAt !== undefined && run.completedAt !== null;
        const completedAtMs = typeof run.completedAt === "string" ? Date.parse(run.completedAt) : Number.NaN;
        const startedAtMs = typeof run.startedAt === "string" ? Date.parse(run.startedAt) : Number.NaN;
        return {
          date: run.date as string,
          status: run.status,
          timestamp: Number.isFinite(completedAtMs) ? completedAtMs : startedAtMs,
          malformedCompletedAt: hasCompletedAt && !Number.isFinite(completedAtMs),
        };
      })
      .filter((run) => Number.isFinite(run.timestamp))
      .sort(
        (a, b) =>
          b.timestamp - a.timestamp ||
          Number(a.status === "COMPLETED") - Number(b.status === "COMPLETED"),
      )[0];
    if (!latest) return 1;

    // Select the newest indexed run before validating its status/output. If a
    // newer run failed or is malformed, do not silently keep an older macro
    // snapshot authoritative over the risk multiplier.
    if (
      latest.status !== "COMPLETED" ||
      latest.malformedCompletedAt ||
      latest.timestamp > nowMs + FUTURE_CLOCK_SKEW_MS ||
      nowMs - latest.timestamp > MACRO_CONTEXT_MAX_AGE_MS
    ) {
      return 1;
    }
    const artifact = readJson(path.join(root, latest.date, "daily", "02-macro-analyst.json")) as
      | { volatilityRegime?: unknown; plausibility?: { status?: unknown } }
      | null;
    if (!artifact || artifact.plausibility?.status === "SKIPPED") return 1;
    const regime = artifact.volatilityRegime;
    if (typeof regime === "string" && ["LOW", "NORMAL", "HIGH", "EXTREME"].includes(regime.toUpperCase())) {
      return macroVolatilityFactor(regime);
    }
  } catch {
    // Bad local state must not crash the adaptive-risk scheduler.
  }
  return 1;
}
