# Architektur: Event-Driven Multi-Zyklen-Trading-System (v1.7)

> **Status-Header (Task 12):** **Implementiert** (Tasks 1–11 gemerged) ·
> Dokumentationsstand **2026-08-29** · Code-Version **1.23.0**
> Verantwortlich: `docs/ARCHITECTURE.md` (Docs-as-Code, Pflege-Regeln: [§13](#13-wie-docs-hier-gepflegt-werden-docs-as-code))

**Detailliertes Architektur- und Implementierungskonzept** für eine
Trading-Firma, die strategische Intelligenz (LLM) von
Ausführungsgeschwindigkeit (kein LLM) trennt.

> Kernidee in einem Satz: **Die LLMs entscheiden langsam im Hintergrund,
> ein reines Skript handelt sofort — verbunden über eine versionierte,
> validierte Regel in der Datenbank, nie über eine lineare Pipeline.**

---

## 0. Warum nicht die lineare Pipeline optimieren?

Die bisherige Pipeline (`CEO → Research → Backtest → Risk → Approver →
Executor`) ruft pro Durchlauf **6 LLMs sequenziell** auf. Auf dem N150
bedeutet das 2–6 Minuten Latenz pro Entscheidungskette — und jeder
Markt-Tick, der in dieser Zeit kommt, ist veraltet. Die Grenze ist
strukturell: **LLM-Latenz multipliziert mit Pipeline-Länge**.

Lineare Optimierung (kleinere Modelle, Parallelität, Streaming) reduziert
nur den Faktor, beseitigt aber nicht den Konflikt. Die Lösung ist
*kausale Entkopplung*:

| Ebene | Zyklus | Takt | Enthält LLM? | Ergebnis |
| --- | --- | --- | --- | --- |
| **Makro** (CEO + Research) | 1× pro Stunde/Tag | Minuten | **ja** | statisches, validiertes Regelwerk in `trade_rules` |
| **Mikro** (Executor) | jeder Preis-Tick | **Millisekunden** | **nein** | Trade, wenn Regel erfüllt |

Der LLM rechnet nicht mehr *mit*, er rechnet *vor*.

---

## 1. Systemarchitektur

```
┌─────────────────────────────────────────────────────────────────────────┐
│  MAKRO-EBENE · langsam · LLM · N150 (oder Desktop bei Variante B)       │
│                                                                         │
│  ┌──────────┐   ┌──────────────┐   ┌──────────────────────────────┐    │
│  │  CEO     │   │ RESEARCH     │   │  Ausführungs-Feedback        │    │
│  │ (Lex)    │◄──│ (Rhea)       │◄──│  rule_executions, positions  │    │
│  └────┬─────┘   └──────┬───────┘   └──────────────────────────────┘    │
│       │  PRÜFEN/REVIDIEREN      │  ERZEUGEN                            │
│       └───────────┬─────────────┘                                      │
│                   ▼                                                    │
│      softes Gate: sanitizeRuleSpec() (Whitelist) + Klemmung            │
│      hartes Gate: riskGateRule() (Risk-Score, Limits)                  │
│                   ▼                                                    │
│      trade_rules (versioniert, immutable: v1 → v2 → v3 …)              │
│      status: DRAFT → ACTIVE → SUPERSEDED | PAUSED | ARCHIVED           │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ SELECT … WHERE status='ACTIVE' (Poll 30 s
                               │ bzw. Invalidation im selben Prozess)
┌──────────────────────────────▼──────────────────────────────────────────┐
│  MIKRO-EBENE · schnell · 0 LLM-Calls · eigener Prozess (Node)           │
│                                                                         │
│  WebSocket-Feed (Binance @trade + @kline_1m   oder Simulator)           │
│      │  ms-genaue Preis-/Volumen-Ticks                                  │
│      ▼                                                                  │
│  RollingTimeframeSeries  (1m→5m/15m/30m/1h, REST-Seed, RAM only)        │
│      ▼  ~10–100 µs                                                      │
│  RuleSnapshot (RSI, EMA9/21/50, ATR, Volumen, Volume-Ratio, …)          │
│      ▼  ~1 µs pro Regel                                                 │
│  RuleCache.match()  —— kompilierte ACTIVE-Regeln im RAM                 │
│      │     Fenster offen? Cooldown? Tageslimit? Mission aktiv?          │
│      ▼                                                                  │
│  RuleExecutionAdapter (Paper):                                          │
│     Advisory-Lock pro Symbol → DB-Wahrheit → Guardrails → Fill          │
│      │                                                                  │
│      ▼                                                                  │
│  positions (+ rule_id) → rule_executions (Feedback) → audit_log         │
└──────────────────────────────────────────────────────────────────────────┘
```

### Komponenten

| Komponente | Datei | Verantwortung | Skaliert |
| --- | --- | --- | --- |
| Makro-Zyklus | `src/lib/macroCycle.ts` | CEO + Research: Regel erzeugen, prüfen, revidieren; Feedback-Kontext; Audit | vertikal (1 Prozess reicht; CPU ist N150-tauglich) |
| Regel-Engine | `src/lib/ruleEngine.ts` | DSL, Whitelist-Validierung, Klemmung, Kompilierung, Snapshot, Backtest — **pure, testbar, kein IO** | — (Bibliothek) |
| Regel-Persistenz | `src/lib/ruleService.ts` | Versionierung, Lebenszyklus, Rollback, Feedback-Aggregation — **LLM-frei** | vertikal |
| Regel-Cache | `src/lib/microExecutor.ts` (`RuleCache`) | ACTIVE-Regeln kompilieren & im RAM halten; Poll + Invalidation | pro Instanz |
| Mikro-Executor | `src/lib/microExecutor.ts` (`MicroExecutor`) | Hot-Path: Tick → Snapshot → Match → Adapter; Latenz-Metriken | **horizontal** (N Instanzen, s. u.) |
| Feeds | `BinanceTradeFeed`, `SimulatedFeed`, `SequenceFeed` | WebSocket-/Sim-Datenquellen | pro Instanz |
| Paper-Adapter | `createPaperRuleAdapter()` | Kill-Switch, Positions-Sperre, Guardrails, Fill, Feedback | horizontal-safe (Advisory-Lock) |
| Standalone-Prozess | `scripts/micro-executor.ts` | `npm run micro` + Health-HTTP (Port 3380) | 1+ Instanzen |

### Kommunikationswege

1. **Makro → Mikro (Regeln):** ausschließlich über PostgreSQL
   (`trade_rules`). Read-modell: `status='ACTIVE'` — der Cache pollt alle
   `MICRO_RULE_REFRESH_MS` (30 s) und invalidiert im selben Prozess sofort.
   **Kein Redis, keine Queue nötig** für Korrektheit: die DB ist der
   Zustand, RAM ist nur der Beschleuniger. Redis/Event-Bus (z. B.
   `NOTIFY trade_rules_changed`) ist eine reine Latenz-Optimierung für
   große CLuster — siehe §5.
2. **Mikro → Makro (Feedback):** `rule_executions` (Trigger/Block/Fehler +
   Latenz), `positions.rule_id` (realisiertes P&L je Regel) und
   `audit_log`. Der Makro-Zyklus liest diese als „Marktrealität“ in seinen
   Prompt — das ist der Lern-Loop (§4).
3. **Mikro → Broker:** ausschließlich über die **Broker-Factory**
   (`src/brokers/factory.ts`, Task 02) — heute der in-process `PaperBroker`
   hinter `PaperBrokerAdapter`, später Venue-Adapter hinter demselben
   `BrokerAdapter`-Interface (Capability-Gating + Live-Gate, s. §10).

### Warum Redis/Event-Streaming nur optional ist

Best Practice für *sehr* viele Instanzen ist ein Pub/Sub (Redis
`PUBLISH rule-updated` oder Postgres `LISTEN/NOTIFY`), damit der
Cache-Invalidations-Lag von 30 s auf ~1 ms sinkt. Für ein lokales
Paper-System ist die DB selbst der Bus (eine Tabelle, ein Index) —
einfacher, ausfallender, auditierbar. Redis ist **kein Single Point of
Truth** für Regeln, nur ein Cache-Beschleuniger.

---

## 2. Regelformat & Persistierung

### 2.1 Schema (`trade_rules`)

```
id            uuid PK                ← eine Zeile = EINE unveränderliche Version
rule_key      uuid                   ← logische Regel-Identität (v1, v2, …)
version       int                    ← 1, 2, 3, …
status        DRAFT|ACTIVE|SUPERSEDED|PAUSED|ARCHIVED|REJECTED
symbol        text                   ← sanitized (A-Z0-9, max 12)
mission_id    uuid → missions
condition     jsonb                  ← RuleCondition  (Whitelist-DSL)
action        jsonb                  ← RuleAction     (hart geklemmt)
window        jsonb                  ← RuleWindow     (timeframe, cooldown, Fenster)
signature     text                   ← FNV-1a über symbol+condition+action (Idempotenz)
source_role   CEO|RESEARCH|MANUAL
source_mode   SIGMA|FALLBACK         ← LLM oder deterministischer Generat
previous_version_id / superseded_by_id  ← Versionskette (Rollback)
```

### 2.2 Bedingungs-DSL (serialisiert, nie ausführbar)

```json
{
  "logic": "all",
  "conditions": [
    { "field": "rsi14",        "op": "lt",    "value": 30 },
    { "field": "volumeRatio",  "op": "gt",    "value": 1.2 }
  ]
}
```

* **Felder (Whitelist):** `price, rsi14, ema9, ema21, ema50, trend,
  atrPct, volume, volumeMa20, volumeRatio, changePct24h,
  priceVsEma21Pct, priceVsEma50Pct`.
* **Operatoren:** `lt, lte, gt, gte, eq, between, in`.
* **Action:** `side` (nur `LONG`), `stopLossPct`, `takeProfitRR`,
  `riskBudgetPct`, `maxPositionPct` — jeder Wert wird gegen
  `RULE_CEILINGS` (abgeleitet aus `LIMIT_CEILINGS` der Guardrails)
  geklemmt. Eine Regel kann **nie mehr Risiko fordern als der Code.**

### 2.3 Validierung — die eigentliche Sicherheitsgrenze

`sanitizeRuleSpec()` ist ein **Normalisierer mit Whitelist**:

* unbekannte Keys (auch `__proto__`, `constructor`) werden verworfen,
* Felder werden case-insensitiv auf die Whitelist gemappt,
* Zahlen müssen endlich sein; Strings werden nie als Zahlen akzeptiert,
* Out-of-Bounds-Werte werden **geklemmt**, nicht abgelehnt (Fail-safe:
  eine zu aggressive Regel wird konservativ, nie „weicher“),
* ungültige Symbole/Operatoren/Seiten → harte Ablehnung (422).

Konsequenz: Auch ein **bösartig** prompt-injiziertes Research-Modell kann
nur einen Ausdruck aus der Whitelist erzeugen. „Code entscheidet“ bleibt
wahr.

### 2.4 Versionierung & Rollback

* **Aktivieren** (`POST /api/firm/rules/:id`, `action:activate`):
  Transaktion setzt alle anderen ACTIVE-Versionen desselben Symbols auf
  `SUPERSEDED` und die neue auf `ACTIVE` (+ `activatedAt`). Doppelte
  Aktivierung ist durch partielle UNIQUE-Indizes
  (`trade_rules_active_unique`, `trade_rules_active_symbol_unique`)
  **auf DB-Ebene atomar** — unabhängig von der Prozessanzahl.
* **Rollback** (`action:rollback`): Reihenfolge wird über
  `previous_version_id` zurückgespult; die alte Version wird wieder
  ACTIVE, die aktuelle SUPERSEDED. Jeder Schritt landet in `audit_log`
  (`RULE_ACTIVATED`, `RULE_ROLLED_BACK`, …).
* **Wie der Mikro-Executor „die aktuelle“ Version bekommt:** Er kennt
  Versionen gar nicht — er lädt `WHERE status='ACTIVE'`. Die DB-Wahrheit
  wandert per Poll/Invalidation in den RAM. Dadurch ist er nach einem
  Rollback automatisch wieder auf der alten Regel (spätestens nach
  `RULE_REFRESH_MS`, im selben Prozess sofort).

---

## 3. Mikro-Zyklus: Implementierung & Latenz

### 3.1 Event-Listener (Pseudocode = echter Code in `microExecutor.ts`)

```ts
feed.start((tick) => {                 // jeder WebSocket-Tick
  if (cache.candidatesBySymbol(tick.symbol).length === 0) return; // Zero-Cost-Tick
  const series = seriesFor(tick.symbol, rule.timeframe);
  series.touch(tick.price, tick.ts, tick.qty);   // RAM only
  const snap = series.snapshot();                // 10–100 µs
  const t0 = performance.now();
  const matched = cache.match(snap);             // kompilierte Closures
  const evalMicros = (performance.now() - t0) * 1000;
  for (const rule of matched) adapter.execute({ rule, snap, evalMicros });
});
```

### 3.2 Latenzbudget & Optimierungen (Sub-Millisekunde)

| Schritt | Kosten | Optimierung |
| --- | --- | --- |
| Tick-Delegation | < 1 µs | `candidatesBySymbol()` Map; ohne Regel: **kein weiterer Schritt** |
| Rolling-Serie | 5–50 µs | 1m-Buckets, finale Kerzen, History-Cap 160; Indikatoren aus ~100 Kerzen (kein Fetch) |
| Snapshot | 10–60 µs | EMA/RSI/ATR sind O(n), n ≤ 160; keine IO |
| Regel-Match | 0,5–2 µs/Regel | **Compile einmalig beim Cache-Load** → durchschnittlich null JSON-Parse im Tick |
| Fenster/Cooldown | < 0,1 µs | in-Memory `firedAt`, Tageszähler im RAM (DB nur beim Load) |
| **Summe (ohne Fill)** | **~20–100 µs** | gemessen & getestet (`tests/microExecutor.test.ts`, Grenze < 5 ms p95, real ~2 Magnituden darunter) |

Weitere Hebel (dokumentiert, nicht alle eingeschaltet):

* **Kein DB-Call im Tick** — die einzige DB-Berührung ist der Match
  (und das ist gewollt: der Fill ist der seltene Fall).
* **JIT-freundliche Closures** statt Interpreter; Feldzugriffe über
  switch-Accessoren, keine String-Property-Lookups.
* **Batching:** Trade-Streams auf 10–100 ms aggregieren, wenn die
  Bedingung ohnehin kerzenbasiert ist (beim reinen Preis-Trigger nicht).
* **Warm-Start:** REST-Seed beim Boot, damit Indikatoren sofort
  aussagekräftig sind (kein 25-Kerzen-Kaltstart).
* **Gültige Indikatoren nur bei Update:** RSI/EMA/Volumen-MA ändern sich
  pro Tick nur marginal; eine Cache-Generation pro (Symbol, Timeframe)
  reicht.

### 3.3 Rule-Caching

* In-Memory `Map<symbol, CachedRule[]>`; `CachedRule` enthält den **fertig
  kompilierten Evaluator** + `firedAt`/Cooldown + Tageszähler.
* Refresh: Poll `MICRO_RULE_REFRESH_MS` (Default 30 s) + `invalidate()`
  für Aktivierungen im selben Prozess.
* Fallback bei DB-Störung: **alte Regeln bleiben aktiv** (Fail-safe:
  weiterhandeln mit dem letzten bekannten Stand, nie „stumm abstürzen“),
  Fehler wird geloggt. Bei Kill-Switch zieht ohnehin die in-process Bremse.
* Redis wäre eine reine Invalidation-Beschleunigung (§1).

---

## 4. Fehlerbehandlung & Feedback-Loop

### 4.1 Ausführungsergebnisse

Der Adapter schreibt für **jeden** Match ein Ereignis:

* `TRIGGERED` — Fill-Details, Order-ID, Snapshot, ausgewertete
  Bedingungen, `latency_micros` (Bewertungszeit),
* `BLOCKED` — Grund (`KILL_SWITCH_ARMED`, `POSITION_ALREADY_OPEN`,
  `GUARDRAIL:…`, `MISSION_KILLED`, `MAX_EXECUTIONS`),
* `ERROR` — Ausnahme (defensiv, nie stillschweigend).

Positionen werden mit `rule_id` verknüpft → realisiertes P&L ist der
Regel direkt zurechenbar.

### 4.2 Wie der CEO lernt („Marktrealität“)

`ruleFeedback()` aggregiert je Regel: Trigger/Blöcke/Fehler (24 h),
geschlossene Trades, realisiertes P&L, Win-Rate. Der Makro-Zyklus gibt
diese Zahlen **in den Prompt** des Research- und CEO-Agenten:

```
Recent rule feedback (24h):
a1b2c3d4… ACTIVE: 24h 3T/1B, geschlossen 2, PnL +412.53, WinRate 0.5
```

Damit entsteht der echte Lern-Loop: **Regel → Execution → P&L → nächste
Regel** — ohne dass je ein LLM in der Ausführungskette hängt. Zusätzlich
landet das Ergebnis als `RECOMMENDATION`/`RULE_REVIEW` im
institutionellen Gedächtnis (`agent_messages`) mit Prompt/Raw-Trace für
spätere Analyse.

### 4.3 Fehlerverhalten

* **Feed weg:** exponentieller Reconnect (1 s → 30 s), Regeln bleiben
  geladen, keine Trades ohne Daten.
* **DB weg zur Laufzeit:** Executor läuft weiter (RAM-Cache), Match-Fill
  schlägt fehl → `ERROR` in Log + Feedback (beim nächsten DB-Zugriff).
* **Kill-Switch:** vor jedem Match in-process geprüft + im Lock nochmal
  aus der DB (frische Wahrheit bei mehreren Prozessen).
* **Doppel-Fill:** Advisory-Lock pro Symbol + Fresh-Read der offenen
  Position + `POSITION_ALREADY_OPEN`-Block.

---

## 5. Deployment & Skalierung

### 5.1 Unabhängige Deploys

```
Makro: Next.js-Dienst (systemd ai-trading-firm.service)
       + Scheduler-Takt MACRO_CYCLE_INTERVAL_MIN (Default 60 min)
Mikro: eigener Prozess (systemd micro-executor.service)
       `npm run micro` — kein Next.js, kein LLM-Code geladen
```

Beide teilen sich nur PostgreSQL. Der Mikro-Prozess kann auf dem
**gleichen** N150 laufen (er ist ~1 % CPU) oder auf einem eigenen
Rechner/Container neben der Datenquelle.

### 5.2 Horizontale Skalierung des Mikro-Zyklus ohne Regel-Konflikte

| Mechanismus | Wirkung |
| --- | --- |
| **Eine ACTIVE-Regel pro Symbol** | partieller UNIQUE-Index — konkurrierende Aktivierungen sind atomar |
| **Advisory-Lock `pg_advisory_lock('rule:'+symbol)`** | kritischer Abschnitt Check→Fill ist pro Symbol serialisiert — zwei Instanzen können denselben Trade nie doppelt eröffnen |
| **Positions-Sperre aus der DB** | `POSITION_ALREADY_OPEN` wird im Lock frisch geprüft, nicht aus dem RAM |
| **Shard-Key** | `MICRO_SYMBOLS=BTC,ETH` je Instanz — empfohlene Verteilung ohne Lock-Contention |

**Einschränkung ehrlich benannt:** Der interne `PaperBroker` ist ein
In-Memory-Ledger. Im Paper-Modus soll deshalb **genau eine**
Executor-Instanz laufen (Single-Writer) — die Guardrail- und
Sperrprimitive für Multi-Instanz sind bereits implementiert, aber erst ein
echter Broker-Adapter (Alpaca/ccxt, staatsextern) macht N-Instanzen zu
einem Normalbetrieb. Bis dahin: „1 Mikro-Instanz“ = korrekt und
ausdrücklich so dokumentiert.

### 5.3 Sizing

* Makro: 2 LLM-Calls/h (Research + CEO) — auf dem N150 sind das ~2 min
  Rechenzeit pro Stunde, Rest idle.
* Mikro: ein V8-Prozess, <100 MB RSS, <5 % eines Kerns (Feed + Indikatoren).
* DB: `rule_executions` schreibt nur bei **Matches** (Trigger/Block/Fehler),
  nie pro Tick — keine Write-Skalierungsfalle.

---

## 6. Konkretes, lauffähiges Beispiel

Siehe `scripts/micro-executor.ts` (Produktion) und
`tests/microExecutor.test.ts` (kommentiertes Minimalprogramm). Das
kompakte Kernstück:

```ts
// 1. Makro (LLM) erzeugt die Regel — 1×/h, dauert Minuten:
const spec = { symbol: "BTC",
  condition: { logic: "all", conditions: [
    { field: "rsi14", op: "lt", value: 30 },
    { field: "volumeRatio", op: "gt", value: 1.2 } ] },
  action: { side: "LONG", stopLossPct: 5, takeProfitRR: 1.5,
            riskBudgetPct: 0.02, maxPositionPct: 0.25 },
  window: { timeframe: "15m", maxExecutionsPerDay: 3,
            cooldownMinutes: 120, volumeWindow: 20 } };

// 2. Validieren & aktivieren (ohne LLM, ohne Pipeline):
const { spec: safe } = sanitizeRuleSpec(spec, "RESEARCH"); // Whitelist + Klemmung
await upsertRuleSpec(safe);                                 // DRAFT, versioniert
await activateRule(ruleId, "MACRO_CYCLE");                  // atomar, auditiert

// 3. Mikro (kein LLM): jeder WebSocket-Tick
feed.start((tick) => {
  series.touch(tick.price, tick.ts, tick.qty);
  const snap = series.snapshot();            // ~10–100 µs
  const matched = cache.match(snap);         // kompilierte Regeln, RAM only
  for (const rule of matched) adapter.execute({ rule, snap });
});
```

Start des Mikro-Executors:

```bash
npm run micro                    # Binance-Feed, Health auf :3380
MICRO_FEED=sim npm run micro     # Offline-Demo (deterministisch)
```

---

## 7. Testing & Security

### 7.1 Backtest vor Live

`POST /api/firm/rules/:id/backtest` simuliert die Regel deterministisch
über historische Kerzen (Signal am Kerzenschluss, Einstieg Schlusskurs,
Stop/Target, Stop-Vorrang bei Gleichzeitigkeit, Position-Sizing über
`riskAdjustedSize`). Ergebnis (Trades, P&L, Profit-Faktor, Max-Drawdown,
Exposure) wird in `rule_backtests` gespeichert.

**Freigabe-Reihenfolge (Empfehlung):** 1) Backtest > 60 Trades und
Profit-Faktor ≥ 1,1 → 2) 10–20 Paper-Durchläufe mit `REQUIRE_HUMAN_APPROVAL`
→ 3) Rollback-Regel dokumentieren → 4) erst dann automatisierte
Aktivierung. Kein Auto-Gate im Code — ein Mensch bleibt das Review-Gate.

