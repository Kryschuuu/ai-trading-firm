# Bitunix-Adapter (Task 07) — 7. Venue, USDT-M-Perpetuals

**Stand:** v1.36.12 · **Modul:** `src/brokers/bitunix/` · **Contract:** `BrokerAdapter` (+ Public-Market-Data über den Wrapper `src/marketdata/adapters/bitunix.ts`)
**Status:** Public REST/WS und Paper (Modus B) ausführbar. Live-Ausführung über den
zentralen Live-Gate-Enforcer (Task 11) und eine **getrennte Broker-Ausführungs-Engine**
(s. §5) — ohne bestandene Gate-Prüfung weiterhin `LiveTradingGateError`.
Kein dokumentiertes Futures-Testnet. Seit v1.32.0 (P0-Verdrahtung) läuft die
**Public-Market-Data über den dünnen Marketdata-Wrapper**
`src/marketdata/adapters/bitunix.ts` (Broker-PublicClient → `MarketDataAdapter`) und
ist damit sauber von der Broker-Domäne entkoppelt (§1.1) — die Registry füllt sich
seit MDSYNC-001 über `npm run market:sync` / `run-scan.ts --sync` statt über die
statischen Seed-Instrumente.

Dieses Dokument ist die verbindliche Spezifikation des Bitunix-Adapters. Der Kern
(engine, risk, agents, API) kennt weiterhin **nur** `BrokerAdapter` — Venue-Details
bleiben in diesem Ordner.

---

## 0. Code-Map (Anforderung → realer Pfad)

Verifikationsschritt der P0-Verdrahtung — wo die beteiligten Bausteine wirklich
leben (Stand v1.32.0):

| Baustein | Realer Pfad | Anmerkung |
| --- | --- | --- |
| `BitunixBrokerAdapter` | `src/brokers/bitunix/adapter.ts` | implementiert nur `BrokerAdapter`; Public-Methoden (`discoverInstruments`, `getTicker(s)`, `getOrderBook`, `getCandles`) bleiben für Paper/Health/API erhalten |
| `PublicClient` | `src/brokers/bitunix/publicClient.ts` (`BitunixPublicClient`) | credential-frei; `fetchTradingPairsRaw`, `fetchTickers` (Bulk, `string[] \| string`), `fetchTicker`, `fetchDepth` (RAW-DTO, Default `limit=5`), `fetchKlines` |
| `PrivateClient` | `src/brokers/bitunix/privateClient.ts` (`BitunixPrivateClient`) | signierte Requests — **niemals** im Market-Data-Pfad instanziiert |
| Broker-Factory `createAdapter()` | `src/brokers/factory.ts` | `createAdapter("BITUNIX", mode)` → `BitunixBrokerAdapter`; Live über zentralen Live-Gate-Enforcer |
| Capability-SSoT | `src/brokers/capabilities.ts` (`VENUE_CAPABILITIES.BITUNIX`) | `discovery/marketData/trading/paper/live: true`, `testnet: false`, `stopAtVenue: true` |
| Market-Data-Adapter-Wrapper | `src/marketdata/adapters/bitunix.ts` (`createBitunixMarketDataAdapter`) | `BitunixPublicClient` → `MarketDataAdapter`; Timeframe-Map, DTO-Mapping, Symbol-SSoT |
| Adapter-Registrierung | `src/marketdata/registerAdapters.ts` (`registerAdapters`, `registerMarketDataAdapters(env)`) | einzige Instanzierungsstelle; Capability- + Env-Gate; ein geteilter Token-Bucket pro Lauf |
| `MarketDataSyncService` (MDSYNC-001) | `src/marketdata/sync.ts` | Discovery → Ticker/Depth-Enrichment → Candle-Backfill → Registry/HistoricalStore |
| Sync-CLI | `scripts/market-sync.ts` + `scripts/lib/market-sync.ts` | `npm run market:sync -- --venue=BITUNIX` |
| `run-scan.ts` | `scripts/run-scan.ts` | `--sync` (Default aus) = optionaler Warmstart VOR dem deterministischen Scan |
| Env-Handling `BITUNIX_ENABLED` | `src/brokers/bitunix/config.ts` (`bitunixEnabled`, nur exakt `"true"`) | geteilt zwischen Trading-Adapter und Market-Data-Sync; `.env.example` § Bitunix/Market-Data-Sync |
| Symbol-SSoT (SYM-007) | `src/symbols/normalize.ts` (`normalizeVenueSymbol`) | Instrument-ID in **venue-nativer Speicherform** `BITUNIX:BTCUSDT` (docs/SYMBOLS.md §4) |
| Fixtures (echte API-Responses) | `test/fixtures/bitunix/*.json` | Snapshot 2026-08-31; Provenanz siehe `test/fixtures/bitunix/README.md` |

---

## 1. Rolle in der Plattform

Bitunix ist das siebte Adapter-Venue (`BrokerVenueId = "BITUNIX"`). Es handelt
ausschließlich **USDT-margined Perpetual Futures** (`marketType = perpetual`).

| Capability | Wert | Bedeutung |
| --- | --- | --- |
| `discovery` | true | `GET /trading_pairs` → `MarketInstrument[]`, Registry-Upsert `source=discovery:bitunix` |
| `marketData` | true | Ticker, Klines, Depth (REST) + Public-WS Ticker/Kline |
| `trading` | true | Paper-Ledger; Live-Serialisierung vorbereitet, Versand gesperrt |
| `paper` | true | Modus B: echte Public-Kurse, simulierte Fills, **0 Private-Calls** |
| `testnet` | **false** | Offizielle Futures-Doku weist kein Testnet aus |
| `live` | **true** | Technische Fähigkeit (Signing, Place-Order-Body) — **keine Freigabe** |
| `stopAtVenue` | **true** | SL/TP gehen als `slPrice`/`tpPrice` in denselben Place-Order-Aufruf |
| `instrumentTypes.perpetual` | true | Spot/Future/Option = false |

Factory: `getBroker("BITUNIX", "paper"|"backtest")` liefert `BitunixBrokerAdapter`.
`testnet` → `NotSupportedCapabilityError`. `live` → **immer** `LiveTradingGateError`,
solange die Live-Gate-State-Machine nicht `LIVE_ENABLED` erreicht hat.

