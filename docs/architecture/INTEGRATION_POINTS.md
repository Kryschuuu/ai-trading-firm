# Integrationspunkte & Erweiterungs-Blaupause (v1.41.0)

> **Dokumenten-Status:** Kanonische Integrations- und Erweiterungskarte  
> **Stand:** 2026-09-18 · **Code-Version:** 1.41.0  
> **Verbindliche Referenz:** `docs/architecture/INTEGRATION_POINTS.md`

Dieses Dokument spezifiziert die **10 wichtigsten Integrationspunkte** im System für anstehende und implementierte Erweiterungen (Backtest-Engine, Trade-Attribution, Regime-Filter, Perp-Daten, Portfolio-Sizing, Execution-Tracking, etc.).

---

## Übersicht der 10 Integrationspunkte

| # | Integrationspunkt | Primäre Quelldateien | Status / Erweiterungsziel |
|---|---|---|---|
| 1 | **Backtest-Engine (Multi-Asset)** | `src/backtest/engine.ts`, `src/backtest/portfolio.ts`, `src/backtest/simulator.ts`, `src/cycle/steps/backtestStep.ts` | **Implementiert (Task 02 / v1.41.0):** Vollständiger synchronisierter Event-Driven Backtest über historische Kerzen |
| 2 | **Trade-Attribution & Analytics** | `src/lib/broker.ts`, `src/lib/microExecutor.ts`, `src/db/schema.ts` | PnL-Zuordnung je Regel, Setup, Agent und Markt-Regime |
| 3 | **Regime-Filter (Markt & Asset)** | `src/scanner/regime.ts`, `src/cycle/steps/macroStep.ts`, `src/lib/adaptiveRisk.ts` | Marktweites Makro-Regime + instrument-spezifisches Volatilitätsregime |
| 4 | **Perp-Daten-Ingestion (FR / OI)** | `src/marketdata/adapters/bitunix.ts`, `src/marketdata/sync.ts`, `src/scanner/factors/funding.ts` | Echte Funding Rates und Open Interest von Bitunix erfassen und persisted enrichern |
| 5 | **Portfolio-Sizing & Allocation** | `src/portfolio/optimize.ts`, `src/portfolio/riskGuard.ts`, `src/cycle/steps/riskStep.ts` | Mathematische Allokation (Risk Parity / Min Variance) vor Rule-Generierung |
| 6 | **Execution-Tracking & Slippage** | `src/brokers/bitunix/execution.ts`, `src/lib/marketdata/simulator.ts`, `src/db/schema.ts` | Realisierte Fills vs. Quotes analysieren (Slippage, Spread-Kosten, Partial Fills) |
| 7 | **Rule-Lifecycle & Cache-Sync** | `src/lib/ruleService.ts`, `src/lib/microExecutor.ts`, `src/app/api/firm/rules/route.ts` | Sofortige RAM-Invalidation (`RuleCache`) bei Statuswechsel via Postgres LISTEN/NOTIFY |
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
- **Datenfluss & Persistenz:** Erzeugt in `02-macro-analyst.json`, propagiert über `06-risk-manager.json` an `src/lib/adaptiveRisk.ts` (`state.adaptiveState`) und steuert die dynamic Caps der `riskGuard`.
- **Risiko & Non-Breaking Design:** Der Multiplikator senkt das Risiko **ausschließlich** (NUR multiplikativ ≤ 1.0, niemals hebelnd).

---

## 4. Perp-Daten-Ingestion (Funding Rate & Open Interest)

- **Beteiligte Dateien:**
  - `src/marketdata/adapters/bitunix.ts` (`createBitunixMarketDataAdapter`)
  - `src/marketdata/sync.ts` (`MarketDataSyncService`)
  - `src/scanner/factors/funding.ts` (Faktor 12)
  - `src/scanner/factors/openInterest.ts` (Faktor 13)
  - `src/universe/types.ts` (`DerivativeContext`)
