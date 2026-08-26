# Autonome KI-Trading-Firma — lokal, Open Source, ohne Cloud

Ein lauffähiges Referenz-Setup für ein Team spezialisierter KI-Agenten (CEO, Research,
Backtest, Risk, Approver, Executor), das ein Handelsziel autonom bearbeitet — komplett
auf eigener Hardware, mit einer **abstrakten LLM-Provider-Schicht** (Ollama, jeder
OpenAI-kompatible Endpunkt wie `llama.cpp`/LM Studio/vLLM, Google Gemini, Anthropic
Claude), **PostgreSQL** als institutionellem Gedächtnis und **harten Risikogrenzen im Code**.

> **Wichtig:** Das System läuft ausschließlich im **Paper-Trading-Modus**. Es gibt keinen
> Live-Broker-Adapter im Auslieferungszustand. Kein echtes Geld ist im Spiel — genau so
> soll man anfangen.

---

## Inhalt

| Dokument | Zweck |
| --- | --- |
| **README.md** (diese Datei, `docs/README.md`) | Überblick, Architektur, Varianten A/B, Schnellstart |
| **[INSTALL.md](INSTALL.md)** | Installation Schritt für Schritt auf CachyOS, beide Varianten |
| **[HANDBUCH.md](HANDBUCH.md)** | Bedienung, ausführliche Beispiele, Runbooks, Troubleshooting |
| **[CHANGELOG.md](CHANGELOG.md)** | Versionen, Bugfixes und Änderungen je Release |
| **[SECURITY_AUDIT.md](SECURITY_AUDIT.md)** | Findings, Schweregrade, Fixes und Peer-Review |
| **[PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md)** | LLM-Provider (Ollama/OpenAI/Gemini/Claude) im Detail |

**Version:** `v1.5.0` (siehe `package.json` + [CHANGELOG.md](CHANGELOG.md)).
Alle Dokumente sind im laufenden System auch unter **`/docs`** im Browser lesbar.

---

## 1. Das Grundprinzip in einem Satz

> **Die KI schlägt vor — der Code entscheidet.**

Ein Agent kann halluzinieren, ein Prompt kann manipuliert werden, ein Modell kann kaputtes
JSON liefern. Deshalb liegt **jede** Sicherheitsgrenze außerhalb der Agentenlogik, in
kompiliertem Code, den kein Modell zur Laufzeit ändern kann.

```
Agent sagt: "Kauf für 90 % des Depots BTC ohne Stop"
        │
        ▼
Schicht 2  Engine-Validierung ........ Rolle darf handeln? Kill-Switch aus? Kurs vorhanden?
        ▼
Schicht 3  Guardrails (riskGuard.ts) .. max. 25 % Position, Stop-Loss Pflicht, kein Short
        ▼
Schicht 4  Kill-Switch ................ globaler Circuit-Breaker, DB-persistent
        ▼
Schicht 5  Broker-Schleuse ............ prüft ALLES nochmal, unabhängig von Schicht 2+3
        │
        ▼
Ergebnis: BLOCKED — "position-size:max-25%-of-equity | stop-loss:mandatory"
```

Die Ablehnung landet revisionssicher im `audit_log`. Nichts wird stillschweigend verworfen.

---

## 2. Architektur

```
┌──────────────────────────────────────────────────────────────────────┐
│  Next.js (App Router)          Dashboard · /docs · REST-API          │
├──────────────────────────────────────────────────────────────────────┤
│  Orchestrierung   src/lib/engine.ts                                  │
│     runAgentTurn()   ein Agent, ein Zug                              │
│     runPipeline()    CEO → Research → Backtest → Risk → Approver →   │
│                      Executor, strikt sequenziell                    │
├──────────────────────────────────────────────────────────────────────┤
│  HARTE GRENZEN    src/lib/riskGuard.ts     ← hier steht die Wahrheit │
│  Broker-Schleuse  src/lib/broker.ts        ← prüft ein zweites Mal   │
│  Provider-Schicht src/lib/llmProvider.ts   ← Ollama · OpenAI · Gemini│
│                    src/lib/ollama.ts       ← Schema, Retry, Fallback │
├──────────────────────────────────────────────────────────────────────┤
│  PostgreSQL + Drizzle    agents · missions · positions · proposals   │
│                          agent_messages · audit_log · kill_switches  │
│                          risk_config · equity_snapshots              │
└──────────────────────────────────────────────────────────────────────┘
```

