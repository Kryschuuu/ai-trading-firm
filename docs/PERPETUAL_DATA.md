# Perpetual-Daten — Funding, Open Interest, Liquidationen (historisch, point-in-time)

> **Status-Header:** **Implementiert** · Dokumentationsstand **2026-09-20** ·
> Code-Version **1.54.0** · Modul `src/perpdata/` · CLI `npm run perp:sync`
> (Status: `npm run perp:sync:status`, Offline-Validierung:
> `npm run perp:sync:fixture`) · Befund RMA-P2-02 des
> [Straßenbegradigungs-Audits](audits/2026-09-20-roadmap-audit/remediation/TRACKING.md)

Der Layer liefert die **Derivate-Wahrheit der Vergangenheit**: Wer hat wann welche
Funding-Rate gezahlt, wie groß war das offene Interesse, was wurde liquidiert —
und zwar so, dass ein Backtest sie zum historischen Zeitpunkt *hätte* kennen
können. Vor v1.54.0 existierten Funding und Open Interest ausschließlich als
Momentwert (Ticker/Discovery) und Liquidationen gar nicht; Research, Backtest und
Post-Mortem hatten damit keine as-of-sichere Quelle.

```
scripts/perp-sync.ts ─▶ PerpDataService (src/perpdata/service.ts)
                          │   Gates: PERP_DATA_ENABLED · PERP_DATA_SYNC_ENABLED
                          │          · <VENUE>_ENABLED · PERP_DATA_VENUES
        registerPerpAdapters() (einzige Instanziierungsstelle, NUR Public-Client)
                          │  BITUNIX → createBitunixPerpAdapter(BitunixPublicClient)
                          │  SIM     → createFixturePerpAdapter (offline, Tests)
                          ▼
                    syncPerpVenue (Fenster · Cursor · Rate/Retry · Batch)
                          ▼
        PerpStore (append-only, Idempotenzschlüssel) ──▶ Postgres: perp_*
                          ▼
     queryPerpSeries (as-of) ──▶ /api/marketdata/perpetual/{series,status}
                          ├─▶ Derivatekontext der Scanner-Signale
                          ├─▶ Funding-Replay von Backtest/Paper-Positionen
                          └─▶ Analystensnapshot + data/perpdata/derivatives.json
```

---

## 0. Code-Map (Modul → Verantwortung)

| Pfad | Verantwortung |
| --- | --- |
| `src/perpdata/types.ts` | Kanonische Zeilentypen, rohe Zeilentypen, Grenzen (`PERP_LIMITS`), `PERP_INSTRUMENT_ID_PATTERN`, Verfügbarkeits Enumern |
| `src/perpdata/config.ts` | 15 `PERP_DATA`-Flags, Bounds, Clamp + Warnung, Fail-closed-Defaults |
| `src/perpdata/capabilities.ts` | Capability-Katalog je Venue (typisiert `unsupported`) |
| `src/perpdata/adapters/bitunix.ts` | Realer Venue-Adapter (nur öffentliche Endpunkte) |
| `src/perpdata/adapters/fixture.ts` | SIM-Adapter mit fehlbaren Kanten (Lücken, Duplikate, negatives OI, 429/Timeout) |
| `src/perpdata/normalize.ts` | Roh → kanonisch: Einheiten, Zeitachsen, `availableAt`-Politik, Inhalts-Hash, qualifizierter Abweis |
| `src/perpdata/store.ts` | Drizzle-Ablage: `commitRun` (atomar, idempotent), Revisionsschutz, Wasserstände, Coverage, Retention |
| `src/perpdata/memoryStore.ts` | Speicher-Ablage für Dry-Runs und Tests (gleicher Port) |
| `src/perpdata/quality.ts` | Lücken, Staleness, OI-Plausibilität, Rate-Bounds, Duplikate, Cross-Venue-Check |
| `src/perpdata/query.ts` | as-of-Abfrage mit harten Grenzen, `availability` + `reason` |
| `src/perpdata/sync.ts` | Backfill/Incremental, Cursor-Fenster, Rate-Limit, Retry, Batch, Manifest |
| `src/perpdata/consumers.ts` | `DerivativeContext`, Funding-Rate-Provider der Backtest-Engine, Analystenzeilen |
| `src/perpdata/replay.ts` | Funding-Accrual einer Position über fällige Settlements |
| `src/perpdata/derivativeCache.ts` | Artefakt `data/perpdata/derivatives.json` (0600) inkl. Frische-Status |
| `src/perpdata/service.ts` | Orchestrierung, Statusbild, Gate-Kette |
| `drizzle/2026-09-20_perpetual_data.sql` | Append-only-Migration (fünf Tabellen, Constraints, Idempotenz) |

