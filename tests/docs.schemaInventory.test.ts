/**
 * DC-07 — Schema-Inventar-Vertragstest (Renderer-Ebene).
 *
 * Prüft die Eigenschaften des Schema-Inventars, die unabhängig vom Stand-Datum
 * gelten: vollständige Abdeckung aller `pgTable(`-Definitionen, deterministische
 * Ausgabe, LF-Zeilenenden, keine Zeitstempel. Der Abgleich mit der committed
 * Datei sowie die Drift-Prüfung laufen in `tests/docsInventories.test.ts` (DC-09).
 *
 * Schreibt nichts; keine DB, kein Netz.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { renderSchemaInventory } from "../scripts/gen-schema-inventory";

const SCHEMA_PATH = path.join(process.cwd(), "src", "db", "schema.ts");

describe("DC-07 · Schema-Inventar (Renderer)", () => {
  const pgTableCount = (readFileSync(SCHEMA_PATH, "utf8").match(/pgTable\(/g) ?? []).length;
  const first = renderSchemaInventory("");

  test("nennt jede pgTable()-Definition aus src/db/schema.ts", () => {
    assert.equal(first.count, pgTableCount, `Renderer: ${first.count} Tabellen, schema.ts: ${pgTableCount} pgTable()`);
    const rows = first.markdown.split("\n").filter((line) => /^\| `/.test(line)).length;
    assert.equal(rows, pgTableCount, `Inventar listet ${rows} Tabellenzeilen`);
  });

  test("deterministisch: zweiter Rendervorgang ist byte-identisch", () => {
    assert.equal(renderSchemaInventory("").markdown, first.markdown);
  });

  test("ohne Stand-Datum keine Stand-Zeile und keine Zeitstempel", () => {
    assert.equal(first.markdown.includes("**Stand:**"), false);
    assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}/.test(first.markdown), false, "ISO-Zeitstempel gefunden");
    assert.equal(/erzeugt am|generated at/i.test(first.markdown), false, "Zeitstempel-Phrase gefunden");
  });

  test("LF-Zeilenenden (kein CRLF)", () => {
    assert.equal(first.markdown.includes("\r"), false, "Ausgabe enthält CR");
  });

  test("trägt den GENERIERT-Hinweis mit dem Befehl des Gesamtgenerators", () => {
    assert.ok(first.markdown.includes("GENERIERT — nicht editieren"), "GENERIERT-Marker fehlt");
    assert.ok(first.markdown.includes("docs:inventories"), "npm-Script-Hinweis fehlt");
  });
});
