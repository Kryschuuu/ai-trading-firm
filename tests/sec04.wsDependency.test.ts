/**
 * SEC-04: Supply-Chain-Gate fuer die WebSocket-Bibliothek `ws` — ohne
 * Registry-/Netzwerkabhaengigkeit.
 *
 * Root Cause des Findings ist nicht die installierte Datei, sondern die
 * SemVer-Range im Manifest: `^8.18.0` erlaubt jede 8.x-Version und damit auch
 * die verwundbaren Staende < 8.21.0. Ein Lockfile schuetzt davor nur solange,
 * bis jemand `npm install`/`npm update` laeuft, das Lockfile neu erzeugt oder
 * ohne Lockfile installiert. Deshalb prueft dieses Gate die gesamte Kette:
 *
 *   Manifest-Pin -> Override fuer transitive Kopien -> jeder Lockfile-Eintrag
 *   -> tatsaechlich aufgeloeste Installation -> verbindliche CI-Verdrahtung.
 *
 * Der Versions-Floor kommt aus `src/brokers/bitunix/ws.ts` (eine Quelle der
 * Wahrheit fuer Laufzeit-Guard und Dependency-Gate).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { MIN_WS_VERSION } from "../src/brokers/bitunix/ws";

/**
 * Mindestversion aus den Advisories (GHSA-96hv-2xvq-fx4p / CVE-2026-48779 und
 * GHSA-58qx-3vcg-4xpx / CVE-2026-45736). Der Code-Floor darf hoeher, aber nie
 * niedriger liegen — sonst waere der Laufzeit-Guard weicher als das Advisory.
 */
const ADVISORY_FLOOR = "8.21.0";
/** Die Typen muessen zur installierten Laufzeit-Major-Linie passen. */
const WS_MAJOR = 8;

interface PackageEntry {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
}
interface Manifest extends PackageEntry {
  scripts: Record<string, string>;
}
interface Lockfile {
  version: string;
  lockfileVersion: number;
  packages: Record<string, PackageEntry>;
}

const ROOT = process.cwd();
const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as Manifest;
const lock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8")) as Lockfile;
const requireFromRoot = createRequire(path.join(ROOT, "package.json"));

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

/** Folgt Nodes echter Aufloesung, auch wenn package.json nicht exportiert wird. */
function resolvedManifest(requireFrom: NodeJS.Require, name: string): string {
  let directory = path.dirname(requireFrom.resolve(name));
  while (directory !== path.dirname(directory)) {
    const file = path.join(directory, "package.json");
    if (existsSync(file)) {
      const candidate = JSON.parse(readFileSync(file, "utf8")) as PackageEntry;
      if (candidate.name === name) return file;
    }
    directory = path.dirname(directory);
  }
  throw new Error(`${name}: Manifest der installierten Dependency fehlt`);
}

/**
 * Bewusst kein SemVer-Range-Parser: Fuer `ws` sind ausschliesslich exakt
 * gepinnte stabile Releases zulaessig. Alles andere (Range, Alias, Tag,
 * Prerelease, Git-/File-Quelle) ist ein potenzieller Downgrade-Pfad.
 */
function assertPatchedVersion(version: unknown, minimum: string, label: string): asserts version is string {
  assert.ok(typeof version === "string", `${label}: Version fehlt`);
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, `${label}: nur stabile exakte Versionen erlaubt`);
  const actual = version.split(".").map(Number);
  const floor = minimum.split(".").map(Number);
  assert.ok(actual.every(Number.isSafeInteger), `${label}: ungueltige Versionskomponenten`);
  const firstDifference = actual.findIndex((part, i) => part !== floor[i]);
  assert.ok(firstDifference === -1 || actual[firstDifference] > floor[firstDifference], `${label}: ${version} < ${minimum}`);
}

function assertRegistryArtifact(entry: PackageEntry, name: string, label: string): void {
  assert.notEqual(entry.link, true, `${label}: kein lokaler Link statt Registry-Paket`);
  const basename = name.split("/").at(-1);
  assert.equal(entry.resolved, `https://registry.npmjs.org/${name}/-/${basename}-${entry.version}.tgz`, `${label}: unerwartete Paketquelle`);
  assert.match(entry.integrity ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/, `${label}: SHA-512-Integritaet fehlt`);
}

test("SEC-04: Versions-Gate lehnt Ranges, Downgrades, Aliase und Prereleases ab", () => {
  for (const unsafe of [
    undefined, null, 8, "", "8.0.0", "8.17.1", "8.18.0", "8.18.3", "8.20.0", "8.20.1",
    "^8.18.0", "^8.21.0", "~8.21.0", ">=8.21.0", "8.x", "*", "latest",
    "8.21.0-rc.1", "8.21.0+local", "8.21.0 || 8.18.0", "8.021.0",
    "npm:ws@8.21.3", "file:../ws", "git+https://example.invalid/ws.git",
    "9007199254740992.21.0",
  ]) {
    assert.throws(() => assertPatchedVersion(unsafe, ADVISORY_FLOOR, "ws"), { code: "ERR_ASSERTION" });
  }
  for (const safe of ["8.21.0", "8.21.3", "8.22.0", "9.0.0"]) {
    assertPatchedVersion(safe, ADVISORY_FLOOR, "ws");
  }
});

