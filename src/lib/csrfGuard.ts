/** Shared session-aware Double-Submit CSRF guard for mutating API handlers. */
import { readSession } from "@/lib/authSession";
import { resolveAuth } from "@/auth/resolve";
import { tokenEquals } from "@/lib/tokenCompare";
import { CSRF_HEADER, CSRF_LOCAL_VALUE } from "@/brokers/control-plane/config";

export function expectedCsrfValue(): string {
  return process.env.FIRM_ADMIN_TOKEN ?? process.env.FIRM_API_TOKEN ?? CSRF_LOCAL_VALUE;
}

export function checkCsrfGuard(req: Request): Response | null {
  const got = req.headers.get(CSRF_HEADER) ?? "";
  const session = readSession(req);
  if (session) {
    if (got.length > 0 && tokenEquals(got, session.csrf)) return null;
  } else {
    // Explicit API credentials are not ambient browser credentials: they are
    // unavailable to cross-site form/fetch attackers and remain CSRF-exempt.
    // Their route-level auth guard still validates them independently.
    const headerCredential =
      req.headers.has("x-admin-token") ||
      req.headers.has("x-firm-token") ||
      req.headers.has("x-viewer-token") ||
      req.headers.has("x-api-token") ||
      /^Bearer\s+\S+/i.test(req.headers.get("authorization") ?? "");
    const auth = headerCredential ? resolveAuth(req) : null;
    // Only verified explicit API credentials are exempt. Merely including an
    // empty/forged token header must not turn local-open browser requests into
    // CSRF-exempt writes.
    if (auth?.ok && auth.actor.source !== "local-open") return null;
    if (tokenEquals(got, expectedCsrfValue())) return null;
  }
  return Response.json(
    {
      ok: false,
      error: "CSRF_INVALID",
      hint: `Fehlender/falscher ${CSRF_HEADER}-Header auf mutierendem Endpoint.`,
    },
    { status: 403 }
  );
}
