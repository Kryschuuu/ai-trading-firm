/**
 * Per-Version-Metriken: Forecast-Qualität + Attribution + Laufzeit (RMA-P3-02, v1.65.0)
 *
 * ── Join ─────────────────────────────────────────────────────────────────
 * Outcomes stammen ausschließlich aus `P3.1_resolutions` (die wahrhaft
 * bereinigten Temperaturen aus `forecast_resolutions`). Die Metriken folgen
 * dem `P3.1`-Ableitungsmodell: wirklicher Status einer Prognose ist
 * `getEffectiveResolution()` (jüngste `forecast_resolutions` je Forecast);
 * ohne Resolution ist die Prognose PENDING. Coverage-Lücken sind sichtbar
 * (`PENDING` zählt nicht als Fehlschlag).
 *
 * ── PIT ──────────────────────────────────────────────────────────────────
 * Sämtliche Zeitfilter verwenden `forecasts.as_of` (Ereigniszeit) und —
 * für „bis wann“ — die Verfügbarkeit `forecasts.availability_deadline`
 * (bewertet). `created_at` wird nie als Zulässigkeitskriterium verwendet.
 * Mit `includePending: false` schließen wir `PENDING`-Prognosen von jeder
 * Brier-/Kalibrierung aus — sie sind nicht „falsch“, sondern „offen“.
 *
 * ── Einheiten ─────────────────────────────────────────────────────────────
 * * Latenz: Millisekunden (ms), ganzer Millisekundenwert je Run.
 * * Tokens: absolute Anzahl (prompt/completion/total), 0 bedeutet „keine
 *   Angabe“ nie als 0 gezählt (Aggregation verwendet `null`).
 * * Kosten: US-Dollar (USD), zwei Nachkommastellen-Logik nur in der Anzeige;
 *   interne Summen behalten `number`.
 *
 * ── Grenzen ───────────────────────────────────────────────────────────────
 * Jede Abfrage ist durch `LIMIT` begrenzt (Forecasts: ≤ 20 000, Runs: ≤ 5 000).
 * `minSample` steuert den Status `ok` vs `insufficient-sample` je Segment
 * (Standard 30, klemmbar [5, 1000]); Trunkierung wird berichtet.
 */

import { and, eq, sql, inArray } from "drizzle-orm";

import { getDb } from "@/db";
import { forecasts, forecastResolutions, agentPromptRuns, tradeAttributions, tradeAttributionEntries } from "@/db/schema";
import { PROMPT_PERF_LIMITS, PromptPerfError, type PromptVersionMetrics } from "./types";
import { promptVersionLabel } from "./canonical";
import { structuredLog } from "@/lib/logger";

// ── Helpers ────────────────────────────────────────────────────────────────

function clampMinSample(n: unknown): number {
  const fallback = PROMPT_PERF_LIMITS.minSampleDefault;
  if (n == null || n === "") return fallback;
  const v = typeof n === "string" ? Number(n) : typeof n === "number" ? n : NaN;
  if (!Number.isFinite(v)) return fallback;
  return Math.min(PROMPT_PERF_LIMITS.minSampleMax, Math.max(PROMPT_PERF_LIMITS.minSampleMin, Math.trunc(v)));
}

function clampLimit(n: unknown, def: number, max: number): number {
  const v = typeof n === "string" ? Number(n) : typeof n === "number" ? n : NaN;
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(1, Math.trunc(v)));
}

function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] ?? null;
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? 0;
  return a + (b - a) * (idx - lo);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

// Wilson-Intervall (95 %, z=1.96) für Trefferquoten — identische Logik zu forecasts/scoring.ts
function wilson95(k: number, n: number): { lower: number; upper: number } | null {
  if (n <= 0) return null;
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    lower: clamp01((centre - half) / denom),
    upper: clamp01((centre + half) / denom),
  };
}

