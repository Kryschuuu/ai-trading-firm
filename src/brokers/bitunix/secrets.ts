/**
 * SecretStore-Interface für den Bitunix-Adapter.
 *
 * TODO(task-08): verschlüsselter Secret-Store. Bis dahin ausschließlich
 * Umgebungsvariablen als Dev-Fallback — niemals Disk-Klartext, niemals
 * Frontend. Siehe docs/BITUNIX.md.
 *
 * // shared contract, vgl. task-08
 */
export interface SecretStore {
  /** Liefert den Klartext oder `null`, wenn nicht gesetzt. */
  get(name: string): Promise<string | null>;
}

const KEY_NAME = "BITUNIX_API_KEY";
const SECRET_NAME = "BITUNIX_API_SECRET";

/**
 * Dev-Fallback: liest `process.env`. Dokumentiert als unsicher für
 * Produktion — task-08 ersetzt die Implementierung.
 *
 * TODO(task-08)
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
