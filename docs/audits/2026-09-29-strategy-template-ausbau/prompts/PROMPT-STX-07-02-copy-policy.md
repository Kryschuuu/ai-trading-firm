# STX-07-02 — Copy-Policy-Engine + Order-Links (Idempotenz)

- **Phase:** 7 · **Paket:** 07-01 · **Findings:** STX-09, STX-16
- **Risiko:** mittel · **Unabhängig von Phase 1–6**

## Zweck

Die Risikoschranken und die Idempotenz. Ohne Order-Links ist ein Copy-Lauf bei
Netzwerk-Timeouts nicht rekonstruierbar; ohne Policy ist er nicht begrenzt.

## Kontext — was **nicht** gebaut wird

- **Kein Reconciler** (STX-09). Der Follower-Pfad erzeugt
  `execution_quality_intents` und nutzt `src/brokers/reconciliation.ts` +
  `src/executionQuality/`. Keine zweite Intent-/Receipt-Tabelle.
- **Kein Slippage-Cancel** (STX-09). Der Befund ist: ist die Order gefüllt, gibt es
  nichts zu stornieren. Richtig ist: **vor** dem Submit prüfen, **nachher** messen
  (`executionQuality` lernt `actualPriceDeviationBps`) und **künftige** Orders drosseln.

## Auftrag

### 1. `src/copy/policy.ts` (rein)

```ts
export interface CopyPolicy {
  maxNotionalPerEvent: number;
  maxNotionalPerDay: number;       // kumulativ
  maxSlippageBps: number;          // **vor** dem Submit
  maxOpenPositions: number;
  maxLossPerDayPct: number;        // aus dem Equity-Stand
  maxLeverage: number;
  /** Kill-Switch, unabhängig von allen anderen Werten. */
  halted: boolean;
}

export type PolicyDecision =
  | { allowed: true; }
  | { allowed: false; code: PolicyCode; detail: string };

export type PolicyCode =
  | "HALTED" | "MAX_EVENT_NOTIONAL" | "MAX_DAY_NOTIONAL" | "MAX_SLIPPAGE"
  | "MAX_POSITIONS" | "MAX_DAILY_LOSS" | "MAX_LEVERAGE" | "NO_MAPPING";
```

- `evaluatePolicy(intent, policy, context): PolicyDecision` — **fail-closed**, Default
  `allowed: false` im Zweifel; ein Fehler im Policy-Code ⇒ `HALTED`.
- **`maxSlippageBps` wird gegen den *erwarteten* Spread geprüft**
  (`RuleSnapshot.spreadPct` / Scanner-Faktor `spread`), **nicht** gegen den realisierten
  Fill. Ein bereits gefüllter Fill ist eine **Messung**, kein Fehler.
- Alle Grenzen aus `LIMIT_CEILINGS` (`src/lib/riskGuard.ts`) ableiten oder **strenger**
  sein. Die Copy-Logik darf die Broker-Guardrails **nicht** aufweichen — sie liegen
  **darüber** (engere Limits), nie darunter.
- Policy aus einer **versionierten Config** laden (Muster
  `strategyLifecycle/config.ts`), nicht hart kodieren.

### 2. Migration `drizzle/2026-09-2X_copy_subscriptions.sql` (additiv)

**Nur zwei Tabellen für Phase 7** — nicht die sechs aus dem Ausbaudokument:

**`copy_subscriptions`**
- `id uuid PK`, `follower_account text NOT NULL`
- `leader_venue text NOT NULL`, `leader_account text NOT NULL`, `leader_symbol text NOT NULL`
- `follower_instrument_id text` (Ergebnis von 07-01-Mapping, **nullable** bis Mapping läuft)
- `sizing_mode text NOT NULL CHECK in ('FIXED_AMOUNT','FIXED_RATIO','EQUITY_RATIO')`
- `sizing_params jsonb NOT NULL`
- `leverage_policy text NOT NULL CHECK in ('FOLLOW_LEADER','CAP','IGNORE','RISK_NORMALIZED')`
- `policy_json jsonb NOT NULL`, `policy_version text NOT NULL`
- `mode text NOT NULL DEFAULT 'SIMULATE_ONLY' CHECK (mode = 'SIMULATE_ONLY')`  ← **STX-16**
- `enabled boolean NOT NULL DEFAULT false`  (Default **aus**)
- `created_at`, `updated_at`
- `UNIQUE (follower_account, leader_venue, leader_account, leader_symbol)`

**`copy_order_links`** — die Idempotenz-Klammer
- `id uuid PK`
- `leader_event_id text NOT NULL`
- `follower_intent_id text NOT NULL`
- `execution_quality_intent_id uuid REFERENCES execution_quality_intents(id)` —
  **Verweis auf die bestehende Tabelle**, nicht eine neue (STX-09)
- `state text NOT NULL CHECK in ('PENDING','SENT','PARTIAL','FILLED','FAILED','DIVERGED')`
- `policy_code text` (bei `FAILED`)
- `observed_deviation_bps numeric` (Messung, kein Trigger)
- `created_at`, `updated_at`
- **`UNIQUE (leader_event_id, follower_intent_id)`** und
  `UNIQUE (follower_intent_id)` ⇒ doppelte Zustellung desselben Leader-Ereignisses
  erzeugt **keine** zweite Order
- Index auf `(state)`, `(leader_event_id)`

**Begründung der Minimalität:** `copy_trade_events` braucht es nicht — die
Leader-Ereignisse sind Quell-Ereignisse, kein persistenter Zustand. `copy_positions`
ist eine Projektion aus `positions`. `copy_risk_limits` steckt in `policy_json`.
Zwei Tabellen statt sechs: weniger Oberfläche, weniger Drift.

### 3. `src/copy/store.ts` — `createIntent()`, `markSent()`, `markFilled()`,
`markFailed()`. Jede Transition **nur** vorwärts entlang
`PENDING → SENT → PARTIAL → FILLED | FAILED`; `DIVERGED` terminal.
`markFilled` bei bereits `FILLED` ⇒ **No-Op** (Retry-Schutz).
Telemetrie + `writeAuditRecord` mit bounded Labels.

### 4. `src/copy/index.ts` — Barrel + Modul-Doku mit der **expliziten
Abgrenzung** zu `src/executionQuality/` und `src/brokers/reconciliation.ts`.

## Akzeptanzkriterien

- [ ] Kein eigener Intent-/Receipt-Pfad — nur FK auf `execution_quality_intents`
- [ ] `UNIQUE (follower_intent_id)` verhindert Doppel-Order bei erneuter Zustellung
- [ ] `evaluatePolicy` ist fail-closed; Exception ⇒ `HALTED`
- [ ] Copy-Limits nie **weiter** als `LIMIT_CEILINGS`
- [ ] `mode`-CHECK erzwingt `SIMULATE_ONLY` auf **DB-Ebene**
- [ ] `enabled` default `false`
- [ ] Kein Code-Pfad erzeugt eine Live-Order (grep-Prüfung über `src/copy/`)
- [ ] `tests/copy.policy.test.ts` + `tests/copy.db.test.ts` grün
- [ ] `npm run typecheck && npm run lint && npm test` grün

## Gesperrt

- **Keine** Leader-/Follower-Adapter (07-03).
- **Kein** eigener Reconciler, **kein** Slippage-Cancel.
- **Kein** Live-Pfad, **kein** Env-Flag, das `SIMULATE_ONLY` aufhebt.
- **Keine** Änderung an `executionQuality`, `brokers/reconciliation.ts`, `riskGuard.ts`.
