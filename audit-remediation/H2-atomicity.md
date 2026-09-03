# H2 — Nicht-atomare Risk-/Positionsprüfung über mehrere Prozesse

- **Severity:** CRITICAL
- **Bereich:** Handelslogik
- **Status (validiert):** ⚠️ **Teilweise.** Der im Audit genannte `G.__paperBrokerLedger ??= new PaperBroker(...)`
  Singleton existiert nicht mehr (heute: Factory + DB-Hydration in `getBroker()`). Aber: die
  kritische Prüfung (Cash / Position-Slot / Kill-Switch) ist weiterhin prozess-lokal im
  `PaperBroker`-Speicher und wird erst **nach** dem Broker-`submit` in die DB geschrieben →
  über mehrere Node-Prozesse nicht atomar.
- **Datei(en):** `src/lib/engine.ts` (`getBroker`, `flattenAll`), `src/lib/broker.ts` (`PaperBroker.submit`), `src/db/schema.ts`

## Arena-Prompt (kopierbar)

```
TASK: Make order-intent reservation atomic across processes for the ai-trading-firm paper broker.

PROBLEM: PaperBroker holds positions/cash in process memory; two Next.js workers can each
hydrate the same open-position set and both pass the guard, then both write positions to the
DB. Risk checks (cash, maxConcurrentPositions, symbol-open, drawdown, kill-switch) are not
serialized. globalThis is NOT a distributed lock.

DO (bounded, no live-venue change):
1. Add a DB table `order_intents` (drizzle, see src/db/schema.ts style) with columns:
   id uuid PK defaultRandom(), account text (e.g. "PAPER"), symbol text, side text,
   qty numeric, status text ('RESERVED'|'FILLED'|'REJECTED'|'CANCELED'),
   created_at timestamptz defaultNow(), UNIQUE(symbol, status='RESERVED') partial index
   to enforce "no second open position per symbol".
2. Add `withAccountLock(account, fn)` in src/lib/broker.ts using a Postgres advisory
   transaction lock so the reserve→fill→persist sequence is exclusive:
     await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${account}))`);
   wrap the whole submit+cash-debit+position-write in ONE db.transaction.
3. In PaperBroker.submit, BEFORE applying the in-memory change, insert an order_intent row
   with status RESERVED inside the same transaction; on guard rejection set REJECTED; on
   success set FILLED and commit. The unique partial index rejects a second open position
   for the same symbol with a 23505 -> map to POSITION_ALREADY_OPEN.
4. Keep in-memory state as cache, but treat the DB as source of truth on hydration.
5. Add integration test: two concurrent submit() calls for the same symbol must yield exactly
   one FILLED and one POSITION_ALREADY_OPEN (or one RESERVED + one rejected).

ACCEPTANCE: Concurrent orders across processes cannot both open the same symbol or exceed
cash; tests simulate two transactions racing. No behaviour change for single-process dev.
```

## Beweis (aktueller Code)

`src/lib/engine.ts` `getBroker()` holt den Adapter aus der Factory und hydriert aus der DB;
`PaperBroker.submit` (`src/lib/broker.ts`) mutiert `this.positions`/`this.cash` **im Speicher**
und die `positions`-Tabelle wird erst danach (`runAgentTurn`) inserted. Zwei Worker sehen
denselben Startzustand → doppelte Genehmigung.

## Fix-Spezifikation

- Neue Tabelle `order_intents` + partieller Unique-Index `(symbol) WHERE status='RESERVED'`.
- `withAccountLock` via `pg_advisory_xact_lock` (Drizzle `sql` raw) um die kritische Sequenz.
- Alles (Reserve → Guard → Debit → Persist) in **einer** `db.transaction`.

## Akzeptanzkriterien / Tests

- [ ] Zwei parallele `submit()` für gleiches Symbol → genau 1 FILL, 1 `POSITION_ALREADY_OPEN`.
- [ ] Cash-Überschreitung ist über Prozesse hinweg unmöglich (Race-Test).
- [ ] Single-Process-Dev-Verhalten unverändert.

## Changelog-Blurb

`H2 (CRITICAL): Order/Positions-Limits nicht atomar über Prozesse — fügt order_intents-Tabelle
+ pg_advisory_xact_lock um Reserve→Fill→Persist (Resolves Teil-Risiko aus Audit 2026-09-03).`

## Versions-Hinweis

DB-Schema-Additiv (neue Tabelle, kein Break) → PATCH (`1.36.3`).
