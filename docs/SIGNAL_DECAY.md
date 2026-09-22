# Signal-Decay-Exits (RMA-P5-05, v1.69.0)

Versionierte, deterministische Exits, wenn das **persistierte Entry-Signal**
gegenüber einem **point-in-time aktuellen Signal derselben Semantik** bestätigt
verfallen oder umgekehrt ist. `SIGNAL_DECAY` ist ein eigener Exit-Grund — nicht
`TIME_STOP` und nicht `MANUAL_FLATTEN`.

Audit-Basis des Befunds war `df3163e` (`decideExit` kannte nur SL/TP/Trailing/Time).
Der Code stand bei der Umsetzung auf `v1.68.0`. Der Exit wurde **additiv**
hinter die bestehenden Safety-Exits gehängt. Der eingefrorene
`src/backtest/simulator.ts` und der `event_replay`-Pfad bleiben unverändert;
`SIGNAL_DECAY` im Backtest gilt für `legacy` und `paper`.

## Priorität

Safety zuerst. Genau ein Grund gewinnt:

1. Kill-Switch / Flatten (außerhalb von `decideExit`; unterdrückt `SIGNAL_DECAY`)
2. `STOP_LOSS`
3. `TAKE_PROFIT`
4. `TRAILING_STOP`
5. `TIME_STOP`
6. `SIGNAL_DECAY`

Ein fehlendes, stales, invalides oder versionsfremdes Signal ist `UNKNOWN`.
Es schließt **nicht** und setzt die Bestätigung nicht fort. `null` ist nicht `0`.

## Vertrag `sig1`

Jedes vergleichbare Signal trägt:

| Feld | Einheit | Bedeutung |
| --- | --- | --- |
| `direction` | `LONG` / `SHORT` / `FLAT` | Seitenrichtung. `null` = nicht gemessen. |
| `strength` | [0, 1] | Stärke. `null` = nicht verfügbar, nie still 0. |
| `confidence` | [0, 1] | Konfidenz. `null` = nicht verfügbar. |
| `coverage` | [0, 1] oder `null` | Anteil vorhandener Features. Unbekannt ≠ 0. |
| `calculatedAsOf` | ISO-8601 | Zeitpunkt der Feature-Berechnung. |
| `availableAt` | ISO-8601 | Frühester Zeitpunkt, zu dem das Signal bekannt sein durfte. |
| `computedAt` | ISO-8601 | Rechenzeit. Muss ≥ `availableAt` sein, wenn beide gesetzt sind. |
| Versionen | Text | `semanticsVersion`, `featureVersion`, `modelVersion`, `configVersion`. |
| `migrationId` | Text oder `null` | Nur gesetzt, wenn der Snapshot das Ergebnis einer expliziten Migration ist. |

Live-Semantik `mkt-sig-1` (Features `ohlcv-rsi-ema-1`, Modell
`deterministic-linear-1`, Config `mkt-sig-cfg-1`):

- Nur Kerzen, deren Close zum Entscheidungszeitpunkt schon verfügbar ist.
- Live (`timeBasis: "open"`): Kerzenzeit ist die **Open-Zeit**. Verfügbar bei
  `time + 15m` (Intervall `15m`). Die laufende Kerze bleibt draußen.
- Backtest-Default (`timeBasis: "close"`): `candle.time` ist der Moment, zu dem
  der Close der Engine bekannt ist. Kerzen mit `time > asOf` bleiben draußen.
- Richtung aus EMA9/EMA21-Spread (Gewicht 0.6, Vollausschlag 2 % vom Preis)
  und RSI14 (Gewicht 0.4). `|composite| ≤ 0.05` ⇒ `FLAT`.
- Stärke = `|composite|` in [0, 1]. Konfidenz = Coverage der vier Features.
- Weniger als 21 Closes oder fehlendes Feature ⇒ Snapshot ohne Richtung/Stärke
  (Coverage < 1), kein erfundener Score.

Der Entry-Snapshot wird **einmal** nach dem Fill geschrieben
(`positions.entry_signal`) und ist danach unveränderlich. NULL = Altbestand
oder nicht erfasst = `MISSING_ENTRY`, nie Decay.

