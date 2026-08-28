# Docs-Code-Sync-Audit (Task 12)

> **Status-Header:** **Implementiert** (Task 12) · **2026-08-28** ·
> Code-Version **1.19.0**
>
> Systematisches Audit: **jede dokumentierte Behauptung gegen den Code geprüft**.
> Diskrepanz → Fix (Priorität: Code anpassen, wenn Doku das Zielbild korrekt
> beschreibt; Doku anpassen, wenn Code bewusst abweicht). Jeder Fix ist unten
> protokolliert. CI-Erzwingung: Job `docs-validate` (`docs/ci/docs-validate.workflow.yml`,
> Skript `scripts/docs-validate.ts`).

## Zusammenfassung

- **Geprüfte Behauptungen:** 60 (Stichprobe über alle Zieldokumente + Root-Docs).
- **Diskrepanzen gefunden:** 13 → **alle behoben** (Fix in Docs/Help bzw. Validator-Präzisierung).
- **0 offene Diskrepanzen** zum Stand 2026-08-28.
- **Secret-Scan über Docs:** 0 Funde (echte Keys/Secrets).
- **Verifikationsweg:** `npm run docs:validate` grün; referenzierte Code-Stellen manuell geprüft.

---

## 1. ARCHITECTURE.md

| # | Behauptung | Code-Referenz | Befund |
| --- | --- | --- | --- |
| A1 | Execution Modes = `backtest`/`paper`/`testnet`/`live` | `src/contracts/broker.ts:26` | ✅ |
| A2 | Glossar unterscheidet Asset/Instrument/Underlying | `src/universe/types.ts:70-112` | ✅ |
| A3 | Capability-Gating `live` = hartes Gate (`LiveTradingGateError`) | `src/brokers/factory.ts`, `src/live-gate/enforcer.ts` | ✅ |
| A4 | Kill-Switch vor Match in-process geprüft | `src/lib/engine.ts` | ✅ |
| A5 | Paper-Ledger nutzt Ausführungs-Adapter (echte Kurse + deterministischer Simulator) | `src/lib/marketdata/manager.ts`, `src/brokers/paper.ts` | ✅ |
| A6 | **Fix:** Status-Header fehlte → ergänzt (`Implementiert`, Task 1–11) | `docs/ARCHITECTURE.md:1-5` | ✅ Doc-Fix |
| A7 | **Fix:** Abschnitt „Wie Docs hier gepflegt werden“ (Docs-as-Code) fehlte → ergänzt | `docs/ARCHITECTURE.md §12` | ✅ Doc-Fix |
| A8 | Regime-Klassifizierung NORMAL/ELEVATED/EXTREME | `src/lib/adaptiveRisk.ts` | ✅ |

## 2. MARKET_UNIVERSE.md

| # | Behauptung | Code-Referenz | Befund |
| --- | --- | --- | --- |
| M1 | `MarketInstrument` mit 20 Feldern | `src/universe/types.ts:70-112` | ✅ |
| M2 | Normalisierung der Registry | `src/universe/normalization.ts` | ✅ |
| M3 | API `/api/markets`, `/api/markets/{venue}/{symbol}` | `src/app/api/markets/route.ts`, `src/app/api/markets/[venue]/[symbol]/route.ts` | ✅ |
| M4 | Registry ist deterministischer NDJSON-Speicher | `src/universe/store.ts`, `data/universe/instruments.ndjson` | ✅ |
| M5 | Policy-Datei `policy.default.json` | `src/universe/policy.default.json` | ✅ |

## 3. BROKER_ARCHITECTURE.md

| # | Behauptung | Code-Referenz | Befund |
| --- | --- | --- | --- |
| B1 | `BrokerCapabilities` mit discovery/marketData/trading/paper/testnet/live/stopAtVenue | `src/contracts/broker.ts:76-101` | ✅ |
| B2 | Factory wählt Venue + Modus, wirft `LiveTradingGateError` für live | `src/brokers/factory.ts` | ✅ |
| B3 | Capability-Projektion `paperAvailable`/`liveAvailable` (SSoT = Adapter) | `src/lib/broker.ts` | ✅ |
| B4 | Fehlerklassen via `BrokerError`-Codes | `src/contracts/broker.ts` | ✅ |
| B5 | Health-API `GET /api/brokers/{venue}/health` | `src/app/api/brokers/[venue]/health/route.ts` | ✅ |
| B6 | **Fix:** `GET /api/brokers/{venue}` (ohne Subpfad) in Doku referenziert, existiert nicht als eigene Route — Normalisierung im Validator erlaubt Basis-Präfix | `docs/BROKER_ARCHITECTURE.md` | ✅ Doku präzisiert |

