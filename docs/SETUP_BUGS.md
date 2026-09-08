# Setup-Bug-Register — `scripts/setup-cachyos.sh`

**Stand:** v1.36.38 · **Datum:** 2026-09-08 · **Status:** alle Befunde behoben
(B1–B7 plus Script-Härtung v1.36.38: DRY-01/02, UUID-01, LOG-01, SEC-PSQL,
ERR-01, STOP-01/02/03, VAL-01/02, SMOKE-01, WIN-01/02/03/04, MDSYNC-002,
LGSCAN-001, LGSTAMP-001, LGKILL-001, MICRO-001)
**Betroffene Dateien:** `scripts/setup-cachyos.sh`, `scripts/validate-setup.sh`,
`src/lib/appPaths.ts`, `src/universe/presets.ts`, `src/lib/marketdata/config.ts`
(Referenz für die akzeptierten `PAPER_MODE`-Werte) sowie seit v1.36.38
`scripts/stop.sh`, `scripts/smoke-test.sh`, `scripts/setup-windows.ps1`,
`scripts/lib/pg-cluster.sh`, `scripts/lib/market-sync.ts`,
`scripts/live-kill.ts`, `scripts/live-security-stamp.ts`,
`scripts/scan-live-gate-secrets.ts`, `scripts/micro-executor.ts`

Dieses Dokument ist die verbindliche Befund-/Fix-Liste des Setup-Pfads. Es
ersetzt die formlose Notizsammlung „bugs start script.md“, die nie versioniert
war, und ist ab v1.30.0 die Referenz für Setup-Regressionen.

Jeder Befund trägt: **Symptom** (was der Nutzer sah), **Ursache** (warum),
**Fix** (was geändert wurde) und **Nachweis** (woran die Behebung erkennbar
ist).

---

## 1. Übersicht

| ID | Bereich | Schwere | Symptom | Status |
| --- | --- | --- | --- | --- |
| B1 | PostgreSQL-Initialisierung | kritisch | Setup bot Datenlöschung an / `initdb` brach ab | behoben |
| B2 | Datenbank-Validierung | kritisch | `invalid input syntax for type uuid: "null"`, leere Agenten-/Missionslisten | behoben |
| B3 | Broker-Adapter | hoch | `UNEXPECTED_BROKER_ADAPTER` ohne Diagnose | behoben |
| B4 | Build | mittel | 12 Turbopack-Warnungen „Dynamic filesystem access" | behoben |
| B5 | API-Sicherheit | hoch | offener LAN-Betrieb ohne Token; falsch geprüfte Ceiling-Klemmung | behoben |
| B6 | Validierung | hoch | kein reproduzierbarer Abnahme-Check; Smoke-Test zu langsam | behoben |
| B7 | PAPER_MODE-Default | kritisch | Setup schreibt `PAPER_MODE=B` → `parsePaperMode()` lehnt ab → `/api/firm` 503 mit irreführendem Hinweis; zehn stille Folgefehler | behoben |
| DRY-01/02 | Dry-Run-Vertrag | hoch | `--dry-run` spammte Log-Fehler und führte real aus (psql, Seed, Server-Start) | behoben (v1.36.38) |
| UUID-01 | UUID-Prüfung | niedrig | Setup lehnte Großbuchstaben-UUIDs ab | behoben (v1.36.38) |
| LOG-01 | Validierungs-Server | niedrig | Start ohne Log-Datei brach mit „ambiguous redirect“ ab | behoben (v1.36.38) |
| SEC-PSQL | Passwort-Hygiene | mittel | DB-Passwort in `ps aux` lesbar (Linux `-v`, Windows `-c`) | behoben (v1.36.38) |
| ERR-01 | ERR-Fallen-Fehlalarm | mittel | „Abbruch in Schritt …“ ohne Abbruch bei planmäßigen Prüfungen | behoben (v1.36.38) |
| STOP-01/02/03 | Stopp-Script | hoch | sofortiges SIGKILL bei Müll-Timeout; Selbst-Abschuss; Substring-Treffer | behoben (v1.36.38) |
| VAL-01/02 | Validator | niedrig | Überschriften auf stderr; ungekodierte JSON-Strings | behoben (v1.36.38) |
| SMOKE-01 | Smoke-Test | niedrig | Absturz auf Bash < 4.4 bei leerem AUTH-Array | behoben (v1.36.38) |
| WIN-01–04 | Windows-Installer | hoch | BOM-`.env`, Passwort in `argv`, Waisen-Prozess, fehlende Schema-/Short-Prüfung | behoben (v1.36.38) |
| MDSYNC-002 | Sync-CLI | niedrig | doppelte `[market-sync]`-Präfixe | behoben (v1.36.38) |
| LGSCAN-001 | Secret-Scanner | mittel | Credential-Guard prüfte Inhalt statt Pfad | behoben (v1.36.38) |
| LGSTAMP-001 | Suite-Stamp | niedrig | Tippfehler in `--source` wurde still `ci` | behoben (v1.36.38) |
| LGKILL-001 | Kill-CLI | niedrig | „undefined“-Meldung bei Nicht-Error-Würfen | behoben (v1.36.38) |
| MICRO-001 | Micro-Executor | niedrig | Stack-Trace bei belegtem Health-Port | behoben (v1.36.38) |

