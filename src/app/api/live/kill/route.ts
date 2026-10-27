/**
 * `GET|POST /api/live/kill` — KILL-SWITCH der Live-Gate-Machine (Task 11, ASA-02).
 *
 * Wirkt aus JEDEM Zustand, sofort: prozesslokale Sperre → persistente
 * Failsafe-Datei → State-Reset auf DISCONNECTED → Audit (hash-verkettet).
 *
 *   GET                 → Einmal-Nonce für `clear` (Admin + CSRF), 60 s TTL.
 *   Body (arm/default):  { action?: "arm", venue? | scope?, reason, confirm: "KILL" }
 *   Body (clear):        { action: "clear", scope?, reason, confirm: "CLEAR_KILL", nonce }
 *
 * ASA-02 — Autorisierung nach AKTION getrennt (vorher pauschal `live.gate`):
 *   - `arm`   → `requirePermission(req, "firm.kill")` (Operator UND Admin) +
 *               CSRF. Der Not-Aus ist die SICHERE Richtung und darf nie an
 *               einer zu strengen Admin-Permission scheitern.
 *   - `clear` → `requirePermission(req, "live.gate")` (nur Admin) + CSRF +
 *               Credential-Rate-Limit + PFLICHT-Nonce via
 *               `consumeKillNonce(body.nonce)` (single-use, 60 s, Replay-Sperre).
 *
 * Der Audit-Akteur stammt aus `actorAuditId(auth.principal)` der verifizierten
 * Auflösung — nie aus ungeprüftem Freitext. Die Bestätigungsphrasen bleiben
 * serverseitig im Service erzwungen. CLI-Notfallpfad: `npm run live:kill`.
 */
import { actorAuditId, requirePermission, resolveAuth } from "@/auth";
import { checkCredentialRateLimit, checkCsrfGuard } from "@/brokers/control-plane/guard";
import { getLiveGateService } from "@/live-gate";
import { LiveGateError, liveGateErrorStatus } from "@/live-gate";
import { consumeKillNonce, issueKillNonce } from "@/lib/killSwitchNonce";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };
/** Hartes Body-Limit (8 KiB) — schützt vor JSON-/Speicher-DoS auf dem Not-Aus. */
const MAX_BODY_BYTES = 8 * 1024;

type ParsedBody = { ok: true; body: Record<string, unknown> } | { ok: false; response: Response };

function jsonError(status: number, error: string, hint?: string): Response {
  return Response.json(
    hint ? { ok: false, error, hint } : { ok: false, error },
    { status, headers: NO_STORE }
  );
}

/**
 * Sicheres JSON-Parsen: Größenprüfung (Content-Length UND tatsächliche Länge)
 * + Typprüfung (flaches Objekt, kein Array/null). Ein kaputtes/zu großes Body
 * wird nie an die Auth- oder Service-Schicht weitergereicht.
 */
async function readKillBody(req: Request): Promise<ParsedBody> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: jsonError(413, "BODY_TOO_LARGE", `Maximal ${MAX_BODY_BYTES} Bytes.`) };
  }
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, response: jsonError(400, "INVALID_BODY") };
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return { ok: false, response: jsonError(413, "BODY_TOO_LARGE", `Maximal ${MAX_BODY_BYTES} Bytes.`) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, response: jsonError(400, "INVALID_JSON") };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, response: jsonError(400, "INVALID_BODY") };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/** Audit-Akteur aus derselben verifizierten Auflösung wie die Permission. */
function auditActor(req: Request): string {
  const auth = resolveAuth(req);
  return auth.ok ? actorAuditId(auth.principal) : "unauthenticated";
}

/**
 * `GET /api/live/kill` — kurzlebige Clear-Challenge (ASA-02).
 * Nur ein Admin darf sie anfordern; Ausgabe enthält nie ein Credential.
 */
export async function GET(req: Request): Promise<Response> {
  const denied = requirePermission(req, "live.gate") ?? checkCsrfGuard(req);
  if (denied) return denied;
  const { nonce, expiresAt } = issueKillNonce();
  return Response.json(
    {
      ok: true,
      nonce,
      expiresAt,
      hint: "Einmal-Nonce für POST /api/live/kill mit action=clear (single-use, 60 s).",
    },
    { headers: NO_STORE }
  );
}

export async function POST(req: Request): Promise<Response> {
  // 1) Body zuerst sicher parsen (Größe + Typ), dann strikt nach Aktion.
  const parsed = await readKillBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const rawAction = body.action;
  if (
    rawAction !== undefined &&
    rawAction !== null &&
    rawAction !== "arm" &&
    rawAction !== "clear"
  ) {
    return jsonError(400, "UNKNOWN_ACTION", 'Erlaubt: action="arm" (Default) | "clear".');
  }
  // Default im Notfallpfad: ARM (kein action-Feld nötig).
  const action: "arm" | "clear" = rawAction === "clear" ? "clear" : "arm";

  // 2) Aktionsspezifische Guards — asymmetrisch und bewusst unterschiedlich.
  const denied =
    action === "clear"
      ? requirePermission(req, "live.gate") ?? checkCsrfGuard(req) ?? checkCredentialRateLimit(req)
      : requirePermission(req, "firm.kill") ?? checkCsrfGuard(req);
  if (denied) return denied;

  try {
    const service = getLiveGateService();
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const confirm = typeof body.confirm === "string" ? body.confirm : undefined;
    const scope = typeof body.scope === "string" ? body.scope : undefined;
    const venue = typeof body.venue === "string" ? body.venue : undefined;
    const actor = auditActor(req);

    if (action === "clear") {
      // 3) ASA-02: Nonce ist PFLICHT. Check-and-consume ist atomar; ein
      //    Replay derselben UUID scheitert an "reused".
      const nonce = typeof body.nonce === "string" ? body.nonce.trim() : "";
      const consumed = consumeKillNonce(nonce);
      if (consumed === "missing") {
        return jsonError(
          400,
          "NONCE_REQUIRED",
          "Clear erfordert eine gültige Einmal-Nonce aus GET /api/live/kill."
        );
      }
      if (consumed === "expired") {
        return jsonError(400, "NONCE_EXPIRED", "Clear-Nonce abgelaufen (60 s). Neue Challenge holen.");
      }
      if (consumed === "reused") {
        return jsonError(403, "NONCE_REPLAYED", "Clear-Nonce wurde bereits verwendet (single-use).");
      }
      const result = await service.clearKill({ scope, actor, reason, confirm });
      return Response.json(result, { status: 200, headers: NO_STORE });
    }

    // ARM: Operator oder Admin. Nonce ist hier ausdrücklich NICHT nötig —
    // der Not-Aus muss ohne Vorlauf gezogen werden können.
    const result = await service.kill({ venue, scope, actor, reason, confirm });
    return Response.json(result, { status: 200, headers: NO_STORE });
  } catch (err) {
    if (err instanceof LiveGateError) {
      return Response.json(
        { ok: false, error: err.code, message: err.message },
        { status: liveGateErrorStatus(err.code), headers: NO_STORE }
      );
    }
    return Response.json(
      {
        ok: false,
        error: "LIVE_GATE_KILL_FAILED",
        message: `Kill-Switch-Aktion fehlgeschlagen: ${(err as Error).message}`,
      },
      { status: 500, headers: NO_STORE }
    );
  }
}
