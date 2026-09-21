# RMA-P1-06: Trade-Attribution auf Agenten, Signale und Faktoren

- **Antwort:** Ja (seit v1.57.0)
- **Tracking-Status:** `FIXED`
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **0 PT** (Audit-Schätzung war 3–5 PT)
- **Umsetzungs-Prompt:** [`PROMPT-P1-06`](../prompts/PROMPT-P1-06-trade-attribution.md)

## Verifizierte Fundstellen

- `src/attribution/` — Attributionsmodul: `model.ts` (reine Berechnung, Methode `ta1`), `store.ts` (append-only Persistenz, Idempotenz, Detail-/Aggregat-Queries, Backfill), `config.ts` (Env-Flags), `hashes.ts` (kanonische Fingerprints), `types.ts` (Vertrag), `README.md` (Spezifikation).
- `src/lib/journal.ts::DecisionSnapshot` — Entry-Snapshot v2 mit Versionskette (`promptVersion`, `agentVersions`, `ruleVersion`/`ruleKey`, `policyVersion`, `dataFingerprint`) und kanonischem `snapshotHash`; `completeJournalRow()` attribuiert beim Close (fail-safe).
- `src/lib/analysts.ts` / `src/lib/engine.ts` — Promptversionen (`agents.version`) fließen in Snapshot und Forecast-Capture.
- `src/db/schema.ts::tradeAttributions`, `tradeAttributionEntries` + Migration `drizzle/2026-09-21_trade_attribution.sql` (append-only, idempotent, UPDATE/DELETE/TRUNCATE-Sperren).
- `src/app/api/firm/journal/attributions/` (+ `/aggregate`) — bounded Read-APIs mit Coverage und Reconciliation.
- `scripts/attribution-backfill.ts` (`npm run attribution:backfill`) — idempotenter Backfill; v1-Altzeilen werden `UNATTRIBUTABLE` erfasst, nie geschätzt.

## Bewertung und Abgrenzung

Jeder geschlossene Trade erhält eine versionierte, deterministische Attribution (Methode `ta1`, `DETERMINISTIC_ALLOCATION`): Die Quellenbeiträge (richtungsbelegte Stimmen der Entscheidungskette bzw. die auslösende Regel) plus Kostenposten (Gebühren, Funding) plus ein **explizites Residual** ergeben **exakt** das realisierte Netto-PnL (erzwungene Reconciliation, Toleranz 1e-6). Enthaltungen tragen Beitrag 0 und bleiben sichtbar; widersprüchliche Stimmen erhalten negative Beiträge, der Konfliktanteil verbleibt im Residual. Unbekannte Kosten sind `null`, nie still 0 (`unknown_costs`). Die Methode behauptet ausdrücklich keine Kausalität; Shapley ist keine Roadmap-Entscheidung dieses Changes. Historische Attributionen hängen nur vom unveränderlichen Entry-Snapshot ab — spätere Prompt-/Regel-/Policy-Änderungen können sie nicht umdeuten; v1-Snapshots (Altbestand) werden fail-closed als `UNATTRIBUTABLE` mit Grund persistiert.

## Konkretes Delta — umgesetzt

- normalisiertes, versioniertes Attributionsschema je Trade — `trade_attributions` (Kopf, Unique `journal_id`+`method_version`) + `trade_attribution_entries` (Posten, Unique `attribution_id`+`source_type`+`source_id`)
- festgelegte Methode für überlappende Agenten-/Faktorbeiträge und Abstentions — normierte Confidence-Gewichte (fehlend → Beta(2,2)-Prior 0.5), letzte Stimme je Agent, Proposal-Bindung schlägt Turn-Auswertung, Regel-Trades ohne erfundene Stimmen
- Verknüpfung zu exakt verwendeten Prompt-, Daten-, Feature- und Strategieversionen — Entry-Snapshot v2 mit `versions.*` + `snapshotHash`
- PnL-/Kosten-Beiträge statt bloßer Win-Rate-Gruppierung — signierte Beiträge je Quelle, Kosten als eigene Posten, Slippage nur Memo (bereits in Fill-Preisen)
- Reconciliation: Summe der Beiträge plus Residual ergibt realisiertes Trade-PnL — Modell-invariante (≤ 1e-6) plus serverseitig geprüfte Aggregat-Reconciliation und Coverage in beiden Read-APIs

## Akzeptanzkriterien für `FIXED`

- [x] Attribution ist deterministisch und summiert sich auf das Netto-PnL — `computeTradeAttribution()` (rein, keine Uhr/kein Zufall); Reconciliation erzwungen (`assertReconciliation`, Toleranz 1e-6); Tests: `tests/tradeAttribution.test.ts` (Reconciliation LONG/SHORT, Gewinn/Verlust, Kosten bekannt/unbekannt; Determinismus/Golden).
- [x] UNKNOWN/fehlende Quellen bleiben als Residual sichtbar — `UNATTRIBUTABLE` mit geschlossenem Grund (`SNAPSHOT_MISSING`/`SNAPSHOT_SCHEMA_V1`/`SNAPSHOT_INVALID`/`NO_SOURCES`), `unknown_costs` für nicht quantifizierbare Kosten; Backfill-Test belegt persistierte sichtbare Lücken ohne geschätzte Quellen.
- [x] keine nachträgliche Prompt- oder Featuremutation verändert historische Attribution — Entry-Snapshot v2 (unveränderlich, `snapshotHash`); Agentenversionen kommen aus dem Snapshot, nicht aus aktuellen Agentenzeilen; Test „Methodenwechsel erhält alte Ergebnisse".
- [x] API-Aggregate sind gegen Einzeltrades reconciled — `aggregateTradeAttributions()` prüft Σ Quellen + Σ Kosten + Σ Residual = Σ Netto (Δ ≤ 1e-6) serverseitig; DB-Test „Aggregate reconciligen gegen Details" vergleicht zusätzlich gegen die Detailzeilen und die Coverage-Quote.

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`; Umsetzung auf `df022dd` (v1.56.0) — `df3163e` ist im Repository nicht auflösbar (bereits in PR #151 dokumentierte Basis-Abweichung).
- Testevidenz: 31 neue Tests (`tests/tradeAttribution.test.ts` 20, `tests/tradeAttribution.db.test.ts` 7 — inkl. eigener Wegwerf-Postgres für Migrations-/Trigger-Vertrag, `tests/tradeAttribution.api.test.ts` 4) + angepasste Regressionen (`tests/tradeJournal.test.ts` auf Snapshot v2 erweitert, FK-korrekte Cleanups in `tests/monitor.exits.test.ts` und `test/integration/orderIntents.submitAtomic.test.ts`); `npm run typecheck`, `npm run lint` (0 Errors), `npm run docs:validate` grün; vollständige Suite grün (Details im PR).
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
