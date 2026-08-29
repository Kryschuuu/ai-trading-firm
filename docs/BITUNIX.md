# Bitunix-Adapter (Task 07) — 7. Venue, USDT-M-Perpetuals

**Stand:** v1.25.2 · **Modul:** `src/brokers/bitunix/` · **Contract:** `BrokerAdapter` + `MarketDataAdapter`
**Status:** Public REST/WS und Paper (Modus B) ausführbar. Live-Ausführung über den
zentralen Live-Gate-Enforcer (Task 11) und eine **getrennte Broker-Ausführungs-Engine**
(s. §5) — ohne bestandene Gate-Prüfung weiterhin `LiveTradingGateError`.
Kein dokumentiertes Futures-Testnet. Seit v1.25.1 (nachgearbeitet zu PR #34) ist die
**Public-Market-Data in die Scanner-Pipeline verdrahtet** (§1.1): `BitunixBrokerAdapter`
implementiert `MarketDataAdapter` und wird von der zentralen `AdapterRegistry` für
`MarketDataSyncService` registriert — ohne parallelen Wrapper.

Dieses Dokument ist die verbindliche Spezifikation des Bitunix-Adapters. Der Kern
(engine, risk, agents, API) kennt weiterhin **nur** `BrokerAdapter` — Venue-Details
bleiben in diesem Ordner.

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

### 1.1 Public Market Data im Scanner-Pipeline (seit v1.25.1)

Der Adapter implementiert neben `BrokerAdapter` explizit das
`MarketDataAdapter`-Interface (`src/marketdata/sync.ts`). Die zentrale
`AdapterRegistry` (`src/marketdata/adapterRegistry.ts` — die **einzige** Stelle,
die konkrete Adapter-Klassen instanziiert) registriert ihn unter dem Venue-Key
`"BITUNIX"`; `MarketDataSyncService` / `npm run market-sync` nutzen nur die
Public-Methoden `discoverInstruments()`, `getTicker(s)()`, `getOrderBook()` und
`getCandles()` — Discovery → Ticker/Orderbook-Enrichment → Candle-Backfill füllt
damit `InstrumentRegistry` und `HistoricalStore` **vor** dem deterministischen
Scanner. Details: [MARKET_DATA_PIPELINE.md](MARKET_DATA_PIPELINE.md).

**Ende der Parallel-Implementierung (v1.25.1):** Der frühere Wrapper
`src/marketdata/adapters/bitunix.ts` (`BitunixMarketDataAdapter`) ist entfernt —
der echte `BitunixBrokerAdapter` ist die alleinige Market-Data-Quelle der
Pipeline; `getCandles()` akzeptiert seither ein `limit`, und `getTickers()`
bündelt das Ticker-Enrichment zu einem Batch-Call.

**Klare Trennung der vier Ebenen:**

| Ebene | Pfad | Credentials | Status |
| --- | --- | --- | --- |
| **Public market data** | `trading_pairs`, `tickers`, `depth`, `kline` (+ Public-WS) | **keine** (Public-Client, Token-Bucket 8 req/s) | **Jetzt an Scanner-Pipeline angebunden** (Sync vor dem Scan) |
| **Private trading API** | `account`, `positions`, `place_order` (signiert) | `BITUNIX_API_KEY` / `BITUNIX_API_SECRET` | **Weiterhin nur für Order-Ausführung** — nie im Sync/Discovery/Enrichment-Pfad |
| **Paper execution** | `PaperExecutionEngine` (lokales Ledger, echte Public-Kurse) | keine signierten Requests | verfügbar (`getBroker("BITUNIX", "paper")`) |
| **Live execution** | `BrokerExecutionEngine` → `BitunixPrivateClient.placeSerializedOrder` | signiert, nur nach Live-Gate | gesperrt (Task 11, Default `LiveTradingGateError`) |

### 1.2 Spread kommt aus dem Orderbuch, nicht aus dem Ticker (FEHLER-3 — seit v1.25.2, nachgearbeitet zu PR #35)

**Spread wird NICHT direkt von der Ticker-API geliefert, sondern aus dem
Orderbook (bestBid/bestAsk) berechnet. Dies erfordert einen zusätzlichen
`/depth`-Call pro Instrument.**

| Metrik | Endpunkt | Feld | Bemerkung |
| --- | --- | --- | --- |
| 24h-Volumen | `GET /tickers` | `quoteVol` → `volume24h` | 1× Batch-Call für alle Symbole möglich |
| Spread | `GET /depth` | `bids[0].price` / `asks[0].price` → `spread` | **1 Call je Instrument**, kein Batch-Äquivalent |

Berechnung (`src/marketdata/spread.ts` → `calculateRelativeSpread`):

```
spread = (ask − bid) / mid        mid = (ask + bid) / 2
```

`0.0004` entspricht 4 bp. Ungültige/fehlende Book-Daten (leere Seite, `≤ 0`,
invertiertes Buch `bid > ask`, `NaN`) liefern **`null`** — niemals `0`, niemals
`NaN`, niemals eine Exception. `null` heißt „nicht geladen“ und ist bewusst von
einem (fachlich verdächtigen) Spread von 0 unterscheidbar.

Folgen für den Sync- und Scanner-Pfad:

* Kosten: N Instrumente ⇒ N zusätzliche `/depth`-Requests (z. B. 180
  Instrumente ⇒ 180 Calls). Sie laufen sequenziell durch den Token-Bucket
  (8 req/s, §2) — kein Sekunden-Burst.
* Der `spread`-Faktor des Scanners hat (anders als `liquidity`, das auf
  `Kerze.volume × close` zurückfällt) **keinen** Fallback. Ohne
  Orderbook-Enrichment scheitert deshalb jedes Instrument an der
  `max-spread`-Regel — als **Data-Quality-Rejection**
  (`dataQuality: true`, Meldung „Spread wurde nicht geladen“), nicht als
  fachliche Marktablehnung.
* Details zum Gesamtfluss: [MARKET_DATA_PIPELINE.md](MARKET_DATA_PIPELINE.md)
  §2–§3 und §8.

Garantien des Sync-Kontexts (durch Tests abgesichert):

- `adapterRegistry.ts` erzeugt den Adapter **immer im Modus `"paper"` und ohne
  PrivateClient** — API-Key/Secret werden im Discovery/Enrichment-Pfad nicht
  referenziert, es laufen keine signierten Requests (Integrationstest zählt
  `privateCalls === 0`).
- Der Scanner (`src/scanner/`) importiert **keinen** konkreten Adapter — er
  kennt ausschließlich `InstrumentRegistry` und `HistoricalStore`.
- Order-Ausführung bleibt vollständig über `getBroker()` (Factory) und den
  Private-Client getrennt (§5).

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
| Positionen (privat) | `GET /api/v1/futures/position/get_pending_positions` |
| Place-Order (privat) | `POST /api/v1/futures/trade/place_order` |
| Public WS | `wss://fapi.bitunix.com/public/` |

Envelope: `{ code: 0, data, msg }`. `code ≠ 0` wird taxonomisch klassifiziert
(auth / permission / rate-limit / maintenance / unknown).

**Fees:** `trading_pairs` liefert keine maker/taker-Felder. `MarketInstrument`
erlaubt kein `null` für Fees — der Adapter setzt die dokumentierten VIP0-Defaults
**0,02 % maker / 0,06 % taker** (`0.0002` / `0.0006`). Abweichung zur Formulierung
„sonst null“ ist bewusst.

**Status-Mapping:** `OPEN` → `active`; `CANCEL_ONLY`/`STOP` → `halted`; sonst `preview`.
Unbekannte Felder werden ignoriert; kaputte Zeilen übersprungen.

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
  bestandener Prüfung sendet die `BrokerExecutionEngine` die Order über
  `BitunixPrivateClient.placeSerializedOrder` (SL/TP als `slPrice`/`tpPrice` im
  selben Body, `stopAtVenue`). **Niemals** über das Paper-Ledger.
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
Query, kein Key, keine Signatur).

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
| Secrets | Default: Control-Plane-Store (`createVenueBackedNamedStore`, AES-256-GCM, AAD=`BITUNIX`) mit Env-Fallback `BITUNIX_API_KEY` / `BITUNIX_API_SECRET`. Nie Disk-Klartext, nie Frontend. `credentialStatus()` liefert nur `connected`/`permissions`/`liveEnabled:false`. |
| SSRF | Host-Allowlist (`fapi.bitunix.com` + optionale `BITUNIX_ALLOWED_HOSTS`). Kein Userinfo. `https` Pflicht; `http`/`ws` nur Loopback + Insecure-Flag. `redirect: "error"`. |
| TLS | Node-Default-Zertifikatsprüfung (an). |
| Rate-Limit | Token-Bucket, konservativ 8 req/s (Doku: 10/s). |
| Timeout / Retry | Default 8 s, max. 3 Versuche, nur 429/5xx/Netz — **nie** auth. |
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

