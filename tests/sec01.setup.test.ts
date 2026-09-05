/** SEC-01: echte Setup-/Boot-Prozesse, isolierte temporaere .env-Dateien. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parse } from "dotenv";

const ROOT = process.cwd();
const API_TOKEN = "sec01-setup-test-api-credential";

function fixture(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "sec01-setup-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function setup(dir: string, before = "") {
  return spawnSync("bash", ["-c", `
    source "$1" --variant a --non-interactive --log-file "$2/setup.log"
    PROJECT_ROOT="$2"
    DATABASE_URL=postgresql://test:test@localhost/test
    VARIANT=a
    NON_INTERACTIVE=true
    ${before}
    step_05_env
  `, "sec01-test", resolve(ROOT, "scripts/setup-cachyos.sh"), dir], {
    cwd: ROOT, env: { ...process.env }, encoding: "utf8", timeout: 30_000,
  });
}

function boot(dir: string, overrides: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of ["FIRM_API_TOKEN", "FIRM_ADMIN_TOKEN", "FIRM_VIEWER_TOKEN", "FIRM_SESSION_SECRET", "AUTH_MODE"]) delete env[key];
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/auth-boot-guard.ts"], {
    cwd: ROOT,
    env: {
      ...env,
      NODE_ENV: "production",
      DOTENV_CONFIG_PATH: join(dir, ".env"),
      DOTENV_CONFIG_QUIET: "true",
      ...overrides,
    },
    encoding: "utf8", timeout: 30_000,
  });
}

test("SEC-01 Setup: neue und bestehende Installationen bekommen unabhaengige stabile Secrets", () => {
  for (const existing of [false, true]) fixture((dir) => {
    const file = join(dir, ".env");
    if (existing) writeFileSync(file, `FIRM_API_TOKEN=${API_TOKEN}\n`, { mode: 0o644 });
    const first = setup(dir);
    assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
    const initial = parse(readFileSync(file));
    assert.match(initial.FIRM_SESSION_SECRET, /^[a-f0-9]{64}$/);
    assert.notEqual(initial.FIRM_SESSION_SECRET, initial.FIRM_API_TOKEN);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(!`${first.stdout}${first.stderr}`.includes(initial.FIRM_SESSION_SECRET));
    const again = setup(dir);
    assert.equal(again.status, 0, `${again.stdout}${again.stderr}`);
    const final = parse(readFileSync(file));
    assert.equal(final.FIRM_SESSION_SECRET, initial.FIRM_SESSION_SECRET);
    assert.equal(final.FIRM_API_TOKEN, initial.FIRM_API_TOKEN);
    const guard = boot(dir);
    assert.equal(guard.status, 0, `${guard.stdout}${guard.stderr}`);
    assert.ok(!`${guard.stdout}${guard.stderr}`.includes(initial.FIRM_SESSION_SECRET));
  });
});

test("SEC-01 Setup: vorhandene Secrets (auch dotenv-Syntax) werden nicht still rotiert", () => {
  const secret = randomBytes(32).toString("hex");
  for (const line of [
    `FIRM_SESSION_SECRET=${secret}`,
    `export FIRM_SESSION_SECRET='${secret}'`,
    `  FIRM_SESSION_SECRET = "${secret}"`,
    "FIRM_SESSION_SECRET=",
    "FIRM_SESSION_SECRET=short",
  ]) fixture((dir) => {
    const file = join(dir, ".env");
    writeFileSync(file, `FIRM_API_TOKEN=${API_TOKEN}\n${line}\n`);
    const expected = parse(readFileSync(file)).FIRM_SESSION_SECRET;
    const result = setup(dir);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const text = readFileSync(file, "utf8");
    assert.equal(parse(text).FIRM_SESSION_SECRET, expected);
    assert.equal(text.match(/FIRM_SESSION_SECRET/g)?.length, 1);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
  });
});

test("SEC-01 Setup: fehlgeschlagener oder defekter RNG bricht ab, kein unsicherer Fallback", () => {
  for (const generator of ["generate_token() { return 1; }", "generate_token() { printf short; }"]) fixture((dir) => {
    const file = join(dir, ".env");
    writeFileSync(file, `FIRM_API_TOKEN=${API_TOKEN}\n`);
    const result = setup(dir, generator);
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /Session-Secret-Erzeugung/);
    assert.equal(parse(readFileSync(file)).FIRM_SESSION_SECRET, undefined);
  });
});

test("SEC-01 Setup: dry-run aendert keine .env und legt kein Secret an", () => fixture((dir) => {
  const file = join(dir, ".env");
  const text = `FIRM_API_TOKEN=${API_TOKEN}\n`;
  writeFileSync(file, text);
  const result = setup(dir, "DRY_RUN=true");
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(readFileSync(file, "utf8"), text);
}));

test("SEC-01 Boot: fehlende/ungueltige Secrets verweigern wirklich Exit 0 und leaken keine Werte", () => {
  const token = randomBytes(32).toString("hex");
  for (const [value, error] of [
    [undefined, "SESSION_SECRET_REQUIRED"],
    ["", "SESSION_SECRET_REQUIRED"],
    ["   ", "SESSION_SECRET_REQUIRED"],
    ["short", "SESSION_SECRET_INVALID"],
    [token, "SESSION_SECRET_INVALID"],
  ] as const) fixture((dir) => {
    writeFileSync(join(dir, ".env"), `FIRM_VIEWER_TOKEN=${token}\n` +
      (value === undefined ? "" : `FIRM_SESSION_SECRET="${value}"\n`));
    const result = boot(dir);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    const output = `${result.stdout}${result.stderr}`;
    assert.ok(output.includes(`Start verweigert (${error})`));
    assert.match(output, /Behebung:/);
    assert.ok(!output.includes(token));
    if (value?.trim()) assert.ok(!output.includes(value));
  });
});

test("SEC-01 Boot: Prozess-Env hat Vorrang, korrektes Viewer-only-Setup startet", () => fixture((dir) => {
  const fileSecret = randomBytes(32).toString("hex");
  const envSecret = randomBytes(32).toString("hex");
  writeFileSync(join(dir, ".env"), `FIRM_VIEWER_TOKEN=${API_TOKEN}\nFIRM_SESSION_SECRET=${fileSecret}\n`);
  const valid = boot(dir, { FIRM_SESSION_SECRET: envSecret });
  assert.equal(valid.status, 0, `${valid.stdout}${valid.stderr}`);
  assert.ok(!`${valid.stdout}${valid.stderr}`.includes(envSecret));
  assert.ok(!`${valid.stdout}${valid.stderr}`.includes(fileSecret));
  const invalidOverride = boot(dir, { FIRM_SESSION_SECRET: "" });
  assert.equal(invalidOverride.status, 1, "kein Fallback auf Datei bei leerem Prozess-Key");
}));

test("SEC-01 Boot: npm start prueft schon vor Next im Produktionsmodus", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  assert.match(pkg.scripts.start, /^NODE_ENV=production node .*auth-boot-guard\.ts &&/);
});

test("SEC-01 Windows-Setup: separater RNG-Aufruf und fehlenden Key auch bei KeepExistingEnv ergaenzen (Verdrahtung)", () => {
  const source = readFileSync(resolve(ROOT, "scripts/setup-windows.ps1"), "utf8");
  assert.match(source, /\$token = New-Token/);
  assert.match(source, /\$sessionSecret = New-Token/);
  assert.match(source, /Add-Content -LiteralPath \$envFile -Value "`nFIRM_SESSION_SECRET=\$sessionSecret"/);
  const keyCheck = source.indexOf("if ($envText -notmatch");
  assert.ok(keyCheck > source.indexOf("$KeepExistingEnv)"));
  assert.ok(keyCheck < source.indexOf('$sessionSecret = New-Token'));
  assert.ok(!/Write-Log[^\n]*\$sessionSecret/.test(source));
});
