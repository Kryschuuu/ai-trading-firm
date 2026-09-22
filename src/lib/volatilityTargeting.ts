/**
 * LIVE-Orchestrator des Portfolio-Volatility-Targetings (RMA-P5-01, v1.67.0).
 *
 * Verdrahtet die PURE Kernfunktion (`src/portfolio/volatilityTargeting.ts`)
 * an Live-Daten und die Risikosandbox:
 *
 *   offene Positionen (DB) → Zielgewichte (Notional-Anteile)
 *   Kerzen je gehaltenem Symbol (Timeframe, nur GESCHLOSSEN)
 *     → Log-Returns + Event-Zeiten
 *     → computeVolatilityTargetingFromInput (pure, geteilt mit Backtest)
 *     → Multiplikator ∈ (0, 1]
 *     → Persistenz: `volatility_targeting_snapshots` (append-only, idempotent)
 *       + `risk_config` (`vtp.activeFactor`/`vtp.activeAt` für den
 *       Mikro-Executor, wie `adp.activeFactor`)
 *     → Anwendung: `applyVolatilityTargeting` (nur im Modus `active`)
 *     → Audit-Event `RISK_VOL_TARGETING` + bounded Metriken
 *
 * ── Betriebsmodi (Feature-Flag `PORTFOLIO_VOL_TARGETING_MODE`) ─────────────
 *   - `monitor` (Default): Forecast + Persistenz + Reporting, aber KEINE
 *     Ordergrößenänderung. Der Rollout-Startzustand.
 *   - `active`: Multiplikator wird in die Risk-Guard-Kaskade komponiert
 *     (regime-Faktor × voltarget-Faktor, beide ≤ 1).
 *   - `off`: System inaktiv, bereits gesetzter Faktor wird zurückgenommen.
 *
 * Zusätzlich `vtp.enabled` in `risk_config` (Master-Schalter, Default 1).
 *
 * ── Zeitsemantik / Look-ahead ───────────────────────────────────────────────
 * Nur GESCHLOSSENE Kerzen: eine Kerze ist geschlossen, wenn
 * `time + timeframeMs ≤ computedAt`. Der Return `r_t` zwischen Kerze t−1 und
 * t hat die Event-Zeit `time_t + timeframeMs` (Verfügbarkeitszeit). Der
 * Kern prüft `computedAt − min(jüngste EventTime) ≤ maxStaleness` —
 * unvollständige oder zu alte Kerzen führen zu STALE_DATA (fail-closed).
 *
 * ── Idempotenz ──────────────────────────────────────────────────────────────
 * Snapshot-Identität `vt1:<sha256>(Minute(computedAt)|configHash|dataHash)`;
 * `ON CONFLICT DO NOTHING` auf dem UNIQUE-Index `snapshot_id`. Retries/
 * Restarts in derselben Minute mit identischer Eingabe ⇒ keine doppelte
 * Zeile. Der persistierte Faktor ist die Projektion des letzten ANGEWENDETEN
 * Multiplikators (dedupliziert über `adp`-analoge Keys).
 *
 * ── Grenzen ─────────────────────────────────────────────────────────────────
 * Der Faktor multipliziert NUR das konfigurierte Basis-Risikobudget
 * (`maxRiskPerTrade`) und ist hart ≤ 1. Risk-Ceilings, Kill-Switches,
 * Authority Chains und Live-Gates bleiben unverändert — das VolTargeting
 * wirkt innerhalb der bestehenden Sandbox, nie darüber.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { positions, riskConfig, volatilityTargetingSnapshots } from "@/db/schema";
import { getRegistry } from "@/universe";
import {
  buildVolatilityTargetingIdempotencyKey,
  computeRealizedPortfolioVolatility,
  computeTargetError,
  computeVolatilityTargetingFromInput,
  DEFAULT_VOLATILITY_TARGETING_CONFIG,
  hashVolatilityTargetingConfig,
  hashVolatilityTargetingData,
  resolveVolatilityTargetingConfig,
  VOLATILITY_TARGETING_BOUNDS,
  VOLATILITY_TARGETING_MODES,
  type VolatilityForecastInput,
  type VolatilityForecastSeries,
  type VolatilityTargetingConfig,
  type VolatilityTargetingMode,
  type VolatilityTargetingResult,
} from "@/portfolio/volatilityTargeting";
import type { Candle } from "./marketData";
import { getCandles } from "./marketData";
import { auditWrite } from "./auditSink";
import { structuredLog } from "./logger";
import { applyVolatilityTargeting } from "./riskGuard";
import { telemetry } from "./telemetry";

// ─────────────────────────────────────────────────────────────────────────────
// Feature-Flag & Timeframe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Feature-Flag des Betriebsmodus.
 *
 * `PORTFOLIO_VOL_TARGETING_MODE` ∈ `off` | `monitor` | `active`.
 * Default (und bei unbekannten Werten): `monitor` — risikoneutraler
 * Rollout-Start. Nur exakt `active` wendet den Faktor an; `off`
 * nimmt einen gesetzten Faktor zurück (Rollback-Pfad).
 */
