# Trade-PnL-Attribution (RMA-P1-06, v1.57.0)

Deterministische, versionierte Netto-PnL-Attribution für jeden geschlossenen
Trade. **Deklaration: `DETERMINISTIC_ALLOCATION`** — eine normierte Aufteilung
des realisierten Ergebnisses auf die im Entry-Snapshot dokumentierten
Entscheidungsquellen. Sie ist **keine Kausalanalyse**: Ein positiver Beitrag
eines Agenten belegt nicht, dass er die Ursache des Gewinns war. Kausale
Verfahren (z. B. Shapley) sind bewusst nicht Teil dieser Methode.

## Invariante

Für jede Attribution gilt (erzwungen in `src/attribution/model.ts`):

```
netPnl   = grossPnl − (fees ?? 0) + (funding ?? 0)     // Kontosicht: Funding negativ = gezahlt
| Σ Quellenbeiträge + Σ Kostenbeiträge + Residual − netPnl | ≤ 1e-6
```

- `grossPnl` = realisiertes PnL der Buchungsquelle (`trade_journal.pnl`, vor
  Gebühren; LONG **und** SHORT vorzeichenrichtig).
- `fees`/`funding` sind NULL-bare Fakten: **NULL = unbekannt, nie still 0.**
  Unbekannte Komponenten stehen sichtbar in `unknown_costs` (Teilmenge von
  `[FEES, FUNDING]`).
- Slippage ist nur ein Memo (`slippage_memo`): Sie ist bereits in den
  Fill-Preisen enthalten (Paper-Simulator, Backtest) — ein eigener Posten
  würde sie doppelt zählen.
- Das **Residual** schließt exakt ab und enthält: Rundungsreste (≤ 1e-8 je
  Posten), nicht teilnehmende Masse (Konfidenz 0) und den Konfliktanteil
  widersprüchlicher Stimmen. Residual und Coverage verhindern Scheingenauigkeit.

## Methode `ta1` (Version 1)

**Zulässige Quellen:**

| Typ | Quelle | ID | Version |
| --- | --- | --- | --- |
| `AGENT` | Stimmen der Entscheidungskette (Entry-Snapshot) + Proposer des ausgeführten Vorschlags | Agentenname | Promptversion (`agents.version`) zum Eröffnungszeitpunkt |
| `RULE` | Die auslösende Regel (rule-snapshot) | `trade_rules.rule_key` | `trade_rules.version` |
| `COST` | Bekannte Kostenkomponenten | `FEES` \| `FUNDING` | `ta1` |

**Votes / Abstention / negative Beiträge:**

- Richtungsbelegte `TRADE`-Stimmen (Seite belegt, Symbol passend oder leer)
  erhalten Alignment `+1` (gleichgerichtet) bzw. `−1` (entgegengesetzt →
  negativer Beitrag bei Gewinn).
- `HOLD`/`REPORT`/`APPROVE`/`REJECT`/`KILL`, `TRADE` ohne Seite oder mit
  fremdem Symbol sind **Enthaltungen**: Alignment 0, Beitrag exakt 0, sichtbare
  eigene Postenzeile. Ein `REJECT`/`KILL` wird nicht spekulativ als Gegenstimme
  gewertet (ohne Proposal-Verknüpfung ist nicht belegt, dass es diesen Trade betraf).
- Der **Proposer** ist über die `proposalId` fest gebunden (Alignment `+1`);
  die Proposal-Bindung schlägt die Turn-Auswertung.
- Mehrere Turns desselben Agenten: die chronologisch **letzte** Stimme gewinnt
  (stabile Sortierung nach `at`).
- Bei `RULE`-Trades ist die Regel die **einzige** Quelle — es werden keine
  Agentenstimmen erfunden (`buildRuleSnapshot` legt ohnehin keine an; der Store
  verhindert Doppel-Allokation defensiv).

**Normalisierte Gewichte:**

```
w_i = clamp(confidence_i, 0, 1)          // fehlend → 0.5 (Beta(2,2)-Prior, wie journalAnalytics)
n_i = w_i / Σ w_j                         // über alle Teilnehmer (Alignment ≠ 0)
contribution_i = round8(grossPnl × alignment_i × n_i)
```

Die Quellen teilen immer das **Brutto-PnL**; Kosten sind eigene signierte
Posten (`FEES` → −fees, `FUNDING` → +funding). Widersprüchliche Stimmen
reduzieren die erklärbare Masse (Σ alignment_i × n_i < 1) — der Differenzbetrag
verbleibt im Residual, Konflikte werden nicht weg-gewichtet.

**UNATTRIBUTABLE (fail-closed):**

| Grund | Bedeutung |
| --- | --- |
| `SNAPSHOT_MISSING` | keine Snapshot-Struktur an der Journal-Zeile |
| `SNAPSHOT_SCHEMA_V1` | v1-Snapshot (vor v1.57.0): Stimmen ohne Richtungsdaten, keine Versionskette — raten ist unzulässig |
| `SNAPSHOT_INVALID` | Snapshot unlesbar/strukturell beschädigt |
| `NO_SOURCES` | v2-Snapshot ohne auswertbare Quelle |

