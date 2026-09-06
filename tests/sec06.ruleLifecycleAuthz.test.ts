/**
 * SEC-06 + SEC-05-Nachprüfung: echte HTTP-Handler und echter Rule-Service.
 * Nur die DB/Audit-Transporte werden an den vorhandenen Test-Hooks ersetzt.
 * Verweigerte Requests dürfen weder lesen noch schreiben; erlaubte Requests
 * müssen die richtige Mutation UND den serverseitigen Audit-Akteur liefern.
 * Keine PostgreSQL-/LLM-/Broker-Verbindung und keine optionalen/skipped Tests.
 */
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERMISSIONS, permissionsForRole, resolveAuth, type Role } from "../src/auth";
import { tradeRules } from "../src/db/schema";
import { resetRateLimiterForTests } from "../src/lib/apiAuth";
import { resetAuditDurabilityForTests, setAuditTransportForTests, type AuditRow } from "../src/lib/auditSink";
import { describeAuditEntry } from "../src/lib/auditView";
import { issueSession, SESSION_COOKIE } from "../src/lib/authSession";
import { ruleActor } from "../src/lib/ruleActor";
import { ruleSignature, sanitizeRuleSpec } from "../src/lib/ruleEngine";
import type { RuleRow } from "../src/lib/ruleService";

const TOKENS = {
  admin: "sec06-admin-token-0123456789",
  operator: "sec06-operator-token-0123456789",
  viewer: "sec06-viewer-token-0123456789",
};
const AUTH_KEYS = [
  "AUTH_MODE", "FIRM_ADMIN_TOKEN", "FIRM_API_TOKEN", "FIRM_VIEWER_TOKEN",
  "FIRM_SESSION_SECRET", "FIRM_RATE_LIMIT", "REQUIRE_HUMAN_APPROVAL", "AUDIT_SPOOL_DIR",
] as const;
const savedEnv = new Map<string, string | undefined>();
const G = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlDb?: unknown;
  __macroBusy?: boolean;
};
let previousDb: unknown;
let previousMacroBusy: boolean | undefined;
let spoolDir: string;
let audits: AuditRow[];

const SPEC = {
  name: "Security regression rule",
  symbol: "BTC-USD",
  condition: { logic: "all", conditions: [{ field: "rsi14", op: "lt", value: 30 }] },
  action: { side: "LONG", stopLossPct: 5, takeProfitRR: 1.5, riskBudgetPct: 0.01, maxPositionPct: 0.1 },
  window: { timeframe: "15m", maxExecutionsPerDay: 2, cooldownMinutes: 120 },
};

