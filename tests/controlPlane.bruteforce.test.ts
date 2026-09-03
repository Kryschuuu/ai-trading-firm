/**
 * Befund C2 (v1.36.14), Teil 2 — Brute-Force-Schichtung der Control Plane.
 *
 * Der Credential-Limiter bekommt dieselbe Client-Identität wie der
 * Firm-Schreib-Limiter (geteiltes `resolveClientIp` aus `src/lib/clientIp.ts`)
 * und zusätzlich zwei IP-unabhängige Ebenen:
 *
 *   a) pro Client-Identität  (BROKER_CREDENTIAL_RATE_LIMIT, Default 5/min)
 *   b) global, fester Bucket (BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT, Default 20/min)
 *   c) exponentieller Backoff ab dem 3. Fehlversuch (2 s → 4 s → 8 s … 15 min)
 *
 * Geprüft wird hier bewusst auch die **Negative**: Der Kill-Switch
 * (`/api/live/kill`) nutzt nur Ebene (a) — weder ein globaler Credential-Flood
 * noch ein Backoff darf die Sicherheitsaktion blockieren können.
 */
import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MemorySecretStorage,
  clearControlPlaneAuditForTests,
  createAesGcmSecretStore,
  resetControlPlaneForTests,
  setControlPlaneSecretStoreForTests,
} from "../src/brokers/control-plane";
import {
  checkCredentialBackoff,
  checkCredentialGlobalRateLimit,
  checkCredentialRateLimit,
  credentialBackoffState,
  guardCredentialEndpoint,
  recordCredentialFailure,
  recordCredentialSuccess,
  resetCredentialRateLimiterForTests,
} from "../src/brokers/control-plane/guard";
import {
  CREDENTIAL_BACKOFF_BASE_MS_FLAG,
  CREDENTIAL_BACKOFF_CONFIG,
  CREDENTIAL_BACKOFF_MAX_MS_FLAG,
  CREDENTIAL_BACKOFF_RESET_MS,
  GLOBAL_CREDENTIAL_BUCKET_KEY,
  credentialBackoffConfig,
  credentialBackoffMs,
  credentialGlobalRateLimitMax,
  credentialRateLimitMax,
} from "../src/brokers/control-plane/config";
import { LOCAL_CLIENT_KEY, TRUSTED_PROXY_IPS_FLAG } from "../src/lib/clientIp";

const NO_ENV = {};
const CSRF_LOCAL = { "x-csrf-token": "local", "content-type": "application/json" };

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/brokers/BITUNIX/credentials", {
    method: "POST",
    headers,
  });
}

