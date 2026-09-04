import { NextResponse } from "next/server";
import { db } from "@/db";
import { killSwitches, missions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { killSwitch } from "@/lib/riskGuard";
import { flattenAll, invalidateBrokerCache, logAudit, type FlattenOutcome } from "@/lib/engine";
import { guardWrite } from "@/lib/apiAuth";
import { actorAuditId, requirePermission } from "@/auth";
import { checkCsrfGuard } from "@/brokers/control-plane/guard";
import { consumeDisarmNonce } from "@/lib/disarmChallenge";
import { flagMissedAudit, isAuditPersistenceError } from "@/lib/auditSink";

export const dynamic = "force-dynamic";

/** Antwort auf fehlerhafte Disarm-Versuche (403, kein Disarm). */
function disarmDenied(error: string, hint: string): Response {
  return Response.json({ ok: false, error, hint }, { status: 403 });
}

/**
 * Not-Halt der gesamten Firma.
 *
 *   { "arm": true,  "flatten": true }  → Kill-Switch ziehen und alles glattstellen
 *   { "arm": false, "nonce": "…" }     → entschärfen (Befund C3, v1.36.15)
 *
 * C3 (Guard-Split): **Arm** geht wie bisher durch `guardWrite(req)`
 * (Operator-Token reicht — Scharfschalten in den sicheren Zustand ist keine
 * Eskalation). **Disarm** (Rückkehr aus dem sicheren Zustand) verlangt:
 *   1. ADMIN-Permission  `live.gate`  (`requirePermission`)
 *   2. CSRF-Header       `x-csrf-token` (`checkCsrfGuard`)
 *   3. gültiger Nonce    aus `GET /api/firm/kill/challenge` — existiert,
 *      nicht abgelaufen (<= 60 s) und single-use (nicht wiederverwendet)
 * Erst danach wird disarmed und ein CRITICAL-Audit mit Actor + Nonce geschrieben.
 * Ein gestohlenes Operator-Token kann damit den Not-Halt NICHT mehr still aufheben.
 *
 * S1 (v1.36.18): Der Disarm-Audit ist **fail-closed** — er wird vor der
 * Mutation mit `stage=PRECHECK` geschrieben; ist weder `audit_log` noch der
 * persistente Spool schreibbar, bleibt der Not-Halt aktiv (503). Nach der
 * Mutation folgt `stage=APPLIED`; fehlt davon nur die DB, meldet der Spool die
 * Nachzugspflicht. Arm dagegen wird nie durch einen Auditfehler blockiert —
 * die sichere Richtung zu verweigern wäre gefährlicher als eine gemeldete Lücke.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    arm?: boolean;
    reason?: string;
    flatten?: boolean;
    nonce?: string;
  };
  const arm = body.arm === true;

  if (arm) {
    // Arm: unverändert Operator-tauglich (guardWrite).
    const denied = guardWrite(req);
    if (denied) return denied;
    const reason = body.reason ?? "MANUAL_OPERATOR";

    // H7 (v1.36.20): Der Not-Halt glattstellt VOR dem Ziehen — erst nach
    // cancel → close → verify gilt der Kill als vollzogen (spec: venue-level
    // sequence BEFORE killSwitch.arm). flattenAll wirft nie (Fehler stehen im
    // Outcome + Audit); die sichere Richtung (Pull) wird dadurch nie blockiert.
    // Paper-Modus: lokales Ledger; Live: echte Venue-Positionen (sobald das
    // Live-Gate freigibt) + Flat-Beweis im Audit.
    let flattenOutcome: FlattenOutcome | null = null;
    if (body.flatten) {
      flattenOutcome = await flattenAll(reason);
    }

    killSwitch.pull(reason);
    await db.insert(killSwitches).values({ reason, triggeredBy: "OPERATOR", armed: true });
    // S1: Scharfschalten ist die SICHERE Richtung. Der Audit ist
    // Sicherheitsklasse (Retry + Spool + Alarm), aber ausdrücklich nicht
    // fail-closed — ein Not-Halt darf niemals an einem Schreibfehler scheitern.
    const audited = await logAudit("KILL_SWITCH", "CRITICAL", {
      reason,
      flatten: body.flatten === true,
      flattenMode: flattenOutcome?.mode,
      flattenVenue: flattenOutcome?.venue,
      flattenClosed: flattenOutcome?.fills.length,
      flattenCanceled: flattenOutcome?.canceled,
      flattenFlat: flattenOutcome?.flat,
      flattenError: flattenOutcome?.error ?? null,
      actor: actorAuditId(req),
    });
    if (!audited.durable) {
      flagMissedAudit("KILL_SWITCH", { reason, action: "arm", detail: audited.error ?? "audit nicht durable" });
    }

    return NextResponse.json({
      ok: true,
      killSwitchArmed: true,
      closedPositions: flattenOutcome?.fills.length ?? 0,
      flatten: flattenOutcome,
      audit: { durable: audited.durable, degraded: audited.degraded, target: audited.target },
    });
  }

  // ── Disarm (C3): ADMIN + CSRF + Nonce ───────────────────────────────────
  const denied = requirePermission(req, "live.gate") ?? checkCsrfGuard(req);
  if (denied) return denied;

  const nonce = typeof body.nonce === "string" ? body.nonce.trim() : "";
  const consume = consumeDisarmNonce(nonce);
  if (consume === "missing")
    return disarmDenied(
      "NONCE_REQUIRED",
      "Disarm erfordert einen Nonce aus GET /api/firm/kill/challenge."
    );
  if (consume === "expired")
    return disarmDenied("NONCE_EXPIRED", "Disarm-Nonce abgelaufen (max. 60 s). Bitte neuen holen.");
  if (consume === "reused")
    return disarmDenied("NONCE_REUSED", "Disarm-Nonce wurde bereits verwendet (single-use).");

  const reason = body.reason ?? "OPERATOR_DISARM";
  const actor = actorAuditId(req);

  // ── S1 (v1.36.18): Disarm ist fail-closed ────────────────────────────────
  // Entschärfen verlässt den sicheren Zustand. Ohne Auditbeleg darf das nicht
  // passieren, sonst ist „wer hat den Not-Halt abgeschaltet“ im Ernstfall
  // unbelegbar. Der Beleg wird deshalb VOR der Mutation geschrieben
  // (stage=PRECHECK, at-least-once) und mit `failClosed` erzwungen: weder
  // `audit_log` noch Spool schreibbar → kein Disarm (HTTP 503).
  // Die doppelte Zeile (PRECHECK + APPLIED) ist dabei Absicht: at-least-once
  // statt exactly-once, weil Verlust teurer ist als ein Duplikat.
  try {
    await logAudit(
      "KILL_SWITCH_DISARMED",
      "CRITICAL",
      { reason, actor, nonceId: nonce, stage: "PRECHECK" },
      undefined,
      undefined,
      { failClosed: true }
    );
  } catch (e) {
    if (isAuditPersistenceError(e)) {
      flagMissedAudit("KILL_SWITCH_DISARMED", {
        reason,
        actor,
        action: "disarm-blocked",
        detail: e.message,
      });
      return NextResponse.json(
        {
          ok: false,
          error: "AUDIT_PERSISTENCE_FAILED",
          message:
            "Not-Halt bleibt aktiv: der Sicherheits-Audit war nicht persistent schreibbar.",
          hint: "PostgreSQL und AUDIT_SPOOL_DIR (Schreibrechte) prüfen — Entschärfen ist ohne Auditbeleg gesperrt.",
        },
        { status: 503 }
      );
    }
    throw e;
  }

  killSwitch.disarm();
  await db.insert(killSwitches).values({ reason, triggeredBy: "OPERATOR", armed: false });
  // Gestoppte Missionen wieder in den Wartezustand versetzen.
  await db
    .update(missions)
    .set({ status: "PENDING", updatedAt: new Date() })
    .where(eq(missions.status, "KILLED"));
  invalidateBrokerCache();
  const audited = await logAudit("KILL_SWITCH_DISARMED", "CRITICAL", {
    reason,
    actor,
    nonceId: nonce,
    stage: "APPLIED",
  });
  if (!audited.durable) {
    // Disarm ist vollzogen und lässt sich nicht sauber zurücknehmen — melden.
    flagMissedAudit("KILL_SWITCH_DISARMED", {
      reason,
      actor,
      action: "disarm-applied",
      detail: audited.error ?? "audit nicht durable",
    });
  }

  return NextResponse.json({
    ok: true,
    killSwitchArmed: false,
    audit: { durable: audited.durable, degraded: audited.degraded, target: audited.target },
  });
}
