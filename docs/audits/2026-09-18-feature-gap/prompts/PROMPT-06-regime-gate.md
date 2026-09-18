# PROMPT-06 — Regime-Detection als Gate für Agenten-Gewichtung (GAP-06)

> **Finding:** [GAP-06](../findings/GAP-06-regime-gate.md) ·
> **Reihenfolge:** Schritt 5 ·
> **Voraussetzungen:** PROMPT-04 empfohlen (Vol-/Korrelations-Infrastruktur) ·
> **Erwartete Größenordnung:** 1 PR, Minor-Version (feat)

## Session-Prompt

```text
# Mission: Markt-Regime-Klassifikator + Strategie-Gate (GAP-06)

Du arbeitest als Senior-Engineer im Repository „ai-trading-firm“ (Node.js
20+/TypeScript strict, Next.js 16, Drizzle + PostgreSQL, node:test,
Paper-Trading only). Stand: adaptiveRisk klassifiziert Vol-Regime
(NORMAL/ELEVATED/EXTREME) MIT Hysterese (RegimeState.update,
De-Eskalationsfenster) — aber nur als Risikofaktor. Ein Trend/Range/
Crash-Klassifikator existiert nicht; Agenten-/Strategiegewichte reagieren
nicht auf Regime. Ziel: deterministischer Klassifikator (KEIN LLM) +
Regime-Gate, das Mean-Reversion-Signale in Trendmärkten dämpft und
umgekehrt — Rollout bewusst monitor-first.

## Schritt 1 — Ist-Stand verifizieren (Pflicht)

Lies vollständig: src/lib/adaptiveRisk.ts (RegimeState-Muster für Hysterese),
src/lib/indicators.ts (vorhandene Indikatoren — ADX vorhanden? wenn nein:
ADX dort implementieren, deterministisch, getestet), src/cycle/steps/
riskStep.ts + selectionStep.ts + technicalStep.ts (WO Regime in den Zyklus
fließt), src/lib/ruleEngine.ts + src/lib/ruleActor.ts (WO Gewichte/
Faktoren wirken), src/ops/collect.ts (Ops-Center-Risk-Sektion),
tests/adaptiveRisk.test.ts (Hysterese-Testmuster). Abweichung → Rest-Delta,
im PR dokumentieren.

## Schritt 2 — Delta umsetzen

D1 KLASSEFIKATOR (neu src/lib/marketRegime.ts):
   - Typ: MarketRegime = TREND_UP | TREND_DOWN | RANGE | HIGH_VOL | CRASH.
   - Features (nur aus Kerzen, Zeitmaske: nur Daten ≤ t): ADX (ggf. neu in
     src/lib/indicators.ts), Regressions-Slope über Schlusskurse, realisierte
     Volatilität (Percentil über Lookback), Drawdown vom Fensterhoch.
   - Priorität bei Mehrfachtreffern: CRASH > HIGH_VOL > TREND_* > RANGE.
   - Konfiguration: REGIME_LOOKBACK_CANDLES (Default 100, Bounds [20, 500]),
     CRASH_DRAWDOWN_PCT (Default 10, Bounds [3, 50]), HIGH_VOL_PERCENTILE
     (Default 90, Bounds [50, 99]).
   - Hysterese: Regime-Wechsel erst nach REGIME_CONFIRM_CANDLES (Default 3,
     Bounds [1, 20]) bestätigenden Kerzen — Muster an adaptiveRisk
     RegimeState angelehnt; Whipsaws an Grenzen werden so gedämpft.
   - Reine Arithmetik, llmAllowed-frei: Architektur-Test verbietet
     LLM-Import im Modul (Muster tests/cycle.architecture.test.ts).
D2 GATE:
   - Mapping Regime → Dämpfungsfaktor je Strategieklasse (mean-reversion,
     trend, breakout): Konfigurierbar, Werte in [0, 2] geklemmt; Vorschlag
     als Defaults: mean-reversion ×0.5 in TREND_UP/DOWN, breakout ×0.5 in
     RANGE, alle ×1 sonst. Umsetzung als Datenkontext für ruleEngine/
     Approver (Faktor multipliziert Signalgewicht), NICHT als hartes Veto.
   - Modus REGIME_GATE_MODE: „off“ | „monitor“ (DEFAULT: Ausweis + Audit,
     keine Wirkung) | „enforce“. Rollout monitor-first.
   - UNKNOWN (zu wenig Kerzen) → Faktor 1 + UNKNOWN-Kennzeichnung, nie
     still.
D3 SICHTBARKEIT: Regime je Instrument in der Risk-Sektion des Ops-Centers
   (src/ops/collect.ts) + Regime-Verlauf in den Cycle-Artefakten
   (Muster src/cycle/artifacts.ts); Audit je Regime-Wechsel
   („regime:SYMBOL:TREND_UP→RANGE“).

## Grundregeln (Baseline der Serie, verbindlich)

Paper-only · Fail-closed · keine neuen Runtime-Dependencies · Schwellen mit
Bounds + Default + Eintrag in .env.example UND CONFIGURATION.md · keine
Secrets · Mutationen ins audit_log · append-only, falls Schemaänderung nötig
· Determinismus (Fake-Clock, feste Serien in Tests) · Pflicht-Checks:
npm run typecheck && npm run lint && npm test && npm run docs:validate —
0 Failures (Ausnahme ENV-01) · CHANGELOG + Versions-Bump (package.json,
Status-Header, docs/README.md) · nur dieses Delta; Neben-Bugs in „Offene
Punkte“.

## Schritt 3 — Tests (neu tests/marketRegime.test.ts)

- Golden-Cases: synthetisch erzeugte Serien (in Tests erlaubt!) für jedes
  Regime (starker Aufwärtstrend → TREND_UP, Seitwärts+niedrige Vol → RANGE,
  scharfer Einbruch → CRASH, …) inklusive Grenzfällen.
- Hysterese: einzelne Gegenkerzen wechseln das Regime nicht; bestätigte
  Serie schon; De-Eskalationsfenster.
- Determinismus: gleiche Serie → identische Klassifikation (Hash).
- Gate: enforce dämpft Mean-Reversion in TREND_* exakt mit konfiguriertem
  Faktor; monitor ändert Entscheidung nicht (nur Audit); off/UNKNOWN →
  Faktor 1.
- ADX-Mathe gegen Referenzwerte (Handrechnung in Test dokumentiert).

## Schritt 4 — Docs & Meta

- docs/HANDBUCH.md (Agenten-Register/Risiko) oder neues kurzes
  docs/REGIME_GATE.md: Klassifikator-Logik, Prioritäten, Gate-Modi,
  Hysterese-Parameter.
- CONFIGURATION.md + .env.example: neue Flags. CHANGELOG (feat, Minor-Bump)
  + Status-Header + docs/README.md. TRACKING.md pflegen; Finding „Umsetzung“
  ergänzen.

## Abnahme (Definition of Done)

[ ] Ist-Stand verifiziert; D1–D3 umgesetzt und je getestet
[ ] Kein LLM im Klassifikator (Architektur-Test)
[ ] Default monitor-first; enforce nur per Flag
[ ] Flags in .env.example + CONFIGURATION.md
[ ] typecheck + lint + npm test + docs:validate grün (Zahlen im PR)
[ ] CHANGELOG/Version + TRACKING.md + Finding aktualisiert
[ ] PR-Beschreibung vollständig
```