---

## 2. B1 — PostgreSQL-Initialisierung

### Symptom

* `✗ Cluster nach initdb weiterhin unvollständig (PG_VERSION/global/*)`,
  obwohl `initdb` erfolgreich durchlief.
* `initdb: error: locale "C.UTF-8" does not exist` auf Minimalinstallationen.
* Das Skript bot die Neuinitialisierung eines **intakten** Clusters an —
  ein „j" hätte die Datenbank zerstört.

### Ursache

1. `initdb` setzt `/var/lib/postgres` und `/var/lib/postgres/data` auf
   `0700 postgres:postgres`. Alle Vollständigkeits-Checks liefen als
   **aufrufender** Benutzer → `EACCES` → falsch-negatives Ergebnis.
2. Die Locale wurde hart als `C.UTF-8` übergeben, ohne Verfügbarkeit zu prüfen.
3. Es gab keinen expliziten Reset-Pfad: Reset war eine Folge des Fehlers, nicht
   eine Entscheidung.

### Fix

* **Alle** Cluster-Prüfungen laufen als `$PG_SUDO_USER` (Default `postgres`)
  über `pg_as_postgres` aus `scripts/lib/pg-cluster.sh` — ein nicht lesbares
  Verzeichnis ist damit kein Fehlalarm mehr.
* Versionsabgleich **vor** jedem Eingriff: `pg_version_mismatch` und
  `pg_control_major` vergleichen Cluster- und Server-Major. Bei Mismatch bricht
  das Skript mit `pg_upgrade`-/`pg_dumpall`-Hinweis ab, statt Daten zu löschen.
* `pg_pick_locale()` bestimmt die Locale in der Reihenfolge
  `C.UTF-8` → `en_US.UTF-8` → `C`; `--encoding=UTF8` wird immer gesetzt.
* `initdb` läuft mit Fehlerbehandlung: bei Misserfolg folgen Journal-Auszug und
  der exakte manuelle Befehl. Danach prüft `pg_cluster_ok "$PGDATA"` erneut.
* Cluster-Reset ist ein eigener, bewusster Schritt (`pg_reset_cluster`), nur
  erreichbar über Bestätigungsfrage oder `--reset-cluster`. Er löscht den
  **Inhalt** des Datenverzeichnisses, nicht das Verzeichnis selbst.
* `pg_service_stoppen` behandelt auch `activating` (systemd-Restart-Schleifen)
  und `pg_cleanup_stale_pid` bricht ab, wenn der Postmaster noch lebt.

### Nachweis

`scripts/setup-cachyos.sh` enthält `pg_cluster_ok "$PGDATA"`,
`pg_version_mismatch`, `pg_pick_locale`, `pg_reset_cluster`;
`tests/setupCluster.test.ts` und `tests/setupPgService.test.ts` bleiben grün
(42/42 Checks in `tests/dbConfig.test.ts` + `tests/setupCluster.test.ts` +
`tests/setupPgService.test.ts`).

---

## 3. B2 — Datenbank-Validierung

### Symptom

```
error: invalid input syntax for type uuid: "null"
```

beim ersten Pipeline-Lauf, dazu `agents`/`missions` leer im Dashboard.

### Ursache

Der Smoke-Test las blind `.missions[0].id` aus `/api/firm`. Bei leerer
Missionsliste liefert `jq` den String `null`, der unverändert als
`missionId` gepostet wurde. `src/app/api/firm/run/route.ts` übergibt den Wert
an `eq(missions.id, body.missionId)` — PostgreSQL lehnt `"null"` als UUID ab.
Die eigentliche Ursache (fehlender Seed) blieb unsichtbar.

