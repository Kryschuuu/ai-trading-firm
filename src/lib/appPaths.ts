/**
 * Zentrale, pfadsichere Auflösung von Laufzeit-Datenverzeichnissen.
 *
 * ── Warum dieses Modul existiert ───────────────────────────────────────────
 * Next.js 16 (Turbopack) warnt bei jedem `path.join(process.cwd(), <dynamisch>)`
 * mit:
 *
 *     Warning: Dynamic filesystem access causes tracing of the whole project
 *
 * Der Bundler kann den Zielpfad nicht statisch bestimmen und traced deshalb das
 * GESAMTE Projekt in den Server-Output. Vor der Einführung dieses Moduls gab es
 * exakt 12 solcher Stellen (`secretStore.ts`, `cycle/artifacts.ts`,
 * `cycle/ports.ts`, `historicalStore.ts`, `portfolio/auditFile.ts`,
 * `routing/router.ts`, `scanner/artifacts.ts`, `universe/store.ts`).
 *
 * ── Warum hier der offizielle Opt-out steht ────────────────────────────────
 * Turbopack nennt vier Auflösungen, davon sind drei für dieses Projekt falsch:
 *
 *   * „Pfad statisch auf einen Unterordner scopen" — würde die dokumentierten
 *     Env-Overrides (`UNIVERSE_DATA_DIR`, `SCANNER_ARTIFACTS_DIR`,
 *     `PORTFOLIO_AUDIT_DIR`, `BROKER_SECRET_DIR`, `CYCLE_ARTIFACTS_DIR`,
 *     `PAPER_HISTORY_DIR`) still auf einen festen Unterordner umbiegen. Die
 *     Defaults `data/…` **und** `artifacts` müssten ebenfalls umziehen; das
 *     wäre ein Breaking Change für bestehende Installationen.
 *   * „nur in Development verwenden" — die Pfade sind Produktionspfade.
 *   * „entfernen" — die Persistenz ist Kernfunktion (Registry, Artefakte,
 *     Historie, Secret-Store).
 *
 *   Übrig bleibt der vierte, von Turbopack selbst empfohlene Weg: der
 *   Opt-out-Kommentar. Dieses Projekt ist **local-first** (`next start`,
 *   `deploy/*.service`, kein Serverless-/Edge-Deployment) — das Projekt-Tracing
 *   hat hier keine Auswirkung auf ein Deployment-Artefakt.
 *
 * Der Kommentar steht deshalb **genau einmal** in {@link resolveRuntimePath}
 * statt an 12 Stellen, und alle Aufrufer gehen durch dieselbe, zusätzlich
 * abgesicherte Funktion.
 *
 * ── Was dieses Modul zusätzlich absichert ──────────────────────────────────
 * Die aufgelösten Pfade stammen teilweise aus Env-Variablen und HTTP-
 * konfigurierten Werten. `resolveRuntimePath()` lehnt deshalb alles ab, was
 * über `..` aus dem Projektstamm ausbrechen würde (Path-Traversal), und
 * normalisiert das Ergebnis. Absolute Pfade bleiben erlaubt — sie sind
 * explizite Operator-Entscheidung (Tests, externe Volumes).
 *
 * @example
 * ```ts
 * resolveRuntimePath("data/universe");        // → <cwd>/data/universe
 * resolveRuntimePath("/srv/ai/universe");     // → /srv/ai/universe
 * resolveRuntimePath("../../etc/passwd");     // → wirft PathTraversalError
 * ```
 */
import path from "node:path";

/**
 * Wird geworfen, wenn ein relativer Pfad über `..` aus dem Projektstamm
 * ausbrechen würde. Der Message-Text enthält nur den bereinigten, auf 200
 * Zeichen gekürzten Pfad — keine Env-Dumps, keine absoluten Host-Pfade.
 */
export class PathTraversalError extends Error {
  readonly code = "PATH_TRAVERSAL";

  constructor(partial: string) {
    super(`Pfad verlässt den Projektstamm: ${partial}`);
    this.name = "PathTraversalError";
  }
}

/** Kürzt Fremdeingaben für Fehlermeldungen (kein Leak von Host-Pfaden). */
function safePartial(value: string, max = 200): string {
  const clean = String(value).replace(/[^\x20-\x7E]/g, "").slice(0, max);
  return clean || "<leer>";
}

/**
 * Zerlegt einen relativen Pfad in Segmente und verwirft `.` sowie führende
 * Trenner. `..`-Segmente werden ZÄHLEND aufgelöst (nicht nur entfernt), damit
 * `data/../..` korrekt als Ausbruch erkannt wird.
 *
 * @returns Segmente ohne `.`/`..`, oder `null`, wenn der Pfad den Stamm verlässt.
 */
