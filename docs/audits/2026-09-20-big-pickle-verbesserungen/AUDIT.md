# Audit: Strategie-/Workshop-/Datenquellen-Verbesserungen

**Datum:** 2026-09-20  
**Quelle:** Big Pickle (big-pickle/opencode)  
**Name:** verbesserungen  
**Pfad:** `docs/audits/2026-09-20-big-pickle-verbesserungen/AUDIT.md`

---

## 1. Zusammenfassung

Dieser Audit dokumentiert die priorisierten Implementierungsmaßnahmen basierend auf der vollständigen Codebase-Analyse (Strategien S1–S6, Workshop W1–W5, Datenquellen-Ranking). Ziel ist die konkrete, sofort umsetzbare Verbesserung der Trading-Firm in vier Bereichen:

1. **Strategieverbesserungen** (O1–O6) — Rule Engine, Indikatoren, Backtest/Live-Konsistenz, Kosten-Modell
2. **Workshop-Optimierung** (W1–W5) — 5-Schritt-Schleife, HitRatePanel, Missionen, Prompts, AgentRun
3. **Datenquellen-Integration** — Yahoo History, Alpha Vantage, Polygon.io (empfohlen), FRED, Finnhub
4. **Arena.ai Agent-Prompts** — Optimale Subagent-Prompts je Arbeitspaket

Alle Prosa auf Deutsch; Commit-Messages: Conventional Commits (`feat/fix/docs(test): … (GAP-XX)`); Working Branches: `arena/*`.

---

## 2. Strategieverbesserungen (O1–O6)

### O1: Rule Engine — RULE_FIELDS & RuleSnapshot erweitern (ADX, BBW, MACD)

**Priorität:** 🔴 Höchste (Blockiert O2, O3, O4)

**Dateien:**
- `src/lib/ruleEngine.ts` — `RULE_FIELDS` (Zeile 45–59), `RuleSnapshot` (124–141), `buildSnapshotFromCandles` (ca. 480–560)
- `src/lib/indicators.ts` — MACD-Implementierung hinzufügen

**Konkrete Änderungen:**

```typescript
// RULE_FIELDS erweitern (Zeile 45–59)
export const RULE_FIELDS = {
  // ... bestehende Felder ...
  adx14: "number",           // NEU: Trendstärke
  bbwPct: "number",          // NEU: Bollinger Band Width %
  macd: "number",            // NEU: MACD Line
  macdSignal: "number",      // NEU: MACD Signal
  macdHist: "number",        // NEU: MACD Histogram
} as const;

// RuleSnapshot erweitern (Zeile 124–141)
export interface RuleSnapshot {
  // ... bestehende Felder ...
  adx14: number | null;
  bbwPct: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
}
```

**MACD in `indicators.ts` hinzufügen:**

```typescript
// Neu in src/lib/indicators.ts
export function macd(closes: number[], fast = 12, slow = 26, signal = 9): {
  macd: number; signal: number; hist: number;
} | null {
  if (!Array.isArray(closes) || closes.length < slow + signal) return null;
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = ema(macdLine, signal);
  const hist = macdLine.map((v, i) => v - signalLine[i]);
  const last = macdLine.length - 1;
  return { macd: macdLine[last], signal: signalLine[last], hist: hist[last] };
}
```

**buildSnapshotFromCandles anpassen** — MACD, ADX, BBW berechnen und in Snapshot schreiben.

**Tests:** `tests/indicators.test.ts` um MACD/ADX/BBW-Tests erweitern; `tests/ruleEngine.test.ts` Snapshot-Validierung mit neuen Feldern.

**CI:** `npm run test:coverage:marketdata` (90% Line-Gate) muss passieren.

---

### O2: TechnicalStep & ResearchStep — Computed Indicators statt LLM-Schätzung

**Priorität:** 🔴 Hoch

**Dateien:**
- `src/cycle/steps/technicalStep.ts` (LLM schätzt RSI/ATR, Fallback `rsi: 50`)
- `src/cycle/steps/researchStep.ts:138–139` (übernimmt Technical-Output)
- `src/lib/indicators.ts` — bereitet alles vor

