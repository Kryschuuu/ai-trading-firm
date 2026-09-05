# Peer-Review: Live-/Paper-Trading-Readiness der AI-Trading-Firm

**Datum:** 2026-08-26  
**Reviewer-Rolle:** Senior Backend Engineer — verteilte Systeme & Fintech-Infrastruktur  
**Scope:** vollständiger Code- und Architektur-Review des Repository-Stands auf Branch `arena/01a03d80-ai-trading-firm`, mit Fokus auf die sequenzielle 6-Agenten-Pipeline, Latenz, Paper-Trading-Korrektheit und spätere Live-Trading-Fähigkeit.

---

## Executive Summary

Die ursprüngliche lineare Pipeline `CEO → Research → Backtest → Risk → Approver → Executor` ist für Live-Märkte **nicht geeignet**. Ein Durchlauf von 2–6 Minuten erzeugt eine kausale Lücke: Der Executor handelt auf einem Markt, der mit dem Analysezeitpunkt des Research-Agenten nicht mehr identisch ist. Diese Pipeline darf daher nur als **Workshop-, Audit- oder langsamer Strategiepfad** verstanden werden.

Der aktuelle Codebase enthält jedoch bereits eine deutlich bessere Zielarchitektur: `macroCycle.ts`, `ruleEngine.ts`, `ruleService.ts` und `microExecutor.ts` trennen langsame LLM-Entscheidung von schneller Tick-Ausführung. Die richtige Produktionsrichtung ist damit nicht, die 6 Agenten nur schneller nacheinander aufzurufen, sondern die LLMs in einen asynchronen **Makro-Zyklus** zu verschieben und den Executor als LLM-freien **Mikro-Zyklus** auf kompilierte Regeln im RAM handeln zu lassen.

**Wichtigste Findings:**

1. **Live-Trading-Bottleneck:** Der Legacy-Endpunkt `POST /api/firm/run` mit `pipeline=true` führt weiterhin alle Agenten sequenziell aus. Das ist bewusst nachvollziehbar für Demo/Workshop, aber nicht live-ready.
2. **Starker Architekturanker vorhanden:** `microExecutor.ts` erfüllt die entscheidende Live-Anforderung: Hot-Path ohne LLM, ohne DB-Read pro Tick, mit `RuleCache`, Rolling-Kerzen und Advisory-Lock im Fill-Pfad.
3. **Größtes Paper-Trading-Risiko außerhalb des Mikro-Pfads:** `runAgentTurn()`/Legacy-Engine nutzt einen in-process `PaperBroker` ohne DB-Advisory-Lock um den Check→Insert-Abschnitt. Mehrere parallele Einzel-Agenten-Requests oder mehrere Next.js-Instanzen können im Legacy-Pfad doppelte Orders erzeugen. Der Mikro-Pfad ist hier besser abgesichert.
4. **Beobachtbarkeit ist gut, aber nicht vollständig:** Audit-Log, Agent-Messages, Rule-Executions und Latenz-Metriken existieren. Für Production fehlen noch strukturierte Korrelations-IDs, p95/p99-End-to-End-Metriken über Agenten- und Broker-Grenzen sowie persistente BLOCKED/ERROR-Events für jeden Mikro-Match.
5. **Testlage solide für Core-Logik:** Nach `npm ci` bestehen `npm test` mit 181/181 Tests, `npm run typecheck`, `npm run lint` und `npm run build`. Es fehlen noch Multi-Process-Concurrency-, DB-Lock-, Feed-Reconnect- und Latenz-Budget-Integrationstests.

**Empfehlung:** Die klassische 6-Agenten-Pipeline im UI klar als „nicht livefähig“ markieren, den Makro/Mikro-Pfad zum Default machen, den Legacy-Orderpfad mit denselben DB-Locks wie den Mikro-Executor härten und danach Pub/Sub-Invalidation sowie eine echte Broker-Adapter-Abstraktion ergänzen.

---

## 1. Architektur-Analyse der aktuellen Pipeline

### 1.1 Ist-Zustand: zwei Pfade im Codebase

| Pfad | Dateien | Charakter | Live-Readiness |
| --- | --- | --- | --- |
| Legacy-Agentenpipeline | `src/lib/engine.ts`, `src/app/api/firm/run/route.ts` | Sequenziell, pro Agent LLM/LocalReason, synchroner Request | **Nicht live-ready**; nur Workshop/Paper/Strategie-Review |
| Makro/Mikro-Architektur | `src/lib/macroCycle.ts`, `src/lib/ruleEngine.ts`, `src/lib/ruleService.ts`, `src/lib/microExecutor.ts`, `scripts/micro-executor.ts` | Langsamer LLM-Makrozyklus erzeugt Regeln; schneller LLM-freier Tick-Executor handelt Regeln | **Richtiger Zielpfad** für effizientes Paper-Trading und spätere Live-Anbindung |

