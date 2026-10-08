# Regelbasierte Backtesting-Engine mit Walk-Forward-Validierung (GAP-01)

**Bestandsdokument** · **Stand:** 2026-09-23 · **Code-Version:** v0.17.2 (Beta) · Vollabgleich offen — [DC-06](audits/2026-10-06-docs-code-audit/findings/DC-06-symbol-und-pfad-drift.md) · **Modul:** `src/backtest/` · **Status zum Stand:** Implementiert

Diese Datei beschreibt die Walk-Forward-Erweiterung der Backtest-Engine:
strikte Zeitmaske, Paper-Ausführung über den Paper-Fill-Simulator,
rollierende IS/OOS-Fenster, vergleichbar persistierte Runs samt
Trade-Ledger (`backtest_trades`, RMA-P1-04) und die CLI.
Die Engine-Basis (Event-Schleife, Portfolio, Legacy-Kostenmodell) steht in
[BACKTEST_ENGINE.md](BACKTEST_ENGINE.md); das Kostenmodell im Paper-Betrieb
in [PAPER_TRADING.md](PAPER_TRADING.md) (§3).

Der Quick-Check einer einzelnen Regel ist **nicht** dieser Walk-Forward.
`POST /api/firm/rules/[id]/backtest` (Handbuch 15.4) defaultet seit v0.2.0
auf `model=paper` und liest nur den Historical Store. `model=reference`
bleibt der gebührenfreie Altpfad über `backtestRule`. Der Default von
`runMultiAssetBacktest` bleibt `"legacy"`, damit bestehende Engine-Läufe
byte-gleich bleiben. Walk-Forward setzt `paper` selbst, ohne den
Engine-Default umzulegen. Die Store-ID ist `VENUE:native`, nicht das
Regel-Symbol. Ohne `instrumentId` nimmt die Route nur eine exakte oder
eindeutig kanonische Reihe; sonst 422. Dieselbe Trennung wie die CLI unten
(Regel-Symbol vs. `--instrument`), ohne stillen Tausch.

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
    G --> I[(backtest_runs + backtest_trades\nEINE Transaktion, idempotent)]
    I --> J[GET /api/firm/backtests\nGET /api/firm/backtests/[id]\nGET /api/firm/backtests/[id]/trades\nfirm.read]
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

### 1.1 Rule-Timeframe ↔ unterstützte Felder (STX-01, `v0.6.2`)

`RuleWindow.timeframe` akzeptiert seit `v0.6.2` jeden Wert aus
`SUPPORTED_TIMEFRAMES` (`1m … 5d`, zehn Werte). `RULE_ALLOWED_TIMEFRAMES`
(`src/lib/ruleEngine.ts`) und das LLM-Schema `RULE_LLM_SCHEMA` leiten sich daraus
ab — es gibt **ein** Vokabular (`src/lib/marketdata/timeframes.ts`; der
Historical Store re-exportiert es). Vorher war der Regel-Pfad auf `1m … 1h`
beschränkt, `4h`/`1d` waren nicht ausdrückbar. `sanitizeRuleSpec` ist
unverändert: Die Schreibweise wird kleingeschrieben (`"1H"` → `"1h"`), alles
außerhalb der Allowlist (`"2h "`, `"7d"`, `""`, `null`) fällt auf den sicheren
Default `15m` — nie wird ein Rohwert durchgereicht. Regeln mit `1m … 1h`
liefern dieselben Bytes wie vor `v0.6.2` (Golden-Test in `tests/ruleEngine.test.ts`).

**Erlaubt heißt nicht live ausführbar.** Backtests laufen auf allen zehn
Timeframes. Der Mikro-Executor wertet dagegen nur Regeln bis zu seinem
**Ausführungsintervall** aus (Default `1h`, Option `executionInterval`): Er bewertet
eine Regel gegen den Snapshot ihres Timeframes inklusive der noch laufenden Kerze —
für `2h … 5d` wäre das ein teilweise abgelaufener Snapshot, den Backtest und
Regelautor nie gesehen haben. Der Timeframe-Guard weist solche Regeln **fail-closed
und sichtbar** ab (keine Serie, keine Position; Counter
`micro_executor_rule_blocked_total`, Log `micro_executor_rule_blocked`,
`status().ruleGuard` in `GET /api/firm/micro`; siehe
[OBSERVABILITY.md](OBSERVABILITY.md) §9 und §4).

| Timeframe | Kerzen je UTC-Tag | `vwapPct` | `volumeWindow` 5…200 Kerzen ≙ | `changePct24h` spannt ≈ | Mikro-Executor (live, Default) | Kostenmodell des Paper-Backtests |
| --- | ---: | --- | --- | --- | --- | --- |
| `1m` | 1 440 | ✅ ab der 2. Kerze des UTC-Tages | 5 min … 3,3 h | 1,6 h | ✅ | kalibriert |
| `3m` | 480 | ✅ ab der 2. Kerze | 15 min … 10 h | 4,8 h | ✅ | generischer Fallback¹ |
| `5m` | 288 | ✅ | 25 min … 16,7 h | 8 h | ✅ | kalibriert |
| `15m` | 96 | ✅ | 1,25 h … 50 h | 24 h | ✅ | kalibriert |
| `30m` | 48 | ✅ | 2,5 h … 4,2 d | 2 d | ✅ | kalibriert |
| `1h` | 24 | ✅ | 5 h … 8,3 d | 4 d | ✅ (Default-Obergrenze) | kalibriert |
| `2h` | 12 | ⚠️ grob: ab 02:00 UTC, 2–12 Stützstellen | 10 h … 16,7 d | 8 d | ❌ abgewiesen | generischer Fallback¹ |
| `4h` | 6 | ⚠️ grob: ab 04:00 UTC, 2–6 Stützstellen | 20 h … 33 d | 16 d | ❌ abgewiesen | kalibriert |
| `1d` | 1 | ❌ **immer `null`** | 5 d … 200 d | 96 d | ❌ abgewiesen | kalibriert |
| `5d` | < 1 | ❌ **immer `null`** | 25 d … 1 000 d | 480 d | ❌ abgewiesen | generischer Fallback¹ |

¹ `timeframeToSpreadFallbackBps` / `timeframeToSlippageBaseBps`
(`src/backtest/paperExecution.ts`) sind nur für `1m`, `5m`, `15m`, `30m`, `1h`, `4h`,
`1d` kalibriert; `3m`, `2h` und `5d` laufen auf dem generischen Fallback
(4 bp Spread, 1 bp Slippage). Für `3m` ist das **optimistisch** (das feinere `1m` rechnet
mit 15 bp / 3 bp) — Backtests auf `3m` bis zur Kalibrierung mit Vorsicht lesen. Das Modell
wurde mit `v0.6.2` bewusst nicht angefasst (bestehende Ergebnisse bleiben byte-identisch).

