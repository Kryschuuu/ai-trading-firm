/**
 * `npm run scan:secrets` — Secret-Scanner ueber das gebaute Frontend-Bundle.
 *
 * Task 08, Pflicht-Test: Der Scanner ueber ALLE API-Responses UND das
 * gebaute Frontend-Bundle muss leer sein. Die API-Response-Seite deckt
 * `tests/controlPlane.security.test.ts` ab (Route-Handler + Scanner);
 * dieses Skript deckt das Bundle ab (`.next/static`) und laeuft in CI
 * nach `next build`:
 *
 *   npm run build && npm run scan:secrets
 *
 * Exit 1 bei Funden; Exit 2 wenn kein Bundle existiert (erst bauen).
 */
import path from "node:path";
import { scanDirectory, maskExcerpt } from "../src/brokers/control-plane/secretScan";

const BUNDLE_DIR = path.resolve(process.cwd(), ".next/static");

const report = scanDirectory(BUNDLE_DIR);

if (report.files === 0) {
  console.error(
    `[scan:secrets] Kein Bundle unter ${BUNDLE_DIR} gefunden — erst "npm run build" ausfuehren.`
  );
  process.exit(2);
}

console.log(`[scan:secrets] ${report.files} Bundle-Dateien gescannt.`);

if (report.findings.length > 0) {
  console.error(`[scan:secrets] FAIL: ${report.findings.length} Secret-Muster im Bundle:`);
  for (const { file, finding } of report.findings.slice(0, 20)) {
    console.error(`  ${file} [${finding.pattern}] ${maskExcerpt(finding.excerpt)}`);
  }
  process.exit(1);
}

console.log("[scan:secrets] OK: keine Secret-Muster im Frontend-Bundle.");