Die 6-Agenten-Pipeline existiert weiterhin in `runPipeline()`:

```ts
const order = ["CEO", "RESEARCH", "BACKTEST", "RISK_MANAGER", "APPROVER", "EXECUTOR"];
for (const agent of sorted) {
  if (killSwitch.isArmed()) break;
  const result = await runAgentTurn(agent.id, missionId);
  results.push({ agent: agent.name, role: agent.role, result });
  if (result.status === "EXECUTED" || result.status === "KILLED") break;
}
```

Dieser Code ist korrekt als Single-Flight-Workshop-Pipeline, aber die Latenz addiert sich strukturell:

```text
T_total = T_ceo + T_research + T_backtest + T_risk + T_approver + T_executor + IO + DB + MarketData
```

Bei lokalen kleinen Modellen auf N150 liegt das realistisch bei Minuten. Live-Marktpreise sind danach veraltet.

### 1.2 Bottlenecks zwischen den sechs Agenten

| Übergang | Aktuelles Verhalten | Bottleneck | Sequenziell nötig? | Parallelisierbar/asynchron? |
| --- | --- | --- | --- | --- |
| CEO → Research | CEO erzeugt/kontextualisiert Mission, danach Research | LLM-Latenz + wiederholter DB-/Marktdatenkontext | Teilweise: Ziel/Mission muss bekannt sein | Research kann für bestehende Missionen kontinuierlich vorlaufen; CEO muss nicht jeden Tick blockieren |
| Research → Backtest | Research-These wird danach geprüft | Backtest wartet auf Research-Text statt auf Regel-Spec | Nur für neue konkrete Regelversion | Backtest kann asynchron auf Regelentwürfen laufen; mehrere Kandidaten parallel |
| Backtest → Risk | Risk bewertet nach Backtest | DB-/Compute-Latenz; Risk ist deterministisch gut abbildbar | Nur finaler Gate-Entscheid sequenziell | Risk-Scoring kann direkt bei Regel-Sanitizing passieren und parallel zu Backtest-Metriken vorberechnet werden |
| Risk → Approver | Approver prüft nach Risk | Mensch/LLM im kritischen Pfad | Für Echtgeld-Gate ja; für Tick-Ausführung nein | Approver muss vor Aktivierung einer Regel laufen, nicht vor jedem Trade |
| Approver → Executor | Executor handelt nach vollständiger Agentenkette | Größte Marktpreis-Alterung | Für Legacy-Demo ja | Live: Executor darf nur gegen aktuelle Ticks und bereits aktive Regeln handeln |
| Executor → Broker/DB | Legacy-Broker in-process, DB-Insert nach Fill | Race-Risiko bei parallelen Next-Instanzen | Check→Fill→Persist muss atomar/serialisiert sein | Nur pro Symbol sequenziell; verschiedene Symbole parallel |

### 1.3 Was wirklich sequenziell bleiben muss

Sequenziell bleiben müssen nur Kausalitätsgrenzen, nicht Agentenrollen:

1. **Regelversionierung:** Regelentwurf → Sanitizing → Risk-Gate → Aktivierung muss in geordneter Reihenfolge laufen.
2. **Symbol-kritischer Fill:** Für ein Symbol muss `open position? → risk check → broker order → DB persist` serialisiert sein.
3. **Rollback/Aktivierung:** Eine ACTIVE-Regel pro Symbol muss atomar durch DB-Constraints/Transaktion sichergestellt bleiben.
4. **Kill-Switch:** Kill-Switch-Status muss vor Orderausführung frisch geprüft werden.

Nicht sequenziell sein müssen:

- Research für mehrere Symbole/Missionen.
- Backtests mehrerer Regelkandidaten.
- News-/SEC-/Market-Data-Fetches.
- Risk-Scoring und Sanitizing vieler Kandidaten.
- Human/LLM-Approval vor **Regelaktivierung**, nicht vor jedem Tick.

---

## 2. Live-Trading-Readiness und konkrete Verbesserungen

### 2.1 Zielarchitektur: LLM aus dem Tick-Pfad entfernen

Der Codebase beschreibt dies in `docs/ARCHITECTURE.md` bereits richtig:

```text
Makro: CEO/Research erzeugen langsam validierte trade_rules.
Mikro: Tick → RollingTimeframeSeries → RuleSnapshot → RuleCache.match() → Adapter.execute().
```

Das ist der entscheidende Wechsel:

