/**
 * Audit-Trail für Registry-Mutationen.
 *
 * Jede Mutation (Upsert, Batch-Upsert, Löschung, Seed) erzeugt genau einen
 * Eintrag mit `actor`, `source`, geänderter Anzahl und Zeitstempel.
 *
 * Zwei Senken:
 *   1. **Datei** (immer): `data/universe/audit-log.ndjson`, append-only.
 *      Funktioniert ohne Datenbank — die Registry ist bewusst DB-frei.
 *   2. **Datenbank** (optional, `UNIVERSE_AUDIT_DB=1`): zusätzlicher Insert in
 *      `audit_log` (Event `UNIVERSE_MUTATION`), damit Registry-Änderungen im
 *      bestehenden revisionssicheren Protokoll erscheinen. Fehler dort werden
 *      geloggt, brechen die Mutation aber nicht ab (die Datei bleibt Wahrheit).
 *
 * Es werden ausschließlich Instrument-IDs und Zähler protokolliert — niemals
 * Credentials, Header oder Roh-Payloads.
 */

import { redactSecrets } from "../lib/secrets";
import type { NdjsonStore } from "./store";

/** Mutationstypen, die auditiert werden. */
export type AuditAction = "UPSERT" | "BATCH_UPSERT" | "REMOVE" | "SEED" | "PRUNE";

/** Ein Audit-Eintrag der Registry. */
export interface UniverseAuditEntry {
  /** Immer `"system"` — die Registry hat keinen Benutzerkontext. */
  actor: "system";
  /** Herkunft der Mutation, z. B. `"seed"`, `"api"`, `"discovery:binance"`. */
  source: string;
  /** Art der Mutation. */
  action: AuditAction;
  /** Anzahl tatsächlich geänderter Instrumente (created + updated + removed). */
  changed: number;
  /** Neu angelegte Instrumente. */
  created: number;
  /** Aktualisierte Instrumente. */
  updated: number;
  /** Abgelehnte Eingaben (Validierung/Policy). */
  rejected: number;
  /** Erste bis zu 25 betroffene IDs (Diagnose ohne Datenflut). */
  ids: string[];
  /** ISO-8601-UTC-Zeitstempel. */
  timestamp: string;
}

/** Senke, die einen Audit-Eintrag entgegennimmt. */
export type AuditSink = (entry: UniverseAuditEntry) => void | Promise<void>;

/** Begrenzt Quellenangaben auf ein harmloses, kurzes Format. */
export function sanitizeSource(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const clean = s.replace(/[^a-z0-9:_.-]/g, "").slice(0, 40);
  return clean || "unknown";
}

/** Datei-Senke auf Basis des NDJSON-Stores. */
export function fileAuditSink(store: NdjsonStore): AuditSink {
  return (entry) => {
    store.appendAudit(entry);
  };
}

/**
 * Optionale Datenbank-Senke. Wird nur aktiv, wenn `UNIVERSE_AUDIT_DB=1` gesetzt
 * ist; der DB-Import erfolgt dynamisch, damit die Registry ohne `DATABASE_URL`
 * importierbar und testbar bleibt.
 */
export async function writeDbAudit(entry: UniverseAuditEntry): Promise<void> {
  if (process.env.UNIVERSE_AUDIT_DB !== "1") return;
  try {
    const [{ db }, { auditLog }] = await Promise.all([import("../db"), import("../db/schema")]);
    await db.insert(auditLog).values({
      event: "UNIVERSE_MUTATION",
      level: "INFO",
      detail: entry as unknown as Record<string, unknown>,
    });
  } catch (e) {
    console.warn("[universe] Audit-DB-Senke fehlgeschlagen:", redactSecrets(e instanceof Error ? e.message : String(e)));
  }
}

/** Baut einen vollständigen Audit-Eintrag mit geklemmten Feldern. */
export function buildAuditEntry(params: {
  source: string;
  action: AuditAction;
  created?: number;
  updated?: number;
  removed?: number;
  rejected?: number;
  ids?: string[];
  now?: Date;
}): UniverseAuditEntry {
  const created = params.created ?? 0;
  const updated = params.updated ?? 0;
  const removed = params.removed ?? 0;
  return {
    actor: "system",
    source: sanitizeSource(params.source),
    action: params.action,
    changed: created + updated + removed,
    created,
    updated,
    rejected: params.rejected ?? 0,
    ids: (params.ids ?? []).slice(0, 25),
    timestamp: (params.now ?? new Date()).toISOString(),
  };
}