**Problem:** Der Technical Analyst (Step 04) lässt das LLM RSI/ATR *schätzen* statt deterministisch zu berechnen. Der Research Step (Step 07) übernimmt diese geschätzten Werte unvalidiert.

**Lösung:** Pre-Compute Indikatoren im `technicalStep` **vor** dem LLM-Call, im Prompt als Fakten übergeben, LLM nur noch Bias/Thesis generieren lassen.

```typescript
// In technicalStep.execute: VOR context.ports.agent.invokeAgent
const precomputed = selection.map(c => {
  const candles = await getCandles(c.instrumentId, '1h', 120);
  const closes = candles.map(c => c.close);
  return {
    instrumentId: c.instrumentId,
    rsi14: rsi(closes),
    atrPct: atrPct(candles),
    adx14: adx(candles),
    bbwPct: bollingerBandWidthPct(closes),
    macd: macd(closes),
    ema9: ema(closes, 9).slice(-1)[0],
    ema21: ema(closes, 21).slice(-1)[0],
    ema50: ema(closes, 50).slice(-1)[0],
  };
});

// UserPrompt um precomputed erweitern, SystemPrompt: "Nutze die vorgegebenen Indikatorwerte exakt"
```

**HitRatePanel Baseline/Signifikanz** (`src/components/workshop/HitRatePanel.tsx`):
- `aggregateOutcomes` um statistische Signifikanz erweitern (Binomial-Test vs. 50% Nullhypothese)
- Confidence-Intervalle (Wilson-Score) für TRADE% anzeigen
- Mindest-N für Aussagekraft (z. B. n ≥ 30) als Warnung

---

### O3/O4: Backtest ↔ Live Exit-Konsistenz & Kosten im Quick-Backtest

**Priorität:** 🔴 Hoch

**Dateien:**
- `src/lib/exits.ts` + `src/lib/monitor.ts:23,204` (Live-Monitor Exit-Logik)
- `src/backtest/simulator.ts` + `src/backtest/paperExecution.ts:191–208` (Backtest Exit)
- `src/backtest/engine.ts` — `executionModel: "legacy" | "paper"` (GAP-01)

**Problem:** Live-Monitor (`monitor.ts`) und Backtest-Simulator (`simulator.ts` / `paperExecution.ts`) nutzen **unterschiedliche Exit-Logik**:
- Live: `detectExitTrigger` in `paperExecution.ts` (Marktstruktur, Stop-Vorrang)
- Legacy-Backtest: `evaluateExit` in `simulator.ts` (einfacher High/Low-Check)

**Lösung:** Einheitlicher Exit-Pfad über `paperExecution.ts` für **beide** Modi.

```typescript
// In backtest/engine.ts — paperExecutionRuntime für BEIDE Modi nutzen
// config.executionModel: "paper" als Default für neue Runs; "legacy" nur für Byte-Kompatibilität
const paper = createPaperExecutionRuntime(config.paper ?? {}, config.feeModel);
// detectExitTrigger + fillExit für ALLE Exits verwenden
```

**Kosten im Quick-Backtest** (`backtestRule` in `ruleEngine.ts:674–776`):
- Aktuell: Keine Fees/Slippage/Funding
- Erweiterung: `feeModel`, `slippageModel`, `funding` Optionen in `backtestRule` Signatur
- Paper-Execution-Pfad wiederverwenden für realistische Fills

---

### O5: Walk-Forward / Purged K-Fold Cross-Validation

**Priorität:** 🟡 Mittel

**Dateien:**
- `src/backtest/walkforward.ts` — existiert, aber Basis-Engine nutzt legacy-Exits
- `src/backtest/metrics.ts` — Metriken erweitern

**Maßnahmen:**
- `executionModel: "paper"` als Default für Walk-Forward
- Purged K-Fold (Embargo zwischen Train/Test) implementieren
- Metriken: `profitFactor`, `expectancy`, `ulcerIndex`, `recoveryFactor` hinzufügen

---

### O6: Regime-Filter in Rules (MarketRegime Integration)

**Priorität:** 🟡 Mittel

**Dateien:**
- `src/lib/marketRegime.ts` — Regime-Erkennung (Bull/Bear/Sideways/Volatile)
- `src/lib/ruleEngine.ts` — `RULE_FIELDS` um `regime` erweitern

