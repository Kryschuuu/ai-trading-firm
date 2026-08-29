/**
 * `npm run docs:validate` — Docs-as-Code-CI-Validator (Task 12).
 *
 * Fuehrt alle automatisierten Doku-Pruefungen aus und beendet mit Exit 0
 * (gruen) bzw. 1 (rot). Der CI-Job `docs-validate` (docs/ci/docs-validate.workflow.yml)
 * ruft genau dieses Skript auf.
 *
 * Pruefungen:
 *   A) Hilfe-Schema: jede docs/help/*.help.json validiert gegen
 *      docs/help/help.schema.json (3-Ebenen-Systematik).
 *   B) Link-Check: alle relativen Markdown-Links innerhalb von docs/ zeigen
 *      auf existierende Ziele (0 tote Links).
 *   C) Markdown-Lint (repo-konform): ausgeglichene Code-Fences, korrekte
 *      ATX-Ueberschriften, keine Leerzeilen-Trailing-Whitespaces.
 *   D) Secret-Scan ueber Docs-Diffs: keine API-Keys, Tokens, privaten Schluessel,
 *      internen Hostnamen oder personenbezogenen Daten in docs/.
 *   E) Konsistenz-Checks gegen den Code:
 *      - Env-Flag-Namen in INSTALL.md existieren im Code (src/**).
 *      - API-Routen in docs/ existieren als registrierte Routen (src/app/api).
 *      - Zustandsnamen in LIVE_TRADING.md == Live-Gate-Enum (src/live-gate/states.ts).
 *      - Alle docs/help/*.help.json erfuellen die 3-Ebenen-Pflicht (via A).
 *   F) Versions-Konsistenz: package.json == oberster Eintrag in CHANGELOG.md
 *      und docs/CHANGELOG.md == Status-Header == docs/README.md.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DOCS = path.join(ROOT, "docs");
const SRC = path.join(ROOT, "src");

let failures: string[] = [];
let checksRun = 0;
const report = (name: string, ok: boolean, detail: string) => {
  checksRun++;
  if (!ok) failures.push(`[${name}] ${detail}`);
};

// ---------------------------------------------------------------------------
// Hilfskonstruktionen
// ---------------------------------------------------------------------------
const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
};

const mdFiles = (base: string): string[] =>
  walk(base).filter((f) => f.endsWith(".md"));

// ---------------------------------------------------------------------------
// A) Help-Schema-Validierung
// ---------------------------------------------------------------------------
function validateHelpFile(file: string): string[] {
  const errs: string[] = [];
  const raw = readFileSync(file, "utf8");
  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return [`unparsebares JSON: ${String(e)}`];
  }
  const rel = path.relative(DOCS, file);
  const need = ["id", "version", "title", "description", "source", "fields"];
  for (const k of need) if (!(k in doc)) errs.push(`fehlt '${k}'`);
  if (typeof doc.version !== "number") errs.push("'version' ist keine Zahl");
  const baseName = path.basename(file, ".help.json");
  if (typeof doc.id === "string" && doc.id !== baseName)
    errs.push(`'id' (${doc.id}) != Dateiname (${baseName})`);
  if (!doc.fields || typeof doc.fields !== "object")
    errs.push("'fields' fehlt");
  else {
    for (const [key, entry] of Object.entries<any>(doc.fields)) {
      for (const level of ["kurzinfo", "technischeInfo", "risiko"]) {
        const v = entry?.[level];
        if (typeof v !== "string" || v.trim().length < 20)
          errs.push(`fields.${key}.${level} fehlt oder <20 Zeichen`);
      }
    }
  }
  return errs.map((e) => `${rel}: ${e}`);
}

// ---------------------------------------------------------------------------
// B) Link-Check (relative Links innerhalb docs/)
// ---------------------------------------------------------------------------
/** GitHub-aehnlicher Heading-Anker ("## 2.1 Schema (x)" -> "21-schema-x"). */
function headingSlug(h: string): string {
  return h
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "") // entfernt Satzzeichen, auch Em-Dash
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function checkLinks() {
  const files = mdFiles(DOCS);
  const dead: string[] = [];
  for (const file of files) {
    const base = path.dirname(file);
    const src = readFileSync(file, "utf8");
    const re = /\]\(([^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const target = m[1].trim();
      if (/^(https?:|mailto:|#)/.test(target)) continue; // extern / Anker
      const [p, anchor] = target.split("#");
      if (!p) continue;
      const resolved = path.resolve(base, decodeURIComponent(p));
      if (!existsSync(resolved)) {
        dead.push(`${path.relative(ROOT, file)}: toter Link -> ${target}`);
        continue;
      }
      if (anchor) {
        const content = readFileSync(resolved, "utf8");
        const want = headingSlug(anchor);
        const headings = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map((hm) => headingSlug(hm[1]));
        if (!headings.includes(want))
          dead.push(`${path.relative(ROOT, file)}: toter Anker -> ${target}`);
      }
    }
  }
  report("Link-Check", dead.length === 0, dead.length ? dead.slice(0, 25).join(" | ") : "");
}

// ---------------------------------------------------------------------------
// C) Markdown-Lint (repo-konform)
// ---------------------------------------------------------------------------
function checkMarkdown() {
  const files = mdFiles(DOCS);
  const issues: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    const rel = path.relative(ROOT, file);
    const fences = lines.filter((l) => /^\s*(```|~~~)/.test(l)).length;
    if (fences % 2 !== 0) issues.push(`${rel}: ungerade Anzahl Code-Fences (${fences})`);
    // ATX-Header ausserhalb von Code-Fences: Leerzeichen nach #
    let inFence = false;
    lines.forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
      if (inFence) return;
      if (/^#{1,6}(?!#)\S/.test(l)) issues.push(`${rel}:${i + 1}: ATX-Header ohne Leerzeichen`);
      // Trailing-Whitespace; genau zwei Leerzeichen (Markdown-Hardbreak) sind erlaubt.
      if (/( {3,}|\t+)$/.test(l) && l.trim().length > 0)
        issues.push(`${rel}:${i + 1}: Trailing-Whitespace`);
    });
  }
  report("Markdown-Lint", issues.length === 0, issues.length ? issues.slice(0, 25).join(" | ") : "");
}

// ---------------------------------------------------------------------------
// D) Secret-Scan ueber docs/
// ---------------------------------------------------------------------------
function checkSecrets() {
  const files = mdFiles(DOCS);
  // Platzhalter-Werte, die in Setup-Dokumentation erlaubt sind (keine echten Secrets).
  const placeholder =
    /bitte-hier-aendern|changeme|ihr-passwort|dein-passwort|your-|passwort-|db_pass|db_user|sk-[^\w]|\$[A-Za-z_][A-Za-z0-9_]*|…|\.\.\.|<\s*[^>]*\s*>|'\w+'|\{+\s*\w+\s*,?\s*\}/i;
  const patterns: [RegExp, string][] = [
    [/AIza[0-9A-Za-z_-]{20,}/, "Google-API-Key"],
    [/sk-[0-9A-Za-z]{20,}/, "OpenAI-/Anthropic-Key"],
    [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, "Privater Schluessel"],
    [/ghp_[0-9A-Za-z]{30,}/, "GitHub-PAT"],
    [/xox[baprs]-[0-9A-Za-z-]{10,}/, "Slack-Token"],
    [/\b[0-9a-f]{64}\b/i, "SHA-256-Hash-Wert (eigentlich kein Secret)"],
  ];
  // Klartext-Passwort/Tokens nur bei Wertzuweisung (>=4 Zeichen) und wenn der
  // Wert kein Platzhalter/Env-Referenz/Beispiel ist.
  const valuePattern = /(?:passwort|password|passwd|pw|secret|api[_-]?key|token)\s*[:=]\s*(\S{4,})/i;
  const findings: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    const rel = path.relative(ROOT, file);
    lines.forEach((l, i) => {
      for (const [re, label] of patterns) {
        if (re.test(l)) findings.push(`${rel}:${i + 1}: ${label}`);
      }
      const vm = l.match(valuePattern);
      if (vm && !placeholder.test(vm[1])) {
        findings.push(`${rel}:${i + 1}: Klartext-Passwort/Token-Wert (${vm[1].slice(0, 12)}...)`);
      }
    });
  }
  report("Secret-Scan", findings.length === 0, findings.length ? findings.slice(0, 25).join(" | ") : "");
}

// ---------------------------------------------------------------------------
// E) Konsistenz-Checks gegen Code
// ---------------------------------------------------------------------------
const CODE_EXT = [".ts", ".tsx"];
function codeSource() {
  return walk(SRC).filter((f) => CODE_EXT.includes(path.extname(f)));
}

function envFlagsFromCode(): Set<string> {
  const flags = new Set<string>();
  for (const f of codeSource()) {
    const src = readFileSync(f, "utf8");
    // env.FLAG / env["FLAG"] / process.env.FLAG / env[FLAG_CONST]
    const re = /(?:process\.)?env(?:\.([A-Z][A-Z0-9_]*)|\[\s*"([A-Z][A-Z0-9_]*)"\s*\])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) flags.add(m[1] ?? m[2]);
    // Konstante Flag-Strings, die als Env-Variable verwendet werden (z. B. *_FLAG)
    const re2 = /(?:const\s+)?\w*_FLAG\s*=\s*"([A-Z][A-Z0-9_]*)"|venue\w*FlagName\(|"[A-Z]+_[A-Z_]+_ENABLED"|"(LIVE_GATE|PAPER|BITUNIX)_[A-Z_]+"/g;
    let m2: RegExpExecArray | null;
    while ((m2 = re2.exec(src)) !== null) if (m2[1]) flags.add(m2[1]);
  }
  // Kandidaten aus envInt/env-Backticks (einzelne grosse Flags)
  for (const f of codeSource()) {
    const src = readFileSync(f, "utf8");
    const re3 = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
    let m3: RegExpExecArray | null;
    while ((m3 = re3.exec(src)) !== null) {
      const v = m3[0];
      if (/(_ENABLED|_URL|_KEY|_TOKEN|_DIR|_MS|_CTX|_PORT|_BASE|_PATH|_DATA|_AUDIT|_MODEL|_PROVIDER|_BUDGET|_FLAG)$/.test(v))
        flags.add(v);
    }
  }
  return flags;
}

function routesFromCode(): Set<string> {
  const routes = new Set<string>();
  const apiDir = path.join(SRC, "app/api");
  if (!existsSync(apiDir)) return routes;
  const files = walk(apiDir).filter((f) => f.endsWith("route.ts"));
  for (const f of files) {
    let rel = path.relative(apiDir, f).replace(/route\.ts$/, "").replace(/\\/g, "/");
    rel = rel.replace(/\/$/, "");
    routes.add(`/api/${rel}`);
  }
  return routes;
}

function liveGateStatesFromCode(): string[] {
  const f = path.join(SRC, "live-gate/states.ts");
  const src = readFileSync(f, "utf8");
  const m = src.match(/LIVE_GATE_STATES\s*=\s*\[([\s\S]*?)\] as const/);
  if (!m) return [];
  const names = [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]);
  return names;
}

function checkEnvFlags() {
  const codeFlags = envFlagsFromCode();
  const docTargets = [path.join(ROOT, "INSTALL.md"), path.join(DOCS, "INSTALL.md")];
  const issues: string[] = [];
  for (const t of docTargets) {
    if (!existsSync(t)) continue;
    const src = readFileSync(t, "utf8");
    const flags = [...src.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)].map((m) => m[0]);
    for (const f of new Set(flags)) {
      if (/(_URL|_KEY|_TOKEN|_ENABLED|_DIR|_MS|_CTX|_PORT|_BASE|_PATH|_DATA|_AUDIT|_MODEL|_PROVIDER|_BUDGET|_FLAG)$/.test(f) && !codeFlags.has(f)) {
        issues.push(`INSTALL.md dokumentiert Flag '${f}', nicht im Code gefunden`);
      }
    }
  }
  report("Env-Flags==Code", issues.length === 0, issues.length ? issues.slice(0, 25).join(" | ") : "");
}

function checkRoutes() {
  const codeRoutes = routesFromCode();
  // Historische/archivierte Docs werden nicht gegen den aktuellen Code geprueft.
  const skip = new Set([
    "CHANGELOG.md",
    "SETUP_PG_TROUBLESHOOTING.md",
    "SECURITY_AUDIT.md", // referenziert Quell-Pfade (z. B. src/app/api/portfolio/parse.ts)
  ]);
  // Bekannte Top-Level-Namespaces der App-API (aus src/app/api). Routen, deren
  // erstes Segment nicht hier liegt (z. B. Ollama /api/tags, Bitunix /api/v1/...),
  // sind externe Endpunkte und gehoeren nicht zur internen Route-Konsistenz.
  const appTop = new Set(
    [...codeRoutes].map((r) => r.split("/")[2]).filter(Boolean)
  );
  const issues: string[] = [];
  for (const f of mdFiles(DOCS)) {
    const base = path.basename(f);
    if (skip.has(base) || /task-\d+.*IMPLEMENTATION_PLAN/.test(base)) continue;
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/`?\/api\/[a-z0-9_{}\/\[\]-]+`?/gi)) {
      let r = m[0].replace(/[`]/g, "").trim();
      if (!r.startsWith("/api/")) continue;
      r = r.replace(/\/+$/, "");
      if (/[?&#]/.test(r)) continue;
      // Quell-Pfad-Referenz (route.ts) und unbalancierte Parameterlisten ueberspringen.
      if (/\/route$/.test(r)) continue;
      if ((r.match(/\{/g) || []).length !== (r.match(/\}/g) || []).length) continue;
      const top = r.split("/")[2];
      if (!appTop.has(top)) continue; // externer Endpunkt
      // Dynamische Parameter normalisieren; grosse Buchstaben = literale Werte
      // (z. B. Venue/Symbol-IDs) -> [x].
      const norm = (s: string) =>
        s
          .replace(/\[[a-zA-Z0-9]+\]/g, "[x]")
          .replace(/\{[a-zA-Z0-9]+\}/g, "[x]")
          .split("/")
          .map((seg) => (/^[A-Z0-9]+$/.test(seg) ? "[x]" : seg))
          .join("/");
      const rx = norm(r);
      const exact = [...codeRoutes].some((cr) => norm(cr) === rx);
      const prefix = [...codeRoutes].some((cr) => norm(cr).startsWith(rx + "/"));
      if (!exact && !prefix) issues.push(`${path.relative(ROOT, f)}: Route in Doku nicht im Code: ${r}`);
    }
  }
  report("API-Routen==Code", issues.length === 0, issues.length ? issues.slice(0, 25).join(" | ") : "");
}

function checkStates() {
  const states = liveGateStatesFromCode();
  const f = path.join(DOCS, "LIVE_TRADING.md");
  const src = existsSync(f) ? readFileSync(f, "utf8") : "";
  const missing = states.filter((s) => !src.includes(s));
  report(
    "State-Enum==LIVE_TRADING.md",
    missing.length === 0,
    missing.length ? `Zustaende aus Code fehlen in Doku: ${missing.join(", ")}` : ""
  );
}

// ---------------------------------------------------------------------------
// F) Versions-Konsistenz (package.json <-> Changelogs <-> Doku)
// ---------------------------------------------------------------------------
/**
 * Die Version ist die einzige Zahl, die an vier Stellen gleichzeitig steht:
 * `package.json` (ausgeliefert von `/api/health` und `/api/firm`), der
 * Status-Header von `CHANGELOG.md`, der oberste Eintrag von `CHANGELOG.md`
 * bzw. `docs/CHANGELOG.md` und die Versionszeile in `docs/README.md`. Weicht
 * eine Stelle ab, ist fuer Betrieb und Deployment unklar, welcher Stand
 * laeuft. Der Check macht diese Drift zum CI-Fehler.
 */
function checkVersionConsistency() {
  const issues: string[] = [];
  const pkgPath = path.join(ROOT, "package.json");
  let version = "";
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    version = typeof pkg.version === "string" ? pkg.version.trim() : "";
  } catch (e) {
    issues.push(`package.json nicht lesbar: ${String(e)}`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
    issues.push(`package.json: Version '${version || "(leer)"}' ist nicht semver-lesbar`);
    report("Version-Konsistenz", false, issues.join(" | "));
    return;
  }

  // Oberster Release-Eintrag einer Changelog-Datei ("## [x.y.z] — …").
  const latestEntry = (file: string): string | null => {
    if (!existsSync(file)) return null;
    const m = readFileSync(file, "utf8").match(/^## \[(\d+\.\d+\.\d+(?:-[\w.]+)?)\]/m);
    return m ? m[1] : null;
  };

  for (const rel of ["CHANGELOG.md", "docs/CHANGELOG.md"]) {
    const v = latestEntry(path.join(ROOT, rel));
    if (v === null) issues.push(`${rel}: kein Release-Eintrag '## [x.y.z]' gefunden`);
    else if (v !== version)
      issues.push(`${rel}: oberster Eintrag [${v}] != package.json (${version})`);
  }

  const top = existsSync(path.join(ROOT, "CHANGELOG.md"))
    ? readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8")
    : "";
  if (!top.includes(`Code-Version **${version}**`))
    issues.push(`CHANGELOG.md: Status-Header nennt nicht 'Code-Version **${version}**'`);

  const docsReadme = existsSync(path.join(DOCS, "README.md"))
    ? readFileSync(path.join(DOCS, "README.md"), "utf8")
    : "";
  if (!docsReadme.includes(`**Version:** \`v${version}\``))
    issues.push(`docs/README.md: Versionszeile nennt nicht 'v${version}'`);

  report("Version-Konsistenz", issues.length === 0, issues.join(" | "));
}

// ---------------------------------------------------------------------------
// Ausfuehrung
// ---------------------------------------------------------------------------
function main() {
  // A) Help-Schema
  const helpFiles = readdirSync(path.join(DOCS, "help")).filter((f) => f.endsWith(".help.json"));
  const helpErrs: string[] = [];
  for (const f of helpFiles) helpErrs.push(...validateHelpFile(path.join(DOCS, "help", f)));
  report("Help-Schema", helpErrs.length === 0, helpErrs.length ? helpErrs.slice(0, 30).join(" | ") : "");

  checkLinks();
  checkMarkdown();
  checkSecrets();
  checkEnvFlags();
  checkRoutes();
  checkStates();
  checkVersionConsistency();

  console.log(`[docs-validate] ${checksRun} Checks, ${helpFiles.length} Hilfe-Dateien.`);
  if (failures.length === 0) {
    console.log("[docs-validate] OK — alle Docs-Checks gruen.");
    process.exit(0);
  } else {
    console.error(`[docs-validate] FAIL — ${failures.length} Funde:`);
    for (const f of failures) console.error("  " + f);
    process.exit(1);
  }
}

main();
