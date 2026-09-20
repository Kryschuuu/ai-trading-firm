# RMA-P2-01: Regime-Erkennung

- **Antwort:** Teilweise
- **Tracking-Status:** `PARTIAL`
- **Severity:** `MEDIUM`
- **Quick Estimate Restaufwand:** **2–4 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P2-01`](../prompts/PROMPT-P2-01-regime-detection.md)

## Verifizierte Fundstellen

- `src/lib/marketRegime.ts::classifyMarketRegime()` — OHLCV-basierte Trend-/Range-/Volatilitätsklassifikation.
- `src/lib/marketRegime.ts::MarketRegimeStateMachine` — Hysterese.
- `src/lib/marketRegime.ts::applyRegimeGate()` — produktive Risikodämpfung.
- `src/lib/marketRegime.ts::collectRegimeHistoryArtifact()` — Verlaufsartefakt.

## Bewertung und Abgrenzung

Deterministische OHLCV-Regime inklusive CRASH, HIGH_VOL, TREND_UP, TREND_DOWN und RANGE sind produktiv verdrahtet. Der Befund ist nur teilweise erfüllt, wenn die Roadmap ein robustes Marktregime aus Preis, Liquidität, Derivaten und Makro verlangt.

## Konkretes Delta

- Liquiditäts-/Spread-, Perp- und Makromerkmale mit explizitem Missingness-Handling
- Regime-Wahrscheinlichkeiten oder Confidence statt nur harter Klasse
- versioniertes Feature-/Modellartefakt mit as-of-Zeitpunkt
- historische Confusion-/Stabilitätsanalyse und regimebezogene OOS-Auswertung

## Akzeptanzkriterien für `FIXED`

- [ ] Regime ist für denselben As-of-Datenstand reproduzierbar
- [ ] fehlende Featurefamilien können kein implizit bullisches Signal erzeugen
- [ ] Hysterese und Confidence sind getrennt testbar
- [ ] Backtest und Live verwenden dieselbe Feature-/Klassifikationsversion

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
