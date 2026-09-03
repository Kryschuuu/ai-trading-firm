# Changelog — Autonome KI-Trading-Firma

Alle für Nutzer sichtbaren Änderungen werden hier dokumentiert. Das Format folgt
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die Versionierung folgt
[SemVer](https://semver.org/lang/de/).


## [1.36.4] — 2026-09-03 · fix(broker): H3 Live-Order fälschlich als FILLED gemeldet (CRITICAL)

**Kritischer Befund H3 aus dem Senior-Peer-Review (Audit 2026-09-03):**
`BrokerExecutionEngine.submit` (Bitunix-Live-Pfad) meldete eine vom Venue nur
**akzeptierte** Order synchron als `status: "FILLED"` mit `fillPrice: 0`. Eine
Annahme (ACK) ist kein Fill — die nachgelagerte Buchhaltung hätte eine reale
Position mit Entry-Preis **0** übernehmen können.

### Geändert

- **Status-Vertrag (`src/contracts/broker.ts`):**
  `BrokerOrderStatus = "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" |
  "REJECTED" | "UNKNOWN"` — plus Contract-Helfer `isFillStatus()` und
  `isBookableFill()` (nur `FILLED` mit `fillPrice > 0` darf eine Position einbuchen).
  `BrokerOrderResult.filledQty` ergänzt; `BrokerAdapter.reconcileOrder?()` im Interface.
- **`submit()` live (`src/brokers/bitunix/execution.ts`):** liefert ausschließlich die
  AKZEPTANZ — `status: "NEW", fillPrice: 0, reason: "ORDER_ACCEPTED"`. Versandte
  Order-Kontexte (SL/TP/Menge) werden für die spätere Reconciliation vorgehalten.
- **Fill-Reconciliation (H3-Kern):**
  - `BitunixPrivateClient.getOrder(orderId)` → `GET /api/v1/futures/trade/get_order_detail`
    (Status NEW/PART_FILLED/FILLED/CANCELED + tradeQty; `null`, wenn nicht auffindbar).
  - `BitunixPrivateClient.getExecutions(symbol?, orderId?)` →
    `GET /api/v1/futures/trade/get_history_trades` (echte Trades als `BitunixFill[]`).
  - `BrokerExecutionEngine.reconcile(orderId)` baut aus Order-Detail **und** den Trades
    das ECHTE Ergebnis: avgPrice = mengen-gewichteter Mittelwert der Trades; Status
    NEW → PARTIALLY_FILLED → FILLED; CANCELED mit/ohne Teilfills; Order nicht
    auffindbar oder Füllpreis nicht belegbar → **UNKNOWN** (fail-safe, nie FILLED/0).
  - `BitunixBrokerAdapter.reconcileOrder(orderId)` mit denselben Gate/Capability-Prüfungen
    wie `placeOrder`; Paper/Backtest liefern `null` (synchroner Fill).
- **Position-Adoption (`listPositions`):** Venue-Positionen mit `entryPrice ≤ 0` oder
  `qty ≤ 0` werden verworfen — eine Position entsteht nur mit echtem avgPrice.
  Engine (`src/lib/engine.ts`) und Mikro-Executor (`src/lib/microExecutor.ts`) buchen
  Positionen nur noch bei `status === "FILLED"` UND belegtem Preis > 0.
- **Consumer per Switch über das neue Status-Ensemble:** Alpaca `mapOrderResult`
  (akzeptierte Orders sind jetzt NEW statt REJECTED; partial/canceled/unknown),
  Audit-Ansicht (`fillSection`: Töne good/bad/warn + erklärende Hinweise je Status).

### Tests

- `submit()` live → `status:"NEW"`, `fillPrice:0`, gültige `orderId`, `reason:"ORDER_ACCEPTED"`.
- `reconcile()` mappt Venue `PART_FILLED` → `PARTIALLY_FILLED` mit echtem avgPrice (65000).
- `reconcile()` NEW ohne Trades → NEW/0; FILLED ohne belegbaren Preis → UNKNOWN
  (`FILL_PRICE_UNKNOWN`); Order fehlt → UNKNOWN (`ORDER_NOT_FOUND`); CANCELED mit Teilfills.
- Adapter-Live-Pfad: `reconcileOrder` nach Gate-Freigabe; Paper → `null`.
- Bestehende Live-Tests (Fixture-Server, Security-Suite) auf NEW/AKZEPTANZ umgestellt;
  Fixture-Server bedient jetzt auch `get_order_detail`/`get_history_trades`.

Abwärtskompatibel: Paper-/Backtest-Engines füllen synchron und liefern weiterhin `FILLED`.

---

## [1.36.3] — 2026-09-03 · security(audit): Remediation-Plan Senior Peer-Review

**Schweregrad-Mix:** 8× CRITICAL, 8× HIGH, 4× MEDIUM (20 Befunde). **H1 bereits in v1.36.2 gefixt.**

Dieser Eintrag dokumentiert den **Remediation-Plan** (keine Code-Behaviour-Änderung in diesem Release
außer Docs/Tests). Jeder Befund hat eine eigene, self-contained Arena-Prompt-Datei unter
`audit-remediation/<ID>-<slug>.md`, die den Fix 1:1 ausführbar beschreibt.

### Befunde & Status (validiert gegen `main` @ a29e956)

| ID | Bereich | Severity | Status (validiert) | Prompt |
| --- | --- | --- | --- | --- |
| H1 | Handelslogik | CRITICAL | ✅ bereits gefixt (v1.36.2) | `audit-remediation/H1-risk-notional.md` |
| H2 | Handelslogik | CRITICAL | ⚠️ teilweise (keine verteilte Atomarität) | `audit-remediation/H2-atomicity.md` |
| H3 | Handelslogik | CRITICAL | ✅ valide | `audit-remediation/H3-order-status.md` |
| H4 | Handelslogik/Broker | CRITICAL | ✅ valide | `audit-remediation/H4-idempotency.md` |
| H5 | Handelslogik | CRITICAL | ✅ valide | `audit-remediation/H5-pipeline-trading.md` |
| H6 | Handelslogik | CRITICAL | ✅ valide | `audit-remediation/H6-approval-chain.md` |
| H7 | Handelslogik/Control | HIGH | ✅ valide (architektonisch) | `audit-remediation/H7-live-kill.md` |
| H8 | Brokers/Venues | HIGH | ✅ valide | `audit-remediation/H8-bitunix-equity.md` |
| H9 | Handelslogik | HIGH | ✅ valide | `audit-remediation/H9-finite-guardrails.md` |
| H10 | Handelslogik | HIGH | ✅ valide | `audit-remediation/H10-adaptive-failopen.md` |
| W1 | Workshop | HIGH | ✅ valide | `audit-remediation/W1-localstorage.md` |
| W2 | Workshop | MEDIUM | ✅ valide | `audit-remediation/W2-prompt-versioning.md` |
| C1 | Control Panel | HIGH | ✅ valide | `audit-remediation/C1-open-mode.md` |
| C2 | Control Panel | MED/HIGH | ✅ valide | `audit-remediation/C2-forwarded-ip.md` |
| C3 | Control Panel | HIGH | ✅ valide | `audit-remediation/C3-kill-disarm.md` |
| C4 | Control Panel | MEDIUM | ✅ valide | `audit-remediation/C4-control-state-persistence.md` |
| B1 | Brokers/Venues | HIGH | ✅ valide | `audit-remediation/B1-sl-tp-geometry.md` |
| B2 | Brokers/Venues | MEDIUM | ✅ valide | `audit-remediation/B2-side-fallback.md` |
| S1 | Sonstiges | MEDIUM | ✅ valide | `audit-remediation/S1-audit-reliability.md` |
| S2 | Sonstiges | MEDIUM | ✅ valide (architektonisch) | `audit-remediation/S2-singleton-consistency.md` |

### Empfohlene Abarbeitungsreihenfolge

1. **Fail-closed-Härtung (CRITICAL):** H3, H4, H5, H6, H9
2. **Broker/Venue-Korrektheit:** H8, B1, B2
3. **Control-Plane-Sicherheit:** C1, C2, C3, C4, S1
4. **Architektur/Live-Bereitschaft:** H2, H7, H10, S2
5. **Workshop:** W1, W2

Siehe `docs/AUDIT_REMEDIATION_2026-09.md` für den vollständigen Plan und `audit-remediation/README.md`
für den Index.

---

## [1.36.2] — 2026-09-02 · fix(broker): H1 Risk-Notional ≠ tatsächliche Ausführungskosten (CRITICAL)

**Schweregrad CRITICAL, gemeldet:** Handelslogik — `Order.riskNotional` (qty×Preis) wurde als
vertrauenswürdige Eingabe für `validateOrder({ notional: riskNotional })` und den Cash-Guard
(`riskNotional > cash*maxLeverage`) verwendet, während die tatsächliche Abbuchung
`qty×Fillpreis + Gebühren` betrug (Legacy: `price*1.001` / `price*0.999`; Simulator:
`FillSimulator` mit Spread, Slippage, Gebühren, Latenz, Partial Fills, vgl. `docs/PAPER_TRADING.md` §3).
Ein manipulierter Client konnte `riskNotional=1` bei `qty=1000` senden, den Guard passieren und
anschließend ein Vielfaches des geprüften Kapitals binden. Beispiel Report: `riskNotional=2500`,
Fill +0.1% Slippage + Gebühren → tatsächliche Kosten >2500, Guard wird umgangen.

### Fixed

* **`src/lib/broker.ts` (`PaperBroker.submit`)** — vor allen Guardrails:
  ```ts
  const estimatedNotional = order.qty * price;
  if (!Number.isFinite(estimatedNotional) || estimatedNotional <= 0)
    return reject("INVALID_ESTIMATED_NOTIONAL");
  ```
  Guardrails nutzen ausschließlich `estimatedNotional`:
  `validateOrder({ notional: estimatedNotional, equity, ... })`.
  Vorab-Cash-Schätzung `requiredCash = estimatedNotional + 0.1% Slippage + Gebühren`
  (Legacy: exakt `qty*fillPrice`; Simulator: konservativ 0.1%), fail-fast.
  **Exakter, verbindlicher Cash-Check nach Simulation:**
  * Simulator-Pfad: `cost = filledQty*fillPrice + fees` → `cost > cash*maxLeverage ? INSUFFICIENT_CASH`
    (mit Detail `Fill qty×Preis + Gebühren`).
  * Legacy-Pfad: `cost = qty*fillPrice` → analog, inkl. 0.1% Slippage.
  Damit ist die gebundene Summe nie größer als geprüft; inkonsistentes `riskNotional`
  (z. B. 1 bei 1000 Einheiten) führt zu `INVALID_ESTIMATED_NOTIONAL` bzw. Guard-Block.

* **`src/brokers/bitunix/paper.ts` / `src/brokers/alpaca/paper.ts` (Paper-Ledger)** —
  analog: `estimatedNotional = qty * ticker.price`, validiert, Guard mit
  `estimatedNotional`, Vorab-Cash `requiredCash ≈ estimatedNotional+0.1%` (fail-fast),
  exakter Check `cost = filledQty*fillPrice+fees > cash`.

* **`src/brokers/bitunix/execution.ts` (`BrokerExecutionEngine`)** — Live-Pfad:
  ```ts
  const estimatedNotional = qty * ticker.price;
  // Guard gegen echte Konto-Equity/Cash (Private-API), fail-closed
  const guard = validateOrder({ notional: estimatedNotional, equity: account.equity, ... });
  if (requiredCashEstimate > account.cash) reject(INSUFFICIENT_CASH);
  ```
  Zusätzlich Kill-Switch + `INVALID_*`-Validierung vor jeder Venue-Order; keine
  Order erreicht die Venue ohne belegbare Equity.

* **`src/brokers/alpaca/execution.ts` (`BrokerExecutionEngine`)** — zuvor fehlte
  jegliche Guardrail-Prüfung im Live-Pfad (nur Kill-Switch). Jetzt identisch zu
  Bitunix: server-seitige `estimatedNotional`-Berechnung, `validateOrder` gegen
  echte Konto-Equity, Cash-Puffer 0.2% (Slippage+Gebühren), fail-closed bei
  Konto-Abruf-Fehler. Import `validateOrder` ergänzt. Live-Order trifft nun
  3 Private-Calls (Account+Positions+Order) statt 1 — im Test explizit erwartet.

* **Keine Breaking Changes im API-Contract:** `BrokerOrderRequest.riskNotional`
  bleibt Pflichtfeld (`finite>0`), ist aber nur Hinweis. Die Engine
  (`src/lib/engine.ts`: `notional = missionSizedNotional(...)`, `qty = notional/price`)
  erzeugt konsistente Paare, daher lauffähig ohne Änderung.

### Tests

* **`tests/broker.test.ts`** — H1-konsistente Orders: Default BTC qty `0.015` (≈1005,
  <2500 Cap) statt `0.1` (6700 → wäre jetzt korrekterweise REJECTED); Oversized-Test
  via `qty=0.5` (33500) statt nur `riskNotional`; `closeAll` mit konsistenten
  `qty/riskNotional` je Symbol; Positions-Qty-Assertion angepasst.
* **`tests/brokerContracts.test.ts`** — PAPER-Fill qty `0.015` (1005) statt `0.1`
  (H1 Guard würde sonst REJECTED liefern).
* **`tests/bitunix.security.test.ts`** — Oversized-Order via `qty=0.1` (6000) statt
  nur `riskNotional` (H1: Guard ignoriert client-seitiges riskNotional).
* **`tests/alpaca.adapter.test.ts`** — Live-Gate-OPEN: `privateCalls` 3 statt 1
  (neue Guardrails gegen echte Cash/Equity brauchen Account+Positions).

Alle **1352 Tests** grün; `typecheck`, `lint`, `build` grün; `docs:validate` grün.

### Changed / Docs

* `package.json` → **1.36.2** (PATCH).
* `docs/PAPER_TRADING.md` §3: Hinweis, dass Notional server-seitig aus `qty*Preis`
  neu berechnet wird und der Cash-Guard `requiredCash = Notional+Gebühren+Slippage`
  prüft (H1).
* `docs/BROKER_ARCHITECTURE.md` § „Ausführungsschleuse“ (Paper & Live): H1-Hinweis
  — `riskNotional` ist nur Hinweis, Ausführungsschleuse nutzt `estimatedNotional`.
* `docs/SECURITY_AUDIT.md`: neuer Eintrag H1 (CRITICAL, Ort, Beispiel, Fix).

### Migration

Kein Schema-Bruch, keine neuen Pflicht-Env-Variablen. Opt-in unverändert. Deploy:
`git pull` → `npm ci` → `npx drizzle-kit push` (no-op) → `npm run build` →
`sudo systemctl restart ai-trading-firm` → `rm -rf .next` (Build-Cache-Tipp aus 1.36.1).

## [1.36.1] — 2026-09-02 · fix(engine): robuster Duck-Type-Check für PAPER-Adapter

Runtime-Bug auf dem Livesystem (192.168.0.10): Scheduler-Tick schlug fehl mit
`UNEXPECTED_BROKER_ADAPTER: PAPER-Adapter erwartet`. Ursache war ein
`instanceof PaperBrokerAdapter`-Check in `src/lib/engine.ts`, der nach dem
Alpaca-Volladapter (v1.36.0) durch Next.js-Modul-Recompilierung einen anderen
Klassenmodul-Identifier lieferte — `instanceof` wurde `false`, obwohl der
Adapter technisch ein `PaperBrokerAdapter` war.

### Warum `instanceof` hier falsch war

Der `instanceof`-Operator vergleicht die Prototyp-Kette eines Objekts mit dem
`prototype`-Property einer **spezifischen Klassenreferenz**. In Next.js mit
Turbopack/Webpack wird jedes Modul bei jedem Build neu kompiliert — die Klasse
`PaperBrokerAdapter` in `src/brokers/paper.ts` bekommt jedes Mal eine neue
Identität im Speicher. Die Factory `createBroker("PAPER", "paper")` instanziiert
die Klasse aus dem gerade geladenen Modul, aber die `engine.ts` hält eine
Referenz auf die Klasse aus ihrem eigenen Modul-Scope. Nach einem Hot-Reload
oder wenn die Build-Caches driften, zeigen diese beiden Referenzen auf
unterschiedliche `prototype`-Objekte — `instanceof` wird `false`, obwohl es sich
um dieselbe Klasse handelt.

Dieses Problem tritt besonders auf, wenn:
- Neue Adapter-Module hinzukommen (wie v1.36.0 mit dem Alpaca-Adapter),
- `BROKER_VENUE_IDS` erweitert wird,
- Next.js den Build-Cache partially invalidiert und neu kompiliert,
- Turbopack Module in anderer Reihenfolge lädt.

### Warum Duck-Type besser ist

Der Duck-Type-Check prüft nur, ob das Objekt die **Struktur** eines
`PaperBrokerAdapter` hat — konkret das Feld `paperBroker`. Das ist:
- **Build-Cache-resistent:** Die Feld-Namen ändern sich nicht bei der
  Compilierung.
- **Unabhängig von Modul-Identität:** Es spielt keine Rolle, aus welchem
  Modul-Scope die Klasse stammt.
- **Minimal-invasiv:** Kein neuer Typ, keine neue Abstraktion — nur eine
  Typanpassung (`as unknown as { paperBroker?: PaperBroker }`).
- **Typsicher:** TypeScript erzwingt weiterhin die Typsicherheit über
  `PaperBroker`.

Nachteil: Duck-Type ist weniger streng als `instanceof` — ein Objekt mit einem
`paperBroker`-Feld, das kein echter `PaperBrokerAdapter` ist, würde den Check
bestehen. In der Praxis ist das irrelevant, weil die Factory garantiert den
richtigen Adapter liefert.

### Fixed

* **`src/lib/engine.ts`:** `instanceof PaperBrokerAdapter` ersetzt durch Duck-Type-
  Check (`adapterAny.paperBroker !== undefined`). Fehlermeldung präzisiert:
  `UNEXPECTED_BROKER_ADAPTER: PAPER-Adapter erwartet (paperBroker fehlt)`.
* **Import bereinigt:** `PaperBrokerAdapter`-Import aus `engine.ts` entfernt
  (nicht mehr nötig).

### Workaround für Betreiber

**Vor jedem Update den Build-Cache löschen:**

```bash
rm -rf .next node_modules/.cache
```

Das beugt dem `instanceof`-Problem grundsätzlich vor — nicht nur für den
PAPER-Adapter, sondern auch für andere Adapter (Bitunix, Alpaca), falls in der
Zukunft ähnliche Checks hinzukommen. Das Update-Kapitel in `docs/INSTALL.md`
(Kapitel 12) wurde entsprechend erweitert.

### Changed

* `src/lib/engine.ts` — `getBroker()` verwendet Duck-Type statt `instanceof`.
* `package.json` — Version **1.36.1** (PATCH, abwärtskompatibel).
* `docs/INSTALL.md` — Kapitel 12 (Updates) um Cache-Clear-Schritt erweitert.

### Tests

* Alle **1352 Tests** bleiben grün (typecheck, lint, build, docs:validate).
* Keine neuen Tests nötig — der Bug war ein Runtime-Problem, kein Logik-Fehler.


## [1.36.0] — 2026-09-01 · feat(broker): Alpaca-Volladapter (8. Venue, US-Aktien/ETFs/Crypto)

**Ausgangslage.** Das System kannte sieben Venues — Bitunix als realer
Volladapter (Perpetuals, Modus B), PAPER für Tests sowie fünf Stubs
(ALPACA, IBKR, BINANCE, KRAKEN, DYDX). Für US-Aktien und ETFs gab es keine
reale Anbindung; wer mit Alpaca handeln wollte, fand nur einen Stub, der
ehrlich `NotSupportedCapabilityError` warf. Mit dem neuen Alpaca-Adapter
rückt eine regulierte, vollständig dokumentierte Broker-API in den
verfügbaren Venue-Pool — als zweiter realer Volladapter neben Bitunix,
weiterhin hinter dem zentralen Live-Gate (Task 11) und mit derselben
Audit-Lehre wie Bitunix 1.35.1: keine ungeprüften Schutzketten.

### Added

* **Volladapter `src/brokers/alpaca/`** (16 Dateien) — Pattern vollständig
  analog zu Bitunix:
  - `config.ts`: Public/Trade-Config-Loader mit `ALPACA_ENABLED`/
    `ALPACA_LIVE_ENABLED`/`ALPACA_USE_LIVE_ENDPOINTS`/`ALPACA_RETRY_MAX`/
    `ALPACA_ALLOW_INSECURE_HTTP`/`ALPACA_PAPER_DATA_HOST` u. a.; Default
    zeigt auf die offizielle Paper-Endpoint-Gruppe.
  - `http.ts`: `AlpacaHttp` + `TokenBucket` (Public- und Private-Endpoint,
    getrennte Rate-Budgets), TLS erzwungen, Loopback-Ausnahme für Tests,
    Host-Allowlist (SSRF), begrenzter Retry/Backoff, **kein Retry für
    nicht-idempotente Requests** (POST `placeOrder`) — Idempotenz wird über
    `client_order_id` aus BrokerOrderRequest-Symbol+Qty+Side+Timestamp
    hergestellt.
  - `publicClient.ts`: `fetchTicker`, `fetchCandles` (Bars v2) — bewusst
    credential-frei (Auth-Header nur bei explizitem Bedarf, getestet).
  - `privateClient.ts`: Basic-Auth, Account/Positions/Assets/Order; jeder
    Private-Call auditiert (`ALPACA_PRIVATE_CALL`, Methode/Pfad/Outcome,
    keine Keys/Body/Query).
  - `secrets.ts`: `SecretStore` mit Env-Fallback (`ALPACA_API_KEY`/
    `ALPACA_API_SECRET`), analog zu Bitunix, deterministische
    Redaction-Befüllung im selben Schritt wie das Laden.
  - `mapping.ts`: `mapAsset`/`mapAssets` (Alpaca-Asset → `MarketInstrument`,
    `class="us_equity" → "equity"`, `class="crypto" → "crypto"`,
    Crypto-Symbole `BTC/USD` mit Base/Quote-Split) plus `mapBar`/
    `mapBars`, `mapOrderResult`, `mapPosition`, `mapAccount`.
  - `orders.ts`: `serializePlaceOrder` + `makeClientOrderId` (Broker-Order
    + Idempotenz-Key), `OrderSerializationError` mit klarem Code.
  - `redactor.ts`: `createAlpacaLogger` + `redactAlpaca` (maskiert
    `apiKey`/`apiSecret`/Header/Body-Quoting).
  - `errors.ts`: `AlpacaApiError` (Code `auth|rate-limit|payload|...`),
    `AlpacaDisabledError`, `safeSnippet`, `classifyAlpacaFailure`.
  - `gates.ts`: `assertAlpacaEnabled(env)` (Default aus), `assertLiveOrderAllowed`
    (delegiert an Live-Gate), `snapshotAlpacaLiveGate`.
  - `paper.ts`: `AlpacaPaperLedger` mit `submit`/`getAccount`/`listPositions` —
    vollständige Guard-Sequenz **vor** der Fill-Simulation:
    `killSwitch` (prozessweit) → Input-Validierung → `validateOrder`
    (Notional, Equity, Side, Leverage, Pflicht-Stop) → Fill-Simulator
    (zentral, mit `filledQty`/Fees) → Cash-Check → Position-Update.
    Reject-Pfade liefern maschinenlesbare Codes (`KILL_SWITCH_ARMED`,
    `INVALID_QTY`, `NO_QUOTE:…`, `INVALID_STOP_LOSS`, Guardrail-Block).
  - `execution.ts`: `ExecutionPort` mit `PaperExecutionEngine` (Ledger,
    Modus `paper`) und `BrokerExecutionEngine` (signierter Private-Client,
    Modus `live`); `submit` führt Kill-Switch-Prüfung **vor** dem Senden,
    nutzt den privaten Account-Abruf nicht für Guardrails (Ledger-
    Equity=0 würde Live-Orders blockieren — Live validiert via echtes
    Konto).
  - `audit.ts`: synchroner In-Memory-Ring (max. 200) für
    `ALPACA_PRIVATE_CALL`, best-effort `audit_log`-Persistenz
    (Event `ALPACA_PRIVATE_CALL`, kein Stacktrace/keine Secret-Header).
  - `adapter.ts`: `AlpacaBrokerAdapter implements BrokerAdapter`
    (`id = "ALPACA"`), `AlpacaAdapterDeps` mit `publicConfig`/`tradeConfig`/
    `publicClient`/`privateClient`/`secretStore`/`logger`/`registry`/
    `paper`/`now`. `credentialStatus({verify?})` ist ehrlich: ohne
    `verify` → `permissions: []`, `connected: false`,
    `permissionsVerified: false`; mit `verify` → erfolgreicher
    Account-Abruf = `connected: true`, `permissions: ["READ"]`,
    `permissionsVerified: true` (keine `["READ","TRADE"]`-Behauptung
    ohne Beleg). `healthCheck({remote?})` ohne `remote` netzwerkfrei;
    mit `remote` credential-frei nur auf Public-Endpoint.
    `discoverInstruments()` nutzt den Private-Endpoint, upserted in die
    Registry (`source: "discovery:alpaca"`). `execution()`-Pfad
    prüft `tradeCfg.usePaperEndpoints` (nicht `publicCfg`) im Testnet,
    um Live-Endpoint + Testnet-Modus-Kombination zu verbieten
    (Defense in Depth).
  - `index.ts`: vollständige Re-Exports.
* **Capabilities** (`src/brokers/capabilities.ts`):
  `VENUE_CAPABILITIES.ALPACA` = `{ discovery: true, marketData: true,
  trading: true, paper: true, testnet: true, live: true,
  instrumentTypes: { spot: true, perpetual: false, future: false,
  option: false, cfd: false }, stopAtVenue: true }` — `testnet: true`,
  weil Alpacas offizielle `paper-api.alpaca.markets` ein vollständiges
  Testnet ist (eigener Endpoint, separate Credentials, eigenes
  Geld-Limit). Bitunix bleibt ohne `testnet` (kein offizielles Testnet).
* **Factory/Contracts/Adapter-Catalog**:
  - `BROKER_VENUE_IDS` enthält `ALPACA` (28er-Matrix).
  - `createAdapter("ALPACA", mode)` instanziiert den neuen Adapter;
    `STUB_ADAPTER_VENUES` enthält ALPACA **nicht** mehr.
  - `contracts/broker.ts` `BrokerVenueId` enthält `ALPACA`.
  - `AlpacaBrokerAdapter` ist in `src/brokers/index.ts` re-exportiert.
* **Live-Gate** (`src/live-gate/enforcer.ts`): zentral, Venue-Flag
  `ALPACA_LIVE_ENABLED` (`venueLiveFlagName("ALPACA")`); Standard-Pfad
  bleibt `LiveTradingGateError` bis Suite-Stamp + Flags + Control Plane
  freigeben.
* **Coverage** (`src/brokers/coverage.ts`): Headline jetzt **2 / 2 / 0**
  (zwei reale externe Venues mit voller Coverage: BITUNIX + ALPACA; beide
  mit Live-Execution deaktiviert). Testnet-Coverage = `["ALPACA"]`
  (BITUNIX hat kein offizielles Testnet). `brokerCoverage.api.test.ts`
  und `brokerCoverage.test.ts` mitgezogen.
* **Tests (122 Alpaca-spezifisch, 13 Factory, 42 Cross-Broker-Contract,
  10 Coverage, 2 Coverage-API)**:
  - `tests/alpaca.unit.test.ts` (22) — Mapping (Asset/Crypto/Filter),
    Orders (Idempotenz, Client-Order-Id, Serization), Errors
    (Klassifikation, safeSnippet), Audit-Ring, Bar-Mapping (NaN-Filter,
    Epoch-ms), `mapBars(null)`, `drawdownPct`-Logik.
  - `tests/alpaca.adapter.test.ts` (17) — Paper-E2E (Discovery → Ticker →
    Order, 0 Private-Calls, Modus B), `ALPACA_ENABLED=false` (alle
    Capability-Methoden werfen `AlpacaDisabledError`), Live-Gate
    `STATE_NOT_LIVE_ENABLED`, Live-Gate OFFEN nutzt Broker-Engine
    (1 Private-Call, Venue-OrderId), Public-Client credential-frei,
    `privateClient` ohne Credentials → `NotSupportedCapabilityError`,
    Capabilities-Spiegel, `getOrderBook` nicht unterstützt,
    `credentialStatus` ohne/mit verify (0/1 Private-Calls), Basic-Auth
    Header korrekt gesetzt, Paper-Ledger Reject-Pfade
    (`KILL_SWITCH_ARMED`, `INVALID_QTY`, `NO_QUOTE`, `INVALID_STOP_LOSS`,
    Guardrail ohne Stop), ExecutionPort-Separation
    (`PaperExecutionEngine` vs `BrokerExecutionEngine` mit Fake-Client),
    `ALPACA_PRIVATE_CALL`-Audit, `basicAuthHeader`-Format, Secret-Scan
    über `src/brokers/alpaca/**` (kein Klartext-Key in `console.*`),
    Testnet-Mismatch-Schutz.
  - `tests/brokerFactory.test.ts` (13) — 28er-Matrix (7×4), Capability-
    Gating, Fehlerklassen, kein stiller Fallback, Audit-Vollständigkeit,
    PAPER-Singleton, Defense in Depth.
  - `tests/brokerContracts.test.ts` (42) — `ALPACA → AlpacaBrokerAdapter`,
    `ALPACA → AlpacaDisabledError` (Trading/MarketData/Discovery/
    Konsistenz), Audit-Katalog-Eintrag, parallele Verträge für alle
    acht Venues.
  - `tests/brokerCoverage.test.ts` (10) / `brokerCoverage.api.test.ts` (2)
    — Headline 2/2/0, Discovery/MarketData/Paper = `["ALPACA","BITUNIX",
    "PAPER"]`, Testnet = `["ALPACA"]`.
* **Audit-Katalog** (`src/lib/auditView.ts`): `ALPACA_PRIVATE_CALL`-
  Eintrag analog `BITUNIX_PRIVATE_CALL` (Label „Alpaca-Privat-API",
  erwartetes Level INFO, deutsche Beschreibung, Sektion „Privater Call"
  mit Methode/Pfad/Ergebnis/Fehlercode, niemals Body/Query/Key).
* **Modus C** (`src/lib/marketdata/manager.ts` + `marketdata.modes.test.ts`):
  `VENUE_CAPABILITIES.ALPACA.testnet = true` ⇒ `PAPER_MODE=broker-paper-api`
  ist mit `PAPER_BROKER_API_VENUE=ALPACA` wählbar; Test „kein Venue
  unterstützt Modus C" wurde auf den Negativ-Fall (z. B. IBKR) verengt
  und um den Positiv-Test „ALPACA + Modus C ohne Fehler" ergänzt.

### Changed

* `src/lib/auditView.ts` — neuer Katalogeintrag `ALPACA_PRIVATE_CALL`
  (analog `BITUNIX_PRIVATE_CALL`).
* `tests/marketdata.modes.test.ts` — Modus-C-Test auf den korrekten
  Negativ-Venue (IBKR) verengt + ALPACA-Positivfall.
* `tests/brokerContracts.test.ts` — `ALPACA`-Branch in jedem
  Vertragstest (Adapter-Instanz, `AlpacaDisabledError`).
* `tests/brokerCoverage.test.ts` / `brokerCoverage.api.test.ts` —
  Headline 2/2/0, Testnet-Liste enthält nur `ALPACA`.

### Security

* `credentialStatus` ohne `verify` meldet keine Rechte — die in 1.35.1
  für Bitunix nachgezogene Lehre wird für Alpaca von Anfang an
  umgesetzt.
* `BrokerExecutionEngine.submit` prüft `killSwitch` vor dem Senden;
  `AlpacaPaperLedger.submit` führt dieselbe Prüfung + `validateOrder`
  gegen das Paper-Ledger. Live-Broker validiert via echtes Konto,
  nicht gegen das lokale Ledger (Equity=0 würde sonst Live-Orders
  blockieren).
* `AlpacaHttp.request` verweigert Retry für nicht-idempotente POSTs
  (`placeOrder`); nur 429 bleibt retry-fähig — keine Doppel-Order-Gefahr
  bei Timeout/5xx.
* Live-Pfad strikt hinter Live-Gate (`assertLiveOrderAllowed`); der
  Testnet-Mismatch verhindert versehentliche Live-Endpoints im
  Testnet-Modus.
* `redactAlpaca` maskiert `apiKey`/`apiSecret`/Header/Body-Quoting;
  Secret-Scan im Test (kein Klartext-Key in `console.*`).
* Public-Client credential-frei, Auth nur wenn nötig (durch Tests
  gegen Fixture-Server verifiziert: Public-Calls haben `authed: false`).
* Audit-Einträge (`ALPACA_PRIVATE_CALL`): nur Methode, Pfad, Outcome,
  Fehlercode — keine Body/Query/Key/Signatur.

### Migration

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

**Test-Stand:** `npm test` 1352/1352 grün; `npm run typecheck`, `npm run
lint`, `npm run build`, `npm run docs:validate` grün.

## Versionierungsrichtlinie

| Versionsstelle | Bedeutung | Beispiel |
| --- | --- | --- |
| **MAJOR** (1.x.y) | Breaking Changes: DB-Schema-Brüche, entfernte Env-Variablen, neue Pflichtkonfiguration | 2.0.0 |
| **MINOR** (x.1.y) | Neue Features (z. B. Provider), abwärtskompatibel | 1.2.0 |
| **PATCH** (x.y.1) | Bugfixes und Sicherheits-Fixes, abwärtskompatibel | 1.1.1 |

* Die Version steht in `package.json` (`"version"`) und wird von `/api/health`
  (`"version"`) und `/api/firm` (`"version"`) ausgeliefert.
* Empfohlene Deploy-Kette: `git pull` → `npm ci` → `npx drizzle-kit push` →
  `npm run build` → `sudo systemctl restart ai-trading-firm`.
* Migrationshinweise stehen in der jeweils betroffenen Release-Sektion.

---


## [1.35.2] — 2026-09-01 · fix(marketdata): Ticker-Lücken-Fallback — Bulk-Lücken nie still als „enriched"

**Ausgangslage.** Zwei Integrationstests (`test/integration/cli-sync-e2e.test.ts`,
`test/marketdata/adapters/bitunix.test.ts`) schlugen fehl, weil sie eine
Semantik kodieren, die `enrichWithTickers()` nicht implementierte: Fehlte ein
Symbol in der Bulk-Ticker-Response, zählte der Sync es trotzdem als
„enriched" (`tickersEnriched` = alle Instrumente), meldete keinen Fehler und
der Lauf galt als sauber (`degraded: false`, Exit-Code 0) — die Datenlücke
wurde kaschiert statt transportiert. Ein Unit-Test
(`src/marketdata/__tests__/sync.test.ts`) schrieb diese alte Semantik sogar
fest („P1: kein per-Symbol-Fallback"). Die Integrationstests beschreiben das
ehrlichere Verhalten und decken sich mit der dokumentierten Philosophie
(„Unbekannte Werte werden als Data-Quality-Zustand transportiert, nicht
kaschiert") — deshalb wurde die Implementierung nachgezogen, nicht die Tests.

### Fixed

* **Lücken-Fallback in `enrichWithTickers()`** — `src/marketdata/enrichment.ts`:
  Fehlt ein Symbol in der Bulk-Response, wird es genau **einmal** per
  Einzel-Ticker versucht — mit demselben Symbol-Guard wie der No-Bulk-Pfad
  (kein Fremd-Volumen). Schließt auch das die Lücke nicht, entsteht ein
  sichtbarer `failure` (`stage: "ticker"`), der Lauf gilt als degradiert und
  das CLI beendet mit Exit-Code 1. `tickersEnriched` zählt damit nur noch
  Instrumente mit tatsächlich beschafftem Ticker.
* Der gemeinsame Einzel-Ticker-Pfad (Symbol-Guard, Fehlerbehandlung) ist in
  einen Helper zusammengeführt — Bulk-Lücken und No-Bulk-Venues verhalten
  sich identisch.

### Changed

* **Zwei Unit-Tests an die ehrliche Semantik angepasst** (bewusst, mit
  Begründung im Test): `sync.test.ts` („Batch unvollständig") erwartet jetzt
  den Lücken-Fallback statt ihn zu verbieten — plus neuer Negativfall
  (Fallback scheitert → sichtbarer failure, `tickersEnriched` zählt die Lücke
  nicht); `test/marketdata/enrichment.test.ts` prüft beide Zweige
  (Fallback schließt die Lücke / failure statt Exception).

### Docs

* `docs/MARKET_DATA_PIPELINE.md` (Ticker-Stage: Lücken-Fallback + degradierter
  Lauf statt stiller Lücke).

**Damit sind alle 1521 Tests grün** — inklusive der zwei zuvor fehlschlagenden
Integrationstests, die in 1.35.1 als vorbestehend dokumentiert wurden.

---


## [1.35.1] — 2026-09-01 · fix(broker): Sicherheits-Härtung des Bitunix-Live-Pfads (Audit-Nacharbeit)

**Ausgangslage.** Ein Audit der Broker-Anbindung fand vier Lücken im
Bitunix-Live-Pfad: (1) `BrokerExecutionEngine.submit` importierte `riskGuard`
überhaupt nicht — weder Kill-Switch noch Code-Guardrails standen vor einer
echten Order; (2) der HTTP-Transport wiederholte bei Timeout/Netzwerkfehler/5xx
unabhängig von der Methode — für den `place_order`-POST eine
Doppel-Order-Gefahr; (3) es existierten zwei voneinander unabhängige Not-Halte
(`riskGuard.killSwitch` via `/api/firm/kill` und die dateibasierte
Live-Gate-Kill-Sperre) — der zentrale Enforcer prüfte nur die Datei, der
Firmen-Not-Halt hätte eine Live-Order also nicht gestoppt; (4)
`credentialStatus()` behauptete `permissions: ["READ","TRADE"]` allein aus der
Existenz von Credentials, und die Redaction-Liste des Loggers wurde per
Fire-and-Forget befüllt (Timing-Fenster, in dem nur musterbasierte Maskierung
griff). Nichts davon war ausnutzbar, solange Live hart gesperrt ist — es sind
aber genau die Sperren, die im Moment einer Live-Freischaltung greifen müssen.

### Fixed

* **Schutzkette vor jeder Live-Order** — `src/brokers/bitunix/execution.ts`:
  `BrokerExecutionEngine.submit` prüft jetzt unmittelbar vor dem Senden den
  prozessweiten `killSwitch` und `validateOrder` gegen die **echte**
  Konto-Equity und die echten offenen Positionen der Venue. Fail-closed:
  scheitert der Konto-Abruf, wird nicht gesendet. Parität zum Paper-Ledger.
* **Kein Retry für `place_order`** — `src/brokers/bitunix/http.ts` +
  `privateClient.ts`: neues `idempotent`-Flag im Transport (Default: GET
  idempotent, POST nicht). Nicht-idempotente Requests brechen bei
  Timeout/Netzwerkfehler/5xx laut ab statt eine zweite Order zu riskieren;
  nur HTTP 429 (definitiv nicht verarbeitet) bleibt Retry-fähig.
* **Kill-Switch-Zweiteilung geschlossen** — `src/live-gate/enforcer.ts`:
  Bedingung 3 prüft jetzt wie dokumentiert **beide** Sperren — den
  prozesslokalen `riskGuard.killSwitch` (`/api/firm/kill`, Auto-Kill bei
  Drawdown/Tagesverlust) **und** die persistente Failsafe-Datei. Deny-Code
  in beiden Fällen `KILL_SWITCH_ACTIVE`.
* **`credentialStatus()` ehrlich gemacht** — `src/brokers/bitunix/adapter.ts` +
  `types.ts`: drei getrennte Aussagen statt einer Behauptung — `configured`
  (hinterlegt), `connected` (read-only Abruf gelang, nur mit `verify: true`),
  `permissionsVerified` (geprüft statt angenommen). Ohne `verify` wird kein
  Recht gemeldet; mit `verify` maximal `READ` — Bitunix' Account-Antwort weist
  keine Handelsberechtigung aus, `TRADE` ließe sich nur per echter Order
  belegen. Der Health-Check bleibt ohne `remote` netzwerkfrei.
* **Deterministische Logger-Redaction** — `adapter.ts`: Fire-and-Forget-Befüllung
  durch einen synchronen Credential-Cache ersetzt (`loadCreds()` ist der einzige
  Weg, auf dem Klartext-Credentials in den Adapter gelangen, und befüllt im
  selben Schritt die Maskierliste). Kein Timing-Fenster mehr.

### Tests

* Neu: `tests/bitunix.security.test.ts` — 7 Regressionen: Kill-Switch stoppt
  die Live-Engine vor dem Senden; Guardrails rechnen gegen die echte Equity
  (Positionsgröße, Pflicht-Stop); fail-closed bei scheiterndem Konto-Abruf;
  kein Retry eines nicht-idempotenten POST bei 5xx/Netzwerkfehler (je exakt
  1 Versuch), 429 und GET bleiben Retry-fähig; Enforcer verweigert mit
  `KILL_SWITCH_ACTIVE` bei armiertem Firmen-Not-Halt; `credentialStatus`
  meldet ohne Verifikation keine Rechte und maskiert Credentials deterministisch.
* Angepasst (nicht überschrieben): `tests/bitunix.adapter.test.ts` zählte
  `calls.getAccount === 1`; die Guardrail-Vorprüfung ruft das Konto legitim
  zusätzlich ab → `>= 1` mit Begründung. Die geprüfte Aussage („Live nutzt den
  Private-Client, nicht das Paper-Ledger") ist unverändert.

### Docs

* `docs/BITUNIX.md` §5/§7 (Schutzkette, Retry-Semantik, ehrliche
  Credential-Projektion), `docs/LIVE_TRADING.md` §5 (beide Not-Halte).

---


## [1.35.0] — 2026-08-31 · feat(workshop): Missions-Baukasten — Markt-Scans, Segmente, Vorlagen

**Ausgangslage.** Eine Mission hatte genau ein Symbol (`missions.symbol`).
Aufträge wie „scanne alle Märkte“, „nur Penny Stocks“ oder „nur Indizes“ ließen
sich nicht ausdrücken: Die beiden Multi-Asset-Mandate des Seeds standen mit
`symbol = NULL` in der Datenbank, die Engine musste raten
(`mission.symbol ?? "SPY"`), und die UI bot kein Feld dafür an. Es gab keine
Vorlagen — jede Mission entstand als Freitext.

### Added

* **Missions-Typ (`MissionScope`)** — `src/lib/missionTemplates.ts`:
  `SINGLE_SYMBOL` (Symbol Pflicht, Verhalten exakt wie vor 1.35.0) und
  `SCAN_UNIVERSE` (Segment Pflicht). Persistiert in der neuen Spalte
  `missions.scope` mit Default `SINGLE_SYMBOL`.
* **Neun Marktsegmente** — `ALL`, `INDICES`, `CRYPTO`, `EQUITIES`, `FX`,
  `COMMODITIES`, `PENNY`, `VOLATILE`, `LIQUID`. Jedes Segment besteht aus einer
  `InstrumentQuery` für die Registry plus optionalem Zusatzfilter, einer
  menschenlesbaren `rule` (identisch im Prompt), einer Kandidaten-Obergrenze
  (8–12), Risikovorschlägen innerhalb der Code-Deckel und Drei-Ebenen-Hilfe.
  Neue Spalte `missions.segment`.
* **Missions-Universum** — `src/lib/missionUniverse.ts`:
  `resolveSegmentInstruments()` (Registry-Query + Filter),
  `rankCandidateSymbols()` (kanonisieren, Venue-Duplikate zusammenfassen mit
  Vorrang für den PAPER-Spiegel, Sortierung nach 24h-Volumen, Kürzung),
  `missionUniverseContext()` (Kandidaten, Fokus-Symbol, Prompt-Zeilen,
  Diagnose), `isSymbolInMissionScope()`, `segmentCandidateCounts()`.
* **Mandatsprüfung in der Engine** (`src/lib/engine.ts`): Nach der
  Symbol-Whitelist prüft der neue Schritt **MISSIONS-MANDAT**, ob das Symbol vom
  Auftrag gedeckt ist. `MISSION_SCOPE_VIOLATION` (Symbol außerhalb der
  Kandidatenliste) und `MISSION_SCOPE_EMPTY` (Segment liefert keine Kandidaten)
  führen zu `BLOCKED` und `ORDER_REJECTED` im `audit_log`. Scan-Missionen
  erhalten vier zusätzliche Prompt-Zeilen (`UNIVERSUM`, `SEGMENT-REGEL`,
  `KANDIDATEN`, Mandatsregel).
* **18 Vorlagen** (`MISSION_TEMPLATES`), davon **14 mit `seeded: true`**:
  BTC-Einstieg, SPY-Beobachtung, Swing-Research, Penny-Desk, Markt-Scan „alle
  Märkte“ (max. 3 Setups/Tag), Indizes-Trendfolge, Krypto-Momentum 24/7,
  US-Large-Caps (1 Trade/Tag), Devisen-Mean-Reversion, Rohstoffe mit halbiertem
  Risiko, Hochvolatilität mit halbiertem Risiko, Liquiditäts-Mandat,
  ETH-Trendfolge, HOLD-Baseline. Zusätzlich (nicht geseedet):
  Guardrail-Stresstest, Research-only-Shortlist, Event-Schutz,
  Korrelations-Wächter. Jede Vorlage trägt `successCriteria` (SQL-prüfbar) und
  Drei-Ebenen-Hilfe.
* **Workshop-UI** — neue Komponente `MissionTemplatePicker.tsx` (gruppierte
  Auswahl, Filter „nur mitinstallierte“, Detailkarte mit Risikoprofil,
  Erfolgskriterium und Hilfe-Aufklapper); `MissionsPanel.tsx` mit
  Missions-Typ-Radiogruppe, Segment-Auswahl inkl. live gezählter Kandidaten
  (`instrumentCount`), Filterregel, Laufzeithinweis, Drei-Ebenen-Hilfe und
  Warnung bei `0` Instrumenten; Missionsliste mit Typ-Badge
  (`missionScopeLabel`). `AgentRunPanel`/`HitRatePanel` zeigen Segment statt
  Symbol. Alle neuen Felder tragen Tooltips (`InfoTip`, zusätzlich `sr-only`).
* **API** — `GET /api/firm/missions` liefert zusätzlich `scopes`, `segments`
  (mit `instrumentCount`), `segmentIds`, `templates`; `POST`/`PUT` persistieren
  `scope`, `segment`, `template_id` und akzeptieren `{"templateId":"…"}`
  (`applyMissionTemplate()` füllt nur leere Felder). `POST /api/seed` meldet
  `missionsMigrated`.
* **Doku** — [`MISSIONS.md`](MISSIONS.md) (neu: Missions-Typen, Segmente,
  Vorlagen, API, Datenmodell, Migration, Fehlerbilder, Tests) und im
  Doku-Katalog registriert; Handbuch 5.1 (vier Schritte) und neues 5.4
  (Markt-Scans & Vorlagen); [`help/workshop.help.json`](help/workshop.help.json)
  mit 16 Begriffen im Drei-Ebenen-Schema; `docs/README.md`-Index;
  `docs/INSTALL.md`-Checkliste (14 Missionen).
* **Tests (57 neu)** — `tests/missionTemplates.test.ts` (15),
  `tests/missionUniverse.test.ts` (13), `tests/missions.api.test.ts` (9),
  `tests/missionsUi.render.test.ts` (8), `tests/missions.seed.test.ts` (6) und
  6 ergänzte Fälle in `tests/workshop.test.ts` (Scope-, Segment-,
  Vorlagen-Regeln). Die Registry-Tests arbeiten gegen ein reales
  Temp-Verzeichnis, die UI-Tests rendern die echten Komponenten.

### Changed

* **`validateMissionInput()`** (`src/lib/workshop.ts`): `MissionInput` trägt
  jetzt `scope`, `segment`, `templateId` und `symbol: string | null`.
  Prüf-Reihenfolge bewusst: Missions-Typ → Vorlage → Titel → Ziel →
  Symbol/Segment → Budgets → Status, damit die erste Meldung die
  wahrscheinlichste Ursache nennt. Neue weiche Warnung: Scan-Mission ohne Zahl
  im Zieltext.
* **Seed** (`src/lib/seed.ts`): `defaultMissions()` leitet die Standard-Mandate
  aus dem Vorlagenkatalog ab (`seeded: true`) — 14 statt 4 Missionen. Die vier
  historischen Titel bleiben unverändert, damit Alt-Installationen nichts
  doppelt bekommen.
* **Makro-Zyklus** (`src/lib/macroCycle.ts`): Das Fokus-Symbol einer
  Scan-Mission ist jetzt der liquideste Segment-Kandidat
  (`missionFocusSymbol()`), nicht mehr starr `BTC`.

### Fixed

* **Mandatsverletzungen wurden ausgeführt.** Vor 1.35.0 handelte die Engine ein
  vom Modell vorgeschlagenes Symbol auch dann, wenn es nicht zur Mission gehörte
  (z. B. `ETH` in einer BTC-Mission). Jetzt wird der Trade blockiert und
  auditiert. **Verhaltensänderung**, bewusst: Die Mission ist ein Mandat.
* **Vager Scan-Auftrag.** Der Zieltext der Vorlage `swing-multi-asset` erhielt
  prüfbare Regeln (Haltedauer 3–15 Handelstage, max. 3 offene Positionen,
  Stop 5–9 %). Bestehende Zeilen behalten ihre Fassung.

### Migration

```bash
git pull && npm ci
npx drizzle-kit push     # + missions.scope (DEFAULT 'SINGLE_SYMBOL'), .segment, .template_id
npm run build && sudo systemctl restart ai-trading-firm
curl -s -X POST localhost:3369/api/seed   # 14 Missionen, Missions-Typ nachtragen
```

* Bestehende Einzel-Symbol-Missionen laufen unverändert (`scope`-Default).
* `POST /api/seed` trägt bei Alt-Mandaten mit `symbol IS NULL` und
  `scope = 'SINGLE_SYMBOL'` den Missions-Typ `SCAN_UNIVERSE` plus das zur
  Vorlage gehörende Segment nach — idempotent, nur bei Titelgleichheit mit
  einer Scan-Vorlage, Budgets und Zieltexte bleiben unangetastet.
* **Alt-Missionen ohne Symbol und ohne Vorlagen-Titel** behalten ihr bisheriges
  Verhalten (Fokus `SPY`, keine Mandatsprüfung); der Kontext meldet das als
  Warnung.
* Scan-Segmente sind nur so gut wie die Registry: `npm run universe:seed:markets`
  (354 Preset-Instrumente, Upsert) und `npm run market:sync`
  (Volumen/Volatilität) füllen `INDICES`, `COMMODITIES`, `VOLATILE`, `LIQUID`.

**Tests:** Gesamtsuite `npm test` **1511/1513 grün** (vorher 1454/1456) — die beiden Ausfälle
(`test/integration/cli-sync-e2e.test.ts`, `test/marketdata/adapters/bitunix.test.ts`,
beide Bitunix-Fixture-/Netz-abhängig) bestanden bereits vor dieser Änderung
nicht. `npm run typecheck`, `npm run lint`, `npm run build` und
`npm run docs:validate` (8 Checks, 10 Hilfe-Dateien) grün.

## [1.34.0] — 2026-08-31 · feat(install): geführtes Windows-Setup mit PowerShell

### Added

* `scripts/setup-windows.ps1`: idempotenter Windows-Installer mit `winget`-
  Preflight, Node.js LTS, PostgreSQL-Dienst, Datenbank/Rolle, sicherer `.env`,
  npm/Drizzle/Universe-Seeds, optionalem Ollama-Modell sowie Typecheck, Lint,
  Build und Health-Check. Secrets werden weder auf der Konsole noch im Log
  ausgegeben; bestehende `.env`-Dateien werden vor dem Ersetzen gesichert.
* [`INSTALL-WINDOWS.md`](INSTALL-WINDOWS.md): vollständige Anleitung vom
  One-Liner bis zu Workarounds für winget, PATH, PostgreSQL, npm, Ollama und
  Health-Check.

### Security

* Neuinstallationen bleiben fail-closed: `PAPER_MODE=broker-market-data`,
  `REQUIRE_HUMAN_APPROVAL=true`, `LIVE_TRADING_ENABLED=false` und
  `BITUNIX_ENABLED=false`.

## [1.33.1] — 2026-08-31 · fix(setup): PAPER-MODE-Default und WURZELURSACHE-Validierung (B7)

**P0, trifft jede Neuinstallation.** `scripts/setup-cachyos.sh` schrieb den
Alt-Wert `B` als `PAPER_MODE` in `.env` — ein Wert, den `parsePaperMode()`
(`src/lib/marketdata/config.ts`) ablehnt (erlaubt: `synthetic |
broker-market-data | broker-paper-api`). Die Engine warf beim Boot einen
`PaperConfigError`, `GET /api/firm` antwortete 503 mit dem irreführenden
Hinweis „PostgreSQL läuft?", und `validate-setup.sh` meldete zehn stille
Folgefehler (V05–V17). Vollständiger Befund mit Symptom, Ursache, Fix und
Nachweis: [`SETUP_BUGS.md`](SETUP_BUGS.md) (B7).

### Fixed

* **`scripts/setup-cachyos.sh`** — schreibt an beiden Stellen
  `PAPER_MODE=broker-market-data` (Heredoc und `env_ensure_key`) statt des
  Alt-Werts `B`. Bestehende `.env`-Dateien werden nicht still überschrieben
  (`env_ensure_key` ergänzt nur fehlende Schlüssel). Reparatur einer
  betroffenen Installation:
  `sed -i 's/^PAPER_MODE=.*/PAPER_MODE=broker-market-data/' .env`, danach
  Dienst neu starten.
* **`scripts/validate-setup.sh`** — `.env`-Vorabprüfung für `PAPER_MODE`
  **vor** jedem HTTP-Request: ungültiger Wert → lauter `WURZELURSACHE`-Block
  (Exit 2). Zusätzlich erkennt die Validierung ein `{error, fix}`-Objekt von
  `/api/firm` (503) und benennt die Ursache, statt V05–V17 als zehn stille
  Folgefehler zu zählen; bei paperMode-Fehlern ersetzt sie den generischen
  Route-Hinweis („PostgreSQL läuft?") durch die konkrete `.env`-Behebung.
  Check V04 nennt `PAPER_MODE` als mögliche Ursache.

### Changed

* **`INSTALL.md`** — Flag-Tabelle `PAPER_MODE`: Default `broker-market-data`,
  erlaubte Werte `synthetic`/`broker-market-data`/`broker-paper-api`;
  `A`/`B`/`C` werden ausdrücklich als **nicht** akzeptiert dokumentiert.
* **`docs/INSTALL.md`** — Troubleshooting-Zeile für
  `EADDRINUSE 0.0.0.0:3369` (Port-Besitzer ermitteln, Prozess beenden,
  Dienst neu starten).
* **`docs/SETUP_BUGS.md`** — Befund B7; Übersichtstabelle und Status-Header
  aktualisiert (B1–B7).
* **`README.md` / `docs/README.md`** — Befund-Register-Verweise auf B1–B7
  aktualisiert.

### Migration

Kein Schema-Bruch, keine Datenmigration. Bestehende Installationen, deren
`.env` noch `PAPER_MODE=A|B|C` enthält, reparieren sich über einen erneuten
Setup-Lauf **nicht** automatisch (der Wert ist bereits gesetzt) — einmalig:

```bash
sed -i 's/^PAPER_MODE=.*/PAPER_MODE=broker-market-data/' .env
sudo systemctl restart ai-trading-firm
./scripts/validate-setup.sh
```

Für Neuinstallationen gilt der korrigierte Default automatisch.

### Links

* Ticket: „Setup schreibt PAPER_MODE=B, den parsePaperMode() ablehnt (B7)“ ·
  Befund: [SETUP_BUGS.md](SETUP_BUGS.md) · Referenz:
  [PAPER_TRADING.md](PAPER_TRADING.md)


## [1.33.0] — 2026-08-31 · feat(ops): add market-data readiness panel to operations center

**[OPS] Surface market-data readiness instead of six funnel zeros (OPS-011, P2)**

Das Operations Center visualisierte ausschließlich den Scanner-Funnel. Bei
fehlender Datenbasis konnte ein Betreiber sechs Nullen nicht unterscheiden
zwischen „der Markt bietet nichts Geeignetes“ (fachlich korrekt), „wir haben
keine Kerzen geladen“ (Warmup) und „der Ticker-/Depth-Abruf ist ausgefallen“
(Infrastruktur) — mitursächlich dafür, dass der P0-Defekt lange als „Scanner
zu restriktiv“ fehlinterpretiert wurde.

### Added

- **`src/ops/collectMarketData.ts`** — `collectMarketDataReadiness()`:
  reine Lesefunktion (Registry-Query + Historical-Store-Zählung + Readiness +
  zwischengespeicherte Sync-Ergebnisse). Kein Netzwerk-I/O, kein Sync-Trigger.
  `buildReadinessHint()` liefert genau einen handlungsleitenden Hinweis je
  dominierendem Blocker (ERROR → Infrastruktur · WARMING ohne Kerzen →
  Sync-Kommando + Sollwert-Herleitung · WARMING ohne Spread → depth-Enrichment
  · WARMING teilweise → fehlende Instrumente benannt · READY → leerer Funnel
  ist eine fachliche Aussage).
- **`MarketDataOpsSnapshot`** (`src/ops/types.ts`, Payload-Feld `marketData`
  in `GET /api/ops`, additiv): `generatedAt`, `requiredCandles`, `registry`,
  `discovered`, `dataReady`, `warming`, `tickerReady`, `spreadReady`,
  `scannerReady` (⇔ `readinessStatus === "READY"`), `readinessStatus`
  (`READY | WARMING | ERROR`), `venues[]`, `worstOffenders[]` (Top 10,
  candles asc), `hint`.
- **`src/marketdata/syncStatus.ts`** — persistenter Sync-Status je Venue
  (`data/market-sync-status.json`, gitignored): letzter Sync, degraded-Flag,
  Instrumente, Fehlerzähler nach **geschlossener** MDERR-006-Taxonomie.
  Geschrieben von `scripts/market-sync.ts` und `scripts/run-scan.ts --sync`;
  beim Laden strikt validiert (Venue-Whitelist, Reason-Enum, Kappung auf 10).
- **`src/components/ops/MarketDataPanel.tsx`** — Sektion „Market Data“
  **oberhalb** des Funnels: Ampel READY/WARMING/ERROR farb- **und**
  textkodiert (`role="status"`), Tooltip je Kennzahl (Herkunft, Berechnung,
  Sollwert), Venue-Sync-Liste, ausklappbare „worst offenders“-Tabelle,
  Hinweis, dass Funnel-Nullen bei WARMING/ERROR datenbedingt sind.
- **`docs/OPERATIONS.md`** — Runbook „Funnel ist leer“ mit Entscheidungsbaum
  (Fehler-Counter > 0 → Venue-Incident | Candles 0 → Sync ausführen |
  Spread-ready 0 → Depth-Abruf prüfen | alles ready → fachliche Bewertung).
- Tests: `test/ops/collectMarketData.test.ts` (Zählregeln, Grenzwert,
  Determinismus, fetch-Spy = 0, Hint-Table-Test, JSON-Stabilität,
  Secret-Scan, Integration Fake-Sync 2/3 gewärmt) und
  `test/ui/MarketDataPanel.test.tsx` (WARMING/READY/ERROR, Funnel bleibt
  sichtbar, Accessibility).

### Changed

- `collectScanner()`-Note verweist bei WARMING/ERROR explizit darauf, dass
  die Funnel-Nullen datenbedingt sind (Sektion „Market Data“). Der Funnel
  selbst ist unverändert.
- `docs/MARKET_DATA_PIPELINE.md` §6: Abschnitt „MarketDataOpsSnapshot“.

### Security

- Ops bleibt **read-only**: kein Sync-Trigger-Endpoint eingeführt.
- Snapshot enthält keine Credentials, keine Env-Variablen, keine internen
  Dateipfade, keine Stacktraces, keine rohen Upstream-Messages.
- Fehler-Reasons sind eine geschlossene Aufzählung (`MarketDataErrorReason`);
  unbekannte Schlüssel werden beim Laden verworfen.
- `venues` und `worstOffenders` sind hart gekappt (kein Response-Wachstum).

Refs: Code Review Scanner, Kap. 14, 26

---

## [1.32.0] — 2026-08-31 · feat(marketdata): enrich instruments with volume24h and orderbook spread (P1)

**[MARKETDATA] Add ticker and orderbook enrichment to instrument discovery**

`discoverInstruments()` rief ausschließlich `fetchTradingPairs()` auf. Die
Trading-Pair-Response enthält Handelsparameter (`symbol, base, quote,
minTradeVolume, basePrecision, quotePrecision, maxLeverage, symbolStatus,
isApiSupported`), aber **nicht** die vom Scanner benötigten Metriken `volume24h`
und `spread`.

Der Produktionspfad muss lauten:

```
trading_pairs → registry instruments → tickers → volume24h
              → depth → bestBid/bestAsk/spread → kline → HistoricalStore → Scanner
```

Implementiert war bisher nur `trading_pairs → registry`.

**Kritische Nuance (Zweiter Funnel-Blocker):** Der Liquiditätsfaktor besitzt einen
Fallback (`instrument.volume24h ?? letzteKerze.volume × letzteKerze.close`), der
Spread-Faktor jedoch **nicht** (`if (spread === null ...) return unavailable(...)`)
und der Eligibility-Filter lehnt unbekannten Spread explizit ab. Daher gilt:

```
Candle-History repariert → min-candles OK → liquidity evtl. OK → spread = null → max-spread reject
```

Ein reines Candle-Seeding erzeugt also **keinen** funktionierenden Funnel. Die
Bitunix-Ticker-API liefert 24h-Volumen, aber keine Bid/Ask-Spanne — der Spread
**muss** aus `/depth` berechnet werden.

### Added

- **`src/marketdata/enrichment.ts`** — neue, eigenständige Stages:
  - `enrichWithTickers()`: **ein** Bulk-Call auf `/market/tickers` → `volume24h`
    (Quote-Volumen, `ticker.quoteVol`). Fehlt ein Symbol → `null` + `missing`,
    kein Throw. Plausibilität: `quoteVol` per `Number.isFinite()` geprüft.
  - `enrichWithOrderBooks()`: `depthLimit=5`, N× `/market/depth` → relativer Spread
    `calculateRelativeSpread(bids[0]?.price, asks[0]?.price)`. Pro Symbol Timeout
    5 s, max. 1 Retry über bestehenden Backoff. Fehler → `null` + `failures`,
    Sync läuft weiter. Plausibilität: leeres/gekreuztes Buch → `null`,
    `spread > 0.5` (50 %) → `null` + Warnung (defektes Buch).
  - `EnrichmentReport { attempted, succeeded, missing, failures }`.
  - Security: Arrays gekappt (max. `depthLimit`), numerische Felder per
    `Number.isFinite()`, `NaN`/`Infinity` → null, `maxInstruments` ≤1000 und
    `concurrency` ≤8 hart gekappt (Schutz gegen self-DoS/IP-Ban), Timeouts,
    Symbol-Allowlist + Encoding vor URL.
- **Registry-Upsert** jetzt mit explizitem Quote-Volumen:
  `registry.upsert({ ...instrument, volume24h: volumeBySymbol.get(symbol) ?? null,
  spread: spreadBySymbol.get(symbol) ?? null, lastSeen }, `sync:${venue}`)`.
  `volume24h` ist Quote-Volumen — dokumentiert als JSDoc im Registry-Typ.
- **Eligibility-Rejection-Payload** mit Coverage-Diagnose (§6):
  ```json
  {
    "instrument": "BITUNIX:BTCUSDT",
    "eligibility": {
      "status": "rejected",
      "rule": "max-spread",
      "data": { "candles": 150, "volume24h": 2840000000, "spread": null }
    }
  }
  ```
  Damit ist im Ops-Kontext sofort erkennbar: nicht „BTC ungeeignet“, sondern
  „Spread wurde nicht geladen".
- **Kontextabhängige Hilfe-Texte:**
  - JSDoc `enrichWithOrderBooks`: „Die Bitunix-Ticker-API liefert kein Bid/Ask.
    Der relative Spread wird deshalb aus dem Orderbook-Top-Level (`/market/depth`,
    limit=5) berechnet. Das kostet N zusätzliche Requests und ist der teuerste
    Teil des Syncs — daher Concurrency-Begrenzung und Token-Bucket."
  - Registry-Feld-Tooltips: `volume24h` und `spread` mit Data-Quality-Hinweisen.
  - Log-Warnung: `[market-sync] spread unavailable for 12/180 symbols — diese
    Instrumente werden mit rule="max-spread" (data quality) abgelehnt, nicht
    wegen zu hoher Kosten.`
- **`test/marketdata/enrichment.test.ts`** — 12 Unit-Tests + Integration:
  volume enrichment, spread calculation, missing ticker → null, depth failure
  isoliert, empty/crossed/implausible spread → null, bulk once, concurrency
  limit, unknown spread rejection, rejection payload context, quoteVol vs baseVol,
  Fake-Adapter Integration (2 mit spread, 1 ohne).

### Changed

- **`src/marketdata/sync.ts`**: Refaktoriert auf zweistufige Stages —
  Discovery → `enrichWithTickers()` (1× Bulk) → Ranking → `enrichWithOrderBooks()`
  (N× Depth, limit=5, concurrency) → Upsert + Candle-Backfill. Rate-Limit:
  jeder Depth-Call durch globalen Limiter, Concurrency ≤8. Neue Warnung für
  `spread unavailable`. `volume24h` explizit Quote-Volumen.
- **`src/marketdata/adapters/bitunix.ts`**: `mapDepthLevels` kappt Arrays auf
  `depthLimit`, validiert per `Number.isFinite()`, `getOrderBook` nutzt limit=5
  (Rate-Limit-schonend, teuerster Teil), JSDoc für Quote-Volumen und Spread.
- **`src/universe/types.ts`**: JSDoc für `volume24h` („Quote-Volumen, null =
  nicht geladen, Fallback letzte Kerze“) und `spread` („Orderbook-Top-Level,
  null = nicht geladen, kein Fallback, Plausibilität >50% → null").
- **`docs/MARKET_DATA_PIPELINE.md`**: Kap. 2 & 3 aktualisiert — neue Stages,
  `EnrichmentReport`, Datenfluss-Diagramm, Registry-Upsert, Coverage-Diagnose,
  Hilfe-Texte, Security-Audit-Checkliste, Log-Warnung.
- **`docs/BITUNIX.md`**: §1.2 aktualisiert — P1-Enrichment-Stages, Interface,
  Registry-Upsert, Coverage-Diagnose, Hilfe-Texte, Log-Warnung, Security-Audit.

### Security Audit

- [x] Depth-Response-Validierung: Arrays gekappt (max. `depthLimit` Levels),
      numerische Felder per `Number.isFinite()` geprüft, `NaN`/`Infinity` → null
- [x] Kein unbegrenztes Fan-out: `maxInstruments` und `concurrency` hart gekappt
      (Schutz gegen self-inflicted DoS / IP-Ban durch die Venue)
- [x] Timeouts auf jedem HTTP-Call (kein hängender Sync)
- [x] Keine Symbol-Werte ungeprüft in URLs (Allowlist + Encoding)
- [x] `spread`/`volume24h` fließen in Risikoentscheidungen → Plausibilitätsgrenzen
      sind getestet und dokumentiert


## [1.31.0] — 2026-08-31 · fix(bitunix): Public Market Data in den Scanner-Warmstart verdrahten (P0)

**P0, Productionspfad.** Der `BitunixBrokerAdapter` existierte funktionsfähig
(`discoverInstruments()`, `getTicker()`, `getCandles()`), wurde aber von keinem
Produktionspfad aufgerufen — der Scanner ging weiter
`Registry → HistoricalStore → scanUniverse()`, und die Registry blieb bei den
26 statischen Seed-Instrumenten. Dieser Release verdrahtet den vorhandenen
Public-Market-Data-Pfad über einen dünnen MarketDataAdapter-Wrapper mit dem
`MarketDataSyncService` (MDSYNC-001) und trennt dabei die Broker-Domäne von der
Marketdata-Domäne.

### Added

* **`src/marketdata/adapters/bitunix.ts`** — Wrapper
  `createBitunixMarketDataAdapter({ publicClient, symbolNormalizer })`:
  Broker-PublicClient → `MarketDataAdapter` (`venue = "BITUNIX"`).
  DTO→Domain-Mapping vollständig dokumentiert (inkl. Nullable-Semantik);
  Instrument-ID immer über `normalizeVenueSymbol("BITUNIX", raw)` in
  venue-nativer Speicherform (`BITUNIX:BTCUSDT`, docs/SYMBOLS.md §4);
  `symbolStatus`/`isApiSupported` → nicht handelbare Symbole werden mit
  `status: "halted" | "delisted"` übernommen, nie still verworfen.
* **`BITUNIX_TIMEFRAME_MAP` + `toBitunixInterval()`** — explizite, vollständige
  Konstanten-Map `SupportedTimeframe → Bitunix-Interval`; dokumentierte
  Venue-Lücken `3m`/`5d` sind `null`-Einträge. Unbekannte oder nicht bediente
  Timeframes werfen neuen `UnsupportedTimeframeError` (kein stiller
  Ersatztimeframe — Reihen verschiedener Periodizität dürfen nie gemischt
  werden).
* **`registerMarketDataAdapters(env)`** (`src/marketdata/registerAdapters.ts`)
  — Ticket-Signatur der zentralen Registrierung. Gate:
  `capabilities.BITUNIX.marketData === true` (neu, SSoT
  `src/brokers/capabilities.ts`) **und** `BITUNIX_ENABLED === "true"` (plus
  bestehende `MARKET_SYNC_*`-Flags). Die Registrierung instanziiert
  ausschließlich den credential-freien `BitunixPublicClient` — kein
  `BitunixBrokerAdapter`, kein `BitunixPrivateClient`, kein Secret-Store.
* **PublicClient-Signatur-Ergänzungen** (`src/brokers/bitunix/publicClient.ts`):
  `fetchTradingPairsRaw()` (RAW-DTO), `fetchTickers(symbols?: string[] | string)`
  (Bulk-Filter als Array), `fetchDepth(symbol, limit = 5)` (RAW-DTO; `fetchOrderBook`
  delegiert). `mapTicker`, `inferBase`/`inferQuote` für die Wiederverwendung
  exportiert.
* **`test/fixtures/bitunix/*.json`** — echte, am 2026-08-31 gezogene Responses
  der öffentlichen API (trading_pairs, tickers, depth, kline; Subset, Felder
  unverändert) plus schema-idente Edge-Status-Zeilen (STOP, CANCEL_ONLY,
  `isApiSupported: false`, DELISTED, base/quote-Inferenz). Provenanz:
  `test/fixtures/bitunix/README.md`.
* **`test/marketdata/adapters/bitunix.test.ts`** — 20 Tests, u. a. alle neun
  Pflicht-Tests des Tickets (Discovery-Upsert, „never instantiates private
  client“, Env-/Capability-Gates, exhaustives Timeframe-Mapping,
  `UnsupportedTimeframeError`, Symbol-Normalisierung je ID, HALTED-Übernahme,
  „run-scan ohne `--sync` = null Netzwerk“ via Guard-Server-Subprozess,
  401/403/429/5xx-Regression mit endlichem Retry-Budget) sowie Security-Audit
  (Endpoint-Allowlist, Env-Proxy gegen `BITUNIX_API_KEY`/`_SECRET`-Reads,
  Redaction, geteilter Token-Bucket).
* **`UnsupportedVenueError`-Hilfetext** — nennt beide Ursachen
  (Capability-Matrix / Env-Flag), die Behebung (`BITUNIX_ENABLED=true`, Public
  Data braucht KEINE API-Credentials) und die Unberührtheit des Live-Gates.

### Changed

* **Domänentrennung:** `BitunixBrokerAdapter` implementiert das
  `MarketDataAdapter`-Interface nicht mehr explizit (kein Import
  `src/brokers → src/marketdata` mehr; strukturell bleibt er kompatibel). Die
  einzige Kopplung ist der Wrapper in `src/marketdata/adapters/bitunix.ts` —
  Abhängigkeitsrichtung ausschließlich Marketdata → Broker.
* **Registrierung baut nur den PublicClient:** `registerAdapters()` erzeugt den
  Sync-Adapter statt des Broker-Adapters im Paper-Modus und erstellt **einen
  geteilten `TokenBucket(8, 8)` pro Lauf** — das dokumentierte IP-Budget
  (10 req/s/IP, Code 8) bleibt autoritativ, auch bei künftiger paralleler
  Registrierung mehrerer Venues.
* **`skipped`-Reason `CAPABILITY_DISABLED`** in `registerAdapters()`-Ergebnis
  und CLI-Behebungshinweis (`scripts/lib/market-sync.ts`).
* `run-scan.ts --sync` ( unverändert Default `false`) dokumentiert jetzt
  test-erzwungen, dass ohne `--sync` null Netzwerk-Requests abgehen.
* Docs: `docs/BITUNIX.md` (neue §0 Code-Map, §1.1 Wrapper-Architektur,
  Vier-Ebenen-Tabelle mit Auth/Rate-Limit/Aktivierung je Ebene, Status- und
  Timeframe-Mapping), `docs/MARKET_DATA_PIPELINE.md` (§0 Code-Map, §9
  Rate-Limit, §10 Venue Capability Matrix inkl. Capability-Gate und
  Timeframe-Lücken-Spalte).

### Security

* grep-Nachweis per Test: `src/marketdata/**` importiert keinen `PrivateClient`,
  keine Signatur-/HMAC-Funktion, keine Nonce-Erzeugung, instanziiert keinen
  Broker-Adapter.
* Endpoint-Allowlist per Test: ein vollständiger `syncVenue()` erzeugt
  ausschließlich Requests auf `trading_pairs`, `tickers`, `depth`, `kline` und
  trägt keine Credential-Header (Laufzeit-Test selbst mit
  `BITUNIX_API_KEY`/`_SECRET` im Env).
* Env-Proxy-Test: Zugriff auf `BITUNIX_API_KEY`/`BITUNIX_API_SECRET` während
  Registrierung + `syncVenue()` lässt die Suite fehlschlagen — die Keys werden
  im Sync-Pfad nicht gelesen.
* Live-Gate unverändert; alle bestehenden Live-Gate-Tests bleiben ohne Anpassung
  grün.

### Links

* Ticket: „BitunixBrokerAdapter in die Market-Data-Pipeline verdrahten (P0)“ ·
  Refs: Code Review Scanner, Kap. 2, 3, 12, 18 · Pipeline:
  [MARKET_DATA_PIPELINE.md](MARKET_DATA_PIPELINE.md) · Adapter:
  [BITUNIX.md](BITUNIX.md)

## [1.30.0] — 2026-08-31 · fix(setup): Setup-Pfad härten, Markt-Presets, Short-Selling-Default (SETUP-130)

**P1, Produktkette + Sicherheit.** Eine Neuinstallation auf CachyOS konnte an
fünf Stellen scheitern oder unsicher enden; das handelbare Universum war mit
26 Instrumenten zu dünn für einen sinnvollen Scanner-Trichter. Vollständiges
Befund-/Fix-Register mit Symptom, Ursache, Fix und Nachweis je Punkt:
[`SETUP_BUGS.md`](SETUP_BUGS.md).

### Added

* **`scripts/validate-setup.sh`** — 18 deterministische Setup-Checks ohne
  Pipeline-Lauf und ohne bleibende Zustandsänderung: Dienst/Schema (V01–V04),
  Stammdaten inkl. UUID-Prüfung (V05–V07), Markt-Universum (V08–V11),
  Broker-Adapter und harte Grenzen (V12–V16), API-Sicherheit (V17–V18).
  Optionen `--base-url`, `--min-pass` (Default 15), `--expect-shorts`,
  `--timeout`, `--json`, `-h`. Exit-Codes 0/1/2. Im `--json`-Modus geht der
  Fortschritt auf `stderr`, `stdout` bleibt reines JSON.
* **`src/universe/presets.ts`** — kuratierte, deterministische Markt-Presets:
  50 Aktien, 50 Indizes, 22 Rohstoffe, 30 Kryptowährungen. Fester
  `lastSeen`-Zeitstempel, kein `liveAvailable` (CAP-008), Metriken `null`.
  `assertPresetContract()` erzwingt die dokumentierten Anzahlen und
  Duplikatfreiheit.
* **`scripts/seed-market-universe.ts`** / **`npm run universe:seed:markets`** mit
  `--dry-run`, `--no-paper-mirror`, `--json`, `-h`. Idempotenter Upsert
  (354 Instrumente), fail-loud bei abgelehnten Sätzen (Exit 1).
* **`src/lib/appPaths.ts`** — zentrale, pfadsichere Auflösung von
  Laufzeit-Datenverzeichnissen: `resolveRuntimePath()`,
  `resolveRuntimePathSafe()`, `joinRuntimePath()`, `resolveStoredPath()` und
  `PathTraversalError`.
* **`docs/SETUP_BUGS.md`** — Setup-Bug-Register (B1–B6), im Doku-Katalog
  (`GET /api/docs`, Slug `setupbugs`) registriert.
* **`tests/universe.presets.test.ts`** — 15 Tests: Preset-Vertrag,
  Seed-Invarianten, Short-/Hebel-Semantik, Policy-Konformität, Determinismus,
  Registry-Idempotenz.
* **`scripts/setup-cachyos.sh`** — neue Optionen: `--no-shorts`,
  `--sync-markets`, `--api-token`, `--no-api-token`, `--skip-build`,
  `--skip-validate`, `--min-pass`, `--reset-cluster`, `--dry-run`,
  `--non-interactive`/`-y`, `--log-file`, `--db-host`, `--db-port`, `--pgdata`.

### Changed

* **Short-Selling ist im Setup-Default aktiviert** (`risk_config.allowShort = 1`).
  Umsetzung über den bestehenden Runtime-Konfigurationspfad
  (`LIMIT_CEILINGS.allowShort = [0, 1]`) als idempotenter SQL-Upsert — kein
  Eingriff in die Code-Ceilings. Harte Grenzen unverändert: `maxLeverage = 1`,
  `requireStopLoss = true` (nicht abschaltbar), Kill-Switch, Positions- und
  Drawdown-Limits. `shortAvailable` bleibt eine Venue-Aussage: BINANCE-Spot
  bleibt `false`, ALPACA/IBKR/PAPER sind `true`.
* **`scripts/setup-cachyos.sh` neu strukturiert:** zehn benannte Schritte
  (`step_01_preflight` … `step_10_validate`), strukturiertes Logging mit
  Zeitstempel nach `data/setup/setup-<Zeitstempel>.log`, `ERR`-Trap mit Schritt-
  und Zeilenangabe, Secret-Maskierung (`run_masked`) für `DATABASE_URL` in
  Anzeige **und** Log, vollständige Idempotenz.
* **Tabellen-Verifikation** nach `drizzle-kit push` erwartet ≥ 13 Tabellen
  (abgeleitet aus `src/lib/seed.ts → checkSchema()`, vorher 9) und prüft
  kritische Tabellen einzeln.
* **`.env`-Behandlung:** eine vorhandene `.env` wird nie still überschrieben;
  fehlende Schlüssel werden ergänzt, eine überschriebene Datei vorher als
  `.env.bak-<Zeitstempel>` gesichert.
* `resolveRuntimePath()` ersetzt die Inline-Pfadauflösung in
  `src/universe/store.ts`, `src/scanner/artifacts.ts`, `src/cycle/artifacts.ts`,
  `src/cycle/ports.ts`, `src/lib/marketdata/historicalStore.ts`,
  `src/portfolio/auditFile.ts`, `src/routing/router.ts` und
  `src/brokers/control-plane/secretStore.ts`. Semantik und Defaults bleiben
  unverändert (`data/...` bzw. `artifacts`).
* `DefaultCycleAuditPort` validiert den Dateinamen gegen
  `CYCLE_AUDIT_FILE_RE` (`^[A-Za-z0-9._-]{1,64}$`) — derselbe Schutz wie im
  Portfolio-Audit.

### Fixed

* **B1 PostgreSQL-Initialisierung:** Cluster-Checks laufen als
  `$PG_SUDO_USER` (kein `EACCES`-Fehlalarm bei `0700`); Versionsabgleich
  (`pg_version_mismatch`, `pg_control_major`) **vor** jedem Eingriff, bei
  Major-Mismatch Abbruch mit `pg_upgrade`-Hinweis statt Datenlöschung;
  `pg_pick_locale()` mit Fallback-Kette `C.UTF-8` → `en_US.UTF-8` → `C`
  (behebt `initdb: error: locale "C.UTF-8" does not exist`); `initdb`-Fehler
  werden abgefangen und mit Journal-Auszug plus manuellem Befehl quittiert;
  Cluster-Reset ist ein eigener, zustimmungspflichtiger Schritt
  (`pg_reset_cluster`).
* **B2 `invalid input syntax for type uuid: "null"`:** Mission-IDs werden auf
  UUID-Form geprüft, bevor sie in einen Request gehen; `agents`/`missions`
  werden nach dem Seed gezählt und gemeldet.
* **B3 `UNEXPECTED_BROKER_ADAPTER`:** der aktive Adapter wird über
  `/api/firm → account.broker` verifiziert (Check V12).
* **B4 Zwölf Turbopack-Warnungen** „Dynamic filesystem access causes tracing
  of the whole project“ sind beseitigt — `npm run build` kompiliert
  warnungsfrei. Schritt 09 wertet die Build-Ausgabe aus, damit sie nicht
  unbemerkt zurückkommen.
* **B5 Offener LAN-Betrieb:** `FIRM_API_TOKEN` wird beim Setup erzeugt;
  `--no-api-token` erzeugt eine explizite Sicherheitswarnung. Die
  Ceiling-Klemmung wird mit Prozent (90 → 0.5) statt Bruch (0.9) geprüft.
* **B6 Fehlende Abnahme-Routine:** `scripts/validate-setup.sh` liefert ein
  schnelles, reproduzierbares Setup-Urteil (18 Checks, Default-Schwelle 15).

### Security

* `FIRM_API_TOKEN`-Erzeugung mit `openssl rand -hex 32` (Fallback
  `/dev/urandom` + `od`); `.env` bleibt `0600`; Token erscheint nie im Log
  (`run_masked`).
* Path-Traversal-Schutz für alle konfigurierten Datenverzeichnisse
  (`UNIVERSE_DATA_DIR`, `SCANNER_ARTIFACTS_DIR`, `CYCLE_ARTIFACTS_DIR`,
  `PORTFOLIO_AUDIT_DIR`, `BROKER_SECRET_DIR`, `PAPER_HISTORY_DIR`);
  `..`-Ausbruch wirft `PathTraversalError`, der Secret-Store fällt auf den
  sicheren Default zurück.
* `--no-api-token` bleibt möglich, ist aber dokumentiert riskant: `npm run start`
  bindet `0.0.0.0`.

### Migration

Kein Schema-Bruch, keine Datenmigration. Bestehende Installationen:

```bash
git pull
npm ci
npm run universe:seed:markets
psql "$DATABASE_URL" -c "INSERT INTO risk_config (key, value, description) VALUES ('allowShort', '1', 'Short-Handel erlaubt? (0/1)') ON CONFLICT (key) DO UPDATE SET value = '1', updated_at = now();"
npm run build
sudo systemctl restart ai-trading-firm
./scripts/validate-setup.sh
```

Wer Short-Selling nicht möchte, lässt das `UPDATE` weg bzw. setzt
`allowShort` zurück auf `0` (Dashboard → Einstellungen).

## [1.29.0] — 2026-08-30 · feat(marketdata): persistenter Marktdaten-Warmup und Sync-CLI (MDSYNC-001)

**P1, Produktkette.** `data/history/candles.ndjson` wurde von keinem Prozess
befüllt: `scanUniverse()` las `candles.length === 0`, lehnte **alle**
Instrumente mit `min-candles` ab und der Trichter meldete „Markt ungeeignet“,
obwohl die Infrastruktur keinen Warmup hatte. Der Sync ist jetzt ein eigener,
persistenter Schritt **vor** dem Scan — der Scanner bleibt rein.

### Added

* **`npm run market:sync`** (`scripts/market-sync.ts`, Alias
  `npm run market-sync`; geteilte Schicht `scripts/lib/market-sync.ts`):
  `--venue`, `--timeframes`, `--symbols`, `--candle-limit`,
  `--max-instruments`, `--concurrency`, `--strict`, `--dry-run`, `--json`,
  `--no-manifest`, `--status`, `--help`/`-h`. Exit-Codes 0/1/2 (2 =
  Bedienfehler, es geht kein Request raus). `--status` liest ausschließlich:
  Readiness des Warmups über dieselbe Aggregation wie das Operations Center
  (`collectMarketDataReadiness`), Exit 0 = bereit, Exit 1 = Warmup fehlt.
  `scripts/run-scan.ts --sync|--sync-first` nutzt denselben Pfad;
  `npm run market:sync:status` (Alias `market-sync:status`) ist das Status-Kommando.
* **`src/marketdata/registerAdapters.ts`** — einzige Instanzierungsstelle
  konkreter Sync-Adapter, fail-closed gated: `MARKET_SYNC_ENABLED`
  (Kill-Switch), `MARKET_SYNC_VENUES` (Allowlist), `<VENUE>_ENABLED`
  (`BITUNIX_ENABLED`, nur exakt `"true"`). Nicht registrierte Venues melden
  `skipped: [{ venue, reason }]` mit Behebungshinweis im CLI.
  `adapterRegistry.ts` ist der objekttragende Wrapper darumherum.
* **`SyncResult`** mit deckungsgleichen Zählern
  (`discovered = synced + skipped`, `tickersEnriched`, `orderbooksEnriched`,
  `spreadsUnknown`, `policyExcluded`, `candlesByTimeframe[tf] =
  { instruments, bars }`, `failures[]`, `degraded`, `durationMs`) und
  `formatSyncLog()` — Logzeilen und Zähler sind dieselbe Zahl.
* **`HistoricalStore.appendSeries(groups, now)`**: ein Lade-, Kompaktier- und
  Schreibvorgang über alle Reihen eines Laufs statt `append` je
  Instrument × Timeframe (quadratische I/O). Semantik je Reihe identisch
  (Dedup: jüngstes `fetchedAt` gewinnt), `append` bleibt öffentliche API.
* **Harte Limits** in `src/marketdata/sync.ts`: `MAX_CONCURRENCY = 8`,
  `MAX_CANDLE_LIMIT = 2000`, Discovery-Zeilen- und Ticker-Cap,
  `InsufficientCandleLimitError` (`candleLimit < requiredWarmupCandles`,
  Default `max(150, Bedarf)`), `SyncPartialFailureError` bei `--strict`.
* **Payload-Kappe am Transport**: `BITUNIX_MAX_RESPONSE_BYTES` (5 MiB), am
  Stream durchgesetzt (`content-length` nur Vorabfilter), Fehlerkind
  `payload` → `BITUNIX_PAYLOAD`, kein Retry.
* Doku: `docs/MARKET_DATA_PIPELINE.md` §0 (Code-Map Anforderung ↔ Pfad), §12
  (CLI, Gates, Exit-Codes, Logformat), §13 (Abweichungen vom Ticket);
  `docs/INSTALL.md` §6.1 (Warmup vor dem ersten Scan); `.env.example`
  (MARKET_SYNC_*); Readme-Verlinkungen.

### Changed / Fixed

* `runMarketSyncDetailed()` läuft über `resolveSyncOptions()` **vor** dem
  ersten Request — ein Timeframe-/Limit-Tippfehler schreibt nichts halbfertig.
* Ticker: Batch-Antwort plus **Lücken-Fallback** (`+1 × tickers` je fehlendem
  Symbol); ein Ticker mit fremdem Symbol wird nicht übernommen (Symbol-Guard),
  `volume24h` bleibt `null` und der Lauf wird degradiert gemeldet.
* `skipped` zählt jede Discovery-Zeile, die nicht synchronisiert wurde
  (Allowlist, Cap, unbrauchbar, Duplikat) — nur so ist die Deckungsgleichheit
  prüfbar; unbrauchbare Zeilen erscheinen zusätzlich als Warnung.
* Historien-Schreibpfad des Syncs puffert Bars und ruft `appendSeries` einmal
  pro Lauf auf (Verhalten, Persistenz und Zähler unverändert).

### Tests / Security

* Neu `test/marketdata/{spread,sync,security,cli}.test.ts`,
  `test/integration/{warm-scanner,cli-sync-e2e}.test.ts` und ein
  Shared-Fixture-Layer (`test/marketdata/fixtures.ts`, Fake-Adapter mit
  Request-Zählern, deterministische Kerzen, deterministische Uhr).
* Goldentest: Fake-Adapter → `syncVenue("FAKE")` → `scanUniverse()` liefert
  `funnel.scanned === 3` und ≥ 1 Eignungskandidat; derselbe Scan mit leerem
  Store lehnt mit `min-candles` (Kontrast ist Teil des Tests). Zweiter Test:
  Warmup überlebt „Neustart“ (neue Store-/Registry-Instanzen) und dupliziert
  im zweiten Lauf keine Bars.
* Architektur-Greps: kein `PrivateClient`/`apiKey` im Sync-Pfad, keine
  Credential-Header auf Public-Routen (`privateCalls === 0` gegen den
  Fixture-Server), `/api/markets` GET-only, keine Pfad-Interpolation aus
  `instrumentId`/`timeframe`, keine URLs/Kontrollzeichen in Fehlermeldungen.
* Request-Budget gemessen: 200 Instrumente × 4 Timeframes = exakt
  `1 + 1 + 200 + 800` Requests, Parallelität ≤ 8, sustained < 10 req/s.
* `npm run test:coverage:marketsync` (≥ 90 % Linien über `src/marketdata/**`).
  Gesamtsuite 1389/1389 grün; `npm run typecheck`, `npm run lint`,
  `npm run build`, `npm run docs:validate` grün.

### Migration

* Keine Schema-Änderung, keine Datenmigration. `npm run market:sync` ist
  optional, aber vor dem ersten Scan nach einem Deploy sinnvoll — ohne Warmup
  bleibt der Trichter leer (das ist der dokumentierte Zustand, nicht ein Fehler).

## [1.28.1] — 2026-08-30 · fix(universe): liveAvailable als Laufzeitprojektion (CAP-008)

**Fix (P1, sicherheitsrelevant im UI/API-Sinn):** Nach v1.26.4 wurden beide
Live-Flags aus der Capability-Matrix abgeleitet (`liveAvailable` ← `marketData`,
`liveTradable` ← `trading`). Das vermischte Produktabsicht mit technischer
Verfügbarkeit: PAPER erschien `liveTradable=true`, Stub-Venues konnten nicht
fachlich als live-vorgesehen markiert werden, und `liveAvailable` spiegelte
Marktdaten statt „jetzt live handelbar“.

### Added

* **`src/universe/capabilityProjection.ts`:** einzige Schreibstelle für
  `liveAvailable`. Konjunktion aus (1) `instrument.liveTradable`,
  (2) `capabilities[venue].trading`, (3) registrierter Nicht-Stub-Adapter und
  `capabilities.live`, (4) `venueEnabledFromEnv` (`${VENUE}_ENABLED`),
  (5) `evaluateLiveOrder(venue, { audit: false }).allowed`. Fail-closed;
  `reasons[]` nur symbolische Codes.
* **`src/brokers/adapterCatalog.ts`:** statisches Factory-Wissen (Stub vs. echt),
  ohne Adapter-Instanziierung.
* Startup-Check `assertTradingVenuesHaveRealAdapters()` in
  `src/instrumentation.ts`.
* API-Metadaten: `liveAvailabilityReasons`, `liveUnavailableBadge`, Tooltips.
* Ops-Sektion Market Universe: Kennzahlen + Badges für fachlich live-handelbare,
  technisch nicht verfügbare Instrumente.

### Changed / Fixed

* Seed: `liveTradable` persistiert (PAPER false, reale Venues true);
  `liveAvailable` bleibt Schema-Fehler im Seed.
* `NdjsonStore` persistiert `liveTradable`, nie `liveAvailable`.
* `resolveInstrumentCapabilities()` delegiert an den Projektor (Default
  `liveTradable=false` ⇒ fail-closed).
* Bitunix-Mapping nutzt `applyAvailabilityProjection({ liveTradable: true })`.
* Hilfe `docs/help/market-universe.help.json`: liveTradable ≠ Adapter existiert;
  liveAvailable ≠ Live-Trading aktiviert.

### Tests / Security

* `tests/capabilityProjection.test.ts`: fünf Bedingungen, Stub, PAPER, unknown
  Venue, Seed-Verbot, Startup-Check, Invariante `liveAvailable ⇒ trading`.
* Registry-Filter: 17 `liveTradable=true`, 0 `liveAvailable=true` (Gate zu).
* `/api/markets?venue=KRAKEN` → `liveTradable:true`, `liveAvailable:false`.
* Store-Serialisierung persistiert `liveTradable`, nicht `liveAvailable`.
* Live-Gate-Enforcement unverändert; dieser Fix öffnet keine Orders.

### Migration / Deployment

* `package.json` → **1.28.1**.
* Keine DB-Migration. Optional `npm run universe:seed` (schreibt `liveTradable`
  in die NDJSON, lässt `liveAvailable` weg).

Refs: CAP-008.

## [1.28.0] — 2026-08-30 · feat(symbols): zentrale, venue-aware Symbol-Normalisierung (SYM-007)

**Priorität P1** (abhängigkeitsfrei; vor MDSYNC-001 zu mergen, damit
Instrument-IDs von Anfang an kanonisch sind).

### Problem

Mindestens vier unabhängige Symbol-Regexe (`universe/validation.ts`,
`src/lib/marketData.ts`, `src/lib/ruleEngine.ts`, Bitunix-Adapter) existierten
mit leicht unterschiedlicher Semantik. Die Universe-Registry definiert `/`
explizit als gültige Notation (`KRAKEN:BTC/USD`), `marketData` und die
RuleEngine akzeptierten dagegen nur `BTCUSDT`, `EUR.USD`, `EURUSD=X` —
`BTC/USD` und `BTC-USD` wurden still abgelehnt. Folge: ein im Universum
gültiges Instrument verschwand lautlos im Laufzeit-/Regelpfad.

### Zielbild (umgesetzt)

Eine einzige venue-aware Normalisierungsschicht als Single Source of Truth:

```ts
normalizeVenueSymbol("KRAKEN", "xbt-usd");
// → { venue: "KRAKEN", canonical: "BTC/USD", venueNative: "XBTUSD",
//     instrumentId: "KRAKEN:BTC/USD", assetClass: "CRYPTO" }
```

### Hinzugefügt

- **`src/symbols/normalize.ts`** — Public API (`normalizeVenueSymbol`,
  `tryNormalizeVenueSymbol`, `isValidInstrumentId`, `isValidStorageSymbol`,
  `isValidVenueNativeSymbol`, `cleanRawSymbol`, injizierbare Warn-Senke).
- **`src/symbols/venueProfiles.ts`** — deklarative Venue-Profile
  (DEFAULT/PAPER/BINANCE/KRAKEN/BITUNIX/DYDX/ALPACA/IBKR), ReDoS-sichere
  negierte Zeichenklassen, Paar-Parser (FX-Suffix → Trenner → Alias-Präfix →
  Quote-Suffix → Einzelwert), Kraken-Alias `XBT ↔ BTC` (bijektiv),
  Korruptionsschutz für konkatenierte native Formen (Paar-Grenze nur bei
  bekannter Quote verlustfrei).
- **`src/symbols/errors.ts`** — `SymbolNormalizationError` (maschinenlesbarer
  Grund), `UnknownVenueProfileWarning` (Abfragepfad: Default-Profil +
  strukturiertes Log, kein Wurf), `UnknownVenueProfileError`
  (Registrierungspfad: `profilePolicy: "strict"`).
- **`src/symbols/idMigration.ts`** + **`scripts/normalize-instrument-ids.ts`**
  (`npm run symbols:normalize`, §3.4) — Dry-Run ist Default, `--apply` mit
  Backup `<datei>.bak-<ISO>` (chmod 600). Repariert nur strukturelle
  Korruption, meldet Alt-Notationen (`KRAKEN:BTC-USD`, `PAPER:EURUSD=X`) als
  Hinweis ohne Änderung, überspringt Unparsebares und Zielkollisionen,
  entfernt byte-identische Dubletten, idempotent. Exit-Codes 0/1/2 wie
  `history:migrate`.
- **Docs:** `docs/SYMBOLS.md` (Befund-Tabelle „Regex → Datei →
  akzeptiert/abgelehnt“, verbindliche Kanonisierungsregeln, Verhaltens-
  änderungen), `README.md` (Abschnitt „Symbol-Notation“),
  `docs/MARKET_DATA_PIPELINE.md` (§11 Referenz), `docs/MARKET_UNIVERSE.md`
  (§4 Cross-Ref zur SSoT; §9 „Symbol-Alias-Tabelle“ als erledigt geführt),
  `docs/HISTORY.md` (Instrument-ID = Speicherform, Verweis auf §4) und
  `docs/ARENA_TASKS.md` (Task 15).
- **Tests:** Golden (`tests/symbols/normalize.test.ts`), Property-basiert
  (`tests/symbols/normalize.property.test.ts` — deterministischer PRNG:
  wirft nie / Idempotenz / Kanon↔Nativ-Roundtrip / Injection-Invariante /
  ReDoS-Probe / Profil grenzen), Migration (`tests/symbols/idMigration.test.ts`).

### Geändert

- `src/lib/marketData.ts` — `sanitizeSymbol()` nutzt die SSoT (Venue `PAPER`)
  und liefert die kanonische Form; Quellen-Routing kanonisch-aware: Fiat/Fiat
  → Yahoo `<6 Buchstaben>=X` (externe URLs unverändert), Krypto → Binance
  (USD-Quote → `USDT`-Konvention); `STATIC_PRICES`-Fallback zusätzlich über
  die Krypto-Basis des Paares; Cache-Schlüssel kanonisch (dedupliziert
  Schreibweisen).
- `src/lib/ruleEngine.ts` — `sanitizeRuleSpec()` ersetzt ausschließlich das
  Symbol-Regex durch `tryNormalizeVenueSymbol()`. **Sicherheitsgrenzen
  unverändert** (§3.3): `RULE_ALLOWED_SIDE = "LONG"`, numerische Operatoren
  `lt, lte, gt, gte, eq, between, in`, Trend-Operatoren `eq, in`, alle
  Ceilings.
- `src/universe/validation.ts` — `VENUE_RE`/`SYMBOL_RE` sind Re-Exporte der
  SSoT (`STORAGE_SYMBOL_RE`, Storage-Semantik unverändert); bestehende
  Registry-IDs bleiben bestehen (Speicherform venue-nativ, kanonische Form
  daraus ableitbar).
- `src/brokers/bitunix/orders.ts` + `src/brokers/bitunix/mapping.ts` —
  `isValidVenueNativeSymbol("BITUNIX", …)` (venue-native Byte-Identität)
  statt lokalem `^[A-Z0-9]{2,20}$`.
- `src/lib/news.ts` — Finviz-Filter kanonisch-aware (jedes Paar/FX/Krypto
  bleibt ohne Finviz-Feed).
- `tests/security.test.ts` — Assertion auf kanonische FX-Form aktualisiert
  (`EURUSD=X` → `EUR/USD`) plus Abdeckung der neu akzeptierten Notationen;
  alle Injection-Ablehnungen unverändert grün.

### Sichtbare Verhaltensänderungen

| Aufruf | Vorher | Nachher |
| --- | --- | --- |
| `sanitizeSymbol("EURUSD=X")` | `"EURUSD=X"` | `"EUR/USD"` (Yahoo-Routing bildet weiter auf `EURUSD=X` ab) |
| `sanitizeSymbol("BTC/USD")` / `("BTC-USD")` | `null` | `"BTC/USD"` |
| `sanitizeSymbol("BTCUSDT")` | `"BTCUSDT"` | `"BTC/USDT"` |
| `sanitizeRuleSpec(symbol: "BTC/USD")` | abgelehnt | akzeptiert (kanonisch) |
| Längenlimit Abfragepfad | 12 (+5) | 24 gesamt, Einzel-Ticker ≤ 12 |

Vollständige Tabelle und Regeln: `docs/SYMBOLS.md` §6.

---

## [1.27.0] — 2026-08-30 · feat(operations): strukturierte Market-Data-Readiness-Diagnose (OPS-010)

**Nacharbeit zum Code-Review (CODE-REVIEW-SCANNER, Sections 14, 22, 26).**
Das Operations Center diagnostizierte den Backend-Zustand korrekt, zeigte
aber nur den **Endzustand** des Scanner-Funnels („Gescannt 26, Eligible 0“)
— nicht die granulare Pipeline-Diagnose entlang Discovery → Enrichment →
Backfill → Readiness. P2 (Diagnose-Erschwernis, kein funktionaler Bug).
Rein additive Änderung: bestehende Sektionen, Funnel-Metriken und das
„erste Regel gewinnt“-Routing des Eignungsfilters bleiben unverändert.

### Added — Backend/Aggregation

* **Neu `src/ops/marketDataReadiness.ts`** — `MarketDataReadinessReport`
  (`venue`, `registryCount`, `discoveredCount`, `dataReadyCount`,
  `warmingCount`, `candlesLoaded`, `candlesRequired`, `tickerReadyCount`,
  `spreadReadyCount`, `scannerReady`) und `collectMarketDataReadiness()`:
  reine Aggregation aus Instrument-Registry (`size`, `lastSeen`,
  `volume24h`, `spread`), Historical Store (Kerzenzahlen im
  Scanner-Timeframe über denselben Provider-Pfad wie der Scan) und
  `requiredWarmupCandles(config)`. **Kein Netzwerk-I/O.**
  - `discoveredCount`: `lastSeen` ≤ 24 h (`DISCOVERY_FRESHNESS_WINDOW_MS`).
  - `dataReadyCount`: Kerzen ≥ Bedarf (Grenzwert = ready) UND Ticker UND
    Spread bekannt; `warmingCount = registryCount − dataReadyCount`;
    `scannerReady = dataReadyCount > 0`.
  - Test-Hook `setMarketDataReadinessStoreForTests()` (Muster wie
    `setScannerServiceForTests`) für hermetische Integrationstests.
* **Neu `src/scanner/eligibilityDiagnostics.ts`** —
  `buildEligibilityDiagnostics()`: reichert `ScanResult.rejections` mit dem
  vollständigen Datenzustand (`candles`, `volume24h`, `spread`) an
  (Review Punkt 22). Aus „Instrument ungeeignet (`max-spread`)“ wird die
  Data-Quality-Aussage „Spread wurde nicht geladen“. Dateikopf fixiert:
  ausschließlich Monitoring/Debugging; Routing unverändert. Ausgabe auf
  `MAX_ELIGIBILITY_DIAGNOSTICS = 50` gedeckelt, `total` vollzählig +
  `truncated`-Flag (DoS-Schutz).
* **`src/ops/collect.ts`** — `collectMarketDataExtras()` als Erweiterung von
  `collectScanner()` (gleiche Scan-Config wie der angezeigte Funnel;
  fail-soft `null` bei Aggregationsfehler).
* **`src/auth/ops.ts`** — `buildOpsPayload(actor, data, extras?)`: optionaler
  dritter Parameter; 2-Argument-Aufrufe verhalten sich exakt wie zuvor.

### Added — API & UI (kein Breaking Change)

* `GET /api/ops`: neue optionale Felder `marketDataReadiness` und
  `eligibilityDiagnostics` (jeweils `null` bei fail-soft-Fehlschlag).
  Sektionen/Funnel unverändert (Integrationstest wacht über
  Metrik-Labels und Sektions-IDs).
* `src/components/ops/OperationsCenterPanel.tsx`: neue Karte **Market Data**
  direkt neben der Scanner-Karte — Zeilenformat exakt nach Review
  (Registry / Discovered / Data-ready / Warming / Candles X/Y /
  Ticker-ready / Spread-ready / Scanner-ready YES|NO) inkl. der
  vorgegebenen Tooltips („Scanner-ready: NO“, „Candles 0/61“) und
  einklappbarer Ablehnungs-Diagnose (Regel, Data-Quality-Kennzeichnung,
  Datenzustand je Instrument).

### Added — Dokumentation

* **Neu `docs/OPERATIONS_CENTER.md`** — Walkthrough „Wie diagnostiziere ich
  einen leeren Scanner-Funnel?“ (Registry → Discovered → Candles →
  Ticker-/Spread-ready → Scanner-ready), Diagnose-Lesart, API-Vertrag,
  Security/Performance; im Doku-Katalog (`src/lib/docsCatalog.ts`) und in
  `docs/README.md` registriert.
* `docs/MARKET_DATA_PIPELINE.md` §6 — Feldtabelle des
  `MarketDataReadinessReport` (exakte Zählregeln) + Diagnose-Format.
* `docs/help/ops.help.json` v3 — Feldhilfe `section.marketDataReadiness`
  (3-Ebenen-Schema).

### Tests

* **Unit (`tests/marketDataReadiness.test.ts`, 11 Tests):** leere Registry
  (alle Zähler 0, `scannerReady: false`); Regression Review-Ist-Zustand
  (26 Instrumente, 0 Kerzen → `registryCount 26, dataReadyCount 0,
  warmingCount 26, candlesLoaded 0, candlesRequired 61, scannerReady
  false`); Ziel-Zustand (180 Instrumente mit 150 Kerzen → `scannerReady
  true`, Summen korrekt); Boundary (`candleCount ===
  requiredWarmupCandles(config)` gilt als ready, −1 als warming);
  Frische-Fenster; Diagnose `spread: null` → `{ rule: "max-spread",
  data: { candles 150, volume24h 2840000000, spread: null } }` im
  Review-Format; Data-Quality ≠ fachlich; DoS-Deckel; Additivität von
  `buildOpsPayload`; SSR-Render der Market-Data-Karte.
* **Integration (`tests/opsReadiness.integration.test.ts`):** simulierter
  Sync-Durchlauf (Registry-Upsert + Historical-Store-Backfill wie
  `syncVenue`) → `GET /api/ops` → Report konsistent mit
  Registry-/HistoricalStore-Zustand, Funnel-Format unverändert, Diagnose
  deckt die 26 Seed-Ablehnungen (`min-candles`, Data-Quality), Idempotenz,
  Secret-Scan über den Payload.

### Security

* Report enthält nur aggregierte Zähler; Diagnose nur Instrument-IDs und
  öffentliche Marktmetriken — keine API-Keys, keine Adapter-Konfiguration,
  keine Pfade/Hostnamen (Payload-Secret-Scan im Integrationstest).
* Kein Netzwerk-I/O in der Aggregation; lineare Kosten, Antwort gedeckelt
  (`MAX_SERVICE_INSTRUMENTS`, `MAX_ELIGIBILITY_DIAGNOSTICS`) — keine
  DoS-Angriffsfläche.

**Refs:** CODE-REVIEW-SCANNER.md Sections 14, 22, 26 · **Version 1.27.0**.
## [1.26.4] — 2026-08-30 · Capability-SSoT für Instrument-Live-Flags (CODE-REVIEW-SCANNER §17)

**Fix (P1, sicherheitsrelevant im UI/API-Sinn):** Der statische Instrument-Seed
war eine zweite, falsche Quelle für `liveAvailable`/`liveTradable`. Mehrere
reale Venues (`BINANCE`, `KRAKEN`, `ALPACA`, `IBKR`) trugen im Seed
`liveAvailable: true`, obwohl die Adapter-Capability-Matrix für diese Venues
`discovery=false`, `marketData=false`, `trading=false` ausweist.

### Added

* **Neu `src/capabilities/resolveCapabilities.ts`:**
  `resolveInstrumentCapabilities(venue, capabilityMatrix)` ist der einzige
  Projektionspunkt für Instrument-Live-Flags. `liveAvailable` wird aus
  `marketData`, `liveTradable` aus `trading` abgeleitet; unbekannte Venues
  fallen sicher auf `{ liveAvailable:false, liveTradable:false }` zurück.
* **Neu `src/capabilities/matrix.ts`:** stabile Import-Fassade zur Capability-
  SSoT (`VENUE_CAPABILITIES`).
* **Neu `docs/CAPABILITIES.md`:** Definition von `discovery`, `marketData`,
  `trading` sowie der abgeleiteten Felder `liveAvailable` und `liveTradable`.

### Changed / Fixed

* `src/universe/seed.ts`: Header-Warnung ergänzt und alle
  `liveAvailable`-/`liveTradable`-Felder aus den Seed-Einträgen entfernt.
* `data/universe/instruments.ndjson` und
  `tests/fixtures/universe-instruments.ndjson`: versionierte Seeds enthalten
  keine Live-Projektionsfelder mehr.
* `normalizeInstrument()` und `validateInstrument()` ignorieren eingehende
  Live-Felder und projizieren sie aus der Capability-Matrix. Damit können auch
  alte NDJSON-Dateien mit falschen `true`-Werten die API nicht mehr täuschen.
* `NdjsonStore.serializeInstrument()` schreibt nur statische Felder; die
  Registry hält zur Laufzeit weiterhin vollständige `MarketInstrument`-Objekte
  für API-Kompatibilität.
* `InstrumentRegistry.query()` filtert `liveAvailable`/`liveTradable` über die
  Projektionsfunktion, nicht über persistierte Werte.
* `/api/markets` gibt für Kraken/Binance/Alpaca/IBKR-Instrumente
  `liveAvailable:false`/`liveTradable:false` aus, solange die Matrix deren
  `marketData`/`trading` auf `false` hält.
* `docs/MARKET_UNIVERSE.md`, `docs/BITUNIX.md`, `docs/README.md` und
  `src/lib/docsCatalog.ts` auf die neue SSoT-Dokumentation aktualisiert.

### Tests / Security

* Resolver-Tests: `BINANCE` → `false/false`, `BITUNIX` spiegelt die Matrix,
  unbekannte Venue → `false/false`.
* Strukturtest: kein `SEED_INSTRUMENTS`-Eintrag und keine versionierte
  Seed-NDJSON-Zeile enthält `liveAvailable` oder `liveTradable`.
* Regression: jede Nicht-PAPER-Stub-Venue im Seed projiziert
  `liveAvailable:false`.
* Integration: `/api/markets?venue=KRAKEN` liefert `liveAvailable:false`.
* Live-Trading-Gate und tatsächliche Order-Enforcement-Logik bleiben
  unverändert; dieser Fix betrifft ausschließlich Anzeige-/API-Projektion.

### Migration / Deployment

* `package.json` → **1.26.4**.
* Keine DB-Migration, keine neuen Pflicht-Env-Variablen.
* Optional: `npm run universe:seed`, falls lokale Seed-Dateien neu erzeugt
  werden sollen; die Serialisierung lässt Live-Projektionsfelder weg.

Refs: CODE-REVIEW-SCANNER.md Section 17.

---

## [1.26.3] — 2026-08-30 · Nacharbeit: Marktdaten-Fehler-Doku & Sync-Klassifikation (MDERR-006)

**Nacharbeit zu v1.26.1 (`fix(marketdata): stop swallowing fetch failures`).**
Die Fehlertaxonomie und Telemetrie bleiben unverändert; ergänzt werden die
Sync-Klassifikation am Abfangen, die explizite Aufrufer-Behandlung und der
Betriebs-Entscheidungsbaum.

### Added — Betriebsdokumentation

* **Neu `docs/ERROR_HANDLING_MARKETDATA.md`** — Entscheidungsbaum:
  „Wann wird geworfen vs. wann Cache vs. wann `DATA_UNAVAILABLE`“,
  vollständige Fehlertaxonomie (`RATE_LIMITED`/`UPSTREAM_5XX`/
  `UNAUTHORIZED`/`NOT_FOUND`/`INVALID_SYMBOL`/`SCHEMA_MISMATCH`/`TIMEOUT`/
  `NETWORK`/`TLS`/`ABORTED`/`UNKNOWN`) mit Zuordnung zu den generischen
  Ticket-Klassen (`SERVER_ERROR`/`NETWORK_ERROR`/`SCHEMA_ERROR`/…),
  Sync- und Operations-Center-Behandlung, Log-/Telemetrie-Regeln und
  Security-Audit (sanitized `cause`, kein Retry-Sturm bei 429).
* Doku-Katalog (`src/lib/docsCatalog.ts`) + `docs/README.md`: neues Dokument
  registriert und verlinkt.

### Changed — Fehlerbehandlung & Sync

* **`src/marketdata/sync.ts` + `src/marketdata/types.ts`:** `SyncError` trägt
  `reason`/`retryable`/`httpStatus`; Fehler werden direkt beim Abfangen
  klassifiziert (`classifyMarketDataError`), damit z. B.
  `BitunixApiError.httpStatus=429` unverfälscht als `RATE_LIMITED` in
  `SyncResult.errors` und im Manifest landet. Fehler bleiben pro Instrument/
  Timeframe isoliert (kein globaler Abbruch).
* **`src/marketdata/dataErrors.ts`:** Manifest/Map übernehmen nur echte
  Fetch-/Infrastrukturfehler (`reason` gesetzt, `stage != "upsert"`).
  Datenqualitäts-Warnungen (z. B. Ticker-Symbol-Abweichung) maskieren keine
  echten 429/5xx-Fehler mehr.
* **`src/lib/marketDataErrors.ts`:** `classifyMarketDataError()` erkennt
  JSON-Parse-/Syntax-Fehler (`SyntaxError`/`TypeError` mit JSON-Marker) als
  `SCHEMA_MISMATCH`; Inline-Kommentar zur Bedeutung der Klassifikation.
* **`src/lib/marketData.ts`:** strukturierte Log-Meldung mit explizitem
  `message`-Feld `[market-data] FETCH FAILED … infrastructure/API error … See
  docs/ERROR_HANDLING_MARKETDATA.md`.
* **`src/lib/analysts.ts` / `src/lib/monitor.ts`:** `getCandles()`-Aufrufer
  fangen `MarketDataFetchError` pro Symbol/Timeframe (TA, Macro, Swing,
  Marktmonitor) — ein Fehler bricht keine Loop ab und wird nie als „keine
  Daten“ normalisiert.
* **`docs/MARKET_DATA_PIPELINE.md`** §8: vollständige Fehlertaxonomie mit
  Behandlung durch Sync-Service und Operations Center.
* **`docs/OBSERVABILITY.md`:** Status auf v1.26.3; Verweis auf den
  Entscheidungsbaum; `message`-Feld im Log-Event.

### Tests

* `classifyMarketDataError()`: JSON-Parse (`SyntaxError`/`TypeError`) →
  `SCHEMA_MISMATCH`.
* `marketData.test.ts`: `market_data_fetch_failed` enthält den
  `FETCH FAILED`-Infrastrukturtext und den Doku-Verweis.
* `sync.test.ts`: `SyncError` behält `reason`/`httpStatus` bei 429,
  verbleibendes Instrument wird trotzdem synchronisiert.
* `sync.integration.test.ts`: voller Sync-Lauf mit 429 im Mock-HTTP-Kline-Pfad
  → `SyncResult.errors` (klassifiziert), übrige Instrumente weiter syncen,
  kein Private-Call.

### Security

* `cause` wird weiterhin nur als `{ name, code }` serialisiert — kein
  Stacktrace, keine Header/Query-Secrets.
* Metrik bleibt ohne `symbol`-Label (Kardinalität); `syncErrorsToDataErrors`
  und `saveMarketDataErrors` schreiben nur stabile Felder.
* 429 → begrenzter Retry + Token-Bucket/Backoff; kein Retry-Sturm bei
  systematischem Rate-Limiting.

### Migration / Deployment

* `package.json` → **1.26.3**.
* Keine Datenmigration, keine Env-Änderung.

Refs: CODE-REVIEW-SCANNER.md Section 9 · MDERR-006.

## [1.26.2] — 2026-08-29 · Nacharbeit: Versionierung, Changelogs & Migrations-Runbook (MDSYNC-001)

**Nacharbeit zu v1.26.0 (PR #40, `fix(history): persist candle timeframe and
deduplicate bars`).** Schema v2, Primärschlüssel `instrumentId + timeframe +
ts` und Dedup-Regel bleiben unverändert. Dieser Release schließt die
Doku-Lücken des Migrationspfads, härtet das Migrations-CLI ab und verankert
die Versionierung in der CI (`npm run docs:validate`).

### Added — Dokumentation & Nachweise

* **Neu `docs/MIGRATION_TIMEFRAME_FIELD.md`** — Runbook für
  Produktionsumgebungen: Wann es gilt, Fehlerbild, Entscheidungsmatrix
  **Neuaufbau (empfohlen) vs. Inline-Migration**, Schritt 0 (Voraussetzungen,
  `PAPER_HISTORY_DIR`), Schritt 1 (Schreiber stoppen — Next.js-App,
  `market-sync`, `scan --sync-first`; MicroExecutor schreibt nicht),
  Schritt 2 (Pflicht-Backup + Prüfsumme, `chmod 600`), Pfad A (Neuaufbau via
  `npm run market-sync -- --venue=BITUNIX`), Pfad B (Dry-Run → `--apply`),
  Bestimmung von `--assume-timeframe` über den Median der `ts`-Abstände
  (nie raten), Validierung mit erwarteten Sollwerten, Nachlauf, Rollback,
  Exit-Codes (`0` angewendet · `1` Abbruch/verworfene Zeilen · `2` nichts
  angewendet) und Sicherheitsregeln.
* **Task 14 in `docs/ARENA_TASKS.md`**: Timeframe-Dimension im Historical
  Store (MDSYNC-001) mit Version (`1.26.0`, Nacharbeit `1.26.2`), PR #40,
  Security- und Review-Spalte sowie Umsetzungs-/Nacharbeits-Detail.
* **`tests/docsVersioning.test.ts`** (neu): package.json-Version gegen beide
  Changelogs, Status-Header und `docs/README.md`; Runbook vorhanden, im
  Katalog (`src/lib/docsCatalog.ts`) und aus `docs/HISTORY.md` +
  `docs/MARKET_DATA_PIPELINE.md` verlinkt; `--apply`-Hinweis im
  Migrations-CLI.
* **`npm run docs:validate`**: neuer Check **Version-Konsistenz** —
  `package.json` muss mit dem obersten Eintrag beider Changelogs, dem
  Status-Header der `CHANGELOG.md` und der Versionszeile in `docs/README.md`
  übereinstimmen.

### Changed — Migrationspfad & Katalog

* **`docs/MARKET_DATA_PIPELINE.md` §5.3 (neu):** „Empfohlener
  Migrationspfad: Neuaufbau statt Inline-Migration“ — für den Bitunix-Feed
  ist der Neuaufbau über `npm run market-sync` der empfohlene Weg (150 Bars
  je Instrument und Timeframe, `5m/15m/30m/1h`, public REST, Timeframe aus
  dem Backfill-Kontext statt aus einer Annahme). Die Inline-Migration bleibt
  bewusst nur Sicherheitsnetz für Umgebungen ohne Netz-/Rate-Limit-Spielraum.
* **`docs/MARKET_DATA_PIPELINE.md` §5.2** und **`docs/HISTORY.md` §6**:
  CLI-Beispiele auf den neuen Dry-Run-Default umgestellt, Exit-Codes
  dokumentiert, Link auf das Runbook.
* **`docs/README.md` + `src/lib/docsCatalog.ts`:** `docs/HISTORY.md` und
  `docs/MIGRATION_TIMEFRAME_FIELD.md` im Doku-Katalog (`GET /api/docs`)
  registriert; Versionszeile aktualisiert.

### Security — Migrationsskript

* **`scripts/migrate-history-timeframe.ts`: Dry-Run ist der Default.**
  Ohne das explizite Flag `--apply` wird **nichts** geschrieben und **kein**
  Backup angelegt; der Lauf endet mit Exit-Code **2** und einem Hinweis auf
  das Runbook. Damit ist der Audit-Punkt „Migrationsskript darf keine
  Produktionsdaten ohne explizite Freigabe verändern“ erfüllt.
* Der Kern (`src/history/migration.ts`, `migrateHistoryFile()`) ist
  unverändert: Backup `0600` vor dem Schreiben, Abbruch bei
  Backup-Fehlschlag, Idempotenz, Verlust-Invariante
  `gelesen == geschrieben + dedupliziert + verworfen`.

### Migration / Deployment

* Für Umgebungen, die bereits Schema v2 nutzen: **keine** Datenmigration.
* Für Altbestand (Zeilen ohne `timeframe`) gilt — zuerst **ohne** `--apply`
  prüfen, dann anwenden:

```bash
npm run history:migrate -- --file=data/history/candles.ndjson \
  --assume-timeframe=15m            # Dry-Run (Default)
npm run history:migrate -- --file=data/history/candles.ndjson \
  --assume-timeframe=15m --apply    # schreibt, mit Backup
```

* Empfohlen bleibt der **Neuaufbau**: Backup → Altdatei entfernen →
  `npm run market-sync -- --venue=BITUNIX` → validieren (Kap. 8 des
  Runbooks).
* `package.json` → **1.26.2**.

---

## [1.26.1] — 2026-08-29 · Typisierte Marktdaten-Fehler statt stiller leerer Arrays (MDERR-006)

**Fix (P1, Observability-/Sicherheitsdefekt):** `getCandles()` in
`src/lib/marketData.ts` bildete HTTP 429/5xx, DNS-Fehler, ungültige Symbole,
Schema-Abweichungen und TLS-Fehler alle auf `[]` ab
(`catch { return cached?.candles ?? []; }`). Downstream erschien das als
`min-candles`-Ablehnung — „Netzwerkfehler“ war nicht von „0 Kerzen vorhanden“
unterscheidbar. In einem Trading-System ist das zusätzlich ein Risikoproblem:
eine leere Serie kann Faktoren neutralisieren, statt eine Ausführung zu
stoppen.

### Changed — Sicherheit / Fehlerbehandlung

* **Neu `src/lib/marketDataErrors.ts`:**
  * `MarketDataFetchError` mit `venue`/`symbol`/`timeframe`/`reason`/
    `retryable`/`httpStatus`/`cause` und **redigiertem** `toJSON()` (kein
    Stacktrace, kein `cause`-Text, keine vollen URLs).
  * `classifyMarketDataError()`: vollständige Ursachen-Taxonomie
    (`MarketDataErrorReason`: RATE_LIMITED, UPSTREAM_5XX, UNAUTHORIZED,
    NOT_FOUND, INVALID_SYMBOL, SCHEMA_MISMATCH, TIMEOUT, NETWORK, TLS,
    ABORTED, UNKNOWN) mit `retryable`-Flags.
  * Fehler-Message-Template macht explizit: „Infrastrukturfehler, KEIN
    ‚keine Historie vorhanden‘ — der Scanner meldet dafür DATA_UNAVAILABLE.“
* **`getCandles()` wirft** bei echten Fehlern; das stille Cache-Fallback
  `?? []` ist entfernt. Leere Venue-Antworten (`[]`) bleiben gültig und
  werden gecacht („nachweislich keine Bars“) — die Abgrenzung ist getestet.
* **Neu `getCandlesWithFallback()`**: bewusste Degradations-API für z. B.
  UI-Preview mit expliziter Staleness — `{ candles, source: "live"|"cache",
  stale, ageMs, error? }`; ohne Cache-Eintrag wird geworfen.
* **Neu `src/lib/telemetry.ts`**: Counter
  `market_data_fetch_failures_total{venue,timeframe,reason}` — bewusst
  **ohne `symbol`-Label** (Kardinalität/Speicher-DoS), Symbol nur im Log.
  Prometheus-Text-Exposition für späteres Scraping.
* **Neu `src/lib/logger.ts`**: strukturierte JSON-Logs mit Redaction
  (`redactSecrets`), Einzeilen-Normalisierung und 512-Zeichen-Kappe —
  Events `market_data_fetch_failed`, `market_data_fetch_retry`,
  `market_data_unauthorized_public_endpoint` (`critical`: Public-Pfad mit
  401/403 = Konfigurationsfehler).
* **Retry-Budget:** `MARKET_DATA_FETCH_ATTEMPTS = 2` mit Backoff
  (250 ms × Versuch), nur retryable Ursachen (429/5xx/Timeout/Netzwerk) —
  kein Endlos-Retry, nicht-retryable Fehler werden sofort geworfen.
* **Scanner (Readiness/Routing):**
  * Sync-Fehler werden als persistentes Manifest
    (`data/market-data-errors.json`, `src/marketdata/dataErrors.ts`,
    gitignored) in `dataErrors: Map<instrumentId, reason>`
    übersetzt und an `assessDataReadiness()` gereicht → Status `ERROR`.
  * Neue Filterregel **`data-unavailable`** (vor `min-candles`): ein
    Abruf-Fehler wird nie als `min-candles` gemeldet.
  * `ScannerService` liest das Manifest standardmäßig; `run-scan`-CLI mutiert
    bei Sync-Fehlern nicht mehr den Ablauf — Readiness `ERROR` + Exit-Code 1.
* **MicroExecutor-Warmstart:** Seed-Fehler werden gezählt und geloggt
  (`status().seed`, Event `micro_executor_seed_fetch_failed`); Live-Kerzen
  wärmen weiter, aber der Fehler bleibt beobachtbar (kein „offline, alles ok“).
* **Backtest-Route:** `MarketDataFetchError` → HTTP 503
  `MARKET_DATA_UNAVAILABLE` mit `reason` (redigiert, kein Stacktrace).

### Added — Beobachtbarkeit

* Operations Center (Scanner-Sektion): Metrik
  „Marktdaten-Abruffehler (`market_data_fetch_failures_total`)“ inkl.
  Ops-Tooltip (RATE_LIMITED → Budget, UPSTREAM_5XX → Venue).
* Hilfe-Eintrag `metric.marketDataFailures` in `docs/help/ops.help.json`.
* Neu **`docs/OBSERVABILITY.md`** (Taxonomie, Metriken, Logs, Redaction,
  Sicherheits-Audit), registriert im Doku-Katalog (`src/lib/docsCatalog.ts`)
  und in `docs/README.md`.

### Tests

* Neu `tests/marketDataErrors.test.ts` (32 Assertions): Äquivalenzklassen
  der Klassifizierung, Template, Serialisierung/Redaction, Log-Injection.
* Neu `tests/marketData.test.ts`: Beobachtbarkeit, leere-Array-Abgrenzung,
  Metrik-/Log-Emission, `getCandlesWithFallback` (stale + Fehler sichtbar),
  Scanner-`DATA_UNAVAILABLE`, Readiness `ERROR`, Retry-Budget, Manifest.
* `tests/scanner.funnel.test.ts`: Filterregel `data-unavailable`.
* `tests/microExecutor.test.ts`: Warmstart-Fehler sichtbar.
* `npm run typecheck` und `npm run docs:validate` grün.

### Migration / Deployment

* Keine DB-Migration. `package.json` → **1.26.1**.
* Neu gitignored: `data/market-data-errors.json*` (Laufzeit-Artefakt).

---

## [1.26.0] — 2026-08-29 · Timeframe-Dimension im Historical Store + v1→v2-Migration (MDSYNC-001)

**Breaking Change (P1, Schema-/Architekturfehler mit Korruptionspotenzial):**
`HistoricalCandleEntry` besaß kein `timeframe`-Feld. Sobald mehrere
Periodizitäten desselben Instruments persistiert wurden
(`BITUNIX:BTCUSDT / 5m`, `/15m`, `/1h`), waren die Bars im Store nicht mehr
unterscheidbar. Der Loader hätte 5m- und 1h-Kerzen zu **einer** Faktorreihe
vermischt — jede EMA, jedes Momentum, jede Volatilität wäre danach
mathematisch bedeutungslos gewesen, ohne dass ein Test oder Filter Alarm
schlägt. Zusätzlich fehlte eine deterministische Deduplizierung
(wiederholter Backfill erzeugte doppelte Bars mit identischem `ts`).

### Migration (PFLICHT für bestehende `candles.ndjson`)

```bash
# 1. trocken prüfen (schreibt nichts, kein Backup)
npm run history:migrate -- --file=data/history/candles.ndjson \
  --assume-timeframe=15m --dry-run
# 2. migrieren (Backup candles.ndjson.bak-<ISO>, chmod 600, idempotent)
npm run history:migrate -- --file=data/history/candles.ndjson \
  --assume-timeframe=15m
```

`--assume-timeframe` ist Pflicht, sobald die Datei Legacy-Zeilen enthält:
5m- und 1h-Bars sind im alten Schema ununterscheidbar, ein erratener Wert
würde die Reihen dauerhaft falsch beschriften — das Skript rät nie.
Rollback: das Backup über die Zieldatei zurückspielen
(siehe [`docs/HISTORY.md`](HISTORY.md)).

### Changed — Breaking

* **`HistoricalCandleEntry`** führt `timeframe: SupportedTimeframe` als
  Pflichtfeld; jede Zeile trägt die Schema-Version `"v": 2`.
* **Logischer Primärschlüssel** ist jetzt `instrumentId + timeframe + ts`
  (statt `instrumentId + ts`).
* **`append()`** hat die Signatur
  `append(candles, instrumentId, provenance, timeframe, now): AppendResult`
  (`{ written, deduplicated }`). Die alte 4-stellige Signatur wurde
  **entfernt, nicht überladen** — TypeScript zwingt jeden Aufrufer zur
  Migration.
* **`query()`** verlangt `timeframe` zwingend
  (`{ instrumentId, timeframe, from?, to?, limit? }`); fehlt er, wirft die
  Methode auch zur Laufzeit einen `HistoricalStoreError` (Runtime-Guard für
  JS-Aufrufer).

### Added

* **Deterministische Deduplizierung:** Bei Schlüsselkollision gewinnt der
  Eintrag mit dem jüngsten `fetchedAt`; bei Gleichstand der zuletzt
  gelesene. `append()` liefert `{ written, deduplicated }`.
* **`SupportedTimeframe`-Allowlist** (`1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h,
  1d, 5d`); ungültige Werte werden beim Schreiben/Laden abgewiesen.
* **Legacy-Behandlung zur Laufzeit:** Zeilen ohne `timeframe` werden als
  `LEGACY_UNKNOWN` markiert, gezählt und über Timeframe-Queries **nie**
  ausgeliefert; beim ersten Fund erscheint eine einmalige Warnung mit
  Migrationshinweis.
* **`readAll()`** für Scanner-Provider/Wartung (Querlesezugriff, Zeitreihen-
  Auswahl mit Timeframe-Präferenz); `count(instrumentId?, timeframe?)`.
* **`maxBarsPerSeries`** (Default 5000) mit Kompaktierung je Reihe.
* **`scripts/migrate-history-timeframe.ts`** / `npm run history:migrate`
  (`src/history/migration.ts`): Backup, `--dry-run`, Dedup, Sortierung
  (`instrumentId, timeframe, ts`), Report
  (gelesen/migriert/dedupliziert/verworfen mit Gründen), idempotent.
* **Streambasierter Loader** (feste Lese-Chunks, kein OOM); kaputte
  Teilzeilen werden geloggt und übersprungen; atomare Schreibvorgänge
  (`tmp` + `rename`), Dateirechte `0600`.

### Migration der Aufrufstellen

* `MarketDataSyncService` (`src/marketdata/sync.ts`) schreibt mit
  `timeframe` und verarbeitet `AppendResult`; die Timeframe-Optionen sind
  auf die Allowlist typisiert.
* `MarketDataManager` (`src/lib/marketdata/manager.ts`) markiert
  Snapshot-Einzel-Tick-Kerzen als `"1m"`.
* `ReplayFeed` (`src/lib/marketdata/feeds/replay.ts`) bekommt einen
  optionalen `timeframe` (Default `DEFAULT_ANALYSIS_TIMEFRAME = "1h"`).
* Scanner-Provider (`src/scanner/service.ts`) liest über `readAll()` und
  wählt je Instrument deterministisch eine Reihe (Präferenz
  `1h → 4h → 30m → 15m → 5m`, Legacy-Fallback zuletzt).
* Analytics-Port (`src/cycle/ports.ts`) und Backtest-Step
  (`src/cycle/steps/backtestStep.ts`) fragen den Analyse-Timeframe (`1h`)
  explizit an.
* Der **MicroExecutor** (`src/lib/microExecutor.ts`) nutzt den
  HistoricalStore nicht (er bezieht Kerzen über den Live-/REST-Pfad
  `getCandles()` und hält eigene `RollingTimeframeSeries` im RAM) und ist
  von der Schema-Änderung nicht betroffen.

### Tests

* **`tests/history/historicalStore.test.ts`** (neu): Timeframe-Isolation,
  Dedup, „jüngstes `fetchedAt` gewinnt", gleiche `ts` in verschiedenen
  Timeframes, aufsteigende Sortierung, `limit`, inklusive `from`/`to`-
  Grenzen, fehlende Datei, kaputte Zeilen, Legacy-Ausschluss, Idempotenz,
  v2-Format, `maxBarsPerSeries`, Dateirechte `0600`, Prototype-Pollution,
  Zeilen-Injection, Eingabevalidierung.
* **`tests/history/migration.test.ts`** (neu): `timeframe`-Zuweisung,
  Idempotenz, Pflicht-Flag `--assume-timeframe`, Backup vor dem Schreiben,
  `--dry-run` ohne Dateiänderung (Hash), Verlust-Invariante
  `gelesen = geschrieben + dedupliziert + verworfen`.
* Bestehende Tests (`marketdata.replay`, `scanner.service`, Sync-Tests) auf
  die 5-Argument-`append`-Signatur und Pflicht-`query`-Timeframe migriert.

### Doku

* Neu: **`docs/HISTORY.md`** (Schema, Schlüssel, Dedup-Regel,
  Migrationsanleitung, Rollback, Sicherheit).
* Aktualisiert: `docs/MARKET_DATA_PIPELINE.md` Kap. 4–5 (Backfill mit
  Timeframe, Persistenz v2, Migration).
* Version auf **1.26.0** gesetzt (`package.json`); `npm run history:migrate`
  ergänzt; Test-Glob um `tests/history/*.test.ts` erweitert.

### Sicherheit

Kein Path-Traversal (Store schreibt ausschließlich in den konfigurierten
Pfad); Zeilen per `JSON.stringify` (keine Zeilen-Injection); Validierung
aller Werte (`Number.isFinite`, positive Ganzzahl-`ts`, Timeframe-Allowlist);
feldweises Parsing ohne Spread (`__proto__`/`constructor` werden verworfen);
Backups `0600`; streambasiertes Laden ohne unbegrenztes In-Memory-Wachstum.

---

## [1.25.3] — 2026-08-29 · Deterministischer Warmup-Bedarf + expliziter Scanner-Readiness-Zustand (OPS-009)

**Fix (P1, CODE-REVIEW-SCANNER Kap. 6/21):** `filters.minCandles = 30` war
inkonsistent zum konfigurierten Faktorsatz (EMA50 → 50 Kerzen,
Momentum-Lookback 60 → 61 Kerzen). Instrumente passierten den `min-candles`-Filter
mit 30 Kerzen, die Faktoren lieferten danach jedoch unvollständige bzw. implizit
gepaddete Scores — ein **stiller Datenqualitätsfehler**, der Ranking und Routing
verfälscht. Zusätzlich war „keine Historie geladen“ (Infrastruktur) nicht von
„Markt ungeeignet“ (Fachlogik) unterscheidbar.

### Added

* **`src/scanner/warmup.ts`** — `requiredWarmupCandles(config)`: die **einzige**
  Quelle der Warmup-Wahrheit, abgeleitet aus dem Faktorsatz
  (`max(trend.slowPeriod, …momentum.lookbacks, drawdown.lookback,
  volatility.lookback + 1, volumeRatio.basePeriods) + 1`, aktuell **61**). Kein
  hartcodierter Wert — wer einen Lookback erhöht, erhöht automatisch den
  Warmup-Bedarf. Zusätzlich auf `MAX_WARMUP_CANDLES = 1000` gedeckelt
  (Security: kein Massen-Fetching bei fehlerhafter Config).
* **`src/scanner/warmup.ts`** — `assessDataReadiness(...)`: **reine** Funktion
  (kein I/O, keine Uhr, keine Mutation) mit den Regeln
  `dataErrors ≠ ∅ → ERROR` (Infrastruktur schlägt Fachlogik), sonst
  `warmed === instruments.length ? READY : WARMING`. `worstOffenders`
  deterministisch sortiert (candles asc, dann instrumentId asc), auf 10
  begrenzt.
* **`src/scanner/readiness.ts`** — Typen `ScannerReadiness =
  READY | WARMING | ERROR` (+ `ReadinessOffender`, `ReadinessFailure`).
* **`ScanResult.readiness`** + **`ScanResult.requiredCandles`**: der Funnel wird
  unverändert weiter berechnet (kein Routing-Verhalten geändert); Readiness ist
  eine zusätzliche, getrennte Information. `scanUniverse` akzeptiert optional
  `dataErrors` (aus MDERR-006).
* Ops-Sektion Scanner (`src/ops/collect.ts`): neue Kennzahlen `Readiness` und
  `Warmup (gewärmt / benötigt)` inkl. erklärendem Tooltip; Notiz unterscheidet
  Warmup/Datenfehler von leerem Trichter.
* CLI (`scripts/run-scan.ts`): meldet den Readiness-Zustand zuerst, inkl.
  worstOffenders bzw. Datenfehler.
* Tests: `tests/scanner.warmup.test.ts`, `tests/scanner.readiness.test.ts`
  (Herleitung, Reaktion auf Config-Änderungen, Max-über-Faktoren, Grenzfälle
  n = 61/60, ERROR-Dominanz, Determinismus/Kappung der worstOffenders, Purity
  via `Object.freeze`, keine sensiblen Pfade), zusätzliche Config- und
  Pipeline-/Snapshot-Tests.

### Changed

* **`filters.minCandles` ist jetzt optional.** Ohne expliziten Wert wird der
  Warmup-Bedarf aus dem Faktorsatz abgeleitet
  (`minCandles ?? requiredWarmupCandles(config)`). `scanner.config.json` und
  `DEFAULT_SCANNER_CONFIG` setzen den Wert nicht mehr hart auf `30`.
* **Config-Validierung** (`validateScannerConfig(raw, { strict?, onWarn? })`):
  ein explizit gesetzter `minCandles < requiredWarmupCandles` erzeugt eine
  **Warnung** (Strict-Modus: Fehler) mit Handlungsempfehlung, statt still
  schwächere Regeln zu aktivieren. Lookbacks werden weiterhin auf positive
  Ganzzahlen validiert (negative/NaN → Startup-Fehler).
* **`checkEligibility(candidate, config)`** nimmt jetzt die vollständige
  `ScannerConfig` (statt nur `FilterConfig`), um Schwellwert **und** erklärende
  Message aus dem Faktorsatz abzuleiten. Die `min-candles`-Rejection nennt jetzt
  die Herkunft des Schwellwerts und ist explizit als Datenverfügbarkeits-, kein
  Marktqualitätsproblem markiert (`dataQuality: true` bleibt).

### Security

* `requiredWarmupCandles` ist auf `MAX_WARMUP_CANDLES = 1000` gedeckelt, damit
  eine fehlerhafte Config keinen candleLimit-Massen-Fetch auslösen kann.
* Faktor-Lookbacks werden auf `Number.isInteger` und positive Range geprüft.
* Die Readiness-Ausgabe redigiert URLs und Pfade aus Fehlerbegründungen (keine
  Hostnamen/Secrets).

### Docs

* `docs/MARKET_DATA_PIPELINE.md` Kap. 6 (Readiness) auf den abgeleiteten
  Warmup-Bedarf und den `READY | WARMING | ERROR`-Zustand umgestellt; §8
  Data-Quality-Tabelle aktualisiert.
* `docs/DAILY_WEEKLY_RESEARCH.md` Filtertabelle: `min-candles`-Schwelle jetzt
  „abgeleitet (61)“.
* Doku-Stand auf 1.25.3 aktualisiert.

---

## [1.25.2] — 2026-08-29 · Instrument-Enrichment: volume24h + Orderbook-Spread (PR #35 nachgearbeitet)

**Nacharbeit zu FEHLER-3 (P0, CODE-REVIEW-SCANNER §4/§5):** Discovery
(`trading_pairs`) liefert ausschließlich statische Handelsparameter (`symbol`,
`base`, `quote`, `minTradeVolume`, Präzisionen, `maxLeverage`, `symbolStatus`,
`isApiSupported`) — **keine** Liquiditäts- oder Preismetriken. Ohne Enrichment
ist `spread` für jedes Instrument `null`; der `spread`-Faktor besitzt keinen
Fallback, also scheitern **alle** Instrumente an der `max-spread`-Regel, selbst
nach einem Candle-Backfill. Der Funktionsumfang wurde mit **PR #35** geliefert
(dort selbst als 1.24.1 geführt); dieser Release konsolidiert Versionierung,
Changelogs und Dokumentationsstand nachträglich — analog zur Nacharbeit zu
PR #33 (1.25.0) und PR #34 (1.25.1).

### Added

* **`src/marketdata/spread.ts`** — `calculateRelativeSpread(bid, ask)`:
  `(ask − bid) / mid`, `mid = (ask + bid) / 2`. Fehlende, nicht-positive,
  invertierte (`bid > ask`) oder nicht-endliche Werte liefern `null`
  („nicht geladen“) — nie `0`, nie `NaN`, nie eine Exception. Mit `typeof`-Guard,
  damit JSON-`null`/Strings/`±Infinity` sicher `null` ergeben.
* **`FilterRejection.dataQuality`** (`src/scanner/filters.ts`) — kennzeichnet
  Ablehnungen wegen fehlender Daten (`min-candles`, `min-volume`, `max-spread`,
  `max-execution-cost`) gegenüber fachlichen Marktgründen; die Meldungen nennen
  die fehlende Metrik explizit („Spread wurde nicht geladen …“). Wird von
  `GET /api/universe/score/{id}` 1:1 mitgeliefert (`rejection`).
* **Tests** — `src/marketdata/__tests__/spread.test.ts` (Golden
  `100/100.02 ≈ 0.00019998`, Toleranz 1e-8, Edge Cases), Enrichment-,
  Batch-Ticker-, Fallback- und Rate-Limiter-Tests in `sync.test.ts`,
  gehärtete Integration (`volume24h > 0` **und** `spread !== null`,
  0 Credential-Header), Data-Quality-Tests in `tests/scanner.funnel.test.ts`.

### Changed

* **`MarketDataSyncService.syncVenue()`** — feste Reihenfolge je Instrument:
  `getTicker` (bzw. 1× `getTickers`-Batch) → `volume24h`, `getOrderBook` →
  `calculateRelativeSpread` → **ein** `registry.upsert` mit
  `{ ...instrument, volume24h, spread, lastSeen }`, danach der Candle-Backfill.
* **Symbol-Guard** im Sync: Ein per-Symbol-Ticker wird nur bei exakter
  Symbol-Übereinstimmung übernommen (sonst `volume24h: null` +
  `SyncResult.errors`, `stage: "ticker"`), damit kein fremdes Volumen
  geschrieben wird.
* **Doku** — [`MARKET_DATA_PIPELINE.md`](MARKET_DATA_PIPELINE.md) §2–§3 mit
  Ende-zu-Ende-Datenfluss (`trading_pairs → tickers → volume24h → depth →
  spread → kline → HistoricalStore → Scanner`) und §8 mit der
  Data-Quality-Tabelle; [`BITUNIX.md`](BITUNIX.md) §1.2: Der Spread kommt
  **nicht** aus der Ticker-API, sondern aus dem Orderbuch — 1 zusätzlicher
  `/depth`-Call je Instrument; [`DAILY_WEEKLY_RESEARCH.md`](DAILY_WEEKLY_RESEARCH.md)
  mit Rejection-Shape (`dataQuality`). Doku-Stand auf 1.25.2 aktualisiert.

### Security

* Public-Endpoints (`trading_pairs`, `tickers`, `depth`, `kline`) senden keine
  Credential-Header (`sign`, `api-key`, `nonce`, `timestamp`, `authorization`) —
  je Request getestet; unnötige Credential-Exposition bleibt ausgeschlossen.
* Rate-Limit-Eskalation bei N Instrumenten (z. B. 180 × `depth`) läuft
  sequenziell durch den Token-Bucket (8 req/s) — kein Sekunden-Burst
  (Limiter-Zählung und Maximal-Parallelität 1 sind getestet).

---

## [1.25.1] — 2026-08-29 · Public Market Data in den Scanner-Warmup verdrahtet (PR #34 nachgearbeitet)

**Nacharbeit zu FEHLER-2 (P0) aus CODE-REVIEW-SCANNER §2/§3:** Der
`BitunixBrokerAdapter` besaß funktionsfähige Public-Pfade (Discovery, Ticker,
Klines, Depth), wurde vom `MarketDataSyncService` aber nie aufgerufen — der
Sync-Pfad nutzte ausschließlich den parallelen, redundanten
`BitunixMarketDataAdapter`-Wrapper. Dieser Release verdrahtet den konkreten
Adapter über die zentrale Registry in die Pipeline und entfernt den Wrapper.

### Added

* **`src/marketdata/adapterRegistry.ts`** — `AdapterRegistry`
  (`createAdapterRegistry()`): die **einzige** Stelle, die konkrete
  `MarketDataAdapter`-Implementierungen instanziiert. Registriert
  `BitunixBrokerAdapter` unter `"BITUNIX"` (Modus `"paper"`, **ohne**
  `PrivateClient`/Credentials); unbekannte Venues liefern `undefined`
  (Normalisierung via `sanitizeVenue`, case-insensitiv). Mit
  `registerVenues: false` registriert die Registry keine Venue (isolierte Tests).
* **`BitunixBrokerAdapter.getTickers()`** — 1 × Batch-Call `GET /tickers`
  (ohne Symbolfilter) für das Enrichment aller Instrumente; der Sync
  bevorzugt den Batch, wenn der Adapter `getTickers` anbietet (Fallsfall:
  N × `getTicker(symbol)`).
* **Tests** — `tests/bitunix.marketdata.test.ts`: Interface-Konformität
  (Compile-Time-Check `const _typeCheck: MarketDataAdapter = adapter`),
  Registry-Mapping (`"BITUNIX"` → Instanz, `"UNKNOWN"` → `undefined`),
  Orderbook-Mapping gegen das `/depth`-Schema, Edge Case (leeres
  `trading_pairs` → `[]`, kein Crash im Sync-Service), Security-Audit
  (statisch + dynamisch: kein PrivateClient/Keys im Discovery-Pfad,
  `privateCalls === 0`, keine Credential-Header) und Rate-Limit-Regression
  (429 → Retry mit Backoff 200/400 ms; persistente 429 →
  `BitunixApiError(kind: "rate-limit")`). Fixture:
  `tests/fixtures/bitunixMockClient.ts` (In-Process-Public-Mock, null-arg).

### Changed

* **`BitunixBrokerAdapter implements BrokerAdapter, MarketDataAdapter`** —
  explizite Interface-Erfüllung statt paralleler Implementierung.
* **`getCandles(symbol, timeframe, limit)`** — Signatur um `limit`
  erweitert (Default 120); der Sync backfilled 150 Kerzen je Timeframe.
* **`scripts/run-market-sync.ts`** — ruft produktiv `syncVenue("BITUNIX")`
  über `createAdapterRegistry()` auf.
* **`src/marketdata/index.ts`** — exportiert die Registry statt des Wrappers.
* **Integrationstest** `src/marketdata/__tests__/sync.integration.test.ts`
  läuft Ende-zu-Ende über Registry + Mock-HTTP-Layer → befüllte
  `InstrumentRegistry` und `HistoricalStore`.
* **Doku** — [`BITUNIX.md`](BITUNIX.md) §1.1: Vier-Ebenen-Trennung (Public
  Market Data / Private Trading API / Paper Execution / Live Execution) mit
  Credentials-Spalte; [`MARKET_DATA_PIPELINE.md`](MARKET_DATA_PIPELINE.md):
  Venue-Matrix mit `BitunixBrokerAdapter`-Zeile und `AdapterRegistry` im
  Architektur-Diagramm. Doku-Stand auf 1.25.1 aktualisiert.

### Removed

* **`src/marketdata/adapters/bitunix.ts`** — redundanter
  `BitunixMarketDataAdapter`-Wrapper. Keine zweite Implementierung der
  Public-Pfade mehr; ein Adapter deckt Broker- und Market-Data-Contract ab.

### Security

* Im Sync-Pfad laufen ausschließlich **Public**-Client-Methoden
  (`trading_pairs`, `tickers`, `depth`, `kline`) — `PrivateClient` bleibt für
  die Order-Ausführung über `getBroker()` (Broker-Factory) getrennt.
* Public-Requests senden keine Credential-Header (`sign`, `api-key`,
  `nonce`, `timestamp`, `authorization`) — je Request getestet; unnötige
  Credential-Exposition auf Public-Endpunkten ist ausgeschlossen.
* `src/scanner/*` importiert keinen konkreten Adapter (statisch getestet) —
  der Scanner bleibt netzwerkfrei.
* 401/403/429/5xx-Handling des HTTP-Clients unverändert (die 48
  existierenden Bitunix-Tests sind nicht regressiert); volle Suite
  1140/1140 grün.

---

## [1.25.0] — 2026-08-29 · Markt-Daten-Sync-Pfad (nachträglich PR #33)

**Nacharbeit zur Architekturänderung (nachträglich für PR #33):** Der Scanner
(`scanUniverse()`) las bisher nur die lokale, oft leere Historie
(`data/history/candles.ndjson`). Ohne einen vorherigen Warmup-Lauf war der
Trichter leer. Dafür gibt es jetzt einen **eigenen Sync-Pfad** vor dem Scan —
deterministisch, ohne den Scanner zu verändern.

**Architektur (nach PR #33):**

```
Venue-Adapter (public REST) → MarketDataSyncService → Registry + HistoricalStore
                                                      → Scanner (weiterhin ohne Netz)
```

* `MarketDataAdapter.discoverInstruments()` (1×) → Registry
* `MarketDataSyncService.syncVenue()` (1× Batch-Ticker, N× Depth, N× 4 Timeframes)
* `scanUniverse()` bleibt deterministisch und netzwerkfrei; `/api/markets` bleibt read-only.

**Neu / bestätigt (nachträglich):**

* `src/marketdata/` — `MarketDataAdapter`, `MarketDataSyncService`, `Spread`,
  `UnsupportedVenueError`, `Bitunix-Public-Adapter` (Public-Client, keine Keys).
* CLI-Befehle: `npm run market-sync` und `npm run scan -- --sync-first`.
* Dokumentation: `docs/MARKET_DATA_PIPELINE.md` (Discovery, Enrichment,
  Backfill 5m/15m/30m/1h mit 150 Kerzen, Persistence, Readiness, Scanner,
  Failure-Semantics, Rate-Limiting 8 req/s, Venue-Matrix, Sicherheit).
* Verhalten: Fehler pro Instrument isoliert (kein Full-Abort); Token-Bucket
  8 req/s nur Public-Client; CLI loggt nur aggregierte Zähler.
* Doku-Stand auf 1.25.0 aktualisiert.

**Sicherheit:** Keine Private-API, keine Credentials im Sync-Pfad; Adapter-Instanzierung
nur über `AdapterRegistry` im Modus `"paper"`; Integrationstests prüfen `privateCalls === 0`.

---

## [1.24.1] — 2026-08-29 · Instrument-Enrichment: volume24h + Orderbook-Spread (PR #35)

**Instrument-Enrichment: 24h-Volumen und Orderbook-Spread.** Discovery
(`trading_pairs`) liefert ausschließlich statische Handelsparameter — keine
Liquiditäts- oder Preismetriken. Ohne Enrichment ist `spread` für jedes
Instrument `null`; der `spread`-Faktor besitzt keinen Fallback, also scheitern
**alle** Instrumente an der `max-spread`-Regel, selbst nach einem
Candle-Backfill. Dieser Release schließt den zweiten Funnel-Blocker.

### Added

* **`src/marketdata/spread.ts`** — `calculateRelativeSpread(bid, ask)`:
  `(ask − bid) / mid`, `mid = (ask + bid) / 2`. Fehlende, nicht-positive,
  invertierte (`bid > ask`) oder nicht-endliche Werte liefern `null`
  („nicht geladen“) — nie `0`, nie `NaN`, nie eine Exception.
* **`FilterRejection.dataQuality`** — kennzeichnet Ablehnungen wegen
  fehlender Daten (`min-candles`, `min-volume`, `max-spread`,
  `max-execution-cost`) gegenüber fachlichen Marktgründen; die Meldungen
  nennen die fehlende Metrik explizit („Spread wurde nicht geladen …“).
* **Tests** — `src/marketdata/__tests__/spread.test.ts` (Golden
  `100/100.02 ≈ 0.00019998`, Toleranz 1e-8, Edge Cases), Enrichment-,
  Batch-Ticker-, Fallback- und Rate-Limiter-Tests in `sync.test.ts`,
  gehärtete Integration (`volume24h > 0` **und** `spread !== null`),
  Data-Quality-Tests in `tests/scanner.funnel.test.ts`.

### Changed

* **`MarketDataSyncService.syncVenue()`** — feste Reihenfolge je Instrument:
  `getTicker` (bzw. 1× `getTickers`-Batch) → `volume24h`, `getOrderBook` →
  `calculateRelativeSpread` → **ein** `registry.upsert` mit
  `{ ...instrument, volume24h, spread, lastSeen }`, danach der Candle-Backfill.
* **Symbol-Guard** im Sync: Ein per-Symbol-Ticker wird nur bei exakter
  Symbol-Übereinstimmung übernommen (sonst `volume24h: null` +
  `SyncResult.errors`), damit kein fremdes Volumen geschrieben wird.
* **Doku** — [`MARKET_DATA_PIPELINE.md`](MARKET_DATA_PIPELINE.md) §2–§3 mit
  Ende-zu-Ende-Datenfluss (`trading_pairs → tickers → volume24h → depth →
  spread → kline → HistoricalStore → Scanner`) und §8 mit der
  Data-Quality-Tabelle; [`BITUNIX.md`](BITUNIX.md) §1.2: Der Spread kommt
  **nicht** aus der Ticker-API, sondern aus dem Orderbuch — 1 zusätzlicher
  `/depth`-Call je Instrument.

### Security

* Public-Endpoints (`trading_pairs`, `tickers`, `depth`, `kline`) senden keine
  Credential-Header (`sign`, `api-key`, `nonce`, `timestamp`, `authorization`) —
  je Request getestet; unnötige Credential-Exposition bleibt ausgeschlossen.
* Rate-Limit-Eskalation bei N Instrumenten (z. B. 180 × `depth`) läuft
  sequenziell durch den Token-Bucket (8 req/s) — kein Sekunden-Burst
  (Limiter-Zählung und Maximal-Parallelität 1 sind getestet).

---

## [1.24.0] — 2026-08-29

**Persistenter Venue-Market-Data-Sync.** Der Scanner las bisher ausschließlich
die lokale, oft leere Historie (`data/history/candles.ndjson` → `[]`) — 26
Seed-Instrumente × 0 Kerzen, Trichter leer. `MarketDataSyncService` schließt
diese Lücke, ohne die Reinheit von `scanUniverse()` aufzugeben.

### Added

* **`src/marketdata/`** — `MarketDataAdapter`, `MarketDataSyncService`,
  `UnsupportedVenueError`, `calculateRelativeSpread`, Bitunix-Public-Adapter.
* **CLI** `npm run market-sync` und `npm run scan -- --sync-first`.
* **Doku** [`docs/MARKET_DATA_PIPELINE.md`](MARKET_DATA_PIPELINE.md)
  (Discovery, Enrichment, Backfill, Persistence, Readiness, Scanner,
  Failure semantics, Rate limiting, Venue-Matrix).
* **Tests** `src/marketdata/__tests__/sync.test.ts` und
  `sync.integration.test.ts` (Mock-Adapter + Bitunix-Fixture-HTTP, 0 Private-Calls).

### Changed

* `HistoricalStore.append` akzeptiert optional `timeframe` (abwärtskompatibel).
* `historicalStoreProvider` bevorzugt `1h`-Kerzen nach einem Sync.
* README: Scanner führt kein Netzwerk-I/O aus; Warmup liegt im Sync-Service.

### Security

* Sync-Pfad verwendet ausschließlich Public-REST (kein PrivateClient, keine Keys).
* Token-Bucket 8 req/s (dokumentiert 10 req/s/IP).
* CLI-Logs nur aggregierte Zähler.

---

## [1.23.0] — 2026-08-29

**Operations Center vollständig integriert (Task 10).** Der Tab war eine
Phase-1-Hülle (sieben Modul-Karten, fünf davon `stub`), während der
Task-Tracker „Implementiert“ auswies. Jetzt zeigt das Cockpit zehn Sektionen
mit echten Werten aus bestehenden Modulen.

### Added

* **Zehn Sektionen im Operations Center:** Market Universe, Scanner, Portfolio
  Analytics, Research Operations, Broker Operations, LLM Operations, Agent
  Operations, Risk, Audit, Help — jede mit Status, Datenstand, Kennzahlen,
  Detailzeilen, Hinweisen und sichtbaren Quellen.
* **Neues Aggregationsmodul `src/ops/`** (`types.ts`, `collect.ts`, `index.ts`):
  liest ausschließlich bestehende Fassaden (Universum, Scanner, Zyklen, Broker,
  Router, Risk Guard, Live-Gate, Datenbank, `docs/`). Keine Mutation, kein
  Secret, keine zweite Fachlogik.
* **Sektionszustände statt Platzhalter:** `ready | degraded | empty | locked |
  unavailable`. `stub` ist aus dem Zustandsraum entfernt.
* **Fail-soft je Sektion:** eine nicht erreichbare Quelle markiert nur ihre
  Sektion (`error` ist redigiert), das Cockpit bleibt lesbar.
* **Health-Zähler** im Payload (`health`) und in der Kopfzeile
  („n/10 Sektionen bereit“).
* **`src/lib/docsCatalog.ts`** als Single Source of Truth der
  Dokumentations-Whitelist (neu auch `brokers` → `BROKER_ARCHITECTURE.md`);
  `GET /api/docs` liest sie jetzt von dort.
* **Reiter „🧭 Operations Center“** im Dashboard sichtbar (war im Code
  vorhanden, aber ohne Reiter erreichbar).
* **Tests:** `tests/opsSections.test.ts` (Payload, Aggregation, Render,
  Fehler-/Leer-/Ladezustand), erweiterte `tests/ops.api.test.ts` und
  `tests/task10.architecture.test.ts`.

### Changed

* `GET /api/ops` liefert `sections[]` statt `modules[]`; die Antwort beschreibt
  sich als „Operations Center“ statt „Operations-Center-Hülle“.
* `src/auth/ops.ts`: `OPS_MODULES` → `OPS_SECTIONS` (zehn Einträge, jede mit
  `sources`, `href`, `helpKey`); `buildOpsPayload(actor, data)` führt Katalog
  und Ist-Daten zusammen.
* `src/components/ops/OperationsCenterPanel.tsx`: Container (`GET /api/ops`)
  plus reine `OperationsCenterView` — testbar ohne Netz und Datenbank.
* `docs/help/ops.help.json` auf Version 2: Felder für alle zehn Sektionen im
  3-Ebenen-Schema, „Phase 1“-Formulierungen entfernt.

### Fixed

* Doc-Code-Diskrepanz Task 10: Tracker „Implementiert“ vs. Code „Hülle“ — der
  Code hat die Doku eingeholt, nicht umgekehrt.
* HANDBUCH 2.3 beschreibt das Operations Center nicht mehr als
  „Phase-1-Hülle“ mit späteren Kacheln.

## [1.22.0] — 2026-08-29

**Provider/Modell-Overrides je Agent + Audit-Identität gehärtet + Test-Isolation
behoben.** Administrative Auswahl von Provider und Modell pro Agent —
persistiert, auditiert, mit transparentem Fallback, ohne die harten
Router-Guardrails auszuhebeln.

### Added

- **Provider/Modell-Override im Router** (`src/routing/router.ts`,
  `setOverrides` / `getOverrides`): pro Agent ein Tupel
  `{provider, model, fallbackMode}`. Override wird **vor** der normalen
  Policy-/Modusauswertung versucht; Health, Cloud-Freigabe, Quota,
  Kontextfenster, Fähigkeiten, Latenz, Budget und Kostendeckel bleiben
  unverändert harte Guardrails. Modell muss in der Provider-Registry
  registriert sein (Validierung im Router, abgewiesene Overrides werden
  nie gesetzt). Trigger `PROVIDER_MODEL_OVERRIDE` in der Entscheidung.
- **Persistenz** `data/routing/overrides.json` (chmod 600, analog zu
  `data/routing/modes.json`): best-effort Schreiben bei jeder Änderung,
  Laden beim Konstruktor, Korrupte/fehlende Dateien werden toleriert
  (leerer Startzustand). Absoluter Pfad wird nicht verändert.
  `ModelRouterOptions.overridesFile` steuert Pfad/Deaktivierung; Tests
  fahren mit `overridesFile: null`.
- **Override-Deaktivierung per `null`:**
  `PUT … {"overrides": {"TECHNICAL_ANALYST": null}}` entfernt den Override
  eines Agenten. Löschung wird als `ADMIN_OVERRIDE_CHANGE` mit
  `from: override:…` → `to: override:none` auditiert.
- **Fallback-Verhalten:** ist der Override-Provider nicht nutzbar
  (offline, Quota erschöpft, Kontext zu klein, fehlende Fähigkeit,
  Latenz nicht eingehalten, Budget/Kosten-Deckel verletzt), fällt der
  Router transparent in den konfigurierten `fallbackMode` (typischerweise
  `automatic`) und die normale Klassen-/Provider-Kette läuft weiter.
  Jeder Wechsel wird als `FALLBACK_CHAIN` auditiert.
- **API-Erweiterung `GET|PUT /api/routing/modes`:** beide Routen liefern
  jetzt auch `overrides`; `PUT` akzeptiert einen kombinierten Body
  `{modes: {...}, overrides: {...}}`. Antwort enthält beide Audit-Logs.
  Fehler in einem Teil blockieren den anderen nicht (teilweise
  Anwendung mit `errors[]`-Liste).
- **Snapshot erweitert:** `RouterSnapshot.overrides` (zuvor nur `modes`)
  gibt die aktuelle Override-Karte zurück; `/api/routing` zeigt sie im
  Payload.
- **Peer-Review-Dokument `docs/PEER_REVIEW_ROUTING_OVERRIDES.md`**
  (Version 1, sieben Prüfabschnitte A–G inkl. Authentifizierung,
  Persistenz-Berechtigungen, Fallback- und Audit-Nachweise).

### Changed / Fixed

- **Actor-Audit-Sicherheitsfix:** das clientseitige JSON-Feld `actor`
  wird in `PUT /api/routing/modes` **vollständig ignoriert** (war bereits
  für alle Control-Plane-Routen unter `/api/brokers/*` umgesetzt).
  Die Audit-ID kommt ausschließlich aus `actorAuditId(req)` nach
  RBAC/CSRF-Prüfung (`admin`/`operator`/`viewer`). TSDoc-Kommentare
  an der Route und im Router verschärft; bestehender Regressions-Test
  belegt, dass ein mitgesendeter `actor: "ops@example"` nicht im Audit
  landet (bleibt `"admin"`).
- **Test-Fixture-Härtung** (`tests/fixtures/routingTestUtil.ts`):
  `modesFile: null` war bereits gesetzt, `overridesFile: null` fehlte.
  Dadurch konnten On-Disk-Overrides aus vorangegangenen Tests in die
  Fake-Registry laufen und einen Validierungstest falsch negativ
  schlagen lassen (Reihenfolgenabhängigkeit). Beide Persistenz-Pfade
  sind jetzt im Test-Modus deaktiviert.
- **Fallback-Entscheidung nach Override-Fehlschlag** berücksichtigt jetzt
  auch den Fall, dass Override-Provider offline ist (zuvor zwar
  `fallbackMode` gesetzt, aber die Override-Entscheidung wurde mit
  `mode: "manual"` fortgesetzt und lieferte im schlimmsten Fall
  `PROVIDER_OFFLINE` ohne Rückgriff — jetzt wird korrekt auf
  `fallbackMode`-Modus zurückgeschaltet).
- **`setOverrides` validiert Unknown-Mode:** `fallbackMode` muss in
  `ROUTING_MODES` liegen (`manual|automatic|hybrid`) — vorher wurde
  bei ungültigem `fallbackMode` nur das Feld ohne Prüfung
  durchgereicht und bei der späteren Verwendung möglicherweise still
  auf Default abgebildet (Hardening).

### Tests

- **5 neue Tests in `tests/routing.override.test.ts`** (Gesamt 8 in der
  Datei, +102 in `tests/routing.*.test.ts` → **107 Routing-Tests**):
  1. Override-Deaktivierung via `null` mit Audit-Eintrag
     (`to: "override:none"`, `outcome: "admin"`).
  2. Persistenz-Roundtrip: schreiben in eine temp. Datei → neuer
     Router lädt Modi und Overrides identisch.
  3. Toleranz gegenüber ungültigen JSON-Dateien (kein Crash, leere
     Override-Map).
  4. Fallback-Kette bei Offline-Override (nicht erreichbarer Provider
     → automatic-Kette wählt einen anderen).
  5. Snapshot enthält Overrides mit provider/model/fallbackMode.
- **Gesamt-Testzahl:** 1143 → **1148** (+5, alle grün).
- Zusätzliche Sicherheits-/Regressionstests bereits vorhanden:
  `tests/routing.api.test.ts` (Client-`actor` wird ignoriert; CSRF;
  422 bei unbekannten Modi; 401/403 Guard); `tests/rbac.test.ts`
  (Token-Zuordnung admin/operator/viewer).

### Dokumentation

- `docs/LLM_ROUTING.md` auf **Version 1.22.0** aktualisiert:
  - Neuer Abschnitt § 4a „Provider/Modell-Overrides" (Semantik,
    Persistenz, Deaktivierung, Fallback-Regeln, API-Beispiel mit
    `curl`).
  - § 5 Routing-Modi um Override-Beschreibung und Authentifizierungs-
    Fließdiagramm ergänzt.
  - § 7 Fallback-Ketten beschreibt jetzt den Override-Pfad explizit
    (Override → `fallbackMode` → Klassen-Fallback → Zwangs-
    Rückstufung → FALLBACK).
  - § 11 API-Referenz um `overrides` in Request/Response ergänzt.
  - § 15 Peer-Review-Checkliste um Override-Punkte (Provider/Modell
    validiert, `actor` ignoriert, Datei-Rechte 600, Deaktivierung
    via `null`, Tests vorhanden) erweitert.
- `docs/PROVIDER_INTEGRATION.md`: Hinweis auf Override-Persistenz-
  Datei und Test-Isolation ergänzt.
- `README.md`: Dokumentationsstand und Test-Zahl auf 1.22.0 / 1148
  angehoben.
- Neues Peer-Review-Dokument `docs/PEER_REVIEW_ROUTING_OVERRIDES.md`.
- Root-`CHANGELOG.md`: Status-Header auf 1.22.0, ausführlicher
  Release-Eintrag, Backlog-Tabelle präzisiert.

### Migrationshinweise

- **Keine Breaking Changes.**
- **Keine DB-Migration** erforderlich (Overrides sind dateibasiert;
  Audit geht in bestehendes `MODEL_ROUTING`-Event).
- **Keine neuen Pflicht-Env-Variablen.** Die Override-Datei
  `data/routing/overrides.json` wird automatisch beim ersten Setzen
  eines Overrides angelegt (chmod 600); sie ist nicht im Repo
  enthalten (`.gitignore` deckt `data/routing/` bereits ab).
- **API-Response erweitert (additiv):** `GET /api/routing/modes`
  liefert jetzt zusätzlich `overrides`; Clients, die das Feld
  ignorieren, bleiben kompatibel.
- **Upgrade-Kette:** `git pull` → `npm ci` → `npm run build` →
  Dienst neu starten (bestehende Modi unter `data/routing/modes.json`
  bleiben erhalten; Overrides starten leer).

### Verifikation (vor dem Release ausgeführt)

- `npm run typecheck` ✓ (tsc --noEmit, 0 Fehler)
- `npm run lint` ✓ (ESLint, 0 Fehler, 0 Warnungen)
- `npm run docs:validate` ✓ (7 Prüfungen / 9 Hilfe-Dateien, alles grün)
- `git diff --check` ✓ (keine Whitespace-Fehler)
- `tests/routing.*.test.ts` ✓ (107 Tests, 0 Fehlschläge)
- Peer-Review: Siehe `docs/PEER_REVIEW_ROUTING_OVERRIDES.md` (Review
  Checkliste A–G vollständig abgenommen).

---

## [1.21.0] — 2026-08-29

**Coverage-Trennung („registriert“ ≠ „abgedeckt“) + vereinheitlichte
Paper-Execution.**

### Added

- **Coverage-Modell** `src/brokers/coverage.ts` (`computeBrokerCoverage`):
  differenzierte Sicht auf registrierte vs. tatsächlich abgedeckte Venues.
  Headline: `registeredVenues` / `fullDiscoveryVenues` / `paperMarketDataVenues`
  / `liveEnabledVenues`; fünf Coverage-Metriken (Discovery / Market Data / Paper
  / Testnet / Live Execution) plus Detailtabelle je Venue. Reine Projektion aus
  der Capability-SSoT (`VENUE_CAPABILITIES`) + Live-Gate-Enforcer — kein
  Netzwerk, keine Secrets.
- **API** `GET /api/brokers/coverage` (read-only, tokenfrei; Fehler-Contract
  `{ ok:false, error, message }`).
- **UI** `src/components/control-plane/CoveragePanel.tsx` im Brokers-&-Venues-Tab:
  Headline-Kacheln, Coverage-Balken, Detailtabelle (intern/extern, Live-Fähigkeit
  vs. Live-Freigabe getrennt). Ersetzt die irreführende Anzeige „7 Broker“ durch
  „7 Venues registriert · 1 mit vollständiger Discovery · 1 mit Paper-Market-Data
  · 0 mit aktiviertem Live Trading“.
- **Snapshot-Builder** `src/lib/marketdata/snapshot.ts` (`snapshotFromLastPrice`,
  `fallbackInstrument`): normalisiert einen reinen Last-Preis-Ticker zu einem
  `MarketSnapshot` (Bid/Ask symmetrisch aus synthetischem Spread).
- **Env** `PAPER_SIM_SYNTHETIC_SPREAD_BPS` (Default `2` bp) für ticker-basierte
  Paper-Fills.
- Tests (+24): `brokerCoverage.test.ts`, `brokerCoverage.api.test.ts`,
  `bitunix.paper.unified.test.ts`, `marketdata.snapshot.test.ts`.

### Changed / Fixed

- **Vereinheitlichte Paper-Execution:** Der Bitunix-Paper-Ledger
  (`src/brokers/bitunix/paper.ts`) nutzt jetzt denselben zentralen
  `FillSimulator` wie die generische Paper-Execution. Die frühere separate,
  vereinfachte Simulation mit festen Faktoren (LONG → `price·1.0001`,
  SHORT → `price·0.9999`) ist entfernt. Ergebnis: `Generic Paper === Bitunix
  Paper` (Spread, Slippage, Gebühren, Latenz, Partial Fills identisch).
- `BitunixPaperLedger` erhält optional Simulator-Konfiguration/Registry
  (Gebühren aus `makerFee`/`takerFee` mit Fallback).
- Frontend-Terminologie in `FirmDashboard` und der Brokers-Seite auf „Venues
  registriert“ + Coverage umgestellt.

### Keine Breaking Changes

- Reject-Pfade, Guardrails, Kill-Switch, Discovery und der harte Live-Pfad
  (`LiveTradingGateError`) unverändert. Bestehende Paper-Order-Pfade laufen weiter.

---

## [1.20.0] — 2026-08-28

**Bitunix-Ausführungs-Refactor — Paper und Broker vollständig getrennt
(Peer-Review umgesetzt).**

**Kritischer Bugfix:** Der Bitunix-Adapter hat im Live-Modus weiterhin das lokale
Paper-Ledger verwendet (`paper.submit()`, `paper.getAccount`, `paper.listPositions`),
obwohl der Live-Gate-Enforcer bereits durchgeschaltet hätte. Das ist semantisch
falsch und gefährlich: Ein Live-System darf nie Paper-Daten als Live-Daten melden.

Umgesetzt über einen neuen Ausführungs-Port:

- **`ExecutionPort`** (`src/brokers/bitunix/execution.ts`) mit zwei
  Implementierungen derselben Schnittstelle:
  - `PaperExecutionEngine` — lokales `BitunixPaperLedger` (paper/backtest,
    0 Private-Calls).
  - `BrokerExecutionEngine` — signierter `BitunixPrivateClient` (live,
    echte Venue-Orders + echte Account-/Positions-Daten).
- **Adapter** (`src/brokers/bitunix/adapter.ts`): Der Modus wählt die Engine.
  Live-Methoden prüfen zuerst das zentrale Live-Gate (Task 11) und delegieren
  danach ausschließlich an die Broker-Engine. Ohne bestandene Gate-Prüfung bleibt
  `LiveTradingGateError` (kein Verhalten geändert); Testnet unverändert
  `NotSupportedCapabilityError`.
- **Semantik-Trennung der Live-Konzepte** (`src/universe/types.ts`):
  - `MarketInstrument.liveTradable` — NEU: Instrument ist beim Broker
    grundsätzlich live-handelbar (Fähigkeit).
  - `adapterCapabilities.live` — Adapter kann Live-Orders serialisieren.
  - `venueControl.liveEnabled` — globale Freigabe der Control Plane.
  - `liveGate.state` — persistierter Gate-Zustand, öffnet erst die Ausführung.
  - `liveAvailable` bleibt als abwärtskompatibler Spiegel (deprecated).
- Bitunix-Mapping: `liveTradable=true`, `liveAvailable=false`.
- Doku aktualisiert: `docs/BITUNIX.md`, `docs/BROKER_ARCHITECTURE.md`,
  `docs/LIVE_TRADING.md`, `docs/PAPER_TRADING.md`, `docs/MARKET_UNIVERSE.md`,
  neues Peer-Review-Dokument `docs/PEER_REVIEW_BITUNIX_EXECUTION.md`.
- **Tests:** Live-Gate-OPEN → Broker-Engine statt Paper; ExecutionPort-Separation;
  Semantik-Trennung der vier Live-Konzepte. Alle betroffenen Suiten grün.

---

## [1.19.0] — 2026-08-28

**Live-Trading-Gate — auditierte State-Machine (Task 11):** 9 Zustände, 8
legale Übergänge mit objektiven Checks, Human-Gate mit 24 h Cooldown und
4-Augen-Modus, Single-Point-Enforcer vor jeder Venue-Order, Kill-Switch mit
persistenter Failsafe-Datei, append-only Audit mit SHA-256-Hash-Kette,
merge-blockierender CI-Job `security-live-gate`. **Dieser Task aktiviert
KEIN Live-Trading** — der Default bleibt DISCONNECTED/off, jede Live-Order
wird weiterhin verweigert (jetzt mit konkretem Deny-Code statt blindem
Throw). Kein Task 12.

### Neu: `src/live-gate/` (State-Machine + Enforcement)

- **Zustände:** `DISCONNECTED → CONNECTED → MARKET_DATA_OK →
  ACCOUNT_READ_OK → ORDER_TEST_OK → PAPER_APPROVED → LIVE_PENDING →
  HUMAN_APPROVED → LIVE_ENABLED`; exakt 8 legale Übergänge
  (`LIVE_GATE_TRANSITIONS`), jede andere Kombination → `ILLEGAL_TRANSITION`
  + Audit. Matrix-Test: 81 Kombinationen, 8 erlaubt, 73 abgelehnt,
  0 Durchlässe.
- **Checks je Übergang** (objektiv über `BrokerGatePort`, read-only bzw.
  simuliert): Health, Public-Ticker, Control-Plane-Probe, Test-Order
  (nur simuliert — Default-Port verweigert bewusst, kein Bitunix-Testnet
  dokumentiert), Paper-Kriterium (≥ `LIVE_GATE_PAPER_MIN_ORDERS`, Default
  50, fehlerfrei). Werfender Port → fail-closed `CHECK_FAILED`.
- **Human-Gate:** Admin-Antrag (`LIVE_PENDING`) → Cooldown 24 h
  (`LIVE_GATE_COOLDOWN_MS`, 0 = aus, max 30 d, Deny mit `retryAt`) →
  Freigabe nur mit `confirm:true` + Grund + Approver;
  `LIVE_GATE_FOUR_EYES=true` verlangt zwei verschiedene Approver.
- **Enforcer (Single Point of Enforcement):** `assertLiveOrderAllowed(venue)`
  entscheidet vor jeder Venue-Order im Live-Pfad (Factory-Routing,
  Bitunix-Adapter placeOrder/getAccount/getPositions, Control-Plane-Anzeige,
  Ops-Center): Kill-Switch → State → 3 Flags → Human-Klausel → Suite-Stamp →
  Control Plane. Jeder Deny mit maschinenlesbarem Code + Audit. Testmatrix
  9 States × 16 Flag-Kombis × Suite × CP gegen Referenz-Oracle: 0 falsche
  Allows. PAPER kann nie live (`VENUE_NOT_LIVE_CAPABLE`).
- **Kill-Switch:** aus jedem Zustand sofort; Memory-Sperre + persistente
  Failsafe-Datei `data/live-gate/kill-switch.json` + State-Reset + Audit;
  wirkt bei DB-/Netz-/Store-Ausfall. Scope je Venue oder systemweit. Clear
  (`CLEAR_KILL`) auditiert, öffnet aber kein Live — kompletter Neudurchlauf
  nötig. UI-Confirm mit Phrase `KILL`.
- **Audit-Hash-Kette:** `data/live-gate/audit-log.ndjson`, kanonisches JSON,
  `prevHash`+`sha256`; `verifyAuditChain()` erkennt Verändern, Einfügen,
  Entfernen, Truncation. Sichtbar in `/api/live/state`, DB `audit_log`
  (Event `LIVE_GATE`), UI-Katalog `LIVE_GATE`.
- **Persistenz/Recovery:** atomares Schreiben (tmp+fsync+rename),
  Intent-Protokoll: halboffene Transitionen nach Crash → `crash-recovery/
  ABORTED` auditiert, Zustand bleibt konsistent; korrupte Files →
  fail-safe DISCONNECTED.
- **Security-Suite-Stamp:** Enforcer verlangt gültigen CI-Stamp (passed,
  runId, ≤ `LIVE_GATE_SUITE_MAX_AGE_MS`, Default 7 Tage).

### Neu: API + UI + CLI

- `GET /api/live/state` (read-only: Zustand je Venue, Flags, Cooldown-Rest,
  Suite, Kill-Status, Audit-Kopf + Integrität; Hashes gekürzt).
- `POST /api/live/transition` / `POST /api/live/kill`: Permission `live.gate`
  (Admin), CSRF-Pflicht, Rate-Limit 5/min/IP; Kill-Phrase-Contract.
- UI: LiveGatePanel im Brokers-Tab (Zustandssteine, Flags, Suite, Kill mit
  Confirm-Dialog); BrokerCard-Live-Chip zeigt jetzt den Gate-Zustand.
- CLI: `npm run live:kill` (Notfall-Kill ohne HTTP), `npm run live:stamp`
  (manueller Suite-Stamp, `--source=manual` sichtbar).

### Neu: Security-Test-Suite + CI (merge-blockierend)

- 8 Suite-Dateien, 78 Tests: Transitionsmatrix (0 Durchlässe),
  Enforcement-Matrix vs. Oracle, Kill-Drill aus allen 9 Zuständen,
  Crash-/Persistenz-, Audit-Manipulations- (4 Fälle) und E2E-Tests,
  API-Guards (Admin/CSRF/Rate-Limit), statische Red-Team-Architektur-
  Regressionen, Unit-Kanten; alle Venue-Zugriffe über zählende Mock-Ports —
  **keine echten Orders in CI**.
- `npm run security:live-gate`: Suite + Coverage-Tor **≥ 95 % Zeilen** auf
  `src/live-gate/**` (erreicht: 95,81 %).
- CI-Job `security-live-gate` auf jedem PR/Push (typecheck, lint, Suite,
  Secret-Scan `scripts/scan-live-gate-secrets.ts`, Stamp-Artefakt). Die
  Job-Quelle liegt bei `docs/ci/security-live-gate.workflow.yml` (das
  Arena-Bot-Token darf keine Workflow-Dateien schreiben). **Einrichtung
  nötig (Owner, einmalig):** Datei nach `.github/workflows/` kopieren +
  Check `security-live-gate` als Required Status Check in der
  Branch-Protection von `main` eintragen (Anleitung in der Job-Datei).

### Neu: Dokumentation

- `docs/LIVE_TRADING.md` (neu): Zustands-Diagramm, Bedingungen, Human-Gate,
  Enforcement, Kill-Runbook, Audit-Format, API/CLI, CI, Grenzen.
- `docs/SECURITY_AUDIT.md`: Kapitel Task 11 (Threat Model T1–T12,
  Red-Team-Checkliste, Ergebnisprotokoll, Befunde LG-01…04 — kein
  High/Critical).
- `docs/PEER_REVIEW_LIVE_TRADING.md`: versionierte Review-Vorlage v1
  (Abschnitte A–G, Unterschriftenfelder).
- `docs/help/live-gate.help.json` (neu), `brokers.help.json` +
  `ops.help.json` aktualisiert; `docs/ARENA_TASKS.md` (neu) dokumentiert
  alle Arena-Tasks 01–11; `docs/README.md`-Index ergänzt; Docs-API-Whitelist
  `liveTrading` ergänzt.

### Geändert

- Broker-Factory `getBroker(venue, "live")`: entscheidet jetzt der
  Live-Gate-Enforcer (statt blindem Throw) — Default unverändert deny.
- Bitunix-Adapter: ruft `assertLiveOrderAllowed` in jedem Live-Pfad;
  `readGateState()` liefert Enforcer-Projektion.
- `package.json`: Skripte `security:live-gate`, `test:coverage:livegate`,
  `live:kill`, `live:stamp`; `.env.example`: Task-11-Sektion;
  `.gitignore`: `/data/live-gate`.

### Upgrade-Hinweise

- Keine DB-Migration, keine neuen Pflicht-Env-Variablen. Verhalten für
  Bestandsnutzer unverändert (Live bleibt off).
- Neue optionale Env-Variablen: `LIVE_GATE_DATA_DIR` (Default
  `data/live-gate`), `LIVE_GATE_COOLDOWN_MS` (86400000),
  `LIVE_GATE_FOUR_EYES` (false), `LIVE_GATE_PAPER_MIN_ORDERS` (50),
  `LIVE_GATE_SUITE_MAX_AGE_MS` (604800000).

---

## [1.18.0] — 2026-08-28

**Operations Center + RBAC-Kern (Task 10, Phase 1):** Rollen
`viewer` / `operator` / `admin`, leerer Operations-Center-Tab, vier
Dokumentations-/Code-Drifts behoben. Live bleibt gesperrt. Kein Task 11/12.

### Neu: `src/auth/`

- Rollenmatrix und Permission-Katalog. `live.gate` existiert, wird **keiner**
  Rolle gewährt.
- `resolveActor` / `requirePermission`: Token-Header `x-admin-token`,
  `x-firm-token`, `x-viewer-token`, `Authorization: Bearer`. Timing-safe.
  Local-open (kein Token) = Admin. Operator ohne `FIRM_ADMIN_TOKEN` erbt
  Admin-Rechte (Single-Admin, Control-Plane-kompatibel: 403 vs 401).
- `GET /api/auth/me` — Actor ohne Token-Echo.
- `GET /api/ops` — Cockpit-Hülle, `liveEnabled: false` hart.
- Dashboard-Tab **🖥 Operations Center** (Rolle, Live-Chip, Modul-Karten).

### Geändert

- Control-Plane-Guard ist Fassade über `requirePermission("broker.credentials")`.
  Audit-Actor kommt aus dem RBAC-Kern statt hart `"admin"`.
- Bitunix-Default-Store: `createVenueBackedNamedStore` + Env-Fallback.
  `TODO(task-08)` entfernt.
- Architecture-Tab: Ist-Stand (Makro/Mikro, 12 Tasks, Paper B, Broker,
  Router, RBAC) — kein LangGraph/AutoGen.
- HANDBUCH Kap. 8: Paper-Modus B als Default, Control Plane, Bitunix.
  Kap. 19.4: MODEL_ROUTER ist v1.17.0 (nicht „bis Task 09“).
- `apiFetch` sendet den gespeicherten Token auch auf GET.

### Tests & Doku

- `tests/rbac.test.ts`, `tests/ops.api.test.ts`, `tests/task10.architecture.test.ts`.
- Plan: [task-10-IMPLEMENTATION_PLAN.md](task-10-IMPLEMENTATION_PLAN.md).
- SECURITY_AUDIT Task 10, `docs/help/ops.help.json`, `.env.example` RBAC.

### Nicht enthalten (bewusst)

- Keine Sessions, keine Widget-Aggregation (Phase 3), Firm-Schreib-APIs
  bleiben `guardWrite`. Live-Gate = Task 11.

---

## [1.17.0] — 2026-08-28

**Deterministischer Model Router (Task 09): der MODEL_ROUTER als Systemrolle.**
Kein Agent wählt sein Modell selbst — die einzige Instanz, die Modellklasse,
Provider und Modell bestimmt, ist der Router auf Basis einer versionierten,
schema-validierten Policy. Eskalationen dürfen Agenten nur **beantragen**;
genehmigt oder abgelehnt wird ausschliesslich vom Router, beides mit Audit.

### Neu: `src/routing/`

- **Policy** (`policy.ts`): versionierte Konfiguration (`1.0.0`), JSON-ladbar via
  `ROUTING_POLICY_PATH`, vollständige Schema-Validierung — **ungültige Policy ⇒
  Startverweigerung** (`RoutingPolicyError`). Enthält Agenten-Tabelle, Klassen
  (`MODEL_A`/`MODEL_B`/`MODEL_C`), Task-Overrides, Complexity-/Risk-Floors,
  Eskalationsregeln, Budgets und Fallback-Ketten. Cloud-Provider **müssen**
  gedeckelt sein (Validierung lehnt `tokensPerDay <= 0` ab).
- **Router** (`router.ts`): `resolve(RoutingContext) → RoutingDecision` über die
  9 Routing-Inputs (task, complexity, risk, latency, tokenBudget, providerHealth,
  capabilities, maxCostUsd, contextSize). Ergebnisraum
  `MODEL_A | MODEL_B | MODEL_C | CLOUD | FALLBACK`. Deterministisch: keine
  Zufallswerte, injizierbare Uhr, feste Policy-Reihenfolgen.
- **Provider-Registry** (`registry.ts`): Karten mit `models[]`, `capabilities[]`,
  `contextSize`, `costPer1kIn/Out`, `healthStatus`, `latencyEma`,
  `tokenBudgetToday`, `tokensUsedToday`, `quotaRest`. Health-Poller mit
  konfigurierbarem Intervall (`ROUTING_HEALTH_POLL_MS`, `0` = aus,
  `ROUTING_HEALTH_PROBE=off|local|all`); Ollama liefert zusätzlich Modellliste
  und Kontextgrösse (`/api/tags`, `/api/show`).
- **Budget** (`budget.ts`): harte Deckel je Provider, Agent und Tag plus
  Tageslimit für Eskalationen (12). Überschreitung ⇒ Zwangsrückstufung auf ein
  lokales Modell + Audit (`outcome: budget_blocked`) — gilt **auch** im
  `manual`-Modus (Ausnahme: auditierte Admin-Freigabe `budgetExempt`).
- **Eskalation**: `requestEscalation()` mit dokumentierter Prüfkette E1–E8
  (Klasse höher, Zielklasse erlaubt, Agenten-Deckel, hybrid-Grenze,
  Komplexität/Runtime-Trigger, Confidence ≤ 0.75, Tageslimit, Verfügbarkeit).
  Trigger sind ausschliesslich Runtime-Metriken — **kein** Prompt-Inhalt.
- **Audit** (`audit.ts`): `AuditSink`-Interface mit Memory-, Datei-
  (`data/routing/audit.ndjson`) und `audit_log`-Senke (Event `MODEL_ROUTING`).
  Format `{ts, agent, from, to, reason, trigger, policyVersion, outcome}`;
  jeder Wechsel — inkl. Fallback und **denied** — wird protokolliert.
- **Adapter** (`adapter.ts`): `routeChat()` bündelt Router-Entscheidung,
  Provider-Kette und Verbrauchsbuchung für alle `chat()`-Pfade.

### Default-Routing-Tabelle (implementiert + getestet)

| Agent | Modus | Klasse |
| --- | :---: | --- |
| `CEO` | automatic | frei (Router) |
| `RESEARCH` | automatic | large (`MODEL_C`) |
| `TECHNICAL*` / `NEWS*` | automatic | local-small (`MODEL_A`) |
| `RISK*` / `PORTFOLIO*` | automatic | local-medium (`MODEL_B`) |

Modi `manual` (festes Modell, Eskalation möglich), `automatic` (Router frei),
`hybrid` (Klasse aus der Tabelle ist bindend) — je Agent über
`PUT /api/routing/modes` (Admin-Token + CSRF + Audit).

### Neu: API

| Methode | Pfad | Zweck |
| --- | --- | --- |
| `GET` | `/api/providers` | Karten-Daten: Status, Modell(e), Kontext, Latenz, Kosten, Tokens %, Restkontingent, Klassen (`?refresh=1` erzwingt Health-Prüfung) |
| `GET` | `/api/routing` | Policy, Modi, Provider, Budgets, letzte Entscheidungen, Audit |
| `GET`/`PUT` | `/api/routing/modes` | Modi lesen / ändern (Admin + CSRF + Audit) |

### Geändert

- `src/cycle/ports.ts`: `DefaultAnalysisAgentPort` läuft über `routeChat()` —
  `MODEL_*`-Environment-Werte bestimmen kein Agentenmodell mehr, nur noch
  Registry-Defaults. Genehmigte Eskalationen führen zu genau einem erneuten
  Aufruf; der Routing-Trace landet in `agent_messages.meta.routing`.
- `src/cycle/steps/macroStep.ts`: der Eskalationstrigger stammt jetzt aus den
  **validierten Strukturfeldern** (Regime, Volatilität, Confidence) statt aus
  Freitext — sonst könnte eine News-Schlagzeile eine Eskalation auslösen.
- `src/cycle/types.ts`: `ModelEscalationRequest` um die Task-09-Felder
  (`task`, `currentModel`, `currentClass`, `requestedClass`, `tokenOvershoot`,
  `latencyViolation`) erweitert; `AgentInvocationSpec.complexity` und
  `AgentInvocationResult.routing` ergänzt.

### Tests (neu)

`tests/routing.policy.test.ts` (108 Tabellenfälle + Modi + Schema-Matrix),
`routing.escalation.test.ts` (Golden 0.58/HIGH ⇒ approved, 0.95/LOW ⇒ denied),
`routing.fallback.test.ts` (Timeout-/Quota-/Health-Ketten),
`routing.budget.test.ts`, `routing.injection.test.ts`,
`routing.registry.test.ts`, `routing.api.test.ts`,
`routing.integration.test.ts` (100 % der Wechsel auditiert).
Coverage des neuen Codes: **96 % Zeilen** (`npm run test:coverage:routing`).

### Dokumentation

Neu: **[LLM_ROUTING.md](LLM_ROUTING.md)** (Rollenbild, 9 Inputs, Ergebnisraum,
Default-Tabelle, Modi, Eskalationsdiagramm, Fallback-Ketten, Budget-Deckel,
Audit-Format, Governance-Begründung) und `docs/help/routing.help.json`
(3-Ebenen-Hilfe, 17 Felder). Aktualisiert: PROVIDER_INTEGRATION.md
(Registry-Felder, Health, Budget), SECURITY_AUDIT.md (`## Security Audit — Task 09`).

---

## [1.16.0] — 2026-08-28

**Broker Control Plane (Task 08): Backend-Credential-Manager mit
verschlüsseltem Secret-Store und das Frontend „Brokers & Venues".**
Datenfluss verbindlich: Frontend (masked credential form) → Backend →
verschlüsselter Secret-Store → Broker-Adapter; Frontend erhält NUR Status.
Live bleibt überall OFF (`liveEnabled:false`, einzige Quelle =
Gate-Service-Meldung bis task-11).

### Neu: `src/brokers/control-plane/`

- **Secret-Store:** AES-256-GCM mit **AAD = Venue-ID** (Auth-Tag bindet den
  Datensatz an die Venue), frischer IV je `put`, Buffer-Nullung (zeroize).
  Key ausschließlich aus Env/KMS (`SECRET_STORE_KEY`; KMS-Hook
  `SECRET_STORE_KMS_ENDPOINT` vorbereitet, fail-safe). Backends: DB
  (`broker_credentials`, verschlüsselte Envelopes) → Datei-Fallback
  (`data/secrets/*.enc`, 600, gitignored) → Memory (Tests). Interface
  `put/get/delete/exists`; Task-07-Bridge `createVenueBackedNamedStore`.
- **Credential-API:** `POST|DELETE /api/brokers/{venue}/credentials`,
  `GET …/status`, `POST …/test` (healthCheck + read-only Probe →
  `permissions[]`), `POST …/discover`. Antworten **status-only**
  (configured/connected/permissions[]/liveEnabled) — kein Echo, kein
  `keyHint`, keine Maskierung. Fehler 403/404/409/422/429/503 mit SAFE-Meldungen.
- **Zustandsmodell:** 6 Ebenen (connection, marketDiscovery, permissions,
  paper, testnet, live) × off/pending/active/error; Übergänge nur über
  `save|test|discover|disable`, Missbrauch → 409/422. **Live immer off.**
- **Permission-Probe (read-only):** PAPER real gegen den Ledger; andere
  Venues über lokalen Mock-Adapter (Unabhängigkeitsklausel, kein Netzwerk);
  Fehler → Ebene `error` mit SAFE-Meldung.
- **Sicherheit:** Admin-Guard (RBAC-Platzhalter, `FIRM_ADMIN_TOKEN`,
  TODO(task-10)), CSRF (`x-csrf-token`), Credential-Rate-Limit
  (5/min/IP, `BROKER_CREDENTIAL_RATE_LIMIT`), Audit je Ereignis
  (`BROKER_CONTROL_PLANE`: actor, venue, Aktion, Ergebnis, timestamp —
  ohne Secrets), Response-/Bundle-Secret-Scanner (`npm run scan:secrets`).

### Neu: Frontend „Brokers & Venues"

- Karten je Broker: Status-LED, Markets-Anzahl, Spot/Perpetual/Futures-Flags,
  Buttons [Verbinden] [Test] [Einstellungen], 6 Zustands-Chips je Ebene,
  Permissions-Badges, Loading-/Error-/Empty-States.
- Masked credential form (`type="password"`,
  `autoComplete="new-password"`, `noValidate`, State wird nach Submit
  geleert; kein Client-Speicher). Settings = read-only Flags inkl.
  `liveEnabled` mit deutlichem „gesperrt"-Zustand; Bestätigungsdialog vor
  Credential-Löschen.
- Neuer Dashboard-Tab „🌐 Brokers & Venues" + eigenständige Seite
  `/brokers` (ohne Firm-DB, Control-Plane-REST-Contract only).

### Geändert

- `src/db/schema.ts`: neue Tabelle `broker_credentials` (venue PK,
  verschlüsseltes Envelope) → `npx drizzle-kit push` erforderlich.
- `src/lib/seed.ts`: `broker_credentials` in der Schema-Prüfung.
- `src/lib/auditView.ts`: Katalog-Eintrag `BROKER_CONTROL_PLANE`.
- `.env.example`: `SECRET_STORE_KEY`, `SECRET_STORE_KMS_ENDPOINT`,
  `BROKER_SECRET_BACKEND`, `BROKER_SECRET_DIR`, `FIRM_ADMIN_TOKEN`,
  `BROKER_CREDENTIAL_RATE_LIMIT`.
- `package.json`: v1.16.0, Scripts `scan:secrets`,
  `test:coverage:controlplane`.

### Tests & Doku

- Neu: `tests/secretStore.test.ts` (Roundtrip, Wrong-Key, Tampering →
  Auth-Tag, AAD-Bindung, Zeroize, Backends, Task-07-Bridge),
  `tests/controlPlane.{states,api,integration,security,e2e}.test.ts`
  (Zustandsmaschine, RBAC/CSRF/Rate-Limit, Response-Scanner über ALLE
  Broker-API-Responses, Bundle-Scanner, Connect-Flow, Audit je Aktion,
  E2E Connect → Test → Status → Disconnect).
- Neu: `docs/FRONTEND_CONTROL_PLANE.md` (Datenfluss, API-Referenz,
  Zustandsmodell, Sicherheitskonzept, „Warum das Secret nie anzeigbar ist").
- Update: `docs/BROKER_ARCHITECTURE.md` (Control-Plane-Abschnitt),
  `docs/help/brokers.help.json` (3-Ebenen-Hilfe), `docs/SECURITY_AUDIT.md`
  (Kapitel „Security Audit — Task 08").

---

## [1.15.0] — 2026-08-27

**Bitunix-Adapter als 7. Venue (Task 07): Public REST/WS für USDT-M-Perpetuals,
offizielle Doppel-SHA256-Signatur, Paper-Modus B gegen echte Kurse, Live-Pfad
weiterhin hart `LiveTradingGateError` (`TODO(task-11)`). Kein dokumentiertes
Testnet, keine echten Private-Calls in Tests.**

### Neu: `src/brokers/bitunix/`

- **Public REST:** `trading_pairs` → `MarketInstrument` (`marketType=perpetual`,
  Registry-Upsert `source=discovery:bitunix`), Ticker (`lastPrice`/`markPrice`/
  `quoteVol`/`baseVol`/`high`/`low`), Klines, Orderbuch.
- **Public WS:** Channels `ticker` und `market_kline_*` mit Reconnect, exponentiellem
  Backoff und Resubscribe; Ticker = Full-Replace, Kline = Delta gleicher `time`.
- **Signing:** `SHA256(SHA256(nonce+timestamp+api-key+queryParams+body)+secret)`,
  UTF-8, Hex lower-case; Query ASCII-sortiert ohne Trenner; Body kompakt.
  Golden-Tests (inkl. offiziellem Doku-Beispiel).
- **Private REST vorbereitet:** Account, Pending-Positions, Place-Order inkl.
  `slPrice`/`tpPrice` (`stopAtVenue=true`). Der Adapter-Live-Pfad sendet **nie**.
- **Gates:** `BITUNIX_ENABLED` / `BITUNIX_LIVE_ENABLED` / `LIVE_TRADING_ENABLED`
  Default aus; `REQUIRE_HUMAN_APPROVAL` für Live nur bei exakt `"false"` offen.
  16 Flag-Kombinationen → immer `LiveTradingGateError`.
- **Secrets:** `SecretStore` + Env-Fallback `BITUNIX_API_KEY`/`BITUNIX_API_SECRET`
  (`TODO(task-08)`). Redactor maskiert Keys, Header und Hex-Signaturen.
- **SSRF/TLS/Rate-Limit:** Host-Allowlist `fapi.bitunix.com`, TLS erzwungen,
  Token-Bucket 8 req/s, Timeout/Retry nur für 429/5xx.
- **Paper (Modus B):** echte Public-Kurse, lokales Ledger, 0 Private-Calls.

### Geändert

- `BROKER_VENUE_IDS` und Factory-Matrix: 6→**7** Venues, 24er→**28er**.
- `GET /api/brokers` `count=7`; BITUNIX `paperAvailable=true`, `liveAvailable=true`
  (Capability; Ausführung gesperrt). Health lokal `offline` solange Flag aus.
- `inferMarketType("BITUNIX")` → `perpetual`.
- Audit-Katalog: Event `BITUNIX_PRIVATE_CALL` (Methode/Pfad/Outcome, keine Secrets).

### Tests & Doku

- `tests/bitunix.*.test.ts` + Fixture-Server; Factory/Contracts/API auf 7 Venues.
- `docs/BITUNIX.md`, Update BROKER_ARCHITECTURE / MARKET_UNIVERSE / ARCHITECTURE §10.1,
  SECURITY_AUDIT Task 07, `docs/help/brokers.help.json`, `.env.example`.
- `npm run test:coverage:bitunix`.

### Migrationshinweise

Kein Schema-Bruch. Optional in `.env`: `BITUNIX_ENABLED=false` (Default). Live bleibt
gesperrt, auch wenn alle Flags gesetzt werden.

---

## [1.14.0] — 2026-08-27

**Daily & Weekly Agent Cycle mit Shortlist-Limits und Artefakten (Task 06):
Ein neues Modul `src/cycle/` orchestriert die strukturierte Tages- und Wochenroutine
der 12 Agenten-Rollen. Massenverarbeitung (Scanner, Backtest) läuft ohne Sprachmodell;
LLM-Analysen erfolgen ausschließlich auf gerankten Shortlists mit strikt im Code
erzwungenen Obergrenzen (max. 40 Instrumente an Technical Analyst und News Analyst).
Vollständiger Prompt-Injection-Schutz über strikte Datentrennung, versionierte
Artefakte mit konfigurierbarer Retention, Vorbereitung für LLM-Eskalationen
(`MODEL_ESCALATION_REQUEST`), injizierbare Uhr für Zeitraffer-Tests und vier neue
read-only REST-Endpunkte unter `/api/analysis/*`.**

### Neu: `src/cycle/` (Agent-Orchestrierung & Zyklus-Engine)

- **8-stufige Tagesroutine** (`daily.ts`, `steps/`):
  1. `00:00–06:00` **Market Scanner**: Deterministischer Scan ohne LLM (`llmAllowed: false`).
  2. `06:00–07:00` **Macro Analyst**: Cross-Market-Blick auf BTC, ETH, DXY, SPX, Nasdaq, Gold, Bonds + Volatilitätsregime.
  3. `07:00–08:00` **Market Selection**: Filtert und rankt die Daily Candidate List (max. 40 Instrumente).
  4. `08:00–09:00` **Technical Analyst**: Multi-Timeframe-TA, **Code-Limit: max. 40 Instrumente** (`assertShortlistLimit`).
  5. `09:00–10:00` **News Analyst**: News-Sentiment & systemisches Risiko, **Code-Limit: max. 40 Instrumente**, Prompt-Injection-Schutz.
  6. `10:00–11:00` **Risk Manager**: Korrelationscluster & Portfolio-Exposure-Bewertung über Task 05 (`AnalyticsPort`).
  7. **danach** **Research**: Konkrete Trade-Setups mit Entry/SL/TP — verbindlich als Vorschläge markiert (`isProposal: true`, keine Orders).
  8. **danach** **Backtest-Verifikation**: Deterministische Verifikation historischer Kennzahlen (Max Drawdown, Profit Factor, Sharpe, Sortino, Regime-Robustheit) ohne LLM.
- **Weekly Universe Review** (`weekly.ts`):
  - 1× wöchentlich (konfigurierbarer Wochentag, Standard: Sonntag).
  - Bewertet neue Listings, Delistings, Liquiditäts- und Gebührenschnittstellen, Regimewechsel und Broker-Verfügbarkeit.
  - Erzeugt verbindliche Klassifikation `CORE` / `ROTATION` / `DISCOVERY` / `EXCLUDED` je Instrument mit bis zu 20 `reasons[]`.
- **Step-Engine & Scheduler** (`engine.ts`, `scheduler.ts`, `clock.ts`):
  - Injizierbare Uhr (`SimulatedClock`) ermöglicht das Durchspielen ganzer Tage/Wochen in Millisekunden.
  - Laufzeit-Gate sperrt LLM-Aufrufe bei `llmAllowed: false`.
  - Konfigurierbare `RetryPolicy` je Schritt mit exponentiellem Backoff.
  - Kontrollierter Abbruch bei Fehlschlägen (`status: "FAILED"`, Audit-Eintrag, bestehende Artefakte bleiben integer).
- **Prompt-Injection-Schutz & Schemavalidierung** (`security.ts`, `schemas.ts`):
  - Externe Inhalte (RSS-Feeds, Marktdaten) werden über `wrapUntrustedData` strikt als Daten gekapselt.
  - Nicht-konforme Antworten werden verworfen und durch deterministische Fallbacks ersetzt.
- **Modell-Eskalations-Event** (`MODEL_ESCALATION_REQUEST`):
  - Schritte dürfen ein Eskalations-Event emittieren; ohne Task-09 fällt das System transparent auf die Provider-Fallback-Kette zurück.
- **Artefakt- & Speicherverwaltung** (`artifacts.ts`):
  - `artifacts/YYYY-MM-DD/daily/*.json` (je Step eine Datei + `daily-summary.json`).
  - `artifacts/YYYY-Www/weekly/*.json` (`weekly-review.json` + `universe-classification.json`).
  - `artifacts/index.json` (globales Manifest aller Läufe).
  - Konfigurierbare Retention (`retentionDays`, `retentionWeeks`, `pruneArtifacts()`).

### Neu: Read-only API (`/api/analysis/*`)

- `GET /api/analysis/daily/latest`: Jüngster Tageslauf inklusive Zusammenfassung und Step-Outputs.
- `GET /api/analysis/daily/{date}`: Tageslauf für ein konkretes Datum `YYYY-MM-DD` (validiert).
- `GET /api/analysis/weekly/latest`: Jüngster wöchentlicher Universe Review.
- `GET /api/analysis/runs`: Paginierte Historie aller Zyklen (`type=daily|weekly|all`, `status`, `page`, `pageSize`).

### Dokumentation & Feldhilfe

- `docs/DAILY_WEEKLY_RESEARCH.md`: Umfassendes Kapitel 13 zur Tages- und Wochenroutine.
- `docs/HANDBUCH.md`: Neues Kapitel 19 „Tagesroutine der Mitarbeiter (Agenten-Zyklus)“.
- `docs/help/cycle.help.json`: 3-Ebenen-Hilfe (kurzinfo, technischeInfo, risiko) für alle Zyklus-Konzepte.
- `docs/SECURITY_AUDIT.md`: Kapitel „Security Audit — Task 06“.

---

## [1.13.0] — 2026-08-27

**Deterministische Portfolio-Analytics, Optimizer und Risk-Guard-Kette (Task 05):
ein neues Modul `src/portfolio/` berechnet Kennzahlen, Korrelations- und
Kovarianzmatrizen sowie Portfoliogewichte in drei Modi — und jedes Ergebnis läuft
durch eine feste Kontrollkette: Portfolio Optimizer → Risk Guard → Position Limits →
Correlation Limits. Reine Funktionen, keine I/O, kein LLM, kein Zufall, keine Uhr.
Gleiche Eingabe ergibt byte-identische Ausgabe; jede Guard-Entscheidung wird
auditiert.**

### Neu: `src/portfolio/` (deterministische Rechenschicht — kein LLM)

- **Kennzahl-Bibliothek** (`metrics.ts`, reine Funktionen, Formel im TSDoc jeder
  Funktion): logarithmische Renditen, realisierte Volatilität
  (`σ · √A`, Annualisierungsfaktor je Anlageklasse konfigurierbar — Krypto 365,
  Aktien/ETF/Indizes/FX/Rohstoffe 252), ATR mit Wilder-RMA (Default-Periode 14),
  Sharpe `(r̄ − r_f/A)/σ`, Sortino mit Downside-Deviation, Max Drawdown inkl.
  `peakIndex`/`troughIndex`/`recoveryIndex`/Dauer, Profit Factor, annualisierte
  Rendite und Volatilitätsregime `LOW/NORMAL/HIGH/EXTREME` (Schwellen 0,25/0,60/1,20,
  überschreibbar). Freiheitsgrade `ddof ∈ {0,1}` konfigurierbar (Default 1).
- **Korrelation & Kovarianz** (`correlation.ts`): Pearson **und** Spearman
  (Durchschnittsränge bei Gleichständen) als Matrix, Sample-Kovarianz (`ddof = 1`)
  und optional EWMA (Default `λ = 0,94`), Korrelationscluster per Union-Find über
  `|ρ| ≥ 0,8` (Schwellwert konfigurierbar). Nullvarianz ist definiert 0, nie `NaN`.
- **Optimizer, drei Modi** (`optimize.ts`): `min_variance` (`min wᵀΣw`, FISTA +
  Active-Set-Polish über das KKT-System), `max_sharpe` (monotoner projizierter
  Aufstieg, drei deterministische Starts), `risk_parity` (Newton auf der
  Spinu-Formulierung, gleichmäßige Risikobeiträge `w_i(Σw)_i`). Nebenbedingungen
  `Σw = 1` und konfigurierbare Bounds (Default long-only). Toleranz 1e-9
  (enger als die geforderte 1e-6), Iterationslimit 2000, beides konfigurierbar;
  Konvergenz wird explizit berichtet (`converged`, `iterations`,
  `notes: ["NOT_CONVERGED:iterations=…"]`).
- **Risk-Guard-Kette** (`riskGuard.ts`, `pipeline.ts`): Positions-Limits
  (Default 20 % je Instrument, `maxPositions`, `minWeight` 0,1 %) und
  Korrelations-Limits (max. 50 % je Cluster). Ergebnis
  `{ rejected, adjusted, reasons[], decisions[], clusterExposures[] }`, jeder
  Schritt ein strukturierter Audit-Eintrag. Die Kette ist als Konstante
  `AUTHORITY_CHAIN` im Code erzwungen — `applyRiskGuard` akzeptiert ausschließlich
  Eingaben des Optimizers, `optimizeWithGuard()` ist der einzige öffentliche Weg
  zu Gewichten.
- **Numerische Robustheit** (`numeric.ts`): Cholesky, Jacobi-Eigenzerlegung,
  Pseudo-Inverse, Ridge-Regularisierung, Vektor-/Matrix-Operationen. Singuläre
  Matrizen sind **konfigurierbar**: `error` (Default), `ridge` oder
  `pseudo-inverse` — nie ein still falsches Ergebnis, immer dokumentiert in
  `diagnostics.regularization` und `notes[]`. Zusätzlich erklärt die Cholesky-
  Zerlegung Pivots unter `1e-12 · max(diag)` für singulär (zwei perfekt korrelierte
  Assets liefern in Gleitkomma sonst ein Pivot von ~1e-19). `NaN`/`±Infinity` in
  Eingaben sind definierte Fehler.
- **Agenten-Schnittstelle** `getAnalysisContext(returns, symbols)`
  (`context.ts`): liefert ausschließlich **fertige** Kennzahlen, Matrizen, Cluster
  und Limits an die Interpretations-Ebene — keine Gewichte, kein Rechenauftrag —
  und trägt die Leitplanke (`llmMay`/`llmMustNot`) direkt im Payload.
- **Audit-Senke** (`audit.ts`, `auditFile.ts`): `AuditSink`-Interface mit
  Memory-Senke (Standard, Ereignisse stehen in der API-Antwort) und
  NDJSON-Datei-Senke (opt-in über `PORTFOLIO_AUDIT_DIR`, atomar über tmp+rename,
  Dateiname gegen Path-Traversal validiert) — `// vgl. task-01/06` für die zentrale
  `audit_log`-Integration.

### Neu: read-only API `/api/portfolio/*`

- `POST /api/portfolio/metrics` — Kennzahlen je Serie (Preise, Renditen oder
  Log-Renditen, optional Kerzen für die ATR).
- `POST /api/portfolio/correlation` — Korrelationsmatrix (Pearson/Spearman) plus
  Cluster.
- `POST /api/portfolio/optimize` — Modus, Bounds, Kovarianz-Methode und Limits;
  antwortet mit Gewichten **und vollständigem Risk-Guard-Report** inklusive
  `audit[]`. Ein Guard-Verwurf ist `422 RISK_GUARD_REJECTION`, nie `200` mit
  falschen Gewichten.
- Alle drei Endpunkte: `GET` ⇒ `405`, einheitliches Fehlerformat
  `{ ok: false, error, message }`, Größenlimits (max. 1000 Serien, max. 2000
  Punkte je Serie, max. 400.000 Stichproben, Body ≤ 16 MiB) ⇒ `413 LIMIT_EXCEEDED`,
  Symbole werden normalisiert und gegen eine strikte Zeichenklasse geprüft
  (Log-Injection-Schutz).

### Tests & Doku

- **8 Testsuiten, 130 Tests** (`tests/portfolio.*.test.ts`): Golden-Tests gegen
  unabhängig in Python berechnete Referenzwerte (Toleranz 1e-6, Kovarianz/
  Optimizer bis 1e-12), analytische 2-Asset-Minimum-Varianz, Property-Tests
  (Risk-Parity-Spread `< 1e-4`, `Σw = 1`, Bounds, min-variance ≤ Gleichgewichtung,
  max-Sharpe ≥ Gleichgewichtung), Robustheit (singulär, `NaN`/`Infinity`,
  Iterationslimit), Risk-Guard-Tests (Kappung, Cluster-Verwurf, ein Audit-Eintrag
  je Entscheidung), API-Contract-Tests und Determinismus-Check.
- **Architekturtest** (`tests/portfolio.architecture.test.ts`): erzwingt per
  Quelltext-Scan, dass `src/portfolio/` kein LLM, kein Netzwerk, keine Datenbank,
  keinen Zufall, keine Uhr und keinen Dateizugriff importiert (einzige Ausnahme:
  `auditFile.ts`), dass jede exportierte Rechenfunktion eine Formel dokumentiert,
  dass die API ausschließlich über die Guard-Kette geht und dass Doku,
  Hilfe-JSON, README-Index, `/api/docs`-Whitelist und Security-Audit vollständig sind.
- **Unit-Tests der Infrastruktur** (`tests/portfolio.unit.test.ts`): Numerik-Primitives
  (Cholesky, Eigenzerlegung, Pseudo-Inverse, Regularisierung), Fehlercodes,
  Konfigurationsvalidierung, Audit-Senken inkl. Datei-Schreibfehler und DB-No-op,
  Request-Parser und Fehlerformat. Coverage der neuen Module: **96,41 %** Zeilen
  (`npm run test:coverage:portfolio`).
- **Benchmark** (`tests/portfolio.benchmark.test.ts`): 500 Assets × 750 Perioden
  (375.000 Stichproben) — Kovarianz 0,21 s, min_variance 0,45 s, max_sharpe 3,7 s,
  risk_parity 0,52 s, vollständige Pipeline 1,0 s ⇒ **5,8 s von 30 s Budget**.
- **Doku**: `docs/PORTFOLIO_ANALYTICS.md` (Formelkatalog mit Annahmen und Grenzen,
  Optimizer-Modi, Guard-Ketten-Diagramm, Konvergenz-/Numerikregeln, API-Referenz mit
  Beispielen, Abschnitt „Warum das LLM keine Gewichte berechnet"),
  `docs/help/portfolio.help.json` (10 Begriffe × 3 Ebenen), README-Index,
  `/api/docs`-Eintrag `portfolio`, `## Security Audit — Task 05`.
- Neues Kommando: `npm run test:coverage:portfolio`.

### Nicht enthalten (bewusst)

- **Keine Order- oder Portfolio-Mutation.** Das Modul erzeugt Gewichte und Reports;
  nichts davon wird ausgeführt, kein Portfolio-, Positions- oder Orderzustand wird
  verändert. Die Order-Guardrails in `src/lib/riskGuard.ts` bleiben unberührt.
- **Keine Kovarianz-Shrinkage** (Ledoit-Wolf) und kein Faktor-Modell — `ridge` und
  `pseudo-inverse` sind dokumentierte Notlösungen für singuläre Matrizen.
- **Keine Transaktionskosten, keine Steuern, kein Rebalancing, kein Leverage.**
- **Keine LLM-Beteiligung an der Berechnung.** Das Modell interpretiert fertige
  Zahlen; Gewichte entstehen ausschließlich im Optimizer.
- **`src/scanner/factors/correlation.ts`** (Task 04) behält vorerst seine eigene
  Pearson/Spearman-Implementierung — der Umzug auf `src/portfolio` ist dokumentiert,
  der Scanner bleibt unverändert lauffähig.

---

## [1.12.0] — 2026-08-27

**Deterministischer Markt-Scanner, Market Score und Trichter (Task 04): Aus bis
zu 10.000 Instrumenten wird täglich eine begründete Liste von 100 Rotations- und
20–40 Deep-Kandidaten. 14 Faktor-Module, neun gewichtete Score-Komponenten,
Volatilitätsregime, Weekly Universe Review, versionierte Tagesartefakte und drei
read-only API-Endpunkte. Kein LLM, kein Netzwerk, kein Zufall — gleiche Eingabe
ergibt byte-identische Ausgabe.**

### Neu: `src/scanner/` (deterministische Analyseschicht — kein LLM)

- **14 Faktor-Module** mit einheitlichem Interface `Factor { id, compute() }` →
  `FactorValue { raw, normalized ∈ [0,1], available, detail }`:
  `liquidity`, `spread`, `atr`, `volatility`, `momentum`, `trend`,
  `volumeRatio`, `rsi`, `drawdown`, `correlation`, `news`, `funding`,
  `openInterest`, `executionCost`. Jede Datei dokumentiert Formel,
  Normalisierung und Datenbedarf im TSDoc (per Architekturtest erzwungen).
- **News-Risiko ohne Sprachmodell**: reine Zählheuristik über Ereigniszahlen,
  High-Impact-Flag, anstehende Termine und die Frische der Registry-Daten.
- **Market Score 0–100** (`ranker.ts`) aus neun Komponenten mit exakten
  Gewichten **Liquidity 25 · Volatility 15 · Trend 15 · Momentum 10 · Spread 10 ·
  Volume 10 · Correlation 5 · News 5 · Execution 5** (Summe 100 %, per Test
  erzwungen). Jeder Score trägt sein **Breakdown**: Faktor → Rohwert → normiert →
  Gewicht → Beitrag.
- **Volatilitätsregime** (`regime.ts`) auf annualisierter realisierter
  Volatilität: `LOW < 0.25 ≤ NORMAL < 0.60 ≤ HIGH < 1.20 ≤ EXTREME`
  (Schwellen konfigurierbar, fehlende Werte ⇒ `NORMAL`).
- **Trichter** (`filters.ts`, `funnel.ts`): 10.000 → **2.000** (10 Eignungs- und
  Risikoregeln, erste greifende Regel gewinnt und wird protokolliert) → **500**
  (Score ≥ 55) → **100** Daily Rotation → **20–40 Deep-Kandidaten** mit
  Diversifikationsregel (max. 8 je Anlageklasse, kontrollierte Lockerung).
- **Versionierte Konfiguration** `src/scanner/scanner.config.json` (`version: 1`)
  mit Validierung aller Bereiche und Summen; Override über `SCANNER_CONFIG_FILE`.
- **Faktor-Cache** (`cache.ts`) je `(instrumentId, factorId, Datenfingerprint)` —
  warmer Lauf ≈ 5× schneller.

### Neu: Weekly Universe Review & Artefakte

- **`classifyWeekly()`** stuft jedes Instrument deterministisch als
  `CORE` / `ROTATION` / `DISCOVERY` / `EXCLUDED` ein und liefert validiertes JSON
  `{ instrumentId, class, reasons[], score, asOf }` (`validateWeeklyEntry`,
  `WeeklyValidationError`). Erkannte Änderungen: Neulistings, Delistings,
  Liquiditätseinbrüche (> 50 %), Gebührensprünge (> 50 %), fehlende
  Broker-Verfügbarkeit, Regimewechsel, Korrelationscluster (|r| ≥ 0.9).
  Die **LLM-Synthese** des Reviews ist bewusst **nicht** Teil dieses Tasks.
- **Tagesartefakte** `artifacts/JJJJ-MM-TT/universe.json` (+ `weekly.json`)
  inklusive Score-Breakdowns, Gewichten, Trichtergrößen und Ablehnungsstatistik.
  Atomar geschrieben (tmp + rename), **byte-identisch reproduzierbar**;
  Verzeichnis über `SCANNER_ARTIFACTS_DIR`, nicht versioniert.

### Neu: read-only API `/api/universe/*`

- **`GET /api/universe/daily`** — Ebenen `deep|daily|interesting|eligible`,
  Pagination (`pageSize` max. **200**, Default 50), optionales `breakdown`.
- **`GET /api/universe/weekly`** — Filter `class` (CSV), gleiche Pagination,
  Antwort inklusive `summary` und `changes`.
- **`GET /api/universe/score/{instrumentId}`** — vollständiges Breakdown
  (9 Komponenten), alle 14 Faktorwerte, Trichter-Zugehörigkeit und ggf. die
  greifende Ablehnungsregel; `404` für unbekannte IDs.
- Alle Endpunkte sind lesend, ohne Token-Pflicht (wie die übrigen GET-Routen),
  mit harten Query-Limits und redigierten 500er-Meldungen.

### Neu: Kommandos

- **`npm run scan`** — Scan aus Registry + Historical Store, schreibt die
  Tagesartefakte (`-- --dry` rechnet nur). **`npm run test:coverage:scanner`.**

### Performance

- Benchmark (`tests/scanner.benchmark.test.ts`): **10.000 synthetische
  Instrumente in 0,68 s** (~14.700 Instrumente/s) gegen ein Budget von 15 Minuten;
  Artefakt + Weekly zusätzlich 35 ms. Der Test scheitert bei Budget-Überschreitung.

### Tests & Doku

- **123 neue Tests** (Gesamt 576, alle grün): Golden-Werte und Edge Cases je
  Faktor, Score-/Gewichts-/Regime-/Trichter-/Weekly-/API-Contract, Determinismus
  und Byte-Identität, Architekturtest „kein LLM/Netzwerk/DB/Zufall im Scanner",
  Benchmark. **Coverage der neuen Module 97,3 % (Zeilen).**
- Neu: [`docs/DAILY_WEEKLY_RESEARCH.md`](./DAILY_WEEKLY_RESEARCH.md) (Pipeline,
  Faktor-Katalog, Gewichte, Trichter, Regime, API-Referenz, Benchmark),
  `docs/help/scanner.help.json` (3-Ebenen-Hilfe), Kapitel „Security Audit —
  Task 04" in `SECURITY_AUDIT.md`, Abschnitt 10 in `MARKET_UNIVERSE.md`.

### Nicht enthalten (bewusst)

- Kein Live-Trading-Bezug, keine Orderentscheidung, keine Änderung an Guardrails,
  Broker oder Ledger. Der Scanner liest nur und schreibt ausschließlich Artefakte.

---

## [1.11.0] — 2026-08-27

**Paper-Market-Data & deterministische Execution-Simulation (Task 03): Die
Plattform läuft standardmäßig mit echten Kursen (Modus B) statt statischem
Preisbuch. Drei Paper-Modi, broker-unabhängige Feed-Abstraktion, Normalisierung
mit Anomalie-Erkennung, append-only Historical Store, deterministischer
Fill-Simulator (Gebühren/Spread/Slippage/Latenz/Partial Fills), auditiertes
Failover. Live bleibt gesperrt, kein Breaking Change.**

### Neu: `src/lib/marketdata/` (deterministische Schicht — kein LLM)

- **`MarketFeed`-Abstraktion** (`types.ts`): `getTicker`, `getCandles`,
  optional `getOrderBook`/`subscribe`. Implementierungen in `feeds/`:
  `BinanceFeed` (Bid/Ask via `bookTicker`, 24h-Volumen), `YahooFeed`
  (Aktien/ETF/FX, Spread aus Registry), `BrokerFeed` (delegiert an
  `BrokerAdapter`, vgl. Task 02), `SyntheticFeed` (seeded, deterministisch,
  NUR Modus A/expliziter Fallback), `ReplayFeed` (spielt Historical Store ab).
- **`MarketSnapshot { instrumentId, bid, ask, last, ts, source, venue, feed,
  spread, volume24h }`** über `normalization.ts`: NaN/≤0, Sprung über
  `PAPER_ANOMALY_MAX_JUMP_PCT`, staler Timestamp und kaputter Spread werden
  **verworfen und geloggt** (`ANOMALOUS_SNAPSHOT`) — nie gehandelt.
- **Historical Store** (`historicalStore.ts`): append-only **NDJSON**
  (`data/history/candles.ndjson`) mit Provenienz (venue, feed, ts, fetchedAt).
- **Failover-Kette** (`failover.ts`): Broker-Feed → unabhängiger Feed →
  Synthetic (nur bei `PAPER_ALLOW_SYNTHETIC_FALLBACK=true`). Jeder Wechsel +
  jede Anomalie → `audit_log` (`FEED_FAILOVER`/`ANOMALOUS_SNAPSHOT`) +
  In-Memory-Ring. **Kein stiller Kursquellwechsel.**
- **`MarketDataManager`** (`manager.ts`): Instrument-Auflösung, Kette je
  Paper-Mode, Cache, Status. **`production.ts`** verdrahtet Factory ↔ Manager
  ↔ Ledger (Import-Zyklen-frei).
- **Shared HTTP** (`http.ts`): Timeout, Retry/Backoff (hart begrenzt),
  **SSRF-Allowlist**, read-only, keine Credentials.

### Neu: Fill-Simulator (`simulator.ts`) — lokal & deterministisch

- Modelliert **Gebühren** (Registry-Felder `makerFee`/`takerFee`, vgl. Task 01),
  **Spread** (Snapshot-Bid/Ask), **Slippage** (linear wachsend mit Ordergröße
  relativ zum 24h-Volumen), **Latenz** (ms) und **Partial Fills**
  (konfigurierbar). Seed-basiert → bit-identisch reproduzierbar (100-Fall-Test).
- Alle Parameter + Defaults dokumentiert (Tabelle in `docs/PAPER_TRADING.md`).

### Paper-Modi (`paperMode`)

- **`synthetic`** (A): Synthetic-Feed, deterministisch, perfekt für Tests.
- **`broker-market-data`** (B, **Default**): echte Kurse über Broker-Feed →
  Binance/Yahoo, Ausführung lokal simuliert.
- **`broker-paper-api`** (C): Broker-Paper-/Testnet-API — nur mit
  Venue-Capability + `PAPER_MODE_C_ENABLED=true`; heute nicht wählbar
  (klarer `PaperConfigError` statt stiller Fallback).
- Statisches Preisbuch (`STATIC_PRICES`) ist **`@deprecated`** und nur noch
  expliziter Offline-Fallback hinter `PAPER_STATIC_FALLBACK=true` (Default aus).

### API (read-only, ohne Token)

- `GET /api/marketdata/snapshot?instrument=…` → normalisierter Snapshot.
- `GET /api/marketdata/status` → aktive Quelle, Cache-TTL, letzter Failover.

### Integration (kein Breaking Change)

- `PaperBroker` erhält optionale `PaperExecutionAdapter` (`setExecution`):
  Modus-B-Fills laufen über den deterministischen Simulator (echte Kurse +
  Gebühren). Rohe `new PaperBroker()`-Instanzen bleiben bytekompatibel.
- `engine.getBroker()` injiziert den Ausführungs-Adapter einmalig und wärmt
  den Snapshot-Cache vor jedem Submit; ohne Kurs → `NO_QUOTE` (nie raten).
- Live-Pfad bleibt hart gesperrt (`LiveTradingGateError`).

### Getestet

- **53 neue Tests** (`npm test` → **453 grün**, alle 400 Bestands-Tests
  unverändert): deterministischer Simulator (100 Fälle), Slippage-/Partial-
  Fill-Grenzfälle, Gebühren aus Registry-Feldern, Replay-/Golden-Test
  (Backtest 2× → byte-identisch), Integration Modus B gegen lokalen
  **Fixture-HTTP-Server** (echter Kursfluss, kein Netz), Failover + Audit,
  Stale-Kurs-Verwerfen, Negative-Tests (Modus C ohne Capability, Synthetic
  ohne Flag), Feed-Tests (Yahoo/Binance/Broker/Synthetic), API-Contract.
- **Coverage `src/lib/marketdata/**` + `src/app/api/marketdata/**`:** Zeilen
  **95,6 %** (≥ 90 %). `npm run typecheck`, `npm run lint` fehlerfrei.
- Kein echter Netzwerkverkehr in der CI-Suite (alles über lokale Fixture-
  Server mit `PAPER_FEED_ALLOWED_HOSTS=127.0.0.1`).

### Doku

- NEU `docs/PAPER_TRADING.md`: Modi A/B/C (Vergleichstabelle), Simulator-
  Parameter-Tabelle, Failover-Kette, Replay-Determinismus, MARKET-DATA-LAYER-
  Diagramm.
- UPDATE `docs/ARCHITECTURE.md` (§10.5 Paper-Modi & Market-Data-Layer,
  Execution-Mode-Tabelle verdrahtet), `docs/SECURITY_AUDIT.md` (Kapitel
  „Security Audit — Task 03“), `docs/README.md` (Doku-Index).
- NEU `docs/help/paper-trading.help.json`: 3-Ebenen-Hilfe (kurzinfo /
  technischeInfo / risiko) für paperMode, Slippage, Partial Fill, Latenz,
  Spread, Failover, Replay.
- NEU `docs/task-03-IMPLEMENTATION_PLAN.md` (Plan + RECON-Abweichungen).

### Migrationshinweise

- Kein Schema-Bruch, keine neuen Dependencies. `PAPER_MODE` (Default
  `broker-market-data`) und die `PAPER_*`-Knobs sind optional; der statische
  Fallback ist standardmäßig **aus** (`PAPER_STATIC_FALLBACK=false`).

---

## [1.10.0] — 2026-08-27

**Broker Capability-Modell (Task 02): Die Plattform ist jetzt
broker-unabhängig — 6 Adapter hinter einem Interface, Execution Modes als
erstklassiges Konzept, Live-Pfad hart und auditierbar gesperrt. Kein Live-
Trading, keine Credentials, kein Netzwerkverkehr (Remote-Health default
OFF).**

### Neu: `src/contracts/broker.ts` (geteilte Contracts)

- **`ExecutionMode = "backtest" | "paper" | "testnet" | "live"`** mit
  fester Semantik: Backtest = historischer Kurs + simulierte Order,
  Paper-Realtime = realer Kurs + simulierte Order, Testnet = realer
  (Testnet-)Kurs + Broker-Order, Live = realer Kurs + reale Order.
- **`BrokerCapabilities`** (discovery, marketData, trading, paper,
  testnet, live, instrumentTypes, `stopAtVenue` — letzteres der
  Ausbaupfad für den späteren Bitunix-Adapter) und **`BrokerAdapter`**
  (healthCheck, optionale capability-geprüfte Methoden).
- **Fehlerklassen:** `LiveTradingGateError`, `NotSupportedCapabilityError`,
  `UnknownVenueError` (alle mit maschinenlesbarem Code, informativ,
  leak-frei — getestet).
- `MarketInstrument` wird **nicht dupliziert**, sondern aus Task 01
  (`src/universe/types.ts`) wiederverwendet (Unabhängigkeitsklausel nicht
  greifend, weil Task 01 gemerged ist).

### Neu: `src/brokers/` (ausführbares Capability-Modell)

- **`capabilities.ts`** — `VENUE_CAPABILITIES` für die 6 Venues (Single
  Source of Truth) + Gating-Table `REQUIRED_CAPABILITY_BY_MODE`
  (backtest/paper → `paper`, testnet → `testnet`, live → hartes Gate).
  Die Flags beschreiben, was der Adapter-CODE ausführt — Venue-Angebote
  bleiben Doku in der Registry.
- **`paper.ts`** — `PaperBrokerAdapter`: delegiert Orders/Guardrails auf
  den bestehenden `PaperBroker`, Marktdaten auf `marketData.ts`, Discovery
  auf die lokale Universe-Registry. Einziger vollständig ausführbarer
  Broker.
- **`stubs.ts`** — ALPACA, IBKR, BINANCE, KRAKEN, DYDX als sichere Stubs:
  ehrliche Capability-Declarations (Exec-Flags false), alle Methoden
  werfen deterministisch und informativ `NotSupportedCapabilityError`
  (Discovery mit klar markiertem `TODO(task-02/07)` + Contract-Referenz),
  Trading im (unerrreichbaren) live-Kontext zusätzlich
  `LiveTradingGateError` (Defense in Depth). Kein Netzwerk, keine
  Credentials, keine Broker-SDKs.
- **`factory.ts`** — `getBroker(venue, mode)` als **einziges Erzeugungs-
  punkt**: Whitelist-Validierung → Live-Gate (IMMER `LiveTradingGateError`)
  → Capability-Gating (`NotSupportedCapabilityError`) → Cache. Niemals
  stiller Fallback. PAPER-Ledger als Prozess-Singleton (backtest/paper
  teilen denselben, von der Engine hydratierten Ledger).
- **`audit.ts`** — jeder Factory-Aufruf mit `mode != "paper"` (plus alle
  Unknown-Venue-Ablehnungen) landet im Audit: In-Memory-Ring (200, immer)
  + best-effort `audit_log` (Event `BROKER_FACTORY`; DB-Ausfall bricht den
  Pfad nie ab).
- **`health.ts`** — `BROKER_HEALTHCHECK_REMOTE` (Default **false** = OFF):
  read-only, credential-freie Public-Checks (Binance `ping`, Kraken `Time`,
  4 s Timeout). ALPACA/IBKR/DYDX führen bewusst keinen Remote-Check aus
  (`degraded` + Grund: CREDENTIALS_REQUIRED / GATEWAY_REQUIRED /
  REMOTE_CHECK_NOT_IMPLEMENTED) — ohne Credentials wird nie gecallt.

### Geändert: Engine, Registry, Audit-View, API

- **`engine.ts`:** Hardcode-Erzeugung entfernt — `getBroker()` nutzt die
  Factory (kein `new PaperBroker` mehr in der Engine); Hydration aus
  PostgreSQL bleibt in der Engine. Rückgabetyp `PaperBroker` und Verhalten
  **bytekompatibel** (alle 334 bestehenden Tests unverändert grün).
- **`BROKER_REGISTRY` (lib/broker.ts):** neue Projektions-Flags
  `paperAvailable`/`liveAvailable` = `projectCapabilityFlags(caps)` —
  Single Source of Truth = Adapter, Registry = Projektion (Test belegt es).
  `paperApi` bleibt als Venue-Angebot (Doku).
- **`auditView.ts`:** Katalogeintrag für das neue Audit-Event
  `BROKER_FACTORY` (deutsche Beschreibung, Sektionen, Widerspruchs-Check).

- **Neue API (read-only, ohne Token wie die übrigen GETs):**
  - `GET /api/brokers` → 6 Venues: id, label, assets, capabilities,
    paperAvailable/liveAvailable (Projektion), executionModes, Health
    (lokal); `remoteHealthCheck.enabled` (Default false).
  - `GET /api/brokers/{venue}/health` → Health (lokal bzw. remote je Flag),
    capabilities, executionModes; 404 `UNKNOWN_VENUE`, Fehler redigiert.
- **`.env.example`:** neue Sektion "Broker" mit
  `BROKER_HEALTHCHECK_REMOTE=false` (Doku, Default OFF).

### Getestet (Peer-Review)

- **66 neue Tests** (`npm test` → **400 grün**, alle 334 Bestands-Tests
  unverändert bytekompatibel):
  - `tests/brokerFactory.test.ts` — **DIE 24er-Matrix** (6 Venues × 4
    Modes) mit expliziter Erwartungstabelle: PAPER ✓/✓/NSE(testnet)/LGTE,
    Stubs NSE/NSE/NSE/LGTE; Capability-Gating; Fehlerklassen; kein
    stiller Fallback; Registry-Projektion (Test belegt die Spiegelung);
    Audit-Vollständigkeit (18 Einträge, paper NICHT auditiert);
    PAPER-Singleton; Ring-Overflow; Defense in Depth.
  - `tests/brokerContracts.test.ts` — gemeinsame Interface-Suite für alle
    6 Adapter (inkl. „Trading wirft sicher und informativ“), offline-
    deterministisch (fetch gestubbt), Leak-Schutz der Meldungen.
  - `tests/brokerApi.test.ts` — beide Endpunkte (Shape, 404,
    Normalisierung), Remote-Checks offline mit simuliertem fetch.
  - `tests/brokerHealth.test.ts` — Flag-Semantik (Default OFF, nur
    exakt "true"), null-Pfade des Remote-Check-Kerns, Leak-Schutz.
- **Coverage neu** (`npm run test:coverage:brokers`): Zeilen 98,3 %,
  Funktionen 95,6 % (>= 90 % Zielerreichung); Branches 89,6 % — die
  systematisch offene Branch ist der Erfolgspfad der DB-Senke (kein
  PostgreSQL in der Testumgebung; by design best-effort/Fail-Safe).
- `npm run typecheck`, `npm run lint` fehlerfrei; `npm run build`
  inklusive neuer Routen erfolgreich.

### Doku

- NEU `docs/BROKER_ARCHITECTURE.md`: Adapter-Vertrag, Capability-Matrix
  (Ist/Soll), Execution-Mode-Tabelle, Factory-Fluss, Fehlerklassen,
  Audit, API, Health/Remote-Flag, Ausbaupfad (inkl. Bitunix-`stopAtVenue`).
- UPDATE `docs/ARCHITECTURE.md` (neues Kapitel 10 + Diagramm,
  Kommunikationsweg Mikro-Broker, Glossar), `docs/SECURITY_AUDIT.md`
  (Kapitel "Security Audit — Task 02"), `docs/README.md` (Doku-Index).
- NEU `docs/help/brokers.help.json`: 3-Ebenen-Hilfe (kurzinfo /
  technischeInfo / risiko) für Execution Modes, Capability-Flags,
  Health-Status, `LiveTradingGateError` und Projektions-Flags.

### Migrationshinweise

- Kein Schema-Bruch, keine neuen Dependencies. Optional:
  `BROKER_HEALTHCHECK_REMOTE` in `.env` (Default OFF).

---

## [1.9.0] — 2026-08-27

**Lesbarer Audit-Trail und lesbares Protokoll: Aufklappbare Einträge mit
deutschen Erklärungen, Rohdaten-Reiter, logischer Bewertung und Paging
(20/50/100/200) — identisch in „Firm Overview" und „Protokoll".**

### Problem (gemeldet)

- Der Audit-Trail zeigte `JSON.stringify(detail).slice(0, 70)`: abgeschnittene,
  aneinanderhängende Roh-JSON ohne Beschriftung (`ceoRaw`, `fill`, `via`).
- Nicht erkennbar, ob eine `ORDER_REJECTED`-Meldung ein **Fehler** oder
  **korrektes Systemverhalten** ist.
- Kein Paging — die Liste war nicht navigierbar.

### Neu: `src/lib/auditView.ts` (reiner Aufbereiter, kein DB-/React-Import)

- **Event-Katalog** mit deutschen Titeln und fachlicher Erklärung für alle 28
  Events, die der Code schreibt (`AGENT_DECISION` → „Agent-Entscheidung",
  `ORDER_REJECTED` → „Order abgelehnt", `TAKE_PROFIT_HIT` → „Take-Profit
  erreicht", `RULE_MACRO_REJECTED` → „Makro-Regel abgelehnt", `RISK_ADAPTIVE`
  → „Risiko angepasst", …).
- **Feld-Wörterbuch**: `ceoRaw` → „CEO-Entscheidung (Rohantwort)", `via` →
  „Quelle der Änderung", `latencyMs` → „Antwortzeit", inkl. Einheiten
  („14,34402 Stück", „104,36426 USD", „1,3 s", „2 %").
- **Logische Prüfung** pro Eintrag und über die Sequenz: Widersprüche
  (`ORDER_SENT` mit `status: REJECTED`, Take-Profit unter Einstieg bei LONG,
  adaptiver Faktor > 1, `ROLE_NOT_ALLOWED_TO_TRADE` für EXECUTOR/RESEARCH)
  werden als ⛔ gekennzeichnet; korrektes Verhalten („Rollen-Mandat",
  „Pyramiding-Sperre", „Fail-safe REJECT") wird als ℹ️ eingeordnet.
- **Abgeschnittene Modellantworten** werden erkannt und benannt: Die Engine
  speichert `ceoRaw` mit 500 und `rawResponse` mit 2.000 Zeichen
  (`src/lib/macroCycle.ts`, `src/lib/engine.ts`). Verdikt und Begründung werden
  trotzdem aus der gekürzten Antwort extrahiert.
- **Zeitstempel eindeutig in UTC**: „27.08.2026, 14:56:14 UTC" + „vor 4 Minuten".

### Neu: `src/lib/paging.ts` + `src/components/common/`

- Paging-Kern (Default **20**, wählbar **20/50/100/200**) — server- und
  clientseitig dieselbe Logik, Seitengrößen geklemmt.
- `AuditTrailList` / `ProtocolList`: aufklappbare Karten mit Kurzfassung,
  „Lesbare Details" (gruppierte, beschriftete Sektionen für `fill`, `order`,
  `decision`) und **„Rohdaten (DB-Eintrag)"**-Reiter mit vollständiger Zeile.
- `AuditTrailPanel` / `ProtocolPanel`: Level-/Event-Filter, Suche, Auto-Refresh
  — in „Firm Overview" und „Protokoll" dieselbe Komponente.
- Farben: INFO grün, WARN gelb, CRITICAL rot; Widersprüche zusätzlich markiert.

### API

- `GET /api/firm/log` unterstützt `page` (1-basiert, alternativ `offset`),
  liefert `meta` (`page`, `pageSize`, `pages`, `auditTotal`, `entryTotal`) und
  pro Protokolleintrag die originale DB-Zeile unter `raw`. `limit` bleibt
  auf 1–200 geklemmt (Fix aus v1.1.0 unverändert).
- Abwärtskompatibel: `entries`, `turns`, `audit`, `agents` bleiben erhalten.

### Tests

- `tests/auditView.test.ts` (23): Katalog, Feldlabels, Widerspruchserkennung,
  gekürzte CEO-Antwort, Muster über mehrere Einträge, Zeitstempel.
- `tests/paging.test.ts` (5): Seitengrößen, Schnitt, Fenster, Klemmung.
- `tests/auditUi.render.test.ts` (3): rendert die echten Komponenten und prüft,
  dass nichts abgeschnitten ankommt und das Paging 20/50/100/200 anbietet.
- Regressionsschutz: Findet der Code ein Audit-Event ohne Katalogeintrag,
  schlägt der Test fehl.

---

## [1.8.0] — 2026-08-27

**Market Universe (Task 01): Die Plattform kennt jetzt Märkte statt Strings.
Eine broker-unabhängige Instrumenten-Registry löst die hart kodierte
`DEFAULT_WATCHLIST` als Marktdefinition ab.**

### Neu: `src/universe/` (deterministischer Kern — kein LLM, kein Netzwerk)

- **Datenmodell `MarketInstrument`** mit 20 fachlichen Pflichtfeldern plus
  kanonischer ID (`VENUE:SYMBOL`): Identität, Handelsbedingungen
  (`minQuantity`, `priceStep`, `quantityStep`, `makerFee`, `takerFee`),
  Capability-Flags (`leverageAvailable`, `shortAvailable`, `paperAvailable`,
  `liveAvailable`) und laufende Metriken (`volume24h`, `spread`, `volatility` —
  initial `null`, gefüllt durch spätere Tasks).
- **Symbol ≠ Markt:** strikte Trennung von `Instrument` (venue-gebunden),
  `Asset` (venue-unabhängig) und `Underlying` (ökonomische Exposure).
  `BINANCE:BTCUSDT`, `KRAKEN:BTC/USD` und `BITUNIX:BTCUSDT` sind drei
  Instrumente mit einem Underlying — per Golden-Test verifiziert.
- **Registry-Layer** (`registry.ts`): `upsert`, `upsertMany` (max. 5000/Batch),
  `query` mit 15 Filtern, Pagination (max. **500**/Seite, Default 100),
  `remove`, `groupByVenue`, `underlyings`. Deterministisch: stabile Sortierung
  nach `id`, Merge-Upsert ohne Default-Rücksetzer, `null`-Metriken überschreiben
  keine Bestandswerte.
- **Persistenz** als versionierbare NDJSON-Datei
  (`data/universe/instruments.ndjson`, atomar via `tmp`+`rename`) — reviewbar im
  Git-Diff und ohne laufende Datenbank nutzbar. Verzeichnis via
  `UNIVERSE_DATA_DIR` konfigurierbar.
- **Normalisierung & Policy** (`normalization.ts`, `policy.ts`,
  `policy.default.json`): venue-native Symbole → kanonische ID, base/quote-,
  Anlageklassen- und Markttyp-Ableitung; konfigurierbare Ausschlussregeln
  (Leveraged Tokens, Test-Symbole, gesperrte Venues/Quotes) mit Validierung der
  Policy-Datei; Override via `UNIVERSE_POLICY_FILE`.
- **Audit** (`audit.ts`): jede Mutation erzeugt genau einen Eintrag
  (`actor: system`, `source`, `action`, `changed`, `created`, `updated`,
  `rejected`, `ids`, `timestamp`) in `data/universe/audit-log.ndjson`;
  mit `UNIVERSE_AUDIT_DB=1` zusätzlich als `UNIVERSE_MUTATION` in `audit_log`.

### Neu: API

- `GET /api/markets` → `{ ok, venue, count, lastSync, instruments[], groups[],
  page, pageSize, total, hasMore }`, nach Venue gruppiert und über 15 Parameter
  filterbar; strikte Eingabevalidierung, Fehler-Contract
  `{ ok:false, error, message, details? }` (400/500).
- `GET /api/markets/{venue}/{symbol}` → Instrument inkl. `assetId`/`underlyingId`
  und `related` (gleiches Underlying an anderen Venues); 400/404/500 nach
  demselben Contract. Symbole mit `/` als `%2F` oder `~` adressierbar.

### Migration (kein Breaking Change)

- Die 9 Watchlist-Symbole wurden zu **26 Seed-Instrumenten** migriert:
  BTC/ETH/SOL → BINANCE + KRAKEN, SPY/QQQ/NVDA/AAPL/MSFT → ALPACA + IBKR,
  EURUSD=X → `IBKR:EUR.USD` (FX) sowie je ein `PAPER:*`-Spiegel, damit der
  bestehende Paper-Broker-Pfad unverändert läuft.
  Regenerierbar mit `npm run universe:seed` (byte-identisches Ergebnis).
- `DEFAULT_WATCHLIST` bleibt exportiert, ist aber **`@deprecated`** und leitet
  sich aus `UI_WATCHLIST_PREFERENCE` (`src/universe/watchlist.ts`) ab — einer
  Liste von Instrument-ID-Referenzen. Die Watchlist ist damit reine UI-Präferenz.

### Tests & Doku

- 66 neue Tests (Registry-CRUD, Upsert-Konflikte, alle Filter, Pagination-Limits,
  stabile Sortierung, Policy, Golden-Normalisierung, API-Contract,
  Persistenz-Reload, Seed-Fixture); Gesamtsuite **301 grün**.
  Coverage `src/universe/**`: **97,4 % Zeilen / 90,6 % Branches / 91,3 % Funktionen**
  (`npm run test:coverage`).
- Neu: `docs/MARKET_UNIVERSE.md`, `docs/help/market-universe.help.json`
  (3-Ebenen-Hilfetexte für alle Felder, Tooltip-Quelle für das Operations Center);
  aktualisiert: `docs/ARCHITECTURE.md` (§9 Universum-Pipeline),
  `docs/SECURITY_AUDIT.md` (Kapitel „Security Audit — Task 01“).

### Migrationshinweise

- Keine DB-Migration nötig; kein neues Paket (0 neue Dependencies).
- `data/universe/instruments.ndjson` ist versioniert und wird beim ersten Start
  automatisch geseedet, falls sie fehlt. `data/universe/audit-log.ndjson` ist
  bewusst **nicht** versioniert (`.gitignore`).

---

## [1.7.0] — 2026-08-26

**Adaptives Risk-Limit-System: `maxRiskPerTrade` senkt sich automatisch in
hochvolatilen Marktphasen — ohne Rebuild, ohne Neustart, zur Laufzeit
konfigurierbar und für Agenten/Monitoring beobachtbar.**

### Neu: `src/lib/adaptiveRisk.ts` (Kernmodul)

- **Vier Volatilitätsindikatoren** mit klaren, zur Laufzeit änderbaren
  Schwellwerten (Keys `adp.*` in `risk_config`):
  1. **VIX** (primärer Trigger, Yahoo `^VIX`, 5-Min-Cache): ≥ 30 → ELEVATED,
     ≥ 40 → EXTREME;
  2. **ATR (14)** auf 15-min-Kerzen, Korb-Spitzenwert über
     SPY/QQQ/BTC — Standard > 1 % des Kurses;
  3. **Bollinger Band Width (20, 2σ)** — Standard > 5 % Bandbreite;
  4. **Return-Standardabweichung (20 × 15-min)** — Standard > 1 % pro Kerze.
  Die beiden neuen Indikator-Funktionen (`bollingerBandWidthPct`,
  `returnStdDevPct`) sind reine, unit-getestete Funktionen in `indicators.ts`.
- **Dreistufige Regime-Logik** (deterministisch, `assessRegime()`):
  EXTREME, wenn VIX ≥ 40 **oder** (VIX ≥ 30 **und** ≥ 1 Korb-Indikator)
  **oder** alle drei Korb-Indikatoren; ELEVATED, wenn VIX ≥ 30 **oder**
  ≥ 1 Korb-Indikator; sonst NORMAL.
- **Dynamische Anpassung ohne Rebuild:** das wirksame
  `maxRiskPerTrade` = konfiguriertes Basis-Limit × Regime-Faktor
  (Standard: ELEVATED 0.5 → 2 % auf 1 %, EXTREME 0.25 → 0.5 %). Der Faktor
  liegt immer in (0, 1] — das System kann per Marktzustand **nur senken**,
  nie erhöhen. Der Boden bleibt das absolute Code-Minimum (0.002).
- **Anti-Flapping (schnelle Volatilitätswechsel):** Eskalation sofort
  (sichere Richtung), De-Eskalation erst nach `adp.deescalateAfter`
  konsekutiven ruhigen Bewertungen (Standard 3 ≈ 3 min). Implementiert als
  reine, getestete `RegimeStateMachine`.
- **Fehlende Daten (Fail-Open):** ein Indikator ohne Daten triggert nie
  (VIX-Timeout, leere Kerzen, NaN) — Reduktionen können ausbleiben, Risiko
  kann nie steigen. Der letzte wirksame Zustand bleibt bei Fehler bestehen.
- **Laufzeit-Konfiguration ohne Neustart:** alle Schwellwerte und Faktoren
  sind im Risk-Tab des Dashboards bzw. via `PUT /api/firm/config`
  (Keys `adp.*`) änderbar; Klemmung gegen `VOLATILITY_CONFIG_BOUNDS`.
- **Multi-Prozess:** der aktive Faktor wird persistiert
  (`adp.activeFactor` / `adp.activeAt`, Frische 15 min), damit der separate
  Mikro-Executor-Prozess (`npm run micro`) die Reduktion ohne eigenen
  Marktzugriff übernimmt.

### Neu: Observability für Agenten & Monitoring

- **`GET /api/firm/risk/volatility`** — Regime, Basis-/effektives
  `maxRiskPerTrade`, Faktor, alle Indikatorwerte mit Schwellen und
  Trigger-Status, Ring-Buffer der letzten 50 Trigger-Events (wann/warum),
  aktive Konfiguration + erlaubtes Fenster, `lastUpdate`/`lastChange`/`stale`.
- **`POST /api/firm/risk/volatility`** — sofortige Neubewertung erzwingen
  (Token + Rate-Limit wie die anderen Schreib-Endpunkte).
- **Audit-Log:** Event `RISK_ADAPTIVE` (WARN bei EXTREME) bei jeder
  Regime-/Limit-Änderung — dauerhafte Historie neben dem In-Memory-Buffer.
- **`GET /api/firm`** liefert zusätzlich `adaptiveRisk` (Status) und
  `volatilityConfig` (Parameter + Fenster); `GET /api/firm/config` ist
  nun namespace-getrennt (`config.limits` / `config.volatility`).
- **Agenten-Turn-Trace:** neue Schicht „ADAPTIVES-RISIKO“ zeigt pro Turn
  Regime, wirksames Limit und Begründung im Protokoll.
- **Monitor-Tick** bewertet bei jedem Durchlauf (60 s) die Volatilität;
  `TickResult` enthält jetzt den `adaptiveRisk`-Zustand.
- **Dashboard:** Risk-Tab zeigt Regime-Badge (grün/gelb/rot), Basis-→
  wirksames Limit, Indikator-Tabelle und letztes Trigger-Event; neue
  Sektion „Volatilitäts-Schwellwerte & Faktoren“ (laufzeitänderbar).

### Behoben

- **Prozent-Eingaben im Config-API wurden verfälscht:** `PUT /api/firm/config`
  nahm für Unit `%` die Prozentzahl (Eingabe 30) als Bruchteil (30.0) an und
  klemmte sie auf das Code-Ceiling — z. B. `maxPositionPct` 30 % → 0.5 statt
  0.3. Jetzt wird Unit `%` korrekt mit ÷ 100 normalisiert (regressionstestbar).

### Architektur (Sandbox-Prinzip, dreistufige Kaskade)

```
Code-Ceilings (LIMIT_CEILINGS, hartkodiert)
  └─ Basis-Limit (risk_config, Dashboard/API — Operator)
       └─ adaptiver Marktfaktor (adaptiveRisk.ts — VIX/ATR/BBW/StdDev)
            → wirksames maxRiskPerTrade (getLimits(), alle Order-Pfade)
```

`0.02` ist damit nur noch STARTWERT des konfigurierten Basis-Limits; die
harten Grenzen (Ceilings/Floors) bleiben bewusst im Code.

### Getestet

- **43 neue Tests** (`npm test` → 235 grün): Unit-Tests je Indikator
  (exakte Werte, Monotonie, unzureichende Daten, NaN/negative Werte),
  komplette Regime-Entscheidungs-Matrix, Hysterese-Sequenzen (inkl.
  schneller Wechsel/Flapping-Schutz), Misskonfigurations-Schutz
  (vixExtreme < vixHigh), Faktor-Klemmung (nie > 1, Code-Boden),
  DB-Neulade-Kumulations-Regression, Integrationstests mit simulierten
  Marktlagen (VIX 35 → 0.01, VIX 45 → 0.005, Korb-Sturm, VIX-Timeout
  Fail-Open, leere Kerzen, Laufzeit-Schwellwertwechsel ohne Neustart,
  Min-Interval/Single-Flight, Observability-Status + Event-Historie).
- `npm run typecheck`, `npm run lint` und `npm run build` fehlerfrei.

### Migrationshinweis

Kein Schema-Bruch — `risk_config` wird nur um `adp.*`-Zeilen ergänzt
(Seed-`POST /api/seed` rüstet nach; `drizzle-kit push` bleibt no-op).
Neu in der DB: `adp.activeFactor` / `adp.activeAt` (werden automatisch
vom System geschrieben — nicht manuell bearbeiten).

---

## [1.6.1] — 2026-08-26

**Bugfix-Release: `drizzle-kit push` bricht ab (42601), Risiko-Config-Save
crasht (22P02), Versionsnummer + Pipeline-Statusleiste.**

### Behoben

- **`drizzle-kit push` — syntax error 42601 beim Index `trade_rules_active_symbol_unique`.**
  Die Indexdefinition lag als eine SQL-Zeile mit Tuple
  `("symbol", COALESCE("mission_id", ''))` an. Drizzle-Kit rendert daraus
  `USING btree (("symbol", …))` — ein Row-Constructor im btree-Index, den
  PostgreSQL verweigert; der Push brach genau dort ab (Position 95).
  Zusätzlich war `''` als COALESCE-Platzhalter für die UUID-Spalte
  `mission_id` ungültig (22P02). Jetzt: zwei Indexspalten
  (`symbol`, `COALESCE(mission_id, NULL-UUID)`), partiell auf
  `status = 'ACTIVE'`. Semantik unverändert (pro Symbol/Mandat höchstens
  eine aktive Regel — jetzt auch erstmals *erzwingbar*). Beide Spalten sind
  SQL-Chunks, damit der Push-Diff den Index nicht bei jedem Lauf als
  geändert erkennt (Drizzle-Kit markiert Mixed-Index-Spalten beim
  Introspektieren auf Index-Ebene als Expression → DROP/CREATE-Drift).
- **`risk_config` — Crash bei `allowShort` (22P02: invalid input syntax
  for type numeric: "true").** Die Spalte `value` ist `numeric`,
  `setConfigValue()` persistierte aber `String(true)`/`String(false)`.
  Boolesche Limits werden jetzt als 0/1 gespeichert (konsistent mit dem
  Seed); die Lese-Seite akzeptiert zusätzlich Legacy-"true"/"false".

### Neu

- **Versionsnummer in der Fußzeile** des Dashboards (aus `package.json`,
  einziger Wahrheitsort `src/lib/version.ts` — derselbe Wert wie
  `/api/health` → `"version"`).
- **Pipeline-Statusleiste:** „Pipeline gestartet — läuft“ erscheint als
  pulsierender Emerald-Block mit Glow + Spinner (auch bei Neustart),
  danach grün „Pipeline fertig“ (löst sich nach 20 s), bei Fehler rot und
  bleibend. Der „▶▶ Ganze Pipeline“-Button leuchtet während des Laufs.
  `prefers-reduced-motion` wird respektiert.

### Migrationshinweis

`npx drizzle-kit push` legt den korrigierten Index
`trade_rules_active_symbol_unique` an (frühere Push-Läufe haben ihn nie
erzeugt — der Abbruch geschah genau an dieser Stelle). Keine Datenänderung.

---

## [1.6.0] — 2026-08-26

**Event-Driven Multi-Zyklen-Architektur: Makro (LLM, 1×/h) und Mikro
(kein LLM, pro Preis-Tick) vollständig entkoppelt — die alte lineare
Pipeline bleibt als Referenz/Workshop-Pfad erhalten.**

### Neu: Regelwerk & Regel-Engine (LLM-frei)

- **`src/lib/ruleEngine.ts`** — deterministische Regel-DSL: Whitelist-Felder
  (`rsi14`, `volumeRatio`, `ema9/21/50`, `trend`, `atrPct`, …), Operatoren
  (`lt/lte/gt/gte/eq/between/in`), `sanitizeRuleSpec()` (Normalisierung +
  Klemmung gegen Code-Ceilings — auch `__proto__`-Schutz), Kompilierung zu
  schnellen Closures, Snapshot-Berechnung, deterministischer Backtest.
- **`src/lib/ruleService.ts`** — Persistenz & Versionierung: `trade_rules`
  (immutable Versionen, DRAFT → ACTIVE → SUPERSEDED/PAUSED/ARCHIVED/REJECTED),
  idempotentes Upsert über Signatur, atomares Aktivieren mit partiellen
  UNIQUE-Indizes, **Rollback** über `previous_version_id`, Feedback-Aggregation
  (`rule_executions` + `positions.rule_id` → P&L/Win-Rate je Regel).
- **`src/lib/microExecutor.ts`** — Mikro-Zyklus als reiner TS-Pfad **ohne
  jeden LLM-Import** (per Test abgesichert): Binance-WebSocket-Feed
  (`@trade` + `@kline_1m`, Reconnect mit Backoff), `RollingTimeframeSeries`
  (1m→5m/15m/30m/1h, REST-Seed, RAM only), `RuleCache` (kompilierte
  ACTIVE-Regeln, Cooldown/Tageslimit in-Memory, Poll + Invalidation),
  `MicroExecutor` (Hot-Path-Metrik `latencyMicros`), Paper-Adapter mit
  **Postgres-Advisory-Lock pro Symbol** und DB-Wahrheitsprüfung
  (Kill-Switch, Positionssperre, Mission-Status) sowie determinstische
  `SimulatedFeed`/`SequenceFeed`.
- **`src/lib/macroCycle.ts`** — Makro-Zyklus: Research erzeugt den
  Regel-Entwurf (LLM, JSON-Schema erzwungen), CEO prüft/revidiert
  (APPROVE/REVISE/REJECT), hartes Risk-Gate, Upsert + Aktivierung;
  ohne LLM deterministischer Fallback (`sourceMode: FALLBACK`). Läuft im
  Scheduler-Takt `MACRO_CYCLE_INTERVAL_MIN` (Default 60 min).
- **`scripts/micro-executor.ts`** + **`deploy/micro-executor.service`** —
  eigenständiger Executor-Prozess (`npm run micro`) mit Health-HTTP
  (`MICRO_HEALTH_PORT`, Default 3380).
- **Neue API:** `GET/POST /api/firm/rules`, `POST /api/firm/rules/[id]`
  (activate/pause/archive/rollback/reject), `POST /api/firm/rules/[id]/backtest`,
  `POST/GET /api/firm/macro`, `GET /api/firm/micro`.
- **Neue DB-Tabellen:** `trade_rules`, `rule_executions`, `rule_backtests`;
  `positions.rule_id` für die P&L-Zuordnung; `checkSchema()` erweitert.
- **Doku:** neue Blaupause [ARCHITECTURE.md](ARCHITECTURE.md); HANDBUCH
  Kap. 15 (Makro/Mikro), 16 (Agenten-Register: **alle zwölf Rollen**),
  17 (Regel-API), 18 (Review-/Security-Checkliste); README aktualisiert.

### Behoben

- **Protokoll-Typen sauber getrennt:** `agent_messages` enthält nicht nur
  Agentenentscheidungen, sondern auch `ANALYSIS`/`RECOMMENDATION` und
  `MARKET_SCAN`. `GET /api/firm/log` liefert deshalb jetzt eine diskriminierte
  `entries`-Timeline. Das Dashboard stellt Analystenberichte (z. B. Cassini,
  Hubble) als Analyse mit Einschätzung/These dar und Systemmeldungen als solche
  — nie mehr als leere „Entscheidung (geparst)“ mit `?` oder `NaN s`.
- **Altbestand kompatibel:** fehlende historische Latenz/Quelle wird explizit
  als `null` normalisiert und im UI ausgelassen; verwaiste Agenten und
  Markt-Scans erhalten lesbare System-/Archiv-Attribution statt Platzhaltern.
  Neue Kern- und Analysten-Einträge speichern zusätzlich einen Actor-Snapshot
  sowie LLM-Trace (Quelle, Modell, Latenz, Prompt, Rohergebnis).
- **API-Kompatibilität:** Das bestehende Feld `turns` bleibt erhalten, enthält
  jetzt bewusst nur echte Agentenentscheidungen (z. B. für den Workshop).
  Die vollständige gemischte Chronologie steht additiv in `entries`.

### Getestet (Peer-Review)

- **181 Unit-Tests grün** (`npm test`; +32 neue: `tests/ruleEngine.test.ts` und
  `tests/microExecutor.test.ts`). Neue Abdeckung: Whitelist/Klemmung/
  Prototype-Pollution, Kompilierung, Snapshot-Determinismus, Backtest-
  Szenarien (Dip-Gewinn, Stop-Vorrang, keine Fehlsignale), **Import-Graph-
  Guard** (kein `ollama`/`llmProvider`/`engine` im Mikro-Pfad), Cooldown/
  Tageslimit/Fenster, Tick→Match→Adapter-E2E ohne DB, Latenz-Grenzen.
- `npm run typecheck` + `npm run lint` sauber; `npm run build` inkl. neuer
  Routen erfolgreich; `npm audit`: 0 Schwachstellen.
- Standalone-Smoke: `npm run micro` startet mit Sim- und Binance-Feed,
  Health-Endpunkt antwortet; ohne DB bleibt der Prozess am Leben
  (RAM-Cache, Fail-safe).

---

## [1.5.4] — 2026-08-26

**Setup-Schritt 2 repariert: `initdb`-Erfolg wurde fälschlich als „Cluster
unvollständig“ gemeldet (Rechte-Fehlalarm); umfassende Fehlerdiagnose und
Sofort-Hilfe-Anleitung ergänzt.**

### Ursache (Vorfall Nr. 2)

`initdb` läuft durch („Erfolg“), das Skript meldet trotzdem
`✗ Cluster nach initdb weiterhin unvollständig`. Grund: `initdb` setzt
`/var/lib/postgres` und `/var/lib/postgres/data` auf **0700 postgres:postgres**.
Die Cluster-Checks (`test -f PG_VERSION`, `global/pg_control`,
`global/pg_filenode.map`) liefen aber als **aufrufender Benutzer** →
`Permission denied` → falsch negativ. Dieselbe Ursache hatte die irreführende
Meldung „Datenverzeichnis existiert nicht oder ist leer“. Folge: Das Skript
hielt einen **vollständigen** Cluster für defekt und bot eine (datenzerstörende)
Neuinitialisierung an.

### Behoben

- **`scripts/lib/pg-cluster.sh` (neu):** Alle Prüfungen am Datenverzeichnis
  laufen als Cluster-Benutzer (`sudo -u postgres`, per `PG_SUDO_USER`
  übersteuerbar; Root/User selbst ohne sudo). Enthält:
  - Grundgerüst-Check (`PG_VERSION`, `global/pg_control`, `base/`) + optionaler
    Relmap-Marker **versionstolerant** (PG ≤ 18 verlangt `global/pg_filenode.map`,
    PG ≥ 19/unbekannt nur noch Warnpfad — künftige Major-Versionen brechen
    nicht mehr fälschlich ab);
  - **Versionsabgleich** Cluster ↔ Server (`PG_VERSION` + `pg_controldata`):
    Major-Mismatch ⇒ **Abbruch mit pg_upgrade/pg_dumpall-Anleitung statt
    automatischem, datenzerstörendem initdb**;
  - `pg_controldata`-Validierung (Version + Cluster-State) statt Datei-Raten;
  - ausführliche Diagnose (Owner/Rechte, Inhalt, PG_VERSION ↔ Server,
    pg_control, freier Platz, laufende Prozesse) — alles als postgres-Benutzer.
- **`scripts/setup-cachyos.sh` (Schritt 2):**
  - Preflight: sudo vorhanden? `postgres`-User existiert? sudoers-Mitgliedschaft?
  - Cluster-Check über den neuen Helper; Fehldiagnose „existiert nicht“ nur
    noch, wenn das Verzeichnis wirklich fehlt (sonst „Rechte nicht lesbar“);
  - nach `initdb`: erneute Verifikation mit Diagnose + **manuellem Fahrplan**
    (exakte Kommandos, inkl. „Nicht als root, nicht als normaler User —
    sondern `sudo -u postgres pg_ctl …` bzw. `sudo systemctl start postgresql`“);
  - Postgres-Dienststart: Port-/Fremdinstanz-Erkennung (fremder Prozess auf
    5432 ⇒ Abbruch; eigener, manuell gestarteter `pg_ctl`-Prozess auf
    demselben Cluster ⇒ Wiederverwendung mit Warnung);
  - veraltete `postmaster.pid` wird erkannt und (wenn der Prozess tot ist)
    entfernt; wartet nach `systemctl stop` auf echten Stop;
  - Cluster-Benutzergruppe dynamisch (`id -gn`), Locale-Fallback `C.UTF-8 → C`.
- **Neue Anleitung `docs/SETUP_PG_TROUBLESHOOTING.md`** (auch im Dashboard:
  `/api/docs?name=pgsetup`): Schritt-für-Schritt-Soforthilfe für den aktuellen
  Zustand, alle Fehlerfälle (Rechte, Version-Mismatch, postmaster.pid,
  Port-Konflikt, sudo/Benutzer, Logs) und eine Entscheidungstabelle.
- INSTALL.md Kap. 9/11 und HANDBUCH 10.6 verweisen auf die neue Anleitung.

### Getestet (Peer-Review)

- 149 Unit-Tests grün (`npm test`; +9: 8 neue in `tests/setupCluster.test.ts`
  plus 1 neuer Rechte-Regressionstest in `tests/dbConfig.test.ts`).
  Die Regressionstests stellen den Vorfall **mit echten Rechten** nach:
  Cluster-Verzeichnis gehört `nobody` und hat Mode 0700 — `test -f` als
  Aufrufer scheitert (EACCES), der neue Helper erkennt den Cluster trotzdem.
  Zusätzlich: Ablehnung unvollständiger PG-18-Cluster, Toleranz für
  künftige Layouts (PG 19 ohne Relmap), Versions-Mismatch,
  pg_controldata-Parser, set -e-Sicherheit.
- `npm run typecheck` + `npm run lint` sauber, `npm audit`: 0 Schwachstellen.
- **End-to-End** (Mock-systemd + Mock-initdb + echtes `sudo -u nobody` +
  PGlite-wire-Postgres):
  - Leeres Verzeichnis → `initdb` → Cluster wird als vollständig erkannt
    (vorher: „weiterhin unvollständig“) → Benutzer/DB → `drizzle-kit push`
    (9 Tabellen) → `next build` ✓;
  - **Datenschutz-Test:** vollständiger 0700-Cluster mit Sentinel-Datei →
    kein Neuinitialisierungs-Dialog, Sentinel überlebt, Setup läuft durch.

---

## [1.5.3] — 2026-08-26

**Setup-Installation läuft wieder durch: `${PGROOT}`-False-Positive behoben;
außerdem Passwort-URL-Encoding, echter `ANALYST_INTERVAL_MIN`-Zyklus und
durchgesetzte Missions-Positionsgrenzen.**

### Behoben

- **Setup-Skript (Schritt 2) — der gemeldete Installationsabbruch:**
  `systemctl show -p ExecStart --value postgresql.service` liefert die
  Arch-Unit-Zeile **unexpandiert** (`-D ${PGROOT}/data`). Der Datadir-Sicherheitsgurt
  verglich diesen Literalstring mit `/var/lib/postgres/data` und brach fälschlich ab:
  `✗ postgresql.service nutzt ein anderes Datenverzeichnis: '${PGROOT}/data'`.
  **Fix:** neues Modul `scripts/lib/pg-service.sh` — liest die
  Unit-Environment (`systemctl show -p Environment`, inkl. `EnvironmentFile`/Drop-ins)
  und expandiert `${VAR}`/`$VAR` im `-D`-Pfad, **bevor** verglichen wird. Versteht
  zusätzlich die systemd-Ausgabeformate `{ path=… ; argv[]=… }`, gequotete
  argv-Tokens und fällt bei fehlendem Bus auf `systemctl cat` zurück
  (Haupt-Unit + Drop-ins, letzte Definition gewinnt). Regressionstests simulieren
  die exakte Nutzer-Unit mit gemockter `systemctl`-Binary
  (`tests/setupPgService.test.ts`).
- **Setup-Skript: Passwort-URL-Encoding** — Zeichen wie `@ : / % + #` im
  DB-Passwort brachen die `DATABASE_URL` (psql, node-postgres, drizzle-kit).
  **Fix:** `jq '@uri'` vor dem URL-Bau; zusätzlich wird auch im
  „Benutzer existiert bereits“-Zweig ein leeres Passwort abgewiesen.
- **Scheduler:** `ANALYST_INTERVAL_MIN` wurde nur geloggt — der Analystenzyklus
  lief tatsächlich **jede Minute** (der v1.4.0-Kommentar versprach „echter Abstand“,
  der Code hielt es nicht). **Fix:** Slot-Key aus Berliner Tag + Intervallfenster
  (`Math.floor(Date.now() / analystIntervalMs)`), Overlap-Schutz gegen lange Läufe.
- **Missions-Cap wird durchgesetzt (Risiko-Entschärfung):** `missions.maxPositionPct`
  stand nur im Prompt — die PENNY-Mission („max 5 %“) konnte real **25 %** des
  Kapitals binden. **Fix:** `missionSizedNotional()` in `riskGuard.ts`
  (min(Missions-Cap, Code-Maximum), Sandbox-Prinzip), von der Engine verwendet;
  der Trace zeigt jetzt die wirksame Obergrenze.
- **Setup-Skript Konsistenz (Variante A):** `MODEL_EXECUTOR` wurde als 3b
  geschrieben, `.env.example`/Docs sagen 1.5b für den N150 — jetzt 1.5b.

### Getestet (Peer-Review)

- 138 Unit-Tests, alle grün (`npm test`) — inkl. neuer Regressionstests für
  `${PGROOT}`-Expansion, systemd-Formate, URL-Encoding, Missions-Sizing und
  Analysten-Intervall.
- `npm run typecheck` und `npm run lint` fehlerfrei; `npm audit`: 0 Schwachstellen.
- End-to-End gegen einen echten TCP-Postgres (PGlite-wire): kompletter
  `./scripts/setup-cachyos.sh --variant a`-Durchlauf mit der **exakten
  Arch-Unit des Nutzers** als Mock — Datadir-Check `✓`, hostile password
  `O'Brien@x:y/z p+q#%` angelegt und URL-encodet, `drizzle-kit push` → 9 Tabellen,
  `next build` ✓; zweiter Lauf (Idempotenz) ✓.
- Produktionsstart + `scripts/smoke-test.sh`: **18/18 Checks bestanden**
  (Pipeline → Paper-Trade → Kill-Switch → Flatten → Report/Kurve/Log →
  Ceiling-Klemmung). PENNY-Mission: Position ≈ 500 € statt 2.500 €.

---

## [1.5.2] — 2026-08-26

**Setup-/PostgreSQL-Robustheit: `global/pg_filenode.map`, ECONNREFUSED und
`next build` ohne `.env` behoben.** Ursachenanalyse und Fixes für den
Produktionsvorfall „Installation bricht bei Schritt 2 ab, danach schlagen alle
DB-Queries fehl“.

### Behoben

- **Setup-Skript (Schritt 2):** `sleep 1` + `systemctl is-active` meldete
  PostgreSQL fälschlich als „läuft“, obwohl ein halb initialisierter Cluster
  (fehlender `global/pg_filenode.map`) in einer Restart-Schleife crashte. Die
  Folge: `psql`-Fehler, danach fragte das Skript trotzdem nach dem
  Datenbank-Passwort und starb mit demselben Fehler. Neu:
  - Cluster-Vollständigkeit (`PG_VERSION`, `global/pg_control`,
    `global/pg_filenode.map`) wird **vor** dem Dienststart geprüft;
  - der Dienst wird vor einer Neuinitialisierung **gestoppt** (kein Race gegen
    systemd-Auto-Restart mehr);
  - echte Bereitschafts-Wartung mit `pg_isready` (30 s Timeout, Logauszug aus
    `journalctl` bei Fehlschlag) statt blindem Sleep;
  - harte SQL-Verifikation als Superuser, **bevor** Benutzer/Passwort abgefragt
    werden — der Fehler wird nicht mehr vom `if/grep` verschluckt;
  - Abgleich des systemd-Datenverzeichnisses gegen das erwartete
    `/var/lib/postgres/data` (Drop-in-Erkennung).
- **Quote-/Injection-Bug im Setup-Skript:** `CREATE USER … PASSWORD
  '${DB_PASS}'` brach bei einem `'` im Passwort das SQL. Neu: psql-Variablen
  (`-v db_pass=…` + `:'db_pass'`), kontextsicher maskiert; DB-User/DB-Name
  werden per Regex validiert. Gegen echte PostgreSQL 16/18 mit feindlichem
  Passwort (`O'Brien"; DROP SCHEMA public; --`) getestet.
- **`initdb`-Defaults:** `--data-checksums --auth-local=peer
  --auth-host=scram-sha-256` — keine „trust“-Warnung mehr, Korruption wird
  erkannt, TCP-Logins laufen über scram-sha-256.
- **`next build` ohne `.env` (frischer Clone):** `src/db/index.ts` warf beim
  Modul-Import ohne `DATABASE_URL` und riss damit den Build während der
  Next.js-Page-Data-Collection ab (`Failed to collect page data for
  /api/firm/agents`). Neu: Pool/Drizzle werden **lazy** beim ersten Zugriff
  erzeugt (Proxy-Facade); der Import ist ohne Konfiguration harmlos, die erste
  echte Nutzung wirft eine präzise, actionabel Fehlermeldung. Build und Tests
  funktionieren damit auch ohne `.env`.
- **`uncaughtException` bei PostgreSQL-Ausfall:** Fällt PostgreSQL weg, während
  Pool-Verbindungen idle sind (SIGTERM → `57P01`), emittierte node-postgres ein
  `'error'`-Event ohne Listener → uncaughtException mit riesigem Objekt-Dump im
  Journal. Fix: Pool-`'error'`-Handler (`[db] Pool-Fehler (idle client): …`);
  die App degradiert kompakt und erholt sich nach DB-Rückkehr ohne Neustart
  (end-to-end verifiziert).
- **SL/TP gingen bei der Broker-Hydration verloren:** `getBroker` reichte
  `stop_loss`/`take_profit` beim Wiederherstellen aus der DB nicht an den
  Paper-Broker weiter — das Dashboard zeigte nach jedem Neustart „kein
  Stop-Loss", obwohl die DB ihn hat (die Absicherung via Monitor blieb intakt,
  die Anzeige log). Fix: SL/TP werden mithydratiert und in `hydrate()`
  zusätzlich gesanitized (null/NaN/≤0 → null).
- **Missions-API-Fehlermeldung mehrdeutig:** `POST /api/firm/missions` erwartet
  Bruchteile (0.02 = 2 %), die Meldung nannte nur Prozent („zwischen 0.2 % und
  5.0 %"). Neu: Meldung nennt Bruchteil **und** Prozent mit Umrechnungshinweis.

### Hinzugefügt

- **8 Regressionstests** (`tests/dbConfig.test.ts`, `tests/broker.test.ts`):
  pg_isready-Wartung, Cluster-Vollständigkeitsprüfung, initdb-Auth-Flags,
  injection-sichere Passwort-Interpolation, Import ohne `DATABASE_URL`
  (Subprozess), actionable Fehlermeldung bei Nutzung ohne `DATABASE_URL`,
  Pool-`'error'`-Handler sowie Erhalt/Sanitizing von SL/TP bei der Hydration.
- **Handbuch-Runbook 10.6 „PostgreSQL-Cluster defekt“** — Diagnose und
  Reparatur des `pg_filenode.map`-Zustands inkl. der kettenreaktionsartigen
  Symptome (Scheduler-/Hydration-Fehler, Setup-Seite, `ECONNREFUSED` beim Push).
- INSTALL.md: gehärtete initdb-Zeile, `pg_isready`-Schritt, aktualisierte
  Fehlertabelle (u. a. entfernte, veraltete `SCHEMA_MISSING`/HTTP-503-Zeile).

### Diagnose

- Der Vorfall ist vollständig reproduziert und verifiziert: Ein Cluster mit
  fehlender `global/pg_filenode.map` startet laut `pg_ctl status`/systemd
  normal („running“/„active“), nimmt aber keine Verbindungen an
  (`pg_isready` → *rejecting*) und wirft exakt
  `FATAL: could not open file "global/pg_filenode.map"`.
- End-to-End gegen echte PostgreSQL-18-/16-Cluster geprüft: Setup-Kette
  (initdb → User/DB mit feindlichem Passwort → `drizzle-kit push` → Seed →
  Pipeline-Run → Position/Equity/Audit), Deprecation-freier Build mit und ohne
  `.env`, DB-Ausfall mitten im Betrieb (kompakte Degradation) und
  Wiederanlauf ohne Dienstneustart.

---

## [1.5.1] — 2026-08-25

**Sicherheits-Härtung und DB-Konfigurationsdiagnose.** Peer-Review-Fixes für
Fehlerbehandlung in API-Routen und gehärtete Datenbank-Pool-Konfiguration.

### Behoben (Sicherheit)

- **S-21 (Medium)**: API-Routen `firm/run`, `firm/tick`, `firm` (GET) gaben rohe
  Fehlermeldungen an den Client zurück. Datenbank-Connection-Strings und interne
  Details konnten in HTTP-Responses landen. Fix: `publicErrorMessage()` in allen
  betroffenen catch-Blöcken.
- **S-22 (Low)**: `GET /api/firm` hatte keinen try/catch — DB-Ausfall führte zu
  unhandled exceptions mit potenziellem Stack-Trace-Leak. Fix: 503 mit redacted
  Error und Fix-Hinweis.
- **S-23 (Low)**: DB-Connection-Pool hatte keine `max`-Grenze und keine Timeouts.
  Fix: `max: 10`, `connectionTimeoutMillis: 5000`, `idleTimeoutMillis: 30000`.

### Hinzugefügt

- **12 neue Tests** (`tests/dbConfig.test.ts`): Validierung der DB-Konfiguration,
  Sicherheitsdirektiven und Fehlerbehandlung. Prüft drizzle.config.ts auf
  Hardcodierung, Pool-Sicherheit, Security-Header und API-Error-Redaktion.

### Diagnose

- Der Datenbankfehler `password authentication failed for user "trader"` ist
  ein Konfigurationsproblem — das Setup-Script `scripts/setup-cachyos.sh` legt
  den User korrekt an, muss aber ausgeführt werden. Siehe `docs/INSTALL.md`.

---

## [1.5.0] — 2026-08-25

**Workshop: Handbuch-Kapitel 5 und 6 ohne Terminal.** Neuer Dashboard-Reiter
🛠 Workshop mit vier Schritten (Mission anlegen → Agent ausführen → Prompt
iterieren → Trefferquote messen), dazu die passenden API-Routen. Kein
Schema-Bruch, keine neuen Pflicht-Env-Variablen. Nach `git pull`:
`npm ci && npm run build` und Dienst neu starten.

### Added
- **Reiter „🛠 Workshop“** (`src/components/workshop/`):
  - **1 · Mission anlegen/bearbeiten** (5.1–5.3): Formular mit Titel, Ziel,
    Symbol-Autocomplete (aus `GET /api/firm/missions` → Broker-Liste),
    Risikobudget % und max. Position %; Nachschlagkasten mit Faustregel
    („nicht per SQL prüfbar → zu vage“) und der Schlecht/Besser-Tabelle aus 5.2.
  - **2 · Agent ausführen** (6.2): Agent + Mission wählen, ein Turn; Ergebnis
    formatiert (`type`/`side`/`stopLossPct`/`riskScore`/`reason` mit
    Hover-Erklärungen), Guardrail-Kette aufklappbar, Rohdaten-Anzeige; rechts
    die letzten 3 Agenten-Nachrichten mit Quelle und Latenz.
  - **3 · Prompt iterieren** (6.3): `system_prompt`-Editor mit sofortiger
    Wirkung (DB, kein Neubau), JSON-Sollformat + vollständiges Beispiel,
    Feld-Hilfen zu `type`/`side`/`stopLossPct`/`riskScore`, „Beispiel an Prompt
    anhängen“-Knopf, grünes Speicher-Bestätigungsfeld. Bewusst **ohne**
    Guardrail-Regler (weiche vs. harte Schicht).
  - **4 · Trefferquote** (6.4): sequenzielle Testschleife (1–20 Läufe, Standard
    10) mit Live-Balken (TRADE / HOLD / HOLD·kaputtes JSON / ERROR / ANDERE),
    automatischen Debug-Tipps ab 2 JSON-Fällen bzw. 20 % Anteil, Fehlerliste
    mit Sprung ins Protokoll-Tab; Stop-Knopf; sauberes 429-Handling.
- **Hover-/Tastatur-Hilfe überall**: `InfoTip`-Komponente (i-Symbol) auf jedem
  Feld und Fachbegriff — Tooltip bei Hover UND Focus, `title`-Fallback,
  `aria-label` + sr-only-Text für Screen Reader.
- **API-Routen**: `GET/POST/PUT /api/firm/missions` und `PUT /api/firm/agents`
  (nur `system_prompt`). Budgets werden gegen `LIMIT_CEILINGS` validiert (90 %
  Risiko → 400 statt Broker-Block), Symbole gegen die Paper-Broker-Liste,
  Prompts auf Länge; Audit-Einträge `MISSION_CREATED`/`MISSION_UPDATED`/
  `AGENT_PROMPT_UPDATED`.
- **`src/lib/workshop.ts`**: reine Validierungs-/Klassifikationslogik
  (`validateMissionInput`, `validatePromptInput`, `classifyTurnOutcome`,
  `aggregateOutcomes`), von Routen und Tests geteilt.
- **Typsicherheit**: `src/lib/types.ts` (AgentRow, MissionRow, TurnResultDto,
  Response-Interfaces) — `FirmData.agents/missions` typisiert statt `any`.
- **`src/lib/apiClient.ts`**: geteilter `apiFetch` (Token-Header) +
  `readJson`-Fehlerwrapper für aussagekräftige API-Fehlermeldungen.
- `GET /api/firm/log` liefert jetzt auch `content` (Kurzform der Nachricht) —
  Grundlage für die „letzten 3 Nachrichten“-Anzeige.
- Neue Tests: `tests/workshop.test.ts` (Validierungs-Edge-Cases: leere
  Eingaben, 90-%-Budget, unbekannte Symbole, Prompt-Grenzen, Warnungen;
  Klassifikation TRADE/HOLD/INVALID_JSON/ERROR; Aggregation inkl. Tipps-
    Schwelle und Division durch 0).

### Changed
- `package.json` Version **1.5.0**.
- Handbuch 2.3/4.1/5.1–5.3/6.1–6.4: UI-Weg jeweils vorangestellt, Terminal als
  Alternative belassen; API-Tabelle um die Workshop-Routen ergänzt.

### Security
- Missions-/Prompt-Endpunkte hängen am bestehenden `guardWrite` (Token +
  Rate-Limit); DB-Fehler werden als 503 mit redaktierter Meldung
  (`publicErrorMessage`) zurückgegeben statt als undurchsichtiger 500-Crash.
- Missions-Budgets werden **serverseitig** gegen die Code-Deckel geprüft —
  die UI ist nur Anzeige, nicht Kontrollinstanz.

---

## [1.4.0] — 2026-08-25

Security-Härtung, Provider-Korrektheit und Scheduler-Fix. Kein Schema-Bruch,
keine neuen Pflicht-Env-Variablen. Nach `git pull`: `npm ci && npm run build`
und Dienst neu starten.

### Added
- **Schreib-Rate-Limit** für POST/PUT (`guardWrite`): Standard 60 Anfragen / 60 s,
  abschaltbar via `FIRM_RATE_LIMIT=0`. Antwort 429 + `Retry-After`.
- **Secret-Redaktion** (`src/lib/secrets.ts`): Connection-Strings, Bearer-Tokens
  und API-Keys werden aus Health-Fehlern, LLM-Logs und öffentlichen Error-Strings
  entfernt.
- **`extractJsonObject()`**: sicherer JSON-Extractor für Analysten-Payloads
  (view/thesis/recommendation), ohne Prototype-Pollution.
- **`envInt()`**: NaN-feste Env-Zahlen mit Clamp — `TICK_INTERVAL_MS=abc` startet
  den Scheduler nicht mehr mit `setInterval(NaN)`.
- Neue Tests: `tests/hardening.test.ts` (Secrets, Token, Rate-Limit, Intervalle,
  parseDecision-Allowlist, Broker-Reject) plus Erweiterungen in `llmProvider.test.ts`.

### Changed
- `package.json` Version **1.4.0**.
- Gemini-Auth: Key ausschließlich im Header `x-goog-api-key` (nicht mehr als
  Query-Parameter — Keys gehören nicht in Access-Logs/Referrer).
- `LLM_MODEL` gilt jetzt für Gemini **und** Anthropic, nicht nur OpenAI-kompatibel.
- Ollama `keep_alive` ist Top-Level (API-konform); Usage (`prompt_eval_count` /
  `eval_count`) wird geparst.
- Token-Limit der Builder folgt `req.maxTokens` (nicht dem bei Client-Erzeugung
  eingefrorenen Wert).
- `parseDecision` kopiert nur Allowlist-Felder (`type/symbol/side/stopLossPct/reason/riskScore`).
- Audit-Log-Filter (`level`/`event`) und Equity-`range` sind gewhitelistet.
- Agenten-Meta speichert `provider`, `usage`, `costUsd`.

### Fixed
- **Gemini-API-Key in der URL** (High): Query `?key=` entfernte den Key in Logs.
- **Gemini-Modellliste** `models/gemini-…` wurde 1:1 in den Pfad gesetzt →
  `/models/models/…`. Prefix wird jetzt gestrippt.
- **Anthropic `listModels`** las `models[].name` statt `data[].id` → leere Liste.
- **Retry-`attempt`** war immer 1, weil `client.chat` den Zähler verwarf.
- **Analysten-Intervall**: `ANALYST_INTERVAL_MIN` wurde nur geloggt; der Slot-Key
  `HH:MM` ließ die Analysten **jede Minute** laufen. Jetzt echter Abstand
  (Default 30 min, Minimum 10).
- **Broker-Cash nach Slippage**: Prüfung gegen Pre-Slippage-Notional konnte das
  Konto um 0,1 % negativ machen. Jetzt Fill-Kosten.
- **`reject()` crashte** bei nicht-string `symbol` (`toUpperCase` auf Number).
- **`hydrate()`** übernahm unsanitized DB-Symbole in die Position-Map.
- **Kerzen-Intervalle und Yahoo-Screener-IDs** ohne Whitelist (URL-Injection).
- **Health-500** konnte `DATABASE_URL` in `error` durchreichen.
- **Provider-Base-URL**: `file:` / Userinfo (`user:pass@host`) werden abgelehnt.

### Security
- Timing-sicherer Token-Vergleich mit Längen-Padding (kein Length-Oracle).
- `npm audit`: Ziel 0 Vulnerabilities (siehe SECURITY_AUDIT.md).

### Tests
- Bisherige 67 Tests bleiben; neu ~25 Härte-/Provider-Tests. `npm test` muss
  vollständig grün sein.

### Anmerkung Migration
Kein DB-Schema-Change. `.env` optional um `FIRM_RATE_LIMIT` ergänzen.
Wer Gemini nutzt: Header-Auth ist transparent, keine Key-Änderung nötig.

---

## [1.3.0] — 2026-08-24

### Added
- **LLM-Provider-Abstraktion** (`src/lib/llmProvider.ts`) mit vier konfigurierbaren
  Providern hinter EINEM Interface:
  - `ollama` — nativer Ollama-Server (Standard)
  - `openai` — jeder OpenAI-kompatible Endpunkt (llama.cpp, LM Studio, vLLM, LocalAI, Cloud)
  - `gemini` — Google Gemini (`GEMINI_API_KEY`, `GEMINI_BASE_URL`)
  - `anthropic` — Anthropic Claude (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`)
- **Provider-Fallback-Kette** `LLM_FALLBACK_PROVIDERS` (kommagetrennt): scheitert der
  primäre Provider, werden die nächsten der Kette probiert, bevor die Regel-Engine greift.
- **Standardisierte API-Calls**: `LlmChatRequest {model, messages, temperature, maxTokens, json, schema, timeoutMs}` → `LlmChatResult {content, usage, latencyMs, costUsd}`.
- **Fehlerbehandlung & Retries**: `withRetry()` mit exponentiellem Backoff + Jitter;
  Retry nur bei Netzwerkfehlern, HTTP 429 und 5xx; `LLM_MAX_ATTEMPTS` (Standard 2).
- **Kosten-/Performance-Trade-offs**:
  - `LLM_MAX_TOKENS` (Standard 512) begrenzt jede Antwort (`num_predict`/`max_tokens`/`maxOutputTokens`).
  - `estimateCostUsd()` schätzt Kosten je Aufruf (Referenztarife + `LLM_COST_*`-Overrides, lokal = 0).
  - Token-Verbrauch (`usage`) wird in `agent_messages.meta` protokolliert.
- **Versions-Reporting**: `/api/health` und `/api/firm` liefern jetzt `version` aus `package.json`.
- **Dokumente umstrukturiert**: alle Markdown-Dateien liegen unter `docs/`
  (`docs/README.md`, `docs/INSTALL.md`, `docs/HANDBUCH.md`, `docs/CHANGELOG.md`,
  `docs/SECURITY_AUDIT.md`, `docs/PROVIDER_INTEGRATION.md`).
- Neue Tests: `tests/llmProvider.test.ts` (Builder, Parser, Retry, Backoff, Kosten,
  Fallback-Kette), `tests/broker.test.ts` (Hydration, Guardrails, Validierung),
  `tests/security.test.ts` (Symbol-Whitelist, Injection-Versuche, parseDecision-Robustheit).

### Changed
- `package.json`: Name `ai-trading-firm`, Version `1.3.0`, `engines.node >= 20`, License MIT.
- `.env.example`: neue Sektionen „Cloud-Provider", „Retries", „Kosten", „Scheduler".
- `src/lib/ollama.ts` ist jetzt die Kompatibilitäts- und Orchestrierungsschicht über
  `llmProvider.ts`; öffentliche Funktionen (`getOllamaStatus`, `localReason`,
  `fallbackReason`, `DECISION_SCHEMA`) bleiben stabil.
- `scripts/setup-cachyos.sh` erwartet jetzt **9** Tabellen (inkl. `equity_snapshots`).

### Fixed
- Siehe [1.1.0] (alle Bugfixes sind in 1.3.0 enthalten).

---

## [1.1.0] — 2026-08-24 (Security- & Stabilitäts-Release)

### Fixed (hoch)
- **P&L-Verlust nach Neustart** (`engine.getBroker` + `PaperBroker.hydrate`):
  Der Cash-Stand wurde aus `STARTING_EQUITY − Einstiegs-Notional` rekonstruiert.
  Realisierte Gewinne/Verluste geschlossener Trades gingen bei jedem Prozess-Neustart
  verloren (Depot zeigte wieder 10.000 € statt z. B. 10.200 €).
  **Fix:** letzter persistenter Cash-Wert aus `equity_snapshots` wird als `cashHint`
  übernommen; Fallback nur bei leerer/frischer DB.

### Fixed (mittel)
- **Tagesverlust-Fenster in `engine.ts`** nutzte Server-Localtime statt
  `Europe/Berlin` — inkonsistent zu `monitor.tick()` und `equity.realizedPnlToday()`
  (systemd läuft oft mit UTC). **Fix:** `startOfBerlinDay()`.
- **GET `/api/firm/tick` mutierte Zustand** (Kurse, SL/TP → Positionen schließen).
  Browser-Prefetches/Monitore lösten dort Handel aus. **Fix:** GET → HTTP 405.
- **Race Conditions**: `monitor.tick()` und `runPipeline()` hatten keinen
  Single-Flight-Schutz — überlappende Zyklen erzeugten doppelte Snapshots,
  Vorschläge und Audit-Einträge. **Fix:** Promise-Lock (Tick) bzw. Guard
  (`PIPELINE_ALREADY_RUNNING` → HTTP 409).
- **Symbol-Validierung**: Modell-/DB-Symbole flossen ungeprüft in externe URLs
  (Binance-Query), Prompts und JSONB. **Fix:** `sanitizeSymbol()`-Whitelist
  (`^[A-Z0-9]{1,12}([.=][A-Z0-9]{1,5})?$`) in `marketData`, `broker.submit` und
  `engine.runAgentTurn`; Binance-URLs zusätzlich `encodeURIComponent`.
- **Security-Header fehlten** (`next.config.ts`): jetzt CSP, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy` in Produktion (Dev bleibt offen für HMR).
- **`checkSchema()` kannte `equity_snapshots` nicht** → Healthcheck meldete
  „schemaReady" obwohl die Equity-Kurve/Snapshots fehlten; Setup-Skript prüfte 8 statt 9 Tabellen.

### Fixed (niedrig)
- `/api/firm/log?limit=NaN|-5` → SQL-Fehler 500. **Fix:** Limit auf 1–200 geklemmt.
- `stopLossPct: "abc"`/`NaN` → Order wurde mit NaN kalkuliert und pauschal geblockt.
  **Fix:** nicht-zahlfähige Werte gelten als „keine Angabe" → ATR-/Default-Fallback.
- `riskScore` aus Modell-Output ohne Zahlenvalidierung konnte Insert in `numeric`
  sprengen. **Fix:** Normalisierung auf [0,1].
- `scripts/drizzle.config.json` (veraltet, hardcodierte DB-Zugangsdaten) entfernt —
  das Projekt nutzt `drizzle.config.ts` mit `DATABASE_URL` aus `.env`.
- `scripts/smoke-test.sh` prüfte das Feld `status`/`SCHEMA_MISSING`, das die API nie
  liefert (toter Setup-Zweig). **Fix:** `schemaReady === false`.
- Scheduler-Analysten-Slot nutzte Server-Stunde statt Berliner Zeit → Doppelstart-
  Schutz griff auf UTC-Servern unzuverlässig. **Fix:** `Europe/Berlin`-Schlüssel.
- Lint: 10 Fehler in `FirmDashboard.tsx`/`docs/page.tsx` (unescaped entities,
  setState im Effekt) behoben — `npm run lint` ist jetzt fehlerfrei.
- `tsconfig.tsbuildinfo` aus dem Repo entfernt und per `.gitignore` ausgeschlossen.

### Security (geprüft, keine Änderung nötig)
- `npm audit`: **0 Schwachstellen** (Stand des Release).
- API-Token-Vergleich: `crypto.timingSafeEqual` ✓
- Keine `eval`/`child_process`/`exec`, keine `dangerouslySetInnerHTML` ✓
- `parseDecision`-Prototype-Pollution-Test (neu) ✓
- SQL: ausschließlich parametrisierte Queries via Drizzle ✓

### Tests
- 63 Unit-Tests, alle grün (`npm test`).
- Neu: Broker-Hydration (Neustart-Fix), Symbol-Injection, parseDecision-Robustheit,
  Provider-Builder/Parser, Retry/Backoff, Kosten, Fallback-Kette, KILL-Marker.

### Anmerkung Migration
Kein Schema-Bruch: `equity_snapshots` existierte bereits; geändert wurde nur die
Prüfung. Bei Alt-Installationen einfach `npx drizzle-kit push` erneut ausführen.

---

## [1.0.0] — 2026-08 (Ausgangsstand beim Audit)

Baseline: Archiv-Repository mit Engine, Paper-Broker, Ollama/OpenAI-Client,
Guardrails, Monitor, Analysten, Dashboard und erster Test-Suite (26 Tests).

---

## Offen / bewusst nicht gemacht (Backlog)

| Thema | Grund |
| --- | --- |
| Multi-Node Rate-Limit / Scheduler-Locks | v1.4.0 limiter ist prozess-lokal; Cluster bräuchte Redis/DB |
| Auto-Upgrade der Abhängigkeiten | Versions-Pins sind bewusst stabil; `npm audit` als Teil des Deploy-Checks |
| Live-Broker-Adapter (Alpaca/ccxt) | bewusst außerhalb des Paper-only-Scopes (Handbuch Kapitel 8) |
| Persistente Scheduler-Locks über Prozesse hinweg | aktuell prozess-lokal (Single-Node-Betrieb); Multi-Node bräuchte DB-Locks |
