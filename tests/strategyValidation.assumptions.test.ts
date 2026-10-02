/**
 * STX-06-01 — Annahmen-Audit: Vertrags- und Pfadtests (Phase 6).
 *
 * Diese Suite ist die Abnahme des deterministischen Annahmen-Audits. Sie prüft
 * drei Dinge, die der Prompt STX-06-01 als Akzeptanzkriterien nennt:
 *
 *  1. **Pfade:** Jede der elf Prüfungen hat einen belegten `VIOLATED`-Pfad
 *     (zehn Pflichtprüfungen + `FILLS_MODELLED`), mehrere `UNKNOWN`-Pfade und
 *     mindestens einen vollständigen `HOLDS`-Lauf.
 *  2. **Die `UNKNOWN`-Regel:** `TRADES_SUFFICIENT` liefert unter
 *     `MC_MIN_SAMPLE_TRADES` `UNKNOWN` und **niemals** `VIOLATED` — zu wenig
 *     Stichprobe ist kein Gegenbeweis.
 *  3. **Die `critical`-Regel:** Eine kritische Template-Annahme mit
 *     `VIOLATED` **oder** `UNKNOWN` zieht den Gesamtstatus auf `INCONCLUSIVE`,
 *     nicht auf `FAIL`.
 *
 * Dazu kommen die strukturellen Zusagen: feste Prüf-Reihenfolge, `evidence`
 * immer mit Zahl, Determinismus (zwei Aufrufe ⇒ identische Ausgabe), keine
 * Mutation der Eingabe und — als statischer Wächter — keine IO/Uhr/DB im
 * Modulquelltext.
 *
 * Keine DB, kein Netz, keine Zeitabhängigkeit: Alle Fakten sind injizierte
 * Fixtures (Muster `tests/strategies.templates.test.ts`). Die Regeln entstehen
 * über den echten Compiler (03-09) bzw. `sanitizeRuleSpec()` — der Audit wird
 * also gegen dieselben Artefakte geprüft, die auch produktiv entstehen.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ASSUMPTION_CHECK_IDS,
  ASSUMPTION_CHECK_SEVERITY,
  DEFAULT_ASSUMPTION_THRESHOLDS,
  auditAssumptions,
  assumptionGate,
} from "../src/strategies/validator/assumptions";
import type {
  AssumptionCheck,
  AssumptionCheckId,
  AuditInput,
  CandleFacts,
  RunConfigFacts,
  SnapshotFacts,
} from "../src/strategies/validator/assumptions";
import { getTemplate } from "../src/strategies/catalog";
import { compileTemplate } from "../src/strategies/compiler";
import type { StrategyAssumption, StrategyTemplate } from "../src/strategies/types";
import { sanitizeRuleSpec } from "../src/lib/ruleEngine";
import type { RuleField, RuleSpec } from "../src/lib/ruleEngine";
import type { SupportedTimeframe } from "../src/lib/marketdata/historicalStore";
import { MC_MIN_SAMPLE_TRADES } from "../src/backtest/montecarlo";
import {
  RULE_BACKTEST_EQUITY_CAP,
  RULE_BACKTEST_TRADE_CAP,
} from "../src/lib/ruleBacktest";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `n` Snapshots mit durchgehend gemessenem Spread und tragender Tiefe.
 * `nullSpreadAt`/`nullDepthAt` markieren einzelne Positionen als nicht
 * gemessen — so entsteht der Anteil, an dem die Prüfungen entscheiden.
 */
function snapshots(
  n: number,
  opts: { nullSpreadAt?: number[]; nullDepthAt?: number[]; depthUsd?: number } = {},
): SnapshotFacts[] {
  const nullSpread = new Set(opts.nullSpreadAt ?? []);
  const nullDepth = new Set(opts.nullDepthAt ?? []);
  return Array.from({ length: n }, (_, i) => ({
    spreadPct: nullSpread.has(i) ? null : 0.04,
    bookDepthUsd: nullDepth.has(i) ? null : (opts.depthUsd ?? 50_000),
  }));
}

