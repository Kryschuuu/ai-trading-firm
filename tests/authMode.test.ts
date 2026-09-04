/**
 * Auth-Modus und Boot-Guard (Befund C1, v1.36.13).
 *
 * Akzeptanzkriterien aus `docs/AUDIT_REMEDIATION_2026-09.md` /
 * `audit-remediation/C1-open-mode.md`:
 *
 *   1. `NODE_ENV=production` ohne Token → Boot-Fehler (kein Start).
 *   2. `AUTH_MODE=local-open` ist nötig, damit offen gelaufen wird; in
 *      Produktion wird der Offen-Betrieb nie implizit.
 *   3. Mit Token verlangen die Write-Endpunkte `x-firm-token`.
 *
 * Dazu die zwei Eigenschaften, die der Befund erst richtig schliesst:
 *   4. Kein Requestpfad entscheidet noch über „kein Token ⇒ offen“ — auch ohne
 *      gelaufenen Boot-Guard bleibt Produktion zu (Defense in Depth).
 *   5. Ein Tipfehler in `AUTH_MODE` ist ein Boot-Fehler, kein offener Betrieb.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AUTH_MODES,
  ConfigurationError,
  anyTokenConfigured,
  assertAuthConfigured,
  authModeWarnings,
  describeAuthMode,
  resolveAuthMode,
} from "../src/auth/authMode";
import { requirePermission, resolveActor, resolveAuth } from "../src/auth/resolve";
import {
  checkApiToken,
  guardWrite,
  resetRateLimiterForTests,
} from "../src/lib/apiAuth";

const TOKEN_KEYS = ["FIRM_ADMIN_TOKEN", "FIRM_API_TOKEN", "FIRM_VIEWER_TOKEN"] as const;
const AUTH_KEYS = [...TOKEN_KEYS, "AUTH_MODE", "NODE_ENV", "FIRM_RATE_LIMIT"] as const;

/** Konfigurierte Env ohne jedes Credential — wie ein frischer Clone. */
function cleanEnv(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    FIRM_ADMIN_TOKEN: undefined,
    FIRM_API_TOKEN: undefined,
    FIRM_VIEWER_TOKEN: undefined,
    AUTH_MODE: undefined,
    NODE_ENV: undefined,
  };
  return { ...env, ...overrides };
}

/** Prozess-Env setzen/löschen — NODE_ENV ist im Typ read-only, deshalb indexiert. */
function setEnv(key: string, value: string | undefined): void {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) delete env[key];
  else env[key] = value;
}

function req(headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request("http://127.0.0.1:3369/api/firm/tick", { method, headers });
}

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  resetRateLimiterForTests();
  const env = process.env as Record<string, string | undefined>;
  for (const key of AUTH_KEYS) {
    saved.set(key, env[key]);
    delete env[key];
  }
});

