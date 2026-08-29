/**
 * Operations Center — Sektionskatalog und RBAC-Projektion (Task 10).
 *
 * Das Operations Center ist die Control Plane der Firma: zehn Sektionen, jede
 * mit echten Daten aus einem bestehenden Modul (Universum, Scanner, Portfolio,
 * Zyklen, Broker, Routing, Agenten, Risiko, Audit, Hilfe). Es gibt keine
 * Platzhalter-Sektionen mehr — der Platzhalter-Zustand ist aus dem
 * Zustandsraum entfernt und durch begründete Ist-Zustände ersetzt.
 *
 * Dieses Modul hält den **Katalog** (Beschreibung + Quellen) und die
 * RBAC-Projektion (Rolle, Live-Status). Die Ist-Daten liefert `src/ops`;
 * zusammengesetzt wird beides in {@link buildOpsPayload}.
 *
 * `liveEnabled` ist die Projektion des zentralen Live-Gate-Enforcers über alle
 * Venues (nur true, wenn der Enforcer eine Live-Order erlauben würde). Es ist
 * unabhängig von Env-Flags und bleibt im Auslieferungszustand false.
 */
import { BROKER_VENUE_IDS } from "@/contracts/broker";
import { evaluateLiveOrder } from "@/live-gate/enforcer";
import { APP_VERSION } from "@/lib/version";
import {
  type OpsHealth,
  type OpsPayload,
  type OpsSection,
  type OpsSectionData,
  type OpsSectionDefinition,
  type OpsSectionId,
} from "@/ops/types";
import type { Actor } from "./types";
import { toPublicActor } from "./types";

/**
 * Die zehn Sektionen des Operations Centers in Anzeigereihenfolge.
 * `sources` nennt die bestehenden Module/APIs, aus denen aggregiert wird —
 * die Sektion erfindet keine eigene Datenquelle.
 */
export const OPS_SECTIONS: readonly OpsSectionDefinition[] = [
  {
    id: "market-universe",
    title: "Market Universe",
    summary:
      "Instrumenten-Registry: Bestand je Venue, Datenstand und Ausschluss-Policy. Single Source of Truth für alles, was handelbar ist.",
    sources: ["src/universe (InstrumentRegistry)", "GET /api/universe/daily"],
    href: "/docs?name=universe",
    helpKey: "section.marketUniverse",
  },
  {
    id: "scanner",
    title: "Scanner",
    summary:
      "Deterministischer 14-Faktoren-Scan: Trichter von „gescannt“ bis „Deep-Dive“ und die aktuelle Tagesrotation nach Market Score.",
    sources: ["src/scanner", "GET /api/universe/daily"],
    href: "/docs?name=scanner",
    helpKey: "section.scanner",
  },
  {
    id: "portfolio-analytics",
    title: "Portfolio Analytics",
    summary:
      "Offene Positionen, Exposure, Eigenkapital und Tagesergebnis — bewertet über die deterministische Kennzahlen-Schicht des Portfolio-Moduls.",
    sources: ["GET /api/firm", "src/portfolio", "GET /api/portfolio/metrics"],
    href: "/docs?name=portfolio",
    helpKey: "section.portfolio",
  },
  {
    id: "research-operations",
    title: "Research Operations",
    summary:
      "Tages- und Wochenläufe des Makro-Zyklus: Status, Dauer, Artefakte und die Weekly-Klassifikation CORE/ROTATION/DISCOVERY.",
    sources: ["src/cycle", "GET /api/analysis/runs", "GET /api/analysis/weekly/latest"],
    href: "/docs?name=handbuch",
    helpKey: "section.research",
  },
  {
    id: "broker-operations",
    title: "Broker Operations",
    summary:
      "Sieben Venues mit Capabilities, verfügbaren Execution-Modi und lokalem Health-Status. Credentials und Live-Freigabe gehören in den Broker-Tab.",
    sources: ["GET /api/brokers", "src/brokers", "src/brokers/control-plane"],
    tab: "brokers",
    href: "/docs?name=brokers",
    helpKey: "section.brokers",
  },
  {
    id: "llm-operations",
    title: "LLM Operations",
    summary:
      "MODEL_ROUTER im Betrieb: Policy-Version, Modus, Provider-Health, Tagesbudget und die letzten Routing-Entscheidungen je Agent.",
    sources: ["GET /api/routing", "src/routing", "GET /api/firm (lokaler Provider)"],
    href: "/docs?name=routing",
    helpKey: "section.llm",
  },
  {
    id: "agent-operations",
    title: "Agent Operations",
    summary:
      "Die Belegschaft der Firma: Rollen, Status, aktive Missionen und wann zuletzt gesprochen wurde.",
    sources: ["GET /api/firm", "GET /api/firm/agents"],
    href: "/docs?name=architecture",
    helpKey: "section.agents",
  },
  {
    id: "risk",
    title: "Risk",
    summary:
      "Wirksame Guardrails: Limits, Volatilitäts-Regime, Kill-Switch und die Freigabelage des Live-Gates. Kein Order-Pfad umgeht diese Kette.",
    sources: ["src/lib/riskGuard", "src/lib/adaptiveRisk", "src/live-gate"],
    tab: "risk",
    href: "/docs?name=security",
    helpKey: "section.risk",
  },
  {
    id: "audit",
    title: "Audit",
    summary:
      "Audit-Trail mit Warnungen und kritischen Ereignissen plus die Integrität der Live-Gate-Hash-Kette (Manipulationserkennung).",
    sources: ["GET /api/firm/log", "src/live-gate/audit"],
    tab: "protocol",
    href: "/docs?name=security",
    helpKey: "section.audit",
  },
  {
    id: "help",
    title: "Help",
    summary:
      "Hilfe-Systematik und Dokumentationsportal: jede Hilfe-Datei im 3-Ebenen-Schema, jedes Handbuch direkt erreichbar.",
    sources: ["docs/help/*.help.json", "GET /api/docs"],
    href: "/docs?name=handbuch",
    helpKey: "section.help",
  },
];

