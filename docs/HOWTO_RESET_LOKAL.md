# Firma lokal sauber neu aufsetzen (Datenbank leeren + komplett neu bauen)

> **Für wen:** alle, die ihre lokale Instanz von `ai-trading-firm` auf „Werkseinstellung“
> zurücksetzen wollen — ohne dabei den PostgreSQL-Cluster, die `.env` oder den Code zu sprengen.
>
> **Grundsatz:** Erst stoppen → dann sichern → dann löschen → dann neu bauen → dann seeden → dann prüfen.
> **Niemals umgekehrt.** Jeder Schritt hat eine Kontroll-Ausgabe; wenn die nicht passt, weitermachen **erst** nachdem du sie verstanden hast.

Alle Befehle laufen im Projektordner:

```bash
cd ~/ai-trading-firm        # bzw. dorthin, wo dein Clone liegt
```

---

## 0. Die Kurzform (wenn du alles verstanden hast)

```bash
# 1) Alles stoppen
npm run stop
sudo systemctl stop ai-trading-firm micro-executor 2>/dev/null || true

# 2) .env in die Shell laden + Sicherung (5 s, rettet dich danach wochenlang)
set -a; eval "$(scripts/env-run.sh)"; set +a     # fish: scripts/env-run.sh --fish | source
test -n "$DATABASE_URL" || { echo "DATABASE_URL ist leer — .env nicht geladen? (Abschnitt 2.5)"; exit 1; }
mkdir -p ~/backups
pg_dump "$DATABASE_URL" | gzip > ~/backups/firm-vor-reset-$(date +%F-%H%M).sql.gz
test -s ~/backups/firm-vor-reset-*.sql.gz || echo "WARNUNG: Sicherung ist leer — Schritt 3 aussetzen."

# 3) Datenbank leeren (nur INHALTE, Struktur bleibt)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "TRUNCATE agents, missions, positions, proposals, order_intents, trade_rules, rule_executions, rule_backtests, agent_messages, audit_log, equity_snapshots, kill_switches, risk_config, broker_credentials, venue_control_state RESTART IDENTITY CASCADE;"

# 4) Laufzeit-Dateien löschen
rm -rf data/history data/market-data-errors.json data/spread-cache.json \
       data/market-sync-status.json data/audit-spool data/routing data/live-gate artifacts

# 5) Komplett neu bauen (npm ci dauert ein paar Minuten — das ist normal)
rm -rf .next node_modules/.cache node_modules
npm ci
npx drizzle-kit push --force

# 6) Universum neu einspielen
npm run universe:seed:markets
npm run universe:seed

# 7) Build
npm run typecheck && npm run build

# 8) Starten + Seed + Prüfen
npm run start &
sleep 10
curl -s -X POST http://localhost:3369/api/seed -H "x-firm-token: $(grep -m1 '^FIRM_API_TOKEN=' .env | cut -d= -f2-)" | jq
./scripts/validate-setup.sh
```

Der Rest dieses Dokuments erklärt die Schritte einzeln — lies es beim ersten Mal komplett.

---

## 1. Welche Reset-Stufe willst du? (bewusst entscheiden)

| Stufe | Was passiert | Wann sinnvoll |
| --- | --- | --- |
| **A — nur Daten löschen** *(empfohlen)* | Alle Zeilen in den 15 Tabellen weg, Schema + `.env` + `node_modules` bleiben | Normalfall: „Firma soll wieder bei 0 anfangen“ |
| **B — Datenbank neu anlegen** | DB `DROP` + `CREATE`, dann Schema-Push von Grund auf | Schema-Verschmutzung, falsche Encoding/Locale, „eine Tabelle fehlt trotzdem“ |
| **C — Cluster-Reset** | Ganzes PostgreSQL-Datenverzeichnis neu initialisiert (`initdb`) | Cluster kaputt (`global/pg_filenode.map`, Restart-Schleife). **Löscht ALLE Datenbanken auf dem Rechner** |

Für **C** gibt es einen eingebauten, abgesicherten Weg — niemals von Hand `rm -rf /var/lib/postgres`:

```bash
./scripts/setup-cachyos.sh --variant a --reset-cluster      # fragt vorher Rückfrage
./scripts/setup-cachyos.sh --variant a --reset-cluster -y   # ohne Rückfrage
```

Das Skript ist idempotent, ergänzt eine vorhandene `.env` nur (Schreiben ist seit v1.39.1
die Ausnahme: `--force-env` sichert sie vorher und holt bekannte Schlüssel automatisch
zurück — siehe `docs/SETUP_BUGS.md`, Befund SET-09) und fährt am Ende die 18-Check-Validierung.
Wenn es durchläuft, sind die Schritte 3–8 hier überflüssig.

