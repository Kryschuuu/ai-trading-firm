# STX-07-03 — Bitunix-Leader-Adapter + Simulate-only-Follower

- **Phase:** 7 · **Paket:** 07-02 · **Findings:** STX-08, STX-09, STX-16
- **Risiko:** **hoch** (erste Komponente, die echte Daten eines fremden Kontos liest)
- **Letzter Prompt der gesamten Roadmap**

## Zweck

Der **erste** lauffähige Copy-Loop: Bitunix-WS-Ereignisse → normalisieren → Policy →
Follower-Intent → **simuliert** ausführen. Kein Alpaca, kein Live, kein Reconciler.

## Kontext — warum Bitunix zuerst

`src/brokers/bitunix/ws.ts` **existiert**. Alpaca hat **keinen** WebSocket
(STX-08: `ls src/brokers/alpaca/` enthält kein `ws.ts`, kein `wss://`). Ein
Alpaca-Leader bräuchte einen eigenen Adapter-Audit — er ist **nicht** Teil dieser
Roadmap.

**Und:** Polling ist kein Ersatz. `getOrderUpdates` ist paginiert,
`events/orders/status` hat Sekundenlatenz, und `src/brokers/alpaca/http.ts:158-252`
hat bereits Retry-/Idempotenz-Logik für genau solche Fälle. Ein Polling-Leader wäre
langsam **und** fehleranfällig.

**Reaktion auf Order-/Fill-Ereignisse, nicht auf Positionen.** Bei einem
Positions-Polling ist nicht unterscheidbar, ob eine Position eröffnet, erhöht oder
verkleinert wurde — ohne `OPEN/INCREASE/DECREASE/CLOSE` ist das Kopieren nicht
deterministisch.

## Auftrag

### 1. `src/copy/leader/bitunix.ts`

```ts
export interface LeaderAdapter {
  connect(): Promise<void>;
  onEvent(h: (e: NormalizedLeaderTrade) => void): void;
  disconnect(): Promise<void>;
}
```

- Nutze **bestehende** Bitunix-Infrastruktur: `src/brokers/bitunix/ws.ts` (Reconnect/
  Heartbeat), `orders.ts` (`clientOrderIdFor`), `privateClient.ts`, `secrets.ts`,
  `redactor.ts`, `errors.ts`, `mapping.ts`. **Kein** zweiter WS-Client.
- **Reihenfolge:** erst `getOpenOrders`/`getPositions` beim Connect **als
  Baseline-Snapshot** („so war es vorher"), dann erst auf Order-/Fill-Ereignisse
  reagieren. Ohne Baseline erzeugt der erste Reconnect ein Copy für alles, was in der
  Zwischenzeit passiert ist.
- Ohne Baseline ⇒ **kein** Kopieren (`PolicyCode: "NO_BASELINE"`, kein
  `No-Op` mit Seiteneffekt).
- **Lücken-Erkennung:** wenn nach `N` Sekunden kein Heartbeat ⇒ Verbindung tot ⇒
  **Leader pausieren**, nicht mit veralteten Daten weiterlaufen. Copy mit stale Daten
  ist gefährlicher als kein Copy.
- Secrets über `secrets.ts`/`redactor.ts` — **niemals** im Log.

### 2. `src/copy/follower/simulated.ts`

- Nutze den **PaperBroker** (`src/brokers/paper.ts`) bzw.
  `src/backtest/paperExecution.ts` — **keine** eigene Fill-Simulation
- Ergebnis ⇒ `execution_quality_intents` (bestehender Pfad, STX-09)
- **Kein** `submit()`-Aufruf gegen eine echte Venue. Der Aufruf wird mit
  `mode: "SIMULATE_ONLY"` strukturell unmöglich gemacht.

### 3. `src/copy/engine.ts` — Orchestrierung

```
Leader-Event
  → dedupe (leader_event_id)
  → mapLeaderSymbol  (07-01, SSoT)
  → computeFollowerNotional (07-01)
  → evaluatePolicy    (07-02)      ← fail-closed
  → createIntent (07-02, UNIQUE ⇒ Idempotenz)
  → follower simulieren
  → markSent/Partial/Filled
```

- Jeder Schritt **fail-closed**: ein Fehler ⇒ kein Intent, Audit-Eintrag, Telemetrie
- **Dedup-Fenster:** `leader_event_id` wird **persistent** dedupliziert
  (`copy_order_links`), nicht nur im Speicher — sonst überlebt ein Neustart keine
  Idempotenz.
- **Latenz:** `occurredAt` des Leaders ⇒ `createdAt` des Followers wird protokolliert;
  ein Schwellwert ⇒ Finding, kein Abbruch.

### 4. `scripts/run-copy-paper.ts` + `npm run copy:paper`

Flags: `--leader-account`, `--symbols`, `--dry-run` (**Default**), `--duration`,
`--max-events`, `--policy=<datei>`, `--no-write`.

### 5. Dokumentation

`docs/COPY_TRADING.md` (neu), **verpflichtende** Abschnitte:
1. **Abgrenzung:** Was Copy-Trading ist und was **nicht** (kein Scraping, keine
   Fremdplattform-Automation, kein Live-Pfad).
2. **Alpaca ist nicht enthalten** und warum (STX-08).
3. **`SIMULATE_ONLY`** und die organisatorische Einordnung (STX-16): dieses Modul ist
   ein Forschungs-/Simulationswerkzeug in einem Paper-Trading-Projekt; ein Ausbau zu
   Live-Copy erfordert eine **separate** rechtliche Prüfung, die nicht Teil dieses
   Repos ist.
4. Symbol-Mapping, Leverage-Policy, Partial-Fills, Slippage (gemessen, nicht storniert).
5. **Welche Produkte nur als Referenzmodell dienten** und nicht nachgebaut wurden.

## Akzeptanzkriterien

- [ ] Kein eigener WS-Client — `src/brokers/bitunix/ws.ts` wird verwendet
- [ ] Baseline-Snapshot beim Connect; ohne Baseline **kein** Kopieren
- [ ] Heartbeat-Ausfall ⇒ Leader pausiert (nicht stale weiterlaufen)
- [ ] **Doppelzustellung desselben `leader_event_id` ⇒ genau eine Follower-Order**
      (Neustart-Test eingebaut)
- [ ] `evaluatePolicy` blockiert `HALTED` ⇒ **kein** Intent entsteht
- [ ] **Kein** Aufruf von `submit()` gegen eine echte Venue (grep-Prüfung)
- [ ] Secrets nie im Log (Test mit `scan-secrets`/`redactor`)
- [ ] `tests/copy.engine.test.ts` grün (WS-Events injiziert, **kein** Netzwerk)
- [ ] `npm run typecheck && npm run lint && npm test` grün
- [ ] `docs/COPY_TRADING.md` existiert mit allen 5 Abschnitten

## Gesperrt

- **Kein Alpaca.** Kein Polling-Leader.
- **Kein** eigener Reconciler, **kein** Slippage-Cancel.
- **Kein** Live-Pfad, kein Scraping, keine UI-Automation.
- **Keine** Änderung an `src/brokers/bitunix/**` (nur **lesen**; wenn dort etwas fehlt,
  als eigener Prompt melden).
- **Keine** Tabelle über `copy_subscriptions` + `copy_order_links` hinaus.