### 7.2 Automatisierte Tests

* `tests/ruleEngine.test.ts` — Whitelist, Klemmung, Prototype-Pollution,
  Kompilierung, Snapshot-Determinismus, Signatur, Backtest-Szenarien.
* `tests/microExecutor.test.ts` — **Import-Graph-Guard** (kein
  `ollama`/`llmProvider`/`engine` im Mikro-Pfad), Rolling-Serie,
  Cooldown-/Tageslimit-Logik, End-to-End-Tick→Match→Adapter ohne DB,
  Latenz-Grenzen.
* Gesamtlauf: `npm test` (alle 181 Tests), `npm run typecheck`,
  `npm run lint`, `npm run build`.

### 7.3 Security-Audit & Peer-Review vor GitHub

1. **Dependency-Audit:** `npm audit` (aktuell: 0 Schwachstellen).
2. **Rule-Injection-Review:** jede Änderung an `sanitizeRuleSpec`,
   `RULE_FIELDS`, `RULE_CEILINGS`, `backtestRule` ist eine
   Sicherheitsgrenze → Peer-Review Pflicht; Tests decken jede neue
   Feld-/Op-Erweiterung ab.
3. **Prompt-Injection-Rehearsal:** Research/CEO-Prompts behandeln
   Marktdaten als DATA; News/Headlines der Analysten bekommen die
   Anti-Injection-Zeile. Regel-Entwürfe, die „NO TRADE TODAY“ oder
   nicht-feuernde Bedingungen enthalten (z. B. `rsi14 < 0`), sind das
   dokumentierte Sicherheitsmuster.
