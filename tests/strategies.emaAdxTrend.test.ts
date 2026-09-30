/**
 * Tests des EMA/ADX-Trend-Templates (STX-03-03, `src/strategies/templates/`).
 *
 * Was hier geprüft wird, sind die vier Zusagen des Prompts — und zwar gegen den
 * **lebenden** Bestand, nie gegen abgeschriebene Zahlen:
 *
 *   1. `validateTemplate(buildEmaAdxTrend())` liefert `[]` (Katalog-Vertrag).
 *   2. `buildRule(defaults)` übersteht `sanitizeRuleSpec()` **ohne Klemmung** —
 *      für jeden Punkt des Parameterrasters, nicht nur für die Defaults. Ein
 *      Rasterpunkt, den der Sanitizer geradebiegt, wäre eine Messung der
 *      Klemmung statt der Strategie (06-02).
 *   3. `adxMin: 99` (außerhalb `max`) scheitert in `validateTemplate` — samt
 *      Gegenbeweis, dass `sanitizeRuleSpec()` solchen Werten hilflos
 *      gegenübersteht (es gibt keinen Deckel auf `adx14`). Die Grenze gehört in
 *      den Katalog, nicht in die Engine.
 *   4. `buildRule` ist eine **reine** Funktion der Parameter: zwei Aufrufe
 *      tiefengleich, keine Mutation des Eingangs, kein Marktdatenzugriff.
 *
 * Dazu die Doku-Pflichten als lebende Invarianten (Hysterese, 29 Kerzen) und
 * die Sperren des Prompts (kein SHORT, kein `vwapPct`, keine Sequenz-Logik, kein
 * Backtest-Lauf). Was hier NICHT steht: der Backtest selbst (03-10), der
 * Compiler (03-09) und die generischen Katalog-Negativfälle
 * (`tests/strategies.catalog.test.ts`). Alles DB-, LLM- und netzfrei.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  EMA_ADX_TREND_DEFAULTS,
  EMA_ADX_TREND_ID,
  EMA_ADX_TREND_PARAMS,
  EMA_ADX_TREND_TIMEFRAMES,
  EMA_ADX_TREND_VERSION,
  buildEmaAdxTrend,
  emaAdxTrendRule,
  type EmaAdxTrendParamKey,
} from "../src/strategies/templates/ema-adx-trend";
import {
  STRATEGY_TEMPLATES,
  assertTemplatesValid,
  getTemplate,
  listTemplates,
  validateTemplate,
} from "../src/strategies/catalog";
import type { ParamSpec, StrategyTemplate } from "../src/strategies/types";
import { RULE_CEILINGS, buildSnapshotFromCandles, compileRuleSpec, sanitizeRuleSpec } from "../src/lib/ruleEngine";
import type { CandleLike, RuleSnapshot, RuleSpec, RuleSpecInput } from "../src/lib/ruleEngine";
import { RULE_FIELDS } from "../src/lib/ruleFieldCatalog";
import { LIMIT_CEILINGS } from "../src/lib/riskGuard";
import { SUPPORTED_TIMEFRAME_MS } from "../src/lib/marketdata/timeframes";
import { strategyClassOfTemplate } from "../src/lib/marketRegime";

const ROOT = process.cwd();
const TEMPLATE_SOURCE = readFileSync(path.join(ROOT, "src/strategies/templates/ema-adx-trend.ts"), "utf8");
const RULE_ENGINE_SOURCE = readFileSync(path.join(ROOT, "src/lib/ruleEngine.ts"), "utf8");
const INDICATORS_SOURCE = readFileSync(path.join(ROOT, "src/lib/indicators.ts"), "utf8");

const PARAM_KEYS = Object.keys(EMA_ADX_TREND_PARAMS) as EmaAdxTrendParamKey[];

// ── Helfer ───────────────────────────────────────────────────────────────────

/** Der vertragliche Pfad: Rohform + **Symbol des Aufrufers**, dann Sanitizer. */
function sanitize(params: Record<string, number>, symbol = "BTC"): RuleSpec {
  const result = sanitizeRuleSpec({ ...emaAdxTrendRule(params), symbol } as RuleSpecInput, "MANUAL");
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
function paramsWith(overrides: Partial<Record<EmaAdxTrendParamKey, number>>): Record<string, number> {
  return { ...EMA_ADX_TREND_DEFAULTS, ...overrides };
}

/** Das Raster eines Parameters, inklusiv beider Endpunkte. */
function gridOf(spec: ParamSpec): number[] {
  const points = Math.round((spec.max - spec.min) / spec.step);
  return Array.from({ length: points + 1 }, (_, index) => spec.min + index * spec.step);
}

/**
 * Ein Template, dessen Parameter-`default` auf `value` steht.
 *
 * Der Katalog ruft `buildRule()` mit genau den Defaults auf — einen Rasterpunkt
 * über den Default zu setzen ist deshalb der einzige Weg, die **vollständige**
 * Prüfung (Param-Grenzen + Builder + `RULE_CEILINGS`) auf diesem Punkt laufen zu
 * lassen. Ein nur ans `action`-Objekt gehängter Wert liefe an der
 * Param-Prüfung vorbei.
 */
function templateWithParam(key: EmaAdxTrendParamKey, value: number): StrategyTemplate {
  const params: Record<string, ParamSpec> = {};
  for (const paramKey of PARAM_KEYS) {
    const spec = EMA_ADX_TREND_PARAMS[paramKey];
    params[paramKey] = paramKey === key ? { ...spec, default: value } : spec;
  }
  return { ...buildEmaAdxTrend(), params };
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

// ─────────────────────────────────────────────────────────────────────────────
// 1) Akzeptanzkriterium 1 — der Katalog nimmt das Artefakt
// ─────────────────────────────────────────────────────────────────────────────

describe("Akzeptanz: validateTemplate(buildEmaAdxTrend()) liefert []", () => {
  test("das frisch gebaute Template ist vertragsgültig", () => {
    assert.deepEqual(validateTemplate(buildEmaAdxTrend()), []);
  });

  test("die Registry-Prüfung wirft nicht (Import-Zeit-Pfad des Katalogs)", () => {
    assert.doesNotThrow(() => assertTemplatesValid([buildEmaAdxTrend()]));
    assert.doesNotThrow(() => assertTemplatesValid());
  });

  test("der Katalogeintrag ist genau dieses Artefakt (keine abweichende Kopie)", () => {
    const entry = getTemplate(EMA_ADX_TREND_ID);
    assert.ok(entry, "ema-adx-trend muss im Katalog stehen");
    assert.equal(entry, listTemplates()[0], "Roadmap-Reihenfolge: 03-03 steht zuerst");
    assert.equal(JSON.stringify(entry), JSON.stringify(buildEmaAdxTrend()));
    // Seit 03-04 steht ein zweites Template daneben (macd-momentum); welche
    // Dateien registriert sind, prüft `tests/strategies.catalog.test.ts` gegen
    // das Verzeichnis — dieser Test bleibt deshalb bei der **relativen**
    // Aussage: dieses Artefakt ist da, an erster Stelle, unverfälscht.
    assert.ok(
      STRATEGY_TEMPLATES.some((template) => template.id === EMA_ADX_TREND_ID),
      "das Artefakt muss in der Registry stehen",
    );
  });

  test("die deklarierte Klasse stimmt mit der ADR-008-Ableitung überein", () => {
    const template = buildEmaAdxTrend();
    assert.equal(template.class, "trend");
    assert.equal(
      strategyClassOfTemplate(template.id),
      template.class,
      "ADR-008: deklarierte Klasse und Herkunfts-Heuristik dürfen nicht divergieren",
    );
  });

  test("jedes requiredFields-Feld lebt in RULE_FIELDS (Whitelist, nicht Kopie)", () => {
    const known = new Set(Object.keys(RULE_FIELDS));
    for (const field of buildEmaAdxTrend().requiredFields) {
      assert.ok(known.has(field), `${field} ist kein RULE_FIELDS-Feld`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Spec-Treue — die Tabellen des Prompts, Zeile für Zeile
// ─────────────────────────────────────────────────────────────────────────────

describe("Template-Daten: der Prompt als Test", () => {
  test("Kennung, Klasse, Version, Scope", () => {
    const t = buildEmaAdxTrend();
    assert.equal(t.id, "ema-adx-trend");
    assert.equal(t.id, EMA_ADX_TREND_ID, "exportierte ID und Template-ID sind eine Zahl");
    assert.equal(t.class, "trend");
    assert.equal(t.version, 1);
    assert.equal(t.version, EMA_ADX_TREND_VERSION);
    assert.equal(t.scope, "SINGLE_SYMBOL");
    assert.ok(t.name.trim().length > 0 && t.description.trim().length > 0, "name/description gehören zum Artefakt");
  });

  test("supportedTimeframes = 1h/4h — und kein einziger Intraday-Takt", () => {
    const t = buildEmaAdxTrend();
    assert.deepEqual([...t.supportedTimeframes], ["1h", "4h"]);
    assert.deepEqual(t.supportedTimeframes, EMA_ADX_TREND_TIMEFRAMES, "exportierte Liste = Template-Liste");
    // „Kein Intraday“ ist eine Aussage über die **Dauer**, nicht über zwei
    // Strings: jeder Eintrag muss mindestens eine Stunde messen.
    for (const tf of t.supportedTimeframes) {
      assert.ok(SUPPORTED_TIMEFRAME_MS[tf] >= SUPPORTED_TIMEFRAME_MS["1h"], `${tf} ist feiner als 1h`);
    }
    // Und ADX(14) hat auf beiden Takten wenigstens einen Tag Historie je 29 Kerzen.
    for (const tf of t.supportedTimeframes) {
      assert.ok(
        29 * SUPPORTED_TIMEFRAME_MS[tf] >= 24 * 3_600_000,
        `${tf}: 29 Kerzen liegen unter einem Tag — keine Trendbasis`,
      );
    }
  });

  test("requiredFields exakt die fünf Felder des Templates", () => {
    assert.deepEqual(
      [...buildEmaAdxTrend().requiredFields],
      ["trend", "priceVsEma50Pct", "adx14", "volumeRatio", "atrPct"],
    );
  });

  test("Parametertabelle: kind, label, unit, default, min, max, step, mapsTo", () => {
    const expected: Readonly<Record<EmaAdxTrendParamKey, Omit<ParamSpec, "key">>> = {
      adxMin: { kind: "threshold", label: "ADX-Mindestwert", unit: "Index", default: 22, min: 15, max: 35, step: 1, mapsTo: "adx14" },
      ema50BufferPct: {
        kind: "threshold",
        label: "Kurs mindestens über EMA 50",
        unit: "%",
        default: 0.2,
        min: 0,
        max: 3,
        step: 0.1,
        mapsTo: "priceVsEma50Pct",
      },
      volumeRatioMin: { kind: "threshold", label: "Volumenverhältnis", unit: "ratio", default: 1, min: 0.8, max: 2, step: 0.05, mapsTo: "volumeRatio" },
      stopLossPct: { kind: "threshold", label: "Stop-Loss", unit: "%", default: 4, min: 1, max: 12, step: 0.5, mapsTo: "atrPct" },
      takeProfitRR: { kind: "ratio", label: "Chance/Risiko", unit: "ratio", default: 2, min: 1, max: 4, step: 0.25, mapsTo: "atrPct" },
    };
    const t = buildEmaAdxTrend();
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
      { ...EMA_ADX_TREND_DEFAULTS },
      { adxMin: 22, ema50BufferPct: 0.2, volumeRatioMin: 1, stopLossPct: 4, takeProfitRR: 2 },
    );
  });

  test("expectedRegimes = [TREND_UP] — ohne UNKNOWN, ohne RANGE (ADR-009)", () => {
    assert.deepEqual([...buildEmaAdxTrend().expectedRegimes], ["TREND_UP"]);
  });

  test("assumptions: die vier Pflichtannahmen mit Kategorie und critical-Flag", () => {
    const assumptions = buildEmaAdxTrend().assumptions;
    assert.ok(assumptions.length >= 4, `mindestens 4 Annahmen, sind ${assumptions.length}`);
    const expected: ReadonlyArray<{ id: string; category: string; critical: boolean }> = [
      { id: "trendreihen-1h-4h", category: "MARKET", critical: false },
      { id: "adx-29-kerzen", category: "DATA", critical: true },
      { id: "volumenfilter-reduzierte-transaktionskosten", category: "COST", critical: false },
      { id: "regime-trend-up", category: "REGIME", critical: false },
    ];
    for (const want of expected) {
      const got = assumptions.find((a) => a.id === want.id);
      assert.ok(got, `Annahme ${want.id} fehlt`);
      assert.equal(got.category, want.category, want.id);
      assert.equal(got.critical, want.critical, `${want.id}: critical-Flag`);
      assert.ok(got.statement.trim().length > 20, `${want.id}: statement ist ein Platzhalter`);
    }
    // `critical` ist eine Aussage über die Datenbasis: kritisch ist genau eine —
    // und sie ist eine DATA-Annahme (ohne ADX gibt es hier keinen Trend).
    assert.deepEqual(
      assumptions.filter((a) => a.critical).map((a) => a.category),
      ["DATA"],
    );
    for (const a of assumptions) {
      assert.match(a.id, /^[a-z0-9-]{1,64}$/, `id ${a.id} außerhalb des Schemas`);
    }
    assert.equal(new Set(assumptions.map((a) => a.id)).size, assumptions.length, "Annahme-IDs eindeutig");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) buildRule — die gelieferte Rohform
// ─────────────────────────────────────────────────────────────────────────────

describe("buildRule(defaults): die vier Bedingungen, die Action, das Fenster", () => {
  test("condition ist eine `all`-Konjunktion über genau vier Regeln", () => {
    const raw = emaAdxTrendRule(EMA_ADX_TREND_DEFAULTS);
    assert.equal(asRecord(raw.condition).logic, "all");
    assert.deepEqual(conditionsOf(raw), [
      { field: "trend", op: "eq", value: "UP" },
      { field: "priceVsEma50Pct", op: "gte", value: 0.2 },
      { field: "adx14", op: "gte", value: 22 },
      { field: "volumeRatio", op: "gte", value: 1 },
    ]);
    assert.ok(
      conditionsOf(raw).length <= RULE_CEILINGS.maxConditions,
      "mehr Bedingungen als maxConditions würde der Sanitizer still kappen",
    );
  });

  test("action: LONG mit den verifizierten Risiko-Werten", () => {
    const action = asRecord(emaAdxTrendRule(EMA_ADX_TREND_DEFAULTS).action);
    assert.deepEqual(action, {
      side: "LONG",
      stopLossPct: 4,
      takeProfitRR: 2,
      riskBudgetPct: 0.01,
      maxPositionPct: 0.15,
      positionSizeMode: "risk",
    });
    // Nachgerechnet am Bestand, nicht am Prompt: Die festgesetzten Werte liegen
    // **innerhalb** der Deckel, die der Sanitizer aus LIMIT_CEILINGS ableitet —
    // und zwar frei von beiden Anschlägen.
    assert.deepEqual([...LIMIT_CEILINGS.maxRiskPerTrade], [0.002, 0.05]);
    assert.deepEqual([...LIMIT_CEILINGS.maxPositionPct], [0.01, 0.5]);
    assert.ok(action.riskBudgetPct === 0.01);
    assert.ok(
      Number(action.riskBudgetPct) > ceilingOf("riskBudgetPct")!.min && Number(action.riskBudgetPct) < ceilingOf("riskBudgetPct")!.max,
      "riskBudgetPct am Anschlag — eine spätere Senkung des Deckels wäre unsichtbar",
    );
    assert.ok(
      Number(action.maxPositionPct) > ceilingOf("maxPositionPct")!.min && Number(action.maxPositionPct) < ceilingOf("maxPositionPct")!.max,
      "maxPositionPct am Anschlag",
    );
  });

  test("window: 1h, 2 Ausführungen/Tag, 240 min Abklingzeit, 20 Kerzen Volumen", () => {
    const window = asRecord(emaAdxTrendRule(EMA_ADX_TREND_DEFAULTS).window);
    assert.deepEqual(window, {
      timeframe: "1h",
      validFrom: null,
      validUntil: null,
      maxExecutionsPerDay: 2,
      cooldownMinutes: 240,
      volumeWindow: 20,
    });
    // `volumeWindow` ist dieselbe Referenz, gegen die der Snapshot
    // `volumeRatio` bildet — eine Abweichung ließe die Volumenbedingung gegen
    // ein anderes Fenster laufen, als das Template denkt.
    assert.equal(window.volumeWindow, 20);
    assert.ok(window.timeframe === "1h" && t_supported(window.timeframe), "window.timeframe muss ein unterstützter Takt des Templates sein");
  });

  test("Herkunft, Rationale, Risiko-Score, Mission — und kein symbol", () => {
    const raw = emaAdxTrendRule(EMA_ADX_TREND_DEFAULTS);
    assert.equal(raw.sourceRole, "RESEARCH");
    assert.equal(raw.missionId, null);
    assert.equal(raw.riskScore, 0.5);
    assert.ok(String(raw.name).includes(EMA_ADX_TREND_ID), "name trägt die Template-ID (Familienname, kein Symbol)");
    const rationale = String(raw.rationale);
    assert.match(rationale, /[a-zäöüß]/, "rationale ist deutsch verfasst");
    assert.ok(rationale.length > 40 && rationale.length <= 600, "rationale muss in den 600-Zeichen-Schnitt des Sanitizers passen");
    // Der Kern des `symbol`-Vertrags: der Builder kennt keinen Markt — und ohne
    // Symbol bleibt die Rohform eine Rohform (fail-closed, kein Default).
    assert.equal("symbol" in raw, false, "symbol ist Pflicht des Aufrufers, nie des Builders");
    assert.equal(sanitizeRuleSpec(raw, "MANUAL").ok, false, "ohne Symbol darf es keine Regel geben");
  });

  test("jeder Parameter erreicht die Regel — kein Parameter ist Deko", () => {
    const raw = emaAdxTrendRule(
      paramsWith({ adxMin: 30, ema50BufferPct: 1.5, volumeRatioMin: 1.55, stopLossPct: 7.5, takeProfitRR: 3.25 }),
    );
    assert.deepEqual(
      conditionsOf(raw).map((item) => [item.field, item.value]),
      [
        ["trend", "UP"],
        ["priceVsEma50Pct", 1.5],
        ["adx14", 30],
        ["volumeRatio", 1.55],
      ],
    );
    const action = asRecord(raw.action);
    assert.equal(action.stopLossPct, 7.5);
    assert.equal(action.takeProfitRR, 3.25);
    // Die Rationale zitiert die Werte: eine Zahl, die in der Regel steht und im
    // Klartext fehlt, wäre eine Audit-Lüge.
    for (const value of [1.5, 30, 1.55, 7.5, 3.25]) {
      assert.ok(rationaleMentions(String(raw.rationale), value), `rationale nennt ${value} nicht`);
    }
  });
});

/** Der Template-Text rundet für die Anzeige auf 3 Stellen — hier nachgestellt. */
function rationaleMentions(rationale: string, value: number): boolean {
  return rationale.includes(String(Number(value.toFixed(3))));
}

/** true, wenn `tf` zu den Timeframes dieses Templates gehört. */
function t_supported(tf: unknown): boolean {
  return (EMA_ADX_TREND_TIMEFRAMES as readonly unknown[]).includes(tf);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) Akzeptanzkriterium 4 — Reinheit und Determinismus
// ─────────────────────────────────────────────────────────────────────────────

describe("buildRule ist eine reine, deterministische Funktion der Parameter", () => {
  test("zwei Aufrufe mit denselben Defaults sind tiefengleich", () => {
    const first = emaAdxTrendRule(EMA_ADX_TREND_DEFAULTS);
    const second = emaAdxTrendRule(EMA_ADX_TREND_DEFAULTS);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second), "auch die Key-Reihenfolge ist stabil (Artefakt-Hash, 04-01)");
  });

  test("zwei Aufrufe teilen keine Objekt-Referenzen (kein geteilter Zustand)", () => {
    const first = asRecord(emaAdxTrendRule(EMA_ADX_TREND_DEFAULTS).condition);
    const second = asRecord(emaAdxTrendRule(EMA_ADX_TREND_DEFAULTS).condition);
    assert.notEqual(first, second);
    assert.notEqual(first.conditions, second.conditions);
    assert.deepEqual(first, second);
  });

  test("der Builder verändert das übergebene params-Objekt nicht", () => {
    const params: Record<string, number> = { ...EMA_ADX_TREND_DEFAULTS };
    const before = { ...params };
    emaAdxTrendRule(params);
    assert.deepEqual(params, before);
  });

  test("unbekannte Schlüssel erreichen die Regel nicht", () => {
    const withExtras = paramsWith({});
    withExtras.riskBudgetPct = 0.5; // ein Schlüssel, den das Template nicht kennt
    withExtras.side = -1;
    assert.deepEqual(emaAdxTrendRule(withExtras), emaAdxTrendRule(EMA_ADX_TREND_DEFAULTS));
    assert.equal(
      asRecord(emaAdxTrendRule(withExtras).action).riskBudgetPct,
      0.01,
      "ein params-Schlüssel darf ein festes Guardrail nicht überschreiben",
    );
  });

  test("fehlende oder nicht endliche Parameter sind ein Wurf, kein Default", () => {
    for (const bad of [undefined, null, NaN, Infinity, "22", {}, []] as unknown[]) {
      const params: Record<string, unknown> = { ...EMA_ADX_TREND_DEFAULTS, adxMin: bad };
      assert.throws(
        () => emaAdxTrendRule(params as Record<string, number>),
        /adxMin/,
        `Wert ${String(bad)} darf nicht still durchgehen`,
      );
    }
    // Auch ein fehlender Parameter wirft — und nennt ihn beim Namen.
    const partial: Record<string, number> = { ...EMA_ADX_TREND_DEFAULTS };
    delete partial.takeProfitRR;
    assert.throws(() => emaAdxTrendRule(partial), /takeProfitRR/);
  });

  test("ein Wert außerhalb des Bereichs ist **kein** Builder-Problem (Grenzen prüft der Katalog)", () => {
    // Der Builder entscheidet nicht über Gültigkeit — sonst gäbe es zwei
    // Stellen, die den Parameterraum kennen. Er liefert, was er bekommt.
    const raw = emaAdxTrendRule(paramsWith({ adxMin: 99 }));
    assert.equal(conditionsOf(raw)[2].value, 99);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) Akzeptanzkriterium 2 — Klemmfreiheit über das ganze Raster
// ─────────────────────────────────────────────────────────────────────────────

describe("Guardrails: kein Rasterpunkt wird geklemmt", () => {
  const ACTION_KEYS = ["stopLossPct", "takeProfitRR", "riskBudgetPct", "maxPositionPct"] as const;
  const WINDOW_KEYS = ["maxExecutionsPerDay", "cooldownMinutes", "volumeWindow"] as const;

  test("die Raster-Endpunkte sind die Param-Grenzen (06-02 sieht den vollen Bereich)", () => {
    for (const key of PARAM_KEYS) {
      const spec = EMA_ADX_TREND_PARAMS[key];
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
      const spec = EMA_ADX_TREND_PARAMS[key];
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
        const spec2 = sanitize(paramsWith({ [key]: value }));
        const windowRaw = asRecord(raw.window);
        const windowSpec = spec2.window as unknown as Record<string, unknown>;
        for (const actionKey of ACTION_KEYS) {
          assert.equal(spec2.action[actionKey], action[actionKey], `${label}: sanitize klemmt action.${actionKey}`);
        }
        for (const windowKey of WINDOW_KEYS) {
          assert.equal(windowSpec[windowKey], windowRaw[windowKey], `${label}: sanitize klemmt window.${windowKey}`);
        }
        const rawConditions = conditionsOf(raw);
        assert.equal(
          spec2.condition.conditions.length,
          rawConditions.length,
          `${label}: eine Bedingung fiel durch die Whitelist`,
        );
        rawConditions.forEach((item, index) => {
          assert.deepEqual(spec2.condition.conditions[index], item, `${label}: Bedingung ${index} wurde verändert`);
        });
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
    // Deshalb ist der Parameterraum exakt passend: min/max des Templates sind
    // echte Teilbereiche, keine Zufälle.
    assert.ok(
      EMA_ADX_TREND_PARAMS.stopLossPct.min >= ceilingOf("stopLossPct")!.min &&
        EMA_ADX_TREND_PARAMS.stopLossPct.max <= ceilingOf("stopLossPct")!.max,
      "stopLossPct-Bereich ragt über RULE_CEILINGS hinaus",
    );
    assert.ok(
      EMA_ADX_TREND_PARAMS.takeProfitRR.min >= ceilingOf("takeProfitRR")!.min &&
        EMA_ADX_TREND_PARAMS.takeProfitRR.max <= ceilingOf("takeProfitRR")!.max,
      "takeProfitRR-Bereich ragt über RULE_CEILINGS hinaus",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) Akzeptanzkriterium 3 — die Grenze gehört in den Katalog
// ─────────────────────────────────────────────────────────────────────────────

describe("adxMin: 99 scheitert in validateTemplate, nicht erst in sanitizeRuleSpec", () => {
  test("der Katalog meldet genau einen Fehler: default über max", () => {
    const errors = validateTemplate(templateWithParam("adxMin", 99));
    assert.equal(errors.length, 1, errors.join(" | "));
    assert.match(errors[0], /params\.adxMin: default \(99\) muss ≤ max \(35\) sein/);
  });

  test("der Sanitizer ließe 99 durch — Beweis, dass die Grenze woanders stehen muss", () => {
    const spec = sanitize(paramsWith({ adxMin: 99 }));
    assert.equal(spec.condition.conditions[2].value, 99, "kein Deckel auf adx14: der Wert überlebt die ganze Kette");
    assert.equal(ceilingOf("adx14"), null, "es gibt keinen RULE_CEILINGS-Schlüssel adx14");
    // Und die Engine macht daraus eine Regel, die fast nie auslöst — still.
    assert.ok(Number(spec.condition.conditions[2].value) > 35);
  });

  test("auch unterhalb von min (adxMin: 4) lehnt der Katalog ab", () => {
    const errors = validateTemplate(templateWithParam("adxMin", 4));
    assert.equal(errors.length, 1, errors.join(" | "));
    assert.match(errors[0], /min \(15\) muss ≤ default \(4\)/);
  });

  test("ein Wert **am** Rand ist gültig (die Grenze ist inklusiv)", () => {
    assert.deepEqual(validateTemplate(templateWithParam("adxMin", 35)), []);
    assert.deepEqual(validateTemplate(templateWithParam("adxMin", 15)), []);
    assert.deepEqual(validateTemplate(templateWithParam("stopLossPct", 12)), []);
    assert.deepEqual(validateTemplate(templateWithParam("ema50BufferPct", 0)), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) Die zwei Doku-Pflichten als lebende Invarianten
// ─────────────────────────────────────────────────────────────────────────────

describe("Doku-Pflichten: Hysterese, 29 Kerzen, symbol-Vertrag", () => {
  test("ema50BufferPct liegt über der trend-Hysterese — aus dem Code gelesen", () => {
    // Die Hysterese ist keine exportierte Konstante, sondern eine Zeile in
    // `buildSnapshotFromCandles()`. Der Test liest sie dort: ändert die Engine
    // sie, schlägt dieser Test fehl, statt den Default still zu entwerten.
    const match = RULE_ENGINE_SOURCE.match(
      /const trendRel = Math\.abs\(e9\[e9\.length - 1\] - e21\[e21\.length - 1\]\) \/ price;\s*\n\s*let trend: TrendValue = "FLAT";\s*\n\s*if \(trendRel >= ([0-9.]+)\)/,
    );
    assert.ok(match, "trend-Hysterese in ruleEngine.ts nicht gefunden (die Zeile hat sich geändert)");
    const hysteresisPct = Number(match[1]) * 100;
    assert.equal(hysteresisPct, 0.1, "Hysterese ist nicht mehr 0,1 % — Kopf des Templates prüfen");
    assert.ok(
      EMA_ADX_TREND_PARAMS.ema50BufferPct.default > hysteresisPct,
      `Buffer ${EMA_ADX_TREND_PARAMS.ema50BufferPct.default} % liegt nicht über der Hysterese ${hysteresisPct} % — der Filter wäre wirkungslos`,
    );
  });

  test("der Kopf begründet den Ausschluss von 1m/5m und die Hysterese", () => {
    assert.match(TEMPLATE_SOURCE, /KEIN `1m` und KEIN `5m`/, "Timeframe-Begründung fehlt");
    assert.match(TEMPLATE_SOURCE, /2 \* period \+ 1|\*\*29 Kerzen\*\*/, "die 29-Kerzen-Regel muss genannt sein");
    assert.match(TEMPLATE_SOURCE, /Hysterese/, "die Hysterese muss begründet sein");
    assert.match(TEMPLATE_SOURCE, /0,1 %/, "die Hysterese muss beziffert sein");
    assert.match(TEMPLATE_SOURCE, /Pflicht des \*\*Aufrufers\*\*/, "der symbol-Vertrag muss dokumentiert sein");
    assert.match(TEMPLATE_SOURCE, /satisfies readonly SupportedTimeframe\[\]/, "Timeframes gegen das bestehende Vokabular typisiert");
  });

  test("die ADX-Annahme sagt dasselbe wie der Code", () => {
    assert.match(INDICATORS_SOURCE, /candles\.length < 2 \* period \+ 1\) return null/, "adx()-Warm-up geändert — Annahme nachziehen");
    const assumption = buildEmaAdxTrend().assumptions.find((a) => a.id === "adx-29-kerzen");
    assert.match(String(assumption?.statement), /29/);
    assert.equal(assumption?.critical, true, "ohne ADX gibt es für dieses Template keinen Trend — das ist kritisch");
  });

  test("der symbol-Vertrag steht im Kopf, nicht nur im Code", () => {
    assert.match(TEMPLATE_SOURCE, /buildRule\(params\)` liefert bewusst \*\*kein\*\* `symbol/, "der Verzicht auf symbol muss begründet sein");
    // Und er ist praktisch wirksam: Dieselbe Rohform wird mit und ohne Symbol
    // zu verschiedenen Ergebnissen — „kein Symbol“ ist kein Default, sondern
    // eine Ablehnung.
    const raw = emaAdxTrendRule(EMA_ADX_TREND_DEFAULTS);
    assert.equal(sanitizeRuleSpec(raw, "RESEARCH").ok, false);
    assert.equal(sanitize(paramsWith({}), "BTC").symbol, "BTC");
    assert.equal(sanitize(paramsWith({}), "btc").symbol, "BTC", "die Symbolnorm ist Sache der Engine, nicht des Templates");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7b) Semantik — die Regel tut, was der Kopf des Templates behauptet
// ─────────────────────────────────────────────────────────────────────────────

/** Eine Kerzenreihe: `rise` Kerzen Aufwärtsschub, danach `flat` Kerzen Stillstand. */
function trendSeries(bars: number, drift: number, volumeLast = 100): CandleLike[] {
  const out: CandleLike[] = [];
  let price = 100;
  let time = 1_700_000_000_000;
  for (let i = 0; i < bars; i++) {
    const close = price * drift;
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

describe("Semantik der vier Bedingungen (kompiliert, echte Snapshot-Pfade)", () => {
  /** Kompiliert **im** Test, nicht im describe-Rumpf: ein Fehler soll hier
   * benannt werden und nicht den ganzen Datei-Import sprengen. */
  const compiled = () => compileRuleSpec(sanitize(EMA_ADX_TREND_DEFAULTS));

  test("Aufwärtstrend mit 30 Kerzen und Normvolumen löst aus", () => {
    const snapshot = buildSnapshotFromCandles("BTC", trendSeries(30, 1.004));
    assert.ok(snapshot);
    assert.equal(snapshot.trend, "UP");
    assert.ok((snapshot.adx14 ?? 0) >= 22, "sauberer Trend muss den ADX-Filter passieren");
    // volumeRatio == 1 bei konstantem Volumen: Die Default-Schwelle 1.0 ist
    // **inklusiv** (`gte`) — genau das ist die Semantik von „mindestens Schnitt“.
    assert.equal(snapshot.volumeRatio, 1);
    assert.equal(compiled().evaluate(snapshot), true);
  });

  test("unter 29 Kerzen ist adx14 null und die Regel schweigt (fail-closed)", () => {
    // Der Kern der `critical: true`-Annahme: zu kurze Historie ist kein „bisschen
    // weniger Trend", sondern keine Entscheidung. Kein Trade, nicht ein Trade
    // mit erfundenem ADX.
    const snapshot = buildSnapshotFromCandles("BTC", trendSeries(26, 1.004));
    assert.ok(snapshot, "26 Kerzen sind über der Snapshot-Untergrenze von 25");
    assert.equal(snapshot.adx14, null);
    assert.equal(snapshot.trend, "UP", "der Trendzweig allein wäre schon „UP“ — der ADX bremst");
    assert.equal(compiled().evaluate(snapshot), false);
  });

  test("Seitwärtsphase löst nicht aus (trend FLAT, ADX 0)", () => {
    const flat: CandleLike[] = Array.from({ length: 80 }, (_, index) => ({
      time: 1_700_000_000_000 + index * 3_600_000,
      open: 100,
      high: 100.05,
      low: 99.95,
      close: 100,
      volume: 100,
    }));
    const snapshot = buildSnapshotFromCandles("BTC", flat);
    assert.ok(snapshot);
    assert.equal(snapshot.trend, "FLAT");
    assert.equal(compiled().evaluate(snapshot), false);
  });

  test("Volumen unter dem Schnitt kostet die Signalkerze den Auslöser", () => {
    const snapshot = buildSnapshotFromCandles("BTC", trendSeries(60, 1.004, 10));
    assert.ok(snapshot);
    assert.ok(snapshot.volumeRatio < 1, "die letzte Kerze muss unter ihrem Schnitt liegen");
    assert.equal(snapshot.trend, "UP", "Trend und Stärke stimmen — nur die Participation fehlt");
    assert.equal(compiled().evaluate(snapshot), false);
  });

  test("der ema50-Buffer filtert die Margin-Kerze, die trend + adx durchlassen", () => {
    // Handgebauter Snapshot (kein Kerzenrätsel): genau der Fall, den der Kopf
    // des Templates beschreibt — Trend entschieden, Kurs aber nur 0,05 % über
    // EMA 50, also innerhalb dessen, was die Hysterese als „kaum verschoben“
    // gelten lässt.
    const marginal = {
      price: 100,
      trend: "UP",
      ema9: 99.9,
      ema21: 99.7,
      priceVsEma50Pct: 0.05,
      adx14: 40,
      volumeRatio: 1.5,
    } as unknown as RuleSnapshot;

    assert.equal(compiled().evaluate(marginal), false, "Default-Buffer 0.2 % muss die Margin-Kerze ablehnen");
    const withoutBuffer = compileRuleSpec(sanitize(paramsWith({ ema50BufferPct: 0 })));
    assert.equal(withoutBuffer.evaluate(marginal), true, "bei min (0) ist die Bedingung ein Durchlass — der Grund, warum der Default darüber liegt");
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 8) Gesperrt — was dieser Prompt nicht darf
// ─────────────────────────────────────────────────────────────────────────────

describe("Sperren des Prompts (statische Wächter)", () => {
  test("kein SHORT, kein vwapPct-Feld, keine Sequenz-/Reclaim-Logik, kein `any`", () => {
    assert.doesNotMatch(TEMPLATE_SOURCE, /side:\s*["']SHORT["']/, "Shorts sind im Code global gesperrt");
    assert.doesNotMatch(TEMPLATE_SOURCE, /field:\s*["']vwapPct["']/, "vwapPct ist auf 1h nicht belastbar (STX-01)");
    assert.doesNotMatch(TEMPLATE_SOURCE, /op:\s*["'](RECLAIM|CROSS|SEQUENCE)["']/, "Sequenz-Logik ist Engine-Arbeit (STX-18)");
    assert.doesNotMatch(TEMPLATE_SOURCE, /logic:\s*["']any["']/, "die Bedingungen sind eine Konjunktion");
  });

  test("keine Engine-Arbeit: Deckel werden nicht geschrieben, die Importe bleiben rein", () => {
    assert.doesNotMatch(TEMPLATE_SOURCE, /RULE_CEILINGS\s*=[^=]/, "ein Template definiert keine Deckel");
    assert.doesNotMatch(TEMPLATE_SOURCE, /LIMIT_CEILINGS\s*=[^=]/);
    assert.doesNotMatch(TEMPLATE_SOURCE, /RULE_FIELDS\s*=[^=]/, "ein Template erweitert kein Regel-Vokabular");
    for (const forbidden of [
      /from "@\/lib\/(ollama|llmProvider|engine|microExecutor|ruleService)"/,
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

  test("kein Backtest-Lauf in 03-03 (der kommt in 03-10)", () => {
    assert.doesNotMatch(TEMPLATE_SOURCE, /from "@\/backtest\/|from "@\/lib\/ruleBacktest|runBacktest\s*\(/);
  });

  test("kein zweites Vokabular in src/strategies (ADR-008/ADR-009)", () => {
    assert.doesNotMatch(TEMPLATE_SOURCE, /type\s+\w+\s*=\s*(?:\|\s*)?["'](?:mean-reversion|trend|breakout)["']/);
    assert.doesNotMatch(TEMPLATE_SOURCE, /\[\s*["']mean-reversion["']/);
    assert.doesNotMatch(TEMPLATE_SOURCE, /["']unclassified["']\s*,\s*["']/);
    assert.doesNotMatch(TEMPLATE_SOURCE, /=\s*\[\s*["']TREND_UP["']/, "erwartete Regime sind keine eigene Liste im Template");
    assert.match(TEMPLATE_SOURCE, /from "\.\.\/types"/, "der Vertrag kommt aus types.ts");
  });

  test("die Engine-Deckel bleiben unverändert (Katalog und Template lesen nur)", () => {
    const snapshot = JSON.stringify(RULE_CEILINGS);
    validateTemplate(buildEmaAdxTrend());
    emaAdxTrendRule(EMA_ADX_TREND_DEFAULTS);
    sanitize(EMA_ADX_TREND_DEFAULTS);
    assert.equal(JSON.stringify(RULE_CEILINGS), snapshot);
  });
});
