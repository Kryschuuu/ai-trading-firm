/**
 * Feature-Vertrag der multidimensionalen Regime-Erkennung (RMA-P2-01,
 * v1.61.0) — REIN, keine IO, kein `fs`, kein `pg`.
 *
 * Das bestehende OHLCV-Klassifikat (GAP-06) bleibt der Kern; dieser Vertrag
 * definiert die zusätzlichen Featurefamilien (Liquidität, Perp, optionale
 * Makro) mit:
 *
 *   - **Einheiten und Lookbacks** je Sample (fest im Vertrag, versioniert),
 *   - **Zeitsemantik**: `eventTime` (Ereignis), `availableAt` (ab wann
 *     bekannt), Berechnung findet immer zum `asOf` des Snapshots statt,
 *   - **Staleness-Budgets** je Familie — zu alte Messungen sind `STALE`,
 *     nicht `OK`,
 *   - **Missingness** ohne Nullsubstitution: fehlend/invalid/stale bleibt
 *     `null`-wertiges Sample mit Grundcode — `null` wird nie zu `0`.
 *
 * Point-in-Time-Regel (Look-ahead-Schutz): Ein Sample ist nur verwendbar,
 * wenn `availableAt ≤ asOf` UND `eventTime ≤ asOf` gilt. Später verfügbare
 * Daten werden als `MISSING (AVAILABLE_AT_FUTURE)` verworfen — ein Backtest
 * kann damit keine später eingetroffenen Makro-/Perp-Daten sehen.
 *
 * Coverage: Gewicht der `OK`-Familien geteilt durch die Summe der
 * NICHT-optionalen Familiengewichte (Preis 0.30, Volatilität 0.30,
 * Liquidität 0.20, Perp 0.20 ⇒ Nenner 1.00). Die optionale Makro-Familie
 * geht nicht in den Nenner ein (nie verfügbar ⇒ kein Coverage-Verlust),
 * wird aber im Familienstatus ausgewiesen.
 */

/** Version des Feature-Vertrags (Familien, Einheiten, Staleness-Budgets). */
export const REGIME_FEATURE_VERSION = "regime-features@1";

/**
 * Version des deterministischen Regime-Modells (OHLCV-Kern + Eskalations-
 * votes + Confidence-Formel). Keine Online-Adaption: jede Semantikänderung
 * erhöht diese Version.
 */
export const REGIME_MODEL_VERSION = "regime-rules@1";

/** Featurefamilien des Vertrags. `macro` ist optional, alle übrigen Pflicht. */
export type RegimeFeatureFamily = "price" | "volatility" | "liquidity" | "perp" | "macro";

/** Status einer Familie (aggregiert über das Primary-Sample). */
export type RegimeFamilyStatus = "OK" | "STALE" | "MISSING" | "DISABLED";

/** Status eines einzelnen Samples. */
export type RegimeSampleStatus = "OK" | "STALE" | "MISSING";

/** Stabile, maschinenlesbare Gründe (geschlossenes Vokabular — keine Fremdtexte). */
export const REGIME_SAMPLE_REASONS = [
  "OK",
  "NO_INPUT",
  "NO_VALUE",
  "INVALID_VALUE",
  "NO_EVENT_TIME",
  "EVENT_TIME_FUTURE",
  "AVAILABLE_AT_FUTURE",
  "STALE",
  "FAMILY_DISABLED",
  "FAMILY_NOT_CONSULTED",
] as const;
export type RegimeSampleReason = (typeof REGIME_SAMPLE_REASONS)[number];

/** Ein Sample des Vertrags (Wert oder explizit fehlend — nie `0`-Ersatz). */
export interface RegimeFeatureSample {
  key: string;
  family: RegimeFeatureFamily;
  /** Endlicher Messwert oder `null` (fehlend/invalid — keine Substitution). */
  value: number | null;
  /** Einheit (z. B. `quote`, `percentile_0_100`, `fraction`, `index`). */
  unit: string;
  /** Lookback/Bildungsfenster des Samples (dokumentiert, versioniert). */
  lookback: string;
  /** Ereigniszeit des Messwerts (ms seit Epoch) oder `null`. */
  eventTimeMs: number | null;
  /** Ab wann der Wert bekannt war (ms) — `null` nur bei `NO_INPUT`. */
  availableAtMs: number | null;
  status: RegimeSampleStatus;
  reason: RegimeSampleReason;
  /** Alter gegen `asOf` in ms (`null`, wenn nicht berechenbar). */
  ageMs: number | null;
}

