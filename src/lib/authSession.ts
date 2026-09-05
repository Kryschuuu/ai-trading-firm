/**
 * Kurzlebige Browser-Sessions (W1), gehaertet fuer SEC-01 (v1.36.27).
 *
 * `firm_session`: HttpOnly, Secure, SameSite=Strict, 15 Minuten TTL.
 * `firm_csrf`: gleicher zufaelliger Wert wie im signierten Payload fuer
 * session-gebundenes Double-Submit-CSRF. Niemals Login-Tokens im Cookie.
 *
 * Ausschliesslich ein unabhaengiges FIRM_SESSION_SECRET darf signieren.
 * Kein Token-Fallback, auch nicht in Entwicklung. local-open stellt keine
 * Sessions aus. Produktion ohne gueltigen Schluessel verweigert den Boot;
 * der Anfragepfad bleibt unabhaengig davon fail-closed.
 *
 * Schema v2 enthaelt KEINEN Berechtigungs-Snapshot. Ein Credential-Selektor
 * ist an die aktuelle serverseitige Auth-Konfiguration gebunden (authEpoch).
 * Rollen, Elevation, Audit-ID und Permissions werden bei JEDEM Request aus
 * dieser Konfiguration abgeleitet. Rotation/Entfernung/Neueinrichtung eines
 * Tokens invalidiert bestehende Sessions, auch bei konstantem Session-Key.
 * Unveraenderte Konfiguration erlaubt weiterhin stateless Prozess-Neustarts.
 * Alle v1-Cookies sind absichtlich ungueltig: Upgrade erfordert neuen Login.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ADMIN_TOKEN_FLAG,
  OPERATOR_TOKEN_FLAG,
  VIEWER_TOKEN_FLAG,
  isProductionEnv,
  resolveAuthMode,
  sessionSecretConfigurationError,
} from "@/auth/authMode";
import { buildActor } from "@/auth/permissions";
import type { Actor } from "@/auth/types";
import { tokenEquals } from "@/lib/tokenCompare";

export const SESSION_COOKIE = "firm_session";
export const SESSION_CSRF_COOKIE = "firm_csrf";
export const SESSION_TTL_S = 900;
export const SESSION_TTL_MS = SESSION_TTL_S * 1000;

const PAYLOAD_VERSION = 2;
const MAX_SESSION_TOKEN_LENGTH = 4096;
const CREDENTIALS = {
  "admin-token": { flag: ADMIN_TOKEN_FLAG, role: "admin" },
  "api-token": { flag: OPERATOR_TOKEN_FLAG, role: "operator" },
  "viewer-token": { flag: VIEWER_TOKEN_FLAG, role: "viewer" },
} as const;
type SessionCredential = keyof typeof CREDENTIALS;

/** Nur Identitaetsbindung und Lebenszyklus — keine Autorisierungs-Claims. */
export type SessionPayload = {
  v: typeof PAYLOAD_VERSION;
  credential: SessionCredential;
  /** Keyed, domain-separated Bindung an Credential UND aktuelle Auth-Tokens. */
  authEpoch: string;
  csrf: string;
  /** Ausstellungs- und Ablaufzeitpunkt in ms seit Epoch. */
  iat: number;
  exp: number;
};

const PAYLOAD_KEYS = ["v", "credential", "authEpoch", "csrf", "iat", "exp"];

type EnvLike = Record<string, string | undefined>;

export type SessionIssue =
  | {
      ok: true;
      open: boolean;
      /** Leer ausschliesslich bei bewusstem local-open (keine Session). */
      sessionToken: string;
      csrf: string;
      expiresAt: number;
      cookies: string[];
    }
  | { ok: false; error: string; hint: string; status: number };

/** Kein nutzbarer, unabhaengiger Schluessel ⇒ Sessions sind deaktiviert. */
export function sessionSecret(env: EnvLike = process.env): string {
  if (sessionSecretConfigurationError(env)) return "";
  return (env.FIRM_SESSION_SECRET ?? "").trim();
}

