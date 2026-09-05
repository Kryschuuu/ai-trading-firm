/**
 * W1 (v1.36.23) — serverseitige, kurzlebige Session anstelle von API-Token
 * im Browser.
 *
 * Der Browser bekommt NIE mehr den FIRM_API_TOKEN zu sehen. Stattdessen setzt
 * `POST /api/auth/login` zwei SameSite=Strict-Cookies:
 *
 *   - `firm_session`  (HttpOnly)  — HMAC-SHA256-signiert, stateless, 15 min TTL.
 *     Enthaelt den aufgeloesten Actor (Rolle/Elevation/Permissions) — niemals
 *     einen Token-Wert. Nach Prozess-Neustart bleiben gueltige Sessions
 *     verifizierbar (kein In-Memory-Zustand, kein Registry-Slot noetig).
 *   - `firm_csrf`      (nicht-HttpOnly) — derselbe zufaellige Wert ist DOPPELT
 *     im signierten Payload gespeichert. Das Browser-JS liest den Cookie aus
 *     und echoet ihn in `x-csrf-token` (Double-Submit). Der Server vergleicht
 *     den Header gegen den session-gebundenen Wert — ein gestohlener CSRF-Wert
 *     allein reicht nie (Session-Cookie ist HttpOnly).
 *
 * Signierschluessel: `FIRM_SESSION_SECRET` (optional, Rotation) oder
 * deterministisch aus den konfigurierten Auth-Tokens abgeleitet — Sessions
 * sind nur eine kurzlebige Delegation derselben Rechte, kein neues
 * Geheimnis-Universum. Ohne konfigurierte Tokens (local-open) gibt es keine
 * Sessions (offener Betrieb braucht keine).
 *
 * Cookie-Sicherheit (Befund W1, Punkt 4):
 *   - `Secure` immer — localhost/loopback ist ein sicherer Kontext, Browser
 *     akzeptieren Secure-Cookies dort auch ueber HTTP.
 *   - `SameSite=Strict` gegen Cross-Site-Cookie.
 *   - In Produktion (`NODE_ENV=production`) wird ueber plain-HTTP **keine**
 *     Session gesetzt (fail-closed, Hinweis auf HTTPS).
 *   - `Max-Age=900` (15 min) statt dauerhaftem Secret.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ADMIN_TOKEN_FLAG,
  OPERATOR_TOKEN_FLAG,
  VIEWER_TOKEN_FLAG,
  isProductionEnv,
} from "@/auth/authMode";
import {
  PERMISSIONS,
  type Actor,
  type Permission,
  type Role,
} from "@/auth/types";

export const SESSION_COOKIE = "firm_session";
export const SESSION_CSRF_COOKIE = "firm_csrf";

/** Kurzlebigkeit: 900 s = 15 min (Akzeptanzkriterium W1). */
export const SESSION_TTL_S = 900;
export const SESSION_TTL_MS = SESSION_TTL_S * 1000;

/** Current payload schema version — bricht alte Cookies ab. */
const PAYLOAD_VERSION = 1;

/** Signierter Session-Payload (nie Token-Werte, nie Secrets). */
export type SessionPayload = {
  v: typeof PAYLOAD_VERSION;
  role: Role;
  effectiveRole: Role;
  elevated: boolean;
  auditId: Actor["auditId"];
  /** Wirksame Permissions zum Issue-Zeitpunkt (signiert geschuetzt). */
  permissions: Permission[];
  /** Double-Submit-CSRF: identisch im `firm_csrf`-Cookie. */
  csrf: string;
  /** Ablaufzeitpunkt in ms seit Epoch. */
  exp: number;
};

export type SessionIssue =
  | {
      ok: true;
      open: boolean;
      /** Leer bei `open` (kein Secret abgeleitet). */
      sessionToken: string;
      csrf: string;
      expiresAt: number;
      /** `Set-Cookie`-Zeilen (firm_session + firm_csrf). */
      cookies: string[];
    }
  | { ok: false; error: string; hint: string; status: number };

type EnvLike = Record<string, string | undefined>;

/**
 * Signierschluessel. Bevorzugt `FIRM_SESSION_SECRET`; sonst deterministisch
 * aus den konfigurierten Tokens abgeleitet. Leerer String ⇒ keine Sessions
 * moeglich (local-open-Betrieb ohne Token).
 */
export function sessionSecret(env: EnvLike = process.env): string {
  const override = (env.FIRM_SESSION_SECRET ?? "").trim();
  if (override) return override;
  const material = [env[ADMIN_TOKEN_FLAG], env[OPERATOR_TOKEN_FLAG], env[VIEWER_TOKEN_FLAG]]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\x00");
  if (!material) return "";
  return createHash("sha256")
    .update(`aitf-session-v${PAYLOAD_VERSION}\x00${material}`)
    .digest("base64url");
}

