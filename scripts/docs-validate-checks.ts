/**
 * Pure/static checks used by `scripts/docs-validate.ts` and their unit tests.
 * No module imports from the application are evaluated here: all code analysis
 * is performed with the TypeScript parser, so validation stays offline/DB-free.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";

export interface TextFile {
  /** Repository-relative path, e.g. `src/lib/env.ts` or `docs/README.md`. */
  filePath: string;
  content: string;
}

export interface Finding {
  filePath: string;
  detail: string;
}

const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/**
 * Suffixes used to recognize inline environment-variable references in install
 * prose (not in the explicit `Flag` tables, which accept every valid name).
 * DC-08 adds DAYS/WEEKS/VERSION/PCT/TYPE, which the former text scanner missed.
 */
export const ENV_DOC_SUFFIXES = new Set([
  "URL",
  "KEY",
  "TOKEN",
  "ENABLED",
  "DIR",
  "MS",
  "CTX",
  "PORT",
  "BASE",
  "PATH",
  "DATA",
  "AUDIT",
  "MODEL",
  "PROVIDER",
  "BUDGET",
  "FLAG",
  "DAYS",
  "WEEKS",
  "VERSION",
  "PCT",
  "TYPE",
  "MODE",
  "SECRET",
  "ENV",
  "S",
  "MIN",
  "MAX",
  "HOURS",
  "MINUTES",
  "SECONDS",
  "SIZE",
  "RATE",
  "LIMIT",
  "THRESHOLD",
  "INTERVAL",
  "INTERVALS",
  "RETRY",
  "ATTEMPTS",
  "CONCURRENCY",
  "SEED",
  "FALLBACK",
  "HOSTS",
  "ORIGINS",
  "SYMBOLS",
  "FRACTION",
  "FACTOR",
  "BPS",
  "TOKENS",
  "MTOK",
]);

/**
 * A non-application setting appears in the install guide's CMake command. It
 * is a build-system `-D` option, not a runtime env flag this app should read.
 * Keep this narrowly scoped and remove it if that command is ever removed.
 */
export const ENV_DOC_NON_RUNTIME_WHITELIST = new Map<string, string>([
  [
    "DCMAKE_BUILD_TYPE",
    "docs/INSTALL.md uses this only as CMake's -D build-type argument for llama.cpp; it is not an application runtime env variable.",
  ],
]);

/**
 * Historical path references deliberately retained as evidence in active docs.
 * Each exception is checked for use so it cannot silently become permanent.
 */
export const HISTORICAL_CODE_REFERENCE_DOCS = new Map<string, string>([
  [
    "CHANGELOG.md",
    "Release history intentionally preserves paths that were accurate at the release date; active implementation maps live in docs/.",
  ],
  [
    "docs/DOCS_CODE_AUDIT_2026-10-06.md",
    "Forensic audit evidence intentionally quotes the pre-remediation missing paths; the maintained tracking lives under docs/audits/.",
  ],
]);

export const LEGACY_CODE_PATH_WHITELIST = new Map<string, string>([
  [
    "scripts/drizzle.config.json",
    "Historical security finding S-11: the document records that this config file was removed; current config is drizzle.config.ts.",
  ],
  [
    "src/scanner/historicalStore.ts",
    "Historical migration reference: the store moved to src/lib/marketdata/historicalStore.ts; the old path is retained in the migration table.",
  ],
]);

const CODE_VERSION_HEADER_WINDOW = 12;
const MAX_FINDINGS = 25;
const HISTORICAL_DOC_SEGMENTS = new Set(["archive", "audits", "peer-reviews"]);
const ENV_HELPERS = new Set(["envInt", "envNumber", "env", "readEnv", "requireEnv"]);
const ENV_VALUE_HELPERS = new Set(["num", "bool", "envFlagTrue"]);
const ENV_SPEC_HELPERS = new Set(["resolveRuntimeFlag", "envFlagDefault", "runtimeFlagView"]);
export const ENV_READ_PATTERN_PREFIX = "\u0000env-pattern:";

