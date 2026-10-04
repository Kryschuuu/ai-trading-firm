/**
 * Minimaler Klassen-Joiner der UI-Bausteine (v0.15.0).
 *
 * Bewusst ohne `clsx`/`tailwind-merge`: Das Projekt hat keine solchen
 * Abhängigkeiten, und die Bausteine setzen Klassen deterministisch zusammen
 * (feste Basis + optionale Zusätze). `false`/`null`/`undefined` werden
 * verworfen, damit bedingte Klassen lesbar bleiben.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
