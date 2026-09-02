/**
 * SecretStore-Interface für den Alpaca-Adapter.
 *
 * Default: Venue-backed Named Store der Control Plane
 * (`createVenueBackedNamedStore`) mit Env-Fallback
 * `ALPACA_API_KEY` / `ALPACA_API_SECRET`. Niemals Disk-Klartext,
 * niemals Frontend. Siehe docs/ALPACA.md.
 */
import { createVenueBackedNamedStore } from "../control-plane/secretStore";

export interface SecretStore {
  /** Liefert den Klartext oder `null`, wenn nicht gesetzt. */
  get(name: string): Promise<string | null>;
}

const KEY_NAME = "ALPACA_API_KEY";
const SECRET_NAME = "ALPACA_API_SECRET";

/**
 * Dev-/Test-Fallback und DI-Implementierung: liest `process.env`.
 * Produktion nutzt `createDefaultAlpacaSecretStore` (verschlüsselter
 * Control-Plane-Store, Env nur wenn dort nichts liegt).
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
 * Fehlt SECRET_STORE_KEY oder der Datensatz, greift der Env-Fallback.
 * `EnvSecretStore` bleibt für Tests injizierbar.
 */
export function createDefaultAlpacaSecretStore(
  env: Record<string, string | undefined> = process.env
): SecretStore {
  const envFallback = new EnvSecretStore(env);
  if (!env.SECRET_STORE_KEY || env.SECRET_STORE_KEY.trim().length === 0) {
    return envFallback;
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
