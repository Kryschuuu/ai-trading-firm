# PROMPT-01 — Backtesting-Engine mit Walk-Forward-Validierung (GAP-01)

> **Finding:** [GAP-01](../findings/GAP-01-backtesting-walk-forward.md) ·
> **Reihenfolge:** Schritt 9 (größter Brocken) ·
> **Voraussetzungen:** HART: PROMPT-02 (Kostenmodell) + PROMPT-07
> (Datenqualität) bereits gemerged — sonst abbrechen und Blocker notieren ·
> **Erwartete Größenordnung:** 1–2 PRs, Minor-Version (feat, neue Tabelle)

## Session-Prompt

```text
# Mission: Regelbasierte Backtesting-Engine mit Walk-Forward-Fenstern und
# Lookahead-Garantie (GAP-01)

Du arbeitest als Senior-Engineer im Repository „ai-trading-firm“ (Node.js
20+/TypeScript strict, Next.js 16, Drizzle + PostgreSQL, node:test,
Paper-Trading only). Stand: backtestStep (src/cycle/steps/backtestStep.ts)
prüft EINZELNE Setups deterministisch gegen historische Kerzen — ABER er
fällt bei <5 Kerzen auf eine SYNTHETISCHE Serie zurück („20 Trades, 55 %
Winrate“): erzeugte statt gemessener Performance. Ein Walk-Forward-Lauf über
Zeiträume mit strikter Zeitmaske existiert nicht; Runs sind nicht
vergleichbar persistiert. rule_backtests + POST /api/firm/rules/[id]/backtest
existieren für Einzelregeln. Ziele dieser Session: (1) echte Engine, (2)
Lookahead-Garantie per Test, (3) Walk-Forward-Fenster + persistierte Runs,
(4) Kostenmodell aus DEMSELBEN Simulator wie der PaperBroker, (5) den
synthetischen Fallback entfernen.

## Schritt 1 — Ist-Stand verifizieren (Pflicht)

Lies vollständig: src/cycle/steps/backtestStep.ts (inkl. des synthetischen
Fallbacks!), src/lib/marketdata/historicalStore.ts (Zeitmaske, Timeframes),
src/lib/broker.ts + src/lib/marketdata/production.ts + src/marketdata/
spread.ts (Execution-Simulation + Spread-Modell — nach PROMPT-02 inkl.
Funding, wenn gemerged), src/db/schema.ts (rule_backtests als
Namens-/Stil-Vorbild), src/portfolio/index.ts (maxDrawdown, profitFactor,
sharpeRatio, sortinoRatio — WIEDERVERWENDEN), src/lib/ruleEngine.ts +
src/lib/ruleActor.ts (Regel-Auswertung, die replayt wird), tests/cycle.steps.
test.ts (bestehende Backtest-Step-Tests). Sind PROMPT-02/07 noch nicht
gemerged: ABBRECHEN, PR nur mit Blocker-Begründung + TRACKING.md auf
IN_PROGRESS setzen (Arbeitsweise A2 der Baseline).

## Schritt 2 — Delta umsetzen

D1 ENGINE (neu src/backtest/engine.ts — bewusst AUSSERHALB von src/cycle,
   damit Zyklus und Engine getrennt bleiben):
   - Eingaben: Regel (tradeRules-Zeile bzw. Regel-Spezifikation), Instrument,
     Timeframe, Zeitraum [from, to], Kostenprofil.
   - Replay: für jede Kerze t: Signalerzeugung mit NUR Daten ≤ t (strikte
     Zeitmaske), Orders durch DEMSELBEN deterministischen Execution-Simulator
     wie der PaperBroker (createPaperExecution-Muster; Quotes aus Kerzen
     abgeleitet über das Spread-Modell — kein zweiter Kosten-Code-Pfad!).
   - Kennzahlen je Run: maxDrawdown, profitFactor, sharpeRatio, sortinoRatio
     (alle aus src/portfolio importieren), Trades, Win-Rate, Kosten gesamt
     (+ Funding, falls PROMPT-02-Feld verfügbar), Equity-Kurve.
   - KEIN LLM: reine Arithmetik (Architektur-Test verbietet LLM-Import im
     Modul, Muster tests/cycle.architecture.test.ts). LLM-Signale lassen sich
     später via gespeicherte Artefakte replayen — out of scope hier.
D2 WALK-FORWARD:
   - Rollierende Fenster: In-Sample (IS) / Out-of-Sample (OOS) mit
     WF_IS_WINDOW_DAYS (Default 90, Bounds [14, 720]) und
     WF_OOS_WINDOW_DAYS (Default 30, Bounds [7, 180]); Regeln in dieser
     Engine sind statisch → IS/OOS trennt EVALUATIONS-Fenster (Robustheit),
     Parameter-Optimierung ist bewusst NICHT Teil dieses PRs (dokumentieren).
   - Report je Fenster + Aggregat; Anti-Overfitting-Hinweis: Fensteranzahl
     begrenzen (max. Backtest-Zeitraum flag-gebunden, Default 2 Jahre).
D3 PERSISTENZ + ZUGRIFF:
   - Neue Tabelle backtest_runs (append-only): id, instrumentId, timeframe,
     from/ts, to/ts, paramsJson, metricsJson, windowsJson, codeVersion,
     createdAt — Migration drizzle/YYYY-MM-DD_backtest_runs.sql, Stil wie
     rule_backtests.
   - CLI scripts/run-backtest.ts (Flags --instrument --timeframe --from
     --to, schreibt Run + MD-Zusammenfassung nach data/backtest/ via
     resolveRuntimePath); Read-API für Runs unter dem firm-Namespace
     (Pfad-Muster wie die bestehenden Reads unter /api/firm; exakten Pfad
     im PR festlegen), Auth: firm.read — KEIN POST-Endpunkt (Runs entstehen
     nur via CLI).
D4 FALLBACK ENTFERNEN: backtestStep.ts — bei <5 Kerzen KEINE synthetische
   Serie mehr, sondern verified=false + expliziter DATA_UNAVAILABLE-artiger
   Zustand + audit/Log; alle Konsumenten (Schemas, Tests, UI-Texte) anpassen.
   Dies ist ein Verhaltens-Fix: im CHANGELOG unter „Fixiert“ benennen mit
   Verweis auf dieses Audit.

## Grundregeln (Baseline der Serie, verbindlich)

Paper-only · Fail-closed (kein synthetisches Pendant mehr — R2 ist hier der
Kern des PRs) · keine neuen Runtime-Dependencies · Schwellen mit Bounds +
Default + Eintrag in .env.example UND CONFIGURATION.md · keine Secrets ·
append-only-Migration, bestehende Tests brechen nicht (backtestStep-Tests
werden SINNGEMÄSS auf den neuen Fail-closed-Pfad umgestellt — Red/Green im
PR dokumentieren) · Determinismus (Fake-Clock, feste Serien) · Pflicht-
Checks: npm run typecheck && npm run lint && npm test && npm run
docs:validate — 0 Failures (Ausnahme ENV-01) · CHANGELOG + Versions-Bump
(package.json, Status-Header, docs/README.md) · nur dieses Delta; Neben-Bugs
in „Offene Punkte“.

## Schritt 3 — Tests (neu tests/backtest.engine.test.ts +tests/backtest.step
.nosynthetic.test.ts)

- LOOKAHEAD (kritischster Test): Fixtures mit Kerzenfolge A; identischer
  Lauf mit zusätzlicher Kerze, die NACH Entscheidungszeitpunkt t bekannte
  Daten verändert → alle Trades/Kennzahlen bis t IDENTISCH (Hash-Vergleich
  der Trade-Liste bis t). Zusätzlich: umgekehrte Serienreihenfolge als
  Mutationstest.
- IS/OOS: Fenster-Grenzen exakt (keine Überlappung, keine Lücke), Kennzahlen
  je Fenster korrekt getrennt, Determinismus (zwei Läufe → identisches
  metricsJson).
- Kostenmodell: Fees/Slippage fließen in Kennzahlen ein (Run ohne Kosten
  vs. mit Kosten → erwartete Differenz); identischer Simulator wie Paper
  (Import-Nachweis, kein duplizierter Code).
- Persistence: Run landet in backtest_runs, Read-API liefert ihn (Auth-
  Test: ohne firm.read abgewiesen).
- Fallback-Entfernung: <5 Kerzen → verified=false + sichtbarer Zustand,
  KEIN synthetischer Output mehr (altes Verhalten als roter Test dokumentiert,
  dann grün).
- Architektur: kein LLM-Import in src/backtest/**.

## Schritt 4 — Docs & Meta

- Neues docs/BACKTESTING.md: Engine-Architektur, Zeitmaske, Walk-Forward-
  Fenster, Kostenmodell-Wiederverwendung, Run-Persistenz, CLI-Referenz,
  Anti-Overfitting-Grenzen (statische Regeln, keine Parameter-Optimierung).
- docs/README.md-Tabelle + src/lib/docsCatalog.ts-Eintrag für BACKTESTING.md.
- CONFIGURATION.md + .env.example: neue Flags. CHANGELOG (feat + fix
  [Fallback-Entfernung], Minor-Bump) + Status-Header + docs/README.md.
  TRACKING.md pflegen; findings/GAP-01-*.md „Umsetzung“ ergänzen.

## Abnahme (Definition of Done)

[ ] Voraussetzungen (PROMPT-02, PROMPT-07) gemerged — sonst abgebrochen
[ ] Lookahead-Test existiert und würde einen Zeitmasken-Fehler rot machen
[ ] Kostenmodell = Paper-Simulator (Code-Nachweis, keine Duplikation)
[ ] Synthetischer Fallback entfernt (Red/Green dokumentiert)
[ ] Runs persistiert + Read-API mit firm.read
[ ] typecheck + lint + npm test + docs:validate grün (Zahlen im PR)
[ ] CHANGELOG/Version + TRACKING.md + Finding + docsCatalog aktualisiert
[ ] PR-Beschreibung vollständig
```
