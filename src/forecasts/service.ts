/**
 * Forecast-Service — Produktionsverdrahtung (RMA-P3-01, v1.55.0).
 *
 * Bindet die reinen Bausteine (Capture-Policy, Scoring, Resolver) an die
 * Infrastruktur: Postgres-Ledger, Kerzen-Store, Market-Data-Fetch, adaptives
 * Regime, Audit und Telemetrie.
 *
 * ── Feature-Flag ────────────────────────────────────────────────────────────
 * `FORECAST_LEDGER_ENABLED` (Default `true`): bei `false` finden weder
 * Capture noch Resolver-Läufe statt; bestehende Ledger-Daten bleiben lesbar.
 * Das ist der dokumentierte Rollback-Pfad (siehe `docs/FORECASTS.md`).
 *
 * ── Risikoneutralität ───────────────────────────────────────────────────────
 * Der Ledger ist ein reiner Auswertungspfad: Er verändert keine Risk-Ceilings,
 * Kill-Switches, Authority Chains oder Live-Gates und nimmt keinen Einfluss
 * auf Order- oder Approval-Pfade.
 */

import { getAdaptiveRiskStatus } from "../lib/adaptiveRisk";
import { auditWrite } from "../lib/auditSink";
import { envInt } from "../lib/env";
import { structuredLog } from "../lib/logger";
import { getCandles } from "../lib/marketData";
import { MarketDataFetchError } from "../lib/marketDataErrors";
import { metricLabel, telemetry } from "../lib/telemetry";
import { forecastFromAnalysis, referenceTimeOf, type ForecastCaptureSkipReason } from "./capture";
import { DrizzleForecastLedger, ForecastLedgerError } from "./ledger";
import { buildScoreReport, type ScoreQuery, type ScoreReport } from "./metrics";
import { HistoricalStoreOutcomeSource } from "./outcomeSource";
import type { DueForecast, ForecastLedgerPort, OutcomeDataWritePort } from "./ports";
import {
  reResolveForecast,
  runForecastResolution,
  voidForecastByOperator,
  type ForecastResolverDeps,
  type OperatorResolutionInput,
  type ResolverRunResult,
} from "./resolver";
import { FORECAST_LIMITS, FORECAST_TIMEFRAME_MS } from "./types";

/** Env-Flag: Capture und Resolver aktiv (Default `true`; `false` = Rollback). */
export const FORECAST_LEDGER_ENABLED_ENV = "FORECAST_LEDGER_ENABLED";
/** Env-Flag: Takt des Resolver-Jobs in Minuten. */
export const FORECAST_RESOLVER_INTERVAL_ENV = "FORECAST_RESOLVER_INTERVAL_MIN";
/** Env-Flag: Mindeststichprobe je Score-Segment. */
export const FORECAST_MIN_SAMPLE_ENV = "FORECAST_MIN_SAMPLE";

export function forecastLedgerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[FORECAST_LEDGER_ENABLED_ENV];
  if (raw === undefined || raw.trim() === "") return true;
  return raw.trim().toLowerCase() !== "false" && raw.trim() !== "0";
}

export function forecastMinSample(env: Record<string, string | undefined> = process.env): number {
  return envInt(FORECAST_MIN_SAMPLE_ENV, FORECAST_LIMITS.minSampleDefault, 5, 1000, env);
}

// ─────────────────────────────────────────────────────────────────────────────
// Singletons (injizierbar für Tests)
// ─────────────────────────────────────────────────────────────────────────────

const GLOBAL = globalThis as typeof globalThis & {
  __forecastLedger?: DrizzleForecastLedger;
  __forecastOutcomeSource?: HistoricalStoreOutcomeSource;
  __forecastResolverBusy?: boolean;
};

export function getForecastLedger(): DrizzleForecastLedger {
  GLOBAL.__forecastLedger ??= new DrizzleForecastLedger();
  return GLOBAL.__forecastLedger;
}

export function getForecastOutcomeSource(): HistoricalStoreOutcomeSource {
  GLOBAL.__forecastOutcomeSource ??= new HistoricalStoreOutcomeSource();
  return GLOBAL.__forecastOutcomeSource;
}

