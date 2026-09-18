/**
 * Alert-Adapter (GAP-10, D3, v1.45.0) — „die Firma meldet sich, wenn etwas
 * kaputt ist“.
 *
 * Drei Senken hinter EINEM Interface:
 *
 *   LogAlertSink      strukturiertes JSON-Log (Muster `src/lib/logger.ts`,
 *                     redigiert + gekürzt, keine Secrets).
 *   FileAlertSink     append-only NDJSON `data/alerts.ndjson` über
 *                     `resolveRuntimePath()` — CLI und Server sehen dieselbe
 *                     Datei (Pfadmuster wie die übrigen Laufzeit-Ablagen).
 *   WebhookAlertSink  OPTIONAL und standardmäßig AUS. Die URL kommt
 *                     AUSSCHLIESSLICH aus dem verschlüsselten Secret-Store
 *                     (`ALERT_WEBHOOK_URL_SECRET_NAME`) — nie aus einer
 *                     Klartext-Umgebungsvariable. Der Webhook-URL wird nie
 *                     geloggt (sie ist selbst ein Credential).
 *
 * Alert-Fatigue-Schutz (D3-Pflicht): Ein identischer `alert.code` wird höchstens
 * einmal pro `ALERT_DEBOUNCE_MINUTES` (Default 30, Bounds [1, 1440]) versendet.
 * Unterdrückte Alerts werden gezählt und beim nächsten echten Versand als
 * `suppressedSinceLast` mitgegeben — der Operator sieht also „12 weitere
 * identische Alarme in den letzten 30 Minuten“ statt 12 Zeilen Rauschen.
 *
 * Fehler-Semantik: Eine Alert-Senke ist Beobachtbarkeit, kein Handelspfad.
 * `AlertDispatcher.emit()` wirft deshalb **nie**: Fehler einzelner Senken
 * werden gesammelt, strukturiert geloggt und im Ergebnis gemeldet. Der
 * Debounce-Zähler wird deterministisch über eine injizierbare Uhr geführt
 * (Tests, keine `Date.now()`-Streuung im Kern).
 */
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

import { joinRuntimePath, resolveRuntimePath } from "./appPaths";
import { envNumber } from "./env";
import { sanitizeLogField, structuredLog } from "./logger";
import { publicErrorMessage } from "./secrets";

/** Schweregrad eines Alerts (Abbildung auf Log-Level in `LogAlertSink`). */
export type AlertSeverity = "info" | "warning" | "critical";

/**
 * Ein Alert — bewusst klein und secret-frei:
 *   code     stabiler Maschinen-Code (Debounce-Schlüssel, z. B.
 *            `circuit-breaker:drawdown`)
 *   message  menschenlesbare Ein-Zeilen-Beschreibung
 *   meta     flache Zusatzwerte (Zahlen/Codes; wird redigiert + gekürzt)
 */
export interface Alert {
  code: string;
  severity: AlertSeverity;
  message: string;
  meta?: Record<string, unknown>;
  /** Ausstellungszeitpunkt (ISO) — vom Dispatcher gesetzt, wenn leer. */
  at?: string;
}

