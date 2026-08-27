/**
 * Tests für die Shortlist-Limits (Task 06).
 *
 * Verifiziert die nicht verhandelbare Architektur-Regel:
 * "Shortlist-Limits sind Code-Grenzen (max. 40 Instrumente an Technical/News),
 * keine prompt-baren Empfehlungen — sie sind im Code erzwungen.
 * Shortlist-Limit-Assertion (41. Instrument wird abgewiesen)."
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertShortlistLimit } from "../src/cycle/security";
import { MAX_SHORTLIST_LIMIT, ShortlistLimitExceededError } from "../src/cycle/types";
import { technicalStep } from "../src/cycle/steps/technicalStep";
import { newsStep } from "../src/cycle/steps/newsStep";
import { selectionStep } from "../src/cycle/steps/selectionStep";
import { createTestPorts } from "../src/cycle/ports";
import { SimulatedClock } from "../src/cycle/clock";

test("Shortlist: Grenze ist auf exakt 40 definiert", () => {
  assert.equal(MAX_SHORTLIST_LIMIT, 40);
});

test("Shortlist: assertShortlistLimit akzeptiert 40 Instrumente und weist 41 strikt ab", () => {
  const fortyItems = Array.from({ length: 40 }, (_, i) => `SYM_${i + 1}`);
  assert.doesNotThrow(() => {
    assertShortlistLimit(fortyItems, 40);
  });

  const fortyOneItems = Array.from({ length: 41 }, (_, i) => `SYM_${i + 1}`);
  assert.throws(
    () => {
      assertShortlistLimit(fortyOneItems, 40);
    },
    (err: unknown) => {
      assert.ok(err instanceof ShortlistLimitExceededError);
      assert.equal(err.count, 41);
      assert.equal(err.limit, 40);
      assert.match(err.message, /Shortlist-Limit überschritten: 41 Instrumente übergeben, maximal 40 erlaubt/);
      return true;
    }
  );
});

test("Technical Analyst: 41. Instrument wird bei der Input-Validierung abgewiesen", () => {
  const fortyOneCandidates = Array.from({ length: 41 }, (_, i) => ({
    instrumentId: `SYM_${i + 1}`,
  }));

  assert.throws(
    () => {
      technicalStep.validateInput!({ candidates: fortyOneCandidates });
    },
    ShortlistLimitExceededError
  );

  // 40 Kandidaten müssen validieren
  const fortyCandidates = Array.from({ length: 40 }, (_, i) => ({
    instrumentId: `SYM_${i + 1}`,
  }));
  const valid = technicalStep.validateInput!({ candidates: fortyCandidates });
  assert.equal(valid.candidates?.length, 40);
});

test("News Analyst: 41. Instrument wird bei der Input-Validierung abgewiesen", () => {
  const fortyOneSymbols = Array.from({ length: 41 }, (_, i) => `SYM_${i + 1}`);

  assert.throws(
    () => {
      newsStep.validateInput!({ symbols: fortyOneSymbols });
    },
    ShortlistLimitExceededError
  );

  const fortySymbols = Array.from({ length: 40 }, (_, i) => `SYM_${i + 1}`);
  const valid = newsStep.validateInput!({ symbols: fortySymbols });
  assert.equal(valid.symbols?.length, 40);
});

test("Market Selection: deckelt Kandidatenliste im Code auf maximal 40", async () => {
  const ports = createTestPorts();
  const clock = new SimulatedClock();

  // Fake-Agent versucht, 50 Kandidaten zurückzuliefern
  const fiftyCandidates = Array.from({ length: 50 }, (_, i) => ({
    instrumentId: `SYM_${i + 1}`,
    rank: i + 1,
    score: 80 - i,
    assetClass: "crypto",
    selectionRationale: "Test",
  }));

  ports.agent.setResponseForRole("MARKET_SELECTION", {
    candidates: fiftyCandidates,
    selectedCount: 50,
    asOf: clock.toISOString(),
  });

  const ctx = {
    cycleId: "test-cycle",
    date: "2026-08-27",
    asOf: clock.now(),
    clock,
    input: {},
    previousStepOutputs: {},
    ports,
    emitEscalation: () => {},
    log: () => {},
  };

  const result = await selectionStep.execute(ctx);
  // Code-Grenze erzwingt maximal 40
  assert.equal(result.candidates.length, 40);
  assert.equal(result.selectedCount, 40);
});
