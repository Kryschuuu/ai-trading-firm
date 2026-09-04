/**
 * Durable Audit-Senke (S1, v1.36.18) — „kein Audit-Eintrag verschwindet still“.
 *
 * Warum diese Datei existiert:
 *   Audit-Schreibvorgänge waren reihenweise in `try/catch` mit leerem Body
 *   verpackt (`/* best-effort *\/`). Für ein Trading-System ist das ein
 *   Sicherheitsproblem: eine erfolgreiche Mutation (Credential gespeichert,
 *   Prompt geändert, Not-Halt entschärft, Order abgelehnt) kann ohne den
 *   zugehörigen Audit-Eintrag bleiben — und der Betreiber erfährt nichts davon.
 *   Die revisionssichere Kette hätte eine Lücke, die niemand sieht.
 *
 * Zwei Klassen (Befund S1, Fix-Spezifikation):
 *   - `security`  — Auth, Kill-Switch, Credential-Operationen, Order-Ablehnungen,
 *     Proposal-Freigaben, Prompt-Änderungen. **Kein stilles Schlucken.**
 *     Ablauf: Versuch → Retry mit Backoff → persistenter Spool-Fallback
 *     (NDJSON, at-least-once) → CRITICAL-Alarm + Metrik. Ist die Mutation noch
 *     vermeidbar, setzt der Aufrufer `failClosed`: dann wirft das Audit
 *     (`AuditPersistenceError`), bevor überhaupt etwas geändert wird.
 *   - `telemetry` — optionale Beobachtbarkeit (Failover-Ringe, Routing-Log,
 *     adaptive Risiko-Events). Bleibt best-effort, ist aber **nie still**: ein
 *     Fehlschlag zählt und loggt eine Warnung.
 *
 * At-least-once (bewusste Abstufung, kein Bug):
 *   Scheitert der DB-Schreibvorgang, wandert der Eintrag in einen append-only
 *   Spool (`data/audit-spool/audit-pending.ndjson`, Modus 0600) und wird beim
 *   nächsten erfolgreichen Schreibvorgang (oder beim Boot) nach `audit_log`
 *   nachgezogen. Weil ein fehlgeschlagener Insert am Server trotzdem verbucht
 *   worden sein kann (Timeout nach Commit), kann dieselbe Zeile **doppelt** in
 *   `audit_log` landen. Duplikate sind korrigierbar, Verlust nicht — deshalb
 *   at-least-once statt exactly-once.
 *
 * Lärm-Regel (kein Log-/Retry-DoS bei DB-Ausfall):
 *   Metrik und Degradations-Ring zählen **jeden** Einzelfall. Die Logzeile wird
 *   pro Ereignisschlüssel in einem Fenster (`AUDIT_ALERT_COOLDOWN_MS`)
 *   gebündelt und nennt die unterdrückte Anzahl. Retries werden während eines
 *   Cooldowns (`AUDIT_DB_COOLDOWN_MS`) übersprungen — sonst hinge bei einem
 *   DB-Ausfall jeder einzelne Audit im Backoff und bremste den Handelspfad.
 *
 * Secrets: Der Spool enthält ausschließlich, was auch in `audit_log` stünde
 * (event/level/detail/missionId/agentId). `detail` ist an den Aufrufstellen
 * bereits secret-frei; zusätzlich wird jede Zeile auf `AUDIT_SPOOL_LINE_MAX`
 * Zeichen begrenzt.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { envInt } from "./env";
import { sanitizeLogField, structuredLog } from "./logger";
import { telemetry } from "./telemetry";

// ─────────────────────────────────────────────────────────────────────────────
// Klassen und Verträge
// ─────────────────────────────────────────────────────────────────────────────

/** Sicherheitsklasse (`security`) oder optionale Telemetrie (`telemetry`). */
export const AUDIT_CLASSES = ["security", "telemetry"] as const;
export type AuditClass = (typeof AUDIT_CLASSES)[number];

export type AuditLevel = "INFO" | "WARN" | "CRITICAL";

/** Ziel, in dem der Eintrag letztlich gelandet ist. */
export type AuditTarget = "db" | "spool" | "none";

/** Was eine Senke brauchen darf — bewusst schmal, damit Tests es ersetzen können. */
export interface AuditRow {
  event: string;
  level: AuditLevel;
  detail: unknown;
  missionId?: string;
  agentId?: string;
}

export type AuditTransport = (row: AuditRow) => Promise<void>;

