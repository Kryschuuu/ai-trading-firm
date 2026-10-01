/**
 * STX-03-08 — Donchian Breakout: Vertrag, Higher-Timeframe-Beschränkung,
 * Parameterraster, strukturelle Einstiegskosten und die unveränderte
 * Sanitize-Kette. DB-, LLM- und netzfrei.
 *
 * Geprüft werden die Akzeptanzkriterien des Prompts gegen den **lebenden**
 * Bestand, nicht gegen abgeschriebene Zahlen:
 *
 *   1. `validateTemplate(buildDonchianBreakout())` liefert `[]` und der
 *      Katalog führt danach **alle sechs** geplanten Templates.
 *   2. `requiredFields` enthält `donchianBreakoutPct` (setzt 02-03 voraus) —
 *      und nur Felder aus `RULE_FIELDS`.
 *   3. `maxExecutionsPerDay === 1`: ein Ausbruch pro Tag, weil dasselbe
 *      Breakout-Charset sonst Nachfolge-Einstiege am selben Ausbruch erzeugte.
 *   4. `buildRule(defaults)` → `sanitizeRuleSpec()` **ohne Klemmung** — für
 *      jeden Rasterpunkt und jede Eckkombination, nicht nur für die Defaults.
 *      Ein Rasterpunkt, den der Sanitizer geradebiegt, wäre eine Messung der
 *      Klemmung statt der Strategie (06-02).
 *   5. Die Lookahead-Invariante auf Template-Ebene: Das Hoch der **Signalkerze**
 *      geht nicht in `donchianBreakoutPct` ein; ein Intrabar-Spike der letzten
 *      Kerze allein löst die Regel nicht aus (die Bar-für-Bar-Parität der
 *      beiden Snapshot-Pfade steht in `tests/backtest.multiAsset.test.ts`).
 *
 * Der Backtest-/Compiler-Vollpfad bleibt 03-09/03-10.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DONCHIAN_BREAKOUT_DEFAULTS,
  DONCHIAN_BREAKOUT_ID,
  DONCHIAN_BREAKOUT_PARAMS,
  DONCHIAN_BREAKOUT_TIMEFRAMES,
  DONCHIAN_BREAKOUT_VERSION,
  buildDonchianBreakout,
  donchianBreakoutRule,
  type DonchianBreakoutParamKey,
} from "../src/strategies/templates/donchian-breakout";
import {
  STRATEGY_TEMPLATE_IDS,
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
import { DONCHIAN_ENTRY_PERIOD } from "../src/lib/indicators";
import { strategyClassOfTemplate } from "../src/lib/marketRegime";

const TEMPLATE_SOURCE = readFileSync(
  path.join(process.cwd(), "src/strategies/templates/donchian-breakout.ts"),
  "utf8",
);
const PARAM_KEYS = Object.keys(DONCHIAN_BREAKOUT_PARAMS) as DonchianBreakoutParamKey[];

/** Genau der spätere Compiler-Pfad: Rohform + Symbol des Aufrufers → Sanitizer. */
function sanitize(params: Readonly<Record<string, number>> = DONCHIAN_BREAKOUT_DEFAULTS): RuleSpec {
  const result = sanitizeRuleSpec({ ...donchianBreakoutRule(params), symbol: "BTC" });
  assert.ok(result.ok, result.ok ? "" : result.errors.join(" | "));
  return result.spec;
}

function gridOf(spec: ParamSpec): number[] {
  const steps = Math.round((spec.max - spec.min) / spec.step);
  return Array.from({ length: steps + 1 }, (_, i) => Number((spec.min + i * spec.step).toFixed(8)));
}

/**
 * Deterministische, leicht steigende Reihe (100 … 105,9) mit einem
 * Ausbruchsbar am Ende: Schlusskurs 108 liegt über dem Hoch der vorigen 20
 * Kerzen, das Volumen ist doppelt so hoch wie der Schnitt.
 */
function candles(bars: number): CandleLike[] {
  return Array.from({ length: bars }, (_, i) => {
    const isLast = i === bars - 1;
    const close = isLast ? 108 : 100 + i * 0.1;
    return {
      time: 1_700_000_000_000 + i * 3_600_000,
      open: isLast ? 105.9 : close - 0.1,
      high: close + 0.05,
      low: isLast ? 105.85 : close - 0.15,
      close,
      volume: isLast ? 200 : 100,
    };
  });
}

