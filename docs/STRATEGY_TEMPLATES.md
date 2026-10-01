# Strategie-Templates — Katalog (aus dem Code generiert)

> **Nicht von Hand bearbeiten.** Diese Datei ist eine Projektion von
> `STRATEGY_TEMPLATES` aus [`src/strategies/catalog.ts`](../src/strategies/catalog.ts);
> erzeugt mit `npm run docs:templates`
> ([`scripts/gen-strategy-templates-doc.ts`](../scripts/gen-strategy-templates-doc.ts)).
> [`tests/strategies.templates.test.ts`](../tests/strategies.templates.test.ts)
> vergleicht sie byteweise mit der Renderer-Ausgabe — eine Parameter-, Timeframe-
> oder Annahmen-Änderung ohne neuen Generatorlauf lässt die Tests fehlschlagen.

Sechs versionierte Strategie-Artefakte (Phase 3, Abnahme STX-03-10). Jedes
Artefakt ist eine **reine Funktion der Parameter** (`buildRule(params) => RuleSpecInput`,
STX-05); die einzige legale Transformation der Rohform ist `sanitizeRuleSpec()`
über [`src/strategies/compiler.ts`](../src/strategies/compiler.ts). Vertrag und
Klassen-/Regime-Vokabular: [`src/strategies/types.ts`](../src/strategies/types.ts),
`STRATEGY_CLASS_KEYS` ([`src/lib/signalDecay.ts`](../src/lib/signalDecay.ts)),
`MarketRegime` ([`src/lib/marketRegime.ts`](../src/lib/marketRegime.ts)).

## Übersicht

