/**
 * Deterministische Multi-Timeframe-Konfluenz — die reine Kernfunktion
 * (RMA-P2-03).
 *
 * {@link computeConfluence} ist die EINZIGE Stelle, an der der Score entsteht.
 * Cycle-Step, Analyst, Scanner und Backtest teilen sie über die Adapter in
 * `./adapters` — es gibt keine zweite, abweichende Formel.
 *
 * Ablauf (deterministisch, Eingabereihenfolge-unabhängig):
 *
 *   1. **As-of-Ausrichtung** je Reihe: nur Kerzen mit `barEnd ≤ asOf` UND
 *      `availableAt ≤ asOf` (geschlossene, bekannte Bars). Die noch offene
 *      HTF-Kerze ist damit strukturell ausgeschlossen — kein Look-ahead.
 *   2. **Validierung**: strukturell ungültige Kerzen im Rechenfenster ⇒
 *      Timeframe fehlt mit Grund `invalid` (kein stilles Reparieren).
 *   3. **Stale-Prüfung**: `asOf − letztesBarEnde > stalePeriods × Perioden` ⇒
 *      Grund `stale` (fail-closed).
 *   4. **Features**: Trend/Momentum/Volatilität (bounded, warmup-geprüft);
 *      zu wenige Bars ⇒ Grund `warmup`.
 *   5. **Aggregation**: Coverage = verfügbares Gewicht; unter `minCoverage` ⇒
 *      `ABSTAIN` (`direction`/`strength`/`bias` = `null`, `confidence` = 0).
 *      Sonst Re-Normalisierung, Richtung, Stärke, Konflikt
 *      (gewichtete mittlere Abweichung) und
 *      `confidence = coverage × (1 − conflict) × volFactor`.
 *
 * Alle Zahlen sind auf Timeframebeiträge und Barzeiten zurückführbar
 * (`contributions[].barEndMs`, `missing[]`); `reasons` trägt die
 * maschinenlesbaren Hinweise.
 */

import { createHash } from "node:crypto";
import {
  SUPPORTED_TIMEFRAME_MS,
  type SupportedTimeframe,
} from "@/lib/marketdata/historicalStore";
import { clamp01, roundTo } from "@/scanner/math";
import type { ConfluenceConfig } from "./config";
import { requiredWarmupBars } from "./config";
import { computeTimeframeFeatures, timeframeDirection } from "./features";
import {
  CONFLUENCE_FORMULA_VERSION,
  type ConfluenceBias,
  type ConfluenceCandle,
  type ConfluenceInput,
  type ConfluenceMissingReason,
  type ConfluenceSnapshot,
  type ConfluenceStatus,
  type TimeframeContribution,
  type TimeframeFeatures,
  type TimeframeMissing,
} from "./types";

/** Interne Sicht auf eine ausgerichtete Reihe (nach Schritt 1–3). */
interface AlignedSeries {
  timeframe: SupportedTimeframe;
  /** Geschlossene+verfügbare, valide, aufsteigend sortierte Kerzen (Fenster). */
  candles: ConfluenceCandle[];
  /** Jüngstes Bar-Ende (Epoch-ms). */
  lastBarEndMs: number;
}

function isValidCandle(c: ConfluenceCandle): boolean {
  return (
    Number.isInteger(c.time) &&
    c.time > 0 &&
    Number.isFinite(c.open) &&
    c.open > 0 &&
    Number.isFinite(c.high) &&
    c.high > 0 &&
    Number.isFinite(c.low) &&
    c.low > 0 &&
    Number.isFinite(c.close) &&
    c.close > 0 &&
    Number.isFinite(c.volume) &&
    c.volume >= 0 &&
    c.high >= c.low &&
    c.close >= c.low &&
    c.close <= c.high
  );
}

/**
 * Richtet EINE Reihe am gemeinsamen Entscheidungszeitpunkt aus.
 *
 * @returns Ausgerichtete Reihe oder den Missing-Grund mit stabilem Detail.
 */