afterEach(() => {
  // NODE_ENV ist im Node-Typ read-only deklariert — für den Restore indexieren.
  const env = process.env as Record<string, string | undefined>;
  for (const key of AUTH_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  saved.clear();
});

// ── 1) Modus-Auflösung ──────────────────────────────────────────────────────

test("resolveAuthMode: Token konfiguriert ⇒ token-required — AUTH_MODE=local-open wird ignoriert", () => {
  const d = resolveAuthMode(cleanEnv({ FIRM_API_TOKEN: "tok", AUTH_MODE: "local-open" }));
  assert.equal(d.mode, "token-required");
  assert.equal(d.reason, "tokens-configured");
  assert.equal(d.ignored, true, "Offen-Betrieb darf eine Token-Konfiguration nie abschalten");
  assert.equal(anyTokenConfigured(cleanEnv({ FIRM_VIEWER_TOKEN: "v" })), true);
  assert.ok(
    authModeWarnings(d).some((line) => line.includes("ignoriert")),
    "Ignorieren muss im Boot-Log sichtbar sein"
  );
});

test("resolveAuthMode: kein Token, keine Produktion ⇒ local-open (Dev-Default, laut angekündigt)", () => {
  const d = resolveAuthMode(cleanEnv());
  assert.equal(d.mode, "local-open");
  assert.equal(d.reason, "dev-default");
  assert.equal(d.requested, null);
  assert.equal(d.production, false);
  assert.ok(authModeWarnings(d).some((line) => line.includes("Lokaler Offen-Betrieb")));
});

test("resolveAuthMode: kein Token, Produktion ⇒ token-required (Implikation ist verboten)", () => {
  const d = resolveAuthMode(cleanEnv({ NODE_ENV: "production" }));
  assert.equal(d.mode, "token-required");
  assert.equal(d.reason, "production-no-tokens");
  assert.equal(d.production, true);
});

test("resolveAuthMode: AUTH_MODE=local-open ist der einzige Weg ohne Token — auch in Produktion (Opt-in)", () => {
  const dev = resolveAuthMode(cleanEnv({ AUTH_MODE: "local-open" }));
  assert.equal(dev.mode, "local-open");
  assert.equal(dev.reason, "explicit-local-open");
  assert.equal(dev.requested, "local-open");

  const prod = resolveAuthMode(cleanEnv({ NODE_ENV: "production", AUTH_MODE: "local-open" }));
  assert.equal(prod.mode, "local-open", "expliziter Opt-in wird respektiert …");
  assert.ok(
    authModeWarnings(prod).some((line) => /WARNUNG/.test(line)),
    "… aber nie still: in Produktion muss die Warnung im Boot-Log stehen"
  );
});

test("resolveAuthMode: AUTH_MODE=token-required schliesst auch die Entwicklung", () => {
  const d = resolveAuthMode(cleanEnv({ AUTH_MODE: "token-required" }));
  assert.equal(d.mode, "token-required");
  assert.equal(d.reason, "explicit-token-required");
});

test("resolveAuthMode: unbekannter Wert ⇒ fail-closed, nie offen", () => {
  const d = resolveAuthMode(cleanEnv({ AUTH_MODE: "local ope" }));
  assert.equal(d.mode, "token-required");
  assert.equal(d.reason, "invalid-auth-mode");
  assert.equal(d.invalidValue, "local ope");
  assert.ok(authModeWarnings(d).some((line) => line.includes("ungu") || line.includes("ungültig")));
  for (const mode of AUTH_MODES) {
    assert.ok(["local-open", "token-required"].includes(mode));
  }
});

test("describeAuthMode nennt Modus und Grund, aber keine Credential-Werte", () => {
  const line = describeAuthMode(resolveAuthMode(cleanEnv({ FIRM_API_TOKEN: "super-secret-token" })));
  assert.match(line, /auth-mode=token-required/);
  assert.match(line, /reason=tokens-configured/);
  assert.ok(!line.includes("super-secret-token"), "Zeile ist Log-tauglich");
});

// ── 2) Boot-Guard ───────────────────────────────────────────────────────────

test("assertAuthConfigured: Produktion ohne Token wirft ConfigurationError (Refusal)", () => {
  assert.throws(
    () => assertAuthConfigured(cleanEnv({ NODE_ENV: "production" })),
    (e: unknown) => {
      assert.ok(e instanceof ConfigurationError, `erwartet ConfigurationError, bekam ${String(e)}`);
      assert.equal(e.code, "AUTH_NOT_CONFIGURED");
      assert.match(
        e.message,
        /Refuse startup: authentication not configured \(set FIRM_ADMIN_TOKEN\/FIRM_API_TOKEN\)\./
      );
      assert.match(e.hint, /AUTH_MODE=local-open/);
      return true;
    }
  );
});

test("assertAuthConfigured: Dev ohne Token und Modus-Opt-in starten lässt, token-required ohne Token nicht", () => {
  assert.equal(assertAuthConfigured(cleanEnv()).reason, "dev-default");
  assert.equal(
    assertAuthConfigured(cleanEnv({ AUTH_MODE: "local-open" })).mode,
    "local-open"
  );
  assert.throws(
    () => assertAuthConfigured(cleanEnv({ AUTH_MODE: "token-required" })),
    (e: unknown) => e instanceof ConfigurationError && e.code === "AUTH_NOT_CONFIGURED"
  );
});

test("assertAuthConfigured: Produktion mit Token startet; Viewer-Token allein zählt als konfiguriert", () => {
  assert.equal(assertAuthConfigured(cleanEnv({ NODE_ENV: "production", FIRM_ADMIN_TOKEN: "a" })).mode, "token-required");
  assert.equal(assertAuthConfigured(cleanEnv({ NODE_ENV: "production", FIRM_VIEWER_TOKEN: "v" })).mode, "token-required");
});

test("assertAuthConfigured: Tipfehler in AUTH_MODE ist ein Boot-Fehler, kein offener Betrieb", () => {
  assert.throws(
    () => assertAuthConfigured(cleanEnv({ AUTH_MODE: "lokahl-open" })),
    (e: unknown) => {
      assert.ok(e instanceof ConfigurationError);
      assert.equal(e.code, "AUTH_MODE_INVALID");
      assert.match(e.message, /Invalid AUTH_MODE/);
      return true;
    }
  );
});

// ── 3) Prozess-Ebene: der Start wird real verweigert ────────────────────────

/**
 * Echter Kindprozess: `scripts/auth-boot-guard.ts` — dasselbe Skript, das
 * `npm run start`/`npm run dev` vorgeschaltet ist.
 */
/**
 * Quellcode ohne Kommentarzeilen — eine Erklärung über process.exit darf nicht
 * wie der Aufruf selbst zählen (sonst ist der Drift-Schutz nur ein Lint für Prosa).
 */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");
}

