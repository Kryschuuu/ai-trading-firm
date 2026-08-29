# Market-Data-Pipeline — Discovery, Enrichment, Backfill

> **Status-Header:** **Implementiert** · Dokumentationsstand **2026-08-29** ·
> Code-Version **1.25.2** · Modul `src/marketdata/` · CLI `npm run market-sync`

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
| Ticker-Symbol ≠ Instrument | `volume24h` bleibt `null`, Eintrag in `errors` (`stage: "ticker"`) |
| Discovery selbst wirft | Lauf bricht ab (ohne Instrumente gibt es nichts zu isolieren) |

CLI loggt nur aggregierte Zähler (`discovery`, `tickers enriched`,
`orderbooks enriched`, `5m candles: N/N`, `errors: K`). Keine Symbole, keine
URLs, keine Secrets.

### Data-Quality- vs. Fachablehnung im Scanner

**Seit v1.25.2 (nachgearbeitet zu PR #35).** Fehlende Metriken sind
**behebbarer Datenmangel**, kein Markturteil. Der
Eignungsfilter markiert sie deshalb explizit (`FilterRejection.dataQuality`):

| Ablehnung | `ruleId` | `dataQuality` | Meldung | Behebung |
| --- | --- | :---: | --- | --- |
| Historie fehlt | `min-candles` | **true** | „Historie nicht geladen (N < 30 Kerzen) …“ | `npm run market-sync` |
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