function isStringLiteral(node: ts.Expression): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    (typeof ts.isSatisfiesExpression === "function" && ts.isSatisfiesExpression(current)) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyNameText(name: ts.PropertyName | ts.BindingName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

interface ParsedSource {
  sourceFile: ts.SourceFile;
  constants: Map<string, ts.Expression>;
  envAliases: Set<string>;
  dynamicEnvGet: boolean;
}

function parseSource(file: TextFile): ParsedSource {
  const scriptKind = file.filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file.filePath, file.content, ts.ScriptTarget.Latest, true, scriptKind);
  const constants = new Map<string, ts.Expression>();
  const envAliases = new Set<string>();

  const collectConstants = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      constants.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectConstants);
  };
  collectConstants(sourceFile);

  const directProcessEnv = (node: ts.Expression): boolean => {
    const value = unwrapExpression(node);
    return (
      ts.isPropertyAccessExpression(value) &&
      value.name.text === "env" &&
      ts.isIdentifier(unwrapExpression(value.expression)) &&
      (unwrapExpression(value.expression) as ts.Identifier).text === "process"
    );
  };
  const isEnvObject = (node: ts.Expression): boolean => {
    const value = unwrapExpression(node);
    if (ts.isIdentifier(value)) return value.text === "env" || envAliases.has(value.text);
    if (!ts.isPropertyAccessExpression(value)) return false;
    if (directProcessEnv(value)) return true;
    // `this.env`, `options.env`, and similar injected environment maps.
    return value.name.text === "env";
  };

  // Resolve simple aliases such as `const runtimeEnv = process.env`.
  let aliasesChanged = true;
  while (aliasesChanged) {
    aliasesChanged = false;
    for (const [name, initializer] of constants) {
      if (!envAliases.has(name) && isEnvObject(initializer)) {
        envAliases.add(name);
        aliasesChanged = true;
      }
    }
  }

  // A small dynamic-key pattern used by EnvSecretStore (`this.env[name]`),
  // followed by call sites such as `store.get(KEY_NAME)`. Resolve these
  // static call-site constants without treating unrelated Map.get() calls as
  // env reads.
  let dynamicEnvGet = false;
  const findDynamicEnvLookup = (node: ts.Node): void => {
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isIdentifier(unwrapExpression(node.argumentExpression)) &&
      isEnvObject(node.expression)
    ) {
      dynamicEnvGet = true;
    }
    ts.forEachChild(node, findDynamicEnvLookup);
  };
  findDynamicEnvLookup(sourceFile);

  return { sourceFile, constants, envAliases, dynamicEnvGet };
}

function exportedConstants(parsed: ParsedSource): Map<string, ts.Expression> {
  const exports = new Map<string, ts.Expression>();
  const hasExport = (node: ts.Node): boolean =>
    (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false;
  for (const statement of parsed.sourceFile.statements) {
    if (ts.isVariableStatement(statement) && hasExport(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          exports.set(declaration.name.text, declaration.initializer);
        }
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const localName = element.propertyName?.text ?? element.name.text;
        const initializer = parsed.constants.get(localName);
        if (initializer) exports.set(element.name.text, initializer);
      }
    }
  }
  return exports;
}

function resolveImportedConstants(
  sourceFiles: readonly TextFile[],
  parsedSources: readonly ParsedSource[],
): void {
  const parsedByPath = new Map(
    sourceFiles.map((file, index) => [file.filePath.replace(/\\/g, "/"), parsedSources[index]]),
  );
  const resolveImportPath = (fromFile: string, specifier: string): string | null => {
    let base: string;
    if (specifier.startsWith("@/")) base = path.posix.join("src", specifier.slice(2));
    else if (specifier.startsWith("~/")) base = path.posix.join("src", specifier.slice(2));
    else if (specifier.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    else return null;

    const candidates = path.posix.extname(base)
      ? [base]
      : [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"].map((extension) => `${base}${extension}`)
        .concat(["index.ts", "index.tsx", "index.js"].map((indexFile) => path.posix.join(base, indexFile)));
    return candidates.find((candidate) => parsedByPath.has(candidate)) ?? null;
  };
  const exportsByPath = new Map(
    [...parsedByPath].map(([filePath, parsed]) => [filePath, exportedConstants(parsed)]),
  );
  const resolveExportedConstant = (
    filePath: string,
    exportName: string,
    visited = new Set<string>(),
  ): { parsed: ParsedSource; initializer: ts.Expression } | null => {
    const visitKey = `${filePath}:${exportName}`;
    if (visited.has(visitKey)) return null;
    visited.add(visitKey);
    const parsed = parsedByPath.get(filePath);
    const direct = exportsByPath.get(filePath)?.get(exportName);
    if (parsed && direct) return { parsed, initializer: direct };
    if (!parsed) return null;

    for (const statement of parsed.sourceFile.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const targetPath = resolveImportPath(filePath, statement.moduleSpecifier.text);
      if (!targetPath) continue;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.name.text !== exportName) continue;
          const originalName = element.propertyName?.text ?? element.name.text;
          const found = resolveExportedConstant(targetPath, originalName, visited);
          if (found) return found;
        }
      } else if (!statement.exportClause) {
        const found = resolveExportedConstant(targetPath, exportName, visited);
        if (found) return found;
      }
    }
    return null;
  };

  for (let index = 0; index < sourceFiles.length; index++) {
    const file = sourceFiles[index];
    const parsed = parsedSources[index];
    for (const statement of parsed.sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.importClause ||
        !statement.importClause.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings)
      ) continue;
      const targetPath = resolveImportPath(file.filePath.replace(/\\/g, "/"), statement.moduleSpecifier.text);
      if (!targetPath) continue;
      for (const element of statement.importClause.namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (parsed.constants.has(element.name.text)) continue;
        const resolvedExport = resolveExportedConstant(targetPath, importedName);
        if (!resolvedExport) continue;
        const value = staticValueResolver(resolvedExport.parsed)(resolvedExport.initializer);
        if (typeof value === "string") {
          parsed.constants.set(element.name.text, ts.factory.createStringLiteral(value));
        }
      }
    }
  }
}

