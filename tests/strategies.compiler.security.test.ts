/**
 * STX-03-09 — Pflicht-Beweis der Compiler-Kette (`src/strategies/compiler.ts`).
 *
 * Diese Datei beweist **nicht**, dass der Compiler schön ist, sondern dass der
 * Template-Weg die Sicherheitsmechanismen des Repos nicht umgeht:
 *
 *   1. `sanitizeRuleSpec()` wird aufgerufen — und ihr Ergebnis bestimmt den
 *      Rückgabewert (Spy + Sentinel + Fehlerrückgabe, kein Rückfall auf Rohform).
 *   2. Klemmung: `stopLossPct: 999` wird auf das Ceiling geklemmt und als
 *      `clamped` sichtbar — kein stiller „Erfolg“.
 *   3. Unbekanntes Feld, fremder Operator und `SHORT` bleiben verboten.
 *   4. Ein fehlendes `requiredFields`-Feld ist `{ok:false}` mit
 *      `requiredFields`-Fehler.
 *   5. Der Fingerprint ist stabil (Reihenfolge, Prozessgrenzen) und reagiert
 *      auf `codeVersion`.
 *   6. ROLLOUT: alle sechs Katalog-Templates kompilieren ohne Klemmung.
 *
 * Die Fixtures sind bewusst Testeigentum (der Katalog exportiert die seinen
 * nicht) und laufen über die `deps`-Naht von `compileTemplate()`, damit
 * absichtlich kaputte Builder (`RuleSpecInput` ist `Record<string, unknown>` —
 * der Typ kann sie nicht verhindern, genau deshalb ist der Sanitizer Pflicht)
 * ohne Katalogmutation prüfbar sind.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  EXPORT_PROBE_SYMBOL,
  compileTemplate,
  exportTemplates,
  strategyFingerprint,
} from "../src/strategies/compiler";
import type { CompileDeps, CompileTemplateInput } from "../src/strategies/compiler";
import { STRATEGY_TEMPLATES, getTemplate } from "../src/strategies/catalog";
import type { ParamSpec, StrategyTemplate } from "../src/strategies/types";
import { RULE_CEILINGS, sanitizeRuleSpec } from "../src/lib/ruleEngine";
import type { RuleSpec, RuleSpecInput } from "../src/lib/ruleEngine";
import { getLimits } from "../src/lib/riskGuard";
import { DEFAULT_CLASS_POLICIES, STRATEGY_CLASS_KEYS } from "../src/lib/signalDecay";
import { MARKET_REGIME_SEVERITY, regimeGateFactor } from "../src/lib/marketRegime";
import type { MarketRegime } from "../src/lib/marketRegime";
import { APP_VERSION } from "../src/lib/version";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — bewusst außerhalb des Katalogs
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE_ID = "fixture-compiler";
const FIXTURE_INPUT: CompileTemplateInput = {
  templateId: FIXTURE_ID,
  symbol: "BTC/USDT",
  timeframe: "1h",
};

type FixtureTweak = (rule: Record<string, unknown>, params: Readonly<Record<string, number>>) => void;

/** Ein gültiges Fixture-Template; `tweak` darf die Builder-Ausgabe absichtlich brechen. */
function fixtureTemplate(tweak?: FixtureTweak): StrategyTemplate {
  const params: Readonly<Record<string, ParamSpec>> = {
    adxMin: {
      key: "adxMin",
      kind: "threshold",
      label: "ADX-Minimum",
      unit: "Index",
      default: 20,
      min: 10,
      max: 40,
      step: 1,
      mapsTo: "adx14",
    },
    volumeRatioMin: {
      key: "volumeRatioMin",
      kind: "threshold",
      label: "Volumenverhältnis",
      unit: "ratio",
      default: 1,
      min: 0.5,
      max: 3,
      step: 0.05,
      mapsTo: "volumeRatio",
    },
    stopLossPct: {
      key: "stopLossPct",
      kind: "threshold",
      label: "Stop-Loss",
      unit: "%",
      default: 4,
      min: 1,
      max: 12,
      step: 0.5,
      mapsTo: "atrPct",
    },
  };
  return {
    id: FIXTURE_ID,
    name: "Fixture: Compiler-Sicherheitspfad",
    description: "Test-Artefakt für den Sanitize-Nachweis (STX-03-09).",
    version: 7,
    class: "trend",
    scope: "SINGLE_SYMBOL",
    supportedTimeframes: ["1h", "4h"],
    requiredFields: ["adx14", "volumeRatio", "atrPct"],
    params,
    buildRule: (given): RuleSpecInput => {
      const rule: Record<string, unknown> = {
        name: `${FIXTURE_ID} v7`,
        condition: {
          logic: "all",
          conditions: [
            { field: "adx14", op: "gte", value: given.adxMin },
            { field: "volumeRatio", op: "gte", value: given.volumeRatioMin },
          ],
        },
        action: {
          side: "LONG",
          stopLossPct: given.stopLossPct,
          takeProfitRR: 1.5,
          riskBudgetPct: 0.01,
          maxPositionPct: 0.15,
          positionSizeMode: "risk",
        },
        window: {
          timeframe: "1h",
          validFrom: null,
          validUntil: null,
          maxExecutionsPerDay: 2,
          cooldownMinutes: 60,
          volumeWindow: 20,
        },
        rationale: "Nur für den Sicherheitsbeweis — kein handelbares Artefakt.",
        sourceRole: "RESEARCH",
        riskScore: 0.5,
      };
      tweak?.(rule, given);
      return rule;
    },
    assumptions: [
      { id: "fixture-annahme", statement: "Testdaten, keine Marktbehauptung.", category: "DATA", critical: true },
    ],
    expectedRegimes: ["TREND_UP"],
  };
}

