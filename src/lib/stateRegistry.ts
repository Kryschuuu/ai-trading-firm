/**
 * Zentrale State-Registry — ALLE prozess-weiten Singletons an EINEM Ort.
 *
 * Befund S2 (Senior-Peer-Review 2026-09, MEDIUM/architektonisch): Mehrere
 * unabhaengige `globalThis`-Keys plus Modul-Variablen machten es schwer,
 * Konsistenz ueber Neustarts/Prozesse hinweg zu beurteilen (`__firmHydrated`
 * und `__controlPlaneStates` drifteten bereits — H2, C4). Die Reset-Pfade der
 * Tests waren verstreut (`resetControlPlaneForTests` + `resetRateLimiterForTests`
 * + `G.__firmHydrated`).
 *
 * Diese Datei buendelt ALLES Cross-Cutting-Mutable hinter typisierten
 * Accessoren in EINEM `globalThis`-Namensraum (HMR-/Hot-Reload-sicher wie vorher
 * die einzelnen Keys) und stellt mit `__resetAllSingletonsForTests()` den EINEN
 * Reset fuer das Test-Harness bereit — ein Reset, der keinen Singleton vergisst.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SOURCE-OF-TRUTH — DB vs. RAM (Lifecycle)
 * ─────────────────────────────────────────────────────────────────────────────
 * Persistente Wahrheit (PostgreSQL, ueberlebt Prozess-Neustart):
 *   - offene Positionen / Cash-Analytic      → `positions`, `equity_snapshots`
 *   - Kill-Switch-Status                     → `kill_switches`
 *   - konfigurierte Risk-Limits              → `risk_config`
 *   - Venue-Control-State (Control Plane)    → `venue_control_state`
 *   - Brokervorschlaege / Missionen          → `proposals`, `missions`
 *   - Broker-Credentials / Secrets           → `broker_credentials` (+ verschluesselte Envelopes)
 *
 * Reine RAM-Caches / Prozess-Singletons (kein verteilter Zustand):
 *   - `firmHydrated`            Hydration-Flag des Paper-Ledgers; DB ist die
 *                               Wahrheit, das Flag nur "schon geladen".
 *   - `pipelineBusy`            Mutex der Agenten-Pipeline (Single-Flight).
 *   - `controlPlaneStates`      Cache der Venue-Zustaende (`venue_control_state`).
 *   - `controlPlaneHydrating`   Dedup laufender Venue-Hydrationen.
 *   - `controlPlaneWarmupPromise` / `controlPlaneServicePromise`
 *                               Prozess-Singleton des Warmups/Services.
 *   - `controlPlanePersistWarned` Einmalige Warnung (Log-Dedup).
 *   - `killSwitchArmed`         In-Memory-Circuit-Breaker. Der Arm-Zustand wird
 *                               in `kill_switches` persistiert und beim Start
 *                               rehydriert; das Flag ist die Wirksamkeit im Prozess.
 *   - `baseLimits`/`currentLimits` Ruetime-Risk-Limits. Basis aus `risk_config`
 *                               (Default = Code), `currentLimits` = Basis +
 *                               adaptiver Marktfaktor (reine RAM-Projektion).
 *   - `adaptiveState`           Aktuelle Volatilitaets-Bewertung (RAM); ein
 *                               persistierter Faktor (`PERSISTED`) liegt in der DB.
 *   - `brokerAdapters`          Adapter-/Ledger-Singleton-Cache der Broker-Factory.
 *   - `paperBrokerLedger`       Papier-Ledger (RAM); offene Positionen/Kill-
 *                               Status werden aus der DB hydriert.
 *   - `rateLimiterHits`         Sliding-Window-Bucket der API-Auth (Single-Node).
 *
 * DI-/Backend-Singletons der Control Plane (Repository `getControlStateRepository`,
 * Secret-Store `getControlPlaneSecretStore`) sind bewusst NICHT hier — sie sind
 * injizierbare Backends und werden ueber ihre dedizierten `...ForTests`-Hooks
 * (`resetControlPlaneForTests`, `setControlPlaneSecretStoreForTests`) gesetzt.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Typ-Abhaengigkeiten werden nur als `import type` geholt (compiler-elektiv
// entfernt) — die Registry hat KEINE Runtime-Importe, es entsteht also kein
// Modul-Zyklus mit den Besitzern (`riskGuard`, `engine`, …).
import type { RiskLimits, AdaptiveRiskState } from "./riskGuard";
import type { BrokerAdapter, BrokerVenueId } from "../contracts/broker";
import type { PaperBroker } from "./broker";
import type { ControlPlaneService } from "../brokers/control-plane/service";
import type { VenueControlState } from "../brokers/control-plane/states";

/**
 * EIN globalThis-Namensraum fuer alle Cross-Cutting-Singletons. Das ueberlebt
 * Next.js-HMR/Modul-Neukompilierung genauso wie vorher die einzelnen
 * `G.__…`-Keys — jetzt aber als EINE sichtbare Instanz.
 */
