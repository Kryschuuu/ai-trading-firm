import { NextResponse } from "next/server";
import {
  activateRule,
  pauseRule,
  archiveRule,
  rollbackRule,
  rejectRule,
  getRule,
} from "@/lib/ruleService";
import { guardWrite } from "@/lib/apiAuth";
import { requirePermission } from "@/auth";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Lebenszyklus einer Regel-Version: activate | pause | archive | rollback | reject.
 *
 * Rollback aktiviert die Vorgängerversion (−1) und superseded die aktuelle —
 * versioniert, atomar und vollständig im Audit-Log nachvollziehbar.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = guardWrite(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      action?: "activate" | "pause" | "archive" | "rollback" | "reject";
      by?: string;
      reason?: string;
    };

    const rule = await getRule(id);
    if (!rule) {
      return NextResponse.json({ ok: false, error: "Regel nicht gefunden" }, { status: 404 });
    }

    let outcome;
    switch (body.action) {
      case "activate": {
        // SEC-06: Aktivierung ist Governance — nur Admin (strategy.rules.activate).
        const deniedAct = requirePermission(req, "strategy.rules.activate");
        if (deniedAct) return deniedAct;
        outcome = await activateRule(id, body.by ?? "API");
        break;
      }
      case "pause": {
        // Operator (firm.write) darf pausieren; guardWrite bleibt Basisschutz.
        const deniedPause = requirePermission(req, "firm.write");
        if (deniedPause) return deniedPause;
        outcome = await pauseRule(id, body.by ?? "API");
        break;
      }
      case "archive": {
        // SEC-06: Archivierung ist Governance — nur Admin (strategy.rules.archive).
        const deniedArc = requirePermission(req, "strategy.rules.archive");
        if (deniedArc) return deniedArc;
        outcome = await archiveRule(id, body.by ?? "API");
        break;
      }
      case "rollback": {
        // SEC-06: Rollback ist Governance — nur Admin (strategy.rules.rollback).
        const deniedRoll = requirePermission(req, "strategy.rules.rollback");
        if (deniedRoll) return deniedRoll;
        outcome = await rollbackRule(id, body.by ?? "API");
        break;
      }
      case "reject": {
        // Ablehnung eines Drafts bleibt Operator (firm.write) vorbehalten.
        const deniedRej = requirePermission(req, "firm.write");
        if (deniedRej) return deniedRej;
        outcome = await rejectRule(id, body.reason ?? "abgelehnt über API", body.by ?? "API");
        break;
      }
      default:
        return NextResponse.json(
          { ok: false, error: "action erforderlich: activate|pause|archive|rollback|reject" },
          { status: 400 }
        );
    }

    if (!outcome.ok) {
      return NextResponse.json({ ok: false, error: outcome.error }, { status: 409 });
    }
    return NextResponse.json({ ok: true, detail: outcome.detail, rule: outcome.rule });
  } catch (e) {
    return NextResponse.json({ ok: false, error: publicErrorMessage(e) }, { status: 500 });
  }
}
