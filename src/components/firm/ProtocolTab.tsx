"use client";

import AuditTrailPanel from "../common/AuditTrailPanel";
import ProtocolPanel from "../common/ProtocolPanel";

/**
 * Protokoll-Tab: Zwei unabhängige, aber identisch aufgebaute Bereiche.
 *
 * Beide nutzen dasselbe Paging-System (20/50/100/200 pro Seite, Default 20),
 * dieselbe aufklappbare Kartenstruktur und denselben „Rohdaten"-Reiter.
 * Die komplette Aufbereitung (deutsche Titel, Feldlabels, Plausibilitätsprüfung)
 * liegt in src/lib/auditView.ts — server- und clientseitig identisch.
 */
export default function ProtocolTab() {
  return (
    <div className="space-y-6">
      <ProtocolPanel />
      <AuditTrailPanel
        title="Audit-Trail"
        hint="Revisionssichere Ereignisse: jede Order, jede Entscheidung, jede Risiko- und Regeländerung."
      />
    </div>
  );
}