| Venue-Feld | Instrument |
| --- | --- |
| `symbol` | `id = BITUNIX:<SYMBOL>`, `symbol` upper |
| `base` / `quote` | upper; Fallback Suffix-Inferenz |
| — | `assetClass=crypto`, `marketType=perpetual` |
| `symbolStatus` | s. §2 |
| `minTradeVolume` | `minQuantity` |
| `basePrecision` / `quotePrecision` | `quantityStep` / `priceStep` = 10^(−p) |
| `maxLeverage` | `leverageAvailable = maxLeverage > 1` |
| — | `shortAvailable=true`, `paperAvailable=true`, `liveTradable=true` (Fähigkeit), `liveAvailable=false` (Freigabe) |
| — | Fees = VIP0-Defaults (§2) |
| `lastSeen` | ISO-UTC jetzt |

**Semantik-Trennung (v1.20.0):** `liveTradable` beschreibt die Fähigkeit des
Instruments am Broker (perpetual ist beim Venue live-handelbar), `liveAvailable`
ist der abwärtskompatible Spiegel und bleibt `false` (keine systemseitige Freigabe).
Die eigentliche Freigabe entscheidet allein der Live-Gate-Zustand + `venueControl`
— siehe `docs/BROKER_ARCHITECTURE.md`.

