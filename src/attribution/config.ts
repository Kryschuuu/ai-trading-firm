/**
 * Trade-Attribution-Konfiguration (RMA-P1-06, v1.57.0).
 *
 * Muster `src/lib/journalConfig.ts`: Allowlist statt freier Strings,
 * unbekannte Werte fallen LAUT auf den sicheren Default (fail-closed).
 *
 *   TRADE_ATTRIBUTION_ENABLED       true (Default) — beim Close eines Trades
 *                                   wird automatisch die Attribution berechnet
 *                                   und append-only persistiert. Additiv: kein
 *                                   Einfluss auf Order-, Risiko- oder
 *                                   Entscheidungs-pfade; Fehler blockieren den
 *                                   Close nie (nur sichtbares Audit).
 *   TRADE_ATTRIBUTION_METHOD_VERSION  1 (Default, Allowlist [1]) — Methode ta1.
 *                                   Ein Wechsel legt NEUE Zeilen an
 *                                   (Idempotenz-Schlüssel journal_id +
 *                                   method_version); historische Ergebnisse
 *                                   bleiben unverändert erhalten.
 */

/** Env-Namen (zentral, für Doku/Tests/docs:validate). */
export const ATTRIBUTION_ENV = {
  ENABLED: "TRADE_ATTRIBUTION_ENABLED",
  METHOD_VERSION: "TRADE_ATTRIBUTION_METHOD_VERSION",
} as const;

/** Implementierte Methodenversionen (Allowlist). */
export const ATTRIBUTION_METHOD_VERSIONS = [1] as const;
export type AttributionMethodVersion = (typeof ATTRIBUTION_METHOD_VERSIONS)[number];

export interface AttributionConfig {
  enabled: boolean;
  methodVersion: AttributionMethodVersion;
}

function parseEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") return true;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  console.warn(
    `[attribution] ${ATTRIBUTION_ENV.ENABLED}="${raw.trim().slice(0, 40)}" ist kein Boolean → sicherer Default true`
  );
  return true;
}

function parseMethodVersion(raw: string | undefined): AttributionMethodVersion {
  if (raw === undefined || raw.trim() === "") return 1;
  const n = Number(raw);
  const allowed = (ATTRIBUTION_METHOD_VERSIONS as readonly number[]).includes(n)
    ? (n as AttributionMethodVersion)
    : null;
  if (allowed === null) {
    console.warn(
      `[attribution] ${ATTRIBUTION_ENV.METHOD_VERSION}="${raw.trim().slice(0, 40)}" ist nicht implementiert (erlaubt: ${ATTRIBUTION_METHOD_VERSIONS.join(", ")}) → sicherer Default 1`
    );
    return 1;
  }
  return allowed;
}

/**
 * Liest die Konfiguration (bei jedem Aufruf frisch — bewusst stateless, damit
 * Tests und Betriebsänderungen ohne Prozessneustart greifen).
 */
export function loadAttributionConfig(
  env: Record<string, string | undefined> = process.env
): AttributionConfig {
  return {
    enabled: parseEnabled(env[ATTRIBUTION_ENV.ENABLED]),
    methodVersion: parseMethodVersion(env[ATTRIBUTION_ENV.METHOD_VERSION]),
  };
}