### Fix

* Schritt 07 verifiziert nach `drizzle-kit push` nicht nur die Tabellenanzahl
  (≥ 13, abgeleitet aus `src/lib/seed.ts → checkSchema()`), sondern die
  kritischen Objekte einzeln: `agents`, `missions`, `risk_config`,
  `kill_switches`, `positions`, `equity_snapshots`, `broker_credentials`.
* Schritt 10 zählt `agents`/`missions` direkt in der Datenbank und prüft jede
  Mission-ID gegen das UUID-Muster — bevor irgendein Request sie verwendet.
* `scripts/validate-setup.sh` Check **V07** validiert die ID erneut über die API
  (`looks_like_uuid`), Check **V05/V06** zählen Team und Mandate.
* `POST /api/seed` wird vor der Validierung ausgelöst; der Seed ist idempotent
  und überschreibt keine Operator-Konfiguration.

### Nachweis

`validate-setup.sh` V05–V07; Schritt 10 meldet
`Datenbank: N Agenten, M Missionen` und `Alle Mission-IDs sind gültige UUIDs`.

---

## 4. B3 — Broker-Adapter

### Symptom

```
UNEXPECTED_BROKER_ADAPTER: PAPER-Adapter erwartet
```

ohne Hinweis, welche Schicht den falschen Adapter lieferte.

### Ursache

`getBroker()` in `src/lib/engine.ts` verlangt, dass die Factory für
`("PAPER", "paper")` einen `PaperBrokerAdapter` liefert. Schlug das fehl, warf
die Engine — sichtbar nur als 503 von `/api/firm`. Das Setup prüfte den aktiven
Adapter nie.

### Fix

* `validate-setup.sh` Check **V12** liest `/api/firm → account.broker` — genau
  das Feld, das dieser Codepfad befüllt — und verlangt `PAPER`.
* Die Behebungszeile nennt `UNEXPECTED_BROKER_ADAPTER`, `PAPER_MODE` und das Log.
* Schritt 10 bricht bei bestandener Validierung erst dann ab, wenn die
  Mindestanzahl Checks erreicht ist; ein Adapter-Fehler ist damit immer sichtbar.

### Nachweis

Check V12: `Broker-Adapter aktiv: PAPER (gefunden: PAPER)`.

---

## 5. B4 — Build-Warnungen (12× „Dynamic filesystem access")

### Symptom

```
Turbopack build encountered 12 warnings:
Warning: Dynamic filesystem access causes tracing of the whole project
```

an 12 Stellen:

| # | Datei:Zeile (vor Fix) |
| --- | --- |
| 1 | `src/brokers/control-plane/secretStore.ts:456` |
| 2 | `src/cycle/artifacts.ts:65` |
| 3 | `src/cycle/artifacts.ts:351` |
| 4 | `src/cycle/ports.ts:550` |
| 5 | `src/lib/marketdata/historicalStore.ts:333` |
| 6 | `src/portfolio/auditFile.ts:70` |
| 7 | `src/portfolio/auditFile.ts:98` |
| 8 | `src/routing/router.ts:305` |
| 9 | `src/routing/router.ts:331` |
| 10 | `src/routing/router.ts:349` |
| 11 | `src/scanner/artifacts.ts:132` |
| 12 | `src/universe/store.ts:41` |

### Ursache

Jede Stelle baute einen Laufzeitpfad als `path.join(process.cwd(), <dynamisch>)`
bzw. `path.resolve(process.cwd(), <dynamisch>)`. Turbopack kann das Ziel nicht
statisch bestimmen und traced dann das gesamte Projekt in den Server-Output.

### Fix

Neues Modul **`src/lib/appPaths.ts`** als einzige Stelle für die Auflösung von
Laufzeit-Datenpfaden:

| Funktion | Zweck |
| --- | --- |
| `resolveRuntimePath(raw)` | absolut → normalisiert; relativ → unter Projektstamm; `..`-Ausbruch → `PathTraversalError` |
| `resolveRuntimePathSafe(raw, fallback)` | wie oben, fällt bei Ausbruch auf `fallback` zurück (Secret-Store) |
| `joinRuntimePath(base, ...segments)` | Segment-Verknüpfung mit Ausbruch-Schutz |
| `resolveStoredPath(raw)` | für **app-eigene** Index-Einträge (`artifacts/index.json`), wo `..` legal ist |