**Lösung:** `regime` als RuleField (enum: `BULL`, `BEAR`, `SIDEWAYS`, `VOLATILE`) hinzufügen. Rules können dann z. B. `regime eq BULL` prüfen. `buildSnapshotFromCandles` Regime aus `marketRegime.assessRegime(candles)` befüllen.

---

## 3. Workshop-Optimierung (W1–W5)

### W1: Workshop Schritt 5 — "Regel-Backtest" mit Export nach `trade_rules`

**Priorität:** 🔴 Höchste (User-Request: O1 + W1)

**Dateien:**
- `src/components/workshop/WorkshopTab.tsx` — Steps-Array erweitern
- `src/components/workshop/` — neues `RuleBacktestPanel.tsx`
- `src/lib/workshop.ts` — Backtest-Logik für Mission→Rule

**Neuer Schritt 5:**
```typescript
// WorkshopTab.tsx steps erweitern
const steps = [
  // ... 1–4 bestehend ...
  { id: "backtest", label: "5 · Regel-Backtest", hint: "Mission als Regel backtesten, Metriken prüfen, in trade_rules übernehmen" },
];
```

**RuleBacktestPanel:**
- Mission → RuleSpec konvertieren (Template: `applyMissionTemplate`)
- `backtestRule(spec, candles)` aufrufen (HistoricalStore)
- Metriken anzeigen: WinRate, ProfitFactor, MaxDD, Expectancy, TRADE%
- Button "Als Regel speichern" → `POST /api/firm/rules` (schreibt in `trade_rules`)

**Arena-Prompt für W1:**
> Du bist der **Workshop-Architekt**. Implementiere Schritt 5 "Regel-Backtest" als neues Panel `RuleBacktestPanel.tsx`. Input: Mission (aus MissionsPanel). Output: BacktestResult + Button "In trade_rules übernehmen". Nutze `backtestRule` aus `ruleEngine.ts` und `HistoricalStore`. UI: Metrik-Karten (WinRate, PF, MaxDD, Expectancy), Equity-Curve (klein), Trade-Liste. Bei Klick: `ruleService.createRule(spec)` aufrufen. Guardrails: nur LONG, Risk-Ceilings prüfen.

---

### W2: HitRatePanel — Baseline & Signifikanz, JSON-Debugging verbessern

**Priorität:** 🔴 Hoch

**Dateien:** `src/components/workshop/HitRatePanel.tsx`, `src/lib/workshop.ts`

**Änderungen:**
- Wilson-Score Confidence Interval für TRADE% (95%)
- Binomial-Test p-Wert vs. 50% (Zufall)
- Warnung bei n < 30: "Zu wenige Läufe für statistische Aussage"
- JSON-Debug-Tips: Bei `INVALID_JSON` ≥ 20% **und** ≥ 2 Fälle → konkrete Prompt-Beispiele einblenden (aus `JSON_DEBUG_TIPS` + dynamisch: "Dein Prompt hat {X} Zeichen, empfohlen < 2000")

---

### W3: MissionsPanel — Validierung gegen `LIMIT_CEILINGS`, Segment-Vorlagen

**Priorität:** 🟡 Mittel

**Dateien:** `src/components/workshop/MissionsPanel.tsx`, `src/lib/missionTemplates.ts`, `src/lib/workshop.ts`

**Änderungen:**
- `validateMissionInput` warnt bei Risiko > 75% des Ceilings
- Segment-Vorlagen (`MISSION_SEGMENTS`) als Quick-Pick Buttons
- Template-Vorschau (Zieltext, Risk, MaxPos) vor Übernehmen
- Status `KILLED` Missionen aus HitRate/Dropdowns filtern (bereits in `HitRatePanel` Zeile 44)

---

### W4: PromptPanel — Versionsgeschichte, Diff, Optimistic Lock

**Priorität:** 🟡 Mittel

**Dateien:** `src/components/workshop/PromptPanel.tsx`, `src/lib/workshop.ts` (`validatePromptInput`)

**Status:** Optimistic Lock (`expectedVersion`) bereits implementiert (W2 v1.36.24).

