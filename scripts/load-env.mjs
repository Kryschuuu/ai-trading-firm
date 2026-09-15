/**
 * Lädt die projekt-eigene `.env` — shell-unabhängig (bash, zsh, **fish**).
 *
 * ── Warum das überhaupt ein Modul braucht ──────────────────────────────────
 * Setup- und Reset-Anleitungen dieses Projekts arbeiten mit
 *
 *     set -a; . ./.env; set +a
 *
 * Das ist bash-Syntax. In **fish** ist es ein Fehler (`invalid variable name`),
 * und die Folge ist tückischer als der Fehler: `$DATABASE_URL` bleibt leer,
 * `psql`/`pg_dump` fallen auf die libpq-Defaults zurück (Unix-Socket,
 * OS-Benutzer) und melden
 *
 *     FATAL: role "<login>" does not exist
 *
 * als wäre die Datenbank kaputt. Siehe Befund SET-10 in docs/SETUP_BUGS.md.
 *
 * ── Die Regel ───────────────────────────────────────────────────────────────
 * `dotenv` (17.3.1) wird nur in den Prozessen der App selbst geladen
 * (`next start`, `scripts/*` über `--import tsx`, `drizzle.config.ts`). Für
 * **Shell-Befehle** (`psql`, `pg_dump`, `npm run …` mit env-Defaults) braucht
 * die Shell dieselben Werte — und zwar aus demselben Parser, damit
 * „lokal läuft's, im Terminal nicht" gar nicht erst entstehen kann.
 *
 * Die Formatierung (Quotes, ` #`-Kommentare, `export`-Präfix, CRLF) lebt
 * ausschließlich in `scripts/env-run.sh`; dieses Skript ist nur der
 * Node-Ausgang für Nicht-bash-Shells. Getestet in `tests/setupScripts.test.ts`.
 *
 * ── Verwendung ──────────────────────────────────────────────────────────────
 *   fish:        scripts/env-run.sh --fish | source
 *   jedes Shell:  eval "$(node scripts/load-env.mjs --sh)"
 *   ein Wert:     node scripts/load-env.mjs --print DATABASE_URL
 *   prüfen:       node scripts/load-env.mjs --check
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ENV_RUN = path.join(HERE, "env-run.sh");

const opts = { print: "", envFile: "", mode: "sh", check: false, raw: false };
{
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => {
      const v = args[++i];
      if (v === undefined) {
        process.stderr.write(`load-env: ${a} braucht einen Wert\n`);
        process.exit(2);
      }
      return v;
    };
    switch (a) {
      case "--sh": case "--bash": case "--zsh": opts.mode = "sh"; break;
      case "--fish":  opts.mode = "fish"; break;
      case "--keys":  opts.mode = "keys"; break;
      case "--check": opts.check = true; break;
      case "--print": opts.print = next(); break;
      case "--raw":   opts.raw = true; break;      // wie env-run.sh: unmaskiert
      case "--env-file": opts.envFile = next(); break;
      case "-h": case "--help":
        process.stdout.write(
          "load-env.mjs — .env shell-unabhängig lesen\n" +
          "  --sh | --fish | --keys | --print KEY | --raw | --check [--env-file PFAD]\n" +
          "  (Formatierung identisch zu scripts/env-run.sh)\n",
        );
        process.exit(0);
      default:
        process.stderr.write(`load-env: unbekannte Option ${a}  (--help)\n`);
        process.exit(2);
    }
  }
}
const envFile = opts.envFile || process.env.ENV_FILE || path.join(ROOT, ".env");

/**
 * Minimaler dotenv-Parser — Bewusst ein Nachbau der dokumentierten Regeln aus
 * `scripts/env-run.sh`, kein Import: fish/nushell/PowerShell-User haben nicht
 * immer bash, und dieser Weg ist der Fallback-Pfad. Die Regel-Tabelle steht in
 * `tests/setupScripts.test.ts` und gilt für beide Implementierungen.
 */