Warum der offizielle Opt-out-Kommentar (`/*turbopackIgnore: true*/`) in genau
diesem Modul steht und nicht an 12 Stellen: Die drei anderen von Turbopack
genannten Auflösungen sind für dieses Projekt falsch — ein statisch gescopter
Unterordner würde die dokumentierten Env-Overrides (`UNIVERSE_DATA_DIR`,
`SCANNER_ARTIFACTS_DIR`, `CYCLE_ARTIFACTS_DIR`, `PORTFOLIO_AUDIT_DIR`,
`BROKER_SECRET_DIR`, `PAPER_HISTORY_DIR`) still umbiegen und die Defaults
`data/…` **und** `artifacts` verschieben (Breaking Change); „nur in Development"
trifft nicht zu, „entfernen" ebenso wenig. Das Projekt ist local-first
(`next start`, `deploy/*.service`, kein Serverless-Deployment) — das Tracing hat
keine Auswirkung auf ein Deployment-Artefakt. Der Gewinn der Änderung ist die
**Zentralisierung plus der zusätzliche Path-Traversal-Schutz**.

### Nachweis

```text
$ npm run build
✓ Compiled successfully
```

keine `Turbopack build encountered … warnings`-Zeile mehr. Schritt 09 des
Setups wertet die Build-Ausgabe aus und meldet zurückkommende Warnungen laut.

---

## 6. B5 — API-Validierung und unsicherer Local-Mode

### Symptom

* Die API war nach dem Setup im LAN offen erreichbar, ohne dass das Setup
  davor warnte.
* Der Ceiling-Klemmungs-Check schlug immer fehl.

### Ursache

