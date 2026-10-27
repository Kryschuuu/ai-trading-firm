/**
 * ASA-02 — kryptographische Principal-Fingerprints (Vier-Augen-Prinzip).
 *
 * `Actor` beschreibt eine ROLLE (`admin`/`operator`/`viewer`) und ihre
 * Permissions. Für ein echtes Vier-Augen-Prinzip reicht das nicht: zwei
 * Requests mit demselben Operator-Token sind dieselbe Person, zwei Admins mit
 * getrennten Credentials/Sessions sind es nicht. `Principal` ergänzt deshalb
 * einen **opaken, kryptographischen Fingerabdruck** der tatsächlich
 * vorgelegten Identität:
 *
 *   - Header-/Bearer-Credential → HMAC(Server-Secret, Flag + Tokenwert)
 *   - Browser-Session           → HMAC(Server-Secret, Credential + Login-Zeit
 *                                 + CSRF-Wert + authEpoch). Über `renewSession`
 *                                 stabile Teile, damit ein Refresh die
 *                                 Gegenzeichnung nicht entwertet.
 *   - local-open                → `distinct: false` (KEIN unterscheidbarer
 *                                 Principal; Vier-Augen-Freigaben fail-closed).
 *
 * Es werden NIEMALS Tokens, CSRF-Werte oder Session-Cookies im Klartext
 * gespeichert, geloggt oder in API-Responses zurückgegeben — nur der HMAC.
 * Als Schlüssel dient das unabhängige `FIRM_SESSION_SECRET`, falls konfiguriert;
 * sonst ein prozesslokaler Zufallsschlüssel (Pending-Freigaben leben ohnehin
 * nur im Prozess). Token-Rotation ändert den Fingerprint sofort.
 *
 * Blatt-Modul: keine Imports aus `resolve.ts` / `authSession.ts` (Zyklusfrei).
 */
import { createHmac, randomBytes } from "node:crypto";
import type { Actor, ActorSource, Principal, SessionPrincipalClaims } from "./types";

const DOMAIN = "aitf:asa02:principal:v1";
/** Fallback-Schlüssel, wenn kein unabhängiges Session-Secret konfiguriert ist. */
const PROCESS_KEY = randomBytes(32);

function signingKey(env: Record<string, string | undefined>): Buffer | string {
  const secret = (env.FIRM_SESSION_SECRET ?? "").trim();
  return secret.length >= 32 ? secret : PROCESS_KEY;
}

/** Domain-separierter HMAC; Ausgabe ist hex (64 Zeichen), nie ein Klartext. */
function fingerprint(
  parts: readonly string[],
  env: Record<string, string | undefined>
): string {
  return createHmac("sha256", signingKey(env))
    .update(`${DOMAIN}\u0000${parts.join("\u0000")}`)
    .digest("hex");
}

function base(actor: Actor, id: string, distinct: boolean): Principal {
  return {
    id,
    distinct,
    role: actor.role,
    effectiveRole: actor.effectiveRole,
    auditId: actor.auditId,
    source: actor.source,
  };
}

/** Header-/Bearer-Credential: Fingerprint aus Flag + konfiguriertem Tokenwert. */
export function principalFromCredential(input: {
  actor: Actor;
  flag: string;
  token: string;
  env: Record<string, string | undefined>;
}): Principal {
  return base(
    input.actor,
    `cred:${fingerprint([input.flag, input.token], input.env)}`,
    true
  );
}

/**
 * Signierte Browser-Session: `iat` (Anmeldung), `csrf` (zufälliger,
 * refresh-stabiler Session-Wert) und `authEpoch` (Credential-Bindung)
 * identifizieren die Session eindeutig, ohne das Cookie zu kopieren.
 */
export function principalFromSession(input: {
  actor: Actor;
  claims: SessionPrincipalClaims;
  env: Record<string, string | undefined>;
}): Principal {
  const c = input.claims;
  return base(
    input.actor,
    `sess:${fingerprint(
      [c.credential, String(c.iat), c.csrf, c.authEpoch],
      input.env
    )}`,
    true
  );
}

/**
 * Offen-Betrieb ohne Token: Es gibt bewusst KEINEN unterscheidbaren
 * kryptographischen Principal. Vier-Augen-Freigaben müssen hier scheitern.
 */
export function principalFromLocalOpen(actor: Actor): Principal {
  return base(actor, `local-open:${actor.source}`, false);
}

/** Typisierte Quellen-Angabe für Audits (nie der Fingerprint selbst). */
export function describePrincipalSource(source: ActorSource): string {
  return source;
}
