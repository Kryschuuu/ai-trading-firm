/**
 * Tests des RSI-Mean-Reversion-Templates (STX-03-05, `src/strategies/templates/`).
 *
 * Geprüft werden die Akzeptanzkriterien des Prompts — gegen den **lebenden**
 * Bestand, nie gegen abgeschriebene Zahlen:
 *
 *   1. `validateTemplate(buildRsiMeanReversion())` liefert `[]`.
 *   2. `buildRule(defaults)` übersteht `sanitizeRuleSpec()` **ohne Klemmung** —
 *      für jeden Punkt des Parameterrasters, nicht nur für die Defaults.
 *   3. **Der `adx14`-Operator ist `lte`, nicht `gte`** — und zwar als Regression
 *      gegen die beiden Trend-Vorlagen 03-03/03-04, die auf demselben Feld
 *      `gte` verlangen. Genau dieser Operator ist der Unterschied zwischen
 *      Mean-Reversion und „Catching the falling knife".
 *   4. **Die Klasse trägt (ADR-008):** `class === "mean-reversion"` und
 *      `class !== "unclassified"`; `regimeGateFactor("TREND_UP", …) < 1`,
 *      `regimeGateFactor("RANGE", …) === 1` — gelesen aus
 *      `DEFAULT_MARKET_REGIME_CONFIG`, nie gesetzt.
 *   5. Das Gate wird **nicht verändert** (Sperre des Prompts): Faktoren und
 *      Decay-Policies sind vor und nach jedem Aufruf byte-identisch.
 *   6. `buildRule` ist eine **reine** Funktion der Parameter.
 *
 * Dazu die Doku-Pflichten als lebende Invarianten: der ADX-Deckel, das kleinere
 * Chance/Risiko-Verhältnis, das **Fehlen** von `bbZScore` (Reihenfolge zu
 * 02-02/03-06) und die RSI-Warm-up-Falle (15 Schlusskurse, Ersatzwert 50).
 * Alles DB-, LLM- und netzfrei; der Backtest selbst bleibt 03-10.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  RSI_MEAN_REVERSION_DEFAULTS,
  RSI_MEAN_REVERSION_ID,
  RSI_MEAN_REVERSION_PARAMS,
  RSI_MEAN_REVERSION_TIMEFRAMES,
  RSI_MEAN_REVERSION_VERSION,
  buildRsiMeanReversion,
  rsiMeanReversionRule,
  type RsiMeanReversionParamKey,
} from "../src/strategies/templates/rsi-mean-reversion";
import {
  EMA_ADX_TREND_DEFAULTS,
  emaAdxTrendRule,
} from "../src/strategies/templates/ema-adx-trend";
import { MACD_MOMENTUM_DEFAULTS, macdMomentumRule } from "../src/strategies/templates/macd-momentum";
import {
  STRATEGY_TEMPLATES,
  assertTemplatesValid,
  getTemplate,
  listTemplates,
  templateByField,
  validateTemplate,
} from "../src/strategies/catalog";
import type { ParamSpec, StrategyTemplate } from "../src/strategies/types";
import {
  RULE_CEILINGS,
  buildSnapshotFromCandles,
  compileRuleSpec,
  sanitizeRuleSpec,
} from "../src/lib/ruleEngine";
import type { CandleLike, RuleSnapshot, RuleSpec, RuleSpecInput } from "../src/lib/ruleEngine";
import { RULE_FIELDS } from "../src/lib/ruleFieldCatalog";
import { LIMIT_CEILINGS } from "../src/lib/riskGuard";
import { SUPPORTED_TIMEFRAME_MS } from "../src/lib/marketdata/timeframes";
import {
  DEFAULT_MARKET_REGIME_CONFIG,
  STRATEGY_CLASSES,
  regimeGateFactor,
  strategyClassOfTemplate,
} from "../src/lib/marketRegime";
import { DEFAULT_CLASS_POLICIES } from "../src/lib/signalDecay";

const ROOT = process.cwd();
const TEMPLATE_SOURCE = readFileSync(
  path.join(ROOT, "src/strategies/templates/rsi-mean-reversion.ts"),
  "utf8",
);
const INDICATORS_SOURCE = readFileSync(path.join(ROOT, "src/lib/indicators.ts"), "utf8");

const PARAM_KEYS = Object.keys(RSI_MEAN_REVERSION_PARAMS) as RsiMeanReversionParamKey[];

// ── Helfer ───────────────────────────────────────────────────────────────────

/** Der vertragliche Pfad: Rohform + **Symbol des Aufrufers**, dann Sanitizer. */
function sanitize(params: Record<string, number>, symbol = "BTC"): RuleSpec {
  const result = sanitizeRuleSpec({ ...rsiMeanReversionRule(params), symbol } as RuleSpecInput, "MANUAL");
  if (!result.ok) throw new Error(`sanitizeRuleSpec lehnt ab: ${result.errors.join(" | ")}`);
  return result.spec;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "erwartet ein Objekt");
  return value as Record<string, unknown>;
}

function conditionsOf(raw: RuleSpecInput): Array<Record<string, unknown>> {
  return asRecord(raw.condition).conditions as Array<Record<string, unknown>>;
}

/** Defaults, punktuell überschrieben — so fährt 06-02 später das Raster. */
function paramsWith(overrides: Partial<Record<RsiMeanReversionParamKey, number>>): Record<string, number> {
  return { ...RSI_MEAN_REVERSION_DEFAULTS, ...overrides };
}

/** Das Raster eines Parameters, inklusiv beider Endpunkte. */
function gridOf(spec: ParamSpec): number[] {
  const points = Math.round((spec.max - spec.min) / spec.step);
  return Array.from({ length: points + 1 }, (_, index) => spec.min + index * spec.step);
}

/** Alle Rasterpunkte aller Parameter — je Eintrag ein vollständiger Parametersatz. */
function everyGridParams(): Array<Record<string, number>> {
  const out: Array<Record<string, number>> = [paramsWith({})];
  for (const key of PARAM_KEYS) {
    for (const value of gridOf(RSI_MEAN_REVERSION_PARAMS[key])) out.push(paramsWith({ [key]: value }));
  }
  return out;
}

/**
 * Ein Template, dessen Parameter-`default` auf `value` steht.
 *
 * Der Katalog ruft `buildRule()` mit genau den Defaults auf — einen Rasterpunkt
 * über den Default zu setzen ist deshalb der einzige Weg, die **vollständige**
 * Prüfung (Param-Grenzen + Builder + `RULE_CEILINGS`) auf diesem Punkt laufen
 * zu lassen.
 */
function templateWithParam(key: RsiMeanReversionParamKey, value: number): StrategyTemplate {
  const params: Record<string, ParamSpec> = {};
  for (const paramKey of PARAM_KEYS) {
    const spec = RSI_MEAN_REVERSION_PARAMS[paramKey];
    params[paramKey] = paramKey === key ? { ...spec, default: value } : spec;
  }
  return { ...buildRsiMeanReversion(), params };
}

/** Zahl eines `RULE_CEILINGS`-Schlüssels als Fenster (Tupel oder Skalar). */
function ceilingOf(key: string): { min: number; max: number } | null {
  const raw: unknown = (RULE_CEILINGS as Readonly<Record<string, unknown>>)[key];
  if (typeof raw === "number") return { min: 0, max: raw };
  if (Array.isArray(raw) && raw.length === 2 && raw.every((n) => typeof n === "number")) {
    return { min: raw[0] as number, max: raw[1] as number };
  }
  return null;
}

/** Der Template-Text rundet für die Anzeige auf 3 Stellen — hier nachgestellt. */
function rationaleMentions(rationale: string, value: number): boolean {
  return rationale.includes(String(Number(value.toFixed(3))));
}

/**
 * Eine Range mit einer Abwärts-Überdehnung am Ende: Oszillation um 100,
 * dann ein sanfter Abverkauf über die letzten zehn Kerzen, die letzte Kerze
 * mit Volumenspitze.
 *
 * Genau das Setup, das dieses Template sucht — und das der ADX-Filter **nur**
 * zulässt, weil die Abwärtsbewegung kein Trend ist (Werte: RSI ≈ 28,8,
 * Abstand zum EMA 21 ≈ −3,9 %, ADX ≈ 17, Volumen ≈ 1,9×).
 */
