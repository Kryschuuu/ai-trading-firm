# Market-Data-Pipeline — Discovery, Enrichment, Backfill

> **Status-Header:** **Implementiert** · Dokumentationsstand **2026-08-30** ·
> Code-Version **1.28.0** · Modul `src/marketdata/` · CLI `npm run market-sync`
> (Historien-Migration: `npm run history:migrate` · ID-Normalisierung:
> `npm run symbols:normalize`)

Die Pipeline füllt Instrument-Registry und Historical Store aus **öffentlichen**
Venue-Marktdaten, **bevor** der deterministische Scanner läuft. Der Scanner
(`scanUniverse()`) führt weiterhin **keinen** Netzwerk-Call aus.

```
AdapterRegistry (src/marketdata/adapterRegistry.ts)
  └─ konkrete MarketDataAdapter-Instanzen (einzige Instanzierungsstelle)
         │  BITUNIX → BitunixBrokerAdapter (Modus "paper", Public-Client)
Discovery / Enrichment
         ▼
MarketDataSyncService (instruments, ticker, orderbook, candles)
         │
┌────────┴────────┐
▼                 ▼
InstrumentRegistry  HistoricalStore
         │
         ▼
ScannerService (PURE: kein Netzwerk, kein DB-I/O, kein LLM)
         ▼
Funnel
```

---

## 1. Discovery

`MarketDataAdapter.discoverInstruments()` holt die handelbare Instrumentenliste
der Venue (Bitunix: `GET /api/v1/futures/market/trading_pairs`). Genau **ein**
Request pro `syncVenue()`-Lauf.

Gemappte Zeilen sind `MarketInstrument`-Sätze (`id = VENUE:SYMBOL`). Kaputte
Zeilen verwirft der Venue-Mapper, nicht der Sync-Service. Ein leeres Ergebnis
ist gültig: `instrumentsDiscovered: 0`, kein Crash.

Unbekannte Venue → `UnsupportedVenueError` (`code: UNSUPPORTED_VENUE`), bevor
irgendein Request startet.

## 2. Metadata enrichment