**`vwapPct` ist eine Intraday-Größe.** Anker ist der UTC-Kalendertag der letzten
Kerze; `sessionVwap` liefert `null`, wenn dort weniger als zwei Kerzen liegen (oder kein
Volumen). Auf `1d`/`5d` ist das konstruktionsbedingt immer der Fall, auf `2h`/`4h`
bis zur zweiten Kerze des Tages. `null` ist dabei nie `0`: Eine `vwapPct`-Bedingung
bleibt `false` (fail-closed), im Snapshot-Builder der Regel-Engine
(`buildSnapshotFromCandles`) wie im Indikator-Cache der Backtest-Engine
(`snapshotFromCache`), die dieselbe Null-Semantik teilen. Ein Template, das `vwapPct`
nutzt, ist damit automatisch auf Intraday-Timeframes beschränkt.

Die übrigen Felder sind auf jedem Timeframe definiert; was sich mit dem Timeframe
ändert, ist die Bedeutung der **Kerzenzahl**:

| Felder | Verhalten |
| --- | --- |
| `price`, `ema9`/`ema21`/`ema50`, `priceVsEma21Pct`/`priceVsEma50Pct`, `trend`, `rsi14`, `atrPct`, `bbwPct` | ab 25 Kerzen Historie; darunter gibt es keinen Snapshot (auf `1d` sind das 25 Tage, auf `5d` 125 Tage Vorlauf) |
| `adx14` | ab 29 Kerzen, davor `null` |
| `macd`, `macdSignal`, `macdHist` | ab 35 Schlusskursen, davor `null` |
| `volume`, `volumeMa20`, `volumeRatio` | Mittel über `window.volumeWindow` **Kerzen** (5…200, geklemmt wie auf jedem Timeframe); die Spalte „`volumeWindow` ≙“ oben rechnet das in Zeit um. Auf `1d` sind 5 Kerzen eine Woche und 200 Kerzen das klassische 200-Tage-Fenster — `RULE_CEILINGS.volumeWindow` bleibt deshalb unverändert. Hat die Serie weniger Kerzen als das Fenster, mittelt der Snapshot über die vorhandenen. |
| `changePct24h` | Basis ist die Kerze 97 Positionen vor dem Serienende, also 96 Perioden zurück — **kein 24-h-Wert** außer auf `15m` (STX-14; bewusst nicht umgerechnet, das würde bestehende Regeln still umwerten) |
| `spreadPct`, `bookDepthUsd` | Liquiditätsgrößen des Instruments bzw. des Live-Orderbuchs, vom Regel-Timeframe unabhängig; `null` ohne belastbares Buch blockiert die Bedingung |
| `bbZScore`, `priceVsUpperBbPct`, `priceVsLowerBbPct` | Lage im selben 20/2σ-Band wie `bbwPct` (STX-02-02, `v0.6.4`); `null` ohne Band (`middle <= 0`), `bbZScore` zusätzlich bei σ == 0 — Details in [§1.2](#12-bollinger-bandlage-stx-02-02-v064) |
| `donchianBreakoutPct` | Abstand zum Donchian-Kanalhoch der **vorigen 20 Kerzen** (ohne Signalkerze, STX-02-03, `v0.6.5`); `null` unter 21 Kerzen oder bei `upper <= 0`, nie eine erfundene 0 — Details in [§1.3](#13-donchian-ausbruch-stx-02-03-v065) |

### 1.2 Bollinger-Bandlage (STX-02-02, `v0.6.4`)

`bbwPct` misst die **Breite** des Bands, nicht die **Lage** des Kurses darin. Drei
Felder schließen diese Lücke; alle sind relativ (Prozent bzw. σ-Einheiten) und
damit über Instrumente mit verschiedenen Kursniveaus vergleichbar — der Dialekt
bleibt „Messwert gegen Schwelle“:

| Feld | Formel | Einheit | Typische Werte |
| --- | --- | --- | --- |
| `bbZScore` | `(close − middle) / σ` | Standardabweichungen (dimensionslos) | −3 … +3; 0 = Bandmitte, ±2 = Bandkante |
| `priceVsUpperBbPct` | `(close − upper) / close · 100` | Prozent des Kurses | ≤ 0; **> 0 = Ausbruch über die obere Kante** |
| `priceVsLowerBbPct` | `(close − lower) / close · 100` | Prozent des Kurses | ≥ 0; **< 0 = Ausbruch unter die untere Kante** |

Bandparameter sind fest **20 Schlusskurse, 2 σ** (Population) — dieselben Werte,
die `bbwPct` benutzt (`BOLLINGER_PERIOD`/`BOLLINGER_MULT` in
`src/lib/indicators.ts`). Periode und Multiplikator sind **kein** Regelfeld: Der
Snapshot definiert das Band, damit `bbZScore` in jedem Template dasselbe bedeutet.

**`null` ist ein Messwert-Ausfall, keine 0** (fail-closed, blockiert die Bedingung):

- weniger als 20 Schlusskurse — praktisch kein Snapshot (Snapshots brauchen ≥ 25 Kerzen),
- `middle <= 0` — kein sinnvolles Band (z. B. Serie mit nicht-positiven Kursen),
- **σ == 0 nur bei `bbZScore`**: Eine flache Kerzenreihe hat keine Lage *im* Band; 0 wäre eine
  erfundene Neutralität. Die Kantenabstände bleiben dort echte 0-Werte (der Kurs liegt genau
  auf der Kante) — sie nehmen keinen Bezug auf σ.

Beide Ausführungspfade liefern dieselben Zahlen: `buildSnapshotFromCandles`
(Quick-Check `backtestRule`, Mikro-Executor) und `snapshotFromCache`
(Multi-Asset-Backtest, Walk-Forward). Ein Paritätstest vergleicht die Felder Bar für Bar
(`tests/backtest.multiAsset.test.ts`); ein Golden-Hash beweist, dass Läufe **ohne**
Bollinger-Feld byte-identisch zu `v0.6.3` bleiben.

**Beispiel-Workflow „Squeeze → Breakout“.** Klassisch: enges Band (Squeeze), dann
schließt der Kurs über der oberen Kante. Der Regeldialekt ist zustandslos — beide
Bedingungen werden auf **derselben** geschlossenen Kerze gemessen (keine Sequenz,
bewusst; siehe ROADMAP „Abgelehnt“):

```json
{
  "name": "Squeeze-Breakout (Bollinger 20/2σ)",
  "symbol": "BTC/USDT",
  "condition": {
    "logic": "all",
    "conditions": [
      { "field": "bbwPct", "op": "lt", "value": 5 },
      { "field": "priceVsUpperBbPct", "op": "gt", "value": 0 }
    ]
  },
  "action": { "side": "LONG", "stopLossPct": 3, "takeProfitRR": 2, "riskBudgetPct": 0.02, "maxPositionPct": 0.25 },
  "window": { "timeframe": "1h", "maxExecutionsPerDay": 3, "cooldownMinutes": 60, "volumeWindow": 20 }
}
```

Praktischer Hinweis aus der Messung: Der Ausbruch selbst **weitet** das Band, weil er
in die 20er-Rechnung eingeht. In einer Beispielreihe (enge Range um 100, ein Sprung von
+3,5 %) liegt `bbwPct` vorher bei 0,31 % und an der Ausbruchskerze bei 3,18 %
(`bbZScore` 4,34; `priceVsUpperBbPct` +1,80 %). Eine Schwelle wie `bbwPct lt 3` wäre
also genau an der Ausbruchskerze verfehlt — die Squeeze-Schwelle muss den Ausbruch
mitdenken (z. B. `lt 5`) oder ausschließlich `bbZScore`/`priceVsUpperBbPct` nutzen
(`bbZScore gt 2` ist der Breakout bereits eingebaut). Wer eine echte
„Squeeze, *danach* Ausbruch“-Sequenz braucht, findet sie heute **nicht** in der
Regel-DSL; das ist eine bewusste Grenze (kein Trigger-/Sequenz-Ausbau).

### 1.3 Donchian-Ausbruch (STX-02-03, `v0.6.5`)

`donchianBreakoutPct` ist das letzte der sieben Strategie-Felder und die einzige
Größe, die sich nicht aus einem bestehenden Feld ableiten ließ: Der Donchian-Ausbruch
(Durchbruch des Hochs der letzten N Kerzen) ist ein **Breakout**-Signal, kein
Abstand zu einem gleitenden Mittel wie `priceVsEma21Pct`/`priceVsUpperBbPct`.

| Feld | Formel | Einheit | Typische Werte |
| --- | --- | --- | --- |
| `donchianBreakoutPct` | `(close / upper − 1) · 100`, `upper` = Kanalhoch der **vorigen** 20 Kerzen | Prozent des Kurses | −10 … +5; **> 0 = Ausbruch über den vorher bekannten Kanal** |

**Kein Look-ahead.** Das Kanalhoch ist das Maximum der Highs der **20 Kerzen vor
der Signalkerze** (`donchianChannel(candles, 20, 10)` aus
`src/lib/indicators.ts`, STX-02-01). Die laufende Kerze ist ausdrücklich nicht im
Kanal: Erst ihr Schlusskurs bestätigt den Ausbruch gegen den *vorher* bekannten
Kanal. Wäre ihr High im `upper`, wäre der Ausbruch in derselben Kerze eingebaut —
genau der Lookahead-Bug, den `tests/indicators.test.ts` und
`tests/ruleEngine.test.ts` ausschließen. Entsprechend heißt `> 0` „der Schlusskurs
liegt über dem Hoch der letzten 20 abgeschlossenen Kerzen“; „der Kurs macht gerade
ein neues 20-Kerzen-Hoch“ wäre derselbe Tag, aber eine andere Aussage.

**Fensterlänge = Snapshot-Definition, kein Regelfeld.** Periode 20 und
Exit-Fenster 10 sind kanonisch (`DONCHIAN_ENTRY_PERIOD`/`DONCHIAN_EXIT_PERIOD`).
Das Feld bedeutet in **jedem** Template „Hoch der vorigen 20 Kerzen“. Wer eine
andere Fensterlänge handeln will, braucht eine zusätzliche, versionierte
Definition — Template 03-08 (`donchian-breakout`, `v0.7.4`) nutzt bewusst den
kanonischen Snapshot-Default und dokumentiert eine andere Periode als bekannte
Grenze (06-02); das Regelwerk bleibt unangetastet, sonst wäre derselbe Feldwert
je Strategie etwas anderes.

**`null` ist ein Messwert-Ausfall, keine 0** (fail-closed, blockiert die Bedingung):

- weniger als 21 Kerzen — das Kanalhoch der vorigen 20 Kerzen ist nicht vollständig
  (praktisch irrelevant: Snapshots brauchen ≥ 25 Kerzen),
- `upper <= 0` — es gibt kein Kanalhoch als Bezug (nicht-positive Kursreihe).

Eine **echte `0`** bleibt möglich und heißt „Schlusskurs exakt auf dem Kanalhoch“;
eine Reihe mit steigendem Kurs liefert Werte, sobald sie über das vorige Hoch
schließt. Die `null`-Semantik steht in `donchianBreakoutPct()` an genau einer
Stelle und gilt für beide Ausführungspfade.

**Beide Engines, eine Zahl.** `buildSnapshotFromCandles` (Quick-Check
`backtestRule`, Mikro-Executor) ruft `donchianChannel` über das Kerzen-Präfix; der
Multi-Asset-Pfad liest `donchianUpper` aus `src/backtest/indicatorCache.ts`. Der
Cache rechnet das laufende Maximum mit einer monotonen Deque in **O(n)** vor
(jeder Index wird einmal eingefügt und höchstens einmal entfernt) — bewusst
**kein** `Math.max(...slice)` je Bar, das wäre O(n·20) und damit die
STX-12-Regression im Backtest-Pfad. Ein Test vergleicht beide Pfade Bar für Bar
über drei Symbole (`tests/backtest.multiAsset.test.ts`); Läufe **ohne**
Donchian-Feld bleiben byte-identisch (Golden-Hash).

**Higher-Timeframe-Hinweis (Template 03-08).** Donchian ist per Definition
HTF-Logik: Ein 20-Kerzen-Hoch ist auf `1m` 20 Minuten, auf `1d` fast ein Monat.
Das Template erzwingt ihn seit `v0.7.4` über
`supportedTimeframes: ["1h", "4h"]`; das Feld selbst ist
timeframe-unabhängig definiert.

```json
{
  "name": "Donchian-Breakout (20 Kerzen, voriges Kanalhoch)",
  "symbol": "BTC/USDT",
  "condition": {
    "logic": "all",
    "conditions": [
      { "field": "donchianBreakoutPct", "op": "gt", "value": 0 }
    ]
  },
  "action": { "side": "LONG", "stopLossPct": 3, "takeProfitRR": 2, "riskBudgetPct": 0.02, "maxPositionPct": 0.25 },
  "window": { "timeframe": "1h", "maxExecutionsPerDay": 3, "cooldownMinutes": 60, "volumeWindow": 20 }
}
```

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
  weiterentwickelt. Neue, vergleichbar persistierte Runs nutzen `"paper"`
  oder — explizit — `"event_replay"` (§3.2).

---

### 3.2 Event-Replay mit realistischen Friktionen (RMA-P1-01, v1.58.0)

`executionModel: "event_replay"` ist der dritte Ausführungspfad
(`src/backtest/replayEvents.ts` + `src/backtest/replayExecution.ts`) —
explizites Opt-in, kein bestehender Lauf wechselt still den Pfad. Er
modelliert, was `"paper"` nicht kann:

* **Kanonischer Eventvertrag:** diskriminierte Union
  `MARKET_BAR | MARKET_QUOTE | MARKET_DEPTH | FUNDING_DUE` (Input) und
  `ORDER_SUBMITTED | ORDER_ACK | ORDER_REJECT | ORDER_PARTIAL_FILL |
  ORDER_FILL | ORDER_CANCEL` (deterministisch erzeugtes Eventlog).
  Sortierung: `eventTime ↑` → Typ-Priorität (Depth vor Quote vor Bar vor
  Funding vor Order-Lifecycle) → Symbol → Einfüge-Reihenfolge
  (dokumentierter stabiler Tie-Break, `sortReplayEvents`).
* **Zeit-/Latenzmodell:** vier getrennte Zeiten je Order —
  `decisionTime → submitTime (+decisionToSubmitMs) → arrivalTime
  (+submitToArrivalMs) → fillTime(s)`. Eine Order füllt frühestens auf der
  ersten Kerze mit `time ≥ arrivalTime`; Latenz 0 = Paper-Konvention.
  Jedes Input-Ereignis trennt `eventTime` von `availableAt`
  (`availableAt ≥ eventTime`, sonst `replay:invalid-event`); sichtbar wird
  es erst ab `availableAt ≤ Simulationszeit` — kein Look-ahead, auch nicht
  für Kosten. Negative Latenz/rückwärts laufende Zeit wird abgewiesen
  (`replay:invalid-config`).
* **Fill-/Impact-Modell:** verfügbare Menge = frisches
  `MARKET_DEPTH`-Ereignis (Alter ≤ `maxDepthAgeMs`, Default 2 Kerzen);
  fehlt/veraltet es, greift der dokumentierte konservative Fallback
  `bar.volume × maxBarVolumeParticipation` (Default 10 %); fehlt auch das
  Kerzenvolumen, findet KEIN Fill statt (fail-closed, Grund
  `NO_LIQUIDITY_DATA_NO_FILL`). Preis:
  `touch = base × (1 ± spread/2)`, `price = touch × (1 ± impactBps/10⁴)`
  mit `impactBps = impactBpsPerParticipation × (fillQty/verfügbareMenge)`;
  Spread aus frischer `MARKET_QUOTE`, sonst `spreadBpsFallback`
  (degradiert sichtbar). Gebühren (Taker) und Slippage werden NUR auf die
  tatsächlich gefüllte Menge gebucht. Ein Fill überschreitet nie Depth,
  Orderrestmenge oder offene Positionsmenge.
* **Order-Lifecycle mit Restmenge:** ein PARTIAL-Exit lässt die Position
  mit Restmenge OFFEN; der Trade schließt erst, wenn die Restmenge 0 ist
  (Exit-Preis = Fill-VWAP). Offene Restmengen verfallen nach
  `orderTtlBars` Kerzen (`ORDER_CANCEL`, Grund `ORDER_TTL_EXPIRED`).
  Beginnt ein Exit, werden laufende Entry-Restmengen gecancelt.
* **Punktgenaues Funding:** `FUNDING_DUE`-Ereignisse (Venue, Instrument,
  signierte `ratePer8h` als Dezimalanteil — positiv = Longs zahlen,
  `intervalHours` 1..24) werden ausschließlich für zum
  Settlement-Zeitpunkt offene, eindeutig als Perpetual erkannte Positionen
  gebucht (DIESELBE Formel `computeFunding` wie der Paper-Betrieb;
  Kontosicht: negativ = gezahlt). Funding vor Entry oder nach Exit wird
  nie gebucht; ohne Ereignis wird KEIN statischer Satz untergeschoben —
  fehlendes Funding ist sichtbar (`coverage.fundingEvents`). Die CLI
  übersetzt kanonische `perp_funding_rates`-Zeilen via
  `perpFundingRowsToReplayEvents` (`src/backtest/replayFunding.ts`,
  as-of über `available_at`).
* **Reproduzierbarkeit:** jeder Lauf trägt `result.replay` mit
  Datenmanifest (sha256 über Kerzen + kanonische Events), aufgelöster
  Friktionskonfiguration (inkl. Seed und Modellversion `er1`),
  Event-Coverage, degradierten Annahmen (geschlossenes Vokabular
  `ReplayDegradedReason`), gedeckeltem Order-Eventlog und
  Fill-/Funding-/Impact-Details je Trade. Walk-Forward-Reports persistieren
  das als `params_json.replayEvidence`; Trade-Zeilen tragen
  `provenance_json.replay` (max. 64 Fills je Trade, `truncated`-Flag).
  Der Idempotency-Key enthält `frictionModelVersion` — ein Modellwechsel
  gilt nie als Replay desselben Laufs.
* **Metriken (bounded):** `backtest_replay_runs_total{result,degraded}` und
  `backtest_replay_degraded_total{reason}` (Gründe = geschlossene Union,
  nie Symbole/IDs).
* **Bewusste Grenzen:** kein Live-Order-Scheduler (P4.2/P4.3), keine
  synthetische Erfindung fehlender historischer Orderbücher (fehlende
  Depth ⇒ dokumentierter konservativer Fallback oder kein Fill), kein
  Umbau der Portfolio-Strategielogik. Der `FillSimulator` des Paper-Pfads
  wird hier bewusst NICHT verwendet: Impact kommt aus historischer Depth
  statt aus dem 24h-Volumen-Modell — beide Pfade bleiben getrennt
  versioniert (`costProfile.executionModel` + `frictionModelVersion`).

Rollback/Feature-Gate: der Pfad ist reines Opt-in über
`executionModel: "event_replay"` (Engine) bzw.
`--execution-model=event_replay` (CLI). Ohne diese Angabe ist das
Verhalten byte-identisch zu v1.57.0; alte gespeicherte Runs werden nicht
uminterpretiert (`params_json.costProfile.executionModel` unterscheidet
die Semantik je Run).

---

### 3.1 Perpetual-Funding aus der Ablage (RMA-P2-02, v1.54.0)

`scripts/run-backtest.ts` speist die Funding-Accrual-Engine über
`createPerpFundingRateProvider` (`src/perpdata/consumers.ts`) — dieselbe Engine
und dieselbe Formel wie im Paper-Betrieb, nur mit historischen Raten aus
`perp_funding_rates`. Drei Punkte machen das replay-sicher:

* **as-of**: geladen wird `event_time ≤ asOf` **und** `available_at ≤ asOf`;
  ein Satz, den es zum Zeitpunkt noch nicht gab, existiert für den Backtest
  nicht. Die Provider-Lesung ist auf `toMs` begrenzt.
* **nur fällige Settlements**: `replayPositionFunding` bucht jede Rate genau
  einmal je Position und Intervall (`hiddenRows`, `missingMarks`,
  `qualityFlagged` im Ergebnis); Sätze außerhalb der Haltedauer werden
  ausgewiesen, nicht verrechnet.
* **fehlend bleibt fehlend**: ohne `PERP_DATA_ENABLED=true`, ohne Daten oder
  bei unbelegbarer Qualität (`INVALID`/`DUPLICATE`/`CROSSCHECK`/`UNKNOWN`)
  liefert der Provider `null` — die Engine rechnet dann wie vor v1.54.0
  (statischer `PAPER_FUNDING_RATE_PCT_PER_8H`-Pfad bleibt unverändert), nie mit
  einer erfundenen 0-Rate. Treffer/Zähler: `provider.stats()`.

Details: [PERPETUAL_DATA.md](PERPETUAL_DATA.md) §1, §4, §6 und
[../CONFIGURATION.md](../CONFIGURATION.md#perpetual-daten-rma-p2-02-v1540).

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
Fenster) und `codeVersion` (Vergleichbarkeit über Releases). Seit v1.52.0
zusätzlich (additiv, Migration `drizzle/2026-09-20_backtest_trades.sql`):
`idempotency_key` (partiell UNIQUE), `trade_count`, `reconciliation_status`
(`RECONCILED`) und `reconciliation_json` (Abgleich-Evidenz, §5.1). Alt-Runs
tragen dort `NULL` — „kein Ledger persistiert“, nie „0 Trades“.

Zugriff (kein POST-Endpunkt — Runs entstehen NUR via CLI):

- `GET /api/firm/backtests?limit=1..100` (Default 20) — Liste, jüngste
  zuerst. Lädt NIE Trade-Zeilen (nur die Run-Zeile inkl. `tradeCount` /
  `reconciliationStatus`).
- `GET /api/firm/backtests/[id]` — ein Run per UUID (404 wenn unbekannt);
  additiv um `ledger`, `trades` (erste Seite) und `links.trades` ergänzt
  (§5.2). Bestehende Felder (`run`) sind unverändert.
- `GET /api/firm/backtests/[id]/trades` — Trade-Ledger paginiert (§5.2).

Alle verlangen `firm.read` (SEC-02-Muster, `no-store`) und melden einen
unerreichbaren DB-Stand als `503 BACKTEST_RUNS_UNAVAILABLE` mit
Handlungs-Hinweis (fail-closed statt leerer Liste).

### 5.1 Trade-Ledger `backtest_trades` (RMA-P1-04)

Ein Run ohne seine Trades war bis v1.51.x nur ein Aggregat: die Trade-Logs
wurden nach der Hash-Bildung verworfen. Seit v1.52.0 ist jeder Trade eines
Runs als eigene Zeile persistiert — die **Trade-Level-Wahrheitsquelle**
für Attribution (P1.6), Audits und Reproduzierbarkeit.

**Schema** (Modul `src/backtest/tradeLedger.ts`, reine Abbildung
`WalkForwardTradeRecord` → Zeile; Drizzle `backtestTrades`):

| Spalte | Typ | Bedeutung / Einheit / Rundung |
|---|---|---|
| `id` | uuid PK | technische Zeilen-ID |
| `run_id` | uuid FK → `backtest_runs.id` | **ohne** `ON DELETE CASCADE` (Repo-Konvention: Trades verhindern das Löschen ihres Runs) |
| `seq` | int, `UNIQUE (run_id, seq)`, ≥ 1 | stabile Sequenz in Report-Reihenfolge: Fenster ↑, IS vor OOS, Engine-Schließreihenfolge — Keyset-Cursor |
| `window_index` / `segment` | int ≥ 0 / `IS`·`OOS` | Walk-Forward-Fenster und Evaluationssegment |
| `trade_ref` | text, `UNIQUE (run_id, window_index, segment, trade_ref)` | Engine-Trade-ID (`POS-n`, je Fenster/Segment eindeutig) |
| `strategy_id`, `symbol`, `side` | text / `LONG`·`SHORT` | Strategie-Item, Instrument-ID (Replay-Ziel), Richtung |
| `qty` (> 0), `notional` (≥ 0) | numeric | Basismenge (roh) und Einstiegs-Notional in Quote (4 Stellen) |
| `entry_ts` / `exit_ts` | timestamptz, `exit ≥ entry` | Zeitstempel der Kerze, deren Schluss den Fill bepreist hat (Engine-`entryTime`/`exitTime`) |
| `entry_price` / `exit_price` | numeric > 0 | **Fill-Preise** des Paper-Simulators (Slippage/Spread bereits enthalten, roh) |
| `pnl_gross` | numeric | `qty · Δpreis` (8 Stellen), aus den Fill-Preisen abgeleitet |
| `pnl_net` | numeric | Engine-`pnl` = `pnl_gross − fees + funding` (4 Stellen; Identität wird beim Mappen geprüft, Toleranz 0,0002) |
| `pnl_pct` | numeric | `pnl_net / notional · 100` (4 Stellen) |
| `fees` (≥ 0), `slippage` (≥ 0) | numeric | Gebühren Ein- + Ausstieg (4 Stellen); Slippage-Kosten informativ (4 Stellen, bereits in den Fill-Preisen) |
| `funding` | numeric NULL-bar | Funding je Trade (8 Stellen, negativ = gezahlt); `NULL` = nicht ausgewiesen (≠ 0) |
| `exit_reason` | text (CHECK) | `STOP_LOSS`·`TAKE_PROFIT`·`SIGNAL_EXIT`·`MAX_HOLDING`·`RISK_STOP`·`END_OF_DATA` |
| `duration_bars` | int ≥ 1 | Haltedauer in Kerzen; `durationMs` wird aus den Zeitstempeln abgeleitet (keine redundante Spalte) |
| `provenance_json` | jsonb | `{v:1, source:"walk-forward", engineTradeId, windowFrom, windowTo, ruleSignature, executionModel, simulatorSeed}` |
| `created_at` | timestamptz | Schreibzeitpunkt (= Run-`created_at`, Berechnungszeitpunkt) |

Alle Zahlen werden als endliche Dezimal-Strings geschrieben (`decimalString`:
kein `NaN`/`Infinity`/Exponent) und mit `Number()` gelesen; das Mapping ist
verlustfrei (`tradeRowToLog(row)` reproduziert das Engine-Log exakt, Test
„Roundtrip“). Ungültige Trades (nicht endlich, `qty ≤ 0`, Preis ≤ 0,
negative Gebühren, `exit < entry`, unbekannte Enums, verletzte
PnL-Identität, Reihenfolgebruch, doppelte Trade-ID) werden **vor** jedem
DB-Zugriff mit `TradeLedgerError` (`ledger:invalid-trade` /
`ledger:invalid-report`) abgewiesen.

**Atomarer, idempotenter Write** (`persistBacktestRun` in
`src/backtest/runStore.ts`):

1. Mapping + Abgleich (unten) laufen rein im Speicher; scheitern sie,
   wird nichts geschrieben.
2. Innerhalb EINER Transaktion: Lookup über `idempotency_key` → existiert
   der Run, wird er (nach Prüfung von Trade-Anzahl und Fenster-Hashes)
   als Replay zurückgegeben (`created: false`, gleiche UUID); sonst
   Run-Zeile + Trade-Zeilen (Chunks à 250) einfügen, **Read-back** aller
   Zeilen aus der Transaktion, erneuter Abgleich — erst bei identischer
   Evidenz `COMMIT`. Jeder Fehler (DB-Constraint, Exception, Read-back-
   Abweichung) rollt Run UND Trades zurück (Test „Fehler bei Trade N“).
3. Idempotency-Key (Default): `wf1:` + sha256 über die Lauf-Identität
   (Art, Instrument, Timeframe, Zeitraum, Regel-Signatur + -Symbol,
   Fensterparameter, Kostenprofil, Code-Version, Trade-Hashes aller
   Fenster) — ohne `createdAt`, damit ein Retry desselben Laufs denselben
   Key ergibt. Der partielle UNIQUE-Index löst auch parallele Retries auf
   (SQLSTATE 23505 ⇒ erneuter Lookup ⇒ Replay): nie zwei Runs, nie
   doppelte Sequenzen. Gleicher Key mit anderem Inhalt ⇒
   `ledger:idempotency-conflict` (kein stilles Replay); eine Run-UUID mit
   fremdem Key ⇒ `persist:run-id-conflict`.
4. Audit (Klasse `telemetry`, nach dem Commit): `BACKTEST_RUN_PERSISTED`
   (INFO) bzw. `BACKTEST_RUN_PERSIST_FAILED` (WARN, mit Fehlercode);
   bounded Metrik `backtest_run_persist_total{result,reason}`
   (`created` · `replayed` · `failed`).

**Abgleich Ledger ↔ Run-Aggregate** (`reconcileTradeLedger`, Evidenz in
`reconciliation_json`): je Fenster × Segment und je Aggregat werden
verglichen — Trade-Anzahl und Gewinner (exakt), Netto-PnL (exakt gegen das
4-stellige `netPnl` des Reports), Gebühren und Slippage
(|Δ| ≤ 0,005 + n · 5·10⁻⁵, weil die Fenster-Kennzahlen auf 2 Stellen, die
Trade-Werte auf 4 Stellen gerundet sind), Funding (|Δ| ≤ 10⁻⁶ + n · 10⁻⁸)
und der **Trade-Hash** (`hashTrades(rows → logs)` muss dem gespeicherten
`tradeHash` gleichen). Jede Abweichung ⇒ `ledger:reconciliation-mismatch`,
der Run wird **nicht** geschrieben (kein Status „inkonsistent“ in der DB —
inkonsistente Runs existieren nicht). Der Equity-PnL (`pnl`, aus der
Equity-Kurve) darf vom Ledger-PnL (`netPnl`, Σ Trades) abweichen: die
Differenz ist die END_OF_DATA-Glattstellung nach dem letzten Snapshot und
wird als `equityLedgerGap` ausgewiesen, nicht kaschiert.

**Volumen & Query-Plan:** Ein Run erzeugt typischerweise 10²–10⁴ Zeilen
(Fensteranzahl × Trades je Fenster; `WF_MAX_SPAN_DAYS` deckelt implizit).
Gemessen (PostgreSQL 17, 20 000 Zeilen eines Runs): ≈ 3,8 MB Heap, ≈ 11 MB
inkl. Indizes (≈ 550 B/Zeile). Alle Lesepfade sind Index-Range-Scans ohne
Sort-Knoten:

| Query | Plan |
|---|---|
| Keyset-Seite `run_id = ? AND seq > ? ORDER BY seq LIMIT n+1` | `Index Scan using backtest_trades_run_seq_unique` |
| Filter `window`/`segment` | `Index Scan using backtest_trades_run_window_idx (run_id, window_index, segment, seq)` |
| Filter `symbol` | `Index Scan using backtest_trades_run_symbol_idx (run_id, symbol, seq)` |
| Existenz/Zählung je Run, FK-Prüfung beim Löschen | `backtest_trades_run_seq_unique` |

**Retention/Löschung:** Es gibt — wie für `backtest_runs` — keinen
Lösch-Endpunkt und kein Cascade. Ein Run mit Ledger lässt sich nur
löschen, wenn zuerst seine Trades gelöscht werden (`DELETE FROM
backtest_trades WHERE run_id = …`, dann der Run); ein Retention-Job wäre
ein eigenes, dokumentiertes Vorhaben (bewusst nicht Teil von RMA-P1-04).
Rollback der Migration (nur wenn nötig, verliert das Ledger):
`DROP TABLE backtest_trades; ALTER TABLE backtest_runs DROP COLUMN
reconciliation_json, DROP COLUMN reconciliation_status, DROP COLUMN
trade_count, DROP COLUMN idempotency_key;` — Alt-Code (v1.51.x) liest die
Run-Zeile danach unverändert.

### 5.2 Read-API des Trade-Ledgers

`GET /api/firm/backtests/[id]/trades` (und dieselben Parameter auf
`GET /api/firm/backtests/[id]`, dessen `trades` die ERSTE Seite enthält):

| Parameter | Bedeutung |
|---|---|
| `limit` | 1..500, Default 100 (hartes Limit — größere Werte ⇒ 400 `INVALID_TRADE_LIMIT`) |
| `cursor` | opaker Cursor der Vorseite (`nextCursor`); Seite beginnt NACH der letzten gelieferten `seq` (Keyset, kein OFFSET). Ungültig ⇒ 400 `INVALID_TRADE_CURSOR` |
| `segment` | `IS` · `OOS` |
| `window` | Fensterindex ≥ 0 |
| `symbol` | Instrument-ID (≤ 64 Zeichen `[A-Za-z0-9:_./-]`) |
| `side` | `LONG` · `SHORT` |
| `exitReason` | einer der sechs Exit-Gründe |

Unbekannte Filterwerte ⇒ 400 `INVALID_TRADE_FILTER` (nie stilles
Ignorieren). Antwort: `{ ok, runId, ledger, trades }` mit
`ledger = { status: "RECONCILED" | "UNAVAILABLE", tradeCount, idempotencyKey,
reconciliation }` und `trades = { items[], nextCursor, limit, filter }`;
`nextCursor: null` markiert die letzte Seite. Jedes Item trägt `seq`,
`windowIndex`, `segment`, `tradeRef`, `symbol`, `side`, `qty`, `notional`,
`entryTs`/`exitTs` (ISO), `entryPrice`/`exitPrice`, `pnlGross`, `pnlNet`,
`pnlPct`, `fees`, `funding` (`null` möglich), `slippage`, `exitReason`,
`durationBars`, `durationMs`, `provenance`. Alt-Runs (vor v1.52.0) liefern
`ledger.status = "UNAVAILABLE"`, `tradeCount = null` und eine leere Seite
mit Hinweis — nie „0 Trades“. Unbekannte UUID ⇒ 404
`BACKTEST_RUN_NOT_FOUND`, ungültige UUID ⇒ 400 `INVALID_RUN_ID` (beides vor
jedem DB-Zugriff bzw. Ledger-Read).

---

## 6. CLI-Referenz (`scripts/run-backtest.ts`)

```sh
node --import tsx scripts/run-backtest.ts \
  --instrument=BITUNIX:BTCUSDT --timeframe=1h \
  --from=2024-01-01 --to=2026-01-01 \
  --rule-id=<uuid> | --rule-file=./regel.json \
  [--is-days=90] [--oos-days=30] [--idempotency-key=<key>] [--skip-db]
```

| Flag | Pflicht | Bedeutung |
|---|---|---|
| `--instrument` | ja | Instrument-ID wie im HistoricalStore (Replay-Ziel) |
| `--timeframe` | nein (Default `1h`) | Kerzen-Periodizität (Store-Allowlist) |
| `--from` / `--to` | ja | Zeitraum (ISO-8601 oder Epoch-ms; muss mind. 1 IS+OOS tragen) |
| `--rule-id` | genau eine Regelquelle | Regel-UUID aus `trade_rules` |
| `--rule-file` | genau eine Regelquelle | Pfad zu einer RuleSpec-JSON (wird sanitized + gegen `RULE_CEILINGS` geklemmt) |
| `--is-days` / `--oos-days` | nein | Fenster-Override (Bounds wie `WF_*`, sonst Env-Wert) |
| `--idempotency-key` | nein | eigener Lauf-Schlüssel (8..128 Zeichen `[A-Za-z0-9:_.-]`); Default: Inhalts-Fingerprint des Laufs (§5.1) |
| `--skip-db` | nein | keine Persistenz (nur Artefakte; Offline-Betrieb) |
| `--execution-model` | nein (Default `paper`) | `paper` oder `event_replay` (§3.2: Order-Lifecycle mit Partial Fills, Latenz, Depth-Impact, punktgenaue `FUNDING_DUE`-Ereignisse aus der Perp-Historie) |
| `--replay-latency-ms` | nein (Default 0) | Submit→Arrival-Latenz in ms (nur `event_replay`, ≥ 0) |
| `--replay-seed` | nein (Default 1) | Seed des Replay-Laufs (nur `event_replay`, Ganzzahl ≥ 0; salzt Order-IDs, kein RNG) |

Ablauf: Regel laden (DB oder Datei) → Kerzen aus dem HistoricalStore →
Instrument aus der Universe-Registry auflösen (fehlt sie: neutrales
Spot-Default, sichtbar in der Konsolenausgabe) → Walk-Forward-Lauf mit
kalibriertem Simulator + Funding-Konfiguration des Paper-Betriebs →
`persistBacktestRun` (Run + ALLE Trades in EINER Transaktion, idempotent;
Retry meldet „Idempotent: Lauf war bereits als Run … persistiert“) →
Artefakte `data/backtest/<runId>.json` (Report inkl. `trades`) +
`<runId>.md` (Zusammenfassung mit Equity- UND Ledger-PnL) unter der UUID
des persistierten Runs.

Regel-Symbol vs. Instrument: Regel-Spezifikationen tragen PAPER-kanonische
Symbole (z. B. `BTC/USDT`), Store-Reihen Venue-IDs (z. B.
`BITUNIX:BTCUSDT`). Die CLI replayt die Regel-Logik (Bedingung, Action,
Fenster — venue-agnostisch) gegen `--instrument`; beide IDs stehen im
Report (`ruleRef.ruleSymbol` vs. `instrumentId`) und in der
MD-Zusammenfassung — kein stiller Tausch.

Fail-closed: Fehlende/ungültige Flags, ungültige Regeln, leere Kerzenreihen
und zu kurze Zeiträume brechen mit Exit 1 ab (kein Run, kein Artefakt,
keine DB-Zeile). Schlägt die Persistenz fehl oder wird sie abgelehnt
(Ledger ≠ Aggregate, DB-Fehler), entsteht KEINE DB-Zeile (Transaktion
zurückgerollt); die Artefakte werden unter der Kandidaten-UUID trotzdem
geschrieben und der Exit-Code ist 1 (laut, nie still). Ein Lauf gilt erst
mit `RECONCILED`-Ledger als persistiert.

### 6.1 Performance-Baseline (`scripts/bench-backtest.ts`, STX-00-01 / `v0.6.0`)

```sh
# 3 Messpunkte x 3 Laeufe x 3 Pfade auf einer echten Store-Reihe (ohne DB, ohne Netz)
npm run bench:backtest -- --instrument=BINANCE:BTCUSDT --dir=data/history
```

| Flag | Pflicht | Bedeutung |
|---|---|---|
| `--instrument` | ja | Instrument-ID im `HistoricalStore` |
| `--timeframe` | nein (Default `1h`) | gemessener Timeframe (Store-Allowlist) |
| `--dir` | nein (Default `data/history`) | Store-Verzeichnis (nur lesend) |
| `--sizes` | nein (Default `1000,5000,17520`) | Messpunkte; nicht verfügbare Größen werden gemeldet und übersprungen (Fit braucht ≥ 2) |
| `--repeat` | nein (Default `3`) | gemessene Läufe je Messpunkt (berichtet wird der Median plus alle Rohwerte) |
| `--warmup-runs` | nein (Default `1`) | ungemessene Läufe je Messpunkt vor der Messung (`0` = Kaltmessung, misst den JIT-Sprung mit) |
| `--warmup-bars` | nein (Default `30`) | Warmup-Kerzen der Messpfade |
| `--paths` | nein | Teilmenge von `rule,multiAsset,cache` |
| `--execution-model` | nein (Default `legacy`) | gilt nur für den `multiAsset`-Pfad (`legacy` = eingefrorener Default, `paper` = Fill-Simulator) |
| `--out-dir` / `--no-write` | nein (Default `data/bench`) | Artefakt-Ziel bzw. „nur stdout" |

Der aktuelle Benchmark misst **auf derselben verfügbaren Kerzenreihe und mit
derselben Regel** drei Pfade: `backtestRule()` (Single-Rule, seit `v0.11.0`
mit einem Cache-Aufbau vor der Schleife), `runMultiAssetBacktest()` (Engine,
Indikator-Cache) und die reine `buildIndicatorCache()` +
`snapshotFromCache()`-Schleife. Berichtet werden Median, `ms/1000 Kerzen`, der
log-log-Fit-Exponent über die Messpunkte und die „1 Zelle Matrix"-Rechnung
(Default 7 500 Zellen à 17 520 Kerzen → Kernstunden seriell). Es wird **kein**
`src/db`-Modul importiert und nur nach `data/bench/` geschrieben (gitignoriert).

**Historisches Ergebnis vor dem Cache (2026-09-29, 2 vCPU, 17 520 echte
Stundenkerzen):** das damalige `backtestRule()` maß Exponent **1,99** / 25 986 ms
je Zelle ⇒ 54,14 Kernstunden für 7 500 Zellen; Engine Exponent **1,01** /
213,5 ms ⇒ 0,44 Kernstunden (121,7×); Indikator-Cache 72,2 ms (360,1×).
Die Screening-Entscheidung über die Multi-Asset-Engine bleibt bestehen. Die
Original-HistoricalStore-Reihe fehlt in diesem Checkout; der ergänzende
synthetische Same-Series-Vergleich nach 08-04 (20 253,6 ms → 64,5 ms, 314,1×)
ist **keine** Wiederholung oder Ersatz der historischen Zahl. Rohzahlen,
Messaufbau, Folgemessung und Grenzen: [BENCH-BASELINE.md](audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md) §11.

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
- Performance-Baseline (STX-00-01): [audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md](audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md)
- Paper-Kostenmodell: [PAPER_TRADING.md](PAPER_TRADING.md) (§3), Funding:
  `src/lib/funding.ts`
- Flags: [CONFIGURATION.md](../CONFIGURATION.md) („Walk-Forward-Backtesting“)
- Findings: [GAP-01](audits/2026-09-18-feature-gap/findings/GAP-01-backtesting-walk-forward.md),
  [RMA-P1-04](audits/2026-09-20-roadmap-audit/findings/RMA-P1-04-backtest-trades.md)
  (Trade-Ledger)
- Migrationen: `drizzle/2026-09-19_backtest_runs.sql`,
  `drizzle/2026-09-20_backtest_trades.sql`
- Tests: `tests/backtest.engine.test.ts`, `tests/backtest.step.nosynthetic.test.ts`,
  `tests/backtest.tradeLedger.test.ts` (Mapping, Abgleich, Idempotenz,
  Rollback, Cursor-API — DB-Teile ping → skip)

## Monte-Carlo-/Trade-Resampling (RMA-P6-02, v1.72.0)

Aufbauend auf dem persistierten Trade-Ledger (§5.1) simuliert
`scripts/run-montecarlo.ts` (`npm run montecarlo`) aus den OOS-Trades eines
Runs reproduzierbare IID- und blockweise Resamples sowie explizite
Kostenstressszenarien und berichtet robuste Quantile (p05/p50/p95) für
End-Equity, MaxDD, Ruin, Sharpe und Losing Streak inklusive
Exceedance-Wahrscheinlichkeiten und Monte-Carlo-Standardfehler. Determinismus
über persistierten Seed (`mulberry32-v1`) + Config + unveränderliche Quelle;
idempotente Persistenz als bounded Summary in `backtest_monte_carlo_runs`
(keine Rohpfade); Read-API `GET /api/firm/montecarlo`. Bewusst KEIN Ersatz
für Walk-Forward/OOS und KEINE Live-Risikofreigabe — Modell, Formeln,
Grenzen und Rollback: [MONTE_CARLO.md](MONTE_CARLO.md).

## Execution-Quality-Evidenz

Mit `EXECUTION_QUALITY_ENABLED=true` erfasst der vorhandene Paper-Simulator
normalisierte Intent-/Fill-/Benchmarkereignisse. Walk-forward-JSON enthält diese
Evidenz; Run-, Trade- und Quality-Ledger werden atomar persistiert. Wiederholungen
nutzen den bestehenden Run-Key. Kerzenbasierte Quality-Zeitpunkte liegen am
abgeschlossenen Bar-Ende (Open + Timeframe), nicht am historischen Open-Zeitstempel
des Legacy-Trade-Ledgers. Referenzpreise/Mids und Latenzen sind als **modeled**
markiert. Fehlende historische L1-Markouts/VWAPs werden nicht aus späteren Kerzen
erfunden. Bestehende Trading-/Kostenentscheidungen und Defaults bleiben unverändert.

[Gemeinsamer Vertrag und Formeln](../src/executionQuality/README.md).
