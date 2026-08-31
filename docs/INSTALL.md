# Installation — Schritt für Schritt auf CachyOS

Diese Anleitung führt dich von einem frischen CachyOS bis zum laufenden Dienst.
Sie ist für **beide Varianten** geschrieben:

* **Variante A — Solo-Node:** alles auf dem Intel N150 (16 GB).
* **Variante B — Split-Node:** N150 = Dienst + Datenbank, Desktop (48 GB, RX 480) = Modellserver.

> **Lesehinweis:** Kapitel 0.5 ist der automatische Weg; Kapitel 1–7 sind dieselben
> Schritte von Hand. Beide Wege gelten für **beide** Varianten. Kapitel 8 ist **nur für
> Variante B**. Blöcke sind mit `[A]`, `[B]` oder `[A+B]` markiert.

**Zeitbedarf:** Kapitel 0.5 ca. 10–20 Minuten. Manuell: Variante A ca. 45 Minuten,
Variante B zusätzlich 1,5–2,5 Stunden (hauptsächlich der Vulkan-Build für die RX 480).

---

## Kapitel 0 — Vorher entscheiden `[A+B]`

Beantworte diese drei Fragen, bevor du tippst:

1. **Wo soll der Dienst dauerhaft laufen?** Antwort ist fast immer: auf dem N150. Er ist
   sparsam und darf 24/7 laufen. Der Desktop ist der Kraftprotz auf Abruf.
2. **Willst du am ersten Tag GPU-Beschleunigung?** Nein. Fang mit CPU an. Die RX 480 ist
   eine Optimierung, kein Fundament — und sie ist der aufwendigste Teil (Kapitel 8.3).
3. **Wie viel darf ein Pipeline-Durchlauf dauern?** Wenn 2–6 Minuten okay sind: Variante A
   reicht dauerhaft. Wenn du unter einer Minute brauchst: plane Variante B ein.

---

## Kapitel 0.5 — Automatische Installation (empfohlen) `[A+B]`

Seit v1.30.0 erledigt `scripts/setup-cachyos.sh` die Kapitel 1–7 in einem
Durchlauf. Das Skript ist idempotent: Es darf beliebig oft erneut laufen, ohne
Daten zu verlieren oder `.env` still zu überschreiben.

```bash
# auf dem N150
sudo pacman -S --needed git
git clone https://github.com/Kryschuuu/ai-trading-firm.git
cd ai-trading-firm

# Variante A — alles auf dem N150
./scripts/setup-cachyos.sh --variant a

# Variante B — Modellserver auf dem Desktop im LAN
./scripts/setup-cachyos.sh --variant b --llm-host 192.168.1.50
```

Zuerst trocken durchspielen ist jederzeit möglich:

```bash
./scripts/setup-cachyos.sh --variant a --dry-run
```

### Was die zehn Schritte tun

| # | Schritt | Inhalt |
| --- | --- | --- |
| 01 | `step_01_preflight` | CachyOS/Arch prüfen, `sudo`, Werkzeugkasten, Port frei |
| 02 | `step_02_packages` | `nodejs`, `npm`, `postgresql`, `openssl` über `pacman` |
| 03 | `step_03_postgres` | Cluster prüfen, `initdb` mit UTF-8 und Fallback-Locale |
| 04 | `step_04_database` | Rolle mit Passwort (SCRAM), Datenbank, `pg_isready` |
| 05 | `step_05_env` | `.env` anlegen/ergänzen, `FIRM_API_TOKEN`, Recht `600` |
| 06 | `step_06_dependencies` | `npm ci` |
| 07 | `step_07_schema` | `drizzle-kit push`, ≥ 13 Pflicht-Tabellen verifizieren |
| 08 | `step_08_universe` | `npm run universe:seed` + `npm run universe:seed:markets` |
| 09 | `step_09_build` | `npm run build`, Build-Warnungen auswerten |
| 10 | `step_10_validate` | Seed, Short-Selling-Default, `scripts/validate-setup.sh` |

### Die wichtigsten Optionen

```bash
--variant a|b          Pflicht: Solo-Node oder Split-Node
--llm-host HOST        Variante B: IP des Modellservers
--db-name / --db-user / --db-host / --db-port
--pgdata PFAD          Datenverzeichnis (Default /var/lib/postgres/data)
--api-token TOKEN      API-Token vorgeben
--no-api-token         kein Token (Sicherheitswarnung!)
--no-shorts            Short-Selling deaktiviert lassen
--sync-markets         Marktdaten-Warmup gleich mitfahren
--skip-build / --skip-validate / --min-pass N
--reset-cluster        Cluster ohne Rückfrage neu initialisieren
--dry-run              nur anzeigen, nichts ausführen
--non-interactive / -y keine Fragen
--log-file PFAD        Default: data/setup/setup-<Zeitstempel>.log
```

### Fehlerbehandlung und Log