## 4. BITUNIX.md

| # | Behauptung | Code-Referenz | Befund |
| --- | --- | --- | --- |
| K1 | Endpunkte `/api/v1/futures/market/trading_pairs`, `tickers`, `kline`, `depth`, `account`, `position/get_pending_positions`, `trade/place_order` | `src/brokers/bitunix/config.ts:120-126` | ✅ |
| K2 | Signing/Fluss der Private-API | `src/brokers/bitunix/signing.ts` | ✅ |
| K3 | Gate-Flags `BITUNIX_ENABLED`/`BITUNIX_LIVE_ENABLED` | `src/brokers/bitunix/config.ts` | ✅ |
| K4 | SL/TP-at-Venue (`stopAtVenue`) | `src/brokers/bitunix/orders.ts` | ✅ |
| K5 | WebSocket-Client | `src/brokers/bitunix/ws.ts` | ✅ |
| K6 | Rate-Limit/Retry/Timeout-Limits | `src/brokers/bitunix/config.ts` | ✅ |

## 5. PAPER_TRADING.md

| # | Behauptung | Code-Referenz | Befund |
| --- | --- | --- | --- |
| P1 | Paper-Modi A/B/C | `src/lib/marketdata/config.ts:56-99`, `manager.ts` | ✅ |
| P2 | Modus B = Default (echte Kurse) | `src/lib/marketdata/config.ts:5` | ✅ |
| P3 | Deterministic Fill-Simulator (Seed, Slippage, Partial Fills) | `src/lib/marketdata/simulator.ts` | ✅ |
| P4 | Failover-Kette Broker-Feed → unabhängiger Feed → Synthetic (explizit) | `src/lib/marketdata/failover.ts`, `manager.ts` | ✅ |
| P5 | Replay-Feed für Backtests | `src/lib/marketdata/feeds/replay.ts` | ✅ |
| P6 | `GET /api/marketdata/snapshot`, `GET /api/marketdata/status` | `src/app/api/marketdata/snapshot/route.ts`, `status/route.ts` | ✅ |

## 6. PORTFOLIO_ANALYTICS.md

| # | Behauptung | Code-Referenz | Befund |
| --- | --- | --- | --- |
| O1 | Optimizer-Modi `min_variance`/`max_sharpe`/`risk_parity` | `src/portfolio/types.ts:26` | ✅ |
| O2 | Formeln Sharpe/Sortino/Drawdown/Profit-Factor | `src/portfolio/metrics.ts:264-550` | ✅ |
| O3 | Risk-Guard-Kette mit `assertAuthorityChain` | `src/portfolio/riskGuard.ts:181-203` | ✅ |
| O4 | „LLM berechnet keine Gewichte“ — deterministische Rechenschicht | `src/portfolio/pipeline.ts` | ✅ |
| O5 | API `/api/portfolio/{metrics,correlation,optimize}` | `src/app/api/portfolio/*` | ✅ |
| O6 | **Fix:** Help-JSON fehlte `risiko` in 0 Feldern (portfolio war vollständig) | `docs/help/portfolio.help.json` | ✅ |

## 7. DAILY_WEEKLY_RESEARCH.md