function runBootGuard(env: Record<string, string | undefined>): { code: number; out: string } {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of AUTH_KEYS) delete childEnv[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/auth-boot-guard.ts"],
    { cwd: process.cwd(), env: childEnv, encoding: "utf8", timeout: 120_000 }
  );
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

test("Startwächter im Kindprozess: Produktion ohne Token = Exit 1, Dev = Exit 0", () => {
  const refused = runBootGuard({ NODE_ENV: "production" });
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /Start verweigert \(AUTH_NOT_CONFIGURED\)/);
  assert.match(
    refused.out,
    /Refuse startup: authentication not configured \(set FIRM_ADMIN_TOKEN\/FIRM_API_TOKEN\)\./,
    "der Wortlaut aus dem Audit muss im Log stehen"
  );
  assert.match(refused.out, /Behebung:/, "die Zeile muss die Behebung nennen");

  const dev = runBootGuard({});
  assert.equal(dev.code, 0, dev.out);
  assert.match(dev.out, /auth-mode=local-open reason=dev-default/);
  assert.match(dev.out, /Start erlaubt/);
  assert.match(dev.out, /Lokaler Offen-Betrieb/, "der Dev-Default muss angekündigt werden");

  const prodWithToken = runBootGuard({
    NODE_ENV: "production",
    FIRM_API_TOKEN: "boot-guard-secret-91827364",
  });
  assert.equal(prodWithToken.code, 0, prodWithToken.out);
  assert.match(prodWithToken.out, /auth-mode=token-required reason=tokens-configured/);
  assert.match(prodWithToken.out, /Start erlaubt/);
  assert.ok(
    !prodWithToken.out.includes("boot-guard-secret-91827364"),
    "der Token-Wert landet nie im Boot-Log"
  );

  const invalid = runBootGuard({ AUTH_MODE: "open" });
  assert.equal(invalid.code, 1, invalid.out);
  assert.match(invalid.out, /Start verweigert \(AUTH_MODE_INVALID\)/);

  const prodOptIn = runBootGuard({ NODE_ENV: "production", AUTH_MODE: "local-open" });
  assert.equal(prodOptIn.code, 0, prodOptIn.out);
  assert.match(prodOptIn.out, /WARNUNG/, "Offen-Betrieb in Produktion nur mit Warnung");
});

test("Verkabelung: npm-Skripte rufen den Wächter, die Instrumentation wirft nur", () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  for (const script of ["dev", "start"]) {
    assert.ok(
      pkg.scripts[script].includes("scripts/auth-boot-guard.ts"),
      `npm run ${script} muss den Auth-Startwächter vorgeschaltet haben`
    );
  }
  const guardSrc = readFileSync(resolve(process.cwd(), "scripts/auth-boot-guard.ts"), "utf8");
  assert.ok(guardSrc.includes("process.exit(1)"), "der Wächter beendet den Prozess mit Exit 1");
  assert.ok(guardSrc.includes("assertAuthConfigured("), "der Wächter nutzt dieselbe Quelle wie der Guard");
  const instr = codeOnly(
    readFileSync(resolve(process.cwd(), "src/instrumentation.ts"), "utf8")
  );
  assert.ok(
    !instr.includes("process.exit"),
    "Instrumentation darf kein process.exit enthalten (Edge-Bundle-Warnung im Build)"
  );
});