- LLM-Latenz wird nicht optimiert, sondern aus der Ausführung entfernt.
- Der Executor handelt nur noch vorkompilierte, versionierte, getestete Regeln.
- Die Marktrealität kommt als Feedback über `rule_executions` und `positions.rule_id` zurück in den nächsten Makro-Zyklus.

### 2.2 Parallelisierungsmöglichkeiten

| Bereich | Empfehlung | Erwarteter Effekt |
| --- | --- | --- |
| Research | Research-Agenten pro Symbol/Mission in Worker-Pool oder Job-Queue parallelisieren | Makro-Laufzeit sinkt bei mehreren Märkten linear mit Worker-Anzahl |
| Backtest | Backtests als async Jobs pro Regelkandidat; Ergebnisse in `rule_backtests` speichern | Kein Blockieren von CEO/Approver; UI kann Polling/Status anzeigen |
| Risk | Deterministische Risk-Checks direkt in `sanitizeRuleSpec()`/`riskGateRule()` ausführen; LLM-Risk nur erklärend | Millisekunden statt LLM-Sekunden im Gate |
| Approval | Approval auf Regelaktivierung verschieben; Approver nicht im Tick-Pfad | Kein menschlicher/LLM-Block pro Trade |
| Market Data | `getCandles`, News und SEC-Fetches per Cache und paralleler Promise-Gruppe pro Makrozyklus | Weniger wiederholte API-Latenz pro Agent |
| Multi-Symbol Execution | Mikro-Executor pro Symbol-Shard (`MICRO_SYMBOLS`) oder mehrere Instanzen | Horizontale Skalierung ohne Lock-Contention |

### 2.3 Agenten cachen/poolen

1. **LLM-Modelle warm halten:** Ollama `keep_alive` ist bereits über Provider-Konfiguration vorgesehen. Für lokale Modelle sollte `OLLAMA_KEEP_ALIVE` produktiv gesetzt werden, damit Agenten nicht kalt starten.
2. **Agent-Kontext cachen:** `runAgentTurn()` baut pro Agent Market-/KPI-/House-Kontext neu. In der Legacy-Pipeline sollte ein `PipelineContext` pro Mission erzeugt und an alle Agenten übergeben werden.
3. **Provider-Clients poolen:** Die Provider-Clients sind leichtgewichtig, aber Modelllisten werden bereits gecacht. Für hohe Frequenz sollte `chatLlm()` pro Provider einen langlebigen Client/HTTP-Agent nutzen.
4. **Backtest-Resultate cachen:** Hash aus `rule.signature + candle-range + backtest-version`; unveränderte Regel nicht erneut testen.
5. **Research-Daten cachen:** Candle-/News-/SEC-Daten mit TTL und Source-Timestamp statt pro Agent abrufen.

### 2.4 Synchrone vs. asynchrone Kommunikation

| Kommunikation | Heute | Empfehlung |
| --- | --- | --- |
| UI → Legacy-Pipeline | synchroner HTTP-Request bis Pipeline fertig | Nur Workshop. Für produktive Läufe: Job anlegen und Status streamen/pollen |
| Makro → Mikro | DB-Polling von ACTIVE-Regeln | Für lokal ok; für Cluster zusätzlich Postgres `LISTEN/NOTIFY` oder Redis Pub/Sub |
| Mikro → Broker | synchron im Match-Fall | Richtig: Orderpfad muss synchron quittiert werden; verschiedene Symbole dürfen parallel laufen |
| Mikro → Feedback | DB-Write bei Trigger | Auch BLOCKED/ERROR persistieren, damit CEO keine Survivorship-Bias-Daten bekommt |
| Research/Backtest | synchron in Pipeline | Job-Queue mit idempotenten Job-Keys und Ergebnistabellen |

### 2.5 Caching-Strategien für Research-Daten

| Datenart | Cache-Key | TTL | Invalidierung |
| --- | --- | --- | --- |
| Candles | `symbol:interval:limit:lastClosedCandle` | Bis nächste Kerze schließt | Candle-Close-Event/WebSocket |
| Quote | `symbol` | 1–5 s für UI/Makro; nicht für Mikro-Hot-Path | Tick-Feed aktualisiert RAM |
| News/RSS | Feed-URL + normalized timestamp | 5–15 min | ETag/Last-Modified, manuelle Refresh-Option |
| SEC company tickers | global | 24 h | Tagesjob |
| SEC submissions | `CIK` | 30–60 min | Filing-Date-Änderung |
| Backtest | `ruleSignature:datasetVersion` | bis Regel/Dataset ändert | neue Regelversion oder Candle-Backfill |
| LLM Research Output | `missionId:symbol:contextHash:model` | 30–60 min | Mission/Prompt/Marktregime ändert |