- **Aktueller Stand & Limitationen:**
  Faktor 12 (`funding`) und Faktor 13 (`openInterest`) erwarten ein `DerivativeContext`-Objekt. Bislang liefert Bitunix Public Client diese Daten im Sync-Lauf noch nicht in die `InstrumentRegistry`. Bei fehlenden Daten greifen dokumentierte Neutralwerte (0.5).
- **Erweiterungs-Schnittstelle:**
  ```ts
  // In src/marketdata/types.ts:
  export interface MarketDataAdapter {
    // ... bestehende Methoden
    getFundingRate?(symbol: string): Promise<{ fundingRate: number; nextFundingTime: number }>;
    getOpenInterest?(symbol: string): Promise<{ openInterest: number; openInterestQuote: number }>;
  }
  ```
- **Datenfluss & Persistenz:** `MarketDataSyncService` fragt per-Batch oder per-Symbol FR/OI ab und speichert die Felder im Instrumenten-Eintrag in `data/universe/instruments.ndjson`.
- **Risiko & Non-Breaking Design:** Fehlen die Endpunkte, bleibt der Wert `null` und der Scanner nutzt weiterhin die existierenden sicheren Neutralwerte.

---

## 5. Portfolio-Sizing & Multi-Asset Allocation Optimizer

- **Beteiligte Dateien:**
  - `src/portfolio/optimize.ts` (`optimizeWithGuard`)
  - `src/portfolio/riskGuard.ts` (`guardPortfolioAllocations`)
  - `src/cycle/steps/riskStep.ts`
  - `src/lib/ruleEngine.ts` (`RuleAction.riskBudgetPct`, `RuleAction.maxPositionPct`)
- **Aktueller Stand & Limitationen:**
  Der Portfolio-Optimizer berechnet mathematisch exakte Gewichte (`min_variance`, `max_sharpe`, `risk_parity`) mit KKT-Polish und Spinu-Formulierung. Aktuell erzeugt Research Setups mit statischen 2 % Budgets.
- **Erweiterungs-Schnittstelle:**
  ```ts
  export interface PortfolioSizingEngine {
    computeAllocations(
      candidates: string[],
      mode: "risk_parity" | "min_variance" | "max_sharpe",
      constraints: { maxWeightPerInstrument: number; maxClusterExposure: number }
    ): Promise<Record<string, number>>;
  }
  ```
- **Datenfluss & Persistenz:** Wird im `06-risk-manager`-Schritt aufgerufen; berechnete Gewichte werden als `allocatedWeightPct` in die `TradeSetupProposal`-Objekte in `07-research` übernommen.
- **Risiko & Non-Breaking Design:** Die `RiskGuard`-Kette kappt alle Gewichte hart gegen `LIMIT_CEILINGS` (`maxWeightPerInstrument = 0.20`).

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
  - `src/lib/ruleService.ts` (`activateRule`, `pauseRule`, `archiveRule`, `rollbackRule`)
  - `src/lib/microExecutor.ts` (`RuleCache`)
  - `src/app/api/firm/rules/[id]/route.ts`
- **Aktueller Stand & Limitationen:**
  `RuleCache` im Micro-Executor pollt die Datenbank alle 30 Sekunden (`MICRO_RULE_REFRESH_MS`). Wird eine Regel über das Frontend oder den Makro-Zyklus aktiviert, vergehen bis zu 30 Sekunden bis zur Wirksamkeit im RAM-Cache des Hot-Paths.
- **Erweiterungs-Schnittstelle:**
  ```ts
  // PostgreSQL LISTEN / NOTIFY Hook:
  export function notifyRuleInvalidation(ruleKey: string): Promise<void> {
    return db.execute(sql`NOTIFY trade_rules_changed, ${ruleKey}`);
  }
  ```
- **Datenfluss & Persistenz:** `ruleService.activateRule` sendet `NOTIFY`; der In-Process `RuleCache` lauscht auf den Kanal und invalidiert sofort (< 1 ms).
- **Risiko & Non-Breaking Design:** Der 30s-Poll bleibt als robuster Fallback bei Verbindungsausfall des Listeners erhalten.

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
