/**
 * Versionierung & Doku-Verlinkung (Nacharbeit v1.26.2, MDSYNC-001).
 *
 * Die Version steht an vier Stellen gleichzeitig (`package.json`,
 * Status-Header `CHANGELOG.md`, oberster Eintrag des kanonischen Changelogs
 * (Root `CHANGELOG.md`; `docs/CHANGELOG.md` ist seit 2026-09-05 Stub/Weiterleitung),
 * Versionszeile `docs/README.md`). Drift dort ist für Betrieb und Deployment
 * unsichtbar — ein Release kann älter wirken, als er ist. Diese Tests
 * sichern die Konsistenz statisch ab; `npm run docs:validate` prüft dasselbe
 * als CI-Check („Version-Konsistenz“).
 *
 * Zweiter Teil: das Migrations-Runbook zum `timeframe`-Feld muss vorhanden,
 * im Doku-Katalog (`GET /api/docs`) registriert und aus den beiden
 * Stellen verlinkt sein, an denen die Migration beschrieben wird — sonst
 * landet die Migrationsanleitung nicht beim Betrieb.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const read = (rel: string): string => {
  const file = path.join(ROOT, rel);
  assert.ok(existsSync(file), `${rel} muss existieren`);
  return readFileSync(file, "utf8");
};

/** Oberster Release-Eintrag einer Changelog-Datei (`## [x.y.z] — …`). */
function latestChangelogEntry(rel: string): string {
  const m = read(rel).match(/^## \[(\d+\.\d+\.\d+(?:-[\w.]+)?)\]/m);
  assert.ok(m, `${rel}: kein Release-Eintrag '## [x.y.z]' gefunden`);
  return m[1];
}

const VERSION = ((): string => {
  const pkg = JSON.parse(read("package.json")) as { version?: unknown };
  assert.equal(typeof pkg.version, "string", "package.json braucht eine Version");
  return pkg.version as string;
})();

test("package.json-Version ist semver und in beiden Changelogs der oberste Eintrag", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/, "Version muss semver sein");
  assert.equal(latestChangelogEntry("CHANGELOG.md"), VERSION, "CHANGELOG.md: oberster Eintrag muss package.json entsprechen");
  // docs/CHANGELOG.md ist seit 2026-09-05 ein Stub/Weiterleitung (kanonisch: Root CHANGELOG.md).
  // Prüfe Stub-Integrität statt Release-Eintrag — verhindert Drift/Gabelung.
  const docsChangelog = read("docs/CHANGELOG.md");
  if (docsChangelog.includes("Weiterleitung")) {
    assert.ok(docsChangelog.includes("../CHANGELOG.md"), "docs/CHANGELOG.md Stub muss auf ../CHANGELOG.md verweisen");
    assert.ok(docsChangelog.includes(`v${VERSION}`), `docs/CHANGELOG.md Stub muss Version v${VERSION} nennen`);
  } else {
    assert.equal(latestChangelogEntry("docs/CHANGELOG.md"), VERSION, "docs/CHANGELOG.md: oberster Eintrag muss package.json entsprechen");
  }
});

test("CHANGELOG.md-Status-Header und docs/README.md nennen dieselbe Version", () => {
  assert.ok(
    read("CHANGELOG.md").includes(`Code-Version **${VERSION}**`),
    `CHANGELOG.md: Status-Header muss 'Code-Version **${VERSION}**' nennen`,
  );
  assert.ok(
    read("docs/README.md").includes(`**Version:** \`v${VERSION}\``),
    `docs/README.md: Versionszeile muss 'v${VERSION}' nennen`,
  );
});

test("Migrations-Runbook zum timeframe-Feld ist vorhanden und katalogisiert", () => {
  const runbook = "docs/MIGRATION_TIMEFRAME_FIELD.md";
  const content = read(runbook);

  // Inhaltliche Pflichtpunkte laut Ticket (Backup, Migration/Neuaufbau,
  // Validierung) und Security-Audit (Dry-Run als Default).
  for (const needle of [
    "npm run history:migrate",
    "--apply",
    "--assume-timeframe",
    "npm run market-sync",
    "0600",
    "Rollback",
  ]) {
    assert.ok(content.includes(needle), `${runbook} muss '${needle}' enthalten`);
  }

  // Katalog (GET /api/docs) — die Datei muss über den Slug lesbar sein.
  const catalog = read("src/lib/docsCatalog.ts");
  assert.match(catalog, /file:\s*"docs\/MIGRATION_TIMEFRAME_FIELD\.md"/, "Runbook muss im docsCatalog stehen");

  // Sichtbarkeit in der Doku-Übersicht.
  assert.ok(read("docs/README.md").includes("MIGRATION_TIMEFRAME_FIELD.md"), "Runbook muss in docs/README.md verlinkt sein");
});

