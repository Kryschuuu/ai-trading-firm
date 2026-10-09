/**
 * Architektur-Doku ↔ Code: Symbol- und Pfad-Drift (Docs↔Code-Audit DC-06).
 *
 * `docs/architecture/PIPELINE_MAP.md` und `INTEGRATION_POINTS.md` sind als
 * „Master-Architekturkarte" bzw. verbindliche Referenz ausgewiesen. DC-06 hatte
 * gezeigt, dass die Karte Symbole und Dateien nannte, die es im Code nicht
 * (mehr) gab (`FunnelStageResult`, `executeWeeklyReview`, ein freies
 * Rule-`match…()` in der Regel-Engine, drei Portfolio-Guard-Funktionen, zwei
 * Adaptive-Risk-Funktionen, ein Env-Flag für den Kerzen-Speicher,
 * `src/perpdata/consumer.ts`, `src/components/workshop/InfoTip.tsx`). Wer der
 * Karte folgte, landete im Leeren.
 *
 * Diese Tests sichern die Korrektur statisch ab — bewusst **ohne** die Module
 * zu importieren (die Doku-Prüfung darf keine DB/LLM-Abhängigkeiten ziehen):
 *   1. Jeder in Backticks genannte `src/…`/`scripts/…`-Pfad existiert, außer er
 *      steht auf der kleinen Whitelist dokumentierter Altpfade (Audit-/
 *      Migrationshistorie). Die Whitelist darf nicht verrotten: jeder Eintrag
 *      muss in der Doku wirklich vorkommen.
 *   2. Die DC-06-Totsymbole tauchen in den Architekturdoks und in den beiden
 *      betroffenen Fachdocs nicht wieder auf.
 *   3. Die realen Einstiegssymbole, die die Karte jetzt nennt, sind echte
 *      Top-Level-Exporte der daneben genannten Datei.
 *   4. Die Modulgrenze der beiden `riskGuard.ts` ist in der Karte beschrieben
 *      (Absatz „Zwei Risk-Guards, zwei Zwecke") und die Pfleger Regeln stehen am
 *      Ende der Karte.
 *
 * Abgrenzung: Der generische Wächter „jedes dokumentierte Export-Symbol muss
 * existieren" in `npm run docs:validate` ist DC-08
 * (`docs/audits/2026-10-06-docs-code-audit/findings/DC-08-ci-waechter-luecken.md`).
 * Dieser Test prüft den konkret nachgeführten Bestand, nicht die Heuristik.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ARCH_DOCS_DIR = path.join(ROOT, "docs", "architecture");

/** Doku mit DC-06-Bezug (Architekturkarte + die beiden Fachdocs mit Altpfad). */
const DC06_DOCS = [
  "docs/architecture/PIPELINE_MAP.md",
  "docs/architecture/INTEGRATION_POINTS.md",
  "docs/MISSIONS.md",
  "docs/DOCS_SYNC_AUDIT.md",
];

/**
 * Bewusst geduldete Altpfade: historische Befunde in Audit-/Migrationstabellen.
 * Sie bleiben als Altpfad stehen, weil die Tabelle sonst ihre Aussage verliert
 * (S-11 „entfernt v1.1.0", Migration `historicalStore` → `lib/marketdata`).
 */
const LEGACY_PATH_WHITELIST = new Set<string>([
  "scripts/drizzle.config.json",
  "src/scanner/historicalStore.ts",
]);

/** Symbole/Pfade aus dem DC-06-Befund, die es im Code nicht gibt. */
const DEAD_SYMBOLS = [
  "FunnelStageResult",
  "getAdaptiveRiskFactor",
  "evaluateMarketRegime",
  "guardPortfolioAllocations",
  "enforcePositionLimits",
  "enforceCorrelationLimits",
  "matchRule",
  "evaluateRule",
  "listActiveRules",
  "recordRuleExecution",
  "RuleMatchResult",
  "RuleExecutionRecord",
  "HISTORICAL_DATA_DIR",
  "executeWeeklyReview",
  "writeCycleArtifact",
  "writeDailyUniverseArtifact",
  "optimizeWeights",
  "computeSeriesMetrics",
  "computeCorrelationMatrix",
  "clusterAssets",
  "PortfolioGuardReport",
  "OrderValidationParams",
  "backtestRuleOnCandles",
  "restoreFirmState",
  "FIRM_OPERATOR_TOKEN",
  "PriceTick",
  "src/components/workshop/InfoTip.tsx",
  "src/perpdata/consumer.ts",
];

