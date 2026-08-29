# Migrations-Runbook — `timeframe`-Feld im Historical Store (Schema v1 → v2)

> **Status-Header:** **Implementiert** · Dokumentationsstand **2026-08-29** ·
> Code-Version **1.26.2** · Zielgruppe: Betrieb & Deployment
>
> Dieses Runbook ist die Schritt-für-Schritt-Anleitung für
> **Produktionsumgebungen mit bestehender** `data/history/candles.ndjson`.
> Die technische Schema-Beschreibung steht in [HISTORY.md](HISTORY.md), die
> Einbettung in die Datengewinnung in
> [MARKET_DATA_PIPELINE.md](MARKET_DATA_PIPELINE.md).

**Kurzfassung für Eilige:**

1. Schreiber stoppen (`ai-trading-firm`, `micro-executor`).
2. Backup anlegen (nie überspringen) + Prüfsumme notieren.
3. **Pfad A (empfohlen):** Datei entfernen und über `npm run market-sync`
   neu aufbauen — der Timeframe kommt dann aus dem Sync-Kontext und kann
   nicht falsch etikettiert werden.
4. Validieren (Kap. 8) und danach alle Backups `0600` aufbewahren.

---

## 1. Wann dieses Runbook gilt

* Die Historien-Datei stammt aus einer Version **vor 1.26.0** (Zeilen ohne
  `timeframe`-Feld).
* Ein Upgrade von `< 1.26.0` auf `>= 1.26.0` steht an.
* Ein Backup aus der Zeit vor 1.26.0 wurde zurückgespielt.

**Erkennung:** Der Loader markiert Zeilen ohne gültiges `timeframe` mit dem
Marker `LEGACY_UNKNOWN`, zählt sie, liefert sie über `query()` **niemals**
aus und schreibt beim ersten Fund eine einmalige Warnung ins Log:

> `data/history/candles.ndjson enthaelt 12.481 Zeilen im Legacy-Schema
> (ohne timeframe). Diese Bars werden ignoriert. Fuehre
> npm run history:migrate aus.`

Solange diese Warnung erscheint, ist die Historie für den Scanner
**unvollständig** — Fachlich relevante Faktoren fehlen still (kein Fehler,
nur „zu wenige Bars“).

## 2. Fehlerbild (Warum die Migration Pflicht ist)

`timeframe` ist Teil der **logischen Identität** einer Kerze. Ohne das Feld
sind `BITUNIX:BTCUSDT / 5m` und `BITUNIX:BTCUSDT / 1h` in derselben Datei
**nicht unterscheidbar**. Ein Lesezugriff ohne Timeframe-Filter mischt beide
Reihen zu einer gemeinsamen Zeitreihe — jede EMA, jedes Momentum und jede
Volatilität wäre danach mathematisch bedeutungslos, ohne dass ein Test oder
Filter Alarm schlägt.

Seit Schema **v2** gilt daher:

* Primärschlüssel `instrumentId + timeframe + ts`.
* `append(candles, instrumentId, provenance, timeframe, now)` — Timeframe ist
  Pflichtparameter, die alte 4-stellige Signatur existiert nicht mehr.
* `query({ instrumentId, timeframe, from?, to?, limit? })` — Timeframe ist
  Pflicht (Compile- **und** Runtime-Guard).

Die Migration ist damit **kein** Komfort-Schritt, sondern die Voraussetzung
dafür, dass Altbestand überhaupt wieder gelesen wird.

## 3. Entscheidung: Neuaufbau (empfohlen) oder Inline-Migration

| Kriterium | **Pfad A — Neuaufbau** (empfohlen) | Pfad B — Inline-Migration |
| --- | --- | --- |
| Datenherkunft | `MarketDataSyncService` ruft alle Bars neu ab (Public REST) | Altbestand wird umetikettiert |
| Risiko falscher Etiketten | **keines** — der Timeframe stammt aus dem Backfill-Kontext | **hoch**, wenn `--assume-timeframe` falsch gewählt wird |
| Dauer | ein Sync-Lauf (Minuten bis wenige Stunden, je Universum) | ein Skriptlauf + Validierung |
| Netzlast | 4 Requests je Instrument (`5m`, `15m`, `30m`, `1h`, je 150 Bars) | keine |
| Voraussetzung | Venue erreichbar, Rate-Limit-Budget vorhanden | Datei vorhanden |
| Empfehlung | **Ja** — Standard für den Bitunix-Feed | nur wenn kein Re-Fetch möglich (Offline, gesperrtes Rate-Limit) |

