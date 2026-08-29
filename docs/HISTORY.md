# Historical Store — Schema, Schlüssel, Dedup & Migration

> **Status-Header:** **Implementiert** · Dokumentationsstand **2026-08-29** ·
> Code-Version **1.26.2** · Modul `src/lib/marketdata/historicalStore.ts` ·
> Migration `scripts/migrate-history-timeframe.ts` / `npm run history:migrate`
>
> **Für Betrieb/Deployment** (Backup, Dry-Run, Anwenden, Validierung,
> Rollback): [MIGRATION_TIMEFRAME_FIELD.md](MIGRATION_TIMEFRAME_FIELD.md).

Der Historical Store ist die append-only OHLCV-Senke des Systems
(`data/history/candles.ndjson`). Scanner, Replay/Backtest und
Analytics-Korrelation lesen **ausschließlich** aus dieser lokalen Datei —
nie aus dem Netzwerk. Diese Seite beschreibt das persistente Zeilenformat
(v2), den logischen Schlüssel, die Deduplizierungsregel und die Migration
von Altbestand (v1).

---

## 1. Warum `timeframe` zwingend ist

`timeframe` ist Teil der **logischen Identität** einer Kerze. Ohne dieses
Feld wären z. B. `BITUNIX:BTCUSDT / 5m` und `/1h` im selben Store nicht mehr
unterscheidbar. Ein Loader würde 5m- und 1h-Bars zu **einer** gemeinsamen
Faktorreihe vermischen — jede EMA, jedes Momentum, jede Volatilität wäre
danach mathematisch bedeutungslos, ohne dass ein Test oder Filter Alarm
schlägt. Deshalb gilt seit **v2**:

* `HistoricalCandleEntry.timeframe: SupportedTimeframe` ist Pflicht.
* `append(candles, instrumentId, provenance, timeframe, now)` verlangt den
  Timeframe als expliziten Parameter. Die alte 4-stellige Signatur wurde
  **entfernt** (nicht überladen): TypeScript zwingt jeden Aufrufer zur
  Migration, ein optionaler Parameter würde den Bug still reproduzieren.
* `query({ instrumentId, timeframe, from?, to?, limit? })` verlangt den
  Timeframe zwingend (Compile- **und** Runtime-Guard für JS-Aufrufer).

## 2. Zeilenformat (Schema v2)

NDJSON, eine Kerze pro Zeile, kodiert per `JSON.stringify` (kein
String-Concat → keine Zeilen-Injection über Feldwerte mit `\n`). Jede Zeile
trägt die Schema-Version `"v": 2`:

```json
{"v":2,"instrumentId":"BITUNIX:BTCUSDT","venue":"BITUNIX","feed":"BITUNIX:rest",
 "timeframe":"1h","ts":1700000000000,"open":100,"high":101,"low":99,
 "close":100.5,"volume":1234,"fetchedAt":"2026-08-29T00:00:00.000Z"}
```

| Feld | Typ | Bedeutung |
| --- | --- | --- |
| `v` | `2` | Schema-Version der Zeile. |
| `instrumentId` | `string` | Kanonische Instrument-ID `"<VENUE>:<SYMBOL>"`. |
| `venue` | `string` | Venue der Provenienz (z. B. `BITUNIX`). |
| `feed` | `string` | Feed-ID (z. B. `BITUNIX:rest`). |
| `timeframe` | `SupportedTimeframe` | Periodizität (Allowlist, s. u.). |
| `ts` | `number` | Kerzenzeitpunkt, Unix-Epoch (ms), positive Ganzzahl. |
| `open/high/low/close` | `number` | Endliche Preise > 0. |
| `volume` | `number` | Endliches Volumen ≥ 0. |
| `fetchedAt` | `string` | Wann geschrieben (ISO-UTC); entscheidet bei Dedup. |

**Timeframe-Allowlist** (`SUPPORTED_TIMEFRAMES`): `1m, 3m, 5m, 15m, 30m,
1h, 2h, 4h, 1d, 5d`. Andere Werte werden beim Schreiben und Laden abgewiesen.

