# Point-in-Time Feature Store

**Stand:** 2026-09-20 · **Modul:** `src/features/` · **Version:** `1.53.0` (RMA-P6-01) · **Status:** Implementiert (kleiner Slice)

Der Feature Store berechnet Scanner-Features **stabil reproduzierbar**, speichert
sie mit vollständiger Provenienz und beantwortet Point-in-Time-Fragen: *„Welchen
Wert hatte Feature X für Instrument Y zum Zeitpunkt `targetTime`, wenn ich nur
Informationen verwenden darf, die bis `as_of` bekannt waren?“*

Das ist die Grundlage für Backtest und Research ohne Look-ahead-Bias: derselbe
Wert ist später nicht „irgendwie ähnlich“, sondern über Definition, Rohdaten-
Fingerprint und Zeitstempel exakt nachvollziehbar.

> **Kernregel (die einzige Zulässigkeitsbedingung):**
> `event_time <= targetTime` **und** `available_at <= as_of`.
> Alles andere ist ein Leak und wird nie geliefert.

## 1. Warum (Problem und Abgrenzung)

Der Scanner berechnet Faktoren **im Moment des Aufrufs**. Für Forschung und
Post-Mortem ist das zu wenig:

* ein später nachgerechneter Wert ist nicht mehr derselbe (Rohdaten ändern sich),
* ein Backtest, der einen erst Tage später eingetroffenen Wert benutzt, ist
  Look-ahead-Bias,
* ein `0`/`false`/`""` als „Ersatz für unbekannt“ verfälscht Scores.

Der Store trennt deshalb drei Zeitpunkte, die sonst verschmelzen, und erfindet
nie einen Wert.

**Nicht im Scope** (bewusste Architektur-Entscheidung, siehe §12): externer
Feature-Store-Dienst, beliebige JSON-Blobs als Featurewerte und stilles
Überschreiben historischer Werte bei Rohdatenrevisionen.

## 2. Module

| Modul | Rolle |
|-------|-------|
| `src/features/types.ts` | Verträge: Definition, Wertzeile, Cursor, Manifest, PIT-Antwort, harte Grenzen, Fehlercodes |
| `src/features/validate.ts` | Fail-closed-Validierung von Definitionen und Wertzeilen |
| `src/features/registry.ts` | Registry: Immutabilität, Topologie, Hash-Bildung (`fc1`/`fg1`/`fd1`), Executor-Bindung |
| `src/features/compute.ts` | Reine Formeln (RSI, ATR, ATR-Band), Verfügbarkeit, Dataset-/Wert-Hashes, Qualitäts-Mapping |
| `src/features/definitions.ts` | Slice-Definitionen (`scanner.rsi@1`, `scanner.atr@1`, `scanner.atr_band@1`) |
| `src/features/materialize.ts` | Materialisierungsplan (Look-ahead-frei), Batch-Bildung, Duplikat-/Revisionsklassifikation |
| `src/features/ports.ts` | Speicher-Ports (Store, Cursor, Werte, Coverage) |
| `src/features/store.ts` | Postgres/Drizzle-Ablage: atomarer Commit, Idempotenz, Retention |
| `src/features/pitQuery.ts` | PIT-Validierung und -Join (SQL-vorgefiltert + endgültige Auswahl) |
| `src/features/service.ts` | Orchestrierung: Materialisierung, Statusbericht, Paritätsjob, PIT-Read-Pfad |
| `src/features/adapters.ts` | Store- vs. Compute-Adapter (offline/online, gemeinsame Registry) |
| `src/features/sourceQuality.ts` | Weitergabe der Befunde des Quality-Layers |
| `src/features/index.ts` | Öffentliche API (Consumer importieren nur von hier) |

## 3. Definitionen und Formeln

Jede Definition deklariert Name, semantische Version, Ausgabeschema (`dtype`,
`enumValues`), Einheit, Wertdezimale, Entity-Typ, Timeframe, Lookback,
Abhängigkeiten, Berechnungs-Key, Konfiguration und **Owner**.

Fingerprints (alle SHA-256, `stableStringify` über kanonisch sortierte Felder):

| Hash | Inhalt | Bedeutung |
|------|--------|-----------|
| `fc1:…` | Implementierungsbindung (`computeKey`) + Dtype/Enum | Code-Kante |
| `fg1:…` | Konfiguration (`config`) | Parameter-Kante |
| `fd1:…` | alle semantischen Felder inkl. `fc1`/`fg1` | Definitions-Identität |

