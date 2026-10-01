/**
 * STX-03-10 — Template-Vertragstests + Katalog-Vollständigkeit (Phase 3, Gate).
 *
 * Diese Datei ist die **Abnahme der Phase 3**: Sie macht aus sechs
 * kompilierbaren Templates einen abgesicherten Vertrag. Ein Template, das
 * seine eigenen Zusagen bricht (unzulässige Felder, Bounds-Verletzungen,
 * Deckungsgleichheit mit der Engine), fällt hier durch — nicht erst im
 * Live-Pfad.
 *
 * ── Was geprüft wird (Auftrag 03-10) ───────────────────────────────────────
 * 1. Struktur-Invarianten über `validateTemplate` hinaus (Params-Raster,
 *    Feld-Whitelist, Klassen-/Regime-Vokabular, ADR-008-Kontrakt-Invariante,
 *    Annahmen-Eindeutigkeit + mindestens eine kritische Annahme).
 * 2. Compiler-Parität: Defaults kompilieren **ohne** Klemmung, derselbe Aufruf
 *    ist fingerprint-stabil, `symbol` kommt vom Aufrufer, `sourceRole` ist
 *    immer `RESEARCH`.
 * 3. Snapshot-Kompatibilität: pro Template und **jedem** unterstützten
 *    Timeframe eine deterministische Positiv-Fixture (mindestens ein Entry)
 *    und eine Kurzhistorie-Fixture, in der ein tragendes Feld `null` ist —
 *    dort bleibt `backtestRule` inert (fail-closed).
 * 4. Negativ-Fixtures: jede einzelne Bedingung ist tragend (ein verletztes
 *    Feld ⇒ kein Entry), der Schwellwert am Raster-Extremwert blockiert, und
 *    ein `null`-Feld blockiert (der wichtigste Einzelfall).
 * 5. Katalog-Integrität: genau die sechs erwarteten IDs, keine Duplikate,
 *    Import-Zeit-Prüfung, `getTemplate` liefert `null` statt zu werfen,
 *    `templateByField` für die beiden Phase-2-Felder.
 * 6. Engine-↔-Cache-Parität als Phase-2-Regression (02-02/02-03): beide
 *    Snapshot-Pfade liefern auf identischen Kerzen **exakt** dieselben Werte.
 * 7. Zeitrahmen-Disziplin (STX-01): `vwapPct`-Templates ohne `1d`.
 *
 * ── Abgrenzung ─────────────────────────────────────────────────────────────
 * Kein Produktivcode: die Tests lesen nur (`catalog`, `compiler`, `ruleEngine`,
 * `indicatorCache`). Keine DB, kein Netz, keine Zeitabhängigkeit — die Fixtures
 * sind reine, hier definierte Kerzenreihen (Muster `tests/backtest.unit.test.ts`).
 * Auch die Doku-Tabelle `docs/STRATEGY_TEMPLATES.md` wird hier gegen den
 * Generator geprüft, damit sie nicht vom Code wegdriftet.
 *
 * ── Fixture-Notiz ──────────────────────────────────────────────────────────
 * `backtestRule` zählt mit `signals` die **Entries** (Signal am Kerzenschluss);
 * `trades` sind abgeschlossene Trades. Eine Positiv-Fixture kann daher
 * `signals > 0` und `trades === 0` liefern, wenn die Position am Reihenende
 * noch offen ist — geprüft wird deshalb der Entry, nicht der Abschluss.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  STRATEGY_TEMPLATE_IDS,
  STRATEGY_TEMPLATES,
  assertTemplatesValid,
  getTemplate,
  templateByField,
  validateTemplate,
} from "../src/strategies/catalog";
import type { StrategyTemplateId } from "../src/strategies/catalog";
import { compileTemplate } from "../src/strategies/compiler";
import type { ParamSpec, StrategyTemplate } from "../src/strategies/types";
import { DEFAULT_CLASS_POLICIES, STRATEGY_CLASS_KEYS } from "../src/lib/signalDecay";
import { MARKET_REGIME_SEVERITY, regimeGateFactor } from "../src/lib/marketRegime";
import type { MarketRegime, StrategyClass } from "../src/lib/marketRegime";
import { RULE_FIELDS } from "../src/lib/ruleFieldCatalog";
import {
  RULE_CEILINGS,
  backtestRule,
  buildSnapshotFromCandles,
  compileRuleSpec,
} from "../src/lib/ruleEngine";
import type { CandleLike, RuleSnapshot, RuleSpec } from "../src/lib/ruleEngine";
import { SUPPORTED_TIMEFRAMES, SUPPORTED_TIMEFRAME_MS } from "../src/lib/marketdata/timeframes";
import type { SupportedTimeframe } from "../src/lib/marketdata/timeframes";
import { buildIndicatorCache, snapshotFromCache } from "../src/backtest/indicatorCache";
import { VWAP_PCT_RELIABLE_TIMEFRAMES } from "../src/strategies/templates/vwap-pullback";
import { renderStrategyTemplatesDoc } from "../scripts/gen-strategy-templates-doc";

// ─────────────────────────────────────────────────────────────────────────────
// Test-Vokabular (gelesen, nicht kopiert)
// ─────────────────────────────────────────────────────────────────────────────

/** Die sechs erwarteten Artefakte — Erwartung des Tests, nicht des Katalogs. */
const EXPECTED_TEMPLATE_IDS = [
  "ema-adx-trend",
  "macd-momentum",
  "rsi-mean-reversion",
  "bollinger-squeeze",
  "vwap-pullback",
  "donchian-breakout",
] as const satisfies readonly StrategyTemplateId[];

/** Die fünf `MarketRegime`-Werte (ADR-009) — abgeleitet, ohne `UNKNOWN`. */
const MARKET_REGIMES: readonly MarketRegime[] = Object.keys(MARKET_REGIME_SEVERITY) as MarketRegime[];

