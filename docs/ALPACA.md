# Alpaca-Adapter (Task 12) — 8. Venue, US-Aktien/ETFs/Crypto

**Stand:** v1.36.0 · **Modul:** `src/brokers/alpaca/` · **Contract:** `BrokerAdapter`
**Status:** Public REST (Market Data v2) + Private Trading API (Basic-Auth) +
Paper (Modus B) ausführbar. Live-Ausführung über den zentralen Live-Gate-Enforcer
(Task 11) und eine **getrennte Broker-Ausführungs-Engine** (s. §5) — ohne
bestandene Gate-Prüfung weiterhin `LiveTradingGateError`. Alpacas offizielle
`paper-api.alpaca.markets` ist ein vollständiges Testnet (eigener Endpoint,
separate Credentials, eigenes Geld-Limit) — daher `VENUE_CAPABILITIES.ALPACA.testnet = true`.

Dieses Dokument ist die verbindliche Spezifikation des Alpaca-Adapters. Der Kern
(engine, risk, agents, API) kennt weiterhin **nur** `BrokerAdapter` — Venue-Details
bleiben in diesem Ordner.

---

## 0. Code-Map (Anforderung → realer Pfad)

| Baustein | Realer Pfad | Anmerkung |
| --- | --- | --- |
| `AlpacaBrokerAdapter` | `src/brokers/alpaca/adapter.ts` | implementiert `BrokerAdapter`; `id = "ALPACA"`, `mode`-abhängiger ExecutionPort |
| `AlpacaHttp` + `TokenBucket` | `src/brokers/alpaca/http.ts` | Public- und Private-Endpoint (getrennte Rate-Budgets); TLS erzwungen, Loopback-Ausnahme, Host-Allowlist, **kein Retry für nicht-idempotente POSTs** |
| `AlpacaPublicClient` | `src/brokers/alpaca/publicClient.ts` | credential-frei; `fetchTicker`, `fetchCandles` (Bars v2) |
| `AlpacaPrivateClient` | `src/brokers/alpaca/privateClient.ts` | Basic-Auth, `getAccount`/`getPositions`/`getAssets`/`placeOrder`/`getOrder` |
| `AlpacaPaperLedger` | `src/brokers/alpaca/paper.ts` | lokales Ledger für Modus B mit Guard-Sequenz (Kill-Switch → Validate → Fill → Cash) |
| `ExecutionPort` | `src/brokers/alpaca/execution.ts` | `PaperExecutionEngine` (paper) + `BrokerExecutionEngine` (live) — getrennte Implementierungen, niemals vermischt |
| Mapping | `src/brokers/alpaca/mapping.ts` | `mapAsset`/`mapAssets` (Alpaca-Asset → `MarketInstrument`), `mapBar`/`mapBars`, `mapOrderResult`/`mapPosition`/`mapAccount` |
| Order-Serialisierung | `src/brokers/alpaca/orders.ts` | `serializePlaceOrder` + `makeClientOrderId` (Idempotenz-Key) |
| Secret-Store | `src/brokers/alpaca/secrets.ts` | `SecretStore` + Env-Fallback `ALPACA_API_KEY`/`ALPACA_API_SECRET` |
| Redactor | `src/brokers/alpaca/redactor.ts` | `createAlpacaLogger` + `redactAlpaca` (maskiert `apiKey`/`apiSecret`/Header) |
| Config | `src/brokers/alpaca/config.ts` | `loadAlpacaPublicConfig`/`loadAlpacaTradeConfig` |
| Audit | `src/brokers/alpaca/audit.ts` | synchroner In-Memory-Ring + `audit_log`-Event `ALPACA_PRIVATE_CALL` |

---

## 1. Aktivierung (Capability-Flags)

* `ALPACA_ENABLED=true` — schaltet Discovery / Market Data / Trading scharf.
  Ohne diesen Flag werfen alle Capability-Methoden `AlpacaDisabledError`.