**Definitionen sind unveränderlich.** Dieselbe `(featureId, version)` mit anderem
`fd1` wird von Registry (`FEATURE_DEFINITION_IMMUTABLE`) und Datenbank
(`definition:immutable`) abgelehnt. Neue Semantik ⇒ **neue Version** (dann greift
auch kein Revisionsschutz: neue Version = neue Schlüssel).

### 3.1 Slice `scanner.*@1` (Rollout klein gehalten)

| Feature | Dtype | Einheit | Fenster | Wert |
|---------|-------|---------|---------|------|
| `scanner.rsi@1` | number | `index_0_100` | `period+1` = 15 Kerzen | Wilder-RSI des letzten **geschlossenen** Bars; identisch zu `computeRsi` (Scanner-Faktor `rsi`) |
| `scanner.atr@1` | number | `fraction_of_close` | `period+1` = 15 Kerzen | ATR (Wilder) geteilt durch den letzten Close — `0.01` = 1 %; identisch zu `computeAtrPct` (Scanner-Faktor `atr`) |
| `scanner.atr_band@1` | enum | — | wie `scanner.atr` | `LOW` < `lowThreshold` ≤ `NORMAL` < `highThreshold` ≤ `HIGH`; Abhängigkeit auf `scanner.atr@1` |

Parameter (`period = 14`, `lowThreshold = 0.01`, `highThreshold = 0.04`)
entsprechen den Scanner-Defaults aus `src/scanner/config.ts`; ein Test erzwingt
die Deckungsgleichheit — driftet der Scanner, wird das ein **Testfehler** und
kein stiller Semantikwechsel im Store. Grenzen gehören zur oberen Klasse
(`atrPct = high` ⇒ `HIGH`), konsistent zu `classifyRegime` im Scanner.

Die Formeln existieren **einmal** (`src/scanner/factors/{rsi,atr}.ts`) und werden
von Scanner und Feature Store gemeinsam genutzt; der Feature-Wert ist damit per
Konstruktion paritätisch zum Faktor.

### 3.2 Null-Gründe (`null` ≠ `0`)

Eine Wertzeile trägt **entweder** einen Wert **oder** einen Grund — nie beides,
nie nichts:

| Grund | Bedeutung |
|-------|-----------|
| `INSUFFICIENT_LOOKBACK` | weniger Kerzen als der deklarierte Lookback |
| `INVALID_INPUT` | Reihe enthält eine unbrauchbare Kerze (nicht endlich, `close ≤ 0`, `high < low`) — fail-closed für die ganze Reihe |
| `MISSING_BARS` | Lücke im Zeitraster |
| `NOT_COMPUTABLE` | Formel liefert kein Ergebnis (z. B. Division unmöglich) |
| `DEPENDENCY_NULL` | Abhängigkeit ist NULL — Band wird **nicht** geraten (kein „neutrales“ `LOW`) |
| `DEPENDENCY_MISSING` | Abhängigkeitswert fehlt ganz |

## 4. Zeit- und Verfügbarkeitssemantik

| Feld | Bedeutung |
|------|-----------|
| `event_time` | Schlusszeit der Kerze, aus der der Wert stammt (Eventzeit) |
| `available_at` | Zeitpunkt, ab dem der Wert **wahrheitsgemäß bekannt** war |
| `computed_at` | Zeitpunkt der Berechnung (Materialisierungslauf) |

Verfügbarkeitspolitik:

* `ingested` (**Default**, fail-closed): `available_at = max(event_time, max(fetched_at des Fensters))`.
  Eine nachgelieferte Kerze ist vor ihrem tatsächlichen Eintreffen unsichtbar.
* `bar_close` (Forschungsannahme für replay-saubere Datensätze): `available_at = event_time`.

Invarianten (prüfen Prüf-Code **und** DB-CHECKs): `available_at ≥ event_time` und
`computed_at ≥ available_at`.

`computed_at` ist **kein** Teil des Wert-Fingerprints (`fv1`): derselbe Wert,
später erneut berechnet, ist keine Revision.

## 5. Wertmodell und Provenienz