**Wenn das Setup bei „Konfiguration (.env)“ abbricht** („Abbruch in Schritt … Exit 1“ ohne
weitere Meldung): das ist der dokumentierte Befund SET-09 — eine Schritt-Funktion endete mit
einem Test und `set -Ee` wertete das als Fehlschritt. Der Schritt selbst war vollständig
durchgelaufen, es wurde nichts halbfertig hinterlassen. Ab v1.39.1 meldet das Skript das
fehlgeschlagene Kommando und die Funktion; auf einem älteren Stand einfach von Schritt 7
(`docs/INSTALL.md` Kapitel 5.2) an weiterarbeiten.

---

## 2. Schritt 0 — Vorbereitung (2 Minuten, Pflicht)

```bash
# a) Liegt ungesicherte Arbeit im Code? (sollte leer / clean sein)
git status --short

# b) Welche Datenbank ist überhaupt gemeint? (steht in deiner .env)
grep -m1 '^DATABASE_URL=' .env
```

> **Falle:** Es gibt *zwei* Datenbanken auf vielen Setups — die Firm-DB und die Test-DB
> `postgresql://test:test@0.0.0.0:5432/test` (nutzen nur `npm test`).
> Löschen darf nur die aus `DATABASE_URL`. Zur Kontrolle:
>
> ```bash
> psql "$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)" -c "SELECT current_database(), count(*) FROM agents;"
> ```
>
> Achte darauf, dass deine Shell nicht noch ein **altes exportiertes** `DATABASE_URL` mit sich
> herumschleppt: Schritt 2 c) überschreibt es zwar mit dem Wert aus `.env`, aber ein vergessenes
> `export` in `~/.bashrc` kann dich auf die falsche DB zeigen lassen. Das `echo` am Ende von
> Schritt 2 muss deshalb auf Zeichen genau die `DATABASE_URL`-Zeile aus `.env` zeigen.

```bash
# c) .env in die Shell holen — EINMAL pro Terminalfenster, gilt für ALLE Schritte
#
# bash / zsh:
set -a; eval "$(scripts/env-run.sh)"; set +a

# fish (die zwei Zeilen oben sind dort ein Syntaxfehler — nutze den Loader):
scripts/env-run.sh --fish | source

# in JEDE Shell (braucht nur Node, keinen bash):
eval "$(node scripts/load-env.mjs --sh)"          # fish: node scripts/load-env.mjs --fish | source

echo "DB = $DATABASE_URL"      # erwartet: postgresql://trader:<passwort>@127.0.0.1:5432/trading_firm
```

> **Diese Zeilen sind kein Deko-Teil.** Ohne sie kennt deine Shell `$DATABASE_URL` nicht,
> und *jedes* `psql`/`pg_dump "$DATABASE_URL"` fällt auf libpq-Defaults zurück: Socket
> `/run/postgresql`, Benutzer = dein Login-Name. Das ist die Fehlermeldung
> `FATAL: role "dein-login" does not exist` — nicht die Datenbank ist kaputt, der Befehl hat
> nur nie deine `.env` gelesen. Nach jedem neuen Terminalfenster (und nach `su`/`sudo -i`)
> neu ausführen.
>
> **Finger weg von `set -a; . ./.env` in fish** und von `export (cat .env | xargs)`: Die `.env`
> enthält Kommentarzeilen, und die landen dann als „Variablennamen“ durch. `scripts/env-run.sh`
> und `scripts/load-env.mjs` sind dieselbe, getestete Parser-Logik
> (`tests/setupScripts.test.ts`) — sie ignorieren Kommentare, `export`-Präfix, ` #`-Reste und
> CRLF und quotieren Werte so, dass `eval`/`source` sie wörtlich nimmt.

---

## 2.5 Shell-Kompatibilität (bash · zsh · fish · PowerShell)

Alle Skripte in `scripts/` sind **bash**. Die Anweisungen hier sind so geschrieben, dass sie
in bash und zsh unverändert funktionieren; für andere Shells gilt:

