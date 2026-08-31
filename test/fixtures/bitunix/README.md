# Bitunix-API-Fixtures (P0-Verdrahtung)

Provenance und Regeln für die Fixtures in diesem Ordner.

## Echte Responses (Snapshot 2026-08-31)

`trading_pairs.json`, `tickers.json`, `depth.json` und `kline.json` sind
**echte, unveränderte Responses der öffentlichen Bitunix-Futures-API**
(`https://fapi.bitunix.com`), abgerufen am 2026-08-31:

| Datei | Endpunkt | Bearbeitung |
| --- | --- | --- |
| `trading_pairs.json` | `GET /api/v1/futures/market/trading_pairs` | **Subset**: die ersten 4 Zeilen (BTC/ETH/BNB/XRP) 1:1 aus der Live-Antwort — Felder, Typen (String-Preise, Int-Precisions), Reihenfolge unverändert |
| `tickers.json` | `GET /api/v1/futures/market/tickers?symbols=BTCUSDT,ETHUSDT` | 1:1 |
| `depth.json` | `GET /api/v1/futures/market/depth?symbol=BTCUSDT&limit=5` | 1:1 |
| `kline.json` | `GET /api/v1/futures/market/kline?symbol=BTCUSDT&interval=1h&limit=3` | 1:1 |

Enthalten sind ausschließlich öffentliche Marktdaten (Kurse, Volumen,
Handelsbedingungen) — keine Account-, Order- oder Credential-Daten; eine
Anonymisierung im Datenschutz-Sinn ist damit nicht erforderlich. Symbole und
Kurse sind bewusst unverändert gelassen, damit Tests gegen echte Werte
(inkl. echter String-Number-Typen) laufen.

## Ergänzte Edge-Case-Zeilen (`trading_pairs_edge_statuses.json`)

Der Live-Snapshot enthielt am Capture-Datum ausschließlich
`symbolStatus: "OPEN"`. Die offizielle API-Doku dokumentiert zusätzlich
`CANCEL_ONLY` („cancel only“) und `STOP` („can't open/close position“) sowie
`isApiSupported: false` („API Trading Disabled“). `trading_pairs_edge_statuses.json`
enthält deshalb **fünf Zeilen im exakt selben Response-Schema** (feldkompatibel
zur echten Antwort, inkl. aller Pflichtfelder), die diese dokumentierten Werte
abdecken:

- `PAUSEUSDT` — `symbolStatus: "STOP"`
- `CXLUSDT` — `symbolStatus: "CANCEL_ONLY"`
- `NOAPIUSDT` — `isApiSupported: false` (Status OPEN)
- `GONEUSDT` — `symbolStatus: "DELISTED"` (defensiv; von der Venue heute nicht
  dokumentiert, Mapper-verhalten trotzdem getestet)
- `BAREUSDT` — Zeile **ohne** `base`/`quote`/`minBuyPriceOffset`/… (Tests der
  base/quote-Inferenz aus dem Symbol-Suffix)

Diese Zeilen sind im Dokumentationskommentar des Tests
(`test/marketdata/adapters/bitunix.test.ts`) als schema-echte, inhaltlich
synthetische Ergänzungen markiert — kein „Wunschschema“: jedes Feld existiert
in der echten Antwort, jeder Statuswert stammt aus der Venue-Doku
(https://www.bitunix.com/api-docs/futures/market/get_trading_pairs.html).

## Verwendung

Nur über den Fixture-Fetch in `test/marketdata/adapters/bitunix.test.ts`
(In-Memory, kein Netzwerk). Kein Test darf echte Requests an fapi.bitunix.com
senden.
