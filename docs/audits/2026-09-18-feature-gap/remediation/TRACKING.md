# Remediation-Tracking — Feature-Gap-Analyse (2026-09-18)

Diese Datei ist die **einzige Wahrheit** für den Status aller Findings
(GAP-01…GAP-10) dieses Audits. Sie wird von der Arena-Session aktualisiert,
die den jeweiligen Prompt ([`../prompts/README.md`](../prompts/README.md))
abgearbeitet hat — im selben PR wie die Implementation.

## Status-Tabelle

| ID | Titel | Nutzen | Status | Fix-Version | PR / Branch | Notizen | Prompt |
|----|-------|--------|--------|-------------|-------------|---------|--------|
| GAP-01 | Backtesting-Engine mit Walk-Forward-Validierung (ohne Lookahead) | ★★★★★ | OPEN | — | — | synthetischer Fallback in `backtestStep.ts` mitentfernen (fail-closed) | [PROMPT-01](../prompts/PROMPT-01-backtesting-walk-forward.md) |
| GAP-02 | Realistische Execution-Simulation (Slippage/Fees/**Funding**) | ★★★★★ | FIXED | 1.42.0 | PR [#136](https://github.com/Kryschuuu/ai-trading-firm/pull/136) · `arena/01a0b48a-ai-trading-firm` | D1–D4 umgesetzt (Funding-Accrual im Monitor-Tick, `positions.funding_paid`, Kalibrierungs-Flags, Determinismus-Tests); Rate-Default 0 = neutral. Offen: echte Funding-Raten-Anbindung (Provider-Interface vorhanden) | [PROMPT-02](../prompts/PROMPT-02-execution-simulation.md) |
| GAP-03 | Trade-Journal mit Agenten-Attribution & Feedback-Loop | ★★★★★ | IN_PROGRESS | 1.43.0 | PR [#137](https://github.com/Kryschuuu/ai-trading-firm/pull/137) · `arena/01a0b4c1-ai-trading-firm` | D1–D4 in Umsetzung: append-only `trade_journal` + `journal_agent_weights`, MAE/MFE (CANDLE_GAP/NO_DATA), Bayes-Glättung α=β=2 + minSample, `JOURNAL_FEEDBACK_MODE` off (Default)/monitor/enforce, `GET /api/firm/journal`. FIXED nach Merge | [PROMPT-03](../prompts/PROMPT-03-trade-journal-attribution.md) |
| GAP-04 | Vol-Sizing + Korrelations-Exposure-Limits | ★★★★★ | OPEN | — | — | Cluster-Mathematik in `src/portfolio` vorhanden; Delta = Guardrail-Verdrahtung + ATR/Kelly-Sizing | [PROMPT-04](../prompts/PROMPT-04-vol-sizing-correlation-limits.md) |
| GAP-05 | Server-seitiges Exit-Management (Trailing/Time-Stop/OCO) | ★★★★★ | IN_PROGRESS | 1.44.0 | Branch `arena/01a0b5f8-ai-trading-firm` (PR folgt in diesem PR) | D1–D4 umgesetzt: `src/lib/exits.ts` (reine `decideExit`-Logik, Bounds-Clamp, Defaults aus = identisches Verhalten), Trailing-Zustand crash-safe in `positions.trailing_armed`/`trailing_stop` (`drizzle/2026-09-18_exit_management.sql`), Time-Stop `RISK_TIME_STOP_HOURS` (0 = aus), OCO via atomarem DB-Claim (`UPDATE … WHERE status='OPEN'` RETURNING, `applyExit()`) — genau ein Exit auch prozessübergreifend, Audit je Exit (`exit:SYMBOL:grund`), `tests/monitor.exits.test.ts` (17 Tests inkl. Race + Restart-Persistenz). Abweichung dokumentiert: OCO war nicht nur „unbelegt“, sondern fehlte prozessübergreifend; Config im `loadFundingConfig`-Muster (Env) statt Dashboard-Namensraum (Begründung im Finding) | [PROMPT-05](../prompts/PROMPT-05-server-side-exit-management.md) |
| GAP-06 | Regime-Detection als Gate für Agenten-Gewichtung | ★★★★ | OPEN | — | — | Vol-Regime + Hysterese vorhanden (Risiko-Seite); Delta = Trend/Range/Crash-Klassifikator + Gate | [PROMPT-06](../prompts/PROMPT-06-regime-gate.md) |
| GAP-07 | Datenqualitäts-Layer & Multi-Timeframe-Konsistenz | ★★★★ | OPEN | — | — | MDERR-Taxonomie vorhanden; Delta = Gap-/Outlier-Prüfung + 1h→4h/1d-Aggregation | [PROMPT-07](../prompts/PROMPT-07-data-quality-multi-timeframe.md) |
| GAP-08 | LLM-Output-Validierung & Prompt-Eval-Harness | ★★★★ | OPEN | — | — | Schema-Validatoren (Repo-Stil, ohne Zod) vorhanden; Delta = Plausibilitäts-Schicht + Golden-Dataset-Eval | [PROMPT-08](../prompts/PROMPT-08-llm-validation-eval-harness.md) |
| GAP-09 | Reconciliation Broker ↔ DB + idempotente Order-IDs | ★★★★ | OPEN | — | — | `orderIntents` + Bitunix-Idempotenz teilweise vorhanden; Delta = generischer Job + Pause + Paper-Invarianzen | [PROMPT-09](../prompts/PROMPT-09-reconciliation-idempotency.md) |
| GAP-10 | Observability & automatische Circuit-Breaker | ★★★★ | OPEN | — | — | Telemetrie + Drawdown-Limits vorhanden; Delta = Auto-Kill-Switch + Alerting + Heartbeat | [PROMPT-10](../prompts/PROMPT-10-observability-circuit-breaker.md) |

Zusätzlich aus der Verifikation hervorgegangen (nicht Teil des Co-Audits):

| ID | Titel | Severity | Status | Fix-Version | PR / Branch | Notizen |
|----|-------|----------|--------|-------------|-------------|---------|
| ENV-01 | `tests/secretStore.test.ts` — Test-Isolation: „db→file-Fallback ohne DATABASE_URL“ erhält `db`, wenn eine DB erreichbar ist | LOW | OPEN | — | — | npm-Script exportiert `DATABASE_URL` prozessweit; der Fallback-Test deutet das als „DB verfügbar“. Standalone grün. Fix-Umfang: env-Inject instead of process-env-Fallback im getesteten Pfad, oder Test-Expectation an effektive URL koppeln |

## Legende

- **Status:**
  - `OPEN` — Verifiziert, noch nicht bearbeitet
  - `IN_PROGRESS` — Arena-Session läuft / PR offen (Branch angeben)
  - `PARTIAL` — Teile umgesetzt, Rest mit Begründung offen
  - `FIXED` — Umgesetzt, mit Version und PR belegt
  - `WONTFIX` — Bewusst nicht umgesetzt, mit Begründung

## Workflow je Prompt-Durchlauf

1. Arena-Session mit dem jeweiligen `PROMPT-XX`-Block starten
   (Reihenfolge siehe [`../prompts/README.md`](../prompts/README.md)).
2. Die Session implementiert das Delta, fügt Tests + Docs hinzu und liefert
   Changelog-Eintrag + Versions-Bump im selben PR.
3. Im selben PR: Zeile dieser Tabelle auf `IN_PROGRESS` → nach Merge `FIXED`
   (Version + PR-Link), Fundings-Datei
   `../findings/GAP-XX-*.md` um einen „Umsetzung“-Abschnitt ergänzen.
4. Abweichungen vom Prompt-Umfang (Scope-Kürzungen, andere Architektur) werden
   in der Notiz-Spalte begründet — kein stilles „erledigt“.
