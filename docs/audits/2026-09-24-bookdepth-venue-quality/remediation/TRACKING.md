# Tracking — bookDepthUsd + Venue-Qualitätsgrenze (2026-09-24)

SSoT des Umsetzungsstatus dieses Zyklus. `GEBAUT` ist in diesem Zweig
implementiert und getestet. `OFFEN` ist benannt, aber bewusst nicht in diesem
Zyklus umgesetzt.

Befunde und Messwerte: [`../README.md`](../README.md).

| ID | Forderung | Status | Nachweis |
|----|-----------|--------|----------|
| DEPTH-01 | `bookDepthUsd` als Regelfeld (Fortsetzung von `spreadPct`) | GEBAUT | `MarketInstrument.bookDepthUsd`, `RuleSnapshot`, `RULE_FIELDS`, `accessor`, `buildSnapshotFromCandles`/`snapshotFromCache`, `TrustedReading` |
| DEPTH-02 | Venue-Qualitätsgrenze je Venue | GEBAUT | `src/lib/bookDepthProvenance.ts` (depth/top/none, ≥ 3 Levels, ≤ 5 s) |
| DEPTH-03 | Deterministische Tiefenberechnung | GEBAUT | `src/lib/bookDepth.ts` (`computeBookDepth`, Sanitisierung + Kappung) |
| DEPTH-04 | Sync: Tiefe aus denselben Depth-Levels | GEBAUT | `enrichWithOrderBooks` → `bookDepthBySymbol` (kein Extra-Request) |
| DEPTH-05 | Registry + Spread-/Depth-Cache | GEBAUT | `MarketInstrument`-Upsert, `spreadCache.freshDepth/recordDepth`, Abwärtskompatibilität |
| DEPTH-06 | Live im Mikro-Executor | GEBAUT | `FeedTick` book-Kind, `MicroExecutor.updateBook`, Binance `@depth5` |
| DEPTH-07 | Backtest-Pfad | GEBAUT | `engine.ts` reicht `bookDepthUsd` durch (konstant je Instrument) |
| DEPTH-08 | Kosmetik: 6 `eslint-disable`, redundanter Seitenfilter | GEBAUT | `lint` 0 warnings; Tiefenberechnung ohne toten Code |
| DOC-01 | CHANGELOG, VERSION, README, docs/README, ARCHITECTURE, PAPER_TRADING | GEBAUT | Version 0.4.0 |
| DOC-02 | Audit-README + TRACKING | GEBAUT | Dieser Ordner |
| IAD-T-07 | Limit-/Stop-Markt/OCO am Broker | OFFEN | gehört in `src/execution` + Broker-Verträge |
| IAD-T-08 | Session-VWAP mit börsenlokaler Tagesgrenze | OFFEN | braucht Exchange-Kalender im Store |
| IAD-T-04 | Shorts freigeben | OFFEN | Risikoentscheidung (Sizing/Exits/Backtest zuerst) |
| IAD-T-05 | 1m-Backfill als Sync-Default | OFFEN | Request-Sturm gegen die `1h`-Produktionsleserin |