export interface AuditRecord extends AuditRow {
  /** `security` = Retry + Spool + Alarm; `telemetry` = Warnung + Metrik. */
  auditClass: AuditClass;
  /**
   * Nur für Audits **vor** der Mutation: wirft `AuditPersistenceError`, wenn
   * weder DB noch Spool durable waren — die Operation bleibt dann aus
   * (fail-closed), statt ohne Auditbeleg zu geschehen.
   */
  failClosed?: boolean;
  /** Versuche zusätzlich zum ersten (Default aus `AUDIT_RETRY_MAX`). */
  retries?: number;
  /** Spool-Fallback abschalten (nur Tests/Drills). */
  spool?: boolean;
}

/** Ergebnis eines Audit-Schreibversuchs — Aufrufer dürfen (und sollen) es auswerten. */
export interface AuditWriteOutcome {
  event: string;
  auditClass: AuditClass;
  /** In `audit_log` **oder** im Spool durable abgelegt. */
  durable: boolean;
  target: AuditTarget;
  /** true = nicht in der DB, aber im Spool (Nachzug ausstehend). */
  degraded: boolean;
  /** true = hat Warnung/CRITICAL-Zeile und Metrik ausgelöst (also nie still). */
  flagged: boolean;
  attempts: number;
  /** redigiert und gekürzt; `null` bei Erfolg. */
  error: string | null;
  at: string;
}

/** Eintrag im Degradations-Ring (Ops/Health/Tests — bounded, secret-frei). */
export interface AuditDegradationRecord {
  at: string;
  event: string;
  auditClass: AuditClass;
  target: AuditTarget;
  attempts: number;
  error: string | null;
  /** `write` = regulärer Schreibpfad, `missed` = gemeldete Audit-Lücke. */
  path: "write" | "missed";
}

/** Wurf bei `failClosed`, damit die Mutation ausbleibt. */
export class AuditPersistenceError extends Error {
  readonly code = "AUDIT_PERSISTENCE_FAILED" as const;

  constructor(event: string, detail: string) {
    super(
      `Audit-Schreibvorgang für „${event}“ war nicht durable (DB und Spool fehlgeschlagen): ${detail}`
    );
    this.name = "AuditPersistenceError";
  }
}

/**
 * Erkennungs-Helfer für `AuditPersistenceError`.
 *
 * Duck-Type ZUSÄTZLICH zu `instanceof`: der Next-Build legt Module in eigene
 * Chunks, über Chunk-Grenzen hinweg ist `instanceof` nicht garantiert
 * (dieselbe Erfahrung wie in `src/instrumentation.ts`). Ein Route-Handler, der
 * den Fehler nicht erkennt, würde statt „503 Audit-Lücke“ ein unbestimmter
 * 500 liefern — genau die Art Fehler, den S1 sichtbar machen will.
 */
export function isAuditPersistenceError(err: unknown): err is AuditPersistenceError {
  return (
    err instanceof AuditPersistenceError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { name?: string }).name === "AuditPersistenceError" &&
      (err as { code?: string }).code === "AUDIT_PERSISTENCE_FAILED")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Konfiguration
// ─────────────────────────────────────────────────────────────────────────────

/** Verzeichnis des persistenten Fallbacks (relativ zum Projektstamm oder absolut). */
export const AUDIT_SPOOL_DIR_FLAG = "AUDIT_SPOOL_DIR";
export const AUDIT_SPOOL_DIR_DEFAULT = "data/audit-spool";
export const AUDIT_SPOOL_FILE_NAME = "audit-pending.ndjson";

/** Zusätzliche Versuche bei `security`-Audits (0 = kein Retry). */
export const AUDIT_RETRY_MAX_FLAG = "AUDIT_RETRY_MAX";
/** Basis des exponentiellen Backoffs in ms. */
export const AUDIT_RETRY_BASE_MS_FLAG = "AUDIT_RETRY_BASE_MS";
/** Fenster, in dem nach einem Fehlschlag die Retries übersprungen werden. */
export const AUDIT_DB_COOLDOWN_MS_FLAG = "AUDIT_DB_COOLDOWN_MS";

const RETRY_MAX_DEFAULT = 2;
const RETRY_BASE_MS_DEFAULT = 50;
const DB_COOLDOWN_MS_DEFAULT = 2_000;

