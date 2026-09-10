"use client";

import type { FirmIssue } from "@/lib/firmSession";

/**
 * Hinweisbox für einen fehlgeschlagenen Firm-Load (v1.36.41).
 *
 * Titel und Anleitung kommen aus der Klassifikation
 * (`classifyFirmFailure` in `src/lib/firmSession.ts`) — die Box selbst
 * enthält keine Ursache-Vermutung mehr. Der DB-Rat
 * („PostgreSQL / `DATABASE_URL` / `drizzle-kit push`") erscheint nur noch bei
 * `kind: "database"`; ein `401` nach Session-Ablauf zeigt stattdessen den
 * nächsten Schritt (Anmeldung), statt die Datenbank zu beschuldigen.
 */
export function FirmIssueBox({ issue }: { issue: FirmIssue }) {
  const authRelated = issue.needsLogin;
  return (
    <div
      className="mb-4 rounded-xl border border-amber-800/60 bg-amber-950/30 px-4 py-3 text-xs leading-relaxed text-amber-200"
      role="status"
    >
      <p className="font-bold text-amber-100">{issue.title}</p>
      <p className="mt-1">
        {issue.detail}{" "}
        {authRelated
          ? "Nach der Anmeldung lädt der Firm-Status automatisch neu — kein F5 nötig."
          : "Die Modul-Tabs (Operations Center, Brokers & Venues) funktionieren weiter — ihre Quellen sind lokal."}
      </p>
      {issue.hint && <p className="mt-1 text-amber-300/80">{issue.hint}</p>}
    </div>
  );
}
