/**
 * Audit-Schnittstelle des Portfolio-Moduls (Task 05).
 *
 * **Jede** Verwerfungs- und Kappungsentscheidung der Risk Guard wird
 * strukturiert protokolliert (Architektur-Regel 2). Dieses Modul bleibt dabei
 * **rein**: Es definiert das Interface `AuditSink`, baut Ereignisse und bietet
 * zwei I/O-freie Senken (Memory, Null). Die Datei- und Datenbank-Senke liegt
 * bewusst in `auditFile.ts`, damit der Kern ohne `node:fs` importierbar bleibt
 * (erzwungen durch `tests/portfolio.architecture.test.ts`).
 *
 * Unabhängigkeitsklausel: Die zentrale `audit_log`-Tabelle des Projekts wird
 * nicht importiert. `fileAuditSink`/`dbAuditSink` sind die Integrationspunkte
 * (`// vgl. task-01/06`).
 */

import { PORTFOLIO_LIMITS, roundVector } from "./config";
import type { AuthorityStage, OptimizationMode } from "./types";

/** Ereignistypen des Portfolio-Audits. */
export type PortfolioAuditEventType =
  /** Eine Optimierung wurde berechnet (Optimizer-Stufe). */
  | "PORTFOLIO_OPTIMIZATION"
  /** Eine einzelne Entscheidung der Risk Guard (Kappung, Verwurf, Umverteilung). */
  | "RISK_GUARD_DECISION"
  /** Zusammenfassung eines Guard-Laufs (Kette, Zähler, Ergebnis). */
  | "RISK_GUARD_SUMMARY"
  /** Ein Analyse-Kontext wurde für das LLM erzeugt. */
  | "ANALYSIS_CONTEXT";

/** Schweregrad eines Audit-Ereignisses. */
export type PortfolioAuditLevel = "INFO" | "WARN" | "ERROR";

/** Ein strukturiertes Audit-Ereignis. Enthält nie Roh-Requests und nie Secrets. */
export interface PortfolioAuditEvent {
  /** Ereignistyp. */
  event: PortfolioAuditEventType;
  /** Schweregrad. */
  level: PortfolioAuditLevel;
  /** Immer `"system"` — dieses Modul hat keinen Benutzerkontext. */
  actor: "system";
  /** Herkunft, z. B. `"portfolio:optimize"`. */
  source: string;
  /** Stufe der Autoritätskette. */
  stage?: AuthorityStage;
  /** Maßnahme (`cap`, `drop`, `reject`, …). */
  action?: string;
  /** Maschinenlesbarer Grund. */
  code?: string;
  /** Optimierungs-Modus (falls zutreffend). */
  mode?: OptimizationMode;
  /** Betroffene Symbole (max. {@link PORTFOLIO_LIMITS.maxSymbolsPerAuditEvent}). */
  symbols: string[];
  /** Freigegebene bzw. betroffene Gewichte (gerundet). */
  weights?: number[];
  /** Wirksame Grenze. */
  limit?: number;
  /** Wert vor der Maßnahme. */
  before?: number;
  /** Wert nach der Maßnahme. */
  after?: number;
  /** Grundliste (Menschen/LLM). */
  reasons: string[];
  /** Solver-Konvergenz (Optimierungs-Ereignisse). */
  converged?: boolean;
  /** Verbrauchte Iterationen (Optimierungs-Ereignisse). */
  iterations?: number;
  /** ISO-8601-UTC-Zeitstempel — **injiziert**, nie intern erzeugt. */
  timestamp: string;
}

/**
 * Senke für Audit-Ereignisse.
 *
 * Implementierungen: {@link memoryAuditSink} (Tests), {@link nullAuditSink}
 * (Analyse ohne Protokollierung) sowie `fileAuditSink`/`dbAuditSink` aus
 * `auditFile.ts` (`// vgl. task-01/06`).
 */
export interface AuditSink {
  /** Name der Senke (Diagnose). */
  readonly name: string;
  /** Nimmt ein Ereignis entgegen. Darf niemals werfen (Audit bricht nichts ab). */
  write(event: PortfolioAuditEvent): void | Promise<void>;
}

