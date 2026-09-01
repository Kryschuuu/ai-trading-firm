"use client";

import { useState } from "react";
import type { AgentRow, MissionRow } from "@/lib/types";
import MissionsPanel from "./MissionsPanel";
import AgentRunPanel from "./AgentRunPanel";
import PromptPanel from "./PromptPanel";
import HitRatePanel from "./HitRatePanel";

/**
 * Workshop — das UI-Pendant zu Handbuch Kapitel 5 (Missionen) und 6 (Prompts
 * iterieren). Vier Schritte, passend zur Iterations-Schleife aus 6.1:
 * Mission schreiben → EINEN Agent einzeln laufen lassen → GENAU EINE Sache
 * am Prompt ändern → zehnmal wiederholen und Trefferquote zählen.
 */
export type WorkshopStep = "missions" | "run" | "prompt" | "hitrate";

const steps: { id: WorkshopStep; label: string; hint: string }[] = [
  { id: "missions", label: "1 · Mission anlegen", hint: "Handbuch 5.1–5.4 — Vorlage übernehmen, Missions-Typ wählen (Einzel-Symbol oder Markt-Scan), Auftrag definieren, bevor irgendein Agent läuft." },
  { id: "run", label: "2 · Agent ausführen", hint: "Handbuch 6.2 — einen Agenten einzeln laufen lassen und die Rohantwort prüfen." },
  { id: "prompt", label: "3 · Prompt iterieren", hint: "Handbuch 6.3 — genau eine Sache am Prompt ändern, wirkt sofort." },
  { id: "hitrate", label: "4 · Trefferquote", hint: "Handbuch 6.4 — Testschleife starten und die Verteilung zählen." },
];

export default function WorkshopTab({
  agents,
  missions,
  onChanged,
  onUnauthorized,
  onOpenProtocol,
}: {
  agents: AgentRow[];
  missions: MissionRow[];
  /** Firmzustand neu laden (nach Mission-/Prompt-Speichern). */
  onChanged: () => void;
  /** 401 → Token-Eingabe im Dashboard-Kopf anzeigen. */
  onUnauthorized: () => void;
  /** Sprung zum Protokoll-Tab für tiefes Debugging. */
  onOpenProtocol: () => void;
}) {
  const [step, setStep] = useState<WorkshopStep>("missions");
  const active = steps.find((s) => s.id === step)!;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-sky-800/50 bg-sky-500/5 px-4 py-3">
        <h2 className="text-sm font-bold text-sky-300">🛠 Workshop — Missionen &amp; Prompts ohne Terminal</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">
          Alles aus Handbuch Kapitel 5 und 6 als Oberfläche: Missionen aus Vorlagen anlegen
          (Einzel-Symbol oder Markt-Scan über ein Segment), einen Agenten einzeln prüfen, Prompts
          iterieren, Trefferquote messen. Die Schleife bleibt wie in 6.1:{" "}
          <span className="text-slate-200">ein Agent pro Test, eine Änderung pro Iteration.</span>{" "}
          Guardrails sind bewusst nicht von hier änderbar — sie leben im Code (Risk-&amp;-Guardrails-Tab).
        </p>
      </div>

      <nav aria-label="Workshop-Schritte" className="flex flex-wrap gap-2">
        {steps.map((s) => (
          <button
            key={s.id}
            onClick={() => setStep(s.id)}
            aria-current={step === s.id ? "step" : undefined}
            title={s.hint}
            className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${
              step === s.id
                ? "bg-sky-500 text-slate-950"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <p className="text-xs text-slate-500">{active.hint}</p>

      {step === "missions" && (
        <MissionsPanel missions={missions} onChanged={onChanged} onUnauthorized={onUnauthorized} />
      )}
      {step === "run" && (
        <AgentRunPanel
          agents={agents}
          missions={missions}
          onUnauthorized={onUnauthorized}
        />
      )}
      {step === "prompt" && (
        <PromptPanel agents={agents} onChanged={onChanged} onUnauthorized={onUnauthorized} />
      )}
      {step === "hitrate" && (
        <HitRatePanel
          agents={agents}
          missions={missions}
          onUnauthorized={onUnauthorized}
          onOpenProtocol={onOpenProtocol}
        />
      )}
    </div>
  );
}