const read = (rel: string): string => {
  const file = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  assert.ok(existsSync(file), `${rel} muss existieren`);
  return readFileSync(file, "utf8");
};

const archDocs = (): string[] =>
  readdirSync(ARCH_DOCS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => path.join("docs", "architecture", f));

/** Alle in Backticks gesetzten `src/…`/`scripts/…`-Dateipfade einer Doku. */
function backtickPaths(doc: string): Array<{ path: string; line: number }> {
  const text = read(doc);
  const pattern = /`((?:src|scripts)\/[A-Za-z0-9_\-./[\]]+\.(?:ts|tsx|json))`/g;
  const found: Array<{ path: string; line: number }> = [];
  for (const match of text.matchAll(pattern)) {
    found.push({ path: match[1], line: text.slice(0, match.index ?? 0).split("\n").length });
  }
  return found;
}

/**
 * Top-Level-Exporte einer Quelldatei (statisch, ohne Import):
 * `export const|let|function|class|interface|type|enum NAME` plus
 * `export { A, B }` (auch `export { A } from "…"` und `type A`).
 */
function topLevelExports(rel: string): Set<string> {
  const text = read(rel);
  const names = new Set<string>();
  const declaration =
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm;
  for (const match of text.matchAll(declaration)) names.add(match[1]);
  const braces = /^export\s*\{([^}]*)\}/gm;
  for (const match of text.matchAll(braces)) {
    for (const part of match[1].split(",")) {
      const cleaned = part.trim().replace(/^type\s+/, "");
      if (!cleaned) continue;
      names.add(cleaned.includes(" as ") ? cleaned.split(" as ").pop()!.trim() : cleaned);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// 1) Pfade in der Architektur-Doku existieren (Whitelist für Altpfade)
// ---------------------------------------------------------------------------

test("DC-06: jeder src-/scripts-Pfad in docs/architecture existiert oder ist whitelisted", () => {
  const dead: string[] = [];
  const whitelisted = new Set<string>();
  for (const doc of archDocs()) {
    for (const entry of backtickPaths(doc)) {
      if (existsSync(path.join(ROOT, entry.path))) continue;
      if (LEGACY_PATH_WHITELIST.has(entry.path)) {
        whitelisted.add(entry.path);
        continue;
      }
      dead.push(`${doc}:${entry.line} → ${entry.path}`);
    }
  }
  assert.deepEqual(dead, [], `tote Pfade in der Architektur-Doku:\n  ${dead.join("\n  ")}`);
});

test("DC-06: die Altpfad-Whitelist verrottet nicht (jeder Eintrag wird zitiert)", () => {
  for (const legacy of LEGACY_PATH_WHITELIST) {
    const cited = archDocs().some((doc) => backtickPaths(doc).some((entry) => entry.path === legacy));
    assert.ok(cited, `Whitelist-Eintrag ${legacy} kommt in docs/architecture/*.md nicht mehr vor — bitte austragen`);
    assert.ok(!existsSync(path.join(ROOT, legacy)), `${legacy} existiert wieder im Code — Whitelist-Eintrag entfernen`);
  }
});

// ---------------------------------------------------------------------------
// 2) Die DC-06-Totsymbole sind aus der Doku verschwunden
// ---------------------------------------------------------------------------

test("DC-06: keine dokumentierten Symbole/Pfade ohne Code-Entsprechung", () => {
  const hits: string[] = [];
  for (const doc of DC06_DOCS) {
    const text = read(doc);
    for (const dead of DEAD_SYMBOLS) {
      const pattern = new RegExp(`\\b${dead.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\b`);
      if (pattern.test(text)) hits.push(`${doc} → ${dead}`);
    }
  }
  assert.deepEqual(hits, [], `Totsymbole wieder in der Doku:\n  ${hits.join("\n  ")}`);
});

// ---------------------------------------------------------------------------
// 3) Die jetzt dokumentierten Einstiege sind reale Exporte
// ---------------------------------------------------------------------------

test("DC-06: Funnel, Weekly-Zyklus und Perp-Konsumenten zeigen auf reale Exporte", () => {
  const funnel = topLevelExports("src/scanner/funnel.ts");
  for (const name of ["FunnelResult", "buildFunnel", "selectDiversified"]) {
    assert.ok(funnel.has(name), `src/scanner/funnel.ts muss ${name} exportieren`);
  }

  const weekly = topLevelExports("src/cycle/weekly.ts");
  for (const name of ["weeklyReviewStep", "createWeeklySteps"]) {
    assert.ok(weekly.has(name), `src/cycle/weekly.ts muss ${name} exportieren`);
  }
  // Die fachliche Wochen-Klassifikation lebt im Scanner, nicht im Zyklus.
  const scannerWeekly = topLevelExports("src/scanner/weekly.ts");
  assert.ok(scannerWeekly.has("classifyWeekly"), "src/scanner/weekly.ts muss classifyWeekly exportieren");

  const cycleArtifacts = topLevelExports("src/cycle/artifacts.ts");
  for (const name of ["saveDailyCycleArtifacts", "saveWeeklyCycleArtifacts", "pruneArtifacts"]) {
    assert.ok(cycleArtifacts.has(name), `src/cycle/artifacts.ts muss ${name} exportieren`);
  }

  const scannerArtifacts = topLevelExports("src/scanner/artifacts.ts");
  for (const name of ["writeDailyArtifact", "writeWeeklyArtifact", "DAILY_FILE"]) {
    assert.ok(scannerArtifacts.has(name), `src/scanner/artifacts.ts muss ${name} exportieren`);
  }

  assert.ok(existsSync(path.join(ROOT, "src/perpdata/consumers.ts")), "src/perpdata/consumers.ts (Plural) fehlt");
  assert.ok(!existsSync(path.join(ROOT, "src/perpdata/consumer.ts")), "src/perpdata/consumer.ts darf nicht wieder auftauchen");
  assert.ok(existsSync(path.join(ROOT, "src/components/ui/InfoTip.tsx")), "src/components/ui/InfoTip.tsx fehlt");
});

test("DC-06: Adaptive-Risk- und Risk-Guard-Symbole sind korrekt zugeordnet", () => {
  const adaptive = topLevelExports("src/lib/adaptiveRisk.ts");
  for (const name of ["updateAdaptiveRisk", "getAdaptiveRiskStatus", "assessRegime", "RegimeStateMachine"]) {
    assert.ok(adaptive.has(name), `src/lib/adaptiveRisk.ts muss ${name} exportieren`);
  }

  const firmGuard = topLevelExports("src/lib/riskGuard.ts");
  for (const name of ["validateOrder", "killSwitch", "RISK_LIMITS", "LIMIT_CEILINGS", "DEFAULT_LIMITS", "applyAdaptiveRisk"]) {
    assert.ok(firmGuard.has(name), `src/lib/riskGuard.ts muss ${name} exportieren`);
  }

  const portfolioGuard = topLevelExports("src/portfolio/riskGuard.ts");
  for (const name of ["applyRiskGuard", "resolveGuardConfig", "assertAuthorityChain", "capFor"]) {
    assert.ok(portfolioGuard.has(name), `src/portfolio/riskGuard.ts muss ${name} exportieren`);
  }

  // Firm-Guardrails und Portfolio-Guards sind verschiedene Module — die
  // Portfolio-Kette startet in pipeline.ts, nicht im Optimizer.
  assert.ok(topLevelExports("src/portfolio/pipeline.ts").has("optimizeWithGuard"), "src/portfolio/pipeline.ts muss optimizeWithGuard exportieren");
  assert.ok(topLevelExports("src/portfolio/optimize.ts").has("optimizePortfolio"), "src/portfolio/optimize.ts muss optimizePortfolio exportieren");
});

test("DC-06: Regel-Pfad (Engine kompiliert, Cache matched, Service liest/schreibt)", () => {
  const engine = topLevelExports("src/lib/ruleEngine.ts");
  for (const name of ["compileRuleSpec", "sanitizeRuleSpec", "ruleSignature", "RULE_CEILINGS", "buildSnapshotFromCandles", "backtestRule"]) {
    assert.ok(engine.has(name), `src/lib/ruleEngine.ts muss ${name} exportieren`);
  }

  const service = topLevelExports("src/lib/ruleService.ts");
  for (const name of ["listRules", "getActiveRules", "upsertRuleSpec", "listRuleExecutions", "rowToSpec"]) {
    assert.ok(service.has(name), `src/lib/ruleService.ts muss ${name} exportieren`);
  }

  const executor = topLevelExports("src/lib/microExecutor.ts");
  for (const name of ["MicroExecutor", "RuleCache", "RollingTimeframeSeries", "createPaperRuleAdapter", "loadRuleCacheSnapshot"]) {
    assert.ok(executor.has(name), `src/lib/microExecutor.ts muss ${name} exportieren`);
  }

  // Der reale Matching-Einstieg ist RuleCache.match(); das Tageslimit wird dort
  // still übersprungen (continue), ohne rule_executions-Zeile oder Log.
  const executorSource = read("src/lib/microExecutor.ts");
  assert.match(executorSource, /^\s{2}match\(snap: RuleSnapshot/m, "RuleCache.match(snap, …) fehlt");
  assert.match(
    executorSource,
    /firedToday >= rule\.spec\.window\.maxExecutionsPerDay\) continue;/,
    "erschöpftes maxExecutionsPerDay muss den Kandidaten still überspringen (continue)",
  );
});

test("DC-06: Kerzen-Speicher hat kein Env-Flag, sondern Store-Pfade", () => {
  const store = read("src/lib/marketdata/historicalStore.ts");
  assert.match(store, /resolveRuntimePath\(dir \?\? "data\/history"\)/, "HistoricalStore-Defaultverzeichnis data/history fehlt");
  assert.match(store, /path\.join\(this\.dir, "candles\.ndjson"\)/, "HistoricalStore-Dateikonstante candles.ndjson fehlt");
  // Kein Code-Pfad liest ein Env-Flag für dieses Verzeichnis.
  const readers: string[] = [];
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") scan(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/HISTORICAL_DATA_DIR/.test(readFileSync(full, "utf8"))) readers.push(full);
    }
  };
  scan(path.join(ROOT, "src"));
  scan(path.join(ROOT, "scripts"));
  assert.deepEqual(readers, [], `HISTORICAL_DATA_DIR wird gelesen in: ${readers.join(", ")} — Doku nachziehen`);
});