| Was | bash / zsh | fish | PowerShell |
| --- | --- | --- | --- |
| Setup-Skript | `./scripts/setup-cachyos.sh --variant a` | `bash scripts/setup-cachyos.sh --variant a` | `scripts\setup-windows.ps1` |
| Validierung / Smoke-Test | `./scripts/validate-setup.sh` | `bash scripts/validate-setup.sh` | `bash scripts/validate-setup.sh` (WSL/Git-Bash) |
| `.env` laden | `set -a; eval "$(scripts/env-run.sh)"; set +a` | `scripts/env-run.sh --fish \| source` | `.env` wird von der App selbst geladen (`dotenv`) |
| Shell-Variablen | `STAMP=$(date +%F-%H%M)` | `set STAMP (date +%F-%H%M)` | `$STAMP = Get-Date -Format …` |
| Einzelwert lesen | `scripts/env-run.sh --raw --print DATABASE_URL` | `node scripts/load-env.mjs --raw --print DATABASE_URL` | `node scripts/load-env.mjs --raw --print DATABASE_URL` |

`--print KEY` gibt bei **beiden** Loadlern nur den Wert aus (kein `KEY=`), mit `--raw`
unmaskiert — so funktioniert `VAR="$(… --raw --print KEY)"` überall identisch.

Drei Regeln, die die meisten Fehler dieser Sektion verhindern:

1. **`VAR=wert befehl` ist in fish kein „Temporär-Export“**, sondern ein Syntaxfehler. In fish:
   `env VAR=wert befehl` (das externe Programm) oder vorher `set -gx VAR wert`.
2. **Der Setup-Guard hilft dir aktiv**: `sh scripts/setup-cachyos.sh …` bricht mit Exit 2 und
   der korrekten Anweisung ab, statt mitten im Skript an `[[ … ]]` zu zerplatzen.
3. **Ein leeres `$DATABASE_URL` ist ein Konfigurationsfehler, kein DB-Defekt.** Prüfe zuerst
   `echo "$DATABASE_URL"` (bash) bzw. `echo $DATABASE_URL` (fish) — und lade dann Schritt 2 c).

## 3. Schritt 1 — ALLES stoppen (sonst löscht du im fahrenden Auto)

Ein laufender Server schreibt permanent in die DB (Zyklen, Audit-Log, Equity-Snapshots).
Ein laufender `market-sync.timer` schreibt `data/` wieder voll, während du löschst.

```bash
# Manuell gestartete Next.js-Server (dev + start) sauber beenden (SIGTERM, wartet bis 30 s)
npm run stop
# Mit anderem Port: PORT=3100 npm run stop

# Falls als systemd-Dienst installiert
sudo systemctl stop ai-trading-firm
sudo systemctl stop micro-executor

# Automatische Sync-Jobs kurz abschalten (sonst sind data/ und die Registry gleich wieder voll)
sudo systemctl stop  market-sync.timer market-sync-full.timer 2>/dev/null || true
systemctl list-timers --all | grep -i market-sync || echo "keine market-sync-Timer aktiv ✔"
```

**Kontrolle — es darf nichts mehr auf dem Port horchen:**

```bash
ss -ltnp '( sport = :3369 )' || echo "Port 3369 frei ✔"
```

> **Warum `npm run stop` und kein `kill -9`:** `scripts/stop.sh` macht genau das, was die
> systemd-Unit auch macht (SIGTERM, 30 s Geduld, erst danach SIGKILL), damit offene
> DB-Transaktionen sauber abschließen. Das schützt vor halb geschriebenen Zeilen.

---

## 4. Schritt 2 — Sicherung anlegen (optional, aber sehr klug)

```bash
# 0) Ordner + Umgebungsvariable VOR dem Dump prüfen — sonst verpufft der Befehl
mkdir -p ~/backups
[ -n "$DATABASE_URL" ] || echo "⚠ DATABASE_URL ist leer -> erst Schritt 2c ausführen, sonst sichert pg_dump die falsche (oder keine) DB"
echo "ziele auf: $DATABASE_URL"          # muss user:pass@host/db enthalten, nicht nur „/run/postgresql“

# 1) Backup in zwei Formen: SQL-Text (für psql) + benutzerdefiniertes Format (für pg_restore)
STAMP=$(date +%F-%H%M)
pg_dump -Fc "$DATABASE_URL" -f ~/backups/firm-$STAMP.dump     # komprimiert, selektive Wiederherstellung
pg_dump  "$DATABASE_URL"     > ~/backups/firm-$STAMP.sql      # Menschen-lesbar, in jede DB spielbar
ls -lh ~/backups/firm-$STAMP.*      # beide Dateien müssen > 0 Byte zeigen
```

