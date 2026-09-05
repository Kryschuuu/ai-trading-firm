# H7 — Kill-Switch/Flatten arbeitet nur auf dem Paper-Ledger

- **Severity:** HIGH
- **Bereich:** Handelslogik / Control
- **Status (validiert):** ✅ **Gefixt v.1.36.20** — siehe `CHANGELOG.md`, `docs/AUDIT_REMEDIATION_2026-09.md` und `tests/h7.emergencyFlatten.test.ts`. Live bleibt weiterhin über das Gate blockiert; der Notfall-Pfad ist jetzt live-ready.
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

- [x] `flattenAll` ruft bei Live-Konfiguration `cancelAllOpenOrders`/`closeAllPositions`/`verifyFlat`.
- [x] Kill-Switch wird erst nach verifiziertem Flat arming/disarming.
- [x] Paper-Modus: Ledger-Flatten bleibt Default; Audit vermerkt Modus.

**Umsetzung (v1.36.20):** `src/contracts/broker.ts` (`EmergencyBroker`,
`EmergencyCloseFill`), `src/lib/engine.ts` (`resolveEmergencyBroker`, `flattenAll`
mit cancel → close → verify + Retry + `FLATTEN_ALL`-Audit mit `mode`/`venue`/
`flat`, Paper-Default „paper-only flatten (live disabled)“),
`src/app/api/firm/kill/route.ts` (Sequenz VOR `killSwitch.pull()`),
`src/lib/broker.ts` (`PaperBroker`), `src/brokers/bitunix/*` +
`src/brokers/alpaca/*` (Live-`BrokerExecutionEngine`). Tests:
`tests/h7.emergencyFlatten.test.ts`.

## Changelog-Blurb

`H7 (HIGH): Kill-Switch glattstellte nur Paper-Ledger — jetzt Venue-Ebene (cancel/close/verify)
vor arm/disarm; live-ready, paper-kompatibel.`

## Versions-Hinweis

Gefixt in **v1.36.20** (PATCH-Serie: H1=1.36.2 … S1=1.36.18, H2=1.36.19, H7=1.36.20).
Live bleibt über das Gate blockiert — der Notfall-Pfad ist live-ready
(paper-first), Verhaltens-Härtung statt Freischaltung.
