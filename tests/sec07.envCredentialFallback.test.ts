/**
 * SEC-07 Regression: Secret-Store faellt bei Fehlern auf Env-Credentials zurueck.
 *
 * Akzeptanzkriterien aus dem Finding:
 * - Store-Fehler (AUTH_FAILED, STORAGE_UNAVAILABLE) → kein Env-Fallback in Production
 * - Fehlender Datensatz → Adapter ohne Credential, nicht stilles Env
 * - Control-Plane `configured` entspricht tatsaechlichem Adapter-Verhalten
 * - Dev/Test-Env-Fallback nur hinter explizitem Flag
 *
 * Deckt Bitunix + Alpaca ab.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  MemorySecretStorage,
  SecretStoreError,
  createAesGcmSecretStore,
  createVenueBackedNamedStore,
  isEnvCredentialFallbackAllowed,
  type VenueSecretStore,
} from "../src/brokers/control-plane/secretStore";

const KEY = Buffer.alloc(32, 7);

function memStore(): VenueSecretStore {
  return createAesGcmSecretStore({
    storage: new MemorySecretStorage(),
    keyBuffer: KEY,
  });
}

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  delete process.env.BROKER_ALLOW_ENV_FALLBACK;
});

afterEach(() => {
  process.env = originalEnv;
});

// ── isEnvCredentialFallbackAllowed ──────────────────────────────────────────

test("SEC-07: isEnvCredentialFallbackAllowed — nur explizites Flag + non-prod", () => {
  assert.equal(isEnvCredentialFallbackAllowed({ BROKER_ALLOW_ENV_FALLBACK: "true", NODE_ENV: "development" }), true);
  assert.equal(isEnvCredentialFallbackAllowed({ BROKER_ALLOW_ENV_FALLBACK: "true", NODE_ENV: "test" }), true);
  assert.equal(isEnvCredentialFallbackAllowed({ BROKER_ALLOW_ENV_FALLBACK: "true", NODE_ENV: "production" }), false);
  assert.equal(isEnvCredentialFallbackAllowed({ BROKER_ALLOW_ENV_FALLBACK: "false", NODE_ENV: "development" }), false);
  assert.equal(isEnvCredentialFallbackAllowed({}), false);
});

// ── Store-Fehler → HARD FAIL ────────────────────────────────────────────────

test("SEC-07: Bitunix — AUTH_FAILED fuehrt zu HARD FAIL, kein Env-Fallback", async () => {
  (process.env as any).NODE_ENV = "production";
  const failingStore: VenueSecretStore = {
    async put() {},
    async get() { throw new SecretStoreError("AUTH_FAILED", "corrupt envelope"); },
    async delete() { return false; },
    async exists() { return false; },
  };
  const bridge = createVenueBackedNamedStore({
    venue: "BITUNIX",
    store: failingStore,
    envFallback: { async get() { return "env-key-should-not-be-used"; } },
    keyName: "BITUNIX_API_KEY",
    secretName: "BITUNIX_API_SECRET",
  });
  await assert.rejects(() => bridge.get("BITUNIX_API_KEY"));
  await assert.rejects(() => bridge.get("BITUNIX_API_SECRET"));
});

test("SEC-07: Alpaca — STORAGE_UNAVAILABLE fuehrt zu HARD FAIL", async () => {
  (process.env as any).NODE_ENV = "production";
  const failingStore: VenueSecretStore = {
    async put() {},
    async get() { throw new SecretStoreError("STORAGE_UNAVAILABLE", "db down"); },
    async delete() { return false; },
    async exists() { return false; },
  };
  const bridge = createVenueBackedNamedStore({
    venue: "ALPACA",
    store: failingStore,
    envFallback: { async get() { return "env-key"; } },
    keyName: "ALPACA_API_KEY",
    secretName: "ALPACA_API_SECRET",
  });
  await assert.rejects(() => bridge.get("ALPACA_API_KEY"));
});

test("SEC-07: INVALID_ENVELOPE → HARD FAIL, kein Fallback", async () => {
  (process.env as any).NODE_ENV = "production";
  const failingStore: VenueSecretStore = {
    async put() {},
    async get() { throw new SecretStoreError("INVALID_ENVELOPE", "invalid"); },
    async delete() { return false; },
    async exists() { return false; },
  };
  const bridge = createVenueBackedNamedStore({
    venue: "BITUNIX",
    store: failingStore,
    envFallback: { async get() { return "env"; } },
    keyName: "BITUNIX_API_KEY",
    secretName: "BITUNIX_API_SECRET",
  });
  await assert.rejects(() => bridge.get("BITUNIX_API_KEY"));
});

// ── Fehlender Datensatz → null, nicht Env ───────────────────────────────────

test("SEC-07: Fehlender Datensatz → null, nicht stilles Env (Bitunix)", async () => {
  (process.env as any).NODE_ENV = "production";
  const store = memStore(); // leer
  const bridge = createVenueBackedNamedStore({
    venue: "BITUNIX",
    store,
    envFallback: { async get() { return "env-key"; } },
    keyName: "BITUNIX_API_KEY",
    secretName: "BITUNIX_API_SECRET",
  });
  assert.equal(await bridge.get("BITUNIX_API_KEY"), null);
  assert.equal(await bridge.get("BITUNIX_API_SECRET"), null);
});

test("SEC-07: Fehlender Datensatz → null, nicht stilles Env (Alpaca)", async () => {
  (process.env as any).NODE_ENV = "production";
  const store = memStore();
  const bridge = createVenueBackedNamedStore({
    venue: "ALPACA",
    store,
    envFallback: { async get() { return "env-key"; } },
    keyName: "ALPACA_API_KEY",
    secretName: "ALPACA_API_SECRET",
  });
  assert.equal(await bridge.get("ALPACA_API_KEY"), null);
});

// ── Control-Plane configured == Adapter-Verhalten ───────────────────────────

test("SEC-07: Control-Plane configured entspricht Adapter-Verhalten (Bitunix)", async () => {
  (process.env as any).NODE_ENV = "production";
  const store = memStore();
  // Simuliere: Control Plane hat keinen Datensatz → configured = false
  const configured = await store.exists("BITUNIX");
  assert.equal(configured, false);

  const bridge = createVenueBackedNamedStore({
    venue: "BITUNIX",
    store,
    envFallback: { async get() { return "env-key-present"; } },
    keyName: "BITUNIX_API_KEY",
    secretName: "BITUNIX_API_SECRET",
  });
  const adapterCred = await bridge.get("BITUNIX_API_KEY");
  // Nach Fix: Adapter hat ebenfalls kein Credential
  assert.equal(adapterCred, null);
  assert.equal(configured, false);
  assert.equal(adapterCred === null, !configured);
});

test("SEC-07: Control-Plane configured entspricht Adapter-Verhalten (Alpaca)", async () => {
  (process.env as any).NODE_ENV = "production";
  const store = memStore();
  await store.put("ALPACA", { apiKey: "k-abcdef0123456789", apiSecret: "s-abcdef0123456789" });
  const configured = await store.exists("ALPACA");
  assert.equal(configured, true);

  const bridge = createVenueBackedNamedStore({
    venue: "ALPACA",
    store,
    envFallback: { async get() { return "env"; } },
    keyName: "ALPACA_API_KEY",
    secretName: "ALPACA_API_SECRET",
  });
  const adapterCred = await bridge.get("ALPACA_API_KEY");
  assert.equal(adapterCred !== null, configured);
});

// ── Dev/Test-Fallback nur hinter explizitem Flag ────────────────────────────

test("SEC-07: Dev-Modus ohne Flag → kein Env-Fallback", async () => {
  (process.env as any).NODE_ENV = "development";
  const store = memStore();
  const bridge = createVenueBackedNamedStore({
    venue: "BITUNIX",
    store,
    envFallback: { async get() { return "env-key"; } },
    keyName: "BITUNIX_API_KEY",
    secretName: "BITUNIX_API_SECRET",
    // allowEnvFallback nicht gesetzt
  });
  assert.equal(await bridge.get("BITUNIX_API_KEY"), null);
});

test("SEC-07: Dev-Modus mit BROKER_ALLOW_ENV_FALLBACK=true → Env-Fallback erlaubt", async () => {
  (process.env as any).NODE_ENV = "development";
  const store = memStore();
  const bridge = createVenueBackedNamedStore({
    venue: "BITUNIX",
    store,
    envFallback: { async get() { return "env-key-dev"; } },
    keyName: "BITUNIX_API_KEY",
    secretName: "BITUNIX_API_SECRET",
    allowEnvFallback: true,
  });
  assert.equal(await bridge.get("BITUNIX_API_KEY"), "env-key-dev");
});

test("SEC-07: Produktion mit BROKER_ALLOW_ENV_FALLBACK=true → trotzdem kein Fallback (Defense in Depth)", async () => {
  (process.env as any).NODE_ENV = "production";
  const store = memStore();
  const bridge = createVenueBackedNamedStore({
    venue: "BITUNIX",
    store,
    envFallback: { async get() { return "env-key-prod"; } },
    keyName: "BITUNIX_API_KEY",
    secretName: "BITUNIX_API_SECRET",
    allowEnvFallback: true, // selbst true in Prod ignoriert
  });
  assert.equal(await bridge.get("BITUNIX_API_KEY"), null);
});

test("SEC-07: Dev-Modus mit Flag — Store-Fehler darf auf Env zurueckfallen (expliziter Dev-Komfort)", async () => {
  (process.env as any).NODE_ENV = "development";
  const failingStore: VenueSecretStore = {
    async put() {},
    async get() { throw new SecretStoreError("STORAGE_UNAVAILABLE", "db down"); },
    async delete() { return false; },
    async exists() { return false; },
  };
  const bridge = createVenueBackedNamedStore({
    venue: "BITUNIX",
    store: failingStore,
    envFallback: { async get() { return "env-fallback-dev"; } },
    keyName: "BITUNIX_API_KEY",
    secretName: "BITUNIX_API_SECRET",
    allowEnvFallback: true,
  });
  // In Dev mit Flag ist Fallback erlaubt (mit Warnung)
  assert.equal(await bridge.get("BITUNIX_API_KEY"), "env-fallback-dev");
});

// ── Default-Store Fabriken (Bitunix/Alpaca) ─────────────────────────────────

test("SEC-07: createDefaultBitunixSecretStore — ohne SECRET_STORE_KEY und ohne Flag → kein Credential", async () => {
  (process.env as any).NODE_ENV = "production";
  const { createDefaultBitunixSecretStore } = await import("../src/brokers/bitunix/secrets");
  const store = createDefaultBitunixSecretStore({
    BITUNIX_API_KEY: "env-key-abcdef0123456789",
    BITUNIX_API_SECRET: "env-secret-abcdef012345",
    NODE_ENV: "production",
  });
  assert.equal(await store.get("BITUNIX_API_KEY"), null);
  assert.equal(await store.get("BITUNIX_API_SECRET"), null);
});

test("SEC-07: createDefaultBitunixSecretStore — ohne SECRET_STORE_KEY aber mit Flag in Dev → Env-Fallback", async () => {
  const { createDefaultBitunixSecretStore } = await import("../src/brokers/bitunix/secrets");
  const store = createDefaultBitunixSecretStore({
    BITUNIX_API_KEY: "env-key-abcdef0123456789",
    BITUNIX_API_SECRET: "env-secret-abcdef012345",
    BROKER_ALLOW_ENV_FALLBACK: "true",
    NODE_ENV: "development",
  });
  assert.equal(await store.get("BITUNIX_API_KEY"), "env-key-abcdef0123456789");
});

test("SEC-07: createDefaultAlpacaSecretStore — ohne SECRET_STORE_KEY und ohne Flag → kein Credential", async () => {
  (process.env as any).NODE_ENV = "production";
  const { createDefaultAlpacaSecretStore } = await import("../src/brokers/alpaca/secrets");
  const store = createDefaultAlpacaSecretStore({
    ALPACA_API_KEY: "env-key-abcdef0123456789",
    ALPACA_API_SECRET: "env-secret-abcdef012345",
    NODE_ENV: "production",
  });
  assert.equal(await store.get("ALPACA_API_KEY"), null);
});

test("SEC-07: createDefaultAlpacaSecretStore — ohne SECRET_STORE_KEY aber mit Flag in Dev → Env-Fallback", async () => {
  const { createDefaultAlpacaSecretStore } = await import("../src/brokers/alpaca/secrets");
  const store = createDefaultAlpacaSecretStore({
    ALPACA_API_KEY: "env-key-abcdef0123456789",
    ALPACA_API_SECRET: "env-secret-abcdef012345",
    BROKER_ALLOW_ENV_FALLBACK: "true",
    NODE_ENV: "development",
  });
  assert.equal(await store.get("ALPACA_API_KEY"), "env-key-abcdef0123456789");
});

// ── Angriffsvektoren ────────────────────────────────────────────────────────

test("SEC-07: Angreifer korrumpiert Envelope — AUTH_FAILED fuehrt zu HARD FAIL, nicht zu Env-Credentials", async () => {
  (process.env as any).NODE_ENV = "production";
  // Simuliere korruptes Envelope via failing store
  const corruptedStore: VenueSecretStore = {
    async put() {},
    async get() { throw new SecretStoreError("AUTH_FAILED", "Envelope korrupt / Auth-Tag Fehler"); },
    async delete() { return false; },
    async exists() { return true; }, // Control Plane koennte noch configured=true zeigen, bis get fehlschlaegt
  };
  const bridge = createVenueBackedNamedStore({
    venue: "BITUNIX",
    store: corruptedStore,
    envFallback: { async get() { return "attacker-controlled-env-key"; } },
    keyName: "BITUNIX_API_KEY",
    secretName: "BITUNIX_API_SECRET",
  });
  // Muss werfen, nicht auf Angreifer-kontrollierten Env-Wert zurueckfallen
  await assert.rejects(() => bridge.get("BITUNIX_API_KEY"));
});

test("SEC-07: Angreifer loescht Credential — fehlender Datensatz fuehrt zu null, nicht zu Env", async () => {
  (process.env as any).NODE_ENV = "production";
  const store = memStore();
  await store.put("BITUNIX", { apiKey: "legit-key-abcdef0123456789", apiSecret: "legit-secret-abcdef012345" });
  await store.delete("BITUNIX"); // Angreifer loescht
  const bridge = createVenueBackedNamedStore({
    venue: "BITUNIX",
    store,
    envFallback: { async get() { return "attacker-env-key"; } },
    keyName: "BITUNIX_API_KEY",
    secretName: "BITUNIX_API_SECRET",
  });
  assert.equal(await bridge.get("BITUNIX_API_KEY"), null);
});

test("SEC-07: Angreifer setzt Env-Vars — in Produktion werden sie ignoriert", async () => {
  (process.env as any).NODE_ENV = "production";
  const store = memStore(); // kein Credential im sicheren Store
  const bridge = createVenueBackedNamedStore({
    venue: "BITUNIX",
    store,
    envFallback: { async get() { return "attacker-env-key"; } },
    keyName: "BITUNIX_API_KEY",
    secretName: "BITUNIX_API_SECRET",
  });
  // Selbst wenn Env-Vars gesetzt sind, in Prod kein Zugriff
  assert.equal(await bridge.get("BITUNIX_API_KEY"), null);
});