> **Warum `-f` und kein `| gzip > datei.gz`:** die Shell öffnet das Datei-Ziel **bevor**
> `pg_dump` läuft. Existiert das Verzeichnis nicht, ist die Fehlermeldung
> `warning: An error occurred while redirecting file '/home/du/backups/' … Ist ein Verzeichnis`
> und es wird **gar nicht** gesichert — mit `-f` und vorangestelltem `mkdir -p` kann das nicht
> passieren. `-Fc` komprimiert außerdem selbst (Standard: 6) und erlaubt Einzeltabellen-Restore.

**Einzeln zurückholen** (z. B. nur die Regeln, wenn du das Reset bereust):

```bash
pg_restore -d "$DATABASE_URL" --table=trade_rules --clean --if-exists ~/backups/firm-<STAMP>.dump

# Ganze Datenbank in eine LEERE Schema-DB zurückspielen
psql "$DATABASE_URL" -f ~/backups/firm-<STAMP>.sql      # oder: pg_restore -d "$DATABASE_URL" --clean ~/backups/firm-<STAMP>.dump
```

Auch die Universum-Datei kurz wegschreiben schadet nicht (siehe Schritt 4):

```bash
cp data/universe/instruments.ndjson ~/backups/instruments-vor-reset.ndjson 2>/dev/null || true
```

---

## 5. Schritt 3 — Datenbank leeren

### Variante A (Standard): Tabellen leeren, Struktur behalten

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
TRUNCATE
  agents, missions, positions, proposals, order_intents,
  trade_rules, rule_executions, rule_backtests,
  agent_messages, audit_log, equity_snapshots, kill_switches,
  risk_config, broker_credentials, venue_control_state
RESTART IDENTITY CASCADE;"
```

Was die drei Schlüsselwörter bedeuten:

* `RESTART IDENTITY` — Zähler/Sequenzen wieder bei 0.
* `CASCADE` — Foreign-Key-Ketten (`proposals → missions`, `positions → trade_rules`, …) blockieren sonst mit `must truncate other tables too`.
* `-v ON_ERROR_STOP=1` — bricht beim ersten Fehler ab statt still weiterzumachen.

**Kontrolle — überall muss 0 stehen:**

```bash
psql "$DATABASE_URL" -tAc "
SELECT 'agents',count(*) FROM agents
UNION ALL SELECT 'missions',count(*) FROM missions
UNION ALL SELECT 'positions',count(*) FROM positions
UNION ALL SELECT 'proposals',count(*) FROM proposals
UNION ALL SELECT 'audit_log',count(*) FROM audit_log;"
```

> **Sonderfall `risk_config`:** die Zeile `allowShort` (Short-Selling an/aus) wird beim
> nächsten Seeding neu gesetzt. Willst du deine eigenen Risiko-Werte behalten, lass die
> Tabelle einfach weg (`TRUNCATE` ohne `risk_config`).

### Variante B: Datenbank komplett neu anlegen

Nur wenn Variante A nicht hilft (Schema-Müll, fehlende Tabellen, Encoding-Fehler).
Dabei geht **alles** in dieser DB verloren — Sicherung aus Schritt 2 nicht vergessen.

```bash
# Name und Besitzer aus der DATABASE_URL ziehen (kein Raten)
DB_NAME="${DATABASE_URL##*/}"; DB_NAME="${DB_NAME%%\?*}"
DB_USER="$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-z]+://([^:@/]+).*#\1#')"
echo "DB-Name: $DB_NAME · DB-Benutzer: $DB_USER"

# Admin-URL = dieselbe URL, aber mit der postgres-DB statt der Firm-DB
ADMIN_URL="${DATABASE_URL%/*}/postgres"

# 1) Verbindungen kappen (sonst: "is being accessed by other users")
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB_NAME';"

# 2) Neu anlegen
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE);"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\";"