function depsFor(tweak?: FixtureTweak, extra?: CompileDeps): CompileDeps {
  return {
    resolveTemplate: (templateId) => (templateId === FIXTURE_ID ? fixtureTemplate(tweak) : null),
    ...extra,
  };
}

function compileFixture(tweak?: FixtureTweak, extra?: CompileDeps, input?: Partial<CompileTemplateInput>) {
  return compileTemplate({ ...FIXTURE_INPUT, ...input }, depsFor(tweak, extra));
}

function conditionFields(rule: unknown): string[] {
  const conditions = (rule as { condition?: { conditions?: Array<{ field?: unknown }> } })?.condition
    ?.conditions;
  return Array.isArray(conditions) ? conditions.map((item) => String(item.field)) : [];
}

function mutateAction(rule: Record<string, unknown>, patch: Record<string, unknown>): void {
  const action = rule.action as Record<string, unknown>;
  Object.assign(action, patch);
}

function mutateConditions(rule: Record<string, unknown>, patch: (items: Array<Record<string, unknown>>) => void): void {
  const condition = rule.condition as { conditions: Array<Record<string, unknown>> };
  patch(condition.conditions);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) sanitizeRuleSpec ist der einzige Weg zur RuleSpec
// ─────────────────────────────────────────────────────────────────────────────

