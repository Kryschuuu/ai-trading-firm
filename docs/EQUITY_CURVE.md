# Equity-Kurve, Drawdown & Report-Zeiträume

> **Status-Header:** **Implementiert** (UI/Report-Ausbau) · **2026-10-04** · Code-Version **0.13.0**
> · Module: `src/lib/equity.ts`, `src/lib/equityAnalytics.ts`, `src/lib/equityRange.ts`,
> `src/lib/equityBenchmark.ts`
> · APIs: `GET /api/firm/equity`, `GET /api/firm/report`
> · Migration/CLI: keine (nur Env-Flags `EQUITY_RAW_RETENTION_DAYS`, `EQUITY_RETENTION_DAYS`,
> `EQUITY_ALERTS_ENABLED`, `EQUITY_ALERT_DRAWDOWN_PCT`, `EQUITY_ALERT_PEAK_MIN_PCT`)

Dieses Dokument ist die kanonische Beschreibung der Kurvendarstellung im
Dashboard (Tab **Reports**): welche Zeiträume es gibt, wie verdichtet wird, was
„Drawdown“ hier bedeutet — und warum der Drawdown vorher im Report
systematisch **0 %** anzeigte.

---

## 1. Datenquelle und Auflösung

Die Kurve kommt aus `equity_snapshots` (`src/db/schema.ts`):

| Feld | Bedeutung |
| --- | --- |
| `ts` | Zeitpunkt des Snapshots (`timestamptz`) |
| `equity` | Kontostand = freies Cash + Marktwert offener Positionen |
| `cash` | freies Cash |
| `open_positions` | Anzahl offener Positionen |
| `realized_pnl_today` | realisiertes P&L des laufenden Berliner Tages |
| `trigger` | `TICK` (60-s-Monitor), `TRADE`, `CLOSE`, `FLATTEN`, `BOOT` |

Geschrieben wird bei **jedem Monitor-Tick (60 s)** und bei jedem Trade
(`src/lib/monitor.ts` → `writeEquitySnapshot()`).

### Zweistufige Aufbewahrung

Vorher löschte der Monitor alles älter als 90 Tage — längere Zeiträume waren
damit unmöglich. Jetzt gilt:

1. **Rohdaten** — 60-s-Snapshots für `EQUITY_RAW_RETENTION_DAYS` (Default **90**).
2. **Tagesverdichtung** — ältere Rohdaten werden auf **zwei Punkte je Berliner
   Kalendertag** eingedampft: Tiefststand (`min(equity)`) und Tagesschluss
   (letzter Snapshot). Beide sind nötig: der Tagesschluss zeichnet die Kurve,
   das Tagestief hält den Drawdown ehrlich.
3. **Harte Grenze** — jenseits von `EQUITY_RETENTION_DAYS` (Default **730**,
   also zwei Jahre) wird gelöscht.

Die Verdichtung läuft in SQL (`row_number()` je Berliner Tag) und damit auch
bei Hunderttausenden Zeilen ohne JS-Zwischenarray; sie läuft im Monitor alle
~4 h (`PRUNE_EVERY_TICKS`).

| Flag | Default | Bounds | Wirkung |
| --- | --- | --- | --- |
| `EQUITY_RAW_RETENTION_DAYS` | `90` | 7…3650 | Tage mit unverdichteten 60-s-Snapshots |
| `EQUITY_RETENTION_DAYS` | `730` | 30…3650 | Gesamtfenster der Kurve (nie kleiner als `EQUITY_RAW_RETENTION_DAYS`) |

### Lesen für den Chart

`readEquitySeriesWindow()` liest **SQL-Buckets**: je Bucket werden erster,
tiefster, höchster und letzter Snapshot behalten (also die Extremwerte, nicht
„jeder n-te Punkt“). Andernfalls würde ein Drawdown-Tief zwischen zwei
Abtastpunkten verschwinden und der Chart zu glatt aussehen. Danach folgt eine
zweite, JS-seitige Sicherung (`downsamplePreservingExtremes`) — sie behält das
globale Minimum und Maximum immer.

#### Fallstricke in der Umsetzung (2026-10-03, beim Live-Test gefunden)

Drei Fehler, die die Kurve im Betrieb verfälscht bzw. die Route 500 geliefert
hätten — sie stehen hier, damit sie nicht zurückkommen:

1. **Spalten-Mapping:** `db.execute` liefert die SQL-Aliase in snake_case
   (`ts_first`), die JS-Seite las camelCase (`tsFirst`) → `undefined` in
   `new Date(...)` und damit `RangeError: Invalid time value`. Die Zeilen werden
   deshalb **explizit** gemappt (kein Alias-Vertrauen); Zeitstempel kommen als
   **Epoch-Millisekunden** (`extract(epoch FROM ts) * 1000`) aus der DB, weil
   `node-postgres` `timestamptz` sonst als Text liefert.
2. **Bucket-Extremwerte:** Die vier Kandidaten eines Buckets (erster, tiefster,
   höchster, letzter) stehen **nicht** chronologisch. Ein Filter „nur
   aufsteigende Zeitstempel in Einfüge-Reihenfolge“ verwarf das Bucket-Maximum,
   sobald das Tief danach lag — der Hochpunkt verschwand und der Drawdown sah
   zu groß aus. Richtig ist: erst sortieren, dann nur **exakte** Duplikate
   verwerfen (`bucketsToPoints`, Regressionstest in
   `tests/equityAnalytics.test.ts`).
3. **Parameter-Default:** `Number(url.searchParams.get("maxPoints"))` ergibt
   `0`, wenn der Parameter fehlt — nach dem Clamp auf min. 20 bekam die Kurve
   dann nur 20 Punkte und wirkte unnötig grob. Jetzt entscheidet `has()`.

Die Bucket-Breite folgt aus Zeitraum und Punktdeckel (`selectBucketSeconds`):

| Zeitraum | typische Bucket-Breite |
| --- | --- |
| 1 Tag | 15 Minuten |
| 1 Woche | 1 Stunde |
| 1 Monat | 6 Stunden |
| 1 Jahr | 1 Tag |
| Max (2 Jahre Aufbewahrung) | 14 Tage |

---

## 2. Zeiträume

Alle Grenzen sind **Berliner Kalendergrenzen** (`src/lib/time.ts`), nicht
rollende Stunden: „Heute“ heißt ab Mitternacht Ortszeit, „Diese Woche“ ab
Montag 00:00.

| ID | UI-Button | Start |
| --- | --- | --- |
| `day` | 1 T | heutige Berliner Mitternacht |
| `week` | 1 W | Montag der aktuellen Woche 00:00 |
| `month` | 1 M | 1. des Monats 00:00 |
| `quarter` | 3 M | 1. Jan/Apr/Jul/Okt |
| `halfyear` | 6 M | 1. Januar bzw. 1. Juli |
| `year` | 1 J | 1. Januar |
| `all` | Max | Grenze der Aufbewahrung (`EQUITY_RETENTION_DAYS`) |

Aliase (`1d`, `24h`, `7d`, `1m`, `3m`, `90d`, `6m`, `1y`, `365d`, `max`,
`alles`, `1j`) werden normalisiert (`src/lib/equityRange.ts`). Ein unbekannter
Wert fällt auf `week` zurück — **nie** auf „alles“, damit ein Tippfehler nicht
unbemerkt die halbe Historie anzeigt.

---

## 3. Definition: Drawdown

> **Drawdown** = Rückgang des Kontostands vom **bisherigen Höchststand**
> (Peak-to-Trough), in Prozent dieses Höchststands.

Drei Punkte, die dabei entscheidend sind:

1. **Bezug ist der Höchststand, nicht das Startkapital.** Ein Konto, das von
   10 000 auf 12 000 steigt und auf 11 000 fällt, hat 8,33 % Drawdown — obwohl
   es über dem Startwert liegt.
2. **Der Höchststand vor dem Zeitraum zählt mit.** Ein Fenster, das bereits im
   Drawdown beginnt, startet deshalb nicht bei 0 %. Die API liest dafür
   `max(equity)` für `ts < since` (Referenz-Peak).
3. **Die „Startkapital“-Kennzahlen bleiben davon getrennt.** `STARTING_EQUITY`
   (Default 10 000) ist der Bezugspunkt für „seit Start“ und für die harten
   Risiko-Limits (`RISK_MAX_EQUITY_DRAWDOWN_PCT`), nicht für die Kurve.