* Jede Ausgabe läuft mit Zeitstempel nach `data/setup/setup-<Zeitstempel>.log`.
* Die `ERR`-Trap nennt bei Abbruch **Schritt und Zeilennummer**.
* `DATABASE_URL` und Passwörter werden in Anzeige **und** Log maskiert.
* Exit-Codes: `0` erfolgreich · `1` Fehler · `2` Bedienfehler.

### Abnahme

Der letzte Schritt führt `scripts/validate-setup.sh` mit 18 Checks aus
(bestanden ab 15). Separat wiederholbar:

```bash
./scripts/validate-setup.sh
./scripts/validate-setup.sh --min-pass 18
./scripts/validate-setup.sh --json
```

Befund-Historie, dokumentierte Ausnahmen und Behebungszeilen:
[`SETUP_BUGS.md`](SETUP_BUGS.md). PostgreSQL-Soforthilfe:
[`SETUP_PG_TROUBLESHOOTING.md`](SETUP_PG_TROUBLESHOOTING.md).

> **Wer die Kapitel 1–7 von Hand durchgehen will**, liest ab hier einfach weiter —
> sie beschreiben exakt dieselben Schritte.

---

## Kapitel 1 — System vorbereiten `[A+B]`

Auf **jedem** beteiligten Rechner:

```bash
# System aktualisieren
sudo pacman -Syu

# Basiswerkzeuge
sudo pacman -S --needed base-devel git curl jq
```

`jq` brauchst du später für die API-Beispiele — es lohnt sich.

Kontrolle:

```bash
uname -r          # Kernel-Version
free -h           # RAM: N150 ~16 GiB, Desktop ~48 GiB
nproc             # N150: 4
```

---

## Kapitel 2 — Node.js installieren `[A+B]`

Der Dienst braucht **Node.js 20 oder neuer**.

```bash
sudo pacman -S --needed nodejs npm
node --version     # muss v20.x oder höher sein
npm --version
```

<details>
<summary>Falls die Paketversion zu alt ist: Node über <code>nvm</code></summary>

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc          # bei fish: siehe nvm-Doku
nvm install 22
nvm use 22
nvm alias default 22
```
</details>

---

## Kapitel 3 — PostgreSQL einrichten `[A]` (bei B nur auf dem N150)

### 3.1 Installieren und initialisieren

```bash
sudo pacman -S --needed postgresql

# Datenverzeichnis initialisieren (nur beim allerersten Mal!)
# Prüfsummen + harte Auth-Defaults: peer (Lokal) / scram-sha-256 (TCP).
sudo -u postgres initdb -D /var/lib/postgres/data --locale=C.UTF-8 --encoding=UTF8 \
  --data-checksums --auth-local=peer --auth-host=scram-sha-256

sudo systemctl enable --now postgresql

# WICHTIG: auf echte Bereitschaft warten — systemctl meldet den Dienst
# manchmal schon als 'active', während der Server noch startet (oder bei
# defektem Cluster in einer Restart-Schleife hängt und trotzdem 'active'
# erscheint). pg_isready prüft das wirklich:
pg_isready   # → 'accepting connections' abwarten
systemctl status postgresql --no-pager
```

Erwartet: `Active: active (running)` und `pg_isready` meldet *accepting connections*.

> **Halb initialisiertes Cluster?** Meldet psql
> `could not open file "global/pg_filenode.map"`, ist das Datenverzeichnis
> defekt (abgebrochenes initdb / Konflikt mit dem systemd-Dienst).
> `./scripts/setup-cachyos.sh` erkennt und repariert das seit v1.5.2 automatisch;
> manuell: Handbuch, Kapitel 10.6.

### 3.2 Benutzer und Datenbank anlegen

```bash
sudo -u postgres psql <<'SQL'
CREATE USER trader WITH PASSWORD 'bitte-hier-aendern';
CREATE DATABASE trading_firm OWNER trader;
GRANT ALL PRIVILEGES ON DATABASE trading_firm TO trader;
SQL
```

### 3.3 Verbindung testen

```bash
psql "postgresql://trader:bitte-hier-aendern@127.0.0.1:5432/trading_firm" -c "SELECT version();"
```

Kommt eine Versionszeile zurück, ist die Datenbank bereit.

> **Sicherheitshinweis:** Ändere das Passwort. Die Datenbank enthält dein komplettes
> Entscheidungsprotokoll — sie soll nur auf `127.0.0.1` lauschen (Standard bei Arch/CachyOS).

---

## Kapitel 4 — Ollama prüfen und Modelle holen `[A]` (bei B auf dem Desktop, siehe Kapitel 8)

Ollama läuft bei dir bereits. Kurz verifizieren:

```bash
systemctl status ollama --no-pager    # oder: ollama --version
curl -s http://127.0.0.1:11434/api/tags | jq '.models[].name'
```

> **Kein Ollama nötig?** Seit v1.3.0 kannst du alternativ einen OpenAI-kompatiblen
> Server, Google Gemini oder Anthropic Claude als Modellquelle wählen — siehe
> [PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md). Für Variante A bleibt Ollama
> die empfohlene Wahl (0 €, kein Datenabfluss).

### 4.1 Modellwahl für Variante A (N150, 16 GB, reine CPU) `[A]`

Der N150 hat **vier Effizienzkerne und Single-Channel-RAM**. Der begrenzende Faktor ist
nicht die Rechenleistung, sondern die **Speicherbandbreite** (~20 GB/s real). Faustformel:

> Token pro Sekunde ≈ Speicherbandbreite ÷ Modellgröße im RAM

| Modell | Größe (Q4) | erwartete Geschwindigkeit | Eignung |
| --- | --- | --- | --- |
| `qwen2.5:1.5b-instruct-q4_K_M` | ~1,0 GB | 15–20 tok/s | Test, sehr einfache JSON-Aufgaben |
| **`qwen2.5:3b-instruct-q4_K_M`** | ~1,9 GB | **8–11 tok/s** | **empfohlener Start für A** |
| `llama3.2:3b-instruct-q4_K_M` | ~2,0 GB | 8–10 tok/s | gute Alternative, andere Fehlerprofile |
| `qwen2.5:7b-instruct-q4_K_M` | ~4,4 GB | 3–4 tok/s | nur für den CEO, wenn Geduld vorhanden |

Startempfehlung:

```bash
ollama pull qwen2.5:3b-instruct-q4_K_M
```

Sofort testen — das ist dein Realitätscheck:

```bash
time ollama run qwen2.5:3b-instruct-q4_K_M \
  'Antworte NUR mit JSON: {"type":"TRADE","symbol":"BTC","side":"LONG","stopLossPct":5,"reason":"kurz"}'
