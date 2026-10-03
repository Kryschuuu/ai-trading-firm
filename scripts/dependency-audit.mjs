import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = path.join(REPOSITORY_ROOT, ".github", "dependency-audit-exceptions.json");
const LOCKFILE_PATH = path.join(REPOSITORY_ROOT, "package-lock.json");
const ADVISORY = {
  id: "GHSA-vfj7-8cjw-p6xm",
  package: "braces",
  title: "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
  url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
  severity: "high",
  affectedRange: "<=3.0.3",
};

// Only this exact development-tool chain is temporarily allowlisted. Version,
// edge, lockfile-scope, and npm-audit topology changes fail closed for review.
const EXPECTED_CHAIN = [
  {
    name: "eslint-config-next",
    version: "16.2.6",
    dependency: "@next/eslint-plugin-next",
    dependencyRange: "16.2.6",
  },
  {
    name: "@next/eslint-plugin-next",
    version: "16.2.6",
    dependency: "fast-glob",
    dependencyRange: "3.3.1",
  },
  {
    name: "fast-glob",
    version: "3.3.1",
    dependency: "micromatch",
    dependencyRange: "^4.0.4",
  },
  {
    name: "micromatch",
    version: "4.0.8",
    dependency: "braces",
    dependencyRange: "^3.0.3",
  },
  { name: "braces", version: "3.0.3", dependency: null, dependencyRange: null },
];

