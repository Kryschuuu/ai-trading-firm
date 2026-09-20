/**
 * Qualitäts-Layer für Kerzenserien (GAP-07, v1.47.0).
 *
 * Grundprinzip: Qualitätsbefunde werden **sichtbar klassifiziert** (MDERR-Stil)
 * und niemals still bereinigt. Der Layer
 *
 *  - validiert Serien (`validateCandleSeries`) gegen vier Klassen:
 *    `GAP` (fehlende Intervalle), `OUTLIER` (Wick/Körper > N×ATR),
 *    `INVALID` (OHLC ≤ 0, high < low, close außerhalb [low, high]) und
 *    `DUPLICATE` (doppelter Zeitstempel),
 *  - persistiert je Lauf einen **Report je Instrument** in
 *    `data/marketdata/quality-report.json` (gitignored, Laufzeit-Artefakt,
 *    `resolveRuntimePath` — derselbe Cross-Prozess-Pfad-Fix wie das
 *    Fehler-Manifest, v1.40.0),
 *  - zählt Befunde prozesslokal in die Metrik
 *    `market_data_quality_findings_total` (Label: Klasse),
 *  - kennt zwei Modi (`MARKETDATA_QUALITY_MODE`):
 *      `log` (Default) — nur sichtbar machen;
 *      `strict` — Instrumente mit INVALID-Befund behandelt der Lesepfad
 *        wie `DATA_UNAVAILABLE` (existierende Stale-Fallback-Kette, fail-closed).
 *
 * **Unveränderlichkeit:** Die Eingabeserie wird nie mutiert (reines
 * Lese-Versprechen, durch Freeze-Tests belegt). Gespeicherte Historie wird
 * von diesem Layer nie umgeschrieben — der Report ist ein *neues* Artefakt.
 *
 * **Flash-Move-Schutz:** Die Outlier-Schwelle ist bewusst großzügig
 * (Default 25 × ATR, Bounds [5, 200]). Ein realistischer Flash-Move bleibt
 * unterhalb der Schwelle und erzeugt KEINEN Befund — weggefilterte
 * Flash-Crashes wären schlechter als das Rauschen, das sie verhindern.
 *
 * Security (wie `dataErrors.ts`): Report-Felder sind stabile Codes
 * (`instrumentId`, klassifizierte Klasse, Zeitstempel) — keine Rohmeldungen,
 * keine URLs, keine Secrets.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { MarketDataErrorReason } from "../lib/marketDataErrors";
import { resolveRuntimePath } from "../lib/appPaths";
import {
  SUPPORTED_TIMEFRAME_MS,
  type SupportedTimeframe,
} from "../lib/marketdata/historicalStore";
import { telemetry } from "../lib/telemetry";
import { candleTimeMs } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Klassen und Kontrakte
// ─────────────────────────────────────────────────────────────────────────────

/** Geschlossene Befundklassen des Qualitäts-Layers. */
export type QualityClass = "GAP" | "OUTLIER" | "INVALID" | "DUPLICATE" | "CROSSCHECK";

export const QUALITY_CLASSES: readonly QualityClass[] = [
  "GAP",
  "OUTLIER",
  "INVALID",
  "DUPLICATE",
  "CROSSCHECK",
] as const;

/**
 * Abbildung Qualitäts-Klasse → MDERR-Taxonomie (GAP-07). Der Sync-Report und
 * der Sync-Status verwenden diese IDs; die Metrik nutzt die Klasse selbst.
 */
export const QUALITY_REASON: Record<QualityClass, MarketDataErrorReason> = {
  GAP: "QUALITY_GAP",
  OUTLIER: "QUALITY_OUTLIER",
  INVALID: "QUALITY_INVALID",
  DUPLICATE: "QUALITY_DUPLICATE",
  CROSSCHECK: "QUALITY_CROSSCHECK",
};

/** Prüft einen Wert gegen die geschlossene Klassen-Aufzählung. */
export function isQualityClass(value: unknown): value is QualityClass {
  return typeof value === "string" && (QUALITY_CLASSES as readonly string[]).includes(value);
}

