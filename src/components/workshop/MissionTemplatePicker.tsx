"use client";

import { useMemo, useState } from "react";
import InfoTip from "./InfoTip";
import type { MissionTemplateDto } from "@/lib/types";

/**
 * Vorlagen-Auswahl des Workshops (v1.35.0).
 *
 * Eine Vorlage ist eine **Blaupause**: „Übernehmen“ füllt das Missionsformular
 * links voraus (Titel, Ziel, Missions-Typ, Symbol/Segment, Budgets) — gespeichert
 * wird erst danach. Nichts wird hier direkt in die Datenbank geschrieben.
 *
 * Die Liste kommt vom Server (`GET /api/firm/missions` → `templates`), damit UI
 * und Validierung immer denselben Katalog nutzen (`src/lib/missionTemplates.ts`).
 */
export default function MissionTemplatePicker({
  templates,
  onApply,
  activeTemplateId = null,
}: {
  /** Vollständiger Vorlagenkatalog des Servers. */
  templates: MissionTemplateDto[];
  /** Wird beim Klick auf „Übernehmen“ mit der gewählten Vorlage aufgerufen. */
  onApply: (template: MissionTemplateDto) => void;
  /** Bereits übernommene Vorlage (Highlight + Hinweis im Formular). */
  activeTemplateId?: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string>(activeTemplateId ?? "");
  const [showInstalledOnly, setShowInstalledOnly] = useState(false);

  const visible = useMemo(
    () => (showInstalledOnly ? templates.filter((t) => t.seeded) : templates),
    [templates, showInstalledOnly]
  );

  /** Vorlagen nach Kategorie gruppieren (Reihenfolge = Katalog-Reihenfolge). */
  const groups = useMemo(() => {
    const order: string[] = [];
    const byCategory = new Map<string, { label: string; items: MissionTemplateDto[] }>();
    for (const template of visible) {
      let group = byCategory.get(template.category);
      if (!group) {
        group = { label: template.categoryLabel, items: [] };
        byCategory.set(template.category, group);
        order.push(template.category);
      }
      group.items.push(template);
    }
    return order.map((key) => ({ key, ...byCategory.get(key)! }));
  }, [visible]);

  const selected = templates.find((t) => t.id === selectedId) ?? null;
  const effSelected = selected ?? templates.find((t) => t.id === activeTemplateId) ?? null;
  const selectId = "mission-template";

  if (templates.length === 0) {
    return (
      <section aria-labelledby="mission-template-title" className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <h3 id="mission-template-title" className="text-sm font-bold text-slate-100">
          Vorlagen
        </h3>
        <p className="mt-2 text-xs text-slate-500">
          Vorlagenkatalog nicht geladen (Server antwortet nicht). Das Formular unten funktioniert
          weiterhin — Vorlagen erscheinen nach dem nächsten erfolgreichen Laden von{" "}
          <code className="font-mono">/api/firm/missions</code>.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="mission-template-title" className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="mb-1 flex items-center">
        <h3 id="mission-template-title" className="text-sm font-bold text-slate-100">
          1 · Vorlage wählen
        </h3>
        <InfoTip
          id="mission-template-title"
          label="Missions-Vorlagen"
          text="Wiederverwendbare Blaupausen: Eine Vorlage füllt das Formular voraus (Titel, Ziel, Missions-Typ, Budgets). Gespeichert wird erst durch „Mission anlegen“ — du kannst jedes Feld vorher ändern."
        />
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-slate-400">
          <input
            type="checkbox"
            checked={showInstalledOnly}
            onChange={(e) => setShowInstalledOnly(e.target.checked)}
            className="h-3.5 w-3.5 accent-sky-500"
          />
          nur mitinstallierte ({templates.filter((t) => t.seeded).length})
        </label>
      </div>
      <p className="mb-3 text-xs text-slate-500">
        {templates.length} Vorlagen · {templates.filter((t) => t.seeded).length} davon werden bei der
        Installation angelegt. Quelle: <code className="font-mono">src/lib/missionTemplates.ts</code>.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[16rem] flex-1">
          <label htmlFor={selectId} className="mb-1 block text-xs font-semibold text-slate-300">
            Vorlage
            <InfoTip
              id={selectId}
              label="Vorlage"
              text="Gruppiert nach Zweck: Einstieg & Einzelwerte, Markt-Scans (Segment), Strategien, Diagnose & Tests. Der Zusatz „wird mitinstalliert“ markiert die 14 Standard-Missionen."
            />
          </label>
          <select
            id={selectId}
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            aria-describedby={`${selectId}-tip`}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
          >
            <option value="">— Vorlage wählen —</option>
            {groups.map((group) => (
              <optgroup key={group.key} label={group.label}>
                {group.items.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.scopeLabel}
                    {t.seeded ? " · wird mitinstalliert" : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <button
          type="button"
          disabled={!selected}
          onClick={() => selected && onApply(selected)}
          className="rounded-lg border border-sky-600 bg-sky-500/10 px-3 py-2 text-xs font-bold text-sky-200 hover:bg-sky-500/20 disabled:opacity-40"
          aria-label="Gewählte Vorlage in das Missionsformular übernehmen"
        >
          ↓ In Formular übernehmen
        </button>
      </div>

      {effSelected && (
        <div className="mt-3 space-y-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-slate-100">{effSelected.name}</span>
            <span className="rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] font-semibold text-slate-200">
              {effSelected.riskProfileLabel}
            </span>
            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">
              {effSelected.scopeLabel}
              {effSelected.scope === "SCAN_UNIVERSE" && effSelected.segmentLabel ? `: ${effSelected.segmentLabel}` : ""}
              {effSelected.symbol ? `: ${effSelected.symbol}` : ""}
            </span>
            <span className="text-[10px] text-slate-400">
              Risiko {(effSelected.riskBudget * 100).toFixed(2)} % · max. Position{" "}
              {(effSelected.maxPositionPct * 100).toFixed(0)} %
            </span>
            {effSelected.seeded && (
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
                wird mitinstalliert
              </span>
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-slate-400">{effSelected.why}</p>
          <p className="text-[11px] text-slate-500">
            <span className="font-semibold text-slate-400">Risikoprofil:</span> {effSelected.riskProfileHint}
          </p>
          <p className="text-[11px] text-slate-500">
            <span className="font-semibold text-slate-400">Erfolg prüfbar über:</span>{" "}
            <code className="font-mono text-[10px]">{effSelected.successCriteria}</code>
          </p>
          <details className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
            <summary className="cursor-pointer text-[11px] font-semibold text-sky-300">
              Hilfe zu dieser Vorlage (Kurzinfo · Technik · Risiko)
            </summary>
            <dl className="mt-2 space-y-1.5 text-[11px] leading-relaxed">
              <div>
                <dt className="font-semibold text-slate-300">Kurzinfo</dt>
                <dd className="text-slate-400">{effSelected.help.kurzinfo}</dd>
              </div>
              <div>
                <dt className="font-semibold text-slate-300">Technische Info</dt>
                <dd className="text-slate-400">{effSelected.help.technischeInfo}</dd>
              </div>
              <div>
                <dt className="font-semibold text-slate-300">Risiko</dt>
                <dd className="text-amber-300/90">{effSelected.help.risiko}</dd>
              </div>
            </dl>
          </details>
        </div>
      )}
    </section>
  );
}