**Ausdrücklich nicht** Teil dieses Layers: Perp-Daten für Spot-Venues
(`selectPerpInstruments` filtert `marketType === "perpetual"`), das Speichern
roher Provider-Payloads, und jede Form von Querschnitts-Ranking über die
bestehenden Faktoren hinaus.

---

## 1. Kanonisches Schema

Drei Reihen, identische Provenienz-Spalten (`PerpProvenance`), damit jede Zeile
für sich beantwortet, woher sie stammt und wann sie wissen durfte, was sie sagt:

| Spalte | Bedeutung |
| --- | --- |
| `venue` | Venue-Key in Großbuchstaben (`BITUNIX`, `SIM`) |
| `instrument_id` | kanonische ID `VENUE:SYMBOL` (Allowlist-Muster, Länge 64) |
| `symbol` | Venue-Symbol, wie gemeldet |
| `source_id` | Endpunkt/Kanal (`bitunix:funding_history`) — Reproduzzleitkette |
| `schema_version` | Zeilenschema (aktuell 1), positiv ganzzahlig (CHECK) |
| `event_time` | **Ereigniszeit**: Settlement, OI-Messpunkt, Liquidation |
| `available_at` | ab wann die Zeile wahrheitsgemäß bekannt sein durfte |
| `fetched_at` | Abrufzeit beim Venue — Transport, nie Entscheidungsgrundlage |

Dazu je Reihe:

* **`perp_funding_rates`** — `funding_rate` (Dezimalanteil je Intervall, Einheit
  `fraction_per_interval`; 0.0001 = 1 bp), `interval_hours`,
  `next_funding_time`, `mark_price`. Nie ein Prozentwert und nie eine auf 8 h
  umgerechnete Zahl: die Umrechnung passiert beim Verbraucher
  (`fundingRateTo8h`).
* **`perp_open_interest`** — `contracts`, `base_quantity`, `quote_value` plus
  `basis` als **autoritativer** Größe der Quelle. Abgeleitete weitere Werte
  müssen `converted = true` tragen (CHECK: ohne Markierung höchstens ein Wert).
  Eine Umrechnung ohne bekannte Kontraktgröße oder ohne Währungscode wird
  **nicht** geraten.
* **`perp_liquidations`** — `side` (`LONG_LIQUIDATED`/`SHORT_LIQUIDATED`),
  `quantity_base`, `price`, `notional_quote`, `source_event_id`,
  `aggregate_count`. Liefert eine Venue die Order-Richtung des Zwangsverkaufs,
  biegt der Adapter sie auf die betroffene Position um (`SELL` ⇒ Long wurde
  liquidiert); ohne bestimmbare Richtung gibt es keinen Richtungs-Rat.

Zwei Invarianten sind als CHECKs in der Datenbank hart:

1. **Wert XOR Grund.** `missing_reason` steht genau dann, wenn kein Messwert
   da ist — „die Venue hat nichts gemeldet“ ist ein anderer Zustand als `0`.
   Bei Open Interest bleibt zusätzlich die Richtung sichtbar: eine Zeile, deren
   einziger Wert negativ war, wird schon in der Normalisierung qualifiziert
   abgewiesen (`INVALID_MEASURE`), weil `basis` ohne Messwert nicht darstellbar
   ist.
2. **Kein Blick in die Zukunft.** `available_at >= event_time` und
   `fetched_at >= event_time`; die as-of-Abfrage verlangt beides ≤ `asOf`.

`availableAt` folgt der Politik `PERP_DATA_AVAILABILITY`:
`ingested` (Default) = `max(event_time, fetched_at)`, `settlement` =
`event_time` für Replay-Forschung mit vollständiger Historie.

---

## 2. Capabilities: „kann nicht“ ist kein leeres Ergebnis

