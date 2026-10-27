# Copy-&-Paste-Remediation-Prompts — Architektur- & Security-Audit 2026-10-27

Jede Datei in diesem Ordner enthält **exakt einen in sich geschlossenen Prompt** in einem einzelnen ```` ```text ````-Block (Copy-Button oben rechts im Codeblock auf GitHub oder im Docs-Viewer).

- **Prinzip:** **1 Prompt = 1 fokussierte Coding-Session = 1 sauberer PR.**
- **Selbstenthaltend:** Jeder Prompt nennt die exakten Quelldateien, Zeilenbereiche, Architektur-Invarianten, bestehende Repo-Helfer, Randfälle, Pflicht-Tests sowie die nachzuziehenden Tracking-/Inventar-Dateien.
- **Konfliktfrei geschnitten:** Innerhalb derselben Prioritätsstufe berühren parallel ausführbare Prompts disjunkte Dateimengen.

## Übersicht & empfohlene Reihenfolge

### Phase P0 — Kritische Blocker (zuerst abarbeiten; P0-01, P0-02, P0-03 sind untereinander dateidisjunkt)

| # | Prompt-Datei | Befund(e) | Schwerpunkt | Berührte Kernpfade |
|---|--------------|-----------|-------------|--------------------|
| 1 | [`PROMPT-ASA-P0-01-multiprocess-ledger-killswitch-pnl.md`](PROMPT-ASA-P0-01-multiprocess-ledger-killswitch-pnl.md) | [ASA-01](../findings/ASA-01-multiprocess-split-brain-kill-switch-pnl.md) (`CRITICAL`) | Prozessübergreifender DB-Kill-Switch, Rehydrierung unter `withAccountLock` & korrekter `realizedPnl` bei Cross-Prozess-Exits | `src/lib/broker.ts`, `src/lib/brokerHydration.ts`, `src/lib/monitor.ts`, `src/live-gate/enforcer.ts`, `src/app/api/firm/kill/route.ts` |
| 2 | [`PROMPT-ASA-P0-02-lifecycle-authz-foureyes-livekill.md`](PROMPT-ASA-P0-02-lifecycle-authz-foureyes-livekill.md) | [ASA-02](../findings/ASA-02-lifecycle-role-spoofing-four-eyes-live-kill.md) (`CRITICAL`) | `x-admin-token`-Rollen-Spoofing schließen, echtes 2-Principal-Vier-Augen-Prinzip, `firm.kill` vs. `live.gate` + Nonce bei `/api/live/kill` | `src/app/api/firm/lifecycle/route.ts`, `src/app/api/live/kill/route.ts`, `src/live-gate/service.ts` |
| 3 | [`PROMPT-ASA-P0-03-alpaca-failclosed-and-429-backoff.md`](PROMPT-ASA-P0-03-alpaca-failclosed-and-429-backoff.md) | [ASA-03](../findings/ASA-03-alpaca-fail-open-positions-verify-flat.md) (`CRITICAL`) | Alpaca-Adapter Fail-Closed (`fetchPositionsStrict`, unbedingtes `DELETE /v2/positions`, `verifyFlat`) & `Retry-After`/Idempotenz | `src/brokers/alpaca/execution.ts`, `src/brokers/alpaca/http.ts` |

### Phase P1 — Hohe Risiken (P1-05 nach P0-02 ausführen; P1-04, P1-06, P1-07, P1-08 unabhängig)

| # | Prompt-Datei | Befund(e) | Schwerpunkt | Berührte Kernpfade |
|---|--------------|-----------|-------------|--------------------|
| 4 | [`PROMPT-ASA-P1-04-micro-executor-cooldown-burst-hotreload.md`](PROMPT-ASA-P1-04-micro-executor-cooldown-burst-hotreload.md) | [ASA-04](../findings/ASA-04-micro-executor-cooldown-burst-runtime-rules.md) (`HIGH`) | Persistenter `firedAt`-Cooldown über 30-s-Snapshots, `inFlightRules`-Lock gegen Tick-Bursts, dynamisches Symbol-Subscribe | `src/lib/microExecutor.ts` |
| 5 | [`PROMPT-ASA-P1-05-api-rbac-sec02-csrf-error-redaction.md`](PROMPT-ASA-P1-05-api-rbac-sec02-csrf-error-redaction.md) | [ASA-05](../findings/ASA-05-unauthenticated-get-routes-dead-rbac-error-leaks.md) + [ASA-07](../findings/ASA-07-missing-session-csrf-and-write-rate-limits.md) (`HIGH`) | Alle 7 toten RBAC-Permissions verdrahten, offene GETs schließen, zentrales CSRF + Rate-Limit für alle Schreibrouten, `publicErrorMessage` | `src/lib/apiAuth.ts`, `src/app/api/**`, `docs/generated/route-inventory.md` |
| 6 | [`PROMPT-ASA-P1-06-portfolio-dos-and-livegate-audit-sync.md`](PROMPT-ASA-P1-06-portfolio-dos-and-livegate-audit-sync.md) | [ASA-06](../findings/ASA-06-portfolio-dos-live-gate-audit-chain-split.md) (`HIGH`) | Auth + Iterations-Caps auf `/api/portfolio/*`, Cross-Prozess-Synchronisierung & Stat-Caching in `LiveGateAudit` | `src/app/api/portfolio/**`, `src/live-gate/audit.ts`, `src/live-gate/service.ts`, `scripts/gen-docs-inventories.ts` |
| 7 | [`PROMPT-ASA-P1-07-client-ip-proxy-trust-and-bind-hardening.md`](PROMPT-ASA-P1-07-client-ip-proxy-trust-and-bind-hardening.md) | [ASA-08](../findings/ASA-08-trusted-proxy-x-verified-ip-0000-bypass.md) (`HIGH`) | `X-Verified-IP`-Bypass bei `peerIp === null` schließen, Loopback-Default-Bind `127.0.0.1` & Boot-Guard-Prüfung | `src/lib/clientIp.ts`, `scripts/auth-boot-guard.ts`, `package.json`, `deploy/ai-trading-firm.service`, `CONFIGURATION.md` |
| 8 | [`PROMPT-ASA-P1-08-historical-store-partitioning-and-streaming.md`](PROMPT-ASA-P1-08-historical-store-partitioning-and-streaming.md) | [ASA-09](../findings/ASA-09-historical-store-oom-utf8-lost-update.md) (`HIGH`) | `StringDecoder("utf8")`, streambares Schreiben ohne V8-Max-String-Crash, File-Lock & Serien-Partitionierung | `src/lib/marketdata/historicalStore.ts` |

### Phase P2 — Mittlere & Niedrige Risiken (Stabilität, DB-Skalierung & Wartbarkeit)

| # | Prompt-Datei | Befund(e) | Schwerpunkt | Berührte Kernpfade |
|---|--------------|-----------|-------------|--------------------|
| 9 | [`PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md`](PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md) | [ASA-10](../findings/ASA-10-llm-fallback-blind-long-and-drawdown-alert-units.md) + [ASA-11](../findings/ASA-11-core-db-indexes-unbounded-scans-pool-timeout.md) + [ASA-12](../findings/ASA-12-unbounded-memory-maps-dead-session-prune.md) (`MEDIUM`) | LLM-Fallback auf `HOLD`, Drawdown-Alert-Fix, Indizes für 6 Kerntabellen + `statement_timeout`, Map-Caps & Session-Revocation-Prune | `src/lib/ollama.ts`, `src/lib/monitor.ts`, `src/db/*`, `drizzle/*`, `src/lib/authSession.ts`, `src/brokers/bitunix/execution.ts` |
| 10 | [`PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md`](PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md) | [ASA-13](../findings/ASA-13-state-registry-drift-dashboard-god-component.md) + [ASA-14](../findings/ASA-14-systemd-micro-executor-hardening.md) + [ASA-15](../findings/ASA-15-alert-sinks-sync-io-webhook-ssrf.md) (`MEDIUM`/`LOW`) | `stateRegistry`-Konsolidierung + Wächtertest, `FirmDashboard`-Polling & Komponenten-Split, `systemd`-Sandboxing & Alert-Sink-Härtung | `src/lib/stateRegistry.ts`, `src/components/FirmDashboard.tsx`, `deploy/micro-executor.service`, `src/lib/alerts.ts` |

## Ablauf pro Session

1. Neue Coding-Session auf aktuellem `main` starten.
2. Den gesamten ```` ```text ````-Block der jeweiligen `PROMPT-ASA-*.md`-Datei einfügen und absenden.
3. Nach grünem Durchlauf aller Pflicht-Checks (`typecheck`, `lint`, `docs:inventories:check`, `docs:validate`, `test`) PR erstellen und mergen.
4. Nächsten Prompt auf dem aktualisierten `main` ausführen.
