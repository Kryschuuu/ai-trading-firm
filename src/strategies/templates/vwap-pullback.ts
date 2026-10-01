/**
 * STX-03-07 — Template: VWAP-Bias, Snapshot-Variante (Phase 3,
 * Paket 03-02 / 01-01 · Finding STX-18).
 *
 * ── Was dieses Template ist — und was der Name nicht versprechen darf ──────
 * Trotz der aus der Roadmap übernommenen stabilen ID `vwap-pullback` ist dies
 * KEIN Pullback- oder Reclaim-Signal. Die vier Bedingungen sehen nur den
 * aktuellen Snapshot: long, wenn der Tag über dem VWAP und im Aufwärtstrend
 * läuft, bestätigt durch EMA 21 und Volumen. Fachlich ist das ein
 * Tages-Trend-Bias und trägt deshalb die ADR-E1-Klasse `trend`. Eine ehrlichere
 * neue ID wäre `vwap-trend-bias`; sie wird hier nicht eingeführt, weil
 * `vwap-pullback` bereits Teil der geschlossenen, roadmap- und artefaktstabilen
 * Template-ID-Union ist. Name und Beschreibung kennzeichnen die Einschränkung
 * daher ausdrücklich, statt eine nicht implementierte Sequenz zu behaupten.
 *
 * ── Warum nur 5m/15m/1h, insbesondere weder 4h noch 1d ─────────────────────
 * `vwapPct` ist gegen den Session-VWAP benannt, seine technische Session ist
 * aber der UTC-Kalendertag der letzten Kerze (`utcDayAnchorMs`). Das ist für
 * US-Equities ein bekannter Versatz gegenüber der Börsen-Session, kein Bug.
 * Auf `1d` enthält der UTC-Tagesanker exakt eine Kerze; nach 01-01 ist
 * `vwapPct` dort folgerichtig null. Auch `4h` liefert pro UTC-Tag zu wenige,
 * stark an den UTC-Grenzen hängende Beobachtungen für diesen Bias. Deshalb
 * sind beide ausgeschlossen. `VWAP_PCT_RELIABLE_TIMEFRAMES` dokumentiert die
 * konservative Intraday-Menge, gegen die Tests die unterstützten Takte prüfen.
 *
 * ── Warum der echte Pullback ein eigener Audit ist ─────────────────────────
 * Ein echter Pullback/Reclaim braucht die zeitliche Sequenz
 * `price_below_vwap` → `price_reclaims_vwap`: Der Executor müsste sich über
 * mehrere Bars merken, ob und wann der Kurs zuvor unter dem VWAP lag. Der
 * heutige `compileRuleSpec()`-Evaluator ist eine zustandslose Closure über
 * genau einen Snapshot. Sequenz-Zustand im MicroExecutor berührt dessen
 * Lebensdauer sowie Stops, Cooldowns und `maxExecutionsPerDay` und braucht
 * eigene Regressionstests. Das ist der eigene Audit STX-18 — bewusst kein
 * `RuleTrigger`, `CROSS` oder `RECLAIM` und keine vergessene Funktion hier.
 *
 * `buildRule` bleibt eine pure Parameterfunktion. Symbol und gewählter
 * unterstützter Timeframe kommen vom Aufrufer; anschließend ist
 * `sanitizeRuleSpec()` Pflicht. `takeProfitRR` hat kein Regelfeld und verweist
 * nur wegen des bestehenden ParamSpec-Vertrags dokumentarisch auf `atrPct`.
 */

import { RULE_ALLOWED_SIDE } from "@/lib/ruleEngine";
import type { RuleField, RuleSpecInput } from "@/lib/ruleEngine";
import type { SupportedTimeframe } from "@/lib/marketdata/historicalStore";

import type { ParamSpec, StrategyAssumption, StrategyTemplate } from "../types";

export const VWAP_PULLBACK_ID = "vwap-pullback" as const;
export const VWAP_PULLBACK_VERSION = 1 as const;

