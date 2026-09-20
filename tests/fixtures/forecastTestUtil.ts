/**
 * Test-Hilfen für das Forecast-Ledger (RMA-P3-01, v1.55.0).
 *
 * In-Memory-Implementierungen der Ledger-/Outcome-Ports mit denselben
 * Garantien wie die Produktion (Idempotenzschlüssel, Versionierung,
 * Fail-closed) — damit Resolver- und Metrik-Tests deterministisch und ohne
 * Datenbank laufen. Die DB-Variante wird zusätzlich in
 * `tests/forecastLedger.db.test.ts` gegen eingebettetes Postgres geprüft.
 */

import { forecastIdempotencyKey, resolutionOutcomeHash } from "../../src/forecasts/hashes";
import type {
  DueForecast,
  ForecastLedgerPort,
  OutcomeBar,
  OutcomeDataReadPort,
  OutcomeDataWritePort,
} from "../../src/forecasts/ports";
import { effectiveStatus } from "../../src/forecasts/ledger";
import {
  FORECAST_CATEGORIES,
  FORECAST_CONTRACT_VERSION,
  FORECAST_RESOLUTION_POLICY_VERSION,
  FORECAST_SETTLE_GRACE_MS,
  FORECAST_TARGET_CATEGORY,
  FORECAST_TARGET_KIND,
  FORECAST_TIMEFRAME,
  type ForecastContract,
  type ForecastResolution,
  type ForecastVoidReason,
  type ResolutionCounts,
} from "../../src/forecasts/types";
import type { LiveBar } from "../../src/forecasts/resolver";

/** Montag, 2026-09-07T00:00:00Z — fester Bezugspunkt aller Forecast-Tests. */
export const FC_T0 = Date.parse("2026-09-07T00:00:00.000Z");
export const FC_HOUR = 3_600_000;

let forecastSeq = 0;

/** Deterministischer Testvertrag (binär, 4h-Horizont). */
export function testContract(overrides: Partial<ForecastContract> = {}): ForecastContract {
  forecastSeq += 1;
  const asOfMs = overrides.asOf?.getTime() ?? FC_T0 + 30 * 60_000; // 00:30
  const referenceMs = Math.floor(asOfMs / FC_HOUR) * FC_HOUR;
  const resolvesMs = overrides.resolvesAt?.getTime() ?? referenceMs + 4 * FC_HOUR;
  return {
    agentRole: "TECHNICAL_ANALYST",
    promptVersion: 1,
    model: "test-model",
    entityType: "instrument",
    entityId: overrides.entityId ?? "PAPER:TEST",
    symbol: overrides.symbol ?? "TEST",
    targetKind: FORECAST_TARGET_KIND,
    categories: FORECAST_CATEGORIES,
    probabilities: overrides.probabilities ?? [0.3, 0.7],
    targetCategory: FORECAST_TARGET_CATEGORY,
    horizonId: overrides.horizonId ?? "4h",
    timeframe: FORECAST_TIMEFRAME,
    asOf: new Date(asOfMs),
    referenceTime: new Date(referenceMs),
    referenceClose: overrides.referenceClose ?? 100,
    resolvesAt: new Date(resolvesMs),
    availabilityDeadline: new Date(resolvesMs + FORECAST_SETTLE_GRACE_MS),
    regime: overrides.regime ?? "UNKNOWN",
    policyVersion: FORECAST_RESOLUTION_POLICY_VERSION,
    contractVersion: FORECAST_CONTRACT_VERSION,
    ...overrides,
  };
}

interface StoredResolution extends ForecastResolution {
  id: string;
}

