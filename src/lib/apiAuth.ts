/**
 * API-Token-Prüfung und Schreib-Rate-Limit für mutierende Endpunkte.
 *
 * Modell:
 *   - FIRM_API_TOKEN NICHT gesetzt → lokaler Offen-Betrieb (Standard, Single-User).
 *   - FIRM_API_TOKEN gesetzt      → POST/PUT-Routen verlangen Header `x-firm-token`.
 *     GET bleibt lesbar, damit das Dashboard Status laden kann.
 *
 * Vergleich ist timing-safe (crypto.timingSafeEqual) inkl. Längen-Padding,
 * damit Token-Raten nicht über Antwortzeiten messbar wird. Der Server lauscht
 * zusätzlich nur auf 127.0.0.1 — Verteidigung in der Tiefe.
 *
 * Rate-Limit (v1.4.0): In-Memory, pro Client, nur Schreib-Endpunkte.
 *   FIRM_RATE_LIMIT=60   Anfragen / 60 s (Standard)
 *   FIRM_RATE_LIMIT=0    deaktiviert
 */
import { timingSafeEqual } from "node:crypto";

export function apiTokenEnabled(): boolean {
  return Boolean(process.env.FIRM_API_TOKEN);
}

/** Timing-sicherer Vergleich, der auch bei ungleicher Länge nicht short-circuited. */
export function tokenEquals(got: string, expected: string): boolean {
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(expected, "utf8");
  const n = Math.max(a.length, b.length, 1);
  const pa = Buffer.alloc(n);
  const pb = Buffer.alloc(n);
  a.copy(pa);
  b.copy(pb);
  const lengthOk = a.length === b.length && b.length > 0;
  const bodyOk = timingSafeEqual(pa, pb);
  return lengthOk && bodyOk;
}

export function checkApiToken(req: Request): Response | null {
  const expected = process.env.FIRM_API_TOKEN;
  if (!expected) return null; // Off-Betrieb

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