4. **DB-Angriffsfläche:** Regeln sind **JSON-Werte**, die nur der
   Whitelist-Parser interpretiert — kein `eval`, kein dynamischer SQL.
   `symbol` wird gegen die Symbol-Regex geprüft.
5. **Multi-Instance-Audit:** Advisory-Lock- & UNIQUE-Index-Tests vor
   jedem horizontalen Ausbau.
6. **GitHub-Hygiene:** Secrets nie committen (`FIRM_API_TOKEN`,
   `DATABASE_URL`); `.env` ist in `.gitignore`; PRs mit Test-Lauf +
   `npm audit` im Checklisten-Header.

### 7.4 Fehlerhafte/bösartige Regeln in Produktion verhindern

| Schicht | Mechanismus |
| --- | --- |
| Erzeugung | Whitelist-DSL, Klemmung, Risk-Gate (Score ≤ 0,9), CEO-Review |
| Persistenz | nur über `upsertRuleSpec` (normalisiert); kein Direkt-UPDATE möglich ohne API-Gate |
| Aktivierung | explizit (menschlich oder `REQUIRE_HUMAN_APPROVAL`), auditiert, versioniert, Rollback-fähig |
| Ausführung | kompilierte Closures auf Zahlen — keine dynamische Codeausführung |
| Broker | Guardrails + Kill-Switch als letzte Instanz — eine Regel kann nie über die Code-Limits hinaus |

