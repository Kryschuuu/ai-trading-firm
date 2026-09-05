# Task 03 — Implementierungsplan: Paper Market Data + deterministische Execution-Simulation

**Umfang:** Broker-unabhängige Marktdaten-Schicht + 3 Paper-Modi + deterministischer
Fill-Simulator + Historical Store + Replay/Backtest + Failover + Docs.

## RECON-Ergebnis (Pfadabweichungen)

- Root `README.md` existiert **nicht**; die Doku liegt unter `docs/README.md` (Tabelle dort wird ergänzt).
- Task 01 (Market Universe) **und** Task 02 (Broker-Capability-Modell) sind gemerged:
  - `MarketInstrument` (20 Felder, `src/universe/types.ts`) und `BrokerCapabilities`
    (`src/contracts/broker.ts`, inkl. `stopAtVenue`) existieren bereits → **keine
    Duplikate**, die Unabhängigkeitsklausel greift nicht. Geteilter Contract wird
    wiederverwendet.
  - `ExecutionMode` (`backtest|paper|testnet|live`), `BrokerAdapter`, Factory mit
    `LiveTradingGateError` (Live unangetastet gesperrt) existieren.
- Bestehende Paper-Order-Pfade (`PaperBroker.submit`, `PaperBrokerAdapter.placeOrder`)
  laufen unverändert weiter; Live-Pfad bleibt hart gesperrt.
- Es gibt bereits einen `MarketFeed` in `microExecutor.ts` (Streaming-Tick-Konzept
  `start/status`). Die neue Abstraktion (getTicker/getCandles/getOrderBook/subscribe)
  ist ein **anderes** Modul unter `src/lib/marketdata/` — kein Import-Konflikt.
- `STATIC_PRICES` in `marketData.ts` wird als deprecated markiert und im Produktivpfad
  nur noch hinter `PAPER_STATIC_FALLBACK=true` verwendet (Default false).

## Architektur-Entscheidungen

1. **Neues Modul `src/lib/marketdata/`** — rein deterministisch (kein LLM, kein
   Seeding außerhalb expliziter Seed-Parameter), venue-unabhängig über `MarketFeed`.
2. **Feeds:** `BinanceFeed`, `YahooFeed`, `BrokerFeed` (delegiert an `BrokerAdapter`),
   `SyntheticFeed` (seeded, nur Modus A / expliziter Fallback), `ReplayFeed`
   (spielt Historical Store ab). Feeds nutzen eine gemeinsame `httpGetJson` mit
   Timeout + Retry/Backoff + **SSRF-Allowlist**.
3. **Normalisierung → `MarketSnapshot { instrumentId, bid, ask, last, ts, source,
   venue, feed, spread, volume24h }`.** Anomalien (NaN, Sprung > Schwellwert,
   staler Timestamp) verwerfen + loggen, nie handeln.
4. **Historical Store:** append-only NDJSON (`data/history/`) mit Provenienz
   (venue, feed, ts) — repo-konform (NDJSON-Muster wie `data/universe`).
5. **Paper-Modi:** `paperMode: 'synthetic' | 'broker-market-data' | 'broker-paper-api'`,
   Default `'broker-market-data'`. Modus C nur wählbar wenn Venue-Capability vorhanden
   + Flag gesetzt; sonst klarer Konfigurationsfehler.
6. **Fill-Simulator:** lokal, deterministisch (Seed), modelliert Maker/Taker-Fee aus
   Registry, Spread aus Bid/Ask, Slippage (linear wachsend mit Ordergröße relativ zum
   24h-Volumen), Latenz (ms), Partial Fills — alle Parameter dokumentiert.
7. **Replay/Backtest:** Kurse ausschließlich aus Historical Store; gleicher Seed +
   gleicher Store-Stand → identische Fills (Golden-Test).
8. **API:** `GET /api/marketdata/snapshot?instrument=…`, `GET /api/marketdata/status`
   — read-only.
9. **Integration:** `PaperBroker` bekommt optionale `quoteProvider` + `fillSimulator`;
   der Produktivpfad (Factory-`paperBrokerLedger`, `PaperBrokerAdapter`) nutzt den
   Manager (Modus B = reale Kurse). Raw-`new PaperBroker()` bleibt für
   Kompatibilitäts-Unit-Tests wie bisher (dokumentiert).

## Umsetzungsschritte (Conventional Commits `(task-03)`, ≥ 5)

1. `feed-abstraction` — Types, http-Helfer (Timeout/Retry/SSRF), Binance/Yahoo/Synthetic/
   Replay/Broker-Feeds.
2. `snapshot+store` — Normalisierung + Historical Store.
3. `simulator` — Fill-Simulator (deterministisch, Seed).
4. `modes+failover` — Paper-Mode-Config, Failover-Kette + Audit, MarketDataManager,
   PaperBroker-Integration, API-Routen.
5. `docs` — PAPER_TRADING.md, ARCHITECTURE.md, CHANGELOG.md, help-JSON, SECURITY_AUDIT.

## Tests (kein echtes Netz in CI)

- Simulator deterministisch (gleicher Seed → 100 identische Fills), Slippage-/Partial-
  Fill-Grenzfälle, Gebühren aus Registry-Feldern.
- Golden-/Replay: Backtest 2× → byte-identische Ergebnisdateien.
- Integration Modus B gegen lokalen Fixture-HTTP-Server (echter Kursfluss), Failover
  (Feed-Ausfall → nächster Feed + Audit-Eintrag), Stale-Kurs-Verwerfen.
- Negativ: Modus C ohne Capability → klarer Fehler; Synthetic ohne Flag → verweigert.
- Coverage ≥ 90 % neuer Code.