function isSessionCredential(value: unknown): value is SessionCredential {
  // Kein Prototyp-Lookup: z. B. "constructor" darf kein Credential werden.
  return typeof value === "string" && Object.hasOwn(CREDENTIALS, value);
}

/**
 * Credential-Version ohne Klartext oder unkeyed Token-Hash im Cookie.
 * Der Selektor ist Teil der Bindung: die Epoche eines Viewers kann nicht fuer
 * ein anderes Credential wiederverwendet werden. Alle Token-Slots zaehlen,
 * insbesondere der Admin-Slot, der Single-Admin-Elevation steuert.
 */
function credentialEpoch(credential: SessionCredential, env: EnvLike, secret: string): string | null {
  if (!env[CREDENTIALS[credential].flag]) return null;
  const material = JSON.stringify([
    credential,
    env[ADMIN_TOKEN_FLAG] ?? "",
    env[OPERATOR_TOKEN_FLAG] ?? "",
    env[VIEWER_TOKEN_FLAG] ?? "",
  ]);
  return createHmac("sha256", secret)
    .update(`aitf-auth-epoch-v${PAYLOAD_VERSION}\x00`)
    .update(material)
    .digest("base64url");
}

function validPayload(value: unknown, now: number): value is SessionPayload {
  if (!Number.isSafeInteger(now) || typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  // Explizites Schema: auch korrekt signierte alte Rollen-/Permission-Claims
  // sind nicht erlaubt und koennen nie zur zweiten Autoritaetsquelle werden.
  const keys = Object.keys(p);
  if (keys.length !== PAYLOAD_KEYS.length || !keys.every((key) => PAYLOAD_KEYS.includes(key))) return false;
  return (
    p.v === PAYLOAD_VERSION &&
    isSessionCredential(p.credential) &&
    typeof p.authEpoch === "string" && /^[A-Za-z0-9_-]{43}$/.test(p.authEpoch) &&
    typeof p.csrf === "string" && /^[a-f0-9]{64}$/.test(p.csrf) &&
    typeof p.iat === "number" && Number.isSafeInteger(p.iat) && p.iat >= 0 && p.iat <= now &&
    typeof p.exp === "number" && Number.isSafeInteger(p.exp) && p.exp > now &&
    p.exp > p.iat && p.exp - p.iat <= SESSION_TTL_MS
  );
}

function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/**
 * Kryptographische/strukturelle Pruefung; wirft bei ungueltigen Cookies nie.
 * KEINE Autorisierung: dafuer muss sessionActor die aktuelle Credential-
 * Bindung pruefen. Request-Guards verwenden readSession, das beides tut.
 */
export function verifySessionToken(
  token: string,
  secret: string,
  now: number = Date.now()
): SessionPayload | null {
  if (!secret || secret.trim().length < 32 || token.length > MAX_SESSION_TOKEN_LENGTH) return null;
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const [, body, sig] = match;
  const got = Buffer.from(sig, "base64url");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  if (got.toString("base64url") !== sig) return null;

  try {
    const bytes = Buffer.from(body, "base64url");
    if (bytes.toString("base64url") !== body) return null;
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    return validPayload(parsed, now) ? parsed : null;
  } catch {
    return null;
  }
}

/** Cookie-Header in name=value-Paare zerlegen. Mehrdeutige Sessions ablehnen. */
function sessionCookie(req: Request): string | null {
  let token: string | null = null;
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0 || part.slice(0, idx).trim() !== SESSION_COOKIE) continue;
    if (token !== null) return null;
    token = part.slice(idx + 1).trim();
  }
  return token;
}

/** Signatur, Schema, Ablauf UND aktuelle Credential-Bindung pruefen. */
export function readSession(
  req: Request,
  env: EnvLike = process.env,
  now: number = Date.now()
): SessionPayload | null {
  const token = sessionCookie(req);
  if (!token) return null;
  const secret = sessionSecret(env);
  if (!secret) return null;
  const payload = verifySessionToken(token, secret, now);
  return payload && sessionActor(payload, env, now) ? payload : null;
}

