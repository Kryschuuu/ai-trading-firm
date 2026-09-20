/**
 * Deterministische Fingerprints des Forecast-Ledgers (RMA-P3-01, v1.55.0).
 *
 * Drei Schlüsselarten (Präfix = Version des Formats):
 *   `fk1:<sha256>`  Idempotenzschlüssel eines Forecast-Vertrags
 *   `fo1:<sha256>`  Outcome-Fingerprint einer Resolution (Idempotenz +
 *                   Revisionserkennung: identisches Outcome ⇒ no-op,
 *                   abweichendes Outcome ⇒ neue Version)
 *   `frk1:<sha256>` Idempotenzschlüssel eines Resolver-Laufs
 *
 * Alle Hashes laufen über die kanonische Serialisierung
 * (`stableStringify`: sortierte Keys, keine Zyklen) — dieselben Eingaben
 * liefern damit prozess- und zeitunabhängig denselben Schlüssel.
 */

import { createHash } from "node:crypto";

import { stableStringify } from "../lib/ruleEngine";
import { forecastKeyPayload, type ForecastContract, type ForecastVoidReason } from "./types";

function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Idempotenzschlüssel `fk1:<sha256>` eines Forecast-Vertrags. */
export function forecastIdempotencyKey(contract: ForecastContract): string {
  return `fk1:${sha256Hex(stableStringify(forecastKeyPayload(contract)))}`;
}

/**
 * Outcome-Fingerprint `fo1:<sha256>` einer Resolution.
 *
 * Enthält ausschließlich den INHALT der Auflösung (kein `resolved_at`):
 * ein Retry derselben Auflösung mit späterem Zeitstempel ist damit immer
 * noch dasselbe Outcome und wird nicht doppelt geschrieben.
 */
export function resolutionOutcomeHash(input: {
  forecastId: string;
  status: "RESOLVED" | "VOID";
  outcomeIndex: number | null;
  voidReason: ForecastVoidReason | null;
  referenceClose: number | null;
  outcomeClose: number | null;
  datasetHash: string | null;
  policyVersion: string;
}): string {
  return `fo1:${sha256Hex(
    stableStringify({
      forecastId: input.forecastId,
      status: input.status,
      outcomeIndex: input.outcomeIndex,
      voidReason: input.voidReason,
      referenceClose: input.referenceClose === null ? null : Number(input.referenceClose.toFixed(9)),
      outcomeClose: input.outcomeClose === null ? null : Number(input.outcomeClose.toFixed(9)),
      datasetHash: input.datasetHash,
      policyVersion: input.policyVersion,
    })
  )}`;
}

/** `ds1:<sha256>` — Dataset-Fingerprint der für eine Auflösung verwendeten Kerzen. */
export function outcomeDatasetHash(
  bars: readonly { closeTimeMs: number; close: number; volume: number; fetchedAtMs: number }[]
): string {
  return `ds1:${sha256Hex(
    stableStringify(
      bars.map((bar) => [bar.closeTimeMs, Number(bar.close.toFixed(9)), Number(bar.volume.toFixed(9)), bar.fetchedAtMs])
    )
  )}`;
}

/** Lauf-Manifest-Schlüssel `frk1:<sha256>`. */
export function resolutionRunKey(input: {
  mode: "AUTOMATIC" | "OPERATOR";
  policyVersion: string;
  codeVersion: string;
  nowMs: number;
  limit: number;
}): string {
  return `frk1:${sha256Hex(stableStringify(input))}`;
}
