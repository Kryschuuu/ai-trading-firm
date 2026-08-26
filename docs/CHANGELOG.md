# Changelog — Autonome KI-Trading-Firma

Alle für Nutzer sichtbaren Änderungen werden hier dokumentiert. Das Format folgt
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die Versionierung folgt
[SemVer](https://semver.org/lang/de/).

## Versionierungsrichtlinie

| Versionsstelle | Bedeutung | Beispiel |
| --- | --- | --- |
| **MAJOR** (1.x.y) | Breaking Changes: DB-Schema-Brüche, entfernte Env-Variablen, neue Pflichtkonfiguration | 2.0.0 |
| **MINOR** (x.1.y) | Neue Features (z. B. Provider), abwärtskompatibel | 1.2.0 |
| **PATCH** (x.y.1) | Bugfixes und Sicherheits-Fixes, abwärtskompatibel | 1.1.1 |

* Die Version steht in `package.json` (`"version"`) und wird von `/api/health`
  (`"version"`) und `/api/firm` (`"version"`) ausgeliefert.
* Empfohlene Deploy-Kette: `git pull` → `npm ci` → `npx drizzle-kit push` →
  `npm run build` → `sudo systemctl restart ai-trading-firm`.
* Migrationshinweise stehen in der jeweils betroffenen Release-Sektion.

---

## [1.5.4] — 2026-08-26 (aktuell)

**Setup-Schritt 2 repariert: `initdb`-Erfolg wurde fälschlich als „Cluster
unvollständig“ gemeldet (Rechte-Fehlalarm); umfassende Fehlerdiagnose und
Sofort-Hilfe-Anleitung ergänzt.**

### Ursache (Vorfall Nr. 2)

`initdb` läuft durch („Erfolg“), das Skript meldet trotzdem
`✗ Cluster nach initdb weiterhin unvollständig`. Grund: `initdb` setzt
`/var/lib/postgres` und `/var/lib/postgres/data` auf **0700 postgres:postgres**.
Die Cluster-Checks (`test -f PG_VERSION`, `global/pg_control`,
`global/pg_filenode.map`) liefen aber als **aufrufender Benutzer** →
`Permission denied` → falsch negativ. Dieselbe Ursache hatte die irreführende
Meldung „Datenverzeichnis existiert nicht oder ist leer“. Folge: Das Skript
hielt einen **vollständigen** Cluster für defekt und bot eine (datenzerstörende)
Neuinitialisierung an.

### Behoben

- **`scripts/lib/pg-cluster.sh` (neu):** Alle Prüfungen am Datenverzeichnis
  laufen als Cluster-Benutzer (`sudo -u postgres`, per `PG_SUDO_USER`
  übersteuerbar; Root/User selbst ohne sudo). Enthält:
  - Grundgerüst-Check (`PG_VERSION`, `global/pg_control`, `base/`) + optionaler
    Relmap-Marker **versionstolerant** (PG ≤ 18 verlangt `global/pg_filenode.map`,
    PG ≥ 19/unbekannt nur noch Warnpfad — künftige Major-Versionen brechen
    nicht mehr fälschlich ab);
  - **Versionsabgleich** Cluster ↔ Server (`PG_VERSION` + `pg_controldata`):
    Major-Mismatch ⇒ **Abbruch mit pg_upgrade/pg_dumpall-Anleitung statt
    automatischem, datenzerstörendem initdb**;
  - `pg_controldata`-Validierung (Version + Cluster-State) statt Datei-Raten;
  - ausführliche Diagnose (Owner/Rechte, Inhalt, PG_VERSION ↔ Server,
    pg_control, freier Platz, laufende Prozesse) — alles als postgres-Benutzer.
- **`scripts/setup-cachyos.sh` (Schritt 2):**
  - Preflight: sudo vorhanden? `postgres`-User existiert? sudoers-Mitgliedschaft?
  - Cluster-Check über den neuen Helper; Fehldiagnose „existiert nicht“ nur
    noch, wenn das Verzeichnis wirklich fehlt (sonst „Rechte nicht lesbar“);
  - nach `initdb`: erneute Verifikation mit Diagnose + **manuellem Fahrplan**
    (exakte Kommandos, inkl. „Nicht als root, nicht als normaler User —
    sondern `sudo -u postgres pg_ctl …` bzw. `sudo systemctl start postgresql`“);
  - Postgres-Dienststart: Port-/Fremdinstanz-Erkennung (fremder Prozess auf
    5432 ⇒ Abbruch; eigener, manuell gestarteter `pg_ctl`-Prozess auf
    demselben Cluster ⇒ Wiederverwendung mit Warnung);
  - veraltete `postmaster.pid` wird erkannt und (wenn der Prozess tot ist)
    entfernt; wartet nach `systemctl stop` auf echten Stop;
  - Cluster-Benutzergruppe dynamisch (`id -gn`), Locale-Fallback `C.UTF-8 → C`.
- **Neue Anleitung `docs/SETUP_PG_TROUBLESHOOTING.md`** (auch im Dashboard:
  `/api/docs?name=pgsetup`): Schritt-für-Schritt-Soforthilfe für den aktuellen
  Zustand, alle Fehlerfälle (Rechte, Version-Mismatch, postmaster.pid,
  Port-Konflikt, sudo/Benutzer, Logs) und eine Entscheidungstabelle.
- INSTALL.md Kap. 9/11 und HANDBUCH 10.6 verweisen auf die neue Anleitung.

### Getestet (Peer-Review)

- 149 Unit-Tests grün (`npm test`; +9: 8 neue in `tests/setupCluster.test.ts`
  plus 1 neuer Rechte-Regressionstest in `tests/dbConfig.test.ts`).
  Die Regressionstests stellen den Vorfall **mit echten Rechten** nach:
  Cluster-Verzeichnis gehört `nobody` und hat Mode 0700 — `test -f` als
  Aufrufer scheitert (EACCES), der neue Helper erkennt den Cluster trotzdem.
  Zusätzlich: Ablehnung unvollständiger PG-18-Cluster, Toleranz für
  künftige Layouts (PG 19 ohne Relmap), Versions-Mismatch,
  pg_controldata-Parser, set -e-Sicherheit.
- `npm run typecheck` + `npm run lint` sauber, `npm audit`: 0 Schwachstellen.
- **End-to-End** (Mock-systemd + Mock-initdb + echtes `sudo -u nobody` +
  PGlite-wire-Postgres):
  - Leeres Verzeichnis → `initdb` → Cluster wird als vollständig erkannt
    (vorher: „weiterhin unvollständig“) → Benutzer/DB → `drizzle-kit push`
    (9 Tabellen) → `next build` ✓;
  - **Datenschutz-Test:** vollständiger 0700-Cluster mit Sentinel-Datei →
    kein Neuinitialisierungs-Dialog, Sentinel überlebt, Setup läuft durch.

---

## [1.5.3] — 2026-08-26

**Setup-Installation läuft wieder durch: `${PGROOT}`-False-Positive behoben;
außerdem Passwort-URL-Encoding, echter `ANALYST_INTERVAL_MIN`-Zyklus und
durchgesetzte Missions-Positionsgrenzen.**

### Behoben

- **Setup-Skript (Schritt 2) — der gemeldete Installationsabbruch:**
  `systemctl show -p ExecStart --value postgresql.service` liefert die
  Arch-Unit-Zeile **unexpandiert** (`-D ${PGROOT}/data`). Der Datadir-Sicherheitsgurt
  verglich diesen Literalstring mit `/var/lib/postgres/data` und brach fälschlich ab:
  `✗ postgresql.service nutzt ein anderes Datenverzeichnis: '${PGROOT}/data'`.
  **Fix:** neues Modul `scripts/lib/pg-service.sh` — liest die
  Unit-Environment (`systemctl show -p Environment`, inkl. `EnvironmentFile`/Drop-ins)
  und expandiert `${VAR}`/`$VAR` im `-D`-Pfad, **bevor** verglichen wird. Versteht
  zusätzlich die systemd-Ausgabeformate `{ path=… ; argv[]=… }`, gequotete
  argv-Tokens und fällt bei fehlendem Bus auf `systemctl cat` zurück
  (Haupt-Unit + Drop-ins, letzte Definition gewinnt). Regressionstests simulieren
  die exakte Nutzer-Unit mit gemockter `systemctl`-Binary
  (`tests/setupPgService.test.ts`).
- **Setup-Skript: Passwort-URL-Encoding** — Zeichen wie `@ : / % + #` im
  DB-Passwort brachen die `DATABASE_URL` (psql, node-postgres, drizzle-kit).
  **Fix:** `jq '@uri'` vor dem URL-Bau; zusätzlich wird auch im
  „Benutzer existiert bereits“-Zweig ein leeres Passwort abgewiesen.
- **Scheduler:** `ANALYST_INTERVAL_MIN` wurde nur geloggt — der Analystenzyklus
  lief tatsächlich **jede Minute** (der v1.4.0-Kommentar versprach „echter Abstand“,
  der Code hielt es nicht). **Fix:** Slot-Key aus Berliner Tag + Intervallfenster
  (`Math.floor(Date.now() / analystIntervalMs)`), Overlap-Schutz gegen lange Läufe.
- **Missions-Cap wird durchgesetzt (Risiko-Entschärfung):** `missions.maxPositionPct`
  stand nur im Prompt — die PENNY-Mission („max 5 %“) konnte real **25 %** des
  Kapitals binden. **Fix:** `missionSizedNotional()` in `riskGuard.ts`
  (min(Missions-Cap, Code-Maximum), Sandbox-Prinzip), von der Engine verwendet;
  der Trace zeigt jetzt die wirksame Obergrenze.
- **Setup-Skript Konsistenz (Variante A):** `MODEL_EXECUTOR` wurde als 3b
  geschrieben, `.env.example`/Docs sagen 1.5b für den N150 — jetzt 1.5b.

### Getestet (Peer-Review)

- 138 Unit-Tests, alle grün (`npm test`) — inkl. neuer Regressionstests für
  `${PGROOT}`-Expansion, systemd-Formate, URL-Encoding, Missions-Sizing und
  Analysten-Intervall.
- `npm run typecheck` und `npm run lint` fehlerfrei; `npm audit`: 0 Schwachstellen.
- End-to-End gegen einen echten TCP-Postgres (PGlite-wire): kompletter
  `./scripts/setup-cachyos.sh --variant a`-Durchlauf mit der **exakten
  Arch-Unit des Nutzers** als Mock — Datadir-Check `✓`, hostile password
  `O'Brien@x:y/z p+q#%` angelegt und URL-encodet, `drizzle-kit push` → 9 Tabellen,
  `next build` ✓; zweiter Lauf (Idempotenz) ✓.
- Produktionsstart + `scripts/smoke-test.sh`: **18/18 Checks bestanden**
  (Pipeline → Paper-Trade → Kill-Switch → Flatten → Report/Kurve/Log →
  Ceiling-Klemmung). PENNY-Mission: Position ≈ 500 € statt 2.500 €.

---

## [1.5.2] — 2026-08-26

**Setup-/PostgreSQL-Robustheit: `global/pg_filenode.map`, ECONNREFUSED und
`next build` ohne `.env` behoben.** Ursachenanalyse und Fixes für den
Produktionsvorfall „Installation bricht bei Schritt 2 ab, danach schlagen alle
DB-Queries fehl“.

### Behoben

- **Setup-Skript (Schritt 2):** `sleep 1` + `systemctl is-active` meldete
  PostgreSQL fälschlich als „läuft“, obwohl ein halb initialisierter Cluster
  (fehlender `global/pg_filenode.map`) in einer Restart-Schleife crashte. Die
  Folge: `psql`-Fehler, danach fragte das Skript trotzdem nach dem
  Datenbank-Passwort und starb mit demselben Fehler. Neu:
  - Cluster-Vollständigkeit (`PG_VERSION`, `global/pg_control`,
    `global/pg_filenode.map`) wird **vor** dem Dienststart geprüft;
  - der Dienst wird vor einer Neuinitialisierung **gestoppt** (kein Race gegen
    systemd-Auto-Restart mehr);
  - echte Bereitschafts-Wartung mit `pg_isready` (30 s Timeout, Logauszug aus
    `journalctl` bei Fehlschlag) statt blindem Sleep;
  - harte SQL-Verifikation als Superuser, **bevor** Benutzer/Passwort abgefragt
    werden — der Fehler wird nicht mehr vom `if/grep` verschluckt;
  - Abgleich des systemd-Datenverzeichnisses gegen das erwartete
    `/var/lib/postgres/data` (Drop-in-Erkennung).
- **Quote-/Injection-Bug im Setup-Skript:** `CREATE USER … PASSWORD
  '${DB_PASS}'` brach bei einem `'` im Passwort das SQL. Neu: psql-Variablen
  (`-v db_pass=…` + `:'db_pass'`), kontextsicher maskiert; DB-User/DB-Name
  werden per Regex validiert. Gegen echte PostgreSQL 16/18 mit feindlichem
  Passwort (`O'Brien"; DROP SCHEMA public; --`) getestet.
- **`initdb`-Defaults:** `--data-checksums --auth-local=peer
  --auth-host=scram-sha-256` — keine „trust“-Warnung mehr, Korruption wird
  erkannt, TCP-Logins laufen über scram-sha-256.
- **`next build` ohne `.env` (frischer Clone):** `src/db/index.ts` warf beim
  Modul-Import ohne `DATABASE_URL` und riss damit den Build während der
  Next.js-Page-Data-Collection ab (`Failed to collect page data for
  /api/firm/agents`). Neu: Pool/Drizzle werden **lazy** beim ersten Zugriff
  erzeugt (Proxy-Facade); der Import ist ohne Konfiguration harmlos, die erste
  echte Nutzung wirft eine präzise, actionabel Fehlermeldung. Build und Tests
  funktionieren damit auch ohne `.env`.
- **`uncaughtException` bei PostgreSQL-Ausfall:** Fällt PostgreSQL weg, während
  Pool-Verbindungen idle sind (SIGTERM → `57P01`), emittierte node-postgres ein
  `'error'`-Event ohne Listener → uncaughtException mit riesigem Objekt-Dump im
  Journal. Fix: Pool-`'error'`-Handler (`[db] Pool-Fehler (idle client): …`);
  die App degradiert kompakt und erholt sich nach DB-Rückkehr ohne Neustart
  (end-to-end verifiziert).
- **SL/TP gingen bei der Broker-Hydration verloren:** `getBroker` reichte
  `stop_loss`/`take_profit` beim Wiederherstellen aus der DB nicht an den
  Paper-Broker weiter — das Dashboard zeigte nach jedem Neustart „kein
  Stop-Loss", obwohl die DB ihn hat (die Absicherung via Monitor blieb intakt,
  die Anzeige log). Fix: SL/TP werden mithydratiert und in `hydrate()`
  zusätzlich gesanitized (null/NaN/≤0 → null).