## Kompatibilität

Current muss dieselben fünf Versionen tragen **oder** eine explizit akzeptierte
Migration (`SIGNAL_DECAY_MIGRATIONS` oder `current.migrationId` aus der
geschlossenen Menge) den Entry auf die Current-Semantik heben.

Bekannte Migrationen: `mig-mkt-sig-0-to-1`, `mig-strength-pct-to-unit`
(Stärke muss in (1, 100] liegen, wird durch 100 geteilt). Nicht gelistete IDs
werden nicht angewendet.

| Status | Folge |
| --- | --- |
| `COMPATIBLE` | Schwellenprüfung |
| `MISSING` / `STALE` / `INCOMPATIBLE` / `INVALID` / `FUTURE` / `LOW_COVERAGE` | kein Exit, Zählung eingefroren |
| `FUTURE` (`availableAt` oder `calculatedAsOf` > `asOf`) | Signal verworfen. Audit setzt Current-Scores und Current-Zeitstempel auf `null`. |

Stale: `asOf - availableAt > maxStalenessMs` der Klasse.

## Policy (bounded, default-off)

Modus `SIGNAL_DECAY_MODE`: `off` | `monitor` | `active`. Unbekannt ⇒ `monitor`.
`off` schreibt nichts und ändert Exits nicht.

Jede Klasse (`trend`, `mean-reversion`, `breakout`, `unclassified`) ist
**default aus**, auch in `active`. `unclassified` wird nie automatisch
eingeschaltet. Schwellen in `risk_config` als `sdc.<klasse>.<feld>` (Klasse
`mean_reversion` wird als `mean-reversion` gelesen) und auf Bounds geklemmt.

| Feld | Bounds | Default (Trend) | Bedeutung |
| --- | --- | --- | --- |
| `enabled` | 0/1 | 0 | Klasse darf bewerten. |
| `absoluteDrop` | [0.05, 0.95] | 0.30 | Stärkepunkte. Breach wenn `entry − current ≥ Schwelle`. |
| `relativeDrop` | [0.05, 0.95] | 0.45 | Anteil. Breach wenn `(entry − current) / entry ≥ Schwelle`. |
| `thresholdMode` | absolute/relative/either/both | either | Verknüpfung der beiden Drops. Env `SIGNAL_DECAY_THRESHOLD_MODE` ist global. |
| `reversalEnabled` | 0/1 | 1 | Gegenrichtung zur Position. |
| `reversalMinStrength` | (0, 1] | 0.35 | Mindeststärke der Gegenrichtung. |
| `reversalMinConfidence` | [0, 1] | 0.60 | Mindestkonfidenz der Gegenrichtung. |
| `minHoldMs` | [0, 30d] | 60 min (Trend) | Vorher zählt ein Kandidat nicht und setzt die Zählung nicht zurück. |
| `confirmationCount` | [1, 20] | 3 | Aufeinanderfolgende kompatible Breaches. |
| `halfLifeMs` | null oder [60s, 30d] | 24h (Trend), null bei unclassified | Optionaler Zeitpfad. `≤ 0` in der Config schaltet ihn aus. |
| `halfLifeRemainingRatio` | [0.05, 0.95] | 0.50 | Halbwertszeit-Pfad, wenn `current ≤ entry × Ratio` und Haltedauer ≥ `halfLifeMs`. |
| `maxStalenessMs` | [60s, 7d] | 2h (Trend) | Darüber ist Current stale. |
| `minCoverage` | [0, 1] | 0.75 | Darunter `LOW_COVERAGE`. |

Reversal gewinnt vor Halbwertszeit vor Schwellen-Drop. Ein kompatibles Signal
ohne Breach setzt den Zähler auf 0 (Hysterese). Dieselbe Beobachtung
(`sdo1`-Key aus availableAt, Versionen, Richtung, Stärke, Konfidenz) zählt
nicht zweimal und löst keinen nachträglichen Exit aus. Eine andere
Policyversion (`sdp1`, Fingerprint der geklemmten Policy) setzt den Zähler
zurück.

