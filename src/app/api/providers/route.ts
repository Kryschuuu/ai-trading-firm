/**
 * `GET /api/providers` — Provider-Karten für das Operations Center (Task 09/10).
 *
 * Liefert je Provider die Karten-Daten:
 *   Status (ONLINE/OFFLINE/DEGRADED) · Modell · Kontext · Latenz · Kosten ·
 *   Token-Budget (verbraucht/Deckel/Prozent) · Restkontingent · Klassen-Zuordnung
 *
 * Zusätzlich: Routing-Überblick (Policy-Version, Modi, letzte Entscheidungen,
 * Budget) und der Routing-Audit-Auszug.
 *
 * SICHERHEIT:
 *   - Provider-, Budget- und Routing-Status sind betriebs- und strategie-sensitiv:
 *     `firm.read` ist vor jeder Verarbeitung erforderlich.
 *   - Keine Secrets: Kosten/Modelle/Health only — niemals API-Keys, niemals
 *     Basis-URLs mit Userinfo.
 *   - `?refresh=1` erzwingt eine Health-Prüfung (Admin/UI), Default: Cache.
 *
 * Antwort 200:
 * ```json
 * { "ok": true, "count": 4, "providers": [ { "id": "ollama", "status": "ONLINE",
 *     "model": "qwen2.5:3b-…", "models": [...], "contextSize": 4096,
 *     "latencyMs": 250, "costPer1kIn": 0, "costPer1kOut": 0,
 *     "tokens": { "used": 1200, "budget": 5000000, "percent": 0.02 },
 *     "quotaRestPercent": 100, "classes": ["MODEL_A"], … } ],
 *   "routing": { "policyVersion": "1.0.0", "modes": {…}, "budget": {…} } }
 * ```
 */
import { requirePermission } from "@/auth";
import { publicErrorMessage } from "@/lib/secrets";
import { getModelRouter } from "@/routing";
import { MODEL_CLASSES, PROVIDER_IDS, type ProviderId } from "@/routing/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  // SEC-02: authorize before an optional refresh can contact a provider.
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;

  try {
    const router = getModelRouter();
    const url = new URL(req.url);
    const refresh = url.searchParams.get("refresh") === "1";

    if (refresh) {
      await router.refreshHealth();
    }

    const snapshot = router.snapshot(25);
    const budget = snapshot.budget;

    const providers = PROVIDER_IDS.map((id) => {
      const descriptor = snapshot.providers.find((p) => p.id === id);
      if (!descriptor) return null;
      const usage = budget.providers[id];
      const budgetTokens = Number.isFinite(usage?.tokensPerDay) ? Number(usage.tokensPerDay) : 0;
      const usedTokens = Number.isFinite(usage?.tokens) ? Number(usage.tokens) : 0;
      return {
        id,
        label: descriptor.label,
        deployment: descriptor.deployment,
        status: descriptor.healthStatus.toUpperCase(),
        health: descriptor.healthStatus,
        model: descriptor.defaultModel,
        models: descriptor.models,
        contextSize: descriptor.contextSize,
        latencyMs: descriptor.latencyEma,
        costPer1kIn: descriptor.costPer1kIn,
        costPer1kOut: descriptor.costPer1kOut,
        costPerMTokIn: Number((descriptor.costPer1kIn * 1000).toFixed(4)),
        costPerMTokOut: Number((descriptor.costPer1kOut * 1000).toFixed(4)),
        tokens: {
          used: usedTokens,
          budget: budgetTokens,
          percent: budgetTokens > 0 ? Number(((usedTokens / budgetTokens) * 100).toFixed(2)) : 0,
        },
        costUsdToday: Number(usage?.costUsd ?? 0),
        quotaRestPercent: descriptor.quotaRest,
        capabilities: descriptor.capabilities,
        /** Klassen, in denen dieser Provider laut Policy genutzt wird. */
        classes: MODEL_CLASSES.filter((cls) =>
          router.policy.classes[cls].providers.some((p) => p.provider === (id as ProviderId))
        ),
        lastCheckedAt: descriptor.lastCheckedAt ?? null,
        error: descriptor.error ?? null,
      };
    }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    return Response.json({
      ok: true,
      count: providers.length,
      providers,
      routing: {
        policyVersion: snapshot.policyVersion,
        modes: snapshot.modes,
        quotaMinPercent: snapshot.policy.quotaMinPercent,
        healthPollerIntervalMs: snapshot.policy.healthPollerIntervalMs,
        globalBudget: budget.global,
        lastDecisions: snapshot.lastDecisions,
      },
      audit: snapshot.audit.slice(0, 25),
      generatedAt: snapshot.generatedAt,
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) },
      { status: 500 }
    );
  }
}
