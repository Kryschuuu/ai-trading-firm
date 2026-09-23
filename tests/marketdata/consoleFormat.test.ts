/**
 * Tests: ASCII-sichere Konsolen-Transliteration (v1.39.1, Mojibake-Fix).
 *
 * Hintergrund: `npm run market:sync` druckt deutsche Logzeilen mit Umlauten
 * und typografischen Symbolen (`—`, `·`, `→`, `≥`). Auf Windows-Konsolen mit
 * Legacy-Codepage (CP850/CP1252) bzw. umgeleiteter Ausgabe erschien daraus
 * Mojibake („â€“, „Ã¼“). `toConsoleAscii()` ist die einzige Übersetzungsstelle
 * — diese Tests sichern die Garantie: KEINE Ausgabezeile enthält danach noch
 * ein Zeichen > 0x7e.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isAsciiSafe, toConsoleAscii } from "../../src/lib/consoleFormat";

test("toConsoleAscii: typografische Symbole bekommen feste ASCII-Äquivalente", () => {
  assert.equal(toConsoleAscii("a — b"), "a - b");
  assert.equal(toConsoleAscii("BITUNIX · Registry 3"), "BITUNIX | Registry 3");
  assert.equal(toConsoleAscii("EMA50 → 50"), "EMA50 -> 50");
  assert.equal(toConsoleAscii(">= 200 ≥ n"), ">= 200 >= n");
  assert.equal(toConsoleAscii("„Zitat“"), '"Zitat"');
  assert.equal(toConsoleAscii("Ende…"), "Ende...");
});

test("toConsoleAscii: Umlaute nach DIN 5008 (ae/oe/ue/ss), Großschreibung erhalten", () => {
  assert.equal(toConsoleAscii("übersprungen"), "uebersprungen");
  assert.equal(toConsoleAscii("ausführen"), "ausfuehren");
  assert.equal(toConsoleAscii("Kerzen höcher"), "Kerzen hoecher");
  assert.equal(toConsoleAscii("Größe"), "Groesse");
  assert.equal(toConsoleAscii("Änderung Ökonomie Übergang"), "Aenderung Oekonomie Uebergang");
});

test("toConsoleAscii: Rest-Nicht-ASCII (Emoji, NBSP, Steuerzeichen > 0x7f) entfällt", () => {
  assert.equal(toConsoleAscii("ok \u{1F600}!"), "ok !");
  assert.equal(toConsoleAscii("a\u00a0b"), "ab");
  assert.equal(toConsoleAscii("x\u2028y"), "xy");
});

test("toConsoleAscii: reine ASCII-Zeilen bleiben byteidentisch (idempotent)", () => {
  const line = "[market-sync] BITUNIX discovery: 42 instruments (1200/1200 bars)";
  assert.equal(toConsoleAscii(line), line);
  assert.equal(toConsoleAscii(toConsoleAscii("Fehler — übel")), toConsoleAscii("Fehler — übel"));
});

test("toConsoleAscii: Zeilenumbruch und Tab bleiben erhalten (Hilfetext)", () => {
  assert.equal(toConsoleAscii("a\nb\tc"), "a\nb\tc");
});

test("Garantie des Mojibake-Fixes: echte CLI-Logmuster werden ASCII-rein", () => {
  const samples = [
    "[market-sync] DEGRADED: 1 isolierte(r) Fehler — Ursachen im Manifest (data/market-data-errors.json), Behebung: erneut ausführen.",
    "[market-sync] status: BITUNIX · Registry 12 · Discovery (24h) 12",
    "[market-sync] übersprungen (Allowlist/Kappung): 3",
    "[market-sync] failures nach Ursache: discovery/UNKNOWN: 1",
  ];
  for (const sample of samples) {
    const out = toConsoleAscii(sample);
    assert.ok(isAsciiSafe(out), `nicht ASCII-rein: ${out}`);
    assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(out));
  }
});

test("isAsciiSafe: druckbares ASCII plus Umbruch ja, Umlaute nein", () => {
  assert.ok(isAsciiSafe("plain text\nsecond line"));
  assert.ok(!isAsciiSafe("Umlaut ü"));
  assert.ok(!isAsciiSafe("dash —"));
});