**Institutionelles Gedächtnis** = `agent_messages` + `audit_log` + `proposals` in
PostgreSQL. Nach einem Neustart (systemd, Stromausfall, Deploy) stellt
`getBroker()` den Kontostand, die offenen Positionen und den Kill-Switch-Zustand
automatisch wieder her. Das ist der Teil, den man bei Prompt-only-Setups schmerzlich vermisst.

---

## 3. Die zwei Varianten

Das Setup ist für genau zwei Ausbaustufen dokumentiert. Beide nutzen denselben Code —
sie unterscheiden sich nur in Konfiguration und Modellgrößen.

### Variante A — „Solo-Node" (Einstieg, empfohlen für den ersten Tag)

Alles läuft auf dem **Intel N150 / 16 GB**: PostgreSQL, Next.js-Dienst und Ollama.

```
┌─────────────── N150, 16 GB, CachyOS ───────────────┐
│  PostgreSQL  ·  Next.js :3369  ·  Ollama :11434    │
│  Modell: qwen2.5:3b-instruct-q4_K_M (CPU)          │
└────────────────────────────────────────────────────┘
```

* **Vorteil:** ein Gerät, ~10 W, 24/7 sinnvoll, minimale Fehlerquellen.
* **Preis:** ~6–10 tok/s bei 3B, ~3–4 tok/s bei 7B. Ein Pipeline-Durchlauf mit 6 Agenten
  dauert **2–6 Minuten**. Für Swing-/Positionstrading völlig ausreichend, für Intraday knapp.

### Variante B — „Split-Node" (Leistung, wenn A steht)

Der N150 bleibt der **immer laufende Dienst**, der Desktop wird zum **Inferenz-Knoten**.

```
┌── N150 (24/7) ──────────┐        LAN        ┌── Desktop 48 GB + RX 480 ──┐
│  PostgreSQL             │  ───────────────► │  Ollama :11434   (CPU)      │
│  Next.js :3369          │   HTTP            │  oder llama-server :8080    │
│  keine Modelle          │                   │       (Vulkan, RX 480)      │
└─────────────────────────┘                   └─────────────────────────────┘
```

* **Vorteil:** 14B-Modelle für den CEO möglich; mit der RX 480 über **Vulkan** ca.
  **20–30 tok/s** bei 7B Q4 — ein Pipeline-Durchlauf dauert dann **20–60 Sekunden**.
* **Preis:** Desktop muss laufen (~150–250 W), Netzwerk als zusätzliche Fehlerquelle,
  zwei Systeme zu pflegen. Der Dienst überlebt einen Desktop-Ausfall trotzdem: er fällt
  automatisch auf die deterministische Regel-Engine zurück und handelt nicht blind.

### Direktvergleich

| | **Variante A — Solo-Node** | **Variante B — Split-Node** |
| --- | --- | --- |
| Hardware | nur N150 (16 GB) | N150 + Desktop (48 GB, RX 480) |
| Modell CEO | `qwen2.5:3b-instruct-q4_K_M` | `qwen2.5:14b-instruct-q4_K_M` |
| Modell Fachagenten | `qwen2.5:3b` / `llama3.2:3b` | `qwen2.5:7b-instruct-q4_K_M` |
| Tempo (7B Q4) | ~3–4 tok/s (CPU) | ~21–30 tok/s (RX 480 / Vulkan) |
| Pipeline-Durchlauf | 2–6 min | 20–60 s |
| Agenten parallel | nein, strikt sequenziell | 2 parallel machbar, empfohlen trotzdem sequenziell |
| Dauerbetrieb | ideal, ~10 W | Desktop nach Bedarf wecken |
| Einrichtungsaufwand | ~45 min | ~2–3 h (Vulkan-Build) |
| Gut für | erster Aufbau, Prompt-Iteration, 24/7-Wache | echte Recherche-Tiefe, längere Kontexte |

**Empfehlung:** mit **A** anfangen, die Pipeline verstehen, Prompts iterieren. Erst wenn die
Latenz konkret stört, auf **B** wechseln — es ist eine reine `.env`-Änderung plus
Modellinstallation, kein Umbau.

---

## 4. Schnellstart

Ausführlich in **[INSTALL.md](INSTALL.md)**. Die Kurzfassung:

```bash
# 1. Abhängigkeiten
sudo pacman -S --needed nodejs npm postgresql git

# 2. Datenbank starten (einmalig initialisieren, siehe INSTALL.md Kapitel 3)
sudo systemctl enable --now postgresql

# 3. Projekt
git clone <dein-repo> ai-trading-firm && cd ai-trading-firm
npm install
cp .env.example .env        # DATABASE_URL prüfen
npx drizzle-kit push        # Tabellen anlegen

# 4. Modell holen (Variante A)
ollama pull qwen2.5:3b-instruct-q4_K_M

# 5. Bauen und starten
npm run build && npm run start
```

Dann `http://localhost:3369` öffnen → **„Seed / Reset"** klicken → **„▶▶ Ganze Pipeline"**.

**Ohne Modell funktioniert es trotzdem:** Ist kein LLM erreichbar, schaltet das System auf
eine deterministische Regel-Engine um und zeigt „Regel-Engine" in der Statusleiste. Die
komplette Orchestrierung samt Guardrails lässt sich so ohne GPU nachvollziehen.

---

## 5. Projektstruktur

```
├── docs/
│   ├── README.md                 ← diese Datei (Überblick, Architektur)
│   ├── INSTALL.md                ← Installation A + B
│   ├── HANDBUCH.md               ← Bedienung, Beispiele, Runbooks
│   ├── CHANGELOG.md              ← Versionen & Bugfixes
│   ├── SECURITY_AUDIT.md         ← Audit-Ergebnis & Peer-Review
│   └── PROVIDER_INTEGRATION.md   ← LLM-Provider, Kosten, Retries
├── deploy/
│   ├── ai-trading-firm.service   ← systemd-Unit für den Dienst
│   └── ollama-lan.conf           ← Ollama im LAN freigeben (Variante B)
├── scripts/
│   ├── setup-cachyos.sh          ← geführte Installation (--variant a|b)
│   └── smoke-test.sh             ← prüft, ob alles läuft
└── src/
    ├── app/
    │   ├── page.tsx              ← Dashboard
    │   ├── docs/page.tsx         ← Doku im Browser
    │   └── api/
    │       ├── health/           ← Healthcheck für systemd/Monitoring
    │       ├── seed/             ← Team + Missionen anlegen (idempotent)
    │       ├── docs/             ← liefert die Markdown-Dateien
    │       └── firm/
    │           ├── route.ts      ← kompletter Firmenzustand (GET)
    │           ├── run/          ← Agent-Turn oder ganze Pipeline (POST)
    │           ├── kill/         ← Not-Halt ziehen/entschärfen (POST)
    │           ├── config/       ← Laufzeit-Limits (PUT, geklemmt)
    │           ├── missions/     ← Missionen anlegen/bearbeiten (Workshop)
    │           ├── agents/       ← system_prompt ändern (Workshop, PUT)
    │           ├── tick/         ← Monitor-Zyklus (POST)
    │           ├── report/       ← KPI-Report (GET)
    │           ├── equity/       ← Equity-Kurve (GET)
    │           └── log/          ← Protokoll/Audit (GET)
    ├── db/schema.ts              ← Drizzle-Tabellen
    ├── components/FirmDashboard.tsx
    ├── components/workshop/      ← Workshop-Tab: Missionen, Turns, Prompts, Trefferquote
    └── lib/
        ├── riskGuard.ts          ← HARTE LIMITS — die wichtigste Datei
        ├── broker.ts             ← Broker-Abstraktion + Paper-Broker
        ├── llmProvider.ts        ← Provider-Abstraktion (Ollama/OpenAI/Gemini/Claude)
        ├── ollama.ts             ← Schema, Retry, Regel-Engine-Fallback
        ├── engine.ts             ← Orchestrierung, Turns, Pipeline
        ├── monitor.ts            ← SL/TP-Überwachung, Tageslimit, Retention
        ├── marketData.ts         ← Binance/Yahoo-Kurse, Screener, Symbol-Whitelist
        └── workshop.ts           ← Workshop-Validierung: Missionen/Prompts, Trefferquote
```

---

## 6. Die harten Grenzen (Auslieferungszustand)

Aus `src/lib/riskGuard.ts` — Änderungen erfordern **Neubau und Neustart**, und das ist
Absicht: eine Sicherheitsgrenze, die man im laufenden Betrieb per Klick ändern kann, ist keine.

