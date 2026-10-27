/**
 * ASA-02 — Einmal-Challenge für `POST /api/live/kill` mit `action: "clear"`.
 *
 * Das ENTschärfen des Live-Kill-Switches verlässt den sicheren Zustand. Es
 * braucht deshalb mehr als ein (möglicherweise gestohlenes) Admin-Credential:
 * `GET /api/live/kill` stellt hier einen kurzlebigen, single-use Nonce aus,
 * den `POST /api/live/kill` mit `consumeKillNonce(body.nonce)` prüft UND
 * verbraucht. Vor ASA-02 wurde die Nonce weder ausgegeben noch geprüft.
 *
 * Analog zu `src/lib/disarmChallenge.ts` (Firm-Kill-Switch, C3), aber bewusst
 * ein EIGENER Nonce-Pool: eine Challenge für `/api/firm/kill` darf niemals
 * den Live-Kill-Switch entschärfen (und umgekehrt).
 *
 * Speicher: zentrale State-Registry (RAM, Single-Node). Neustart ⇒ alle
 * offenen Challenges weg — gewolltes Fail-Closed-Verhalten.
 */
import { randomUUID } from "node:crypto";
import { state } from "./stateRegistry";

/** Gültigkeit einer Clear-Challenge (60 s, wie beim Firm-Disarm). */
export const KILL_NONCE_TTL_MS = 60_000;

type KillNonceEntry = { nonce: string; expiresAt: number; used: boolean };

function sweep(now: number): void {
  const store = state.killNonces.get();
  for (const [nonce, entry] of store) {
    if (now > entry.expiresAt) store.delete(nonce);
  }
}

/** Nur für Tests: Nonce-Pool leeren. */
export function resetKillNoncesForTests(): void {
  state.killNonces.clear();
}

export type KillNonceIssue = {
  nonce: string;
  /** epoch-ms, zu dem die Challenge abläuft. */
  expiresAt: number;
};

/** Frische, zufällige Einmal-Challenge ausstellen (`GET /api/live/kill`). */
export function issueKillNonce(now: number = Date.now()): KillNonceIssue {
  sweep(now);
  const nonce = randomUUID();
  const expiresAt = now + KILL_NONCE_TTL_MS;
  const entry: KillNonceEntry = { nonce, expiresAt, used: false };
  state.killNonces.get().set(nonce, entry);
  return { nonce, expiresAt };
}

export type KillNonceConsumeResult = "ok" | "missing" | "expired" | "reused";

/**
 * Prüft und verbraucht den Nonce synchron (check-and-consume atomar im
 * Single-Thread). Nur `"ok"` berechtigt zum Clear.
 * - `missing` → unbekannt/falsch/leer → 400
 * - `expired` → TTL überschritten → 400
 * - `reused`  → bereits benutzt (Replay) → 403/400
 */
export function consumeKillNonce(
  nonce: string,
  now: number = Date.now()
): KillNonceConsumeResult {
  if (!nonce) return "missing";
  const store = state.killNonces.get();
  const entry = store.get(nonce);
  if (!entry) return "missing";
  if (entry.used) return "reused";
  if (now > entry.expiresAt) {
    store.delete(nonce);
    return "expired";
  }
  entry.used = true;
  return "ok";
}
