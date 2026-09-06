# Autonome KI-Trading-Firma — Dokumentation

Ein lauffähiges Referenz-Setup für ein Team spezialisierter KI-Agenten (CEO, Research, Backtest, Risk, Approver, Executor), das ein Handelsziel autonom bearbeitet — komplett auf eigener Hardware, mit einer **abstrakten LLM-Provider-Schicht** (Ollama, jeder OpenAI-kompatible Endpunkt wie `llama.cpp`/LM Studio/vLLM, Google Gemini, Anthropic Claude), **PostgreSQL** als institutionellem Gedächtnis und **harten Risikogrenzen im Code**.

> **Wichtig:** Das System läuft ausschließlich im **Paper-Trading-Modus**. Es gibt keinen Live-Broker-Adapter im Auslieferungszustand. Kein echtes Geld ist im Spiel — genau so soll man anfangen.

**Version:** `v1.36.30` (siehe `package.json` + [../CHANGELOG.md](../CHANGELOG.md)).
**Security-Upgrade v1.36.27:** SEC-01 ist behoben. Produktion mit Tokens benötigt
ein unabhängiges `FIRM_SESSION_SECRET`; alle Instanzen neu starten und erneut
anmelden. [Konfiguration und Migration](../CONFIGURATION.md#session-sicherheit-sec-01-v13627).

**Security-Upgrade v1.36.28:** SEC-03 ist behoben: Next.js 16.3.4 und gepatchte
native Bildverarbeitung. Für Linux und Windows: `npm ci`,
`npm run test:security:next`, frischer Build und Neustart aller Instanzen.
[Upgrade-Runbook](security/README.md#nextjs-upgrade-sec-03).

**Security-Upgrade v1.36.30:** SEC-04 ist behoben: `ws` exakt auf 8.21.3 gepinnt
(inklusive transitiver Kopien), der Bitunix-WebSocket-Client verbindet nur mit
gepatchter Bibliothek und kappt Nachrichtengrößen hart. `npm ci`,
`npm run test:security:ws`, Neustart aller Prozesse.
[Upgrade-Runbook](security/README.md#ws-upgrade-sec-04).

Alle Dokumente sind im laufenden System auch unter **`/docs`** im Browser lesbar (kanonische URLs `/docs/<Datei>.md`).

---

## Inhaltsverzeichnis — Neue Struktur (2026-09-05)

### Top-Level Dokumente (aktive Doku)

| Dokument | Zweck |
|----------|-------|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | Blaupause: Event-Driven **Makro-/Mikro-Zyklen**, Regelformat, Latenz, Skalierung, Security |
| **[INSTALL.md](INSTALL.md)** | Installation Schritt für Schritt auf CachyOS, beide Varianten A/B |
| **[INSTALL-WINDOWS.md](INSTALL-WINDOWS.md)** | Windows-Installation mit PowerShell-One-Liner, PostgreSQL, Ollama, Workarounds |
| **[CONFIGURATION.md](../CONFIGURATION.md)** | Env-Flags mit sicheren Defaults — verbindliche Flag-Referenz (ehemals Root `INSTALL.md`) |
| **[HANDBUCH.md](HANDBUCH.md)** | Bedienung, Beispiele, Runbooks, Troubleshooting, Agenten-Register |
| **[BROKER_ARCHITECTURE.md](BROKER_ARCHITECTURE.md)** | Broker-Capability-Modell: Adapter-Vertrag, Capability-Matrix, Execution Modes, Factory, Live-Gate, Health-API |
| **[MARKET_DATA_PIPELINE.md](MARKET_DATA_PIPELINE.md)** | MarketDataSyncService + `npm run market:sync`: Discovery, Enrichment, Candle-Backfill, Gates, Limits |
| **[LIVE_TRADING.md](LIVE_TRADING.md)** | Live-Trading-Gate (Task 11): State-Machine, Enforcement, Kill-Switch, Audit-Kette, CI |
| **[PAPER_TRADING.md](PAPER_TRADING.md)** | Paper-Market-Data: Modi A/B/C, deterministischer Fill-Simulator, Failover, Replay |
| **[PORTFOLIO_ANALYTICS.md](PORTFOLIO_ANALYTICS.md)** | Portfolio-Analytics: Formelkatalog, Kovarianz/Korrelation, Optimizer, Risk-Guard-Kette |
| **[MARKET_UNIVERSE.md](MARKET_UNIVERSE.md)** | Instrument-Universum: Datenmodell, Registry, Normalisierung, `/api/markets` |
| **[SYMBOLS.md](SYMBOLS.md)** | Venue-aware Symbol-Normalisierung: Kanon ↔ Nativ, Profile, ID-Migration (SYM-007) |
| **[CAPABILITIES.md](CAPABILITIES.md)** | Capability-SSoT: `discovery`, `marketData`, `trading`; `liveTradable` vs `liveAvailable` |
| **[MISSIONS.md](MISSIONS.md)** | Missionen, Markt-Scans & Vorlagen: Typen, Segmente, 18 Vorlagen, Mandatsprüfung |
| **[LLM_ROUTING.md](LLM_ROUTING.md)** | MODEL_ROUTER: Modell-Klassen, Routing-Modi, Eskalation, Budget-Deckel, Audit |
| **[PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md)** | LLM-Provider (Ollama/OpenAI/Gemini/Claude) im Detail |
| **[FRONTEND_CONTROL_PLANE.md](FRONTEND_CONTROL_PLANE.md)** | Control Plane: Brokers & Venues UI, Credential-Manager, Secret-Store |
| **[OPERATIONS.md](OPERATIONS.md)** | Runbook „Funnel ist leer“: Entscheidungsbaum + Ops-Sektion Market Data |
| **[OPERATIONS_CENTER.md](OPERATIONS_CENTER.md)** | Operations Center: Market-Data-Readiness-Diagnose |
| **[HISTORY.md](HISTORY.md)** | Historical Store: Kerzen-Schema v2, Timeframe-Schlüssel, Dedup, Migration |
| **[OBSERVABILITY.md](OBSERVABILITY.md)** | Marktdaten-Fehler: Taxonomie, Metriken, strukturierte Logs, Redaction |
| **[ERROR_HANDLING_MARKETDATA.md](ERROR_HANDLING_MARKETDATA.md)** | Entscheidungsbaum: Werfen vs. Cache vs. `DATA_UNAVAILABLE` |
| **[BITUNIX.md](BITUNIX.md)** | Bitunix-Adapter: 7. Venue, Public REST/WS, Signing, Paper-Modus B, Live-Gate |
| **[ALPACA.md](ALPACA.md)** | Alpaca-Adapter: 8. Venue, US-Aktien/ETFs/Crypto, Paper-API = Testnet |
| **[DAILY_WEEKLY_RESEARCH.md](DAILY_WEEKLY_RESEARCH.md)** | Tages-/Wochen-Research-Pipeline: Scanner, Macro, Market Selection, Technical, News |
| **[SETUP_BUGS.md](SETUP_BUGS.md)** | Setup-Bug-Register: PostgreSQL-Init, Seed/UUID, Broker-Adapter, Build-Warnungen |
| **[SETUP_PG_TROUBLESHOOTING.md](SETUP_PG_TROUBLESHOOTING.md)** | PostgreSQL-Soforthilfe |
| **[ARENA_TASKS.md](ARENA_TASKS.md)** | Übersicht aller Arena-Tasks (01–11) mit Versionen, Umfang, Merge-Status |
| **[DOCS_SYNC_AUDIT.md](DOCS_SYNC_AUDIT.md)** | Docs-Code-Sync-Audit: jede Behauptung gegen Code geprüft |

### Audit & Security — Neue skalierbare Struktur (2026-09-05)

| Verzeichnis | Zweck | Details |
|-------------|-------|---------|
| **[audits/](audits/)** | Zentrale Audit-Verwaltung — alle Audits chronologisch | [README](audits/README.md) erklärt Naming, Workflow, Status-Modell |
| [audits/2026-09-03-peer-review/](audits/2026-09-03-peer-review/) | Senior Peer-Review 2026-09-03 — H1-H10, C1-C4, B1/B2, W1/W2, S1/S2 | CLOSED, alle gefixt v1.36.2–v1.36.24 |
| [audits/2026-09-05-security-review-gpt01/](audits/2026-09-05-security-review-gpt01/) | Security-Audit GPT_01 — SEC-01 bis SEC-10 (Session-Autorisierung, GETs, next/ws, Rule-Audit, Env-Fallback) | SEC-01 FIXED v1.36.27; SEC-03 FIXED v1.36.28; SEC-10 FIXED v1.36.29; SEC-04 FIXED v1.36.30; übrige OPEN |
| [audits/TEMPLATE/](audits/TEMPLATE/) | Vorlage für neuen Audit-Zyklus | Kopieren: `cp -r TEMPLATE YYYY-MM-DD-<quelle>-<name>` |
| **[peer-reviews/](peer-reviews/)** | Peer-Review-Patches — Patch-Vorschläge gesammelt & verknüpft | [README](peer-reviews/README.md) |
| [peer-reviews/2026-08-26-live-trading-readiness/](peer-reviews/2026-08-26-live-trading-readiness/) | Live-/Paper-Trading-Readiness — Bottlenecks, Makro/Mikro, DB-Locks | [review](peer-reviews/2026-08-26-live-trading-readiness/review.md) + [patches](peer-reviews/2026-08-26-live-trading-readiness/patches/) |
| [peer-reviews/2026-08-26-bitunix-execution/](peer-reviews/2026-08-26-bitunix-execution/) | Bitunix-Ausführungs-Refactor — ExecutionPort | [review](peer-reviews/2026-08-26-bitunix-execution/review.md) |
| [peer-reviews/2026-08-26-routing-overrides/](peer-reviews/2026-08-26-routing-overrides/) | Provider/Modell-Overrides — Audit-Härtung | [review](peer-reviews/2026-08-26-routing-overrides/review.md) |
| **[security/](security/)** | Security-Übersicht & Härtung — aggregierte Critical/High Findings | [README](security/README.md) + [SECURITY_AUDIT.md](security/SECURITY_AUDIT.md) |

### Archiv — Historische Dokumente

| Verzeichnis | Zweck |
|-------------|-------|
| **[archive/](archive/)** | Veraltete/historische Docs — nicht Teil des aktiven Katalogs | [README](archive/README.md) |
| [archive/task-plans/](archive/task-plans/) | Task-Implementation-Pläne 03–11 — historisch, aktueller Stand in `ARENA_TASKS.md` |

### Weitere Verzeichnisse

| Verzeichnis | Zweck |
|-------------|-------|
| [ci/](ci/) | CI-Workflows: `docs-validate`, `security-live-gate` |
| [help/](help/) | Help-JSONs für UI: brokers, cycle, live-gate, market-universe, ops, paper-trading, portfolio, routing, scanner, workshop |

**Hinweis Changelog:** Der vollständige Changelog liegt jetzt kanonisch im Root: [../CHANGELOG.md](../CHANGELOG.md). `docs/CHANGELOG.md` ist ein Stub/Weiterleitung, um alte Links nicht zu brechen.

---

## Das Grundprinzip in einem Satz

> **Die KI schlägt vor — der Code entscheidet.**

Ein Agent kann halluzinieren, ein Prompt kann manipuliert werden, ein Modell kann kaputtes JSON liefern. Deshalb liegt **jede** Sicherheitsgrenze außerhalb der Agentenlogik, in kompiliertem Code, den kein Modell zur Laufzeit ändern kann.

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

## Architektur (Kurzfassung)

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

**Die Kernidee (v1.6):** Die LLMs rechnen **vor** (Makro: 1×/h), nicht **mit** (Mikro: jeder Tick). Verbunden nur über ein versioniertes, validiertes Regelwerk in `trade_rules` — keine lineare Pipeline, keine LLM-Latenz im Ausführungspfad. Details: [ARCHITECTURE.md](ARCHITECTURE.md).

**Institutionelles Gedächtnis** = `agent_messages` + `audit_log` + `proposals` in PostgreSQL.

---

## Schnellstart

Ausführlich in [INSTALL.md](INSTALL.md). Kurzfassung:

```bash
# 1. Abhängigkeiten
sudo pacman -S --needed nodejs npm postgresql git

# 2. Datenbank starten
sudo systemctl enable --now postgresql

# 3. Projekt
git clone <dein-repo> ai-trading-firm && cd ai-trading-firm
npm ci
cp .env.example .env        # DATABASE_URL prüfen
npx drizzle-kit push        # Tabellen anlegen

# 4. Modell holen (Variante A)
ollama pull qwen2.5:3b-instruct-q4_K_M

# 5. Bauen und starten
npm run build && npm run start
```

Dann `http://localhost:3369` öffnen → **„Seed / Reset“** klicken → **„▶▶ Ganze Pipeline“**.

---

## Projektstruktur (aktualisiert 2026-09-05)

```
├── README.md                 ← Projekt-README (GitHub-Einstieg)
├── CHANGELOG.md              ← Kanonischer Changelog (Keep a Changelog, Root)
├── CONFIGURATION.md          ← Env-Flags mit Defaults (ehemals Root INSTALL.md)
├── INSTALL.md                ← Wrapper: zeigt auf docs/INSTALL.md + CONFIGURATION.md
├── docs/
│   ├── README.md             ← diese Datei (Doku-Index)
│   ├── INSTALL.md            ← CachyOS-Installation A+B (kanonisch)
│   ├── CHANGELOG.md          ← Stub → ../CHANGELOG.md
│   ├── ARCHITECTURE.md, HANDBUCH.md, ...
│   ├── audits/               ← NEU: alle Audits chronologisch
│   │   ├── README.md         ← erklärt Naming, Workflow, Status-Modell
│   │   ├── TEMPLATE/         ← Vorlage für neuen Audit
│   │   ├── 2026-09-03-peer-review/  ← Peer-Review-Audit (CLOSED)
│   │   └── 2026-09-05-security-review-gpt01/  ← Security-Audit (SEC-01/03/10/04 FIXED bis v1.36.30; übrige OPEN)
│   ├── peer-reviews/         ← NEU: Peer-Review-Patches gesammelt
│   │   ├── README.md
│   │   ├── 2026-08-26-live-trading-readiness/
│   │   ├── 2026-08-26-bitunix-execution/
│   │   └── 2026-08-26-routing-overrides/
│   ├── security/             ← NEU: Security-Übersicht
│   │   ├── README.md
│   │   └── SECURITY_AUDIT.md
│   ├── archive/              ← NEU: historische Docs
│   │   └── task-plans/
│   ├── ci/
│   └── help/
├── src/
└── ...
```

---

## Migration & Aufräumaktion 2026-09-05

**Ziele:**
- Ordnung schaffen: dediziertes Verzeichnis für Audit-/Security-Findings, skaliert für wiederkehrende Audits
- Neuer Ordner für Peer-Review-Patches mit bidirektionaler Verlinkung
- Doppelte MDs entfernen: `CHANGELOG.md` Duplikat konsolidiert (kanonisch Root), `INSTALL.md` Duplikat geklärt (Root = Wrapper, docs/INSTALL.md = CachyOS-Guide, Flag-Referenz = CONFIGURATION.md)
- Überflüssiges entrümpeln: `task-*.md` → `archive/task-plans/`, `PEER_REVIEW_*.md` → `peer-reviews/*/review.md`, `AUDIT_REMEDIATION_2026-09.md` + `audit-remediation/` → `audits/2026-09-03-peer-review/`
- Verlinkungen aktualisiert und getestet: alle internen Links zeigen auf neue Pfade, `docs-validate` grün
- Langfristige Wartbarkeit: TEMPLATEs, Naming-Konvention `YYYY-MM-DD-<quelle>-<name>`, Status-Modell OPEN/IN_PROGRESS/FIXED/WONTFIX/FALSE_POSITIVE

**Entfernte Duplikate:**
- `docs/CHANGELOG.md` (Duplikat, 5833 Zeilen) → Stub, kanonisch `../CHANGELOG.md`
- `audit-remediation/` (Root, 21 Files) → `docs/audits/2026-09-03-peer-review/findings/`
- `docs/PEER_REVIEW_*.md` (3 Files) → `docs/peer-reviews/*/review.md`
- `docs/AUDIT_REMEDIATION_2026-09.md` → `docs/audits/2026-09-03-peer-review/report.md`
- `docs/task-*.md` (8 Files) → `docs/archive/task-plans/`
- `docs/SECURITY_AUDIT.md` (kopiert nach `security/`, Original entfernt oder als Stub)

Siehe [audits/README.md](audits/README.md) und [peer-reviews/README.md](peer-reviews/README.md) für Details zur neuen Struktur.

---

## Version

`v1.36.28` (siehe `package.json` + [../CHANGELOG.md](../CHANGELOG.md)).
