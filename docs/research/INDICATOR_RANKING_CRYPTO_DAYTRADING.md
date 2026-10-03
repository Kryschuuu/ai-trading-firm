# Indikator-Ranking für Crypto-Daytrading (Quelle: AlgoTrade Pro)

> **Stand:** 03.10.2026 · **Quelle:** <https://www.algotradepro.com/indicators-ranking>
> (letztes Update laut Seite: 02.10.2026) · **Rohdaten:** [`algotradepro_indicators_ranking.csv`](./algotradepro_indicators_ranking.csv)
>
> Dies ist eine Recherche-Notiz, keine Anlageberatung. Die Zahlen stammen von
> AlgoTrade Pro und wurden hier nicht nachgetestet.

## Vorab: Was die Daten aussagen und was nicht

1. **Es gibt keinen reinen Crypto-Filter.** Die Seite zeigt nur *eine* Tabelle,
   gemittelt über alle getesteten Märkte. In der archivierten Version (Sep. 2025)
   stehen die Assets drin: **BTCUSD, ETHUSD, XRPUSD** plus AUDNZD, CHFJPY, EURUSD,
   Gold, Öl, S&P 500 und AAPL, also 3 von 10 Assets Crypto. Die aktuelle Seite nennt
   nur noch „Crypto, Forex, Stocks, Commodities, Indexes“. Die Liste unten ist
   daher ein **Proxy**: Die Indikatoren, die auf den Intraday-Timeframes insgesamt am
   besten abschneiden. Für Crypto muss man sie selbst validieren.
2. **Für Daytrading zählen die Spalten 30-Min und 1-Hour.** Die 1-Day-Spalte ist
   nur zur Info aufgeführt.
3. **Testbedingungen:** 200-EMA als Baseline-Filter, ATR-Bänder als Stop/Target,
   **2 % Risiko pro Trade**, R:R fest oder Trailing. In der archivierten Version
   war der Testzeitraum 01.01.2022 bis 31.12.2024. „P/L“ ist der kumulierte
   Gewinn in % über alle Trades und Assets.
4. **Abdeckung:** Die Live-Tabelle hat 5 Seiten (ca. 75 Indikatoren), aber nur
   Seite 1 ist ohne JavaScript abrufbar (**15 Indikatoren, Stand 02.10.2026**).
   Die übrigen **44 Indikatoren** stammen aus dem Wayback-Machine-Snapshot vom
   12.09.2025. Bis auf Purple Cloud sind die Werte in beiden Versionen identisch.
   Sie sind also sehr wahrscheinlich noch aktuell. Das ist aber nicht garantiert.
   **Ca. 16 neuere Indikatoren fehlen** (Spalte `source` in der CSV).

## Methode

- **Ranking-Score:** P/L 30-Min + P/L 1-Hour.
- **Pflichtfilter:** Beide Intraday-Timeframes müssen positiv sein. Ein Daytrader
  wechselt zwischen 30m und 1h, und ein Indikator, der auf einem der beiden Geld
  verliert, ist nicht robust.
- **Edge/Trade:** P/L ÷ Anzahl Trades, also der Gewinn pro Trade in % des Kontos.
  Diese Spalte ist für Crypto entscheidend (siehe „Gebühren-Check“).

## Top 15: Die profitabelsten Indikatoren für Intraday (30m + 1h)

