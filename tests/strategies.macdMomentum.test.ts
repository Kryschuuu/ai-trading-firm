/**
 * Tests des MACD-Momentum-Templates (STX-03-04, `src/strategies/templates/`).
 *
 * Was hier geprüft wird, sind die Akzeptanzkriterien des Prompts — und zwar
 * gegen den **lebenden** Bestand, nie gegen abgeschriebene Zahlen:
 *
 *   1. `validateTemplate(buildMacdMomentum())` liefert `[]` (Katalog-Vertrag).
 *   2. `buildRule(defaults)` übersteht `sanitizeRuleSpec()` **ohne Klemmung** —
 *      für jeden Punkt des Parameterrasters, nicht nur für die Defaults. Ein
 *      Rasterpunkt, den der Sanitizer geradebiegt, wäre eine Messung der
 *      Klemmung statt der Strategie (06-02).
 *   3. **Keine Magnitude-Bedingung auf `macdHist`**: Die einzige
 *      `macdHist`-Bedingung des Builder-Outputs ist `gt 0` — über das ganze
 *      Raster und als statischer Wächter über den Dateitext.
 *   4. Ein Eintrag in `STRATEGY_TEMPLATES` (Roadmap-Reihenfolge: zweiter Platz).
 *   5. `stopLossPct`/`takeProfitRR` liegen **innerhalb** `RULE_CEILINGS` — für
 *      den gesamten Parameterraum, nicht nur für die Defaults.
 *   6. `buildRule` ist eine **reine** Funktion der Parameter.
 *
 * Dazu die Doku-Pflichten als lebende Invarianten: Die Preiseinheiten von
 * `macdHist` (`macd − signal`, gerundet auf 6 Stellen), die 35-Kerzen-Grenze
 * des MACD(12/26/9) und die Ablehnung einer Magnitude-Bedingung. Alles DB-,
 * LLM- und netzfrei; der Backtest selbst bleibt 03-10.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  MACD_MOMENTUM_DEFAULTS,
  MACD_MOMENTUM_ID,
  MACD_MOMENTUM_PARAMS,
  MACD_MOMENTUM_TIMEFRAMES,
  MACD_MOMENTUM_VERSION,
  buildMacdMomentum,
  macdMomentumRule,
  type MacdMomentumParamKey,
} from "../src/strategies/templates/macd-momentum";
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
import { strategyClassOfTemplate } from "../src/lib/marketRegime";

const ROOT = process.cwd();
const TEMPLATE_SOURCE = readFileSync(
  path.join(ROOT, "src/strategies/templates/macd-momentum.ts"),
  "utf8",
);
const RULE_ENGINE_SOURCE = readFileSync(path.join(ROOT, "src/lib/ruleEngine.ts"), "utf8");
const INDICATORS_SOURCE = readFileSync(path.join(ROOT, "src/lib/indicators.ts"), "utf8");

const PARAM_KEYS = Object.keys(MACD_MOMENTUM_PARAMS) as MacdMomentumParamKey[];

// ── Helfer ───────────────────────────────────────────────────────────────────

/** Der vertragliche Pfad: Rohform + **Symbol des Aufrufers**, dann Sanitizer. */
function sanitize(params: Record<string, number>, symbol = "BTC"): RuleSpec {
  const result = sanitizeRuleSpec({ ...macdMomentumRule(params), symbol } as RuleSpecInput, "MANUAL");
  if (!result.ok) throw new Error(`sanitizeRuleSpec lehnt ab: ${result.errors.join(" | ")}`);
  return result.spec;
}

/** Wie `sanitize`, aber mit Zugriff auf die volle Sanitize-Antwort (Fehlerpfade). */
function sanitizeResult(params: Record<string, number>, symbol = "BTC") {
  return sanitizeRuleSpec({ ...macdMomentumRule(params), symbol } as RuleSpecInput, "MANUAL");
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "erwartet ein Objekt");
  return value as Record<string, unknown>;
}

function conditionsOf(raw: RuleSpecInput): Array<Record<string, unknown>> {
  return asRecord(raw.condition).conditions as Array<Record<string, unknown>>;
}

/** Defaults, punktuell überschrieben — so fährt 06-02 später das Raster. */
function paramsWith(overrides: Partial<Record<MacdMomentumParamKey, number>>): Record<string, number> {
  return { ...MACD_MOMENTUM_DEFAULTS, ...overrides };
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
    for (const value of gridOf(MACD_MOMENTUM_PARAMS[key])) out.push(paramsWith({ [key]: value }));
  }
  return out;
}

/**
 * Ein Template, dessen Parameter-`default` auf `value` steht.
 *
 * Der Katalog ruft `buildRule()` mit genau den Defaults auf — einen Rasterpunkt
 * über den Default zu setzen ist deshalb der einzige Weg, die **vollständige**
 * Prüfung (Param-Grenzen + Builder + `RULE_CEILINGS`) auf diesem Punkt laufen zu
 * lassen.
 */
