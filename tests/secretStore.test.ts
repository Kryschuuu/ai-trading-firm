/**
 * Unit-Tests des verschluesselten Secret-Stores (Task 08).
 *
 * Pflicht laut DoD:
 *   - Roundtrip put/get
 *   - falscher Schluessel → Fehler (Auth-Tag)
 *   - Tampering (Ciphertext-Manipulation) → Fehler (Auth-Tag)
 *   - AAD-Bindung (Datensatz einer anderen Venue) → Fehler
 *   - Buffer-Nullung (zeroize)
 *   - Env-/KMS-Key-Handling, Backend-Fallback, Task-07-Bridge
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EnvKmsClient,
  FileSecretStorage,
  MemorySecretStorage,
  SecretStoreError,
  assertValidCredential,
  assertValidVenueId,
  createAesGcmSecretStore,
  createVenueBackedNamedStore,
  deriveStoreKey,
  openEnvelope,
  resolveSecretStorage,
  sealEnvelope,
  zeroize,
  type CredentialPayload,
  type VenueSecretStore,
} from "../src/brokers/control-plane/secretStore";

const KEY = Buffer.alloc(32, 7);

function memStore(): VenueSecretStore {
  return createAesGcmSecretStore({
    storage: new MemorySecretStorage(),
    keyBuffer: KEY,
  });
}

const VALID: CredentialPayload = {
  apiKey: "k-abcdef0123456789",
  apiSecret: "s-abcdef0123456789",
};

beforeEach(() => {
  delete process.env.SECRET_STORE_KEY;
});

// ── Roundtrip ───────────────────────────────────────────────────────────────

test("SecretStore: put/get-Roundtrip (AES-256-GCM) liefert exakt das Credential", async () => {
  const store = memStore();
  await store.put("ALPACA", VALID);
  assert.equal(await store.exists("ALPACA"), true);
  const got = await store.get("ALPACA");
  assert.deepEqual(got, VALID);
});

test("SecretStore: get ohne put → null, delete → false/true-Semantik", async () => {
  const store = memStore();
  assert.equal(await store.get("KRAKEN"), null);
  assert.equal(await store.delete("KRAKEN"), false);
  await store.put("KRAKEN", VALID);
  assert.equal(await store.delete("KRAKEN"), true);
  assert.equal(await store.get("KRAKEN"), null);
  assert.equal(await store.exists("KRAKEN"), false);
});

test("SecretStore: get liefert frische Objekte (Mutieren des Ergebnisses aendert nichts)", async () => {
  const store = memStore();
  await store.put("BINANCE", VALID);
  const first = await store.get("BINANCE");
  first!.apiKey = "TAMPERED";
  const second = await store.get("BINANCE");
  assert.equal(second!.apiKey, VALID.apiKey);
});

// ── Wrong-Key / Tampering / AAD ─────────────────────────────────────────────

test("SecretStore: falscher Schluessel → AUTH_FAILED (Auth-Tag)", async () => {
  const storage = new MemorySecretStorage();
  const storeA = createAesGcmSecretStore({ storage, keyBuffer: Buffer.alloc(32, 1) });
  const storeB = createAesGcmSecretStore({ storage, keyBuffer: Buffer.alloc(32, 2) });
  await storeA.put("ALPACA", VALID);
  await assert.rejects(
    () => storeB.get("ALPACA"),
    (err: unknown) =>
      err instanceof SecretStoreError && err.code === "AUTH_FAILED"
  );
});

test("SecretStore: Ciphertext-Manipulation → AUTH_FAILED (Auth-Tag)", async () => {
  const storage = new MemorySecretStorage();
  const store = createAesGcmSecretStore({ storage, keyBuffer: KEY });
  await store.put("IBKR", VALID);

  const envelopeText = (await storage.read("IBKR"))!;
  const envelope = JSON.parse(envelopeText) as { iv: string; tag: string; ct: string };
  // Ein Byte des Ciphertexts flippen — muss am Auth-Tag scheitern.
  const ct = Buffer.from(envelope.ct, "base64");
  ct[0] = ct[0] === 0x00 ? 0xff : ct[0] ^ 0xff;
  envelope.ct = ct.toString("base64");
  await storage.write("IBKR", JSON.stringify(envelope));

  await assert.rejects(
    () => store.get("IBKR"),
    (err: unknown) =>
      err instanceof SecretStoreError && err.code === "AUTH_FAILED"
  );
});

test("SecretStore: AAD-Bindung — Envelope einer ANDEREN Venue → AUTH_FAILED", async () => {
  const key = Buffer.alloc(32, 9);
  // Envelope fuer ALPACA erzeugen, aber unter BINANCE ablegen:
  const plaintext = Buffer.from(
    JSON.stringify(VALID),
    "utf8"
  );
  const envelope = sealEnvelope(key, plaintext, "ALPACA");
  const storage = new MemorySecretStorage();
  await storage.write("BINANCE", envelope); // falsche Venue-Zuordnung

  const store = createAesGcmSecretStore({ storage, keyBuffer: key });
  await assert.rejects(
    () => store.get("BINANCE"),
    (err: unknown) =>
      err instanceof SecretStoreError && err.code === "AUTH_FAILED"
  );
});

test("SecretStore: openEnvelope mit falscher Venue direkt → AUTH_FAILED", async () => {
  const key = Buffer.alloc(32, 5);
  const envelope = sealEnvelope(key, Buffer.from("{}", "utf8"), "DYDX");
  assert.throws(
    () => openEnvelope(key, envelope, "KRAKEN"),
    (err: unknown) =>
      err instanceof SecretStoreError && err.code === "AUTH_FAILED"
  );
  // Mit der RICHTIGEN Venue oeffnet das Envelope:
  const opened = openEnvelope(key, envelope, "DYDX");
  assert.equal(opened.toString("utf8"), "{}");
});

test("SecretStore: kaputtes Envelope (kein JSON / falsche Form) → INVALID_ENVELOPE", async () => {
  const storage = new MemorySecretStorage();
  await storage.write("ALPACA", "das-ist-kein-envelope");
  const store = createAesGcmSecretStore({ storage, keyBuffer: KEY });
  await assert.rejects(
    () => store.get("ALPACA"),
    (err: unknown) =>
      err instanceof SecretStoreError && err.code === "INVALID_ENVELOPE"
  );
});

// ── Buffer-Nullung / Memory-Hygiene ─────────────────────────────────────────

test("zeroize: Buffer wird deterministisch genullt", () => {
  const buf = Buffer.from("super-geheimes-secret", "utf8");
  zeroize(buf);
  assert.ok(buf.every((byte) => byte === 0));
  assert.equal(buf.length, "super-geheimes-secret".length);
});

test("sealEnvelope/openEnvelope: keine Klartext-Spur im Envelope", async () => {
  const key = Buffer.alloc(32, 3);
  const plaintext = Buffer.from(JSON.stringify(VALID), "utf8");
  const envelope = sealEnvelope(key, plaintext, "BITUNIX");
  assert.ok(!envelope.includes(VALID.apiKey));
  assert.ok(!envelope.includes(VALID.apiSecret));
  const opened = openEnvelope(key, envelope, "BITUNIX");
  assert.equal(opened.toString("utf8"), JSON.stringify(VALID));
  zeroize(opened);
});

// ── Key-Handling ────────────────────────────────────────────────────────────

test("deriveStoreKey: Hex und Base64 (32 Byte) funktionieren; Unfug wirft", () => {
  const hex = "ab".repeat(32);
  assert.equal(deriveStoreKey(hex).length, 32);
  const b64 = Buffer.alloc(32, 11).toString("base64");
  assert.equal(deriveStoreKey(b64).length, 32);
  assert.throws(() => deriveStoreKey(""), /KEY_MISSING|SECRET_STORE_KEY/);
  assert.throws(
    () => deriveStoreKey("abcd"),
    (err: unknown) =>
      err instanceof SecretStoreError && err.code === "INVALID_KEY"
  );
});

test("EnvKmsClient: fehlender SECRET_STORE_KEY → KEY_MISSING (fail-closed)", async () => {
  const kms = new EnvKmsClient({});
  await assert.rejects(
    () => kms.resolveKey("broker-control-plane"),
    (err: unknown) =>
      err instanceof SecretStoreError && err.code === "KEY_MISSING"
  );
  const kmsOk = new EnvKmsClient({ SECRET_STORE_KEY: "ab".repeat(32) });
  assert.equal((await kmsOk.resolveKey("x")).length, 32);
});

// ── Validierung ─────────────────────────────────────────────────────────────

test("assertValidCredential: leere/zu kurze/lange Werte und Steuerzeichen → Fehler", () => {
  assert.throws(() => assertValidCredential({ apiKey: "", apiSecret: "x".repeat(20) }));
  assert.throws(() => assertValidCredential({ apiKey: "short", apiSecret: "x".repeat(20) }));
  assert.throws(() => assertValidCredential({ apiKey: "x".repeat(513), apiSecret: "x".repeat(20) }));
  assert.throws(() => assertValidCredential({ apiKey: "x\u0000".repeat(20), apiSecret: "x".repeat(20) }));
  assert.doesNotThrow(() => assertValidCredential(VALID));
});

test("assertValidVenueId: Traversal/Spaces/Laengen → Fehler; gueltige IDs ok", () => {
  assert.throws(() => assertValidVenueId("../etc"));
  assert.throws(() => assertValidVenueId("ALPACA/USD"));
  assert.throws(() => assertValidVenueId("x".repeat(33)));
  assert.doesNotThrow(() => assertValidVenueId("BITUNIX"));
  assert.doesNotThrow(() => assertValidVenueId("PAPER-TEST_01"));
});

// ── Backends ────────────────────────────────────────────────────────────────

test("FileSecretStorage: Roundtrip + delete, keine Klartext-Spur auf Disk", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "atf-secrets-"));
  try {
    const storage = new FileSecretStorage(dir);
    const store = createAesGcmSecretStore({ storage, keyBuffer: KEY });
    await store.put("ALPACA", VALID);
    assert.equal(await store.exists("ALPACA"), true);
    const raw = await storage.read("ALPACA");
    assert.ok(raw && !raw.includes(VALID.apiSecret), "Datei enthaelt keinen Klartext");
    assert.deepEqual(await store.get("ALPACA"), VALID);
    assert.equal(await store.delete("ALPACA"), true);
    assert.equal(existsSync(path.join(dir, "ALPACA.enc")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSecretStorage: explizite Backends + db→file-Fallback (ohne DATABASE_URL)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "atf-secrets-"));
  try {
    const mem = await resolveSecretStorage({ env: { BROKER_SECRET_BACKEND: "memory" } });
    assert.equal(mem.backend, "memory");
    const file = await resolveSecretStorage({
      env: { BROKER_SECRET_BACKEND: "file", BROKER_SECRET_DIR: dir },
    });
    assert.equal(file.backend, "file");
    // Default ohne DATABASE_URL: DB-Ping scheitert → Fallback file.
    const fallback = await resolveSecretStorage({
      env: { BROKER_SECRET_DIR: dir },
    });
    assert.equal(fallback.backend, "file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Task-07-Bridge ──────────────────────────────────────────────────────────

test("createVenueBackedNamedStore: entschluesselte Felder auf BITUNIX_*-Namen; Env-Fallback", async () => {
  const store = memStore();
  await store.put("BITUNIX", {
    apiKey: "bt-key-abcdef0123456789",
    apiSecret: "bt-secret-abcdef012345",
  });
  const envValues: Record<string, string> = {
    BITUNIX_API_KEY: "env-key-abcdef0123456789",
    BITUNIX_API_SECRET: "env-secret-abcdef012345",
  };
  const envFallback = {
    async get(name: string): Promise<string | null> {
      return envValues[name] ?? null;
    },
  };
  const bridge = createVenueBackedNamedStore({
    venue: "BITUNIX",
    store,
    envFallback,
    keyName: "BITUNIX_API_KEY",
    secretName: "BITUNIX_API_SECRET",
  });

  // Store gewinnt ueber Env:
  assert.equal(await bridge.get("BITUNIX_API_KEY"), "bt-key-abcdef0123456789");
  assert.equal(await bridge.get("BITUNIX_API_SECRET"), "bt-secret-abcdef012345");
  // Unbekannte Namen werden nie beantwortet:
  assert.equal(await bridge.get("ANDERER_NAME"), null);

  // Ohne Store-Datensatz greift der Env-Fallback (task-07-Verhalten):
  await store.delete("BITUNIX");
  assert.equal(await bridge.get("BITUNIX_API_KEY"), "env-key-abcdef0123456789");
  assert.equal(await bridge.get("BITUNIX_API_SECRET"), "env-secret-abcdef012345");
});
