import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { proposals } from "@/db/schema";
import { eq } from "drizzle-orm";
import { logAudit } from "@/lib/engine";

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await request.json().catch(() => ({}));
    const approvedBy = typeof body?.approvedBy === "string" ? body.approvedBy.trim() : "";
    if (!approvedBy || approvedBy.length < 1) {
      return NextResponse.json({ error: "approvedBy (actor) is required" }, { status: 400 });
    }
    const proposalId = params.id;
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

    await db.update(proposals).set({
      status: "APPROVED",
      reviewedAt: new Date(),
      reason: proposal.reason ? `${proposal.reason} | Approved by ${approvedBy}` : `Approved by ${approvedBy}`,
    }).where(eq(proposals.id, proposalId));

    await logAudit("PROPOSAL_APPROVED", "INFO", {
      proposalId,
      approvedBy,
      previousStatus: "PENDING",
    }, proposal.missionId ?? undefined, approvedBy);

    return NextResponse.json({ success: true, proposalId, status: "APPROVED", approvedBy });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Internal error" }, { status: 500 });
  }
}
