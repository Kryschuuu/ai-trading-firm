# Integrationspunkte & Erweiterungskarte (v0.17.2)

> **Dokumenten-Status:** Architekturübersicht; TASK 03/04/05/07 zuletzt fachlich abgeglichen<br>
> **Stand:** 2026-10-05 · **Code-Version:** v0.17.2 (Beta)<br>
> **Verbindliche Statusquellen:** [`docs/roadmap/STATUS.md`](../roadmap/STATUS.md), [`docs/PERPETUAL_DATA.md`](../PERPETUAL_DATA.md), [`docs/README.md`](../README.md)

Dieses Dokument skizziert die wichtigsten Integrationspunkte. Frühere
Erweiterungsschnittstellen in Abschnitten 1, 2, 6 und 8–10 sind
Architekturkontext, nicht automatisch eine Aussage über die aktuelle
Implementierung oder Produktionsreife. Die jeweils aktuelle Roadmap beschreibt
den geprüften Umfang und die verbleibenden Betriebsgrenzen.

---

## Übersicht der 10 Integrationspunkte

| # | Integrationspunkt | Primäre Quelldateien | Status / Erweiterungsziel |
|---|---|---|---|
| 1 | **Backtest-Engine (Multi-Asset)** | `src/backtest/engine.ts`, `src/backtest/portfolio.ts`, `src/backtest/simulator.ts`, `src/cycle/steps/backtestStep.ts` | **Implementiert (Task 02 / v1.41.0):** Vollständiger synchronisierter Event-Driven Backtest über historische Kerzen |
| 2 | **Trade-Attribution & Analytics** | `src/lib/broker.ts`, `src/lib/microExecutor.ts`, `src/db/schema.ts` | PnL-Zuordnung je Regel, Setup, Agent und Markt-Regime |
| 3 | **Regime-Filter (Markt & Asset)** | `src/scanner/regime.ts`, `src/cycle/steps/macroStep.ts`, `src/lib/adaptiveRisk.ts` | Makro-Risikodrossel mit as-of/Frischeprüfung und instrument-spezifisches Volatilitätsregime |
| 4 | **Perp-Daten-Ingestion (Funding / OI / Liquidations)** | `src/perpdata/`, `src/brokers/bitunix/publicClient.ts`, `src/scanner/factors/funding.ts` | Funding-Sync implementiert; Bitunix OI/Liquidationen ohne öffentlichen Endpoint (`UNSUPPORTED`); Live-Sync noch in Zielumgebung zu verifizieren |
| 5 | **Portfolio-Sizing & Allocation** | `src/portfolio/optimize.ts`, `src/portfolio/riskGuard.ts`, `src/cycle/steps/riskStep.ts`, `src/cycle/steps/researchStep.ts` | Risk-geprüfte relative Gewichte erreichen serverseitig validierte Research-Proposals; keine Orderfreigabe |
| 6 | **Execution-Tracking & Slippage** | `src/executionQuality/`, `src/attribution/`, `src/db/schema.ts` | Execution-quality capture/reconcile und Trade-Attribution/Aggregation vorhanden; siehe jeweilige API-/Betriebsdoku |
| 7 | **Rule-Lifecycle & Cache-Sync** | `src/lib/ruleService.ts`, `src/lib/microExecutor.ts`, `src/lib/tradeRulesNotificationListener.ts`, `drizzle/2026-10-05_trade_rules_notify.sql` | LISTEN/NOTIFY invalidiert RuleCaches sofort; Polling/Backoff sind Fallbacks, SQL-Trigger-Migration manuell anzuwenden |
| 8 | **State Registry & Hydration** | `src/lib/stateRegistry.ts`, `src/lib/broker.ts`, `src/lib/engine.ts` | Atomare Mehrprozess-Hydrierung von Ledgern und Risk-Zuständen |
| 9 | **LLM-Routing & Escalation** | `src/routing/router.ts`, `src/cycle/engine.ts`, `src/lib/llmProvider.ts` | Dynamische Modellauswahl nach Task-Komplexität und Token-Budget-Eskalation |
| 10 | **Live-Gate Enforcement Hooks** | `src/live-gate/enforcer.ts`, `src/brokers/bitunix/adapter.ts`, `src/brokers/factory.ts` | Schusssichere Torsicherung für zusätzliche Broker-Venues (z. B. Alpaca, Binance) |

