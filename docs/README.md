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
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | Blaupause: Event-Driven **Makro-/Mikro-Zyklen**, Regelformat, Latenz, Skalierung, Security |
| **[PEER_REVIEW_LIVE_TRADING.md](PEER_REVIEW_LIVE_TRADING.md)** | Peer-Review: Bottlenecks der 6-Agenten-Pipeline, Live-/Paper-Readiness, Code-Review, Tests und Handlungsplan |
| **[PEER_REVIEW_BITUNIX_EXECUTION.md](PEER_REVIEW_BITUNIX_EXECUTION.md)** | Peer-Review: Bitunix-Ausführungs-Refactor (Paper/Broker getrennt, v1.20) |
| **[PEER_REVIEW_ROUTING_OVERRIDES.md](PEER_REVIEW_ROUTING_OVERRIDES.md)** | Peer-Review: Provider/Modell-Overrides, Audit-Härtung, Test-Isolation (v1.22) |
| **[LIVE_TRADING.md](LIVE_TRADING.md)** | Live-Trading-Gate (Task 11): auditierte State-Machine, Enforcement, Kill-Switch, Audit-Kette, CI (v1.19) |
| **[ARENA_TASKS.md](ARENA_TASKS.md)** | Übersicht aller Arena-Tasks (01–11) mit Versionen, Umfang und Merge-Status |
| **[MARKET_UNIVERSE.md](MARKET_UNIVERSE.md)** | Instrument-Universum: Datenmodell, Registry, Normalisierung, `/api/markets` |
| **[SYMBOLS.md](SYMBOLS.md)** | Zentrale, venue-aware Symbol-Normalisierung: Kanon ↔ Nativ, Profile, ID-Migration (SYM-007, v1.28.0) |
| **[CAPABILITIES.md](CAPABILITIES.md)** | Capability-SSoT: `discovery`, `marketData`, `trading`; `liveTradable` (Stammdaten) vs. `liveAvailable` (Laufzeit, CAP-008, v1.28.1) |
| **[MARKET_DATA_PIPELINE.md](MARKET_DATA_PIPELINE.md)** | MarketDataSyncService + `npm run market:sync`: Discovery, Enrichment, Candle-Backfill vor dem Scanner, Gates, Limits, Exit-Codes (v1.24, CLI v1.29) |
| **[OPERATIONS_CENTER.md](OPERATIONS_CENTER.md)** | Operations Center: Market-Data-Readiness-Diagnose — leeren Scanner-Funnel Schritt für Schritt eingrenzen (v1.27) |
| **[OPERATIONS.md](OPERATIONS.md)** | Runbook „Funnel ist leer“: Entscheidungsbaum + Ops-Sektion „Market Data“ oberhalb des Funnels (OPS-011, v1.33) |
| **[HISTORY.md](HISTORY.md)** | Historical Store: Kerzen-Schema v2, Timeframe-Schlüssel, Dedup-Regel, v1→v2-Migration (v1.26) |
| **[MIGRATION_TIMEFRAME_FIELD.md](MIGRATION_TIMEFRAME_FIELD.md)** | Runbook Produktion: Timeframe-Feld nachziehen — Backup, Dry-Run/--apply, Neuaufbau, Validierung, Rollback (v1.26.2) |
| **[OBSERVABILITY.md](OBSERVABILITY.md)** | Marktdaten-Fehler: Taxonomie, Metriken, strukturierte Logs, Redaction (v1.26.3) |
| **[ERROR_HANDLING_MARKETDATA.md](ERROR_HANDLING_MARKETDATA.md)** | Entscheidungsbaum: Werfen vs. Cache vs. `DATA_UNAVAILABLE`, Sync-/Ops-Behandlung (v1.26.3) |
| **[BROKER_ARCHITECTURE.md](BROKER_ARCHITECTURE.md)** | Broker-Capability-Modell (Task 02): Adapter-Vertrag, Capability-Matrix, Execution Modes, Factory, Live-Gate, Health-API |
| **[BITUNIX.md](BITUNIX.md)** | Bitunix-Adapter (Task 07): 7. Venue, Public REST/WS, Signing, Paper-Modus B, Live-Gate |
| **[ALPACA.md](ALPACA.md)** | Alpaca-Adapter (Task 12): 8. Venue, US-Aktien/ETFs/Crypto, Public-Market-Data + Private-Trading-API (Basic-Auth), Testnet = Paper-API, Bracket-Orders (v1.36.0) |
| **[PAPER_TRADING.md](PAPER_TRADING.md)** | Paper-Market-Data (Task 03): Modi A/B/C, deterministischer Fill-Simulator, Failover-Kette, Replay, Historical Store, `/api/marketdata/*` |
| **[PORTFOLIO_ANALYTICS.md](PORTFOLIO_ANALYTICS.md)** | Portfolio-Analytics (Task 05): Formelkatalog, Kovarianz/Korrelation, drei Optimizer-Modi, Risk-Guard-Kette, `/api/portfolio/*` |
| **[INSTALL.md](INSTALL.md)** | Installation Schritt für Schritt auf CachyOS, beide Varianten |
| **[INSTALL-WINDOWS.md](INSTALL-WINDOWS.md)** | Vollständige Windows-Installation mit PowerShell-One-Liner, PostgreSQL, Ollama und Workarounds |
| **[SETUP_BUGS.md](SETUP_BUGS.md)** | Setup-Bug-Register: PostgreSQL-Init, Seed/UUID, Broker-Adapter, Build-Warnungen, API-Token, 18-Check-Validierung, PAPER_MODE-Default (B1–B7) |
| **[MISSIONS.md](MISSIONS.md)** | Missionen, Markt-Scans & Vorlagen: Missions-Typen, neun Marktsegmente, 18 Vorlagen (14 im Seed), Mandatsprüfung (v1.35.0) |
| **[HANDBUCH.md](HANDBUCH.md)** | Bedienung, ausführliche Beispiele, Runbooks, Troubleshooting, Agenten-Register |
| **[CHANGELOG.md](CHANGELOG.md)** | Versionen, Bugfixes und Änderungen je Release |
| **[SECURITY_AUDIT.md](SECURITY_AUDIT.md)** | Findings, Schweregrade, Fixes und Peer-Review |
| **[PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md)** | LLM-Provider (Ollama/OpenAI/Gemini/Claude) im Detail |
| **[LLM_ROUTING.md](LLM_ROUTING.md)** | MODEL_ROUTER (Task 09): Modell-Klassen, Routing-Modi, Eskalation, Budget-Deckel, Audit |
| **[task-10-IMPLEMENTATION_PLAN.md](task-10-IMPLEMENTATION_PLAN.md)** | Operations Center + RBAC (Task 10): Rollen, Phase-Plan (Stand v1.18.0; Nachtrag v1.23.0) |

