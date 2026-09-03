/**
 * API-Token-Prüfung und Schreib-Rate-Limit für mutierende Endpunkte.
 *
 * Modell (C1, v1.36.13 — Offen-Betrieb ist explizit, nie implizit in Produktion):
 *   - FIRM_API_TOKEN gesetzt    → POST/PUT-Routen verlangen Header `x-firm-token`.
 *     GET bleibt lesbar, damit das Dashboard Status laden kann.
 *   - kein FIRM_API_TOKEN, aber RBAC aktiv ⇒ RBAC entscheidet: ein Actor mit
 *     Permission `firm.write` (Admin-/Operator-Credential) darf schreiben,
 *     ein Viewer nicht. Vorher waren diese Routen offen (Befund C1).
 *   - gar kein Token            → offen **nur** bei wirksamem Modus
 *     `local-open` (Dev-Default ohne NODE_ENV=production oder explizit
 *     `AUTH_MODE=local-open`). In Produktion ohne Token ist der Modus
 *     `token-required`: 401 `AUTH_NOT_CONFIGURED` — zusätzlich verweigert der
 *     Boot-Guard (`src/instrumentation.ts`) den Start ohnehin.
 *
 * Die Modus-Entcheidung liegt in `src/auth/authMode.ts` (SSoT für diesen Guard
 * und die RBAC-Auflösung in `src/auth/resolve.ts`).
 *
 * Vergleich ist timing-safe (crypto.timingSafeEqual) inkl. Längen-Padding,
 * damit Token-Raten nicht über Antwortzeiten messbar wird. Der Server lauscht
 * zusätzlich nur auf 127.0.0.1 — Verteidigung in der Tiefe.
 *
 * Rate-Limit (v1.4.0): In-Memory, pro Client, nur Schreib-Endpunkte.
 *   FIRM_RATE_LIMIT=60   Anfragen / 60 s (Standard)
 *   FIRM_RATE_LIMIT=0    deaktiviert
 */
import { anyTokenConfigured, resolveAuth } from "@/auth/resolve";
import { resolveAuthMode } from "@/auth/authMode";
import { tokenEquals } from "@/lib/tokenCompare";

/** Timing-sicherer Vergleich (Blatt-Modul) — Alias für bestehende Importpfade. */
export { tokenEquals } from "@/lib/tokenCompare";

export function apiTokenEnabled(): boolean {
  return Boolean(process.env.FIRM_API_TOKEN);
}

function unauthorizedNotConfigured(): Response {
  return Response.json(
    {
      ok: false,
      error: "UNAUTHORIZED",
      code: "AUTH_NOT_CONFIGURED",
      hint: "Kein Token konfiguriert und Offen-Betrieb nicht wirksam. FIRM_ADMIN_TOKEN/FIRM_API_TOKEN setzen; lokal-offener Betrieb nur mit AUTH_MODE=local-open ausserhalb der Produktion.",
    },
    { status: 401 }
  );
}

/**
 * Schreib-Guard für POST/PUT. `null` = erlaubt, sonst 401/403-Response.
 *
 * Bewusst **kein** `if (!expected) return null` mehr: das war der Kern von
 * Befund C1 — jede unauthentifizierte Anfrage im Netz hätte schreiben dürfen.
 */
export function checkApiToken(req: Request): Response | null {
  const expected = process.env.FIRM_API_TOKEN;

  if (!expected) {
    const decision = resolveAuthMode();
    if (decision.mode === "local-open") return null; // explizit/Dev konfiguriert
    if (!anyTokenConfigured()) return unauthorizedNotConfigured();
    // RBAC ist eingerichtet (z. B. nur FIRM_ADMIN_TOKEN): die Permission
    // entscheidet, nicht das Fehlen eines Operator-Tokens.
    const resolution = resolveAuth(req);
    if (!resolution.ok) {
      return Response.json(
        { ok: false, error: resolution.error, hint: resolution.hint },
        { status: resolution.status }
      );
    }
    if (resolution.actor.permissions.includes("firm.write")) return null;
    return Response.json(
      {
        ok: false,
        error: "FORBIDDEN",
        hint: "Rolle ohne Permission firm.write — Schreibende Firm-Endpunkte brauchen Operator- oder Admin-Credential.",
      },
      { status: 403 }
    );
  }

  const got = req.headers.get("x-firm-token") ?? "";
  if (tokenEquals(got, expected)) return null;

  return Response.json(
    { ok: false, error: "UNAUTHORIZED", hint: "Fehlender/falscher x-firm-token Header." },
    { status: 401 }
  );
}

// ── Rate-Limit (Prozess-lokal, Single-Node) ──────────────────────────────────

const hits = new Map<string, number[]>();

function clientKey(req: Request): string {
  // Hinter einem Proxy wäre x-forwarded-for spoofbar — der Dienst lauscht
  // standardmäßig nur auf 127.0.0.1, der Header ist dann irrelevant.
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = req.headers.get("x-real-ip")?.trim();
  return fwd || real || "local";
}

export type RateLimitOptions = {
  max?: number;
  windowMs?: number;
  now?: number;
};

/** Nur für Tests: Bucket-Speicher leeren. */
export function resetRateLimiterForTests(): void {
  hits.clear();
}

/**
 * Sliding-Window-Limiter. `max <= 0` deaktiviert (FIRM_RATE_LIMIT=0).
 * Standard: 60 Schreib-Requests / 60 s — Dashboard-Klicks bleiben flüssig,
 * automatisierte Floods werden mit 429 beantwortet.
 */
export function checkRateLimit(req: Request, opts: RateLimitOptions = {}): Response | null {
  const envMax = Number(process.env.FIRM_RATE_LIMIT);
  const max = opts.max ?? (Number.isFinite(envMax) ? envMax : 60);
  if (!Number.isFinite(max) || max <= 0) return null;

  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now();
  const key = clientKey(req);
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    const retryAfter = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
    return Response.json(
      { ok: false, error: "RATE_LIMITED", hint: "Zu viele Schreib-Anfragen, bitte kurz warten." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }
  recent.push(now);
  hits.set(key, recent);
  return null;
}

/** Token-Check + Rate-Limit für POST/PUT. Reihenfolge: Auth zuerst, dann Quota. */
export function guardWrite(req: Request): Response | null {
  return checkApiToken(req) ?? checkRateLimit(req);
}
