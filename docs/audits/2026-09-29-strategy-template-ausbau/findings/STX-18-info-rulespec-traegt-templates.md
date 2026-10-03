# STX-18 — INFO: `RuleSpec`-Kette trägt 5 der 7 Templates ohne Engine-Umbau

- **ID:** STX-18
- **Severity:** INFO
- **Bereich:** Handelslogik
- **Quelle:** Ausbaudokument §1.3–1.8
- **Status:** VERIFIED — Abgleich 2026-10-03: alle sechs Templates gebaut, kompiliert und vertraglich abgesichert (03-01…03-10)

## Abgleich 2026-10-03

- **Geprüfter Stand:** `main` @ `3d13161` · Code-Version `0.10.6` (Beta)
- **Eingestuft:** `☑` **VERIFIED** — unverändert bestätigt
- **Abgleich-Bericht:** [`../remediation/RECONCILE-2026-10-03.md`](../remediation/RECONCILE-2026-10-03.md)

**Nachweise**

- Sechs Templates in `src/strategies/templates/`: `ema-adx-trend`, `macd-momentum`, `rsi-mean-reversion`, `bollinger-squeeze`, `vwap-pullback`, `donchian-breakout`
- Generierte Doku `docs/STRATEGY_TEMPLATES.md:21-28` — Übersicht mit Klasse, Timeframes, erwarteten Regimes, Versions- und Parameterzahl
- Vertragstests `tests/strategies.templates.test.ts` ausgeführt: **grün** (im Paket 195 Tests, 0 Fehler)
- **„Nicht bestätigt" bleibt gültig:** `RECLAIM`/`CROSS` als `RuleTrigger` sind kein `RULE_FIELDS`-Patch — der Evaluator ist zustandslos; eigener Audit

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

## Empfehlung

Templates 03-03 (EMA/ADX), 03-04 (MACD), 03-05 (RSI) sofort. 03-06/03-08 nach den
Feature-Prompts. 03-07 ohne Sequenz.