**Begründung der Empfehlung:** Der Backfill ist klein und billig — 150 Bars
je Instrument und Timeframe, vier Timeframes (`5m`, `15m`, `30m`, `1h`).
Ein kompletter Neuaufbau liefert **nachweislich korrekt etikettierte** Reihen,
weil der Timeframe aus dem Aufrufkontext stammt. Die Inline-Migration muss
dagegen für Altbestand *raten*, welche Periodizität vorliegt — und ein
falsch angenommener Timeframe ist später nicht mehr erkennbar. Sie ist ein
**Sicherheitsnetz**, kein vollwertiger Ersatz.

## 4. Schritt 0 — Voraussetzungen prüfen

```bash
# 1. Code-Version (muss >= 1.26.0 sein, dieses Runbook: 1.26.2)
node -p "require('./package.json').version"

# 2. Node-Version (>= 20)
node -v

# 3. Tatsächlich genutzter Pfad (PAPER_HISTORY_DIR überschreibt den Default)
echo "${PAPER_HISTORY_DIR:-data/history}"

# 4. Datei vorhanden? Wie groß?
ls -l "${PAPER_HISTORY_DIR:-data/history}"/candles.ndjson
```

Plattenplatz: mindestens **das Doppelte** der Dateigröße (Backup + temporäre
Zieldatei). Alle Schritte laufen im Projektstamm (dort liegt `package.json`).

## 5. Schritt 1 — Alle Schreiber stoppen

Folgende Prozesse schreiben in den Store:

| Prozess | Was wird geschrieben | Stoppen |
| --- | --- | --- |
| Next.js-App / `ai-trading-firm.service` | Snapshot-Ticks als `1m` (`src/lib/marketdata/manager.ts`) | `sudo systemctl stop ai-trading-firm` |
| `npm run market-sync` | Backfill `5m/15m/30m/1h` | laufende Cron-/Sync-Jobs beenden |
| `npm run scan -- --sync-first` | Sync vor dem Scan | Job beenden |
| `micro-executor.service` | **schreibt nicht** (eigene In-RAM-Serien) | muss nicht gestoppt werden |

```bash
sudo systemctl stop ai-trading-firm
# ggf. Cron/Sync-Jobs pausieren
```

Erst weitermachen, wenn **kein** Prozess mehr in die Datei schreibt — sonst
überschreibt ein später Append das Migrationsergebnis teilweise.

## 6. Schritt 2 — Pflicht-Backup (nie überspringen)

```bash
HIST="${PAPER_HISTORY_DIR:-data/history}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

cp -a "$HIST/candles.ndjson" "$HIST/candles.ndjson.manual-$STAMP"
chmod 600 "$HIST/candles.ndjson.manual-$STAMP"

# Prüfsumme des Originals notieren (für den Abgleich nach der Migration)
sha256sum "$HIST/candles.ndjson" | tee "/tmp/candles-before-$STAMP.txt"
```

Das Backup enthält Kursdaten und Provenienz (Venue, Feed, Zeitpunkte) —
`chmod 600` halten und **nicht** ins Repository legen (`/data/history` ist
gitignored). Backups erst löschen, wenn die Validierung (Kap. 8) grün ist.

## 7. Pfad A — Neuaufbau (empfohlen)

```bash
HIST="${PAPER_HISTORY_DIR:-data/history}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# 1. Alte Datei aus dem Weg (Backup aus Kap. 6 liegt bereits vor)
mv "$HIST/candles.ndjson" "$HIST/candles.ndjson.pre-v2-$STAMP"

# 2. Historie neu aufbauen (Public REST, keine Credentials)
npm run market-sync -- --venue=BITUNIX

# 3. Validierung: siehe Kap. 8
```

`market-sync` schreibt je Instrument **vier** Reihen (`5m`, `15m`, `30m`,
`1h`) mit je bis zu 150 Bars — jede Zeile mit korrektem `timeframe` und
`"v": 2`. Fehlerhafte Instrumente landen im Manifest
`data/market-data-errors.json` und werden als Readiness `ERROR` gemeldet
(kein stilles `min-candles` mehr, siehe [OBSERVABILITY.md](OBSERVABILITY.md)).

**Erwartung:** Nach dem Lauf ist die Zahl der Bars ein Vielfaches der
Timeframes — pro Instrument bis zu 4 × 150. Weicht eine Reihe stark ab, ist
das ein Rate-Limit-/Fehlersignal (Manifest prüfen), **kein** Grund, auf
Pfad B zu wechseln.

## 8. Pfad B — Inline-Migration (Sicherheitsnetz)

### 8.1 Dry-Run ist der Default (seit 1.26.2)

Ein Aufruf **ohne** `--apply` verändert **nichts**: kein Schreiben, kein
Backup, nur der Report. Das ist die Voreinstellung — geschrieben wird erst
mit dem expliziten Flag `--apply`.