### 1.1 Public Market Data in der Scanner-Pipeline (seit v1.32.0 über den Wrapper)

Die Verdrahtung läuft über **drei Schichten** (Domänentrennung, keine
Rückwärts-Abhängigkeit `src/brokers` → `src/marketdata`):

```
registerAdapters()/registerMarketDataAdapters(env)   (src/marketdata/registerAdapters.ts)
   Gate: capabilities.BITUNIX.marketData === true  ∧  BITUNIX_ENABLED === "true"
   (∧ MARKET_SYNC_ENABLED ≠ "false" ∧ MARKET_SYNC_VENUES erlaubt BITUNIX)
        │  instanziiert NUR BitunixPublicClient (+ je Lauf EINEN Token-Bucket, 8 req/s)
        ▼
createBitunixMarketDataAdapter({ publicClient, symbolNormalizer })   (Wrapper)
   DTO→Domain-Mapping · Instrument-ID über normalizeVenueSymbol (venue-native Form)
   Timeframe-Map SupportedTimeframe → Bitunix-Interval (3m/5d = dokumentierte Lücke)
        ▼
MarketDataSyncService (src/marketdata/sync.ts)
   Discovery → Ticker-Enrichment (1 × tickers bulk) → Depth-Enrichment (N × depth)
   → Candle-Backfill (N × M × kline) → InstrumentRegistry + HistoricalStore
        ▼
npm run market:sync -- --venue=BITUNIX   bzw.   npm run scan -- --sync
```

Fehlt das Flag (`BITUNIX_ENABLED != "true"`) oder meldet die Capability-Matrix
`marketData=false`, wird **kein** Adapter registriert und
`syncVenue("BITUNIX")` wirft `UnsupportedVenueError` mit Behebungshinweis:

> `Venue "BITUNIX" ist nicht als Market-Data-Adapter registriert. Ursache: entweder
> capabilities.BITUNIX.marketData=false oder BITUNIX_ENABLED != "true". Public Market
> Data benoetigt KEINE API-Credentials; setze BITUNIX_ENABLED=true, um Discovery und
> Candle-Backfill zu aktivieren. Live-Trading bleibt davon unberuehrt und weiterhin
> durch das Live-Gate gesperrt.`

**Historie:** v1.25.1 hatte den (damals parallelen) Wrapper entfernt und den
`BitunixBrokerAdapter` selbst registrieren lassen — das koppelte die Broker-Domäne
an `src/marketdata/sync.ts` zurück. v1.32.0 stellt den Wrapper als einzigen
Kopplungspunkt wieder her: der Broker-Adapter implementiert das Interface nicht
mehr selbst (bleibt aber strukturell kompatibel), die Registrierung instanziiert
ausschließlich den credential-freien PublicClient.

**Klare Trennung der vier Ebenen** (Auth-Anforderung · Rate-Limit · Aktivierung):

| Ebene | Pfade | Auth-Anforderung | Rate-Limit | Aktivierungs-Flag |
| --- | --- | --- | --- | --- |
| **Public market data** | `trading_pairs`, `tickers`, `depth`, `kline` (+ Public-WS) | **keine** — credential-freier PublicClient, keine Signatur, kein Nonce | Token-Bucket **8 req/s/IP** (Doku: 10); ein **geteilter** Bucket je Sync-Lauf, Parallelität ≤ 8 | `BITUNIX_ENABLED=true` + `capabilities.BITUNIX.marketData` + `MARKET_SYNC_ENABLED`/`MARKET_SYNC_VENUES` (Sync) |
| **Private trading API** | `account`, `position/get_pending_positions`, `trade/place_order`, `trade/get_order_detail`, `trade/get_history_trades` (H3-Reconciliation) | `BITUNIX_API_KEY` + `BITUNIX_API_SECRET`, signiert (SHA-256-Doppelhash, `nonce`/`timestamp`) | 8 req/s/uid (Doku: 10) | nie im Sync-Pfad; nur Ausführung nach Gate |
| **Paper execution** | `PaperExecutionEngine` (lokales Ledger gegen echte Public-Kurse) | keine signierten Requests (liest nur Public-Ticker) | über Public-Bucket | `getBroker("BITUNIX", "paper")`, `BITUNIX_ENABLED=true` |
| **Live execution** | `BrokerExecutionEngine` → `BitunixPrivateClient.placeSerializedOrder` | signiert (Private API) + komplette Live-Gate-State-Machine | Private-Bucket | `BITUNIX_LIVE_ENABLED` + `LIVE_TRADING_ENABLED` + `REQUIRE_HUMAN_APPROVAL=false` + Live-Gate `LIVE_ENABLED` (Default: `LiveTradingGateError`) |

### 1.2 Spread kommt aus dem Orderbuch, nicht aus dem Ticker (P1 — seit v1.25.2, P1-Enrichment v1.32.0)

**Spread wird NICHT direkt von der Ticker-API geliefert, sondern aus dem
Orderbook (bestBid/bestAsk) berechnet. Dies erfordert einen zusätzlichen
`/depth`-Call pro Instrument.**

| Metrik | Endpunkt | Feld | Bemerkung |
| --- | --- | --- | --- |
| 24h-Volumen | `GET /tickers` | `quoteVol` → `volume24h` | 1× Batch-Call für alle Symbole möglich (Stage `enrichWithTickers`) |
| Spread | `GET /depth` | `bids[0].price` / `asks[0].price` → `spread` | **1 Call je Instrument**, kein Batch-Äquivalent (Stage `enrichWithOrderBooks`, limit=5) |

Berechnung (`src/marketdata/spread.ts` → `calculateRelativeSpread`):

```
spread = (ask − bid) / mid        mid = (ask + bid) / 2
```

`0.0004` entspricht 4 bp. Ungültige/fehlende Book-Daten (leere Seite, `≤ 0`,
invertiertes Buch `bid > ask`, `NaN`, `Infinity`, Spread >50 %) liefern **`null`**
— niemals `0`, niemals `NaN`, niemals eine Exception. `null` heißt „nicht geladen“
und ist bewusst von einem (fachlich verdächtigen) Spread von 0 unterscheidbar.

**P1-Enrichment-Stages (src/marketdata/enrichment.ts):**