export function resolveVolTargetingMode(env: NodeJS.ProcessEnv = process.env): VolatilityTargetingMode {
  const raw = (env.PORTFOLIO_VOL_TARGETING_MODE ?? "").trim().toLowerCase();
  return (VOLATILITY_TARGETING_MODES as readonly string[]).includes(raw) ? (raw as VolatilityTargetingMode) : "monitor";
}

/** Erlaubte Timeframes für den Forecast (subset der Store-Timeframes). */
export const VOLATILITY_TARGETING_TIMEFRAMES: readonly string[] = ["5m", "15m", "30m", "1h", "4h", "1d"];

/** Default-Timeframe (1h: genug Auflösung, genug Historie, geringe Latenz). */
export const VOLATILITY_TARGETING_DEFAULT_TIMEFRAME = "1h";

/** Timeframe → Millisekunden (nur für die geschlossene- Kerzen-Prüfung). */
const TIMEFRAME_MS: Record<string, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/**
 * Löst die Forecast-Timeframe aus der Env-Variable auf.
 * Unbekannte Werte fallen auf den Default (kein Stillversagen).
 */
export function resolveVolTargetingTimeframe(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.PORTFOLIO_VOL_TARGETING_TIMEFRAME ?? "").trim().toLowerCase();
  return (VOLATILITY_TARGETING_TIMEFRAMES as readonly string[]).includes(raw)
    ? raw
    : VOLATILITY_TARGETING_DEFAULT_TIMEFRAME;
}

/**
 * Annualisierungsfaktor (Perioden pro Jahr) je Asset-Klasse und Timeframe.
 *
 * Krypto handelt 365 Tage, Aktien/ETFs/Indizes/Commodities/FX an ~252
 * Börsentagen (gleiche Konvention wie `src/portfolio/config.ts`).
 * Unbekannte Klassen → 252 (konservativer Default, dokumentiert).
 *
 * Beispiel: 1h-Kerzen ⇒ 24 Perioden/Tag ⇒ Krypto 8760, Aktien 6048.
 */
export function annualizationForTimeframe(
  timeframe: string,
  assetClass: string | null | undefined
): number {
  const tfMs = TIMEFRAME_MS[timeframe] ?? TIMEFRAME_MS[VOLATILITY_TARGETING_DEFAULT_TIMEFRAME];
  const barsPerDay = 86_400_000 / tfMs;
  const tradingDays = assetClass === "crypto" ? 365 : 252;
  return barsPerDay * tradingDays;
}

// ─────────────────────────────────────────────────────────────────────────────
// Konfiguration (risk_config `vtp.*`, geklemmt)
// ─────────────────────────────────────────────────────────────────────────────

/** DB-Key ↔ Config-Feld (risk_config.value ist NUMERIC). */
const VTP_DB_KEY_BY_FIELD: Record<string, keyof VolatilityTargetingConfig> = {
  "vtp.enabled": "enabled",
  "vtp.targetAnnualizedVolPct": "targetAnnualizedVolPct",
  "vtp.lookbackPeriods": "lookbackPeriods",
  "vtp.minObservations": "minObservations",
  "vtp.minMultiplier": "minMultiplier",
  "vtp.maxMultiplier": "maxMultiplier",
  "vtp.maxStep": "maxStep",
  "vtp.smoothingAlpha": "smoothingAlpha",
  "vtp.maxStalenessMinutes": "maxStalenessMs", // Sonderfall: Minuten → ms
  "vtp.minCoverage": "minCoverage",
  "vtp.shrinkage": "shrinkage",
};

