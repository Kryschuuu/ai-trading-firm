import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/market-sync-mission-venues.sh");

test("mission venue warmup attempts every venue and forwards options", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mission-venue-script-"));
  try {
    const bin = path.join(dir, "bin");
    const log = path.join(dir, "calls.log");
    mkdirSync(bin);
    const npmMock = path.join(bin, "npm");
    writeFileSync(
      npmMock,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\n[[ "$*" == *"--venue=PAPER"* ]] && exit 7\nexit 0\n`,
      { mode: 0o700 },
    );
    chmodSync(npmMock, 0o700);

    const result = spawnSync("bash", [script, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(result.status, 1, "ein Venue-Fehler muss im Gesamtergebnis sichtbar sein");
    assert.deepEqual(
      calls,
      ["run market:sync -- --venue=IBKR --dry-run", "run market:sync -- --venue=PAPER --dry-run", "run market:sync -- --venue=BINANCE --dry-run", "run market:sync -- --venue=KRAKEN --dry-run"],
    );
    assert.match(result.stderr, /PAPER fehlgeschlagen/);
    assert.match(result.stdout, /KRAKEN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

