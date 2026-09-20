# RMA-P3-03: Strukturierter Devil’s Advocate

- **Antwort:** Nein
- **Tracking-Status:** `OPEN`
- **Severity:** `MEDIUM`
- **Quick Estimate Restaufwand:** **2–4 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P3-03`](../prompts/PROMPT-P3-03-devils-advocate.md)

## Verifizierte Fundstellen

- `src/cycle/steps/riskStep.ts` — unabhängiger Risk Review mit harten Risikogrenzen.
- `src/cycle/steps/researchStep.ts` und CEO-/Investment-Schritte — mehrstufige Entscheidung.
- `src/lib/journal.ts::JournalVote` — Votes können im Decision Snapshot liegen.
- Keine eigene Rolle beziehungsweise Schema für Gegenhypothese, Falsifikatoren und Disagreement gefunden.

## Bewertung und Abgrenzung

Mehrere Rollen können Vorschläge kritisieren; insbesondere der Risk-Schritt ist ein starkes Sicherheitsgate. Das erfüllt nicht den Research-Zweck eines Devil’s Advocate, der die These gezielt falsifiziert und sein Ergebnis strukturiert messbar macht.

## Konkretes Delta

- eigene, prompt-injection-gehärtete Devil’s-Advocate-Rolle
- Schema für Gegenhypothese, Evidenz, Falsifikatoren, Risiken und Confidence
- deterministischer Disagreement-/Severity-Score
- persistierter Einfluss auf finale Entscheidung und Abstention
- Evaluation des inkrementellen Nutzens gegen eine Baseline ohne Rolle

## Akzeptanzkriterien für `FIXED`

- [ ] Rolle sieht nur freigegebenen Snapshot und keine zukünftigen Outcomes
- [ ] fehlende Evidenz wird als Unsicherheit markiert
- [ ] hoher Disagreement löst Review oder Risikoreduktion aus, nie automatische Risikoerhöhung
- [ ] A/B-Auswertung ist an Prompt-/Policy-Version gebunden

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
