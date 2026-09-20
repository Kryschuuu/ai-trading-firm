# Regelbasierte Backtesting-Engine mit Walk-Forward-Validierung (GAP-01)

**Stand:** 2026-09-20 · **Modul:** `src/backtest/` · **Version:** `1.52.0` · **Status:** Implementiert

Diese Datei beschreibt die Walk-Forward-Erweiterung der Backtest-Engine:
strikte Zeitmaske, Paper-Ausführung über den Paper-Fill-Simulator,
rollierende IS/OOS-Fenster, vergleichbar persistierte Runs samt
Trade-Ledger (`backtest_trades`, RMA-P1-04) und die CLI.
Die Engine-Basis (Event-Schleife, Portfolio, Legacy-Kostenmodell) steht in
[BACKTEST_ENGINE.md](BACKTEST_ENGINE.md); das Kostenmodell im Paper-Betrieb
in [PAPER_TRADING.md](PAPER_TRADING.md) (§3).

---

## 1. Architektur-Überblick

```mermaid
flowchart TD
    A[CLI scripts/run-backtest.ts\n--instrument --timeframe --from --to\n--rule-id oder --rule-file] --> B[HistoricalStore\nKerzen EINES Instruments EINES Timeframes]
    B --> C[Walk-Forward-Lauf\nsrc/backtest/walkforward.ts]
    C --> D[Je Fenster: IS-Eval + OOS-Eval\ndurch runMultiAssetBacktest]
    D --> E[Paper-Ausführung\nsrc/backtest/paperExecution.ts\nFillSimulator wie PaperBroker]
    E --> F[Kennzahlen aus src/portfolio\nMaxDD, Profit Factor, Sharpe, Sortino]
    F --> G[Report: Aggregate + Fenster\n+ Trade-Hashes]
    G --> H[data/backtest/<runId>.json + .md]
    G --> I[(backtest_runs + backtest_trades\nEINE Transaktion, idempotent)]
    I --> J[GET /api/firm/backtests\nGET /api/firm/backtests/[id]\nGET /api/firm/backtests/[id]/trades\nfirm.read]
```

Schichten-Trennung (bewusst):

- `src/backtest/` liegt AUSSERHALB von `src/cycle/` — Zyklus und Engine
  bleiben getrennt. Der Zyklus-Step (`08-backtest-verification`) nutzt die
  Engine nur lesend zur Setup-Verifikation.
- Reine Arithmetik: `src/backtest/**` importiert kein LLM-Modul
  (Architektur-Test in `tests/backtest.engine.test.ts`). LLM-Signale lassen
  sich später via gespeicherte Artefakte replayen — out of scope.
- Die Engine macht kein IO (kein Store-, kein Registry-, kein DB-Zugriff):
  Kerzen, Instrumente und Kostenprofil werden injiziert. Dadurch ist jeder
  Lauf deterministisch testbar.

---

## 2. Zeitmaske (Lookahead-Garantie)

**Regel:** An jedem Zeitschritt `t` sehen Signalerzeugung, Indikatoren und
Fills ausschließlich Daten mit Zeitstempel `≤ t`.

Umsetzung:

1. Die Engine sortiert alle Kerzen nach Zeit und iteriert eine gemeinsame
   Timeline. Pro Symbol wird nur das Präfix bis zum aktuellen Index
   übergeben (`series.slice(0, index + 1)`) — spätere Kerzen sind für
   `buildSnapshotFromCandles` und die Regel-Evaluierung strukturell
   unerreichbar.
2. Jeder Walk-Forward-Fensterlauf bekommt zusätzlich einen `from`/`to`-Clip
   der Engine: OOS-Läufe sehen keine IS-fremden Kerzen und umgekehrt.
3. Fills nutzen den Referenzkurs der Entscheidungs-Kerze (Close bzw.
   SL/TP-Trigger) — nie Future-Kurse.

Tests (`tests/backtest.engine.test.ts`, Abschnitt „Lookahead-Garantie“):

