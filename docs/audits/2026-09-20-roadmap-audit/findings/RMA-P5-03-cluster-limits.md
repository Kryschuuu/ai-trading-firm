# RMA-P5-03: Korrelations- und Cluster-Limits

- **Antwort:** Ja
- **Tracking-Status:** `VERIFIED`
- **Severity:** `INFO`
- **Quick Estimate Restaufwand:** **0 PT**
- **Umsetzungs-Prompt:** keiner — Kontrollbefund ohne blockerndes Delta

## Verifizierte Fundstellen

- `src/portfolio/riskGuard.ts::applyRiskGuard()` — Symbol-, Cluster- und Bruttoexposure-Grenzen.
- `src/portfolio/riskGuard.ts::assertAuthorityChain()` — nachvollziehbare Reihenfolge der Kontrollstufen.
- `src/cycle/steps/riskStep.ts` — reicht Korrelationsmatrix und Cluster in den Risikopfad.
- `tests/portfolio.riskGuard.test.ts` — Cluster-/Exposure- und Determinismustests.

## Bewertung und Abgrenzung

Gewichte werden gegen per-Symbol-, per-Cluster- und Gesamtgrenzen geprüft beziehungsweise reduziert. Korrelation und Cluster liegen im Portfolioentscheid vor und die Authority Chain verhindert ein späteres Wiederaufweiten.

## Konkretes Delta

- Kein blockerndes Roadmap-Delta. Dynamische Clusterstabilität kann separat beobachtet werden, ändert den Erfüllungsstatus aber nicht.

## Akzeptanzkriterien für `FIXED`

- [ ] Kontrollbefund bleibt durch Cluster-, Ceiling- und Authority-Chain-Tests abgesichert

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
