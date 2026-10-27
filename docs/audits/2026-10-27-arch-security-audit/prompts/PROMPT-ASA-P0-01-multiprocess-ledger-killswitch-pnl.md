# PROMPT-ASA-P0-01 — Multi-Prozess-Split-Brain beheben (Kill-Switch, Rehydrierung & `realizedPnl`)

- **Befund:** [`../findings/ASA-01-multiprocess-split-brain-kill-switch-pnl.md`](../findings/ASA-01-multiprocess-split-brain-kill-switch-pnl.md) (`CRITICAL`)
- **Tracking:** [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
- **Anwendung:** Den folgenden Block vollständig in eine frische Coding-Session kopieren.

```text
Du arbeitest im Repository `ai-trading-firm` (TypeScript, Next.js App Router, Drizzle ORM + PostgreSQL, Node-Testrunner `tsx --test`).

AUFGABE: Behebe vollständig den kritischen Audit-Befund `ASA-01` (Multi-Prozess-Split-Brain zwischen Next.js-Server und `micro-executor`: prozesslokaler Kill-Switch, veralteter `PaperBroker`-RAM-Zustand und `realizedPnl = 0` beim Cross-Prozess-Exit).

KONTEXT & IST-ZUSTAND (lies diese Dateien zuerst komplett):
1. `docs/audits/2026-10-27-arch-security-audit/findings/ASA-01-multiprocess-split-brain-kill-switch-pnl.md`
2. `src/lib/broker.ts` (insb. `submitAtomic` ab Zeile 460, `close`, `armKillSwitch`/`isKillSwitchArmed`)
3. `src/lib/brokerHydration.ts` (`ensurePaperBrokerHydrated`, `restorePaperBrokerState` — läuft aktuell wegen `hydratedOnce` nur ein einziges Mal pro Prozessstart)
4. `src/lib/monitor.ts` (insb. `applyExit` um Zeile 716–750: `const closed = broker.close(pos.symbol, exitPrice); const realized = closed ? closed.realizedPnl : 0;`)
5. `src/lib/microExecutor.ts` (`executeOrder` ab Zeile 840)
6. `src/app/api/firm/kill/route.ts` und `src/live-gate/enforcer.ts` (`evaluateLiveOrder` ab Zeile 183)
7. `src/db/schema.ts` (Tabellen `killSwitches`, `positions`) und `src/lib/accountLock.ts` (`withAccountLock`)

WARUM DER FEHLER AUFTRITT:
- `ai-trading-firm.service` (Next.js + Monitor) und `micro-executor.service` laufen als zwei getrennte OS-Prozesse mit isoliertem RAM (`globalThis.__paperBroker`, `globalThis.__firmKillSwitchArmed`).
- `POST /api/firm/kill` schreibt in `kill_switches` und schärft den RAM-Kill-Switch nur im Web-Prozess. Weder `paperBroker.submitAtomic()` noch `evaluateLiveOrder()` lesen `kill_switches` aus PostgreSQL; im `micro-executor` laufen Orders nach einem Not-Aus weiter durch.
- Eröffnet `micro-executor` eine Position in PostgreSQL, fehlt sie im RAM-`paperBroker` des Web-Prozesses. Triggert `applyExit()` im Monitor einen SL/TP-Exit, liefert `broker.close(...)` `null` und der Fallback schreibt `realizedPnl = 0` in `positions.realized_pnl`.

VERBINDLICHE UMSETZUNGSSCHRITTE:
1. Autoritatives, prozessübergreifendes Kill-Switch-Gate (Fail-Closed):
   - Baue ein schlankes Modul `src/lib/killSwitchDb.ts` (oder erweitere `brokerHydration.ts` sauber), das den globalen `kill_switches`-Status aus PostgreSQL liest (mit kurzem, z. B. <= 500 ms TTL-Cache im Normalbetrieb + sofortiger Invalidierung via `NOTIFY` auf Kanal `firm_control_changed`, sobald `POST /api/firm/kill` schärft oder entschärft).
   - WICHTIG: Ist `DATABASE_URL` / DB im Produktionspfad konfiguriert und schlägt die Kill-Switch-Abfrage fehl, muss die Prüfung FAIL-CLOSED (`armed = true` + klarer Ablehnungsgrund) entscheiden. Für reine In-Memory-Unit-Tests ohne DB muss ein expliziter, testfreundlicher In-Memory-Fallback erhalten bleiben, damit bestehende Offline-Tests in `tests/` grün bleiben.
   - Prüfe diesen autoritativen Kill-Switch zwingend vor jeder Order-Annahme in `MicroExecutor` (`executeOrder`), vor den Pipeline-Käufen sowie in `evaluateLiveOrder` (`src/live-gate/enforcer.ts`), und synchronisiere den lokalen `PaperBroker`-Kill-Switch damit.

2. Cross-Prozess-Rehydrierung & deterministische `realizedPnl`-Berechnung:
   - Ergänze in `src/lib/brokerHydration.ts` eine wiederaufrufbare Synchronisationsfunktion `syncPaperBrokerWithDb()` (unter Schutz von `withAccountLock` bzw. innerhalb des bestehenden Account-Lock-Kontexts), die den offenen `positions`-Bestand in PostgreSQL mit dem lokalen `PaperBroker` abgleicht (neu in einem anderen Prozess eröffnete `open`-Positionen übernimmt, extern geschlossene entfernt und Cash konsistent hält).
   - Rufe diesen Abgleich vor `submitAtomic`-Pfaden (Macro-Engine & `MicroExecutor`) sowie in `monitor.ts` vor dem Auswerten/Schließen offener Positionen auf.
   - Eliminiere in `src/lib/monitor.ts` (`applyExit`) den stillen `0`-Fallback: Falls `broker.close(pos.symbol, exitPrice)` dennoch `null` liefert (z. B. weil die Position bereits zwischenzeitlich aus dem RAM entfernt wurde), berechne `realizedPnl` deterministisch mit exakt derselben Gebühren-/ Richtungsformel (`LONG` vs. `SHORT`, `entryPrice`, `exitPrice`, `quantity`, Exit-Fee) wie `PaperBroker.close()` und prüfe per bedingtem DB-Update (`WHERE id = pos.id AND status = 'open'`), dass kein Doppel-Close doppelt Cash gutschreibt.

3. Dokumentation & Audit-Tracking nachziehen:
   - Setze den Status von `ASA-01` in `docs/audits/2026-10-27-arch-security-audit/findings/ASA-01-multiprocess-split-brain-kill-switch-pnl.md` (inkl. Abschnitt `## Umsetzung`), `docs/audits/2026-10-27-arch-security-audit/README.md`, `docs/audits/2026-10-27-arch-security-audit/remediation/TRACKING.md` sowie den Zähler in `docs/security/README.md` auf `FIXED`.

LEITPLANKEN / NICHT-ZIELE:
- Keine Änderungen an `src/app/api/firm/lifecycle/route.ts`, `src/brokers/alpaca/*` oder anderen Audit-Befunden (`ASA-02`..`ASA-15`), um Merge-Konflikte zu vermeiden.
- Keine reinen Formatierungs-Änderungen außerhalb der betroffenen Dateien.

PFLICHT-TESTS & VERIFIKATION:
1. Erstelle `tests/asa01.multiprocessKillAndPnl.test.ts` mit mindestens folgenden Fällen:
   - Prozess A schärft den Kill-Switch in DB / Handler -> separater Executor-/Gate-Kontext mit frischem lokalem RAM blockiert Orders sofort.
   - Simulierter DB-Fehler beim Kill-Switch-Read blockiert Order-Ausführung Fail-Closed.
   - Position existiert in `positions` (`LONG` und `SHORT` mit Gewinn und Verlust), fehlt aber initial im lokalen `PaperBroker`-RAM -> Exit über den Monitor-Pfad verbucht den exakten, nicht-null `realizedPnl` (inkl. Gebührenparität zu `PaperBroker.close`) und schützt vor Doppel-Close.
2. Führe aus und stelle sicher, dass alles fehlerfrei durchläuft:
   - `npx tsx --test tests/asa01.multiprocessKillAndPnl.test.ts`
   - `npm run typecheck`
   - `npm run lint`
   - `npm run docs:inventories && npm run docs:inventories:check`
   - `npm run docs:validate`
   - `npm test`
```