`perpCapabilitiesFor(venue)` beantwortet je Reihe `supported` plus `sourceId`,
`reason` und `note`. Der Grund ist eine geschlossene Liste
(`NO_PUBLIC_ENDPOINT`, `VENUE_NOT_PERP`, `DISABLED_BY_POLICY`) und damit von
einem transienten Ausfall (`HTTP_ERROR`, `RATE_LIMITED`, `NETWORK`, `TIMEOUT`,
`SCHEMA_MISMATCH`, `EMPTY_RESPONSE`, `LIMIT_EXCEEDED`, `STORE_UNAVAILABLE`)
streng getrennt.

| Venue | funding | openInterest | liquidations |
| --- | --- | --- | --- |
| `BITUNIX` | ✅ `get_funding_rate_history` (max 200 je Antwort, 10 req/s) | ❌ `NO_PUBLIC_ENDPOINT` | ❌ `NO_PUBLIC_ENDPOINT` |
| `SIM` (Fixture) | ✅ | ✅ | ✅ |

Bitunix veröffentlicht public **keinen** Open-Interest- und keinen
Force-Order/Liquidations-Endpunkt (Stand der API-Doku 2026-09); diese Reihen
bleiben deshalb typisiert `UNSUPPORTED` — der Sync schreibt keine Nullzeilen,
setzt den Cursor auf `UNSUPPORTED` mit Grund und zählt den Fall in den
Laufstatistiken. Beide Reihen werden über den SIM-Adapter geprüft (Fixture mit
negativem Open Interest, Lücken, Duplikaten, 429-Antworten).

Ein Reader, der `[]` als „keine Daten“ läse, verwechselte einen ruhigen Markt mit
einem fehlenden Endpunkt. Deshalb trägt **jedes** Reihenergebnis
`availability` (`AVAILABLE`/`MISSING`/`STALE`/`UNSUPPORTED`/`UNAVAILABLE`) und
einen `reason`.

---

## 3. Sync: append-only, idempotent, cursor-basiert

* **Fenster.** Backfill: `to = now − PERP_DATA_SAFETY_LAG_MS`,
  `from = to − PERP_DATA_BACKFILL_DAYS` (CLI `--from`/`--to`/`--days`
  überschreiben). Incremental: `from = min(Wasserstand der betroffenen Reihen −
  Überlapp)`, `to` wie oben. Der Überlapp ist je Reihe positiv, damit ein
  nachträglich korrigierter Satz erneut betrachtet wird.
* **Wasserstände** liegen in `perp_sync_cursors` je `(venue, instrument, kind)`:
  `watermark_event_time`, `watermark_available_at`, `consecutive_failures`,
  `last_status` (`OK`/`PARTIAL`/`FAILED`/`UNSUPPORTED`), `unsupported_reason`.
  Ein Cursor fällt **nie** zurück; `UNSUPPORTED` bleibt bis zum ersten Erfolg.
* **Idempotenz.** `perpRunIdempotencyKey({venue, mode, fromMs, toMs,
  instrumentIds, kinds, availabilityPolicy, codeVersion})` →
  `prk1:<sha256>` auf `perp_sync_runs.idempotency_key` (UNIQUE). Ein zweiter
  Lauf mit gleichem Schlüssel wird als Replay erkannt und schreibt nichts.
* **Zeilen-Idempotenz.** Alle Writes sind `ON CONFLICT (venue, instrument_id,
  event_time[, source_event_id]) DO NOTHING`. Abweichender Inhalt zum selben
  natürlichen Schlüssel ist eine **Revision**: die bestehende Zeile bleibt
  stehen, der Konflikt zählt (`revisionConflicts`, Metrik
  `perp_data_revisions_total`, Audit-Ereignis).
* **Begrenzung.** `PERP_LIMITS` ist harte Obergrenze, nicht Empfehlung: 250
  Instrumente je Lauf, 500 Zeilen je Request, 20 Requests je Reihe und Lauf,
  2 000 Zeilen je Batch und Ablage-Sicht, 250 Zeilen je Insert-Chunk, 200
  Qualitätsbefunde je Reihe. Alles darüber wird gekappt **und gemeldet**
  (`truncated`, Cursor `PARTIAL`).
