/**
 * SEC-05 — Serverseitige Akteurs-Attribution für Regel-Lebenszyklus-Aktionen.
 *
 * Vorher übernahmen `POST /api/firm/rules` und `POST /api/firm/rules/[id]` die
 * Audit-Attribution (`by`) sowie die Herkunftsrolle (`sourceRole`) direkt aus
 * dem Request-Body. Jeder Aufrufer mit Schreibrecht konnte damit fremde
 * Akteure in den Audit-Trail schreiben (`{"action":"activate","by":"ADMIN"}`)
 * — der forensische Nachweis, WER eine Strategieänderung ausgelöst hat, war
 * fälschbar.
 *
 * Regel dieses Moduls (Single Source of Truth für Regel-Audit-Akteure):
 *   1. Die Attribution stammt AUSSCHLIESSLICH aus dem authentifizierten
 *      Credential (`resolveAuth` → `actor.auditId`), nie aus dem Body.
 *   2. Client-gelieferte Attributionsfelder werden nicht still ignoriert,
 *      sondern hart mit 400 abgelehnt (fail-closed, laut statt leise): ein
 *      Integrationspartner merkt sofort, dass sein Feld keine Wirkung hat,
 *      statt sich auf eine wirkungslose Attribution zu verlassen.
 *   3. `sourceRole` ist ebenfalls nicht client-steuerbar; API-erzeugte Regeln
 *      sind immer `MANUAL` (interne Erzeuger wie der Makro-Zyklus setzen ihre
 *      Rolle serverseitig beim Aufruf von `sanitizeRuleSpec`).
 */
import { actorAuditId } from "@/auth";

/** Vom Client verbotene Attributionsfelder (Top-Level des Request-Bodys). */
export const CLIENT_FORBIDDEN_ACTOR_FIELDS = ["by", "actor", "sourceRole"] as const;

/** Herkunftsrolle für alle über die öffentliche API erzeugten Regeln. */
export const API_RULE_SOURCE_ROLE = "MANUAL" as const;

/**
 * Audit-Akteur einer Regel-Änderung.
 *
 * Der Wert kommt aus der serverseitigen RBAC-Auflösung (`admin` | `operator` |
 * `viewer`; `admin` im wirksamen `local-open`-Betrieb). Der Guard der Route
 * (`guardWrite`) hat zu diesem Zeitpunkt bereits `firm.write` sichergestellt —
 * hier wird die Identität nur noch für den Audit-Trail abgeleitet.
 */
export function ruleActor(req: Request): string {
  return actorAuditId(req);
}

/**
 * Lehnt Requests ab, die Akteurs-/Rollenattribution mitschicken.
 *
 * Prüft nur eigene Top-Level-Schlüssel (`Object.hasOwn`), damit
 * Prototype-Pollution-Versuche (`{"__proto__":{"by":"ADMIN"}}`) keinen
 * Fehlalarm erzeugen — geerbte Felder werden ohnehin nie gelesen.
 * Rückgabe: `null` = sauber, sonst eine fertige 400-Response.
 */
export function rejectClientActorFields(body: unknown): Response | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;

  const offending = CLIENT_FORBIDDEN_ACTOR_FIELDS.filter((field) =>
    Object.hasOwn(body as Record<string, unknown>, field)
  );
  if (offending.length === 0) return null;

  return Response.json(
    {
      ok: false,
      error: "ACTOR_NOT_CLIENT_CONTROLLED",
      hint:
        `Felder ${offending.join(", ")} sind nicht Teil des API-Vertrags. ` +
        "Die Audit-Attribution wird ausschliesslich aus dem authentifizierten Credential abgeleitet.",
    },
    { status: 400 }
  );
}
