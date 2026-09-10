/**
 * Lade- und Login-Fehler des Firm-Dashboards (v1.36.41, Bug 2 aus
 * `docs/HOWTO_LAN_SESSION.md`).
 *
 * Problem davor: `FirmDashboard.load()` schrieb **jeden** Fehlerbody von
 * `GET /api/firm` in dieselbe Hinweisbox, deren Titel hart
 * „Firm-Status nicht verfügbar (Datenbank)." lautete. Ein `401 UNAUTHORIZED`
 * nach Ablauf der 15-Minuten-Session (`firm_session`) wurde damit als
 * PostgreSQL-Schaden ausgegeben — inklusive der Empfehlung, `DATABASE_URL`
 * und `npx drizzle-kit push` zu prüfen, obwohl `/api/health` `schemaReady:true`
 * meldete. Zusätzlich erschien das Token-Feld erst nach einer *Aktion*, und
 * nach erfolgreichem Login musste die Seite manuell neu geladen werden.
 *
 * Dieses Modul ist der einzige Ort, der einen fehlgeschlagenen Firm-Load
 * klassifiziert und den Login durchführt — bewusst ohne React und ohne
 * Browser-Globals, damit dieselbe Logik in `tests/firmSession.test.ts` mit
 * einem Stub-`fetch` geprüft werden kann. Die Komponenten reichen nur ihre
 * Setter als Hooks herein.
 *
 * Sicherheit: Der Token wird ausschließlich im Body von `POST /api/auth/login`
 * übertragen — nie in einer URL, nie in einem Header, nie in einer Meldung.
 * Meldungen übernehmen höchstens `error`/`hint`/`fix` des Servers; die
 * serverseitige Redaction (`publicErrorMessage`) bleibt damit wirksam.
 */

/** Art des Ladefehlers — bestimmt Titel, Hinweis und ob ein Login nötig ist. */
export type FirmIssueKind =
  /** 401: Session fehlt/abgelaufen (Neustart, TTL, Secret-Rotation). */
  | "session"
  /** 403: authentifiziert, aber ohne `firm.read` (bzw. Admin-Token erwartet). */
  | "forbidden"
  /** 5xx bzw. Antwort mit `.fix`: die Datenquelle (PostgreSQL) antwortet nicht. */
  | "database"
  /** Antwort passte nicht zum Vertrag (z. B. HTML statt JSON, leeres Objekt). */
  | "unexpected"
  /** `fetch` selbst schlug fehl: Dienst nicht erreichbar. */
  | "network";

/** Klassifizierter Ladefehler, direkt renderbar. */
export type FirmIssue = {
  kind: FirmIssueKind;
  /** Kurzer, wahrer Titel der Hinweisbox — kein pauschales „Datenbank". */
  title: string;
  /** Technischer Grund (Server-`error` bzw. Zustandsbeschreibung). */
  detail: string;
  /** Handlungsempfehlung; leer, wenn keine Diagnose sinnvoll ist. */
  hint: string;
  /** `true` ⇒ das Token-Feld wird sofort eingeblendet. */
  needsLogin: boolean;
};

/** Ergebnis von `GET /api/firm`: Nutzdaten oder ein klassifizierter Fehler. */
export type FirmSnapshotResult =
  | { ok: true; data: unknown }
  | { ok: false; issue: FirmIssue };

/** Titel je Fehlerart — die einzige Zuordnung von Ursache zu Überschrift. */
const TITLES: Record<FirmIssueKind, string> = {
  session: "Sitzung abgelaufen — bitte neu anmelden.",
  forbidden: "Zugriff verweigert — Anmeldung oder Berechtigung fehlt.",
  database: "Firm-Status nicht verfügbar (Datenbank).",
  unexpected: "Firm-Status nicht verfügbar (unerwartete Antwort).",
  network: "Firm-Status nicht erreichbar (Netzwerk).",
};

/**
 * Fallback, wenn der Server kein `.fix` mitschickt — identisch zum `fix`-Text
 * von `src/app/api/firm/route.ts`, damit beide Pfade dieselbe Anleitung geben.
 */
const DATABASE_HINT =
  "PostgreSQL gestartet? `DATABASE_URL` gesetzt? `npx drizzle-kit push` ausgeführt?";

/** Session-TTL des Servers (`SESSION_TTL_S`); nur Anzeige-Fallback. */
const SESSION_TTL_FALLBACK_S = 900;

/** Nur Strings übernehmen — alles andere wäre gerendertes Rauschen. */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function issue(kind: FirmIssueKind, detail: string, hint: string): FirmIssue {
  return {
    kind,
    title: TITLES[kind],
    detail,
    hint,
    needsLogin: kind === "session" || kind === "forbidden",
  };
}

