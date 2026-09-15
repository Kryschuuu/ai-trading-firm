/**
 * Tests für die Setup-Shell-Werkzeuge (v1.39.1) — Befunde SET-09 und SET-10.
 *
 * Beide Befunde sind reiner Shell-/Setup-Code, daher laufen diese Tests ohne
 * PostgreSQL und ohne Build:
 *
 *   SET-10 (fish/POSIX-Shells):  Anleitungen nutzten `set -a; . ./.env; set +a`.
 *     In fish ist das ein Syntaxfehler, `$DATABASE_URL` bleibt leer und
 *     `psql`/`pg_dump` fallen auf Unix-Socket + OS-Benutzer zurück
 *     („FATAL: role "<login>" does not exist"). `scripts/env-run.sh` ist der
 *     einizge Parser, der für bash/zsh UND fish formatiert — dieses Test-File
 *     hält ihn an den Randfällen fest (Quoting, ` #`, `export`, CRLF, Sonder-
 *     zeichen im Passwort, fehlende/unlesbare .env).
 *
 *   SET-09 (Setup bricht ohne Meldung ab):  Eine Schritt-Funktion, deren letzte
 *     Zeile ein Test war (`[[ -n "$API_TOKEN" ]] && ok …`), lieferte Status 1;
 *     `set -Eeuo pipefail` wertete das als Fehlschritt und main brach mit
 *     „Abbruch in Schritt „Konfiguration (.env)" (Zeile …, Exit 1)" ab — ohne
 *     jede Fehlermeldung. Und: der Rückfrage-Pfad „.env überschreiben? j" hat
 *     die Datei aus dem Template NEU geschrieben und dabei `FIRM_API_TOKEN`
 *     sowie alle Operator-Schlüssel still entfernt. Geprüft wird hier
 *     (a) das harte `return 0` am Ende aller Schritt-Funktionen,
 *     (b) Merge als Default (eigene Schlüssel bleiben erhalten),
 *     (c) `--force-env` = Backup + Rückholung bekannter Schlüssel.
 *
 * Exit-Codes der Getesteten sind Teil des Vertrags — deshalb wird jeder
 * Schritt über `bash -c` in einem Kindprozess gefahren, nie in diesem Prozess.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(process.cwd());
const ENV_RUN = path.join(REPO, "scripts", "env-run.sh");
const SETUP = path.join(REPO, "scripts", "setup-cachyos.sh");
const LOAD_ENV = path.join(REPO, "scripts", "load-env.mjs");

const node = (script: string, args: string[], cwd = REPO): Run =>
  run(process.execPath, ["--import", "tsx", script, ...args], { cwd });

const dirs: string[] = [];
function workDir(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `atf-${name}-`));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const d of dirs) {
    try {
      chmodSync(path.join(d, ".env"), 0o600);
    } catch {
      /* egal */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

type Run = { code: number; out: string; err: string };

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Run {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd ?? REPO,
    env: { ...process.env, ...opts.env },
    timeout: 120_000,
  });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const bash = (script: string, env?: NodeJS.ProcessEnv): Run => run("bash", ["-c", script], { env });

function hasShell(name: string): boolean {
  return run("bash", ["-c", `command -v ${name}`]).code === 0;
}

/** .env-Randfälle: Keys, die der Setup-Loader liefern muss. */
const TRICKY_ENV = [
  "# Erzeugt von Hand — Kommentarzeile bleibt unsichtbar",
  "",
  "DATABASE_URL=postgresql://trader:p@ss!$x#y@127.0.0.1:5432/trading_firm",
  "  export PORT = 3369   # Freigabe",
  "PAPER_MODE=\"broker-market-data\"",
  "GELISTE='a b c'",
  "LEERWERT=",
  "CRLF_WERT=wert\r",
  "KAPUTT diese Zeile hat kein Gleichheitszeichen",
].join("\n");