function staticEnvNamePattern(parsed: ParsedSource, expression: ts.Expression): string | null {
  const value = unwrapExpression(expression);
  const initializer = ts.isIdentifier(value) ? parsed.constants.get(value.text) : value;
  if (!initializer || !ts.isTemplateExpression(initializer)) return null;
  let pattern = initializer.head.text;
  for (const span of initializer.templateSpans) pattern += `*${span.literal.text}`;
  return /^[A-Z][A-Z0-9_*]+$/.test(pattern) && pattern.includes("_") ? pattern : null;
}

function staticValueResolver(parsed: ParsedSource): (node: ts.Expression | undefined) => unknown {
  const { constants } = parsed;
  const active = new Set<string>();
  const resolve = (node: ts.Expression | undefined): unknown => {
    if (!node) return undefined;
    const value = unwrapExpression(node);
    if (isStringLiteral(value)) return value.text;
    if (ts.isTemplateExpression(value)) {
      let output = value.head.text;
      for (const span of value.templateSpans) {
        const substitution = resolve(span.expression);
        if (typeof substitution !== "string") return undefined;
        output += substitution + span.literal.text;
      }
      return output;
    }
    if (ts.isIdentifier(value)) {
      if (active.has(value.text)) return undefined;
      const initializer = constants.get(value.text);
      if (!initializer) return undefined;
      active.add(value.text);
      const resolved = resolve(initializer);
      active.delete(value.text);
      return resolved;
    }
    if (ts.isObjectLiteralExpression(value)) {
      const entries = new Map<string, unknown>();
      for (const property of value.properties) {
        if (ts.isPropertyAssignment(property)) {
          // Computed keys (`[BINANCE_VENUE]: …`) are resolved like identifiers.
          const key = ts.isComputedPropertyName(property.name)
            ? resolve(property.name.expression)
            : propertyNameText(property.name);
          if (typeof key === "string") entries.set(key, resolve(property.initializer));
        } else if (ts.isShorthandPropertyAssignment(property)) {
          entries.set(property.name.text, resolve(property.name));
        }
      }
      return entries;
    }
    if (ts.isPropertyAccessExpression(value)) {
      const target = resolve(value.expression);
      return target instanceof Map ? target.get(value.name.text) : undefined;
    }
    if (ts.isElementAccessExpression(value)) {
      const target = resolve(value.expression);
      const key = resolve(value.argumentExpression);
      if (!(target instanceof Map)) return undefined;
      // A dynamic selector over a literal env-name map still represents real
      // possible reads. Preserve the map so the caller can collect its values.
      return typeof key === "string" ? target.get(key) : target;
    }
    return undefined;
  };
  return resolve;
}

function isDirectProcessEnv(node: ts.Expression): boolean {
  const value = unwrapExpression(node);
  if (!ts.isPropertyAccessExpression(value) || value.name.text !== "env") return false;
  const processExpression = unwrapExpression(value.expression);
  return ts.isIdentifier(processExpression) && processExpression.text === "process";
}

function isEnvObjectExpression(node: ts.Expression, aliases: ReadonlySet<string>): boolean {
  const value = unwrapExpression(node);
  if (isDirectProcessEnv(value)) return true;
  if (ts.isIdentifier(value)) return value.text === "env" || aliases.has(value.text);
  if (ts.isPropertyAccessExpression(value)) return value.name.text === "env";
  return false;
}

