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

/* ---------------------------------------------------------------------------
 * Anmelde-/Sitzungsstatus (v1.39.0, S1) — „Ist die Firm-API eingetragen, und
 * laeuft meine Session gerade?“
 *
 * Dieselbe Regel wie oben: bewusst kein React und keine Browser-Globals, damit
 * `tests/firmSession.test.ts` alles mit einem Stub-`fetch` prueft. Der Server
 * ist die einzige Wahrheit ueber Fristen (`/api/auth/status`); der Client
 * rechnet nur die Restzeit bis zum Naechstpruef-Zeitpunkt herunter.
 * ------------------------------------------------------------------------- */

/** Zustand der eigenen Browser-Session — Projektion von `sessionStatus()`. */
export type SessionState =
  | "active"
  | "expiring"
  | "renewable"
  | "missing"
  | "expired"
  | "max-life"
  | "revoked"
  | "invalid"
  | "open";

/** Ist die Firm-API serverseitig eingerichtet? Nur Booleans, nie Werte. */
export type FirmApiConfig = {
  configured: boolean;
  admin: boolean;
  operator: boolean;
  viewer: boolean;
  /** Gueltiges, unabhaengiges `FIRM_SESSION_SECRET` ⇒ Sessions moeglich. */
  sessionsAvailable: boolean;
};

/** Snapshot von `GET /api/auth/status`, auf das UI-Notwendige reduziert. */
export type SessionSnapshot = {
  mode: "local-open" | "token-required";
  reason: string;
  firmApi: FirmApiConfig;
  session: {
    active: boolean;
    state: SessionState;
    role: string | null;
    remainingS: number;
    maxLifeRemainingS: number;
    renewInS: number;
    idleTtlS: number;
    maxLifeS: number;
    graceS: number;
    cookieLifetime: string;
    expiresAt: number | null;
  };
  /** Millisekunden seit Epoch der Serverantwort — Basis des Runterzaehlens. */
  observedAt: number;
};

const SESSION_STATES: readonly string[] = [
  "active", "expiring", "renewable", "missing", "expired", "max-life", "revoked", "invalid", "open",
];

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function int(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

/**
 * Toleranter Parser: ein Teil eines fehlenden Felds macht keinen Crash, aber
 * ein Snapshot ohne `session`-Objekt ist wertlos ⇒ `null` (= Status unbekannt).
 */
export function parseSessionStatus(json: unknown, observedAt: number = Date.now()): SessionSnapshot | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const session = root.session as Record<string, unknown> | undefined;
  if (!session || typeof session !== "object") return null;
  const firmApi = (root.firmApi ?? {}) as Record<string, unknown>;
  const authMode = (root.authMode ?? {}) as Record<string, unknown>;
  const state = SESSION_STATES.includes(String(session.state)) ? (String(session.state) as SessionState) : "invalid";
  const mode = authMode.mode === "local-open" ? "local-open" : "token-required";
  const expiresAtMs = typeof session.expiresAt === "string" ? Date.parse(session.expiresAt) : NaN;
  return {
    mode,
    reason: typeof authMode.reason === "string" ? authMode.reason : "",
    firmApi: {
      configured: bool(firmApi.configured),
      admin: bool(firmApi.admin),
      operator: bool(firmApi.operator),
      viewer: bool(firmApi.viewer),
      sessionsAvailable: bool(firmApi.sessionsAvailable),
    },
    session: {
      active: bool(session.active),
      state,
      role: typeof session.role === "string" ? session.role : null,
      remainingS: int(session.remainingS),
      maxLifeRemainingS: int(session.maxLifeRemainingS),
      renewInS: int(session.renewInS, 15),
      idleTtlS: int(session.idleTtlS, 900),
      maxLifeS: int(session.maxLifeS),
      graceS: int(session.graceS),
      cookieLifetime: typeof session.cookieLifetime === "string" ? session.cookieLifetime : "browser-session",
      expiresAt: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
    },
    observedAt,
  };
}

/** Laeuft die Session noch — ggf. abzgl. der seit der Antwort verstrichenen Zeit. */
export function sessionRemainingS(snapshot: SessionSnapshot, now: number = Date.now()): number {
  const elapsed = Math.max(0, Math.floor((now - snapshot.observedAt) / 1000));
  return Math.max(0, snapshot.session.remainingS - elapsed);
}

/** Restzeit bis zur absoluten Grenze (unabhaengig von Verlaengerungen). */
export function sessionMaxLifeRemainingS(snapshot: SessionSnapshot, now: number = Date.now()): number {
  const elapsed = Math.max(0, Math.floor((now - snapshot.observedAt) / 1000));
  return Math.max(0, snapshot.session.maxLifeRemainingS - elapsed);
}

