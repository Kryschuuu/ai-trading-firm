# How-to: BITUNIX freischalten (`BITUNIX_ENABLED=true`) und das Kerzen-Warmup bei laufender Firma nachziehen

> **Kurzfassung für Eilige:** In einem **zweiten Terminal** bei laufender Firma ausführen —
>
> ```bash
> BITUNIX_ENABLED=true npm run market:sync -- --venue=BITUNIX
> npm run market:sync:status
> ```
>
> Danach das Control Panel im Browser **neu laden**. Fertig. Kein API-Key nötig, Live-Trading bleibt gesperrt.

---

## 1. Was die Meldungen bedeuten

### 1.1 `BITUNIX wurde nicht freigeschaltet (Grund: VENUE_DISABLED)`

Der Market-Data-Sync registriert den BITUNIX-Adapter nur, wenn **alle vier Gates** passieren
(`src/marketdata/registerAdapters.ts`):

1. `MARKET_SYNC_ENABLED` ist nicht `"false"` (globaler Kill-Switch — Standard: **an**),
2. `MARKET_SYNC_VENUES` enthält die Venue (leer = alle bekannten — Standard: **leer**),
3. die Capability-Matrix meldet `capabilities.BITUNIX.marketData === true` (ist erfüllt),
4. **`BITUNIX_ENABLED === "true"`** — und zwar der **exakte String** `"true"`.

Der entscheidende Code (`src/brokers/bitunix/config.ts`):

```ts
export function envFlagTrue(env: EnvLike, name: string): boolean {
  return env[name] === "true";   // nur "true" — nicht "1", "TRUE", "yes" oder "false"
}
```

`--venue=BITUNIX` **allein schaltet nichts an** — das CLI-Flag wählt nur die Venue aus,
das Pro-Venue-Env-Flag bleibt Pflicht (siehe `docs/MARKET_DATA_PIPELINE.md`).

### 1.2 `Warmup unvollständig: 365 Instrument(e) < 61 Kerzen`

Das ist **kein Marktausschluss**, sondern ein Datenzustand: In `data/history/candles.ndjson`
liegen (noch) keine bzw. zu wenige Kerzen vor. Der Scanner braucht je Instrument **61 Kerzen**,
weil der konfigurierte Faktorsatz eine **EMA50** (50 Kerzen) und einen **Momentum-Lookback
von 60 Perioden** (→ 61 Kerzen) enthält (`src/scanner/warmup.ts`, `requiredWarmupCandles`).
Ohne diese Historie bleiben die Funnel-Stellen datenbedingt auf null.

Der Sync lädt pro Timeframe standardmäßig **150 Kerzen** (`SYNC_CANDLE_LIMIT`), also mehr
als die benötigten 61 — ein einfacher Lauf ohne Optionen reicht.

---

## 2. Wo muss `BITUNIX_ENABLED=true` eingetragen werden? — Der wichtige Unterschied

Es gibt **zwei verschiedene Laufzeitumgebungen**, und sie laden Environment-Variablen
unterschiedlich:

| Umgebung | Liest `.env` automatisch? | So wird das Flag gesetzt |
| --- | --- | --- |
| **CLI-Skripte** (`npm run market:sync`, `npm run market-sync`, `npm run scan`) | **NEIN** — die Skripte importieren kein `dotenv` (empirisch verifiziert: ein Eintrag in `.env` allein führt weiterhin zu `VENUE_DISABLED`) | Inline-Präfix oder `export` **in der Shell** (siehe §3) |
| **Next.js-Web-App** (Control Panel, API-Routen) | **JA** — Next.js lädt `.env` beim Serverstart | In `.env` eintragen **und Server neu starten** (siehe §4) |
| **Micro-Executor** (`npm run micro`) | **JA** — importiert `dotenv/config` | In `.env` eintragen und Prozess neu starten |

> ⚠️ **Häufigster Irrtum:** `BITUNIX_ENABLED=true` in die `.env` schreiben und dann
> `npm run market:sync` aufrufen. Das funktioniert **nicht**, weil das CLI die `.env`
> nicht lädt. Für das CLI muss die Variable in der Shell-Umgebung gesetzt sein.
> (`--env-file` wird von Node in `NODE_OPTIONS` blockiert und ist keine Option.)

---

## 3. Sofort-Lösung: Sync bei laufender Firma ausführen (empfohlen)

