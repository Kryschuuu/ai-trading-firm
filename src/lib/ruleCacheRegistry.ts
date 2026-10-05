/**
 * Prozesslokales Register der aktiven Mikro-Executor-Regelcaches.
 *
 * PostgreSQL NOTIFY wird pro Prozess zugestellt. Dieser kleine Bridge-Layer
 * verbindet die DB-Invalidierung mit allen RuleCache-Instanzen im Prozess,
 * ohne ruleService und microExecutor zyklisch voneinander abhängig zu machen.
 */
import { state } from "./stateRegistry";

export type RuleCacheInvalidator = () => void;

/** Registriert einen Cache und gibt eine idempotente Abmeldefunktion zurück. */
export function registerRuleCacheInvalidator(owner: object, invalidate: RuleCacheInvalidator): () => void {
  const invalidators = state.ruleCacheInvalidators.get();
  invalidators.set(owner, invalidate);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    // Nur den eigenen Eintrag entfernen; eine erneute Registrierung desselben
    // Owners könnte inzwischen einen neueren Callback hinterlegt haben.
    if (invalidators.get(owner) === invalidate) invalidators.delete(owner);
  };
}

/** Invalidiert alle aktuell gestarteten RuleCaches dieses Prozesses. */
export function invalidateRuleCaches(): number {
  const invalidators = state.ruleCacheInvalidators.get();
  let invalidated = 0;
  for (const invalidate of invalidators.values()) {
    try {
      invalidate();
      invalidated += 1;
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      console.error("[cache-invalidation] RuleCache-Invalidierung fehlgeschlagen:", errorName);
    }
  }
  return invalidated;
}
