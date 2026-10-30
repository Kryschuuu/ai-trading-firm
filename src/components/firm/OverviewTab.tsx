"use client";

import { firstSentence } from "@/lib/auditView";
import { missionScopeLabel } from "@/lib/missionTemplates";
import InfoTip from "../ui/InfoTip";
import DataTable from "../ui/DataTable";
import Chip from "../ui/Chip";
import { SECTION_TITLE } from "../ui/layout";
import AuditTrailPanel from "../common/AuditTrailPanel";
import type { FirmData } from "./types";

/**
 * Überblick: Missionen, Positionen, Approval-Queue, Audit-Trail.
 *
 * Anordnung seit v0.15.0 nach Informationswert statt nach Eingangsreihenfolge:
 * Die **Positionen** stehen zuerst und über die volle Breite (10 Spalten,
 * auf Ultrawide ohne Umbruch lesbar), darunter **Missionen** und
 * **Approval-Queue** nebeneinander — das sind die beiden Listen, die man
 * beim Durchsehen vergleicht. Der Audit-Trail bleibt am Ende (Detailtiefe).
 */
export default function OverviewTab({ data }: { data: FirmData }) {
  return (
    <div className="space-y-6">
      <section>
        <h2 className={SECTION_TITLE}>
          Positionen
          <InfoTip
            label="Positionen"
            text="Alle vom Executor eröffneten Positionen inklusive Marktwert, Stop-Loss, Take-Profit und schwebendem P&L. Gezeigt werden die ersten 15 Datensätze."
          />
        </h2>
        <DataTable
          label="Positionen"
          maxHeight="70vh"
          stickyHead
          head={["Status", "Symbol", "Side", "Menge", "Einstieg", "SL", "TP", "Kurs", "PnL", "Exit-Grund"]}
          empty="Keine Positionen. Pipeline oder Executor gegen eine aktive Mission laufen lassen."
          rows={data.positions.slice(0, 15).map((p) => [
            p.status,
            <span key={`${p.id}-symbol`} className="font-semibold text-slate-200">{p.symbol}</span>,
            p.side,
            p.qty,
            p.entryPrice,
            p.stopLoss ?? "—",
            p.takeProfit ?? "—",
            p.lastPrice ?? "—",
            <span
              key={p.id}
              className={(Number(p.unrealizedPnl) >= 0 ? "text-emerald-400" : "text-red-400") + " font-semibold tabular-nums"}
            >
              {(Number(p.unrealizedPnl) >= 0 ? "+" : "") + Number(p.unrealizedPnl).toFixed(2)}
            </span>,
            p.exitReason ?? "—",
          ])}
        />
      </section>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section>
          <h2 className={SECTION_TITLE}>Missionen</h2>
          <DataTable
            label="Missionen"
            head={["Titel", "Ziel", "Symbol / Segment", "Risikobudget", "Status"]}
            empty="Keine Mission angelegt — „Seed / Reset“ im Kopfbereich legt das Standard-Team an."
            rows={data.missions.map((m) => [
              <span key={m.id} className="font-semibold text-slate-200">{m.title}</span>,
              // Auf Wortgrenze gekürzt, vollständiger Text im Tooltip — kein harter Schnitt mitten im Wort.
              <span key={`${m.id}-objective`} title={m.objective} className="block">
                {firstSentence(m.objective, 120)}
              </span>,
              // Missions-Typ (v1.35.0): Einzel-Symbol oder „Markt-Scan: <Segment>“.
              <span key={`${m.id}-scope`} title={m.symbol ?? missionScopeLabel(m)}>
                {missionScopeLabel(m)}
              </span>,
              `${(Number(m.riskBudget) * 100).toFixed(0)} %`,
              <Chip key={`${m.id}-status`} tone={m.status === "ACTIVE" ? "good" : "neutral"}>
                {m.status}
              </Chip>,
            ])}
          />
        </section>

        <section>
          <h2 className={SECTION_TITLE}>Approval Queue</h2>
          <DataTable
            label="Approval Queue"
            head={["Aktion", "Vorgeschlagene Order", "Risiko-Score", "Status"]}
            empty="Keine offenen Vorschläge."
            rows={data.proposals.map((p) => {
              const detail = p.proposedDetail ?? {};
              const summary = [
                detail.symbol ? String(detail.symbol) : null,
                detail.side ? String(detail.side).toUpperCase() : null,
                detail.reason ? String(detail.reason) : null,
              ]
                .filter((part): part is string => Boolean(part))
                .join(" · ");
              return [
                p.action,
                <details key={p.id}>
                  <summary className="cursor-pointer text-slate-300">
                    {summary || "Details anzeigen"}
                  </summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950/60 p-2 font-mono text-xs text-slate-300">
                    {JSON.stringify(detail, null, 2)}
                  </pre>
                </details>,
                p.riskScore,
                <Chip key={`${p.id}-status`} tone="info">{p.status}</Chip>,
              ];
            })}
          />
        </section>
      </div>

      {/* Audit-Trail: aufklappbar, vollständig geparst, mit Paging (20/50/100/200). */}
      <AuditTrailPanel
        title="Audit Trail"
        hint="Alle revisionssicheren Ereignisse — aufklappbar mit lesbaren Details, logischer Bewertung und Rohdaten."
      />
    </div>
  );
}
