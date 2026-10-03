/**
 * `npm run docs:validate` — Docs-as-Code-CI-Validator (Task 12 + Repo-Cleanup 2026-09-05).
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
 *      - Env-Flag-Namen in CONFIGURATION.md / INSTALL.md existieren im Code (src/**).
 *      - API-Routen in docs/ existieren als registrierte Routen (src/app/api).
 *      - Zustandsnamen in LIVE_TRADING.md == Live-Gate-Enum (src/live-gate/states.ts).
 *      - Alle docs/help/*.help.json erfuellen die 3-Ebenen-Pflicht (via A).
 *   F) Versions-Konsistenz: package.json == oberster Eintrag in CHANGELOG.md
 *      (kanonisch im Root, docs/CHANGELOG.md ist Stub) == Status-Header == docs/README.md.
 *
 * Struktur-Update 2026-09-05:
 *   - docs/CHANGELOG.md ist jetzt Stub → nur Root wird version-geprüft
 *   - Flag-Referenz: CONFIGURATION.md (Root) + docs/INSTALL.md (CachyOS)
 *   - Neue Ordner audits/, peer-reviews/, security/, archive/ sind ausgenommen von strikten Checks
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import GithubSlugger from "github-slugger";
import { extractMarkdownLinks, resolveDocLink, splitAnchor } from "../src/lib/docsLinks";

const ROOT = process.cwd();
const DOCS = path.join(ROOT, "docs");
const SRC = path.join(ROOT, "src");
/**
 * Markdown-Dateien im Repo-Root, die von der Doku verlinkt werden.
 * Sie gehoeren zur Link-Pruefung dazu (Befund C3): `docs/README.md` verlinkt
 * `../CHANGELOG.md`, `docs/BACKTESTING.md` verlinkt `../CONFIGURATION.md#…` —
 * beides war vorher ungeprueft.
 */
const ROOT_MD = ["CHANGELOG.md", "CONFIGURATION.md", "CONTRIBUTING.md", "INSTALL.md", "README.md", "VERSION.md"]
  .map((f) => path.join(ROOT, f))
  .filter((f) => existsSync(f));

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
// B) Link-Check (relative Links innerhalb docs/ + Root-Dateien)
// ---------------------------------------------------------------------------
/**
 * Anker einer Ueberschrift — exakt der Algorithmus von `github-slugger`
 * (und damit von `rehype-slug`, das der Viewer benutzt).
 *
 * Vorher stand hier ein „github-aehnlicher“ Nachbau, der `[^\w\s-]` entfernte
 * und damit auch Umlaute killte (`über` -> `ber`). Ergebnis: der Check
 * verglich zwei verschiedene Algorithmen und war halb aussagekraeftig
 * (Befund C2). Jetzt ist es dieselbe Bibliothek, die auch rendert.
 */
function headingSlug(h: string): string {
  return new GithubSlugger().slug(headingText(h));
}

/**
 * Ueberschrift ohne ATX-Prefix und ohne Inline-Markdown.
 *
 * Wichtig: `_` bleibt erhalten — `github-slugger` zaehlt es zu den
 * Wortzeichen (`AUTH_MODE` -> `auth_mode`). `*` und Backticks fallen weg.
 */