export type VwapPullbackParamKey =
  | "vwapMinPct"
  | "ema21BufferPct"
  | "volumeRatioMin"
  | "stopLossPct"
  | "takeProfitRR";

/**
 * Konservative Takte, auf denen ein UTC-Tages-VWAP genügend Intraday-Punkte
 * besitzen kann. Das ist eine Daten-Eignungsmenge, nicht die Template-Auswahl.
 */
export const VWAP_PCT_RELIABLE_TIMEFRAMES = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
] as const satisfies readonly SupportedTimeframe[];

export const VWAP_PULLBACK_TIMEFRAMES = [
  "5m",
  "15m",
  "1h",
] as const satisfies readonly (typeof VWAP_PCT_RELIABLE_TIMEFRAMES)[number][];

export const VWAP_PULLBACK_PARAMS: Readonly<Record<VwapPullbackParamKey, ParamSpec>> = {
  vwapMinPct: {
    key: "vwapMinPct",
    kind: "threshold",
    label: "Kurs mind. über VWAP",
    unit: "%",
    default: 0.1,
    min: -0.5,
    max: 2,
    step: 0.05,
    mapsTo: "vwapPct",
  },
  ema21BufferPct: {
    key: "ema21BufferPct",
    kind: "threshold",
    label: "Kurs über EMA 21",
    unit: "%",
    default: 0.1,
    min: -1,
    max: 3,
    step: 0.1,
    mapsTo: "priceVsEma21Pct",
  },
  volumeRatioMin: {
    key: "volumeRatioMin",
    kind: "threshold",
    label: "Volumenverhältnis",
    unit: "ratio",
    default: 1.1,
    min: 0.8,
    max: 2.5,
    step: 0.05,
    mapsTo: "volumeRatio",
  },
  stopLossPct: {
    key: "stopLossPct",
    kind: "threshold",
    label: "Stop-Loss",
    unit: "%",
    default: 3,
    min: 0.5,
    max: 10,
    step: 0.25,
    mapsTo: "atrPct",
  },
  takeProfitRR: {
    key: "takeProfitRR",
    kind: "ratio",
    label: "Chance/Risiko",
    unit: "ratio",
    default: 2,
    min: 1,
    max: 4,
    step: 0.25,
    // Kein eigenes Regelfeld; dokumentarischer Risikobezug.
    mapsTo: "atrPct",
  },
};

export const VWAP_PULLBACK_DEFAULTS: Readonly<Record<VwapPullbackParamKey, number>> = Object.fromEntries(
  (Object.keys(VWAP_PULLBACK_PARAMS) as VwapPullbackParamKey[]).map((key) => [
    key,
    VWAP_PULLBACK_PARAMS[key].default,
  ]),
) as Readonly<Record<VwapPullbackParamKey, number>>;

const REQUIRED_FIELDS: readonly RuleField[] = [
  "trend",
  "vwapPct",
  "volumeRatio",
  "priceVsEma21Pct",
  "atrPct",
];

const ASSUMPTIONS: readonly StrategyAssumption[] = [
  {
    id: "utc-tag-statt-boersensession",
    statement:
      "vwapPct ist am UTC-Kalendertag verankert, nicht an der Börsen-Session; für US-Equities ist das ein bekannter Versatz.",
    category: "DATA",
    critical: true,
  },
  {
    id: "fortsetzung-ueber-vwap",
    statement:
      "Kurse über dem Session-VWAP handeln im Tagesverlauf häufiger weiter; das ist eine Marktthese, keine Pullback-Bestätigung.",
    category: "MARKET",
    critical: false,
  },
  {
    id: "historischer-vwap-kein-fill",
    statement:
      "Der VWAP ist eine historische Größe; er sagt nichts über den Ausführungskurs aus. Der Bid/Ask-Spread ist separat über spreadPct zu messen.",
    category: "EXECUTION",
    critical: true,
  },
  {
    id: "intraday-kosten",
    statement:
      "Intraday-Handel macht die Gebühren- und Slippage-Annahme zur kritischsten Kostenannahme dieses Templates.",
    category: "COST",
    critical: true,
  },
  {
    id: "snapshot-kein-reclaim",
    statement:
      "Die Regel prüft nur den aktuellen Tages-Bias. Ein echter Pullback/Reclaim benötigt Sequenz-Zustand über mehrere Bars im Executor und ist der eigene Audit STX-18.",
    category: "DATA",
    critical: true,
  },
];