| Grenze | Wert | Bedeutung |
| --- | --- | --- |
| `maxPositionPct` | 0.25 | max. 25 % des Kapitals in einer Position |
| `maxRiskPerTrade` | 0.02 | max. 2 % Kapitalrisiko pro Trade |
| `maxConcurrentPositions` | 5 | nie mehr als 5 offene Positionen |
| `allowShort` | false | Leerverkäufe komplett gesperrt |
| `maxLeverage` | 1 | kein Hebel |
| `requireStopLoss` | true | Order ohne Stop-Loss wird abgelehnt |
| `maxEquityDrawdownPct` | 0.15 | ab 15 % Drawdown zieht der Kill-Switch automatisch |

---

## 7. REST-API

| Methode | Pfad | Zweck |
| --- | --- | --- |
| `GET` | `/api/health` | Healthcheck inkl. Version, Schema-Status (systemd, Monitoring) |
| `GET` | `/api/firm` | kompletter Zustand: Agenten, Missionen, Positionen, Audit, Limits |
| `POST` | `/api/seed` | Team + Missionen anlegen (idempotent) |
| `POST` | `/api/firm/run` | `{agentId, missionId}` oder `{missionId, pipeline:true}` |
| `POST` | `/api/firm/kill` | `{arm:true, flatten:true}` / `{arm:false}` |
| `POST` | `/api/firm/tick` | Monitor-Zyklus (Kurse, SL/TP, Tageslimit) — **schreibend** |
| `GET` | `/api/firm/report?period=day\|week\|month` | KPI-Report |
| `GET` | `/api/firm/equity?range=day\|week\|month\|all` | Equity-Kurve |
| `GET` | `/api/firm/log?limit=50&level=WARN` | Lesbare Protokoll-Timeline (`entries`: Turns, Analystenberichte, Systemmeldungen) + gefilterte Turn-Liste (`turns`) + Audit |
| `PUT` | `/api/firm/config` | Laufzeit-Limit ändern (wird auf Code-Ceilings geklemmt) |
| `GET/POST/PUT` | `/api/firm/missions` | Missionen lesen/anlegen/bearbeiten (Workshop; Budgets gegen Code-Ceilings) |
| `PUT` | `/api/firm/agents` | `system_prompt` eines Agenten ändern — wirken sofort, Guardrails unberührt |
| `GET` | `/api/docs?name=install` | Markdown-Doku als JSON |

Schreibende Endpunkte (`POST`/`PUT`) werden per `x-firm-token` geschützt, sobald
`FIRM_API_TOKEN` gesetzt ist (siehe `.env.example`).

Beispiele mit `curl` im **[Handbuch, Kapitel 4](HANDBUCH.md)**.

---

## 8. Ehrliche Grenzen dieses Setups

* **Kein Live-Trading.** Der Paper-Broker nutzt ein statisches Kursbuch. Für echte Kurse
  und Orders braucht es einen Adapter (Alpaca, ccxt) — Kapitel 8 im Handbuch beschreibt ihn.
* **Kein ernsthaftes Backtesting.** Bewusst weggelassen, weil zuerst Paper-Trading zählt.
  Der Backtest-Agent ist als nicht blockierender Platzhalter verdrahtet.
* **Kleine Modelle sind keine Analysten.** 3B–14B lokal ersetzen keine echte Recherche.
  Sie sind gut darin, klar definierte Aufgaben in stabiles JSON zu gießen — und genau
  dafür werden sie hier eingesetzt.
* **Cloud-Anbieter kosten Geld und geben Daten ab.** Die Provider-Schicht kann Gemini/Claude
  als Fallback nutzen (`LLM_FALLBACK_PROVIDERS`) — die Kostenrechnung im Dashboard
  (`estimateCostUsd`) ist eine Schätzung auf Referenzpreisen, keine Abrechnung.
* **Sequenziell ist gewollt.** Auf dieser Hardware bringt Parallelität kaum Durchsatz,
  aber sehr wohl Race-Conditions an der Broker-Schnittstelle.
* **Kein Kursrisiko-Modell.** Es gibt keine Korrelations-, Volatilitäts- oder
  Portfoliooptimierung. Die Guardrails sind absichtlich stumpf und deshalb verlässlich.

---

## 9. Haftungsausschluss

Dies ist Software zu Lern- und Experimentierzwecken, **keine Anlageberatung**. Wer die
Guardrails aufweicht, den Kill-Switch entfernt oder einen Live-Broker anschließt, handelt
auf eigenes Risiko. Vor jedem Schritt Richtung echtem Geld: Kapitel 11 im Handbuch
(Sicherheits-Checkliste) durcharbeiten.
