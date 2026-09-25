/**
 * Provider-Schalter — LLM-Provider per UI ein-/ausschalten (Task 09-Erweiterung).
 *
 * ── Problem ─────────────────────────────────────────────────────────────────
 * Welcher Provider genutzt werden darf, stand bisher ausschließlich in der
 * `.env` (`LLM_PROVIDER`, `LLM_FALLBACK_PROVIDERS`, API-Keys). Ein Cloud-Provider
 * wie die OpenCode-Zen-Free-Modelle ließ sich damit nur mit Prozess-Neustart
 * an- oder abschalten — für einen Schalter, den man situativ umlegen will
 * („heute kostenlos ausprobieren, morgen wieder aus"), zu schwer.
 *
 * ── Lösung ──────────────────────────────────────────────────────────────────
 * Je Provider ein persistenter Runtime-Schalter `provider.<id>.enabled`
 * (`src/lib/runtimeFlags.ts`, Datei `data/runtime/flags.json`). Auflösung:
 *
 *   1. Runtime-Flag (UI, explizit gesetzt)   → gewinnt
 *   2. `ROUTING_DISABLED_PROVIDERS` (Env)    → kommagetrennte Sperrliste
 *   3. Code-Default                          → an
 *
 * Ein **gesperrter** Provider ist für den Router nicht wählbar: die Registry
 * projiziert ihn als `offline` (mit Begründung), der Health-Poller fragt ihn
 * nicht ab und `resolveProviderChain()` überspringt ihn. Es entsteht also
 * **kein** Netzwerkverkehr zu einem abgeschalteten Provider — dieselbe
 * Sicherheits-Regel wie beim Broker-Remote-Check.
 *
 * ── Free-Modelle (OpenCode Zen) ─────────────────────────────────────────────
 * `opencode` ist der Cloud-Provider für OpenCode Zen. Dessen Free-Modelle
 * kosten 0 USD; die Karte wird deshalb mit `costPer1kIn/Out = 0` und einem
 * eigenen Token-Deckel geführt (Regel 3: Cloud bleibt immer gedeckelt).
 */
import {
  runtimeFlagValue,
  setRuntimeFlag,
  clearRuntimeFlag,
  resolveRuntimeFlag,
  runtimeFlagView,
  type RuntimeFlagSpec,
  type RuntimeFlagView,
} from "@/lib/runtimeFlags";
import { PROVIDER_IDS, type ProviderId } from "./types";

/** Schlüssel-Präfix aller Provider-Schalter. */
export const PROVIDER_TOGGLE_PREFIX = "provider.";

/** Schlüssel eines Provider-Schalters, z. B. `provider.opencode.enabled`. */
export function providerToggleKey(id: ProviderId | string): string {
  return `${PROVIDER_TOGGLE_PREFIX}${String(id).toLowerCase()}.enabled`;
}

/**
 * Env-Sperrliste: `ROUTING_DISABLED_PROVIDERS=gemini,anthropic` schaltet die
 * genannten Provider ab (ohne Runtime-Flag). Unbekannte Einträge werden
 * ignoriert — kein Tippfehler öffnet oder schließt still etwas anderes.
 */
export const DISABLED_PROVIDERS_ENV = "ROUTING_DISABLED_PROVIDERS";

/** Provider-IDs aus der Env-Sperrliste (unbekannte Werte verworfen). */
export function disabledProvidersFromEnv(
  env: Record<string, string | undefined> = process.env
): ProviderId[] {
  const raw = env[DISABLED_PROVIDERS_ENV] ?? "";
  const out: ProviderId[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (!id) continue;
    if ((PROVIDER_IDS as readonly string[]).includes(id) && !out.includes(id as ProviderId)) {
      out.push(id as ProviderId);
    }
  }
  return out;
}

