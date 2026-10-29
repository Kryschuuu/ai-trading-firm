# Schema-Inventar (generiert)

<!-- GENERIERT — nicht editieren (`npm run docs:inventories`). -->

> **GENERIERT — nicht editieren** (`npm run docs:inventories`)
> — Quelle: [`src/db/schema.ts`](../../src/db/schema.ts) + [`drizzle/*.sql`](../../drizzle/)
> — Pflegehinweise: ändere TSDoc/Schema im Code und lasse das Skript neu laufen.

Insgesamt **67** `pgTable`-Definitionen. Tabellen, die keine Migrationsdatei nennen, wurden bereits im Initial-Setup ausgerollt ("`(initial)`").

| Tabelle | Quelle (schema.ts-Zeile) | Spalten | Migrationsdatei(en) | Zweck (TSDoc-Kurzform) |
| --- | --- | ---:| --- | --- |
| `risk_config` | [`schema.ts:42`](../../src/db/schema.ts) | 5 | *(initial)* | Risikoparameter zur Anzeige/Dokumentation. |
| `agents` | [`schema.ts:51`](../../src/db/schema.ts) | 9 | *(initial)* | — |
| `missions` | [`schema.ts:92`](../../src/db/schema.ts) | 12 | *(initial)* | Ein Handelsauftrag/Ziel für die Firma. |
| `trade_rules` | [`schema.ts:126`](../../src/db/schema.ts) | 22 | *(initial)* | Regelwerk des Makro-Zyklus (CEO/Research) — die einzige Brücke zur Ausführungsebene. Jede Zeile ist IMMUTABLE … |
| `rule_executions` | [`schema.ts:192`](../../src/db/schema.ts) | 14 | *(initial)* | Ausführungs-Feedback des Mikro-Zyklus: jede Trigger-Entscheidung, jeder Block und jeder Fehler — die … |
| `backtest_runs` | [`schema.ts:231`](../../src/db/schema.ts) | 14 | [`2026-09-19_backtest_runs.sql`](../../drizzle/2026-09-19_backtest_runs.sql) | Vergleichbar persistierte Walk-Forward-Runs (GAP-01, v1.51.0). |
| `backtest_trades` | [`schema.ts:301`](../../src/db/schema.ts) | 25 | [`2026-09-20_backtest_trades.sql`](../../drizzle/2026-09-20_backtest_trades.sql) | Trade-Level-Wahrheitsquelle eines Walk-Forward-Runs (RMA-P1-04, v1.52.0). |
| `backtest_monte_carlo_runs` | [`schema.ts:377`](../../src/db/schema.ts) | 16 | [`2026-09-23_monte_carlo.sql`](../../drizzle/2026-09-23_monte_carlo.sql) | Monte-Carlo-/Trade-Resampling-Analysen (RMA-P6-02, v1.72.0). |
| `rule_backtests` | [`schema.ts:423`](../../src/db/schema.ts) | 14 | *(initial)* | — |
| `positions` | [`schema.ts:442`](../../src/db/schema.ts) | 26 | *(initial)* | — |
| `agent_messages` | [`schema.ts:538`](../../src/db/schema.ts) | 7 | *(initial)* | — |
| `audit_log` | [`schema.ts:552`](../../src/db/schema.ts) | 7 | *(initial)* | — |
| `broker_credentials` | [`schema.ts:574`](../../src/db/schema.ts) | 4 | *(initial)* | Broker-Credentials der Control Plane (Task 08) — IMMER verschluesselt. |
| `venue_control_state` | [`schema.ts:600`](../../src/db/schema.ts) | 13 | [`2026-09-04_c4_venue_control_state.sql`](../../drizzle/2026-09-04_c4_venue_control_state.sql) | Persistierter Control-Plane-Zustand je Venue (C4, v1.36.16). |
| `proposals` | [`schema.ts:618`](../../src/db/schema.ts) | 10 | *(initial)* | — |
| `order_intents` | [`schema.ts:655`](../../src/db/schema.ts) | 8 | [`2026-09-04_h2_order_intents.sql`](../../drizzle/2026-09-04_h2_order_intents.sql) | Order-Intents (H2, v1.36.19) — der DB-seitige Reservierungsschritt, der die Broker-Ausführungsschleuse über … |
| `kill_switches` | [`schema.ts:675`](../../src/db/schema.ts) | 5 | *(initial)* | — |
| `equity_snapshots` | [`schema.ts:687`](../../src/db/schema.ts) | 7 | *(initial)* | Equity-Kurve: ein Snapshot pro Monitor-Tick und pro ausgeführtem Trade. |
| `trade_journal` | [`schema.ts:734`](../../src/db/schema.ts) | 17 | [`2026-09-18_trade_journal.sql`](../../drizzle/2026-09-18_trade_journal.sql) | Trade-Journal mit Agenten-Attribution (GAP-03, v1.43.0). |
| `journal_agent_weights` | [`schema.ts:792`](../../src/db/schema.ts) | 5 | [`2026-09-18_trade_journal.sql`](../../drizzle/2026-09-18_trade_journal.sql) | Journal-Feedback-Gewichte (GAP-03, v1.43.0) — begrenzte Rückführung. |
| `trade_attributions` | [`schema.ts:834`](../../src/db/schema.ts) | 25 | [`2026-09-21_trade_attribution.sql`](../../drizzle/2026-09-21_trade_attribution.sql) | — |
| `trade_attribution_entries` | [`schema.ts:918`](../../src/db/schema.ts) | 10 | [`2026-09-21_trade_attribution.sql`](../../drizzle/2026-09-21_trade_attribution.sql) | — |
| `feature_definitions` | [`schema.ts:984`](../../src/db/schema.ts) | 19 | [`2026-09-20_feature_store.sql`](../../drizzle/2026-09-20_feature_store.sql) | — |
| `feature_materialization_runs` | [`schema.ts:1047`](../../src/db/schema.ts) | 20 | [`2026-09-20_feature_store.sql`](../../drizzle/2026-09-20_feature_store.sql) | Materialisierungslauf (Backfill-Manifest, append-only). |
| `feature_values` | [`schema.ts:1105`](../../src/db/schema.ts) | 20 | [`2026-09-20_feature_store.sql`](../../drizzle/2026-09-20_feature_store.sql) | Featurewert (append-only Wahrheitsquelle). |
| `feature_materialization_cursors` | [`schema.ts:1189`](../../src/db/schema.ts) | 8 | [`2026-09-20_feature_store.sql`](../../drizzle/2026-09-20_feature_store.sql) | Materialisierungs-Cursor (Wasserstand je Featurereihe). |
| `feature_data_revisions` | [`schema.ts:1221`](../../src/db/schema.ts) | 11 | [`2026-09-20_feature_store.sql`](../../drizzle/2026-09-20_feature_store.sql) | Beobachtete Datenrevision (append-only Protokoll). |
| `perp_funding_rates` | [`schema.ts:1279`](../../src/db/schema.ts) | 19 | [`2026-09-20_perpetual_data.sql`](../../drizzle/2026-09-20_perpetual_data.sql) | — |
| `perp_open_interest` | [`schema.ts:1359`](../../src/db/schema.ts) | 23 | [`2026-09-20_perpetual_data.sql`](../../drizzle/2026-09-20_perpetual_data.sql) | Open Interest — `basis` sagt, welche Größe die Quelle **autoritativ** gemeldet hat; die übrigen sind nur mit … |
| `perp_liquidations` | [`schema.ts:1446`](../../src/db/schema.ts) | 22 | [`2026-09-20_perpetual_data.sql`](../../drizzle/2026-09-20_perpetual_data.sql) | — |
| `perp_sync_runs` | [`schema.ts:1533`](../../src/db/schema.ts) | 18 | [`2026-09-20_perpetual_data.sql`](../../drizzle/2026-09-20_perpetual_data.sql) | Sync-Manifest je Lauf. |
| `perp_sync_cursors` | [`schema.ts:1581`](../../src/db/schema.ts) | 10 | [`2026-09-20_perpetual_data.sql`](../../drizzle/2026-09-20_perpetual_data.sql) | — |
| `forecasts` | [`schema.ts:1648`](../../src/db/schema.ts) | 26 | [`2026-09-20_forecast_ledger.sql`](../../drizzle/2026-09-20_forecast_ledger.sql) | Unveränderlicher Forecast-Vertrag (append-only). |
| `forecast_resolutions` | [`schema.ts:1750`](../../src/db/schema.ts) | 16 | [`2026-09-20_forecast_ledger.sql`](../../drizzle/2026-09-20_forecast_ledger.sql) | Versionierte Auflösung eines Forecasts (append-only). |
| `forecast_resolution_runs` | [`schema.ts:1822`](../../src/db/schema.ts) | 12 | [`2026-09-20_forecast_ledger.sql`](../../drizzle/2026-09-20_forecast_ledger.sql) | Lauf-Manifest des Resolver-Jobs (append-only, Idempotenzschlüssel). |
| `forecast_resolver_cursors` | [`schema.ts:1865`](../../src/db/schema.ts) | 4 | [`2026-09-20_forecast_ledger.sql`](../../drizzle/2026-09-20_forecast_ledger.sql) | Wasserstand des Resolver-Jobs (Betriebsdiagnose, monotone Marke). |
| `execution_quality_intents` | [`schema.ts:1882`](../../src/db/schema.ts) | 8 | [`2026-09-20_execution_quality.sql`](../../drizzle/2026-09-20_execution_quality.sql) | — |
| `execution_quality_events` | [`schema.ts:1900`](../../src/db/schema.ts) | 6 | [`2026-09-20_execution_quality.sql`](../../drizzle/2026-09-20_execution_quality.sql) | — |
| `execution_quality_submissions` | [`schema.ts:1914`](../../src/db/schema.ts) | 3 | [`2026-09-21_execution_quality_capture.sql`](../../drizzle/2026-09-21_execution_quality_capture.sql) | — |
| `execution_quality_receipts` | [`schema.ts:1919`](../../src/db/schema.ts) | 5 | [`2026-09-21_execution_quality_capture.sql`](../../drizzle/2026-09-21_execution_quality_capture.sql) | — |
| `execution_quality_quotes` | [`schema.ts:1928`](../../src/db/schema.ts) | 3 | [`2026-09-21_execution_quality_quotes.sql`](../../drizzle/2026-09-21_execution_quality_quotes.sql) | — |
| `execution_quality_completed` | [`schema.ts:1939`](../../src/db/schema.ts) | 2 | [`2026-09-21_execution_quality_completion.sql`](../../drizzle/2026-09-21_execution_quality_completion.sql) | — |
| `copy_subscriptions` | [`schema.ts:1947`](../../src/db/schema.ts) | 15 | [`2026-10-03_copy_subscriptions.sql`](../../drizzle/2026-10-03_copy_subscriptions.sql) | — |
| `copy_order_links` | [`schema.ts:1978`](../../src/db/schema.ts) | 10 | [`2026-10-03_copy_subscriptions.sql`](../../drizzle/2026-10-03_copy_subscriptions.sql) | — |
| `regime_snapshots` | [`schema.ts:2011`](../../src/db/schema.ts) | 18 | [`2026-09-22_regime_snapshots.sql`](../../drizzle/2026-09-22_regime_snapshots.sql) | Persistente Regime-Snapshots (RMA-P2-01, v1.61.0) — append-only Historie der multidimensionalen … |
| `cross_sectional_snapshots` | [`schema.ts:2081`](../../src/db/schema.ts) | 21 | [`2026-09-22_cross_sectional_ranking.sql`](../../drizzle/2026-09-22_cross_sectional_ranking.sql) | Point-in-Time Cross-Sectional Momentum Ranking (RMA-P2-04, v1.63.0) — append-only Snapshots universumsweiter … |
| `cross_sectional_rankings` | [`schema.ts:2142`](../../src/db/schema.ts) | 17 | [`2026-09-22_cross_sectional_ranking.sql`](../../drizzle/2026-09-22_cross_sectional_ranking.sql) | — |
| `sentiment_forecasts` | [`schema.ts:2214`](../../src/db/schema.ts) | 32 | [`2026-09-22_structured_sentiment.sql`](../../drizzle/2026-09-22_structured_sentiment.sql) | Persistente Sentiment-Forecast-Historie (append-only). |
| `prompt_artifacts` | [`schema.ts:2339`](../../src/db/schema.ts) | 8 | [`2026-09-22_prompt_performance.sql`](../../drizzle/2026-09-22_prompt_performance.sql) | Immutable Prompt-Artefakt: eine Version eines Agenten-Prompts. |
| `agent_prompt_runs` | [`schema.ts:2377`](../../src/db/schema.ts) | 23 | [`2026-09-22_prompt_performance.sql`](../../drizzle/2026-09-22_prompt_performance.sql) | Provenanz eines einzelnen LLM-Aufrufs (append-only). |
| `volatility_targeting_snapshots` | [`schema.ts:2449`](../../src/db/schema.ts) | 26 | [`2026-09-22_volatility_targeting.sql`](../../drizzle/2026-09-22_volatility_targeting.sql) | — |
| `drawdown_scaling_snapshots` | [`schema.ts:2590`](../../src/db/schema.ts) | 37 | [`2026-09-22_drawdown_scaling.sql`](../../drizzle/2026-09-22_drawdown_scaling.sql) | — |
| `signal_decay_events` | [`schema.ts:2740`](../../src/db/schema.ts) | 30 | [`2026-09-22_signal_decay.sql`](../../drizzle/2026-09-22_signal_decay.sql) | Signal-Decay-Ereignisse (RMA-P5-05, v1.69.0). |
| `execution_workflows` | [`schema.ts:2843`](../../src/db/schema.ts) | 31 | [`2026-09-22_post_only_fallback.sql`](../../drizzle/2026-09-22_post_only_fallback.sql) | Ein Maker-Versuch des Execution-Policy-Controllers. |
| `execution_workflow_events` | [`schema.ts:2935`](../../src/db/schema.ts) | 20 | [`2026-09-22_post_only_fallback.sql`](../../drizzle/2026-09-22_post_only_fallback.sql) | Append-only Schritt-Log eines Workflows (Zustandskanten, Fill-Ereignisse, Gate-Entscheidungen). `from_state` … |
| `execution_workflow_fills` | [`schema.ts:2995`](../../src/db/schema.ts) | 10 | [`2026-09-22_post_only_fallback.sql`](../../drizzle/2026-09-22_post_only_fallback.sql) | Bestätigte Fills eines Workflows — die mengen-/fee-genaue Wahrheit. |
| `execution_twap_parents` | [`schema.ts:3037`](../../src/db/schema.ts) | 35 | [`2026-09-23_twap_execution.sql`](../../drizzle/2026-09-23_twap_execution.sql) | — |
| `execution_twap_slices` | [`schema.ts:3101`](../../src/db/schema.ts) | 22 | [`2026-09-23_twap_execution.sql`](../../drizzle/2026-09-23_twap_execution.sql) | — |
| `execution_twap_events` | [`schema.ts:3151`](../../src/db/schema.ts) | 14 | [`2026-09-23_twap_execution.sql`](../../drizzle/2026-09-23_twap_execution.sql) | — |
| `execution_twap_evaluations` | [`schema.ts:3185`](../../src/db/schema.ts) | 18 | [`2026-09-23_twap_execution.sql`](../../drizzle/2026-09-23_twap_execution.sql) | — |
| `strategy_definitions` | [`schema.ts:3227`](../../src/db/schema.ts) | 7 | [`2026-10-01_strategy_catalog.sql`](../../drizzle/2026-10-01_strategy_catalog.sql) | Persistierte Strategie-Definitionen (STX-04-01). |
| `strategy_versions` | [`schema.ts:3257`](../../src/db/schema.ts) | 12 | [`2026-10-01_strategy_catalog.sql`](../../drizzle/2026-10-01_strategy_catalog.sql) | Unveränderliche, rekonstruierbare Version eines Strategie-Artefakts (STX-04-01): kompilierte Parameter + … |
| `strategy_screening_runs` | [`schema.ts:3299`](../../src/db/schema.ts) | 12 | [`2026-10-01_strategy_screening.sql`](../../drizzle/2026-10-01_strategy_screening.sql) | Strategie×Markt-Screening-Lauf (STX-05-03): gemeinsamer PIT-Cutoff, reproduzierbare Config und monotone … |
| `strategy_market_results` | [`schema.ts:3330`](../../src/db/schema.ts) | 15 | [`2026-10-01_strategy_screening.sql`](../../drizzle/2026-10-01_strategy_screening.sql) | Immutable Screening-Zelle mit verpflichtendem Strategieversionsbezug. |
| `strategy_lifecycle_states` | [`schema.ts:3371`](../../src/db/schema.ts) | 13 | [`2026-09-23_strategy_lifecycle.sql`](../../drizzle/2026-09-23_strategy_lifecycle.sql) | Strategy-Lifecycle-Zustand je konkreter Strategieversion (RMA-P1-05, v1.73.0). |
| `strategy_lifecycle_evidence` | [`schema.ts:3422`](../../src/db/schema.ts) | 22 | [`2026-09-23_strategy_lifecycle.sql`](../../drizzle/2026-09-23_strategy_lifecycle.sql) | Immutable Evidence-Referenzen (RMA-P1-05). Kein Update-Pfad: Zeilen entstehen insert-only mit Content-Hash + … |
| `strategy_lifecycle_transitions` | [`schema.ts:3490`](../../src/db/schema.ts) | 17 | [`2026-09-23_strategy_lifecycle.sql`](../../drizzle/2026-09-23_strategy_lifecycle.sql) | Append-only Transitions-Log (RMA-P1-05). UNIQUE `transition_key` macht Retries/parallele Ausführungen … |
