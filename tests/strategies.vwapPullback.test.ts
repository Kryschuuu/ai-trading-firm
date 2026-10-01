/** STX-03-07 — VWAP-Bias-Snapshot: Vertrag, Datenhorizont und Sanitize-Kette. */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  VWAP_PCT_RELIABLE_TIMEFRAMES,
  VWAP_PULLBACK_DEFAULTS,
  VWAP_PULLBACK_ID,
  VWAP_PULLBACK_PARAMS,
  VWAP_PULLBACK_TIMEFRAMES,
  buildVwapPullback,
  vwapPullbackRule,
} from "../src/strategies/templates/vwap-pullback";
import {
  STRATEGY_TEMPLATES,
  assertTemplatesValid,
  getTemplate,
  validateTemplate,
} from "../src/strategies/catalog";
import { sanitizeRuleSpec } from "../src/lib/ruleEngine";
import type { ParamSpec } from "../src/strategies/types";

function sanitize(params: Readonly<Record<string, number>> = VWAP_PULLBACK_DEFAULTS) {
  const result = sanitizeRuleSpec({ ...vwapPullbackRule(params), symbol: "BTC" });
  assert.ok(result.ok, result.ok ? "" : result.errors.join(" | "));
  return result.spec;
}

describe("VWAP-Bias: Template-Vertrag und Registry", () => {
  test("validateTemplate liefert [] und Registry enthält genau den fünften Eintrag", () => {
    const template = buildVwapPullback();
    assert.deepEqual(validateTemplate(template), []);
    assert.doesNotThrow(() => assertTemplatesValid());
    assert.equal(getTemplate(VWAP_PULLBACK_ID), STRATEGY_TEMPLATES[4]);
    assert.equal(STRATEGY_TEMPLATES.filter((entry) => entry.id === VWAP_PULLBACK_ID).length, 1);
    assert.deepEqual(getTemplate(VWAP_PULLBACK_ID), template);
    assert.equal(template.class, "trend");
    assert.deepEqual(template.expectedRegimes, ["TREND_UP"]);
  });

  test("Timeframes sind exakt 5m/15m/1h und Teil der exportierten VWAP-Eignungsmenge", () => {
    const template = buildVwapPullback();
    const reliable = new Set<string>(VWAP_PCT_RELIABLE_TIMEFRAMES);
    assert.deepEqual(template.supportedTimeframes, ["5m", "15m", "1h"]);
    assert.deepEqual(template.supportedTimeframes, VWAP_PULLBACK_TIMEFRAMES);
    for (const timeframe of template.supportedTimeframes) {
      assert.ok(reliable.has(timeframe), `${timeframe} ist nicht als belastbarer VWAP-Takt dokumentiert`);
    }
    assert.equal(template.supportedTimeframes.includes("4h"), false);
    assert.equal(template.supportedTimeframes.includes("1d"), false);
    assert.equal(reliable.has("4h"), false);
    assert.equal(reliable.has("1d"), false);
  });

  test("requiredFields und Annahmen bilden UTC-Anker, Markt, Execution und Kosten ab", () => {
    const template = buildVwapPullback();
    assert.deepEqual(template.requiredFields, [
      "trend", "vwapPct", "volumeRatio", "priceVsEma21Pct", "atrPct",
    ]);
    assert.ok(template.assumptions.length >= 4);
    for (const category of ["DATA", "MARKET", "EXECUTION", "COST"] as const) {
      assert.ok(template.assumptions.some((item) => item.category === category), category);
    }
    assert.equal(template.assumptions.find((item) => item.id === "utc-tag-statt-boersensession")?.critical, true);
    assert.equal(template.assumptions.find((item) => item.id === "fortsetzung-ueber-vwap")?.critical, false);
    assert.equal(template.assumptions.find((item) => item.id === "historischer-vwap-kein-fill")?.critical, true);
    assert.equal(template.assumptions.find((item) => item.id === "intraday-kosten")?.critical, true);
    assert.match(template.name, /kein Pullback/);
    assert.match(template.description, /keine Pullback-\/Reclaim-Sequenz/);
  });

  test("Parameterraster entspricht dem Auftrag", () => {
    const expected: Readonly<Record<string, Omit<ParamSpec, "key" | "kind">>> = {
      vwapMinPct: { label: "Kurs mind. über VWAP", unit: "%", default: 0.1, min: -0.5, max: 2, step: 0.05, mapsTo: "vwapPct" },
      ema21BufferPct: { label: "Kurs über EMA 21", unit: "%", default: 0.1, min: -1, max: 3, step: 0.1, mapsTo: "priceVsEma21Pct" },
      volumeRatioMin: { label: "Volumenverhältnis", unit: "ratio", default: 1.1, min: 0.8, max: 2.5, step: 0.05, mapsTo: "volumeRatio" },
      stopLossPct: { label: "Stop-Loss", unit: "%", default: 3, min: 0.5, max: 10, step: 0.25, mapsTo: "atrPct" },
      takeProfitRR: { label: "Chance/Risiko", unit: "ratio", default: 2, min: 1, max: 4, step: 0.25, mapsTo: "atrPct" },
    };
    assert.deepEqual(Object.keys(VWAP_PULLBACK_PARAMS), Object.keys(expected));
    for (const [key, spec] of Object.entries(VWAP_PULLBACK_PARAMS)) {
      const { kind: _kind, key: _key, ...actual } = spec;
      assert.deepEqual(actual, expected[key]);
    }
    assert.deepEqual(VWAP_PULLBACK_DEFAULTS, {
      vwapMinPct: 0.1,
      ema21BufferPct: 0.1,
      volumeRatioMin: 1.1,
      stopLossPct: 3,
      takeProfitRR: 2,
    });
  });
});

describe("VWAP-Bias: Snapshot-Regel und unveränderte Sanitize-Kette", () => {
  test("Defaults erzeugen genau vier Bedingungen mit logic all", () => {
    const raw = vwapPullbackRule(VWAP_PULLBACK_DEFAULTS);
    assert.deepEqual(raw.condition, {
      logic: "all",
      conditions: [
        { field: "trend", op: "eq", value: "UP" },
        { field: "vwapPct", op: "gte", value: 0.1 },
        { field: "priceVsEma21Pct", op: "gte", value: 0.1 },
        { field: "volumeRatio", op: "gte", value: 1.1 },
      ],
    });
    assert.equal(raw.symbol, undefined);
    assert.deepEqual(sanitize(), { ...raw, symbol: "BTC" }, "keine Klemmung oder Default-Reparatur");
  });

  test("Fenster und Risiko entsprechen dem Snapshot-Auftrag", () => {
    const spec = sanitize();
    assert.deepEqual(spec.window, {
      timeframe: "15m",
      validFrom: null,
      validUntil: null,
      maxExecutionsPerDay: 3,
      cooldownMinutes: 120,
      volumeWindow: 20,
    });
    assert.equal(spec.action.stopLossPct, 3);
    assert.equal(spec.action.takeProfitRR, 2);
  });

  test("fehlende Parameter scheitern und die Rohform enthält keine Trigger-/Sequenzsemantik", () => {
    assert.throws(() => vwapPullbackRule({}), /Parameter/);
    const encoded = JSON.stringify(vwapPullbackRule(VWAP_PULLBACK_DEFAULTS));
    assert.doesNotMatch(encoded, /RECLAIM|CROSS|sequence|trigger/i);
  });
});
