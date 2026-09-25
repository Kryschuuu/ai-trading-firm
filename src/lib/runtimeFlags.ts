/**
 * Laufzeit-Schalter (Runtime Flags) — persistente, UI-bedienbare Betriebs-Flags.
 *
 * ── Warum es dieses Modul gibt ──────────────────────────────────────────────
 * Mehrere Betriebs-Entscheidungen waren bisher **nur** per `.env` und damit nur
 * mit Prozess-Neustart änderbar:
 *
 *   - Remote-Health-Checks der Broker (`BROKER_HEALTHCHECK_REMOTE`)
 *   - Freigabe/Sperre einzelner LLM-Provider (inkl. Cloud-Free-Modelle)
 *
 * Der Operator soll solche Schalter **bequem in der Oberfläche** umlegen
 * können, ohne die Anwendung neu zu starten. Gleichzeitig gilt die
 * Sicherheits-Regel des Repos: kein Netzwerk-I/O ohne ausdrückliche
 * Entscheidung — deshalb ist der Default weiterhin `false` bzw. „an" nur da,
 * wo der Provider ohnehin konfiguriert ist, und jede Änderung ist ein
 * auditierter Admin-Vorgang.
 *
 * ── Semantik ────────────────────────────────────────────────────────────────
 * `null` (kein gesetzter Wert) heißt: **es gilt der Env-Default**. Ein
 * gesetzter Bool-Wert ist eine explizite Operator-Entscheidung und gewinnt.
 *
 *   effektiv = Runtime-Flag (falls gesetzt) → sonst Env-Default → sonst Code-Default
 *
 * ── Persistenz ──────────────────────────────────────────────────────────────
 * Eine kleine JSON-Datei (`data/runtime/flags.json`, überschreibbar über
 * `RUNTIME_FLAGS_FILE`) mit **ausschließlich Bool-Werten** — keine Secrets,
 * keine URLs, keine Freitexte. Geschrieben wird atomar (temp + rename) mit
 * Modus `0o600`; Lesen ist fehlertolerant (kaputte/fehlende Datei ⇒ leere
 * Menge + sichtbarer `error`, niemals ein Wurf im Request-Pfad).
 *
 * Der Dateipfad kommt — wie überall im Repo (`src/lib/appPaths.ts`) — über
 * `resolveRuntimePath()`, damit `..`-Ausbrüche abgelehnt werden.
 *
 * @example
 * ```ts
 * runtimeFlagValue("broker.healthcheck.remote");      // null | true | false
 * setRuntimeFlag("broker.healthcheck.remote", true);  // explizite Entscheidung
 * clearRuntimeFlag("broker.healthcheck.remote");      // zurück auf Env-Default
 * ```
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveRuntimePath } from "./appPaths";

/** Env-Override für den Ablageort der Flag-Datei (Tests, externe Volumes). */
export const RUNTIME_FLAGS_FILE_ENV = "RUNTIME_FLAGS_FILE";

/** Default-Ablage (relativ zum Projektstamm). */
export const DEFAULT_RUNTIME_FLAGS_FILE = "data/runtime/flags.json";

/** Erlaubter Werte-Typ: ausschließlich Bool (keine Freitexte, keine Secrets). */
export type RuntimeFlagValue = boolean;

/** Sicht auf einen einzelnen Schalter (API/UI). */
export interface RuntimeFlagView {
  key: string;
  value: RuntimeFlagValue;
  /** `true`, wenn der Wert explizit gesetzt ist (nicht nur Default). */
  explicit: boolean;
  /** Zeitpunkt der letzten Änderung (ISO) oder `null`. */
  updatedAt: string | null;
  /** Akteur der letzten Änderung (Audit-Kontext, gekürzt) oder `null`. */
  updatedBy: string | null;
  label: string;
  description: string;
  /** Env-Variable, deren Wert als Default dient (oder `null`). */
  envVar: string | null;
  /** Wert, der ohne Runtime-Flag gelten würde. */
  defaultValue: RuntimeFlagValue;
  /** `true`, wenn die Änderung eines gesetzten Werts wieder auf Default führt. */
  mutable: boolean;
  /** Effektiver Wert nach Auflösung (Runtime → Env → Code-Default). */
  effective: RuntimeFlagValue;
  /** Quelle des effektiven Werts. */
  source: RuntimeFlagSource;
}

/** Woher der effektive Wert stammt. */
export type RuntimeFlagSource = "runtime" | "env" | "default";

/**
 * Beschreibung eines Schalters. `envVar` ist optional: gesetzt ⇒ der Wert
 * dieser Env-Variable ist der Default (`"true"` = an, sonst aus).
 */