* `ALPACA_LIVE_ENABLED=true` **allein** öffnet **nichts** — der zentrale
  Live-Gate-Enforcer (Task 11) prüft State-Machine + Suite-Stamp + Control
  Plane + Kill-Switch. Default ist `LiveTradingGateError`.
* `ALPACA_USE_LIVE_ENDPOINTS=false` (Default) → `paper-api.alpaca.markets`.
  `true` → `api.alpaca.markets`. `execution()` wirft im Testnet-Modus
  `NotSupportedCapabilityError`, wenn `ALPACA_USE_LIVE_ENDPOINTS=true` gesetzt
  ist (Testnet-Mismatch-Schutz).
* `ALPACA_ALLOW_INSECURE_HTTP` — nur für Loopback-Tests.
* `ALPACA_RETRY_MAX` (Default 2) — nur für idempotente GET-Requests und 429.

## 2. Public-Market-Data (credential-frei)

Der `AlpacaPublicClient` ruft `GET /v2/stocks/{symbol}/snapshot` bzw.
`GET /v2/crypto/{symbol}/bars` ohne Auth-Header. Der Adapter setzt
`Authorization` nur, wenn Credentials explizit geladen wurden; im
Public-Pfad ist `authed: false` (Fixture-Test verifiziert).

## 3. Private-Trading-API (Basic-Auth)

`Authorization: Basic base64(API_KEY:API_SECRET)` (immer gesetzt im
Private-Pfad). POST `/v2/orders` ist **nicht idempotent** — der HTTP-
Transport verweigert Retry für nicht-idempotente Requests. Idempotenz
wird über `client_order_id` (BrokerOrderRequest-Symbol+Qty+Side+Timestamp)
sichergestellt. Jeder Private-Call wird in `ALPACA_PRIVATE_CALL` auditiert
(Methode, Pfad, Outcome, kein Body/Query/Key).

## 4. Capabilities

```ts
VENUE_CAPABILITIES.ALPACA = {
  discovery: true,    // /v2/assets (credential-pflichtig)
  marketData: true,   // /v2/stocks/{sym}/snapshot, /v2/crypto/...
  trading: true,      // /v2/orders, /v2/account
  paper: true,        // Paper-Ledger (Modus B)
  testnet: true,      // Paper-API ist offizielles Testnet
  live: true,         // Capability deklariert; Ausführung hinter Live-Gate
  stopAtVenue: true,  // Bracket-Orders (order_class=bracket)
  instrumentTypes: { spot: true, perpetual: false, future: false,
                     option: false, cfd: false },
}
```

Modus C (`PAPER_MODE=broker-paper-api`) ist mit `PAPER_BROKER_API_VENUE=ALPACA`
wählbar (`testnet: true`).

## 5. ExecutionPort-Separation

Wie in `docs/BITUNIX.md` §5 beschrieben: zwei Implementierungen derselben
Schnittstelle, niemals vermischt.

| Modus | Engine | Pfad |
| --- | --- | --- |
| `paper` / `backtest` | `PaperExecutionEngine` | `AlpacaPaperLedger` (lokal, 0 Private-Calls) |
| `testnet` / `live` | `BrokerExecutionEngine` | `AlpacaPrivateClient` (echte Venue-Orders) |

* `BrokerExecutionEngine.submit` prüft **vor** dem Senden:
  `killSwitch.isArmed()` (Defense in Depth).
* `AlpacaPaperLedger.submit` führt die volle Guard-Sequenz:
  Kill-Switch → Input-Validierung → `validateOrder` (Notional, Equity, Side,
  Pflicht-Stop) → `FillSimulator` → Cash-Check → Position-Update.
* Reject-Codes: `KILL_SWITCH_ARMED`, `INVALID_QTY`, `NO_QUOTE:<sym>`,
  `INVALID_STOP_LOSS`, Guardrail-Block (z. B. `MISSING_STOP_LOSS`).

