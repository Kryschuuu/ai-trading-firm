/**
 * `GET|PUT /api/ops/toggles` — Laufzeit-Schalter über die API bedienen.
 *
 * Deckt die Sicherheits-Sequenz ab (Admin + CSRF), die Allowlist (unbekannte
 * Schlüssel ⇒ 422, keine freie Key-Value-Ablage) und die Wirksamkeit:
 * ein gesperrter Provider ist danach wirklich gesperrt (`isProviderEnabled`).
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProviderEnabled } from "../src/routing/providerToggles";
import { resetRuntimeFlagsCacheForTests } from "../src/lib/runtimeFlags";
import { scanTextForSecrets } from "../src/brokers/control-plane/secretScan";

type Handler = (req: Request) => Promise<Response>;

let GET_TOGGLES: Handler;
let PUT_TOGGLES: Handler;

const VALID_ADMIN = "adm-test-token-0123456789";
const tmpDirs: string[] = [];

before(async () => {
  ({ GET: GET_TOGGLES, PUT: PUT_TOGGLES } = await import("../src/app/api/ops/toggles/route"));
});

beforeEach(() => {
  delete process.env.FIRM_ADMIN_TOKEN;
  delete process.env.FIRM_API_TOKEN;
  delete process.env.ROUTING_DISABLED_PROVIDERS;
  const dir = mkdtempSync(path.join(os.tmpdir(), "ops-toggles-"));
  tmpDirs.push(dir);
  process.env.RUNTIME_FLAGS_FILE = path.join(dir, "flags.json");
  resetRuntimeFlagsCacheForTests();
});

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  delete process.env.RUNTIME_FLAGS_FILE;
  resetRuntimeFlagsCacheForTests();
});

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function put(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return PUT_TOGGLES(
    new Request("http://localhost/api/ops/toggles", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
    })
  );
}

test("GET liefert die Allowlist inkl. OpenCode-Provider und Broker-Remote-Schalter", async () => {
  const res = await GET_TOGGLES(new Request("http://localhost/api/ops/toggles"));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.ok, true);
  assert.deepEqual(body.set, {}, "frischer Store: kein gesetzter Wert");

  const flags = body.flags as Array<Record<string, unknown>>;
  const keys = flags.map((f) => f.key);
  assert.ok(keys.includes("broker.healthcheck.remote"));
  assert.ok(keys.includes("provider.opencode.enabled"));
  assert.ok(keys.includes("provider.ollama.enabled"));

  const remote = flags.find((f) => f.key === "broker.healthcheck.remote")!;
  assert.equal(remote.effective, false, "Remote-Checks sind Default AUS");
  assert.equal(remote.source, "default");
  assert.equal(remote.envVar, "BROKER_HEALTHCHECK_REMOTE");

  const opencode = flags.find((f) => f.key === "provider.opencode.enabled")!;
  assert.equal(opencode.effective, true, "Provider sind Default AN");
  assert.equal(opencode.mutable, true);
  assert.deepEqual(scanTextForSecrets(JSON.stringify(body)), [], "keine Secrets im Payload");
});

test("PUT ohne Admin ist verboten (403) — Schalter bleibt unverändert", async () => {
  process.env.FIRM_ADMIN_TOKEN = VALID_ADMIN;
  const res = await put({ key: "provider.opencode.enabled", value: false });
  assert.equal(res.status, 403);
  assert.equal((await json(res)).error, "FORBIDDEN");
  assert.equal(isProviderEnabled("opencode"), true);
});

test("PUT verlangt CSRF (403 CSRF_INVALID)", async () => {
  process.env.FIRM_ADMIN_TOKEN = VALID_ADMIN;
  const res = await put(
    { key: "provider.opencode.enabled", value: false },
    { "x-admin-token": VALID_ADMIN }
  );
  assert.equal(res.status, 403);
  assert.equal((await json(res)).error, "CSRF_INVALID");
});

test("PUT mit unbekanntem Schlüssel wird abgewiesen (422, Allowlist)", async () => {
  process.env.FIRM_ADMIN_TOKEN = VALID_ADMIN;
  const res = await put(
    { key: "provider.evil.enabled", value: true },
    { "x-admin-token": VALID_ADMIN, "x-csrf-token": VALID_ADMIN }
  );
  assert.equal(res.status, 422);
  assert.equal((await json(res)).error, "UNKNOWN_FLAG");
});

test("PUT mit ungültigem Wert wird abgewiesen (400)", async () => {
  process.env.FIRM_ADMIN_TOKEN = VALID_ADMIN;
  const res = await put(
    { key: "provider.opencode.enabled", value: "ja" },
    { "x-admin-token": VALID_ADMIN, "x-csrf-token": VALID_ADMIN }
  );
  assert.equal(res.status, 400);
  assert.equal((await json(res)).error, "INVALID_VALUE");
});

test("PUT sperrt OpenCode wirksam (Provider-Schalter, sofort aktiv)", async () => {
  process.env.FIRM_ADMIN_TOKEN = VALID_ADMIN;
  const res = await put(
    { key: "provider.opencode.enabled", value: false },
    { "x-admin-token": VALID_ADMIN, "x-csrf-token": VALID_ADMIN }
  );
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.ok, true);
  assert.equal(body.key, "provider.opencode.enabled");
  assert.equal(body.value, false);
  assert.equal(typeof body.auditDurable, "boolean");

  // Wirksam für Chain/Registry (dieselbe Auflösung, die der Router nutzt).
  assert.equal(isProviderEnabled("opencode"), false);
  assert.equal(isProviderEnabled("ollama"), true, "andere Provider bleiben unberührt");

  const flags = body.flags as Array<Record<string, unknown>>;
  const opencode = flags.find((f) => f.key === "provider.opencode.enabled")!;
  assert.equal(opencode.source, "runtime");
  assert.equal(opencode.explicit, true);
});

test("PUT mit value=null setzt zurück auf den Env-Default", async () => {
  process.env.FIRM_ADMIN_TOKEN = VALID_ADMIN;
  const headers = { "x-admin-token": VALID_ADMIN, "x-csrf-token": VALID_ADMIN };
  await put({ key: "provider.opencode.enabled", value: false }, headers);
  assert.equal(isProviderEnabled("opencode"), false);

  const cleared = await put({ key: "provider.opencode.enabled", value: null }, headers);
  assert.equal(cleared.status, 200);
  const body = await json(cleared);
  assert.equal(body.value, true, "zurück auf Default (an)");
  assert.equal(isProviderEnabled("opencode"), true);

  const flags = body.flags as Array<Record<string, unknown>>;
  const opencode = flags.find((f) => f.key === "provider.opencode.enabled")!;
  assert.equal(opencode.explicit, false);
  assert.equal(opencode.source, "default");
});

test("PUT kann Broker-Remote-Checks aktivieren (Runtime-Quelle)", async () => {
  process.env.FIRM_ADMIN_TOKEN = VALID_ADMIN;
  const res = await put(
    { key: "broker.healthcheck.remote", value: true },
    { "x-admin-token": VALID_ADMIN, "x-csrf-token": VALID_ADMIN }
  );
  assert.equal(res.status, 200);
  const flags = (await json(res)).flags as Array<Record<string, unknown>>;
  const remote = flags.find((f) => f.key === "broker.healthcheck.remote")!;
  assert.equal(remote.effective, true);
  assert.equal(remote.source, "runtime");

  const { remoteHealthCheckEnabled } = await import("../src/brokers/health");
  assert.equal(remoteHealthCheckEnabled(), true, "Adressaten lesen den Schalter");
});
