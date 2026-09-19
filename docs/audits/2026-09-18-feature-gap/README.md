# Audit: Feature-Gap-Analyse (Co-Audit) — 2026-09-18

**Quelle:** Externer Co-Audit „ai-trading-firm – Feature-Gap-Analyse“ (Arena-Session).
Der vollständige Wortlaut ist in [`report.md`](report.md) übernommen.
**Reviewer:** Arena-Agent (Architektur-/Feature-Lücken-Analyse), Gegenprüfung
des Ist-Stands gegen den realen Codebestand dieses Repositories (2026-09-18,
Basis v1.40.0).
**Scope:** Trading-Qualität, Ausführungsrealismus, Lernschleife, Risiko,
Betrieb — bewusst **kein** Security-Review (Security/Governance wird im
Co-Audit ausdrücklich als Stärke bewertet).
**Branch/Commit:** Arbeitsbranch `arena/01a0b41c-ai-trading-firm`, Basis
`main` (Stand v1.40.0).
**Status:** FIXED (2026-09-19, v1.51.1) — alle zehn Lücken wurden über die
Prompt-Serie ([`prompts/`](prompts/README.md)) in v1.42.0 … v1.51.0
(PRs #136–#145) umgesetzt; der verbindliche Status je Lücke steht in
[`remediation/TRACKING.md`](remediation/TRACKING.md), der Abschluss-Abgleich
gegen `main` in
[`remediation/STATUS-REVIEW-2026-09-19.md`](remediation/STATUS-REVIEW-2026-09-19.md).

> **Warum dieser Ordner existiert:** Das Co-Audit konnte bei seiner Erstellung
> nur README, Changelog und öffentliche PRs auswerten — nicht den Code. Damit
> aus den Beobachtungen keine Doku-Code-Diskrepanz wird (Muster
> [`DOCS_SYNC_AUDIT.md`](../../DOCS_SYNC_AUDIT.md)), ist hier je Finding der
> **verifizierte Ist-Stand im Code** dokumentiert. Mehrere Lücken sind damit
> **Teil-umgesetzt** — die Prompt-Serie arbeitet jeweils nur noch das Delta ab.

## Kennzahlen-Übersicht

Das Zyklus-Modell „Severity“ ist auf Feature-Lücken nicht übertragbar. Diese
Serie bewertet mit den beiden Achsen des Co-Audits:

| Achse | Skala |
|-------|-------|
| **Nutzen** | ★☆☆☆☆ – ★★★★★ |
| **Aufwand** | 🔧 (Tage) – 🔧🔧🔧🔧🔧 (Wochen+, tiefe Eingriffe) |

Aufwandsschätzungen des ursprünglichen Co-Audits wurden nach der
Code-Verifikation korrigiert, wo bereits Teil-Umsetzungen existieren
(siehe je Finding).

## Findings-Index

| ID | Titel | Nutzen | Ist-Stand (verifiziert) | Status | Finding | Prompt |
|----|-------|--------|-------------------------|--------|---------|--------|
| GAP-01 | Backtesting-Engine mit Walk-Forward-Validierung (ohne Lookahead) | ★★★★★ | Teil-umgesetzt (`backtestStep` je Setup; **synthetischer Fallback als Anti-Pattern**) | FIXED v1.51.0 | [GAP-01](./findings/GAP-01-backtesting-walk-forward.md) | [PROMPT-01](./prompts/PROMPT-01-backtesting-walk-forward.md) |
| GAP-02 | Realistische Execution-Simulation im PaperBroker (Slippage/Fees/Funding) | ★★★★★ | Großteils umgesetzt (`PaperExecutionAdapter`); **Funding-Kosten fehlen** | FIXED v1.42.0 | [GAP-02](./findings/GAP-02-execution-simulation.md) | [PROMPT-02](./prompts/PROMPT-02-execution-simulation.md) |
| GAP-03 | Trade-Journal mit Agenten-Attribution & Feedback-Loop | ★★★★★ | Rohdaten vorhanden (mission/rule/audit/proposals); **Verknüpfung + Auswertung + Rückführung fehlen** | FIXED v1.43.0 | [GAP-03](./findings/GAP-03-trade-journal-attribution.md) | [PROMPT-03](./prompts/PROMPT-03-trade-journal-attribution.md) |
| GAP-04 | Volatilitätsbasiertes Position-Sizing + Korrelations-Exposure-Limits | ★★★★★ | Korrelations-/Cluster-Mathematik vorhanden; **nicht als Guardrail verdrahtet**; Sizing fix | FIXED v1.48.0 (+1.51.1) | [GAP-04](./findings/GAP-04-vol-sizing-correlation-limits.md) | [PROMPT-04](./prompts/PROMPT-04-vol-sizing-correlation-limits.md) |
| GAP-05 | Server-seitiges Exit-Management (SL/TP/Trailing, OCO/Bracket, Time-Stop) | ★★★★★ | SL/TP-Watcher vorhanden (`monitor.tick`); **Trailing, Time-Stop, OCO-Exklusivität fehlen** | FIXED v1.44.0 | [GAP-05](./findings/GAP-05-server-side-exit-management.md) | [PROMPT-05](./prompts/PROMPT-05-server-side-exit-management.md) |
| GAP-06 | Explizite Regime-Detection als Gate für Agenten-Gewichtung | ★★★★ | Vol-Regime mit Hysterese vorhanden (Risiko-Seite); **Trend/Range-Klassifikator + Strategie-Gate fehlen** | FIXED v1.46.0 | [GAP-06](./findings/GAP-06-regime-gate.md) | [PROMPT-06](./prompts/PROMPT-06-regime-gate.md) |
| GAP-07 | Datenqualitäts-Layer & Multi-Timeframe-Konsistenz | ★★★★ | MDERR-Taxonomie + Stale-Fallback vorhanden; **Gap-Detection, Outlier-Filter, Multi-TF-Aggregation fehlen** | FIXED v1.47.0 | [GAP-07](./findings/GAP-07-data-quality-multi-timeframe.md) | [PROMPT-07](./prompts/PROMPT-07-data-quality-multi-timeframe.md) |
| GAP-08 | LLM-Output-Validierung & Prompt-Eval-Harness | ★★★★ | Schema-Validatoren vorhanden (ohne Zod, Repo-Stil); **Plausibilitäts-Checks + Golden-Dataset-Eval fehlen** | FIXED v1.49.0 | [GAP-08](./findings/GAP-08-llm-validation-eval-harness.md) | [PROMPT-08](./prompts/PROMPT-08-llm-validation-eval-harness.md) |
| GAP-09 | Reconciliation Broker ↔ DB + idempotente Order-IDs | ★★★★ (★★★★★ bei Live) | `orderIntents` + Bitunix-Idempotenz teilweise vorhanden; **generischer periodischer Abgleich + Pause-Pfad fehlen** | FIXED v1.50.0 | [GAP-09](./findings/GAP-09-reconciliation-idempotency.md) | [PROMPT-09](./prompts/PROMPT-09-reconciliation-idempotency.md) |
| GAP-10 | Observability & automatische Circuit-Breaker | ★★★★ | Telemetrie + Ops-Center + Drawdown-Limits vorhanden; **Auto-Kill-Switch, Alerting, Heartbeat-Watchdog fehlen** | FIXED v1.45.0 | [GAP-10](./findings/GAP-10-observability-circuit-breaker.md) | [PROMPT-10](./prompts/PROMPT-10-observability-circuit-breaker.md) |

Siehe [`remediation/TRACKING.md`](remediation/TRACKING.md) für den
verbindlichen Status und [`prompts/README.md`](prompts/README.md) für die
empfohlene Abarbeitungsreihenfolge.

## Executive Summary

Das Co-Audit bestätigt das Bild eines **asymmetrisch reifen** Systems:
Security, Auth, Audit-Trail und Betrieb sind auf Produktionsniveau, während
die Trading-Qualität selbst (Validierung vor Papiergeld, realistische Fills,
Lernschleife) aus dem sichtbaren Material kaum belegt war.

Die Code-Verifikation 2026-09-18 **relativiert das Bild in beide Richtungen**:

1. **Mehr vorhanden als angenommen:** Deterministischer
   Execution-Simulator mit Gebühren/Spread/Slippage/Partial-Fills
   (`PaperExecutionAdapter`, Task 03), SL/TP-Watcher im Monitor-Tick,
   Vol-Regime-Erkennung mit Hysterese im adaptiven Risiko,
   Korrelations-/Cluster-Mathematik im Portfolio-Modul, MDERR-Fehler-Taxonomie,
   Prometheus-Snapshot für Marktdaten-Fehler.
2. **Weniger vorhanden als die UI/Docs vermuten lassen:** Der Backtest-Step
   fällt bei <5 Kerzen auf eine **synthetische Standardserie** („20 Trades,
   55 % Winrate“) zurück — erzeugte Performance statt gemessener, genau das
   „Bauchgefühl statt Datenbasis“, das das Co-Audit beanstandet. Funding-Kosten
   (Perpetuals!) fließen nirgends in Paper-PnL ein. Es gibt keinen
   Lookahead-freien Walk-Forward-Lauf, keine Agenten-Attribution im Journal,
   keinen automatischen Circuit-Breaker.

Daraus folgt die Remediation-Strategie dieser Serie: **nicht** zehn
Greenfield-Projekte, sondern zehn abgrenzbare Deltas — je eines als
selbstständiger Arena-Session-Prompt mit Verifikationspflicht, Testpflicht
und Docs-Sync-Pflicht. Die empfohlene Reihenfolge (Ehrlichkeit → Schutz →
Betrieb → Rendite/Risiko → Lernschleife → Validierung → Live-Readiness) ist
in [`prompts/README.md`](prompts/README.md) begründet.

## Remediation-Plan

- Remediation erfolgt **prompt-basiert**: je Finding ein einpaste-fähiger
  Arena-Session-Prompt in [`prompts/`](prompts/README.md), jeder Prompt
  self-contained (Baseline-Regeln inklusive), mit Pflicht-Verifikation des
  Ist-Stands, Testplan, Docs-/Changelog-Pflichten und Abnahmecheckliste.
- Der Status je Finding wird ausschließlich in
  [`remediation/TRACKING.md`](remediation/TRACKING.md) gepflegt
  (OPEN → IN_PROGRESS → PARTIAL → FIXED / WONTFIX, mit Version + PR).
- Ein Prompt = eine Arena-Session = ein PR. Kein Prompt ändert den
  Live-Trading-Pfad; das System bleibt Paper-only.

## Abschluss (2026-09-19, v1.51.1)

- Alle zehn Prompts wurden in der empfohlenen Reihenfolge abgearbeitet und
  gemerged (v1.42.0 … v1.51.0, PRs #136–#145); jedes Finding trägt einen
  „Umsetzung“-Abschnitt mit Datei-/Testpfaden und bewusst offenen Punkten.
- Der Status-Review
  [`remediation/STATUS-REVIEW-2026-09-19.md`](remediation/STATUS-REVIEW-2026-09-19.md)
  hat den Ist-Stand in `main` je GAP verifiziert (PR-Status, Artefakte,
  Flags, Docs, Gesamt-Testlauf **mit** DB: 2439 Tests). Einziger Restdefekt:
  vier GAP-04-Audit-Events ohne Katalog-Eintrag — behoben in v1.51.1.
- Zwei Prozess-Lehren sind in `remediation/TRACKING.md` (Workflow, Punkte
  3 + 5) festgehalten: Der Schritt „nach Merge `FIXED`“ braucht einen
  Eigentümer, und `npm test` läuft nicht in der CI — der lokale Gesamtlauf
  im PR-Testbericht ist der einzige Beleg.