export interface RuntimeFlagSpec {
  key: string;
  label: string;
  description: string;
  envVar?: string;
  defaultValue: RuntimeFlagValue;
  /** Default `true`; `false` verbietet UI-Änderungen (nur lesbar). */
  mutable?: boolean;
}

/** Gespeicherter Eintrag in der Datei. */
interface StoredFlag {
  value: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

interface FlagsFileState {
  flags: Record<string, StoredFlag>;
  error: string | null;
}

/** Prozess-Cache: Dateipfad → zuletzt gelesener Zustand (mit mtime/size). */
interface FlagsCacheEntry extends FlagsFileState {
  mtimeMs: number;
  size: number;
  /** `false`, wenn die Datei zuletzt nicht existierte. */
  exists: boolean;
}

const G = globalThis as typeof globalThis & {
  __runtimeFlagsCache?: Map<string, FlagsCacheEntry>;
};

const cache: Map<string, FlagsCacheEntry> = (G.__runtimeFlagsCache ??= new Map());

/** Nur für Tests: Cache verwerfen (Datei bleibt unberührt). */
export function resetRuntimeFlagsCacheForTests(): void {
  cache.clear();
}

/** Löst den Ablageort der Flag-Datei auf (Env-Override → Default). */
export function resolveFlagsFile(env: Record<string, string | undefined> = process.env): string {
  const raw = (env[RUNTIME_FLAGS_FILE_ENV] ?? process.env[RUNTIME_FLAGS_FILE_ENV] ?? "").trim();
  return resolveRuntimePath(raw || DEFAULT_RUNTIME_FLAGS_FILE);
}

/**
 * Liest die Datei mit mtime/size-Check. Fehler werden **nie** geworfen:
 * ein kaputter Eintrag wird verworfen, die Datei als Ganzes als leer
 * behandelt und der Grund als `error` mitgeführt (sichtbar in der UI).
 */
function loadFlags(file: string): FlagsCacheEntry {
  const cached = cache.get(file);
  let mtimeMs = 0;
  let size = -1;
  let exists = existsSync(file);
  if (exists) {
    try {
      const st = statSync(file);
      mtimeMs = st.mtimeMs;
      size = st.size;
    } catch {
      exists = false;
    }
  }
  if (cached && cached.exists === exists && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached;
  }

  const next: FlagsCacheEntry = { flags: {}, error: null, mtimeMs, size, exists };
  if (exists) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
          const value = normalizeStoredFlag(raw);
          if (value) next.flags[key] = value;
        }
      } else {
        next.error = "FLAGS_FILE_INVALID";
      }
    } catch {
      next.error = "FLAGS_FILE_UNREADABLE";
    }
  }
  cache.set(file, next);
  return next;
}

/** Akzeptiert sowohl `{value,updatedAt,…}` als auch ein nacktes Bool. */
function normalizeStoredFlag(raw: unknown): StoredFlag | null {
  if (typeof raw === "boolean") {
    return { value: raw, updatedAt: new Date(0).toISOString(), updatedBy: null };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (typeof record.value !== "boolean") return null;
    return {
      value: record.value,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
      updatedBy: typeof record.updatedBy === "string" ? record.updatedBy.slice(0, 64) : null,
    };
  }
  return null;
}

/** Alle gesetzten Flags (kopiert) + Diagnose. */
export function readRuntimeFlags(
  env: Record<string, string | undefined> = process.env
): { flags: Record<string, RuntimeFlagValue>; error: string | null; file: string } {
  const file = resolveFlagsFile(env);
  const state = loadFlags(file);
  const flags: Record<string, RuntimeFlagValue> = {};
  for (const [key, entry] of Object.entries(state.flags)) flags[key] = entry.value;
  return { flags, error: state.error, file };
}

/** Gesetzter Wert (`null` = kein Runtime-Flag ⇒ Env/Code-Default gilt). */
export function runtimeFlagValue(
  key: string,
  env: Record<string, string | undefined> = process.env
): RuntimeFlagValue | null {
  const file = resolveFlagsFile(env);
  const entry = loadFlags(file).flags[key];
  return entry ? entry.value : null;
}

/** Metadaten (Zeit/Akteur) eines gesetzten Flags. */
export function runtimeFlagMeta(
  key: string,
  env: Record<string, string | undefined> = process.env
): { updatedAt: string | null; updatedBy: string | null } {
  const file = resolveFlagsFile(env);
  const entry = loadFlags(file).flags[key];
  return { updatedAt: entry?.updatedAt ?? null, updatedBy: entry?.updatedBy ?? null };
}

/** Env-Default eines Schalters (`"true"` = an; sonst der Code-Default). */
export function envFlagDefault(
  spec: RuntimeFlagSpec,
  env: Record<string, string | undefined> = process.env
): RuntimeFlagValue {
  if (!spec.envVar) return spec.defaultValue;
  const raw = env[spec.envVar];
  if (raw === undefined || raw === null || String(raw).trim() === "") return spec.defaultValue;
  return String(raw).trim().toLowerCase() === "true";
}

