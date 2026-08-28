/**
 * API-Contract des Model Routers (Task 09).
 *
 *   GET  /api/providers        — Karten-Daten (Status, Model, Context, Latency,
 *                                Cost, Tokens %) für das Operations Center
 *   GET  /api/routing          — Policy, Modi, Provider, Budget, Audit
 *   GET  /api/routing/modes    — Modi je Agent
 *   PUT  /api/routing/modes    — nur Admin (Token + CSRF), auditiert
 *
 * Alle Antworten werden zusätzlich auf Secret-Muster gescannt.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  getModelRouter,
  resetModelRouterForTests,
  setModelRouterForTests,
  type ModelRouter,
} from "../src/routing";
import { createTestRouter, type TestRouter } from "./fixtures/routingTestUtil";
import { scanTextForSecrets } from "../src/brokers/control-plane/secretScan";

type Handler = (req: Request) => Promise<Response>;

let GET_PROVIDERS: Handler;
let GET_ROUTING: Handler;
let GET_MODES: Handler;
let PUT_MODES: Handler;

const VALID_ADMIN = "adm-test-token-0123456789";

before(async () => {
  ({ GET: GET_PROVIDERS } = await import("../src/app/api/providers/route"));
  ({ GET: GET_ROUTING } = await import("../src/app/api/routing/route"));
  ({ GET: GET_MODES, PUT: PUT_MODES } = await import("../src/app/api/routing/modes/route"));
});

let router: ModelRouter;
let env: TestRouter;

beforeEach(() => {
  delete process.env.FIRM_ADMIN_TOKEN;
  delete process.env.FIRM_API_TOKEN;
  env = createTestRouter();
  router = setModelRouterForTests(env.router);
});

after(() => {
  resetModelRouterForTests();
});

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/providers
// ─────────────────────────────────────────────────────────────────────────────

test("API: GET /api/providers liefert Karten-Daten aller vier Provider", async () => {
  const res = await GET_PROVIDERS(new Request("http://localhost/api/providers"));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.ok, true);
  assert.equal(body.count, 4);

  const providers = body.providers as Array<Record<string, unknown>>;
  assert.deepEqual(
    providers.map((p) => p.id),
    ["ollama", "openai", "gemini", "anthropic"]
  );

  for (const card of providers) {
    assert.equal(card.status, "ONLINE");
    assert.equal(typeof card.model, "string");
    assert.ok(Number.isFinite(card.contextSize));
    assert.ok(Number.isFinite(card.latencyMs));
    assert.ok(Number.isFinite(card.costPer1kIn));
    assert.ok(Number.isFinite(card.costPer1kOut));
    assert.ok(Number.isFinite(card.costPerMTokIn));
    const tokens = card.tokens as Record<string, number>;
    assert.ok(Number.isFinite(tokens.used));
    assert.ok(Number.isFinite(tokens.budget));
    assert.ok(Number.isFinite(tokens.percent));
    assert.ok(Number.isFinite(card.quotaRestPercent));
    assert.ok(Array.isArray(card.classes));
    assert.ok(Array.isArray(card.models));
    assert.ok(Array.isArray(card.capabilities));
  }

  // Ollama-Karte: lokal, kostenlos
  const ollama = providers[0];
  assert.equal(ollama.deployment, "local");
  assert.equal(ollama.costPer1kIn, 0);
  assert.equal(ollama.costPer1kOut, 0);
  const gemini = providers.find((p) => p.id === "gemini");
  assert.equal(gemini?.deployment, "cloud");
  assert.ok((gemini?.costPer1kIn as number) > 0);

  // Routing-Block
  const routing = body.routing as Record<string, unknown>;
  assert.equal(routing.policyVersion, router.policy.version);
  assert.ok(routing.modes);
  assert.ok(routing.globalBudget);
  assert.ok(Array.isArray(body.audit));

  // Kein Secret in der Antwort
  const findings = scanTextForSecrets(JSON.stringify(body));
  assert.deepEqual(findings, []);
});

test("API: GET /api/providers spiegelt Health, Quota und Token-Verbrauch", async () => {
  env.registry.setHealth("gemini", "offline");
  env.registry.setQuota("anthropic", 3);
  router.consumeUsage({ provider: "ollama", agent: "CEO", tokens: 1_250_000 });

  const body = await json(await GET_PROVIDERS(new Request("http://localhost/api/providers")));
  const providers = body.providers as Array<Record<string, unknown>>;
  const byId = new Map(providers.map((p) => [String(p.id), p]));

  assert.equal(byId.get("gemini")?.status, "OFFLINE");
  assert.equal(byId.get("anthropic")?.quotaRestPercent, 3);
  const ollamaTokens = byId.get("ollama")?.tokens as Record<string, number>;
  assert.equal(ollamaTokens.used, 1_250_000);
  assert.equal(ollamaTokens.percent, 25);
});

test("API: GET /api/providers?refresh=1 löst eine Health-Prüfung aus", async () => {
  const res = await GET_PROVIDERS(new Request("http://localhost/api/providers?refresh=1"));
  assert.equal(res.status, 200);
  assert.equal(env.registry.refreshCount, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/routing
// ─────────────────────────────────────────────────────────────────────────────

test("API: GET /api/routing liefert Policy, Modi, Provider, Budget und Audit", async () => {
  router.resolve({ agent: "CEO", task: "strategy_development", complexity: "high" });
  const body = await json(await GET_ROUTING(new Request("http://localhost/api/routing")));
  assert.equal(body.ok, true);
  assert.equal(body.policyVersion, "1.0.0");

  const policy = body.policy as Record<string, unknown>;
  assert.ok(policy.classes);
  assert.ok(policy.escalation);
  assert.ok(policy.budgets);
  assert.ok(policy.fallbackChains);
  assert.ok(policy.agents);

  const agents = policy.agents as Record<string, { mode: string; defaultClass?: string }>;
  assert.equal(agents.RESEARCH.defaultClass, "MODEL_C");
  assert.equal(agents.TECHNICAL.defaultClass, "MODEL_A");
  assert.equal(agents.NEWS.defaultClass, "MODEL_A");
  assert.equal(agents.RISK.defaultClass, "MODEL_B");
  assert.equal(agents.PORTFOLIO.defaultClass, "MODEL_B");
  assert.equal(agents.CEO.mode, "automatic");

  assert.ok((body.modes as Record<string, string>).CEO);
  assert.equal((body.providers as unknown[]).length, 4);
  assert.ok((body.budget as Record<string, unknown>).global);
  assert.ok(((body.audit as unknown[]) ?? []).length >= 1);
  assert.ok((body.lastDecisions as Record<string, unknown>).CEO);
  assert.deepEqual(scanTextForSecrets(JSON.stringify(body)), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET/PUT /api/routing/modes
// ─────────────────────────────────────────────────────────────────────────────

test("API: GET /api/routing/modes liefert Modi und erlaubte Werte", async () => {
  const body = await json(await GET_MODES(new Request("http://localhost/api/routing/modes")));
  assert.equal(body.ok, true);
  assert.deepEqual(body.allowedModes, ["manual", "automatic", "hybrid"]);
  assert.equal((body.modes as Record<string, string>).RESEARCH, "automatic");
  assert.equal((body.effective as Record<string, string>).RESEARCH, "automatic");
});

test("API: PUT /api/routing/modes ist ohne Admin-Token verboten (403)", async () => {
  process.env.FIRM_ADMIN_TOKEN = VALID_ADMIN;
  const res = await PUT_MODES(
    new Request("http://localhost/api/routing/modes", {
      method: "PUT",
      body: JSON.stringify({ modes: { RESEARCH: "hybrid" } }),
      headers: { "content-type": "application/json" },
    })
  );
  assert.equal(res.status, 403);
  const body = await json(res);
  assert.equal(body.error, "FORBIDDEN");
  assert.equal(router.effectiveMode("RESEARCH"), "automatic", "keine Änderung ohne Admin");
});

test("API: PUT /api/routing/modes verlangt CSRF (403 CSRF_INVALID)", async () => {
  process.env.FIRM_ADMIN_TOKEN = VALID_ADMIN;
  const res = await PUT_MODES(
    new Request("http://localhost/api/routing/modes", {
      method: "PUT",
      body: JSON.stringify({ modes: { RESEARCH: "hybrid" } }),
      headers: { "content-type": "application/json", "x-admin-token": VALID_ADMIN },
    })
  );
  assert.equal(res.status, 403);
  assert.equal((await json(res)).error, "CSRF_INVALID");
});

test("API: PUT /api/routing/modes ändert mit Admin+CSRF und auditiert", async () => {
  process.env.FIRM_ADMIN_TOKEN = VALID_ADMIN;
  const res = await PUT_MODES(
    new Request("http://localhost/api/routing/modes", {
      method: "PUT",
      body: JSON.stringify({ modes: { RESEARCH: "hybrid" }, actor: "ops@example" }),
      headers: {
        "content-type": "application/json",
        "x-admin-token": VALID_ADMIN,
        "x-csrf-token": VALID_ADMIN,
      },
    })
  );
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.ok, true);
  assert.equal((body.modes as Record<string, string>).RESEARCH, "hybrid");
  assert.equal(router.effectiveMode("RESEARCH"), "hybrid");

  const audit = body.audit as Array<Record<string, unknown>>;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].outcome, "admin");
  assert.equal(audit[0].from, "mode:automatic");
  assert.equal(audit[0].to, "mode:hybrid");
  assert.equal((audit[0].detail as Record<string, unknown>).actor, "ops@example");
});

test("API: PUT /api/routing/modes weist unbekannte Modi mit 422 ab", async () => {
  process.env.FIRM_ADMIN_TOKEN = VALID_ADMIN;
  const res = await PUT_MODES(
    new Request("http://localhost/api/routing/modes", {
      method: "PUT",
      body: JSON.stringify({ modes: { RESEARCH: "turbo" } }),
      headers: {
        "content-type": "application/json",
        "x-admin-token": VALID_ADMIN,
        "x-csrf-token": VALID_ADMIN,
      },
    })
  );
  assert.equal(res.status, 422);
  const body = await json(res);
  assert.equal(body.error, "INVALID_MODES");
  assert.ok((body.errors as string[]).length === 1);
  assert.equal(router.effectiveMode("RESEARCH"), "automatic");
});

test("API: PUT /api/routing/modes mit kaputtem Body → 400 INVALID_BODY", async () => {
  process.env.FIRM_ADMIN_TOKEN = VALID_ADMIN;
  const headers = { "content-type": "application/json", "x-admin-token": VALID_ADMIN, "x-csrf-token": VALID_ADMIN };

  const broken = await PUT_MODES(
    new Request("http://localhost/api/routing/modes", { method: "PUT", body: "{ no json", headers })
  );
  assert.equal(broken.status, 400);

  const empty = await PUT_MODES(
    new Request("http://localhost/api/routing/modes", { method: "PUT", body: JSON.stringify({}), headers })
  );
  assert.equal(empty.status, 400);
  assert.equal((await json(empty)).error, "INVALID_BODY");
});

test("API: Off-Betrieb (kein Token gesetzt) erlaubt die Admin-Änderung weiterhin auditiert", async () => {
  delete process.env.FIRM_ADMIN_TOKEN;
  delete process.env.FIRM_API_TOKEN;
  const res = await PUT_MODES(
    new Request("http://localhost/api/routing/modes", {
      method: "PUT",
      body: JSON.stringify({ NEWS_ANALYST: "manual" }),
      headers: { "content-type": "application/json", "x-csrf-token": "local" },
    })
  );
  assert.equal(res.status, 200);
  assert.equal(router.effectiveMode("NEWS_ANALYST"), "manual");
  assert.equal(((await json(res)).audit as unknown[]).length, 1);
});

test("API: Router-Singleton ist pro Prozess stabil (getModelRouter)", () => {
  const same = getModelRouter();
  assert.equal(same, router);
});