type Ctx = { params: Promise<{ venue: string }> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;
let POST_CRED: Handler;

const VALID = {
  apiKey: "k-bruteforce-test-0123456789",
  apiSecret: "s-bruteforce-test-0123456789",
};

before(async () => {
  ({ POST: POST_CRED } = await import(
    "../src/app/api/brokers/[venue]/credentials/route"
  ));
});

beforeEach(() => {
  resetControlPlaneForTests();
  resetCredentialRateLimiterForTests();
  clearControlPlaneAuditForTests();
  setControlPlaneSecretStoreForTests(
    createAesGcmSecretStore({
      storage: new MemorySecretStorage(),
      keyBuffer: Buffer.alloc(32, 11),
    })
  );
  delete process.env[TRUSTED_PROXY_IPS_FLAG];
  delete process.env.BROKER_CREDENTIAL_RATE_LIMIT;
  delete process.env.BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT;
  delete process.env[CREDENTIAL_BACKOFF_BASE_MS_FLAG];
  delete process.env[CREDENTIAL_BACKOFF_MAX_MS_FLAG];
  delete process.env.FIRM_ADMIN_TOKEN;
  delete process.env.FIRM_API_TOKEN;
  delete process.env.FIRM_VIEWER_TOKEN;
});

// ── Konfiguration ────────────────────────────────────────────────────────────

describe("Konfiguration der Brute-Force-Schichten", () => {
  test("Defaults: 5/min pro Identität, 20/min global, 0 deaktiviert", () => {
    assert.equal(credentialRateLimitMax(NO_ENV), 5);
    assert.equal(credentialGlobalRateLimitMax(NO_ENV), 20);
    assert.equal(credentialGlobalRateLimitMax({ BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT: "0" }), 0);
    assert.equal(credentialGlobalRateLimitMax({ BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT: "abc" }), 20);
    assert.equal(credentialGlobalRateLimitMax({ BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT: "-5" }), 0);
    assert.notEqual(GLOBAL_CREDENTIAL_BUCKET_KEY, LOCAL_CLIENT_KEY);
  });

  test("credentialBackoffConfig: Defaults, Env-Override, 0 = aus, Klemmung", () => {
    const def = credentialBackoffConfig(NO_ENV);
    assert.deepEqual(def, CREDENTIAL_BACKOFF_CONFIG);
    const tuned = credentialBackoffConfig({
      [CREDENTIAL_BACKOFF_BASE_MS_FLAG]: "60000",
      [CREDENTIAL_BACKOFF_MAX_MS_FLAG]: "120000",
    });
    assert.equal(tuned.baseMs, 60_000);
    assert.equal(tuned.maxMs, 120_000);
    assert.equal(tuned.threshold, CREDENTIAL_BACKOFF_CONFIG.threshold);
    assert.equal(credentialBackoffMs(3, tuned), 60_000);
    assert.equal(credentialBackoffMs(9, tuned), 120_000, "Deckel aus Env gilt");
    // 0 = Backoff aus (dokumentierter Operator-Knob), Müll ⇒ Default
    assert.equal(credentialBackoffMs(9, credentialBackoffConfig({ [CREDENTIAL_BACKOFF_BASE_MS_FLAG]: "0" })), 0);
    assert.equal(credentialBackoffConfig({ [CREDENTIAL_BACKOFF_BASE_MS_FLAG]: "abc" }).baseMs, CREDENTIAL_BACKOFF_CONFIG.baseMs);
    assert.equal(credentialBackoffConfig({ [CREDENTIAL_BACKOFF_BASE_MS_FLAG]: "-5" }).baseMs, 0);
  });

  test("credentialBackoffMs: Schwelle, exponentielles Wachstum, Deckel, Unsinn", () => {
    const cfg = CREDENTIAL_BACKOFF_CONFIG;
    assert.equal(cfg.threshold, 3);
    // unterhalb der Schwelle: keine Sperre (ein Tippfehler sperrt niemanden aus)
    assert.equal(credentialBackoffMs(0), 0);
    assert.equal(credentialBackoffMs(1), 0);
    assert.equal(credentialBackoffMs(2), 0);
    // exponentiell
    assert.equal(credentialBackoffMs(3), 2_000);
    assert.equal(credentialBackoffMs(4), 4_000);
    assert.equal(credentialBackoffMs(5), 8_000);
    assert.equal(credentialBackoffMs(6), 16_000);
    // gedeckelt auf 15 min — auch bei absurden Zählerständen
    assert.equal(credentialBackoffMs(50), cfg.maxMs);
    assert.equal(credentialBackoffMs(10_000), cfg.maxMs);
    assert.equal(credentialBackoffMs(Number.NaN), 0);
    assert.equal(credentialBackoffMs(Number.POSITIVE_INFINITY), 0);
    assert.equal(credentialBackoffMs(-7), 0);
    // kaputte Konfiguration ⇒ keine Dauersperre (fail-safe für den Betreiber)
    assert.equal(credentialBackoffMs(9, { threshold: 3, baseMs: 0, factor: 2, maxMs: 1000 }), 0);
    assert.equal(credentialBackoffMs(9, { threshold: 3, baseMs: 10, factor: 1, maxMs: 1000 }), 0);
  });
});

// ── Ebene (a): Identität ist nicht mehr client-setzbar ───────────────────────

describe("Credential-Limiter: dieselbe Identitätsauflösung wie der Firm-Limiter", () => {
  test("rotierende X-Forwarded-For-Headers ergeben EINEN Bucket ⇒ 429", () => {
    const opts = { max: 3, windowMs: 60_000, now: 1_000, env: NO_ENV };
    assert.equal(checkCredentialRateLimit(req({ "x-forwarded-for": "1.2.3.4" }), opts), null);
    assert.equal(checkCredentialRateLimit(req({ "x-forwarded-for": "5.6.7.8" }), opts), null);
    assert.equal(checkCredentialRateLimit(req({ "x-real-ip": "9.9.9.9" }), opts), null);
    const limited = checkCredentialRateLimit(req({ "x-forwarded-for": "10.0.0.1" }), opts);
    assert.ok(limited, "spoofbare Identität würde Brute-Force unbegrenzt erlauben");
    assert.equal(limited.status, 429);
  });

  test("429-Body bleibt secret-frei und nennt Retry-After + Code", async () => {
    const opts = { max: 1, windowMs: 60_000, now: 2_000, env: NO_ENV };
    assert.equal(checkCredentialRateLimit(req(), opts), null);
    const limited = checkCredentialRateLimit(req(), opts);
    assert.ok(limited);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("Retry-After")) >= 1);
    const body = (await limited.json()) as { ok: boolean; error: string; code: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, "RATE_LIMITED");
    assert.equal(body.code, "CREDENTIAL_RATE_LIMITED");
  });

  test("konfiguriertes Proxy-Vertrauen trennt echte Clients wieder", () => {
    const env = { [TRUSTED_PROXY_IPS_FLAG]: "203.0.113.7" };
    const opts = { max: 1, windowMs: 60_000, now: 3_000, env, peerIp: "203.0.113.7" };
    // Client A über den verifizierten Proxy
    assert.equal(
      checkCredentialRateLimit(req({ "x-verified-ip": "198.51.100.11" }), opts),
      null
    );
    assert.equal(
      checkCredentialRateLimit(req({ "x-verified-ip": "198.51.100.11" }), opts)?.status,
      429,
      "derselbe Client muss gedrosselt bleiben"
    );
    // Client B hat ein eigenes Budget — die Trennung ist nicht verloren gegangen
    assert.equal(
      checkCredentialRateLimit(req({ "x-verified-ip": "198.51.100.12" }), opts),
      null
    );
  });

  test("ohne jeden Hinweis bleibt der stabile Fallback-Bucket", () => {
    const opts = { max: 1, windowMs: 60_000, now: 4_000, env: NO_ENV };
    assert.equal(checkCredentialRateLimit(req(), opts), null);
    assert.equal(checkCredentialRateLimit(req(), opts)?.status, 429);
    assert.equal(credentialBackoffState(req(), { env: NO_ENV }).key, LOCAL_CLIENT_KEY);
  });
});