function row(status = "DRAFT", overrides: Partial<RuleRow> = {}): RuleRow {
  return {
    ...SPEC,
    id: "00000000-0000-4000-8000-000000000002",
    ruleKey: "00000000-0000-4000-8000-000000000003",
    version: 2,
    status,
    missionId: null,
    signature: "test-signature",
    rationale: null,
    sourceRole: "MANUAL",
    sourceAgentId: null,
    sourceMode: "MANUAL",
    riskScore: "0.5",
    previousVersionId: "00000000-0000-4000-8000-000000000001",
    supersededById: null,
    activatedAt: null,
    deactivatedAt: null,
    createdAt: new Date("2026-09-06T00:00:00Z"),
    updatedAt: new Date("2026-09-06T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Scripted DB-Port (wie tests/auditReliability.test.ts). Jede Abfrage wird
 * gezählt; unerwartete Zugriffe werfen, statt unbemerkt als Erfolg zu gelten.
 * Autorisierung, Validierung, Transitionslogik und Audit laufen ungemockt.
 */
class RuleDb {
  reads: RuleRow[][] = [];
  updateRows: RuleRow[] = [];
  calls = 0;
  writes: Array<{ kind: "insert" | "update"; values: Record<string, unknown> }> = [];
  failure: Error | null = null;

  touch() {
    this.calls++;
    if (this.failure) throw this.failure;
  }

  select() {
    this.touch();
    const rows = this.reads.shift();
    assert.ok(rows, "unerwarteter Rule-Lookup");
    const result = Object.assign(Promise.resolve(rows), {
      from: (table: unknown) => { assert.equal(table, tradeRules); return result; },
      where: () => result,
      limit: () => result,
    });
    return result;
  }

  insert(table: unknown) {
    this.touch();
    assert.equal(table, tradeRules);
    return { values: (values: Record<string, unknown>) => {
      this.writes.push({ kind: "insert", values });
      return { returning: () => [row("DRAFT", values)] };
    } };
  }

  update(table: unknown) {
    this.touch();
    assert.equal(table, tradeRules);
    return { set: (values: Record<string, unknown>) => ({ where: () => {
      this.writes.push({ kind: "update", values });
      const current = this.updateRows.shift();
      assert.ok(current, "unerwartete Rule-Mutation");
      const rows = [{ ...current, ...values }];
      return Object.assign(Promise.resolve(rows), { returning: () => rows });
    } }) };
  }

  async transaction<T>(fn: (tx: RuleDb) => Promise<T>): Promise<T> {
    this.touch();
    return fn(this);
  }
}

let db: RuleDb;
let post: typeof import("../src/app/api/firm/rules/route").POST;
let lifecycle: typeof import("../src/app/api/firm/rules/[id]/route").POST;
let macro: typeof import("../src/app/api/firm/macro/route").POST;

before(async () => {
  ({ POST: post } = await import("../src/app/api/firm/rules/route"));
  ({ POST: lifecycle } = await import("../src/app/api/firm/rules/[id]/route"));
  ({ POST: macro } = await import("../src/app/api/firm/macro/route"));
  for (const key of AUTH_KEYS) savedEnv.set(key, process.env[key]);
  previousDb = G.__arenaNextJsPostgresqlDb;
  previousMacroBusy = G.__macroBusy;
  spoolDir = mkdtempSync(join(tmpdir(), "sec06-audit-"));
});

beforeEach(() => {
  for (const key of AUTH_KEYS) delete process.env[key];
  process.env.AUTH_MODE = "token-required";
  process.env.FIRM_ADMIN_TOKEN = TOKENS.admin;
  process.env.FIRM_API_TOKEN = TOKENS.operator;
  process.env.FIRM_VIEWER_TOKEN = TOKENS.viewer;
  process.env.FIRM_SESSION_SECRET = randomBytes(32).toString("hex");
  process.env.FIRM_RATE_LIMIT = "0";
  process.env.AUDIT_SPOOL_DIR = spoolDir;
  db = new RuleDb();
  G.__arenaNextJsPostgresqlDb = db;
  // Der echte Makro-Einstieg liefert ALREADY_RUNNING: deterministischer
  // positiver Guard-Pfad ohne LLM-/Marktdaten-Netzwerkzugriffe.
  G.__macroBusy = true;
  audits = [];
  resetRateLimiterForTests();
  resetAuditDurabilityForTests();
  setAuditTransportForTests(async (entry) => { audits.push(entry); });
});

afterEach(() => {
  resetRateLimiterForTests();
  resetAuditDurabilityForTests();
});

after(() => {
  if (previousDb === undefined) delete G.__arenaNextJsPostgresqlDb;
  else G.__arenaNextJsPostgresqlDb = previousDb;
  if (previousMacroBusy === undefined) delete G.__macroBusy;
  else G.__macroBusy = previousMacroBusy;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(spoolDir, { recursive: true, force: true });
});

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://trading.example.test/api/firm/rules", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function credential(role: Role, transport: "header" | "bearer" | "session" = "header"): Record<string, string> {
  if (transport === "bearer") return { authorization: `Bearer ${TOKENS[role]}` };
  const headers = { [role === "admin" ? "x-admin-token" : role === "viewer" ? "x-viewer-token" : "x-firm-token"]: TOKENS[role] };
  if (transport === "header") return headers;
  const req = request({}, headers);
  const resolved = resolveAuth(req);
  assert.ok(resolved.ok);
  const issued = issueSession(req, resolved.actor);
  assert.ok(issued.ok);
  return { cookie: `${SESSION_COOKIE}=${issued.sessionToken}` };
}

function actionRequest(body: unknown, headers = credential("operator"), id = row().id) {
  return lifecycle(request(body, headers), { params: Promise.resolve({ id }) });
}

function prepareAction(action: string) {
  const current = row(action === "pause" || action === "rollback" ? "ACTIVE" : "DRAFT");
  db.reads = [[current], [current]]; // Route-Lookup + Service-Lookup
  db.updateRows = [current];
  if (action === "activate") db.reads.push([]); // andere aktive Versionen
  if (action === "rollback") {
    const previous = row("SUPERSEDED", { id: current.previousVersionId!, version: 1 });
    db.reads.push([previous]);
    db.updateRows.push(previous);
  }
}

function prepareCreate(activate = false) {
  db.reads = [[]];
  if (activate) {
    db.reads.push([row()], []);
    db.updateRows = [row()];
  }
}

function assertUntouched() {
  assert.equal(db.calls, 0, "Autorisierung/Validierung muss VOR jedem DB-Zugriff greifen");
  assert.deepEqual(db.writes, []);
  assert.deepEqual(audits, []);
}

const ACTIONS = ["activate", "pause", "archive", "rollback", "reject"] as const;
const ADMIN_ACTIONS = ["activate", "archive", "rollback"] as const;

for (const role of ["viewer", "operator", "admin"] as const) {
  test(`SEC-06: Permission-Katalog und Rollenmatrix für ${role}`, () => {
    for (const name of ["write", "activate", "rollback", "archive"]) {
      const permission = `strategy.rules.${name}`;
      assert.ok((PERMISSIONS as readonly string[]).includes(permission));
      assert.equal((permissionsForRole(role) as readonly string[]).includes(permission),
        name === "write" ? role !== "viewer" : role === "admin", permission);
    }
  });
}

for (const transport of ["header", "bearer", "session"] as const) {
  for (const action of ADMIN_ACTIONS) {
    test(`SEC-06: Operator/${transport} darf ${action} nicht auslösen`, async () => {
      prepareAction(action); // würde ohne Permission-Guard erfolgreich mutieren
      const res = await actionRequest({ action }, credential("operator", transport));
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error, "FORBIDDEN");
      assertUntouched();
    });
  }

  for (const action of ACTIONS) {
    test(`SEC-06/05: Admin/${transport} darf ${action}, Audit stammt aus dem Credential`, async () => {
      prepareAction(action);
      const res = await actionRequest({ action }, credential("admin", transport));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.rule.status, { activate: "ACTIVE", pause: "PAUSED", archive: "ARCHIVED", rollback: "ACTIVE", reject: "REJECTED" }[action]);
      assert.equal(db.reads.length, 0);
      assert.ok(db.writes.length > 0);
      assert.equal(audits.length, 1);
      assert.equal((audits[0].detail as Record<string, unknown>).by, "admin");
      if (action === "rollback") assert.equal(body.rule.id, row().previousVersionId);
    });
  }

  test(`SEC-06: Viewer/${transport} erhält 403 auf sämtliche Rule-Writes`, async () => {
    for (const action of ACTIONS) {
      assert.equal((await actionRequest({ action }, credential("viewer", transport))).status, 403);
    }
    for (const activate of [false, true]) {
      assert.equal((await post(request({ rule: SPEC, activate }, credential("viewer", transport)))).status, 403);
    }
    assertUntouched();
  });

  for (const wrapped of [false, true]) {
    test(`SEC-06: Operator/${transport} darf create-and-activate (${wrapped ? "rule" : "flat"}) nicht`, async () => {
      prepareCreate(true);
      const body = wrapped ? { rule: SPEC, activate: true } : { ...SPEC, activate: true };
      assert.equal((await post(request(body, credential("operator", transport)))).status, 403);
      assertUntouched();
    });
  }

  test(`SEC-06/05: Operator/${transport} darf Draft anlegen, Herkunft und Ersteller sind serverseitig`, async () => {
    prepareCreate();
    const res = await post(request({ rule: { ...SPEC, status: "ACTIVE", sourceMode: "SIGMA" } }, credential("operator", transport)));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.rule.status, "DRAFT");
    assert.equal(body.rule.sourceRole, "MANUAL");
    assert.equal(body.rule.sourceMode, "MANUAL");
    assert.equal(audits.length, 1);
    assert.equal(audits[0].event, "RULE_CREATED");
    assert.equal((audits[0].detail as Record<string, unknown>).by, "operator");
    const view = describeAuditEntry({ ...audits[0], id: "created", createdAt: "2026-09-06T00:00:00Z" });
    assert.equal(view.sections.flatMap((section) => section.facts)
      .find((fact) => fact.label === "Ausgelöst von")?.value, "operator");
  });

  test(`SEC-06/05: Admin/${transport} darf create-and-activate, beide Audits tragen denselben Actor`, async () => {
    prepareCreate(true);
    const res = await post(request({ ...SPEC, activate: true }, credential("admin", transport)));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).rule.status, "ACTIVE");
    assert.deepEqual(audits.map((entry) => entry.event), ["RULE_CREATED", "RULE_ACTIVATED"]);
    assert.deepEqual(audits.map((entry) => (entry.detail as Record<string, unknown>).by), ["admin", "admin"]);
  });

  for (const action of ["pause", "reject"]) {
    test(`SEC-06/05: Operator/${transport} darf ${action} mit eigener Audit-Attribution`, async () => {
      prepareAction(action);
      const res = await actionRequest({ action }, credential("operator", transport));
      assert.equal(res.status, 200);
      assert.equal((audits[0].detail as Record<string, unknown>).by, "operator");
    });
  }
}

