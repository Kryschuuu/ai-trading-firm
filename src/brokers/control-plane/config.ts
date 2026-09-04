/**
 * Konfiguration der Broker Control Plane (Task 08; Brute-Force-Schichtung C2,
 * v1.36.14).
 *
 * Alle Defaults sind SICHER (fail-closed):
 *   - Credential-Rate-Limit: 5 Versuche/min/Client-Identitaet
 *     (BROKER_CREDENTIAL_RATE_LIMIT, 0 = aus — nur fuer lokale Tests).
 *     Die Identitaet kommt aus `src/lib/clientIp.ts` und ist ohne
 *     Proxy-Vertrauenskonfiguration NICHT client-setzbar (Befund C2).
 *   - Globales Credential-Limit: 20 Versuche/min ueber ALLE Clients
 *     (BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT, 0 = aus). Bewusst
 *     IP-unabhaengig: ein Angreifer, der Proxys/Netze wechselt oder hinter
 *     einem NAT viele Identitaeten teilt, laeuft trotzdem in eine Deckelung.
 *   - Exponentieller Backoff: ab dem 3. fehlgeschlagenen Credential-Versuch
 *     wachsende Sperre pro Identitaet (2 s, 4 s, 8 s, ... max. 15 min),
 *     Ruecksetzung nach 15 min Ruhe oder nach einem erfolgreichen Versuch.
 *   - Secret-Store: AES-256-GCM, Key aus SECRET_STORE_KEY/KMS. Fehlt der
 *     Key, liefern Credential-Endpoints 503 SECRET_STORE_UNAVAILABLE —
 *     niemals einen Klartext-Fallback.
 *   - Live: `liveEnabled` ist IMMER false. Es gibt KEINEN Env-Schalter,
 *     der das aendern kann — die Anzeige kommt ausschliesslich aus dem
 *     Gate-Service (readGateState), der bis task-11 hart gesperrt ist.
 */
import { envInt } from "@/lib/env";

export const CREDENTIAL_RATE_LIMIT_FLAG = "BROKER_CREDENTIAL_RATE_LIMIT";
export const CREDENTIAL_RATE_LIMIT_DEFAULT = 5;
export const CREDENTIAL_RATE_LIMIT_WINDOW_MS = 60_000;

/** Effektives Credential-Limit pro Identitaet (Default 5/min; 0 deaktiviert). */
export function credentialRateLimitMax(
  env: Record<string, string | undefined> = process.env
): number {
  return envInt(
    CREDENTIAL_RATE_LIMIT_FLAG,
    CREDENTIAL_RATE_LIMIT_DEFAULT,
    0,
    1000,
    env
  );
}

/**
 * Globales Credential-Limit (C2, v1.36.14) — IP-/identitaetsunabhaengig.
 * Default 20/min ueber alle Clients; 0 deaktiviert.
 */
export const CREDENTIAL_GLOBAL_RATE_LIMIT_FLAG =
  "BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT";
export const CREDENTIAL_GLOBAL_RATE_LIMIT_DEFAULT = 20;

/** Fester Bucket-Schluessel des globalen Limits (nie aus dem Request). */
export const GLOBAL_CREDENTIAL_BUCKET_KEY = "global";

/** Effektives globales Credential-Limit (Default 20/min; 0 deaktiviert). */
export function credentialGlobalRateLimitMax(
  env: Record<string, string | undefined> = process.env
): number {
  return envInt(
    CREDENTIAL_GLOBAL_RATE_LIMIT_FLAG,
    CREDENTIAL_GLOBAL_RATE_LIMIT_DEFAULT,
    0,
    100000,
    env
  );
}

// ── Exponentieller Backoff fuer Credential-Brute-Force (C2) ─────────────────

export type CredentialBackoffConfig = {
  /** Ab dieser Anzahl Fehlversuche greift die Sperre (davor: nur Fenster). */
  threshold: number;
  /** Sperre beim `threshold`-ten Fehlversuch. */
  baseMs: number;
  /** Wachstumsfaktor je weiterem Fehlversuch. */
  factor: number;
  /** Harte Obergrenze einer Sperre. */
  maxMs: number;
};