function templateWithParam(key: MacdMomentumParamKey, value: number): StrategyTemplate {
  const params: Record<string, ParamSpec> = {};
  for (const paramKey of PARAM_KEYS) {
    const spec = MACD_MOMENTUM_PARAMS[paramKey];
    params[paramKey] = paramKey === key ? { ...spec, default: value } : spec;
  }
  return { ...buildMacdMomentum(), params };
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

/** Eine Kerzenreihe mit konstantem Drift (Faktor je Kerze). */
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

/** Eine flache Kerzenreihe (Seitwärtsphase). */
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
 * der Test nicht zufällig über andere Zweige „grün“ wird.
 */
function snapshotWith(overrides: Record<string, unknown>): RuleSnapshot {
  return {
    price: 100,
    trend: "UP",
    ema9: 99.9,
    ema21: 99.7,
    priceVsEma50Pct: 0.5,
    adx14: 30,
    macdHist: 0.01,
    ...overrides,
  } as unknown as RuleSnapshot;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) Akzeptanzkriterium 1 — der Katalog nimmt das Artefakt
// ─────────────────────────────────────────────────────────────────────────────

describe("Akzeptanz: validateTemplate(buildMacdMomentum()) liefert []", () => {
  test("das frisch gebaute Template ist vertragsgültig", () => {
    assert.deepEqual(validateTemplate(buildMacdMomentum()), []);
  });

  test("die Registry-Prüfung wirft nicht (Import-Zeit-Pfad des Katalogs)", () => {
    assert.doesNotThrow(() => assertTemplatesValid([buildMacdMomentum()]));
    assert.doesNotThrow(() => assertTemplatesValid());
  });

  test("der Katalogeintrag ist genau dieses Artefakt (Roadmap-Reihenfolge: zweiter Platz)", () => {
    const entry = getTemplate(MACD_MOMENTUM_ID);
    assert.ok(entry, "macd-momentum muss im Katalog stehen");
    assert.equal(entry, listTemplates()[1], "Roadmap-Reihenfolge: 03-03, 03-04, …");
    assert.equal(entry?.id, MACD_MOMENTUM_ID);
    assert.equal(JSON.stringify(entry), JSON.stringify(buildMacdMomentum()));
    assert.ok(
      STRATEGY_TEMPLATES.some((template) => template.id === MACD_MOMENTUM_ID),
      "das Artefakt muss in der Registry stehen",
    );
    // Der Nachbar aus 03-03 steht weiter davor — die Reihenfolge ist die der
    // Roadmap, nicht die des Einfügens.
    assert.equal(listTemplates()[0]?.id, "ema-adx-trend");
  });

  test("die deklarierte Klasse stimmt mit der ADR-008-Ableitung überein", () => {
    const template = buildMacdMomentum();
    assert.equal(template.class, "trend");
    assert.equal(
      strategyClassOfTemplate(template.id),
      template.class,
      "ADR-008: deklarierte Klasse und Herkunfts-Heuristik dürfen nicht divergieren",
    );
  });

  test("jedes requiredFields-Feld lebt in RULE_FIELDS (Whitelist, nicht Kopie)", () => {
    const known = new Set(Object.keys(RULE_FIELDS));
    for (const field of buildMacdMomentum().requiredFields) {
      assert.ok(known.has(field), `${field} ist kein RULE_FIELDS-Feld`);
    }
  });

  test("das Template braucht nichts Neues: `macdHist` existiert bereits als Regelfeld", () => {
    assert.equal(RULE_FIELDS.macdHist, "number");
    assert.ok("macdHist" in RULE_FIELDS && "priceVsEma50Pct" in RULE_FIELDS && "adx14" in RULE_FIELDS);
  });

  test("das Artefakt ist über seine Felder auffindbar (templateByField, SSoT-Abfrage)", () => {
    for (const field of buildMacdMomentum().requiredFields) {
      assert.ok(
        templateByField(field).some((template) => template.id === MACD_MOMENTUM_ID),
        `${field} muss auf macd-momentum zeigen`,
      );
    }
    // Die geteilten Felder tragen beide Templates — die Abfrage ist keine
    // Ein-Element-Liste, sondern der Katalog.
    assert.ok(templateByField("adx14").some((template) => template.id === "ema-adx-trend"));
    assert.ok(templateByField("adx14").some((template) => template.id === MACD_MOMENTUM_ID));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Spec-Treue — die Tabellen des Prompts, Zeile für Zeile
// ─────────────────────────────────────────────────────────────────────────────

describe("Template-Daten: der Prompt als Test", () => {
  test("Kennung, Klasse, Version, Scope", () => {
    const t = buildMacdMomentum();
    assert.equal(t.id, "macd-momentum");
    assert.equal(t.id, MACD_MOMENTUM_ID, "exportierte ID und Template-ID sind eine Zahl");
    assert.equal(t.class, "trend");
    assert.equal(t.version, 1);
    assert.equal(t.version, MACD_MOMENTUM_VERSION);
    assert.equal(t.scope, "SINGLE_SYMBOL");
    assert.ok(t.name.trim().length > 0 && t.description.trim().length > 0, "name/description gehören zum Artefakt");
  });

  test("supportedTimeframes = 1h/4h — und kein einziger Intraday-Takt", () => {
    const t = buildMacdMomentum();
    assert.deepEqual([...t.supportedTimeframes], ["1h", "4h"]);
    assert.deepEqual(t.supportedTimeframes, MACD_MOMENTUM_TIMEFRAMES, "exportierte Liste = Template-Liste");
    for (const tf of t.supportedTimeframes) {
      assert.ok(SUPPORTED_TIMEFRAME_MS[tf] >= SUPPORTED_TIMEFRAME_MS["1h"], `${tf} ist feiner als 1h`);
    }
    // 35 MACD-Kerzen müssen mindestens einen Handelstag füllen, sonst misst das
    // Histogramm eine Session-Phase statt eines Momentum-Zyklus.
    for (const tf of t.supportedTimeframes) {
      assert.ok(
        35 * SUPPORTED_TIMEFRAME_MS[tf] >= 24 * 3_600_000,
        `${tf}: 35 Kerzen liegen unter einem Tag — keine Momentum-Basis`,
      );
    }
  });

  test("requiredFields exakt die vier Felder des Templates", () => {
    assert.deepEqual(
      [...buildMacdMomentum().requiredFields],
      ["macdHist", "priceVsEma50Pct", "adx14", "atrPct"],
    );
  });

  test("Parametertabelle: kind, label, unit, default, min, max, step, mapsTo", () => {
    const expected: Readonly<Record<MacdMomentumParamKey, Omit<ParamSpec, "key">>> = {
      adxMin: {
        kind: "threshold",
        label: "ADX-Mindestwert",
        unit: "Index",
        default: 20,
        min: 14,
        max: 35,
        step: 1,
        mapsTo: "adx14",
      },
      ema50BufferPct: {
        kind: "threshold",
        label: "Kurs über EMA 50",
        unit: "%",
        default: 0,
        min: -1,
        max: 3,
        step: 0.1,
        mapsTo: "priceVsEma50Pct",
      },
      stopLossPct: {
        kind: "threshold",
        label: "Stop-Loss",
        unit: "%",
        default: 4,
        min: 1,
        max: 12,
        step: 0.5,
        mapsTo: "atrPct",
      },
      takeProfitRR: {
        kind: "ratio",
        label: "Chance/Risiko",
        unit: "ratio",
        default: 2,
        min: 1,
        max: 4,
        step: 0.25,
        mapsTo: "atrPct",
      },
    };
    const t = buildMacdMomentum();
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
      { ...MACD_MOMENTUM_DEFAULTS },
      { adxMin: 20, ema50BufferPct: 0, stopLossPct: 4, takeProfitRR: 2 },
    );
  });

  test("kein Parameter mappt auf `macdHist` — es gibt hier nichts zu kalibrieren, was nicht skalenfrei wäre", () => {
    for (const key of PARAM_KEYS) {
      assert.notEqual(MACD_MOMENTUM_PARAMS[key].mapsTo, "macdHist", `params.${key} darf nicht auf macdHist mappen`);
    }
    // Alle Mappings zeigen auf vorhandene Regelfelder.
    for (const key of PARAM_KEYS) {
      assert.ok(MACD_MOMENTUM_PARAMS[key].mapsTo in RULE_FIELDS, `params.${key}.mapsTo ist kein Regelfeld`);
    }
  });

  test("expectedRegimes = [TREND_UP] — ohne UNKNOWN, ohne RANGE (ADR-009)", () => {
    assert.deepEqual([...buildMacdMomentum().expectedRegimes], ["TREND_UP"]);
  });

  test("assumptions: die vier Pflichtannahmen mit Kategorie und critical-Flag", () => {
    const assumptions = buildMacdMomentum().assumptions;
    assert.ok(assumptions.length >= 4, `mindestens 4 Annahmen, sind ${assumptions.length}`);
    const expected: ReadonlyArray<{ id: string; category: string; critical: boolean }> = [
      { id: "macd-histogramm-vorzeichen", category: "MARKET", critical: false },
      { id: "macd-hist-keine-staerke-metrik", category: "MARKET", critical: true },
      { id: "macd-35-kerzen", category: "DATA", critical: true },
      { id: "histogramm-wechsel-cooldown", category: "COST", critical: false },
    ];
    for (const want of expected) {
      const got = assumptions.find((a) => a.id === want.id);
      assert.ok(got, `Annahme ${want.id} fehlt`);
      assert.equal(got.category, want.category, want.id);
      assert.equal(got.critical, want.critical, `${want.id}: critical-Flag`);
      assert.ok(got.statement.trim().length > 20, `${want.id}: statement ist ein Platzhalter`);
    }
    // `critical: true` heißt „ohne diese Annahme ist das Ergebnis wertlos“:
    // hier sind es genau die Preiseinheiten-Lehre (MARKET) und die
    // 35-Kerzen-Grenze (DATA).
    assert.deepEqual(
      assumptions
        .filter((a) => a.critical)
        .map((a) => a.category)
        .sort(),
      ["DATA", "MARKET"],
    );
    const strength = assumptions.find((a) => a.id === "macd-hist-keine-staerke-metrik");
    assert.match(String(strength?.statement), /nicht skalenfrei|Preiseinheiten/i);
    const warmup = assumptions.find((a) => a.id === "macd-35-kerzen");
    assert.match(String(warmup?.statement), /35/);
    for (const a of assumptions) {
      assert.match(a.id, /^[a-z0-9-]{1,64}$/, `id ${a.id} außerhalb des Schemas`);
      assert.ok(["MARKET", "COST", "LIQUIDITY", "DATA", "REGIME", "EXECUTION"].includes(a.category), a.category);
    }
    assert.equal(new Set(assumptions.map((a) => a.id)).size, assumptions.length, "Annahme-IDs eindeutig");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) buildRule — die gelieferte Rohform
// ─────────────────────────────────────────────────────────────────────────────

describe("buildRule(defaults): die drei Bedingungen, die Action, das Fenster", () => {
  test("condition ist eine `all`-Konjunktion über genau drei Regeln", () => {
    const raw = macdMomentumRule(MACD_MOMENTUM_DEFAULTS);
    assert.equal(asRecord(raw.condition).logic, "all");
    assert.deepEqual(conditionsOf(raw), [
      { field: "macdHist", op: "gt", value: 0 },
      { field: "priceVsEma50Pct", op: "gt", value: 0 },
      { field: "adx14", op: "gte", value: 20 },
    ]);
    assert.ok(
      conditionsOf(raw).length <= RULE_CEILINGS.maxConditions,
      "mehr Bedingungen als maxConditions würde der Sanitizer still kappen",
    );
  });

  test("action: LONG mit den verifizierten Risiko-Werten", () => {
    const action = asRecord(macdMomentumRule(MACD_MOMENTUM_DEFAULTS).action);
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
    const window = asRecord(macdMomentumRule(MACD_MOMENTUM_DEFAULTS).window);
    assert.deepEqual(window, {
      timeframe: "1h",
      validFrom: null,
      validUntil: null,
      maxExecutionsPerDay: 2,
      cooldownMinutes: 240,
      volumeWindow: 20,
    });
    // `volumeWindow` ist dieselbe Referenz, gegen die der Snapshot
    // `volumeRatio` bildet — die Regel nutzt kein Volumenfeld, aber ein
    // abweichendes Fenster wäre trotzdem eine zweite Wahrheit über den Snapshot.
    assert.equal(window.volumeWindow, 20);
    assert.ok(
      (MACD_MOMENTUM_TIMEFRAMES as readonly unknown[]).includes(window.timeframe),
      "window.timeframe muss ein unterstützter Takt des Templates sein",
    );
  });

  test("Herkunft, Rationale, Risiko-Score, Mission — und kein symbol", () => {
    const raw = macdMomentumRule(MACD_MOMENTUM_DEFAULTS);
    assert.equal(raw.sourceRole, "RESEARCH");
    assert.equal(raw.missionId, null);
    assert.equal(raw.riskScore, 0.5);
    assert.ok(String(raw.name).includes(MACD_MOMENTUM_ID), "name trägt die Template-ID (Familienname, kein Symbol)");
    const rationale = String(raw.rationale);
    assert.match(rationale, /[a-zäöüß]/, "rationale ist deutsch verfasst");
    assert.ok(rationale.length > 40 && rationale.length <= 600, "rationale muss in den 600-Zeichen-Schnitt des Sanitizers passen");
    // Der Kern des `symbol`-Vertrags: der Builder kennt keinen Markt — und ohne
    // Symbol bleibt die Rohform eine Rohform (fail-closed, kein Default).
    assert.equal("symbol" in raw, false, "symbol ist Pflicht des Aufrufers, nie des Builders");
    assert.equal(sanitizeRuleSpec(raw, "MANUAL").ok, false, "ohne Symbol darf es keine Regel geben");
  });

  test("jeder Parameter erreicht die Regel — kein Parameter ist Deko", () => {
    const raw = macdMomentumRule(
      paramsWith({ adxMin: 30, ema50BufferPct: 1.5, stopLossPct: 7.5, takeProfitRR: 3.25 }),
    );
    assert.deepEqual(
      conditionsOf(raw).map((item) => [item.field, item.value]),
      [
        ["macdHist", 0],
        ["priceVsEma50Pct", 1.5],
        ["adx14", 30],
      ],
    );
    const action = asRecord(raw.action);
    assert.equal(action.stopLossPct, 7.5);
    assert.equal(action.takeProfitRR, 3.25);
    // Die Rationale zitiert die Werte: eine Zahl, die in der Regel steht und im
    // Klartext fehlt, wäre eine Audit-Lüge.
    for (const value of [1.5, 30, 7.5, 3.25]) {
      assert.ok(rationaleMentions(String(raw.rationale), value), `rationale nennt ${value} nicht`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) Akzeptanzkriterium 3 — KEINE Magnitude-Bedingung auf `macdHist`
// ─────────────────────────────────────────────────────────────────────────────

describe("MACD-Preiseinheiten: die einzige `macdHist`-Bedingung ist `gt 0`", () => {
  test("grep über den Builder-Output: genau eine macdHist-Bedingung, und sie ist `gt 0`", () => {
    // Über **jeden** Rasterpunkt aller Parameter, nicht nur über die Defaults —
    // eine Magnitude dürfte an keiner Stelle des Parameterraums entstehen.
    for (const params of everyGridParams()) {
      const raw = macdMomentumRule(params);
      const conditions = conditionsOf(raw);
      const macdConditions = conditions.filter((item) => item.field === "macdHist");
      assert.equal(
        macdConditions.length,
        1,
        `genau eine macdHist-Bedingung erwartet, sind ${macdConditions.length} (${JSON.stringify(params)})`,
      );
      assert.deepEqual(macdConditions[0], { field: "macdHist", op: "gt", value: 0 });
      // Der Vorzeichen-Test ist die **erste** Bedingung (load-bearing, nicht
      // nachträglich angehängt).
      assert.equal(conditions[0].field, "macdHist");
      // Und die rohe Bedingung serialisiert exakt auf `gt 0` — kein
      // zusätzliches `between`, kein zweiter Eintrag mit Magnitude.
      assert.match(JSON.stringify(macdConditions[0]), /^\{"field":"macdHist","op":"gt","value":0\}$/);
    }
  });

  test("auch die Sanitize-Kette erhält die Bedingung unverändert: `gt 0`, nie eine Magnitude", () => {
    const spec = sanitize(paramsWith({ adxMin: 35, ema50BufferPct: 3, stopLossPct: 12, takeProfitRR: 4 }));
    const macdConditions = spec.condition.conditions.filter((c) => c.field === "macdHist");
    assert.equal(macdConditions.length, 1);
    assert.equal(macdConditions[0].op, "gt");
    assert.equal(macdConditions[0].value, 0);
  });

  test("statischer Wächter: `macdHist` steht im Builder nur mit `value: 0`, nie mit Magnitude", () => {
    // Genau ein Feld-Literal — der Text erwähnt das Feld sonst nur in Prosa.
    assert.equal(
      [...TEMPLATE_SOURCE.matchAll(/field:\s*"macdHist"/g)].length,
      1,
      "genau eine macdHist-Bedingung im Builder-Quelltext",
    );
    const block = TEMPLATE_SOURCE.match(/\{[^{}]*field:\s*"macdHist"[^{}]*\}/);
    assert.ok(block, "die macdHist-Bedingung wurde im Quelltext nicht gefunden");
    assert.match(block![0], /op:\s*"gt"/);
    assert.match(block![0], /value:\s*0\b/);
    assert.doesNotMatch(block![0], /value:\s*[1-9]/, "kein positiver Wert in der macdHist-Bedingung");
    // Und nirgends steht ein Vergleich von macdHist gegen eine Zahl ungleich 0
    // (auch nicht in Prosa-Beispielen) — nur `0` ist skalenfrei.
    assert.doesNotMatch(TEMPLATE_SOURCE, /macdHist\s*(?:gt|gte|lt|lte|>|>=|<|<=)\s*(?!0\b)\d/);
    assert.doesNotMatch(TEMPLATE_SOURCE, /macdHist[^\n]*\b(?:gte|lte|between|lt)\b/, "nur `gt 0` ist zulässig");
  });

  test("keine Bedingung und kein Parameter auf `macd`/`macdSignal` (dieselbe Preiseinheiten-Falle)", () => {
    assert.doesNotMatch(TEMPLATE_SOURCE, /field:\s*"macd(Signal)?"/, "macd/macdSignal sind keine Bedingungsfelder");
    assert.doesNotMatch(TEMPLATE_SOURCE, /mapsTo:\s*"macd(Signal)?"/);
    const raw = macdMomentumRule(MACD_MOMENTUM_DEFAULTS);
    const fields = conditionsOf(raw).map((item) => item.field);
    assert.ok(!fields.includes("macd") && !fields.includes("macdSignal"));
  });

  test("Doku-Pflicht: der Kopf erklärt die Magnitude-Ablehnung und nennt `priceVsEma50Pct` als skalenfreien Ersatz", () => {
    assert.match(TEMPLATE_SOURCE, /keine Magnitude-Bedingung/i, "die Ablehnung muss wörtlich im Kopf stehen");
    assert.match(TEMPLATE_SOURCE, /Preiseinheiten/, "die Einheit von macdHist muss benannt sein");
    assert.match(TEMPLATE_SOURCE, /skalenfrei/i, "der Begriff der Skalenfreiheit fehlt");
    assert.match(TEMPLATE_SOURCE, /priceVsEma50Pct/, "der skalenfreie Ersatz muss genannt sein");
    assert.match(TEMPLATE_SOURCE, /Verwechslung von Momentum und Volatilität/i, "die Analyse-Reihenfolge muss benannt sein");
  });

  test("die Einheit von `macdHist` ist im Bestand wirklich der Preis: macd − signal", () => {
    // Diese Invariante ist der Grund für die Regel oben. Ändert jemand die
    // Semantik des Feldes (z. B. auf Prozent), muss dieser Test fallen und die
    // Begründung im Template nachgezogen werden.
    assert.match(INDICATORS_SOURCE, /histogram:\s*macdValue\s*-\s*signalValue/, "histogramm = macd − signal");
    assert.match(
      RULE_ENGINE_SOURCE,
      /macdHist:\s*macdValue != null \? Number\(macdValue\.histogram\.toFixed\(6\)\) : null/,
      "der Snapshot schreibt das Histogramm unskaliert (nur gerundet) in macdHist",
    );
    // Und der Feldkatalog sagt dasselbe.
    const fieldCatalog = readFileSync(path.join(ROOT, "src/lib/ruleFieldCatalog.ts"), "utf8");
    assert.match(fieldCatalog, /macdHist: "number"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) Reinheit und Determinismus
// ─────────────────────────────────────────────────────────────────────────────

describe("buildRule ist eine reine, deterministische Funktion der Parameter", () => {
  test("zwei Aufrufe mit denselben Defaults sind tiefengleich", () => {
    const first = macdMomentumRule(MACD_MOMENTUM_DEFAULTS);
    const second = macdMomentumRule(MACD_MOMENTUM_DEFAULTS);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second), "auch die Key-Reihenfolge ist stabil (Artefakt-Hash, 04-01)");
  });

  test("zwei Aufrufe teilen keine Objekt-Referenzen (kein geteilter Zustand)", () => {
    const first = asRecord(macdMomentumRule(MACD_MOMENTUM_DEFAULTS).condition);
    const second = asRecord(macdMomentumRule(MACD_MOMENTUM_DEFAULTS).condition);
    assert.notEqual(first, second);
    assert.notEqual(first.conditions, second.conditions);
    assert.deepEqual(first, second);
  });

  test("der Builder verändert das übergebene params-Objekt nicht", () => {
    const params: Record<string, number> = { ...MACD_MOMENTUM_DEFAULTS };
    const before = { ...params };
    macdMomentumRule(params);
    assert.deepEqual(params, before);
  });

  test("unbekannte Schlüssel erreichen die Regel nicht", () => {
    const withExtras = paramsWith({});
    withExtras.riskBudgetPct = 0.5; // ein Schlüssel, den das Template nicht kennt
    withExtras.macdHistMin = 0.5; // der Magnitude-Versuch von außen
    withExtras.side = -1;
    assert.deepEqual(macdMomentumRule(withExtras), macdMomentumRule(MACD_MOMENTUM_DEFAULTS));
    assert.equal(
      asRecord(macdMomentumRule(withExtras).action).riskBudgetPct,
      0.01,
      "ein params-Schlüssel darf ein festes Guardrail nicht überschreiben",
    );
    // Und selbst ein von außen injizierter Magnitude-Schlüssel ändert die
    // macdHist-Bedingung nicht — der Builder liest seine Parameter whitelist.
    assert.deepEqual(conditionsOf(macdMomentumRule(withExtras))[0], { field: "macdHist", op: "gt", value: 0 });
  });

  test("fehlende oder nicht endliche Parameter sind ein Wurf, kein Default", () => {
    for (const bad of [undefined, null, NaN, Infinity, "20", {}, []] as unknown[]) {
      const params: Record<string, unknown> = { ...MACD_MOMENTUM_DEFAULTS, adxMin: bad };
      assert.throws(
        () => macdMomentumRule(params as Record<string, number>),
        /adxMin/,
        `Wert ${String(bad)} darf nicht still durchgehen`,
      );
    }
    const partial: Record<string, number> = { ...MACD_MOMENTUM_DEFAULTS };
    delete partial.takeProfitRR;
    assert.throws(() => macdMomentumRule(partial), /takeProfitRR/);
  });

  test("ein Wert außerhalb des Bereichs ist **kein** Builder-Problem (Grenzen prüft der Katalog)", () => {
    const raw = macdMomentumRule(paramsWith({ adxMin: 99 }));
    assert.equal(conditionsOf(raw)[2].value, 99);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) Akzeptanzkriterium 2 + 6 — Klemmfreiheit über das ganze Raster
// ─────────────────────────────────────────────────────────────────────────────

describe("Guardrails: kein Rasterpunkt wird geklemmt", () => {
  const ACTION_KEYS = ["stopLossPct", "takeProfitRR", "riskBudgetPct", "maxPositionPct"] as const;
  const WINDOW_KEYS = ["maxExecutionsPerDay", "cooldownMinutes", "volumeWindow"] as const;

  test("die Raster-Endpunkte sind die Param-Grenzen (06-02 sieht den vollen Bereich)", () => {
    for (const key of PARAM_KEYS) {
      const spec = MACD_MOMENTUM_PARAMS[key];
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
      const spec = MACD_MOMENTUM_PARAMS[key];
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
        //     kein Verwerfen einer Bedingung — und keine Magnitude.
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
      MACD_MOMENTUM_PARAMS.stopLossPct.min >= ceilingOf("stopLossPct")!.min &&
        MACD_MOMENTUM_PARAMS.stopLossPct.max <= ceilingOf("stopLossPct")!.max,
      "stopLossPct-Bereich ragt über RULE_CEILINGS hinaus",
    );
    assert.ok(
      MACD_MOMENTUM_PARAMS.takeProfitRR.min >= ceilingOf("takeProfitRR")!.min &&
        MACD_MOMENTUM_PARAMS.takeProfitRR.max <= ceilingOf("takeProfitRR")!.max,
      "takeProfitRR-Bereich ragt über RULE_CEILINGS hinaus",
    );
  });

  test("auch die verschachtelten Fenster-Grenzen sind Teilbereiche der Deckel", () => {
    const window = asRecord(macdMomentumRule(MACD_MOMENTUM_DEFAULTS).window);
    assert.ok(
      Number(window.maxExecutionsPerDay) >= ceilingOf("maxExecutionsPerDay")!.min &&
        Number(window.maxExecutionsPerDay) <= ceilingOf("maxExecutionsPerDay")!.max,
    );
    assert.ok(
      Number(window.cooldownMinutes) >= ceilingOf("cooldownMinutes")!.min &&
        Number(window.cooldownMinutes) <= ceilingOf("cooldownMinutes")!.max,
    );
    assert.ok(
      Number(window.volumeWindow) >= ceilingOf("volumeWindow")!.min &&
        Number(window.volumeWindow) <= ceilingOf("volumeWindow")!.max,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) Katalog-Grenzen: der Parameterraum ist dort verteidigt, wo er hingehört
// ─────────────────────────────────────────────────────────────────────────────

describe("die Parametergrenzen gehören in den Katalog, nicht in den Builder", () => {
  test("`adxMin: 99` scheitert in validateTemplate — genau ein Fehler", () => {
    const errors = validateTemplate(templateWithParam("adxMin", 99));
    assert.equal(errors.length, 1, errors.join(" | "));
    assert.match(errors[0], /params\.adxMin: default \(99\) muss ≤ max \(35\) sein/);
  });

  test("der Sanitizer ließe 99 durch — Beweis, dass die Grenze woanders stehen muss", () => {
    const spec = sanitize(paramsWith({ adxMin: 99 }));
    assert.equal(spec.condition.conditions[2].value, 99, "kein Deckel auf adx14: der Wert überlebt die ganze Kette");
    assert.equal(ceilingOf("adx14"), null, "es gibt keinen RULE_CEILINGS-Schlüssel adx14");
    assert.ok(Number(spec.condition.conditions[2].value) > 35);
  });

  test("auch unterhalb von min (adxMin: 4) und beim negativen Buffer (ema50BufferPct: -2) lehnt der Katalog ab", () => {
    const belowMin = validateTemplate(templateWithParam("adxMin", 4));
    assert.equal(belowMin.length, 1, belowMin.join(" | "));
    assert.match(belowMin[0], /min \(14\) muss ≤ default \(4\)/);

    const tooNegative = validateTemplate(templateWithParam("ema50BufferPct", -2));
    assert.equal(tooNegative.length, 1, tooNegative.join(" | "));
    assert.match(tooNegative[0], /min \(-1\) muss ≤ default \(-2\)/);
  });

  test("ein Wert **am** Rand ist gültig (die Grenze ist inklusiv)", () => {
    for (const [key, value] of [
      ["adxMin", 14],
      ["adxMin", 35],
      ["ema50BufferPct", -1],
      ["ema50BufferPct", 3],
      ["stopLossPct", 1],
      ["stopLossPct", 12],
      ["takeProfitRR", 1],
      ["takeProfitRR", 4],
    ] as Array<[MacdMomentumParamKey, number]>) {
      assert.deepEqual(validateTemplate(templateWithParam(key, value)), [], `${key}=${value}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8) Semantik — die Regel tut, was der Kopf des Templates behauptet
// ─────────────────────────────────────────────────────────────────────────────

describe("Semantik der drei Bedingungen (kompiliert, echte Snapshot-Pfade)", () => {
  /** Kompiliert **im** Test, nicht im describe-Rumpf. */
  const compiled = () => compileRuleSpec(sanitize(MACD_MOMENTUM_DEFAULTS));
  const compiledWith = (params: Record<string, number>) => compileRuleSpec(sanitize(params));

  test("Aufwärtstrend über 35 Kerzen löst aus — echtes Histogramm-Vorzeichen aus dem Snapshot", () => {
    const snapshot = buildSnapshotFromCandles("BTC", trendSeries(35, 1.004));
    assert.ok(snapshot);
    assert.equal(snapshot.trend, "UP");
    assert.ok((snapshot.macdHist ?? 0) > 0, "steigende Reihe muss ein positives Histogramm liefern");
    assert.ok((snapshot.adx14 ?? 0) >= 20, "sauberer Trend muss den ADX-Filter passieren");
    assert.ok((snapshot.priceVsEma50Pct ?? 0) > 0);
    assert.equal(compiled().evaluate(snapshot), true);
  });

  test("unter 35 Kerzen ist macdHist null und die Regel schweigt (fail-closed) — bei lebendem ADX", () => {
    // Der Kern der `critical: true`-Annahme: Bei 34 Kerzen ist der ADX (29
    // Kerzen) längst da, Trend und EMA-50-Abstand stimmen — trotzdem gibt es
    // KEINEN Trade, weil das Histogramm fehlt. Kein Trade mit erfundenem Wert.
    const snapshot = buildSnapshotFromCandles("BTC", trendSeries(34, 1.004));
    assert.ok(snapshot, "34 Kerzen sind über der Snapshot-Untergrenze von 25");
    assert.equal(snapshot.macdHist, null, "MACD(12/26/9) braucht 35 Schlusskurse");
    assert.notEqual(snapshot.adx14, null, "der ADX-Filter allein wäre erfüllbar — das Histogramm bremst");
    assert.ok((snapshot.priceVsEma50Pct ?? 0) > 0, "auch der EMA-50-Filter allein wäre erfüllbar");
    assert.equal(compiled().evaluate(snapshot), false);
  });

  test("Seitwärtsphase: Histogramm exakt 0 löst nicht aus (gt, nicht gte)", () => {
    const snapshot = buildSnapshotFromCandles("BTC", flatSeries(120));
    assert.ok(snapshot);
    assert.equal(snapshot.macdHist, 0, "flache Reihe ⇒ Histogramm 0");
    assert.equal(snapshot.trend, "FLAT");
    assert.equal(compiled().evaluate(snapshot), false);
  });

  test("Abwärtstrend: Histogramm positiv, aber Kurs unter EMA 50 — der skalenfreie Filter bremst", () => {
    // Genau der Fall, für den `priceVsEma50Pct` im Template steht: Das
    // Histogramm allein sagt bei fallenden Reihen „positiv“, der Prozentabstand
    // zum EMA 50 sagt „darunter“ — keine Long-Eröffnung.
    const snapshot = buildSnapshotFromCandles("BTC", trendSeries(120, 0.996));
    assert.ok(snapshot);
    assert.ok((snapshot.macdHist ?? 0) > 0, "Histogramm kann in der fallenden Reihe positiv stehen");
    assert.ok((snapshot.priceVsEma50Pct ?? 0) < 0, "der Kurs liegt unter seinem EMA 50");
    assert.equal(compiled().evaluate(snapshot), false);
  });

  test("handgebaute Snapshots: jede der drei Bedingungen kann den Auslöser einzeln kosten", () => {
    assert.equal(compiled().evaluate(snapshotWith({})), true, "Referenzfall löst aus");

    // 1) Histogramm-Vorzeichen
    assert.equal(compiled().evaluate(snapshotWith({ macdHist: 0 })), false, "0 ist kein positives Vorzeichen");
    assert.equal(compiled().evaluate(snapshotWith({ macdHist: -0.001 })), false);
    assert.equal(compiled().evaluate(snapshotWith({ macdHist: 0.0001 })), true, "jedes positive Vorzeichen zählt, egal wie klein");

    // 2) Kurs vs. EMA 50 — strikt (`gt`), Default 0.0
    assert.equal(compiled().evaluate(snapshotWith({ priceVsEma50Pct: 0 })), false, "exakt auf dem EMA 50 ist kein Reclaim");
    assert.equal(compiled().evaluate(snapshotWith({ priceVsEma50Pct: -0.5 })), false);

    // 3) ADX — inklusiv (`gte`)
    assert.equal(compiled().evaluate(snapshotWith({ adx14: 19.9 })), false);
    assert.equal(compiled().evaluate(snapshotWith({ adx14: 20 })), true, "adxMin ist inklusiv");
  });

  test("der negative Buffer ist messbar: mit ema50BufferPct = -1 trägt der frühe Impuls unter dem EMA 50", () => {
    // Keine Empfehlung, sondern die Messbarkeit, die 06-02 braucht: der
    // Parameterraum endet nicht bei der Vorsicht des Defaults.
    const loose = compiledWith({ ...MACD_MOMENTUM_DEFAULTS, ema50BufferPct: -1 });
    assert.equal(loose.evaluate(snapshotWith({ priceVsEma50Pct: -0.5 })), true, "leicht unter EMA 50 liegt innerhalb -1 %");
    assert.equal(loose.evaluate(snapshotWith({ priceVsEma50Pct: -1.5 })), false, "unterhalb des Buffers bleibt es gesperrt");
    // Und der Default lehnt denselben Snapshot ab — der Unterschied ist der
    // Parameter, nicht die Umgebung.
    assert.equal(compiled().evaluate(snapshotWith({ priceVsEma50Pct: -0.5 })), false);
  });

  test("`adxMin: 14` (unterer Rand) und `adxMin: 35` (oberer Rand) kompilieren zu unterscheidbaren Regeln", () => {
    const low = compiledWith({ ...MACD_MOMENTUM_DEFAULTS, adxMin: 14 });
    const high = compiledWith({ ...MACD_MOMENTUM_DEFAULTS, adxMin: 35 });
    const snapshot = snapshotWith({ adx14: 25 });
    assert.equal(low.evaluate(snapshot), true);
    assert.equal(high.evaluate(snapshot), false);
  });

  test("die Regel ist im Backtest-Pfad dieselbe (sanitize ⇒ compile, keine Engine-Sonderfälle)", () => {
    const spec = sanitize(MACD_MOMENTUM_DEFAULTS);
    assert.equal(spec.window.timeframe, "1h");
    assert.equal(spec.action.side, "LONG");
    assert.equal(spec.symbol, "BTC");
    const result = sanitizeResult(MACD_MOMENTUM_DEFAULTS, "btc");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.spec.symbol, "BTC", "die Symbolnorm ist Sache der Engine, nicht des Templates");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9) Gesperrt — was dieser Prompt nicht darf
// ─────────────────────────────────────────────────────────────────────────────

describe("Sperren des Prompts (statische Wächter)", () => {
  test("kein SHORT, kein bbZScore, keine Sequenz-/Reclaim-Logik, kein `any`", () => {
    assert.doesNotMatch(TEMPLATE_SOURCE, /side:\s*["']SHORT["']/, "Shorts sind im Code global gesperrt");
    assert.doesNotMatch(TEMPLATE_SOURCE, /field:\s*["']bbZScore["']/, "bbZScore kommt in 03-06");
    assert.doesNotMatch(TEMPLATE_SOURCE, /op:\s*["'](RECLAIM|CROSS|SEQUENCE)["']/, "Sequenz-Logik ist Engine-Arbeit (STX-18)");
    assert.doesNotMatch(TEMPLATE_SOURCE, /logic:\s*["']any["']/, "die Bedingungen sind eine Konjunktion");
    assert.doesNotMatch(TEMPLATE_SOURCE, /:\s*any\b/);
  });

  test("keine Magnitude auf `macdHist` — weder als Parameter noch als Bedingung (Sperre des Prompts)", () => {
    assert.doesNotMatch(TEMPLATE_SOURCE, /macdHistMin|macdHistMax|macdHistThreshold/, "kein Magnitude-Parameter");
    const raw = macdMomentumRule(MACD_MOMENTUM_DEFAULTS);
    const conditionText = JSON.stringify(asRecord(raw.condition));
    assert.equal(
      conditionText.match(/macdHist/g)?.length,
      1,
      "genau eine macdHist-Bedingung im gesamten Builder-Output",
    );
    assert.match(conditionText, /"field":"macdHist","op":"gt","value":0/);
    assert.doesNotMatch(conditionText, /"field":"macdHist","op":"(gte|lt|lte|between|in)"/);
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

  test("die MACD-Felder der Engine bleiben unverändert (die Regel liest nur)", () => {
    const engineSnapshot = JSON.stringify(RULE_CEILINGS);
    const fieldsBefore = JSON.stringify(RULE_FIELDS.macd + RULE_FIELDS.macdSignal + RULE_FIELDS.macdHist);
    buildMacdMomentum();
    macdMomentumRule(MACD_MOMENTUM_DEFAULTS);
    sanitize(MACD_MOMENTUM_DEFAULTS);
    assert.equal(JSON.stringify(RULE_CEILINGS), engineSnapshot, "RULE_CEILINGS bleibt unangetastet");
    assert.equal(
      JSON.stringify(RULE_FIELDS.macd + RULE_FIELDS.macdSignal + RULE_FIELDS.macdHist),
      fieldsBefore,
      "die MACD-Feldtypen bleiben unangetastet",
    );
    // Das Template importiert keines der MACD-Felder als Wert — es liest nur
    // das Vorzeichen über die Regel.
    assert.doesNotMatch(TEMPLATE_SOURCE, /from "@\/lib\/indicators"/, "kein Direktzugriff auf den Indikator");
  });

  test("kein Backtest-Lauf in 03-04 (der kommt in 03-10)", () => {
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
    validateTemplate(buildMacdMomentum());
    macdMomentumRule(MACD_MOMENTUM_DEFAULTS);
    sanitize(MACD_MOMENTUM_DEFAULTS);
    assert.equal(JSON.stringify(RULE_CEILINGS), snapshot);
  });
});
