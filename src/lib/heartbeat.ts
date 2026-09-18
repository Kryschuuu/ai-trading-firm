/**
 * Heartbeat / Stale-Erkennung des Monitor-Ticks (GAP-10, D4, v1.45.0).
 *
 * „Die Firma läuft“ ist keine Selbstverständlichkeit: Der Scheduler-Tick
 * (60 s, `src/instrumentation.ts`) kann sterben — Prozess lebt, Tick tot.
 * Ein reiner Prozess-Healthcheck sieht das nicht. Deshalb:
 *
 *   - `/api/health` meldet `monitorLastTickAt` + `stale` (+ Alter/Schwelle),
 *   - `scripts/watchdog.ts` ist der alarm-first Gegenpart (kein Auto-Restart),
 *   - beide nutzen DIESELBE Berechnung (`heartbeatSnapshot`) und dieselbe
 *     Schwelle `HEALTH_STALE_AFTER_MS` (Default 300000 ms = 5 Min,
 *     Bounds [30000, 3600000]).
 *
 * Quelle ist `state.monitorLastTickAt` (RAM, vom Monitor-Tick gesetzt). Das
 * Signal ist damit bewusst DB-frei lesbar — gerade bei einem DB-Ausfall muss
 * „der Tick stand“ noch erkennbar sein.
 *
 * Semantik (getestet, Grenzwerte):
 *   - noch nie ein Tick (`null`)          → `stale: true` (fail-loud: ein
 *     frisch gestarteter Prozess ist erst nach dem ersten Tick gesund),
 *   - Alter > Schwelle                    → `stale: true`,
 *   - Alter <= Schwelle                   → `stale: false` (die Schwelle
 *     selbst ist noch gesund — `>` ist die Alarmgrenze).
 *
 * Die Zeit kommt als Parameter (deterministisch, keine versteckte Uhr).
 */
import { envNumber } from "./env";
import { state } from "./stateRegistry";

/** Env-Name der Stale-Schwelle (Doku in CONFIGURATION.md). */
export const HEALTH_STALE_AFTER_MS_FLAG = "HEALTH_STALE_AFTER_MS";

/** Bounds der Stale-Schwelle in ms (30 s … 60 min). */
export const HEALTH_STALE_AFTER_MS_BOUNDS = { min: 30_000, max: 3_600_000 } as const;

/** Default: 5 Minuten (mehrere verpasste 60-s-Ticks). */
export const HEALTH_STALE_AFTER_MS_DEFAULT = 300_000;

export interface HealthConfig {
  staleAfterMs: number;
}

/** Lädt die Health-Konfiguration (Bounds-Clamp mit Warnung, Muster `envNumber`). */
export function loadHealthConfig(
  env: Record<string, string | undefined> = process.env,
): HealthConfig {
  return {
    staleAfterMs: envNumber(
      HEALTH_STALE_AFTER_MS_FLAG,
      HEALTH_STALE_AFTER_MS_DEFAULT,
      HEALTH_STALE_AFTER_MS_BOUNDS.min,
      HEALTH_STALE_AFTER_MS_BOUNDS.max,
      env,
    ),
  };
}

/** Momentaufnahme des Monitor-Heartbeats. */
export interface HeartbeatSnapshot {
  /** ISO-Zeitpunkt des letzten Ticks oder `null` (noch keiner). */
  monitorLastTickAt: string | null;
  /** Alter des letzten Ticks in ms (`null` = kein Tick bekannt). */
  monitorAgeMs: number | null;
  /** true = Tick überfällig oder noch nie gelaufen. */
  stale: boolean;
  /** Wirksame Schwelle in ms (für Doku/Alarm-Meta). */
  staleAfterMs: number;
}

export interface HeartbeatInput {
  /** Aktueller Zeitstempel (ms). */
  now: number;
  /** Zeitpunkt des letzten Ticks (ms) oder `null`. */
  lastTickAtMs: number | null;
  /** Wirksame Schwelle (ms); Default aus Env/Bounds. */
  staleAfterMs?: number;
  env?: Record<string, string | undefined>;
}

/**
 * Reine Stale-Berechnung: kein IO, keine Uhr — exakt die Grenzfall-Semantik
 * aus dem Modul-Kommentar. `null`-Heartbeat ist stale (fail-loud).
 */
export function heartbeatSnapshot(input: HeartbeatInput): HeartbeatSnapshot {
  const staleAfterMs =
    typeof input.staleAfterMs === "number" && Number.isFinite(input.staleAfterMs)
      ? input.staleAfterMs
      : loadHealthConfig(input.env).staleAfterMs;
  const last = input.lastTickAtMs;
  if (typeof last !== "number" || !Number.isFinite(last)) {
    return { monitorLastTickAt: null, monitorAgeMs: null, stale: true, staleAfterMs };
  }
  const age = Math.max(0, input.now - last);
  return {
    monitorLastTickAt: new Date(last).toISOString(),
    monitorAgeMs: age,
    stale: age > staleAfterMs,
    staleAfterMs,
  };
}

/** Heartbeat aus dem Prozess-Zustand (Quelle: `state.monitorLastTickAt`). */
export function readHeartbeat(
  now: number = Date.now(),
  env: Record<string, string | undefined> = process.env,
): HeartbeatSnapshot {
  return heartbeatSnapshot({
    now,
    lastTickAtMs: state.monitorLastTickAt.get() ?? null,
    env,
  });
}