function rangeSelloffSeries(
  bars = 120,
  amplitude = 1,
  phase = 6,
  dropStart = 110,
  dropPerBar = -0.005,
  volumeSpike = 200,
): CandleLike[] {
  const out: CandleLike[] = [];
  let previous = 100;
  let time = 1_700_000_000_000;
  for (let i = 0; i < bars; i++) {
    const oscillation = Math.sin((i / phase) * Math.PI * 2) * amplitude;
    const jitter = (((i * 37) % 11) / 11) * 0.3 - 0.15;
    const factor = i >= dropStart ? Math.pow(1 + dropPerBar, i - dropStart + 1) : 1;
    const close = (100 + oscillation + jitter) * factor;
    out.push({
      time,
      open: previous,
      high: Math.max(previous, close) * 1.0008,
      low: Math.min(previous, close) * 0.9992,
      close,
      volume: i === bars - 1 ? volumeSpike : 100,
    });
    previous = close;
    time += 3_600_000;
  }
  return out;
}

/** Eine monoton fallende Kerzenreihe (der Falling-Knife-Fall). */
function downSeries(bars: number, factorPerBar: number, volumeLast = 300): CandleLike[] {
  const out: CandleLike[] = [];
  let price = 100;
  let time = 1_700_000_000_000;
  for (let i = 0; i < bars; i++) {
    const close = price * factorPerBar;
    out.push({
      time,
      open: price,
      high: Math.max(price, close) * 1.0005,
      low: Math.min(price, close) * 0.9995,
      close,
      volume: i === bars - 1 ? volumeLast : 100,
    });
    price = close;
    time += 3_600_000;
  }
  return out;
}

/** Eine flache Kerzenreihe (Range ohne Überdehnung). */
function flatSeries(bars: number): CandleLike[] {
  return Array.from({ length: bars }, (_, index) => ({
    time: 1_700_000_000_000 + index * 3_600_000,
    open: 100,
    high: 100.05,
    low: 99.95,
    close: 100,
    volume: 100,
  }));
}

/**
 * Ein handgebauter Snapshot: genau der Fall, den eine Bedingung behauptet.
 * Nur die Felder, die diese Regel liest — der Rest ist bewusst nicht da, damit
 * der Test nicht zufällig über andere Zweige „grün" wird.
 */
function snapshotWith(overrides: Record<string, unknown>): RuleSnapshot {
  return {
    price: 100,
    trend: "DOWN",
    ema9: 99,
    ema21: 102,
    rsi14: 25,
    priceVsEma21Pct: -2,
    adx14: 15,
    volumeRatio: 1.5,
    atrPct: 2,
    ...overrides,
  } as unknown as RuleSnapshot;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) Akzeptanzkriterium 1 — der Katalog nimmt das Artefakt
// ─────────────────────────────────────────────────────────────────────────────