/** Minimaler Kerzen-Contract (zeitstempelfähig wie `MarketCandle`: `time` ∪ `ts`). */
export interface QualityCandle {
  time?: number;
  ts?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Ein einzelner, klassifizierter Befund. */
export interface QualityFinding {
  /** Befundklasse (geschlossene Aufzählung). */
  cls: QualityClass;
  /** Zeitpunkt des Befunds (GAP = erste fehlende erwartete Kerze). */
  ts?: number;
  /** Kurze, stabile Beschreibung — keine Rohmeldungen, keine URLs. */
  detail: string;
}

/** Report einer einzelnen Reihe (Instrument ⟂ Timeframe). */
export interface QualitySeriesReport {
  instrumentId: string;
  timeframe: string;
  /** Eingangs-Kerzen (vor Dedup). */
  candles: number;
  /** Findings je Klasse (alle fünf Klassen immer vorhanden, 0-fall mitgeführt). */
  counts: Record<QualityClass, number>;
  findings: QualityFinding[];
  /**
   * Cross-Check: verglichene Zeitstempel mit der Zweitquelle (nur gesetzt,
   * wenn der Cross-Check aktiv war). `0` = keine Überlappung (kein Befund —
   * kein Vergleich ≠ Abweichung).
   */
  crosscheckCompared?: number;
}

/** Gesamt-Report eines Laufs (Datei `data/marketdata/quality-report.json`). */
export interface QualityReport {
  writtenAt: string;
  mode: QualityMode;
  series: QualitySeriesReport[];
  totals: {
    series: number;
    candles: number;
    byClass: Record<QualityClass, number>;
  };
}

/** Lesepfad-Modus des Qualitäts-Layers. */
export type QualityMode = "log" | "strict";

// ─────────────────────────────────────────────────────────────────────────────
// Konfiguration (Env + Bounds, Muster `loadMarketRegimeConfig`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stale-Schwellen je Timeframe in Stunden. Default: 26 h für 1h (etwas mehr
 * als eine Periode + eine volle Ausfallperiode für den Stundentimer); 4h/1d
 * skaliert sinngemäß (26 × Periodenfaktor). Die drei dokumentierten
 * Produktiv-Timeframes sind explizit konfigurierbar; die übrigen Timeframes
 * skalieren proportional (nur als Default — Override gibt es nur für 1h/4h/1d,
 * damit die Flags-Fläche klein bleibt).
 */
export const STALE_HOURS_ENV: Record<"1h" | "4h" | "1d", string> = {
  "1h": "MARKETDATA_STALE_1H_HOURS",
  "4h": "MARKETDATA_STALE_4H_HOURS",
  "1d": "MARKETDATA_STALE_1D_HOURS",
};

/** Bounds der Stale-Schwellen (Stunden) je konfigurierbarem Timeframe. */
export const STALE_HOURS_BOUNDS: Record<"1h" | "4h" | "1d", readonly [number, number]> = {
  "1h": [2, 168],
  "4h": [8, 672],
  "1d": [48, 4032],
};

/** Default-Stale-Schwelle (Stunden) je Timeframe. */
export const DEFAULT_STALE_HOURS: Record<SupportedTimeframe, number> = Object.fromEntries(
  (Object.keys(SUPPORTED_TIMEFRAME_MS) as SupportedTimeframe[]).map((tf) => [
    tf,
    26 * (SUPPORTED_TIMEFRAME_MS[tf] / SUPPORTED_TIMEFRAME_MS["1h"]),
  ]),
) as Record<SupportedTimeframe, number>;

/** Outlier-Schwelle (× ATR): bewusst großzügig, Bounds [5, 200]. */
export const OUTLIER_ATR_MULT_ENV = "MARKETDATA_OUTLIER_ATR_MULT";
export const OUTLIER_ATR_MULT_DEFAULT = 25;
export const OUTLIER_ATR_MULT_BOUNDS: readonly [number, number] = [5, 200];

/** Cross-Check-Toleranz in Prozent (Default 1, Bounds [0.1, 10]). */
export const CROSSCHECK_TOLERANCE_ENV = "MARKETDATA_CROSSCHECK_TOLERANCE_PCT";
export const CROSSCHECK_TOLERANCE_DEFAULT = 1;
export const CROSSCHECK_TOLERANCE_BOUNDS: readonly [number, number] = [0.1, 10];

/** Env-Flags (Name → Doku in CONFIGURATION.md). */
export const QUALITY_MODE_ENV = "MARKETDATA_QUALITY_MODE";
export const CROSSCHECK_ENABLED_ENV = "MARKETDATA_CROSSCHECK";
export const AGGREGATE_ENABLED_ENV = "MARKET_SYNC_AGGREGATE";

/**
 * Lesbarer Report-Pfad. Relativ gehalten und über `resolveRuntimePath`
 * aufgelöst (CLI vs. Next.js sehen dieselbe Datei — dasselbe Muster wie
 * `dataErrors.ts`/`syncStatus.ts`, v1.40.0).
 */
export const QUALITY_REPORT_FILE = path.join("data", "marketdata", "quality-report.json");

const clampNum = (v: number, [min, max]: readonly [number, number]): number =>
  Number.isFinite(v) ? Math.min(Math.max(v, min), max) : min;

/** `MARKETDATA_QUALITY_MODE` → `log` | `strict` (unbekannt → `log`, fail-loud). */
export function parseQualityMode(raw: string | undefined, warn?: (line: string) => void): QualityMode {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "log" || v === "strict") return v;
  if (v !== "") warn?.(`MARKETDATA_QUALITY_MODE=\"${v}\" ist unbekannt — es gilt \"log\".`);
  return "log";
}

