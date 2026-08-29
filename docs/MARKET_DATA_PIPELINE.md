# Market-Data-Pipeline — Discovery, Enrichment, Backfill

> **Status-Header:** **Implementiert** · Dokumentationsstand **2026-08-29** ·
> Code-Version **1.24.0** · Modul `src/marketdata/` · CLI `npm run market-sync`

Die Pipeline füllt Instrument-Registry und Historical Store aus **öffentlichen**
Venue-Marktdaten, **bevor** der deterministische Scanner läuft. Der Scanner
(`scanUniverse()`) führt weiterhin **keinen** Netzwerk-Call aus.

```
Venue Adapters (Bitunix, Binance, Bitfinex, …)
         │
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

Nach Discovery reichert der Service jedes Instrument mit 24h-Volumen an:

- Bevorzugt **1 × tickers** (Batch), wenn `adapter.getTickers` existiert
  (Bitunix: `GET /api/v1/futures/market/tickers` ohne Symbolfilter).
- Sonst **N × getTicker(symbol)** — der Pfad, den Mock-Adapter in Unit-Tests
  nutzen.

`volume24h` wird aus `ticker.quoteVol` geschrieben. Fehlt der Ticker, bleibt
der Wert `null` (unbekannt, nicht 0). `lastSeen` wird auf den Sync-Zeitpunkt
gesetzt. Quelle des Upserts: `sync:<VENUE>`.

## 3. Orderbook enrichment

Pro Instrument **1 × depth** (`getOrderBook`). Der relative Spread

```
(ask − bid) / mid     mid = (ask + bid) / 2
```

kommt aus `calculateRelativeSpread(book.bids[0]?.price, book.asks[0]?.price)`.
Fehlt `bids[0]` oder `asks[0]`, ist der Spread `null` — kein Crash, kein
optimistisches 0.

## 4. Historical backfill

Pro Instrument und Timeframe **N × candle**:

| Timeframe | Limit |
| --- | ---: |
| `5m` | 150 |
| `15m` | 150 |
| `30m` | 150 |
| `1h` | 150 |

Kerzen landen append-only in `data/history/candles.ndjson` mit Provenienz
`{ venue, feed: "<VENUE>:rest" }` und Feld `timeframe`. Der Scanner liest
danach bevorzugt `1h` (sonst 30m → 15m → 5m → untagged Altbestand).

## 5. Persistence

| Senke | Datei | Mutation |
| --- | --- | --- |
| Instrument-Registry | `data/universe/instruments.ndjson` | `registry.upsert(..., "sync:<VENUE>")` |
| Historical Store | `data/history/candles.ndjson` | `history.append(..., timeframe, now)` |
| Universe-Audit | `data/universe/audit-log.ndjson` | ein Eintrag je mutierendem Upsert |

Keine PostgreSQL-Pflicht. Kein Private-Ledger. `/api/markets` bleibt **read-only**
und triggert `syncVenue()` nicht.

## 6. Readiness

Ein Universum gilt als scan-bereit, wenn:

1. `MarketDataSyncService.syncVenue(venue)` durchgelaufen ist (CLI oder
   `npm run scan -- --sync-first`).
2. Die Registry Instrumente mit frischem `lastSeen` und — soweit die Venue
   lieferte — `volume24h` / `spread` enthält.
3. Der Historical Store je aktivem Instrument ≥ `filters.minCandles` (Default 30)
   Kerzen des Scanner-Timeframes (`1h`) hat.

Ohne Warmup: 26 Seed-Instrumente × 0 Kerzen → alle `min-candles` → Eligible =
Interesting = Daily = Deep = 0. Das ist kein Scanner-Bug, sondern fehlende
Historie.

## 7. Scanner execution

```bash
npm run market-sync                 # Netzwerk, public REST, Token-Bucket
npm run scan                        # lokal, deterministisch, kein Netz
# oder
npm run scan -- --sync-first        # Warmup, danach derselbe lokale Scan
```

`scanUniverse()` importiert `src/marketdata/sync.ts` **nicht**. Der Service
`ScannerService` liest `HistoricalStore.query()` und `InstrumentRegistry.query()`.
Gleiche Eingabe → gleiches Artefakt.

## 8. Failure semantics

| Ereignis | Verhalten |
| --- | --- |
| Unbekannte Venue | `UnsupportedVenueError`, kein Partial-Write |
| Leere Discovery | `SyncResult` mit Zählern 0, Exit 0 |
| `getTicker` / `getOrderBook` / `getCandles` wirft | Fehler in `SyncResult.errors`, **Instrument isoliert**, Lauf geht weiter |
| Upsert per Policy abgelehnt | Registry-`rejected`; Sync bricht nicht ab |
| Discovery selbst wirft | Lauf bricht ab (ohne Instrumente gibt es nichts zu isolieren) |

CLI loggt nur aggregierte Zähler (`discovery`, `tickers enriched`,
`orderbooks enriched`, `5m candles: N/N`, `errors: K`). Keine Symbole, keine
URLs, keine Secrets.

## 9. Rate limiting

Alle produktiven Bitunix-Calls laufen durch den Token-Bucket in
`src/brokers/bitunix/http.ts`:

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
| BITUNIX | `BitunixMarketDataAdapter` | ja (public REST) | ja | ja | ja | **nein** |
| BINANCE | — (Feed in `src/lib/marketdata/feeds`, kein Sync-Adapter) | geplant | — | — | — | nein |
| BITFINEX | — | geplant | — | — | — | nein |
| KRAKEN | — | geplant | — | — | — | nein |
| ALPACA / IBKR | — | geplant | — | — | — | nein |
| PAPER | Seed-Registry, kein REST | n/a | n/a | n/a | n/a | n/a |

Neue Venues: `MarketDataAdapter` implementieren, in die `adapters`-Map unter
dem Venue-Kürzel einhängen. Der Scanner ändert sich nicht.

---

## Sicherheit

- Kein `BitunixPrivateClient`, keine API-Keys, keine signierten Requests im
  Sync-Pfad (Integrationstest zählt `privateCalls === 0`).
- SSRF-Allowlist und TLS-Zwang des bestehenden HTTP-Clients gelten unverändert.
- `/api/markets` triggert keinen Sync (kein Schreibpfad über die Leseschnittstelle).