**Seit v1.25.2 (nachgearbeitet zu PR #35):** Ticker- und Orderbook-Enrichment
laufen vor dem Candle-Backfill — feste Reihenfolge je Instrument:
`tickers → depth → ein Upsert → kline`.

Nach Discovery reichert der Service jedes Instrument mit 24h-Volumen an:

- Bevorzugt **1 × tickers** (Batch), wenn `adapter.getTickers` existiert
  (Bitunix: `GET /api/v1/futures/market/tickers` ohne Symbolfilter).
- Sonst **N × getTicker(symbol)** — der Pfad, den Mock-Adapter in Unit-Tests
  nutzen.

`volume24h` wird aus `ticker.quoteVol` geschrieben. Fehlt der Ticker, bleibt
der Wert `null` (unbekannt, nicht 0). `lastSeen` wird auf den Sync-Zeitpunkt
gesetzt. Quelle des Upserts: `sync:<VENUE>`.

**Symbol-Guard:** Ein per-Symbol-Ticker wird nur übernommen, wenn
`ticker.symbol` exakt (case-insensitiv) dem Instrument entspricht. Fällt ein
Venue-Client auf eine fremde Zeile zurück, bleibt `volume24h` lieber `null`,
als dass ein fremdes Volumen geschrieben wird — der Fall landet in
`SyncResult.errors` (`stage: "ticker"`).

### Enrichment-Datenfluss (Ende-zu-Ende)

```
GET /trading_pairs                       (1× — Discovery)
   │  symbol, base, quote, minTradeVolume, basePrecision,
   │  quotePrecision, maxLeverage, symbolStatus, isApiSupported
   │  └─ statische HANDELSPARAMETER — keine Liquiditäts-/Preismetriken
   ▼
registry instruments  (id = "VENUE:SYMBOL", volume24h = null, spread = null)
   │
   ├─ GET /tickers?symbols=…             (1× Batch; Fallback N× getTicker)
   │     quoteVol ─────────────────────────────────► volume24h  (null wenn absent)
   │
   ├─ GET /depth?symbol=…                (N× — 1 Call je Instrument)
   │     bids[0].price, asks[0].price
   │        └─ calculateRelativeSpread(bid, ask)
   │             (ask − bid) / mid ,  mid = (ask + bid) / 2
   │             └──────────────────────────────────► spread     (null wenn Book leer)
   │
   ▼
registry.upsert({ ...instrument, volume24h, spread, lastSeen }, "sync:<VENUE>")
   │
   ├─ GET /kline?symbol=…&interval=…     (N × 4 Timeframes)
   │        └──────────────────────────────────────► HistoricalStore.append(...)
   ▼
Scanner (pure) ── liquidity-Faktor ── volume24h ?? (letzte Kerze volume × close)
              └── spread-Faktor ───── spread (KEIN Fallback)
                     └─ checkEligibility(): min-volume / max-spread
```

## 3. Orderbook enrichment

**Seit v1.25.2 (nachgearbeitet zu PR #35).** Pro Instrument **1 × depth**
(`getOrderBook`). Der relative Spread

```
(ask − bid) / mid     mid = (ask + bid) / 2
```

kommt aus `calculateRelativeSpread(book.bids[0]?.price, book.asks[0]?.price)`.
Fehlt `bids[0]` oder `asks[0]`, ist der Spread `null` — kein Crash, kein
optimistisches 0.

**Warum dieser Call nötig ist:** Die Ticker-API liefert das 24h-Volumen, aber
**keine** Bid/Ask-Spanne. Der Spread kann nur aus dem Orderbook berechnet
werden, also kostet jedes Instrument einen zusätzlichen `/depth`-Request
(bei 180 Instrumenten 180 Requests — über den Token-Bucket gedrosselt, §9).

**`spread = null` ist kein 0.** `null` bedeutet „nicht geladen“ und ist im
Eligibility-Filter ausdrücklich von einem (fachlich verdächtigen) Spread von 0
unterschieden. `checkEligibility()` lehnt solche Instrumente als
**Data-Quality-Rejection** ab (`ruleId: "max-spread"`, `dataQuality: true`,
Meldung „Spread wurde nicht geladen …“) — das ist ein Hinweis auf fehlenden
Warmup, kein Marktausschluss (§8).

## 4. Historical backfill

Pro Instrument und Timeframe **N × candle**:

| Timeframe | Limit |
| --- | ---: |
| `5m` | 150 |
| `15m` | 150 |
| `30m` | 150 |
| `1h` | 150 |

Kerzen landen in `data/history/candles.ndjson` mit Provenienz
`{ venue, feed: "<VENUE>:rest" }` und **verpflichtendem** Feld `timeframe`.
Seit Schema-Version **v2** (1.26.0) ist `timeframe` Teil des logischen
Primärschlüssels (`instrumentId + timeframe + ts`); der Store dedupliziert
deterministisch (jüngstes `fetchedAt` gewinnt). Der Scanner liest danach
bevorzugt `1h` (Präferenz `1h → 4h → 30m → 15m → 5m`, danach Legacy-Fallback).

## 5. Persistence

| Senke | Datei | Mutation |
| --- | --- | --- |
| Instrument-Registry | `data/universe/instruments.ndjson` | `registry.upsert(..., "sync:<VENUE>")` |
| Historical Store | `data/history/candles.ndjson` | `history.append(candles, id, provenance, timeframe, now)` |
| Universe-Audit | `data/universe/audit-log.ndjson` | ein Eintrag je mutierendem Upsert |

Keine PostgreSQL-Pflicht. Kein Private-Ledger. `/api/markets` bleibt **read-only**
und triggert `syncVenue()` nicht.

### 5.1 Historical-Store-Schema (v2, seit 1.26.0)

Jede Zeile ist ein NDJSON-Datensatz mit Schema-Version `"v": 2`:

```json
{"v":2,"instrumentId":"BITUNIX:BTCUSDT","venue":"BITUNIX","feed":"BITUNIX:rest",
 "timeframe":"1h","ts":1700000000000,"open":100,"high":101,"low":99,
 "close":100.5,"volume":1234,"fetchedAt":"2026-08-29T00:00:00.000Z"}
```

* **Logischer Primärschlüssel:** `instrumentId + timeframe + ts`.
* **`timeframe` ist Pflicht** — in `HistoricalCandleEntry`, im
  `append(candles, instrumentId, provenance, timeframe, now)`-Aufruf und im
  `query({ instrumentId, timeframe, from?, to?, limit? })`-Filter. Ein
  Timeframe-freier Zugriff wirft (Compile + Runtime-Guard), weil er Kerzen
  unterschiedlicher Periodizität mischen und jede EMA/Momentum/Volatilität
  unbemerkt verfälschen würde.
* **Deduplizierung:** Bei Schlüsselkollision gewinnt der Eintrag mit dem
  **jüngsten `fetchedAt`**; bei Gleichstand der zuletzt gelesene.
  `append()` liefert `{ written, deduplicated }`.
* **Ergebnisreihenfolge:** `ts` aufsteigend; `limit` liefert die letzten N
  Bars (jüngste), wieder aufsteigend sortiert. `from`/`to` sind inklusiv.
* **Größenkontrolle:** optionales `maxBarsPerSeries` (Default **5000**),
  Kompaktierung behält je Reihe die jüngsten Bars.
* **Robustheit:** Der Loader arbeitet puffer-/streambasiert (kein OOM bei
  großen Historien); kaputte Teilzeilen werden geloggt und übersprungen
  (kein Prozessabbruch). Schreibvorgänge laufen atomar über
  `tmp` + `rename`, Dateirechte `0600`.
* **Sicherheit:** `instrumentId`/`timeframe`/`feed` werden nie in Dateipfade
  interpoliert (Store schreibt ausschließlich in den konfigurierten Pfad);
  Zeilen entstehen per `JSON.stringify` (keine Zeilen-Injection); Werte werden
  validiert (`Number.isFinite` für OHLCV, `ts` positive Ganzzahl, Timeframe
  gegen Allowlist); geparste Zeilen werden feldweise gemappt (kein Spread,
  `__proto__`/`constructor` werden verworfen).

### 5.2 Legacy-Schema (v1) und Migration

Zeilen **ohne** `timeframe` (Altbestand vor 1.26.0) werden im Runtime-Loader
mit dem Marker `LEGACY_UNKNOWN` versehen, **gezählt** und über
Timeframe-Queries **nie** ausgeliefert. Beim ersten Fund gibt es eine
**einmalige Warnung** mit Migrationshinweis. Die Migration ist destruktiv
scheinfrei, sichert vorher und ist idempotent:

```bash
# 1. trocken prüfen — Dry-Run ist der Default (schreibt nichts, kein Backup,
#    Exit-Code 2 weist auf das fehlende --apply hin)
npm run history:migrate -- --file=data/history/candles.ndjson \
  --assume-timeframe=15m

# 2. migrieren — erst --apply schreibt (Backup candles.ndjson.bak-<ISO>, chmod 600)
npm run history:migrate -- --file=data/history/candles.ndjson \
  --assume-timeframe=15m --apply
```

`--assume-timeframe` ist **Pflicht**, sobald die Datei Legacy-Zeilen enthält:
5m- und 1h-Bars sind im alten Schema ununterscheidbar, ein erratener Wert
würde die Reihen dauerhaft falsch beschriften. Das Skript rät nie.
Vollständige Schema-/Schlüssel-/Rollback-Doku: [`docs/HISTORY.md`](HISTORY.md).

### 5.3 Empfohlener Migrationspfad: Neuaufbau statt Inline-Migration

Für den **Bitunix-Feed ist der Neuaufbau der empfohlene Weg** — nicht die
Inline-Migration des Altbestands:

```bash
# 1. Schreiber stoppen, 2. Backup (siehe Runbook), dann:
mv data/history/candles.ndjson data/history/candles.ndjson.pre-v2
npm run market-sync -- --venue=BITUNIX
```

| Grund | Erläuterung |
| --- | --- |
| Datenvolumen gering | 150 Bars je Instrument und Timeframe, vier Timeframes (`5m`, `15m`, `30m`, `1h`) — ein Sync-Lauf genügt |
| Kein Rate-Limit-Problem | öffentliche REST-Schnittstelle, 4 Requests je Instrument |
| Keine Rate-Fehler möglich | der Timeframe stammt aus dem Backfill-Kontext statt aus einer Annahme |
| Prüfbar | Sync-Report nennt `written` je Instrument und Timeframe |

Die Inline-Migration (`npm run history:migrate`) ist bewusst nur das
**Sicherheitsnetz** für Umgebungen ohne Netz-/Rate-Limit-Spielraum. Sie
schreibt seit 1.26.2 **nur mit explizitem `--apply`** — ohne das Flag läuft
sie als Dry-Run (kein Schreiben, kein Backup, Exit-Code 2).

Schritt-für-Schritt-Anleitung für Produktionsumgebungen (Backup, Dry-Run,
Anwenden, Validierung, Rollback):
[`docs/MIGRATION_TIMEFRAME_FIELD.md`](MIGRATION_TIMEFRAME_FIELD.md).

## 6. Readiness

**Seit v1.25.3 (OPS-009).** Der Scanner rechnet einen expliziten,
deterministischen Readiness-Zustand **vor** der Funnel-Auswertung und weist ihn
getrennt aus (`ScanResult.readiness`, Typ `READY | WARMING | ERROR`). Damit
lässt sich Infrastruktur (fehlende/fehlerhafte Daten) von Fachlogik (Markt
ungeeignet) unterscheiden.

### Abgeleiteter Warmup-Bedarf (`requiredWarmupCandles`)

Der Schwellwert wird **nicht** hartcodiert, sondern aus dem konfigurierten
Faktorsatz abgeleitet — die einzige Quelle der Warmup-Wahrheit
(`src/scanner/warmup.ts`):

```ts
requiredWarmupCandles(config) = Math.min(
  Math.max(
    factors.trend.slowPeriod,        // EMA50 → 50
    ...factors.momentum.lookbacks,   // 60 → braucht 61 (n+1)
    factors.drawdown.lookback,       // 60
    factors.volatility.lookback + 1, // 30 + 1 (Returns brauchen eine Kerze mehr)
    factors.volumeRatio.basePeriods, // 20
  ) + 1,
  MAX_WARMUP_CANDLES,                // 1000 (Security-Kappe)
)
// Default: max(50, 60, 60, 31, 20) + 1 = 61
```

Wer einen Faktor-Lookback erhöht, erhöht damit automatisch den Warmup-Bedarf.
`filters.minCandles` ist **optional**: ohne expliziten Wert gilt der abgeleitete
Bedarf (`minCandles ?? requiredWarmupCandles(config)`). Ein explizit gesetzter,
kleinerer Wert erzeugt bei der Config-Validierung eine Warnung (Strict-Modus:
Fehler), weil Instrumente den Filter sonst mit unvollständigen Faktor-Scores
passieren würden.

### Zustände

| Status | Bedingung | Bedeutung / Behebung |
| --- | --- | --- |
| `READY` | alle Instrumente haben ≥ `requiredCandles` Kerzen | scan-bereit |
| `WARMING` | Historie fehlt (kein Fetch-Fehler) | `npm run market-sync` — Datenverfügbarkeit, kein Marktausschluss |
| `ERROR` | ≥ 1 echter Fetch-/Infrastruktur-Fehler (MDERR-006, aus `dataErrors`/Manifest) | Infrastruktur schlägt Fachlogik; Venue/Netz prüfen — kein Marktausschluss |

Seit v1.26.1 speist der Sync das **Fehler-Manifest**
(`data/market-data-errors.json`, `src/marketdata/dataErrors.ts`) in den
Scanner ein: betroffene Instrumente werden mit `data-unavailable` abgelehnt
(`dataQuality: true`) statt mit `min-candles`; `min-candles` bleibt die
behebbare Warnung für **genuin fehlende** Historie (`WARMING`).

`assessDataReadiness(...)` ist eine **reine** Funktion (kein I/O, keine Uhr,
keine Mutation). `worstOffenders` (nur im `WARMING`-Zustand) ist deterministisch
sortiert (candles asc, dann instrumentId asc) und auf 10 Einträge begrenzt.
Fehlerbegründungen im `ERROR`-Zustand werden redigiert (keine URLs/Pfade).

Voraussetzungen für `READY`:

1. `MarketDataSyncService.syncVenue(venue)` ist durchgelaufen (CLI oder
   `npm run scan -- --sync-first`).
2. Die Registry enthält Instrumente mit frischem `lastSeen` und — soweit die
   Venue lieferte — `volume24h` / `spread`.
3. Der Historical Store hat je aktivem Instrument ≥ `requiredWarmupCandles`
   (Default 61) Kerzen des Scanner-Timeframes (`1h`).

Ohne Warmup: 26 Seed-Instrumente × 0 Kerzen → Readiness `WARMING` (missing = 26)
→ alle `min-candles` → Eligible = Interesting = Daily = Deep = 0. Das ist kein
Scanner-Bug, sondern fehlende Historie — und wird jetzt explizit als solche
gemeldet statt als generische Ablehnung.

### Market-Data-Readiness-Report (Operations Center, v1.27.0 / OPS-010)

Der Readiness-**Zustand** (oben) bewertet nur die Kerzen-Stufe. Für die
Root-Cause-Diagnose aggregiert das Operations Center zusätzlich den
Zustand **entlang aller Pipeline-Stufen** (Discovery → Enrichment →
Backfill → Readiness): `collectMarketDataReadiness()`
(`src/ops/marketDataReadiness.ts`) berechnet aus Instrument-Registry,
Historical Store und der Konfiguration des letzten Scans — **ohne
Netzwerk-I/O**, reine Aggregation vorhandener Zustände — den strukturierten
`MarketDataReadinessReport`, der als additives Feld `marketDataReadiness`
in der Antwort von `GET /api/ops` erscheint:

| Feld | Quelle / Regel |
| --- | --- |
| `venue` | exakt eine Venue im Bestand, sonst `"ALL"` |
| `registryCount` | `registry.size` (Gesamtbestand) |
| `discoveredCount` | `lastSeen` innerhalb von 24 h (`DISCOVERY_FRESHNESS_WINDOW_MS`) |
| `dataReadyCount` | Kerzen **≥** `requiredWarmupCandles(config)` (Grenzwert gilt als ready) UND `volume24h !== null` UND `spread !== null` |
| `warmingCount` | `registryCount − dataReadyCount` |
| `candlesLoaded` | Summe der geladenen Kerzen über alle Registry-Instrumente (Scanner-Timeframe, dieselbe Zeitreihen-Auswahl wie der Scan); `0` ⇒ kein/fehlgeschlagener Sync |
| `candlesRequired` | Referenzwert **je Instrument** aus `requiredWarmupCandles(config)` (Default 61) |
| `tickerReadyCount` | `volume24h !== null` (Schritt „tickers“ gelaufen) |
| `spreadReadyCount` | `spread !== null` (Schritt „depth“ gelaufen) |
| `scannerReady` | `dataReadyCount > 0` |

Damit ist der Engpass ohne Log-Lektüre ablesbar: `Registry 26, Discovered 26,
Candles 0/61, Ticker-ready 0, Spread-ready 0` ⇒ Discovery lief, aber weder
Enrichment noch Backfill → `npm run market-sync` (bzw. dessen Fehler-Manifest
§8) prüfen. Der Schritt-für-Schritt-Walkthrough steht in
[`docs/OPERATIONS_CENTER.md`](OPERATIONS_CENTER.md).

### Eligibility-Ablehnungs-Diagnose (v1.27.0 / OPS-010)

Zusätzlich wird jede Ablehnung des Eignungsfilters mit dem **vollständigen
Datenzustand** des Instruments angereichert (`src/scanner/eligibilityDiagnostics.ts`,
Payload-Feld `eligibilityDiagnostics`, auf 50 Einträge gedeckelt — `total`
zählt voll). Aus „BITUNIX:BTCUSDT ist ungeeignet (`max-spread`)“ wird damit
eine Data-Quality-Aussage mit Kontext:

```json
{
  "instrument": "BITUNIX:BTCUSDT",
  "eligibility": {
    "status": "rejected",
    "rule": "max-spread",
    "dataQuality": true,
    "data": { "candles": 150, "volume24h": 2840000000, "spread": null }
  }
}
```

Kerzen reichlich (150 ≥ 61), Volumen bekannt — aber `spread: null`: die
Ablehnung bedeutet „**Spread wurde nicht geladen**“ (depth-Enrichment fehlt,
§3), nicht „Markt zu teuer“. Das diagnostische Modul ändert das
„erste Regel gewinnt“-Routing des Filters ausdrücklich **nicht** — es dient
ausschließlich Monitoring/Debugging (siehe Dateikopf des Moduls).

## 7. Scanner execution

```bash
npm run market-sync                 # Netzwerk, public REST, Token-Bucket
npm run scan                        # lokal, deterministisch, kein Netz
# oder
npm run scan -- --sync-first        # Warmup, danach derselbe lokale Scan
```

Seit v1.26.1 bricht `--sync-first` bei Sync-Fehlern **nicht** mehr ab: Die
Fehler landen im Manifest, der Scan läuft mit `dataErrors` (Readiness
`ERROR`, `data-unavailable`-Rejections), der Prozess beendet sich mit
Exit-Code 1, damit CI/Automatisierung den Datenfehler sieht.

`scanUniverse()` importiert `src/marketdata/sync.ts` **nicht**. Der Service
`ScannerService` liest `HistoricalStore.query()` und `InstrumentRegistry.query()`.
Gleiche Eingabe → gleiches Artefakt.

## 8. Failure semantics

**Seit v1.26.1 (MDERR-006):** Abruf-Fehler sind typisiert, metrifiziert und
für den Scanner als `DATA_UNAVAILABLE`/Readiness `ERROR` sichtbar — sie werden
**nie** auf „leeres Array“ oder `min-candles` abgebildet. Details: Ursachen-
Taxonomie (`MarketDataErrorReason`), Metrik, strukturierte Logs und
Redaction in **[OBSERVABILITY.md](OBSERVABILITY.md)**. Die operative
Antwort auf „werfen vs. Cache vs. `DATA_UNAVAILABLE`“ steht im
**Entscheidungsbaum [ERROR_HANDLING_MARKETDATA.md](ERROR_HANDLING_MARKETDATA.md)**.

### Vollständige Fehlertaxonomie und Behandlung

| `reason` | Auslöser | `retryable` | Sync-Service | Scanner / Operations Center |
| --- | --- | :---: | --- | --- |
| `RATE_LIMITED` | HTTP 429 / Venue `code=10001` | ja | Fehler isoliert, Manifest `RATE_LIMITED` | `data-unavailable`, Readiness `ERROR`; Token-Bucket/Backoff prüfen |
| `UPSTREAM_5XX` | HTTP 5xx | ja | Fehler isoliert, Manifest `UPSTREAM_5XX` | `data-unavailable`, Readiness `ERROR`; Venue-Status prüfen |
| `UNAUTHORIZED` | HTTP 401/403 im Public-Pfad | nein | Fehler isoliert, Manifest `UNAUTHORIZED`, Critical-Alarm | Konfigurationsfehler (versehentlicher Auth-Endpunkt) |
| `NOT_FOUND` | HTTP 404 / unbekanntes Symbol | nein | Fehler isoliert, Manifest `NOT_FOUND` | Instrument nicht (mehr) handelbar; Registry prüfen |
| `INVALID_SYMBOL` | Symbolformat verletzt Whitelist | nein | Fehler isoliert, Manifest `INVALID_SYMBOL` | Eingabe-/Config-Fehler; Registry prüfen |
| `SCHEMA_MISMATCH` | JSON-Parse / unerwartetes Schema | nein | Fehler isoliert, Manifest `SCHEMA_MISMATCH` | Venue-API geändert; Adapter/Normalisierung anpassen |
| `TIMEOUT` | Timeout-Timer / `AbortError` | ja | Fehler isoliert | Netz/Latenz; prod. Monitoring |
| `NETWORK` | `ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET` … | ja | Fehler isoliert | Netz/Infrastruktur prüfen |
| `TLS` | `ERR_TLS_*`, Zertifikat/Hostname | nein | Fehler isoliert | Zertifikat/Deployment sofort prüfen (MitM?) |
| `ABORTED` | expliziter Abbruch | nein | Fehler isoliert | Aufrufer-Abbruch |
| `UNKNOWN` | alles andere | nein | Fehler isoliert | Doku/Log analysieren |

Diese Klassen werden **nie** als „keine Daten vorhanden“ interpretiert. Nur
eine tatsächliche leere Venue-Antwort (`[]`) wird als fehlende Historie
behandelt (`min-candles` → `WARMING`).

| Ereignis | Verhalten |
| --- | --- |
| Unbekannte Venue | `UnsupportedVenueError`, kein Partial-Write |
| Leere Discovery | `SyncResult` mit Zählern 0, Exit 0 |
| `getTicker` / `getOrderBook` / `getCandles` wirft | Fehler in `SyncResult.errors`, **Instrument isoliert**, Lauf geht weiter |
| **Kerzen-Abruf wirft** (MDERR-006) | Fehler in `SyncResult.errors` **und** persistiertes Fehler-Manifest `data/market-data-errors.json` (klassifizierte `reason` je Instrument) → Scanner: `data-unavailable` + Readiness `ERROR` |
| Upsert per Policy abgelehnt | Registry-`rejected`; Sync bricht nicht ab |
| Ticker-Symbol ≠ Instrument | `volume24h` bleibt `null`, Eintrag in `errors` (`stage: "ticker"`) |
| Discovery selbst wirft | Lauf bricht ab (ohne Instrumente gibt es nichts zu isolieren) |

CLI loggt nur aggregierte Zähler (`discovery`, `tickers enriched`,
`orderbooks enriched`, `5m candles: N/N`, `errors: K`) plus
`market_sync_fetch_failures` (venue, count, byStage). Keine Symbole, keine
URLs, keine Secrets.

### `getCandles()` (legacy REST-Cache-Pfad) — wirft statt `[]`

Der REST-/Cache-Pfad in `src/lib/marketData.ts` wird von Analysten, Monitor,
MicroExecutor-Warmstart und Backtest genutzt:

- `getCandles()` wirft bei echten Fehlern `MarketDataFetchError`
  (Klassifikation in `src/lib/marketDataErrors.ts`), inkl. Metrik
  (`market_data_fetch_failures_total`) und strukturiertem Log
  (`market_data_fetch_failed`, inkl. explizitem
  „FETCH FAILED … infrastructure/API error“-Text mit Verweis auf
  `docs/ERROR_HANDLING_MARKETDATA.md`). Das alte
  `catch { return cached?.candles ?? []; }` ist **entfernt**.
- **Leere Venue-Antwort** (`[]`, nachweislich keine Bars) wird **nicht**
  geworfen — sie wird gecacht und zurückgegeben. Die Abgrenzung ist getestet.
- `getCandlesWithFallback()` ist die **explizite** Stale-Cache-API (nur für
  Aufrufer, die degradierten Betrieb bewusst erlauben, z. B. UI-Preview):
  liefert `{ candles, source: "live"|"cache", stale, ageMs, error? }` und wirft
  ohne Cache-Eintrag. Scanner-/Executor-Pfad nutzt sie **nicht**.
- Mikro-Executor-Warmstart: Seed-Fehler werden gezählt (`status().seed`),
  geloggt (`micro_executor_seed_fetch_failed`) und geloggt — die Live-Kerzen
  wärmen die Serie weiter, aber der Fehler verschwindet nicht.

### Data-Quality- vs. Fachablehnung im Scanner

**Seit v1.25.2 (nachgearbeitet zu PR #35).** Fehlende Metriken sind
**behebbarer Datenmangel**, kein Markturteil. Der
Eignungsfilter markiert sie deshalb explizit (`FilterRejection.dataQuality`):

| Ablehnung | `ruleId` | `dataQuality` | Meldung | Behebung |
| --- | --- | :---: | --- | --- |
| Historie fehlt | `min-candles` | **true** | „min-candles: N/61 Kerzen. Benoetigt werden 61 Kerzen, weil der konfigurierte Faktorsatz … Datenverfuegbarkeits-, kein Marktqualitaetsproblem.“ (Schwelle abgeleitet aus dem Faktorsatz, §6) | `npm run market-sync` |
| Volumen unbekannt | `min-volume` | **true** | „24h-Volumen wurde nicht geladen …“ | `npm run market-sync` (tickers) |
| Spread unbekannt | `max-spread` | **true** | „Spread wurde nicht geladen (kein Orderbook-Snapshot) …“ | `npm run market-sync` (depth) |
| Kosten nicht bezifferbar | `max-execution-cost` | **true** | „Handelskosten nicht bezifferbar — Spread wurde nicht geladen“ | `npm run market-sync` (depth) |
| Volumen zu klein / Spread zu breit / Kosten zu hoch / Status / Markttyp / Drawdown / Regime | entsprechend | false | fachliche Begründung (bp-, %- bzw. Status-Wert) | — |

Der `liquidity`-Faktor besitzt einen Kerzen-Fallback
(`volume24h ?? letzte Kerze volume × close`), der `spread`-Faktor **nicht**.
Candle-Seeding allein reicht daher nicht: ohne `/depth`-Enrichment scheitern
auch kerzengesättigte Instrumente an `max-spread` (§3).

## 9. Rate limiting

Der Token-Bucket sitzt am `BitunixHttp`-Transport
(`src/brokers/bitunix/http.ts`) des Adapter-Public-Clients — die
`AdapterRegistry` erzeugt den Adapter ohne zusätzlichen Limiter (ein zweiter
auf Orchestrier-Ebene würde Tokens doppelt verrechnen). Alle produktiven
Bitunix-Calls laufen dadurch durch den Bucket:

- Dokumentiertes Limit: **10 req/s/IP**
- Code-Limit: **8 req/s** (`BITUNIX_PUBLIC_RATE_PER_SEC`) — konservativ, vor
  jedem Rollout gegen die Live-API zu verifizieren

Bündelung pro Lauf:

1. 1 × `trading_pairs`
2. 1 × `tickers` (Batch, falls der Adapter `getTickers` anbietet)
3. N × `depth`
4. N × 4 `kline` (Instrument × Timeframe)

Kein paralleles Fan-Out. Retry nur für 429/5xx (bestehender HTTP-Client).
Sync verwendet ausschließlich den **Public**-Client.

## 10. Venue capability matrix

| Venue | Adapter | Discovery | Tickers (Batch) | Orderbuch | Kerzen 5m/15m/30m/1h | Private/Keys im Sync |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| BITUNIX | `BitunixBrokerAdapter` (Modus `paper`, Public-Pfad) | ja (public REST) | ja | ja | ja | **nein** |
| BINANCE | — (Feed in `src/lib/marketdata/feeds`, kein Sync-Adapter) | geplant | — | — | — | nein |
| BITFINEX | — | geplant | — | — | — | nein |
| KRAKEN | — | geplant | — | — | — | nein |
| ALPACA / IBKR | — | geplant | — | — | — | nein |
| PAPER | Seed-Registry, kein REST | n/a | n/a | n/a | n/a | n/a |

**Bitunix-Status (verdrahtet seit v1.25.1):** Discovery: ✓ · MarketData: ✓ —
produktiv über `BitunixBrokerAdapter` + `AdapterRegistry` (der parallele
`BitunixMarketDataAdapter`-Wrapper ist entfernt) ·
Trading: über `BitunixPrivateClient` getrennt (niemals im Sync-Pfad).

Neue Venues: `MarketDataAdapter` implementieren und in
`src/marketdata/adapterRegistry.ts` unter dem Venue-Kürzel registrieren — die
**einzige** Stelle, die konkrete Adapter-Klassen instanziiert (nicht im Scanner,
nicht in `/api/markets`). Der Scanner ändert sich nicht.

## 11. Symbol-Normalisierung und Instrument-IDs (SYM-007, v1.28.0)

Symbolsemantik ist seit v1.28.0 **zentralisiert**: `src/symbols/`
(`normalizeVenueSymbol` / `tryNormalizeVenueSymbol`) ist die Single Source of
Truth und ersetzt die vier historisch auseinandergelaufenen Regex-Muster
(Universe / `marketData` / `ruleEngine` / Bitunix-Adapter). Verbindlich:

- **Kanonische ID** `${VENUE}:${canonical}` (`KRAKEN:BTC/USD`) — deterministisch
  aus jedem gespeicherten Symbol ableitbar, die ID für neue Konsumenten.
- **Speicherform** der Registry/bleibt die venue-native Schreibweise
  (`IBKR:EUR.USD`, `BINANCE:BTCUSDT`) — bestehende Bestände werden **nicht**
  umgeschrieben; `isValidInstrumentId` akzeptiert beide Formen.
- Der Legacy-Datenpfad (`src/lib/marketData.ts`) kanonisiert über das
  `PAPER`/Default-Profil und routet danach: Fiat/Fiat-Paar → Yahoo
  (`EURUSD=X`-Form), Krypto-Paar/-Basis → Binance (`BTCUSDT`-Konvention).
- Bestands-Normalisierung: `npm run symbols:normalize` (Dry-Run ist Default,
  `--apply` mit Backup) — repariert nur strukturelle Korruption, meldet
  Alt-Notationen als Hinweis, überspringt Unparsebares (§3.4).

Alle Regeln, die Venue-Profile, das Befund-Tableau der Alt-Regexe und die
sichtbaren Verhaltensänderungen: **[SYMBOLS.md](SYMBOLS.md)**.

---

## Sicherheit

- `AdapterRegistry` (`src/marketdata/adapterRegistry.ts`) ist die **einzige**
  Stelle, die konkrete Adapter-Klassen instanziiert. Sie erzeugt den
  `BitunixBrokerAdapter` **immer im Modus `"paper"` und ohne PrivateClient** —
  API-Keys/Secrets werden im Discovery/Enrichment-Pfad nicht referenziert.
- Kein `BitunixPrivateClient`, keine signierten Requests im Sync-Pfad
  (Integrationstest zählt `privateCalls === 0`).
- Public-Calls (`trading_pairs` / `tickers` / `depth` / `kline`) senden **keine
  Credential-Header**: Tests prüfen je Request, dass `sign`, `api-key`,
  `nonce`, `timestamp` und `authorization` abwesend sind — unnötige
  Credential-Exposition auf einem Public-Endpoint wird damit ausgeschlossen.
- Der Scanner (`src/scanner/`) importiert keinen konkreten Adapter — er kennt
  ausschließlich `InstrumentRegistry` und `HistoricalStore`.
- SSRF-Allowlist und TLS-Zwang des bestehenden HTTP-Clients gelten unverändert.
- `/api/markets` triggert keinen Sync (kein Schreibpfad über die Leseschnittstelle).
