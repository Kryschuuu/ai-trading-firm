/**
 * `scripts/scan-live-gate-secrets.ts` — Secret-Scan über den Live-Gate-Code
 * (Task 11, CI-Schritt im Job `security-live-gate`).
 *
 * Scannt alle Quell-/Test-/Workflow-Dateien des Live-Gates auf Secret-Muster
 * (gleiche Muster wie der Bundle-Scanner, `scanTextForSecrets`).
 * Ergebnis MUSS leer sein (DoD: „Secret-Scan negativ"). Exit 1 bei Funden.
 *
 * Zusätzliche Guards:
 *   - Kein echter Bitunix-API-Key/-Secret in Live-Gate-Tests (CI-Regel:
 *     keine echten Orders/Credentials in der Security-Suite).
 *   - Workflow-Datei enthält keinen Inline-Secret-Wert (nur Referenzen).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { scanTextForSecrets } from "../src/brokers/control-plane/secretScan";

const ROOT = process.cwd();

const TARGET_DIRS = [
  "src/live-gate",
  "src/app/api/live",
  "tests/liveGate.api.test.ts",
  "tests/liveGate.architecture.test.ts",
  "tests/liveGate.enforcement.test.ts",
  "tests/liveGate.e2e.test.ts",
  "tests/liveGate.kill.test.ts",
  "tests/liveGate.persistence.test.ts",
  "tests/liveGate.states.test.ts",
  "tests/liveGate.unit.test.ts",
  "tests/fixtures/liveGateTestUtil.ts",
  "scripts/live-kill.ts",
  "scripts/live-security-stamp.ts",
  "docs/ci/security-live-gate.workflow.yml",
  ".github/workflows/security-live-gate.yml", // nach Installation (Owner-Step)
];

function collectFiles(rel: string): string[] {
  const full = path.join(ROOT, rel);
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return [full];
  const out: string[] = [];
  for (const name of readdirSync(full)) {
    const p = path.join(full, name);
    if (statSync(p).isDirectory()) out.push(...collectFiles(path.relative(ROOT, p)));
    else if (p.endsWith(".ts") || p.endsWith(".yml") || p.endsWith(".json")) out.push(p);
  }
  return out;
}

const files = [...new Set(TARGET_DIRS.flatMap(collectFiles))];
if (files.length < 10) {
  console.error(`[scan-live-gate-secrets] Zu wenige Ziele (${files.length}) — Pfadkaputt?`);
  process.exit(2);
}

let findings = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const hits = scanTextForSecrets(text);
  if (hits.length > 0) {
    findings += hits.length;
    console.error(`[scan-live-gate-secrets] ${path.relative(ROOT, file)}: ${hits.length} Fund(e)`);
    for (const hit of hits) {
      console.error(`  - Muster ${hit.pattern} @${hit.index}: ${hit.excerpt}`);
    }
  }
  if (/tests\\/.test(text) || /tests\//.test(text)) {
    if (/(BITUNIX_API_SECRET|BITUNIX_API_KEY)\s*[:=]\s*["'][A-Za-z0-9+/_-]{16,}/.test(text)) {
      findings += 1;
      console.error(`[scan-live-gate-secrets] ${path.relative(ROOT, file)}: echte Venue-Credentials in Tests verboten.`);
    }
  }
}

if (findings > 0) {
  console.error(`[scan-live-gate-secrets] ${findings} Fund(e) — FEHLGESCHLAGEN.`);
  process.exit(1);
}
console.log(`[scan-live-gate-secrets] ${files.length} Dateien gescannt — 0 Funde (negativ, wie gefordert).`);