function paramValue(params: Readonly<Record<string, number>>, key: VwapPullbackParamKey): number {
  const raw: unknown = params[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(
      `vwap-pullback: Parameter „${key}“ fehlt oder ist keine endliche Zahl ` +
        `(ist ${raw === null ? "null" : Array.isArray(raw) ? "Array" : typeof raw}).`,
    );
  }
  return raw;
}

function num(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** Reine Snapshot-Regel; weder Pullback-Sequenz noch Executor-Zustand. */
export function vwapPullbackRule(params: Readonly<Record<string, number>>): RuleSpecInput {
  const vwapMinPct = paramValue(params, "vwapMinPct");
  const ema21BufferPct = paramValue(params, "ema21BufferPct");
  const volumeRatioMin = paramValue(params, "volumeRatioMin");
  const stopLossPct = paramValue(params, "stopLossPct");
  const takeProfitRR = paramValue(params, "takeProfitRR");

  return {
    name: `${VWAP_PULLBACK_ID} v${VWAP_PULLBACK_VERSION}`,
    missionId: null,
    condition: {
      logic: "all",
      conditions: [
        { field: "trend", op: "eq", value: "UP" },
        { field: "vwapPct", op: "gte", value: vwapMinPct },
        { field: "priceVsEma21Pct", op: "gte", value: ema21BufferPct },
        { field: "volumeRatio", op: "gte", value: volumeRatioMin },
      ],
    },
    action: {
      side: RULE_ALLOWED_SIDE,
      stopLossPct,
      takeProfitRR,
      riskBudgetPct: 0.01,
      maxPositionPct: 0.15,
      positionSizeMode: "risk",
    },
    window: {
      timeframe: "15m",
      validFrom: null,
      validUntil: null,
      maxExecutionsPerDay: 3,
      cooldownMinutes: 120,
      volumeWindow: 20,
    },
    rationale:
      `VWAP-Trend-Bias long (Snapshot, kein Pullback): Trend UP, Kurs mindestens ${num(vwapMinPct)} % ` +
      `über UTC-Tages-VWAP und ${num(ema21BufferPct)} % über EMA 21, Volumen mindestens ` +
      `${num(volumeRatioMin)}× des 20er-Schnitts. Stop ${num(stopLossPct)} %, Ziel ` +
      `${num(takeProfitRR)}× Chance/Risiko.`,
    sourceRole: "RESEARCH",
    riskScore: 0.5,
  };
}

export function buildVwapPullback(): StrategyTemplate {
  return {
    id: VWAP_PULLBACK_ID,
    name: "VWAP-Trend-Bias (Snapshot, kein Pullback)",
    description:
      "Intraday-Long-Bias über UTC-Tages-VWAP im Aufwärtstrend, bestätigt durch EMA 21 und Volumen. " +
      "Trotz stabiler ID keine Pullback-/Reclaim-Sequenz und kein zustandsbehafteter Trigger.",
    version: VWAP_PULLBACK_VERSION,
    class: "trend",
    scope: "SINGLE_SYMBOL",
    supportedTimeframes: VWAP_PULLBACK_TIMEFRAMES,
    requiredFields: REQUIRED_FIELDS,
    params: VWAP_PULLBACK_PARAMS,
    buildRule: vwapPullbackRule,
    assumptions: ASSUMPTIONS,
    expectedRegimes: ["TREND_UP"],
  };
}