```ts
export interface EnrichmentReport {
  attempted: number;
  succeeded: number;
  missing: string[];
  failures: Array<{ symbol: string; reason: string }>;
}

export async function enrichWithTickers(
  instruments: MarketInstrument[],
  adapter: MarketDataAdapter,
): Promise<{ volumeBySymbol: Map<string, number | null>; report: EnrichmentReport }>;

export async function enrichWithOrderBooks(
  instruments: MarketInstrument[],
  adapter: MarketDataAdapter,
  opts: { depthLimit: number; concurrency: number },
): Promise<{ spreadBySymbol: Map<string, number | null>; report: EnrichmentReport }>;
```

- `enrichWithTickers()`: **ein** Bulk-Call, fehlendes Symbol → `null` + `missing` (kein Throw).
  `volume24h` ist explizit **Quote-Volumen** (`ticker.quoteVol`) — Verwechslung mit Base-Volumen
  verfälscht jeden `min-volume`-Filter um Größenordnungen.
- `enrichWithOrderBooks()`: `depthLimit=5`, pro Symbol Timeout 5 s, max. 1 Retry,
  Fehler → `null` + `failures`, Sync läuft weiter. Plausibilität: `spread > 0.5` → `null` + Warnung.
- Unbekannte Werte bleiben `null` (Data-Quality), nicht fachliche Ablehnung.
- Rate-Limit-schonend: 1× Bulk-Tickers, N× Depth mit `limit=5`, Concurrency ≤8,
  `maxInstruments` ≤1000 (Schutz gegen self-DoS/IP-Ban).

**Registry-Upsert (P1):**

```ts
registry.upsert({
  ...instrument,
  volume24h: volumeBySymbol.get(instrument.symbol) ?? null, // Quote-Volumen!
  spread:    spreadBySymbol.get(instrument.symbol) ?? null, // relativer Spread aus Depth
  lastSeen:  now.toISOString(),
}, `sync:${venue}`);
```

Folgen für den Sync- und Scanner-Pfad:

* Kosten: N Instrumente ⇒ N zusätzliche `/depth`-Requests (z. B. 180
  Instrumente ⇒ 180 Calls). Sie laufen durch den Token-Bucket (8 req/s, §2)
  mit Concurrency-Begrenzung — kein Sekunden-Burst, kein unbegrenztes Fan-out.
* Der `spread`-Faktor des Scanners hat (anders als `liquidity`, das auf
  `Kerze.volume × close` zurückfällt) **keinen** Fallback. Ohne
  Orderbook-Enrichment scheitert deshalb jedes Instrument an der
  `max-spread`-Regel — als **Data-Quality-Rejection**
  (`dataQuality: true`, Meldung „Spread wurde nicht geladen“), nicht als
  fachliche Marktablehnung.
* Coverage-Diagnose: Rejection trägt jetzt `candles/volume24h/spread` als Kontext
  (`eligibilityDiagnostics`), damit Ops sofort sieht: nicht „BTC ungeeignet“,
  sondern „Spread wurde nicht geladen“.
* Details zum Gesamtfluss: [MARKET_DATA_PIPELINE.md](MARKET_DATA_PIPELINE.md)
  §2–§3 und §8.

**JSDoc `enrichWithOrderBooks`:** „Die Bitunix-Ticker-API liefert kein Bid/Ask. Der
relative Spread wird deshalb aus dem Orderbook-Top-Level (`/market/depth`, limit=5)
berechnet. Das kostet N zusätzliche Requests und ist der teuerste Teil des Syncs —
daher Concurrency-Begrenzung und Token-Bucket.“

**Registry-Feld-Tooltips:**

- `volume24h`: „24-Stunden-Handelsvolumen in Quote-Währung, geliefert vom
  Ticker-Endpoint. `null` = nicht geladen. Der Liquiditätsfaktor nutzt dann den
  Fallback aus der letzten Kerze (volume × close).“
- `spread`: „Relativer Bid/Ask-Spread aus dem Orderbook-Top-Level.
  `null` = nicht geladen. Es existiert **kein** Kerzen-Fallback; der Scanner lehnt
  das Instrument mit `max-spread` als Datenqualitätsproblem ab.“

**Log-Warnung (P1):**

```
[market-sync] spread unavailable for 12/180 symbols — diese Instrumente
werden mit rule="max-spread" (data quality) abgelehnt, nicht wegen zu hoher Kosten.
```

Garantien des Sync-Kontexts (durch Tests abgesichert):

- `registerAdapters()` / `registerMarketDataAdapters(env)` erzeugen **nur den
  `BitunixPublicClient`** (adaptiert über den Wrapper) — kein
  `BitunixBrokerAdapter`, kein Paper-Ledger, kein Secret-Store, kein
  PrivateClient. `BITUNIX_API_KEY`/`_SECRET` werden im Sync-Pfad nicht gelesen
  (Env-Proxy-Test), API-Key/Secret im Env ändern nichts am Sync-Verhalten
  (Laufzeit-Test mit Credentials im Env: 0 Credential-Header).
- Der Scanner (`src/scanner/`) importiert **keinen** konkreten Adapter — er
  kennt ausschließlich `InstrumentRegistry` und `HistoricalStore`; ohne `--sync`
  macht `run-scan.ts` **null** Netzwerk-Requests (Guard-Server-Test).
- Order-Ausführung bleibt vollständig über `getBroker()` (Factory) und den
  Private-Client getrennt (§5).
- Security Audit (P1): Depth-Response-Validierung (Arrays gekappt, `Number.isFinite()`,
  `NaN`/`Infinity` → null), kein unbegrenztes Fan-out (`maxInstruments`/`concurrency`
  hart gekappt), Timeouts auf jedem HTTP-Call, keine Symbol-Werte ungeprüft in URLs.

---

## 2. Öffentliche Endpunkte

Basis: `https://fapi.bitunix.com` (Allowlist-Host). Schema `https` erzwungen;
`http` nur Loopback + `BITUNIX_ALLOW_INSECURE_HTTP=true` (lokale Tests).

