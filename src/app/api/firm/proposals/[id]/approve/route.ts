import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { proposals } from "@/db/schema";
import { eq } from "drizzle-orm";
import { logAudit } from "@/lib/engine";
import { flagMissedAudit, isAuditPersistenceError } from "@/lib/auditSink";

/**
 * Next.js >= 15 liefert `params` in Route-Handlern als Promise; seit Next.js 16
 * ist der synchrone Zugriff vollständig entfernt (Breaking Change
 * "Sync params/searchParams props access"). Ohne `await` wäre `params.id`
 * zur Laufzeit `undefined` und jeder Approve-Call würde mit 400
 * "proposal id missing" abbrechen — deshalb hier die Repo-Konvention
 * `RouteContext` (vgl. /api/brokers/[venue]/*, /api/firm/rules/[id]).
 */
type RouteContext = { params: Promise<{ id: string }> };

/**
 * Menschliche Freigabe eines Proposals (H6, v1.36.7) — sicherheitskritischer
 * Pfad: erst mit Freigabe darf der Executor handeln.
 *
 * S1 (v1.36.18): Der Audit ist Sicherheitsklasse und wird erzwungen.
 *   1. `PROPOSAL_APPROVED` mit `stage: "PRECHECK"` wird **vor** dem UPDATE
 *      geschrieben und ist `failClosed`: ist weder `audit_log` noch der
 *      persistente Spool schreibbar, bleibt das Proposal PENDING (503).
 *      Eine Freigabe ohne Beleg wäre untraceable — genau das, was S1 schließt.
 *   2. Nach dem UPDATE folgt `stage: "APPLIED"`; fehlt davon nur die DB, meldet
 *      der Spool den Nachzug (at-least-once), eine Totalverlust-Lücke wird als
 *      Missed-Audit gezählt und CRITICAL geloggt.
 *
 * Nebenbei behoben: `agentId` ist ein FK auf `agents.id` (uuid). Der alte Code
 * schrieb dort den frei textuellen `approvedBy`-Namen hinein — der Insert konnte
 * auf einer echten PostgreSQL damit nie gelingen (22P02), d. h. dieses Audit
 * fehlte **immer**. Der Actor steht jetzt im `detail`, `agentId` bleibt leer.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const body = await request.json().catch(() => ({}));
    const approvedBy = typeof body?.approvedBy === "string" ? body.approvedBy.trim() : "";
    if (!approvedBy || approvedBy.length < 1) {
      return NextResponse.json({ error: "approvedBy (actor) is required" }, { status: 400 });
    }
    const proposalId = id;
    if (!proposalId) {
      return NextResponse.json({ error: "proposal id missing" }, { status: 400 });
    }

    const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
    if (!proposal) {
      return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
    }
    if (proposal.status !== "PENDING") {
      return NextResponse.json({ error: "Proposal is not PENDING", status: proposal.status }, { status: 409 });
    }

    // 1) Auditbeleg VOR der Mutation, fail-closed (S1).
    try {
      await logAudit(
        "PROPOSAL_APPROVED",
        "INFO",
        { proposalId, approvedBy, previousStatus: "PENDING", stage: "PRECHECK" },
        proposal.missionId ?? undefined,
        undefined,
        { failClosed: true }
      );
    } catch (e) {
      if (isAuditPersistenceError(e)) {
        flagMissedAudit("PROPOSAL_APPROVED", { proposalId, approvedBy, action: "approve-blocked" });
        return NextResponse.json(
          {
            error: "AUDIT_PERSISTENCE_FAILED",
            message:
              "Freigabe wurde nicht ausgeführt: der Sicherheits-Audit war nicht persistent schreibbar.",
            hint: "PostgreSQL und AUDIT_SPOOL_DIR (Schreibrechte) prüfen.",
            proposalId,
            status: proposal.status,
          },
          { status: 503 }
        );
      }
      throw e;
    }

    await db.update(proposals).set({
      status: "APPROVED",
      reviewedAt: new Date(),
      reason: proposal.reason ? `${proposal.reason} | Approved by ${approvedBy}` : `Approved by ${approvedBy}`,
    }).where(eq(proposals.id, proposalId));

    // 2) Bestätigungs-Audit nach der Mutation — bei Totalverlust gemeldet, nicht verschluckt.
    const audited = await logAudit(
      "PROPOSAL_APPROVED",
      "INFO",
      { proposalId, approvedBy, previousStatus: "PENDING", stage: "APPLIED" },
      proposal.missionId ?? undefined
    );
    if (!audited.durable) {
      flagMissedAudit("PROPOSAL_APPROVED", {
        proposalId,
        approvedBy,
        action: "approve-applied",
        reason: audited.error ?? "audit nicht durable",
      });
    }

    return NextResponse.json({
      success: true,
      proposalId,
      status: "APPROVED",
      approvedBy,
      audit: { durable: audited.durable, degraded: audited.degraded, target: audited.target },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Internal error" }, { status: 500 });
  }
}
