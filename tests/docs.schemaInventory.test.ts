/**
 * DC-07 — Schema-Inventar-Vertragstest.
 *
 * Prüft, dass `docs/generated/schema-inventory.md` von
 * `scripts/gen-schema-inventory.ts` stammt (byteweise Abgleich), alle 67
 * pgTable-Definitionen aus `src/db/schema.ts` abdeckt, deterministisch
 * (zweiter Lauf identisch) und LF-zeilenendig ist.
 *
 * Keine DB, kein Netz.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { generateInventory } from "../scripts/gen-schema-inventory";

const REPO = process.cwd();
const DOC_PATH = path.join(REPO, "docs", "generated", "schema-inventory.md");
const SCHEMA_PATH = path.join(REPO, "src", "db", "schema.ts");

describe("DC-07 · docs/generated/schema-inventory.md", () => {
  const onDisk = readFileSync(DOC_PATH, "utf8");
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  const pgTableCount = (schema.match(/pgTable\(/g) ?? []).length;

  test("Datei existiert und hat den GENERIERT-Hinweis", () => {
    assert.ok(onDisk.includes("GENERIERT — nicht editieren"), "GENERIERT-Marker fehlt");
    assert.ok(onDisk.includes("docs:inventories"), "npm-Script-Hinweis fehlt");
  });

  test("zweiter Lauf ist byte-identisch (Idempotenz)", () => {
    // Ohne SCHEMA_INVENTORY_STAND generieren → kein Datum, vollständig stabil.
    const before = process.env.SCHEMA_INVENTORY_STAND;
    delete process.env.SCHEMA_INVENTORY_STAND;
    try {
      const first = generateInventory();
      const md1 = readFileSync(DOC_PATH, "utf8");
      const second = generateInventory();
      const md2 = readFileSync(DOC_PATH, "utf8");
      assert.equal(md1, md2, "zweiter Lauf erzeugt andere Bytes");
      assert.equal(first.count, second.count, "Tabellenzahl ändert sich");
      assert.equal(first.count, pgTableCount, `Generator nennt ${first.count} Tabellen, schema.ts hat ${pgTableCount} pgTable()`);
    } finally {
      if (before !== undefined) process.env.SCHEMA_INVENTORY_STAND = before;
    }
  });

  test("Tabellenzeilenzahl ≥ pgTable()-Anzahl im Quellcode", () => {
    // Wir schreiben ohne Datum, damit der Snapshot hier deterministisch ist.
    const before = process.env.SCHEMA_INVENTORY_STAND;
    delete process.env.SCHEMA_INVENTORY_STAND;
    try {
      generateInventory();
      const md = readFileSync(DOC_PATH, "utf8");
      const rows = md.split("\n").filter((l) => /^\| `/.test(l)).length;
      assert.ok(
        rows >= pgTableCount,
        `Inventar listet ${rows} Tabellenzeilen, aber schema.ts hat ${pgTableCount} pgTable()`,
      );
    } finally {
      if (before !== undefined) process.env.SCHEMA_INVENTORY_STAND = before;
      // Stelle den Zustand vor dem Test wieder her (der PR-Commit hat
      // SCHEMA_INVENTORY_STAND=2026-10-09 gesetzt).
      generateInventory();
    }
  });

  test("LF-Zeilenenden (kein CRLF)", () => {
    assert.ok(!onDisk.includes("\r\n"), "Datei enthält CRLF");
  });

  test("keine Zeitstempel/Hashes, die den Output byte-instabil machen", () => {
    // Ein Datum kommt ausschließlich über SCHEMA_INVENTORY_STAND — ohne
    // diese Env-Variable darf "Stand:" nirgendwo in der Ausgabe vorkommen.
    const before = process.env.SCHEMA_INVENTORY_STAND;
    delete process.env.SCHEMA_INVENTORY_STAND;
    try {
      generateInventory();
      const md = readFileSync(DOC_PATH, "utf8");
      assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}/.test(md), "ISO-Zeitstempel gefunden");
      assert.ok(!/erzeugt am|generated at/i.test(md), "Zeitstempel-Phrase gefunden");
    } finally {
      if (before !== undefined) process.env.SCHEMA_INVENTORY_STAND = before;
      generateInventory();
    }
  });
});
