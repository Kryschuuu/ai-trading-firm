/**
 * SEC-09 Regression: Secret-Memory-Hygiene — ehrliche JS-String-Grenze.
 *
 * Root Cause aus dem Finding: Der Secret-Store behauptete, es entstuenden
 * „keine langlebigen Strings“ — tatsaechlich erzeugt der Parse-Pfad
 * (`plaintext.toString(\"utf8\")` → `JSON.parse` → `CredentialPayload`)
 * unveraenderliche JS-Strings im Heap, die NICHT deterministisch genullt
 * werden koennen. `disposeCredential()` hat zudem nur eine Buffer-Kopie
 * genullt und die Original-Strings unangetastet gelassen (Placebo).
 *
 * Kein Remote-Angriffspfad (LOW) — relevant bei Heap-Dump, Crash-Dumps,
 * Debugging, Process Compromise und forensischem Speicherzugriff. Diese
 * Tests sichern den Fix ab:
 *   1. `disposeCredential()` verwirft Referenzen tatsaechlich (GC-Freigabe),
 *      statt ein Nullen vorzutauschen.
 *   2. Buffer-Hygiene (`zeroize` auf Krypto-/Key-Material) bleibt erhalten.
 *   3. Code und Doku behaupten keine String-Nullung mehr (Docs-as-Code-Scan).
 *   4. Betriebs-Hinweise (kein Inspector, keine Heap-/Core-Dumps) existieren.
 *   5. Der Store cached keine Credential-Objekte (minimales Zeitfenster).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MemorySecretStorage,
  createAesGcmSecretStore,
  openEnvelope,
  sealEnvelope,
  zeroize,
  type CredentialPayload,
  type VenueSecretStore,
} from "../src/brokers/control-plane/secretStore";
import {
  disposeCredential,
  probePermissions,
} from "../src/brokers/control-plane/probe";

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

function readRepoFile(rel: string): string {
  return readFileSync(path.resolve(process.cwd(), rel), "utf8");
}

// ── 1. disposeCredential verwirft Referenzen tatsaechlich ────────────────────

test("SEC-09: disposeCredential leert die Credential-Felder (Referenzen fallen lassen)", () => {
  const credential: CredentialPayload = {
    apiKey: "live-key-abcdef0123456789",
    apiSecret: "live-secret-abcdef012345",
  };
  disposeCredential(credential);
  // Vor dem Fix blieben die Original-Strings unangetastet (nur eine
  // Buffer-Kopie wurde genullt) — dieser Test war rot.
  assert.equal(credential.apiKey, "");
  assert.equal(credential.apiSecret, "");
});

test("SEC-09: disposeCredential ist cleanup-sicher (null + gefrorene Objekte werfen nicht)", () => {
  assert.doesNotThrow(() => disposeCredential(null));
  const frozen = Object.freeze({
    apiKey: "frozen-key-abcdef0123456789",
    apiSecret: "frozen-secret-abcdef0123",
  }) as CredentialPayload;
  assert.doesNotThrow(() => disposeCredential(frozen));
});

test("SEC-09: Probe-Flow schliesst das Zeitfenster (nach dispose unbrauchbar)", async () => {
  const credential: CredentialPayload = {
    apiKey: "probe-key-abcdef0123456789",
    apiSecret: "probe-secret-abcdef012345",
  };
  // Gleiche Reihenfolge wie ControlPlaneService.saveCredentials/testConnection:
  // Probe mit transientem Wert, danach sofort verwerfen.
  const outcome = await probePermissions("BITUNIX", credential);
  assert.equal(outcome.ok, true);
  disposeCredential(credential);
  assert.equal(credential.apiKey, "");
  assert.equal(credential.apiSecret, "");
});

// ── 2. Buffer-Hygiene bleibt erhalten ────────────────────────────────────────

test("SEC-09: zeroize nullt Krypto-/Key-Buffer deterministisch (Regression)", () => {
  const key = Buffer.alloc(32, 0xab);
  zeroize(key);
  assert.ok(key.every((byte) => byte === 0));
  assert.equal(key.length, 32);

  const secret = Buffer.from("super-geheimes-key-material", "utf8");
  zeroize(secret);
  assert.ok(secret.every((byte) => byte === 0));
});

test("SEC-09: Envelope enthaelt keinen Klartext (Buffer-Pfad intakt)", () => {
  const key = Buffer.alloc(32, 3);
  try {
    const plaintext = Buffer.from(JSON.stringify(VALID), "utf8");
    try {
      const envelope = sealEnvelope(key, plaintext, "BITUNIX");
      assert.ok(!envelope.includes(VALID.apiKey));
      assert.ok(!envelope.includes(VALID.apiSecret));
      const opened = openEnvelope(key, envelope, "BITUNIX");
      try {
        assert.equal(opened.toString("utf8"), JSON.stringify(VALID));
      } finally {
        zeroize(opened);
        assert.ok(opened.every((byte) => byte === 0));
      }
    } finally {
      zeroize(plaintext);
    }
  } finally {
    zeroize(key);
  }
});

// ── 3. Keine Retention: frische Objekte, kein Caching ────────────────────────

test("SEC-09: Store haelt keine Credential-Referenzen (Put-Eingabe + Get-Ergebnis entkoppelt)", async () => {
  const store = memStore();
  const input: CredentialPayload = { ...VALID };
  await store.put("ALPACA", input);
  // Angreifer-Perspektive: Spaetere Mutation des Eingabe-Objekts darf den
  // gespeicherten Datensatz nicht aendern (kein Referenz-Leak in den Store).
  input.apiKey = "MUTATED-AFTER-PUT-0123456789";
  input.apiSecret = "MUTATED-AFTER-PUT-0123456789";
  const first = await store.get("ALPACA");
  assert.deepEqual(first, VALID);

  // Umgekehrt: Mutation eines Get-Ergebnisses betrifft weder Store noch
  // spaetere Get-Aufrufe (frische Kopie je Aufruf, kein Singleton-Cache).
  first!.apiKey = "MUTATED-AFTER-GET-01234567890";
  const second = await store.get("ALPACA");
  assert.deepEqual(second, VALID);
  assert.notEqual(first, second);
});

// ── 4. Docs-as-Code: keine falschen Nullungs-Versprechen mehr ───────────────

test("SEC-09: Quellcode behauptet keine JS-String-Nullung mehr (war rot vor dem Fix)", () => {
  const sources = [
    "src/brokers/control-plane/secretStore.ts",
    "src/brokers/control-plane/probe.ts",
    "src/brokers/control-plane/service.ts",
  ];
  // Jede dieser Formulierungen versprach (direkt oder implizit), dass
  // Klartext-Strings deterministisch genullt wuerden — in JS unmoeglich.
  const forbidden = [
    "keine langlebigen Strings",
    "nie als langlebiger String",
    "zeroizeCredential",
    "verworfen (zeroize)",
  ];
  for (const rel of sources) {
    const content = readRepoFile(rel);
    for (const phrase of forbidden) {
      assert.ok(
        !content.includes(phrase),
        `${rel} enthaelt irrefuehrende Formulierung: \"${phrase}\"`
      );
    }
  }
  // Die ehrliche Grenze ist an sicherheitskritischer Stelle dokumentiert.
  assert.ok(
    readRepoFile("src/brokers/control-plane/secretStore.ts").includes("SEC-09"),
    "secretStore.ts dokumentiert die SEC-09-Grenze nicht"
  );
  assert.ok(
    readRepoFile("src/brokers/control-plane/probe.ts").includes("SEC-09"),
    "probe.ts dokumentiert die SEC-09-Grenze nicht"
  );
});

test("SEC-09: Doku beschreibt JS-String-Grenze + Betriebsschutz (war rot vor dem Fix)", () => {
  const controlPlane = readRepoFile("docs/FRONTEND_CONTROL_PLANE.md");
  assert.ok(
    !controlPlane.includes("verworfen/genullt"),
    "FRONTEND_CONTROL_PLANE.md behauptet weiterhin String-Nullung"
  );
  for (const marker of ["SEC-09", "zeroize", "Inspector", "Core-Dumps"]) {
    assert.ok(
      controlPlane.includes(marker),
      `FRONTEND_CONTROL_PLANE.md enthaelt Pflicht-Marker nicht: \"${marker}\"`
    );
  }
  const security = readRepoFile("docs/security/README.md");
  for (const marker of [
    "Secret-Memory-Hygiene (SEC-09)",
    "--inspect",
    "ulimit -c 0",
  ]) {
    assert.ok(
      security.includes(marker),
      `docs/security/README.md enthaelt Pflicht-Marker nicht: \"${marker}\"`
    );
  }
});