function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function isPermission(value: unknown): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value as string);
}

/** Verifiziert Signatur, Schema und Ablauf. Wirft nie. */
export function verifySessionToken(
  token: string,
  secret: string,
  now: number = Date.now()
): SessionPayload | null {
  const sep = token.indexOf(".");
  if (sep <= 0) return null;
  const body = token.slice(0, sep);
  const sig = token.slice(sep + 1);
  if (!body || !sig) return null;
  const got = Buffer.from(sig, "base64url");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;

  let raw: string;
  let parsed: unknown;
  try {
    raw = Buffer.from(body, "base64url").toString("utf8");
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== PAYLOAD_VERSION) return null;
  if (typeof p.exp !== "number" || !Number.isFinite(p.exp) || p.exp < now) return null;
  if (
    typeof p.role !== "string" ||
    typeof p.effectiveRole !== "string" ||
    typeof p.elevated !== "boolean" ||
    typeof p.auditId !== "string" ||
    typeof p.csrf !== "string" ||
    p.csrf.length === 0 ||
    !Array.isArray(p.permissions) ||
    !p.permissions.every(isPermission)
  ) {
    return null;
  }
  return {
    v: PAYLOAD_VERSION,
    role: p.role as Role,
    effectiveRole: p.effectiveRole as Role,
    elevated: p.elevated,
    auditId: p.auditId as Actor["auditId"],
    permissions: p.permissions as Permission[],
    csrf: p.csrf,
    exp: p.exp,
  };
}

/** Cookie-Header des Requests sicher in `name=value`-Paare zerlegen. */
function cookieEntries(req: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out.set(name, value);
  }
  return out;
}

/**
 * Liest und verifiziert die `firm_session`-Cookie des Requests.
 * Liefert `null` bei fehlendem/ungueltigem/abgelaufenem Token.
 */
export function readSession(
  req: Request,
  env: EnvLike = process.env,
  now: number = Date.now()
): SessionPayload | null {
  const secret = sessionSecret(env);
  if (!secret) return null;
  const token = cookieEntries(req).get(SESSION_COOKIE);
  if (!token) return null;
  return verifySessionToken(token, secret, now);
}

/**
 * Baut den Actor aus einem verifizierten Payload. `source` wird auf
 * `api-session` gesetzt (Audit/Diagnose unterscheidbar von Header-Token).
 */
export function sessionActor(payload: SessionPayload): Actor {
  return {
    role: payload.role,
    effectiveRole: payload.effectiveRole,
    elevated: payload.elevated,
    source: "api-session",
    auditId: payload.auditId,
    permissions: payload.permissions,
  };
}

const COOKIE_BASE = "Path=/; Secure; SameSite=Strict";

function secureCookieLine(name: string, value: string): string {
  return `${name}=${value}; ${COOKIE_BASE}; Max-Age=${SESSION_TTL_S}`;
}

/**
 * Stellt Session-Cookies fuer einen aufgeloesten Actor aus. Fail-closed:
 * Produktion ueber plain-HTTP ⇒ keine Session (Hinweis auf HTTPS).
 */
export function issueSession(
  req: Request,
  actor: Actor,
  env: EnvLike = process.env
): SessionIssue {
  const secret = sessionSecret(env);
  // Open-Betrieb (local-open, kein Token konfiguriert): keine Session noetig.
  if (!secret) {
    return { ok: true, open: true, sessionToken: "", csrf: "", expiresAt: 0, cookies: [] };
  }

  const protocol = new URL(req.url).protocol;
  if (isProductionEnv(env) && protocol !== "https:") {
    return {
      ok: false,
      error: "SESSION_HTTPS_REQUIRED",
      hint: "W1: Session-Cookie ist Secure und wird in Produktion nur ueber HTTPS gesetzt. Bitte hinter TLS betreiben (Proxy/Terminator).",
      status: 400,
    };
  }

  const csrf = randomBytes(32).toString("hex");
  const exp = Date.now() + SESSION_TTL_MS;
  const payload: SessionPayload = {
    v: PAYLOAD_VERSION,
    role: actor.role,
    effectiveRole: actor.effectiveRole,
    elevated: actor.elevated,
    auditId: actor.auditId,
    permissions: [...actor.permissions],
    csrf,
    exp,
  };
  const sessionToken = signSession(payload, secret);
  return {
    ok: true,
    open: false,
    sessionToken,
    csrf,
    expiresAt: exp,
    cookies: [
      `${SESSION_COOKIE}=${sessionToken}; ${COOKIE_BASE}; HttpOnly; Max-Age=${SESSION_TTL_S}`,
      secureCookieLine(SESSION_CSRF_COOKIE, csrf),
    ],
  };
}