type ErrorBody = { ok?: unknown; error?: unknown; hint?: unknown; fix?: unknown };

/**
 * Ordnet eine Fehlerantwort von `GET /api/firm` ihrer Ursache zu.
 *
 * - `401` → Session-Thema (kein DB-Text, Login-Feld sichtbar),
 * - `403` → Permission-Thema (Server-`hint` nennt die fehlende Permission),
 * - `5xx` **oder** Body mit `.fix` → Datenbank-Thema (DB-Anleitung bleibt),
 * - alles andere → „unerwartete Antwort" ohne Fehldiagnose.
 */
export function classifyFirmFailure(status: number, body: unknown): FirmIssue {
  const parsed = (body ?? {}) as ErrorBody;
  const error = text(parsed.error);
  const hint = text(parsed.hint);
  const fix = text(parsed.fix);

  if (status === 401) return issue("session", error || `HTTP 401`, "");
  if (status === 403) return issue("forbidden", error || `HTTP 403`, hint);
  if (status >= 500 || fix) {
    return issue("database", error || `HTTP ${status}`, fix || DATABASE_HINT);
  }
  return issue("unexpected", error || `HTTP ${status}`, hint);
}

/**
 * Mindestvertrag des Firm-Snapshots. Ohne diese Prüfung landete ein Fehlerbody
 * früher im State und ließ `data.positions.filter` beim nächsten Rendern
 * abstürzen (FIX v1.23.0) — daher bleibt sie zentral und getestet.
 */
export function isFirmSnapshot(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const value = json as { ok?: unknown; positions?: unknown; missions?: unknown };
  if (value.ok === false) return false;
  return Array.isArray(value.positions) && Array.isArray(value.missions);
}

/**
 * Lädt den Firm-Zustand. Wirft nie: Jeder Fehlerpfad endet in einem
 * klassifizierten `FirmIssue`, den die Komponente unverändert rendern kann.
 */
export async function fetchFirmSnapshot(
  fetchImpl: typeof fetch = fetch
): Promise<FirmSnapshotResult> {
  let res: Response;
  try {
    res = await fetchImpl("/api/firm");
  } catch {
    return { ok: false, issue: issue("network", "GET /api/firm nicht erreichbar.", "") };
  }
  // Auch Fehlerkörper sind JSON — ein Parse-Fehler (HTML-500) wird unten als
  // „unerwartete Antwort" klassifiziert, statt als Netzwerkfehler zu lügen.
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) {
    if (isFirmSnapshot(body)) return { ok: true, data: body };
    return {
      ok: false,
      issue: issue(
        "unexpected",
        `Unerwartete Antwort von GET /api/firm (HTTP ${res.status}).`,
        ""
      ),
    };
  }
  return { ok: false, issue: classifyFirmFailure(res.status, body) };
}

type LoginBody = { ok?: unknown; error?: unknown; hint?: unknown; open?: unknown; expiresInS?: unknown };

export type SessionTokenHooks = {
  /** Ergebnis-Meldung für den Hinweisbalken (Erfolg wie Ablehnung). */
  onNotice: (message: string) => void;
  /** Nach erfolgreichem Login: Firm-Status neu laden — ersetzt das manuelle F5. */
  reload: () => void | Promise<void>;
  /** Nur für Tests: injizierbares `fetch`. */
  fetchImpl?: typeof fetch;
};

/**
 * Meldet den Browser über `POST /api/auth/login` an (W1, v1.36.23: der Token
 * wird nur serverseitig geprüft, das Ergebnis ist die HttpOnly-Session-Cookie)
 * und lädt den Firm-Status danach automatisch neu.
 *
 * @returns `true` bei gültiger Session — die Komponente blendet das Token-Feld
 *          aus; `false` bei Ablehnung/Netzwerkfehler (Feld bleibt offen).
 */
export async function submitSessionToken(
  token: string,
  hooks: SessionTokenHooks
): Promise<boolean> {
  const fetchImpl = hooks.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "same-origin",
    });
  } catch {
    hooks.onNotice("Netzwerkfehler — /api/auth/login nicht erreichbar.");
    return false;
  }

  const json = (await res.json().catch(() => null)) as LoginBody | null;
  if (!res.ok || json?.ok !== true) {
    hooks.onNotice(
      `Anmeldung abgelehnt: ${text(json?.hint) || text(json?.error) || `HTTP ${res.status}`}`
    );
    return false;
  }

  hooks.onNotice(
    json.open
      ? "Lokaler Offen-Betrieb — keine Anmeldung nötig."
      : `Session aktiv (${typeof json.expiresInS === "number" ? json.expiresInS : SESSION_TTL_FALLBACK_S} s) — Firm-Status wird neu geladen.`
  );
  await hooks.reload();
  return true;
}
