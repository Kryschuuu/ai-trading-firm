# Architektur-, Sicherheits-, Performance- & Code-Qualitäts-Audit 2026-10-27

## Metadaten

- **Audit-Datum:** 2026-10-27
- **Quelle / Reviewer:** Principal Software Architect & Senior Security Engineer (Arena-Agent-Vollprüfung)
- **Prüfbasis:** `main` @ `123a876c8d2bb74d8741907b34523fb789e16bcf` · Code-Version **v0.17.2 (Beta)**
- **Umfang:** Vollständige Codebasis (`src/auth/*`, `src/lib/*`, `src/app/api/**`, `src/brokers/*`, `src/live-gate/*`, `src/db/*`, `src/execution/*`, `src/copy/*`, `src/portfolio/*`, `src/ops/*`, `src/components/*`, `deploy/*`, `scripts/*`)
- **Status:** **IN ARBEIT** — 15 Befunde (`ASA-01` … `ASA-15`), davon **`ASA-01` + `ASA-02` FIXED**, 13 `OPEN`; gebündelt in 10 kopierfertigen Remediation-Prompts
- **Vollbericht:** [`report.md`](report.md)
- **Copy-&-Paste-Prompts:** [`prompts/README.md`](prompts/README.md)
- **Tracking:** [`remediation/TRACKING.md`](remediation/TRACKING.md)

## Severity-Übersicht

| Severity | Anzahl | Offen | In Arbeit | Gefixt |
|----------|--------|-------|-----------|--------|
| CRITICAL | 3 | 2 | 0 | 1 |
| HIGH | 6 | 6 | 0 | 0 |
| MEDIUM | 4 | 4 | 0 | 0 |
| LOW | 2 | 2 | 0 | 0 |
| **Summe** | **15** | **14** | **0** | **1** |

## Executive Summary

Das System besitzt in mehreren Kernmodulen bereits eine reife Härtung — darunter konstante Zeitvergleiche (`src/lib/tokenCompare.ts`), AES-256-GCM mit sauberer Nonce-/Tag-Prüfung (`src/brokers/control-plane/secretStore.ts`), HMAC-signierte Sessions mit Path-Scoping (`src/lib/authSession.ts`), Append-Only-Trigger mit Advisory-Locks (`src/execution/store.ts`, `src/copy/store.ts`), AST-basierte Regelkompilierung ohne `eval` (`src/strategies/compiler.ts`) sowie XSS-gehärtetes Docs-Rendering (`src/components/docs/DocsMarkdown.tsx`).

Die kritischsten Risiken entstehen an den **Prozess-, Autorisierungs- und Venue-Fehlergrenzen**:

1. **Multi-Prozess-Split-Brain (`ASA-01`, CRITICAL — `FIXED`):** `Next.js` und `micro-executor` hielten getrennte RAM-Singletons für Paper-Ledger, Kill-Switch und Live-Gate; behoben durch das autoritative Fail-Closed-Kill-Switch-Gate (`src/lib/killSwitchDb.ts`, `LISTEN/NOTIFY firm_control_changed`), Cross-Prozess-Reconcile (`syncPaperBrokerWithDb`) und deterministische Close-Abrechnung (`computePaperClosePnl`).
2. **Governance- & Kill-Switch-AuthZ (`ASA-02`, CRITICAL — `FIXED`):** `POST /api/firm/lifecycle` vergab die Admin-Rolle allein anhand der bloßen Header-Existenz `Boolean(req.headers.get("x-admin-token"))`; Vier-Augen-Prüfungen vertrauten auf ungebundene Body-Strings (`approvedBy`); `POST /api/live/kill` nutzte `live.gate` statt `firm.kill` und ignorierte `consumeKillNonce` beim Entschärfen. Behoben durch `auth.principal`-Rollenbindung, 2-Request-/2-Principal-Vier-Augen-Freigaben (15 min TTL, `local-open` fail-closed) sowie Aktionssplit + Einmal-Nonce beim Live-Kill-Switch — Details im [Finding](findings/ASA-02-lifecycle-role-spoofing-four-eyes-live-kill.md).
3. **Fail-Open im Alpaca-Live-Adapter (`ASA-03`, CRITICAL):** `safeGetPositions()` schluckt API-/429-Fehler zu `[]`, wodurch `getAccount()` `openPositions: 0` meldet, `closeAllPositions()` den Notfall-Close überspringt und `verifyFlat()` fälschlich `true` bestätigt.

## Verifizierte saubere Module (Positivbefunde)