# 3) Schema von Grund auf
npx drizzle-kit push --force
```

> **Nach Variante B gilt immer:** der Schema-Push (Schritt 5) und alle Seeds (Schritte 6
> und 9) sind Pflicht — die Datenbank ist ja leer wie am ersten Tag.

---

## 6. Schritt 4 — Laufzeit-Dateien unter `data/` löschen

Nicht alles lebt in der Datenbank. Diese Dateien sind bewusst **nicht** versioniert und
machen die „neue Firma“ sonst halb alt:

| Pfad | Inhalt | Löschen? |
| --- | --- | --- |
| `data/history/` | Append-only OHLCV-Kerzen (Historie) | ✅ ja |
| `data/spread-cache.json` | Orderbuch-Spreads, TTL 6 h | ✅ ja |
| `data/market-data-errors.json` | Fehler-Manifest des Sync-Jobs | ✅ ja |
| `data/market-sync-status.json` | Sync-Status je Venue | ✅ ja |
| `data/audit-spool/` | Fallback-Audit, wenn DB nicht schreibbar war | ✅ ja |
| `data/routing/` | Model-Router: Modi + Routing-Audit | ✅ ja (sonst bleibt altes Routing aktiv) |
| `data/live-gate/` | Live-Gate-State, Hash-Kette, Kill-Failsafe | ✅ ja |
| `data/setup/` | Setup-Protokolle (Logs) | ⬜ egal |
| `artifacts/` | Scanner-Snapshots, Portfolio-Audit | ✅ ja |
| `data/universe/instruments.ndjson` | **Instrument-Registry — versioniert in Git** | ⚠️ nur mit `git checkout` zurückholen |
| `data/secrets/` | verschlüsselte Broker-Credential-Hüllen | 🔶 nur löschen, wenn du die Keys wirklich loswerden willst |

> **Nie mit Auslassungspunkten arbeiten.** `rm -rf data/history data/routing …` löscht
> im Zweifel das Zeichenfolge-Zeichen `…` als Pfadnamen (fish bricht so eine Zeile sogar
> komplett ab, weil das Globbing nicht aufgeht) — und genau die Verzeichnisse bleiben stehen,
> die du leeren wolltest. Alle Pfade immer vollständig ausschreiben, dann mit `ls` gegenzählen.

```bash
rm -rf data/history data/market-data-errors.json data/spread-cache.json \
       data/market-sync-status.json data/audit-spool data/routing \
       data/live-gate data/live-gate-test artifacts

# Registry: entweder behalten (Datei bleibt, wie sie ist) …
ls -l data/universe/

