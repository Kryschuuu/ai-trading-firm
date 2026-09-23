/**
 * Versionierte TWAP-Policy (RMA-P4-03).
 *
 * Die Policy beschreibt das Eltern-Intent: Slice-Intervall, Participation,
 * Mindest-/Höchstslice, Preis-/Impact-Grenzen und den Umgang mit fehlender
 * Tiefe. Sie erzeugt keine Orders. Kinder laufen über den Execution-Policy-
 * Controller (P4.2) mit einer abgeleiteten Policy, die Market-Fallback und
 * Repricing hart ausschaltet — ein TWAP jagt den Preis nicht außerhalb des
 * Eltern-Limits.
 *
 * Einheiten:
 *   - Mengen in Basiseinheiten
 *   - `minNotional` in Quote-Währung
 *   - `maxParticipation` als Anteil (0.1 = 10 % des beobachteten Intervallvolumens)
 *   - `maxImpactBps` / `priceOffsetBps` / `maxSpreadBps` in Basispunkten
 *   - Zeiten in Millisekunden (Ereigniszeit, nicht „irgendwann“)
 *
 * Sub-Sekunden-Scheduling ist absichtlich unmöglich (`sliceIntervalMs >= 1000`).
 */
import { createHash } from "node:crypto";
import { parseExecutionPolicy, type ExecutionPolicy } from "../policy";
import { TwapError } from "./errors";

export const TWAP_POLICY_PREFIX = "etw1";

export type StaleDepthAction = "pause" | "conservative";

export interface TwapPolicyInput {
  /** Abstand der Slice-Starts. Hart ≥ 1000 ms (kein Sub-Sekunden-Scheduler). */
  sliceIntervalMs: number;
  /** Anteil des beobachteten Intervallvolumens, den ein Slice höchstens nimmt. (0, 1]. */
  maxParticipation: number;
  /** Mindestslice in Basiseinheiten. Venue-Minimum wird zusätzlich erzwungen. */
  minSliceQty: number;
  /** Höchstslice in Basiseinheiten. */
  maxSliceQty: number;
  /** Mindest-Notional in Quote. 0 = keine zusätzliche Notional-Grenze. */
  minNotional: number;
  /** Maximaler geschätzter Take-Impact in bp (Walk des sichtbaren Buchs). */
  maxImpactBps: number;
  /** Maker-Offset in bp (LONG unter Bid, SHORT über Ask). */
  priceOffsetBps: number;
  /** Maximales Alter von Buch und Volumen (available_at → now). */
  maxBookAgeMs: number;
  /** Fehlende/stale Tiefe: pausieren oder expliziter konservativer Fallback. */
  staleDepthAction: StaleDepthAction;
  /** Pflicht bei `conservative`. Sonst null. Niemals als „unbegrenzte Tiefe“ gelesen. */
  conservativeSliceQty: number | null;
  /** Mengen-Jitter als Anteil der Slice-Menge, 0..0.25. Nur aus persistiertem Seed. */
  jitterFraction: number;
  /** Zeit-Jitter in ms, 0..sliceInterval/2. Nur aus persistiertem Seed. */
  jitterMs: number;
  /** TTL des Kinder-Limits (P4.2). Kein Market danach. */
  childTtlMs: number;
  /** Kinder sind standardmäßig post-only. */
  childPostOnly: boolean;
  /** Wenn die Venue kein Post-Only kann: `fail` (Default) oder explizites `limit`. */
  childPostOnlyFallback: "fail" | "limit";
  /** Spread-Gate der Kinder (bp). */
  maxSpreadBps: number;
}

export interface TwapPolicy extends TwapPolicyInput {
  policyVersion: string;
}

export const DEFAULT_TWAP_POLICY: TwapPolicyInput = {
  sliceIntervalMs: 60_000,
  maxParticipation: 0.1,
  minSliceQty: 0.0001,
  maxSliceQty: 1_000_000,
  minNotional: 0,
  maxImpactBps: 25,
  priceOffsetBps: 0,
  maxBookAgeMs: 5_000,
  staleDepthAction: "pause",
  conservativeSliceQty: null,
  jitterFraction: 0,
  jitterMs: 0,
  childTtlMs: 60_000,
  childPostOnly: true,
  childPostOnlyFallback: "fail",
  maxSpreadBps: 50,
};

const FIELDS: (keyof TwapPolicyInput)[] = [
  "sliceIntervalMs",
  "maxParticipation",
  "minSliceQty",
  "maxSliceQty",
  "minNotional",
  "maxImpactBps",
  "priceOffsetBps",
  "maxBookAgeMs",
  "staleDepthAction",
  "conservativeSliceQty",
  "jitterFraction",
  "jitterMs",
  "childTtlMs",
  "childPostOnly",
  "childPostOnlyFallback",
  "maxSpreadBps",
];

function num(value: unknown, field: string, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TwapError("INVALID_POLICY", `${field} muss eine endliche Zahl sein`, field);
  }
  if (integer && !Number.isInteger(value)) {
    throw new TwapError("INVALID_POLICY", `${field} muss ganzzahlig sein`, field);
  }
  if (value < min || value > max) {
    throw new TwapError("INVALID_POLICY", `${field} muss in [${min}, ${max}] liegen`, field);
  }
  return value;
}

/**
 * Validiert und versioniert eine TWAP-Policy. Unbekannte Felder werden
 * verworfen (kein stilles Flag-Dropping: sie stehen nicht in der Version).
 * Fehlende Felder fallen auf `DEFAULT_TWAP_POLICY` zurück, außer der Aufrufer
 * übergibt `strict` (API: nur explizite Felder, Rest Default — das ist der
 * normale Pfad; ein explizites `null` für eine Zahl ist ein Fehler).
 */