- **Kryptographie & Secret-Handling:** `src/lib/tokenCompare.ts` (SHA-256-normalisiertes `timingSafeEqual`), `src/brokers/control-plane/secretStore.ts` (AES-256-GCM, 96-Bit-IV, 128-Bit-Auth-Tag, strikte Hex-Key-Prüfung).
- **Session-Kryptographie & Browser-Client:** `src/lib/authSession.ts` (HMAC-SHA256, `HttpOnly`, `SameSite=Strict`, `Path=/api`) und `src/lib/apiClient.ts` (automatisches Double-Submit-CSRF + 401-Refresh-Mutex).
- **Append-Only-Stores & Transaktions-Locks:** `src/execution/store.ts`, `src/execution/twap/store.ts`, `src/copy/store.ts`, `src/executionQuality/store.ts` (`pg_advisory_xact_lock`, DB-Trigger gegen Mutation).
- **LISTEN/NOTIFY-Reconnect & AST-Compiler:** `src/lib/tradeRulesNotificationListener.ts` (dedizierter Client + Backoff + Snapshot-Fallback), `src/strategies/compiler.ts` (deterministischer AST ohne `eval`/`new Function`), `src/lib/engine.ts` (`withPipelineLock`).
- **Bitunix-Signierung & Docs-XSS-Schutz:** `src/brokers/bitunix/signing.ts`, `src/brokers/bitunix/http.ts`, `src/lib/docsCatalog.ts`, `src/components/docs/DocsMarkdown.tsx`, `src/app/layout.tsx`.

## Befundliste (Findings-Index)