**Ergänzung:**
- Versions-History Panel (letzte 10 Versionen mit Diff)
- "Rollback auf Version X" Button
- Prompt-Länge Warnung bei > 2000 Zeichen (kleine Modelle verlieren Struktur)

---

### W5: AgentRunPanel — Rohantwort + Trace sichtbar, Copy-to-Prompt

**Priorität:** 🟢 Niedrig

**Dateien:** `src/components/workshop/AgentRunPanel.tsx`

**Änderungen:**
- Roh-LLM-Response (vor Parsing) in Expander anzeigen
- Trace-Steps (Guardrail-Checks, Schema-Validation) mit Timings
- "Als Prompt-Vorlage kopieren" → füllt PromptPanel mit SystemPrompt + Beispiel-JSON

---

## 4. Datenquellen-Integration (Blueprint)

### 4.1 Ranking & Empfehlung

| Quelle | Kosten | Abdeckung | Qualität | Empfehlung | SSRF-Allowlist | Key-Handling |
|--------|--------|-----------|----------|------------|----------------|--------------|
| **Yahoo Finance** | Frei | Global (Aktien, ETFs, Crypto, Indizes) | Gut (1d, 1h, 15m via unofficial) | **Basis-History** (Backtest, Indikatoren) | `query1/2.finance.yahoo.com` in `PAPER_FEED_ALLOWED_HOSTS` | Kein Key |
| **Alpha Vantage** | Frei (25/day), Paid | Aktien, Forex, Crypto | Mittel (Rate-Limit strikt) | **Fallback / Fundamentals** | `www.alphavantage.co` | `ALPHAVANTAGE_API_KEY` in `.env` |
| **Polygon.io** | **Paid** (ab $29/mo) | US-Aktien, Options, Crypto, Forex | **Sehr gut** (Tick-level, Corporate Actions) | **Empfohlene Paid-Quelle** | `api.polygon.io` | `POLYGON_API_KEY` in `.env` |
| **FRED** | Frei | Makro (Zinsen, Inflation, GDP, VIX) | Sehr gut | **Makro-Regime, VIX** | `api.stlouisfed.org` | `FRED_API_KEY` in `.env` |
| **Finnhub** | Frei (60/min), Paid | Global, WebSocket | Gut | **Realtime-Quotes Alternative** | `finnhub.io` | `FINNHUB_API_KEY` in `.env` |
| **TradingView** | Nicht offiziell | — | — | ❌ **Abgeraten** (ToS, kein API, Scraping) | — | — |
| **IEX Cloud** | Paid (Deprecated/Sunset) | US | — | ❌ **Abgeraten** (Sunset 2024) | — | — |

### 4.2 Integrations-Blueprint (Code-Stubs)

**Neue Adapter in `src/marketdata/adapters/`:**

```typescript
// yahoo.ts — History Adapter (kein Key, public endpoints)
export async function createYahooAdapter(config: { allowedHosts: string[] }) {
  // fetch von query1/2.finance.yahoo.com, Chart-API
  // unterstützt: 1m, 5m, 15m, 1h, 1d, 1wk, 1mo
  // Mappe auf MarketDataAdapter Interface
}

// polygon.ts — Paid Adapter (Key required)
export async function createPolygonAdapter(config: { apiKeyEnv: string; allowedHosts: string[] }) {
  // REST + WebSocket, Tick-Level, Corporate Actions
  // Rate-Limit: plan-abhängig (TokenBucket)
}

// fred.ts — Makro Adapter
export async function createFredAdapter(config: { apiKeyEnv: string; allowedHosts: string[] }) {
  // VIX, Yields, CPI, GDP — Series IDs konfigurierbar
  // Cache TTL: 1h (Makro ändert sich langsam)
}

// finnhub.ts — Realtime Quote Alternative
export async function createFinnhubAdapter(config: { apiKeyEnv: string; allowedHosts: string[] }) {
  // WebSocket für Realtime, REST für History
}
```

**Registry erweitern** (`src/marketdata/registerAdapters.ts`):
```typescript
// Env-Flags (alle in CONFIGURATION.md dokumentieren)
MARKET_SYNC_YAHOO_ENABLED=true
MARKET_SYNC_POLYGON_ENABLED=true  // nur bei Key
MARKET_SYNC_FRED_ENABLED=true
MARKET_SYNC_FINNHUB_ENABLED=false

// In registerAdapters(): Capability-Check + Env-Gate + SSRF-Allowlist prüfen
```

