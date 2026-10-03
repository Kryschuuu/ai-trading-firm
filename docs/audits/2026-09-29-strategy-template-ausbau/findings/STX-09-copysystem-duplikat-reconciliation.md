# STX-09 — Copy-Reconciler würde bestehende Fill-Reconciliation duplizieren

- **ID:** STX-09
- **Severity:** MEDIUM
- **Bereich:** Broker / Copy-Trading
- **Quelle:** Ausbaudokument §2.7 („Partial Fills"), §2.8
- **Status:** FIXED — Abgleich 2026-10-03: 07-02 (`f5af325` PR #214, `v0.10.6`) und 07-03 (`5f437d8` PR #215) ohne zweiten Reconciler umgesetzt
- **Datei(en):** `src/brokers/reconciliation.ts`, `src/executionQuality/`, `src/backtest/replayExecution.ts`

## Abgleich 2026-10-03

- **Geprüfter Stand:** `main` @ `3d13161` · Code-Version `0.10.6` (Beta)
- **Eingestuft:** `☑` **FIXED** — von `OPEN` hochgestuft
- **Abgleich-Bericht:** [`../remediation/RECONCILE-2026-10-03.md`](../remediation/RECONCILE-2026-10-03.md)

**Nachweise**

- **Kein** eigener Reconciler: `src/copy/` enthält keinen `reconciler.ts`; `src/copy/index.ts:11` hält fest, dass Reconciliation bei `src/brokers/reconciliation.ts` bleibt
- Copy nutzt `executionQuality`, keine zweite Intent-/Receipt-Tabelle: `src/copy/follower/simulated.ts:54-55` importiert `newIntent`, `synchronousResult` aus `@/executionQuality/capture` und `ExecutionQualityStore`; `executionQualityIntentId` wird als FK-Ziel geführt (`simulated.ts:96-97`, `engine.ts:463,731`)
- **Kein** Cancel nach Fill: `src/copy/store.ts:6` („not a cancel/reject trigger"), `:280` („never cancels a fill"), `src/copy/policy.ts:6` (realisierter Versatz ist Evidenz, kein Storno-Grund); `grep cancelFollowerOrder src/` → 0 Treffer
- Genau **ein** `state`-Weg: `drizzle/2026-10-03_copy_subscriptions.sql:60-61` — `CHECK (state IN ('PENDING','SENT','PARTIAL','FILLED','FAILED','DIVERGED'))`
- Tests `copy.{domain,policy,engine}` ausgeführt: **grün** (u. a. `copy.engine.test.ts` 20/20)
- **Nicht verifizierbar:** `tests/copy.db.test.ts` (PostgreSQL fehlt)

## Beschreibung

§2.7/§2.8 schlagen einen eigenen `copy/reconciler.ts` mit
`LEADER_NEW → LEADER_PARTIAL → LEADER_FILLED` und
`FOLLOWER_NEW → FOLLOWER_PARTIAL → FOLLOWER_FILLED` vor. Der Follower-Teil existiert bereits.

## Beweis

- `src/brokers/reconciliation.ts` — Venue-Reconciliation
- `src/executionQuality/` mit **5 Tabellen**:
  `execution_quality_intents`, `_submissions`, `_quotes`, `_events`, `_receipts`,
  `_completed` (Migrationen `2026-09-20` … `2026-09-21`)
- `src/backtest/replayExecution.ts` — deterministischer Order-Lifecycle mit Partial Fills,
  Restmenge, Latenz, Depth-Impact, Order-TTL, Seed

Der Backtest-Replay-Pfad modelliert **genau** die Zustandsmaschine, die das Dokument für
den Follower beschreibt — inklusive Seed/Reproduzierbarkeit.

## Zusatzbefund: Slippage-Cancel ist unmöglich

§2.7 schlägt vor:

```ts
if (actualPriceDeviationBps > policy.maxSlippageBps) cancelFollowerOrder();
```

Ist die Order **gefüllt**, gibt es nichts zu canceln. Korrekt ist: den Versatz **nachträglich
messen** (dafür existiert `executionQuality`) und **künftige** Orders drosseln
(`maxSlippageBps` als Gate vor dem Submit, nicht als Reaktion danach).

## Remediation

1. **Kein** neuer Reconciler. Der Copy-Pfad erzeugt `execution_quality_intents` und
   nutzt die vorhandene Reconciliation.
2. Nur **eine** neue Zustandsdimension: `copy_order_links.state` mit Werten
   `PENDING | SENT | PARTIAL | FILLED | FAILED | DIVERGED` — orthogonal zur
   Execution-Quality-Maschine, nicht parallel dazu.
3. Slippage-Policy **vor** dem Submit als Gate; danach nur Messung + Lernziel.

## Akzeptanzkriterien

- [ ] Copy nutzt `executionQuality`, keine zweite Intent-/Receipt-Tabelle
- [ ] Kein `cancelFollowerOrder()`-Pfad nach Filled
- [ ] `copy_order_links` hat genau einen `state`-Weg je Order

## Versions-Hinweis

Minor (neue Tabelle, kein Eingriff in Execution-Quality).
