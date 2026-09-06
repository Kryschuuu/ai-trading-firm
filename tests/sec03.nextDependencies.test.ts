/**
 * SEC-03: Dependency-Gate ohne Registry-/Netzwerkabhaengigkeit.
 *
 * 16.3.3 sperrte AVIF voruebergehend; 16.3.4 aktiviert es mit sharp 0.35.4
 * wieder. Deshalb reicht eine Next-Versionspruefung allein nicht aus:
 * Manifest, gesamtes Lockfile (auch Windows-Binaries) und geladener Decoder
 * muessen zusammen den Patch enthalten. Kein eigener SemVer-Range-Parser:
 * fuer Next erlauben wir bewusst nur exakt gepinnte stabile Releases.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { getSharp } from "next/dist/server/image-optimizer";

const MIN_NEXT = "16.3.4";
const MIN_SHARP = "0.35.4";
const MIN_SHARP_LIBVIPS = "1.3.3";
const MIN_LIBHEIF = "1.23.2";

interface PackageEntry {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
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

test("SEC-03: Versions-Gate lehnt Downgrades, Ranges, Aliase und Prereleases ab", () => {
  for (const unsafe of [
    undefined, null, 16, "", "16.3.1", "16.3.2", "16.3.3", "15.5.24",
    "^16.3.1", "^16.3.4", "~16.3.4", ">=16.3.4", "16.x", "*", "latest",
    "16.3.4-canary.0", "16.3.4+local", "16.3.4 || 16.3.1", "16.03.4",
    "npm:next@16.3.4", "file:../next", "git+https://example.invalid/next.git",
    "9007199254740992.3.4",
  ]) {
    assert.throws(() => assertPatchedVersion(unsafe, MIN_NEXT, "next"), { code: "ERR_ASSERTION" });
  }
  for (const safe of ["16.3.4", "16.3.10", "16.10.0", "17.0.0"]) {
    assertPatchedVersion(safe, MIN_NEXT, "next");
  }
});

test("SEC-03: package.json pinnt ein gepatchtes stabiles Next.js", () => {
  assertPatchedVersion(manifest.dependencies?.next, MIN_NEXT, "package.json next");
});

test("SEC-03: Lockfile, Root-Spezifikation und Release-Version sind konsistent", () => {
  assert.equal(lock.lockfileVersion, 3);
  const root = lock.packages[""];
  assert.ok(root, "Root-Eintrag fehlt");
  assert.equal(lock.version, manifest.version);
  assert.equal(root.version, manifest.version);
  assert.equal(root.dependencies?.next, manifest.dependencies?.next);
  const next = lock.packages["node_modules/next"];
  assert.ok(next, "Next fehlt im Lockfile");
  assertPatchedVersion(next.version, MIN_NEXT, "Lockfile next");
  assert.equal(next.version, manifest.dependencies?.next, "Lockfile-Drift gegen den exakten Pin");
});

test("SEC-03: keine alte Next-/Decoder-Kopie im Lockfile, auch nicht verschachtelt oder fuer andere OS", () => {
  const found = new Set<string>();
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location) continue;
    // npm-Aliase koennen einen anderen Installationspfad als Paketnamen haben.
    const name = entry.name ?? location.split("node_modules/").at(-1)!;
    let minimum: string | undefined;
    if (name === "next") minimum = MIN_NEXT;
    else if (name === "sharp") minimum = MIN_SHARP;
    else if (name.startsWith("@img/sharp-libvips-")) minimum = MIN_SHARP_LIBVIPS;
    else if (name.startsWith("@img/sharp-")) minimum = MIN_SHARP;
    if (!minimum) continue;
    found.add(name);
    assertPatchedVersion(entry.version, minimum, location);
    assertRegistryArtifact(entry, name, location);
  }
  for (const name of ["next", "sharp", "@img/sharp-win32-x64", "@img/sharp-libvips-linux-x64"]) {
    assert.ok(found.has(name), `${name}: plattformuebergreifender Lock-Eintrag fehlt`);
  }
});

test("SEC-03: Next-Runtime-Pakete und SWC-Binaries folgen dem Framework-Pin", () => {
  const next = lock.packages["node_modules/next"];
  assert.ok(next);
  const companions = { ...next.dependencies, ...next.optionalDependencies };
  assert.ok(companions["@next/env"]);
  assert.ok(companions["@next/swc-win32-x64-msvc"]);
  for (const [name, version] of Object.entries(companions)) {
    if (name !== "@next/env" && !name.startsWith("@next/swc-")) continue;
    assert.equal(version, next.version, `${name}: abweichende Runtime-Version`);
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `${name}: fehlt im Lockfile`);
    assert.equal(entry.version, version, `${name}: abweichendes Binary im Lockfile`);
    assertRegistryArtifact(entry, name, name);
  }
});

test("SEC-03: tatsaechlich aufgeloestes Next und dessen sharp stimmen mit dem Lockfile ueberein", () => {
  const nextManifestPath = requireFromRoot.resolve("next/package.json");
  const requireFromNext = createRequire(nextManifestPath);
  for (const [file, minimum] of [
    [nextManifestPath, MIN_NEXT],
    [resolvedManifest(requireFromNext, "sharp"), MIN_SHARP],
  ]) {
    const installed = JSON.parse(readFileSync(file, "utf8")) as PackageEntry;
    const location = path.relative(ROOT, path.dirname(file)).split(path.sep).join("/");
    assertPatchedVersion(installed.version, minimum, location);
    assert.equal(installed.version, lock.packages[location]?.version, `${location}: npm ci erforderlich`);
  }
});

test("SEC-03: Dependency- und Framework-Regressionen sind Pflicht vor dem Live-Gate", () => {
  assert.match(manifest.scripts["security:live-gate"], /^npm run test:security:next && /);
  assert.match(manifest.scripts["test:security:next"], /--test "tests\/sec03\.\*\.test\.ts"/);
});

test("SEC-03: der von Next geladene native AVIF-Decoder enthaelt den libheif-Fix", () => {
  // Wichtig auch bei globalem/custom libvips: Paketversion != geladene Library.
  // GHSA-2xp9-vwfh-vxw4 / GHSA-g89c-p67h-r497. Keine RCE-Datei wird dekodiert.
  const { versions } = getSharp(1, false);
  assertPatchedVersion(versions.heif, MIN_LIBHEIF, "geladenes libheif");
  assertPatchedVersion(versions.sharp, MIN_SHARP, "geladenes sharp");
});
