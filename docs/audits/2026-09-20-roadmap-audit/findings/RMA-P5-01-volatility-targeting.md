# RMA-P5-01: Portfolio-Volatility-Targeting

- **Antwort:** Ja (v1.67.0)
- **Tracking-Status:** `FIXED` (v1.67.0, PR #166)
- **Severity:** `MEDIUM`
- **Quick Estimate Restaufwand:** **2–4 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P5-01`](../prompts/PROMPT-P5-01-volatility-targeting.md)

## Verifizierte Fundstellen

- `src/lib/adaptiveRisk.ts::assessRegime()` und `updateAdaptiveRisk()` — diskrete Volatilitätsregime.
- `src/lib/riskGuard.ts::applyAdaptiveRisk()` — multipliziert harte Risikolimits mit einem Regimefaktor.
- `src/portfolio/metrics.ts::realizedVolatility()` — annualisierte Volatilitätsmessung.
- `src/portfolio/riskGuard.ts::applyRiskGuard()` — nachgelagerte Portfolio-Ceilings.

## Bewertung und Abgrenzung

Risiko sinkt bei erhöhtem oder extremem Volatilitätsregime. Das ist diskrete Dämpfung, kein kontinuierliches Targeting auf eine angestrebte Portfolio-Volatilität unter Berücksichtigung von Korrelationen.

## Konkretes Delta

- konfigurierbares annualisiertes Volatilitätsziel und Forecast-Horizont
- Portfolio-Volatilitätsforecast aus Gewichten und regularisierter Kovarianz
- geklemmter, geglätteter Leverage-/Risk-Multiplikator
- Turnover-/Staleness-Gates und konservativer Missing-Data-Fallback
- Soll-Ist-Monitoring realisierter Volatilität

## Akzeptanzkriterien für `FIXED`

- [ ] Multiplikator ist endlich, begrenzt und kann harte Risk-Ceilings nie erweitern
- [ ] stale/ill-conditioned Inputs reduzieren Risiko
- [ ] Korrelationen werden berücksichtigt statt Einzelvolatilitäten zu addieren
- [ ] Forecast und realisierte Zielabweichung werden versioniert berichtet

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
