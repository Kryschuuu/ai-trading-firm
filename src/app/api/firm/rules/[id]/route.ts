import { NextResponse } from "next/server";
import {
  activateRule,
  pauseRule,
  archiveRule,
  rollbackRule,
  rejectRule,
  getRule,
} from "@/lib/ruleService";
import { checkRateLimit } from "@/lib/apiAuth";
import { requirePermission, RULE_ACTION_PERMISSIONS, type RuleLifecycleAction } from "@/auth";
import { rejectClientActorFields, ruleActor } from "@/lib/ruleActor";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Lebenszyklus einer Regel-Version: activate | pause | archive | rollback | reject.
 *
 * Rollback aktiviert die Vorgängerversion (−1) und superseded die aktuelle —
 * versioniert, atomar und vollständig im Audit-Log nachvollziehbar.
 *
 * SEC-05: Die Audit-Attribution (`by`) stammt ausschließlich aus dem
 * authentifizierten Credential (`ruleActor` → `resolveAuth`). Ein
 * client-geliefertes `by`/`actor`/`sourceRole` ist kein Teil des API-Vertrags
 * mehr und führt zu 400 — der Audit-Trail bleibt forensisch belastbar.
 * SEC-06: Operative Pflege (pause/reject) ist von administrativer Governance
 * (activate/rollback/archive) getrennt, auch für bereits aktive Versionen.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requirePermission(req, "strategy.rules.write") ?? checkRateLimit(req);
  if (denied) return denied;
  try {
    const parsed: unknown = await req.json().catch(() => null);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: "JSON-Objekt erforderlich" }, { status: 400 });
    }
    const body = parsed as Record<string, unknown>;

    // SEC-05: fail-closed statt stillem Ignorieren.
    const forged = rejectClientActorFields(body);
    if (forged) return forged;
    const forgedNested = rejectClientActorFields(body.rule);
    if (forgedNested) return forgedNested;

    // SEC-06: Keine implizite Permission und kein Prototyp-Lookup. Die
    // Autorisierung gilt auch für unbekannte IDs und idempotente Aktionen:
    // erst das aktionsbezogene Recht prüfen, dann den Rule-Service berühren.
    if (typeof body.action !== "string" || !Object.hasOwn(RULE_ACTION_PERMISSIONS, body.action)) {
      return NextResponse.json(
        { ok: false, error: "action erforderlich: activate|pause|archive|rollback|reject" },
        { status: 400 }
      );
    }
    const action = body.action as RuleLifecycleAction;
    const actionDenied = requirePermission(req, RULE_ACTION_PERMISSIONS[action]);
    if (actionDenied) return actionDenied;
    if (Object.hasOwn(body, "reason") && typeof body.reason !== "string") {
      return NextResponse.json({ ok: false, error: "reason muss ein String sein" }, { status: 400 });
    }

    // Einzige Quelle der Attribution: das authentifizierte Credential.
    const actor = ruleActor(req);

    const { id } = await params;
    const rule = await getRule(id);
    if (!rule) {
      return NextResponse.json({ ok: false, error: "Regel nicht gefunden" }, { status: 404 });
    }

    let outcome;
    switch (action) {
      case "activate":
        outcome = await activateRule(id, actor);
        break;
      case "pause":
        outcome = await pauseRule(id, actor);
        break;
      case "archive":
        outcome = await archiveRule(id, actor);
        break;
      case "rollback":
        outcome = await rollbackRule(id, actor);
        break;
      case "reject":
        outcome = await rejectRule(id, typeof body.reason === "string" ? body.reason : "abgelehnt über API", actor);
        break;
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
