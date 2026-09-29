# STX-03-08 — Template: Donchian Breakout

- **Phase:** 3 · **Paket:** 03-02, **02-03** · **Finding:** STX-18
- **Risiko:** niedrig

## Zweck

Sechstes Template, letztes der Reihe. Nutzt `donchianBreakoutPct` aus 02-03.

## Kontext

`donchianBreakoutPct` = Abstand des Schlusskurses zum **Hoch der vorletzten 20
Kerzen** (ohne die aktuelle — der Lookahead-Schutz aus 02-01). `> 0` heißt: Der Kurs
schließt über dem Kanalhoch.

**Zwei Punkte, die im Doc-Kommentar stehen müssen:**

1. **Higher-Timeframe-only.** Donchian ist per Definition Ausbruchs-/Trendfolge-
   Systemik. Auf `5m` ist ein 20-Bar-Kanal 100 Minuten — kein Ausbruch im Sinne der
   Strategie. `supportedTimeframes: ["1h", "4h"]`.
2. **Der Ausbruch kostet.** Der Einstieg zum Schlusskurs **nach** einem Ausbruch
   über dem 20-Bar-Hoch kauft typischerweise am lokalen Hoch. Das ist eine
   **strukturelle** Eigenschaft, kein Parameterfehler — und genau der Grund, warum die
   `takeProfitRR`-Vorgabe niedriger ist als beim EMA/ADX-Trend.

## Auftrag

Lege `src/strategies/templates/donchian-breakout.ts` an.

| Feld | Wert |
|---|---|
| `id` | `donchian-breakout` |
| `class` | `"breakout"` |
| `supportedTimeframes` | `["1h", "4h"]` |
| `requiredFields` | `["donchianBreakoutPct", "adx14", "volumeRatio", "atrPct"]` |

**Parameter:**

| key | label | unit | default | min | max | step | mapsTo |
|---|---|---|---|---|---|---|---|
| `breakoutMinPct` | mind. Abstand über Kanal | % | `0.3` | `0.0` | `3.0` | `0.1` | `donchianBreakoutPct` |
| `adxMin` | ADX-Bestätigung | Index | `20` | `14` | `35` | `1` | `adx14` |
| `volumeRatioMin` | Volumen beim Ausbruch | ratio | `1.2` | `0.9` | `3` | `0.05` | `volumeRatio` |
| `stopLossPct` | Stop-Loss | % | `5` | `1` | `15` | `0.5` | `atrPct` |
| `takeProfitRR` | Chance/Risiko | ratio | `2` | `1` | `4` | `0.25` | — |

**`buildRule`:** `logic: "all"`, drei Bedingungen — `donchianBreakoutPct gte breakoutMinPct`,
`adx14 gte adxMin`, `volumeRatio gte volumeRatioMin`.

`window.timeframe: "1h"`, `maxExecutionsPerDay: 1` (**ein Ausbruch pro Tag** — ein
Breakout-Charset erzeugt sonst Nachfolge-Einstiege am selben Ausbruch),
`cooldownMinutes: 720`.

**`assumptions`** (mindestens 4), u. a.:

- `MARKET` „20-Bar-Ausbrüche markieren Regime-Wechsel" — `critical: false`
- `EXECUTION` „Der Einstieg erfolgt zum Schlusskurs **nach** dem Ausbruch — das ist der
  lokale Hoch-Punkt; strukturelle Properties, keine Parameterfrage" — `critical: true`
- `DATA` „`donchianBreakoutPct` bezieht sich auf die **vorigen** 20 Kerzen, ohne die
  aktuelle (kein Look-ahead)" — `critical: true`
- `COST` „Breakout-Einstiege zahlen den Spread am lokalen Hoch" — `critical: true`

**`expectedRegimes`**: `["TREND_UP", "RANGE"]`

**Doc-Kommentar-Pflicht:** Punkt 1 und 2 oben wörtlich aufnehmen. Außerdem: der
`entryPeriod` (20) ist **kein** Regelfeld, sondern Template-Konfiguration — und der
Snapshot rechnet mit dem kanonischen Default aus 02-03. Wenn 06-02 eine andere Periode
testen will, braucht es **dann** ein zusätzliches Feld; dokumentiere das als
bekannte Grenze, statt es hier zu bauen.

## Akzeptanzkriterien

- [ ] `validateTemplate(...)` liefert `[]`
- [ ] `requiredFields` enthält `donchianBreakoutPct` (setzt 02-03 voraus)
- [ ] `maxExecutionsPerDay === 1`
- [ ] `buildRule(defaults)` → `sanitizeRuleSpec()` ohne Klemmschreiben
- [ ] Ein Eintrag in `STRATEGY_TEMPLATES` — danach hat der Katalog **6** Templates
- [ ] `npm run typecheck && npm run lint && npm test` grün

## Gesperrt

- **Keine** Änderung an `donchianChannel` / `donchianBreakoutPct`.
- **Kein** `entryPeriod`-Regelfeld.
- **Keine** Short-Variante (der Donchian-Short ist das natürliche Gegenstück und
  braucht den `side`-Wert, den die Engine nicht kennt).
