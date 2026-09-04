/**
 * HTTP-Anbindung der Broker Control Plane (Task 08).
 *
 * Fehler-Contract der Control-Plane-Endpoints: `{ ok:false, error, message }`
 * mit SAFE-Meldungen (redigiert, ohne Secret-Inhalte). Maschinenlesbare
 * Codes werden auf HTTP-Status abgebildet:
 *   UNKNOWN_VENUE / NOT_CONFIGURED / ALREADY_CONNECTED / NO_CREDENTIALS → 404/409
 *   Zustands-Missbrauch (422), Validierung (422), Store nicht bereit (503).
 */
import { UnknownVenueError } from "@/contracts/broker";
import { isAuditPersistenceError } from "@/lib/auditSink";
import { publicErrorMessage } from "@/lib/secrets";
import { SecretStoreError } from "./secretStore";
import { StateTransitionError } from "./states";

const CONFLICT_CODES = new Set([
  "NOT_CONFIGURED",
  "ALREADY_CONNECTED",
  "NO_CREDENTIALS",
]);

const VALIDATION_CODES = new Set([
  "VALIDATION_ERROR",
  "NO_CREDENTIALS_REQUIRED",
  "PROBE_MISSING",
  "UNKNOWN_ACTION",
  "CONNECTION_REQUIRED",
  "NOT_SUPPORTED_CAPABILITY",
  "DISCOVERY_NOT_IMPLEMENTED",
  "INVALID_ENVELOPE",
]);

/** Uebersetzt Control-Plane-Fehler in eine SAFE HTTP-Response. */
export function mapControlPlaneError(err: unknown): Response {
  if (isAuditPersistenceError(err)) {
    // S1: fail-closed weil der Auditbeleg nicht durable war — die Mutation
    // wurde nicht ausgeführt. Behebung liegt beim Betrieb (DB/Spool-Verzeichnis),
    // nicht beim Anwender: 503, kein 4xx.
    return Response.json(
      {
        ok: false,
        error: "AUDIT_PERSISTENCE_FAILED",
        message: "Änderung wurde nicht ausgeführt: der Sicherheits-Audit war nicht persistent schreibbar.",
        hint: "PostgreSQL und AUDIT_SPOOL_DIR (Schreibrechte) prüfen, dann erneut versuchen.",
      },
      { status: 503 }
    );
  }
  if (err instanceof UnknownVenueError) {
    return Response.json(
      { ok: false, error: err.code, message: publicErrorMessage(err) },
      { status: 404 }
    );
  }
  if (err instanceof StateTransitionError) {
    const status = CONFLICT_CODES.has(err.code) ? 409 : 422;
    return Response.json(
      { ok: false, error: err.code, message: publicErrorMessage(err) },
      { status }
    );
  }
  if (err instanceof SecretStoreError) {
    // INVALID_ENVELOPE wird hier als Validierungsfehler behandelt
    // (Credential-Format); alle anderen Store-Fehler sind 503.
    if (VALIDATION_CODES.has(err.code)) {
      return Response.json(
        { ok: false, error: "VALIDATION_ERROR", message: publicErrorMessage(err) },
        { status: 422 }
      );
    }
    return Response.json(
      { ok: false, error: err.code, message: publicErrorMessage(err) },
      { status: 503 }
    );
  }
  return Response.json(
    { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(err) },
    { status: 500 }
  );
}

/** Parsen des JSON-Bodys; kaputtes JSON → 422 (konsistenter Fehler-Contract). */
export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new StateTransitionError(
      "VALIDATION_ERROR",
      "Request-Body ist kein gueltiges JSON."
    );
  }
}
