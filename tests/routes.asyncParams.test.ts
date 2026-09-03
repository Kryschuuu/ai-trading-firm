/**
 * Regression (v1.36.9): Async Route-Params — Next.js >= 15 liefert `params` in
 * Route-Handlern/Pages als Promise, seit Next.js 16 ist der synchrone Zugriff
 * vollständig entfernt (Breaking Change "Sync params/searchParams props access").
 *
 * Hintergrund des Befunds: `src/app/api/firm/proposals/[id]/approve/route.ts`
 * (eingeführt mit H6, v1.36.7) nutzte noch die synchrone Signatur
 * `{ params }: { params: { id: string } }`. Zur Laufzeit war `params` damit ein
 * Promise, `params.id` also `undefined` — der Endpoint antwortete auf **jeden**
 * Aufruf mit 400 `"proposal id missing"`, die menschliche Freigabe war tot.
 * `tsc --noEmit` sieht das nicht: die inkompatible Signatur fällt erst im
 * `next build` über den generierten Route-Validator (`.next/types/validator.ts`,
 * TS2344) auf — und `next build` läuft in keiner der CI-Workflows.
 *
 * Dieser Test schließt beide Lücken:
 *   1. Projektweiter Scan aller dynamischen Segmente auf synchrone
 *      `params`/`searchParams`-Annotationen (der eigentliche CI-Blindfleck).
 *   2. Verhaltenstest des Approve-Handlers: `params` muss ausgepackt werden.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { NextRequest } from "next/server";

const APP_DIR = new URL("../src/app", import.meta.url).pathname;
const ROUTE_FILE = "../src/app/api/firm/proposals/[id]/approve/route.ts";

/** Signatur des Approve-Handlers (`RouteContext` ist nicht exportiert). */
type ApprovePost = (
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

async function loadApprove(): Promise<ApprovePost> {
  const mod = (await import("../src/app/api/firm/proposals/[id]/approve/route")) as {
    POST: ApprovePost;
  };
  return mod.POST;
}

/** Rekursiv alle Dateien unter einem Verzeichnis sammeln. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * Alle Dateien, die in einem dynamischen Segment liegen (`[…]`) und einen
 * Route-Handler oder eine Page/Layout exportieren können.
 */
function dynamicSegmentFiles(): string[] {
  return walk(APP_DIR).filter(
    (f) =>
      f.includes("[") &&
      (f.endsWith("route.ts") ||
        f.endsWith("route.tsx") ||
        f.endsWith("page.tsx") ||
        f.endsWith("layout.tsx")),
  );
}

/**
 * Eine `params`/`searchParams`-Annotation gilt als **synchron**, wenn sie direkt
 * mit einem Objekt-Literal-Typ annotiert ist (`params: { id: string }`) statt mit
 * `Promise<…>` (`params: Promise<{ id: string }>`). Typ-Aliase wie
 * `type RouteContext = { params: Promise<…> }` tragen ihre Promise-Annotation an
 * der Definition und werden damit korrekt als asynchron erkannt.
 */
const SYNC_ANNOTATION = /\b(params|searchParams)\s*:\s*\{/g;

test("async-params: es existieren dynamische Segmente (Sanity — Scan ist nicht leer)", () => {
  assert.ok(dynamicSegmentFiles().length >= 10, "erwartet >= 10 Dateien in dynamischen Segmenten");
});

test("async-params: keine dynamische Route annotiert params/searchParams synchron", () => {
  const violations: string[] = [];
  for (const file of dynamicSegmentFiles()) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(SYNC_ANNOTATION)) {
      const line = source.slice(0, match.index ?? 0).split("\n").length;
      violations.push(`${relative(APP_DIR, file)}:${line} → ${match[0]}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    "Synchrone Request-Params sind seit Next.js 16 entfernt (params ist ein Promise).\n" +
      "Bitte auf die Repo-Konvention umstellen:\n" +
      '  type RouteContext = { params: Promise<{ id: string }> };\n' +
      "  export async function POST(req: Request, ctx: RouteContext) { const { id } = await ctx.params; … }\n" +
      `Betroffen:\n  ${violations.join("\n  ")}`,
  );
});

test("async-params: jede dynamische Route, die params liest, packt es mit await/use() aus", () => {
  const offenders: string[] = [];
  for (const file of dynamicSegmentFiles()) {
    const source = readFileSync(file, "utf8");
    // Nur Dateien prüfen, die überhaupt eine params-Annotation tragen.
    if (!/\b(params|searchParams)\s*:/.test(source)) continue;
    // Mindestens ein await/use() auf das jeweilige Feld.
    const unwrapped =
      /await\s+(?:\w+\.params|\w+\.searchParams|params|searchParams)\b/.test(source) ||
      /\buse\(\s*\w+\.(?:params|searchParams)\s*\)/.test(source) ||
      /\buse\(\s*(?:params|searchParams)\s*\)/.test(source);
    if (!unwrapped) offenders.push(relative(APP_DIR, file));
  }
  assert.deepEqual(offenders, [], "params/searchParams werden gelesen, aber nie ausgepackt");
});

test("async-params: Approve-Route nutzt die Repo-Konvention RouteContext", () => {
  const source = readFileSync(new URL(ROUTE_FILE, import.meta.url), "utf8");
  assert.match(source, /type RouteContext = \{ params: Promise<\{ id: string \}> \}/);
  assert.match(source, /export async function POST\(request: NextRequest, ctx: RouteContext\)/);
  assert.match(source, /await ctx\.params/);
  // Der alte, kaputte Zugriff darf nie wiederkommen.
  assert.doesNotMatch(source, /params\s*:\s*\{\s*id\s*:\s*string\s*\}/);
  assert.doesNotMatch(source, /=\s*params\.id\b/);
});

/**
 * Verhaltenstest: Der Handler wird — wie in `tests/brokerApi.test.ts` — direkt
 * aufgerufen, mit `params` als Promise (die reale Next.js-16-Arity). Unter der
 * alten synchronen Signatur lieferte genau dieser Call 400 `"proposal id
 * missing"`; jetzt muss die ID im Handler ankommen, d. h. der Call läuft bis zur
 * DB weiter (404 ohne Datensatz bzw. 500 ohne DB — beides ≠ "proposal id missing").
 */
test("async-params: Approve-Handler löst die Route-ID aus dem Promise auf", async () => {
  const POST = await loadApprove();
  const res = await POST(
    new NextRequest("http://localhost/api/firm/proposals/prop-async-check/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvedBy: "regression-test" }),
    }),
    { params: Promise.resolve({ id: "prop-async-check" }) },
  );
  const body = (await res.json()) as { error?: string };
  assert.notEqual(
    body.error,
    "proposal id missing",
    "params wurde nicht ausgepackt — die Route-ID kam nicht im Handler an",
  );
  assert.ok(
    res.status === 404 || res.status === 500 || res.status === 200,
    `erwartet 200/404/500 nach erfolgreicher ID-Auflösung, bekam ${res.status}`,
  );
});

test("async-params: Approve-Handler lehnt fehlenden Actor weiterhin mit 400 ab", async () => {
  const POST = await loadApprove();
  const res = await POST(
    new NextRequest("http://localhost/api/firm/proposals/prop-async-check/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    { params: Promise.resolve({ id: "prop-async-check" }) },
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: string };
  assert.equal(body.error, "approvedBy (actor) is required");
});
