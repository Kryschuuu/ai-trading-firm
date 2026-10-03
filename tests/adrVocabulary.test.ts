/**
 * ADR-Konsistenz der Vokabular-Entscheidungen (STX-00-03, `v0.6.1`).
 *
 * `docs/roadmap/DECISIONS.md` fixiert mit ADR-008 (Strategieklasse, Audit-Kurzname
 * `ADR-E1`), ADR-009 (Regime, `ADR-E2`) und ADR-010 (Universe, `ADR-E3`), welches
 * Vokabular im Repo gilt. Eine Entscheidung, die nur im Text steht, driftet:
 * Code ändert sich, Prompts werden umgeschrieben, die ADR bleibt stehen. Diese
 * Tests nageln deshalb drei Dinge statisch fest — ohne Netzwerk und ohne DB:
 *
 *   1. Form: jedes ADR trägt Status/Kontext/Optionen/Entscheidung/Konsequenzen/
 *      Auswirkung, endet in genau einer Entscheidung und führt jede Alternative
 *      als „verworfen“ mit Begründung (Sperre des Prompts STX-00-03).
 *   2. Code-Fakten: jede Aussage, auf die sich eine ADR stützt (Klassenliste,
 *      Regime-Labels, `evaluateRegimeOos`-Verhalten, `UNIVERSE_CAP`, Bounds …),
 *      wird gegen den echten Code geprüft. Ändert sich der Bestand, schlägt der
 *      Test fehl — und zwingt zu einem neuen ADR statt zu stiller Abweichung.
 *   3. Verweise: Roadmap, Tracking und die betroffenen Prompts nennen die
 *      ADR-Nummern und widersprechen den Entscheidungen nicht.
 *
 * Reine Leseprüfungen: kein Test verändert Dateien oder Laufzeitzustand.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_MARKET_REGIME_CONFIG,
  GATE_FACTOR_BOUNDS,
  STRATEGY_CLASSES,
  regimeGateFactor,
  strategyClassOfTemplate,
} from "../src/lib/marketRegime";
import { DEFAULT_CLASS_POLICIES, STRATEGY_CLASS_KEYS } from "../src/lib/signalDecay";
import { REGIME_EVAL_LABELS, evaluateRegimeOos, type RegimeEvalRow } from "../src/lib/regimeEvaluation";
import { RULE_FIELDS } from "../src/lib/ruleFieldCatalog";
import { SUPPORTED_TIMEFRAMES } from "../src/lib/marketdata/historicalStore";
import { DEFAULT_CROSS_SECTIONAL_CONFIG, validateCrossSectionalConfig } from "../src/crossSectional/config";
import { selectUniverse } from "../src/crossSectional/universe";
import { AUTHORITY_CHAIN } from "../src/portfolio/types";
import { VOLATILITY_TARGETING_BOUNDS, resolveVolatilityTargetingConfig } from "../src/portfolio/volatilityTargeting";

const ROOT = process.cwd();
const DECISIONS = "docs/roadmap/DECISIONS.md";
const AUDIT = "docs/audits/2026-09-29-strategy-template-ausbau";

const read = (rel: string): string => {
  const file = path.join(ROOT, rel);
  assert.ok(existsSync(file), `${rel} muss existieren`);
  return readFileSync(file, "utf8");
};

/** Alle Dateien unterhalb von `dir` (relativ zum Repo-Root) mit einer der Endungen. */
function filesUnder(dir: string, extensions: readonly string[]): string[] {
  const base = path.join(ROOT, dir);
  if (!existsSync(base)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (extensions.some((ext) => entry.endsWith(ext))) out.push(path.relative(ROOT, full));
    }
  };
  walk(base);
  return out.sort();
}

