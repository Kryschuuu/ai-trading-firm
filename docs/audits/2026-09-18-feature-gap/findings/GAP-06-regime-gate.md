# GAP-06 — Explizite Regime-Detection als Gate für Agenten-Gewichtung

**Nutzen:** ★★★★ · **Aufwand (Co-Audit):** 🔧🔧 · **Aufwand (verifiziert):** 🔧🔧
**Kategorie:** Rendite · **Prompt:** [`PROMPT-06`](../prompts/PROMPT-06-regime-gate.md)

## Befund (Co-Audit)

Mean-Reversion-Signale in Trendmärkten automatisch dämpfen (und umgekehrt) —
das Regime-Gate für den Contrarian-Agenten gehört von Tag eins hinein, nicht
nach den ersten Live-Verlusten. Contra: Klassifikatoren laggen, Whipsaws an
Grenzen → Hysterese nötig.

## Verifizierter Ist-Stand (2026-09-18, v1.40.0)

- `src/lib/adaptiveRisk.ts`: Vol-Regime-Klassifikation NORMAL/ELEVATED/EXTREME
  **mit** Hysterese (`RegimeState.update`, De-Eskalationsfenster, Severity-
  Ordnung) — aber ausschließlich als *Risiko-Faktor* (`regimeFactor`) auf
  Positionsgrößen.
- Kein Trend/Range/Crash-Klassifikator im Code (kein ADX, keine
  Regressions-Slope-Logik); kein Gate, das Strategien/Agentengewichte je
  Regime dämpft.

## Delta

1. `MarketRegime`-Klassifikator (TREND_UP/TREND_DOWN/RANGE/HIGH_VOL/CRASH)
   als deterministische Arithmetik (KEIN LLM): ADX/Slope + realisierte Vol +
   Drawdown-Schwelle; Zeitmaske (nur Daten ≤ t); Hysterese nach bestehendem
   `RegimeState`-Muster.
2. Gate: Regime dämpft Strategie-/Agentengewichte (z. B. Mean-Reversion in
   TREND_*) — Default **monitor-only** (Ausweis + Audit), Enforcing
   flag-gaged mit Bounds.
3. UNKNOWN bei fehlenden Daten → konservatives Verhalten, dokumentiert.
4. Ausweis im Ops-Center (Risk-Sektion) je Instrument.

## Akzeptanzkriterien (kurz)

Golden-Case-Klassifikationstests, Hysterese-/Whipsaw-Test, Gate-Dämpfungs-
Test, UNKNOWN-Pfad-Test, kein LLM im Klassifikator (Architektur-Test).

## Umsetzung (v1.46.0, 2026-09-19)

Umsetzung im Rahmen von [PROMPT-06](../prompts/PROMPT-06-regime-gate.md)
(Arena-Session, Branch `arena/01a0b708-ai-trading-firm`). **Ist-Stand wie
verifiziert:** `adaptiveRisk.ts` liefert Vol-Regime NORMAL/ELEVATED/EXTREME
mit Hysterese ausschließlich als Risikofaktor; ADX existierte nicht (neu in
`src/lib/indicators.ts`, Wilder, mit Handrechnungs-Referenztest).

- **D1 Klassifikator:** `src/lib/marketRegime.ts`
  (`classifyMarketRegime()`), deterministisch und LLM-frei
  (Architektur-Test in `tests/marketRegime.test.ts`). Features nur aus
  Kerzen (Zeitmaske ≤ t): ADX (14), OLS-Regressions-Slope (%/Kerze),
  realisierte Volatilität als Perzentil über den Lookback (mit
  Entartungsschutz bei konstanter Vol), Drawdown vom Fensterhoch.
  Priorität strikt **CRASH > HIGH_VOL > TREND_UP/TREND_DOWN > RANGE**;
  CRASH verlangt Drawdown ≥ Schwelle **und** negativen Slope (V-Erholung
  ist kein Crash). Konfiguration: `REGIME_LOOKBACK_CANDLES` (100,
  [20, 500]), `CRASH_DRAWDOWN_PCT` (10, [3, 50]), `HIGH_VOL_PERCENTILE`
  (90, [50, 99]) plus `REGIME_TREND_ADX` (25, [10, 60]) und
  `REGIME_TREND_SLOPE_PCT` (0.05, [0.005, 1]) — alle mit Bounds + Default
  in `.env.example` + `CONFIGURATION.md`.
