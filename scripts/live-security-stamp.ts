/**
 * `npm run live:stamp` — Security-Suite-Stamp schreiben (Task 11, CI).
 *
 *   node --import tsx scripts/live-security-stamp.ts \
 *     --run-id=gha-1234-1 --sha=abc123… --source=ci
 *
 * Wird vom CI-Job `security-live-gate` NACH grüner Security-Suite aufgerufen
 * und erzeugt das Deployment-Artefakt `data/live-gate/security-suite.json`.
 * Der Enforcer verlangt einen gültigen Stamp vor jeder Live-Order — ohne
 * CI-Grün (oder dokumentiertes manuelles Stempeln) bleibt Live gesperrt.
 *
 * Das Stempeln selbst wird in der Audit-Kette protokolliert (action
 * "suite-stamp"); `--source=manual` ist im Stamp sichtbar (Transparenz).
 */
import { getLiveGateRuntime } from "../src/live-gate/runtime";
import { writeSuiteStamp } from "../src/live-gate/suite";

const args = process.argv.slice(2);

function arg(name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
}

const runId = arg("run-id");
const sha = arg("sha");
const source = arg("source") === "manual" ? "manual" : "ci";

if (!runId) {
  console.error("[live:stamp] --run-id=… ist Pflicht (CI-Kennung der Suite).");
  process.exit(2);
}

const runtime = getLiveGateRuntime(process.env);
const stamp = writeSuiteStamp(runtime.dir, { passed: true, runId, sha: sha ?? null, source });
runtime.audit.append({
  actor: source === "ci" ? "ci" : "admin",
  venue: "*",
  from: null,
  to: null,
  action: "suite-stamp",
  result: "OK",
  reason: `Security-Suite security-live-gate bestanden (runId ${runId}, sha ${sha ?? "n/a"}, source ${source}).`,
});
console.log(`[live:stamp] Stamp geschrieben: ${runtime.dir}/security-suite.json (runId ${runId}, source ${source})`);
