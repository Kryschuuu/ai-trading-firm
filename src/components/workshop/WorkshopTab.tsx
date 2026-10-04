"use client";

/**
 * Workshop — das UI-Pendant zu Handbuch Kapitel 5 (Missionen), 6 (Prompts)
 * und 15.4 (Regel-Entwurf). Fünf Schritte: Mission schreiben → EINEN Agent
 * einzeln laufen lassen → GENAU EINE Sache am Prompt ändern → Trefferquote
 * zählen → Regel als DRAFT speichern und gegen den Store messen.
 */

import { useState } from "react";
import type { AgentRow, MissionRow } from "@/lib/types";
import TabBar, { TabPanel, type TabDef } from "@/components/ui/Tabs";
import MissionsPanel from "./MissionsPanel";
import AgentRunPanel from "./AgentRunPanel";
import PromptPanel, { type PromptDraftSeed } from "./PromptPanel";
import HitRatePanel from "./HitRatePanel";
import RuleBacktestPanel from "./RuleBacktestPanel";

export type WorkshopStep = "missions" | "run" | "prompt" | "hitrate" | "rulebacktest";

/**
 * Die fünf Workshop-Schritte. `hint` steht als Tooltip am Reiter und als
 * Erklärzeile darunter — die Reihenfolge ist die Arbeitsreihenfolge und
 * entspricht Handbuch 5, 6 und 15.4.
 */
const steps: readonly TabDef<WorkshopStep>[] = [
  { id: "missions", label: "1 · Mission anlegen", title: "Handbuch 5.1–5.4 — Vorlage übernehmen, Missions-Typ wählen (Einzel-Symbol oder Markt-Scan), Auftrag definieren, bevor irgendein Agent läuft." },
  { id: "run", label: "2 · Agent ausführen", title: "Handbuch 6.2 — einen Agenten einzeln laufen lassen und die Rohantwort prüfen." },
  { id: "prompt", label: "3 · Prompt iterieren", title: "Handbuch 6.3 — genau eine Sache am Prompt ändern, wirkt sofort." },
  { id: "hitrate", label: "4 · Trefferquote", title: "Handbuch 6.4 — Testschleife starten und die Verteilung zählen." },
  { id: "rulebacktest", label: "5 · Regel prüfen", title: "Handbuch 15.4 — Bedingungen setzen, als DRAFT speichern und den Paper-Store messen. Keine Aktivierung." },
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
  const [promptSeed, setPromptSeed] = useState<PromptDraftSeed | null>(null);
  const active = steps.find((s) => s.id === step)!;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-sky-800/50 bg-sky-500/5 px-4 py-3">
        <h2 className="text-sm font-bold text-sky-300">🛠 Workshop — Missionen &amp; Prompts ohne Terminal</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">
          Alles aus Handbuch Kapitel 5 und 6 als Oberfläche: Missionen aus Vorlagen anlegen
          (Einzel-Symbol oder Markt-Scan über ein Segment), einen Agenten einzeln prüfen, Prompts
          iterieren, Trefferquote messen, eine Regel nur als Entwurf gegen den Store prüfen.
          Die Schleife bleibt wie in 6.1:{" "}
          <span className="text-slate-200">ein Agent pro Test, eine Änderung pro Iteration.</span>{" "}
          Guardrails sind bewusst nicht von hier änderbar — sie leben im Code (Risk-&amp;-Guardrails-Tab).
        </p>
      </div>

      {/* Die Schritte sind eine zweite Ebene unter der Dashboard-Reiterleiste:
          gleiche Bedienung (Pfeiltasten, ARIA), aber nicht sticky — sonst
          überlagerten sich die beiden Leisten. `active` blendet die anderen
          Schritte aus; ohne das stünden alle fünf untereinander. */}
      <TabBar
        tabs={steps}
        active={step}
        onChange={setStep}
        ariaLabel="Workshop-Schritte"
        idPrefix="workshop"
        sticky={false}
      />
      <p className="-mt-2 text-xs text-slate-500">{active.title}</p>

      <TabPanel id="missions" idPrefix="workshop" active={step === "missions"}>
        <MissionsPanel missions={missions} onChanged={onChanged} onUnauthorized={onUnauthorized} />
      </TabPanel>
      <TabPanel id="run" idPrefix="workshop" active={step === "run"}>
        <AgentRunPanel
          agents={agents}
          missions={missions}
          onUnauthorized={onUnauthorized}
          onCopyRaw={(text) => {
            setPromptSeed({ nonce: Date.now(), text });
            setStep("prompt");
          }}
        />
      </TabPanel>
      <TabPanel id="prompt" idPrefix="workshop" active={step === "prompt"}>
        <PromptPanel
          agents={agents}
          onChanged={onChanged}
          onUnauthorized={onUnauthorized}
          draftSeed={promptSeed}
        />
      </TabPanel>
      <TabPanel id="hitrate" idPrefix="workshop" active={step === "hitrate"}>
        <HitRatePanel
          agents={agents}
          missions={missions}
          onUnauthorized={onUnauthorized}
          onOpenProtocol={onOpenProtocol}
        />
      </TabPanel>
      <TabPanel id="rulebacktest" idPrefix="workshop" active={step === "rulebacktest"}>
        <RuleBacktestPanel onUnauthorized={onUnauthorized} />
      </TabPanel>
    </div>
  );
}
