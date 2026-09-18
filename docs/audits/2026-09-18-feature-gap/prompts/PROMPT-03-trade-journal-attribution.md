# PROMPT-03 — Trade-Journal mit Agenten-Attribution & Feedback-Loop (GAP-03)

> **Finding:** [GAP-03](../findings/GAP-03-trade-journal-attribution.md) ·
> **Reihenfolge:** Schritt 7 ·
> **Voraussetzungen:** empfohlen: PROMPT-06 (Regime je Trade), PROMPT-07
> (saubere Kerzen für MAE/MFE) ·
> **Erwartete Größenordnung:** 1–2 PRs, Minor-Version (feat, Schema append-only)

## Session-Prompt

```text
# Mission: Trade-Journal mit Agenten-Attribution + begrenzter
# Gewichts-Rückführung (GAP-03)

Du arbeitest als Senior-Engineer im Repository „ai-trading-firm“ (Node.js
20+/TypeScript strict, Next.js 16, Drizzle + PostgreSQL, node:test,
Paper-Trading only). Stand: Die Rohdaten existieren — positions trägt
missionId/ruleId/exitReason, dazu proposals, agentMessages („institutionelles
Gedächtnis“), audit_log, equity_snapshots. Es fehlt die VERKNÜPFUNG
(Position ↔ Entscheidungskette der Agenten) und die AUSWERTUNG (wer hat
wann recht?) samt begrenzter Rückführung in Gewichte. Kernidee: lernfähig,
aber rauschfest — Mindest-Stichprobe + Bayes-Glättung + harte Bounds.

## Schritt 1 — Ist-Stand verifizieren (Pflicht)

Lies vollständig: src/db/schema.ts (positions/proposals/agentMessages/
auditLog), src/lib/engine.ts (Orderpfad: WO Proposals/Approval in Orders
münden), src/cycle/schemas.ts (Agenten-Output-Struktur: Stimmen, Confidence),
src/lib/monitor.ts (Close-Pfad), src/lib/marketdata/historicalStore.ts
(Kerzen für MAE/MFE), src/auth/permissions.ts (firm.read-Muster für neue
Read-API), tests/engine.pipeline-approval.test.ts + tests/cycle.*.test.ts.
KLÄRE ZUERST: Welche Agenten-Stimmen/Confidence-Werte liegen je Proposal
strukturiert vor (Spalten? JSON?) und wie ist proposals ↔ positions
verknüpfbar (missionId)? Das bestimmt das Journal-Design. Abweichung vom
Audit-Stand → im PR dokumentieren.

## Schritt 2 — Delta umsetzen

D1 JOURNAL (neue append-only Tabelle trade_journal — KEINE Umbauten an
   bestehenden Tabellen):
   - Spalten (Vorschlag, an Repo-Stil anpassen): id, positionId (FK),
     symbol, side, openedAt, closedAt, missionId, ruleId, decisionSnapshot
     (jsonb: Agenten-Stimmen {name, vote, confidence}, Regime, rationaleHash),
     regime (text, UNKNOWN erlaubt), pnl numeric, maePct numeric, mfePct
     numeric, holdingMinutes int, exitReason text, createdAt.
   - Schreiben: (a) bei Positionseröffnung (Engine-Orderpfad) Snapshot aus
     Proposal/Approval übernehmen; (b) beim Close (Monitor) Metriken
     ergänzen. Fehlt die Verknüpfung (z. B. manuelle Position ohne Proposal)
     → Zeile mit decisionSnapshot UNBEKANNT — Lücke sichtbar, nicht geraten.
D2 MAE/MFE: aus Kerzen (Default 1h, Zeitmaske: nur Intervalle ≤ Exit-Zeit,
   ≥ Eröffnungszeit): MAE = maximaler ungünstiger Excursion relativ zum
   Entry (LONG: (low−entry)/entry), MFE = günstiger (LONG: (high−entry)/entry);
   SHORT gespiegelt. Kerzenlücken (kein Qualitätsbefund-Handling in diesem
   PR) → Metriken null + Flag im Datensatz, nicht schätzen.
D3 AUSWERTUNG (neu src/lib/journalAnalytics.ts):
   - Trefferquote/Erwartungswert je Agent × Regime × Symbolgruppe, mit
     Beta-Prior-Glättung (Alpha=Beta=2 als Default, Konstante dokumentiert)
     und Mindest-Stichprobe JOURNAL_MIN_TRADES (Default 20, Bounds [5, 200])
     — darunter: Kennzahl wird mit „insufficient-sample“ ausgewiesen, NIEMALS
     als Faktor verwendet.
   - Read-API: Summary-Endpunkt im firm-Namespace (Pfad-Muster wie die
     bestehenden Reads unter /api/firm; exakten Pfad im PR festlegen),
     Auth: firm.read nach dem Muster der SEC-02-hartgesicherten Reads
     + Summary in Cycle-Artefakt.
D4 RÜCKFÜHRUNG (begrenzt!):
   - JOURNAL_FEEDBACK_MODE: „off“ (DEFAULT — nur Auswertung) | „monitor“
     (vorgeschlagene Gewichte als Artefakt/Log) | „enforce“ (Gewichte wirken
     im Approver-/Portfolio-Kontext).
   - Gewicht je (Agent, Regime): Bound [JOURNAL_WEIGHT_MIN=0.5,
     JOURNAL_WEIGHT_MAX=1.5], maximale Änderung je Zyklus
     JOURNAL_MAX_WEIGHT_DELTA (Default 0.1, Bounds [0.01, 0.5]); Update
     revisionssicher im audit_log („journal-weight:AGENT:REGIME:x→y“).
   - Bayes-Glättung FIRST: frisch geschlossene Trades verschieben Gewichte
     nur innerhalb der Bounds.

## Grundregeln (Baseline der Serie, verbindlich)

Paper-only · Fail-closed (unbekannte Attribution sichtbar machen, nicht
raten) · keine neuen Runtime-Dependencies · Schwellen mit Bounds + Default +
Eintrag in .env.example UND CONFIGURATION.md · keine Secrets · Mutationen
(Weights) ins audit_log · Schema NUR append-only (neue Tabelle, drizzle/
YYYY-MM-DD_trade_journal.sql), bestehende Tests brechen nicht ·
Determinismus (Fake-Clock, MAE/MFE-Mathe-Tests mit Handrechnung) ·
Pflicht-Checks: npm run typecheck && npm run lint && npm test &&
npm run docs:validate — 0 Failures (Ausnahme ENV-01) · CHANGELOG +
Versions-Bump (package.json, Status-Header, docs/README.md) · nur dieses
Delta; Neben-Bugs in „Offene Punkte“.

## Schritt 3 — Tests (neu tests/tradeJournal.test.ts)

- End-to-End-Attribution: Position über Engine-Pfad eröffnen (mit Proposal/
  Stimmen) → Journal-Zeile enthält korrekten Snapshot; Close → Metriken
  ergänzt.
- Manuelle Position ohne Proposal → Snapshot „unbekannt“, kein Fehler.
- MAE/MFE-Handrechnung LONG und SHORT (Werte im Test als Referenz), Lücken →
  null + Kennzeichnung.
- Glättung: 2/3 Treffer bei n=3 weicht kaum von Prior ab; bei n>=MIN wirkt
  die empirische Quote; insufficient-sample-Ausweis.
- Bounds/Max-Delta: vorgeschlagenes Gewicht außerhalb Grenzen wird geklemmt;
  mehrfache Zyklen → schrittweise Annäherung, nie Sprung; audit Einträge.
- Modus off/monitor: Entscheidungspfad unverändert (bestehende Tests grün).

## Schritt 4 — Docs & Meta

- docs/PORTFOLIO_ANALYTICS.md oder docs/HANDBUCH.md: Journal-Sektion
  (Attribution, Kennzahlen, Glättung, Feedback-Modi + Sicherheitsbegründung
  für off-Default).
- CONFIGURATION.md + .env.example: neue Flags. CHANGELOG (feat, Minor-Bump)
  + Status-Header + docs/README.md. TRACKING.md pflegen; Finding „Umsetzung“
  ergänzen.

## Abnahme (Definition of Done)

[ ] Ist-Stand inkl. proposals-Verknüpfungsfrage geklärt und dokumentiert
[ ] D1–D4 umgesetzt; Schema ausschließlich append-only
[ ] Rausch-Schutz (Min-Stichprobe + Glättung + Bounds) getestet
[ ] Flags in .env.example + CONFIGURATION.md; Default off/monitor
[ ] typecheck + lint + npm test + docs:validate grün (Zahlen im PR)
[ ] CHANGELOG/Version + TRACKING.md + Finding aktualisiert
[ ] PR-Beschreibung vollständig
```