test("Migration ist aus HISTORY.md und MARKET_DATA_PIPELINE.md erreichbar", () => {
  assert.ok(
    read("docs/HISTORY.md").includes("MIGRATION_TIMEFRAME_FIELD.md"),
    "docs/HISTORY.md muss auf das Migrations-Runbook verlinken",
  );
  assert.ok(
    read("docs/MARKET_DATA_PIPELINE.md").includes("MIGRATION_TIMEFRAME_FIELD.md"),
    "docs/MARKET_DATA_PIPELINE.md muss auf das Migrations-Runbook verlinken",
  );
});

test("Migrations-CLI schreibt nur mit --apply (Dry-Run als Default)", () => {
  const cli = read("scripts/migrate-history-timeframe.ts");
  assert.match(cli, /const apply = args\.includes\("--apply"\)/, "--apply muss explizit abgefragt werden");
  assert.match(cli, /const dryRun = args\.includes\("--dry-run"\) \|\| !apply/, "ohne --apply muss der Dry-Run greifen");
  assert.ok(cli.includes("docs/MIGRATION_TIMEFRAME_FIELD.md"), "CLI-Hilfe muss auf das Runbook verweisen");
});

test("Capability-Dokumentation ist vorhanden, katalogisiert und verlinkt", () => {
  const doc = "docs/CAPABILITIES.md";
  const content = read(doc);
  for (const needle of [
    "discovery",
    "marketData",
    "trading",
    "liveAvailable",
    "liveTradable",
    "resolveInstrumentCapabilities",
    "fail-closed",
  ]) {
    assert.ok(content.includes(needle), `${doc} muss '${needle}' enthalten`);
  }
  const catalog = read("src/lib/docsCatalog.ts");
  assert.match(catalog, /file:\s*"docs\/CAPABILITIES\.md"/, "Capabilities-Doku muss im docsCatalog stehen");
  assert.ok(read("docs/README.md").includes("CAPABILITIES.md"), "Capabilities-Doku muss in docs/README.md verlinkt sein");
  assert.ok(read("docs/MARKET_UNIVERSE.md").includes("CAPABILITIES.md"), "Market-Universe-Doku muss die Capability-SSoT verlinken");
});

test("Marktdaten-Fehler-Entscheidungsbaum ist vorhanden, katalogisiert und verlinkt", () => {
  const doc = "docs/ERROR_HANDLING_MARKETDATA.md";
  const content = read(doc);

  // Inhaltliche Pflichtpunkte laut Ticket (Entscheidungsbaum,
  // Fehlertaxonomie, Sync-/Ops-Behandlung).
  for (const needle of [
    "MarketDataFetchError",
    "RATE_LIMITED",
    "UPSTREAM_5XX",
    "SCHEMA_MISMATCH",
    "DATA_UNAVAILABLE",
    "getCandlesWithFallback",
    "using stale cache due to fetch error",
    "Token-Bucket",
  ]) {
    assert.ok(content.includes(needle), `${doc} muss '${needle}' enthalten`);
  }

  // Katalog (GET /api/docs) und Doku-Übersicht.
  const catalog = read("src/lib/docsCatalog.ts");
  assert.match(catalog, /file:\s*"docs\/ERROR_HANDLING_MARKETDATA\.md"/, "Entscheidungsbaum muss im docsCatalog stehen");
  assert.ok(read("docs/README.md").includes("ERROR_HANDLING_MARKETDATA.md"), "Entscheidungsbaum muss in docs/README.md verlinkt sein");

  // Erreichbarkeit aus Memory-Docs.
  assert.ok(read("docs/MARKET_DATA_PIPELINE.md").includes("ERROR_HANDLING_MARKETDATA.md"), "Pipeline-Doku muss verlinken");
  assert.ok(read("docs/OBSERVABILITY.md").includes("ERROR_HANDLING_MARKETDATA.md"), "Observability-Doku muss verlinken");
});