/** Sanierte Regel über den legalen Pfad (`sanitizeRuleSpec`, STX-05). */
function specOf(
  fields: readonly RuleField[],
  timeframe: SupportedTimeframe = "15m",
): RuleSpec {
  const result = sanitizeRuleSpec(
    {
      name: "audit-fixture",
      symbol: "BTC/USDT",
      missionId: null,
      condition: {
        logic: "all",
        conditions: fields.map((field) => ({ field, op: "gte", value: 0 })),
      },
      action: {
        side: "LONG",
        stopLossPct: 3,
        takeProfitRR: 2,
        riskBudgetPct: 0.01,
        maxPositionPct: 0.25,
        positionSizeMode: "risk",
      },
      window: {
        timeframe,
        validFrom: null,
        validUntil: null,
        maxExecutionsPerDay: 3,
        cooldownMinutes: 60,
        volumeWindow: 20,
      },
      rationale: "Fixture für den Annahmen-Audit.",
      sourceRole: "RESEARCH",
      riskScore: 0.5,
    },
    "RESEARCH",
  );
  assert.equal(result.ok, true, `sanitizeRuleSpec: ${JSON.stringify(result)}`);
  return result.spec;
}

/** Kontrollierbares Template-Fixture (kein Katalogeintrag, keine Registry). */
function fixtureTemplate(
  assumptions: readonly StrategyAssumption[],
  requiredFields: readonly RuleField[] = ["rsi14", "atrPct"],
): StrategyTemplate {
  return {
    id: "audit-fixture-template",
    name: "Audit-Fixture",
    description: "Template-Fixture ausschließlich für die Audit-Tests.",
    version: 1,
    class: "trend",
    scope: "SINGLE_SYMBOL",
    supportedTimeframes: ["15m"],
    requiredFields,
    params: {},
    buildRule: () => ({ name: "audit-fixture" }),
    assumptions,
    expectedRegimes: ["TREND_UP"],
  };
}

/** Katalog-Template mit Nachweis — `null` wäre ein kaputter Katalog. */
function requireTemplate(id: Parameters<typeof getTemplate>[0]): StrategyTemplate {
  const template = getTemplate(id);
  assert.ok(template, `${id} muss im Katalog registriert sein`);
  return template;
}

const VWAP_TEMPLATE = requireTemplate("vwap-pullback");

/** Regel des echten VWAP-Templates über den Compiler (03-09). */
function vwapSpec(timeframe: SupportedTimeframe = "15m"): RuleSpec {
  const compiled = compileTemplate({
    templateId: "vwap-pullback",
    symbol: "BTC/USDT",
    timeframe,
  });
  assert.equal(compiled.ok, true, `compileTemplate: ${JSON.stringify(compiled)}`);
  return compiled.spec;
}

/**
 * Sauberer Lauf: Jede der elf Prüfungen hält. `overrides` ersetzt die
 * Teilobjekte shallow, damit jeder Test genau **eine** Annahme bricht.
 */
function cleanInput(overrides: {
  template?: StrategyTemplate;
  version?: RuleSpec;
  run?: Partial<AuditInput["run"]>;
  candles?: CandleFacts | null;
  config?: Partial<RunConfigFacts>;
} = {}): AuditInput {
  return {
    template: overrides.template ?? VWAP_TEMPLATE,
    version: overrides.version ?? vwapSpec("15m"),
    run: {
      trades: 42,
      equityPoints: 100,
      feesPaid: 12.5,
      slippagePaid: 8.25,
      fundingPaid: 0,
      outOfSample: false,
      walkForwardWindows: 0,
      ...overrides.run,
    },
    candles:
      overrides.candles === undefined
        ? {
            bars: 500,
            requiredWarmupCandles: 61,
            snapshots: snapshots(20),
          }
        : overrides.candles,
    config: {
      executionModel: "paper",
      timeframe: "15m",
      slippageModel: "fixed",
      fixedSlippageBps: 5,
      spreadSlippageFactor: 0.5,
      feeModel: { makerFee: 0.0002, takerFee: 0.0006 },
      initialCapital: 10_000,
      ...overrides.config,
    },
  };
}

function checkOf(audit: ReturnType<typeof auditAssumptions>, id: AssumptionCheckId): AssumptionCheck {
  const found = audit.checks.find((check) => check.assumptionId === id);
  assert.ok(found, `Prüfung ${id} fehlt im Ergebnis`);
  return found;
}

