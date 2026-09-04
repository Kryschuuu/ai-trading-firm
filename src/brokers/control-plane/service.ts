/**
 * Broker Control Plane — Backend-Credential-Manager (Task 08).
 *
 * Der EINZIGE Pfad fuer Broker-Credentials:
 *   Frontend (masked form) → POST /api/brokers/{venue}/credentials
 *   → validate → AES-256-GCM (AAD = venue) → Probe (read-only)
 *   → Zustandsmaschine (6 Ebenen) → Audit. Antworten sind IMMER
 *   Status-Objekte: configured/connected/permissions[]/liveEnabled —
 *   NIE ein Secret, NIE ein keyHint (empfohlen: gar nicht — so umgesetzt).
 *
 * Live: `liveEnabled` ist eine reine Projektion des zentralen Live-Gate-
 * Enforcers (Task 11, readGateState) — Default false, kein Schalter hier.
 *
 * Zustandsmaschine: Uebergaenge nur via save/test/discover/disable —
 * Missbrauch wirft StateTransitionError (→ 409/422 mit klarem Fehler).
 * Audit: JEDES Ereignis → Control-Plane-Audit (Ring + audit_log).
 *
 * Persistenz (C4, v1.36.16): Der Zustand je Venue liegt in der Tabelle
 * `venue_control_state` (stateStore.ts); die Map `G.__controlPlaneStates`
 * ist nur noch Cache. `writeState()` upsertet, ein kalter `loadState()`
 * laedt aus der DB — nach einem Prozess-Neustart zeigt der Broker-Tab den
 * letzten bekannten Verbindungszustand statt immer INITIAL.
 */
import {
  UnknownVenueError,
  type BrokerAdapter,
  type BrokerVenueId,
} from "@/contracts/broker";
import { VENUE_CAPABILITIES } from "../capabilities";
import { normalizeVenue } from "../factory";
import {
  recordControlPlaneEvent,
  type ControlPlaneAction,
} from "./audit";
import {
  applyAction,
  createInitialControlState,
  readGateState,
  StateTransitionError,
  type ControlLayerId,
  type LayerStateValue,
  type ProbeOutcome,
  type VenueControlState,
} from "./states";
import { disposeCredential, probePermissions } from "./probe";
import {
  assertValidCredential,
  type CredentialPayload,
  type VenueSecretStore,
} from "./secretStore";
import {
  MemoryControlStateRepository,
  fromPersistedRow,
  getControlStateRepository,
  setControlStateRepositoryForTests,
  toPersistedRow,
} from "./stateStore";

// ── Ergebnis-Vertraege (status-only, siehe docs/FRONTEND_CONTROL_PLANE.md) ───

export interface LayerStatusDto {
  state: LayerStateValue;
  at: string | null;
  detail: string | null;
}

export interface StatusDto {
  ok: true;
  venue: BrokerVenueId;
  configured: boolean;
  connected: boolean;
  permissions: string[];
  liveEnabled: boolean;
  liveReason: string;
  discovery: { state: LayerStateValue; count: number; lastSync: string | null };
  health: {
    status: string;
    latencyMs: number;
    details: Record<string, unknown>;
  };
  layers: Record<ControlLayerId, LayerStatusDto>;
  updatedAt: string | null;
}

export interface SaveResultDto {
  ok: true;
  venue: BrokerVenueId;
  configured: true;
  connected: boolean;
  permissions: string[];
  liveEnabled: boolean;
  probe: {
    state: "ok" | "error";
    at: string;
    errorCode: string | null;
    message: string | null;
  };
  layers: Record<ControlLayerId, LayerStatusDto>;
}

export interface TestResultDto {
  ok: true;
  venue: BrokerVenueId;
  configured: boolean;
  connected: boolean;
  permissions: string[];
  liveEnabled: boolean;
  health: { status: string; latencyMs: number; details: Record<string, unknown> };
}

