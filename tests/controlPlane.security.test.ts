/**
 * Contract-/Security-Tests der Broker Control Plane (Task 08, Pflicht).
 *
 *   1. Response-Scanner: ueber ALLE Control-Plane-/Broker-API-Responses
 *      (Erfolg + Fehler) — Ergebnis MUSS leer sein (Secret-Muster).
 *   2. Bundle-Scanner: gebautes Frontend-Bundle (.next/static) — MUSS leer
 *      sein; optional hart erzwingbar via BROKER_REQUIRE_BUNDLE=1 (CI nach
 *      `npm run build`; gleichwertig: `npm run scan:secrets`).
 *   3. CSRF-Test (Request ohne Token → abgelehnt).
 *   4. RBAC-Test (nicht-Admin → 403).
 *   5. Rate-Limit-Test (5/min/IP → 429).
 *   6. Frontend-Statik: Secret-Feld maskiert (type="password",
 *      autoComplete="new-password", noValidate), kein localStorage fuer
 *      Credentials, kein dangerouslySetInnerHTML/innerHTML in der
 *      Control-Plane-UI (XSS-sicher, CSP-freundlich).
 *   7. Scanner-Unit: bekannte Secret-Formate werden erkannt, harmloser
 *      Text nicht (kein Scanner, der nichts findet).
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  MemorySecretStorage,
  clearControlPlaneAuditForTests,
  createAesGcmSecretStore,
  resetControlPlaneForTests,
  resetCredentialRateLimiterForTests,
  setControlPlaneSecretStoreForTests,
} from "../src/brokers/control-plane";
import {
  scanDirectory,
  scanTextForSecrets,
} from "../src/brokers/control-plane/secretScan";

type Ctx = { params: Promise<{ venue: string }> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;

let POST_CRED: Handler;
let DELETE_CRED: Handler;
let GET_STATUS: Handler;
let POST_TEST: Handler;
let POST_DISCOVER: Handler;
let GET_LIST: (req: Request) => Promise<Response>;
let GET_HEALTH: Handler;

const VALID = {
  apiKey: "k-sec-test-0123456789abcdef",
  apiSecret: "s-sec-test-0123456789abcdef",
};
const CSRF = { "x-csrf-token": "local", "content-type": "application/json" };

before(async () => {
  ({ POST: POST_CRED, DELETE: DELETE_CRED } = await import(
    "../src/app/api/brokers/[venue]/credentials/route"
  ));
  ({ GET: GET_STATUS } = await import("../src/app/api/brokers/[venue]/status/route"));
  ({ POST: POST_TEST } = await import("../src/app/api/brokers/[venue]/test/route"));
  ({ POST: POST_DISCOVER } = await import("../src/app/api/brokers/[venue]/discover/route"));
  ({ GET: GET_LIST } = await import("../src/app/api/brokers/route"));
  ({ GET: GET_HEALTH } = await import("../src/app/api/brokers/[venue]/health/route"));
});

beforeEach(() => {
  resetControlPlaneForTests();
  resetCredentialRateLimiterForTests();
  clearControlPlaneAuditForTests();
  setControlPlaneSecretStoreForTests(
    createAesGcmSecretStore({
      storage: new MemorySecretStorage(),
      keyBuffer: Buffer.alloc(32, 10),
    })
  );
  delete process.env.FIRM_ADMIN_TOKEN;
  delete process.env.FIRM_API_TOKEN;
  delete process.env.BROKER_CREDENTIAL_RATE_LIMIT;
});

after(() => {
  delete process.env.FIRM_ADMIN_TOKEN;
  delete process.env.FIRM_API_TOKEN;
  delete process.env.BROKER_CREDENTIAL_RATE_LIMIT;
  delete process.env.BROKER_REQUIRE_BUNDLE;
});

// ── 1. Response-Scanner ueber ALLE Control-Plane-/Broker-API-Responses ─────

test("Security: Response-Scanner ueber alle Broker-API-Responses findet KEIN Secret-Muster", async () => {
  const responses: { step: string; text: string }[] = [];
  const collect = async (step: string, res: Response) => {
    responses.push({ step, text: await res.text() });
    return res;
  };

  // Broker-Liste + Health (Task 02, read-only).
  await collect("list", await GET_LIST(new Request("http://localhost/api/brokers")));
  await collect(
    "health",
    await GET_HEALTH(
      new Request("http://localhost/api/brokers/BITUNIX/health"),
      { params: Promise.resolve({ venue: "BITUNIX" }) }
    )
  );

  // Status vor/nach Credentials.
  await collect(
    "status-empty",
    await GET_STATUS(new Request("http://localhost/api/brokers/ALPACA/status"), {
      params: Promise.resolve({ venue: "ALPACA" }),
    })
  );

  // Connect (Erfolg) + alle Fehlerpfade:
  await collect(
    "connect-ok",
    await POST_CRED(
      new Request("http://localhost/api/brokers/BITUNIX/credentials", {
        method: "POST",
        headers: CSRF,
        body: JSON.stringify(VALID),
      }),
      { params: Promise.resolve({ venue: "BITUNIX" }) }
    )
  );
  await collect(
    "connect-csrf",
    await POST_CRED(
      new Request("http://localhost/api/brokers/BITUNIX/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(VALID),
      }),
      { params: Promise.resolve({ venue: "BITUNIX" }) }
    )
  );
  await collect(
    "connect-invalid",
    await POST_CRED(
      new Request("http://localhost/api/brokers/KRAKEN/credentials", {
        method: "POST",
        headers: CSRF,
        body: JSON.stringify({ apiKey: "x", apiSecret: "y" }),
      }),
      { params: Promise.resolve({ venue: "KRAKEN" }) }
    )
  );
  await collect(
    "connect-paper",
    await POST_CRED(
      new Request("http://localhost/api/brokers/PAPER/credentials", {
        method: "POST",
        headers: CSRF,
        body: JSON.stringify(VALID),
      }),
      { params: Promise.resolve({ venue: "PAPER" }) }
    )
  );
  await collect(
    "connect-unknown",
    await POST_CRED(
      new Request("http://localhost/api/brokers/%20/credentials", {
        method: "POST",
        headers: CSRF,
        body: JSON.stringify(VALID),
      }),
      { params: Promise.resolve({ venue: " " }) }
    )
  );
  await collect(
    "connect-probe-fail",
    await POST_CRED(
      new Request("http://localhost/api/brokers/IBKR/credentials", {
        method: "POST",
        headers: CSRF,
        body: JSON.stringify({ apiKey: "x".repeat(20), apiSecret: "x".repeat(20) }),
      }),
      { params: Promise.resolve({ venue: "IBKR" }) }
    )
  );

  // Test, Discover, Delete (inkl. Fehlerpfade).
  await collect(
    "test",
    await POST_TEST(
      new Request("http://localhost/api/brokers/BITUNIX/test", {
        method: "POST",
        headers: CSRF,
      }),
      { params: Promise.resolve({ venue: "BITUNIX" }) }
    )
  );
  await collect(
    "test-no-creds",
    await POST_TEST(
      new Request("http://localhost/api/brokers/DYDX/test", {
        method: "POST",
        headers: CSRF,
      }),
      { params: Promise.resolve({ venue: "DYDX" }) }
    )
  );
  await collect(
    "discover",
    await POST_DISCOVER(
      new Request("http://localhost/api/brokers/BITUNIX/discover", {
        method: "POST",
        headers: CSRF,
      }),
      { params: Promise.resolve({ venue: "BITUNIX" }) }
    )
  );
  await collect(
    "delete",
    await DELETE_CRED(
      new Request("http://localhost/api/brokers/BITUNIX/credentials", {
        method: "DELETE",
        headers: CSRF,
      }),
      { params: Promise.resolve({ venue: "BITUNIX" }) }
    )
  );
  await collect(
    "delete-not-configured",
    await DELETE_CRED(
      new Request("http://localhost/api/brokers/ALPACA/credentials", {
        method: "DELETE",
        headers: CSRF,
      }),
      { params: Promise.resolve({ venue: "ALPACA" }) }
    )
  );

  for (const { step, text } of responses) {
    const findings = scanTextForSecrets(text);
    assert.deepEqual(findings, [], `Response ${step} enthaelt Secret-Muster`);
    assert.ok(!text.includes(VALID.apiKey), `${step}: apiKey-Echo`);
    assert.ok(!text.includes(VALID.apiSecret), `${step}: apiSecret-Echo`);
  }
});

// ── 2. Bundle-Scanner (.next/static) ────────────────────────────────────────

test("Security: gebautes Frontend-Bundle enthaelt keine Secret-Muster (falls vorhanden)", () => {
  const bundleDir = path.resolve(process.cwd(), ".next/static");
  const report = scanDirectory(bundleDir);
  if (report.files === 0) {
    if (process.env.BROKER_REQUIRE_BUNDLE === "1") {
      assert.fail(
        "Bundle fehlt, aber BROKER_REQUIRE_BUNDLE=1 — vorher `npm run build` ausfuehren (CI)."
      );
    }
    console.log(
      "[controlPlane.security] .next/static fehlt — Bundle-Scan uebersprungen (CI: npm run build && npm run scan:secrets)."
    );
    return;
  }
  assert.deepEqual(report.findings, [], "Bundle enthaelt Secret-Muster");
});

// ── 3./4./5. CSRF, RBAC, Rate-Limit ─────────────────────────────────────────

test("Security: CSRF — Request ohne x-csrf-token wird abgelehnt (403)", async () => {
  const res = await POST_CRED(
    new Request("http://localhost/api/brokers/BITUNIX/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID),
    }),
    { params: Promise.resolve({ venue: "BITUNIX" }) }
  );
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error: string }).error, "CSRF_INVALID");
});

test("Security: RBAC — nicht-Admin (falscher Token) → 403", async () => {
  process.env.FIRM_ADMIN_TOKEN = "admin-token-sec-123456";
  const res = await POST_CRED(
    new Request("http://localhost/api/brokers/BITUNIX/credentials", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": "ich-bin-kein-admin",
        "x-csrf-token": "ich-bin-kein-admin",
      },
      body: JSON.stringify(VALID),
    }),
    { params: Promise.resolve({ venue: "BITUNIX" }) }
  );
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error: string }).error, "FORBIDDEN");
});

test("Security: Rate-Limit — 6. Versuch/min → 429 (BROKER_CREDENTIAL_RATE_LIMIT=5)", async () => {
  process.env.BROKER_CREDENTIAL_RATE_LIMIT = "5";
  for (let i = 0; i < 5; i += 1) {
    const res = await POST_CRED(
      new Request("http://localhost/api/brokers/BINANCE/credentials", {
        method: "POST",
        headers: CSRF,
        body: JSON.stringify(VALID),
      }),
      { params: Promise.resolve({ venue: "BINANCE" }) }
    );
    assert.notEqual(res.status, 429);
  }
  const res = await POST_CRED(
    new Request("http://localhost/api/brokers/BINANCE/credentials", {
      method: "POST",
      headers: CSRF,
      body: JSON.stringify(VALID),
    }),
    { params: Promise.resolve({ venue: "BINANCE" }) }
  );
  assert.equal(res.status, 429);
});

// ── 6. Frontend-Statik (masked form, kein Client-Speicher, XSS-sicher) ──────

function readSource(rel: string): string {
  return readFileSync(path.resolve(process.cwd(), rel), "utf8");
}

function componentSources(): string[] {
  const dir = path.resolve(process.cwd(), "src/components/control-plane");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => readFileSync(path.join(dir, f), "utf8"));
}

test("Frontend: Credential-Feld bleibt maskiert (type=password, new-password, noValidate)", () => {
  const form = readSource("src/components/control-plane/CredentialForm.tsx");
  assert.ok(form.includes('type="password"'), "Passwort-Feld");
  assert.ok(form.includes('autoComplete="new-password"'), "kein Passwort-Manager");
  assert.ok(form.includes("noValidate"), "Validierung beim Server");
  assert.ok(!/console\.log\s*\(/.test(form), "keine Log-Ausgaben");
  assert.ok(!form.includes('type="text"'), "kein Klartext-Eingabefeld");
});

test("Frontend: keine Secrets im Client-Speicher (kein localStorage.setItem fuer Credentials)", () => {
  const sources = [
    readSource("src/lib/controlPlane.ts"),
    ...componentSources(),
  ].join("\n");
  assert.ok(!/localStorage\.setItem|sessionStorage\.setItem/.test(sources));
  assert.ok(sources.includes("x-csrf-token"), "CSRF-Header wird gesendet");
});

test("Frontend: XSS-sicher — kein dangerouslySetInnerHTML/innerHTML in der Control-Plane-UI", () => {
  for (const source of componentSources()) {
    assert.ok(!/dangerouslySetInnerHTML\s*=/.test(source), "dangerouslySetInnerHTML");
    assert.ok(!/\.innerHTML\s*[=(]/.test(source), "innerHTML-Zuweisung");
  }
});

// ── 7. Scanner-Unit (der Scanner findet echte Muster) ───────────────────────

test("Scanner: erkennt bekannte Secret-Formate und Entropie-Tokens", () => {
  const samples: Array<[string, string]> = [
    ["hex-64", "x" + "f".repeat(64)],
    ["hex-32", "z" + "a".repeat(32) + "z"],
    ["base64-secret", "v=" + "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="],
    ["entropy", "z" + "ZgT2bX9vQp5rW8nL4kJm7Yd3cH6sA1uE0oI9"],
    ["jwt", "x eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
    ["pem-private", "-----BEGIN RSA PRIVATE KEY-----"],
    ["assign-secret", '"apiKey": "geheimes-api-key-material-123"'],
  ];
  for (const [pattern, sample] of samples) {
    const findings = scanTextForSecrets(sample);
    assert.ok(
      findings.some((f) => f.pattern === pattern),
      `Muster ${pattern} muss erkannt werden`
    );
  }
});

test("Scanner: harmloser Text/JSON erzeugt KEINE Funde (kein False-Positive-Rauschen)", () => {
  const clean = JSON.stringify({
    ok: true,
    venue: "BITUNIX",
    configured: true,
    connected: true,
    permissions: ["READ", "TRADE"],
    liveEnabled: false,
    liveReason: "LIVE_GATE_LOCKED: hart gesperrt (task-11)",
    discovery: { state: "active", count: 42, lastSync: "2026-08-28T12:00:00.000Z" },
    layers: {
      connection: { state: "active", at: "2026-08-28T12:00:00.000Z", detail: "READ_ONLY_PROBE_OK" },
      live: { state: "off", at: null, detail: "LIVE_GATE_LOCKED" },
    },
  });
  assert.deepEqual(scanTextForSecrets(clean), []);
  assert.deepEqual(
    scanTextForSecrets("Das ist ein ganz normaler deutscher Satz ohne Geheimnisse."),
    []
  );
});
