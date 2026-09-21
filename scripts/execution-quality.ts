/** Operator-only normalized-event ingestion. Never accepts broker raw payloads. */
import "dotenv/config";
import { readFile, stat } from "node:fs/promises";
import { ExecutionQualityStore } from "../src/executionQuality/store";
import { QualityError } from "../src/executionQuality/model";
import { pool } from "../src/db";
import { auditWrite } from "../src/lib/auditSink";
import { executionQualityWrites } from "../src/executionQuality/telemetry";

async function main() {
  const [file, ...extra] = process.argv.slice(2);
  if (!file || extra.length) throw new QualityError("USAGE: npm run execution:ingest -- normalized-batch.json");
  if ((await stat(file)).size > 1024*1024) throw new QualityError("FILE_LIMIT");
  const data: unknown = JSON.parse(await readFile(file,"utf8"));
  const result = await new ExecutionQualityStore().append(data);
  executionQualityWrites.inc({ result: result.inserted ? "created" : "replayed" });
  await auditWrite("EXECUTION_QUALITY_INGEST", "INFO", { inserted: result.inserted });
  console.log(JSON.stringify({ ok: true, ...result }));
}
main().catch(async error => {
  executionQualityWrites.inc({ result: "failed" });
  const code = error instanceof QualityError ? error.code : "INGEST_FAILED";
  await auditWrite("EXECUTION_QUALITY_INGEST", "WARN", { code });
  console.error(JSON.stringify({ ok: false, error: code })); process.exitCode = 1;
}).finally(() => pool.end());
