# Regelbasierte Backtesting-Engine mit Walk-Forward-Validierung (GAP-01)

**Stand:** 2026-09-19 · **Modul:** `src/backtest/` · **Version:** `1.51.0` · **Status:** Implementiert

Diese Datei beschreibt die Walk-Forward-Erweiterung der Backtest-Engine:
strikte Zeitmaske, Paper-Ausführung über den Paper-Fill-Simulator,
rollierende IS/OOS-Fenster, vergleichbar persistierte Runs und die CLI.
Die Engine-Basis (Event-Schleife, Portfolio, Legacy-Kostenmodell) steht in
[BACKTEST_ENGINE.md](BACKTEST_ENGINE.md); das Kostenmodell im Paper-Betrieb
in [PAPER_TRADING.md](PAPER_TRADING.md) (§3).

---

## 1. Architektur-Überblick

```mermaid
flowchart TD
    A[CLI scripts/run-backtest.ts\n--instrument --timeframe --from --to\n--rule-id oder --rule-file] --> B[HistoricalStore\nKerzen EINES Instruments EINES Timeframes]
    B --> C[Walk-Forward-Lauf\nsrc/backtest/walkforward.ts]
    C --> D[Je Fenster: IS-Eval + OOS-Eval\ndurch runMultiAssetBacktest]
    D --> E[Paper-Ausführung\nsrc/backtest/paperExecution.ts\nFillSimulator wie PaperBroker]
    E --> F[Kennzahlen aus src/portfolio\nMaxDD, Profit Factor, Sharpe, Sortino]
    F --> G[Report: Aggregate + Fenster\n+ Trade-Hashes]
    G --> H[data/backtest/<runId>.json + .md]
    G --> I[(backtest_runs\nappend-only)]
    I --> J[GET /api/firm/backtests\nGET /api/firm/backtests/[id]\nfirm.read]
```

Schichten-Trennung (bewusst):

- `src/backtest/` liegt AUSSERHALB von `src/cycle/` — Zyklus und Engine
  bleiben getrennt. Der Zyklus-Step (`08-backtest-verification`) nutzt die
  Engine nur lesend zur Setup-Verifikation.
- Reine Arithmetik: `src/backtest/**` importiert kein LLM-Modul
  (Architektur-Test in `tests/backtest.engine.test.ts`). LLM-Signale lassen
  sich später via gespeicherte Artefakte replayen — out of scope.
- Die Engine macht kein IO (kein Store-, kein Registry-, kein DB-Zugriff):
  Kerzen, Instrumente und Kostenprofil werden injiziert. Dadurch ist jeder
  Lauf deterministisch testbar.

---

## 2. Zeitmaske (Lookahead-Garantie)

**Regel:** An jedem Zeitschritt `t` sehen Signalerzeugung, Indikatoren und
Fills ausschließlich Daten mit Zeitstempel `≤ t`.

Umsetzung:

1. Die Engine sortiert alle Kerzen nach Zeit und iteriert eine gemeinsame
   Timeline. Pro Symbol wird nur das Präfix bis zum aktuellen Index
   übergeben (`series.slice(0, index + 1)`) — spätere Kerzen sind für
   `buildSnapshotFromCandles` und die Regel-Evaluierung strukturell
   unerreichbar.
2. Jeder Walk-Forward-Fensterlauf bekommt zusätzlich einen `from`/`to`-Clip
   der Engine: OOS-Läufe sehen keine IS-fremden Kerzen und umgekehrt.
3. Fills nutzen den Referenzkurs der Entscheidungs-Kerze (Close bzw.
   SL/TP-Trigger) — nie Future-Kurse.

Tests (`tests/backtest.engine.test.ts`, Abschnitt „Lookahead-Garantie“):

