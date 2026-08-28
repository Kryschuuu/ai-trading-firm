/**
 * Permission-Probe der Broker Control Plane (Task 08, Regel: read-only).
 *
 * Nach dem Speichern (und bei jedem Verbindungstest) fuehrt die Control
 * Plane EINEN read-only API-Check aus und leitet daraus `permissions[]`
 * (z. B. READ, TRADE) ab. Der Check NIE verfuegbar: Secret wird nur im
 * Speicher genutzt und danach verworfen (zeroize), Fehler sind SAFE
 * (kein Echo von Secret-Inhalten, keine Infrastruktur-Details).
 *
 * Implementierungsstand (ehrliche Ist-Lage, Unabhaengigkeitsklausel):
 *   - PAPER: ECHTE Probe gegen den Paper-Ledger (getAccount, in-process).
 *   - Alle anderen Venues: lokaler Mock-Adapter (deterministisch, KEIN
 *     Netzwerk). Die echten venue-spezifischen Probes landen mit den
 *     Adapter-Aufgaben (task-03+); der Mock bildet den Adapter-Vertrag ab:
 *       * READ  wird bei gueltigem Credential-Format erteilt,
 *       * TRADE nur, wenn `capabilities.trading` true ist (SSoT),
 *       * Ablehnung (401-Simulation), wenn apiKey === apiSecret (Mock-Regel,
 *         dokumentiert, NUR fuer die Simulation).
 *   - Live wird hier NIE angefragt — liveEnabled kommt ausschliesslich aus
 *     readGateState() (bis task-11 immer false).
 */
import { VENUE_CAPABILITIES } from "../capabilities";
import { createAdapter } from "../factory";
import type { BrokerVenueId } from "@/contracts/broker";
import type { CredentialPayload } from "./secretStore";
import { zeroize } from "./secretStore";
import type { ProbeOutcome } from "./states";

export const PERMISSION_READ = "READ";
export const PERMISSION_TRADE = "TRADE";

const MOCK_MIN_LENGTH = 16;

/** SAFE-Fehlermeldungen — duerfen NIE Secret-Inhalte oder Infrastruktur enthalten. */
export const PROBE_SAFE_MESSAGES = {
  UNAUTHORIZED:
    "Die Venue hat die Zugangsdaten abgelehnt (401, read-only Probe). Zugangsdaten pruefen und erneut speichern.",
  PROBE_FAILED:
    "Read-only Probe fehlgeschlagen. Keine Verbindung hergestellt — es wurden keine Daten veraendert.",
  INVALID_CREDENTIAL:
    "Zugangsdaten-Format ungueltig (read-only Probe wurde nicht ausgefuehrt).",
} as const;

/** Deterministischer Mock-API-Client fuer noch nicht implementierte Venue-Adapters. */
export class MockVenueApiClient {
  constructor(private readonly venue: BrokerVenueId) {}

  /**
   * Simuliert den read-only Account-Check einer Venue-API.
   * Regelwerk (dokumentiert, nur Mock):
   *   1. apiKey === apiSecret → 401-Ablehnung (typische Fehlkonfiguration).
   *   2. Sonst: READ immer; TRADE genau dann, wenn der Adapter laut
   *      Capability-Matrix trading kann (VENUE_CAPABILITIES = SSoT).
   */
  async probeAccount(credential: CredentialPayload): Promise<ProbeOutcome> {
    if (credential.apiKey === credential.apiSecret) {
      return {
        ok: false,
        connected: false,
        permissions: [],
        errorCode: "UNAUTHORIZED",
        message: PROBE_SAFE_MESSAGES.UNAUTHORIZED,
      };
    }
    const caps = VENUE_CAPABILITIES[this.venue];
    const permissions = [PERMISSION_READ];
    if (caps.trading) permissions.push(PERMISSION_TRADE);
    return { ok: true, connected: true, permissions };
  }
}

/** Validiert das Format (kein Secret-Leak); Fehler SAFE. */
function validateProbeCredential(
  credential: CredentialPayload | null
): ProbeOutcome | null {
  if (!credential) return null; // keine Credentials → Aufrufer entscheidet
  const fields: (keyof CredentialPayload)[] = ["apiKey", "apiSecret"];
  for (const field of fields) {
    const value = credential[field];
    if (
      typeof value !== "string" ||
      value.length < MOCK_MIN_LENGTH ||
      value.length > 512 ||
       
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      return {
        ok: false,
        connected: false,
        permissions: [],
        errorCode: "INVALID_CREDENTIAL",
        message: PROBE_SAFE_MESSAGES.INVALID_CREDENTIAL,
      };
    }
  }
  return null;
}

/**
 * Read-only Account-Probe fuer ein Venue.
 * PAPER braucht keine Credentials (interne Simulation) und wird real gegen
 * den Ledger geprueft; alle anderen Venues laufen ueber den Mock-Client.
 */
export async function probePermissions(
  venue: BrokerVenueId,
  credential: CredentialPayload | null
): Promise<ProbeOutcome> {
  if (venue === "PAPER") {
    try {
      const adapter = createAdapter("PAPER", "paper");
      if (!adapter.getAccount) {
        return {
          ok: false,
          connected: false,
          permissions: [],
          errorCode: "PROBE_FAILED",
          message: PROBE_SAFE_MESSAGES.PROBE_FAILED,
        };
      }
      await adapter.getAccount();
      return {
        ok: true,
        connected: true,
        permissions: [PERMISSION_READ, PERMISSION_TRADE],
      };
    } catch {
      return {
        ok: false,
        connected: false,
        permissions: [],
        errorCode: "PROBE_FAILED",
        message: PROBE_SAFE_MESSAGES.PROBE_FAILED,
      };
    }
  }

  const invalid = validateProbeCredential(credential);
  if (invalid) return invalid;
  const mock = new MockVenueApiClient(venue);
  // Kopie uebergeben, damit der Store-Besitz beim Aufrufer bleibt.
  return mock.probeAccount(credential as CredentialPayload);
}

/**
 * Nuellt die String-Felder eines Credential-Objekts, soweit das in JS
 * moeglich ist: Die Werte werden ueber einen Buffer-Pfad gefuehrt und der
 * Buffer genullt. JS-Strings selbst sind unveraenderlich — der Hinweis
 * dokumentiert die Grenze ehrlich (siehe FRONTEND_CONTROL_PLANE.md,
 * Kapitel Memory-Hygiene).
 */
export function disposeCredential(credential: CredentialPayload | null): void {
  if (!credential) return;
  for (const field of ["apiKey", "apiSecret"] as const) {
    try {
      const buf = Buffer.from(credential[field], "utf8");
      zeroize(buf);
    } catch {
      /* never throw on cleanup */
    }
  }
}
