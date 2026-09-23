/**
 * Read-only Reconciliation-Worker des Execution-Quality-Ledgers.
 *
 * Zweck: sammelt echte Fill-Fakten + zeitpunktgerechte Markouts einer Venue
 * (ALPACA testnet / BITUNIX) in das append-only Quality-Ledger
 * (src/executionQuality/reconcile.ts); --watch läuft dauerhaft. Liest Broker-
 * Rohdaten NIE als Schreibquelle — unbekannte Submissions werden nur lesend
 * rekonstruiert und niemals erneut gesendet.
 * Aufruf: npm run execution:reconcile -- <VENUE> <MODE> [--watch]
 * Abhängigkeiten: ../src/brokers/factory, ../src/executionQuality/*, ../src/db.
 */

import "dotenv/config";
import { setTimeout } from "node:timers/promises";
import { getBroker, normalizeVenue } from "../src/brokers/factory";
import { EXECUTION_MODES, type ExecutionMode } from "../src/contracts/broker";
import { reconcileQuality } from "../src/executionQuality/reconcile";
import { qualityEnabled } from "../src/executionQuality/capture";
import { pool } from "../src/db";
async function main() {
  const args = process.argv.slice(2),
    venue = normalizeVenue(args[0]),
    mode = args[1] as ExecutionMode;
  if (
    !venue ||
    !EXECUTION_MODES.includes(mode) ||
    args.slice(2).some((a) => a !== "--watch")
  )
    throw new Error("USAGE: execution:reconcile VENUE MODE [--watch]");
  const scope = process.env.EXECUTION_QUALITY_SCOPE;
  if (!qualityEnabled() || !scope || !/^[A-Za-z0-9_.-]{1,64}$/.test(scope))
    throw new Error("CAPTURE_DISABLED_OR_MISSING_SCOPE");
  const adapter = await getBroker(venue, mode);
  let cursor = "",
    stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  do {
    const result = await reconcileQuality(adapter, scope, cursor);
    console.log(JSON.stringify(result));
    if (result.failures) process.exitCode = 1;
    cursor = result.nextCursor ?? "";
    if (!args.includes("--watch") && !cursor) break;
    await setTimeout(1000);
  } while (!stopped);
}
main()
  .catch(() => {
    console.error("EXECUTION_QUALITY_RECONCILIATION_FAILED");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
