/**
 * Tests des Template-Katalogs (STX-03-02, `src/strategies/catalog.ts`).
 *
 * Diese Datei ist bewusst **DB-, LLM- und netzfrei**: Geprüft wird der
 * deterministische Kern — die Registry-Validierung. Der Kernpunkt des Prompts
 * ist fail-closed: Ein kaputtes Template muss **beim Import** sterben, nicht
 * erst beim Backtest. Deshalb steht hier für jede Zeile der Prüftabelle
 * mindestens ein Negativfall, der **genau einen** erwarteten Fehler liefert
 * (ein zweiter Fehler würde bedeuten, dass die Prüfung unscharf ist).
 *
 * Was hier NICHT getestet wird: die sechs konkreten Templates (03-03 … 03-08)
 * und der Compiler inkl. `sanitizeRuleSpec()` (03-09). Der Katalog sanitized
 * nichts — er prüft nur, dass ein Builder innerhalb der Guardrails bleibt.
 *
 * Hinweis zur Testbasis: `baseTemplate()` unten ist eine eigene, minimal
 * gültige Fassung. Der Katalog hält seine Fixtures absichtlich **nicht**
 * exportiert (`__fixtures`, nur für die Import-Zeit-Canary) — die Testbasis
 * gehört deshalb zum Test, genau wie die Negativfälle.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  STRATEGY_TEMPLATE_ID_RE,
  STRATEGY_TEMPLATE_IDS,
  STRATEGY_TEMPLATES,
  assertTemplatesValid,
  getTemplate,
  isStrategyTemplateId,
  listTemplates,
  templateByField,
  validateTemplate,
} from "../src/strategies/catalog";
import { RULE_CEILINGS } from "../src/lib/ruleEngine";
import type { RuleField, RuleSpecInput } from "../src/lib/ruleEngine";
import { RULE_FIELDS } from "../src/lib/ruleFieldCatalog";
import { STRATEGY_CLASS_KEYS } from "../src/lib/signalDecay";
import { SUPPORTED_TIMEFRAMES } from "../src/lib/marketdata/timeframes";
import type { ParamSpec, StrategyTemplate } from "../src/strategies/types";

// ── Testdaten ────────────────────────────────────────────────────────────────

/** Minimal gültiges Template — Basis jedes Negativfalls. */
function baseTemplate(): StrategyTemplate {
  return {
    id: "fixture-valid",
    name: "Fixture: gültiges Template",
    description: "Testbasis für die Negativfälle des Katalogs.",
    version: 1,
    class: "trend",
    scope: "SINGLE_SYMBOL",
    supportedTimeframes: ["1h", "4h"],
    requiredFields: ["ema9", "ema21"],
    params: {
      fast: {
        key: "fast",
        kind: "period",
        label: "schnelle EMA",
        unit: "Bars",
        default: 9,
        min: 3,
        max: 30,
        step: 1,
        mapsTo: "ema9",
      },
      slow: {
        key: "slow",
        kind: "period",
        label: "langsame EMA",
        unit: "Bars",
        default: 21,
        min: 10,
        max: 60,
        step: 1,
        mapsTo: "ema21",
      },
    },
    buildRule: (params): RuleSpecInput => ({
      name: "fixture-trend",
      symbol: "BTC",
      rationale: "Reine Funktion der Parameter — kein ctx, kein Marktdatenzugriff.",
      condition: {
        logic: "all",
        conditions: [
          { field: "ema9", op: "gt", value: params.fast },
          { field: "ema21", op: "lt", value: params.slow },
        ],
      },
      action: {
        side: "LONG",
        stopLossPct: 5,
        takeProfitRR: 1.5,
        riskBudgetPct: 0.01,
        maxPositionPct: 0.2,
        positionSizeMode: "risk",
      },
      window: {
        timeframe: "1h",
        validFrom: null,
        validUntil: null,
        maxExecutionsPerDay: 3,
        cooldownMinutes: 60,
        volumeWindow: 20,
      },
    }),
    assumptions: [
      {
        id: "fixture-trend-haelt",
        statement: "Trendphasen sind häufiger als Seitwärtsphasen.",
        category: "MARKET",
        critical: true,
      },
    ],
    expectedRegimes: ["TREND_UP", "TREND_DOWN"],
  };
}

