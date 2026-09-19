#!/usr/bin/env node
/**
 * CLI für Ad-hoc-Reconciliation (GAP-09, D1, v1.50.0).
 *
 * Führt den vollständigen Abgleich von Broker-Positionen, Account-Balance
 * und Paper-Invarianten gegen die PostgreSQL-Datenbank durch und speichert
 * den Bericht in `data/reconciliation/last-report.json`.
 *
 * Aufruf:
 *   node --import tsx scripts/reconcile.ts [--venue=PAPER|BITUNIX|ALPACA] [--mode=paper|live]
 */

import { getBroker } from "../src/brokers/factory";
import {
  runReconciliation,
  loadReconciliationConfig,
  RECON_REPORT_DEFAULT_FILE,
} from "../src/brokers/reconciliation";
import type { BrokerVenueId, ExecutionMode } from "../src/contracts/broker";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let venue: BrokerVenueId = "PAPER";
  let mode: ExecutionMode = "paper";

  for (const arg of args) {
    if (arg.startsWith("--venue=")) {
      venue = arg.slice(8).toUpperCase() as BrokerVenueId;
    } else if (arg.startsWith("--mode=")) {
      mode = arg.slice(7).toLowerCase() as ExecutionMode;
    }
  }

  const config = loadReconciliationConfig();
  console.log(`[reconcile] Starte Reconciliation für Venue=${venue}, Mode=${mode} ...`);
  console.log(
    `[reconcile] Konfiguration: Toleranz=${config.priceDriftPct} %, Intervall=${config.intervalMinutes} min, PauseOnMismatch=${config.pauseOnMismatch}`
  );

  const adapter = await getBroker(venue, mode);
  const report = await runReconciliation(adapter, undefined, { config });

  console.log(
    `[reconcile] Status: ${report.clean ? "SAUBER (keine kritischen Abweichungen)" : "ABWEICHUNGEN GEFUNDEN"}`
  );
  console.log(
    `[reconcile] Zusammenfassung: ${report.summary.total} Diskrepanzen (kritisch: ${report.summary.critical})`
  );
  console.log(`  - Preis-Drift (tolerierbar): ${report.summary.priceDrift}`);
  console.log(`  - Qty-Mismatch:             ${report.summary.qtyMismatch}`);
  console.log(`  - Phantom-Position (Broker): ${report.summary.phantomPosition}`);
  console.log(`  - Fehlende Position (DB):    ${report.summary.missingPosition}`);
  console.log(`  - Kassendifferenz:           ${report.summary.balanceMismatch}`);
  console.log(`  - Ledger-Invarianz:          ${report.summary.invariantViolation}`);

  if (report.paused) {
    console.warn(
      `[reconcile] ⚠️ PAUSE ENGAGED: Kill-Switch aktiviert mit Grund "${report.pauseReason}"!`
    );
  }

  for (const d of report.discrepancies) {
    const prefix = d.critical ? "[KRITISCH]" : "[INFO]";
    console.log(`  ${prefix} ${d.type}: ${d.detail}`);
  }

  console.log(`[reconcile] Bericht persistiert in: ${RECON_REPORT_DEFAULT_FILE}`);

  if (!report.clean) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[reconcile] Fataler Fehler bei der Reconciliation:", err);
  process.exit(2);
});