/** `MARKET_SYNC_AGGREGATE`/`MARKETDATA_CROSSCHECK` → `true` nur bei `on`/`true`/`1`. */
export function parseOnFlag(raw: string | undefined): boolean {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
}

export interface QualityConfig {
  /** Lesepfad-Modus (Default `log`). */
  mode: QualityMode;
  /** Outlier-Schwelle in × Baseline (Default 25, Bounds [5, 200], mit Clamp). */
  outlierAtrMult: number;
  /** Stale-Schwellen je Timeframe in Stunden (Bounds-geclampt). */
  staleHours: Record<SupportedTimeframe, number>;
  /** Zweitquellen-Cross-Check aktiv (Default off — Rate-Limits!). */
  crosscheck: boolean;
  /** Cross-Check-Toleranz in % (Default 1, Bounds [0.1, 10], mit Clamp). */
  crosscheckTolerancePct: number;
}

/**
 * Lädt die Qualitäts-Konfiguration aus der Umgebung (Bounds-Clamp + sichere
 * Defaults; Muster `loadMarketRegimeConfig`/`loadExitConfig`). `overrides`
 * (Tests) überschreiben Env-Werte und werden ebenfalls geklemmt.
 */
export function loadQualityConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  overrides: Partial<QualityConfig> = {},
  warn?: (line: string) => void,
): QualityConfig {
  const staleHours = { ...DEFAULT_STALE_HOURS };
  for (const tf of ["1h", "4h", "1d"] as const) {
    const raw = env[STALE_HOURS_ENV[tf]];
    if (raw !== undefined && raw.trim() !== "") {
      const n = Number(raw);
      if (Number.isFinite(n)) {
        const clamped = clampNum(n, STALE_HOURS_BOUNDS[tf]);
        if (clamped !== n) {
          warn?.(`${STALE_HOURS_ENV[tf]}=${n} h außerhalb von [${STALE_HOURS_BOUNDS[tf][0]}, ${STALE_HOURS_BOUNDS[tf][1]}] — geklemmt auf ${clamped} h.`);
        }
        staleHours[tf] = clamped;
      } else {
        warn?.(`${STALE_HOURS_ENV[tf]}=\"${raw}\" ist keine Zahl — Default ${DEFAULT_STALE_HOURS[tf]} h gilt.`);
      }
    }
  }

  let outlierAtrMult = OUTLIER_ATR_MULT_DEFAULT;
  const rawMult = env[OUTLIER_ATR_MULT_ENV];
  if (rawMult !== undefined && rawMult.trim() !== "") {
    const n = Number(rawMult);
    if (Number.isFinite(n)) {
      const clamped = clampNum(n, OUTLIER_ATR_MULT_BOUNDS);
      if (clamped !== n) {
        warn?.(`${OUTLIER_ATR_MULT_ENV}=${n} außerhalb von [${OUTLIER_ATR_MULT_BOUNDS[0]}, ${OUTLIER_ATR_MULT_BOUNDS[1]}] — geklemmt auf ${clamped}.`);
      }
      outlierAtrMult = clamped;
    } else {
      warn?.(`${OUTLIER_ATR_MULT_ENV}=\"${rawMult}\" ist keine Zahl — Default ${OUTLIER_ATR_MULT_DEFAULT} gilt.`);
    }
  }

  let crosscheckTolerancePct = CROSSCHECK_TOLERANCE_DEFAULT;
  const rawTol = env[CROSSCHECK_TOLERANCE_ENV];
  if (rawTol !== undefined && rawTol.trim() !== "") {
    const n = Number(rawTol);
    if (Number.isFinite(n)) {
      const clamped = clampNum(n, CROSSCHECK_TOLERANCE_BOUNDS);
      if (clamped !== n) {
        warn?.(`${CROSSCHECK_TOLERANCE_ENV}=${n} außerhalb von [${CROSSCHECK_TOLERANCE_BOUNDS[0]}, ${CROSSCHECK_TOLERANCE_BOUNDS[1]}] — geklemmt auf ${clamped}.`);
      }
      crosscheckTolerancePct = clamped;
    } else {
      warn?.(`${CROSSCHECK_TOLERANCE_ENV}=\"${rawTol}\" ist keine Zahl — Default ${CROSSCHECK_TOLERANCE_DEFAULT} % gilt.`);
    }
  }

  const base: QualityConfig = {
    mode: parseQualityMode(env[QUALITY_MODE_ENV], warn),
    outlierAtrMult,
    staleHours,
    crosscheck: parseOnFlag(env[CROSSCHECK_ENABLED_ENV]),
    crosscheckTolerancePct,
  };
  return { ...base, ...overrides };
}