---

## 8. Adaptives Risk-Limit (v1.7.0): volatilitätsgetriebene Limit-Anpassung

### 8.1 Problem

`maxRiskPerTrade` war ein statischer Wert (2 %). In hochvolatilen Phasen
(VIX-Spike, Bandbreiten-Expansion) trägt dieselbe Prozentzahl ein deutlich
größeres absolutes Risiko. Die Anpassung musste vor jeder Re-Deployment
manuell passieren — zu langsam und unsichtbar für die Agenten.

### 8.2 Kaskade (Sandbox-Prinzip bleibt intact)

```
LIMIT_CEILINGS (hartkodiert, Rebuild)          ← absolutes Fenster [0.002 … 0.05]
   └─ risk_config.maxRiskPerTrade (Basis)      ← Operator, Laufzeit, geklemmt
        └─ adaptiver Faktor (adaptiveRisk.ts)  ← Markt, automatisch, ∈ (0,1]
             → getLimits().maxRiskPerTrade     ← alle Order-Pfade (Engine,
                                                   Mikro-Executor, Sizing)
```

Wichtige Invarianten (je eine Regressionstest-Gruppe):

- **Nur senkend:** der Faktor wird auf (0, 1] geklemmt — Marktzustand kann
  das Limit nie über das konfigurierte Basis-Limit anheben.
