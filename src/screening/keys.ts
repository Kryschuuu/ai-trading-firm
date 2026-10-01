/**
 * STX-05-03 — deterministische Screening-Identitäten (ohne IO).
 *
 * Array-Reihenfolge bleibt erhalten: `cells` kommt aus der stabil sortierten
 * Matrix. Der gemeinsame PIT-Cutoff wird vor dem Hash in UTC normalisiert;
 * ein Date direkt in canonicalJson würde sonst als leeres Objekt erscheinen.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@/strategyLifecycle/evidence";

export interface ScreeningRunKeyInput {
  cells: readonly unknown[];
  asOf: Date | string | number;
  codeVersion: string;
  /** Vollständig aufgelöste Konfiguration, einschließlich Gewichten und Limits. */
  config: Readonly<Record<string, unknown>>;
}

export interface ScreeningCellKeyInput {
  runId: string;
  strategyVersionId: string;
  instrumentId: string;
  venue: string;
  timeframe: string;
}

/** Kanonische UUID-Schreibweise verhindert Dubletten durch Groß-/Kleinschreibung. */
export function normalizeScreeningUuid(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())) {
    throw new Error("screening: UUID erforderlich");
  }
  return value.trim().toLowerCase();
}

/** String-Cutoffs benötigen eine explizite Zeitzone (kein lokaler PIT-Cutoff). */
export function screeningAsOf(asOf: ScreeningRunKeyInput["asOf"]): Date {
  if (
    !(asOf instanceof Date) && typeof asOf !== "number" && typeof asOf !== "string"
    || typeof asOf === "string" && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(asOf)
  ) {
    throw new Error("screening: asOf benötigt einen gültigen Cutoff mit Zeitzone");
  }
  const date = new Date(asOf instanceof Date ? asOf.getTime() : asOf);
  if (!Number.isFinite(date.getTime())) throw new Error("screening: ungültiger asOf-Cutoff");
  return date;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** ssr1:sha256(canonicalJson({ cells, asOf, codeVersion, config })). */
export function screeningRunHash(input: ScreeningRunKeyInput): string {
  if (!Array.isArray(input.cells)) throw new Error("screening: cells muss ein Array sein");
  if (typeof input.codeVersion !== "string" || !input.codeVersion.trim()) {
    throw new Error("screening: codeVersion erforderlich");
  }
  if (!input.config || typeof input.config !== "object" || Array.isArray(input.config)) {
    throw new Error("screening: vollständiges config-Objekt erforderlich");
  }
  return `ssr1:${sha256({
    cells: input.cells,
    asOf: screeningAsOf(input.asOf).toISOString(),
    codeVersion: input.codeVersion,
    config: input.config,
  })}`;
}

/** ssm1:sha256(canonicalJson({ runId, strategyVersionId, instrumentId, venue, timeframe })). */
export function screeningCellKey(input: ScreeningCellKeyInput): string {
  for (const value of [input.instrumentId, input.venue, input.timeframe]) {
    if (typeof value !== "string" || !value.trim()) throw new Error("screening: Zellidentität unvollständig");
  }
  return `ssm1:${sha256({
    runId: normalizeScreeningUuid(input.runId),
    strategyVersionId: normalizeScreeningUuid(input.strategyVersionId),
    instrumentId: input.instrumentId,
    venue: input.venue,
    timeframe: input.timeframe,
  })}`;
}
