/** Only code-constant result labels; never order, instrument, strategy or fill IDs.
 * CLI counters are process-local; the durable operational source is audit_log. */

import { LabelCounter } from "../lib/telemetry";
export const executionQualityWrites = new LabelCounter(
  "execution_quality_ingest_total",
);
