/** ASA-08: real boot process plus instrumentation/bind wiring. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertProxyTrustConfigured } from "../src/lib/proxyTrustBoot";

function boot(overrides: Record<string, string>, fileContents = "") {
  const dir = mkdtempSync(join(tmpdir(), "asa08-boot-"));
  try {
    const env = { ...process.env };
    for (const key of ["FIRM_API_TOKEN", "FIRM_ADMIN_TOKEN", "FIRM_VIEWER_TOKEN",
      "TRUSTED_PROXY_IPS", "TRUSTED_PROXY_SECRET", "NEXT_PHASE"]) delete env[key];
    const file = join(dir, ".env");
    writeFileSync(file, fileContents);
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/auth-boot-guard.ts"], {
      env: { ...env, NODE_ENV: "production", AUTH_MODE: "local-open",
        DOTENV_CONFIG_PATH: file, DOTENV_CONFIG_QUIET: "true", ...overrides },
      encoding: "utf8", timeout: 30_000,
    });
    assert.ifError(result.error);
    return { code: result.status, output: result.stdout + result.stderr };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("ASA-08 boot: CIDR-only setup refuses startup on wildcard, unknown and even loopback binds", () => {
  for (const host of ["0.0.0.0", "::", "", "127.0.0.1", "::1"]) {
    const result = boot({ HOSTNAME: host, TRUSTED_PROXY_IPS: "10.0.0.0/8" });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /TRUSTED_PROXY_SECRET_REQUIRED/);
    assert.match(result.output, /Behebung:/);
    assert.doesNotMatch(result.output, /Start erlaubt/);
  }
});

test("ASA-08 boot: malformed/blank secrets fail closed without leaking their value", () => {
  for (const value of ["", "   ", "dummy", "x".repeat(257), "x".repeat(32) + ","]) {
    const result = boot({ TRUSTED_PROXY_IPS: "loopback", TRUSTED_PROXY_SECRET: value });
    assert.equal(result.code, 1);
    assert.match(result.output, /TRUSTED_PROXY_SECRET_(REQUIRED|INVALID)/);
    if (value.trim()) assert.ok(!result.output.includes(value));
  }
});

test("ASA-08 boot: valid dotenv secret starts, explicit empty process-env overrides fail", () => {
  const secret = randomBytes(32).toString("hex");
  const file = `TRUSTED_PROXY_IPS=loopback\nTRUSTED_PROXY_SECRET=${secret}\n`;
  const good = boot({ HOSTNAME: "0.0.0.0" }, file);
  assert.equal(good.code, 0, good.output);
  assert.match(good.output, /fetch-peer=secret-required/);
  assert.ok(!good.output.includes(secret));
  const bad = boot({ TRUSTED_PROXY_SECRET: "" }, file);
  assert.equal(bad.code, 1);
  assert.ok(!bad.output.includes(secret));
});

test("ASA-08 boot: default without proxy trust and build phase need no proxy secret", () => {
  assert.equal(boot({}).code, 0);
  assert.doesNotThrow(() => assertProxyTrustConfigured({
    NEXT_PHASE: "phase-production-build", TRUSTED_PROXY_IPS: "10.0.0.0/8",
  }));
});

test("ASA-08 wiring: CLI/instrumentation share the guard, production binds loopback explicitly", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(pkg.scripts.start, /next start -p \$\{PORT:-3369\} -H 127\.0\.0\.1/);
  assert.doesNotMatch(pkg.scripts.start, /0\.0\.0\.0/);
  const unit = readFileSync("deploy/ai-trading-firm.service", "utf8");
  assert.match(unit, /^ExecStart=\/usr\/bin\/npm run start -- -H 127\.0\.0\.1$/m);
  for (const file of ["scripts/auth-boot-guard.ts", "src/instrumentation.ts"]) {
    const code = readFileSync(file, "utf8");
    assert.match(code, /assertProxyTrustConfigured\(\)/);
    assert.match(code, /lib\/proxyTrustBoot/);
  }
  assert.match(pkg.scripts["security:live-gate"], /npm run test:security:asa08/);
});
