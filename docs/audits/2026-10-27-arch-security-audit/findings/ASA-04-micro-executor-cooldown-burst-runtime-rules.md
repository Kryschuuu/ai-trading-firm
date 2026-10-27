# ASA-04 — `MicroExecutor` verliert alle 30 s Cooldowns, feuert doppelt bei Tick-Bursts und abonniert neue Symbole zur Laufzeit nicht

- **ID:** ASA-04
- **Severity:** HIGH
- **Bereich:** Architektur / Handelslogik & Concurrency
- **Status:** OPEN
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

- [ ] Eine Regel mit `cooldownSeconds = 3600` feuert auch nach mehreren `refresh("poll")` / `applySnapshot()`-Zyklen innerhalb der Cooldown-Dauer kein zweites Mal.
- [ ] `executionsToday` entspricht nach Order + nachfolgendem `applySnapshot()` exakt `1` (keine Verdopplung durch `ramCounts`).
- [ ] Zwei gleichzeitig eintreffende Ticks für dieselbe Regel lösen während einer laufenden asynchronen Order-Ausführung exakt **eine** Order aus.
- [ ] Eine nach `start()` aktivierte Regel auf einem neuen Symbol empfängt ohne Prozess-Neustart Ticks und feuert bei erfüllter Bedingung.
- [ ] Regressionstest `tests/asa04.microExecutorConcurrency.test.ts` grün.