function alignSeries(
  timeframe: SupportedTimeframe,
  candles: readonly ConfluenceCandle[],
  asOfMs: number,
  config: ConfluenceConfig,
): { aligned: AlignedSeries } | { missing: Omit<TimeframeMissing, "timeframe" | "weight"> } {
  const tfMs = SUPPORTED_TIMEFRAME_MS[timeframe];
  const rows = Array.isArray(candles) ? candles : [];

  // Nur geschlossene (`barEnd ≤ asOf`) UND verfügbare (`availableAt ≤ asOf`).
  const closed: ConfluenceCandle[] = [];
  for (const c of rows) {
    if (!c || typeof c !== "object") continue;
    if (!Number.isInteger(c.time) || c.time <= 0) continue;
    if (c.time + tfMs > asOfMs) continue; // offene/unvollständige Bar — kein Look-ahead
    if (c.availableAtMs !== undefined) {
      if (!Number.isFinite(c.availableAtMs)) continue;
      if (c.availableAtMs > asOfMs) continue; // zum Entscheidungszeitpunkt unbekannt
    }
    closed.push(c);
  }
  if (closed.length === 0) {
    return {
      missing: {
        reason: "no-closed-bars",
        detail: `keine geschlossene Bar mit barEnd<=asOf (${new Date(asOfMs).toISOString()})`,
      },
    };
  }

  // Deterministische Ordnung: ts aufsteigend; Duplikate behalten die letzte
  // verfügbare Kerze (stabile Dedup-Regel wie im Store: identischer Schlüssel
  // ⇒ letzter gewinnt, dokumentiert und reihenfolgenunabhängig via Sortierung).
  const sorted = [...closed].sort((a, b) => a.time - b.time);
  const deduped: ConfluenceCandle[] = [];
  for (const c of sorted) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.time === c.time) deduped[deduped.length - 1] = c;
    else deduped.push(c);
  }

  // Rechenfenster: die jüngsten `maxBars` Bars (gedeckelt, deterministisch).
  const window = deduped.slice(-config.maxBars);

  // Strukturelle Validierung ÜBER DAS FENSTER (kein stilles Reparieren).
  for (const c of window) {
    if (!isValidCandle(c)) {
      return {
        missing: {
          reason: "invalid",
          detail: `ungueltige Kerze im Rechenfenster (ts=${c.time}, OHLC-Regel verletzt)`,
        },
      };
    }
  }

  const lastBarEndMs = window[window.length - 1].time + tfMs;

  // Stale: jüngstes Bar-Ende älter als `stalePeriods` Perioden.
  const ageMs = asOfMs - lastBarEndMs;
  const staleAfterMs = config.stalePeriods * tfMs;
  if (ageMs > staleAfterMs) {
    return {
      missing: {
        reason: "stale",
        detail:
          `letztes Bar-Ende ${new Date(lastBarEndMs).toISOString()} ist ` +
          `${Math.floor(ageMs / tfMs)} Perioden alt (Schwelle ${config.stalePeriods})`,
      },
    };
  }

  // Warmup: genug geschlossene Bars für ALLE Features?
  const warmup = requiredWarmupBars(config);
  if (window.length < warmup) {
    return {
      missing: {
        reason: "warmup",
        detail: `${window.length}/${warmup} geschlossene Bars (Features brauchen ${warmup})`,
      },
    };
  }

  return { aligned: { timeframe, candles: window, lastBarEndMs } };
}

/**
 * Baut den stabilen Snapshot-Schlüssel (Idempotency):
 * `mtf1:<sha256 über instrumentId|asOfMs|barEnds|configVersion|formula>(16 Hex)`.
 * Eingabereihenfolge-unabhängig (kanonische TF-Sortierung der Bar-Enden).
 */
export function confluenceSnapshotKey(args: {
  instrumentId: string;
  asOfMs: number;
  /** Bar-Enden je VERFÜGBAREM Timeframe (`tf:barEndMs`), unsortiert ok. */
  barEnds: readonly string[];
  configVersion: number;
}): string {
  const canonical = [...args.barEnds].sort().join(",");
  const preimage = [
    args.instrumentId,
    String(args.asOfMs),
    canonical,
    String(args.configVersion),
    CONFLUENCE_FORMULA_VERSION,
  ].join("|");
  const hex = createHash("sha256").update(preimage, "utf8").digest("hex").slice(0, 16);
  return `mtf1:${hex}`;
}

/**
 * Berechnet den deterministischen Konfluenzsnapshot. Reine Funktion:
 * kein I/O, keine Uhr (außer injiziertem `computedAtMs`), kein Zufall.
 *
 * @param input Instrument, as-of und Eingabereihen (Reihenfolge egal).
 * @param config Validierte, versionierte Konfiguration.
 * @param computedAtMs Protokollzeit (Default: `asOfMs` — deterministisch für
 *   Golden Tests; Live-Pfade dürfen `Date.now()` injizieren).
 */
