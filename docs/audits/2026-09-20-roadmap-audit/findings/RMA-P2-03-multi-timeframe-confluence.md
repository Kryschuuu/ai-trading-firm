# RMA-P2-03: Deterministische Multi-Timeframe-Konfluenz

- **Antwort:** Teilweise
- **Tracking-Status:** `FIXED` (v1.62.0, PR [#160](https://github.com/Kryschuuu/ai-trading-firm/pull/160), Commit `4ffee0d`)
- **Severity:** `MEDIUM`
- **Quick Estimate Restaufwand:** **3–5 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P2-03`](../prompts/PROMPT-P2-03-multi-timeframe-confluence.md)

## Verifizierte Fundstellen

- `src/lib/analysts.ts::runTechnicalAnalyst()` — fordert Multi-Timeframe-Ausgabe vom Analysten an.
- `src/lib/marketdata/historicalStore.ts::HistoricalStore.query()` — timeframe-spezifische Historie.
- `src/cycle/steps/technicalStep.ts` — strukturierter technischer Tageszyklus.
- `src/lib/seed.ts` — Rolle als Multi-Timeframe-Analyst, aber keine deterministische Scoreformel.

## Bewertung und Abgrenzung

Mehrere Timeframes sind verfügbar und werden sprachlich vom Agenten zusammengeführt. Das Ergebnis hängt jedoch vom LLM ab; ein identischer Candle-Snapshot garantiert keinen identischen, erklärbaren Konfluenzscore.

## Konkretes Delta

- kanonische Features je Timeframe und explizite Gewichtungs-/Vetoformel
- as-of-Ausrichtung ohne Nutzung unvollständiger höherer Kerzen
- Coverage-/Staleness-/Conflict-Felder im Output
- versionierter deterministischer Konfluenzscore als Agenteninput
- Backtest-/Live-Parität und Golden Fixtures

## Akzeptanzkriterien für `FIXED`

- [ ] keine Look-ahead-Nutzung noch offener HTF-Kerzen
- [ ] identische Daten und Config ergeben identischen Score
- [ ] Konflikt zwischen Timeframes bleibt im Output sichtbar
- [ ] Agententhese darf den deterministischen Basisscore erklären, aber nicht still überschreiben

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)

## Umsetzung (v1.62.0)

- Reine Formel `mtf-confluence@1` (`src/confluence/`): as-of-Ausrichtung
  (`barEnd ≤ asOf`, `availableAt ≤ asOf`), drei bounded Features je
  Timeframe, Coverage/Conflict/Confidence, ABSTAIN fail-closed
  (`null` statt `0`), `snapshotKey` als Idempotency-Kennung.
- Trusted-Data-Integration im technischen Step (`analysis.confluence`,
  `confluenceMeta`) und im Analysten (`agentMessages.meta.confluence`);
  der Validator verwirft LLM-Override-Versuche strukturell.
- Bounded Metrik `confluence_runs_total{result,source}`, Audit-Event
  `confluence_computed`, keine DB-Migration (versionierte Artefakte),
  Rollback via `CONFLUENCE_ENABLED=false`.
- Tests: `tests/confluence.{unit,adapters,cycle}.test.ts` (38) +
  Golden-Fixture; Doku: `docs/MTF_CONFLUENCE.md`.
- Akzeptanzkriterien: keine offene HTF-Kerze (Look-ahead-Tests) ·
  deterministischer Score (Golden/Parität) · sichtbarer Konflikt
  (`conflict-high`, DEGRADED) · kein stilles Überschreiben
  (Validator- + Step-Tests).
