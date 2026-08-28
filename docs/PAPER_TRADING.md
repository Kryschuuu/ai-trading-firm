# Paper-Trading — Market Data & deterministische Execution-Simulation (Task 03)

Dieses Dokument beschreibt, wie die Plattform von **statischem Paper-Trading**
(feste Watchlist + statisches Preisbuch) auf eine **broker-unabhängige
Marktdaten-Infrastruktur** umgestellt wird: echte Kurse (Binance/Yahoo) mit
Cache, drei Paper-Modi, Normalisierung mit Anomalie-Erkennung, ein
append-only Historical Store, ein deterministischer Fill-Simulator sowie eine
auditierte Failover-Kette. Es gibt **keinen** künstlichen Kursgenerator als
Ersatz für echte Kurse — `SyntheticFeed` ist ein deterministischer, explizit
gewählter Modus (A) bzw. nur-auf-Anforderung-Fallback.

**Rein deterministisch (Architektur-Regel 1):** Die Schichten Kursbeschaffung,
Normalisierung und Fill-Simulation enthalten **keinen LLM-Zugriff**.
Deterministische Teile (Simulator, Replay, Synthetic) sind Seed-basiert und
bit-identisch reproduzierbar.

**Trennung Paper ⇄ Live (v1.20.0):** Broker-Adapter bedienen Paper über eine
eigene `PaperExecutionEngine` (`ExecutionPort`), die strikt vom echten
Broker-Executor getrennt ist. Paper-Orders/-Positionen sind rein lokal
(0 Private-Calls) und werden im Live-Pfad **nie** als Live-Daten zurückgegeben.
Details: [BROKER_ARCHITECTURE.md](BROKER_ARCHITECTURE.md) §2.1.

---

## 1. Market-Data-Layer (Übersicht)

