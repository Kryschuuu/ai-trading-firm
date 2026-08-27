# Task 07 — Implementierungsplan: Bitunix-Adapter (7. Venue)

**Umfang:** Public REST (trading_pairs/ticker/klines/depth) · WS Ticker+Kline
(Reconnect/Backoff/Resubscribe) · Signing (offizielle Doppel-SHA256) · Private
REST vorbereitet (Account/Positions/Place-Order inkl. SL/TP-at-Venue) ·
Gate-Flags mit sicheren Defaults · Live **immer** `LiveTradingGateError`
(`TODO(task-11)`) · SecretStore-Interface (`TODO(task-08)` Env-Fallback) ·
Mock-Server-Tests · Docs.

**Branch:** Session ist fest auf `arena/01a0451e-ai-trading-firm` gebunden
(wie Task 06). Arbeit und PR erfolgen von diesem Branch; Commits `(task-07)`.

---

## 1. RECON (Pfadmapping)

| Erwartung | Realität | Entscheidung |
| --- | --- | --- |
| BrokerAdapter-Contract | `src/contracts/broker.ts` (Task 02 gemerged) | BITUNIX als 7. `BrokerVenueId`; Capabilities ehrlich |
| MarketInstrument 20 Felder | camelCase in `src/universe/types.ts` (nicht snake_case) | Mapping auf bestehenden Contract; Abweichung dokumentiert |
| Registry-Upsert | `InstrumentRegistry.upsertMany` | `source=discovery:bitunix`, Batch, `lastSeen` |
| Paper-Simulator | `src/lib/marketdata/simulator.ts` + Paper-Ledger | Paper-Orders lokal gegen Bitunix-Kurse; **keine** Private-API |
| SecretStore | fehlt (task-08) | Interface + `EnvSecretStore` (`BITUNIX_API_KEY`/`BITUNIX_API_SECRET`) |
| Live-Gate-Service | fehlt (task-11) | Interface-Stelle markiert; Live-Pfad wirft **immer** |
| Testnet | Offizielle Futures-Doku weist **kein** Testnet aus | `testnet=false` mit Begründung |
| Fees in trading_pairs | nicht enthalten | Dokumentierte Defaults maker 0.02 % / taker 0.06 % (MarketInstrument erlaubt kein `null` für Fees) |

---

## 2. Module (`src/brokers/bitunix/`)

| Datei | Verantwortung |
| --- | --- |
| `config.ts` | Flags, Allowlist, Endpunkte, Timeouts, Defaults |
| `signing.ts` | `SHA256(SHA256(nonce+ts+api-key+query+body)+secret)` UTF-8, Goldens |
| `http.ts` | TLS, SSRF-Allowlist, Rate-Limit, Timeout, Backoff |
| `publicClient.ts` | trading_pairs, tickers, kline, depth |
| `ws.ts` | `ticker` / `market_kline_*`, Reconnect, Snapshot-Delta |
| `mapping.ts` | trading_pairs → MarketInstrument (`marketType=perpetual`) |
| `privateClient.ts` | Account, Positions, Place-Order (signiert) |
| `orders.ts` | Serialisierung inkl. `slPrice`/`tpPrice` (Venue-Level) |
| `gates.ts` | Flag-AND + **immer** LGTE bis task-11 |
| `secrets.ts` / `redactor.ts` | SecretStore, Log-Maskierung |
| `adapter.ts` | `BrokerAdapter`-Implementierung |
| `paper.ts` | lokales Paper-Ledger (Modus B) |

---

## 3. Endpunkte (offiziell `https://fapi.bitunix.com`)

**Public:** `GET /api/v1/futures/market/trading_pairs|tickers|kline|depth`
**Private:** `GET /api/v1/futures/account`, `GET .../position/get_pending_positions`,
`POST .../trade/place_order` (SL/TP im selben Body)
**WS:** `wss://fapi.bitunix.com/public/` · Channels `ticker`, `market_kline_{interval}`

---

## 4. Signatur-Verifikation (offizielle Doku)

Quelle: [Bitunix Sign](https://www.bitunix.com/api-docs/futures/common/sign.html)

1. Query-Params ASCII-sortiert, `key+value` ohne Trenner (`id1uid200`).
2. Body kompakt, **ohne Spaces**, byte-identisch zum Request.
3. `digest = SHA256_hex(nonce + timestamp + api-key + queryParams + body)`
4. `sign = SHA256_hex(digest + secretKey)`  (UTF-8)

**Abweichung Doku-Beispiel:** Header-Text „timestamp milliseconds“, Demo-String
`"20241120123045"` (YmdHis). Implementierung nutzt **Millisekunden** laut
API-Validation-Abschnitt. Nonce: 32 Hex-Zeichen (Doku „32bits“ mehrdeutig;
Login-Beispiel ist 32 Zeichen).

---

## 5. Gates (Defaults sicher)

`BITUNIX_ENABLED=false` · `BITUNIX_LIVE_ENABLED=false` ·
`LIVE_TRADING_ENABLED=false` · `REQUIRE_HUMAN_APPROVAL` für Live nur bei
exakt `"false"` offen. Live-Order **nur** wenn alle true/false wie spezifiziert
**und** Live-Gate-Service `LIVE_ENABLED` — Service fehlt → **immer** LGTE.

---

## 6. Teststrategie

Unit: Signing-Goldens (≥5), Nonce/Timestamp, Mapping, Order-Serialisierung,
16 Flag-Kombos, SSRF, Secret-Scan.
Integration: Mock-REST (Signatur-401), Ticker/Klines/Depth, Fehlerpfade,
WS-Reconnect. E2E Paper: Discovery → Registry → Ticker → Paper-Order
(0 Private-Calls). Coverage ≥ 90 % `src/brokers/bitunix/**`.