**Version:** `v1.36.1` (siehe `package.json` + [CHANGELOG.md](CHANGELOG.md)).
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
│  MAKRO-ZYKLUS (langsam, LLM im Hintergrund)                          │
│     macroCycle.ts   CEO + Research → Regeln, 1×/h (Scheduler)        │
│     engine.ts       klassische Pipeline (manuell/Workshop)           │
├──────────────────────────────────────────────────────────────────────┤
│  MIKRO-ZYKLUS (schnell, KEIN LLM) — eigener Prozess `npm run micro`  │
│     microExecutor.ts  WebSocket-Tick → Rolling-Serie → kompilierte   │
│                        Regel (RAM) → Paper-Fill; ~20–100 µs          │
│     ruleEngine.ts      Whitelist-DSL · Validierung · Backtest        │
├──────────────────────────────────────────────────────────────────────┤
│  HARTE GRENZEN    src/lib/riskGuard.ts     ← hier steht die Wahrheit │
│  Broker-Schleuse  src/lib/broker.ts        ← prüft ein zweites Mal   │
│  Provider-Schicht src/lib/llmProvider.ts   ← Ollama · OpenAI · Gemini│
│                    src/lib/ollama.ts       ← Schema, Retry, Fallback │
├──────────────────────────────────────────────────────────────────────┤
│  PostgreSQL + Drizzle    agents · missions · positions · proposals   │
│                          agent_messages · audit_log · kill_switches  │
│                          risk_config · equity_snapshots              │
│                          trade_rules · rule_executions               │
│                          rule_backtests (v1.6)                       │
└──────────────────────────────────────────────────────────────────────┘
```

**Die Kernidee (v1.6):** Die LLMs rechnen **vor** (Makro: 1×/h), nicht **mit**
(Mikro: jeder Tick). Verbunden nur über ein versioniertes, validiertes
Regelwerk in `trade_rules` — keine lineare Pipeline, keine LLM-Latenz im
Ausführungspfad. Details: **[ARCHITECTURE.md](ARCHITECTURE.md)**.

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

# 6. (optional, v1.6) Mikro-Zyklus als eigener Prozess — ohne LLM, pro Tick
npm run micro        # Binance-Feed; MICRO_FEED=sim für Offline-Demo
```

