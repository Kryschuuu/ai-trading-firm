# Tracking — Adapter, Parallelität, Daytrading (2026-09-24)

SSoT des Umsetzungsstatus dieses Zyklus. `GEBAUT` ist in diesem Zweig
implementiert und getestet. `VERWORFEN` hat eine Begründung im
[Audit-README](../README.md) und wird nicht doppelt gebaut. `OFFEN` ist
benannt, aber bewusst nicht in diesem Zyklus umgesetzt.

Befunde und Messungen: [`../README.md`](../README.md).

| ID | Vorschlag aus dem Auftrag | Status | Nachweis / Grund |
|----|---------------------------|--------|------------------|
| IAD-D-yahoo | Yahoo-History-Adapter neu bauen | VERWORFEN | produktiv vorhanden: `src/marketdata/adapters/yahoo.ts` (ALPACA/IBKR/PAPER), `tests/marketdata/adapters/yahoo.test.ts` |
| IAD-D-polygon | Polygon-REST + WebSocket + Corporate Actions | VERWORFEN | Credential-freier Sync-Zweig, kein Polygon-Universum, dritter Realtime-Feed; Begründung + Kipp-Bedingungen im README §2.2 |
| IAD-D-fred | FRED-Makro-Adapter, Output für `marketRegime.ts` | VERWORFEN | kein OHLCV, keine Point-in-Time-Semantik (Revisionen) ⇒ Look-ahead-Gefahr in der Regel-Engine; Regime hat bereits `macroCycle.ts` |
| IAD-D-registry | `MARKET_SYNC_*_ENABLED`-Flags, Capability-Check, SSRF-Allowlist | VERWORFEN | existiert bereits in `src/marketdata/registerAdapters.ts` (`MARKET_SYNC_VENUES`, `SYNC_VENUE_MARKET_DATA`, `SyncHttpClient`-Allowlist, Key-Handshake ausserhalb des Syncs) |
| IAD-O1 | `RULE_FIELDS` + `RuleSnapshot` um `adx14`/`bbwPct`/`macd*`, `macd()` in `indicators.ts` | VERWORFEN | seit v0.2.0 da (VBF-P2-02); Duplikat ohne Nutzen |
| IAD-O2 | Technical/Research: Indikatoren vor dem LLM rechnen | VERWORFEN | als strengere Variante da (VBF-P2-01): Code **überschreibt** Modellzahlen, Fallback erfindet kein `rsi: 50` |
| IAD-W2 | Binomialtest gegen 50 % im HitRatePanel | VERWORFEN | Wilson-Intervall deckelt dieselbe Unsicherheit (VBF-W2); Panel nutzt `src/lib/stats.ts` |
| IAD-P-01 | **Prompt-Budget + Batch-Aufteilung des Technical Steps** | GEBAUT | `src/cycle/promptBudget.ts`, `src/cycle/steps/technicalStep.ts`; Tests `tests/cycle.promptBudget.test.ts`, `tests/cycle.technicalBatching.test.ts` |
| IAD-P-02 | Redundanz im Prompt entfernen (Voll-Snapshots ≡ Zeilenform) | GEBAUT | je Batch entschieden, Artefakt bleibt vollständig; Messung 64 % der Prompt-Bytes |
| IAD-P-03 | Batches parallel statt sequenziell, wo es etwas bringt | GEBAUT | `mapBounded` + `CYCLE_ANALYST_CONCURRENCY`; Default providerabhängig (1 lokal, 2 remote) |
| IAD-P-04 | Fallback sichtbar machen statt als Analyse ausliefern | GEBAUT | `promptFit.failedBatches`/`fallbackInstruments`/`incomplete` im Step-Output und Tages-Artefakt |
| IAD-P-05 | `confluenceMeta`/`promptFit` überleben die Engine-Validierung | GEBAUT | `validateTechnicalOutput` (vorher Handoff-Verlust, sanktioniert im Test) |
| IAD-T-01 | **`vwapPct` als Regelfeld** (Tages-VWAP, Daytrading-Referenz) | GEBAUT | `sessionVwap`/`utcDayAnchorMs` in `src/lib/indicators.ts`, Katalog + Snapshot + `accessor`; Tests in `tests/indicators.test.ts`, `tests/ruleEngine.test.ts` |
| IAD-T-02 | **`1m` als Regel-Timeframe** (sonst stille 15m-Aggregation) | GEBAUT | `ALLOWED_TIMEFRAMES`, `RuleWindow`, JSON-Schema, `TIMEFRAME_MS["1m"]`, Workshop-Port |
| IAD-T-03 | VWAP als Messwert in den Trusted-Block | GEBAUT | `src/cycle/trustedIndicators.ts` (`vwapPct` im Reading) |
| IAD-T-04 | Shorts im Regelwerk freigeben | VERWORFEN | `RULE_ALLOWED_SIDE = "LONG"` ist eine Risikoentscheidung (unbegrenzter Verlust, Leihgebühr, Margin); braucht Sizing/Exits/Backtest/Kosten-Pfade zuerst |
| IAD-T-05 | `1m`-Backfill als Sync-Default | VERWORFEN | Request-Sturm gegen eine einzige Produktionsleserin (`1h`); explizit: `npm run market:sync -- --timeframes=1m,5m,15m,1h` |
| IAD-T-06 | `spreadPct`/`bookDepthUsd` als Regelfeld | OFFEN | höchster Daytrading-Nutzen unter den offenen Ideen, braucht Orderbuch-Qualitätsgrenze je Venue (README §7.3) |
| IAD-T-07 | Limit-/Stop-Markt/OCO am Broker | OFFEN | gehört in `src/execution` + Broker-Verträge, nicht in die Regel-DSL |
| IAD-T-08 | Session-VWAP mit börsenlokaler Tagesgrenze | OFFEN | UTC-Anker ist dokumentierte Konvention; Präzisierung braucht Exchange-Kalender im Store |
| IAD-E-01 | Engine-Default, `backtestRule`, Whitelist-Semantik | UNVERÄNDERT | Auftrag: „Bewusst nicht gebaut" — stimmt und bleibt so |