export function parseTwapPolicy(raw: unknown): TwapPolicy {
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
    throw new TwapError("INVALID_POLICY", "policy muss ein Objekt sein", "policy");
  }
  const src = (raw ?? {}) as Record<string, unknown>;
  const base: TwapPolicyInput = { ...DEFAULT_TWAP_POLICY };
  for (const key of FIELDS) {
    if (src[key] === undefined) continue;
    (base as unknown as Record<string, unknown>)[key] = src[key];
  }
  const sliceIntervalMs = num(base.sliceIntervalMs, "sliceIntervalMs", 1_000, 86_400_000, true);
  const maxParticipation = num(base.maxParticipation, "maxParticipation", 0, 1);
  if (maxParticipation <= 0) {
    throw new TwapError("INVALID_POLICY", "maxParticipation muss > 0 sein", "maxParticipation");
  }
  const minSliceQty = num(base.minSliceQty, "minSliceQty", 0, 1_000_000_000);
  if (minSliceQty <= 0) throw new TwapError("INVALID_POLICY", "minSliceQty muss > 0 sein", "minSliceQty");
  const maxSliceQty = num(base.maxSliceQty, "maxSliceQty", minSliceQty, 1_000_000_000);
  const minNotional = num(base.minNotional, "minNotional", 0, 1_000_000_000_000);
  const maxImpactBps = num(base.maxImpactBps, "maxImpactBps", 0, 5_000);
  const priceOffsetBps = num(base.priceOffsetBps, "priceOffsetBps", 0, 500);
  const maxBookAgeMs = num(base.maxBookAgeMs, "maxBookAgeMs", 100, 60_000, true);
  if (base.staleDepthAction !== "pause" && base.staleDepthAction !== "conservative") {
    throw new TwapError("INVALID_POLICY", "staleDepthAction muss pause oder conservative sein", "staleDepthAction");
  }
  let conservativeSliceQty: number | null = null;
  if (base.conservativeSliceQty !== null && base.conservativeSliceQty !== undefined) {
    conservativeSliceQty = num(base.conservativeSliceQty, "conservativeSliceQty", minSliceQty, maxSliceQty);
  }
  if (base.staleDepthAction === "conservative" && conservativeSliceQty === null) {
    throw new TwapError(
      "INVALID_POLICY",
      "conservative verlangt conservativeSliceQty (expliziter Fallback, kein stilles 0)",
      "conservativeSliceQty",
    );
  }
  const jitterFraction = num(base.jitterFraction, "jitterFraction", 0, 0.25);
  const jitterMs = num(base.jitterMs, "jitterMs", 0, Math.floor(sliceIntervalMs / 2), true);
  const childTtlMs = num(base.childTtlMs, "childTtlMs", 1_000, 3_600_000, true);
  if (typeof base.childPostOnly !== "boolean") {
    throw new TwapError("INVALID_POLICY", "childPostOnly muss boolean sein", "childPostOnly");
  }
  if (base.childPostOnlyFallback !== "fail" && base.childPostOnlyFallback !== "limit") {
    throw new TwapError("INVALID_POLICY", "childPostOnlyFallback muss fail oder limit sein", "childPostOnlyFallback");
  }
  const maxSpreadBps = num(base.maxSpreadBps, "maxSpreadBps", 0, 5_000);
  const input: TwapPolicyInput = {
    sliceIntervalMs,
    maxParticipation,
    minSliceQty,
    maxSliceQty,
    minNotional,
    maxImpactBps,
    priceOffsetBps,
    maxBookAgeMs,
    staleDepthAction: base.staleDepthAction,
    conservativeSliceQty,
    jitterFraction,
    jitterMs,
    childTtlMs,
    childPostOnly: base.childPostOnly,
    childPostOnlyFallback: base.childPostOnlyFallback,
    maxSpreadBps,
  };
  return { ...input, policyVersion: twapPolicyVersion(input) };
}

/** Kanonische Version. Policyänderung ⇒ neue Version, nie ein stilles Update. */
export function twapPolicyVersion(input: TwapPolicyInput): string {
  const canonical = FIELDS.map((k) => [k, input[k]]);
  const hex = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return `${TWAP_POLICY_PREFIX}:${hex}`;
}

/**
 * Kinder-Policy für P4.2. Market-Fallback und Repricing sind hart aus:
 * die Restmenge kehrt in den TWAP-Pool zurück, statt den Preis zu jagen.
 */
export function childExecutionPolicy(policy: TwapPolicy): ExecutionPolicy {
  return parseExecutionPolicy({
    postOnly: policy.childPostOnly,
    postOnlyFallback: policy.childPostOnlyFallback,
    ttlMs: policy.childTtlMs,
    maxReprices: 0,
    priceOffsetBps: policy.priceOffsetBps,
    fallbackAllowed: false,
    maxSpreadBps: policy.maxSpreadBps,
    // P4.2 erlaubt 0 nicht (Untergrenze 1). Der Chase-Schutz ist
    // fallbackAllowed=false + maxReprices=0 + das Eltern-Limit, nicht dieser Wert.
    maxSlippageBps: 1,
    maxNotional: 0,
    maxQuoteAgeMs: Math.min(60_000, Math.max(100, policy.maxBookAgeMs)),
    cancelConfirmTimeoutMs: Math.min(30_000, Math.max(100, Math.floor(policy.childTtlMs / 2))),
    maxCancelAttempts: 3,
  });
}
