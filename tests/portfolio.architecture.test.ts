/**
 * Architektur-Tests des Portfolio-Moduls (Task 05).
 *
 * Das Portfolio-Modul ist die mathematische Autorität der Plattform. Ihre
 * Glaubwürdigkeit hängt an vier Eigenschaften, die hier **statisch** über
 * einen Quelltext-/Import-Scan erzwungen werden:
 *   1. kein LLM-Import (Interpretation und Berechnung bleiben getrennt),
 *   2. kein Netzwerk, keine Datenbank, keine Broker-/Order-Pfade,
 *   3. kein Zufall, keine Uhr im Kern (Determinismus),
 *   4. kein Dateizugriff außerhalb der Audit-Senke.
 *
 * Zusätzlich: Formel-TSDoc an jeder exportierten Rechenfunktion, Vollständigkeit
 * der Hilfe-JSON und der Doku, und die Pflicht der API, ausschließlich über die
 * Risk-Guard-Kette zu gehen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const PORTFOLIO_DIR = path.join(process.cwd(), "src/portfolio");
const API_DIR = path.join(process.cwd(), "src/app/api/portfolio");
const ROOT = process.cwd();

/** Alle `.ts`-Dateien eines Verzeichnisses (rekursiv). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Alle Import-Specifier einer Quelle (statisch und dynamisch). */
function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) specifiers.push(match[1]);
  const dynamic = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = dynamic.exec(source)) !== null) specifiers.push(match[1]);
  const required = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = required.exec(source)) !== null) specifiers.push(match[1]);
  return specifiers;
}

const FORBIDDEN_IMPORT =
  /(ollama|llmProvider|openai|anthropic|claude|gemini|analysts|prompt|langchain|\/engine|microExecutor|\/db\b|drizzle|\/brokers?\/|\bws\b|node:http|node:https|node:child_process|node:net|node:dgram)/i;

test("Architektur: kein LLM, kein Netzwerk, keine DB, keine Broker im Portfolio-Modul", () => {
  const files = sourceFiles(PORTFOLIO_DIR);
  assert.ok(files.length >= 10, `erwartet ≥ 10 Dateien, gefunden ${files.length}`);
  for (const file of files) {
    if (path.basename(file) === "auditFile.ts") continue; // dokumentierte Ausnahme (task-01/06)
    for (const specifier of importsOf(readFileSync(file, "utf8"))) {
      assert.ok(
        !FORBIDDEN_IMPORT.test(specifier),
        `${path.relative(ROOT, file)} importiert verbotenes Modul "${specifier}"`
      );
    }
  }
});