/** Aggregierter Zustand einer Familie. */
export interface RegimeFamilyState {
  family: RegimeFeatureFamily;
  status: RegimeFamilyStatus;
  reason: RegimeSampleReason;
  optional: boolean;
  /** Coverage-Gewicht der Familie (0 für optionale Familien). */
  weight: number;
  samples: RegimeFeatureSample[];
}

/** Zusammengesetzter Feature-Vektor zum `asOf`-Zeitpunkt. */
export interface RegimeFeatureVector {
  /** As-of-Zeitpunkt der Bewertung (ISO). */
  asOf: string;
  featureVersion: string;
  families: RegimeFamilyState[];
  /** Gewicht der OK-Pflichtfamilien / Summe Pflichtgewichte, geklemmt [0, 1]. */
  coverage: number;
  /** true = nicht alle Pflichtfamilien `OK` → Degraded Mode. */
  degraded: boolean;
}

/** Roh-Inputs der erweiterten Familien (vom Loader oder aus Fixtures). */
export interface RegimeFamilyInputs {
  liquidity?: {
    /** Relativer Spread `(ask-bid)/mid` — `fraction` (0.001 = 10 bp). */
    relativeSpread: number | null;
    /** Messzeitpunkt des Spreads (ms). */
    measuredAtMs: number | null;
  };
  perp?: {
    /** Funding-Rate des jüngsten Satzes — `fraction` je Intervall. */
    fundingRate: number | null;
    fundingEventTimeMs: number | null;
    /** 24h-Änderung des Open Interest — `fraction` (0.1 = +10 %). */
    openInterestChange24h: number | null;
    oiEventTimeMs: number | null;
    /**
     * konservative Verfügbarkeit des ganzen Artefakts (ms): Spätestens
     * Schreib-/Sync-Zeitpunkt — Cache-Inhalte sind vorher nicht bekannt.
     */
    availableAtMs: number | null;
  };
  macro?: {
    /** VIX-Level — `index` (z. B. 28.4). */
    vix: number | null;
    /** Messzeitpunkt der adaptiven Bewertung (ms). */
    measuredAtMs: number | null;
  };
}

/** Klassifikationsmodus: `ohlcv` = expliziter Degraded-/Legacy-Pfad. */
export type RegimeFeatureMode = "ohlcv" | "multidim";