export const CREDENTIAL_BACKOFF_CONFIG: CredentialBackoffConfig = {
  threshold: 3,
  baseMs: 2_000,
  factor: 2,
  maxMs: 900_000, // 15 min
};

/** Ruhephase, nach der die Fehlversuchs-Zaehlung einer Identitaet neu beginnt. */
export const CREDENTIAL_BACKOFF_RESET_MS = 900_000; // 15 min

/**
 * Backoff-Justierung per Env (0 = Backoff aus, wie bei den anderen Limits).
 * Defaults bleiben die Code-Konstanten oben; `envInt` klemmt Ausreisser.
 */
export const CREDENTIAL_BACKOFF_BASE_MS_FLAG = "BROKER_CREDENTIAL_BACKOFF_BASE_MS";
export const CREDENTIAL_BACKOFF_MAX_MS_FLAG = "BROKER_CREDENTIAL_BACKOFF_MAX_MS";

/** Wirksame Backoff-Konfiguration (Defaults aus `CREDENTIAL_BACKOFF_CONFIG`). */
export function credentialBackoffConfig(
  env: Record<string, string | undefined> = process.env
): CredentialBackoffConfig {
  return {
    threshold: CREDENTIAL_BACKOFF_CONFIG.threshold,
    factor: CREDENTIAL_BACKOFF_CONFIG.factor,
    baseMs: envInt(
      CREDENTIAL_BACKOFF_BASE_MS_FLAG,
      CREDENTIAL_BACKOFF_CONFIG.baseMs,
      0,
      3_600_000,
      env
    ),
    maxMs: envInt(
      CREDENTIAL_BACKOFF_MAX_MS_FLAG,
      CREDENTIAL_BACKOFF_CONFIG.maxMs,
      0,
      86_400_000,
      env
    ),
  };
}

/**
 * Sperrdauer aus der Anzahl Fehlversuche — exponentiell, gedeckelt, ohne
 * Ueberlauf. `0` = keine Sperre (unterhalb `threshold` bzw. bei Unsinn wie
 * NaN/negativen Werten: fail-closed waere hier eine Dauersperre, deshalb 0 —
 * das Fenster-Limit drosselt weiterhin).
 */
export function credentialBackoffMs(
  failures: number,
  cfg: CredentialBackoffConfig = CREDENTIAL_BACKOFF_CONFIG
): number {
  if (!Number.isFinite(failures) || failures < cfg.threshold) return 0;
  const { threshold, baseMs, factor, maxMs } = cfg;
  if (!(baseMs > 0) || !(factor > 1) || !(maxMs > 0)) return 0;
  // Exponent begrenzen: 2^1024 waere Infinity, und laenger als maxMs sperrt
  // es ohnehin nie.
  const exponent = Math.min(Math.trunc(failures) - threshold, 32);
  const ms = baseMs * Math.pow(factor, exponent);
  if (!Number.isFinite(ms)) return maxMs;
  return Math.min(maxMs, Math.max(0, Math.round(ms)));
}

export const SECRET_STORE_KEY_FLAG = "SECRET_STORE_KEY";
export const SECRET_STORE_KMS_FLAG = "SECRET_STORE_KMS_ENDPOINT";
export const SECRET_BACKEND_FLAG = "BROKER_SECRET_BACKEND";
export const ADMIN_TOKEN_FLAG = "FIRM_ADMIN_TOKEN";

/** Fester CSRF-Wert im Offen-Betrieb (kein Token konfiguriert). */
export const CSRF_LOCAL_VALUE = "local";

/** Header fuer den Admin-Token (RBAC-Kern: src/auth, Task 10). */
export const ADMIN_HEADER = "x-admin-token";
export const CSRF_HEADER = "x-csrf-token";

/** Live-Gate-Begruendung — die EINZIGE erlaubte liveEnabled-Quelle. */
export const LIVE_GATE_LOCKED_REASON =
  "LIVE_GATE_LOCKED: Live-Ausfuehrung bleibt bis zum Gate-Service (task-11) gesperrt. liveEnabled=false ist die einzige moegliche Anzeige.";