### Warum der Report vorher 0 % anzeigte

`GET /api/firm/report` summierte die realisierten P&L der geschlossenen Trades
und berechnete daraus einen Drawdown:

```ts
// ALT (fehlerhaft): Peak der P&L-Summe, Start bei 0
let peak = Number.NEGATIVE_INFINITY;
let running = 0;
for (const p of closed) {
  running += Number(p.realizedPnl ?? 0);
  peak = Math.max(peak, running);
  if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((running - peak) / peak) * 100);
}
```

Zwei Fehler: (a) die Reihe beginnt bei 0 — solange die Summe nicht über 0
steigt, wird nie gerechnet (`peak > 0`); (b) „Drawdown der P&L-Summe“ ist nicht
der Drawdown des Kontos (Einzahlungen, offene Positionen und Kursgewinne
fehlen). Jetzt liest der Report dieselbe Equity-Kurve wie das Chart und liefert
zusätzlich `maxDrawdownAbs`, `currentDrawdownPct`, `maxDrawdownFrom`,
`maxDrawdownTo` und `recoveredAt`.

### Offener vs. abgeschlossener Drawdown

`recoveredAt` ist `null`, solange die Kurve den Höchststand nicht wieder
erreicht hat — **nicht** 0 und nicht „abgeschlossen“. Die UI zeigt in diesem
Fall „aktuell X % unter dem Höchststand“ bzw. „noch nicht erholt“
(fail-closed: unbekannt ≠ Null).

---

## 4. API-Referenz

### `GET /api/firm/equity`

Autorisierung: `firm.read` (SEC-02). Antwort: `Cache-Control: private, no-store`.

| Parameter | Werte | Default |
| --- | --- | --- |
| `range` | siehe §2 (+ Aliase) | `week` |
| `resolution` | `auto`, `raw` (60 s), `hourly`, `daily` | `auto` |
| `maxPoints` | 20…2000 | `240` |
| `compare` | `BTC`, `ETH`, `SPY`, `QQQ`, `off`/`none`/`keine` | `off` |
| `from` / `until` | ISO-Zeitstempel — **ersetzt** `range` (für Vorperioden, §5.3) | — |

```jsonc
{
  "ok": true,
  "range": "quarter",
  "since": "2026-07-01T22:00:00.000Z",     // effektiver Fensterstart
  "until": "2026-10-03T09:00:00.000Z",
  "requestedSince": "2026-07-01T22:00:00.000Z",
  "bucketSeconds": 21600,
  "resolution": "6 Stunden",
  "series": [
    { "ts": "…", "equity": 10123.45, "peak": 10300.1, "drawdownPct": 1.71, "drawdownAbs": 176.65, "trigger": "TICK" }
  ],
  "markers": [
    { "kind": "ENTRY", "ts": "…", "symbol": "BTCUSDT", "side": "LONG", "price": 60000 },
    { "kind": "EXIT", "ts": "…", "symbol": "BTCUSDT", "side": "LONG", "price": 59000, "pnl": -120.5, "exitReason": "STOP_LOSS" }
  ],
  "stats": { "maxDrawdownPct": 6.67, "currentDrawdownPct": 1.71, "recoveredAt": null, "returnPct": 1.23, "volatilityPct": 0.84, "sharpeLike": 1.12, "/* … */": null },
  "twr": { "twrPct": 1.18, "simplePct": 1.23, "days": 94, "flows": { "count": 0, "total": 0, "applied": false }, "bestDayPct": 0.91, "worstDayPct": -0.62 },
  "benchmark": { "id": "BTC", "label": "Bitcoin (BTC/USDT)", "source": "BINANCE:BTCUSDT", "timeframe": "1d", "points": [ { "ts": "…", "value": 10123.45 } ], "returnPct": 8.4 },
  "episodes": [ { "peakTs": "…", "peakValue": 10300.1, "troughTs": "…", "troughValue": 9614.2, "drawdownPct": 6.67, "recoveredAt": "…", "declineMs": 5400000, "recoveryMs": 10800000, "totalMs": 16200000, "open": false } ],
  "monthly": [ { "ym": "2026-09", "year": 2026, "month": 9, "pct": 2.4, "points": 148, "partial": true } ],
  "calendarSince": "2026-10-01T22:00:00.000Z",  // Anfang des Kalenderfensters aus `range`
  "retention": { "rawDays": 90, "retentionDays": 730, "historyStart": "…", "priorPeak": 10300.1, "truncated": false }
}
```