- **Präfix-Test:** Lauf A über 100 Kerzen vs. Lauf B über dasselbe Präfix +
  40 Trend-Umkehr-Kerzen (die jede Full-Series-Kennzahl verschieben würden).
  Alle Einstiege bis `t` und alle bis `t` abgeschlossenen Trades sind
  byte-identisch (Hash-Vergleich der Trade-Liste). Ein Zeitmasken-Fehler
  (z. B. Indikator über die volle Serie) macht diesen Test rot.
- **Mutationstest:** Umgekehrte Eingabereihenfolge liefert identische
  Trades, Kennzahlen und Equity-Kurve (Entscheidungen hängen an der Zeit,
  nicht an der Eingabereihenfolge).
- **Fenster-Zeitmaske:** OOS-Fenstergrenzen schließen exakt an IS an; die
  OOS-Segmente kacheln lückenlos (Nachweis im Report).

---

## 3. Ausführung & Kostenmodell (kein zweiter Kosten-Code-Pfad)

Walk-Forward-Runs laufen IMMER mit `executionModel: "paper"`
(`src/backtest/paperExecution.ts`). Einstiegs- und Ausstiegs-Fills gehen
durch DIESELBE deterministische `FillSimulator`-Klasse
(`src/lib/marketdata/simulator.ts`), die `createPaperExecution`
(`src/lib/marketdata/production.ts`) in den PaperBroker injiziert:

| Baustein | Paper-Betrieb | Backtest (diese Engine) |
|---|---|---|
| Fill-Preis, Taker-Gebühr, Slippage, Partial Fills | `FillSimulator.simulate` | `FillSimulator.simulate` (dieselbe Klasse) |
| Simulator-Konfiguration | `calibrateSimulatorConfig(loadSimulatorConfig())` | dieselbe Quelle (CLI) |
| Kerze/Ticker → Snapshot | `snapshotFromLastPrice` (Bitunix-/Alpaca-Paper) | `snapshotFromLastPrice` (Kerzen-Close) |
| Spread | Registry-`instrument.spread` (via `calculateRelativeSpread` angereichert) → `PAPER_SPREAD_FALLBACK_BPS`-Fallback | identisch gestuft (`effectiveSpreadDecimal`) |
| Funding | `FundingAccrualEngine` + `computeFunding` im Monitor-Tick | dieselbe Engine + Formel je Kerze |

Details und bewusste Grenzen:

- **Quotes aus Kerzen:** Bid/Ask werden symmetrisch aus dem Spread-Modell
  um den Referenzkurs konstruiert (LONG füllt am Ask, SHORT am Bid —
  identische Semantik wie bei echten Level-1-Feeds). Kerzen-Volumen ist
  kein 24h-Volumen: Der Simulator nutzt ehrlich seinen
  `volume24hFallback` (keine hochgerechnete Schein-Liquidität).
- **SL/TP-Trigger** sind Marktstruktur, kein Execution: Die Erkennung je
  Kerze (`detectExitTrigger`) hat bei Kollision Stop-Vorrang (konservativ,
  wie der Legacy-Pfad); der FILL zum Trigger-Preis läuft durch den
  Simulator (Taker-Gebühr — konservativer als das Legacy-Limit-Fill).
- **Funding:** Nur eindeutig als Perpetual erkannte Instrumente
  (`marketType === "perpetual"` aus der Registry) werden belastet;
  unbekannte Symbole bekommen ein neutrales Spot-Default (fail-safe: keine
  erfundenen Kosten). Rate-Default `0` = neutral (wie Paper).
- **Partial Fills:** Mit Default-Konfiguration (`partialFillEnabled: false`)
  füllt jede Order vollständig. Ist die Option an, wird der füllbare Anteil
  verbucht (die Engine hat kein Orderbuch für Restmengen — dokumentierte
  Einschränkung, sichtbar an `filledQty` vs. Notional).
- **Legacy-Pfad:** `executionModel: "legacy"` (Default) ist der
  eingefrorene Task-02-Simulator (`src/backtest/simulator.ts`) —
  Byte-kompatibel für bestehende Läufe/Tests, aber nicht mehr
  weiterentwickelt. Neue, vergleichbar persistierte Runs nutzen `"paper"`.