/** Test-Reset der Singletons. */
export function resetForecastServiceForTests(): void {
  delete GLOBAL.__forecastLedger;
  delete GLOBAL.__forecastOutcomeSource;
  GLOBAL.__forecastResolverBusy = false;
}

export function forecastResolverDeps(): ForecastResolverDeps {
  return {
    ledger: getForecastLedger(),
    outcomeRead: getForecastOutcomeSource(),
    outcomeWrite: getForecastOutcomeSource(),
    fetchLiveBars: async (symbol, timeframe, limit) => {
      const candles = await getCandles(symbol, timeframe, limit);
      return candles.map((candle) => ({ ...candle }));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capture-Hook (aus dem Analystenpfad)
// ─────────────────────────────────────────────────────────────────────────────

export interface AnalystCaptureInput {
  role: string;
  symbol: unknown;
  view: unknown;
  confidence: unknown;
  promptVersion: number;
  model: string;
  asOf?: Date;
}

export interface AnalystCaptureResult {
  captured: boolean;
  forecastId?: string;
  reason?: ForecastCaptureSkipReason | "DISABLED";
  /** `true`, wenn der Forecast bereits existierte (Idempotenz-Treffer). */
  duplicate?: boolean;
}

/** Kanonische Paper-Entity eines Analysten-Symbols (Watchlist-Konvention). */
export function paperEntityIdOf(symbol: string): string {
  return `PAPER:${symbol.trim().toUpperCase()}`;
}

/**
 * Quelle der Referenzkerze: liefert die letzte vor `asOf` geschlossene
 * 1h-Kerze des Symbols sowie die geladenen Nachbarkerzen. Die Nachbarkerzen
 * schreibt der Capture-Pfad in den Outcome-Store, damit die Auflösung sie
 * später mit echter Verfügbarkeit (`fetchedAt`) vorfindet. Injektion für
 * Tests; Produktion nutzt `getCandles`.
 */
export type ForecastReferenceProvider = (
  symbol: string,
  asOf: Date
) => Promise<{ referenceClose: number | null; referenceTime: Date | null; bars: readonly { time: number; open: number; high: number; low: number; close: number; volume: number }[] }>;

/**
 * Produktions-Referenzquelle: derselbe Kerzenpfad wie der Analyst
 * (`getCandles`, 1h). Rein lesend — die Persistenz übernimmt der
 * Capture-Pfad (append-only, idempotent).
 */
export function defaultReferenceProvider(): ForecastReferenceProvider {
  return async (symbol, asOf) => {
    try {
      const candles = await getCandles(symbol, "1h", 3);
      const asOfMs = asOf.getTime();
      let best: { closeAt: number; close: number } | null = null;
      for (const candle of candles) {
        const closeAt = candle.time + FORECAST_TIMEFRAME_MS;
        if (closeAt <= asOfMs && (best === null || closeAt > best.closeAt)) {
          best = { closeAt, close: candle.close };
        }
      }
      if (best !== null && Number.isFinite(best.close) && best.close > 0) {
        return {
          referenceClose: best.close,
          referenceTime: new Date(best.closeAt),
          bars: candles.map((candle) => ({ ...candle })),
        };
      }
      return { referenceClose: null, referenceTime: null, bars: candles.map((candle) => ({ ...candle })) };
    } catch (error) {
      const reason = error instanceof MarketDataFetchError ? error.reason : "UNKNOWN";
      structuredLog("warn", "forecast_capture_reference_failed", {
        symbol: metricLabel(symbol),
        reason: metricLabel(reason),
      });
      return { referenceClose: null, referenceTime: null, bars: [] };
    }
  };
}

/**
 * Erfasst eine Analysten-Ausgabe als Forecast (sofern die Policy `fp1` einen
 * gültigen Vertrag zulässt) und stellt die Referenzkerze in den Kerzen-Store.
 *
 * Fail-closed: jeder Fehlschlag liefert `captured: false` mit geschlossenem
 * Grund und Telemetrie — der Analystenpfad selbst läuft unverändert weiter
 * (der Ledger ist additiv und risikoneutral).
 */
export async function captureAnalystForecast(
  input: AnalystCaptureInput,
  deps: {
    ledger?: ForecastLedgerPort;
    outcomeSource?: OutcomeDataWritePort;
    regimeProvider?: () => string;
    referenceProvider?: ForecastReferenceProvider;
    enabled?: boolean;
  } = {}
): Promise<AnalystCaptureResult> {
  if (deps.enabled === false || (deps.enabled === undefined && !forecastLedgerEnabled())) {
    telemetry.forecasts.captures.inc({ result: "skipped", reason: "disabled" });
    return { captured: false, reason: "DISABLED" };
  }
  const asOf = input.asOf ?? new Date();
  const ledger = deps.ledger ?? getForecastLedger();
  const outcomeSource = deps.outcomeSource ?? getForecastOutcomeSource();
  const referenceProvider = deps.referenceProvider ?? defaultReferenceProvider();
  const regime = deps.regimeProvider
    ? deps.regimeProvider()
    : (getAdaptiveRiskStatus()?.regime ?? "UNKNOWN");

  const symbolOk = typeof input.symbol === "string" && input.symbol.trim().length > 0;
  // Referenzkerze: letzte vor `asOf` geschlossene Kerze. Fehlt sie, entsteht
  // KEIN Forecast (fail-closed: kein Vertrag ohne Event-Basis).
  let referenceClose: number | null = null;
  let referenceTime: Date | null = null;
  if (symbolOk) {
    const reference = await referenceProvider(String(input.symbol), asOf);
    referenceClose = reference.referenceClose;
    referenceTime = reference.referenceTime;
    // Geladene Kerzen in den Outcome-Store schreiben (idempotent), damit die
    // Auflösung sie später mit echter Verfügbarkeit vorfindet. Ein Schreibfehler
    // verhindert den Forecast nicht — die Auflösung entscheidet später
    // fail-closed über die tatsächlich vorhandenen Daten.
    if (reference.bars.length > 0) {
      try {
        await outcomeSource.appendBars(paperEntityIdOf(String(input.symbol)), "1h", reference.bars, asOf);
      } catch (error) {
        structuredLog("warn", "forecast_capture_store_append_failed", {
          symbol: metricLabel(input.symbol),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const built = forecastFromAnalysis({
    role: input.role,
    symbol: input.symbol,
    view: input.view,
    confidence: input.confidence,
    asOf,
    referenceClose,
    referenceTime,
    entityId: symbolOk ? paperEntityIdOf(String(input.symbol)) : null,
    promptVersion: input.promptVersion,
    model: input.model,
    regime,
  });
  if (!built.ok) {
    telemetry.forecasts.captures.inc({ result: "skipped", reason: metricLabel(built.reason) });
    return { captured: false, reason: built.reason };
  }

  try {
    const result = await ledger.recordForecast(built.contract, {
      source: "analyst",
      role: built.contract.agentRole,
      symbolRaw: typeof input.symbol === "string" ? input.symbol.slice(0, 24) : null,
      reference: {
        closeTimeMs: built.contract.referenceTime.getTime(),
        close: built.contract.referenceClose,
        timeframe: built.contract.timeframe,
      },
      regime: built.contract.regime,
    });
    telemetry.forecasts.captures.inc({ result: result.created ? "captured" : "duplicate" });
    return { captured: true, forecastId: result.forecastId, duplicate: !result.created };
  } catch (error) {
    // Ledger-Störung darf den Analystenpfad nicht brechen — bleibt laut.
    const code = error instanceof ForecastLedgerError ? error.code : "capture:db-error";
    telemetry.forecasts.captures.inc({ result: "failed", reason: metricLabel(code) });
    structuredLog("warn", "forecast_capture_failed", {
      role: built.contract.agentRole,
      entityId: built.contract.entityId,
      code,
    });
    await auditWrite(
      "FORECAST_CAPTURE_FAILED",
      "WARN",
      { role: built.contract.agentRole, entityId: built.contract.entityId, code },
      { missionId: undefined, agentId: undefined }
    ).catch(() => {
      // Audit-Ausfall ist selbst meldepflichtig — die Senke zählt und loggt
      // intern (auditSink); hier wird zusätzlich der Capture-Fehler nicht
      // überdeckt.
      structuredLog("warn", "forecast_capture_audit_failed", { code });
    });
    return { captured: false, reason: "INVALID_CONTRACT" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver-Job (Scheduler/API)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Führt einen Resolver-Lauf aus — mit Überlappungsschutz (ein Lauf zugleich
 * je Prozess). Bei deaktiviertem Ledger passiert nichts (Rollback-Pfad).
 */
export async function runForecastResolverJob(options: { limit?: number } = {}): Promise<ResolverRunResult | null> {
  if (!forecastLedgerEnabled()) return null;
  if (GLOBAL.__forecastResolverBusy) return null;
  GLOBAL.__forecastResolverBusy = true;
  try {
    return await runForecastResolution(forecastResolverDeps(), options);
  } finally {
    GLOBAL.__forecastResolverBusy = false;
  }
}

/** Operator-Re-Resolution (versioniert, nie stille Mutation). */
export function operatorReResolve(input: OperatorResolutionInput): ReturnType<typeof reResolveForecast> {
  return reResolveForecast(forecastResolverDeps(), input);
}

/** Operator-VOID mit geschlossenem Grund. */
export function operatorVoid(
  input: OperatorResolutionInput & { voidReason: string }
): ReturnType<typeof voidForecastByOperator> {
  return voidForecastByOperator(forecastResolverDeps(), input);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lese-/Berichtspfad
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score-Bericht über bounded gefilterte Forecasts. Wirft
 * `ForecastReportError`/`ForecastLedgerError` bei ungültigen oder zu breiten
 * Anfragen (laut, nie still gekürzt).
 */
export async function forecastScoreReport(
  query: ScoreQuery,
  deps: { ledger?: Pick<DrizzleForecastLedger, "queryForecasts"> } = {}
): Promise<ScoreReport> {
  const ledger = deps.ledger ?? getForecastLedger();
  const now = query.now ?? new Date();
  const limit = Math.min(FORECAST_LIMITS.maxScoreForecasts, Math.max(1, Math.floor(query.limit ?? 5000)));
  const { rows, truncated } = await ledger.queryForecasts(
    {
      agentRole: query.agentRole,
      entityId: query.entityId,
      horizonId: query.horizonId,
      regime: query.regime,
      promptVersion: query.promptVersion,
      fromAsOf: query.fromAsOf,
      toAsOf: query.toAsOf,
    },
    limit
  );
  telemetry.forecasts.queries.inc({ result: truncated ? "truncated" : "ok" });
  return buildScoreReport(rows, {
    truncated,
    minSample: query.minSample ?? forecastMinSample(),
    now,
    filters: query,
  });
}

/** Bounded Forecast-Liste mit Wirksstatus (Betrieb/Debugging). */
export async function forecastList(
  filter: Parameters<DrizzleForecastLedger["queryForecasts"]>[0],
  limit: number
): Promise<{ rows: DueForecast[]; truncated: boolean }> {
  const ledger = getForecastLedger();
  const bounded = Math.min(FORECAST_LIMITS.maxListLimit, Math.max(1, Math.floor(limit)));
  return ledger.queryForecasts(filter, bounded);
}

/** Betriebsstatus: Wasserstand, Lag, jüngster Lauf. */
export async function forecastOperationsStatus(): Promise<{
  enabled: boolean;
  cursor: { watermarkDeadline: Date; lastRunId: string | null } | null;
  overdue: { forecastId: string; availabilityDeadline: Date; lagMs: number } | null;
}> {
  const enabled = forecastLedgerEnabled();
  const ledger = getForecastLedger();
  const cursor = await ledger.readCursor();
  const now = new Date();
  const due = await ledger.dueForecasts(now, 1);
  const oldest = due[0];
  return {
    enabled,
    cursor,
    overdue: oldest
      ? {
          forecastId: oldest.forecastId,
          availabilityDeadline: oldest.contract.availabilityDeadline,
          lagMs: Math.max(0, now.getTime() - oldest.contract.availabilityDeadline.getTime()),
        }
      : null,
  };
}