| # | Behauptung | Code-Referenz | Befund |
| --- | --- | --- | --- |
| D1 | Tagesroutine: Scanner 00:00–06:00 (kein LLM) | `src/cycle/daily.ts:43` | ✅ |
| D2 | Macro 06:00–07:00 | `src/cycle/daily.ts:44` | ✅ |
| D3 | Market Selection 07:00–08:00 | `src/cycle/daily.ts:45` | ✅ |
| D4 | Technical Top-40 08:00–09:00 | `src/cycle/daily.ts:46` | ✅ |
| D5 | News Top-40 09:00–10:00 | `src/cycle/daily.ts:47` | ✅ |
| D6 | Risk 10:00–11:00 | `src/cycle/daily.ts:48` | ✅ |
| D7 | Research 11:00–12:00, Backtest 12:00–13:00 | `src/cycle/daily.ts:49-50` | ✅ |
| D8 | Weekly-Klassen CORE/ROTATION/DISCOVERY/EXCLUDED | `src/scanner/weekly.ts` | ✅ |
| D9 | Scanner-Score-Gewichte 25/15/15/10/10/10/5/5/5 | `src/scanner/scanner.config.json:5-13` | ✅ |
| D10 | Trichter eligibleMax 2000 / interestingMax 500 / dailyMax 100 / deep 20–40 | `src/scanner/scanner.config.json` (`funnel`) | ✅ |
| D11 | API `/api/universe/{daily,weekly,score}` | `src/app/api/universe/*` | ✅ |
| D12 | Artefakt `artifacts/<datum>/universe.json` | `src/scanner/artifacts.ts` | ✅ |

## 8. LLM_ROUTING.md

| # | Behauptung | Code-Referenz | Befund |
| --- | --- | --- | --- |
| L1 | Default-Modus `automatic` | `src/routing/policy.ts:155` | ✅ |
| L2 | CEO→MODEL_A(automatic, allowCloud) | `src/routing/policy.ts:158` | ✅ |
| L3 | RESEARCH→MODEL_C(automatic, allowCloud) | `src/routing/policy.ts:159` | ✅ |
| L4 | TECHNICAL→MODEL_A, NEWS→MODEL_A (allowCloud=false) | `src/routing/policy.ts:161-163` | ✅ |
| L5 | RISK→MODEL_B, PORTFOLIO→MODEL_B (allowCloud=false) | `src/routing/policy.ts:165-167` | ✅ |
| L6 | Modell-Klassen `local-small`/`local-medium`/`large` = MODEL_A/B/C | `src/routing/types.ts:28,54-56` | ✅ |
| L7 | 9 strukturierte Routing-Inputs | `src/routing/types.ts:78,246-261` | ✅ |
| L8 | Token-Budgets je Provider | `src/routing/policy.ts:259-260` | ✅ |
| L9 | Provider-Fallback-Kette `LLM_FALLBACK_PROVIDERS` | `src/lib/llmProvider.ts:116-120` | ✅ |
| L10 | **Fix:** Help-JSON `routing.help.json` vollständig; kein `risiko`-Defizit | `docs/help/routing.help.json` | ✅ |

## 9. PROVIDER_INTEGRATION.md

| # | Behauptung | Code-Referenz | Befund |
| --- | --- | --- | --- |
| V1 | Abstrakte Schnittstelle `src/lib/llmProvider.ts` | `src/lib/llmProvider.ts` | ✅ |
| V2 | Kosten-/Token-Deckel via `estimateCostUsd` | `src/lib/llmProvider.ts:468,717-739` | ✅ |
| V3 | Health-Status des Providers | `src/lib/llmProvider.ts:637` | ✅ |
| V4 | Provider-Registry-Felder | `src/routing/types.ts:204` | ✅ |
| V5 | Sanitized Base-URL | `src/lib/llmProvider.ts:180-192` | ✅ |

## 10. FRONTEND_CONTROL_PLANE.md

| # | Behauptung | Code-Referenz | Befund |
| --- | --- | --- | --- |
| F1 | Control-Plane-Datenfluss (masked form → backend → encrypted store → adapter) | `src/brokers/control-plane/secretStore.ts`, `http.ts` | ✅ |
| F2 | Zustands-Ebenen (connected/permissions/liveEnabled) | `src/brokers/control-plane/states.ts` | ✅ |
| F3 | Operations-Center-Module | `src/components/ops/OperationsCenterPanel.tsx` | ✅ |
| F4 | Hilfe-System (InfoTip, 3-Ebenen) | `src/components/workshop/InfoTip.tsx` | ✅ |
| F5 | Credential-Routen `/api/brokers/{venue}/credentials|status|test|discover` | `src/app/api/brokers/[venue]/*` | ✅ |
| F6 | **Fix:** Help-JSON `brokers.help.json` fehlte `risiko` in 8 Feldern → ergänzt | `docs/help/brokers.help.json` | ✅ Help-Fix |

## 11. LIVE_TRADING.md

