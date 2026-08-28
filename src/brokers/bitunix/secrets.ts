/**
 * SecretStore-Interface für den Bitunix-Adapter.
 *
 * Default (Task 08/10): Venue-backed Named Store der Control Plane
 * (`createVenueBackedNamedStore`) mit Env-Fallback
 * `BITUNIX_API_KEY` / `BITUNIX_API_SECRET`. Niemals Disk-Klartext,
 * niemals Frontend. Siehe docs/BITUNIX.md.
 */
import { createVenueBackedNamedStore } from "../control-plane/secretStore";

export interface SecretStore {
  /** Liefert den Klartext oder `null`, wenn nicht gesetzt. */
  get(name: string): Promise<string | null>;
}

const KEY_NAME = "BITUNIX_API_KEY";
const SECRET_NAME = "BITUNIX_API_SECRET";

/**
 * Dev-/Test-Fallback und DI-Implementierung: liest `process.env`.
 * Produktion nutzt `createDefaultBitunixSecretStore` (verschlüsselter
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
 * (AAD = BITUNIX), gemappt auf BITUNIX_API_KEY / BITUNIX_API_SECRET.
 * Fehlt SECRET_STORE_KEY oder der Datensatz, greift der Env-Fallback
 * (task-07-Verhalten). `EnvSecretStore` bleibt für Tests injizierbar.
 */
export function createDefaultBitunixSecretStore(
  env: Record<string, string | undefined> = process.env
): SecretStore {
  const envFallback = new EnvSecretStore(env);
  if (!env.SECRET_STORE_KEY || env.SECRET_STORE_KEY.trim().length === 0) {
    return envFallback;
  }
  return createVenueBackedNamedStore({
    venue: "BITUNIX",
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

export interface BitunixCredentials {
  apiKey: string;
  apiSecret: string;
}

/** Liest Key+Secret; `null` wenn eines fehlt (kein Throw mit Klartext). */
export async function loadBitunixCredentials(
  store: SecretStore
): Promise<BitunixCredentials | null> {
  const apiKey = await store.get(KEY_NAME);
  const apiSecret = await store.get(SECRET_NAME);
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

export const BITUNIX_SECRET_ENV = { KEY_NAME, SECRET_NAME } as const;