export interface DeleteResultDto {
  ok: true;
  venue: BrokerVenueId;
  configured: false;
  connected: false;
  permissions: [];
  liveEnabled: boolean;
}

export interface DiscoverResultDto {
  ok: true;
  venue: BrokerVenueId;
  discovery: { state: LayerStateValue; count: number; lastSync: string | null };
  layers: Record<ControlLayerId, LayerStatusDto>;
}

export interface ControlPlaneOptions {
  store?: VenueSecretStore;
  /** DI-Hook fuer die Discovery (Tests; Default: Adapter-Discovery). */
  discoverFn?: (venue: BrokerVenueId) => Promise<number>;
  /** DI-Hook fuer die Probe (Tests; Default: probe.ts). */
  probeFn?: (
    venue: BrokerVenueId,
    credential: CredentialPayload | null
  ) => Promise<ProbeOutcome>;
  now?: () => string;
}

function toLayerDto(record: Record<ControlLayerId, VenueControlState["layers"][ControlLayerId]>): Record<ControlLayerId, LayerStatusDto> {
  return Object.fromEntries(
    Object.entries(record).map(([id, l]) => [id, { state: l.state, at: l.at, detail: l.detail }])
  ) as Record<ControlLayerId, LayerStatusDto>;
}

const G = globalThis as typeof globalThis & {
  __controlPlaneServicePromise?: Promise<ControlPlaneService>;
  __controlPlaneStates?: Map<string, VenueControlState>;
  __controlPlaneHydrating?: Map<string, Promise<VenueControlState>>;
  __controlPlaneWarmupPromise?: Promise<number>;
  __controlPlanePersistWarned?: boolean;
};

/** In-Memory-CACHE des Zustands (Wahrheit: `venue_control_state`, C4). */
function stateMap(): Map<string, VenueControlState> {
  return (G.__controlPlaneStates ??= new Map());
}

function hydrating(): Map<string, Promise<VenueControlState>> {
  return (G.__controlPlaneHydrating ??= new Map());
}

/** Venue-ID-Guardrail fuer den Persistenzpfad (nur registrierte Venues). */
function persistableVenue(venue: string): venue is BrokerVenueId {
  return normalizeVenue(venue) === venue;
}

function warnPersistOnce(op: string, err: unknown): void {
  if (G.__controlPlanePersistWarned) return;
  G.__controlPlanePersistWarned = true;
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(
    `[control-plane] venue_control_state ${op} fehlgeschlagen — Zustand bleibt prozesslokal (Cache). Ursache (redigiert): ${msg.slice(0, 160)}`
  );
}

/**
 * Synchroner Cache-Zugriff: liefert den gecachten Zustand oder — kalt — den
 * Initialzustand, OHNE ihn zu cachen (sonst wuerde der persistierte Zustand
 * nie mehr nachgeladen). Der async Pfad ist `loadState()`.
 */
function readState(venue: BrokerVenueId): VenueControlState {
  return stateMap().get(venue) ?? createInitialControlState(venue);
}

/**
 * Zustand laden (C4): Cache → DB → Initialzustand (lazy persistiert).
 * Parallele Aufrufe derselben Venue teilen sich eine Hydration.
 */
async function loadState(venue: BrokerVenueId): Promise<VenueControlState> {
  const cached = stateMap().get(venue);
  if (cached) return cached;
  const inflight = hydrating().get(venue);
  if (inflight) return inflight;
  const task = (async () => {
    // Ein konkurrierender writeState() waehrend der Hydration gewinnt.
    const raced = () => stateMap().get(venue);
    try {
      const repo = await getControlStateRepository();
      const row = await repo.load(venue);
      if (raced()) return raced()!;
      if (row) {
        const state = fromPersistedRow(row);
        stateMap().set(venue, state);
        return state;
      }
      const initial = createInitialControlState(venue);
      stateMap().set(venue, initial);
      try {
        await repo.save(toPersistedRow(initial, false));
      } catch (err) {
        warnPersistOnce("insert", err);
      }
      return initial;
    } catch (err) {
      warnPersistOnce("load", err);
      const fallback = raced() ?? createInitialControlState(venue);
      stateMap().set(venue, fallback);
      return fallback;
    } finally {
      hydrating().delete(venue);
    }
  })();
  hydrating().set(venue, task);
  return task;
}