---

## 3. Code-Review

### 3.1 Positive Findings

- **Security/Guardrails:** Whitelisting, Symbol-Sanitizing, Prototype-Pollution-Abwehr und harte Risk-Ceilings sind umfangreich getestet.
- **DB-Pool:** `src/db/index.ts` nutzt Lazy-Initialisierung, Pool-Limits, Timeouts und Error-Listener.
- **LLM Provider:** `llmProvider.ts` hat Timeouts, Retry mit Backoff, Provider-Whitelist, API-Key-Header statt URL-Key für Gemini und redaktierte Fehler.
- **Micro Hot Path:** `microExecutor.ts` trennt LLM-Code per Import-Graph, kompiliert Regeln und vermeidet DB/Netzwerk im Tick-Path.
- **Kill-Switch:** In-process und persistent vorhanden; Mikro-Adapter prüft Kill-Switch im Lock erneut aus der DB.
- **Observability-Basis:** `audit_log`, `agent_messages`, `rule_executions`, `latencyMicros`, Dashboard-Endpunkte und Health-Checks existieren.

### 3.2 Kritische/hohe Architektur-Risiken

#### Finding H1 — Legacy-Engine kann bei Parallelität doppelte Paper-Orders erzeugen

**Ort:** `src/lib/engine.ts`, `runAgentTurn()` / `getBroker()` / `broker.submit()` / anschließender Insert in `positions`.

Der Legacy-Pfad prüft offene Positionen überwiegend über den in-process `PaperBroker`. Bei zwei parallelen Einzel-Agenten-Requests oder mehreren Next.js-Prozessen ist der Check→Fill→Persist-Abschnitt nicht DB-serialisiert. `runPipeline()` hat nur einen globalen Single-Flight im Prozess; das schützt nicht:

- parallele `runAgentTurn()` Einzelaufrufe,
- mehrere Node/Next-Instanzen,
- Neustartfenster,
- externe API-Aufrufer.

**Empfehlung:** Den Legacy-Orderpfad auf denselben Mechanismus wie `createPaperRuleAdapter()` umstellen: DB-Client holen, `pg_advisory_lock(hashtext('order:' + symbol))`, Kill-Switch frisch lesen, offene Position frisch lesen, Broker hydratisieren, Order ausführen, Position persistieren, Lock freigeben. Alternativ den Legacy-Pfad vollständig auf „Vorschlag erzeugen“ degradieren und nur Mikro-Regeln ausführen lassen.

#### Finding H2 — RuleCache-Refresh kann bei langsamer DB überlappen

**Ort:** `src/lib/microExecutor.ts`, `RuleCache.start()`/`load()`.

`setInterval(() => void this.load(), refreshMs)` verhindert nicht, dass zwei `load()`-Aufrufe parallel laufen, falls ein DB-Call länger als `refreshMs` dauert oder manuell `invalidate()` triggert. Das Risiko ist nicht hoch im lokalen Paper-Setup, kann aber bei DB-Störungen zu unnötigem Druck und theoretisch zu stale-last-writer führen.

**Empfehlung:** `private loading: Promise<void> | null` oder Generation-Token einführen. Nur ein aktiver Refresh; neue Invalidierung setzt `dirty=true` und startet nach Abschluss erneut.

#### Finding H3 — BLOCKED/ERROR im Mikro-Match sind nicht vollständig als `rule_executions` persistiert

**Ort:** `src/lib/microExecutor.ts`, `createPaperRuleAdapter()`.

Die Architektur-Doku verspricht, dass jeder Match als `TRIGGERED`, `BLOCKED` oder `ERROR` protokolliert wird. Der Code persistiert `TRIGGERED`, viele `BLOCKED`/`ERROR`-Returns werden jedoch nur als Rückgabewert/Log sichtbar. Dadurch fehlen dem Makro-Feedback wichtige Negativsignale, z. B. `POSITION_ALREADY_OPEN`, `MISSION_KILLED`, `GUARDRAIL:*`.

**Empfehlung:** Eine kleine Helper-Funktion `recordRuleExecution(ctx, status, reason, fill?)` im Adapter nutzen und in allen Return-Pfaden aufrufen. Tests sollten assertieren, dass BLOCKED/ERROR gezählt werden.

#### Finding H4 — Legacy-Pipeline wiederholt teure Kontextarbeit pro Agent

**Ort:** `src/lib/engine.ts`, `runAgentTurn()`.

Jeder Agent lädt Marktdaten, Performance-Kontext und House-View neu. In einer 6-Agenten-Pipeline multipliziert sich nicht nur LLM-, sondern auch IO-Latenz.