/** Effektiver Wert + Quelle eines Schalters (Runtime → Env → Default). */
export function resolveRuntimeFlag(
  spec: RuntimeFlagSpec,
  env: Record<string, string | undefined> = process.env
): { value: RuntimeFlagValue; source: RuntimeFlagSource } {
  const explicit = runtimeFlagValue(spec.key, env);
  if (explicit !== null) return { value: explicit, source: "runtime" };
  if (spec.envVar) {
    const raw = env[spec.envVar];
    if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
      return { value: envFlagDefault(spec, env), source: "env" };
    }
  }
  return { value: spec.defaultValue, source: "default" };
}

/** Vollständige Sicht auf einen Schalter (für API/UI). */
export function runtimeFlagView(
  spec: RuntimeFlagSpec,
  env: Record<string, string | undefined> = process.env
): RuntimeFlagView {
  const resolved = resolveRuntimeFlag(spec, env);
  const meta = runtimeFlagMeta(spec.key, env);
  const explicit = runtimeFlagValue(spec.key, env) !== null;
  return {
    key: spec.key,
    value: resolved.value,
    explicit,
    updatedAt: explicit ? meta.updatedAt : null,
    updatedBy: explicit ? meta.updatedBy : null,
    label: spec.label,
    description: spec.description,
    envVar: spec.envVar ?? null,
    defaultValue: envFlagDefault(spec, env),
    mutable: spec.mutable !== false,
    effective: resolved.value,
    source: resolved.source,
  };
}

export type SetRuntimeFlagResult =
  | { ok: true; key: string; value: RuntimeFlagValue; view: RuntimeFlagView }
  | { ok: false; error: string };

/**
 * Setzt ein Flag persistent (atomarer Schreibvorgang). Fehler werden als
 * Ergebnis gemeldet — der Aufrufer (API-Route) antwortet damit 4xx/5xx,
 * statt eine Ausnahme in den Request-Pfad zu lassen.
 */
export function setRuntimeFlag(
  spec: RuntimeFlagSpec,
  value: RuntimeFlagValue,
  opts: {
    env?: Record<string, string | undefined>;
    by?: string | null;
    now?: Date;
  } = {}
): SetRuntimeFlagResult {
  const env = opts.env ?? process.env;
  if (typeof value !== "boolean") return { ok: false, error: "INVALID_VALUE" };
  if (spec.mutable === false) return { ok: false, error: "FLAG_NOT_MUTABLE" };

  const file = resolveFlagsFile(env);
  const current = loadFlags(file);
  const next: Record<string, StoredFlag> = { ...current.flags };
  next[spec.key] = {
    value,
    updatedAt: (opts.now ?? new Date()).toISOString(),
    updatedBy: opts.by ? String(opts.by).slice(0, 64) : null,
  };

  const written = writeFlagsFile(file, next);
  if (!written.ok) return { ok: false, error: written.error };

  // Cache invalidieren — der nächste Leser sieht den neuen Stand.
  cache.delete(file);
  return { ok: true, key: spec.key, value, view: runtimeFlagView(spec, env) };
}

/** Entfernt ein Flag ⇒ es gilt wieder Env-/Code-Default (`null` = war nicht gesetzt). */
export function clearRuntimeFlag(
  key: string,
  env: Record<string, string | undefined> = process.env
): { ok: boolean; error?: string; removed: boolean } {
  const file = resolveFlagsFile(env);
  const current = loadFlags(file);
  if (!(key in current.flags)) return { ok: true, removed: false };
  const next: Record<string, StoredFlag> = { ...current.flags };
  delete next[key];
  const written = writeFlagsFile(file, next);
  if (!written.ok) return { ok: false, error: written.error, removed: false };
  cache.delete(file);
  return { ok: true, removed: true };
}

/**
 * Atomares Schreiben: temp-Datei im Zielverzeichnis + `rename`. Rechte `0o600`
 * (nur Bool-Werte, aber konsequent restriktiv wie die übrigen State-Dateien).
 * Eine leere Datei wird gelöscht, damit kein toter Zustand zurückbleibt.
 */
function writeFlagsFile(
  file: string,
  flags: Record<string, StoredFlag>
): { ok: true } | { ok: false; error: string } {
  try {
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
    if (Object.keys(flags).length === 0) {
      if (existsSync(file)) unlinkSync(file);
      return { ok: true };
    }
    const payload = `${JSON.stringify(flags, null, 2)}\n`;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, payload, { mode: 0o600 });
    renameSync(tmp, file);
    return { ok: true };
  } catch {
    return { ok: false, error: "FLAGS_WRITE_FAILED" };
  }
}
