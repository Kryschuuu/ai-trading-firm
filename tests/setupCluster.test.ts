/**
 * Regressionstests für scripts/lib/pg-cluster.sh (v1.5.4).
 *
 * Vorfall Nr. 2 (Nutzer):
 *   - initdb lief mit "Erfolg" durch
 *   - trotzdem: „Cluster nach initdb weiterhin unvollständig“
 *
 * Ursache: initdb setzt $PGDATA auf 0700 postgres:postgres. Die alten
 * `test -f`-Checks liefen als aufrufender Benutzer → EACCES → falsch negativ.
 * (Deshalb auch die irreführende Meldung „existiert nicht oder ist leer“.)
 *
 * Diese Tests stellen das mit einem echten, einem fremden Benutzer (nobody)
 * gehörenden 0700-Verzeichnis nach. Benötigt sudo -u <anderer User>
 * (auf dem Zielsystem vorhanden; sonst skip).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

const LIB = resolve(process.cwd(), "scripts/lib/pg-cluster.sh");
const OWNER = "nobody";
const HAVE_SUDO =
  spawnSync("sudo", ["-n", "true"], { encoding: "utf8" }).status === 0;

/** Temp-Cluster anlegen, Besitz an $OWNER geben, Mode 0700 (wie initdb). */
function makeCluster(layout: {
  version?: string;
  relmap?: boolean;
  base?: boolean;
}): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pg-cluster-test-"));
  chmodSync(root, 0o755); // nobody muss in den Temp-Pfad kommen
  const dir = join(root, "data");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "global"), { recursive: true });
  if (layout.base ?? true) mkdirSync(join(dir, "base", "1"), { recursive: true });
  writeFileSync(join(dir, "PG_VERSION"), `${layout.version ?? "18"}\n`);
  writeFileSync(join(dir, "global", "pg_control"), "");
  if (layout.relmap ?? true) writeFileSync(join(dir, "global", "pg_filenode.map"), "");
  // Rechte wie nach einem echten initdb: erst 0700 setzen (solange wir Owner
  // sind), DANN Besitz an $OWNER übergeben (chown ändert den Mode nicht).
  chmodSync(dir, 0o700);
  spawnSync("sudo", ["chown", "-R", `${OWNER}:nogroup`, dir], { encoding: "utf8" });
  return {
    dir,
    cleanup: () => spawnSync("sudo", ["rm", "-rf", root], { encoding: "utf8" }),
  };
}