---

## 1. Backtest-Engine (Multi-Asset Historical Simulator)

- **Beteiligte Dateien:**
  - `src/cycle/steps/backtestStep.ts`
  - `src/lib/ruleEngine.ts` (`backtestRuleOnCandles`)
  - `src/lib/marketdata/historicalStore.ts` (`HistoricalStore.query`)
  - `src/lib/marketdata/feeds/replay.ts` (`ReplayFeed`)
  - `src/db/schema.ts` (`rule_backtests`)
- **Aktueller Stand & Limitationen:**
  `backtestStep.ts` verifiziert aktuell Research-Setups auf Basis einzelner Kerzenschnittmengen mit vereinfachten Kennzahlen (`maxDrawdown`, `profitFactor`, `sharpeRatio`). `backtestRuleOnCandles` in `src/lib/ruleEngine.ts` testet einzelne `RuleSpec`-Objekte seriell. Es fehlt ein koordinierter Multi-Asset-Portfoliosimulator, der zeitgleiche Signale mit gemeinsamen Cash- und Positionsgrenzen testet.
- **Erweiterungs-Schnittstelle:**
  ```ts
  export interface PortfolioBacktestOptions {
    rules: RuleSpec[];
    from: number;
    to: number;
    timeframe: SupportedTimeframe;
    initialCapital: number;
    slippageModel: "fixed" | "spread_relative";
    feeModel: { makerFee: number; takerFee: number };
  }

  export interface PortfolioBacktestResult {
    equityCurve: { ts: number; equity: number; cash: number; openPositions: number }[];
    metrics: {
      totalPnl: number;
      sharpeRatio: number;
      sortinoRatio: number;
      maxDrawdownPct: number;
      profitFactor: number;
      winRate: number;
      tradesCount: number;
    };
    tradeLogs: Array<{
      ruleId: string;
      symbol: string;
      entryTs: number;
      exitTs: number;
      entryPrice: number;
      exitPrice: number;
      pnl: number;
      exitReason: string;
    }>;
  }
  ```
- **Datenfluss & Persistenz:** Liest aus `HistoricalStore` (`data/history/candles.ndjson`), persistiert Durchläufe in `rule_backtests` und als JSON-Artefakt `08-backtest-verification.json`.
- **Risiko & Non-Breaking Design:** Reine mathematische Berechnung (`llmAllowed = false`). Keine Auswirkung auf Live-State.

---

## 2. Trade-Attribution & Performance Analytics

- **Beteiligte Dateien:**
  - `src/lib/broker.ts` (`positions`, `order_intents`)
  - `src/lib/microExecutor.ts` (`rule_executions`)
  - `src/db/schema.ts` (`positions`, `rule_executions`, `agent_messages`, `equity_snapshots`)
  - `src/portfolio/metrics.ts`
- **Aktueller Stand & Limitationen:**
  `positions` speichert `rule_id` und `realized_pnl`. `rule_executions` speichert Latenzen und Snapshots. Eine granulare Zerlegung, welcher Agent (Research vs. Selection vs. Technical), welche Marktphase (Regime) und welcher Faktor-Score den Gewinn/Verlust verursacht hat, ist noch nicht aggregiert abrufbar.
- **Erweiterungs-Schnittstelle:**
  ```ts
  export interface TradeAttribution {
    positionId: string;
    ruleId: string | null;
    missionId: string | null;
    symbol: string;
    realizedPnl: number;
    returnPct: number;
    holdingDurationMs: number;
    attribution: {
      regimeAtEntry: "LOW" | "NORMAL" | "HIGH" | "EXTREME";
      macroRegimeAtEntry: "RISK_ON" | "RISK_OFF" | "MIXED";
      marketScoreAtEntry: number;
      sourceRole: "CEO" | "RESEARCH" | "MANUAL";
      sourceMode: "SIGMA" | "FALLBACK";
      slippagePaid: number;
      feesPaid: number;
    };
  }
  ```