**Empfehlung:** `PipelineContext` einführen: Mission, Broker-State, Risk-Limits, Candle-Snapshot, KPI-Kontext und House-View einmal pro Pipeline-Lauf berechnen. Rollen bekommen denselben immutable Kontext plus rollenspezifische Instruktion.

### 3.3 Mittlere/niedrige Findings

| Finding | Schwere | Empfehlung |
| --- | --- | --- |
| `POST /api/firm/run` kann 300 s laufen | Mittel | Für UI: async Job statt langem HTTP-Request; Timeouts klar anzeigen |
| Logs sind überwiegend `console.*` | Mittel | JSON-Logger mit `requestId`, `missionId`, `agentId`, `ruleId`, `symbol`, `latencyMs` |
| `MicroExecutor.handleTick()` feuert Adapter-Promises ohne Backpressure | Mittel | Per-Symbol Queue/Limit einführen; bei Match-Sturm keine unbounded Promises |
| Healthcheck liefert bei DB down HTTP 200 | Niedrig/Mittel | Für systemd ok; für Kubernetes zusätzlich `/ready` mit 503 bei DB down |
| PaperBroker ist in-memory | Dokumentiert | Für horizontalen Paper-Betrieb Single-Writer erzwingen oder Ledger DB-zentriert machen |
| API-Rate-Limit in-memory | Niedrig | Für Multi-Instance Redis/DB-basiertes Rate-Limit verwenden |
| Metrics nur im Prozess | Mittel | Prometheus/OpenTelemetry Export für p95/p99 und Error-Budgets ergänzen |

### 3.4 Memory Leaks / Ressourcennutzung

- `MODEL_LIST_CACHE` ist klein und TTL-basiert.
- `evalSamples` ist auf 1000 begrenzt.
- `RollingTimeframeSeries` begrenzt Historie auf 160 Kerzen.
- Feed-Reconnect nutzt `setTimeout`; bei Stop muss sichergestellt sein, dass kein späterer Reconnect nach `stop()` wieder verbindet. Dieser Fall sollte getestet werden.
- React-Intervalle/Timeouts sind in den geprüften Komponenten überwiegend mit Cleanup versehen.

**Bewertung:** Keine akuten Memory Leaks gefunden. Größtes Ressourcenrisiko ist nicht Speicher, sondern unbounded parallele Adapter-Ausführung bei sehr vielen Matches.

### 3.5 API-Latenz und DB-Queries

- Dashboard-GETs nutzen mehrere parallele Queries (`Promise.all`) — gut.
- Report-/Log-Endpunkte laden begrenzte Mengen, aber einige Auswertungen passieren in Node statt SQL-Aggregation. Für größere Datenmengen sollten Aggregationen in SQL verschoben werden.
- `ruleFeedback()` und Report-Queries brauchen passende Indizes auf `rule_executions(rule_id, created_at)`, `positions(rule_id/status/updated_at)`, `audit_log(created_at)`. Das Schema sollte im DB-Migrationsreview auf diese Query-Muster geprüft werden.
- Mikro-Hot-Path ist sauber: DB erst im Match-/Fill-Fall.

---

## 4. Test-Abdeckung

### 4.1 Ausgeführte Prüfungen

Initial scheiterte `npm test`, weil `node_modules` in der frischen Sandbox nicht installiert war (`ERR_MODULE_NOT_FOUND: tsx`). Nach `npm ci` liefen alle Prüfungen erfolgreich.

| Kommando | Ergebnis |
| --- | --- |
| `npm ci` | 500 Packages installiert, `npm audit`: 0 Vulnerabilities |
| `npm test` | **181/181 Tests bestanden** |
| `npm run typecheck` | bestanden |
| `npm run lint` | bestanden |
| `npm run build` | bestanden, Next.js Production Build erfolgreich |

### 4.2 Bestehende Test-Stärken

- Broker-Guardrails, Kill-Switch, Hydration und Close-All.
- Security-Hardening: Secrets, Env, Tokenvergleich, Rate-Limit, API-Routen-Fehlerbehandlung.
- LLM-Provider: Provider-Whitelist, Retry, URL-Sanitizing, API-Key-Handling, Kostenabschätzung.
- Rule Engine: Sanitizing, Whitelist, Prototype-Pollution, Kompilierung, Backtest.
- Micro Executor: Import-Graph-Guard, Rolling-Serie, Cooldown/Tageslimit, Hot-Path-Latenz.
- Setup-/Postgres-Skripte und Zeitzonenlogik.

### 4.3 Fehlende Tests / Empfehlungen

