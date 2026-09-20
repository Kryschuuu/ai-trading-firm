# RMA-P1-05: Backtest↔Paper↔Live-Drift und Strategy-Lifecycle

- **Antwort:** Nein
- **Tracking-Status:** `OPEN`
- **Severity:** `CRITICAL`
- **Quick Estimate Restaufwand:** **8–12 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P1-05`](../prompts/PROMPT-P1-05-lifecycle-drift.md)

## Verifizierte Fundstellen

- `src/lib/ruleService.ts` — immutable Regelversionen mit Aktivierung, Pause, Archivierung und Rollback.
- `src/db/schema.ts::tradeRules` — Regelstatus, Version und Vorgängerreferenz.
- `src/brokers/control-plane/states.ts` — Venue-Zustände; betrifft Brokerfreigabe, nicht Strategieevidenz.
- Repository-Suche nach `strategy_lifecycle`, `BACKTEST_PASSED`, Reality-Gate und automatischer Degradation ergab keinen produktiven Pfad.

## Bewertung und Abgrenzung

Manuelle Regel- und Brokerzustände verhindern unkontrollierte Mutation. Sie messen aber nicht, ob die Strategie ihre in Backtest und Paper erwartete Qualität im Live-Betrieb hält.

## Konkretes Delta

- eigene persistente Lifecycle-State-Machine mit erlaubten Übergängen
- Promotion-Gates aus reproduzierbaren Backtest- und Paper-Evidenzen
- kanonische Backtest↔Paper↔Live-Driftmetriken mit Mindeststichprobe
- automatische Degradation/Halt bei Performance-, Risiko- oder Execution-Drift
- idempotente, auditierte Operator-Overrides und Recovery-Regeln

## Akzeptanzkriterien für `FIXED`

- [ ] kein direkter Übergang von DRAFT nach LIVE
- [ ] jede Transition referenziert unveränderliche Evidenz und Policy-Version
- [ ] Drift-Gates fail-closed bei fehlenden/stalen Daten
- [ ] Degradation ist idempotent, auditiert und reduziert Risiko statt es zu erhöhen

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
