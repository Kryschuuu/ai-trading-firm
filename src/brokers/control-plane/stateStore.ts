/**
 * Persistenz des Control-Plane-Zustands (C4, v1.36.16).
 *
 * Befund C4 (Senior-Peer-Review 2026-09): `VenueControlState` lebte nur in
 * `globalThis.__controlPlaneStates` (Map). Die Credentials waren persistent
 * (`broker_credentials`), der Zustand nicht — nach einem Prozess-Neustart
 * zeigte der Broker-Tab `configured=true, connected=false` (INITIAL), bis
 * jemand erneut testete. Eine Konsistenzluecke zwischen zwei Wahrheiten.
 *
 * Jetzt: Tabelle `venue_control_state` ist die Wahrheit, die Map nur Cache.
 *   - `writeState()` upsertet die Zeile (best-effort, blockiert nie).
 *   - kalter `readState()` laedt die Zeile; fehlt sie, gilt der Initial-
 *     zustand, der lazy persistiert wird.
 *   - `liveEnabled`/`liveReason` werden beim Laden NEU aus dem Live-Gate-
 *     Enforcer projiziert (readGateState) — der persistierte Wert ist nur
 *     eine informative Momentaufnahme, nie eine Freigabequelle.
 *
 * Inhalt ist status-only: Ebenen, Rechte-NAMEN, Zaehler, Zeitstempel und
 * SAFE-Fehlercodes. NIE Secret-Inhalt, kein Envelope, kein keyHint.
 *
 * Backends:
 *   - `db`     : Drizzle (`venue_control_state`), lazy, Fehler => Fallback
 *   - `memory` : Tests/Demos (`CONTROL_STATE_BACKEND=memory`) und der
 *                Fail-Safe-Fallback, wenn die DB (noch) nicht erreichbar ist
 *                oder die Tabelle fehlt (Deployment vor `drizzle-kit push`).
 * Ein Fallback wird genau einmal pro Prozess im Server-Log gemeldet und
 * verhaelt sich exakt wie vor C4 (Map-only) — additiv, kein Bruch.
 */
import {
  createInitialControlState,
  readGateState,
  CONTROL_LAYER_IDS,
  type ControlLayer,
  type ControlLayerId,
  type LayerStateValue,
  type VenueControlState,
} from "./states";

/** Env-Flag: Backend des Zustands-Stores (`db` Default, `memory` nur Tests). */
export const CONTROL_STATE_BACKEND_FLAG = "CONTROL_STATE_BACKEND";

/** Persistierte, status-only Projektion einer Venue (1 Zeile je Venue). */
export interface PersistedControlState {
  venue: string;
  configured: boolean;
  connected: boolean;
  permissions: string[];
  liveEnabled: boolean;
  lastProbe: string | null;
  connectionState: LayerStateValue;
  discoveryState: LayerStateValue;
  discoveryCount: number;
  discoveryLastSync: string | null;
  lastError: string | null;
  /** Vollstaendiger Ebenen-Snapshot (verlustfreie Rehydrierung). */
  layers: Record<ControlLayerId, ControlLayer> | null;
  updatedAt: string | null;
}

/** Venue-keyed Repository — bewusst minimal (load/save/all/remove). */
export interface ControlStateRepository {
  readonly backend: string;
  load(venue: string): Promise<PersistedControlState | null>;
  save(row: PersistedControlState): Promise<void>;
  /** Alle Zeilen (Boot-Warm-up nach Neustart). */
  all(): Promise<PersistedControlState[]>;
  remove(venue: string): Promise<boolean>;
}

const LAYER_VALUES: readonly LayerStateValue[] = ["off", "pending", "active", "error"];

function isLayerValue(v: unknown): v is LayerStateValue {
  return typeof v === "string" && (LAYER_VALUES as readonly string[]).includes(v);
}

