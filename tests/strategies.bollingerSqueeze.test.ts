/**
 * STX-03-06 — Bollinger-Squeeze: Vertrag, unveränderte Sanitize-Kette,
 * Parameterraster, σ-Semantik und Snapshot-Grenzen. DB-/LLM-/netzfrei.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  BOLLINGER_SQUEEZE_DEFAULTS,
  BOLLINGER_SQUEEZE_ID,
  BOLLINGER_SQUEEZE_PARAMS,
  BOLLINGER_SQUEEZE_TIMEFRAMES,
  BOLLINGER_SQUEEZE_VERSION,
  bollingerSqueezeRule,
  buildBollingerSqueeze,
  type BollingerSqueezeParamKey,
} from "../src/strategies/templates/bollinger-squeeze";
import {
  STRATEGY_TEMPLATES,
  assertTemplatesValid,
  getTemplate,
  templateByField,
  validateTemplate,
} from "../src/strategies/catalog";
import type { ParamSpec } from "../src/strategies/types";
import {
  RULE_ALLOWED_SIDE,
  RULE_CEILINGS,
  buildSnapshotFromCandles,
  compileRuleSpec,
  sanitizeRuleSpec,
} from "../src/lib/ruleEngine";
import type { CandleLike, RuleSnapshot, RuleSpec } from "../src/lib/ruleEngine";
import { RULE_FIELDS } from "../src/lib/ruleFieldCatalog";
import { bollingerBands, bollingerPosition } from "../src/lib/indicators";

const TEMPLATE_SOURCE = readFileSync(
  path.join(process.cwd(), "src/strategies/templates/bollinger-squeeze.ts"),
  "utf8",
);
const PARAM_KEYS = Object.keys(BOLLINGER_SQUEEZE_PARAMS) as BollingerSqueezeParamKey[];

/** Genau der spätere Compiler-Pfad: Rohform + Symbol des Aufrufers → Sanitizer. */
function sanitize(params: Readonly<Record<string, number>> = BOLLINGER_SQUEEZE_DEFAULTS): RuleSpec {
  const result = sanitizeRuleSpec({ ...bollingerSqueezeRule(params), symbol: "BTC" });
  assert.ok(result.ok, result.ok ? "" : result.errors.join(" | "));
  return result.spec;
}

function gridOf(spec: ParamSpec): number[] {
  const steps = Math.round((spec.max - spec.min) / spec.step);
  return Array.from({ length: steps + 1 }, (_, i) => Number((spec.min + i * spec.step).toFixed(8)));
}

/** Deterministische, leicht steigende Reihe mit Volumenbestätigung am Ende. */
function candles(bars: number, drift = 0.1): CandleLike[] {
  return Array.from({ length: bars }, (_, i) => {
    const close = 100 + i * drift;
    return {
      time: 1_700_000_000_000 + i * 3_600_000,
      open: close - drift,
      high: close + 0.05,
      low: close - drift - 0.05,
      close,
      volume: i === bars - 1 ? 200 : 100,
    };
  });
}

const BASE_SNAPSHOT = buildSnapshotFromCandles("BTC", candles(60), 20);
assert.ok(BASE_SNAPSHOT);

/** Alle vier Filter auf ihrer inklusiven Schwelle; andere Felder aus dem echten Snapshot. */
function snapshotWith(overrides: Partial<RuleSnapshot> = {}): RuleSnapshot {
  return {
    ...BASE_SNAPSHOT!,
    bbwPct: 6,
    bbZScore: 0.5,
    adx14: 22,
    volumeRatio: 1.2,
    ...overrides,
  };
}