- **Präfix-Test:** Lauf A über 100 Kerzen vs. Lauf B über dasselbe Präfix +
  40 Trend-Umkehr-Kerzen (die jede Full-Series-Kennzahl verschieben würden).
  Alle Einstiege bis `t` und alle bis `t` abgeschlossenen Trades sind
  byte-identisch (Hash-Vergleich der Trade-Liste). Ein Zeitmasken-Fehler
  (z. B. Indikator über die volle Serie) macht diesen Test rot.
- **Mutationstest:** Umgekehrte Eingabereihenfolge liefert identische
  Trades, Kennzahlen und Equity-Kurve (Entscheidungen hängen an der Zeit,
  nicht an der Eingabereihenfolge).
- **Fenster-Zeitmaske:** OOS-Fenstergrenzen schließen exakt an IS an; die
  OOS-Segmente kacheln lückenlos (Nachweis im Report).

---

## 3. Ausführung & Kostenmodell (kein zweiter Kosten-Code-Pfad)

Walk-Forward-Runs laufen IMMER mit `executionModel: "paper"`
(`src/backtest/paperExecution.ts`). Einstiegs- und Ausstiegs-Fills gehen
durch DIESELBE deterministische `FillSimulator`-Klasse
(`src/lib/marketdata/simulator.ts`), die `createPaperExecution`
(`src/lib/marketdata/production.ts`) in den PaperBroker injiziert:

| Baustein | Paper-Betrieb | Backtest (diese Engine) |
|---|---|---|
| Fill-Preis, Taker-Gebühr, Slippage, Partial Fills | `FillSimulator.simulate` | `FillSimulator.simulate` (dieselbe Klasse) |
| Simulator-Konfiguration | `calibrateSimulatorConfig(loadSimulatorConfig())` | dieselbe Quelle (CLI) |
| Kerze/Ticker → Snapshot | `snapshotFromLastPrice` (Bitunix-/Alpaca-Paper) | `snapshotFromLastPrice` (Kerzen-Close) |
| Spread | Registry-`instrument.spread` (via `calculateRelativeSpread` angereichert) → `PAPER_SPREAD_FALLBACK_BPS`-Fallback | identisch gestuft (`effectiveSpreadDecimal`) |
| Funding | `FundingAccrualEngine` + `computeFunding` im Monitor-Tick | dieselbe Engine + Formel je Kerze |

Details und bewusste Grenzen:

- **Quotes aus Kerzen:** Bid/Ask werden symmetrisch aus dem Spread-Modell
  um den Referenzkurs konstruiert (LONG füllt am Ask, SHORT am Bid —
  identische Semantik wie bei echten Level-1-Feeds). Kerzen-Volumen ist
  kein 24h-Volumen: Der Simulator nutzt ehrlich seinen
  `volume24hFallback` (keine hochgerechnete Schein-Liquidität).
- **SL/TP-Trigger** sind Marktstruktur, kein Execution: Die Erkennung je
  Kerze (`detectExitTrigger`) hat bei Kollision Stop-Vorrang (konservativ,
  wie der Legacy-Pfad); der FILL zum Trigger-Preis läuft durch den
  Simulator (Taker-Gebühr — konservativer als das Legacy-Limit-Fill).
- **Funding:** Nur eindeutig als Perpetual erkannte Instrumente
  (`marketType === "perpetual"` aus der Registry) werden belastet;
  unbekannte Symbole bekommen ein neutrales Spot-Default (fail-safe: keine
  erfundenen Kosten). Rate-Default `0` = neutral (wie Paper).
- **Partial Fills:** Mit Default-Konfiguration (`partialFillEnabled: false`)
  füllt jede Order vollständig. Ist die Option an, wird der füllbare Anteil
  verbucht (die Engine hat kein Orderbuch für Restmengen — dokumentierte
  Einschränkung, sichtbar an `filledQty` vs. Notional).
- **Legacy-Pfad:** `executionModel: "legacy"` (Default) ist der
  eingefrorene Task-02-Simulator (`src/backtest/simulator.ts`) —
  Byte-kompatibel für bestehende Läufe/Tests, aber nicht mehr
  weiterentwickelt. Neue, vergleichbar persistierte Runs nutzen `"paper"`.

---

