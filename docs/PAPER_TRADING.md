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

Der Simulator (`src/lib/marketdata/simulator.ts`) modelliert Gebühren

> **H1 Fix (v1.36.2, CRITICAL):** `Order.riskNotional` wird **nicht** vertraut. Die Ausführungsschleuse
> (`src/lib/broker.ts`, `src/brokers/*/paper.ts`, `src/brokers/*/execution.ts`) berechnet
> `estimatedNotional = qty * Preis` server-seitig und prüft Guardrails + Cash (`requiredCash =
> Notional + Slippage + Gebühren`) dagegen. Exakter Check `cost = filledQty*fillPrice+fees`
> nach Simulation blockt Orders, deren tatsächliche Kosten (Slippage `price*1.001` / Simulator-Fees)
> das verfügbare Cash übersteigen — selbst wenn `riskNotional` klein gewählt wurde. Beispiel:
> `riskNotional=2500`, Fill +0.1% + Gebühren → real >2500 → `INSUFFICIENT_CASH`. Der Simulator selbst
> ist unverändert; nur die Schleuse davor/ danach nutzt die server-seitige Größe.

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
| Synthetischer Spread | `PAPER_SIM_SYNTHETIC_SPREAD_BPS` | `2` bp | Bid/Ask-Spread für ticker-basierte Snapshots (nur Last-Preis, z. B. Bitunix Modus B) |

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

### 3.1 Gebühren, Slippage & Kalibrierung (GAP-02, v1.42.0)

Die vier Kernparameter der Ausführungs-Simulation sind über Env-Flags
kalibrierbar (`calibrateSimulatorConfig` in `src/lib/marketdata/config.ts`,
verdrahtet in `createPaperExecution`). Sie wirken als **Overlay** über die
Basis-Konfiguration (`PAPER_SIM_*` bzw. deren Defaults = die bisher
hartcodierten Werte): Ist ein Flag nicht gesetzt, bleibt die Basis unverändert
— **kein Verhaltensbruch**. Ist es gesetzt, überschreibt es das entsprechende
Feld; Werte außerhalb der Bounds werden **geklemmt und per Log-Warnung
angemekert** (fail-laut, nie still — ein falsch kalibriertes Paper-PnL wäre
schlimmer als eine abgewiesene Konfiguration).

| Parameter | Env | Default (= Basis) | Bounds | Effekt |
| --- | --- | --- | --- | --- |
| Maker-Gebühr | `PAPER_MAKER_FEE_PCT` | `0.04` (= 4 bp) | [0, 10] % | Maker-Fallback, falls Registry-Feld fehlt |
| Taker-Gebühr | `PAPER_TAKER_FEE_PCT` | `0.1` (= 10 bp) | [0, 10] % | Taker-Gebühr für Market-Fills (overrides `PAPER_SIM_TAKER_FEE`) |
| Basis-Slippage | `PAPER_SLIPPAGE_BPS` | `1` bp | [0, 10000] bp | Slippage bei Ordergröße → 0 (overrides `PAPER_SIM_SLIPPAGE_BPS_BASE`) |
| Spread-Fallback | `PAPER_SPREAD_FALLBACK_BPS` | `2` bp | [0, 10000] bp | synthetischer Bid/Ask-Spread für ticker-basierte Snapshots (overrides `PAPER_SIM_SYNTHETIC_SPREAD_BPS`). **v0.3.0**: Wenn nicht gesetzt, nutzt die Backtest-Engine einen timeframe-abhängigen Fallback (1m 15 bp, 5m 10, 15m 8, 30m 6, 1h 4, 4h 3, 1d 2) — feiner Takt = höhere Kosten. |


Einheiten: `_PCT`-Flags sind **Prozent** (`0.04` = 0,04 % ⇒ 0.0004 als
Dezimalanteil), `_BPS`-Flags sind Basispunkte. Beispiel:
`PAPER_TAKER_FEE_PCT=0.05` ⇒ jede Market-Order zahlt 5 bp Taker-Gebühr.

### 3.1a Timeframe-abhängiges Kostenmodell (v0.3.0)

Feine Takte haben pro Bar eine kleinere Edge, aber dieselben absoluten Kosten
(Gebühren + Spread + Slippage). Das Modell skaliert deshalb den Fallback:

- **Spread-Fallback**: 1m 15 bp, 5m 10 bp, 15m 8 bp, 30m 6 bp, 1h 4 bp, 4h 3 bp, 1d 2 bp
- **Slippage-Basis**: 1m 3 bp, 5m 2 bp, 15m 1,5 bp, 30m 1 bp, 1h 1 bp, 4h 0,5 bp, 1d 0,5 bp

Implementierung: `timeframeToSpreadFallbackBps()` / `timeframeToSlippageBaseBps()`
in `src/backtest/paperExecution.ts`, verdrahtet in `createPaperExecutionRuntime`
und `runMultiAssetBacktest` (Paper-Option `timeframe`). Wenn ein expliziter
Simulator übergeben wurde (`paper.simulator`), bleibt er unverändert — kein
Verhaltensbruch für kalibrierte Läufe. Für Live-Paper (Broker) gilt derselbe
`FillSimulator` — die Skalierung ist damit konsistent über Backtest und Paper.

Für Daytrading sind zusätzlich `spreadPct` (relativer Orderbuch-Spread) und
`bookDepthUsd` (Orderbuch-Tiefe der schwächeren Seite, v0.4.0) als Regelfeld
verfügbar — beide `null` ohne belastbares Buch, mit Qualitätsgrenze je Venue
(`src/lib/bookDepthProvenance.ts`). Siehe `src/lib/ruleFieldCatalog.ts`
und `docs/ARCHITECTURE.md`.


### 3.2 Funding-Accrual für Perpetuals (GAP-02, v1.42.0)

Vor v1.42.0 existierte Funding nur als Scanner-Ranking-Faktor — die
Haltekosten offener Perpetual-Positionen flossen **nicht** ins Paper-PnL.
Jetzt führt der PaperBroker je offener Perpetual-Position kumuliertes Funding
(`src/lib/funding.ts`, gebucht im Monitor-Tick bei Periodenwechsel).

**Formel und Vorzeichenkonvention (verbindlich):**

```
funding_zahlung = fundingRate · |notional| · direction        (LONG = +1, SHORT = −1)
                 → funding_zahlung > 0: die Position ZAHLT (LONG bei positiver Rate)
funding (Kontosicht) = −funding_zahlung
                 → funding < 0: gezahlt (Cash-Abfluss, Equity sinkt)
                   funding > 0: erhalten (Cash-Zufluss, Equity steigt)
```

Alle Felder und Events verwenden die **Kontosicht**: `positions.funding_paid`
(DB-Spalte, kumuliert je Position, bleibt nach Schließen stehen),
`PaperBroker.listPositions().fundingPaid`, `broker.totalFundingPaid` sowie der
Audit-Eintrag (`funding:SYMBOL:-1.0000` = gezahlt). Damit gilt exakt:
**equity nach Accrual = equity vorher + fundingPaid-Summe.**

**Ablauf (Monitor-Tick, alle 60 s):**

1. Periodenwechsel-Prüfung (Default: 8h-Marken 00/08/16 UTC; ohne Wechsel ⇒
   nichts zu tun). Erste Sichtung nach Prozessstart bucht nichts nach
   (kein doppeltes Accrual nach Neustart); Standby über mehrere Marken bucht
   `periods`-fach (aktuelle Rate, dokumentierte Näherung).
2. Nur als Perpetual erkannte Instrumente (Registry-Lookup über den
   Marktdaten-Manager; Spot/Aktien/unbekannt ⇒ kein Funding — fail-safe
   gegen erfundene Lasten).
3. Buchung: Ledger (`broker.accrueFunding` — Cash und Kumulativwert) →
   DB (`positions.funding_paid`) → `audit_log` (`FUNDING_ACCRUAL`, Muster
   `funding:SYMBOL:+0.42`, revisionssicher über die Audit-Senke mit Retry +
   Spool). Schlägt die Persistenz fehl, wird die Ledger-Buchung
   zurückgerollt (fail-closed).
4. Rate 0 (Default) ⇒ kein Event, keine Buchung, kein Audit — bestehende
   Installationen verhalten sich unverändert.

**Rate-Quelle (gestuft):**