Eine Wertzeile enthält: `feature_id`, `feature_version`, `entity_type`,
`entity_id`, `timeframe`, `event_time`, `available_at`, `computed_at`, `dtype`,
`value_num`/`value_bool`/`value_text` (genau eine Spalte), `null_reason`,
`quality_status`, `definition_hash`, `value_hash` und `source_manifest`.

* Eindeutiger Schlüssel: `(feature_id, feature_version, entity_id, timeframe, event_time)`
  — je Feature, Entity, Timeframe und Bar **höchstens ein** Wert.
* `fv1:<sha256>` = Inhalts-Fingerprint (Definition, Eventzeit, Wert, Null-Grund,
  Qualitätsstatus, Dataset-Hash). Zeilen sind append-only: es gibt **kein**
  `UPDATE` auf `feature_values`.
* `source_manifest` (JSONB, schema-validiert): Quelle (`historical-store`),
  `candle_count`, `first_event_time`, `last_event_time`, `max_ingested_at`,
  `dataset_hash` (`ds1:<sha256>` über die Rohkerzen **inklusive**
  Ingestion-Zeitstempel) und die verwendete Politik. Damit ist jeder Wert bis
  zur Rohkerze rückverfolgbar; `ds1` unterscheidet Rechenläufe von echten
  Rohdatenänderungen.

**Featurewerte sind skalare, typisierte Werte** (`number`/`boolean`/`enum`) —
keine beliebigen JSON-Blobs (sonst wäre eine PIT-Abfrage nicht entscheidbar).

## 6. Materialisierung

```text
Rohkerzen (Historical Store)
  → planMaterialization                (deterministisch, nur geschlossene Bars)
  → classifyDraftsAgainstExisting      (neu / Duplikat / Revision)
  → commitRun                          (Manifest + Werte + Cursor, EINE Transaktion)
```

* **Deterministisch & rein:** keine Uhr, kein Zufall, kein IO in Planer und
  Formeln; `computedAt` und die Rohkerzen werden injiziert.
* **Bounded Batches:** höchstens `FEATURE_LIMITS.batchRows` Werte je Batch
  (Default 2000, Insert-Chunks ≤ 250) und höchstens `maxBatches` Batches je Lauf.
* **Cursor (Wasserstand):** je Feature/Entity/Timeframe wird
  `watermark_event_time` monoton via `GREATEST` fortgeschrieben. Ein Neustart
  setzt **ohne Lücke und ohne Duplikat** fort; Bars vor dem Wasserstand werden
  gezählt (`skipped_before_cursor`) und nicht neu erzeugt.
* **Idempotenz:** `idempotency_key = fm1:<sha256>` über Definitions-Fingerprints,
  Entities, Timeframe, Politik, Modus, Zeitfenster, **Dataset-Hashes** und
  Code-Version. Ist der Key bereits erfolgreich abgeschlossen, wird der Lauf als
  **Replay** gemeldet: kein zweiter Wert, kein zweites Manifest, keine Revision.
  Ein fehlgeschlagener Lauf bleibt mit demselben Key wiederholbar (der neue
  Versuch ersetzt dessen Manifest).
* **Rohdatenrevision (fail-closed):** Ergibt derselbe Wertschlüssel einen
  **anderen** Inhalt (`fv1` verschieden), wird der Batch **verworfen**: keine
  Werte, kein Cursor-Fortschritt, Manifest mit `status = FAILED` und
  `error_code = FEATURE_DATA_REVISION_DETECTED`, ein Datensatz in
  `feature_data_revisions` und das Audit-Event `FEATURE_DATA_REVISION_REJECTED`
  (Detailvariante `FEATURE_VALUE_REVISION_DETECTED` in der Ablage). Der
  historische Wert bleibt gültig. Wiederholtes Ausführen erzeugt keinen zweiten
  Revisionsdatensatz (UNIQUE je Schlüssel + eingehendem Hash).
  Ausweg bei echter, gewollter Neuberechnung: **neue Featureversion** (neue
  Schlüssel) oder ein bewusst freigegebener Backfill in einer künftigen Version
  (heute bewusst nicht implementiert, siehe §12).
* **Backfill-Manifest:** jeder Lauf schreibt ein Manifest mit Zählern
  (`bars_considered`, `skipped_before_cursor`, `gap_bars`, `values_written`,
  `duplicates`, `revisions`, `null_values`), Definitions-Fingerprints,
  Source-Manifesten, Cursor-Ständen vor/nach, Modus (`INCREMENTAL`/`BACKFILL`),
  Politik und Code-Version — Grundlage für Reproduzierbarkeit und Betrieb.