function headingText(h: string): string {
  return h
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+#+\s*$/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [Text](ziel) -> Text
    .replace(/\*\*|__/g, "")
    .replace(/\*/g, "")
    .replace(/`/g, "")
    .trim();
}

/**
 * Alle Anker-IDs einer Datei in Dokumentreihenfolge — inklusive der
 * `-1`/`-2`-Suffixe, die `github-slugger` bei doppelten Titeln vergibt.
 */
function headingSlugs(content: string): string[] {
  const slugger = new GithubSlugger();
  const out: string[] = [];
  let inFence = false;
  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) out.push(slugger.slug(headingText(m[2])));
  }
  return out;
}

const slugCache = new Map<string, string[]>();
function slugsOf(file: string): string[] {
  const cached = slugCache.get(file);
  if (cached) return cached;
  let slugs: string[] = [];
  try {
    slugs = headingSlugs(readFileSync(file, "utf8"));
  } catch {
    slugs = [];
  }
  slugCache.set(file, slugs);
  return slugs;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * B) Link-Check — die **GitHub-Sicht**: existiert das Ziel auf der Platte?
 *
 * Zusaetzlich zu frueher: Root-Dateien (Befund C3) und reine In-Page-Anker
 * werden geprueft. Fuer die Browser-Sicht ist {@link checkAppLinks} zustaendig.
 */
function checkLinks() {
  const files = [...mdFiles(DOCS), ...ROOT_MD];
  const dead: string[] = [];
  for (const file of files) {
    const base = path.dirname(file);
    const rel = path.relative(ROOT, file);
    for (const target of extractMarkdownLinks(readFileSync(file, "utf8"))) {
      const [p, anchor] = splitAnchor(target);
      const resolved = p ? path.resolve(base, safeDecode(p)) : file;

      if (p && !existsSync(resolved)) {
        dead.push(`${rel}: toter Link -> ${target}`);
        continue;
      }
      if (!anchor) continue;
      const slugs = slugsOf(resolved);
      if (!slugs.includes(safeDecode(anchor))) {
        dead.push(`${rel}: toter Anker -> ${target}`);
      }
    }
  }
  report("Link-Check", dead.length === 0, dead.length ? dead.slice(0, 25).join(" | ") : "");
}

// ---------------------------------------------------------------------------
// B2) App-Link-Check — die **Browser-Sicht** (Befund C1)
// ---------------------------------------------------------------------------
/**
 * Simuliert die Aufloesung des Viewers und vergleicht sie mit der GitHub-Sicht.
 *
 * Genau diese Pruefung haette die 903 toten und 127 falschen Treffer des
 * Ausgangsbefunds gefunden: der bisherige Check pruefte nur, ob die Datei
 * existiert — nicht, ob `/docs/<Ziel>` im Browser dort landet.
 *
 * Verlangt wird die Aufloesung nur fuer **Markdown-Ziele**. Alles andere stellt
 * der Viewer absichtlich als nicht klickbaren Code-Text dar (Befund B7) und
 * zaehlt nur als Statistik: Ziele ausserhalb von `docs/` (`../src/db/schema.ts`,
 * `../drizzle/*.sql`), Nicht-Markdown-Dateien (`help/*.help.json`, `*.csv`) und
 * Verzeichnisse ohne `README.md` (`findings/`, `patches/`, `task-plans/`).
 */
function checkAppLinks() {
  const files = [...mdFiles(DOCS), ...ROOT_MD];
  const fsProbe = {
    isFile: (f: string) => {
      try {
        return statSync(path.join(ROOT, f)).isFile();
      } catch {
        return false;
      }
    },
    isDir: (d: string) => {
      try {
        return statSync(path.join(ROOT, d)).isDirectory();
      } catch {
        return false;
      }
    },
  };

  const broken: string[] = []; // App zeigt 404
  const wrong: string[] = []; // App zeigt ein anderes Dokument
  let resolved = 0;
  let outside = 0;

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    for (const target of extractMarkdownLinks(readFileSync(file, "utf8"))) {
      const [p] = splitAnchor(target);
      if (!p) continue; // reiner Anker (von checkLinks geprueft)

      const expected = path.relative(ROOT, path.resolve(path.dirname(file), safeDecode(p)));
      const insideDocs = expected.startsWith("docs/");
      const isRootMd = !expected.includes("/") && expected.endsWith(".md");
      if (!insideDocs && !isRootMd) {
        outside++;
        continue;
      }
      if (!expected.endsWith(".md")) {
        // Verzeichnis-Ziel: der Viewer verlinkt `<dir>/README.md`, wenn sie
        // existiert — sonst bleibt es Code-Text. Beides ist kein Fehler.
        const readme = `${expected}/README.md`;
        outside++;
        if (fsProbe.isFile(readme)) {
          const resolution = resolveDocLink(target, rel, fsProbe);
          if (resolution.kind !== "doc" || resolution.file !== readme) {
            wrong.push(
              `${rel}: Verzeichnisziel loest nicht auf sein README auf -> ${target} (erwartet ${readme})`,
            );
          } else {
            resolved++;
          }
        }
        continue;
      }
      const want = expected;

      const resolution = resolveDocLink(target, rel, fsProbe);
      if (resolution.kind !== "doc") {
        broken.push(`${rel}: in der App nicht erreichbar -> ${target}`);
      } else if (path.relative(ROOT, path.resolve(ROOT, resolution.file)) !== want) {
        wrong.push(
          `${rel}: zeigt auf das falsche Dokument -> ${target} (erwartet ${want}, App liefert ${resolution.file})`,
        );
      } else {
        resolved++;
      }
    }
  }

  report(
    "App-Link-Check",
    broken.length === 0 && wrong.length === 0,
    broken.length || wrong.length
      ? [...broken, ...wrong].slice(0, 25).join(" | ")
      : "",
  );
  console.log(
    `[docs-validate] App-Link-Check: ${resolved} korrekt aufgelöst, ` +
      `${outside} außerhalb von docs/ (bewusst als Code-Text).`,
  );
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
  const fromSrc = walk(SRC).filter((f) => CODE_EXT.includes(path.extname(f)));
  // GAP-08 (v1.49.0): CLI-Runner unter scripts/ sind ebenfalls Code — deren
  // Env-Flags (z. B. EVAL_OUTPUT_DIR in scripts/eval-prompts.ts) zählen als
  // „im Code gefunden“. Wird nur vom Env-Flags-Check genutzt (Richtung
  // Doku→Code), kann also nur Fehlalarme entfernen, keine erzeugen.
  const scriptsDir = path.join(ROOT, "scripts");
  const fromScripts = existsSync(scriptsDir)
    ? walk(scriptsDir).filter((f) => CODE_EXT.includes(path.extname(f)))
    : [];
  return [...fromSrc, ...fromScripts];
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
  // Neue Struktur 2026-09-05: Flag-Referenz ist CONFIGURATION.md (Root) + docs/INSTALL.md (CachyOS) + INSTALL.md (Wrapper)
  const docTargets = [
    path.join(ROOT, "CONFIGURATION.md"),
    path.join(ROOT, "INSTALL.md"),
    path.join(DOCS, "INSTALL.md"),
    path.join(DOCS, "CONFIGURATION.md"),
  ];
  const issues: string[] = [];
  for (const t of docTargets) {
    if (!existsSync(t)) continue;
    const src = readFileSync(t, "utf8");
    // Stub-Dateien (Weiterleitung) überspringen
    if (src.includes("Weiterleitung") && src.length < 1500) continue;
    const flags = [...src.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)].map((m) => m[0]);
    for (const f of new Set(flags)) {
      if (/(_URL|_KEY|_TOKEN|_ENABLED|_DIR|_MS|_CTX|_PORT|_BASE|_PATH|_DATA|_AUDIT|_MODEL|_PROVIDER|_BUDGET|_FLAG)$/.test(f) && !codeFlags.has(f)) {
        issues.push(`${path.relative(ROOT, t)} dokumentiert Flag '${f}', nicht im Code gefunden`);
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
    "SECURITY_AUDIT.md", // referenziert Quell-Pfade (z. B. src/app/api/portfolio/parse.ts) — jetzt in security/
    "AUDIT_REMEDIATION_2026-09.md", // alt, jetzt in audits/
    "PEER_REVIEW_BITUNIX_EXECUTION.md",
    "PEER_REVIEW_LIVE_TRADING.md",
    "PEER_REVIEW_ROUTING_OVERRIDES.md",
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
    const content = readFileSync(file, "utf8");
    // Stub-Dateien (Weiterleitung) überspringen — kein Release-Eintrag erwartet
    if (content.includes("Weiterleitung") && content.length < 1500) return version;
    const m = content.match(/^## \[(\d+\.\d+\.\d+(?:-[\w.]+)?)\]/m);
    return m ? m[1] : null;
  };

  // Neue Struktur 2026-09-05: kanonisch ist nur noch CHANGELOG.md im Root, docs/CHANGELOG.md ist Stub
  const rootChangelog = path.join(ROOT, "CHANGELOG.md");
  const vRoot = latestEntry(rootChangelog);
  if (vRoot === null) issues.push(`CHANGELOG.md: kein Release-Eintrag '## [x.y.z]' gefunden`);
  else if (vRoot !== version) issues.push(`CHANGELOG.md: oberster Eintrag [${vRoot}] != package.json (${version})`);

  // docs/CHANGELOG.md nur prüfen wenn es kein Stub ist
  const docsChangelogPath = path.join(ROOT, "docs/CHANGELOG.md");
  if (existsSync(docsChangelogPath)) {
    const docsContent = readFileSync(docsChangelogPath, "utf8");
    if (!docsContent.includes("Weiterleitung")) {
      const vDocs = latestEntry(docsChangelogPath);
      if (vDocs === null) issues.push(`docs/CHANGELOG.md: kein Release-Eintrag '## [x.y.z]' gefunden`);
      else if (vDocs !== version) issues.push(`docs/CHANGELOG.md: oberster Eintrag [${vDocs}] != package.json (${version})`);
    }
  }

  const top = existsSync(rootChangelog) ? readFileSync(rootChangelog, "utf8") : "";
  if (!top.includes(`Code-Version **${version}**`))
    issues.push(`CHANGELOG.md: Status-Header nennt nicht 'Code-Version **${version}**'`);

  const docsReadme = existsSync(path.join(DOCS, "README.md")) ? readFileSync(path.join(DOCS, "README.md"), "utf8") : "";
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
  checkAppLinks();
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