- **(a) Statisch (Default):** `PAPER_FUNDING_RATE_PCT_PER_8H` (Default `0` =
  neutral). Die Prozentangabe bezieht sich auf 8h und wird auf das
  konfigurierte Intervall skaliert (4h-Takt ⇒ halbe Rate je Accrual, gleiche
  annualisierte Last).
- **(b) Provider (Erweiterungspunkt):** Interface `FundingRateProvider`
  (`getFundingRate(symbol)` → signierte Rate je 8h als Dezimalanteil, `null` =
  unbekannt ⇒ statischer Default). Keine Netzwerk-Anbindung in diesem
  Release — echte Raten (z. B. Bitunix) können später hier eingehängt werden.

**Ausweis:** Equity enthält Funding über den Cash-Bestand (wie Gebühren beim
Fill — keine Doppelzählung). `GET /api/firm` zeigt je Position `fundingPaid`
(aktiv + historisch) und im Account-Snapshot `fundingPaid` (SUMME über alle
Positionen, Lifetime) sowie `fundingPaidOpen` (aktuell offen).

| Parameter | Env | Default | Bounds | Effekt |
| --- | --- | --- | --- | --- |
| Funding-Intervall | `PAPER_FUNDING_INTERVAL_HOURS` | `8` | [1, 24] | Accrual-Takt in Stunden (8 = Marken 00/08/16 UTC) |
| Funding-Rate | `PAPER_FUNDING_RATE_PCT_PER_8H` | `0` | [−1, 1] % | statische Rate je 8h in Prozent (0.01 = 0,01 %/8h); 0 = aus |

Migration: `drizzle/2026-09-18_positions_funding.sql` (append-only,
`ALTER TABLE positions ADD COLUMN funding_paid numeric NOT NULL DEFAULT 0`)
oder `npx drizzle-kit push`. Tests: `tests/paper.funding.test.ts`
(Vorzeichen, Periodenwechsel, Equity-Abgleich, Bounds, Neutralität,
Determinismus).

### 3.3 Server-seitiges Exit-Management: Trailing, Time-Stop, OCO (GAP-05, v1.44.0)

Exits dürfen nie von LLM-Latenz oder Provider-Ausfall abhängen. Der
Monitor-Tick (`src/lib/monitor.ts`, alle 60 s oder manuell via
`POST /api/firm/tick`) prüft je offener Position **fünf komplementäre
Exit-Bedingungen** und schließt genau einmal. Safety zuerst:

| Bedingung | Auslösung | `exitReason` | Konfiguration |
| --- | --- | --- | --- |
| Stop-Loss | Kurs ≤ SL (LONG) bzw. ≥ SL (SHORT) | `STOP_LOSS` | wie bisher je Order |
| Take-Profit | Kurs ≥ TP (LONG) bzw. ≤ TP (SHORT) | `TAKE_PROFIT` | wie bisher je Order |
| **Trailing-Stop** | bewaffneter Ratchet-Stop berührt | `TRAILING_STOP` | `RISK_TRAILING_*` (Default aus) |
| **Time-Stop** | Haltedauer ≥ Limit | `TIME_STOP` | `RISK_TIME_STOP_HOURS` (Default 0 = aus) |
| **Signal-Decay** | bestätigter, versionierter Signalverfall | `SIGNAL_DECAY` | `SIGNAL_DECAY_MODE` + Klasse (Default aus) |

**Trailing-Stop.** Ab `RISK_TRAILING_ACTIVATION_PCT` Prozent Gewinn (vom
Einstieg, seitenrichtig für LONG/SHORT) wird die Position *bewaffnet*; der
Stop liegt `RISK_TRAILING_RETURN_PCT` Prozent hinter dem Kurs (LONG darunter,
SHORT darüber). Mit jedem besseren Stand **ratchtet** der Stop nach —
ausschließlich in Schutzrichtung: LONG steigt er nur, SHORT fällt er nur.
Ein Rücksetzer über dem Stop schließt nicht, ein Berühren des Stops schließt
mit `exitReason = TRAILING_STOP`. Der Zustand (bewaffnet? Stop-Level?) liegt
in `positions.trailing_armed`/`positions.trailing_stop` — crash-safe: Nach
einem Prozess-Neustart liest der Monitor den erreichten Stand aus der DB,
kein Stop geht verloren, keiner wird aus dem Prozessgedächtnis erfunden.
Stops werden **nie automatisch verengt**; jede Bewegung ist im Audit
nachvollziehbar.

