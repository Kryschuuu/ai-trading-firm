# GAP-09 — Reconciliation Broker ↔ DB + idempotente Order-IDs

**Nutzen:** ★★★★ (★★★★★ bei Live) · **Aufwand (Co-Audit):** 🔧🔧🔧 · **Aufwand (verifiziert):** 🔧🔧🔧
**Kategorie:** Live-Readiness · **Prompt:** [`PROMPT-09`](../prompts/PROMPT-09-reconciliation-idempotency.md)

## Befund (Co-Audit)

Zwingende Voraussetzung vor Aktivierung des Live-Pfads: Timeouts nach
Order-Submit sind sonst ein Doppelorder-Risiko. Im Paper-Modus kein akuter
Nutzen — umso wertvoller als Invarianten-Selbsttest. Bitunix-Eigenheiten
(Position-Modes, Hedge-Mode) machen den Abgleich aufwendig.

## Verifizierter Ist-Stand (2026-09-18, v1.40.0)

- `orderIntents`-Tabelle (H2-Fix) + Idempotenz-Tests für Bitunix
  (`tests/bitunix.idempotency.test.ts`); `reconcile`-Konzepte im
  Broker-Contract/Bitunix-Execution vorhanden.
- **Aber:** kein periodischer, adapter-übergreifender Abgleich
  (Broker ↔ DB) mit Differenz-Klassifikation, kein Alarm-/Pause-Pfad bei
  kritischer Abweichung, Client-Order-ID-Regime nicht einheitlich,
  kein Paper-Invarianz-Selbsttest (Ledger-Summen, negatives Cash).

## Delta

1. Periodischer Reconciliation-Job (Interval konfigurierbar): Broker-Positions/
   Orders/Balance ↔ DB; Differenz-Klassifikation (tolerierbarer Preis-Drift,
   Qty-Mismatch, Phantom-/fehlende Position) → Audit + Alert (GAP-10-Adapter)
   + optionale Trading-Pause (Flag; niemals Auto-Flatten ohne Admin).
2. Einheitliche Client-Order-ID-Konvention (deterministisch aus
   `orderIntent`-ID) für sichere Retries; Test: Timeout nach Submit → Retry
   erzeugt keine Doppelorder.
3. Paper-Modus: Reconciliation als Invarianten-Selbsttest des Ledgers —
   gibt auch ohne Live-Broker echten Nutzen.

## Akzeptanzkriterien (kurz)

Klassifikations-Tests je Differenztyp, Pause-Flag-Test, Idempotenz-Test mit
Mock-Timeout nach Submit, Paper-Invarianz-Test, Live-Gate unangetastet.

## Umsetzung (v1.50.0, 2026-09-19)

- **D1 Periodischer Reconciliation-Job (`src/brokers/reconciliation.ts`):**
  `runReconciliation(adapter, dbStore)` gleicht Broker-Positionen, Account-
  Balance und Ledger-Zustand gegen die DB ab (`positions`, `equity_snapshots`,
  `order_intents`). Reine Differenz-Klassifikation `classifyDifferences()`:
  `PRICE_DRIFT` innerhalb `RECON_PRICE_DRIFT_PCT` (1 %, Bounds [0.01, 10];
  tolerierbar, nur reportet), `QTY_MISMATCH` (kritisch), `PHANTOM_POSITION`
  (nur Broker — kritisch), `MISSING_POSITION` (nur DB — kritisch),
  `BALANCE_MISMATCH` (Kontostand-Abweichung — kritisch), `INVARIANT_VIOLATION`
  (Ledger-Invarianz-Bruch — kritisch). Report-Persistenz nach
  `data/reconciliation/last-report.json` via `resolveRuntimePath()`.
  Scheduler verdrahtet in `src/instrumentation.ts` (`RECON_INTERVAL_MINUTES`,
  60, Bounds [5, 1440]) + CLI `scripts/reconcile.ts` (`npm run reconcile`).
- **D2 Pause-Pfad:** `RECON_PAUSE_ON_MISMATCH` (Default false). Bei kritischer
  Klasse (`QTY_MISMATCH`, `PHANTOM_POSITION`, `MISSING_POSITION`, `BALANCE_MISMATCH`,
  `INVARIANT_VIOLATION`) wird der bestehende Kill-Switch-Pfad scharfgeschaltet
  (`killSwitch.pull("recon:<klasse>")`), in `kill_switches` persistiert, ein
  `CRITICAL`-Audit (`KILL_SWITCH`) geschrieben und ein Alert über den
  `AlertSink` emittiert. **Auto-Flatten ist strikt verboten** — Positionen
  bleiben unberührt; Re-Arm erfordert wie bisher den manuellen Disarm-Pfad
  mit Challenge-Nonce (`GET /api/firm/kill/challenge`).
- **D3 Client-Order-ID-Konvention:** Einheitliches, deterministisches Schema
  `atf-<orderIntentId-kurz>` (`buildClientOrderId()`) für alle Submit-Pfade
  (Bitunix `clientId`, Alpaca `client_order_id` / `Idempotency-Key`).
  Wiederholter Submit nach Timeout sendet dieselbe `clientOrderId` aus
  demselben Intent → sichere Venue- und DB-Status-Deduplizierung
  (`submitWithIntent`: genau eine Order, konsistenter `orderIntent`-Status).
- **D4 Paper-Invarianz-Selbsttest:** Kontinuierliche Validierung der Ledger-
  Invarianten: `freeCash >= 0`, `Summe Notional <= equity`, `fees >= 0`,
  keine negative Menge, `equity = freeCash + Summe Einstandswerte ± unrealizedPnl`
  (Formel direkt aus `PaperBroker.accountEquity` / `listPositions`).
  Verletzungen führen zur Klasse `INVARIANT_VIOLATION` mit Audit und Alert.
- **Tests:** `tests/reconciliation.test.ts` (17 Tests) deckt alle Fälle ab:
  Differenztypen inkl. Grenzfall genau `RECON_PRICE_DRIFT_PCT` (tolerierbar),
  Pause-Pfad an/aus mit Disarm-Challenge, Idempotenz mit Mock-Timeout nach
  Submit (exakt eine Order) und zweitem Intent (zwei Orders), Paper-Invarianzen
  (gesund vs. manipuliertes Negativ-Cash / Notional-Überschreitung) sowie
  Scheduler-Intervall mit Fake-Clock und Datei-Persistenz.
- **Docs:** `docs/BROKER_ARCHITECTURE.md` (§10), `docs/LIVE_TRADING.md` (§12),
  `CONFIGURATION.md`, `.env.example`, `CHANGELOG.md` 1.50.0.

**Offene Punkte (bewusst nicht in diesem Release):**
- Stubs (IBKR, BINANCE, KRAKEN, DYDX) werfen weiterhin `NotSupportedCapabilityError`.
- Generic `getOrders()` existiert nicht am `BrokerAdapter`-Vertrag (nur
  `reconcileOrder(orderId)` für Einzelfills) — dokumentiertes Rest-Delta.
