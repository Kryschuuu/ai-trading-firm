# Claude Trading Indicator (CTI)

**Stand:** 2026-10-03 · **Modul:** `src/signals/` · **CLI:** `npm run cti`
**Version:** `0.12.0` · **Status:** Implementiert

> **Beta-Hinweis:** Das System handelt ausschließlich im Paper-Modus. Der CTI
> erzeugt Signale und Handlungsabsichten — ausgeführt wird nur, was der
> Ausführungs-Adapter freigibt (Live-Gate, Kill-Switch, Risk-Limits bleiben
> unverändert zuständig).

---

## 1. Was der CTI ist

Der **Claude Trading Indicator** ist die 1:1-Portierung eines Pine-Script-v6-
Indikators (`@version=6`, shorttitle `CTI`) nach TypeScript. Er verdichtet
acht klassische Indikatoren zu **vier Dimensionen** und erzeugt ein Signal
nur, wenn **alle eingeschalteten Dimensionen einstimmig** in dieselbe
Richtung zeigen — ein bewusst seltener, selektiver Ansatz.

Leitgedanke der Portierung: **Es gibt genau einen Rechenkern.**
`src/signals/cti/runtime.ts` ist ein inkrementeller Zustandsautomat
(„Kerze rein, Bar-Zustand raus"). Backtest, Live-Engine und CLI füttern
denselben Automaten. Backtest-↔-Live-Parität ist damit keine Behauptung,
sondern eine Eigenschaft der Architektur; Look-ahead ist strukturell
unmöglich, weil der Automat immer nur die gerade geschlossene Kerze sieht.

### Dateien

| Datei | Rolle |
| ----- | ----- |
| `src/signals/pine.ts` | Pine-Primitiven (`ta.sma`, `ta.ema`, `ta.rma`, `ta.stdev`, `ta.rsi`, `ta.macd`, `ta.stoch`, `ta.atr`, `ta.obv`, `ta.supertrend`, `ta.dmi`, Bollinger) als Streaming-Akkumulatoren |
| `src/signals/cti/params.ts` | Einstellbare Inputs, interne Komponenten-Perioden, Bounds/Klemmung, Aufwärmbedarf |
| `src/signals/cti/types.ts` | Bar-/Votum-/Lesewert-Typen, `CtiInputError` |
| `src/signals/cti/runtime.ts` | **Rechenkern** (`CtiRuntime`, `computeCtiSeries`, `ctiSignals`) |
| `src/signals/cti/dashboard.ts` | Dashboard-Tabelle und Alert-Texte wie im Skript |
| `src/signals/cti/backtest.ts` | Anbindung an die Multi-Asset-Backtest-Engine |
| `src/signals/cti/engine.ts` | Trading-Engine: Signale → Handlungsabsichten (IO-frei) |
| `scripts/run-cti.ts` | CLI (`npm run cti`) — liest, rechnet, handelt nicht |

Das Modul ist **frei von IO**: kein `src/db`, kein Broker, kein LLM, kein
`next`. Ein Test nagelt das fest (`tests/cti.engine.test.ts`, Abschnitt
„Architektur"), damit der Indikator aus Skripten, Tests, Backtest und
Live-Pfad gleichermaßen importierbar bleibt.

---

## 2. Das Zwei-Stufen-Konsensmodell

### Stufe 1 — jede Dimension stimmt intern einstimmig ab

Eine Dimension ist **bullisch** nur, wenn **alle** ihre Komponenten bullisch
sind; **bärisch** nur, wenn alle bärisch sind; sonst **neutral**.

| Dimension | Komponenten (interne Perioden) | bullisch, wenn … |
| --------- | ------------------------------ | ---------------- |
| **Trend** | EMA 200 · Supertrend (ATR 10, Faktor 3,0) · Bollinger-Basis SMA 20 (Mult 2,0) | `close > EMA200` **und** Supertrend-Richtung aufwärts **und** `close > Basis` |
| **Momentum** | MACD 12/26/9 · RSI 14 · Stochastik 14/3/3 | `MACD > Signal` **und** `RSI > 50` **und** `%K > %D` |
| **Volatilität** | DMI/ADX 14/14, Mindeststärke `ADX ≥ 20` | `ADX ≥ 20` **und** `+DI > −DI` (sonst neutral) |
| **Volumen** | OBV vs. `SMA(OBV, 10)` | `OBV > SMA(OBV, 10)` |

Ein `na`-Wert (Aufwärmphase) ergibt **neutral**, nie eine stille 0.

### Stufe 2 — Verdikt über die eingeschalteten Dimensionen

```text
enabledCount = Anzahl eingeschalteter Dimensionen
BULL  ⇔ bullCount == enabledCount  (und enabledCount > 0)
BEAR  ⇔ bearCount == enabledCount  (und enabledCount > 0)
sonst   NONE
```

Ein einziges neutrales Votum verhindert das Verdikt. Sind alle vier
Dimensionen abgeschaltet, feuert der Indikator nie.

### Filter 1 — Persistenz (`persistBars`, Default 2)

Pine prüft `bullStreak == persistBars` — **Gleichheit, nicht `>=`**. Das
Signal feuert also **einmal je Strecke**, nicht auf jedem weiteren Bar, auf
dem das Verdikt noch hält.

### Filter 2 — Sperrfrist (`minBarsBetween`, Default 10)

Seit dem letzten Signal müssen mindestens `minBarsBetween` Bars vergangen
sein. Fällt der `== persistBars`-Moment in die Sperrfrist, ist das Signal
für diese Strecke **verloren** — es wird **nicht nachgeholt**. Auch das ist
Originalverhalten und wird hier absichtlich nicht „verbessert".

Feuern Kauf und Verkauf rechnerisch auf derselben Kerze, gewinnt der Kauf
(`sellSignal := … and not buySignal`). In der Praxis schließen sich BULL und
BEAR ohnehin aus.

---

## 3. Parameter

**Einstellbar** (wie im Skript — mehr gibt es nicht):

| Parameter | Default | Bounds | Bedeutung |
| --------- | ------- | ------ | --------- |
| `useTrend` / `useMomentum` / `useVolatility` / `useVolume` | `true` | — | Dimension ein/aus |
| `atrLength` | 14 | 1 … 1000 (ganzzahlig) | ATR-Länge der Stop-Berechnung |
| `atrMultiplier` | 3.0 | 0,1 … 100 | Stop-Abstand = ATR × Multiplikator |
| `persistBars` | 2 | 1 … 1000 (ganzzahlig) | Bars, die das Verdikt halten muss |
| `minBarsBetween` | 10 | 0 … 10 000 (ganzzahlig) | Sperrfrist zwischen Signalen |

**Nicht einstellbar** (interne Konstanten, `CTI_COMPONENTS`): EMA 200,
Supertrend 10/3,0, Bollinger 20/2,0, MACD 12/26/9, RSI 14, Stochastik 14/3/3,
DMI/ADX 14/14 mit Schwelle 20, OBV-Glättung 10. Das entspricht dem Skript:
Diese Perioden sind dort fest verdrahtet.

**Klemmung ist sichtbar:** `resolveCtiParams()` korrigiert ungültige Werte
auf Bounds bzw. Defaults und meldet jedes korrigierte Feld in `clamped[]`.
CLI und `runCtiBacktest()` geben diese Liste aus — eine stille Korrektur
wäre eine zweite Wahrheit über den Indikator.

Die visuellen Inputs des Skripts (`showDashboard`, `showBackground`) sind
bewusst **nicht** portiert: Sie beeinflussen keine Signale.

---

## 4. Stops

```text
longStop  = close − ATR(atrLength) × atrMultiplier
shortStop = close + ATR(atrLength) × atrMultiplier
```

Beim Signal wird der jeweilige Stop **eingefroren** (`activeLongStop` /
`activeShortStop`) — er wird **nicht** bar-für-bar nachgezogen. Ein
**erneutes Signal derselben Richtung** setzt ihn dagegen neu
(`activeLongStop := longStop`), wie im Skript. In einer laufenden Bewegung
wirkt das wie ein Nachziehen in Signalschritten.

Die Strecke endet, sobald der Kurs den Stop durchhandelt
(`low <= activeLongStop` bzw. `high >= activeShortStop`); `CtiBar.stopHit`
meldet das.

> **Unterschied Chart ↔ Handel:** Pine prüft den Stop auch auf dem Signalbar
> selbst (dort endet die gezeichnete Linie). Eine Position entsteht aber erst
> **mit dem Schlusskurs** dieses Bars — ein vorher gelaufenes Tief kann sie
> nicht treffen. Backtest und Live-Engine prüfen den Stop deshalb ab der
> Folgekerze; der Indikator meldet `stopHit` unverändert, damit Chart und Log
> vergleichbar bleiben.

---

## 5. Aufwärmphase (kein Signal vor …)

| Dimension | langsamste Komponente | erste Kerze mit Votum (1-basiert) |
| --------- | --------------------- | --------------------------------- |
| Trend | EMA 200 | 200 |
| Momentum | MACD 12/26/9 | 34 |
| Volatilität | DMI/ADX 14/14 | 28 |
| Volumen | `SMA(OBV, 10)` | 11 |

`ctiWarmupBars(params)` = langsamste **aktive** Dimension + `persistBars` − 1
(der erste Bar der Strecke ist derselbe Bar). Mit Defaults: **201 Kerzen**.

`runCtiBacktest()` hebt `warmupBars` automatisch auf mindestens diesen Wert
an — ein zu kurzer Warmup würde Signale auswerten, die der Indikator noch gar
nicht bilden kann.

---

## 6. Eingabeprüfung (fail-closed)

`CtiRuntime.push()` wirft `CtiInputError` mit klassifiziertem Code:

| Code | Auslöser |
| ---- | -------- |
| `INVALID_CANDLE` | nicht endliche Werte, Kurs ≤ 0, `volume < 0`, `high < low` |
| `NON_MONOTONIC_TIME` | Zeitstempel kleiner als der zuletzt verarbeitete |
| `DUPLICATE_BAR` | derselbe Zeitstempel zweimal |

Ein abgewiesener Bar verändert den Zustand nicht. Das ist wichtiger, als es
klingt: Ein doppelt eingespeister Tick würde Streaks und Sperrfrist
verfälschen und damit Signale erzeugen, die es im Chart nicht gibt.

---

## 7. Backtest-Integration

### 7.1 Vertrag

Die Engine kennt seit v0.12.0 einen dritten Strategietyp neben `rule` und
`setup` (`src/backtest/types.ts`):

```ts
type BacktestStrategyItem =
  | { type: "rule";   spec: RuleSpec; id?: string }
  | { type: "setup";  setup: TradeSetupProposal; id?: string }
  | { type: "signal"; signal: BacktestSignalStrategy; id?: string };

interface BacktestSignalStrategy {
  id: string;
  symbol: string;
  onBar(bar: BacktestSignalBar): BacktestSignalDecision | null;
}

interface BacktestSignalBar {
  symbol: string;
  index: number;     // Kerzenindex dieses Symbols
  barStep: number;   // 1-basierter Schritt der Engine-Zeitachse
  time: number;
  candle: CandleLike; // GENAU EINE geschlossene Kerze — keine Reihe
  warmup: boolean;
}

interface BacktestSignalDecision {
  side: "LONG" | "SHORT" | "FLAT";
  stopLoss: number | null;
  takeProfit: number | null;
  riskBudgetPct?: number;
  maxPositionPct?: number;
  closeOpposite?: boolean; // Default true
}
```

**Warum das kein Look-ahead sein kann:** Die Strategie bekommt pro Schritt
genau eine geschlossene Kerze und **keine** Kerzenreihe. Sie hat damit
keinen Zugriff auf die Zukunft, unabhängig davon, was sie rechnet. Der
Einstieg erfolgt zum Schlusskurs **dieses** Bars — genau dort, wo der Chart
das Dreieck zeichnet. Ein Test prüft diesen Vertrag Feld für Feld, ein
zweiter, dass das Abschneiden späterer Kerzen keinen Trade bis `t` ändert.

### 7.2 Was die Engine mit einer Entscheidung macht

1. `SHORT` ohne `enableShorts` wird zu `FLAT` **herabgestuft**, nicht
   verworfen: Der Guardrail darf Risiko nur senken — eine Long-Position
   gegen ein Verkaufssignal offen zu lassen, würde es erhöhen.
2. Gleiche Richtung bereits offen ⇒ **kein Nachkauf**, aber `stopLoss` und
   `takeProfit` werden auf den neuen Stand gesetzt (Stop-Nachschärfung).
3. Gegenposition offen und `closeOpposite !== false` ⇒ `SIGNAL_EXIT` zum
   Schlusskurs (gleiches Kostenmodell wie jeder andere Ausstieg), danach
   Drehung.
4. Erst dann greifen Cash-Puffer, `maxOpenPositions`, Risikobudget,
   `maxPositionPct` und — falls aktiv — Volatility-Targeting.
5. Entscheidungen aus der Aufwärmphase (`barStep < warmupBars`) werden
   verworfen; gefüttert wird die Strategie trotzdem auf **jedem** Bar, damit
   ihr Zustand korrekt aufgebaut wird.

`executionModel: "event_replay"` **lehnt Signalstrategien ab** (Fehler statt
stiller Umdeutung): Der Order-Lifecycle mit Teilfüllungen bildet eine
Richtungsumkehr nicht ab.

### 7.3 CTI-Strategie

```ts
import { runCtiBacktest, ctiStrategyItem } from "@/signals/cti";

const outcome = runCtiBacktest({
  candlesBySymbol: { "BITUNIX:BTCUSDT": candles },
  options: { tradeShorts: true },          // false = Long-only (Spot)
  config: { initialCapital: 10_000, timeframe: "1h" },
});
```

| CTI | Backtest |
| --- | -------- |
| `BUY` | Long zum Schlusskurs des Signalbars, Stop = `activeLongStop` |
| `SELL` (Shorts erlaubt) | Short zum Schlusskurs, Stop = `activeShortStop` |
| `SELL` (Long-only) | `FLAT` — offene Long-Position wird glattgestellt |
| kein Kursziel im Skript | `takeProfit = null` (Option `takeProfitRR` ist eine bewusste Abweichung) |

`runCtiBacktest()` setzt als Voreinstellung `executionModel: "paper"`
(derselbe Fill-Simulator wie der PaperBroker inklusive Funding),
`enableShorts` gemäß `tradeShorts` und `warmupBars ≥ ctiWarmupBars()`. Jede
dieser Vorgaben ist über `config` überschreibbar.

Das Ergebnis trennt **Indikator-Signale** von **ausgeführten Trades**:
`outcome.signals[symbol]` zählt, was der Indikator geliefert hat. Stehen im
Report weniger Trades, hat ein Guardrail gegriffen — diese Differenz soll
sichtbar sein, nicht verschwinden.

### 7.4 Nebenbefund: Leerverkäufe im Portfolio

Bei der Arbeit an diesem Modul fiel auf, dass `BacktestPortfolio` jede
Position wie einen Kauf verbuchte (Cash − Notional beim Öffnen, + Notional
beim Schließen). Für Leerverkäufe lief die Equity-Kurve damit **gegenläufig**
zum geloggten Trade-PnL. Seit v0.12.0 bucht ein Short nur Gebühren und
Ergebnis (die Sicherheit bleibt im Cash), und die Mark-to-Market-Bewertung
nutzt den Positions-PnL. Long-Läufe sind davon arithmetisch nicht betroffen.
Details: [BACKTEST_ENGINE.md](BACKTEST_ENGINE.md) §3.

---

## 8. Trading-Engine (Live-/Paper-Pfad)

`CtiTradingEngine` (`src/signals/cti/engine.ts`) macht aus Signalen
**Handlungsabsichten** und hält nach, in welcher Richtung sie steht. Sie
verwaltet **kein** Kapital und keine Stückzahl — Sizing und Guardrails
gehören in den Ausführungs-Adapter, wo der Rest des Systems sie bereits
implementiert hat.

Ablauf je geschlossener Kerze:

1. Kerze in den Automaten (derselbe wie im Backtest).
2. **Schutz zuerst:** aktiver Stop durchhandelt ⇒ `EXIT` mit Grund
   `STOP_LOSS` zum Stop-Preis — vor jeder Signalauswertung.
3. Signal: Gegenrichtung offen ⇒ `EXIT` (`OPPOSITE_SIGNAL`) + `ENTER`;
   flach ⇒ `ENTER`; gleiche Richtung ⇒ `ADJUST_STOP` (`REARM_STOP`).
4. Absichten an den Port. Der interne Zustand wird **erst nach Bestätigung**
   fortgeschrieben.

```ts
interface CtiExecutionPort {
  readonly name: string;
  apply(intent: CtiIntent): Promise<CtiExecutionResult> | CtiExecutionResult;
}
```

Der Adapter darf alles prüfen, was das System sonst auch prüft (Kill-Switch,
Live-Gate, Risk-Limits). Jedes `ok: false` akzeptiert die Engine wortlos und
bleibt bei ihrer bisherigen Sicht; wirft der Port, gilt das als Ablehnung
(`PORT_ERROR:<Name>`). Ohne Port arbeitet die Engine im Trockenlauf — nützlich
für Simulation und Tests.

Weitere Bausteine: `register(symbol, history)` wärmt den Indikator auf, ohne
Absichten zu erzeugen; `adoptPosition()` übernimmt eine bestehende
Broker-Position nach einem Neustart; `status()` meldet Aufwärmstand, Verdikt,
Streaks, Position sowie Zahl der erzeugten und abgelehnten Absichten.

---

## 9. CLI

```bash
# Signale + Dashboard des letzten Bars
npm run cti -- --instrument=BITUNIX:BTCUSDT --timeframe=1h

# zusätzlich Backtest über dieselbe Reihe
npm run cti -- --instrument=BITUNIX:BTCUSDT --timeframe=1h \
  --mode=backtest --capital=10000 --execution=paper \
  --out=data/cti/btc-1h.json

# Parameter-Varianten
npm run cti -- --instrument=BITUNIX:BTCUSDT --timeframe=4h \
  --persist-bars=3 --min-bars-between=20 --atr-mult=2.5 --long-only
```

Das Skript liest aus dem HistoricalStore (`npm run market:sync` /
`npm run history:import-csv` befüllen ihn), schreibt **nicht** in die
Datenbank und löst **keine** Order aus. Ausgabe: Dashboard-Tabelle,
Signalliste (letzte 20), optional Backtest-Kennzahlen und ein JSON-Report.

---

## 10. Bewusste Abweichungen vom Original

| Thema | Entscheidung |
| ----- | ------------ |
| Intrabar-Repainting | **Nicht** portiert. Der Port arbeitet ausschließlich auf Bar-Schluss (entspricht „Once Per Bar Close"). Die laufende Kerze gehört nicht in den Automaten. |
| Visuals (Plots, Hintergrund, Dreiecke) | Nicht portiert — keine Signalwirkung. Die Dashboard-**Texte** und Alert-Wortlaute sind wortgleich übernommen. |
| Kursziel | Das Skript kennt keines; `takeProfit` ist `null`, sofern der Aufrufer nicht ausdrücklich `takeProfitRR` setzt. |
| Positionsgröße | Nicht Teil des Skripts; sie kommt aus den Guardrails der Engine (Risikobudget, `maxPositionPct`). |
| Stop auf der Einstiegskerze | Der Indikator meldet ihn (Chart-Treue), der Handel ignoriert ihn (die Position existiert erst ab dem Schluss dieser Kerze). |

---

## 11. Tests

| Datei | Deckt ab |
| ----- | -------- |
| `tests/signals.pine.test.ts` | Primitiven gegen unabhängige Referenzformeln, `na`-Verhalten, Supertrend-Aufwärmspur, fail-closed Perioden |
| `tests/cti.indicator.test.ts` | Konsens-Invarianten über die gesamte Reihe, Persistenz/Sperrfrist, Kausalität (Präfix-Gleichheit), Streaming == Batch, Stops, Eingabeprüfung, Parameter, Dashboard/Alerts |
| `tests/cti.backtest.test.ts` | Vertrag `BacktestSignalBar`, kein Look-ahead, Determinismus, Signal ⇒ Trade, Stop-/Umkehr-Ausstiege, Guardrails, Kosten, Equity == Σ Trade-PnL |
| `tests/cti.engine.test.ts` | Absichten und ihre Reihenfolge, Port-Ablehnung/-Fehler, Reconciliation, Parität Live ↔ Backtest, IO-Freiheit des Moduls |
| `tests/backtest.unit.test.ts` | u. a. Regression: Leerverkauf-Buchung (Cash-Bewegung == Trade-PnL) |

Alle Fixtures sind deterministisch (fester Seed, keine `Math.random()`,
keine Uhr) — `tests/cti.fixtures.ts`.

---

## 12. Verwandte Dokumente

* [BACKTEST_ENGINE.md](BACKTEST_ENGINE.md) — Engine-Basis, Portfolio, Kostenmodell
* [BACKTESTING.md](BACKTESTING.md) — Walk-Forward, Paper-Ausführung, CLI
* [HISTORY.md](HISTORY.md) — Historical Store (Datenquelle der CLI)
* [../CONTRIBUTING.md](../CONTRIBUTING.md) — Pflicht-Checks vor jedem PR
