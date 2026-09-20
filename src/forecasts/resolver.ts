/**
 * Idempotenter, bounded Outcome-Resolver (RMA-P3-01, v1.55.0).
 *
 * Der Resolver löst ausschließlich FÄLLIGE Forecasts auf und verwendet dafür
 * nur Kerzen, die innerhalb der Verfügbarkeits-Deadline des Forecasts im
 * Store standen (`fetchedAt <= availability_deadline`). Später eintreffende
 * oder korrigierte Kerzen sind für die Erstauflösung unsichtbar — kein
 * Look-ahead über den Outcome-Cutoff, keine stille Mutation.
 *
 * ── Ablauf eines automatischen Laufs ────────────────────────────────────────
 *   1. Feed-Phase: Forecasts im Fenster `resolves_at <= now < deadline`
 *      bekommen aktuelle Kerzen in den Store geschrieben (idempotent), damit
 *      die Outcome-Kerze bis zur Deadline nachweisbar verfügbar ist.
 *   2. Resolve-Phase: Forecasts mit `deadline <= now` werden aus dem Store
 *      bewertet (RESOLVED, VOID oder weiterhin PENDING bei strukturellen
 *      Lücken ⇒ laut gezählt, nie als Outcome gebucht).
 *   3. Wasserstand, Lauf-Manifest, Audit und Telemetrie.
 *
 * ── Idempotenz und Restart ──────────────────────────────────────────────────
 * Jede Auflösung trägt einen Outcome-Hash; ein identisches Ergebnis wird beim
 * zweiten Schreiben nicht dupliziert (`created: false`). Ein abweichendes
 * Ergebnis entsteht ausschließlich über eine neue Resolution-Version
 * (Operator/Re-Resolution). Ein abgebrochener Lauf darf daher jederzeit neu
 * gestartet werden.
 *
 * ── Fail-closed ─────────────────────────────────────────────────────────────
 * Fehlende, unbrauchbare oder verspätete Daten erzeugen VOID mit geschlossenem
 * Grund oder verbleiben als PENDING — niemals werden sie als „0“ oder
 * „falsch“ gebucht. Einzelne Fehler brechen den Lauf nicht ab; sie werden
 * gezählt, geloggt und im Lauf-Manifest berichtet.
 */

import { APP_VERSION } from "../lib/version";
import { structuredLog } from "../lib/logger";
import { metricLabel, telemetry } from "../lib/telemetry";
import { outcomeDatasetHash, resolutionRunKey } from "./hashes";
import type {
  ForecastLedgerPort,
  OutcomeBar,
  OutcomeDataReadPort,
  OutcomeDataWritePort,
  ResolutionEvaluation,
} from "./ports";
import {
  emptyResolutionCounts,
  FORECAST_LIMITS,
  FORECAST_RESOLUTION_POLICY_VERSION,
  FORECAST_TIMEFRAME_MS,
  isForecastVoidReason,
  type ForecastContract,
  type ForecastVoidReason,
  type ResolutionCounts,
} from "./types";

/** Eine Roh-Kerze, wie der Live-Feed sie liefert (Startzeit-basiert). */
export interface LiveBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ForecastResolverDeps {
  ledger: ForecastLedgerPort;
  outcomeRead: OutcomeDataReadPort;
  outcomeWrite: OutcomeDataWritePort;
  /**
   * Live-Kerzen für die Feed-Phase (optional). Ohne Quelle läuft nur die
   * Resolve-Phase (z. B. in Umgebungen ohne Marktdatenzugriff).
   */
  fetchLiveBars?: (symbol: string, timeframe: string, limit: number) => Promise<LiveBar[]>;
  now?: () => Date;
  codeVersion?: string;
}

export interface ResolverRunResult {
  ok: boolean;
  runId: string;
  counts: ResolutionCounts;
  fed: number;
  watermarkDeadline: Date | null;
  lagMs: number | null;
  errorCode: string | null;
}