### 3.1 Perpetual-Funding aus der Ablage (RMA-P2-02, v1.54.0)

`scripts/run-backtest.ts` speist die Funding-Accrual-Engine über
`createPerpFundingRateProvider` (`src/perpdata/consumers.ts`) — dieselbe Engine
und dieselbe Formel wie im Paper-Betrieb, nur mit historischen Raten aus
`perp_funding_rates`. Drei Punkte machen das replay-sicher:

* **as-of**: geladen wird `event_time ≤ asOf` **und** `available_at ≤ asOf`;
  ein Satz, den es zum Zeitpunkt noch nicht gab, existiert für den Backtest
  nicht. Die Provider-Lesung ist auf `toMs` begrenzt.
* **nur fällige Settlements**: `replayPositionFunding` bucht jede Rate genau
  einmal je Position und Intervall (`hiddenRows`, `missingMarks`,
  `qualityFlagged` im Ergebnis); Sätze außerhalb der Haltedauer werden
  ausgewiesen, nicht verrechnet.
* **fehlend bleibt fehlend**: ohne `PERP_DATA_ENABLED=true`, ohne Daten oder
  bei unbelegbarer Qualität (`INVALID`/`DUPLICATE`/`CROSSCHECK`/`UNKNOWN`)
  liefert der Provider `null` — die Engine rechnet dann wie vor v1.54.0
  (statischer `PAPER_FUNDING_RATE_PCT_PER_8H`-Pfad bleibt unverändert), nie mit
  einer erfundenen 0-Rate. Treffer/Zähler: `provider.stats()`.

