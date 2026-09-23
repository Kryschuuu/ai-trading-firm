/**
 * API-Route `GET /api/firm/execution-quality` — Venueübergreifendes Execution-Benchmarking (bounded, Lese-API).
 *
 * Teil der Firm-API (Next.js App Router). Autorisierung: requirePermission("firm.read") — Auth-Modell und RBAC: docs/security/README.md.
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/auth";
import { QualityError } from "@/executionQuality/model";
import { ExecutionQualityStore, reportRange } from "@/executionQuality/store";
export const dynamic = "force-dynamic";
/** Authenticated, read-only, bounded [from,to) UTC epoch-ms report. No IDs or
 * provider payloads are returned. See src/executionQuality/README.md. */
export async function GET(req: Request) {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;
  const headers = { "Cache-Control": "private, no-store" };
  const params = new URL(req.url).searchParams;
  const read = (name: string) => /^\d{1,16}$/.test(params.get(name) ?? "") ? Number(params.get(name)) : NaN;
  const from = read("from"), to = read("to"), asOf = read("asOf");
  try { reportRange(from,to,asOf); }
  catch { return NextResponse.json({ ok: false, error: "INVALID_REPORT_RANGE" }, { status: 400, headers }); }
  try {
    return NextResponse.json({ ok: true, ...await new ExecutionQualityStore().report(from,to,asOf) }, { headers });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof QualityError ? error.code : "EXECUTION_QUALITY_UNAVAILABLE" }, { status: error instanceof QualityError ? 422 : 503, headers });
  }
}