describe("Compiler/Sanitize: der Pflichtschritt ist nicht umgehbar", () => {
  test("sanitizeRuleSpec() wird aufgerufen — Spy sieht die Rohform mit eingesetztem Symbol", () => {
    const calls: Array<RuleSpecInput | null | undefined> = [];
    const spy: typeof sanitizeRuleSpec = (rawInput, fallback, options) => {
      calls.push(rawInput);
      return sanitizeRuleSpec(rawInput, fallback, options);
    };

    const result = compileFixture(undefined, { sanitizeRuleSpec: spy });

    // Beweisziel: Ohne Sanitize-Aufruf bleibt `calls` leer und dieser Test
    // schlägt fehl — es gibt keinen zweiten Konstruktionsweg zur RuleSpec.
    assert.equal(calls.length, 1, "genau ein Sanitize-Aufruf pro Kompiliervorgang");
    const seen = calls[0];
    assert.ok(seen, "die Rohform wird an sanitizeRuleSpec übergeben");
    assert.deepEqual(conditionFields(seen), ["adx14", "volumeRatio"]);
    assert.equal(seen.symbol, "BTC/USDT", "Symbol kommt vom Aufrufer");

    assert.equal(result.ok, true, result.ok ? "" : result.errors.join(" | "));
    if (result.ok) {
      assert.equal(result.spec.action.stopLossPct, 4);
      assert.equal(result.strategyClass, "trend");
    }
  });

  test("das Sanitize-Ergebnis wird unverändert zurückgegeben (Sentinel-Identität)", () => {
    const first = compileFixture();
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const sentinel: RuleSpec = Object.freeze({ ...first.spec }) as RuleSpec;

    const result = compileFixture(undefined, {
      sanitizeRuleSpec: () => ({ ok: true, spec: sentinel }),
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.spec, sentinel, "der Compiler baut keine eigene RuleSpec daneben");
    }
  });

  test("Sanitize-Fehler ⇒ {ok:false} mit den Sanitize-Fehlerstrings — kein Rückfall auf die Rohform", () => {
    const result = compileFixture(undefined, {
      sanitizeRuleSpec: () => ({ ok: false, errors: ["sentinel: Sanitize verweigert"] }),
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.errors, ["sentinel: Sanitize verweigert"]);
      assert.ok(result.errors.every((error) => typeof error === "string"));
    }
    assert.equal("spec" in result, false);
    assert.equal("fingerprint" in result, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Klemmung wird sichtbar gemacht
// ─────────────────────────────────────────────────────────────────────────────

describe("Compiler/Klemmung: kein stiller Erfolg", () => {
  test("stopLossPct: 999 landet auf dem Ceiling — `clamped` nennt Feld, Roh- und Klemmwert", () => {
    // RuleSpecInput ist Record<string, unknown>: Der Builder DARF das liefern —
    // verhindern kann es nur der Sanitizer (STX-05).
    const result = compileFixture((rule) => mutateAction(rule, { stopLossPct: 999 }));

    assert.equal(result.ok, true, result.ok ? "" : result.errors.join(" | "));
    if (!result.ok) return;
    const ceiling = Number(RULE_CEILINGS.stopLossPct[1].toFixed(2));
    assert.equal(result.spec.action.stopLossPct, ceiling, "der Wert liegt auf dem Ceiling");
    assert.equal(result.clamped.length, 1);
    assert.match(result.clamped[0], /action\.stopLossPct: 999 → 20/);
  });

  test("auch mehrere Klemmungen werden einzeln ausgewiesen (window + action)", () => {
    const result = compileFixture((rule) =>
      mutateAction(rule, { takeProfitRR: 99, maxPositionPct: 0.9 })
    );

    assert.equal(result.ok, true, result.ok ? "" : result.errors.join(" | "));
    if (!result.ok) return;
    assert.equal(result.spec.action.takeProfitRR, RULE_CEILINGS.takeProfitRR[1]);
    assert.equal(result.spec.action.maxPositionPct, RULE_CEILINGS.maxPositionPct[1]);
    assert.equal(result.clamped.length, 2);
    assert.ok(result.clamped.some((entry) => entry.startsWith("action.takeProfitRR: 99 →")));
    assert.ok(result.clamped.some((entry) => entry.startsWith("action.maxPositionPct: 0.9 →")));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) Whitelist, Operatoren, Side
// ─────────────────────────────────────────────────────────────────────────────

describe("Compiler: der Sanitizer lässt nichts durch", () => {
  test("unbekanntes Feld „oracle“ ⇒ {ok:false} — die sonst gültige Regel wird nicht durchgelassen", () => {
    const result = compileFixture((rule) =>
      mutateConditions(rule, (items) => {
        items.push({ field: "oracle", op: "gte", value: 1 });
      })
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.errors.some((error) => /oracle|unbekanntes Feld/i.test(error)),
        `Fehler nennt das Feld nicht: ${result.errors.join(" | ")}`
      );
    }
  });

  test("fremder Operator „exec“ ⇒ {ok:false}", () => {
    const result = compileFixture((rule) =>
      mutateConditions(rule, (items) => {
        items.push({ field: "adx14", op: "exec", value: 10 });
      })
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.errors.some((error) => /exec|Operator/i.test(error)),
        `Fehler nennt den Operator nicht: ${result.errors.join(" | ")}`
      );
    }
  });

  test("action.side „SHORT“ ⇒ {ok:false} (Shorts sind im Code gesperrt)", () => {
    const result = compileFixture((rule) => mutateAction(rule, { side: "SHORT" }));

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.errors.some((error) => /SHORT|LONG/i.test(error)),
        `Fehler nennt die Seite nicht: ${result.errors.join(" | ")}`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) Pflichtfelder
// ─────────────────────────────────────────────────────────────────────────────

describe("Compiler/Pflichtfelder: der Builder darf sich nicht selbst beschneiden", () => {
  test("intaktes Fixture kompiliert — der entfernte adx14-Fall ist kein Selbstgänger", () => {
    const result = compileFixture();
    assert.equal(result.ok, true, result.ok ? "" : result.errors.join(" | "));
  });

  test("adx14 aus der condition entfernt ⇒ {ok:false} mit requiredFields-Fehler", () => {
    const result = compileFixture((rule) =>
      mutateConditions(rule, (items) => {
        const kept = items.filter((item) => item.field !== "adx14");
        items.length = 0;
        items.push(...kept);
      })
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.errors.some((error) => /requiredFields/.test(error) && /adx14/.test(error)),
        `Fehler nennt requiredFields/adx14 nicht: ${result.errors.join(" | ")}`
      );
    }
    assert.equal("spec" in result, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) Fingerprint
// ─────────────────────────────────────────────────────────────────────────────

describe("Compiler/Fingerprint: stabil über Prozessgrenzen, empfindlich auf Inhalt", () => {
  const emaInput: CompileTemplateInput = {
    templateId: "ema-adx-trend",
    symbol: "BTC/USDT",
    timeframe: "1h",
  };
  const paramsA = {
    adxMin: 25,
    ema50BufferPct: 0.3,
    volumeRatioMin: 1.2,
    stopLossPct: 5,
    takeProfitRR: 2,
  } as const;

  test("gleiche Eingabe ⇒ gleicher Fingerprint (auch bei vertauschter Parameter-Reihenfolge)", () => {
    const first = compileTemplate({ ...emaInput, params: paramsA });
    const second = compileTemplate({ ...emaInput, params: paramsA });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;

    assert.equal(first.fingerprint, second.fingerprint);
    assert.match(first.fingerprint, /^stc1:[0-9a-f]{64}$/);

    const reordered = compileTemplate({
      ...emaInput,
      params: {
        takeProfitRR: paramsA.takeProfitRR,
        stopLossPct: paramsA.stopLossPct,
        volumeRatioMin: paramsA.volumeRatioMin,
        ema50BufferPct: paramsA.ema50BufferPct,
        adxMin: paramsA.adxMin,
      },
    });
    assert.equal(reordered.ok, true);
    if (reordered.ok) {
      assert.equal(reordered.fingerprint, first.fingerprint, "kanonische Key-Reihenfolge");
    }
  });

  test("Default-codeVersion ist APP_VERSION; eine andere Version ⇒ anderer Fingerprint", () => {
    const withDefault = compileTemplate(emaInput);
    const explicit = compileTemplate({ ...emaInput, codeVersion: APP_VERSION });
    const other = compileTemplate({ ...emaInput, codeVersion: `${APP_VERSION}-andere` });
    assert.equal(withDefault.ok, true);
    assert.equal(explicit.ok, true);
    assert.equal(other.ok, true);
    if (!withDefault.ok || !explicit.ok || !other.ok) return;

    assert.equal(withDefault.fingerprint, explicit.fingerprint);
    assert.notEqual(withDefault.fingerprint, other.fingerprint);
  });

  test("anderes Symbol/anderer Takt ⇒ anderer Fingerprint; strategyFingerprint ist rein", () => {
    const base = compileTemplate(emaInput);
    const otherSymbol = compileTemplate({ ...emaInput, symbol: "ETH/USDT" });
    const otherTf = compileTemplate({ ...emaInput, timeframe: "4h" });
    assert.equal(base.ok, true);
    assert.equal(otherSymbol.ok, true);
    assert.equal(otherTf.ok, true);
    if (!base.ok || !otherSymbol.ok || !otherTf.ok) return;

    assert.notEqual(base.fingerprint, otherSymbol.fingerprint);
    assert.notEqual(base.fingerprint, otherTf.fingerprint);

    const direct = strategyFingerprint({
      templateId: "ema-adx-trend",
      version: 1,
      params: { b: 2, a: 1 },
      timeframe: "1h",
      symbol: "BTC/USDT",
      codeVersion: "x",
    });
    const reordered = strategyFingerprint({
      templateId: "ema-adx-trend",
      version: 1,
      params: { a: 1, b: 2 },
      timeframe: "1h",
      symbol: "BTC/USDT",
      codeVersion: "x",
    });
    assert.equal(direct, reordered);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) ROLLOUT — alle sechs Templates durch den Sicherheitspfad
// ─────────────────────────────────────────────────────────────────────────────

describe("Compiler/Rollout: sechs Templates, keine Klemmung, keine Umgehung", () => {
  test("exportTemplates() ⇒ 6 Templates über alle Takte, alle ok:true, alle ohne clamped", () => {
    const entries = exportTemplates();

    const ids = new Set(entries.map((entry) => entry.templateId));
    assert.equal(ids.size, 6, "genau sechs Artefakte");
    assert.deepEqual(
      [...ids].sort(),
      [...STRATEGY_TEMPLATES.map((template) => template.id)].sort(),
      "der Export deckt genau den Katalog"
    );

    for (const entry of entries) {
      assert.equal(
        entry.result.ok,
        true,
        `${entry.templateId}/${entry.timeframe}: ${entry.result.ok ? "" : entry.result.errors.join(" | ")}`
      );
      if (!entry.result.ok) continue;
      assert.deepEqual(entry.result.clamped, [], `${entry.templateId}/${entry.timeframe} klemmt`);
      assert.equal(entry.result.spec.symbol, EXPORT_PROBE_SYMBOL);
      assert.equal(entry.result.spec.window.timeframe, entry.timeframe, "Aufrufer-Takt erreicht den Spec");
      assert.match(entry.result.fingerprint, /^stc1:[0-9a-f]{64}$/);
    }
  });

  test("ADR-008: strategyClass === template.class, gültige Klasse, Regime-Gate für alle fünf Regimes", () => {
    const regimes = Object.keys(MARKET_REGIME_SEVERITY) as MarketRegime[];
    assert.equal(regimes.length, 5);

    for (const template of STRATEGY_TEMPLATES) {
      for (const timeframe of template.supportedTimeframes) {
        const result = compileTemplate({
          templateId: template.id,
          symbol: EXPORT_PROBE_SYMBOL,
          timeframe,
        });
        assert.equal(result.ok, true, `${template.id}/${timeframe}`);
        if (!result.ok) continue;

        assert.equal(result.strategyClass, template.class, "genau eine Klassenquelle (ADR-008)");
        assert.ok(STRATEGY_CLASS_KEYS.includes(result.strategyClass));
        assert.notEqual(result.strategyClass, "unclassified");

        const strategyClass = result.strategyClass === "unclassified" ? null : result.strategyClass;
        assert.ok(strategyClass, "Katalog-Templates tragen nie unclassified");
        assert.ok(DEFAULT_CLASS_POLICIES[result.strategyClass], "Decay-Policy existiert");
        for (const regime of regimes) {
          const factor = regimeGateFactor(regime, strategyClass);
          assert.ok(
            Number.isFinite(factor) && factor > 0 && factor <= 1,
            `${template.id}: regimeGateFactor(${regime}, ${result.strategyClass}) = ${factor}`
          );
        }
      }
    }
  });

  test("Laufzeit-Limits sind Warnungen (dynamische Marktlage) — nie stille Compile-Fehler", () => {
    const limits = getLimits();
    const entries = exportTemplates();

    for (const entry of entries) {
      if (!entry.result.ok) continue;
      const { spec, warnings } = entry.result;
      const overLimit =
        spec.action.riskBudgetPct > limits.maxRiskPerTrade ||
        spec.action.maxPositionPct > limits.maxPositionPct ||
        spec.action.takeProfitRR > limits.takeProfitRR;
      assert.equal(
        warnings.length > 0,
        overLimit,
        `${entry.templateId}: Warnungen ${JSON.stringify(warnings)} passen nicht zu den Laufzeit-Limits`
      );
    }
  });

  test("exportTemplates() läuft ohne DB/Netz: synchron, wiederholbar, identische Fingerprints", () => {
    const first = exportTemplates();
    const second = exportTemplates();
    assert.equal(first.length, second.length);
    for (let i = 0; i < first.length; i++) {
      const a = first[i].result;
      const b = second[i].result;
      assert.equal(first[i].templateId, second[i].templateId);
      assert.equal(first[i].timeframe, second[i].timeframe);
      assert.equal(a.ok, b.ok);
      if (a.ok && b.ok) {
        assert.equal(a.fingerprint, b.fingerprint);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) Fehlerfälle sind Fehlerstrings — nie Würfe
// ─────────────────────────────────────────────────────────────────────────────

describe("Compiler/Eingabefehler: {ok:false} mit Strings statt Exception", () => {
  test("unbekanntes Template ⇒ Fehler, kein stiller Default", () => {
    const result = compileTemplate({
      templateId: "gibt-es-nicht",
      symbol: "BTC/USDT",
      timeframe: "1h",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.length > 0);
  });

  test("„unclassified“ wird zur Laufzeit abgelehnt (ADR-008)", () => {
    const template = { ...fixtureTemplate(), class: "unclassified" as const };
    const result = compileTemplate(
      FIXTURE_INPUT,
      depsFor(undefined, { resolveTemplate: () => template })
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((error) => /unclassified/.test(error)));
    }
  });

  test("nicht unterstützter Timeframe ⇒ Fehler", () => {
    const result = compileFixture(undefined, undefined, { timeframe: "5m" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((error) => /Timeframe/.test(error)));
    }
  });

  test("unbekannter Parameter-Key und Wert außerhalb des Rasters ⇒ Fehler", () => {
    const unknownKey = compileFixture(undefined, undefined, {
      params: { adxMin: 20, erfunden: 1 },
    });
    assert.equal(unknownKey.ok, false);
    if (!unknownKey.ok) {
      assert.ok(unknownKey.errors.some((error) => /erfunden/.test(error)));
    }

    const outOfRange = compileFixture(undefined, undefined, { params: { adxMin: 999 } });
    assert.equal(outOfRange.ok, false);
    if (!outOfRange.ok) {
      assert.ok(outOfRange.errors.some((error) => /adxMin/.test(error)));
    }
  });

  test("fehlende Parameter werden durch Defaults ersetzt (kein Fehler)", () => {
    const result = compileFixture(undefined, undefined, { params: { adxMin: 33 } });
    assert.equal(result.ok, true);
    if (result.ok) {
      const adx = result.spec.condition.conditions.find((item) => item.field === "adx14");
      assert.ok(adx);
      assert.equal(adx.value, 33, "expliziter Wert gewinnt");
      assert.equal(result.spec.condition.conditions.length, 2, "volumeRatio kommt als Default");
    }
  });

  test("werfender oder nicht-objektliefernder Builder ⇒ {ok:false}, kein Wurf", () => {
    assert.doesNotThrow(() => {
      const throwing = compileFixture((rule) => {
        void rule;
        throw new Error("Fixture-Builder absichtlich kaputt");
      });
      assert.equal(throwing.ok, false);
      if (!throwing.ok) {
        assert.ok(throwing.errors.some((error) => /Fixture-Builder absichtlich kaputt/.test(error)));
      }

      const nonObject: StrategyTemplate = {
        ...fixtureTemplate(),
        buildRule: () => null as unknown as RuleSpecInput,
      };
      const result = compileTemplate(
        FIXTURE_INPUT,
        depsFor(undefined, { resolveTemplate: () => nonObject })
      );
      assert.equal(result.ok, false);
    });
  });

  test("ungültiges Symbol ⇒ Fehler aus dem Sanitizer, kein Wurf", () => {
    const result = compileFixture(undefined, undefined, { symbol: "" });
    assert.equal(result.ok, false);
  });

  test("verlangt das Artefakt CEO, bleibt CEO; MANUAL wird zu RESEARCH erzwungen", () => {
    const ceo = compileFixture((rule) => {
      rule.sourceRole = "CEO";
    });
    assert.equal(ceo.ok, true);
    if (ceo.ok) assert.equal(ceo.spec.sourceRole, "CEO");

    const manual = compileFixture((rule) => {
      rule.sourceRole = "MANUAL";
    });
    assert.equal(manual.ok, true);
    if (manual.ok) assert.equal(manual.spec.sourceRole, "RESEARCH");

    const byDefault = compileTemplate({
      templateId: "ema-adx-trend",
      symbol: "BTC/USDT",
      timeframe: "1h",
    });
    assert.equal(byDefault.ok, true);
    if (byDefault.ok) assert.equal(byDefault.spec.sourceRole, "RESEARCH");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8) Katalog-Anbindung (Sanity der Beweisführung selbst)
// ─────────────────────────────────────────────────────────────────────────────

describe("Compiler: Beweisführung ist an den echten Katalog gebunden", () => {
  test("die sechs Templates stammen aus getTemplate()", () => {
    for (const template of STRATEGY_TEMPLATES) {
      assert.equal(getTemplate(template.id as Parameters<typeof getTemplate>[0])?.id, template.id);
    }
  });
});