* **Rate & Retry.** Ein Rate-Limiter pro Lauf (der Bitunix-Transport hat seinen
  eigenen Token-Bucket, Doku: 10 req/s, konfiguriert 8/s). Ein Wurf des
  Adapters oder ein `retryable` `UNAVAILABLE` (429/Timeout) wird einmal mit
  500 ms Pause wiederholt; danach bleibt die klassische Zeile im Manifest —
  redigiert (`perpRedactMessage`: URLs → `[url]`, `key=value`-Secrets →
  `[redacted]`, einzeilig, ≤ 200 Zeichen).
* **Atomarität.** `commitRun` schreibt Manifest, Zeilen und Cursor in
  **einer** Transaktion. Kein halbvoller Stand nach einem Absturz — der nächste
  Lauf wiederholt das Fenster und landet auf 0 neuen Zeilen.
* **Dry-Run.** `--dry-run` läuft die gesamte Kette gegen die
  Speicher-Ablage (Normalisierung, Qualität, Ansetzen inklusive) und lässt
  Postgres unberührt.

---

## 4. Qualitätsschicht (analog zum Kerzen-Quality-Layer)

`validatePerpSeries` prüft je (Instrument, Reihe) gegen das as-of-Fenster:

| Klasse | Befund |
| --- | --- |
| `GAP` | Lücke > 1,5 × erwartetes Raster (Raster je Reihe aus der Konfiguration) |
| `STALE` | jüngstes Ereignis älter als `PERP_DATA_MAX_STALE_*` (Alter gegen `event_time`, nicht gegen `available_at`) |
| `INVALID` | Struktur-/Plausibilitätsverstoß, u. a. negatives oder widersprüchliches Open Interest, Satz außerhalb der Bounds (`OUT_OF_BOUNDS`) |
| `DUPLICATE` | doppelter natürlicher Schlüssel in einer Ladung |
| `OUTLIER` | Rate oder Betrag außerordentlich (Bound überschritten ⇒ Wert wird `null` + Grund, **kein** geklemmter Wert) |
| `CROSSCHECK` | Funding weicht von der Zweitvenue ab (`PERP_DATA_CROSSCHECK_VENUE`, opt-in) |

Modus `PERP_DATA_QUALITY_MODE`:

* `log` (Default) — Befunde sind sichtbar (Report
  `data/perpdata/quality-report.json`, Log, Metrik, `qualityStatus` an der
  Zeile), der Bestand bleibt lesbar.
* `strict` — Reihen mit `INVALID`- oder `DUPLICATE`-Befund bleiben **ungeschrieben**
  und werden in der Abfrage gefiltert (`ALL_ROWS_REJECTED_BY_QUALITY`).

Zwei Konsumptionsregeln halten die Unterscheidung sauber:

* `perpRowIsAttestable(row)` — Zeilen mit `INVALID`, `DUPLICATE`, `CROSSCHECK`
  oder `UNKNOWN` ergeben **nie** ein Signal, einen Replay-Posten oder einen
  Cache-Wert, unabhängig von `log`/`strict`. `GAP`/`STALE`/`OUTLIER` betreffen
  Alter und Lücke, nicht die Zahl selbst.
* Wird eine Reihe allein wegen der Belegbarkeit geleert, meldet der Snapshot den
  Grund `ALL_ROWS_UNATTESTABLE` statt still `null`.

---

## 5. as-of-Abfrage und HTTP-API

```
GET /api/marketdata/perpetual/series?instruments=BITUNIX:BTCUSDT&kinds=funding&asOf=2026-09-20T10:00:00.000Z&limit=500
```

| Parameter | Regel |
| --- | --- |
| `instruments` | Pflicht, CSV kanonischer IDs oder Symbole, ≤ 200 |
| `venue` | optionaler Venue-Filter |
| `kinds` | `funding`, `openInterest`, `liquidations` (Default: alle) |
| `from` / `to` | ISO oder Epoch-ms über die **Ereigniszeit** |
| `asOf` | ISO oder Epoch-ms; liefert nur `event_time ≤ asOf` **und** `available_at ≤ asOf` |
| `limit` | Zeilen je Instrument/Reihe, Default 500, hart bei 2 000 |

