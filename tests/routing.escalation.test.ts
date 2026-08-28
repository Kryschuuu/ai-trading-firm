/**
 * Eskalationsfluss (Task 09).
 *
 *   Agent → MODEL_ESCALATION_REQUEST → Router → Policy → approved | denied
 *
 * Golden Test (Vorgabe): Research, kleines lokales Modell, Confidence 0.58,
 * Complexity HIGH ⇒ approved ⇒ großes Modell ⇒ (Test-Kontext) Confidence 0.87.
 * Gegenfall: Confidence 0.95 / LOW ⇒ denied (kein Modellwechsel, Audit).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestRouter, ctx } from "./fixtures/routingTestUtil";
import { DEFAULT_ROUTING_POLICY } from "../src/routing";
import type { RoutingPolicy } from "../src/routing/policy";

/** Research auf kleinem lokalen Modell (Startpunkt des Golden Tests). */
function researchOnSmallModel() {
  return createTestRouter({
    agents: { RESEARCH: { mode: "automatic", defaultClass: "MODEL_A", allowCloud: true } },
  });
}

test("Eskalation GOLDEN: Research/small + Confidence 0.58 + HIGH → approved → großes Modell", () => {
  const { router, audit } = researchOnSmallModel();

  const before = router.resolve(ctx({ agent: "RESEARCH", task: "default", complexity: "low" }));
  assert.equal(before.modelClass, "MODEL_A");
  assert.equal(before.decision, "MODEL_A");

  const outcome = router.requestEscalation({
    agent: "RESEARCH",
    task: "research",
    complexity: "high",
    confidence: 0.58,
    currentModel: before.model,
    currentClass: "MODEL_A",
    requestedClass: "MODEL_C",
    reason: "Für diese Aufgabe reicht Modell A nicht.",
  });

  assert.equal(outcome.approved, true, "Golden Case muss genehmigt werden");
  assert.equal(outcome.trigger, "APPROVED");
  assert.equal(outcome.decision?.modelClass, "MODEL_C");
  assert.equal(outcome.decision?.escalated, true);
  assert.equal(outcome.decision?.trigger, "ESCALATION_APPROVED");
  assert.equal(outcome.policyVersion, DEFAULT_ROUTING_POLICY.version);

  // Signatur wechselt von MODEL_A auf MODEL_C
  assert.match(outcome.from, /^MODEL_A:/);
  assert.match(outcome.to, /^MODEL_C:/);
  assert.notEqual(outcome.from, outcome.to);

  // Audit: genau ein Eintrag, vollständig
  const entry = audit.entries.at(-1);
  assert.equal(entry?.outcome, "approved");
  assert.equal(entry?.agent, "RESEARCH");
  assert.equal(entry?.trigger, "ESCALATION_APPROVED");
  assert.equal(entry?.detail?.confidence, 0.58);
  assert.equal(entry?.detail?.requestedClass, "MODEL_C");
  assert.equal(entry?.detail?.currentClass, "MODEL_A");
  assert.equal(entry?.detail?.agentReason, "Für diese Aufgabe reicht Modell A nicht.");
  assert.equal(entry?.policyVersion, DEFAULT_ROUTING_POLICY.version);

  // Der Router merkt sich die eskalierte Entscheidung
  assert.equal(router.lastDecisionFor("RESEARCH")?.modelClass, "MODEL_C");
});

test("Eskalation: denied bei Confidence 0.95 / LOW — kein Modellwechsel, aber Audit", () => {
  const { router, audit } = researchOnSmallModel();
  const before = router.resolve(ctx({ agent: "RESEARCH", complexity: "low" }));

  const outcome = router.requestEscalation({
    agent: "RESEARCH",
    complexity: "low",
    confidence: 0.95,
    currentClass: "MODEL_A",
    requestedClass: "MODEL_C",
    reason: "Agent ist sich sicher.",
  });

  assert.equal(outcome.approved, false);
  assert.equal(outcome.trigger, "COMPLEXITY_BELOW_THRESHOLD");
  assert.equal(outcome.from, outcome.to, "Ablehnung ändert nichts");

  const after = router.lastDecisionFor("RESEARCH");
  assert.equal(after?.model, before.model, "kein Modellwechsel");
  assert.equal(after?.modelClass, before.modelClass);

  const entry = audit.entries.at(-1);
  assert.equal(entry?.outcome, "denied");
  assert.equal(entry?.from, entry?.to);
  assert.equal(entry?.trigger, "COMPLEXITY_BELOW_THRESHOLD");
});