// ─────────────────────────────────────────────────────────────────────────────
// D1 — Serien-Validierung (reine Funktion, deterministisch, read-only)
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidateCandleSeriesOptions {
  /** Erwartetes Intervall in ms (z. B. `SUPPORTED_TIMEFRAME_MS["1h"]`). */
  expectedIntervalMs: number;
  /** Outlier-Schwelle in × Baseline (Default 25; nur `>` erzeugt einen Befund). */
  outlierAtrMult?: number;
}

/** Interne, geprüfte Kerze (Zeitstempel aufgelöst, Struktur validiert). */
interface CheckedCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  valid: boolean;
}

const isPosFinite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Validiert EINE Kerzenserie (ts-aufsteigend erwartet, Reihenfolge ist aber
 * egal — die Funktion sortiert intern). Reine Funktion:
 *
 *  - **mutiert die Eingabe nie** (kein Sortieren auf dem Array, keine
 *    Property-Schreibzugriffe — Freeze-Test),
 *  - ist **deterministisch** (gleiche Eingabe → byte-identischer Report).
 *
 * Klassen und Regeln:
 *
 * | Klasse | Regel |
 * | --- | --- |
 * | `DUPLICATE` | derselbe Zeitstempel ≥ 2× (jede weitere Vorkommnis ist ein Befund) |
 * | `INVALID` | OHLC ≤ 0 / nicht endlich, `high < low`, `close` außerhalb `[low, high]` |
 * | `GAP` | Abstand zweier Folgekerzen > `expectedIntervalMs` → eine Befund je Lücke an der ersten erwarteten fehlenden Position (exakt `expectedIntervalMs` Abstand = **kein** Befund) |
 * | `OUTLIER` | Wick **oder** Körper **streng** > `outlierAtrMult × Baseline` (Genauigkeit: gleich groß = kein Befund; Baseline = leave-one-out-Mittel der True-Ranges der strukturell gültigen Kerzen) |
 *
 * `GAP`/`OUTLIER` werden nur über strukturell gültige, eindeutige Kerzen
 * berechnet — eine INVALID-Kerze vergiftet weder Gap-Logik noch Volatilitäts-Baseline.
 */