| ID | Severity | Titel | Bereich | Status | Prompt |
|----|----------|-------|---------|--------|--------|
| [ASA-01](findings/ASA-01-multiprocess-split-brain-kill-switch-pnl.md) | CRITICAL | Multi-Prozess-Split-Brain: `PaperBroker`, Kill-Switch und `realizedPnl = 0` divergieren zwischen Web-Server und `micro-executor` | Architektur / Konsistenz | `FIXED` | [P0-01](prompts/PROMPT-ASA-P0-01-multiprocess-ledger-killswitch-pnl.md) |
| [ASA-02](findings/ASA-02-lifecycle-role-spoofing-four-eyes-live-kill.md) | CRITICAL | Rollen-Spoofing per `x-admin-token`, umgehbares Vier-Augen-Prinzip und gebrochene Kill-Switch-Autorisierung | Sicherheit (AuthZ) | `FIXED` | [P0-02](prompts/PROMPT-ASA-P0-02-lifecycle-authz-foureyes-livekill.md) |
| [ASA-03](findings/ASA-03-alpaca-fail-open-positions-verify-flat.md) | CRITICAL | Alpaca-Live-Adapter ist bei Positionsabfragen Fail-Open (`safeGetPositions` liefert `[]`, `verifyFlat()` meldet fälschlich `true`) | Sicherheit / Live-Execution | `OPEN` | [P0-03](prompts/PROMPT-ASA-P0-03-alpaca-failclosed-and-429-backoff.md) |
| [ASA-04](findings/ASA-04-micro-executor-cooldown-burst-runtime-rules.md) | HIGH | `MicroExecutor` verliert alle 30 s Cooldowns, feuert doppelt bei Tick-Bursts und abonniert neue Symbole zur Laufzeit nicht | Architektur / Handelslogik | `OPEN` | [P1-04](prompts/PROMPT-ASA-P1-04-micro-executor-cooldown-burst-hotreload.md) |
| [ASA-05](findings/ASA-05-unauthenticated-get-routes-dead-rbac-error-leaks.md) | HIGH | Unauthentifizierte sensitive GET-Routen (SEC-02-Lücken), 7 tote RBAC-Permissions und ungefilterte `e.message`-Leaks | Sicherheit (AuthZ / Info-Leak) | `OPEN` | [P1-05](prompts/PROMPT-ASA-P1-05-api-rbac-sec02-csrf-error-redaction.md) |
| [ASA-06](findings/ASA-06-portfolio-dos-live-gate-audit-chain-split.md) | HIGH | Event-Loop-DoS auf `/api/portfolio/optimize` und Prozess-Divergenz in der `LiveGateAudit`-Hash-Kette | Performance / Integrität | `OPEN` | [P1-06](prompts/PROMPT-ASA-P1-06-portfolio-dos-and-livegate-audit-sync.md) |
| [ASA-07](findings/ASA-07-missing-session-csrf-and-write-rate-limits.md) | HIGH | Fehlender CSRF-Schutz auf zentralen mutierenden Endpunkten (`guardWrite`) sowie fehlende Write-Rate-Limits | Sicherheit (CSRF / DoS) | `OPEN` | [P1-05](prompts/PROMPT-ASA-P1-05-api-rbac-sec02-csrf-error-redaction.md) |
| [ASA-08](findings/ASA-08-trusted-proxy-x-verified-ip-0000-bypass.md) | HIGH | IP-Spoofing über `X-Verified-IP`, sobald `TRUSTED_PROXY_IPS` gesetzt ist und Next.js auf `0.0.0.0:3369` lauscht | Sicherheit (Netzwerk / Rate-Limit) | `OPEN` | [P1-07](prompts/PROMPT-ASA-P1-07-client-ip-proxy-trust-and-bind-hardening.md) |
| [ASA-09](findings/ASA-09-historical-store-oom-utf8-lost-update.md) | HIGH | `HistoricalStore` parst gesamte NDJSON-Historie pro Query, korrumpiert UTF-8 an 1-MiB-Grenzen und verliert Cross-Prozess-Writes | Performance / Datenintegrität | `OPEN` | [P1-08](prompts/PROMPT-ASA-P1-08-historical-store-partitioning-and-streaming.md) |
| [ASA-10](findings/ASA-10-llm-fallback-blind-long-and-drawdown-alert-units.md) | MEDIUM | Deterministischer LLM-Fallback eröffnet bei Modell-Ausfall blind `LONG`-Trades; Drawdown-Alerts vergleichen `0..1` mit `5/10/20` | Code-Qualität / Handelslogik | `OPEN` | [P2-09](prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md) |
| [ASA-11](findings/ASA-11-core-db-indexes-unbounded-scans-pool-timeout.md) | MEDIUM | Fehlende Sekundärindizes auf hochfrequenten Kerntabellen, unbegrenzte Full-Table-Loads und fehlendes `statement_timeout` | Performance / Datenbank | `OPEN` | [P2-09](prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md) |
| [ASA-12](findings/ASA-12-unbounded-memory-maps-dead-session-prune.md) | MEDIUM | Unbegrenzte In-Memory-Maps, nie aufgerufenes `pruneRevokedSessions()` und nicht persistierte Session-Revocation | Performance / Zuverlässigkeit | `OPEN` | [P2-09](prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md) |
| [ASA-13](findings/ASA-13-state-registry-drift-dashboard-god-component.md) | MEDIUM | 34 verstreute `globalThis`-Singletons umgehen `stateRegistry.ts`; `FirmDashboard.tsx` (1.934 Zeilen) triggert Polling-Resets | Architektur & Wartbarkeit | `OPEN` | [P2-10](prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md) |
| [ASA-14](findings/ASA-14-systemd-micro-executor-hardening.md) | LOW | `deploy/micro-executor.service` fehlt jegliches `systemd`-Sandboxing und weicht bei Pfaden/User von der Haupt-Unit ab | Sicherheit / Betrieb | `OPEN` | [P2-10](prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md) |
| [ASA-15](findings/ASA-15-alert-sinks-sync-io-webhook-ssrf.md) | LOW | Synchrone Datei-I/O in `FileAlertSink` und unvalidierte Ziel-URLs (`http://`, Loopback, Link-Local) in `WebhookAlertSink` | Sicherheit / Performance | `OPEN` | [P2-10](prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md) |

## Remediation-Fahrplan (10 Sessions)

Die 15 Befunde sind in **10 konfliktfreie, direkt kopierbare Coding-Prompts** unter [`prompts/`](prompts/README.md) aufgeteilt:

- **Phase P0 (Sofort / Live- & Paper-Blocker):** `PROMPT-ASA-P0-01` (`ASA-01`), `PROMPT-ASA-P0-02` (`ASA-02`), `PROMPT-ASA-P0-03` (`ASA-03`)
- **Phase P1 (Vor jedem Mehrbenutzer-/Netzwerkbetrieb):** `PROMPT-ASA-P1-04` (`ASA-04`), `PROMPT-ASA-P1-05` (`ASA-05` + `ASA-07`), `PROMPT-ASA-P1-06` (`ASA-06`), `PROMPT-ASA-P1-07` (`ASA-08`), `PROMPT-ASA-P1-08` (`ASA-09`)
- **Phase P2 (Stabilität, Skalierung & Wartbarkeit):** `PROMPT-ASA-P2-09` (`ASA-10` + `ASA-11` + `ASA-12`), `PROMPT-ASA-P2-10` (`ASA-13` + `ASA-14` + `ASA-15`)
