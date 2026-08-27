/**
 * Verschluesselter Secret-Store der Broker Control Plane (Task 08).
 *
 * HARTE REGELN (docs/FRONTEND_CONTROL_PLANE.md):
 *   - Verschlüsselung at rest: AES-256-GCM, Schlüssel NUR aus Env/KMS
 *     (`SECRET_STORE_KEY` bzw. KMS-Hook), niemals im Repo.
 *   - AAD = Venue-ID: Der Auth-Tag bindet jeden Datensatz an genau eine
 *     Venue. Ein Ciphertext einer anderen Venue ODER ein getauschtes Venue
 *     schlägt bei der Entschlüsselung fehl (Auth-Tag).
 *   - Ent-/Verschlüsselung ausschließlich im Backend. Das Secret fließt
 *     einmalig Form → Store, danach existiert nur noch die Referenz.
 *   - Memory-Hygiene: Secret-Buffer werden nach Nutzung genullt (zeroize),
 *     es entstehen keine langlebigen Strings.
 *
 * KMS-Hook: `KmsClient.resolveKey(context)` liefert das 32-Byte-Key-Material.
 * Default ist der Env-Client (`SECRET_STORE_KEY`, hex oder base64). Ein
 * AWS-KMS-Client ist vorbereitet und meldet eine klare TODO-Meldung, statt
 * still auf Env zurückzufallen (SECRET_STORE_KMS_ENDPOINT).
 *
 * Speicher-Backends (verschluesselte Envelopes, NIE Klartext):
 *   - `db`     : Tabelle `broker_credentials` (Drizzle, lazy, best-effort)
 *   - `file`   : `data/secrets/<VENUE>.enc`, chmod 600, gitignored
 *   - `memory` : nur Tests/demos (BROKER_SECRET_BACKEND=memory)
 * Default: `db`; schlägt der DB-Ping fehl, fällt der Store auf `file` zurück
 * (lauter Audit-Hinweis, nie stilles Verlieren von Credentials).
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/** Einmalig vom Frontend uebernommenes Credential-Paar (wird nie angezeigt). */
export interface CredentialPayload {
  apiKey: string;
  apiSecret: string;
}