Die Firma **muss nicht gestoppt werden**. Der Sync ist ein separater Prozess, der nur
öffentliche REST-Endpunkte abfragt und lokal Dateien schreibt.

### Linux / macOS (zweites Terminal im Projektverzeichnis)

**Variante A — Inline-Präfix** (auch genau so im `README.md` dokumentiert):

```bash
cd /pfad/zur/ai-trading-firm
BITUNIX_ENABLED=true npm run market:sync -- --venue=BITUNIX
```

**Variante B — Export in der Shell-Sitzung** (danach für alle weiteren Befehle gesetzt):

```bash
cd /pfad/zur/ai-trading-firm
export BITUNIX_ENABLED=true
npm run market:sync -- --venue=BITUNIX
npm run market:sync:status          # Readiness prüfen (nur lesen)
npm run scan                        # Scan auf dem frischen Warmup
```

### Windows PowerShell

```powershell
cd C:\pfad\zur\ai-trading-firm
$env:BITUNIX_ENABLED="true"
npm run market:sync -- --venue=BITUNIX
```

### Windows CMD

```cmd
cd C:\pfad\zur\ai-trading-firm
set BITUNIX_ENABLED=true
npm run market:sync -- --venue=BITUNIX
```

### Erwartete Ausgabe eines erfolgreichen Laufs

Seit v1.37.0 lädt der Standardlauf nur `1h` (der einzige von Scanner/Analytics
ausgewertete Zeitrahmen); kürzere Zeitrahmen gezielt mit
`--timeframes=5m,15m,30m,1h`. Seit v1.39.2 werden Ticker in 50er-Chunks
angefragt (`BITUNIX_TICKER_SYMBOLS_PER_REQUEST=50`, ~1 KB, Gateway-Limit >6 KB
– Fix gegen 754× `SCHEMA_MISMATCH`):

```
[market-sync] BITUNIX discovery: <N> instruments
[market-sync] tickers enriched: <N>
[market-sync] orderbooks enriched: <N>
[market-sync] 1h candles: <N>/<N> (<bars>/<soll> bars)
[market-sync] duration: ...
```

Exit-Codes: `0` = sauber · `1` = degradiert (Details im Manifest
`data/market-data-errors.json` — einfach **erneut ausführen**, es gibt z. B. Rate-Limits
von 8 req/s/IP) · `2` = Bedienfehler/Gate (z. B. weiterhin `VENUE_DISABLED`).

**Seit v1.39.1** nennt der Lauf bei Fehlern die Ursache direkt im Log
(Ursachen-Buckets je Stage/Taxonomie + Wiederholbarkeits-Bilanz), und ALLE
Ausgaben sind ASCII-sicher — auf Windows-Konsolen mit Legacy-Codepage erscheinen
keine „komischen Zeichen“ (Mojibake) mehr:

```
[market-sync] failures: 1
[market-sync] failures nach Ursache: discovery/NETWORK: 1
[market-sync] failures: 1 wiederholbar, 0 endgültig — Instrument-Zuordnung im Manifest (data/market-data-errors.json), Rohdaten per --json
[market-sync] DEGRADED: 1 isolierte(r) Fehler - Ursachen im Manifest (data/market-data-errors.json), Behebung: erneut ausfuehren.
```

---

## 4. Persistente Lösung für die Web-App / den Micro-Executor

Soll die **laufende Next.js-Firma** das Flag ebenfalls kennen (z. B. Paper-Trading-Pfad
über den BITUNIX-Adapter), gehört es in die `.env`:

```bash
cd /pfad/zur/ai-trading-firm
cp -n .env.example .env        # nur, falls noch keine .env existiert (-n: nicht überschreiben!)
# Datei bearbeiten und diese Zeile setzen (bzw. auskommentieren):
#   BITUNIX_ENABLED=true
chmod 600 .env                 # .env enthält Zugangsdaten → nur lesbar für den Owner
```

Anschließend die Web-App **neu starten**, damit Next.js die neue Umgebung lädt
(Umgebungsvariablen werden nur beim Start eingelesen):

```bash
npm run stop        # falls das Stopp-Skript genutzt wird, bzw. dev/start-Prozess beenden
npm run dev         # Entwicklung  (http://localhost:3369)
# bzw.
npm run build && npm run start   # Produktiv
```