/** Bash mit geladenem Helper ausführen; Cluster-Pfad via $DATA_DIR. */
function runBash(code: string, env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync("bash", ["-c", `set -euo pipefail; source "$0"; ${code}`, LIB], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PG_SUDO_USER: OWNER,
      DATA_DIR: "",
      ...env,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
}

test(
  "Regression v1.5.4: vollständiger Cluster in 0700 (fremder Owner) wird erkannt",
  { skip: !HAVE_SUDO },
  () => {
    const c = makeCluster({ version: "18", relmap: true });
    try {
      // Beweis der ursprünglichen Fehlannahme: als aufrufender Benutzer ist
      // die Datei unsichtbar (EACCES) — der alte Check wäre falsch-negativ.
      const direct = spawnSync("test", ["-f", join(c.dir, "PG_VERSION")]);
      assert.notEqual(direct.status, 0, "test -f als Aufrufer muss scheitern (EACCES)");

      const r = runBash(`pg_cluster_ok "$DATA_DIR"`, { DATA_DIR: c.dir });
      assert.equal(
        r.status,
        0,
        `pg_cluster_ok muss den Cluster erkennen. stderr: ${r.stderr}`
      );
    } finally {
      c.cleanup();
    }
  }
);

test(
  "Unvollständiger Cluster (PG 18 ohne pg_filenode.map) wird abgelehnt",
  { skip: !HAVE_SUDO },
  () => {
    const c = makeCluster({ version: "18", relmap: false });
    try {
      const r = runBash(`pg_cluster_ok "$DATA_DIR"`, { DATA_DIR: c.dir });
      assert.equal(r.status, 1, "PG 18 ohne Relmap darf nicht als ok gelten");
    } finally {
      c.cleanup();
    }
  }
);

test(
  "Künftige Version (PG 19) ohne Relmap bleibt ok — versionstolerant",
  { skip: !HAVE_SUDO },
  () => {
    const c = makeCluster({ version: "19", relmap: false });
    try {
      const r = runBash(`pg_cluster_ok "$DATA_DIR"`, { DATA_DIR: c.dir });
      assert.equal(r.status, 0, "PG 19-Layout ohne Relmap ist gültig (Warnpfad)");
    } finally {
      c.cleanup();
    }
  }
);

test(
  "Versions-Mismatch Cluster ↔ Server wird erkannt (Datenschutz)",
  { skip: !HAVE_SUDO },
  () => {
    const c = makeCluster({ version: "17", relmap: true });
    try {
      const r = runBash(
        `if pg_version_mismatch 18 "$DATA_DIR"; then echo MISMATCH; else echo OK; fi`,
        { DATA_DIR: c.dir }
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /MISMATCH/, "Server 18 vs Cluster 17 muss als Mismatch gelten");
    } finally {
      c.cleanup();
    }
  }
);

test("pg_server_major parst postgres --version und pg_config --version", () => {
  const bin = mkdtempSync(join(tmpdir(), "pg-bin-test-"));
  writeFileSync(
    join(bin, "postgres"),
    "#!/usr/bin/env bash\nprintf '%s\\n' 'postgres (PostgreSQL) 18.6 (Arch)'\n"
  );
  writeFileSync(
    join(bin, "pg_config"),
    "#!/usr/bin/env bash\nprintf '%s\\n' 'PostgreSQL 18.6'\n"
  );
  spawnSync("chmod", ["+x", join(bin, "postgres"), join(bin, "pg_config")]);
  try {
    const r = spawnSync(
      "bash",
      ["-c", `set -euo pipefail; source "$0"; printf '%s' "$(pg_server_major)"`, LIB],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
        timeout: 60_000,
      }
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "18");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("pg_control_major/pg_control_state parsen pg_controldata-Ausgabe", () => {
  // Fakebin mit gemocktem sudo (echtes sudo nutzt secure_path und würde den
  // pg_controldata-Mock nicht finden) + gemocktem pg_controldata.
  const bin = mkdtempSync(join(tmpdir(), "pg-ctrl-test-"));
  writeFileSync(
    join(bin, "pg_controldata"),
    `#!/usr/bin/env bash
printf '%s\\n' 'pg_control version number:            1800'
printf '%s\\n' 'Database cluster state:               shut down'
`
  );
  writeFileSync(
    join(bin, "sudo"),
    `#!/usr/bin/env bash
if [[ "\$1" == "-u" ]]; then shift 2; fi
if [[ "\$1" == "--" ]]; then shift; fi
exec "\$@"
`
  );
  spawnSync("chmod", ["+x", join(bin, "pg_controldata"), join(bin, "sudo")]);
  const c = makeCluster({ version: "18", relmap: true });
  try {
    const r = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail; source "$0"; printf 'major=%s state=%s' "$(pg_control_major "$1")" "$(pg_control_state "$1")"`,
        LIB,
        c.dir,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PG_SUDO_USER: OWNER,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
        timeout: 60_000,
      }
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "major=18 state=shut down");
  } finally {
    c.cleanup();
    rmSync(bin, { recursive: true, force: true });
  }
});

test("Diagnose-Funktion läuft durch und nennt Datenverzeichnis + Versionen", () => {
  const c = makeCluster({ version: "18", relmap: false });
  try {
    const r = spawnSync(
      "bash",
      ["-c", `set -euo pipefail; source "$0"; pg_cluster_diagnostics "$1"`, LIB, c.dir],
      {
        cwd: process.cwd(),
        env: { ...process.env, PG_SUDO_USER: OWNER },
        encoding: "utf8",
        timeout: 60_000,
      }
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Datenverzeichnis/);
    assert.match(r.stdout, /PG_VERSION/);
  } finally {
    c.cleanup();
  }
});

test("set -e: Check bricht das aufrufende Skript nicht ab (return 1 in if)", () => {
  const r = runBash(
    `if pg_cluster_ok "/does/not/exist"; then echo ok; else echo detected; fi`
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /detected/);
});