test("SEC-04: der Code-Floor ist mindestens der Advisory-Floor", () => {
  // Der Laufzeit-Guard darf nie unter die gepatchte Version fallen.
  assertPatchedVersion(MIN_WS_VERSION, ADVISORY_FLOOR, "MIN_WS_VERSION");
});

test("SEC-04: package.json pinnt ein gepatchtes stabiles ws", () => {
  assertPatchedVersion(manifest.dependencies?.ws, MIN_WS_VERSION, "package.json ws");
});

test("SEC-04: overrides erzwingen dieselbe ws-Version fuer transitive Kopien", () => {
  // Ohne Override koennte eine beliebige (auch kuenftige) transitive
  // Abhaengigkeit eine eigene, verwundbare ws-Kopie verschachtelt mitbringen.
  const override = manifest.overrides?.ws;
  assertPatchedVersion(override, MIN_WS_VERSION, "package.json overrides.ws");
  assert.equal(override, manifest.dependencies?.ws, "overrides.ws muss dem direkten Pin entsprechen");
});

test("SEC-04: Lockfile, Root-Spezifikation und Release-Version sind konsistent", () => {
  assert.equal(lock.lockfileVersion, 3);
  const root = lock.packages[""];
  assert.ok(root, "Root-Eintrag fehlt");
  assert.equal(lock.version, manifest.version);
  assert.equal(root.version, manifest.version);
  assert.equal(root.dependencies?.ws, manifest.dependencies?.ws, "Lockfile-Drift gegen den exakten Pin");
  const ws = lock.packages["node_modules/ws"];
  assert.ok(ws, "ws fehlt im Lockfile");
  assertPatchedVersion(ws.version, MIN_WS_VERSION, "Lockfile ws");
  assert.equal(ws.version, manifest.dependencies?.ws, "Lockfile-Version weicht vom Pin ab");
  assertRegistryArtifact(ws, "ws", "node_modules/ws");
});

test("SEC-04: keine verwundbare ws-Kopie im Lockfile, auch nicht verschachtelt oder aliased", () => {
  let found = 0;
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location) continue;
    // npm-Aliase koennen einen anderen Installationspfad als Paketnamen haben.
    const name = entry.name ?? location.split("node_modules/").at(-1)!;
    if (name !== "ws") continue;
    found += 1;
    assertPatchedVersion(entry.version, MIN_WS_VERSION, location);
    assertRegistryArtifact(entry, "ws", location);
  }
  assert.ok(found >= 1, "ws fehlt vollstaendig im Lockfile");
});

test("SEC-04: tatsaechlich installiertes ws entspricht dem Lockfile und ist gepatcht", () => {
  const file = resolvedManifest(requireFromRoot, "ws");
  const installed = JSON.parse(readFileSync(file, "utf8")) as PackageEntry;
  const location = path.relative(ROOT, path.dirname(file)).split(path.sep).join("/");
  assertPatchedVersion(installed.version, MIN_WS_VERSION, location);
  assert.equal(installed.version, lock.packages[location]?.version, `${location}: npm ci erforderlich`);
});

test("SEC-04: @types/ws bleibt auf der Major-Linie der Laufzeit", () => {
  // Typen duerfen nicht auf eine andere Major-Linie driften — sonst prueft der
  // Typecheck eine API, die zur Laufzeit gar nicht installiert ist.
  const types = manifest.devDependencies?.["@types/ws"];
  assert.ok(typeof types === "string", "@types/ws fehlt");
  assert.match(types, new RegExp(`^\\^?${WS_MAJOR}\\.`), "@types/ws: fremde Major-Linie");
  const runtime = manifest.dependencies?.ws;
  assert.ok(typeof runtime === "string" && runtime.startsWith(`${WS_MAJOR}.`), "ws: unerwartete Major-Linie");
});

test("SEC-04: das ws-Gate ist verbindlich vor dem Live-Gate verdrahtet", () => {
  assert.match(manifest.scripts["test:security:ws"], /--test "tests\/sec04\.\*\.test\.ts"/);
  assert.match(manifest.scripts["security:live-gate"], /npm run test:security:ws &&/);
  for (const workflow of [".github/workflows/security-live-gate.yml", "docs/ci/security-live-gate.workflow.yml"]) {
    const content = read(workflow);
    assert.ok(content.includes("npm run test:security:ws"), `${workflow}: SEC-04-Gate fehlt`);
    assert.ok(content.includes("npm ls ws --all"), `${workflow}: Baumpruefung auf ws fehlt`);
  }
});
