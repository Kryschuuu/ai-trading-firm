/**
 * API-Route: GET /api/firm/devils-advocate
 *
 * Liefert Status, Konfiguration und die jüngsten Falsifikationsanalysen des Devil's Advocate.
 */

import { NextResponse } from "next/server";
import { loadDevilsAdvocateConfig } from "@/devilsAdvocate/config";
import { resolveRuntimePath } from "@/lib/appPaths";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = loadDevilsAdvocateConfig();

  // Jüngstes Cycle-Artefakt suchen (falls vorhanden)
  let latestAnalysis = null;
  try {
    const cyclesDir = resolveRuntimePath("data/cycles");
    if (existsSync(cyclesDir)) {
      const entries = readdirSync(cyclesDir).filter((d) => d.startsWith("daily-")).sort().reverse();
      for (const entry of entries) {
        const artifactPath = path.join(cyclesDir, entry, "07b-devils-advocate.json");
        if (existsSync(artifactPath)) {
          const raw = readFileSync(artifactPath, "utf8");
          latestAnalysis = JSON.parse(raw);
          break;
        }
      }
    }
  } catch {
    // Optional
  }

  return NextResponse.json({
    ok: true,
    config: {
      enabled: cfg.enabled,
      shadowMode: cfg.shadowMode,
      scaleDownThreshold: cfg.scaleDownThreshold,
      humanReviewThreshold: cfg.humanReviewThreshold,
      scaleDownFactor: cfg.scaleDownFactor,
    },
    latestAnalysis,
  });
}