- **Datenfluss & Persistenz:** Liest Relationen aus `positions` JOIN `trade_rules` JOIN `rule_executions` JOIN `agent_messages`. Liefert Daten für Operations Center (`GET /api/ops`) und Performance-Reports (`GET /api/firm/report`).
- **Risiko & Non-Breaking Design:** Rein lesender Analyse-Layer.

---

## 3. Regime-Filter (Marktweit & Asset-Spezifisch)

- **Beteiligte Dateien:**
  - `src/scanner/regime.ts` (`classifyRegime`)
  - `src/cycle/steps/macroStep.ts` (Cassini Makro-Regime)
  - `src/lib/adaptiveRisk.ts` (`getAdaptiveRiskFactor`, `evaluateMarketRegime`)
  - `src/scanner/config.ts` (`ScannerConfig.regime`)
- **Aktueller Stand & Limitationen:**
  Es existieren zwei separate Regime-Begriffe:
  1. Das instrument-spezifische Volatilitätsregime (`LOW`, `NORMAL`, `HIGH`, `EXTREME`) im Scanner (`src/scanner/regime.ts`), berechnet aus der annualisierten realisierten Volatilität.
  2. Das globale Makro-Regime (`RISK_ON`, `RISK_OFF`, `MIXED`) im Agent-Zyklus (`src/cycle/steps/macroStep.ts`).
  Bislang filtert der Scanner nur auf Einzeltitelebene (`max-regime`).
- **Erweiterungs-Schnittstelle:**
  ```ts
  export interface SystemicRegimeContext {
    macroRegime: "RISK_ON" | "RISK_OFF" | "MIXED";
    marketVolatilityRegime: "LOW" | "NORMAL" | "HIGH" | "EXTREME";
    compositeRiskMultiplier: number; // ∈ (0, 1] — wirkt als Drosselung auf maxRiskPerTrade
    effectiveAsOf: string;
  }
  ```
- **Datenfluss & Persistenz:** `src/lib/macroRegimeContext.ts` prüft den jüngsten indexierten Cycle-Lauf im konfigurierten Artefakt-Root/Index; nur ein frischer, abgeschlossener Lauf darf `src/lib/adaptiveRisk.ts` drosseln. Ein neuerer fehlgeschlagener/unvollständiger Lauf und fehlende, veraltete, zukünftige, fehlerhafte oder übersprungene Ausgaben bleiben neutral, ohne Rückfall auf ältere Makro-Daten; `LOW` erhöht Risiko nicht. Details und Grenzen: [`docs/roadmap/STATUS.md`](../roadmap/STATUS.md).
- **Risiko & Non-Breaking Design:** Der Multiplikator senkt das Risiko **ausschließlich** (NUR multiplikativ ≤ 1.0, niemals hebelnd).

---

## 4. Perp-Daten-Ingestion (Funding, Open Interest & Liquidationen)

- **Beteiligte Dateien:**
  - `src/perpdata/adapters/bitunix.ts` und `src/perpdata/service.ts` (kanonischer Sync-Pfad)
  - `src/brokers/bitunix/publicClient.ts` (credential-freie Bitunix-Funding-API)
  - `src/perpdata/capabilities.ts`, `src/perpdata/store.ts` (Capability/append-only Ablage)
  - `src/perpdata/consumer.ts`, `src/scanner/factors/funding.ts`, `src/scanner/factors/openInterest.ts`
