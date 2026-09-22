/**
 * Kontinuierliches Portfolio-Volatility-Targeting (RMA-P5-01, v1.67.0).
 *
 * Der KERN des Volatility-Targetings ist hier: eine **pure, deterministische**
 * Forecast- und Multiplikatorfunktion, die LIVE (Monitor-Tick, `src/lib/
 * volatilityTargeting.ts`) und BACKTEST (`src/backtest/engine.ts`) TEILEN.
 *
 * ── Ziel ────────────────────────────────────────────────────────────────────
 * Aus as-of-sicheren Returns, Zielgewichten und einer regularisierten
 * Kovarianz wird die annualisierte Portfolio-Volatilität FORECASTED:
 *
 *   σ̂_a = ( wᵀ Σ^A w ),   Σ^A_ij = Σ*_ij · √(A_i·A_j)
 *
 * mit `w` = normalisierte Zielgewichte (Long-only, Σw = 1), `Σ*` =
 * regularisierte Stichprobenkovarianz (pro Periode) und `A_i` =
 * Annualisierungsfaktor (Perioden pro Jahr) je Asset. Bei einheitlichem
 * `A_i = A` reduziert sich das auf `σ̂_a = √A · √(wᵀΣ*w)` — die klassische
 * √A-Skalierung. Die √(A_i·A_j)-Form annualisiert jeden Paarbeitrag mit der
 * Jahreslänge SEINER Asset-Klassen (Krypto 365 d, Aktien 252 d); die
 * Korrelationsstruktur bleibt dabei unverändert (dokumentierte Annahme).
 *
 * Daraus folgt der Risikomultiplikator auf das Risikobudget:
 *
 *   raw      = target / σ̂_a                 (hohe Forecast-Vol ⇒ kleiner)
 *   clamped  = clamp(raw, min, max)          (max ≤ 1: NIEMALS risikosteigernd)
 *   smoothed = α·clamped + (1−α)·prev        (EMA-Glättung, α = smoothingAlpha)
 *   applied  = clamp(smoothed, prev−maxStep, prev+maxStep)
 *
 * Der Multiplikator wirkt NUR innerhalb der bestehenden harten Grenzen:
 * er multipliziert das konfigurierte Basis-Risikobudget (Faktor ≤ 1) und
 * wird in `src/lib/riskGuard.ts` in die Sandbox-Kaskade komponiert
 * (Code-Ceilings → Basis-Limit → Regime-Faktor → VolTarget-Faktor → Boden).
 *
 * ── Fail-closed (verbindlich) ───────────────────────────────────────────────
 * Fehlende, stale oder invalide Daten führen NIEMALS still zu "neutral"
 * (`null`/`unavailable` ist nicht `0`):
 *
 *   - jede Validierungsstörung ⇒ `status: "FALLBACK"`,
 *     `appliedMultiplier = minMultiplier` (konservativ ≤ 1), und der
 *     Fallback wird SOFORT wirksam (bypassed Max-Step und Smoothing — die
 *     sichere Richtung ist sofort, wie bei der Regime-Maschine);
 *   - `forecastAnnualizedVol` ist bei Fallback `null` (nicht 0);
 *   - `eventTimes` sind Pflicht für die Anwendung: ohne verifizierbare
 *     Frische (`computedAt − eventTime ≤ maxStaleness`) ist der Forecast
 *     nicht verwendbar (STALE_DATA) — Look-ahead ist damit strukturell
 *     ausgeschlossen;
 *   - Gewichte sind Long-only Total-Exposure-Anteile (≥ 0, Summe > 0).
 *
 * ── Zeitsemantik ────────────────────────────────────────────────────────────
 *   eventTimes[t]  = Zeitstempel (ms), zu dem Return t verfügbar war
 *                    (Ereignis-/Verfügbarkeitszeit der geschlossenen Kerze).
 *                    Nur Kerzen mit `eventTime ≤ asOf` gehören in den Input.
 *   asOf           = Entscheidungszeitpunkt (ms) des Aufrufer-Kontexts.
 *   computedAt     = Berechnungszeit (ms), im Live-Pfad ≈ `now`.
 *
 * Der Live-Orchestrator und die Backtest-Engine übergeben immer geschlossene
 * Kerzen; die Backtest-Engine nutzt ihre etablierte Verfügbarkeitskonvention
 * (Kerze mit `time ≤ currentTime` ist bei `currentTime` verfügbar).
 *
 * ── Reine Logik ─────────────────────────────────────────────────────────────
 * Keine Uhr, kein Zufall, kein I/O, keine Seiteneffekte — die Funktion ist
 * vollständig unit-testbar und deterministisch (gleiche Eingabe ⇒
 * bit-identisches Ergebnis).
 */

import { createHash } from "node:crypto";

import { OUTPUT_DECIMALS, validateAnnualization } from "./config";
import { requireFinite } from "./errors";
import { cholesky, isSymmetric, regularizeCovariance, type Matrix } from "./numeric";

// ─────────────────────────────────────────────────────────────────────────────
// Konfiguration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Betriebsmodus des Volatility-Targetings:
 *   - `off`     — aus (kein Forecast, keine Persistenz, kein Faktor).
 *   - `monitor` — Forecast + Persistenz + Reporting, aber KEINE
 *                 Ordergrößenänderung (Rollout-Phase, Default).
 *   - `active`  — Multiplikator wird auf das Risikobudget angewendet.
 */