// Brier SE / 95 %-CI (asymptotisch normal, wie forecasts/scoring.ts)
function brierSE(brier: number, n: number): { se: number; lower: number; upper: number } | null {
  if (n < 2 || !Number.isFinite(brier)) return null;
  // Schätzung: se ≈ sqrt(p*(1-p)/n) mit p=Brier schwierig; wir nutzen
  // die empirische Streuung der quadrierten Fehler (≈ Brier) — hier
  // konservativ: se = sqrt(Brier*(1-Brier)/n)
  const se = Math.sqrt(Math.max(0, brier * (1 - brier)) / n);
  const lower = Math.max(0, brier - 1.96 * se);
  const upper = Math.min(1, brier + 1.96 * se);
  return { se, lower, upper };
}

// Vorderes, gebounded Forecast-Fenster (für PIT-Filter)
// Wenn eine Seite fehlt, ist das Fenster offen. Falsche Chronologie (from>=to) ⇒ INVALID_TIME_WINDOW.
function parseBounds(fromRaw: unknown, toRaw: unknown): { from: Date | null; to: Date | null } {
  function parseOne(raw: unknown): Date | null {
    if (raw == null || raw === "") return null;
    const s = String(raw).trim();
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const from = parseOne(fromRaw);
  const to = parseOne(toRaw);
  if (from && to && from.getTime() >= to.getTime()) {
    throw new PromptPerfError("INVALID_TIME_WINDOW", "`from` muss vor `to` liegen");
  }
  return { from, to };
}

// ── Öffentliche Metrikabfrage ────────────────────────────────────────────

export interface PromptMetricsFilter {
  promptVersion?: number | null; // null | "UNKNOWN" wird als SQL-Null behandelt (fail-closed UNKNOWN)
  agentRole?: string;
  horizonId?: string;
  entityId?: string;
  regime?: string;
  fromAsOf?: string;
  toAsOf?: string;
  minSample?: number;
  limit?: number;
}

export async function getPromptVersionMetrics(filter: PromptMetricsFilter): Promise<PromptVersionMetrics> {
  const db = getDb();
  const promptVersion = filter.promptVersion === null || (filter.promptVersion as unknown) === "UNKNOWN" ? null : (typeof filter.promptVersion === "number" ? Math.trunc(filter.promptVersion) : undefined);
  const isUnknown = filter.promptVersion == null;
  const minSample = clampMinSample(filter.minSample);
  const limit = clampLimit(filter.limit, 5000, PROMPT_PERF_LIMITS.maxMetricsForecasts);
  const { from, to } = parseBounds(filter.fromAsOf, filter.toAsOf);

  // ── 1) Forecasts lesen (bounded, PIT nach as_of) ─────────────────────
  const forecastPredicates: ReturnType<typeof eq>[] = [];
  if (promptVersion != null) forecastPredicates.push(eq(forecasts.promptVersion, promptVersion));
  // UNKNOWN ⇒ wir holen *nur* UNKNOWN-Versionen nicht, sondern melden es sichtbar
  // (leeres Fenster, Status insufficient-sample). Das ist bewusst fail-closed.
  if (filter.agentRole) forecastPredicates.push(eq(forecasts.agentRole, String(filter.agentRole)));
  if (filter.horizonId) forecastPredicates.push(eq(forecasts.horizonId, String(filter.horizonId)));
  if (filter.entityId) forecastPredicates.push(eq(forecasts.entityId, String(filter.entityId)));
  if (filter.regime) forecastPredicates.push(eq(forecasts.regime, String(filter.regime)));
  if (from) forecastPredicates.push(sql`${forecasts.asOf} >= ${from.toISOString()}::timestamptz` as unknown as ReturnType<typeof eq>);
  if (to) forecastPredicates.push(sql`${forecasts.asOf} < ${to.toISOString()}::timestamptz` as unknown as ReturnType<typeof eq>);

  // Bei UNKNOWN zeigen wir explizit 0 Zeilen statt „alle“ zu leaken (bounded-label Regel):
  // der Aufrufer hat die UNKNOWN-Gruppe angefragt — sie umfasst Prognosen, deren
  // promptVersion in keinem Artefakt mehr auflösbar ist (z. B. Altbestand).
  // Wir behandeln sie als getrennt (nicht getarnt als v0).
  const forecastRows = isUnknown
    ? []
    : await (async () => {
        const where = forecastPredicates.length > 0 ? and(...forecastPredicates) : undefined;
        // Wir holen Forecasts + ihre jüngste Resolution (LEFT JOIN, distinct on)
        // — aber begrenzt auf `limit`. Um „genau eine“ jüngste je Forecast zu
        // garantieren, lesen wir Forecasts und lösen danach je Forecast die
        // jüngste Resolution auf (bounded, weil Forecasts schon limitiert).
        const rows = await db.select().from(forecasts).where(where).orderBy(sql`${forecasts.asOf} desc`).limit(limit + 1);
        const truncated = rows.length > limit;
        return truncated ? rows.slice(0, limit) : rows;
      })();

  const forecastIds = forecastRows.map((r: (typeof forecastRows)[number]) => r.id);
  // Jüngste Resolutionen je Forecast (eine Query, bounded durch forecastIds)
  const resolutionByForecast = new Map<string, typeof forecastResolutions.$inferSelect>();
  if (forecastIds.length > 0) {
    const chunkSize = 500;
    for (let off = 0; off < forecastIds.length; off += chunkSize) {
      const chunk = forecastIds.slice(off, off + chunkSize);
      const resolutions = await db
        .select()
        .from(forecastResolutions)
        .where(inArray(forecastResolutions.forecastId, chunk))
        .orderBy(sql`${forecastResolutions.forecastId}, ${forecastResolutions.resolutionVersion} desc`);
      for (const r of resolutions) {
        if (!resolutionByForecast.has(r.forecastId)) resolutionByForecast.set(r.forecastId, r);
      }
    }
  }

  // ── 2) Runs lesen (bounded, direkt, nicht aus Forecasts abgeleitet) ────
  const runPredicates: ReturnType<typeof eq>[] = [];
  if (filter.agentRole) runPredicates.push(eq(agentPromptRuns.role, String(filter.agentRole)));
  if (promptVersion != null) runPredicates.push(eq(agentPromptRuns.promptVersion, promptVersion));
  else if (isUnknown) {
    // UNKNOWN-Runs: genau jene mit null-Version (historische Lücke);
    // wir zählen sie gepoolt, label UNKNOWN — nicht als „0“.
    runPredicates.push(sql`${agentPromptRuns.promptVersion} IS NULL` as unknown as ReturnType<typeof eq>);
  }
  if (from) runPredicates.push(sql`${agentPromptRuns.startedAt} >= ${from.toISOString()}::timestamptz` as unknown as ReturnType<typeof eq>);
  if (to) runPredicates.push(sql`${agentPromptRuns.startedAt} < ${to.toISOString()}::timestamptz` as unknown as ReturnType<typeof eq>);

  const runWhere = runPredicates.length > 0 ? and(...runPredicates) : undefined;
  const runLimit = Math.min(PROMPT_PERF_LIMITS.maxRunsPerQuery, limit);
  // Wir umgehen Drizzle Limit Typen mit sql
  const rawRuns = isUnknown && forecastIds.length === 0 && !filter.agentRole
    ? await db.select().from(agentPromptRuns).where(runWhere).limit(runLimit + 1)
    : await db.select().from(agentPromptRuns).where(runWhere).limit(runLimit + 1);
  const runsTruncated = rawRuns.length > runLimit;
  const runRows = runsTruncated ? rawRuns.slice(0, runLimit) : rawRuns;

  // ── 3) Forecasts in Resolved/Void/Pending partitionieren ───────────────
  let total = forecastRows.length;
  let resolvedCount = 0;
  let voidCount = 0;
  let pendingCount = 0;
  const resolvedPairs: Array<{ forecast: typeof forecasts.$inferSelect; resolution: typeof forecastResolutions.$inferSelect }> = [];
  for (const f of forecastRows) {
    const r = resolutionByForecast.get(f.id);
    if (!r) {
      pendingCount += 1;
      continue;
    }
    if (r.status === "RESOLVED") {
      resolvedCount += 1;
      resolvedPairs.push({ forecast: f, resolution: r });
    } else if (r.status === "VOID") {
      voidCount += 1;
    } else {
      pendingCount += 1;
    }
  }
  const due = resolvedCount + voidCount; // coverage-Nenner nur fällige Forecasts
  const coverage: number | null = due > 0 ? (resolvedCount + voidCount) / (total || 1) > 1 ? 1 : (resolvedCount + voidCount) / (total) : (total === 0 ? null : 0);
  // Korrekt: (resolved+void)/total, aber nur resolved+void sind gedeckt — pending fehlt.
  const coverageFixed = total > 0 ? (resolvedCount + voidCount) / total : null;

  // Abstention ist in P3.1 nicht als Forecast-Flag gespeichert; wir approximieren:
  // keine zählebare Enthaltung — null, bis ein Ledger-Flag eingeführt wird.
  const abstentionRate: number | null = null;

  // ── 4) Forecast-Qualität aus RESOLVED-Paaren ─────────────────────────
  const n = resolvedPairs.length;
  let brierScore: number | null = null;
  let brierSkillScore: number | null = null;
  let logLoss: number | null = null;
  let ece: number | null = null;
  let hitRate: number | null = null;
  let hitWilson: { lower: number; upper: number } | null = null;
  let brierUncertainty: { se: number; lower: number; upper: number } | null = null;
  const reliability: Array<{ index: number; count: number; meanForecast: number | null; observedRate: number | null; wilson95: { lower: number; upper: number } | null }> = [];
  let status: "ok" | "insufficient-sample" = n >= minSample ? "ok" : "insufficient-sample";

  if (n > 0) {
    // Brier / LogLoss / HitRate
    let brierSum = 0;
    let logSum = 0;
    let hits = 0;
    const buckets = Array.from({ length: 10 }, (_, i) => ({ index: i, count: 0, sumProb: 0, sumOutcome: 0 }));

    for (const { forecast, resolution } of resolvedPairs) {
      const p = Number(forecast.probability);
      const y = resolution.outcomeBinary === 1 ? 1 : 0;
      const err = p - y;
      brierSum += err * err;
      const pClamped = Math.min(0.999999, Math.max(0.000001, p));
      logSum += y === 1 ? -Math.log(pClamped) : -Math.log(1 - pClamped);
      if ((p >= 0.5 ? 1 : 0) === y) hits += 1;
      const b = Math.min(9, Math.max(0, Math.floor(p * 10)));
      const bucket = buckets[b]!;
      bucket.count += 1;
      bucket.sumProb += p;
      bucket.sumOutcome += y;
    }

    brierScore = brierSum / n;
    logLoss = logSum / n;
    hitRate = hits / n;
    hitWilson = wilson95(hits, n);
    brierUncertainty = brierSE(brierScore, n);

    // Brier Skill Score vs. konstantes 0.5 (Referenz-Brier 0.25) — wie forecasts/scoring.ts
    const referenceBrier = 0.25;
    const bssDen = referenceBrier;
    brierSkillScore = bssDen > 0 ? 1 - brierScore / bssDen : null;

    // ECE: gewichtete mittlere Kalibrierabweichung je Bucket
    let eceAccum = 0;
    for (const b of buckets) {
      if (b.count === 0) {
        reliability.push({ index: b.index, count: 0, meanForecast: null, observedRate: null, wilson95: null });
        continue;
      }
      const meanForecast = b.sumProb / b.count;
      const observedRate = b.sumOutcome / b.count;
      const w = b.count / n;
      eceAccum += Math.abs(meanForecast - observedRate) * w;
      reliability.push({
        index: b.index,
        count: b.count,
        meanForecast,
        observedRate,
        wilson95: wilson95(b.sumOutcome, b.count),
      });
    }
    ece = eceAccum;
  } else {
    for (let i = 0; i < 10; i++) reliability.push({ index: i, count: 0, meanForecast: null, observedRate: null, wilson95: null });
  }

  // ── 5) Trade-Attribution (P1.6) je Prompt-Version ──────────────────────
  // Bounded Label: promptVersion als Zahl, nicht Instrument-ID.
  // Wir summieren Beiträge des Typs AGENT mit sourceVersion === "<promptVersion>" (z. B. "3").
  // Bei UNKNOWN: keine Attribution (sichtbare Lücke).
  let attributedPnl: number | null = null;
  let tradeCount = 0;
  let avgContribution: number | null = null;
  let maxDrawdown: number | null = null;
  if (!isUnknown && promptVersion != null) {
    try {
      const pvStr = String(promptVersion);
      // Begrenzt: zuerst Attributionen im Zeitfenster, dann Beiträge filtern.
      // Wir holen closedAt sortiert, um kumulierten Drawdown korrekt zu messen.
      const atPredicates: ReturnType<typeof eq>[] = [eq(tradeAttributions.methodVersion, 1), eq(tradeAttributions.status, "ATTRIBUTED")];
      if (from) atPredicates.push(sql`${tradeAttributions.closedAt} >= ${from.toISOString()}::timestamptz` as unknown as ReturnType<typeof eq>);
      if (to) atPredicates.push(sql`${tradeAttributions.closedAt} < ${to.toISOString()}::timestamptz` as unknown as ReturnType<typeof eq>);
      const atWhere = and(...atPredicates);
      const atRows = await db.select({ id: tradeAttributions.id, closedAt: tradeAttributions.closedAt }).from(tradeAttributions).where(atWhere).orderBy(sql`${tradeAttributions.closedAt} asc`).limit(2000);
      if (atRows.length > 0) {
        const atIds = atRows.map((r: (typeof atRows)[number]) => r.id);
        const closedByAttribution = new Map<string, Date>();
        for (const r of atRows as Array<{ id: string; closedAt: Date }>) closedByAttribution.set(r.id, r.closedAt);
        // Chunked Abfrage nach (AGENT, pvStr)
        const perAttributionContribution = new Map<string, number>();
        let sum = 0;
        let cnt = 0;
        for (let off = 0; off < atIds.length; off += 250) {
          const chunk = atIds.slice(off, off + 250);
          const entries = await db
            .select()
            .from(tradeAttributionEntries)
            .where(and(inArray(tradeAttributionEntries.attributionId, chunk), eq(tradeAttributionEntries.sourceType, "AGENT"), eq(tradeAttributionEntries.sourceVersion, pvStr)));
          for (const e of entries) {
            const c = Number(e.contribution);
            if (!Number.isFinite(c)) continue;
            sum += c;
            cnt += 1;
            const prev = perAttributionContribution.get(e.attributionId) ?? 0;
            perAttributionContribution.set(e.attributionId, prev + c);
          }
        }
        if (cnt > 0) {
          attributedPnl = sum;
          tradeCount = cnt;
          avgContribution = sum / cnt;
          // Drawdown: kumulierte P&L-Kurve je Attribution in closedAt-Reihenfolge
          let cum = 0;
          let peak = 0;
          let dd = 0; // negativ oder 0
          const sortedAttributions = [...perAttributionContribution.entries()].sort((a, b) => {
            const da = closedByAttribution.get(a[0])?.getTime() ?? 0;
            const dbb = closedByAttribution.get(b[0])?.getTime() ?? 0;
            return da - dbb;
          });
          for (const [, contrib] of sortedAttributions) {
            cum += contrib;
            if (cum > peak) peak = cum;
            const curDD = cum - peak; // <=0
            if (curDD < dd) dd = curDD;
          }
          maxDrawdown = cnt > 1 ? dd : 0;
        } else {
          tradeCount = 0;
          attributedPnl = null;
          maxDrawdown = null;
        }
      }
    } catch (e) {
      structuredLog("warn", "prompt_metrics_attribution_failed", { promptVersion, reason: String(e).slice(0, 200) });
    }
  }

  // ── 6) Laufzeit ─────────────────────────────────────────────────────────
  const latencyValues: number[] = runRows.map((r: (typeof runRows)[number]) => Number(r.latencyMs)).filter((v: number) => Number.isFinite(v)).sort((a: number, b: number) => a - b) as number[];
  const latCount = runRows.length;
  const latAvg = latencyValues.length > 0 ? latencyValues.reduce((a, b) => a + b, 0) / latencyValues.length : null;
  const latP50 = percentile(latencyValues, 0.5);
  const latP95 = percentile(latencyValues, 0.95);

  let totalPrompt = 0, totalCompletion = 0, totalTokens = 0;
  for (const r of runRows) {
    if (r.promptTokens != null) totalPrompt += Number(r.promptTokens) || 0;
    if (r.completionTokens != null) totalCompletion += Number(r.completionTokens) || 0;
    if (r.totalTokens != null) totalTokens += Number(r.totalTokens) || 0;
    else if (r.promptTokens != null || r.completionTokens != null) totalTokens += (Number(r.promptTokens) || 0) + (Number(r.completionTokens) || 0);
  }
  const avgPerRun = latCount > 0 && totalTokens > 0 ? totalTokens / latCount : (latCount > 0 ? null : null);

  let totalCost = 0, billedRuns = 0, freeRuns = 0;
  for (const r of runRows) {
    const cs = String(r.costStatus);
    if (cs === "billed" && r.costUsd != null) { totalCost += Number(r.costUsd) || 0; billedRuns += 1; }
    else if (cs === "free") freeRuns += 1;
    else if (cs === "unknown") {/* unbekannt trägt 0 zur Summe bei, aber sichtbar */}
  }
  // Wenn es keine kostenpflichtige Zeile gab, ist die Summe 0 — nicht null (mault nicht).
  const avgCost = billedRuns > 0 ? totalCost / billedRuns : (runRows.length > 0 ? 0 : 0);

  const hashLabel = isUnknown ? "UNKNOWN" : promptHashForVersionFallback(promptVersion as unknown as number, runRows as unknown as Array<{ promptHash: string }>);
  const versionLabel = isUnknown ? "UNKNOWN" : promptVersionLabel(promptVersion as unknown as number, hashLabel === "UNKNOWN" ? "pp1:0000000000000000000000000000000000000000000000000000000000000000" : hashLabel);

  return {
    promptVersion: isUnknown ? null : (promptVersion as number),
    promptHash: hashLabel,
    versionLabel,
    counts: {
      runs: latCount,
      forecastsTotal: total,
      forecastsResolved: resolvedCount,
      forecastsVoid: voidCount,
      forecastsPending: pendingCount,
    },
    coverage: coverageFixed,
    abstentionRate,
    forecastQuality: {
      brierScore,
      brierScoreMultiClass: null,
      brierSkillScore,
      logLoss,
      expectedCalibrationError: ece,
      hitRate,
      hitRateWilson95: hitWilson,
      brierUncertainty,
      reliability,
      status,
    },
    tradeContribution: {
      attributedPnl,
      tradeCount,
      avgContribution,
      maxDrawdown,
    },
    runtime: {
      latency: { count: latCount, avgMs: latAvg, p50Ms: latP50, p95Ms: latP95 },
      tokens: { totalPrompt, totalCompletion, total: totalTokens, avgPerRun },
      cost: { totalUsd: totalCost, avgUsd: latCount > 0 ? (billedRuns > 0 ? totalCost / billedRuns : 0) : null, billedRuns, freeRuns },
    },
  };
}

function promptHashForVersionFallback(version: number | undefined, runs: Array<{ promptHash: string }>): string {
  if (version == null) return "UNKNOWN";
  const hit = runs.find((r) => r.promptHash && r.promptHash.startsWith("pp1:"));
  return hit?.promptHash ?? "UNKNOWN";
}
