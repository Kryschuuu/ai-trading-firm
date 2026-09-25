# Alpaca-Adapter (Task 12) — 8. Venue, US-Aktien/ETFs/Crypto

**Stand:** v0.1.0 (Beta) · **Modul:** `src/brokers/alpaca/` · **Contract:** `BrokerAdapter`
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
| Secret-Store | `src/brokers/alpaca/secrets.ts` | `SecretStore` = Control-Plane-Store (SEC-07 v1.36.32: in Prod kein Env-Fallback; Env nur mit `BROKER_ALLOW_ENV_FALLBACK=true` + non-prod) |
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

## 1a. Datenversorgung (Market-Data-Sync) — der häufigste „Alpaca ist nicht integriert"-Fall

Alpacas Market-Data-API verlangt API-Keys. Der **Warmup** (Discovery →
Enrichment → Backfill → Readiness, s. [MARKET_DATA_PIPELINE.md](MARKET_DATA_PIPELINE.md))
zieht Kerzen und Ticker für die ALPACA-Instrumente deshalb über
**Yahoo Finance** — denselben credential-freien Pfad wie IBKR
(`src/marketdata/adapters/yahoo.ts`, `createsYahooMarketDataAdapter({ venue: "ALPACA" })`).

Daraus folgt die Aktivierungs-Reihenfolge, ohne die die 52 kuratierten
US-Werte im Operations Center als „0 Kerzen / warming" erscheinen:

```bash
# 1) Venue freischalten (gilt für Sync UND Broker-Adapter):
ALPACA_ENABLED=true

# 2) Warmup fahren — eine Venue pro Aufruf (--venue nimmt genau eine):
npm run market:sync -- --venue=ALPACA --timeframes=15m,1h,1d --candle-limit=61

# 3) Kontrolle (rein lesend, kein Netzwerk):
npm run market:sync -- --status
```

Danach sind die ALPACA-Instrumente `data-ready` und die Equity-/Index-Mandate
(`EQUITIES`, `INDICES`) erhalten echte Marktdaten statt „keine Kerzendaten".

**Ohne `ALPACA_ENABLED=true`** überspringt `registerAdapters()` die Venue
vollständig (`SkippedAdapter` mit Grund `FLAG_OFF`) — es passiert kein
Netzwerkverkehr, aber es entstehen eben auch keine Kerzen.

Hinweise:

* `--candle-limit` muss ≥ `requiredWarmupCandles` (Default **61**) sein, sonst
  lehnt das CLI den Lauf mit `InsufficientCandleLimitError` ab (der
  Obige Fehlertext stammt aus genau dieser Prüfung).
* Der Hinweis in der Sektion „Market Data" nennt seit v0.5.0 **die Venue der
  worst offenders** (`npm run market:sync -- --venue=ALPACA …`) statt pauschal
  BITUNIX — plus den Flag-Hinweis, wenn die Venue noch nie synchronisiert wurde.
* US-Handelstage: außerhalb der Börsenzeiten liefert Yahoo die letzten
  Schlusskerzen; der Warmup funktioniert also auch am Wochenende.

## 1b. Health-Status: was „degraded" bei ALPACA bedeutet

`GET /api/brokers` / `GET /api/brokers/ALPACA/health` liefern für ALPACA
weiterhin `online` **nur** mit echten Credentials (`getAccount` gelungen).
Ohne Credentials bleibt der Status `degraded` mit `reason:
CREDENTIALS_REQUIRED` — die Trading-API ist ungeprüft.