```
┌──────────────────────────────  MARKET DATA LAYER  ──────────────────────────────┐
│                                                                                  │
│   Broker-Feed          unabhängiger Feed          (Modus A/Fallback)              │
│   (BrokerAdapter →      BinanceFeed / YahooFeed    SyntheticFeed (seeded)         │
│    Venue-Marktdaten)                              ReplayFeed (Historical Store)  │
│          │                      │                                                 │
│          └──────────┬───────────┘                                                 │
│                     ▼                                                            │
│            ┌─────────────────────────────┐                                       │
│            │  Normalisierung            │  NaN/≤0, Sprung > Schwellwert,          │
│            │  → MarketSnapshot          │  stale Timestamp → verwerfen + loggen   │
│            └────────────┬────────────────┘  (nie gehandelt)                       │
│                         │                                                        │
│                    Snapshot + Historical Store (append-only OHLCV, Provenienz)   │
│                         │                                                        │
│              ┌──────────┴──────────┐                                              │
│              │  Screener / Agents  │                                              │
│              └──────────┬──────────┘                                              │
│                         ▼                                                        │
│            ┌─────────────────────────────┐                                       │
│            │  Paper Broker              │  deterministischer Fill-Simulator        │
│            │  → simulated fill          │  (Gebühren, Spread, Slippage, Latenz,    │
│            └─────────────────────────────┘   Partial Fills)                       │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Die Bausteine leben in `src/lib/marketdata/`:

| Baustein | Datei | Verantwortung |
| --- | --- | --- |
| Typen/Contracts | `types.ts` | `MarketFeed`, `MarketSnapshot`, Fehlerklassen |
| HTTP-Zugang | `http.ts` | Timeout, Retry/Backoff, **SSRF-Allowlist**, read-only |
| Konfiguration | `config.ts` | `paperMode`, Simulator-Parameter, Env-Knobs |
| Normalisierung | `normalization.ts` | Anomalie-Erkennung → `MarketSnapshot` |
| Historical Store | `historicalStore.ts` | append-only OHLCV-NDJSON mit Provenienz |
| Failover | `failover.ts` | Kette + Audit (`FEED_FAILOVER`/`ANOMALOUS_SNAPSHOT`) |
| Manager | `manager.ts` | Auflösung, Kette, Cache, Status |
| Feeds | `feeds/` | `BinanceFeed`, `YahooFeed`, `BrokerFeed`, `SyntheticFeed`, `ReplayFeed` |
| Simulator | `simulator.ts` | deterministischer Fill-Simulator |
| Produktion | `production.ts` | Verdrahtung (Factory ↔ Manager ↔ Ledger) |
| API | `src/app/api/marketdata/` | `GET snapshot`, `GET status` (read-only) |

---

## 2. Die drei Paper-Modi

Konfigurierbar über `PAPER_MODE` (Default **`broker-market-data`**).

| | **A — Synthetic** | **B — Broker-Market-Data** (Default) | **C — Broker Paper API** |
| --- | --- | --- | --- |
| **Kursquelle** | `SyntheticFeed` (seeded, deterministisch) | echte Venue-Marktdaten (Broker-Feed → Binance/Yahoo) | Venue-eigene Paper-/Testnet-Marktdaten |
| **Orderausführung** | lokal simuliert (deterministischer Simulator) | lokal simuliert (Simulator) gegen echten Kurs | **Broker-eigene Paper-/Testnet-API** |
| **Einsatzbereich** | Unit-Tests, Replay, Offline-Demo, deterministische Wiederholbarkeit | **Standard-Betrieb** der Firma (Realtime-Paper) | nur, wenn der Broker eine Paper-/Testnet-API anbietet |
| **Verfügbarkeit** | immer | immer | **nur** mit Venue-Capability + `PAPER_MODE_C_ENABLED=true` |

> **Modus C** ist heute **nicht** wählbar: Kein Adapter deklariert eine
> `testnet`-Capability und kein externes Venue eine Broker-Paper-API
> (alle Stubs `false`). Die Wahl ohne Capability/Flag endet in einem klaren
> `PaperConfigError` — nie in einem stillen Fallback.

**Validierung (falsche Kombinationen → klarer Fehler):**

- `PAPER_MODE=broker-paper-api` ohne `PAPER_MODE_C_ENABLED=true` → Fehler.
- `PAPER_MODE=broker-paper-api` ohne `PAPER_BROKER_API_VENUE` → Fehler.
- `PAPER_MODE=broker-paper-api` mit Venue ohne Paper-/Testnet-Capability → Fehler.
- `PAPER_MODE=synthetic` ist der explizite Modus A; als *Fallback* in Modus B
  nur mit `PAPER_ALLOW_SYNTHETIC_FALLBACK=true` — sonst wird die Kette **nicht**
  auf Synthetic umgeschaltet (kein stiller Wechsel).

---

## 3. Fill-Simulator — Parameter

Der Simulator (`src/lib/marketdata/simulator.ts`) modelliert Gebühren, Spread,
Slippage, Latenz und Partial Fills **lokal und deterministisch** (Seed).
Gebühren kommen aus den **Registry-Feldern** `makerFee`/`takerFee` (vgl.
Task 01); ein Market-Fill nutzt die **Taker-Gebühr**.

| Parameter | Env | Default | Effekt |
| --- | --- | --- | --- |
| Maker-Gebühr-Fallback | `PAPER_SIM_MAKER_FEE` | `0.0004` (4 bp) | Fallback, falls Registry-Feld fehlt |
| Taker-Gebühr-Fallback | `PAPER_SIM_TAKER_FEE` | `0.001` (10 bp) | Fallback für Market-Fills |
| Latenz | `PAPER_SIM_LATENCY_MS` | `25` ms | sim. Ausführungslatenz im Fill |
| Basis-Slippage | `PAPER_SIM_SLIPPAGE_BPS_BASE` | `1` bp | Slippage bei Ordergröße → 0 |
| Slippage/Teilnahme | `PAPER_SIM_SLIPPAGE_PER_PARTICIPATION` | `30` bp | **zusätzliche** Slippage je 100 % Teilnahme am 24h-Volumen |
| Slippage-Streuung | `PAPER_SIM_SLIPPAGE_JITTER_BPS` | `0` bp | deterministische Streuung (Seed); `0` = rein deterministisch |
| Partial Fills | `PAPER_SIM_PARTIAL_FILL` | `false` | Partial-Fill-Modell ein/aus |
| Max. Fill-Anteil | `PAPER_SIM_PARTIAL_MAX_FRACTION` | `1` (100 %) | Obergrenze der gefüllten Menge |
| Seed | `PAPER_SIM_SEED` | `0` | deterministischer Zufall (Streuung/Liquidität) |
| 24h-Volumen-Fallback | `PAPER_SIM_VOLUME_FALLBACK` | `10_000_000` | falls Registry-`volume24h` fehlt |

**Slippage-Modell** (linear wachsend mit Ordergröße relativ zum 24h-Volumen):

```
participation = (qty · last) / max(volume24h, 1e-9)
slippage_bps  = slippageBpsBase + participation · slippageBpsPerParticipation
Fill LONG  @ ask · (1 + slippage)
Fill SHORT @ bid · (1 − slippage)
Gebühren    = fillPrice · filledQty · takerFee
```

**Determinismus:** Gleiche `(Seed, Order, Snapshot, Instrument)` → identisches
Ergebnis. Der Test `marketdata.simulator.test.ts` belegt 100 identische Fills
bei gleicher Seed.

---

## 4. Failover-Kette (kein stiller Kursquellwechsel)

Reihenfolge (konfigurierbar, dokumentiert):

```
Broker-Feed → unabhängiger Feed (Binance/Yahoo) → Synthetic (NUR wenn erlaubt)
```

- **Broker-Feed** = Marktdaten über die Venue, über die auch die Orders laufen
  (`BrokerFeed` → `BrokerAdapter`). Primäre Quelle in Modus B.
- **Unabhängiger Feed** = eigene Binance-/Yahoo-Beschaffung.
- **Synthetic** = nur bei `PAPER_ALLOW_SYNTHETIC_FALLBACK=true`.

Jeder Feed-Wechsel UND jede verworfene Kurs-Anomalie erzeugt einen
**Audit-Eintrag** (`FEED_FAILOVER` bzw. `ANOMALOUS_SNAPSHOT` in `audit_log`,
zusätzlich In-Memory-Ring für Tests). Ein Failover ist **immer laut**, nie still.

**Anomalie-Erkennung** (in `normalization.ts`): Kurse mit NaN/≤0, Sprung über
`PAPER_ANOMALY_MAX_JUMP_PCT` (Default 50 %), staler Timestamp (älter als
`PAPER_STALE_AFTER_MS`, Default 30 s) oder kaputtem Spread werden **verworfen
und geloggt** — sie werden nie gehandelt und lösen ggf. einen Failover aus.

---

## 5. Historical Store & Replay / Backtest-Determinismus

- **Historical Store** (`historicalStore.ts`): append-only **NDJSON**
  (`data/history/candles.ndjson`), eine Kerze pro Zeile, mit eindeutiger
  Provenienz `(venue, feed, ts, fetchedAt)`.
- **Replay-Feed** (`feeds/replay.ts`): spielt den Store in stabiler
  `ts`-Reihenfolge ab (last = close). Backtest speist Kurse **ausschließlich**
  aus dem Store — kein Live-Kurs.
- **Determinismus:** Gleicher Seed + gleicher Store-Stand → **identische Fills
  und byte-identische Ergebnisdateien**. Belegt durch den Golden-Test in
  `marketdata.replay.test.ts` (Backtest zweimal → identische Ausgabe).

**Synthetic** ist ebenfalls Seed-deterministisch: gleiche Seed + gleiche
Aufruffolge → identische Kursfolge.

---

## 6. Konfiguration (Env)

| Env | Default | Bedeutung |
| --- | --- | --- |
| `PAPER_MODE` | `broker-market-data` | `synthetic` \| `broker-market-data` \| `broker-paper-api` |
| `PAPER_STATIC_FALLBACK` | `false` | statisches Preisbuch nur als expliziter Offline-Fallback (Code deprecated) |
| `PAPER_ALLOW_SYNTHETIC_FALLBACK` | `false` | Synthetic als Fallback in Modus B erlauben |
| `PAPER_MODE_C_ENABLED` | `false` | Modus C freischalten (erfordert zusätzlich Capability) |
| `PAPER_BROKER_API_VENUE` | – | Venue für Modus C (z. B. `ALPACA`) |
| `PAPER_ANOMALY_MAX_JUMP_PCT` | `50` | max. Kurssprung zwischen Kursen in % |
| `PAPER_STALE_AFTER_MS` | `30000` | max. Kursalter |
| `PAPER_FEED_TIMEOUT_MS` | `8000` | Feed-Timeout |
| `PAPER_FEED_RETRY_MAX` | `2` | Feed-Retry-Maximum (inkl. Erstversuch, mit Backoff) |
| `PAPER_FEED_ALLOWED_HOSTS` | – | zusätzliche erlaubte Feed-Hosts (SSRF) |
| `PAPER_HISTORY_DIR` | `data/history` | Verzeichnis des Historical Store |
| `PAPER_SIM_*` | siehe §3 | Simulator-Parameter |

---

## 7. API (read-only)

| Methode | Pfad | Zweck |
| --- | --- | --- |
| `GET` | `/api/marketdata/snapshot?instrument=…` | normalisierter Markt-Snapshot (Bid/Ask/Last + Provenienz) |
| `GET` | `/api/marketdata/status` | aktive Quelle, Cache-TTL, letzter Failover, paperMode |

Beispiel:

```bash
curl 'http://localhost:3369/api/marketdata/snapshot?instrument=PAPER:BTC'
# → { "ok": true, "snapshot": { "instrumentId":"PAPER:BTC", ..., "source":"binance", ... } }
curl 'http://localhost:3369/api/marketdata/status'
# → { "ok": true, "status": { "paperMode":"broker-market-data", "activeSource":"...", ... } }
```

---

## 8. Integration in die Trading-Pipeline

- `MarketDataManager` (Prozess-Singleton, `production.ts`) baut die Feeds und
  die Failover-Kette.
- Der `PaperBroker`-Ledger erhält einen **Ausführungs-Adapter**
  (`PaperExecutionAdapter`), der echte Kurse aus dem Manager durch den
  deterministischen Simulator schickt (Gebühren/Spread/Slippage/Latenz/
  Partial Fills) und das Ergebnis ins Paperbuch schreibt.
- Die Engine (`engine.ts`) wärmt den Snapshot-Cache vor jedem Submit (Modus B)
  und injiziert den Ausführungs-Adapter einmalig beim `getBroker()`.
- Fehlt ein Kurs (Offline, keine Feed liefert, Statik-Fallback aus) → die
  Order wird mit `NO_QUOTE` abgelehnt — es wird **nie geraten**.
- **Kein Breaking Change:** bestehende Paper-Order-Pfade funktionieren weiter;
  der Live-Pfad bleibt hart gesperrt (`LiveTradingGateError`).