## 3. Logischer Schlüssel & Deduplizierung

* **Primärschlüssel:** `instrumentId + timeframe + ts`.
* **Bei Kollision** gewinnt der Eintrag mit dem **jüngsten `fetchedAt`**;
  bei Gleichstand der **zuletzt gelesene** (deterministisch).
* `append()` fasst den neuen Batch gegen den Bestand zusammen und liefert
  `AppendResult { written, deduplicated }`. Wiederholter Backfill erzeugt
  also keine doppelten Bars mehr.
* **Ergebnisreihenfolge:** `ts` aufsteigend (stabil nach `fetchedAt`).
  `limit` selektiert die **letzten N** Bars (jüngste) und gibt sie wieder
  aufsteigend zurück. `from`/`to` sind **inklusiv**.
* **Größenkontrolle:** optionales `maxBarsPerSeries` (Default **5000**);
  die Kompaktierung behält je Reihe (`instrumentId+timeframe`) die jüngsten
  Bars.

## 4. Lese-API

```ts
// Pflicht: instrumentId UND timeframe. Wirft sonst HistoricalStoreError.
const bars = store.query({ instrumentId: "BITUNIX:BTCUSDT", timeframe: "1h" });
const recent = store.query({ instrumentId, timeframe: "1h", limit: 200 });
const window = store.query({ instrumentId, timeframe: "1h", from, to });

// Querlesezugriff nur für Scanner-Provider & Wartung (Timeframe-Auswahl).
const all = store.readAll();
```

Die Runtime-Fehlermeldung bei fehlendem Timeframe lautet:

> `query({instrumentId}) ohne timeframe ist nicht zulaessig. Ein
> Timeframe-freier Zugriff wuerde Kerzen unterschiedlicher Periodizitaet
> mischen. Nutze z.B. query({ instrumentId, timeframe: "15m" }). Siehe
> docs/MIGRATION_TIMEFRAME_FIELD.md.`

## 5. Legacy-Verhalten zur Laufzeit (v1 ohne `timeframe`)

Zeilen ohne gültiges `timeframe` werden als **`LEGACY_UNKNOWN`** markiert,
gezählt und bei `query()` **niemals** ausgeliefert. Beim ersten Fund gibt es
eine **einmalige Warnung** pro Datei, z. B.:

> `data/history/candles.ndjson enthaelt 12.481 Zeilen im Legacy-Schema
> (ohne timeframe). Diese Bars werden ignoriert. Fuehre
> \`npm run history:migrate\` aus.`

Der Scanner-Provider (`historicalStoreProvider`) liest über `readAll()`
alle Timeframes und wählt je Instrument deterministisch eine Reihe
(Präferenz `1h → 4h → 30m → 15m → 5m`; Legacy nur als letzter Fallback).

## 6. Migration v1 → v2

**Empfohlener Pfad in Produktion ist der Neuaufbau**, nicht die
Inline-Migration: `candles.ndjson` entfernen (Backup vorher!) und
`npm run market-sync` die Historie mit korrektem Timeframe neu aufbauen
lassen (150 Bars je Instrument und Timeframe, Timeframes `5m`, `15m`,
`30m`, `1h`). Der Bitunix-Feed ist public REST und in Minuten nachgezogen —
damit ist die Etikettierung nachweislich korrekt statt angenommen. Der Pfad
der Datei folgt `PAPER_HISTORY_DIR` (Default `data/history`). Details und
Validierung: [MIGRATION_TIMEFRAME_FIELD.md](MIGRATION_TIMEFRAME_FIELD.md).

Die Inline-Migration bleibt als Sicherheitsnetz für Fälle, in denen kein
Re-Fetch möglich ist (Offline-Betrieb, ausgeschöpftes Rate-Limit):

```bash
# 1. Dry-Run — das ist der Default, schreibt nichts, Exit-Code 2
npm run history:migrate -- --file=data/history/candles.ndjson \
  --assume-timeframe=15m

# 2. Anwenden — erst mit --apply wird geschrieben (Backup automatisch)
npm run history:migrate -- --file=data/history/candles.ndjson \
  --assume-timeframe=15m --apply
```