Dann `http://localhost:3369` öffnen → **„Seed / Reset"** klicken → **„▶▶ Ganze Pipeline"**.
Für den event-getriebenen Regelbetrieb: `POST /api/firm/macro` (erzeugt die erste
Regel) — danach übernimmt der Mikro-Executor automatisch (siehe
[HANDBUCH, Kap. 15](HANDBUCH.md)).

**Ohne Modell funktioniert es trotzdem:** Ist kein LLM erreichbar, schaltet das System auf
eine deterministische Regel-Engine um und zeigt „Regel-Engine" in der Statusleiste. Die
komplette Orchestrierung samt Guardrails lässt sich so ohne GPU nachvollziehen — auch
der Makro-Zyklus erzeugt dann deterministische Fallback-Regeln (`sourceMode: FALLBACK`).

---

## 5. Projektstruktur

```
├── docs/
│   ├── README.md                 ← diese Datei (Überblick, Architektur)
│   ├── ARCHITECTURE.md           ← Makro/Mikro-Blaupause (v1.6, neu)
│   ├── INSTALL.md                ← Installation A + B
│   ├── HANDBUCH.md               ← Bedienung, Beispiele, Runbooks, Agenten-Register
│   ├── CHANGELOG.md              ← Versionen & Bugfixes
│   ├── SECURITY_AUDIT.md         ← Audit-Ergebnis & Peer-Review
│   └── PROVIDER_INTEGRATION.md   ← LLM-Provider, Kosten, Retries
├── deploy/
│   ├── ai-trading-firm.service   ← systemd-Unit für den Dienst
│   ├── micro-executor.service    ← systemd-Unit für den Mikro-Zyklus (neu)
│   └── ollama-lan.conf           ← Ollama im LAN freigeben (Variante B)
├── scripts/
│   ├── micro-executor.ts         ← Standalone-Mikro-Zyklus: npm run micro (neu)
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
    │           ├── macro/        ← Makro-Zyklus (CEO+Research) (neu)
    │           ├── micro/        ← Mikro-Executor-Status (neu)
    │           ├── rules/        ← Regelwerk: Liste/Anlage (neu)
    │           ├── rules/[id]/   ← activate/pause/rollback/… (neu)
    │           ├── rules/[id]/backtest ← Historie-Backtest (neu)
    │           ├── report/       ← KPI-Report (GET)
    │           ├── equity/       ← Equity-Kurve (GET)
    │           └── log/          ← Protokoll/Audit (GET)
    ├── db/schema.ts              ← Drizzle-Tabellen (inkl. trade_rules, v1.6)
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
        ├── ruleEngine.ts         ← Regel-DSL, Whitelist, Klemmung, Backtest (neu, LLM-frei)
        ├── ruleService.ts        ← Regel-Persistenz, Versionierung, Rollback (neu, LLM-frei)
        ├── microExecutor.ts      ← Mikro-Zyklus: Feeds, Cache, Hot-Path (neu, LLM-frei)
        ├── macroCycle.ts         ← Makro-Zyklus: CEO+Research erzeugen Regeln (neu)
        ├── workshop.ts           ← Workshop-Validierung: Missionen/Prompts, Trefferquote
        ├── missionTemplates.ts   ← Missions-Typen, 9 Marktsegmente, 18 Vorlagen (v1.35)
        └── missionUniverse.ts    ← Segment → Kandidaten aus der Registry, Mandatsprüfung (v1.35)
```