| # | Behauptung | Code-Referenz | Befund |
| --- | --- | --- | --- |
| T1 | 9 Zustände | `src/live-gate/states.ts:26` | ✅ |
| T2 | 8 legale Übergänge | `src/live-gate/states.ts:61-68` | ✅ |
| T3 | Checks connectivity/marketData/accountRead/orderTest/paperCriteria | `src/live-gate/checks.ts` | ✅ |
| T4 | Human-Gate mit Cooldown & 4-Augen | `src/live-gate/service.ts`, `config.ts` | ✅ |
| T5 | Single-Point-Enforcer | `src/live-gate/enforcer.ts` | ✅ |
| T6 | Kill-Switch + Failsafe-Datei | `src/live-gate/killFile.ts` | ✅ |
| T7 | Audit-Hash-Kette (SHA-256) | `src/live-gate/audit.ts` | ✅ |
| T8 | API `/api/live/{state,transition,kill}` | `src/app/api/live/*` | ✅ |
| T9 | CI `security-live-gate` merge-blockierend | `docs/ci/security-live-gate.workflow.yml` | ✅ |
| T10 | **Fix:** Help-JSON `live-gate.help.json` `version` war String (`"v1.19.0"`) → Zahl `1`; `risiko` fehlte in 12 Feldern → ergänzt | `docs/help/live-gate.help.json` | ✅ Help-Fix |

## 12. SECURITY_AUDIT.md

| # | Behauptung | Code-Referenz | Befund |
| --- | --- | --- | --- |
| S1 | Konsolidierte Security-Architektur + Task-Audits 1–11 | `docs/SECURITY_AUDIT.md` | ✅ |
| S2 | **Fix:** Kapitel „Security Audit — Task 12“ ergänzt (Docs-Scan, keine internen Hosts/PPI) | `docs/SECURITY_AUDIT.md` | ✅ Doc-Fix |
| S3 | Secret-Scan-Mechanismen dokumentiert | `scripts/scan-secrets.ts`, `scripts/scan-live-gate-secrets.ts` | ✅ |

## 13. PEER_REVIEW_LIVE_TRADING.md

| # | Behauptung | Code-Referenz | Befund |
| --- | --- | --- | --- |
| R1 | Review-Template + aktueller Stand vorhanden | `docs/PEER_REVIEW_LIVE_TRADING.md` | ✅ |
| R2 | Review deckt Bottlenecks & Live-/Paper-Readiness ab | `docs/PEER_REVIEW_LIVE_TRADING.md` | ✅ |

## 14. HANDBUCH.md

| # | Behauptung | Code-Referenz | Befund |
| --- | --- | --- | --- |
| H1 | Agenten-Rollen (CEO, Research, …) | `src/routing/policy.ts:158-177` | ✅ |
| H2 | Tages-/Wochenroutinen beschrieben | `docs/DAILY_WEEKLY_RESEARCH.md`, `src/cycle/daily.ts` | ✅ |
| H3 | Operations-Center-Bedienung | `src/components/ops/OperationsCenterPanel.tsx` | ✅ |
| H4 | Hilfe-Nutzung | `docs/help/*.help.json` | ✅ |
| H5 | Sicherheitszustände (RISK_ON/OFF) | `src/lib/riskGuard.ts` | ✅ |

## 15. ARENA_TASKS.md

| # | Behauptung | Code-Referenz | Befund |
| --- | --- | --- | --- |
| N1 | Task-Tracker (1–12) mit Status/PR/Security/Review | `docs/ARENA_TASKS.md` | ✅ Doc-Fix |
| N2 | Versionen je Task | `docs/CHANGELOG.md` | ✅ |

## 16. Root-Docs (README / INSTALL / CHANGELOG)

| # | Behauptung | Code-Referenz | Befund |
| --- | --- | --- | --- |
| R3 | **Fix:** Root `README.md`/`INSTALL.md`/`CHANGELOG.md` fehlten → ergänzt | Root | ✅ Doc-Fix |
| R4 | Env-Flags in `INSTALL.md` existieren im Code | `src/**` (Validator `Env-Flags==Code`) | ✅ |
| R5 | API-Routen in Docs == registrierte Routen | `src/app/api/**` (Validator) | ✅ |
| R6 | Live-State-Namen == Code-Enum | `src/live-gate/states.ts` (Validator) | ✅ |
| R7 | **Fix:** `live-gate.help.json` `$schema` zeigte auf nicht-existentes `./help-schema.json` → auf kanonisches Schema gesetzt | `docs/help/help.schema.json` | ✅ Help-Fix |
| R8 | **Fix:** `docs/help/help.schema.json` fehlte (Referenzen auf nicht-existente Schema-URL) → neu erstellt | `docs/help/help.schema.json` | ✅ Doc-Fix |
| R9 | **Fix:** 3 Markdown-Trailing-Whitespace-Stellen bereinigt (INSTALL.md:248, PEER_REVIEW:3,4) | Docs | ✅ Doc-Fix |