```

* Antwort in **unter 15 Sekunden** und valides JSON → dein Setup trägt Variante A.
* Deutlich langsamer → nimm `qwen2.5:1.5b` für die Fachagenten.
* Kein valides JSON → siehe Handbuch Kapitel 6 (Prompt-Härtung).

### 4.2 Warum nicht DeepSeek Coder als Orchestrator? `[A+B]`

Kurz: **Coder-Modelle sind auf Code trainiert, nicht auf Instruktionstreue in
Entscheidungsketten.** Nimm `deepseek-coder` oder `qwen2.5-coder` für den Backtest-Agenten
(Testskripte schreiben) und `qwen2.5-instruct` für alles, was koordiniert, bewertet
oder freigibt. Ausführliche Begründung im Handbuch, Kapitel 7.

---

## Kapitel 5 — Projekt einrichten `[A+B]` (auf dem N150)

```bash
git clone <dein-repo> ~/ai-trading-firm
cd ~/ai-trading-firm
npm install
```

### 5.1 `.env` anlegen

```bash
cp .env.example .env
nano .env
```

**Variante A** (alles lokal):

```ini
DATABASE_URL=postgresql://trader:bitte-hier-aendern@127.0.0.1:5432/trading_firm

LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_NUM_CTX=4096
LLM_TIMEOUT_MS=180000

STARTING_EQUITY=10000
REQUIRE_HUMAN_APPROVAL=false

MODEL_CEO=qwen2.5:3b-instruct-q4_K_M
MODEL_RESEARCH=qwen2.5:3b-instruct-q4_K_M
MODEL_BACKTEST=qwen2.5:3b-instruct-q4_K_M
MODEL_RISK=qwen2.5:3b-instruct-q4_K_M
MODEL_APPROVER=qwen2.5:3b-instruct-q4_K_M
MODEL_EXECUTOR=qwen2.5:3b-instruct-q4_K_M
```

**Variante B** (Modelle auf dem Desktop, IP anpassen):

```ini
DATABASE_URL=postgresql://trader:bitte-hier-aendern@127.0.0.1:5432/trading_firm

LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://192.168.1.50:11434     # ← IP des Desktops
OLLAMA_NUM_CTX=8192
LLM_TIMEOUT_MS=180000

STARTING_EQUITY=10000
REQUIRE_HUMAN_APPROVAL=false

MODEL_CEO=qwen2.5:14b-instruct-q4_K_M
MODEL_RESEARCH=qwen2.5:7b-instruct-q4_K_M
MODEL_BACKTEST=qwen2.5-coder:7b
MODEL_RISK=qwen2.5:7b-instruct-q4_K_M
MODEL_APPROVER=qwen2.5:7b-instruct-q4_K_M
MODEL_EXECUTOR=qwen2.5:7b-instruct-q4_K_M
```

### 5.2 Tabellen anlegen

```bash
npx drizzle-kit push
```

> **Wichtig für Variante B (und bei allen frischen Installationen):**  
> Das Projekt nutzt `drizzle.config.ts` statt einer `drizzle.config.json`.
> Die `.ts`-Konfiguration liest `DATABASE_URL` aus der `.env` — sie zeigt damit
> immer auf die richtige Datenbank, egal auf welchem Rechner du den Befehl ausführst.
>
> Falls du auf deinem System noch eine alte `drizzle.config.json` mit einer
> hardcodierten URL findest: Diese Datei löschen. Drizzle bevorzugt `.ts` automatisch.
>
> Als zusätzliche Absicherung kannst du die URL auch explizit übergeben:
>
> ```bash
> DATABASE_URL="$(grep DATABASE_URL .env | cut -d= -f2-)" npx drizzle-kit push --force
> ```

Erwartet: `[✓] Changes applied`. Kontrolle:

```bash
psql "$DATABASE_URL" -c "\dt"
```

Es müssen **zwölf** Tabellen erscheinen (v1.6):

```
 agents            agent_messages   audit_log        kill_switches
 missions          positions        proposals        risk_config
 equity_snapshots  trade_rules      rule_executions  rule_backtests
