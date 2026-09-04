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
 *
 * Client-Identität (C2, v1.36.14): Der Bucket-Schlüssel kommt aus
 * `src/lib/clientIp.ts` (`resolveClientIp`) — `x-forwarded-for`/`x-real-ip`
 * werden NICHT mehr blind übernommen, weil der Client sie selbst setzt und so
 * pro Anfrage einen frischen Bucket erfinden konnte. Identität ist jetzt:
 * proxy-verifizierte IP (`x-verified-ip`, nur bei wirksamem Proxy-Vertrauen),
 * `x-forwarded-for` ausschließlich hinter einem als `TRUSTED_PROXY_IPS`
 * konfigurierten UND per Socket-Adresse verifizierten Peer, sonst die
 * Socket-Remote-Adresse, sonst die Prozess-Konstante `local`.
 */
import { anyTokenConfigured, resolveAuth } from "@/auth/resolve";
import { resolveAuthMode } from "@/auth/authMode";
import { tokenEquals } from "@/lib/tokenCompare";
import { clientRateLimitKey, type ClientIpOptions } from "@/lib/clientIp";
import { state } from "@/lib/stateRegistry";

/** Client-IP-Auflösung (C2) — derselbe Helfer wie in der Control Plane. */
export { resolveClientIp, clientRateLimitKey } from "@/lib/clientIp";

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
// S2: Der Bucket liegt in der zentralen State-Registry (state.rateLimiterHits).

/**
 * Bucket-Schlüssel = geteilte Client-IP-Auflösung (C2, v1.36.14).
 *
 * Vorher stand hier `x-forwarded-for`/`x-real-ip` direkt — client-setzbare
 * Header als Sicherheitsgrenze. Jetzt entscheidet `resolveClientIp()`:
 * ohne konfiguriertes Proxy-Vertrauen (`TRUSTED_PROXY_IPS`) bzw. ohne
 * proxy-gesetztes `x-verified-ip` ist der Schlüssel die Socket-Adresse oder
 * `local`, und ein mitgeschicktes `X-Forwarded-For: 1.2.3.4` ändert nichts.
 */
function clientKey(req: Request, opts: ClientIpOptions = {}): string {
  return clientRateLimitKey(req, opts);
}

export type RateLimitOptions = {
  max?: number;
  windowMs?: number;
  now?: number;
  /**
   * Socket-Remote-Adresse des direkten Peers, falls der Aufrufer sie kennt
   * (eigener Node-Server/Adapter). Im Next.js-App-Router nicht verfügbar —
   * dann trägt `TRUSTED_PROXY_IPS` + `x-verified-ip` die Identität.
   */
  peerIp?: string | null;
};

/** Nur für Tests: Bucket-Speicher leeren. */
export function resetRateLimiterForTests(): void {
  state.rateLimiterHits.clear();
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
  const key = clientKey(req, { peerIp: opts.peerIp });
  const recent = (state.rateLimiterHits.get().get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    const retryAfter = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
    return Response.json(
      { ok: false, error: "RATE_LIMITED", hint: "Zu viele Schreib-Anfragen, bitte kurz warten." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }
  recent.push(now);
  state.rateLimiterHits.get().set(key, recent);
  return null;
}

/** Token-Check + Rate-Limit für POST/PUT. Reihenfolge: Auth zuerst, dann Quota. */
export function guardWrite(req: Request): Response | null {
  return checkApiToken(req) ?? checkRateLimit(req);
}
