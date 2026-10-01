# Strategie×Markt-Screening — Persistenz und Idempotenz

> **Status-Header:** **Beta** · Dokumentationsstand **2026-10-01** · Code-Version **0.8.0** · Modul **STX-05-03** · Migration **2026-10-01_strategy_screening.sql**

## Zweck und Abgrenzung

Die Candidate Matrix lebt in zwei eigenen Tabellen, nicht in
`backtest_runs`: diese Tabelle bleibt **single-instrument**. Ein Screening-Run
fasst den gemeinsamen Point-in-Time-Cutoff, Code-/Daten-Provenienz und die
aufgelöste Konfiguration zusammen. Jede persistierte Zelle referenziert eine
bereits vorhandene `strategy_versions.id`; ein Backtest ist **optional**.

Die reine Discovery aus `types.ts`/`matrix.ts` darf Kandidaten ohne
Strategieversion liefern. Vor `upsertCells()` muss der Aufrufer die
Strategieversion persistieren/auflösen. Der Store erfindet weder Versionen
noch Universe-Pseudoinstrumente. Runner, CLI und Backtest-Ausführung sind
**nicht** Bestandteil von 05-03 (folgen in 05-04). Keine Lifecycle-Promotion
oder Live-Freigabe, keine neuen Runtime-Dependencies oder Env-Flags.

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

## Tests und Rollback

- [`tests/strategyScreening.keys.test.ts`](../tests/strategyScreening.keys.test.ts):
  genaue Hash-Formel, kanonische Schlüssel, Zeit-/UUID-Normalisierung,
  Identitätsänderungen, ungültige Inputs, Paging-Bounds und statischer
  Kein-DELETE-/Kein-Overwrite-Wächter.
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