function addResolvedEnvName(target: Set<string>, value: unknown): void {
  if (typeof value === "string" && ENV_NAME.test(value)) {
    target.add(value);
  } else if (value instanceof Map) {
    for (const entry of value.values()) addResolvedEnvName(target, entry);
  } else if (Array.isArray(value)) {
    for (const entry of value) addResolvedEnvName(target, entry);
  }
}

function isFunctionLikeNode(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function functionName(node: ts.FunctionLikeDeclaration): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
    return node.name.text;
  }
  if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.name) {
    return propertyNameText(node.name);
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent)) return propertyNameText(parent.name);
    if (ts.isPropertyDeclaration(parent)) return propertyNameText(parent.name);
  }
  return null;
}

/** Maps helper names to parameters used as dynamic env-map keys. */
function envKeyParameters(parsed: ParsedSource): Map<string, Set<number>> {
  const byFunction = new Map<string, Set<number>>();
  const visit = (node: ts.Node): void => {
    if (!isFunctionLikeNode(node) || !node.body) {
      ts.forEachChild(node, visit);
      return;
    }

    const name = functionName(node);
    if (name) {
      const inspectBody = (child: ts.Node): void => {
        if (child !== node.body && isFunctionLikeNode(child)) return;
        if (
          ts.isElementAccessExpression(child) &&
          child.argumentExpression &&
          ts.isIdentifier(unwrapExpression(child.argumentExpression)) &&
          isEnvObjectExpression(child.expression, parsed.envAliases)
        ) {
          const keyName = (unwrapExpression(child.argumentExpression) as ts.Identifier).text;
          const index = node.parameters.findIndex(
            (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === keyName,
          );
          if (index >= 0) {
            const indexes = byFunction.get(name) ?? new Set<number>();
            indexes.add(index);
            byFunction.set(name, indexes);
          }
        }
        ts.forEachChild(child, inspectBody);
      };
      inspectBody(node.body);
    }

    // Nested functions own their parameter analysis.
    ts.forEachChild(node, visit);
  };
  visit(parsed.sourceFile);
  return byFunction;
}

/**
 * Collect statically identifiable, real environment reads from TS/TSX source.
 * Supported forms include direct process.env access, env maps, string-literal
 * helpers, helper calls with an injected env map, and const/object-map keys.
 */
export function envReadsFromCode(sourceFiles: readonly TextFile[]): Set<string> {
  const reads = new Set<string>();
  const parsedSources = sourceFiles.map(parseSource);
  resolveImportedConstants(sourceFiles, parsedSources);
  for (let fileIndex = 0; fileIndex < sourceFiles.length; fileIndex++) {
    const file = sourceFiles[fileIndex];
    const parsed = parsedSources[fileIndex];
    const resolve = staticValueResolver(parsed);
    const dynamicKeyArguments = envKeyParameters(parsed);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && isEnvObjectExpression(node.expression, parsed.envAliases)) {
        // `process.env` itself is an env map, not a flag read; this branch only
        // sees the property after it (`process.env.FLAG`, `env.FLAG`, etc.).
        if (!isDirectProcessEnv(node) && ENV_NAME.test(node.name.text)) reads.add(node.name.text);
      }

      if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        isEnvObjectExpression(node.expression, parsed.envAliases)
      ) {
        const keyValue = resolve(node.argumentExpression);
        addResolvedEnvName(reads, keyValue);
        if (keyValue === undefined) {
          const pattern = staticEnvNamePattern(parsed, node.argumentExpression);
          if (pattern) reads.add(`${ENV_READ_PATTERN_PREFIX}${pattern}`);
        }
      }

      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression);
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : "";
        if (ENV_HELPERS.has(name) && node.arguments.length > 0) {
          addResolvedEnvName(reads, resolve(node.arguments[0]));
        }
        for (const index of dynamicKeyArguments.get(name) ?? []) {
          addResolvedEnvName(reads, resolve(node.arguments[index]));
        }
        if (ENV_SPEC_HELPERS.has(name) && node.arguments.length > 0) {
          const spec = resolve(node.arguments[0]);
          if (spec instanceof Map) addResolvedEnvName(reads, spec.get("envVar"));
        }
        if (
          ENV_VALUE_HELPERS.has(name) &&
          node.arguments.length >= 2 &&
          isEnvObjectExpression(node.arguments[0], parsed.envAliases)
        ) {
          addResolvedEnvName(reads, resolve(node.arguments[1]));
        }
        if (
          parsed.dynamicEnvGet &&
          name === "get" &&
          ts.isPropertyAccessExpression(callee) &&
          node.arguments.length > 0
        ) {
          addResolvedEnvName(reads, resolve(node.arguments[0]));
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(parsed.sourceFile);
  }
  return reads;
}

