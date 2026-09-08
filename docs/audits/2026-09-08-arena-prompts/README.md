# Audit: Arena-Review-Serie (Prompts) — 2026-09-08

**Quelle:** Externe Review-Serie „Arena.ai Agent Prompt“ (nummerierte Findings,
dieser Zyklus: Prompt 13).
**Reviewer:** Arena-Agent (Senior-Python/Node-Engineering-Auftrag), Gegenprüfung
gegen den realen Stand dieses Repositories.
**Scope:** `src/lib/engine.ts` (Restore des Firmenzustands), `src/db/schema.ts`
(`positions`), `src/lib/stateRegistry.ts`, `src/lib/monitor.ts`,
`src/lib/microExecutor.ts`, `src/brokers/control-plane/*`.
**Datum:** 2026-09-08
**Branch/Commit:** Arbeitsbranch `arena/01a080a3-ai-trading-firm`, Basis `main`
(Stand v1.36.36).
**Status:** CLOSED — das übertragene Finding ist behoben (v1.36.37); der
wörtliche Pfad des Findings ist für dieses Repository als
nicht-anwendbar bewertet und begründet.

> **Warum dieser Ordner existiert:** Die Prompt-Serie stammt aus einem anderen
> Projekt („t-bot-lokal“, Django + `asgiref.sync.sync_to_async`). Die IDs werden
> hier übernommen, damit das Mapping zurück zur Quelle erhalten bleibt
> (Konvention: [`../README.md`](../README.md) → „Original-ID beibehalten“).
> Die Bewertung selbst ist stack-spezifisch dokumentiert.

## Severity-Übersicht

| Severity | Anzahl | Offen | In Arbeit | Gefixt | Nicht anwendbar |
|----------|--------|-------|-----------|--------|-----------------|
| CRITICAL | 0 | 0 | 0 | 0 | 0 |
| HIGH | 0 | 0 | 0 | 0 | 0 |
| MEDIUM | 1 | 0 | 0 | 1 | 0 |
| LOW | 0 | 0 | 0 | 0 | 0 |

## Findings-Index

| ID | Titel | Severity | Status | Fix-Version | Datei |
|----|-------|----------|--------|-------------|-------|
| RESTORE-01 | Restore des Firmenzustands pro Aufrufer (blockierend, ungedeckelt, ohne Index) | MEDIUM | ✅ FIXED | v1.36.37 | [RESTORE-01](./findings/RESTORE-01-state-restore-blocking.md) |

Siehe [`remediation/TRACKING.md`](remediation/TRACKING.md) für den
verbindlichen Status und [`report.md`](report.md) für die Vollständigkeit der
Überprüfung (inkl. der als nicht-anwendbar bewerteten Wortlaut-Ebene).

## Executive Summary

Prompt 13 beschreibt eine synchrone `db_restore_state()` in
`trading/trading_bot.py`, die bei großen Tabellen den Bot-Thread blockiert,
und verlangt `sync_to_async` mit dediziertem Executor. Dieser Stack ist
Next.js/TypeScript (Node.js, einzelner Event-Loop, `pg`-Pool) — die genannte
Datei, die genannten Symbole und Python überhaupt existieren in diesem
Repository nicht (Nachweis in [`report.md`](report.md)).

Die Schwachstellenklasse ist hier aber real und wirksam: die
Zustandswiederherstellung des Paper-Ledgers (`getBroker()` in
`src/lib/engine.ts`) lief pro Aufrufer, ohne Bündelung, ohne
Versuchsdeckel nach Fehlern und gegen eine Tabelle ohne Index auf dem
Abfrageprädikat. Genau das ist das Verhalten, das bei großen Tabellen zum
Problem wird — hier zusätzlich als Selbstverstärker bei Datenbankausfall.
RESTORE-01 behebt die Root Cause auf allen drei Ebenen.

## Remediation-Plan

Ein Finding, drei Ebenen, in einer Lieferung:
Bündelung (Single-Flight) → Versuchsdeckel (Backoff) → Kosten der Abfrage
(partieller Index inkl. idempotenter Migration). Reihenfolge ist beliebig,
weil alle drei denselben Pfad betreffen; die Tests sind gegen jede Ebene
einzeln gerichtet.

## Referenzen

- Finding: [`findings/RESTORE-01-state-restore-blocking.md`](findings/RESTORE-01-state-restore-blocking.md)
- Tracking: [`remediation/TRACKING.md`](remediation/TRACKING.md)
- Prüfbericht: [`report.md`](report.md)
- Changelog: [`../../../CHANGELOG.md`](../../../CHANGELOG.md)
- Security-Übersicht: [`../../security/README.md`](../../security/README.md)
- Broker-/Ledger-Architektur: [`../../BROKER_ARCHITECTURE.md`](../../BROKER_ARCHITECTURE.md)