| # | Indikator | 30m Winrate | 30m P/L | 30m Trades | 1h Winrate | 1h P/L | 1h Trades | Σ 30m+1h | Edge/Trade 30m / 1h | Daten |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **FRAMA Channel** | 30.91 % | **887.57 %** | 1912 | 30.33 % | **653.87 %** | 1833 | **1541.4 %** | 0.46 % / 0.36 % | live |
| 2 | **DSL Oscillator** | 34.40 % | 324.52 % | 2224 | 38.46 % | 303.70 % | 1690 | 628.2 % | 0.15 % / 0.18 % | Archiv |
| 3 | **Claude Indicator** | 51.93 % | 309.46 % | 2744 | 52.86 % | 260.13 % | 1890 | 569.6 % | 0.11 % / 0.14 % | live |
| 4 | **Price Momentum Osc.** | 51.40 % | 321.77 % | 3957 | 51.93 % | 211.91 % | 1997 | 533.7 % | 0.08 % / 0.11 % | live |
| 5 | **Andean Oscillator** | 51.23 % | 273.18 % | 5268 | 51.98 % | 221.52 % | 2701 | 494.7 % | 0.05 % / 0.08 % | Archiv |
| 6 | **JFKP_Stochastic** | 52.42 % | 302.01 % | 2850 | 52.28 % | 187.71 % | 1840 | 489.7 % | 0.11 % / 0.10 % | live |
| 7 | **Average Force** | 53.22 % | 261.97 % | 1757 | 52.46 % | 191.04 % | 1704 | 453.0 % | 0.15 % / 0.11 % | live |
| 8 | **Doda Stochastic** | 50.93 % | 182.98 % | 3267 | 52.30 % | 237.21 % | 2069 | 420.2 % | 0.06 % / 0.11 % | live |
| 9 | **BH Ergodic MT4** | 52.00 % | 189.13 % | 1948 | 52.62 % | 230.60 % | 1908 | 419.7 % | 0.10 % / 0.12 % | live |
| 10 | **Trendilo** | 52.37 % | 311.85 % | 3267 | 51.50 % | 107.82 % | 1800 | 419.7 % | 0.10 % / 0.06 % | Archiv |
| 11 | **Twin Range Filter** | 40.55 % | 221.05 % | 1243 | 42.02 % | 178.81 % | 677 | 399.9 % | 0.18 % / 0.26 % | Archiv |
| 12 | **Know Sure Thing** | 47.73 % | 122.20 % | 794 | 51.59 % | 271.69 % | 566 | 393.9 % | 0.15 % / 0.48 % | live |
| 13 | **Ichimoku Oscillator** | 51.21 % | 192.41 % | 4282 | 52.01 % | 192.41 % | 2311 | 384.8 % | 0.04 % / 0.08 % | Archiv |
| 14 | **Radius Trend** | 51.89 % | 128.00 % | 1640 | 53.94 % | 256.00 % | 1624 | 384.0 % | 0.08 % / 0.16 % | live |
| 15 | **Dynamic Sentiment RSI** | 51.56 % | 253.74 % | 3328 | 51.28 % | 123.03 % | 1833 | 376.8 % | 0.08 % / 0.07 % | Archiv |

Knapp dahinter, ebenfalls auf beiden Timeframes positiv: Ichimoku Cloud (373 %),
Zero Lag Trend Signals (369 %), KusKus Starlight (347 %), Range Identifier (344 %),
Top Bottom Ind. (336 %), MACD Zero-Lag (330 %), Gaussian Channel (308 %).

## Bestenlisten nach Timeframe

**Nur 30-Min (Scalping/aktives Daytrading)**

1. FRAMA Channel: 887.57 %
2. DSL Oscillator: 324.52 %
3. Price Momentum Osc.: 321.77 %
4. Trendilo: 311.85 %
5. Claude Indicator: 309.46 %
6. JFKP_Stochastic: 302.01 %
7. Andean Oscillator: 273.18 %
8. Average Force: 261.97 %
9. Dynamic Sentiment RSI: 253.74 %
10. Top Bottom Ind.: 234.45 %

**Nur 1-Hour (ruhigeres Daytrading)**

1. FRAMA Channel: 653.87 %
2. Squeeze Momentum: 379.22 % (*aber −24.75 % auf 30m*)
3. Didi Index: 345.41 % (*aber −107.07 % auf 30m*)
4. DSL Oscillator: 303.70 %
5. Ichimoku Cloud: 302.83 %
6. KusKus Starlight: 282.51 %
7. Range Identifier: 278.32 %
8. Know Sure Thing: 271.69 %
9. Derivative Oscillator: 267.05 %
10. Claude Indicator: 260.13 %

## Gebühren-Check: der wichtigste Punkt für Crypto