| Testtyp | Konkreter Test | Priorität |
| --- | --- | --- |
| Multi-Process-Concurrency | Zwei parallele Legacy-`runAgentTurn()`-Aufrufe für dasselbe Symbol dürfen nur eine Position erzeugen | P0 |
| DB-Advisory-Lock | Zwei Mikro-Adapter-Instanzen matchen dieselbe Regel gleichzeitig; eine füllt, eine blockt `POSITION_ALREADY_OPEN` | P0 |
| BLOCKED/ERROR Persistenz | Jeder Mikro-Match mit Kill-Switch/Guardrail schreibt `rule_executions` | P1 |
| RuleCache-Refresh | Überlappende `load()`-Calls; neuer Stand darf nicht von älterem überschrieben werden | P1 |
| Feed-Reconnect/Stop | `stop()` verhindert spätere Reconnect-Timer | P1 |
| Backpressure | Match-Sturm erzeugt bounded Adapter-Concurrency und keine Promise-Flut | P1 |
| Latenz-Budget Integration | Simulierter Feed mit 10k Ticks; p95/p99 Hot-Path und Fill-Pfad getrennt messen | P1 |
| DB-Index Regression | Query-Pläne/Index-Erwartungen für `rule_executions`, `positions`, `audit_log` | P2 |
| Async Job API | Pipeline-Job lässt sich starten, pollen, abbrechen; kein HTTP-Timeout | P2 |

---

## 5. Priorisierter Handlungsplan

| Prio | Maßnahme | Aufwand | Erwartete Latenz-/Risiko-Wirkung |
| --- | --- | --- | --- |
| P0 | Legacy-Pipeline im UI/API klar als „nicht livefähig“ markieren; Default auf Makro/Mikro-Regeln legen | S | Verhindert Fehlbedienung; keine direkte Latenzsenkung, aber großer Sicherheitsgewinn |
| P0 | Legacy-Orderpfad mit DB-Advisory-Lock oder vollständige Deaktivierung direkter Legacy-Fills | M | Entfernt Doppelorder-Race im Paper-Betrieb; kritisch für Multi-Instance |
| P0 | Mikro-Executor als empfohlenen Paper-Default dokumentieren/starten (`npm run micro`) | S | Tick→Entscheid von Minuten auf µs/ms im Hot-Path |
| P1 | Persistenz von `BLOCKED`/`ERROR` für Mikro-Matches ergänzen | S–M | Besserer Feedback-Loop; reduziert falsche Strategieoptimierung |
| P1 | `RuleCache.load()` single-flight/generation-safe machen | S | Stabiler bei DB-Latenz; verhindert stale-last-writer |
| P1 | `PipelineContext` + parallele IO-Fetches für Legacy/Makro einführen | M | Legacy-Laufzeit typ. 10–30 % geringer; weniger API-Last |
| P1 | Backtest-Jobs asynchronisieren und nach Regel-Signatur cachen | M | Makro-Freigaben blockieren weniger; bei Wiederholung nahezu 0 ms Backtest-Latenz |
| P1 | Postgres `LISTEN/NOTIFY` für Regelinvalidierung ergänzen | M | Regel-Aktivierung im Mikro von max. 30 s Poll-Lag auf ~ms–subsekündlich |
| P2 | Strukturierte Logs + OpenTelemetry/Prometheus | M | Schnellere Incident-Analyse; p95/p99 sichtbar |
| P2 | Per-Symbol Adapter-Queue/Backpressure | M | Stabilität bei Match-Stürmen; verhindert Ressourcen-Spikes |
| P2 | Echten Broker-Adapter hinter Interface implementieren (Paper bleibt Default) | L | Voraussetzung für Live-Trading; ermöglicht echte Broker-Idempotency/Order-IDs |
| P3 | Distributed Rate-Limit und Job-Queue (Redis/Postgres) | M–L | Multi-Instance-Produktionsbetrieb |

### Erwartete Latenz-Reduktion nach Zielbild

| Pfad | Heute/Legacy | Ziel |
| --- | --- | --- |
| 6-Agenten-Pipeline bis Order | 2–6 min auf Variante A | Nicht im Live-Pfad verwenden |
| Makro-Regelerzeugung | Minuten, aber selten | Minuten bleiben ok, da vorab/asynchron |
| Regelaktivierung bis Mikro sichtbar | bis 30 s Polling | mit `LISTEN/NOTIFY`: ~1–100 ms |
| Tick→Rule-Match | bereits µs-Bereich im Design/Test | beibehalten; p95/p99 messen |
| Match→Paper-Fill | DB + Lock + Insert, ms-Bereich | mit Indizes/Pool stabilisieren |

---