---

## 4. Walk-Forward-Fenster (IS/OOS)

Konfiguration (`src/backtest/walkforward.ts`, Flags in
[CONFIGURATION.md](../CONFIGURATION.md)):

| Flag | Default | Bounds | Bedeutung |
|---|---|---|---|
| `WF_IS_WINDOW_DAYS` | `90` | [14, 720] | Länge des In-Sample-Fensters (Tage) |
| `WF_OOS_WINDOW_DAYS` | `30` | [7, 180] | Länge des Out-of-Sample-Fensters (Tage) |
| `WF_MAX_SPAN_DAYS` | `730` | [30, 3650] | Maximaler Backtest-Zeitraum (Anti-Overfitting-Deckel, Default 2 Jahre) |

Layout (klassisch, vorwärts-rollierend): Fenster 0 startet am
Zeitraum-Anfang mit IS + OOS; jedes weitere Fenster rückt um EINE
OOS-Länge vor. Nur VOLLSTÄNDIGE Fenster werden gelegt — ein angebrochenes
Restfenster wird verworfen. OOS-Segmente kacheln lückenlos und
überlappungsfrei; IS-Fenster dürfen überlappen (Standard). Übersteigt der
Zeitraum den Deckel, wird am Anfang gekappt (jüngste Daten gewinnen,
`truncated: true` im Report).

Jedes Fenster ist ein EIGENSTÄNDIGER Evaluations-Lauf (keine
fensterübergreifenden Positionen). Report je Fenster: Kennzahlen IS/OOS +
Trade-Hash (sha256 über die kanonische Trade-Liste) sowie Aggregate über
alle Fenster. Aggregate werden aus Summen NEU berechnet (kein Mittel über Raten);
Sharpe/Sortino/MaxDD über die verkettete
Fenster-Renditenreihe (dokumentierte Näherung, kein fiktiver Kontoverlauf).

Fail-closed: Trägt der Zeitraum kein vollständiges IS+OOS-Fenster, wirft
der Runner `walkforward:insufficient-span` (statt zu raten); ohne Kerzen
`walkforward:no-candles`.

---

## 5. Run-Persistenz & Read-API

Tabelle `backtest_runs` (append-only, Migration
`drizzle/2026-09-19_backtest_runs.sql`, Stil wie `rule_backtests`): ein
Walk-Forward-Lauf = EINE Zeile (insert-only, kein Update-Pfad) mit
`paramsJson` (Regel-Ref + Regel-Spezifikation + Fenster + Kostenprofil),
`metricsJson` (Aggregate OOS/IS), `windowsJson` (Kennzahlen + Trade-Hash je
Fenster) und `codeVersion` (Vergleichbarkeit über Releases).

Zugriff (kein POST-Endpunkt — Runs entstehen NUR via CLI):

- `GET /api/firm/backtests?limit=1..100` (Default 20) — Liste, jüngste zuerst.
- `GET /api/firm/backtests/[id]` — ein Run per UUID (404 wenn unbekannt).

Beide verlangen `firm.read` (SEC-02-Muster, `no-store`) und melden einen
unerreichbaren DB-Stand als `503 BACKTEST_RUNS_UNAVAILABLE` mit
Handlungs-Hinweis (fail-closed statt leerer Liste).

---

## 6. CLI-Referenz (`scripts/run-backtest.ts`)

```sh
node --import tsx scripts/run-backtest.ts \
  --instrument=BITUNIX:BTCUSDT --timeframe=1h \
  --from=2024-01-01 --to=2026-01-01 \
  --rule-id=<uuid> | --rule-file=./regel.json \
  [--is-days=90] [--oos-days=30] [--skip-db]
```