Fehler sind Teil des Vertrags: `{ ok:false, error, message, hint }` — 400 bei
Anfrageablehnung (`query:instruments_required`, `query:kind_invalid`,
`query:time_invalid`, `query:limit_invalid`, `query:invalid_instrument`,
`query:too_many_instruments`), 503 `perp:store_unavailable`, wenn die Ablage
nicht erreichbar ist. **Nie** 200 mit leerem Bestand als Ersatz für „wir wissen
nichts“. Beide Routen sind ausschließlich `GET` und lösen keinen Sync aus;
`GET /api/marketdata/perpetual/status` zeigt Gates, Capabilities, Grenzen,
Coverage, letzte Läufe und den Quality-Report-Kopf (Ablagestatus ist dort Teil
der Antwort, kein 500).

---

## 6. Konsumenten

* **Scanner/Signale** — `perpDerivativeProvider` liefert den
  `DerivativeContext` (Funding-Rate, Intervall, Open Interest in Quote, Δ24 h)
  aus der kanonischen Ablage. Ohne Freigabe (`PERP_DATA_ENABLED=false`) oder ohne
  Daten bleibt er `null` und die Faktoren `funding`/`openInterest` verhalten sich
  exakt wie vor v1.54.0; der Grund steht im Snapshot (`reasons` je Reihe).
* **Backtest/Paper** — `createPerpFundingRateProvider` speist die
  `FundingAccrualEngine` (die live denselben Rechner nutzt) mit historischen
  Raten; `replayPositionFunding` setzt **nur fällige** Settlements innerhalb der
  Haltedauer an, mit `hiddenRows` (Look-ahead-Schutz), `missingMarks` (fehlende
  Marken) und `qualityFlagged` (ausgesonderte Sätze). Verfügbare Raten werden
  über `intervalHours` auf das 8-h-Raster der Engine normalisiert — nie durch
  Raten-Klemmen.
* **Analysten** — `perpAnalystSnapshotLines(FromCache)` ergänzt die
  Derivatzeilen im Research-Protokoll; `unavailable`-Einträge erscheinen als
  „unavailable (grund)“, nie als 0.
* **Artefakt** — `data/perpdata/derivatives.json` (Modus 0600, atomarer
  Write) hält den Stand für Offline-Scans. Status: `FRESH`, `STALE`,
  `FILE_STALE` (zu alt für die Frischeanforderung), `MISSING`, `DISABLED`,
  `ERROR`. Ein zu altes Artefakt wird verworfen statt mit Alt-Werten zu scannen.

---

## 7. CLI (`scripts/perp-sync.ts`)

```bash
npm run perp:sync -- --status                        # Gates, Capabilities, Coverage
npm run perp:sync -- --fixture --dry-run --mode=backfill   # Offline-Validierung, netzfrei
npm run perp:sync -- --venue=BITUNIX --mode=incremental --kinds=funding
npm run perp:sync:fixture                             # Alias für den Offline-Check
```

| Flag | Wirkung |
| --- | --- |
| `--venue=` | kommagetrennte Venues (Großschreibung, Format `[A-Z0-9][A-Z0-9_-]{0,31}`) |
| `--mode=` | `incremental` (Default) \| `backfill` |
| `--days=` | Backfill-Tiefe je Reihe (Bounds `PERP_BOUNDS.backfillDays`) |
| `--from=` / `--to=` | ISO-8601 oder Epoch-ms (Ereigniszeit-Fenster) |
| `--kinds=` | `funding,openInterest,liquidations` |
| `--availability=` | `ingested` \| `settlement` |
| `--quality=` | `log` \| `strict` |
| `--max-instruments=` | harte Kappung je Lauf (≤ 250) |
| `--concurrency=` | parallele Reihen (1–8) |
| `--safety-lag=` | Fenster-Nachlauf in ms |
| `--dry-run` | alles rechnen, nichts in die Ablage schreiben |
| `--fixture` | SIM-Venue + temporäre Fixture-Universe, Gates offen, kein Netz |
| `--status` | Betriebsbild statt Lauf |
| `--refresh-cache` | Derivat-Artefakt aus der Ablage neu bauen |
| `--prune-runs=` | Manifest-Retention (behält N je Venue, **nie** Datenzeilen) |
| `--json` | maschinenlesbare Ausgabe |
| `--help` | USAGE |