- **Keine Kumulation:** Basis und Faktor sind getrennt gespeichert
  (`baseLimits` vs. `adaptiveState`); jede DB-Neuladung rechnet
  Basis × Faktor, nie reduzierte-Werte × Faktor.
- **Fail-Open bei Datenfehlern:** Indikator ohne Daten triggert nie; bei
  Gesamtfehlern bleibt der zuletzt wirksame Zustand (Risiko kann weder
  wachsen noch „kaputt“ werden).
- **Code-Boden gewinnt:** `maxRiskPerTrade` unterläuft nie
  `LIMIT_CEILINGS.maxRiskPerTrade[0]` (0.002).

### 8.3 Datenfluss pro Bewertung (≈60 s, Monitor-Tick)

```
Yahoo ^VIX (5-Min-Cache, 2 Hosts, stale-Fallback)
Binance/Yahoo 15-min-Kerzen: SPY, QQQ, BTC  → ATR(14), BBW(20,2σ), Return-StdDev(20)
        │  Korb-Indikatoren: Spitzenwert (max) über den Korb
        ▼
assessRegime(readings, cfg)            ← reine Funktion, unit-getestet
        │  NORMAL | ELEVATED | EXTREME (deterministische Matrix, s. 8.4)
        ▼
RegimeStateMachine.update(candidate)   ← Hysterese: Eskalation sofort,
        │                                  De-Eskalation nach N ruhigen Ticks
        ▼
riskGuard.applyAdaptiveRisk(state)     ← currentLimits = base × factor (geklemmt)
        ▼
Event (Ring-Buffer 50) + audit_log RISK_ADAPTIVE + Persistenz adp.activeFactor/At
```

Einträge in `runAgentTurn` halten den Zustand frische
(`ensureAdaptiveRiskFresh`, Single-Flight, Min-Interval 45 s) und legen die
Schicht „ADAPTIVES-RISIKO“ in den Turn-Trace.

### 8.4 Regime-Matrix (Defaults)

| VIX | ATR>1 % | BBW>5 % | StdDev>1 % | Regime | Faktor |
| --- | --- | --- | --- | --- | --- |
| < 30 | 0–1 triggern | … | … | NORMAL | 1.0 |
| < 30 | ≥ 1 triggert | | | ELEVATED | 0.5 |
| < 30 | 3 triggern | | | EXTREME | 0.25 |
| ≥ 30 | 0 | | | ELEVATED | 0.5 |
| ≥ 30 | ≥ 1 | | | EXTREME (belegt) | 0.25 |
| ≥ 40 | egal | | | EXTREME (direkt) | 0.25 |

