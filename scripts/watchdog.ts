/**
 * `npm run watchdog` — Heartbeat-Wächter (GAP-10, D4, v1.45.0).
 *
 * ALARM-FIRST, bewusst KEIN Daemon: Das Skript prüft GENAU EINMAL den
 * Gesundheitszustand der Firma und beendet sich. Der Aufruf gehört in einen
 * systemd-Timer / Cron (z. B. alle 5 Minuten) — ein Wächter, der selbst als
 * Daemon läuft, wäre ein zweiter Single Point of Failure (so steht es auch im
 * GAP-10-Befund).
 *
 *   npm run watchdog                                     # http://127.0.0.1:$PORT/api/health
 *   npm run watchdog -- --url=http://host:3369/api/health
 *   npm run watchdog -- --source=inprocess               # lastTickAt im eigenen Prozess
 *   npm run watchdog -- --timeout-ms=3000
 *
 * Regeln:
 *   - Alarm wird über den Alert-Adapter (AlertSink, D3) gemeldet — Log-Senke
 *     plus Datei `data/alerts.ndjson` (Debounce schützt vor Alert-Fatigue).
 *   - KEIN Auto-Restart, kein Kill, keine Mutation. Der Wächter beobachtet
 *     nur; Wiederanlauf ist eine bewusste Operator-Entscheidung.
 *   - Exit-Code 0 = gesund, 1 = Alarm (stale/nicht erreichbar), 2 = Bedienfehler.
 *   - Es werden nie Secrets geloggt (URL nur hostname-frei als Quelle).
 *
 * Doku: docs/OPERATIONS.md („Auto-Breaker hat ausgelöst“, Heartbeat),
 * docs/OBSERVABILITY.md (Heartbeat-Metriken/-Felder).
 */
import { readHeartbeat } from "../src/lib/heartbeat";
import { emitAlert } from "../src/lib/alerts";

const args = process.argv.slice(2);

function arg(name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
}

/** Reduziert eine URL auf den Host für Logs (keine Query/Secrets). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unbekannt";
  }
}

async function main(): Promise<void> {
  const source = (arg("source") ?? "http").toLowerCase();
  const timeoutMs = Number(arg("timeout-ms") ?? process.env.WATCHDOG_TIMEOUT_MS ?? "5000");
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;

  if (source === "inprocess") {
    // Nur sinnvoll im selben Prozess (z. B. Test/Timer mit tsx im Server-Graph);
    // ein separater Prozess hat seinen EIGENEN RAM-Heartbeat (dann HTTP nutzen).
    const hb = readHeartbeat();
    if (hb.stale) {
      const result = await emitAlert({
        code: "heartbeat-stale",
        severity: "critical",
        message:
          hb.monitorLastTickAt === null
            ? "Watchdog: Monitor-Tick hat noch nie gelaufen (in-process)."
            : `Watchdog: Monitor-Tick ist überfällig (${Math.round((hb.monitorAgeMs ?? 0) / 1000)} s > ${Math.round(hb.staleAfterMs / 1000)} s).`,
        meta: {
          source: "inprocess",
          monitorLastTickAt: hb.monitorLastTickAt ?? "never",
          monitorAgeMs: hb.monitorAgeMs,
          staleAfterMs: hb.staleAfterMs,
        },
      });
      console.log(`[watchdog] ALARM heartbeat-stale (Alert: sent=${result.sent}, suppressed=${result.suppressed})`);
      process.exitCode = 1;
      return;
    }
    console.log(`[watchdog] ok — letzter Tick ${hb.monitorLastTickAt}`);
    return;
  }

  if (source !== "http") {
    console.error(`[watchdog] unbekannte Quelle "${source}" (erlaubt: http, inprocess)`);
    process.exitCode = 2;
    return;
  }

  const url = arg("url") ?? process.env.WATCHDOG_HEALTH_URL ?? `http://127.0.0.1:${process.env.PORT || 3369}/api/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
  } catch (e) {
    clearTimeout(timer);
    const reason = e instanceof Error ? e.name : "Error";
    const result = await emitAlert({
      code: "heartbeat-health-unreachable",
      severity: "critical",
      message: `Watchdog: /api/health nicht erreichbar (${reason}) — Prozess prüfen, KEIN Auto-Restart.`,
      meta: { source: "http", host: hostOf(url) },
    });
    console.log(`[watchdog] ALARM heartbeat-health-unreachable (Alert: sent=${result.sent}, suppressed=${result.suppressed})`);
    process.exitCode = 1;
    return;
  }
  clearTimeout(timer);

  if (!res.ok) {
    const result = await emitAlert({
      code: "heartbeat-health-unreachable",
      severity: "critical",
      message: `Watchdog: /api/health antwortet mit HTTP ${res.status} — Prozess/Proxy prüfen.`,
      meta: { source: "http", host: hostOf(url), httpStatus: res.status },
    });
    console.log(`[watchdog] ALARM heartbeat-health-unreachable (HTTP ${res.status}; Alert: sent=${result.sent})`);
    process.exitCode = 1;
    return;
  }

  const payload = (await res.json().catch(() => null)) as
    | { stale?: unknown; monitorLastTickAt?: unknown; monitorAgeMs?: unknown; staleAfterMs?: unknown }
    | null;
  if (!payload) {
    const result = await emitAlert({
      code: "heartbeat-health-unreadable",
      severity: "warning",
      message: "Watchdog: /api/health liefert kein lesbares JSON.",
      meta: { source: "http", host: hostOf(url) },
    });
    console.log(`[watchdog] ALARM heartbeat-health-unreadable (Alert: sent=${result.sent})`);
    process.exitCode = 1;
    return;
  }

  if (payload.stale === true) {
    const ageMs = typeof payload.monitorAgeMs === "number" ? payload.monitorAgeMs : null;
    const staleAfterMs = typeof payload.staleAfterMs === "number" ? payload.staleAfterMs : null;
    const result = await emitAlert({
      code: "heartbeat-stale",
      severity: "critical",
      message:
        payload.monitorLastTickAt == null
          ? "Watchdog: Monitor-Tick hat noch nie gelaufen."
          : `Watchdog: Monitor-Tick ist überfällig (${Math.round((ageMs ?? 0) / 1000)} s > ${Math.round((staleAfterMs ?? 0) / 1000)} s).`,
      meta: {
        source: "http",
        host: hostOf(url),
        monitorLastTickAt: typeof payload.monitorLastTickAt === "string" ? payload.monitorLastTickAt : "never",
        monitorAgeMs: ageMs,
        staleAfterMs,
      },
    });
    console.log(`[watchdog] ALARM heartbeat-stale (Alert: sent=${result.sent}, suppressed=${result.suppressed})`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `[watchdog] ok — letzter Tick ${String(payload.monitorLastTickAt ?? "unbekannt")} (Alter ${Math.round((typeof payload.monitorAgeMs === "number" ? payload.monitorAgeMs : 0) / 1000)} s)`,
  );
}

main().catch(async (e) => {
  // Ein Fehler im Wächter selbst ist ein Alarm, kein stiller Exit.
  console.error(`[watchdog] unerwarteter Fehler: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
});