test("env-run.sh: PARSE — Kommentare, export, Quotes, #Kommentar, CRLF, Sonderzeichen", () => {
  const dir = workDir("parse");
  const envFile = path.join(dir, ".env");
  writeFileSync(envFile, TRICKY_ENV, { mode: 0o600 });

  const keys = bash(`"${ENV_RUN}" --env-file "${envFile}" --keys`);
  assert.equal(keys.code, 0, keys.err);
  const names = keys.out.split("\n").filter(Boolean);
  assert.deepEqual(
    names,
    ["DATABASE_URL", "PORT", "PAPER_MODE", "GELISTE", "LEERWERT", "CRLF_WERT"],
    "nur gueltige Eintraege, in Datei-Reihenfolge",
  );

  // --print KEY liefert NUR den Wert (bei beiden Loadlern identisch); --raw
  // schaltet die eval-Sicherung ab. Der Schlüssel wird nicht wiederholt —
  // `VAR="$(… --print KEY)"` ist genau der Anwendungsfall aus der Doku.
  const val = (k: string) => {
    const r = bash(`"${ENV_RUN}" --env-file "${envFile}" --raw --print ${k}`);
    assert.equal(r.code, 0, `--print ${k}: ${r.err}`);
    return r.out.replace(/\n$/, "");
  };

  // ` #`-Kommentar am unquotierten Wert ist dotenv-Konvention und MUSS weg;
  // ein `#` INNERHALB des Werts (Passwort) bleibt, weil er nicht auf ein
  // Leerzeichen folgt.
  assert.equal(val("DATABASE_URL"), "postgresql://trader:p@ss!$x#y@127.0.0.1:5432/trading_firm");
  assert.equal(val("PORT"), "3369");
  assert.equal(val("PAPER_MODE"), "broker-market-data");
  assert.equal(val("GELISTE"), "a b c");
  assert.equal(val("LEERWERT"), "");
  assert.equal(val("CRLF_WERT"), "wert", "CRLF-Zeilenende wird abgeschnitten");

  // Die eval-Ausgabe maskiert `$`, damit `eval` den Wert wörtlich nimmt.
  const shellForm = bash(`"${ENV_RUN}" --env-file "${envFile}" --print DATABASE_URL`).out;
  assert.match(shellForm, /\$x/, " Dollar im Wert muss vor eval maskiert sein: " + shellForm);

  // Zeilennummer in der Warnung (Reg: Zeile 9, nicht 8).
  const check = bash(`"${ENV_RUN}" --env-file "${envFile}" --check`);
  assert.equal(check.code, 1, "eine Zeile ohne '=' ist ein Befund");
  assert.match(check.err, /9: zeile ohne = uebersprungen/);
});


test("env-run.sh: bash-Ausgabe ist eval-sicher (Befehle in der .env werden nie ausgeführt)", () => {
  const dir = workDir("bash-eval");
  const envFile = path.join(dir, ".env");
  const marker = path.join(dir, "pwned");
  const dotenvText = [
    'DATABASE_URL="postgresql://u:pa$$w0rd@h:5432/db"',
    "EVIL=$(touch " + marker + ")",
    "AFTER=1",
  ].join("\n");
  writeFileSync(envFile, dotenvText, { mode: 0o600 });

  const printed = bash(`"${ENV_RUN}" --env-file "${envFile}"`);
  assert.equal(printed.code, 0, printed.err);
  // `eval "$(...)"` ist genau der Weg aus der Doku — der Test fährt ihn 1:1.
  const evalOut = bash(
    `set -a; eval "$("${ENV_RUN}" --env-file "${envFile}")"; set +a; ` +
      `printf 'URL=%s|AFTER=%s' "$DATABASE_URL" "$AFTER"`,
  );
  assert.equal(evalOut.code, 0, evalOut.err);
  assert.equal(evalOut.out, "URL=postgresql://u:pa$$w0rd@h:5432/db|AFTER=1", evalOut.out);
  assert.ok(!existsSync(marker), "Befehls-Substitution in der .env darf nie ausgefuehrt werden");
});

test("env-run.sh: fish-Ausgabe ist ein `set -gx` pro Eintrag, Werte maskiert", () => {
  const dir = workDir("fish");
  const envFile = path.join(dir, ".env");
  writeFileSync(envFile, TRICKY_ENV, { mode: 0o600 });

  const fish = bash(`"${ENV_RUN}" --env-file "${envFile}" --fish`);
  assert.equal(fish.code, 0, fish.err);
  const lines = fish.out.split("\n").filter(Boolean);
  assert.equal(lines.length, 6, fish.out);
  for (const l of lines) assert.match(l, /^set -gx [A-Za-z_][A-Za-z0-9_]* /, l);
  assert.match(
    lines[0]!,
    /DATABASE_URL postgresql:\/\/trader:p@ss\\!\\\$x\\#y@127\.0\.0\.1:5432\/trading_firm/,
    "fish maskiert ! $ # — sonst wären sie Token-Operatoren",
  );
  assert.match(fish.out, /^set -gx LEERWERT ''$/m, "leerer Wert bleibt als leeres Quote erhalten");
  assert.match(fish.out, /GELISTE a\\ b\\ c/, "Leerzeichen im Wert werden escapet, nicht quotiert-verloren");
});

