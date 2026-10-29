# ASA-09 — `HistoricalStore` parst gesamte NDJSON-Historie pro Query, korrumpiert UTF-8 an 1-MiB-Grenzen und verliert Cross-Prozess-Writes

- **ID:** ASA-09
- **Severity:** HIGH
- **Bereich:** Performance & Datenintegrität
- **Status:** `FIXED` (v0.17.5, 2026-10-29)
- **Datei(en):** `src/lib/marketdata/historicalStore.ts:375-425`, `src/lib/marketdata/historicalStore.ts:440-530`, `src/lib/marketdata/historicalStore.ts:555-603`
- **Session-Prompt:** [`../prompts/PROMPT-ASA-P1-08-historical-store-partitioning-and-streaming.md`](../prompts/PROMPT-ASA-P1-08-historical-store-partitioning-and-streaming.md)

## Beschreibung

`HistoricalStore` bündelt sämtliche Kerzen aller Instrumente und Timeframes in einer einzigen monolithischen Datei `candles.ndjson`. Dadurch skaliert jede Lese- und Schreiboperation linear mit der Gesamthistorie (`O(N_total)`), spaltet Multi-Byte-UTF-8-Zeichen an 1-MiB-Puffergrenzen, stürzt ab ~512 MB mit `RangeError: Invalid string length` ab und verliert bei parallelen Zugriffen Daten.

## Technischer Nachweis

1. **Monolithischer Voll-Scan (`src/lib/marketdata/historicalStore.ts:440-530`):** Jeder `query()`- und `ingest()`-Aufruf liest synchron alle Zeilen von `candles.ndjson` und führt `JSON.parse` für jede Zeile aus — auch wenn nur die letzten 200 Kerzen eines einzelnen Symbols abgefragt werden.
2. **UTF-8-Chunk-Korruption (`readLinesSync`, Zeile 569–585):** `buf.subarray(0, bytesRead).toString("utf8")` dekodiert 1-MiB-Blöcke isoliert ohne `StringDecoder("utf8")`. Ein über die Chunk-Grenze gespaltenes Multi-Byte-Zeichen wird zu `U+FFFD` verfälscht.
3. **V8-String-Limit (`writeAll`, Zeile 593–601):** `bars.map((b) => JSON.stringify(b)).join("\n")` allokiert einen einzigen Gesamtstring im Heap und wirft bei großen Historien `RangeError`.
4. **Temp-File-Kollision & Lost Updates (Zeile 595):** `${filePath}.tmp-${process.pid}` kollidiert bei nebenläufigen Aufrufen im selben Prozess; Cross-Prozess-Writes zwischen CLI-Sync und Web-Server überschreiben sich ohne Lock gegenseitig.

## Konkreter Lösungsvorschlag

- `StringDecoder("utf8")` aus `node:string_decoder` in `readLinesSync` nutzen (`decoder.write(...)` + `decoder.end()`).
- `writeAll` auf gebündeltes FD-Streaming (`writeSync` in 64-KiB-Blöcken ohne Gesamtstring), `fsyncSync(fd)`, eindeutigen Temp-Namen (`${process.pid}-${randomUUID()}`) und eine Lock-Datei (`<storeDir>/.write.lock`) umstellen.
- Serien dateibasiert pro `(instrumentId, timeframe)` unter `<dir>/series/<safeInstrument>__<timeframe>.ndjson` partitionieren, wobei eine vorhandene Legacy-`candles.ndjson` beim ersten Zugriff transparent migriert bzw. als Fallback gelesen wird, sodass alle bestehenden Aufrufer und Tests kompatibel bleiben.

## Akzeptanzkriterien / Verifikation

- [x] Multi-Byte-UTF-8-Zeichen (z. B. in `venue`/`feed`/Instrument-Metadaten), die exakt über eine Chunk-Grenze fallen, werden verlustfrei zurückgelesen.
- [x] `query({ instrumentId, timeframe })` liest nur noch die Datei der angefragten Serie statt aller anderen Symbole.
- [x] Kein `join("\n")` über das gesamte Bar-Array mehr in `writeAll`; eindeutige `.tmp`-Suffixe und Cross-Handle-Schreibschutz sind durch `tests/asa09.historicalStoreSafety.test.ts` abgedeckt.

## Umsetzung (FIXED, v0.17.5 — 2026-10-29)

Alle vier Defekte sind in `src/lib/marketdata/historicalStore.ts` behoben:

1. **UTF-8-verlustfreies Streaming (`readLinesSync`):** Der zeilenweise Leser
   dekodiert über `StringDecoder("utf8")` aus `node:string_decoder`
   (`decoder.write(chunk)` je Block, `decoder.end()` am Dateiende). Ein
   Multi-Byte-Zeichen, das exakt auf einer Chunk-Grenze liegt, wird exakt
   rekonstruiert — nachgewiesen für 2-/3-/4-Byte-Zeichen mit 17-Byte-Puffern
   und für ein 4-Byte-Zeichen exakt auf der echten 1-MiB-Grenze.
   `chunkSizeBytes` ist als optionaler Parameter für Grenz-Unit-Tests
   parametrisierbar (`READ_CHUNK_BYTES` = 1 MiB als Default).
2. **Speicherkonstantes, atomares Schreiben:** Die Schreibroutine bündelt
   Zeilen in 64-KiB-Puffern und schreibt direkt über `writeSync(fd, chunk)` +
   `fsyncSync(fd)` + `closeSync(fd)` + `renameSync(tmp, target)` — der
   zusätzliche String-Speicher bleibt konstant `O(64 KiB)`, ein
   `RangeError: Invalid string length` ist ausgeschlossen (auch in
   `writeStoreSnapshot`). Temp-Namen sind kollisionsfrei
   (`${target}.tmp-${process.pid}-${randomUUID()}`) und werden im `catch`
   via `rmSync(…, { force: true })` entfernt.
3. **Cross-Prozess-Sperre:** `append`/`appendSeries`/`clear` und die
   Layout-Migration halten `<dir>/.store.lock` (`openSync(…, "wx")`, Retry mit
   Backoff, Stale-Bereinigung nach Halter-PID und Haltezeit ≥ 15 s,
   `LOCK_TIMEOUT`-Fehler statt stillem Overwrite; Freigabe nur durch den
   Halter-Prozess). Zwei Store-Instanzen — auch über Prozessgrenzen —
   erzeugen keine Lost Updates mehr.
4. **Partitionierung pro `(instrumentId, timeframe)`:** Serien liegen unter
   `<dir>/series/<encodedKey>.ndjson`; der Dateiname ist bijektiv und
   Path-Traversal-frei (Percent-Encoding aller Zeichen außer
   `[A-Za-z0-9._-]`, `%` selbst wird mitkodiert; unbekannter Timeframe →
   `INVALID_TIMEFRAME`, zu lange IDs → `INSTRUMENT_ID_TOO_LONG` fail-closed).
   `query()` öffnet und parst ausschließlich die eine Partitionsdatei;
   Partitionsdateien sind aufsteigend nach `ts` sortiert und werden
   zeilenweise gestreamt (`from`/`to` filtern im Strom, `limit` nach dem
   Sortieren). `appendSeries` liest/schreibt nur die berührten Serien.
5. **Rückwärtskompatibilität:** Existiert noch eine Legacy-`candles.ndjson`,
   wird sie beim ersten Lese-/Schreibzugriff **unter Lock** automatisch und
   verlustfrei migriert: v2-Zeilen wandeln dedupliziert in die Serien-Dateien,
   das Original bleibt byte-exakt als `candles.ndjson.migrated-<stamp>-<uuid>`
   erhalten (Legacy-v1-Zeilen ausschließlich dort; `npm run history:migrate`
   kann das Backup weiter verarbeiten). Schlägt die Migration fehl (read-only),
   lesen alle Zugriffe die Legacy-Datei transparent weiter. Neue Helfer-API:
   `seriesFilePath()`, `listSeries()`, `stats()`, `clear()`,
   `readLinesSync(file, chunkSizeBytes?)`.

### Verifikation

- `npx tsx --test tests/asa09.historicalStoreSafety.test.ts
  tests/history/historicalStore.test.ts tests/marketdata/historicalStore.test.ts`
  — 34/34 grün (UTF-8-Grenzen 17 B/1 MiB, 20-Serien-Partitionierungsnachweis
  mit vergifteten Fremdpartitionen, Legacy-Migration byte-exakt + idempotent,
  Cross-Instanz-Ingests ohne Lost Updates, Lock-Timeout/Stale-Recovery,
  Temp-Hygiene, 20.000-Bar-Schreiblauf).
- `npm run typecheck`, `npm run lint`, `npm run docs:validate`, `npm test`
  und `npm run security:live-gate` — grün (Stand v0.17.5).