| Flag | Pflicht | Bedeutung |
|---|---|---|
| `--instrument` | ja | Instrument-ID wie im HistoricalStore (Replay-Ziel) |
| `--timeframe` | nein (Default `1h`) | Kerzen-Periodizität (Store-Allowlist) |
| `--from` / `--to` | ja | Zeitraum (ISO-8601 oder Epoch-ms; muss mind. 1 IS+OOS tragen) |
| `--rule-id` | genau eine Regelquelle | Regel-UUID aus `trade_rules` |
| `--rule-file` | genau eine Regelquelle | Pfad zu einer RuleSpec-JSON (wird sanitized + gegen `RULE_CEILINGS` geklemmt) |
| `--is-days` / `--oos-days` | nein | Fenster-Override (Bounds wie `WF_*`, sonst Env-Wert) |
| `--skip-db` | nein | kein `backtest_runs`-Insert (nur Artefakte; Offline-Betrieb) |

Ablauf: Regel laden (DB oder Datei) → Kerzen aus dem HistoricalStore →
Instrument aus der Universe-Registry auflösen (fehlt sie: neutrales
Spot-Default, sichtbar in der Konsolenausgabe) → Walk-Forward-Lauf mit
kalibriertem Simulator + Funding-Konfiguration des Paper-Betriebs →
Artefakte `data/backtest/<runId>.json` (Report) + `<runId>.md`
(Zusammenfassung) → `backtest_runs`-Zeile mit derselben UUID.

Regel-Symbol vs. Instrument: Regel-Spezifikationen tragen PAPER-kanonische
Symbole (z. B. `BTC/USDT`), Store-Reihen Venue-IDs (z. B.
`BITUNIX:BTCUSDT`). Die CLI replayt die Regel-Logik (Bedingung, Action,
Fenster — venue-agnostisch) gegen `--instrument`; beide IDs stehen im
Report (`ruleRef.ruleSymbol` vs. `instrumentId`) und in der
MD-Zusammenfassung — kein stiller Tausch.

Fail-closed: Fehlende/ungültige Flags, ungültige Regeln, leere Kerzenreihen
und zu kurze Zeiträume brechen mit Exit 1 ab (kein Run, kein Artefakt,
keine DB-Zeile). Schlägt das DB-Insert fehl, bleiben die Artefakte
bestehen und der Exit-Code ist 1 (laut, nie still).

---

## 7. Anti-Overfitting-Grenzen (bewusst nicht enthalten)

1. **Statische Regeln, keine Parameter-Optimierung:** IS/OOS trennt hier
   EVALUATIONS-Fenster (Robustheit: trägt die Regel über die Zeit, oder
   „passt“ sie nur auf einem Abschnitt?). Eine Schätzung auf IS mit
   Verifikation auf OOS ist bewusst NICHT Teil dieses PRs.
2. **Fensteranzahl-Deckel:** `WF_MAX_SPAN_DAYS` (Default 2 Jahre) begrenzt
   implizit die Fensteranzahl — mehr Fenster laden zu selektivem Lesen
   („das beste Fenster zählt“) ein.
3. **OOS trägt die Wahrheit:** Die MD-Zusammenfassung und `metricsJson`
   stellen das OOS-Aggregat voran; IS dient nur dem Vergleich.
4. **Kein synthetischer Fallback:** Step 8 (`08-backtest-verification`)
   meldet bei < 5 Kerzen `DATA_UNAVAILABLE` (verified=false, Audit,
   Log) — die frühere erfundene Mindestbewertung ist entfernt (GAP-01 D4,
   Fail-closed-Kern dieses PRs).

---

## 8. Referenzen

- Engine-Basis: [BACKTEST_ENGINE.md](BACKTEST_ENGINE.md)
- Paper-Kostenmodell: [PAPER_TRADING.md](PAPER_TRADING.md) (§3), Funding:
  `src/lib/funding.ts`
- Flags: [CONFIGURATION.md](../CONFIGURATION.md) („Walk-Forward-Backtesting“)
- Finding: [GAP-01](audits/2026-09-18-feature-gap/findings/GAP-01-backtesting-walk-forward.md)
- Tests: `tests/backtest.engine.test.ts`, `tests/backtest.step.nosynthetic.test.ts`
