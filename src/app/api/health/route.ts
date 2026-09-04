import { auditDurabilitySnapshot } from "@/lib/auditSink";
import { checkSchema } from "@/lib/seed";
import { APP_NAME, APP_VERSION } from "@/lib/version";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";

/**
 * Healthcheck-Endpunkt.
 *
 * Antwortet IMMER mit HTTP 200 (damit systemd, Proxies und die Sandbox den
 * Dienst nicht als "down" einstufen solange er läuft).
 *
 * Das Feld "schemaReady" zeigt an ob die Tabellen existieren:
 *   schemaReady: true  → vollständig betriebsbereit
 *   schemaReady: false → Dienst läuft, aber "npx drizzle-kit push" fehlt noch
 *
 * Monitoring-Systeme die zwischen "Process up" und "DB ready" unterscheiden
 * wollen, können das Feld auswerten. Der Prozess selbst ist in beiden Fällen
 * lebendig — genau was ein Healthcheck prüft.
 */
/**
 * Audit-Zuverlässigkeit (S1, v1.36.18) als Health-Feld.
 *
 * `audit.pending` sind Belege im persistenten Spool (Nachzug ausstehend),
 * `audit.lost`/`audit.missed` sind gemeldete Lücken. Ein Monitoring, das nur
 * `schemaReady` sieht, würde einen Audit-Rückstau übersehen — deshalb hier
 * zusätzlich, und zwar auch dann, wenn die DB nicht erreichbar ist (der
 * Spool-Zustand ist DB-frei lesbar).
 */
function auditHealth() {
  const d = auditDurabilitySnapshot();
  return {
    pending: d.pending,
    lost: d.lost,
    missed: d.missed,
    spooled: d.spooled,
    drained: d.drained,
    quarantined: d.quarantined,
    dbCoolingDown: d.dbCoolingDown,
    gap: d.pending + d.lost + d.missed + d.quarantined > 0,
  };
}

export async function GET() {
  try {
    const schema = await checkSchema();
    return Response.json({
      ok: true,
      app: APP_NAME,
      version: APP_VERSION,
      schemaReady: schema.ok,
      missingTables: schema.ok ? [] : schema.missingTables,
      fix: schema.ok ? null : "npx drizzle-kit push",
      audit: auditHealth(),
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    // Datenbank komplett nicht erreichbar — trotzdem 200, damit der Prozess
    // nicht als crash gilt. Der Fehler ist in den Logs sichtbar.
    return Response.json({
      ok: true,
      app: APP_NAME,
      version: APP_VERSION,
      schemaReady: false,
      error: publicErrorMessage(e, "Datenbank nicht erreichbar"),
      fix: "PostgreSQL läuft? DATABASE_URL korrekt?",
      audit: auditHealth(),
      timestamp: new Date().toISOString(),
    });
  }
}