Hinweis: Die `.env` ist in `.gitignore` eingetragen (`.env`, `.env.local`, `.env.*.local`)
und wird niemals committet.

---

## 5. Geht das während die Firma läuft? — Ja, ohne Unterbrechung

- **Kein Stopp nötig:** `market:sync` läuft als eigener Prozess. Die Web-App, die Datenbank
  und offene Paper-Positionen laufen unberührt weiter.
- **Keine API-Credentials nötig:** Der Sync instanziiert ausschließlich den
  credential-freien **PublicClient** (Endpunkte `trading_pairs`, `tickers`, `depth`, `kline`) —
  kein PrivateClient, keine Signatur, keine Keys. `BITUNIX_API_KEY`/`BITUNIX_API_SECRET`
  müssen **nicht** gesetzt werden.
- **Live-Trading bleibt gesperrt:** `BITUNIX_ENABLED=true` schaltet nur Adapter /
  Market Data / Paper frei. Echte Orders bleiben durch das Live-Gate blockiert
  (zusätzlich nötig wären `BITUNIX_LIVE_ENABLED=true` + `LIVE_TRADING_ENABLED=true` +
  `REQUIRE_HUMAN_APPROVAL=false` + eine freigeschaltete Live-Gate-State-Machine —
  siehe `docs/LIVE_TRADING.md`). Diese Flags **nicht anfassen**.
- **Das Control Panel lädt die neue Lage selbst:** Die Readiness-Anzeige
  („X Instrumente < 61 Kerzen“) liest zur Anfragezeit aus den synchronisierten
  Datenbeständen (`data/universe`, `data/history/candles.ndjson`, Sync-Status).
  Nach dem Sync einfach die Seite im Browser **neu laden** — die Warnung verschwindet,
  sobald genügend Kerzen vorliegen; ein Web-Server-Neustart ist dafür **nicht** nötig.

Ablauf in der Praxis:

```bash
# Terminal 1: Firma läuft (npm run dev / npm run start) — einfach weiterlaufen lassen

# Terminal 2: Warmup nachziehen
BITUNIX_ENABLED=true npm run market:sync -- --venue=BITUNIX
npm run market:sync:status                 # Exit 0 = Warmup vollständig

# Browser: Control Panel neu laden → Warnung weg, danach Scan auslösen
# (oder aus Terminal 2: npm run scan)
```

---

## 6. Prüfen, ob es funktioniert hat

1. **Status (read-only, kein Netzwerk-Gate):**
   ```bash
   npm run market:sync:status
   ```
   Exit `0` = Warmup vollständig; Exit `1` = es fehlen noch Kerzen.
2. **Control Panel:** Nach dem Seiten-Refresh sollte „Warmup unvollständig: 365 …“
   verschwunden sein und die „Market Data“-Sektion volle Zähler zeigen.
3. **Scanner:** Den nächsten Scan laufen lassen (`npm run scan` bzw. Scan im UI) —
   die Funnel-Nullen füllen sich, sobald die Faktoren auf ≥ 61 Kerzen rechnen können.
4. **Bei degradiertem Lauf** (Exit 1): Ursachen stehen in `data/market-data-errors.json`
   (keine Secrets, nur Zähler/Gründe). Meist reicht ein erneuter Lauf.

Nützliche Optionen für den Zweifelsfall:

```bash
# Nur ein paar Symbole, mehr Kerzen, explizite Timeframes:
BITUNIX_ENABLED=true npm run market:sync -- --venue=BITUNIX \
  --symbols=BTCUSDT,ETHUSDT --candle-limit=200 --timeframes=5m,15m,30m,1h

# Trockenlauf (kein Schreiben), um die Venue-Freischaltung zu testen:
BITUNIX_ENABLED=true npm run market:sync -- --venue=BITUNIX --dry-run
```

---

## 7. Troubleshooting