export function computeConfluence(
  input: ConfluenceInput,
  config: ConfluenceConfig,
  computedAtMs?: number,
): ConfluenceSnapshot {
  const asOfMs = input.asOfMs;
  if (!Number.isFinite(asOfMs) || asOfMs <= 0) {
    throw new Error("computeConfluence: asOfMs muss eine positive Epoch-ms-Zahl sein");
  }
  const instrumentId = typeof input.instrumentId === "string" ? input.instrumentId : "";
  if (instrumentId === "") {
    throw new Error("computeConfluence: instrumentId darf nicht leer sein");
  }

  // Kanonische TF-Ordnung: aufsteigend nach Periodenlänge (Eingabereihenfolge egal).
  const orderedTfs = [...config.timeframes].sort(
    (a, b) => SUPPORTED_TIMEFRAME_MS[a] - SUPPORTED_TIMEFRAME_MS[b],
  );
  const byTf = new Map<SupportedTimeframe, readonly ConfluenceCandle[]>();
  for (const s of input.series ?? []) {
    if (!s || typeof s !== "object") continue;
    // Nur konfigurierte Timeframes; doppelte Reihen ⇒ erste gewinnt
    // (deterministisch durch kanonische Nachsortierung der Kerzen ohnehin).
    if (!orderedTfs.includes(s.timeframe)) continue;
    if (!byTf.has(s.timeframe)) byTf.set(s.timeframe, s.candles ?? []);
  }

  const contributions: TimeframeContribution[] = [];
  const missing: TimeframeMissing[] = [];
  const reasons: string[] = [];
  // Zwischenspeicher für die Aggregation (ungekürzt bis zur finalen Rundung).
  const parts: { tf: SupportedTimeframe; weight: number; direction: number; vol: number }[] = [];

  for (const tf of orderedTfs) {
    const weight = config.weights[tf] ?? 0;
    const series = byTf.get(tf);
    if (series === undefined) {
      missing.push({
        timeframe: tf,
        weight: roundTo(weight),
        reason: "unavailable",
        detail: "keine Reihe geliefert (z. B. Sync-Luecke)",
      });
      reasons.push(`timeframe-missing:${tf}:unavailable`);
      continue;
    }
    const aligned = alignSeries(tf, series, asOfMs, config);
    if ("missing" in aligned) {
      missing.push({ timeframe: tf, weight: roundTo(weight), ...aligned.missing });
      reasons.push(`timeframe-missing:${tf}:${aligned.missing.reason}`);
      continue;
    }
    const { candles, lastBarEndMs } = aligned.aligned;
    const closes = candles.map((c) => c.close);
    const features: TimeframeFeatures | null = computeTimeframeFeatures(
      closes,
      candles,
      config.features,
    );
    if (!features) {
      // Defensive zweite Warmup-/Validitätsprüfung (alignSeries prüft bereits;
      // diese Zeile ist nur bei interner Inkonsistenz erreichbar).
      missing.push({
        timeframe: tf,
        weight: roundTo(weight),
        reason: "warmup",
        detail: "Features nicht berechenbar (Warmup/Validitaet)",
      });
      reasons.push(`timeframe-missing:${tf}:warmup`);
      continue;
    }
    const direction = timeframeDirection(features, config.features);
    const strength = roundTo(Math.abs(direction));
    contributions.push({
      timeframe: tf,
      weight: roundTo(weight),
      effectiveWeight: 0, // wird nach der Coverage-Bestimmung gesetzt
      direction,
      strength,
      features,
      barEndMs: lastBarEndMs,
      barEnd: new Date(lastBarEndMs).toISOString(),
      barsUsed: candles.length,
    });
    parts.push({ tf, weight, direction, vol: features.volatility });
  }

  // ── Aggregation ──────────────────────────────────────────────────────────
  const configuredWeight = orderedTfs.reduce((a, tf) => a + (config.weights[tf] ?? 0), 0);
  const availableWeight = parts.reduce((a, p) => a + p.weight, 0);
  const coverage = configuredWeight > 0 ? availableWeight / configuredWeight : 0;
  const coverageR = roundTo(clamp01(coverage));

  const computedAt = new Date(
    computedAtMs !== undefined && Number.isFinite(computedAtMs) ? computedAtMs : asOfMs,
  ).toISOString();
  const barEnds = contributions.map((c) => `${c.timeframe}:${c.barEndMs}`);
  const snapshotKey = confluenceSnapshotKey({
    instrumentId,
    asOfMs,
    barEnds,
    configVersion: config.version,
  });

  // Fail-closed: unter der Mindestcoverage gibt es KEIN Signal.
  if (coverage < config.minCoverage || parts.length === 0) {
    if (!reasons.includes("coverage-below-minimum")) reasons.push("coverage-below-minimum");
    return {
      formulaVersion: CONFLUENCE_FORMULA_VERSION,
      configVersion: config.version,
      instrumentId,
      asOf: new Date(asOfMs).toISOString(),
      asOfMs,
      computedAt,
      snapshotKey,
      status: "ABSTAIN",
      direction: null,
      strength: null,
      bias: null,
      confidence: 0,
      coverage: coverageR,
      conflict: roundTo(conflictOf(parts, availableWeight)),
      contributions,
      missing,
      reasons: [...reasons].sort(),
    };
  }

  // Re-Normalisierung über die verfügbaren Timeframes.
  for (const c of contributions) {
    const w = config.weights[c.timeframe] ?? 0;
    c.effectiveWeight = roundTo(availableWeight > 0 ? w / availableWeight : 0);
  }
  const directionRaw = parts.reduce((a, p) => a + (p.weight / availableWeight) * p.direction, 0);
  const strengthRaw = parts.reduce(
    (a, p) => a + (p.weight / availableWeight) * Math.abs(p.direction),
    0,
  );
  const conflictRaw = conflictOf(parts, availableWeight);
  // Volatilitätsdämpfer: extreme Streckung halbiert die Confidence (maximal).
  const volPenalty = parts.reduce((a, p) => {
    const over =
      p.vol > config.features.volHigh
        ? (p.vol - config.features.volHigh) / (1 - config.features.volHigh)
        : 0;
    return a + (p.weight / availableWeight) * 0.5 * clamp01(over);
  }, 0);
  const volFactor = 1 - clamp01(volPenalty);
  const confidence = clamp01(coverage * (1 - conflictRaw) * volFactor);

  const direction = roundTo(directionRaw);
  const strength = roundTo(strengthRaw);
  const conflict = roundTo(conflictRaw);
  const bias: ConfluenceBias =
    direction > config.biasThreshold ? "BULLISH" : direction < -config.biasThreshold ? "BEARISH" : "NEUTRAL";

  let status: ConfluenceStatus = "OK";
  if (missing.length > 0 || conflictRaw > config.conflictThreshold) {
    status = "DEGRADED";
    if (conflictRaw > config.conflictThreshold) reasons.push("conflict-high");
  }

  return {
    formulaVersion: CONFLUENCE_FORMULA_VERSION,
    configVersion: config.version,
    instrumentId,
    asOf: new Date(asOfMs).toISOString(),
    asOfMs,
    computedAt,
    snapshotKey,
    status,
    direction,
    strength,
    bias,
    confidence: roundTo(confidence),
    coverage: coverageR,
    conflict,
    contributions,
    missing,
    reasons: [...reasons].sort(),
  };
}

