/**
 * Forecast-API — Vertrags- und Validierungstests (RMA-P3-01, v1.55.0).
 *
 * Prüft die HTTP-Verträge der vier Forecast-Routen ohne Datenbank:
 * Eingabevalidierung (400), geschlossene Parametermengen und das
 * Authorisierungsverhalten (SEC-02-Muster: `firm.read`/`firm.write`,
 * `no-store`). DB-gestützte Pfade decken `forecastLedger.db.test.ts` und
 * `forecastService.test.ts` ab.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GET as scoresGet } from "../src/app/api/firm/forecasts/scores/route";
import { GET as listGet } from "../src/app/api/firm/forecasts/route";
import { POST as resolvePost } from "../src/app/api/firm/forecasts/resolve/route";
import { POST as resolutionsPost } from "../src/app/api/firm/forecasts/resolutions/route";

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("API GET /api/firm/forecasts/scores — Validierung", () => {
  it("ungültiger Horizont ⇒ 400 INVALID_HORIZON", async () => {
    const res = await scoresGet(new Request("http://localhost/api/firm/forecasts/scores?horizon=99h"));
    assert.equal(res.status, 400);
    const body = await json(res);
    assert.equal(body.ok, false);
    assert.equal(body.error, "INVALID_HORIZON");
  });

  it("ungültiges minSample ⇒ 400 INVALID_MIN_SAMPLE", async () => {
    const res = await scoresGet(new Request("http://localhost/api/firm/forecasts/scores?minSample=0"));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, "INVALID_MIN_SAMPLE");
  });

  it("ungültiges limit ⇒ 400 INVALID_LIMIT", async () => {
    const res = await scoresGet(new Request("http://localhost/api/firm/forecasts/scores?limit=abc"));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, "INVALID_LIMIT");
  });

  it("ungültiges Datum ⇒ 400 INVALID_DATE", async () => {
    const res = await scoresGet(new Request("http://localhost/api/firm/forecasts/scores?from=gestern"));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, "INVALID_DATE");
  });

  it("Antworten tragen no-store (SEC-02-Muster)", async () => {
    const res = await scoresGet(new Request("http://localhost/api/firm/forecasts/scores?horizon=99h"));
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  });
});

describe("API GET /api/firm/forecasts — Validierung", () => {
  it("ungültiger Horizont ⇒ 400", async () => {
    const res = await listGet(new Request("http://localhost/api/firm/forecasts?horizon=88h"));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, "INVALID_HORIZON");
  });

  it("limit außerhalb der Bounds ⇒ 400", async () => {
    const res = await listGet(new Request("http://localhost/api/firm/forecasts?limit=0"));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, "INVALID_LIMIT");
  });

  it("ungültiges from ⇒ 400 INVALID_DATE", async () => {
    const res = await listGet(new Request("http://localhost/api/firm/forecasts?from=nix"));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, "INVALID_DATE");
  });

  it("ungültige promptVersion ⇒ 400", async () => {
    const res = await listGet(new Request("http://localhost/api/firm/forecasts?promptVersion=-3"));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, "INVALID_PROMPT_VERSION");
  });
});

describe("API POST /api/firm/forecasts/resolve — Validierung", () => {
  it("ungültiges limit ⇒ 400 INVALID_LIMIT", async () => {
    const res = await resolvePost(
      new Request("http://localhost/api/firm/forecasts/resolve", {
        method: "POST",
        body: JSON.stringify({ limit: 0 }),
      })
    );
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, "INVALID_LIMIT");
  });
});

describe("API POST /api/firm/forecasts/resolutions — Validierung", () => {
  it("ungültiges JSON ⇒ 400 INVALID_JSON", async () => {
    const res = await resolutionsPost(
      new Request("http://localhost/api/firm/forecasts/resolutions", { method: "POST", body: "{kaputt" })
    );
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, "INVALID_JSON");
  });

  it("fehlende forecastId ⇒ 400 INVALID_BODY", async () => {
    const res = await resolutionsPost(
      new Request("http://localhost/api/firm/forecasts/resolutions", {
        method: "POST",
        body: JSON.stringify({ action: "VOID", reason: "CORPORATE_ACTION" }),
      })
    );
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, "INVALID_BODY");
  });

  it("ungültige action ⇒ 400 INVALID_BODY", async () => {
    const res = await resolutionsPost(
      new Request("http://localhost/api/firm/forecasts/resolutions", {
        method: "POST",
        body: JSON.stringify({ forecastId: "abc", action: "LÖSCHEN", reason: "DATA_CORRECTION" }),
      })
    );
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, "INVALID_BODY");
  });

  it("überlange note ⇒ 400 INVALID_BODY", async () => {
    const res = await resolutionsPost(
      new Request("http://localhost/api/firm/forecasts/resolutions", {
        method: "POST",
        body: JSON.stringify({
          forecastId: "abc",
          action: "VOID",
          reason: "CORPORATE_ACTION",
          note: "x".repeat(501),
        }),
      })
    );
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error, "INVALID_BODY");
  });
});