/**
 * Nur fuer signaturverifizierte Payloads (readSession/verifySessionToken).
 * Niemals Cookie-Permissions kopieren: derselbe serverseitige Rollen-Builder
 * wie fuer Header-Credentials entscheidet. Auch separat aufgerufen werden
 * Schema, Ablauf und Credential-Bindung nochmals fail-closed geprueft.
 */
export function sessionActor(
  payload: SessionPayload,
  env: EnvLike = process.env,
  now: number = Date.now()
): Actor | null {
  if (!validPayload(payload, now)) return null;
  const mode = resolveAuthMode(env);
  if (mode.mode !== "token-required" || mode.invalidValue !== null) return null;
  const secret = sessionSecret(env);
  if (!secret) return null;
  const expectedEpoch = credentialEpoch(payload.credential, env, secret);
  if (!expectedEpoch || !tokenEquals(payload.authEpoch, expectedEpoch)) return null;
  return buildActor(CREDENTIALS[payload.credential].role, "api-session", env);
}

const COOKIE_BASE = "Path=/; Secure; SameSite=Strict";

/**
 * Nur einen serverseitig via Header-Token aufgeloesten Actor delegieren.
 * Sessions selbst duerfen keine neuen Sessions ausstellen (keine unbegrenzte
 * Verlaengerung gestohlener Cookies). local-open wird niemals delegiert.
 */
export function issueSession(
  req: Request,
  actor: Actor,
  env: EnvLike = process.env
): SessionIssue {
  const mode = resolveAuthMode(env);
  if (mode.mode === "local-open" && actor.source === "local-open") {
    return { ok: true, open: true, sessionToken: "", csrf: "", expiresAt: 0, cookies: [] };
  }
  const configError = sessionSecretConfigurationError(env);
  if (configError) {
    return { ok: false, error: configError.code, hint: configError.hint, status: 503 };
  }
  const secret = sessionSecret(env);
  const credential = actor.source;
  const invalidActor: SessionIssue = {
    ok: false,
    error: "SESSION_CREDENTIAL_REQUIRED",
    hint: "Eine Session erfordert ein aktuell verifiziertes Admin-/Operator-/Viewer-Credential. Bitte erneut anmelden.",
    status: 403,
  };
  if (mode.invalidValue !== null || !isSessionCredential(credential)) return invalidActor;
  const authEpoch = credentialEpoch(credential, env, secret);
  if (!authEpoch) return invalidActor;

  // Defense in Depth an der Issue-Grenze: ein inkonsistenter oder veralteter
  // Actor wird nicht signiert. Die Login-Route authentifiziert den Token ohne
  // vorhandene Session-Cookies; Rollenfelder aus dem Request sind wirkungslos.
  const current = buildActor(CREDENTIALS[credential].role, credential, env);
  if (
    actor.role !== current.role || actor.effectiveRole !== current.effectiveRole ||
    actor.elevated !== current.elevated || actor.auditId !== current.auditId ||
    !Array.isArray(actor.permissions) || actor.permissions.length !== current.permissions.length ||
    !current.permissions.every((permission) => actor.permissions.includes(permission))
  ) return invalidActor;

  if (isProductionEnv(env) && new URL(req.url).protocol !== "https:") {
    return {
      ok: false,
      error: "SESSION_HTTPS_REQUIRED",
      hint: "Session-Cookies werden in Produktion nur ueber HTTPS gesetzt. Bitte hinter TLS betreiben (Proxy/Terminator).",
      status: 400,
    };
  }

  const csrf = randomBytes(32).toString("hex");
  const iat = Date.now();
  const exp = iat + SESSION_TTL_MS;
  const payload: SessionPayload = { v: PAYLOAD_VERSION, credential, authEpoch, csrf, iat, exp };
  const sessionToken = signSession(payload, secret);
  return {
    ok: true,
    open: false,
    sessionToken,
    csrf,
    expiresAt: exp,
    cookies: [
      `${SESSION_COOKIE}=${sessionToken}; ${COOKIE_BASE}; HttpOnly; Max-Age=${SESSION_TTL_S}`,
      `${SESSION_CSRF_COOKIE}=${csrf}; ${COOKIE_BASE}; Max-Age=${SESSION_TTL_S}`,
    ],
  };
}