const BASE_SNAPSHOT = buildSnapshotFromCandles("BTC", candles(60), 20);
assert.ok(BASE_SNAPSHOT);

/** Alle drei Filter auf ihrer inklusiven Schwelle; andere Felder aus dem echten Snapshot. */
function snapshotWith(overrides: Partial<RuleSnapshot> = {}): RuleSnapshot {
  return {
    ...BASE_SNAPSHOT!,
    donchianBreakoutPct: 0.3,
    adx14: 20,
    volumeRatio: 1.2,
    ...overrides,
  };
}

describe("Donchian-Breakout: Template-Vertrag und Registry", () => {
  test("validateTemplate liefert [] und die Import-Zeit-Prüfung bleibt gültig", () => {
    assert.deepEqual(validateTemplate(buildDonchianBreakout()), []);
    assert.doesNotThrow(() => assertTemplatesValid());
  });

  test("genau ein Eintrag an sechster Stelle — der Katalog führt jetzt alle sechs Templates", () => {
    const template = buildDonchianBreakout();
    const entry = getTemplate(DONCHIAN_BREAKOUT_ID);
    assert.ok(entry);
    assert.equal(entry, STRATEGY_TEMPLATES[5], "Roadmap-Reihenfolge: 03-03 … 03-08");
    assert.equal(STRATEGY_TEMPLATES.filter((t) => t.id === DONCHIAN_BREAKOUT_ID).length, 1);
    assert.equal(STRATEGY_TEMPLATES.length, 6);
    assert.deepEqual(
      STRATEGY_TEMPLATES.map((t) => t.id),
      [...STRATEGY_TEMPLATE_IDS],
      "der Katalog ist die vollständige, geschlossene ID-Union",
    );
    assert.deepEqual(entry, template);
    assert.notEqual(buildDonchianBreakout(), template, "Factory statt modulweitem Objekt");
    assert.equal(template.version, DONCHIAN_BREAKOUT_VERSION);
    assert.equal(template.version, 1);
    assert.equal(template.class, "breakout");
    assert.equal(template.scope, "SINGLE_SYMBOL");
    assert.deepEqual([...template.supportedTimeframes], ["1h", "4h"]);
    assert.deepEqual(template.supportedTimeframes, DONCHIAN_BREAKOUT_TIMEFRAMES);
    assert.deepEqual([...template.expectedRegimes], ["TREND_UP", "RANGE"]);
  });

  test("requiredFields enthalten donchianBreakoutPct (02-03) und nur Bestandsfelder", () => {
    const template = buildDonchianBreakout();
    assert.deepEqual([...template.requiredFields], ["donchianBreakoutPct", "adx14", "volumeRatio", "atrPct"]);
    for (const field of template.requiredFields) {
      assert.equal(RULE_FIELDS[field], "number", `${field} muss bereits in RULE_FIELDS existieren`);
      assert.ok(templateByField(field).includes(getTemplate(DONCHIAN_BREAKOUT_ID)!));
    }
    assert.deepEqual(
      templateByField("donchianBreakoutPct").map((t) => t.id),
      [DONCHIAN_BREAKOUT_ID],
      "nur dieses Template liest das Donchian-Feld",
    );
  });

  test("Higher-Timeframe-only: kein Intraday-Takt in supportedTimeframes", () => {
    const timeframes: readonly string[] = buildDonchianBreakout().supportedTimeframes;
    for (const intraday of ["1m", "3m", "5m", "15m", "30m"]) {
      assert.equal(timeframes.includes(intraday), false, `${intraday} ist kein Donchian-Takt dieser Strategie`);
    }
    assert.match(TEMPLATE_SOURCE, /Higher-Timeframe-only/);
    assert.match(TEMPLATE_SOURCE, /20-Bar-Kanal 100 Minuten/);
  });

  test("deklarierte Klasse und ADR-008-Heuristik stimmen überein", () => {
    const template = buildDonchianBreakout();
    assert.equal(template.class, "breakout");
    assert.equal(strategyClassOfTemplate(DONCHIAN_BREAKOUT_ID), template.class);
  });

  test("keine Short-Variante: der Builder liefert ausschließlich LONG", () => {
    const raw = donchianBreakoutRule(DONCHIAN_BREAKOUT_DEFAULTS);
    assert.equal(RULE_ALLOWED_SIDE, "LONG");
    assert.equal((raw.action as Record<string, unknown>).side, RULE_ALLOWED_SIDE);
    for (const item of (raw.condition as { conditions: Array<Record<string, unknown>> }).conditions) {
      assert.notEqual(item.field, "side");
    }
  });
});

