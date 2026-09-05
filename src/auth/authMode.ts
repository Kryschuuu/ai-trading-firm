/**
 * Auth-Modus — Offen-Betrieb ist eine Konfigurationsentscheidung, kein
 * impliziter Default in Produktion (Befund C1, v1.36.13).
 *
 * Blatt-Modul der Auth-Schicht: keine Imports aus `src/lib/apiAuth`,
 * `src/auth/resolve` oder Next.js. Deshalb können sowohl der Schreib-Guard
 * (`src/lib/apiAuth.ts`) als auch die RBAC-Auflösung (`src/auth/resolve.ts`)
 * und der Boot-Guard (`src/instrumentation.ts`) dieselbe Entscheidung teilen,
 * ohne einander zu importieren.
 *
 * Modell — `AUTH_MODE = "local-open" | "token-required"`, in dieser Reihenfolge:
 *
 *  1. **Irgendein Token konfiguriert** (`FIRM_ADMIN_TOKEN` / `FIRM_API_TOKEN` /
 *     `FIRM_VIEWER_TOKEN`) ⇒ `token-required`. Ein zusätzlich gesetztes
 *     `AUTH_MODE=local-open` wird **ignoriert** (Boot-Warnung) — Offen-Betrieb
 *     darf eine installierte Token-Konfiguration nie abschalten.
 *  2. **Kein Token, `AUTH_MODE` explizit** ⇒ genau dieser Modus. `local-open`
 *     ist der einzige Weg, ohne Token schreiben zu dürfen; in Produktion bleibt
 *     es eine bewusste, in `.env` hinterlegte Entscheidung (laute Warnung).
 *  3. **Kein Token, `AUTH_MODE` ungesetzt** ⇒ `local-open` nur ausserhalb der
 *     Produktion (`NODE_ENV !== "production"`, Dev-Komfort, im Boot-Log
 *     angekündigt). In Produktion ⇒ `token-required`, und der Boot-Guard
 *     verweigert den Start mit `ConfigurationError`.
 *  4. **Unbekannter `AUTH_MODE`-Wert** ⇒ fail-closed `token-required` +
 *     Boot-Fehler. Ein Tipfehler in einer Sicherheitskonfiguration darf nie
 *     stillschweigend offen laufen.
 *
 * Der Boot-Guard ist die scharfe Kante, die Modus-Auflösung die
 * Verteidigung in der Tiefe: Selbst wenn `register()` nicht lief (Tests,
 * Skripte, direkter Routenaufruf) bleiben Write- und Admin-Endpoints in
 * Produktion ohne Token geschlossen.
 */

/** Env-Flag, das den Modus explizit setzt. */
export const AUTH_MODE_FLAG = "AUTH_MODE";