```

Fehlt eine Tabelle — insbesondere `positions` — hast du das Symptom aus dem
Original-Fehlerbericht: Der Dienst startet, schlägt aber beim ersten Request mit
`relation "positions" does not exist` fehl. Lösung: erneut `npx drizzle-kit push`.

```bash
# Spalten der positions-Tabelle prüfen (stop_loss muss da sein)
psql "$DATABASE_URL" -c "\d positions"
```

### 5.3 Bauen und starten

```bash
npm run build
npm run start          # läuft auf http://localhost:3369
```

Im Browser öffnen → **„Seed / Reset"** → **„▶▶ Ganze Pipeline"**.

**Optional (v1.6): Mikro-Zyklus starten** — die LLM-freie Ausführungsebene
(regelbasiert, pro Preis-Tick). Einmal die erste Regel erzeugen:

```bash
curl -s -X POST localhost:3369/api/firm/macro | jq '.cycle.rule.status'
```

Dann als eigener Prozess bzw. Dienst (Kapitel 7.1):

```bash
npm run micro                      # Vordergrund / Smoke
# oder:
sudo cp deploy/micro-executor.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now micro-executor
```

---

## Kapitel 6 — Erster Funktionstest `[A+B]`

Im zweiten Terminal:

```bash
# 1. Lebt der Dienst?
curl -s http://localhost:3369/api/health | jq

# 2. Team und Missionen anlegen (idempotent)
curl -s -X POST http://localhost:3369/api/seed | jq