describe("Bollinger-Squeeze: Template-Vertrag und Registry", () => {
  test("validateTemplate liefert [] und Import-Zeit-Prüfung bleibt gültig", () => {
    assert.deepEqual(validateTemplate(buildBollingerSqueeze()), []);
    assert.doesNotThrow(() => assertTemplatesValid());
  });

  test("genau ein Eintrag an vierter Stelle mit expliziter Breakout-Klasse", () => {
    const template = buildBollingerSqueeze();
    const entry = getTemplate(BOLLINGER_SQUEEZE_ID);
    assert.ok(entry);
    assert.equal(entry, STRATEGY_TEMPLATES[3]);
    assert.equal(STRATEGY_TEMPLATES.filter((t) => t.id === BOLLINGER_SQUEEZE_ID).length, 1);
    assert.deepEqual(entry, template);
    assert.equal(template.id, "bollinger-squeeze");
    assert.equal(template.version, BOLLINGER_SQUEEZE_VERSION);
    assert.equal(template.version, 1);
    assert.equal(template.class, "breakout");
    assert.equal(template.scope, "SINGLE_SYMBOL");
    assert.deepEqual(template.supportedTimeframes, ["1h", "4h"]);
    assert.deepEqual(template.expectedRegimes, ["RANGE", "TREND_UP"]);
    assert.notEqual(buildBollingerSqueeze(), template, "Factory statt modulweitem Objekt");
  });

  test("requiredFields sind exakt die vorhandenen Felder aus 02-02 und dem Bestand", () => {
    const template = buildBollingerSqueeze();
    assert.deepEqual(template.requiredFields, ["bbwPct", "bbZScore", "adx14", "volumeRatio", "atrPct"]);
    for (const field of template.requiredFields) {
      assert.equal(RULE_FIELDS[field], "number", `${field} muss bereits in RULE_FIELDS existieren`);
      assert.ok(templateByField(field).includes(getTemplate(BOLLINGER_SQUEEZE_ID)!));
    }
    assert.equal(template.requiredFields.includes("priceVsUpperBbPct"), false);
  });

  test("das vollständige Parameterraster entspricht dem Auftrag", () => {
    const expected: Readonly<Record<BollingerSqueezeParamKey, Omit<ParamSpec, "key">>> = {
      bbwMaxPct: {
        kind: "threshold", label: "maximale Bandbreite (Squeeze)", unit: "%",
        default: 6, min: 2, max: 15, step: 0.25, mapsTo: "bbwPct",
      },
      bbZScoreMin: {
        kind: "threshold", label: "Kurs über oberer Bandkante", unit: "σ",
        default: 0.5, min: 0, max: 3, step: 0.1, mapsTo: "bbZScore",
      },
      adxMin: {
        kind: "threshold", label: "ADX-Bestätigung", unit: "Index",
        default: 22, min: 15, max: 35, step: 1, mapsTo: "adx14",
      },
      volumeRatioMin: {
        kind: "threshold", label: "Volumen beim Ausbruch", unit: "ratio",
        default: 1.2, min: 0.9, max: 3, step: 0.05, mapsTo: "volumeRatio",
      },
      stopLossPct: {
        kind: "threshold", label: "Stop-Loss", unit: "%",
        default: 4, min: 1, max: 12, step: 0.5, mapsTo: "atrPct",
      },
      takeProfitRR: {
        kind: "ratio", label: "Chance/Risiko", unit: "ratio",
        // Der bestehende ParamSpec-Vertrag verlangt ein Mapping; nur Risikodoku.
        default: 2.5, min: 1, max: 5, step: 0.25, mapsTo: "atrPct",
      },
    };
    assert.deepEqual(Object.keys(BOLLINGER_SQUEEZE_PARAMS).sort(), Object.keys(expected).sort());
    for (const key of PARAM_KEYS) {
      assert.deepEqual(BOLLINGER_SQUEEZE_PARAMS[key], { key, ...expected[key] });
    }
    assert.deepEqual(BOLLINGER_SQUEEZE_DEFAULTS, {
      bbwMaxPct: 6, bbZScoreMin: 0.5, adxMin: 22,
      volumeRatioMin: 1.2, stopLossPct: 4, takeProfitRR: 2.5,
    });
    assert.deepEqual(
      BOLLINGER_SQUEEZE_DEFAULTS,
      Object.fromEntries(Object.entries(buildBollingerSqueeze().params).map(([key, spec]) => [key, spec.default])),
    );
  });

  test("Regression: bbZScoreMin-Default ist ausdrücklich < 2", () => {
    assert.ok(BOLLINGER_SQUEEZE_PARAMS.bbZScoreMin.default < 2);
    assert.equal(BOLLINGER_SQUEEZE_DEFAULTS.bbZScoreMin, 0.5);
  });

  test("Pflichtannahmen und Snapshot-Vereinfachung sind kategorisiert und auditierbar", () => {
    const assumptions = buildBollingerSqueeze().assumptions;
    assert.ok(assumptions.length >= 4);
    for (const [id, category, critical, statement] of [
      ["kontraktion-vor-expansion", "MARKET", true, /Volatilitätskontraktion.*Expansion/],
      ["bbw-kalibrierung", "DATA", true, /nicht marktübergreifend.*timeframe- und regime-spezifisch/],
      ["schlusskurs-latenz", "EXECUTION", true, /Schluss der Kerze.*Schlusskurs.*Live-Pfad.*Latenzannahme/],
      ["squeeze-kosten-rr", "COST", false, /niedrige Volatilität.*R:R.*höhere Trefferzahl/],
      ["snapshot-statt-sequenz", "DATA", true, /derselben.*Kerze.*nicht als Sequenz vorher eng, jetzt weit/],
    ] as const) {
      const assumption = assumptions.find((a) => a.id === id);
      assert.ok(assumption, id);
      assert.equal(assumption.category, category, id);
      assert.equal(assumption.critical, critical, id);
      assert.match(assumption.statement, statement, id);
    }
    assert.equal(new Set(assumptions.map((a) => a.id)).size, assumptions.length);
    for (const assumption of assumptions) assert.match(assumption.id, /^[a-z0-9-]{1,64}$/);
  });
});