**Time-Stop.** `RISK_TIME_STOP_HOURS > 0` begrenzt die Haltedauer unabhängig
vom Kurs (Kapitalbindung, Haltekosten, Signalentropie). Ablauf → Close mit
`exitReason = TIME_STOP` + Audit. Default `0` = komplett inaktiv.

**Signal-Decay (RMA-P5-05, v1.69.0).** Nur wenn `SIGNAL_DECAY_MODE=active` und
die Strategieklasse explizit an ist. Der Monitor vergleicht den unveränderlichen
Entry-Snapshot mit einem Signal aus geschlossenen 15m-Kerzen. Fehlende, stale
oder fremde Versionen schließen nicht. `monitor` schreibt nur den
Counterfactual. Details: [`SIGNAL_DECAY.md`](SIGNAL_DECAY.md).

**OCO-Exklusivität (genau ein Exit).** Kritischer Fall: zwei parallele Ticks
— oder sogar zwei Prozessinstanzen — entscheiden dieselbe Position
gleichzeitig zu schließen (etwa der eine auf SL, der andere auf TP). Der Exit
ist deshalb kein Check-then-Act im Speicher, sondern ein **atomarer
DB-Claim**: `UPDATE positions SET status = 'CLOSED', exit_reason = … WHERE
id = … AND status = 'OPEN'` — genau eine Transaktion bekommt die Zeile
(`RETURNING` liefert sie), jede weitere sieht die Position als bereits
geschlossen und macht einen sauberen **no-op** (kein Doppel-Fill, kein
Doppel-P&L, kein Fehler). Der Gewinner glattstellt danach den Ledger
(`broker.close`, der bei fehlender Position `null` liefert und dann ignoriert
wird), schreibt den Exit-Preis/PnL nach und protokolliert **genau ein**
`audit_log`-Ereignis (`STOP_LOSS_HIT`/`TAKE_PROFIT_HIT`/
`TRAILING_STOP_HIT`/`TIME_STOP_HIT`, Detail-Code `exit:SYMBOL:grund`).

Bei gleichzeitiger SL- und TP-Berührung im selben Intervall gilt wie bisher
konservativ **der Stop zuerst**; die Priorität der vier Bedingungen ist
SL → TP → Trailing → Time-Stop (preisbasiert vor Zeit). Die Bewaffnung des
Trailing-Stops wird genau einmal je Position auditiert
(`TRAILING_STOP_ARMED`, Detail-Code `trailing-arm:SYMBOL`); reine
Ratchet-Anhebungen sind Zustandspflege in `positions.trailing_stop` und
schreiben kein Audit (kein Log-Flood pro Tick). Die Logik selbst ist
als reine, clock-unabhängige Funktion in `src/lib/exits.ts` gekapselt
(`decideExit`, `loadExitConfig`) und wird über `tick()`-Optionen
(Fake-Clock, injizierte Kurse) deterministisch getestet —
`tests/monitor.exits.test.ts`.

| Flag | Default | Bounds | Bedeutung |
| --- | --- | --- | --- |
| `RISK_TRAILING_ENABLED` | `false` | — | Trailing-Stop an/aus (aus = heutiges Verhalten) |
| `RISK_TRAILING_ACTIVATION_PCT` | `1.0` | [0.1, 20] | Bewaffnungsschwelle in % Gewinn |
| `RISK_TRAILING_RETURN_PCT` | `0.5` | [0.1, 10] | Rückgabeweg in % (Stop-Abstand zum Kurs) |
| `RISK_TIME_STOP_HOURS` | `0` | [0, 720] | max. Haltedauer in h; 0 = aus |

Migration: `drizzle/2026-09-18_exit_management.sql` (append-only, zwei neue
Spalten auf `positions`) oder `npx drizzle-kit push`. Bewusst **Paper-only**:
Die Auslösung ist Ledger-/DB-Logik; ein Order-Mapping (Conditional/Reduce-Only)
an echte Venues ist nicht Teil dieses Deltas und bleibt durch die Live-Gate
(`src/live-gate/**`, unangetastet) ohnehin gesperrt.

