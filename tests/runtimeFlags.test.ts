/**
 * Laufzeit-Schalter (UI) — Store, Provider-Freigaben und Broker-Remote-Check.
 *
 * Sicherheitsinvarianten, die hier festgenagelt werden:
 *   1. Ohne gesetzten Schalter gilt der Env-Default (Default AUS beim
 *      Broker-Remote-Check, AN bei Providern).
 *   2. Ein Runtime-Flag (UI) hat Vorrang — aber nur für erlaubte Bool-Werte.
 *   3. Ein gesperrter Provider wird vom Router nie gewählt und **nie**
 *      abgefragt (kein Netzwerkverkehr, kein Health-Ping).
 *   4. Die Ablage ist eine JSON-Datei mit ausschließlich Bool-Werten; der Pfad
 *      geht durch `resolveRuntimePath` (`..`-Ausbruch ⇒ Fehler) und ist per
 *      `RUNTIME_FLAGS_FILE` umlenkbar (Tests, externe Volumes).
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearRuntimeFlag,
  envFlagDefault,
  readRuntimeFlags,
  resetRuntimeFlagsCacheForTests,
  resolveFlagsFile,
  resolveRuntimeFlag,
  runtimeFlagValue,
  setRuntimeFlag,
  type RuntimeFlagSpec,
} from "../src/lib/runtimeFlags";
import {
  DISABLED_PROVIDERS_ENV,
  PROVIDER_DISABLED_REASON,
  disabledProvidersFromEnv,
  filterEnabledProviders,
  isProviderEnabled,
  providerToggleKey,
  providerToggleSpecs,
  providerToggleView,
  setProviderEnabled,
} from "../src/routing/providerToggles";
import { EnvProviderRegistry } from "../src/routing/registry";
import { PROVIDER_IDS } from "../src/routing/types";
import {
  REMOTE_HEALTHCHECK_SPEC,
  remoteHealthCheckEnabled,
  resolveRemoteHealthcheck,
} from "../src/brokers/health";
import { resolveProviderChain } from "../src/lib/llmProvider";

const tmpDirs: string[] = [];
let flagsFile = "";

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "runtime-flags-"));
  tmpDirs.push(dir);
  return dir;
}

const TEST_SPEC: RuntimeFlagSpec = {
  key: "test.flag",
  label: "Test-Schalter",
  description: "nur für Tests",
  defaultValue: false,
};

beforeEach(() => {
  flagsFile = path.join(tmpDir(), "flags.json");
  process.env.RUNTIME_FLAGS_FILE = flagsFile;
  resetRuntimeFlagsCacheForTests();
});

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  delete process.env.RUNTIME_FLAGS_FILE;
  delete process.env.ROUTING_DISABLED_PROVIDERS;
  resetRuntimeFlagsCacheForTests();
});

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

test("Store: ohne Datei gilt der Code-Default (kein Flag gesetzt)", () => {
  const view = resolveRuntimeFlag(TEST_SPEC, {});
  assert.equal(view.value, false);
  assert.equal(view.source, "default");
  assert.equal(runtimeFlagValue(TEST_SPEC.key, {}), null);
  const read = readRuntimeFlags({});
  assert.deepEqual(read.flags, {});
  assert.equal(read.error, null);
});

test("Store: Env-Variable setzt den Default (nur exakt 'true' = an)", () => {
  const spec: RuntimeFlagSpec = { ...TEST_SPEC, envVar: "TEST_FLAG_ENV" };
  assert.equal(envFlagDefault(spec, { TEST_FLAG_ENV: "true" }), true);
  assert.equal(envFlagDefault(spec, { TEST_FLAG_ENV: "1" }), false, "nur exakt true");
  assert.equal(envFlagDefault(spec, { TEST_FLAG_ENV: "" }), false);
  assert.equal(resolveRuntimeFlag(spec, { TEST_FLAG_ENV: "true" }).source, "env");
});

test("Store: setzen schreibt atomar (0600), lesen liefert Wert + Quelle runtime", () => {
  const result = setRuntimeFlag(TEST_SPEC, true, { by: "admin", env: process.env });
  assert.equal(result.ok, true);
  assert.ok(statSync(flagsFile).isFile());
  // restriktive Rechte (nur Besitzer). Windows/umask-tolerant geprüft.
  const mode = statSync(flagsFile).mode & 0o777;
  if (mode !== 0) assert.equal(mode & 0o077, 0, "keine Gruppen-/Other-Rechte");

  resetRuntimeFlagsCacheForTests();
  assert.equal(runtimeFlagValue(TEST_SPEC.key), true);
  const resolved = resolveRuntimeFlag({ ...TEST_SPEC, envVar: "TEST_FLAG_ENV" }, {
    TEST_FLAG_ENV: "false",
  });
  assert.equal(resolved.value, true, "Runtime-Flag gewinnt gegen Env");
  assert.equal(resolved.source, "runtime");

  const stored = JSON.parse(readFileSync(flagsFile, "utf8")) as Record<string, { value: boolean }>;
  assert.equal(stored[TEST_SPEC.key].value, true);
});

test("Store: zurücksetzen stellt den Env-Default wieder her", () => {
  const spec: RuntimeFlagSpec = { ...TEST_SPEC, envVar: "TEST_FLAG_ENV" };
  setRuntimeFlag(spec, true, { env: process.env });
  resetRuntimeFlagsCacheForTests();
  const cleared = clearRuntimeFlag(spec.key, process.env);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.removed, true);
  resetRuntimeFlagsCacheForTests();
  assert.equal(runtimeFlagValue(spec.key), null);
  assert.deepEqual(resolveRuntimeFlag(spec, { TEST_FLAG_ENV: "true" }), {
    value: true,
    source: "env",
  });
});

test("Store: kaputte Datei ist fail-soft (leer + sichtbarer Fehler, kein Wurf)", () => {
  writeFileSync(flagsFile, "{ das ist kein json");
  resetRuntimeFlagsCacheForTests();
  const read = readRuntimeFlags({});
  assert.deepEqual(read.flags, {});
  assert.equal(read.error, "FLAGS_FILE_UNREADABLE");

  // Ungültige Werte werden je Eintrag verworfen, gültige übernommen.
  writeFileSync(
    flagsFile,
    JSON.stringify({ "a.flag": true, "b.flag": "ja", "c.flag": { value: false } })
  );
  resetRuntimeFlagsCacheForTests();
  const second = readRuntimeFlags({});
  assert.deepEqual(second.flags, { "a.flag": true, "c.flag": false });
  assert.equal(second.error, null);
});

test("Store: Pfad-Ausbruch über RUNTIME_FLAGS_FILE wird abgelehnt", () => {
  assert.throws(() => resolveFlagsFile({ RUNTIME_FLAGS_FILE: "../../etc/passwd" }));
});

test("Store: Nur-Bool-Datei — geschriebene Datei enthält keine Secrets/Freitexte", () => {
  setRuntimeFlag(TEST_SPEC, false, { by: "operator" });
  const raw = readFileSync(flagsFile, "utf8");
  assert.ok(raw.includes('"value": false'));
  assert.ok(!/http|key|token|secret/i.test(raw), `Datei enthält nur Bool + Metadaten: ${raw}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Provider-Schalter
// ─────────────────────────────────────────────────────────────────────────────

test("Provider: Default ist freigegeben, Env-Sperrliste schaltet ab", () => {
  assert.equal(isProviderEnabled("opencode", {}), true);
  const disabled = disabledProvidersFromEnv({
    [DISABLED_PROVIDERS_ENV]: "gemini, opencode, gibt-es-nicht",
  });
  assert.deepEqual(disabled, ["gemini", "opencode"], "unbekannte Werte werden verworfen");
  assert.equal(isProviderEnabled("opencode", { [DISABLED_PROVIDERS_ENV]: "opencode" }), false);
  assert.equal(isProviderEnabled("ollama", { [DISABLED_PROVIDERS_ENV]: "opencode" }), true);
});

test("Provider: UI-Flag hat Vorrang vor der Env-Sperrliste (in beide Richtungen)", () => {
  const specs = providerToggleSpecs();
  assert.deepEqual(
    specs.map((s) => s.key),
    PROVIDER_IDS.map((id) => providerToggleKey(id)),
    "je Provider genau ein Schalter"
  );

  // Env sperrt gemini; UI gibt es wieder frei.
  const env = { [DISABLED_PROVIDERS_ENV]: "gemini" };
  assert.equal(isProviderEnabled("gemini", env), false);
  assert.equal(setProviderEnabled("gemini", true, { env, by: "admin" }).ok, true);
  assert.equal(isProviderEnabled("gemini", env), true);
  assert.equal(providerToggleView("gemini", env).source, "runtime");

  // UI sperrt anthropic, obwohl die Env-Liste es nicht nennt.
  assert.equal(setProviderEnabled("anthropic", false, { env, by: "admin" }).ok, true);
  assert.equal(isProviderEnabled("anthropic", env), false);
  assert.equal(setProviderEnabled("anthropic", null, { env }).ok, true, "auf Default zurücksetzen");
  assert.equal(isProviderEnabled("anthropic", env), true);
});

test("Provider: unbekannter Provider wird abgelehnt", () => {
  const result = setProviderEnabled("gpt-99", true, { env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error, "UNKNOWN_PROVIDER");
});

test("Provider: Registry projiziert gesperrte Provider als offline mit Begründung", () => {
  const env = { [DISABLED_PROVIDERS_ENV]: "opencode" };
  const registry = new EnvProviderRegistry(env);
  const card = registry.get("opencode")!;
  assert.equal(card.enabled, false);
  assert.equal(card.healthStatus, "offline");
  assert.equal(card.quotaRest, 0);
  assert.equal(card.error, PROVIDER_DISABLED_REASON);

  const free = registry.get("ollama")!;
  assert.equal(free.enabled, true);
  assert.notEqual(free.error, PROVIDER_DISABLED_REASON);
});

test("Provider: refresh() fragt gesperrte Provider NICHT ab (kein Netzwerk)", async () => {
  const env = {
    [DISABLED_PROVIDERS_ENV]: PROVIDER_IDS.join(","),
    OLLAMA_BASE_URL: "http://127.0.0.1:1",
  };
  const registry = new EnvProviderRegistry(env);

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const cards = await registry.refresh();
    assert.equal(fetchCalls, 0, "gesperrte Provider werden nicht abgefragt");
    for (const card of cards) {
      assert.equal(card.enabled, false);
      assert.equal(card.healthStatus, "offline");
      assert.equal(card.error, PROVIDER_DISABLED_REASON);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Provider: resolveProviderChain überspringt gesperrte Provider", () => {
  const env = {
    LLM_PROVIDER: "opencode",
    LLM_FALLBACK_PROVIDERS: "gemini,ollama",
    [DISABLED_PROVIDERS_ENV]: "opencode,gemini",
  };
  assert.deepEqual(resolveProviderChain(env), ["ollama"]);

  // Alles gesperrt ⇒ leere Kette (Aufrufer nutzt die deterministische Engine).
  assert.deepEqual(
    resolveProviderChain({ ...env, [DISABLED_PROVIDERS_ENV]: "opencode,gemini,ollama" }),
    []
  );

  // Ohne Sperre bleibt die Reihenfolge unverändert.
  assert.deepEqual(
    resolveProviderChain({ LLM_PROVIDER: "opencode", LLM_FALLBACK_PROVIDERS: "ollama" }),
    ["opencode", "ollama"]
  );
  assert.deepEqual(filterEnabledProviders(["opencode", "ollama"], {}), ["opencode", "ollama"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Broker-Remote-Check (bestehender Env-Schalter + neuer UI-Schalter)
// ─────────────────────────────────────────────────────────────────────────────

test("Remote-Check: Default aus, Env an, UI-Schalter gewinnt", () => {
  assert.equal(remoteHealthCheckEnabled({}), false);
  assert.equal(resolveRemoteHealthcheck({}).source, "default");
  assert.equal(remoteHealthCheckEnabled({ BROKER_HEALTHCHECK_REMOTE: "true" }), true);
  assert.equal(
    resolveRemoteHealthcheck({ BROKER_HEALTHCHECK_REMOTE: "true" }).source,
    "env"
  );

  // UI-Schalter an, obwohl die .env „false" sagt.
  const on = setRuntimeFlag(REMOTE_HEALTHCHECK_SPEC, true, { env: process.env });
  assert.equal(on.ok, true);
  const envOff = { BROKER_HEALTHCHECK_REMOTE: "false" };
  assert.equal(remoteHealthCheckEnabled(envOff), true);
  assert.equal(resolveRemoteHealthcheck(envOff).source, "runtime");

  // UI-Schalter aus, obwohl die .env „true" sagt.
  const off = setRuntimeFlag(REMOTE_HEALTHCHECK_SPEC, false, { env: process.env });
  assert.equal(off.ok, true);
  assert.equal(remoteHealthCheckEnabled({ BROKER_HEALTHCHECK_REMOTE: "true" }), false);
});
