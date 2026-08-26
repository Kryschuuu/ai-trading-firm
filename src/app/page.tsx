import FirmDashboard from "@/components/FirmDashboard";
import { ensureSeeded, checkSchema } from "@/lib/seed";
import { APP_VERSION } from "@/lib/version";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // Schema prüfen und Team/Missionen anlegen.
  // Fehlt das Schema (drizzle-kit push nicht gelaufen), wird eine klare Setup-Seite
  // gezeigt statt eines kryptischen 500-Fehlers.
  let schemaOk = true;
  let missingTables: string[] = [];
  let seedError: string | undefined;

  try {
    const schema = await checkSchema();
    schemaOk = schema.ok;
    missingTables = schema.missingTables;

    if (schemaOk) {
      const seedResult = await ensureSeeded();
      if (!seedResult.ok) seedError = seedResult.reason;
    }
  } catch (e) {
    schemaOk = false;
    seedError = e instanceof Error ? e.message : String(e);
  }

  if (!schemaOk) {
    return (
      <main className="min-h-screen bg-slate-950 flex items-center justify-center p-8">
        <div className="max-w-2xl w-full rounded-2xl border border-red-700/50 bg-red-950/30 p-8">
          <p className="text-xs uppercase tracking-widest text-red-400 mb-2">Setup erforderlich</p>
          <h1 className="text-2xl font-bold text-slate-50 mb-4">
            Datenbanktabellen fehlen
          </h1>
          <p className="text-slate-300 mb-6">
            Das Datenbankschema wurde noch nicht angelegt. Führe den folgenden Befehl
            im Projektstamm aus und lade die Seite dann neu:
          </p>
          <pre className="rounded-xl border border-slate-700 bg-slate-900 px-5 py-4 text-sm text-emerald-300 font-mono mb-6 overflow-x-auto">
{`# Datenbanktabellen anlegen (einmalig)
npx drizzle-kit push

# Danach den Dienst neu starten
npm run start       # Entwicklung
# oder
sudo systemctl restart ai-trading-firm   # Produktion (systemd)`}
          </pre>

          {missingTables.length > 0 && (
            <div className="mb-4">
              <p className="text-sm font-semibold text-slate-400 mb-2">Fehlende Tabellen:</p>
              <div className="flex flex-wrap gap-2">
                {missingTables.map((t) => (
                  <span key={t} className="rounded-md border border-red-700/40 bg-red-900/30 px-2 py-1 text-xs font-mono text-red-300">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          <details className="text-sm">
            <summary className="text-slate-500 cursor-pointer hover:text-slate-300">
              Vollständige Fehlermeldung
            </summary>
            <pre className="mt-2 rounded-lg bg-slate-900 px-4 py-3 text-xs text-slate-400 overflow-x-auto">
              {seedError ?? "relation does not exist"}
            </pre>
          </details>

          <div className="mt-6 rounded-xl border border-slate-800 bg-slate-900/50 p-4 text-xs text-slate-400 leading-relaxed">
            <strong className="text-slate-200">Häufige Ursache (Variante B):</strong><br/>
            Das Setup-Skript hat <code className="text-emerald-400">drizzle-kit push</code> ausgeführt,
            bevor <code className="text-emerald-400">.env</code> mit der richtigen{" "}
            <code className="text-emerald-400">DATABASE_URL</code> vorhanden war —
            oder <code className="text-emerald-400">drizzle.config.json</code> mit einer
            hardcodierten URL hat den Push auf die falsche Datenbank umgeleitet.
            Seit der aktuellen Version nutzt das Projekt <code className="text-emerald-400">drizzle.config.ts</code>,
            das die URL aus <code className="text-emerald-400">.env</code> liest.
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900">
      <FirmDashboard />
      <footer className="mx-auto max-w-7xl px-4 pb-10 pt-4 text-center text-xs text-slate-600">
        Lokale autonome Trading-Firma · Next.js + Drizzle + PostgreSQL + Ollama ·
        Ausschließlich Paper-Trading — es ist zu keiner Zeit echtes Kapital im Spiel.
        {/* Versionsnummer aus package.json (einziger Wahrheitsort: src/lib/version.ts) */}
        <span className="ml-2 rounded-md border border-slate-800 bg-slate-900/60 px-1.5 py-0.5 font-mono text-slate-500">
          v{APP_VERSION}
        </span>
      </footer>
    </main>
  );
}