const NS_KEY = "__AITF_STATE_REGISTRY__";
const G = globalThis as typeof globalThis & {
  __AITF_STATE_REGISTRY__?: Record<string, unknown>;
};
const NS: Record<string, unknown> = (G.__AITF_STATE_REGISTRY__ ??= {});

/** Boolesches Flag (Default false). */
export interface FlagAccessor {
  get(): boolean;
  set(v: boolean): boolean;
  reset(): void;
}

/** Map-Value (lazy erzeugt; reset loescht → naechster Zugriff erzeugt neu). */
export interface MapAccessor<K, V> {
  get(): Map<K, V>;
  clear(): void;
  reset(): void;
  has(): boolean;
}

/**
 * Referenz auf einen Wert (optional mit Default-Fabrik). `get()` liefert nach
 * einem `reset()` wieder den Default — so ist "Reset" fuer Tests immer
 * deterministisch, ohne dass die Besitzer nachziehen muessen.
 */
export interface RefAccessor<T> {
  get(): T | undefined;
  set(v: T): T;
  reset(): void;
  has(): boolean;
  /** Default-Fabrik registrieren (wird nach `reset()` beim naechsten `get()` neu ausgefuehrt). */
  setDefault(factory: () => T): void;
}

function flag(key: string): FlagAccessor {
  return {
    get: () => NS[key] === true,
    set: (v: boolean): boolean => {
      NS[key] = v;
      return v;
    },
    reset: () => {
      delete NS[key];
    },
  };
}

function map<K, V>(key: string): MapAccessor<K, V> {
  const get = (): Map<K, V> => {
    const current = NS[key];
    if (current instanceof Map) return current as Map<K, V>;
    const created = new Map<K, V>();
    NS[key] = created;
    return created;
  };
  return {
    get,
    clear: () => get().clear(),
    has: () => NS[key] instanceof Map,
    reset: () => {
      delete NS[key];
    },
  };
}

function ref<T>(key: string): RefAccessor<T> {
  let defaultFactory: (() => T) | null = null;
  const get = (): T | undefined => {
    if (NS[key] === undefined && defaultFactory) NS[key] = defaultFactory();
    return NS[key] as T | undefined;
  };
  return {
    get,
    set: (v: T): T => {
      NS[key] = v;
      return v;
    },
    setDefault: (factory: () => T) => {
      defaultFactory = factory;
    },
    has: () => NS[key] !== undefined,
    reset: () => {
      delete NS[key];
    },
  };
}

/**
 * Die eine, typed zentrale Sicht auf allen Cross-Cutting-State.
 * Besitzer-Dateien greifen NUR ueber diese Accessoren auf ihre Singletons zu
 * (keine eigenen `globalThis`-Deklarationen mehr), Tests reseten ueber
 * `__resetAllSingletonsForTests()`.
 */
