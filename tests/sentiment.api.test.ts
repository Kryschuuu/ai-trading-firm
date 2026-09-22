/**
 * Tests: Kalibrierbare strukturierte Sentiment-Outputs — API Route Tests (RMA-P2-05).
 *
 * Prüft den Endpunkt `GET /api/analysis/sentiment`:
 *   - 200 OK mit strukturierter JSON-Antwort
 *   - Strikte 400-Validierung aller Query-Parameter (entityId, status, horizon, limit, from, to)
 *   - Cache-Control: no-store Header (SEC-02-Muster)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GET } from "../src/app/api/analysis/sentiment/route";

function makeRequest(url: string): Request {
  return new Request(url, {
    method: "GET",
    headers: {
      "User-Agent": "test-agent",
    },
  });
}

describe("GET /api/analysis/sentiment", () => {
  it("antwortet mit Cache-Control: no-store", async () => {
    const req = makeRequest("https://localhost/api/analysis/sentiment?limit=10");
    const res = await GET(req);
    assert.equal(res.status, 200);
    const cacheHeader = res.headers.get("Cache-Control");
    assert.ok(cacheHeader?.includes("no-store"), "Antwort muss no-store tragen");
  });

  it("akzeptiert gültige Filterparameter und liefert 200 mit forecasts[]", async () => {
    const req = makeRequest("https://localhost/api/analysis/sentiment?entityId=BINANCE:BTCUSDT&status=ACTIVE&horizon=24h&limit=5");
    const res = await GET(req);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.count, "number");
    assert.ok(Array.isArray(body.forecasts));
  });

  it("lehnt ungültigen status mit 400 INVALID_STATUS ab", async () => {
    const req = makeRequest("https://localhost/api/analysis/sentiment?status=UNKNOWN");
    const res = await GET(req);
    assert.equal(res.status, 400);

    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "INVALID_STATUS");
  });

  it("lehnt ungültigen horizon mit 400 INVALID_HORIZON ab", async () => {
    const req = makeRequest("https://localhost/api/analysis/sentiment?horizon=12h");
    const res = await GET(req);
    assert.equal(res.status, 400);

    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "INVALID_HORIZON");
  });

  it("lehnt limit außerhalb [1, 200] mit 400 INVALID_LIMIT ab", async () => {
    const reqLow = makeRequest("https://localhost/api/analysis/sentiment?limit=0");
    const resLow = await GET(reqLow);
    assert.equal(resLow.status, 400);

    const reqHigh = makeRequest("https://localhost/api/analysis/sentiment?limit=201");
    const resHigh = await GET(reqHigh);
    assert.equal(resHigh.status, 400);

    const reqNan = makeRequest("https://localhost/api/analysis/sentiment?limit=abc");
    const resNan = await GET(reqNan);
    assert.equal(resNan.status, 400);
  });

  it("lehnt ungültiges Datum mit 400 INVALID_DATE ab", async () => {
    const req = makeRequest("https://localhost/api/analysis/sentiment?from=not-a-date");
    const res = await GET(req);
    assert.equal(res.status, 400);

    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "INVALID_DATE");
  });

  it("lehnt überlange entityId mit 400 INVALID_ENTITY_ID ab", async () => {
    const req = makeRequest(`https://localhost/api/analysis/sentiment?entityId=${"X".repeat(65)}`);
    const res = await GET(req);
    assert.equal(res.status, 400);

    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "INVALID_ENTITY_ID");
  });
});