// ── Ebene (b): globales, IP-unabhängiges Limit ───────────────────────────────

describe("Globales Credential-Limit (IP-unabhängig)", () => {
  test("deckelt verteilte Versuche, obwohl jede Identität unter ihrem Limit bleibt", () => {
    const env = { [TRUSTED_PROXY_IPS_FLAG]: "203.0.113.7" };
    const perClient = { max: 5, windowMs: 60_000, now: 10_000, env };
    const global = { max: 3, windowMs: 60_000, now: 10_000, env };

    for (let i = 0; i < 3; i += 1) {
      const r = req({ "x-verified-ip": `198.51.100.${i + 1}` });
      assert.equal(checkCredentialRateLimit(r, perClient), null, `Identität ${i} pro Client`);
      assert.equal(checkCredentialGlobalRateLimit(global), null, `globaler Versuch ${i}`);
    }
    // 4. Versuch: neue Identität (pro Client frei), global gedeckelt
    const fresh = req({ "x-verified-ip": "198.51.100.99" });
    assert.equal(checkCredentialRateLimit(fresh, perClient), null);
    const limited = checkCredentialGlobalRateLimit(global);
    assert.ok(limited);
    assert.equal(limited.status, 429);
  });

  test("429 des globalen Limits nennt eigenen Code", async () => {
    const limited = checkCredentialGlobalRateLimit({ max: 0, now: 1 });
    assert.equal(limited, null, "max=0 deaktiviert die Ebene");
    const opts = { max: 1, windowMs: 60_000, now: 11_000, env: NO_ENV };
    assert.equal(checkCredentialGlobalRateLimit(opts), null);
    const denied = checkCredentialGlobalRateLimit(opts);
    assert.ok(denied);
    const body = (await denied.json()) as { code: string; error: string };
    assert.equal(body.error, "RATE_LIMITED");
    assert.equal(body.code, "CREDENTIAL_GLOBAL_RATE_LIMITED");
  });

  test("globales Limit hängt an keinem Request-Header (fester Bucket-Schlüssel)", () => {
    const opts = { max: 1, windowMs: 60_000, now: 12_000, env: NO_ENV };
    assert.equal(checkCredentialGlobalRateLimit(opts), null);
    // völlig andere Requests/Headers — dasselbe globale Budget
    assert.equal(checkCredentialGlobalRateLimit(opts)?.status, 429);
    assert.equal(
      checkCredentialGlobalRateLimit({
        max: 1,
        windowMs: 60_000,
        now: 12_000 + 60_001,
        env: NO_ENV,
      }),
      null,
      "nach dem Fenster ist das globale Budget wieder frei"
    );
  });
});

