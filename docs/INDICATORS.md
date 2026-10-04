# Indikatoren-Katalog — Engine, CTI und Scanner

**Stand:** 2026-10-04 · **Version:** `v0.13.0` (Beta) · **Status:** beschreibt den Code, keine Wunschliste
**Verwandt:** [CLAUDE_TRADING_INDICATOR.md](CLAUDE_TRADING_INDICATOR.md) · [BACKTESTING.md](BACKTESTING.md) · [architecture/STRATEGY_STACK.md](architecture/STRATEGY_STACK.md) · [DAILY_WEEKLY_RESEARCH.md](DAILY_WEEKLY_RESEARCH.md) · [research/INDICATOR_RANKING_CRYPTO_DAYTRADING.md](research/INDICATOR_RANKING_CRYPTO_DAYTRADING.md)

> **Beta-Hinweis:** Alle Indikatoren erzeugen Signale, keine Orders. Ausgeführt
> wird ausschließlich, was Live-Gate, Kill-Switch und Risikolimits freigeben —
> und im Paper-Modus ohnehin nur simuliert.

Dieser Katalog ist der **Einstieg in alle Rechenkerne**: welche Indikatoren es
gibt, wo sie im Code stehen, mit welchen Defaults sie rechnen, welches
Regelfeld daraus wird und wo ihre Grenzen liegen. Die Details je Baustein
bleiben in den jeweiligen Fachdokumenten — hier steht die Landkarte.

---

## 1. Landkarte — welcher Indikator lebt wo

