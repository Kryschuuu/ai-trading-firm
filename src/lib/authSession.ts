/**
 * Browser-Sessions (W1), gehaertet fuer SEC-01 (v1.36.27); Laufzeit-Policy
 * seit v1.39.0: „die Sitzung gilt, bis das Browserfenster geschlossen wird".
 *
 * `firm_session`: HttpOnly, Secure, SameSite=Strict — **ohne** `Max-Age`/
 * `Expires`, also eine echte Browser-Session-Cookie. Der Browser legt sie weg,
 * sobald die Browsersession endet (Fenster/Profil zu). `firm_csrf`: gleicher
 * zufaelliger Wert wie im signierten Payload fuer session-gebundenes
 * Double-Submit-CSRF, identische Laufzeit-Policy. Niemals Login-Tokens im Cookie.
 *
 * ## Autorisierung haengt NIEMALS am Alter des Cookies (Sicherheit)
 *
 * „Cookie weg beim Fenster-Zu" ist nur die halbe Wahrheit. Ob eine Anfrage
 * Rechte bekommt, entscheidet weiterhin der signierte Payload — eng befristet:
 *
 *   - `exp`    Idle-Frist (Default 900 s, `FIRM_SESSION_IDLE_TTL_S`). Ohne
 *              Verlaengerung ist die Session danach abgelaufen, auch wenn das
 *              Cookie im Browser noch existiert (z. B. nach „Sitzung
 *              wiederherstellen").
 *   - `maxExp` absolute Obergrenze seit der Anmeldung (Default 24 h,
 *              `FIRM_SESSION_MAX_LIFE_S`). Wird durch keine Verlaengerung
 *              verschoben — harte Decke gegen unsterbliche Sessions.
 *   - `iat`    Zeitpunkt der ANMELDUNG, ueber alle Verlaengerungen unveraendert.
 *              Davon leitet die globale Revocation (SEC-08) ihren Schnitt ab:
 *              ein Verlaengern waescht einen widerrufenen Login nicht.
 *
 * Verlaengert wird ausschliesslich ueber `POST /api/auth/refresh`
 * (`renewSession`): gueltige Session + Double-Submit-CSRF-Header, nur innerhalb
 * der Idle-Frist oder in der Nachfrist (`FIRM_SESSION_GRACE_S`, Default 900 s —
 * deckt Notebook-Schlafpausen und gedrosselte Hintergrund-Tabs ab), und nie
 * ueber `maxExp` hinaus. `readSession` ignoriert die Nachfrist vollstaendig:
 * ein abgelaufenes Cookie erhaelt auf keiner anderen Route Rechte.
 *
 * Ausschliesslich ein unabhaengiges FIRM_SESSION_SECRET darf signieren.
 * Kein Token-Fallback, auch nicht in Entwicklung. local-open stellt keine
 * Sessions aus. Produktion ohne gueltigen Schluessel verweigert den Boot;
 * der Anfragepfad bleibt unabhaengig davon fail-closed.
 *
 * Schema v3 enthaelt KEINEN Berechtigungs-Snapshot. Ein Credential-Selektor
 * ist an die aktuelle serverseitige Auth-Konfiguration gebunden (authEpoch).
 * Rollen, Elevation, Audit-ID und Permissions werden bei JEDEM Request aus
 * dieser Konfiguration abgeleitet. Rotation/Entfernung/Neueinrichtung eines
 * Tokens invalidiert bestehende Sessions, auch bei konstantem Session-Key —
 * und damit auch jede spaetere Verlaengerung. Unveraenderte Konfiguration
 * erlaubt weiterhin stateless Prozess-Neustarts.
 * Alle Cookies aelterer Schemata (v1/v2) sind absichtlich ungueltig: Das
 * Upgrade auf die Browser-Session-Policy erfordert einmalig neuen Login.
 *
 * SEC-08 (v1.36.35): Zusaetzlich zur Credential-Bindung existiert eine
 * serverseitige Revocation-Registry (RAM, `state` in `lib/stateRegistry.ts`).
 * `readSession`/`sessionActor` pruefen sie fail-closed vor jeder Rechtevergabe;
 * der globale Epochen-Cutoff ist millisekundengenau deterministisch (Sessions
 * NACH dem Schnitt bleiben gueltig, alle davor sind sofort ungueltig).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ADMIN_TOKEN_FLAG,
  anyTokenConfigured,
  OPERATOR_TOKEN_FLAG,
  VIEWER_TOKEN_FLAG,
  isProductionEnv,
  resolveAuthMode,
  sessionSecretConfigurationError,
} from "@/auth/authMode";
import { buildActor } from "@/auth/permissions";
import type { Actor } from "@/auth/types";
import { tokenEquals } from "@/lib/tokenCompare";
import { state } from "@/lib/stateRegistry";

export const SESSION_COOKIE = "firm_session";
export const SESSION_CSRF_COOKIE = "firm_csrf";

/**
 * Standard-Idle-Frist einer Session in Sekunden (`SESSION_TTL_S` bleibt der
 * Name aus W1/SEC-01, damit existierende Importe und Tests stabil bleiben).
 * Wirksam ist `sessionIdleTtlS(env)` — dieser Wert ist nur der Default.
 */
export const SESSION_TTL_S = 900;
export const SESSION_TTL_MS = SESSION_TTL_S * 1000;

/** Absolute Obergrenze ab Anmeldung (Default 24 h), nie verschiebbar. */
export const SESSION_MAX_LIFE_S = 86_400;
/** Nachfrist fuer `POST /api/auth/refresh` nach Ablauf der Idle-Frist. */
export const SESSION_GRACE_S = 900;
/** Verlaengerungsfenster: erneuern, wenn die Idle-Restzeit darunter faellt. */
export const SESSION_RENEW_WINDOW_S = 300;
/**
 * Unterhalb dieser Restlebensdauer lohnt eine Verlaengerung nicht mehr:
 * die neue Generation waere kuerzer als ein Client-Takt und die Sitzung
 * wuerde in einer Schleife aus Mini-Verlaengerungen enden (Default-Deckel:
 * 60 s). Stattdessen endet die Sitzung sauber und der Nutzer meldet sich neu an.
 */