// ── Ebene (c): exponentieller Backoff ────────────────────────────────────────

describe("Exponentieller Backoff nach Fehlversuchen", () => {
  test("unterhalb der Schwelle frei, ab dem 3. Fehlversuch Sperre", () => {
    const opts = { now: 20_000, env: NO_ENV };
    assert.equal(recordCredentialFailure(req(), opts).failures, 1);
    assert.equal(checkCredentialBackoff(req(), opts), null);
    assert.equal(recordCredentialFailure(req(), opts).failures, 2);
    assert.equal(checkCredentialBackoff(req(), opts), null);
    const third = recordCredentialFailure(req(), opts);
    assert.equal(third.failures, 3);
    assert.equal(third.backoffMs, 2_000);
    const denied = checkCredentialBackoff(req(), opts);
    assert.ok(denied);
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get("Retry-After"), "2");
  });

  test("Sperre wächst exponentiell und ist gedeckelt", async () => {
    let now = 30_000;
    for (let i = 0; i < 4; i += 1) recordCredentialFailure(req(), { now, env: NO_ENV });
    const state = credentialBackoffState(req(), { now, env: NO_ENV });
    assert.equal(state.failures, 4);
    assert.equal(state.retryAfterMs, 4_000);
    const denied = checkCredentialBackoff(req(), { now, env: NO_ENV });
    assert.ok(denied);
    const body = (await denied.json()) as { code: string };
    assert.equal(body.code, "CREDENTIAL_BACKOFF");

    // nach Ablauf der Sperre frei, obwohl der Zählerstand bleibt
    assert.equal(
      checkCredentialBackoff(req(), { now: now + 4_001, env: NO_ENV }),
      null
    );
    // Deckel: sehr viele Fehlversuche ⇒ max. 15 min. Abstand kleiner als die
    // Ruhephase, sonst beginnt die Zählung (gewollt) wieder bei 1.
    now += 5_000;
    let lastFailureAt = now;
    for (let i = 0; i < 60; i += 1) {
      recordCredentialFailure(req(), { now, env: NO_ENV });
      lastFailureAt = now;
      now += CREDENTIAL_BACKOFF_RESET_MS - 1;
    }
    // Gemessen direkt am letzten Fehlversuch: die Sperre ist gedeckelt.
    const capped = credentialBackoffState(req(), { now: lastFailureAt, env: NO_ENV });
    assert.ok(capped.failures > 50);
    assert.equal(capped.retryAfterMs, CREDENTIAL_BACKOFF_CONFIG.maxMs);
  });

  test("erfolgreicher Versuch setzt den Backoff zurück", () => {
    const opts = { now: 40_000, env: NO_ENV };
    for (let i = 0; i < 5; i += 1) recordCredentialFailure(req(), opts);
    assert.ok(checkCredentialBackoff(req(), opts));
    recordCredentialSuccess(req(), opts);
    assert.equal(checkCredentialBackoff(req(), opts), null);
    assert.equal(credentialBackoffState(req(), opts).failures, 0);
  });

  test("Ruhephase lässt die Zählung neu beginnen", () => {
    const first = recordCredentialFailure(req(), { now: 50_000, env: NO_ENV });
    assert.equal(first.failures, 1);
    const later = recordCredentialFailure(req(), {
      now: 50_000 + CREDENTIAL_BACKOFF_RESET_MS + 1,
      env: NO_ENV,
    });
    assert.equal(later.failures, 1, "nach 15 min Ruhe zählt es wieder bei 1");
  });

  test("Backoff ist pro Identität getrennt (kein Kollektiv-Aussperren)", () => {
    const env = { [TRUSTED_PROXY_IPS_FLAG]: "203.0.113.7" };
    const opts = { now: 60_000, env, peerIp: "203.0.113.7" };
    for (let i = 0; i < 4; i += 1) {
      recordCredentialFailure(req({ "x-verified-ip": "198.51.100.21" }), opts);
    }
    assert.ok(checkCredentialBackoff(req({ "x-verified-ip": "198.51.100.21" }), opts));
    assert.equal(checkCredentialBackoff(req({ "x-verified-ip": "198.51.100.22" }), opts), null);
  });
});

