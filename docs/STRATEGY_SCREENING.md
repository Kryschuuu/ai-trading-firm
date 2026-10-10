# Strategie×Markt-Screening — Persistenz und Idempotenz

> **Status-Header:** **Bestandsdokument** · **Stand:** 2026-10-02 · **Code-Version:** v0.17.2 (Beta) · Vollabgleich offen — [DC-06](audits/2026-10-06-docs-code-audit/findings/DC-06-symbol-und-pfad-drift.md) · Modul **STX-05-03/05-04** · Migration **2026-10-01_strategy_screening.sql**

## Zweck und Abgrenzung

Die Candidate Matrix lebt in zwei eigenen Tabellen, nicht in
`backtest_runs`: diese Tabelle bleibt **single-instrument**. Ein Screening-Run
fasst den gemeinsamen Point-in-Time-Cutoff, Code-/Daten-Provenienz und die
aufgelöste Konfiguration zusammen. Jede persistierte Zelle referenziert eine
bereits vorhandene `strategy_versions.id`; ein Backtest ist **optional**.

Die reine Discovery aus `types.ts`/`matrix.ts` darf Kandidaten ohne
Strategieversion liefern. Vor `upsertCells()` muss der Aufrufer die
Strategieversion persistieren/auflösen. Der Store erfindet weder Versionen
noch Universe-Pseudoinstrumente. Keine Lifecycle-Promotion oder Live-Freigabe,
keine neuen Runtime-Dependencies.

`SCREENING_PRIORITY_CONFIG_FILE` ist der optionale Env-Default von
`loadScreeningPriorityConfig()` (`src/screening/config.ts`); die JSON-Overrides
werden gegen bekannte Felder und Bounds validiert. **Derzeit nutzt das CLI
`scripts/run-screening.ts` diese Loader-Funktion nicht**, sondern injiziert
`DEFAULT_SCREENING_PRIORITY_CONFIG`. Das Setzen der Variable ändert daher
aktuell keinen CLI-Lauf; sie wirkt nur für Aufrufer, die den Loader ohne
expliziten Dateipfad verwenden. Die Einschränkung ist auch in
[`CONFIGURATION.md`](../CONFIGURATION.md) festgehalten.

Ab 05-04 (`v0.9.0`) kommen Runner, CLI und Backtest-Job-Adapter dazu; der
**Store-Vertrag bleibt unverändert** — der Runner ist ein weiterer Aufrufer
derselben vier Funktionen, keine zweite Persistenzschicht.

## Schema und Migration