- **Missions-API-Fehlermeldung mehrdeutig:** `POST /api/firm/missions` erwartet
  Bruchteile (0.02 = 2 %), die Meldung nannte nur Prozent („zwischen 0.2 % und
  5.0 %"). Neu: Meldung nennt Bruchteil **und** Prozent mit Umrechnungshinweis.

### Hinzugefügt

- **8 Regressionstests** (`tests/dbConfig.test.ts`, `tests/broker.test.ts`):
  pg_isready-Wartung, Cluster-Vollständigkeitsprüfung, initdb-Auth-Flags,
  injection-sichere Passwort-Interpolation, Import ohne `DATABASE_URL`
  (Subprozess), actionable Fehlermeldung bei Nutzung ohne `DATABASE_URL`,
  Pool-`'error'`-Handler sowie Erhalt/Sanitizing von SL/TP bei der Hydration.
- **Handbuch-Runbook 10.6 „PostgreSQL-Cluster defekt“** — Diagnose und
  Reparatur des `pg_filenode.map`-Zustands inkl. der kettenreaktionsartigen
  Symptome (Scheduler-/Hydration-Fehler, Setup-Seite, `ECONNREFUSED` beim Push).
- INSTALL.md: gehärtete initdb-Zeile, `pg_isready`-Schritt, aktualisierte
  Fehlertabelle (u. a. entfernte, veraltete `SCHEMA_MISSING`/HTTP-503-Zeile).

### Diagnose

- Der Vorfall ist vollständig reproduziert und verifiziert: Ein Cluster mit
  fehlender `global/pg_filenode.map` startet laut `pg_ctl status`/systemd
  normal („running“/„active“), nimmt aber keine Verbindungen an
  (`pg_isready` → *rejecting*) und wirft exakt
  `FATAL: could not open file "global/pg_filenode.map"`.
- End-to-End gegen echte PostgreSQL-18-/16-Cluster geprüft: Setup-Kette
  (initdb → User/DB mit feindlichem Passwort → `drizzle-kit push` → Seed →
  Pipeline-Run → Position/Equity/Audit), Deprecation-freier Build mit und ohne
  `.env`, DB-Ausfall mitten im Betrieb (kompakte Degradation) und
  Wiederanlauf ohne Dienstneustart.

---

## [1.5.1] — 2026-08-25

**Sicherheits-Härtung und DB-Konfigurationsdiagnose.** Peer-Review-Fixes für
Fehlerbehandlung in API-Routen und gehärtete Datenbank-Pool-Konfiguration.

### Behoben (Sicherheit)

- **S-21 (Medium)**: API-Routen `firm/run`, `firm/tick`, `firm` (GET) gaben rohe
  Fehlermeldungen an den Client zurück. Datenbank-Connection-Strings und interne
  Details konnten in HTTP-Responses landen. Fix: `publicErrorMessage()` in allen
  betroffenen catch-Blöcken.
- **S-22 (Low)**: `GET /api/firm` hatte keinen try/catch — DB-Ausfall führte zu
  unhandled exceptions mit potenziellem Stack-Trace-Leak. Fix: 503 mit redacted
  Error und Fix-Hinweis.
- **S-23 (Low)**: DB-Connection-Pool hatte keine `max`-Grenze und keine Timeouts.
  Fix: `max: 10`, `connectionTimeoutMillis: 5000`, `idleTimeoutMillis: 30000`.

### Hinzugefügt

- **12 neue Tests** (`tests/dbConfig.test.ts`): Validierung der DB-Konfiguration,
  Sicherheitsdirektiven und Fehlerbehandlung. Prüft drizzle.config.ts auf
  Hardcodierung, Pool-Sicherheit, Security-Header und API-Error-Redaktion.

### Diagnose

- Der Datenbankfehler `password authentication failed for user "trader"` ist
  ein Konfigurationsproblem — das Setup-Script `scripts/setup-cachyos.sh` legt
  den User korrekt an, muss aber ausgeführt werden. Siehe `docs/INSTALL.md`.

---

## [1.5.0] — 2026-08-25

**Workshop: Handbuch-Kapitel 5 und 6 ohne Terminal.** Neuer Dashboard-Reiter
🛠 Workshop mit vier Schritten (Mission anlegen → Agent ausführen → Prompt
iterieren → Trefferquote messen), dazu die passenden API-Routen. Kein
Schema-Bruch, keine neuen Pflicht-Env-Variablen. Nach `git pull`:
`npm ci && npm run build` und Dienst neu starten.

### Added
- **Reiter „🛠 Workshop“** (`src/components/workshop/`):
  - **1 · Mission anlegen/bearbeiten** (5.1–5.3): Formular mit Titel, Ziel,
    Symbol-Autocomplete (aus `GET /api/firm/missions` → Broker-Liste),
    Risikobudget % und max. Position %; Nachschlagkasten mit Faustregel
    („nicht per SQL prüfbar → zu vage“) und der Schlecht/Besser-Tabelle aus 5.2.
  - **2 · Agent ausführen** (6.2): Agent + Mission wählen, ein Turn; Ergebnis
    formatiert (`type`/`side`/`stopLossPct`/`riskScore`/`reason` mit
    Hover-Erklärungen), Guardrail-Kette aufklappbar, Rohdaten-Anzeige; rechts
    die letzten 3 Agenten-Nachrichten mit Quelle und Latenz.
  - **3 · Prompt iterieren** (6.3): `system_prompt`-Editor mit sofortiger
    Wirkung (DB, kein Neubau), JSON-Sollformat + vollständiges Beispiel,
    Feld-Hilfen zu `type`/`side`/`stopLossPct`/`riskScore`, „Beispiel an Prompt
    anhängen“-Knopf, grünes Speicher-Bestätigungsfeld. Bewusst **ohne**
    Guardrail-Regler (weiche vs. harte Schicht).
  - **4 · Trefferquote** (6.4): sequenzielle Testschleife (1–20 Läufe, Standard
    10) mit Live-Balken (TRADE / HOLD / HOLD·kaputtes JSON / ERROR / ANDERE),
    automatischen Debug-Tipps ab 2 JSON-Fällen bzw. 20 % Anteil, Fehlerliste
    mit Sprung ins Protokoll-Tab; Stop-Knopf; sauberes 429-Handling.
- **Hover-/Tastatur-Hilfe überall**: `InfoTip`-Komponente (i-Symbol) auf jedem
  Feld und Fachbegriff — Tooltip bei Hover UND Focus, `title`-Fallback,
  `aria-label` + sr-only-Text für Screen Reader.
- **API-Routen**: `GET/POST/PUT /api/firm/missions` und `PUT /api/firm/agents`
  (nur `system_prompt`). Budgets werden gegen `LIMIT_CEILINGS` validiert (90 %
  Risiko → 400 statt Broker-Block), Symbole gegen die Paper-Broker-Liste,
  Prompts auf Länge; Audit-Einträge `MISSION_CREATED`/`MISSION_UPDATED`/
  `AGENT_PROMPT_UPDATED`.
- **`src/lib/workshop.ts`**: reine Validierungs-/Klassifikationslogik
  (`validateMissionInput`, `validatePromptInput`, `classifyTurnOutcome`,
  `aggregateOutcomes`), von Routen und Tests geteilt.
- **Typsicherheit**: `src/lib/types.ts` (AgentRow, MissionRow, TurnResultDto,
  Response-Interfaces) — `FirmData.agents/missions` typisiert statt `any`.
- **`src/lib/apiClient.ts`**: geteilter `apiFetch` (Token-Header) +
  `readJson`-Fehlerwrapper für aussagekräftige API-Fehlermeldungen.
- `GET /api/firm/log` liefert jetzt auch `content` (Kurzform der Nachricht) —
  Grundlage für die „letzten 3 Nachrichten“-Anzeige.
- Neue Tests: `tests/workshop.test.ts` (Validierungs-Edge-Cases: leere
  Eingaben, 90-%-Budget, unbekannte Symbole, Prompt-Grenzen, Warnungen;
  Klassifikation TRADE/HOLD/INVALID_JSON/ERROR; Aggregation inkl. Tipps-
    Schwelle und Division durch 0).

### Changed
- `package.json` Version **1.5.0**.
- Handbuch 2.3/4.1/5.1–5.3/6.1–6.4: UI-Weg jeweils vorangestellt, Terminal als
  Alternative belassen; API-Tabelle um die Workshop-Routen ergänzt.

### Security
- Missions-/Prompt-Endpunkte hängen am bestehenden `guardWrite` (Token +
  Rate-Limit); DB-Fehler werden als 503 mit redaktierter Meldung
  (`publicErrorMessage`) zurückgegeben statt als undurchsichtiger 500-Crash.
- Missions-Budgets werden **serverseitig** gegen die Code-Deckel geprüft —
  die UI ist nur Anzeige, nicht Kontrollinstanz.

---

## [1.4.0] — 2026-08-25

Security-Härtung, Provider-Korrektheit und Scheduler-Fix. Kein Schema-Bruch,
keine neuen Pflicht-Env-Variablen. Nach `git pull`: `npm ci && npm run build`
und Dienst neu starten.

### Added
- **Schreib-Rate-Limit** für POST/PUT (`guardWrite`): Standard 60 Anfragen / 60 s,
  abschaltbar via `FIRM_RATE_LIMIT=0`. Antwort 429 + `Retry-After`.
- **Secret-Redaktion** (`src/lib/secrets.ts`): Connection-Strings, Bearer-Tokens
  und API-Keys werden aus Health-Fehlern, LLM-Logs und öffentlichen Error-Strings
  entfernt.
- **`extractJsonObject()`**: sicherer JSON-Extractor für Analysten-Payloads
  (view/thesis/recommendation), ohne Prototype-Pollution.
- **`envInt()`**: NaN-feste Env-Zahlen mit Clamp — `TICK_INTERVAL_MS=abc` startet
  den Scheduler nicht mehr mit `setInterval(NaN)`.
- Neue Tests: `tests/hardening.test.ts` (Secrets, Token, Rate-Limit, Intervalle,
  parseDecision-Allowlist, Broker-Reject) plus Erweiterungen in `llmProvider.test.ts`.

### Changed
- `package.json` Version **1.4.0**.
- Gemini-Auth: Key ausschließlich im Header `x-goog-api-key` (nicht mehr als
  Query-Parameter — Keys gehören nicht in Access-Logs/Referrer).
- `LLM_MODEL` gilt jetzt für Gemini **und** Anthropic, nicht nur OpenAI-kompatibel.
- Ollama `keep_alive` ist Top-Level (API-konform); Usage (`prompt_eval_count` /
  `eval_count`) wird geparst.
- Token-Limit der Builder folgt `req.maxTokens` (nicht dem bei Client-Erzeugung
  eingefrorenen Wert).
- `parseDecision` kopiert nur Allowlist-Felder (`type/symbol/side/stopLossPct/reason/riskScore`).
- Audit-Log-Filter (`level`/`event`) und Equity-`range` sind gewhitelistet.
- Agenten-Meta speichert `provider`, `usage`, `costUsd`.

### Fixed
- **Gemini-API-Key in der URL** (High): Query `?key=` entfernte den Key in Logs.
- **Gemini-Modellliste** `models/gemini-…` wurde 1:1 in den Pfad gesetzt →
  `/models/models/…`. Prefix wird jetzt gestrippt.
- **Anthropic `listModels`** las `models[].name` statt `data[].id` → leere Liste.
- **Retry-`attempt`** war immer 1, weil `client.chat` den Zähler verwarf.
- **Analysten-Intervall**: `ANALYST_INTERVAL_MIN` wurde nur geloggt; der Slot-Key
  `HH:MM` ließ die Analysten **jede Minute** laufen. Jetzt echter Abstand
  (Default 30 min, Minimum 10).
- **Broker-Cash nach Slippage**: Prüfung gegen Pre-Slippage-Notional konnte das
  Konto um 0,1 % negativ machen. Jetzt Fill-Kosten.
- **`reject()` crashte** bei nicht-string `symbol` (`toUpperCase` auf Number).
- **`hydrate()`** übernahm unsanitized DB-Symbole in die Position-Map.
- **Kerzen-Intervalle und Yahoo-Screener-IDs** ohne Whitelist (URL-Injection).
- **Health-500** konnte `DATABASE_URL` in `error` durchreichen.
- **Provider-Base-URL**: `file:` / Userinfo (`user:pass@host`) werden abgelehnt.

### Security
- Timing-sicherer Token-Vergleich mit Längen-Padding (kein Length-Oracle).
- `npm audit`: Ziel 0 Vulnerabilities (siehe SECURITY_AUDIT.md).

### Tests
- Bisherige 67 Tests bleiben; neu ~25 Härte-/Provider-Tests. `npm test` muss
  vollständig grün sein.

### Anmerkung Migration
Kein DB-Schema-Change. `.env` optional um `FIRM_RATE_LIMIT` ergänzen.
Wer Gemini nutzt: Header-Auth ist transparent, keine Key-Änderung nötig.

---

## [1.3.0] — 2026-08-24

### Added
- **LLM-Provider-Abstraktion** (`src/lib/llmProvider.ts`) mit vier konfigurierbaren
  Providern hinter EINEM Interface:
  - `ollama` — nativer Ollama-Server (Standard)
  - `openai` — jeder OpenAI-kompatible Endpunkt (llama.cpp, LM Studio, vLLM, LocalAI, Cloud)
  - `gemini` — Google Gemini (`GEMINI_API_KEY`, `GEMINI_BASE_URL`)
  - `anthropic` — Anthropic Claude (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`)
- **Provider-Fallback-Kette** `LLM_FALLBACK_PROVIDERS` (kommagetrennt): scheitert der
  primäre Provider, werden die nächsten der Kette probiert, bevor die Regel-Engine greift.
- **Standardisierte API-Calls**: `LlmChatRequest {model, messages, temperature, maxTokens, json, schema, timeoutMs}` → `LlmChatResult {content, usage, latencyMs, costUsd}`.
- **Fehlerbehandlung & Retries**: `withRetry()` mit exponentiellem Backoff + Jitter;
  Retry nur bei Netzwerkfehlern, HTTP 429 und 5xx; `LLM_MAX_ATTEMPTS` (Standard 2).
- **Kosten-/Performance-Trade-offs**:
  - `LLM_MAX_TOKENS` (Standard 512) begrenzt jede Antwort (`num_predict`/`max_tokens`/`maxOutputTokens`).
  - `estimateCostUsd()` schätzt Kosten je Aufruf (Referenztarife + `LLM_COST_*`-Overrides, lokal = 0).
  - Token-Verbrauch (`usage`) wird in `agent_messages.meta` protokolliert.
- **Versions-Reporting**: `/api/health` und `/api/firm` liefern jetzt `version` aus `package.json`.
- **Dokumente umstrukturiert**: alle Markdown-Dateien liegen unter `docs/`
  (`docs/README.md`, `docs/INSTALL.md`, `docs/HANDBUCH.md`, `docs/CHANGELOG.md`,
  `docs/SECURITY_AUDIT.md`, `docs/PROVIDER_INTEGRATION.md`).
- Neue Tests: `tests/llmProvider.test.ts` (Builder, Parser, Retry, Backoff, Kosten,
  Fallback-Kette), `tests/broker.test.ts` (Hydration, Guardrails, Validierung),
  `tests/security.test.ts` (Symbol-Whitelist, Injection-Versuche, parseDecision-Robustheit).

### Changed
- `package.json`: Name `ai-trading-firm`, Version `1.3.0`, `engines.node >= 20`, License MIT.
- `.env.example`: neue Sektionen „Cloud-Provider", „Retries", „Kosten", „Scheduler".
- `src/lib/ollama.ts` ist jetzt die Kompatibilitäts- und Orchestrierungsschicht über
  `llmProvider.ts`; öffentliche Funktionen (`getOllamaStatus`, `localReason`,
  `fallbackReason`, `DECISION_SCHEMA`) bleiben stabil.
- `scripts/setup-cachyos.sh` erwartet jetzt **9** Tabellen (inkl. `equity_snapshots`).

### Fixed
- Siehe [1.1.0] (alle Bugfixes sind in 1.3.0 enthalten).

---

## [1.1.0] — 2026-08-24 (Security- & Stabilitäts-Release)

### Fixed (hoch)
- **P&L-Verlust nach Neustart** (`engine.getBroker` + `PaperBroker.hydrate`):
  Der Cash-Stand wurde aus `STARTING_EQUITY − Einstiegs-Notional` rekonstruiert.
  Realisierte Gewinne/Verluste geschlossener Trades gingen bei jedem Prozess-Neustart
  verloren (Depot zeigte wieder 10.000 € statt z. B. 10.200 €).
  **Fix:** letzter persistenter Cash-Wert aus `equity_snapshots` wird als `cashHint`
  übernommen; Fallback nur bei leerer/frischer DB.

### Fixed (mittel)
- **Tagesverlust-Fenster in `engine.ts`** nutzte Server-Localtime statt
  `Europe/Berlin` — inkonsistent zu `monitor.tick()` und `equity.realizedPnlToday()`
  (systemd läuft oft mit UTC). **Fix:** `startOfBerlinDay()`.
- **GET `/api/firm/tick` mutierte Zustand** (Kurse, SL/TP → Positionen schließen).
  Browser-Prefetches/Monitore lösten dort Handel aus. **Fix:** GET → HTTP 405.
- **Race Conditions**: `monitor.tick()` und `runPipeline()` hatten keinen
  Single-Flight-Schutz — überlappende Zyklen erzeugten doppelte Snapshots,
  Vorschläge und Audit-Einträge. **Fix:** Promise-Lock (Tick) bzw. Guard
  (`PIPELINE_ALREADY_RUNNING` → HTTP 409).
- **Symbol-Validierung**: Modell-/DB-Symbole flossen ungeprüft in externe URLs
  (Binance-Query), Prompts und JSONB. **Fix:** `sanitizeSymbol()`-Whitelist
  (`^[A-Z0-9]{1,12}([.=][A-Z0-9]{1,5})?$`) in `marketData`, `broker.submit` und
  `engine.runAgentTurn`; Binance-URLs zusätzlich `encodeURIComponent`.
- **Security-Header fehlten** (`next.config.ts`): jetzt CSP, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy` in Produktion (Dev bleibt offen für HMR).
- **`checkSchema()` kannte `equity_snapshots` nicht** → Healthcheck meldete
  „schemaReady" obwohl die Equity-Kurve/Snapshots fehlten; Setup-Skript prüfte 8 statt 9 Tabellen.

### Fixed (niedrig)
- `/api/firm/log?limit=NaN|-5` → SQL-Fehler 500. **Fix:** Limit auf 1–200 geklemmt.
- `stopLossPct: "abc"`/`NaN` → Order wurde mit NaN kalkuliert und pauschal geblockt.
  **Fix:** nicht-zahlfähige Werte gelten als „keine Angabe" → ATR-/Default-Fallback.
- `riskScore` aus Modell-Output ohne Zahlenvalidierung konnte Insert in `numeric`
  sprengen. **Fix:** Normalisierung auf [0,1].
- `scripts/drizzle.config.json` (veraltet, hardcodierte DB-Zugangsdaten) entfernt —
  das Projekt nutzt `drizzle.config.ts` mit `DATABASE_URL` aus `.env`.
- `scripts/smoke-test.sh` prüfte das Feld `status`/`SCHEMA_MISSING`, das die API nie
  liefert (toter Setup-Zweig). **Fix:** `schemaReady === false`.
- Scheduler-Analysten-Slot nutzte Server-Stunde statt Berliner Zeit → Doppelstart-
  Schutz griff auf UTC-Servern unzuverlässig. **Fix:** `Europe/Berlin`-Schlüssel.
- Lint: 10 Fehler in `FirmDashboard.tsx`/`docs/page.tsx` (unescaped entities,
  setState im Effekt) behoben — `npm run lint` ist jetzt fehlerfrei.
- `tsconfig.tsbuildinfo` aus dem Repo entfernt und per `.gitignore` ausgeschlossen.

### Security (geprüft, keine Änderung nötig)
- `npm audit`: **0 Schwachstellen** (Stand des Release).
- API-Token-Vergleich: `crypto.timingSafeEqual` ✓
- Keine `eval`/`child_process`/`exec`, keine `dangerouslySetInnerHTML` ✓
- `parseDecision`-Prototype-Pollution-Test (neu) ✓
- SQL: ausschließlich parametrisierte Queries via Drizzle ✓

### Tests
- 63 Unit-Tests, alle grün (`npm test`).
- Neu: Broker-Hydration (Neustart-Fix), Symbol-Injection, parseDecision-Robustheit,
  Provider-Builder/Parser, Retry/Backoff, Kosten, Fallback-Kette, KILL-Marker.

### Anmerkung Migration
Kein Schema-Bruch: `equity_snapshots` existierte bereits; geändert wurde nur die
Prüfung. Bei Alt-Installationen einfach `npx drizzle-kit push` erneut ausführen.

---

## [1.0.0] — 2026-08 (Ausgangsstand beim Audit)

Baseline: Archiv-Repository mit Engine, Paper-Broker, Ollama/OpenAI-Client,
Guardrails, Monitor, Analysten, Dashboard und erster Test-Suite (26 Tests).

---

## Offen / bewusst nicht gemacht (Backlog)

| Thema | Grund |
| --- | --- |
| Multi-Node Rate-Limit / Scheduler-Locks | v1.4.0 limiter ist prozess-lokal; Cluster bräuchte Redis/DB |
| Auto-Upgrade der Abhängigkeiten | Versions-Pins sind bewusst stabil; `npm audit` als Teil des Deploy-Checks |
| Live-Broker-Adapter (Alpaca/ccxt) | bewusst außerhalb des Paper-only-Scopes (Handbuch Kapitel 8) |
| Persistente Scheduler-Locks über Prozesse hinweg | aktuell prozess-lokal (Single-Node-Betrieb); Multi-Node bräuchte DB-Locks |
