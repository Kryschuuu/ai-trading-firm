/**
 * ASA-02 — zustandsbehaftetes, kryptographisches Vier-Augen-Verfahren.
 *
 * Vorher genügte ein einziger Request mit zwei frei wählbaren Strings
 * (`actor`/`approvedBy` bzw. `operator`/`secondApprover`) aus demselben Body.
 * Dieses Modul erzwingt stattdessen ZWEI getrennte Requests zweier
 * **unterschiedlicher authentifizierter Principals**:
 *
 *   1. `proposeFourEyes()`  — speichert den serverseitig verifizierten
 *      HMAC-Fingerprint (`Principal.id`) des Antragstellers zusammen mit einer
 *      zufälligen `approvalId`, einem Intent-Fingerprint und einer Ablaufzeit.
 *   2. `consumeFourEyes()`  — verlangt dieselbe `approvalId`, denselben Intent
 *      und einen ANDEREN Principal (`approverPrincipalId !==
 *      proposerPrincipalId`). Nur dann wird der Datensatz atomar verbraucht
 *      (single-use) und die Transition darf vollzogen werden.
 *
 * `distinct: false` (local-open, kein Credential) wird an BEIDEN Schritten
 * fail-closed abgelehnt: ohne getrennte authentifizierte Principals gibt es
 * kein Vier-Augen-Prinzip.
 *
 * Speicher: zentrale State-Registry (Single-Node, RAM, HMR-sicher), analog zu
 * Rate-Limiter und Disarm-Challenge. Ein Prozessneustart verwirft offene
 * Freigaben — das ist gewollt (kein stilles Wiederaufleben alter Anträge).
 * Die Live-Gate-State-Machine nutzt dieselben Helfer mit ihrem eigenen,
 * crash-sicheren Venue-State-File (siehe `src/live-gate/service.ts`).
 */
import { randomUUID } from "node:crypto";
import { state } from "./stateRegistry";

/** Gültigkeit einer Erstfreigabe (ASA-02: 15 Minuten). */
export const FOUR_EYES_TTL_MS = 15 * 60_000;

/** Minimal nötige, bereits authentifizierte Aufrufer-Identität. */
export type FourEyesActor = {
  /** HMAC-Fingerprint der verifizierten Identität. */
  id: string;
  /** false = local-open / nicht unterscheidbar ⇒ fail-closed. */
  distinct: boolean;
  /** Kurze Audit-ID (Services dürfen hier auch einen Freitext-Akteur nennen). */
  auditId?: string;
};

/**
 * Persistierter Freigabe-Datensatz. `approvedBy` ist NUR noch ein
 * nicht-autorisierendes Anzeigelabel (Kompatibilität mit bestehenden
 * State-Dateien/Tests); die Autorisierung läuft ausschließlich über
 * `proposerPrincipalId`.
 */
export interface FourEyesPending {
  /** Zufälliges, unguessable Token, das Schritt 2 vorlegen muss. */
  approvalId: string;
  /** Bindung an genau diesen Übergang (Ziel/Intent darf nicht getauscht werden). */
  intent: string;
  /** HMAC-Fingerprint des Antragstellers — DER Vergleichswert für Vier-Augen. */
  proposerPrincipalId: string;
  /** Ablaufzeit (epoch ms). */
  expiresAt: number;
  /** Nur im RAM-Store gesetzt; persistente Stores kennen ihren Scope selbst. */
  scope?: string;
  /** Reine Audit-/Anzeigefelder (optional für Legacy-State-Dateien). */
  proposerAuditId?: string;
  approvedBy?: string;
  at?: string;
  createdAt?: number;
}

export type FourEyesDenyReason =
  | "PRINCIPALS_REQUIRED"
  | "NO_PROPOSAL"
  | "APPROVAL_ID_REQUIRED"
  | "WRONG_APPROVAL_ID"
  | "EXPIRED"
  | "SAME_PRINCIPAL"
  | "INTENT_MISMATCH";

export type FourEyesResult =
  | { ok: true; pending: FourEyesPending }
  | { ok: false; reason: FourEyesDenyReason };

const HINTS: Record<FourEyesDenyReason, string> = {
  PRINCIPALS_REQUIRED:
    "Vier-Augen-Live-Freigaben erfordern zwei getrennte authentifizierte Principals. Im local-open-Modus (AUTH_MODE=local-open, kein Token) ist das nicht möglich — Tokens/Sessions konfigurieren.",
  NO_PROPOSAL:
    "Keine gültige Erstfreigabe vorhanden. Zuerst Schritt 1 (propose) mit einem authentifizierten Principal ausführen.",
  APPROVAL_ID_REQUIRED:
    "approvalId der Erstfreigabe fehlt. Schritt 2 muss dieselbe approvalId aus Schritt 1 vorlegen.",
  WRONG_APPROVAL_ID:
    "approvalId passt nicht zur offenen Erstfreigabe (oder die Freigabe wurde ersetzt).",
  EXPIRED:
    `Erstfreigabe ist abgelaufen (TTL ${FOUR_EYES_TTL_MS / 60_000} Minuten). Neuen Antrag stellen.`,
  SAME_PRINCIPAL:
    "Vier-Augen-Prinzip verletzt: Gegenzeichnung stammt vom selben authentifizierten Principal wie der Antrag. Freitextnamen im Body zählen nicht — ein anderes Credential bzw. eine andere Session ist erforderlich.",
  INTENT_MISMATCH:
    "Die Erstfreigabe galt für einen anderen Übergang (Zielzustand/Strategie geändert). Neuen Antrag stellen.",
};

