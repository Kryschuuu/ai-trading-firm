/**
 * Policy-Engine des Model Routers (Task 09).
 *
 * 1. Erschöpfende Routing-Tabelle: Agent × Complexity × Health × Budget
 *    (> 60 Fälle), jede Entscheidung deterministisch.
 * 2. Default-Tabelle (CEO → automatic, Research → large, Technical → local-small,
 *    News → local-small, Risk → local-medium, Portfolio → local-medium).
 * 3. Modi: manual · automatic · hybrid.
 * 4. Policy-Schema-Validierung (ungültige Policy ⇒ Startverweigerung).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_ROUTING_POLICY,
  ModelRouter,
  RoutingPolicyError,
  assertRoutingPolicy,
  defaultRoutingPolicy,
  loadRoutingPolicy,
  toRoutingContext,
  validateRoutingPolicy,
} from "../src/routing";
import { createFakeProviderRegistry } from "../src/routing/registry";
import { MemoryAuditSink } from "../src/routing/audit";
import { createTestRouter, ctx } from "./fixtures/routingTestUtil";
import type { RoutingPolicy } from "../src/routing/policy";
import type { ModelClass, RoutingMode } from "../src/routing/types";

const AGENTS = ["CEO", "RESEARCH", "TECHNICAL_ANALYST", "NEWS_ANALYST", "RISK_MANAGER", "PORTFOLIO_ANALYST"];
const COMPLEXITIES = ["low", "medium", "high"] as const;
const HEALTH_SCENARIOS = ["all-online", "ollama-offline", "ollama-degraded"] as const;
const BUDGET_SCENARIOS = ["ok", "cloud-exhausted"] as const;

const CLOUD = new Set(["gemini", "anthropic"]);

beforeEach(() => {
  // Kein globaler Zustand zwischen den Tests.
  delete process.env.ROUTING_POLICY_PATH;
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Erschöpfende Routing-Tabelle (6 · 3 · 3 · 2 = 108 Fälle)
// ─────────────────────────────────────────────────────────────────────────────

test("Policy: erschöpfende Routing-Tabelle (108 Fälle) ist deterministisch und regelkonform", () => {
  let cases = 0;
  const seen = new Map<string, string>();

  for (const agent of AGENTS) {
    for (const complexity of COMPLEXITIES) {
      for (const health of HEALTH_SCENARIOS) {
        for (const budget of BUDGET_SCENARIOS) {
          cases += 1;
          const { router, registry } = createTestRouter();
          if (health === "ollama-offline") registry.setHealth("ollama", "offline");
          if (health === "ollama-degraded") registry.setHealth("ollama", "degraded");
          if (budget === "cloud-exhausted") {
            router.budget.consume({ provider: "gemini", agent, tokens: 1_000_000 });
            router.budget.consume({ provider: "anthropic", agent, tokens: 1_000_000 });
          }

          const request = ctx({ agent, complexity, tokenBudget: 2048 });
          const first = router.resolve(request);
          const second = router.resolve(request);

          // Determinismus: identische Eingaben ⇒ identische Entscheidung
          assert.equal(JSON.stringify(first), JSON.stringify(second), `Fall ${agent}/${complexity}/${health}/${budget}`);

          // Ergebnisraum
          assert.ok(
            ["MODEL_A", "MODEL_B", "MODEL_C", "CLOUD", "FALLBACK"].includes(first.decision),
            `Unerlaubtes Ergebnis: ${first.decision}`
          );
          // Kontrakt: provider "none" ⇔ FALLBACK
          assert.equal(first.provider === "none", first.decision === "FALLBACK");
          // Policy-Version überall dabei
          assert.equal(first.policyVersion, DEFAULT_ROUTING_POLICY.version);
          // Cloud nur mit erlaubtem Agenten
          if (CLOUD.has(first.provider)) {
            assert.equal(DEFAULT_ROUTING_POLICY.agents[agent]?.allowCloud !== false, true, `${agent} darf keine Cloud nutzen`);
          }
          // Budget erschöpft ⇒ kein Cloud-Provider
          if (budget === "cloud-exhausted" && CLOUD.has(first.provider)) {
            assert.fail(`${agent}: Cloud-Provider ${first.provider} trotz erschöpftem Budget gewählt`);
          }
          // Health offline ⇒ ollama nie gewählt
          if (health === "ollama-offline") {
            assert.notEqual(first.provider, "ollama");
          }

          const key = `${agent}|${complexity}|${health}|${budget}`;
          seen.set(key, `${first.decision}/${first.provider}/${first.model}`);
        }
      }
    }
  }

  assert.equal(cases, 108, "Anzahl der Tabellenfälle");
  assert.equal(seen.size, 108);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Default-Routing-Tabelle
// ─────────────────────────────────────────────────────────────────────────────

test("Policy: Default-Tabelle CEO→automatic, Research→large, Technical/News→local-small, Risk/Portfolio→local-medium", () => {
  const { router } = createTestRouter();

  const technical = router.resolve(ctx({ agent: "TECHNICAL_ANALYST", task: "technical_analysis_standard" }));
  assert.equal(technical.decision, "MODEL_A");
  assert.equal(technical.modelClass, "MODEL_A");
  assert.equal(technical.provider, "ollama");

  const news = router.resolve(ctx({ agent: "NEWS_ANALYST", task: "news_categorization" }));
  assert.equal(news.decision, "MODEL_A");

  const risk = router.resolve(ctx({ agent: "RISK_MANAGER", task: "simple_risk_decision" }));
  assert.equal(risk.decision, "MODEL_B");
  assert.equal(risk.modelClass, "MODEL_B");

  const portfolio = router.resolve(ctx({ agent: "PORTFOLIO_ANALYST" }));
  assert.equal(portfolio.modelClass, "MODEL_B");

  const research = router.resolve(ctx({ agent: "RESEARCH", task: "default" }));
  assert.equal(research.modelClass, "MODEL_C");

  const ceo = router.resolve(ctx({ agent: "CEO" }));
  assert.equal(ceo.mode, "automatic");
  assert.equal(ceo.modelClass, "MODEL_A", "CEO startet ohne Task-Vorgabe lokal-klein");
  const ceoStrategy = router.resolve(ctx({ agent: "CEO", task: "strategy_development", complexity: "high" }));
  assert.equal(ceoStrategy.modelClass, "MODEL_C");
});

test("Policy: Task-Overrides erzwingen die große Klasse (Synthese, Selektion, Regime, Wochenbericht)", () => {
  const { router } = createTestRouter();
  for (const task of [
    "technical_news_synthesis",
    "market_selection",
    "portfolio_analysis",
    "complex_research",
    "regime_analysis",
    "conflicting_evidence",
    "strategy_development",
    "weekly_report",
  ]) {
    const decision = router.resolve(ctx({ agent: "TECHNICAL_ANALYST", task }));
    assert.equal(decision.modelClass, "MODEL_C", `Task ${task} muss auf MODEL_C rutschen`);
  }
});

test("Policy: Complexity- und Risk-Floor heben die Klasse deterministisch an", () => {
  const { router } = createTestRouter();
  assert.equal(router.resolve(ctx({ agent: "CEO", complexity: "low" })).modelClass, "MODEL_A");
  assert.equal(router.resolve(ctx({ agent: "CEO", complexity: "medium" })).modelClass, "MODEL_B");
  assert.equal(router.resolve(ctx({ agent: "CEO", complexity: "high" })).modelClass, "MODEL_C");
  assert.equal(router.resolve(ctx({ agent: "CEO", complexity: "critical" })).modelClass, "MODEL_C");
  assert.equal(router.resolve(ctx({ agent: "CEO", complexity: "low", risk: "high" })).modelClass, "MODEL_C");
  assert.equal(
    router.resolve(ctx({ agent: "CEO", complexity: "low", risk: "medium" })).modelClass,
    "MODEL_B"
  );
});

test("Policy: Latenz-, Kontext- und Kosten-Grenzen filtern Provider deterministisch", () => {
  const { router } = createTestRouter();
  // Latenz: ollama (EMA 250 ms) fällt weg, wenn < 250 ms gefordert sind
  const fast = router.resolve(ctx({ agent: "CEO", latencyRequirementMs: 100 }));
  assert.notEqual(fast.provider, "ollama");
  // Kontext: 100k Token überschreiten Ollama (4096) ⇒ Cloud
  const bigContext = router.resolve(ctx({ agent: "RESEARCH", contextSize: 100_000 }));
  assert.ok(CLOUD.has(bigContext.provider));
  // Kostendeckel 0 ⇒ kein Cloud-Provider
  const zeroCost = router.resolve(ctx({ agent: "RESEARCH", maxCostUsd: 0 }));
  assert.equal(CLOUD.has(zeroCost.provider), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Modi manual · automatic · hybrid
// ─────────────────────────────────────────────────────────────────────────────

test("Modi: manual pinnt das Modell (Eskalation bleibt möglich), keine freie Router-Wahl", () => {
  const { router } = createTestRouter({
    agents: { TECHNICAL_ANALYST: { mode: "manual", pinnedModel: "qwen2.5:3b-instruct-q4_K_M", defaultClass: "MODEL_A" } },
  });
  const decision = router.resolve(ctx({ agent: "TECHNICAL_ANALYST", complexity: "high", task: "technical_news_synthesis" }));
  assert.equal(decision.mode, "manual");
  assert.equal(decision.model, "qwen2.5:3b-instruct-q4_K_M");
  assert.equal(decision.trigger, "MANUAL_PINNED");
  assert.equal(decision.modelClass, "MODEL_A", "manual ignoriert Complexity-Floor");
});

test("Modi: manual mit pinnedModel 'none' ⇒ deterministische Regel-Engine (FALLBACK)", () => {
  const { router } = createTestRouter({
    agents: { EXECUTOR: { mode: "manual", pinnedModel: "none", defaultClass: "MODEL_A" } },
  });
  const decision = router.resolve(ctx({ agent: "EXECUTOR" }));
  assert.equal(decision.decision, "FALLBACK");
  assert.equal(decision.provider, "none");
  assert.equal(decision.model, "rule-engine");
});

test("Modi: automatic hebt die Klasse frei an, hybrid bleibt in der Klassengrenze", () => {
  const automatic = createTestRouter().router;
  const hybrid = createTestRouter({ modes: { TECHNICAL_ANALYST: "hybrid" } }).router;

  const auto = automatic.resolve(ctx({ agent: "TECHNICAL_ANALYST", task: "technical_news_synthesis", complexity: "high" }));
  const hyb = hybrid.resolve(ctx({ agent: "TECHNICAL_ANALYST", task: "technical_news_synthesis", complexity: "high" }));

  assert.equal(auto.mode, "automatic");
  assert.equal(auto.modelClass, "MODEL_C");
  assert.equal(hyb.mode, "hybrid");
  assert.equal(hyb.modelClass, "MODEL_A", "hybrid bleibt in der Tabellen-Klasse");
  assert.equal(hyb.trigger, "HYBRID_BOUND");
});

test("Modi: hybrid wählt den Provider INNERHALB der Klasse, niemals darüber", () => {
  const { router, registry } = createTestRouter({ modes: { RISK_MANAGER: "hybrid" } });
  const normal = router.resolve(ctx({ agent: "RISK_MANAGER" }));
  assert.equal(normal.modelClass, "MODEL_B");
  assert.equal(normal.provider, "ollama");

  // Ollama offline ⇒ Router bleibt in MODEL_B und wählt den nächsten Provider
  registry.setHealth("ollama", "offline");
  const chained = router.resolve(ctx({ agent: "RISK_MANAGER" }));
  assert.equal(chained.mode, "hybrid");
  assert.equal(chained.modelClass, "MODEL_B");
  assert.equal(chained.provider, "openai");

  // Auch hohe Komplexität hebt die Klasse im hybrid-Modus NICHT an
  const complex = router.resolve(ctx({ agent: "RISK_MANAGER", complexity: "critical", task: "regime_analysis" }));
  assert.equal(complex.modelClass, "MODEL_B");
});

test("Modi: Admin-Änderung wird validiert und auditiert", () => {
  const { router, audit } = createTestRouter();
  const ok = router.setModes({ NEWS_ANALYST: "hybrid" }, "admin@test");
  assert.equal(ok.ok, true);
  assert.equal(router.effectiveMode("NEWS_ANALYST"), "hybrid");
  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0].outcome, "admin");
  assert.equal(audit.entries[0].from, "mode:automatic");
  assert.equal(audit.entries[0].to, "mode:hybrid");

  const bad = router.setModes({ NEWS_ANALYST: "turbo" }, "admin@test");
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /unbekannter Modus/);
  assert.equal(audit.entries.length, 1, "ungültige Änderung erzeugt kein Audit");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Policy-Schema-Validierung
// ─────────────────────────────────────────────────────────────────────────────

test("Policy-Schema: Default-Policy ist valide", () => {
  const result = validateRoutingPolicy(DEFAULT_ROUTING_POLICY);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.doesNotThrow(() => assertRoutingPolicy(defaultRoutingPolicy()));
});

test("Policy-Schema: ungültige Policy ⇒ Startverweigerung (RoutingPolicyError)", () => {
  const broken = structuredClone(DEFAULT_ROUTING_POLICY) as RoutingPolicy;
  broken.version = "";
  broken.defaultMode = "turbo" as RoutingMode;
  broken.classes.MODEL_A.providers = [];
  broken.escalation.maxConfidenceToApprove = 5;
  broken.quotaMinPercent = 120;

  const result = validateRoutingPolicy(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 5);

  assert.throws(() => assertRoutingPolicy(broken), RoutingPolicyError);
  try {
    assertRoutingPolicy(broken);
  } catch (e) {
    assert.ok(e instanceof RoutingPolicyError);
    assert.ok(e.errors.length >= 5);
    assert.match(e.message, /Ungültige Routing-Policy/);
  }
});

test("Policy-Schema: unbekannte Provider/Tasks/Modi werden abgewiesen", () => {
  const broken = structuredClone(DEFAULT_ROUTING_POLICY) as unknown as Record<string, unknown>;
  broken.classes = {
    MODEL_A: { label: "local-small", deployment: "local", minParamsB: 3, maxParamsB: 8, providers: [{ provider: "mystery" }] },
    MODEL_B: { label: "local-medium", deployment: "local", minParamsB: 8, maxParamsB: 30, providers: [{ provider: "ollama" }] },
    MODEL_C: { label: "large", deployment: "any", minParamsB: 30, maxParamsB: 1000, providers: [{ provider: "gemini" }] },
  };
  broken.taskOverrides = { not_a_task: "MODEL_C" };
  broken.agents = { BAD: { mode: "super" } };
  broken.fallbackChains = { "sometimes:ollama": ["gemini"], default: ["nope"] };
  const result = validateRoutingPolicy(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("mystery")));
  assert.ok(result.errors.some((e) => e.includes("not_a_task")));
  assert.ok(result.errors.some((e) => e.includes("agents.BAD.mode")));
  assert.ok(result.errors.some((e) => e.includes("fallbackChains.sometimes:ollama")));
  assert.ok(result.errors.some((e) => e.includes("fallbackChains.default")));
});

test("Policy-Schema: loadRoutingPolicy liest Datei und verweigert bei Fehlern den Start", () => {
  const valid = JSON.stringify(DEFAULT_ROUTING_POLICY);
  const fromFile = loadRoutingPolicy(
    { ROUTING_POLICY_PATH: "/tmp/policy.json" },
    () => valid
  );
  assert.equal(fromFile.version, DEFAULT_ROUTING_POLICY.version);

  assert.throws(
    () => loadRoutingPolicy({ ROUTING_POLICY_PATH: "/tmp/broken.json" }, () => "{ not json"),
    RoutingPolicyError
  );
  const invalid = JSON.stringify({ ...DEFAULT_ROUTING_POLICY, version: 1 });
  assert.throws(
    () => loadRoutingPolicy({ ROUTING_POLICY_PATH: "/tmp/broken2.json" }, () => invalid),
    RoutingPolicyError
  );
  assert.throws(
    () => loadRoutingPolicy({ ROUTING_POLICY_PATH: "/tmp/missing.json" }, () => { throw new Error("ENOENT"); }),
    RoutingPolicyError
  );

  // Ohne Pfad: Default-Policy
  const fallback = loadRoutingPolicy({});
  assert.equal(fallback.version, DEFAULT_ROUTING_POLICY.version);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Kontext-Normalisierung (Whitelist)
// ─────────────────────────────────────────────────────────────────────────────

test("Kontext: Normalisierung erzwingt die 9 Inputs und verwirft Unfug", () => {
  const normalized = toRoutingContext({
    agent: "  research  ",
    task: "does-not-exist",
    complexity: "EXTREME",
    risk: "n/a",
    latencyRequirementMs: -5,
    tokenBudget: "viel",
    contextSize: Number.NaN,
    maxCostUsd: "0,5",
    confidence: 5,
    providerHealth: { ollama: "kaputt", gemini: "online" },
    requiredCapabilities: ["json", 42],
  });
  assert.equal(normalized.agent, "RESEARCH");
  assert.equal(normalized.task, "default");
  assert.equal(normalized.complexity, "low");
  assert.equal(normalized.risk, "low");
  assert.equal(normalized.latencyRequirementMs, 0);
  assert.equal(normalized.tokenBudget, 4096);
  assert.equal(normalized.contextSize, undefined);
  assert.equal(normalized.maxCostUsd, undefined);
  assert.equal(normalized.confidence, 1);
  assert.deepEqual(normalized.providerHealth, { gemini: "online" });
  assert.deepEqual(normalized.requiredCapabilities, ["json"]);
});

test("Router: Registry/Policy/Clock sind injizierbar; kein Netzwerk im Konstruktor", () => {
  const audit = new MemoryAuditSink();
  const registry = createFakeProviderRegistry();
  const router = new ModelRouter({
    policy: defaultRoutingPolicy(),
    registry,
    audit,
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    modesFile: null,
    autoStartPoller: false,
    env: {},
  });
  const decision = router.resolve(ctx({ agent: "CEO" }));
  assert.equal(decision.at, "2026-01-01T00:00:00.000Z");
  assert.equal(registry.refreshCount, 0, "Kein Health-Poll ohne Poller");
});

test("Router: Modi-Map aller Agenten ist vollständig und gültig", () => {
  const { router } = createTestRouter();
  const modes = router.getModes();
  for (const agent of Object.keys(DEFAULT_ROUTING_POLICY.agents)) {
    assert.ok(["manual", "automatic", "hybrid"].includes(modes[agent]), `Modus für ${agent}`);
    assert.equal(router.effectiveMode(agent), modes[agent]);
  }
  assert.equal(router.effectiveMode("UNBEKANNTER_AGENT"), DEFAULT_ROUTING_POLICY.defaultMode);
});

test("Router: classCeiling deckelt jede Klasse (auch bei critical/hohem Risiko)", () => {
  const { router } = createTestRouter({
    agents: { RESEARCH: { mode: "automatic", defaultClass: "MODEL_A", classCeiling: "MODEL_B", allowCloud: true } },
  });
  const decision = router.resolve(ctx({ agent: "RESEARCH", complexity: "critical", risk: "high" }));
  assert.equal(decision.modelClass, "MODEL_B");
  const classes: ModelClass[] = ["MODEL_A", "MODEL_B", "MODEL_C"];
  assert.ok(classes.indexOf(decision.modelClass) <= classes.indexOf("MODEL_B"));
});

test("Router: Modi-Datei wird nur bei Änderungen geschrieben (best-effort)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "routing-modes-"));
  const modesFile = path.join(dir, "modes.json");
  const router = new ModelRouter({
    policy: defaultRoutingPolicy(),
    registry: createFakeProviderRegistry(),
    audit: new MemoryAuditSink(),
    clock: { now: () => new Date("2026-08-28T00:00:00.000Z") },
    modesFile,
    autoStartPoller: false,
    env: {},
  });
  const result = router.setMode("CEO", "hybrid", "admin");
  assert.equal(result.ok, true);
  assert.equal(result.audit.length, 1);
  assert.equal(router.effectiveMode("CEO"), "hybrid");
  const again = router.setMode("CEO", "hybrid", "admin");
  assert.equal(again.audit.length, 0, "Wiederholte identische Änderung ist wirkungslos");
  assert.equal(existsSync(modesFile), true);
  rmSync(dir, { recursive: true, force: true });
});

test("Router: Modi-Map-Typen sind auf die drei Modi beschränkt", () => {
  const allowed: RoutingMode[] = ["manual", "automatic", "hybrid"];
  for (const mode of allowed) {
    const { router } = createTestRouter({ modes: { CEO: mode } });
    assert.equal(router.effectiveMode("CEO"), mode);
  }
});

test("Policy-Schema: jede Feldverletzung wird erkannt (vollständige Branch-Matrix)", () => {
  const mutations: Array<[string, (policy: RoutingPolicy) => void]> = [
    ["version fehlt", (p) => { delete (p as Record<string, unknown>).version; }],
    ["version Zahl", (p) => { (p as Record<string, unknown>).version = 1; }],
    ["version ohne SemVer", (p) => { p.version = "eins"; }],
    ["defaultMode fehlt", (p) => { delete (p as Record<string, unknown>).defaultMode; }],
    ["defaultClass fehlt", (p) => { delete (p as Record<string, unknown>).defaultClass; }],
    ["agents kein Objekt", (p) => { (p as Record<string, unknown>).agents = 5; }],
    ["agents leerer Schlüssel", (p) => { p.agents[""] = { mode: "automatic" }; }],
    ["agents Eintrag kein Objekt", (p) => { (p.agents as Record<string, unknown>).BAD = "hybrid"; }],
    ["agents mode ungültig", (p) => { p.agents.BAD = { mode: "schnell" as never }; }],
    ["agents defaultClass ungültig", (p) => { p.agents.BAD = { mode: "automatic", defaultClass: "MODEL_X" as never }; }],
    ["agents classCeiling ungültig", (p) => { p.agents.BAD = { mode: "automatic", classCeiling: "MODEL_Z" as never }; }],
    ["agents pinnedModel kein String", (p) => { p.agents.BAD = { mode: "manual", pinnedModel: 3 as never }; }],
    ["agents manual ohne Pin", (p) => { p.agents.BAD = { mode: "manual" }; }],
    ["agents allowCloud kein Boolean", (p) => { p.agents.BAD = { mode: "automatic", allowCloud: "ja" as never }; }],
    ["agents budgetExempt kein Boolean", (p) => { p.agents.BAD = { mode: "automatic", budgetExempt: 1 as never }; }],
    ["classes kein Objekt", (p) => { (p as Record<string, unknown>).classes = "x"; }],
    ["classes Klasse fehlt", (p) => { delete (p.classes as Record<string, unknown>).MODEL_B; }],
    ["classes deployment ungültig", (p) => { p.classes.MODEL_A.deployment = "cloud" as never; }],
    ["classes Parameter keine Zahl", (p) => { p.classes.MODEL_A.minParamsB = "viel" as never; }],
    ["classes min > max", (p) => { p.classes.MODEL_C.minParamsB = 500; p.classes.MODEL_C.maxParamsB = 10; }],
    ["classes providers leer", (p) => { p.classes.MODEL_A.providers = []; }],
    ["classes providers kein Array", (p) => { p.classes.MODEL_A.providers = "ollama" as never; }],
    ["classes Eintrag kein Objekt", (p) => { p.classes.MODEL_A.providers = ["ollama"] as never; }],
    ["classes Provider doppelt", (p) => { p.classes.MODEL_A.providers = [{ provider: "ollama" }, { provider: "ollama" }]; }],
    ["classes model kein String", (p) => { p.classes.MODEL_A.providers = [{ provider: "ollama", model: 7 as never }]; }],
    ["taskOverrides kein Objekt", (p) => { (p as Record<string, unknown>).taskOverrides = 1; }],
    ["complexityFloor fehlt", (p) => { delete (p.complexityFloor as Record<string, unknown>).high; }],
    ["complexityFloor ungültig", (p) => { p.complexityFloor.low = "MODEL_Q" as never; }],
    ["riskFloor kein Objekt", (p) => { (p as Record<string, unknown>).riskFloor = null; }],
    ["escalation kein Objekt", (p) => { (p as Record<string, unknown>).escalation = 1; }],
    ["escalation minComplexity ungültig", (p) => { p.escalation.minComplexity = "hoch" as never; }],
    ["escalation Schwelle > 1", (p) => { p.escalation.maxConfidenceToApprove = 3; }],
    ["escalation Floor > Deckel", (p) => { p.escalation.minConfidenceFloor = 0.9; p.escalation.maxConfidenceToApprove = 0.1; }],
    ["escalation Zielklassen leer", (p) => { p.escalation.allowedTargetClasses = []; }],
    ["escalation Zielklasse unbekannt", (p) => { p.escalation.allowedTargetClasses = ["MODEL_X" as never]; }],
    ["escalation Tageslimit negativ", (p) => { p.escalation.maxApprovedPerAgentPerDay = -1; }],
    ["escalation Trigger-Flag kein Boolean", (p) => { p.escalation.honorRuntimeTriggers = "ja" as never; }],
    ["budgets kein Objekt", (p) => { (p as Record<string, unknown>).budgets = 1; }],
    ["budgets global fehlt", (p) => { delete (p.budgets as Record<string, unknown>).global; }],
    ["budgets global Kosten ungültig", (p) => { p.budgets.global.costUsdPerDay = -2; }],
    ["budgets providers kein Objekt", (p) => { (p.budgets as Record<string, unknown>).providers = 1; }],
    ["budgets Provider unbekannt", (p) => { (p.budgets.providers as Record<string, unknown>).mystery = { tokensPerDay: 1, costUsdPerDay: 1 }; }],
    ["budgets Provider Tokens ungültig", (p) => { p.budgets.providers.ollama = { tokensPerDay: -5, costUsdPerDay: 0 }; }],
    ["budgets agents kein Objekt", (p) => { (p.budgets as Record<string, unknown>).agents = 1; }],
    ["budgets Agent Tokens ungültig", (p) => { (p.budgets.agents as Record<string, unknown>).CEO = { tokensPerDay: "viel" }; }],
    ["fallbackChains kein Objekt", (p) => { (p as Record<string, unknown>).fallbackChains = 1; }],
    ["fallbackChains keine Liste", (p) => { p.fallbackChains.default = "ollama" as never; }],
    ["fallbackChains Trigger unbekannt", (p) => { p.fallbackChains["maybe:ollama"] = ["gemini"]; }],
    ["fallbackChains Provider im Schlüssel unbekannt", (p) => { p.fallbackChains["offline:mystery"] = ["ollama"]; }],
    ["quotaMinPercent > 100", (p) => { p.quotaMinPercent = 500; }],
    ["healthPollerIntervalMs negativ", (p) => { p.healthPollerIntervalMs = -1; }],
    ["maxLatencyEmaMs negativ", (p) => { p.maxLatencyEmaMs = -1; }],
  ];

  for (const [label, mutate] of mutations) {
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    mutate(policy);
    const result = validateRoutingPolicy(policy);
    assert.equal(result.ok, false, `Muss abgelehnt werden: ${label}`);
    assert.ok(result.errors.length > 0, `Fehlerliste leer: ${label}`);
  }

  // Kein Objekt ⇒ sofortige Ablehnung
  assert.deepEqual(validateRoutingPolicy(null).errors, ["Policy muss ein Objekt sein."]);
  assert.equal(validateRoutingPolicy(42).ok, false);
});