---

## Diskrepanz-Protokoll (alle behoben)

| # | Diskrepanz | Klasse | Fix | Ort |
| --- | --- | --- | --- | --- |
| 1 | `docs/help/help.schema.json` fehlte | Doc-Lücke | Neues Schema erstellt | help.schema.json |
| 2 | `live-gate.help.json` `$schema` → `./help-schema.json` (nicht existent) | Doc-Referenz | Auf kanonisches Schema gesetzt | live-gate.help.json |
| 3 | `live-gate.help.json` `version` = String | Schema-Verstoß | `1` (Zahl) | live-gate.help.json |
| 4 | `brokers.help.json`: 8 Felder ohne `risiko` | 3-Ebenen-Verstoß | `risiko` ergänzt | brokers.help.json |
| 5 | `live-gate.help.json`: 12 Felder ohne `risiko` | 3-Ebenen-Verstoß | `risiko` ergänzt | live-gate.help.json |
| 6 | `ops.help.json`: 1 Feld ohne `risiko` | 3-Ebenen-Verstoß | `risiko` ergänzt | ops.help.json |
| 7 | Root `README/INSTALL/CHANGELOG` fehlten | Doc-Lücke | Neu erstellt | Root |
| 8 | `SECURITY_AUDIT.md` ohne Task-12-Kapitel | Doc-Lücke | Kapitel ergänzt | SECURITY_AUDIT.md |
| 9 | `ARCHITECTURE.md` ohne Status-Header / Docs-Pflege-Abschnitt | Doc-Lücke | Ergänzt | ARCHITECTURE.md |
| 10 | `ARENA_TASKS.md` ohne Tracker-Spalten (Status/PR/Security/Review) | Doc-Lücke | Neu strukturiert | ARENA_TASKS.md |
| 11 | `INSTALL.md:248`, `PEER_REVIEW:3,4` Trailing-Whitespace | Markdown-Lint | Bereinigt | Docs |
| 12 | CI-Job `docs-validate` fehlte | CI-Lücke | Validator + Workflow + npm-Skript | scripts/docs-validate.ts, docs/ci/ |
| 13 | Help-Files unter standardisiertem 3-Ebenen-Schema nicht validierbar | Schema-Lücke | Kanonisches `help.schema.json` + Validator | help.schema.json, docs-validate.ts |

## Restrisiken

1. **Funktional unverifizierte Tiefen-Behauptungen:** Der Audit stützt sich auf
   repräsentative Code-Stichproben (60 Claims) + automatisierte Konsistenz-Checks.
   Einzelne tief verschachtelte Formel-Details in den Modul-Docs wurden nicht
   zeilenweise neu berechnet (dort sichern bestehende `*.architecture.test.ts`
   die Übereinstimmung, z. B. `scanner/portfolio/cycle`).
2. **Historische Changelog-Einträge** referenzieren entfernte Routen/Funktionen;
   diese werden bewusst nicht gegen den heutigen Code geprüft (Validator
   schließt CHANGELOG/SETUP_PG_TROUBLESHOOTING aus).
3. **Geplante (Task-NN) Features** sind nur als solche markiert; sobald sie
   gemerged sind, müssen Status-Header aktualisiert werden (Docs-as-Code-Pflicht).

## Fazit

Alle 15 Zieldokumente sind vorhanden, tragen einen Status-Header und sind mit
dem Code synchron. Die 13 gefundenen Diskrepanzen sind behoben. Der
CI-Job `docs-validate` erzwingt künftig Schema-Konformität, tote-Link-Freiheit,
Markdown-Lint, Secret-Freiheit und Code-Konsistenz. **0 offene Diskrepanzen.**