/** Metadaten für Dashboard/Doku (analog `VOLATILITY_KEYS` in adaptiveRisk). */
export const VTP_CONFIG_KEYS: {
  key: string;
  field: keyof VolatilityTargetingConfig;
  label: string;
  unit: "%" | "x" | "count" | "min" | "bool";
  description: string;
}[] = [
  { key: "vtp.enabled", field: "enabled", label: "Volatility Targeting", unit: "bool", description: "Master-Schalter (0/1). Der Modus kommt aus PORTFOLIO_VOL_TARGETING_MODE." },
  { key: "vtp.targetAnnualizedVolPct", field: "targetAnnualizedVolPct", label: "Volatilitätsziel (p. a., %)", unit: "%", description: "Annualisiertes Portfolio-Volatilitätsziel. Standard 30 (30 % p. a.)." },
  { key: "vtp.lookbackPeriods", field: "lookbackPeriods", label: "Lookback (Perioden)", unit: "count", description: "Anzahl Log-Renditen im Fenster. Standard 168 (7 Tage × 1h)." },
  { key: "vtp.minObservations", field: "minObservations", label: "Min. Beobachtungen", unit: "count", description: "Mindest-T für einen Forecast (Wärmeauflauf). Standard 60." },
  { key: "vtp.minMultiplier", field: "minMultiplier", label: "Multiplikator min", unit: "x", description: "Untergrenze des Faktors. Standard 0.25." },
  { key: "vtp.maxMultiplier", field: "maxMultiplier", label: "Multiplikator max", unit: "x", description: "Obergrenze des Faktors (hart ≤ 1). Standard 1.0." },
  { key: "vtp.maxStep", field: "maxStep", label: "Max. Schritt/Update", unit: "x", description: "Max. |ΔFaktor| pro Update im OK-Pfad. Standard 0.25." },
  { key: "vtp.smoothingAlpha", field: "smoothingAlpha", label: "Smoothing-Alpha", unit: "x", description: "EMA-Glättung (1 = keine). Standard 0.5." },
  { key: "vtp.maxStalenessMinutes", field: "maxStalenessMs", label: "Max. Staleness (min)", unit: "min", description: "Max. Alter des jüngsten Datenpunkts. Standard 120." },
  { key: "vtp.minCoverage", field: "minCoverage", label: "Min. Datenabdeckung", unit: "x", description: "Min. gewichtete Abdeckung (0–1). Standard 0.5." },
  { key: "vtp.shrinkage", field: "shrinkage", label: "Kovarianz-Shrinkage κ", unit: "x", description: "Konstante Shrinkage auf mittlere Varianz (0–0.9). Standard 0.1." },
];

/**
 * Lädt die `vtp.*`-Konfiguration aus risk_config und löst sie geklemmt auf.
 * DB-Fehler → bestehende/Default-Konfiguration bleibt (Fail-Safe, wie `adp.*`).
 */
