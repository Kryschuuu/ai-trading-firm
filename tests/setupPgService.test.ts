/**
 * Regressionstests für scripts/lib/pg-service.sh (v1.5.3).
 *
 * Der Produktionsvorfall: `systemctl show -p ExecStart --value` liefert die
 * Arch-Unit-Zeile UNEXPANDIERT — `-D ${PGROOT}/data`. Der Setup-Sicherheitsgurt
 * verglich das wörtlich mit `/var/lib/postgres/data` und brach fälschlich ab:
 *
 *   ! postgresql.service nutzt ein anderes Datenverzeichnis: '${PGROOT}/data'
 *
 * Diese Tests bauen eine MOCK-systemctl-Binary in ein Temp-Verzeichnis und
 * rufen die echten Helferfunktionen via `bash` auf — kein Systemd, keine
 * Root-Rechte nötig.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const LIB = resolve(process.cwd(), "scripts/lib/pg-service.sh");

type ShowBehavior = {
  exec?: string;
  env?: string;
  showFails?: boolean;
  cat?: string;
};

/** Werte in eckigen Single-Quotes exportieren (schützt ${VAR} vor Expansion). */
function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Baut ein Temp-Verzeichnis mit einer gemockten systemctl-Binary. */
function makeMockSystemctl(show: ShowBehavior): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pg-svc-test-"));
  const mockSh = `#!/usr/bin/env bash
set -uo pipefail
  if [[ "\$1" == "show" ]]; then
  if [[ "\$SHOW_FAILS" == "1" ]]; then exit 1; fi
  if [[ "\$3" == "Environment" ]]; then
    printf '%s\n' "\$SHOW_ENV"
    exit 0
  fi
  if [[ "\$3" == "ExecStart" ]]; then
    printf '%s\n' "\$SHOW_EXEC"
    exit 0
  fi
  exit 1
fi
if [[ "\$1" == "cat" ]]; then
  printf '%s\n' "\$CAT_OUTPUT"
  exit 0
fi
exit 1
`;
  const bin = join(dir, "systemctl");
  writeFileSync(bin, mockSh, "utf8");
  chmodSync(bin, 0o755);

  const envFile = join(dir, "mock.env");
  writeFileSync(
    envFile,
    [
      `export SHOW_EXEC=${shellQuote(show.exec ?? "")}`,
      `export SHOW_ENV=${shellQuote(show.env ?? "")}`,
      `export SHOW_FAILS=${show.showFails ? "1" : "0"}`,
      `export CAT_OUTPUT=${shellQuote(show.cat ?? "")}`,
      "",
    ].join("\n"),
    "utf8"
  );
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Führt `pg_svc_datadir <svc>` in einer frischen bash mit Mock-PATH aus. */
function resolveDatadir(show: ShowBehavior): string {
  const mock = makeMockSystemctl(show);
  try {
    const r = spawnSync(
      "bash",
      [
        "-c",
        // set -e wie im Setup-Skript: kein && -Kurzschluss darf den
        // Aufrufer abbrechen, wenn der Pfad nicht auflösbar ist.
        'set -euo pipefail; source "$0" && . "$1" && pg_svc_datadir postgresql.service',
        LIB,
        join(mock.dir, "mock.env"),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${mock.dir}:${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    assert.equal(r.status, 0, `Helper-Aufruf fehlgeschlagen. stderr: ${r.stderr}`);
    return r.stdout.trim();
  } finally {
    mock.cleanup();
  }
}

/** Arch-Unit exakt wie im Originalfehler des Nutzers (${PGROOT} literal). */
const ARCH_UNIT = [
  "# /usr/lib/systemd/system/postgresql.service",
  "[Service]",
  'Environment=PGROOT=/var/lib/postgres',
  "ExecStart=/usr/bin/postgres -D ${PGROOT}/data",
].join("\n");

test("Regression v1.5.3: ${PGROOT} in ExecStart wird expandiert (Arch-Unit)", () => {
  const result = resolveDatadir({
    exec: "/usr/bin/postgres -D ${PGROOT}/data",
    env: "PGROOT=/var/lib/postgres",
  });
  assert.equal(
    result,
    "/var/lib/postgres/data",
    "Der expandierte Pfad muss dem erwarteten Arch-Standard entsprechen"
  );
});

test("auch ungeklammerte Variablen ($VAR) werden expandiert", () => {
  const result = resolveDatadir({
    exec: "/usr/bin/postgres -D $PGROOT/data",
    env: "PGROOT=/var/lib/postgres",
  });
  assert.equal(result, "/var/lib/postgres/data");
});

test("systemd-Strukturformat { path=… ; argv[]=… } wird verstanden", () => {
  const result = resolveDatadir({
    exec:
      "{ path=/usr/bin/postgres ; argv[]=/usr/bin/postgres -D ${PGROOT}/data ; ignore_errors=no ; start_time=[n/a] }",
    env: "PGROOT=/var/lib/postgres",
  });
  assert.equal(result, "/var/lib/postgres/data");
});

test("gequotete argv-Tokens (-D \"/pfad\") werden verstanden", () => {
  const result = resolveDatadir({
    exec: '{ path=/usr/bin/postgres ; argv[]=/usr/bin/postgres -D "/srv/pg/alt" ; ignore_errors=no }',
    env: "",
  });
  assert.equal(result, "/srv/pg/alt");
});

test("Drop-in mit anderem PGDATA wird erkannt (kein stilles Weitermachen)", () => {
  const result = resolveDatadir({
    exec: "/usr/bin/postgres -D /var/lib/postgresql/16/main",
    env: "",
  });
  assert.equal(result, "/var/lib/postgresql/16/main");
});

test("Fallback systemctl cat: Environment + letzte ExecStart-Definition gewinnen", () => {
  const result = resolveDatadir({
    showFails: true,
    cat: [
      "# /usr/lib/systemd/system/postgresql.service",
      "[Service]",
      'Environment="PGROOT=/var/lib/postgres"',
      "ExecStart=/usr/bin/postgres -D ${PGROOT}/data",
      "# /etc/systemd/system/postgresql.service.d/override.conf",
      "[Service]",
      "ExecStart=/usr/bin/postgres -D /srv/pg/data",
    ].join("\n"),
  });
  assert.equal(result, "/srv/pg/data");
});

test("Fallback systemctl cat ohne Drop-in löst ${PGROOT} auf", () => {
  const result = resolveDatadir({
    showFails: true,
    cat: ARCH_UNIT,
  });
  assert.equal(result, "/var/lib/postgres/data");
});

test("set -e: nicht auflösbare ExecStart bricht das aufrufende Skript nicht ab", () => {
  const mock = makeMockSystemctl({ exec: "", env: "", showFails: false });
  try {
    const r = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$0" && . "$1" && pg_svc_datadir postgresql.service; echo "exit=ok"',
        LIB,
        join(mock.dir, "mock.env"),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${mock.dir}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    assert.equal(r.status, 0, `set -e darf nicht abbrechen: ${r.stderr}`);
    assert.ok(r.stdout.includes("exit=ok"), "Aufrufer muss weiterlaufen");
  } finally {
    mock.cleanup();
  }
});

test("systemctl-String-Liste: mehrere KEY=VAL auf einer Zeile werden geparst", () => {
  const result = resolveDatadir({
    exec: "/usr/bin/postgres -D ${PGROOT}/data",
    env: "PGROOT=/var/lib/postgres FOO=bar",
  });
  assert.equal(result, "/var/lib/postgres/data");
});

test("pg_norm_path normalisiert // und trailing slash", () => {
  const mock = makeMockSystemctl({});
  try {
    const r = spawnSync(
      "bash",
      [
        "-c",
        'source "$0" && . "$1" && printf "%s" "$(pg_norm_path "/var/lib//postgres/data/")"',
        LIB,
        join(mock.dir, "mock.env"),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${mock.dir}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "/var/lib/postgres/data");
  } finally {
    mock.cleanup();
  }
});

test("pg_svc_extract_exec_d: hängende argv-Reste (; } ) werden abgestreift", () => {
  const mock = makeMockSystemctl({});
  try {
    const r = spawnSync(
      "bash",
      [
        "-c",
        'source "$0" && . "$1" && printf "%s" "$(pg_svc_extract_exec_d "/usr/bin/postgres -D /var/lib/postgres/data; ignore_errors=no;")"',
        LIB,
        join(mock.dir, "mock.env"),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${mock.dir}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
        timeout: 30_000,
      }
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "/var/lib/postgres/data");
  } finally {
    mock.cleanup();
  }
});