export function parseEnvText(text) {
  const out = [];
  const stats = { bad: 0 };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^[ \t]*$/.test(line) || /^[ \t]*#/.test(line)) continue;
    line = line.replace(/^[ \t]+/, "").replace(/^export[ \t]+/, "").replace(/^[ \t]+/, "");
    const eq = line.indexOf("=");
    if (eq === -1) {
      process.stderr.write(`load-env:${i + 1}: zeile ohne = uebersprungen: ${line.slice(0, 40)}\n`);
      stats.bad++;
      continue;
    }
    const key = line.slice(0, eq).replace(/[ \t]/g, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      process.stderr.write(`load-env:${i + 1}: ungueltiger schluesselname: ${key.slice(0, 32)}\n`);
      stats.bad++;
      continue;
    }
    let val = line.slice(eq + 1).replace(/^[ \t]+/, "");
    const q = val[0];
    if ((q === '"' || q === "'") && val.length >= 2 && val.endsWith(q)) {
      val = val.slice(1, -1);
    } else if (q === '"' || q === "'") {
      val = val.slice(1).replace(/[ \t].*$/, "");
    } else {
      val = val.replace(/[ \t]#.*$/, "").replace(/[ \t]+$/, "");
    }
    out.push([key, val]);
  }
  return { entries: out, ...stats };
}

function shellQuote(v) {
  return `"${shellEscape(v)}"`;
}
// Wie der esc_shell()-Zweig in scripts/env-run.sh: innerhalb "…" sind in bash
// nur \ " $ ` wirksam — genau die werden maskiert, damit `eval` den Wert
// woertlich nimmt. Bewusst separat: --print liefert den Wert OHNE Quotes.
function shellEscape(v) {
  return v.replace(/[\\$"`]/g, (c) => "\\" + c);
}

function fishQuote(v) {
  if (v === "") return "''";
  const safe = /[A-Za-z0-9._/@:^=+,-]/;
  let out = "";
  for (const c of v) {
    if (safe.test(c)) out += c;
    else if (c === " ") out += "\\ ";
    else out += "\\" + c;
  }
  return out;
}

function readEnv() {
  if (!existsSync(envFile)) {
    process.stderr.write(
      `load-env: keine .env gefunden (${envFile})\n` +
        `  Vorlage anlegen: cp .env.example .env && chmod 600 .env\n` +
        `  Oder Pfad nennen: ENV_FILE=/pfad/.env node scripts/load-env.mjs\n`,
    );
    process.exit(1);
  }
  return parseEnvText(readFileSync(envFile, "utf8"));
}

// ── Modi ────────────────────────────────────────────────────────────────────
// --check hat dieselbe Vertragserwartung wie scripts/env-run.sh --check:
// eine fehlerhafte Zeile ist ein Befund (Exit 1), nicht nur eine Randnotiz.
if (opts.check) {
  const parsed = readEnv();
  if (parsed.bad > 0) {
    process.stderr.write(`load-env: ${parsed.bad} fehlerhafte Zeile(n) in ${envFile}\n`);
    process.exit(1);
  }
  if (parsed.entries.length === 0) {
    process.stderr.write(`load-env: .env ohne gueltige Eintraege (${envFile})\n`);
    process.exit(1);
  }
  process.stdout.write(`load-env: .env ok (${envFile}) — ${parsed.entries.length} Eintraege\n`);
  process.exit(0);
}
if (opts.print) {
  const hit = readEnv().entries.find(([k]) => k === opts.print);
  if (!hit) process.exit(1);
  // Ohne --raw wird maskiert (eval-sicher, identisch zu env-run.sh --print);
  // mit --raw liefert beide Loader den Realwert für Werkzeuge.
  process.stdout.write((opts.raw ? hit[1] : shellEscape(hit[1])) + "\n");
  process.exit(0);
}
if (opts.mode === "fish") {
  const r = spawnSync("bash", [ENV_RUN, "--env-file", envFile, "--fish"], { encoding: "utf8" });
  if (r.error) {
    // Kein bash? Dann aus diesem Prozess heraus formatieren — der Parser ist identisch.
    process.stdout.write(readEnv().entries.map(([k, v]) => `set -gx ${k} ${fishQuote(v)}`).join("\n") + "\n");
    process.exit(0);
  }
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  process.exit(r.status ?? 0);
}
if (opts.mode === "keys") {
  process.stdout.write(readEnv().entries.map(([k]) => k).join("\n") + "\n");
  process.exit(0);
}
process.stdout.write(readEnv().entries.map(([k, v]) => `export ${k}=${shellQuote(v)}`).join("\n") + "\n");
