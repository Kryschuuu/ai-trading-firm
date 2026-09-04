/**
 * C3 (v1.36.15): Disarm-Challenge für den Firm-Kill-Switch.
 *
 * Ein Disarm (`POST /api/firm/kill` mit `{ arm: false }`) verlangt seit C3
 * deutlich mehr als ein gestohlenes Operator-Token: ADMIN-Permission
 * (`live.gate`) UND einen expliziten, kurzlebigen Einmal-Nonce. Der Nonce wird
 * hier prozesslokal ausgestellt (Single-Node, wie die Rate-Limiter) und ist:
 *
 *   - single-use  → ein bereits verbrauchter Nonce wird abgelehnt
 *   - kurzlebig    → läuft nach `DISARM_NONCE_TTL_MS` (60 s) ab
 *
 * `issueDisarmNonce`  → für `GET /api/firm/kill/challenge`
 * `consumeDisarmNonce` → für den Disarm in `POST /api/firm/kill`
 *
 * Die Speicherung ist bewusst In-Memory (kein Secret auf der Platte); ein
 * Neustart invalidiert offene Challenges — genau das gewünschte Verhalten für
 * einen sicherheitskritischen Entschärfungsvorgang.
 */
import { randomUUID } from "node:crypto";

/** Gültigkeit einer Challenge (Hard-Limit, siehe Arena-Prompt C3: <= 60 s). */
export const DISARM_NONCE_TTL_MS = 60_000;

type Entry = { nonce: string; expiresAt: number; used: boolean };

/** Prozesslokaler Challenge-Speicher (Single-Node; wie die Rate-Limiter). */
const store = new Map<string, Entry>();

/** Entfernt abgelaufene Challenges (lazy cleanup beim nächsten Zugriff). */
function sweep(now: number): void {
  for (const [nonce, e] of store) {
    if (now > e.expiresAt) store.delete(nonce);
  }
}

/** Nur für Tests: Speicher leeren. */
export function resetDisarmNoncesForTests(): void {
  store.clear();
}

export type DisarmNonceIssue = {
  nonce: string;
  /** epoch-ms, zu dem die Challenge abläuft. */
  expiresAt: number;
};

/**
 * Stellt einen frischen Einmal-Nonce aus. `now` ist injizierbar (Tests).
 * Liefert den Nonce + Ablaufzeitpunkt.
 */
export function issueDisarmNonce(now: number = Date.now()): DisarmNonceIssue {
  sweep(now);
  const nonce = randomUUID();
  const expiresAt = now + DISARM_NONCE_TTL_MS;
  store.set(nonce, { nonce, expiresAt, used: false });
  return { nonce, expiresAt };
}

/**
 * Ergebnis der Nonce-Prüfung:
 *  - "ok"      → gültig und jetzt atomar als verbraucht markiert (Disarm frei)
 *  - "missing" → unbekannt/fehlend → 403
 *  - "expired" → abgelaufen (> 60 s) → 403
 *  - "reused"  → bereits verwendet (single-use verletzt) → 403
 */
export type DisarmNonceConsumeResult =
  | "ok"
  | "missing"
  | "expired"
  | "reused";

/**
 * Prüft und verbraucht den Nonce synchron (kein `await` davor im Aufrufer,
 * damit check-and-consume atomar bleibt — Single-Node, Single-Thread).
 * Gibt nur bei "ok" den Eintrag als verbraucht frei.
 */
export function consumeDisarmNonce(
  nonce: string,
  now: number = Date.now()
): DisarmNonceConsumeResult {
  if (!nonce) return "missing";
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