---

### 3.4 Derivat-Kontext aus der Perp-Ablage (RMA-P2-02, v1.54.0)

Scanner-Signale und der Derivat-Kontext des Paper-Pfads können Funding-Rate,
Intervall, Open Interest (Quote) und Δ24 h aus der kanonischen Ablage lesen
(`perpDerivativeProvider`). Der statische Fallback aus §3.2
(`PAPER_FUNDING_RATE_PCT_PER_8H`) bleibt unverändert die Quelle der
Paper-Accruals, solange `PERP_DATA_ENABLED=false` (Default) — mit Freigabe
ersetzt der as-of-gelesene Wert den gerateten, und **nur** belegbare Sätze
werden benutzt. Alles, was die Ablage nicht belegen kann, bleibt `null` mit
Grund (`MISSING`, `STALE`, `UNSUPPORTED`, `UNAVAILABLE`,
`ALL_ROWS_UNATTESTABLE`); das Artefakt `data/perpdata/derivatives.json` wird bei
zu alter Datei verworfen (`FILE_STALE`) statt mit Alt-Werten zu handeln.
Kein Orderrouting, keine Risiko- oder Gate-Änderung. Details:
[PERPETUAL_DATA.md](PERPETUAL_DATA.md) §6.

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
| `PAPER_MAKER_FEE_PCT` / `PAPER_TAKER_FEE_PCT` | `0.04` / `0.1` (%) | Kalibrierung: Gebühren-Overlay (GAP-02, siehe §3.1) |
| `PAPER_SLIPPAGE_BPS` / `PAPER_SPREAD_FALLBACK_BPS` | `1` / `2` (bp) | Kalibrierung: Slippage/Spread-Overlay (GAP-02, siehe §3.1) |
| `PAPER_FUNDING_INTERVAL_HOURS` | `8` | Funding-Accrual-Takt (GAP-02, siehe §3.2) |
| `PAPER_FUNDING_RATE_PCT_PER_8H` | `0` | statische Funding-Rate je 8h in % (0 = aus) |

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

### 8.1 Eine Fill-Engine für alle Paper-Pfade (v1.21.0)

Es gibt **genau einen** Fill-Simulator. Adapter, die nur einen Last-Preis
liefern (z. B. der Bitunix-Ticker in Modus B), wandeln diesen über
`snapshotFromLastPrice` (`src/lib/marketdata/snapshot.ts`) in einen
normalisierten `MarketSnapshot` (Bid/Ask symmetrisch aus dem synthetischen
Spread) und schicken ihn durch **denselben** `FillSimulator`:

```
echte Broker-/Marktdaten
        ↓  (normalisierter Ticker/Snapshot)
normalisierte Marktdaten
        ↓  (FillSimulator: Spread · Slippage · Gebühren · Latenz · Partial Fills)
lokale Simulation
```

Damit ist der frühere Sonderfall beseitigt, bei dem der Bitunix-Paper-Ledger
eine **separate**, vereinfachte Simulation mit festen Faktoren
(LONG → `price·1.0001`, SHORT → `price·0.9999`) verwendete. Heute gilt:
`Generic Paper === Bitunix Paper`. Belege: `tests/bitunix.paper.unified.test.ts`
und `tests/marketdata.snapshot.test.ts`.

## Kanonisches Execution-Benchmarking

Optionales `EXECUTION_QUALITY_ENABLED=true` erfasst normale Order-Submissions in
PAPER/ALPACA/BITUNIX und den atomaren Engine-/MicroExecutor-Pfad. Paper-Fills sind
modeled, echte Venue-Ausführungen observed. Der Paper-Transaktionspfad schreibt
Quality-Evidenz zusammen mit Order/Position und rollt eine neue In-Memory-Füllung
bei Persistenzfehler zurück. Bekannte Decision-IDs werden ohne erneuten Fill
wiedergegeben; Scope und stabile Adapter-IDs sind für Restart-Sicherheit Pflicht.
Kein Benchmark verändert Sizing, Preisentscheidung oder Risk-/Live-Gates.

[Migration, Operations-Worker und Read-API](../src/executionQuality/README.md).