- **Aktueller Stand & Limitationen:**
  Bitunix current funding snapshots und historische Funding-Sätze laufen über öffentliche Endpunkte; Funding-Raten werden als dokumentierte Dezimalwerte unverändert normalisiert. Die History-Doku nennt den Start-Query-Key `starTime`, daher sendet der Client diese Schreibweise; ein Live-Vendor-Request konnte hier nicht verifiziert werden. Bitunix bietet laut geprüfter öffentlicher Futures-Doku keine OI- oder Liquidations-Endpunkte. Diese Capabilities sind `UNSUPPORTED / NO_PUBLIC_ENDPOINT` und lösen keinen Request aus; sie werden nicht als Messwert `0` ausgegeben. `SIM` ist ein deterministischer Test-/Offline-Fixture-Provider, kein Live-Ersatz.
- **Datenfluss:**
  `BitunixPublicClient` → `BitunixPerpAdapter` → Normalisierung/Qualität/Append-only `perp_*`-Tabellen → as-of Consumer/Scanner. `PERP_DATA_SYNC_ENABLED=true`, `BITUNIX_ENABLED=true` und `PERP_DATA_VENUES`-Freigabe sind für Ingestion nötig; `PERP_DATA_ENABLED=true` schaltet separat Scanner/Replay/Analyst-Konsumenten frei. Discovery für fehlende Perpetual-Instrumente läuft separat über `MARKET_SYNC`.
- **Live-Betrieb:**
  ```bash
  BITUNIX_ENABLED=true MARKET_SYNC_VENUES=BITUNIX npm run market:sync -- --venue=BITUNIX
  BITUNIX_ENABLED=true PERP_DATA_SYNC_ENABLED=true PERP_DATA_VENUES=BITUNIX \
    npm run perp:sync -- --venue=BITUNIX --kinds=funding --mode=backfill --days=30
  ```
  Keine Bitunix-API-Credentials erforderlich. Zielumgebungs-Sync und tatsächliche Registry-/Datenabdeckung bleiben zu verifizieren. Betriebs- und Schema-Details stehen in [`docs/PERPETUAL_DATA.md`](../PERPETUAL_DATA.md).
- **Risiko & Non-Breaking Design:**
  Fähigkeitslücken, fehlende Historie und transienter Provider-Ausfall sind verschieden typisiert. Fehlende/stale Daten bleiben sichtbar und werden weder als Nullmessung noch als erfolgreich synchronisiert ausgegeben.

---

## 5. Portfolio-Sizing & Multi-Asset Allocation Optimizer

- **Beteiligte Dateien:**
  - `src/portfolio/optimize.ts` (`optimizeWithGuard`)
  - `src/portfolio/riskGuard.ts` (Portfolio-Guards)
  - `src/cycle/steps/riskStep.ts`, `src/cycle/steps/researchStep.ts`
  - `src/cycle/schemas.ts` (`portfolioAllocation`, `portfolioWeight`)
- **Aktueller Stand:**
  `riskStep` bildet die deterministisch freigegebene Kandidatenmenge; die LLM-Antwort darf sie nur verengen. Auf ausschließlich gemeinsame, bis `asOf` gültige Preiszeitstempel werden Risk-Parity-Gewichte berechnet und guard-geprüft. Unzureichende Historie, Guard-/Solver-Ablehnung und Fehler erhalten einen explizit gekennzeichneten Equal-Weight-Fallback.
- **Datenfluss:**
  Das Risk-Artefakt hält Allokation und Methode. `researchStep` liest sie serverseitig, filtert jedes Modell-Setup auf die Risk-freigegebene Shortlist und ergänzt `portfolioWeight`; Gewichte für eine engere Research-Shortlist werden normalisiert. Nicht freigegebene Symbole werden verworfen und `totalSetups` aus der sicheren Ausgabe neu berechnet.
- **Grenzen:**
  `portfolioWeight` ist ein relatives Vorschlagsgewicht, keine absolute Kontopositionsgröße, Orderfreigabe oder Authority-Überschreibung. Research bleibt proposal-only; bestehende RiskGuard-, Execution- und Live-Gate-Grenzen bleiben maßgeblich. Daten mit Event-Zeit oder `fetchedAt > asOf` dürfen Research-/Backtest-Auswertungen nicht beeinflussen.

---

## 6. Execution-Tracking & Slippage/Fee Analysis