/**
 * Reine Bewertung EINES Forecasts gegen die verfügbaren Kerzen.
 *
 * @param bars Kerzen des Instruments/Timeframes (auch nach der Deadline
 *   geschriebene — gefiltert wird hier über `fetchedAtMs <= deadlineMs`).
 * @param deadlineMs Verfügbarkeits-Deadline (automatisch:
 *   `availability_deadline`; Operator-Re-Resolution: `now`).
 */
export function evaluateForecast(
  contract: ForecastContract,
  bars: readonly OutcomeBar[],
  deadlineMs: number
): ResolutionEvaluation {
  const referenceMs = contract.referenceTime.getTime();
  const resolvesMs = contract.resolvesAt.getTime();
  const usable = bars.filter((bar) => bar.fetchedAtMs <= deadlineMs);

  const referenceBar = usable.find((bar) => bar.closeTimeMs === referenceMs);
  const outcomeBar = usable.find((bar) => bar.closeTimeMs === resolvesMs);

  const manifestBase = {
    targetKind: contract.targetKind,
    timeframe: contract.timeframe,
    entityId: contract.entityId,
    referenceTimeMs: referenceMs,
    resolvesAtMs: resolvesMs,
    deadlineMs,
    policyVersion: FORECAST_RESOLUTION_POLICY_VERSION,
    barsConsidered: bars.length,
    barsUsable: usable.length,
  };

  if (!referenceBar || !outcomeBar) {
    return {
      kind: "VOID",
      voidReason: "MISSING_DATA",
      manifest: {
        ...manifestBase,
        voidDetail: !referenceBar && !outcomeBar
          ? "reference-and-outcome-bar-missing"
          : !referenceBar
            ? "reference-bar-missing"
            : "outcome-bar-missing",
        datasetHash: outcomeDatasetHash(usable.filter((b) => b.closeTimeMs >= referenceMs && b.closeTimeMs <= resolvesMs)),
      },
    };
  }

  if (
    !Number.isFinite(referenceBar.close) || referenceBar.close <= 0 ||
    !Number.isFinite(outcomeBar.close) || outcomeBar.close <= 0
  ) {
    return {
      kind: "VOID",
      voidReason: "INVALID_DATA",
      manifest: { ...manifestBase, voidDetail: "non-positive-or-non-finite-close" },
    };
  }

  // Halt-Heuristik: ALLE verfügbaren Kerzen des Auflösungsfensters
  // (nach der Referenz, inkl. Outcome) ohne Volumen ⇒ Handelsaussetzung.
  const windowBars = usable.filter((bar) => bar.closeTimeMs > referenceMs && bar.closeTimeMs <= resolvesMs);
  if (windowBars.length > 0 && windowBars.every((bar) => bar.volume === 0)) {
    return {
      kind: "VOID",
      voidReason: "TRADING_HALT",
      manifest: { ...manifestBase, voidDetail: "zero-volume-window", windowBars: windowBars.length },
    };
  }

  const windowBarsDetail = [referenceBar, ...windowBars].map((bar) => ({
    closeTimeMs: bar.closeTimeMs,
    close: bar.close,
    volume: bar.volume,
    fetchedAtMs: bar.fetchedAtMs,
  }));
  const datasetHash = outcomeDatasetHash(windowBarsDetail);
  const gaps = expectedBarCount(referenceMs, resolvesMs) - windowBars.length;

  // Policy `fp1`: strikt größer ⇒ UP (1); Gleichstand zählt als DOWN (0).
  const up = outcomeBar.close > referenceBar.close;
  const categories = [...contract.categories];
  const label = up ? "UP" : "DOWN";
  const outcomeIndex = categories.indexOf(label);
  if (outcomeIndex < 0) {
    return {
      kind: "VOID",
      voidReason: "INVALID_DATA",
      manifest: { ...manifestBase, voidDetail: "outcome-label-not-in-categories" },
    };
  }
  const targetIndex = categories.indexOf(contract.targetCategory);
  return {
    kind: "RESOLVED",
    outcomeIndex,
    outcomeLabel: label,
    outcomeBinary: outcomeIndex === targetIndex ? 1 : 0,
    referenceClose: referenceBar.close,
    outcomeClose: outcomeBar.close,
    manifest: {
      ...manifestBase,
      datasetHash,
      windowBars: windowBarsDetail,
      gapsInWindow: Math.max(0, gaps),
      rule: "close(outcome) > close(reference) => UP; tie => DOWN",
    },
  };
}

