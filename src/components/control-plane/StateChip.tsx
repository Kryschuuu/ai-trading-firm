"use client";

/**
 * Zustands-Chip einer Control-Plane-Ebene (Task 08).
 *
 * 6 Ebenen × 4 Zustaende (off/pending/active/error) — reine Anzeige,
 * XSS-sicher (nur JSX, kein innerHTML). Der `detail`-String kommt aus dem
 * Server, wird aber ausschliesslich als Text gerendert.
 */
import type { LayerStateValue } from "@/lib/controlPlane";

export const LAYER_LABELS: Record<string, string> = {
  connection: "Verbindung",
  marketDiscovery: "Markt-Discovery",
  permissions: "Berechtigungen",
  paper: "Paper",
  testnet: "Testnet",
  live: "Live",
};

const STATE_STYLES: Record<LayerStateValue, string> = {
  off: "border-slate-700 bg-slate-900/60 text-slate-500",
  pending: "border-amber-600/60 bg-amber-500/10 text-amber-300",
  active: "border-emerald-600/60 bg-emerald-500/10 text-emerald-300",
  error: "border-red-600/60 bg-red-500/10 text-red-300",
};

const STATE_LABELS: Record<LayerStateValue, string> = {
  off: "off",
  pending: "pending",
  active: "aktiv",
  error: "Fehler",
};

export default function StateChip({
  layerId,
  state,
  detail,
}: {
  layerId: string;
  state: LayerStateValue;
  detail?: string | null;
}) {
  const title = [LAYER_LABELS[layerId] ?? layerId, STATE_LABELS[state], detail]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${STATE_STYLES[state]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {LAYER_LABELS[layerId] ?? layerId}: {STATE_LABELS[state]}
    </span>
  );
}