---

## 10. Tests & Coverage

- `tests/bitunix.unit.test.ts` — Signing-Goldens (≥5), Mapping, Orders, 16 Gates, Redactor, Config, Secrets
- `tests/bitunix.http.test.ts` — Fixture-REST, Private-Signatur, SSRF, Token-Bucket
- `tests/bitunix.ws.test.ts` — Ingest, Reconnect/Resubscribe, WS-SSRF
- `tests/bitunix.adapter.test.ts` — Paper-E2E (0 Private-Calls), Live-Gate, Disabled, Secret-Scan
- `tests/bitunix.marketdata.test.ts` — `MarketDataAdapter`-Konformität (Compile-Time), AdapterRegistry, `/depth`-Orderbook-Schema, leerer-Discovery-Edge-Case, Sync-Kontext-Sicherheit (0 Credentials **und 0 Credential-Header** auf Public-Calls), 429-Retry/Backoff-Regression, Rate-Limit-Eskalation bei N Depth-Calls (Token-Bucket, kein Burst)
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
- Market-Data-Sync: `src/marketdata/adapterRegistry.ts` (einzige Adapter-Instanzierungsstelle) + `src/marketdata/sync.ts` (`MarketDataAdapter`, `MarketDataSyncService`)
- Architektur: [BROKER_ARCHITECTURE.md](BROKER_ARCHITECTURE.md) · Universum: [MARKET_UNIVERSE.md](MARKET_UNIVERSE.md)
- Market-Data-Pipeline: [MARKET_DATA_PIPELINE.md](MARKET_DATA_PIPELINE.md)
- Security: [SECURITY_AUDIT.md](SECURITY_AUDIT.md) (Kapitel Task 07)