/** Abschnitt `## ADR-00N: …` bis zur nächsten ADR-Überschrift bzw. Dateiende. */
function adrSection(log: string, nr: number): string {
  const id = String(nr).padStart(3, "0");
  const start = log.search(new RegExp(`^## ADR-${id}:`, "m"));
  assert.ok(start >= 0, `ADR-${id} fehlt in ${DECISIONS}`);
  const rest = log.slice(start + 1);
  const next = rest.search(/^## ADR-\d{3}:/m);
  return next < 0 ? log.slice(start) : log.slice(start, start + 1 + next);
}

/** Text zwischen zwei Bullet-Labels (`- **Label:**`) eines ADR-Abschnitts. */
function between(section: string, from: string, to: string): string {
  const a = section.indexOf(`- **${from}:**`);
  const b = section.indexOf(`- **${to}:**`);
  assert.ok(a >= 0 && b > a, `Abschnitt „${from}“ → „${to}“ nicht gefunden`);
  return section.slice(a, b);
}

/** Phasen-Abschnitte der Roadmap (`## Phase N — …`), Schlüssel = N. */
function roadmapPhases(): Map<number, string> {
  const roadmap = read(`${AUDIT}/ROADMAP.md`);
  const parts = roadmap.split(/^## (?=Phase \d)/m).slice(1);
  const phases = new Map<number, string>();
  for (const part of parts) {
    const nr = Number(part.match(/^Phase (\d)/)?.[1]);
    phases.set(nr, part);
  }
  return phases;
}

const PLANNED_TEMPLATE_IDS = [
  "ema-adx-trend",
  "macd-momentum",
  "rsi-mean-reversion",
  "bollinger-squeeze",
  "vwap-pullback",
  "donchian-breakout",
] as const;

const TEMPLATE_PROMPTS = [
  "PROMPT-STX-03-03-template-ema-adx.md",
  "PROMPT-STX-03-04-template-macd.md",
  "PROMPT-STX-03-05-template-rsi.md",
  "PROMPT-STX-03-06-template-bollinger.md",
  "PROMPT-STX-03-07-template-vwap.md",
  "PROMPT-STX-03-08-template-donchian.md",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// 1) Form des ADR-Logs
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-Log: Form (docs/roadmap/DECISIONS.md)", () => {
  const log = read(DECISIONS);

  test("ADR-Nummern sind fortlaufend ab 001 und eindeutig (mindestens bis ADR-010)", () => {
    const numbers = [...log.matchAll(/^## ADR-(\d{3}): .+$/gm)].map((m) => Number(m[1]));
    assert.ok(numbers.length >= 10, "ADR-001 … ADR-010 müssen im Log stehen");
    assert.deepEqual(numbers, numbers.map((_, index) => index + 1), "Nummern lückenlos, aufsteigend, nie wiederverwendet");
  });

  test("Kopfzeile nennt Stand und öffentliche Code-Version (v0.x, nicht die interne Legacy-Zählung)", () => {
    assert.match(log, /\*\*Stand:\*\* \d{4}-\d{2}-\d{2}/);
    assert.match(log, /\*\*Code-Version:\*\* v0\.\d+\.\d+ \(Beta\)/);
  });

  for (const nr of [8, 9, 10]) {
    const id = `ADR-${String(nr).padStart(3, "0")}`;

    test(`${id}: Schema Status → Kontext → Optionen → Entscheidung → Konsequenzen → Auswirkung (je genau einmal)`, () => {
      const section = adrSection(log, nr);
      const labels = ["Status", "Kontext", "Optionen", "Entscheidung", "Konsequenzen", "Auswirkung auf die Roadmap"];
      let cursor = -1;
      for (const label of labels) {
        const marker = `- **${label}:**`;
        assert.equal(section.split(marker).length - 1, 1, `${id}: „${label}“ muss genau einmal vorkommen`);
        const at = section.indexOf(marker);
        assert.ok(at > cursor, `${id}: „${label}“ steht in falscher Reihenfolge`);
        cursor = at;
      }
      assert.match(section, /- \*\*Status:\*\* Angenommen & Verbindlich/);
    });

    test(`${id}: genau eine gewählte Option, jede Alternative ist „verworfen“ mit Begründung`, () => {
      const options = between(adrSection(log, nr), "Optionen", "Entscheidung");
      const items = options.split("\n").filter((line) => /^ {2}\d+\. /.test(line));
      assert.ok(items.length >= 5, `${id}: erwartet ≥ 5 Optionen, gefunden ${items.length}`);
      assert.equal((options.match(/\*\*gewählt\*\*/g) ?? []).length, 1, `${id}: genau eine Option ist „gewählt“`);
      const rejected = items.filter((line) => line.includes("**verworfen:**"));
      assert.equal(rejected.length, items.length - 1, `${id}: jede andere Option ist „verworfen“`);
      for (const line of rejected) {
        const reason = line.split("**verworfen:**")[1].trim();
        // Begründung steht in der Zeile oder — bei Teilpunkten — in den folgenden Unterpunkten.
        const hasSubPoints = options.split(line)[1]?.startsWith("\n     - ") ?? false;
        assert.ok(reason.length >= 25 || hasSubPoints, `${id}: Verwerfung ohne Begründung: ${line.slice(0, 60)}`);
      }
    });

    test(`${id}: keine Vorbehalte („vielleicht später“) — die ADR endet in einer Entscheidung`, () => {
      const section = adrSection(log, nr);
      assert.doesNotMatch(section, /vielleicht|eventuell|ggf\.|gegebenenfalls|später|TBD|TODO|offen bleibt/i);
    });
  }

  test("Audit-Kurznamen ADR-E1…E3 stehen im Titel; im Audit wird kein anderer Kurzname zitiert", () => {
    assert.match(log, /^## ADR-008: .+\(ADR-E1\)$/m);
    assert.match(log, /^## ADR-009: .+\(ADR-E2\)$/m);
    assert.match(log, /^## ADR-010: .+\(ADR-E3\)$/m);
    for (const file of filesUnder(AUDIT, [".md"])) {
      for (const m of read(file).matchAll(/ADR-E(\d+)/g)) {
        assert.ok(["1", "2", "3"].includes(m[1]), `${file}: unbekannter Kurzname ADR-E${m[1]}`);
      }
    }
  });

  test("jede in docs/ zitierte ADR-Nummer existiert im Log", () => {
    const known = new Set([...log.matchAll(/^## ADR-(\d{3}): .+$/gm)].map((m) => m[1]));
    for (const file of filesUnder("docs", [".md"])) {
      for (const m of read(file).matchAll(/ADR-(\d{3})\b/g)) {
        assert.ok(known.has(m[1]), `${file}: ADR-${m[1]} existiert nicht im Log`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) ADR-008 — Strategie-Klassifikation: Code-Fakten
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-008 (E1): Strategie-Klassifikation — Code-Fakten", () => {
  test("Vokabular: drei Klassen + `unclassified`, genau eine Quelle je Liste", () => {
    assert.deepEqual([...STRATEGY_CLASSES], ["mean-reversion", "trend", "breakout"]);
    assert.deepEqual([...STRATEGY_CLASS_KEYS], [...STRATEGY_CLASSES, "unclassified"]);
  });

  test("Kontrakt-Invariante: jede Klasse hat in allen fünf Regimes einen Gate-Faktor und eine Decay-Policy", () => {
    const regimes = Object.keys(DEFAULT_MARKET_REGIME_CONFIG.gateFactors);
    assert.equal(regimes.length, 5);
    for (const regime of regimes as (keyof typeof DEFAULT_MARKET_REGIME_CONFIG.gateFactors)[]) {
      assert.deepEqual(
        Object.keys(DEFAULT_MARKET_REGIME_CONFIG.gateFactors[regime]).sort(),
        [...STRATEGY_CLASSES].sort(),
        `gateFactors[${regime}] muss genau die Klassen aus STRATEGY_CLASSES tragen`,
      );
      for (const cls of STRATEGY_CLASSES) {
        const factor = regimeGateFactor(regime, cls);
        assert.ok(Number.isFinite(factor), `Gate-Faktor ${regime}/${cls} muss endlich sein`);
        assert.ok(factor >= GATE_FACTOR_BOUNDS[0] && factor <= GATE_FACTOR_BOUNDS[1], `Gate-Faktor ${regime}/${cls} außerhalb der Bounds`);
      }
    }
    for (const cls of STRATEGY_CLASSES) {
      const policy = DEFAULT_CLASS_POLICIES[cls];
      assert.ok(policy, `DEFAULT_CLASS_POLICIES fehlt für ${cls}`);
      assert.equal(typeof policy.halfLifeMs, "number", `${cls}: Klassen-Policy hat eine Halbwertszeit`);
    }
  });

  test("`unclassified` ist die Nicht-Klasse: Policy default-off, keine Halbwertszeit, im Gate Faktor 1", () => {
    assert.equal(DEFAULT_CLASS_POLICIES.unclassified.enabled, false);
    assert.equal(DEFAULT_CLASS_POLICIES.unclassified.halfLifeMs, null);
    for (const regime of ["TREND_UP", "TREND_DOWN", "RANGE", "HIGH_VOL", "CRASH", "UNKNOWN"] as const) {
      assert.equal(regimeGateFactor(regime, null), 1, `ohne Klasse gilt Faktor 1 (${regime})`);
    }
  });

  test("Namens-Heuristik der Mission-Templates liefert für 2 von 6 geplanten Template-IDs `null` (Option 5 verworfen)", () => {
    const derived = PLANNED_TEMPLATE_IDS.map((id) => [id, strategyClassOfTemplate(id)] as const);
    assert.deepEqual(derived, [
      ["ema-adx-trend", "trend"],
      ["macd-momentum", "trend"],
      ["rsi-mean-reversion", "mean-reversion"],
      ["bollinger-squeeze", null],
      ["vwap-pullback", null],
      ["donchian-breakout", "breakout"],
    ]);
  });

  test("Klassen-Tabelle der ADR stimmt mit den sechs Template-Prompts überein und nutzt nur Bestands-Klassen", () => {
    const section = adrSection(read(DECISIONS), 8);
    const table = new Map<string, string>();
    for (const m of section.matchAll(/^ {4}\| `([a-z0-9-]+)` \| `([a-z-]+)` \|$/gm)) table.set(m[1], m[2]);
    assert.deepEqual([...table.keys()], [...PLANNED_TEMPLATE_IDS], "Tabelle muss genau die sechs geplanten Templates führen");
    for (const [id, cls] of table) {
      assert.ok((STRATEGY_CLASSES as readonly string[]).includes(cls), `${id}: Klasse ${cls} ist keine Bestands-Klasse`);
    }
    for (const file of TEMPLATE_PROMPTS) {
      const prompt = read(`${AUDIT}/prompts/${file}`);
      const id = prompt.match(/^\| `id` \| `([a-z0-9-]+)` \|/m)?.[1];
      const cls = prompt.match(/^\| `class` \| `"([a-z-]+)"`/m)?.[1];
      assert.ok(id && cls, `${file}: id/class-Zeile nicht gefunden`);
      assert.equal(table.get(id), cls, `${file}: Klasse weicht von der ADR-Tabelle ab`);
    }
  });

  test("Guard für src/strategies/: keine eigene Klassenliste, kein eigener Union-Typ, Klasse aus StrategyClassKey", () => {
    const files = filesUnder("src/strategies", [".ts"]);
    for (const file of files) {
      const source = read(file);
      assert.doesNotMatch(source, /type\s+\w+\s*=\s*(?:\|\s*)?["']mean-reversion["']/, `${file}: eigener Klassen-Union-Typ (ADR-008)`);
      assert.doesNotMatch(source, /\[\s*["']mean-reversion["']/, `${file}: eigene Klassenliste (ADR-008)`);
      assert.doesNotMatch(source, /["']unclassified["']\s*,\s*["']/, `${file}: eigene Klassenliste mit unclassified (ADR-008)`);
    }
    if (existsSync(path.join(ROOT, "src/strategies/types.ts"))) {
      assert.match(read("src/strategies/types.ts"), /\bclass\s*:\s*StrategyClassKey\b/, "StrategyTemplate.class muss StrategyClassKey sein (ADR-008)");
    }
  });

  test("Guard für signalDecay*: keine Klassen-Literale in Vergleichen oder Listen — die Klasse kommt aus STRATEGY_CLASSES/STRATEGY_CLASS_KEYS (STX-08-03)", () => {
    // Quelltext-Muster wie beim src/strategies/-Wächter. Die Namen kommen aus
    // der SSoT: eine per ADR ergänzte fünfte Klasse wird sofort mitgeprüft,
    // `unclassified` ist als Nicht-Klasse enthalten.
    const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const classLiteral = `(?:${STRATEGY_CLASS_KEYS.map(escape).join("|")})`;
    const patterns: ReadonlyArray<[RegExp, string]> = [
      [new RegExp(`(?:===|!==|==|!=)\\s*["']${classLiteral}["']`), "Vergleich gegen ein Klassenliteral"],
      [new RegExp(`["']${classLiteral}["']\\s*(?:===|!==|==|!=)`), "Vergleich gegen ein Klassenliteral"],
      [new RegExp(`\\[\\s*["']${classLiteral}["']`), "eigene Klassenliste"],
      [new RegExp(`["']${classLiteral}["']\\s*,\\s*["']${classLiteral}["']`), "eigene Klassenliste"],
    ];
    for (const file of ["src/lib/signalDecay.ts", "src/lib/signalDecayRuntime.ts"]) {
      const source = read(file);
      for (const [pattern, what] of patterns) {
        assert.doesNotMatch(
          source,
          pattern,
          `${file}: ${what} — die Klassenliste ist aus STRATEGY_CLASSES abzuleiten (ADR-008)`,
        );
      }
    }
    assert.match(
      read("src/lib/signalDecay.ts"),
      /export const STRATEGY_CLASS_KEYS:[^=]*=\s*\[\.\.\.STRATEGY_CLASSES,\s*"unclassified"\s*\]/,
      "STRATEGY_CLASS_KEYS muss aus STRATEGY_CLASSES abgeleitet sein (ADR-008)",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) ADR-009 — Regime-Vokabular: Code-Fakten
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-009 (E2): Regime-Vokabular — Code-Fakten", () => {
  test("Vokabular: fünf MarketRegime-Werte + UNKNOWN; das Gate kennt UNKNOWN nicht als Regime", () => {
    assert.deepEqual([...REGIME_EVAL_LABELS], ["TREND_UP", "TREND_DOWN", "RANGE", "HIGH_VOL", "CRASH", "UNKNOWN"]);
    assert.deepEqual(Object.keys(DEFAULT_MARKET_REGIME_CONFIG.gateFactors), REGIME_EVAL_LABELS.slice(0, 5));
  });

  test("regime_snapshots: CHECK-Constraint führt exakt die sechs Labels (ein Label je Snapshot)", () => {
    const sql = read("drizzle/2026-09-22_regime_snapshots.sql");
    const check = sql.match(/"confirmed_regime" IN \(([^)]+)\)/);
    assert.ok(check, "CHECK über confirmed_regime nicht gefunden");
    const labels = [...check[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(labels, [...REGIME_EVAL_LABELS]);
  });

  test("evaluateRegimeOos misst den Markt: UNKNOWN ist ein eigener Bucket, Fremd-Labels landen darin, Horizont `null` wird ausgeschlossen", () => {
    const row = (asOfMs: number, confirmedRegime: string, forwardReturnPct: number | null): RegimeEvalRow => ({
      symbol: "BTC",
      asOfMs,
      rawRegime: confirmedRegime,
      confirmedRegime,
      confidence: confirmedRegime === "UNKNOWN" ? null : 0.8,
      coverage: 1,
      degraded: false,
      forwardReturnPct,
    });
    const oos = evaluateRegimeOos([row(1, "RANGE", 1), row(2, "UNKNOWN", -2), row(3, "SIDEWAYS", 3), row(4, "RANGE", null)]);
    const byRegime = new Map(oos.map((m) => [m.regime, m]));
    assert.deepEqual([...byRegime.keys()], ["RANGE", "UNKNOWN"], "keine Buckets außerhalb der sechs Labels");
    assert.deepEqual(
      { snapshots: byRegime.get("RANGE")?.snapshots, samples: byRegime.get("RANGE")?.samples, excluded: byRegime.get("RANGE")?.excluded },
      { snapshots: 2, samples: 1, excluded: 1 },
      "Snapshot ohne Horizont wird ausgeschlossen, nie als 0 gewertet",
    );
    assert.equal(byRegime.get("UNKNOWN")?.snapshots, 2, "UNKNOWN + Fremd-Label teilen den UNKNOWN-Bucket (Messbericht)");
    assert.equal(byRegime.get("UNKNOWN")?.meanForwardReturnPct, 0.5);
  });

  test("die verworfene 7er-Taxonomie existiert nirgends als Label im Code", () => {
    const forbidden = /["'](sideways|low-vol|high-vol|high-volume|low-volume)["']/;
    for (const file of [...filesUnder("src", [".ts", ".tsx"]), ...filesUnder("scripts", [".ts"])]) {
      assert.doesNotMatch(read(file), forbidden, `${file}: Label der verworfenen 7er-Taxonomie (ADR-009)`);
    }
  });

  test("Volumen ist kein Regime, sondern Scanner-Faktor und Regel-Feld (`volumeRatio`)", () => {
    assert.ok("volumeRatio" in RULE_FIELDS, "volumeRatio ist ein Regel-Feld");
    const scannerConfig = JSON.parse(read("src/scanner/scanner.config.json")) as { factors: Record<string, unknown> };
    assert.ok("volumeRatio" in scannerConfig.factors, "volumeRatio ist ein Scanner-Faktor");
    assert.ok(!(REGIME_EVAL_LABELS as readonly string[]).some((label) => /VOLUME/i.test(label)), "kein Volume-Regime");
  });

  test("Beta-Kriterium B2 ist über die 5 MarketRegime-Klassen definiert (keine andere Taxonomie)", () => {
    assert.ok(read("docs/BETA_STATUS.md").includes("5 `MarketRegime`-Klassen"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) ADR-010 — Universe-Strategie: Code-Fakten
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-010 (E3): Universe-Strategie — Code-Fakten", () => {
  test("CrossSectionalConfig trägt Ranking/Eligibility/Timeframe — und kein sizing/rebalance/selection", () => {
    const keys = Object.keys(DEFAULT_CROSS_SECTIONAL_CONFIG);
    for (const required of ["horizons", "eligibility", "timeframe", "availabilityPolicy"]) {
      assert.ok(keys.includes(required), `CrossSectionalConfig.${required} fehlt`);
    }
    for (const foreign of ["sizing", "rebalance", "selection", "topN", "weights"]) {
      assert.ok(!keys.includes(foreign), `CrossSectionalConfig.${foreign} existiert — ADR-010 (Kontext/Optionen) neu bewerten`);
    }
    assert.deepEqual(Object.keys(DEFAULT_CROSS_SECTIONAL_CONFIG.eligibility).sort(), [
      "assetClasses",
      "maxStaleBars",
      "maxUniverseSize",
      "minCandles",
      "minVolume24h",
    ]);
  });

  test("Rebalance-Frequenz = timeframe: alle zehn SUPPORTED_TIMEFRAMES sind gültig, Unbekanntes wird abgelehnt", () => {
    assert.equal(SUPPORTED_TIMEFRAMES.length, 10);
    assert.equal(DEFAULT_CROSS_SECTIONAL_CONFIG.timeframe, "1h");
    for (const timeframe of SUPPORTED_TIMEFRAMES) {
      assert.doesNotThrow(() => validateCrossSectionalConfig({ ...DEFAULT_CROSS_SECTIONAL_CONFIG, timeframe }), `timeframe ${timeframe}`);
    }
    for (const bad of ["7d", "2H", ""]) {
      assert.throws(() => validateCrossSectionalConfig({ ...DEFAULT_CROSS_SECTIONAL_CONFIG, timeframe: bad }), /timeframe/);
    }
  });

  test("UNIVERSE_CAP kappt nach volume24h (Liquidität), nicht nach Composite-Rang — topN ist nicht abgedeckt", () => {
    const config = {
      ...DEFAULT_CROSS_SECTIONAL_CONFIG,
      eligibility: { ...DEFAULT_CROSS_SECTIONAL_CONFIG.eligibility, maxUniverseSize: 2 },
    };
    const candidate = (id: string, volume24h: number) => ({ id, status: "active", assetClass: "crypto", volume24h });
    const { verdicts } = selectUniverse(
      [candidate("A", 500_000), candidate("B", 900_000), candidate("C", 700_000)],
      new Map(),
      { asOf: 1_700_000_000_000, tfMs: 3_600_000, policy: "ingested" },
      336 * 3_600_000,
      config,
    );
    const reason = Object.fromEntries(verdicts.map((v) => [v.instrumentId, v.reason]));
    assert.equal(reason.A, "UNIVERSE_CAP", "das volumenschwächste Instrument fällt aus dem Cap");
    assert.notEqual(reason.B, "UNIVERSE_CAP");
    assert.notEqual(reason.C, "UNIVERSE_CAP");
  });

  test("Vol-Targeting-Bounds begrenzen den Multiplikator (hart ≤ 1), nicht einzelne Gewichte", () => {
    assert.deepEqual(VOLATILITY_TARGETING_BOUNDS.minMultiplier, [0.05, 1]);
    assert.deepEqual(VOLATILITY_TARGETING_BOUNDS.maxMultiplier, [0.05, 1]);
    assert.equal(resolveVolatilityTargetingConfig({ maxMultiplier: 5 }).maxMultiplier, 1, "maxMultiplier wird hart auf 1 geklemmt");
    assert.ok(!Object.keys(VOLATILITY_TARGETING_BOUNDS).some((key) => /weight/i.test(key)), "keine Gewichts-Bounds im Vol-Targeting");
    assert.match(read("src/portfolio/types.ts"), /export interface WeightBounds\b/, "Gewichts-Schranken liegen in WeightBounds");
  });

  test("Sizing fehlt im Bestand: der Optimizer kennt nur min_variance, max_sharpe, risk_parity", () => {
    assert.match(
      read("src/portfolio/types.ts"),
      /export type OptimizationMode = "min_variance" \| "max_sharpe" \| "risk_parity";/,
      "OptimizationMode geändert — ADR-010 (Kontext, Option 4) neu bewerten",
    );
  });

  test("Autoritätskette bleibt Optimizer → Risk Guard → Position Limits → Correlation Limits", () => {
    assert.deepEqual([...AUTHORITY_CHAIN], ["portfolio-optimizer", "risk-guard", "position-limits", "correlation-limits"]);
  });

  test("keine MultiAssetStrategySpec in src/ und scripts/ (verworfen)", () => {
    for (const file of [...filesUnder("src", [".ts", ".tsx"]), ...filesUnder("scripts", [".ts"])]) {
      assert.doesNotMatch(read(file), /MultiAssetStrategySpec/, `${file}: MultiAssetStrategySpec ist durch ADR-010 verworfen`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) Verweise: Roadmap, Tracking, betroffene Prompts
// ─────────────────────────────────────────────────────────────────────────────

describe("Verweise auf die ADR-Nummern (Roadmap, Tracking, Prompts)", () => {
  test("jede Roadmap-Phase, die ein Vokabular berührt, nennt die ADR-Nummer", () => {
    const phases = roadmapPhases();
    const expected: Record<number, string[]> = {
      0: ["ADR-008", "ADR-009", "ADR-010"],
      1: ["ADR-010"],
      3: ["ADR-008", "ADR-009", "ADR-010"],
      4: ["ADR-008"],
      5: ["ADR-008", "ADR-010"],
      6: ["ADR-009"],
      7: ["ADR-010"],
    };
    for (const [nr, adrs] of Object.entries(expected)) {
      const text = phases.get(Number(nr));
      assert.ok(text, `Phase ${nr} fehlt in der Roadmap`);
      for (const adr of adrs) assert.ok(text.includes(adr), `Phase ${nr} verweist nicht auf ${adr}`);
    }
  });

  test("Tracking: 00-02/00-03 sind ☑ in v0.6.1, Gate G0 ist erfüllt, STX-02/03/04 sind nicht mehr offen, OP-2 ist beantwortet", () => {
    const tracking = read(`${AUDIT}/remediation/TRACKING.md`);
    assert.match(tracking, /^\| 00-02 \|.*\| ☑ \|.*v0\.6\.1/m);
    assert.match(tracking, /^\| 00-03 \|.*\| ☑ \|.*v0\.6\.1/m);
    assert.match(tracking, /^\| \*\*G0\*\* \| ✅/m);
    for (const id of ["STX-02", "STX-03", "STX-04"]) {
      const row = tracking.match(new RegExp(`^\\| ${id} [^\\n]*$`, "m"))?.[0];
      assert.ok(row, `${id} fehlt im Tracking`);
      assert.doesNotMatch(row, /\| ☐ \|/, `${id} darf nach 00-03 nicht mehr ☐ sein`);
    }
    assert.match(tracking, /\*\*OP-2:\*\*[\s\S]*?beantwortet/);
  });

  test("Prompts folgen den Entscheidungen: expectedRegimes ohne UNKNOWN, Compiler liefert strategyClass, Aggregator statt evaluateRegimeOos", () => {
    const prompts = `${AUDIT}/prompts`;
    assert.match(read(`${prompts}/PROMPT-STX-03-01-template-types.md`), /expectedRegimes: readonly MarketRegime\[\]/);
    assert.match(read(`${prompts}/PROMPT-STX-03-02-catalog.md`), /expectedRegimes[^\n]*ohne `UNKNOWN`/);
    assert.match(read(`${prompts}/PROMPT-STX-03-09-compiler.md`), /ok: true; spec: RuleSpec; strategyClass: StrategyClassKey/);
    const report = read(`${prompts}/PROMPT-STX-06-04-validation-report.md`);
    assert.match(report, /regimes: readonly \{ regime: MarketRegime;/);
    assert.match(report, /Aggregator/);
  });

  test("die Findings STX-02/03/04 verweisen auf ihre ADR", () => {
    const expected: Record<string, string> = {
      "STX-02-strategyclass-duplikat.md": "ADR-008",
      "STX-03-regime-vokabular-konflikt.md": "ADR-009",
      "STX-04-multiaset-spec-duplikat.md": "ADR-010",
    };
    for (const [file, adr] of Object.entries(expected)) {
      assert.ok(read(`${AUDIT}/findings/${file}`).includes(adr), `${file} verweist nicht auf ${adr}`);
    }
  });
});
