#!/usr/bin/env node
/**
 * Synchronisiert und prueft die CI-Workflow-Spiegel (`docs/ci/*.workflow.yml`
 * <-> `.github/workflows/*.yml`), das SEC-10-SHA-Pinning sowie die
 * Multi-Directory-Konfiguration in `.github/dependabot.yml`.
 *
 * Hintergrund:
 *   - `docs/ci/` haelt die versionierten Workflow-Quellen fuer Verbindungen
 *     ohne `workflows`-Schreibrecht; `.github/workflows/` ist der von GitHub
 *     Actions ausgefuehrte Spiegel.
 *   - Zuvor pruefte nur ein roher `diff -u`-Schritt in CI die Byte-Gleichheit,
 *     waehrend `.github/dependabot.yml` lediglich `directory: /` konfigurierte
 *     und bei jedem Action-Update nur `.github/workflows/` aktualisierte (PR #243).
 *
 * Gepruefte Invarianten (`--check` und eingebunden in `npm run docs:validate`):
 *   1. Spiegel-Paritaet: Jedes registrierte Paar ist byte-identisch und nutzt
 *      LF-Zeilenenden.
 *   2. Spiegel-Vollstaendigkeit: Keine verwaisten `.yml`/`.yaml`-Dateien in
 *      `docs/ci/` oder `.github/workflows/`.
 *   3. SEC-10-Pinning: Jede externe `uses:`-Referenz ist auf einen vollstaendigen
 *      40-stelligen Kleinbuchstaben-Commit-SHA gepinnt und traegt einen
 *      Versionskommentar (`# vX.Y.Z`).
 *   4. Dependabot-Abdeckung: `.github/dependabot.yml` deckt ueber `directories`
 *      sowohl `"/"` (bzw. `"/.github/workflows"`) als auch `"/docs/ci"` ab und
 *      gruppiert sowohl `version-updates` als auch `security-updates`, damit
 *      Dependabot nie wieder nur eine Seite aktualisiert.
 *
 * Aufruf:
 *   npm run ci:sync                         # docs/ci/ -> .github/workflows/
 *   npm run ci:sync -- --from=github        # .github/workflows/ -> docs/ci/
 *   npm run ci:sync:check                   # Pruefung ohne Schreibzugriff
 *   npm run ci:sync:check -- --gha          # Pruefung mit ::error::-Annotationen
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface WorkflowMirrorPair {
  readonly canonical: string;
  readonly mirror: string;
}

export interface CiWorkflowIssue {
  readonly filePath: string;
  readonly detail: string;
}

export interface CiWorkflowCheckResult {
  readonly ok: boolean;
  readonly issues: readonly CiWorkflowIssue[];
}

export type SyncDirection = "docs" | "github";

export const WORKFLOW_MIRRORS: readonly WorkflowMirrorPair[] = [
  {
    canonical: "docs/ci/docs-validate.workflow.yml",
    mirror: ".github/workflows/main.yml",
  },
  {
    canonical: "docs/ci/security-live-gate.workflow.yml",
    mirror: ".github/workflows/security-live-gate.yml",
  },
];

const PINNED_ACTION_RE =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}\s+#\s*v\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?\b/;

function listYamlFiles(dirPath: string, repoRoot: string): string[] {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => path.posix.join(path.relative(repoRoot, dirPath).split(path.sep).join("/"), entry.name))
    .sort();
}

function firstDiffSummary(leftText: string, rightText: string): string {
  const leftLines = leftText.split("\n");
  const rightLines = rightText.split("\n");
  const max = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < max; i++) {
    const a = leftLines[i];
    const b = rightLines[i];
    if (a !== b) {
      const leftPreview = a === undefined ? "<EOF>" : a.trim();
      const rightPreview = b === undefined ? "<EOF>" : b.trim();
      return `Zeile ${i + 1} weicht ab (Quelle: "${leftPreview}" vs. Spiegel: "${rightPreview}")`;
    }
  }
  return "Byte-Inhalt weicht ab";
}

function validateWorkflowActionPins(relPath: string, content: string): CiWorkflowIssue[] {
  const issues: CiWorkflowIssue[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*#/.test(line)) continue;
    const match = line.match(/^\s*(?:-\s*)?uses:\s*(.+?)\s*$/);
    if (!match) continue;
    const rawTarget = match[1];
    if (rawTarget.startsWith("./")) continue;
    if (!PINNED_ACTION_RE.test(rawTarget)) {
      issues.push({
        filePath: relPath,
        detail:
          `Zeile ${index + 1}: SEC-10 verletzt — 'uses: ${rawTarget}' muss auf einen ` +
          `40-stelligen Kleinbuchstaben-SHA mit Versionskommentar ('# vX.Y.Z') gepinnt sein.`,
      });
    }
  }
  return issues;
}

function validateDependabotConfig(repoRoot: string): CiWorkflowIssue[] {
  const relPath = ".github/dependabot.yml";
  const fullPath = path.join(repoRoot, relPath);
  if (!existsSync(fullPath)) {
    return [{ filePath: relPath, detail: "Datei fehlt (SEC-10 verlangt rotierende Action-SHA-Updates)." }];
  }
  const content = readFileSync(fullPath, "utf8");
  const issues: CiWorkflowIssue[] = [];

  if (content.includes("\r")) {
    issues.push({ filePath: relPath, detail: "Enthaelt CR-Zeilenenden (nur LF erlaubt)." });
  }

  const uncommented = content
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  if (!/\bpackage-ecosystem:\s*["']?github-actions["']?\b/.test(uncommented)) {
    issues.push({
      filePath: relPath,
      detail: "Oekosystem 'github-actions' fehlt in .github/dependabot.yml.",
    });
  }

  if (/^\s*directory:\s*/m.test(uncommented)) {
    issues.push({
      filePath: relPath,
      detail:
        "Einzelnes 'directory:' statt 'directories:' konfiguriert — Dependabot wuerde docs/ci/ nicht mitziehen.",
    });
  }

  const directoriesBlock = uncommented.match(/directories:\s*\n((?:\s*-\s*[^\n]+\n?)+)/);
  if (!directoriesBlock) {
    issues.push({
      filePath: relPath,
      detail: "'directories:'-Liste fehlt; erwartet '/' (bzw. '/.github/workflows') UND '/docs/ci'.",
    });
  } else {
    const entries = [...directoriesBlock[1].matchAll(/^\s*-\s*["']?([^"'\s#]+)["']?\s*$/gm)].map((m) => m[1]);
    const hasWorkflowsRoot = entries.includes("/") || entries.includes("/.github/workflows");
    const hasDocsCi = entries.includes("/docs/ci");
    if (!hasWorkflowsRoot || !hasDocsCi) {
      issues.push({
        filePath: relPath,
        detail:
          `'directories:' muss sowohl '/' (oder '/.github/workflows') als auch '/docs/ci' enthalten ` +
          `(gefunden: [${entries.join(", ")}]).`,
      });
    }
  }

  if (!/\bgroups:\s*\n/.test(uncommented)) {
    issues.push({
      filePath: relPath,
      detail: "'groups:' fehlt — Updates ueber mehrere Verzeichnisse muessen in einem gemeinsamen PR gebuendelt werden.",
    });
  }

  if (!/\bapplies-to:\s*["']?security-updates["']?\b/.test(uncommented)) {
    issues.push({
      filePath: relPath,
      detail:
        "Keine Gruppe mit 'applies-to: security-updates' konfiguriert — Dependabot-Security-PRs wuerden die Verzeichnisse getrennt aktualisieren.",
    });
  }

  return issues;
}