/** Typ-Reexport: der Sektionskatalog ist Teil der öffentlichen Auth-API. */
export type { OpsSectionDefinition };

/** Schnellzugriff: Katalogeintrag je Sektions-ID. */
export const OPS_SECTION_BY_ID: Readonly<Record<OpsSectionId, OpsSectionDefinition>> = Object.fromEntries(
  OPS_SECTIONS.map((section) => [section.id, section])
) as Record<OpsSectionId, OpsSectionDefinition>;

/**
 * Aggregierter Live-Status: true nur, wenn der Enforcer für IRGENDEIN Venue
 * eine Live-Order erlauben würde (State-Machine + Flags + Suite + kein Kill).
 * Read-only (audit:false) — die Abfrage selbst erzeugt keine Audit-Einträge.
 */
export function aggregateLiveGateStatus(): { liveEnabled: boolean; reason: string } {
  let reason = "LIVE_GATE_LOCKED: Kein Venue im State LIVE_ENABLED (Live-Gate-State-Machine, Task 11).";
  for (const venue of BROKER_VENUE_IDS) {
    try {
      const decision = evaluateLiveOrder(venue, { audit: false });
      if (decision.allowed) {
        return { liveEnabled: true, reason: decision.reason };
      }
      if (decision.code === "KILL_SWITCH_ACTIVE") {
        reason = decision.reason;
      }
    } catch {
      /* einzelne Venue nicht bewertbar → weiter deny (fail-safe). */
    }
  }
  return { liveEnabled: false, reason };
}

/** Ersatzdatensatz, falls ein Kollektor keine Daten liefert (nie Platzhalter). */
function missingData(id: OpsSectionId): OpsSectionData {
  return {
    id,
    status: "unavailable",
    asOf: null,
    metrics: [],
    items: [],
    note: null,
    error: "Sektion wurde nicht aggregiert (Kollektor fehlt).",
  };
}

/** Zählt die Sektionen je Zustand (Kopfzeile des Cockpits). */
export function summarizeSections(sections: readonly OpsSection[]): OpsHealth {
  const health: OpsHealth = { total: sections.length, ready: 0, degraded: 0, empty: 0, locked: 0, unavailable: 0 };
  for (const section of sections) health[section.status] += 1;
  return health;
}

/**
 * Setzt Katalog und Ist-Daten zum Antwort-Payload zusammen.
 * Rein und synchron — Testbarkeit ohne Datenbank/Netzwerk.
 */
export function buildOpsPayload(
  actor: Actor | null,
  data: Readonly<Partial<Record<OpsSectionId, OpsSectionData>>> = {}
): OpsPayload {
  const live = aggregateLiveGateStatus();
  const sections: OpsSection[] = OPS_SECTIONS.map((definition) => {
    const collected = data[definition.id] ?? missingData(definition.id);
    return {
      ...definition,
      status: collected.status,
      asOf: collected.asOf,
      metrics: collected.metrics,
      items: collected.items,
      note: collected.note,
      error: collected.error,
    };
  });

  return {
    ok: true,
    version: APP_VERSION,
    generatedAt: new Date().toISOString(),
    liveEnabled: live.liveEnabled,
    liveLockedReason: live.reason,
    actor: actor ? toPublicActor(actor) : null,
    sections,
    health: summarizeSections(sections),
  };
}