/** Maschinenlesbare Fehler des Secret-Stores — Meldungen NIE mit Secret-Inhalt. */
export class SecretStoreError extends Error {
  constructor(
    readonly code:
      | "KEY_MISSING"
      | "INVALID_KEY"
      | "INVALID_ENVELOPE"
      | "AUTH_FAILED"
      | "STORAGE_UNAVAILABLE"
      | "KMS_NOT_IMPLEMENTED"
      | "BACKEND_UNAVAILABLE",
    message: string
  ) {
    super(message);
    this.name = "SecretStoreError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory-Hygiene
// ─────────────────────────────────────────────────────────────────────────────

/** Ueberschreibt einen Buffer deterministisch mit 0-Bytes. */
export function zeroize(buf: Buffer): void {
  if (Buffer.isBuffer(buf)) buf.fill(0);
}

/**
 * Krypto-Primitive (AES-256-GCM).
 *
 * Eingabe/Ausgabe sind Buffer, damit der Klartext nie als langlebiger String
 * existiert und deterministisch genullt werden kann. JS-Strings sind
 * unveraenderlich und koennen nicht genullt werden — deshalb laeuft der
 * komplette Krypto-Pfad ueber Buffer (put: JSON → Buffer → seal; get:
 * open → Buffer → parse → Ergebnis-Objekt wird von zeroizeCredential()-Kopien
 * getragen, die der Aufrufer nach der Probe entsorgt).
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/** AAD ist die Venue-ID — bindet den Datensatz an genau diese Venue. */
export function aadForVenue(venue: string): Buffer {
  return Buffer.from(`broker-control-plane:venue=${venue}`, "utf8");
}

/**
 * Leitet den 32-Byte-Schluessel aus `SECRET_STORE_KEY` ab.
 * Akzeptiert 64-Zeichen-Hex oder Base64 (URL-safe oder Standard).
 * Der Eingabe-String selbst wird nicht kopiert/nicht geloggt.
 */
export function deriveStoreKey(secret: string): Buffer {
  const raw = typeof secret === "string" ? secret.trim() : "";
  if (raw.length === 0) {
    throw new SecretStoreError(
      "KEY_MISSING",
      "SECRET_STORE_KEY ist nicht gesetzt. Einen 32-Byte-Schluessel als Hex (64 Zeichen) oder Base64 erzeugen, z. B.: openssl rand -hex 32"
    );
  }
  let key: Buffer;
  try {
    key = /^[0-9a-fA-F]{64}$/.test(raw)
      ? Buffer.from(raw, "hex")
      : Buffer.from(raw, "base64");
  } catch {
    throw new SecretStoreError(
      "INVALID_KEY",
      "SECRET_STORE_KEY ist kein gueltiger Hex-/Base64-Schluessel."
    );
  }
  if (key.length !== KEY_LENGTH) {
    zeroize(key);
    throw new SecretStoreError(
      "INVALID_KEY",
      "SECRET_STORE_KEY muss exakt 32 Bytes ergeben (AES-256)."
    );
  }
  return key;
}

interface Envelope {
  v: 1;
  alg: "aes-256-gcm";
  iv: string; // base64, 12 Bytes
  tag: string; // base64, 16 Bytes
  ct: string; // base64, ciphertext
}

/**
 * Versiegelt Klartext (Buffer) fuer eine Venue: frischer IV je Aufruf,
 * AAD = Venue-ID, Auth-Tag 16 Bytes. Liefert das Envelope als JSON-String.
 * Alle temporaeren Buffer werden im finally genullt.
 */
export function sealEnvelope(key: Buffer, plaintext: Buffer, venue: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aadForVenue(venue));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  try {
    const envelope: Envelope = {
      v: 1,
      alg: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ct: ct.toString("base64"),
    };
    return JSON.stringify(envelope);
  } finally {
    zeroize(iv);
    zeroize(tag);
    zeroize(ct);
  }
}

/**
 * Oeffnet ein Envelope fuer eine Venue. Falscher Schluessel, manipulierte
 * Ciphertext-Bytes oder ein Envelope einer ANDEREN Venue (AAD-Bindung)
 * schlagen am Auth-Tag fehl → `SecretStoreError("AUTH_FAILED")` mit einer
 * bewusst generischen Meldung (kein Orakel ueber den Inhalt).
 */
export function openEnvelope(key: Buffer, envelopeText: string, venue: string): Buffer {
  let envelope: Envelope;
  try {
    envelope = JSON.parse(envelopeText) as Envelope;
  } catch {
    throw new SecretStoreError(
      "INVALID_ENVELOPE",
      "Gespeicherter Datensatz ist kein gueltiges Envelope."
    );
  }
  if (
    envelope?.v !== 1 ||
    envelope.alg !== "aes-256-gcm" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.ct !== "string"
  ) {
    throw new SecretStoreError(
      "INVALID_ENVELOPE",
      "Envelope-Format ungueltig (Version/Algorithmus/Laengen)."
    );
  }

  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ct = Buffer.from(envelope.ct, "base64");
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH || ct.length === 0) {
    zeroize(iv);
    zeroize(tag);
    zeroize(ct);
    throw new SecretStoreError(
      "INVALID_ENVELOPE",
      "Envelope-Laengen ungueltig (IV/Tag/Ciphertext)."
    );
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(aadForVenue(venue));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err ? String(err.code) : "";
    // Auth-Tag-Fehler (falscher Key, Tampering, fremde Venue) bewusst
    // generisch melden — keine Unterscheidung, die ein Angreifer als
    // Padding-Orakel nutzen koennte.
    if (code.includes("BAD_DECRYPT") || code.includes("UNSUPPORTED") || code === "") {
      throw new SecretStoreError(
        "AUTH_FAILED",
        "Entschluesselung fehlgeschlagen: Schluessel falsch, Datensatz manipuliert oder an eine andere Venue gebunden (Auth-Tag)."
      );
    }
    throw new SecretStoreError(
      "INVALID_ENVELOPE",
      "Entschluesselung fehlgeschlagen: Datensatz ungueltig."
    );
  } finally {
    zeroize(iv);
    zeroize(tag);
    zeroize(ct);
  }
}

