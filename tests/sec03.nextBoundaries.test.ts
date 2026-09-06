/**
 * SEC-03: harmlose Regressionen an den gepatchten Framework-Grenzen.
 * Direkte Aufrufe des installierten Next.js statt Quelltext-Greps. Der Cache
 * benutzt ausschliesslich ein aufzeichnendes Fake-FS (keine Dateien/Secrets).
 * CI fuehrt dieselben Tests unter Linux UND Windows mit nativer Pfadsemantik aus.
 */
import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { PHASE_PRODUCTION_SERVER } from "next/constants";
import loadConfig from "next/dist/server/config";
import {
  detectContentType,
  getSharp,
  ImageError,
  ImageOptimizerCache,
  imageOptimizer,
} from "next/dist/server/image-optimizer";
import FileSystemCache from "next/dist/server/lib/incremental-cache/file-system-cache";
import type { CachedRouteKind, IncrementalCacheKind, IncrementalCacheValue } from "next/dist/server/response-cache";
import escapePathDelimiters from "next/dist/shared/lib/router/utils/escape-path-delimiters";
import type { CacheFs } from "next/dist/shared/lib/utils";
import appConfig from "../next.config";

const serverDistDir = path.resolve("sec03-virtual-build", "server");

function cacheHarness() {
  const operations: { operation: string; file: string }[] = [];
  const fs: CacheFs = {
    existsSync: () => { throw new Error("Unexpected existsSync"); },
    readFileSync: () => { throw new Error("Unexpected readFileSync"); },
    readFile: async (file) => {
      operations.push({ operation: "read", file: String(file) });
      throw Object.assign(new Error("fixture cache miss"), { code: "ENOENT" });
    },
    writeFile: async (file) => { operations.push({ operation: "write", file }); },
    mkdir: async (file) => { operations.push({ operation: "mkdir", file }); },
    stat: async () => { throw new Error("Unexpected stat after cache miss"); },
  };
  const cache = new FileSystemCache({
    fs, serverDistDir, flushToDisk: true, maxMemoryCacheSize: 0,
    revalidatedTags: [], _requestHeaders: {},
  });
  return { cache, operations };
}

// Next deklariert diese Wire-Werte als ambient const enums; unter
// isolatedModules duerfen sie nur als Typen, nicht als Werte importiert werden.
const caches: { kind: IncrementalCacheKind; root: string; data?: IncrementalCacheValue }[] = [
  {
    kind: "APP_PAGE" as IncrementalCacheKind.APP_PAGE, root: path.join(serverDistDir, "app"),
    data: {
      kind: "APP_PAGE" as CachedRouteKind.APP_PAGE, html: "fixture", rscData: Buffer.from("fixture"),
      headers: {}, status: 200, postponed: undefined, segmentData: undefined,
    },
  },
  {
    kind: "APP_ROUTE" as IncrementalCacheKind.APP_ROUTE, root: path.join(serverDistDir, "app"),
    data: { kind: "APP_ROUTE" as CachedRouteKind.APP_ROUTE, body: Buffer.from("fixture"), headers: {}, status: 200 },
  },
  {
    kind: "PAGES" as IncrementalCacheKind.PAGES, root: path.join(serverDistDir, "pages"),
    data: { kind: "PAGES" as CachedRouteKind.PAGES, html: "fixture", pageData: {}, headers: {}, status: 200 },
  },
  {
    kind: "FETCH" as IncrementalCacheKind.FETCH, root: path.join(serverDistDir, "..", "cache", "fetch-cache"),
    data: { kind: "FETCH" as CachedRouteKind.FETCH, data: { body: "fixture", headers: {}, url: "https://example.invalid/fixture" }, revalidate: 60 },
  },
  { kind: "IMAGE" as IncrementalCacheKind.IMAGE, root: path.join(serverDistDir, "app") },
];

for (const { kind, root, data } of caches) {
  const getContext = kind === "FETCH" ? { kind } : { kind, isFallback: false };
  const setContext = kind === "FETCH" ? { fetchCache: true as const } : { fetchCache: false as const };
  const traversalKeys = [
    "../outside", "../../outside", "nested/../../outside",
    // Ein reiner startsWith(root)-Check wuerde diesen Nachbarpfad erlauben.
    `../${path.basename(root)}-neighbour/outside`,
    ...(process.platform === "win32" ? ["..\\outside", "..\\..\\outside", "nested/..\\..\\outside"] : []),
  ];

  test(`SEC-03: ${kind} liest bei Path Traversal keine Datei ausserhalb des Cache-Roots`, async () => {
    for (const key of traversalKeys) {
      const { cache, operations } = cacheHarness();
      assert.equal(await cache.get(key, getContext), null);
      assert.deepEqual(operations, [], `${kind} / ${key}: unzulaessiger Dateizugriff`);
    }
  });

  if (data) test(`SEC-03: ${kind} verweigert Cache-Writes bei Path Traversal vor jedem FS-Zugriff`, async () => {
    for (const key of traversalKeys) {
      const { cache, operations } = cacheHarness();
      await assert.rejects(cache.set(key, data, setContext), /Invalid file path/);
      assert.deepEqual(operations, [], `${kind} / ${key}: unzulaessiger Dateizugriff`);
    }
  });

  test(`SEC-03: ${kind} behaelt legitime verschachtelte und escaped Cache-Keys bei`, async () => {
    for (const key of ["nested/page", escapePathDelimiters("..\\..\\fixture", true), "%2e%2e%5cfixture"]) {
      const { cache, operations } = cacheHarness();
      if (data) await cache.set(key, data, setContext);
      assert.equal(await cache.get(key, getContext), null); // Fake-FS liefert einen normalen Miss.
      assert.ok(operations.some((op) => op.operation === "read"));
      if (data) assert.ok(operations.some((op) => op.operation === "write"));
      for (const { file } of operations) {
        assert.ok(file === root || file.startsWith(root + path.sep), `${kind}: ${file} ausserhalb ${root}`);
      }
    }
  });
}