| Zweck | Methode / Pfad |
| --- | --- |
| Discovery | `GET /api/v1/futures/market/trading_pairs` |
| Ticker | `GET /api/v1/futures/market/tickers` |
| Klines | `GET /api/v1/futures/market/kline` |
| Orderbuch | `GET /api/v1/futures/market/depth` |
| Account (privat) | `GET /api/v1/futures/account` |
| Positionen (privat) | `GET /api/v1/futures/position/get_pending_positions` (`side` **validiert**: nur `LONG`/`SHORT`, sonst Verwurf + Zähler — §5.3) |
| Place-Order (privat) | `POST /api/v1/futures/trade/place_order` |
| Order-Detail (privat, H3) | `GET /api/v1/futures/trade/get_order_detail` (per `orderId` **oder** `clientId` — H4-Idempotenz-Query) |
| Ausführungen/Trades (privat, H3) | `GET /api/v1/futures/trade/get_history_trades` |
| Public WS | `wss://fapi.bitunix.com/public/` |

**H3 — Order-Status & Fill-Reconciliation (seit v1.36.4):** `place_order` liefert
nur die AKZEPTANZ der Order (`BrokerOrderResult.status = "NEW"`, `fillPrice = 0`)
— eine Annahme ist kein Fill. Der echte Fill wird asynchron abgeglichen:
`get_order_detail` (Venue-Status `NEW`/`PART_FILLED`/`FILLED`/`CANCELED` +
`tradeQty`) und `get_history_trades` (echte Trades) werden über
`BrokerExecutionEngine.reconcile(orderId)` (bzw. `Adapter.reconcileOrder`) zum
echten Ergebnis zusammengesetzt — der avgPrice ist der mengen-gewichtete
Mittelwert der Trades. Status-Mapping: `NEW/INIT` → NEW, `PART_FILLED` →
PARTIALLY_FILLED, `FILLED` → FILLED, `CANCELED/EXPIRED/PART_FILLED_CANCELED` →
CANCELED, Unbekanntes/fehlende Order/nicht belegbarer Preis → UNKNOWN
(fail-safe — eine Position wird NIE mit Entry-Preis 0 eingebucht).

Envelope: `{ code: 0, data, msg }`. `code ≠ 0` wird taxonomisch klassifiziert
(auth / permission / rate-limit / maintenance / unknown).

**H4 — Order-Idempotenz (seit v1.36.5):** Jede Live-Order trägt einen stabilen
`clientOrderId` (Wire-Feld `clientId`, Format `ATF-<sha256>`). Der HTTP-Transport
wiederholt einen nicht-idempotenten place_order-POST bei 429/Timeout/Netz/5xx
**nie automatisch**, sondern reicht einen `BitunixAmbiguousError` nach oben.
`placeSerializedOrder` fragt dann VOR jedem erneuten Senden per
`getOrderByClientId(clientOrderId)` (`GET get_order_detail?clientId=…`) den
echten Status ab: Order gefunden → bestehende Order (kein Duplikat); nicht
gefunden → genau **ein** kontrollierter Retry mit demselben `clientOrderId`
(derselbe Body). Damit wird nachweislich kein Doppel-Order erzeugt.

**Fees:** `trading_pairs` liefert keine maker/taker-Felder. `MarketInstrument`
erlaubt kein `null` für Fees — der Adapter setzt die dokumentierten VIP0-Defaults
**0,02 % maker / 0,06 % taker** (`0.0002` / `0.0006`). Abweichung zur Formulierung
„sonst null“ ist bewusst.

**Status-Mapping (Venue-Doku: „OPEN: trade normal · CANCEL_ONLY: cancel only ·
STOP: can't open/close position“; `isApiSupported`: true/false — API Trading
Enabled/Disabled):** `OPEN` → `active`; `CANCEL_ONLY`/`STOP` → `halted`;
`OPEN` + `isApiSupported=false` → `halted` (Instrument existiert, API-Handel
aus — wird übernommen, **nicht verworfen**); `DELISTED`/`DEL` → `delisted`
(defensiv, von der Venue heute nicht dokumentiert); unbekannt/fehlend →
`preview` (konservativ). Gilt identisch für Broker-Mapping
(`src/brokers/bitunix/mapping.ts`) und Wrapper (`src/marketdata/adapters/bitunix.ts`,
dort zusätzlich `isApiSupported`-Behandlung). Unbekannte Felder werden ignoriert;
kaputte Zeilen übersprungen.

**Kline-Intervalle (Timeframe-Map `BITUNIX_TIMEFRAME_MAP`):** Bitunix bedient
`1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M`. Die Store-Allowlist
(`SUPPORTED_TIMEFRAMES`) ist ein Superset — `3m` und `5d` sind bei Bitunix
**nicht verfügbar** und in der Map explizit `null` eingetragen; der Wrapper wirft
dafür (wie für Werte außerhalb der Allowlist) `UnsupportedTimeframeError`, statt
still einen Nachbar-Timeframe zu liefern (Reihen verschiedener Periodizität
dürfen nie gemischt werden). `kline` liefert max. **200 Bars je Call**; ein
höheres `candleLimit` erforderte Paging (out of scope, Sync-Default 150/100 ≤ 200).

---

## 3. WebSocket (Public)

Subscribe: `{ op: "subscribe", args: [{ symbol, ch }] }`.

| Channel | Semantik |
| --- | --- |
| `ticker` | Full-Replace je Symbol (`la`/`lastPrice`, optional mark/vol/high/low) |
| `market_kline_{1min\|5min\|…}` | Delta: gleiche `time` → Replace, sonst neue Kerze |

Reconnect: exponentielles Backoff 250 ms … 8 s, danach Resubscribe aller Channels.
Backoff ist in Tests injizierbar (`backoff?: (attempt) => ms`).

---

## 4. Signatur (REST)