Die Kennzahlen kommen ausschließlich aus `src/lib/equityAnalytics.ts`
(reine Funktionen, `tests/equityAnalytics.test.ts`): Rendite, Hoch/Tief,
Drawdown-Details, Tagesrenditen (bestes/schlechtestes Tagesergebnis,
Positiv-/Negativtage) und eine annualisierte Sharpe-ähnliche Kennzahl, die erst
ab fünf Tagesrenditen berechnet wird (vorher `null`).

### `GET /api/firm/report`

`?period=day|week|month|quarter|halfyear|year` (Berliner Grenzen). Zusätzlich
zu den bisherigen KPIs liefert der Report nun:

- `kpis.maxDrawdownPct` / `maxDrawdownAbs` / `currentDrawdownPct` — aus der
  Equity-Kurve (Peak-to-Trough, §3),
- `kpis.maxDrawdownFrom` / `maxDrawdownTo` / `recoveredAt`,
- `kpis.grossProfit`, `grossLoss`, `avgWin`, `avgLoss`, `expectancy`,
  `payoffRatio`, `maxWinStreak`, `maxLossStreak`, `avgHoldHours`,
- `equity.series` + `equity.stats` (dieselbe Kurve wie `/api/firm/equity`),
- `twr` (+ `kpis.twrPct`, `kpis.twrSimplePct`, `kpis.twrDays`,
  `kpis.twrCashflowApplied`) — siehe §5.2,
- `drawdownEpisodes` (Top 5 ab 0,05 %) bzw. `kpis.drawdownEpisodes` (Anzahl) —
  siehe §5.1.

---

## 5. Was der Reports-Tab zeigt

### 5.1 Drawdown-Episoden (Peak → Tief → Erholung)

`stats.maxDrawdownPct` sagt *wie tief*, aber nicht *wie lange*. Die API liefert
deshalb zusätzlich die **Top-5-Drawdown-Episoden** (`drawdownEpisodes`,
`minPct` 0,1 in der API, 0,05 im Report):

| Feld | Bedeutung |
| --- | --- |
| `peakTs` / `peakValue` | Höchststand vor dem Rückgang — `null`, wenn er **vor** dem Fenster liegt (dann wird kein Datum erfunden) |
| `troughTs` / `troughValue` | Tiefpunkt |
| `drawdownPct` / `drawdownAbs` | Tiefe bezogen auf den Peak |
| `recoveredAt` | Zeitpunkt der Rückkehr auf den Peak; `null` = **noch offen** |
| `declineMs` / `recoveryMs` / `totalMs` | Abstieg, Erholung, Gesamtdauer (`recoveryMs` = `null`, solange offen) |
| `open` | `true`, wenn die Episode bis zum Fensterende nicht erholt ist |

Die Tabelle im Panel ist nach Tiefe sortiert und zeigt deutsche Dauerangaben
(„5 h 20 min“, ab einem Tag „3 T 4 h“); offene Episoden stehen als „noch offen“.

### 5.2 Zeitgewichtete Rendite (TWR)

`simplePct` („was steht am Ende mehr da“) verzerrt, sobald Kapital zu- oder
abfließt: eine Einzahlung kurz vor einem Verlusttag sieht wie ein Gewinn aus.
Die **zeitgewichtete Rendite** verkettet stattdessen die Tagesrenditen und
bereinigt jeden Tag um die Zu-/Abflüsse, die zwischen den beiden Eckpunkten
liegen (Basis = Vortagesschluss + Zufluss):

```
TWR = Π (1 + (Endstand − Zufluss − Vortagesschluss) / (Vortagesschluss + Zufluss)) − 1
```

| Feld | Bedeutung |
| --- | --- |
| `twrPct` | verkettete Tagesrenditen in Prozent (Tagesgrenzen Berlin) |
| `simplePct` | Differenz erster → letzter Punkt im Fenster |
| `days` | berücksichtigte Tagesrenditen |
| `flows.count` / `flows.total` | gefundene Zu-/Abflüsse und ihre Summe |
| `flows.applied` | ob Cashflows tatsächlich bereinigt wurden |
| `bestDayPct` / `worstDayPct` | bester/schlechtester Tag |

