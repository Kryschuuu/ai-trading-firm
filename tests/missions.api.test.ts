/**
 * API-Contract-Tests von `/api/firm/missions` (v1.35.0).
 *
 * Direkt gegen die Route-Handler, ohne Netzwerk. Geprüft wird der Teil des
 * Vertrags, der **vor** der Datenbank entscheidet — also genau die Schicht, in
 * der Vorlage (`applyMissionTemplate`) und Validierung (`validateMissionInput`)
 * zusammenlaufen:
 *
 *   * POST aus einer Vorlage heraus (`{ "templateId": "scan-all-markets" }`)
 *     wird vollständig ausgefüllt und erst danach validiert,
 *   * fehlerhafte Kombinationen (Scan + Symbol, Scan ohne Segment, unbekannter
 *     Missions-Typ, Budget außerhalb der Code-Deckel) liefern 400 mit einer
 *     handlungsleitenden Meldung,
 *   * PUT verlangt eine UUID,
 *   * GET degradiert bei nicht erreichbarer Datenbank auf 503 **ohne**
 *     Connection-String in der Antwort (Redaction).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { GET, POST, PUT } from "../src/app/api/firm/missions/route";
import { MISSION_TEMPLATE_IDS } from "../src/lib/missionTemplates";

const BASE = "http://localhost:3369";

function request(method: "POST" | "PUT", body: unknown, raw?: string): Request {
  return new Request(`${BASE}/api/firm/missions`, {
    method,
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ── POST: Vorlagen-Pfad ──────────────────────────────────────────────────────

test("POST: unbekannte Vorlage wird mit 400 und Alternativen abgelehnt", async () => {
  const res = await POST(request("POST", { templateId: "gibt-es-nicht" }));
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.ok, false);
  assert.match(String(body.error), /Vorlage/);
  assert.match(String(body.error), /scan-all-markets/, "die Antwort nennt verfügbare Vorlagen");
});

test("POST: unvollständige Eingabe wird auch mit Vorlage geprüft", async () => {
  // Vorlage füllt Titel/Ziel/Typ, aber das Budget bleibt außerhalb der Deckel:
  const res = await POST(
    request("POST", { templateId: "indices-trend-follow", riskBudget: 0.9, maxPositionPct: 0.2 })
  );
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.match(String(body.error), /Risikobudget/);
});

test("POST: Scan-Mission mit Symbol ist ein Bedienfehler (400)", async () => {
  const res = await POST(
    request("POST", {
      title: "Indizes-Scan",
      objective: "Nur Long auf Indizes, höchstens 2 Setups pro Tag, Stop 4–7 %, sonst HOLD.",
      scope: "SCAN_UNIVERSE",
      segment: "INDICES",
      symbol: "SPY",
      riskBudget: 0.01,
      maxPositionPct: 0.15,
    })
  );
  assert.equal(res.status, 400);
  assert.match(String((await json(res)).error), /kein Einzel-Symbol/);
});

test("POST: Scan-Mission ohne Segment nennt die erlaubten Segmente", async () => {
  const res = await POST(
    request("POST", {
      title: "Alle Märkte scannen",
      objective: "Scanne alle Märkte, höchstens 3 Setups pro Tag, Stop 3–8 %, sonst HOLD.",
      scope: "SCAN_UNIVERSE",
      riskBudget: 0.01,
      maxPositionPct: 0.1,
    })
  );
  assert.equal(res.status, 400);
  const error = String((await json(res)).error);
  assert.match(error, /Segment/);
  assert.match(error, /PENNY/);
  assert.match(error, /INDICES/);
});

test("POST: unbekannter Missions-Typ und kaputtes JSON werden abgelehnt", async () => {
  const badScope = await POST(
    request("POST", {
      title: "Quatsch-Typ",
      objective: "Irgendein Auftrag mit mindestens zehn Zeichen Inhalt.",
      scope: "ALLES",
      symbol: "BTC",
      riskBudget: 0.01,
      maxPositionPct: 0.1,
    })
  );
  assert.equal(badScope.status, 400);
  assert.match(String((await json(badScope)).error), /Missions-Typ/);

  const broken = await POST(request("POST", undefined, "{kein json"));
  assert.equal(broken.status, 400);
  assert.match(String((await json(broken)).error), /Ungültiges JSON/);
});

test("POST: Einzel-Symbol außerhalb der Paper-Broker-Liste wird abgelehnt", async () => {
  const res = await POST(
    request("POST", {
      title: "Unbekanntes Symbol",
      objective: "Nur Long, Stop 5 %, bei Unsicherheit HOLD antworten.",
      symbol: "TSLA",
      riskBudget: 0.01,
      maxPositionPct: 0.1,
    })
  );
  assert.equal(res.status, 400);
  const error = String((await json(res)).error);
  assert.match(error, /TSLA/);
  assert.match(error, /Markt-Scan/, "die Antwort weist auf den alternativen Missions-Typ hin");
});

// ── PUT ──────────────────────────────────────────────────────────────────────

test("PUT: fehlende oder ungültige ID wird vor der Datenbank abgewiesen", async () => {
  const noId = await PUT(
    request("PUT", {
      title: "Ohne ID",
      objective: "Nur Long, Stop 5 %, bei Unsicherheit HOLD antworten.",
      symbol: "BTC",
      riskBudget: 0.01,
      maxPositionPct: 0.1,
    })
  );
  assert.equal(noId.status, 400);
  assert.match(String((await json(noId)).error), /UUID/);

  const injection = await PUT(
    request("PUT", {
      id: "'; DROP TABLE missions;--",
      title: "Injection",
      objective: "Nur Long, Stop 5 %, bei Unsicherheit HOLD antworten.",
      symbol: "BTC",
      riskBudget: 0.01,
      maxPositionPct: 0.1,
    })
  );
  assert.equal(injection.status, 400);
});

// ── GET ──────────────────────────────────────────────────────────────────────

test("GET: ohne Datenbank 503 mit redaktierter Meldung (kein Connection-String)", async () => {
  const res = await GET();
  // In der Testumgebung läuft kein PostgreSQL → sauberer 503 statt Crash.
  assert.equal(res.status, 503);
  const body = await json(res);
  assert.equal(body.ok, false);
  const error = String(body.error);
  assert.match(error, /Datenbank nicht lesbar/);
  assert.equal(error.includes("postgresql://"), false, "Connection-String darf nicht durchsickern");
  assert.equal(error.includes("test:test"), false, "Credentials dürfen nicht durchsickern");
});

// ── Katalog-Konsistenz der API-Quelle ────────────────────────────────────────

test("Katalog: die API liefert dieselben Vorlagen wie der Seed-Katalog", async () => {
  // Die Route liest MISSION_TEMPLATES direkt — dieser Test sichert, dass die
  // exportierte Liste die erwarteten Einstiegs-IDs enthält (UI + Doku verweisen
  // darauf).
  for (const id of ["paper-btc-long-only", "scan-all-markets", "indices-trend-follow", "penny-desk-mini"]) {
    assert.ok(MISSION_TEMPLATE_IDS.includes(id), `${id} fehlt im Katalog`);
  }
  assert.ok(MISSION_TEMPLATE_IDS.length >= 14, "Katalog muss mindestens die 14 Standard-Missionen enthalten");
});
