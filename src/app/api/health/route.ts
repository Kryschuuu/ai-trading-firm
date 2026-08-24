import { checkSchema } from "@/lib/seed";

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
export async function GET() {
  try {
    const schema = await checkSchema();
    return Response.json({
      ok: true,
      schemaReady: schema.ok,
      missingTables: schema.ok ? [] : schema.missingTables,
      fix: schema.ok ? null : "npx drizzle-kit push",
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    // Datenbank komplett nicht erreichbar — trotzdem 200, damit der Prozess
    // nicht als crash gilt. Der Fehler ist in den Logs sichtbar.
    return Response.json({
      ok: true,
      schemaReady: false,
      error: e instanceof Error ? e.message : String(e),
      fix: "PostgreSQL läuft? DATABASE_URL korrekt?",
      timestamp: new Date().toISOString(),
    });
  }
}