export const SESSION_RENEW_MIN_REMAINING_MS = 60_000;

/** Grenzwerte der Env-Konfiguration — ausserhalb gilt der geklemmte Wert. */
export const SESSION_IDLE_TTL_BOUNDS = { min: 60, max: 86_400 } as const;
export const SESSION_MAX_LIFE_BOUNDS = { min: 600, max: 604_800 } as const;
export const SESSION_GRACE_BOUNDS = { min: 0, max: 86_400 } as const;
/**
 * Harte Decke ueber ALLEN Konfigurationen: kein signierter Payload darf eine
 * Gueltigkeit behaupten, die ueber 7 Tage hinausreicht — auch nicht, wenn
 * `FIRM_SESSION_MAX_LIFE_S` groesser geschrieben wurde als erlaubt.
 */
export const SESSION_ABSOLUTE_LIFE_CEILING_MS = 7 * 86_400 * 1000;

export const SESSION_IDLE_FLAG = "FIRM_SESSION_IDLE_TTL_S";
export const SESSION_MAX_LIFE_FLAG = "FIRM_SESSION_MAX_LIFE_S";
export const SESSION_GRACE_FLAG = "FIRM_SESSION_GRACE_S";

const PAYLOAD_VERSION = 3;
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
  /**
   * Anmeldung in ms seit Epoch. Unveraenderlich — auch ueber alle
   * Verlaengerungen (Grundlage des globalen Revocation-Schnitts, SEC-08).
   */
  iat: number;
  /** Ende der Idle-Frist dieser Cookie-Generation in ms (verschiebbar). */
  exp: number;
  /** Absolute Obergrenze der Sitzung in ms — NIE verschiebbar (v3, v1.39.0). */
  maxExp: number;
};

const PAYLOAD_KEYS = ["v", "credential", "authEpoch", "csrf", "iat", "exp", "maxExp"];

type EnvLike = Record<string, string | undefined>;

/**
 * Lebenszyklus einer Session — dieselbe Projektion fuer Login, Refresh und
 * Status-Anzeige, damit UI und Server nie zwo verschiedene Rechnungen zeigen.
 */
export type SessionLifetime = {
  /** ms seit Epoch: Ende der Idle-Frist dieser Cookie-Generation. */
  expiresAt: number;
  /** ms seit Epoch: absolute Obergrenze der Sitzung (unveraenderlich). */
  maxExpiresAt: number;
  /** Verbleibende Sekunden bis zur Idle-Frist (nie negativ). */
  remainingS: number;
  /** Verbleibende Sekunden bis zur absoluten Grenze (nie negativ). */
  maxLifeRemainingS: number;
  /** Sekunden, nach denen eine Verlaengerung spaetestens sinnvoll ist. */
  renewInS: number;
  /** Wirksame Idle-Frist in Sekunden (aus `FIRM_SESSION_IDLE_TTL_S`). */
  idleTtlS: number;
  /** Wirksame absolute Lebensdauer in Sekunden (`FIRM_SESSION_MAX_LIFE_S`). */
  maxLifeS: number;
  /** Wirksame Nachfrist fuer Verlaengerungen in Sekunden (`FIRM_SESSION_GRACE_S`). */
  graceS: number;
  /**
   * `browser-session` = Cookie OHNE `Max-Age`/`Expires`: der Browser wirft es
   * beim Schließen des Fensters weg. Die Autorisierung endet unabhaengig davon
   * mit der Idle-Frist — das Cookie-Alter ist nie ein Rechtebeweis.
   */
  cookieLifetime: "browser-session";
};

export type SessionIssue =
  | {
      ok: true;
      open: boolean;
      /** Leer ausschliesslich bei bewusstem local-open (keine Session). */
      sessionToken: string;
      csrf: string;
      expiresAt: number;
      lifetime: SessionLifetime;
      cookies: string[];
    }
  | { ok: false; error: string; hint: string; status: number };

/**
 * Ganzzahl-Sekunden aus einer Env-Variable, geclampt. Ein unbrauchbarer Wert
 * (Tippfehler, `0`, `abc`) faellt auf den Default zurueck — niemals auf
 * „unbegrenzt“: fail-closed gilt auch fuer die Laufzeit-Policy.
 */