## 6. Credential-Status (ehrliche Projektion)

`credentialStatus({verify?})`:

* **ohne `verify`:** `connected: false`, `permissions: []`,
  `permissionsVerified: false`, `configured`/`alpacaEnabled` aus Credentials/Flag.
  **Kein** Netzwerk-Call.
* **mit `verify: true`:** erfolgreicher `getAccount` →
  `connected: true`, `permissions: ["READ"]`, `permissionsVerified: true`.
  Nur READ — TRADE wird nie ohne echte Order belegt.

Damit ist die in v1.35.1 für Bitunix nachgezogene Audit-Lehre
(`credentialStatus` ohne `verify` meldet keine Rechte) für Alpaca von
Anfang an erfüllt.

## 7. Audit (`ALPACA_PRIVATE_CALL`)

```json
{
  "ts": 1756700000000,
  "venue": "ALPACA",
  "method": "GET",
  "path": "/v2/account",
  "outcome": "OK",
  "errorCode": null
}
```

* Synchroner In-Memory-Ring (`alpacaPrivateAuditRing`, max. 200).
* Best-effort `audit_log`-Persistenz (Event `ALPACA_PRIVATE_CALL`).
* `src/lib/auditView.ts` enthält den Katalogeintrag mit deutscher
  Beschreibung, Sektion „Privater Call" (Methode/Pfad/Ergebnis/Fehlercode).

## 8. Security-Audit

* **Kill-Switch** prüft sowohl `killSwitch.isArmed()` als auch
  Datei-Kill-Flag im Enforcer.
* **Idempotenz** POST `placeOrder` über `client_order_id` (UUID, Broker
  erkennt Duplikate).
* **No-Retry** für nicht-idempotente Requests (nur 429 retry-fähig).
* **Deterministische Redaction** — `loadCreds()` befüllt die Maskierliste
  im selben Schritt wie das Laden.
* **Public-Endpoint** credential-frei (Test gegen Fixture-Server).
* **Kein Klartext-Secret** in `console.*` (Test-Scan in
  `tests/alpaca.adapter.test.ts`).
* **Testnet-Mismatch-Schutz**: Testnet + Live-Endpoint → `NotSupportedCapabilityError`.

## 9. Tests

* `tests/alpaca.unit.test.ts` (22): Mapping, Orders, Errors, Audit, Bars.
* `tests/alpaca.adapter.test.ts` (17): Paper-E2E, Disabled-Flag,
  Live-Gate, Live-Gate OFFEN, Public-Client, Private-Client, Capabilities,
  getOrderBook, credentialStatus mit/ohne verify, Basic-Auth-Header,
  Paper-Ledger Reject-Pfade, ExecutionPort-Separation, Audit, Secret-Scan.
* `tests/brokerFactory.test.ts` (13): 28er-Matrix.
* `tests/brokerContracts.test.ts` (42): `ALPACA`-Branch in allen Verträgen.
* `tests/brokerCoverage.test.ts` (10) / `brokerCoverage.api.test.ts` (2):
  Headline 2/2/0, Testnet = `["ALPACA"]`.

## 10. Migration / Deployment

Kein Schema-Bruch, keine neuen Pflicht-Env-Variablen. Opt-in in `.env`:

```bash
ALPACA_ENABLED=false            # Default aus
ALPACA_API_KEY=…                # aus https://app.alpaca.markets (Paper!)
ALPACA_API_SECRET=…
ALPACA_USE_LIVE_ENDPOINTS=false # Default: Paper-API
ALPACA_ALLOW_INSECURE_HTTP=false # nur Loopback-Tests
ALPACA_RETRY_MAX=2              # Default
```

`GET /api/brokers` zeigt ab v1.36.0 `count=8` Venues (PAPER + BITUNIX +
ALPACA als reale Volladapter, fünf Stubs unverändert). Live bleibt
überall gesperrt; `credentialStatus` ohne `verify` meldet keine Rechte.
