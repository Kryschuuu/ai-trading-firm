# RMA-P5-04: Drawdown-basiertes Risk Scaling

- **Antwort:** Teilweise
- **Tracking-Status:** `PARTIAL`
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

- [ ] wachsender Drawdown kann den Risikofaktor nie erhöhen
- [ ] fehlende/stale Equity führt zu konservativem Faktor
- [ ] Recovery ist langsamer oder gleich schnell wie Degradation und getestet
- [ ] Restart rekonstruiert denselben High-Water-Mark/Faktor

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