function envSeconds(
  env: EnvLike,
  flag: string,
  fallback: number,
  bounds: { min: number; max: number }
): number {
  const raw = (env[flag] ?? "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  // `0` ist hier kein „deaktiviert“, sondern ein unbrauchbarer Wert: eine
  // Session ohne Frist waer kein Zustand, den der Server anbietet.
  if (!Number.isFinite(value) || value <= 0) return fallback;
  const seconds = Math.floor(value);
  if (seconds < bounds.min) return bounds.min;
  if (seconds > bounds.max) return bounds.max;
  return seconds;
}

/** Wirksame Idle-Frist in Sekunden (Default 900 = 15 Minuten). */
export function sessionIdleTtlS(env: EnvLike = process.env): number {
  return envSeconds(env, SESSION_IDLE_FLAG, SESSION_TTL_S, SESSION_IDLE_TTL_BOUNDS);
}

/**
 * Wirksame absolute Lebensdauer in Sekunden — mindestens eine Idle-Frist,
 * hoechstens die harte Decke (`SESSION_ABSOLUTE_LIFE_CEILING_MS`).
 */
export function sessionMaxLifeS(env: EnvLike = process.env): number {
  const idle = sessionIdleTtlS(env);
  const configured = envSeconds(env, SESSION_MAX_LIFE_FLAG, SESSION_MAX_LIFE_S, SESSION_MAX_LIFE_BOUNDS);
  const ceilingMs = Math.floor(SESSION_ABSOLUTE_LIFE_CEILING_MS / 1000);
  return Math.min(Math.max(configured, idle), ceilingMs);
}

/**
 * Nachfrist nach Idle-Ablauf, in der `renewSession` noch verlaengern darf.
 * Als einzige der drei Fristen darf sie explizit `0` sein — dann gilt die
 * Idle-Frist hart und ein Inaktivitaetsfenster heilt gar nichts.
 */
export function sessionGraceS(env: EnvLike = process.env): number {
  const raw = (env[SESSION_GRACE_FLAG] ?? "").trim();
  if (!raw) return SESSION_GRACE_S;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return SESSION_GRACE_S;
  const seconds = Math.floor(value);
  return Math.min(Math.max(seconds, SESSION_GRACE_BOUNDS.min), SESSION_GRACE_BOUNDS.max);
}

/**
 * Verlaengerungsfenster: ab dieser Restzeit soll der Client erneuern.
 * Faellt nie groesser aus als die halbe Idle-Frist, sonst erneuert ein
 * 60-s-Ticker bei kurz konfigurierten Sessions in jedem zweiten Takt.
 */
export function sessionRenewWindowS(env: EnvLike = process.env): number {
  const idle = sessionIdleTtlS(env);
  return Math.max(10, Math.min(SESSION_RENEW_WINDOW_S, Math.floor(idle / 2)));
}

export const sessionIdleTtlMs = (env: EnvLike = process.env): number => sessionIdleTtlS(env) * 1000;
export const sessionMaxLifeMs = (env: EnvLike = process.env): number => sessionMaxLifeS(env) * 1000;
export const sessionGraceMs = (env: EnvLike = process.env): number => sessionGraceS(env) * 1000;

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

/**
 * Globaler Revocation-Cutoff (SEC-08) oder null, wenn nie global widerrufen
 * wurde. Nur wohlgeformte, nicht negative Zeitstempel zaehlen; alles andere
 * wird ignoriert (fail-closed bleibt ueber die Einzel-Registry bestehen).
 */
function globalRevocationCutoff(): number | null {
  const cutoff = state.sessionsRevokedBefore.get();
  return typeof cutoff === "number" && Number.isSafeInteger(cutoff) && cutoff >= 0 ? cutoff : null;
}

/**
 * Obergrenze fuer `iat` (SEC-08): der aktuelle Zeitpunkt — bzw. nach einem
 * globalen Widerruf zusaetzlich der Klemmwert `cutoff + 1`, den der Server
 * selbst vergibt (siehe `issueInstant`). `Date.now()` loest nur in ganzen
 * Millisekunden auf: Ohne Klemmung waere eine Session, die in derselben
 * Millisekunde wie `revokeAllSessions()` ausgestellt wird, sofort wieder
 * "widerrufen" (iat <= cutoff). Futuristische Fremd-`iat` bleiben abgewiesen —
 * Payloads sind HMAC-signiert, den Klemmwert kann nur dieser Prozess setzen.
 */
function maxIssuedAt(now: number): number {
  const cutoff = globalRevocationCutoff();
  return cutoff === null ? now : Math.max(now, cutoff + 1);
}

/**
 * Ausstellungszeitpunkt neuer Sessions (SEC-08): immer strikt nach einem
 * bestehenden globalen Cut. Damit gilt deterministisch — unabhaengig von der
 * Millisekunden-Aufloesung der Uhr:
 *   iat <= cutoff  ⇒  Session stammt von VOR dem Schnitt  ⇒  widerrufen
 *   iat  > cutoff  ⇒  Session stammt von NACH dem Schnitt ⇒  gueltig
 */
function issueInstant(now: number = Date.now()): number {
  const cutoff = globalRevocationCutoff();
  return cutoff !== null && now <= cutoff ? cutoff + 1 : now;
}

export type SessionValidityOptions = {
  /**
   * Nachfrist in ms, innerhalb derer ein abgelaufenes `exp` noch durchgeht.
   * Nur der Refresh-Pfad setzt das — `readSession`/Guards bleiben bei 0.
   */
  graceMs?: number;
  /**
   * Konfigurierte absolute Lebensdauer in ms. Wenn ubergeben, verbindlich:
   * ein Payload, der langer behauptet als heute konfiguriert, ist ungueltig
   * (fail-closed bei Konfigurations-Verschaerfung). Der Aufrufer ohne `env`
   * prueft trotzdem immer gegen die harte Decke.
   */
  maxLifeMs?: number;
};

/** Struktur-/Signaturzeit-Grenze eines Payloads — ohne Credential-Bindung. */
function validPayload(
  value: unknown,
  now: number,
  opts: SessionValidityOptions = {}
): value is SessionPayload {
  if (!Number.isSafeInteger(now) || typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  // Explizites Schema: auch korrekt signierte alte Rollen-/Permission-Claims
  // sind nicht erlaubt und koennen nie zur zweiten Autoritaetsquelle werden.
  const keys = Object.keys(p);
  if (keys.length !== PAYLOAD_KEYS.length || !keys.every((key) => PAYLOAD_KEYS.includes(key))) return false;
  // Negative/NaN-Nachfrist zaehlt nicht: Nur ein echtes, endliches Polster
  // lockert die Idle-Frist — und auch dann nie die absolute Grenze.
  const graceMs =
    typeof opts.graceMs === "number" && Number.isSafeInteger(opts.graceMs) && opts.graceMs > 0
      ? opts.graceMs
      : 0;
  const ceilingMs = Math.floor(SESSION_ABSOLUTE_LIFE_CEILING_MS);
  const maxLifeMs =
    typeof opts.maxLifeMs === "number" && Number.isSafeInteger(opts.maxLifeMs) && opts.maxLifeMs > 0
      ? Math.min(opts.maxLifeMs, ceilingMs)
      : ceilingMs;
  return (
    p.v === PAYLOAD_VERSION &&
    isSessionCredential(p.credential) &&
    typeof p.authEpoch === "string" && /^[A-Za-z0-9_-]{43}$/.test(p.authEpoch) &&
    typeof p.csrf === "string" && /^[a-f0-9]{64}$/.test(p.csrf) &&
    typeof p.iat === "number" && Number.isSafeInteger(p.iat) && p.iat >= 0 && p.iat <= maxIssuedAt(now) &&
    typeof p.exp === "number" && Number.isSafeInteger(p.exp) && p.exp > now - graceMs &&
    // Die Idle-Frist einer Generation ueberschreitet nie die groesstmuegliche
    // Frist, und die absolute Grenze liegt immer hinter ihr.
    p.exp > p.iat && p.exp - now <= SESSION_IDLE_TTL_BOUNDS.max * 1000 &&
    typeof p.maxExp === "number" && Number.isSafeInteger(p.maxExp) &&
    p.maxExp > now && p.maxExp >= p.exp && p.maxExp > p.iat &&
    p.maxExp - p.iat <= maxLifeMs
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
 *
 * `opts.graceMs` ist ausschliesslich fuer den Refresh-Pfad gedacht — jede
 * andere Nutzung des Rueckgabewerts (Autorisierung!) muss `readSession` sein.
 */
export function verifySessionToken(
  token: string,
  secret: string,
  now: number = Date.now(),
  opts: SessionValidityOptions = {}
): SessionPayload | null {
  const verified = inspectSessionToken(token, secret, now, opts);
  return verified.state === "valid" ? verified.payload : null;
}

/**
 * Signaturpruefung mit Unterscheidung der Ablehnungsgruende. Der Grund wird
 * ausschliesslich gegenueber dem eigenen Browser des Aufrufers projiziert
 * (`GET /api/auth/status`), niemals als Autorisierung verwendet — und ohne
 * gueltige Signatur gibt es ueberhaupt keinen Grund, nur „invalid“.
 */
export type SessionInspection =
  | { state: "valid"; payload: SessionPayload }
  | { state: "missing" | "invalid" | "expired" | "max-life" | "revoked"; payload: SessionPayload | null };

export function inspectSessionToken(
  token: string,
  secret: string,
  now: number = Date.now(),
  opts: SessionValidityOptions = {}
): SessionInspection {
  if (!token) return { state: "missing", payload: null };
  if (!secret || secret.trim().length < 32 || token.length > MAX_SESSION_TOKEN_LENGTH) {
    return { state: "invalid", payload: null };
  }
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return { state: "invalid", payload: null };
  const [, body, sig] = match;
  const got = Buffer.from(sig, "base64url");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { state: "invalid", payload: null };
  if (got.toString("base64url") !== sig) return { state: "invalid", payload: null };

  let parsed: unknown = null;
  try {
    const bytes = Buffer.from(body, "base64url");
    if (bytes.toString("base64url") !== body) return { state: "invalid", payload: null };
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { state: "invalid", payload: null };
  }
  if (typeof parsed !== "object" || parsed === null) return { state: "invalid", payload: null };

  // Nur strukturell wohlgeformte Payloads werden nach Gruenden unterschieden.
  // Eine gueltige Signatur ist dafuer Pflicht — die Details bleiben also ein
  // Spiegel des eigenen Cookies, kein Oracle ueber Fremd-Tokens.
  const candidate = parsed as SessionPayload;
  const wellformed =
    candidate.v === PAYLOAD_VERSION &&
    isSessionCredential(candidate.credential) &&
    typeof candidate.authEpoch === "string" &&
    typeof candidate.csrf === "string" &&
    [candidate.iat, candidate.exp, candidate.maxExp].every(
      (v) => typeof v === "number" && Number.isSafeInteger(v)
    );
  if (!wellformed) return { state: "invalid", payload: null };
  // Widerruf vor allen Zeitfragen: ein Logout oder Notfallschnitt (SEC-08) ist
  // die Aussage, die dem Betreiber am schnellsten weiterhilft — und sie gilt
  // auch dann, wenn die Frist der letzten Generation formal noch laeuft.
  if (isSessionRevoked(candidate, now)) return { state: "revoked", payload: candidate };
  if (validPayload(parsed, now, opts)) return { state: "valid", payload: candidate };
  if (candidate.maxExp <= now) return { state: "max-life", payload: candidate };
  if (candidate.exp <= now) return { state: "expired", payload: candidate };
  return { state: "invalid", payload: null };
}

/** Cookie-Header in name=value-Paare zerlegen. Mehrdeutige Sessions ablehnen. */
export function sessionCookieToken(req: Request): string | null {
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
  const token = sessionCookieToken(req);
  if (!token) return null;
  const secret = sessionSecret(env);
  if (!secret) return null;
  // Bewusst OHNE graceMs: ein abgelaufenes Cookie autorisiert nirgendwo.
  const payload = verifySessionToken(token, secret, now);
  if (!payload || isSessionRevoked(payload, now)) return null;
  return sessionActor(payload, env, now) ? payload : null;
}

/**
 * Nur fuer signaturverifizierte Payloads (readSession/verifySessionToken).
 * Niemals Cookie-Permissions kopieren: derselbe serverseitige Rollen-Builder
 * wie fuer Header-Credentials entscheidet. Auch separat aufgerufen werden
 * Schema, Ablauf, Revocation-Status und Credential-Bindung nochmals fail-closed geprueft.
 *
 * `opts` erlaubt dem Refresh-Pfad, die Idle-Frist mit Nachfrist zu bewerten;
 * die absolute Grenze `maxExp` und die Credential-Bindung gelten immer strikt.
 */
export function sessionActor(
  payload: SessionPayload,
  env: EnvLike = process.env,
  now: number = Date.now(),
  opts: SessionValidityOptions = {}
): Actor | null {
  if (!validPayload(payload, now, { ...opts, maxLifeMs: sessionMaxLifeMs(env) })) return null;
  if (isSessionRevoked(payload, now)) return null;
  const mode = resolveAuthMode(env);
  if (mode.mode !== "token-required" || mode.invalidValue !== null) return null;
  const secret = sessionSecret(env);
  if (!secret) return null;
  const expectedEpoch = credentialEpoch(payload.credential, env, secret);
  if (!expectedEpoch || !tokenEquals(payload.authEpoch, expectedEpoch)) return null;
  return buildActor(CREDENTIALS[payload.credential].role, "api-session", env);
}

/**
 * Prueft, ob eine Session serverseitig widerrufen wurde (SEC-08).
 * Beruecksichtigt sowohl individuelle Session-Revocations als auch globale Epochen-Schnitte.
 * Raeumt abgelaufene Eintraege automatisch auf (Memory-Hygiene).
 */
export function isSessionRevoked(payload: SessionPayload, now: number = Date.now()): boolean {
  const cutoff = globalRevocationCutoff();
  if (cutoff !== null && payload.iat <= cutoff) {
    return true;
  }
  const map = state.revokedSessions.get();
  const exp = map.get(payload.csrf);
  if (exp !== undefined) {
    if (now >= exp) {
      map.delete(payload.csrf);
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Widerruft eine einzelne Session serverseitig vor Ablauf ihrer Laufzeit
 * (SEC-08). Akzeptiert ein SessionPayload-Objekt oder einen signierten
 * Session-Token-String.
 *
 * Registriert wird die Session-Identitaet (`csrf`) bis zu ihrer ABSOLUTEN
 * Grenze `maxExp` — nicht bis zur Idle-Frist der aktuell gesehenen
 * Cookie-Generation. Sonst koennte eine aeltere Generation mit kleinerem
 * `exp` den Registereintrag geraumt haben, waehrend eine juengere Generation
 * desselben Cookies noch lief (v1.39.0: Verlaengerungen verschieben `exp`).
 */
export function revokeSession(
  session: SessionPayload | string,
  now: number = Date.now()
): boolean {
  const record = (csrf: string, expiresAt: number): boolean => {
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
    state.revokedSessions.get().set(csrf, expiresAt);
    return true;
  };
  if (typeof session === "string") {
    const match = /^([A-Za-z0-9_-]+)\./.exec(session.trim());
    if (!match) return false;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
      const p = parsed as Partial<SessionPayload> | null;
      if (
        typeof p === "object" &&
        p !== null &&
        typeof p.csrf === "string" &&
        typeof p.exp === "number"
      ) {
        // `maxExp` fehlt bei Payloads vor v3: dann gilt die bekannte Frist.
        const until =
          typeof p.maxExp === "number" && Number.isSafeInteger(p.maxExp) && p.maxExp > p.exp
            ? p.maxExp
            : p.exp;
        return record(p.csrf, until);
      }
    } catch {
      return false;
    }
    return false;
  }

  if (
    typeof session === "object" &&
    session !== null &&
    typeof session.csrf === "string" &&
    typeof session.exp === "number"
  ) {
    const until =
      typeof session.maxExp === "number" &&
      Number.isSafeInteger(session.maxExp) &&
      session.maxExp > session.exp
        ? session.maxExp
        : session.exp;
    return record(session.csrf, until);
  }
  return false;
}

/**
 * Widerruft alle bis zu diesem Zeitpunkt ausgestellten Sessions global
 * (Admin-Notfall/Epochen-Schnitt, SEC-08).
 *
 * Der Cutoff ist streng monoton: Zwei Schnitte innerhalb derselben
 * Millisekunde schreiben nicht denselben Wert, sonst wuerde eine zwischen
 * beiden Schnitten ausgestellte Session (iat = cutoff + 1) den zweiten Schnitt
 * ueberleben. Ebenso kann ein rueckwaerts springender Systemtakt einen einmal
 * gesetzten Cut nicht wieder aufheben (kein Fail-Open durch Clock-Skew).
 */
export function revokeAllSessions(now: number = Date.now()): void {
  const instant = Number.isSafeInteger(now) && now >= 0 ? now : Date.now();
  const previous = globalRevocationCutoff();
  const cutoff = previous === null ? instant : Math.max(instant, previous + 1);
  state.sessionsRevokedBefore.set(cutoff);
  // Einzel-Revocations, deren natuerliche TTL vor dem Schnitt endet, sind durch
  // den globalen Cut laengst abgedeckt (iat <= exp <= cutoff) — raus damit.
  const map = state.revokedSessions.get();
  for (const [key, exp] of map.entries()) {
    if (exp <= cutoff) map.delete(key);
  }
}

/**
 * Bereinigt abgelaufene Eintraege aus der Revocation-Registry.
 */
export function pruneRevokedSessions(now: number = Date.now()): number {
  const map = state.revokedSessions.get();
  let pruned = 0;
  for (const [key, exp] of map.entries()) {
    if (exp <= now) {
      map.delete(key);
      pruned++;
    }
  }
  return pruned;
}

/**
 * Liefert Set-Cookie-Header zum sicheren Loeschen der Browser-Session-Cookies.
 */
export function clearSessionCookies(): string[] {
  return [
    `${SESSION_COOKIE}=; ${COOKIE_BASE}; HttpOnly; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    `${SESSION_CSRF_COOKIE}=; ${COOKIE_BASE}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  ];
}

/**
 * Set-Cookie fuer eine Session-Generation.
 *
 * bewusst OHNE `Max-Age`/`Expires`: Das ist der Mechanismus, der die Sitzung
 * „bis zum Schließen des Browserfensters" tragt — der Browser behandelt sie als
 * Browsersession-Cookie und verwirft sie beim Session-Ende. Die Autorisierung
 * laeuft unabhaengig davon nach `exp` (Idle) spaetestens nach `maxExp` (absolut)
 * ab, ein langlebiges Cookie ist also nie ein langlebiges Recht.
 */
function sessionCookieHeaders(sessionToken: string, csrf: string): string[] {
  return [
    `${SESSION_COOKIE}=${sessionToken}; ${COOKIE_BASE}; HttpOnly`,
    `${SESSION_CSRF_COOKIE}=${csrf}; ${COOKIE_BASE}`,
  ];
}

const COOKIE_BASE = "Path=/; Secure; SameSite=Strict";

/** Zeitprojektion eines gueltigen Payloads — Anzeige und Taktsteuerung. */
export function sessionLifetime(
  payload: SessionPayload,
  env: EnvLike = process.env,
  now: number = Date.now()
): SessionLifetime {
  const idleTtlS = sessionIdleTtlS(env);
  const remainingS = Math.max(0, Math.floor((payload.exp - now) / 1000));
  const maxLifeRemainingS = Math.max(0, Math.floor((payload.maxExp - now) / 1000));
  const windowS = sessionRenewWindowS(env);
  return {
    expiresAt: payload.exp,
    maxExpiresAt: payload.maxExp,
    remainingS,
    maxLifeRemainingS,
    // Erneuern, bevor die Idle-Frist unter `windowS` faellt; mindestens in 15 s,
    // damit ein Ticker nicht in eine Schleife aus 1:1-Erneuerungen gerat.
    renewInS: Math.max(15, remainingS - windowS),
    idleTtlS,
    maxLifeS: sessionMaxLifeS(env),
    graceS: sessionGraceS(env),
    cookieLifetime: "browser-session",
  };
}

type MintResult =
  | { ok: true; sessionToken: string; csrf: string; lifetime: SessionLifetime; cookies: string[] }
  | { ok: false; error: string; hint: string; status: number };

/**
 * Gemeinsamer Kern von Ausstellung und Verlaengerung. Bewusst privat: er kennt
 * weder Actor-Claims noch Request-Felder, sondern nur das serverseitig
 * Aufgeloeste Credential und die Zeitbasis. `renewal` verschiebt ausschliesslich
 * die Idle-Frist — `iat` (Anmeldung) und `maxExp` (absolute Grenze) bleiben.
 */
function mintSession(
  req: Request,
  credential: SessionCredential,
  env: EnvLike,
  renewal: { iat: number; maxExp: number; csrf: string } | null,
  now: number
): MintResult {
  const configError = sessionSecretConfigurationError(env);
  if (configError) {
    return { ok: false, error: configError.code, hint: configError.hint, status: 503 };
  }
  const secret = sessionSecret(env);
  const authEpoch = credentialEpoch(credential, env, secret);
  if (!authEpoch) {
    return {
      ok: false,
      error: "SESSION_CREDENTIAL_REQUIRED",
      hint: "Eine Session erfordert ein aktuell verifiziertes Admin-/Operator-/Viewer-Credential. Bitte erneut anmelden.",
      status: 403,
    };
  }
  if (isProductionEnv(env) && new URL(req.url).protocol !== "https:") {
    return {
      ok: false,
      error: "SESSION_HTTPS_REQUIRED",
      hint: "Session-Cookies werden in Produktion nur ueber HTTPS gesetzt. Bitte hinter TLS betreiben (Proxy/Terminator).",
      status: 400,
    };
  }

  // Verlaengerung: Identitaet (csrf) und Zeitbasis (iat/maxExp) bleiben, nur
  // die Idle-Frist dieser Generation rueckt. Neue Session: alles frisch.
  const csrf = renewal?.csrf ?? randomBytes(32).toString("hex");
  // SEC-08: strikt nach einem globalen Revocation-Cutoff datieren, damit ein
  // Login in derselben Millisekunde wie `revokeAllSessions()` nicht sofort
  // wieder als widerrufen gilt (siehe `issueInstant`).
  const iat = renewal?.iat ?? issueInstant(now);
  const maxExp = renewal?.maxExp ?? iat + sessionMaxLifeMs(env);
  // Idle-Frist immer ab JETZT (Verlaengerung) bzw. ab Anmeldung (frischer
  // Login) — der absolute Deckel `maxExp` wird nie ueberschritten.
  const deadlineBase = renewal ? now : iat;
  const exp = Math.min(deadlineBase + sessionIdleTtlMs(env), maxExp);
  // Fail-closed: eine Generation, die nicht in die Zukunft reicht, wird nicht
  // signiert (das kann nur bei einer Verlaengerung nahe `maxExp` passieren).
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(maxExp) || maxExp <= iat || exp <= now || exp > maxExp) {
    return {
      ok: false,
      error: "SESSION_MAX_LIFE_REACHED",
      hint: `Die absolute Sitzungsdauer (${sessionMaxLifeS(env)} s seit Anmeldung) ist erreicht. Bitte erneut anmelden.`,
      status: 401,
    };
  }
  const payload: SessionPayload = { v: PAYLOAD_VERSION, credential, authEpoch, csrf, iat, exp, maxExp };
  const sessionToken = signSession(payload, secret);
  return {
    ok: true,
    sessionToken,
    csrf,
    lifetime: sessionLifetime(payload, env, now),
    cookies: sessionCookieHeaders(sessionToken, csrf),
  };
}

/**
 * Anmeldung: stellt eine neue Browser-Session aus.
 *
 * Nur ein serverseitig via Credential-Header aufgeloester Actor wird
 * delegiert — eine bestehende Session kann hier NIE Verlaengerung oder
 * Rechte nachreichen (dafuer gibt es `renewSession`, das an `maxExp` gebunden
 * ist). local-open wird niemals delegiert. `now` ist nur fuer Tests
 * injizierbar; es wird nie aus einem Request gelesen.
 */
export function issueSession(
  req: Request,
  actor: Actor,
  env: EnvLike = process.env,
  now: number = Date.now()
): SessionIssue {
  const mode = resolveAuthMode(env);
  if (mode.mode === "local-open" && actor.source === "local-open") {
    return {
      ok: true,
      open: true,
      sessionToken: "",
      csrf: "",
      expiresAt: 0,
      lifetime: emptyLifetime(env, now),
      cookies: [],
    };
  }
  const configError = sessionSecretConfigurationError(env);
  if (configError) {
    return { ok: false, error: configError.code, hint: configError.hint, status: 503 };
  }
  const credential = actor.source;
  if (mode.invalidValue !== null || !isSessionCredential(credential)) {
    return {
      ok: false,
      error: "SESSION_CREDENTIAL_REQUIRED",
      hint: "Eine Session erfordert ein aktuell verifiziertes Admin-/Operator-/Viewer-Credential. Bitte erneut anmelden.",
      status: 403,
    };
  }

  // Defense in Depth an der Issue-Grenze: ein inkonsistenter oder veralteter
  // Actor wird nicht signiert. Die Login-Route authentifiziert den Token ohne
  // vorhandene Session-Cookies; Rollenfelder aus dem Request sind wirkungslos.
  const current = buildActor(CREDENTIALS[credential].role, credential, env);
  if (
    actor.role !== current.role || actor.effectiveRole !== current.effectiveRole ||
    actor.elevated !== current.elevated || actor.auditId !== current.auditId ||
    !Array.isArray(actor.permissions) || actor.permissions.length !== current.permissions.length ||
    !current.permissions.every((permission) => actor.permissions.includes(permission))
  ) {
    return {
      ok: false,
      error: "SESSION_CREDENTIAL_REQUIRED",
      hint: "Eine Session erfordert ein aktuell verifiziertes Admin-/Operator-/Viewer-Credential. Bitte erneut anmelden.",
      status: 403,
    };
  }

  const minted = mintSession(req, credential, env, null, now);
  if (!minted.ok) return { ok: false, error: minted.error, hint: minted.hint, status: minted.status };
  return {
    ok: true,
    open: false,
    sessionToken: minted.sessionToken,
    csrf: minted.csrf,
    expiresAt: minted.lifetime.expiresAt,
    lifetime: minted.lifetime,
    cookies: minted.cookies,
  };
}

/** Lebensdauer-Projektion fuer „keine Session“ (local-open, abgelehnter Login). */
export function emptyLifetime(env: EnvLike = process.env, now: number = Date.now()): SessionLifetime {
  return {
    expiresAt: 0,
    maxExpiresAt: 0,
    remainingS: 0,
    maxLifeRemainingS: 0,
    renewInS: 0,
    idleTtlS: sessionIdleTtlS(env),
    maxLifeS: sessionMaxLifeS(env),
    graceS: sessionGraceS(env),
    cookieLifetime: "browser-session",
  };
}

/**
 * Verlaengert eine bestehende Browser-Session (v1.39.0, S1).
 *
 * Regeln — alle fail-closed:
 *   - nur eine signierte, nicht widerrufene Session mit passender
 *     Credential-Bindung (`sessionActor`) wird verlaengert;
 *   - Verlaengerung nur, wenn die Idle-Frist laeuft ODER die Nachfrist
 *     (`FIRM_SESSION_GRACE_S`) noch nicht um ist — letztere allein fuer diesen
 *     Endpunkt, niemals fuer die Autorisierung anderer Routen;
 *   - `maxExp` (absolute Obergrenze) wird nie verschoben;
 *   - außerhalb des Verlaengerungsfensters passiert nichts (kein Cookie,
 *     keine Signaturarbeit pro Anfrage) — die Antwort nennt die Restzeit.
 *
 * Der Double-Submit-CSRF-Header wird in dieser Funktion geprueft (nicht in der
 * Route) — wer verlaengern will, kann die Pruefung nicht vergessen.
 */
export type SessionRenewal =
  | {
      ok: true;
      /** true = neues Cookie gesetzt, false = noch gueltig, nichts zu tun. */
      renewed: boolean;
      open: boolean;
      actor: Actor | null;
      lifetime: SessionLifetime;
      cookies: string[];
    }
  | { ok: false; error: string; hint: string; status: number; lifetime?: SessionLifetime };

export function renewSession(
  req: Request,
  env: EnvLike = process.env,
  now: number = Date.now()
): SessionRenewal {
  // Der Double-Submit-Wert kommt aus dem Request, nicht aus einem Parameter:
  // ein Aufrufer kann die Pruefung so nicht versehentlich abschalten.
  const csrfToken = req.headers.get("x-csrf-token") ?? "";
  const mode = resolveAuthMode(env);
  if (mode.mode === "local-open" && !anyTokenConfigured(env)) {
    // Offen-Betrieb hat keine Session — nichts zu verlaengern, kein Fehler.
    return { ok: true, renewed: false, open: true, actor: null, lifetime: emptyLifetime(env, now), cookies: [] };
  }
  const configError = sessionSecretConfigurationError(env);
  if (configError) {
    return { ok: false, error: configError.code, hint: configError.hint, status: 503 };
  }
  const token = sessionCookieToken(req);
  if (!token) {
    return {
      ok: false,
      error: "SESSION_REQUIRED",
      hint: "Keine Browser-Session. Ueber POST /api/auth/login anmelden — der Token selbst wird nicht zurueckgegeben.",
      status: 401,
    };
  }
  const secret = sessionSecret(env);
  // Nachfrist gilt NUR hier; readSession bleibt strikt.
  const payload = verifySessionToken(token, secret, now, { graceMs: sessionGraceMs(env) });
  if (!payload) {
    const inspection = inspectSessionToken(token, secret, now, { graceMs: sessionGraceMs(env) });
    if (inspection.state === "max-life") {
      return {
        ok: false,
        error: "SESSION_MAX_LIFE_REACHED",
        hint: `Die absolute Sitzungsdauer (${sessionMaxLifeS(env)} s seit Anmeldung) ist erreicht. Bitte neu anmelden.`,
        status: 401,
      };
    }
    return {
      ok: false,
      error: inspection.state === "revoked" ? "SESSION_REVOKED" : "SESSION_INVALID",
      hint:
        inspection.state === "revoked"
          ? "Diese Session wurde serverseitig widerrufen (Logout oder globaler Schnitt). Bitte neu anmelden."
          : "Session-Cookie ist ungueltig, abgelaufen oder passt nicht zur aktuellen Auth-Konfiguration. Bitte neu anmelden.",
      status: 401,
    };
  }
  // Widerruf zuerst: eine Logout-/Notfall-Session ist weg, egal welche Header
  // mitschwingen (Revocation schlaegt Verlaengerung — SEC-08 invariant).
  if (isSessionRevoked(payload, now)) {
    return {
      ok: false,
      error: "SESSION_REVOKED",
      hint: "Diese Session wurde serverseitig widerrufen (Logout oder globaler Schnitt). Bitte neu anmelden.",
      status: 401,
    };
  }
  // Double-Submit-Pflicht: der Header muss exakt dem session-gebundenen Wert
  // entsprechen. Der Legacy-Pfad (Header == Token) gilt hier bewusst NICHT —
  // eine Verlaengerung ist eine Session-Operation, keine API-Operation.
  if (!csrfToken || !tokenEquals(csrfToken, payload.csrf)) {
    return {
      ok: false,
      error: "CSRF_INVALID",
      hint: "Fehlender/falscher x-csrf-token-Header — Verlaengerungen verlangen das Double-Submit des firm_csrf-Cookies.",
      status: 403,
    };
  }
  const actor = sessionActor(payload, env, now, { graceMs: sessionGraceMs(env), maxLifeMs: sessionMaxLifeMs(env) });
  if (!actor) {
    return {
      ok: false,
      error: "SESSION_INVALID",
      hint: "Die Auth-Konfiguration hat sich seit der Anmeldung geaendert (Token-/Secret-Rotation). Bitte neu anmelden.",
      status: 401,
    };
  }

  const lifetime = sessionLifetime(payload, env, now);
  // Ausserhalb des Verlaengerungsfensters: alles okay, nichts zu tun.
  if (payload.exp - now > sessionRenewWindowS(env) * 1000) {
    return { ok: true, renewed: false, open: false, actor, lifetime, cookies: [] };
  }
  // Nahe der absoluten Grenze wurde die neue Generation kuerzer als ein
  // Taktintervall — das waere eine Endlosschleife aus Mini-Verlaengerungen.
  // Lieber einmal klar neu anmelden lassen.
  if (payload.maxExp - now < SESSION_RENEW_MIN_REMAINING_MS) {
    return {
      ok: false,
      error: "SESSION_MAX_LIFE_REACHED",
      hint: `Die absolute Sitzungsdauer (${sessionMaxLifeS(env)} s seit Anmeldung) ist erreicht. Bitte neu anmelden.`,
      status: 401,
      lifetime,
    };
  }
  if (isProductionEnv(env) && new URL(req.url).protocol !== "https:") {
    return {
      ok: false,
      error: "SESSION_HTTPS_REQUIRED",
      hint: "Session-Cookies werden in Produktion nur ueber HTTPS gesetzt. Bitte hinter TLS betreiben (Proxy/Terminator).",
      status: 400,
    };
  }
  const issued = mintSession(
    req,
    payload.credential,
    env,
    { iat: payload.iat, maxExp: payload.maxExp, csrf: payload.csrf },
    now
  );
  if (!issued.ok) {
    return { ok: false, error: issued.error, hint: issued.hint, status: issued.status };
  }
  return {
    ok: true,
    renewed: true,
    open: false,
    actor,
    lifetime: issued.lifetime,
    cookies: issued.cookies,
  };
}

/**
 * Session-Zustand eines Browsers fuer die Statusanzeige
 * (`GET /api/auth/status`) — anzeigt, ob die Firm-API ueberhaupt eingerichtet
 * ist und ob die eigene Browser-Session laeuft. Liefert nie Credentials und
 * nie Details Dritter: die Session-Felder beschreiben ausschliesslich das
 * Cookie des Anrufers.
 */
export type SessionStatus = {
  /** `true` = gueltige, autorisierende Browser-Session (readSession-Pfad). */
  active: boolean;
  /**
   * Zustand der eigenen Browser-Session — genau die Ursache, die weiterhilft:
   * `missing` (nie angemeldet), `renewable` (Idle-Frist um, Nachfrist laeuft —
   * ein Refresh genuegt), `expired` (auch Nachfrist um), `max-life` (absolute
   * Grenze erreicht, neu anmelden), `revoked` (Logout oder notfallmaessiger
   * Schnitt), `invalid` (Signatur oder geaenderte Auth-Konfiguration),
   * `open` (Offen-Betrieb, keine Anmeldung noetig).
   */
  state:
    | "active"
    | "expiring"
    | "renewable"
    | "missing"
    | "expired"
    | "max-life"
    | "revoked"
    | "invalid"
    | "open";
  /** Rolle der eigenen Session, sonst null. */
  role: Actor["role"] | null;
  /** Single-Admin-Elevation des eigenen Actors. */
  elevated: boolean;
  /** true, wenn der Server im Offen-Betrieb laeuft (kein Login noetig). */
  open: boolean;
  lifetime: SessionLifetime;
  /** Sessions sind moeglich (gueltiges, unabhaengiges FIRM_SESSION_SECRET). */
  signable: boolean;
};

export function sessionStatus(req: Request, env: EnvLike = process.env, now: number = Date.now()): SessionStatus {
  const mode = resolveAuthMode(env);
  const open = mode.mode === "local-open" && !anyTokenConfigured(env);
  const signable = !sessionSecretConfigurationError(env);
  const inactive = (state: SessionStatus["state"]): SessionStatus => ({
    active: false,
    state,
    role: null,
    elevated: false,
    open,
    lifetime: emptyLifetime(env, now),
    signable,
  });

  if (open) {
    return {
      active: true,
      state: "open",
      role: "admin",
      elevated: true,
      open: true,
      lifetime: emptyLifetime(env, now),
      signable,
    };
  }

  const payload = readSession(req, env, now);
  if (payload) {
    const actor = sessionActor(payload, env, now);
    if (actor) {
      const lifetime = sessionLifetime(payload, env, now);
      return {
        active: true,
        state: lifetime.remainingS <= sessionRenewWindowS(env) ? "expiring" : "active",
        role: actor.role,
        elevated: actor.elevated,
        open: false,
        lifetime,
        signable,
      };
    }
  }

  const token = sessionCookieToken(req);
  if (!token) return inactive("missing");
  const secret = sessionSecret(env);
  switch (inspectSessionToken(token, secret, now, { graceMs: sessionGraceMs(env) }).state) {
    case "revoked":
      return inactive("revoked");
    case "valid":
      // Zeitlich gueltig (strict oder innerhalb der Nachfrist), aber
      // readSession lehnte ab: Credential-Bindung oder Modus haben sich
      // geaendert. Streng gueltig ⇒ neu anmelden; nur nachfristgueltig ⇒
      // ein Refresh heilt, ohne dass der Token erneut eingegeben werden muss.
      return verifySessionToken(token, secret, now) ? inactive("invalid") : inactive("renewable");
    case "max-life":
      return inactive("max-life");
    case "expired":
      return inactive("expired");
    default:
      return inactive("invalid");
  }
}