async function loadVtpConfig(current: VolatilityTargetingConfig): Promise<VolatilityTargetingConfig> {
  try {
    const rows = await db.select().from(riskConfig);
    const raw: Partial<Record<keyof VolatilityTargetingConfig, number | boolean>> = {};
    for (const r of rows) {
      const field = VTP_DB_KEY_BY_FIELD[r.key];
      if (!field) continue;
      const n = Number(r.value);
      if (!Number.isFinite(n)) continue;
      if (field === "enabled") raw.enabled = n >= 0.5;
      else if (field === "maxStalenessMs") raw.maxStalenessMs = n * 60_000; // Minuten → ms
      else (raw[field] as number) = n;
    }
    return resolveVolatilityTargetingConfig(raw, current);
  } catch {
    return current;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Datenprovider (injizierbar für Tests)
// ─────────────────────────────────────────────────────────────────────────────

/** Eine offene Position (aus `positions`, status = OPEN). */
export interface OpenPositionRow {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  currentPrice: number | null;
}

/** Standard-Positionprovider: DB-Read der offenen Positionen. */
async function fetchOpenPositions(): Promise<OpenPositionRow[]> {
  const rows = await db
    .select({
      symbol: positions.symbol,
      side: positions.side,
      qty: positions.qty,
      entryPrice: positions.entryPrice,
      currentPrice: positions.currentPrice,
    })
    .from(positions)
    .where(eq(positions.status, "OPEN"));
  return rows.map((r) => ({
    symbol: r.symbol,
    side: r.side as "LONG" | "SHORT",
    qty: Number(r.qty),
    entryPrice: Number(r.entryPrice),
    currentPrice: r.currentPrice === null ? null : Number(r.currentPrice),
  }));
}

/**
 * Minimales DB-Interface des Persistenzpfads (strukturell erfüllt vom
 * echten Drizzle-Client; Test-Fakes brauchen nur diese Methode-Ketten).
 */
export interface VtpDbLike {
  select(): { from(_t: unknown): Promise<Record<string, unknown>[]> };
  insert(_t: unknown): {
    values(v: Record<string, unknown>): {
      onConflictDoNothing(o?: unknown): { returning(f?: unknown): Promise<Record<string, unknown>[]> };
      onConflictDoUpdate(o?: unknown): Promise<unknown>;
    };
  };
}

export interface VolatilityTargetingDeps {
  /** Position-Lese (Default: DB). */
  fetchPositions?: () => Promise<OpenPositionRow[]>;
  /** Kerzen-Lese (Default: getCandles). */
  fetchCandles?: (symbol: string, timeframe: string, limit: number) => Promise<Candle[]>;
  /** Datenbank-Instanz für Persistenz (Default: @/db). */
  db?: VtpDbLike;
  /** Uhr (Default: Date.now) — für Tests. */
  now?: () => number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Laufzeit-Zustand (globalThis: überlebt Next.js-HMR wie der Rest der Firma)
// ─────────────────────────────────────────────────────────────────────────────

/** Mindest-Abstand zwischen zwei Neubewertungen (Volatilität ändert sich langsam). */
export const VTP_UPDATE_MIN_INTERVAL_MS = 5 * 60_000;

type VtpState = {
  config: VolatilityTargetingConfig;
  configLoadedAt: number;
  lastResult: VolatilityTargetingResult | null;
  lastApplied: number | null;
  lastUpdateAt: number | null;
  lastError: string | null;
  updating: Promise<VolatilityTargetingStatus> | null;
  /** Realisierte Volatilität + Target-Error des letzten Laufs. */
  lastRealized: number | null;
  lastTargetError: number | null;
};

const G = globalThis as typeof globalThis & { __volatilityTargeting?: VtpState };

function state(): VtpState {
  G.__volatilityTargeting ??= {
    config: { ...DEFAULT_VOLATILITY_TARGETING_CONFIG },
    configLoadedAt: 0,
    lastResult: null,
    lastApplied: null,
    lastUpdateAt: null,
    lastError: null,
    updating: null,
    lastRealized: null,
    lastTargetError: null,
  };
  return G.__volatilityTargeting;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

export interface VolatilityTargetingStatus {
  /** Effektiv wirksamer Modus (Env × vtp.enabled). */
  mode: VolatilityTargetingMode;
  /** true wenn Mode = active (Faktor wirkt auf das Risikobudget). */
  active: boolean;
  /** Zeitframe des Forecasts. */
  timeframe: string;
  /** Konfiguriertes Ziel (dezimal, annualisiert). */
  targetAnnualizedVol: number;
  /** Letzter Forecast (null = noch kein Lauf). */
  forecast: VolatilityTargetingResult["forecast"] | null;
  /** Letzter roher Multiplikator (null bei Fallback/fehlendem Lauf). */
  rawMultiplier: number | null;
  /** Letzter angewendeter Multiplikator (1 = neutral). */
  appliedMultiplier: number;
  /** Vorheriger Multiplikator. */
  prevMultiplier: number | null;
  /** Realisierte Volatilität (null = nicht berechenbar). */
  realizedAnnualizedVol: number | null;
  /** Target Error = realisiert − Ziel (null = nicht berechenbar). */
  targetError: number | null;
  /** Letzter Lauf (ISO) oder null. */
  lastUpdate: string | null;
  /** Letzter Fehler (null = letzter Lauf OK). */
  lastError: string | null;
  /** true wenn die letzte Bewertung > 10 min zurückliegt. */
  stale: boolean;
  /** Aktive Konfiguration (geklemmt). */
  config: VolatilityTargetingConfig;
  /** Erlaubtes Fenster (Dashboard/Validierung). */
  bounds: typeof VOLATILITY_TARGETING_BOUNDS;
}

/**
 * Synchroner Status-Snapshot für Agenten/Monitoring/API.
 * Liefert `null` wenn noch nie eine Bewertung stattfand.
 */
export function getVolatilityTargetingStatus(): VolatilityTargetingStatus | null {
  const s = state();
  if (s.lastUpdateAt == null && s.lastResult == null) return null;
  const mode = resolveVolTargetingMode();
  const enabled = s.config.enabled;
  const effectiveMode: VolatilityTargetingMode = !enabled ? "off" : mode;
  return {
    mode: effectiveMode,
    active: effectiveMode === "active",
    timeframe: resolveVolTargetingTimeframe(),
    targetAnnualizedVol: s.config.targetAnnualizedVolPct / 100,
    forecast: s.lastResult?.forecast ?? null,
    rawMultiplier: s.lastResult?.rawMultiplier ?? null,
    appliedMultiplier: s.lastApplied ?? 1,
    prevMultiplier: s.lastResult?.prevMultiplier ?? null,
    realizedAnnualizedVol: s.lastRealized,
    targetError: s.lastTargetError,
    lastUpdate: s.lastUpdateAt ? new Date(s.lastUpdateAt).toISOString() : null,
    lastError: s.lastError,
    stale: s.lastUpdateAt == null || Date.now() - s.lastUpdateAt > 10 * 60_000,
    config: { ...s.config },
    bounds: { ...VOLATILITY_TARGETING_BOUNDS },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistenz
// ─────────────────────────────────────────────────────────────────────────────

export interface PersistedVtpSnapshotInput {
  mode: VolatilityTargetingMode;
  result: VolatilityTargetingResult;
  asOf: number;
  computedAt: number;
  config: VolatilityTargetingConfig;
  realizedAnnualizedVol: number | null;
  targetError: number | null;
  input: VolatilityForecastInput;
}

/**
 * Persistiert einen Snapshot (idempotent über `snapshot_id`).
 *
 * `db.insert(...).onConflictDoNothing().returning(...)` — Retry/Restart mit
 * gleichem Key ⇒ dieselbe Zeile, keine doppelte Buchung. Liefert `true` wenn
 * eine neue Zeile geschrieben wurde, `false` wenn sie bereits existierte.
 */
async function persistSnapshot(
  deps: VolatilityTargetingDeps,
  input: PersistedVtpSnapshotInput
): Promise<boolean> {
  const dbRef: VtpDbLike = deps.db ?? (db as unknown as VtpDbLike);
  const configHash = hashVolatilityTargetingConfig(input.config);
  const dataHash = hashVolatilityTargetingData({
    series: input.input.series,
    asOf: input.asOf,
    computedAt: input.computedAt,
  });
  const snapshotId = buildVolatilityTargetingIdempotencyKey(input.computedAt, configHash, dataHash);

  const row = {
    snapshotId,
    mode: input.mode,
    monitorOnly: input.mode === "monitor",
    status: input.result.forecast.status,
    reasonCode: input.result.forecast.reasonCode,
    reason: input.result.forecast.reason,
    asOf: new Date(input.asOf),
    computedAt: new Date(input.computedAt),
    eventTime: input.result.forecast.eventTime !== null ? new Date(input.result.forecast.eventTime) : null,
    targetAnnualizedVol: String(input.result.targetAnnualizedVol),
    forecastAnnualizedVol:
      input.result.forecast.forecastAnnualizedVol !== null
        ? String(input.result.forecast.forecastAnnualizedVol)
        : null,
    realizedAnnualizedVol:
      input.realizedAnnualizedVol !== null ? String(input.realizedAnnualizedVol) : null,
    targetError: input.targetError !== null ? String(input.targetError) : null,
    rawMultiplier: input.result.rawMultiplier !== null ? String(input.result.rawMultiplier) : null,
    prevMultiplier: String(input.result.prevMultiplier ?? 1),
    appliedMultiplier: String(input.result.appliedMultiplier),
    coverage: String(input.result.forecast.coverage),
    observations: input.result.forecast.observations,
    annualization: String(input.result.forecast.annualization),
    shrinkage: String(input.result.forecast.shrinkage),
    regularization: input.result.forecast.regularization,
    weights: input.result.forecast.normalizedWeights,
    configHash,
    dataHash,
  };

  const inserted = await dbRef
    .insert(volatilityTargetingSnapshots)
    .values(row)
    .onConflictDoNothing({ target: volatilityTargetingSnapshots.snapshotId })
    .returning({ id: volatilityTargetingSnapshots.id });

  return inserted.length > 0;
}

/**
 * Persistiert den aktiven Faktor + Zeitstempel in risk_config, damit der
 * SEPARATE Mikro-Executor-Prozess die Reduktion ohne eigenen Marktzugriff
 * übernehmen kann (analog `adp.activeFactor`/`adp.activeAt`).
 */
async function persistActiveFactor(
  deps: VolatilityTargetingDeps,
  factor: number,
  atMs: number
): Promise<void> {
  const dbRef: VtpDbLike = deps.db ?? (db as unknown as VtpDbLike);
  const atSec = Math.floor(atMs / 1000);
  for (const [key, value, description] of [
    ["vtp.activeFactor", factor, "Aktiver Volatility-Targeting-Faktor (vom Monitor geschrieben)"],
    ["vtp.activeAt", atSec, "Epoch-Sekunden der letzten Volatility-Targeting-Bewertung"],
  ] as const) {
    await dbRef
      .insert(riskConfig)
      .values({ key, value: String(value), description })
      .onConflictDoUpdate({
        target: riskConfig.key,
        set: { value: String(value), updatedAt: new Date() },
      });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Kern-Datenfluss: Positionen → Gewichte, Kerzen → Returns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Baut aus offenen Positionen die Zielgewichte (Notional-Anteile, Long-only
 * Total-Exposure) und liefert sie plus die zugehörigen Symbole.
 *
 * `notional = |qty| × (currentPrice ?? entryPrice)`. Kurz-Positionen zählen
 * per Absolutbetrag in die Gesamt-Exposure (konservativ: ein Short ist
 * genauso viel Risiko wie ein Long gleicher Größe).
 */
function weightsFromPositions(rows: readonly OpenPositionRow[]): {
  symbols: string[];
  weights: Record<string, number>;
} {
  const notional: Record<string, number> = {};
  for (const r of rows) {
    const price = r.currentPrice !== null && Number.isFinite(r.currentPrice) && r.currentPrice > 0 ? r.currentPrice : r.entryPrice;
    const n = Math.abs(Number(r.qty)) * price;
    if (!Number.isFinite(n) || n <= 0) continue;
    notional[r.symbol] = (notional[r.symbol] ?? 0) + n;
  }
  const total = Object.values(notional).reduce((a, b) => a + b, 0);
  if (total <= 0) return { symbols: [], weights: {} };
  const weights: Record<string, number> = {};
  const symbols = Object.keys(notional).sort();
  for (const s of symbols) weights[s] = notional[s] / total;
  return { symbols, weights };
}

/**
 * Lädt Kerzen für ein Symbol, filtert auf GESCHLOSSENE (time + tfMs ≤ now)
 * und liefert die letzten `maxCandles` als `{ closes, eventTimes }`.
 *
 * `eventTimes[t]` = Schließzeit der Kerze t = `candles[t].time + tfMs` —
 * der Moment, ab dem der Close bekannt war (Verfügbarkeitszeit).
 */
async function loadClosedCandles(
  deps: VolatilityTargetingDeps,
  symbol: string,
  timeframe: string,
  maxCandles: number,
  nowMs: number
): Promise<{ closes: number[]; eventTimes: number[] } | null> {
  const fetchCandlesFn = deps.fetchCandles ?? getCandles;
  const tfMs = TIMEFRAME_MS[timeframe] ?? TIMEFRAME_MS[VOLATILITY_TARGETING_DEFAULT_TIMEFRAME];
  try {
    const candles = await fetchCandlesFn(symbol, timeframe, maxCandles + 1);
    if (!Array.isArray(candles) || candles.length === 0) return null;
    // Nur geschlossene Kerzen: close-Zeit ≤ now.
    const closed = candles.filter((c) => c.time + tfMs <= nowMs && Number.isFinite(c.close) && c.close > 0);
    const tail = closed.slice(-maxCandles);
    if (tail.length < 2) return null;
    const closes = tail.map((c) => c.close);
    const eventTimes = tail.map((c) => c.time + tfMs);
    return { closes, eventTimes };
  } catch {
    return null;
  }
}

/**
 * Baut aus den Kerzen aller gehaltenen Symbole die ausgerichtete
 * Return-Matrix (index-aligned vom jüngsten Zeitpunkt) und liefert sie als
 * {@link VolatilityForecastSeries[]]. Symbole ohne ausreichend Daten werden
 * verworfen (Coverage im Kern).
 */
async function buildForecastSeries(
  deps: VolatilityTargetingDeps,
  symbols: string[],
  weights: Record<string, number>,
  timeframe: string,
  lookbackPeriods: number,
  nowMs: number
): Promise<VolatilityForecastSeries[]> {
  if (symbols.length === 0) return [];
  // Wir brauchen lookbackPeriods+1 Kerzen für lookbackPeriods Returns.
  const maxCandles = lookbackPeriods + 1;
  const perSymbol = await Promise.all(
    symbols.map(async (sym) => {
      const candles = await loadClosedCandles(deps, sym, timeframe, maxCandles, nowMs);
      if (!candles) return null;
      // Log-Returns aus konsekutiven Closes.
      const returns: number[] = [];
      const evTimes: number[] = [];
      for (let i = 1; i < candles.closes.length; i++) {
        const prev = candles.closes[i - 1];
        const cur = candles.closes[i];
        if (prev <= 0 || cur <= 0) continue;
        returns.push(Math.log(cur / prev));
        evTimes.push(candles.eventTimes[i]);
      }
      if (returns.length === 0) return null;
      return { symbol: sym, returns, eventTimes: evTimes, annualization: annualizationForTimeframe(timeframe, assetClassOf(sym)) };
    })
  );

  // Gemeinsame Länge T = min über alle verfügbaren Serien (index-aligned vom Ende).
  const available = perSymbol.filter((s): s is NonNullable<typeof s> => s !== null);
  if (available.length === 0) return [];
  const commonLength = Math.min(...available.map((s) => s.returns.length));
  if (commonLength < 2) return [];

  return available.map((s) => {
    const returns = s.returns.slice(-commonLength);
    const eventTimes = s.eventTimes.slice(-commonLength);
    return {
      symbol: s.symbol,
      weight: weights[s.symbol] ?? 0,
      annualization: s.annualization,
      logReturns: returns,
      eventTimes,
    };
  });
}

/**
 * Liefert die Asset-Klasse eines Symbols aus der Universe-Registry.
 * Fallback: `null` (→ 252 Tage/Year, konservativer Default).
 */
function assetClassOf(symbol: string): string | null {
  try {
    const inst = getRegistry().get(symbol);
    return inst ? inst.assetClass : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Haupt-API
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateVtpOptions {
  /** Umgeht das Min-Interval (z. B. nach Konfigurationsänderung, API-POST). */
  force?: boolean;
  /** Min. Abstand zwischen zwei Neubewertungen (Default VTP_UPDATE_MIN_INTERVAL_MS). */
  minIntervalMs?: number;
  /** Injizierbare Dependencies (Tests). */
  deps?: VolatilityTargetingDeps;
  /** Volle Konfiguration statt DB-Lade (Tests/Overrides). */
  config?: VolatilityTargetingConfig;
}

/**
 * Führt einen vollständigen Volatility-Targeting-Bewertungsdurchlauf aus:
 * Konfiguration → Positionen → Kerzen → Forecast + Multiplikator (pure) →
 * Persistenz → Anwendung (nur `active`) → Audit + Metriken.
 *
 * Single-Flight (kein paralleles Re-Entry) + Min-Interval. Fehler machen den
 * Durchlauf NIE abbrechen — sie werden lokal gefangen, im Status gemeldet und
 * als fail-closed Fallback behandelt (kein risikosteigerndes Verhalten).
 */
export async function updateVolatilityTargeting(opts: UpdateVtpOptions = {}): Promise<VolatilityTargetingStatus> {
  const s = state();

  if (s.updating && !opts.force) return s.updating;
  if (
    !opts.force &&
    s.lastUpdateAt != null &&
    Date.now() - s.lastUpdateAt < (opts.minIntervalMs ?? VTP_UPDATE_MIN_INTERVAL_MS)
  ) {
    return buildStatus(s);
  }

  const deps = opts.deps ?? {};
  const nowFn = deps.now ?? Date.now;

  const run = (async (): Promise<VolatilityTargetingStatus> => {
    const mode = resolveVolTargetingMode();
    const timeframe = resolveVolTargetingTimeframe();
    const enabled = s.config.enabled;
    const effectiveMode: VolatilityTargetingMode = !enabled ? "off" : mode;

    // 1) Konfiguration laden (außer explizit übergeben).
    if (opts.config) {
      s.config = resolveVolatilityTargetingConfig(opts.config, s.config);
      s.configLoadedAt = nowFn();
    } else if (nowFn() - s.configLoadedAt >= 10_000) {
      s.config = await loadVtpConfig(s.config);
      s.configLoadedAt = nowFn();
    }
    const cfg = s.config;

    // 2) Mode = off: System inaktiv, gesetzten Faktor zurücknehmen.
    if (effectiveMode === "off") {
      applyVolatilityTargeting(null);
      s.lastApplied = null;
      s.lastUpdateAt = nowFn();
      telemetry.volatilityTargeting.updates.inc({ result: "disabled", mode: "off" });
      return buildStatus(s);
    }

    // 3) Daten: Positionen → Gewichte, Kerzen → Returns.
    const fetchPositions = deps.fetchPositions ?? fetchOpenPositions;
    let posRows: OpenPositionRow[];
    try {
      posRows = await fetchPositions();
    } catch (e) {
      s.lastError = `Position-Read fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`;
      // Fail-closed: kein risikosteigerndes Verhalten, aber auch kein
      // Fallback-Faktor (Monitor bleibt neutral, Status zeigt den Fehler).
      telemetry.volatilityTargeting.updates.inc({ result: "error", mode: effectiveMode });
      return buildStatus(s);
    }

    const nowMs = nowFn();
    const { symbols, weights } = weightsFromPositions(posRows);

    // Keine offenen Positionen: Portfolio ist Cash, Ziel trivial erfüllt.
    // Faktor = 1 (neutral), kein risikosteigerndes Verhalten, aber auch kein
    // unnötiger Fallback (keine Exposure = kein Risiko zu dämpfen).
    if (symbols.length === 0) {
      const neutral: VolatilityTargetingResult = {
        forecast: {
          status: "NO_EXPOSURE",
          reasonCode: "ZERO_EXPOSURE",
          reason: "keine offenen Positionen — Portfolio ist Cash",
          forecastAnnualizedVol: 0,
          observations: 0,
          annualization: 0,
          coverage: 1,
          usedSymbols: [],
          normalizedWeights: {},
          eventTime: null,
          regularization: "skipped",
          shrinkage: cfg.shrinkage,
          seriesLength: 0,
        },
        targetAnnualizedVol: cfg.targetAnnualizedVolPct / 100,
        rawMultiplier: null,
        clampedMultiplier: cfg.maxMultiplier,
        prevMultiplier: s.lastApplied ?? cfg.maxMultiplier,
        appliedMultiplier: cfg.maxMultiplier,
        outcome: "no_exposure",
      };
      s.lastResult = neutral;
      s.lastApplied = neutral.appliedMultiplier;
      s.lastRealized = null;
      s.lastTargetError = null;
      s.lastUpdateAt = nowMs;
      s.lastError = null;
      telemetry.volatilityTargeting.updates.inc({ result: "no_exposure", mode: effectiveMode });
      // Im active-Modus: neutraler Faktor (1) anwenden — kein Risiko-Change.
      if (effectiveMode === "active") {
        applyVolatilityTargeting({
          factor: 1,
          at: new Date(nowMs).toISOString(),
          asOf: new Date(nowMs).toISOString(),
          reason: "keine Exposure (neutral)",
          mode: "active",
        });
      }
      return buildStatus(s);
    }

    const series = await buildForecastSeries(deps, symbols, weights, timeframe, cfg.lookbackPeriods, nowMs);

    // 4) Pure Forecast + Multiplikator (gemeinsam mit Backtest).
    const prev = s.lastApplied ?? cfg.maxMultiplier;
    const asOf = nowMs;
    const computedAt = nowMs;
    const input: VolatilityForecastInput = {
      series,
      asOf,
      computedAt,
      config: cfg,
    };
    const result = computeVolatilityTargetingFromInput(input, prev);

    // 5) Realisierte Volatilität + Target-Error (Soll-Ist-Monitoring).
    const realized = series.length > 0 ? computeRealizedPortfolioVolatility(series, cfg) : null;
    const targetError = computeTargetError(realized, cfg);

    // 6) Persistenz (Snapshot + Faktor).
    let snapshotWritten = false;
    try {
      snapshotWritten = await persistSnapshot(deps, {
        mode: effectiveMode,
        result,
        asOf,
        computedAt,
        config: cfg,
        realizedAnnualizedVol: realized,
        targetError,
        input,
      });
      telemetry.volatilityTargeting.snapshots.inc({
        result: snapshotWritten ? "written" : "duplicate",
      });
      // Nur im active-Modus: Faktor für den Mikro-Executor persistieren.
      if (effectiveMode === "active") {
        await persistActiveFactor(deps, result.appliedMultiplier, computedAt);
      }
    } catch (e) {
      s.lastError = `Persistenz fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`;
      telemetry.volatilityTargeting.snapshots.inc({ result: "failed" });
      // Persistenz-Fehler bricht den Lauf nicht ab (Fail-Safe).
    }

    // 7) Anwendung (nur im active-Modus).
    if (effectiveMode === "active") {
      applyVolatilityTargeting({
        factor: result.appliedMultiplier,
        at: new Date(computedAt).toISOString(),
        asOf: new Date(asOf).toISOString(),
        reason: result.forecast.reason,
        mode: "active",
      });
    } else {
      // monitor: kein Ordergrößenänderung — gesetzten Faktor zurücknehmen.
      applyVolatilityTargeting(null);
    }

    // 8) Zustand aktualisieren.
    s.lastResult = result;
    s.lastApplied = result.appliedMultiplier;
    s.lastRealized = realized;
    s.lastTargetError = targetError;
    s.lastUpdateAt = nowMs;
    s.lastError = result.forecast.status === "FALLBACK" ? result.forecast.reason : null;

    // 9) Metriken + Audit.
    telemetry.volatilityTargeting.updates.inc({
      result: result.outcome,
      mode: effectiveMode,
    });
    if (result.outcome === "fallback") {
      telemetry.volatilityTargeting.fallbacks.inc({
        reason: result.forecast.reasonCode.toLowerCase(),
      });
    }
    await logVtpEvent(effectiveMode, result, computedAt, realized, targetError);

    return buildStatus(s);
  })();

  s.updating = run;
  try {
    return await run;
  } finally {
    s.updating = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────────────────────

async function logVtpEvent(
  mode: VolatilityTargetingMode,
  result: VolatilityTargetingResult,
  computedAt: number,
  realized: number | null,
  targetError: number | null
): Promise<void> {
  const level = result.outcome === "fallback" ? "WARN" : "INFO";
  const detail = {
    mode,
    status: result.forecast.status,
    reasonCode: result.forecast.reasonCode,
    reason: result.forecast.reason,
    targetAnnualizedVol: result.targetAnnualizedVol,
    forecastAnnualizedVol: result.forecast.forecastAnnualizedVol,
    realizedAnnualizedVol: realized,
    targetError,
    rawMultiplier: result.rawMultiplier,
    prevMultiplier: result.prevMultiplier,
    appliedMultiplier: result.appliedMultiplier,
    coverage: result.forecast.coverage,
    observations: result.forecast.observations,
    usedSymbols: result.forecast.usedSymbols.slice(0, 25),
    computedAt: new Date(computedAt).toISOString(),
  };
  try {
    await auditWrite("RISK_VOL_TARGETING", level, detail, {
      auditClass: result.outcome === "fallback" ? "security" : "telemetry",
    });
  } catch {
    /* Audit-Fehler brechen den Lauf nicht ab (best-effort, gezählt in audit_write_failures_total). */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test-Helfer
// ─────────────────────────────────────────────────────────────────────────────

/** Leert den kompletten Laufzeit-Zustand (nur für Tests). */
export function __resetVolatilityTargetingForTests(): void {
  delete G.__volatilityTargeting;
}

function buildStatus(s: VtpState): VolatilityTargetingStatus {
  const mode = resolveVolTargetingMode();
  const enabled = s.config.enabled;
  const effectiveMode: VolatilityTargetingMode = !enabled ? "off" : mode;
  return {
    mode: effectiveMode,
    active: effectiveMode === "active",
    timeframe: resolveVolTargetingTimeframe(),
    targetAnnualizedVol: s.config.targetAnnualizedVolPct / 100,
    forecast: s.lastResult?.forecast ?? null,
    rawMultiplier: s.lastResult?.rawMultiplier ?? null,
    appliedMultiplier: s.lastApplied ?? 1,
    prevMultiplier: s.lastResult?.prevMultiplier ?? null,
    realizedAnnualizedVol: s.lastRealized,
    targetError: s.lastTargetError,
    lastUpdate: s.lastUpdateAt ? new Date(s.lastUpdateAt).toISOString() : null,
    lastError: s.lastError,
    stale: s.lastUpdateAt == null || Date.now() - s.lastUpdateAt > 10 * 60_000,
    config: { ...s.config },
    bounds: { ...VOLATILITY_TARGETING_BOUNDS },
  };
}
