/**
 * Regressions- und Counterprobe-Suite fuer die CI-Workflow-Spiegelung,
 * das SEC-10-SHA-Pinning und die Multi-Directory-Dependabot-Konfiguration.
 *
 * Deckt u. a. den exakten Fehlerfall aus PR #243 ab (Dependabot aktualisierte
 * nur `.github/workflows/*`, nicht `docs/ci/*.workflow.yml`).
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { WORKFLOW_MIRRORS, checkCiWorkflows, syncCiWorkflows } from "../scripts/sync-ci-workflows";

function makeFixtureRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ci-workflow-sync-"));
  mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(path.join(root, "docs", "ci"), { recursive: true });
  cpSync(path.join(process.cwd(), ".github", "dependabot.yml"), path.join(root, ".github", "dependabot.yml"));
  for (const pair of WORKFLOW_MIRRORS) {
    cpSync(path.join(process.cwd(), pair.canonical), path.join(root, pair.canonical));
    cpSync(path.join(process.cwd(), pair.mirror), path.join(root, pair.mirror));
  }
  return root;
}

describe("CI-Workflow-Spiegel, SEC-10 & Dependabot", () => {
  test("Live-Repository: Spiegel byte-identisch, SEC-10-Pins gueltig, Dependabot deckt beide Verzeichnisse ab", () => {
    const res = checkCiWorkflows(process.cwd());
    assert.equal(res.ok, true, res.issues.map((i) => `${i.filePath}: ${i.detail}`).join(" | "));

    for (const pair of WORKFLOW_MIRRORS) {
      const canonical = readFileSync(path.join(process.cwd(), pair.canonical));
      const mirror = readFileSync(path.join(process.cwd(), pair.mirror));
      assert.equal(Buffer.compare(canonical, mirror), 0, `${pair.canonical} != ${pair.mirror}`);
    }
  });

  test("security-live-gate: beide npm-audit-Stufen sind fail-closed (kein continue-on-error)", () => {
    for (const rel of ["docs/ci/security-live-gate.workflow.yml", ".github/workflows/security-live-gate.yml"]) {
      const text = readFileSync(path.join(process.cwd(), rel), "utf8");
      assert.ok(text.includes("npm audit --audit-level=high --omit=dev"), `${rel}: Prod-Audit fehlt`);
      assert.ok(/^\s*run:\s*npm audit --audit-level=high\s*$/m.test(text), `${rel}: Gesamtbaum-Audit fehlt`);
      assert.equal(/continue-on-error\s*:\s*true/.test(text), false, `${rel}: continue-on-error verdeckt Advisories`);
    }
  });

  test("Counterprobe PR #243: einseitige Aenderung in .github/workflows bricht Check; Sync stellt Paritaet her", () => {
    const root = makeFixtureRepo();
    try {
      assert.equal(checkCiWorkflows(root).ok, true);

      // Simuliert PR #243: Dependabot aktualisiert nur .github/workflows/main.yml.
      const mirrorPath = path.join(root, ".github", "workflows", "main.yml");
      const original = readFileSync(mirrorPath, "utf8");
      const drifted = original.replace("# v7.1.0", "# v7.2.0");
      assert.notEqual(drifted, original);
      writeFileSync(mirrorPath, drifted, "utf8");

      const broken = checkCiWorkflows(root);
      assert.equal(broken.ok, false);
      assert.ok(
        broken.issues.some(
          (i) => i.filePath === ".github/workflows/main.yml" && i.detail.includes("Spiegel weicht von docs/ci/docs-validate.workflow.yml ab"),
        ),
      );

      // Richtung github -> docs uebernimmt den Stand aus .github/workflows/.
      const syncedToDocs = syncCiWorkflows(root, "github");
      assert.deepEqual(syncedToDocs, ["docs/ci/docs-validate.workflow.yml"]);
      assert.equal(checkCiWorkflows(root).ok, true);
      assert.equal(readFileSync(path.join(root, "docs", "ci", "docs-validate.workflow.yml"), "utf8"), drifted);

      // Richtung docs -> github spiegelt Aenderungen aus docs/ci/ zurueck.
      writeFileSync(path.join(root, "docs", "ci", "docs-validate.workflow.yml"), original, "utf8");
      assert.equal(checkCiWorkflows(root).ok, false);
      const syncedToGithub = syncCiWorkflows(root, "docs");
      assert.deepEqual(syncedToGithub, [".github/workflows/main.yml"]);
      assert.equal(checkCiWorkflows(root).ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Counterprobe Vollstaendigkeit: verwaiste Workflow-Datei wird erkannt", () => {
    const root = makeFixtureRepo();
    try {
      const orphan = path.join(root, ".github", "workflows", "extra.yml");
      writeFileSync(orphan, "name: extra\non: push\njobs: {}\n", "utf8");
      const broken = checkCiWorkflows(root);
      assert.equal(broken.ok, false);
      assert.ok(broken.issues.some((i) => i.filePath === ".github/workflows/extra.yml"));

      rmSync(orphan);
      assert.equal(checkCiWorkflows(root).ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Counterprobe SEC-10: beweglicher Tag oder fehlender Versionskommentar wird abgelehnt", () => {
    const root = makeFixtureRepo();
    try {
      const canonical = path.join(root, "docs", "ci", "docs-validate.workflow.yml");
      const original = readFileSync(canonical, "utf8");

      for (const badUses of [
        "uses: actions/checkout@v7",
        "uses: actions/checkout@main",
        "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      ]) {
        const mutated = original.replace(
          /uses:\s*actions\/checkout@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+/,
          badUses,
        );
        writeFileSync(canonical, mutated, "utf8");
        syncCiWorkflows(root, "docs");
        const res = checkCiWorkflows(root);
        assert.equal(res.ok, false, `erwartet Fehler fuer '${badUses}'`);
        assert.ok(res.issues.some((i) => i.detail.includes("SEC-10 verletzt")));
      }

      writeFileSync(canonical, original, "utf8");
      syncCiWorkflows(root, "docs");
      assert.equal(checkCiWorkflows(root).ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Counterprobe Dependabot: einzelnes directory: / oder fehlende security-updates-Gruppe wird abgelehnt", () => {
    const root = makeFixtureRepo();
    try {
      const depPath = path.join(root, ".github", "dependabot.yml");
      const original = readFileSync(depPath, "utf8");

      // Altkonfiguration vor dem Fix (nur `directory: /`, kein `/docs/ci`):
      writeFileSync(
        depPath,
        [
          "version: 2",
          "updates:",
          "  - package-ecosystem: github-actions",
          "    directory: /",
          "    schedule:",
          "      interval: weekly",
          "    groups:",
          "      actions:",
          '        patterns: ["*"]',
          "",
        ].join("\n"),
        "utf8",
      );
      const oldBroken = checkCiWorkflows(root);
      assert.equal(oldBroken.ok, false);
      assert.ok(oldBroken.issues.some((i) => i.detail.includes("Einzelnes 'directory:'")));
      assert.ok(oldBroken.issues.some((i) => i.detail.includes("security-updates")));

      // Nur `/` in directories ohne `/docs/ci`:
      writeFileSync(
        depPath,
        [
          "version: 2",
          "updates:",
          "  - package-ecosystem: github-actions",
          "    directories:",
          '      - "/"',
          "    schedule:",
          "      interval: weekly",
          "    groups:",
          "      actions:",
          "        applies-to: version-updates",
          '        patterns: ["*"]',
          "      actions-security:",
          "        applies-to: security-updates",
          '        patterns: ["*"]',
          "",
        ].join("\n"),
        "utf8",
      );
      const missingDocsCi = checkCiWorkflows(root);
      assert.equal(missingDocsCi.ok, false);
      assert.ok(missingDocsCi.issues.some((i) => i.detail.includes("'/docs/ci'")));

      writeFileSync(depPath, original, "utf8");
      assert.equal(checkCiWorkflows(root).ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