// ── Zusammenspiel + Kill-Switch-Ausnahme ─────────────────────────────────────

describe("guardCredentialEndpoint und Kill-Switch-Ausnahme", () => {
  test("guardCredentialEndpoint: Backoff und globales Limit greifen im Verbund", () => {
    const now = 70_000;
    // globales Budget auf 1 setzen, per-Client bleibt großzügig
    process.env.BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT = "1";
    assert.equal(guardCredentialEndpoint(req(CSRF_LOCAL), { now, env: process.env }), null);
    const denied = guardCredentialEndpoint(req(CSRF_LOCAL), { now, env: process.env });
    assert.ok(denied);
    assert.equal(denied.status, 429);
  });

  test("guardCredentialEndpoint: CSRF bleibt vor den Limitern (Reihenfolge)", () => {
    const denied = guardCredentialEndpoint(
      req({ "content-type": "application/json" }),
      { now: 71_000, env: NO_ENV }
    );
    assert.ok(denied);
    assert.equal(denied.status, 403, "CSRF muss vor dem Rate-Limit entscheiden");
  });

  test("Kill-Switch-Pfad nutzt nur das Identitäts-Limit (nie global/Backoff)", () => {
    const now = 80_000;
    // global dicht + Backoff aktiv
    process.env.BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT = "1";
    assert.equal(checkCredentialGlobalRateLimit({ now, env: process.env }), null);
    assert.ok(checkCredentialGlobalRateLimit({ now, env: process.env }));
    for (let i = 0; i < 6; i += 1) recordCredentialFailure(req(), { now, env: process.env });
    assert.ok(checkCredentialBackoff(req(), { now, env: process.env }));

    // Die Live-Gate-Routen rufen genau diese Funktion — sie muss frei bleiben.
    assert.equal(
      checkCredentialRateLimit(req(), { max: 5, windowMs: 60_000, now, env: process.env }),
      null,
      "Kill-Switch darf durch Credential-Backoff/globalen Flood nicht blockiert werden"
    );
  });
});

// ── Route-Integration: der Backoff wirkt über den echten Endpoint ────────────