> **Ehrliche Kennzeichnung:** Das Paper-Konto führt (Stand 0.13.0) **keine
> persistierte Cashflow-Spur**. `readEquitySeriesWindow()` übergibt daher keine
> Zu-/Abflüsse, `flows.applied` bleibt `false`, und TWR und einfache Rendite
> sind identisch — die Kennzahl ist dann eine reine Kettenrendite, keine
> cashflow-bereinigte Performance. Sobald eine Flow-Quelle existiert, ändert
> sich nur die Liste im Aufruf (`timeWeightedReturn(points, { flows })`), nicht
> die Rechnung. Ein geratener Cashflow wäre schlimmer als „keiner“: die UI
> schreibt „ohne Cashflow-Spur“ statt eine Bereinigung zu behaupten.

`timeWeightedReturn` liegt als reine Funktion in `src/lib/equityAnalytics.ts`
und ist in `tests/equityAnalytics.test.ts` mit und ohne Flows festgehalten.

### 5.3 Referenzlinie und Vorperioden-Vergleich

- **Referenz (Benchmark):** `?compare=BTC|ETH|SPY|QQQ` schaltet eine
  Buy-and-Hold-Linie dazu. Die Reihen kommen **ausschließlich** aus dem
  `HistoricalStore` (`data/history/candles.ndjson`), der von
  `npm run market:sync` gefüllt wird — die API holt nichts aus dem Netz und
  erfindet keine Kurse. Fehlt die Historie für ein Instrument, ist
  `benchmark` schlicht `null` und die UI schreibt „keine Daten“.
  `readBenchmarkSeries` (`src/lib/equityBenchmark.ts`) probiert je Benchmark
  die bekannten Instrument-IDs und Timeframes (1 d → 4 h → 1 h) durch und
  skaliert beim ersten Treffer mit **≥ 2 Kerzen** auf den Kontostand am
  Fensterstart (`scaleBenchmarkSeries`, Buy-and-Hold).
- **Zwei Zeiträume vergleichen:** „Vorperiode“ bzw. „Ø der letzten 3“ laden
  dasselbe Fenster um eine Periode nach hinten (`?from`/`?until` — deshalb der
  explizite Fensterparameter) und zeichnen die Reihen **indexiert** auf 100.
  Der 3er-Mittelwert entsteht auf der Zeitachse der aktuellen Kurve; fehlende
  Stützstellen werden linear zwischen den geladenen Punkten interpoliert
  (`alignToSeries`), nicht fortgeschrieben.
- Beide Linien erscheinen gestrichelt in der Kurve und mit Namen in der
  Legende; die y-Achse dehnt sich auf den gemeinsamen Wertebereich.

### 5.4 Logarithmische y-Achse und Monats-Heatmap

- **Log-Achse („linear/log“):** Schalter im Panel. Sie skaliert linear in
  `log₁₀(equity)`, verwendet das 1/2/5-Raster je Zehnerpotenz
  (`niceLogTicks`) und nur bei **strikt positiven** Kurswerten; sonst bleibt es
  bei linear (statt eine Achse zu zeichnen, die Null/Negatives nicht abbildet).
  Der Rand ist multiplikativ, damit `yMin` nicht unter 0 rutscht. Das
  Achsenlabel zeigt „· log“ erst, wenn die Spanne mindestens eine Zehnerpotenz
  umfasst — darunter sind log und linear deckungsgleich.
- `calendarSince` ist der Anfang des **Kalenderfensters aus `range`** (bei
  `?from`/`?until` also *nicht* das effektive `since`) — das Panel nutzt ihn für
  die Fußnote „Kalenderfenster ab …“.
- **Monatsrendite-Heatmap:** je Berliner Kalendermonat eine Zelle (grün =
  positiv, rot = negativ, Intensität = Betrag), Zeilen sind Jahre, dazu eine
  verkettete Jahresrendite und eine Fußnote mit x positiv / y negativ, bester
  und schlechtester Monat (`monthlySummary`). Angeschnittene Randmonate sind
  markiert und zählen mit — die Monatsaggregate kommen aus SQL über die
  **gesamte** Aufbewahrung (`readMonthlyEquity`), nicht nur über das Fenster.