/**
 * Öffentlicher, SYNCHRONER Lesezugriff auf den Control-Plane-Zustand
 * (Task 11: Live-Gate-Bridge prüft „Venue aktiv"). Liest den Cache; ist die
 * Venue kalt (z. B. direkt nach einem Neustart), wird die Hydration aus
 * `venue_control_state` im Hintergrund angestossen und bis dahin der
 * Initialzustand geliefert (alles off => nicht aktiv => fail-safe deny).
 * Beim Server-Boot fuellt `warmControlPlaneStateCache()` den Cache vorab.
 */
export function readVenueControlStatePublic(venueRaw: string): VenueControlState {
  const venue = normalizeVenue(venueRaw) ?? (String(venueRaw ?? "").toUpperCase().slice(0, 40) as BrokerVenueId);
  if (!stateMap().has(venue) && persistableVenue(venue)) {
    void loadState(venue).catch(() => undefined);
  }
  return readState(venue);
}

/**
 * Asynchroner Lesezugriff (bevorzugt): Cache → `venue_control_state`.
 * Fuer Aufrufer, die auf den persistierten Zustand warten koennen.
 */
export async function loadVenueControlState(venueRaw: string): Promise<VenueControlState> {
  const venue = normalizeVenue(venueRaw);
  if (!venue) {
    return createInitialControlState(String(venueRaw ?? "").toUpperCase().slice(0, 40));
  }
  return loadState(venue);
}

/**
 * Cache schreiben + Zeile upserten (C4). Persistenz ist best-effort: ein
 * DB-Ausfall bricht den Control-Plane-Pfad NIE ab (Fail-Safe, Warnung einmal
 * pro Prozess) — der Cache bleibt dann bis zum naechsten Erfolg die Wahrheit.
 * `configured` kommt vom Aufrufer (Secret-Store); ohne Angabe wird es aus der
 * Verbindungsebene abgeleitet (off => nicht konfiguriert).
 */
async function writeState(state: VenueControlState, configured?: boolean): Promise<void> {
  stateMap().set(state.venue, state);
  if (!persistableVenue(state.venue)) return;
  try {
    const repo = await getControlStateRepository();
    await repo.save(toPersistedRow(state, configured));
  } catch (err) {
    warnPersistOnce("upsert", err);
  }
}

/**
 * Boot-Warm-up (C4): laedt ALLE persistierten Venue-Zustaende in den Cache,
 * damit auch synchrone Leser (Live-Gate-Bridge) direkt nach einem Neustart
 * den letzten bekannten Zustand sehen. Idempotent, best-effort, nie werfend.
 * Liefert die Anzahl geladener Venues.
 */
export function warmControlPlaneStateCache(): Promise<number> {
  if (!G.__controlPlaneWarmupPromise) {
    G.__controlPlaneWarmupPromise = (async () => {
      try {
        const repo = await getControlStateRepository();
        const rows = await repo.all();
        let loaded = 0;
        for (const row of rows) {
          if (!persistableVenue(row.venue) || stateMap().has(row.venue)) continue;
          stateMap().set(row.venue, fromPersistedRow(row));
          loaded++;
        }
        return loaded;
      } catch (err) {
        warnPersistOnce("warm-up", err);
        return 0;
      }
    })();
  }
  return G.__controlPlaneWarmupPromise;
}

export class ControlPlaneService {
  private readonly discoverFn: (venue: BrokerVenueId) => Promise<number>;
  private readonly probeFn: (
    venue: BrokerVenueId,
    credential: CredentialPayload | null
  ) => Promise<ProbeOutcome>;
  private readonly now: () => string;