/**
 * Felder, die im Snapshot **wirklich** `null` sein können (Typ `number | null`
 * in `RuleSnapshot`). Nur für diese ist der fail-closed-Null-Test aussagekräftig
 * — „Feld auf null gesetzt (wo das Feld null sein kann)“.
 */
const NULLABLE_SNAPSHOT_FIELDS: ReadonlySet<string> = new Set([
  "atrPct",
  "adx14",
  "bbwPct",
  "bbZScore",
  "priceVsUpperBbPct",
  "priceVsLowerBbPct",
  "donchianBreakoutPct",
  "macd",
  "macdSignal",
  "macdHist",
  "vwapPct",
  "spreadPct",
  "bookDepthUsd",
  "changePct24h",
]);

const RULE_FIELD_NAMES: ReadonlySet<string> = new Set(Object.keys(RULE_FIELDS));

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures: deterministische Kerzenreihen (keine Zufallszahlen, keine Uhrzeit)
// ─────────────────────────────────────────────────────────────────────────────

/** UTC-Anker der Reihe (`2026-01-01T00:00:00Z`) — fix, damit nichts „heute“ ist. */
const SERIES_START_MS = Date.UTC(2026, 0, 1);
const DEFAULT_RANGE_PCT = 0.1;

interface SeriesShape {
  bars: number;
  closeAt: (index: number) => number;
  volumeAt?: (index: number, bars: number) => number;
  rangePct?: number;
  /** Letzte Kerze exakt auf eine UTC-Mitternacht legen (VWAP-Tag mit 1 Kerze). */
  lastBarAtUtcMidnight?: boolean;
}

/**
 * Baut eine Kerzenreihe aus einer reinen Kursfunktion. `open` ist der
 * Vorschluss, High/Low liegen symmetrisch um `rangePct` Prozent — dadurch sind
 * die Reihen vollständig deterministisch und für alle Timeframes gleich
 * (die Form ist pro Bar definiert, der Takt kommt aus `SUPPORTED_TIMEFRAME_MS`).
 */
function buildSeries(timeframe: SupportedTimeframe, shape: SeriesShape): CandleLike[] {
  const stepMs = SUPPORTED_TIMEFRAME_MS[timeframe];
  const rangePct = shape.rangePct ?? DEFAULT_RANGE_PCT;
  const volumeAt = shape.volumeAt ?? ((index: number, bars: number) => (index === bars - 1 ? 200 : 100));

  const lastTime = shape.lastBarAtUtcMidnight
    ? Math.floor((SERIES_START_MS + (shape.bars - 1) * stepMs) / 86_400_000) * 86_400_000
    : SERIES_START_MS + (shape.bars - 1) * stepMs;

  const out: CandleLike[] = [];
  for (let i = 0; i < shape.bars; i++) {
    const close = shape.closeAt(i);
    const previous = i === 0 ? close : shape.closeAt(i - 1);
    out.push({
      time: lastTime - (shape.bars - 1 - i) * stepMs,
      open: previous,
      high: close * (1 + rangePct / 100),
      low: close * (1 - rangePct / 100),
      close,
      volume: volumeAt(i, shape.bars),
    });
  }
  return out;
}

/**
 * Positiv-Fixture der Trend-/Ausbruch-/Squeeze-/VWAP-Templates: eine moderate
 * Aufwärtsbewegung (Drift + ruhige Oszillation) mit Volumenbestätigung auf der
 * letzten Kerze. Bewusst „moderat“: ADX, Bandbreite und Volumenverhältnis
 * liegen innerhalb der Parameterraster, sonst würde der Extremwert-Test
 * (Negativ-Fixture 2) nicht greifen.
 */
const moderateUptrend = (timeframe: SupportedTimeframe): CandleLike[] =>
  buildSeries(timeframe, {
    bars: 140,
    closeAt: (i) => 100 * (1 + 0.0012 * i + 0.008 * Math.sin((2 * Math.PI * i) / 6)),
  });

/** Wie oben, aber **fallendes** Volumen: das Volumenverhältnis ist an jeder Kerze < 1. */
const moderateUptrendWithFallingVolume = (timeframe: SupportedTimeframe): CandleLike[] =>
  buildSeries(timeframe, {
    bars: 140,
    closeAt: (i) => 100 * (1 + 0.0012 * i + 0.008 * Math.sin((2 * Math.PI * i) / 6)),
    volumeAt: (i) => 200 - i,
  });

/** Spiegelbild der Aufwärtsbewegung — MACD-Histogramm und EMA-50-Lage kippen. */
const mirroredDecline = (timeframe: SupportedTimeframe): CandleLike[] =>
  buildSeries(timeframe, {
    bars: 140,
    closeAt: (i) => 100 * (1 - 0.0012 * i - 0.008 * Math.sin((2 * Math.PI * i) / 6)),
  });

/**
 * Positiv-Fixture `rsi-mean-reversion`: ruhige Seitwärtsbewegung (ADX bleibt
 * niedrig) und ein kurzer, tiefer Dip am Ende (RSI überverkauft, Kurs unter
 * dem EMA 21) mit Volumenbestätigung.
 */
const rangeThenDip = (timeframe: SupportedTimeframe): CandleLike[] => {
  const bars = 120;
  const dipBars = 4;
  const dipPct = 0.008;
  const amplitude = 0.002;
  const dipStart = bars - dipBars;
  const flat = (i: number) => 100 * (1 + (i % 2 === 0 ? amplitude : -amplitude));
  return buildSeries(timeframe, {
    bars,
    rangePct: 0.15,
    closeAt: (i) => {
      if (i < dipStart) return flat(i);
      let value = flat(dipStart - 1);
      for (let k = dipStart; k <= i; k++) value *= 1 - dipPct;
      return value;
    },
  });
};

