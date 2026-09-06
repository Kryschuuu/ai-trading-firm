/**
 * SEC-05 (MEDIUM) — Fälschbare Akteurs-/Rollenattribution bei Rule-Änderungen.
 *
 * Angriff vor dem Fix: Ein Aufrufer mit `firm.write` (Operator) schickt
 * `{"action":"activate","by":"ADMIN"}` an `POST /api/firm/rules/[id]` bzw.
 * `{"sourceRole":"CEO", ...}` an `POST /api/firm/rules`. Beide Werte landeten
 * unverändert im Audit-Trail — der forensische Nachweis, wer eine
 * Strategieänderung ausgelöst hat, war fälschbar.
 *
 * Nach dem Fix:
 *   - Attributionsfelder (`by`, `actor`, `sourceRole`) sind kein Teil des
 *     API-Vertrags mehr und werden mit 400 abgelehnt (fail-closed) — vor jedem
 *     DB-Zugriff, also ohne Datenbank testbar.
 *   - Die Attribution stammt ausschliesslich aus `resolveAuth`/`actorAuditId`.
 *   - `sourceRole` ist nicht client-steuerbar (auch nicht verschachtelt in
 *     `rule` oder als Prototype-Pollution-Versuch).
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sanitizeRuleSpec } from "../src/lib/ruleEngine";
import {
  API_RULE_SOURCE_ROLE,
  CLIENT_FORBIDDEN_ACTOR_FIELDS,
  rejectClientActorFields,
  ruleActor,
} from "../src/lib/ruleActor";

type PostHandler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type CollectionPostHandler = (req: Request) => Promise<Response>;

const ADMIN_TOKEN = "sec05-admin-token-0123456789";
const OPERATOR_TOKEN = "sec05-operator-token-0123456789";
const AUTH_KEYS = ["FIRM_ADMIN_TOKEN", "FIRM_API_TOKEN", "FIRM_VIEWER_TOKEN", "AUTH_MODE", "FIRM_RATE_LIMIT"] as const;
const savedEnv = new Map<string, string | undefined>();

let postRuleAction: PostHandler;
let postRule: CollectionPostHandler;

before(async () => {
  postRuleAction = (await import("../src/app/api/firm/rules/[id]/route")).POST as unknown as PostHandler;
  postRule = (await import("../src/app/api/firm/rules/route")).POST as CollectionPostHandler;
  for (const key of AUTH_KEYS) savedEnv.set(key, process.env[key]);
});

beforeEach(() => {
  for (const key of AUTH_KEYS) delete process.env[key];
  process.env.FIRM_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.FIRM_API_TOKEN = OPERATOR_TOKEN;
  // Rate-Limit aus: die Tests feuern viele Schreib-Requests aus derselben
  // (nicht auflösbaren) Client-Identität.
  process.env.FIRM_RATE_LIMIT = "0";
});

after(() => {
  for (const key of AUTH_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function operatorRequest(body: unknown): Request {
  return new Request("https://trading.example.test/api/firm/rules/rule-1", {
    method: "POST",
    headers: { "content-type": "application/json", "x-firm-token": OPERATOR_TOKEN },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ id: "rule-1" });

// ── Angriffsvektor 1: gefälschtes `by` bei Lifecycle-Aktionen ───────────────

for (const action of ["activate", "pause", "archive", "rollback", "reject"] as const) {
  test(`SEC-05: Operator kann bei action=${action} kein fremdes 'by' setzen`, async () => {
    const res = await postRuleAction(operatorRequest({ action, by: "ADMIN" }), { params });
    assert.equal(res.status, 400, "gefälschte Attribution muss abgelehnt werden");
    const body = (await res.json()) as { ok: boolean; error: string; hint?: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, "ACTOR_NOT_CLIENT_CONTROLLED");
    assert.ok(body.hint?.includes("by"), "Hinweis muss das verbotene Feld nennen");
  });
}

test("SEC-05: auch 'actor' und 'sourceRole' im Lifecycle-Body werden abgelehnt", async () => {
  for (const field of ["actor", "sourceRole"]) {
    const res = await postRuleAction(
      operatorRequest({ action: "activate", [field]: "CEO" }),
      { params }
    );
    assert.equal(res.status, 400, `${field} muss abgelehnt werden`);
  }
});

test("SEC-05: Ablehnung greift vor jedem DB-Zugriff (kein 500, kein Regel-Lookup)", async () => {
  // Ohne erreichbare Datenbank würde ein Lookup 500 liefern. 400 beweist:
  // der Guard läuft davor.
  const res = await postRuleAction(operatorRequest({ action: "activate", by: "ADMIN" }), { params });
  assert.equal(res.status, 400);
});

test("SEC-05: unauthentifizierter Request wird weiterhin vor allem anderen abgewiesen", async () => {
  const res = await postRuleAction(
    new Request("https://trading.example.test/api/firm/rules/rule-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "activate", by: "ADMIN" }),
    }),
    { params }
  );
  assert.equal(res.status, 401);
});

// ── Angriffsvektor 2: client-gesteuerte sourceRole beim Anlegen ─────────────

test("SEC-05: POST /api/firm/rules lehnt sourceRole auf Top-Level ab", async () => {
  const res = await postRule(
    new Request("https://trading.example.test/api/firm/rules", {
      method: "POST",
      headers: { "content-type": "application/json", "x-firm-token": OPERATOR_TOKEN },
      body: JSON.stringify({ sourceRole: "CEO", rule: { symbol: "BTC-USD" } }),
    })
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "ACTOR_NOT_CLIENT_CONTROLLED");
});

test("SEC-05: POST /api/firm/rules lehnt sourceRole auch verschachtelt in 'rule' ab", async () => {
  const res = await postRule(
    new Request("https://trading.example.test/api/firm/rules", {
      method: "POST",
      headers: { "content-type": "application/json", "x-firm-token": OPERATOR_TOKEN },
      body: JSON.stringify({ rule: { symbol: "BTC-USD", sourceRole: "CEO" } }),
    })
  );
  assert.equal(res.status, 400);
});

test("SEC-05: sanitizeRuleSpec erzwingt die Rolle bei forceSourceRole", () => {
  const spec = {
    symbol: "BTC-USD",
    sourceRole: "CEO",
    condition: { logic: "all", conditions: [{ field: "rsi14", op: "lt", value: 30 }] },
    action: { side: "LONG", sizePct: 1, stopLossPct: 1, takeProfitPct: 2 },
    window: { timeframe: "1h", lookback: 50 },
  };
  const forced = sanitizeRuleSpec(spec, API_RULE_SOURCE_ROLE, { forceSourceRole: true });
  assert.equal(forced.ok, true);
  if (forced.ok) assert.equal(forced.spec.sourceRole, "MANUAL");

  // Interne Erzeuger (Makro-Zyklus) behalten das bisherige Verhalten.
  const internal = sanitizeRuleSpec(spec, "RESEARCH");
  assert.equal(internal.ok, true);
  if (internal.ok) assert.equal(internal.spec.sourceRole, "CEO");
});

// ── Attribution kommt aus dem Credential ────────────────────────────────────

test("SEC-05: ruleActor leitet die Attribution aus dem Credential ab", () => {
  const asOperator = new Request("https://trading.example.test/api/firm/rules/rule-1", {
    method: "POST",
    headers: { "x-firm-token": OPERATOR_TOKEN },
  });
  assert.equal(ruleActor(asOperator), "operator");

  const asAdmin = new Request("https://trading.example.test/api/firm/rules/rule-1", {
    method: "POST",
    headers: { "x-admin-token": ADMIN_TOKEN },
  });
  assert.equal(ruleActor(asAdmin), "admin");
});

test("SEC-05: ruleActor ignoriert einen im Body behaupteten Akteur vollständig", () => {
  // Selbst wenn ein Body-Feld durchrutschte: die Funktion liest nur Header/Session.
  const req = new Request("https://trading.example.test/api/firm/rules/rule-1", {
    method: "POST",
    headers: { "x-firm-token": OPERATOR_TOKEN, "x-actor": "ADMIN" },
    body: JSON.stringify({ by: "ADMIN" }),
  });
  assert.equal(ruleActor(req), "operator");
});

// ── Guard-Einheitstests inkl. Prototype-Pollution ───────────────────────────

test("SEC-05: rejectClientActorFields — sauberer Body passiert", () => {
  assert.equal(rejectClientActorFields({ action: "activate", reason: "ok" }), null);
  assert.equal(rejectClientActorFields(undefined), null);
  assert.equal(rejectClientActorFields(null), null);
  assert.equal(rejectClientActorFields("by"), null);
  assert.equal(rejectClientActorFields([{ by: "ADMIN" }]), null);
});

test("SEC-05: rejectClientActorFields — geerbte Felder lösen keinen Fehlalarm aus", () => {
  const polluted = JSON.parse('{"__proto__":{"by":"ADMIN"},"action":"activate"}') as Record<string, unknown>;
  assert.equal(rejectClientActorFields(polluted), null);
  // Und die Pollution hat den Prototyp nicht verändert.
  assert.equal(({} as Record<string, unknown>).by, undefined);
});

test("SEC-05: jedes verbotene Feld wird erkannt", async () => {
  for (const field of CLIENT_FORBIDDEN_ACTOR_FIELDS) {
    const res = rejectClientActorFields({ [field]: "ADMIN" });
    assert.ok(res, `${field} muss abgelehnt werden`);
    assert.equal(res.status, 400);
  }
});

// ── Drift-Schutz auf Quellebene ─────────────────────────────────────────────

test("SEC-05: Routen leiten 'by' nicht mehr aus dem Request-Body ab", () => {
  const sources = [
    "src/app/api/firm/rules/[id]/route.ts",
    "src/app/api/firm/rules/route.ts",
  ];
  for (const rel of sources) {
    const src = readFileSync(resolve(process.cwd(), rel), "utf8");
    assert.ok(!/body\.by/.test(src), `${rel}: darf 'body.by' nicht mehr lesen`);
    assert.ok(!/body\.sourceRole/.test(src), `${rel}: darf 'body.sourceRole' nicht mehr lesen`);
    assert.ok(src.includes("rejectClientActorFields"), `${rel}: muss den SEC-05-Guard aufrufen`);
    assert.ok(src.includes("ruleActor"), `${rel}: muss die serverseitige Attribution nutzen`);
  }
});
