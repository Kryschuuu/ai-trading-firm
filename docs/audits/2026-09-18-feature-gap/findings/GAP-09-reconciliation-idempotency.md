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
