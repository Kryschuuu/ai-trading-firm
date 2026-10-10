import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  codeVersionHeaderIssues,
  documentedCodePathSymbolIssues,
  documentedEnvReadIssues,
  envReadsFromCode,
  processEnvPropertyReads,
  undocumentedProcessEnvReads,
  undocumentedRoutes,
  type TextFile,
} from "../scripts/docs-validate-checks";

const emptyAllowlist = new Map<string, string>();
const emptyHistoricalDocs = new Map<string, string>();

function flagTable(flag: string): TextFile[] {
  return [{
    filePath: "CONFIGURATION.md",
    content: [
      "# Config",
      "",
      "| Flag | Default | Meaning |",
      "| --- | --- | --- |",
      `| \`${flag}\` | — | Fixture flag |`,
    ].join("\n"),
  }];
}

test("L1 counterprobe: documented Env reads require an AST-visible read; reset returns green", () => {
  const documents = flagTable("DOCS_VALIDATE_L1_FLAG");
  const realReader: TextFile[] = [{
    filePath: "src/runtime.ts",
    content: [
      'const RUNTIME_FLAG = "DOCS_VALIDATE_L1_FLAG";',
      'const KEY_NAME = "DOCS_VALIDATE_L1_FLAG";',
      "function readSetting(env: Record<string, string | undefined>, key: string) {",
      "  return env[key];",
      "}",
      "class EnvSecretStore {",
      "  constructor(private readonly env: Record<string, string | undefined>) {}",
      "  get(name: string) { return this.env[name]; }",
      "}",
      "export const setting = readSetting(process.env, RUNTIME_FLAG);",
      "export const secret = new EnvSecretStore(process.env).get(KEY_NAME);",
    ].join("\n"),
  }];
  const dynamicSecretReader: TextFile[] = [{
    filePath: "src/secrets.ts",
    content: [
      'const KEY_NAME = "DOCS_VALIDATE_L1_FLAG";',
      "class EnvSecretStore {",
      "  constructor(private readonly env: Record<string, string | undefined>) {}",
      "  get(name: string) { return this.env[name]; }",
      "}",
      "export const secret = new EnvSecretStore(process.env).get(KEY_NAME);",
    ].join("\n"),
  }];
  assert.ok(
    envReadsFromCode(dynamicSecretReader).has("DOCS_VALIDATE_L1_FLAG"),
    "`this.env[name]` resolves a static credential key at its get() call site",
  );

  const realReads = envReadsFromCode(realReader);
  assert.ok(realReads.has("DOCS_VALIDATE_L1_FLAG"));
  assert.deepEqual(
    documentedEnvReadIssues(documents, realReads, "", emptyAllowlist),
    [],
    "baseline: a statically identified helper read satisfies L1",
  );

  // Intentional break: leave the same spelling in a comment, but remove the
  // only runtime read. A text-presence scanner would incorrectly stay green.
  const brokenReader: TextFile[] = [{
    ...realReader[0],
    content: [
      'const RUNTIME_FLAG = "DOCS_VALIDATE_L1_FLAG";',
      "// DOCS_VALIDATE_L1_FLAG is mentioned, but is no longer read.",
      "export const setting = undefined;",
    ].join("\n"),
  }];
  const brokenIssues = documentedEnvReadIssues(
    documents,
    envReadsFromCode(brokenReader),
    "",
    emptyAllowlist,
  );
  assert.match(brokenIssues[0]?.detail ?? "", /dokumentiertes Env-Flag 'DOCS_VALIDATE_L1_FLAG'/);

  // Counterprobe reset: restore the actual `env[key]` call and require green.
  assert.deepEqual(
    documentedEnvReadIssues(documents, envReadsFromCode(realReader), "", emptyAllowlist),
    [],
  );
});

