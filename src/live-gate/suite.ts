/**
 * Security-Suite-Stamp (Task 11) — persistierte CI-Kennung der Security-
 * Test-Suite `security-live-gate`.
 *
 * Der Enforcer verlangt vor jeder Live-Order einen GÜLTIGEN Stamp:
 *   { schemaVersion, passed: true, runId, sha, at, source: "ci" | "manual" }
 *
 * Wer schreibt den Stamp? Der CI-Job `.github/workflows/security-live-gate.yml`
 * nach grüner Suite (`npm run live:stamp -- --run-id=… --sha=… --source=ci`).
 * Der Stamp ist ein DEPLOYMENT-ARTEFAKT (data/live-gate/security-suite.json),
 * kein Repo-File — er muss mit dem Release ausgeliefert werden. Ein lokal
 * selbst gestempelter ("manual") Stamp ist im Audit sichtbar.
 *
 * Gültigkeit: passed && runId nicht leer && (LIVE_GATE_SUITE_MAX_AGE_MS = 0
 * oder Alter <= Max). Alles andere => ungültig => Enforcer denied (fail-safe).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "./store";

export const SUITE_FILE_NAME = "security-suite.json";

export interface SecuritySuiteStamp {
  schemaVersion: number;
  passed: boolean;
  runId: string;
  sha: string | null;
  at: string;
  source: "ci" | "manual";
}

export interface SuiteStampValidation {
  valid: boolean;
  stamp: SecuritySuiteStamp | null;
  reason: string;
}

export function suiteStampFile(dir: string): string {
  return path.join(dir, SUITE_FILE_NAME);
}

/** Liest den Stamp (null wenn fehlend/ungültig als JSON). */
export function readSuiteStamp(dir: string): SecuritySuiteStamp | null {
  const file = suiteStampFile(dir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SecuritySuiteStamp;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.passed !== "boolean" ||
      typeof parsed.runId !== "string" ||
      typeof parsed.at !== "string" ||
      (parsed.source !== "ci" && parsed.source !== "manual")
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      passed: parsed.passed,
      runId: parsed.runId,
      sha: typeof parsed.sha === "string" ? parsed.sha : null,
      at: parsed.at,
      source: parsed.source,
    };
  } catch {
    return null;
  }
}

/** Validiert den Stamp gegen die konfigurierte Max-Alters-Policy. */
export function validateSuiteStamp(
  stamp: SecuritySuiteStamp | null,
  opts: { maxAgeMs: number; now?: number }
): SuiteStampValidation {
  if (!stamp) {
    return { valid: false, stamp: null, reason: "Kein Security-Suite-Stamp vorhanden (CI-Artefakt fehlt)." };
  }
  if (!stamp.passed) {
    return { valid: false, stamp, reason: `Security-Suite nicht bestanden (runId ${stamp.runId}).` };
  }
  if (!stamp.runId || stamp.runId.trim().length === 0) {
    return { valid: false, stamp, reason: "Suite-Stamp ohne CI-Kennung (runId) — ungültig." };
  }
  if (opts.maxAgeMs > 0) {
    const at = Date.parse(stamp.at);
    const now = opts.now ?? Date.now();
    if (!Number.isFinite(at) || now - at > opts.maxAgeMs) {
      return {
        valid: false,
        stamp,
        reason: `Suite-Stamp älter als LIVE_GATE_SUITE_MAX_AGE_MS (${opts.maxAgeMs} ms) oder Zeitstempel ungültig.`,
      };
    }
  }
  return { valid: true, stamp, reason: `Security-Suite bestanden (runId ${stamp.runId}, source ${stamp.source}).` };
}

/** Schreibt einen neuen Stamp (atomar) — Aufruf: CI-Script/Admin-CLI. */
export function writeSuiteStamp(
  dir: string,
  stamp: Omit<SecuritySuiteStamp, "schemaVersion" | "at"> & { at?: string }
): SecuritySuiteStamp {
  const full: SecuritySuiteStamp = {
    schemaVersion: 1,
    passed: stamp.passed,
    runId: stamp.runId,
    sha: stamp.sha ?? null,
    at: stamp.at ?? new Date().toISOString(),
    source: stamp.source,
  };
  atomicWriteFile(suiteStampFile(dir), JSON.stringify(full, null, 2) + "\n");
  return full;
}