test("Architektur: die einzige Datei mit Dateizugriff ist auditFile.ts", () => {
  for (const file of sourceFiles(PORTFOLIO_DIR)) {
    const source = readFileSync(file, "utf8");
    if (path.basename(file) === "auditFile.ts") continue;
    assert.ok(!/from\s+["']node:fs/.test(source), `${file} importiert node:fs`);
    assert.ok(
      !/writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|readFileSync|mkdirSync/.test(source),
      `${path.relative(ROOT, file)} greift auf das Dateisystem zu`
    );
  }
});

test("Architektur: kein Zufall, kein fetch, kein eval, keine Uhr im Kern", () => {
  for (const file of sourceFiles(PORTFOLIO_DIR)) {
    const source = readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file);
    assert.ok(!/Math\.random\s*\(/.test(source), `${rel} nutzt Math.random`);
    assert.ok(!/(^|[^.\w])fetch\s*\(/.test(source), `${rel} nutzt fetch`);
    assert.ok(!/\beval\s*\(/.test(source), `${rel} nutzt eval`);
    assert.ok(!/child_process|execSync|spawnSync/.test(source), `${rel} startet Prozesse`);
    assert.ok(!/Date\.now\s*\(/.test(source), `${rel} nutzt Date.now()`);
    assert.ok(!/new\s+Date\s*\(/.test(source), `${rel} erzeugt eine eigene Uhr (Zeit muss injiziert werden)`);
    assert.ok(
      !/process\.env\.(?!PORTFOLIO_AUDIT_DIR|PORTFOLIO_AUDIT\b|PORTFOLIO_AUDIT_DB)/.test(source),
      `${rel} liest fremde Umgebungsvariablen`
    );
    if (path.basename(file) !== "auditFile.ts") {
      assert.ok(!/process\.env/.test(source), `${rel} liest Umgebungsvariablen (nur auditFile.ts darf das)`);
    }
  }
});

test("Architektur: auditFile.ts ist als Integrationspunkt gekennzeichnet", () => {
  const source = readFileSync(path.join(PORTFOLIO_DIR, "auditFile.ts"), "utf8");
  assert.match(source, /vgl\. task-01\/06/, "Hinweis auf die zentrale audit_log-Integration fehlt");
  assert.match(source, /export function fileAuditSink/);
  assert.match(source, /export function dbAuditSink/);
  // Kein Secret darf ins Audit-Log: nur strukturierte Felder werden serialisiert.
  assert.match(source, /EVENT_FIELDS/);
});

test("Architektur: Formel-TSDoc an jeder exportierten Rechenfunktion", () => {
  const files = ["metrics.ts", "correlation.ts", "numeric.ts", "optimize.ts"];
  let checked = 0;
  for (const name of files) {
    const source = readFileSync(path.join(PORTFOLIO_DIR, name), "utf8");
    const exported = [...source.matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
    assert.ok(exported.length > 0, `${name}: keine exportierten Funktionen gefunden`);
    for (const fn of exported) {
      const index = source.indexOf(`export function ${fn}`);
      const before = source.slice(Math.max(0, index - 2500), index);
      const docStart = before.lastIndexOf("/**");
      assert.ok(docStart >= 0, `${name}: ${fn} hat kein TSDoc`);
      const doc = before.slice(docStart);
      const backticked = [...doc.matchAll(/`([^`]+)`/g)].map((m) => m[1]).join(" ");
      const hasFormula = /[=≤≥≈∝Σ√·ᵀ²⁻¹]/.test(backticked);
      const hasMethod =
        /Formel|Verfahren|Regel|Projektion|Zerlegung|Löst|Baut|Prüft|Extrahiert|Schätzt|Macht|Rundet|Erzeugt|Wandelt|Begrenzt|Verteilt|Schließt|Validiert|Liefert|Gibt|Setzt/.test(
          doc
        );
      assert.ok(
        hasFormula || hasMethod,
        `${name}: ${fn} dokumentiert weder eine Formel noch das Verfahren`
      );
      checked++;
    }
  }
  assert.ok(checked >= 30, `erwartet ≥ 30 dokumentierte Funktionen, gefunden ${checked}`);
});

test("Architektur: die API nutzt ausschließlich die Risk-Guard-Kette", () => {
  const route = readFileSync(path.join(API_DIR, "optimize/route.ts"), "utf8");
  assert.match(route, /optimizeWithGuard/, "die Route muss optimizeWithGuard verwenden");
  assert.ok(!/optimizePortfolio/.test(route), "die Route darf den rohen Optimizer nicht direkt aufrufen");
  assert.match(route, /export const dynamic = "force-dynamic"/);
  for (const file of sourceFiles(API_DIR)) {
    const source = readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file);
    // Read-only: keine Order-, Positions- oder Ledger-Mutation.
    // Read-only: keine Order-, Positions-, Ledger- oder Broker-Aufrufe.
    assert.ok(
      !/(submitOrder|placeOrder|cancelOrder|killSwitch|orderStore|positionsStore|paperBroker|liveBroker|brokerFactory|drizzle|from "@\/db")/i.test(
        source
      ),
      `${rel} berührt Order-, Positions- oder Ledger-Pfade`
    );
    // Keine Secrets in Antworten.
    assert.ok(!/process\.env\.(?!PORTFOLIO_AUDIT)/.test(source), `${rel} liest fremde Umgebungsvariablen`);
    for (const specifier of importsOf(source)) {
      assert.ok(!/(ollama|llmProvider|openai|anthropic|claude|gemini|analysts|langchain)/i.test(specifier), `${rel} importiert LLM-Modul`);
    }
  }
});

test("Architektur: GET ist auf allen drei Routen verboten (read-only POST)", () => {
  for (const name of ["metrics", "correlation", "optimize"]) {
    const source = readFileSync(path.join(API_DIR, name, "route.ts"), "utf8");
    assert.match(source, /export function GET\(\): Response \{\s*return methodNotAllowed\(\);/, `${name}: GET fehlt`);
    assert.match(source, /export async function POST/);
  }
});

test("Architektur: Autoritätskette ist als Konstante fixiert", () => {
  const types = readFileSync(path.join(PORTFOLIO_DIR, "types.ts"), "utf8");
  assert.match(types, /"portfolio-optimizer",\s*"risk-guard",\s*"position-limits",\s*"correlation-limits"/);
  const guard = readFileSync(path.join(PORTFOLIO_DIR, "riskGuard.ts"), "utf8");
  assert.match(guard, /assertAuthorityChain\(params\.chain, \{ complete: !params\.rejected \}\)/);
});

test("Doku: portfolio.help.json deckt alle Pflichtbegriffe im 3-Ebenen-Schema ab", () => {
  const help = JSON.parse(readFileSync(path.join(ROOT, "docs/help/portfolio.help.json"), "utf8")) as {
    id: string;
    version: number;
    fields: Record<string, { kurzinfo?: string; technischeInfo?: string; risiko?: string }>;
  };
  assert.equal(help.id, "portfolio");
  assert.equal(typeof help.version, "number");
  for (const key of [
    "volatilitaet",
    "korrelation",
    "sharpe",
    "sortino",
    "maxDrawdown",
    "profitFactor",
    "minVariance",
    "maxSharpe",
    "riskParity",
    "riskGuard",
  ]) {
    assert.ok(help.fields[key], `Hilfetext für ${key} fehlt`);
  }
  for (const [key, entry] of Object.entries(help.fields)) {
    for (const level of ["kurzinfo", "technischeInfo", "risiko"] as const) {
      const text = entry[level];
      assert.equal(typeof text, "string", `${key}.${level} fehlt`);
      assert.ok((text ?? "").length >= 40, `${key}.${level} ist zu knapp`);
    }
  }
  // Der vorgegebene Wortlaut der Aufgabenstellung für „Volatilität“.
  assert.match(help.fields.volatilitaet.kurzinfo ?? "", /nicht automatisch ein gutes Handelssignal/);
  assert.match(help.fields.volatilitaet.risiko ?? "", /zulässige Positionsgröße/);
});

test("Doku: PORTFOLIO_ANALYTICS.md enthält Formelkatalog, Kette und LLM-Abschnitt", () => {
  const doc = readFileSync(path.join(ROOT, "docs/PORTFOLIO_ANALYTICS.md"), "utf8");
  for (const heading of [
    "Formelkatalog",
    "Optimizer",
    "Risk-Guard-Kette",
    "Konvergenz",
    "API-Referenz",
    "Warum das LLM keine Gewichte berechnet",
  ]) {
    assert.ok(doc.includes(heading), `Abschnitt "${heading}" fehlt`);
  }
  for (const formula of [
    "min_variance",
    "max_sharpe",
    "risk_parity",
    "Portfolio Optimizer",
    "Position Limits",
    "Correlation Limits",
    "POST /api/portfolio/metrics",
    "POST /api/portfolio/correlation",
    "POST /api/portfolio/optimize",
  ]) {
    assert.ok(doc.includes(formula), `"${formula}" ist nicht dokumentiert`);
  }
});

test("Doku: README-Index und /api/docs-Whitelist kennen das neue Dokument", () => {
  const readme = readFileSync(path.join(ROOT, "docs/README.md"), "utf8");
  assert.match(readme, /PORTFOLIO_ANALYTICS\.md/);
  const docsRoute = readFileSync(path.join(ROOT, "src/app/api/docs/route.ts"), "utf8");
  assert.match(docsRoute, /docs\/PORTFOLIO_ANALYTICS\.md/);
});

test("Doku: Security-Audit-Kapitel für Task 05 existiert", () => {
  const audit = readFileSync(path.join(ROOT, "docs/SECURITY_AUDIT.md"), "utf8");
  assert.match(audit, /## Security Audit — Task 05/);
  const haystack = audit.toLowerCase();
  for (const criterion of ["read-only", "größenlimits", "determinismus", "kein llm-import"]) {
    assert.ok(haystack.includes(criterion), `Kriterium "${criterion}" fehlt im Audit-Kapitel`);
  }
  assert.match(audit, /\| R-01 /, "Befundtabelle mit R-IDs fehlt");
});

test("Doku: CHANGELOG führt Task 05", () => {
  const changelog = readFileSync(path.join(ROOT, "docs/CHANGELOG.md"), "utf8");
  assert.match(changelog, /Task 05/);
  assert.match(changelog, /src\/portfolio/);
});