/** In-Memory-Ledger mit Produktionsgarantien (Idempotenz, Versionierung). */
export class InMemoryForecastLedger implements ForecastLedgerPort {
  private forecasts = new Map<string, { contract: ForecastContract; sourceManifest: Record<string, unknown> }>();
  private byKey = new Map<string, string>();
  private resolutions = new Map<string, StoredResolution[]>();
  private cursor: { watermarkDeadline: Date; lastRunId: string | null } | null = null;
  private runs = new Map<string, string>();
  private runSeq = 0;
  /** Fehlerinjektion für Retry-/Restart-Tests. */
  failNextAppend: Error | null = null;

  async recordForecast(
    contract: ForecastContract,
    sourceManifest: Readonly<Record<string, unknown>>
  ): Promise<{ created: boolean; forecastId: string }> {
    const key = forecastIdempotencyKey(contract);
    const existing = this.byKey.get(key);
    if (existing) return { created: false, forecastId: existing };
    forecastSeq += 1;
    const id = `fc-${forecastSeq.toString().padStart(6, "0")}`;
    this.forecasts.set(id, { contract, sourceManifest: { ...sourceManifest } });
    this.byKey.set(key, id);
    return { created: true, forecastId: id };
  }

  async appendResolution(draft: {
    forecastId: string;
    status: "RESOLVED" | "VOID";
    outcomeIndex: number | null;
    outcomeLabel: string | null;
    outcomeBinary: 0 | 1 | null;
    referenceClose: number | null;
    outcomeClose: number | null;
    voidReason: ForecastVoidReason | null;
    resolutionKind: "AUTOMATIC" | "OPERATOR";
    resolvedAt: Date;
    policyVersion: string;
    outcomeManifest: Readonly<Record<string, unknown>>;
  }): Promise<{ created: boolean; resolutionVersion: number; outcomeHash: string }> {
    if (!this.forecasts.has(draft.forecastId)) {
      throw new Error(`forecast:not-found: ${draft.forecastId}`);
    }
    if (this.failNextAppend) {
      const error = this.failNextAppend;
      this.failNextAppend = null;
      throw error;
    }
    const datasetHash = typeof draft.outcomeManifest.datasetHash === "string" ? draft.outcomeManifest.datasetHash : null;
    const outcomeHash = resolutionOutcomeHash({
      forecastId: draft.forecastId,
      status: draft.status,
      outcomeIndex: draft.outcomeIndex,
      voidReason: draft.voidReason,
      referenceClose: draft.referenceClose,
      outcomeClose: draft.outcomeClose,
      datasetHash,
      policyVersion: draft.policyVersion,
    });
    const list = this.resolutions.get(draft.forecastId) ?? [];
    const same = list.find((r) => r.outcomeHash === outcomeHash);
    if (same) return { created: false, resolutionVersion: same.resolutionVersion, outcomeHash };
    const version = list.length > 0 ? Math.max(...list.map((r) => r.resolutionVersion)) + 1 : 1;
    const stored: StoredResolution = {
      id: `fr-${draft.forecastId}-${version}`,
      forecastId: draft.forecastId,
      resolutionVersion: version,
      status: draft.status,
      outcome:
        draft.status === "RESOLVED" && draft.outcomeIndex !== null
          ? {
              outcomeIndex: draft.outcomeIndex,
              outcomeLabel: (draft.outcomeLabel ?? "") as "UP" | "DOWN",
              outcomeBinary: draft.outcomeBinary ?? 0,
              referenceClose: draft.referenceClose ?? Number.NaN,
              outcomeClose: draft.outcomeClose ?? Number.NaN,
            }
          : null,
      voidReason: draft.voidReason,
      resolutionKind: draft.resolutionKind,
      resolvedAt: draft.resolvedAt,
      policyVersion: draft.policyVersion,
      outcomeManifest: { ...draft.outcomeManifest },
      outcomeHash,
    };
    list.push(stored);
    this.resolutions.set(draft.forecastId, list);
    return { created: true, resolutionVersion: version, outcomeHash };
  }