describe("Akzeptanz: validateTemplate(buildRsiMeanReversion()) liefert []", () => {
  test("das frisch gebaute Template ist vertragsgültig", () => {
    assert.deepEqual(validateTemplate(buildRsiMeanReversion()), []);
  });

  test("die Registry-Prüfung wirft nicht (Import-Zeit-Pfad des Katalogs)", () => {
    assert.doesNotThrow(() => assertTemplatesValid([buildRsiMeanReversion()]));
    assert.doesNotThrow(() => assertTemplatesValid());
  });

  test("der Katalogeintrag ist genau dieses Artefakt (Roadmap-Reihenfolge: dritter Platz)", () => {
    const entry = getTemplate(RSI_MEAN_REVERSION_ID);
    assert.ok(entry, "rsi-mean-reversion muss im Katalog stehen");
    assert.equal(entry, listTemplates()[2], "Roadmap-Reihenfolge: 03-03, 03-04, 03-05, …");
    assert.equal(entry?.id, RSI_MEAN_REVERSION_ID);
    assert.equal(JSON.stringify(entry), JSON.stringify(buildRsiMeanReversion()));
    assert.ok(
      STRATEGY_TEMPLATES.some((template) => template.id === RSI_MEAN_REVERSION_ID),
      "das Artefakt muss in der Registry stehen",
    );
    // Die Nachbarn aus 03-03/03-04 stehen weiter davor — die Reihenfolge ist
    // die der Roadmap, nicht die des Einfügens.
    assert.equal(listTemplates()[0]?.id, "ema-adx-trend");
    assert.equal(listTemplates()[1]?.id, "macd-momentum");
  });

  test("jedes requiredFields-Feld lebt in RULE_FIELDS (Whitelist, nicht Kopie)", () => {
    const known = new Set(Object.keys(RULE_FIELDS));
    for (const field of buildRsiMeanReversion().requiredFields) {
      assert.ok(known.has(field), `${field} ist kein RULE_FIELDS-Feld`);
    }
  });

  test("das Template braucht nichts Neues: alle fünf Felder existieren bereits", () => {
    for (const field of ["rsi14", "priceVsEma21Pct", "adx14", "volumeRatio", "atrPct"]) {
      assert.ok(field in RULE_FIELDS, `${field} fehlt im Feldkatalog`);
    }
    assert.equal(RULE_FIELDS.rsi14, "number");
    assert.equal(RULE_FIELDS.priceVsEma21Pct, "number");
  });

  test("das Artefakt ist über seine Felder auffindbar (templateByField, SSoT-Abfrage)", () => {
    for (const field of buildRsiMeanReversion().requiredFields) {
      assert.ok(
        templateByField(field).some((template) => template.id === RSI_MEAN_REVERSION_ID),
        `${field} muss auf rsi-mean-reversion zeigen`,
      );
    }
    // `rsi14` ist bislang ungenutzt — dieses Template ist der erste Kunde.
    assert.deepEqual(
      templateByField("rsi14").map((template) => template.id),
      [RSI_MEAN_REVERSION_ID],
    );
    // `adx14` teilt es mit beiden Trend-Vorlagen — mit einem anderen Operator.
    // Weitere ADX-Nutzer (seit 03-06 auch Bollinger) ändern diesen Vertrag nicht.
    for (const id of ["ema-adx-trend", "macd-momentum"]) {
      assert.ok(templateByField("adx14").some((template) => template.id === id), `${id} nutzt weiterhin ADX`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Spec-Treue — die Tabellen des Prompts, Zeile für Zeile
// ─────────────────────────────────────────────────────────────────────────────

describe("Template-Daten: der Prompt als Test", () => {
  test("Kennung, Klasse, Version, Scope", () => {
    const t = buildRsiMeanReversion();
    assert.equal(t.id, "rsi-mean-reversion");
    assert.equal(t.id, RSI_MEAN_REVERSION_ID, "exportierte ID und Template-ID sind eine Zahl");
    assert.equal(t.class, "mean-reversion");
    assert.equal(t.version, 1);
    assert.equal(t.version, RSI_MEAN_REVERSION_VERSION);
    assert.equal(t.scope, "SINGLE_SYMBOL");
    assert.ok(t.name.trim().length > 0 && t.description.trim().length > 0, "name/description gehören zum Artefakt");
  });

  test("supportedTimeframes = 15m/1h/4h — Allowlist-Werte, aufsteigend", () => {
    const t = buildRsiMeanReversion();
    assert.deepEqual([...t.supportedTimeframes], ["15m", "1h", "4h"]);
    assert.deepEqual(t.supportedTimeframes, RSI_MEAN_REVERSION_TIMEFRAMES, "exportierte Liste = Template-Liste");
    const widths = t.supportedTimeframes.map((tf) => SUPPORTED_TIMEFRAME_MS[tf]);
    assert.deepEqual(widths, [...widths].sort((a, b) => a - b), "die Liste ist aufsteigend sortiert");
    // 29 ADX-Kerzen sind die Untergrenze der Aussage: auf 15m (7,25 h) unter
    // einem Handelstag — deshalb ist 15m unterstützt, aber nicht der Default.
    assert.ok(29 * SUPPORTED_TIMEFRAME_MS["1h"] >= 24 * 3_600_000, "1h: 29 Kerzen ≥ ein Handelstag");
    assert.ok(29 * SUPPORTED_TIMEFRAME_MS["15m"] < 24 * 3_600_000, "15m: 29 Kerzen < ein Handelstag");
  });

  test("requiredFields exakt die fünf Felder des Templates", () => {
    assert.deepEqual(
      [...buildRsiMeanReversion().requiredFields],
      ["rsi14", "priceVsEma21Pct", "adx14", "volumeRatio", "atrPct"],
    );
  });

  test("Parametertabelle: kind, label, unit, default, min, max, step, mapsTo", () => {
    const expected: Readonly<Record<RsiMeanReversionParamKey, Omit<ParamSpec, "key">>> = {
      rsiOversold: {
        kind: "threshold",
        label: "RSI-Überverkauft-Schwelle",
        unit: "Index",
        default: 30,
        min: 15,
        max: 40,
        step: 1,
        mapsTo: "rsi14",
      },
      ema21GapPct: {
        kind: "threshold",
        label: "Kurs mind. unter EMA 21",
        unit: "%",
        default: 1,
        min: 0.3,
        max: 5,
        step: 0.1,
        mapsTo: "priceVsEma21Pct",
      },
      adxMax: {
        kind: "threshold",
        label: "Maximaler ADX (Seitwärts-Filter)",
        unit: "Index",
        default: 20,
        min: 10,
        max: 30,
        step: 1,
        mapsTo: "adx14",
      },
      volumeRatioMin: {
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
        kind: "threshold",
        label: "Stop-Loss",
        unit: "%",
        default: 5,
        min: 1,
        max: 15,
        step: 0.5,
        mapsTo: "atrPct",
      },
      takeProfitRR: {
        kind: "ratio",
        label: "Chance/Risiko",
        unit: "ratio",
        default: 1.5,
        min: 1,
        max: 4,
        step: 0.25,
        mapsTo: "atrPct",
      },
    };
    const t = buildRsiMeanReversion();
    assert.deepEqual(Object.keys(t.params).sort(), Object.keys(expected).sort(), "kein Parameter zu viel oder zu wenig");
    for (const [key, want] of Object.entries(expected)) {
      const got = t.params[key];
      assert.ok(got, `params.${key} fehlt`);
      assert.equal(got.key, key, `params.${key}: record-key und spec.key müssen übereinstimmen`);
      for (const field of Object.keys(want) as Array<keyof Omit<ParamSpec, "key">>) {
        assert.deepEqual(got[field], want[field], `params.${key}.${field}`);
      }
    }
    // Die Defaults sind die einzige Default-Quelle (kein zweiter Satz).
    assert.deepEqual(
      { ...RSI_MEAN_REVERSION_DEFAULTS },
      { rsiOversold: 30, ema21GapPct: 1, adxMax: 20, volumeRatioMin: 1.1, stopLossPct: 5, takeProfitRR: 1.5 },
    );
  });

  test("jeder Parameter mappt auf ein vorhandenes Regelfeld, keiner auf `bbZScore`", () => {
    for (const key of PARAM_KEYS) {
      const mapsTo = RSI_MEAN_REVERSION_PARAMS[key].mapsTo;
      assert.ok(mapsTo in RULE_FIELDS, `params.${key}.mapsTo ist kein Regelfeld`);
      assert.notEqual(mapsTo, "bbZScore", `${key}: bbZScore gehört zu 03-06 (siehe Doku-Pflicht 3)`);
    }
    // Und die gemappten Felder sind genau die ausgewerteten (ohne atrPct, das
    // nur die Risikoseite dokumentiert).
    const mapped = new Set(PARAM_KEYS.map((key) => RSI_MEAN_REVERSION_PARAMS[key].mapsTo));
    assert.deepEqual([...mapped].sort(), ["adx14", "atrPct", "priceVsEma21Pct", "rsi14", "volumeRatio"]);
  });

  test("expectedRegimes = [RANGE] — ohne UNKNOWN, ohne TREND_UP (ADR-009)", () => {
    assert.deepEqual([...buildRsiMeanReversion().expectedRegimes], ["RANGE"]);
  });

  test("assumptions: die vier Pflichtannahmen mit Kategorie und critical-Flag", () => {
    const assumptions = buildRsiMeanReversion().assumptions;
    assert.ok(assumptions.length >= 4, `mindestens 4 Annahmen, sind ${assumptions.length}`);
    const expected: ReadonlyArray<{ id: string; category: string; critical: boolean }> = [
      { id: "regime-range", category: "REGIME", critical: true },
      { id: "ueberverkauf-keine-bodenbildung", category: "MARKET", critical: false },
      { id: "turnover-kosten-lastend", category: "COST", critical: true },
      { id: "rsi-15-schlusskurse", category: "DATA", critical: true },
    ];
    for (const want of expected) {
      const got = assumptions.find((a) => a.id === want.id);
      assert.ok(got, `Annahme ${want.id} fehlt`);
      assert.equal(got.category, want.category, want.id);
      assert.equal(got.critical, want.critical, `${want.id}: critical-Flag`);
      assert.ok(got.statement.trim().length > 20, `${want.id}: statement ist ein Platzhalter`);
    }
    // `critical: true` heißt „ohne diese Annahme ist das Ergebnis wertlos":
    // das Regime (RANGE), die Kosten (Turnover) und die RSI-Warm-up-Grenze.
    assert.deepEqual(
      assumptions
        .filter((a) => a.critical)
        .map((a) => a.category)
        .sort(),
      ["COST", "DATA", "REGIME"],
    );
    const regime = assumptions.find((a) => a.id === "regime-range");
    assert.match(String(regime?.statement), /RANGE/);
    assert.match(String(regime?.statement), /Regime-Gate/, "die Wirkung des Gates muss benannt sein");
    const costs = assumptions.find((a) => a.id === "turnover-kosten-lastend");
    assert.match(String(costs?.statement), /Turnover/i);
    const warmup = assumptions.find((a) => a.id === "rsi-15-schlusskurse");
    assert.match(String(warmup?.statement), /15/);
    for (const a of assumptions) {
      assert.match(a.id, /^[a-z0-9-]{1,64}$/, `id ${a.id} außerhalb des Schemas`);
      assert.ok(["MARKET", "COST", "LIQUIDITY", "DATA", "REGIME", "EXECUTION"].includes(a.category), a.category);
    }
    assert.equal(new Set(assumptions.map((a) => a.id)).size, assumptions.length, "Annahme-IDs eindeutig");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) ADR-008 — die Klasse trägt (das Kern-Akzeptanzkriterium dieses Prompts)
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-008: `class: \"mean-reversion\"` trägt Gate und Decay-Policy", () => {
  test("die deklarierte Klasse ist `mean-reversion` und ausdrücklich nicht `unclassified`", () => {
    const template = buildRsiMeanReversion();
    assert.equal(template.class, "mean-reversion");
    assert.notEqual(template.class, "unclassified", "ohne Klasse wäre der Gate-Faktor still 1");
    assert.ok((STRATEGY_CLASSES as readonly string[]).includes(template.class), "Klasse aus dem Bestandsvokabular");
    // Dieses Template ist das ERSTE mit dieser Klasse — der Katalog führt bis
    // hierher nur `trend`. Spätere Templates dürfen weitere Klassen ergänzen.
    const throughRsi = listTemplates().slice(0, listTemplates().findIndex((t) => t.id === RSI_MEAN_REVERSION_ID) + 1);
    assert.deepEqual([...new Set(throughRsi.map((t) => t.class))], ["trend", "mean-reversion"]);
    // Und die ADR-008-Namens-Heuristik sieht dasselbe.
    assert.equal(strategyClassOfTemplate(template.id), template.class);
  });

  test("Regime-Gate: TREND_UP/TREND_DOWN < 1, RANGE === 1 — gelesen, nicht gesetzt", () => {
    const declared = buildRsiMeanReversion().class;
    if (declared === "unclassified") throw new Error("unclassified darf keine Template-Klasse sein");
    const cfg = DEFAULT_MARKET_REGIME_CONFIG;

    // Der Auftrag: < 1 in den Trend-Regimen, genau 1 in der Range.
    assert.ok(
      regimeGateFactor("TREND_UP", declared, cfg) < 1,
      "TREND_UP muss die Mean-Reversion-Klasse dämpfen",
    );
    assert.ok(
      regimeGateFactor("TREND_DOWN", declared, cfg) < 1,
      "TREND_DOWN muss die Mean-Reversion-Klasse dämpfen",
    );
    assert.equal(regimeGateFactor("RANGE", declared, cfg), 1, "in der Range darf nichts gedämpft werden");

    // Nachgerechnet an der Konfiguration: es ist derselbe Wert, keine Kopie.
    assert.equal(regimeGateFactor("TREND_UP", declared, cfg), cfg.gateFactors.TREND_UP["mean-reversion"]);
    assert.equal(regimeGateFactor("RANGE", declared, cfg), cfg.gateFactors.RANGE["mean-reversion"]);

    // Der Kontrast zum Nachbarn: `trend` wird in TREND_UP NICHT gedämpft —
    // erst die Klasse macht den Unterschied, nicht das Regime allein.
    assert.equal(regimeGateFactor("TREND_UP", "trend", cfg), 1);
    assert.ok(regimeGateFactor("TREND_UP", declared, cfg) < regimeGateFactor("TREND_UP", "trend", cfg));
  });

  test("die Klasse hat eine eigene Decay-Policy — und sie unterscheidet sich von `trend`", () => {
    const policy = DEFAULT_CLASS_POLICIES["mean-reversion"];
    assert.equal(typeof policy.halfLifeMs, "number", "die Klasse hat eine Halbwertszeit");
    assert.ok((policy.halfLifeMs ?? 0) > 0);
    // Mean-Reversion ist kurzlebiger als Trendfolge — genau der Grund, warum
    // der Raster bis `4h` sinnvoll ist und `takeProfitRR` kleiner ausfällt.
    assert.ok(
      (policy.halfLifeMs ?? Infinity) < (DEFAULT_CLASS_POLICIES.trend.halfLifeMs ?? 0),
      "mean-reversion muss schneller verfallen als trend",
    );
    // `unclassified` bleibt die Nicht-Klasse (ADR-008): Policy aus, keine Zeit.
    assert.equal(DEFAULT_CLASS_POLICIES.unclassified.enabled, false);
    assert.equal(DEFAULT_CLASS_POLICIES.unclassified.halfLifeMs, null);
  });

  test("die Klasse wirkt, aber das Gate bleibt unverändert (Sperre des Prompts)", () => {
    // Vorher/Nachher über den gesamten Pfad: Bauen, Regeln erzeugen, sanitisieren
    // — keine dieser Stellen darf an den Gate-Faktoren drehen.
    const before = JSON.stringify(DEFAULT_MARKET_REGIME_CONFIG.gateFactors);
    buildRsiMeanReversion();
    rsiMeanReversionRule(RSI_MEAN_REVERSION_DEFAULTS);
    sanitize(RSI_MEAN_REVERSION_DEFAULTS);
    assert.equal(JSON.stringify(DEFAULT_MARKET_REGIME_CONFIG.gateFactors), before, "Gate-Faktoren wurden verändert");
    // Auch die Modi bleiben, wie sie sind: dieses Template nutzt `enforce`,
    // es schaltet es nicht ein.
    assert.equal(DEFAULT_MARKET_REGIME_CONFIG.gateMode, "monitor");
  });

  test("Doku-Pflicht: der Kopf nennt die Gate-Faktoren und die Wirkungsgrenze", () => {
    assert.match(TEMPLATE_SOURCE, /Regime-Gegenpol/, "der Regime-Abschnitt fehlt");
    assert.match(TEMPLATE_SOURCE, /`TREND_UP` \| `0\.5`/, "der Faktor 0,5 muss als gelesener Wert stehen");
    assert.match(TEMPLATE_SOURCE, /resolveRegimeGateForExecution/, "der Live-Pfad muss benannt sein");
    assert.match(TEMPLATE_SOURCE, /Wirkungsgrenze/, "ADR-008-Wirkungsgrenze fehlt");
    // Zeilenumbruch-tolerant: der Kopf ist umbrochen, die Aussage muss stehen.
    assert.match(
      TEMPLATE_SOURCE,
      /Backtest wendet\s*\*\*kein\*\*[\s\S]{0,16}Regime-Gate an/,
      "die Wirkungsgrenze fehlt",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) Akzeptanzkriterium: der `adx14`-Operator ist `lte`, nicht `gte`
// ─────────────────────────────────────────────────────────────────────────────

describe("Der lastende Filter: `adx14 lte adxMax` — Regression gegen die Trend-Vorlage", () => {
  test("die ADX-Bedingung des Builders ist `lte` — über das gesamte Raster", () => {
    for (const params of everyGridParams()) {
      const conditions = conditionsOf(rsiMeanReversionRule(params));
      const adx = conditions.filter((item) => item.field === "adx14");
      assert.equal(adx.length, 1, `genau eine adx14-Bedingung (${JSON.stringify(params)})`);
      assert.equal(adx[0].op, "lte", `adx14-Operator muss lte sein (${JSON.stringify(params)})`);
      assert.equal(adx[0].value, params.adxMax);
    }
  });

  test("auch nach dem Sanitizer bleibt der Operator `lte` (keine stille Umkehrung)", () => {
    for (const value of gridOf(RSI_MEAN_REVERSION_PARAMS.adxMax)) {
      const spec = sanitize(paramsWith({ adxMax: value }));
      const adx = spec.condition.conditions.filter((c) => c.field === "adx14");
      assert.equal(adx.length, 1);
      assert.equal(adx[0].op, "lte");
      assert.equal(adx[0].value, value);
    }
  });

  test("Kontrast zu 03-03/03-04: dieselben Templates, dasselbe Feld, der andere Operator", () => {
    // Das ist die Regression, die der Prompt verlangt: Mean-Reversion und
    // Trendfolge lesen `adx14` in entgegengesetzte Richtungen. Würde hier
    // jemand `gte` eintragen, wäre das Template kein Mean-Reversion mehr.
    const trendConditions = conditionsOf(emaAdxTrendRule(EMA_ADX_TREND_DEFAULTS));
    assert.equal(trendConditions.find((item) => item.field === "adx14")?.op, "gte");
    const momentumConditions = conditionsOf(macdMomentumRule(MACD_MOMENTUM_DEFAULTS));
    assert.equal(momentumConditions.find((item) => item.field === "adx14")?.op, "gte");
    const meanReversionConditions = conditionsOf(rsiMeanReversionRule(RSI_MEAN_REVERSION_DEFAULTS));
    assert.equal(meanReversionConditions.find((item) => item.field === "adx14")?.op, "lte");
  });

  test("statischer Wächter: im Quelltext steht `adx14` nur mit `lte`, nirgends mit `gte`", () => {
    assert.equal(
      [...TEMPLATE_SOURCE.matchAll(/field:\s*"adx14"/g)].length,
      1,
      "genau eine adx14-Bedingung im Builder-Quelltext",
    );
    const block = TEMPLATE_SOURCE.match(/\{[^{}]*field:\s*"adx14"[^{}]*\}/);
    assert.ok(block, "die adx14-Bedingung wurde im Quelltext nicht gefunden");
    assert.match(block[0], /op:\s*"lte"/);
    assert.doesNotMatch(block[0], /op:\s*"(gte|gt|lt)"/, "kein anderer Operator auf adx14");
    // Der Parameter heißt `adxMax`, nicht `adxMin` — der Name selbst trägt die
    // Richtung, und der Prompt verlangt diese Schreibweise.
    assert.match(TEMPLATE_SOURCE, /adxMax:\s*\{/);
    assert.doesNotMatch(TEMPLATE_SOURCE, /adxMin:/, "ein Minimum wäre die falsche Strategie");
  });

  test("Doku-Pflicht 1: der Kopf begründet den Deckel und nennt das Falling-Knife-Szenario", () => {
    assert.match(TEMPLATE_SOURCE, /DOK-PFLICHT 1/, "die Doku-Pflicht muss als solche stehen");
    assert.match(TEMPLATE_SOURCE, /`adx14` ein MAXIMUM ist/, "Maximum vs. Minimum muss benannt sein");
    assert.match(TEMPLATE_SOURCE, /Catching the falling knife/i, "das Szenario ohne Filter muss benannt sein");
    assert.match(TEMPLATE_SOURCE, /Umkehrung der Strategie/, "die Konsequenz von gte muss benannt sein");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) buildRule — die gelieferte Rohform
// ─────────────────────────────────────────────────────────────────────────────

describe("buildRule(defaults): die vier Bedingungen, die Action, das Fenster", () => {
  test("condition ist eine `all`-Konjunktion über genau vier Regeln", () => {
    const raw = rsiMeanReversionRule(RSI_MEAN_REVERSION_DEFAULTS);
    assert.equal(asRecord(raw.condition).logic, "all");
    assert.deepEqual(conditionsOf(raw), [
      { field: "rsi14", op: "lte", value: 30 },
      { field: "priceVsEma21Pct", op: "lte", value: -1 },
      { field: "adx14", op: "lte", value: 20 },
      { field: "volumeRatio", op: "gte", value: 1.1 },
    ]);
    assert.ok(
      conditionsOf(raw).length <= RULE_CEILINGS.maxConditions,
      "mehr Bedingungen als maxConditions würde der Sanitizer still kappen",
    );
  });

  test("action: LONG mit den verifizierten Risiko-Werten", () => {
    const action = asRecord(rsiMeanReversionRule(RSI_MEAN_REVERSION_DEFAULTS).action);
    assert.deepEqual(action, {
      side: "LONG",
      stopLossPct: 5,
      takeProfitRR: 1.5,
      riskBudgetPct: 0.01,
      maxPositionPct: 0.15,
      positionSizeMode: "risk",
    });
    // Nachgerechnet am Bestand, nicht am Prompt: Die festgesetzten Werte liegen
    // **innerhalb** der Deckel, die der Sanitizer aus LIMIT_CEILINGS ableitet —
    // und zwar frei von beiden Anschlägen.
    assert.deepEqual([...LIMIT_CEILINGS.maxRiskPerTrade], [0.002, 0.05]);
    assert.deepEqual([...LIMIT_CEILINGS.maxPositionPct], [0.01, 0.5]);
    assert.ok(
      Number(action.riskBudgetPct) > ceilingOf("riskBudgetPct")!.min &&
        Number(action.riskBudgetPct) < ceilingOf("riskBudgetPct")!.max,
      "riskBudgetPct am Anschlag — eine spätere Senkung des Deckels wäre unsichtbar",
    );
    assert.ok(
      Number(action.maxPositionPct) > ceilingOf("maxPositionPct")!.min &&
        Number(action.maxPositionPct) < ceilingOf("maxPositionPct")!.max,
      "maxPositionPct am Anschlag",
    );
  });

  test("window: 1h, 2 Ausführungen/Tag, 240 min Abklingzeit, 20 Kerzen Volumen", () => {
    const window = asRecord(rsiMeanReversionRule(RSI_MEAN_REVERSION_DEFAULTS).window);
    assert.deepEqual(window, {
      timeframe: "1h",
      validFrom: null,
      validUntil: null,
      maxExecutionsPerDay: 2,
      cooldownMinutes: 240,
      volumeWindow: 20,
    });
    assert.ok(
      (RSI_MEAN_REVERSION_TIMEFRAMES as readonly unknown[]).includes(window.timeframe),
      "window.timeframe muss ein unterstützter Takt des Templates sein",
    );
    // 240 min sind genau eine 4h-Kerze — der gröbste unterstützte Takt. Auf
    // jedem Takt liegt damit mindestens eine volle Kerze zwischen zwei Trades.
    assert.equal(Number(window.cooldownMinutes), SUPPORTED_TIMEFRAME_MS["4h"] / 60_000);
  });

  test("Herkunft, Rationale, Risiko-Score, Mission — und kein symbol", () => {
    const raw = rsiMeanReversionRule(RSI_MEAN_REVERSION_DEFAULTS);
    assert.equal(raw.sourceRole, "RESEARCH");
    assert.equal(raw.missionId, null);
    assert.equal(raw.riskScore, 0.5);
    assert.ok(String(raw.name).includes(RSI_MEAN_REVERSION_ID), "name trägt die Template-ID (Familienname)");
    const rationale = String(raw.rationale);
    assert.match(rationale, /[a-zäöüß]/, "rationale ist deutsch verfasst");
    assert.ok(rationale.length > 40 && rationale.length <= 600, "rationale muss in den 600-Zeichen-Schnitt passen");
    // Der Kern des `symbol`-Vertrags: der Builder kennt keinen Markt.
    assert.equal("symbol" in raw, false, "symbol ist Pflicht des Aufrufers, nie des Builders");
    assert.equal(sanitizeRuleSpec(raw, "MANUAL").ok, false, "ohne Symbol darf es keine Regel geben");
  });

  test("jeder Parameter erreicht die Regel — kein Parameter ist Deko", () => {
    const raw = rsiMeanReversionRule(
      paramsWith({ rsiOversold: 22, ema21GapPct: 2.5, adxMax: 27, volumeRatioMin: 1.75, stopLossPct: 7.5, takeProfitRR: 3.25 }),
    );
    assert.deepEqual(
      conditionsOf(raw).map((item) => [item.field, item.op, item.value]),
      [
        ["rsi14", "lte", 22],
        ["priceVsEma21Pct", "lte", -2.5],
        ["adx14", "lte", 27],
        ["volumeRatio", "gte", 1.75],
      ],
    );
    const action = asRecord(raw.action);
    assert.equal(action.stopLossPct, 7.5);
    assert.equal(action.takeProfitRR, 3.25);
    // Die Rationale zitiert die Werte: eine Zahl, die in der Regel steht und im
    // Klartext fehlt, wäre eine Audit-Lüge.
    for (const value of [22, 2.5, 27, 1.75, 7.5, 3.25]) {
      assert.ok(rationaleMentions(String(raw.rationale), value), `rationale nennt ${value} nicht`);
    }
  });

  test("`ema21GapPct` wird in der Regel negiert, nicht als zweites Raster verdoppelt", () => {
    // Der Parameter ist positiv („1 % unter EMA 21"), das Feld trägt das
    // Vorzeichen. Ein negativer Rasterwert wäre ein zweites Vorzeichen-
    // Vokabular und ein falscher Default im Workshop-Formular.
    assert.ok(RSI_MEAN_REVERSION_PARAMS.ema21GapPct.min > 0, "der Raster bleibt positiv");
    for (const value of gridOf(RSI_MEAN_REVERSION_PARAMS.ema21GapPct)) {
      const condition = conditionsOf(rsiMeanReversionRule(paramsWith({ ema21GapPct: value })))[1];
      assert.equal(condition.field, "priceVsEma21Pct");
      assert.equal(condition.op, "lte");
      assert.equal(condition.value, -value);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) Reinheit und Determinismus
// ─────────────────────────────────────────────────────────────────────────────

describe("buildRule ist eine reine, deterministische Funktion der Parameter", () => {
  test("zwei Aufrufe mit denselben Defaults sind tiefengleich", () => {
    const first = rsiMeanReversionRule(RSI_MEAN_REVERSION_DEFAULTS);
    const second = rsiMeanReversionRule(RSI_MEAN_REVERSION_DEFAULTS);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second), "auch die Key-Reihenfolge ist stabil (Artefakt-Hash)");
  });

  test("zwei Aufrufe teilen keine Objekt-Referenzen (kein geteilter Zustand)", () => {
    const first = asRecord(rsiMeanReversionRule(RSI_MEAN_REVERSION_DEFAULTS).condition);
    const second = asRecord(rsiMeanReversionRule(RSI_MEAN_REVERSION_DEFAULTS).condition);
    assert.notEqual(first, second);
    assert.notEqual(first.conditions, second.conditions);
    assert.deepEqual(first, second);
  });

  test("der Builder verändert das übergebene params-Objekt nicht", () => {
    const params: Record<string, number> = { ...RSI_MEAN_REVERSION_DEFAULTS };
    const before = { ...params };
    rsiMeanReversionRule(params);
    assert.deepEqual(params, before);
  });

  test("unbekannte Schlüssel erreichen die Regel nicht", () => {
    const withExtras = paramsWith({});
    withExtras.riskBudgetPct = 0.5; // ein Schlüssel, den das Template nicht kennt
    withExtras.adxMin = 25; // der Trend-Parameter von nebenan
    assert.deepEqual(rsiMeanReversionRule(withExtras), rsiMeanReversionRule(RSI_MEAN_REVERSION_DEFAULTS));
    assert.equal(
      asRecord(rsiMeanReversionRule(withExtras).action).riskBudgetPct,
      0.01,
      "ein params-Schlüssel darf ein festes Guardrail nicht überschreiben",
    );
  });

  test("fehlende oder nicht endliche Parameter sind ein Wurf, kein Default", () => {
    for (const bad of [undefined, null, NaN, Infinity, "30", {}, []] as unknown[]) {
      const params: Record<string, unknown> = { ...RSI_MEAN_REVERSION_DEFAULTS, rsiOversold: bad };
      assert.throws(
        () => rsiMeanReversionRule(params as Record<string, number>),
        /rsiOversold/,
        `Wert ${String(bad)} darf nicht still durchgehen`,
      );
    }
    const partial: Record<string, number> = { ...RSI_MEAN_REVERSION_DEFAULTS };
    delete partial.adxMax;
    assert.throws(() => rsiMeanReversionRule(partial), /adxMax/);
  });

  test("ein Wert außerhalb des Bereichs ist **kein** Builder-Problem (Grenzen prüft der Katalog)", () => {
    const raw = rsiMeanReversionRule(paramsWith({ rsiOversold: 99 }));
    assert.equal(conditionsOf(raw)[0].value, 99);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) Akzeptanzkriterium 2 — Klemmfreiheit über das ganze Raster
// ─────────────────────────────────────────────────────────────────────────────

describe("Guardrails: kein Rasterpunkt wird geklemmt", () => {
  const ACTION_KEYS = ["stopLossPct", "takeProfitRR", "riskBudgetPct", "maxPositionPct"] as const;
  const WINDOW_KEYS = ["maxExecutionsPerDay", "cooldownMinutes", "volumeWindow"] as const;

  test("die Raster-Endpunkte sind die Param-Grenzen (06-02 sieht den vollen Bereich)", () => {
    for (const key of PARAM_KEYS) {
      const spec = RSI_MEAN_REVERSION_PARAMS[key];
      const points = gridOf(spec);
      assert.equal(points[0], spec.min, `${key}: unterster Rasterpunkt`);
      assert.ok(Math.abs(points[points.length - 1] - spec.max) < 1e-9, `${key}: oberster Rasterpunkt != max`);
      assert.ok(points.length >= 5, `${key}: ${points.length} Punkte sind kein Raster`);
      assert.ok(
        points.some((p) => Math.abs(p - spec.default) < 1e-9),
        `${key}: der Default ${spec.default} liegt nicht auf dem Raster`,
      );
    }
  });

  for (const key of PARAM_KEYS) {
    test(`${key}: jeder Rasterpunkt ist gültig, unverfälscht und geklemmungsfrei`, () => {
      const spec = RSI_MEAN_REVERSION_PARAMS[key];
      for (const value of gridOf(spec)) {
        const label = `${key}=${value}`;
        const variant = templateWithParam(key, value);
        // (a) Der Katalog muss den Punkt als zulässigen Default akzeptieren.
        assert.deepEqual(validateTemplate(variant), [], label);
        // (b) Jede Zahl mit Deckel liegt **innerhalb** des Deckels.
        const raw = variant.buildRule(paramsWith({ [key]: value }));
        const action = asRecord(raw.action);
        for (const actionKey of ACTION_KEYS) {
          const bounds = ceilingOf(actionKey);
          assert.ok(bounds, `RULE_CEILINGS.${actionKey} fehlt — der Test wäre blind`);
          const numeric = Number(action[actionKey]);
          assert.ok(
            numeric >= bounds!.min && numeric <= bounds!.max,
            `${label}: ${actionKey} = ${numeric} außerhalb [${bounds!.min}, ${bounds!.max}]`,
          );
        }
        // (c) Der Sanitizer verändert **nichts**: kein Klemmen, kein Runden,
        //     kein Verwerfen einer Bedingung.
        const sanitized = sanitize(paramsWith({ [key]: value }));
        const windowRaw = asRecord(raw.window);
        const windowSpec = sanitized.window as unknown as Record<string, unknown>;
        for (const actionKey of ACTION_KEYS) {
          assert.equal(sanitized.action[actionKey], action[actionKey], `${label}: sanitize klemmt action.${actionKey}`);
        }
        for (const windowKey of WINDOW_KEYS) {
          assert.equal(windowSpec[windowKey], windowRaw[windowKey], `${label}: sanitize klemmt window.${windowKey}`);
        }
        const rawConditions = conditionsOf(raw);
        assert.equal(
          sanitized.condition.conditions.length,
          rawConditions.length,
          `${label}: eine Bedingung fiel durch die Whitelist`,
        );
        rawConditions.forEach((item, index) => {
          assert.deepEqual(sanitized.condition.conditions[index], item, `${label}: Bedingung ${index} wurde verändert`);
        });
        // (d) Der Operator bleibt `lte` — auch an den Rasterenden.
        const adx = sanitized.condition.conditions.find((c) => c.field === "adx14");
        assert.equal(adx?.op, "lte", `${label}: adx14-Operator gekippt`);
      }
    });
  }

  test("die Action-Deckel sind die aus LIMIT_CEILINGS abgeleiteten (Nachrechnung)", () => {
    assert.deepEqual(ceilingOf("stopLossPct"), {
      min: LIMIT_CEILINGS.defaultStopLossPct[0] * 100,
      max: LIMIT_CEILINGS.defaultStopLossPct[1] * 100,
    });
    assert.deepEqual(ceilingOf("takeProfitRR"), {
      min: LIMIT_CEILINGS.takeProfitRR[0],
      max: LIMIT_CEILINGS.takeProfitRR[1],
    });
    assert.ok(
      RSI_MEAN_REVERSION_PARAMS.stopLossPct.min >= ceilingOf("stopLossPct")!.min &&
        RSI_MEAN_REVERSION_PARAMS.stopLossPct.max <= ceilingOf("stopLossPct")!.max,
      "stopLossPct-Bereich ragt über RULE_CEILINGS hinaus",
    );
    assert.ok(
      RSI_MEAN_REVERSION_PARAMS.takeProfitRR.min >= ceilingOf("takeProfitRR")!.min &&
        RSI_MEAN_REVERSION_PARAMS.takeProfitRR.max <= ceilingOf("takeProfitRR")!.max,
      "takeProfitRR-Bereich ragt über RULE_CEILINGS hinaus",
    );
  });

  test("auch die verschachtelten Fenster-Grenzen sind Teilbereiche der Deckel", () => {
    const window = asRecord(rsiMeanReversionRule(RSI_MEAN_REVERSION_DEFAULTS).window);
    for (const key of WINDOW_KEYS) {
      const bounds = ceilingOf(key);
      assert.ok(bounds, `RULE_CEILINGS.${key} fehlt`);
      assert.ok(
        Number(window[key]) >= bounds!.min && Number(window[key]) <= bounds!.max,
        `${key} = ${String(window[key])} außerhalb [${bounds!.min}, ${bounds!.max}]`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8) Katalog-Grenzen: der Parameterraum ist dort verteidigt, wo er hingehört
// ─────────────────────────────────────────────────────────────────────────────

describe("die Parametergrenzen gehören in den Katalog, nicht in den Builder", () => {
  test("`rsiOversold: 99` scheitert in validateTemplate — genau ein Fehler", () => {
    const errors = validateTemplate(templateWithParam("rsiOversold", 99));
    assert.equal(errors.length, 1, errors.join(" | "));
    assert.match(errors[0], /params\.rsiOversold: default \(99\) muss ≤ max \(40\) sein/);
  });

  test("der Sanitizer ließe 99 durch — Beweis, dass die Grenze woanders stehen muss", () => {
    const spec = sanitize(paramsWith({ rsiOversold: 99 }));
    assert.equal(spec.condition.conditions[0].value, 99, "kein Deckel auf rsi14: der Wert überlebt die ganze Kette");
    assert.equal(ceilingOf("rsi14"), null, "es gibt keinen RULE_CEILINGS-Schlüssel rsi14");
  });

  test("unterhalb von min lehnt der Katalog ab (rsiOversold: 10, adxMax: 5, volumeRatioMin: 0.5)", () => {
    for (const [key, value] of [
      ["rsiOversold", 10],
      ["adxMax", 5],
      ["volumeRatioMin", 0.5],
    ] as Array<[RsiMeanReversionParamKey, number]>) {
      const errors = validateTemplate(templateWithParam(key, value));
      assert.equal(errors.length, 1, `${key}: ${errors.join(" | ")}`);
      const spec = RSI_MEAN_REVERSION_PARAMS[key];
      assert.match(
        errors[0],
        new RegExp(`params\\.${key}: min \\(${spec.min}\\) muss ≤ default \\(${value}\\) sein`),
      );
    }
  });

  test("ein Wert **am** Rand ist gültig (die Grenze ist inklusiv)", () => {
    for (const [key, value] of [
      ["rsiOversold", 15],
      ["rsiOversold", 40],
      ["adxMax", 10],
      ["adxMax", 30],
      ["stopLossPct", 1],
      ["stopLossPct", 15],
      ["takeProfitRR", 1],
      ["takeProfitRR", 4],
    ] as Array<[RsiMeanReversionParamKey, number]>) {
      assert.deepEqual(validateTemplate(templateWithParam(key, value)), [], `${key}=${value}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9) Semantik — die Regel tut, was der Kopf des Templates behauptet
// ─────────────────────────────────────────────────────────────────────────────

describe("Semantik der vier Bedingungen (kompiliert, echte Snapshot-Pfade)", () => {
  const compiledWith = (params: Record<string, number>) => compileRuleSpec(sanitize(params));
  const compiled = () => compiledWith(RSI_MEAN_REVERSION_DEFAULTS);

  test("Range mit Abverkauf löst aus — alle vier Felder aus dem echten Snapshot", () => {
    const snapshot = buildSnapshotFromCandles("BTC", rangeSelloffSeries());
    assert.ok(snapshot);
    assert.ok((snapshot.rsi14 ?? 100) <= 30, `RSI muss überverkauft sein, ist ${snapshot.rsi14}`);
    assert.ok((snapshot.priceVsEma21Pct ?? 0) <= -1, `Kurs unter EMA 21, ist ${snapshot.priceVsEma21Pct}`);
    assert.ok((snapshot.adx14 ?? 100) <= 20, `ADX muss seitwärts sein, ist ${snapshot.adx14}`);
    assert.ok((snapshot.volumeRatio ?? 0) >= 1.1, `Volumen über dem Schnitt, ist ${snapshot.volumeRatio}`);
    assert.equal(compiled().evaluate(snapshot), true);
  });

  test("Falling Knife: monotoner Abwärtstrend erfüllt RSI, EMA-21 und Volumen — der ADX-Filter bremst", () => {
    // Der Kern der DOK-PFLICHT 1: RSI(14) fällt in der fallenden Reihe auf ~0,
    // der Kurs liegt weit unter dem EMA 21, das Volumen ist über dem Schnitt.
    // Ohne `adx14 lte` wäre das ein Einstieg in einen laufenden Abverkauf.
    const snapshot = buildSnapshotFromCandles("BTC", downSeries(120, 0.997));
    assert.ok(snapshot);
    assert.ok((snapshot.rsi14 ?? 100) < 30, `RSI überverkauft, ist ${snapshot.rsi14}`);
    assert.ok((snapshot.priceVsEma21Pct ?? 0) < -1, `Kurs unter EMA 21, ist ${snapshot.priceVsEma21Pct}`);
    assert.ok((snapshot.volumeRatio ?? 0) >= 1.1, `Volumenbestätigung fehlt nicht, ist ${snapshot.volumeRatio}`);
    assert.ok((snapshot.adx14 ?? 0) > 30, `der Abwärtstrend muss einen hohen ADX haben, ist ${snapshot.adx14}`);
    assert.equal(compiled().evaluate(snapshot), false, "nur der ADX-Filter darf hier bremsen");
    // Und selbst das obere Rasterende (adxMax = 30) reicht nicht: ein echter
    // Trend ist kein Seitwärtsmarkt, auch nicht bei der lockersten Schwelle.
    assert.equal(compiledWith(paramsWith({ adxMax: 30 })).evaluate(snapshot), false);
  });

  test("derselbe Snapshot mit niedrigem ADX würde auslösen — der Filter ist lastend, nicht dekorativ", () => {
    const snapshot = buildSnapshotFromCandles("BTC", downSeries(120, 0.997));
    assert.ok(snapshot);
    const asRange = { ...snapshot, adx14: 15 } as unknown as RuleSnapshot;
    assert.equal(compiled().evaluate(asRange), true, "mit ADX 15 ist es ein Range-Setup");
    assert.equal(compiled().evaluate(snapshot), false, "mit dem echten ADX nicht");
  });

  test("Range ohne Überdehnung löst nicht aus (flache Reihe: kein RSI, kein Abstand, kein Volumen)", () => {
    const snapshot = buildSnapshotFromCandles("BTC", flatSeries(120));
    assert.ok(snapshot);
    assert.equal(snapshot.trend, "FLAT");
    assert.ok(Math.abs(snapshot.priceVsEma21Pct ?? 0) < 0.3, "der Kurs liegt auf seinem EMA 21");
    assert.equal(compiled().evaluate(snapshot), false);
  });

  test("handgebaute Snapshots: jede der vier Bedingungen kann den Auslöser einzeln kosten", () => {
    assert.equal(compiled().evaluate(snapshotWith({})), true, "Referenzfall löst aus");

    // 1) RSI — inklusiv (`lte`)
    assert.equal(compiled().evaluate(snapshotWith({ rsi14: 30 })), true, "genau auf der Schwelle zählt als überverkauft");
    assert.equal(compiled().evaluate(snapshotWith({ rsi14: 30.01 })), false);
    assert.equal(compiled().evaluate(snapshotWith({ rsi14: 50 })), false, "der RSI-Ersatzwert löst nicht aus");

    // 2) EMA-21-Abstand — inklusiv (`lte`), negiert
    assert.equal(compiled().evaluate(snapshotWith({ priceVsEma21Pct: -1 })), true, "genau -1 % ist die Schwelle");
    assert.equal(compiled().evaluate(snapshotWith({ priceVsEma21Pct: -0.99 })), false);
    assert.equal(compiled().evaluate(snapshotWith({ priceVsEma21Pct: 2 })), false, "Kurs über dem Mittel ist kein Setup");

    // 3) ADX — Deckel, inklusiv (`lte`)
    assert.equal(compiled().evaluate(snapshotWith({ adx14: 20 })), true, "adxMax ist inklusiv");
    assert.equal(compiled().evaluate(snapshotWith({ adx14: 20.01 })), false);
    assert.equal(compiled().evaluate(snapshotWith({ adx14: null })), false, "null (Warm-up) ist fail-closed");

    // 4) Volumen — inklusiv (`gte`)
    assert.equal(compiled().evaluate(snapshotWith({ volumeRatio: 1.1 })), true, "volumeRatioMin ist inklusiv");
    assert.equal(compiled().evaluate(snapshotWith({ volumeRatio: 1.09 })), false);
  });

  test("die Raster-Enden verschieben den Auslöser messbar (06-02 sieht den Bereich)", () => {
    const snapshot = snapshotWith({ rsi14: 35, priceVsEma21Pct: -3, adx14: 25, volumeRatio: 2 });
    assert.equal(compiled().evaluate(snapshot), false, "der Default ist strenger");
    const loose = compiledWith(
      paramsWith({ rsiOversold: 40, ema21GapPct: 0.3, adxMax: 30, volumeRatioMin: 0.8 }),
    );
    assert.equal(loose.evaluate(snapshot), true, "das lockere Ende lässt denselben Snapshot zu");
    const strict = compiledWith(
      paramsWith({ rsiOversold: 15, ema21GapPct: 5, adxMax: 10, volumeRatioMin: 2.5 }),
    );
    assert.equal(strict.evaluate(snapshot), false);
  });

  test("die Regel ist im Backtest-Pfad dieselbe (sanitize ⇒ compile, keine Engine-Sonderfälle)", () => {
    const spec = sanitize(RSI_MEAN_REVERSION_DEFAULTS);
    assert.equal(spec.window.timeframe, "1h");
    assert.equal(spec.action.side, "LONG");
    assert.equal(spec.symbol, "BTC");
    assert.equal(spec.condition.logic, "all");
    assert.equal(spec.condition.conditions.length, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10) RSI-Warm-up: 15 Schlusskurse und der Ersatzwert 50 (Doku-Pflicht DATA)
// ─────────────────────────────────────────────────────────────────────────────

describe("RSI-Warm-up: 15 Schlusskurse, Ersatzwert 50 — und warum er hier nicht zuschnappt", () => {
  test("`rsi()` verlangt period + 1 Werte und liefert darunter 50 (im Bestand nachgelesen)", () => {
    assert.match(
      INDICATORS_SOURCE,
      /if \(values\.length < period \+ 1\) return 50;/,
      "der RSI-Warm-up-Wert im Bestand hat sich geändert — die Annahme muss nachgezogen werden",
    );
  });

  test("der gesamte `rsiOversold`-Bereich liegt unter dem Ersatzwert 50", () => {
    // Das ist die eigentliche Sicherheitsaussage: Der Warm-up-Wert ist kein
    // `null`, sondern eine Zahl — und sie darf die Bedingung an keinem
    // Rasterpunkt erfüllen. Sonst würde auf einer erfundenen Zahl gehandelt.
    const spec = RSI_MEAN_REVERSION_PARAMS.rsiOversold;
    assert.ok(
      spec.max < 50,
      `rsiOversold.max (${spec.max}) muss unter dem RSI-Ersatzwert 50 bleiben`,
    );
    for (const value of gridOf(spec)) {
      assert.ok(value < 50, `Rasterpunkt ${value} würde auf dem Ersatzwert auslösen`);
      assert.equal(compileRuleSpec(sanitize(paramsWith({ rsiOversold: value }))).evaluate(snapshotWith({ rsi14: 50 })), false);
    }
  });

  test("im Snapshot-Pfad ist der Ersatzwert ohnehin unerreichbar (25 Kerzen ≥ 15)", () => {
    // `buildSnapshotFromCandles` verlangt 25 Kerzen, der RSI nur 15 — die Falle
    // sitzt ausschließlich in Direktaufrufen des Indikators.
    assert.equal(buildSnapshotFromCandles("BTC", downSeries(24, 0.999)), null, "unter 25 Kerzen kein Snapshot");
    const snapshot = buildSnapshotFromCandles("BTC", downSeries(25, 0.999));
    assert.ok(snapshot, "ab 25 Kerzen existiert der Snapshot");
    assert.notEqual(snapshot.rsi14, 50, "mit 25 Kerzen ist der RSI echt gerechnet");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11) Gesperrt — was dieser Prompt nicht darf
// ─────────────────────────────────────────────────────────────────────────────

describe("Sperren des Prompts (statische Wächter)", () => {
  test("kein SHORT, kein bbZScore, keine Sequenz-/Reclaim-Logik, kein `any`", () => {
    assert.doesNotMatch(TEMPLATE_SOURCE, /side:\s*["']SHORT["']/, "Shorts sind im Code global gesperrt");
    assert.doesNotMatch(TEMPLATE_SOURCE, /field:\s*["']bbZScore["']/, "bbZScore kommt in 03-06");
    assert.doesNotMatch(TEMPLATE_SOURCE, /mapsTo:\s*["']bbZScore["']/);
    assert.doesNotMatch(TEMPLATE_SOURCE, /op:\s*["'](RECLAIM|CROSS|SEQUENCE)["']/, "Sequenz-Logik ist Engine-Arbeit");
    assert.doesNotMatch(TEMPLATE_SOURCE, /logic:\s*["']any["']/, "die Bedingungen sind eine Konjunktion");
    assert.doesNotMatch(TEMPLATE_SOURCE, /:\s*any\b/);
  });

  test("Doku-Pflicht 3: das Fehlen von `bbZScore` ist begründet und die Reihenfolge notiert", () => {
    assert.match(TEMPLATE_SOURCE, /DOK-PFLICHT 3/, "die Doku-Pflicht muss als solche stehen");
    assert.match(TEMPLATE_SOURCE, /Reihenfolge-Abhängigkeit/, "die Reihenfolge-Abhängigkeit fehlt");
    assert.match(TEMPLATE_SOURCE, /02-02/, "die Abhängigkeit von STX-02-02 muss benannt sein");
    assert.match(TEMPLATE_SOURCE, /03-06/, "der Ort der Bollinger-Lage (bollinger-squeeze) muss benannt sein");
    assert.match(TEMPLATE_SOURCE, /normalisiert/, "der fachliche Vorzug des Z-Score muss benannt sein");
    assert.match(TEMPLATE_SOURCE, /Versionserhöhung/, "eine Nachrüstung ist eine Semantikänderung");
  });

  test("Doku-Pflicht 2: das kleinere Chance/Risiko-Verhältnis ist begründet", () => {
    assert.match(TEMPLATE_SOURCE, /DOK-PFLICHT 2/);
    assert.match(TEMPLATE_SOURCE, /`takeProfitRR` hier 1\.5 ist, nicht 2/);
    assert.match(TEMPLATE_SOURCE, /Trefferquote/, "die Odds-Ratio-Begründung fehlt");
    assert.equal(RSI_MEAN_REVERSION_PARAMS.takeProfitRR.default, 1.5);
    assert.ok(
      RSI_MEAN_REVERSION_PARAMS.takeProfitRR.default < 2,
      "das Ziel muss kleiner sein als in den Trend-Vorlagen (03-03/03-04: 2)",
    );
    assert.equal(asRecord(macdMomentumRule(MACD_MOMENTUM_DEFAULTS).action).takeProfitRR, 2);
    assert.equal(asRecord(emaAdxTrendRule(EMA_ADX_TREND_DEFAULTS).action).takeProfitRR, 2);
  });

  test("keine Regime-Gate-Änderung: das Template schreibt keine Faktoren und keinen Modus", () => {
    assert.doesNotMatch(TEMPLATE_SOURCE, /gateFactors\s*=/, "ein Template setzt keine Gate-Faktoren");
    assert.doesNotMatch(TEMPLATE_SOURCE, /gateMode\s*=/, "ein Template setzt keinen Gate-Modus");
    assert.doesNotMatch(TEMPLATE_SOURCE, /parseGateFactors\s*\(/, "ein Template parsed keine Faktoren");
    assert.doesNotMatch(TEMPLATE_SOURCE, /applyRegimeGate\s*\(/, "ein Template wendet das Gate nicht selbst an");
    assert.doesNotMatch(TEMPLATE_SOURCE, /regimeGateFactor\s*\(/, "ein Template rechnet keine Faktoren (nur gelesen)");
  });

  test("keine Engine-Arbeit: Deckel werden nicht geschrieben, die Importe bleiben rein", () => {
    assert.doesNotMatch(TEMPLATE_SOURCE, /RULE_CEILINGS\s*=[^=]/, "ein Template definiert keine Deckel");
    assert.doesNotMatch(TEMPLATE_SOURCE, /LIMIT_CEILINGS\s*=[^=]/);
    assert.doesNotMatch(TEMPLATE_SOURCE, /RULE_FIELDS\s*=[^=]/, "ein Template erweitert kein Regel-Vokabular");
    for (const forbidden of [
      /from "@\/lib\/(ollama|llmProvider|engine|microExecutor|ruleService|marketRegime|signalDecay)"/,
      /from "@\/db\//,
      /from "pg"/,
      /node:(fs|net|http|child_process)/,
      /Math\.random/,
      /Date\.now/,
      /new Date\(/,
    ]) {
      assert.doesNotMatch(TEMPLATE_SOURCE, forbidden, `verbotener Pfad im Template: ${forbidden.source}`);
    }
  });

  test("kein zweites Vokabular in src/strategies (ADR-008/ADR-009)", () => {
    assert.doesNotMatch(TEMPLATE_SOURCE, /type\s+\w+\s*=\s*(?:\|\s*)?["'](?:mean-reversion|trend|breakout)["']/);
    // Derselbe Wächter wie in `tests/adrVocabulary.test.ts` (ADR-008): auch ein
    // Bracket-Index wie `POLICIES["mean-reversion"]` fällt darunter — die Klasse
    // wird deklariert, nie als Schlüssel nachgeschlagen.
    assert.doesNotMatch(TEMPLATE_SOURCE, /\[\s*["']mean-reversion["']/, "keine eigene Klassenliste");
    assert.doesNotMatch(TEMPLATE_SOURCE, /["']unclassified["']\s*,\s*["']/);
    assert.doesNotMatch(TEMPLATE_SOURCE, /=\s*\[\s*["']RANGE["']/, "erwartete Regime sind keine eigene Liste im Template");
    assert.match(TEMPLATE_SOURCE, /from "\.\.\/types"/, "der Vertrag kommt aus types.ts");
  });

  test("die Engine-Deckel und Feldtypen bleiben unverändert (Katalog und Template lesen nur)", () => {
    const ceilings = JSON.stringify(RULE_CEILINGS);
    const fields = JSON.stringify(RULE_FIELDS.rsi14 + RULE_FIELDS.priceVsEma21Pct);
    validateTemplate(buildRsiMeanReversion());
    rsiMeanReversionRule(RSI_MEAN_REVERSION_DEFAULTS);
    sanitize(RSI_MEAN_REVERSION_DEFAULTS);
    assert.equal(JSON.stringify(RULE_CEILINGS), ceilings);
    assert.equal(JSON.stringify(RULE_FIELDS.rsi14 + RULE_FIELDS.priceVsEma21Pct), fields);
  });

  test("kein Backtest-Lauf in 03-05 (der kommt in 03-10)", () => {
    assert.doesNotMatch(TEMPLATE_SOURCE, /from "@\/backtest\/|from "@\/lib\/ruleBacktest|runBacktest\s*\(/);
  });
});
