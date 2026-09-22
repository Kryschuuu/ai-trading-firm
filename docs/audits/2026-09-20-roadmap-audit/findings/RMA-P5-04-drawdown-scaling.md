# RMA-P5-04: Drawdown-basiertes Risk Scaling

- **Antwort:** Ja (v1.68.0)
- **Tracking-Status:** `FIXED` (v1.68.0, PR #166)
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **2–3 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P5-04`](../prompts/PROMPT-P5-04-drawdown-scaling.md)

## Verifizierte Fundstellen

- `src/portfolio/metrics.ts::maxDrawdown()` — Drawdown-Berechnung.
- `src/lib/riskGuard.ts::RiskLimits` und `validateOrder()` — Daily-Loss- und Risikogrenzen.
- `src/db/schema.ts::equitySnapshots` — Equityhistorie.
- `src/lib/adaptiveRisk.ts` — bestehendes Muster für persistierte adaptive Risikofaktoren.

## Bewertung und Abgrenzung

Drawdown kann gemessen und Verlustgrenzen können hart durchgesetzt werden. Es gibt keine kontinuierliche Policy, die unterhalb des Kill-Switches Risiko abhängig vom laufenden High-Water-Mark zurücknimmt und kontrolliert wieder freigibt.

## Konkretes Delta

- kanonischer High-Water-Mark und aktueller Drawdown aus reconcilter Equity
- stückweise/monotone Skalierungsfunktion mit harten Bounds
- Hysterese, Cooldown und Recovery-Schritte gegen Flapping
- Persistenz und Audit jedes Faktorwechsels
- Komposition mit Volatilitätsfaktor ohne Ceiling-Verletzung

## Akzeptanzkriterien für `FIXED`

- [x] wachsender Drawdown kann den Risikofaktor nie erhöhen
- [x] fehlende/stale Equity führt zu konservativem Faktor
- [x] Recovery ist langsamer oder gleich schnell wie Degradation und getestet
- [x] Restart rekonstruiert denselben High-Water-Mark/Faktor

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`. Die Basis ist im
  Repository nach der Branch-Konsolidierung nicht mehr auflösbar; umgesetzt
  wurde die Absicht aus `PROMPT-P5-04` auf dem Stand `413d926`/`v1.67.0`
  (Abweichung in PR #166 dokumentiert).
- Beleg: Commit `ba0cf1d`, Fix-Version `v1.68.0`, PR #166.
- Tests (alle grün): `tests/portfolio.drawdownScaling.test.ts` (39),
  `tests/drawdownScaling.engine.test.ts` (19),
  `tests/riskGuard.drawdownScaling.test.ts` (17),
  `tests/drawdownScaling.db.test.ts` (6, eingebettete Postgres),
  `tests/riskConfigView.test.ts` (+4 für den `dsp.*`-Namensraum).
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
