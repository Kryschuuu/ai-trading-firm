"use client";

/**
 * Maskiertes Credential-Formular (Task 08).
 *
 * SICHERHEITSREGELN:
 *   - Beide Felder sind Passwort-Felder (type="password") und werden NIE
 *     als Klartext angezeigt (kein "Auge"-Toggle, kein Echo in der UI).
 *   - autoComplete="new-password" + autoCapitalize="none" + spellCheck=false:
 *     Browser-Passwortmanager sollen nichts speichern/vorschlagen.
 *   - form noValidate: Validierung liegt vollstaendig beim Server
 *     (16-512 Zeichen, keine Steuerzeichen) — der Client blockt nur
 *     offensichtlich Leeres.
 *   - Nach dem Submit werden die Feld-Werte SOFORT geleert und der State
 *     verworfen — das Secret existiert nur transient im Speicher.
 *   - Kein localStorage/sessionStorage/IndexedDB, kein console.log,
 *     keine URL-Parameter.
 *
 * Datenfluss (verbindlich): masked form → POST /api/brokers/{venue}/credentials
 * → verschluesselter Secret-Store → Adapter. Antwort ist status-only.
 */
import { useState } from "react";
import { saveVenueCredentials, type BrokerStatusDto } from "@/lib/controlPlane";

export default function CredentialForm({
  venue,
  label,
  onDone,
  onUnauthorized,
}: {
  venue: string;
  label: string;
  /** Ergebnis des Speicherns (Erfolg ODER Fehler mit SAFE-Meldung). */
  onDone: (result: BrokerStatusDto | null, error: string) => void;
  onUnauthorized: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const canSubmit =
    !busy && apiKey.trim().length >= 16 && apiSecret.trim().length >= 16;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      setError("Beide Felder sind Pflicht (mind. 16 Zeichen, max. 512).");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await saveVenueCredentials(venue, apiKey, apiSecret);
      if (result.unauthorized) {
        onUnauthorized();
        setError("Nicht berechtigt (Admin-Token erforderlich).");
        return;
      }
      if (result.error) {
        setError(result.error);
        onDone(null, result.error);
        return;
      }
      // Secret aus dem Client-Speicher entfernen — Wert existiert ab jetzt
      // ausschliesslich verschluesselt im Backend-Store.
      setApiKey("");
      setApiSecret("");
      onDone(result.data, "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      autoComplete="off"
      className="mt-4 rounded-xl border border-slate-800 bg-slate-900/70 p-4"
    >
      <p className="text-xs font-semibold text-slate-300">
        Zugangsdaten fuer {label} hinterlegen (einmalig, read-only Probe)
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
        Das Secret wird genau einmal an das Backend uebertragen, dort mit
        AES-256-GCM verschluesselt (AAD = Venue-ID) und danach NUR als
        Referenz gefuehrt. Es ist spaeter nicht mehr abrufbar oder anzeigbar.
      </p>

      <div className="mt-3 space-y-3">
        <label className="block">
          <span className="text-xs text-slate-400">API-Key</span>
          <input
            type="password"
            name="apiKey"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            minLength={16}
            maxLength={512}
            placeholder="••••••••••••••••"
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-700 focus:border-sky-500 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="text-xs text-slate-400">API-Secret</span>
          <input
            type="password"
            name="apiSecret"
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            minLength={16}
            maxLength={512}
            placeholder="••••••••••••••••"
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-700 focus:border-sky-500 focus:outline-none"
          />
        </label>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-red-800/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-lg bg-sky-500 px-4 py-2 text-xs font-bold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Speichere & pruefe …" : "Speichern & verbinden"}
        </button>
        <p className="text-[11px] text-slate-600">
          {canSubmit
            ? "Senden loest genau eine read-only Probe aus (kein Trade)."
            : "Bitte beide Felder ausfuellen (mind. 16 Zeichen)."}
        </p>
      </div>
    </form>
  );
}
