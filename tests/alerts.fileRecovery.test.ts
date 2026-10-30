import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileAlertSink } from "../src/lib/alerts";

test("FileAlertSink erholt sich nach mkdir-Fehlern und schreibt auch bei Überlänge gültiges NDJSON", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "alert-recovery-"));
  const blockingFile = path.join(dir, "blocked");
  const target = path.join(blockingFile, "alerts.ndjson");
  try {
    await writeFile(blockingFile, "kein Verzeichnis");
    const sink = new FileAlertSink(target, 100);
    await assert.rejects(sink.send({ code: "failed", severity: "info", message: "test" }));
    await rm(blockingFile);
    await sink.send({ code: "recovered", severity: "warning", message: "x".repeat(1_000),
      meta: { huge: "ä".repeat(1_000) } });
    const line = (await readFile(target, "utf8")).trim();
    assert.ok(Buffer.byteLength(line, "utf8") <= 100);
    assert.deepEqual(JSON.parse(line), { code: "recovered", severity: "warning", truncated: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
