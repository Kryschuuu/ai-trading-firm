/**
 * SecretStore-Interface fuer den Alpaca-Adapter.
 *
 * Default (SEC-07, v1.36.32): Venue-backed Named Store der Control Plane
 * (`createVenueBackedNamedStore`) — in Produktion KEIN Env-Fallback.
 * `ALPACA_API_KEY` / `ALPACA_API_SECRET` nur noch in explizitem
 * Dev/Test-Modus hinter `BROKER_ALLOW_ENV_FALLBACK=true`. Niemals
 * Disk-Klartext, niemals Frontend. Siehe docs/ALPACA.md.
 */
import {
  createVenueBackedNamedStore,
  isEnvCredentialFallbackAllowed,
} from "../control-plane/secretStore";

export interface SecretStore {
  /** Liefert den Klartext oder `null`, wenn nicht gesetzt. */
  get(name: string): Promise<string | null>;
}

const KEY_NAME = "ALPACA_API_KEY";
const SECRET_NAME = "ALPACA_API_SECRET";

/**
 * Dev-/Test-Fallback und DI-Implementierung: liest `process.env`.
 * Produktion nutzt `createDefaultAlpacaSecretStore` (verschluesselter
 * Control-Plane-Store, Env nur wenn explizit erlaubt).
 */
export class EnvSecretStore implements SecretStore {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  async get(name: string): Promise<string | null> {
    const v = this.env[name];
    if (typeof v !== "string") return null;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}

/**
 * Default-Store des Adapters: AES-256-GCM-Store der Control Plane
 * (AAD = ALPACA), gemappt auf ALPACA_API_KEY / ALPACA_API_SECRET.
 *
 * SEC-07 Fix (v1.36.32):
 *   - credential exists in secure store → use it
 *   - credential absent                 → no credential (null)
 *   - store failure (AUTH_FAILED, STORAGE_UNAVAILABLE) → HARD FAIL (throw)
 *   - Env-Fallback nur wenn `BROKER_ALLOW_ENV_FALLBACK=true` und
 *     NODE_ENV != production (expliziter Dev/Test-Modus).
 *
 * Fehlt SECRET_STORE_KEY:
 *   - mit explizitem Dev-Fallback-Flag → EnvFallback (Dev-Komfort)
 *   - ohne Flag / in Produktion      → kein Credential (fail-closed)
 *
 * `EnvSecretStore` bleibt fuer Tests injizierbar.
 */
export function createDefaultAlpacaSecretStore(
  env: Record<string, string | undefined> = process.env
): SecretStore {
  const envFallback = new EnvSecretStore(env);
  const allowEnvFallback = isEnvCredentialFallbackAllowed(env);

  if (!env.SECRET_STORE_KEY || env.SECRET_STORE_KEY.trim().length === 0) {
    if (allowEnvFallback) {
      return envFallback;
    }
    // Fail-closed: kein Store-Key und kein expliziter Dev-Fallback → kein Credential.
    return {
      async get(): Promise<string | null> {
        return null;
      },
    };
  }
  return createVenueBackedNamedStore({
    venue: "ALPACA",
    store: {
      async put(venue, credential) {
        const { getControlPlaneSecretStore } = await import("../control-plane/secretStore");
        return (await getControlPlaneSecretStore()).put(venue, credential);
      },
      async get(venue) {
        const { getControlPlaneSecretStore } = await import("../control-plane/secretStore");
        return (await getControlPlaneSecretStore()).get(venue);
      },
      async delete(venue) {
        const { getControlPlaneSecretStore } = await import("../control-plane/secretStore");
        return (await getControlPlaneSecretStore()).delete(venue);
      },
      async exists(venue) {
        const { getControlPlaneSecretStore } = await import("../control-plane/secretStore");
        return (await getControlPlaneSecretStore()).exists(venue);
      },
    },
    envFallback,
    keyName: KEY_NAME,
    secretName: SECRET_NAME,
    allowEnvFallback,
  });
}

export interface AlpacaCredentials {
  apiKey: string;
  apiSecret: string;
}

/** Liest Key+Secret; `null` wenn eines fehlt (kein Throw mit Klartext). */
export async function loadAlpacaCredentials(
  store: SecretStore
): Promise<AlpacaCredentials | null> {
  const apiKey = await store.get(KEY_NAME);
  const apiSecret = await store.get(SECRET_NAME);
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

export const ALPACA_SECRET_ENV = { KEY_NAME, SECRET_NAME } as const;