export function checkCiWorkflows(repoRoot: string = process.cwd()): CiWorkflowCheckResult {
  const issues: CiWorkflowIssue[] = [];

  const expectedCanonical = new Set(WORKFLOW_MIRRORS.map((pair) => pair.canonical));
  const expectedMirror = new Set(WORKFLOW_MIRRORS.map((pair) => pair.mirror));

  for (const file of listYamlFiles(path.join(repoRoot, "docs", "ci"), repoRoot)) {
    if (!expectedCanonical.has(file)) {
      issues.push({
        filePath: file,
        detail: "Nicht in WORKFLOW_MIRRORS registrierte Workflow-Quelle unter docs/ci/.",
      });
    }
  }

  for (const file of listYamlFiles(path.join(repoRoot, ".github", "workflows"), repoRoot)) {
    if (!expectedMirror.has(file)) {
      issues.push({
        filePath: file,
        detail: "Nicht in WORKFLOW_MIRRORS registrierter Workflow unter .github/workflows/ (Spiegel in docs/ci/ fehlt).",
      });
    }
  }

  for (const pair of WORKFLOW_MIRRORS) {
    const canonicalAbs = path.join(repoRoot, pair.canonical);
    const mirrorAbs = path.join(repoRoot, pair.mirror);
    const hasCanonical = existsSync(canonicalAbs);
    const hasMirror = existsSync(mirrorAbs);

    if (!hasCanonical) {
      issues.push({ filePath: pair.canonical, detail: `Kanonische Workflow-Quelle fehlt (Spiegel: ${pair.mirror}).` });
    }
    if (!hasMirror) {
      issues.push({ filePath: pair.mirror, detail: `Workflow-Spiegel fehlt (Quelle: ${pair.canonical}).` });
    }
    if (!hasCanonical || !hasMirror) continue;

    const canonicalText = readFileSync(canonicalAbs, "utf8");
    const mirrorText = readFileSync(mirrorAbs, "utf8");

    if (canonicalText.includes("\r")) {
      issues.push({ filePath: pair.canonical, detail: "Enthaelt CR-Zeilenenden (nur LF erlaubt)." });
    }
    if (mirrorText.includes("\r")) {
      issues.push({ filePath: pair.mirror, detail: "Enthaelt CR-Zeilenenden (nur LF erlaubt)." });
    }

    if (canonicalText !== mirrorText) {
      issues.push({
        filePath: pair.mirror,
        detail:
          `Spiegel weicht von ${pair.canonical} ab: ${firstDiffSummary(canonicalText, mirrorText)}. ` +
          `Behebung: 'npm run ci:sync' (Quelle docs/ci -> .github/workflows) oder ` +
          `'npm run ci:sync -- --from=github' (.github/workflows -> docs/ci).`,
      });
    }

    issues.push(...validateWorkflowActionPins(pair.canonical, canonicalText));
    if (canonicalText !== mirrorText) {
      issues.push(...validateWorkflowActionPins(pair.mirror, mirrorText));
    }
  }

  issues.push(...validateDependabotConfig(repoRoot));

  return {
    ok: issues.length === 0,
    issues,
  };
}

