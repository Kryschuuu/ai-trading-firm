# Remediation-Tracking — Architektur- & Security-Audit 2026-10-27

- **Audit:** [`../README.md`](../README.md) · **Vollbericht:** [`../report.md`](../report.md) · **Prompts:** [`../prompts/README.md`](../prompts/README.md)
- **Prüfbasis:** `main` @ `123a876c8d2bb74d8741907b34523fb789e16bcf` · Code-Version **0.17.3**
- **Stand:** 2026-10-29 · **15 Findings:** 6 `OPEN`, 9 `FIXED` (`ASA-01` … `ASA-15`)
- **Konvention:** 1 Prompt = 1 fokussierte Coding-Session + eigener PR; nach Merge Status hier, in `../findings/ASA-*.md`, in `../README.md` und bei `CRITICAL`/`HIGH` in `../../../security/README.md` nachziehen. Finding-IDs bleiben unverändert.

## Statusübersicht

| ID | Severity | Titel | Status | Session-Prompt | PR / Commit | Verifiziert |
|----|----------|-------|--------|----------------|-------------|-------------|
| [ASA-01](../findings/ASA-01-multiprocess-split-brain-kill-switch-pnl.md) | CRITICAL | Multi-Prozess-Split-Brain: `PaperBroker`, Kill-Switch und `realizedPnl = 0` | `FIXED` | [PROMPT-ASA-P0-01](../prompts/PROMPT-ASA-P0-01-multiprocess-ledger-killswitch-pnl.md) | [PR #246](https://github.com/Kryschuuu/ai-trading-firm/pull/246) | `tests/asa01.multiprocessKillAndPnl.test.ts` |
| [ASA-02](../findings/ASA-02-lifecycle-role-spoofing-four-eyes-live-kill.md) | CRITICAL | `x-admin-token`-Rollen-Spoofing, Vier-Augen-Bypass & Live-Kill-AuthZ | `FIXED` | [PROMPT-ASA-P0-02](../prompts/PROMPT-ASA-P0-02-lifecycle-authz-foureyes-livekill.md) | [PR #247](https://github.com/Kryschuuu/ai-trading-firm/pull/247) | `tests/asa02.lifecycleAndLiveKillAuthz.test.ts` |
| [ASA-03](../findings/ASA-03-alpaca-fail-open-positions-verify-flat.md) | CRITICAL | Alpaca-Live-Adapter Fail-Open (`safeGetPositions` / `verifyFlat` / 429) | `FIXED` | [PROMPT-ASA-P0-03](../prompts/PROMPT-ASA-P0-03-alpaca-failclosed-and-429-backoff.md) | [PR #248](https://github.com/Kryschuuu/ai-trading-firm/pull/248) | `npx tsx --test tests/asa03.alpacaFailClosed.test.ts`; Alpaca + Broker-Contracts; `npm test` (`BROKER_CONTRACTS_REQUIRE_DB=true` in CI) |
| [ASA-04](../findings/ASA-04-micro-executor-cooldown-burst-runtime-rules.md) | HIGH | `MicroExecutor` Cooldown-Reset (30 s), Tick-Burst-Race & fehlendes Feed-Hot-Subscribe | `FIXED` | [PROMPT-ASA-P1-04](../prompts/PROMPT-ASA-P1-04-micro-executor-cooldown-burst-hotreload.md) | Dieser PR | `tests/asa04.microExecutorConcurrency.test.ts` |
| [ASA-05](../findings/ASA-05-unauthenticated-get-routes-dead-rbac-error-leaks.md) | HIGH | Offene sensitive GET-Routen, 7 tote RBAC-Permissions & `e.message`-Leaks | `FIXED` | [PROMPT-ASA-P1-05](../prompts/PROMPT-ASA-P1-05-api-rbac-sec02-csrf-error-redaction.md) | Dieser PR | `tests/asa05.apiGuardsAndCsrf.test.ts`; security suite |
| [ASA-06](../findings/ASA-06-portfolio-dos-live-gate-audit-chain-split.md) | HIGH | Event-Loop-DoS auf `/api/portfolio/optimize` & `LiveGateAudit`-Kettenbruch | `FIXED` | [PROMPT-ASA-P1-06](../prompts/PROMPT-ASA-P1-06-portfolio-dos-and-livegate-audit-sync.md) | [PR #251](https://github.com/Kryschuuu/ai-trading-firm/pull/251) | `tests/asa06.portfolioLimitsAndAuditSync.test.ts`; `tests/portfolio*.test.ts`; `tests/liveGate*.test.ts` |
| [ASA-07](../findings/ASA-07-missing-session-csrf-and-write-rate-limits.md) | HIGH | Fehlender Session-CSRF-Guard in `guardWrite` & fehlende Write-Rate-Limits | `FIXED` | [PROMPT-ASA-P1-05](../prompts/PROMPT-ASA-P1-05-api-rbac-sec02-csrf-error-redaction.md) | Dieser PR | `tests/asa05.apiGuardsAndCsrf.test.ts`; logout/session regression |
| [ASA-08](../findings/ASA-08-trusted-proxy-x-verified-ip-0000-bypass.md) | HIGH | `X-Verified-IP`-Spoofing bei `TRUSTED_PROXY_IPS` + `0.0.0.0`-Bind | `FIXED` | [PROMPT-ASA-P1-07](../prompts/PROMPT-ASA-P1-07-client-ip-proxy-trust-and-bind-hardening.md) | Dieser PR (v0.17.4) | `tests/asa08.clientIpProxyTrust.test.ts`; `tests/authBootGuard.proxyTrust.test.ts` |
| [ASA-09](../findings/ASA-09-historical-store-oom-utf8-lost-update.md) | HIGH | `HistoricalStore` Voll-Scan, UTF-8-Chunk-Split, V8-String-Crash & Lost Updates | `FIXED` | [PROMPT-ASA-P1-08](../prompts/PROMPT-ASA-P1-08-historical-store-partitioning-and-streaming.md) | Dieser PR (v0.17.5) | `tests/asa09.historicalStoreSafety.test.ts`; `tests/history/historicalStore.test.ts`; `tests/marketdata/historicalStore.test.ts` |
| [ASA-10](../findings/ASA-10-llm-fallback-blind-long-and-drawdown-alert-units.md) | MEDIUM | Deterministischer LLM-Fallback kauft `LONG`; Drawdown-Alerts vergleichen `0..1` mit `5/10/20` | `OPEN` | [PROMPT-ASA-P2-09](../prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md) | — | — |
| [ASA-11](../findings/ASA-11-core-db-indexes-unbounded-scans-pool-timeout.md) | MEDIUM | Fehlende Sekundärindizes auf Kerntabellen, unbegrenzte Loads & `statement_timeout` | `OPEN` | [PROMPT-ASA-P2-09](../prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md) | — | — |
| [ASA-12](../findings/ASA-12-unbounded-memory-maps-dead-session-prune.md) | MEDIUM | Unbegrenzte Rate-Limit-/Order-Maps & nie aufgerufenes `pruneRevokedSessions()` | `OPEN` | [PROMPT-ASA-P2-09](../prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md) | — | — |
| [ASA-13](../findings/ASA-13-state-registry-drift-dashboard-god-component.md) | MEDIUM | 34 unregistrierte `globalThis`-Singletons & `FirmDashboard.tsx` Polling-Reset | `OPEN` | [PROMPT-ASA-P2-10](../prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md) | — | — |
| [ASA-14](../findings/ASA-14-systemd-micro-executor-hardening.md) | LOW | `deploy/micro-executor.service` ohne `systemd`-Sandboxing & mit Pfad-Drift | `OPEN` | [PROMPT-ASA-P2-10](../prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md) | — | — |
| [ASA-15](../findings/ASA-15-alert-sinks-sync-io-webhook-ssrf.md) | LOW | Synchrone Datei-I/O in `FileAlertSink` & fehlender SSRF-Schutz in `WebhookAlertSink` | `OPEN` | [PROMPT-ASA-P2-10](../prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md) | — | — |

## Abgeschlossene Remediation ASA-09 (2026-10-29)

- **Partitionierung:** Kerzen liegen pro `(instrumentId, timeframe)` unter `<dir>/series/<encodedKey>.ndjson` — der Schlüssel wird bijektiv und Path-Traversal-frei percent-kodiert (`:` → `%3A`, `/` → `%2F`; `%` selbst wird mitkodiert). `query()` öffnet und parst ausschließlich die eine Partitionsdatei (`O(N_series)` statt `O(N_all)`); `appendSeries` liest/schreibt nur die berührten Serien. Partitionsdateien sind `ts`-aufsteigend, `from`/`to`/`limit` filtern im Streaming.
- **UTF-8-Streaming:** `readLinesSync(file, chunkSizeBytes?)` dekodiert über `StringDecoder("utf8")` (`decoder.write()` je Block, `decoder.end()` am Ende) — Multi-Byte-Zeichen an Chunk-Grenzen (Default 1 MiB, testbar ab 1 Byte) werden exakt rekonstruiert.
- **Speicherkonstantes Schreiben:** 64-KiB-Bündel direkt über `writeSync(fd)` + `fsyncSync` + `renameSync`; kein Gesamt-`join("\n")` mehr (kein V8-`RangeError`), kollisionsfreie Temp-Namen `.tmp-<pid>-<uuid>` mit `rmSync`-Cleanup im Fehlerfall (auch in `writeStoreSnapshot`).
- **Cross-Prozess-Lock:** `<dir>/.store.lock` (`wx`-Open, Backoff-Retry, Stale-Recovery nach Halter-PID/Alter ≥ 15 s, `LOCK_TIMEOUT` fail-closed, Freigabe nur durch den Halter) um `append`/`appendSeries`/`clear` und die Legacy-Migration.
- **Verlustfreie Auto-Migration:** Bestehende `candles.ndjson` wird beim ersten Zugriff unter Lock in die Serien-Dateien überführt (Dedup `instrumentId+timeframe+ts`, jüngstes `fetchedAt` gewinnt); das Original bleibt byte-exakt als `candles.ndjson.migrated-<stamp>-<uuid>` erhalten (Legacy-v1-Zeilen inklusive, weiter migrierbar via `npm run history:migrate`). Ohne möglicher Migration (read-only) lesen alle Zugriffe die Legacy-Datei transparent weiter. Neue Helfer: `seriesFilePath()`, `listSeries()`, `stats()`, `clear()`.
- **Regressionen:** `npx tsx --test tests/asa09.historicalStoreSafety.test.ts tests/history/historicalStore.test.ts tests/marketdata/historicalStore.test.ts` (34/34 grün); `npm run typecheck`, `npm run lint`, `npm run docs:validate`, `npm test`.
- **Doku:** `docs/HISTORY.md` §2a (Layout/Migration/Backup), `docs/MARKET_DATA_PIPELINE.md`, `README.md`, `docs/security/README.md`, Finding ASA-09 auf `FIXED`.

## Abgeschlossene Remediation ASA-06 (2026-10-28)

- **Portfolio-AuthZ/DoSLimits:** `POST /api/portfolio/{correlation,metrics}` verlangen `firm.read`, `POST /api/portfolio/optimize` `firm.write` — jeweils mit CSRF-Guard und Write-Rate-Limit (`optimize`: 10/min). `PORTFOLIO_API_LIMITS` begrenzt `solver.maxIterations` auf 2.000 (HTTP-Default 400) und `guard.maxAdjustmentRounds` auf 10; Überschreitungen liefern `400 INVALID_INPUT`. Die generierte `docs/generated/route-inventory.md` weist die Routen jetzt als explizit geschützt aus (`REVIEWED_UNGUARDED_WRITES` enthält keine Portfolio-Einträge).
- **Asynchrone Audit-I/O:** `fileAuditSink` schreibt über `node:fs/promises` (serialisierte Promise-Kette, kein `mkdirSync`/`appendFileSync` mehr im Request-Pfad); `writeAuditSnapshot` ist async und atomar (`writeFile` → `rename`).
- **LiveGateAudit Cross-Prozess:** `append()` sperrt `<audit>.lock` (`openSync(…, "wx")`, Stale-Recovery nach 10 s bzw. toter PID), liest nur neue Bytes ab dem bekannten Offset, verifiziert die Verkettung, übernimmt den Dateischwanz als `head` und schreibt erst dann `writeSync` + `fsync`. `verifyAuditChain()` cached über `(size, mtimeMs, ctimeMs, ino)` — `GET /api/live/state` ist bei unveränderter Datei O(1).
- **Regressionen:** `npx tsx --test tests/asa06.portfolioLimitsAndAuditSync.test.ts tests/portfolio*.test.ts tests/liveGate*.test.ts`; `tests/portfolio.api.test.ts` setzt den Rate-Limit-Bucket je Test zurück und wartet bounded auf die asynchrone Audit-Datei.

## Abgeschlossene Remediation ASA-05 + ASA-07 (2026-10-28)

- **API-RBAC:** Alle nicht-öffentlichen API-Handler sind Auth-geschützt. `ops.view`, `firm.config`, `broker.status`, `broker.test`, `routing.read`, `routing.modes.write` und `firm.kill` sind in den vorgesehenen Routen verdrahtet; `firm.config` ist Admin-only. Geschützte GET-Handler setzen `Cache-Control: private, no-store`. `/api/docs` bleibt ausdrücklich öffentlich (kuratierter Docs-Katalog); `/api/firm/micro` ist im aktuellen Checkout read-only.
- **CSRF/Rate-Limit:** `guardWrite` und `guardMutation` prüfen Auth → CSRF → Rate-Limit. Token-Header-Clients bleiben CSRF-frei; Session-Cookies erfordern Double-Submit, local-open-Browser-Calls den festgelegten lokalen Double-Submit-Wert. Logout ist CSRF-/rate-limited; Refresh prüft die Sessionbindung intern. Alle UI-`/api/**`-Aufrufe verwenden `apiFetch`.
- **Error-Redaction:** Unerwartete 5xx-Ausnahmen werden mit `publicErrorMessage` redigiert; validierungsbezogene 4xx bleiben fachlich aussagekräftig.
- **Regressionen:** `npx tsx --test tests/asa05.apiGuardsAndCsrf.test.ts tests/sec02.unauthenticatedGetApis.test.ts`; zusätzlich vollständige Typecheck-, Lint-, Inventar-, Doku- und Test-Suite.

## Abgeschlossene Remediation ASA-04 (2026-10-28)

Cooldown-Zeitstempel und Tageszähler über Snapshots synchronisiert; prozesslokaler In-Flight-Lock und Read-Barriere schützen Tick-Bursts und Zähler. Neue Symbol-/Timeframe-Paare werden bei Cache-Refresh gewärmt und über additive Feed-Abonnements aktiviert; Audit-Version aus dem Regelkontext. Betriebsgrenzen und Regressionen: [ASA-04](../findings/ASA-04-micro-executor-cooldown-burst-runtime-rules.md).

## Abgeschlossene Remediation ASA-03 (2026-10-27)

- **Positionsdaten fail-closed:** `safeGetPositions()` ist entfernt. `fetchPositionsStrict()` prüft die Antwort und offene Positionsdatensätze; HTTP-/Validierungsfehler propagieren als `BrokerError` bis `getPositions()`, `getAccount()` und `verifyFlat()`.
- **Notfall-Close:** Orders werden best-effort storniert und Fehler auditiert. Ein optionaler Vorab-Snapshot beeinflusst den Ablauf nicht: `DELETE /v2/positions?cancel_orders=true` wird immer gesendet. Anschließend folgt ein strikter Venue-Read, auch nach HTTP `207 Multi-Status`; ein fehlgeschlagener Nachher-Read wirft statt Flatheit vorzutäuschen.
- **HTTP-Retry:** `Retry-After` (Sekunden, Dezimal-Sekunden und HTTP-Datum) wird mit konfigurierbarem 10-s-Standardlimit beachtet. Mehrdeutige Netzwerk-/Timeout-/5xx-Retries sind auf `GET`, `DELETE` und `POST` mit echtem `client_order_id` im JSON-Body begrenzt; die private Alpaca-Order-API setzt den Schlüssel im Body.
- **Verifikation:** `npx tsx --test tests/asa03.alpacaFailClosed.test.ts`, `npx tsx --test tests/alpaca*.test.ts tests/brokerContracts.test.ts`, `npm run typecheck`, `npm run lint`, `npm run docs:validate` und `npm test`.

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


## Abgeschlossene Remediation ASA-08 (v0.17.4, 2026-10-28)

Loopback-Default (npm/systemd), Secret-authentisierte Fetch-Proxy-Identität und
Fail-Closed-Boot für CIDR-only-Konfigurationen; echte Socket-Peers bleiben strikt
CIDR-geprüft. Regressionen testen direkten Login-/API-429 trotz Header-Rotation,
richtige/falsche Secrets, Socket-Miss und secret-freie Diagnose. Neue Tests sind
im Security-Live-Gate verankert; Upgrade und sichere Rotation in `CONFIGURATION.md`.

Prüfergebnisse, Produktions-Smoke und Resthinweise: [ASA-08-Verifikation](ASA-08-VERIFICATION.md).
