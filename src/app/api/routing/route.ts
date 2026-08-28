/**
 * `GET /api/routing` — Routing-Überblick (Task 09).
 *
 * Liefert Policy-Version, Routing-Tabelle (Agent → Modus/Klasse), Modi,
 * Provider-Karten, Budget-Zähler, letzte Entscheidungen und Audit-Auszug.
 * Rein lesend (kein Token nötig), keine Secrets in der Antwort.
 */
import { publicErrorMessage } from "@/lib/secrets";
import { getModelRouter } from "@/routing";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const router = getModelRouter();
    const snapshot = router.snapshot(50);
    return Response.json({
      ok: true,
      policyVersion: snapshot.policyVersion,
      policy: {
        defaultMode: snapshot.policy.defaultMode,
        defaultClass: snapshot.policy.defaultClass,
        agents: snapshot.policy.agents,
        quotaMinPercent: snapshot.policy.quotaMinPercent,
        healthPollerIntervalMs: snapshot.policy.healthPollerIntervalMs,
        classes: Object.fromEntries(
          Object.entries(router.policy.classes).map(([cls, def]) => [
            cls,
            { label: def.label, deployment: def.deployment, providers: def.providers },
          ])
        ),
        escalation: router.policy.escalation,
        budgets: router.policy.budgets,
        fallbackChains: router.policy.fallbackChains,
      },
      modes: snapshot.modes,
      providers: snapshot.providers,
      budget: snapshot.budget,
      lastDecisions: snapshot.lastDecisions,
      audit: snapshot.audit,
      generatedAt: snapshot.generatedAt,
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) },
      { status: 500 }
    );
  }
}
