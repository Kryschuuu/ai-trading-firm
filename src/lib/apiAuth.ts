/**
 * API-Token-Prüfung für schreibende Endpunkte.
 *
 * Modell:
 *   - FIRM_API_TOKEN NICHT gesetzt → lokaler Offen-Betrieb (Standard, Single-User).
 *   - FIRM_API_TOKEN gesetzt      → POST/PUT-Routen verlangen Header `x-firm-token`.
 *     GET bleibt lesbar, damit das Dashboard Status laden kann.
 *
 * Vergleich ist timing-safe (crypto.timingSafeEqual), damit Token-Raten nicht
 * über Antwortzeiten messbar wird. Der Server lauscht zusätzlich nur auf
 * 127.0.0.1 — Verteidigung in der Tiefe.
 */
import { timingSafeEqual } from "node:crypto";

export function apiTokenEnabled(): boolean {
  return Boolean(process.env.FIRM_API_TOKEN);
}

export function checkApiToken(req: Request): Response | null {
  const expected = process.env.FIRM_API_TOKEN;
  if (!expected) return null; // Off-Betrieb

  const got = req.headers.get("x-firm-token") ?? "";
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(expected, "utf8");
  const ok =
    a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  if (ok) return null;

  return Response.json(
    { ok: false, error: "UNAUTHORIZED", hint: "Fehlender/falscher x-firm-token Header." },
    { status: 401 }
  );
}