/** Prompt-Pflichtprüfungen (die zehn aus STX-06-01, ohne die Ergänzung). */
const PROMPT_CHECKS: readonly AssumptionCheckId[] = [
  "FEE_NONZERO",
  "SLIPPAGE_NONZERO",
  "SPREAD_MEASURED",
  "DEPTH_SUFFICIENT",
  "WARMUP_MET",
  "TRADES_SUFFICIENT",
  "CAPS_RESPECTED",
  "LEAKAGE_PROTECTED",
  "INTRADAY_ONLY",
  "CHANGE_PCT_SEMANTICS",
];

// ─────────────────────────────────────────────────────────────────────────────
// 1) Grundlinie: HOLDS
// ─────────────────────────────────────────────────────────────────────────────

describe("Annahmen-Audit — HOLDS-Grundlinie", () => {
  test("1 HOLDS-Pfad: sauberer Lauf hält alle 11 Prüfungen ⇒ PASS", () => {
    const audit = auditAssumptions(cleanInput());

    assert.equal(audit.checks.length, ASSUMPTION_CHECK_IDS.length);
    assert.equal(audit.violated.length, 0);
    assert.equal(audit.unknown.length, 0);
    assert.equal(audit.blocking.length, 0);
    assert.equal(audit.criticalFindings.length, 0);
    assert.equal(audit.uncoveredCritical.length, 0);
    assert.equal(audit.verdict, "PASS");
    assert.ok(
      audit.checks.every((check) => check.status === "HOLDS"),
      `nicht alle Prüfungen HOLDS: ${JSON.stringify(audit.checks.filter((c) => c.status !== "HOLDS"))}`,
    );
    assert.equal(assumptionGate(audit).allow, true);
  });

  test("Reihenfolge ist fix: erste zehn = Prompt, danach die Ergänzung", () => {
    const audit = auditAssumptions(cleanInput());
    const ids = audit.checks.map((check) => check.assumptionId);

    assert.deepEqual(ids, [...ASSUMPTION_CHECK_IDS]);
    assert.deepEqual(ids.slice(0, 10), [...PROMPT_CHECKS]);
    assert.equal(ids[10], "FILLS_MODELLED");
    // Jede Pflichtprüfung hat eine Regelschwere und Kategorien.
    for (const id of ASSUMPTION_CHECK_IDS) {
      assert.match(ASSUMPTION_CHECK_SEVERITY[id], /^(BLOCKING|WARNING)$/);
    }
  });

  test("evidence enthält immer mindestens eine Zahl — in jedem Pfad", () => {
    const inputs: AuditInput[] = [
      cleanInput(),
      cleanInput({ config: { feeModel: { makerFee: 0, takerFee: 0 } } }),
      cleanInput({ run: { trades: 7 } }),
      cleanInput({ candles: null }),
      cleanInput({ candles: { bars: null, snapshots: [] } }),
      cleanInput({ config: { slippageModel: undefined, feeModel: null } }),
      cleanInput({ run: { trades: null, equityPoints: null } }),
      // 4h ist für vwap-pullback nicht kompilierbar (supportedTimeframes),
      // deshalb hier die sanierte Rohregel mit vwapPct auf 4h.
      cleanInput({ version: specOf(["vwapPct"], "4h"), config: { timeframe: "4h" } }),
      cleanInput({ template: fixtureTemplate([], ["changePct24h"]) }),
    ];
    for (const input of inputs) {
      const audit = auditAssumptions(input);
      for (const check of audit.checks) {
        assert.match(
          check.evidence,
          /\d/,
          `${check.assumptionId}: Evidenz ohne Zahl: „${check.evidence}"`,
        );
        assert.ok(check.evidence.length > 20, `${check.assumptionId}: Evidenz zu kurz`);
      }
      assert.match(audit.summary, /\d/);
      assert.match(assumptionGate(audit).reason, /\d/);
    }
  });

  test("deterministisch und eingabe-treu: zwei Aufrufe identisch, Eingabe unverändert", () => {
    const input = cleanInput({ run: { trades: 12 } });
    const before = JSON.stringify(input);

    const first = auditAssumptions(input);
    const second = auditAssumptions(input);

    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(input), before, "auditAssumptions darf die Eingabe nicht mutieren");
  });

  test("Modulquelltext ist IO-frei: keine Uhr, kein Zufall, keine DB, kein fs", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/strategies/validator/assumptions.ts"),
      "utf8",
    );
    for (const forbidden of [
      "Date.now(",
      "new Date(",
      "Math.random(",
      "process.env",
      "node:fs",
      "node:net",
      "node:http",
      "from \"pg\"",
      "@/db",
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `Annahmen-Audit enthält verbotene IO-Referenz „${forbidden}"`,
      );
    }
    // Die einzigen Wert-Importe sind die drei Konstanten-SSoT.
    const valueImports = [...source.matchAll(/^import\s+\{[^}]*\}\s+from\s+"([^"]+)";$/gm)].map(
      (match) => match[1],
    );
    assert.deepEqual(valueImports.sort(), [
      "@/backtest/montecarlo",
      "@/lib/marketdata/timeframes",
      "@/lib/ruleBacktest",
      "@/lib/ruleFieldCatalog",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) VIOLATED-Pfade (zehn Pflichtprüfungen + Ergänzung)
// ─────────────────────────────────────────────────────────────────────────────

describe("Annahmen-Audit — VIOLATED-Pfade", () => {
  test("1) FEE_NONZERO: makerFee = 0 und takerFee = 0 ⇒ VIOLATED + INCONCLUSIVE", () => {
    const audit = auditAssumptions(
      cleanInput({ config: { feeModel: { makerFee: 0, takerFee: 0 } } }),
    );
    const check = checkOf(audit, "FEE_NONZERO");

    assert.equal(check.status, "VIOLATED");
    assert.equal(check.severity, "BLOCKING");
    assert.match(check.evidence, /0 bp/);
    // vwap-pullback deklariert „intraday-kosten" als kritische COST-Annahme.
    assert.ok(check.templateAssumptions.includes("intraday-kosten"));
    assert.ok(audit.criticalFindings.includes("intraday-kosten"));
    assert.equal(audit.verdict, "INCONCLUSIVE");
    assert.equal(assumptionGate(audit).allow, false);
  });

  test("2) FEE_NONZERO: negative Gebühren sind kein Rabatt, sondern VIOLATED", () => {
    const audit = auditAssumptions(
      cleanInput({ config: { feeModel: { makerFee: -0.0001, takerFee: -0.0002 } } }),
    );
    assert.equal(checkOf(audit, "FEE_NONZERO").status, "VIOLATED");
  });

  test("3) SLIPPAGE_NONZERO: slippageModel = \"none\" ⇒ VIOLATED", () => {
    const audit = auditAssumptions(cleanInput({ config: { slippageModel: "none" } }));
    const check = checkOf(audit, "SLIPPAGE_NONZERO");

    assert.equal(check.status, "VIOLATED");
    assert.match(check.evidence, /"none"/);
    assert.equal(audit.verdict, "INCONCLUSIVE");
  });

  test("4) SLIPPAGE_NONZERO: Modell fixed mit 0 bp ist ebenfalls VIOLATED", () => {
    const audit = auditAssumptions(
      cleanInput({ config: { slippageModel: "fixed", fixedSlippageBps: 0 } }),
    );
    assert.equal(checkOf(audit, "SLIPPAGE_NONZERO").status, "VIOLATED");
  });

  test("5) SPREAD_MEASURED: 60 % der Snapshots ohne spreadPct ⇒ VIOLATED", () => {
    const audit = auditAssumptions(
      cleanInput({
        candles: {
          bars: 500,
          requiredWarmupCandles: 61,
          snapshots: snapshots(20, { nullSpreadAt: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }),
        },
      }),
    );
    const check = checkOf(audit, "SPREAD_MEASURED");

    assert.equal(check.status, "VIOLATED");
    assert.match(check.evidence, /12 von 20/);
    assert.match(check.evidence, /60 %/);
  });

  test("6) SPREAD_MEASURED: leere Snapshot-Reihe = nie gemessen ⇒ VIOLATED", () => {
    const audit = auditAssumptions(
      cleanInput({ candles: { bars: 500, requiredWarmupCandles: 61, snapshots: [] } }),
    );
    const check = checkOf(audit, "SPREAD_MEASURED");

    assert.equal(check.status, "VIOLATED");
    assert.match(check.evidence, /0 Snapshots/);
    assert.equal(checkOf(audit, "DEPTH_SUFFICIENT").status, "VIOLATED");
  });

  test("7) DEPTH_SUFFICIENT: fehlende Tiefe in ≥ 20 % der Snapshots ⇒ VIOLATED", () => {
    const audit = auditAssumptions(
      cleanInput({
        candles: {
          bars: 500,
          requiredWarmupCandles: 61,
          snapshots: snapshots(20, { nullDepthAt: [0, 1, 2, 3] }),
        },
      }),
    );
    const check = checkOf(audit, "DEPTH_SUFFICIENT");

    assert.equal(check.status, "VIOLATED");
    assert.equal(check.severity, "WARNING");
    assert.match(check.evidence, /4 von 20/);
  });

  test("8) DEPTH_SUFFICIENT: Buch trägt die Position nicht ⇒ VIOLATED", () => {
    // Positionsnotional = 10 000 × maxPositionPct 0.15 = 1 500 USD.
    const audit = auditAssumptions(
      cleanInput({
        candles: {
          bars: 500,
          requiredWarmupCandles: 61,
          snapshots: snapshots(20, { depthUsd: 900 }),
        },
      }),
    );
    const check = checkOf(audit, "DEPTH_SUFFICIENT");

    assert.equal(check.status, "VIOLATED");
    assert.match(check.evidence, /1500 USD/);
    assert.match(check.evidence, /20 von 20 gemessenen Tiefen/);
  });

  test("9) WARMUP_MET: 30 Kerzen < Bedarf 61 ⇒ VIOLATED", () => {
    const audit = auditAssumptions(
      cleanInput({
        candles: { bars: 30, requiredWarmupCandles: 61, snapshots: snapshots(20) },
      }),
    );
    const check = checkOf(audit, "WARMUP_MET");

    assert.equal(check.status, "VIOLATED");
    assert.equal(check.severity, "BLOCKING");
    assert.match(check.evidence, /30 Kerzen < Bedarf 61 Kerzen/);
    assert.match(check.evidence, /31 Kerzen fehlen/);
  });

  test("10) CAPS_RESPECTED: 250 Trades über dem Deckel 200 ⇒ VIOLATED", () => {
    const audit = auditAssumptions(
      cleanInput({
        template: fixtureTemplate([
          { id: "markt-these", statement: "These", category: "MARKET", critical: true },
        ]),
        version: specOf(["rsi14"]),
        run: { trades: RULE_BACKTEST_TRADE_CAP + 50, equityPoints: 100 },
      }),
    );
    const check = checkOf(audit, "CAPS_RESPECTED");

    assert.equal(check.status, "VIOLATED");
    assert.match(check.evidence, /250 Trades \(Deckel 200\)/);
    assert.match(check.evidence, /trade_cap/);
    // Keine kritische DATA-Annahme ⇒ kein INCONCLUSIVE, sondern FAIL.
    assert.equal(audit.criticalFindings.length, 0);
    assert.equal(audit.verdict, "FAIL");
  });

  test("11) CAPS_RESPECTED: 130 Equity-Punkte über dem Deckel 120 ⇒ VIOLATED", () => {
    const audit = auditAssumptions(
      cleanInput({
        template: fixtureTemplate([
          { id: "markt-these", statement: "These", category: "MARKET", critical: true },
        ]),
        version: specOf(["rsi14"]),
        run: { trades: 42, equityPoints: RULE_BACKTEST_EQUITY_CAP + 10 },
      }),
    );
    const check = checkOf(audit, "CAPS_RESPECTED");

    assert.equal(check.status, "VIOLATED");
    assert.match(check.evidence, /equity_cap/);
  });

  test("12) LEAKAGE_PROTECTED: OOS ohne embargoMs/purgeMs ⇒ VIOLATED", () => {
    const audit = auditAssumptions(
      cleanInput({ run: { outOfSample: true, walkForwardWindows: 5 } }),
    );
    const check = checkOf(audit, "LEAKAGE_PROTECTED");

    assert.equal(check.status, "VIOLATED");
    assert.match(check.evidence, /5 OOS-Fenster ohne embargoMs und purgeMs/);
    assert.equal(audit.verdict, "INCONCLUSIVE");
  });

  test("13) LEAKAGE_PROTECTED: nur purgeMs fehlt ⇒ VIOLATED, Embargo belegt", () => {
    const audit = auditAssumptions(
      cleanInput({ run: { outOfSample: true, walkForwardWindows: 3, embargoMs: 3_600_000 } }),
    );
    const check = checkOf(audit, "LEAKAGE_PROTECTED");

    assert.equal(check.status, "VIOLATED");
    assert.match(check.evidence, /1 von 2 Leakage-Schutzparametern fehlen/);
  });

  test("14) INTRADAY_ONLY: vwapPct auf 4h ⇒ VIOLATED (BLOCKING)", () => {
    const audit = auditAssumptions(
      cleanInput({ version: vwapSpec("1h"), config: { timeframe: "4h" } }),
    );
    const check = checkOf(audit, "INTRADAY_ONLY");

    assert.equal(check.status, "VIOLATED");
    assert.equal(check.severity, "BLOCKING");
    assert.match(check.evidence, /14400000 ms/);
    assert.match(check.evidence, /Regel deklariert 1h, Lauf nutzt 4h/);
  });

  test("15) INTRADAY_ONLY: vwapPct auf 1h ⇒ VIOLATED, aber nur WARNING", () => {
    const audit = auditAssumptions(
      cleanInput({ version: vwapSpec("1h"), config: { timeframe: "1h" } }),
    );
    const check = checkOf(audit, "INTRADAY_ONLY");

    assert.equal(check.status, "VIOLATED");
    assert.equal(check.severity, "WARNING");
    assert.match(check.evidence, /3600000 ms/);
  });

  test("16) CHANGE_PCT_SEMANTICS: genutztes Feld ⇒ VIOLATED (WARNING, STX-14)", () => {
    const audit = auditAssumptions(
      cleanInput({
        template: fixtureTemplate([], ["changePct24h", "rsi14"]),
        version: specOf(["changePct24h"]),
      }),
    );
    const check = checkOf(audit, "CHANGE_PCT_SEMANTICS");

    assert.equal(check.status, "VIOLATED");
    assert.equal(check.severity, "WARNING");
    assert.match(check.evidence, /1 von 2 Pflichtfeldern/);
    assert.match(check.evidence, /1 von 1 Regelbedingungen/);
    assert.match(check.evidence, /97 Perioden/);
    // WARNING ohne kritische Annahme ⇒ kein FAIL.
    assert.equal(audit.verdict, "PASS");
  });

  test("17) FILLS_MODELLED: executionModel legacy (instant fills) ⇒ VIOLATED", () => {
    const audit = auditAssumptions(cleanInput({ config: { executionModel: "legacy" } }));
    const check = checkOf(audit, "FILLS_MODELLED");

    assert.equal(check.status, "VIOLATED");
    assert.match(check.evidence, /0 ms Latenz/);
    // vwap-pullback: „historischer-vwap-kein-fill" ist kritisch (EXECUTION).
    assert.ok(audit.criticalFindings.includes("historischer-vwap-kein-fill"));
    assert.equal(audit.verdict, "INCONCLUSIVE");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) UNKNOWN-Pfade
// ─────────────────────────────────────────────────────────────────────────────

describe("Annahmen-Audit — UNKNOWN-Pfade", () => {
  test("1) TRADES_SUFFICIENT: 7 Trades ⇒ UNKNOWN, niemals VIOLATED", () => {
    const audit = auditAssumptions(cleanInput({ run: { trades: 7 } }));
    const check = checkOf(audit, "TRADES_SUFFICIENT");

    assert.equal(check.status, "UNKNOWN");
    assert.notEqual(check.status, "VIOLATED");
    assert.equal(audit.violated.length, 0);
    assert.equal(audit.unknown.length, 1);
    assert.match(check.evidence, /7 Trades < Minimum 30 Trades/);
    assert.match(check.evidence, /23 fehlen/);
    assert.equal(MC_MIN_SAMPLE_TRADES, 30);
    // Nicht prüfbar ⇒ INCONCLUSIVE, kein FAIL.
    assert.equal(audit.verdict, "INCONCLUSIVE");
  });

  test("2) TRADES_SUFFICIENT: fehlende Trade-Zahl ⇒ UNKNOWN", () => {
    const audit = auditAssumptions(cleanInput({ run: { trades: null, equityPoints: null } }));

    assert.equal(checkOf(audit, "TRADES_SUFFICIENT").status, "UNKNOWN");
    assert.equal(checkOf(audit, "CAPS_RESPECTED").status, "UNKNOWN");
    assert.equal(audit.violated.length, 0);
    assert.equal(audit.verdict, "INCONCLUSIVE");
  });

  test("3) fehlende Snapshot-/Kerzenfakten ⇒ SPREAD, DEPTH und WARMUP UNKNOWN", () => {
    const audit = auditAssumptions(cleanInput({ candles: null }));

    assert.equal(checkOf(audit, "SPREAD_MEASURED").status, "UNKNOWN");
    assert.equal(checkOf(audit, "DEPTH_SUFFICIENT").status, "UNKNOWN");
    assert.equal(checkOf(audit, "WARMUP_MET").status, "UNKNOWN");
    assert.equal(audit.unknown.length, 3);
    assert.equal(audit.violated.length, 0);
  });

  test("4) fehlendes Gebührenmodell ⇒ FEE_NONZERO UNKNOWN + kritisch ⇒ INCONCLUSIVE", () => {
    const audit = auditAssumptions(cleanInput({ config: { feeModel: null } }));
    const check = checkOf(audit, "FEE_NONZERO");

    assert.equal(check.status, "UNKNOWN");
    assert.match(check.evidence, /0 von 2 Werten lesbar/);
    assert.ok(audit.criticalFindings.includes("intraday-kosten"));
    assert.equal(audit.verdict, "INCONCLUSIVE");
  });

  test("5) fehlendes Slippage-Modell und executionModel ⇒ UNKNOWN", () => {
    const audit = auditAssumptions(
      cleanInput({ config: { slippageModel: undefined, executionModel: undefined } }),
    );

    assert.equal(checkOf(audit, "SLIPPAGE_NONZERO").status, "UNKNOWN");
    assert.equal(checkOf(audit, "FILLS_MODELLED").status, "UNKNOWN");
    assert.equal(audit.unknown.length, 2);
  });

  test("6) Warmup: Bedarf fehlt ⇒ UNKNOWN statt erfundener Grenze", () => {
    const audit = auditAssumptions(
      cleanInput({
        candles: { bars: 12, requiredWarmupCandles: null, snapshots: snapshots(5) },
      }),
    );
    const check = checkOf(audit, "WARMUP_MET");

    assert.equal(check.status, "UNKNOWN");
    assert.match(check.evidence, /12 Kerzen/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) Verdict-, Mapping- und Schwellen-Regeln
// ─────────────────────────────────────────────────────────────────────────────

describe("Annahmen-Audit — Verdict- und Mapping-Regeln", () => {
  test("critical + VIOLATED ⇒ INCONCLUSIVE (nie FAIL)", () => {
    const template = fixtureTemplate([
      { id: "kosten", statement: "Gebühren bleiben", category: "COST", critical: true },
    ]);
    const audit = auditAssumptions(
      cleanInput({
        template,
        version: specOf(["rsi14"]),
        config: { feeModel: { makerFee: 0, takerFee: 0 }, slippageModel: "none" },
      }),
    );

    assert.equal(audit.violated.length, 2);
    assert.deepEqual(audit.criticalFindings, ["kosten"]);
    assert.equal(audit.verdict, "INCONCLUSIVE");
    assert.equal(assumptionGate(audit).allow, false);
  });

  test("critical + UNKNOWN ⇒ INCONCLUSIVE (ein nicht prüfbarer Lauf ist kein Beweis)", () => {
    const template = fixtureTemplate([
      { id: "daten", statement: "Keine Lücken", category: "DATA", critical: true },
    ]);
    const audit = auditAssumptions(
      cleanInput({ template, version: specOf(["rsi14"]), candles: null }),
    );

    assert.equal(audit.violated.length, 0);
    assert.ok(audit.unknown.length >= 3);
    assert.ok(audit.criticalFindings.includes("daten"));
    assert.equal(audit.verdict, "INCONCLUSIVE");
  });

  test("BLOCKING-VIOLATED ohne kritische Annahme ⇒ FAIL", () => {
    const template = fixtureTemplate([
      { id: "markt", statement: "These", category: "MARKET", critical: false },
    ]);
    const audit = auditAssumptions(
      cleanInput({
        template,
        version: specOf(["rsi14"]),
        candles: { bars: 10, requiredWarmupCandles: 61, snapshots: snapshots(5) },
      }),
    );

    assert.equal(checkOf(audit, "WARMUP_MET").status, "VIOLATED");
    assert.equal(audit.criticalFindings.length, 0);
    assert.equal(audit.verdict, "FAIL");
    assert.equal(assumptionGate(audit).allow, false);
  });

  test("WARNING-VIOLATED ohne kritische Annahme ⇒ PASS bleibt", () => {
    const audit = auditAssumptions(
      cleanInput({ template: fixtureTemplate([]), version: specOf(["changePct24h"]) }),
    );

    assert.equal(checkOf(audit, "CHANGE_PCT_SEMANTICS").status, "VIOLATED");
    assert.equal(audit.violated.length, 1);
    assert.equal(audit.verdict, "PASS");
    assert.equal(assumptionGate(audit).allow, true);
  });

  test("Kategorien ohne Prüfung (REGIME) landen in uncoveredCritical, nicht im Status", () => {
    const rsi = requireTemplate("rsi-mean-reversion");
    const audit = auditAssumptions(
      cleanInput({
        template: rsi,
        version: specOf(["rsi14"]),
        config: { timeframe: "15m" },
      }),
    );

    assert.ok(
      audit.uncoveredCritical.includes("regime-range"),
      `uncoveredCritical: ${JSON.stringify(audit.uncoveredCritical)}`,
    );
    assert.equal(audit.verdict, "PASS");
    assert.equal(audit.criticalFindings.length, 0);
  });

  test("templateAssumptions folgen dem Kategorien-Mapping", () => {
    const audit = auditAssumptions(cleanInput());
    const fee = checkOf(audit, "FEE_NONZERO");
    const depth = checkOf(audit, "DEPTH_SUFFICIENT");

    assert.deepEqual([...fee.templateAssumptions].sort(), ["intraday-kosten"]);
    // vwap-pullback deklariert keine LIQUIDITY-Annahme.
    assert.deepEqual(depth.templateAssumptions, []);
  });

  test("Schwellen-Override verschiebt die Entscheidung messbar", () => {
    const input = cleanInput({
      candles: {
        bars: 500,
        requiredWarmupCandles: 61,
        snapshots: snapshots(20, { nullSpreadAt: [0, 1, 2, 3, 4] }),
      },
    });

    assert.equal(checkOf(auditAssumptions(input), "SPREAD_MEASURED").status, "VIOLATED");
    assert.equal(DEFAULT_ASSUMPTION_THRESHOLDS.maxMissingSpreadPct, 20);

    const relaxed = auditAssumptions({
      ...input,
      config: { ...input.config, thresholds: { maxMissingSpreadPct: 80 } },
    });
    assert.equal(checkOf(relaxed, "SPREAD_MEASURED").status, "HOLDS");
    assert.match(checkOf(relaxed, "SPREAD_MEASURED").evidence, /Grenze 80 %/);
  });

  test("Schwellen außerhalb der Bounds werden abgewiesen (fail-closed)", () => {
    const input = cleanInput();
    assert.throws(
      () =>
        auditAssumptions({
          ...input,
          config: { ...input.config, thresholds: { maxMissingSpreadPct: 140 } },
        }),
      /maxMissingSpreadPct/,
    );
    assert.throws(
      () =>
        auditAssumptions({
          ...input,
          config: { ...input.config, thresholds: { minDepthToNotionalRatio: -1 } },
        }),
      /minDepthToNotionalRatio/,
    );
  });

  test("Fehlende Eingaben werden abgewiesen statt still bestanden", () => {
    assert.throws(
      () => auditAssumptions({} as unknown as AuditInput),
      /template\.assumptions/,
    );
    assert.throws(
      () => auditAssumptions({ template: fixtureTemplate([]) } as unknown as AuditInput),
      /version/,
    );
  });

  test("Gate: nur PASS gibt die Metrik-Auswertung frei", () => {
    const pass = auditAssumptions(cleanInput());
    const fail = auditAssumptions(
      cleanInput({
        template: fixtureTemplate([]),
        version: specOf(["rsi14"]),
        candles: { bars: 1, requiredWarmupCandles: 61, snapshots: snapshots(3) },
      }),
    );
    const inconclusive = auditAssumptions(cleanInput({ run: { trades: 3 } }));

    assert.equal(pass.verdict, "PASS");
    assert.equal(assumptionGate(pass).allow, true);
    assert.equal(fail.verdict, "FAIL");
    assert.equal(assumptionGate(fail).allow, false);
    assert.equal(inconclusive.verdict, "INCONCLUSIVE");
    assert.equal(assumptionGate(inconclusive).allow, false);
    assert.match(assumptionGate(inconclusive).reason, /INCONCLUSIVE/);
  });
});
