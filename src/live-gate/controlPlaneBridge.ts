/**
 * Control-Plane-Bridge (Task 11) — verdrahtet die Enforcer-Bedingung
 * „Venue-State in der Control Plane aktiv" ohne zirkuläre Abhängigkeit.
 *
 * Der Enforcer (enforcer.ts) importiert die Control Plane NICHT; er erhält
 * hier einen Readiness-Provider. Ohne Registrierung gilt CONTROL_PLANE_UNKNOWN
 * → DENY (fail-safe). Registriert wird die Bridge beim Laden des Live-Gate-
 * Modul-Index (src/live-gate/index.ts) — d. h. überall dort, wo API-Routen
 * oder der Betrieb das Gate nutzen, ist der Provider aktiv.
 *
 * Aktiv = Control-Plane-Verbindungsebene der Venue ist `active`
 * (Task-08-Zustandsmodell; erreicht nur durch validierte Credentials +
 * bestandene read-only Probe). Unbekannt/Fehler => nicht aktiv/nichtig.
 */
import { readVenueControlStatePublic } from "@/brokers/control-plane/service";
import { setVenueReadinessProvider } from "./enforcer";

export function controlPlaneReadinessProvider(venue: string): { active: boolean } | null {
  try {
    const state = readVenueControlStatePublic(venue);
    return { active: state.layers.connection.state === "active" };
  } catch {
    return null;
  }
}

/** Registriert den Provider beim Enforcer (idempotent). */
export function registerControlPlaneBridge(): void {
  setVenueReadinessProvider(controlPlaneReadinessProvider);
}
