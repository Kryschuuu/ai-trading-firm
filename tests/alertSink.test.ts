/**
 * GAP-10 (v1.45.0) — Alert-Adapter (D3).
 *
 * Abnahmekriterien aus
 * docs/audits/2026-09-18-feature-gap/findings/GAP-10-observability-circuit-breaker.md:
 *
 *   - Debounce: ein identischer `alert.code` wird innerhalb von
 *     `ALERT_DEBOUNCE_MINUTES` maximal EINMAL versendet; unterdrückte Alarme
 *     werden gezählt und beim nächsten Versand ausgewiesen (Alert-Fatigue).
 *   - FileAlertSink schreibt NDJSON über `resolveRuntimePath` (CLI und Server
 *     sehen dieselbe Datei), redigiert und mit Modus 0600.
 *   - Webhook-Sink liest die URL aus dem Secret-Store (Mock) und wird ohne
 *     Credential still übersprungen; die URL erscheint NIE in Fehlern/Logs.
 *   - Ein Sink-Fehler bricht nichts ab (Dispatcher wirft nie).
 *
 * Deterministisch: Debounce läuft mit injizierter Uhr, Datei-Tests schreiben in
 * ein temporäres Verzeichnis unterhalb des Projektstamms (Aufräumen im Test).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import {
  ALERT_DEBOUNCE_BOUNDS,
  ALERT_DEFAULTS,
  AlertDispatcher,
  FileAlertSink,
  LogAlertSink,
  WebhookAlertSink,
  alertFilePath,
  loadAlertConfig,
  resolveAlertWebhookUrlFromSecretStore,
  type Alert,
  type AlertSink,
} from "../src/lib/alerts";
import { setStructuredLogSinkForTests, type StructuredLogEntry } from "../src/lib/logger";
import { setControlPlaneSecretStoreForTests } from "../src/brokers/control-plane/secretStore";

const TMP_DIRS: string[] = [];

function tmpDir(): string {
  // Relativer Pfad unterhalb des Projektstamms → `resolveRuntimePath` greift
  // wie im Produktivpfad (kein absoluter Sonderweg im Test).
  const dir = mkdtempSync(path.join(process.cwd(), ".tmp-alerts-"));
  TMP_DIRS.push(dir);
  return dir;
}

function captureSink(): { sink: AlertSink; alerts: Alert[] } {
  const alerts: Alert[] = [];
  return {
    sink: { send: (alert: Alert) => void alerts.push(alert) },
    alerts,
  };
}

beforeEach(() => {
  setStructuredLogSinkForTests(() => {});
});

afterEach(() => {
  setStructuredLogSinkForTests(null);
  setControlPlaneSecretStoreForTests(null);
  while (TMP_DIRS.length > 0) {
    const dir = TMP_DIRS.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D3: Debounce unterdrückt identische Codes im Fenster und meldet die Anzahl", async () => {
  const { sink, alerts } = captureSink();
  let now = Date.UTC(2026, 8, 18, 12, 0, 0);
  const dispatcher = new AlertDispatcher([sink], { debounceMinutes: 30, now: () => now });

  const first = await dispatcher.emit({ code: "circuit-breaker:drawdown", severity: "critical", message: "Brecher" });
  assert.equal(first.sent, true);
  assert.equal(first.suppressed, false);
  assert.equal(alerts.length, 1);

  // Zweites IDENTISCHES Event im Fenster → unterdrückt.
  const second = await dispatcher.emit({ code: "circuit-breaker:drawdown", severity: "critical", message: "Brecher" });
  assert.equal(second.sent, false);
  assert.equal(second.suppressed, true);
  assert.equal(alerts.length, 1, "unterdrückter Alert darf keine Senke erreichen");

  // 10 Minuten später: immer noch im 30-Minuten-Fenster.
  now += 10 * 60_000;
  assert.equal((await dispatcher.emit({ code: "circuit-breaker:drawdown", severity: "critical", message: "Brecher" })).suppressed, true);
  assert.equal(alerts.length, 1);

  // Ein ANDERER Code ist vom Debounce unberührt.
  await dispatcher.emit({ code: "heartbeat-stale", severity: "critical", message: "Tick tot" });
  assert.equal(alerts.length, 2);

  // Nach Ablauf des Fensters geht wieder ein Alert raus — mit Zähler.
  now += 31 * 60_000;
  const after = await dispatcher.emit({ code: "circuit-breaker:drawdown", severity: "critical", message: "Brecher" });
  assert.equal(after.sent, true);
  assert.equal(after.suppressedSinceLast, 2, "2 unterdrückte Alarme müssen ausgewiesen werden");
  assert.equal(alerts.length, 3);
  assert.equal(alerts[2].meta?.suppressedSinceLast, 2);
});

test("D3: Sink-Fehler werden gesammelt, nie geworfen", async () => {
  const ok = captureSink();
  const failing: AlertSink = {
    send() {
      throw new Error("Festplatte voll");
    },
  };
  const dispatcher = new AlertDispatcher([failing, ok.sink], { debounceMinutes: 1 });
  const result = await dispatcher.emit({ code: "test:sink", severity: "warning", message: "x" });
  assert.equal(result.sent, true, "der gesunde Sink hat den Alert gesehen");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Festplatte voll/);
  assert.equal(ok.alerts.length, 1);
});

test("D3: LogAlertSink nutzt strukturierte Logs mit Redaktion", () => {
  const entries: StructuredLogEntry[] = [];
  setStructuredLogSinkForTests((entry) => entries.push(entry));
  new LogAlertSink().send({
    code: "circuit-breaker:drawdown",
    severity: "critical",
    message: "Brecher: sk-live-SECRET-MARKER",
    meta: { metric: "drawdown", value: 0.2 },
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, "critical");
  assert.equal(entries[0].event, "alert");
  assert.equal(entries[0].fields.code, "circuit-breaker:drawdown");
  assert.match(String(entries[0].fields.message), /\[REDACTED\]/);
  assert.ok(!JSON.stringify(entries[0]).includes("SECRET-MARKER"));
});

test("D3: FileAlertSink schreibt NDJSON über resolveRuntimePath (0600, redigiert)", () => {
  const dir = tmpDir();
  const file = path.join(dir, "alerts.ndjson");
  const sink = new FileAlertSink(file);
  sink.send({ code: "heartbeat-stale", severity: "critical", message: "Tick tot", meta: { ageMs: 900_000 } });
  sink.send({
    code: "circuit-breaker:dailyLoss",
    severity: "critical",
    message: "Tagesverlust — Token sk-live-SECRET-MARKER",
    meta: { value: 0.06, token: "sk-live-SECRET-MARKER" },
  });

  assert.ok(existsSync(file), "Alert-Datei muss existieren");
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "ein Alert = eine NDJSON-Zeile");
  const first = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(first.code, "heartbeat-stale");
  assert.equal(first.severity, "critical");
  assert.equal(first.ageMs, 900_000);
  const second = JSON.parse(lines[1]) as Record<string, unknown>;
  assert.ok(!lines[1].includes("SECRET-MARKER"), "Secrets sind redigiert");
  assert.equal(second.value, 0.06);
  // Modus 0600 (nur Eigentümer) — wie die übrigen Sicherheits-Ablagen.
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("D3: Webhook-Sink liest die URL aus dem Secret-Store (Mock) und postet sie", async () => {
  const seen: { url: string; body: unknown }[] = [];
  setControlPlaneSecretStoreForTests({
    put: async () => {},
    delete: async () => false,
    exists: async () => true,
    get: async (name: string) => (name === "ALERT_WEBHOOK_URL" ? { apiKey: "https://hooks.example.test/T/B", apiSecret: "" } : null),
  });

  const url = await resolveAlertWebhookUrlFromSecretStore("ALERT_WEBHOOK_URL");
  assert.equal(url, "https://hooks.example.test/T/B");

  const sink = new WebhookAlertSink({
    resolveUrl: () => resolveAlertWebhookUrlFromSecretStore("ALERT_WEBHOOK_URL"),
    fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("", { status: 200 });
    }) as typeof fetch,
  });
  await sink.send({ code: "circuit-breaker:drawdown", severity: "critical", message: "Brecher", meta: { value: 0.2 } });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://hooks.example.test/T/B");
  assert.equal((seen[0].body as Record<string, unknown>).code, "circuit-breaker:drawdown");
});

test("D3: Webhook ohne Credential ist still, Fehler nennen die URL nie", async () => {
  setControlPlaneSecretStoreForTests({
    put: async () => {},
    delete: async () => false,
    exists: async () => false,
    get: async () => null,
  });
  const silent = new WebhookAlertSink({
    resolveUrl: () => resolveAlertWebhookUrlFromSecretStore("ALERT_WEBHOOK_URL"),
    fetchFn: (async () => {
      throw new Error("darf nicht aufgerufen werden");
    }) as typeof fetch,
  });
  await silent.send({ code: "x", severity: "info", message: "y" }); // kein Wurf = Senke aus

  setControlPlaneSecretStoreForTests({
    put: async () => {},
    delete: async () => false,
    exists: async () => true,
    get: async () => ({ apiKey: "https://hooks.example.test/TOKEN-SECRET", apiSecret: "" }),
  });
  const failing = new WebhookAlertSink({
    resolveUrl: () => resolveAlertWebhookUrlFromSecretStore("ALERT_WEBHOOK_URL"),
    fetchFn: (async () => new Response("nope", { status: 500 })) as typeof fetch,
  });
  await assert.rejects(
    () => failing.send({ code: "x", severity: "critical", message: "y" }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /HTTP 500/);
      assert.ok(!message.includes("TOKEN-SECRET"), "die Webhook-URL ist ein Credential und darf nie im Fehler stehen");
      return true;
    },
  );
});

test("D3: Konfiguration — Default 30 min, Bounds [1, 1440], Webhook default aus", () => {
  const defaults = loadAlertConfig({});
  assert.equal(defaults.debounceMinutes, ALERT_DEFAULTS.debounceMinutes);
  assert.equal(defaults.debounceMinutes, 30);
  assert.deepEqual(ALERT_DEBOUNCE_BOUNDS, { min: 1, max: 1440 });
  assert.equal(defaults.webhookSecretName, "", "Webhook ist per Default aus");

  // Clamp mit Warnung (fail-loud, siehe envNumber).
  assert.equal(loadAlertConfig({ ALERT_DEBOUNCE_MINUTES: "0" }).debounceMinutes, 1);
  assert.equal(loadAlertConfig({ ALERT_DEBOUNCE_MINUTES: "5000" }).debounceMinutes, 1440);
  assert.equal(loadAlertConfig({ ALERT_DEBOUNCE_MINUTES: "abc" }).debounceMinutes, 30);

  // Secret-Name: nur das Format des Secret-Stores; ungültig → aus (fail-closed).
  assert.equal(loadAlertConfig({ ALERT_WEBHOOK_URL_SECRET_NAME: "alert_webhook_url" }).webhookSecretName, "ALERT_WEBHOOK_URL");
  assert.equal(loadAlertConfig({ ALERT_WEBHOOK_URL_SECRET_NAME: "https://hooks.example.test/x" }).webhookSecretName, "");
  assert.equal(loadAlertConfig({ ALERT_WEBHOOK_URL_SECRET_NAME: "a".repeat(33) }).webhookSecretName, "");
});

test("D3: Alert-Datei liegt relativ im Projektstamm (CLI == Server)", () => {
  const file = alertFilePath({});
  assert.equal(file, path.join(process.cwd(), "data", "alerts.ndjson"));
  assert.ok(alertFilePath({ ALERT_FILE: "data/custom.ndjson" }).endsWith(path.join("data", "custom.ndjson")));
  // `..`-Ausbruch fällt auf die sichere Default-Ablage zurück.
  assert.equal(alertFilePath({ ALERT_FILE: "../../etc/passwd" }), path.join(process.cwd(), "data", "alerts.ndjson"));
});
