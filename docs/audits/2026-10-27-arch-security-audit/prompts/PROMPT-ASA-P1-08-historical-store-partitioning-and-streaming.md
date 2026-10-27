# PROMPT-ASA-P1-08 — `HistoricalStore` partitionieren, UTF-8-Chunk-Bug & Streaming-Writes reparieren

- **Befund:** [`../findings/ASA-09-historical-store-oom-utf8-lost-update.md`](../findings/ASA-09-historical-store-oom-utf8-lost-update.md) (`HIGH`)
- **Tracking:** [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
- **Anwendung:** Den folgenden Block vollständig in eine frische Coding-Session kopieren.

```text
Du arbeitest im Repository `ai-trading-firm` (TypeScript, Marktdaten-Schicht unter `src/lib/marketdata/*`).

AUFGABE: Behebe vollständig den Befund `ASA-09` in `src/lib/marketdata/historicalStore.ts` (monolithischer Voll-Scan von `candles.ndjson` bei jedem `query()`/`ingest()`, UTF-8-Zeichenspaltung an 1-MiB-Chunk-Grenzen in `readLinesSync()`, V8-`RangeError` durch Gesamtstring-Konkatenation in `writeAll()` sowie Temp-File-Races und Cross-Prozess-Lost-Updates).

KONTEXT & IST-ZUSTAND (lies diese Dateien zuerst komplett):
1. `docs/audits/2026-10-27-arch-security-audit/findings/ASA-09-historical-store-oom-utf8-lost-update.md`
2. `src/lib/marketdata/historicalStore.ts` (komplett lesen!)
3. Alle Aufrufer von `HistoricalStore` in `src/` und `scripts/` (`grep -rn "HistoricalStore\|candles\.ndjson" src/ scripts/ tests/`)
4. Bestehende Tests: `tests/historicalStore*.test.ts`, `tests/marketdata*.test.ts`

VIER KONKRETE DEFEKTE IN `src/lib/marketdata/historicalStore.ts`:
1. `readLinesSync()` dekodiert jeden 1-MiB-Puffer isoliert per `buf.subarray(0, bytesRead).toString("utf8")`. Ein Multi-Byte-UTF-8-Zeichen auf der Chunk-Grenze wird in zwei kaputte Hälften (`U+FFFD`) zerschnitten.
2. `writeAll()` baut den gesamten Dateiinhalt mit `bars.map((b) => JSON.stringify(b)).join("\n")` als einen einzigen String im RAM — bei großen Kerzenbeständen wirft V8 `RangeError: Invalid string length`.
3. `writeAll()` nutzt `${filePath}.tmp-${process.pid}` als Temp-Pfad (kollidiert innerhalb desselben Prozesses) und schützt Read-Modify-Write in `ingest()`/`prune()` nicht per Lock gegen parallele Prozesse (z. B. `scripts/sync-*` parallel zum laufenden Web-Server).
4. Alle Symbole und Timeframes liegen ungeordnet/vermischt in einer einzigen Datei `candles.ndjson`, sodass jeder `query({ instrumentId, timeframe })`-Aufruf sämtliche Zeilen aller anderen Instrumente mitliest und per `JSON.parse` deserialisiert.

VERBINDLICHE UMSETZUNGSSCHRITTE:
1. Verlustfreies UTF-8-Streaming beim Zeilenlesen:
   - Verwende `StringDecoder` aus `node:string_decoder` (`new StringDecoder("utf8")`) in `readLinesSync`, rufe pro gelesenen Block `decoder.write(buf.subarray(0, bytesRead))` und am Dateiende `decoder.end()` auf, sodass Multi-Byte-Sequenzen über beliebige Chunk-Größen hinweg exakt rekonstruiert werden (mache `chunkSizeBytes` optional parametrisierbar für gezielte Grenz-Unit-Tests mit kleinen Puffern wie 16 Bytes!).

2. Speicher-konstantes, gelocktes atomares Schreiben:
   - Ersetze `bars.map(...).join("\n")` in der Schreibroutine durch gebündeltes Schreiben in 64-KiB-Puffern direkt über `writeSync(fd, chunk)` + `fsyncSync(fd)` + `closeSync(fd)` + `renameSync(tmpPath, targetPath)`. Damit bleibt der zusätzliche String-Speicher konstant `O(64 KiB)` unabhängig von der Anzahl der Kerzen.
   - Verwende einen kollisionsfreien Temp-Dateinamen `${targetPath}.tmp-${process.pid}-${randomUUID()}` (mit Aufräumen im `catch`-Block via `rmSync(..., { force: true })`).
   - Schütze mutierende Operationen (`ingest`, `clear`, Migration) durch eine Dateisperre im Store-Verzeichnis (`<dir>/.store.lock` mittels `openSync(..., "wx")`, kurzem Retry mit Backoff und Stale-Lock-Bereinigung), damit gleichzeitige Zugriffe zweier Store-Instanzen keine Lost Updates erzeugen.

3. Rückwärtskompatible Partitionierung pro `(instrumentId, timeframe)`:
   - Speichere Serien partitioniert pro `(instrumentId, timeframe)` unter `<dir>/series/<encodedKey>.ndjson` (verwende eine bijektive, Dateisystem-sichere und Path-Traversal-freie Kodierung für `instrumentId` und `timeframe`, z. B. URL-/Hex-Encoding für Sonderzeichen wie `/` oder `:`).
   - Volle Rückwärtskompatibilität: Existiert im Store-Verzeichnis noch eine Legacy-Datei `candles.ndjson` (aus bestehenden Installationen oder Tests, die `candles.ndjson` vorab anlegen), migriere sie beim ersten Lese-/Schreibzugriff unter Lock automatisch und verlustfrei in die Serien-Dateien (oder lies sie transparent ein und überführe sie beim nächsten Write), sodass `query()`, `listSeries()`, `stats()` und alle bestehenden Tests zu 100 % kompatibel bleiben!
   - `query({ instrumentId, timeframe, ... })` darf danach **nur noch** die Partitionsdatei dieser einen Serie öffnen und parsen (`O(N_series)` statt `O(N_all)`). Halte die Kerzen in jeder Partitionsdatei aufsteigend nach `openTime` sortiert, sodass Bereichsabfragen (`from`/`to`/`limit`) früh abbrechen bzw. effizient filtern können.

4. Audit-Tracking aktualisieren:
   - Setze `ASA-09` in `docs/audits/2026-10-27-arch-security-audit/findings/ASA-09-historical-store-oom-utf8-lost-update.md`, `README.md`, `remediation/TRACKING.md` und `docs/security/README.md` auf `FIXED`.

PFLICHT-TESTS & VERIFIKATION:
1. Erstelle `tests/asa09.historicalStoreSafety.test.ts`:
   - UTF-8-Chunk-Grenztest (z. B. `chunkSizeBytes = 17` mit 2-, 3- und 4-Byte-UTF-8-Zeichen im Quell-Feld): 0 `U+FFFD`-Ersetzungszeichen, 100 % identischer Roundtrip.
   - Partitionierungs-Nachweis: Store mit 20 Serien -> `query()` für `BTCUSDT` / `1m` berührt die übrigen 19 Serien nicht und liefert identische Ergebnisse.
   - Legacy-Migrations-Test: Vorhandene `candles.ndjson` mit gemischten Symbolen wird von `HistoricalStore` vollständig erkannt und verlustfrei abgefragt/migriert.
   - Parallele / verschachtelte `ingest()`-Aufrufe über zwei getrennte `HistoricalStore`-Instanzen auf demselben Verzeichnis verlieren keine Kerzen.
2. Führe aus und halte alles grün:
   - `npx tsx --test tests/asa09.historicalStoreSafety.test.ts tests/historicalStore*.test.ts`
   - `npm run typecheck`
   - `npm run lint`
   - `npm run docs:validate`
   - `npm test`
```