**SSRF-Schutz:** `PAPER_FEED_ALLOWED_HOSTS` (CSV) in `.env` — **alle** externen Hosts hier eintragen. Adapter prüfen vor Request gegen Allowlist.

**Key-Handling:** **NIEMALS** Keys loggen, commiten, in Code hartkodieren. Nur via `process.env` / `src/lib/env.ts`. `.env.bak-*` in Root sind untrackt (drei Stück vorhanden) — nie echo'n.

---

## 5. Optimale Arena.ai Agent-Prompts (Subagent/arena Workflow)

Für jedes Arbeitspaket ein fertiger Prompt, den du als `arena/<branch>` Subagent starten kannst.

### Prompt O1 — Rule Engine Erweiterung (ADX, BBW, MACD)

```markdown
# arena/feat-rule-engine-indicators

## Rolle
Senior TypeScript Engineer — ai-trading-firm Core (Rule Engine, Indikatoren)

## Aufgabe
Erweitere `RULE_FIELDS` und `RuleSnapshot` in `src/lib/ruleEngine.ts` um:
- `adx14` (number) — Average Directional Index 14
- `bbwPct` (number) — Bollinger Band Width % (20, 2σ)
- `macd`, `macdSignal`, `macdHist` (number) — MACD (12,26,9)

Implementiere `macd()` in `src/lib/indicators.ts` (deterministisch, Wilder-EMA).
Passe `buildSnapshotFromCandles()` an: berechne alle 5 neuen Werte, schreibe in Snapshot.

## Constraints
- Keine externen Libs, reine Arithmetik
- Null-Sicherheit: `null` bei unzureichender Historie
- Whitelist-Prinzip: nur Felder in `RULE_FIELDS` dürfen in Rules vorkommen
- Tests: `tests/indicators.test.ts` (MACD/ADX/BBW), `tests/ruleEngine.test.ts` (Snapshot)

## Acceptance
- `npm run typecheck` ✓
- `npm run lint` ✓
- `npm run test:coverage:marketdata` ≥ 90% Line ✓
- Regel mit `adx14 gt 25` + `macdHist gt 0` kompiliert & evaluiert
```

---

### Prompt O2 — TechnicalStep Pre-Compute Indicators

```markdown
# arena/feat-technicalstep-precompute

## Rolle
Senior TypeScript Engineer — Macro Cycle Steps

## Aufgabe
Refactoriere `src/cycle/steps/technicalStep.ts`:
1. VOR dem LLM-Call: Für jedes Kandidat-Instrument (max 40) lade 1h-Kerzen (120 Bars) aus `HistoricalStore`
2. Berechne deterministisch: RSI14, ATR%, ADX14, BBW%, MACD, EMA9/21/50, Trend
3. Übergebe diese Werte im `userPrompt` als **Fakten** an den LLM (nicht schätzen lassen)
4. SystemPrompt: "Nutze die vorgegebenen Indikatorwerte exakt. Deine Aufgabe: Bias (BULLISH/BEARISH/NEUTRAL), Thesis, Key Levels."
5. `researchStep.ts` übernimmt diese Werte 1:1 (keine erneute LLM-Schätzung)

## Constraints
- `assertShortlistLimit(selection, 40)` bleibt erhalten
- Fallback bei fehlenden Kerzen: `rsi: 50, atrPct: null, adx14: null, bbwPct: null, macd: null`
- LLM-Output-Schema unverändert (`TechnicalStepOutput`)
- Keine DB-Änderungen, nur Step-Logik

## Acceptance
- TechnicalStep Output enthält deterministische Indikatorwerte (nicht LLM-geschätzt)
- ResearchStep Setups nutzen diese Werte für Entry/Stop/TP
- `npm run typecheck && npm run lint` ✓
```

---

### Prompt O3/O4 — Backtest/Live Exit Unity + Costs