describe("Bollinger-Squeeze: Rohform → sanitizeRuleSpec ohne Klemmung", () => {
  test("defaults erzeugen exakt vier inklusive Bedingungen mit logic all", () => {
    const raw = buildBollingerSqueeze().buildRule(BOLLINGER_SQUEEZE_DEFAULTS);
    assert.deepEqual(raw.condition, {
      logic: "all",
      conditions: [
        { field: "bbwPct", op: "lte", value: 6 },
        { field: "bbZScore", op: "gte", value: 0.5 },
        { field: "adx14", op: "gte", value: 22 },
        { field: "volumeRatio", op: "gte", value: 1.2 },
      ],
    });
    assert.equal(raw.symbol, undefined, "das Symbol gehört dem Aufrufer");
    assert.deepEqual(sanitize(), { ...raw, symbol: "BTC" }, "keine Klemmung, Kürzung oder Default-Reparatur");
  });

  test("ohne Symbol scheitert der Sanitizer, beide unterstützten Timeframes bleiben erhalten", () => {
    const result = sanitizeRuleSpec(bollingerSqueezeRule(BOLLINGER_SQUEEZE_DEFAULTS));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((e) => e.includes("symbol")));
    for (const timeframe of BOLLINGER_SQUEEZE_TIMEFRAMES) {
      const raw = { ...sanitize(), window: { ...sanitize().window, timeframe } };
      const normalized = sanitizeRuleSpec(raw);
      assert.ok(normalized.ok);
      assert.deepEqual(normalized.spec, raw);
    }
  });

  test("Action und Fenster sind explizit, innerhalb der lebenden RULE_CEILINGS", () => {
    const spec = sanitize();
    assert.deepEqual(spec.action, {
      side: RULE_ALLOWED_SIDE, stopLossPct: 4, takeProfitRR: 2.5,
      riskBudgetPct: 0.01, maxPositionPct: 0.15, positionSizeMode: "risk",
    });
    assert.deepEqual(spec.window, {
      timeframe: "1h", validFrom: null, validUntil: null,
      maxExecutionsPerDay: 2, cooldownMinutes: 240, volumeWindow: 20,
    });
    for (const key of ["stopLossPct", "takeProfitRR"] as const) {
      assert.ok(BOLLINGER_SQUEEZE_PARAMS[key].min >= RULE_CEILINGS[key][0]);
      assert.ok(BOLLINGER_SQUEEZE_PARAMS[key].max <= RULE_CEILINGS[key][1]);
    }
    assert.equal(spec.sourceRole, "RESEARCH");
    assert.equal(spec.missionId, null);
    assert.equal(spec.riskScore, 0.5);
  });

  for (const key of PARAM_KEYS) {
    test(`jeder Rasterpunkt von ${key} bleibt gültig, unverändert und tatsächlich parametrisiert`, () => {
      const param = BOLLINGER_SQUEEZE_PARAMS[key];
      const values = gridOf(param);
      assert.equal(values[0], param.min);
      assert.equal(values.at(-1), param.max);
      for (const value of values) {
        const params = { ...BOLLINGER_SQUEEZE_DEFAULTS, [key]: value };
        const template = {
          ...buildBollingerSqueeze(),
          params: { ...BOLLINGER_SQUEEZE_PARAMS, [key]: { ...param, default: value } },
        };
        assert.deepEqual(validateTemplate(template), [], `${key}=${value}`);
        const raw = bollingerSqueezeRule(params);
        const normalized = sanitize(params);
        assert.deepEqual(normalized, { ...raw, symbol: "BTC" }, `${key}=${value}: unverändert`);
        if (key === "stopLossPct" || key === "takeProfitRR") {
          assert.equal(normalized.action[key], value);
        } else {
          assert.equal(normalized.condition.conditions.find((c) => c.field === param.mapsTo)?.value, value);
        }
      }
    });
  }

  test("auch alle 64 Kombinationen der Parametergrenzen überstehen den Sanitizer unverändert", () => {
    for (let mask = 0; mask < 2 ** PARAM_KEYS.length; mask++) {
      const params = Object.fromEntries(PARAM_KEYS.map((key, i) => [
        key, BOLLINGER_SQUEEZE_PARAMS[key][mask & (1 << i) ? "max" : "min"],
      ]));
      assert.deepEqual(sanitize(params), { ...bollingerSqueezeRule(params), symbol: "BTC" }, `Ecke ${mask}`);
    }
  });

  test("der Builder ist deterministisch, mutiert keine Eingabe und liefert frische Rohdaten", () => {
    const params = Object.freeze({ ...BOLLINGER_SQUEEZE_DEFAULTS });
    const before = { ...params };
    const first = bollingerSqueezeRule(params);
    const second = bollingerSqueezeRule(params);
    assert.deepEqual(first, second);
    assert.deepEqual(params, before);
    assert.notEqual(first, second);
    assert.notEqual(first.condition, second.condition);
    assert.notEqual(first.action, second.action);
    assert.notEqual(first.window, second.window);
  });

  test("fehlende, nicht-endliche und typfalsche Parameter scheitern statt stiller Defaults", () => {
    for (const key of PARAM_KEYS) {
      const missing: Record<string, number> = { ...BOLLINGER_SQUEEZE_DEFAULTS };
      delete missing[key];
      assert.throws(() => bollingerSqueezeRule(missing), new RegExp(key));
      for (const value of [NaN, Infinity, -Infinity, undefined, null, "1", {}, []]) {
        const params = { ...BOLLINGER_SQUEEZE_DEFAULTS, [key]: value } as unknown as Record<string, number>;
        assert.throws(() => bollingerSqueezeRule(params), new RegExp(key));
      }
    }
  });

  test("der Builder klemmt keine Rohwerte; ungültige Parameterdefaults scheitern im Katalog", () => {
    const params = { ...BOLLINGER_SQUEEZE_DEFAULTS, stopLossPct: 99 };
    const raw = bollingerSqueezeRule(params);
    assert.equal((raw.action as Record<string, unknown>).stopLossPct, 99);
    const errors = validateTemplate({
      ...buildBollingerSqueeze(),
      params: { ...BOLLINGER_SQUEEZE_PARAMS, stopLossPct: { ...BOLLINGER_SQUEEZE_PARAMS.stopLossPct, default: 99 } },
    });
    assert.ok(errors.some((e) => e.includes("params.stopLossPct") && e.includes("max")));
    assert.ok(errors.some((e) => e.includes("RULE_CEILINGS")));
  });
});

