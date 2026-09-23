# RMA-P3-02: Prompt-Version-Metrikvergleich

- **Antwort:** Ja (seit v1.65.0)
- **Tracking-Status:** `FIXED` (v1.65.0, [#163](https://github.com/Kryschuuu/ai-trading-firm/pull/163), Commit `040eb9b`)
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **0 PT** (Audit-Schätzung war 3–5 PT)
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

- [x] Prompttext wird nicht als Secret-/PII-haltiges unbeschränktes Label verwendet
- [x] historische Aufrufe bleiben nach Promptänderung unverändert zuordenbar
- [x] Vergleich berichtet Coverage, Stichprobe und Unsicherheit
- [x] gleiche Prompt-Hashes werden unabhängig vom Zeilenendeformat stabil erkannt

## Umsetzung (v1.65.0)

- **Artefakt + Provenanz `src/promptPerformance/`:** LF-Kanonisierung, immutable `promptHash` `pp1:<sha256>`, Run-Ledger `agent_prompt_runs` mit Idempotenz `pr1:`, UNKNOWN statt stiller 0.
- **Metriken/Vergleich:** PIT-Join auf P3.1-Resolutions und P1.6-Attribution; Brier/ECE/HitRate + CIs; Vergleich immer `GATED` (ECE-Wächter, kein Auto-Promote).
- **APIs:** `GET /api/firm/prompts/{artifacts,runs,metrics,compare}` (`firm.read`, no-store, bounded).
- **Doku:** [`docs/PROMPT_PERFORMANCE.md`](../../../PROMPT_PERFORMANCE.md).

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`. Umsetzung auf v1.64.0 → Fix `v1.65.0`.
- Fix: Commit `040eb9b`, [PR #163](https://github.com/Kryschuuu/ai-trading-firm/pull/163).
- Tests: `tests/promptPerformance.canonical.test.ts` (17), `tests/promptPerformance.db.test.ts` (8, eingebettete Postgres).
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
