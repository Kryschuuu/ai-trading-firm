# Remediation-Tracking — Architektur- & Security-Audit 2026-10-27

- **Audit:** [`../README.md`](../README.md) · **Vollbericht:** [`../report.md`](../report.md) · **Prompts:** [`../prompts/README.md`](../prompts/README.md)
- **Prüfbasis:** `main` @ `123a876c8d2bb74d8741907b34523fb789e16bcf` · Code-Version **0.17.2**
- **Stand:** 2026-10-27 · **15 Findings:** 13 `OPEN`, 2 `FIXED` (`ASA-01` … `ASA-15`)
- **Konvention:** 1 Prompt = 1 fokussierte Coding-Session + eigener PR; nach Merge Status hier, in `../findings/ASA-*.md`, in `../README.md` und bei `CRITICAL`/`HIGH` in `../../../security/README.md` nachziehen. Finding-IDs bleiben unverändert.

## Statusübersicht

| ID | Severity | Titel | Status | Session-Prompt | PR / Commit | Verifiziert |
|----|----------|-------|--------|----------------|-------------|-------------|
| [ASA-01](../findings/ASA-01-multiprocess-split-brain-kill-switch-pnl.md) | CRITICAL | Multi-Prozess-Split-Brain: `PaperBroker`, Kill-Switch und `realizedPnl = 0` | `FIXED` | [PROMPT-ASA-P0-01](../prompts/PROMPT-ASA-P0-01-multiprocess-ledger-killswitch-pnl.md) | [PR #246](https://github.com/Kryschuuu/ai-trading-firm/pull/246) | `tests/asa01.multiprocessKillAndPnl.test.ts` |
| [ASA-02](../findings/ASA-02-lifecycle-role-spoofing-four-eyes-live-kill.md) | CRITICAL | `x-admin-token`-Rollen-Spoofing, Vier-Augen-Bypass & Live-Kill-AuthZ | `FIXED` | [PROMPT-ASA-P0-02](../prompts/PROMPT-ASA-P0-02-lifecycle-authz-foureyes-livekill.md) | [PR #247](https://github.com/Kryschuuu/ai-trading-firm/pull/247) | `tests/asa02.lifecycleAndLiveKillAuthz.test.ts` |
| [ASA-03](../findings/ASA-03-alpaca-fail-open-positions-verify-flat.md) | CRITICAL | Alpaca-Live-Adapter Fail-Open (`safeGetPositions` / `verifyFlat` / 429) | `OPEN` | [PROMPT-ASA-P0-03](../prompts/PROMPT-ASA-P0-03-alpaca-failclosed-and-429-backoff.md) | — | — |
| [ASA-04](../findings/ASA-04-micro-executor-cooldown-burst-runtime-rules.md) | HIGH | `MicroExecutor` Cooldown-Reset (30 s), Tick-Burst-Race & fehlendes Feed-Hot-Subscribe | `OPEN` | [PROMPT-ASA-P1-04](../prompts/PROMPT-ASA-P1-04-micro-executor-cooldown-burst-hotreload.md) | — | — |
| [ASA-05](../findings/ASA-05-unauthenticated-get-routes-dead-rbac-error-leaks.md) | HIGH | Offene sensitive GET-Routen, 7 tote RBAC-Permissions & `e.message`-Leaks | `OPEN` | [PROMPT-ASA-P1-05](../prompts/PROMPT-ASA-P1-05-api-rbac-sec02-csrf-error-redaction.md) | — | — |
| [ASA-06](../findings/ASA-06-portfolio-dos-live-gate-audit-chain-split.md) | HIGH | Event-Loop-DoS auf `/api/portfolio/optimize` & `LiveGateAudit`-Kettenbruch | `OPEN` | [PROMPT-ASA-P1-06](../prompts/PROMPT-ASA-P1-06-portfolio-dos-and-livegate-audit-sync.md) | — | — |
| [ASA-07](../findings/ASA-07-missing-session-csrf-and-write-rate-limits.md) | HIGH | Fehlender Session-CSRF-Guard in `guardWrite` & fehlende Write-Rate-Limits | `OPEN` | [PROMPT-ASA-P1-05](../prompts/PROMPT-ASA-P1-05-api-rbac-sec02-csrf-error-redaction.md) | — | — |
| [ASA-08](../findings/ASA-08-trusted-proxy-x-verified-ip-0000-bypass.md) | HIGH | `X-Verified-IP`-Spoofing bei `TRUSTED_PROXY_IPS` + `0.0.0.0`-Bind | `OPEN` | [PROMPT-ASA-P1-07](../prompts/PROMPT-ASA-P1-07-client-ip-proxy-trust-and-bind-hardening.md) | — | — |
| [ASA-09](../findings/ASA-09-historical-store-oom-utf8-lost-update.md) | HIGH | `HistoricalStore` Voll-Scan, UTF-8-Chunk-Split, V8-String-Crash & Lost Updates | `OPEN` | [PROMPT-ASA-P1-08](../prompts/PROMPT-ASA-P1-08-historical-store-partitioning-and-streaming.md) | — | — |
| [ASA-10](../findings/ASA-10-llm-fallback-blind-long-and-drawdown-alert-units.md) | MEDIUM | Deterministischer LLM-Fallback kauft `LONG`; Drawdown-Alerts vergleichen `0..1` mit `5/10/20` | `OPEN` | [PROMPT-ASA-P2-09](../prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md) | — | — |
| [ASA-11](../findings/ASA-11-core-db-indexes-unbounded-scans-pool-timeout.md) | MEDIUM | Fehlende Sekundärindizes auf Kerntabellen, unbegrenzte Loads & `statement_timeout` | `OPEN` | [PROMPT-ASA-P2-09](../prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md) | — | — |
| [ASA-12](../findings/ASA-12-unbounded-memory-maps-dead-session-prune.md) | MEDIUM | Unbegrenzte Rate-Limit-/Order-Maps & nie aufgerufenes `pruneRevokedSessions()` | `OPEN` | [PROMPT-ASA-P2-09](../prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md) | — | — |
| [ASA-13](../findings/ASA-13-state-registry-drift-dashboard-god-component.md) | MEDIUM | 34 unregistrierte `globalThis`-Singletons & `FirmDashboard.tsx` Polling-Reset | `OPEN` | [PROMPT-ASA-P2-10](../prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md) | — | — |
| [ASA-14](../findings/ASA-14-systemd-micro-executor-hardening.md) | LOW | `deploy/micro-executor.service` ohne `systemd`-Sandboxing & mit Pfad-Drift | `OPEN` | [PROMPT-ASA-P2-10](../prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md) | — | — |
| [ASA-15](../findings/ASA-15-alert-sinks-sync-io-webhook-ssrf.md) | LOW | Synchrone Datei-I/O in `FileAlertSink` & fehlender SSRF-Schutz in `WebhookAlertSink` | `OPEN` | [PROMPT-ASA-P2-10](../prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md) | — | — |

## Abgeschlossene Remediation ASA-02 (2026-10-27)

- **Auth/Identität:** `resolveAuth()` liefert jetzt zusätzlich `auth.principal` mit HMAC-Fingerprint (`src/auth/principal.ts`); `actorAuditId()` akzeptiert den verifizierten Principal. `POST /api/firm/lifecycle` ignoriert `x-admin-token` vollständig und leitet Rolle/Audit-ID ausschließlich aus `auth.principal` ab.
- **Vier-Augen:** `src/lib/fourEyesApproval.ts` (15-Minuten-TTL, `approvalId`, 2 getrennte Requests/Principals, `local-open` fail-closed). Lifecycle: `propose` → `approve`; Live-Gate: principal-gebundener 2-Schritt-Flow im Venue-State-File inkl. Audit `four-eyes-second`.
- **Kill-Switch:** `GET /api/live/kill` gibt eine 60-s-Einmal-Nonce (`src/lib/killSwitchNonce.ts`) aus; `POST` trennt `arm` (`firm.kill`, Operator + Admin) und `clear` (`live.gate` + `consumeKillNonce`, nur Admin). Bounded JSON-Body (8 KiB), Audit-Akteur aus `auth.principal`.
- **Verifikation:** `npx tsx --test tests/asa02.lifecycleAndLiveKillAuthz.test.ts` (12/12 grün), `npm run typecheck`, `npm run lint`, `npm run docs:inventories && npm run docs:inventories:check`, `npm run docs:validate`, `npm test`.
- Betroffene Bestandstests migriert: `tests/liveGate.api.test.ts` (Nonce für `clear`), `tests/liveGate.states.test.ts` (Principal-IDs statt Freitextnamen).
- **Required Check nachgezogen (2026-10-27):** Der merge-blockierende Job
  `security-live-gate` maß Coverage ohne `--enable-source-maps` und meldete
  nach dem neuen Vier-Augen-Code fälschlich 94,39 % (real 96,32 %). Alle
  Coverage-Skripte tragen jetzt das Flag, `docs:validate` prüft die Invariante,
  `test:security:asa02` hängt die 12 HTTP-Regressionen in den Job ein und
  `tests/liveGate.fourEyes.test.ts` deckt die neuen Gate-Zweige ab. Real
  97,91 % Zeilen — Schwelle 95 % unverändert. Details:
  [`CHANGELOG.md`](../../../../CHANGELOG.md) (Eintrag „security-live-gate
  dauerhaft stabilisiert") und [`docs/LIVE_TRADING.md`](../../../LIVE_TRADING.md)
  §8.

## Empfohlene Abarbeitungsreihenfolge (konfliktfrei nach Dateigrenzen)

```text
Phase P0 — Sofort-Blocker (keine überlappenden Dateien zwischen P0-01, P0-02, P0-03):
  1. PROMPT-ASA-P0-01  → ASA-01  (broker.ts, brokerHydration.ts, monitor.ts, enforcer.ts, firm/kill)
  2. PROMPT-ASA-P0-02  → ASA-02  (firm/lifecycle/route.ts, live/kill/route.ts, live-gate/service.ts)
  3. PROMPT-ASA-P0-03  → ASA-03  (brokers/alpaca/execution.ts, brokers/alpaca/http.ts)

Phase P1 — Hohe Risiken (P1-05 nach P0-02 ausführen, da beide API-Routen berühren; Rest parallelisierbar):
  4. PROMPT-ASA-P1-04  → ASA-04  (lib/microExecutor.ts)
  5. PROMPT-ASA-P1-05  → ASA-05 + ASA-07  (lib/apiAuth.ts, auth/permissions.ts, app/api/**, route-inventory.md)
  6. PROMPT-ASA-P1-06  → ASA-06  (app/api/portfolio/**, live-gate/audit.ts, live-gate/service.ts)
  7. PROMPT-ASA-P1-07  → ASA-08  (lib/clientIp.ts, scripts/auth-boot-guard.ts, package.json, deploy/)
  8. PROMPT-ASA-P1-08  → ASA-09  (lib/marketdata/historicalStore.ts)

Phase P2 — Mittlere & Niedrige Risiken (nach P0/P1):
  9. PROMPT-ASA-P2-09  → ASA-10 + ASA-11 + ASA-12  (ollama.ts, monitor.ts, db/*, drizzle/*, authSession.ts, bitunix/execution.ts)
 10. PROMPT-ASA-P2-10  → ASA-13 + ASA-14 + ASA-15  (stateRegistry.ts, FirmDashboard.tsx, deploy/micro-executor.service, alerts.ts)
```

## Pflicht-Gates vor jedem Merge einer Remediation-Session

1. `npm run typecheck`
2. `npm run lint`
3. `npm run docs:inventories && npm run docs:inventories:check` (sobald API-Routen, Env-Flags oder `src/db/schema.ts` geändert wurden)
4. `npm run docs:validate`
5. Gezielte neue Regressionstests der jeweiligen Session + `npm test`