describe("Bollinger-Squeeze: Snapshot-Auswertung und σ-Rechnung", () => {
  const compiled = compileRuleSpec(sanitize());

  test("alle Gleichheiten sind inklusive, jede einzelne verletzte Bedingung blockiert", () => {
    assert.equal(compiled.evaluate(snapshotWith()), true);
    assert.equal(compiled.evaluate(snapshotWith({ bbwPct: 5, bbZScore: 1, adx14: 25, volumeRatio: 1.5 })), true);
    for (const overrides of [
      { bbwPct: 6.0001 }, { bbZScore: 0.4999 }, { adx14: 21.9999 }, { volumeRatio: 1.1999 },
    ]) assert.equal(compiled.evaluate(snapshotWith(overrides)), false, JSON.stringify(overrides));
    assert.deepEqual(compiled.fields, ["bbwPct", "bbZScore", "adx14", "volumeRatio"]);
  });

  test("null, fehlende und NaN-Readings blockieren jeden Filter fail-closed", () => {
    for (const field of compiled.fields) {
      for (const value of [null, undefined, NaN]) {
        assert.equal(compiled.evaluate(snapshotWith({ [field]: value })), false, `${field}=${String(value)}`);
      }
    }
    assert.equal(compiled.evaluate(snapshotWith({ bbZScore: null, priceVsUpperBbPct: 1 })), false,
      "kein stiller Ersatz durch den verfügbaren Kantenabstand");
  });

  test("lebende Bandformel: an upper ist z = 2; Default 0.5 erlaubt ein Setup UNTER upper", () => {
    const band = bollingerBands(Array.from({ length: 20 }, (_, i) => i % 2 ? 101 : 99));
    assert.ok(band);
    assert.equal(band.middle, 100);
    assert.equal(band.upper, 102);
    const edge = bollingerPosition(band.upper, band);
    assert.ok(edge);
    assert.equal(edge.zScore, 2, "(upper − middle) / σ = (2 · σ) / σ, nicht ≈ 1.4");
    assert.equal(edge.priceVsUpperPct, 0);
    const early = bollingerPosition(100.5, band);
    assert.ok(early);
    assert.equal(early.zScore, BOLLINGER_SQUEEZE_DEFAULTS.bbZScoreMin);
    assert.ok(early.priceVsUpperPct < 0);
    assert.equal(compiled.evaluate(snapshotWith({
      price: 100.5, bbwPct: band.bandwidthPct * 100,
      bbZScore: early.zScore, priceVsUpperBbPct: early.priceVsUpperPct,
    })), true, "nur der frühe Z-Score, kein redundanter oberer Kantenfilter");
    assert.match(sanitize().rationale, /0\.5 σ über der Bandmitte/);
  });

  test("echter Snapshot wird gelesen; fehlender ADX-Warm-up und σ == 0 bleiben gesperrt", () => {
    assert.equal(compiled.evaluate(BASE_SNAPSHOT!), true, "deterministische Signal-Fixture, keine Edge-Messung");
    const warmup = buildSnapshotFromCandles("BTC", candles(25), 20);
    assert.ok(warmup);
    assert.equal(warmup.adx14, null);
    assert.equal(compiled.evaluate(warmup), false);
    const flat = buildSnapshotFromCandles("BTC", candles(60, 0), 20);
    assert.ok(flat);
    assert.equal(flat.bbwPct, 0);
    assert.equal(flat.bbZScore, null);
    assert.equal(flat.priceVsUpperBbPct, 0);
    assert.equal(compiled.evaluate({ ...flat, adx14: 22, volumeRatio: 1.2 }), false, "null ist keine neutrale 0");
  });

  test("Doku hält σ-Rechnung, unvermessenes Kalibrierungsziel und Snapshot-Grenze fest", () => {
    assert.match(TEMPLATE_SOURCE, /bbZScore = \(close − middle\) \/ σ/);
    assert.match(TEMPLATE_SOURCE, /close == upper ⇒ z = \(2 · σ\) \/ σ = 2/);
    assert.match(TEMPLATE_SOURCE, /z = 0\.5 ⇒ close = middle \+ 0\.5 · σ < upper/);
    assert.match(TEMPLATE_SOURCE, /vorläufiger Research-Startwert/);
    assert.match(TEMPLATE_SOURCE, /20\. Perzentile[\s\S]*200[\s\S]*`1h`[\s\S]*`4h` separat/);
    assert.match(TEMPLATE_SOURCE, /06-01\/06-02/);
    assert.match(TEMPLATE_SOURCE, /VOR einem Live-Einsatz/);
    assert.match(TEMPLATE_SOURCE, /vorher eng, jetzt weit/);
  });

  test("RuleSpec enthält nur Feld-Schwellen, keine Bollinger-Parameter oder Sequenz-Keys", () => {
    const raw = bollingerSqueezeRule(BOLLINGER_SQUEEZE_DEFAULTS);
    assert.deepEqual(Object.keys(raw).sort(), [
      "name", "missionId", "condition", "action", "window", "rationale", "sourceRole", "riskScore",
    ].sort());
    const condition = raw.condition as Record<string, unknown>;
    assert.deepEqual(Object.keys(condition).sort(), ["conditions", "logic"]);
    for (const item of condition.conditions as Array<Record<string, unknown>>) {
      assert.deepEqual(Object.keys(item).sort(), ["field", "op", "value"]);
      assert.notEqual(item.field, "priceVsUpperBbPct");
      assert.equal(typeof item.value, "number");
    }
    assert.doesNotMatch(TEMPLATE_SOURCE, /from ["'](?:node:|@\/db\/|@\/lib\/(?:ollama|llmProvider|engine))[^"]*["']/);
    assert.doesNotMatch(TEMPLATE_SOURCE, /Date\.now\(|Math\.random\(|fetch\(/);
  });
});