export function syncCiWorkflows(
  repoRoot: string = process.cwd(),
  from: SyncDirection = "docs",
): readonly string[] {
  const updated: string[] = [];
  for (const pair of WORKFLOW_MIRRORS) {
    const sourceRel = from === "docs" ? pair.canonical : pair.mirror;
    const targetRel = from === "docs" ? pair.mirror : pair.canonical;
    const sourceAbs = path.join(repoRoot, sourceRel);
    const targetAbs = path.join(repoRoot, targetRel);

    if (!existsSync(sourceAbs)) {
      throw new Error(`Quelldatei fehlt: ${sourceRel}`);
    }
    const normalized = readFileSync(sourceAbs, "utf8").replace(/\r\n/g, "\n");
    const existing = existsSync(targetAbs) ? readFileSync(targetAbs, "utf8") : null;
    if (existing !== normalized) {
      mkdirSync(path.dirname(targetAbs), { recursive: true });
      writeFileSync(targetAbs, normalized, "utf8");
      updated.push(targetRel);
    }
    if (readFileSync(sourceAbs, "utf8") !== normalized) {
      writeFileSync(sourceAbs, normalized, "utf8");
      updated.push(sourceRel);
    }
  }
  return updated;
}

function runCli(argv: readonly string[]): number {
  const checkOnly = argv.includes("--check");
  const emitGha = argv.includes("--gha");
  const fromArg = argv.find((arg) => arg.startsWith("--from="))?.slice("--from=".length);

  if (fromArg !== undefined && fromArg !== "docs" && fromArg !== "github") {
    console.error(`[ci:sync] Ungueltiger Parameter --from=${fromArg} (erlaubt: docs | github).`);
    return 2;
  }

  const direction: SyncDirection = fromArg === "github" ? "github" : "docs";

  if (!checkOnly) {
    const updated = syncCiWorkflows(process.cwd(), direction);
    if (updated.length === 0) {
      console.log("[ci:sync] Alle Workflow-Spiegel waren bereits byte-identisch.");
    } else {
      console.log(`[ci:sync] Synchronisiert (--from=${direction}): ${updated.join(", ")}`);
    }
  }

  const result = checkCiWorkflows(process.cwd());
  if (result.ok) {
    console.log(
      `[ci:sync] OK — ${WORKFLOW_MIRRORS.length} Workflow-Spiegelpaare, SEC-10-SHA-Pins und Dependabot-Konfiguration konsistent.`,
    );
    return 0;
  }

  console.error(`[ci:sync] FEHLER — ${result.issues.length} Abweichung(en):`);
  for (const issue of result.issues) {
    console.error(`  - ${issue.filePath}: ${issue.detail}`);
    if (emitGha) {
      const escaped = issue.detail.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
      console.error(`::error file=${issue.filePath}::${escaped}`);
    }
  }
  return 1;
}

const isDirectExecution =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  process.exit(runCli(process.argv.slice(2)));
}