// ── 4) RBAC-Auflösung: kein implizites Admin in Produktion ──────────────────

test("resolveActor: Dev ohne Token ⇒ local-open-Admin", () => {
  const actor = resolveActor(req(), cleanEnv());
  assert.ok(actor);
  assert.equal(actor.role, "admin");
  assert.equal(actor.source, "local-open");
});

test("resolveActor: Produktion ohne Token ⇒ 401 (kein Admin-Geschenk, auch ohne Boot-Guard)", () => {
  const resolution = resolveAuth(req(), cleanEnv({ NODE_ENV: "production" }));
  assert.equal(resolution.ok, false);
  if (resolution.ok) throw new Error("unerwartet");
  assert.equal(resolution.status, 401);
  assert.equal(resolution.error, "UNAUTHORIZED");
  assert.match(resolution.hint, /AUTH_MODE=local-open/);
});

test("resolveActor: AUTH_MODE=token-required schliesst auch die Entwicklung", () => {
  const resolution = resolveAuth(req(), cleanEnv({ AUTH_MODE: "token-required" }));
  assert.equal(resolution.ok, false);
  if (resolution.ok) throw new Error("unerwartet");
  assert.equal(resolution.status, 401);
});

test("resolveActor: AUTH_MODE=local-open in Produktion ist der dokumentierte Opt-in", () => {
  const actor = resolveActor(
    req(),
    cleanEnv({ NODE_ENV: "production", AUTH_MODE: "local-open" })
  );
  assert.ok(actor);
  assert.equal(actor.source, "local-open");
});

test("requirePermission: Produktion ohne Token ⇒ 401 statt Admin (C1)", async () => {
  const denied = requirePermission(req(), "broker.credentials", cleanEnv({ NODE_ENV: "production" }));
  assert.ok(denied);
  assert.equal(denied.status, 401);
  const body = (await denied.json()) as { error: string };
  assert.equal(body.error, "UNAUTHORIZED");
});

test("requirePermission: Token-Pfad unverändert — falsches Credential bleibt 403/401", async () => {
  const denied = requirePermission(
    req({ "x-admin-token": "falsch" }),
    "broker.credentials",
    cleanEnv({ NODE_ENV: "production", FIRM_ADMIN_TOKEN: "admin-secret-token-1" })
  );
  assert.ok(denied);
  assert.equal(denied.status, 403);
});

// ── 5) Schreib-Guard der Firm-API ───────────────────────────────────────────

test("checkApiToken/guardWrite: Produktion ohne Token ⇒ 401 AUTH_NOT_CONFIGURED", async () => {
  setEnv("NODE_ENV", "production");
  const denied = checkApiToken(req());
  assert.ok(denied);
  assert.equal(denied.status, 401);
  const body = (await denied.json()) as { error: string; code: string };
  assert.equal(body.error, "UNAUTHORIZED");
  assert.equal(body.code, "AUTH_NOT_CONFIGURED");
  assert.ok(guardWrite(req()));
});

test("checkApiToken: Dev ohne Token bleibt offen (Dev-Komfort, Prod nie)", () => {
  assert.equal(checkApiToken(req()), null);
  setEnv("NODE_ENV", "production");
  assert.ok(checkApiToken(req()));
});

test("checkApiToken: AUTH_MODE=token-required erzwingt Credential auch in der Entwicklung", async () => {
  setEnv("AUTH_MODE", "token-required");
  const denied = checkApiToken(req());
  assert.ok(denied);
  assert.equal(denied.status, 401);
  const body = (await denied.json()) as { code: string };
  assert.equal(body.code, "AUTH_NOT_CONFIGURED");
});

test("guardWrite: mit Token ist x-firm-token Pflicht (Akzeptanz 3)", async () => {
  setEnv("FIRM_API_TOKEN", "s3cret-token");
  const missing = guardWrite(req());
  assert.ok(missing);
  assert.equal(missing.status, 401);
  const wrong = guardWrite(req({ "x-firm-token": "s3cret-toke" }));
  assert.ok(wrong);
  assert.equal(wrong.status, 401);
  assert.equal(guardWrite(req({ "x-firm-token": "s3cret-token" })), null);
});