**Die zwölf Agenten** (von `seed.ts`): Kern-Pipeline Lex (CEO), Rhea
(Research), Milo (Backtest), Rigel (Risk), Vega (Approver), Nova (Executor) —
plus Analysten Kepler (Technical), Cassini (Macro), Hubble (News), Sagan
(Swing), Voyager (Scout), Curie (Diligence). Beschreibungen: **[HANDBUCH, Kap. 16](HANDBUCH.md)**.

---

## 6. Die harten Grenzen (dreistufige Kaskade)

Risikolimits folgen einer **Kaskade** (`src/lib/riskGuard.ts` +
`src/lib/adaptiveRisk.ts`) — nur die äußere Schicht ist hart im Code:

```
1. Code-Ceilings (hartkodiert, Rebuild nötig)   ← LIMIT_CEILINGS: absolutes Fenster
   2. Basis-Limits (runtime, Dashboard/API)      ← risk_config, z. B. maxRiskPerTrade 0.02
      3. adaptiver Marktfaktor (runtime, auto)   ← Volatilität: VIX/ATR/BBW/StdDev → Faktor ∈ (0, 1]
           → wirksames maxRiskPerTrade (alle Order-Pfade)
```

- **Ceilings/Floors** (z. B. `maxRiskPerTrade` ∈ [0.002, 0.05],
  `requireStopLoss` immer an) bleiben bewusst im Code — auch eine
  kompromittierte DB kann sie nicht aufweichen.
- **Basis-Limits** (Auslieferungszustand): `maxPositionPct` 0.25,
  `maxRiskPerTrade` 0.02, `maxConcurrentPositions` 5, `allowShort` false,
  `maxLeverage` 1, `requireStopLoss` true, `maxEquityDrawdownPct` 0.15 —
  zur Laufzeit änderbar im Risk-Tab / via `PUT /api/firm/config`
  (geklemmt, audit-protokolliert, **ohne Neustart**).
- **Adaptives Risk-Limit (v1.7.0):** Das wirksame `maxRiskPerTrade` senkt
  sich automatisch in hochvolatilen Phasen — Regime NORMAL/ELEVATED/EXTREME
  aus **VIX (≥ 30 / ≥ 40, primärer Trigger)**, **ATR % (15-min, > 1 %)**,
  **Bollinger Band Width (> 5 %)** und **Return-StdDev (> 1 %/Kerze)**;
  Standard-Faktoren 0.5 bzw. 0.25 (2 % → 1 % → 0.5 %). Schwellwerte/Faktoren
  (`adp.*`) sind zur Laufzeit konfigurierbar, De-Eskalation mit Hysterese
  gegen Flapping, fehlende Daten sind Fail-Open (Risiko steigt nie).
  Status/Trigger-Events für Agenten & Monitoring:
  `GET /api/firm/risk/volatility` (Details in [HANDBUCH, Kap. 9](HANDBUCH.md)).

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
| `GET` | `/api/firm/log?limit=20&page=2&level=WARN&event=ORDER_REJECTED` | Lesbare Protokoll-Timeline (`entries` inkl. `raw`-DB-Zeile) + gefilterte Turn-Liste (`turns`) + gepagter `audit` + `meta` (Seite, Gesamtzahlen) |
| `PUT` | `/api/firm/config` | Laufzeit-Limit ändern (Limits + Volatilitäts-Parameter `adp.*`, geklemmt) |
| `GET` | `/api/firm/risk/volatility` | Adaptives Risk-System: Regime, wirksames maxRiskPerTrade, Indikatoren, Trigger-Event-Historie |
| `POST` | `/api/firm/risk/volatility` | `{force:true}` — Volatilitäts-Neubewertung sofort erzwingen |
| `GET/POST/PUT` | `/api/firm/missions` | Missionen lesen/anlegen/bearbeiten (Workshop; Missions-Typ + Segment + Vorlagen, Budgets gegen Code-Ceilings) |
| `PUT` | `/api/firm/agents` | `system_prompt` eines Agenten ändern — wirken sofort, Guardrails unberührt |
| `GET/POST` | `/api/firm/rules` | Regelwerk (alle Versionen + Feedback) lesen bzw. validierte Regel anlegen (DRAFT) |
| `POST` | `/api/firm/rules/[id]` | `activate` / `pause` / `archive` / `rollback` / `reject` einer Regel-Version |
| `POST` | `/api/firm/rules/[id]/backtest` | deterministischer Historie-Backtest (ohne LLM), Ergebnis in `rule_backtests` |
| `POST/GET` | `/api/firm/macro` | Makro-Zyklus (CEO + Research) jetzt ausführen / Status |
| `GET` | `/api/firm/micro` | Status des Mikro-Executor-Prozesses + aktive Regeln + letzte Ausführungen |
| `GET` | `/api/docs?name=install` | Markdown-Doku als JSON |