  async dueForecasts(now: Date, limit: number): Promise<DueForecast[]> {
    const out: DueForecast[] = [];
    for (const [forecastId, entry] of this.forecasts) {
      if ((this.resolutions.get(forecastId) ?? []).length > 0) continue;
      if (entry.contract.availabilityDeadline.getTime() > now.getTime()) continue;
      out.push({ forecastId, contract: entry.contract, latestResolution: null, status: "PENDING" });
    }
    out.sort((a, b) => a.contract.availabilityDeadline.getTime() - b.contract.availabilityDeadline.getTime());
    return out.slice(0, limit);
  }

  async maturingForecasts(now: Date, limit: number): Promise<DueForecast[]> {
    const out: DueForecast[] = [];
    for (const [forecastId, entry] of this.forecasts) {
      if ((this.resolutions.get(forecastId) ?? []).length > 0) continue;
      const c = entry.contract;
      if (c.resolvesAt.getTime() <= now.getTime() && now.getTime() < c.availabilityDeadline.getTime()) {
        out.push({ forecastId, contract: c, latestResolution: null, status: "PENDING" });
      }
    }
    out.sort((a, b) => a.contract.resolvesAt.getTime() - b.contract.resolvesAt.getTime());
    return out.slice(0, limit);
  }

  async loadForecast(forecastId: string): Promise<DueForecast | null> {
    const entry = this.forecasts.get(forecastId);
    if (!entry) return null;
    const list = this.resolutions.get(forecastId) ?? [];
    const latest = list.length > 0 ? list[list.length - 1] : null;
    return {
      forecastId,
      contract: entry.contract,
      latestResolution: latest,
      status: effectiveStatus(latest),
    };
  }

  async queryForecasts(
    filter: {
      agentRole?: string;
      entityId?: string;
      horizonId?: string;
      regime?: string;
      promptVersion?: number;
      fromAsOf?: Date;
      toAsOf?: Date;
    },
    limit: number
  ): Promise<{ rows: DueForecast[]; truncated: boolean }> {
    const matched: { createdAtMs: number; due: DueForecast }[] = [];
    for (const [forecastId, entry] of this.forecasts) {
      const c = entry.contract;
      if (filter.agentRole !== undefined && c.agentRole !== filter.agentRole) continue;
      if (filter.entityId !== undefined && c.entityId !== filter.entityId) continue;
      if (filter.horizonId !== undefined && c.horizonId !== filter.horizonId) continue;
      if (filter.regime !== undefined && c.regime !== filter.regime) continue;
      if (filter.promptVersion !== undefined && c.promptVersion !== filter.promptVersion) continue;
      if (filter.fromAsOf !== undefined && c.asOf.getTime() < filter.fromAsOf.getTime()) continue;
      if (filter.toAsOf !== undefined && c.asOf.getTime() > filter.toAsOf.getTime()) continue;
      const list = this.resolutions.get(forecastId) ?? [];
      const latest = list.length > 0 ? list[list.length - 1] : null;
      matched.push({
        createdAtMs: c.asOf.getTime(),
        due: { forecastId, contract: c, latestResolution: latest, status: effectiveStatus(latest) },
      });
    }
    matched.sort((a, b) => b.createdAtMs - a.createdAtMs);
    const truncated = matched.length > limit;
    return { rows: matched.slice(0, limit).map((m) => m.due), truncated };
  }

  /** Alle gespeicherten Resolutionen eines Forecasts (Testintrospektion). */
  resolutionsOf(forecastId: string): readonly StoredResolution[] {
    return this.resolutions.get(forecastId) ?? [];
  }

  /** Anzahl gespeicherter Forecasts (Testintrospektion). */
  forecastCount(): number {
    return this.forecasts.size;
  }

  async advanceCursor(deadline: Date, runId: string | null): Promise<Date> {
    if (this.cursor === null || deadline.getTime() > this.cursor.watermarkDeadline.getTime()) {
      this.cursor = { watermarkDeadline: deadline, lastRunId: runId };
    } else {
      this.cursor = { ...this.cursor, lastRunId: runId };
    }
    return this.cursor.watermarkDeadline;
  }