function splitContainedSegments(relative: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  for (const rawSegment of relative.split(/[/\\]+/)) {
    if (rawSegment === "" || rawSegment === ".") continue;
    if (rawSegment === "..") {
      depth -= 1;
      if (depth < 0) return null;
      out.pop();
      continue;
    }
    out.push(rawSegment);
    depth += 1;
  }
  return out;
}

/**
 * Löst einen konfigurierten Datenpfad zu einem absoluten Pfad auf.
 *
 * Semantik (identisch zu `path.join(process.cwd(), raw)` — bewusst kein
 * Verhaltenswechsel gegenüber den früheren Inline-Auflösungen):
 *
 *   * absoluter Pfad  → normalisiert übernommen (Operator-/Test-Entscheidung)
 *   * relativer Pfad  → unter dem Projektstamm verankert
 *   * `..`-Ausbruch   → {@link PathTraversalError}
 *
 * @param raw Konfigurierter Pfad (Env-Variable, Default-Konstante, Testwert).
 * @throws {PathTraversalError} wenn ein relativer Pfad den Projektstamm verlässt.
 */
export function resolveRuntimePath(raw: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return path.normalize(process.cwd());
  if (path.isAbsolute(value)) return path.normalize(value);

  const segments = splitContainedSegments(value);
  if (segments === null) throw new PathTraversalError(safePartial(value));
  if (segments.length === 0) return path.normalize(process.cwd());

  // EINZIGE Stelle mit dem Turbopack-Opt-out — siehe Modul-Dokumentation.
  return path.normalize(
    path.join(/*turbopackIgnore: true*/ process.cwd(), ...segments),
  );
}

/**
 * Löst einen **vom Programm selbst persistierten** Pfad-Eintrag auf
 * (Index-/Manifest-Dateien, z. B. `artifacts/index.json` → `reviewPath`).
 *
 * Unterschied zu {@link resolveRuntimePath}: `..`-Segmente sind hier **legal**.
 * Die Werte entstehen ausschließlich über `path.relative(process.cwd(), …)` in
 * `src/cycle/artifacts.ts`; liegt das Artefakt-Verzeichnis außerhalb des
 * Projekts (externes Volume, `CYCLE_ARTIFACTS_DIR=/srv/…`, Test-Tmpdir), ist
 * der gespeicherte relative Pfad zwingend `../../../…`. Ein strikter
 * Ausbruch-Check würde diese legitimen Installationen lahmlegen.
 *
 * Fremd-/HTTP-Eingaben gehören hier NICHT hin — dafür ist
 * {@link resolveRuntimePath} (mit Ausbruch-Schutz) zuständig.
 */
export function resolveStoredPath(raw: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return path.normalize(process.cwd());
  if (path.isAbsolute(value)) return path.normalize(value);
  return path.normalize(
    path.join(/*turbopackIgnore: true*/ process.cwd(), value),
  );
}

/**
 * Verknüpft Segmente mit einem (bereits aufgelösten oder rohen) Basispfad.
 *
 * Existenzgrund: Turbopack verfolgt die Herkunft eines Pfads über
 * Funktionsgrenzen **innerhalb desselben Moduls** weiter. Ein
 * `path.join(resolveAuditDir(x), file)` in der Aufrufer-Datei wurde deshalb
 * trotz korrekter Auflösung weiterhin als „dynamic filesystem access"
 * gemeldet. Läuft die Verknüpfung über dieses Modul, endet die Analyse an der
 * Modulgrenze — bei identischem Ergebnis.
 *
 * Alle Segmente werden gegen Path-Traversal geprüft (`..`-Ausbruch ⇒ Wurf).
 *
 * @param base   Basispfad (absolut oder relativ zum Projektstamm).
 * @param segments Weitere Pfadsegmente (Dateiname, Unterordner, …).
 * @throws {PathTraversalError} wenn ein Segment aus dem Basispfad ausbricht.
 */
export function joinRuntimePath(base: string, ...segments: string[]): string {
  const root = resolveRuntimePath(base);
  const parts: string[] = [];
  for (const segment of segments) {
    const value = typeof segment === "string" ? segment.trim() : "";
    if (!value) continue;
    if (path.isAbsolute(value)) throw new PathTraversalError(safePartial(value));
    const nested = splitContainedSegments(value);
    if (nested === null) throw new PathTraversalError(safePartial(value));
    parts.push(...nested);
  }
  return parts.length === 0 ? root : path.normalize(path.join(root, ...parts));
}

/**
 * Wie {@link resolveRuntimePath}, aber fehlertolerant: ein `..`-Ausbruch fällt
 * auf `fallback` zurück (niemals auf den Ausbruchspfad selbst). Für Pfade, die
 * aus nicht vertrauenswürdigen Quellen stammen und den Betrieb nicht stoppen
 * dürfen (z. B. Best-Effort-Artefakt-Senken).
 */
export function resolveRuntimePathSafe(raw: string, fallback: string): string {
  try {
    return resolveRuntimePath(raw);
  } catch {
    return resolveRuntimePath(fallback);
  }
}