### 5.5 Druck / PDF

Der Button **„Druck / PDF“** ruft `window.print()` auf. Die Anzeige ist darauf
vorbereitet:

- Bedienelemente (Buttons, Selects, Zeitraumleiste) tragen `print:hidden`, der
  Report-Kopf `hidden print:block` („Equity-Report · Zeitraum · Stand“).
- `globals.css` erzwingt unter `@media print` die **Light-Palette**
  (dieselben Variablen wie `:root[data-theme="light"]`, unabhängig vom
  gewählten Theme — ein Midnight-Theme druckt sonst schwarze Seiten),
  entfernt Schatten und hält Tabellen/SVG/`.print-break-avoid`-Blöcke
  zusammen. Seitenrand über `@page { margin: 12mm }`.

### 5.6 Kennzahlen- und Bedienübersicht

- **Kennzahlenzeile:** Rendite im Zeitraum, **vs. Startkapital**, maximaler
  Drawdown (mit Peak→Tief-Zeitraum), aktueller Drawdown (mit Erholungsdatum),
  Hoch/Tief, Tagesvolatilität (inkl. Sharpe-ähnlich) und Anzahl Trades —
  jeweils mit InfoTip-Definition.
- **Achsen:** y-Achse mit „schönen“ 1/2/5-Ticks in Kontowährung (bzw.
  Indexdarstellung „Start = 100“), x-Achse auf **echter Zeitachse** mit
  Berliner Labels (Uhrzeit → Datum → Monat/Jahr, je nach Fensterbreite).
  Beide Achsen sind beschriftet („Equity (USD)“, „Zeit (Europe/Berlin)“).
- **Basislinie:** gestrichelte Linie auf dem ersten Punkt des Zeitraums.
- **Drawdown:** eigene Unterwasser-Kurve in Prozent plus schraffiertes
  Max-Drawdown-Band (Peak → Tief) im Hauptchart. Die Drawdown-Achse beschriftet
  kleine Werte mit bis zu zwei Nachkommastellen (`formatPercentTick`) — sonst
  stünden bei 0,86 % Max-Drawdown zwei Ticks als „0 %“ bzw. „1 %“ da.
- **Trade-Marker:** ▲ Einstieg, ● Ausstieg (blau = Gewinn, rot = Verlust);
  ab 80 Markern werden nur Ausstiege gezeichnet, damit die Kurve lesbar bleibt.
- **Hover/Tastatur:** Tooltip je Punkt mit Zeitstempel (Berlin), Equity,
  Abstand zum Zeitraumstart, Drawdown in % und absolut, Höchststand und
  Snapshot-Auslöser („Monitor-Tick (60 s)“). Tastatur: `←`/`→` (mit `Shift`
  in 10er-Schritten), `Pos1`/`Ende`, `Esc`. Für Screenreader liegt derselbe
  Text in einem `aria-live`-Bereich; die SVG trägt eine zusammenfassende
  `aria-label`.
- **Ehrliche Datenlage:** Fußzeile nennt Startkapital, Historiebeginn,
  Auflösung und Lesestand; reicht der gewählte Zeitraum über die Historie
  hinaus, erscheint ein Hinweis mit der tatsächlichen Startzeit.
- **Export:** CSV (`Zeitstempel;Equity;Höchststand;Drawdown_%;Trigger`, plus
  Referenzspalte, wenn eine Vergleichslinie aktiv ist) für eigene
  Auswertungen — mit `\uFEFF`-BOM und Semikolon, damit Excel die Datei direkt
  korrekt öffnet.

---

## 6. Equity-Alarme (Monitor)

Der Monitor prüft seit 0.13.0 im selben 60-s-Tick auch die Kurve
(`checkEquityAlerts` in `src/lib/monitor.ts`) und meldet über die bestehenden
Senken (`data/alerts.ndjson`, Log, optional Webhook — `src/lib/alerts.ts`):