  async readCursor(): Promise<{ watermarkDeadline: Date; lastRunId: string | null } | null> {
    return this.cursor;
  }

  async recordRun(manifest: {
    idempotencyKey: string;
    mode: "AUTOMATIC" | "OPERATOR";
    status: "SUCCEEDED" | "FAILED";
    counts: ResolutionCounts;
    cursorBefore: { watermarkDeadline: Date | null };
    cursorAfter: { watermarkDeadline: Date | null };
    codeVersion: string;
    errorCode: string | null;
    startedAt: Date;
    finishedAt: Date;
  }): Promise<{ created: boolean; runId: string }> {
    const existing = this.runs.get(manifest.idempotencyKey);
    if (existing) return { created: false, runId: existing };
    this.runSeq += 1;
    const id = `run-${this.runSeq.toString().padStart(4, "0")}`;
    this.runs.set(manifest.idempotencyKey, id);
    return { created: true, runId: id };
  }

  runCount(): number {
    return this.runs.size;
  }
}

/** In-Memory-Kerzen-Store mit fetchedAt-Provenienz (Outcome-Daten). */
export class InMemoryOutcomeStore implements OutcomeDataReadPort, OutcomeDataWritePort {
  private bars = new Map<string, Map<number, OutcomeBar>>();
  /** Fehlerinjektion für Feed-/Load-Tests. */
  failNextLoad: Error | null = null;

  private key(entityId: string, timeframe: string): string {
    return `${entityId}\u0000${timeframe}`;
  }

  async loadBars(entityId: string, timeframe: string, fromMs: number, toMs: number): Promise<OutcomeBar[]> {
    if (this.failNextLoad) {
      const error = this.failNextLoad;
      this.failNextLoad = null;
      throw error;
    }
    const series = this.bars.get(this.key(entityId, timeframe));
    if (!series) return [];
    return [...series.values()]
      .filter((bar) => bar.closeTimeMs >= fromMs && bar.closeTimeMs <= toMs)
      .sort((a, b) => a.closeTimeMs - b.closeTimeMs);
  }

  async appendBars(
    entityId: string,
    timeframe: string,
    bars: readonly LiveBar[],
    now: Date
  ): Promise<{ written: number; deduplicated: number; invalid: number }> {
    const tfMs = 3_600_000;
    const key = this.key(entityId, timeframe);
    const series = this.bars.get(key) ?? new Map<number, OutcomeBar>();
    let written = 0;
    let deduplicated = 0;
    let invalid = 0;
    for (const bar of bars) {
      if (!Number.isFinite(bar.close) || bar.close <= 0 || !Number.isInteger(bar.time)) {
        invalid += 1;
        continue;
      }
      const closeTimeMs = bar.time + tfMs;
      const existing = series.get(closeTimeMs);
      const next: OutcomeBar = {
        closeTimeMs,
        openTimeMs: bar.time,
        close: bar.close,
        volume: bar.volume,
        fetchedAtMs: now.getTime(),
      };
      if (existing && existing.close === next.close && existing.volume === next.volume) {
        deduplicated += 1;
        continue;
      }
      series.set(closeTimeMs, next);
      written += 1;
    }
    this.bars.set(key, series);
    return { written, deduplicated, invalid };
  }

  /** Testintrospektion: Anzahl Kerzen einer Reihe. */
  barCount(entityId: string, timeframe: string): number {
    return this.bars.get(this.key(entityId, timeframe))?.size ?? 0;
  }
}

/** Kerze als LiveBar (Startzeit-basiert, wie getCandles sie liefert). */
export function barOf(closeTimeMs: number, close: number, volume = 1000, openOffset = FC_HOUR): LiveBar {
  return {
    time: closeTimeMs - openOffset,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume,
  };
}
