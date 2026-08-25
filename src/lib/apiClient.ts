/**
 * Fetch-Wrapper für das Browser-Dashboard: hängt den API-Token an mutierende
 * Requests, wenn er in localStorage liegt (FIRM_API_TOKEN-Betrieb, siehe
 * src/lib/apiAuth.ts). Von FirmDashboard und allen Workshop-Panels geteilt.
 */
export function apiFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token =
    typeof window !== "undefined" ? window.localStorage.getItem("firmToken") ?? "" : "";
  const headers = new Headers(opts.headers ?? {});
  if (token && ["POST", "PUT", "DELETE"].includes((opts.method ?? "GET").toUpperCase())) {
    headers.set("x-firm-token", token);
  }
  return fetch(url, { ...opts, headers });
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