* **Reihen-Validität:** Enthält die abgeschlossene Eingangsmenge eine
  unbrauchbare Kerze, liefert die Reihe `INVALID_INPUT` statt Teilergebnissen.

## 7. Point-in-Time-Abfrage (API)

```http
GET /api/firm/features/values?asOf=2026-09-20T12:00:00Z&targetTime=2026-09-20T11:00:00Z
    &entities=BITUNIX:BTCUSDT&features=scanner.rsi,scanner.atr_band:1&timeframe=1h
```

* `asOf` (Pflicht) — Sichtbarkeitshorizont: „nur Informationen bis hierhin“.
* `targetTime` (Default `asOf`) — Zielzeit; **darf nicht nach `asOf` liegen**
  (`INVALID_TARGET`, HTTP 400 — genau das wäre Look-ahead).
* `entities` (Pflicht, CSV) — max. 200; `features` (Pflicht, CSV) — max. 25,
  je `featureId` oder `featureId:version` (ohne Version gilt die neueste).

Ausgewählt wird je Paar der **jüngste** zulässige Wert; bei gleicher Eventzeit
deterministisch die später verfügbare Zeile, dann der größere Fingerprint.

Antwortfelder je Wert: `status` (`OK` | `NULL_VALUE` | `MISSING`), `value`
(`null` bei `NULL_VALUE`/`MISSING` — nie `0`), `nullReason`, `qualityStatus`,
`eventTime`, `availableAt`, `computedAt`, `lagMs`, `stale`, `definitionHash`,
`dtype`, `unit`.

Zähler und Invarianten über alle angeforderten Paare:
`matched + missing = requested`, `nullValues ≤ matched`, `stale ≤ matched`.
`MISSING` heißt **nicht** „kein Wert vorhanden, also 0“, sondern „kein zulässiger
Wert vorhanden — Entscheidung ist Sache des Consumers“.

`lagMs` ist das **Informationsalter** gegenüber `asOf`:
`asOf − max(eventTime, availableAt)`. `stale` bedeutet „älter als ein
Zeitrahmen“ (bzw. als das injizierte `maxLagMs`). Bewusst nicht
`targetTime − eventTime`: ein erst spät eingetroffener Wert ist frisch, eine seit
Tagen nicht aktualisierte Reihe ist es nicht.

Harte Grenzen (fail-closed statt stiller Kürzung): Ergebnisse ≤ 2000
(`FEATURE_LIMITS.pitRows`), Quellzeilen ≤ 20000 — wird die Quellgrenze erreicht,
antwortet die API mit `FEATURE_PIT_SOURCE_TRUNCATED` (HTTP 503) und der Hinweis
„Zeitraum/Entities eingrenzen“, statt eine unvollständige Menge als „Wert fehlt“
auszugeben.

Beide Read-Endpunkte verlangen `firm.read`, senden `Cache-Control: private, no-store`
und sind reine Lesepfade:

| Route | Zweck |
|-------|-------|
| `GET /api/firm/features` | Definitionen (inkl. Fingerprints), Abdeckung/Lag je Reihe, jüngste Läufe und protokollierte Revisionen; optional `?timeframe=`, `?feature=`, `?runs=1..50` |
| `GET /api/firm/features/values` | PIT-Abfrage wie oben |

## 8. Offline/Online-Parität

`createStoreBackedSource` (liest materialisierte Werte) und
`createComputeBackedSource` (rechnet on-the-fly aus Rohkerzen) nutzen **dieselbe**
Registry und **dieselben** Executors; sie unterscheiden sich nur in der Quelle.
Der Paritätsjob (`parityCheck`, CLI `--parity`) vergleicht je Wertschlüssel die
Fingerprints und meldet Abweichungen mit Grund:

| Grund | Bedeutung |
|-------|-----------|
| `MISSING_STORED` | offline berechnet, im Store nicht vorhanden |
| `VALUE_MISMATCH` | gleicher Dataset-Hash, anderer Wert (Formel-/Rundungsabweichung) |
| `DATASET_REVISION` | Rohdaten haben sich geändert (`ds1` verschieden) |
| `DEFINITION_MISMATCH` | Zeile gehört zu einem anderen Definitions-Fingerprint |