export function validateCandleSeries(
  series: readonly QualityCandle[],
  opts: ValidateCandleSeriesOptions,
): QualitySeriesReport {
  const counts: Record<QualityClass, number> = {
    GAP: 0,
    OUTLIER: 0,
    INVALID: 0,
    DUPLICATE: 0,
    CROSSCHECK: 0,
  };
  const findings: QualityFinding[] = [];
  const rows = Array.isArray(series) ? series : [];
  const intervalMs = Number.isFinite(opts.expectedIntervalMs) && opts.expectedIntervalMs > 0
    ? Math.floor(opts.expectedIntervalMs)
    : 0;
  const atrMult = Number.isFinite(opts.outlierAtrMult) && (opts.outlierAtrMult as number) > 0
    ? (opts.outlierAtrMult as number)
    : OUTLIER_ATR_MULT_DEFAULT;

  // 1. Zeitstempel auflösen + strukturelle Prüfung (OHLC/High-Low/Close-Enveloppe).
  const checked: CheckedCandle[] = rows.map((c) => {
    const ts = candleTimeMs(c as QualityCandle | null | undefined);
    const open = c?.open;
    const high = c?.high;
    const low = c?.low;
    const close = c?.close;
    const numericOk = isPosFinite(open) && isPosFinite(high) && isPosFinite(low) && isPosFinite(close);
    return {
      ts: ts ?? 0,
      open: typeof open === "number" ? open : NaN,
      high: typeof high === "number" ? high : NaN,
      low: typeof low === "number" ? low : NaN,
      close: typeof close === "number" ? close : NaN,
      valid: ts !== null && numericOk && high >= low && close >= low && close <= high,
    };
  });

  // 2. INVALID (je Kerze, stabile Reihenfolge über die Eingabe).
  checked.forEach((k, i) => {
    const c = rows[i] as QualityCandle | undefined;
    if (candleTimeMs(c as QualityCandle | null | undefined) === null) {
      counts.INVALID += 1;
      findings.push({ cls: "INVALID", detail: "kein verwertbarer Zeitstempel (time/ts)" });
      return;
    }
    const open = c?.open;
    const high = c?.high;
    const low = c?.low;
    const close = c?.close;
    const details: string[] = [];
    if (!isPosFinite(open) || !isPosFinite(high) || !isPosFinite(low) || !isPosFinite(close)) {
      details.push("OHLC nicht endlich oder ≤ 0");
    }
    if (isPosFinite(high) && isPosFinite(low) && high < low) details.push("high < low");
    if (
      isPosFinite(close) &&
      isPosFinite(low) &&
      isPosFinite(high) &&
      (close < low || close > high)
    ) {
      details.push("close außerhalb [low, high]");
    }
    if (details.length > 0) {
      counts.INVALID += 1;
      findings.push({ cls: "INVALID", ts: k.ts, detail: details.join(", ") });
    }
  });

  // 3. Sortierte, eindeutige Ansicht für GAP/OUTLIER (Eigene Kopie — die
  //    Eingabe bleibt unangetastet).
  const indexed = checked.map((k, i) => ({ k, i })).sort((a, b) => a.k.ts - b.k.ts || a.i - b.i);

  // 4. DUPLICATE (jede weitere Vorkommnis desselben ts; Kerzen ohne
  //    Zeitstempel sind bereits INVALID und zählen nicht doppelt).
  const tsOccurrence = new Map<number, number>();
  const unique: CheckedCandle[] = [];
  for (const { k } of indexed) {
    if (k.ts === 0) continue; // ts nicht auflösbar (INVALID) — kein Duplizitäts-Kandidat
    const seen = tsOccurrence.get(k.ts) ?? 0;
    tsOccurrence.set(k.ts, seen + 1);
    if (seen === 0) {
      unique.push(k);
    } else {
      counts.DUPLICATE += 1;
      findings.push({ cls: "DUPLICATE", ts: k.ts, detail: "doppelter Zeitstempel" });
    }
  }

  // 5. GAP (nur strukturell gültige Kerzen; exaktes Intervall = kein Befund).
  const valid = unique.filter((k) => k.valid);
  if (intervalMs > 0) {
    for (let i = 1; i < valid.length; i++) {
      const prev = valid[i - 1];
      const cur = valid[i];
      const delta = cur.ts - prev.ts;
      if (delta > intervalMs) {
        const missing = Math.floor(delta / intervalMs) - 1;
        if (missing > 0) {
          counts.GAP += 1;
          findings.push({
            cls: "GAP",
            ts: prev.ts + intervalMs,
            detail: `erwartete Kerze am ${new Date(prev.ts + intervalMs).toISOString()}, ` +
              `erhalten ${new Date(cur.ts).toISOString()} (${missing} fehlend)`,
          });
        }
      }
    }
  }

  // 6. OUTLIER (strikt > Schwelle — der Grenzwert SELBST erzeugt keinen
  //    Befund, echte Flash-Moves durchkommen). Baseline je Kerze:
  //    leave-one-out-Mittel der True-Ranges (die geprüfte Kerze selbst
  //    verunreinigt ihre eigene Schwelle nicht — sonst könnte ein einzelner
  //    Spike in kurzen Serien selbst seinen Schwellwert aufblähen).
  const trs = trueRanges(valid);
  const sumTr = trs.reduce((a, b) => a + b, 0);
  if (trs.length >= 2) {
    for (let i = 1; i < valid.length; i++) {
      const k = valid[i];
      const baseline = (sumTr - trs[i - 1]) / (trs.length - 1);
      if (!Number.isFinite(baseline) || baseline <= 0) continue;
      const wick = Math.max(k.high - Math.max(k.open, k.close), Math.min(k.open, k.close) - k.low);
      const body = Math.abs(k.close - k.open);
      const threshold = atrMult * baseline;
      if (wick > threshold || body > threshold) {
        counts.OUTLIER += 1;
        const kind = wick >= body ? "Wick" : "Körper";
        findings.push({
          cls: "OUTLIER",
          ts: k.ts,
          detail: `${kind} ${Math.max(wick, body).toFixed(4)} > Schwelle ${threshold.toFixed(4)} (${atrMult} × Baseline ${baseline.toFixed(6)})`,
        });
      }
    }
  }

  // Stabile Reihenfolge: ts aufsteigend, bei Gleichstand nach Eingabe-Index
  // (alle Befunde tragen ts; INVALID ohne ts steht am Series-Anfang).
  findings.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  return {
    instrumentId: "",
    timeframe: "",
    candles: rows.length,
    counts,
    findings,
  };
}

/**
 * True-Ranges der strukturell gültigen Kerzen (deterministisch):
 * `TR[i] = max(high-low, |high-prevClose|, |low-prevClose|)` für i ≥ 1
 * (die erste Kerze hat keinen Vorgängerschluss → kein TR).
 */
export function trueRanges(
  valid: readonly { high: number; low: number; close: number }[],
): number[] {
  const trs: number[] = [];
  for (let i = 1; i < valid.length; i++) {
    const h = valid[i].high;
    const l = valid[i].low;
    const prevClose = valid[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose)));
  }
  return trs;
}

// ─────────────────────────────────────────────────────────────────────────────
// D1 — Report-Persistenz (gitignored Laufzeit-Artefakt, atomar)
// ─────────────────────────────────────────────────────────────────────────────