| Symptom | Ursache / Behebung |
| --- | --- |
| Trotz Eintrag in `.env` weiter `VENUE_DISABLED` | Das CLI lädt `.env` nicht. Variable in der Shell setzen: `BITUNIX_ENABLED=true npm run market:sync …` (bzw. `export` / PowerShell `$env:`). Prüfen mit `echo "$BITUNIX_ENABLED"` (muss exakt `true` ergeben). |
| `--env-file= is not allowed in NODE_OPTIONS` | Node verbietet `--env-file` in `NODE_OPTIONS` bewusst. Bitte Inline/`export` verwenden. |
| Flag gesetzt, aber Wert ist `TRUE`/`1`/`yes` | Es zählt nur der exakte String `"true"` (klein geschrieben). |
| `tickers enriched: 0`, `failures: 754`, `ticker/SCHEMA_MISMATCH: 754` | **Vor v1.39.2:** `enrichWithTickers()` schickte ~750 Symbole als **einen** `GET /tickers?symbols=…` (>6 KB URL) → Gateway lehnt ab → jeder als `SCHEMA_MISMATCH` endgültig markiert. **Seit v1.39.2 behoben:** Chunking in 50er-Blöcken (`BITUNIX_TICKER_SYMBOLS_PER_REQUEST=50`, ~1 KB Query), Teilausfall toleriert. Falls nach Update noch auftritt: Version prüfen (`npm run market:sync -- --help` zeigt keine, aber `package.json` = 1.39.2), `BITUNIX_TICKER_SYMBOLS_PER_REQUEST` nicht über 100 setzen, Gateway-Logs prüfen. |
| `discovery: 0 instruments`, `failures: 1` | Netzwerk/API nicht erreichbar (Proxy/Firewall, Geo-Block) oder Ratenlimit. Seit v1.39.1 zeigt die Logzeile `failures nach Ursache:` die klassifizierte Ursache (`discovery/NETWORK` = API nicht erreichbar, `discovery/RATE_LIMITED` = Limit, `discovery/TLS` = Zertifikat/Proxy). Batch-Fehler stehen seit v1.39.1 auch im `batch`-Abschnitt von `data/market-data-errors.json`; erneut ausführen. |
| „Komische Zeichen“ (z. B. `â€"`, `Ã¼`) in der Konsole | bis v1.39.0: UTF-8-Ausgabe auf Windows-Konsolen mit Legacy-Codepage. Seit v1.39.1 behoben — alle CLI-Ausgaben sind ASCII-sicher (`toConsoleAscii`). Falls weiterhin Mojibake erscheint: Konsole auf Windows-Terminal/`chcp 65001` stellen. |
| Immer noch „< 61 Kerzen“ nach dem Lauf | `--candle-limit` weglassen (Default 150 ≥ 61) bzw. auf ≥ 61 stellen; Status mit `npm run market:sync:status` prüfen. |
| Warnung im Control Panel bleibt nach Sync | Seite hart neu laden (Cache). Die Anzeige liest die Daten zur Anfragezeit — ein App-Neustart ist nicht nötig. |
| Web-App reagiert nicht auf `.env`-Änderung | Next.js liest `.env` nur beim Start → `npm run dev`/`npm run start` neu starten. |

---

## 8. Quellen im Repository

- `src/brokers/bitunix/config.ts` — `envFlagTrue` / `bitunixEnabled` (nur `"true"` schaltet an) + `BITUNIX_TICKER_SYMBOLS_PER_REQUEST=50` (v1.39.2 Chunking, ~1 KB, Gateway >6 KB)
- `src/brokers/bitunix/publicClient.ts` — `fetchTickers` chunked (50, Teilausfall toleriert, Totalausfall wirft ersten Fehler)
- `src/marketdata/enrichment.ts` — Batch-Kappe verwirft keine selbst angeforderten Zeilen, Failures mit `cause`
- `src/marketdata/sync.ts` — `selectedSymbolSet` + `toFailure` Klassifizierung aus Originalfehler
- `src/marketdata/registerAdapters.ts` — die vier Gates: Kill-Switch → Allowlist → Capability → Venue-Flag
- `scripts/market-sync.ts`, `scripts/run-market-sync.ts`, `scripts/lib/market-sync.ts` — CLI (ohne dotenv-Bezug)
- `src/scanner/warmup.ts` — `requiredWarmupCandles` = 61 (EMA50 + Momentum 60)
- `src/marketdata/types.ts` — `SYNC_CANDLE_LIMIT = 150`
- `.env.example` (§ „Bitunix Futures“ / „Market-Data-Sync“), `README.md`, `INSTALL.md`
- `docs/MARKET_DATA_PIPELINE.md`, `docs/BITUNIX.md`, `docs/LIVE_TRADING.md`
