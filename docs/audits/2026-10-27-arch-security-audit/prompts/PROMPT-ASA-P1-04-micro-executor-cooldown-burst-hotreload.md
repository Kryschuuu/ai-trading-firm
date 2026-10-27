# PROMPT-ASA-P1-04 — `MicroExecutor`-Cooldowns, Tick-Burst-Lock & dynamisches Feed-Abonnement

- **Befund:** [`../findings/ASA-04-micro-executor-cooldown-burst-runtime-rules.md`](../findings/ASA-04-micro-executor-cooldown-burst-runtime-rules.md) (`HIGH`)
- **Tracking:** [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
- **Anwendung:** Den folgenden Block vollständig in eine frische Coding-Session kopieren.

```text
Du arbeitest im Repository `ai-trading-firm` (TypeScript, Echtzeit-Regel-Daemon in `src/lib/microExecutor.ts`).

AUFGABE: Behebe vollständig den Befund `ASA-04` im `MicroExecutor` (`firedAt`-Cooldown-Verlust bei jedem 30-s-Poll/NOTIFY, Doppelzählung von `executionsToday` über `ramCounts`, parallele Doppel-Orders bei Tick-Bursts, fehlendes dynamisches Symbol-/Timeframe-Abonnement zur Laufzeit sowie der `version: 1 : 1`-Audit-Bug).

KONTEXT & IST-ZUSTAND (lies diese Dateien zuerst komplett):
1. `docs/audits/2026-10-27-arch-security-audit/findings/ASA-04-micro-executor-cooldown-burst-runtime-rules.md`
2. `src/lib/microExecutor.ts` (insb. `RuleCache` Zeilen 515–680, `executeOrder` Zeilen 815–925, Audit-Eintrag Zeile 1230–1245, `start`/`refresh`/`handleTick` Zeilen 1470–1770)
3. Feed-Implementierungen, die `MicroExecutor` konsumiert (prüfe alle Imports am Dateikopf von `src/lib/microExecutor.ts`)
4. Bestehende Tests `tests/microExecutor*.test.ts` und `tests/tradeRules*.test.ts`

VIER KONKRETE FEHLER IN `src/lib/microExecutor.ts`:
1. `RuleCache.applySnapshot()` überschreibt bei jedem `refresh("poll")` (alle 30 s) und jedem `NOTIFY` für alle Regeln `firedAt: 0`. Dadurch ist jeder `cooldownSeconds > 30` wirkungslos. Zusätzlich rechnet `applySnapshot` `executionsToday = r.executionsToday + (this.ramCounts.get(r.id) ?? 0)`, ohne `ramCounts` zu bereinigen, sobald der DB-Wert die Ausführung bereits enthält.
2. In `handleTick` läuft `executeOrder` asynchron (`await`), `markFired(rule.id)` passiert aber erst nach Abschluss der Order. Treffen in diesen 20–150 ms weitere Ticks ein, matchen alle Ticks dieselbe Regel parallel und senden Mehrfach-Orders.
3. `activeSymbols` und die Live-Feed-Streams werden nur einmalig in `start()` aufgebaut. Zur Laufzeit neu aktivierte Regeln auf neuen `(symbol, timeframe)`-Kombinationen werden zwar per `NOTIFY` in `RuleCache` geladen, bekommen aber ohne Daemon-Neustart weder Bar-Warmup noch WebSocket-Ticks.
4. Um Zeile 1237 steht `version: 1 : 1` statt `rule.version`.

VERBINDLICHE UMSETZUNGSSCHRITTE:
1. Cooldown-Persistenz & exakte Tageszähler in `RuleCache`:
   - Bewahre bei `applySnapshot(rows)` für bestehende Regeln `firedAt = Math.max(prev?.firedAt ?? 0, dbLastFiredMs)` (falls das Regel-Row-Objekt einen Zeitstempel letzter Ausführung aus der DB liefert, nutze diesen zusätzlich für Prozess-Neustarts).
   - Vermeide Doppelzählungen zwischen DB-Snapshot und `ramCounts`: Sobald ein frischer DB-Snapshot eingelesen wurde, spiegelt `r.executionsToday` bereits alle vor Snapshot-Beginn committeten DB-Ausführungen wider; nur während des laufenden DB-Reads in-flight gezählte Ausführungen dürfen berücksichtigt werden, danach `ramCounts` sauber synchronisieren/zurücksetzen.

2. Synchroner Per-Rule-In-Flight-Lock gegen Tick-Bursts:
   - Führe ein `inFlightRuleIds = new Set<number>()` ein.
   - Prüfe vor dem Start einer Regel-Ausführung synchron (`!inFlightRuleIds.has(rule.id)`) und trage `rule.id` **vor** dem ersten `await` ein; entferne `rule.id` garantiert im `finally`-Block.
   - Berücksichtige `inFlightRuleIds` bereits in `match()` bzw. unmittelbar vor `executeRule`, damit parallele Ticks im selben Burst kein zweites `executeOrder` starten.

3. Dynamisches Hot-Subscribe für neue `(symbol, timeframe)`-Paare:
   - Erkenne nach jedem `refresh()` die Differenz zwischen bisher abonnierten Symbolen/Timeframes und den aktuell aktiven Regeln im `RuleCache`.
   - Für neu hinzugekommene `(symbol, timeframe)`-Paare: führe asynchron (mit Dedup-Guard gegen parallele Refreshes) das Kerzen-Warmup für das neue Paar aus und aktualisiere das Feed-Abonnement (entweder über eine `updateSymbols` / `subscribe`-Methode am Feed-Port oder einen sauberen, verlustfreien Stream-Rebind beim WS-Feed).

4. Audit-Version korrigieren:
   - Ersetze den fehlerhaften Ausdruck bei `version:` durch die tatsächliche Regelversion (`rule.version ?? 1`).

5. Audit-Tracking aktualisieren:
   - Setze `ASA-04` in `docs/audits/2026-10-27-arch-security-audit/findings/ASA-04-micro-executor-cooldown-burst-runtime-rules.md`, `README.md`, `remediation/TRACKING.md` und `docs/security/README.md` auf `FIXED`.

PFLICHT-TESTS & VERIFIKATION:
1. Erstelle `tests/asa04.microExecutorConcurrency.test.ts` für alle vier Punkte:
   - `cooldownSeconds = 600` bleibt über mehrfaches `applySnapshot()` / `refresh()` hinweg wirksam; `executionsToday` wird nach `markFired()` + DB-Snapshot mit aktualisiertem Zähler nicht verdoppelt (`1` statt `2`).
   - 5 zeitgleich eintreffende Ticks auf eine langsame (z. B. 50 ms verzögerte) Order-Ausführung führen zu exakt **1** Order-Aufruf.
   - Eine nach `start()` neu hinzukommende Regel auf einem neuen Symbol löst Warmup + Feed-Subscription aus und verarbeitet anschließende Ticks ohne Neustart.
   - Audit-Payload trägt die echte `rule.version`.
2. Führe aus und halte alles grün:
   - `npx tsx --test tests/asa04.microExecutorConcurrency.test.ts tests/microExecutor*.test.ts`
   - `npm run typecheck`
   - `npm run lint`
   - `npm run docs:validate`
   - `npm test`
```