/** Baut einen Gesamt-Report aus Reihen-Berichten (deterministisch sortiert). */
export function buildQualityReport(
  series: readonly QualitySeriesReport[],
  mode: QualityMode,
  now: Date = new Date(),
): QualityReport {
  const sorted = [...series].sort(
    (a, b) =>
      a.instrumentId.localeCompare(b.instrumentId) || a.timeframe.localeCompare(b.timeframe),
  );
  const totals: QualityReport["totals"] = {
    series: sorted.length,
    candles: 0,
    byClass: { GAP: 0, OUTLIER: 0, INVALID: 0, DUPLICATE: 0, CROSSCHECK: 0 },
  };
  for (const s of sorted) {
    totals.candles += s.candles;
    for (const cls of QUALITY_CLASSES) totals.byClass[cls] += s.counts[cls] ?? 0;
  }
  return { writtenAt: now.toISOString(), mode, series: sorted, totals };
}

/**
 * Persistiert den Report atomar (tmp + rename, Modus 0600). Der Report ist
 * das NEUE Artefakt — `data/history/candles.ndjson` wird von diesem Layer
 * nie berührt.
 */
export function saveQualityReport(
  report: QualityReport,
  file: string = QUALITY_REPORT_FILE,
): string {
  const resolved = resolveRuntimePath(file);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(report, null, 2), { mode: 0o600 });
  renameSync(tmp, resolved);
  return resolved;
}

/** Lädt den letzten Report (fehlend/korrupt → `null`, nie ein Wurf). */
export function loadQualityReport(file: string = QUALITY_REPORT_FILE): QualityReport | null {
  try {
    const resolved = resolveRuntimePath(file);
    if (!existsSync(resolved)) return null;
    const parsed = JSON.parse(readFileSync(resolved, "utf8")) as Partial<QualityReport>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.series)) return null;
    const series: QualitySeriesReport[] = [];
    for (const s of parsed.series) {
      if (!s || typeof s !== "object") continue;
      if (typeof s.instrumentId !== "string" || s.instrumentId === "") continue;
      const counts: Record<QualityClass, number> = {
        GAP: 0,
        OUTLIER: 0,
        INVALID: 0,
        DUPLICATE: 0,
        CROSSCHECK: 0,
      };
      if (s.counts && typeof s.counts === "object") {
        for (const cls of QUALITY_CLASSES) {
          const v = (s.counts as Record<string, unknown>)[cls];
          if (typeof v === "number" && Number.isFinite(v) && v >= 0) counts[cls] = Math.floor(v);
        }
      }
      const findings: QualityFinding[] = [];
      if (Array.isArray(s.findings)) {
        for (const f of s.findings) {
          if (!f || typeof f !== "object" || !isQualityClass(f.cls)) continue;
          findings.push({
            cls: f.cls,
            ...(typeof f.ts === "number" && Number.isFinite(f.ts) ? { ts: f.ts } : {}),
            detail: typeof f.detail === "string" ? f.detail.slice(0, 200) : "",
          });
        }
      }
      const crosscheckCompared =
        typeof s.crosscheckCompared === "number" &&
        Number.isFinite(s.crosscheckCompared) &&
        s.crosscheckCompared >= 0
          ? Math.floor(s.crosscheckCompared)
          : null;
      series.push({
        instrumentId: s.instrumentId.slice(0, 128),
        timeframe: typeof s.timeframe === "string" ? s.timeframe.slice(0, 16) : "",
        candles: typeof s.candles === "number" && Number.isFinite(s.candles) ? Math.max(0, Math.floor(s.candles)) : 0,
        counts,
        findings,
        ...(crosscheckCompared !== null ? { crosscheckCompared } : {}),
      });
    }

    // Aggregate ausschließlich aus den defensiv validierten Reihen. Die
    // persistierten Totals sind abgeleitete Daten und können veraltet oder
    // manipuliert sein; beim Laden bleiben sie deshalb nie autoritativ.
    const totals: QualityReport["totals"] = {
      series: series.length,
      candles: 0,
      byClass: { GAP: 0, OUTLIER: 0, INVALID: 0, DUPLICATE: 0, CROSSCHECK: 0 },
    };
    for (const item of series) {
      totals.candles += item.candles;
      for (const cls of QUALITY_CLASSES) totals.byClass[cls] += item.counts[cls];
    }

    return {
      writtenAt: typeof parsed.writtenAt === "string" ? parsed.writtenAt : "",
      mode: parsed.mode === "strict" ? "strict" : "log",
      series,
      totals,
    };
  } catch {
    return null;
  }
}

/**
 * Strikte Lesepfad-Map (fail-closed): Instrumente mit mindestens einem
 * INVALID-Befund werden wie `DATA_UNAVAILABLE` behandelt — dieselbe
 * Stale-Fallback-Kette, die der Scanner für Sync-Fehler kennt
 * (`data-unavailable`-Ablehnung, nie `min-candles`).
 *
 * Nur im Modus `strict`; `log` (Default) liefert leer — Befunde sind dort
 * sichtbar (Report/Log/Metrik), aber wirkungslos.
 */