Alle Schwellwerte/Faktoren = `adp.*` in `risk_config`, geklemmt gegen
`VOLATILITY_CONFIG_BOUNDS`, änderbar via Dashboard/`PUT /api/firm/config`
— Neubewertung erfolgt automatisch (nächster Tick) bzw. sofort per
`POST /api/firm/risk/volatility`.

### 8.5 Multi-Prozess & Observability

- **Mikro-Executor (`npm run micro`):** konsumiert den persistierten Faktor
  (`adp.activeFactor` + `adp.activeAt`, Frischegrenze 15 min) — bleibt damit
  LLM- und netzwerk-frei.
- **API:** `GET /api/firm/risk/volatility` (Regime, Basis/effectives Limit,
  Faktor, Indikatorwerte mit Schwellen/Trigger-Status, Event-Ring-Buffer,
  Config + Bounds, `lastUpdate`/`lastChange`/`stale`),
  `POST …/risk/volatility` (Forced-Update), `GET /api/firm → adaptiveRisk`.
- **Persistenz:** `audit_log`-Events `RISK_ADAPTIVE` (dauerhaft) neben dem
  In-Memory-Buffer (50 Events, prozesslokal).

---

## 9. Market Universe: vom Broker zur Agenten-Analyse (v1.8.0, Task 01)

Bis v1.7 war die **Watchlist** (`DEFAULT_WATCHLIST`, 9 Strings in
`src/lib/marketData.ts`) die faktische Marktdefinition. Ab Task 01 ist die
**Instrument-Registry** (`src/universe/`) die Quelle der Wahrheit; die
Watchlist ist zu einer reinen UI-Präferenz mit Referenzen auf Instrument-IDs
degradiert.

### 9.1 Die Universum-Pipeline

```
┌───────────┐   Instrumentenlisten (REST/CSV, ausserhalb des Kerns)
│  BROKER   │   BINANCE · KRAKEN · ALPACA · IBKR · DYDX · BITUNIX · PAPER
└─────┬─────┘
      │  roh, venue-nativ ("btcusdt", "BTC/USD", "SPY", "EURUSD=X")
      ▼
┌──────────────────────┐  Adapter je Venue (Task 2+): holen, mappen, batchen
│ INSTRUMENT DISCOVERY │  ── einziger Ort mit Netzwerkzugriff ──
└─────────┬────────────┘
          │  InstrumentInput[]  (upsertMany, max. 5000/Batch)
          ▼
┌──────────────────────────────────────────────────────────────────────┐
│ INSTRUMENT REGISTRY   src/universe/   deterministisch · kein LLM     │
│   Normalisierung  →  Validierung  →  Ausschluss-Policy  →  Upsert    │
│   ID = VENUE:SYMBOL · stabile Sortierung · NDJSON-Persistenz         │
│   jede Mutation → audit_log (actor=system, source, changed, ts)      │
└─────────┬────────────────────────────────────────────────────────────┘
          │  query({ status, venue, assetClass, … })
          ▼
┌──────────────────┐   volume24h, spread  → dünne Märkte raus
│ LIQUIDITY FILTER │   (Task 2+; Metriken sind hier initial null)
└─────────┬────────┘
          ▼
┌───────────────────┐  status=active · paperAvailable/liveAvailable ·
│ TRADABILITY FILTER│  minQuantity/priceStep gegen Kontogröße
└─────────┬─────────┘
          ▼
┌──────────────┐  volatility · Hebel/Short-Flags · Klumpenrisiko je Underlying
│ RISK FILTER  │  (riskGuard.ts bleibt die harte Schranke im Code)
└─────────┬────┘
          ▼
┌────────────────┐  Score aus Liquidität, Kosten (maker/taker + spread),
│ MARKET RANKING │  Volatilität und Trendqualität
└─────────┬──────┘
          ▼
┌────────────────────────┐  Top-N je Anlageklasse, versioniert und auditiert
│ DAILY / WEEKLY UNIVERSE│  = das, worauf die Firma an diesem Tag schaut
└─────────┬──────────────┘
          ▼
┌────────────────┐  CEO/Research (Makro-Zyklus) bekommen Instrument-IDs,
│ AGENT ANALYSIS │  keine losen Strings — Regeln referenzieren VENUE:SYMBOL
└────────────────┘
```

Umgesetzt in Task 01 sind **Registry** (inkl. Normalisierung, Policy,
Persistenz, Audit) und die Lesepfade `GET /api/markets` sowie
`GET /api/markets/{venue}/{symbol}`. Discovery, die Filterstufen, Ranking und
die Tages-/Wochen-Auswahl sind vorbereitet (Contract + Metrikfelder), aber
bewusst noch nicht implementiert — sie sind eigene Tasks.

### 9.2 Symbol ≠ Markt

```
Underlying  BTC ─┬─ Asset BTC ─┬─ BINANCE:BTCUSDT   spot        (Gebühren, Ticks je Venue)
                 │             ├─ KRAKEN:BTC/USD    spot
                 │             └─ BITUNIX:BTCUSDT   perpetual   (Funding, Liquidation)
```

Drei handelbare Instrumente, ein Asset, ein ökonomisches Underlying. Der
Risk-Layer muss deshalb pro **Underlying** aggregieren, nicht pro Symbol —
sonst wird dreifach dieselbe Wette eröffnet.

### 9.3 Einordnung in die bestehende Architektur

| Ebene | Kennt das Universum als | Kopplung |
| --- | --- | --- |
| Discovery-Adapter (Task 2+) | Schreibpfad (`upsertMany`) | einziger Netzwerkzugriff |
| Registry (`src/universe/`) | Wahrheit | keine DB-Pflicht, keine LLM, kein Netz |
| Makro-Zyklus (CEO/Research) | Kandidatenliste je Zyklus | liest über `query()` |
| Mikro-Executor | Handelsbedingungen (Ticks, Mindestmengen) | RAM-Cache, kein Hot-Path-IO |
| Dashboard/Operations Center | `GET /api/markets` + `docs/help/market-universe.help.json` | rein lesend |

Details, Feldkatalog und API-Beispiele: **[MARKET_UNIVERSE.md](MARKET_UNIVERSE.md)**.

---

## 10. Broker Capability-Modell (v1.10.0, Task 02)

