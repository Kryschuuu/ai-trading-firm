/**
 * Konfiguration der Broker Control Plane (Task 08).
 *
 * Alle Defaults sind SICHER (fail-closed):
 *   - Credential-Rate-Limit: 5 Versuche/min/IP (BROKER_CREDENTIAL_RATE_LIMIT,
 *     0 = aus — nur fuer lokale Tests).
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

/** Effektives Credential-Limit (Default 5/min/IP; 0 deaktiviert). */
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

export const SECRET_STORE_KEY_FLAG = "SECRET_STORE_KEY";
export const SECRET_STORE_KMS_FLAG = "SECRET_STORE_KMS_ENDPOINT";
export const SECRET_BACKEND_FLAG = "BROKER_SECRET_BACKEND";
export const ADMIN_TOKEN_FLAG = "FIRM_ADMIN_TOKEN";

/** Fester CSRF-Wert im Offen-Betrieb (kein Token konfiguriert). */
export const CSRF_LOCAL_VALUE = "local";

/** Header fuer den minimalen Admin-Guard (TODO(task-10): zentrale RBAC). */
export const ADMIN_HEADER = "x-admin-token";
export const CSRF_HEADER = "x-csrf-token";

/** Live-Gate-Begruendung — die EINZIGE erlaubte liveEnabled-Quelle. */
export const LIVE_GATE_LOCKED_REASON =
  "LIVE_GATE_LOCKED: Live-Ausfuehrung bleibt bis zum Gate-Service (task-11) gesperrt. liveEnabled=false ist die einzige moegliche Anzeige.";