Ein Vergleich über `[fromTs, toTs]` liest auch die Store-Seite nur in diesem
Fenster — sonst würde die halbe Historie als „fehlt“ gelten.

## 9. Qualität, Abdeckung, Retention

* **Source-Quality wird propagiert:** Der schwerste Befund (GAP, OUTLIER,
  INVALID, DUPLICATE, CROSSCHECK) im verwendeten Fenster wird zum
  `quality_status` des Werts. Befunde **ohne** Zeitstempel gelten für die ganze
  Reihe. Liegt für die Reihe kein Report vor, ist der Status `UNKNOWN` („nicht
  geprüft“) — niemals `OK`. `UNKNOWN` ist schwerer als `OK`; Gates, die geprüfte
  Daten verlangen, müssen es fail-closed behandeln.
* **Abdeckung/Lag:** `featureStoreStatus` liefert je Reihe Zeilen, Entities,
  NULL-Anteil, UNKNOWN-Anteil, jüngste Event-/Verfügbarkeits-/Berechnungszeit,
  Cursor-Wasserstand, Revisionszähler und den **Materialisierungs-Rückstand**
  `max(0, now − timeframe − max_event_time)` (0 = aktuell).
* **Retention/Compaction:** `pruneRuns(keepLast)` entfernt ausschließlich
  **wertfreie** Manifeste (FAILED oder `values_written = 0`), die kein Cursor
  referenziert und zu denen keine Revision protokolliert ist. Wertezeilen und
  Revisionen werden **nie** gelöscht — sie sind die Wahrheitsquelle.
* **Metriken (bounded Labels):**
  `feature_materialization_values_total{result,reason}`,
  `feature_materialization_runs_total{result,mode}`,
  `feature_pit_queries_total{result}`, `feature_pit_outcomes_total{status,stale}`,
  `feature_parity_checks_total{result}`. Keine Instrument-/Order-/Trade-IDs als
  Label (Kardinalitätsregel); Entities erscheinen ausschließlich in
  Audit-Details.
* **Audit-Events:** `FEATURE_DEFINITIONS_REGISTERED`,
  `FEATURE_MATERIALIZATION_COMPLETED`, `FEATURE_MATERIALIZATION_FAILED`,
  `FEATURE_DATA_REVISION_REJECTED` (Batch verworfen),
  `FEATURE_VALUE_REVISION_DETECTED` (Ablage), `FEATURE_DEFINITION_DRIFT_DETECTED`,
  `FEATURE_MATERIALIZATION_RUNS_PRUNED` — Klasse `telemetry`.

## 10. Betrieb: CLI und Deployment

```bash
npm run features:materialize                    # inkrementell (Default: ingested)
npm run features:status                         # read-only Statusbericht
npm run features:parity                         # Offline/Online-Vergleich (Exit 1 bei Divergenz)
npm run features:materialize -- --dry-run       # rechnen/klassifizieren, nichts schreiben
npm run features:materialize -- --feature=scanner.rsi --entities=BITUNIX:BTCUSDT
npm run features:materialize -- --mode=backfill --from=2024-01-01 --to=2026-01-01
npm run features:materialize -- --availability=bar_close      # Forschungsannahme
npm run features:materialize -- --prune-runs=50               # Retention (wertefrei)
```

Datenquelle ist der Historical Store (`PAPER_HISTORY_DIR`, Default `data/history`)
— **kein Netzwerk**, kein LLM. Exit-Codes: `0` ok, `1` Fehler/Divergenz,
`2` Aufruf-/Validierungsfehler.

**Migration:** `drizzle/2026-09-20_feature_store.sql` (append-only, idempotent)
legt fünf Tabellen an; angewendet wird sie wie im Repo üblich mit
`npx drizzle-kit push` (liest `DATABASE_URL`, siehe `drizzle.config.ts`). Die
Tabellen sind **rein additiv**:

| Tabelle | Inhalt | Schlüssel/Indizes |
|---------|--------|-------------------|
| `feature_definitions` | unveränderliche Definitionen | PK `(feature_id, version)`, UNIQUE `definition_hash` |
| `feature_values` | Wertzeilen (append-only) | UNIQUE `(feature_id, feature_version, entity_id, timeframe, event_time)`, PIT-Index `(entity_id, feature_id, feature_version, timeframe, event_time DESC, available_at)`, Event-/Run-Indizes |
| `feature_materialization_runs` | Manifeste (Erfolg/Fehlschlag) | UNIQUE `idempotency_key`, Index `finished_at DESC` |
| `feature_materialization_cursors` | Wasserstände | PK `(feature_id, feature_version, entity_id, timeframe)` + monotoner CHECK |
| `feature_data_revisions` | protokollierte Rohdatenrevisionen | UNIQUE `(feature_id, feature_version, entity_id, timeframe, event_time, incoming_value_hash)` |