| Template | Klasse | Timeframes | Erwartete Regimes | Version | Parameter | Annahmen (kritisch) |
| --- | --- | --- | --- | --- | --- | --- |
| [`ema-adx-trend`](#ema-adx-trend) | `trend` | `1h`, `4h` | `TREND_UP` | 1 | 5 | 5 (1) |
| [`macd-momentum`](#macd-momentum) | `trend` | `1h`, `4h` | `TREND_UP` | 1 | 4 | 6 (2) |
| [`rsi-mean-reversion`](#rsi-mean-reversion) | `mean-reversion` | `15m`, `1h`, `4h` | `RANGE` | 1 | 6 | 7 (3) |
| [`bollinger-squeeze`](#bollinger-squeeze) | `breakout` | `1h`, `4h` | `RANGE`, `TREND_UP` | 1 | 6 | 7 (5) |
| [`vwap-pullback`](#vwap-pullback) | `trend` | `5m`, `15m`, `1h` | `TREND_UP` | 1 | 5 | 5 (4) |
| [`donchian-breakout`](#donchian-breakout) | `breakout` | `1h`, `4h` | `TREND_UP`, `RANGE` | 1 | 5 | 7 (6) |

## `ema-adx-trend`

**EMA/ADX Trend** — Trendfolge auf 1h/4h: Der Kurs muss mit klarer Marge über seinem EMA 50 liegen (Default 0,2 %), EMA 9 über EMA 21 stehen (Trendentscheidung, nicht Trendvermutung), der ADX(14) muss die Stärke bestätigen (Default 22) und die Signalkerze muss mindestens auf Höhe ihres 20er-Volumenschnitts schließen. Stop und Ziel sind feste Prozent- bzw. Chance/Risiko-Werte, kein ATR-Kanal.

- **Klasse:** `trend` (ADR-008, deklariert; nicht aus der ID abgeleitet)
- **Version:** 1 (v1; Teil des Artefakt-Hashs, 04-01)
- **Scope:** `SINGLE_SYMBOL`
- **Timeframes:** `1h`, `4h` (`SUPPORTED_TIMEFRAMES`, STX-01)
- **Erwartete Regimes:** `TREND_UP` (ADR-009, ohne `UNKNOWN`)
- **Pflichtfelder:** `trend`, `priceVsEma50Pct`, `adx14`, `volumeRatio`, `atrPct`
- **Bedingung (Defaults, Rohform `RuleSpecInput`):** `trend` eq „UP“ ∧ `priceVsEma50Pct` gte 0.2 ∧ `adx14` gte 22 ∧ `volumeRatio` gte 1

### Parameter

| Key | Label | Einheit | Art | Default | Min | Max | Step | mapsTo (Regelfeld) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `adxMin` | ADX-Mindestwert | Index | threshold | 22 | 15 | 35 | 1 | `adx14` |
| `ema50BufferPct` | Kurs mindestens über EMA 50 | % | threshold | 0.2 | 0 | 3 | 0.1 | `priceVsEma50Pct` |
| `volumeRatioMin` | Volumenverhältnis | ratio | threshold | 1 | 0.8 | 2 | 0.05 | `volumeRatio` |
| `stopLossPct` | Stop-Loss | % | threshold | 4 | 1 | 12 | 0.5 | `atrPct` |
| `takeProfitRR` | Chance/Risiko | ratio | ratio | 2 | 1 | 4 | 0.25 | `atrPct` |

### Annahmen

| ID | Kategorie | Kritisch | Aussage |
| --- | --- | --- | --- |
| `trendreihen-1h-4h` | MARKET | nein | Auf 1h/4h sind Trendreihen (EMA9 über EMA21 mit ausreichendem Abstand) häufiger als Seitwärtsphasen — der Markt liefert dem Filter überhaupt eine nennenswerte Zahl an Auslösungen, statt ihn monatelang leer laufen zu lassen. |
| `adx-29-kerzen` | DATA | **ja** | ADX(14) braucht 29 Kerzen (2 · 14 + 1); bei kürzerer Historie liefert das Feld null und die Bedingung `adx14 gte adxMin` scheitert fail-closed — ohne ADX wird nicht gehandelt. |
| `volumenfilter-reduzierte-transaktionskosten` | COST | nein | Die Volumenbedingung reduziert die Zahl der Transaktionen; die Gebühren bleiben dabei auf dem Niveau des Backtests (Kosten-Fallback je Timeframe, docs/BACKTESTING.md) — realer Slippage-Abschlag also nicht größer als modellierter. Ist er es doch, schrumpft die Edge pro Trade, nicht pro Signal. |
| `regime-trend-up` | REGIME | nein | Funktioniert in TREND_UP. In RANGE degradiert die ADX-Bedingung zur bloßen Rauschunterdrückung: Ein auslaufender Trend kann kurz über der ADX-Schwelle stehen, während die Richtung bereits gedreht hat — die Bedingung unterscheidet dann nicht mehr zwischen Trend und Range, sie verzögert nur. |
| `ema50-min-50-kerzen` | DATA | nein | priceVsEma50Pct bezieht sich auf einen echten EMA 50: buildSnapshotFromCandles() rechnet ema(closes, min(50, closes.length)) — unter 50 Kerzen ist der Vergleichswert also ein kürzerer EMA und die Buffer-Bedingung sagt etwas anderes. Der Snapshot braucht erst ab 25 Kerzen; fachlich verlangt dieses Template 50 (1h ≈ 2 Tage, 4h ≈ 8 Tage Historie). |

## `macd-momentum`

**MACD Momentum** — Momentum auf 1h/4h: Das MACD(12/26/9)-Histogramm muss über null drehen (nur das Vorzeichen — der Wert steht in Preiseinheiten und ist nicht marktübergreifend vergleichbar), der Kurs mit einer Vorgabe über seinem EMA 50 liegen (Default 0 %, also strikt darüber; die skalenfreie Stärkebedingung) und der ADX(14) eine gerichtete Bewegung bestätigen (Default 20). Stop und Ziel sind feste Prozent- bzw. Chance/Risiko-Werte, kein ATR-Kanal.

- **Klasse:** `trend` (ADR-008, deklariert; nicht aus der ID abgeleitet)
- **Version:** 1 (v1; Teil des Artefakt-Hashs, 04-01)
- **Scope:** `SINGLE_SYMBOL`
- **Timeframes:** `1h`, `4h` (`SUPPORTED_TIMEFRAMES`, STX-01)
- **Erwartete Regimes:** `TREND_UP` (ADR-009, ohne `UNKNOWN`)
- **Pflichtfelder:** `macdHist`, `priceVsEma50Pct`, `adx14`, `atrPct`
- **Bedingung (Defaults, Rohform `RuleSpecInput`):** `macdHist` gt 0 ∧ `priceVsEma50Pct` gt 0 ∧ `adx14` gte 20

### Parameter

| Key | Label | Einheit | Art | Default | Min | Max | Step | mapsTo (Regelfeld) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `adxMin` | ADX-Mindestwert | Index | threshold | 20 | 14 | 35 | 1 | `adx14` |
| `ema50BufferPct` | Kurs über EMA 50 | % | threshold | 0 | -1 | 3 | 0.1 | `priceVsEma50Pct` |
| `stopLossPct` | Stop-Loss | % | threshold | 4 | 1 | 12 | 0.5 | `atrPct` |
| `takeProfitRR` | Chance/Risiko | ratio | ratio | 2 | 1 | 4 | 0.25 | `atrPct` |

### Annahmen

| ID | Kategorie | Kritisch | Aussage |
| --- | --- | --- | --- |
| `macd-histogramm-vorzeichen` | MARKET | nein | Das Vorzeichen des MACD-Histogramms dreht vor dem Trend: Die Drehung ist ein Frühindikator, kein Nachläufer. Trifft das nicht zu, kommt das Signal nach der Bewegung — die Edge verschwindet in ebenjener Strecke, die der Einstieg dann schon verpasst hat. |
| `macd-hist-keine-staerke-metrik` | MARKET | **ja** | `macdHist` wird ausdrücklich NICHT als Stärke-Metrik verwendet: Der Wert steht in Preiseinheiten (macd − signal) und ist nicht skalenfrei — dieselbe Zahl bedeutet für BTC und einen 5-stelligen Aktienkurs Verschiedenes. Die Regel nutzt nur das Vorzeichen (`gt 0`); die Stärke-/Lagefrage beantwortet allein `priceVsEma50Pct` in Prozent. |
| `macd-35-kerzen` | DATA | **ja** | MACD(12/26/9) braucht 35 Schlusskurse (slow 26 + signal 9); darunter liefert `macd()` null und die Bedingung `macdHist gt 0` scheitert fail-closed — ohne Histogramm wird nicht gehandelt, statt einen Wert zu erfinden. |
| `histogramm-wechsel-cooldown` | COST | nein | Häufige Histogramm-Wechsel in Seitwärtsphasen werden durch Cooldown (240 min) und Tageslimit (2) gedämpft; die verbleibende Transaktionszahl bleibt auf dem Niveau des Backtest-Kostenmodells (Kosten-Fallback 1h: 4 bp, docs/BACKTESTING.md). Wird der Cooldown unterschritten, wächst die Kostenseite schneller als die Signalzahl. |
| `regime-trend-up` | REGIME | nein | Funktioniert in TREND_UP. In RANGE wechselt das Vorzeichen ohne Richtung — die Bedingungen bleiben formal erfüllbar, ohne dass ein Trend existiert; Tageslimit und Cooldown begrenzen den Schaden, verhindern ihn aber nicht. |
| `ema50-min-50-kerzen` | DATA | nein | priceVsEma50Pct bezieht sich auf einen echten EMA 50: buildSnapshotFromCandles() rechnet ema(closes, min(50, closes.length)) — unter 50 Kerzen ist der Vergleichswert ein kürzerer EMA und die Buffer-Bedingung sagt etwas anderes. Fachlich verlangt dieses Template 50 Kerzen (1h ≈ 2 Tage, 4h ≈ 8 Tage Historie). |

## `rsi-mean-reversion`

**RSI Mean-Reversion** — Mean-Reversion long in der Range auf 15m/1h/4h: Der RSI(14) muss überverkauft stehen (Default 30), der Kurs mindestens 1 % unter seinem EMA 21 liegen, der ADX(14) darf höchstens 20 betragen — der Seitwärts-Filter, ohne den das Template ein Falling-Knife-System wäre — und die Signalkerze muss überdurchschnittliches Volumen zeigen (Default 1,1×). Stop und Ziel sind feste Prozent- bzw. Chance/Risiko-Werte, kein ATR-Kanal; das Ziel ist mit 1,5× bewusst kleiner als bei der Trendfolge.

- **Klasse:** `mean-reversion` (ADR-008, deklariert; nicht aus der ID abgeleitet)
- **Version:** 1 (v1; Teil des Artefakt-Hashs, 04-01)
- **Scope:** `SINGLE_SYMBOL`
- **Timeframes:** `15m`, `1h`, `4h` (`SUPPORTED_TIMEFRAMES`, STX-01)
- **Erwartete Regimes:** `RANGE` (ADR-009, ohne `UNKNOWN`)
- **Pflichtfelder:** `rsi14`, `priceVsEma21Pct`, `adx14`, `volumeRatio`, `atrPct`
- **Bedingung (Defaults, Rohform `RuleSpecInput`):** `rsi14` lte 30 ∧ `priceVsEma21Pct` lte -1 ∧ `adx14` lte 20 ∧ `volumeRatio` gte 1.1

### Parameter

| Key | Label | Einheit | Art | Default | Min | Max | Step | mapsTo (Regelfeld) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `rsiOversold` | RSI-Überverkauft-Schwelle | Index | threshold | 30 | 15 | 40 | 1 | `rsi14` |
| `ema21GapPct` | Kurs mind. unter EMA 21 | % | threshold | 1 | 0.3 | 5 | 0.1 | `priceVsEma21Pct` |
| `adxMax` | Maximaler ADX (Seitwärts-Filter) | Index | threshold | 20 | 10 | 30 | 1 | `adx14` |
| `volumeRatioMin` | Volumenverhältnis | ratio | threshold | 1.1 | 0.8 | 2.5 | 0.05 | `volumeRatio` |
| `stopLossPct` | Stop-Loss | % | threshold | 5 | 1 | 15 | 0.5 | `atrPct` |
| `takeProfitRR` | Chance/Risiko | ratio | ratio | 1.5 | 1 | 4 | 0.25 | `atrPct` |

### Annahmen

| ID | Kategorie | Kritisch | Aussage |
| --- | --- | --- | --- |
| `regime-range` | REGIME | **ja** | Funktioniert in RANGE. In TREND_UP/TREND_DOWN ist die Strategie nicht schwächer, sondern verkehrt herum — sie kauft in eine fallende Bewegung, weil der RSI niedrig ist, in einem Trend, in dem der RSI niedrig bleibt. Dort greift ausschließlich das Regime-Gate der Klasse (Faktor 0,5 auf das Risikobudget, nur im Modus enforce); die Regel selbst kennt kein Regime. |
| `ueberverkauf-keine-bodenbildung` | MARKET | nein | Überverkaufte Zustände sind keine Bodenbildung: Der RSI markiert eine Überdehnung, keinen Wendepunkt. Trifft das nicht zu, kauft die Regel in die Fortsetzung hinein — genau das Falling-Knife-Szenario, das der ADX-Filter ausschließen soll und das der Stop dann bezahlt. |
| `ema21-ist-das-mittel` | MARKET | nein | Der EMA 21 ist das Mittel, zu dem der Kurs in der Range zurückkehrt. Der Abstand `priceVsEma21Pct` misst damit die Überdehnung und nicht den Beginn eines neuen Trends — fällt diese Annahme, ist die zweite Bedingung des Templates eine Trendaussage mit falschem Vorzeichen. |
| `turnover-kosten-lastend` | COST | **ja** | Mean-Reversion hat eine höhere Turnover-Rate als Trendfolge (kürzere Haltezeit, mehr Signale in derselben Range) — die Gebühren- und Slippage-Annahme des Backtests ist hier deshalb besonders lastend: Sie wirkt auf mehr Transaktionen bei kleinerem Ziel je Trade. Schon die Hälfte des angenommenen Zusatz-Slippage kann die Edge der Klasse kippen, nicht nur schmälern. |
| `rsi-15-schlusskurse` | DATA | **ja** | RSI(14) braucht 15 Schlusskurse (periode + 1). Darunter liefert `rsi()` keinen Null-Wert, sondern den neutralen Ersatzwert 50 — der gesamte Parameterbereich von `rsiOversold` (15…40) liegt unter 50, die Regel schweigt also auch auf dem Ersatzwert, statt auf einer erfundenen Zahl zu handeln. |
| `adx-29-kerzen` | DATA | nein | ADX(14) braucht 29 Kerzen (2 · 14 + 1); darunter liefert das Feld null und die Bedingung `adx14 lte adxMax` scheitert fail-closed — ohne Seitwärts-Bestätigung wird nicht gehandelt. Auf dem feinsten unterstützten Takt (15m) sind 29 Kerzen nur 7,25 Stunden, also weniger als ein Handelstag: dort misst der Filter eine Session-Phase, keinen Marktzyklus. |
| `fill-in-der-signalkerze` | EXECUTION | nein | Der Einstieg gelingt in der Signalkerze. Mean-Reversion kauft in eine laufende Abwärtsbewegung — ein Fill erst danach verschlechtert den Einstiegskurs systematisch (adverse Selection), weil die Bewegung, gegen die gekauft wird, noch läuft. |

## `bollinger-squeeze`

**Bollinger Squeeze Breakout** — Frühes Long-Ausbruchssetup auf 1h/4h: enges Bollinger(20, 2σ)-Band (vorläufig maximal 6 %), Kurs mindestens 0,5 σ über der Bandmitte, ADX(14) mindestens 22 und Volumen mindestens 1,2× des 20er-Schnitts. Snapshot-Vereinfachung, keine Squeeze-Sequenz und beim Default kein bestätigter Bruch der oberen Kante. Die Bandbreitenschwelle ist markt-/timeframe-/regimeabhängig; Stop 4 %, Ziel 2,5× Chance/Risiko.

- **Klasse:** `breakout` (ADR-008, deklariert; nicht aus der ID abgeleitet)
- **Version:** 1 (v1; Teil des Artefakt-Hashs, 04-01)
- **Scope:** `SINGLE_SYMBOL`
- **Timeframes:** `1h`, `4h` (`SUPPORTED_TIMEFRAMES`, STX-01)
- **Erwartete Regimes:** `RANGE`, `TREND_UP` (ADR-009, ohne `UNKNOWN`)
- **Pflichtfelder:** `bbwPct`, `bbZScore`, `adx14`, `volumeRatio`, `atrPct`
- **Bedingung (Defaults, Rohform `RuleSpecInput`):** `bbwPct` lte 6 ∧ `bbZScore` gte 0.5 ∧ `adx14` gte 22 ∧ `volumeRatio` gte 1.2

### Parameter

| Key | Label | Einheit | Art | Default | Min | Max | Step | mapsTo (Regelfeld) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `bbwMaxPct` | maximale Bandbreite (Squeeze) | % | threshold | 6 | 2 | 15 | 0.25 | `bbwPct` |
| `bbZScoreMin` | Kurs über oberer Bandkante | σ | threshold | 0.5 | 0 | 3 | 0.1 | `bbZScore` |
| `adxMin` | ADX-Bestätigung | Index | threshold | 22 | 15 | 35 | 1 | `adx14` |
| `volumeRatioMin` | Volumen beim Ausbruch | ratio | threshold | 1.2 | 0.9 | 3 | 0.05 | `volumeRatio` |
| `stopLossPct` | Stop-Loss | % | threshold | 4 | 1 | 12 | 0.5 | `atrPct` |
| `takeProfitRR` | Chance/Risiko | ratio | ratio | 2.5 | 1 | 5 | 0.25 | `atrPct` |

### Annahmen

| ID | Kategorie | Kritisch | Aussage |
| --- | --- | --- | --- |
| `kontraktion-vor-expansion` | MARKET | **ja** | Volatilitätskontraktion geht einer Expansion voraus. Ein enges Bollinger-Band ist ein plausibles Ausbruchssetup, aber weder eine Garantie für Expansion noch für deren Richtung. |
| `bbw-kalibrierung` | DATA | **ja** | bbwPct ist nicht marktübergreifend; die Schwelle ist markt-, timeframe- und regime-spezifisch. Der vorläufige Default 6 % für 1h/4h ist vor Live-Einsatz gegen den Store zu prüfen: in 06-01/06-02 die 20. Perzentile über die letzten 200 geschlossenen Kerzen je Markt/Timeframe/Regime vermessen. |
| `schlusskurs-latenz` | EXECUTION | **ja** | Der Ausbruch wird am Schluss der Kerze erkannt, gehandelt wird zum Schlusskurs. Im Live-Pfad ist das eine kritische Latenzannahme: Erkennung und Order folgen erst nach Kerzenschluss; ein Fill zum beobachteten Schlusskurs ist nicht garantiert und muss mit Slippage geprüft werden. |
| `squeeze-kosten-rr` | COST | nein | Squeeze-Phasen haben niedrige Volatilität; R:R muss die höhere Trefferzahl und deren Kosten ausgleichen. Das vorläufige Ziel 2,5× muss nach Gebühren und Slippage in 06-02 geprüft werden; ein engeres Band allein belegt keine profitable Trefferquote. |
| `snapshot-statt-sequenz` | DATA | **ja** | Bewusste Vereinfachung im Snapshot-Dialekt: Alle vier Bedingungen gelten auf derselben geschlossenen Kerze, nicht als Sequenz vorher eng, jetzt weit. Die Signalkerze steckt bereits im Band und kann es weiten; vorherige Kontraktion und folgende Expansion werden nicht geprüft. |
| `fruehe-bandposition` | MARKET | nein | bbZScoreMin 0,5 bedeutet mindestens 0,5 σ über der Bandmitte, nicht über der oberen Bandkante (z = 2). ADX und Volumen sollen das frühe Setup bestätigen; eine Überschreitung der oberen Kante wird beim Default nicht verlangt. |
| `indikator-warm-up` | DATA | **ja** | Das Bollinger-Band braucht 20 Schlusskurse, ADX(14) 29 Kerzen. Fehlende Readings blockieren die Regel fail-closed; bei σ == 0 bleibt bbZScore null, auch wenn bbwPct und Kantenabstand echte Nullen liefern. Kein stiller Ersatz durch priceVsUpperBbPct. |

## `vwap-pullback`

**VWAP-Trend-Bias (Snapshot, kein Pullback)** — Intraday-Long-Bias über UTC-Tages-VWAP im Aufwärtstrend, bestätigt durch EMA 21 und Volumen. Trotz stabiler ID keine Pullback-/Reclaim-Sequenz und kein zustandsbehafteter Trigger.

- **Klasse:** `trend` (ADR-008, deklariert; nicht aus der ID abgeleitet)
- **Version:** 1 (v1; Teil des Artefakt-Hashs, 04-01)
- **Scope:** `SINGLE_SYMBOL`
- **Timeframes:** `5m`, `15m`, `1h` (`SUPPORTED_TIMEFRAMES`, STX-01)
- **Erwartete Regimes:** `TREND_UP` (ADR-009, ohne `UNKNOWN`)
- **Pflichtfelder:** `trend`, `vwapPct`, `volumeRatio`, `priceVsEma21Pct`, `atrPct`
- **Bedingung (Defaults, Rohform `RuleSpecInput`):** `trend` eq „UP“ ∧ `vwapPct` gte 0.1 ∧ `priceVsEma21Pct` gte 0.1 ∧ `volumeRatio` gte 1.1

### Parameter

| Key | Label | Einheit | Art | Default | Min | Max | Step | mapsTo (Regelfeld) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `vwapMinPct` | Kurs mind. über VWAP | % | threshold | 0.1 | -0.5 | 2 | 0.05 | `vwapPct` |
| `ema21BufferPct` | Kurs über EMA 21 | % | threshold | 0.1 | -1 | 3 | 0.1 | `priceVsEma21Pct` |
| `volumeRatioMin` | Volumenverhältnis | ratio | threshold | 1.1 | 0.8 | 2.5 | 0.05 | `volumeRatio` |
| `stopLossPct` | Stop-Loss | % | threshold | 3 | 0.5 | 10 | 0.25 | `atrPct` |
| `takeProfitRR` | Chance/Risiko | ratio | ratio | 2 | 1 | 4 | 0.25 | `atrPct` |

### Annahmen

| ID | Kategorie | Kritisch | Aussage |
| --- | --- | --- | --- |
| `utc-tag-statt-boersensession` | DATA | **ja** | vwapPct ist am UTC-Kalendertag verankert, nicht an der Börsen-Session; für US-Equities ist das ein bekannter Versatz. |
| `fortsetzung-ueber-vwap` | MARKET | nein | Kurse über dem Session-VWAP handeln im Tagesverlauf häufiger weiter; das ist eine Marktthese, keine Pullback-Bestätigung. |
| `historischer-vwap-kein-fill` | EXECUTION | **ja** | Der VWAP ist eine historische Größe; er sagt nichts über den Ausführungskurs aus. Der Bid/Ask-Spread ist separat über spreadPct zu messen. |
| `intraday-kosten` | COST | **ja** | Intraday-Handel macht die Gebühren- und Slippage-Annahme zur kritischsten Kostenannahme dieses Templates. |
| `snapshot-kein-reclaim` | DATA | **ja** | Die Regel prüft nur den aktuellen Tages-Bias. Ein echter Pullback/Reclaim benötigt Sequenz-Zustand über mehrere Bars im Executor und ist der eigene Audit STX-18. |

## `donchian-breakout`

**Donchian Breakout** — Higher-Timeframe-Long-Ausbruch auf 1h/4h: Schlusskurs mindestens 0,3 % über dem Hoch der vorigen 20 Kerzen (Donchian-Kanal ohne Signalkerze, kein Look-ahead), ADX(14) mindestens 20 und Volumen mindestens 1,2× des 20er-Schnitts. Höchstens ein Ausbruch pro Tag (Cooldown 12 h), weil dasselbe Breakout sonst mehrfach kauft; der Einstieg erfolgt strukturell am lokalen Hoch. Stop 5 %, Ziel 2× Chance/Risiko.

- **Klasse:** `breakout` (ADR-008, deklariert; nicht aus der ID abgeleitet)
- **Version:** 1 (v1; Teil des Artefakt-Hashs, 04-01)
- **Scope:** `SINGLE_SYMBOL`
- **Timeframes:** `1h`, `4h` (`SUPPORTED_TIMEFRAMES`, STX-01)
- **Erwartete Regimes:** `TREND_UP`, `RANGE` (ADR-009, ohne `UNKNOWN`)
- **Pflichtfelder:** `donchianBreakoutPct`, `adx14`, `volumeRatio`, `atrPct`
- **Bedingung (Defaults, Rohform `RuleSpecInput`):** `donchianBreakoutPct` gte 0.3 ∧ `adx14` gte 20 ∧ `volumeRatio` gte 1.2

### Parameter

| Key | Label | Einheit | Art | Default | Min | Max | Step | mapsTo (Regelfeld) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `breakoutMinPct` | mind. Abstand über Kanal | % | threshold | 0.3 | 0 | 3 | 0.1 | `donchianBreakoutPct` |
| `adxMin` | ADX-Bestätigung | Index | threshold | 20 | 14 | 35 | 1 | `adx14` |
| `volumeRatioMin` | Volumen beim Ausbruch | ratio | threshold | 1.2 | 0.9 | 3 | 0.05 | `volumeRatio` |
| `stopLossPct` | Stop-Loss | % | threshold | 5 | 1 | 15 | 0.5 | `atrPct` |
| `takeProfitRR` | Chance/Risiko | ratio | ratio | 2 | 1 | 4 | 0.25 | `atrPct` |

### Annahmen

| ID | Kategorie | Kritisch | Aussage |
| --- | --- | --- | --- |
| `20-bar-ausbrueche-regimewechsel` | MARKET | nein | 20-Bar-Ausbrüche markieren Regime-Wechsel: Ein Schlusskurs über dem Hoch der vorigen 20 Kerzen ist ein plausibles Signal für den Beginn einer neuen Aufwärtsbewegung — aber nur ein Signal, kein Beweis. Fehlausbrüche sind Teil der Verteilung, nicht ein Defekt der Regel. |
| `einstieg-am-lokalen-hoch` | EXECUTION | **ja** | Der Einstieg erfolgt zum Schlusskurs NACH dem Ausbruch — das ist der lokale Hoch-Punkt; strukturelle Properties, keine Parameterfrage. Der Fill liegt systematisch über dem Kanalhoch, weil die Signalkerze den Kanal bereits hinter sich gelassen hat; keine Parametersetzung macht daraus einen frühen Einstieg. |
| `vorige-20-kerzen-kein-lookahead` | DATA | **ja** | donchianBreakoutPct bezieht sich auf die VORIGEN 20 Kerzen, ohne die aktuelle (kein Look-ahead): Das Kanalhoch stammt ausschließlich aus der vor der Signalkerze bekannten Historie. Die Signalkerze kann sich nicht selbst bestätigen — `upper` enthält ihr eigenes Hoch ausdrücklich nicht. |
| `spread-am-lokalen-hoch` | COST | **ja** | Breakout-Einstiege zahlen den Spread am lokalen Hoch: Spread und Slippage fallen auf einem Kurs an, der bereits über dem Kanal liegt. Die Kosten wirken damit genau gegen die Position und sind in 06-02 gegen die Signalqualität zu messen (Fill vs. Signalkurs), nicht wegzudefinieren. |
| `ein-ausbruch-pro-tag` | EXECUTION | **ja** | Ein Ausbruch bleibt typischerweise mehrere Kerzen über dem Kanal, deshalb maxExecutionsPerDay 1: Ohne die Tagesgrenze erzeugte dasselbe Breakout-Charset Nachfolge-Einstiege am selben Ausbruch und zahlte die Kosten des lokalen Hochs mehrfach für dieselbe Bewegung. Der Cooldown von 720 Minuten hält den Abstand auch über den Tageswechsel hinweg. |
| `entry-period-ist-snapshot-default` | DATA | **ja** | entryPeriod (20) ist kein Regelfeld, sondern Template-/Snapshot-Konfiguration: Der Snapshot rechnet mit dem kanonischen Default DONCHIAN_ENTRY_PERIOD aus 02-03, die Regel sieht die Periode nicht. Eine andere Periode braucht in 06-02 ein zusätzliches Feld (oder eine versionierte Snapshot-Definition) — bis dahin ist die feste 20 die bekannte Grenze dieses Templates. |
| `warm-up-blockiert-fail-closed` | DATA | **ja** | donchianBreakoutPct ist null, solange weniger als 21 Kerzen vorliegen (oder das Kanalhoch <= 0 ist), und adx(14) braucht 29 Kerzen. Fehlende Readings blockieren die Regel fail-closed — nie eine erfundene 0, kein stiller Ersatzwert. |

## Pflege

1. Template ändern (`src/strategies/templates/*.ts`) — der Katalog validiert beim Import.
2. `npm run docs:templates` ausführen und `docs/STRATEGY_TEMPLATES.md` mitcommitten.
3. `npm test` prüft, dass Datei und Katalog übereinstimmen; die Vertragstests
   `tests/strategies.templates.test.ts` prüfen zusätzlich Struktur-Invarianten,
   Compiler-Parität, Fixture-/Negativ-Fixtures und die Engine-↔-Cache-Parität (02-02/02-03).