Die Plattform ist von einer statischen Paper-Broker-Architektur zu einer
broker-unabhängigen Infrastruktur umgebaut: `BROKER_REGISTRY` war reine
Capability-Dokumentation, `getBroker()` erzeugte ausnahmslos einen
`PaperBroker`. Seit Task 02 ist das Capability-Modell **ausführbar** —
ohne Live-Trading zu aktivieren.

### 10.1 Schichten

```
Kern (engine, risk, agents, API)
  │  kennt NUR das Interface
  ▼
BrokerAdapter  (src/contracts/broker.ts)     ← Contracts + Fehlerklassen
  │  Factory = einziger Erzeugungspunkt
  ▼
getBroker(venue, mode)  (src/brokers/factory.ts)
  │  1. Whitelist → 2. Live-Gate (IMMER LGTE) → 3. Capability-Gating → 4. Cache
  ▼
PAPER-Adapter (voll) · BITUNIX (Public REST/WS + Paper, Live gesperrt) · ALPACA/IBKR/BINANCE/KRAKEN/DYDX (sichere Stubs)
  │  delegiert
  ▼
PaperBroker + marketData + Universe-Registry   (bestehende Bestandteile)
```

### 10.2 Execution Modes (erstklassiges Konzept)

| Modus | Kurs | Order |
| --- | --- | --- |
| `backtest` | historisch | simuliert |
| `paper` | real | simuliert |
| `testnet` | real (Testnet) | Broker-Order |
| `live` | real | reale Order — **hart gesperrt** (`LiveTradingGateError`, bis Live-Gate-Task) |

Gating: `backtest`/`paper` → Capability `paper`, `testnet` → `testnet`,
`live` → immer `LiveTradingGateError` (vor jeder Capability-Prüfung).
Niemals stiller Fallback — jede Abweisung ist ein lauter, auditierter Fehler.

### 10.3 Capability-Single-Source-of-Truth & Registry-Projektion

`VENUE_CAPABILITIES` (src/brokers/capabilities.ts) ist die Wahrheit; die
Adapter deklariert sie, die Factory gated nach ihr, und `BROKER_REGISTRY`
projiziert `paperAvailable`/`liveAvailable` daraus (`projectCapabilityFlags`).
Venue-Angebote (z. B. „Binance: Testnet vorhanden“) bleiben Doku-Felder —
keine zweite Quelle. Capability-Matrix (Ist/Soll) und `stopAtVenue`
(Ausbaupfad Bitunix): **[BROKER_ARCHITECTURE.md](BROKER_ARCHITECTURE.md)**.

### 10.4 Audit & API

* Jeder Factory-Aufruf mit `mode != "paper"` → `audit_log` (Event
  `BROKER_FACTORY`) + In-Memory-Ring (best-effort DB, Fail-Safe).
* `GET /api/brokers` (Übersicht: id, capabilities, Health, projizierte
  Flags) und `GET /api/brokers/{venue}/health` (read-only; Remote-Check nur
  mit `BROKER_HEALTHCHECK_REMOTE=true`, Default OFF, credential-frei).

### 10.5 Paper-Modi & Market-Data-Layer (v1.11.0, Task 03)

Die Execution-Mode-Tabelle oben wird durch die **Paper-Modi** des
Market-Data-Layers verdrahtet (`paperMode`, siehe
**[PAPER_TRADING.md](PAPER_TRADING.md)**):

| Execution-Modus | Paper-Mode (`paperMode`) | Kursquelle | Order |
| --- | --- | --- | --- |
| `backtest` | `synthetic`/Replay | **Historical Store** (`ReplayFeed`) | simuliert (deterministisch) |
| `paper` (Default) | `broker-market-data` (Default) | echte Venue-Marktdaten (Broker-Feed → Binance/Yahoo) | simuliert (deterministischer Fill-Simulator) |
| `paper` (optional) | `synthetic` | Synthetic-Feed (seeded) | simuliert |
| `paper` (Capability-gated) | `broker-paper-api` | Venue-Paper-/Testnet-API | **Broker-Paper-API** |
| `testnet` | — | real (Testnet) | Broker-Order |
| `live` | — | real | reale Order — **hart gesperrt** |

Die Market-Data-Schicht (`src/lib/marketdata/`) ist rein deterministisch (kein
LLM): Feeds → Normalisierung (`MarketSnapshot` mit Bid/Ask/Last + Provenienz,
Anomalie-Erkennung) → Historical Store (append-only OHLCV-NDJSON) →
Screener/Agents → Paper-Broker → **simulierter Fill**. Failover:
Broker-Feed → unabhängiger Feed → Synthetic (nur explizit); jeder Wechsel und
jede verworfene Anomalie → `audit_log` (`FEED_FAILOVER`/`ANOMALOUS_SNAPSHOT`).
Der `PaperBroker`-Ledger nutzt einen Ausführungs-Adapter (echte Kurse +
deterministischer Simulator mit Gebühren/Spread/Slippage/Latenz/Partial Fills).
Statisches Preisbuch nur noch hinter `PAPER_STATIC_FALLBACK=true` (Default aus).
Neue read-only-Endpunkte: `GET /api/marketdata/snapshot?instrument=…` und
`GET /api/marketdata/status`.

---

## 11. Operations Center: Aggregationsschicht (v1.23.0, Task 10)

Das Operations Center ist die **Control Plane** des Systems — kein eigenes
Fachmodul. Es führt vorhandene Module in einer read-only Sicht zusammen:

```
GET /api/ops
   └─ src/ops/index.ts            buildOperationsCenter(actor)
        ├─ src/ops/collect.ts     zehn Kollektoren, parallel, fail-soft
        │    ├─ src/universe        Market Universe
        │    ├─ src/scanner         Scanner
        │    ├─ Datenbank           Portfolio Analytics / Agent Operations / Audit
        │    ├─ src/cycle           Research Operations
        │    ├─ src/brokers         Broker Operations
        │    ├─ src/routing         LLM Operations
        │    ├─ riskGuard/adaptive  Risk
        │    └─ docs/help           Help
        └─ src/auth/ops.ts        Katalog + Rolle + Live-Gate-Projektion
```

