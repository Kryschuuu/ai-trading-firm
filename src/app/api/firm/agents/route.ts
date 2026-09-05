import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { guardWrite } from "@/lib/apiAuth";
import { validatePromptInput } from "@/lib/workshop";
import { logAudit } from "@/lib/engine";
import { flagMissedAudit } from "@/lib/auditSink";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";

/**
 * Workshop: system_prompt eines Agenten ohne Terminal ändern (Handbuch 6.3).
 *
 *   PUT /api/firm/agents  { agentId, systemPrompt, expectedVersion }
 *
 * Änderungen wirken sofort — Prompts stehen in der Datenbank, kein Neubau.
 * Guardrails (harte Schicht, riskGuard.ts) sind über diesen Endpunkt
 * absichtlich NICHT erreichbar. Validierung via validatePromptInput
 * (geteilt mit Tests); jede Änderung wird ins audit_log geschrieben.
 *
 * Optimistic Lock (W2, v1.36.24): Der Client sendet die beim Laden gesehene
 * `expectedVersion` mit. Der UPDATE greift nur bei passender Version und
 * inkrementiert sie atomar (`version = version + 1`) — zwei parallele
 * Browser-Edits können sich nicht mehr still überschreiben (last-write-wins).
 * Der Verlierer erhält 409 inklusive aktueller Version zum Neuladen.
 *
 * Audit-Zuverlässigkeit (S1, v1.36.18): Der Audit ist Sicherheitsklasse und
 * wird nicht mehr in einem leeren `catch` entsorgt. Ist `audit_log` nicht
 * erreichbar, übernimmt der persistente Spool (at-least-once); ist auch der
 * nicht schreibbar, bleibt es nicht still — CRITICAL-Journalzeile,
 * Missed-Audit-Zähler und ein `warnings`-Hinweis im Response-Body. Der Prompt
 * wird in diesem Fall trotzdem gespeichert (Trade-off, siehe Kommentar im
 * Handler). Die Response enthält zusätzlich `audit` mit dem Durable-Status.
 */
export async function PUT(req: Request) {
  const denied = guardWrite(req);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Ungültiges JSON im Request-Body." }, { status: 400 });
  }

  const validated = validatePromptInput(raw);
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
  }
  const { agentId, systemPrompt, expectedVersion } = validated.value;

  try {
    const existing = (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
    if (!existing) {
      return NextResponse.json({ ok: false, error: "Agent nicht gefunden." }, { status: 404 });
    }

    // ── W2 (v1.36.24): Optimistic Lock ────────────────────────────────────────
    // Nur die Zeile mit der vom Client gesehenen Version wird aktualisiert und
    // dabei inkrementiert. 0 betroffene Zeilen ⇒ paralleler Editor hat gewonnen
    // (oder die Zeile wurde zwischen Vorab-Lesen und Update geändert) ⇒ 409 mit
    // der aktuellen Version, damit die UI neu lädt statt still zu überschreiben.
    const updated = await db
      .update(agents)
      .set({
        systemPrompt,
        updatedAt: new Date(),
        version: sql`${agents.version} + 1`,
      })
      .where(and(eq(agents.id, agentId), eq(agents.version, expectedVersion)))
      .returning();

    if (updated.length === 0) {
      const current = (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
      return NextResponse.json(
        {
          ok: false,
          error: "Konflikt: Der Prompt wurde inzwischen von jemand anderem geändert.",
          currentVersion: current?.version ?? null,
          hint: "Neu laden und erneut speichern — der fremde Stand ist jetzt eingeblendet.",
        },
        { status: 409 }
      );
    }

    // ── S1 (v1.36.18): dokumentierter Trade-off ──────────────────────────────
    // Prompt-Änderungen sind sicherheitsrelevant: sie verschieben das
    // Entscheidungsverhalten aller folgenden Agenten-Turns. Der Audit-Eintrag
    // läuft deshalb in der Klasse `security` (Retry mit Backoff + persistenter
    // Spool mit at-least-once-Nachzug, siehe src/lib/auditSink.ts).
    //
    // Bewusste Ausnahme von fail-closed: Ist *auch* der Spool nicht schreibbar,
    // wird der Prompt **dennoch gespeichert** und die Lücke stattdessen
    // gemeldet — CRITICAL-Zeile, Missed-Audit-Zähler und Hinweis im Response-
    // Feld `warnings`. Begründung (dokumentierter Trade-off): Der UPDATE ist
    // zu diesem Zeitpunkt bereits wirksam — ein „Abbruch“ nach erfolgreichem
    // UPDATE wäre keine saubere Rücknahme, sondern eine Änderung ohne Beleg.
    // Die Alternative (Prompt-Änderungen bei DB-Degradation sperren) würde
    // Notfall-Patches verunmöglichen. Deshalb: Mutation zu, Lücke nie still.
    const audited = await logAudit("AGENT_PROMPT_UPDATED", "INFO", {
      agent: existing.name,
      role: existing.role,
      oldLength: existing.systemPrompt.length,
      newLength: systemPrompt.length,
      via: "workshop-ui",
    }, undefined, agentId);

    const warnings = [...validated.warnings];
    if (!audited.durable) {
      flagMissedAudit("AGENT_PROMPT_UPDATED", {
        agent: existing.name,
        agentId,
        reason: audited.error ?? "audit nicht durable",
        policy: "prompt gespeichert, audit-loecke gemeldet (S1)",
      });
      warnings.push(
        "Prompt gespeichert, aber der Audit-Eintrag war nicht persistent schreibbar — " +
          "die Lücke ist im Journal (CRITICAL) und im Operations Center gemeldet. " +
          "audit_log manuell ergänzen bzw. Spool-Nachzug prüfen."
      );
    } else if (audited.degraded) {
      warnings.push(
        "Audit nicht sofort in audit_log: Eintrag liegt im persistenten Spool und wird nachgezogen."
      );
    }

    return NextResponse.json({
      ok: true,
      agent: updated[0],
      /** Neue Optimistic-Lock-Version (W2) — nächster PUT muss sie als expectedVersion senden. */
      version: updated[0].version,
      warnings,
      audit: {
        durable: audited.durable,
        target: audited.target,
        degraded: audited.degraded,
        attempts: audited.attempts,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Prompt nicht gespeichert: ${publicErrorMessage(e)}` },
      { status: 503 }
    );
  }
}