# … oder wirklich auf Null, dann aber deterministisch zurückholen:
rm -f data/universe/instruments.ndjson data/universe/*.tmp
npm run universe:seed            # 26 Basis-Instrumente
npm run universe:seed:markets    # + 354 Preset-Instrumente (50 Aktien · 50 Indizes · 22 Rohstoffe · 30 Krypto)
```

> **Gut zu wissen:** fehlt die Registry-Datei, seedet die App beim ersten Zugriff automatisch
> das Basis-Universum (`src/universe/index.ts`). Das Preset-Universum (354) kommt dadurch
> **nicht** — deshalb Schritt 8 nicht auslassen, sonst bleiben die Checks V08–V11 rot und die
> Missionen melden `MISSION_SCOPE_EMPTY`.

`data/secrets/`: die Broker-API-Keys (z. B. Bitunix) liegen verschlüsselt als Hülle in diesem
Ordner **und** referenziert in der Tabelle `broker_credentials`. Beides ist nach dem Reset weg — du musst die
Credentials im Dashboard (Control Plane) neu eintragen. Das ist gewollt so.

---

## 7. Schritt 5 — Schema neu einspielen

```bash
# .env vorhanden? Sonst: cp .env.example .env und DATABASE_URL + Tokens setzen
test -f .env || { echo "KEINE .env!"; cp .env.example .env; }

npx drizzle-kit push --force
```

Erwartete Ausgabe: `[✓] Changes applied`.

`drizzle.config.ts` liest die URL aus der `.env` — deshalb gibt es hier keine hartkodierte
Verbindung und kein „push auf die falsche DB“.

**Kontrolle — mindestens 14 Tabellen, darunter die kritischen:**

```bash
psql "$DATABASE_URL" -c "\dt"
psql "$DATABASE_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
```

Erwartet: **≥ 14** (15 Tabellen in `src/db/schema.ts`). Fehlen Tabellen, ist fast immer
eine veraltete `drizzle.config.json` im Weg:

```bash
ls drizzle.config.*        # nur .ts erlaubt → .json löschen
rm -f drizzle.config.json && npx drizzle-kit push --force
```

> Die vier `.sql`-Dateien in `drizzle/` sind der **alternative** Pfad für Umgebungen ohne
> `drizzle-kit` (`psql "$DATABASE_URL" -f drizzle/…sql`). Nach einem `push --force` sind sie
> überflüssig — sie sind idempotent, ein doppeltes Ausführen schadet also nicht, bringt aber nichts.

---

## 8. Schritt 6 — Seeden (Team, Missionen, Risiko, Universum)

Reihenfolge egal, alle drei sind idempotent:

```bash
npm run universe:seed:markets     # 354 Preset-Instrumente (Registry)
npm run universe:seed             # 26 Basis-Instrumente
```

Team + Missionen + `risk_config` **nicht** per Skript, sondern über den API-Endpunkt — und
zwar erst nach dem Start (Schritt 11). Warum: `ensureSeeded()` liest die Modellnamen aus der
Laufzeitumgebung des Servers (`MODEL_CEO`, `MODEL_RESEARCH`, …), nicht aus deinem Terminal.

> **Marktdaten-Warmup** (braucht Netzwerk, dauert je Universumgröße):
>
> ```bash
> npm run market:sync -- --dry-run     # erst schauen, was passieren würde
> npm run market:sync                   # Registry + data/history/ persistent füllen
> npm run market:sync:status            # Kontrolle: „Scanner bereit: ja“
> ```
>
> Ohne Warmup ist der Scanner-Funnel leer (`Kerzen fehlen`) — die Firma läuft trotzdem,
> findet aber nichts.

---

## 9. Schritt 7 — Komplett neu bauen

Der Cache-Löschschritt ist **kein Aberglaube**: Next.js kompiliert Module pro Build neu,
und alte Artefakte lassen `instanceof`-Checks fehlschlagen (deshalb auch in
`docs/INSTALL.md` Kapitel 12 als Pflicht vor jedem Update).

```bash
rm -rf .next node_modules/.cache
npm ci                      # installiert exakt aus package-lock.json (npm install ist hier falsch!)
npm run typecheck           # TypeScript-Fehler, bevor der Build sie versteckt
npm run lint                # optional
npm run build               # = next build
```

**Kontrolle:** `npm run build` endet ohne rotes `Failed to compile`. Warnungen der Art
„Dynamic filesystem access“ sind seit `src/lib/appPaths.ts` behoben — tauchen sie wieder auf,
ist das ein echter Befund (siehe `docs/SETUP_BUGS.md` B4).

> `npm ci` statt `npm install`: `ws` ist auf 8.21.3 gepinnt (SEC-04), `next` auf 16.3.4
> (SEC-03). `npm install` kann über Semver-Ranges daneben greifen. Danach gilt:
> `npm ls ws --all` muss genau `8.21.3` zeigen.
>
> Nur wenn du wirklich auf frische Abhängigkeiten willst: `npm outdated` → Absprache →
> Lockfile aktualisieren und **neu committen**, nicht nur lokal installieren.

---

## 10. Schritt 8 — Starten

### Variante „nur testen“ (Dev-Modus, ohne Build)

```bash
npm run dev            # http://localhost:3369, AUTH_MODE-Default: local-open
```

### Variante „so wie später auch“ (Produktion, empfohlen fürs Reset-Ritual)

```bash
npm run start &        # NODE_ENV=production, bindet 0.0.0.0:3369
# oder als Dienst:
sudo systemctl start ai-trading-firm
sudo systemctl start micro-executor 2>/dev/null || true
sudo systemctl start market-sync.timer 2>/dev/null || true   # Timer wieder an!
```

> **Der Boot-Guard ist eine Funktion, kein Bug.** `npm run start` ohne jedes Token startet
> **nicht** (`AUTH_NOT_CONFIGURED`). In `.env` müssen dann stehen:
>
> ```bash
> grep -E '^(FIRM_API_TOKEN|FIRM_SESSION_SECRET|AUTH_MODE)=' .env
> # fehlen sie:
> printf 'FIRM_API_TOKEN=%s\n'      "$(openssl rand -hex 32)" >> .env
> printf 'FIRM_SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
> chmod 600 .env
> ```
>
> `AUTH_MODE=local-open` ist der bewusste Opt-in für Single-User ohne Token — in Produktion
> nur mit Absicht eintragen. Der Reset ersetzt **keinen** vorhandenen `FIRM_SESSION_SECRET`
> durch einen API-Token (SEC-01: beide müssen unabhängig sein, ≥ 32 Zufallszeichen).

---

## 11. Schritt 9 — Team + Missionen anlegen

```bash
TOKEN="$(grep -m1 '^FIRM_API_TOKEN=' .env | cut -d= -f2-)"

curl -s http://localhost:3369/api/health | jq '{schemaReady, version}'
curl -s -X POST http://localhost:3369/api/seed -H "x-firm-token: $TOKEN" | jq
```

Erwartet: `{"ok": true, "seeded": true, ...}`.

> **Not-Halt verstehen:** der Zustand des Kill-Switches liegt in der DB-Tabelle
> `kill_switches` (letzte Zeile = wirksam) und wird beim Start rehydriert; die
> In-Memory-Kopie entscheidet im Prozess. Da du die Tabelle geleert hast, legt
> `ensureSeeded()` eine Zeile `armed = false` an → **kein Not-Halt**, die Firma
> dürfte sofort handeln. Wer den gestrigen Alarm-Zustand behalten wollte, lässt
> `kill_switches` beim TRUNCATE einfach weg.

Genauso geht es im Browser: `http://localhost:3369` → mit dem Token aus `.env` anmelden →
Button **„Seed / Reset“**.

**Kontrolle:**

```bash
curl -s http://localhost:3369/api/firm -H "x-firm-token: $TOKEN" | jq '{
  agenten: (.agents | length),
  missionen: (.missions | length),
  broker: .account.broker,
  equity: .account.equity,
  notHalt: .killSwitchArmed,
  llm: .ollama.provider, verfuegbar: .ollama.available
}'
```

Erwartet: 12 Agenten, ≥ 1 Mission, `broker: "PAPER"`, `equity` = dein `STARTING_EQUITY`
(`.env.example`: 10000), `notHalt: false`.

Wer den Not-Halt als Sicherheitspuffer **bewusst scharf** schalten will (dann blockiert jede
Order, bis du disarmst):

```bash
curl -s -X POST http://localhost:3369/api/firm/kill -H "x-firm-token: $TOKEN" | jq
```

---

## 12. Schritt 10 — Abnahme (das ist der „Fertig“-Beweis)

```bash
./scripts/validate-setup.sh                    # 18 Checks, bestanden ab 15
./scripts/validate-setup.sh --min-pass 18       # harte Messlatte
BASE_URL=http://192.168.1.42:3369 ./scripts/validate-setup.sh   # gegen eine ferne Instanz
```

Grün nach sauberem Reset bedeutet konkret:

* `V02 schemaReady` ✔ · `V05` 12 Rollen ✔ · `V06/V07` Mission mit gültiger UUID ✔
* `V08–V11` Universum (≥ 50 Aktien, ≥ 50 Indizes, ≥ 20 Rohstoffe, ≥ 30 Krypto) ✔
* `V12 broker = PAPER` ✔ · `V13 maxLeverage = 1` ✔ · `V14 Stop-Loss Pflicht` ✔
* `V18 401 ohne Token` ✔ (rot nur, wenn du bewusst `AUTH_MODE=local-open` gesetzt hast)

Der ausführliche Funktionstest (fährt eine komplette Pipeline und zieht am Ende den Not-Halt,
bis zu 900 s):

```bash
./scripts/smoke-test.sh
```

Und die letzten Handgriffe, die man gern vergisst:

```bash
sudo systemctl start market-sync.timer        # Timer wieder AN (sonst altern die Daten)
crontab -l | grep pg_dump || echo "kein Backup-Cron — siehe docs/INSTALL.md Kap. 12"
```

---

## 13. Wenn etwas hakt

| Meldung | Ursache | Lösung |
| --- | --- | --- |
| `database "firma" is being accessed by other users` | Server/Systemd/Timer hält Verbindungen | Schritt 1 wiederholen: `sudo systemctl stop ai-trading-firm` und `psql "$DATABASE_URL" -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database();"` , dann `DROP DATABASE … WITH (FORCE);` |
| `permission denied for database` / `must be owner` | `.env`-User besitzt die DB nicht | DB/Rolle mit dem Setup-Skript anlegen (`docs/INSTALL.md` 3.2), nicht per Hand |
| `must truncate other tables too` | Foreign Keys | `CASCADE` fehlt in deinem `TRUNCATE` |
| `relation "positions" does not exist` | `push` lief auf falsche/keine DB | `.env` prüfen, `rm -f drizzle.config.json`, `npx drizzle-kit push --force` |
| `password authentication failed` | Passwort in `.env` ≠ DB-Passwort | `sudo -u postgres psql -c "\password <user>"` und `.env` nachziehen |
| `FATAL: role "<dein Login>" does not exist` | `$DATABASE_URL` war leer ⇒ libpq nutzt Socket + OS-Benutzer | Schritt 2 c) im **selben** Terminal ausführen, dann `echo "$DATABASE_URL"` kontrollieren |
| `warning: An error occurred while redirecting file '…/backups/': open: Ist ein Verzeichnis` | Zielordner existiert nicht; die Shell öffnet das Ziel vor dem Befehl | `mkdir -p ~/backups` zuerst, und `-f datei` statt `\| gzip > datei` verwenden |
| `set: # …: invalid variable name` / `fish: Unsupported use of '='` | bash-Idiome (`. ./.env`, `VAR=x cmd`) in fish | Loader benutzen: `scripts/env-run.sh --fish \| source` bzw. `node scripts/load-env.mjs --fish \| source` (Abschnitt 2.5) |
| `Abbruch in Schritt „Konfiguration (.env)" (Zeile …, Exit 1)` ohne weitere Meldung | Befund SET-09: Schritt-Funktion endete mit einem Test, `set -Ee` deutete das als Fehlschritt | ab v1.39.1 behoben (Diagnose + `return 0`); auf älterem Stand ab `docs/INSTALL.md` 5.2 von Hand weiter — es wurde nichts halbfertig geschrieben |
| Setup meldet `N Schlüssel aus der Sicherungskopie zurückgeholt` | `--force-env` hat die .env ersetzt (Merge ist der Default, Ersetzen die Ausnahme) | `.env.bak-<Zeitstempel>` im Projektstamm ansehen; fehlende Zeilen zurückkopieren |
| `env-run.sh:9: zeile ohne = uebersprungen` | .env von Hand editiert (Zeile ohne `=`) | Zeilennummer prüfen; `scripts/env-run.sh --check` (Exit 1 = Befund) |
| Dienst startet nicht: `AUTH_NOT_CONFIGURED` | Produktion ohne Credential | Token in `.env` (Schritt 8), Dienst neu starten |
| `SESSION_SECRET_REQUIRED` / `_INVALID` | Session-Key fehlt oder wurde mit API-Token verwechselt | separat `openssl rand -hex 32` in `.env`, alle Instanzen neu starten, neu anmelden |
| `EADDRINUSE 0.0.0.0:3369` | Restprozess vom Stop | `sudo ss -ltnp 'sport = :3369'` → `sudo kill <PID>`, oder `PORT=3100 npm run start` |
| Pipeline bricht mit `invalid input syntax for type uuid: "null"` | keine Mission | `POST /api/seed` (Schritt 11) |
| V08–V11 rot | Preset-Universum fehlt | `npm run universe:seed:markets` |
| Scanner-Funnel leer, obwohl Universum groß | Warmup fehlt | `npm run market:sync`, dann `npm run scan -- --sync-first` |
| „Sitzung abgelaufen“ im Dashboard | Reset/Neustart entwertet alle Sessions (normal!) | neu anmelden; Details `docs/HOWTO_LAN_SESSION.md` |

Dokumentierte Befunde: `docs/SETUP_BUGS.md` (B1–B8, C1/C2, SET-09, SET-10),
`docs/SETUP_PG_TROUBLESHOOTING.md`, `docs/INSTALL.md` Kapitel 11.

---

## 14. Windows / PowerShell (Kurzpfad)

```powershell
cd $HOME\ai-trading-firm
npm run stop                       # wenn vorhanden; sonst Task-Manager / Ctrl+C im Server-Fenster
$env:PGPASSWORD = "<db-passwort>"
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -c "TRUNCATE agents, missions, positions, proposals, order_intents, trade_rules, rule_executions, rule_backtests, agent_messages, audit_log, equity_snapshots, kill_switches, risk_config, broker_credentials, venue_control_state RESTART IDENTITY CASCADE;"
Remove-Item -Recurse -Force .next, node_modules\.cache, data\history, data\audit-spool, data\routing, data\live-gate, artifacts -ErrorAction SilentlyContinue
npm ci
npx drizzle-kit push --force
npm run universe:seed:markets ; npm run universe:seed
npm run build
npm run start
```

Das PowerShell-Setup-Skript `scripts/setup-windows.ps1` macht dasselbe inkl. Validierung
(Ablauf: `docs/INSTALL-WINDOWS.md`).

---

## 15. Einmaleins der Sicherheit beim Reset

* **Nie** `DROP SCHEMA public CASCADE` auf einer DB, die nicht aus deiner `.env` kommt.
* **Nie** `rm -rf /var/lib/postgres*` — dafür existiert `--reset-cluster` mit Rückfrage.
* **Nie** `.env` löschen und aus `.env.example` neu bauen, wenn du deinen bestehenden
  `FIRM_SESSION_SECRET` behalten willst: Rotation meldet sich sonst als „Sitzung abgelaufen“
  in jedem Browser.
* Die Risikogrenzen (`maxLeverage = 1`, Stop-Loss-Pflicht, Positionsgrößen-Ceiling) stehen im
  **Code** (`src/lib/riskGuard.ts`), nicht in der DB — ein Reset macht sie *nicht* los.
  `risk_config` ist nur beschreibend.
* Das Projekt ist Paper-Trading. Es gibt keinen Live-Broker-Pfad — aber genau deshalb ist
  `data/secrets` + `broker_credentials` der einzige Ort, an dem echte Keys liegen.
