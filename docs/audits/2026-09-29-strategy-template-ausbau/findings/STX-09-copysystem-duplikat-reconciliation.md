# STX-09 — Copy-Reconciler würde bestehende Fill-Reconciliation duplizieren

- **ID:** STX-09
- **Severity:** MEDIUM
- **Bereich:** Broker / Copy-Trading
- **Quelle:** Ausbaudokument §2.7 („Partial Fills"), §2.8
- **Status:** OPEN
- **Datei(en):** `src/brokers/reconciliation.ts`, `src/executionQuality/`, `src/backtest/replayExecution.ts`

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