`shouldExit` nur wenn Modus `active`, Bestätigung neu erreicht, Kill-Switch
nicht bewaffnet und die Beobachtung nicht doppelt ist. `monitor` setzt
`wouldExit` und schließt nicht.

## Counterfactual

Erstes `WOULD_EXIT` / `EXIT` / `SUPPRESSED_KILL_SWITCH` je Position ist die
Referenz. Mark-to-market (ohne erfundene Gebühren):

- LONG: `qty × (mark − entry)`
- SHORT: `qty × (entry − mark)`
- ungültige Inputs ⇒ `null`, nicht 0

Nach einem echten Close (beliebiger Grund):

- `additionalPnl = max(0, mtm − realized)` — der Signal-Exit hätte mehr gesichert
- `avoidedPnl = max(0, realized − mtm)` — das Nicht-Schließen hat diesen Betrag erhalten

`triggerCoverage = compatible / evaluated`. `evaluated = 0` ⇒ Coverage `null`.

## Persistenz und Idempotenz

Migration (append-only, zweimal ausführbar):
`drizzle/2026-09-22_signal_decay.sql`.

- `positions.entry_signal` / `entry_signal_hash` — einmalig, Trigger verbietet Änderung
- `signal_decay_streak`, `signal_decay_last_key`, `signal_decay_policy_version` — Hysterese, überlebt Neustart (CAS `WHERE status = 'OPEN'`)
- `strategy_class`
- `signal_decay_events` — append-only, `event_id = sde1` aus Position, Beobachtung und Policy. `ON CONFLICT DO NOTHING`. Zeit-Checks: `computed_at ≥ as_of`, `available_at ≤ as_of`.

**Deploy:** Migration vor dem App-Start. `db.select()` auf `positions` liest die
neuen Spalten. Ohne Migration bricht der Tick (kein stilles Weglassen).

Entry-Capture ist best-effort nach dem Fill (Engine und Mikro-Executor). Ein
Fehler lässt die Position NULL und bricht den Fill nicht ab. Geschrieben wird
nur, wenn der Modus nicht `off` ist und die Klasse aktiviert ist.

## API

`GET /api/firm/risk/signal-decay` — Policy, Bounds, Policyversion, Rollup, Priorität.

`POST` mit `firm.write`: `{ "key": "sdc.trend.enabled", "value": 1 }`. Der Modus
selbst bleibt die Env-Variable. Unbekannte Schlüssel werden mit 400 abgelehnt.

Audit-Events: `SIGNAL_DECAY_CAPTURED`, `SIGNAL_DECAY_COUNTERFACTUAL`,
`SIGNAL_DECAY_EXIT`. Metrik-Labels nur `result`, `mode`, `strategy_class`
(keine Positions- oder Symbol-IDs).

## Rollback

1. `SIGNAL_DECAY_MODE=off` — keine Bewertung, keine Writes, Exits wie zuvor.
2. Oder Klassenflags auf 0 (`SIGNAL_DECAY_CLASS_*` / `sdc.*.enabled`) — Modus
   kann `monitor` bleiben, ohne dass eine Klasse schließt.
3. Tabellen nicht löschen müssen. Downgrade der Spalten nur, wenn keine
   App-Version mehr darauf selektiert:

```sql
DROP TRIGGER IF EXISTS positions_entry_signal_immutable ON positions;
DROP TRIGGER IF EXISTS signal_decay_events_immutable ON signal_decay_events;
DROP TABLE IF EXISTS signal_decay_events;
ALTER TABLE positions DROP COLUMN IF EXISTS entry_signal,
  DROP COLUMN IF EXISTS entry_signal_hash,
  DROP COLUMN IF EXISTS signal_decay_streak,
  DROP COLUMN IF EXISTS signal_decay_last_key,
  DROP COLUMN IF EXISTS signal_decay_policy_version,
  DROP COLUMN IF EXISTS strategy_class;
```

Die CHECK-Erweiterung von `backtest_trades.exit_reason` um `SIGNAL_DECAY` ist
additiv. Ein Downgrade muss den alten Check wiederherstellen, bevor Zeilen mit
diesem Grund existieren.