**Regeln:**

1. **Keine zweite Fachlogik.** Gewichte, Scores, Limits und Kennzahlen werden
   weiterhin in ihren Modulen berechnet. Das Cockpit zeigt nur Ergebnisse.
2. **Kein Schreibpfad.** Kein Order-, Credential- oder Mutations-Aufruf.
3. **Fail-soft, nie fail-open.** Ist eine Quelle nicht lesbar, wird nur ihre
   Sektion `unavailable` (mit redigierter Meldung). Es gibt keinen
   Platzhalter-Zustand: `ready | degraded | empty | locked | unavailable`.
4. **Broker-Status getrennt.** Das Cockpit zeigt Capabilities und lokalen
   Health in Papier-Ausführung. Credentials, Verbindungszustand und
   Live-Freigabe bleiben im Broker-Tab (Control Plane).
5. **Live bleibt zu.** `liveEnabled` ist die Projektion des Live-Gate-Enforcers
   über alle Venues — im Auslieferungszustand `false`.

---

## 12. Glossar (Kurz)

| Begriff | Bedeutung |
| --- | --- |
| Makro-Zyklus | CEO/Research, LLM, 1×/h, schreibt `trade_rules` |
| Mikro-Zyklus | Executor ohne LLM, pro Tick, liest ACTIVE-Regeln aus dem RAM |
| RuleKey/Version | logische Regel & unveränderliche Version für Rollback |
| RuleCache | kompilierte ACTIVE-Regeln im RAM |
| Rolling-Serie | in-Memory-Kerzen (1m-Aggregation) für Indikatoren |
| `latency_micros` | Bewertungszeit des Hot-Paths (ohne Fill) |
| Feedback-Loop | `rule_executions` + `positions.rule_id` → CEO-Prompt |
| Adaptiver Faktor | ∈ (0,1]-Multiplikator auf `maxRiskPerTrade` (NUR senkend), aus dem Volatilitäts-Regime |
| Regime (NORMAL/ELEVATED/EXTREME) | Klassifizierung der Marktvolatilität (VIX/ATR/BBW/StdDev) |
| Hysterese / Anti-Flapping | Eskalation sofort, De-Eskalation erst nach N ruhigen Ticks |
| Fail-Open (Daten) | Indikator ohne Daten triggert nie — Risiko kann nie steigen |
| Instrument | handelbarer Kontrakt an genau einer Venue, ID `VENUE:SYMBOL` |
| Asset | venue-unabhängiger Ticker (z. B. `BTC`) |
| Underlying | ökonomische Exposure hinter einem Instrument — Aggregationsebene für Klumpenrisiko |
| Registry | deterministischer Speicher aller Instrumente (`src/universe/`, NDJSON) |
| `BrokerAdapter` | venue-unabhängiges Interface der Broker-Schicht (Task 02) — die einzige Grenze zwischen Kern und Markt |
| `ExecutionMode` | `backtest`/`paper`/`testnet`/`live` mit fester Semantik (Kurs × Order) |
| Capability-Gating | Modus-Prüfung der Factory: `backtest`/`paper`→`paper`, `testnet`→`testnet`, `live`→hartes Gate |
| `LiveTradingGateError` | permanente Sperre des Live-Pfads bis zum Live-Gate-Task — kein stiller Fallback |
| Capability-Projektion | Registry-Flags `paperAvailable`/`liveAvailable` = Ableitung der Adapter-Capabilities (SSoT = Adapter) |

---

## 13. Wie Docs hier gepflegt werden (Docs-as-Code)

Dieser Abschnitt ist die **verbindliche Pflege-Anleitung** für alle Markdown-
Dateien in `docs/` (Task 12). Sie gelten für jede zukünftige Änderung.

### Grundsatz: Docs und Code im selben PR

Docs und Code werden **nie getrennt gemergt**. Jeder PR, der Verhalten ändert,
ändert im selben PR die betroffenen Docs (`docs/*.md`), Hilfe-Dateien
(`docs/help/*.help.json`) und — bei Verhaltens-Änderungen — den Changelog
(`docs/CHANGELOG.md`).

### Docs-as-Code-Regeln

1. **Jede Behauptung ist gegen den Code verifiziert** (Datei/Zeile/Contract).
   Unverifizierbares wird als **„Geplant (Task NN)“** markiert, nie erfunden.
2. **Keine Secrets**: keine API-Keys, Tokens, Zugangsdaten, internen Hostnamen,
   personenbezogenen Daten in Docs. Sicherheitsdokumente beschreiben
   **Mechanismen**, niemals Zugangsdaten.
3. **Status-Header-Pflicht**: Jede Doc trägt oben einen Status-Header
   (`Implementiert` / `Teilweise` / `Geplant` + zugehöriger Task). Nichts
   Unimplementiertes wird als fertig beschrieben.
4. **Terminologie-Konsistenz**: Fachbegriffe gemäß Glossar in [§12](#12-glossar-kurz)
   (Asset vs. Instrument vs. Underlying; Execution Modes `backtest/paper/testnet/live`;
   Paper-Modi A/B/C; Modell-Klassen `small/medium/large`; Live-State-Namen).

### Hilfe-Systematik (3-Ebenen)

Jede `docs/help/*.help.json` folgt dem Schema `docs/help/help.schema.json` mit
den Pflicht-Ebenen `{ kurzinfo, technischeInfo, risiko }`. Neue Fachbegriffe
werden nur mit allen drei Ebenen aufgenommen.

### CI-Job `docs-validate`

Der Job `docs-validate` (`docs/ci/docs-validate.workflow.yml`, Skript
`scripts/docs-validate.ts`, `npm run docs:validate`) erzwingt: Hilfe-Schema,
relativer Link-Check (0 tote Links), Markdown-Lint, Secret-Scan über Docs und
Konsistenz-Checks (Env-Flags in INSTALL.md == Code; API-Routen in Docs == Code;
Live-State-Namen == Code-Enum). Er ist merge-blockierend in der
Branch-Protection zu hinterlegen.