```bash
HIST="${PAPER_HISTORY_DIR:-data/history}"

# Trockenlauf — Pflicht vor jedem echten Lauf
npm run history:migrate -- --file="$HIST/candles.ndjson" \
  --assume-timeframe=15m
```

Der Report nennt `gelesen`, `migriert`, `bereits v2`, `dedupliziert`,
`verworfen` (mit Gründen) und `geschrieben`. Ohne `--apply` endet der Lauf
mit Exit-Code **2** und dem Hinweis, dass `--apply` fehlt.

### 8.2 Anwenden

```bash
npm run history:migrate -- --file="$HIST/candles.ndjson" \
  --assume-timeframe=15m --apply
```

Ablauf: Backup `candles.ndjson.bak-<ISO>` (`0600`) **vor** dem Schreiben →
Zeilen parsen → `timeframe` zuweisen → deduplizieren → sortieren → atomar
schreiben (`tmp` + `rename`). Schlägt das Backup fehl, bricht die Migration
ab und das Original bleibt unverändert.

### 8.3 `--assume-timeframe` bestimmen — nie raten

Das Skript weist Altbestand **nie** automatisch einen Timeframe zu: 5m- und
1h-Bars sind im Altschema ununterscheidbar, ein erratener Wert würde die
Reihe dauerhaft falsch beschriften. Vor dem Anwenden daher prüfen, mit
welcher Periodizität der Altbestand entstanden ist:

```bash
HIST="${PAPER_HISTORY_DIR:-data/history}"
node -e '
const fs = require("node:fs");
const file = process.argv[1];
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && r.instrumentId && Number.isFinite(r.ts));
const byInstrument = new Map();
for (const r of rows) {
  const list = byInstrument.get(r.instrumentId) ?? [];
  list.push(r.ts);
  byInstrument.set(r.instrumentId, list);
}
for (const [id, tsList] of byInstrument) {
  tsList.sort((a, b) => a - b);
  const deltas = tsList.slice(1).map((t, i) => t - tsList[i]).filter((d) => d > 0).sort((a, b) => a - b);
  const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : null;
  console.log(id, "bars=" + tsList.length, "medianDeltaMs=" + median,
    "≈" + (median ? Math.round(median / 60000) + "m" : "unbekannt"));
}
' "$HIST/candles.ndjson"
```

Ergibt der Median z. B. `≈15m`, ist `--assume-timeframe=15m` belegt. Sind
pro Instrument **mehrere** Periodizitäten vermischt (unterschiedliche
Median-Abstände innerhalb einer Reihe), kann keine Zuweisung korrekt sein —
dann ist **Pfad A** zwingend.

### 8.4 Exit-Codes

| Code | Bedeutung |
| --- | --- |
| `0` | Migration angewendet (oder Datei nicht vorhanden) bzw. Report ohne verworfene Zeilen |
| `1` | Abbruch (ungültige Option, Backup fehlgeschlagen, Invariante verletzt) oder Zeilen verworfen |
| `2` | **Nichts angewendet** — `--assume-timeframe` fehlt/ungültig oder `--apply` fehlt |

## 9. Schritt 4 — Validierung (beide Pfade)

```bash
HIST="${PAPER_HISTORY_DIR:-data/history}"
node -e '
const fs = require("node:fs");
const { SUPPORTED_TIMEFRAMES } = { SUPPORTED_TIMEFRAMES: ["1m","3m","5m","15m","30m","1h","2h","4h","1d","5d"] };
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
let legacy = 0, bad = 0, noVersion = 0;
const keys = new Set(); let dupes = 0;
const perSeries = new Map();
for (const l of lines) {
  let r; try { r = JSON.parse(l); } catch { bad++; continue; }
  if (!r) { bad++; continue; }
  if (r.v !== 2) noVersion++;
  if (!SUPPORTED_TIMEFRAMES.includes(r.timeframe)) { legacy++; continue; }
  const k = r.instrumentId + "|" + r.timeframe + "|" + r.ts;
  if (keys.has(k)) dupes++;
  keys.add(k);
  const s = r.instrumentId + "|" + r.timeframe;
  perSeries.set(s, (perSeries.get(s) ?? 0) + 1);
}
console.log(JSON.stringify({
  zeilen: lines.length,
  ungueltigesJson: bad,
  ohneSchemaVersion: noVersion,
  legacyOhneTimeframe: legacy,
  doppelteCompositeKeys: dupes,
  reihen: [...perSeries.entries()].sort().slice(0, 20),
}, null, 2));
' "$HIST/candles.ndjson"
```

**Erwartete Werte:**