Ist der Broker-Remote-Check aktiv (Default aus, ohne Neustart umschaltbar im
Operations Center → „Broker Operations"), kommt die credential-freie
Datenquellen-Prüfung additiv dazu:

| Feld | Bedeutung |
| --- | --- |
| `syncSourceReachable` | `true` = Yahoo liefert Kerzen für SPY → der Warmup-Datenpfad der Venue funktioniert |
| `syncSourceScope` | immer `market-data-source` — es wird **nicht** die Trading-API geprüft |
| `syncSourceReason` | `TRADING_API_UNVERIFIED` (Quelle ok) · `SYNC_SOURCE_EMPTY` · `SYNC_SOURCE_UNREACHABLE` |
| `syncSourceBars` / `syncSourceHttpStatus` | gelieferte Kerzen bzw. HTTP-Status der Fehlantwort |

Ein erreichbarer Datenpfad ist **kein** Online-Beweis für die Venue — deshalb
ändert er den Status nie auf `online`.

## 2. Public-Market-Data (credential-frei)

Der `AlpacaPublicClient` ruft `GET /v2/stocks/{symbol}/snapshot` bzw.
`GET /v2/crypto/{symbol}/bars` ohne Auth-Header. Der Adapter setzt
`Authorization` nur, wenn Credentials explizit geladen wurden; im
Public-Pfad ist `authed: false` (Fixture-Test verifiziert).

## 3. Private-Trading-API (Basic-Auth)

Im Private-Pfad wird der `Authorization`-Header mit dem Base64-codierten
Credential-Paar gesetzt (Format `Basic base64(<key>:<secret>)`).
POST `/v2/orders` ist **nicht idempotent** — der HTTP-Transport verweigert
Retry für nicht-idempotente Requests. Idempotenz wird über `client_order_id`
(BrokerOrderRequest-Symbol+Qty+Side+Timestamp) sichergestellt. Jeder
Private-Call wird in `ALPACA_PRIVATE_CALL` auditiert (Methode, Pfad,
Outcome, kein Body/Query/Key).

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

## 8. Security-Audit (SEC-07 v1.36.32)

* **Env-Fallback nur explizit in Dev/Test:** In Produktion kein Fallback auf `ALPACA_API_KEY`/`ALPACA_API_SECRET`. Fehlender Datensatz → null, Store-Fehler (AUTH_FAILED, STORAGE_UNAVAILABLE) → HARD FAIL. Env nur wenn `BROKER_ALLOW_ENV_FALLBACK=true` und `NODE_ENV!=production`. Ohne `SECRET_STORE_KEY` und ohne Flag → fail-closed.

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
ALPACA_ENABLED=true             # Default aus — ohne Flag kein Sync, kein Adapter
ALPACA_KEY_ID=…                 # alternativ: Control-Plane-UI (Broker-Tab, empfohlen)
ALPACA_SECRET_KEY=…
ALPACA_USE_LIVE_ENDPOINTS=false # Default: Paper-API
ALPACA_ALLOW_INSECURE_HTTP=false # nur Loopback-Tests
ALPACA_RETRY_MAX=2              # Default
BROKER_ALLOW_ENV_FALLBACK=false # SEC-07: Env-Fallback nur explizit Dev/Test
```

**Reihenfolge für eine bestehende Installation** (das war der beobachtete
Zustand „ALPACA nie synchronisiert, 0/61 Kerzen"):

1. `ALPACA_ENABLED=true` setzen (Sync-Gate und Adapter-Gate).
2. `npm run market:sync -- --venue=ALPACA --timeframes=15m,1h,1d` ausführen —
   danach `npm run market:sync -- --status` zur Kontrolle.
3. Optional Credentials im Broker-Tab hinterlegen; der Paper-Modus B
   (`PAPER_MODE=broker-paper-api`, `PAPER_BROKER_API_VENUE=ALPACA`) nutzt sie.
4. Optional Remote-Check einschalten (Operations Center → „Broker Operations"),
   um die Datenquelle der Venue mitzuprüfen.

`GET /api/brokers` zeigt ab v1.36.0 `count=8` Venues (PAPER + BITUNIX +
ALPACA als reale Volladapter, fünf Stubs unverändert). Live bleibt
überall gesperrt; `credentialStatus` ohne `verify` meldet keine Rechte.
