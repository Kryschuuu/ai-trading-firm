# How-to: Laufende Firma nach `git pull` aktualisieren

**Stand:** v1.39.1 · **Zielgruppe:** Betreiber einer laufenden Instanz (Paper oder Live)
· **Dauer:** 3–10 Minuten (der Build ist der längste Teil)

Dieses Runbook beantwortet eine einzige Frage: *Ich habe lokal `git pull` gemacht —
wie bringe ich meine **laufende** Firma sauber auf den neuen Stand, ohne
Warmup, Daten oder Positionen zu verlieren?*

Die Kurzfassung steht auch in [`INSTALL.md`](INSTALL.md) Kapitel 12. Hier steht das
**Warum**, die richtige **Reihenfolge** und was du **prüfst**, bevor du wieder weggehst.

---

## 0. Grundsatz: Erst stoppen, dann ziehen, dann bauen, dann starten

Ein `git pull` in ein laufendes Projekt ist für sich harmlos — Node hat den alten
Code längst geladen. Gefährlich wird es beim **Mischstand**, der entsteht, wenn du
`npm ci`, `drizzle-kit push` oder `npm run build` fährst, während Prozesse laufen:

| Risiko | Was passiert |
|---|---|
| **Version-Mix** | Server läuft mit altem Code, `.next/` wird gleichzeitig neu geschrieben → Chunks passen nicht zusammen, `ChunkLoadError`/500 im Dashboard |
| **Halbe Installation** | `npm ci` löscht `node_modules/` komplett und baut neu — ein Timer-Lauf (`market-sync`) in dieser Minute stirbt mit `Cannot find module` |
| **Schema-Drift** | `drizzle-kit push` ändert Tabellen, während der alte Server noch Queries mit altem Spaltensatz stellt |
| **Doppelläufe** | Micro-Executor alt + neu gleichzeitig → doppelte Orders im Paper-Book (Live: der Kill-Switch würde greifen, aber soweit soll es nicht kommen) |

Deshalb: **alle Prozesse stoppen**, bevor irgendetwas außer `git pull` selbst passiert.

Was **nicht** angefasst wird und jedes Update überlebt:

* `.env` — ist git-ignoriert, `git pull` rührt sie nie an
* `data/` — Historical Store, Spread-Cache, Sync-Status, Secret-Envelopes, Live-Gate-Zustand (alles git-ignoriert, siehe `.gitignore`)
* die PostgreSQL-Datenbank — Positionen, Entscheidungen, Audit-Log