/** In-Memory-Senke mit Zugriff auf alle Ereignisse (Tests, API-Antwort). */
export interface MemoryAuditSink extends AuditSink {
  /** Gesammelte Ereignisse in Reihenfolge. */
  readonly events: PortfolioAuditEvent[];
  /** Leert die Sammlung. */
  clear(): void;
}

/** Senke, die Ereignisse für Tests und Antworten sammelt. */
export function memoryAuditSink(): MemoryAuditSink {
  const events: PortfolioAuditEvent[] = [];
  return {
    name: "memory",
    events,
    write(event) {
      events.push(event);
    },
    clear() {
      events.length = 0;
    },
  };
}

/** Senke, die nichts tut (read-only Analysen ohne Protokollierungsbedarf). */
export function nullAuditSink(): AuditSink {
  return { name: "null", write() {} };
}

/** Schreibt in mehrere Senken (z. B. Memory + Datei). */
export function compositeAuditSink(sinks: readonly AuditSink[]): AuditSink {
  return {
    name: sinks.map((s) => s.name).join("+") || "null",
    write(event) {
      for (const sink of sinks) void sink.write(event);
    },
  };
}

/** Parameter des Audit-Loggers. */
export interface AuditLoggerOptions {
  /** Zielsenke (Default {@link nullAuditSink}). */
  sink?: AuditSink;
  /** Uhr — **Pflicht zur Injektion**, damit der Kern deterministisch bleibt. */
  now?: () => Date;
  /** Herkunftskennung (Default `"portfolio"`). */
  source?: string;
}

/** Audit-Logger: baut Ereignisse und reicht sie an die Senke weiter. */
export interface AuditLogger {
  /** Erzeugt ein Ereignis (ohne es zu schreiben). */
  build(input: Omit<PortfolioAuditEvent, "actor" | "timestamp" | "source" | "symbols" | "reasons"> & {
    symbols?: readonly string[];
    reasons?: readonly string[];
  }): PortfolioAuditEvent;
  /** Erzeugt ein Ereignis und schreibt es in die Senke. */
  log(input: Omit<PortfolioAuditEvent, "actor" | "timestamp" | "source" | "symbols" | "reasons"> & {
    symbols?: readonly string[];
    reasons?: readonly string[];
  }): PortfolioAuditEvent;
  /** Verwendete Senke. */
  readonly sink: AuditSink;
}

/** Fester Fallback-Zeitstempel, wenn keine Uhr injiziert wurde (Determinismus). */
export const EPOCH_TIMESTAMP = "1970-01-01T00:00:00.000Z";

/** Begrenzt Symbol- und Grundlisten (keine Datenflut im Audit-Log). */
export function clampList<T>(values: readonly T[], max = PORTFOLIO_LIMITS.maxSymbolsPerAuditEvent): T[] {
  return values.slice(0, max);
}

/**
 * Erzeugt einen Audit-Logger.
 *
 * Der Zeitstempel kommt aus der injizierten Uhr (`now`); fehlt sie, wird der
 * Unix-Epoch-Wert `0` geschrieben — der Kern erzeugt niemals selbst eine Uhr
 * (Architektur-Regel 1: Determinismus).
 */
export function createAuditLogger(options: AuditLoggerOptions = {}): AuditLogger {
  const sink = options.sink ?? nullAuditSink();
  const source = options.source ?? "portfolio";
  const now = options.now;
  const build: AuditLogger["build"] = (input) => ({
    event: input.event,
    level: input.level,
    actor: "system",
    source,
    stage: input.stage,
    action: input.action,
    code: input.code,
    mode: input.mode,
    symbols: clampList(input.symbols ?? []),
    weights: input.weights ? roundVector(input.weights) : undefined,
    limit: input.limit,
    before: input.before,
    after: input.after,
    reasons: clampList(input.reasons ?? [], 20),
    converged: input.converged,
    iterations: input.iterations,
    timestamp: now ? now().toISOString() : EPOCH_TIMESTAMP,
  });
  return {
    sink,
    build,
    log(input) {
      const event = build(input);
      void sink.write(event);
      return event;
    },
  };
}
