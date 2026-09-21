/**
 * Kanonische Serialisierung + Hash-Helfer der Trade-Attribution
 * (RMA-P1-06, v1.57.0).
 *
 * Zweck: historische Snapshots und Attributionsergebnisse dürfen später NICHT
 * uminterpretierbar sein. Basis dafür ist eine **deterministische**
 * JSON-Serialisierung (rekursiv sortierte Objektschlüssel, definierte
 * Zahlen-/Null-Darstellung) — dieselbe Darstellung ergibt immer denselben
 * SHA-256-Fingerprint.
 *
 * Rein und frei von DB-/Node-Abhängigkeiten außer node:crypto.
 */
import { createHash } from "node:crypto";

/**
 * Kanonisches JSON: Objektschlüssel werden rekursiv sortiert, Arrays behalten
 * ihre Reihenfolge (Reihenfolge ist Semantik), `undefined` wird wie beim
 * Standard-JSON.stringify verworfen. Damit ist der Hash unabhängig von der
 * Einfügereihenfolge der Schlüssel — zwei inhaltsgleiche Snapshots hashen
 * identisch.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value ?? null;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/** SHA-256 als Hex-String über den UTF-8-kodierten Text. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** SHA-256 über die kanonische JSON-Darstellung eines Wertes. */
export function sha256OfJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Versionierter Fingerprint `prefix:<sha256>` (Muster: fc1/fd1 der Features). */
export function fingerprint(prefix: string, value: unknown): string {
  return `${prefix}:${sha256OfJson(value)}`;
}