export type VolatilityTargetingMode = "off" | "monitor" | "active";

export const VOLATILITY_TARGETING_MODES: readonly VolatilityTargetingMode[] = ["off", "monitor", "active"];

/** Rohe (ungvalidierte) Konfiguration — z. B. aus `risk_config` (`vtp.*`). */
export interface VolatilityTargetingConfig {
  /** Master-Schalter (Default true). */
  enabled: boolean;
  /** Betriebsmodus (Default "monitor"). */
  mode: VolatilityTargetingMode;
  /**
   * Annualisiertes Volatilitätsziel in PROZENT (30 = 30 % p. a.).
   * Der Multiplikator steuert das Risikobudget darauf zu.
   */
  targetAnnualizedVolPct: number;
  /** Anzahl Log-Renditen (Kerzen − 1) im Lookback-Fenster. */
  lookbackPeriods: number;
  /**
   * Minimum Beobachtungen, bevor ein Forecast überhaupt berechnet wird
   * (Wärmeauflauf-Schutz; separate Schranke zu `lookbackPeriods`).
   */
  minObservations: number;
  /** Untergrenze des Multiplikators (Default 0.25). */
  minMultiplier: number;
  /** Obergrenze des Multiplikators (Default 1.0, HART ≤ 1). */
  maxMultiplier: number;
  /** Max. |ΔMultiplikator| pro Update im OK-Pfad (Turnover-Limit). */
  maxStep: number;
  /** EMA-Glättung: 1 = keine Glättung, kleiner = träger. */
  smoothingAlpha: number;
  /** Maximales Alter des jüngsten Datenpunkts (ms), sonst STALE_DATA. */
  maxStalenessMs: number;
  /** Minimale gewichtete Datenabdeckung (Anteil messbarer Exposure). */
  minCoverage: number;
  /**
   * Konstante Shrinkage auf die mittlere Varianz:
   * `Σ* = (1−κ)·Σ + κ·μ·I`, `μ = tr(Σ)/n`. 0 = keine Shrinkage.
   */
  shrinkage: number;
}

/** Werkwerte (Default = Monitor-only-Rollout, risikoneutral). */
export const DEFAULT_VOLATILITY_TARGETING_CONFIG: VolatilityTargetingConfig = {
  enabled: true,
  mode: "monitor",
  targetAnnualizedVolPct: 30,
  lookbackPeriods: 168,
  minObservations: 60,
  minMultiplier: 0.25,
  maxMultiplier: 1.0,
  maxStep: 0.25,
  smoothingAlpha: 0.5,
  maxStalenessMs: 120 * 60_000,
  minCoverage: 0.5,
  shrinkage: 0.1,
};

/** Erlaubtes Fenster pro Feld — alle Quellen werden hiergegen geklemmt. */
export const VOLATILITY_TARGETING_BOUNDS: Record<keyof VolatilityTargetingConfig, [min: number, max: number]> = {
  enabled: [0, 1],
  mode: [0, 0], // Modus wird separat validiert (kein numerisches Fenster)
  targetAnnualizedVolPct: [1, 300],
  lookbackPeriods: [42, 1008],
  minObservations: [2, 500],
  minMultiplier: [0.05, 1],
  maxMultiplier: [0.05, 1],
  maxStep: [0.01, 1],
  smoothingAlpha: [0.05, 1],
  maxStalenessMs: [5 * 60_000, 24 * 3600_000],
  minCoverage: [0.1, 1],
  shrinkage: [0, 0.9],
};

/**
 * Rohe (ungeprüfte) Konfigurationsquelle — z. B. `risk_config` (NUMERIC),
 * Env-Var oder Test-Input. Alle Werte dürfen `number | boolean | string`
 * sein; die Resolver-Typen der Felder werden hier bewusst nicht erzwungen,
 * weil die DB nur NUMERIC trägt und Boolesche/Modi als 0/1 bzw. String
 * ankommen.
 */
export type VolatilityTargetingConfigInput = Partial<
  Record<keyof VolatilityTargetingConfig, number | boolean | string>
>;

/**
 * Löst eine Partial-Konfiguration in die voll validierte Form auf.
 *
 * Klemm-Regeln (Fail-safe, keine Ausnahmen):
 *   - numerische Werte: `clamp(v, min, max)` gegen {@link VOLATILITY_TARGETING_BOUNDS};
 *   - `maxMultiplier` zusätzlich HART auf `≤ 1` (der Faktor darf das Basis-
 *     Risikobudget niemals überschreiten — auch nicht durch Konfiguration);
 *   - `minMultiplier > maxMultiplier` ⇒ `minMultiplier = maxMultiplier`
 *     (ein leeres Fenster ist Misskonfiguration, kein Fehlbetrieb);
 *   - `minObservations > lookbackPeriods` ⇒ `minObservations = lookbackPeriods`.
 *
 * Ungültige Werte behalten den Basiswert (gleiche Konvention wie
 * `clampVolatilityConfig` in `src/lib/adaptiveRisk.ts`).
 */
