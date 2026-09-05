/**
 * Fetch-Wrapper für das Browser-Dashboard (W1, v1.36.23).
 *
 * Die Authentifizierung läuft über die HttpOnly-Session-Cookie des Browsers
 * (`firm_session`, von `POST /api/auth/login` gesetzt) — es wird KEIN Token
 * mehr aus localStorage gelesen und in Header gesetzt. Mutierende Requests
 * senden stattdessen den Double-Submit-CSRF-Header `x-csrf-token`
 * (Wert aus `firm_csrf`, Offen-Betrieb: "local").
 * Von FirmDashboard, Workshop und Operations Center geteilt.
 */
import { csrfHeaderValue } from "@/lib/browserSession";

export function apiFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const headers = new Headers(opts.headers ?? {});
  const method = (opts.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !headers.has("x-csrf-token")) {
    headers.set("x-csrf-token", csrfHeaderValue());
  }
  return fetch(url, { ...opts, headers, credentials: "same-origin" });
}

/**
 * Liest eine JSON-Response und wandelt Netzwerk-/Parse-Fehler in eine
 * aussagekräftige Meldung. Liefert nie `undefined` — im Fehlerfall steht
 * `error` auf einem nicht-leeren String.
 */
export async function readJson<T extends { ok?: boolean; error?: string }>(
  res: Response,
  fallback: string
): Promise<{ res: Response; data: T; error: string }> {
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    data = {} as T;
  }
  const error =
    !res.ok
      ? (data as { error?: string }).error?.trim() || `${fallback} (HTTP ${res.status})`
      : data.ok === false
        ? (data as { error?: string }).error?.trim() || fallback
        : "";
  return { res, data, error };
}