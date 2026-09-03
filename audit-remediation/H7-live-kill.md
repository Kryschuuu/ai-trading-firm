# H7 — Kill-Switch/Flatten arbeitet nur auf dem Paper-Ledger

- **Severity:** HIGH
- **Bereich:** Handelslogik / Control
- **Status (validiert):** ✅ **Valide (architektonisch).** Live ist aktuell über das Gate
  blockiert, daher nicht unmittelbar ausnutzbar — bei späterer Live-Freigabe aber gefährlich.
- **Datei(en):** `src/app/api/firm/kill/route.ts` (`flattenAll`), `src/lib/engine.ts` (`flattenAll` → `getBroker()` liefert `PaperBroker`)

## Arena-Prompt (kopierbar)

```
TASK: Make the kill-switch flatten REAL venue positions, not just the paper ledger.

PROBLEM: /api/firm/kill -> flattenAll() -> getBroker() returns the in-process PaperBroker and
calls broker.closeAll(). The real Bitunix/live execution engine is never used, so a kill-switch
would "flatten" only the simulation while real venue positions remain open.

DO (paper-first, live-ready):
1. Introduce a Broker abstraction that both PaperBroker and the live BrokerExecutionEngine
   satisfy for emergency actions:
     interface EmergencyBroker {
       cancelAllOpenOrders(): Promise<void>;
       closeAllPositions(reason: string): Promise<Fill[]>;
       verifyFlat(): Promise<boolean>;
     }
2. getBroker() already returns PaperBroker (paper). For live, resolve the live
   BrokerExecutionEngine via the adapter factory (same path as H3). flattenAll should:
     - cancelAllOpenOrders()
     - closeAllPositions(reason)
     - verifyFlat()  // assert 0 open positions; if not flat, retry/alert + audit
   and only THEN arm/disarm the kill switch.
3. In /api/firm/kill, run the venue-level sequence BEFORE killSwitch.arm()/disarm(). Keep the
   paper ledger flatten as the default (paper mode) but gate on the configured execution mode.
4. Add an audit entry recording whether real venue flatten succeeded; if live is disabled, record
   "paper-only flatten (live disabled)".

ACCEPTANCE: With live mode configured, a kill flattens the venue (cancel+close+verify) and the
audit proves flatness; paper mode flattens the ledger. Test: mock EmergencyBroker, assert
cancelAllOpenOrders + closeAllPositions + verifyFlat called before arm.
```

## Beweis (aktueller Code)

`src/lib/engine.ts` L738‑745:

```ts
export async function flattenAll(reason: string) {
  const broker = await getBroker();           // -> PaperBroker
  const fills = broker.closeAll(reason === "MANUAL_FLATTEN" ? "MANUAL_FLATTEN" : reason);
  ...
}
```

## Fix-Spezifikation

Kill arbeitet auf Account-/Venue-Ebene: `cancelAllOpenOrders → closeAllPositions → verifyFlat`,
erst danach `killSwitch.arm()/disarm()` (siehe Audit H7-Fix-Skizze).

## Akzeptanzkriterien / Tests

- [ ] `flattenAll` ruft bei Live-Konfiguration `cancelAllOpenOrders`/`closeAllPositions`/`verifyFlat`.
- [ ] Kill-Switch wird erst nach verifiziertem Flat arming/disarming.
- [ ] Paper-Modus: Ledger-Flatten bleibt Default; Audit vermerkt Modus.

## Changelog-Blurb

`H7 (HIGH): Kill-Switch glattstellte nur Paper-Ledger — jetzt Venue-Ebene (cancel/close/verify)
vor arm/disarm; live-ready, paper-kompatibel.`

## Versions-Hinweis

PATCH (`1.36.3`) — Verhaltens-Härtung (Live weiterhin über Gate blockiert).
