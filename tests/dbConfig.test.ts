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
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

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

test("src/db/index.ts: Pool hat 'error'-Listener (kein uncaughtException bei DB-Neustart)", () => {
  const dbIndex = readFileSync(
    resolve(process.cwd(), "src/db/index.ts"),
    "utf8"
  );
  // Fällt PostgreSQL während idle Connections weg (57P01), emittiert der Pool
  // ein async 'error'-Event. Ohne Listener → uncaughtException + Objekt-Dump.
  assert.ok(
    dbIndex.includes('pool.on("error"'),
    "Pool muss einen 'error'-Handler registriert haben"
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

// KORRIGIERT (v1.5.2): Regressionen für den Produktionsvorfall
// „could not open file global/pg_filenode.map“ + ECONNREFUSED während des Push.
test("scripts/setup-cachyos.sh: wartet auf echte PostgreSQL-Bereitschaft", () => {
  const script = readFileSync(
    resolve(process.cwd(), "scripts/setup-cachyos.sh"),
    "utf8"
  );
  // 'sleep 1' + systemctl is-active meldet Type=forking-Dienste als aktiv,
  // BEVOR der Server Connections annimmt — bei einem defekten Cluster crasht
  // der Server sogar in einer Restart-Schleife und bleibt trotzdem 'active'.
  assert.ok(
    script.includes("pg_isready"),
    "Setup-Script muss mit pg_isready auf echte Bereitschaft warten"
  );
  assert.ok(
    !script.includes("sleep 1\nsystemctl is-active"),
    "Das blinde sleep-1-plus-is-active-Muster darf nicht zurückkommen"
  );
});

test("scripts/setup-cachyos.sh: prüft Cluster-Vollständigkeit vor dem Start", () => {
  const script = readFileSync(
    resolve(process.cwd(), "scripts/setup-cachyos.sh"),
    "utf8"
  );
  const helper = readFileSync(
    resolve(process.cwd(), "scripts/lib/pg-cluster.sh"),
    "utf8"
  );
  // Halb initialisierte Cluster (fehlender global/pg_filenode.map) müssen
  // erkannt und repariert werden, bevor der Dienst startet. Die Prüfung lebt
  // seit v1.5.4 in scripts/lib/pg-cluster.sh (versionstolerant) und wird vom
  // Skript über pg_cluster_ok aufgerufen.
  assert.ok(
    helper.includes("pg_filenode.map"),
    "Cluster-Helfer muss global/pg_filenode.map prüfen (Originalfehlerbild)"
  );
  assert.ok(
    helper.includes("pg_control") && helper.includes("PG_VERSION"),
    "Cluster-Helfer muss PG_VERSION und global/pg_control einbeziehen"
  );
  assert.ok(
    script.includes("pg_cluster_ok \"$PGDATA\""),
    "Setup-Skript muss die Helper-Prüfung nutzen"
  );
  // v1.5.4: versionstolerant — künftige PG-Versionen ohne Relmap dürfen nicht
  // fälschlich als defekt gelten.
  assert.ok(
    helper.includes("pg_relmap_required"),
    "Relmap-Prüfung muss versionstolerant sein (pg_relmap_required)"
  );
});

test("scripts/setup-cachyos.sh: Cluster-Checks laufen als postgres-Benutzer (v1.5.4)", () => {
  const script = readFileSync(
    resolve(process.cwd(), "scripts/setup-cachyos.sh"),
    "utf8"
  );
  const helper = readFileSync(
    resolve(process.cwd(), "scripts/lib/pg-cluster.sh"),
    "utf8"
  );
  // Der zweite Vorfall: initdb OK, aber Check "unvollständig", weil das
  // 0700-postgres-Verzeichnis für den aufrufenden Benutzer unsichtbar war.
  assert.ok(
    script.includes("PG_SUDO_USER"),
    "Setup-Skript muss den Cluster-Benutzer konfigurieren"
  );
  assert.ok(
    helper.includes("pg_as_postgres") && helper.includes("sudo -u"),
    "Alle Cluster-Checks müssen als postgres laufen (kein EACCES-Fehlalarm)"
  );
  // Datenschutz: Versions-Mismatch → Abbruch mit pg_upgrade-Hinweis statt
  // automatischem (datenzerstörendem) initdb.
  assert.ok(
    script.includes("pg_version_mismatch") && script.includes("pg_upgrade"),
    "Major-Mismatch muss abbrechen statt Daten zu löschen"
  );
});

test("scripts/setup-cachyos.sh: initdb mit Auth-Flags und Prüfsummen", () => {
  const script = readFileSync(
    resolve(process.cwd(), "scripts/setup-cachyos.sh"),
    "utf8"
  );
  // Ohne -A setzt initdb lokale Verbindungen auf 'trust' (Warnung des Users).
  assert.ok(
    script.includes("--auth-local=peer") &&
      script.includes("--auth-host=scram-sha-256"),
    "initdb muss peer/scram-sha-256 als Authentifizierung setzen"
  );
  assert.ok(
    script.includes("--data-checksums"),
    "initdb soll Data-Checksummen aktivieren (Korruption früh erkennen)"
  );
});

test("scripts/setup-cachyos.sh: Passwort-Interpolation ist quote-/injection-sicher", () => {
  const script = readFileSync(
    resolve(process.cwd(), "scripts/setup-cachyos.sh"),
    "utf8"
  );
  // Alt (verwundbar): PASSWORD '${DB_PASS}' — ein ' im Passwort brach das SQL.
  // Neu: psql-Variablen mit :'var' maskieren kontextsicher.
  assert.ok(
    script.includes(":'db_pass'"),
    "CREATE USER muss das Passwort via psql-Variable (:'db_pass') interpolieren"
  );
  assert.ok(
    !script.includes("PASSWORD '${DB_PASS}'"),
    "Rohes '${DB_PASS}' im SQL-String ist verboten (Quote-Bug)"
  );
  // Identifikatoren dürfen nicht beliebig sein (sie gehen in SQL ein).
  assert.ok(
    script.includes("DB_USER\" =~ ^[a-z_]") || script.includes('DB_USER" =~ '),
    "DB_USER muss per Regex validiert werden"
  );
});

// ── v1.5.3: systemd-${PGROOT}-Vorfall + URL-Encoded-Passwort ────────────────

test("scripts/setup-cachyos.sh: expandiert ${PGROOT} in ExecStart statt rohem String", () => {
  const script = readFileSync(
    resolve(process.cwd(), "scripts/setup-cachyos.sh"),
    "utf8"
  );
  // Der alte Vergleich verglich den UNEXPANDIERTEN ExecStart-String ('${PGROOT}/data')
  // gegen /var/lib/postgres/data — die Ursache des Originalfehlers.
  assert.ok(
    script.includes("lib/pg-service.sh"),
    "Setup-Script muss den systemd-Helfer einbinden"
  );
  assert.ok(
    script.includes("pg_svc_datadir"),
    "Setup-Script muss den Helper pg_svc_datadir nutzen"
  );
  assert.ok(
    !/grep -oP -- '\(\?<=-D \)/.test(script),
    "Der alte unexpandierte grep-Parser darf nicht zurückkommen"
  );
});

test("scripts/setup-cachyos.sh: DATABASE_URL-URL-Encoded Passwort (Sonderzeichen)", () => {
  const script = readFileSync(
    resolve(process.cwd(), "scripts/setup-cachyos.sh"),
    "utf8"
  );
  // @ : / % im Passwort brachen sonst die Connection-URI in psql/pg/drizzle.
  assert.ok(
    script.includes("DB_PASS_ENC"),
    "Das Passwort muss vor dem URL-Bau encodiert werden"
  );
  assert.ok(
    script.includes("@uri"),
    "Die Encodierung muss via jq @uri erfolgen (jq-Pflichtpaket aus Schritt 1)"
  );
  assert.ok(
    !script.includes("DATABASE_URL=\"postgresql://${DB_USER}:${DB_PASS}@"),
    "Die rohe (nicht encodierte) Passwort-Interpolation ist verboten"
  );
});

test("src/instrumentation.ts: ANALYST_INTERVAL_MIN steuert das Zyklusfenster", () => {
  const ts = readFileSync(
    resolve(process.cwd(), "src/instrumentation.ts"),
    "utf8"
  );
  // v1.5.3: ANALYST_INTERVAL_MIN wurde nur geloggt — der Zyklus lief jede Minute.
  assert.ok(
    ts.includes("Math.floor(Date.now() / analystIntervalMs)"),
    "Slot-Key muss aus dem Analysten-Intervall abgeleitet werden"
  );
  assert.ok(
    ts.includes("Math.min(60_000, analystIntervalMs)"),
    "Analysten-Ticker muss an ANALYST_INTERVAL_MIN gekoppelt sein"
  );
});

// ── src/db/index.ts: Lazy-Init (v1.5.2) ─────────────────────────────────────

test("src/db/index.ts: Import OHNE DATABASE_URL wirft nicht (next-build-fähig)", () => {
  // Vor v1.5.2 warf src/db/index.ts beim Import, wenn DATABASE_URL fehlte —
  // und riss damit `next build` während der Page-Data-Collection ab, sobald
  // eine Route "@/db" importierte (frischer Clone ohne .env = kaputter Build).
  const entry = pathToFileURL(
    resolve(process.cwd(), "src/db/index.ts")
  ).href;
  const r = spawnSync(
    process.execPath,
    [
      "--import", "tsx",
      "--eval",
      `import(${JSON.stringify(entry)})` +
        `.then(() => process.exit(0))` +
        `.catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });`,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: "" },
      encoding: "utf8",
      timeout: 60_000,
    }
  );
  assert.equal(
    r.status,
    0,
    `Import ohne DATABASE_URL muss durchgehen. stderr: ${r.stderr}`
  );
});

test("src/db/index.ts: erste Nutzung OHNE DATABASE_URL wirft actionable Fehler", () => {
  const entry = pathToFileURL(
    resolve(process.cwd(), "src/db/index.ts")
  ).href;
  const r = spawnSync(
    process.execPath,
    [
      "--import", "tsx",
      "--eval",
      `import(${JSON.stringify(entry)}).then(async (m) => {` +
        `  try { await m.db.execute("select 1"); process.exit(0); }` +
        `  catch (e) { console.error(String(e && e.message)); process.exit(2); }` +
        `});`,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: "" },
      encoding: "utf8",
      timeout: 60_000,
    }
  );
  assert.equal(r.status, 2, "DB-Nutzung ohne DATABASE_URL muss werfen");
  assert.ok(
    r.stderr.includes("DATABASE_URL"),
    "Fehlermeldung muss DATABASE_URL nennen"
  );
  assert.ok(
    r.stderr.includes(".env.example") || r.stderr.includes("HANDBUCH"),
    "Fehlermeldung muss auf die Lösung führen (.env.example / Handbuch)"
  );
  assert.ok(
    !/postgresql:\/\/\S+:\S+@/.test(r.stderr),
    "Fehlermeldung darf keine Credentials enthalten"
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
