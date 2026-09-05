/**
 * Link-Rewriting für gerendertes Markdown — behebt die lokalen 404s.
 *
 * Problem: In `docs/README.md` (und anderen Doku-Dateien) zeigen relative
 * Links wie `[ARCHITECTURE.md](ARCHITECTURE.md)` auf `/ARCHITECTURE.md` —
 * eine Route, die es nicht gibt → 404. Die Docs werden aber im laufenden
 * System unter `/docs/<Datei>.md` gerendert und sind dort navigierbar.
 *
 * Diese Funktion übersetzt relative `*.md`-Links beim Rendern in ihre
 * kanonische URL (`/docs/<Datei>.md`), sodass jeder Klick lokal funktioniert.
 * Externe URLs, Mailto-, Anker- und bereits absolute Pfade bleiben unverändert.
 */
export function rewriteDocHref(href: string): string {
  if (!href) return href;

  // Externe Links, Protokolle und reine In-Page-Anker unverändert lassen.
  if (/^(https?:|mailto:|tel:|data:|#|\/)/.test(href) || href.startsWith("//")) return href;

  // Nur relative Pfade, die auf eine Markdown-Datei (mit optionalem Anker) zeigen.
  const [p, anchor] = splitAnchor(href);
  if (!p.endsWith(".md")) return href;

  const file = basename(p);
  const withAnchor = anchor ? `#${anchor}` : "";
  return `/docs/${file}${withAnchor}`;
}

/** Trennt `pfad#anker` in Pfad und Anker (sicher gegen mehrere `#`). */
function splitAnchor(target: string): [string, string] {
  const idx = target.indexOf("#");
  if (idx === -1) return [target, ""];
  return [target.slice(0, idx), target.slice(idx + 1)];
}

/** Letztes Pfadsegment (`sub/ARCHITECTURE.md` → `ARCHITECTURE.md`). */
function basename(p: string): string {
  return p.split("/").pop() ?? p;
}