- **Beteiligte Dateien:**
  - `src/brokers/bitunix/execution.ts` (`BrokerExecutionEngine.reconcile`)
  - `src/lib/marketdata/simulator.ts` (`FillSimulator`)
  - `src/contracts/broker.ts` (`BrokerOrderResult`)
  - `src/db/schema.ts` (`positions`, `rule_executions`)
- **Aktueller Stand & Limitationen:**
  `FillSimulator` modelliert Slippage, Spread und Gebühren synthetisch. `BrokerExecutionEngine` ruft über `reconcile()` die echten Trades ab und bildet mengengewichtete `avgPrice`-Werte. Eine strukturierte Speicherung der Abweichung (Expected Price vs. Executed Fill Price) fehlt in der Datenbank.
- **Erweiterungs-Schnittstelle:**
  ```ts
  export interface ExecutionQualityReport {
    orderId: string;
    symbol: string;
    expectedPrice: number;
    fillPrice: number;
    slippageBps: number; // (fillPrice - expectedPrice)/expectedPrice * 10000
    feePaid: number;
    feeAsset: string;
    latencyMs: number;
  }
  ```
- **Datenfluss & Persistenz:** Erfasst in `BrokerExecutionEngine.reconcile()` und abgelegt im `fill`-JSONB-Feld von `rule_executions` sowie im `audit_log`.
- **Risiko & Non-Breaking Design:** Additive Felder im JSONB `fill`, kein Schema-Bruch.

---

## 7. Rule-Lifecycle & Cache-Invalidation (Hot-Path)

- **Beteiligte Dateien:**
  - `src/lib/ruleService.ts` (`startTradeRulesListen`, `stopTradeRulesListen`)
  - `src/lib/tradeRulesNotificationListener.ts` (dedizierter reconnectender PG-Listener)
  - `src/lib/ruleCacheRegistry.ts`, `src/lib/microExecutor.ts` (`RuleCache`)
  - `drizzle/2026-10-05_trade_rules_notify.sql` (PostgreSQL Trigger)
- **Aktueller Stand:**
  Regelmutationen in `public.trade_rules` senden nach dem Commit über einen statement-level Trigger `NOTIFY trade_rules`. `ruleService` verbindet den Listener mit allen im Prozess registrierten RuleCaches; die Invalidierung markiert den Cache sofort ungültig und startet/teilt einen reload. Der Cache lädt fehlgeschlagene oder währenddessen überholte Snapshots nicht aktiv; ein erfolgreicher aktueller Reload veröffentlicht die Maps atomar.
- **Resilienz und Betrieb:**
  PostgreSQL LISTEN nutzt eine dedizierte Pool-Verbindung, reconnectet mit begrenztem exponentiellem Backoff, und der 30-Sekunden-Cache-Poll bleibt Fallback. Fehlgeschlagene Loads lösen keinen unbeschränkten sofortigen Retry-Sturm aus; nach einer NOTIFY liefert `match()` fail-closed, bis ein aktueller Snapshot geladen wurde. Der Trigger-SQL muss nach dem Schema-Setup explizit angewendet werden (`psql "$DATABASE_URL" -f drizzle/2026-10-05_trade_rules_notify.sql`); `drizzle-kit push` installiert keine Trigger/Funktionen.
- **Tests:**
  Listener-Verlust/Reconnect, NOTIFY→Cache-Invalidation, Trigger-Wirkung und fehlgeschlagener Reload sind durch dedizierte Tests abgedeckt; PostgreSQL-Tests benötigen eine erreichbare Testdatenbank.

---

## 8. State Registry & Hydration

- **Beteiligte Dateien:**
  - `src/lib/stateRegistry.ts` (`state`, `__resetAllSingletonsForTests`)
  - `src/lib/broker.ts` (`withAccountLock`, `state.paperBrokerLedger`)
  - `src/lib/engine.ts` (`restoreFirmState`)