export function fourEyesHint(reason: FourEyesDenyReason): string {
  return HINTS[reason];
}

/** Eindeutiger Scope-Schlüssel (Domain + Zielobjekt), z. B. venue oder Strategie. */
export function fourEyesScope(domain: "lifecycle" | "live-gate", parts: readonly string[]): string {
  return `${domain}:${parts.map((p) => p.replace(/:/g, "%3A")).join(":")}`;
}

/** Intent bindet die Freigabe an genau diesen Übergang (kein Ziel-Tausch). */
export function fourEyesIntent(parts: readonly (string | number)[]): string {
  return parts.join("|");
}

/** Nur für Tests / Notfall-Reset: alle offenen Erstfreigaben verwerfen. */
export function resetFourEyesApprovalsForTests(): void {
  state.fourEyesApprovals.clear();
}

/** Abgelaufene Datensätze entfernen (lazy Sweep, Speicher-Hygiene). */
function sweep(now: number): void {
  const store = state.fourEyesApprovals.get();
  for (const [scope, entry] of store) {
    if (now > entry.expiresAt) store.delete(scope);
  }
}

/**
 * Erzeugt einen Erstfreigabe-Datensatz, ohne ihn zu speichern. Für Stores, die
 * ihre Pending-Freigabe selbst persistieren (Live-Gate-State-File). Liefert
 * `null`, wenn kein unterscheidbarer authentifizierter Principal vorliegt.
 */
export function createFourEyesPending(input: {
  scope?: string;
  intent: string;
  principal: FourEyesActor;
  /** Nicht autorisierendes Anzeigelabel für Audits (nie für den Vergleich). */
  approvedBy?: string;
  now?: number;
}): FourEyesPending | null {
  if (!input.principal.distinct || !input.principal.id) return null;
  const now = input.now ?? Date.now();
  return {
    approvalId: randomUUID(),
    scope: input.scope,
    intent: input.intent,
    proposerPrincipalId: input.principal.id,
    proposerAuditId: input.principal.auditId,
    approvedBy: (input.approvedBy ?? input.principal.auditId ?? "unknown").slice(0, 64),
    at: new Date(now).toISOString(),
    createdAt: now,
    expiresAt: now + FOUR_EYES_TTL_MS,
  };
}

/**
 * Schritt 1 — Erstfreigabe (Antrag) eines authentifizierten Principals.
 * Ein neuer Antrag ersetzt einen offenen Antrag desselben Scopes bewusst.
 */
export function proposeFourEyes(input: {
  scope: string;
  intent: string;
  principal: FourEyesActor;
  approvedBy?: string;
  now?: number;
}): FourEyesResult {
  const now = input.now ?? Date.now();
  const pending = createFourEyesPending({ ...input, now });
  if (!pending) return { ok: false, reason: "PRINCIPALS_REQUIRED" };
  sweep(now);
  state.fourEyesApprovals.get().set(input.scope, pending);
  return { ok: true, pending };
}

/** Reine Prüfung eines bestehenden Datensatzes (auch für persistente Stores). */
export function evaluateFourEyes(
  pending: FourEyesPending | null | undefined,
  input: {
    intent: string;
    approver: FourEyesActor;
    approvalId?: string;
    now?: number;
  }
): FourEyesResult {
  const now = input.now ?? Date.now();
  if (!pending) return { ok: false, reason: "NO_PROPOSAL" };
  if (!input.approver.distinct || !input.approver.id || !pending.proposerPrincipalId) {
    return { ok: false, reason: "PRINCIPALS_REQUIRED" };
  }
  if (now > pending.expiresAt) return { ok: false, reason: "EXPIRED" };
  if (!input.approvalId) return { ok: false, reason: "APPROVAL_ID_REQUIRED" };
  if (input.approvalId !== pending.approvalId) {
    return { ok: false, reason: "WRONG_APPROVAL_ID" };
  }
  if (input.intent !== pending.intent) return { ok: false, reason: "INTENT_MISMATCH" };
  if (input.approver.id === pending.proposerPrincipalId) {
    return { ok: false, reason: "SAME_PRINCIPAL" };
  }
  return { ok: true, pending };
}

/**
 * Schritt 2 — Gegenzeichnung und atomarer Verbrauch. Nur bei `ok: true` wurde
 * der Datensatz gelöscht; jeder weitere Versuch scheitert an `NO_PROPOSAL`.
 */
export function consumeFourEyes(input: {
  scope: string;
  intent: string;
  approver: FourEyesActor;
  approvalId?: string;
  now?: number;
}): FourEyesResult {
  const now = input.now ?? Date.now();
  const store = state.fourEyesApprovals.get();
  sweep(now);
  const pending = store.get(input.scope);
  const decision = evaluateFourEyes(pending, { ...input, now });
  if (!decision.ok) {
    // Abgelaufene Einträge nicht als Zombie behalten.
    if (decision.reason === "EXPIRED") store.delete(input.scope);
    return decision;
  }
  store.delete(input.scope);
  return decision;
}

/** Lesender Zugriff für Statusanzeigen (kein Verbrauch). */
export function peekFourEyes(scope: string, now: number = Date.now()): FourEyesPending | null {
  sweep(now);
  return state.fourEyesApprovals.get().get(scope) ?? null;
}