**Dry-Run ist der Default (seit 1.26.2):** Ohne `--apply` wird keine Datei
verändert und kein Backup angelegt; der Lauf endet mit Exit-Code **2** und
einem Hinweis. Exit-Codes: `0` angewendet · `1` Abbruch oder verworfene
Zeilen · `2` nichts angewendet (`--apply` oder `--assume-timeframe` fehlt).

Ablauf (`src/history/migration.ts`):

1. **Backup** `candles.ndjson.bak-<ISO>` mit restriktiven Rechten (`0600`)
   anlegen (nur bei `--apply` — im Dry-Run entsteht kein Backup). Schlägt
   das Backup fehl, **bricht die Migration ab**, das Original bleibt
   unverändert.
2. Jede Zeile wird geparst (feldweise, kein Spread —
   Prototype-Pollution-sicher). Fehlt `timeframe`, wird
   `--assume-timeframe` zugewiesen. **Ohne dieses Flag bricht die Migration
   mit Erklärung ab** — es wird nie geraten (5m vs. 1h ist im alten
   Schema ununterscheidbar).
3. **Dedup** nach `instrumentId + timeframe + ts` (jüngstes `fetchedAt`
   gewinnt; Gleichstand → zuletzt gelesen).
4. **Sortierung** nach `instrumentId, timeframe, ts`.
5. **Report:** gelesen / migriert / bereits v2 / dedupliziert / verworfen
   (mit Gründen) / geschrieben.
6. Ohne `--apply` (Default seit 1.26.2) schreibt die Migration **nichts**
   und legt **kein Backup** an — nur der Report wird ausgegeben, der Lauf
   endet mit Exit-Code **2**. `--dry-run` bleibt als explizites Flag
   erlaubt.

Die Migration ist **idempotent**: ein zweiter Lauf ändert nichts
(alle Zeilen haben bereits ein gültiges `timeframe`, keine Duplikate).

**Verlust-Invariante:** `gelesen == geschrieben + dedupliziert +
verworfen` — kein Bar geht still verloren; verletzt die Migration diese
Bedingung, bricht sie mit Fehler ab.

### Rollback (Backup zurückspielen)

Jeder (Nicht-Dry-Run-)Lauf sichert den Originalstand unter
`candles.ndjson.bak-<ISO>` (chmod `0600`). Im Problemfall:

```bash
# 1. Prozess anhalten, der auf den Store schreibt (market-sync, scan).
# 2. Backup zurückspielen:
cp data/history/candles.ndjson.bak-<ISO> data/history/candles.ndjson
# 3. Dateirechte prüfen (sollte 0600 sein):
chmod 600 data/history/candles.ndjson
# 4. Migration nach Korrektur ggf. erneut mit --dry-run prüfen.
```

## 7. Sicherheit / Robustheit

* **Kein Path Traversal:** `instrumentId`, `timeframe`, `feed` werden nie in
  Dateipfade interpoliert; der Store schreibt ausschließlich in den
  konfigurierten Pfad (`<dir>/candles.ndjson`).
* **Keine Zeilen-Injection:** Zeilen entstehen per `JSON.stringify`.
* **Eingabevalidierung:** `Number.isFinite` für OHLCV, `ts` als positive
  Ganzzahl, `timeframe` gegen die Allowlist.
* **Prototype-Pollution:** `JSON.parse`-Ergebnisse werden feldweise auf ein
  prototypfreies Objekt gemappt (kein Spread); `__proto__`/`constructor`/
  `prototype` werden verworfen.
* **Restriktive Rechte:** Store- und Backup-Dateien `0600`.
* **Streaming-Loader:** pufferbasiert (feste Lese-Chunks), damit eine große
  Historie den Prozess nicht OOM-killt; kaputte Teilzeilen werden geloggt
  und übersprungen (kein Prozessabbruch).
* **Atomare Schreibvorgänge:** `tmp` + `rename` (keine halben Dateien).