Details: [PERPETUAL_DATA.md](PERPETUAL_DATA.md) §1, §4, §6 und
[../CONFIGURATION.md](../CONFIGURATION.md#perpetual-daten-rma-p2-02-v1540).

## 4. Walk-Forward-Fenster (IS/OOS)

Konfiguration (`src/backtest/walkforward.ts`, Flags in
[CONFIGURATION.md](../CONFIGURATION.md)):

| Flag | Default | Bounds | Bedeutung |
|---|---|---|---|
| `WF_IS_WINDOW_DAYS` | `90` | [14, 720] | Länge des In-Sample-Fensters (Tage) |
| `WF_OOS_WINDOW_DAYS` | `30` | [7, 180] | Länge des Out-of-Sample-Fensters (Tage) |
| `WF_MAX_SPAN_DAYS` | `730` | [30, 3650] | Maximaler Backtest-Zeitraum (Anti-Overfitting-Deckel, Default 2 Jahre) |

Layout (klassisch, vorwärts-rollierend): Fenster 0 startet am
Zeitraum-Anfang mit IS + OOS; jedes weitere Fenster rückt um EINE
OOS-Länge vor. Nur VOLLSTÄNDIGE Fenster werden gelegt — ein angebrochenes
Restfenster wird verworfen. OOS-Segmente kacheln lückenlos und
überlappungsfrei; IS-Fenster dürfen überlappen (Standard). Übersteigt der
Zeitraum den Deckel, wird am Anfang gekappt (jüngste Daten gewinnen,
`truncated: true` im Report).

Jedes Fenster ist ein EIGENSTÄNDIGER Evaluations-Lauf (keine
fensterübergreifenden Positionen). Report je Fenster: Kennzahlen IS/OOS +
Trade-Hash (sha256 über die kanonische Trade-Liste) sowie Aggregate über
alle Fenster. Aggregate werden aus Summen NEU berechnet (kein Mittel über Raten);
Sharpe/Sortino/MaxDD über die verkettete
Fenster-Renditenreihe (dokumentierte Näherung, kein fiktiver Kontoverlauf).

Fail-closed: Trägt der Zeitraum kein vollständiges IS+OOS-Fenster, wirft
der Runner `walkforward:insufficient-span` (statt zu raten); ohne Kerzen
`walkforward:no-candles`.

---

## 5. Run-Persistenz & Read-API

Tabelle `backtest_runs` (append-only, Migration
`drizzle/2026-09-19_backtest_runs.sql`, Stil wie `rule_backtests`): ein
Walk-Forward-Lauf = EINE Zeile (insert-only, kein Update-Pfad) mit
`paramsJson` (Regel-Ref + Regel-Spezifikation + Fenster + Kostenprofil),
`metricsJson` (Aggregate OOS/IS), `windowsJson` (Kennzahlen + Trade-Hash je
Fenster) und `codeVersion` (Vergleichbarkeit über Releases). Seit v1.52.0
zusätzlich (additiv, Migration `drizzle/2026-09-20_backtest_trades.sql`):
`idempotency_key` (partiell UNIQUE), `trade_count`, `reconciliation_status`
(`RECONCILED`) und `reconciliation_json` (Abgleich-Evidenz, §5.1). Alt-Runs
tragen dort `NULL` — „kein Ledger persistiert“, nie „0 Trades“.

Zugriff (kein POST-Endpunkt — Runs entstehen NUR via CLI):

- `GET /api/firm/backtests?limit=1..100` (Default 20) — Liste, jüngste
  zuerst. Lädt NIE Trade-Zeilen (nur die Run-Zeile inkl. `tradeCount` /
  `reconciliationStatus`).
- `GET /api/firm/backtests/[id]` — ein Run per UUID (404 wenn unbekannt);
  additiv um `ledger`, `trades` (erste Seite) und `links.trades` ergänzt
  (§5.2). Bestehende Felder (`run`) sind unverändert.
- `GET /api/firm/backtests/[id]/trades` — Trade-Ledger paginiert (§5.2).

Alle verlangen `firm.read` (SEC-02-Muster, `no-store`) und melden einen
unerreichbaren DB-Stand als `503 BACKTEST_RUNS_UNAVAILABLE` mit
Handlungs-Hinweis (fail-closed statt leerer Liste).

### 5.1 Trade-Ledger `backtest_trades` (RMA-P1-04)

Ein Run ohne seine Trades war bis v1.51.x nur ein Aggregat: die Trade-Logs
wurden nach der Hash-Bildung verworfen. Seit v1.52.0 ist jeder Trade eines
Runs als eigene Zeile persistiert — die **Trade-Level-Wahrheitsquelle**
für Attribution (P1.6), Audits und Reproduzierbarkeit.

**Schema** (Modul `src/backtest/tradeLedger.ts`, reine Abbildung
`WalkForwardTradeRecord` → Zeile; Drizzle `backtestTrades`):

| Spalte | Typ | Bedeutung / Einheit / Rundung |
|---|---|---|
| `id` | uuid PK | technische Zeilen-ID |
| `run_id` | uuid FK → `backtest_runs.id` | **ohne** `ON DELETE CASCADE` (Repo-Konvention: Trades verhindern das Löschen ihres Runs) |
| `seq` | int, `UNIQUE (run_id, seq)`, ≥ 1 | stabile Sequenz in Report-Reihenfolge: Fenster ↑, IS vor OOS, Engine-Schließreihenfolge — Keyset-Cursor |
| `window_index` / `segment` | int ≥ 0 / `IS`·`OOS` | Walk-Forward-Fenster und Evaluationssegment |
| `trade_ref` | text, `UNIQUE (run_id, window_index, segment, trade_ref)` | Engine-Trade-ID (`POS-n`, je Fenster/Segment eindeutig) |
| `strategy_id`, `symbol`, `side` | text / `LONG`·`SHORT` | Strategie-Item, Instrument-ID (Replay-Ziel), Richtung |
| `qty` (> 0), `notional` (≥ 0) | numeric | Basismenge (roh) und Einstiegs-Notional in Quote (4 Stellen) |
| `entry_ts` / `exit_ts` | timestamptz, `exit ≥ entry` | Zeitstempel der Kerze, deren Schluss den Fill bepreist hat (Engine-`entryTime`/`exitTime`) |
| `entry_price` / `exit_price` | numeric > 0 | **Fill-Preise** des Paper-Simulators (Slippage/Spread bereits enthalten, roh) |
| `pnl_gross` | numeric | `qty · Δpreis` (8 Stellen), aus den Fill-Preisen abgeleitet |
| `pnl_net` | numeric | Engine-`pnl` = `pnl_gross − fees + funding` (4 Stellen; Identität wird beim Mappen geprüft, Toleranz 0,0002) |
| `pnl_pct` | numeric | `pnl_net / notional · 100` (4 Stellen) |
| `fees` (≥ 0), `slippage` (≥ 0) | numeric | Gebühren Ein- + Ausstieg (4 Stellen); Slippage-Kosten informativ (4 Stellen, bereits in den Fill-Preisen) |
| `funding` | numeric NULL-bar | Funding je Trade (8 Stellen, negativ = gezahlt); `NULL` = nicht ausgewiesen (≠ 0) |
| `exit_reason` | text (CHECK) | `STOP_LOSS`·`TAKE_PROFIT`·`SIGNAL_EXIT`·`MAX_HOLDING`·`RISK_STOP`·`END_OF_DATA` |
| `duration_bars` | int ≥ 1 | Haltedauer in Kerzen; `durationMs` wird aus den Zeitstempeln abgeleitet (keine redundante Spalte) |
| `provenance_json` | jsonb | `{v:1, source:"walk-forward", engineTradeId, windowFrom, windowTo, ruleSignature, executionModel, simulatorSeed}` |
| `created_at` | timestamptz | Schreibzeitpunkt (= Run-`created_at`, Berechnungszeitpunkt) |

Alle Zahlen werden als endliche Dezimal-Strings geschrieben (`decimalString`:
kein `NaN`/`Infinity`/Exponent) und mit `Number()` gelesen; das Mapping ist
verlustfrei (`tradeRowToLog(row)` reproduziert das Engine-Log exakt, Test
„Roundtrip“). Ungültige Trades (nicht endlich, `qty ≤ 0`, Preis ≤ 0,
negative Gebühren, `exit < entry`, unbekannte Enums, verletzte
PnL-Identität, Reihenfolgebruch, doppelte Trade-ID) werden **vor** jedem
DB-Zugriff mit `TradeLedgerError` (`ledger:invalid-trade` /
`ledger:invalid-report`) abgewiesen.

**Atomarer, idempotenter Write** (`persistBacktestRun` in
`src/backtest/runStore.ts`):

1. Mapping + Abgleich (unten) laufen rein im Speicher; scheitern sie,
   wird nichts geschrieben.
2. Innerhalb EINER Transaktion: Lookup über `idempotency_key` → existiert
   der Run, wird er (nach Prüfung von Trade-Anzahl und Fenster-Hashes)
   als Replay zurückgegeben (`created: false`, gleiche UUID); sonst
   Run-Zeile + Trade-Zeilen (Chunks à 250) einfügen, **Read-back** aller
   Zeilen aus der Transaktion, erneuter Abgleich — erst bei identischer
   Evidenz `COMMIT`. Jeder Fehler (DB-Constraint, Exception, Read-back-
   Abweichung) rollt Run UND Trades zurück (Test „Fehler bei Trade N“).
3. Idempotency-Key (Default): `wf1:` + sha256 über die Lauf-Identität
   (Art, Instrument, Timeframe, Zeitraum, Regel-Signatur + -Symbol,
   Fensterparameter, Kostenprofil, Code-Version, Trade-Hashes aller
   Fenster) — ohne `createdAt`, damit ein Retry desselben Laufs denselben
   Key ergibt. Der partielle UNIQUE-Index löst auch parallele Retries auf
   (SQLSTATE 23505 ⇒ erneuter Lookup ⇒ Replay): nie zwei Runs, nie
   doppelte Sequenzen. Gleicher Key mit anderem Inhalt ⇒
   `ledger:idempotency-conflict` (kein stilles Replay); eine Run-UUID mit
   fremdem Key ⇒ `persist:run-id-conflict`.
4. Audit (Klasse `telemetry`, nach dem Commit): `BACKTEST_RUN_PERSISTED`
   (INFO) bzw. `BACKTEST_RUN_PERSIST_FAILED` (WARN, mit Fehlercode);
   bounded Metrik `backtest_run_persist_total{result,reason}`
   (`created` · `replayed` · `failed`).

**Abgleich Ledger ↔ Run-Aggregate** (`reconcileTradeLedger`, Evidenz in
`reconciliation_json`): je Fenster × Segment und je Aggregat werden
verglichen — Trade-Anzahl und Gewinner (exakt), Netto-PnL (exakt gegen das
4-stellige `netPnl` des Reports), Gebühren und Slippage
(|Δ| ≤ 0,005 + n · 5·10⁻⁵, weil die Fenster-Kennzahlen auf 2 Stellen, die
Trade-Werte auf 4 Stellen gerundet sind), Funding (|Δ| ≤ 10⁻⁶ + n · 10⁻⁸)
und der **Trade-Hash** (`hashTrades(rows → logs)` muss dem gespeicherten
`tradeHash` gleichen). Jede Abweichung ⇒ `ledger:reconciliation-mismatch`,
der Run wird **nicht** geschrieben (kein Status „inkonsistent“ in der DB —
inkonsistente Runs existieren nicht). Der Equity-PnL (`pnl`, aus der
Equity-Kurve) darf vom Ledger-PnL (`netPnl`, Σ Trades) abweichen: die
Differenz ist die END_OF_DATA-Glattstellung nach dem letzten Snapshot und
wird als `equityLedgerGap` ausgewiesen, nicht kaschiert.

**Volumen & Query-Plan:** Ein Run erzeugt typischerweise 10²–10⁴ Zeilen
(Fensteranzahl × Trades je Fenster; `WF_MAX_SPAN_DAYS` deckelt implizit).
Gemessen (PostgreSQL 17, 20 000 Zeilen eines Runs): ≈ 3,8 MB Heap, ≈ 11 MB
inkl. Indizes (≈ 550 B/Zeile). Alle Lesepfade sind Index-Range-Scans ohne
Sort-Knoten:

| Query | Plan |
|---|---|
| Keyset-Seite `run_id = ? AND seq > ? ORDER BY seq LIMIT n+1` | `Index Scan using backtest_trades_run_seq_unique` |
| Filter `window`/`segment` | `Index Scan using backtest_trades_run_window_idx (run_id, window_index, segment, seq)` |
| Filter `symbol` | `Index Scan using backtest_trades_run_symbol_idx (run_id, symbol, seq)` |
| Existenz/Zählung je Run, FK-Prüfung beim Löschen | `backtest_trades_run_seq_unique` |

**Retention/Löschung:** Es gibt — wie für `backtest_runs` — keinen
Lösch-Endpunkt und kein Cascade. Ein Run mit Ledger lässt sich nur
löschen, wenn zuerst seine Trades gelöscht werden (`DELETE FROM
backtest_trades WHERE run_id = …`, dann der Run); ein Retention-Job wäre
ein eigenes, dokumentiertes Vorhaben (bewusst nicht Teil von RMA-P1-04).
Rollback der Migration (nur wenn nötig, verliert das Ledger):
`DROP TABLE backtest_trades; ALTER TABLE backtest_runs DROP COLUMN
reconciliation_json, DROP COLUMN reconciliation_status, DROP COLUMN
trade_count, DROP COLUMN idempotency_key;` — Alt-Code (v1.51.x) liest die
Run-Zeile danach unverändert.

### 5.2 Read-API des Trade-Ledgers

`GET /api/firm/backtests/[id]/trades` (und dieselben Parameter auf
`GET /api/firm/backtests/[id]`, dessen `trades` die ERSTE Seite enthält):

| Parameter | Bedeutung |
|---|---|
| `limit` | 1..500, Default 100 (hartes Limit — größere Werte ⇒ 400 `INVALID_TRADE_LIMIT`) |
| `cursor` | opaker Cursor der Vorseite (`nextCursor`); Seite beginnt NACH der letzten gelieferten `seq` (Keyset, kein OFFSET). Ungültig ⇒ 400 `INVALID_TRADE_CURSOR` |
| `segment` | `IS` · `OOS` |
| `window` | Fensterindex ≥ 0 |
| `symbol` | Instrument-ID (≤ 64 Zeichen `[A-Za-z0-9:_./-]`) |
| `side` | `LONG` · `SHORT` |
| `exitReason` | einer der sechs Exit-Gründe |

Unbekannte Filterwerte ⇒ 400 `INVALID_TRADE_FILTER` (nie stilles
Ignorieren). Antwort: `{ ok, runId, ledger, trades }` mit
`ledger = { status: "RECONCILED" | "UNAVAILABLE", tradeCount, idempotencyKey,
reconciliation }` und `trades = { items[], nextCursor, limit, filter }`;
`nextCursor: null` markiert die letzte Seite. Jedes Item trägt `seq`,
`windowIndex`, `segment`, `tradeRef`, `symbol`, `side`, `qty`, `notional`,
`entryTs`/`exitTs` (ISO), `entryPrice`/`exitPrice`, `pnlGross`, `pnlNet`,
`pnlPct`, `fees`, `funding` (`null` möglich), `slippage`, `exitReason`,
`durationBars`, `durationMs`, `provenance`. Alt-Runs (vor v1.52.0) liefern
`ledger.status = "UNAVAILABLE"`, `tradeCount = null` und eine leere Seite
mit Hinweis — nie „0 Trades“. Unbekannte UUID ⇒ 404
`BACKTEST_RUN_NOT_FOUND`, ungültige UUID ⇒ 400 `INVALID_RUN_ID` (beides vor
jedem DB-Zugriff bzw. Ledger-Read).

---

## 6. CLI-Referenz (`scripts/run-backtest.ts`)

```sh
node --import tsx scripts/run-backtest.ts \
  --instrument=BITUNIX:BTCUSDT --timeframe=1h \
  --from=2024-01-01 --to=2026-01-01 \
  --rule-id=<uuid> | --rule-file=./regel.json \
  [--is-days=90] [--oos-days=30] [--idempotency-key=<key>] [--skip-db]
```

| Flag | Pflicht | Bedeutung |
|---|---|---|
| `--instrument` | ja | Instrument-ID wie im HistoricalStore (Replay-Ziel) |
| `--timeframe` | nein (Default `1h`) | Kerzen-Periodizität (Store-Allowlist) |
| `--from` / `--to` | ja | Zeitraum (ISO-8601 oder Epoch-ms; muss mind. 1 IS+OOS tragen) |
| `--rule-id` | genau eine Regelquelle | Regel-UUID aus `trade_rules` |
| `--rule-file` | genau eine Regelquelle | Pfad zu einer RuleSpec-JSON (wird sanitized + gegen `RULE_CEILINGS` geklemmt) |
| `--is-days` / `--oos-days` | nein | Fenster-Override (Bounds wie `WF_*`, sonst Env-Wert) |
| `--idempotency-key` | nein | eigener Lauf-Schlüssel (8..128 Zeichen `[A-Za-z0-9:_.-]`); Default: Inhalts-Fingerprint des Laufs (§5.1) |
| `--skip-db` | nein | keine Persistenz (nur Artefakte; Offline-Betrieb) |

Ablauf: Regel laden (DB oder Datei) → Kerzen aus dem HistoricalStore →
Instrument aus der Universe-Registry auflösen (fehlt sie: neutrales
Spot-Default, sichtbar in der Konsolenausgabe) → Walk-Forward-Lauf mit
kalibriertem Simulator + Funding-Konfiguration des Paper-Betriebs →
`persistBacktestRun` (Run + ALLE Trades in EINER Transaktion, idempotent;
Retry meldet „Idempotent: Lauf war bereits als Run … persistiert“) →
Artefakte `data/backtest/<runId>.json` (Report inkl. `trades`) +
`<runId>.md` (Zusammenfassung mit Equity- UND Ledger-PnL) unter der UUID
des persistierten Runs.

Regel-Symbol vs. Instrument: Regel-Spezifikationen tragen PAPER-kanonische
Symbole (z. B. `BTC/USDT`), Store-Reihen Venue-IDs (z. B.
`BITUNIX:BTCUSDT`). Die CLI replayt die Regel-Logik (Bedingung, Action,
Fenster — venue-agnostisch) gegen `--instrument`; beide IDs stehen im
Report (`ruleRef.ruleSymbol` vs. `instrumentId`) und in der
MD-Zusammenfassung — kein stiller Tausch.

Fail-closed: Fehlende/ungültige Flags, ungültige Regeln, leere Kerzenreihen
und zu kurze Zeiträume brechen mit Exit 1 ab (kein Run, kein Artefakt,
keine DB-Zeile). Schlägt die Persistenz fehl oder wird sie abgelehnt
(Ledger ≠ Aggregate, DB-Fehler), entsteht KEINE DB-Zeile (Transaktion
zurückgerollt); die Artefakte werden unter der Kandidaten-UUID trotzdem
geschrieben und der Exit-Code ist 1 (laut, nie still). Ein Lauf gilt erst
mit `RECONCILED`-Ledger als persistiert.

---

## 7. Anti-Overfitting-Grenzen (bewusst nicht enthalten)

1. **Statische Regeln, keine Parameter-Optimierung:** IS/OOS trennt hier
   EVALUATIONS-Fenster (Robustheit: trägt die Regel über die Zeit, oder
   „passt“ sie nur auf einem Abschnitt?). Eine Schätzung auf IS mit
   Verifikation auf OOS ist bewusst NICHT Teil dieses PRs.
2. **Fensteranzahl-Deckel:** `WF_MAX_SPAN_DAYS` (Default 2 Jahre) begrenzt
   implizit die Fensteranzahl — mehr Fenster laden zu selektivem Lesen
   („das beste Fenster zählt“) ein.
3. **OOS trägt die Wahrheit:** Die MD-Zusammenfassung und `metricsJson`
   stellen das OOS-Aggregat voran; IS dient nur dem Vergleich.
4. **Kein synthetischer Fallback:** Step 8 (`08-backtest-verification`)
   meldet bei < 5 Kerzen `DATA_UNAVAILABLE` (verified=false, Audit,
   Log) — die frühere erfundene Mindestbewertung ist entfernt (GAP-01 D4,
   Fail-closed-Kern dieses PRs).

---

## 8. Referenzen

- Engine-Basis: [BACKTEST_ENGINE.md](BACKTEST_ENGINE.md)
- Paper-Kostenmodell: [PAPER_TRADING.md](PAPER_TRADING.md) (§3), Funding:
  `src/lib/funding.ts`
- Flags: [CONFIGURATION.md](../CONFIGURATION.md) („Walk-Forward-Backtesting“)
- Findings: [GAP-01](audits/2026-09-18-feature-gap/findings/GAP-01-backtesting-walk-forward.md),
  [RMA-P1-04](audits/2026-09-20-roadmap-audit/findings/RMA-P1-04-backtest-trades.md)
  (Trade-Ledger)
- Migrationen: `drizzle/2026-09-19_backtest_runs.sql`,
  `drizzle/2026-09-20_backtest_trades.sql`
- Tests: `tests/backtest.engine.test.ts`, `tests/backtest.step.nosynthetic.test.ts`,
  `tests/backtest.tradeLedger.test.ts` (Mapping, Abgleich, Idempotenz,
  Rollback, Cursor-API — DB-Teile ping → skip)

## Execution-Quality-Evidenz

Mit `EXECUTION_QUALITY_ENABLED=true` erfasst der vorhandene Paper-Simulator
normalisierte Intent-/Fill-/Benchmarkereignisse. Walk-forward-JSON enthält diese
Evidenz; Run-, Trade- und Quality-Ledger werden atomar persistiert. Wiederholungen
nutzen den bestehenden Run-Key. Kerzenbasierte Quality-Zeitpunkte liegen am
abgeschlossenen Bar-Ende (Open + Timeframe), nicht am historischen Open-Zeitstempel
des Legacy-Trade-Ledgers. Referenzpreise/Mids und Latenzen sind als **modeled**
markiert. Fehlende historische L1-Markouts/VWAPs werden nicht aus späteren Kerzen
erfunden. Bestehende Trading-/Kostenentscheidungen und Defaults bleiben unverändert.

[Gemeinsamer Vertrag und Formeln](../src/executionQuality/README.md).