Schreibende Endpunkte (`POST`/`PUT`) werden per `x-firm-token` geschützt, sobald
`FIRM_API_TOKEN` gesetzt ist (siehe `.env.example`).

Beispiele mit `curl` im **[Handbuch, Kapitel 4](HANDBUCH.md)**.

---

## 8. Ehrliche Grenzen dieses Setups

* **Kein Live-Trading.** Paper läuft im Default mit echten Kursen (Modus B) und
  lokalem Fill-Simulator. Live bleibt `LiveTradingGateError` (Task 11).
  Broker-Anbindung: HANDBUCH Kapitel 8 und [BROKER_ARCHITECTURE.md](BROKER_ARCHITECTURE.md).
* **Kein ernsthaftes Backtesting.** Bewusst weggelassen, weil zuerst Paper-Trading zählt.
  Der Backtest-Agent ist als nicht blockierender Platzhalter verdrahtet.
* **Kleine Modelle sind keine Analysten.** 3B–14B lokal ersetzen keine echte Recherche.
  Sie sind gut darin, klar definierte Aufgaben in stabiles JSON zu gießen — und genau
  dafür werden sie hier eingesetzt.
* **Cloud-Anbieter kosten Geld und geben Daten ab.** Die Provider-Schicht kann Gemini/Claude
  als Fallback nutzen (`LLM_FALLBACK_PROVIDERS`) — die Kostenrechnung im Dashboard
  (`estimateCostUsd`) ist eine Schätzung auf Referenzpreisen, keine Abrechnung.
* **Makro ist sequenziell, Mikro ist event-getrieben.** Die klassische Pipeline bleibt
  bewusst sequenziell (keine Race-Conditions an der Broker-Schnittstelle); schnelle
  Ausführung läuft seit v1.6 ausschließlich über den LLM-freien Mikro-Zyklus
  (WebSocket → kompilierte Regel → Fill, ~20–100 µs).
* **Der Mikro-Zyklus ist im Paper-Modus Single-Instance.** Der interne PaperBroker ist
  ein In-Memory-Ledger; die Multi-Instanz-Primitive (Advisory-Lock, UNIQUE-Indizes)
  sind implementiert und greifen, sobald ein echter Broker-Adapter (Alpaca/ccxt) als
  geteilte Zustandsquelle angebunden ist — Details in ARCHITECTURE.md §5.
* **Kein Kursrisiko-Modell auf Order-Ebene.** Seit v1.13 gibt es eine deterministische
  Portfolio-Ebene (`src/portfolio/`: Volatilität, Korrelation/Cluster, drei Optimizer-Modi,
  Risk-Guard-Kette — siehe [PORTFOLIO_ANALYTICS.md](PORTFOLIO_ANALYTICS.md)). Die
  **Order-Guardrails** (`src/lib/riskGuard.ts`) bleiben davon unberührt absichtlich stumpf
  und deshalb verlässlich; die Portfolio-Analytics erzeugen Gewichte, aber keine Orders.

---

## 9. Haftungsausschluss

Dies ist Software zu Lern- und Experimentierzwecken, **keine Anlageberatung**. Wer die
Guardrails aufweicht, den Kill-Switch entfernt oder einen Live-Broker anschließt, handelt
auf eigenes Risiko. Vor jedem Schritt Richtung echtem Geld: Kapitel 11 im Handbuch
(Sicherheits-Checkliste) durcharbeiten.