## 6. Abhakliste vor dem Push

- [x] Alle Tests bestanden: `npm test` → 181/181 grün
- [x] Typecheck bestanden: `npm run typecheck`
- [x] Lint bestanden: `npm run lint`
- [x] Production Build bestanden: `npm run build`
- [x] Keine ungepatchten sicherheitskritischen Code-Leaks/Secret-Leaks gefunden
- [x] Architektur-Bottlenecks dokumentiert
- [x] Handlungsplan erstellt

---

## 7. Schlussbewertung

Für **Paper-Trading** ist die Codebasis bereits überdurchschnittlich robust, sofern der Makro/Mikro-Pfad genutzt wird. Für **Live-Trading** ist die wichtigste Regel: Die 6-Agenten-Pipeline darf nicht im Orderpfad liegen. Live-fähig wird das System erst mit:

1. LLM-freiem Mikro-Executor als einzigem Ausführungspfad,
2. DB-/Broker-idempotentem Check→Fill→Persist,
3. vollständiger Persistenz von Triggern, Blocks und Fehlern,
4. echter Broker-Adapter-Schicht mit Order-Idempotency,
5. p95/p99-Metriken und Runbooks für Feed-/DB-/Broker-Ausfälle.

Die vorhandene v1.6-Architektur zeigt bereits in die richtige Richtung. Die nächsten Arbeiten sollten nicht in „schnellere Agenten“ fließen, sondern in **Entkopplung, Idempotenz, Observability und getestete Concurrency**.

---

# Peer-Review-Vorlage — Live-Trading-Gate (Task 11), v1

**Anleitung:** Dieses Template ist vom Reviewer je Zeile mit ✓/✗/N/A, Befund
und Schweregrad (Critical/High/Medium/Low/Info) auszufüllen. **Der PR darf nur
gemerged werden, wenn die Checkliste komplett ✓/N/A ist** (DoD: ≥ 2 Approvals,
davon 1 Security-Fokus-Review anhand dieser Liste). Versioniert: Bei
Änderungen am Gate eine neue Template-Version (v2 …) anlegen und die
ausgefüllte Version im PR archivieren.

**Review-Gegenstand:** PR `feat(live-gate): auditierte Live-Trading-State-Machine + Enforcement + Kill-Switch (task-11) — aktiviert kein Live` ·
Modul `src/live-gate/**` · Doku `docs/LIVE_TRADING.md` ·
Security-Audit-Kapitel „Task 11" in `docs/SECURITY_AUDIT.md`.

**Reviewer 1 (Security-Fokus):** ______________________  Datum: ____________
**Reviewer 2 (Backend):** ______________________  Datum: ____________

## A. State-Machine & Transitionsmatrix

| # | Prüfpunkt | ✓/✗ | Befund |
| --- | --- | :---: | --- |
| A1 | 9 Zustände + exakt 8 legale Übergänge im Code (`LIVE_GATE_TRANSITIONS`) verankert | ☐ | |
| A2 | Matrix-Test vollständig: alle legalen Übergänge grün, ALLE illegalen Kombinationen (inkl. Sprünge, Rückwärts, Selbst) abgelehnt — 0 Durchlässe | ☐ | |
| A3 | Jeder Übergang hat objektive, automatisch verifizierte Bedingungen (TransitionCheck) ODER dokumentierte Admin-Policy | ☐ | |
| A4 | Halboffene Transitionen (Crash) werden als FEHLGESCHLAGEN auditiert; Zustand bleibt konsistent | ☐ | |
| A5 | Downgrades nur über disable/kill (auditiert); kein stiller Rückwärts-Sprung | ☐ | |

## B. Enforcement (Single Point)

| # | Prüfpunkt | ✓/✗ | Befund |
| --- | --- | :---: | --- |
| B1 | `assertLiveOrderAllowed` ist der einzige Torwächter; Factory UND Bitunix-Live-Pfad(e) rufen ihn | ☐ | |
| B2 | Order-Versuch je Zustand (9) × Flags getestet — nur die exakt erlaubte Konstellation lässt durch; alle anderen `LiveTradingGateError` + Audit | ☐ | |
| B3 | Fail-Safe: fehlt/ist unklar irgendetwas (Suite, Control Plane, State, Kill) → deny | ☐ | |
| B4 | **Bypass-Freiheit bestätigt**: kein zweiter Order-Pfad (`placeSerializedOrder` nur im Adapter), kein UI-/Agent-Flag fließt in den Enforcer, keine Flag-Writes im Code | ☐ | |
| B5 | PAPER kann nie live (Capability-Check vor Flags) | ☐ | |
| B6 | Suite-Stamp ist CI-Kennung (passed/runId/Max-Alter) und wird persistent geprüft | ☐ | |