test("guardWrite: nur Admin-Token gesetzt — RBAC entscheidet, nicht das Fehlen des API-Tokens", async () => {
  // Vor C1 war dieser Pfad offen: FIRM_API_TOKEN unset ⇒ jeder durfte schreiben.
  setEnv("FIRM_ADMIN_TOKEN", "admin-secret-token-1");
  assert.equal(guardWrite(req({ "x-admin-token": "admin-secret-token-1" })), null);
  const anon = guardWrite(req());
  assert.ok(anon);
  assert.equal(anon.status, 403);
});

test("guardWrite: nur Viewer-Token gesetzt ⇒ Lesen ja, Schreiben 403", async () => {
  setEnv("FIRM_VIEWER_TOKEN", "viewer-token-xyz");
  const denied = guardWrite(req({ "x-viewer-token": "viewer-token-xyz" }));
  assert.ok(denied);
  assert.equal(denied.status, 403);
  const body = (await denied.json()) as { error: string };
  assert.equal(body.error, "FORBIDDEN");
});

test("Route POST /api/firm/tick: Produktion ohne Token antwortet 401, bevor getickt wird", async () => {
  setEnv("NODE_ENV", "production");
  const { POST } = await import("../src/app/api/firm/tick/route");
  const res = await POST(req() as Request);
  assert.equal(res.status, 401);
  const body = (await res.json()) as { code?: string };
  assert.equal(body.code, "AUTH_NOT_CONFIGURED");
});

test("Route POST /api/firm/tick: mit Token bleibt es beim klassischen 401", async () => {
  setEnv("FIRM_API_TOKEN", "s3cret-token");
  const { POST } = await import("../src/app/api/firm/tick/route");
  const res = await POST(req() as Request);
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string; code?: string };
  assert.equal(body.error, "UNAUTHORIZED");
  assert.equal(body.code, undefined, "klassischer Token-Deny trägt keinen Config-Fehlercode");
});

// ── 6) Verkabelung (Drift-Schutz, statisch wie die Architektur-Tests) ──────

test("instrumentation.ts ruft den Boot-Guard vor jedem Hintergrund-Job", () => {
  const src = readFileSync(resolve(process.cwd(), "src/instrumentation.ts"), "utf8");
  const guard = src.indexOf("assertAuthConfigured(");
  const adapters = src.indexOf("assertTradingVenuesHaveRealAdapters()");
  assert.ok(guard > 0, "Boot-Guard muss in instrumentation.ts aufgerufen werden");
  assert.ok(adapters > guard, "Auth-Guard läuft vor allen anderen Startschritten");
  assert.match(src, /phase-production-build/, "next build darf nicht am Auth-Guard scheitern");
  // Zweite Linie für Starts am npm-Skript vorbei (`npx next start`): der Fehler
  // wird weitergeworfen, nicht geschluckt.
  assert.match(src, /throw e;/, "Der ConfigurationError muss weitergeworfen werden");
});

test("kein Pfad entscheidet mehr über ‚kein Token ⇒ offen‘", () => {
  const apiAuth = readFileSync(resolve(process.cwd(), "src/lib/apiAuth.ts"), "utf8");
  const resolveSrc = readFileSync(resolve(process.cwd(), "src/auth/resolve.ts"), "utf8");
  assert.ok(
    !/^\s*if \(!expected\) return null;\s*$/m.test(apiAuth),
    "apiAuth.ts: impliziter Offen-Pfad ist zurück"
  );
  assert.ok(apiAuth.includes("resolveAuthMode("), "apiAuth.ts muss den Modus lesen");
  assert.ok(resolveSrc.includes('resolveAuthMode(env).mode === "local-open"'), "resolve.ts muss den Modus lesen");
});

test("Doku und Vorlage erklären die Produktionspflicht (C1)", () => {
  const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");
  for (const file of [".env.example", "INSTALL.md", "docs/INSTALL.md"]) {
    const src = read(file);
    assert.ok(src.includes("AUTH_MODE"), `${file} muss AUTH_MODE dokumentieren`);
    assert.ok(/Produktion/.test(src), `${file} muss die Produktionspflicht nennen`);
  }
});