| Code | Severity | Auslöser |
| --- | --- | --- |
| `equity:new-high` | `info` | neuer Höchststand (Default: mindestens +0,5 % über dem letzten Alarm-Hoch) |
| `equity:drawdown-5` | `info` | Kontostand ≥ 5 % unter dem Höchststand |
| `equity:drawdown-10` | `warning` | ≥ 10 % |
| `equity:drawdown-20` | `critical` | ≥ 20 % |

| Flag | Default | Wirkung |
| --- | --- | --- |
| `EQUITY_ALERTS_ENABLED` | `true` | `false` schaltet die Equity-Alarme ab |
| `EQUITY_ALERT_DRAWDOWN_PCT` | `5,10,20` | Schwellen in Prozent (Komma/Leerzeichen-getrennt); ungültige oder ≤ 0 fallen weg, max. 20 Schwellen |
| `EQUITY_ALERT_PEAK_MIN_PCT` | `0,5` | Mindestabstand für „neues Hoch“, damit ein Tick-Rauschen nicht alarmiert |

Eigenschaften (in `tests/equityAlerts.test.ts` festgehalten):

- **Ratchet statt Flut:** Eine überschrittene Drawdown-Schwelle wird einmal
  gemeldet; erst ein Rückgang unter eine bereits gemeldete Schwelle bzw. ein
  neues Hoch setzt sie zurück. Der Alarm-Senke liegt zusätzlich der
  Debounce von `ALERT_DEBOUNCE_MINUTES` (Default 30) vor.
- **Peak folgt still nach:** Kleine Anstiege unterhalb `EQUITY_ALERT_PEAK_MIN_PCT`
  lösen keinen Alarm aus, heben aber den internen Höchststand — der nächste
  echte Alarm misst nicht gegen einen veralteten Peak.
- **Fail-soft:** Ein Fehler in der Alarm-Senke landet in der Fehlerliste des
  Ticks und stoppt den Handel nicht; ungültige Kontostände (`NaN`, ≤ 0) werden
  ignoriert. Der Zustand ist pro Prozess (`GLOBAL.__equityAlertState`), die
  Zähler stehen in `GLOBAL.__equityAlertStats`.

---

## 7. Grenzen und bewusste Nicht-Entscheidungen

- **Benchmark nur, wenn echte Historie da ist:** Es gibt keine
  Benchmark-Datenquelle in der Datenbank. Die Referenzlinie liest den
  `HistoricalStore`; ist er leer (frischer Checkout, kein
  `npm run market:sync`), bleibt `benchmark` `null` und die UI schreibt
  „keine Daten“ statt eine Kurve zu erfinden. Das ist die bewusste Umkehr der
  früheren Nicht-Entscheidung: eine Linie gibt es **nur** mit echter Reihe.
- **TWR ohne Cashflow-Bereinigung, solange die Spur fehlt:** Die Rechnung
  beherrscht Flows (`timeWeightedReturn(points, { flows })`, getestet), aber
  das Paper-Konto führt keine persistierte Cashflow-Spur. `flows.applied`
  bleibt deshalb `false` und die UI weist die Kennzahl als „ohne
  Cashflow-Spur“ aus. Keine Heuristik aus
  `drawdown_scaling_snapshots.cumulative_net_flow` — die wäre eine Schätzung,
  kein Beleg.
- **Volatilität auf Tagesbasis:** Tagesrenditen aus Berliner Kalendertagen —
  bei sehr kurzen Fenstern (n < 2 Tagen) bleibt die Kennzahl `null`, statt aus
  einem Datenpunkt eine Streuung zu behaupten.
- **Rohdatenfenster begrenzt:** `resolution=raw` liefert nur innerhalb von
  `EQUITY_RAW_RETENTION_DAYS` echte 60-s-Punkte; danach sind es Tagespunkte.
- **Randmonate der Heatmap sind angeschnitten:** Der erste/letzte Monat des
  Fensters enthält nur die Tage ab Fensterstart bzw. bis Fensterende, ist
  entsprechend markiert (`partial`) und fließt trotzdem in die Jahresrendite
  ein. Eine „vollständige“ Zahl für einen halben Monat gäbe es nicht.
- **Der Vergleich „Ø letzte 3“ ist ein Index-Mittel,** keine
  Performance-Fortschreibung: Die Vorperioden werden auf 100 indexiert und je
  Zeitpunkt gemittelt; fehlende Stützstellen werden linear interpoliert.