/** Direct dotted `process.env.NAME` reads, used for the intentionally
 * non-blocking code→docs drift warning. */
export function processEnvPropertyReads(sourceFiles: readonly TextFile[]): Set<string> {
  const reads = new Set<string>();
  for (const file of sourceFiles) {
    const sourceFile = ts.createSourceFile(
      file.filePath,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      file.filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && isDirectProcessEnv(node.expression)) {
        reads.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return reads;
}

export function envExampleKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*(?:#\s*)?(?:export\s+)?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*=/);
    if (match) keys.add(match[1]);
  }
  return keys;
}

function extractBacktickIdentifiers(content: string): Set<string> {
  const identifiers = new Set<string>();
  for (const match of content.matchAll(/`([^`]+)`/g)) {
    for (const candidate of match[1].matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
      if (ENV_NAME.test(candidate[0])) identifiers.add(candidate[0]);
    }
  }
  return identifiers;
}

export function extractFlagTableNames(content: string): Set<string> {
  const flags = new Set<string>();
  let inFlagTable = false;
  for (const line of content.split("\n")) {
    if (/^\s*\|\s*(?:\*\*)?Flag(?:\*\*)?\s*\|/i.test(line)) {
      inFlagTable = true;
      continue;
    }
    if (!line.trim()) {
      inFlagTable = false;
      continue;
    }
    if (!/^\s*\|/.test(line)) {
      inFlagTable = false;
      continue;
    }
    if (!inFlagTable || /^\s*\|\s*:?-{2,}/.test(line)) continue;

    // Flag tables keep the variable declaration in column one. Parse only
    // backtick identifiers from that cell, not status codes in descriptions.
    const firstCell = line.replace(/^\s*\|/, "").split("|")[0] ?? "";
    for (const token of firstCell.matchAll(/`([^`]+)`/g)) {
      for (const candidate of token[1].matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
        if (ENV_NAME.test(candidate[0])) flags.add(candidate[0]);
      }
    }
  }
  return flags;
}

/**
 * Extract flags deliberately documented as runtime configuration. The main
 * configuration reference is read from its explicit `Flag` tables; install
 * guides contribute inline, suffix-qualified env names and `.env.example` keys.
 */
export function documentedEnvFlagsFromDocs(
  documents: readonly TextFile[],
  envExampleContent = "",
): Set<string> {
  const flags = new Set<string>();
  const exampleKeys = envExampleKeys(envExampleContent);

  for (const doc of documents) {
    if (doc.content.includes("Weiterleitung") && doc.content.length < 1500) continue;
    const normalizedPath = doc.filePath.replace(/\\/g, "/");
    const base = path.posix.basename(normalizedPath);
    if (base === "CONFIGURATION.md") {
      for (const flag of extractFlagTableNames(doc.content)) flags.add(flag);
      continue;
    }
    if (base === "INSTALL.md") {
      for (const flag of extractBacktickIdentifiers(doc.content)) {
        const suffix = flag.slice(flag.lastIndexOf("_") + 1);
        if (ENV_DOC_SUFFIXES.has(suffix) || exampleKeys.has(flag)) flags.add(flag);
      }
      // `.env` setup snippets may document flags without inline backticks.
      for (const line of doc.content.split("\n")) {
        const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*=/);
        if (match) flags.add(match[1]);
      }
    }
  }
  return flags;
}

export function envReadCoversName(reads: ReadonlySet<string>, name: string): boolean {
  if (reads.has(name)) return true;
  for (const read of reads) {
    if (!read.startsWith(ENV_READ_PATTERN_PREFIX)) continue;
    const pattern = read.slice(ENV_READ_PATTERN_PREFIX.length);
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[A-Z0-9_]+");
    if (new RegExp(`^${escaped}$`).test(name)) return true;
  }
  return false;
}