test("SEC-03: Router escaped rohe Windows-/URL-Trennzeichen und bereits kodierte Separatoren", () => {
  for (const segment of ["..\\..\\fixture", "..\\../fixture", "a/b?c#d\\e", "%5c", "%5C", "%2f", "%2F", "%23", "%3f"]) {
    assert.equal(escapePathDelimiters(segment, true), encodeURIComponent(segment));
  }
  for (const encoded of ["%5c", "%5C", "%255c", "%255C"]) {
    const escaped = escapePathDelimiters(decodeURIComponent(encoded), true);
    assert.ok(!escaped.includes("\\"), "Dekodierter Windows-Separator darf nicht im Cache-Key bleiben");
  }
});

// Der echte Config-Loader beruecksichtigt auch kuenftige App-/Next-Defaults.
const loadImageConfig = () => loadConfig(PHASE_PRODUCTION_SERVER, process.cwd(), { customConfig: appConfig, silent: true });

test("SEC-03: Image-API erlaubt keine externen oder rekursiven Quellen ohne explizite Freigabe", async (t) => {
  const imageConfig = await loadImageConfig();
  const socket = new Socket();
  t.after(() => socket.destroy());
  const req = new IncomingMessage(socket); // kein Listener und keine Netzwerkanfrage
  req.headers.accept = "image/webp";
  for (const url of [
    "https://example.invalid/image.avif", "http://127.0.0.1/image.avif",
    "http://[::1]/image.avif", "//example.invalid/image.avif", "file:///fixture.avif",
    "/_next/image?url=/fixture.avif", "/%5fnext/image?url=/fixture.avif",
  ]) {
    const result = ImageOptimizerCache.validateParams(req, { url, w: "32", q: "75" }, imageConfig, false);
    assert.ok("errorMessage" in result, `${url}: Quelle darf nicht akzeptiert werden`);
  }
  const local = ImageOptimizerCache.validateParams(req, { url: "/fixture.avif", w: "32", q: "75" }, imageConfig, false);
  assert.ok(!("errorMessage" in local), "Legitime lokale Bilder bleiben nutzbar");
});

test("SEC-03: AVIF laeuft auch mit falscher Endung/MIME durch den gepatchten Decoder", async () => {
  // Ausschliesslich ein selbst erzeugtes 2x2-Bild, keine schaedliche RCE-Datei.
  // Die Version der tatsaechlich geladenen Library prueft die Dependency-Suite.
  const imageConfig = await loadImageConfig();
  const sharp = getSharp(1, false);
  const buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#336699" } }).avif().toBuffer();
  assert.equal(await detectContentType(buffer), "image/avif");
  for (const href of ["/fixture.avif", "/fixture.png"]) {
    for (const contentType of ["image/avif", "image/png", null]) {
      for (const mimeType of ["image/webp", "image/jpeg"]) {
        const result = await imageOptimizer(
          { buffer, contentType, cacheControl: null, etag: "sec03-fixture" },
          { href, width: 1, quality: 75, mimeType }, imageConfig, { silent: true },
        );
        assert.equal(result.error, undefined, "Kein stiller Fallback auf das Originalbild");
        assert.equal(result.contentType, mimeType);
        assert.equal(await detectContentType(result.buffer), mimeType);
        const metadata = await sharp(result.buffer).metadata();
        assert.equal(metadata.width, 1);
        assert.equal(metadata.height, 1);
      }
    }
  }
});

test("SEC-03: Image-API verweigert leere, bildfremde und als PNG deklarierte SVG-Inhalte", async () => {
  const imageConfig = await loadImageConfig();
  for (const buffer of [Buffer.alloc(0), Buffer.from("not an image"), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')]) {
    await assert.rejects(
      imageOptimizer(
        { buffer, contentType: "image/png", cacheControl: null, etag: "sec03-invalid" },
        { href: "/fixture.png", width: 1, quality: 75, mimeType: "image/webp" }, imageConfig, { silent: true },
      ),
      (error: unknown) => error instanceof ImageError && error.statusCode === 400,
    );
  }
});