/** Die Rohform, die der gültige Builder mit den Defaults liefert. */
function baseSpec(): Record<string, unknown> {
  return baseTemplate().buildRule({ fast: 9, slow: 21 }) as Record<string, unknown>;
}

/** Negativfall über die Parameter: ein Record-Eintrag wird gezielt geändert. */
function withParams(edit: (params: Record<string, ParamSpec>) => void): StrategyTemplate {
  const params: Record<string, ParamSpec> = { ...baseTemplate().params };
  edit(params);
  return { ...baseTemplate(), params };
}

/** Negativfall über den Builder: die gelieferte Rohform wird gezielt geändert. */
function withRule(edit: (spec: Record<string, unknown>) => void): StrategyTemplate {
  const spec = baseSpec();
  edit(spec);
  return { ...baseTemplate(), buildRule: () => spec as RuleSpecInput };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) STRATEGY_TEMPLATE_IDS — geschlossene Union
// ─────────────────────────────────────────────────────────────────────────────

describe("STRATEGY_TEMPLATE_IDs — geschlossene Union der geplanten Templates", () => {
  test("führt exakt die sechs geplanten IDs in Roadmap-Reihenfolge", () => {
    assert.deepEqual([...STRATEGY_TEMPLATE_IDS], [
      "ema-adx-trend",
      "macd-momentum",
      "rsi-mean-reversion",
      "bollinger-squeeze",
      "vwap-pullback",
      "donchian-breakout",
    ]);
  });

  test("jede ID erfüllt das Katalog-Schema", () => {
    for (const id of STRATEGY_TEMPLATE_IDS) {
      assert.match(id, STRATEGY_TEMPLATE_ID_RE, `${id} verstößt gegen das ID-Format`);
      assert.ok(id.length >= 3 && id.length <= 64, `${id}: Länge außerhalb 3…64`);
    }
    assert.equal(new Set(STRATEGY_TEMPLATE_IDS).size, STRATEGY_TEMPLATE_IDS.length, "IDs eindeutig");
  });

  test("isStrategyTemplateId trennt bekannt von unbekannt (kein stiller Default)", () => {
    for (const id of STRATEGY_TEMPLATE_IDS) assert.equal(isStrategyTemplateId(id), true, id);
    for (const raw of ["", "ema-adx", "EMA-ADX-TREND", "donchian-breakout ", null, 42, undefined]) {
      assert.equal(isStrategyTemplateId(raw), false, String(raw));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Katalog ist leer — Templates kommen in 03-03 … 03-08
// ─────────────────────────────────────────────────────────────────────────────

describe("Katalog: leer, aber vollständig abfragbar", () => {
  test("STRATEGY_TEMPLATES und listTemplates() sind leer (kein Template in 03-02)", () => {
    assert.equal(STRATEGY_TEMPLATES.length, 0);
    assert.deepEqual([...listTemplates()], []);
  });

  test("getTemplate liefert für jede geplante ID null — nie einen Default", () => {
    for (const id of STRATEGY_TEMPLATE_IDS) assert.equal(getTemplate(id), null, id);
  });

  test("listTemplates() gibt genau den Katalog zurück (eine SSoT, keine Kopie)", () => {
    assert.equal(listTemplates(), STRATEGY_TEMPLATES);
  });

  test("templateByField akzeptiert jedes Regel-Feld und liefert solange []", () => {
    for (const field of Object.keys(RULE_FIELDS) as RuleField[]) {
      assert.deepEqual([...templateByField(field)], [], `${field}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) Positivfall
// ─────────────────────────────────────────────────────────────────────────────

describe("validateTemplate — gültiges Template", () => {
  test("die gültige Basis liefert eine leere Fehlerliste", () => {
    assert.deepEqual(validateTemplate(baseTemplate()), []);
  });

  test("ein zweiter Aufruf liefert dieselbe Liste (deterministisch)", () => {
    assert.deepEqual(validateTemplate(baseTemplate()), validateTemplate(baseTemplate()));
  });

  test("jede der drei Bestandsklassen ist zulässig (ADR-008)", () => {
    for (const cls of STRATEGY_CLASS_KEYS) {
      if (cls === "unclassified") continue; // eigener Negativfall
      assert.deepEqual(validateTemplate({ ...baseTemplate(), class: cls }), [], cls);
    }
  });

  test("jeder Timeframe der Allowlist ist zulässig (STX-01)", () => {
    assert.deepEqual(
      validateTemplate({ ...baseTemplate(), supportedTimeframes: [...SUPPORTED_TIMEFRAMES] }),
      [],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) Negativfälle — je genau ein erwarteter Fehler
// ─────────────────────────────────────────────────────────────────────────────

const NEGATIVE_CASES: ReadonlyArray<{
  name: string;
  build: () => StrategyTemplate;
  expect: RegExp;
}> = [
  // ── Identität / Version ───────────────────────────────────────────────────
  {
    name: "ID-Format: Großbuchstaben und Unterstrich",
    build: () => ({ ...baseTemplate(), id: "EMA_ADX_Trend" }),
    expect: /ID-Format/,
  },
  {
    name: "ID-Format: zu kurz",
    build: () => ({ ...baseTemplate(), id: "ab" }),
    expect: /ID-Format/,
  },
  {
    name: "ID-Format: kein String",
    build: () => ({ ...baseTemplate(), id: 42 as unknown as string }),
    expect: /ID-Format/,
  },
  {
    name: "Version: 0",
    build: () => ({ ...baseTemplate(), version: 0 }),
    expect: /version muss eine Ganzzahl ≥ 1 sein/,
  },
  {
    name: "Version: 1.5",
    build: () => ({ ...baseTemplate(), version: 1.5 }),
    expect: /version muss eine Ganzzahl ≥ 1 sein/,
  },

  // ── Klasse (ADR-008) ──────────────────────────────────────────────────────
  {
    name: "Klasse: unclassified (ADR-008)",
    build: () => ({ ...baseTemplate(), class: "unclassified" }),
    expect: /unclassified.*ADR-008/,
  },
  {
    name: "Klasse: außerhalb STRATEGY_CLASS_KEYS",
    build: () => ({ ...baseTemplate(), class: "momentum" as StrategyTemplate["class"] }),
    expect: /kein Schlüssel aus STRATEGY_CLASS_KEYS/,
  },

  // ── Timeframes (STX-01) ───────────────────────────────────────────────────
  {
    name: "Timeframes: leer",
    build: () => ({ ...baseTemplate(), supportedTimeframes: [] }),
    expect: /supportedTimeframes darf nicht leer sein/,
  },
  {
    name: "Timeframes: außerhalb SUPPORTED_TIMEFRAMES",
    build: () => ({
      ...baseTemplate(),
      supportedTimeframes: ["7d" as StrategyTemplate["supportedTimeframes"][number]],
    }),
    expect: /kein Wert aus SUPPORTED_TIMEFRAMES/,
  },
  {
    name: "Timeframes: Duplikat",
    build: () => ({ ...baseTemplate(), supportedTimeframes: ["1h", "1h"] }),
    expect: /doppelt/,
  },

  // ── requiredFields (Whitelist) ────────────────────────────────────────────
  {
    name: "requiredFields: unbekannter Feldname",
    build: () => ({ ...baseTemplate(), requiredFields: ["nichtImKatalog" as RuleField] }),
    expect: /kein Feld aus RULE_FIELDS/,
  },
  {
    name: "requiredFields: kein Array",
    build: () => ({
      ...baseTemplate(),
      requiredFields: "ema9" as unknown as StrategyTemplate["requiredFields"],
    }),
    expect: /requiredFields muss ein Array sein/,
  },

  // ── Params ────────────────────────────────────────────────────────────────
  {
    name: "Params: min > default",
    build: () => withParams((p) => void (p.fast = { ...p.fast, min: 50 })),
    expect: /min \(50\) muss ≤ default \(9\) sein/,
  },
  {
    name: "Params: default > max",
    build: () => withParams((p) => void (p.fast = { ...p.fast, default: 99 })),
    expect: /default \(99\) muss ≤ max \(30\) sein/,
  },
  {
    name: "Params: step = 0",
    build: () => withParams((p) => void (p.fast = { ...p.fast, step: 0 })),
    expect: /step muss > 0 sein/,
  },
  {
    name: "Params: step negativ",
    build: () => withParams((p) => void (p.fast = { ...p.fast, step: -1 })),
    expect: /step muss > 0 sein/,
  },
  {
    name: "Params: min nicht endlich",
    build: () => withParams((p) => void (p.fast = { ...p.fast, min: Number.NaN })),
    expect: /min muss eine endliche Zahl sein/,
  },
  {
    name: "Params: key nicht eindeutig",
    build: () => withParams((p) => void (p.slow = { ...p.slow, key: "fast" })),
    expect: /key „fast“ ist nicht eindeutig/,
  },
  {
    name: "Params: key fehlt",
    build: () => withParams((p) => void (p.fast = { ...p.fast, key: "" })),
    expect: /key fehlt oder ist leer/,
  },
  {
    name: "Params: Eintrag ist kein ParamSpec-Objekt",
    build: () => withParams((p) => void (p.fast = "9" as unknown as ParamSpec)),
    expect: /ist kein ParamSpec-Objekt/,
  },
  {
    name: "mapsTo: unbekanntes Regel-Feld",
    build: () => withParams((p) => void (p.fast = { ...p.fast, mapsTo: "gibtEsNicht" as RuleField })),
    expect: /mapsTo.*kein Feld aus RULE_FIELDS/,
  },

  // ── Builder ───────────────────────────────────────────────────────────────
  {
    name: "Builder: Rückgabe ist undefined",
    build: () => ({ ...baseTemplate(), buildRule: () => undefined as unknown as RuleSpecInput }),
    expect: /liefert kein Objekt/,
  },
  {
    name: "Builder: Rückgabe ist ein Array",
    build: () => ({ ...baseTemplate(), buildRule: () => [] as unknown as RuleSpecInput }),
    expect: /liefert kein Objekt/,
  },
  {
    name: "Builder: nicht deterministisch",
    build: () => {
      const spec = baseSpec();
      let calls = 0;
      return {
        ...baseTemplate(),
        buildRule: (): RuleSpecInput => ({ ...spec, aufrufe: ++calls }) as RuleSpecInput,
      };
    },
    expect: /nicht deterministisch/,
  },
  {
    name: "Builder: wirft",
    build: () => ({
      ...baseTemplate(),
      buildRule: (): RuleSpecInput => {
        throw new Error("boom");
      },
    }),
    expect: /buildRule\(defaults\) wirft: boom/,
  },
  {
    name: "Builder: Bedingungsfeld außerhalb RULE_FIELDS",
    build: () =>
      withRule((spec) => {
        (spec.condition as Record<string, unknown>).conditions = [
          { field: "erfundenesFeld", op: "gt", value: 1 },
        ];
      }),
    expect: /kein Feld aus RULE_FIELDS/,
  },
  {
    name: "Builder: keine Bedingung",
    build: () =>
      withRule((spec) => {
        (spec.condition as Record<string, unknown>).conditions = [];
      }),
    expect: /erzeugt keine Bedingung/,
  },
  {
    name: "Builder: Bedingungseintrag ist kein Objekt",
    build: () =>
      withRule((spec) => {
        (spec.condition as Record<string, unknown>).conditions = ["ema9"];
      }),
    expect: /condition\.conditions\[0\] ist kein Objekt/,
  },
  {
    name: "Builder: action.side SHORT",
    build: () =>
      withRule((spec) => {
        (spec.action as Record<string, unknown>).side = "SHORT";
      }),
    expect: /action\.side „SHORT“ ist nicht erlaubt/,
  },
  {
    name: "Builder: stopLossPct 999 (RULE_CEILINGS)",
    build: () =>
      withRule((spec) => {
        (spec.action as Record<string, unknown>).stopLossPct = 999;
      }),
    expect: /action\.stopLossPct = 999 liegt außerhalb von RULE_CEILINGS/,
  },
  {
    name: "Builder: maxPositionPct über dem Deckel",
    build: () =>
      withRule((spec) => {
        (spec.action as Record<string, unknown>).maxPositionPct = RULE_CEILINGS.maxPositionPct[1] + 0.01;
      }),
    expect: /action\.maxPositionPct.*RULE_CEILINGS/,
  },
  {
    name: "Builder: takeProfitRR unter dem Boden",
    build: () =>
      withRule((spec) => {
        (spec.action as Record<string, unknown>).takeProfitRR = RULE_CEILINGS.takeProfitRR[0] - 0.1;
      }),
    expect: /action\.takeProfitRR.*RULE_CEILINGS/,
  },
  {
    name: "Builder: cooldownMinutes über dem Deckel (verschachtelt)",
    build: () =>
      withRule((spec) => {
        (spec.window as Record<string, unknown>).cooldownMinutes = RULE_CEILINGS.cooldownMinutes[1] + 1;
      }),
    expect: /window\.cooldownMinutes.*RULE_CEILINGS/,
  },
  {
    name: "Builder: mehr Bedingungen als RULE_CEILINGS.maxConditions",
    build: () =>
      withRule((spec) => {
        (spec.condition as Record<string, unknown>).conditions = Array.from(
          { length: RULE_CEILINGS.maxConditions + 1 },
          () => ({ field: "ema9", op: "gt", value: 1 }),
        );
      }),
    expect: /RULE_CEILINGS\.maxConditions/,
  },
  {
    name: "Builder: action ist kein Objekt",
    build: () =>
      withRule((spec) => {
        spec.action = "LONG";
      }),
    expect: /action ist kein Objekt/,
  },

  // ── Assumptions ───────────────────────────────────────────────────────────
  {
    name: "Assumptions: doppelte ID",
    build: () => ({
      ...baseTemplate(),
      assumptions: [
        { id: "doppelt", statement: "erste Annahme", category: "MARKET", critical: false },
        { id: "doppelt", statement: "zweite Annahme", category: "MARKET", critical: false },
      ],
    }),
    expect: /assumptions: id „doppelt“ ist nicht eindeutig/,
  },
  {
    name: "Assumptions: leerer statement",
    build: () => ({
      ...baseTemplate(),
      assumptions: [{ id: "leer", statement: "   ", category: "MARKET", critical: false }],
    }),
    expect: /statement der Annahme „leer“ ist leer/,
  },
  {
    name: "Assumptions: kein Array",
    build: () => ({
      ...baseTemplate(),
      assumptions: { id: "x" } as unknown as StrategyTemplate["assumptions"],
    }),
    expect: /assumptions muss ein Array sein/,
  },

  // ── expectedRegimes (ADR-009) ─────────────────────────────────────────────
  {
    name: "expectedRegimes: UNKNOWN (ADR-009)",
    build: () => ({
      ...baseTemplate(),
      expectedRegimes: ["UNKNOWN" as StrategyTemplate["expectedRegimes"][number]],
    }),
    expect: /kein MarketRegime.*ohne UNKNOWN/,
  },
  {
    name: "expectedRegimes: Fremd-Label der verworfenen 7er-Taxonomie",
    build: () => ({
      ...baseTemplate(),
      expectedRegimes: ["BULL" as StrategyTemplate["expectedRegimes"][number]],
    }),
    expect: /kein MarketRegime/,
  },
  {
    name: "expectedRegimes: kein Array",
    build: () => ({
      ...baseTemplate(),
      expectedRegimes: "TREND_UP" as unknown as StrategyTemplate["expectedRegimes"],
    }),
    expect: /expectedRegimes muss ein Array sein/,
  },
];

describe("validateTemplate — Negativfälle (je genau ein Fehler)", () => {
  test(`die Prüftabelle ist mit mindestens 10 Fällen abgedeckt (hier: ${NEGATIVE_CASES.length})`, () => {
    assert.ok(NEGATIVE_CASES.length >= 10, "Auftrag: ≥ 10 Negativfälle");
  });

  for (const negative of NEGATIVE_CASES) {
    test(negative.name, () => {
      const errors = validateTemplate(negative.build());
      assert.equal(errors.length, 1, `erwartet genau einen Fehler, bekam: ${errors.join(" | ")}`);
      assert.match(errors[0], negative.expect);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) RULE_CEILINGS werden gelesen, nicht kopiert
// ─────────────────────────────────────────────────────────────────────────────

describe("RULE_CEILINGS: der Katalog liest die lebenden Deckel", () => {
  test("ein Wert exakt AM Deckel ist gültig, ein Hauch darüber nicht", () => {
    const atCeiling = withRule((spec) => {
      (spec.action as Record<string, unknown>).stopLossPct = RULE_CEILINGS.stopLossPct[1];
    });
    assert.deepEqual(validateTemplate(atCeiling), []);

    const above = withRule((spec) => {
      (spec.action as Record<string, unknown>).stopLossPct = RULE_CEILINGS.stopLossPct[1] + 0.01;
    });
    assert.equal(validateTemplate(above).length, 1);
  });

  test("auch die Fenster-Deckel werden gegen die lebenden Werte geprüft", () => {
    const atCeiling = withRule((spec) => {
      (spec.window as Record<string, unknown>).cooldownMinutes = RULE_CEILINGS.cooldownMinutes[1];
      (spec.window as Record<string, unknown>).maxExecutionsPerDay = RULE_CEILINGS.maxExecutionsPerDay[1];
      (spec.window as Record<string, unknown>).volumeWindow = RULE_CEILINGS.volumeWindow[1];
    });
    assert.deepEqual(validateTemplate(atCeiling), []);
  });

  test("der Katalog verändert RULE_CEILINGS nicht (nur Lesezugriff)", () => {
    const before = JSON.stringify(RULE_CEILINGS);
    validateTemplate(baseTemplate());
    validateTemplate({
      ...baseTemplate(),
      buildRule: (): RuleSpecInput => ({ ...baseSpec(), stopLossPct: 9999 }) as RuleSpecInput,
    });
    assert.equal(JSON.stringify(RULE_CEILINGS), before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) assertTemplatesValid — der Import-Zeit-Wächter
// ─────────────────────────────────────────────────────────────────────────────

describe("assertTemplatesValid — wirft beim Negativ-Template", () => {
  test("wirft nicht für den leeren Katalog (03-02 liefert keine Templates)", () => {
    assert.doesNotThrow(() => assertTemplatesValid());
    assert.doesNotThrow(() => assertTemplatesValid([]));
  });

  test("wirft nicht für ein gültiges Template", () => {
    assert.doesNotThrow(() => assertTemplatesValid([baseTemplate()]));
  });

  test("wirft für ein Template mit kaputter ID und nennt ID + Grund", () => {
    assert.throws(
      () => assertTemplatesValid([{ ...baseTemplate(), id: "bad_id" }]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Strategie-Templates ungültig/);
        assert.match(err.message, /bad_id: id „bad_id“ verstößt gegen das ID-Format/);
        return true;
      },
    );
  });

  test("wirft für class: „unclassified“ (ADR-008)", () => {
    assert.throws(
      () => assertTemplatesValid([{ ...baseTemplate(), class: "unclassified" }]),
      /unclassified/,
    );
  });

  test("wirft für expectedRegimes: [„UNKNOWN“] (ADR-009)", () => {
    assert.throws(
      () =>
        assertTemplatesValid([
          {
            ...baseTemplate(),
            expectedRegimes: ["UNKNOWN" as StrategyTemplate["expectedRegimes"][number]],
          },
        ]),
      /kein MarketRegime/,
    );
  });

  test("wirft für einen Builder mit stopLossPct: 999", () => {
    assert.throws(
      () =>
        assertTemplatesValid([
          withRule((spec) => {
            (spec.action as Record<string, unknown>).stopLossPct = 999;
          }),
        ]),
      /RULE_CEILINGS/,
    );
  });

  test("wirft für einen Builder mit action.side: „SHORT“", () => {
    assert.throws(
      () =>
        assertTemplatesValid([
          withRule((spec) => {
            (spec.action as Record<string, unknown>).side = "SHORT";
          }),
        ]),
      /action\.side/,
    );
  });

  test("wirft für einen Builder mit einem Feld außerhalb RULE_FIELDS", () => {
    assert.throws(
      () =>
        assertTemplatesValid([
          withRule((spec) => {
            (spec.condition as Record<string, unknown>).conditions = [
              { field: "erfundenesFeld", op: "gt", value: 1 },
            ];
          }),
        ]),
      /kein Feld aus RULE_FIELDS/,
    );
  });

  test("wirft bei doppelter Template-ID im Katalog", () => {
    assert.throws(
      () => assertTemplatesValid([baseTemplate(), baseTemplate()]),
      /Template-ID ist im Katalog nicht eindeutig/,
    );
  });

  test("meldet ALLE beanstandeten Templates in einem Wurf (Registry, nicht Einzelfall)", () => {
    assert.throws(
      () =>
        assertTemplatesValid([
          { ...baseTemplate(), id: "bad_id" },
          { ...baseTemplate(), id: "fixture-zwei", version: 0 },
        ]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /bad_id/);
        assert.match(err.message, /fixture-zwei/);
        return true;
      },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) Modul-Struktur — Import-Zeit-Canary und gesperrte Pfade
// ─────────────────────────────────────────────────────────────────────────────

const CATALOG_SOURCE = readFileSync(
  path.join(process.cwd(), "src/strategies/catalog.ts"),
  "utf8",
);

describe("Modul-Struktur: Import-Zeit-Wächter, Fixtures, Sperren", () => {
  test("der Modul-Import wirft assertTemplatesValid() auf (ein kaputtes Template startet nicht)", () => {
    assert.match(CATALOG_SOURCE, /^assertTemplatesValid\(\);\s*$/m);
    assert.match(CATALOG_SOURCE, /^assertValidatorCalibrated\(\);\s*$/m);
  });

  test("der Negativfall liegt im __fixtures-Bereich und ist NICHT exportiert", () => {
    assert.match(CATALOG_SOURCE, /const __fixtures = \{/);
    assert.match(CATALOG_SOURCE, /brokenTemplate\(\): StrategyTemplate/);
    assert.doesNotMatch(CATALOG_SOURCE, /export\s+(const|function|\{)[^\n]*__fixtures/);
    assert.doesNotMatch(CATALOG_SOURCE, /export\s*\{[^}]*brokenTemplate/);
  });

  test("die Canary prüft beide Richtungen (nicht fail-open, nicht überstreng)", () => {
    assert.match(CATALOG_SOURCE, /const broken = validateTemplate\(__fixtures\.brokenTemplate\(\)\)/);
    assert.match(CATALOG_SOURCE, /const valid = validateTemplate\(__fixtures\.validTemplate\(\)\)/);
  });

  test("RULE_CEILINGS wird importiert und nie zugewiesen (der Katalog erweitert keine Deckel)", () => {
    assert.match(CATALOG_SOURCE, /import \{[^}]*RULE_CEILINGS[^}]*\} from "@\/lib\/ruleEngine"/);
    assert.doesNotMatch(CATALOG_SOURCE, /RULE_CEILINGS\s*=[^=]/);
    assert.doesNotMatch(CATALOG_SOURCE, /RULE_CEILINGS\s*\.\w+\s*=/);
  });

  test("kein LLM-/Prompt-Pfad und keine DB im Katalog (deterministisch, reine Daten)", () => {
    for (const forbidden of [
      /from "@\/lib\/(ollama|llmProvider|engine)"/,
      /from "@\/db\//,
      /from "pg"/,
      /Math\.random/,
      /Date\.now/,
    ]) {
      assert.doesNotMatch(CATALOG_SOURCE, forbidden);
    }
  });

  test("kein zweites Klassen- oder Regime-Vokabular (ADR-008 / ADR-009)", () => {
    // Kein eigener Union-Typ …
    assert.doesNotMatch(
      CATALOG_SOURCE,
      /type\s+\w+\s*=\s*(?:\|\s*)?["'](?:mean-reversion|trend|breakout|TREND_UP)["']/,
    );
    // … und keine eigene Liste: beide Mengen werden aus dem Bestand abgeleitet.
    assert.doesNotMatch(CATALOG_SOURCE, /=\s*\[\s*["'](?:mean-reversion|trend|breakout)["']/);
    assert.doesNotMatch(CATALOG_SOURCE, /=\s*\[\s*["']TREND_UP["']/);
    assert.match(CATALOG_SOURCE, /Object\.keys\(MARKET_REGIME_SEVERITY\)/);
    assert.match(CATALOG_SOURCE, /new Set<string>\(STRATEGY_CLASS_KEYS\)/);
  });
});
