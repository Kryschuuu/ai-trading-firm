# RMA-P1-06: Trade-Attribution auf Agenten, Signale und Faktoren

- **Antwort:** Teilweise
- **Tracking-Status:** `PARTIAL`
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **3–5 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P1-06`](../prompts/PROMPT-P1-06-trade-attribution.md)

## Verifizierte Fundstellen

- `src/lib/journal.ts::DecisionSnapshot`, `buildProposalSnapshot()` und `buildRuleSnapshot()` — Decision Context und Votes.
- `src/lib/journal.ts::completeJournalRow()` — realisierte Trade-Ergebnisse.
- `src/lib/journalAnalytics.ts::computeJournalSummary()` — gruppierte Agent-/Regime-Statistiken.
- `src/db/schema.ts::tradeJournal` — Journalpersistenz.

## Bewertung und Abgrenzung

Ein Trade kann auf Proposal oder Rule und auf damalige Agentenvotes zurückgeführt werden. Die bestehende Statistik verteilt aber Outcomes auf Gruppen beziehungsweise Votes; sie berechnet keine eindeutig spezifizierte additive PnL-Attribution pro Signal/Faktor.

## Konkretes Delta

- normalisiertes, versioniertes Attributionsschema je Trade
- festgelegte Methode für überlappende Agenten-/Faktorbeiträge und Abstentions
- Verknüpfung zu exakt verwendeten Prompt-, Daten-, Feature- und Strategieversionen
- PnL-/Kosten-/Drawdown-Beiträge statt bloßer Win-Rate-Gruppierung
- Reconciliation: Summe der Beiträge plus Residual ergibt realisiertes Trade-PnL

## Akzeptanzkriterien für `FIXED`

- [ ] Attribution ist deterministisch und summiert sich auf das Netto-PnL
- [ ] UNKNOWN/fehlende Quellen bleiben als Residual sichtbar
- [ ] keine nachträgliche Prompt- oder Featuremutation verändert historische Attribution
- [ ] API-Aggregate sind gegen Einzeltrades reconciled

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