test("SEC-06: unechte activate-Booleans werden abgelehnt, niemals coerced", async () => {
  for (const role of ["operator", "admin"] as const) {
    for (const activate of ["true", "false", 1, 0, null, [], {}]) {
      prepareCreate(true);
      const res = await post(request({ rule: SPEC, activate }, credential(role)));
      assert.equal(res.status, 400, `${role}: activate=${JSON.stringify(activate)}`);
      assertUntouched();
    }
  }
});

test("SEC-06: activate=false legt auch in flacher Form nur einen Draft an", async () => {
  prepareCreate();
  const res = await post(request({ ...SPEC, activate: false, status: "ACTIVE" }, credential("operator")));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).rule.status, "DRAFT");
  assert.deepEqual(db.writes.map((write) => write.kind), ["insert"]);
});

test("SEC-06: Operator-Änderungen erzeugen nur einen Draft, die aktive Version bleibt unangetastet", async () => {
  const active = row("ACTIVE");
  db.reads = [[active]];
  const res = await post(request({ ...SPEC, name: "Revised draft", activate: false }, credential("operator")));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.rule.ruleKey, active.ruleKey);
  assert.equal(body.rule.version, active.version + 1);
  assert.equal(body.rule.previousVersionId, active.id);
  assert.equal(body.rule.status, "DRAFT");
  assert.deepEqual(db.writes.map((write) => write.kind), ["insert"]);
});