/**
 * Kurzhistorie-Fixture (28 Kerzen, `< 29` ⇒ `adx14` ist `null`). Für
 * `vwap-pullback` zusätzlich mit der letzten Kerze auf UTC-Mitternacht: der
 * UTC-Tag der letzten Kerze enthält dann genau **eine** Beobachtung, und
 * `vwapPct` ist `null` (nie eine erfundene 0).
 */
const shortHistory = (timeframe: SupportedTimeframe, lastBarAtUtcMidnight = false): CandleLike[] =>
  buildSeries(timeframe, {
    bars: 28,
    lastBarAtUtcMidnight,
    closeAt: (i) => 100 * (1 + 0.001 * i),
  });

// ─────────────────────────────────────────────────────────────────────────────
// Fall-Tabelle: ein Eintrag je Template (die Tests laufen darüber)
// ─────────────────────────────────────────────────────────────────────────────

interface TemplateCase {
  id: StrategyTemplateId;
  /** Positiv-Fixture: erfüllt die Bedingungen (mindestens ein Entry). */
  positive: (timeframe: SupportedTimeframe) => CandleLike[];
  /** Kurzhistorie-Fixture: `nullField` ist darin auf der Signalkerze `null`. */
  nullFixture: (timeframe: SupportedTimeframe) => CandleLike[];
  /** Tragendes Feld, das in der Kurzhistorie `null` ist. */
  nullField: string;
  /** Fixture, in der genau eine Bedingung an keiner Kerze erfüllbar ist. */
  oneFieldShort: (timeframe: SupportedTimeframe) => CandleLike[];
  /** Warum diese Fixture die Bedingung dauerhaft verletzt. */
  oneFieldShortNote: string;
  /** Parameter am Raster-Extremwert in der harten Richtung (blockiert). */
  extremeParams: Readonly<Record<string, number>>;
  /** Begründung des Extremwerts. */
  extremeNote: string;
}

const CASES: readonly TemplateCase[] = [
  {
    id: "ema-adx-trend",
    positive: moderateUptrend,
    nullFixture: shortHistory,
    nullField: "adx14",
    oneFieldShort: moderateUptrendWithFallingVolume,
    oneFieldShortNote: "fallendes Volumen ⇒ `volumeRatio` < 1 an jeder Kerze (Bedingung `gte 1`)",
    extremeParams: { adxMin: 35 },
    extremeNote: "`adxMin` am Rastermaximum (35) — die Fixture bleibt darunter",
  },
  {
    id: "macd-momentum",
    positive: moderateUptrend,
    nullFixture: shortHistory,
    nullField: "macdHist",
    oneFieldShort: mirroredDecline,
    oneFieldShortNote: "gespiegelte Abwärtsbewegung ⇒ `macdHist > 0`/`priceVsEma50Pct > 0` nie erfüllt",
    extremeParams: { adxMin: 35 },
    extremeNote: "`adxMin` am Rastermaximum (35) — die Fixture bleibt darunter",
  },
  {
    id: "rsi-mean-reversion",
    positive: rangeThenDip,
    nullFixture: shortHistory,
    nullField: "adx14",
    oneFieldShort: moderateUptrend,
    oneFieldShortNote: "Aufwärtsbewegung ⇒ `rsi14 lte 30` und `priceVsEma21Pct lte -1` unerreichbar",
    extremeParams: { rsiOversold: 15 },
    extremeNote: "`rsiOversold` am Rasterminimum (15) — der Dip erreicht nur ~29",
  },
  {
    id: "bollinger-squeeze",
    positive: moderateUptrend,
    nullFixture: shortHistory,
    nullField: "adx14",
    oneFieldShort: moderateUptrendWithFallingVolume,
    oneFieldShortNote: "fallendes Volumen ⇒ `volumeRatio` < 1.2 an jeder Kerze",
    extremeParams: { bbwMaxPct: 2 },
    extremeNote: "`bbwMaxPct` am Rasterminimum (2) — die Fixture bleibt darüber",
  },
  {
    id: "vwap-pullback",
    positive: moderateUptrend,
    nullFixture: (timeframe) => shortHistory(timeframe, true),
    nullField: "vwapPct",
    oneFieldShort: moderateUptrendWithFallingVolume,
    oneFieldShortNote: "fallendes Volumen ⇒ `volumeRatio` < 1.1 an jeder Kerze",
    extremeParams: { volumeRatioMin: 2.5 },
    extremeNote: "`volumeRatioMin` am Rastermaximum (2.5) — die Fixture bleibt darunter",
  },
  {
    id: "donchian-breakout",
    positive: moderateUptrend,
    // 28 Kerzen: `adx14` ist null (< 29). `donchianBreakoutPct` wäre erst unter
    // 21 Kerzen null — dort gibt es aber noch keinen Snapshot (Minimum 25);
    // die null-Semantik dieses Feldes prüft der Negativ-Block (Feld auf null).
    nullFixture: shortHistory,
    nullField: "adx14",
    oneFieldShort: moderateUptrendWithFallingVolume,
    oneFieldShortNote: "fallendes Volumen ⇒ `volumeRatio` < 1.2 an jeder Kerze",
    extremeParams: { breakoutMinPct: 3 },
    extremeNote: "`breakoutMinPct` am Rastermaximum (3) — die Fixture bleibt darunter",
  },
];

function caseOf(template: StrategyTemplate): TemplateCase {
  const found = CASES.find((entry) => entry.id === template.id);
  assert.ok(found, `Fixture-Fall für ${template.id} fehlt`);
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helfer
// ─────────────────────────────────────────────────────────────────────────────

/** Default-Parameter aus dem Template (SSoT ist das `ParamSpec`-Raster). */
function defaultParams(template: StrategyTemplate): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, spec] of Object.entries(template.params)) out[key] = spec.default;
  return out;
}