Einzige versionierte Datei unter `data/`: `data/universe/instruments.ndjson`
(Registry). Siehe [Sonderfall B](#b-git-pull-meldet-konflikt-in-datauniverseinstrumentsndjson).

---

## 1. Kurzversion (zum Kopieren)

### Linux / systemd (Standardbetrieb nach INSTALL.md Kapitel 7)

```bash
cd ~/ai-trading-firm

# 0) Sicherung
pg_dump "$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" | gzip > ~/backups/firm-pre-update-$(date +%F_%H%M).sql.gz

# 1) Stoppen — Timer zuerst, dann Executor, dann Server
sudo systemctl stop market-sync-full.timer market-sync.timer 2>/dev/null
sudo systemctl stop market-sync-full.service market-sync.service 2>/dev/null
sudo systemctl stop micro-executor 2>/dev/null
sudo systemctl stop ai-trading-firm

# 2) Code holen
git status --short            # muss leer sein (außer data/universe/instruments.ndjson, s. Sonderfall B)
git pull --ff-only

# 3) Abhängigkeiten exakt nach Lockfile
rm -rf .next node_modules/.cache
npm ci

# 4) .env abgleichen (neue Pflicht-Flags?) — siehe Abschnitt 5
git diff HEAD@{1} HEAD --stat -- .env.example CONFIGURATION.md CHANGELOG.md

# 5) Schema — nur wenn sich src/db/schema.ts oder drizzle/ geändert hat
git diff HEAD@{1} HEAD --stat -- src/db/schema.ts drizzle/ && npx drizzle-kit push

# 6) Bauen
npm run build

# 7) Starten — Server zuerst, dann Executor, dann Timer
sudo systemctl start ai-trading-firm
sudo systemctl start micro-executor 2>/dev/null
sudo systemctl start market-sync.timer market-sync-full.timer 2>/dev/null

# 8) Prüfen
curl -s localhost:3369/api/health | jq '{version, schemaReady, missingTables}'
npm run market:sync:status
```

### Linux ohne systemd (manueller Start via `npm run start`)

```bash
cd ~/ai-trading-firm
npm run stop                  # SIGTERM → 30 s → SIGKILL (scripts/stop.sh)
# Micro-Executor und market-sync-Loops (falls in tmux/screen) von Hand beenden
git pull --ff-only
rm -rf .next node_modules/.cache
npm ci
# ggf.: npx drizzle-kit push
npm run build
npm run start                 # bzw. in tmux/screen wieder hochziehen
npm run micro                 # falls genutzt
```

### Windows / PowerShell

```powershell
cd $HOME\ai-trading-firm
# Server-Fenster: Strg+C; Micro-Executor-Fenster: Strg+C; geplante Aufgaben für market:sync deaktivieren
git pull --ff-only
Remove-Item -Recurse -Force .next, node_modules\.cache -ErrorAction SilentlyContinue
npm ci
# ggf.: npx drizzle-kit push
npm run build
npm run start
```

Die Windows-Besonderheiten (Node-Version, Proxy, PowerShell-Umgebungsvariablen)
stehen in [`INSTALL-WINDOWS.md`](INSTALL-WINDOWS.md).

---

## 2. Schritt 0 — Sicherung

Immer, auch bei Patch-Releases. Es kostet Sekunden und ist die einzige
Rückfahrkarte, falls eine Schema-Migration schiefgeht:

```bash
mkdir -p ~/backups
pg_dump "$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" \
  | gzip > ~/backups/firm-pre-update-$(date +%F_%H%M).sql.gz
ls -lh ~/backups | tail -1
```

Zusätzlich empfehlenswert, wenn du am Historical Store hängst (Warmup dauert
Stunden): `tar czf ~/backups/data-$(date +%F).tgz data/`. Nötig ist es nicht —
`data/` bleibt beim Update unangetastet — aber es macht den Rollback vollständig.

---

## 3. Schritt 1 — Stoppen, in dieser Reihenfolge

1. **Timer** (`market-sync.timer`, `market-sync-full.timer`) — damit während
   des Updates kein Sync anspringt. Timer stoppen beendet **nicht** einen gerade
   laufenden Service, deshalb danach auch die `.service`-Units stoppen.
2. **Micro-Executor** — er hält offene Order-Intents; SIGTERM lässt ihn den
   aktuellen Tick beenden.
3. **Server** (`ai-trading-firm`) — zuletzt, damit der Executor beim Beenden
   noch die API erreichen kann.

Kontrolle, dass wirklich nichts mehr läuft:

```bash
systemctl is-active ai-trading-firm micro-executor market-sync.service market-sync-full.service
# erwartet: 4× inactive
ss -ltnp | grep -E ':3369\b'      # erwartet: leer
pgrep -af 'next-server|micro-executor|market-sync' # erwartet: leer
```

Bleibt Port 3369 belegt, obwohl die Unit `inactive` ist, war es ein manuell
gestarteter Server: `npm run stop` (siehe [HOWTO_LAN_SESSION.md](HOWTO_LAN_SESSION.md), Bug 1).

> **Live-Betrieb:** Das Stoppen des Servers ist **kein** Kill-Switch. Offene
> Positionen bei der Venue bleiben offen. Wer für die Update-Minuten flach sein
> will, löst vorher `POST /api/firm/kill` aus bzw. `npm run live:kill`
> ([LIVE_TRADING.md](LIVE_TRADING.md)).

---

## 4. Schritt 2 — `git pull --ff-only`

```bash
git status --short
git pull --ff-only
git log --oneline HEAD@{1}..HEAD    # was ist neu?
```

`--ff-only` statt nacktem `git pull`: Wenn du lokal etwas geändert oder
committet hast, bricht der Befehl ab, statt einen Merge-Commit in deine
Betriebsinstanz zu schreiben. Dann weißt du, dass etwas zu klären ist
(Sonderfall B/C), bevor irgendetwas gebaut wird.

Nach dem Pull einmal `CHANGELOG.md` für die übersprungenen Versionen lesen —
dort stehen Pflicht-Schritte (neue Env-Variable, Migrationen, Seeds), die dieses
generische Runbook nicht kennen kann.

---

## 5. Schritt 3 — `npm ci` (nicht `npm install`)

```bash
rm -rf .next node_modules/.cache
npm ci
```

* **`npm ci`** installiert exakt das `package-lock.json` des neuen Standes und
  löscht `node_modules/` vorher. `npm install` würde das Lockfile ggf. verändern
  und dir beim nächsten Pull einen Konflikt bescheren.
* **Build-Cache löschen** ist Pflicht (INSTALL.md Kapitel 12): Reste in `.next/`
  und `node_modules/.cache` führen zu `instanceof`-Drift zwischen alten und neuen
  Modulkopien — Symptom sind Adapter-Checks, die grundlos fehlschlagen.
* Node muss weiterhin **>= 20** sein (`node --version`); ein Node-Update ist
  kein Teil dieses Runbooks, steht aber ggf. im CHANGELOG.

---

## 6. Schritt 4 — `.env` abgleichen

`.env` wird nie überschrieben — dafür bekommt sie **neue Flags auch nicht
automatisch**. Vergleiche:

```bash
git diff HEAD@{1} HEAD -- .env.example CONFIGURATION.md
```

Faustregeln:

* Neue Flags haben sichere Defaults ([CONFIGURATION.md](../CONFIGURATION.md)) —
  du musst sie nur eintragen, wenn du vom Default abweichen willst.
* Ausnahme sind **Pflicht-Werte**, die der Boot-Guard prüft
  (`scripts/auth-boot-guard.ts`): Fehlt z. B. `FIRM_API_TOKEN` in Produktion,
  verweigert der Server den Start mit `AUTH_NOT_CONFIGURED`. Das siehst du sofort
  in `journalctl -u ai-trading-firm`.
* Einen Token oder das Session-Secret zu **rotieren** entwertet alle
  Browser-Sitzungen — nach dem Start also einmal neu anmelden (kein Fehler).

---

## 7. Schritt 5 — Schema: `drizzle-kit push` nur bei Bedarf

```bash
git diff HEAD@{1} HEAD --stat -- src/db/schema.ts drizzle/
```

* **Leere Ausgabe** → nichts zu tun, Schritt überspringen.
* **Änderungen** → `npx drizzle-kit push` (Datenbank läuft, Server ist gestoppt).
  Der Befehl ist additiv und idempotent; Spalten-Umbenennungen fragt er
  interaktiv nach — im Zweifel `CHANGELOG.md` zur Version lesen.
* Liegt unter `drizzle/` eine neue `*.sql`-Datei mit Handanweisung im Kopf,
  gilt diese (Beispiel: `2026-09-08_positions_open_idx.sql`).

Falls du unsicher bist, ob du ihn brauchst: Nach dem Start meldet
`/api/health` bei fehlenden Tabellen `schemaReady: false` plus `missingTables`
— dann Server stoppen, `push`, Server starten. Es geht nichts kaputt, die Firma
startet nur nicht in den Zyklus.

Datenmigrationen jenseits des Schemas (z. B. `npm run history:migrate`,
`npm run symbols:normalize`) sind **nie** Teil eines normalen Updates; sie
stehen mit eigenem Runbook im CHANGELOG, wenn sie fällig sind.

---

## 8. Schritt 6 — Build

```bash
npm run build
```

Der Build muss **fehlerfrei** durchlaufen, bevor du startest. Ein `next start`
auf halbem `.next/` liefert 500er im ganzen Dashboard. Warnungen (z. B. zu
Edge-Runtime oder Bildoptimierung) sind bekannt und harmlos
([SETUP_BUGS.md](SETUP_BUGS.md)).

Optional, wenn du Zeit hast — dieselben Gates wie die CI:

```bash
npm run typecheck && npm run lint && npm run docs:validate
```

---

## 9. Schritt 7 — Starten, umgekehrte Reihenfolge

```bash
sudo systemctl start ai-trading-firm
sleep 5 && curl -sf localhost:3369/api/health >/dev/null && echo "Server ok"
sudo systemctl start micro-executor
sudo systemctl start market-sync.timer market-sync-full.timer
```

Server zuerst und kurz warten — der Executor und ein sofort feuernder Timer
(`Persistent=true` holt einen verpassten Lauf nach) brauchen die API bzw. die
Sperrdatei des Servers.

Hast du Unit-Dateien unter `deploy/` verändert bekommen (`git diff HEAD@{1} HEAD -- deploy/`),
dann vor dem Start neu einspielen: `sudo cp deploy/<unit> /etc/systemd/system/ && sudo systemctl daemon-reload`
— Pfade und User wie in INSTALL.md Kapitel 7 anpassen.

---

## 10. Schritt 8 — Verifikation (Checkliste)

- [ ] `curl -s localhost:3369/api/health | jq` → HTTP 200, `schemaReady: true`, `version` = neue Version aus `package.json`
- [ ] `journalctl -u ai-trading-firm -n 50 --no-pager` → kein `AUTH_NOT_CONFIGURED`, kein `EADDRINUSE`, kein Stacktrace
- [ ] `systemctl list-timers market-sync*` → beide Timer haben ein `NEXT`
- [ ] `npm run market:sync:status` → letzter Lauf ohne Fehler, Bestand unverändert (Warmup ist noch da)
- [ ] Dashboard im Browser laden → ggf. einmal **Anmelden** (Sitzungen sind nach Neustart weg — erwartet, siehe [HOWTO_LAN_SESSION.md](HOWTO_LAN_SESSION.md) Bug 2)
- [ ] Operations Center → Market Data → Funnel nicht leer; falls doch: [OPERATIONS.md](OPERATIONS.md)
- [ ] Paper-Positionen und Equity stimmen mit dem Stand vor dem Update überein
- [ ] Live-Betrieb: Live-Gate-Zustand prüfen ([LIVE_TRADING.md](LIVE_TRADING.md)); falls vorher Kill-Switch ausgelöst: bewusst wieder freigeben

---

## 11. Sonderfälle

### A) Patch-Update ohne Schema- und Env-Änderung (Normalfall, z. B. 1.39.0 → 1.39.1)

Stop → `git pull --ff-only` → Cache löschen → `npm ci` → `npm run build` → Start.
Kein `drizzle-kit push`, kein `.env`-Eingriff. Dauer: Build-Zeit.

### B) `git pull` meldet Konflikt in `data/universe/instruments.ndjson`

Die Registry-Datei ist versioniert **und** wird lokal vom Seed/Discovery
beschrieben. Bei Konflikt gewinnt im Zweifel das Repo, danach neu seeden:

```bash
git checkout -- data/universe/instruments.ndjson
git pull --ff-only
npm run universe:seed && npm run universe:seed:markets
```

Lokale Ergänzungen, die dir wichtig sind, vorher sichern
(`cp data/universe/instruments.ndjson /tmp/`) — Details in [MARKET_UNIVERSE.md](MARKET_UNIVERSE.md).

### C) `git pull --ff-only` bricht ab: „Not possible to fast-forward“

Du hast lokale Commits. Entweder gehören sie in einen Branch/PR
(`git switch -c meine-aenderung && git switch main && git pull --ff-only`) oder du
willst sie nicht mehr (`git reset --hard origin/main` — **löscht** die lokalen
Commits, vorher `git log origin/main..HEAD` ansehen).

### D) Nach dem Start: `EADDRINUSE :3369`

Ein alter Server lebt noch (meist ein manuell gestarteter neben der Unit).
`npm run stop`, dann Unit erneut starten. Ausführlich: [HOWTO_LAN_SESSION.md](HOWTO_LAN_SESSION.md) Bug 1.

### E) Rollback

```bash
sudo systemctl stop market-sync.timer market-sync-full.timer micro-executor ai-trading-firm
git log --oneline -5                     # alten Commit/Tag heraussuchen
git checkout <alter-commit>              # oder: git checkout v1.39.0
rm -rf .next node_modules/.cache && npm ci && npm run build
# nur wenn drizzle-kit push gelaufen war und die alte Version damit nicht kann:
gunzip -c ~/backups/firm-pre-update-<Zeit>.sql.gz | psql "$(grep '^DATABASE_URL=' .env | cut -d= -f2-)"
sudo systemctl start ai-trading-firm micro-executor market-sync.timer market-sync-full.timer
```

Additive Schema-Änderungen (neue Spalte/Tabelle) stören den alten Code in aller
Regel nicht — der DB-Restore ist die Ausnahme, nicht der Standard.

---

## 12. Verwandte Dokumente

* [INSTALL.md](INSTALL.md) Kapitel 7 (systemd-Units) und Kapitel 12 (Kurzform + Backups)
* [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md) — Windows-Pfad
* [HOWTO_LAN_SESSION.md](HOWTO_LAN_SESSION.md) — die zwei häufigsten „nach dem Update kaputt“-Symptome, die keine sind
* [OPERATIONS.md](OPERATIONS.md) — wenn der Funnel nach dem Update leer bleibt
* [LIVE_TRADING.md](LIVE_TRADING.md) — Kill-Switch und Live-Gate rund um Wartungsfenster
* [../CHANGELOG.md](../CHANGELOG.md) — versionsspezifische Pflicht-Schritte