  constructor(private readonly opts: ControlPlaneOptions = {}) {
    this.probeFn =
      opts.probeFn ??
      ((venue, credential) => probePermissions(venue, credential));
    this.now = opts.now ?? (() => new Date().toISOString());
    this.discoverFn =
      opts.discoverFn ?? defaultDiscoverFn;
  }

  private store(): VenueSecretStore {
    if (!this.opts.store) {
      throw new Error(
        "ControlPlaneService ohne Secret-Store konfiguriert — getControlPlaneService() verwenden (Fabrik)."
      );
    }
    return this.opts.store;
  }

  private capabilities(venue: BrokerVenueId) {
    const caps = VENUE_CAPABILITIES[venue];
    return {
      paper: caps.paper,
      testnet: caps.testnet,
      trading: caps.trading,
      discovery: caps.discovery,
    };
  }

  // ── Aktionen ──────────────────────────────────────────────────────────────

  /** `POST /api/brokers/{venue}/credentials` — Secret einmalig entgegennehmen. */
  async saveCredentials(
    actor: string,
    venueRaw: string,
    body: unknown
  ): Promise<SaveResultDto> {
    const venue = this.requireVenue(venueRaw);

    if (venue === "PAPER") {
      await this.deny(actor, venue, "credential.saved", "NO_CREDENTIALS_REQUIRED");
      throw new StateTransitionError(
        "NO_CREDENTIALS_REQUIRED",
        "PAPER ist der interne Simulator und benoetigt keine Zugangsdaten. Verbindungstest genuegt (POST /test)."
      );
    }

    const credential = this.parseCredentialBody(body);
    const store = this.store();

    if (await store.exists(venue)) {
      const state = await loadState(venue);
      if (state.layers.connection.state === "active") {
        await this.deny(actor, venue, "credential.saved", "ALREADY_CONNECTED");
        throw new StateTransitionError(
          "ALREADY_CONNECTED",
          "Verbindung ist bereits aktiv. Zuerst trennen (DELETE), dann neu speichern."
        );
      }
      // Erneutes Speichern im Fehler-Zustand = Aendern (upsert).
      await this.audit(actor, venue, "credential.changed", "OK");
    } else {
      await this.audit(actor, venue, "credential.saved", "OK");
    }

    // 1) Verschluesseln (AES-256-GCM, AAD = venue) — Klartext danach weg.
    await store.put(venue, credential);

    // 2) Read-only Probe mit dem (noch im Speicher gehaltenen) Credential →
    //    permissions[] ableiten. Danach wird der Wert verworfen (zeroize);
    //    ein Fehler fuehrt zu Zustand error mit SAFE-Meldung.
    const probe = await this.runProbe(venue, credential);
    disposeCredential(credential);
    await this.auditProbe(actor, venue, probe);

    // 3) Zustandsuebergang nur ueber definierte Aktion "save".
    const state = await loadState(venue);
    const next = applyAction(state, {
      action: "save",
      probe,
      capabilities: this.capabilities(venue),
      now: this.now(),
    });
    await writeState(next, true);
    await this.auditTransition(actor, venue, next);

    return {
      ok: true,
      venue,
      configured: true,
      connected: next.connected,
      permissions: next.permissions,
      liveEnabled: next.liveEnabled,
      probe: {
        state: probe.ok ? "ok" : "error",
        at: this.now(),
        errorCode: probe.errorCode ?? null,
        message: probe.message ?? null,
      },
      layers: toLayerDto(next.layers),
    };
  }

