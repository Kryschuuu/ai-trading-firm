import { NextResponse } from "next/server";
import { sanitizeRuleSpec } from "@/lib/ruleEngine";
import {
  listRules,
  getActiveRules,
  upsertRuleSpec,
  activateRule,
  ruleFeedback,
  listRuleExecutions,
} from "@/lib/ruleService";
import { checkRateLimit } from "@/lib/apiAuth";
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
 *        Akteur zugeschrieben (auch RULE_CREATED).
 * SEC-06: Drafts verlangen strategy.rules.write, die optionale Aktivierung
 *        zusätzlich strategy.rules.activate — geprüft vor jeder Persistenz.
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
  const denied = requirePermission(req, "strategy.rules.write") ?? checkRateLimit(req);
  if (denied) return denied;
  try {
    const parsed: unknown = await req.json().catch(() => null);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: "JSON-Objekt erforderlich" }, { status: 400 });
    }
    const body = parsed as Record<string, unknown>;

    // SEC-05: `by`/`actor`/`sourceRole` sind nicht Teil des API-Vertrags —
    // weder auf Top-Level noch verschachtelt in `rule`.
    const forgedTop = rejectClientActorFields(body);
    if (forgedTop) return forgedTop;
    const forgedNested = rejectClientActorFields(body.rule);
    if (forgedNested) return forgedNested;

    // SEC-06: Auch create-and-activate braucht die Freigabe VOR dem Upsert.
    // Nur ein echtes Boolean ist erlaubt; Truthiness darf keine zweite
    // Interpretation zwischen Autorisierung und Ausführung schaffen.
    if (Object.hasOwn(body, "activate") && typeof body.activate !== "boolean") {
      return NextResponse.json({ ok: false, error: "activate muss ein Boolean sein" }, { status: 400 });
    }
    const activate = body.activate === true;
    if (activate) {
      const activationDenied = requirePermission(req, "strategy.rules.activate");
      if (activationDenied) return activationDenied;
    }

    const input = Object.hasOwn(body, "rule") ? body.rule : body;
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return NextResponse.json({ ok: false, error: "rule muss ein Objekt sein" }, { status: 400 });
    }
    // `forceSourceRole` schließt den Pfad auch dann, wenn die Spezifikation
    // (z. B. über eine kopierte Regel) ein `sourceRole` mitführt.
    const validated = sanitizeRuleSpec(input as Record<string, unknown>, API_RULE_SOURCE_ROLE, { forceSourceRole: true });
    if (!validated.ok) {
      return NextResponse.json(
        { ok: false, errors: validated.errors },
        { status: 422 }
      );
    }
    // Ein Actor für Erstellung UND optionale Freigabe, niemals aus dem Body.
    const actor = ruleActor(req);
    const upsert = await upsertRuleSpec(validated.spec, actor, null, "MANUAL");
    if (!upsert.ok || !upsert.rule) {
      return NextResponse.json(
        { ok: false, error: upsert.error ?? "Speichern fehlgeschlagen" },
        { status: 500 }
      );
    }
    let rule = upsert.rule;
    if (activate) {
      const activated = await activateRule(rule.id, actor);
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
