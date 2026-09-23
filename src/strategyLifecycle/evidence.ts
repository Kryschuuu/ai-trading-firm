/**
 * Evidence-Modell der Strategy-Lifecycle (RMA-P1-05) — rein.
 *
 * Persistente Evidence ist IMMER immutable, referenziert über FK/Hash und
 * trennt `eventTime` (Beobachtung), `availableAt` (Prozessverfügbarkeit) und
 * `computedAt` (Bewertung). Dieses Modul baut Evidence-Referenzen, Inhalts-
 * Hashes und Idempotency-Keys — kein freies JSON ohne Hash.
 */
import { createHash } from "node:crypto";
import type { LifecycleEvidenceKind } from "./states";

export interface EvidenceMetricSnapshot {
  /** Geschlossene Metrik-Map — Werte number|null (nie still 0 für unbekannt). */
  readonly metrics: Readonly<Record<string, number | null>>;
  readonly sampleSize: number | null;
  readonly windowStartMs: number | null;
  readonly windowEndMs: number | null;
}

export interface EvidenceProvenance {
  readonly strategyKey: string;
  readonly strategyVersion: number;
  /** Code-Version des Bewertungslaufs (APP_VERSION). */
  readonly codeVersion: string;
  /** Policy-Version der verwendeten Promotion-/Drift-Policy. */
  readonly policyVersion: string;
  /** Optionale Prompt-/Daten-/Regel-Referenzen (Hashes, keine Rohtexte). */
  readonly promptVersion?: string | null;
  readonly dataVersion?: string | null;
  readonly ruleKey?: string | null;
  /** FK auf backtest_runs, wenn die Evidenz einen WF-Run belegt. */
  readonly backtestRunId?: string | null;
}

export interface EvidenceInput extends EvidenceProvenance {
  readonly kind: LifecycleEvidenceKind;
  readonly result: "PASS" | "FAIL" | "INCONCLUSIVE";
  readonly snapshot: EvidenceMetricSnapshot;
  readonly eventTimeMs: number;
  readonly availableAtMs: number;
  readonly computedAtMs: number;
  /** Zusätzliche, kanonisch serialisierte Kontextfelder (bounded). */
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface EvidenceRef {
  readonly id: string;
  readonly contentHash: string;
  readonly idempotencyKey: string;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Kanonische Serialisierung: sortierte Keys, stabile Zahlendarstellung. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return "null";
}

/**
 * Inhalts-Hash über die fachliche Evidence (ohne Laufzeit-IDs):
 * Identischer Inhalt ⇒ identischer Hash ⇒ idempotenter Retry.
 */
export function evidenceContentHash(input: EvidenceInput): string {
  const body = {
    strategyKey: input.strategyKey,
    strategyVersion: input.strategyVersion,
    kind: input.kind,
    result: input.result,
    codeVersion: input.codeVersion,
    policyVersion: input.policyVersion,
    promptVersion: input.promptVersion ?? null,
    dataVersion: input.dataVersion ?? null,
    ruleKey: input.ruleKey ?? null,
    backtestRunId: input.backtestRunId ?? null,
    metrics: input.snapshot.metrics,
    sampleSize: input.snapshot.sampleSize,
    windowStartMs: input.snapshot.windowStartMs,
    windowEndMs: input.snapshot.windowEndMs,
    eventTimeMs: input.eventTimeMs,
    availableAtMs: input.availableAtMs,
    detail: input.detail ?? {},
  };
  return `sle1:${sha256(canonicalJson(body))}`;
}

/**
 * Stabiler Idempotency-Key der Evidence-Zeile:
 * `slei1:<sha256>` über Content-Hash + Kind — Retries/Restarts schreiben
 * keine zweite Zeile.
 */
export function evidenceIdempotencyKey(contentHash: string): string {
  return `slei1:${sha256(contentHash)}`;
}

/** Transition-Key `slt1:<sha256>` — dedupliziert parallele/redundante Transitions. */
export function transitionKey(input: {
  strategyKey: string;
  strategyVersion: number;
  from: string;
  to: string;
  /** Zusammenfassung von Reason+Evidenz-Hash (unterschiedliche Gründe ⇒ unterschiedliche Keys). */
  nonce: string;
}): string {
  return `slt1:${sha256(
    canonicalJson({
      strategyKey: input.strategyKey,
      strategyVersion: input.strategyVersion,
      from: input.from,
      to: input.to,
      nonce: input.nonce,
    })
  )}`;
}

/** Validiert/normalisiert einen Strategie-Schlüssel (kein Freitext-Sprung). */
export function normalizeStrategyKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (v.length < 1 || v.length > 128) return null;
  if (!/^[A-Za-z0-9._:@/-]+$/.test(v)) return null;
  return v;
}

export function normalizeStrategyVersion(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) return null;
  return n;
}
