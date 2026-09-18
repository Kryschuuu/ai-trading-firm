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
