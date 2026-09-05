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
import type { EligibilityDiagnosticsSummary } from "@/scanner/eligibilityDiagnostics";
import type { MarketDataReadinessReport } from "./marketDataReadiness";

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
  /** Dokumentationsziel (kanonisch `/docs/<Datei>.md`). */
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
  /**
   * Additiv seit v1.27.0 (OPS-010): strukturierter Market-Data-Readiness-Report
   * (Registry/Discovered/Data-ready/Warming/Candles/Ticker/Spread/Scanner-ready).
   * `null`, wenn die Aggregation fail-soft fehlschlug — das Funnel-Format der
   * Sektionen bleibt davon unberührt (kein Breaking Change).
   */
  marketDataReadiness?: MarketDataReadinessReport | null;
  /**
   * Additiv seit v1.27.0 (OPS-010): Eligibility-Diagnose je abgelehntem
   * Instrument mit vollständigem Datenzustand (Monitoring; das
   * „erste Regel gewinnt“-Routing ist unverändert). Gedeckelt, `total` zählt voll.
   */
  eligibilityDiagnostics?: EligibilityDiagnosticsSummary | null;
  /**
   * Additiv seit v1.33.0 (OPS-011): Snapshot der Market-Data-Pipeline für die
   * Sektion „Market Data“ oberhalb des Funnels (Registry/Discovered/Data-ready/
   * Warming/Ticker/Spread/Scanner-ready + Venues + worstOffenders + Hint).
   * `null`, wenn die Aggregation fail-soft fehlschlug — Funnel und Sektionen
   * bleiben davon unberührt (kein Breaking Change).
   */
  marketData?: MarketDataOpsSnapshot | null;
};

/** Typwächter für die zehn Sektions-IDs. */
export function isOpsSectionId(value: unknown): value is OpsSectionId {
  return typeof value === "string" && (OPS_SECTION_IDS as readonly string[]).includes(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Market-Data-Ops-Snapshot (OPS-011) — Sektion „Market Data“ oberhalb des Funnels
// ─────────────────────────────────────────────────────────────────────────────

/** Ampelzustand des Snapshots: grün / gelb / rot (immer auch textkodiert). */
export type MarketDataReadinessStatus = "READY" | "WARMING" | "ERROR";

/** Venue-Zeile des Snapshots (aus dem persistierten Sync-Status, MDSYNC-001). */
export interface MarketDataOpsVenue {
  /** Venue-Key in Großbuchstaben (z. B. `"BITUNIX"`). */
  venue: string;
  /** Zeitpunkt des letzten Syncs (ISO-8601 UTC) oder `null` (nie gesynct). */
  lastSyncAt: string | null;
  /** `true`, wenn der letzte Lauf Fehler hatte, aber fortgesetzt wurde. */
  lastSyncDegraded: boolean;
  /** Instrumente dieser Venue in der Registry. */
  instruments: number;
  /** Fehlerzähler nach klassifizierter Ursache (geschlossene MDERR-006-Taxonomie). */
  failuresByReason: Record<string, number>;
}

/** Instrument mit zu wenig Kerzenhistorie („worst offender“). */
export interface MarketDataOpsOffender {
  /** Instrument-ID (`VENUE:SYMBOL`) — bewusst der einzige „Pfad“ im Snapshot. */
  instrumentId: string;
  /** Geladene Kerzen im Scanner-Timeframe. */
  candles: number;
  /** Benötigte Kerzen je Instrument (`requiredWarmupCandles`). */
  required: number;
}

/**
 * Snapshot der Market-Data-Pipeline für das Operations Center (OPS-011).
 *
 * Reine Lese-Aggregation (Registry + Historical Store + persistierter
 * Sync-Status) — kein Netzwerk-I/O, kein Sync-Trigger. Der Snapshot macht
 * sichtbar, **warum** der Scanner-Funnel leer ist: fehlende Kerzen (Warmup),
 * ausgefallene Abrufe (Infrastruktur) oder tatsächlich kein geeignetes
 * Instrument (fachlich). Semantik je Feld: `docs/MARKET_DATA_PIPELINE.md` §6.
 *
 * Security: nur Zähler, ISO-Zeitstempel, Instrument-IDs und die geschlossene
 * `reason`-Taxonomie — keine Credentials, keine Env-Variablen, keine internen
 * Dateipfade, keine Stacktraces. `venues` und `worstOffenders` sind gekappt.
 */
export interface MarketDataOpsSnapshot {
  /** Erzeugungszeitpunkt des Snapshots (ISO-8601 UTC). */
  generatedAt: string;
  /** Mindest-Kerzenzahl je Instrument (dynamisch aus dem Faktorsatz). */
  requiredCandles: number;
  /** Instrumente in der Registry. */
  registry: number;
  /** Per Sync entdeckt (`lastSeen` innerhalb des Frische-Fensters). */
  discovered: number;
  /** Instrumente mit ≥ `requiredCandles` Kerzen im Scanner-Timeframe. */
  dataReady: number;
  /** `registry − dataReady` (nie negativ) — noch im Warmup. */
  warming: number;
  /** Instrumente mit `volume24h !== null` (Ticker-Enrichment gelaufen). */
  tickerReady: number;
  /** Instrumente mit `spread !== null` (Orderbook-/depth-Enrichment gelaufen). */
  spreadReady: number;
  /** `true` genau dann, wenn `readinessStatus === "READY"`. */
  scannerReady: boolean;
  /**
   * Ampelzustand:
   * - `ERROR`   — echte Fetch-/Infrastrukturfehler (MDERR-006-Manifest nicht leer).
   * - `READY`   — jedes Registry-Instrument ist vollständig (Kerzen + Ticker + Spread).
   * - `WARMING` — sonst (Historie/Enrichment unvollständig oder Registry leer).
   */
  readinessStatus: MarketDataReadinessStatus;
  /** Sync-Zustand je Venue (gekappt, deterministisch sortiert). */
  venues: MarketDataOpsVenue[];
  /** Bis zu 10 Instrumente mit den wenigsten Kerzen (candles asc, id asc). */
  worstOffenders: MarketDataOpsOffender[];
  /** Kontextabhängiger, handlungsleitender Hinweis (`buildReadinessHint`). */
  hint: string;
}