test("SEC-06: idempotentes Upsert ohne Freigabe ist keine Mutation", async () => {
  const validated = sanitizeRuleSpec(SPEC);
  assert.ok(validated.ok);
  const active = row("ACTIVE", { signature: ruleSignature(validated.spec) });
  db.reads = [[active]];
  const res = await post(request({ rule: SPEC, activate: false }, credential("operator")));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reason, "IDEMPOTENT");
  assert.equal(body.rule.id, active.id);
  assert.deepEqual(db.writes, []);
  assert.deepEqual(audits, []);
});

test("SEC-06: auch ungültige Specs und idempotente Aktivierung umgehen den Freigabe-Guard nicht", async () => {
  for (const rule of [{}, SPEC]) {
    db.reads = [[row("ACTIVE")]];
    assert.equal((await post(request({ rule, activate: true }, credential("operator")))).status, 403);
    assertUntouched();
  }
  for (const status of ["DRAFT", "ACTIVE", "PAUSED", "REJECTED", "SUPERSEDED", "ARCHIVED"]) {
    db.reads = [[row(status)]];
    assert.equal((await actionRequest({ action: "activate" })).status, 403);
    assertUntouched();
  }
});

test("SEC-06: Admin-Token im dokumentierten x-firm-token-Alias bleibt zulässig", async () => {
  prepareAction("activate");
  assert.equal((await actionRequest({ action: "activate" }, { "x-firm-token": TOKENS.admin })).status, 200);
  assert.equal((audits[0].detail as Record<string, unknown>).by, "admin");
});