/** Erwartete Kerzenanzahl eines Fensters (Referenz exklusiv, Outcome inklusiv). */
export function expectedBarCount(referenceMs: number, resolvesMs: number, timeframeMs: number = FORECAST_TIMEFRAME_MS): number {
  if (!Number.isFinite(referenceMs) || !Number.isFinite(resolvesMs) || resolvesMs <= referenceMs) return 0;
  return Math.round((resolvesMs - referenceMs) / timeframeMs);
}

/** Fällige Forecasts bewerten und schreiben (Resolve-Phase). */
async function resolveDue(
  deps: ForecastResolverDeps,
  now: Date,
  limit: number
): Promise<{ counts: ResolutionCounts; maxDeadline: Date | null; truncated: boolean }> {
  const { ledger, outcomeRead } = deps;
  const counts = emptyResolutionCounts();
  let maxDeadline: Date | null = null;

  const due = await ledger.dueForecasts(now, limit + 1);
  const truncated = due.length > limit;
  const batch = due.slice(0, limit);

  for (const item of batch) {
    counts.dueConsidered += 1;
    const contract = item.contract;
    try {
      const fromMs = contract.referenceTime.getTime();
      const toMs = contract.resolvesAt.getTime();
      const bars = await outcomeRead.loadBars(contract.entityId, contract.timeframe, fromMs, toMs);
      const evaluation = evaluateForecast(contract, bars, contract.availabilityDeadline.getTime());
      const result = await ledger.appendResolution({
        forecastId: item.forecastId,
        status: evaluation.kind === "RESOLVED" ? "RESOLVED" : "VOID",
        outcomeIndex: evaluation.kind === "RESOLVED" ? evaluation.outcomeIndex : null,
        outcomeLabel: evaluation.kind === "RESOLVED" ? evaluation.outcomeLabel : null,
        outcomeBinary: evaluation.kind === "RESOLVED" ? evaluation.outcomeBinary : null,
        referenceClose: evaluation.kind === "RESOLVED" ? evaluation.referenceClose : null,
        outcomeClose: evaluation.kind === "RESOLVED" ? evaluation.outcomeClose : null,
        voidReason: evaluation.kind === "VOID" ? evaluation.voidReason : null,
        resolutionKind: "AUTOMATIC",
        resolvedAt: now,
        policyVersion: FORECAST_RESOLUTION_POLICY_VERSION,
        outcomeManifest: evaluation.manifest,
      });
      if (!result.created) {
        counts.duplicates += 1;
      } else if (evaluation.kind === "RESOLVED") {
        counts.resolved += 1;
      } else {
        counts.voided += 1;
        telemetry.forecasts.resolutions.inc({ result: "void", reason: metricLabel(evaluation.voidReason) });
      }
      if (result.created && evaluation.kind === "RESOLVED") {
        telemetry.forecasts.resolutions.inc({ result: "resolved", reason: "ok" });
      }
      if (maxDeadline === null || contract.availabilityDeadline.getTime() > maxDeadline.getTime()) {
        maxDeadline = contract.availabilityDeadline;
      }
    } catch (error) {
      counts.failed += 1;
      telemetry.forecasts.resolutions.inc({ result: "failed", reason: "error" });
      structuredLog("warn", "forecast_resolution_failed", {
        forecastId: item.forecastId,
        entityId: contract.entityId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { counts, maxDeadline, truncated };
}

/** Resultat eines vollständigen Resolver-Laufs (automatisch). */
export async function runForecastResolution(
  deps: ForecastResolverDeps,
  options: { limit?: number; mode?: "AUTOMATIC" | "OPERATOR" } = {}
): Promise<ResolverRunResult> {
  const now = (deps.now ?? (() => new Date()))();
  const startedAt = now;
  const limit = Math.min(
    FORECAST_LIMITS.resolverBatchLimit,
    Math.max(1, Math.floor(options.limit ?? FORECAST_LIMITS.resolverBatchLimit))
  );
  const codeVersion = deps.codeVersion ?? APP_VERSION;
  const counts = emptyResolutionCounts();
  let fed = 0;
  let errorCode: string | null = null;
  let status: "SUCCEEDED" | "FAILED" = "SUCCEEDED";

  const cursorBefore = await deps.ledger.readCursor().catch(() => null);

  try {
    // ── Feed-Phase: Outcome-Kerzen rechtzeitig in den Store schreiben ──────
    if (deps.fetchLiveBars) {
      const maturing = await deps.ledger.maturingForecasts(now, limit);
      for (const item of maturing) {
        const contract = item.contract;
        try {
          const bars = await deps.fetchLiveBars(contract.symbol, contract.timeframe, 12);
          if (bars.length === 0) continue;
          const result = await deps.outcomeWrite.appendBars(contract.entityId, contract.timeframe, bars, now);
          fed += result.written;
        } catch (error) {
          // Feed-Fehler sind nicht fatal: die Resolve-Phase entscheidet später
          // fail-closed (VOID/MISSING_DATA). Laut bleiben wir trotzdem.
          structuredLog("warn", "forecast_feed_failed", {
            entityId: contract.entityId,
            message: error instanceof Error ? error.message : String(error),
          });
          telemetry.forecasts.feeds.inc({ result: "failed" });
          continue;
        }
        telemetry.forecasts.feeds.inc({ result: "ok" });
      }
    }

    // ── Resolve-Phase ───────────────────────────────────────────────────────
    const phase = await resolveDue(deps, now, limit);
    Object.assign(counts, phase.counts);

    // Wasserstand nur vorwärts bewegen, wenn die fällige Menge vollständig
    // bearbeitet wurde (sonst bliebe Rückstand unsichtbar).
    let watermark: Date | null = cursorBefore?.watermarkDeadline ?? null;
    if (!phase.truncated && phase.maxDeadline !== null) {
      watermark = phase.maxDeadline;
    }

    // Lag: ältester offener, fälliger Forecast gegen `now`.
    const overdue = await oldestOverdueOf(deps, now);
    const lagMs = overdue === null ? null : Math.max(0, now.getTime() - overdue.getTime());

    const runKey = resolutionRunKey({
      mode: "AUTOMATIC",
      policyVersion: FORECAST_RESOLUTION_POLICY_VERSION,
      codeVersion,
      nowMs: now.getTime(),
      limit,
    });
    const run = await deps.ledger.recordRun({
      idempotencyKey: runKey,
      mode: "AUTOMATIC",
      status,
      counts,
      cursorBefore: { watermarkDeadline: cursorBefore?.watermarkDeadline ?? null },
      cursorAfter: { watermarkDeadline: watermark },
      codeVersion,
      errorCode,
      startedAt,
      finishedAt: (deps.now ?? (() => new Date()))(),
    });
    // Wasserstand mit Run-Referenz stempeln (monoton; `GREATEST` im Ledger).
    if (watermark !== null) {
      await deps.ledger.advanceCursor(watermark, run.runId);
    }
    telemetry.forecasts.runs.inc({ result: "ok", mode: "AUTOMATIC" });
    return { ok: true, runId: run.runId, counts, fed, watermarkDeadline: watermark, lagMs, errorCode: null };
  } catch (error) {
    status = "FAILED";
    errorCode = error instanceof Error && "code" in error && typeof (error as { code: unknown }).code === "string"
      ? (error as { code: string }).code
      : "resolver:error";
    telemetry.forecasts.runs.inc({ result: "failed", mode: "AUTOMATIC" });
    try {
      await deps.ledger.recordRun({
        idempotencyKey: resolutionRunKey({
          mode: "AUTOMATIC",
          policyVersion: FORECAST_RESOLUTION_POLICY_VERSION,
          codeVersion,
          nowMs: now.getTime(),
          limit,
        }),
        mode: "AUTOMATIC",
        status: "FAILED",
        counts,
        cursorBefore: { watermarkDeadline: cursorBefore?.watermarkDeadline ?? null },
        cursorAfter: { watermarkDeadline: cursorBefore?.watermarkDeadline ?? null },
        codeVersion,
        errorCode,
        startedAt,
        finishedAt: (deps.now ?? (() => new Date()))(),
      });
    } catch {
      // Lauf-Manifest darf den Fehlschlag nicht verdecken — der ursprüngliche
      // Fehler bleibt maßgeblich und wird unten geworfen.
    }
    throw error;
  }
}

async function oldestOverdueOf(deps: ForecastResolverDeps, now: Date): Promise<Date | null> {
  const due = await deps.ledger.dueForecasts(now, 1);
  const first = due[0];
  return first ? first.contract.availabilityDeadline : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Operator-Pfad: versionierte Re-Resolution und VOID (nie stille Mutation)
// ─────────────────────────────────────────────────────────────────────────────

/** Geschlossene Gründe für Operator-Eingriffe. */
export const FORECAST_OPERATOR_REASONS = [
  "DATA_CORRECTION",
  "CORPORATE_ACTION",
  "TRADING_HALT",
  "INVALID_DATA",
  "MISSING_DATA",
] as const;
export type ForecastOperatorReason = (typeof FORECAST_OPERATOR_REASONS)[number];

export interface OperatorResolutionInput {
  forecastId: string;
  actorId: string;
  reason: string;
  note?: string;
}

/**
 * Re-Resolution durch den Operator: bewertet den Forecast NEU mit der
 * aktuellen Store-Lage (Deadline = jetzt). Weicht das Ergebnis von der
 * jüngsten Resolution ab, entsteht eine neue Version — die Historie bleibt
 * unangetastet. Identisches Ergebnis ⇒ no-op.
 */
export async function reResolveForecast(
  deps: ForecastResolverDeps,
  input: OperatorResolutionInput
): Promise<{ created: boolean; resolutionVersion: number; status: "RESOLVED" | "VOID"; outcomeHash: string }> {
  validateOperatorInput(input);
  const now = (deps.now ?? (() => new Date()))();
  const item = await deps.ledger.loadForecast(input.forecastId);
  if (item === null) {
    throw new ResolverInputError("forecast:not-found", `Forecast ${input.forecastId} existiert nicht.`);
  }
  const contract = item.contract;
  const bars = await deps.outcomeRead.loadBars(
    contract.entityId,
    contract.timeframe,
    contract.referenceTime.getTime(),
    contract.resolvesAt.getTime()
  );
  const evaluation = evaluateForecast(contract, bars, now.getTime());
  const manifest = {
    ...evaluation.manifest,
    operator: { actorId: input.actorId, reason: input.reason, note: clampNote(input.note) },
    reResolution: { previousVersion: item.latestResolution?.resolutionVersion ?? null },
  };
  const result = await deps.ledger.appendResolution({
    forecastId: input.forecastId,
    status: evaluation.kind === "RESOLVED" ? "RESOLVED" : "VOID",
    outcomeIndex: evaluation.kind === "RESOLVED" ? evaluation.outcomeIndex : null,
    outcomeLabel: evaluation.kind === "RESOLVED" ? evaluation.outcomeLabel : null,
    outcomeBinary: evaluation.kind === "RESOLVED" ? evaluation.outcomeBinary : null,
    referenceClose: evaluation.kind === "RESOLVED" ? evaluation.referenceClose : null,
    outcomeClose: evaluation.kind === "RESOLVED" ? evaluation.outcomeClose : null,
    voidReason: evaluation.kind === "VOID" ? evaluation.voidReason : null,
    resolutionKind: "OPERATOR",
    resolvedAt: now,
    policyVersion: FORECAST_RESOLUTION_POLICY_VERSION,
    outcomeManifest: manifest,
  });
  telemetry.forecasts.resolutions.inc({
    result: result.created ? "re_resolved" : "duplicate",
    reason: metricLabel(input.reason),
  });
  return {
    created: result.created,
    resolutionVersion: result.resolutionVersion,
    status: evaluation.kind === "RESOLVED" ? "RESOLVED" : "VOID",
    outcomeHash: result.outcomeHash,
  };
}

/**
 * VOID durch den Operator (z. B. Corporate Action): hängt eine VOID-Resolution
 * mit geschlossenem Grund an. Kein Überschreiben — ist der Forecast bereits
 * mit identischem Outcome VOID, ist der Aufruf ein no-op.
 */
export async function voidForecastByOperator(
  deps: ForecastResolverDeps,
  input: OperatorResolutionInput & { voidReason: string }
): Promise<{ created: boolean; resolutionVersion: number; outcomeHash: string }> {
  validateOperatorInput(input);
  if (!isForecastVoidReason(input.voidReason)) {
    throw new ResolverInputError("void:invalid-reason", `Ungültiger VOID-Grund: ${String(input.voidReason)}.`);
  }
  const voidReason = input.voidReason as ForecastVoidReason;
  const now = (deps.now ?? (() => new Date()))();
  const item = await deps.ledger.loadForecast(input.forecastId);
  if (item === null) {
    throw new ResolverInputError("forecast:not-found", `Forecast ${input.forecastId} existiert nicht.`);
  }
  const manifest = {
    entityId: item.contract.entityId,
    policyVersion: FORECAST_RESOLUTION_POLICY_VERSION,
    operator: { actorId: input.actorId, reason: input.reason, note: clampNote(input.note), action: "VOID" },
  };
  const result = await deps.ledger.appendResolution({
    forecastId: input.forecastId,
    status: "VOID",
    outcomeIndex: null,
    outcomeLabel: null,
    outcomeBinary: null,
    referenceClose: null,
    outcomeClose: null,
    voidReason,
    resolutionKind: "OPERATOR",
    resolvedAt: now,
    policyVersion: FORECAST_RESOLUTION_POLICY_VERSION,
    outcomeManifest: manifest,
  });
  telemetry.forecasts.resolutions.inc({ result: result.created ? "void" : "duplicate", reason: metricLabel(voidReason) });
  return { created: result.created, resolutionVersion: result.resolutionVersion, outcomeHash: result.outcomeHash };
}

/** Fehler der Operator-/Eingabevalidierung. */
export class ResolverInputError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = new.target.name;
  }
}

function validateOperatorInput(input: OperatorResolutionInput): void {
  if (typeof input.forecastId !== "string" || input.forecastId.length === 0 || input.forecastId.length > 64) {
    throw new ResolverInputError("input:invalid-forecast-id", "forecastId fehlt oder ist ungültig.");
  }
  if (typeof input.actorId !== "string" || input.actorId.length === 0 || input.actorId.length > 64) {
    throw new ResolverInputError("input:invalid-actor", "actorId fehlt oder ist ungültig.");
  }
  if (!(FORECAST_OPERATOR_REASONS as readonly string[]).includes(input.reason)) {
    throw new ResolverInputError("input:invalid-reason", `Ungültiger Operator-Grund: ${String(input.reason)}.`);
  }
}

function clampNote(note: string | undefined): string | null {
  if (typeof note !== "string") return null;
  const trimmed = note.trim();
  if (trimmed.length === 0) return null;
  // Operator-Notizen sind Freitext und bleiben Daten: gekürzt, nie Instruktion.
  return trimmed.slice(0, FORECAST_LIMITS.maxOperatorNoteLength);
}
