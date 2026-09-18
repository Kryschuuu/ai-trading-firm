# Report: Feature-Gap-Analyse (Co-Audit) — 2026-09-18

**Teil 1** ist der vollständige Wortlaut des externen Co-Audits (Arena-Session,
2026-09-18), erstellt **ohne** Code-Lese-Zugriff — nur README, Changelog und
öffentliche PRs (#89–#132) wurden ausgewertet. Der Wortlaut wird unverändert
bewahrt (Konvention „Original-ID/Original-Wortlaut beibehalten“).

**Teil 2** ist die nachgelagerte **Verifikation gegen den Codebestand**
(Basis v1.40.0, 2026-09-18) — die Brücke von der Behauptung zum Nachweis, je
Finding mit Datei-Evidenz. Abweichungen zwischen Teil 1 und Teil 2 sind dort
explizit markiert.

---

## Teil 1 — Wortlaut des Co-Audits (unverändert)

> **Wichtige Einschränkung vorab:** Das Audit konnte das Repo nicht Datei für
> Datei lesen, sondern nur README, Changelog und die öffentlichen PRs
> (#89–#132) auswerten. Es ist also eine **Architektur- und
> Feature-Lücken-Analyse**, kein Zeilen-Review.

### 1. Ist-Stand (was bereits solide ist)

Das Projekt ist ein Referenz-Setup für ein Team spezialisierter KI-Agenten
(CEO, Research, Technical, News, Macro, Risk, Portfolio, Approver, Executor),
das ein Handelsziel autonom bearbeitet — mit einer abstrakten
LLM-Provider-Schicht (Ollama, OpenAI-kompatible Endpunkte, Gemini, Claude),
PostgreSQL als institutionellem Gedächtnis und harten Risikogrenzen im Code.
Das System läuft ausschließlich im Paper-Trading-Modus. Es gibt keinen aktiven
Live-Broker-Pfad.

**Stärken, die auffallen:**

- **Security/Governance ist überdurchschnittlich:** Kill-Switch mit
  Challenge-Nonce (Disarm: requirePermission(live.gate) [ADMIN] + CSRF +
  single-use Nonce (<=60s)), RBAC, eine EmergencyBroker-Schnittstelle für
  Notfälle (cancelAllOpenOrders → closeAllPositions → verifyFlat), CI auf
  immutable Commit-SHAs gepinnt.
- **Concurrency-Fixes sind durch:** zwei unabhängige PaperBroker-Instanzen
  racen submitAtomic() auf dasselbe Symbol → genau ein FILLED + ein
  REJECTED:POSITION_ALREADY_OPEN; Optimistic Locking auf Prompt-Edits.
- **Fail-closed-Denken beim Risiko:** Bei fehlender/fehlerhafter/staler
  Bewertung fiel das adaptive Risk-System still auf das Basis-Risiko zurück —
  das wurde in v1.36.21 auf einen expliziten UNKNOWN-Zustand umgestellt.
- **Testabdeckung:** 2119 Tests, 0 Failures.

**Kleiner Doku-Befund:** Die Repo-Beschreibung nennt es eine „Python-basierte
Handelsplattform“, der Stack ist aber Node.js/TypeScript (Next.js 16 +
Drizzle), kein Python-Backend. Die GitHub-Description sollte korrigiert
werden.

**Zentrale Beobachtung:** Der Reifegrad ist stark asymmetrisch. Sicherheit,
Auth, Audit-Trail und Betrieb sind auf Produktionsniveau — aber die
**Trading-Qualität selbst** (Validierung, realistische Fills, Lernschleife)
ist aus dem sichtbaren Material kaum belegt. Genau dort setzen die Top 10 an.

### 2. Top 10 fehlende Funktionen

#### GAP-01 — Backtesting-Engine mit Walk-Forward-Validierung (ohne Lookahead)

Historische Bars der 354 Instrumente durch dieselbe Agenten-Pipeline laufen
lassen, mit strikter Zeitmaske (Agenten sehen nur Daten ≤ t),
In-Sample/Out-of-Sample-Split und gespeicherten Runs zum Vergleich.

- **Pro:** Einzige Möglichkeit, Strategien *vor* Paper/Live überhaupt zu
  bewerten; erlaubt Prompt-/Parameter-Vergleiche auf Datenbasis statt
  Bauchgefühl.
- **Contra:** LLM-Agenten sind nicht deterministisch und teuer — ein Backtest
  über Jahre kostet Tokens/Zeit; Gefahr des Overfittings auf historische News.
  Man braucht einen „schnellen Pfad“ (regelbasierte Agenten) für lange
  Zeiträume.
- **Nutzen:** ★★★★★ · **Aufwand:** 🔧🔧🔧🔧🔧

#### GAP-02 — Realistische Execution-Simulation im PaperBroker

Slippage-Modell (spread- und volumenabhängig), Maker/Taker-Gebühren,
**Funding-Rates** (Bitunix Perpetuals!), Teil-Fills, Latenz, Rejection bei zu
geringer Liquidität.

- **Pro:** Paper-Ergebnisse werden ehrlich; ohne das ist jede
  Performance-Aussage systematisch zu optimistisch. Gerade bei Shorts auf
  Perps frisst Funding oft die Edge.
- **Contra:** Modelle sind Annahmen; zu pessimistische Parameter töten gute
  Strategien. Muss kalibrierbar sein (Env/Config).
- **Nutzen:** ★★★★★ · **Aufwand:** 🔧🔧

#### GAP-03 — Trade-Journal mit Agenten-Attribution & Feedback-Loop

Jede Order speichert: welche Agenten wie gestimmt haben, Confidence, Regime,
Begründung → nach Close: PnL, MAE/MFE, Haltedauer. Auswertung „welcher Agent
hat recht, wann?“ fließt als Gewichtung in den Approver/Portfolio-Agenten
zurück.

- **Pro:** Macht das Multi-Agenten-System erst *lernfähig*; Agenten mit
  schlechter Trefferquote in bestimmten Regimes werden automatisch
  runtergewichtet. PostgreSQL als „institutionelles Gedächtnis“ ist dafür
  bereits da.
- **Contra:** Kleine Stichproben → Rauschen wird als Signal fehlinterpretiert;
  braucht Mindest-Trade-Anzahl und Bayes'sche Glättung.
- **Nutzen:** ★★★★★ · **Aufwand:** 🔧🔧🔧

#### GAP-04 — Volatilitätsbasiertes Position-Sizing + Korrelations-Exposure-Limits

ATR-/Vol-Targeting statt fixer Größen, Fractional Kelly als Obergrenze,
Cluster-Limits (z. B. max. 3 hoch korrelierte Alt-Coins gleichzeitig long).

- **Pro:** Größter Einzelhebel auf risikoadjustierte Rendite; verhindert, dass
  5 „unabhängige“ Trades in Wahrheit ein einziger BTC-Beta-Trade sind. Passt
  zu den bestehenden `LIMIT_CEILINGS`.
- **Contra:** Korrelationsmatrix muss laufend berechnet werden (Rechenlast,
  Stale-Risiko); Vol-Schätzer versagen bei Regime-Brüchen.
- **Nutzen:** ★★★★★ · **Aufwand:** 🔧🔧🔧

#### GAP-05 — Server-seitiges Exit-Management (Stop-Loss/Take-Profit/Trailing, OCO/Bracket)

Jede Position erhält beim Öffnen zwingend SL/TP; Trailing-Logik und Time-Stop
laufen in einem eigenen Watcher-Prozess unabhängig von LLM-Turns.

- **Pro:** Der wichtigste Schutz gegen Tail-Risk; Exits dürfen nie von
  LLM-Latenz oder Provider-Ausfall abhängen. Ergänzt den Kill-Switch um
  granulare Kontrolle.
- **Contra:** Zu enge Stops in Crypto = Stop-Hunting; Bitunix-Order-Typen
  müssen korrekt gemappt werden (Conditional Orders, Reduce-Only).
- **Nutzen:** ★★★★★ · **Aufwand:** 🔧🔧🔧

#### GAP-06 — Explizite Regime-Detection als Gate für Agenten-Gewichtung

Trend/Range/High-Vol/Crash-Klassifikation (z. B. ADX + realisierte Vol +
BTC-Dominanz) als Input für Portfolio- und Approver-Agent. Das adaptive Risk
kennt bereits Regimes — aber als Risiko-Faktor, nicht als Strategie-Gate.

- **Pro:** Mean-Reversion-Signale in Trendmärkten werden automatisch gedämpft
  und umgekehrt. Was man von Tag eins hinzufügen sollte: ein Regime-Gate für
  den Contrarian-Agenten. In trendenden Märkten sollte sein Gewicht
  automatisch sinken. Das durch Live-Verluste zu entdecken, ist der
  langsamere Weg zu lernen.
- **Contra:** Regime-Klassifikatoren laggen; Whipsaws an Regime-Grenzen.
  Braucht Hysterese.
- **Nutzen:** ★★★★ · **Aufwand:** 🔧🔧

#### GAP-07 — Datenqualitäts-Layer & Multi-Timeframe-Konsistenz

Gap-Detection in Candles, Outlier-Filter (Wick-Fehler), Stale-Data-Guard pro
Instrument, Cross-Check gegen zweite Quelle, saubere Aggregation 1h → 4h/1d.
Default ist seit v1.37.0 '1h' — nur ein Timeframe ist für Trend-Kontext zu
wenig.

- **Pro:** „Garbage in, garbage out“ gilt für LLM-Agenten doppelt — eine
  falsche Candle produziert eine überzeugend formulierte Fehlentscheidung. Die
  Failure-Klassifizierung aus PR #129 ist eine gute Basis.
- **Contra:** Zweite Datenquelle = zusätzliche Rate-Limits und API-Kosten; zu
  aggressive Filter verwerfen echte Flash-Moves.
- **Nutzen:** ★★★★ · **Aufwand:** 🔧🔧

#### GAP-08 — LLM-Output-Validierung & Prompt-Eval-Harness

Strukturierte JSON-Schemata für jede Agenten-Antwort, Plausibilitätschecks
(Confidence vs. Begründung, Richtung vs. genannte Indikatoren), Golden-Dataset
mit historischen Situationen zur Regressionsprüfung nach Prompt-Änderungen,
Token-/Latenz-Budget pro Turn.

- **Pro:** Prompt-Edits sind heute versioniert (W2-Fix), aber nicht *bewertet*
  — ein „verbesserter“ Prompt kann Performance still ruinieren. Schützt
  außerdem gegen Halluzinationen (Agent nennt Kurse, die es nicht gibt).
- **Contra:** Golden-Dataset-Pflege ist Handarbeit; kleine lokale Modelle
  (Ollama) halten Schemata schlechter ein → Fallback-Logik nötig.
- **Nutzen:** ★★★★ · **Aufwand:** 🔧🔧🔧

#### GAP-09 — Reconciliation Broker ↔ Datenbank + idempotente Order-IDs

Periodischer Abgleich Positionen/Orders/Balance zwischen Broker-API und
PostgreSQL; Abweichung → Alarm + optional Trading-Pause. Client-Order-IDs für
sichere Retries.

- **Pro:** Zwingende Voraussetzung, bevor der Live-Pfad je aktiviert wird;
  Netzwerk-Timeouts nach Order-Submit sind sonst Doppelorder-Risiko. Passt
  logisch neben `verifyFlat`.
- **Contra:** Im reinen Paper-Modus noch kein akuter Nutzen;
  Bitunix-API-Eigenheiten (Position-Modes, Hedge-Mode) machen den Abgleich
  fummelig.
- **Nutzen:** ★★★★ (★★★★★ bei Live) · **Aufwand:** 🔧🔧🔧

#### GAP-10 — Observability & automatische Circuit-Breaker

Prometheus/OpenTelemetry-Metriken (PnL, Drawdown, Fill-Rate, LLM-Latenz,
Provider-Fehler), Alerting (Telegram/Mail), Heartbeat-Watchdog, und
**automatischer** Kill-Switch bei Tages-/Wochen-Drawdown-Limit oder N
Verlusten in Folge.

- **Pro:** Der Kill-Switch ist heute manuell — bei einem Bug um 3 Uhr nachts
  hilft nur ein Automat. Metriken machen Performance-Drift sichtbar, bevor sie
  teuer wird.
- **Contra:** Alert-Fatigue bei schlecht gesetzten Schwellen; Watchdog selbst
  ist ein Single Point of Failure und muss getrennt laufen.
- **Nutzen:** ★★★★ · **Aufwand:** 🔧🔧

### 3. Übersicht & empfohlene Reihenfolge (des Co-Audits)

| # | Feature | Nutzen | Aufwand | Kategorie |
|---|---------|--------|---------|-----------|
| 2 | Slippage/Fees/Funding im PaperBroker | ★★★★★ | 🔧🔧 | Ehrlichkeit |
| 5 | Server-seitiges Exit-Management | ★★★★★ | 🔧🔧🔧 | Schutz |
| 10 | Observability + Auto-Circuit-Breaker | ★★★★ | 🔧🔧 | Betrieb |
| 4 | Vol-Sizing + Korrelations-Limits | ★★★★★ | 🔧🔧🔧 | Rendite/Risiko |
| 6 | Regime-Gate | ★★★★ | 🔧🔧 | Rendite |
| 7 | Datenqualität + Multi-TF | ★★★★ | 🔧🔧 | Fundament |
| 3 | Trade-Journal + Attribution | ★★★★★ | 🔧🔧🔧 | Lernschleife |
| 8 | LLM-Output-Validierung + Eval | ★★★★ | 🔧🔧🔧 | Qualität |
| 1 | Backtesting/Walk-Forward | ★★★★★ | 🔧🔧🔧🔧🔧 | Validierung |
| 9 | Reconciliation + Idempotenz | ★★★★ | 🔧🔧🔧 | Live-Readiness |

**Begründung der Reihenfolge:** Erst die „Quick Wins“ mit hohem Nutzen
(#2, #10, #6, #7), dann die Schutz- und Sizing-Logik (#5, #4), dann die
Lernschleife (#3, #8). Das Backtesting (#1) ist der größte Brocken und
profitiert davon, wenn #2 und #7 bereits stehen — sonst backtestet man gegen
unrealistische Fills und schmutzige Daten. #9 wird erst kritisch, wenn der
Live-Pfad tatsächlich aktiviert werden soll.

**Schlussgedanke des Co-Audits:** Das Projekt hat mit dem Paper-only-Default
und der Security-Härtung die richtige Reihenfolge gewählt. Die Erfahrung aus
vergleichbaren Systemen ist eindeutig: Im Backtesting ja — manchmal
beeindruckend. Im Live-Trading ist die Lücke zwischen simulierten und realen
Renditen groß. Transaktionskosten, Slippage und Marktregime-Wechsel fressen
die Performance auf. Genau diese drei Punkte adressieren #2, #6 und #1 —
deshalb sind sie aus Sicht des Co-Audits nicht optional, sondern die
Voraussetzung dafür, dass „optimale Trades“ überhaupt messbar werden.

---

## Teil 2 — Verifikation gegen den Codebestand (2026-09-18, v1.40.0)

Methode: je Finding Lesen der betreffenden `src/**`-Dateien und Tests.
Keine der Evidenz-Dateien wurde durch dieses Audit verändert.

| GAP | Co-Audit-Annahme | Verifizierter Ist-Stand | Evidenz (Auszug) | Delta für Remediation |
|-----|------------------|-------------------------|------------------|-----------------------|
| 01 | „kaum belegt“ | **Teil-umgesetzt.** `backtestStep` prüft Setups deterministisch gegen historische Kerzen (KEIN LLM); `rule_backtests` + `/api/firm/rules/[id]/backtest` existieren. **Aber:** Bei <5 Kerzen fällt der Step auf eine synthetische Standardserie zurück („20 Trades, 55 % Winrate“) — erzeugte statt gemessener Performance. Kein Walk-Forward, keine Zeitmaske-Architektur, keine gespeicherten Vergleichsläufe. | `src/cycle/steps/backtestStep.ts`, `src/db/schema.ts` (`rule_backtests`), `src/app/api/firm/rules/[id]/backtest/route.ts` | Echte Walk-Forward-Engine (regelbasiert), Lookahead-Tests, synthetischen Fallback entfernen (fail-closed), Run-Persistenz |
| 02 | „fehlen komplett“ | **Großteils umgesetzt.** `PaperExecutionAdapter` (Task 03): Gebühren, Spread, Slippage, Partial Fills, deterministisch; Vorab-Cash-Guard rechnet Slippage+Gebühren konservativ ein. **Aber:** Funding-Raten fließen nirgends in Paper-PnL (Funding existiert nur als Scanner-Ranking-Faktor); Parameter-Kalibrierung über Env/Config begrenzt. | `src/lib/broker.ts` (Fill, LiveQuote, ExecutedFill, PaperExecutionAdapter), `src/lib/marketdata/production.ts` (`createPaperExecution`), `src/scanner/factors/funding.ts` | Funding-Accrual je Perpetual-Position + Kalibrierung + Transparenz im Ausweis |
| 03 | „fehlt“ | **Rohdaten vorhanden, Auswertung fehlt.** `positions` trägt `missionId`, `ruleId`, `exitReason`; `proposals`, `agentMessages` („institutionelles Gedächtnis“), `audit_log`, `equity_snapshots` existieren. **Aber:** keine Verknüpfung Position ↔ Agenten-Stimmen, keine MAE/MFE-Auswertung, keine Gewichts-Rückführung. | `src/db/schema.ts` (positions/proposals/agentMessages), `src/lib/engine.ts` | Journal-Verknüpfung + Auswertung (Bayes-Glättung, Mindest-Stichprobe) + begrenzte Rückführung |
| 04 | „fixe Größen, keine Cluster-Limits“ | **Mathematik vorhanden, Verdrahtung fehlt.** `src/portfolio/correlation.ts` hat Pearson/Spearman, Korrelations- und Kovarianzmatrizen, `correlationClusters`, `clusterAnalysis`; `/api/portfolio/correlation` existiert. Risiko-Seite: `adaptiveRisk` skaliert per Vol-Regime, `riskGuard` begrenzt `maxPositionPct` fix. **Aber:** kein ATR-Sizing, kein Kelly-Deckel, keine Cluster-Limits als Guardrail. | `src/portfolio/correlation.ts`, `src/lib/riskGuard.ts` (LIMIT_CEILINGS), `src/lib/adaptiveRisk.ts` | Sizing-Formel + Cluster-Guardrail (Schicht 3) mit Stale-Policy |
| 05 | „fehlt“ | **Teil-umgesetzt.** `monitor.tick()` prüft je offener Position SL/TP serverseitig unabhängig von LLM-Turns (`stopsTriggered`, `exitReason`-Taxonomie STOP_LOSS/TAKE_PROFIT/…). **Aber:** kein Trailing-Stop, kein Time-Stop, OCO-Exklusivität (genau ein Exit bei Race) nicht belegt, Zustand nur aus DB-Spalten (ok), keine Stop-Parametrisierung. | `src/lib/monitor.ts`, `src/db/schema.ts` (positions.stopLoss/takeProfit/exitReason) | Trailing + Time-Stop + OCO-Exklusivität (idempotente Ticks) + Konfiguration |
| 06 | „nur Risiko-Faktor“ | **Bestätigt, präzisiert.** `adaptiveRisk` klassifiziert Vol-Regime NORMAL/ELEVATED/EXTREME **mit** Hysterese (`RegimeState.update`, De-Eskalationsfenster) — als Risikofaktor. **Aber:** kein Trend/Range/Crash-Klassifikator (kein ADX im Code), kein Strategie-/Agenten-Gate. | `src/lib/adaptiveRisk.ts` (RegimeState, regimeFactor), `src/lib/indicators.ts` | Markt-Regime-Klassifikator (deterministisch) + Gate (monitor-only Default) mit Hysterese |
| 07 | „nur ein Timeframe, keine Qualitätsprüfung“ | **Teil-umgesetzt.** MDERR-Taxonomie mit strukturierten Logs/Metriken/Manifest, leere Kerzen zählen seit v1.40.0 als `DATA_UNAVAILABLE`, History ist timeframe-dimensioniert (`instrumentId+timeframe+ts`, MDSYNC-001), Stale-Fallback-API explizit. **Aber:** keine Gap-Detection, kein Outlier-Filter, keine 1h→4h/1d-Aggregation, kein Cross-Check. | `src/marketdata/dataErrors.ts`, `src/marketdata/sync.ts`, `src/lib/marketdata/historicalStore.ts`, `docs/OBSERVABILITY.md` | Qualitäts-Prüfungen beim Schreiben/Lesen + deterministische Multi-TF-Aggregation + optionale Zweitquelle (flag-gated, default off) |
| 08 | „nicht bewertet“ | **Teil-umgesetzt.** `src/cycle/schemas.ts` validiert jede Step-Ausgabe mit handgeschriebenen TS-Validatoren (bewusst **ohne** Zod — keine Runtime-Dep); LLM_ROUTING hat Budget-Deckel; Prompt-Edits sind versioniert (Optimistic Locking). **Aber:** keine Plausibilitäts-Schicht (Confidence vs. Begründung, Kurs-Halluzinationen), kein Golden-Dataset/Eval-Runner, Budget-Lücken möglich. | `src/cycle/schemas.ts`, `src/routing/**`, `docs/LLM_ROUTING.md` | Plausibilitäts-Validatoren + Retry-Policy + Golden-Dataset-Eval (offline/deterministisch) + Budget-Hartdeckel |
| 09 | „fehlt“ | **Teil-umgesetzt (Bitunix-spezifisch).** `orderIntents`-Tabelle (H2-Fix), Idempotenz-Tests für Bitunix, `reconcile`-Begriffe im Broker-Contract. **Aber:** kein periodischer generischer Abgleich mit Differenz-Klassifikation, kein Pause-Pfad, kein Paper-Invarianz-Selbsttest, Client-Order-ID-Regime nicht adapter-übergreifend. | `src/db/schema.ts` (orderIntents), `tests/bitunix.idempotency.test.ts`, `src/contracts/broker.ts`, `src/brokers/bitunix/execution.ts` | Generischer Reconciliation-Job + Pause + clientOrderId-Konvention + Paper-Invarianzen |
| 10 | „Kill-Switch nur manuell“ | **Teil-umgesetzt.** `telemetry.ts` mit `prometheusMetrics()` (Marktdaten-Fehler), Ops-Center mit 10 echten Sektionen, `riskGuard` kennt `maxEquityDrawdownPct`/`dailyLossLimitPct` (Grenzen beim Order-Pfad). **Aber:** keine Firmen-Metriken (PnL/Fill-Rate/LLM-Latenz) im Metrik-Endpunkt, kein automatischer Kill-Switch bei Limit-Bruch, kein Alerting, kein Heartbeat-Watchdog. | `src/lib/telemetry.ts`, `src/app/api/ops/route.ts`, `src/lib/riskGuard.ts`, `src/app/api/health/route.ts` | Metrik-Ausbau + Auto-Circuit-Breaker (nutzt bestehende Kill-Switch-Infrastruktur) + Alert-Adapter + Heartbeat |

### Verifikations-Befunde außerhalb der Top 10

- **Doku-Befund bestätigt:** Die GitHub-Repo-Description lautete „…modulare
  Python-basierte Handelsplattform…“ — der Stack ist Node.js/TypeScript.
  Korrektur erfolgt mit diesem Audit-PR (Chunk „Geändert“ im Changelog).
- **Test-Baseline 2026-09-18 (Sandbox, PostgreSQL lokal):** 2122 Tests,
  2114 bestanden, 7 skipped, **1 Fehler** — `tests/secretStore.test.ts`
  („db→file-Fallback ohne DATABASE_URL“): der Test erwartet `file`, erhält
  `db`, wenn unter der effektiven `DATABASE_URL` eine **erreichbare**
  Datenbank antwortet (Test-Isolation: das npm-Script exportiert
  `DATABASE_URL` prozessweit; standalone und ohne DB ist der Test grün).
  Vorab existierend, nicht durch dieses Audit verursacht — als eigenes
  Finding zu führen (empfohlene ID: ENV-01, Severity LOW, Kategorie
  Test-Isolation).

### Korrigierte Aufwands-Schätzungen

Nach Verifikation reduzieren sich die Aufwände der Teil-umgesetzten Lücken:

| GAP | Co-Audit | Verifiziert | Begründung |
|-----|----------|-------------|------------|
| 02 | 🔧🔧 | 🔧 | Simulator existiert; Delta = Funding + Kalibrierung + Ausweis |
| 05 | 🔧🔧🔧 | 🔧🔧 | Watcher existiert; Delta = Trailing/Time-Stop/OCO-Exklusivität |
| 07 | 🔧🔧 | 🔧🔧 | Taxonomie steht; Delta = Prüfung + Aggregation |
| 10 | 🔧🔧 | 🔧🔧 | Telemetrie + Limits stehen; Delta = Auto-Breaker + Alerting + Heartbeat |
| 01 | 🔧🔧🔧🔧🔧 | 🔧🔧🔧🔧 | Step + Store + Runs-Tabelle stehen; Delta = Engine + Walk-Forward + Lookahead-Garantie |

Die Reihenfolge-Empfehlung des Co-Audits bleibt unverändert gültig
(siehe [`prompts/README.md`](prompts/README.md)).
