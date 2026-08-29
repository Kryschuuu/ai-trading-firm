/**
 * Operations Center — Vertragstypen (Task 10, vollständige Integration).
 *
 * Das Operations Center ist eine **Aggregations- und Control-Plane-Schicht**
 * über bestehende Module und APIs. Es besitzt bewusst keine eigene Fachlogik:
 * jede Sektion nennt ihre Quellen (`sources`) und liefert einen Ist-Zustand
 * (`status` + `metrics` + `items`) — oder einen begründeten Fehlerzustand.
 *
 * Es gibt keinen Platzhalter-Status mehr. Eine Sektion ist
 *   `ready`       — Quelle gelesen, Daten vorhanden
 *   `empty`       — Quelle erreichbar, aber ohne Daten (frischer Clone)
 *   `degraded`    — teilweise verfügbar (z. B. Remote-Checks aus)
 *   `locked`      — bewusst gesperrt (Live-Gate)
 *   `unavailable` — Quelle nicht erreichbar (DB/Dateisystem/Provider)
 */
import type { PublicActor } from "@/auth/types";

/** Die zehn Sektionen des Operations Centers (Reihenfolge = Anzeige). */
export const OPS_SECTION_IDS = [
  "market-universe",
  "scanner",
  "portfolio-analytics",
  "research-operations",
  "broker-operations",
  "llm-operations",
  "agent-operations",
  "risk",
  "audit",
  "help",
] as const;

export type OpsSectionId = (typeof OPS_SECTION_IDS)[number];

/** Laufzeitzustände einer Sektion (siehe Header — kein Platzhalter). */
export const OPS_SECTION_STATUSES = ["ready", "degraded", "empty", "locked", "unavailable"] as const;
export type OpsSectionStatus = (typeof OPS_SECTION_STATUSES)[number];

/** Farbton einer Kennzahl/Zeile. */
export type OpsTone = "neutral" | "good" | "warn" | "bad";

/** Eine Kennzahl der Sektion (Label/Wert-Paar, optional mit Ton und Hinweis). */
export type OpsMetric = {
  label: string;
  value: string;
  tone?: OpsTone;
  hint?: string;
};

/** Eine Detailzeile der Sektion (z. B. Top-Instrument, Venue, Audit-Ereignis). */
export type OpsItem = {
  label: string;
  value?: string;
  meta?: string;
  tone?: OpsTone;
};

/** Rohergebnis eines Kollektors (vor dem Zusammenführen mit dem Katalog). */
export type OpsSectionData = {
  id: OpsSectionId;
  status: OpsSectionStatus;
  /** Datenstand der Quelle (ISO-8601 UTC) oder `null`. */
  asOf: string | null;
  metrics: OpsMetric[];
  items: OpsItem[];
  /** Hinweis des Kollektors (z. B. „Remote-Checks sind Default aus“). */
  note: string | null;
  /** Redigierte Fehlermeldung, wenn die Quelle nicht lesbar war. */
  error: string | null;
};

/**
 * Katalogeintrag einer Sektion: Beschreibung + Quellen.
 * Enthält **keine** Laufzeitdaten — die liefert der Kollektor.
 */
export type OpsSectionDefinition = {
  id: OpsSectionId;
  title: string;
  summary: string;
  /** Bestehende Module/APIs, aus denen die Sektion aggregiert. */
  sources: readonly string[];
  /** Dashboard-Tab, den die Sektion direkt öffnen kann. */
  tab?: string;
  /** Dokumentationsziel (`/docs?name=…`). */
  href?: string;
  /** Hilfe-Key in `docs/help/ops.help.json`. */
  helpKey?: string;
};

/** Katalog + Laufzeitdaten — genau das, was `GET /api/ops` ausliefert. */
export type OpsSection = OpsSectionDefinition & {
  status: OpsSectionStatus;
  asOf: string | null;
  metrics: OpsMetric[];
  items: OpsItem[];
  note: string | null;
  error: string | null;
};

/** Wie viele Sektionen befinden sich in welchem Zustand. */
export type OpsHealth = {
  total: number;
  ready: number;
  degraded: number;
  empty: number;
  locked: number;
  unavailable: number;
};

/** Antwort von `GET /api/ops`. */
export type OpsPayload = {
  ok: true;
  version: string;
  generatedAt: string;
  /** Projektion des Live-Gate-Enforcers über alle Venues (Task 11). */
  liveEnabled: boolean;
  liveLockedReason: string;
  actor: PublicActor | null;
  sections: OpsSection[];
  health: OpsHealth;
};

/** Typwächter für die zehn Sektions-IDs. */
export function isOpsSectionId(value: unknown): value is OpsSectionId {
  return typeof value === "string" && (OPS_SECTION_IDS as readonly string[]).includes(value);
}