/** Kompiliert das Template mit den Aufrufer-Werten (Symbol/Takt) — wie 03-09. */
function compileSpec(
  template: StrategyTemplate,
  timeframe: SupportedTimeframe,
  params?: Readonly<Record<string, number>>,
  symbol = "BTC",
): RuleSpec {
  const result = compileTemplate({ templateId: template.id, symbol, timeframe, params });
  if (!result.ok) assert.fail(`${template.id}/${timeframe}: ${result.errors.join(" | ")}`);
  return result.spec;
}

/** Ein Snapshot mit gezielten Überschreibungen (Typ-Cast nur hier, dokumentiert). */
function snapshotWith(base: RuleSnapshot, overrides: Readonly<Record<string, unknown>>): RuleSnapshot {
  return { ...base, ...overrides } as unknown as RuleSnapshot;
}

/** Die Bedingungen der Builder-Rohform als einfache Liste. */
interface RawCondition {
  field: string;
  op: string;
  value: unknown;
}

function conditionsOf(template: StrategyTemplate): RawCondition[] {
  const built = template.buildRule(defaultParams(template)) as Record<string, unknown>;
  const condition = built.condition as { conditions?: unknown } | undefined;
  const items = Array.isArray(condition?.conditions) ? condition.conditions : [];
  return items.map((item) => {
    const record = item as Record<string, unknown>;
    return { field: String(record.field), op: String(record.op), value: record.value };
  });
}

/** Ein Wert, der die Bedingung erfüllt (Kontroll-Snapshot). */
function satisfyingValue(op: string, value: unknown): unknown {
  if (typeof value === "string") return value;
  if (typeof value !== "number") return value;
  switch (op) {
    case "gt":
    case "gte":
      return value + 1;
    case "lt":
    case "lte":
      return value - 1;
    default:
      return value;
  }
}

/** Ein Wert, der die Bedingung **knapp** verletzt (Grenze wirkt). */
function violatingValue(op: string, value: unknown): unknown {
  if (typeof value === "string") return value === "UP" ? "DOWN" : "__verletzt__";
  if (typeof value !== "number") return value;
  switch (op) {
    case "gt":
      // Gleichstand erfüllt „strikt größer“ nicht.
      return value;
    case "gte":
      return value - 1e-6;
    case "lt":
      return value;
    case "lte":
      return value + 1e-6;
    default:
      return value;
  }
}

/**
 * Baut aus einem echten Snapshot einen Snapshot, in dem **alle** Bedingungen
 * des Templates erfüllt sind (Kontrolle) — bzw. in dem genau ein Feld
 * verletzt/null ist (`targetField`).
 */
