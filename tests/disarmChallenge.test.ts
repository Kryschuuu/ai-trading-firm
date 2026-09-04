/**
 * Befund C3 (v1.36.15): Nonce-Logik des Disarm-Challenge-Speichers.
 *
 * Ein Disarm des Firm-Kill-Switch verlangt einen kurzlebigen, single-use Nonce
 * aus `GET /api/firm/kill/challenge`. Diese Tests decken die Akzeptanzkriterien
 * des Audit-Prompts auf der Logik-Ebene ab (fehlender/abgelaufener/
 * wiederverwendeter Nonce wird abgelehnt; gültiger Nonce wird genau einmal
 * verbraucht). Rein, ohne DB — gleiche Modulbasis wie die Rate-Limiter.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  consumeDisarmNonce,
  DISARM_NONCE_TTL_MS,
  issueDisarmNonce,
  resetDisarmNoncesForTests,
} from "../src/lib/disarmChallenge";

afterEach(() => {
  resetDisarmNoncesForTests();
});

test("C3: issue liefert Nonce + Ablauf in 60 s", () => {
  const now = Date.now();
  const { nonce, expiresAt } = issueDisarmNonce(now);
  assert.equal(typeof nonce, "string");
  assert.ok(nonce.length >= 16, "Nonce soll kryptographisch zufällig/lang sein");
  assert.equal(expiresAt, now + DISARM_NONCE_TTL_MS);
  assert.equal(DISARM_NONCE_TTL_MS, 60_000, "Hard-Limit <= 60 s laut Audit-Prompt");
});

test("C3: gültiger Nonce wird verbraucht (consume = ok)", () => {
  const now = Date.now();
  const { nonce } = issueDisarmNonce(now);
  assert.equal(consumeDisarmNonce(nonce, now), "ok");
});

test("C3: fehlender/unbekannter Nonce → missing (403)", () => {
  assert.equal(consumeDisarmNonce("", Date.now()), "missing");
  assert.equal(consumeDisarmNonce("gibt-es-nicht", Date.now()), "missing");
});

test("C3: wiederverwendeter Nonce → reused (403)", () => {
  const now = Date.now();
  const { nonce } = issueDisarmNonce(now);
  assert.equal(consumeDisarmNonce(nonce, now), "ok");
  assert.equal(consumeDisarmNonce(nonce, now), "reused");
});

test("C3: abgelaufener Nonce → expired (403)", () => {
  const now = Date.now();
  const { nonce } = issueDisarmNonce(now);
  // Erst nach Ablauf prüfen — knapp davor ist er noch gültig.
  assert.equal(consumeDisarmNonce(nonce, now + DISARM_NONCE_TTL_MS - 1), "ok");
  const { nonce: later } = issueDisarmNonce(now);
  assert.equal(consumeDisarmNonce(later, now + DISARM_NONCE_TTL_MS + 1), "expired");
});