export function qualityStrictDataErrors(
  report: QualityReport | null,
  mode: QualityMode = "log",
): Map<string, "DATA_UNAVAILABLE"> {
  const out = new Map<string, "DATA_UNAVAILABLE">();
  if (mode !== "strict" || !report) return out;
  for (const s of report.series) {
    if ((s.counts.INVALID ?? 0) > 0) out.set(s.instrumentId, "DATA_UNAVAILABLE");
  }
  return out;
}

/**
 * Lesepfad-Integration für Scanner-Entry-Points (`run-scan.ts`,
 * `ScannerService.refresh`): liest Modus + Report aus der Umgebung/Datei und
 * liefert die DATA_UNAVAILABLE-Map (leer im `log`-Modus und ohne Report).
 * Der Aufrufer MERGT das Ergebnis in seine `dataErrors` — die bestehende
 * Stale-Fallback-Kette des Scanners bleibt die einzige Wirkkette.
 */
export function qualityStrictDataErrorsForScan(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  file: string = QUALITY_REPORT_FILE,
): Map<string, "DATA_UNAVAILABLE"> {
  const mode = parseQualityMode(env[QUALITY_MODE_ENV]);
  if (mode !== "strict") return new Map();
  return qualityStrictDataErrors(loadQualityReport(file), "strict");
}