Exit-Codes: `0` gelaufen, `1` blockiert/fehlgeschlagen (Verschließen der Gates ist
ein Fehler für den Cron-Aufrufer, damit ein nicht laufender Sync im Monitoring
auffällt), `2` Aufruffehler (unbekanntes Flag, Wert außerhalb der Bounds).

---

## 8. Konfiguration

Vollständige Flag-Referenz mit Defaults:
[`CONFIGURATION.md`](../CONFIGURATION.md#perpetual-daten-rma-p2-02-v1540) und
`.env.example`. Kurz: `PERP_DATA_ENABLED` und `PERP_DATA_SYNC_ENABLED` stehen
beide auf `false`; ohne sie ändert sich am System nichts.

---

## 9. Migration und Betrieb

```bash
psql "$DATABASE_URL" -f drizzle/2026-09-20_perpetual_data.sql   # idempotent
# oder: npx drizzle-kit push
npm run perp:sync -- --fixture --dry-run --mode=backfill        # Offline-Check
npm run perp:sync -- --venue=BITUNIX --mode=backfill --days=30
```

Die Migration ist append-only (fünf Tabellen, keine Änderung an bestehenden),
wiederholbar (`IF NOT EXISTS`) und ohne Backfill-Zwang: der erste Sync füllt das
Fenster. Rollback: Gates aus, Code zurück, `DROP TABLE` der fünf `perp_*`-Tabellen
(nur wenn kein v1.54.0-Code mehr läuft) — der Bestand ist aus denselben Quellen
reproduzierbar.

Metriken (`/metrics`, Ausweis über `src/lib/telemetry.ts`):
`perp_sync_runs_total{result,mode}`, `perp_sync_rows_total{kind,result}`,
`perp_data_quality_findings_total{class}`, `perp_data_revisions_total{kind}`,
`perp_data_asof_queries_total{result,kind}`. Labels sind bounded
(`metricLabel`-gekapselt, nie Instrument-IDs).

---

## 10. Sicherheit und Grenzen

* Nur **öffentliche** Endpunkte: kein PrivateClient, kein API-Key, keine
  Signatur im gesamten `src/perpdata`-Baum (Architekturtest).
* Keine Roh-Payloads: die Insert-Maps kennen ausschließlich kanonische Spalten.
* Keine Secret-Leaks: Fremd-Fehlermeldungen laufen durch `perpRedactMessage`,
  bevor sie Manifest, Log oder API-Body erreichen.
* Injection-Grenze: `PERP_INSTRUMENT_ID_PATTERN` gilt in Universe-Auflösung,
  Adapter und as-of-Validierung; abgelehnte IDs werden im Echo gekürzt und
  kontrollzeichenfrei gemacht. Instrument-IDs werden nie zu Dateinamen.
* Keine Risiko-Seiteneffekte: Der Layer schreibt nur in `perp_*`-Tabellen und
  seine zwei Artefakte. Risk-Limits, Kill-Switch, Authority-Kette und Live-Gate
  bleiben unberührt; ein Perp-Ausfall macht nichts „erlaubt“, er macht Daten
  unavailable.

## 11. Tests

| Suite | Deckung |
| --- | --- |
| `tests/perpPipeline.normalize.test.ts` | Einheiten, Zeitachsen, `availableAt`-Politik, qualifizierter Abweis, Duplikat-/Truncation-Behandlung |
| `tests/perpPipeline.sync.test.ts` | Backfill + Idempotenz + Increment, unsupported vs. transient vs. leer, Qualität (Lücke, Staleness, negatives OI, Cross-Check, strict vs. log) |
| `tests/perpPipeline.db.test.ts` | echte Postgres (embedded): Constraints, Replay, Revision, Wasserstand nach Neustart, as-of, Retention |
| `tests/perpPipeline.consumers.test.ts` | as-of-Grenze, Derivatekontext, Funding-Replay, Artefakt, Analystenzeilen, Belegbarkeit |
| `tests/perpPipeline.security.test.ts` | Public-only, Leak-freiheit, keine Roh-Payloads, Allowlist, Label-Bounds, read-only-Routen, Antwortbombing |
| `tests/perpPipeline.cli.test.ts` | Flag-Parser, Env-Übersetzung, 400/405-Vertrag, zwei CLI-Läufe im Kindprozess |
