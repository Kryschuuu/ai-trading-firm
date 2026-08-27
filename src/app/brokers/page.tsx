/**
 * `/brokers` — eigenstaendige Seite "Brokers & Venues" (Task 08).
 *
 * Laedt OHNE Firm-Datenbank (kein checkSchema/ensureSeeded) — die
 * Control-Plane-UI ist vollstaendig selbstaendig und liest ausschliesslich
 * die Broker-API (GET /api/brokers + GET /api/brokers/{venue}/status).
 * Das ist zugleich der E2E-Einstiegspunkt (Playwright/manuell).
 */
import type { Metadata } from "next";
import BrokersPanel from "@/components/control-plane/BrokersPanel";

export const metadata: Metadata = {
  title: "Brokers & Venues — AI Trading Firm",
  description:
    "Broker Control Plane: Verbindungsstatus, Berechtigungen und Modus-Ebenen je Venue. Live-Trading gesperrt.",
};

export const dynamic = "force-dynamic";

export default function BrokersPage() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900">
      <div className="mx-auto max-w-7xl px-4 py-8">
        <header className="mb-6">
          <h1 className="text-xl font-bold text-slate-50">
            🌐 Brokers &amp; Venues
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            Broker Control Plane (Task 08) — Status, Berechtigungen und
            Modus-Ebenen je Venue. Zugangsdaten bleiben im Backend
            (AES-256-GCM); Live-Trading ist ueberall gesperrt.
          </p>
        </header>
        <BrokersPanel />
        <footer className="mt-10 text-center text-xs text-slate-600">
          Broker Control Plane · Ausschliesslich Paper-Trading — Live bleibt
          gesperrt (Gate-Service: task-11).
        </footer>
      </div>
    </main>
  );
}