export function documentedEnvReadIssues(
  documents: readonly TextFile[],
  envReads: ReadonlySet<string>,
  envExampleContent = "",
  allowlist: ReadonlyMap<string, string> = ENV_DOC_NON_RUNTIME_WHITELIST,
): Finding[] {
  const documented = documentedEnvFlagsFromDocs(documents, envExampleContent);
  const issues: Finding[] = [];
  const usedAllowlist = new Set<string>();

  for (const doc of documents) {
    if (doc.content.includes("Weiterleitung") && doc.content.length < 1500) continue;
    const normalizedPath = doc.filePath.replace(/\\/g, "/");
    if (path.posix.basename(normalizedPath) !== "INSTALL.md") continue;
    for (const name of documented) {
      if (allowlist.has(name) && doc.content.includes(name)) usedAllowlist.add(name);
    }
  }

  for (const name of documented) {
    if (envReadCoversName(envReads, name)) continue;
    if (allowlist.has(name)) continue;
    const sources = documents
      .filter((doc) => doc.content.includes(`\`${name}\``))
      .map((doc) => doc.filePath);
    issues.push({
      filePath: sources[0] ?? "CONFIGURATION.md",
      detail: `dokumentiertes Env-Flag '${name}' hat keinen statisch erkennbaren Code-Read`,
    });
  }
  for (const [name, reason] of allowlist) {
    if (!usedAllowlist.has(name)) {
      issues.push({
        filePath: "scripts/docs-validate-checks.ts",
        detail: `Env-Ausnahme '${name}' ist nicht mehr dokumentiert; Allowlist-Eintrag entfernen (${reason})`,
      });
    }
  }
  return issues;
}

export function undocumentedProcessEnvReads(
  reads: ReadonlySet<string>,
  configAndExampleText: string,
): string[] {
  return [...reads]
    .filter((name) => !name.startsWith(ENV_READ_PATTERN_PREFIX))
    .filter((name) => !configAndExampleText.includes(name))
    .sort()
    .map((name) => `Env-Flag '${name}' wird gelesen, aber in CONFIGURATION.md, .env.example oder docs/** nicht erwähnt`);
}

function normalizeRoutePath(value: string): string {
  return value
    .replace(/\[\[\.\.\.([^\]]+)\]\]/g, "/{param}")
    .replace(/\[\.\.\.([^\]]+)\]/g, "/{param}")
    .replace(/\[([^\]]+)\]/g, "{param}")
    .replace(/\{[^}]+\}/g, "{param}")
    .replace(/:[A-Za-z][A-Za-z0-9_]*/g, "{param}")
    .replace(/\/+$/, "");
}

export function undocumentedRoutes(routes: ReadonlySet<string>, docsContent: string): string[] {
  const normalizedDocs = docsContent
    .replace(/\[\[\.\.\.([^\]]+)\]\]/g, "{param}")
    .replace(/\[\.\.\.([^\]]+)\]/g, "{param}")
    .replace(/\[([^\]]+)\]/g, "{param}")
    .replace(/\{[^}]+\}/g, "{param}")
    .replace(/:[A-Za-z][A-Za-z0-9_]*/g, "{param}");
  return [...routes]
    .filter((route) => !normalizedDocs.includes(normalizeRoutePath(route)))
    .sort()
    .map((route) => `${route} ist unter docs/** nicht erwähnt`);
}

function isHistoricalDocument(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.split("/").some((segment) => HISTORICAL_DOC_SEGMENTS.has(segment));
}

export function firstCodeVersion(content: string): { line: number; version: string | null } | null {
  const lines = content.split("\n").slice(0, CODE_VERSION_HEADER_WINDOW);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    // A Dokument-Version may explain that it is not a code version; that is
    // not a Code-Version header and must remain valid without package coupling.
    if (/\bDokument-Version\b\s*[:*]/i.test(line) && !/\bCode-Version\b\s*[:*]/i.test(line)) continue;
    if (!/\bCode-Version\b/i.test(line)) continue;
    const match = line.match(/Code-Version[^\d\n]{0,48}v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i);
    return { line: index + 1, version: match?.[1] ?? null };
  }
  return null;
}

/** Validate Code-Version header values only; Dokument-Version is intentionally ignored. */
export function codeVersionHeaderIssues(
  documents: readonly TextFile[],
  packageVersion: string,
): Finding[] {
  const issues: Finding[] = [];
  for (const doc of documents) {
    if (isHistoricalDocument(doc.filePath)) continue;
    const header = firstCodeVersion(doc.content);
    if (!header) continue;
    if (!header.version) {
      issues.push({
        filePath: doc.filePath,
        detail: `Code-Version-Header in Zeile ${header.line} enthält keine parsebare Version`,
      });
    } else if (header.version !== packageVersion) {
      issues.push({
        filePath: doc.filePath,
        detail: `Code-Version v${header.version} != package.json ${packageVersion}`,
      });
    }
  }
  return issues;
}