| Schicht | Ort im Code | Was sie liefert | Dokument |
| --- | --- | --- | --- |
| **Engine-Indikatoren** | `src/lib/indicators.ts` | 14 Funktionen (EMA, RSI, MACD, Bollinger, Donchian, ADX, ATR, VWAP, Return-StdDev, Snapshot) — die gemeinsame Basis von Regelwerk, Prompt-Snapshot, Backtest und Feature Store | dieses Dokument §2 |
| **Regelfelder** | `src/lib/ruleFieldCatalog.ts` | 25 Whitelist-Felder, die eine Strategie überhaupt sehen darf (`rsi14`, `bbwPct`, `vwapPct`, …) | §3, [BACKTESTING.md §1.1](BACKTESTING.md#11-rule-timeframe--unterstützte-felder-stx-01-v062) |
| **Claude Trading Indicator (CTI)** | `src/signals/pine.ts`, `src/signals/cti/**` | 8 Standardindikatoren → 4 Dimensionen → 1 Verdikt; eigener Streaming-Kern | §4, [CLAUDE_TRADING_INDICATOR.md](CLAUDE_TRADING_INDICATOR.md) |
| **Scanner-Faktoren** | `src/scanner/factors/*` + `scanner.config.json` | 15 Faktoren (9 gewichtet, 6 diagnostisch) für Market Score und Trichter | §5, [DAILY_WEEKLY_RESEARCH.md §3](DAILY_WEEKLY_RESEARCH.md#3-faktor-katalog) |
| **Adaptives Risiko** | `src/lib/adaptiveRisk.ts` | VIX, ATR(14), Bollinger-Bandbreite (20, 2σ), Return-StdDev (20) als Risiko-Dämpfer | §6, [HANDBUCH.md §9.3](HANDBUCH.md#93-adaptives-risk-limit-v170-volatilitätsgetriebene-limit-anpassung) |
| **Trusted Indicators** | `src/cycle/trustedIndicators.ts` | RSI/ATR/ADX/MACD/VWAP/Spread/Tiefe aus geschlossenen 1h-Kerzen für den Analysten | §7 |
| **Externe Research** | `docs/research/INDICATOR_RANKING_CRYPTO_DAYTRADING.md` | Fremd-Ranking (AlgoTrade Pro) als Ideengeber — **nicht** nachgerechnet | §8 |

Prinzip in allen Schichten: **`null` statt erfundener 0.** Fehlt Historie oder
ist ein Wert fachlich nicht definiert, bleibt das Feld leer und wird als
„nicht gemessen“ geführt — nie als neutrale 50, nie als stilles 0.

---

## 2. Engine-Indikatoren (`src/lib/indicators.ts`)

Alle Funktionen sind **rein und deterministisch**: keine Bibliothek, kein Netz,
keine Uhr, kein Zufall. Aufrufer übergeben Kursreihen bzw. Kerzen und bekommen
Zahlen oder `null`.

| Funktion | Formel (Kurzform) | Default | Rückgabe bei zu wenig Daten |
| --- | --- | --- | --- |
| `ema(values, period)` | `k = 2/(period+1)`, `Eₜ = vₜ·k + Eₜ₋₁·(1−k)`, Seed = **erster Kurs** (kein SMA-Seed) | Aufrufer wählt | endliche Reihe (kein `null`) |
| `rsi(values, period)` | Wilder: Ø-Gewinn/Ø-Verlust über `period`, `RSI = 100 − 100/(1+RS)` | `period = 14` | `50` (bewusst neutral) bzw. `100` bei reinem Aufwärtslauf |
| `macd(closes, fast, slow, signal)` | `Linie = EMA(fast) − EMA(slow)`, `Signal = EMA(Linie, signal)`, `Hist = Linie − Signal` | `12 / 26 / 9` | `null`, wenn `< slow + signal` Kurse |
| `bollingerBandWidthPct(closes, period, mult)` | `2·mult·σ / SMA` (Bruch: `0.05` = 5 %) | `20 / 2` | `null` |
| `bollingerBands(closes, period, mult)` | `SMA ± mult·σ` (Population), `width = 2·mult·σ/SMA` | `20 / 2`, geklemmt `period 5…200`, `mult 1…4` | `null` |
| `bollingerPosition(close, reading, mult)` | `z = (close − Mitte)/σ`, `priceVsUpperPct`, `priceVsLowerPct` | `mult = 2` | `z = null` bei `σ = 0` (flache Reihe), Prozente bleiben |
| `donchianChannel(candles, entry, exit)` | `upper = max(high)` der **vorigen** `entry` Kerzen, `lower = min(low)` der vorigen `exit` Kerzen | `20 / 10`, geklemmt `5…200` / `3…100` | `null` unter `entry + 1` Kerzen |
| `donchianBreakoutPct(close, upper)` | `(close/upper − 1)·100` | — | `null` ohne Kanalhoch |
| `returnStdDevPct(closes, n)` | σ der Perioden-Renditen `(cₜ−cₜ₋₁)/cₜ₋₁` | `n = 20` | `null` |
| `utcDayAnchorMs(timeMs)` | `floor(t / 86 400 000) · 86 400 000` | — | `0` bei ungültigem `t` |
| `sessionVwap(candles, anchorMs?)` | `Σ(HLC3·vol) / Σ(vol)` ab Tagesanker (UTC), Ergebnis `vwap`, `priceVsVwapPct`, `samples` | Anker = UTC-Tag der letzten Kerze | `null` ohne Volumen oder `< 2` Kerzen |
| `adx(candles, period)` | Wilder: `+DM/−DM/TR`, Glättung, `DX`, `ADX = geglätteter DX` | `period = 14` | `null` unter `2·period + 1` Kerzen |
| `atr(candles, period)` | `TR = max(h−l, ⎮h−c₋₁⎮, ⎮l−c₋₁⎮)`, arithmetisches Mittel der letzten `period` TR | `period = 14` | `null` unter `period + 1` Kerzen |
| `atrPct(candles, period)` | `ATR / close` (Bruch) | `period = 14` | `null` |
| `snapshot(symbol, candles)` | Kompaktbild: Kurs, `rsi14`, `ema9/21`, `trend`, `atrPercent`, `changePct24h` | `≥ 25` Kerzen | `null` |
| `snapshotLine(snapshot)` | eine Zeile für LLM-Prompts | — | — |

**Kanonische Fenster** (als Konstanten exportiert, dadurch in Regelwerk,
Backtest und Feature Store identisch interpretiert):

| Konstante | Wert | Bedeutung |
| --- | --- | --- |
| `BOLLINGER_PERIOD` / `BOLLINGER_MULT` | `20` / `2` | Snapshot-Definition aller `bb*`-Regelfelder |
| `DONCHIAN_ENTRY_PERIOD` / `DONCHIAN_EXIT_PERIOD` | `20` / `10` | Snapshot-Definition von `donchianBreakoutPct` |

### 2.1 Konventionen, die man kennen muss

1. **Kein Look-ahead.** Donchian und Bollinger lesen ausschließlich
   **abgeschlossene** Fenster; die aktuelle Signalkerze ist im Kanal nicht
   enthalten. Der Backtest benutzt dafür einen inkrementellen Cache
   (`src/backtest/indicatorCache.ts`), der pro Bar exakt dieselben Werte liefert
   wie der Direktpfad — Look-ahead wäre sonst als Performance „belohnt“.
2. **Prozent oder Bruch?** `bollingerBandWidthPct` und `atrPct` liefern
   **Brüche** (`0.05` = 5 %). Das Regelfeld `bbwPct` und der Dashboard-Key
   `adp.bbwHighPct`-Umfeld rechnen in **Prozent** (`5` = 5 %) bzw. Bruch
   (`max 0.5`) — die Feldnamen sagen es jeweils an.
3. **Rundung.** Regel-Snapshots runden auf 4 Dezimalstellen
   (`buildSnapshotFromCandles`, `snapshotFromCache`); die Trusted Indicators
   runden je Feld auf 2–6 Stellen. Die Funktionen selbst runden nicht.
4. **`changePct24h` ist historisch benannt:** verglichen wird die Kerze vor
   **97 Perioden** — auf `1h` also ~4 Tage, auf `5m` ~8 Stunden. Die
   Feldbeschreibung in `ruleFieldCatalog.ts` sagt das ausdrücklich; die
   Umbenennung wäre eine Versionsfrage (bestehende Regeln).
5. **Aufwärmbedarf.** RSI ≥ 15 Kerzen, ADX ≥ 29 Kerzen (`2·14+1`), MACD ≥ 35
   Kurse, Snapshot ≥ 25 Kerzen. Zu kurze Reihen ergeben `null` (oder bei `rsi`
   dokumentiert 50) — niemals eine stille 0.

---

## 3. Vom Indikator zum Regelfeld

`src/lib/ruleFieldCatalog.ts` ist die **Whitelist**: Nur diese 25 Felder darf
eine Strategie in einer Bedingung sehen. Alles andere wird von
`sanitizeRuleSpec()` abgewiesen.

| Gruppe | Felder |
| --- | --- |
| Preis & Trend | `price`, `ema9`, `ema21`, `ema50`, `priceVsEma21Pct`, `priceVsEma50Pct`, `trend` (`UP`/`DOWN`/`FLAT`) |
| Momentum | `rsi14`, `macd`, `macdSignal`, `macdHist`, `changePct24h` |
| Volatilität | `atrPct`, `adx14`, `bbwPct`, `bbZScore`, `priceVsUpperBbPct`, `priceVsLowerBbPct`, `donchianBreakoutPct` |
| Liquidität & Kosten | `volume`, `volumeMa20`, `volumeRatio`, `spreadPct`, `bookDepthUsd` |
| Referenz | `vwapPct` (Session-VWAP, UTC-Tagesanker) |

Ausführliche Feldbeschreibungen inkl. typischer Wertebereiche stehen in
[BACKTESTING.md §1.2/§1.3](BACKTESTING.md) und im Modulkopf von
`ruleFieldCatalog.ts`. Die Einordnung, welcher Baustein wofür zuständig ist,
führt [architecture/STRATEGY_STACK.md](architecture/STRATEGY_STACK.md).

---

## 4. Claude Trading Indicator (CTI)

Der CTI ist die **1:1-Portierung eines Pine-Script-v6-Indikators** — und damit
der „Claude Indicator“ im Sinne dieses Projekts. Kurzfassung; die vollständige
Beschreibung (Kausalität, Sperrfristen, Backtest-Anbindung, Engine, CLI) steht
in [CLAUDE_TRADING_INDICATOR.md](CLAUDE_TRADING_INDICATOR.md).

**Stufenmodell:** 8 Komponenten → 4 Dimensionen → 1 Verdikt.

| Dimension | Komponenten (feste Perioden) | bullisch, wenn … |
| --- | --- | --- |
| **Trend** | EMA 200 · Supertrend (ATR 10, Faktor 3,0) · Bollinger-Basis SMA 20 | `close > EMA200` **und** Supertrend aufwärts **und** `close > Basis` |
| **Momentum** | MACD 12/26/9 · RSI 14 · Stochastik 14/3/3 | `MACD > Signal` **und** `RSI > 50` **und** `%K > %D` |
| **Volatilität** | DMI/ADX 14/14, Mindeststärke 20 | `ADX ≥ 20` **und** `+DI > −DI`, sonst neutral |
| **Volumen** | OBV gegen `SMA(OBV, 10)` | `OBV > SMA(OBV, 10)` |

Eine Dimension ist nur einstimmig bullisch/bärisch; ein neutrales Votum
verhindert das Verdikt. **BULL** feuert nur, wenn *alle eingeschalteten*
Dimensionen bullisch sind — ein bewusst seltener, selektiver Ansatz.

| Einstellbarer Parameter | Default | Grenzen (geklemmt, Korrektur wird gemeldet) |
| --- | --- | --- |
| Dimensionen (`useTrend` … `useVolume`) | alle `true` | — |
| `atrLength` (Stop-ATR) | `14` | 1 … 1000 |
| `atrMultiplier` (Stop-Abstand) | `3.0` | 0,1 … 100 |
| `persistBars` (Verdikt muss halten) | `2` | 1 … 1000 (Pine: **Gleichheit**, nicht `≥` — ein Signal je Strecke) |
| `minBarsBetween` (Sperrfrist) | `10` | 0 … 10000 |

Die Komponenten-Perioden sind **fest verdrahtet** (`CTI_COMPONENTS` in
`src/signals/cti/params.ts`) — wer sie ändert, verlässt die Chart-Treue.

| Eigenschaft | Umsetzung |
| --- | --- |
| Rechenkern | `src/signals/cti/runtime.ts` — inkrementeller Zustandsautomat („Kerze rein, Bar-Zustand raus“) |
| Parität Backtest ↔ Live | derselbe Automat; Look-ahead strukturell unmöglich |
| Stops | `longStop = close − ATR(14)·3,0`, `shortStop = close + ATR·3,0`, beim Signal eingefroren |
| IO-Freiheit | kein `src/db`, kein Broker, kein LLM, kein `next` (per Test festgenagelt) |
| CLI | `npm run cti` (liest, rechnet, handelt nicht) |
| Tests | `tests/cti.indicator.test.ts`, `tests/cti.engine.test.ts`, `tests/cti.backtest.test.ts` |
| Status | Implementiert (v0.12.0), Paper-only |

---

## 5. Scanner-Faktoren (`src/scanner/factors/*`)

15 Module mit identischem Interface (`raw`, `normalized ∈ [0,1]`,
`available`, `detail`). Neun Faktoren tragen Gewicht, sechs sind diagnostisch.

| # | Faktor | Kurzformel | Gewicht |
| --- | --- | --- | --- |
| 1 | `liquidity` | `volume24h`, logarithmisch normiert | **25 %** |
| 2 | `spread` | `(ask−bid)/mid`, invers linear | **10 %** |
| 3 | `atr` | Wilder-TR(14) `/close`, Trapez | Diagnose |
| 4 | `volatility` | σ der Log-Renditen (30) annualisiert | **15 %** |
| 5 | `momentum` | gewichtete Renditen 5/20/60 (`0.2/0.3/0.5`) | **10 %** |
| 6 | `trend` | EMA 9/21/50, Alignment | **15 %** |
| 7 | `volumeRatio` | `Ø vol(5) / Ø vol(20)` | **10 %** |
| 8 | `rsi` | Wilder-RSI(14) mit Überhitzungsfilter | Diagnose |
| 9 | `drawdown` | max. Rückgang vom Peak über 60 | Diagnose |
| 10 | `correlation` | Pearson/Spearman vs. Benchmark, `1−⎮r⎮` | **5 %** |
| 11 | `news` | Termin-/Impact-Mischung, `1−raw` | **5 %** |
| 12 | `funding` | `⎮Funding⎮ × 8760/interval` | Diagnose |
| 13 | `openInterest` | Open Interest (Quote), logarithmisch | Diagnose |
| 14 | `executionCost` | Roundturn-Gebühr + Spread | **5 %** |
| 15 | `crossSectionalMomentum` | Perzentil im Point-in-Time-Querschnitt | Diagnose (0 %) |

Gewichtete Summe = **100 %** (`contribution = weight × normalized × 100`).
Die Gewichte stehen ausschließlich in der versionierten
`src/scanner/scanner.config.json`; ein Test erzwingt Summe und Einzelwerte.
Vollständige Tabelle inkl. Neutralwerten bei `available: false`:
[DAILY_WEEKLY_RESEARCH.md §3](DAILY_WEEKLY_RESEARCH.md#3-faktor-katalog).
Der Querschnitts-Rang ist gesondert beschrieben:
[CROSS_SECTIONAL_RANKING.md](CROSS_SECTIONAL_RANKING.md).

---

## 6. Adaptive Risiko-Indikatoren (`src/lib/adaptiveRisk.ts`)

Der adaptive Faktor kann das Risiko **nur senken** (Faktor ∈ (0, 1]).

| Indikator | Quelle | Standardschwelle | Wirkung |
| --- | --- | --- | --- |
| **VIX** (primär) | Yahoo `^VIX`, 5-Min-Cache | ≥ 30 → ELEVATED, ≥ 40 → EXTREME | Faktor 0.5 / 0.25 |
| **ATR (14)** | 15-min-Kerzen, Korb SPY/QQQ/BTC (Spitzenwert) | > 1 % des Kurses | ELEVATED |
| **Bollinger-Bandbreite (20, 2σ)** | dieselben Kerzen | > 5 % | ELEVATED |
| **Return-StdDev (20)** | dieselben Kerzen | > 1 % pro Kerze | ELEVATED |

Alle Schwellen sind Laufzeit-Konfiguration (`adp.*` in `risk_config`), die
Eskalation wirkt sofort, die De-Eskalation erst nach `adp.deescalateAfter`
Bestätigungen. Details: [HANDBUCH.md §9.3](HANDBUCH.md#93-adaptives-risk-limit-v170-volatilitätsgetriebene-limit-anpassung).

---

## 7. Trusted Indicators (Analysten-Sicht)

`src/cycle/trustedIndicators.ts` rechnet aus **geschlossenen 1h-Kerzen** des
Historical Store (120 Bars) die Felder, die der technische Analyst als
vertrauenswürdig vorgesetzt bekommt: `rsi`, `atr`, `atrPct`, `adx`, `vwapPct`,
`spreadPct`, `bookDepthUsd`, `macd`, `macdSignal`, `macdHist` — jeweils mit
`asOf`, `bars` und Version `trusted-indicators@1`. Fehlt die Historie, bleibt
das Feld **weg** statt auf einen Default zu fallen. Hintergrund und
Prompt-Vertrag: [PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md) und
[DAILY_WEEKLY_RESEARCH.md](DAILY_WEEKLY_RESEARCH.md).

---

## 8. Externe Research: Indikator-Ranking (AlgoTrade Pro)

[docs/research/INDICATOR_RANKING_CRYPTO_DAYTRADING.md](research/INDICATOR_RANKING_CRYPTO_DAYTRADING.md)
wertet ein fremdes Ranking (30m/1h, P/L und Winrate) aus und prüft es gegen
realistische Krypto-Gebühren. Dort steht der **„Claude Indicator“ auf Rang 3**
der Intraday-Auswertung (30m+1h: +569,6 %, Winrate 51,93 %/52,86 %, Edge
0,11 %/0,14 % pro Trade) — genau der Indikator, dessen Pine-Skript als
**CTI (§4)** in diesem Repository portiert ist.

Wichtig für die Einordnung:

* Die Zahlen sind **Fremddaten**, im Projekt nicht nachgetestet.
* Die Edge pro Trade liegt in der Größenordnung der Krypto-Roundturn-Kosten
  (≈ 0,2 % des Kontos bei 2× Kontogröße) — ohne Maker-Orders bleibt rechnerisch
  wenig übrig.
* Die Portierung übernimmt deshalb nur die **Mechanik** (Konsens, Persistenz,
  Stops), nicht die Renditebehauptung. Ob der CTI auf den eigenen Daten trägt,
  beantwortet der Walk-Forward-Backtest, nicht die Fremdtabelle.

---

## 9. Prüfpfad — wie man diese Aussagen nachrechnet

| Frage | Befehl / Datei |
| --- | --- |
| Rechnen die Formeln wie dokumentiert? | `npm test` — `tests/indicators.test.ts`, `tests/cti.*.test.ts`, `tests/scanner.*.test.ts` |
| Welche Felder darf eine Regel sehen? | `src/lib/ruleFieldCatalog.ts` (SSoT), Tests: `tests/ruleEngine.*.test.ts` |
| Sind die Formeln im Backtest identisch? | `src/backtest/indicatorCache.ts` + `tests/ruleEngine.indicatorCacheParity.test.ts` |
| Sind die Doku-Aussagen noch gültig? | `npm run docs:validate` (u. a. Env-Flags, API-Routen, Version-Konsistenz) |
| Der CTI im Detail | `npm run cti -- --help` bzw. [CLAUDE_TRADING_INDICATOR.md](CLAUDE_TRADING_INDICATOR.md) |

> **Pflege-Regel:** Wird eine Formel, ein Default oder ein Gewicht geändert,
> ändert sich **in derselben Änderung** diese Datei und die zugehörige
> Fachdoku. Der Katalog erhebt keinen Anspruch, den Code zu ersetzen — nur,
> den Einstieg zu liefern.