**Deployment/Rollback:**

1. Migration einspielen (additiv, kein Lock auf bestehenden Tabellen).
2. Materialisierung starten (`npm run features:materialize`) und Status prüfen
   (`npm run features:status`) — ohne Werte sind PIT-Abfragen leer, aber korrekt
   (`MISSING`), nie „0“.
3. **Rollback:** Der Store ist ein **zusätzlicher** Lesepfad. Ein Rollback
   besteht darin, die CLI nicht mehr auszuführen; die Read-Endpunkte liefern
   ohne Tabellen `FEATURE_STORE_UNAVAILABLE` (HTTP 503). Bestehende Consumer
   (Scanner, Weekly, Backtest) sind **nicht** betroffen — sie nutzen den Store
   nicht. Ein `DROP TABLE` ist nur nötig, wenn die Tabellen wirklich verschwinden
   sollen, und ist jederzeit gefahrlos (keine Fremdschlüssel in andere Module).
4. **Feature-Flag-Ersatz:** Es gibt bewusst kein globales Flag — der Rollout ist
   der Slice selbst (drei Features, eigene Tabellen, eigene Endpunkte). Ein
   Consumer entscheidet über die Konsumption, nicht der Store über sein Dasein.

## 11. Tests und Evidenz

| Test | Deckung |
|------|---------|
| `tests/featureStore.test.ts` | Registry-Immutabilität/Topologie, Formelparität zu den Scanner-Faktoren, Fail-closed-Wertregeln, bounded Batching + Cursor-Neustart, Replay-Idempotenz, Trockenlauf, **synthetischer Leakage-Test** (verspätete Kerze unsichtbar bis `available_at`, `event_time`-Grenze), Missingness, Anfragevalidierung, Quellgrenze, Revision vs. Parität, Adapter-Parität, Source-Quality, Betriebssicht/Metriken |
| `tests/featureStore.db.test.ts` | Postgres-Variante: Constraints/UNIQUEs, CHECK-Invarianten, as-of-Indexpfad, Transaktionsatomarität, Idempotenz gegen echte DB (überspringt sich sauber ohne erreichbare Datenbank) |

Reproduzierbare Läufe: `npm run typecheck`, `npm run lint`,
`node --import tsx --test tests/featureStore.test.ts`,
`npm run docs:validate`, `npm test`.

## 12. Bewusste Entscheidungen und Ausblick

* **Kein externer Feature-Store-Dienst** (Feast/Tecton & Co.): dafür bräuchte es
  eine Architektur-Entscheidung (Betriebsaufwand, Datenhoheit, Latenz). Der
  Slice bleibt in der bestehenden Postgres-Instanz.
* **Keine beliebigen JSON-Blobs:** nur skalare, typisierte Werte.
* **Kein stilles Überschreiben bei Rohdatenrevision:** Revisionsschutz statt
  `UPDATE`; gewollte Neuberechnung braucht eine neue Featureversion.
* **Nächste Schritte:** weitere deterministische Scanner-Features migrieren
  (dann ohne Big-Bang), Backfill-Beschleunigung, optionale `boolean`-Features,
  Partitions-/Compaction-Strategie für sehr lange Historien, Anbindung des
  Backtest-Replays an den Store als Lesepfad.

## Verwandte Dokumente

* [ARCHITECTURE.md](ARCHITECTURE.md) — Gesamtarchitektur und Datenflüsse
* [HISTORY.md](HISTORY.md) — Historical Store (Rohkerzen und Provenienz)
* [OBSERVABILITY.md](OBSERVABILITY.md) — Metriken, Alerts, Audit
* [OPERATIONS.md](OPERATIONS.md) — Runbooks
* [BACKTESTING.md](BACKTESTING.md) — Walk-Forward-Backtesting
* [audits/2026-09-20-roadmap-audit/findings/RMA-P6-01-point-in-time-feature-store.md](audits/2026-09-20-roadmap-audit/findings/RMA-P6-01-point-in-time-feature-store.md)