const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const HIGH_OR_CRITICAL = new Set(["high", "critical"]);
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const MAX_EXCEPTION_DAYS = 14;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSameArray(actual, expected, message) {
  assert(
    Array.isArray(actual) &&
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]),
    `${message}; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function validateExceptionPolicy(policy, now) {
  assert(policy?.version === 1, "Unsupported dependency-audit exception policy version.");
  assert(Array.isArray(policy.exceptions), "Dependency-audit exceptions must be an array.");
  assert(
    policy.exceptions.length <= 1,
    "Expected at most one reviewed dependency-audit exception; update the policy and checker together.",
  );
  if (policy.exceptions.length === 0) return null;

  const [exception] = policy.exceptions;
  assert(exception.ghsaId === ADVISORY.id, `Unrecognized dependency-audit exception: ${exception.ghsaId}`);
  assert(
    typeof exception.reason === "string" && exception.reason.trim().length >= 20,
    `Exception ${ADVISORY.id} needs a documented reason.`,
  );
  assert(
    typeof exception.expiresOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(exception.expiresOn),
    `Exception ${ADVISORY.id} needs an ISO date in expiresOn.`,
  );

  const expiryStart = Date.parse(`${exception.expiresOn}T00:00:00.000Z`);
  assert(
    Number.isFinite(expiryStart) && new Date(expiryStart).toISOString().slice(0, 10) === exception.expiresOn,
    `Exception ${ADVISORY.id} has an invalid expiresOn date.`,
  );
  assert(
    now.getTime() < expiryStart + DAY_IN_MILLISECONDS,
    `Dependency-audit exception ${ADVISORY.id} expired on ${exception.expiresOn}; remove it after an upstream fix or renew it only after review.`,
  );
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  assert(
    expiryStart <= todayStart + MAX_EXCEPTION_DAYS * DAY_IN_MILLISECONDS,
    `Dependency-audit exceptions may not be renewed for more than ${MAX_EXCEPTION_DAYS} days at a time.`,
  );

  return exception;
}

function validateAuditEnvelope({ exitCode, report }) {
  assert(exitCode === 0 || exitCode === 1, `npm audit exited unexpectedly with status ${exitCode}.`);
  assert(report && typeof report === "object", "npm audit did not return a JSON report.");
  assert(!report.error, `npm audit failed: ${JSON.stringify(report.error)}`);

  const vulnerabilities = report.vulnerabilities;
  const totals = report.metadata?.vulnerabilities;
  assert(
    vulnerabilities && typeof vulnerabilities === "object" && !Array.isArray(vulnerabilities),
    "npm audit JSON is missing its vulnerabilities object.",
  );
  assert(totals && typeof totals === "object", "npm audit JSON is missing vulnerability totals.");

  const observedTotals = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    assert(
      vulnerability && SEVERITIES.includes(vulnerability.severity),
      `npm audit returned an invalid severity for ${name}.`,
    );
    observedTotals[vulnerability.severity] += 1;
  }

  for (const severity of SEVERITIES) {
    assert(
      totals[severity] === observedTotals[severity],
      `npm audit ${severity} count does not match its package findings.`,
    );
  }
  assert(
    totals.total === Object.keys(vulnerabilities).length,
    "npm audit total does not match its package findings.",
  );

  const highOrCritical = Object.entries(vulnerabilities).filter(([, vulnerability]) =>
    HIGH_OR_CRITICAL.has(vulnerability.severity),
  );
  assert(
    (exitCode === 0 && highOrCritical.length === 0) || (exitCode === 1 && highOrCritical.length > 0),
    "npm audit exit status disagrees with its high/critical findings; failing closed.",
  );

  return { vulnerabilities, highOrCritical };
}

function validateVulnerableChain(vulnerabilities, lockfile) {
  const expectedNames = EXPECTED_CHAIN.map(({ name }) => name).sort();
  const highNames = Object.entries(vulnerabilities)
    .filter(([, vulnerability]) => HIGH_OR_CRITICAL.has(vulnerability.severity))
    .map(([name]) => name)
    .sort();
  assertSameArray(
    highNames,
    expectedNames,
    "Unexpected high/critical dependency-audit findings; only the exact reviewed braces chain is permitted",
  );

  const rootPackage = lockfile?.packages?.[""];
  assert(rootPackage, "package-lock.json has no root package entry.");
  assert(
    rootPackage.devDependencies?.["eslint-config-next"] === EXPECTED_CHAIN[0].version &&
      rootPackage.dependencies?.["eslint-config-next"] === undefined,
    "eslint-config-next must remain the expected development-only root dependency.",
  );

  for (let index = 0; index < EXPECTED_CHAIN.length; index += 1) {
    const component = EXPECTED_CHAIN[index];
    const nodePath = `node_modules/${component.name}`;
    const vulnerability = vulnerabilities[component.name];
    const lockEntry = lockfile.packages[nodePath];
    const expectedEffect = index === 0 ? [] : [EXPECTED_CHAIN[index - 1].name];

    assert(vulnerability.severity === ADVISORY.severity, `${component.name} severity changed; review the exception.`);
    assert(vulnerability.isDirect === (index === 0), `${component.name} directness changed; review the exception.`);
    assertSameArray(vulnerability.nodes, [nodePath], `${component.name} audit nodes changed`);
    assertSameArray(vulnerability.effects, expectedEffect, `${component.name} audit dependency effects changed`);
    assert(lockEntry, `${nodePath} is missing from package-lock.json.`);
    assert(
      lockEntry.version === component.version && lockEntry.dev === true,
      `${nodePath} must remain version ${component.version} and development-only.`,
    );

    if (component.dependency) {
      assert(
        lockEntry.dependencies?.[component.dependency] === component.dependencyRange,
        `${nodePath} no longer has the reviewed dependency edge to ${component.dependency}.`,
      );
      assertSameArray(
        vulnerability.via,
        [component.dependency],
        `${component.name} audit path changed`,
      );
    } else {
      assert(
        Array.isArray(vulnerability.via) && vulnerability.via.length === 1,
        "braces must have exactly the one reviewed high-severity advisory.",
      );
      const [advisory] = vulnerability.via;
      assert(
        advisory.name === ADVISORY.package &&
          advisory.dependency === ADVISORY.package &&
          advisory.title === ADVISORY.title &&
          advisory.url === ADVISORY.url &&
          advisory.severity === ADVISORY.severity &&
          advisory.range === ADVISORY.affectedRange,
        `braces advisory details changed; expected ${ADVISORY.id}.`,
      );
    }
  }
}

export function evaluateDependencyAudit({ exitCode, report, lockfile, policy, now = new Date() }) {
  assert(now instanceof Date && Number.isFinite(now.getTime()), "A valid audit evaluation date is required.");
  const { vulnerabilities, highOrCritical } = validateAuditEnvelope({ exitCode, report });
  const exception = validateExceptionPolicy(policy, now);

  if (highOrCritical.length === 0) {
    return { allowedException: false, exceptionId: null };
  }

  assert(exception, "High/critical findings are present but no dependency-audit exception is configured.");
  validateVulnerableChain(vulnerabilities, lockfile);
  return { allowedException: true, exceptionId: exception.ghsaId, expiresOn: exception.expiresOn };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function runDependencyAudit() {
  const npmResult = spawnSync("npm", ["audit", "--audit-level=high", "--json"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 180_000,
  });

  if (npmResult.error) throw new Error(`Could not complete npm audit: ${npmResult.error.message}`);

  let report;
  try {
    report = JSON.parse(npmResult.stdout);
  } catch {
    const detail = npmResult.stderr?.trim() || npmResult.stdout?.trim() || "no audit output";
    throw new Error(`Could not parse npm audit JSON: ${detail}`);
  }

  const result = evaluateDependencyAudit({
    exitCode: npmResult.status,
    report,
    lockfile: readJson(LOCKFILE_PATH),
    policy: readJson(POLICY_PATH),
  });

  if (result.allowedException) {
    console.warn(
      `npm audit: allowing only ${result.exceptionId} in the verified dev-only ESLint toolchain through ${result.expiresOn}; all other high/critical findings remain blocking.`,
    );
    return;
  }

  console.log("npm audit: no high or critical vulnerabilities in production or development dependencies.");
}

const invokedPath = process.argv[1] ? path.resolve(process.cwd(), process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runDependencyAudit();
  } catch (error) {
    console.error(`Dependency audit failed closed: ${error.message}`);
    process.exitCode = 1;
  }
}
