import FirmDashboard from "@/components/FirmDashboard";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // Beim ersten Aufruf Team und Missionen anlegen, damit das Dashboard nicht leer ist.
  // Idempotent — bestehende Daten bleiben unangetastet.
  try {
    await ensureSeeded();
  } catch (e) {
    console.error("[seed] übersprungen:", e);
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900">
      <FirmDashboard />
      <footer className="mx-auto max-w-7xl px-4 pb-10 pt-4 text-center text-xs text-slate-600">
        Lokale autonome Trading-Firma · Next.js + Drizzle + PostgreSQL + Ollama ·
        Ausschließlich Paper-Trading — es ist zu keiner Zeit echtes Kapital im Spiel.
      </footer>
    </main>
  );
}