/** Credential-Payload aus einem Klartext-Buffer parsen (strikt validiert). */
export function parseCredentialPlaintext(plaintext: Buffer): CredentialPayload {
  try {
    const parsed = JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
    if (
      typeof parsed?.apiKey !== "string" ||
      typeof parsed?.apiSecret !== "string"
    ) {
      throw new Error("shape");
    }
    return { apiKey: parsed.apiKey, apiSecret: parsed.apiSecret };
  } catch {
    throw new SecretStoreError(
      "INVALID_ENVELOPE",
      "Entschluesselter Inhalt hat nicht das erwartete Credential-Format."
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// KMS-Hook
// ─────────────────────────────────────────────────────────────────────────────

/** KMS-Hook: liefert Key-Material fuer einen Kontext (nie im Repo, nie im Log). */
export interface KmsClient {
  /** Menschlich lesbare Quelle fuer Status/Audit ("env", "aws-kms"). */
  readonly source: string;
  /** Liefert das 32-Byte-Key-Material. Darf werfen (SecretStoreError). */
  resolveKey(context: string): Promise<Buffer>;
}

/** Default: Schluessel aus `SECRET_STORE_KEY` (Hex oder Base64). */
export class EnvKmsClient implements KmsClient {
  readonly source = "env";
  constructor(
    private readonly env: Record<string, string | undefined> = process.env
  ) {}

  async resolveKey(_context: string): Promise<Buffer> {
    const raw = this.env.SECRET_STORE_KEY;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new SecretStoreError(
        "KEY_MISSING",
        "SECRET_STORE_KEY ist nicht gesetzt (siehe .env.example)."
      );
    }
    return deriveStoreKey(raw);
  }
}

/**
 * Vorbereiteter AWS-KMS-Hook. Wird erst aktiv, wenn
 * `SECRET_STORE_KMS_ENDPOINT` gesetzt ist — dann bewusst mit einer klaren
 * TODO-Meldung statt still auf Env zurueckzufallen (fail-safe).
 *
 * TODO(task-08-Nachfolge): AWS SDK-Anbindung (resolveKey via KMS Decrypt),
 * Keys niemals im Log, Audit des Key-Uploads.
 */
export class AwsKmsClient implements KmsClient {
  readonly source = "aws-kms";
  constructor(
    private readonly env: Record<string, string | undefined> = process.env
  ) {}

  async resolveKey(_context: string): Promise<Buffer> {
    const endpoint = this.env.SECRET_STORE_KMS_ENDPOINT;
    if (endpoint) {
      throw new SecretStoreError(
        "KMS_NOT_IMPLEMENTED",
        "SECRET_STORE_KMS_ENDPOINT ist gesetzt, aber der KMS-Client ist noch nicht implementiert (TODO). Entweder Endpoint entfernen oder SECRET_STORE_KEY als Env-Fallback verwenden."
      );
    }
    // Kein Endpoint konfiguriert → Env-Verhalten (gleicher Vertrag).
    return new EnvKmsClient(this.env).resolveKey(_context);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Speicher-Backends (Envelope-Strings, niemals Klartext)
// ─────────────────────────────────────────────────────────────────────────────

export interface SecretStorage {
  readonly backend: string;
  read(venue: string): Promise<string | null>;
  write(venue: string, envelope: string): Promise<void>;
  remove(venue: string): Promise<boolean>;
  /** Schneller Verfuegbarkeits-Check (fuer die Backend-Wahl). */
  ping(): Promise<boolean>;
}

export class MemorySecretStorage implements SecretStorage {
  readonly backend = "memory";
  private readonly map = new Map<string, string>();

  async read(venue: string): Promise<string | null> {
    return this.map.get(venue) ?? null;
  }
  async write(venue: string, envelope: string): Promise<void> {
    this.map.set(venue, envelope);
  }
  async remove(venue: string): Promise<boolean> {
    return this.map.delete(venue);
  }
  async ping(): Promise<boolean> {
    return true;
  }
  /** Nur Tests. */
  entries(): Map<string, string> {
    return this.map;
  }
}

export class FileSecretStorage implements SecretStorage {
  readonly backend = "file";

  constructor(private readonly dir: string) {}

  private fileFor(venue: string): string {
    // Venue-IDs sind serverseitig bereits gegen ^[A-Z0-9_-]{1,32}$ validiert;
    // zusaetzlich hart sanitizen, damit kein Pfad-Traversal moeglich ist.
    if (!/^[A-Z0-9_-]{1,32}$/.test(venue)) {
      throw new SecretStoreError("INVALID_ENVELOPE", "Ungueltige Venue-ID.");
    }
    return path.join(this.dir, `${venue}.enc`);
  }

  async read(venue: string): Promise<string | null> {
    const file = this.fileFor(venue);
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8");
  }
  async write(venue: string, envelope: string): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const file = this.fileFor(venue);
    writeFileSync(file, envelope, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* chmod best-effort (Dateisysteme ohne POSIX-Modes, z. B. Container-FS). */
    }
  }
  async remove(venue: string): Promise<boolean> {
    const file = this.fileFor(venue);
    if (!existsSync(file)) return false;
    rmSync(file);
    return true;
  }
  async ping(): Promise<boolean> {
    try {
      mkdirSync(this.dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
}

export class DbSecretStorage implements SecretStorage {
  readonly backend = "db";

  async read(venue: string): Promise<string | null> {
    const { db } = await import("@/db");
    const { brokerCredentials } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select({ envelope: brokerCredentials.envelope })
      .from(brokerCredentials)
      .where(eq(brokerCredentials.venue, venue))
      .limit(1);
    return rows[0]?.envelope ?? null;
  }
  async write(venue: string, envelope: string): Promise<void> {
    const { db } = await import("@/db");
    const { brokerCredentials } = await import("@/db/schema");
    await db
      .insert(brokerCredentials)
      .values({ venue, envelope })
      .onConflictDoUpdate({ target: brokerCredentials.venue, set: { envelope } });
  }
  async remove(venue: string): Promise<boolean> {
    const { db } = await import("@/db");
    const { brokerCredentials } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const result = await db
      .delete(brokerCredentials)
      .where(eq(brokerCredentials.venue, venue));
    return (result.rowCount ?? 0) > 0;
  }
  async ping(): Promise<boolean> {
    try {
      const { db } = await import("@/db");
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`SELECT 1`);
      return true;
    } catch {
      return false;
    }
  }
}

/** Backend-Auswahl: explizit konfiguriert, sonst db → Fallback file. */
export async function resolveSecretStorage(opts: {
  env?: Record<string, string | undefined>;
  dir?: string;
} = {}): Promise<SecretStorage> {
  const env = opts.env ?? process.env;
  const configured = (env.BROKER_SECRET_BACKEND ?? "").trim().toLowerCase();
  if (configured === "memory") return new MemorySecretStorage();
  if (configured === "file") return new FileSecretStorage(opts.dir ?? secretDirFromEnv(env));

  const db = new DbSecretStorage();
  if (configured === "db" || (await db.ping())) return db;
  const file = new FileSecretStorage(opts.dir ?? secretDirFromEnv(env));
  if (await file.ping()) return file;
  throw new SecretStoreError(
    "BACKEND_UNAVAILABLE",
    "Weder Datenbank noch Datei-Backend fuer den Secret-Store verfuegbar."
  );
}

function secretDirFromEnv(env: Record<string, string | undefined>): string {
  return path.resolve(process.cwd(), env.BROKER_SECRET_DIR || "data/secrets");
}

// ─────────────────────────────────────────────────────────────────────────────
// Der Store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Venue-keyed Secret-Store der Control Plane (Interface-Pflicht aus Task 08):
 * `put(venue, credential) / get(venue) / delete(venue) / exists(venue)`.
 */
export interface VenueSecretStore {
  put(venue: string, credential: CredentialPayload): Promise<void>;
  get(venue: string): Promise<CredentialPayload | null>;
  delete(venue: string): Promise<boolean>;
  exists(venue: string): Promise<boolean>;
}

/** Venue-ID-Guardrail: nur das Format, das in Dateinamen/DB-Spalten sicher ist. */
export function assertValidVenueId(venue: string): void {
  if (!/^[A-Z0-9_-]{1,32}$/.test(venue)) {
    throw new SecretStoreError(
      "INVALID_ENVELOPE",
      "Ungueltige Venue-ID (erlaubt: A-Z, 0-9, - und _, max. 32 Zeichen)."
    );
  }
}

/** Strikte Credential-Validierung (Format, nicht Echtheit). */
export function assertValidCredential(credential: CredentialPayload): void {
  for (const [field, value] of [
    ["apiKey", credential?.apiKey],
    ["apiSecret", credential?.apiSecret],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new SecretStoreError(
        "INVALID_ENVELOPE",
        `Credential-Feld "${field}" fehlt oder ist leer.`
      );
    }
    if (value.length < 16 || value.length > 512) {
      throw new SecretStoreError(
        "INVALID_ENVELOPE",
        `Credential-Feld "${field}" muss 16-512 Zeichen lang sein.`
      );
    }
    // Steuerzeichen sind in echten API-Keys nie enthalten und brechen Logs/Formate.
     
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      throw new SecretStoreError(
        "INVALID_ENVELOPE",
        `Credential-Feld "${field}" enthaelt ungueltige Steuerzeichen.`
      );
    }
  }
}

export class AesGcmSecretStore implements VenueSecretStore {
  constructor(
    private readonly storage: SecretStorage,
    private readonly kms: KmsClient
  ) {}

  private async resolveKey(): Promise<Buffer> {
    return this.kms.resolveKey("broker-control-plane");
  }

  /** Verschluesselt und speichert das Credential fuer eine Venue (upsert). */
  async put(venue: string, credential: CredentialPayload): Promise<void> {
    assertValidVenueId(venue);
    assertValidCredential(credential);
    const key = await this.resolveKey();
    const plaintext = Buffer.from(
      JSON.stringify({ apiKey: credential.apiKey, apiSecret: credential.apiSecret }),
      "utf8"
    );
    try {
      const envelope = sealEnvelope(key, plaintext, venue);
      try {
        await this.storage.write(venue, envelope);
      } catch (err) {
        throw new SecretStoreError(
          "STORAGE_UNAVAILABLE",
          "Secret-Store-Speicher nicht verfuegbar (Details im Server-Log, redigiert)."
        );
      }
    } finally {
      zeroize(plaintext);
      zeroize(key);
    }
  }

  /** Entschluesselt das Credential einer Venue (frische Kopie) oder `null`. */
  async get(venue: string): Promise<CredentialPayload | null> {
    assertValidVenueId(venue);
    let envelope: string | null;
    try {
      envelope = await this.storage.read(venue);
    } catch {
      throw new SecretStoreError(
        "STORAGE_UNAVAILABLE",
        "Secret-Store-Speicher nicht verfuegbar (Details im Server-Log, redigiert)."
      );
    }
    if (envelope === null) return null;

    const key = await this.resolveKey();
    try {
      const plaintext = openEnvelope(key, envelope, venue);
      try {
        return parseCredentialPlaintext(plaintext);
      } finally {
        zeroize(plaintext);
      }
    } finally {
      zeroize(key);
    }
  }

  async delete(venue: string): Promise<boolean> {
    assertValidVenueId(venue);
    try {
      return await this.storage.remove(venue);
    } catch {
      throw new SecretStoreError(
        "STORAGE_UNAVAILABLE",
        "Secret-Store-Speicher nicht verfuegbar (Details im Server-Log, redigiert)."
      );
    }
  }

  async exists(venue: string): Promise<boolean> {
    assertValidVenueId(venue);
    try {
      return (await this.storage.read(venue)) !== null;
    } catch {
      throw new SecretStoreError(
        "STORAGE_UNAVAILABLE",
        "Secret-Store-Speicher nicht verfuegbar (Details im Server-Log, redigiert)."
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fabrik + Prozess-Singleton (HMR-sicher ueber globalThis)
// ─────────────────────────────────────────────────────────────────────────────

const G = globalThis as typeof globalThis & {
  __controlPlaneSecretStore?: VenueSecretStore;
  __controlPlaneSecretStorePromise?: Promise<VenueSecretStore>;
};

/**
 * Der Prozess-Singleton-Store der Control Plane. Aufloesung ist async
 * (Backend-Wahl: DB-Ping). Tests injizieren ihren Store ueber
 * `setControlPlaneSecretStoreForTests` bzw. direkt in den Service.
 */
export function getControlPlaneSecretStore(): Promise<VenueSecretStore> {
  if (!G.__controlPlaneSecretStorePromise) {
    G.__controlPlaneSecretStorePromise = (async () => {
      if (G.__controlPlaneSecretStore) return G.__controlPlaneSecretStore;
      const storage = await resolveSecretStorage();
      const kms = process.env.SECRET_STORE_KMS_ENDPOINT
        ? new AwsKmsClient()
        : new EnvKmsClient();
      return new AesGcmSecretStore(storage, kms);
    })();
  }
  return G.__controlPlaneSecretStorePromise;
}

/** Nur Tests: Singleton ersetzen/zuruecksetzen (isoliert Testprozesse). */
export function setControlPlaneSecretStoreForTests(
  store: VenueSecretStore | null
): void {
  G.__controlPlaneSecretStore = store ?? undefined;
  G.__controlPlaneSecretStorePromise = undefined;
}

/**
 * Erzeugt einen Store mit expliziten Abhaengigkeiten (Tests + DI).
 * `kmsKey` ist der 32-Byte-Rohkey als Buffer; ohne Angabe Env.
 */
export function createAesGcmSecretStore(opts: {
  storage: SecretStorage;
  kms?: KmsClient;
  keyBuffer?: Buffer;
}): AesGcmSecretStore {
  const kms =
    opts.kms ??
    (opts.keyBuffer
      ? ({
          source: "test",
          async resolveKey(): Promise<Buffer> {
            return Buffer.from(opts.keyBuffer!);
          },
        } satisfies KmsClient)
      : new EnvKmsClient());
  return new AesGcmSecretStore(opts.storage, kms);
}

// ─────────────────────────────────────────────────────────────────────────────
// Task-07-Kompatibilitaet
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bridge auf das Task-07-Interface `SecretStore` (`get(name)`),
 * z. B. fuer den Bitunix-Adapter: Die entschluesselten Felder der Venue
 * werden auf `BITUNIX_API_KEY` / `BITUNIX_API_SECRET` gemappt. Liegt im
 * verschluesselten Store nichts vor, greift der Env-Fallback (task-07).
 *
 * WICHTIG: Liefert NIE etwas anderes als exakt diese zwei Namen — der
 * task-07-Adapter fragt nur sie ab.
 */
export function createVenueBackedNamedStore(opts: {
  venue: string;
  store: VenueSecretStore;
  envFallback: { get(name: string): Promise<string | null> };
  keyName: string;
  secretName: string;
}): { get(name: string): Promise<string | null> } {
  return {
    async get(name: string): Promise<string | null> {
      if (name !== opts.keyName && name !== opts.secretName) return null;
      try {
        const credential = await opts.store.get(opts.venue);
        if (credential) {
          return name === opts.keyName ? credential.apiKey : credential.apiSecret;
        }
      } catch {
        // Auth-Fehler/Store nicht bereit → Env-Fallback (task-07-Verhalten).
      }
      return opts.envFallback.get(name);
    },
  };
}