/** Sekunden, bis der Client die Verlaengerung anstossen soll (`null` = nie). */
export function sessionRenewDelayMs(snapshot: SessionSnapshot | null, now: number = Date.now()): number | null {
  if (!snapshot || snapshot.session.state === "open") return null;
  // Idle-Frist um, Nachfrist laeuft: sofort versuchen (Schlafpause, gedrosselter Tab).
  if (snapshot.session.state === "renewable") return 0;
  if (snapshot.session.state !== "active" && snapshot.session.state !== "expiring") return null;
  const remaining = sessionRemainingS(snapshot, now);
  if (remaining <= 0) return 0;
  return Math.max(15, snapshot.session.renewInS) * 1000;
}

/** Braucht diese Antwort das Token-Feld? (offener Betrieb und renewable: nein) */
export function sessionNeedsLogin(snapshot: SessionSnapshot | null): boolean {
  if (!snapshot) return false;
  const { state } = snapshot.session;
  if (state === "open" || state === "active" || state === "expiring" || state === "renewable") return false;
  // Ohne eingerichtetes Credential und ohne moegliche Sessions fuehrt das
  // Feld zu nichts — die Meldung erklaert den Konfigurationsfehler.
  return snapshot.firmApi.configured || snapshot.firmApi.sessionsAvailable;
}

export type SessionNotice = {
  /** Kurztext fuer den Balken — nennt immer API-Konfiguration UND Session. */
  label: string;
  /** `true` ⇒ Warn-/Farbton, sonst neutral. */
  warning: boolean;
};

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  operator: "Operator",
  viewer: "Viewer",
};

