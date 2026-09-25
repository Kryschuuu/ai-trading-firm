"use client";

/**
 * RuntimeTogglesPanel — Laufzeit-Schalter direkt im Operations Center.
 *
 * Zwei Verwendungen (Prop `group`):
 *   - `providers` (Sektion „LLM Operations"): je LLM-Provider ein Schalter.
 *     Aus = der MODEL_ROUTER wählt den Provider nie, es findet **kein**
 *     Netzwerkverkehr statt (auch kein Health-Ping). Damit lassen sich z. B.
 *     die OpenCode-Zen-Free-Modelle bequem ein- und ausschalten — ohne
 *     `.env`-Bearbeitung und ohne Prozess-Neustart.
 *   - `broker` (Sektion „Broker Operations"): Remote-Health-Checks der Venues
 *     (read-only, credential-frei) ein-/ausschalten. Default AUS.
 *
 * Sicherheit: Änderungen laufen über `PUT /api/ops/toggles` (Admin-Guard +
 * CSRF, auditiert). Dieses Panel sendet ausschließlich Schlüssel aus der
 * Server-Allowlist und nie Secrets. Der Server ist die Wahrheit — nach dem
 * Speichern wird die Antwort übernommen, nicht lokal geraten.
 *
 * XSS-sicher: kein innerHTML, alle Werte als JSX-Text.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch, readJson } from "@/lib/apiClient";

/** Server-Antwort von `GET/PUT /api/ops/toggles`. */
type RuntimeFlagView = {
  key: string;
  value: boolean;
  explicit: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  label: string;
  description: string;
  envVar: string | null;
  defaultValue: boolean;
  mutable: boolean;
  effective: boolean;
  source: "runtime" | "env" | "default";
};

type TogglesPayload = {
  ok?: boolean;
  flags?: RuntimeFlagView[];
  error?: string;
  message?: string;
};

const SOURCE_LABEL: Record<RuntimeFlagView["source"], string> = {
  runtime: "UI-Schalter",
  env: ".env",
  default: "Default",
};

/** Provider-ID aus dem Schlüssel `provider.<id>.enabled`. */
function providerIdOf(key: string): string | null {
  const match = /^provider\.([a-z0-9_-]+)\.enabled$/.exec(key);
  return match ? match[1] : null;
}

function stampUtc(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

export default function RuntimeTogglesPanel({ group }: { group: "providers" | "broker" }) {
  const [flags, setFlags] = useState<RuntimeFlagView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch("/api/ops/toggles");
      const { data, error: readError } = await readJson<TogglesPayload>(
        res,
        "Schalter konnten nicht geladen werden."
      );
      if (!mounted.current) return;
      if (readError || !data.ok) {
        setError(readError || data.error || "Unbekannter Fehler");
        return;
      }
      setFlags(data.flags ?? []);
    } catch {
      if (mounted.current) setError("Netzwerkfehler — /api/ops/toggles nicht erreichbar.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  const apply = useCallback(
    async (flag: RuntimeFlagView, next: boolean | null) => {
      setBusyKey(flag.key);
      setError("");
      try {
        const res = await apiFetch("/api/ops/toggles", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: flag.key, value: next }),
        });
        const { data, error: readError } = await readJson<TogglesPayload>(
          res,
          "Änderung fehlgeschlagen."
        );
        if (!mounted.current) return;
        if (readError || !data.ok) {
          setError(readError || data.error || "Unbekannter Fehler");
          return;
        }
        if (data.flags) setFlags(data.flags);
      } catch {
        if (mounted.current) setError("Netzwerkfehler beim Speichern.");
      } finally {
        if (mounted.current) setBusyKey(null);
      }
    },
    []
  );

  const relevant =
    group === "providers"
      ? flags.filter((f) => providerIdOf(f.key) !== null)
      : flags.filter((f) => f.key === "broker.healthcheck.remote");

  const heading =
    group === "providers" ? "LLM-Provider-Schalter" : "Broker-Remote-Checks";

  return (
    <section className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="text-sm font-bold text-slate-100">{heading}</h3>
        <span className="rounded-md border border-slate-700 bg-slate-900 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          sofort wirksam
        </span>
      </div>

      <p className="text-[11px] leading-relaxed text-slate-400">
        {group === "providers"
          ? "Freigabe je Provider im MODEL_ROUTER. Aus heißt: keine Anfragen, keine Kosten, kein Datenabfluss an diesen Anbieter — auch kein Health-Ping. Änderungen werden auditiert."
          : "Read-only Netzpings an öffentliche Venue-/Datenquellen-Endpunkte (keine Credentials, keine Orders). Aus (Default) bleibt der Health-Status rein lokal."}
      </p>

      {error && (
        <p className="mt-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-[11px] leading-relaxed text-red-200">
          {error}
        </p>
      )}

      {loading && relevant.length === 0 && !error && (
        <p className="mt-3 text-[11px] text-slate-500">Lade Schalter …</p>
      )}

      <ul className="mt-3 space-y-2">
        {relevant.map((flag) => {
          const provider = providerIdOf(flag.key);
          const isFreeCloud = provider === "opencode";
          return (
            <li
              key={flag.key}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-100">
                    {provider ? provider.toUpperCase() : flag.label}
                    {isFreeCloud && (
                      <span className="ml-2 rounded border border-emerald-800/60 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                        Free-Modelle
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{flag.description}</p>
                  <p className="mt-1 text-[10px] text-slate-500">
                    Zustand: <b className={flag.effective ? "text-emerald-300" : "text-slate-400"}>
                      {flag.effective ? "freigegeben" : "gesperrt"}
                    </b>{" "}
                    · Quelle: {SOURCE_LABEL[flag.source]}
                    {flag.envVar ? ` (${flag.envVar})` : ""}
                    {flag.explicit ? ` · gesetzt ${stampUtc(flag.updatedAt)} von ${flag.updatedBy ?? "—"}` : ""}
                  </p>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-1">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={flag.effective}
                    aria-label={`${provider ?? flag.label} ${flag.effective ? "abschalten" : "einschalten"}`}
                    disabled={!flag.mutable || busyKey === flag.key}
                    onClick={() => void apply(flag, !flag.effective)}
                    className={`h-6 w-11 rounded-full border transition-colors ${
                      flag.effective
                        ? "border-emerald-700 bg-emerald-500/30"
                        : "border-slate-700 bg-slate-800"
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    <span
                      className={`block h-4 w-4 translate-y-[3px] rounded-full transition-transform ${
                        flag.effective ? "translate-x-6 bg-emerald-300" : "translate-x-1 bg-slate-500"
                      }`}
                    />
                  </button>
                  {flag.explicit && (
                    <button
                      type="button"
                      disabled={busyKey === flag.key}
                      onClick={() => void apply(flag, null)}
                      className="text-[10px] text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline disabled:opacity-50"
                    >
                      auf Default
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {!loading && relevant.length === 0 && !error && (
        <p className="mt-3 text-[11px] text-slate-500">Keine Schalter gemeldet.</p>
      )}
    </section>
  );
}