export const state = {
  // ── Engine (src/lib/engine.ts) ─────────────────────────────────────────────
  /** Papier-Ledger aus DB hydriert? (Wahrheit: `positions`/`equity_snapshots`.) */
  firmHydrated: flag("firmHydrated"),
  /** Pipeline-Einzelausfuehrung aktiv? (RAM-Mutex gegen Doppelverarbeitung.) */
  pipelineBusy: flag("pipelineBusy"),

  // ── Control Plane (src/brokers/control-plane/service.ts) ───────────────────
  /** Venue-Zustands-Cache (Wahrheit: `venue_control_state`). */
  controlPlaneStates: map<string, VenueControlState>("controlPlaneStates"),
  /** Dedup laufender Hydrationen je Venue (RAM). */
  controlPlaneHydrating: map<string, Promise<VenueControlState>>("controlPlaneHydrating"),
  /** Boot-Warmup-Singleton (RAM). */
  controlPlaneWarmupPromise: ref<Promise<number>>("controlPlaneWarmupPromise"),
  /** Service-Singleton (RAM). */
  controlPlaneServicePromise: ref<Promise<ControlPlaneService>>("controlPlaneServicePromise"),
  /** Einmalige Persistenz-Warnung pro Prozess (RAM). */
  controlPlanePersistWarned: flag("controlPlanePersistWarned"),

  // ── Risk-Guard (src/lib/riskGuard.ts) ──────────────────────────────────────
  /** In-Memory-Circuit-Breaker (Arm-Zustand zusätzlich in `kill_switches`). */
  killSwitchArmed: flag("killSwitchArmed"),
  /** Konfigurierte Basis-Limits (Wahrheit: `risk_config`; Default aus Code). */
  baseLimits: ref<RiskLimits>("baseLimits"),
  /** Wirksame Limits = Basis + adaptiver Marktfaktor (RAM-Projektion). */
  currentLimits: ref<RiskLimits>("currentLimits"),
  /** Aktuelle Volatilitaets-Bewertung (RAM; `PERSISTED`-Faktor liegt in DB). */
  adaptiveState: ref<AdaptiveRiskState | null>("adaptiveState"),

  // ── Broker-Factory (src/brokers/factory.ts) ────────────────────────────────
  /** Adapter-Singletons je venue:mode (RAM-Cache). */
  brokerAdapters: map<`${BrokerVenueId}:${string}`, BrokerAdapter>("brokerAdapters"),
  /** Papier-Ledger (RAM; offene Positionen/Kill-Status werden aus DB hydriert). */
  paperBrokerLedger: ref<PaperBroker>("paperBrokerLedger"),

  // ── API-Auth (src/lib/apiAuth.ts) ──────────────────────────────────────────
  /** Sliding-Window-Rate-Limit-Bucket (RAM, Single-Node). */
  rateLimiterHits: map<string, number[]>("rateLimiterHits"),
} as const;

/**
 * DER eine Test-Reset: setzt ALLE registrierten Cross-Cutting-Singletons auf
 * ihren sauberen Ausgangszustand — auch jene, die frueher ueber verstreute
 * Funktionen (`resetControlPlaneForTests`, `resetRateLimiterForTests`,
 * `G.__firmHydrated`) zurueckgesetzt wurden. Ein Reset, der keinen Singleton
 * vergisst. Produktionspfad ruft diese Funktion nie auf.
 */
export function __resetAllSingletonsForTests(): void {
  // Engine
  state.firmHydrated.reset();
  state.pipelineBusy.reset();
  // Control Plane
  state.controlPlaneStates.reset();
  state.controlPlaneHydrating.reset();
  state.controlPlaneWarmupPromise.reset();
  state.controlPlaneServicePromise.reset();
  state.controlPlanePersistWarned.reset();
  // Risk-Guard
  state.killSwitchArmed.reset();
  state.baseLimits.reset();
  state.currentLimits.reset();
  state.adaptiveState.reset();
  // Broker-Factory
  state.brokerAdapters.reset();
  state.paperBrokerLedger.reset();
  // API-Auth
  state.rateLimiterHits.reset();
}