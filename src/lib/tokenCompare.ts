/**
 * Timing-sicherer Token-Vergleich — Blatt-Modul (C1, v1.36.13).
 *
 * Ursprünglich Teil von `src/lib/apiAuth.ts`. Ausgelagert, weil der RBAC-Kern
 * (`src/auth/resolve.ts`) denselben Vergleich braucht, `apiAuth.ts` jetzt aber
 * den Auth-Modus aus `src/auth/authMode.ts` liest. Ohne Auslagerung wäre ein
 * Import-Zyklus entstanden:
 *
 *   src/lib/apiAuth.ts → src/auth/authMode.ts → (Blatt)
 *   src/lib/apiAuth.ts → src/auth/resolve.ts  → src/lib/tokenCompare.ts (Blatt)
 *
 * Regel: Alles, was der Vergleich braucht, darf nicht auf die Guard-Schicht
 * zurückzeigen. `apiAuth.ts` re-exportiert die Funktion, alle bestehenden
 * Importpfade (`@/lib/apiAuth`) bleiben gültig.
 *
 * Der Vergleich paddert beide Werte auf die identische Länge, damit ein
 * Token-Raten nicht über Antwortzeiten messbar wird, und prüft die Länge
 * separat — `timingSafeEqual` wirft sonst bei ungleicher Länge.
 */
import { timingSafeEqual } from "node:crypto";

/** Timing-sicherer Vergleich, der auch bei ungleicher Länge nicht short-circuited. */
export function tokenEquals(got: string, expected: string): boolean {
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(expected, "utf8");
  const n = Math.max(a.length, b.length, 1);
  const pa = Buffer.alloc(n);
  const pb = Buffer.alloc(n);
  a.copy(pa);
  b.copy(pb);
  const lengthOk = a.length === b.length && b.length > 0;
  const bodyOk = timingSafeEqual(pa, pb);
  return lengthOk && bodyOk;
}