```markdown
# arena/feat-backtest-live-exit-unity

## Rolle
Senior TypeScript Engineer — Backtest Engine & Live Monitor

## Aufgabe
Vereinheitliche Exit-Logik zwischen Live-Monitor (`src/lib/monitor.ts`, `src/backtest/paperExecution.ts`) und Backtest (`src/backtest/simulator.ts`, `src/backtest/engine.ts`):

1. **Einheitlicher Exit-Pfad:** `detectExitTrigger()` + `fillExit()` aus `paperExecution.ts` für **beide** Modi nutzen
2. In `backtest/engine.ts`: `executionModel: "paper"` als Default für **neue** Runs; `"legacy"` nur für Byte-Kompatibilität bestehender Artefakte
3. `backtestRule()` in `ruleEngine.ts`: Optionale `feeModel`, `slippageModel`, `funding` Parameter → delegiere an `paperExecutionRuntime`
4. Funding-Accrual im Backtest (Perpetuals) analog `monitor.ts` Zeile 204

## Constraints
- Legacy-Backtests müssen byte-identisch reproduzierbar bleiben (`executionModel: "legacy"`)
- Paper-Execution: `TokenBucket` für Rate-Limits, deterministische Order-IDs (Sequence)
- Fail-Closed: Simulator-Reject → Position bleibt offen (kein erfundener Fill)

## Acceptance
- Live-Monitor & Backtest (paper) nutzen **identischen** Exit-Code
- Quick-Backtest (`backtestRule`) zeigt realistische PnL mit Fees/Slippage/Funding
- `npm run test:coverage:bitunix` ≥ 90% Line ✓
- Walk-Forward Runs nutzen `executionModel: "paper"`
```

---

### Prompt W1 — Workshop Schritt 5: Regel-Backtest Panel

```markdown
# arena/feat-workshop-rule-backtest

## Rolle
Fullstack Engineer — Workshop UI (Next.js 16, React 19, Tailwind)

## Aufgabe
Implementiere Workshop Schritt 5 "5 · Regel-Backtest" als neues Panel `RuleBacktestPanel.tsx`:

**UI-Flow:**
1. Mission auswählen (Dropdown, nur `ACTIVE`/`PENDING`)
2. "Backtest starten" → lädt Kerzen aus `HistoricalStore` (Timeframe = Mission/Rule Default 1h)
3. Konvertiert Mission → `RuleSpec` (via `applyMissionTemplate` + `sanitizeRuleSpec`)
4. Führt `backtestRule(spec, candles)` aus
5. Zeigt Metrik-Karten: WinRate, ProfitFactor, MaxDD, Expectancy, TRADE%, Anzahl Trades
6. Mini-Equity-Curve (SVG/Canvas, 300×150px)
7. Trade-Liste (Entry/Exit, PnL, Reason)
8. Button **"Als Regel speichern"** → `POST /api/firm/rules` (RuleService.createRule)

**Integration:**
- `WorkshopTab.tsx`: Steps-Array um `{ id: "backtest", label: "5 · Regel-Backtest", hint: ... }` erweitern
- Route im Tab-Rendering hinzufügen
- `onChanged` Callback nach Speichern feuern

## Constraints
- Guardrails: `LIMIT_CEILINGS` prüfen (wie `validateMissionInput`)
- Nur LONG-Regeln (Shorts gesperrt)
- Loading/Error/Empty States
- Keine neuen API-Routes — nutze bestehende `/api/firm/rules`

## Acceptance
- Mission → Backtest → Regel in `trade_rules` in < 3 Klicks
- Metriken matchen `backtestRule` Output exakt
- `npm run lint && npm run typecheck` ✓
- Mobile responsive (Tailwind)
```

---

### Prompt W2 — HitRatePanel Statistik & Debugging