describe("Donchian-Breakout: Parameterraster und Ausführungsfenster", () => {
  test("das vollständige Parameterraster entspricht dem Auftrag", () => {
    const expected: Readonly<Record<DonchianBreakoutParamKey, Omit<ParamSpec, "key">>> = {
      breakoutMinPct: {
        kind: "threshold", label: "mind. Abstand über Kanal", unit: "%",
        default: 0.3, min: 0, max: 3, step: 0.1, mapsTo: "donchianBreakoutPct",
      },
      adxMin: {
        kind: "threshold", label: "ADX-Bestätigung", unit: "Index",
        default: 20, min: 14, max: 35, step: 1, mapsTo: "adx14",
      },
      volumeRatioMin: {
        kind: "threshold", label: "Volumen beim Ausbruch", unit: "ratio",
        default: 1.2, min: 0.9, max: 3, step: 0.05, mapsTo: "volumeRatio",
      },
      stopLossPct: {
        kind: "threshold", label: "Stop-Loss", unit: "%",
        default: 5, min: 1, max: 15, step: 0.5, mapsTo: "atrPct",
      },
      takeProfitRR: {
        kind: "ratio", label: "Chance/Risiko", unit: "ratio",
        // Der bestehende ParamSpec-Vertrag verlangt ein Mapping; nur Risikodoku.
        default: 2, min: 1, max: 4, step: 0.25, mapsTo: "atrPct",
      },
    };
    assert.deepEqual(Object.keys(DONCHIAN_BREAKOUT_PARAMS).sort(), Object.keys(expected).sort());
    for (const key of PARAM_KEYS) {
      assert.deepEqual(DONCHIAN_BREAKOUT_PARAMS[key], { key, ...expected[key] });
    }
    assert.deepEqual(DONCHIAN_BREAKOUT_DEFAULTS, {
      breakoutMinPct: 0.3, adxMin: 20, volumeRatioMin: 1.2, stopLossPct: 5, takeProfitRR: 2,
    });
    assert.deepEqual(
      DONCHIAN_BREAKOUT_DEFAULTS,
      Object.fromEntries(Object.entries(buildDonchianBreakout().params).map(([key, spec]) => [key, spec.default])),
    );
  });

  test("der Kanal-Default ist 0,3 % über dem Hoch — nicht 0 (Grenzfall) oder 3", () => {
    assert.ok(DONCHIAN_BREAKOUT_PARAMS.breakoutMinPct.default > 0);
    assert.equal(DONCHIAN_BREAKOUT_DEFAULTS.breakoutMinPct, 0.3);
    assert.equal(DONCHIAN_BREAKOUT_PARAMS.breakoutMinPct.min, 0);
  });

  test("Fenster: ein Ausbruch pro Tag, 12 h Cooldown, 1h-Kerzen", () => {
    const spec = sanitize();
    assert.deepEqual(spec.window, {
      timeframe: "1h", validFrom: null, validUntil: null,
      maxExecutionsPerDay: 1, cooldownMinutes: 720, volumeWindow: 20,
    });
    assert.equal(spec.window.maxExecutionsPerDay, 1, "derselbe Ausbruch darf nicht mehrfach kaufen");
    assert.match(TEMPLATE_SOURCE, /Ein Ausbruch pro Tag/);
    for (const [key, value] of [["maxExecutionsPerDay", 1], ["cooldownMinutes", 720]] as const) {
      const bounds = RULE_CEILINGS[key];
      assert.ok(value >= bounds[0] && value <= bounds[1], `${key}=${value} außerhalb RULE_CEILINGS`);
    }
  });

  test("alle Parametergrenzen liegen innerhalb der lebenden RULE_CEILINGS", () => {
    for (const key of ["stopLossPct", "takeProfitRR"] as const) {
      assert.ok(DONCHIAN_BREAKOUT_PARAMS[key].min >= RULE_CEILINGS[key][0], `${key}.min`);
      assert.ok(DONCHIAN_BREAKOUT_PARAMS[key].max <= RULE_CEILINGS[key][1], `${key}.max`);
    }
  });
});

