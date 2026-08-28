/**
 * Operations-Center-Stub (Task 10, Phase 1; Live-Anzeige seit Task 11).
 *
 * Liefert die Cockpit-Hülle: Rolle, Live-Status, Modul-Karten ohne Widgets.
 * `liveEnabled` ist Projektion des zentralen Live-Gate-Enforcers über alle
 * Venues (nur true, wenn der Enforcer eine Live-Order erlauben würde) —
 * Default nach Task 11 weiter false, unabhängig von Env-Flags.
 */
import { BROKER_VENUE_IDS } from "@/contracts/broker";
import { evaluateLiveOrder } from "@/live-gate/enforcer";
import { APP_VERSION } from "@/lib/version";
import type { Actor, PublicActor } from "./types";
import { toPublicActor } from "./types";

export type OpsModuleStatus = "ready" | "stub" | "locked";

export type OpsModule = {
  id: string;
  title: string;
  summary: string;
  status: OpsModuleStatus;
  /** Optionaler Dashboard-Tab, den die Karte öffnen kann. */
  tab?: string;
  href?: string;
};

export const OPS_MODULES: readonly OpsModule[] = [
  {
    id: "universe",
    title: "Marktuniversum",
    summary: "Instrumenten-Registry (Task 01). Kacheln folgen in Phase 3.",
    status: "stub",
    href: "/docs?name=universe",
  },
  {
    id: "scanner",
    title: "Scanner & Score",
    summary: "Deterministischer Markt-Scanner (Task 04). Kacheln folgen in Phase 3.",
    status: "stub",
    href: "/docs?name=scanner",
  },
  {
    id: "portfolio",
    title: "Portfolio & Risk Guard",
    summary: "Optimizer und Guard-Kette (Task 05). Kacheln folgen in Phase 3.",
    status: "stub",
    href: "/docs?name=portfolio",
  },
  {
    id: "cycle",
    title: "Agenten-Zyklus",
    summary: "Tages-/Wochenroutine (Task 06). Kacheln folgen in Phase 3.",
    status: "stub",
    href: "/docs?name=handbuch",
  },
  {
    id: "routing",
    title: "MODEL_ROUTER",
    summary: "Deterministische Modellwahl (Task 09). Kacheln folgen in Phase 3.",
    status: "stub",
    href: "/docs?name=routing",
  },
  {
    id: "brokers",
    title: "Brokers & Venues",
    summary: "Control Plane (Task 08) — eigener Dashboard-Tab.",
    status: "ready",
    tab: "brokers",
  },
  {
    id: "live",
    title: "Live-Gate",
    summary: "Auditierte State-Machine (Task 11) — Live bleibt gesperrt bis zum vollständigen Durchlauf inkl. Human-Gate.",
    status: "locked",
    href: "/docs?name=live",
  },
];

export type OpsPayload = {
  ok: true;
  version: string;
  liveEnabled: boolean;
  liveLockedReason: string;
  actor: PublicActor | null;
  modules: readonly OpsModule[];
};

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

export function buildOpsPayload(actor: Actor | null): OpsPayload {
  const live = aggregateLiveGateStatus();
  return {
    ok: true,
    version: APP_VERSION,
    liveEnabled: live.liveEnabled,
    liveLockedReason: live.reason,
    actor: actor ? toPublicActor(actor) : null,
    modules: OPS_MODULES,
  };
}