test("SEC-06: token-required bleibt auch ohne konfigurierte Credentials geschlossen", async () => {
  delete process.env.FIRM_ADMIN_TOKEN;
  delete process.env.FIRM_API_TOKEN;
  delete process.env.FIRM_VIEWER_TOKEN;
  assert.equal((await post(request({ rule: SPEC, activate: true }))).status, 401);
  assert.equal((await actionRequest({ action: "activate" }, {})).status, 401);
  assert.equal((await macro(request({}))).status, 401);
  assertUntouched();
});

test("SEC-05-Nachprüfung: leere/falsy Attributionsfelder werden nicht still akzeptiert", async () => {
  for (const field of ["by", "actor", "sourceRole"]) {
    for (const value of [null, "", false, [], {}]) {
      for (const body of [{ ...SPEC, [field]: value }, { rule: { ...SPEC, [field]: value } }]) {
        const res = await post(request(body, credential("operator")));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, "ACTOR_NOT_CLIENT_CONTROLLED");
      }
      const res = await actionRequest({ action: "pause", [field]: value });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, "ACTOR_NOT_CLIENT_CONTROLLED");
    }
  }
  assertUntouched();
});

test("SEC-06: unbekannte/mehrdeutige Aktionen sind vor dem Lookup ungültig", async () => {
  for (const action of [undefined, null, "ACTIVATE", "activate ", "constructor", "__proto__", "toString", ["activate"], {}, 1]) {
    const res = await actionRequest({ action });
    assert.equal(res.status, 400, JSON.stringify(action));
    assertUntouched();
  }
});

test("SEC-06: JSON-Fehler, Skalare und Arrays führen zu 400, nicht zu DB-Arbeit/500", async () => {
  for (const raw of ["", "{", "null", "[]", '"activate"', "123", "true"]) {
    for (const handler of [post, (req: Request) => lifecycle(req, { params: Promise.resolve({ id: row().id }) })]) {
      const req = new Request("https://trading.example.test/api/firm/rules", {
        method: "POST", headers: credential("operator"), body: raw,
      });
      assert.equal((await handler(req)).status, 400, raw);
      assertUntouched();
    }
  }
});

test("SEC-06: ungültiger Wrapper/reason wird vor jedem Persistenzzugriff abgelehnt", async () => {
  for (const rule of [null, false, [], "spec"]) {
    assert.equal((await post(request({ rule }, credential("operator")))).status, 400);
  }
  for (const reason of [null, 3, {}, []]) {
    assert.equal((await actionRequest({ action: "reject", reason })).status, 400);
  }
  assertUntouched();
});

test("SEC-06: manipulierte Rollen-Claims und Header verleihen keine Admin-Rechte", async () => {
  const attacks: Array<Record<string, string>> = [
    { "x-admin-token": TOKENS.operator },
    { "x-firm-token": TOKENS.operator, "x-admin-token": "forged", "x-role": "admin", "x-forwarded-for": "127.0.0.1" },
    { ...credential("admin", "session"), "x-firm-token": TOKENS.operator }, // Header hat Vorrang
  ];
  for (const headers of attacks) {
    const res = await actionRequest({ action: "activate", role: "admin", effectiveRole: "admin", permissions: ["strategy.rules.activate"] }, headers);
    assert.equal(res.status, 403);
    assertUntouched();
  }
});

test("SEC-06: fehlende oder ungültige Credentials scheitern vor Body- und DB-Zugriff", async () => {
  const attacks: Array<Record<string, string>> = [{}, { "x-admin-token": "forged" }, { cookie: `${SESSION_COOKIE}=forged.signature` }];
  for (const headers of attacks) {
    for (const handler of [post, (req: Request) => lifecycle(req, { params: Promise.resolve({ id: row().id }) }), macro]) {
      const req = request({ action: "activate", rule: SPEC, activate: true }, headers);
      assert.equal((await handler(req)).status, 403);
      assert.equal(req.bodyUsed, false);
      assertUntouched();
    }
  }
  delete process.env.FIRM_ADMIN_TOKEN;
  assert.equal((await post(request({ rule: SPEC }))).status, 401);
  assertUntouched();
});

test("SEC-06: verbotene Aktionen verraten auch bei unbekannter ID keine Existenz", async () => {
  for (const id of [row().id, "unknown", "not-a-uuid"]) {
    assert.equal((await actionRequest({ action: "activate" }, credential("operator"), id)).status, 403);
  }
  assertUntouched();
});