test("Eskalation: Confidence 0.95 bei hoher Komplexität → denied (CONFIDENCE_ABOVE_THRESHOLD)", () => {
  const { router } = researchOnSmallModel();
  const outcome = router.requestEscalation({
    agent: "RESEARCH",
    complexity: "high",
    confidence: 0.95,
    currentClass: "MODEL_A",
    requestedClass: "MODEL_C",
    reason: "trotzdem",
  });
  assert.equal(outcome.approved, false);
  assert.equal(outcome.trigger, "CONFIDENCE_ABOVE_THRESHOLD");
});

test("Eskalation: Schwelle 0.75 ist exklusiv (0.75 approved, 0.76 denied)", () => {
  const a = researchOnSmallModel().router.requestEscalation({
    agent: "RESEARCH",
    complexity: "high",
    confidence: 0.75,
    currentClass: "MODEL_A",
    requestedClass: "MODEL_C",
    reason: "grenzwert",
  });
  const b = researchOnSmallModel().router.requestEscalation({
    agent: "RESEARCH",
    complexity: "high",
    confidence: 0.76,
    currentClass: "MODEL_A",
    requestedClass: "MODEL_C",
    reason: "grenzwert",
  });
  assert.equal(a.approved, true);
  assert.equal(b.approved, false);
});

test("Eskalation: keine Höherstufung beantragt → denied (REQUESTED_CLASS_NOT_HIGHER)", () => {
  const { router } = researchOnSmallModel();
  const same = router.requestEscalation({
    agent: "RESEARCH",
    complexity: "high",
    confidence: 0.4,
    currentClass: "MODEL_C",
    requestedClass: "MODEL_C",
    reason: "gleich",
  });
  const lower = router.requestEscalation({
    agent: "RESEARCH",
    complexity: "high",
    confidence: 0.4,
    currentClass: "MODEL_C",
    requestedClass: "MODEL_A",
    reason: "tiefer",
  });
  assert.equal(same.approved, false);
  assert.equal(same.trigger, "REQUESTED_CLASS_NOT_HIGHER");
  assert.equal(lower.approved, false);
  assert.equal(lower.trigger, "REQUESTED_CLASS_NOT_HIGHER");
});

test("Eskalation: hybrid-Modus hält die Klassengrenze (HYBRID_CLASS_BOUND)", () => {
  const { router } = createTestRouter({
    agents: { RESEARCH: { mode: "hybrid", defaultClass: "MODEL_B", allowCloud: true } },
  });
  const outcome = router.requestEscalation({
    agent: "RESEARCH",
    complexity: "critical",
    confidence: 0.2,
    currentClass: "MODEL_B",
    requestedClass: "MODEL_C",
    reason: "Regimebruch",
  });
  assert.equal(outcome.approved, false);
  assert.equal(outcome.trigger, "HYBRID_CLASS_BOUND");
});

test("Eskalation: Agenten-Deckel classCeiling blockt die Zielklasse (CLASS_NOT_ALLOWED)", () => {
  const { router } = createTestRouter({
    agents: { RESEARCH: { mode: "automatic", defaultClass: "MODEL_A", classCeiling: "MODEL_B", allowCloud: true } },
  });
  const outcome = router.requestEscalation({
    agent: "RESEARCH",
    complexity: "high",
    confidence: 0.3,
    currentClass: "MODEL_A",
    requestedClass: "MODEL_C",
    reason: "bitte groß",
  });
  assert.equal(outcome.approved, false);
  assert.equal(outcome.trigger, "CLASS_NOT_ALLOWED");
});

test("Eskalation: Runtime-Trigger (Token-Überschuss/Latenz) ersetzen die Komplexitäts-Schwelle", () => {
  const { router } = researchOnSmallModel();
  const byTokens = router.requestEscalation({
    agent: "RESEARCH",
    complexity: "low",
    confidence: 0.6,
    currentClass: "MODEL_A",
    requestedClass: "MODEL_C",
    tokenOvershoot: true,
    reason: "Kontextfenster gerissen",
  });
  assert.equal(byTokens.approved, true);

  const { router: r2 } = researchOnSmallModel();
  const byLatency = r2.requestEscalation({
    agent: "RESEARCH",
    complexity: "medium",
    confidence: 0.6,
    currentClass: "MODEL_A",
    requestedClass: "MODEL_C",
    latencyViolation: true,
    reason: "Latenzbudget verletzt",
  });
  assert.equal(byLatency.approved, true);
});