test("env-run.sh: --exec-artiger Modus setzt das Env für den Kindprozess", () => {
  const dir = workDir("exec");
  const envFile = path.join(dir, ".env");
  writeFileSync(envFile, "DATABASE_URL=postgresql://u:p@h:5432/db\nPORT=3369\n", { mode: 0o600 });

  const r = bash(`"${ENV_RUN}" --env-file "${envFile}" -- printenv DATABASE_URL PORT`);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "postgresql://u:p@h:5432/db\n3369");
});

test("env-run.sh: fehlende und unlesbare .env brechen mit Handlungsempfehlung", () => {
  const dir = workDir("missing");
  const missing = bash(`"${ENV_RUN}" --env-file "${path.join(dir, "none.env")}"`);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /keine \.env gefunden/);
  assert.match(missing.err, /cp \.env\.example \.env/);

  const secret = path.join(dir, ".env");
  writeFileSync(secret, "A=1\n", { mode: 0o600 });
  chmodSync(secret, 0o000);
  const unreadable = bash(`"${ENV_RUN}" --env-file "${secret}"`);
  chmodSync(secret, 0o600);
  // Root liest alles — auf einem unprivilegierten Runner ist der Fehler Pflicht.
  if (process.getuid?.() !== 0) {
    assert.equal(unreadable.code, 1, unreadable.out + unreadable.err);
    assert.match(unreadable.err, /nicht lesbar/);
  } else {
    assert.equal(unreadable.code, 0);
  }

  const bad = bash(`"${ENV_RUN}" --unbekannt`);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unbekannte Option/);
});