  /** `DELETE /api/brokers/{venue}/credentials` — Referenz loeschen + disable. */
  async deleteCredentials(actor: string, venueRaw: string): Promise<DeleteResultDto> {
    const venue = this.requireVenue(venueRaw);
    const store = this.store();
    if (!(await store.exists(venue))) {
      await this.deny(actor, venue, "credential.deleted", "NOT_CONFIGURED");
      throw new StateTransitionError(
        "NOT_CONFIGURED",
        "Keine Zugangsdaten hinterlegt — nichts zu loeschen."
      );
    }
    await store.delete(venue);
    const state = await loadState(venue);
    const next = applyAction(state, {
      action: "disable",
      now: this.now(),
    });
    await writeState(next, false);
    await this.audit(actor, venue, "credential.deleted", "OK");
    await this.auditTransition(actor, venue, next);
    return {
      ok: true,
      venue,
      configured: false,
      connected: false,
      permissions: [],
      liveEnabled: next.liveEnabled,
    };
  }

  /** `GET /api/brokers/{venue}/status` — Status-Objekt, NIE Secret-Inhalt. */
  async getStatus(venueRaw: string): Promise<StatusDto> {
    const venue = this.requireVenue(venueRaw);
    const store = this.store();
    // C4: Cache → venue_control_state — nach Neustart der letzte bekannte Zustand.
    const state = await loadState(venue);
    const configured = await store.exists(venue);
    const gate = readGateState(venue);
    return {
      ok: true,
      venue,
      configured,
      connected: state.connected,
      permissions: state.permissions,
      liveEnabled: gate.liveEnabled,
      liveReason: gate.reason,
      discovery: { ...state.discovery },
      health: await this.safeHealth(venue),
      layers: toLayerDto(state.layers),
      updatedAt: state.updatedAt,
    };
  }

  /** `POST /api/brokers/{venue}/test` — healthCheck + read-only Probe. */
  async testConnection(actor: string, venueRaw: string): Promise<TestResultDto> {
    const venue = this.requireVenue(venueRaw);
    const store = this.store();

    let credential: CredentialPayload | null = null;
    let configured = false;
    let probe: ProbeOutcome;
    if (venue === "PAPER") {
      configured = false; // PAPER braucht keine Credentials
      probe = await this.runProbe(venue, null);
    } else {
      configured = await store.exists(venue);
      if (!configured) {
        await this.deny(actor, venue, "connection.test", "NO_CREDENTIALS");
        throw new StateTransitionError(
          "NO_CREDENTIALS",
          "Keine Zugangsdaten hinterlegt — erst speichern (POST /credentials), dann testen."
        );
      }
      try {
        credential = await store.get(venue);
        probe = await this.runProbe(venue, credential);
      } catch {
        // Entschluesselung fehlgeschlagen (falscher Key/Tampering) →
        // Zustand error mit SAFE-Meldung, kein Secret-Leak.
        probe = {
          ok: false,
          connected: false,
          permissions: [],
          errorCode: "CREDENTIAL_READ_FAILED",
          message:
            "Gespeicherte Zugangsdaten konnten nicht entschluesselt werden (falscher SECRET_STORE_KEY oder manipulierter Datensatz).",
        };
      } finally {
        disposeCredential(credential);
      }
    }

    await this.auditProbe(actor, venue, probe);
    await this.audit(actor, venue, "connection.test", probe.ok ? "OK" : "ERROR");

    const state = await loadState(venue);
    const next = applyAction(state, {
      action: "test",
      probe,
      capabilities: this.capabilities(venue),
      now: this.now(),
    });
    await writeState(next, configured);
    await this.auditTransition(actor, venue, next);

    return {
      ok: true,
      venue,
      configured,
      connected: probe.connected,
      permissions: probe.permissions,
      liveEnabled: next.liveEnabled,
      health: await this.safeHealth(venue),
    };
  }

