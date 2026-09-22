# RMA-P3-03: Strukturierter Devil’s Advocate

- **Antwort:** Ja
- **Tracking-Status:** `FIXED`
- **Severity:** `MEDIUM`
- **Fix-Version:** `v1.66.0`
- **Umsetzungs-Prompt:** [`PROMPT-P3-03`](../prompts/PROMPT-P3-03-devils-advocate.md)

## Verifizierte Fundstellen

- `src/cycle/steps/devilsAdvocateStep.ts` — Eigener Pipeline-Step nach Research/Backtest und vor finalem Commit.
- `src/devilsAdvocate/` — Vollständiges Falsifikations-Modul (`schemas.ts`, `scoring.ts`, `prompt.ts`, `config.ts`).
- `src/lib/journal.ts` — Persistierter Falsifikationsnachweis in `DecisionSnapshotVersions.devilsAdvocate`.
- `src/app/api/firm/devils-advocate/route.ts` — API-Endpunkt für Status und Falsifikationsanalysen.
- `docs/DEVILS_ADVOCATE.md` — Moduldokumentation mit Formel-, Rollout- und Schutzregeln.

## Bewertung und Abgrenzung

Mehrere Rollen können Vorschläge kritisieren; insbesondere der Risk-Schritt ist ein starkes Sicherheitsgate. Der Devil's Advocate ergänzt eine gezielte Falsifikation der Hypothese mit strukturierter Evidenz, Failure Modes und deterministischem Disagreement-Score.

## Konkretes Delta

- eigene, prompt-injection-gehärtete Devil’s-Advocate-Rolle (`DEVILS_ADVOCATE`)
- Schema `da1` für Gegenhypothese, Evidenz, Falsifikatoren, Risiken und Confidence
- deterministischer Disagreement-/Severity-Score (kann Risiko nur senken oder Review erzwingen)
- persistierter Einfluss auf finale Entscheidung und Abstention im Decision Snapshot
- Evaluation über Feature-Flag und Shadow Mode (`DEVILS_ADVOCATE_SHADOW`)

## Akzeptanzkriterien für `FIXED`

- [x] Rolle sieht nur freigegebenen Snapshot und keine zukünftigen Outcomes
- [x] fehlende Evidenz wird als Unsicherheit markiert (Abstention)
- [x] hoher Disagreement löst Review oder Risikoreduktion aus, nie automatische Risikoerhöhung
- [x] A/B-Auswertung ist an Prompt-/Policy-Version gebunden und im Shadow Mode evaluierbar

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`; umgesetzt in `v1.66.0`.
- Tests: `tests/devilsAdvocate.test.ts`, `tests/cycle.steps.test.ts`, `tests/cycle.integration.test.ts`, `tests/cycle.architecture.test.ts`.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
