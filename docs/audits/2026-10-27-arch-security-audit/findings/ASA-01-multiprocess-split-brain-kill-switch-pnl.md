# ASA-01 — Multi-Prozess-Split-Brain: `PaperBroker`, Kill-Switch und `realizedPnl` divergieren zwischen Web-Server und `micro-executor`

- **ID:** ASA-01
- **Severity:** CRITICAL
- **Bereich:** Architektur & Modularität / Datenkonsistenz
- **Status:** FIXED
- **Datei(en):** `deploy/micro-executor.service:7-20`, `src/lib/brokerHydration.ts:116-142`, `src/lib/broker.ts:460-605`, `src/lib/microExecutor.ts:840-905`, `src/lib/monitor.ts:716-750`, `src/app/api/firm/kill/route.ts:52-78`, `src/live-gate/enforcer.ts:183-245`
- **Session-Prompt:** [`../prompts/PROMPT-ASA-P0-01-multiprocess-ledger-killswitch-pnl.md`](../prompts/PROMPT-ASA-P0-01-multiprocess-ledger-killswitch-pnl.md)

## Beschreibung

Das produktive Deployment betreibt zwei getrennte OS-Prozesse (`ai-trading-firm.service` für Next.js/Monitor und `micro-executor.service` für den Echtzeit-Regel-Daemon). Trotzdem liegen `paperBroker` (`globalThis.__paperBroker`), `firmKillSwitchArmed` (`globalThis.__firmKillSwitchArmed`) und der `LiveGateService` ausschließlich im Prozess-RAM. `ensurePaperBrokerHydrated()` hydratisiert pro Prozess exakt einmal beim Start (`hydratedOnce = true`).

## Technischer Nachweis

1. **Prozesslokaler Kill-Switch:** `POST /api/firm/kill` (`src/app/api/firm/kill/route.ts:52-78`) persistiert zwar in `kill_switches`, ruft `armKillSwitch()` aber nur im Web-Prozess auf. Weder `paperBroker.submitAtomic()` (`src/lib/broker.ts:468`) noch `evaluateLiveOrder()` (`src/live-gate/enforcer.ts:183`) prüfen `kill_switches` in PostgreSQL. In `src/lib/microExecutor.ts:856` wurde die frühere DB-Kill-Switch-Abfrage vor `submitAtomic` entfernt — der `micro-executor` führt nach Aktivierung des Not-Aus weiter Orders aus.
2. **Systematischer `realizedPnl = 0`-Fehler:** Eröffnet `micro-executor` eine Position, fehlt diese im RAM-`paperBroker` des Web-Prozesses. Beim SL/TP-Exit in `applyExit` (`src/lib/monitor.ts:718-727`) gibt `broker.close(pos.symbol, exitPrice)` deshalb `null` zurück, woraufhin `const realized = closed ? closed.realizedPnl : 0` exakt `0` als realisierten PnL in `positions.realized_pnl` schreibt.
3. **Veraltete Risikogrenzen:** Cash-, Exposure- und Max-Positions-Prüfungen in `submitAtomic` rechnen auf dem isolierten lokalen RAM-Snapshot statt dem aktuellen DB-Bestand.

## Konkreter Lösungsvorschlag

```diff
--- a/src/lib/monitor.ts
+++ b/src/lib/monitor.ts
@@ -718,7 +718,14 @@ async function applyExit(
   exitPrice: number,
   reason: "STOP_LOSS" | "TAKE_PROFIT" | "TRAILING_STOP",
 ) {
+  await syncPaperBrokerFromDb(); // synchronisiert offene Cross-Prozess-Positionen unter Lock
   const closed = broker.close(pos.symbol, exitPrice);
-  const realized = closed ? closed.realizedPnl : 0;
+  const realized = closed
+    ? closed.realizedPnl
+    : computeRealizedPnlFallback({
+        side: pos.side as "LONG" | "SHORT",
+        entryPrice: pos.entryPrice,
+        exitPrice,
+        quantity: pos.quantity,
+      });
```

- Autoritativen DB-Kill-Switch-Check (`SELECT armed FROM kill_switches WHERE scope = 'global'`) Fail-Closed vor Order-Ausführung in `submitAtomic` / `evaluateLiveOrder` (ergänzt durch kurzen TTL-Cache + PostgreSQL `NOTIFY firm_control_changed` zur sofortigen Invalidierung) verdrahten.
- `syncPaperBrokerFromDb()` unter `withAccountLock` bereitstellen, damit offene Cross-Prozess-Positionen und Cash vor `submitAtomic` und `applyExit` abgeglichen werden.

## Umsetzung