test("L2 counterprobe: undocumented Env/route drift warns, then clears after docs are restored", () => {
  const documented = "CONFIGURATION.md: KNOWN_RUNTIME_FLAG\n/api/known";
  const stableCode: TextFile[] = [{
    filePath: "src/runtime.ts",
    content: "export const enabled = process.env.KNOWN_RUNTIME_FLAG;",
  }];
  assert.deepEqual(
    undocumentedProcessEnvReads(envReadsFromCode(stableCode), documented),
    [],
    "baseline Env read is documented",
  );
  assert.deepEqual(undocumentedRoutes(new Set(["/api/known"]), documented), []);

  // Intentional break: add a real Env read and route but omit both from docs.
  const brokenCode: TextFile[] = [{
    ...stableCode[0],
    content: `${stableCode[0].content}\nexport const extra = process.env.UNLISTED_RUNTIME_FLAG;`,
  }];
  const envWarnings = undocumentedProcessEnvReads(envReadsFromCode(brokenCode), documented);
  assert.ok(envWarnings.some((warning) => warning.includes("UNLISTED_RUNTIME_FLAG")));
  const routeWarnings = undocumentedRoutes(
    new Set(["/api/known", "/api/unlisted"]),
    documented,
  );
  assert.ok(routeWarnings.some((warning) => warning.includes("/api/unlisted")));

  // Counterprobe reset: restore both code and documentation coverage.
  const restoredDocs = `${documented}\nUNLISTED_RUNTIME_FLAG\n/api/unlisted`;
  assert.deepEqual(undocumentedProcessEnvReads(envReadsFromCode(brokenCode), restoredDocs), []);
  assert.deepEqual(
    undocumentedRoutes(new Set(["/api/known", "/api/unlisted"]), restoredDocs),
    [],
  );
  assert.deepEqual(undocumentedProcessEnvReads(envReadsFromCode(stableCode), documented), []);
  assert.deepEqual(undocumentedRoutes(new Set(["/api/known"]), documented), []);

  // The warning collector intentionally handles dynamic Next route segments.
  assert.deepEqual(
    undocumentedRoutes(
      new Set(["/api/brokers/[venue]/health"]),
      "GET /api/brokers/{venue}/health",
    ),
    [],
  );
  assert.ok(processEnvPropertyReads(brokenCode).has("UNLISTED_RUNTIME_FLAG"));
});

test("L3 counterprobe: Code-Version follows package.json; Dokument-Version is independent", () => {
  const current: TextFile[] = [{
    filePath: "docs/active.md",
    content: "> Status · Code-Version **v0.17.2** · Dokument-Version **v4.2**",
  }];
  assert.deepEqual(codeVersionHeaderIssues(current, "0.17.2"), [], "baseline version matches package.json");

  const broken: TextFile[] = [{
    ...current[0],
    content: "> Status · Code-Version **v0.17.1** · Dokument-Version **v4.2**",
  }];
  assert.match(
    codeVersionHeaderIssues(broken, "0.17.2")[0]?.detail ?? "",
    /Code-Version v0\.17\.1 != package\.json 0\.17\.2/,
  );

  // Counterprobe reset and explicit Dokument-Version-only allowance.
  assert.deepEqual(codeVersionHeaderIssues(current, "0.17.2"), []);
  assert.deepEqual(
    codeVersionHeaderIssues([{
      filePath: "docs/schema.md",
      content: "# Schema\n\n> **Dokument-Version:** v4.2 (keine Code-Version)",
    }], "0.17.2"),
    [],
  );
});

test("L4 counterprobe: concrete paths and named exports validate, broken refs fail, reset clears", () => {
  const repositoryRoot = mkdtempSync(path.join(tmpdir(), "docs-validate-l4-"));
  try {
    const sourcePath = path.join(repositoryRoot, "src/contracts/demo.ts");
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, "export const PublicDemo = 1;\nconst InternalDemo = 2;\n", "utf8");

    const validDocs: TextFile[] = [{
      filePath: "docs/contracts.md",
      content: [
        "Implementation: `src/contracts/demo.ts:1-2` (`PublicDemo`).",
        "Source group: `src/contracts/*.ts`.",
      ].join("\n"),
    }];
    const check = (documents: readonly TextFile[]) =>
      documentedCodePathSymbolIssues(
        documents,
        repositoryRoot,
        emptyAllowlist,
        emptyHistoricalDocs,
      );
    assert.deepEqual(check(validDocs), [], "baseline path, glob, line suffix, and named export exist");

    // Intentional break: one missing file and one private/non-exported symbol.
    const brokenDocs: TextFile[] = [{
      ...validDocs[0],
      content: [
        "Missing: `src/contracts/missing.ts`.",
        "Not exported: `src/contracts/demo.ts` (`InternalDemo`).",
      ].join("\n"),
    }];
    const brokenIssues = check(brokenDocs);
    assert.ok(brokenIssues.some((issue) => issue.detail.includes("src/contracts/missing.ts")));
    assert.ok(brokenIssues.some((issue) => issue.detail.includes("InternalDemo")));

    // Counterprobe reset: restore the original path/export claims.
    assert.deepEqual(check(validDocs), []);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});