Voraussetzungen: bestehende Backtest-Tabelle und Katalog-Migration
[`2026-10-01_strategy_catalog.sql`](../drizzle/2026-10-01_strategy_catalog.sql).
Die aktuelle Datierung ersetzt den Platzhalter `2026-09-2X` des Auftrags,
damit die Migration nicht vor ihrem Strategieversions-FK-Ziel datiert ist.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/2026-10-01_strategy_screening.sql
# Alternativer Schema-Pfad (gleiche neuen Tabellen/Defaults/Constraints/Indizes):
npx drizzle-kit push
```

SQL-Datei und [`src/db/schema.ts`](../src/db/schema.ts) sind deckungsgleich.
Die Migration ist mehrfach anwendbar und ändert keine vorhandenen Tabellen,
Spalten oder Indizes; es gibt keinen Backfill.

| Tabelle | Vertrag |
|---|---|
| `strategy_screening_runs` | UUID, Laufart `DISCOVERY`/`MATRIX`/`BACKTEST_BATCH`, gemeinsames `as_of`, `ssr1:`-Hash, Code-/optionale Daten-Version, verpflichtendes `config_json`, Laufstatus, Fortschritt und Erzeugungs-/Aktualisierungszeit |
| `strategy_market_results` | UUID, verpflichtende Run-/Strategieversions-FKs, Instrument/Venue/Timeframe/Template, nullable Priorität, Status/Gründe, optionaler Backtest-FK, Metriken, global eindeutiger `ssm1:`-Key und Zeitstempel |

Run-Identität: `UNIQUE(candidate_set_hash, code_version)`. Zell-Identität:
`UNIQUE(idempotency_key)`. Die Read-Indizes sind `(run_id, status)` und
`(run_id, priority DESC NULLS LAST)`. FKs haben **keine Cascade**.
Run-Zähler sind nichtnegativ, `cells_done ≤ cells_total`; Config/Metriken
sind JSON-Objekte, Gründe ein JSON-Array. SQL- und JSON-NULL ersetzen keine
Config. Unbekannte Priorität bleibt SQL-NULL, unbekannte Metriken können
explizite JSON-NULL-Werte tragen (nicht still 0).

## Hash-Herleitung

[`src/screening/keys.ts`](../src/screening/keys.ts) verwendet ausschließlich
`canonicalJson` aus `strategyLifecycle/evidence.ts` für die Serialisierung:

```text
ssr1:sha256(canonicalJson({ cells, asOf, codeVersion, config }))
ssm1:sha256(canonicalJson({ runId, strategyVersionId, instrumentId, venue, timeframe }))
```

`asOf` wird als UTC-ISO-Zeit normalisiert; Date, Millisekunden und ISO-Zeit
mit Offset für denselben Zeitpunkt ergeben denselben Key. Strings ohne
explizite Zeitzone und ungültige Cutoffs werden abgelehnt. UUIDs werden vor
der Zell-Key-Bildung auf kanonische Kleinschreibung normalisiert.

Objektschlüssel sind kanonisch sortiert; **Array-Reihenfolge bleibt erhalten**.
`cells` muss deshalb die stabile Reihenfolge des Matrix-Builders beibehalten.
Alle Zellinhalte, der Cutoff, Code und die **vollständige** Config gehören
zur Run-Identität. Caller übergeben die aufgelösten Prioritätsgewichte und
Matrix-/Job-Limits, nicht nur einen Dateinamen oder einen partiellen Override.

`runKind`/`dataVersion` sind Metadaten, nicht zusätzliche Hash-Felder. Ein
Retry behält die erste Provenienz; datenversionsabhängige Unterscheidungen
müssen entsprechend der vorgegebenen Hash-Formel in `cells` oder `config`
stehen. Ein geänderter Bewertungsauftrag erzeugt einen neuen Run und damit
neue Zellen; gleiche Inhalte am gleichen Code sind dagegen ein Replay.

## Store-Verträge

[`src/screening/store.ts`](../src/screening/store.ts):

- `createOrGetRun(input): Promise<RunRow>` berechnet den Run-Hash und schreibt
  `PENDING`, `cells_total = input.cells.length`, `cells_done = 0`. INSERT mit
  `ON CONFLICT DO NOTHING` und anschließender SELECT laufen in **einer
  READ-COMMITTED-Transaktion**, auch bei konkurrierenden Retries. Ein Replay
  verändert weder Config noch Status, Fortschritt oder Zeitstempel.
- `upsertCells(runId, cells): Promise<number>` berechnet alle Zell-Keys selbst
  und schreibt in Chunks von 250 Zeilen, **atomar in einer Transaktion**.
  `ON CONFLICT (idempotency_key) DO NOTHING`; Rückgabe ist die Zahl tatsächlich
  neuer Zeilen (Replay: 0). Weder Priorität noch Status, Gründe, Metriken,
  Backtest-Link oder Zeitstempel vorhandener Zellen werden überschrieben.
- `setRunStatus(runId, status, counts): Promise<RunRow>` serialisiert Meldungen
  per `FOR UPDATE`. Beide Zähler steigen monoton; verspätete kleinere Werte
  setzen nichts zurück. `PENDING` überschreibt kein `RUNNING`/`ABORTED`.
  `ABORTED → RUNNING` erlaubt Fortsetzen; `DONE` und `FAILED` sind terminal.
  `DONE` benötigt `cells_done = cells_total`; ungültige Zähler bzw. ein
  unbekannter Run scheitern ohne Mutation.
- `listResults(runId, { status?, limit? }): Promise<CellRow[]>` filtert immer
  auf den Run, optional auf den Zellstatus. Höchste Priorität zuerst,
  NULL zuletzt, deterministische Tie-Breaker. Default 20, jede positive
  ganzzahlige Größe bis **maximal 200** (`src/lib/paging.ts`); größere Werte
  werden gedeckelt, ungültige Werte fallen auf den Default.

Beispiel (die Zellen haben bereits aufgelöste Strategieversions-IDs):

```ts
const run = await createOrGetRun({
  runKind: "MATRIX",
  cells,
  asOf: cutoff,
  codeVersion: APP_VERSION,
  dataVersion: candlesVersion,
  config: { priority: resolvedPriorityConfig, limits: resolvedMatrixLimits },
});
const inserted = await upsertCells(run.id, cells);
await setRunStatus(run.id, "RUNNING", { cellsDone: completedCells });
const top = await listResults(run.id, { status: "READY", limit: 50 });
```

`numeric`-Prioritäten werden im Store als Zahlen angenommen und im DB-Read
als dezimale Strings zurückgegeben (Drizzle-/Postgres-Konvention).
Es gibt **keinen DELETE-Pfad** und keinen Zell-UPDATE-Pfad im Store.

## Runner, CLI und Backtest-Pfad (STX-05-04)

[`src/screening/runner.ts`](../src/screening/runner.ts) fährt die Matrix als
Jobs: `createOrGetRun()` → je Zelle `upsertCells()` → optionaler Backtest →
Metriken. Er ist bewusst **ohne** `worker_threads` und ohne eigenen Thread-Pool:
I/O-Nebenläufigkeit 4 (`SCREENING_DEFAULT_CONCURRENCY`, hart gedeckelt auf
`SCREENING_MAX_CONCURRENCY` = 8), die Engine selbst läuft strikt **seriell** —
CPU-Arbeit wird nicht vervielfacht.

### Verträge

| Zusicherung | Umsetzung |
|---|---|
| `maxCells` ist **hart** | Überschreitung ⇒ `{ ok: false }` mit `matrix too large: n > limit`; **kein** `createOrGetRun`, kein `upsertCells`, kein stilles Kürzen. Default `MAX_MATRIX_CELLS` = 5 000 |
| Caps ⇒ vergleichbar oder geblockt | `checkScreeningCaps()` gegen `RULE_BACKTEST_MIN_BARS` (100), `RULE_BACKTEST_TRADE_CAP` (200), `RULE_BACKTEST_EQUITY_CAP` (120). Verstoß ⇒ Zelle `BLOCKED`, Grund `caps exceeded`, `metrics` leer, `backtest_run_id` `null`. **Nie** ein gekapptes Ergebnis. Unbekannte Größen (`null`) sind fail-closed ein Verstoß |
| Kein Overwrite | Lauf-Identität aus `ssr1:`-Hash; gleicher Inhalt ⇒ gleicher Lauf, Replay ⇒ 0 neue Zellen. Anderer Inhalt (Cutoff, Limits, Gewichte) ⇒ neuer Lauf |
| Fortschritt | `cells_done` monoton, Persistenz-Zyklus alle 25 Zellen (`SCREENING_PROGRESS_EVERY`); Ende `DONE` nur bei `cells_done = cells_total` |
| Abbruch | `shouldAbort()` (CLI: SIGINT/SIGTERM) ⇒ Stand als `ABORTED`; Fortsetzung über denselben Inhalt überspringt den erledigten Prefix |
| Telemetrie | `screening_cells_total{result}` mit dem **geschlossenen** Vokabular `discovered/backtested/blocked/capped/failed/skipped`. Kein Instrument, kein Template, keine Priorität im Label |
| Fehler | Ein Persistenz-Fehler setzt den Lauf auf `FAILED`, nie auf `DONE` |

### Backtest-Pfad (festgenagelt in 00-01)

[`src/screening/backtestAdapter.ts`](../src/screening/backtestAdapter.ts) ruft
**ausschließlich** `runMultiAssetBacktest()` auf
(`SCREENING_BACKTEST_PATH = "multiAsset"`). Begründung und Messung:
[`BENCH-BASELINE.md`](audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md)
§6 — O(n) statt O(n²), 121,7× schneller, 7 500 Zellen in 0,44 Kernstunden.
`backtestRule()` wird nicht angefasst.

- **Punkt-in-Zeit:** nur Kerzen mit `ts ≤ asOf` gehen in den Lauf.
- **Kostenbremse:** `maxCandlesPerCell` (Default
  `SCREENING_MAX_CANDLES_PER_CELL` = 20 000, CLI-Flag `--max-candles`) wird hart
  angewendet.
- **Ein Lesevorgang je Reihe:** `HistoricalStore.query()` liest die ganze
  ndjson neu; der Adapter cached die Reihe, damit N Zellen nicht N Dateilesen
  bedeuten.
- **Metriken bleiben geschlossen:** Skalare Kennzahlen + Provenienz, kein
  Trade-Log, keine Equity-Kurve in `strategy_market_results.metrics`.
- **`compileTemplate()` ist der einzige Sanitize-Pfad** und bekommt das
  venue-native Symbol; `candlesBySymbol` ist nach `instrumentId` geschlüsselt.
- **Zu wenige Kerzen** ⇒ `candles:too-few`, die Zelle landet über den
  `min_bars`-Cap auf `capped`.

### `backtest_run_id` bleibt in 05-04 `null`

`persistBacktestRun()` erwartet einen vollständigen `WalkForwardReport`. Aus
einem Einzelzellen-Engine-Lauf einen solchen Report zu bauen wäre eine **zweite
Wahrheit** über Läufe — und `runMultiAssetBacktest()`/`backtestRule()` sind für
05-04 gesperrt. Der optionale `persist`-Hook im Adapter ist die dokumentierte
Naht für einen späteren Prompt. Die Spalte ist nullable (05-03), die Zellen
bleiben gültig.

### CLI

```bash
npm run screening                                  # --dry-run (Default): nur Matrix
npm run screening -- --templates=a,b               # Template-Teilmenge
npm run screening -- --timeframes=1h,4h            # Timeframe-Teilmenge
npm run screening -- --max-instruments=100         # harte Instrumentengrenze (500)
npm run screening -- --limit-cells=50 --execute    # echter Pilotlauf
npm run screening -- --run-id=<uuid> --execute     # vorhandenen Lauf fortsetzen
npm run screening -- --max-cells=1000              # harte Zellgrenze (5000)
npm run screening -- --concurrency=8               # I/O-Nebenläufigkeit (4, max 8)
npm run screening -- --as-of=2026-10-01T00:00:00Z  # gemeinsamer PIT-Cutoff
npm run screening -- --max-candles=5000            # Kerzen je Zelle (20000)
```

`--dry-run` ist der Default; `--execute` ist der einzige Weg zu einem echten
Lauf. Ausgabe: Tabelle `priority · template · instrument · tf · status ·
reasons` plus Zusammenfassung je Ergebnis-Token, `BLOCKED`-Gründen und
Cap-Zählern. Exit-Codes: 0 = grün (oder Dry-Run), 1 = Lauf fachlich nicht grün,
2 = Bedienfehler.

Die Metrik-Zuordnung der CLI ist **Verdrahtung, keine neue Formel-Wahrheit** —
jede Zeile referenziert ihre bestehende Quelle (Tabelle im Kopf von
[`scripts/run-screening.ts`](../scripts/run-screening.ts)): `dataQuality` aus der
Store-Abdeckung, `liquidity`/`volatilityOpportunity`/`correlation` aus
`InstrumentScore.factors.*.normalized`, `freshness` aus der
`DEFAULT_STALE_HOURS`-Rampe in `src/marketdata/quality.ts`.

`crossSectional` bleibt bewusst ungesetzt: der Scanner-Faktor
`crossSectionalMomentum` ist **kein** Point-in-Time-Snapshot und hat keine
`snapshotId`. Einen `CrossSectionalRankContext` daraus zu bauen wäre erfundene
Provenienz; der Matrix-Bauer setzt seinen dokumentierten Neutralwert 0,5.

### Pilot

Der verbindliche Pilot nach dem Merge:
`npm run screening -- --limit-cells=50 --execute`, ausgewertet in
[`SCREENING-PILOT.md`](audits/2026-09-29-strategy-template-ausbau/remediation/SCREENING-PILOT.md).
Bei über einer Kernstunde für 50 Zellen wird der Pilot blockiert und die Ursache im Store-/Adapter-/Engine-Pfad geprüft. STX-12 ist mit `v0.11.0` bereits behoben; das Screening bleibt unverändert auf `runMultiAssetBacktest()`.

## Tests und Rollback

- [`tests/strategyScreening.keys.test.ts`](../tests/strategyScreening.keys.test.ts):
  genaue Hash-Formel, kanonische Schlüssel, Zeit-/UUID-Normalisierung,
  Identitätsänderungen, ungültige Inputs, Paging-Bounds und statischer
  Kein-DELETE-/Kein-Overwrite-Wächter.
- [`tests/screening.runner.test.ts`](../tests/screening.runner.test.ts):
  harte `maxCells` (Abbruch ohne Store-Zugriff), Caps ⇒ `BLOCKED` mit Grund
  `caps exceeded` statt Kappung, Dry-Run-Äquivalent ohne Backtest-Job,
  50 Zellen mit Stub << 30 s, bounded Concurrency (I/O parallel begrenzt,
  Engine strikt seriell), bounded Telemetrie-Labels, Abbruch ⇒ `ABORTED` mit
  konsistentem `cells_done` und Fortsetzung über denselben Inhalt, idempotentes
  Replay (0 neue Zellen), fremde Run-ID ⇒ Abbruch, Persistenz-Fehler ⇒
  `FAILED`. Keine Engine, keine Datenbank — Store und Backtest sind injizierte
  Ports (Fixture: [`tests/screening.runner.fixtures.ts`](../tests/screening.runner.fixtures.ts)).
- [`tests/screening.backtestAdapter.test.ts`](../tests/screening.backtestAdapter.test.ts):
  Engine-Pfad `multiAsset` am gemeldeten Ergebnis, Punkt-in-Zeit-Filter
  (Kerzen nach dem Cutoff bleiben draußen), harte Kerzengrenze, genau ein
  Store-Lesevorgang je Reihe, fail-closed bei zu wenigen Kerzen und
  unbekanntem Template, geschlossene Metrikmenge ohne Listen/Kurven.
- [`tests/strategyScreening.db.test.ts`](../tests/strategyScreening.db.test.ts):
  embedded PostgreSQL, doppelte Migration, **echter Drizzle-Push** auf eine
  zweite Wegwerf-DB und Katalogvergleich (Spalten/Defaults/CHECKs/FKs/Indizes),
  parallele Retries, frischer Pool, unveränderte Zellen, Pflicht-FKs,
  nullable Backtest, Chunk-Rollback, monotone Fortschritte und bounded Reads.
  Nur ein nicht startbarer PostgreSQL überspringt die DB-Suite; Migrations-
  und Store-Fehler sind echte Testfehler.

Für einen Schema-Rollback zuerst alle Screening-Leser/Schreiber stoppen und
Ergebnisse exportieren. Ohne laufende neue Anwendung darf ausschließlich
die additive Screening-Schicht entfernt werden:

```sql
DROP TABLE IF EXISTS strategy_market_results;
DROP TABLE IF EXISTS strategy_screening_runs;
```

Kein `CASCADE`, keine Änderung an `backtest_runs`, `strategy_versions` oder
`strategy_lifecycle_*`. Im Regelfall genügt das Zurückrollen des Codes; die
zusätzlichen Tabellen bleiben kompatibel stehen. Ein Schema-Rollback
entfernt Screening-Ergebnisse und ist kein Retention-/Anwendungs-Löschpfad.
