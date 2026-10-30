"use client";

import type { FirmData } from "./types";

export default function AgentsTab({
  data,
  running,
  onRun,
}: {
  data: FirmData;
  running: string | null;
  onRun: (id: string) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4">
      {data.agents.map((a) => (
        <div key={a.id} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-100">{a.name}</h3>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase ${
                a.status === "RUNNING"
                  ? "bg-amber-500/20 text-amber-300"
                  : a.status === "BLOCKED"
                  ? "bg-red-500/20 text-red-300"
                  : "bg-emerald-500/20 text-emerald-300"
              }`}
            >
              {a.status}
            </span>
          </div>
          <p className="mb-1 text-xs font-semibold text-emerald-400">{a.role}</p>
          <p className="mb-1 text-xs text-slate-500">Model: {a.model}</p>
          <p className="mb-3 line-clamp-3 text-xs text-slate-400">{a.systemPrompt}</p>
          <button
            onClick={() => onRun(a.id)}
            disabled={running === a.id}
            className="w-full rounded-lg bg-slate-700 px-3 py-2 text-xs font-semibold text-slate-100 hover:bg-slate-600 disabled:opacity-50"
          >
            {running === a.id ? "Thinking…" : "▶ Run one turn"}
          </button>
        </div>
      ))}
    </div>
  );
}
