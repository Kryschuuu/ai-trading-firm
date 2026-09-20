# RMA-P5-02: Fractional Kelly

- **Antwort:** Ja
- **Tracking-Status:** `VERIFIED`
- **Severity:** `INFO`
- **Quick Estimate Restaufwand:** **0 PT**
- **Umsetzungs-Prompt:** keiner — Kontrollbefund ohne blockerndes Delta

## Verifizierte Fundstellen

- `src/lib/positionSizing.ts::resolveKellyEdge()` — berechnet Full Kelly aus belastbaren Journalstatistiken und verweigert zu kleine/undefinierte Stichproben.
- `src/lib/positionSizing.ts::computePositionSize()` — wendet die konfigurierte Fraction als Notional-Deckel an.
- `src/lib/positionSizing.ts::SIZING_CONFIG_BOUNDS` — begrenzt `kellyFraction` auf `[0, 1]`.
- `tests/positionSizing.test.ts` — Formel-, Zero-Edge-, Missing-Stats- und Ceiling-Tests.

## Bewertung und Abgrenzung

Fractional Kelly ist im produktiven Position-Sizing implementiert, aus realisierten Journalstatistiken abgeleitet und als Deckel hinter harten Risikobudgets wirksam. Negative oder nicht belastbare Edge-Fälle werden konservativ behandelt.

## Konkretes Delta

- Kein blockerndes Roadmap-Delta. Bayesian Kelly oder shrinkage-basierte Schätzer wären separate Erweiterungen.

## Akzeptanzkriterien für `FIXED`

- [ ] Kontrollbefund bleibt durch Formel-, Bounds- und Integrationstests abgesichert

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