Die Seite sagt nicht, ob Gebühren und Slippage eingerechnet sind. Eine grobe
Überschlagsrechnung zeigt, warum das wichtig ist:

- 2 % Risiko bei einem ATR-Stop von ca. 1 % Abstand (typisch BTC auf 30m/1h)
  ergeben eine Positionsgröße von ca. **2× Kontogröße**.
- Taker-Gebühr ca. 0.05–0.06 % pro Seite → Roundtrip ca. 0.11 % auf das
  Nominal → **ca. 0.2–0.25 % des Kontos pro Trade**, ohne Slippage und Funding.

Die meisten Indikatoren verdienen laut Tabelle nur **0.05–0.15 % pro Trade**.
Wenn die Backtests ohne Kosten gerechnet sind, wäre das in Crypto nach Gebühren
**nahe null oder negativ**. Bei der aktuellen Datenlage haben nur diese Indikatoren
genug Puffer pro Trade (≥ ca. 0.25 %):

| Indikator | Edge/Trade 30m | Edge/Trade 1h | Hinweis |
|---|---|---|---|
| FRAMA Channel | 0.46 % | 0.36 % | Trendfolger, Winrate nur ca. 31 %. Lange Verlustserien sind normal |
| Know Sure Thing | 0.15 % | **0.48 %** | nur auf 1h stark |
| Ichimoku Cloud | 0.05 % | **0.40 %** | nur auf 1h |
| SuperTrend Fusion | 0.35 % | 0.36 % | kleine Stichprobe (382 / 308 Trades) |
| Twin Range Filter | 0.18 % | 0.26 % | Winrate ca. 41 % |
| Purple Cloud | 0.12 % | 0.25 % | höchste 1h-Winrate (54.8 %) |
| Gaussian Channel | 0.13 % | 0.24 % | |

Fazit: Wer viele Trades mit kleinem Edge macht (Andean Oscillator, Ichimoku Oscillator,
Doda Stochastic), braucht Maker-Orders bzw. sehr niedrige Gebühren.

## Für Crypto-Daytrading eher meiden

Auf mindestens einem Intraday-Timeframe negativ oder insgesamt schwach:

| Indikator | 30m P/L | 1h P/L |
|---|---|---|
| QQE MT4 | −241.40 % | −21.92 % |
| SSL Channel | −110.56 % | −109.82 % |
| HalfTrend | −144.35 % | 131.14 % |
| ZLVQI | −107.00 % | 83.63 % |
| Vortex | −110.31 % | 138.92 % |
| Didi Index | −107.07 % | 345.41 % |
| Coral Trend | −73.54 % | 197.20 % |
| SuperTrend (klassisch) | −53.87 % | 70.77 % |
| Dorsey Inertia | −42.71 % | 31.46 % |
| RSI (klassisch) | −36.02 % | 172.44 % |
| Squeeze Momentum | −24.75 % | 379.22 % |
| UT Bot Alerts | −13.16 % | 129.27 % |
| Golden Cross (50/200) | −11.43 % | 52.54 % |

Viele Klassiker wie RSI, SuperTrend, QQE und SSL schneiden intraday schlecht ab.
Mehrere davon (QQE, SSL, SuperTrend) sind dafür auf **1-Day** stark (+31 % bis +42 %).

## Bezug zu diesem Repo

Die vorhandenen Strategie-Templates (`docs/STRATEGY_TEMPLATES.md`) nutzen vor allem
klassische Indikatoren: RSI, Donchian, Bollinger, MACD und EMA/ADX. Laut dieser
Rangliste sind Donchian Channel (Σ 115 %) und RSI (30m negativ) intraday eher
schwach. Kandidaten für neue Templates oder Features wären die Top-Indikatoren
oben. Sie sollten vorher mit dem eigenen Backtest-Engine **nur auf Crypto-Daten
und mit realen Bitunix-Gebühren** geprüft werden (siehe `docs/BACKTESTING.md`).
Achtung: Viele davon sind proprietäre bzw. Community-Skripte aus TradingView
(z. B. „Claude Indicator“, „Average Force“, „JFKP_Stochastic“). Die genaue Formel
muss also erst beschafft werden.