function concreteCodePath(raw: string): { path: string; symbolFile: boolean } | null {
  const normalized = raw.trim().replace(/\\/g, "/");
  // Stop at whitespace, line/symbol annotations, commas, or prose following
  // the code path (e.g. `script.ts --sync` or `types.ts:28,54-56`).
  const match = normalized.match(/^(?:src|scripts)\/[A-Za-z0-9_./*?\[\]-]+/);
  if (!match) return null;
  let value = match[0];
  // Abstract examples are not claims about a concrete file or directory.
  if (value.includes("...") || value.includes("…") || /[<>]/.test(value)) return null;
  value = value.replace(/\/(?:\*\*|\*)+$/, "").replace(/\/$/, "");
  if (!value || value === "src" || value === "scripts") return { path: value, symbolFile: false };
  const hasGlob = /[*?]/.test(value);
  return { path: value, symbolFile: !hasGlob && /\.(?:ts|tsx|mts|cts)$/.test(value) };
}

function codePathExists(repositoryRoot: string, relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.includes("*") || normalized.includes("?")) {
    const globRegex = new RegExp(
      `^${normalized
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000DOUBLE_STAR\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000DOUBLE_STAR\u0000/g, ".*")
        .replace(/\?/g, "[^/]")}$`,
    );
    const wildcardIndex = normalized.search(/[?*]/);
    const prefix = normalized.slice(0, wildcardIndex);
    const startDirectory = path.resolve(repositoryRoot, path.posix.dirname(prefix || "src"));
    const visit = (directory: string): boolean => {
      try {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const absolute = path.join(directory, entry.name);
          const relative = path.relative(repositoryRoot, absolute).replace(/\\/g, "/");
          if (globRegex.test(relative)) return true;
          if (entry.isDirectory() && visit(absolute)) return true;
        }
      } catch {
        return false;
      }
      return false;
    };
    return visit(startDirectory);
  }

  const absolute = path.resolve(repositoryRoot, relativePath);
  if (existsSync(absolute)) return true;
  // Older docs occasionally omit a TypeScript script extension. Accept only
  // the repository's source extensions; arbitrary near-matches still fail.
  if (!path.posix.extname(relativePath)) {
    return [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".sh"]
      .some((extension) => existsSync(`${absolute}${extension}`));
  }
  return false;
}

function exportedSymbols(source: string, filePath: string): Set<string> {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const exports = new Set<string>();
  const hasExport = (node: ts.Node): boolean =>
    (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false;

  const addBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) exports.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) addBinding(element.name);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && hasExport(node)) {
      for (const declaration of node.declarationList.declarations) addBinding(declaration.name);
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node)) &&
      hasExport(node) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      exports.add(node.name.text);
    } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) exports.add(element.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return exports;
}

const SYMBOL_LIST_PATTERN = /`((?:src|scripts)\/[^`]+?\.(?:ts|tsx|mts|cts))`\s*\(\s*((?:`[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?`\s*(?:,\s*`[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?`\s*)*))\)/g;

function symbolsFromList(value: string): string[] {
  return [...value.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?)`/g)].map((match) => match[1]);
}

/**
 * Check concrete `src/` and `scripts/` path mentions and strict file/symbol
 * attributions (`path.ts` (`ExportA`, `ExportB`)). Old references are allowed
 * only via the explicit, reasoned, anti-rot whitelist above.
 */
export function documentedCodePathSymbolIssues(
  documents: readonly TextFile[],
  repositoryRoot: string,
  allowlist: ReadonlyMap<string, string> = LEGACY_CODE_PATH_WHITELIST,
  historicalDocs: ReadonlyMap<string, string> = HISTORICAL_CODE_REFERENCE_DOCS,
): Finding[] {
  const issues: Finding[] = [];
  const usedAllowlist = new Set<string>();
  const usedHistoricalDocs = new Set<string>();
  const codePathPattern = /`((?:src|scripts)\/[^`\r\n]+)`/g;

  for (const doc of documents) {
    const normalizedDocPath = doc.filePath.replace(/\\/g, "/");
    if (historicalDocs.has(normalizedDocPath)) {
      usedHistoricalDocs.add(normalizedDocPath);
      continue;
    }
    if (isHistoricalDocument(doc.filePath)) continue;
    const checkedPaths = new Set<string>();
    for (const match of doc.content.matchAll(codePathPattern)) {
      const reference = concreteCodePath(match[1]);
      if (!reference || checkedPaths.has(reference.path)) continue;
      checkedPaths.add(reference.path);
      const exists = codePathExists(repositoryRoot, reference.path);
      if (exists) continue;
      if (allowlist.has(reference.path)) {
        usedAllowlist.add(reference.path);
        continue;
      }
      issues.push({ filePath: doc.filePath, detail: `dokumentierter Code-Pfad existiert nicht: ${reference.path}` });
    }

    for (const match of doc.content.matchAll(SYMBOL_LIST_PATTERN)) {
      const codePath = match[1].replace(/\\/g, "/");
      const reference = concreteCodePath(codePath);
      if (!reference || !reference.symbolFile) continue;
      if (!existsSync(path.resolve(repositoryRoot, reference.path))) continue;
      const source = readFileSync(path.resolve(repositoryRoot, reference.path), "utf8");
      const exports = exportedSymbols(source, reference.path);
      for (const symbol of symbolsFromList(match[2])) {
        const baseSymbol = symbol.split(".")[0];
        if (!exports.has(baseSymbol)) {
          issues.push({
            filePath: doc.filePath,
            detail: `${reference.path} ordnet '${symbol}' zu, aber '${baseSymbol}' ist dort kein Export`,
          });
        }
      }
    }
  }

  for (const [legacyPath, reason] of allowlist) {
    if (!usedAllowlist.has(legacyPath)) {
      issues.push({
        filePath: "scripts/docs-validate-checks.ts",
        detail: `Altpfad-Ausnahme '${legacyPath}' ist nicht mehr zitiert; Allowlist-Eintrag entfernen (${reason})`,
      });
    }
  }
  for (const [historicalDoc, reason] of historicalDocs) {
    if (!usedHistoricalDocs.has(historicalDoc)) {
      issues.push({
        filePath: "scripts/docs-validate-checks.ts",
        detail: `Historische Pfad-Doku '${historicalDoc}' wird nicht mehr geprüft; Ausnahme entfernen (${reason})`,
      });
    }
  }
  return issues;
}

/** Convenience helper for the production script's capped output. */
export function firstFindings(findings: readonly Finding[], limit = MAX_FINDINGS): Finding[] {
  return findings.slice(0, limit);
}

/** Convenience helper for filesystem-backed callers. */
export function textFilesFromPaths(paths: readonly string[], repositoryRoot: string): TextFile[] {
  return paths.map((absolutePath) => ({
    filePath: path.relative(repositoryRoot, absolutePath).replace(/\\/g, "/"),
    content: readFileSync(absolutePath, "utf8"),
  }));
}

/** True when the path is a regular file, avoiding directory matches in test fixtures. */
export function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Rekursive Dateiliste (absolute Pfade), sortiert — für deterministische Läufe. */
export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/**
 * Alle Quelldateien (TS/TSX), die als Laufzeit-Code gelten: `src/**`,
 * `scripts/**` und Root-Dateien (z. B. `next.config.ts`, `instrumentation.ts`).
 */
export function codeSourceFiles(repositoryRoot: string): string[] {
  const exts = [".ts", ".tsx"];
  const isCode = (f: string) => exts.includes(path.extname(f));
  const srcDir = path.join(repositoryRoot, "src");
  const scriptsDir = path.join(repositoryRoot, "scripts");
  const fromSrc = existsSync(srcDir) ? walkFiles(srcDir).filter(isCode) : [];
  const fromScripts = existsSync(scriptsDir) ? walkFiles(scriptsDir).filter(isCode) : [];
  const fromRoot = readdirSync(repositoryRoot)
    .sort()
    .map((entry) => path.join(repositoryRoot, entry))
    .filter((file) => isCode(file) && statSync(file).isFile());
  return [...fromSrc, ...fromScripts, ...fromRoot];
}

/** Eine App-Route: URL-Pfad (`/api/firm/kill`) und absolute Datei. */
export interface ApiRouteFile {
  urlPath: string;
  file: string;
}

/** Alle `route.ts`-Dateien unter `apiDir`, als URL-Pfade, sortiert nach URL. */
export function apiRouteFiles(apiDir: string): ApiRouteFile[] {
  if (!existsSync(apiDir)) return [];
  return walkFiles(apiDir)
    .filter((f) => path.basename(f) === "route.ts")
    .map((file) => {
      const rel = path.relative(apiDir, path.dirname(file)).split(path.sep).join("/");
      return { urlPath: rel ? `/api/${rel}` : "/api", file };
    })
    .sort((a, b) => (a.urlPath < b.urlPath ? -1 : a.urlPath > b.urlPath ? 1 : 0));
}
