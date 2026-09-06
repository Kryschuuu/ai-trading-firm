import { NextResponse } from "next/server";
import { sanitizeRuleSpec, type RuleSpecInput } from "@/lib/ruleEngine";
import {
  listRules,
  getActiveRules,
  upsertRuleSpec,
  activateRule,
  ruleFeedback,
  listRuleExecutions,
} from "@/lib/ruleService";
import { guardWrite } from "@/lib/apiAuth";
import { API_RULE_SOURCE_ROLE, rejectClientActorFields, ruleActor } from "@/lib/ruleActor";
import { requirePermission } from "@/auth";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Regelwerk des Makro-Zyklus.
 *
 * GET  → alle Versionen + aktive Regeln + 24h-Feedback + letzte Ausführungen
 * POST → neue Regel (DRAFT) aus einer validierten Spezifikation.
 *        Die Spezifikation wird hier IMMER durch sanitizeRuleSpec() geschleust
 *        (Whitelist + Code-Klemmung) — es gibt keinen Weg, eine unvalidierte
 *        Regel in die DB zu schreiben.
 *
 * SEC-05: Weder die Herkunftsrolle (`sourceRole`) noch die Audit-Attribution
 *        (`by`) sind client-steuerbar. Über die API erzeugte Regeln sind immer
 *        `MANUAL`; eine direkt mitaktivierte Regel wird dem authentifizierten
 *        Akteur zugeschrieben.
 */
export async function GET(req: Request) {
  // SEC-02: active rules, feedback and executions expose the trading strategy.
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  try {
    const [rules, active, feedback, executions] = await Promise.all([
      listRules(),
      getActiveRules(),
      ruleFeedback(),
      listRuleExecutions(undefined, 20),
    ]);
    const summaries = {
      total: rules.length,
      active: active.length,
      draft: rules.filter((r) => r.status === "DRAFT").length,
      paused: rules.filter((r) => r.status === "PAUSED").length,
      superseded: rules.filter((r) => r.status === "SUPERSEDED").length,
      rejected: rules.filter((r) => r.status === "REJECTED").length,
      archived: rules.filter((r) => r.status === "ARCHIVED").length,
    };
    return NextResponse.json({
      ok: true,
      rules,
      active,
      feedback,
      executions,
      summaries,
      timestamp: new Date().toISOString(),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: publicErrorMessage(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const denied = guardWrite(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      rule?: RuleSpecInput;
      activate?: boolean;
    };

    // SEC-05: `by`/`actor`/`sourceRole` sind nicht Teil des API-Vertrags —
    // weder auf Top-Level noch verschachtelt in `rule`.
    const forgedTop = rejectClientActorFields(body);
    if (forgedTop) return forgedTop;
    const forgedNested = rejectClientActorFields(body.rule);
    if (forgedNested) return forgedNested;

    const input = body.rule ?? body;
    // `forceSourceRole` schließt den Pfad auch dann, wenn die Spezifikation
    // (z. B. über eine kopierte Regel) ein `sourceRole` mitführt.
    const validated = sanitizeRuleSpec(input, API_RULE_SOURCE_ROLE, { forceSourceRole: true });
    if (!validated.ok) {
      return NextResponse.json(
        { ok: false, errors: validated.errors },
        { status: 422 }
      );
    }
    const upsert = await upsertRuleSpec(validated.spec, null);
    if (!upsert.ok || !upsert.rule) {
      return NextResponse.json(
        { ok: false, error: upsert.error ?? "Speichern fehlgeschlagen" },
        { status: 500 }
      );
    }
    let rule = upsert.rule;
    if (body.activate) {
      const activated = await activateRule(rule.id, ruleActor(req));
      if (!activated.ok) {
        return NextResponse.json({ ok: false, error: activated.error }, { status: 409 });
      }
      rule = activated.rule;
    }
    return NextResponse.json({
      ok: true,
      rule,
      created: upsert.created,
      changed: upsert.changed,
      reason: upsert.reason,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: publicErrorMessage(e) }, { status: 500 });
  }
}