```markdown
# arena/feat-hitratepanel-stats

## Rolle
Frontend Engineer — Workshop Analytics

## Aufgabe
Erweitere `src/components/workshop/HitRatePanel.tsx` und `src/lib/workshop.ts`:

1. **Statistische Signifikanz:**
   - Wilson-Score 95% CI für TRADE% anzeigen (neben Balken)
   - Binomial-Test p-Wert vs. 50% Nullhypothese ("Zufall")
   - Warn-Banner bei n < 30: "Zu wenige Läufe für statistische Aussagekraft"

2. **JSON-Debugging verbessert:**
   - Bei `INVALID_JSON` ≥ 20% **und** ≥ 2 Fälle: dynamische Tipps
   - Prompt-Länge analysieren: "Dein Prompt: {len} Zeichen — empfohlen < 2000 für kleine Modelle"
   - Fehlende JSON-Marker prüfen: "Prompt enthält kein `{` — Beispiel-Objekt fehlt"
   - Modell-Empfehlung: "qwen2.5 bei JSON verlässlicher als 3B-Alternativen"

## Acceptance
- CI: `npm run test:coverage:marketdata` unverändert ✓
- UI: Kein Layout-Shift, Tooltips für CI/p-Wert
```

---

### Prompt Data Sources — Yahoo/Polygon/FRED Adapter

```markdown
# arena/feat-marketdata-adapters

## Rolle
Backend Engineer — Market Data Pipeline

## Aufgabe
Implementiere drei neue MarketDataAdapter in `src/marketdata/adapters/`:

### 1. Yahoo History Adapter (`yahoo.ts`)
- Endpoints: `query1.finance.yahoo.com`, `query2.finance.yahoo.com` (Chart API)
- Timeframes: 1m, 5m, 15m, 1h, 1d, 1wk, 1mo
- Kein API-Key, Rate-Limit: höflich (TokenBucket 5 req/s)
- Output: `MarketCandle[]` (time, open, high, low, close, volume)

### 2. Polygon.io Adapter (`polygon.ts`) — **Paid, empfohlen**
- REST: `api.polygon.io/v2/aggs/ticker/{symbol}/range/{mult}/{timespan}/{from}/{to}`
- WebSocket: `ws://socket.polygon.io` (Realtime)
- API-Key via `POLYGON_API_KEY` Env
- Corporate Actions (Splits, Dividends) → `adjustment` Feld
- Rate-Limit: Plan-abhängig (TokenBucket konfigurierbar)

### 3. FRED Makro Adapter (`fred.ts`)
- Series: VIX (VIXCLS), 10Y Yield (DGS10), CPI (CPIAUCSL), GDP (GDP)
- Endpoint: `api.stlouisfed.org/fred/series/observations`
- API-Key via `FRED_API_KEY` Env
- Cache TTL: 1 Stunde (Makro ändert sich langsam)
- Output: `MacroObservation[]` (date, value) → für `marketRegime.ts` nutzbar

## Registry Integration (`registerAdapters.ts`)
- Env-Flags: `MARKET_SYNC_YAHOO_ENABLED`, `MARKET_SYNC_POLYGON_ENABLED`, `MARKET_SYNC_FRED_ENABLED`
- Capability-Check: `VENUE_CAPABILITIES[venue].marketData === true`
- SSRF-Allowlist: `PAPER_FEED_ALLOWED_HOSTS` muss alle Hosts enthalten
- Key-Handling: **Nur** via `process.env`, nie loggen, nie committen

## Acceptance
- `npm run typecheck && npm run lint` ✓
- Adapter registrieren sich bei `MARKET_SYNC_VENUES=YAHOO,POLYGON,FRED`
- Sync-Service (`src/marketdata/sync.ts`) zieht History ohne Fehler
- Polygon WebSocket reconnectet bei Disconnect (exponential backoff)
```

---

## 6. CI / Docs Implications

### Workflow-Änderungen (spiegeln in `docs/ci/*.workflow.yml` UND `.github/workflows/`)

| Workflow | Änderung | Grund |
|----------|----------|-------|
| `main.yml` | `test:coverage:marketdata` Job hinzufügen | O1/O2 Indikator-Tests |
| `main.yml` | `test:coverage:bitunix` bestehende 90% Gate prüfen | O3/O4 Backtest/Live Unity |
| `security-live-gate.yml` | Unverändert (nur Security) | — |
| `docs-validate` | Prüft neue Env-Flags in `CONFIGURATION.md` | Data Sources |

### Docs zu aktualisieren

- `CONFIGURATION.md` — Neue Env-Flags dokumentieren (Yahoo, Polygon, FRED, Finnhub, `PAPER_FEED_ALLOWED_HOSTS`)
- `docs/MARKET_DATA_PIPELINE.md` — Adapter-Architektur, SSRF-Allowlist, Key-Handling
- `docs/HANDBUCH.md` K5/K6 — Workshop Schritt 5 dokumentieren, HitRatePanel Statistik erklären
- `docs/MISSIONS.md` — Mission→Rule Backtest Flow
- `docs/help/workshop.help.json` — Neue Schritt-5-Hilfe, HitRatePanel Tooltips

### Commit-Strategie

```bash
# Branch
git checkout -b arena/feat-rule-engine-indicators   # O1
git checkout -b arena/feat-technicalstep-precompute # O2
git checkout -b arena/feat-backtest-live-exit-unity # O3/O4
git checkout -b arena/feat-workshop-rule-backtest   # W1
git checkout -b arena/feat-hitratepanel-stats       # W2
git checkout -b arena/feat-marketdata-adapters      # Data Sources

# Commit Messages (Conventional Commits, German)
feat(rule-engine): RULE_FIELDS um ADX, BBW, MACD erweitern (O1)
feat(indicators): MACD-Implementierung (Wilder EMA) hinzugefügt (O1)
feat(technicalstep): Indikatoren pre-computed vor LLM-Call (O2)
feat(backtest): Exit-Logik mit Live-Monitor vereinheitlicht (O3/O4)
feat(workshop): Schritt 5 "Regel-Backtest" mit trade_rules Export (W1)
feat(hitrate): Wilson-CI, Binomial-Test, JSON-Debug-Tips (W2)
feat(marketdata): Yahoo/Polygon/FRED Adapter + SSRF-Allowlist (Data Sources)
docs(config): Env-Flags für neue Datenquellen dokumentiert
docs(handbuch): Workshop Schritt 5 + HitRatePanel Statistik
```

---

## 7. Offene AGENTS.md Edits (aus früherer Task)

Drei **additive** Edits (kein Rewrite), AGENTS.md ist derzeit untracked (`?? AGENTS.md`):

1. **PAPER_MODE_C_ENABLED Gotcha** — Hinweis: `PAPER_MODE=broker-paper-api` benötigt `PAPER_MODE_C_ENABLED=true` (sonst Boot-Verweigerung)
2. **docs/ci/README.md Mirror-Howto** — Wie man `docs/ci/*.workflow.yml` ↔ `.github/workflows/` byte-identisch hält
3. **help-schema Check in docs:validate** — `docs/help/*.help.json` gegen Schema validieren

Diese Edits separat in `arena/chore-agents-md-edits` committen.

---

## 8. Risiken & Offene Fragen

| Risiko | Mitigation |
|--------|------------|
| MACD/ADX/BBW Breaking Changes in Rules | `sanitizeRuleSpec` klemmt unbekannte Felder weg — alte Rules laufen weiter |
| Polygon.io Kosten | Env-Flag `MARKET_SYNC_POLYGON_ENABLED` default `false`; nur bei Key aktiv |
| SSRF-Allowlist unvollständig | CI-Test: `npm run security:live-gate` prüft `PAPER_FEED_ALLOWED_HOSTS` |
| Backtest/Live Drift bei Paper-Execution | Golden-Master-Test: identische Kerzen → identische Trades (Live vs. Backtest) |
| Workshop Step 5 UI Complexity | Progressive Disclosure: einfache Metriken zuerst, Equity-Curve aufklappbar |

---

## 9. Nächste Schritte (Suggested Order)

1. **O1** — Rule Engine Indikatoren (Fundament für alles)
2. **W1** — Workshop Schritt 5 (User-visible Value, nutzt O1)
3. **O2** — TechnicalStep Pre-Compute (Qualitätssprung für Research)
4. **O3/O4** — Backtest/Live Unity + Kosten (Produktionsreife)
5. **Data Sources** — Yahoo/Polygon/FRED Adapter (Datenbasis verbreitern)
6. **W2, W3, W4, W5** — Workshop Polish
7. **O5, O6** — Walk-Forward, Regime-Filter (Advanced)

---

**Ende des Audit.**  
Alle Code-Belege referenzieren exakte Dateien/Zeilen aus der analysierten Codebase (Stand 2026-09-20, main branch).