export function resolveVolatilityTargetingConfig(
  raw: VolatilityTargetingConfigInput = {},
  base: VolatilityTargetingConfig = DEFAULT_VOLATILITY_TARGETING_CONFIG
): VolatilityTargetingConfig {
  const next: VolatilityTargetingConfig = { ...base };

  const num = (field: keyof VolatilityTargetingConfig): number | undefined => {
    const v = raw[field];
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  if (raw.enabled !== undefined) {
    next.enabled = raw.enabled === true || Number(raw.enabled) >= 0.5;
  }
  if (raw.mode !== undefined) {
    const m = String(raw.mode).trim().toLowerCase();
    if ((VOLATILITY_TARGETING_MODES as readonly string[]).includes(m)) {
      next.mode = m as VolatilityTargetingMode;
    }
  }

  for (const field of [
    "targetAnnualizedVolPct",
    "lookbackPeriods",
    "minObservations",
    "minMultiplier",
    "maxMultiplier",
    "maxStep",
    "smoothingAlpha",
    "maxStalenessMs",
    "minCoverage",
    "shrinkage",
  ] as const) {
    const v = num(field);
    if (v === undefined) continue;
    const [min, max] = VOLATILITY_TARGETING_BOUNDS[field];
    (next[field] as number) = Math.min(Math.max(v, min), max);
  }

  // Ganzzahlfelder deterministisch runden.
  next.lookbackPeriods = Math.round(next.lookbackPeriods);
  next.minObservations = Math.round(next.minObservations);
  next.maxStalenessMs = Math.round(next.maxStalenessMs);

  // Harte Risiko-Invariante: maxMultiplier ≤ 1 (auch wenn Bounds es erlauben).
  next.maxMultiplier = Math.min(next.maxMultiplier, 1);
  if (next.minMultiplier > next.maxMultiplier) next.minMultiplier = next.maxMultiplier;
  if (next.minObservations > next.lookbackPeriods) next.minObservations = next.lookbackPeriods;
  if (next.minMultiplier <= 0) next.minMultiplier = VOLATILITY_TARGETING_BOUNDS.minMultiplier[0];

  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Forecast
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Eine Zeitreihe für den Forecast. Alle Serien sind index-aligned
 * (gleiche Periode t, gleiche Länge T = `logReturns.length`).
 */
export interface VolatilityForecastSeries {
  /** Instrument-Kennung (nur für Reporting/Hashing, keine PII). */
  symbol: string;
  /**
   * Zielgewicht als Anteil der Gesamt-Exposure (Long-only, ≥ 0).
   * 0 = Symbol im Fenster, aber ohne Exposure (wird in der Gewichtssumme
   * nicht gezählt). Die Gewichte werden intern auf Summe 1 normalisiert.
   */
  weight: number;
  /**
   * Annualisierungsfaktor: Perioden pro Jahr für DIESE Asset-Klasse/
   * Timeframe (z. B. 8760 für 1h-Krypto, 6048 für 1h-Aktien, 252 für
   * 1d-Aktien). Muss endliche Zahl > 0 sein.
   */
  annualization: number;
  /** Logarithmische Renditen pro Periode (Länge T). */
  logReturns: readonly number[];
  /**
   * Verfügbarkeitszeitstempel (ms) je Return, aufsteigend, Länge T.
   * `eventTimes[t]` = Zeitpunkt, ab dem Return t bekannt war. Für die
   * Freshness gilt der jüngste Wert der jeweils ältesten Komponente
   * (konservativ: die langsamste Quelle dominiert).
   */
  eventTimes: readonly number[];
}

/** Input des Forecasts. `asOf`/`computedAt` in ms (epoch). */
export interface VolatilityForecastInput {
  series: readonly VolatilityForecastSeries[];
  /** Entscheidungszeitpunkt (ms). */
  asOf: number;
  /** Berechnungszeit (ms), normalerweise ≥ asOf. */
  computedAt: number;
  /** Voll validierte Konfiguration. */
  config: VolatilityTargetingConfig;
}

/** Code der Forecast-/Fallback-Ursache (geschlossen, bounded — kein Freitext-Label). */
export type VolatilityTargetingReasonCode =
  | "OK"
  | "ZERO_EXPOSURE"
  | "NO_SERIES"
  | "CONFIG_INVALID"
  | "INVALID_WEIGHTS"
  | "INSUFFICIENT_DATA"
  | "LENGTH_MISMATCH"
  | "INVALID_EVENT_TIMES"
  | "STALE_DATA"
  | "LOW_COVERAGE"
  | "SYMMETRY_VIOLATION"
  | "ILL_CONDITIONED";

/**
 * Ergebnis des Forecasts (BEVOR der Multiplikator gebildet wird).
 *
 * `forecastAnnualizedVol` ist `null` genau dann, wenn der Forecast nicht
 * berechenbar ist (Fail-closed). `null` heißt "unbekannt" — es wird NIEMALS
 * durch 0 ersetzt (0 wäre "kein Risiko", eine andere Aussage).
 */
export interface PortfolioVolatilityForecast {
  status: "OK" | "FALLBACK" | "NO_EXPOSURE";
  reasonCode: VolatilityTargetingReasonCode;
  /** Menschenlesbare Begründung (Audit/Status). */
  reason: string;
  /** Annualisierte Forecast-Volatilität (dezimal, 0.30 = 30 % p. a.) oder null. */
  forecastAnnualizedVol: number | null;
  /** Anzahl Perioden T (0 bei Fallback). */
  observations: number;
  /** Effektive Annualisierung: max(A_i) über die verwandten Serien. */
  annualization: number;
  /**
   * Gewichtete Datenabdeckung ∈ [0, 1]: Anteil der Gesamt-Exposure, der
   * mit validen, frischen, abdeckungserfüllenden Daten gemessen wurde.
   */
  coverage: number;
  /** Symbole, die in den Forecast eingegangen sind (sortiert). */
  usedSymbols: string[];
  /** Normalisierte Gewichte der verwandten Symbole (Summe = 1 bei OK). */
  normalizedWeights: Record<string, number>;
  /** Jüngstes Event der ältesten verwandten Komponente (ms) oder null. */
  eventTime: number | null;
  /** Angewendete Regularisierung: none | ridge (Shrinkage zählt nicht dazu). */
  regularization: "none" | "ridge" | "skipped";
  /** Tatsächlich verwendete Shrinkage κ. */
  shrinkage: number;
  /** T der verwandten Serien (0 bei Fallback). */
  seriesLength: number;
}

function fallbackForecast(
  reasonCode: VolatilityTargetingReasonCode,
  reason: string,
  config: VolatilityTargetingConfig,
  partial?: { coverage?: number; usedSymbols?: string[]; observations?: number; annualization?: number }
): PortfolioVolatilityForecast {
  return {
    status: "FALLBACK",
    reasonCode,
    reason,
    forecastAnnualizedVol: null,
    observations: partial?.observations ?? 0,
    annualization: partial?.annualization ?? 0,
    coverage: partial?.coverage ?? 0,
    usedSymbols: partial?.usedSymbols ?? [],
    normalizedWeights: {},
    eventTime: null,
    regularization: "skipped",
    shrinkage: config.shrinkage,
    seriesLength: 0,
  };
}

/**
 * Reiner Portfolio-Volatilitätsforecast.
 *
 * Validierungsreihenfolge (deterministisch):
 *   1. Konfiguration (target > 0)
 *   2. Gewichte (endliche, ≥ 0; Summe > 0, sonst ZERO_EXPOSURE)
 *   3. Serienlänge (alle T gleich, T ≥ minObservations)
 *   4. Per-Serie-Verwendbarkeit (NaN/±∞-Returns, fehlende Event-Zeiten,
 *      unzulässige Annualisierung ⇒ Serie unbrauchbar; Event-Zeiten in der
 *      Zukunft ⇒ harter Fehler INVALID_EVENT_TIMES)
 *   5. Abdeckung (gewichteter Anteil brauchbarer Serien ≥ minCoverage)
 *   6. Frische (computedAt − min(jüngste EventTime) ≤ maxStalenessMs)
 *   7. Kovarianz (Symmetrie, PSD via Cholesky, Ridge-Fallback)
 *
 * Jede Stufe liefert bei Scheitern einen FAIL-CLOSED-Forecast
 * (`status: "FALLBACK"`, `forecastAnnualizedVol: null`) — nie eine stille
 * "neutral" 0.
 */
export function computePortfolioVolatilityForecast(input: VolatilityForecastInput): PortfolioVolatilityForecast {
  const { series, computedAt, config } = input;

  // 1) Konfiguration
  const targetPct = requireFinite(config.targetAnnualizedVolPct, "config.targetAnnualizedVolPct");
  if (!(targetPct > 0)) {
    return fallbackForecast("CONFIG_INVALID", `ungültiges Volatilitätsziel ${targetPct}`, config);
  }

  // 2) Gewichte
  if (series.length === 0) {
    return fallbackForecast("NO_SERIES", "keine Serien übergeben", config);
  }
  const totalWeight = series.reduce((acc, s) => {
    const w = Number(s.weight);
    if (!Number.isFinite(w) || w < 0) return NaN;
    return acc + w;
  }, 0);
  if (!Number.isFinite(totalWeight)) {
    return fallbackForecast("INVALID_WEIGHTS", "Gewicht ist keine endliche Zahl oder negativ", config);
  }
  if (totalWeight <= 0) {
    return {
      status: "NO_EXPOSURE",
      reasonCode: "ZERO_EXPOSURE",
      reason: "keine Exposure (alle Gewichte 0) — Portfolio ist Cash, Forecast trivial erfüllt",
      forecastAnnualizedVol: 0,
      observations: 0,
      annualization: 0,
      coverage: 1,
      usedSymbols: [],
      normalizedWeights: {},
      eventTime: null,
      regularization: "skipped",
      shrinkage: config.shrinkage,
      seriesLength: 0,
    };
  }

  // 3) Serienlänge
  const T = series[0].logReturns.length;
  let lengthMismatch = false;
  for (const s of series) {
    if (s.logReturns.length !== T) {
      lengthMismatch = true;
      break;
    }
  }
  if (lengthMismatch) {
    return fallbackForecast("LENGTH_MISMATCH", "Serien haben unterschiedliche Länge (Alignment verletzt)", config);
  }
  if (T < 2) {
    return fallbackForecast("INSUFFICIENT_DATA", `mindestens 2 Beobachtungen nötig, gefunden ${T}`, config, {
      observations: T,
    });
  }
  if (T < config.minObservations) {
    return fallbackForecast(
      "INSUFFICIENT_DATA",
      `nur ${T} Beobachtungen, mindestens ${config.minObservations} nötig (Wärmeauflauf)`,
      config,
      { observations: T }
    );
  }

  // 4) Per-Serie-Verwendbarkeit (fail-closed, granular):
  //    Eine Serie mit NaN/±∞-Returns, fehlenden Event-Zeiten oder
  //    unzulässiger Annualisierung ist UNVERWENDBAR — ihr Exposure zählt
  //    dann in die Abdeckung (Schritt 5). Event-Zeiten in der ZUKUNFT
  //    (Look-ahead-Verdacht) sind ein Strukturverstoß und scheitern HART
  //    (INVALID_EVENT_TIMES).
  const usable: { symbol: string; weight: number; annualization: number; logReturns: readonly number[]; latestEvent: number }[] = [];
  for (const s of series) {
    const w = Number(s.weight);
    if (w <= 0) continue; // kein Exposure → nicht relevant
    let A: number;
    try {
      A = validateAnnualization(Number(s.annualization));
    } catch {
      continue; // unzulässige Annualisierung ⇒ unverwendbar (Coverage)
    }
    // Event-Zeiten: Pflicht, endliche, > 0, strikt aufsteigend.
    let eventOk = s.eventTimes.length === T;
    let futureEvent = false;
    for (let t = 0; t < T && eventOk; t++) {
      const e = s.eventTimes[t];
      if (!Number.isFinite(e) || e <= 0) {
        eventOk = false;
        break;
      }
      if (t > 0 && e <= s.eventTimes[t - 1]) {
        eventOk = false;
        break;
      }
      if (e > computedAt) futureEvent = true;
    }
    if (!eventOk) continue; // Frische nicht verifizierbar ⇒ unverwendbar
    if (futureEvent) {
      return fallbackForecast(
        "INVALID_EVENT_TIMES",
        `Event-Zeit liegt in der Zukunft (computedAt = ${computedAt}) — Look-ahead-Verdacht, abgelehnt`,
        config,
        { observations: T }
      );
    }
    // Endlichkeit der Returns: eine einzige NaN/±∞ macht die Serie unbrauchbar.
    let finite = true;
    for (let t = 0; t < T; t++) {
      if (!Number.isFinite(s.logReturns[t])) {
        finite = false;
        break;
      }
    }
    if (!finite) continue;
    usable.push({ symbol: s.symbol, weight: w, annualization: A, logReturns: s.logReturns, latestEvent: s.eventTimes[T - 1] });
  }

  // 5) Abdeckung: gewichteter Anteil der messbaren Exposure (fail-closed).
  const usableWeight = usable.reduce((acc, s) => acc + s.weight, 0);
  const coverage = usableWeight / totalWeight;
  if (usable.length === 0) {
    return fallbackForecast("NO_SERIES", "keine Serie mit Exposure und validen Daten (alle unbrauchbar)", config, {
      observations: T,
      coverage,
    });
  }
  if (coverage < config.minCoverage) {
    return fallbackForecast(
      "LOW_COVERAGE",
      `gewichtete Datenabdeckung ${(coverage * 100).toFixed(1)} % unter dem Limit ${(config.minCoverage * 100).toFixed(0)} % — ${series.length - usable.length} Serie(n) unbrauchbar`,
      config,
      { observations: T, coverage }
    );
  }

  // 6) Frische: jüngstes Event der ÄLTESTEN verwandten Komponente dominiert
  //    (konservativ: die langsamste Quelle bestimmt die Freshness).
  const oldestLatestEvent = Math.min(...usable.map((s) => s.latestEvent));
  const stalenessMs = computedAt - oldestLatestEvent;
  if (stalenessMs > config.maxStalenessMs) {
    return fallbackForecast(
      "STALE_DATA",
      `Daten zu alt: jüngstes Event der ältesten Komponente ist ${Math.round(stalenessMs / 60_000)} min alt (Limit ${Math.round(config.maxStalenessMs / 60_000)} min)`,
      config,
      { observations: T, coverage }
    );
  }

  // Gewichte auf die verwandten Serien normalisieren (Summe = 1).
  const normalizedWeights: Record<string, number> = {};
  const wArr = usable.map((s) => s.weight / usableWeight);
  for (let i = 0; i < usable.length; i++) normalizedWeights[usable[i].symbol] = wArr[i];

  // 8) Kovarianz (pro Periode, ddof = 1).
  const n = usable.length;
  const means = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let t = 0; t < T; t++) acc += usable[i].logReturns[t];
    means[i] = acc / T;
  }
  const centered = usable.map((s, i) => {
    const out = new Float64Array(T);
    for (let t = 0; t < T; t++) out[t] = s.logReturns[t] - means[i];
    return out;
  });
  const denom = T - 1;
  const rows: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let acc = 0;
      for (let t = 0; t < T; t++) acc += centered[i][t] * centered[j][t];
      const v = acc / denom;
      rows[i][j] = v;
      rows[j][i] = v;
    }
  }

  // Shrinkage: Σ* = (1−κ)·Σ + κ·μ·I, μ = tr(Σ)/n (konstante Shrinkage auf die
  // mittlere Varianz — stabil, deterministisch, dokumentiert).
  const kappa = Math.min(Math.max(config.shrinkage, 0), 0.99);
  let trace = 0;
  for (let i = 0; i < n; i++) trace += rows[i][i];
  const mu = trace / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) rows[i][j] = (1 - kappa) * rows[i][j] + (i === j ? kappa * mu : 0);
  }

  const matrix: Matrix = { n, data: new Float64Array(n * n) };
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) matrix.data[i * n + j] = rows[i][j];

  // Symmetrie-Check (wäre ein numerischer Regressionsbefund).
  if (!isSymmetric(matrix, 1e-9)) {
    return fallbackForecast(
      "SYMMETRY_VIOLATION",
      "Kovarianzmatrix ist numerisch nicht symmetrisch",
      config,
      { observations: T, coverage }
    );
  }

  // PSD-Check via Cholesky; bei Scheitern Ridge (wie regularizeCovariance "ridge").
  let finalMatrix: Matrix;
  let regularization: "none" | "ridge";
  try {
    cholesky(matrix, "volatilityTargeting.covariance");
    finalMatrix = matrix;
    regularization = "none";
  } catch (e) {
    try {
      const reg = regularizeCovariance(matrix, "ridge", { ridgeFactor: 1e-6 });
      finalMatrix = reg.matrix;
      regularization = "ridge";
    } catch {
      return fallbackForecast(
        "ILL_CONDITIONED",
        `Kovarianzmatrix nicht positiv definit (auch nach Ridge): ${e instanceof Error ? e.message : "unbekannt"}`,
        config,
        { observations: T, coverage }
      );
    }
  }

  // Annualisierte Portfolio-Volatilität:
  //   Σ^A_ij = Σ*_ij · √(A_i·A_j)   (einheitliches A reduziert auf A·Σ*)
  //   σ̂_a = √(wᵀ Σ^A w)
  const annualizations = usable.map((s) => s.annualization);
  const maxAnnualization = Math.max(...annualizations);
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const wi = wArr[i];
    for (let j = i; j < n; j++) {
      const wj = wArr[j];
      const aij = finalMatrix.data[i * n + j];
      const annualized = aij * Math.sqrt(annualizations[i] * annualizations[j]);
      variance += i === j ? wi * wj * annualized : 2 * wi * wj * annualized;
    }
  }
  if (!Number.isFinite(variance) || variance < 0) {
    return fallbackForecast(
      "ILL_CONDITIONED",
      `Portfolio-Varianz nicht endlich oder negativ (${variance})`,
      config,
      { observations: T, coverage }
    );
  }
  const forecastAnnualizedVol = Math.sqrt(variance);
  if (!Number.isFinite(forecastAnnualizedVol)) {
    return fallbackForecast(
      "ILL_CONDITIONED",
      `Forecast-Volatilität nicht endlich (Varianz ${variance})`,
      config,
      { observations: T, coverage }
    );
  }

  const usedSymbols = usable.map((s) => s.symbol).sort();
  return {
    status: "OK",
    reasonCode: "OK",
    reason: `Forecast OK: ${n} Symbole, T=${T}, Abdeckung ${(coverage * 100).toFixed(1)} %, Regularisierung ${regularization}`,
    forecastAnnualizedVol,
    observations: T,
    annualization: maxAnnualization,
    coverage,
    usedSymbols,
    normalizedWeights,
    eventTime: oldestLatestEvent,
    regularization,
    shrinkage: kappa,
    seriesLength: T,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Multiplikator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ergebnis des vollständigen Volatility-Targeting-Schritts (Forecast +
 * Multiplikator). `appliedMultiplier` ist IMMER eine endliche Zahl in
 * `[minMultiplier, maxMultiplier]` (mit `maxMultiplier ≤ 1`) — das ist der
 * Wert, der tatsächlich auf das Risikobudget wirkt.
 */
export interface VolatilityTargetingResult {
  /** Der Forecast (siehe {@link PortfolioVolatilityForecast}). */
  forecast: PortfolioVolatilityForecast;
  /** Annualisiertes Ziel (dezimal; aus `targetAnnualizedVolPct / 100`). */
  targetAnnualizedVol: number;
  /**
   * Roher Multiplikator `target / forecast` (vor Clamp/Smoothing/Step).
   * `null` bei Fallback (nicht berechenbar) — bewusst nicht 0 oder ∞.
   */
  rawMultiplier: number | null;
  /** Nach Clamp auf [min, max] (vor Smoothing/Step). */
  clampedMultiplier: number | null;
  /** Vorheriger Multiplikator (null = erster Lauf ⇒ maxMultiplier). */
  prevMultiplier: number | null;
  /** Tatsächlich angewendeter Multiplikator (immer endlich, ≤ 1). */
  appliedMultiplier: number;
  /** Kurz-Code für Telemetrie (bounded, kein Freitext). */
  outcome: "ok" | "fallback" | "no_exposure";
}

/**
 * Reine Multiplikatorbildung aus Forecast und Konfiguration.
 *
 * Reihenfolge (deterministisch):
 *   1. Fallback (Forecast.status = FALLBACK) ⇒ `applied = minMultiplier`,
 *      SOFORT (bypassed Step + Smoothing — sichere Richtung ist sofort).
 *   2. NO_EXPOSURE (keine Exposure) ⇒ `applied = maxMultiplier` (1).
 *   3. OK: raw = target/forecast → clamp → EMA-Smoothing → Max-Step.
 *
 * `prevMultiplier` ist der zuletzt ANGEWENDETE Multiplikator (aus RAM oder
 * DB). `null` = erster Lauf ⇒ `prev = maxMultiplier` (neutraler Start).
 */
export function computeVolatilityTargeting(
  forecast: PortfolioVolatilityForecast,
  config: VolatilityTargetingConfig,
  prevMultiplier: number | null
): VolatilityTargetingResult {
  const targetAnnualizedVol = config.targetAnnualizedVolPct / 100;
  const prev =
    prevMultiplier === null || !Number.isFinite(prevMultiplier)
      ? config.maxMultiplier
      : Math.min(Math.max(prevMultiplier, config.minMultiplier), config.maxMultiplier);

  // 1) Fallback: konservativ, sofort, ohne Glättung/Step.
  if (forecast.status === "FALLBACK") {
    return {
      forecast,
      targetAnnualizedVol,
      rawMultiplier: null,
      clampedMultiplier: null,
      prevMultiplier: prev,
      appliedMultiplier: config.minMultiplier,
      outcome: "fallback",
    };
  }

  // 2) Keine Exposure: Ziel trivial erfüllt, neutraler Faktor.
  if (forecast.status === "NO_EXPOSURE") {
    return {
      forecast,
      targetAnnualizedVol,
      rawMultiplier: null,
      clampedMultiplier: config.maxMultiplier,
      prevMultiplier: prev,
      appliedMultiplier: config.maxMultiplier,
      outcome: "no_exposure",
    };
  }

  // 3) OK: Forecast > 0 muss gelten (von computePortfolioVolatilityForecast garantiert).
  const forecastVol = forecast.forecastAnnualizedVol as number;
  if (!(forecastVol > 0)) {
    // Defensive: sollte durch den Forecast ausgeschlossen sein.
    return {
      forecast: { ...forecast, status: "FALLBACK", reasonCode: "ILL_CONDITIONED", reason: `Forecast-Volatilität ≤ 0 (${forecastVol})` },
      targetAnnualizedVol,
      rawMultiplier: null,
      clampedMultiplier: null,
      prevMultiplier: prev,
      appliedMultiplier: config.minMultiplier,
      outcome: "fallback",
    };
  }

  const raw = targetAnnualizedVol / forecastVol;
  const clamped = Math.min(Math.max(raw, config.minMultiplier), config.maxMultiplier);
  // EMA-Glättung: α·clamped + (1−α)·prev
  const smoothed = config.smoothingAlpha * clamped + (1 - config.smoothingAlpha) * prev;
  // Max-Step: |applied − prev| ≤ maxStep
  const stepLimited = Math.min(Math.max(smoothed, prev - config.maxStep), prev + config.maxStep);
  // Finaler Clamp (doppelte Absicherung gegen numerische Drift).
  const applied = Math.min(Math.max(stepLimited, config.minMultiplier), config.maxMultiplier);

  return {
    forecast,
    targetAnnualizedVol,
    rawMultiplier: raw,
    clampedMultiplier: clamped,
    prevMultiplier: prev,
    appliedMultiplier: applied,
    outcome: "ok",
  };
}

/**
 * Kombiniert Forecast und Multiplikator in EINEM Aufruf (der kanonische
 * Entry-Point für Live- und Backtest-Pfade).
 */
export function computeVolatilityTargetingFromInput(
  input: VolatilityForecastInput,
  prevMultiplier: number | null
): VolatilityTargetingResult {
  const forecast = computePortfolioVolatilityForecast(input);
  return computeVolatilityTargeting(forecast, input.config, prevMultiplier);
}

// ─────────────────────────────────────────────────────────────────────────────
// Realisierte Volatilität + Target Error (Soll-Ist-Monitoring)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Realisierte (historische) Portfolio-Volatilität über dasselbe Fenster und
 * dieselben Gewichte wie der Forecast — aber OHNE Shrinkage (reine
 * Stichprobenkovarianz), weil sie das IST, nicht das SOLL, misst.
 *
 * Liefert `null`, wenn die Realisierung nicht berechenbar ist (fehlende
 * Daten, singuläre Matrix, invalide Annualisierung) — niemals 0. Wirft
 * NIE (gleiche Fail-closed-Konvention wie der Forecast).
 */
export function computeRealizedPortfolioVolatility(
  series: readonly VolatilityForecastSeries[],
  config: VolatilityTargetingConfig
): number | null {
  try {
    return computeRealizedPortfolioVolatilityInner(series);
  } catch {
    return null;
  }
}

function computeRealizedPortfolioVolatilityInner(
  series: readonly VolatilityForecastSeries[]
): number | null {
  const totalWeight = series.reduce((acc, s) => {
    const w = Number(s.weight);
    if (!Number.isFinite(w) || w < 0) return NaN;
    return acc + w;
  }, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) return null;

  const usable = series.filter((s) => {
    const w = Number(s.weight);
    if (w <= 0) return false;
    const T = s.logReturns.length;
    for (let t = 0; t < T; t++) if (!Number.isFinite(s.logReturns[t])) return false;
    // Unzulässige Annualisierung (wie im Forecast) ⇒ Serie unverwendbar.
    try {
      validateAnnualization(Number(s.annualization));
    } catch {
      return false;
    }
    return true;
  });
  if (usable.length === 0) return null;

  const T = usable[0].logReturns.length;
  if (T < 2) return null;
  for (const s of usable) if (s.logReturns.length !== T) return null;

  const n = usable.length;
  const means = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let t = 0; t < T; t++) acc += usable[i].logReturns[t];
    means[i] = acc / T;
  }
  const centered = usable.map((s, i) => {
    const out = new Float64Array(T);
    for (let t = 0; t < T; t++) out[t] = s.logReturns[t] - means[i];
    return out;
  });
  const denom = T - 1;
  const rows: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let acc = 0;
      for (let t = 0; t < T; t++) acc += centered[i][t] * centered[j][t];
      const v = acc / denom;
      rows[i][j] = v;
      rows[j][i] = v;
    }
  }
  const usableWeight = usable.reduce((acc, s) => acc + Number(s.weight), 0);
  const wArr = usable.map((s) => Number(s.weight) / usableWeight);
  const annualizations = usable.map((s) => validateAnnualization(Number(s.annualization)));
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const wi = wArr[i];
    for (let j = i; j < n; j++) {
      const wj = wArr[j];
      const aij = rows[i][j];
      const annualized = aij * Math.sqrt(annualizations[i] * annualizations[j]);
      variance += i === j ? wi * wj * annualized : 2 * wi * wj * annualized;
    }
  }
  if (!Number.isFinite(variance) || variance < 0) return null;
  const vol = Math.sqrt(variance);
  return Number.isFinite(vol) ? vol : null;
}