test("setup-cachyos.sh: env_read_key liest wie dotenv (Quotes weg, Kommentar weg)", () => {
  const dir = workDir("read-key");
  const envFile = path.join(dir, ".env");
  writeFileSync(
    envFile,
    [
      'export A="x y"',
      "B='q w'",
      "C=v # kein Teil des Werts",
      "D = spacy ",
      "E=a=b",
      "F=leer",
      "G=pa\#ss",
      "F=leer",
      "HILFE=\r",
    ].join("\n"),
    { mode: 0o600 },
  );
  const harness = path.join(dir, "h.sh");
  writeFileSync(
    harness,
    [
      "#!/usr/bin/env bash",
      `source "${SETUP}" --variant a --non-interactive --log-file "${path.join(dir, "s.log")}" || true`,
      `for k in A B C D E F G; do printf '%s=[%s]\n' "$k" "$(env_read_key "$k" "${envFile}")"; done`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const r = bash(`"${harness}"`);
  assert.equal(r.code, 0, r.err);
  const got = Object.fromEntries(
    r.out
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  assert.equal(got.A, "[x y]", "export-Praefix + fuehrende Leerzeichen + Quotes");
  assert.equal(got.B, "[q w]", "einfache Quotes");
  assert.equal(got.C, "[v]", "unquotierter #Kommentar zaehlt nicht zum Wert");
  assert.equal(got.D, "[spacy]", "Leerzeichen um das = sind erlaubt (dotenv)");
  assert.equal(got.E, "[a=b]", "Wert darf = enthalten");
  assert.equal(got.F, "[leer]", "letzter Eintrag gewinnt (tail -1)");
});
test("load-env.mjs: liefert dieselben Einträge wie env-run.sh (ein Vertrag, zwei Wege)", () => {
  const dir = workDir("parity");
  const envFile = path.join(dir, ".env");
  writeFileSync(envFile, TRICKY_ENV, { mode: 0o600 });

  const sh = node(LOAD_ENV, ["--sh", "--env-file", envFile]);
  assert.equal(sh.code, 0, sh.err);
  // Das `$` im Wert ist in der Ausgabe maskiert (\$) — sonst wuerde `eval`
  // eine Variable daraus machen. Genau das ist der Punkt des Loaders.
  assert.match(
    sh.out,
    /^export DATABASE_URL="postgresql:\/\/trader:p@ss!\\\$x#y@127\.0\.0\.1:5432\/trading_firm"$/m,
  );
  assert.match(sh.out, /^export PORT="3369"$/m);
  assert.match(sh.out, /^export LEERWERT=""$/m, "leerer Wert bleibt erhalten");
  assert.ok(!/KAPUTT/.test(sh.out), "Zeile ohne = wird nie exportiert");

  const fish = node(LOAD_ENV, ["--fish", "--env-file", envFile]);
  assert.equal(fish.code, 0, fish.err);
  assert.match(fish.out, /^set -gx PORT 3369$/m);
  assert.match(fish.out, /^set -gx GELISTE a\\ b\\ c$/m);

  // Schlüsselmenge muss mit dem bash-Loader uebereinstimmen — sonst ist die
  // eine Variante still aelter als die andere.
  const keys = (out: string) =>
    out
      .split("\n")
      .filter(Boolean)
      .map((l) => l.replace(/^\s*(?:export\s+|set -gx\s+)/, "").split("=")[0].trim())
      .sort()
      .join(",");
  const a = keys(sh.out);
  const b = bash(`"${ENV_RUN}" --env-file "${envFile}" --keys`).out
    .split("\n")
    .filter(Boolean)
    .sort()
    .join(",");
  assert.equal(a, b, "env-run.sh und load-env.mjs lesen unterschiedlich");

  // --check: identische Vertragserwartung (fehlerhafte Zeile = Exit 1).
  const checkNode = node(LOAD_ENV, ["--check", "--env-file", envFile]);
  const checkBash = bash(`"${ENV_RUN}" --env-file "${envFile}" --check`);
  assert.equal(checkNode.code, 1, checkNode.out + checkNode.err);
  assert.equal(checkBash.code, checkNode.code);

  // --print / --raw --print: identische Ausgabe (der Wert, nicht KEY=wert)
  for (const args of [["--print", "PORT"], ["--raw", "--print", "PORT"], ["--print", "DATABASE_URL"], ["--raw", "--print", "LEERWERT"]]) {
    const fromNode = node(LOAD_ENV, [...args, "--env-file", envFile]);
    const fromBash = bash(`"${ENV_RUN}" ${args.map((a) => `"${a}"`).join(" ")} --env-file "${envFile}"`);
    assert.equal(fromNode.code, 0, fromNode.err);
    assert.equal(fromBash.code, 0, fromBash.err);
    assert.equal(fromNode.out, fromBash.out, `${args.join(" ")}:\nnode ${JSON.stringify(fromNode.out)}\nbash ${JSON.stringify(fromBash.out)}`);
  }

  const unknown = node(LOAD_ENV, ["--gibt-es-nicht"]);
  assert.equal(unknown.code, 2, unknown.out + unknown.err);
});

test("env-run.sh und load-env.mjs: identische Ausgabe in jedem Format (ein Vertrag, zwei Wege)", () => {
  // Die Schluessel-Mengen-Pruefung oben allein reicht nicht: sie uebersieht
  // Formatting-Drift (Quotes, `export`-Praezifix, fish-Escaping) — genau die
  // Stelle, an der eine der beiden Varianten still "aelter" waere.
  const dir = workDir("parity-format");
  const envFile = path.join(dir, ".env");
  writeFileSync(
    envFile,
    [
      "A=x",
      "export B=\"mit leerzeichen\"",
      "C=p'w#q",
      "D=",
      "E=a$b`c\\d",
      "F=\"#kein\ kommentar\"",
      "G=x y # anhaenger",
    ].join("\n"),
    { mode: 0o600 },
  );
  for (const args of [["--sh"], ["--keys"]]) {
    const fromNode = node(LOAD_ENV, [...args, "--env-file", envFile]);
    const fromBash = bash(`"${ENV_RUN}" ${args[0] === "--sh" ? "" : args[0]} --env-file "${envFile}"`);
    assert.equal(fromNode.code, 0, fromNode.err);
    assert.equal(fromBash.code, 0, fromBash.err);
    assert.equal(
      fromNode.out,
      fromBash.out,
      `Format ${args[0]} unterscheidet sich:\nnode: ${JSON.stringify(fromNode.out)}\nbash: ${JSON.stringify(fromBash.out)}`,
    );
  }
  // fish: env-run.sh ist die Referenzimplementierung, load-env delegiert an sie
  // (und faellt auf den eigenen Formatter zurueck, falls bash fehlt).
  const fishNode = node(LOAD_ENV, ["--fish", "--env-file", envFile]);
  const fishBash = bash(`"${ENV_RUN}" --fish --env-file "${envFile}"`);
  assert.equal(fishNode.out, fishBash.out, "fish-Format driftet");
  assert.match(fishNode.out, /^set -gx D ''$/m, "leerer Wert bleibt auch in fish erhalten");

  // --raw ist der Werkzeug-Pfad: unmaskiert, damit `$(...)` den Realwert liefert.
  const rawUrl = bash(`"${ENV_RUN}" --env-file "${envFile}" --raw --print C`).out.trim();
  assert.equal(rawUrl, "p'w#q", "--raw darf nichts maskieren");
  assert.ok(!rawUrl.startsWith("C="), "--print nennt nur den Wert, nicht KEY=wert");
  const masked = bash(`"${ENV_RUN}" --env-file "${envFile}" --print E`).out.trim();
  assert.ok(masked.includes("\\"), "ohne --raw wird vor `eval` maskiert");
});


// ── Setup-Skript: Struktur- und Verhaltensverträge (SET-09) ────────────────

test("setup-cachyos.sh: Interpreter-Guard vor `set -Eeuo pipefail` (POSIX-sicher)", () => {
  const src = readFileSync(SETUP, "utf8");
  const guard = src.indexOf('if [ -z "${BASH_VERSION:-}" ]');
  assert.ok(guard > 0, "Interpreter-Guard fehlt");
  // Die erste `set -Eeuo pipefail` im File steht in der Kopf-Doku — gesucht ist
  // die ECHTE Anweisung, also die erste ab dem Guard.
  const strict = src.indexOf("set -Eeuo pipefail", guard);
  assert.ok(strict > guard, "Guard muss VOR `set -Eeuo pipefail` stehen — POSIX-sh kennt pipefail nicht");

  if (hasShell("dash")) {
    const r = run("dash", [SETUP, "--variant", "a"]);
    assert.equal(r.code, 2, `${r.out}\n${r.err}`);
    assert.match(r.err, /braucht bash/);
    assert.ok(!/Illegal option/.test(r.err), `dash darf nicht ueber pipefail stolpern:\n${r.err}`);
    // Der Guard-Text darf selbst keine Befehle ausführen (Backticks/$( )).
    assert.ok(!/pwned/.test(r.err), "Guard-Text darf im fremden Interpreter nichts ausführen");
  }
});

test("setup-cachyos.sh: bash -n + Usage nennt --force-env, Parsing akzeptiert es", () => {
  const syn = bash(`bash -n "${SETUP}"`);
  assert.equal(syn.code, 0, syn.err);
  const help = bash(`"${SETUP}" --help`);
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /--force-env/);
  const unknown = bash(`"${SETUP}" --variant a --sicher-nicht-existiert`);
  assert.notEqual(unknown.code, 0);
});

test("setup-cachyos.sh: jede Schritt-Funktion endet mit einem harten return 0", () => {
  const src = readFileSync(SETUP, "utf8");
  const steps = [
    "step_01_preflight", "step_02_packages", "step_03_postgres", "step_04_database",
    "step_05_env", "step_06_dependencies", "step_07_schema", "step_08_universe",
    "step_09_build", "step_10_validate",
  ];
  for (const name of steps) {
    const m = new RegExp(`\\n${name}\\(\\) \\{`).exec(src);
    assert.ok(m, `${name} existiert nicht mehr — Test und Skript sind auseinandergedriftet`);
    const end = src.indexOf("\n}\n", (m.index ?? 0) + 1);
    const body = src.slice((m.index ?? 0) + 1, end).replace(/\n\s*$/, "");
    assert.ok(
      /(^|\n)\s*return 0$/.test(body),
      `${name} endet ohne 'return 0' — ein Test als letzte Zeile waere der Rueckgabewert (SET-09)`,
    );
  }
  // main() ruft alle Schritte durch die Kapselung, damit ein Nicht-Null-Status
  // als genau dieser Schritt sichtbar wird.
  const main = /main\(\) \{[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
  for (const name of steps) {
    assert.match(main, new RegExp(`run_step ${name}\\b`), `main ruft ${name} nicht uber run_step`);
  }
});

test("setup-cachyos.sh: env_ensure_key wird nie als letzter Befehl eines && -Blocks benutzt", () => {
  const src = readFileSync(SETUP, "utf8");
  const offenders = src
    .split("\n")
    .map((l, i) => ({ l, i: i + 1 }))
    .filter(({ l }) => /env_ensure_key .*&&.*added=\$\(added/.test(l));
  assert.deepEqual(offenders, [], "SET-09: Zaehler ueber env_add(), nicht ueber `&&` (Rueckgabe 1 = vorhanden)");
});

/** Schritt 05 in einem isolierten Projekt-Root laufen lassen (rc, .env, stdout). */
function runStep05(dir: string, extraFlags: string): { rc: number; out: string; envText: string } {
  const harness = path.join(dir, "harness.sh");
  const script = [
    "#!/usr/bin/env bash",
    `mkdir -p "${dir}/data/setup"`,
    `source "${SETUP}" --variant a --non-interactive --log-file "${path.join(dir, "setup.log")}" ${extraFlags} || true`,
    `PROJECT_ROOT="${dir}"`,
    `DATABASE_URL="postgresql://trader:pw\@127.0.0.1:5432/trading_firm"`,
    'DB_PASS="pw"; DB_USER="trader"; DB_NAME="trading_firm"; DB_HOST="127.0.0.1"; DB_PORT="5432"',
    'PGDATA="/var/lib/postgres/data"; PG_SUDO_USER="postgres"',
    `cd "${dir}"`,
    "step_05_env",
    'echo "STEP05_RC=$?"',
    "",
  ].join("\n");
  writeFileSync(harness, script, { mode: 0o700 });
  const r = bash(`"${harness}"`);
  const rc = Number(/STEP05_RC=(\d+)/.exec(r.out)?.[1] ?? "-1");
  const envText = existsSync(path.join(dir, ".env"))
    ? readFileSync(path.join(dir, ".env"), "utf8")
    : "";
  return { rc, out: r.out + r.err, envText };
}

const OPERATOR_ENV = [
  "DATABASE_URL=postgresql://trader:pw@127.0.0.1:5432/trading_firm",
  "FIRM_API_TOKEN=bestaendiges-token-1234",
  "FIRM_ADMIN_TOKEN=nur-dem-operator-bekannt",
  "PAPER_MODE=broker-paper-api",
  "PAPER_STATIC_FALLBACK=true",
  "TRUSTED_PROXY_IPS=127.0.0.1",
  "FREMDER_SCHLUESSEL=vom_template_nicht_gekannt",
].join("\n");

test("setup-cachyos.sh Schritt 05: Merge ist der Default — keine Schlüssel verschwinden, rc = 0", () => {
  const dir = workDir("merge");
  const envFile = path.join(dir, ".env");
  // bewusst OHNE abschließenden Umbruch: `printf >>` darf keine Zeilen
  // zusammenkleben (Regression: TRUSTED_PROXY_IPS=127.0.0.1FIRM_SESSION_SECRET=…)
  writeFileSync(envFile, OPERATOR_ENV, { mode: 0o600 });

  const { rc, out, envText } = runStep05(dir, "");
  assert.equal(rc, 0, `Schritt 05 darf nicht mit Status 1 enden (SET-09):\n${out}`);
  assert.match(out, /Bestehende \.env bleibt erhalten/);
  assert.doesNotMatch(envText, /=127\.0\.0\.1FIRM_/, "angehaengte Schluessel waeren ein stiller Konfigurationsverlust");
  assert.match(envText, /^TRUSTED_PROXY_IPS=127\.0\.0\.1$/m);

  // Bestehendes bleibt, wo es war — auch Werte, die das Template anders sehen.
  assert.match(envText, /^FIRM_API_TOKEN=bestaendiges-token-1234$/m);
  assert.match(envText, /^FIRM_ADMIN_TOKEN=nur-dem-operator-bekannt$/m);
  assert.match(envText, /^PAPER_MODE=broker-paper-api$/m, "vorhandener Wert wird nicht ueberschrieben");
  assert.match(envText, /^TRUSTED_PROXY_IPS=127\.0\.0\.1$/m);

  // Was fehlt, wird ergaenzt — und nur das.
  assert.match(envText, /^BITUNIX_ENABLED=true$/m);
  assert.match(envText, /^MARKET_SYNC_VENUES=BITUNIX$/m);
  assert.match(envText, /^FIRM_SESSION_SECRET=[0-9a-f]{64}$/m);
  assert.ok(!existsSync(path.join(dir, ".env.bak-")), "beim Merge wird nichts überschrieben, also kein Backup nötig");
});

test("setup-cachyos.sh Schritt 05: --force-env sichert, schreibt neu und holt bekannte Schlüssel zurück", () => {
  const dir = workDir("force");
  const envFile = path.join(dir, ".env");
  writeFileSync(envFile, OPERATOR_ENV, { mode: 0o600 });

  const { rc, out, envText } = runStep05(dir, "--force-env");
  assert.equal(rc, 0, out);
  assert.match(out, /Sicherungskopie der alten \.env angelegt/);
  assert.match(out, /zurückgeholt/);
  const backups = readFileSyncSafeDir(dir);
  assert.ok(backups.some((f) => f.startsWith(".env.bak-")), "Backup der alten .env fehlt");

  // Gerettet werden die Schluessel aus dem Rescue-Katalog. Der Template-Wert
  // gewinnt dabei: `--force-env` will ausdruecklich eine frische Konfiguration.
  // Was darueber hinausgeht (hier TRUSTED_PROXY_IPS), liegt im Backup und wird
  // in der Ausgabe benannt — still verlieren darf dieser Pfad nichts.
  assert.match(envText, /^FIRM_API_TOKEN=bestaendiges-token-1234$/m);
  assert.match(envText, /^FIRM_ADMIN_TOKEN=/m, "Admin-Token steht im Rescue-Katalog");
  assert.match(envText, /^PAPER_MODE=broker-market-data$/m);
  assert.match(envText, /^DATABASE_URL=postgresql:\/\/trader:pw@127\.0\.0\.1:5432\/trading_firm$/m);
  assert.match(envText, /^TRUSTED_PROXY_IPS=127\.0\.0\.1$/m, "katalogisierter Schluessel wird zurueckgeholt");
  assert.ok(!/^FREMDER_SCHLUESSEL=/m.test(envText), "nicht-katalogisiertes bleibt im Backup — und wird benannt");
  assert.match(out, /eigenen Eintr/, "es muss auf die Sicherungskopie verwiesen werden\n" + out);

  const backupName = readdirSync(dir).find((f) => f.startsWith(".env.bak-"));
  assert.ok(backupName, "Backup-Datei fehlt: " + readdirSync(dir).join(" "));
  const backup = readFileSync(path.join(dir, backupName), "utf8");
  assert.match(backup, /^PAPER_MODE=broker-paper-api$/m);
  assert.match(backup, /^TRUSTED_PROXY_IPS=127\.0\.0\.1$/m);
  assert.match(backup, /^FREMDER_SCHLUESSEL=vom_template_nicht_gekannt$/m);
});

function readFileSyncSafeDir(dir: string): string[] {
  // verzeichnis listing ohne `readdir`-Import-Reihenfolge-Zauberei
  const r = bash(`ls -A "${dir}"`);
  return r.code === 0 ? r.out.split("\n").filter(Boolean) : [];
}

test("setup-cachyos.sh Schritt 05: leere/fehlende .env wird aus dem Template angelegt (rc = 0)", () => {
  const dir = workDir("fresh");
  const { rc, out, envText } = runStep05(dir, "");
  assert.equal(rc, 0, out);
  assert.match(envText, /^DATABASE_URL=postgresql:\/\/trader:pw@127\.0\.0\.1:5432\/trading_firm$/m);
  assert.match(envText, /^PAPER_MODE=broker-market-data$/m);
  assert.match(envText, /^MODEL_CEO=qwen2\.5:3b-instruct-q4_K_M$/m);
  assert.match(envText, /^FIRM_API_TOKEN=[0-9a-f]{64}$/m, "frische Installation erhaelt ein Token");
});
