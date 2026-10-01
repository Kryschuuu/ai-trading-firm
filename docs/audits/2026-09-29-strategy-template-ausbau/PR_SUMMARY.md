# PR-Summary — Audit 2026-09-29

> **Schnappschuss der Audit-Übergabe (`v1.0.0`).** Den aktuellen Umsetzungsstand führt
> [`remediation/TRACKING.md`](remediation/TRACKING.md): Die Phasen 0–3 sind abgeschlossen, Phase 4 läuft, und die drei
> Entscheidungen aus „Strategische Richtung“ sind seit `v0.6.1` als
> [ADR-008 … ADR-010](../../roadmap/DECISIONS.md) fixiert (Gate G0 erfüllt).

**Titel:** docs(audit): Validierung des Strategie-Template-Ausbaus + Roadmap (32 Prompts, 8 Phasen)

---

## Zusammenfassung

Dieses PR ist **reine Doku** — kein Produktivcode, keine Migration, keine Schema-Änderung. Es
prüft ein externes Ausbaudokument (Strategy-Templates, Candidate Matrix, Validator-Agent,
Copy-Trading) gegen den tatsächlichen Code-Stand von `main` und liefert ein Audit mit
19 Findings sowie einer Roadmap aus 32 kopierfertigen, sequenziell abarbeitbaren Prompts.

**Die Diagnose des Dokuments ist bestätigt, die Bestandsaufnahme nicht.** Die zentrale
Lücke stimmt: Es existiert weder `src/strategies/`, `src/screening/` noch `src/copy/`, und
`strategy_lifecycle_states` trägt `strategy_key`/`strategy_version` als Freitext bzw.
Integer, **ohne** das versionierte Strategie-Artefakt dahinter — Version 3 einer Strategie
ist heute nicht rekonstruierbar. Ebenso bestätigt: die `RuleEngine` ist zu Recht
deterministisch, `sanitizeRuleSpec()`/`RULE_CEILINGS` bilden eine echte Enforcement-Schicht,
und Backtest/Walk-Forward/Monte-Carlo/Lifecycle mit Evidenz und Drift sind substanziell
vorhanden.

Sechs Bausteine des Dokuments werden jedoch **unterschätzt** (Feature Store = 3 Features
statt „zentraler Layer"; Regime-Vokabular mit 5+1 Klassen existiert bereits; Strategie-Klasse
`trend/mean-reversion/breakout` existiert bereits und wirkt bis in den Micro-Executor;
Monte-Carlo hat bereits `MonteCarloStressConfig`; `WalkForwardCandidate` + `SelectorGates`
erzeugen bereits eine volle Parameter-Score-Tabelle), zwei sind **falsch** (der Scanner hat
**14** aktive Faktoren, nicht „15+"; `src/brokers/alpaca/` enthält **keinen** WebSocket), und
zwei **harte Blocker** werden nicht erwähnt: `RuleWindow.timeframe` ist auf
`1m|5m|15m|30m|1h` beschränkt, während der Store `1m…5d` unterstützt — ohne diesen Fix sind
sämtliche Screening- und Cross-Sectional-Ziele unerreichbar; und der vorgeschlagene
`buildRule(ctx)`-Builder würde als Runtime-Generator das Sicherheitsmodell „Code entscheidet"
umgehen, weil sein Output nicht durch `sanitizeRuleSpec()` läuft.

## Strategische Richtung

Wir bauen **kein neues Vokabular**, sondern binden das Vorhandene zusammen. Drei
Entscheidungen werden vor der ersten Codezeile schriftlich fixiert (ADR): Strategie-Templates
übernehmen die bestehende `StrategyClassKey`; Regime-Validierung nutzt das bestehende
`MarketRegime` + `regime_snapshots` + `evaluateRegimeOos`; eine zweite
`MultiAssetStrategySpec` entfällt zugunsten einer schmalen Portfolio-Construction-Schicht
über `src/crossSectional/`. Der Validator-Agent bleibt **nach** dem deterministischen Report
und darf ausschließlich `detail jsonb` schreiben, nie `result` — die Trennung „Agent
interpretiert, Code entscheidet" ist bereits im Repo institutionell verankert
(`devilsAdvocate` mit Shadow-Mode) und passt verlustfrei auf das bestehende
Evidence-Schema (`result`-CHECK ist bereits `PASS|FAIL|INCONCLUSIVE`). Copy-Trading kommt
**ganz am Ende, Paper-only, Bitunix-first** — Alpaca hat keinen WS, ein eigener Reconciler
existiert bereits nicht mehr nötig (`executionQuality`), und ein nachträglicher
Slippage-Cancel ist bei einer gefüllten Order unmöglich.

## Nächste Schritte

**Phase 0 ist das Gate:** drei Prompts ohne Produktivcode — ein Backtest-Perfenz-Benchmark
(der Single-Rule-Pfad ist O(n²) und entscheidet, ob 7.500 Screening-Zellen überhaupt
laufen), eine Bestandsaufnahme als SSoT-Karte und drei ADRs. Danach folgen in Reihenfolge
der Timeframe-Blocker (01-01), die Indikator-Grundlage (02-01…02-03), der Template-Kern mit
sechs Templates plus Compiler und Sicherheits-Nachweis (03-01…03-10), die versionierte
Persistenz (04-01/04-02), die Candidate Matrix (05-01…05-04), der Validator
(06-01…06-05) und zuletzt, unabhängig und weiterhin Paper-only, Copy-Trading
(07-01…07-03). Jeder Prompt ist eine eigene, grün abschließbare Aufgabe mit Akzeptanz-
kriterien und **Gesperrt-Klauseln**; der erste greifbare Nutzen (ein lauffähiges
EMA/ADX-Strategie-Artefakt) steht nach fünf Voraussetzungen in Prompt 03-03.

## Auswirkung

Kein Laufzeitrisiko, keine API-Änderung, keine Migrations-Risiken. Der Wert dieses PRs ist
sequenzielle: Er verhindert, dass sechs Duplikat-Vokabulare entstehen, und er macht die
beiden ungenannten Blocker **vor** der Template-Arbeit sichtbar, statt sie in Phase 3 zu
entdecken.

---

**Artefakte:**
[`README.md`](README.md) (Index) · [`report.md`](report.md) (Haupt-Audit, 7 Abschnitte) ·
[`findings/`](findings/) (19 Findings) · [`ROADMAP.md`](ROADMAP.md) (8 Phasen, Abhängigkeitsgraph) ·
[`prompts/`](prompts/) (32 Prompts) · [`remediation/TRACKING.md`](remediation/TRACKING.md)
(Status, Gates, 5 offene Punkte) · [`PR_SUMMARY.md`](PR_SUMMARY.md) (diese Datei)