/**
 * Target Error = realisierte − Ziel (annualisiert, dezimal).
 * `null` wenn die realisierte Volatilität nicht berechenbar ist.
 * Positive Werte = Portfolio ist UNTER dem Ziel (zu wenig Risiko),
 * negative = ÜBER dem Ziel (Risiko zu hoch).
 */
export function computeTargetError(
  realizedVol: number | null,
  config: VolatilityTargetingConfig
): number | null {
  if (realizedVol === null) return null;
  const target = config.targetAnnualizedVolPct / 100;
  return realizedVol - target;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministische Hashing-Helfer (für Idempotenz + Reproduzierbarkeit)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kanonische JSON-Stringifikation (sortierte Keys, stabile Zahlen).
 * Dient als Basis für deterministische Hashes — gleiche fachliche Eingabe
 * erzeugt dieselbe Zeichenkette.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJsonStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/** SHA-256 (hex) einer Zeichenkette. */
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Deterministischer Hash der KONFIGURATION (resolved). Dient als
 * `config_hash` in der Persistenz — gleiche Config ⇒ gleicher Hash.
 */
export function hashVolatilityTargetingConfig(config: VolatilityTargetingConfig): string {
  return `cfg1:${sha256Hex(canonicalJsonStringify(config))}`;
}

/**
 * Deterministischer Hash der DATEN (Serien + Gewichte + Event-Zeiten +
 * Zeitstempel). Dient als `data_hash` in der Persistenz — gleiche Daten ⇒
 * gleicher Hash. Enthalten sind: Symbole, Gewichte, Annualisierung,
 * Log-Renditen, Event-Zeiten, asOf, computedAt.
 */
export function hashVolatilityTargetingData(input: {
  series: readonly VolatilityForecastSeries[];
  asOf: number;
  computedAt: number;
}): string {
  const payload = {
    symbols: input.series.map((s) => s.symbol),
    weights: input.series.map((s) => s.weight),
    annualizations: input.series.map((s) => s.annualization),
    logReturns: input.series.map((s) => s.logReturns),
    eventTimes: input.series.map((s) => s.eventTimes),
    asOf: input.asOf,
    computedAt: input.computedAt,
  };
  return `data1:${sha256Hex(canonicalJsonStringify(payload))}`;
}

/**
 * Stabiler Idempotency-Key für einen Snapshot: `vt1:<sha256>` über
 * (computedAt gerundet auf die Minute, configHash, dataHash). Ein Retry
 * oder Neustart innerhalb derselben Minute mit identischer Eingabe
 * erzeugt dieselbe ID ⇒ `ON CONFLICT DO NOTHING` ⇒ keine doppelte Zeile.
 */
export function buildVolatilityTargetingIdempotencyKey(
  computedAtMs: number,
  configHash: string,
  dataHash: string
): string {
  const minute = Math.floor(computedAtMs / 60_000);
  const payload = canonicalJsonStringify({ minute, configHash, dataHash });
  return `vt1:${sha256Hex(payload)}`;
}
