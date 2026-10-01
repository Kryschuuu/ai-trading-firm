# STX-18 — INFO: `RuleSpec`-Kette trägt 5 der 7 Templates ohne Engine-Umbau

- **ID:** STX-18
- **Severity:** INFO
- **Bereich:** Handelslogik
- **Quelle:** Ausbaudokument §1.3–1.8
- **Status:** FELDSEITE GEKLÄRT (2026-09-30) · TEMPLATES ZU 4/6 GEBAUT (2026-10-01) — Bollinger-Regelfelder 02-02 (`v0.6.4`), Donchian-Regelfeld 02-03 (`v0.6.5`); Templates 03-03 (`v0.7.1`), 03-04 (`v0.7.2`), 03-05 (`v0.7.3`), 03-06 (`v0.7.4`) umgesetzt; 03-07/03-08 offen

## Befund

Die Analyse des Dokuments zur Machbarkeit der einzelnen Strategien trifft zu:

| Template | Benötigt neue Felder? | Zusätzliche Engine-Arbeit |
|---|---|---|
| EMA/ADX Trend | **nein** — `trend`, `priceVsEma50Pct`, `adx14`, `volumeRatio` existieren | keine |
| MACD Momentum | **nein** — `macdHist`, `priceVsEma50Pct`, `adx14` existieren | keine |
| RSI Mean Reversion | optional `bbZScore` (ohne: RSI+EMA+ADX reicht) | keine |
| Bollinger Squeeze | **ja** — `bbZScore` oder `priceVsUpperBbPct` (STX-02/03) | keine |
| VWAP Pullback (Snapshot-Variante) | **nein** — `trend`, `vwapPct`, `volumeRatio`, `priceVsEma21Pct` | keine |
| Donchian Breakout | **ja** — `donchianBreakoutPct` (02-03, `v0.6.5`) | keine |
| Cross-Sectional Momentum | n/a — **kein** `RuleSpec` (siehe STX-05) | entfällt |

**3 von 5 P0-Templates sind sofort umsetzbar.** Das ist die stärkste Bestätigung des
Dokuments.

## Nicht bestätigt

Die `RECLAIM`-Sequenz (§1.8) und die `RuleTrigger`-Erweiterung
(`SNAPSHOT | CROSS | RECLAIM | BREAKOUT`) sind **kein** `RULE_FIELDS`-Patch. Der heutige
Evaluator ist **zustandslos** (`compileRuleSpec` erzeugt eine Closure über einen
Snapshot). Zustand erfordert Speicher im `MicroExecutor` über Zeit — mit Regressionsrisiko
für Stops, Cooldowns und `maxExecutionsPerDay`.

→ **Eigener Audit**, nicht Teil dieser Roadmap.

## Umsetzung 03-06 (`v0.7.4`)

Bollinger Squeeze Breakout ist als viertes Katalog-Template umgesetzt, mit
`class: "breakout"`, Timeframes `1h`/`4h` und dem Feld `bbZScore` aus 02-02.
Die vier `all`-Bedingungen und alle Parameter-Rasterpunkte überstehen die
bestehende Sanitize-Kette ohne Klemmung; 25 Tests sichern Vertrag und Grenzen.

Die σ-Rechnung des Auftrags ist korrigiert: An `upper = middle + 2·σ` gilt
`z = (close − middle)/σ = 2`, nicht ungefähr 1,4. Default 0,5 bleibt als frühes
Setup über der Bandmitte erhalten; kein redundanter Kantenfilter. Die
6-%-Bandbreitenschwelle ist noch **nicht vermessen** und vor Live-Einsatz in
06-01/06-02 markt-/timeframe-/regimespezifisch gegen den Store zu prüfen.
Die Snapshot-Vereinfachung und Schlusskurs-Latenz sind explizite Annahmen;
kein Sequenz-/Cross-Trigger und keine Engine-Änderung.

Details: [Strategie-Stack §1.1](../../../architecture/STRATEGY_STACK.md#11-bollinger-squeeze-stx-03-06-v074).

## Nächste Schritte

03-07 (VWAP) ohne Sequenz und 03-08 (Donchian) auf dem Feld aus 02-03.
Compiler 03-09 und Phase-3-Abnahme 03-10 bleiben offen; die Implementierung
belegt keine wirtschaftliche Edge oder Live-Tauglichkeit.
