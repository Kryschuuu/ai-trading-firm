/**
 * Live-Gate-Runtime (Task 11) — alle Zustandsquellen EINER Machine-Instanz.
 *
 * Eine Runtime = ein Data-Dir (Default `data/live-gate`, über LIVE_GATE_DATA_DIR
 * übersteuerbar). Sie hält:
 *   - Store (per-Venue State-Files, atomar, crash-safe)
 *   - Audit (Hash-Kette, Ring + NDJSON + DB best-effort)
 *   - Kill-Memory (prozesslokal, sofort wirksam, erster Failsafe-Schritt)
 *
 * Der Enforcer liest AUSSCHLIESSLICH diese persistierte Machine (plus Env-Flags,
 * Suite-Stamp und Kill-Failsafe-Datei) — niemals UI-Flags oder Agent-Aussagen.
 */
import { LiveGateAudit } from "./audit";
import { LiveGateStore } from "./store";
import { liveGateConfig, liveGateDataDir, type LiveGateConfig, type LiveGateEnv } from "./config";
import { isKilledInFile, type KillFileEntry } from "./killFile";

export class LiveGateRuntime {
  readonly dir: string;
  readonly audit: LiveGateAudit;
  readonly store: LiveGateStore;
  readonly killedMemory = new Set<string>();

  constructor(readonly env: LiveGateEnv) {
    this.dir = liveGateDataDir(env);
    this.audit = new LiveGateAudit(this.dir);
    this.store = new LiveGateStore(this.dir, this.audit);
  }

  config(): LiveGateConfig {
    return liveGateConfig(this.env);
  }

  /** Kill aktiv? Memory zuerst (sofort), dann persistente Failsafe-Datei. */
  isKilled(venue: string): KillFileEntry | null {
    const v = venue.toUpperCase();
    if (this.killedMemory.has("*") || this.killedMemory.has(v)) {
      return {
        scope: this.killedMemory.has("*") ? "*" : v,
        at: new Date().toISOString(),
        actor: "runtime-memory",
        reason: "Kill aktiv (prozesslokal, sofort wirksam).",
      };
    }
    return isKilledInFile(this.dir, v);
  }
}

const G = globalThis as typeof globalThis & {
  __liveGateRuntimes?: Map<string, LiveGateRuntime>;
};

function runtimeRegistry(): Map<string, LiveGateRuntime> {
  return (G.__liveGateRuntimes ??= new Map());
}

/** Runtime je Data-Dir (Singleton; Env wird beim ersten Zugriff eingeefroren). */
export function getLiveGateRuntime(env: LiveGateEnv = process.env): LiveGateRuntime {
  const dir = liveGateDataDir(env);
  let rt = runtimeRegistry().get(dir);
  if (!rt) {
    rt = new LiveGateRuntime(env);
    runtimeRegistry().set(dir, rt);
  }
  return rt;
}

/** Nur Tests: alle Runtimes verwerfen (Dateien bleiben). */
export function resetLiveGateRuntimesForTests(): void {
  runtimeRegistry().clear();
}