UNATTRIBUTABLE-Ergebnisse werden **persistiert** (sichtbare Lücke mit Grund);
bekannte Kosten bleiben trotzdem ausgewiesen, der Rest steht im Residual.
Historische Zeilen werden **niemals** mit geschätzten Quellen gefüllt.

## Entry-Snapshot v2 (`src/lib/journal.ts`)

Neue, unveränderliche Felder (schemaVersion 2): `versions.promptVersion`
(Promptversion des Proposers), `versions.agentVersions` (Agent →
Promptversion), `versions.ruleVersion`/`ruleKey`, `versions.policyVersion`
(Fingerprint `rp1:<sha256>` der wirksamen Risk-Limits via `getLimits()`),
`versions.dataFingerprint` (`df1:<sha256>` der Entscheidungsdaten: Markt-
Snapshot der Engine bzw. Trigger-Snapshot des Mikro-Executors) sowie
`snapshotHash` (`js2:<sha256>` kanonisch über den Snapshot). Stimmen tragen
zusätzlich `symbol`, `side` und `model`. Spätere Prompt-/Regel-/Policy-Änderungen
können historische Attributionen nicht umdeuten — der Backfill behandelt
v1-Snapshots als UNATTRIBUTABLE statt zu raten.

## Persistenz (append-only)

Migration: `drizzle/2026-09-21_trade_attribution.sql` (idempotent; installiert
zusätzlich UPDATE/DELETE/TRUNCATE-Sperren — `npx drizzle-kit push` allein legt
die Trigger **nicht** an; Produktionssysteme sollen die SQL-Datei laufen lassen).

- `trade_attributions` — eine Kopfzeile je (`journal_id`, `method_version`),
  UNIQUE = Idempotenzschlüssel. `closed_at` = Ereigniszeit (Filter aller
  Queries), `computed_at` = Berechnungszeit.
- `trade_attribution_entries` — Posten, UNIQUE je (`attribution_id`,
  `source_type`, `source_id`); `source_id` ist bounded (Agentenname, rule_key,
  `FEES`/`FUNDING`) — keine Instrument-/Order-/Trade-IDs, keine
  High-Cardinality-Metrics-Labels.

## Produktionspfad

`completeJournalRow()` (Monitor-Tick, Engine-Flatten, Micro-Executor-Close)
berechnet und persistiert die Attribution nach dem Close — **fehlertolerant**:
ein Fehler blockiert den Handelsschluss nie und bleibt als
`JOURNAL_ATTRIBUTION_FAILED` im Audit sichtbar (Backfill kann nachziehen).
Backtest-Trades werden über `attributeBacktestTrade()` als Wert attribuiert,
ohne den eingefrorenen `BacktestTradeLog`-Ledger (RMA-P1-04) zu mutieren —
semantisch dieselbe Methode (Strategie als einzige Quelle).

## APIs (Berechtigung `firm.read`, `no-store`)

- `GET /api/firm/journal/attributions?symbol=&regime=&status=&methodVersion=&from=&to=&limit=&entries=true`
  — bounded Detailliste (Limit ≤ 200) + Totals + Coverage + Reconciliation.
- `GET /api/firm/journal/attributions/aggregate?dimension=agent|rule|regime|cost&from=&to=`
  — dimensionale Aggregation; liefert immer Counts, Coverage und die
  serverseitig geprüfte Reconciliation (Δ ≤ 1e-6) mit.

## Betrieb

```bash
npm run attribution:backfill                  # historische Zeilen nachziehen (idempotent, Batch ≤ 1000)
npm run attribution:backfill -- --dry-run     # klassifizieren, nichts schreiben
npm run attribution:backfill -- --from=2026-01-01 --to=2026-09-01
```

Flags: `TRADE_ATTRIBUTION_ENABLED` (Default `true`), `TRADE_ATTRIBUTION_METHOD_VERSION`
(Default `1`) — siehe `CONFIGURATION.md`. Rollback: Tabellen sind rein additiv;
`DROP TABLE trade_attribution_entries; DROP TABLE trade_attributions;` stellt
den v1.56.x-Stand her, falls kein v1.57.0-Code mehr läuft.

## Tests

- `tests/tradeAttribution.test.ts` — reine Modelltests: Reconciliation (LONG/SHORT,
  Gewinn/Verlust, Kosten bekannt/unbekannt), Alignment-Regeln, Enthaltungen,
  Konflikte, Determinismus/Golden, Negative Paths (AttributionError).
- `tests/tradeAttribution.db.test.ts` — Postgres: Roundtrip, Idempotenz
  (Retry/Restart), Methodenwechsel, Backfill (v1 ⇒ UNATTRIBUTABLE, Dry-Run,
  Restart-leer), Aggregate-Reconciliation + Coverage, Close-Wiring, Migration
  idempotent + Append-only-Trigger.
- `tests/tradeAttribution.api.test.ts` — HTTP-Verträge (400-Validierung,
  Dimensionen, `no-store`, Deklarationsanker).