| Prüfung | Soll |
| --- | --- |
| `legacyOhneTimeframe` | `0` |
| `doppelteCompositeKeys` | `0` |
| `ungueltigesJson` | `0` |
| `ohneSchemaVersion` | `0` |
| `reihen` | je Instrument nur Timeframes aus der Allowlist; bei Pfad A `5m/15m/30m/1h` |

Zusätzlich:

1. **Keine Legacy-Warnung mehr:** Anwendung starten, Log prüfen — die
   Meldung „Legacy-Schema (ohne timeframe)“ darf nicht mehr erscheinen.
2. **Timeframe-Isolation:** `HistoricalStore.query()` liefert für `5m` und
   `1h` **getrennte** Reihen (abgedeckt durch
   `tests/history/historicalStore.test.ts`).
3. **Bar-Zähler:** `npm run market-sync` meldet je Instrument und Timeframe
   die geschriebenen Bars (`written`) — die Summe muss zur Validierung
   oben passen.
4. **Scanner:** `npm run scan` darf Altbestand nicht mehr als
   „Warmup unvollständig“ (Readiness `WARMING`) ausweisen.

## 10. Schritt 5 — Nachlauf

* Applicationen wieder starten: `sudo systemctl start ai-trading-firm`.
* Sync-Fehler beobachten (`data/market-data-errors.json`, Metrik
  `market_data_fetch_failures_total`).
* Backups erst nach grüner Validierung löschen; bis dahin `0600` belassen.
* Wiederholte Läufe sind **idempotent** — ein zweiter `history:migrate`-Lauf
  ändert nichts (alle Zeilen tragen bereits ein gültiges `timeframe`).

## 11. Rollback

```bash
HIST="${PAPER_HISTORY_DIR:-data/history}"

# 1. Schreiber stoppen (Kap. 5)
# 2. Backup zurückspielen — entweder das manuelle (Kap. 6) …
cp -a "$HIST/candles.ndjson.manual-$STAMP" "$HIST/candles.ndjson"
# … oder das automatische der Migration
cp -a "$HIST/candles.ndjson.bak-$ISO" "$HIST/candles.ndjson"

# 3. Rechte prüfen
chmod 600 "$HIST/candles.ndjson"

# 4. Prüfsumme gegen /tmp/candles-before-$STAMP.txt abgleichen
sha256sum "$HIST/candles.ndjson"
```

**Wichtig:** Wird zusätzlich die Software auf `< 1.26.0` zurückgerollt, muss
**auch** die Datei zurückgespielt werden. Eine v2-Datei unter altem Code
würde die Timeframe-Dimension wieder ignorieren und den Mix-Bug
zurückholen.

## 12. Sicherheitsregeln (Audit)

* **Dry-Run ist der Default.** Geschrieben wird erst mit explizitem
  `--apply` (seit 1.26.2); ohne das Flag bleibt die Datei bitgleich.
* **Backup vor jedem Schreiben** mit restriktiven Rechten (`0600`);
  schlägt das Backup fehl, wird abgebrochen (Original unverändert).
* **Kein Raten:** `--assume-timeframe` ist Pflicht, sobald Legacy-Zeilen
  existieren; ohne Flag Abbruch mit Erklärung.
* **Idempotenz** und **Verlust-Invariante**
  `gelesen == geschrieben + dedupliziert + verworfen`.
* **Kein Path-Traversal:** `instrumentId`/`timeframe`/`feed` werden nie in
  Dateipfade interpoliert; der Store schreibt ausschließlich in den
  konfigurierten Pfad.
* **Keine Zeilen-Injection:** Zeilen entstehen per `JSON.stringify`.
* **Prototype-Pollution-Schutz:** geparste Zeilen werden feldweise auf ein
  prototypfreies Objekt gemappt (kein Spread); `__proto__`/`constructor`/
  `prototype` werden verworfen.
* **Keine Credentials:** der Migrationspfad ist reine Dateiverarbeitung, der
  Neuaufbau nutzt ausschließlich die Public-REST-Schnittstelle.

## 13. Referenzen

* [HISTORY.md](HISTORY.md) — Schema v2, Primärschlüssel, Dedup-Regel,
  Legacy-Verhalten, Rollback.
* [MARKET_DATA_PIPELINE.md](MARKET_DATA_PIPELINE.md) — Backfill je
  Timeframe, Persistenz, Migrationsabschnitt.
* [PAPER_TRADING.md](PAPER_TRADING.md) — `PAPER_HISTORY_DIR` und die
  Markt-Datenmodi.
* Code: `src/lib/marketdata/historicalStore.ts`,
  `src/history/migration.ts`, `scripts/migrate-history-timeframe.ts`.
* Tests: `tests/history/historicalStore.test.ts`,
  `tests/history/migration.test.ts`.
