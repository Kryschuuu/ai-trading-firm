/**
 * Trade-PnL-Attribution — API-Vertragstests (RMA-P1-06, v1.57.0).
 *
 * Prüft die HTTP-Verträge der beiden Attribution-Routen ohne Datenbank:
 * Eingabevalidierung (400), geschlossene Parametermengen, Deklarationsfeld
 * (DETERMINISTIC_ALLOCATION — keine Kausalanalyse) und das SEC-02-Muster
 * (`firm.read`, `no-store`). DB-gestützte Pfade deckt
 * `tests/tradeAttribution.db.test.ts` ab.
 *
 * Auth-Verhalten: Ohne Session/Token antwortet `requirePermission` mit
 * 401 — die Validierung der Parameter läuft DAVOR, deshalb sind die
 * 400-Fälle ohne Credentials prüfbar (gleiche Reihenfolge wie die Route).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { GET as listGet } from "../src/app/api/firm/journal/attributions/route";
import { GET as aggregateGet } from "../src/app/api/firm/journal/attributions/aggregate/route";
import { ATTRIBUTION_DECLARATION } from "../src/attribution/types";

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

test("API GET /api/firm/journal/attributions — Parameter-Validierung", async () => {
  const base = "http://localhost/api/firm/journal/attributions";

  const invalidCases: Array<[string, string, string]> = [
    [`?status=FREITEXT`, "INVALID_STATUS", "geschlossene Status-Menge"],
    [`?methodVersion=0`, "INVALID_METHOD_VERSION", "Methodenversion ≥ 1"],
    [`?limit=0`, "INVALID_LIMIT", "limit ≥ 1"],
    [`?limit=abc`, "INVALID_LIMIT", "limit numerisch"],
    [`?limit=201`, "INVALID_LIMIT", "limit ≤ 200 (hart geklemmte Obergrenze)"],
    [`?from=gestern`, "INVALID_DATE", "ISO-Datum from"],
    [`?to=morgen`, "INVALID_DATE", "ISO-Datum to"],
  ];
  for (const [query, error, why] of invalidCases) {
    const res = await listGet(new Request(base + query));
    assert.equal(res.status, 400, `${query} ⇒ 400 (${why})`);
    assert.equal((await json(res)).error, error);
  }

  // Grenzwertige, GÜLTIGE Parameter laufen in den Auth-/DB-Pfad (401 ohne
  // Session bzw. 503 ohne DB) — niemals 400.
  const valid = await listGet(new Request(base + "?limit=200&status=ATTRIBUTED&methodVersion=1&entries=true"));
  assert.notEqual(valid.status, 400, "gültige Parameter werden nicht mit 400 abgelehnt");
});

test("API GET /api/firm/journal/attributions/aggregate — Dimension & Validierung", async () => {
  const base = "http://localhost/api/firm/journal/attributions/aggregate";

  const res = await aggregateGet(new Request(base + "?dimension=shapley"));
  assert.equal(res.status, 400);
  assert.equal((await json(res)).error, "INVALID_DIMENSION");

  for (const [query, error] of [
    ["?methodVersion=-1", "INVALID_METHOD_VERSION"],
    ["?from=2026-13-99", "INVALID_DATE"],
    ["?to=nie", "INVALID_DATE"],
  ] as Array<[string, string]>) {
    const r = await aggregateGet(new Request(base + query));
    assert.equal(r.status, 400, `${query} ⇒ 400`);
    assert.equal((await json(r)).error, error);
  }

  // Alle vier Dimensionen sind erlaubt (Kein 400).
  for (const dimension of ["agent", "rule", "regime", "cost"]) {
    const r = await aggregateGet(new Request(`${base}?dimension=${dimension}`));
    assert.notEqual(r.status, 400, `dimension=${dimension} ist erlaubt`);
  }
  // Default-Dimension (agent) ist erlaubt.
  const r = await aggregateGet(new Request(base));
  assert.notEqual(r.status, 400);
});

test("API: Deklaration DETERMINISTIC_ALLOCATION ist im Quellcode verankert (kein Kausalitätsversprechen)", async () => {
  // Die Deklaration wird in jeder Antwort, jedem Audit und jeder persistierten
  // Zeile mitgeführt — hier als Vertragsanker gegen Typos getestet.
  assert.equal(ATTRIBUTION_DECLARATION, "DETERMINISTIC_ALLOCATION");
  assert.match(ATTRIBUTION_DECLARATION, /^DETERMINISTIC_ALLOCATION$/);
});

test("API: no-store auf 400-Antworten (SEC-02-Muster)", async () => {
  const res = await listGet(new Request("http://localhost/api/firm/journal/attributions?limit=0"));
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  const agg = await aggregateGet(
    new Request("http://localhost/api/firm/journal/attributions/aggregate?dimension=x")
  );
  assert.match(agg.headers.get("cache-control") ?? "", /no-store/);
});