describe("POST /api/brokers/{venue}/credentials: Backoff im echten Pfad", () => {
  const ctx = (venue: string): Ctx => ({ params: Promise.resolve({ venue }) });
  const post = (venue: string, body: unknown) =>
    new Request(`http://localhost/api/brokers/${venue}/credentials`, {
      method: "POST",
      headers: CSRF_LOCAL,
      body: JSON.stringify(body),
    });

  test("drei ungültige Credentials ⇒ vierter Versuch 429 CREDENTIAL_BACKOFF", async () => {
    // Backoff-Basis hochsetzen: Die Aussage des Tests ist „ab dem 3. Fehlversuch
    // sperrt die Route", nicht „die Sperre endet nach 2 s" (Wall-Clock-Rennen
    // unter paralleler Test-Last wären Flakes).
    process.env[CREDENTIAL_BACKOFF_BASE_MS_FLAG] = "600000";
    for (let i = 0; i < 3; i += 1) {
      const res = await POST_CRED(post("ALPACA", { apiKey: "kurz", apiSecret: "kurz" }), ctx("ALPACA"));
      assert.equal(res.status, 422, `Versuch ${i + 1} muss VALIDATION_ERROR liefern`);
    }
    const blocked = await POST_CRED(post("ALPACA", { apiKey: "kurz", apiSecret: "kurz" }), ctx("ALPACA"));
    assert.equal(blocked.status, 429, "ab dem 3. Fehlversuch muss der Backoff greifen");
    const body = (await blocked.json()) as { error: string; code: string };
    assert.equal(body.error, "RATE_LIMITED");
    assert.equal(body.code, "CREDENTIAL_BACKOFF");
    assert.ok(Number(blocked.headers.get("Retry-After")) >= 1);
  });

  test("erfolgreiches Speichern setzt die Fehlversuchszählung zurück", async () => {
    for (let i = 0; i < 2; i += 1) {
      const res = await POST_CRED(post("ALPACA", { apiKey: "kurz", apiSecret: "kurz" }), ctx("ALPACA"));
      assert.equal(res.status, 422);
    }
    const ok = await POST_CRED(post("KRAKEN", VALID), ctx("KRAKEN"));
    assert.equal(ok.status, 200);
    // Zählung neu: zwei weitere Fehler sperren noch nicht
    for (let i = 0; i < 2; i += 1) {
      const res = await POST_CRED(post("ALPACA", { apiKey: "kurz", apiSecret: "kurz" }), ctx("ALPACA"));
      assert.equal(res.status, 422, "nach Erfolg darf kein Backoff kleben bleiben");
    }
  });

  test("Zustandskonflikt (409) zählt nicht als Brute-Force-Fehlversuch", async () => {
    process.env.BROKER_CREDENTIAL_RATE_LIMIT = "100";
    process.env.BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT = "0";
    const first = await POST_CRED(post("BITUNIX", VALID), ctx("BITUNIX"));
    assert.equal(first.status, 200);
    for (let i = 0; i < 6; i += 1) {
      const res = await POST_CRED(post("BITUNIX", VALID), ctx("BITUNIX"));
      assert.notEqual(res.status, 429, "erneutes Speichern bei aktiver Verbindung darf nie sperren");
      assert.notEqual(res.status, 422);
    }
  });

  test("Spoofbare Header kaufen auch hier keine zusätzlichen Versuche", async () => {
    process.env.BROKER_CREDENTIAL_RATE_LIMIT = "3";
    process.env.BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT = "0";
    process.env[CREDENTIAL_BACKOFF_BASE_MS_FLAG] = "600000";
    const spoof = (ip: string) =>
      new Request("http://localhost/api/brokers/ALPACA/credentials", {
        method: "POST",
        headers: { ...CSRF_LOCAL, "x-forwarded-for": ip, "x-real-ip": ip },
        body: JSON.stringify({ apiKey: "kurz", apiSecret: "kurz" }),
      });
    for (let i = 0; i < 3; i += 1) {
      const res = await POST_CRED(spoof(`1.2.3.${i + 1}`), ctx("ALPACA"));
      assert.equal(res.status, 422, `Versuch ${i + 1} zählt noch nicht als Sperre`);
    }
    const limited = await POST_CRED(spoof("9.9.9.9"), ctx("ALPACA"));
    assert.equal(limited.status, 429, "mit frei wählbarer IP wäre das Limit wirkungslos");
    const body = (await limited.json()) as { code: string };
    assert.ok(
      ["CREDENTIAL_RATE_LIMITED", "CREDENTIAL_BACKOFF"].includes(body.code),
      `unerwarteter 429-Grund: ${body.code}`
    );
  });
});