  /** `POST /api/brokers/{venue}/discover` — Market Discovery (Aktion "discover"). */
  async discover(actor: string, venueRaw: string): Promise<DiscoverResultDto> {
    const venue = this.requireVenue(venueRaw);
    const state = await loadState(venue);

    if (!this.capabilities(venue).discovery) {
      await this.deny(actor, venue, "connection.discover", "NOT_SUPPORTED_CAPABILITY");
      throw new StateTransitionError(
        "NOT_SUPPORTED_CAPABILITY",
        "Dieses Venue unterstuetzt keine Market Discovery (capabilities.discovery=false)."
      );
    }

    let next: VenueControlState;
    try {
      const count = await this.discoverFn(venue);
      next = applyAction(state, {
        action: "discover",
        capabilities: this.capabilities(venue),
        discoveryCount: count,
        now: this.now(),
      });
    } catch (err) {
      if (err instanceof StateTransitionError) throw err;
      next = applyAction(state, {
        action: "discover",
        capabilities: this.capabilities(venue),
        discoveryCount: -1,
        now: this.now(),
      });
    }
    await writeState(next);
    await this.audit(actor, venue, "connection.discover", next.discovery.state === "active" ? "OK" : "ERROR");
    await this.auditTransition(actor, venue, next);
    return {
      ok: true,
      venue,
      discovery: { ...next.discovery },
      layers: toLayerDto(next.layers),
    };
  }

  /** Nur Tests/Demo: Zustand einer Venue zuruecksetzen (Cache + Zeile). */
  async resetForTests(venue: BrokerVenueId): Promise<void> {
    await writeState(createInitialControlState(venue), false);
  }

  // ── interne Helfer ────────────────────────────────────────────────────────

  private requireVenue(raw: string): BrokerVenueId {
    const venue = normalizeVenue(raw);
    if (!venue) {
      const safe = String(raw ?? "").slice(0, 40);
      throw new UnknownVenueError(safe);
    }
    return venue;
  }

  private parseCredentialBody(body: unknown): CredentialPayload {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new StateTransitionError(
        "VALIDATION_ERROR",
        "Request-Body muss ein JSON-Objekt mit apiKey und apiSecret sein."
      );
    }
    const record = body as Record<string, unknown>;
    const credential: CredentialPayload = {
      apiKey: typeof record.apiKey === "string" ? record.apiKey : "",
      apiSecret: typeof record.apiSecret === "string" ? record.apiSecret : "",
    };
    assertValidCredential(credential);
    return credential;
  }

  private async runProbe(
    venue: BrokerVenueId,
    credential: CredentialPayload | null = null
  ): Promise<ProbeOutcome> {
    try {
      return await this.probeFn(venue, credential);
    } catch {
      return {
        ok: false,
        connected: false,
        permissions: [],
        errorCode: "PROBE_FAILED",
        message: "Read-only Probe fehlgeschlagen (SAFE: keine Details).",
      };
    }
  }

  private async safeHealth(venue: BrokerVenueId): Promise<StatusDto["health"]> {
    try {
      const adapter: BrokerAdapter = (await import("../factory")).createAdapter(venue, "paper");
      const health = await adapter.healthCheck();
      return {
        status: health.status,
        latencyMs: health.latencyMs,
        details: health.details,
      };
    } catch {
      return {
        status: "offline",
        latencyMs: 0,
        details: { error: "HEALTH_CHECK_FAILED" },
      };
    }
  }

  private async audit(
    actor: string,
    venue: string,
    action: ControlPlaneAction,
    result: "OK" | "DENIED" | "ERROR",
    errorCode?: string
  ): Promise<void> {
    await recordControlPlaneEvent({ actor, venue, action, result, errorCode: errorCode ?? null });
  }

  private async deny(
    actor: string,
    venue: string,
    action: ControlPlaneAction,
    errorCode: string
  ): Promise<void> {
    await recordControlPlaneEvent({ actor, venue, action, result: "DENIED", errorCode });
  }

  private async auditProbe(actor: string, venue: string, probe: ProbeOutcome): Promise<void> {
    await recordControlPlaneEvent({
      actor,
      venue,
      action: "permission.probe",
      result: probe.ok ? "OK" : "ERROR",
      errorCode: probe.errorCode ?? null,
      meta: { permissions: probe.permissions.join(",") || null },
    });
  }

  private async auditTransition(actor: string, venue: string, state: VenueControlState): Promise<void> {
    const changed = (Object.keys(state.layers) as ControlLayerId[])
      .filter((id) => state.layers[id].state !== "off")
      .join(",");
    if (!changed) return;
    await recordControlPlaneEvent({
      actor,
      venue,
      action: "state.transition",
      result: "OK",
      meta: { layers: changed },
    });
  }
}

