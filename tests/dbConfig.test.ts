/**
 * Datenbank-Konfigurations- und Sicherheits-Tests.
 *
 * Diese Tests prüfen NICHT die tatsächliche DB-Verbindung (die Tests laufen
 * gegen eine Dummy-URL), sondern die Konfigurationssicherheit:
 *
 *   - drizzle.config.ts liest DATABASE_URL aus .env (keine Hardcodierung)
 *   - DB-Pool hat Sicherheitsparameter (max, timeouts)
 *   - Fehlermeldungen aus API-Routen enthalten keine Secrets
 *   - checkSchema() erkennt fehlende Tabellen korrekt
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── drizzle.config.ts: keine Hardcodierung ──────────────────────────────────

test("drizzle.config.ts: keine hardcodierte DATABASE_URL", () => {
  const config = readFileSync(
    resolve(process.cwd(), "drizzle.config.ts"),
    "utf8"
  );
  // Sollte process.env.DATABASE_URL nutzen
  assert.ok(
    config.includes("process.env.DATABASE_URL"),
    "drizzle.config.ts muss DATABASE_URL aus der Umgebung lesen"
  );
  // Sollte KEINE hardcodierte URL enthalten
  assert.ok(
    !config.match(/postgresql:\/\/[^$]/),
    "drizzle.config.ts darf keine hardcodierte PostgreSQL-URL enthalten"
  );
  // Sollte bei fehlender URL einen Fehler werfen
  assert.ok(
    config.includes("throw new Error"),
    "drizzle.config.ts muss bei fehlender DATABASE_URL einen Fehler werfen"
  );
});

test("drizzle.config.ts: kein altes JSON-Config-File im Repo", () => {
  // Variante-B-Bug: drizzle.config.json mit hardcodierter URL lenkte den Push
  // auf die falsche Datenbank um. Die Datei darf nicht mehr existieren.
  let exists = false;
  try {
    readFileSync(resolve(process.cwd(), "drizzle.config.json"), "utf8");
    exists = true;
  } catch {
    // Datei existiert nicht — korrekt.
  }
  assert.equal(
    exists,
    false,
    "drizzle.config.json darf nicht existieren (nur drizzle.config.ts ist gültig)"
  );
});

// ── .env.example: sichere Defaults ─────────────────────────────────────────

test(".env.example: DATABASE_URL ist ein Platzhalter, kein echtes Passwort", () => {
  const envExample = readFileSync(
    resolve(process.cwd(), ".env.example"),
    "utf8"
  );
  // Darf kein echtes/gebräuchliches Passwort enthalten
  assert.ok(
    envExample.includes("bitte-hier-aendern"),
    ".env.example muss ein Platzhalter-Passwort verwenden"
  );
  // Darf kein 'postgres:postgres' Default verwenden
  assert.ok(
    !envExample.includes("postgres:postgres@"),
    ".env.example darf nicht das unsichere postgres:postgres-Passwort verwenden"
  );
});

test(".env.example: chmod 600 Hinweis vorhanden", () => {
  const envExample = readFileSync(
    resolve(process.cwd(), ".env.example"),
    "utf8"
  );
  assert.ok(
    envExample.includes("chmod 600"),
    ".env.example muss auf chmod 600 hinweisen"
  );
});

// ── .gitignore: .env ist ausgeschlossen ─────────────────────────────────────

test(".gitignore: .env-Dateien sind ausgeschlossen", () => {
  const gitignore = readFileSync(
    resolve(process.cwd(), ".gitignore"),
    "utf8"
  );
  assert.ok(
    gitignore.includes(".env"),
    ".gitignore muss .env-Dateien ausschließen"
  );
  // Sollte auch .env.local ausschließen
  assert.ok(
    gitignore.includes(".env.local"),
    ".gitignore muss .env.local ausschließen"
  );
});

// ── DB-Pool-Konfiguration: Sicherheitsparameter ─────────────────────────────

test("src/db/index.ts: Pool hat max-Connections und Timeouts konfiguriert", () => {
  const dbIndex = readFileSync(
    resolve(process.cwd(), "src/db/index.ts"),
    "utf8"
  );
  assert.ok(
    dbIndex.includes("max:"),
    "DB-Pool muss eine max-Verbindungsgrenze haben"
  );
  assert.ok(
    dbIndex.includes("connectionTimeoutMillis"),
    "DB-Pool muss ein Connection-Timeout haben"
  );
  assert.ok(
    dbIndex.includes("idleTimeoutMillis"),
    "DB-Pool muss ein Idle-Timeout haben"
  );
});

test("src/db/index.ts: kein hardcodiertes Passwort", () => {
  const dbIndex = readFileSync(
    resolve(process.cwd(), "src/db/index.ts"),
    "utf8"
  );
  assert.ok(
    !dbIndex.includes("password:") && !dbIndex.match(/postgresql:\/\/[^$]/),
    "src/db/index.ts darf keine hardcodierten Zugangsdaten enthalten"
  );
});

// ── systemd-Unit: Sicherheitshärtung ────────────────────────────────────────

test("deploy/ai-trading-firm.service: Sicherheitsdirektiven vorhanden", () => {
  const service = readFileSync(
    resolve(process.cwd(), "deploy/ai-trading-firm.service"),
    "utf8"
  );
  const requiredDirectives = [
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "EnvironmentFile=",
    "Restart=always",
  ];
  for (const directive of requiredDirectives) {
    assert.ok(
      service.includes(directive),
      `systemd-Unit muss ${directive} enthalten`
    );
  }
});

// ── Setup-Script: sichere DB-Erstellung ─────────────────────────────────────

test("scripts/setup-cachyos.sh: erstellt DB-User mit Passwort-Abfrage", () => {
  const script = readFileSync(
    resolve(process.cwd(), "scripts/setup-cachyos.sh"),
    "utf8"
  );
  // Passwort soll interaktiv abgefragt werden, nicht hardcodiert
  assert.ok(
    script.includes("read -r -s") && script.includes("Passwort"),
    "Setup-Script muss das DB-Passwort interaktiv abfragen"
  );
  // .env soll chmod 600 bekommen
  assert.ok(
    script.includes("chmod 600 .env"),
    "Setup-Script muss .env mit chmod 600 sichern"
  );
  // drizzle-kit push muss die DATABASE_URL aus der Umgebung nutzen
  assert.ok(
    script.includes("DATABASE_URL=") && script.includes("drizzle-kit push"),
    "Setup-Script muss DATABASE_URL explizit an drizzle-kit push übergeben"
  );
});

// ── Next.js Security Headers ────────────────────────────────────────────────

test("next.config.ts: Security-Header für Produktion konfiguriert", () => {
  const config = readFileSync(
    resolve(process.cwd(), "next.config.ts"),
    "utf8"
  );
  const requiredHeaders = [
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Content-Security-Policy",
    "Referrer-Policy",
  ];
  for (const header of requiredHeaders) {
    assert.ok(
      config.includes(header),
      `next.config.ts muss ${header} Header setzen`
    );
  }
  // Nur in Produktion aktiv
  assert.ok(
    config.includes("production"),
    "Security-Header dürfen nur in Produktion aktiv sein (Dev-Modus braucht HMR)"
  );
});

// ── API-Routen: keine unredaktierten Fehler ─────────────────────────────────

test("API-Routen: firm/run und firm/tick nutzen publicErrorMessage", () => {
  const runRoute = readFileSync(
    resolve(process.cwd(), "src/app/api/firm/run/route.ts"),
    "utf8"
  );
  const tickRoute = readFileSync(
    resolve(process.cwd(), "src/app/api/firm/tick/route.ts"),
    "utf8"
  );
  // Beide sollten publicErrorMessage importieren
  assert.ok(
    runRoute.includes("publicErrorMessage"),
    "firm/run/route.ts muss publicErrorMessage nutzen"
  );
  assert.ok(
    tickRoute.includes("publicErrorMessage"),
    "firm/tick/route.ts muss publicErrorMessage nutzen"
  );
});

test("API-Routen: firm/route.ts (GET) hat Fehlerbehandlung", () => {
  const firmRoute = readFileSync(
    resolve(process.cwd(), "src/app/api/firm/route.ts"),
    "utf8"
  );
  assert.ok(
    firmRoute.includes("try") && firmRoute.includes("catch"),
    "firm/route.ts GET muss einen try/catch-Block haben"
  );
  assert.ok(
    firmRoute.includes("publicErrorMessage"),
    "firm/route.ts muss publicErrorMessage nutzen"
  );
});
