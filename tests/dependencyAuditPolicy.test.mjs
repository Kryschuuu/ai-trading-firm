import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateDependencyAudit } from "../scripts/dependency-audit.mjs";

const advisory = {
  name: "braces",
  dependency: "braces",
  title: "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
  url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
  severity: "high",
  range: "<=3.0.3",
};
const chain = [
  { name: "eslint-config-next", version: "16.2.6", dependency: "@next/eslint-plugin-next", range: "16.2.6" },
  { name: "@next/eslint-plugin-next", version: "16.2.6", dependency: "fast-glob", range: "3.3.1" },
  { name: "fast-glob", version: "3.3.1", dependency: "micromatch", range: "^4.0.4" },
  { name: "micromatch", version: "4.0.8", dependency: "braces", range: "^3.0.3" },
  { name: "braces", version: "3.0.3", dependency: null, range: null },
];
const policyPath = new URL("../.github/dependency-audit-exceptions.json", import.meta.url);
const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const evaluationDate = new Date("2026-10-03T12:00:00.000Z");

function createLockfile() {
  const packages = {
    "": { devDependencies: { "eslint-config-next": "16.2.6" } },
  };

  for (const component of chain) {
    packages[`node_modules/${component.name}`] = {
      version: component.version,
      dev: true,
      ...(component.dependency
        ? { dependencies: { [component.dependency]: component.range } }
        : {}),
    };
  }

  return { lockfileVersion: 3, packages };
}

function createVulnerabilities() {
  const vulnerabilities = {};

  for (let index = 0; index < chain.length; index += 1) {
    const component = chain[index];
    const next = chain[index + 1];
    const previous = chain[index - 1];
    vulnerabilities[component.name] = {
      severity: "high",
      isDirect: index === 0,
      via: next ? [next.name] : [{ ...advisory }],
      effects: previous ? [previous.name] : [],
      range: component.name === "eslint-config-next" ? ">=14.3.0-canary.0" : "*",
      nodes: [`node_modules/${component.name}`],
    };
  }

  return vulnerabilities;
}

function createReport(vulnerabilities = {}) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const vulnerability of Object.values(vulnerabilities)) {
    counts[vulnerability.severity] += 1;
  }

  return {
    vulnerabilities,
    metadata: {
      vulnerabilities: { ...counts, total: Object.keys(vulnerabilities).length },
    },
  };
}

function evaluate({
  exitCode = 1,
  report = createReport(createVulnerabilities()),
  lockfile = createLockfile(),
  exceptionPolicy = structuredClone(policy),
  now = evaluationDate,
} = {}) {
  return evaluateDependencyAudit({ exitCode, report, lockfile, policy: exceptionPolicy, now });
}

test("accepts a clean high-severity audit", () => {
  const result = evaluate({ exitCode: 0, report: createReport() });
  assert.deepEqual(result, { allowedException: false, exceptionId: null });
});

test("accepts a clean audit after the temporary exception is removed", () => {
  const exceptionPolicy = structuredClone(policy);
  exceptionPolicy.exceptions = [];

  assert.deepEqual(
    evaluate({ exitCode: 0, report: createReport(), exceptionPolicy }),
    { allowedException: false, exceptionId: null },
  );
});

test("allows only the documented GHSA in the exact dev-only dependency chain", () => {
  assert.deepEqual(evaluate(), {
    allowedException: true,
    exceptionId: "GHSA-vfj7-8cjw-p6xm",
    expiresOn: "2026-10-17",
  });
});

test("blocks high-severity findings if the exception has been removed", () => {
  const exceptionPolicy = structuredClone(policy);
  exceptionPolicy.exceptions = [];

  assert.throws(() => evaluate({ exceptionPolicy }), /no dependency-audit exception is configured/);
});

test("blocks any additional high-severity package", () => {
  const vulnerabilities = createVulnerabilities();
  vulnerabilities["other-package"] = {
    severity: "high",
    isDirect: false,
    via: ["unreviewed-advisory"],
    effects: [],
    nodes: ["node_modules/other-package"],
  };

  assert.throws(
    () => evaluate({ report: createReport(vulnerabilities) }),
    /only the exact reviewed braces chain is permitted/,
  );
});

test("blocks a changed advisory identity or affected range", () => {
  const vulnerabilities = createVulnerabilities();
  vulnerabilities.braces.via[0].url = "https://github.com/advisories/GHSA-not-the-reviewed-one";

  assert.throws(() => evaluate({ report: createReport(vulnerabilities) }), /advisory details changed/);
});

test("blocks the exception if any link is no longer development-only", () => {
  const lockfile = createLockfile();
  lockfile.packages["node_modules/braces"].dev = false;

  assert.throws(() => evaluate({ lockfile }), /development-only/);
});

test("blocks an expired exception", () => {
  const exceptionPolicy = structuredClone(policy);
  exceptionPolicy.exceptions[0].expiresOn = "2026-10-02";

  assert.throws(() => evaluate({ exceptionPolicy }), /expired/);
});

test("limits renewals to 14 days", () => {
  const exceptionPolicy = structuredClone(policy);
  exceptionPolicy.exceptions[0].expiresOn = "2026-11-01";

  assert.throws(() => evaluate({ exceptionPolicy }), /may not be renewed for more than 14 days/);
});

test("fails closed when npm reports an error instead of an audit", () => {
  assert.throws(
    () => evaluate({ exitCode: 1, report: { error: { code: "ENOAUDIT" } } }),
    /npm audit failed/,
  );
});