function withConditionValues(
  base: RuleSnapshot,
  conditions: readonly RawCondition[],
  mode: "satisfying" | "violating" | "null",
  targetField?: string,
): RuleSnapshot {
  const overrides: Record<string, unknown> = {};
  for (const condition of conditions) {
    const isTarget = targetField !== undefined && condition.field === targetField;
    if (!isTarget) {
      overrides[condition.field] = satisfyingValue(condition.op, condition.value);
      continue;
    }
    if (mode === "null") overrides[condition.field] = null;
    else if (mode === "violating") overrides[condition.field] = violatingValue(condition.op, condition.value);
    else overrides[condition.field] = satisfyingValue(condition.op, condition.value);
  }
  return snapshotWith(base, overrides);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) Strukturelle Invarianten
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-03-10 · Struktur-Invarianten (Vertrag über validateTemplate hinaus)", () => {
  test("validateTemplate liefert für jedes Katalog-Template []", () => {
    assert.equal(STRATEGY_TEMPLATES.length, 6);
    for (const template of STRATEGY_TEMPLATES) {
      assert.deepEqual(validateTemplate(template), [], `${template.id} verletzt den Template-Vertrag`);
    }
  });

  test("params erfüllen min ≤ default ≤ max und liegen auf dem step-Raster", () => {
    for (const template of STRATEGY_TEMPLATES) {
      for (const [key, spec] of Object.entries(template.params) as [string, ParamSpec][]) {
        assert.ok(
          spec.min <= spec.default && spec.default <= spec.max,
          `${template.id}.${key}: min ≤ default ≤ max verletzt (${spec.min}, ${spec.default}, ${spec.max})`,
        );
        assert.ok(spec.step > 0, `${template.id}.${key}: step muss > 0 sein`);
        const steps = (spec.default - spec.min) / spec.step;
        assert.ok(
          Math.abs(steps - Math.round(steps)) <= 1e-9,
          `${template.id}.${key}: default liegt nicht auf dem step-Raster (${steps} Schritte)`,
        );
        assert.equal(typeof spec.mapsTo, "string", `${template.id}.${key}: mapsTo fehlt`);
      }
    }
  });

  test("requiredFields und mapsTo stammen aus RULE_FIELDS", () => {
    for (const template of STRATEGY_TEMPLATES) {
      assert.ok(template.requiredFields.length > 0, `${template.id}: requiredFields ist leer`);
      for (const field of template.requiredFields) {
        assert.ok(RULE_FIELD_NAMES.has(field), `${template.id}: requiredFields enthält „${field}“ nicht in RULE_FIELDS`);
      }
      for (const [key, spec] of Object.entries(template.params)) {
        assert.ok(RULE_FIELD_NAMES.has(spec.mapsTo), `${template.id}.${key}: mapsTo „${spec.mapsTo}“ ist kein Regelfeld`);
      }
    }
  });

  test("class kommt aus STRATEGY_CLASS_KEYS und ist nie „unclassified“ (ADR-008)", () => {
    for (const template of STRATEGY_TEMPLATES) {
      assert.ok(
        (STRATEGY_CLASS_KEYS as readonly string[]).includes(template.class),
        `${template.id}: class „${template.class}“ ist kein Schlüssel aus STRATEGY_CLASS_KEYS`,
      );
      assert.notEqual(template.class, "unclassified", `${template.id}: unclassified ist kein Template-Status`);
    }
  });

  test("supportedTimeframes ist nicht leer, duplikatfrei und aus SUPPORTED_TIMEFRAMES", () => {
    for (const template of STRATEGY_TEMPLATES) {
      const timeframes = template.supportedTimeframes;
      assert.ok(timeframes.length > 0, `${template.id}: supportedTimeframes ist leer`);
      assert.equal(new Set(timeframes).size, timeframes.length, `${template.id}: Timeframe doppelt`);
      for (const timeframe of timeframes) {
        assert.ok(
          (SUPPORTED_TIMEFRAMES as readonly string[]).includes(timeframe),
          `${template.id}: „${timeframe}“ steht nicht in SUPPORTED_TIMEFRAMES`,
        );
      }
    }
  });

  test("expectedRegimes sind die fünf MarketRegime-Werte ohne UNKNOWN (ADR-009)", () => {
    assert.equal(MARKET_REGIMES.length, 5, "MARKET_REGIME_SEVERITY muss genau die fünf Regimes führen");
    for (const template of STRATEGY_TEMPLATES) {
      assert.ok(template.expectedRegimes.length > 0, `${template.id}: expectedRegimes ist leer`);
      assert.equal(
        new Set(template.expectedRegimes).size,
        template.expectedRegimes.length,
        `${template.id}: expectedRegimes enthält Duplikate`,
      );
      for (const regime of template.expectedRegimes) {
        assert.ok(MARKET_REGIMES.includes(regime), `${template.id}: „${regime}“ ist kein MarketRegime`);
      }
      assert.ok(
        !(template.expectedRegimes as readonly string[]).includes("UNKNOWN"),
        `${template.id}: UNKNOWN ist kein erwartetes Regime`,
      );
    }
  });

  test("Kontrakt-Invariante (ADR-008): Gate-Faktor für alle fünf Regimes + Decay-Policy vorhanden", () => {
    for (const template of STRATEGY_TEMPLATES) {
      // Nach den Zusagen oben ist die Klasse eine der drei Fachklassen.
      const strategyClass = template.class as StrategyClass;
      assert.ok(
        Object.prototype.hasOwnProperty.call(DEFAULT_CLASS_POLICIES, strategyClass),
        `${template.id}: DEFAULT_CLASS_POLICIES[${strategyClass}] fehlt`,
      );
      assert.ok(DEFAULT_CLASS_POLICIES[strategyClass].enabled !== undefined);
      for (const regime of MARKET_REGIMES) {
        const factor = regimeGateFactor(regime, strategyClass);
        assert.equal(typeof factor, "number", `${template.id}: regimeGateFactor(${regime}) ist undefiniert`);
        assert.ok(Number.isFinite(factor), `${template.id}: regimeGateFactor(${regime}) ist nicht endlich`);
        assert.ok(
          factor >= RULE_CEILINGS.riskBudgetPct[0] && factor <= 2,
          `${template.id}: regimeGateFactor(${regime}) liegt außerhalb [0, 2]`,
        );
      }
    }
  });

  test("assumptions: eindeutige IDs und mindestens eine kritische Annahme je Template", () => {
    for (const template of STRATEGY_TEMPLATES) {
      assert.ok(template.assumptions.length > 0, `${template.id}: assumptions ist leer`);
      const ids = template.assumptions.map((assumption) => assumption.id);
      assert.equal(new Set(ids).size, ids.length, `${template.id}: Annahmen-ID doppelt`);
      assert.ok(
        template.assumptions.some((assumption) => assumption.critical),
        `${template.id}: keine Annahme mit critical: true`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Compiler-Parität
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-03-10 · Compiler-Parität (Template → sanitizeRuleSpec → RuleSpec)", () => {
  test("Defaults kompilieren ohne Klemmung", () => {
    for (const template of STRATEGY_TEMPLATES) {
      for (const timeframe of template.supportedTimeframes) {
        const result = compileTemplate({ templateId: template.id, symbol: "BTC", timeframe });
        if (!result.ok) assert.fail(`${template.id}/${timeframe}: ${result.errors.join(" | ")}`);
        assert.deepEqual(result.clamped, [], `${template.id}/${timeframe}: Template klemmt`);
        assert.ok(Array.isArray(result.warnings), `${template.id}/${timeframe}: warnings fehlen`);
        assert.equal(result.strategyClass, template.class, `${template.id}: strategyClass muss die Artefakt-Klasse sein`);
      }
    }
  });

  test("derselbe Aufruf liefert denselben Fingerprint (Idempotenz)", () => {
    for (const template of STRATEGY_TEMPLATES) {
      const timeframe = template.supportedTimeframes[0];
      const first = compileTemplate({ templateId: template.id, symbol: "BTC", timeframe });
      const second = compileTemplate({ templateId: template.id, symbol: "BTC", timeframe });
      if (!first.ok || !second.ok) assert.fail(`${template.id}: Default-Kompilat fehlgeschlagen`);
      assert.equal(first.fingerprint, second.fingerprint, `${template.id}: Fingerprint ist nicht stabil`);
      assert.match(first.fingerprint, /^stc1:[0-9a-f]{64}$/, `${template.id}: Fingerprint-Format`);
      assert.deepEqual(first.spec, second.spec, `${template.id}: Spec ist nicht stabil`);
    }
  });

  test("symbol kommt vom Aufrufer, nie aus dem Template", () => {
    for (const template of STRATEGY_TEMPLATES) {
      const timeframe = template.supportedTimeframes[0];
      const withBtc = compileTemplate({ templateId: template.id, symbol: "BTC", timeframe });
      const withEth = compileTemplate({ templateId: template.id, symbol: "ETH", timeframe });
      if (!withBtc.ok || !withEth.ok) assert.fail(`${template.id}: Kompilat fehlgeschlagen`);
      assert.equal(withBtc.spec.symbol, "BTC", `${template.id}: Aufrufer-Symbol BTC ging verloren`);
      assert.equal(withEth.spec.symbol, "ETH", `${template.id}: Aufrufer-Symbol ETH ging verloren`);
      assert.notEqual(withBtc.fingerprint, withEth.fingerprint, `${template.id}: Symbol gehört in den Fingerprint`);

      // Die Rohform des Builders kennt kein Symbol — der Aufrufer setzt es.
      const raw = template.buildRule(defaultParams(template)) as Record<string, unknown>;
      assert.equal(raw.symbol, undefined, `${template.id}: buildRule darf kein symbol mitbringen`);
    }
  });

  test("sourceRole ist für Templates immer RESEARCH (nie MANUAL)", () => {
    for (const template of STRATEGY_TEMPLATES) {
      for (const timeframe of template.supportedTimeframes) {
        const spec = compileSpec(template, timeframe);
        assert.equal(spec.sourceRole, "RESEARCH", `${template.id}/${timeframe}: sourceRole muss RESEARCH sein`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) Snapshot-Kompatibilität über alle unterstützten Timeframes
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-03-10 · Snapshot-Kompatibilität (deterministische Fixtures je Template)", () => {
  for (const template of STRATEGY_TEMPLATES) {
    test(`${template.id}: Positiv-Fixture erzeugt mindestens einen Entry`, () => {
      const fixture = caseOf(template);
      const evaluator = compileRuleSpec(compileSpec(template, template.supportedTimeframes[0]));

      for (const timeframe of template.supportedTimeframes) {
        const candles = fixture.positive(timeframe);
        // Determinismus: dieselbe Reihe, dieselbe Bewertung (kein Zufall, keine Uhrzeit).
        const first = backtestRule(compileSpec(template, timeframe), candles, { warmup: 30 });
        const second = backtestRule(compileSpec(template, timeframe), candles, { warmup: 30 });
        assert.deepEqual(first, second, `${template.id}/${timeframe}: Backtest ist nicht deterministisch`);
        assert.ok(
          first.signals >= 1,
          `${template.id}/${timeframe}: totes Template — kein Entry auf der Positiv-Fixture`,
        );
        assert.equal(first.bars, candles.length, `${template.id}/${timeframe}: Backtest lief nicht über die Fixture`);
        assert.equal(first.stats.trades, first.trades.length, `${template.id}/${timeframe}: Trade-Zählung inkonsistent`);
        for (const trade of first.trades) {
          assert.equal(trade.side, "LONG", `${template.id}/${timeframe}: nur LONG ist erlaubt`);
        }
      }

      // Kontrolle: Die Fixture ist nicht nur „irgendwie“ handelbar — der
      // Bedingungssatz selbst feuert auf einer bewerteten Kerze.
      const candles = fixture.positive(template.supportedTimeframes[0]);
      let fired = 0;
      for (let i = 24; i < candles.length; i++) {
        const snapshot = buildSnapshotFromCandles("BTC", candles.slice(0, i + 1), 20);
        if (snapshot && evaluator.evaluate(snapshot)) fired += 1;
      }
      assert.ok(fired > 0, `${template.id}: keine bewertete Kerze erfüllt die Template-Bedingungen`);
    });

    test(`${template.id}: null-Feld (zu wenig Historie) bleibt inert`, () => {
      const fixture = caseOf(template);
      assert.ok(
        NULLABLE_SNAPSHOT_FIELDS.has(fixture.nullField),
        `${template.id}: ${fixture.nullField} muss ein nullable-Snapshot-Feld sein`,
      );

      for (const timeframe of template.supportedTimeframes) {
        const candles = fixture.nullFixture(timeframe);
        const spec = compileSpec(template, timeframe);
        const evaluator = compileRuleSpec(spec);

        // Kein Entry — weder offen noch abgeschlossen.
        const result = backtestRule(spec, candles, { warmup: 0 });
        assert.equal(result.signals, 0, `${template.id}/${timeframe}: Entry trotz fehlender Historie`);
        assert.equal(result.trades.length, 0, `${template.id}/${timeframe}: Trade trotz fehlender Historie`);

        // Snapshot-Ebene: jede bewertete Kerze bleibt blockiert …
        for (let i = 24; i < candles.length; i++) {
          const snapshot = buildSnapshotFromCandles("BTC", candles.slice(0, i + 1), 20);
          assert.ok(snapshot, `${template.id}/${timeframe}: Snapshot ab 25 Kerzen erwartet`);
          assert.equal(evaluator.evaluate(snapshot), false, `${template.id}/${timeframe} idx=${i}: Bedingung trotz null offen`);
        }

        // … und die Signalkerze trägt wirklich das `null`-Feld.
        const last = buildSnapshotFromCandles("BTC", candles, 20);
        assert.ok(last, `${template.id}/${timeframe}: Snapshot der Signalkerze fehlt`);
        assert.equal(last[fixture.nullField as keyof RuleSnapshot], null, `${template.id}/${timeframe}: ${fixture.nullField} ist nicht null`);

        // Kontrolle: Wären die Lesewerte vorhanden und erfüllt, würde die Regel feuern.
        const control = withConditionValues(last, conditionsOf(template), "satisfying");
        assert.equal(evaluator.evaluate(control), true, `${template.id}/${timeframe}: Kontroll-Snapshot feuert nicht`);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) Negativ-Fixtures je Template
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-03-10 · Negativ-Fixtures (jede Bedingung ist tragend)", () => {
  for (const template of STRATEGY_TEMPLATES) {
    test(`${template.id}: ein um ein Feld verletzter Snapshot erzeugt keinen Entry`, () => {
      const spec = compileSpec(template, template.supportedTimeframes[0]);
      const evaluator = compileRuleSpec(spec);
      const conditions = conditionsOf(template);
      assert.ok(conditions.length > 0, `${template.id}: Builder erzeugt keine Bedingung`);

      const base = buildSnapshotFromCandles("BTC", caseOf(template).positive(template.supportedTimeframes[0]), 20);
      assert.ok(base, `${template.id}: Basis-Snapshot fehlt`);

      const control = withConditionValues(base, conditions, "satisfying");
      assert.equal(evaluator.evaluate(control), true, `${template.id}: Kontroll-Snapshot feuert nicht`);

      for (const condition of conditions) {
        const broken = withConditionValues(base, conditions, "violating", condition.field);
        assert.equal(
          evaluator.evaluate(broken),
          false,
          `${template.id}: Bedingung „${condition.field} ${condition.op}“ wirkt nicht — verletztes Feld feuert trotzdem`,
        );
      }
    });

    test(`${template.id}: Feld auf null (wo es null sein kann) blockiert fail-closed`, () => {
      const evaluator = compileRuleSpec(compileSpec(template, template.supportedTimeframes[0]));
      const conditions = conditionsOf(template);
      const base = buildSnapshotFromCandles("BTC", caseOf(template).positive(template.supportedTimeframes[0]), 20);
      assert.ok(base, `${template.id}: Basis-Snapshot fehlt`);

      const nullableConditions = conditions.filter((condition) => NULLABLE_SNAPSHOT_FIELDS.has(condition.field));
      assert.ok(nullableConditions.length > 0, `${template.id}: keine nullable-Bedingung — Test wäre blind`);
      for (const condition of nullableConditions) {
        const nulled = withConditionValues(base, conditions, "null", condition.field);
        assert.equal(
          evaluator.evaluate(nulled),
          false,
          `${template.id}: null in „${condition.field}“ blockiert nicht (fail-closed verletzt)`,
        );
      }
    });

    test(`${template.id}: Schwellwert am Raster-Extremwert blockiert am Serien-Fixture`, () => {
      const fixture = caseOf(template);
      for (const timeframe of template.supportedTimeframes) {
        const series = fixture.positive(timeframe);
        const extreme = compileTemplate({
          templateId: template.id,
          symbol: "BTC",
          timeframe,
          params: fixture.extremeParams,
        });
        if (!extreme.ok) assert.fail(`${template.id}/${timeframe}: Extremwert-Kompilat fehlgeschlagen`);
        const result = backtestRule(extreme.spec, series, { warmup: 30 });
        assert.equal(
          result.signals,
          0,
          `${template.id}/${timeframe}: ${fixture.extremeNote} — Bedingung greift nicht (${JSON.stringify(fixture.extremeParams)})`,
        );
      }
    });

    test(`${template.id}: eine durchgängig verletzte Einzelbedingung erzeugt keinen Entry`, () => {
      const fixture = caseOf(template);
      for (const timeframe of template.supportedTimeframes) {
        const result = backtestRule(compileSpec(template, timeframe), fixture.oneFieldShort(timeframe), { warmup: 30 });
        assert.equal(
          result.signals,
          0,
          `${template.id}/${timeframe}: ${fixture.oneFieldShortNote} — trotzdem ein Entry`,
        );
        assert.equal(result.trades.length, 0, `${template.id}/${timeframe}: Trade trotz verletzter Bedingung`);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) Katalog-Integrität
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-03-10 · Katalog-Integrität", () => {
  test("STRATEGY_TEMPLATES enthält genau die sechs erwarteten IDs, keine Duplikate", () => {
    assert.deepEqual(
      STRATEGY_TEMPLATE_IDS,
      EXPECTED_TEMPLATE_IDS,
      "die geschlossene ID-Union muss der Erwartung des Gates entsprechen",
    );
    const ids = STRATEGY_TEMPLATES.map((template) => template.id);
    assert.equal(ids.length, 6, "der Katalog muss genau sechs Templates führen");
    assert.equal(new Set(ids).size, ids.length, "Template-ID ist doppelt registriert");
    assert.deepEqual(ids, [...EXPECTED_TEMPLATE_IDS], "Katalog-Reihenfolge/IDs weichen ab");
  });

  test("assertTemplatesValid() läuft beim Import und beim Aufruf ohne Fehler", () => {
    assert.doesNotThrow(() => assertTemplatesValid());
    assert.doesNotThrow(() => assertTemplatesValid(STRATEGY_TEMPLATES));
  });

  test("getTemplate liefert für unbekannte IDs null statt zu werfen", () => {
    assert.equal(getTemplate("nicht-vorhanden" as StrategyTemplateId), null);
    assert.equal(getTemplate("" as StrategyTemplateId), null);
    for (const id of EXPECTED_TEMPLATE_IDS) {
      assert.ok(getTemplate(id), `${id} muss im Katalog liegen`);
    }
  });

  test("templateByField: bbZScore nur bollinger-squeeze, donchianBreakoutPct nur donchian-breakout", () => {
    assert.deepEqual(
      templateByField("bbZScore").map((template) => template.id),
      ["bollinger-squeeze"],
    );
    assert.deepEqual(
      templateByField("donchianBreakoutPct").map((template) => template.id),
      ["donchian-breakout"],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) Engine ↔ Cache (Regression aus Phase 2 — 02-02/02-03 festnageln)
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-03-10 · Engine ↔ Cache-Parität der Phase-2-Felder", () => {
  const PARITY_FIELDS = ["bbZScore", "priceVsUpperBbPct", "priceVsLowerBbPct", "donchianBreakoutPct"] as const;

  for (const templateId of ["bollinger-squeeze", "donchian-breakout"] as const) {
    test(`${templateId}: buildSnapshotFromCandles und snapshotFromCache sind feldgleich`, () => {
      const template = getTemplate(templateId);
      assert.ok(template, `${templateId} fehlt im Katalog`);
      const fixture = caseOf(template);

      for (const timeframe of template.supportedTimeframes) {
        const candles = fixture.positive(timeframe);
        const cache = buildIndicatorCache(candles);
        let compared = 0;

        for (let index = 24; index < candles.length; index++) {
          const direct = buildSnapshotFromCandles("BTC", candles.slice(0, index + 1), 20);
          const viaCache = snapshotFromCache("BTC", candles, cache, index, 20);
          assert.ok(direct && viaCache, `${templateId}/${timeframe} idx=${index}: Snapshot fehlt`);
          for (const field of PARITY_FIELDS) {
            assert.equal(
              viaCache[field],
              direct[field],
              `${templateId}/${timeframe} idx=${index}: ${field} weicht zwischen den Pfaden ab`,
            );
          }
          compared += 1;
        }
        assert.ok(compared > 0, `${templateId}/${timeframe}: keine verglichene Kerze`);
      }
    });
  }

  test("die Parität gilt auch für die Null-Semantik (zu wenig Historie ⇒ beide null)", () => {
    for (const templateId of ["bollinger-squeeze", "donchian-breakout"] as const) {
      const timeframe = getTemplate(templateId)?.supportedTimeframes[0];
      assert.ok(timeframe);
      const candles = shortHistory(timeframe);
      const cache = buildIndicatorCache(candles);
      const direct = buildSnapshotFromCandles("BTC", candles, 20);
      const viaCache = snapshotFromCache("BTC", candles, cache, candles.length - 1, 20);
      assert.ok(direct && viaCache);
      for (const field of PARITY_FIELDS) {
        assert.equal(viaCache[field], direct[field], `${templateId}: ${field} (Null-Semantik) weicht ab`);
      }
      // 28 Kerzen: das MACD-Fenster (35) ist auch im Cache nicht vollständig —
      // beide Pfade liefern `null`, keine erfundene 0.
      assert.equal(direct.macd, null, `${templateId}: macd muss null sein`);
      assert.equal(viaCache.macd, null, `${templateId}: macd muss auch im Cache null sein`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) Zeitrahmen-Disziplin (STX-01)
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-03-10 · Zeitrahmen-Disziplin (STX-01)", () => {
  test("vwapPct-Templates schließen 1d aus und bleiben auf zuverlässigen Takten", () => {
    for (const template of STRATEGY_TEMPLATES) {
      if (!template.requiredFields.includes("vwapPct")) continue;
      assert.ok(
        !template.supportedTimeframes.includes("1d"),
        `${template.id}: vwapPct ist auf 1d immer null — 1d darf nicht unterstützt werden`,
      );
      assert.ok(
        !template.supportedTimeframes.includes("5d"),
        `${template.id}: vwapPct ist auf 5d immer null — 5d darf nicht unterstützt werden`,
      );
      for (const timeframe of template.supportedTimeframes) {
        assert.ok(
          (VWAP_PCT_RELIABLE_TIMEFRAMES as readonly string[]).includes(timeframe),
          `${template.id}: ${timeframe} liegt außerhalb der VWAP-tauglichen Takte`,
        );
      }
    }
  });

  test("mindestens ein Template nutzt vwapPct — sonst prüft der Wächter nichts", () => {
    assert.ok(
      STRATEGY_TEMPLATES.some((template) => template.requiredFields.includes("vwapPct")),
      "kein Template nutzt vwapPct: der STX-01-Wächter wäre blind",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8) Doku-Tabelle ist aus dem Code generiert (kein Drift)
// ─────────────────────────────────────────────────────────────────────────────

describe("STX-03-10 · docs/STRATEGY_TEMPLATES.md", () => {
  const docPath = path.join(process.cwd(), "docs/STRATEGY_TEMPLATES.md");
  const doc = readFileSync(docPath, "utf8");

  test("die Datei entspricht byteweise der Renderer-Ausgabe", () => {
    assert.equal(
      doc,
      renderStrategyTemplatesDoc(),
      "docs/STRATEGY_TEMPLATES.md ist veraltet — `npm run docs:templates` ausführen und mitcommitten",
    );
  });

  test("die Tabelle nennt jedes Template mit Klasse, Timeframes, Parametern und Annahmen", () => {
    for (const template of STRATEGY_TEMPLATES) {
      assert.ok(doc.includes(`## \`${template.id}\``), `${template.id}: Abschnitt fehlt`);
      assert.ok(doc.includes(`\`${template.class}\``), `${template.id}: Klasse fehlt`);
      for (const timeframe of template.supportedTimeframes) {
        assert.ok(doc.includes(`\`${timeframe}\``), `${template.id}: Timeframe ${timeframe} fehlt`);
      }
      for (const key of Object.keys(template.params)) {
        assert.ok(doc.includes(`\`${key}\``), `${template.id}: Parameter ${key} fehlt`);
      }
      for (const assumption of template.assumptions) {
        assert.ok(doc.includes(`\`${assumption.id}\``), `${template.id}: Annahme ${assumption.id} fehlt`);
      }
    }
  });

  test("keine Hashes in der Doku (Secret-Scan von docs:validate bleibt grün)", () => {
    assert.equal(/\b[0-9a-f]{64}\b/.test(doc), false, "kein 64-stelliger Hex-String in docs/");
  });
});