describe("Donchian-Breakout: Rohform → sanitizeRuleSpec ohne Klemmung", () => {
  test("Defaults erzeugen exakt drei inklusive Bedingungen mit logic all", () => {
    const raw = buildDonchianBreakout().buildRule(DONCHIAN_BREAKOUT_DEFAULTS);
    assert.deepEqual(raw.condition, {
      logic: "all",
      conditions: [
        { field: "donchianBreakoutPct", op: "gte", value: 0.3 },
        { field: "adx14", op: "gte", value: 20 },
        { field: "volumeRatio", op: "gte", value: 1.2 },
      ],
    });
    assert.equal(raw.symbol, undefined, "das Symbol gehört dem Aufrufer");
    assert.deepEqual(sanitize(), { ...raw, symbol: "BTC" }, "keine Klemmung, Kürzung oder Default-Reparatur");
  });

  test("ohne Symbol scheitert der Sanitizer, beide unterstützten Timeframes bleiben erhalten", () => {
    const result = sanitizeRuleSpec(donchianBreakoutRule(DONCHIAN_BREAKOUT_DEFAULTS));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((e) => e.includes("symbol")));
    for (const timeframe of DONCHIAN_BREAKOUT_TIMEFRAMES) {
      const raw = { ...sanitize(), window: { ...sanitize().window, timeframe } };
      const normalized = sanitizeRuleSpec(raw);
      assert.ok(normalized.ok);
      assert.deepEqual(normalized.spec, raw);
    }
  });

  for (const key of PARAM_KEYS) {
    test(`jeder Rasterpunkt von ${key} bleibt gültig, unverändert und tatsächlich parametrisiert`, () => {
      const param = DONCHIAN_BREAKOUT_PARAMS[key];
      const values = gridOf(param);
      assert.equal(values[0], param.min);
      assert.equal(values.at(-1), param.max);
      for (const value of values) {
        const params = { ...DONCHIAN_BREAKOUT_DEFAULTS, [key]: value };
        const template = {
          ...buildDonchianBreakout(),
          params: { ...DONCHIAN_BREAKOUT_PARAMS, [key]: { ...param, default: value } },
        };
        assert.deepEqual(validateTemplate(template), [], `${key}=${value}`);
        const raw = donchianBreakoutRule(params);
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

  test("auch alle 32 Kombinationen der Parametergrenzen überstehen den Sanitizer unverändert", () => {
    for (let mask = 0; mask < 2 ** PARAM_KEYS.length; mask++) {
      const params = Object.fromEntries(PARAM_KEYS.map((key, i) => [
        key, DONCHIAN_BREAKOUT_PARAMS[key][mask & (1 << i) ? "max" : "min"],
      ]));
      assert.deepEqual(sanitize(params), { ...donchianBreakoutRule(params), symbol: "BTC" }, `Ecke ${mask}`);
    }
  });

  test("der Builder ist deterministisch, mutiert keine Eingabe und liefert frische Rohdaten", () => {
    const params = Object.freeze({ ...DONCHIAN_BREAKOUT_DEFAULTS });
    const before = { ...params };
    const first = donchianBreakoutRule(params);
    const second = donchianBreakoutRule(params);
    assert.deepEqual(first, second);
    assert.deepEqual(params, before);
    assert.notEqual(first, second);
    assert.notEqual(first.condition, second.condition);
    assert.notEqual(first.action, second.action);
    assert.notEqual(first.window, second.window);
  });

  test("fehlende, nicht-endliche und typfalsche Parameter scheitern statt stiller Defaults", () => {
    for (const key of PARAM_KEYS) {
      const missing: Record<string, number> = { ...DONCHIAN_BREAKOUT_DEFAULTS };
      delete missing[key];
      assert.throws(() => donchianBreakoutRule(missing), new RegExp(key));
      for (const value of [NaN, Infinity, -Infinity, undefined, null, "1", {}, []]) {
        const params = { ...DONCHIAN_BREAKOUT_DEFAULTS, [key]: value } as unknown as Record<string, number>;
        assert.throws(() => donchianBreakoutRule(params), new RegExp(key));
      }
    }
  });

  test("der Builder klemmt keine Rohwerte; ungültige Parameterdefaults scheitern im Katalog", () => {
    const params = { ...DONCHIAN_BREAKOUT_DEFAULTS, stopLossPct: 99 };
    const raw = donchianBreakoutRule(params);
    assert.equal((raw.action as Record<string, unknown>).stopLossPct, 99);
    const errors = validateTemplate({
      ...buildDonchianBreakout(),
      params: { ...DONCHIAN_BREAKOUT_PARAMS, stopLossPct: { ...DONCHIAN_BREAKOUT_PARAMS.stopLossPct, default: 99 } },
    });
    assert.ok(errors.some((e) => e.includes("params.stopLossPct") && e.includes("max")));
    assert.ok(errors.some((e) => e.includes("RULE_CEILINGS")));
  });
});

describe("Donchian-Breakout: Annahmen und Doku-Pflichten", () => {
  test("Pflichtannahmen sind kategorisiert und auditierbar (06-01)", () => {
    const assumptions = buildDonchianBreakout().assumptions;
    assert.ok(assumptions.length >= 4);
    for (const [id, category, critical, statement] of [
      ["20-bar-ausbrueche-regimewechsel", "MARKET", false, /20-Bar-Ausbrüche markieren Regime-Wechsel/],
      ["einstieg-am-lokalen-hoch", "EXECUTION", true, /lokale Hoch-Punkt; strukturelle\s+Properties, keine Parameterfrage/],
      ["vorige-20-kerzen-kein-lookahead", "DATA", true, /VORIGEN 20 Kerzen, ohne die aktuelle \(kein Look-ahead\)/],
      ["spread-am-lokalen-hoch", "COST", true, /Breakout-Einstiege zahlen den Spread am lokalen Hoch/],
    ] as const) {
      const assumption = assumptions.find((a) => a.id === id);
      assert.ok(assumption, id);
      assert.equal(assumption.category, category, id);
      assert.equal(assumption.critical, critical, id);
      assert.match(assumption.statement, statement, id);
    }
    for (const category of ["MARKET", "EXECUTION", "DATA", "COST"] as const) {
      assert.ok(assumptions.some((a) => a.category === category), category);
    }
    assert.equal(new Set(assumptions.map((a) => a.id)).size, assumptions.length);
    for (const assumption of assumptions) assert.match(assumption.id, /^[a-z0-9-]{1,64}$/);
  });

  test("der Doc-Kommentar hält Strukturkosten, Higher-Timeframe-Grenze und die entryPeriod-Grenze fest", () => {
    assert.match(TEMPLATE_SOURCE, /Der Ausbruch kostet/);
    assert.match(TEMPLATE_SOURCE, /kauft typischerweise am lokalen Hoch/);
    assert.match(TEMPLATE_SOURCE, /Eigenschaft, kein Parameterfehler/);
    assert.match(TEMPLATE_SOURCE, /niedriger ist als beim EMA\/ADX-Trend/);
    assert.match(TEMPLATE_SOURCE, /entryPeriod[\s\S]{0,80}kein Regelfeld/);
    assert.match(TEMPLATE_SOURCE, /DONCHIAN_ENTRY_PERIOD/);
    assert.match(TEMPLATE_SOURCE, /06-02/);
    assert.match(TEMPLATE_SOURCE, /Bekannte Grenze, bewusst nicht gebaut/);
  });

  test("das Feld ist an den kanonischen Snapshot-Default (20) gebunden, nicht an einen Template-Parameter", () => {
    assert.equal(DONCHIAN_ENTRY_PERIOD, 20);
    assert.equal(PARAM_KEYS.includes("entryPeriod" as DonchianBreakoutParamKey), false);
    assert.equal(
      (buildDonchianBreakout().requiredFields as readonly string[]).includes("entryPeriod"),
      false,
    );
    const fields = sanitize().condition.conditions.map((c) => c.field);
    assert.deepEqual(fields, ["donchianBreakoutPct", "adx14", "volumeRatio"]);
  });

  test("RuleSpec enthält nur Feld-Schwellen, keine Donchian-Parameter oder Sequenz-Keys", () => {
    const raw = donchianBreakoutRule(DONCHIAN_BREAKOUT_DEFAULTS);
    assert.deepEqual(Object.keys(raw).sort(), [
      "name", "missionId", "condition", "action", "window", "rationale", "sourceRole", "riskScore",
    ].sort());
    const condition = raw.condition as Record<string, unknown>;
    assert.deepEqual(Object.keys(condition).sort(), ["conditions", "logic"]);
    for (const item of condition.conditions as Array<Record<string, unknown>>) {
      assert.deepEqual(Object.keys(item).sort(), ["field", "op", "value"]);
      assert.equal(typeof item.value, "number");
    }
    assert.doesNotMatch(TEMPLATE_SOURCE, /from ["'](?:node:|@\/db\/|@\/lib\/(?:ollama|llmProvider|engine))[^"]*["']/);
    assert.doesNotMatch(TEMPLATE_SOURCE, /Date\.now\(|Math\.random\(|fetch\(/);
  });
});

describe("Donchian-Breakout: Snapshot-Auswertung", () => {
  const compiled = compileRuleSpec(sanitize());

  test("alle Gleichheiten sind inklusive, jede einzelne verletzte Bedingung blockiert", () => {
    assert.equal(compiled.evaluate(snapshotWith()), true);
    assert.equal(compiled.evaluate(snapshotWith({ donchianBreakoutPct: 2, adx14: 30, volumeRatio: 2 })), true);
    for (const overrides of [
      { donchianBreakoutPct: 0.2999 }, { adx14: 19.9999 }, { volumeRatio: 1.1999 },
    ]) assert.equal(compiled.evaluate(snapshotWith(overrides)), false, JSON.stringify(overrides));
    assert.deepEqual(compiled.fields, ["donchianBreakoutPct", "adx14", "volumeRatio"]);
  });

  test("null, fehlende und NaN-Readings blockieren jeden Filter fail-closed", () => {
    for (const field of compiled.fields) {
      for (const value of [null, undefined, NaN]) {
        assert.equal(compiled.evaluate(snapshotWith({ [field]: value })), false, `${field}=${String(value)}`);
      }
    }
  });

  test("echter Snapshot mit Ausbruch feuert; unter 25 Kerzen gibt es keinen Snapshot", () => {
    assert.equal(compiled.evaluate(BASE_SNAPSHOT!), true, "deterministische Signal-Fixture, keine Edge-Messung");
    assert.ok((BASE_SNAPSHOT!.donchianBreakoutPct ?? 0) >= DONCHIAN_BREAKOUT_DEFAULTS.breakoutMinPct);
    assert.equal(buildSnapshotFromCandles("BTC", candles(20), 20), null, "zu wenig Historie ⇒ kein Snapshot");
    const warmup = buildSnapshotFromCandles("BTC", candles(25), 20);
    assert.ok(warmup);
    assert.equal(warmup.adx14, null, "ADX(14) braucht 29 Kerzen");
    assert.ok((warmup.donchianBreakoutPct ?? 0) > 0, "das Kanalhoch existiert bereits ab 21 Kerzen");
    assert.equal(compiled.evaluate(warmup), false, "null blockiert, obwohl der Ausbruch messbar wäre");
  });

  test("kein Look-ahead: ein Intrabar-Spike der Signalkerze allein löst die Regel nicht aus", () => {
    const spiky = candles(60);
    spiky[59] = { ...spiky[59], high: 130, close: 105.5 };
    const snapshot = buildSnapshotFromCandles("BTC", spiky, 20);
    assert.ok(snapshot);
    assert.ok(
      (snapshot.donchianBreakoutPct ?? 0) < 0,
      "das Hoch der Signalkerze (130) gehört nicht zum vorher bekannten Kanal",
    );
    assert.equal(compiled.evaluate(snapshot), false);
  });
});