/** Spec eines Provider-Schalters (Label/Beschreibung für API + UI). */
export function providerToggleSpec(id: ProviderId): RuntimeFlagSpec {
  const cloud = id === "opencode" || id === "gemini" || id === "anthropic";
  return {
    key: providerToggleKey(id),
    label: `Provider ${id} ${cloud ? "(Cloud)" : "(lokal)"}`,
    description: cloud
      ? "Cloud-Provider im MODEL_ROUTER. Aus = keine Anfragen, keine Kosten, kein Datenabfluss an diesen Anbieter."
      : "Lokaler Provider im MODEL_ROUTER. Aus = der Router überspringt ihn vollständig.",
    // Default: an. Eine Sperre ist eine explizite Entscheidung (UI-Flag oder
    // ROUTING_DISABLED_PROVIDERS) — kein Provider verschwindet von selbst.
    defaultValue: true,
  };
}

/** Alle Provider-Specs in kanonischer Reihenfolge. */
export function providerToggleSpecs(): RuntimeFlagSpec[] {
  return PROVIDER_IDS.map((id) => providerToggleSpec(id));
}

/** Ist der Provider aktuell freigegeben? (`false` ⇒ kein Netzwerkverkehr.) */
export function isProviderEnabled(
  id: ProviderId | string,
  env: Record<string, string | undefined> = process.env
): boolean {
  const provider = String(id).toLowerCase() as ProviderId;
  if (!(PROVIDER_IDS as readonly string[]).includes(provider)) return true;
  const runtime = runtimeFlagValue(providerToggleKey(provider), env);
  if (runtime !== null) return runtime;
  return !disabledProvidersFromEnv(env).includes(provider);
}

/** Nur die freigegebenen Provider (Reihenfolge der Eingabe bleibt erhalten). */
export function filterEnabledProviders<T extends string>(
  ids: readonly T[],
  env: Record<string, string | undefined> = process.env
): T[] {
  return ids.filter((id) => isProviderEnabled(id, env));
}

/** Sicht auf einen Provider-Schalter (UI). */
export function providerToggleView(
  id: ProviderId,
  env: Record<string, string | undefined> = process.env
): RuntimeFlagView {
  const view = runtimeFlagView(providerToggleSpec(id), env);
  return { ...view, effective: isProviderEnabled(id, env), value: isProviderEnabled(id, env) };
}

/** Sicht auf alle Provider-Schalter. */
export function providerToggleViews(
  env: Record<string, string | undefined> = process.env
): RuntimeFlagView[] {
  return PROVIDER_IDS.map((id) => providerToggleView(id, env));
}

/**
 * Setzt einen Provider-Schalter. `enabled === null` löscht das Runtime-Flag —
 * dann gilt wieder der Env-Default (`ROUTING_DISABLED_PROVIDERS`).
 */
export function setProviderEnabled(
  id: ProviderId | string,
  enabled: boolean | null,
  opts: { env?: Record<string, string | undefined>; by?: string | null; now?: Date } = {}
): { ok: true; id: ProviderId; enabled: boolean } | { ok: false; error: string } {
  const provider = String(id).toLowerCase() as ProviderId;
  if (!(PROVIDER_IDS as readonly string[]).includes(provider)) {
    return { ok: false, error: "UNKNOWN_PROVIDER" };
  }
  const env = opts.env ?? process.env;
  if (enabled === null) {
    const cleared = clearRuntimeFlag(providerToggleKey(provider), env);
    if (!cleared.ok) return { ok: false, error: cleared.error ?? "FLAGS_WRITE_FAILED" };
    return { ok: true, id: provider, enabled: isProviderEnabled(provider, env) };
  }
  const result = setRuntimeFlag(providerToggleSpec(provider), enabled, {
    env,
    by: opts.by ?? null,
    now: opts.now,
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, id: provider, enabled: isProviderEnabled(provider, env) };
}

/** Begründungstext für gesperrte Provider (Registry/Health/Audit). */
export const PROVIDER_DISABLED_REASON =
  "Provider ist über die Provider-Schalter (UI/Flags) deaktiviert — keine Anfragen, kein Health-Check.";

export { resolveRuntimeFlag };