function safeText(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t.slice(0, max);
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialisierung (State <-> Zeile)
// ─────────────────────────────────────────────────────────────────────────────

/** Leitet `configured` ab, wenn der Aufrufer es nicht kennt (Ebene != off). */
export function deriveConfigured(state: VenueControlState): boolean {
  return state.layers.connection.state !== "off";
}

/** Letzter SAFE-Fehlercode aus den Ebenen (connection vor marketDiscovery). */
export function deriveLastError(state: VenueControlState): string | null {
  const conn = state.layers.connection;
  if (conn.state === "error") return safeText(conn.detail) ?? "CONNECTION_ERROR";
  const disc = state.layers.marketDiscovery;
  if (disc.state === "error") return safeText(disc.detail) ?? "DISCOVERY_FAILED";
  return null;
}

/** State → persistierbare Zeile (status-only, ohne Secret-Inhalte). */
export function toPersistedRow(
  state: VenueControlState,
  configured: boolean = deriveConfigured(state)
): PersistedControlState {
  const layers = Object.fromEntries(
    CONTROL_LAYER_IDS.map((id) => {
      const l = state.layers[id];
      return [id, { state: l.state, at: l.at ?? null, detail: safeText(l.detail) }];
    })
  ) as Record<ControlLayerId, ControlLayer>;
  return {
    venue: state.venue,
    configured,
    connected: state.connected,
    permissions: [...state.permissions],
    liveEnabled: state.liveEnabled,
    lastProbe: state.layers.connection.at ?? null,
    connectionState: state.layers.connection.state,
    discoveryState: state.discovery.state,
    discoveryCount: state.discovery.count,
    discoveryLastSync: state.discovery.lastSync,
    lastError: deriveLastError(state),
    layers,
    updatedAt: state.updatedAt,
  };
}

/**
 * Zeile → State. Der Ebenen-Snapshot ist die bevorzugte Quelle; fehlt er
 * (oder ist er unbrauchbar), wird aus den Einzelspalten rekonstruiert.
 * Live wird IMMER neu aus dem Enforcer projiziert (Regel 5).
 */
export function fromPersistedRow(row: PersistedControlState): VenueControlState {
  const initial = createInitialControlState(row.venue);
  const gate = readGateState(row.venue);
  const layers = { ...initial.layers };

  const snapshot = row.layers;
  if (snapshot && typeof snapshot === "object") {
    for (const id of CONTROL_LAYER_IDS) {
      const l = (snapshot as Record<string, Partial<ControlLayer> | undefined>)[id];
      if (l && isLayerValue(l.state)) {
        layers[id] = {
          state: l.state,
          at: typeof l.at === "string" ? l.at : null,
          detail: safeText(l.detail),
        };
      }
    }
  } else {
    if (isLayerValue(row.connectionState)) {
      layers.connection = {
        state: row.connectionState,
        at: row.lastProbe,
        detail: row.connectionState === "error" ? row.lastError : null,
      };
    }
    if (isLayerValue(row.discoveryState)) {
      layers.marketDiscovery = {
        state: row.discoveryState,
        at: row.discoveryLastSync ?? row.updatedAt,
        detail: row.discoveryState === "error" ? row.lastError : null,
      };
    }
    if (row.permissions.length > 0) {
      layers.permissions = {
        state: "active",
        at: row.lastProbe,
        detail: `permissions=[${row.permissions.join(",")}]`,
      };
    }
  }

  // Live bleibt eine reine Projektion des Enforcers — nie aus der DB.
  layers.live = { state: "off", at: layers.live.at ?? null, detail: gate.reason };

  const connected = layers.connection.state === "active";
  return {
    venue: row.venue,
    layers,
    discovery: {
      state: isLayerValue(row.discoveryState) ? row.discoveryState : "off",
      count: Number.isFinite(row.discoveryCount) ? row.discoveryCount : 0,
      lastSync: row.discoveryLastSync,
    },
    connected,
    permissions: Array.isArray(row.permissions)
      ? row.permissions.filter((p): p is string => typeof p === "string")
      : [],
    liveEnabled: gate.liveEnabled,
    liveReason: gate.reason,
    updatedAt: row.updatedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Backends
// ─────────────────────────────────────────────────────────────────────────────

export class MemoryControlStateRepository implements ControlStateRepository {
  readonly backend = "memory";
  private readonly rows = new Map<string, PersistedControlState>();

  async load(venue: string): Promise<PersistedControlState | null> {
    const row = this.rows.get(venue);
    return row ? structuredClone(row) : null;
  }
  async save(row: PersistedControlState): Promise<void> {
    this.rows.set(row.venue, structuredClone(row));
  }
  async all(): Promise<PersistedControlState[]> {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }
  async remove(venue: string): Promise<boolean> {
    return this.rows.delete(venue);
  }
  /** Nur Tests. */
  size(): number {
    return this.rows.size;
  }
}

type DbRow = {
  venue: string;
  configured: boolean;
  connected: boolean;
  permissions: unknown;
  liveEnabled: boolean;
  lastProbe: Date | null;
  connectionState: string;
  discoveryState: string;
  discoveryCount: number;
  discoveryLastSync: Date | null;
  lastError: string | null;
  layers: unknown;
  updatedAt: Date | null;
};

function iso(d: Date | null | undefined): string | null {
  return d instanceof Date && Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function date(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

function rowFromDb(r: DbRow): PersistedControlState {
  const layers =
    r.layers && typeof r.layers === "object" && !Array.isArray(r.layers)
      ? (r.layers as Record<ControlLayerId, ControlLayer>)
      : null;
  return {
    venue: r.venue,
    configured: Boolean(r.configured),
    connected: Boolean(r.connected),
    permissions: Array.isArray(r.permissions)
      ? r.permissions.filter((p): p is string => typeof p === "string")
      : [],
    liveEnabled: Boolean(r.liveEnabled),
    lastProbe: iso(r.lastProbe),
    connectionState: isLayerValue(r.connectionState) ? r.connectionState : "off",
    discoveryState: isLayerValue(r.discoveryState) ? r.discoveryState : "off",
    discoveryCount: Number.isFinite(r.discoveryCount) ? r.discoveryCount : 0,
    discoveryLastSync: iso(r.discoveryLastSync),
    lastError: r.lastError ?? null,
    layers,
    updatedAt: iso(r.updatedAt),
  };
}

export class DbControlStateRepository implements ControlStateRepository {
  readonly backend = "db";

  async load(venue: string): Promise<PersistedControlState | null> {
    const { db } = await import("@/db");
    const { venueControlState } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(venueControlState)
      .where(eq(venueControlState.venue, venue))
      .limit(1);
    return rows[0] ? rowFromDb(rows[0] as DbRow) : null;
  }

  async save(row: PersistedControlState): Promise<void> {
    const { db } = await import("@/db");
    const { venueControlState } = await import("@/db/schema");
    const set = {
      configured: row.configured,
      connected: row.connected,
      permissions: row.permissions,
      liveEnabled: row.liveEnabled,
      lastProbe: date(row.lastProbe),
      connectionState: row.connectionState,
      discoveryState: row.discoveryState,
      discoveryCount: row.discoveryCount,
      discoveryLastSync: date(row.discoveryLastSync),
      lastError: row.lastError,
      layers: row.layers,
      updatedAt: date(row.updatedAt) ?? new Date(),
    };
    await db
      .insert(venueControlState)
      .values({ venue: row.venue, ...set })
      .onConflictDoUpdate({ target: venueControlState.venue, set });
  }

  async all(): Promise<PersistedControlState[]> {
    const { db } = await import("@/db");
    const { venueControlState } = await import("@/db/schema");
    const rows = await db.select().from(venueControlState);
    return rows.map((r) => rowFromDb(r as DbRow));
  }

  async remove(venue: string): Promise<boolean> {
    const { db } = await import("@/db");
    const { venueControlState } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const result = await db.delete(venueControlState).where(eq(venueControlState.venue, venue));
    return (result.rowCount ?? 0) > 0;
  }

  /** Erreichbarkeit + Tabelle vorhanden (Backend-Wahl). */
  async ping(): Promise<boolean> {
    try {
      const { db } = await import("@/db");
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`SELECT 1 FROM venue_control_state LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prozess-Singleton (HMR-sicher) + Fail-Safe-Fallback
// ─────────────────────────────────────────────────────────────────────────────

const G = globalThis as typeof globalThis & {
  __controlStateRepo?: ControlStateRepository;
  __controlStateRepoPromise?: Promise<ControlStateRepository>;
  __controlStateFallbackWarned?: boolean;
};

/**
 * Backend-Auswahl: `CONTROL_STATE_BACKEND=memory` explizit, sonst DB mit
 * Ping (Verbindung + Tabelle). Schlaegt der Ping fehl → Memory-Fallback mit
 * einmaliger Server-Log-Warnung (Verhalten wie vor C4, kein Bruch).
 */
export async function resolveControlStateRepository(
  env: Record<string, string | undefined> = process.env
): Promise<ControlStateRepository> {
  const configured = (env[CONTROL_STATE_BACKEND_FLAG] ?? "").trim().toLowerCase();
  if (configured === "memory") return new MemoryControlStateRepository();
  const dbRepo = new DbControlStateRepository();
  if (configured === "db" || (await dbRepo.ping())) return dbRepo;
  if (!G.__controlStateFallbackWarned) {
    G.__controlStateFallbackWarned = true;
    console.warn(
      "[control-plane] venue_control_state nicht erreichbar (DB down oder Tabelle fehlt — `npx drizzle-kit push`). " +
        "Control-Plane-Zustand bleibt bis dahin prozesslokal (Verhalten wie vor v1.36.16)."
    );
  }
  return new MemoryControlStateRepository();
}

/** Prozess-Singleton des Repositories (Tests injizieren per setControlStateRepositoryForTests). */
export function getControlStateRepository(): Promise<ControlStateRepository> {
  if (!G.__controlStateRepoPromise) {
    G.__controlStateRepoPromise = (async () => {
      if (G.__controlStateRepo) return G.__controlStateRepo;
      return resolveControlStateRepository();
    })();
  }
  return G.__controlStateRepoPromise;
}

/** Nur Tests: Repository ersetzen (null = Default-Aufloesung beim naechsten Zugriff). */
export function setControlStateRepositoryForTests(repo: ControlStateRepository | null): void {
  G.__controlStateRepo = repo ?? undefined;
  G.__controlStateRepoPromise = undefined;
}