test("Eskalation: Tageslimit (12) wird hart durchgesetzt", () => {
  const { router, audit } = researchOnSmallModel();
  for (let i = 0; i < 12; i++) {
    const outcome = router.requestEscalation({
      agent: "RESEARCH",
      complexity: "high",
      confidence: 0.4,
      currentClass: "MODEL_A",
      requestedClass: "MODEL_C",
      reason: `Lauf ${i}`,
    });
    assert.equal(outcome.approved, true, `Lauf ${i} muss genehmigt werden`);
  }
  const blocked = router.requestEscalation({
    agent: "RESEARCH",
    complexity: "high",
    confidence: 0.4,
    currentClass: "MODEL_A",
    requestedClass: "MODEL_C",
    reason: "13. Antrag",
  });
  assert.equal(blocked.approved, false);
  assert.equal(blocked.trigger, "DAILY_LIMIT_REACHED");
  assert.equal(audit.entries.filter((e) => e.outcome === "approved").length, 12);
  assert.equal(audit.entries.filter((e) => e.outcome === "denied").length, 1);
});

test("Eskalation: erschöpftes Budget der Zielklasse → denied (BUDGET_EXCEEDED)", () => {
  const budgets: RoutingPolicy["budgets"] = {
    providers: {
      ollama: { tokensPerDay: 100, costUsdPerDay: 0 },
      openai: { tokensPerDay: 100, costUsdPerDay: 0 },
      gemini: { tokensPerDay: 100, costUsdPerDay: 1 },
      anthropic: { tokensPerDay: 100, costUsdPerDay: 1 },
    },
    agents: {},
    global: { tokensPerDay: 1000, costUsdPerDay: 5 },
  };
  const { router, audit } = createTestRouter({
    agents: { RESEARCH: { mode: "automatic", defaultClass: "MODEL_A", allowCloud: true } },
    policy: { budgets },
  });
  for (const provider of ["ollama", "openai", "gemini", "anthropic"] as const) {
    router.budget.consume({ provider, tokens: 500 });
  }
  const outcome = router.requestEscalation({
    agent: "RESEARCH",
    complexity: "high",
    confidence: 0.3,
    currentClass: "MODEL_A",
    requestedClass: "MODEL_C",
    reason: "groß wäre gut",
  });
  assert.equal(outcome.approved, false);
  assert.equal(outcome.trigger, "BUDGET_EXCEEDED");
  assert.equal(audit.entries.at(-1)?.outcome, "denied");
});

test("Eskalation: kein gesunder Provider → denied (NO_HEALTHY_PROVIDER)", () => {
  const { router, registry } = researchOnSmallModel();
  for (const id of ["ollama", "openai", "gemini", "anthropic"] as const) {
    registry.setHealth(id, "offline");
  }
  const outcome = router.requestEscalation({
    agent: "RESEARCH",
    complexity: "high",
    confidence: 0.2,
    currentClass: "MODEL_A",
    requestedClass: "MODEL_C",
    reason: "alle down",
  });
  assert.equal(outcome.approved, false);
  assert.equal(outcome.trigger, "NO_HEALTHY_PROVIDER");
});

test("Eskalation: unvollständiger/fehlerhafter Antrag wird sicher abgelehnt", () => {
  const { router, audit } = researchOnSmallModel();
  const garbage = router.requestEscalation({ agent: "RESEARCH", complexity: "ultra", confidence: "hoch" });
  assert.equal(garbage.approved, false);
  assert.equal(garbage.trigger, "COMPLEXITY_BELOW_THRESHOLD");
  assert.equal(audit.entries.at(-1)?.outcome, "denied");

  const nothing = router.requestEscalation(undefined);
  assert.equal(nothing.approved, false);
  assert.equal(nothing.audit.agent, "UNKNOWN");
});

test("Eskalation: JEDER Antrag (approved und denied) erzeugt genau einen Audit-Eintrag", () => {
  const { router, audit } = researchOnSmallModel();
  const requests = [
    { complexity: "high", confidence: 0.58, currentClass: "MODEL_A", requestedClass: "MODEL_C" },
    { complexity: "low", confidence: 0.95, currentClass: "MODEL_A", requestedClass: "MODEL_C" },
    { complexity: "high", confidence: 0.95, currentClass: "MODEL_A", requestedClass: "MODEL_C" },
    { complexity: "critical", confidence: 0.1, currentClass: "MODEL_C", requestedClass: "MODEL_C" },
  ] as const;
  const before = audit.entries.length;
  for (const r of requests) {
    router.requestEscalation({ agent: "RESEARCH", reason: "test", ...r });
  }
  assert.equal(audit.entries.length - before, requests.length);
  assert.deepEqual(
    audit.entries.slice(before).map((e) => e.outcome),
    ["approved", "denied", "denied", "denied"]
  );
  for (const entry of audit.entries.slice(before)) {
    assert.ok(entry.ts.length > 0);
    assert.equal(entry.agent, "RESEARCH");
    assert.ok(entry.from.length > 0 && entry.to.length > 0);
    assert.ok(entry.reason.length > 0);
    assert.ok(entry.trigger.length > 0);
    assert.equal(entry.policyVersion, DEFAULT_ROUTING_POLICY.version);
  }
});