/** Default-Discovery: Adapter-Discovery, sicher gekappt (kein Netzwerk ohne Flag). */
async function defaultDiscoverFn(venue: BrokerVenueId): Promise<number> {
  // PAPER: lokale Universe-Registry (DB-gestuetzt; Fehler → -1 → Ebene error).
  // Andere Venues: echte Discovery erst mit den Adapter-Aufgaben — hier
  // bewusst NICHTS (Mock-Discovery ist Aufgabe des Tests/DI-Hooks).
  if (venue !== "PAPER") {
    throw new StateTransitionError(
      "DISCOVERY_NOT_IMPLEMENTED",
      "Echte Market Discovery dieses Venues folgt mit dem Adapter-Ausbau (TODO(task-02/07))."
    );
  }
  const adapter = (await import("../factory")).createAdapter("PAPER", "paper");
  if (!adapter.discoverInstruments) return -1;
  try {
    const instruments = await adapter.discoverInstruments();
    return Array.isArray(instruments) ? instruments.length : -1;
  } catch {
    return -1;
  }
}

/**
 * Prozess-Singleton des Service: loest den Secret-Store einmalig auf
 * (Backend-Wahl: DB-Ping → Fallback file) und injiziert ihn. API-Routen
 * `await`en diese Fabrik; Tests erzeugen eigene Instanzen mit injiziertem
 * Memory-Store.
 */
export function getControlPlaneService(): Promise<ControlPlaneService> {
  if (!G.__controlPlaneServicePromise) {
    G.__controlPlaneServicePromise = (async () => {
      const { getControlPlaneSecretStore } = await import("./secretStore");
      const store = await getControlPlaneSecretStore();
      // C4: Cache aus venue_control_state vorwaermen (best-effort).
      await warmControlPlaneStateCache();
      return new ControlPlaneService({ store });
    })();
  }
  return G.__controlPlaneServicePromise;
}

/**
 * Nur Tests: simulierter Prozess-Neustart — leert NUR den Cache (Map,
 * Hydration, Warm-up). Das Zustands-Repository (die „DB") bleibt bestehen,
 * genau wie eine echte Datenbank einen Neustart ueberlebt (C4).
 */
export function clearControlPlaneStateCacheForTests(): void {
  G.__controlPlaneStates = undefined;
  G.__controlPlaneHydrating = undefined;
  G.__controlPlaneWarmupPromise = undefined;
}

/**
 * Nur Tests: Singleton + Cache + Zustands-Repository zuruecksetzen
 * (vollstaendig sauberer Zustand, auch die „DB" ist danach leer).
 *
 * Installiert bewusst ein FRISCHES Memory-Repository statt der Default-
 * Aufloesung: Testprozesse duerfen sich nie ueber eine zufaellig erreichbare
 * PostgreSQL-Instanz gegenseitig Zustand hinterlassen (jede Testdatei ist ein
 * eigener Prozess; die DB ueberlebt ihn — genau das ist C4). Wer das echte
 * DB-Repository testen will, injiziert es explizit
 * (`setControlStateRepositoryForTests(new DbControlStateRepository())`).
 */
export function resetControlPlaneForTests(): void {
  G.__controlPlaneServicePromise = undefined;
  G.__controlPlanePersistWarned = undefined;
  clearControlPlaneStateCacheForTests();
  setControlStateRepositoryForTests(new MemoryControlStateRepository());
}