/** `mm:ss` bzw. `h:mm:ss` — die einzige Ort, an dem die Restzeit formatiert wird. */
export function formatSessionCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const tail = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${tail}` : tail;
}

/**
 * Menschenlesbare Statuszeile: unterscheidet als erstes, ob die Firm-API
 * ueberhaupt eingetragen ist (die Frage, die das Dashboard vorher nie
 * beantwortet hat), und dann, was mit der eigenen Session los ist.
 */
export function describeSession(
  snapshot: SessionSnapshot | null,
  now: number = Date.now(),
  unavailable = false
): SessionNotice {
  if (!snapshot) {
    return unavailable
      ? {
          label: "Anmeldestatus nicht ermittelbar (Netzwerk?) — Aktionen brauchen eine gueltige Sitzung.",
          warning: true,
        }
      : { label: "Anmeldestatus wird gepraft…", warning: false };
  }
  const { session, firmApi } = snapshot;
  if (session.state === "open") {
    return {
      label: "Lokaler Offen-Betrieb: kein Firm-API-Token eingerichtet — keine Anmeldung noetig (nur fuer Entwicklung/Loopback geeignet).",
      warning: true,
    };
  }
  const apiPart = firmApi.configured
    ? `Firm-API: eingetragen${firmApi.admin ? " (Admin" : " ("}${firmApi.operator ? "+Operator" : ""}${
        firmApi.viewer ? "+Viewer" : ""
      })`
    : "Firm-API: KEIN Token gesetzt";
  const countdown = formatSessionCountdown(sessionRemainingS(snapshot, now));
  const maxLife = sessionMaxLifeRemainingS(snapshot, now);
  const life = `Session noch ${countdown} · automatische Verlaengerung · absolute Grenze in ${formatSessionCountdown(maxLife)}`;

  switch (session.state) {
    case "active":
    case "expiring":
      return {
        label: `${apiPart} · angemeldet als ${ROLE_LABEL[session.role ?? ""] ?? session.role ?? "unbekannt"} · ${life}`,
        warning: session.state === "expiring",
      };
    case "renewable":
      return {
        label: `${apiPart} · Sitzung war im Hintergrund inaktiv (${countdown} Puffer) — wird automatisch wiederhergestellt, sofort mit „Verlängern”.`,
        warning: true,
      };
    case "missing":
      return {
        label: `${apiPart} · nicht angemeldet — API-Token eintragen. Die Sitzung gilt bis zum Schließen des Browserfensters.`,
        warning: true,
      };
    case "expired":
      return { label: `${apiPart} · Sitzung abgelaufen (auch Nachfrist vorbei) — bitte neu anmelden.`, warning: true };
    case "max-life":
      return {
        label: `${apiPart} · Maximale Sitzungsdauer erreicht (${formatCountdownHint(snapshot)}) — bitte neu anmelden.`,
        warning: true,
      };
    case "revoked":
      return { label: `${apiPart} · Sitzung widerrufen (Logout oder Notfallschnitt) — bitte neu anmelden.`, warning: true };
    default:
      return {
        label: `${apiPart} · gueltige Anmeldung erforderlich (Session ungueltig: Auth-Konfiguration oder Secret geaendert).`,
        warning: true,
      };
  }
}

/** Lesbarer Hinweis auf die absolute Grenze, ohne sie zu erraten. */
function formatCountdownHint(snapshot: SessionSnapshot): string {
  const hours = Math.round((snapshot.session.maxLifeS || 0) / 3600);
  return hours > 0 ? `${hours} h` : `${snapshot.session.maxLifeS || 0} s`;
}

export type SessionStatusResult =
  | { ok: true; snapshot: SessionSnapshot }
  | { ok: false; error: string };

/** `GET /api/auth/status` — wirft nie, auch nicht bei HTML/Stolpern des Servers. */
export async function fetchSessionStatus(
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now()
): Promise<SessionStatusResult> {
  let res: Response;
  try {
    res = await fetchImpl("/api/auth/status", { method: "GET", credentials: "same-origin", cache: "no-store" });
  } catch {
    return { ok: false, error: "Netzwerkfehler — /api/auth/status nicht erreichbar." };
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const snapshot = parseSessionStatus(json, now);
  if (!snapshot) return { ok: false, error: "Unerwartete Antwort von GET /api/auth/status." };
  return { ok: true, snapshot };
}

export type SessionRenewResult =
  | { ok: true; renewed: boolean; remainingS: number; error: string }
  | { ok: false; renewed: false; remainingS: number; error: string };

/**
 * `POST /api/auth/refresh` — eine Verlaengerung anstossen. Der CSRF-Wert kommt
 * als Parameter herein (Double-Submit aus `firm_csrf`), damit diese Funktion
 * ohne `document` testbar bleibt. Bei 401 meldet der Server „neu anmelden“.
 */
export async function renewSession(
  csrf: string,
  fetchImpl: typeof fetch = fetch
): Promise<SessionRenewResult> {
  let res: Response;
  try {
    res = await fetchImpl("/api/auth/refresh", {
      method: "POST",
      headers: { "x-csrf-token": csrf },
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, renewed: false, remainingS: 0, error: "Netzwerkfehler — /api/auth/refresh nicht erreichbar." };
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const remainingS = int(json?.expiresInS);
  if (!res.ok) {
    const error = text(json?.hint) || text(json?.error) || `HTTP ${res.status}`;
    return { ok: false, renewed: false, remainingS, error };
  }
  if (bool(json?.open)) {
    return { ok: true, renewed: false, remainingS, error: "Lokaler Offen-Betrieb — keine Session." };
  }
  return {
    ok: true,
    renewed: bool(json?.renewed),
    remainingS,
    error: text(json?.hint),
  };
}

type LoginBody = {
  ok?: unknown;
  error?: unknown;
  hint?: unknown;
  open?: unknown;
  expiresInS?: unknown;
  lifetime?: { idleTtlS?: unknown; maxLifeS?: unknown } | null;
};

export type SessionTokenHooks = {
  /** Ergebnis-Meldung für den Hinweisbalken (Erfolg wie Ablehnung). */
  onNotice: (message: string) => void;
  /** Nach erfolgreichem Login: Firm-Status neu laden — ersetzt das manuelle F5. */
  reload: () => void | Promise<void>;
  /** Nur für Tests: injizierbares `fetch`. */
  fetchImpl?: typeof fetch;
};

/**
 * Meldung, wenn der Login serverseitig Erfolg meldete, die Session aber nicht
 * angenommen wurde. Das ist der häufigste stille Bruch im LAN-Betrieb: Die
 * Cookies tragen `Secure` — über `http://192.168.x.x:3369` verwirft der
 * Browser sie, obwohl der Login `200` war. Ohne diese Zeile bleibt nur
 * „Sitzung abgelaufen“ als rätselhafter Zustand zurück.
 */
export function diagnosePostLogin(snapshot: SessionSnapshot | null): string {
  if (snapshot?.session.active) return "";
  if (snapshot && snapshot.session.state !== "missing") return "";
  return (
    "Anmeldung vom Server bestätigt, aber keine Sitzungs-Cookie im Browser — " +
    "die App läuft über plain-HTTP? `Secure`-Cookies brauchen TLS (Gegencheck: " +
    "GET /api/auth/status). Behelf: über https:// (Proxy/TLS) oder localhost öffnen."
  );
}

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

  const idleS = typeof json.lifetime?.idleTtlS === "number" ? json.lifetime.idleTtlS : SESSION_TTL_FALLBACK_S;
  const maxLifeS = typeof json.lifetime?.maxLifeS === "number" ? json.lifetime.maxLifeS : 0;
  hooks.onNotice(
    json.open
      ? "Lokaler Offen-Betrieb — keine Anmeldung nötig."
      : `Angemeldet: die Sitzung gilt bis zum Schließen des Browserfensters und verlängert sich automatisch ` +
        `(Frist ${idleS} s${maxLifeS ? `, absolute Grenze ${Math.round(maxLifeS / 3600)} h` : ""}). ` +
        `Firm-Status wird neu geladen.`
  );
  await hooks.reload();
  return true;
}