/** Bündelungsfenster für Alarmzeilen pro Ereignisschlüssel. */
export const AUDIT_ALERT_COOLDOWN_MS = 30_000;
/** Harte Obergrenze des Spools (Speicherschutz; Überlauf wird CRITICAL gemeldet). */
export const AUDIT_SPOOL_MAX_ENTRIES = 20_000;
/** Maximale Zeilenlänge im Spool. */
export const AUDIT_SPOOL_LINE_MAX = 8_000;
/** Maximale Länge eines Event-Codes. */
export const AUDIT_EVENT_MAX = 64;
/** Größe des Degradations-Rings. */
const RECENT_MAX = 100;
/** Mindestabstand zweier Nachzüge (sonst liest jeder erfolgreiche Write den Spool). */
const DRAIN_MIN_INTERVAL_MS = 5_000;

export interface AuditSinkConfig {
  retryMax: number;
  backoffMs: number;
  dbCooldownMs: number;
  spoolDir: string;
  spoolFile: string;
}

/** Wird pro Aufruf gelesen — Tests und Drills dürfen ohne Neustart umkonfigurieren. */
export function auditSinkConfig(
  env: Record<string, string | undefined> = process.env
): AuditSinkConfig {
  const rawDir = env[AUDIT_SPOOL_DIR_FLAG]?.trim();
  const dir = rawDir && rawDir.length > 0 ? rawDir : AUDIT_SPOOL_DIR_DEFAULT;
  const abs = path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
  return {
    retryMax: envInt(AUDIT_RETRY_MAX_FLAG, RETRY_MAX_DEFAULT, 0, 10, env),
    backoffMs: envInt(AUDIT_RETRY_BASE_MS_FLAG, RETRY_BASE_MS_DEFAULT, 0, 5_000, env),
    dbCooldownMs: envInt(AUDIT_DB_COOLDOWN_MS_FLAG, DB_COOLDOWN_MS_DEFAULT, 0, 600_000, env),
    spoolDir: abs,
    spoolFile: path.join(abs, AUDIT_SPOOL_FILE_NAME),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prozessweiter Zustand (überlebt HMR — Muster wie `src/lib/riskGuard.ts`)
// ─────────────────────────────────────────────────────────────────────────────

interface AuditDurabilityState {
  /** fehlgeschlagene Schreibversuche gegen `audit_log` (inkl. Retries) */
  dbFailures: number;
  /** Einträge, die im Spool gelandet sind */
  spooled: number;
  /** aus dem Spool erfolgreich nachgezogene Einträge */
  drained: number;
  /** security-Audits, die nirgends durable wurden (echter Verlust) */
  lost: number;
  /** vom Aufrufer gemeldete, bewusst hingenommene Audit-Lücken */
  missedFlagged: number;
  /** wegen Spool-Überlauf verworfene, älteste Einträge */
  overflowDropped: number;
  lastError: string | null;
  lastSpoolError: string | null;
  dbUnavailableUntil: number;
  lastDrainAt: number;
  /** Inhalt der Kopfzeile, die zuletzt am Nachzug scheiterte (Poison-Pill-Erkennung). */
  lastFailedHead: string | null;
  headFailures: number;
  recent: AuditDegradationRecord[];
  /** Alarm-Bündelung: Schlüssel → { bis, unterdrückt }. */
  alerts: Map<string, { until: number; suppressed: number }>;
}

const G = globalThis as typeof globalThis & {
  __auditDurability?: AuditDurabilityState;
};

function freshState(): AuditDurabilityState {
  return {
    dbFailures: 0,
    spooled: 0,
    drained: 0,
    lost: 0,
    missedFlagged: 0,
    overflowDropped: 0,
    lastError: null,
    lastSpoolError: null,
    dbUnavailableUntil: 0,
    lastDrainAt: 0,
    lastFailedHead: null,
    headFailures: 0,
    recent: [],
    alerts: new Map(),
  };
}

function state(): AuditDurabilityState {
  return (G.__auditDurability ??= freshState());
}

// ─────────────────────────────────────────────────────────────────────────────
// Injektionspunkte (Tests, Drills)
// ─────────────────────────────────────────────────────────────────────────────

let transportOverride: AuditTransport | null = null;
let sleepFn: (ms: number) => Promise<void> = (ms: number) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** Nur für Tests: DB-Schreibpfad ersetzen (werfender Stub oder Erfolgsmesser). */
export function setAuditTransportForTests(next: AuditTransport | null): void {
  transportOverride = next;
}

/** Nur für Tests: Backoff-Schlaf injizieren (deterministisch, ohne Latenz). */
export function setAuditSleepForTests(next: ((ms: number) => Promise<void>) | null): void {
  sleepFn =
    next ??
    ((ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()));
}

/**
 * Standard-Senke: `audit_log` über Drizzle. Dynamischer Import (wie in den
 * Venue-Audit-Modulen unter `src/brokers/<venue>/audit.ts`), damit Module ohne
 * DB-Infrastruktur (Tests, Build) ladbar bleiben.
 */
async function defaultTransport(row: AuditRow): Promise<void> {
  const { db } = await import("@/db");
  const { auditLog } = await import("@/db/schema");
  await db.insert(auditLog).values({
    event: row.event,
    level: row.level,
    detail: (row.detail ?? null) as object,
    missionId: row.missionId,
    agentId: row.agentId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Alarme (gebündelt, aber nie stumm)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loggt `event` höchstens alle `AUDIT_ALERT_COOLDOWN_MS` pro Schlüssel; die
 * unterdrückte Anzahl steht in der nächsten Zeile. Metrik- und Ring-Zählung
 * passieren beim Aufrufer **vor** diesem Aufruf und sind daher lückenlos.
 */
function alertBundle(
  level: "warn" | "error" | "critical",
  key: string,
  event: string,
  fields: Record<string, unknown>
): void {
  const s = state();
  const now = Date.now();
  const entry = s.alerts.get(key);
  if (entry && now < entry.until) {
    entry.suppressed += 1;
    return;
  }
  const suppressed = entry?.suppressed ?? 0;
  s.alerts.set(key, { until: now + AUDIT_ALERT_COOLDOWN_MS, suppressed: 0 });
  structuredLog(level, event, { ...fields, ...(suppressed > 0 ? { suppressed } : {}) });
}

function pushRecent(record: Omit<AuditDegradationRecord, "at">): void {
  const s = state();
  s.recent.push({ ...record, at: new Date().toISOString() });
  if (s.recent.length > RECENT_MAX) s.recent.splice(0, s.recent.length - RECENT_MAX);
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistenter Fallback: Spool (NDJSON, at-least-once)
// ─────────────────────────────────────────────────────────────────────────────

export interface SpoolEntry {
  /** monotone Folge je Prozess — nur für Diagnose und Reihenfolge */
  seq: number;
  at: string;
  event: string;
  level: AuditLevel;
  detail: unknown;
  missionId?: string;
  agentId?: string;
  auditClass: AuditClass;
}

let spoolSeq = 0;

/** Zeile für den Spool serialisieren; notfalls `detail` auf Text reduzieren. */
function serializeSpoolLine(entry: SpoolEntry): string {
  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    // zyklische oder fremde detail-Objekte: Kerninformationen retten, nie verlieren.
    line = JSON.stringify({ ...entry, detail: String(entry.detail) });
  }
  if (line.length > AUDIT_SPOOL_LINE_MAX) {
    line = JSON.stringify({
      ...entry,
      detail: sanitizeLogField(entry.detail, Math.floor(AUDIT_SPOOL_LINE_MAX / 2)),
      truncated: true,
    });
  }
  return line.length > AUDIT_SPOOL_LINE_MAX
    ? line.slice(0, AUDIT_SPOOL_LINE_MAX - 1)
    : line;
}

function countLines(file: string): number {
  try {
    if (statSync(file).size === 0) return 0;
    const content = readFileSync(file, "utf8");
    let n = 0;
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) n++;
    return content.endsWith("\n") ? n : n + 1;
  } catch {
    return 0;
  }
}

/** Zeilen des Spools (leer, wenn die Datei fehlt). Defekte Zeilen bleiben lesbar. */
function readSpoolLines(file: string): string[] {
  let raw: string;
  try {
    if (!existsSync(file)) return [];
    raw = readFileSync(file, "utf8");
  } catch (e) {
    state().lastSpoolError = sanitizeLogField(e);
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Atomares Umschreiben (tmp + rename) — kein halber Spool nach einem Crash. */
function writeSpoolLines(file: string, lines: string[]): void {
  const dir = path.dirname(file);
  try {
    if (lines.length === 0) {
      if (existsSync(file)) unlinkSync(file);
      return;
    }
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    state().lastSpoolError = sanitizeLogField(e);
  }
}

/**
 * Hängt einen Eintrag an den Spool an. Rückgabe `false` = auch der Spool ist
 * nicht schreibbar — dann entscheidet der Aufrufer über Alarm bzw. Abbruch.
 */
function spoolAppend(entry: SpoolEntry, file: string, dir: string): boolean {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
    const lines = existsSync(file) ? readSpoolLines(file) : [];
    if (lines.length >= AUDIT_SPOOL_MAX_ENTRIES) {
      state().overflowDropped += 1;
      pushRecent({
        event: entry.event,
        auditClass: entry.auditClass,
        target: "none",
        attempts: 0,
        error: `Spool voll (${lines.length} Zeilen) — ältester Eintrag verworfen`,
        path: "write",
      });
      alertBundle("critical", "audit-spool-overflow", "audit_spool_overflow", {
        lines: lines.length,
        limit: AUDIT_SPOOL_MAX_ENTRIES,
        newestEvent: entry.event,
        spoolFile: file,
      });
      writeSpoolLines(file, lines.slice(lines.length - (AUDIT_SPOOL_MAX_ENTRIES - 1)));
    }
    appendFileSync(file, `${serializeSpoolLine(entry)}\n`, { mode: 0o600 });
    return true;
  } catch (e) {
    state().lastSpoolError = sanitizeLogField(e);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Öffentliche API
// ─────────────────────────────────────────────────────────────────────────────

function normalizeRow(rec: AuditRecord): AuditRow {
  const event = sanitizeLogField(rec.event || "AUDIT_UNNAMED", AUDIT_EVENT_MAX) || "AUDIT_UNNAMED";
  return {
    event,
    level: rec.level === "CRITICAL" || rec.level === "WARN" ? rec.level : "INFO",
    detail: rec.detail ?? null,
    ...(rec.missionId ? { missionId: rec.missionId } : {}),
    ...(rec.agentId ? { agentId: rec.agentId } : {}),
  };
}

/**
 * Schreibt einen Audit-Eintrag gemäß seiner Klasse.
 *
 * Wirft nur, wenn `failClosed` gesetzt ist **und** weder DB noch Spool durable
 * waren. Alle anderen Pfade liefern ein auswertbares `outcome` zurück.
 */
export async function writeAuditRecord(rec: AuditRecord): Promise<AuditWriteOutcome> {
  const s = state();
  const cfg = auditSinkConfig();
  const row = normalizeRow(rec);
  const security = rec.auditClass === "security";
  const transport = transportOverride ?? defaultTransport;
  const at = new Date().toISOString();

  // Versuche: security retryt mit Backoff, telemetry nicht. Während des
  // Cooldowns (DB ist nachweislich gerade weg) entfällt der Retry-Sturm.
  const inCooldown = Date.now() < s.dbUnavailableUntil;
  const retries = security ? (rec.retries ?? cfg.retryMax) : 0;
  const maxAttempts = security && !inCooldown ? Math.max(1, retries + 1) : 1;

  let attempts = 0;
  let dbOk = false;
  let lastError: unknown = null;

  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await sleepFn(cfg.backoffMs * 2 ** (i - 1));
    attempts += 1;
    try {
      await transport(row);
      dbOk = true;
      break;
    } catch (e) {
      lastError = e;
    }
  }

  const errorMessage = dbOk ? null : sanitizeLogField(lastError ?? "unbekannter Fehler");

  if (dbOk) {
    s.dbUnavailableUntil = 0;
    // Es könnte etwas im Spool warten: gedrosselt und nicht blockierend nachziehen.
    void drainIfPending();
    return {
      event: row.event,
      auditClass: rec.auditClass,
      durable: true,
      target: "db",
      degraded: false,
      flagged: false,
      attempts,
      error: null,
      at,
    };
  }

  // ── DB-Pfad erschöpft: ab hier wird es nie stumm ───────────────────────────
  s.dbFailures += attempts;
  s.lastError = errorMessage;
  if (!inCooldown) s.dbUnavailableUntil = Date.now() + cfg.dbCooldownMs;
  telemetry.audit.writeFailures.inc({ auditClass: rec.auditClass, stage: "db" }, attempts);

  const spoolAllowed = security && rec.spool !== false;
  let spooled = false;
  if (spoolAllowed) {
    spoolSeq += 1;
    spooled = spoolAppend(
      {
        seq: spoolSeq,
        at,
        event: row.event,
        level: row.level,
        detail: row.detail,
        missionId: row.missionId,
        agentId: row.agentId,
        auditClass: rec.auditClass,
      },
      cfg.spoolFile,
      cfg.spoolDir
    );
    if (spooled) {
      s.spooled += 1;
      telemetry.audit.spooled.inc({ auditClass: rec.auditClass });
    }
  }

  if (spooled) {
    // Durable, aber noch nicht in `audit_log` — Alarm, damit niemand „erledigt“ liest.
    alertBundle("critical", "audit-degraded", "audit_write_degraded", {
      event: row.event,
      auditClass: rec.auditClass,
      attempts,
      target: "spool",
      spoolFile: cfg.spoolFile,
      reason: errorMessage,
      hint: "Nachzug nach audit_log erfolgt automatisch; pendingAuditCount() zeigt die offene Anzahl.",
    });
    pushRecent({
      event: row.event,
      auditClass: rec.auditClass,
      target: "spool",
      attempts,
      error: errorMessage,
      path: "write",
    });
    return {
      event: row.event,
      auditClass: rec.auditClass,
      durable: true,
      target: "spool",
      degraded: true,
      flagged: true,
      attempts,
      error: errorMessage,
      at,
    };
  }

  // Nichts durable: echter Verlust (security) bzw. verworfene Telemetrie.
  if (security) s.lost += 1;
  telemetry.audit.writeFailures.inc({ auditClass: rec.auditClass, stage: "lost" });
  telemetry.audit.missed.inc({ auditClass: rec.auditClass, kind: "dropped" });
  alertBundle(
    security ? "critical" : "warn",
    security ? "audit-lost" : "audit-telemetry-lost",
    security ? "audit_write_lost" : "audit_telemetry_dropped",
    {
      event: row.event,
      auditClass: rec.auditClass,
      attempts,
      reason: errorMessage,
      spoolError: s.lastSpoolError,
      ...(security ? { hint: "Sicherheits-Audit verloren — AUDIT_SPOOL_DIR prüfbar machen." } : {})
    }
  );
  pushRecent({
    event: row.event,
    auditClass: rec.auditClass,
    target: "none",
    attempts,
    error: errorMessage,
    path: "write",
  });

  if (security && rec.failClosed) {
    throw new AuditPersistenceError(row.event, errorMessage ?? "unbekannter Fehler");
  }

  return {
    event: row.event,
    auditClass: rec.auditClass,
    durable: false,
    target: "none",
    degraded: false,
    flagged: true,
    attempts,
    error: errorMessage,
    at,
  };
}

/**
 * Bequemer Einstieg für Aufrufer ohne Objektbau. Default-Klasse ist
 * `security`: ein zu lautes Audit ist billiger als eine stille Lücke.
 */
export async function auditWrite(
  event: string,
  level: AuditLevel,
  detail: unknown,
  opts: {
    auditClass?: AuditClass;
    missionId?: string;
    agentId?: string;
    failClosed?: boolean;
  } = {}
): Promise<AuditWriteOutcome> {
  return writeAuditRecord({
    event,
    level,
    detail,
    missionId: opts.missionId,
    agentId: opts.agentId,
    auditClass: opts.auditClass ?? "security",
    failClosed: opts.failClosed,
  });
}

/**
 * Meldepflicht für Aufrufer, die eine Mutation **trotz** fehlenden Audits
 * bewusst durchgehen lassen (dokumentierter Trade-off, z. B. Prompt-Update):
 * CRITICAL-Zeile + Missed-Audit-Zähler, damit die Lücke sichtbar ist.
 */
export function flagMissedAudit(event: string, meta: Record<string, unknown> = {}): void {
  const s = state();
  s.missedFlagged += 1;
  telemetry.audit.missed.inc({ auditClass: "security", kind: "flagged" });
  pushRecent({
    event,
    auditClass: "security",
    target: "none",
    attempts: 0,
    error: sanitizeLogField(meta.reason ?? "Audit nicht durable"),
    path: "missed",
  });
  structuredLog("critical", "audit_missed_security", { event, ...meta });
}

/** Anzahl bewusst gemeldeter, aber nicht geschriebener Sicherheits-Audits. */
export function missedAuditCount(): number {
  return state().missedFlagged;
}

export interface AuditDrainResult {
  scanned: number;
  written: number;
  failed: number;
  remaining: number;
  /** in die Quarantäne verschobene Zeilen (Giftzeilen/Unlesbares) */
  quarantined: number;
  ok: boolean;
  error: string | null;
}

/** Dateiname der Quarantäne (vom Spool blockierte, ablehnungsresistente Zeilen). */
export const AUDIT_QUARANTINE_FILE_NAME = "audit-quarantine.ndjson";
/** Versuche auf dieselbe Kopfzeile, bevor sie in die Quarantäne wandert. */
export const AUDIT_DRAIN_HEAD_MAX_FAILURES = 3;

/** Zeilen in die Quarantäne wegsichern — verliert nichts, blockiert nie. */
function quarantineLines(dir: string, lines: string[], reason: string | null): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
    const file = path.join(dir, AUDIT_QUARANTINE_FILE_NAME);
    const at = new Date().toISOString();
    appendFileSync(
      file,
      lines.map((line) => JSON.stringify({ quarantinedAt: at, reason, line })).join("\n") + "\n",
      { mode: 0o600 }
    );
  } catch (e) {
    state().lastSpoolError = sanitizeLogField(e);
  }
}

/** Anzahl der Quarantäne-Zeilen (Diagnose: hier stapeln sich unbelegbare Events). */
export function quarantinedAuditCount(): number {
  return countLines(path.join(auditSinkConfig().spoolDir, AUDIT_QUARANTINE_FILE_NAME));
}

/**
 * Zieht offene Spool-Einträge nach `audit_log` nach (at-least-once).
 * Bricht beim ersten Fehlschlag ab: Reihenfolge und Rest bleiben erhalten.
 */
export async function drainAuditSpool(
  opts: { transport?: AuditTransport } = {}
): Promise<AuditDrainResult> {
  const cfg = auditSinkConfig();
  const s = state();
  const transport = opts.transport ?? transportOverride ?? defaultTransport;
  const lines = readSpoolLines(cfg.spoolFile);
  const result: AuditDrainResult = {
    scanned: 0,
    written: 0,
    failed: 0,
    remaining: lines.length,
    quarantined: 0,
    ok: true,
    error: null,
  };
  if (lines.length === 0) return result;

  let i = 0;
  for (; i < lines.length; i++) {
    result.scanned += 1;
    let entry: SpoolEntry;
    try {
      entry = JSON.parse(lines[i]) as SpoolEntry;
      if (typeof entry?.event !== "string") throw new Error("Zeile ohne event-Feld");
    } catch {
      // Unlesbare Zeile: würde den Nachzug sonst für immer blockieren. Inhalt
      // in die Quarantäne legen (nichts verlieren) und weitermachen.
      result.failed += 1;
      quarantineLines(cfg.spoolDir, [lines[i]], "unlesbar");
      telemetry.audit.spoolDrained.inc({ result: "corrupt" });
      alertBundle("warn", "audit-spool-corrupt", "audit_spool_line_corrupt", {
        index: i,
        spoolFile: cfg.spoolFile,
      });
      continue;
    }
    try {
      await transport({
        event: entry.event,
        level: entry.level,
        detail: entry.detail,
        missionId: entry.missionId,
        agentId: entry.agentId,
      });
      result.written += 1;
      s.drained += 1;
      s.headFailures = 0;
      s.lastFailedHead = null;
      telemetry.audit.spoolDrained.inc({ result: "ok" });
    } catch (e) {
      result.error = sanitizeLogField(e);
      result.failed += 1;
      telemetry.audit.spoolDrained.inc({ result: "error" });
      // Giftzeile (Poison Pill): eine Zeile, die die DB *ablehnt* (z. B.
      // Fremdschlüssel-Verletzung), würde den gesamten Nachzug blockieren —
      // der Spool wüchse, neue Einträge erreichten audit_log nie. Nach
      // `AUDIT_DRAIN_HEAD_MAX_FAILURES` Versuchen auf dieselbe Zeile wandert
      // sie in die Quarantäne und der Nachzug läuft weiter.
      const sameAsLast = s.lastFailedHead === lines[i];
      s.lastFailedHead = lines[i];
      s.headFailures = sameAsLast ? s.headFailures + 1 : 1;
      if (s.headFailures >= AUDIT_DRAIN_HEAD_MAX_FAILURES) {
        s.headFailures = 0;
        s.lastFailedHead = null;
        result.quarantined += 1;
        quarantineLines(cfg.spoolDir, [lines[i]], result.error ?? "Einfügefehler");
        alertBundle("critical", "audit-drain-quarantine", "audit_spool_line_quarantined", {
          event: entry.event,
          attempts: AUDIT_DRAIN_HEAD_MAX_FAILURES,
          reason: result.error,
          hint: "Zeile liegt in audit-quarantine.ndjson und ist dort prüfbar — nichts ist verloren.",
        });
        continue;
      }
      // DB ist weg: Nachzug stoppen, Verbleibendes (ab i) erhalten.
      s.dbUnavailableUntil = Date.now() + cfg.dbCooldownMs;
      writeSpoolLines(cfg.spoolFile, lines.slice(i));
      result.remaining = lines.length - i;
      alertBundle("critical", "audit-drain-failed", "audit_spool_drain_failed", {
        remaining: result.remaining,
        written: result.written,
        reason: result.error,
      });
      result.ok = false;
      return result;
    }
  }

  writeSpoolLines(cfg.spoolFile, []);
  result.remaining = 0;
  if (result.written > 0 || result.quarantined > 0) {
    structuredLog("info", "audit_spool_drained", {
      written: result.written,
      quarantined: result.quarantined,
      failed: result.failed,
    });
  }
  return result;
}

let drainInFlight: Promise<AuditDrainResult> | null = null;

/**
 * Nachzug anstoßen, falls der Spool Einträge enthält — gedrosselt,
 * nicht blockierend, wirft nie (der Schreibpfad darf daran nicht hängen).
 */
export function drainIfPending(): Promise<AuditDrainResult> | null {
  const s = state();
  const cfg = auditSinkConfig();
  if (drainInFlight) return drainInFlight;
  if (Date.now() - s.lastDrainAt < DRAIN_MIN_INTERVAL_MS) return null;
  if (!existsSync(cfg.spoolFile)) return null;
  s.lastDrainAt = Date.now();
  drainInFlight = drainAuditSpool()
    .catch((e) => {
      alertBundle("warn", "audit-drain-error", "audit_spool_drain_error", {
        reason: sanitizeLogField(e),
      });
      return {
        scanned: 0,
        written: 0,
        failed: 1,
        remaining: 0,
        ok: false,
        error: sanitizeLogField(e),
      } as AuditDrainResult;
    })
    .finally(() => {
      drainInFlight = null;
    });
  return drainInFlight;
}

export interface AuditDurabilitySnapshot {
  /** fehlgeschlagene Schreibversuche gegen `audit_log` (inkl. Retries) */
  dbFailures: number;
  /** im Spool abgelegte Einträge */
  spooled: number;
  /** aus dem Spool nachgezogene Einträge */
  drained: number;
  /** security-Audits, die nirgends durable wurden */
  lost: number;
  /** vom Aufrufer gemeldete, bewusst hingenommene Lücken */
  missed: number;
  /** wegen Spool-Überlauf verworfene älteste Einträge */
  overflowDropped: number;
  /** aktuell offene Einträge im Spool */
  pending: number;
  /** Zeilen in der Quarantäne (von der DB abgelehnt/unlesbar) */
  quarantined: number;
  lastError: string | null;
  lastSpoolError: string | null;
  /** true, solange die DB als „gerade erst fehlgeschlagen“ gilt (Retries aus) */
  dbCoolingDown: boolean;
  spoolFile: string;
  /** letzte Degradationen, neueste zuerst */
  recent: AuditDegradationRecord[];
}

/** Snapshot für Operations Center, `/api/health` und Tests. */
export function auditDurabilitySnapshot(): AuditDurabilitySnapshot {
  const s = state();
  const cfg = auditSinkConfig();
  return {
    dbFailures: s.dbFailures,
    spooled: s.spooled,
    drained: s.drained,
    lost: s.lost,
    missed: s.missedFlagged,
    overflowDropped: s.overflowDropped,
    pending: countLines(cfg.spoolFile),
    quarantined: quarantinedAuditCount(),
    lastError: s.lastError,
    lastSpoolError: s.lastSpoolError,
    dbCoolingDown: Date.now() < s.dbUnavailableUntil,
    spoolFile: cfg.spoolFile,
    recent: [...s.recent].reverse(),
  };
}

/** Nur die offene Anzahl (günstig für Health-Felder). */
export function pendingAuditCount(): number {
  return countLines(auditSinkConfig().spoolFile);
}

/** Vorschau auf offene Spool-Einträge (Diagnose, neueste zuerst). */
export function readPendingAudits(limit = 20): Array<Partial<SpoolEntry> & { raw?: string }> {
  const lines = readSpoolLines(auditSinkConfig().spoolFile);
  return lines
    .slice(-limit)
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line) as Partial<SpoolEntry>;
      } catch {
        return { raw: sanitizeLogField(line, 200) };
      }
    });
}

/** Nur für Tests: Zähler, Ringe, Cooldowns und Transport zurücksetzen. */
export function resetAuditDurabilityForTests(): void {
  G.__auditDurability = freshState();
  spoolSeq = 0;
  transportOverride = null;
  sleepFn = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  telemetry.audit.reset();
}

/** Nur für Tests: Alarm-Bündelung und Degradations-Ring leeren, Zähler behalten. */
export function clearAuditDegradationsForTests(): void {
  const s = state();
  s.recent = [];
  s.alerts.clear();
}
