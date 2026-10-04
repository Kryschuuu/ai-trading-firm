/**
 * `/brokers` — eigenstaendige Seite "Brokers & Venues" (Task 08).
 *
 * Laedt OHNE Firm-Datenbank (kein checkSchema/ensureSeeded) — die
 * Control-Plane-UI ist vollstaendig selbstaendig und liest ausschliesslich
 * die Broker-API (GET /api/brokers + GET /api/brokers/{venue}/status).
 * Das ist zugleich der E2E-Einstiegspunkt (Playwright/manuell).
 *
 * Seit v0.15.0 randlos über `PageShell`: Die Venue-Karten und das
 * Coverage-Dashboard profitieren von jeder zusätzlichen Spalte auf breiten
 * Monitoren; vorher endete die Seite bei `max-w-7xl`.
 */
import type { Metadata } from "next";
import BrokersPanel from "@/components/control-plane/BrokersPanel";
import { PageShell } from "@/components/ui/PageShell";

export const metadata: Metadata = {
  title: "Brokers & Venues — AI Trading Firm",
  description:
    "Broker Control Plane: Verbindungsstatus, Berechtigungen und Modus-Ebenen je Venue. Live-Trading gesperrt.",
};

export const dynamic = "force-dynamic";

export default function BrokersPage() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900">
      <PageShell
        eyebrow="Control Plane (Task 08)"
        title="🌐 Brokers &amp; Venues"
        subtitle="Status, Berechtigungen und Modus-Ebenen je Venue, plus Coverage-Dashboard (registrierte vs. tatsächlich abgedeckte Venues). Zugangsdaten bleiben im Backend (AES-256-GCM); Live-Trading ist überall gesperrt."
      >
        <BrokersPanel />
        <footer className="mt-10 text-center text-xs text-slate-600">
          Broker Control Plane · Ausschliesslich Paper-Trading — Live bleibt
          gesperrt (Live-Gate-State-Machine, Task 11 — Default DISCONNECTED).
        </footer>
      </PageShell>
    </main>
  );
}
