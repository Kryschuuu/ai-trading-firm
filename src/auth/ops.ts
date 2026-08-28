/**
 * Operations-Center-Stub (Task 10, Phase 1).
 *
 * Liefert die Cockpit-Hülle: Rolle, Live-Sperre, Modul-Karten ohne Widgets.
 * `liveEnabled` ist hart false — unabhängig von Env-Flags.
 */
import { LIVE_GATE_LOCKED_REASON } from "@/brokers/control-plane/config";
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
    summary: "Live-Trading bleibt gesperrt (Task 11).",
    status: "locked",
  },
];

export type OpsPayload = {
  ok: true;
  version: string;
  liveEnabled: false;
  liveLockedReason: string;
  actor: PublicActor | null;
  modules: readonly OpsModule[];
};

export function buildOpsPayload(actor: Actor | null): OpsPayload {
  return {
    ok: true,
    version: APP_VERSION,
    liveEnabled: false,
    liveLockedReason: LIVE_GATE_LOCKED_REASON,
    actor: actor ? toPublicActor(actor) : null,
    modules: OPS_MODULES,
  };
}