1. `npm run start` bindet `0.0.0.0` (`package.json`). `src/lib/apiAuth.ts`
   öffnet alle `POST`/`PUT`-Routen, wenn `FIRM_API_TOKEN` **nicht** gesetzt ist.
   Das alte Setup erzeugte nie ein Token — die Kombination ist ein offener
   Schreib-Endpunkt im gesamten Netz. Der Kommentar in `apiAuth.ts` („der Dienst
   lauscht nur auf 127.0.0.1") beschreibt nicht den Auslieferungszustand.
2. Seit v1.7.0 normalisiert `setConfigValue()` Prozent-Units
   (`asFraction`: Eingabe `30` = 30 %). Der Smoke-Test sendete den **Bruch**
   `0.9` → `0.9 / 100 = 0.009` → Klemmung auf das Minimum `0.01`, nie auf das
   Ceiling `0.5`. Der Check konnte nie bestehen.

### Fix

* Schritt 05 erzeugt `FIRM_API_TOKEN` (`openssl rand -hex 32`, Fallback
  `/dev/urandom` + `od`) und schreibt ihn mit Recht `600` in `.env`. Vorhandene
  Token bleiben unverändert (Idempotenz).
* `--no-api-token` ist möglich, erzeugt aber eine explizite
  Sicherheitswarnung.
* Check **V18** prüft, dass `POST /api/firm/tick` ohne `x-firm-token` mit
  `401` antwortet — und zwar nur, wenn ein Token konfiguriert ist. Ohne Token
  zählt der Check als Fehlcheck und ist als **dokumentierte Ausnahme**
  ausgewiesen.
* Check **V17** sendet `90` (Prozent) und erwartet `effective = 0.5`. Danach
  wird der Ursprungswert zurückgeschrieben — die Validierung verbiegt keine
  Konfiguration dauerhaft.

### Nachweis

`validate-setup.sh` V17/V18; Schritt 05 meldet `Neues FIRM_API_TOKEN erzeugt`.

---

## 7. B6 — Fehlende Abnahme-Routine

### Symptom

Es gab keinen schnellen, reproduzierbaren Check dafür, ob eine Installation
brauchbar ist. `scripts/smoke-test.sh` fährt eine komplette Pipeline
(bis zu 900 s) und zieht am Ende den Not-Halt — ungeeignet als Setup-Abnahme.

### Fix

Neues Skript **`scripts/validate-setup.sh`** mit 18 deterministischen Checks
ohne Pipeline-Lauf und ohne bleibende Zustandsänderung:

| ID | Check |
| --- | --- |
| V01 | Healthcheck antwortet |
| V02 | `schemaReady = true` |
| V03 | Version entspricht `package.json` |
| V04 | `/api/firm` abrufbar |
| V05 | ≥ 12 Agenten |
| V06 | ≥ 1 Mission |
| V07 | Mission-ID ist gültige UUID |
| V08 | ≥ 50 Aktien |
| V09 | ≥ 50 Indizes |
| V10 | ≥ 20 Rohstoffe |
| V11 | ≥ 30 Kryptowährungen |
| V12 | Broker-Adapter = `PAPER` |
| V13 | `maxLeverage = 1` |
| V14 | `requireStopLoss = true` |
| V15 | `maxPositionPct ≤ 0.5` |
| V16 | Short-Selling im Soll-Zustand |
| V17 | Ceiling-Klemmung `90 % → 0.5` |
| V18 | `401` ohne `x-firm-token` |

Bestanden ab `--min-pass` (Default **15**). Jeder Fehlcheck gibt eine konkrete
Behebungszeile aus. `--json` liefert maschinenlesbare Ergebnisse auf `stdout`
(Fortschritt geht auf `stderr`).

### Dokumentierte Ausnahmen

Einzelne Checks dürfen aus nachvollziehbaren Gründen fehlschlagen:

| Check | Ausnahme | Behebung |
| --- | --- | --- |
| V18 | Betrieb bewusst ohne `FIRM_API_TOKEN` (`--no-api-token`) | Token erzeugen, Dienst neu starten |
| V08–V11 | Preset-Universum noch nicht geseedet | `npm run universe:seed:markets` |
| V16 | Short-Selling bewusst deaktiviert (`--no-shorts`) | `--expect-shorts false` bzw. `allowShort = 1` |
| V01–V04 | Dienst läuft nicht | `npm run start` |

### Nachweis

`./scripts/validate-setup.sh --base-url http://127.0.0.1:3369` →
`Ergebnis: 18 bestanden, 0 fehlgeschlagen (von 18, benötigt 15)`.

---

## 8. B7 — `PAPER_MODE`-Default ungültig (Setup schreibt `B`)

### Symptom

* Frische Installation: `curl -s localhost:3369/api/firm` antwortet mit
  HTTP 503 und `Dashboard-Daten nicht verfügbar: Ungültiger paperMode "b".
  Erlaubt: synthetic | broker-market-data | broker-paper-api.` — dazu der
  irreführende Hinweis `PostgreSQL läuft? DATABASE_URL korrekt?`, obwohl
  PostgreSQL lief und das Schema bereit war.
* `./scripts/validate-setup.sh` meldete **zehn stille Folgefehler**
  (V05–V17), statt die eine Ursache zu benennen.
* Betroffen: **jede Neuinstallation**, da der Setup-Default den Alt-Wert `B`
  in `.env` schrieb.

### Ursache

`scripts/setup-cachyos.sh` schrieb an zwei Stellen den Alt-Wert `B`
(`PAPER_MODE=B` im `.env`-Heredoc und `env_ensure_key "PAPER_MODE" "B"`).
`parsePaperMode()` (`src/lib/marketdata/config.ts:75-76`) akzeptiert
ausschließlich `synthetic | broker-market-data | broker-paper-api` und wirft
bei `B` einen `PaperConfigError`. Der Fehler entsteht beim Boot in
`getBroker()`; `GET /api/firm` fängt ihn als 503 mit generischem Hinweis ab —
die eigentliche Ursache (ungültiger `PAPER_MODE`) blieb dadurch unsichtbar,
und die Validierung zählte V05–V17 als unabhängige Fehler.

### Fix

* `scripts/setup-cachyos.sh` schreibt an beiden Stellen
  `broker-market-data` (der dokumentierte Produktions-Default). Bestehende
  `.env`-Dateien werden nicht still überschrieben — `env_ensure_key` ergänzt
  nur fehlende Schlüssel. Reparatur einer betroffenen `.env`:
  `sed -i 's/^PAPER_MODE=.*/PAPER_MODE=broker-market-data/' .env`, dann
  Dienst neu starten.
* `scripts/validate-setup.sh` prüft `PAPER_MODE` aus `./.env` **vor** jedem
  HTTP-Request und bricht bei ungültigem Wert mit einem lauten
  `WURZELURSACHE`-Block ab (Exit 2). Zusätzlich erkennt die Validierung ein
  `{error, fix}`-Objekt von `/api/firm` (503) und benennt die Ursache, statt
  V05–V17 als zehn stille Folgefehler zu zählen. Bei paperMode-Fehlern wird
  der generische Route-Hinweis durch die konkrete `.env`-Behebung ersetzt.
* Flag-Referenz `INSTALL.md` dokumentiert die erlaubten Werte und dass
  `A`/`B`/`C` **nicht** akzeptiert werden.

### Nachweis

* `scripts/setup-cachyos.sh` enthält nur noch
  `PAPER_MODE=broker-market-data` (2 Stellen); `bash -n` bleibt grün.
* `validate-setup.sh` mit `PAPER_MODE=B` in `./.env` → Exit 2 mit
  `WURZELURSACHE: PAPER_MODE=B wird von parsePaperMode() abgelehnt …`.
* `tests/marketdata.modes.test.ts` bleibt grün (bestehende Coverage für
  `parsePaperMode()`).

---

## 9. Neue Markt-Konfiguration (v1.30.0)

`src/universe/presets.ts` definiert vier kuratierte, deterministische Presets;
`scripts/seed-market-universe.ts` (`npm run universe:seed:markets`) schreibt sie
in die Registry.

| Preset | Anzahl | Venue(s) | `marketType` | `shortAvailable` |
| --- | ---: | --- | --- | --- |
| Aktien | 50 | `ALPACA`, `IBKR` | `spot` | ja |
| Indizes | 50 | `IBKR` | `cfd` | ja |
| Rohstoffe | 22 | `IBKR` | `future` | ja |
| Kryptowährungen | 30 | `BINANCE` | `spot` | nein (Spot) |
| PAPER-Spiegel | je Asset | `PAPER` | `spot` | ja |

Gesamt: **354 Instrumente** (50×3 + 50×2 + 22×2 + 30×2). Metriken
(`volume24h`, `spread`, `volatility`) starten auf `null` — die Registry erfindet
keine Marktdaten; gefüllt werden sie von `npm run market:sync`.

**Short-Selling** ist seit v1.30.0 im Setup-Default **aktiviert**
(`risk_config.allowShort = 1`). Die harten Code-Grenzen bleiben unverändert:
`maxLeverage = 1`, `requireStopLoss = true` (nicht abschaltbar),
Kill-Switch, `LIMIT_CEILINGS`. `shortAvailable` beschreibt die Venue-Fähigkeit,
die operative Freigabe ist ausschließlich `riskLimits.allowShort`.

### Nachweis

* `tests/universe.presets.test.ts` — 15 Tests (Anzahlen, Duplikatfreiheit,
  Seed-Invarianten, Determinismus, Idempotenz).
* `assertPresetContract()` wirft, wenn eine Preset-Liste von den dokumentierten
  Zahlen abweicht — ein still dünneres Universum ist damit unmöglich.

---

## 10. Script-Härtung v1.36.38 (Ausführungs-Review aller `scripts/`)

Anlass: Vollständiges Ausführungs-Review aller Scripts (jedes Script
gestartet, Hilfe-Texte, Dry-Runs, Fehlerpfade mit Exit-Codes, Installer-
Dry-Run Ende-zu-Ende in simulierter Arch-Umgebung). Installer-Version
`scripts/setup-cachyos.sh` v1.30.0 → v1.30.1,
`scripts/validate-setup.sh` v1.30.0 → v1.30.1.

### DRY-01 — Dry-Run spammte „No such file or directory“

**Symptom:** Jeder `--dry-run`-Lauf druckte pro Log-Zeile
`... setup-<ts>.log: No such file or directory` auf stderr.
**Ursache:** Der Default-Logpfad wurde gesetzt, das Verzeichnis aber im
Dry-Run nie angelegt; `_log_to_file()` hing am fehlenden Pfad.
**Fix:** Dry-Run ist stdout-only (`LOG_FILE=""`, Banner: `<nur stdout>`).
**Nachweis:** Dry-Run Ende-zu-Ende: Exit 0, stderr 0 Bytes.

### DRY-02 — Dry-Run führte real aus (Vertragsbruch)

**Symptom:** `--dry-run` („nichts ausführen“) fragte Cluster-Resets ab,
rief `psql` auf, kopierte `.env`-Backups, seedete die Registry (Upsert),
POSTete Seeds, schrieb `risk_config` und startete Server.
**Ursache:** Nur `run()`/`run_masked()` waren Dry-Run-sicher; direkte
`psql`-/`npm`-/`curl`-Aufrufe und Seiteneffekte hatten keine Guards.
**Fix:** Dry-Run-Guards in Schritt 03 (Cluster-Diagnose endet lesend),
04 (nur URI aufbauen), 05 (kein Backup/kein Schreiben), 07 (keine
Verifikation), 08 (kein Preset-Seed), 10 (komplett Vorschau);
`pg_cleanup_stale_pid()` und `pg_wait_ready()` melden statt zu handeln.
Vertrag jetzt exakt dokumentiert: **keine Schreiboperationen, lesende
Prüfungen laufen** (`--help`, `README.md`, `INSTALL.md`).
**Nachweis:** Simulierter Arch-Dry-Run (Stub-`pacman`/`sudo`): 10/10
Schritte, Exit 0, keine einzige Datei geschrieben (`git status` leer bis
auf die gewollten Code-Änderungen, kein `data/setup/`).

### UUID-01 — UUID-Prüfung case-sensitiv

**Symptom:** Großbuchstaben-UUIDs in `missions` zählten als „keine gültige
UUID“. **Ursache:** `!~` statt `!~*` (PostgreSQL und V07 akzeptieren beide
Schreibweisen). **Fix:** Ein Zeichen (`!~*`).
**Nachweis:** Parity mit `looks_like_uuid()` in `validate-setup.sh`.

### LOG-01 — Validierungs-Server ohne Log-Datei

**Symptom:** Bei unbeschreibbarem Log starb der Server-Start mit
„ambiguous redirect“ (`>>""`). **Fix:** Fallback `/dev/null`.

### SEC-PSQL — DB-Passwort in der Prozessliste

**Symptom:** Das Passwort war während des Setups für jeden lokalen
Benutzer lesbar (`ps aux`: Linux `-v db_pass=…`, Windows `psql -c …`).
**Fix:** Linux baut das SQL mit `printf` (regex-validierte Bezeichner,
Dollar-quoted Passwort mit kollisionsfreiem Tag) und füttert `psql` per
STDIN; Windows nutzt den neuen `Run-Stdin`-Helper. `psql` echot STDIN
ohne `-e` nicht (weder Terminal noch Log).
**Nachweis:** `pg_sql_quote_password()` gegen 10 gemeine Passwörter
(Quotes, `$`, Backticks, `%`-Formate, Semikola, Tag-Kollisionen,
Leerstring) — 10/10 Roundtrips exakt.

### ERR-01 — „Abbruch …“-Fehlalarme der ERR-Falle

**Symptom:** Auf frischen Hosts (keine `postgres`-Binaries, kein Cluster)
meldete das Setup „Abbruch in Schritt PostgreSQL-Cluster (Zeile …)“ —
und fuhr korrekt fort.
**Ursache:** Mit `pipefail` liefern `v="$(postgres … | sed …)"`,
`v="$(pg_config … | sed …)"` und `v="$(… cat PG_VERSION | tr …)"` 127/1;
die ERR-Falle feuert auch in Befehls-Substitutionen (doppelt: Subshell
plus Eltern), während `set -e` dort nicht abbricht. Die Lib war
„set -e-sicher“, aber nicht „ERR-Fallen-still“.
**Fix:** `|| true` an den drei Captures in
`scripts/lib/pg-cluster.sh` plus Token-/Preset-Parses im Setup
(Werte-/Verzweigungslogik unverändert).
**Nachweis:** Isolierte Reproduktion (vorher 6 Trap-Feuer, nachher 0);
voller Dry-Run mit stderr 0 Bytes; `tests/setupCluster.test.ts` und
`tests/setupPgService.test.ts` grün.

### STOP-01/02/03 — Stopp-Script

- **STOP-01:** Müll-`STOP_TIMEOUT` → `seq`-Fehler → SIGTERM-Wartezeit
  entfiel still → sofort SIGKILL. Jetzt validiert (1–300, Fallback 30).
- **STOP-02:** `pgrep`-Muster trafen auch die eigene Ahnenkette (Aufruf
  mit „next-server“ im Befehl tötete die aufrufende Shell — im Review
  live passiert). Keine PID der eigenen Kette bekommt je ein Signal.
- **STOP-03:** Muster verankert (Tokens statt Substrings):
  `less next-server.log` & Co. treffen nicht mehr.
  **Nachweis:** 13/13 Pattern-Fälle; Ende-zu-Ende mit Fake-Server
  (`argv[0]=next-server`): erkannt, per SIGTERM sauber gestoppt,
  Harness überlebt.

### VAL-01/02 — Validator

- **VAL-01:** Überschriften → `progress()` (stdout normal, stderr nur im
  JSON-Modus; stdout bleibt reines JSON).
- **VAL-02:** `baseUrl`/`version` jq-kodiert.
  **Nachweis:** `--json` gegen toten Server: valides JSON, Exit 1.

### SMOKE-01 — Smoke-Test auf Bash < 4.4

**Symptom:** `"${AUTH[@]}"` auf leerem Array bricht unter `set -u` auf
Bash < 4.4 (macOS 3.2) mit „unbound variable“ ab.
**Fix:** `${AUTH[@]+"${AUTH[@]}"}` (8 Stellen, wie `validate-setup.sh`).
**Nachweis:** `bash -n`; Pfad ohne Token gegen toten Server: Exit 1 mit
Hinweis (kein Crash).

### WIN-01–04 — Windows-Installer

- **WIN-01:** `.env` BOM-frei per .NET-UTF8-ohne-BOM (5.1- und 7-kompatibel
  — `Set-Content -Encoding UTF8` hängt auf 5.1 ein BOM an).
- **WIN-02:** Rollen-SQL via STDIN (`Run-Stdin`) statt `-c` (Passwort nie
  in `argv`/Task-Manager).
- **WIN-03:** Health-Check-Cleanup per `taskkill /T` (Baum-Kill gegen
  `node.exe`-Waisen) plus Port-Cleanup nur bei vorher freiem Port
  (fremde Instanzen werden nie beendet; Warnung bei belegtem Port).
- **WIN-04:** Schema-Verifikation (≥ 14 Tabellen) und
  `risk_config.allowShort = 1`-Upsert — Parität mit Linux-Schritt 07/10
  (zuvor blieb Windows auf Code-Default 0 statt Setup-Default 1).
  **Nachweis:** statisch (Klammer-Balance, keine PS-7-only-Syntax,
  Bindungen geprüft); Laufzeit auf Windows in CI/Review empfohlen.

### TS-CLIs (MDSYNC-002, LGSCAN-001, LGSTAMP-001, LGKILL-001, MICRO-001)

- **MDSYNC-002** (`scripts/lib/market-sync.ts`): Gate-Meldung ohne
  Doppel-Präfix (nur der Einstiegspunkt präfixt).
- **LGSCAN-001** (`scan-live-gate-secrets.ts`): Testdatei-Erkennung
  pfadbasiert statt inhaltsbasiert (8/8 Fälle).
- **LGSTAMP-001** (`live-security-stamp.ts`): `--source` validiert
  (`ci|manual`, sonst Exit 2 statt stillem `ci`-Fallback).
- **LGKILL-001** (`live-kill.ts`): Lesbare Meldung auch bei
  Nicht-Error-Würfen.
- **MICRO-001** (`micro-executor.ts`): `server.on("error")` — belegter
  Port beendet mit einer Zeile plus Executor-Stopp (Exit 1).
  **Nachweis:** Gate-Meldung einfach; Stamp-Validierung Exit 2/0;
  Secret-Scan weiter negativ (28 Dateien); `tsc`/`eslint` sauber;
  marketdata-CLI-Tests grün.

### Verifizierte Nicht-Befunde (bewusst nicht geändert)

- `PAPER:EURUSD=X`-Hinweis in `normalize-instrument-ids.ts` (Dry-Run):
  legale Alt-Notation, per Design nur Hinweis (SYM-007 §3.4).
- `run-scan.ts --candle-limit=abc`: bereits fail-loud
  („muss eine positive Ganzzahl sein“, Exit 1, kein Request).
- `"${VAR%$'\r'}"` in den Shell-Scripts: funktioniert (in
  Parameter-Expansion wird `$'…'` expandiert) — per Hex-Dump verifiziert.
- `Run`-Helper in `setup-windows.ps1`: `$LASTEXITCODE` übersteht die
  `Tee-Object`-Pipeline korrekt (Cmdlets ändern es nicht).
- Rolle `DILIGENCE`: kanonischer Name (Seed, Analysten, Handbuch
  konsistent) — kein Tippfehler.

---

## 11. Verwandte Dokumente

* [`SETUP_PG_TROUBLESHOOTING.md`](SETUP_PG_TROUBLESHOOTING.md) —
  PostgreSQL-Soforthilfe (Abschnitte 1–6)
* [`INSTALL.md`](INSTALL.md) — Installation auf CachyOS, Variante A/B
* [`MARKET_UNIVERSE.md`](MARKET_UNIVERSE.md) — Datenmodell der Registry
* [`MARKET_DATA_PIPELINE.md`](MARKET_DATA_PIPELINE.md) — Warmup/Sync (MDSYNC-001)
* [`CHANGELOG.md`](CHANGELOG.md) — Release-Eintrag v1.30.0