- **Hysterese:** `MarketRegimeStateMachine` (Muster an `RegimeStateMachine`
  angelehnt, Schwere-Ordnung RANGE < TREND_* < HIGH_VOL < CRASH):
  Eskalation sofort (sichere Richtung), Seitwärts-/De-Eskalation erst nach
  `REGIME_CONFIRM_CANDLES` (3, [1, 20]) konsekutiven Bestätigungen —
  einzelne Gegenkerzen wechseln das Regime nicht. UNKNOWN (unter 30 Kerzen)
  lässt die Maschine unangetastet.
- **D2 Gate:** `applyRegimeGate()` — Regime × Strategieklasse
  (mean-reversion/trend/breakout) → Faktor geklemmt [0, 2]; Defaults wie
  im Prompt vorgeschlagen (mean-reversion ×0.5 in TREND_*, breakout ×0.5 in
  RANGE, sonst ×1), konfigurierbar über `REGIME_GATE_FACTORS`.
  `REGIME_GATE_MODE` off/**monitor** (Default: Ausweis + Audit, keine
  Wirkung)/enforce; unbekannter Wert → fail-closed monitor. Umsetzung als
  Datenkontext: Engine-Turn (Prompt-Zeile + gedämpftes Missions-Risikobudget
  in enforce) und Mikro-Executor (enforce dämpft `riskBudgetPct` vor
  `missionSizedNotional`, gegen `maxRiskPerTrade` geklemmt) — **nie ein
  Veto**. Strategieklasse deterministisch aus dem Mission-Template
  (`strategyClassOfTemplate`); ohne Klasse/Regime-UNKNOWN → Faktor 1
  (fail-safe, nie still).
- **D3 Sichtbarkeit:** Ops-Center-Risk-Sektion mit Gate-Modus + Regime je
  Instrument (nach Schwere sortiert); `regime-history.json` in den
  Cycle-Tagesartefakten (Muster `src/cycle/artifacts.ts`); Audit je
  Regime-Wechsel (`REGIME_CHANGE`, Code `regime:SYMBOL:VON→NACH`) und je
  enforce-Dämpfung (`REGIME_GATE_APPLIED`, `regime-gate:SYMBOL:KLASSE:REGIME`),
  beide im Audit-Katalog dokumentiert.
- **Tests:** `tests/marketRegime.test.ts` — Golden-Cases je Regime
  (synthetische feste Serien) inkl. Grenzfällen (Drawdown exakt auf
  Schwelle, V-Erholung, Slope unter Trend-Schwelle), Hysterese
  (Gegenkerzen/Bestätigung/Unterbrechung/De-Eskalationsfenster),
  Determinismus per FNV-Hash, Gate-Semantik off/monitor/enforce exakt,
  Konfig-Klemmung, Architektur-Garantie. ADX gegen Handrechnung
  (`tests/indicators.test.ts`, Periode 2 → exakt 190/3).
- **Docs:** neues `docs/REGIME_GATE.md` (Klassifikator-Logik, Prioritäten,
  Gate-Modi, Hysterese-Parameter, Abweichungen), `CONFIGURATION.md`
  §„Regime-Gate“, `.env.example`, CHANGELOG 1.46.0 + Status-Header +
  `docs/README.md` + Doku-Katalog.

**Abweichung/Bewusste Entscheidung:** Die Strategieklasse wird aus dem
Mission-Template abgeleitet statt über ein neues Schema-Feld auf Regeln
(append-only-Prinzip, keine Migration); Regeln ohne Mission bleiben
ungedämpft (Faktor 1). Die Anreicherung der Zyklus-Steps
(riskStep/selectionStep, bis zu 40 Kerzen-Abrufe je Lauf) ist bewusst
nicht Teil dieses Deltas — die Gate-Wirkung läuft über Engine-Turn und
Mikro-Executor. Siehe `docs/REGIME_GATE.md` §6.
