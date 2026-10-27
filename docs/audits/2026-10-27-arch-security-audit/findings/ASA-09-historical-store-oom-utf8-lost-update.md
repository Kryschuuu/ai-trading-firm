# ASA-09 — `HistoricalStore` parst gesamte NDJSON-Historie pro Query, korrumpiert UTF-8 an 1-MiB-Grenzen und verliert Cross-Prozess-Writes

- **ID:** ASA-09
- **Severity:** HIGH
- **Bereich:** Performance & Datenintegrität
- **Status:** OPEN
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

- [ ] Multi-Byte-UTF-8-Zeichen (z. B. in `source` oder Instrument-Metadaten), die exakt über eine Chunk-Grenze fallen, werden verlustfrei zurückgelesen.
- [ ] `query({ instrumentId, timeframe })` liest nur noch die Datei der angefragten Serie statt aller anderen Symbole.
- [ ] Kein `join("\n")` über das gesamte Bar-Array mehr in `writeAll`; eindeutige `.tmp`-Suffixe und Cross-Handle-Schreibschutz sind durch `tests/asa09.historicalStoreSafety.test.ts` abgedeckt.