- **Aktueller Stand & Limitationen:**
  Alle prozessweiten Singletons sind typisiert in `src/lib/stateRegistry.ts` registriert. `firmHydrated` schützt vor Mehrfach-Hydrierung aus der Datenbank.
- **Erweiterungs-Schnittstelle:**
  ```ts
  // Bei neuen Singletons:
  export const state = {
    // ... bestehende Accessoren
    backtestEngineState: ref<BacktestRuntimeState>("backtestEngineState"),
  };
  ```
- **Datenfluss & Persistenz:** Neuer State wird in `state` als `flag`, `ref` oder `map` registriert und in `__resetAllSingletonsForTests()` aufgenommen.
- **Risiko & Non-Breaking Design:** Verhindert Memory-Leaks und globale Verschmutzung; garantiert grüne Unit-Tests.

---

## 9. LLM-Routing & Model Escalation Hook

- **Beteiligte Dateien:**
  - `src/routing/router.ts` (`ModelRouter.resolve`, `ModelRouter.requestEscalation`)
  - `src/cycle/engine.ts` (`MODEL_ESCALATION_REQUEST` Handler)
  - `src/lib/llmProvider.ts` (`chatLlm`)
- **Aktueller Stand & Limitationen:**
  `ModelRouter` wählt anhand von Task-Komplexität und Token-Budget zwischen Modellen (`small`, `medium`, `large`, `cloud`). `executeCycle` erfasst `ModelEscalationRequest` im Audit-Log, schlägt aber bisher auf den Default-Provider zurück.
- **Erweiterungs-Schnittstelle:**
  ```ts
  export interface AnalysisAgentPort {
    invokeAgent<T>(params: {
      role: string;
      systemPrompt: string;
      userPrompt: string;
      taskComplexity?: "low" | "medium" | "high" | "critical";
      untrustedData?: Record<string, unknown>;
      schemaValidator: (raw: unknown) => { success: boolean; data?: T; error?: string };
      fallback: T;
    }): Promise<{ output: T; modelUsed: string; escalated: boolean }>;
  }
  ```
- **Datenfluss & Persistenz:** Übergibt Anfrage an `ModelRouter.resolve()`. Bei Eskalation wird das nächsthöhere Modell gewählt und das Token-Budget in `src/routing/budget.ts` belastet.
- **Risiko & Non-Breaking Design:** Bei Budget-Überschreitung oder Provider-Ausfall Zwangsfallback auf lokales Basismodell (`ollama`).

---

## 10. Live-Gate Enforcement & Multi-Venue Safety Hooks

- **Beteiligte Dateien:**
  - `src/live-gate/enforcer.ts` (`assertLiveOrderAllowed`, `evaluateLiveOrder`)
  - `src/brokers/factory.ts` (`getBroker`)
  - `src/brokers/bitunix/adapter.ts`
  - `src/live-gate/states.ts` (`LIVE_GATE_TRANSITIONS`)
- **Aktueller Stand & Limitationen:**
  Der Live-Gate-Enforcer prüft 10 strenge Bedingungen (Machine-State = `LIVE_ENABLED`, 3 Flags, Kill-Switch, Security-Suite-Stamp, Control-Plane-State). Bitunix ist vollständig verdrahtet. Weitere Venues (z. B. Alpaca, Binance) sind als Stubs vorhanden.
- **Erweiterungs-Schnittstelle:**
  ```ts
  export function assertLiveOrderAllowed(venue: BrokerVenueId): void {
    const evaluation = evaluateLiveOrder(venue);
    if (!evaluation.allowed) {
      throw new LiveTradingGateError(venue, evaluation.code, evaluation.reason);
    }
  }
  ```
- **Datenfluss & Persistenz:** Jeder Adapter-Aufruf mit `mode = "live"` muss zwingend `assertLiveOrderAllowed(venue)` vor der Instanziierung von signierten Clients aufrufen.
- **Risiko & Non-Breaking Design:** Keine Order kann ohne State-Machine-Freigabe, CI-Security-Suite-Stamp und explizite Env-Flags an eine echte Börse gesendet werden.