/** Senke für Alerts (Log, Datei, Webhook …). Fehler wirft der Dispatcher ab. */
export interface AlertSink {
  send(alert: Alert): Promise<void> | void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Konfiguration (Bounds + Defaults, Muster `loadExitConfig`/`loadFundingConfig`)
// ─────────────────────────────────────────────────────────────────────────────

/** Env-Namen (zentral, für Doku/Tests). */
export const ALERT_ENV = {
  DEBOUNCE_MINUTES: "ALERT_DEBOUNCE_MINUTES",
  WEBHOOK_URL_SECRET_NAME: "ALERT_WEBHOOK_URL_SECRET_NAME",
} as const;

/** Bounds des Debounce-Fensters in Minuten (Alert-Fatigue-Schutz). */
export const ALERT_DEBOUNCE_BOUNDS = { min: 1, max: 1440 } as const;

/** Sichere Defaults: 30 Minuten Debounce, Webhook aus. */
export const ALERT_DEFAULTS = { debounceMinutes: 30 } as const;

/** Default-Ablage der Datei-Senke (CLI + Server teilen dieselbe Datei). */
export const ALERT_FILE_DEFAULT = "data/alerts.ndjson";

/** Max. Länge einer NDJSON-Zeile (Schutz vor Log-Flutung durch Fremdtexte). */
export const ALERT_LINE_MAX = 4_000;

/** Max. Anzahl Meta-Schlüssel je Alert (Kardinalität/Flut). */
export const ALERT_META_KEYS_MAX = 24;

export interface AlertConfig {
  /** Debounce-Fenster je `code` in Minuten (Bounds [1, 1440]). */
  debounceMinutes: number;
  /**
   * Name des Credentials im Secret-Store, unter dem die Webhook-URL liegt.
   * Leer (`""`) = Webhook-Senke aus (Default).
   */
  webhookSecretName: string;
}

/**
 * Lädt die Alert-Konfiguration aus der Umgebung, klemmt auf die Bounds
 * (mit Warnung, Muster `envNumber`) und deaktiviert ungültige Secret-Namen
 * fail-closed: Der Secret-Store akzeptiert nur `^[A-Z0-9_-]{1,32}$`, ein
 * anderer Wert würde dort niemals greifen — und ein Klartext-Fallback auf
 * eine Env-URL gibt es bewusst NICHT.
 */
export function loadAlertConfig(
  env: Record<string, string | undefined> = process.env,
): AlertConfig {
  const debounceMinutes = envNumber(
    ALERT_ENV.DEBOUNCE_MINUTES,
    ALERT_DEFAULTS.debounceMinutes,
    ALERT_DEBOUNCE_BOUNDS.min,
    ALERT_DEBOUNCE_BOUNDS.max,
    env,
  );
  const rawName = String(env[ALERT_ENV.WEBHOOK_URL_SECRET_NAME] ?? "").trim();
  let webhookSecretName = "";
  if (rawName.length > 0) {
    if (/^[A-Z0-9_-]{1,32}$/i.test(rawName)) {
      webhookSecretName = rawName.toUpperCase();
    } else {
      console.warn(
        `[alerts] ${ALERT_ENV.WEBHOOK_URL_SECRET_NAME} ist kein gültiger Secret-Name ` +
          "(erlaubt: A-Z, 0-9, - und _, max. 32 Zeichen) → Webhook-Senke bleibt aus.",
      );
    }
  }
  return { debounceMinutes, webhookSecretName };
}

/** Pfad der Alert-Datei (relativ → Projektstamm, mit Ausbruchsschutz). */
export function alertFilePath(env: Record<string, string | undefined> = process.env): string {
  const configured = String(env.ALERT_FILE ?? "").trim();
  const raw = configured.length > 0 ? configured : ALERT_FILE_DEFAULT;
  try {
    return resolveRuntimePath(raw);
  } catch {
    // `..`-Ausbruch o. Ä. fällt auf die sichere Default-Ablage zurück
    // (eine kaputte Pfad-Konfiguration darf das Alarmieren nicht verhindern).
    return resolveRuntimePath(ALERT_FILE_DEFAULT);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Debounce (Alert-Fatigue-Schutz)
// ─────────────────────────────────────────────────────────────────────────────

export interface DebounceDecision {
  /** true = jetzt senden; false = unterdrücken. */
  send: boolean;
  /** Seit dem letzten Versand desselben Codes unterdrückte Alerts. */
  suppressedSinceLast: number;
}

/**
 * Einfacher, deterministischer Code-Debounce.
 *
 * Fenster = `debounceMinutes`. Erster Alert eines Codes geht immer durch; ein
 * identischer Code innerhalb des Fensters wird unterdrückt und gezählt. Erst
 * wenn das Fenster abgelaufen ist, geht wieder ein Alert raus — mit der Anzahl
 * der unterdrückten Alarme im Gepäck.
 */
export class AlertDebounce {
  private lastSentAt = new Map<string, number>();
  private suppressed = new Map<string, number>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(code: string, atMs: number = this.now()): DebounceDecision {
    const key = String(code ?? "").trim() || "UNKNOWN";
    const last = this.lastSentAt.get(key);
    if (last !== undefined && atMs - last < this.windowMs) {
      this.suppressed.set(key, (this.suppressed.get(key) ?? 0) + 1);
      return { send: false, suppressedSinceLast: 0 };
    }
    const suppressedSinceLast = this.suppressed.get(key) ?? 0;
    this.suppressed.delete(key);
    this.lastSentAt.set(key, atMs);
    return { send: true, suppressedSinceLast };
  }

  /** Nur für Tests: Debounce-Zustand leeren. */
  reset(): void {
    this.lastSentAt.clear();
    this.suppressed.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Senken
// ─────────────────────────────────────────────────────────────────────────────

/** Strukturierter Log-Sink (Muster `logger.ts`) — Default-Senke. */
export class LogAlertSink implements AlertSink {
  send(alert: Alert): void {
    const level = alert.severity === "critical" ? "critical" : alert.severity === "warning" ? "warn" : "info";
    structuredLog(level, "alert", {
      code: alert.code,
      severity: alert.severity,
      message: alert.message,
      at: alert.at ?? new Date().toISOString(),
      ...sanitizeMeta(alert.meta),
    });
  }
}

/**
 * NDJSON-Datei-Sink (`data/alerts.ndjson`).
 *
 * Gleiche Ablage für CLI und Server (`resolveRuntimePath`), Modus 0600,
 * jede Zeile redigiert + gekürzt. Ein Schreibfehler wird geworfen und vom
 * Dispatcher gesammelt — die Datei-Senke ist Beobachtbarkeit, kein Handelspfad.
 */
export class FileAlertSink implements AlertSink {
  constructor(
    private readonly file: string = alertFilePath(),
    private readonly maxBytes: number = ALERT_LINE_MAX,
  ) {}

  get path(): string {
    return this.file;
  }

  send(alert: Alert): void {
    const target = resolveRuntimePath(this.file);
    mkdirSync(path.dirname(target), { recursive: true });
    const line = JSON.stringify({
      ts: alert.at ?? new Date().toISOString(),
      code: alert.code,
      severity: alert.severity,
      message: sanitizeLogField(alert.message),
      ...sanitizeMeta(alert.meta),
    });
    const bounded = line.length > this.maxBytes ? `${line.slice(0, this.maxBytes - 2)}"}` : line;
    appendFileSync(target, `${bounded}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(target, 0o600);
    } catch {
      /* Best-effort (Dateisysteme ohne POSIX-Modes). */
    }
  }
}

/**
 * Optionaler Webhook-Sink — NUR mit URL aus dem Secret-Store.
 *
 * Die URL wird **nie** geloggt oder in Fehlermeldungen durchgereicht (sie ist
 * selbst ein Credential, z. B. ein Slack-Incoming-Webhook). Fehler nennen
 * ausschließlich Klasse/Status.
 */
export class WebhookAlertSink implements AlertSink {
  constructor(
    private readonly opts: {
      /** Auflöser der URL (Default: verschlüsselter Secret-Store). */
      resolveUrl: () => Promise<string | null>;
      fetchFn?: typeof fetch;
      timeoutMs?: number;
    },
  ) {}

  async send(alert: Alert): Promise<void> {
    const url = await this.opts.resolveUrl();
    if (!url) return; // kein Credential hinterlegt → Senke still (Default aus).
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("webhook: ungültige URL (nur http/https)");
    }
    const fetchFn = this.opts.fetchFn ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 5_000);
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: alert.code,
          severity: alert.severity,
          message: alert.message,
          at: alert.at ?? new Date().toISOString(),
          meta: sanitizeMeta(alert.meta),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Status als strukturiertes Feld — die Message bleibt frei von der URL.
        throw Object.assign(new Error("webhook response not ok"), { httpStatus: res.status });
      }
    } catch (e) {
      // Bewusst ohne Fremd-Message, ohne URL: nur Status/Klasse nennen — die
      // Webhook-URL ist selbst ein Credential (z. B. Slack-Incoming-Webhook).
      const httpStatus = (e as { httpStatus?: unknown }).httpStatus;
      if (typeof httpStatus === "number") throw new Error(`webhook: HTTP ${httpStatus}`);
      const name = e instanceof Error ? e.name : "Error";
      throw new Error(`webhook: Versand fehlgeschlagen (${sanitizeLogField(name, 40)})`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Liest die Webhook-URL aus dem verschlüsselten Secret-Store der Control
 * Plane. Der Name wird wie eine Venue-ID behandelt (`^[A-Z0-9_-]{1,32}$`) —
 * die URL liegt im Feld `apiKey` der Credential-Struktur (das `apiSecret`
 * bleibt leer/Platzhalter). Fehler des Stores werden geworfen (Aufrufer
 * meldet sie als Sink-Fehler), **kein** Env-Fallback.
 */
export async function resolveAlertWebhookUrlFromSecretStore(name: string): Promise<string | null> {
  const key = String(name ?? "").trim().toUpperCase();
  if (!key) return null;
  const { getControlPlaneSecretStore } = await import("@/brokers/control-plane/secretStore");
  const store = await getControlPlaneSecretStore();
  const credential = await store.get(key);
  const url = credential?.apiKey?.trim();
  return url && url.length > 0 ? url : null;
}

/** Meta auf redigierte, gekürzte, einzeilige Werte begrenzen (Flut-Schutz). */
function sanitizeMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!meta) return out;
  for (const [key, value] of Object.entries(meta).slice(0, ALERT_META_KEYS_MAX)) {
    const safeKey = sanitizeLogField(key, 40);
    if (!safeKey) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[safeKey] = value;
    else if (typeof value === "boolean") out[safeKey] = value;
    else if (value !== null && value !== undefined) out[safeKey] = sanitizeLogField(value);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher + Prozess-Singleton
// ─────────────────────────────────────────────────────────────────────────────

export interface AlertDispatchResult {
  /** true = an alle Senken übergeben (mindestens eine ohne Fehler). */
  sent: boolean;
  /** true = wegen Debounce unterdrückt. */
  suppressed: boolean;
  /** Wie viele identische Alerts im Fenster unterdrückt wurden (beim Senden). */
  suppressedSinceLast: number;
  /** Anzahl beteiligter Senken. */
  sinks: number;
  /** Redigierte Fehler einzelner Senken (leer = alles ok). */
  errors: string[];
}

/**
 * Leitet Alerts an alle Senken weiter — dedupliziert, fail-soft und niemals
 * werfend. Ein Alert darf den Monitor-Tick oder einen Request nie abbrechen.
 */
export class AlertDispatcher {
  private readonly debounce: AlertDebounce;

  constructor(
    private readonly sinks: AlertSink[],
    opts: { debounceMinutes?: number; now?: () => number } = {},
  ) {
    const minutes = Number(opts.debounceMinutes ?? ALERT_DEFAULTS.debounceMinutes);
    const bounded = Number.isFinite(minutes)
      ? Math.min(Math.max(minutes, ALERT_DEBOUNCE_BOUNDS.min), ALERT_DEBOUNCE_BOUNDS.max)
      : ALERT_DEFAULTS.debounceMinutes;
    this.debounce = new AlertDebounce(bounded * 60_000, opts.now ?? Date.now);
  }

  async emit(alert: Alert): Promise<AlertDispatchResult> {
    const code = String(alert.code ?? "").trim() || "UNKNOWN";
    const decision = this.debounce.check(code);
    if (!decision.send) {
      return { sent: false, suppressed: true, suppressedSinceLast: 0, sinks: this.sinks.length, errors: [] };
    }

    const at = alert.at ?? new Date().toISOString();
    const meta = { ...(alert.meta ?? {}) };
    if (decision.suppressedSinceLast > 0) meta.suppressedSinceLast = decision.suppressedSinceLast;
    const enriched: Alert = { ...alert, code, at, meta };

    const errors: string[] = [];
    let delivered = 0;
    for (const sink of this.sinks) {
      try {
        await sink.send(enriched);
        delivered++;
      } catch (e) {
        const message = `${sink.constructor?.name ?? "AlertSink"}: ${publicErrorMessage(e, "Versand fehlgeschlagen")}`;
        errors.push(message);
        structuredLog("warn", "alert_sink_failed", { code, sink: sink.constructor?.name ?? "AlertSink", error: message });
      }
    }
    return {
      sent: delivered > 0 || this.sinks.length === 0,
      suppressed: false,
      suppressedSinceLast: decision.suppressedSinceLast,
      sinks: this.sinks.length,
      errors,
    };
  }

  /** Nur für Tests: Debounce-Zustand leeren. */
  resetDebounce(): void {
    this.debounce.reset();
  }
}

const GLOBAL = globalThis as typeof globalThis & {
  __alertDispatcher?: AlertDispatcher;
};

/** Baut den Prozess-Dispatcher aus der Env-Konfiguration. */
function buildDefaultDispatcher(): AlertDispatcher {
  const config = loadAlertConfig();
  const sinks: AlertSink[] = [new LogAlertSink(), new FileAlertSink()];
  if (config.webhookSecretName) {
    sinks.push(
      new WebhookAlertSink({
        resolveUrl: () => resolveAlertWebhookUrlFromSecretStore(config.webhookSecretName),
      }),
    );
  }
  return new AlertDispatcher(sinks, { debounceMinutes: config.debounceMinutes });
}

/** Prozess-Singleton des Alert-Dispatchers (HMR-sicher über globalThis). */
export function getAlertDispatcher(): AlertDispatcher {
  if (!GLOBAL.__alertDispatcher) GLOBAL.__alertDispatcher = buildDefaultDispatcher();
  return GLOBAL.__alertDispatcher;
}

/** Nur für Tests: Dispatcher ersetzen (`null` = Default neu bauen). */
export function setAlertDispatcherForTests(next: AlertDispatcher | null): void {
  GLOBAL.__alertDispatcher = next ?? undefined;
}

/** Nur für Tests: Debounce-Zustand + Sink-Auswahl zurücksetzen. */
export function resetAlertStateForTests(): void {
  GLOBAL.__alertDispatcher = undefined;
}

/** Bequemer Einstiegspunkt: Alert über den Prozess-Dispatcher melden. */
export function emitAlert(alert: Alert): Promise<AlertDispatchResult> {
  return getAlertDispatcher().emit(alert);
}