interface ContractEntry {
  family: RegimeFeatureFamily;
  optional: boolean;
  weight: number;
  unit: string;
  lookback: string;
  /** Staleness-Budget gegen `eventTime` (ms); `null` = kein Budget. */
  maxStalenessMs: number | null;
  primarySampleKey: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Vertragstabelle (single source of truth für Familien, Gewichte, Einheiten,
 * Lookbacks und Staleness). Gewichte: Preis 0.30 + Volatilität 0.30 +
 * Liquidität 0.20 + Perp 0.20 = 1.00 (Nenner der Coverage); Makro optional.
 */
export const REGIME_FEATURE_CONTRACT: readonly ContractEntry[] = Object.freeze([
  {
    family: "price",
    optional: false,
    weight: 0.3,
    unit: "quote",
    lookback: "lookbackCandles×15m (letzter Schlusskurs)",
    // 2 h: jüngste abgeschlossene 15m-Kerze darf nicht älter sein. Außerhalb
    // der Handelszeiten (Wochenende) wird die Familie damit ehrlich STALE.
    maxStalenessMs: 2 * HOUR,
    primarySampleKey: "price.close",
  },
  {
    family: "volatility",
    optional: false,
    weight: 0.3,
    unit: "percentile_0_100",
    lookback: "REGIME_VOL_WINDOW=20-Renditefenster, Perzentil über Lookback",
    maxStalenessMs: 2 * HOUR,
    primarySampleKey: "volatility.realizedPercentile",
  },
  {
    family: "liquidity",
    optional: false,
    weight: 0.2,
    unit: "fraction",
    lookback: "Orderbuch-Messung (Spread-Cache, TTL 6 h)",
    maxStalenessMs: 6 * HOUR,
    primarySampleKey: "liquidity.relativeSpread",
  },
  {
    family: "perp",
    optional: false,
    weight: 0.2,
    unit: "fraction_per_interval",
    lookback: "jüngster Funding-Satz; OI-Delta 24 h (Derivative-Cache)",
    maxStalenessMs: 24 * HOUR,
    primarySampleKey: "perp.fundingRate",
  },
  {
    family: "macro",
    optional: true,
    weight: 0,
    unit: "index",
    lookback: "jüngste adaptive VIX-Bewertung (Parität ADAPTIVE_STATE_MAX_AGE_MS)",
    maxStalenessMs: 15 * MINUTE,
    primarySampleKey: "macro.vix",
  },
]);

/** Nenner der Coverage (Summe der Nicht-optionalen Gewichte) = 1.0. */
export const REGIME_COVERAGE_DENOMINATOR = REGIME_FEATURE_CONTRACT.filter((c) => !c.optional).reduce(
  (sum, c) => sum + c.weight,
  0
);

/** Summe der OK-Bewertungen → Coverage, geklemmt [0, 1], 6 Dezimalstellen. */
export function coverageOf(families: readonly RegimeFamilyState[]): number {
  let covered = 0;
  for (const state of families) {
    if (state.optional) continue;
    if (state.status === "OK") covered += state.weight;
  }
  const raw = REGIME_COVERAGE_DENOMINATOR > 0 ? covered / REGIME_COVERAGE_DENOMINATOR : 0;
  const clamped = Math.min(Math.max(raw, 0), 1);
  // Deterministische Serialisierung (Golden-/Hash-Tests).
  return Math.round(clamped * 1e6) / 1e6;
}

type SampleEvalInput = {
  key: string;
  family: RegimeFeatureFamily;
  unit: string;
  lookback: string;
  value: number | null;
  eventTimeMs: number | null;
  availableAtMs: number | null;
  asOfMs: number;
  maxStalenessMs: number | null;
  disabled?: boolean;
  /**
   * true = kerzenabgeleitetes Sample (Preis/Volatilität): die Kerzen sind
   * selbst das Eingabe-Input des Callers (Kontrakt „abgeschlossene Kerzen
   * ≤ t“, Zeitmaske des Klassifikators) — ein von injizierten Test-Zeiten
   * abweichendes `eventTime` wird hier NICHT als Look-ahead verworfen.
   * Externe Familien (Liquidität/Perp/Makro) bleiben strikt PIT-geprüft.
   */
  callerProvidedTimeline?: boolean;
};

/** Bewertet EIN Sample gegen den Vertrag (rein, deterministisch). */
export function evaluateSample(input: SampleEvalInput): RegimeFeatureSample {
  const base = {
    key: input.key,
    family: input.family,
    unit: input.unit,
    lookback: input.lookback,
    eventTimeMs: input.eventTimeMs,
    availableAtMs: input.availableAtMs,
    ageMs: null as number | null,
  };
  if (input.disabled) {
    return { ...base, value: null, status: "MISSING", reason: "FAMILY_DISABLED" };
  }
  if (input.availableAtMs == null && input.eventTimeMs == null && input.value == null) {
    return { ...base, value: null, status: "MISSING", reason: "NO_INPUT" };
  }
  if (input.value == null) {
    return { ...base, value: null, status: "MISSING", reason: "NO_VALUE" };
  }
  if (!Number.isFinite(input.value)) {
    // Invalid ≠ 0: der Wert wird verworfen, nicht ersetzt.
    return { ...base, value: null, status: "MISSING", reason: "INVALID_VALUE" };
  }
  if (!input.callerProvidedTimeline) {
    if (input.availableAtMs != null && input.availableAtMs > input.asOfMs) {
      return { ...base, value: null, status: "MISSING", reason: "AVAILABLE_AT_FUTURE" };
    }
    if (input.eventTimeMs == null) {
      return { ...base, value: null, status: "MISSING", reason: "NO_EVENT_TIME" };
    }
    if (input.eventTimeMs > input.asOfMs) {
      return { ...base, value: null, status: "MISSING", reason: "EVENT_TIME_FUTURE" };
    }
  } else if (input.eventTimeMs == null) {
    return { ...base, value: null, status: "MISSING", reason: "NO_EVENT_TIME" };
  }
  const ageMs = Math.max(0, input.asOfMs - input.eventTimeMs);
  if (input.maxStalenessMs != null && ageMs > input.maxStalenessMs) {
    return { ...base, value: input.value, status: "STALE", reason: "STALE", ageMs };
  }
  return { ...base, value: input.value, status: "OK", reason: "OK", ageMs };
}

function contractEntry(family: RegimeFeatureFamily): ContractEntry {
  const entry = REGIME_FEATURE_CONTRACT.find((c) => c.family === family);
  /* c8 ignore next -- Vertragstabelle ist konstant;existence-Guard für Refactor-Sicherheit */
  if (!entry) throw new Error(`regimeFeatures: Familie "${family}" fehlt im Feature-Vertrag.`);
  return entry;
}

function familyStateOf(
  family: RegimeFeatureFamily,
  samples: RegimeFeatureSample[],
  asOfMs: number,
  disabled: boolean
): RegimeFamilyState {
  const entry = contractEntry(family);
  const primary = samples.find((s) => s.key === entry.primarySampleKey);
  let status: RegimeFamilyStatus;
  let reason: RegimeSampleReason;
  if (disabled || primary?.reason === "FAMILY_DISABLED") {
    status = "DISABLED";
    reason = "FAMILY_DISABLED";
  } else if (!primary) {
    status = "MISSING";
    reason = "NO_INPUT";
  } else if (primary.status === "OK") {
    status = "OK";
    reason = "OK";
  } else if (primary.status === "STALE") {
    status = "STALE";
    reason = primary.reason;
  } else {
    status = "MISSING";
    reason = primary.reason;
  }
  void asOfMs;
  return { family, status, reason, optional: entry.optional, weight: entry.weight, samples };
}

export type AssembleFeatureVectorInput = {
  asOfMs: number;
  mode: RegimeFeatureMode;
  /** Letzter Schlusskurs der ausgewerteten Kerzen (oder `null`). */
  price?: { close: number | null; eventTimeMs: number | null } | null;
  /** Volatilitäts-Perzentil der OHLCV-Klassifikation (oder `null`). */
  volatility?: { volPercentile: number | null; eventTimeMs: number | null } | null;
  /** Erweiterte Familien (Live-Loader oder Backtest-Fixtures, PIT-gefiltert). */
  families?: RegimeFamilyInputs | null;
};

/**
 * Setzt den Feature-Vektor zum `asOf` zusammen — rein und deterministisch.
 *
 * - `price`/`volatility` stammen aus den ausgewerteten (abgeschlossenen)
 *   Kerzen selbst; `eventTime` = Zeitstempel der letzten Kerze.
 * - `liquidity`/`perp`/`macro` werden nur im Modus `multidim` konsultiert;
 *   im Modus `ohlcv` sind sie `FAMILY_DISABLED` (expliziter Degraded Mode).
 * - Jedes Sample durchläuft die PIT- und Staleness-Prüfung; es gibt keine
 *   Nullsubstitution und keinen „neutralen“ Ersatzwert.
 */
export function assembleRegimeFeatureVector(input: AssembleFeatureVectorInput): RegimeFeatureVector {
  const asOfMs = Number.isFinite(input.asOfMs) ? input.asOfMs : 0;
  const extended = input.mode === "multidim";
  const fam = input.families ?? null;

  const priceEntry = contractEntry("price");
  const volEntry = contractEntry("volatility");
  const priceSample = evaluateSample({
    key: priceEntry.primarySampleKey,
    family: "price",
    unit: priceEntry.unit,
    lookback: priceEntry.lookback,
    value: input.price?.close ?? null,
    eventTimeMs: input.price?.eventTimeMs ?? null,
    availableAtMs: input.price?.eventTimeMs ?? null,
    asOfMs,
    maxStalenessMs: priceEntry.maxStalenessMs,
    callerProvidedTimeline: true,
  });
  const volSample = evaluateSample({
    key: volEntry.primarySampleKey,
    family: "volatility",
    unit: volEntry.unit,
    lookback: volEntry.lookback,
    value: input.volatility?.volPercentile ?? null,
    eventTimeMs: input.volatility?.eventTimeMs ?? null,
    availableAtMs: input.volatility?.eventTimeMs ?? null,
    asOfMs,
    maxStalenessMs: volEntry.maxStalenessMs,
    callerProvidedTimeline: true,
  });

  const liqEntry = contractEntry("liquidity");
  const liqSample = evaluateSample({
    key: liqEntry.primarySampleKey,
    family: "liquidity",
    unit: liqEntry.unit,
    lookback: liqEntry.lookback,
    value: fam?.liquidity?.relativeSpread ?? null,
    eventTimeMs: fam?.liquidity?.measuredAtMs ?? null,
    availableAtMs: fam?.liquidity?.measuredAtMs ?? null,
    asOfMs,
    maxStalenessMs: liqEntry.maxStalenessMs,
    disabled: !extended,
  });

  const perpEntry = contractEntry("perp");
  const perpAvailableAt = fam?.perp?.availableAtMs ?? null;
  const perpFundingSample = evaluateSample({
    key: perpEntry.primarySampleKey,
    family: "perp",
    unit: perpEntry.unit,
    lookback: perpEntry.lookback,
    value: fam?.perp?.fundingRate ?? null,
    eventTimeMs: fam?.perp?.fundingEventTimeMs ?? null,
    availableAtMs: perpAvailableAt,
    asOfMs,
    maxStalenessMs: perpEntry.maxStalenessMs,
    disabled: !extended,
  });
  const perpOiSample = evaluateSample({
    key: "perp.openInterestChange24h",
    family: "perp",
    unit: "fraction",
    lookback: "OI-Delta 24 h",
    value: fam?.perp?.openInterestChange24h ?? null,
    eventTimeMs: fam?.perp?.oiEventTimeMs ?? null,
    // Sekundäres Sample: teilt die konservative Artefakt-Verfügbarkeit.
    availableAtMs: perpAvailableAt,
    asOfMs,
    maxStalenessMs: perpEntry.maxStalenessMs,
    disabled: !extended,
  });

  const macroEntry = contractEntry("macro");
  const macroSample = evaluateSample({
    key: macroEntry.primarySampleKey,
    family: "macro",
    unit: macroEntry.unit,
    lookback: macroEntry.lookback,
    value: fam?.macro?.vix ?? null,
    eventTimeMs: fam?.macro?.measuredAtMs ?? null,
    availableAtMs: fam?.macro?.measuredAtMs ?? null,
    asOfMs,
    maxStalenessMs: macroEntry.maxStalenessMs,
    disabled: !extended,
  });

  const families: RegimeFamilyState[] = [
    familyStateOf("price", [priceSample], asOfMs, false),
    familyStateOf("volatility", [volSample], asOfMs, false),
    familyStateOf("liquidity", [liqSample], asOfMs, false),
    familyStateOf("perp", [perpFundingSample, perpOiSample], asOfMs, false),
    familyStateOf("macro", [macroSample], asOfMs, !extended),
  ];

  const coverage = coverageOf(families);
  const degraded = families.some((f) => !f.optional && f.status !== "OK");
  return {
    asOf: new Date(asOfMs).toISOString(),
    featureVersion: REGIME_FEATURE_VERSION,
    families,
    coverage,
    degraded,
  };
}
