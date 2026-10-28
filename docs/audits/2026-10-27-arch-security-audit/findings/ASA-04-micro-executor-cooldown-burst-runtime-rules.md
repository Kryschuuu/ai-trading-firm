# ASA-04 — `MicroExecutor` verliert alle 30 s Cooldowns, feuert doppelt bei Tick-Bursts und abonniert neue Symbole zur Laufzeit nicht

- **ID:** ASA-04
- **Severity:** HIGH
- **Bereich:** Architektur / Handelslogik & Concurrency
- **Status:** FIXED
- **Datei(en):** `src/lib/microExecutor.ts:537-566`, `src/lib/microExecutor.ts:818-920`, `src/lib/microExecutor.ts:1234-1240`, `src/lib/microExecutor.ts:1490-1509`, `src/lib/microExecutor.ts:1630-1660`, `src/lib/microExecutor.ts:1746-1755`
- **Session-Prompt:** [`../prompts/PROMPT-ASA-P1-04-micro-executor-cooldown-burst-hotreload.md`](../prompts/PROMPT-ASA-P1-04-micro-executor-cooldown-burst-hotreload.md)

## Beschreibung

Im Echtzeit-Daemon `MicroExecutor` führen vier Fehler in `RuleCache` und `handleTick` dazu, dass Regel-Cooldowns regelmäßig gelöscht werden, Tageszähler doppelt hochzählen, schnelle Tick-Bursts Doppel-Orders auslösen und zur Laufzeit angelegte Symbole ohne Daemon-Neustart tot bleiben.

## Technischer Nachweis

1. **Cooldown-Verlust & Doppelzählung (`src/lib/microExecutor.ts:537-566`):** `RuleCache.applySnapshot()` setzt alle 30 s (`pollTimer`) sowie bei jedem `NOTIFY` `firedAt: 0` und berechnet `executionsToday = r.executionsToday + (this.ramCounts.get(r.id) ?? 0)`, ohne `ramCounts` zurückzusetzen.
2. **Tick-Burst-Stampede (`src/lib/microExecutor.ts:818-905, 1630-1660`):** Zwischen `cache.match(tick)` und `cache.markFired(rule.id)` liegt das asynchrone `executeOrder()`. Alle in diesem Zeitfenster eintreffenden WebSocket-Ticks matchen dieselbe Regel erneut parallel.
3. **Fehlendes dynamisches Feed-Abonnement (`src/lib/microExecutor.ts:1490-1509, 1746-1755`):** `activeSymbols` und Feed-Streams werden nur einmalig in `start()` abonniert; per `NOTIFY` neu aktivierte `(symbol, timeframe)`-Paare erhalten weder Warmup-Bars noch Live-Ticks.
4. **Audit-Feld (`src/lib/microExecutor.ts:1237`):** `version: 1 : 1` statt `rule.version`.

## Konkreter Lösungsvorschlag

- `firedAt` über `prevById.get(r.id)?.firedAt ?? (r.lastExecutedAt ? r.lastExecutedAt.getTime() : 0)` initialisieren und über Snapshots bewahren; `this.ramCounts.clear()` bei konsistentem DB-Snapshot aufrufen.
- Ein `inFlightRules = new Set<number>()` synchron vor `await executeRule(...)` prüfen/setzen und im `finally`-Block freigeben.
- Bei `refresh()` neu hinzugekommene `(symbol, timeframe)`-Tupel erkennen, Warmup-Kerzen nachladen und den Feed dynamisch erweitern (`feed.subscribe(...)` bzw. sauberer Stream-Rebind).
- `version: rule.version ?? 1` im Audit-Detail protokollieren.

## Akzeptanzkriterien / Verifikation

- [x] Eine Regel mit `cooldownSeconds = 3600` feuert auch nach mehreren `refresh("poll")` / `applySnapshot()`-Zyklen innerhalb der Cooldown-Dauer kein zweites Mal.
- [x] `executionsToday` entspricht nach Order + nachfolgendem `applySnapshot()` exakt `1` (keine Verdopplung durch `ramCounts`).
- [x] Zwei gleichzeitig eintreffende Ticks für dieselbe Regel lösen während einer laufenden asynchronen Order-Ausführung exakt **eine** Order aus.
- [x] Eine nach `start()` aktivierte Regel auf einem neuen Symbol empfängt ohne Prozess-Neustart Ticks und feuert bei erfüllter Bedingung.
- [x] Regressionstest `tests/asa04.microExecutorConcurrency.test.ts` grün.


## Remediation (2026-10-28)

- Der Cache übernimmt den jeweils jüngsten lokalen bzw. in `rule_executions` persistierten Trigger-Zeitpunkt. Der Berliner Tageszähler stammt nach einem erfolgreichen DB-Read aus dem Snapshot; lokale Zähler werden erst dann zurückgesetzt. Bei Tageswechsel wird auch der alte DB-Zähler verworfen.
- Vor jedem ersten `await` sichert ein prozesslokaler Regel-Lock die Ausführung; `finally` gibt ihn auch bei Fehlern frei. Ein Snapshot-Read wartet auf laufende Ausführungen und verhindert neue Starts während des Reads. So kann ein Insert nicht zwischen Snapshot und lokaler Buchung doppelt gezählt werden. Fehlgeschlagene Reads behalten die lokalen Zähler.
- Nach jedem erfolgreichen Cache-Swap werden neue zulässige Symbol/Timeframe-Paare seriell vorbereitet. Während des Warmups gepufferte Ticks werden übernommen; bei Überlauf startet die Serie kalt. Binance erweitert den laufenden Stream additiv per `SUBSCRIBE`, ohne bestehende Streams zu unterbrechen, und übernimmt die Symbole beim Reconnect. Der Simulator unterstützt ebenfalls neue Symbole. Der Timeframe-Guard bleibt aktiv.
- `RULE_TRIGGERED` protokolliert die Regelversion aus dem Execution-Context.

### Betriebsgrenzen

Der Lock ist **prozesslokal**, kein verteilter Lock für mehrere Executor-Prozesse; Multi-Prozess-Orders benötigen weiterhin die Broker-/DB-Sicherungen. Additive dynamische Abonnements sind bei eigenen Feeds über `MarketFeed.updateSymbols` zu implementieren; der Binance-Feed unterstützt weiterhin nur seine Symbol-Whitelist. Fehlgeschlagenes oder leeres REST-Warmup führt zu einer kalten Serie, die erst nach genügend Live-Kerzen auswertbar ist; Fehler erscheinen in `status().seed`. Bei gepuffertem Warmup-Überlauf wird ebenfalls kalt gestartet. Ein noch laufender/defekter Adapter verzögert den nächsten Cache-Read; währenddessen starten keine weiteren Ausführungen. Binance-Verbindungsabbrüche unterliegen weiterhin dem Reconnect-Backoff und garantieren keine lückenlose Marktdatenhistorie.

### Regression

`tests/asa04.microExecutorDb.test.ts` prüft den echten PostgreSQL-Snapshot. `tests/asa04.microExecutorConcurrency.test.ts`: Cooldown und DB-Synchronisierung inklusive Neustart, fünf konkurrierende Ticks und Snapshot-Barriere, Lock-Freigabe bei Fehlern, neues Symbol und neuer Timeframe bei parallelen Invalidierungen, Version im verwendeten Audit-Payload sowie Binance-Subscribe/Reconnect.