Offizielle Formel
([Sign](https://www.bitunix.com/api-docs/futures/common/sign.html)):

```
queryParams = sortierte Keys, Konkatenation key+value ohne Trenner  (id1uid200)
body        = kompaktes JSON, byte-identisch zum Request
digest      = SHA256_hex(nonce + timestamp + api-key + queryParams + body)
sign        = SHA256_hex(digest + secretKey)
```

UTF-8, Hex lower-case, `node:crypto.createHash("sha256")`. Header: `api-key`,
`nonce`, `timestamp`, `sign`.

**Abweichungen zur Doku (bewusst):**

- Demo-timestamp `"20241120123045"` (YmdHis) vs. Spezifikation „milliseconds“ —
  Produktion nutzt **monotonische Millisekunden**.
- Nonce „32bits“ vs. Login-Beispiel 32 Zeichen — **32 Hex-Zeichen**, Eindeutigkeit
  über ein In-Memory-Fenster.
- WS-Login-Signatur (ohne query/body) ist **nicht** implementiert (kein Private-WS).

Goldens in `tests/bitunix.unit.test.ts` (u. a. das offizielle Doku-Beispiel).
Das in älteren Mirrors gespeicherte Hash-Paar `75099831…` ist **nicht**
reproduzierbar und wird nicht als Golden verwendet.

---

## 5. Ausführung (ExecutionPort) & Live-Gate

**Ausführungs-Architektur (v1.20.0, Peer-Review):** Der Adapter bedient jede
Execution über einen `ExecutionPort` (`src/brokers/bitunix/execution.ts`) mit
**zwei getrennten Implementierungen** — Paper-Ledger und echter Broker-Executor
sind nie vermischt:

```
ExecutionMode
 ├── paper / backtest ─► PaperExecutionEngine   (lokales Ledger, 0 Private-Calls)
 └── live              ─► BrokerExecutionEngine (echte Venue-API, signiert)
                            └── LiveGate (Task 11) → BitunixPrivateClient
```

- `placeOrder` im **Live**-Modus: Live-Gate-Enforcer (Task 11) prüft zuerst; bei
  bestandener Prüfung durchläuft die `BrokerExecutionEngine` **unmittelbar vor
  dem Senden** dieselbe Schutzkette wie das Paper-Ledger — prozessweiter
  Kill-Switch (`riskGuard.killSwitch`, `/api/firm/kill`) und Code-Guardrails
  (`validateOrder`) gegen die **echte** Konto-Equity und die echten offenen
  Positionen (fail-closed: scheitert der Abruf, wird nicht gesendet). Erst dann
  geht die Order über `BitunixPrivateClient.placeSerializedOrder` (SL/TP als
  `slPrice`/`tpPrice` im selben Body, `stopAtVenue`; **H4-Idempotenz**: stabiler
  `clientOrderId` (`ATF-…`) wird gesetzt und bei einem kontrollierten Retry
  wiederverwendet; ein nicht-idempotenter place_order-POST wird bei
  Timeout/Netz/5xx/429 nie blind wiederholt, sondern erst per `clientOrderId`
  abgefragt — siehe §7). **Niemals** über das Paper-Ledger.
- `getAccount`/`getPositions` im **Live**-Modus liefern **echte Venue-Daten**
  (signierte Private-API), nie Paper-Daten.
- `paper`/`backtest` → `PaperExecutionEngine` gegen das lokale Ledger
  (Modus B). Das Ledger nutzt seit v1.21.0 den **zentralen** `FillSimulator`
  (siehe §6), nicht mehr eine eigene, vereinfachte Simulationslogik.

Eine Live-Order ist **nur** möglich, wenn **alle** gelten (zentraler Enforcer):

1. `BITUNIX_ENABLED=true`
2. `BITUNIX_LIVE_ENABLED=true`
3. `LIVE_TRADING_ENABLED=true`
4. `REQUIRE_HUMAN_APPROVAL=false` (nur exakt dieser String hebt die Teilbedingung)
5. Live-Gate-State-Machine = `LIVE_ENABLED` (persistiert, inkl. Human-Gate + Suite + Control-Plane)

Ohne bestandene Gesamtprüfung wirft der Live-Pfad `LiveTradingGateError` — es gibt
keinen stillen Fallback auf Paper. `testnet` → `NotSupportedCapabilityError`
(kein Bitunix-Testnet dokumentiert).

Private Calls (nur im Live-Pfad nach Gate-Freigabe bzw. in Tests) landen als Event
`BITUNIX_PRIVATE_CALL` (Methode, Pfad, Outcome, errorCode — **kein** Body, keine
Query, kein Key, keine Signatur). Verworfene Positionszeilen zusätzlich im
In-Memory-Ring `readBitunixPositionAnomalies()` plus Zähler (B2, §5.3).

### 5.1 Konto-Mapping `getAccount` (H8, seit v1.36.10)

`GET /api/v1/futures/account?marginCoin=USDT` liefert pro Margin-Coin eine Zeile.
`BitunixPrivateClient.getAccount()` bildet sie auf die **kanonische
`BrokerAccount`-Zerlegung** ab (`src/contracts/broker.ts`); der Risk-Guard
(`validateOrder` in `BrokerExecutionEngine.submit`) nutzt `equity` als
Denominator, der Cash-Guard prüft `cash` (= freie Margin):

| Venue-Feld (Zeile) | Bedeutung | Kanonisches Feld |
| --- | --- | --- |
| `walletBalance` | Kontostand ohne offene Positionen (falls geliefert) | `walletBalance` |
| `available` | freie Margin (freies Cash) — **nicht** Equity | `cash` = `availableCash` |
| `margin` (ggf. `usedMargin`) | durch Positionen gebundene Initial-Margin | `usedMargin` |
| `frozen` | durch offene Orders gebundene Margin | (in `walletBalance`-Fallback) |
| `crossUnrealizedPNL` | uPnL der Cross-Positionen | Teil von `unrealizedPnl` |
| `isolationUnrealizedPNL` | uPnL der Isolated-Positionen | Teil von `unrealizedPnl` |
| `maintenanceMargin` | Wartungsmargin (falls geliefert, sonst 0) | `maintenanceMargin` |
| `realizedPnl` | realisiertes PnL (falls separat geliefert, sonst 0) | fließt in `equity` ein |

Mapping-Regeln (H8):

```text
equity        = walletBalance + realizedPnl + unrealizedPnl
unrealizedPnl = crossUnrealizedPNL + isolationUnrealizedPNL
cash          = availableCash = available
usedMargin    = usedMargin ?? row.margin ?? 0
```

- **`walletBalance`:** Wird direkt übernommen, wenn die Antwort das Feld führt.
  Fehlt es **genuin** (undefined/null/leer — die dokumentierte Antwortversion
  führt es nicht), wird es aus den venue-eigenen Komponenten zerlegt:
  `available + frozen + margin` (freie Margin + Order-Margin + Positions-Margin).
- **Niemals** wird `equity` aus `available` allein synthetisiert — die alte Formel
  `equity = available + uPnL` ließ die gebundene Margin außen vor und war bei
  offenen Positionen (`usedMargin > 0`) zu klein; es gilt dann `equity != available`.
- Realisiertes PnL settled Bitunix laufend ins Wallet; die Account-Antwort führt
  es regulär nicht — `realizedPnl` wird nur addiert, wenn die API es liefert.
- Fehlen alle Felder (leere Antwort), ergibt die Abbildung fail-closed 0 —
  `validateOrder` (H9) blockiert Orders dann hart.

Alle übrigen Erzeuger (Paper-Ledger Alpaca/Bitunix, PAPER-Venue-Wrapper,
Alpaca-Live-Mapping) liefern dieselbe kanonische Zerlegung; Paper/Cash-Konten
sind voll besichert (`usedMargin = 0`, `availableCash = cash`,
`walletBalance = equity − unrealizedPnl`). Tests:
`tests/bitunix.accountEquity.test.ts`.

### 5.2 SL/TP-Geometrie (B1 — seit v1.36.11)

`serializePlaceOrder` (`src/brokers/bitunix/orders.ts`) prüft **vor** dem Aufbau des
Wire-Bodys, ob SL/TP auf der richtigen Seite des Entry liegen. Ohne diese Prüfung
könnte eine formal positive, aber semantisch falsche Staffelung (z. B. ein
LONG-Stop oberhalb des Einstiegspreises) zur Venue gehen — der Adapter vertraut
**nicht** darauf, dass Caller korrekte Werte liefern.

**Entry-Bezugspunkt** (`entry`):

| Order-Typ | Entry | Geometrie-Prüfung |
| --- | --- | --- |
| `LIMIT` | `req.limitPrice` (fester Preis) | immer aktiv |
| `MARKET` mit `req.markPriceHint` | `req.markPriceHint` (Mark-/Quote-Preis) | aktiv |
| `MARKET` ohne Entry-Hinweis | — | **übersprungen** (kein falscher Deny) |

`markPriceHint` ist ein reiner Validierungs-Bezugspunkt: Er geht **nie** in den
Wire-Body und **nicht** in die Order-Idempotenz (`clientOrderId`) ein.

**Regeln (Fehler = `OrderSerializationError`):**

| Side | Bedingung | Meldung |
| --- | --- | --- |
| `LONG` | `stopLoss >= entry` | `LONG stopLoss muss unter dem Entry liegen` |
| `LONG` | `takeProfit <= entry` | `LONG takeProfit muss über dem Entry liegen` |
| `SHORT` | `stopLoss <= entry` | `SHORT stopLoss muss über dem Entry liegen` |
| `SHORT` | `takeProfit >= entry` | `SHORT takeProfit muss unter dem Entry liegen` |

Die Grenzfälle `SL == entry` bzw. `TP == entry` werden ebenfalls abgelehnt
(streng kleiner/größer). Tests: `tests/bitunix.unit.test.ts`
(`Orders (B1): SL/TP-Geometrie …`).

### 5.3 Positionsseite: validieren statt raten (B2 — seit v1.36.12)

`getPositions()` (`src/brokers/bitunix/privateClient.ts`) übernahm früher jede
Zeile, deren `side` nicht exakt `"SHORT"` war, als **LONG** — auch `""`, `null`
und offensichtlichen Müll. Eine korrumpierte Antwort war damit unsichtbar, und
eine Short-Position wäre im lokalen View als Long erschienen (falsches
uPnL-Vorzeichen, falsche SL/TP-Geometrie, falsche Seitenlogik im Risk-Pfad).

Heute gilt eine **Zwei-Gate-Filterung in fester Reihenfolge**:

| # | Prüfung | Outcome bei Fehlschlag |
| --- | --- | --- |
| 1 | `qty` endlich und `> 0` | Zeile verworfen (geschlossene/Null-Mengen-Zeile) — **keine** Anomalie |
| 2 | `side` ∈ {`LONG`, `SHORT`} (getrimmt, case-insensitiv) | Zeile verworfen + als Anomalie gezählt |

Reihenfolge ist Absicht: Das Venue liefert für bereits geschlossene Zeilen
regulär keine `side`. Sie scheiden über die `qty`-Prüfung aus, bevor die Seite
überhaupt betrachtet wird — die Seitenprüfung bleibt damit den **echten offenen
Positionen** vorbehalten, wo Raten gefährlich ist.

`parseBitunixPositionSide(raw)` ist der exportierte, pure Kern der Prüfung:
akzeptiert nur `LONG`/`SHORT`, alles andere (inkl. `BUY`/`SELL`, die als
*Order*-Seite nicht in eine Positionsantwort gehören) → `null`. Die
Zweiwertigkeit ist venue-seitig dokumentiert — `get_pending_positions` weist
`side` als `LONG`/`SHORT` aus
(<https://www.bitunix.com/api-docs/futures/position/get_pending_positions.html>);
ein dritter Wert ist deshalb kein „impliziter Long“, sondern eine unplausible
Antwort.

**Sichtbarkeit statt Stillschweigen:** jede verworfene Zeile landet im
In-Memory-Audit-Ring `readBitunixPositionAnomalies(limit)` (Symbol, gekürzter
Rohwert, `reason: "UNKNOWN_SIDE"`, Zeitstempel; maximal 50 Einträge) und erhöht
`readBitunixPositionAnomalyCount()`. Pro Call wird zusätzlich **eine**
zusammengefasste Warnung über den redaktierten Logger ausgegeben
(`getPositions: N Positionszeile(n) ohne verwertbare side verworfen (kein
LONG-Fallback, B2): …`) — nie unlimitiert pro Zeile, nie ohne Redaction.

Der Zähler ist ein Betriebsignal: ein dauerhaft wachsender Wert bedeutet
„Venue-Antwort unplausibel“, nicht „Position existiert mit unbekannter Seite“.
Eine verworfene Position wird deshalb auch **nie** in `openPositions` der
`BrokerAccount` gezählt (`BrokerExecutionEngine.getAccount` → `listPositions`).

Tests: `tests/bitunix.positions.test.ts` (Unit der Seitenvalidierung, Verwurf +
Zählung, Warnung, Kumulation über Calls, `qty`-vor-`side`-Reihenfolge,
Regression der sauberen Antwort).

---

## 6. Paper (Modus B)

Echte Public-Kurse (Ticker), lokales Ledger, Guardrails + Kill-Switch.
SL/TP werden am Fill **vermerkt** (Venue-Semantik vorbereitet), die Ausführung
bleibt lokal. Credentials dürfen gesetzt sein — der Paper-Pfad stellt trotzdem
**keinen** signierten Request.

**Vereinheitlichte Fill-Engine (v1.21.0):** Das `BitunixPaperLedger`
(`src/brokers/bitunix/paper.ts`) verwendet **denselben** zentralen
`FillSimulator` (`src/lib/marketdata/simulator.ts`) wie die generische
Paper-Execution — es gibt **keine** separate, vereinfachte Simulationslogik mehr.
Früher rechnete das Ledger mit festen Faktoren (LONG → `price·1.0001`,
SHORT → `price·0.9999`); das wich von der zentralen Engine ab
(`Generic Paper ≠ Bitunix Paper`). Heute gilt `Generic Paper === Bitunix Paper`:

```
Bitunix-Ticker (Last-Preis)
        │  snapshotFromLastPrice()  (Bid/Ask symmetrisch aus synthet. Spread)
        ▼
normalisierter MarketSnapshot
        │  FillSimulator.simulate()  (Spread · Slippage · Gebühren · Latenz · Partial Fills)
        ▼
lokaler Fill im Ledger  (Guardrails + Kill-Switch unverändert)
```

Der synthetische Spread wird über `PAPER_SIM_SYNTHETIC_SPREAD_BPS` (Default 2 bp)
gesteuert; Gebühren stammen aus den Registry-Feldern des Instruments
(`makerFee`/`takerFee`) mit Fallback aus der Simulator-Konfiguration. Damit füllt
das Ledger LONG am Ask (+Slippage) und SHORT am Bid (−Slippage) — identisch zum
generischen Simulator. Details der Simulator-Parameter:
[PAPER_TRADING.md](PAPER_TRADING.md) §5.

Discovery schreibt in eine **injizierte** Registry (`source=discovery:bitunix`).
Produktion darf `getRegistry()` nutzen; Tests injizieren immer ein Temp-Verzeichnis
(`autoSave: false`), damit die committete Universe-Datei unberührt bleibt.

---

## 7. Secrets, SSRF, Rate-Limit, Redactor

| Thema | Regel |
| --- | --- |
| Secrets | Default: Control-Plane-Store (`createVenueBackedNamedStore`, AES-256-GCM, AAD=`BITUNIX`) mit Env-Fallback `BITUNIX_API_KEY` / `BITUNIX_API_SECRET`. Nie Disk-Klartext, nie Frontend. `credentialStatus()` liefert `configured`/`connected`/`permissions`/`permissionsVerified`/`liveEnabled:false` — Rechte werden **nie angenommen**: ohne `verify` bleibt `permissions` leer; mit `verify` belegt ein read-only Konto-Abruf maximal `READ` (TRADE wäre nur per echter Order beweisbar). |
| SSRF | Host-Allowlist (`fapi.bitunix.com` + optionale `BITUNIX_ALLOWED_HOSTS`). Kein Userinfo. `https` Pflicht; `http`/`ws` nur Loopback + Insecure-Flag. `redirect: "error"`. |
| TLS | Node-Default-Zertifikatsprüfung (an). |
| Rate-Limit | Token-Bucket, konservativ 8 req/s (Doku: 10/s). |
| Timeout / Retry | Default 8 s, max. 3 Versuche, nur 5xx/Netz — **nie** auth. **H4-Idempotenz:** Nicht-idempotente Requests (POST, insbesondere `place_order`) werden bei Timeout/Netzwerkfehler/5xx/**429** **nie automatisch** wiederholt — Doppel-Order-Gefahr. Der Transport reicht stattdessen einen `BitunixAmbiguousError` (kind `ambiguous`) nach oben; der Aufrufer (`placeSerializedOrder`) fragt VOR jedem erneuten Senden per `clientOrderId` den echten Status ab (`getOrderByClientId`) und wiederholt nur dann genau **einmal** mit demselben `clientOrderId`. Idempotente GETs bleiben weiterhin Retry-fähig. |
| Redactor | Maskiert Header-Muster, Hex-Tokens ≥ 32, injizierte Klartext-Secrets. Logger-Prefix `[bitunix]`. |

---

## 8. Gate-Flags (Defaults sicher)

| Variable | Default | Wirkung |
| --- | --- | --- |
| `BITUNIX_ENABLED` | **false** (nur `"true"` schaltet an) | Adapter/Market-Data/Paper |
| `BITUNIX_LIVE_ENABLED` | false | Venue-Live-Teilbedingung (allein wirkungslos) |
| `LIVE_TRADING_ENABLED` | false | Plattform-Live-Teilbedingung |
| `REQUIRE_HUMAN_APPROVAL` | fehlend = **true** für Live | nur `"false"` öffnet diese Teilbedingung |
| `BITUNIX_API_KEY` / `BITUNIX_API_SECRET` | leer | Env-Fallback, nicht für Frontend |
| `BITUNIX_BASE_URL` / `BITUNIX_WS_URL` | offizielle Hosts | Test-Overrides (Fixture) |
| `BITUNIX_ALLOW_INSECURE_HTTP` | false | Loopback-http für Mock-Tests |
| `BITUNIX_ALLOWED_HOSTS` | — | zusätzliche Hosts (Komma) |
| `BITUNIX_TIMEOUT_MS` / `BITUNIX_RETRY_MAX` | 8000 / 3 | geklemmt |

---

## 9. Mapping `trading_pairs` → `MarketInstrument`

Gilt spiegelbildlich für das Broker-Mapping (`src/brokers/bitunix/mapping.ts`,
Discovery-Upsert `source=discovery:bitunix`) und den Marketdata-Wrapper
(`src/marketdata/adapters/bitunix.ts` — dort geht die Instrument-ID zusätzlich
**immer** über `normalizeVenueSymbol("BITUNIX", symbol)`, Ergebnis in
venue-nativer Speicherform `BITUNIX:<SYMBOL>`, siehe docs/SYMBOLS.md §4):

| Venue-Feld | Instrument |
| --- | --- |
| `symbol` | `id = BITUNIX:<SYMBOL>` (Speicherform; Wrapper: via `normalizeVenueSymbol`), `symbol` upper |
| `base` / `quote` | upper; Fallback Suffix-Inferenz (`inferBase`/`inferQuote`) |
| — | `assetClass=crypto`, `marketType=perpetual` |
| `symbolStatus` + `isApiSupported` | s. §2 (OPEN/CANCEL_ONLY/STOP/isApiSupported=false/DELISTED → active/halted/halted/halted/delisted, unbekannt → preview) |
| `minTradeVolume` | `minQuantity` (ungültig/fehlend ⇒ `1e-8`) |
| `basePrecision` / `quotePrecision` | `quantityStep` / `priceStep` = 10^(−p) (p außerhalb 0..12 ⇒ Defaults `1e-8`/`0.01`) |
| `maxLeverage` | `leverageAvailable = maxLeverage > 1` (ungültig/fehlend ⇒ 1 ⇒ false) |
| — | `shortAvailable=true`, `paperAvailable=true`; `liveTradable=true` (fachlich); `liveAvailable` kommt aus `projectInstrumentAvailability()` |
| — | Fees = VIP0-Defaults (§2) |
| — | `lastSeen` = ISO-UTC jetzt (Wrapper: injizierbare Uhr) |

**Semantik-Trennung (CAP-008 / v1.28.1):** `liveTradable=true` ist die fachliche
Freigabe (Bitunix-Perpetuals sind für Live vorgesehen). `liveAvailable` kommt
ausschließlich aus `projectInstrumentAvailability()` — Adapter, `capabilities.live`,
Feature-Flag und Live-Gate. Solange das Gate geschlossen ist, bleibt
`liveAvailable=false`. Die eigentliche Order-Freigabe entscheidet weiterhin allein
der Live-Gate-Enforcer — siehe `docs/BROKER_ARCHITECTURE.md` und
`docs/CAPABILITIES.md`.

---

## 10. Tests & Coverage

- `tests/bitunix.unit.test.ts` — Signing-Goldens (≥5), Mapping, Orders (inkl. **B1 SL/TP-Geometrie**), 16 Gates, Redactor, Config, Secrets
- `tests/bitunix.http.test.ts` — Fixture-REST, Private-Signatur, SSRF, Token-Bucket
- `tests/bitunix.positions.test.ts` — B2: Positionsseite validiert (Verwurf + Zähler + Warnung), `qty`-vor-`side`-Reihenfolge, LONG/SHORT-Regression
- `tests/bitunix.ws.test.ts` — Ingest, Reconnect/Resubscribe, WS-SSRF
- `tests/bitunix.adapter.test.ts` — Paper-E2E (0 Private-Calls), Live-Gate, Disabled, Secret-Scan
- `tests/bitunix.marketdata.test.ts` — strukturelle `MarketDataAdapter`-Kompatibilität des Broker-Adapters, AdapterRegistry (registriert den Public-only-Wrapper), `/depth`-Orderbook-Schema, leerer-Discovery-Edge-Case, Sync-Kontext-Sicherheit (0 Credentials **und 0 Credential-Header** auf Public-Calls), 429-Retry/Backoff-Regression, Rate-Limit-Eskalation bei N Depth-Calls (Token-Bucket, kein Burst)
- `test/marketdata/adapters/bitunix.test.ts` — P0-Verdrahtung: Discovery-Upsert, „never instantiates private client“ (statisch + Laufzeit gegen Endpoint-Allowlist), Env-/Capability-Gates der Registrierung (inkl. `UnsupportedVenueError`-Hilfetext), exhaustives Timeframe-Mapping + `UnsupportedTimeframeError` (3m/5d-Lücke), Symbol-Normalisierung je Instrument-ID, HALTED/DELISTED-Übernahme, `run-scan` ohne `--sync` = null Netzwerk (Guard-Server-Subprozess), 401/403/429/5xx-Regression mit endlichem Retry-Budget, Env-Proxy (kein Lesen von `BITUNIX_API_KEY`/`_SECRET`), Redaction, geteilter Token-Bucket (8 req/s authoritativ), Voll-Sync gegen echte Fixture-Responses (`test/fixtures/bitunix/`)
- `src/marketdata/__tests__/spread.test.ts` — `calculateRelativeSpread` (Golden 100/100.02 ≈ 0.00019998, Edge Cases: fehlend/invertiert/`0`/`NaN`/`null` ⇒ `null`)
- `src/marketdata/__tests__/sync.test.ts` — `volume24h`-Enrichment, Orderbook-Spread-Upsert, Batch-Tickers, `quoteVol`-Fehlend-Fallback, Rate-Limiter-Zählung bei 180 Instrumenten
- Factory 28er-Matrix, Contract-Suite, `GET /api/brokers` count=7

```bash
npm run test:coverage:bitunix
```

Ziel: ≥ 90 % Zeilen in `src/brokers/bitunix/**`. Kein echter Private-Call, kein
Live-Enable in der Suite.

---

## 11. Verweise

- Contract: `src/contracts/broker.ts` · Factory: `src/brokers/factory.ts`
- Capabilities: `src/brokers/capabilities.ts`
- Market-Data-Sync: `src/marketdata/registerAdapters.ts` (einzige Adapter-Instanzierungsstelle: `registerAdapters()` / `registerMarketDataAdapters(env)`) + `src/marketdata/adapters/bitunix.ts` (Wrapper) + `src/marketdata/sync.ts` (`MarketDataAdapter`, `MarketDataSyncService`)
- Architektur: [BROKER_ARCHITECTURE.md](BROKER_ARCHITECTURE.md) · Universum: [MARKET_UNIVERSE.md](MARKET_UNIVERSE.md)
- Market-Data-Pipeline: [MARKET_DATA_PIPELINE.md](MARKET_DATA_PIPELINE.md)
- Security: [SECURITY_AUDIT.md](SECURITY_AUDIT.md) (Kapitel Task 07)