# 3. Zustand ansehen
curl -s http://localhost:3369/api/firm | jq '{
  llm: .ollama.provider, verfuegbar: .ollama.available, modelle: .ollama.models,
  equity: .account.equity, notHalt: .killSwitchArmed,
  agenten: [.agents[] | "\(.role): \(.model)"]
}'
```

Wenn `verfuegbar: false` erscheint, arbeitet das System mit der Regel-Engine — die
Pipeline funktioniert trotzdem, nur ohne echtes Modell. Prüfe dann `OLLAMA_BASE_URL`.

Kompletter Durchlauf:

```bash
MISSION=$(curl -s http://localhost:3369/api/firm | jq -r '.missions[0].id')
curl -s -X POST http://localhost:3369/api/firm/run \
  -H 'Content-Type: application/json' \
  -d "{\"missionId\":\"$MISSION\",\"pipeline\":true}" | jq '.pipeline[] | {rolle:.role, status:.result.status, quelle:.result.source, ms:.result.latencyMs}'
```

Erwartete Ausgabe (Variante A, Regel-Engine oder kleines Modell):

```json
{"rolle":"CEO","status":"REPORT","quelle":"ollama","ms":4210}
{"rolle":"RESEARCH","status":"EXECUTED","quelle":"ollama","ms":3880}
```

Die Pipeline stoppt nach `EXECUTED` — genau eine Position pro Durchlauf. Das ist Absicht.

Oder bequemer mit dem mitgelieferten Skript:

```bash
./scripts/smoke-test.sh
```

### 6.1 Marktdaten-Warmup vor dem ersten Scan `[A+B]`

Der deterministische Scanner (`npm run scan`) führt **keine** Netzwerk-Requests
aus — er liest nur, was der Sync vorher persistiert hat. Ohne Warmup meldet er
`WARMING` und lehnt alle Instrumente mit `min-candles` ab. Also zuerst:

```bash
# 1. trocken prüfen: echte Requests, aber nichts wird nach data/ geschrieben
npm run market:sync -- --dry-run

# 2. wirklich synchronisieren (Registry + data/history/candles.ndjson)
BITUNIX_ENABLED=true npm run market:sync

# 3. danach der Scan — jetzt mit Historie
npm run scan -- --json | jq '.readiness, .funnel.scanned'
```

Erwartung nach Schritt 2 (Zählerzeilen, keine Symbole/URLs):

```
[market-sync] BITUNIX discovery: 26 instruments
[market-sync] tickers enriched: 26
[market-sync] orderbooks enriched: 26
[market-sync] 1h candles: 26/26 (3900/3900 bars)
[market-sync] duration: 8123 ms
```

Der Status des Warmups lässt sich ohne jeden Request abfragen (Exit 1 = Warmup
fehlt — genau der Befund, der den leeren Trichter erzeugt):

```bash
npm run market:sync:status
# [market-sync] status: ALL · Registry 26 · Discovery (24h) 26
# [market-sync] Warmup: 26/26 bereit · 0 im Warmup · 3900 Kerzen geladen (≥ 61 je Instrument)
# [market-sync] Enrichment: tickers 26/26 · orderbooks 26/26
# [market-sync] Scanner bereit: ja
```

Exit-Codes: `0` sauberer Lauf · `1` degradierter Lauf (mindestens ein isolierter
Fehler, Teilpersistenz bleibt — Details in `data/market-data-errors.json`) ·
`2` Bedienfehler (unbekannte Option, Venue nicht freigeschaltet,
`--candle-limit` unter dem Warmup-Bedarf) — da geht kein Request raus.
Flags, Gates und Limits: [`MARKET_DATA_PIPELINE.md`](MARKET_DATA_PIPELINE.md) §12.

---

## Kapitel 7 — Als Dienst einrichten (systemd) `[A+B]`

Damit die Firma nach jedem Reboot von selbst läuft.

### 7.1 Unit installieren

```bash
sudo cp deploy/ai-trading-firm.service /etc/systemd/system/
sudo nano /etc/systemd/system/ai-trading-firm.service   # User + Pfade anpassen
sudo systemctl daemon-reload
sudo systemctl enable --now ai-trading-firm
```

**Mikro-Executor (zweite Unit, v1.6):**

```bash
sudo cp deploy/micro-executor.service /etc/systemd/system/
sudo nano /etc/systemd/system/micro-executor.service   # User + Pfade anpassen
sudo systemctl daemon-reload
sudo systemctl enable --now micro-executor
```

### 7.2 Kontrolle

```bash
systemctl status ai-trading-firm --no-pager
journalctl -u ai-trading-firm -f          # Live-Log, mit Strg+C beenden
curl -s http://localhost:3369/api/health

# Mikro-Zyklus
systemctl status micro-executor --no-pager
curl -s http://localhost:3380/health | jq '.feed.connected, .cache.activeRules'
```

### 7.3 Im Heimnetz erreichbar machen (optional)

```bash
# Firewall öffnen — nur wenn du weißt, wer im Netz ist
sudo firewall-cmd --add-port=3369/tcp --permanent && sudo firewall-cmd --reload
# oder bei ufw:
sudo ufw allow from 192.168.1.0/24 to any port 3369
```

> **Nicht ins offene Internet stellen.** Es gibt keine Authentifizierung. Wenn du von
> außen zugreifen willst: WireGuard oder Tailscale, kein Portforwarding.

---

## Kapitel 8 — Variante B einrichten `[B]`

Ab hier arbeitest du auf **beiden** Rechnern. Der N150 heißt im Folgenden *Server*,
der 48-GB-Rechner *Desktop*.

### 8.1 Ollama auf dem Desktop im LAN freigeben `[B]`

Standardmäßig lauscht Ollama nur auf `127.0.0.1`. Das muss sich ändern:

```bash
# auf dem DESKTOP
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo cp deploy/ollama-lan.conf /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl restart ollama

# Prüfen, dass er auf allen Interfaces lauscht
ss -tlnp | grep 11434
```

Firewall auf dem Desktop öffnen — **nur für die Server-IP**:

```bash
sudo ufw allow from 192.168.1.42 to any port 11434    # ← IP des N150
```

Vom **Server** aus testen:

```bash
curl -s http://192.168.1.50:11434/api/tags | jq '.models[].name'
```

### 8.2 Modelle auf dem Desktop holen `[B]`

```bash
# auf dem DESKTOP
ollama pull qwen2.5:7b-instruct-q4_K_M     # Arbeitspferd der Fachagenten
ollama pull qwen2.5:14b-instruct-q4_K_M    # nur für den CEO
ollama pull qwen2.5-coder:7b               # Backtest-Agent
```

Speicherbedarf im RAM: 7B Q4 ≈ 4,4 GB, 14B Q4 ≈ 9 GB. Bei 48 GB kannst du beide
gleichzeitig geladen halten:

```bash
# auf dem DESKTOP: Modelle nach Gebrauch nicht sofort entladen
sudo systemctl edit ollama
# und im Editor ergänzen:
#   [Service]
#   Environment="OLLAMA_KEEP_ALIVE=30m"
#   Environment="OLLAMA_MAX_LOADED_MODELS=2"
```

Das spart bei jedem Agentenwechsel 10–30 Sekunden Ladezeit — der größte Einzelgewinn
in Variante B.

### 8.3 RX 480 per Vulkan nutzen (optional, aber lohnend) `[B]`

**Ausgangslage ehrlich benannt:** Die RX 480 ist eine Polaris-Karte (`gfx803`). AMD hat
ROCm-Unterstützung dafür eingestellt, und **offizielles Ollama wird sie nicht nutzen** —
es fällt still auf CPU zurück. Der funktionierende Weg ist der **Vulkan-Backend von
llama.cpp**. Gemessene Werte anderer Nutzer mit genau dieser Kartenfamilie: **~21–30
tok/s** bei einem 7B-Q4-Modell gegenüber ~8 tok/s auf CPU. Das ist den Aufwand wert.

#### Schritt 1 — Voraussetzungen

```bash
# auf dem DESKTOP
sudo pacman -S --needed cmake ninja vulkan-radeon vulkan-headers \
                        vulkan-tools shaderc glslang mesa

vulkaninfo --summary | grep -i "deviceName\|apiVersion"
```

Erwartet: `AMD Radeon RX 480 (RADV POLARIS10)`. Mesa sollte **Version 25 oder neuer**
sein (`glxinfo | grep "OpenGL version"`), sonst fehlt Vulkan 1.4.

#### Schritt 2 — llama.cpp mit Vulkan bauen

```bash
git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp
cd ~/llama.cpp
cmake -B build -DGGML_VULKAN=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j4
```

Der Build dauert 10–25 Minuten.

#### Schritt 3 — Modell im GGUF-Format besorgen

```bash
mkdir -p ~/models && cd ~/models
# Beispiel: Qwen2.5 7B Instruct, Q4_K_M
curl -L -o qwen2.5-7b-instruct-q4_k_m.gguf \
  "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf"
```

#### Schritt 4 — Kurz benchmarken, bevor du dich freust

```bash
cd ~/llama.cpp
./build/bin/llama-bench -m ~/models/qwen2.5-7b-instruct-q4_k_m.gguf -ngl 99
```

In der Ausgabe muss `Vulkan` als Backend stehen und `tg128` sollte deutlich über dem
CPU-Wert liegen. Falls `VK_ERROR_DEVICE_LOST` erscheint: erst mit weniger Layern testen
(`-ngl 20`), das ist bei Polaris ein bekanntes Muster.

#### Schritt 5 — Als Server starten (OpenAI-kompatibel)

```bash
./build/bin/llama-server \
  -m ~/models/qwen2.5-7b-instruct-q4_k_m.gguf \
  -ngl 99 -c 8192 --host 0.0.0.0 --port 8080 --alias qwen-local
```

Test vom **Server** aus:

```bash
curl -s http://192.168.1.50:8080/v1/models | jq
```

#### Schritt 6 — Dienst auf den Vulkan-Server umstellen

In der `.env` auf dem **Server**:

```ini
LLM_PROVIDER=openai
LLM_BASE_URL=http://192.168.1.50:8080/v1
LLM_MODEL=qwen-local
# LLM_API_KEY bleibt leer — llama-server verlangt standardmäßig keinen
```

Danach `npm run build && sudo systemctl restart ai-trading-firm`. Im Dashboard steht in
der Statusleiste jetzt die Modellanzahl des llama-servers statt „Regel-Engine".

> **Kleiner Wermutstropfen:** `llama-server` bedient immer **ein** Modell. In Variante B
> mit Vulkan bekommen also alle Agenten dasselbe Modell. Willst du unterschiedliche
> Modelle pro Rolle, betreibe entweder mehrere `llama-server`-Instanzen auf
> verschiedenen Ports oder bleib für die Rollenvielfalt bei Ollama (CPU).

### 8.4 Ausfallsicherheit prüfen `[B]`

Schalte den Desktop testweise aus und starte eine Pipeline. Erwartetes Verhalten:

* Statusleiste zeigt **„Regel-Engine"**,
* die Pipeline läuft trotzdem durch,
* im Audit-Log steht bei jeder Entscheidung `"source":"fallback"`.

Das System handelt also **nicht blind weiter mit erfundenen Modellantworten**, sondern
mit deterministischen, konservativen Regeln. Genau das willst du bei einem Netzwerkausfall.

---

## Kapitel 9 — Geführtes Setup-Skript `[A+B]`

Statt Kapitel 1–7 von Hand — **siehe [Kapitel 0.5](#kapitel-05--automatische-installation-empfohlen-ab)**,
dort stehen Aufruf, zehn Schritte, alle Optionen, Log-Pfad und Exit-Codes.

```bash
./scripts/setup-cachyos.sh --variant a                        # Solo-Node
./scripts/setup-cachyos.sh --variant b --llm-host 192.168.1.50  # Split-Node
```

Das Skript ist absichtlich gesprächig: es zeigt jeden Befehl an, fragt vor
Systemänderungen nach und bricht bei Fehlern ab. Lies mit, statt blind zu
bestätigen. Mit `--dry-run` zeigt es jeden Befehl, führt aber nichts aus.

**Hängt das Setup beim PostgreSQL-Schritt oder meldet es einen
Cluster-Fehler:** Sofort-Hilfe und alle Fehlerfälle stehen in
**[docs/SETUP_PG_TROUBLESHOOTING.md](SETUP_PG_TROUBLESHOOTING.md)** — und
im Dashboard unter `/api/docs?name=pgsetup`. Die Befund-Historie des Setup-Pfads
(B1–B6) steht in **[SETUP_BUGS.md](SETUP_BUGS.md)**.

---

## Kapitel 10 — Installation überprüfen `[A+B]`

Hake diese Liste ab, bevor du weitermachst:

- [ ] `./scripts/validate-setup.sh` → `Validierung bestanden.` (18 Checks, ab 15)
- [ ] `systemctl status postgresql` → `active (running)`
- [ ] `psql "$DATABASE_URL" -c "\dt"` zeigt mindestens 13 Tabellen
- [ ] `curl -s localhost:3369/api/health` antwortet mit `schemaReady: true`
- [ ] Dashboard erreichbar, Statusleiste zeigt Equity 10.000
- [ ] Seed legt **12 Agenten** und **4 Missionen** an (idempotent)
- [ ] `/api/firm` zeigt zwölf Agenten und mindestens eine Mission mit gültiger UUID
- [ ] `/api/markets` meldet ≥ 50 Aktien, ≥ 50 Indizes, ≥ 20 Rohstoffe, ≥ 30 Krypto
- [ ] `/api/firm | jq .account.broker` → `"PAPER"`
- [ ] `/api/firm | jq .riskLimits.allowShort` → `true` (oder bewusst `false`)
- [ ] `npm run build` kompiliert ohne Turbopack-Warnungen
- [ ] `curl -s localhost:3369/api/firm | jq .ollama` → `available: true`
- [ ] `POST` ohne `x-firm-token` antwortet mit `401`
- [ ] Eine Pipeline läuft durch und erzeugt eine Position
- [ ] Not-Halt-Knopf blockiert weitere Orders (Audit-Log prüfen)
- [ ] `systemctl restart ai-trading-firm` → Positionen sind danach noch da
- [ ] Reboot → Dienst kommt automatisch hoch

Sind alle Punkte erfüllt, geht es im **[Handbuch](HANDBUCH.md)** weiter.

---

## Kapitel 11 — Typische Fehler und Lösungen `[A+B]`

| Symptom | Ursache | Lösung |
| --- | --- | --- |
| **`relation "positions" does not exist`** | `drizzle-kit push` lief nicht oder auf falsche DB | `npx drizzle-kit push` im Projektstamm; sicherstellen dass `.env` mit `DATABASE_URL` existiert |
| **Setup-Seite statt Dashboard beim ersten Start** | Schema fehlt (oder DB defekt/nicht erreichbar) | erst `pg_isready`, dann `npx drizzle-kit push`, dann Browser neu laden |
| **`/api/health` liefert `schemaReady: false` (HTTP 200)** | Tabellen fehlen | `npx drizzle-kit push` ausführen; Details im Feld `missingTables` |
| **`could not open file "global/pg_filenode.map"`** | Cluster halb initialisiert (abgebrochenes initdb, Konflikt mit systemd-Dienst); Server crasht in Restart-Schleife | Handbuch Kapitel 10.6 — oder `./scripts/setup-cachyos.sh` erneut ausführen (repariert seit v1.5.2 selbstständig) |
| **`invalid input syntax for type uuid: "null"`** beim ersten Pipeline-Lauf | keine Mission vorhanden — der Smoke-Test postete den String `null` als `missionId` | `curl -s -X POST localhost:3369/api/seed`, dann `./scripts/validate-setup.sh` (Check V07 prüft die UUID-Form). Seit v1.30.0 behoben: Befund B2 in **[SETUP_BUGS.md](SETUP_BUGS.md)** |
| **`UNEXPECTED_BROKER_ADAPTER: PAPER-Adapter erwartet`** | die Broker-Factory liefert keinen Paper-Adapter — meist fehlendes `.env` oder `PAPER_MODE`-Fehlkonfiguration | `.env` und `PAPER_MODE` prüfen, Dienst neu starten; Check V12 verifiziert `/api/firm → account.broker`. Befund B3 in **[SETUP_BUGS.md](SETUP_BUGS.md)** |
| **`initdb: error: locale "C.UTF-8" does not exist`** | Minimalinstallation ohne `C.UTF-8` | seit v1.30.0 behoben: `pg_pick_locale()` fällt auf `en_US.UTF-8` bzw. `C` zurück. Manuell: `initdb -D … --locale=en_US.UTF-8 --encoding=UTF8`. Befund B1 |
| **Build meldet „Dynamic filesystem access“-Warnungen** | dynamische `path.join(process.cwd(), …)`-Stellen | seit v1.30.0 behoben über `src/lib/appPaths.ts`. Wiederkehrend? `npm run build` erneut prüfen — Setup-Schritt 09 meldet sie. Befund B4 |
| **API im LAN offen beschreibbar** | `npm run start` bindet `0.0.0.0` und ohne `FIRM_API_TOKEN` sind `POST`/`PUT` ungeschützt | `FIRM_API_TOKEN` in `.env` setzen (Setup erzeugt eines), Dienst neu starten; Check V18 prüft `401`. Befund B5 |
| **Scanner-Funnel leer trotz großem Universum** | Marktdaten-Warmup fehlt — Kerzen fehlen | `npm run market:sync`, dann `npm run scan -- --sync-first`; `npm run market:sync:status` zeigt die Readiness |
| **Setup-Skript: `nutzt ein anderes Datenverzeichnis: '${PGROOT}/data'`** (v1.5.2 und älter) | systemd liefert `${PGROOT}` in `ExecStart` unexpandiert — der Gurt hält die eigene Arch-Unit fälschlich für einen fremden Drop-in | seit v1.5.3 behoben (Expansion der Unit-Environment in `scripts/lib/pg-service.sh`); Update ziehen und Setup erneut ausführen |
| **`initdb` läuft durch, aber „Cluster nach initdb weiterhin unvollständig“** (v1.5.3 und älter) | Datenverzeichnis ist nach initdb `0700 postgres:postgres` — die alten Checks liefen als aufrufender Benutzer → EACCES → falsch „unvollständig“ (und falsches „existiert nicht“) | seit v1.5.4 behoben: alle Cluster-Checks laufen als postgres. **Nichts löschen!** → `sudo systemctl enable --now postgresql`, `pg_isready`, dann Setup erneut ausführen. Ausführlich: **docs/SETUP_PG_TROUBLESHOOTING.md** |
| `pg_ctl …` als User: *„Keine Berechtigung"*, als `sudo pg_ctl`: *„can't run as root"* | postgres-Serverprozess darf nur als postgres-Benutzer laufen | `sudo -u postgres pg_ctl -D /var/lib/postgres/data -l …/postgres.log start` — oder einfach `sudo systemctl start postgresql` |
| Push läuft durch, aber Tabellen fehlen trotzdem | alte `drizzle.config.json` mit hardcodierter URL überschreibt `.env` | `rm drizzle.config.json` — das Projekt nutzt `drizzle.config.ts` |
| Push schlägt mit `password authentication failed` fehl | `DATABASE_URL` in `.env` ≠ DB-Passwort | Passwort in `.env` korrigieren; explizit testen: `psql "$DATABASE_URL" -c "SELECT 1"` |
| Spalte `stop_loss` fehlt in `positions` | veraltetes Schema aus einem früheren Commit | `npx drizzle-kit push --force` |
| `DATABASE_URL ist nicht gesetzt` | `.env` fehlt oder wurde nicht geladen | `.env` im Projektstamm anlegen (Vorlage `.env.example`), Dienst neu starten. `next build` funktioniert auch ohne `.env` (Lazy-DB-Init seit v1.5.2) |
| `ECONNREFUSED 127.0.0.1:5432` | PostgreSQL läuft nicht (oder läuft mit defektem Cluster) | `pg_isready` → schlägt fehl: `sudo systemctl start postgresql` bzw. Handbuch 10.6 |
| `password authentication failed` | Passwort in `.env` ≠ DB-Passwort | `ALTER USER trader WITH PASSWORD '…';` |
| Statusleiste zeigt „Regel-Engine" | Ollama nicht erreichbar | `curl $OLLAMA_BASE_URL/api/tags`, Firewall und IP prüfen |
| Statusleiste OK, aber `source: fallback` | Modelltag existiert nicht | `ollama list` und Tags in `.env` abgleichen |
| Agent-Turn läuft in Timeout | Modell zu groß für die CPU | kleineres Modell, oder `LLM_TIMEOUT_MS` erhöhen |
| `VK_ERROR_DEVICE_LOST` | Polaris-Vulkan-Eigenheit | mit `-ngl 20` starten, Mesa aktualisieren |
| Ollama nutzt die GPU nicht | gfx803 ist von ROCm nicht unterstützt | erwartetes Verhalten → Kapitel 8.3 (Vulkan) |
| Modell antwortet mit Prosa statt JSON | zu kleines Modell / weicher Prompt | Handbuch Kapitel 6, oder eine Stufe größer wählen |
| Position verschwindet nach Neustart | Positionen stehen auf `CLOSED` | `psql -c "SELECT status, count(*) FROM positions GROUP BY 1;"` |
| Port 3369 belegt | anderer Dienst läuft | `PORT=3100 npm run start` |
| **Validierung meldet `V16` fehlgeschlagen** | Short-Selling ist aus, `--expect-shorts` erwartet aber `true` | `--expect-shorts false` — oder aktivieren: `allowShort = 1` im Dashboard bzw. `INSERT … ON CONFLICT (key) DO UPDATE` auf `risk_config` |
| **Validierung meldet `V08`–`V11` fehlgeschlagen** | Preset-Universum nicht geseedet | `npm run universe:seed:markets` |
| **Validierung meldet `V18` fehlgeschlagen** | kein `FIRM_API_TOKEN` konfiguriert | Token in `.env` setzen und Dienst neu starten — sonst ist die API im LAN offen |

Weitere Diagnose im **[Handbuch, Kapitel 12](HANDBUCH.md)**.

---

## Kapitel 12 — Updates und Sicherung `[A+B]`

```bash
# Update einspielen
cd ~/ai-trading-firm
git pull
npm install
npx drizzle-kit push          # nur nötig, wenn sich das Schema geändert hat
npm run build
sudo systemctl restart ai-trading-firm
```

Tägliche Sicherung der Entscheidungshistorie:

```bash
# in die crontab: crontab -e
0 3 * * * pg_dump "$DATABASE_URL" | gzip > ~/backups/firm-$(date +\%F).sql.gz
```

Wiederherstellen:

```bash
gunzip -c ~/backups/firm-2026-03-24.sql.gz | psql "$DATABASE_URL"
```