/**
 * Konflikt ∈ [0, 1]: gewichtete mittlere absolute Abweichung der
 * Timeframe-Richtungen vom gewichteten Mittel (0 = voll einig).
 * Für Richtungen in [-1, 1] ist das Mittel der Beträge ≤ 1 (skalentreu).
 */
function conflictOf(
  parts: readonly { weight: number; direction: number }[],
  availableWeight: number,
): number {
  if (parts.length === 0 || !(availableWeight > 0)) return 0;
  const mean = parts.reduce((a, p) => a + (p.weight / availableWeight) * p.direction, 0);
  const mad = parts.reduce(
    (a, p) => a + (p.weight / availableWeight) * Math.abs(p.direction - mean),
    0,
  );
  return clamp01(mad);
}

/**
 * Kompakte, einzeilige Darstellung für Prompts/Logs (keine Secrets, keine
 * Fremdtexte — nur Zahlen, Codes und die Instrument-ID).
 */
export function formatConfluenceLine(snapshot: ConfluenceSnapshot): string {
  const dir = snapshot.direction === null ? "n/a" : snapshot.direction.toFixed(3);
  const str = snapshot.strength === null ? "n/a" : snapshot.strength.toFixed(3);
  const parts = snapshot.contributions.map(
    (c) => `${c.timeframe}:${c.direction >= 0 ? "+" : ""}${c.direction.toFixed(2)}(w${c.effectiveWeight.toFixed(2)})`,
  );
  const miss = snapshot.missing.map((m) => `${m.timeframe}:${m.reason}`);
  return (
    `MTF-CONFLUENCE ${snapshot.formulaVersion} status=${snapshot.status} ` +
    `direction=${dir} strength=${str} confidence=${snapshot.confidence.toFixed(3)} ` +
    `coverage=${snapshot.coverage.toFixed(2)} conflict=${snapshot.conflict.toFixed(3)} ` +
    `bias=${snapshot.bias ?? "n/a"} [${parts.join(" ")}]` +
    (miss.length > 0 ? ` missing=[${miss.join(" ")}]` : "") +
    ` key=${snapshot.snapshotKey}`
  );
}