- **Autoritatives prozessübergreifendes Kill-Switch-Gate (`src/lib/killSwitchDb.ts`, `src/lib/stateRegistry.ts`):**
  - `readAuthoritativeKillSwitch` und `evaluateAuthoritativeKillSwitchSync` lesen den globalen Status aus PostgreSQL (`kill_switches`), puffern ihn im Normalbetrieb höchstens `500 ms` (`KILL_SWITCH_CACHE_TTL_MS = 500`) und synchronisieren das lokale `killSwitch`-Latch (`src/lib/riskGuard.ts`).
  - Bei konfigurierter Datenbank entscheiden fehlgeschlagene DB-Abfragen sowie abgelaufene/unverifizierte Sync-Caches zwingend **Fail-Closed** (`armed = true`, `KILL_SWITCH_DB_UNAVAILABLE` bzw. `KILL_SWITCH_DB_UNVERIFIED` ohne Credential-Leaks). Für DB-freie Unit-Tests greift explizit der In-Memory-Fallback.
  - `POST /api/firm/kill` (`src/app/api/firm/kill/route.ts`), `src/lib/circuitBreaker.ts` und Auto-Kills in `src/lib/engine.ts` senden nach Persistenz `pg_notify('firm_control_changed', …)`; `FirmControlNotificationListener` (`startFirmControlListener`) invalidiert den TTL-Cache in `src/instrumentation.ts` und `scripts/micro-executor.ts` sofort.
  - Verdrahtet vor jeder Order-Annahme in `src/lib/microExecutor.ts` (`MicroExecutor` + `createPaperRuleAdapter`), `src/lib/engine.ts` (`runAgentTurn`, `executeApprovedProposal`, `runPipeline`), `src/live-gate/enforcer.ts` (`evaluateLiveOrder`), `src/brokers/factory.ts`, `src/brokers/bitunix/adapter.ts` und `src/app/api/live/state/route.ts`.
- **Cross-Prozess-Rehydration & deterministischer `realizedPnl` (`src/lib/broker.ts`, `src/lib/brokerHydration.ts`, `src/lib/monitor.ts`):**
  - `syncPaperBrokerWithDb` gleicht unter `withAccountLock("PAPER", …)` offene DB-Positionen (`positions` mit `status = 'OPEN'`) und extern geschlossene Positionen inkrementell über `PaperBroker.reconcileOpenPositions` mit dem lokalen `PaperBroker` ab (aufgerufen vor `submitAtomic` in `src/lib/engine.ts` und `src/lib/microExecutor.ts`, vor Paper-`flattenAll` sowie in `src/lib/monitor.ts`).
  - `computePaperClosePnl` vereinheitlicht die Richtungs- und Gebührenformel (`LONG` vs. `SHORT`, `entryPrice`, `exitPrice`, optionale Exit-Gebühr via `PaperBroker.resolveExitFee`) zwischen `PaperBroker.close` und `applyExit`.
  - In `src/lib/monitor.ts` (`applyExit`) entfällt der stille `0`-Fallback vollständig: ein einzelnes atomares `UPDATE positions … WHERE id = pos.id AND status = 'OPEN' RETURNING id` schreibt Status, `exitPrice` und deterministischen `realizedPnl` gemeinsam, verhindert Doppel-Closes zuverlässig und zieht bei fehlendem RAM-Eintrag ausschließlich den Netto-P&L (`PaperBroker.applyExternalCloseNetPnl`) nach.
- **Verifikation:** Regressionstests in `tests/asa01.multiprocessKillAndPnl.test.ts` (Cross-Prozess-Kill + `LISTEN/NOTIFY`, Fail-Closed-DB-Fehler, Cross-Prozess-`LONG`/`SHORT`-Gewinn- & Verlust-Exits mit Gebührenparität sowie OCO-Doppel-Close-Schutz).

## Akzeptanzkriterien / Verifikation

- [x] Nach `POST /api/firm/kill` (`action: "arm"`) lehnt ein separater Executor-/Order-Pfad ohne gemeinsamen RAM jede neue Paper- und Live-Order Fail-Closed ab; bei DB-Ausfall während des Kill-Checks wird ebenfalls blockiert.
- [x] Eine Position, die in `positions` existiert, aber zuvor nicht im lokalen `PaperBroker`-RAM lag, wird durch `applyExit` mit mathematisch korrektem `realizedPnl` (ungleich `0` bei Preisdifferenz) geschlossen und der Kontostand bleibt konsistent.
- [x] Regressionstest `tests/asa01.multiprocessKillAndPnl.test.ts` grün; `npm run typecheck`, `npm run lint`, `npm run docs:validate` grün.
