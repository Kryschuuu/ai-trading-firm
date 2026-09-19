/**
 * Unit Tests für `src/lib/version.ts` — Single Source of Truth der
 * Versionsinformation (/api/health, /api/firm, Reports).
 *
 * Garantie: Ein laufender Dienst muss eindeutig einem Release zugeordnet
 * werden können. Diese Tests frieren ein, dass die Exporte exakt aus
 * package.json stammen und SemVer-Format haben — ein Drift (hartkodierte
 * Version, vergessenes Update) fällt hier sofort auf.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { APP_NAME, APP_VERSION } from "../src/lib/version";

const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
  name: string;
  version: string;
};

describe("version: Single Source of Truth package.json", () => {
  test("APP_NAME ist exakt der package.json-Name", () => {
    assert.equal(APP_NAME, pkg.name, "APP_NAME darf nicht von package.json abweichen");
  });

  test("APP_VERSION ist exakt die package.json-Version", () => {
    assert.equal(APP_VERSION, pkg.version, "APP_VERSION darf nicht von package.json abweichen");
  });

  test("APP_VERSION hat SemVer-Format (maschinenlesbar für Gateways)", () => {
    assert.match(
      APP_VERSION,
      /^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?(\+[0-9A-Za-z-.]+)?$/,
      "die Versionsangabe muss SemVer sein (Major.Minor.Patch, optional Prerelease/Build)"
    );
  });

  test("beide Exporte sind nicht-leere Strings (kein undefined-Durchreichen)", () => {
    assert.equal(typeof APP_NAME, "string");
    assert.equal(typeof APP_VERSION, "string");
    assert.ok(APP_NAME.length > 0, "APP_NAME darf nicht leer sein");
    assert.ok(APP_VERSION.length > 0, "APP_VERSION darf nicht leer sein");
  });
});