// ---------------------------------------------------------------------------
// 4) Karten-Pflege: Modulgrenze und Pflegeregeln stehen in der Doku
// ---------------------------------------------------------------------------

test("DC-06: PIPELINE_MAP trennt die zwei riskGuard-Module und nennt die Pflegeregeln", () => {
  const map = read("docs/architecture/PIPELINE_MAP.md");
  assert.match(map, /##\s+Zwei Risk-Guards, zwei Zwecke/, "Absatz „Zwei Risk-Guards, zwei Zwecke“ fehlt");
  const section = map.slice(map.indexOf("Zwei Risk-Guards, zwei Zwecke"));
  assert.ok(section.includes("`src/lib/riskGuard.ts`"), "der Absatz muss die Firm-Guardrails nennen");
  assert.ok(section.includes("`src/portfolio/riskGuard.ts`"), "der Absatz muss die Portfolio-Guards nennen");

  assert.match(map, /##\s+8\.\s+Pflege dieser Karte/, "Abschnitt „Pflege dieser Karte“ fehlt");
  assert.match(map, /DC-08/, "die Pflegehinweise müssen auf den Wächter DC-08 verweisen");

  // Beide Architekturdoks tragen den Abgleich im Status-Header.
  for (const doc of ["docs/architecture/PIPELINE_MAP.md", "docs/architecture/INTEGRATION_POINTS.md"]) {
    const header = read(doc).split("\n").slice(0, 8).join("\n");
    assert.match(header, /DC-06/, `${doc}: Status-Header muss den Symbol-/Pfadabgleich (DC-06) ausweisen`);
    assert.ok(!/Vollabgleich offen/.test(header), `${doc}: Status-Header steht noch auf „Vollabgleich offen“`);
  }
});

test("DC-06: INTEGRATION_POINTS verweist auf die Risk-Guard-Grenze der Karte", () => {
  const integration = read("docs/architecture/INTEGRATION_POINTS.md");
  assert.match(integration, /PIPELINE_MAP\.md#zwei-risk-guards-zwei-zwecke/, "Querverweis auf „Zwei Risk-Guards, zwei Zwecke“ fehlt");
  assert.ok(integration.includes("`src/lib/brokerHydration.ts`"), "Hydration muss das reale Modul src/lib/brokerHydration.ts nennen");
});