/** Erlaubte Werte von `AUTH_MODE`. */
export const AUTH_MODES = ["local-open", "token-required"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/** Token-Flags der Auth-Schicht (SSoT für RBAC und Schreib-Guard). */
export const ADMIN_TOKEN_FLAG = "FIRM_ADMIN_TOKEN";
export const OPERATOR_TOKEN_FLAG = "FIRM_API_TOKEN";
export const VIEWER_TOKEN_FLAG = "FIRM_VIEWER_TOKEN";

/** Warum dieser Modus gewählt wurde (Log/Debug, nie ein Credential). */
export type AuthModeReason =
  | "tokens-configured"
  | "explicit-local-open"
  | "explicit-token-required"
  | "dev-default"
  | "production-no-tokens"
  | "invalid-auth-mode";

export type ConfigurationErrorCode =
  | "AUTH_NOT_CONFIGURED"
  | "AUTH_MODE_INVALID"
  | "SESSION_SECRET_REQUIRED"
  | "SESSION_SECRET_INVALID";

/**
 * Konfigurationsfehler, der den Start verweigert. Bewusst kein `Error`-Substitut
 * mit freiem Text: `code` ist die maschinenlesbare Stellschraube für Logs,
 * Tests und Runbooks, `hint` die Behebungszeile für den Betreiber.
 */
export class ConfigurationError extends Error {
  readonly code: ConfigurationErrorCode;
  readonly hint: string;

  constructor(
    message: string,
    code: ConfigurationErrorCode = "AUTH_NOT_CONFIGURED",
    hint = ""
  ) {
    super(message);
    this.name = "ConfigurationError";
    this.code = code;
    this.hint = hint;
    // Prototyp-Kette stabil halten (tsx/ESM down-level): instanceof muss gelten.
    Object.setPrototypeOf(this, ConfigurationError.prototype);
  }
}

export type AuthModeDecision = {
  /** Wirksamer Modus. */
  mode: AuthMode;
  /** `AUTH_MODE` war gesetzt und gültig (sonst `null`). */
  requested: AuthMode | null;
  /** `AUTH_MODE=local-open` wurde wegen konfigurierter Tokens ignoriert. */
  ignored: boolean;
  /** Unbekannter `AUTH_MODE`-Wert (fail-closed + Boot-Fehler). */
  invalidValue: string | null;
  /** `NODE_ENV === "production"`. */
  production: boolean;
  /** Mindestens ein Token-Flag ist gesetzt. */
  tokensConfigured: boolean;
  reason: AuthModeReason;
};

type EnvLike = Record<string, string | undefined>;

/**
 * SEC-01: Signierschluessel sind ausschliesslich serverseitige, unabhaengige
 * Secrets — niemals Login-Credentials oder ein Fallback aus deren Material.
 * Dieselbe Validierung gilt beim Boot UND beim Ausstellen/Lesen von Sessions.
 * Die Mindestlaenge ersetzt keine Entropie: separat mit openssl rand erzeugen.
 * Fehler enthalten nur Flag-Namen, niemals konfigurierte Werte.
 */
export function sessionSecretConfigurationError(env: EnvLike = process.env): ConfigurationError | null {
  const secret = (env.FIRM_SESSION_SECRET ?? "").trim();
  const hint =
    "FIRM_SESSION_SECRET separat mit openssl rand -hex 32 erzeugen und serverseitig konfigurieren (mindestens 32 Zeichen). Kein Admin-/Operator-/Viewer-Token und keine Ableitung davon verwenden.";
  if (!secret) {
    return new ConfigurationError(
      "Session signing requires an independent FIRM_SESSION_SECRET.",
      "SESSION_SECRET_REQUIRED",
      hint
    );
  }
  const reused = [ADMIN_TOKEN_FLAG, OPERATOR_TOKEN_FLAG, VIEWER_TOKEN_FLAG]
    .some((flag) => secret === (env[flag] ?? "").trim());
  if (secret.length < 32 || reused) {
    return new ConfigurationError(
      "FIRM_SESSION_SECRET must be at least 32 characters and distinct from every auth token.",
      "SESSION_SECRET_INVALID",
      hint
    );
  }
  return null;
}

/** Admin-Token konfiguriert? Trennt Single-Admin- von Rollen-Modell. */
export function adminTokenConfigured(env: EnvLike = process.env): boolean {
  return Boolean(env[ADMIN_TOKEN_FLAG]);
}

/** Irgendein Token konfiguriert? Definiert „Authentifizierung ist eingerichtet“. */
export function anyTokenConfigured(env: EnvLike = process.env): boolean {
  return Boolean(
    env[ADMIN_TOKEN_FLAG] || env[OPERATOR_TOKEN_FLAG] || env[VIEWER_TOKEN_FLAG]
  );
}

/** Produktion im Sinne des Boot-Guards: nur der exakte Wert zählt. */
export function isProductionEnv(env: EnvLike = process.env): boolean {
  return env.NODE_ENV === "production";
}

/**
 * Löst den wirksamen Auth-Modus auf. **Wirft nie** — diese Funktion steht auf
 * dem Anfragepfad und muss einen fehlkonfigurierten Wert fail-closed, nicht
 * fatal beantworten. Die Startverweigerung liegt in {@link assertAuthConfigured}.
 */
export function resolveAuthMode(env: EnvLike = process.env): AuthModeDecision {
  const production = isProductionEnv(env);
  const tokensConfigured = anyTokenConfigured(env);
  const raw = (env[AUTH_MODE_FLAG] ?? "").trim();
  const requested: AuthMode | null = (AUTH_MODES as readonly string[]).includes(raw)
    ? (raw as AuthMode)
    : null;
  const invalidValue = raw.length > 0 && requested === null ? raw : null;

  let mode: AuthMode;
  let reason: AuthModeReason;
  if (tokensConfigured) {
    // Regel 1: Tokens schlagen Offen-Betrieb — ohne Ausnahme.
    mode = "token-required";
    reason = "tokens-configured";
  } else if (invalidValue !== null) {
    // Regel 4: unbekannter Wert ⇒ zu, nicht auf.
    mode = "token-required";
    reason = "invalid-auth-mode";
  } else if (requested === "local-open") {
    // Regel 2: einziges Mittel, ohne Token offen zu laufen (auch Prod, laut).
    mode = "local-open";
    reason = "explicit-local-open";
  } else if (requested === "token-required") {
    mode = "token-required";
    reason = "explicit-token-required";
  } else if (!production) {
    // Regel 3a: Dev-Komfort — angekündigt, nie still.
    mode = "local-open";
    reason = "dev-default";
  } else {
    // Regel 3b: Produktion ohne Token ⇒ zu, und der Boot-Guard wirft.
    mode = "token-required";
    reason = "production-no-tokens";
  }

  return {
    mode,
    requested,
    ignored: requested === "local-open" && tokensConfigured,
    invalidValue,
    production,
    tokensConfigured,
    reason,
  };
}

/** Kurze, secret-freie Zeile für Boot-Log und Status-Endpunkte. */
export function describeAuthMode(decision: AuthModeDecision): string {
  const tokens = decision.tokensConfigured ? "Tokens konfiguriert" : "kein Token";
  const where = decision.production ? "produktion" : "entwicklung";
  return `auth-mode=${decision.mode} reason=${decision.reason} ${tokens} · NODE_ENV=${where}`;
}

/**
 * Betreiber-Warnungen zum Modus — als Zeilen, damit der Aufrufer (Boot,
 * Validierungsskript, Test) entscheidet, wie laut er sie ausgibt.
 */
export function authModeWarnings(decision: AuthModeDecision): string[] {
  const out: string[] = [];
  if (decision.invalidValue !== null) {
    out.push(
      `[auth] AUTH_MODE='${decision.invalidValue}' ist ungültig (erlaubt: ${AUTH_MODES.join(
        " | "
      )}) — Schreib-API bleibt zu (fail-closed).`
    );
    return out;
  }
  if (decision.ignored) {
    out.push(
      "[auth] AUTH_MODE=local-open wird ignoriert: Es ist mindestens ein Token konfiguriert — Tokens schlagen Offen-Betrieb."
    );
  }
  if (decision.reason === "dev-default") {
    out.push(
      "[auth] Lokaler Offen-Betrieb (Dev-Default, kein Token gesetzt): alle POST/PUT-Endpunkte sind ohne Credential erreichbar. Produktionsnahes Verhalten mit AUTH_MODE=token-required pruefen."
    );
  }
  if (decision.reason === "explicit-local-open") {
    out.push(
      decision.production
        ? "[auth] WARNUNG: AUTH_MODE=local-open in Produktion — Schreib- und Admin-API sind ohne jedes Credential offen. Nur vertretbar hinter einem Loopback-Bind oder einem authentifizierenden Proxy."
        : "[auth] AUTH_MODE=local-open explizit gesetzt — Schreib-API ohne Credential offen."
    );
  }
  return out;
}

/**
 * Boot-Guard: verweigert den Start, wenn die Authentifizierung nicht
 * eingerichtet ist. Wird von `src/instrumentation.ts` vor jedem anderen Start
 * aufgerufen und ist auch für Skripte/Tests direkt nutzbar.
 *
 * @throws ConfigurationError `AUTH_MODE_INVALID` bei unbekanntem Modus,
 *         `AUTH_NOT_CONFIGURED` wenn `token-required` wirksam ist, aber kein
 *         Token existiert (Produktion ohne Token, oder `AUTH_MODE=token-required`
 *         ins Leere konfiguriert). SEC-01: In Produktion mit Tokens auch
 *         `SESSION_SECRET_REQUIRED` / `SESSION_SECRET_INVALID`, wenn der
 *         unabhaengige Session-Signierschluessel fehlt oder ungueltig ist.
 */
export function assertAuthConfigured(env: EnvLike = process.env): AuthModeDecision {
  const decision = resolveAuthMode(env);
  const fix =
    "Setze FIRM_ADMIN_TOKEN und/oder FIRM_API_TOKEN (openssl rand -hex 32) in .env. Bewusster Offen-Betrieb ohne Token ist nur ausserhalb der Produktion vorgesehen: AUTH_MODE=local-open.";

  if (decision.invalidValue !== null) {
    throw new ConfigurationError(
      `Invalid AUTH_MODE '${decision.invalidValue}' — expected one of: ${AUTH_MODES.join(
        " | "
      )}.`,
      "AUTH_MODE_INVALID",
      `AUTH_MODE kennt nur ${AUTH_MODES.join(" | ")}. Leerer Wert = automatischer Modus.`
    );
  }

  if (decision.mode === "token-required" && !decision.tokensConfigured) {
    throw new ConfigurationError(
      "Refuse startup: authentication not configured (set FIRM_ADMIN_TOKEN/FIRM_API_TOKEN).",
      "AUTH_NOT_CONFIGURED",
      decision.reason === "production-no-tokens"
        ? `NODE_ENV=production ohne Token wurde im Audit als Befund C1 (HIGH) gezählt — der Dienst startet deshalb nicht. ${fix}`
        : `AUTH_MODE=token-required verlangt mindestens ein Token, keins ist gesetzt. ${fix}`
    );
  }

  // local-open verwendet ueberhaupt keine Sessions. Im Token-Betrieb darf
  // Produktion dagegen nie ohne unabhaengigen Signierschluessel starten.
  if (decision.production && decision.tokensConfigured) {
    const error = sessionSecretConfigurationError(env);
    if (error) throw error;
  }

  return decision;
}