## C. Kill-Switch-Drill

| # | Prüfpunkt | ✓/✗ | Befund |
| --- | --- | :---: | --- |
| C1 | Kill aus ALLEN 9 Zuständen getestet: sofort gesperrt + Audit + Failsafe-Datei | ☐ | |
| C2 | Kill wirkt bei DB-/Store-Ausfall (Memory + lokale Datei), Reihenfolge Datei-vor-Reset | ☐ | |
| C3 | Nach Kill: Live-Order systemweit/venue-scoped verweigert bis kompletter Neudurchlauf | ☐ | |
| C4 | Clear ist auditiert und öffnet KEIN Live (Zustand bleibt DISCONNECTED) | ☐ | |
| C5 | UI-Confirm (Phrase), API (Admin+CSRF) und CLI-Pfad vorhanden | ☐ | |

## D. Human Gate

| # | Prüfpunkt | ✓/✗ | Befund |
| --- | --- | :---: | --- |
| D1 | LIVE_PENDING → HUMAN_APPROVED nur durch Admin-Aktion mit confirm + Pflicht-Begründung + Approver | ☐ | |
| D2 | Cooldown (Default 24 h) serverseitig erzwungen, inkl. retryAt im Deny; 0 = aus dokumentiert | ☐ | |
| D3 | 4-Augen-Modus: zwei verschiedene Approver, erste Bestätigung auditiert | ☐ | |
| D4 | `REQUIRE_HUMAN_APPROVAL=true` kann strukturell nicht umgangen werden (keine Matrix-Kante) | ☐ | |

## E. Audit-Kette

| # | Prüfpunkt | ✓/✗ | Befund |
| --- | --- | :---: | --- |
| E1 | Jeder Übergang/Deny/Kill/Enforce hat einen Eintrag mit {ts, actor, venue, from, to, result, reason, policyVersion} | ☐ | |
| E2 | Hash-Kette (prevHash + sha256) über kanonisches JSON; Manipulation/Einfügen/Entfernen/Truncation erkannt (Tests) | ☐ | |
| E3 | Audit-Datei append-only; Ring + DB-Senke werfen nie | ☐ | |
| E4 | Keine Secrets/Order-Daten in Audit-Einträgen (Scanner grün) | ☐ | |

## F. CI & Betrieb

| # | Prüfpunkt | ✓/✗ | Befund |
| --- | --- | :---: | --- |
| F1 | Job `security-live-gate` führt die komplette Security-Suite aus und ist als Required Check eingetragen (Branch Protection) | ☐ | |
| F2 | Coverage-Tor ≥ 95 % kritischer Code (`src/live-gate/**`) aktiv | ☐ | |
| F3 | KEINE echten Orders in CI/Tests (Mock-Ports; Default-Test-Order-Port verweigert) | ☐ | |
| F4 | Secret-Scan über Gate-Quellen + API-Responses negativ | ☐ | |
| F5 | „Dieser Task aktiviert kein Live": nach Merge State DISCONNECTED, Flags false, kein Suite-Stamp im Betrieb | ☐ | |

## G. Doku

| # | Prüfpunkt | ✓/✗ | Befund |
| --- | --- | :---: | --- |
| G1 | `docs/LIVE_TRADING.md`: Diagramm, Bedingungen, Human-Gate, Enforcement, Kill, Audit, API/CLI, CI, Grenzen | ☐ | |
| G2 | SECURITY_AUDIT Task 11 (Threat Model + Red-Team-Liste + Ergebnisprotokoll) | ☐ | |
| G3 | help-JSONs (Live-Ebenen), CHANGELOG, FRONTEND_CONTROL_PLANE (Live-Chip ← Gate), BROKER_ARCHITECTURE | ☐ | |

## Ergebnis

- [ ] **Bypass-Freiheit des Enforcers ausdrücklich bestätigt** (B4) — Unterschrift Reviewer 1: __________
- [ ] Alle Punkte ✓/N/A, keine offenen High/Critical-Befunde
- [ ] Approval erteilt (GitHub Review: Approve)
- [ ] Anmerkungen/Follow-ups (z. B. LG-01 4-Augen-Identität, LG-02 Testnet-Anbindung): ______________________

**Ausgefüllt durch (Selbstaudit-Vorabcheck, kein Ersatz für Review):**
`npm run security:live-gate` → 78 Tests grün, 95,81 % Zeilen; Matrix 0
Durchlässe; Kill-Drill 9/9; Audit-Manipulation 4/4 erkannt (Protokoll im
SECURITY_AUDIT-Kapitel Task 11).
