/**
 * Unit Tests für `src/lib/tokenCompare.ts` — timing-sicherer Token-Vergleich.
 *
 * Warum diese Datei existiert: `tokenEquals` schützt ALLE Schreib-Endpunkte
 * (x-firm-token) und die RBAC-Auflösung. `tests/hardening.test.ts` enthält
 * nur einen Smoke-Test; hier werden die Edge Cases abgesichert, die bei
 * einem Sicherheitsbaustein regressionsfrei bleiben müssen:
 *
 *   - ungleiche Längen dürfen NIEMALS werfen (timingSafeEqual wirft sonst)
 *   - leere Eingaben dürfen niemals autorisieren (fail-closed)
 *   - UTF-8-Multi-Byte-Token vergleichen über Bytes, nicht Zeichen
 *   - der Re-Export in `src/lib/apiAuth.ts` bleibt identisch (kein Duplikat)
 *
 * Rein deterministisch: `tokenEquals` ist eine reine Funktion ohne I/O.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tokenEquals } from "../src/lib/tokenCompare";

describe("tokenEquals: Grundverhalten", () => {
  test("identische Tokens → true", () => {
    assert.equal(
      tokenEquals("geheim-token-123", "geheim-token-123"),
      true,
      "identische Tokens müssen als gleich erkannt werden"
    );
  });

  test("unterschiedlicher Inhalt bei gleicher Länge → false", () => {
    assert.equal(
      tokenEquals("aaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaab"),
      false,
      "Ein-Bit-Abweichung darf nicht als gleich gelten"
    );
  });

  test("Präfix-Beziehung → false (kein Short-Circuit-Treffer)", () => {
    assert.equal(
      tokenEquals("abc", "abcdef"),
      false,
      "ein Präfix des erwarteten Tokens darf nicht autorisieren"
    );
    assert.equal(
      tokenEquals("abcdef", "abc"),
      false,
      "auch umgekehrt darf ein verlängertes Token nicht autorisieren"
    );
  });

  test("Groß-/Kleinschreibung ist relevant → false", () => {
    assert.equal(
      tokenEquals("Token", "token"),
      false,
      "Token-Vergleich muss byte-exakt sein (keine Case-Faltung)"
    );
  });

  test("Whitespace-Unterschiede → false (kein Trimmen)", () => {
    assert.equal(
      tokenEquals("token ", "token"),
      false,
      "angehängter Leerraum darf nicht still entfernt werden"
    );
    assert.equal(
      tokenEquals("\ttoken", "token"),
      false,
      "führender Leerraum darf nicht still entfernt werden"
    );
  });
});

describe("tokenEquals: ungleiche Längen (timingSafeEqual-Gefahr)", () => {
  test("längeres Gegenstück wirft nicht und liefert false", () => {
    // crypto.timingSafeEqual wirft bei ungleicher Länge — die Funktion muss
    // das durch Padding abfangen, sonst wird der Auth-Pfad zum 500er.
    assert.doesNotThrow(() => tokenEquals("kurz", "sehr-viel-laengerer-token"));
    assert.equal(tokenEquals("kurz", "sehr-viel-laengerer-token"), false);
  });

  test("kürzeres Gegenstück wirft nicht und liefert false", () => {
    assert.doesNotThrow(() => tokenEquals("sehr-viel-laengerer-token", "kurz"));
    assert.equal(tokenEquals("sehr-viel-laengerer-token", "kurz"), false);
  });

  test("Length-Mismatch über große Distanz (1 vs. 10k Zeichen) → false, kein Throw", () => {
    const long = "x".repeat(10_000);
    assert.doesNotThrow(() => tokenEquals("x", long));
    assert.equal(tokenEquals("x", long), false);
  });
});

describe("tokenEquals: leere und fehlende Werte (fail-closed)", () => {
  test("beide Seiten leer → false (leerer Token darf nie autorisieren)", () => {
    assert.equal(
      tokenEquals("", ""),
      false,
      "zwei leere Strings sind NICHT gleich — sonst autorisiert ein leerer Header"
    );
  });

  test("erhaltener Token leer, erwarteter gesetzt → false", () => {
    assert.equal(tokenEquals("", "erwarteter-token"), false);
  });

  test("erhaltener Token gesetzt, erwarteter leer → false", () => {
    assert.equal(tokenEquals("irgendein-token", ""), false);
  });
});

describe("tokenEquals: UTF-8 und lange Tokens", () => {
  test("Multi-Byte-Token (Bytes ≠ Zeichen) vergleichen korrekt", () => {
    // „ß“ und Emojis sind Multi-Byte in UTF-8 — der Vergleich läuft über
    // Buffer-Längen; identische Strings müssen trotzdem true liefern.
    const token = "töken-🔒-sichér-ß";
    assert.equal(tokenEquals(token, token), true);
  });

  test("Multi-Byte-Token mit unterschiedlicher Byte-Repräsentation → false", () => {
    // é als ein Codepoint (U+00E9) vs. e + kombinierender Akzent (U+0065 U+0301):
    // sieht gleich aus, ist byte-unterschiedlich → muss false sein.
    assert.equal(tokenEquals("caf\u00e9", "cafe\u0301"), false);
  });

  test("sehr lange identische Tokens (10k Zeichen) → true", () => {
    const long = "A1b2!".repeat(2_500);
    assert.equal(tokenEquals(long, long), true);
  });
});

describe("tokenEquals: Alias-Konsistenz", () => {
  test("apiAuth re-exportiert EXAKT dieselbe Funktion (kein Duplikat)", async () => {
    // Bestehende Importpfade nutzen "@/lib/apiAuth" — der Re-Export muss
    // dieselbe Implementierung sein, sonst driftet das Sicherheitsverhalten.
    const { tokenEquals: alias } = await import("../src/lib/apiAuth");
    assert.equal(alias, tokenEquals, "apiAuth.tokenEquals muss identisch mit tokenCompare.tokenEquals sein");
  });
});
