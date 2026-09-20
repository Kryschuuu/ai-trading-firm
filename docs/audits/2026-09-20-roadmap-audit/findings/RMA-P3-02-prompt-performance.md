# RMA-P3-02: Prompt-Version-Metrikvergleich

- **Antwort:** Teilweise
- **Tracking-Status:** `PARTIAL`
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **3–5 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P3-02`](../prompts/PROMPT-P3-02-prompt-performance.md)

## Verifizierte Fundstellen

- `src/db/schema.ts::agents.version` — Agentenkonfiguration ist versioniert.
- `src/lib/seed.ts` — Prompt-/Rolleninhalte.
- `src/lib/analysts.ts::recordAnalysis()` — speichert Analysen, aber kein lückenloses Prompt-Artefakt.
- `src/lib/journalAnalytics.ts::computeJournalSummary()` — Outcome-Aggregate ohne Promptversion als kanonische Dimension.

## Bewertung und Abgrenzung

Versionen und Outcomes sind grundsätzlich vorhanden. Nicht jeder Lauf trägt jedoch einen unveränderlichen Prompt-Hash samt Modell-/Parameterkontext; damit können historische Ergebnisse einer Promptvariante nicht zuverlässig zugeordnet werden.

## Konkretes Delta

- immutable Prompt-Version/-Hash je Agentenaufruf
- Model Provider, Modellversion, Samplingparameter, Token-/Kostenmetadaten
- Join auf P3.1-Forecast-Outcomes und Trade-Attribution
- vergleichbare Metriken mit Mindeststichprobe und Zeit-/Regime-Segmentierung
- Promotion-Regel, die keine schlechter kalibrierte Variante allein wegen PnL bevorzugt

## Akzeptanzkriterien für `FIXED`

- [ ] Prompttext wird nicht als Secret-/PII-haltiges unbeschränktes Label verwendet
- [ ] historische Aufrufe bleiben nach Promptänderung unverändert zuordenbar
- [ ] Vergleich berichtet Coverage, Stichprobe und Unsicherheit
- [ ] gleiche Prompt-Hashes werden unabhängig vom Zeilenendeformat stabil erkannt

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