test("SEC-06: berechtigter Lookup/Statuskonflikt und DB-Fehler behalten ihre Fehlerantwort", async () => {
  db.reads = [[]];
  assert.equal((await actionRequest({ action: "activate" }, credential("admin"))).status, 404);
  db.reads = [[row("ARCHIVED")], [row("ARCHIVED")]];
  assert.equal((await actionRequest({ action: "activate" }, credential("admin"))).status, 409);
  db.failure = new Error("test database unavailable");
  const res = await post(request({ rule: SPEC }, credential("operator")));
  assert.equal(res.status, 500);
  assert.equal((await res.json()).ok, false);
  assert.deepEqual(db.writes, []);
  assert.deepEqual(audits, []);
});

test("SEC-06: Rate-Limit bleibt für beide Rule-Routen und den Makro-Einstieg wirksam", async () => {
  process.env.FIRM_RATE_LIMIT = "1";
  // Erster erlaubter Request verbraucht Quota, ohne die DB zu benötigen.
  assert.equal((await post(request({ rule: {} }, credential("operator")))).status, 422);
  for (const handler of [post, (req: Request) => lifecycle(req, { params: Promise.resolve({ id: row().id }) }), macro]) {
    const res = await handler(request({ action: "activate", rule: SPEC }, credential("admin")));
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("Retry-After")) > 0);
  }
  assertUntouched();
});

for (const transport of ["header", "bearer", "session"] as const) {
  test(`SEC-06: Makro-Autoaktivierung ist kein Umweg für Operator/Viewer (${transport})`, async () => {
    for (const approval of ["true", "false"]) {
      process.env.REQUIRE_HUMAN_APPROVAL = approval;
      for (const role of ["operator", "viewer"] as const) {
        const res = await macro(request({ missionId: row().missionId }, credential(role, transport)));
        assert.equal(res.status, 403);
      }
    }
    assertUntouched();
    const allowed = await macro(request({}, credential("admin", transport)));
    assert.equal(allowed.status, 422);
    assert.equal((await allowed.json()).cycle.error, "MACRO_ALREADY_RUNNING");
  });
}

test("SEC-06: bewusste Single-Admin-Elevation und local-open bleiben administrativ", async () => {
  delete process.env.FIRM_ADMIN_TOKEN;
  for (const transport of ["header", "bearer", "session"] as const) {
    prepareAction("activate");
    assert.equal((await actionRequest({ action: "activate" }, credential("operator", transport))).status, 200);
    assert.equal((audits.at(-1)!.detail as Record<string, unknown>).by, "admin");
  }
  delete process.env.FIRM_API_TOKEN;
  delete process.env.FIRM_VIEWER_TOKEN;
  process.env.AUTH_MODE = "local-open";
  prepareAction("activate");
  assert.equal((await actionRequest({ action: "activate" }, {})).status, 200);
});

test("SEC-06: Einführung eines Admin-Tokens entzieht alten Single-Admin-Sessions die Freigabe", async () => {
  delete process.env.FIRM_ADMIN_TOKEN;
  const oldSession = credential("operator", "session");
  process.env.FIRM_ADMIN_TOKEN = TOKENS.admin;
  assert.equal((await actionRequest({ action: "activate" }, oldSession)).status, 403);
  assertUntouched();
});

test("SEC-05-Nachprüfung: auch verschachtelte Attributionsfelder im Lifecycle werden abgelehnt", async () => {
  for (const role of ["operator", "admin"] as const) {
    for (const field of ["by", "actor", "sourceRole"]) {
      const res = await actionRequest({ action: "pause", rule: { [field]: "CEO" } }, credential(role));
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, "ACTOR_NOT_CLIENT_CONTROLLED");
      assertUntouched();
    }
  }
});

test("SEC-05-Nachprüfung: ruleActor erfindet bei fehlender Authentifizierung keinen Admin", () => {
  assert.throws(() => ruleActor(request({})), /auth/i);
});

test("SEC-06/05: Sicherheitsregressionen sind im verbindlichen Auth-CI-Gate enthalten", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  for (const finding of ["sec05", "sec06"]) {
    assert.ok(pkg.scripts["test:security:auth"].includes(`tests/${finding}.*.test.ts`), finding);
  }
});