/** Zählt die Befundklassen in die prozesslokale Metrik (Kardinalität: Klasse). */
export function recordQualityFindings(report: QualityReport): void {
  for (const cls of QUALITY_CLASSES) {
    const n = report.totals.byClass[cls] ?? 0;
    if (n > 0) telemetry.marketData.qualityFindings.inc({ class: cls }, n);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// D2 — Stale-Guard je Instrument/Timeframe
// ─────────────────────────────────────────────────────────────────────────────

/** Zustand einer Reihe aus Sicht des Stale-Guards. */
export interface StaleSeriesState {
  /** `instrumentId \u0000 timeframe` (Reihenschlüssel). */
  seriesKey: string;
  instrumentId: string;
  timeframe: SupportedTimeframe;
  /** Jüngster Zeitstempel der Reihe (ms). */
  lastTs: number;
  /** `nowMs - lastTs` (ms). */
  ageMs: number;
  /** `true` wenn `ageMs` die TF-Schwelle überschreitet. */
  stale: boolean;
}

/**
 * Bewertet Reihen (Store-Einträge) gegen die Stale-Schwellen. Reine Funktion
 * (injizierte `nowMs` — Fake-Clock in Tests, Determinismus).
 *
 * Je Reihe (`instrumentId + timeframe`) zählt nur der JÜNGSTE Zeitstempel;
 * eine Reihe mit frischer letzter Kerze ist nicht stale, egal wie lückig sie
 * davor ist (Lücken sind `GAP`-Befunde, nicht Staleness).
 */
export function evaluateStaleSeries(
  entries: readonly { instrumentId: string; timeframe: string; ts: number }[],
  staleHours: Record<SupportedTimeframe, number>,
  nowMs: number,
): StaleSeriesState[] {
  const lastBySeries = new Map<string, { instrumentId: string; timeframe: string; ts: number }>();
  for (const e of entries) {
    if (typeof e.instrumentId !== "string" || e.instrumentId === "") continue;
    if (typeof e.timeframe !== "string" || !(e.timeframe in SUPPORTED_TIMEFRAME_MS)) continue;
    if (typeof e.ts !== "number" || !Number.isFinite(e.ts) || e.ts <= 0) continue;
    const key = `${e.instrumentId}\u0000${e.timeframe}`;
    const known = lastBySeries.get(key);
    if (known === undefined || e.ts > known.ts) lastBySeries.set(key, e);
  }
  const out: StaleSeriesState[] = [];
  for (const [key, e] of lastBySeries) {
    const tf = e.timeframe as SupportedTimeframe;
    const hours = Number.isFinite(staleHours[tf]) && staleHours[tf] > 0
      ? staleHours[tf]
      : DEFAULT_STALE_HOURS[tf];
    const ageMs = nowMs - e.ts;
    out.push({
      seriesKey: key,
      instrumentId: e.instrumentId,
      timeframe: tf,
      lastTs: e.ts,
      ageMs: Math.max(0, ageMs),
      stale: ageMs > hours * 3_600_000,
    });
  }
  out.sort((a, b) => a.seriesKey.localeCompare(b.seriesKey));
  return out;
}

export interface VenueStaleSummary {
  /** Reihen der Venue insgesamt. */
  totalSeries: number;
  /** Stale-Reihen der Venue (Zähler — kein Symbol im Status, Security). */
  staleSeries: number;
  /** Stale-Reihen je Timeframe (nur Timeframes mit Befund). */
  staleByTimeframe: Record<string, number>;
}

/**
 * Aggregiert den Stale-Zustand je Venue (Präfix `VENUE:` der Instrument-ID).
 * Liefert ausschließlich ZÄHLER — der Sync-Status darf keine Symbole tragen
 * (geschlossene Security-Policy von `syncStatus.ts`).
 */
export function summarizeStaleByVenue(
  entries: readonly { instrumentId: string; timeframe: string; ts: number }[],
  staleHours: Record<SupportedTimeframe, number>,
  nowMs: number,
): Map<string, VenueStaleSummary> {
  const byVenue = new Map<string, { total: number; stale: number; staleTf: Record<string, number> }>();
  const bump = (venue: string, total: boolean, stale: boolean, tf?: string): void => {
    let slot = byVenue.get(venue);
    if (!slot) {
      slot = { total: 0, stale: 0, staleTf: {} };
      byVenue.set(venue, slot);
    }
    if (total) slot.total += 1;
    if (stale) {
      slot.stale += 1;
      if (tf) slot.staleTf[tf] = (slot.staleTf[tf] ?? 0) + 1;
    }
  };
  for (const e of entries) {
    const sep = String(e.instrumentId ?? "").indexOf(":");
    if (sep <= 0) continue;
    bump(String(e.instrumentId).slice(0, sep), true, false);
  }
  for (const s of evaluateStaleSeries(entries, staleHours, nowMs)) {
    const sep = s.instrumentId.indexOf(":");
    if (sep <= 0) continue;
    const venue = s.instrumentId.slice(0, sep);
    if (s.stale) bump(venue, false, true, s.timeframe);
  }
  const out = new Map<string, VenueStaleSummary>();
  for (const [venue, v] of byVenue) {
    out.set(venue, {
      totalSeries: v.total,
      staleSeries: v.stale,
      staleByTimeframe: Object.fromEntries(
        Object.entries(v.staleTf).sort((a, b) => a[0].localeCompare(b[0])),
      ),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// D4 — Zweitquellen-Cross-Check (Interface + Vertrag, opt-in)
// ─────────────────────────────────────────────────────────────────────────────

export interface CrosscheckResult {
  /** Verglichene Paare (gleiches ts in beiden Serien). */
  compared: number;
  /** Maximale Abweichung der Schlusskurse in % (0 wenn nichts verglichen). */
  maxDeviationPct: number;
  /** Zeitstempel des größten Abstands (Diagnose, kein Secret). */
  ts?: number;
  /** Befund wenn `maxDeviationPct > tolerancePct` (streng). */
  finding: QualityFinding | null;
}

/**
 * Vergleicht die Schlusskurse zweier Serien auf gemeinsamen Zeitstempeln.
 * Reine Funktion; Abweichung relativ zum Primärkurs (in %, `1` = 1 %).
 *
 * Vertrag: > `tolerancePct` (Default 1, Bounds [0.1, 10]) ⇒ Befund
 * `CROSSCHECK` (MDERR `QUALITY_CROSSCHECK`) — der Sync loggt zusätzlich
 * einen Alert. Gleich groß = **kein** Befund (Genauigkeit wie beim Outlier).
 * 0 gemeinsame Zeitstempel ⇒ `compared: 0`, kein Befund (kein Vergleich
 * möglich ≠ Abweichung; der Sync meldet das als Warnung, nicht als Befund).
 */
export function crosscheckCandles(
  primary: readonly QualityCandle[],
  secondary: readonly QualityCandle[],
  tolerancePct: number,
): CrosscheckResult {
  const byTs = new Map<number, number>();
  for (const c of Array.isArray(secondary) ? secondary : []) {
    const ts = candleTimeMs(c as QualityCandle | null | undefined);
    if (ts === null) continue;
    if (typeof c?.close !== "number" || !Number.isFinite(c.close) || c.close <= 0) continue;
    byTs.set(ts, c.close);
  }
  let compared = 0;
  let maxDeviationPct = 0;
  let maxTs: number | undefined;
  for (const c of Array.isArray(primary) ? primary : []) {
    const ts = candleTimeMs(c as QualityCandle | null | undefined);
    if (ts === null) continue;
    if (typeof c?.close !== "number" || !Number.isFinite(c.close) || c.close <= 0) continue;
    const other = byTs.get(ts);
    if (other === undefined) continue;
    compared += 1;
    const dev = (Math.abs(c.close - other) / c.close) * 100;
    if (dev > maxDeviationPct) {
      maxDeviationPct = dev;
      maxTs = ts;
    }
  }
  const tol = Number.isFinite(tolerancePct) && tolerancePct > 0 ? tolerancePct : CROSSCHECK_TOLERANCE_DEFAULT;
  const finding: QualityFinding | null =
    compared > 0 && maxDeviationPct > tol
      ? {
          cls: "CROSSCHECK",
          ts: maxTs,
          detail: `Abweichung ${maxDeviationPct.toFixed(3)} % > Toleranz ${tol} % (Zweitquelle)`,
        }
      : null;
  return { compared, maxDeviationPct, ...(maxTs !== undefined ? { ts: maxTs } : {}), finding };
}
