/**
 * Unit Tests für `src/lib/env.ts` — sicheres Lesen numerischer Env-Variablen.
 *
 * Warum diese Datei existiert: `envInt`/`envNumber` schützen `setInterval`
 * und Risikoparameter vor NaN (`Math.max(15000, Number("abc")) === NaN`).
 * `tests/hardening.test.ts` deckt nur envInt-Grundfälle ab; hier liegen die
 * vollständigen Edge Cases beider Funktionen, insbesondere das in der
 * Codebasis dokumentierte fail-laut-Verhalten von `envNumber` (Warnung bei
 * JEDER Korrektur), das sonst nirgends abgesichert ist.
 *
 * Rein deterministisch: beide Funktionen sind rein (Env wird injiziert);
 * `console.warn` wird pro Test gemockt, um die Warn-Pflichten zu prüfen.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { envInt, envNumber } from "../src/lib/env";

/** Protokolliert console.warn-Aufrufe des Tests (statt sie zu drucken). */
let warnings: string[] = [];

beforeEach((t) => {
  warnings = [];
  // Hook-Kontext ist Test- ODER Suite-Kontext; nur der Test-Kontext trägt mock.
  if ("mock" in t) {
    t.mock.method(console, "warn", (...args: unknown[]) => {
      warnings.push(args.join(" "));
    });
  }
});

describe("envInt: Fallback bei unbrauchbaren Werten", () => {
  test("Variable fehlt → Fallback", () => {
    assert.equal(envInt("MISSING", 42, 1, 100, {}), 42, "ohne Variable muss der Fallback gelten");
  });

  test("nicht-numerischer Müll → Fallback (nie NaN)", () => {
    const value = envInt("X", 42, 1, 100, { X: "abc" });
    assert.equal(value, 42);
    assert.ok(Number.isFinite(value), "das Ergebnis darf niemals NaN sein");
  });

  test("Infinity → Fallback (Number.isFinite fängt es ab)", () => {
    assert.equal(envInt("X", 42, 1, 100, { X: "Infinity" }), 42);
  });

  test("NaN-Literal → Fallback", () => {
    assert.equal(envInt("X", 42, 1, 100, { X: "NaN" }), 42);
  });

  test("Leerstring wird zu 0 geparst und an die Untergrenze geklemmt (dokumentierte envInt-Semantik)", () => {
    // Number("") === 0 — anders als envNumber behandelt envInt "" als Zahl.
    // Dieses Verhalten ist bewusst dokumentiert und wird hier eingefroren.
    assert.equal(envInt("X", 42, 10, 100, { X: "" }), 10, "'' → 0 → Clamp auf min");
  });
});

describe("envInt: Clamp und Ganzzahligkeit", () => {
  test("Wert unter min → min", () => {
    assert.equal(envInt("X", 50, 15, 600, { X: "1" }), 15);
  });

  test("Wert über max → max", () => {
    assert.equal(envInt("X", 50, 15, 600, { X: "999999" }), 600);
  });

  test("Grenzwerte selbst bleiben unverändert (inklusive Bounds)", () => {
    assert.equal(envInt("X", 50, 15, 600, { X: "15" }), 15);
    assert.equal(envInt("X", 50, 15, 600, { X: "600" }), 600);
  });

  test("Nachkommastellen werden abgeschnitten (Intervall-Semantik)", () => {
    assert.equal(envInt("X", 50, 1, 100, { X: "30.9" }), 30, "30.9 muss zu 30 werden (trunc, nicht round)");
  });

  test("negative Werte sind erlaubt, wenn die Bounds sie decken", () => {
    assert.equal(envInt("X", 0, -10, 10, { X: "-5" }), -5);
  });

  test("wissenschaftliche Notation wird verstanden", () => {
    assert.equal(envInt("X", 1, 1, 100_000, { X: "1e3" }), 1000);
  });
});

describe("envNumber: stiller Default ohne Warnung im Normalfall", () => {
  test("Variable fehlt → Fallback OHNE Warnung", () => {
    assert.equal(envNumber("X", 0.5, 0, 1, {}), 0.5);
    assert.equal(warnings.length, 0, "fehlende Variable ist der Normalfall und darf nicht warnen");
  });

  test("Leerstring → Fallback OHNE Warnung", () => {
    assert.equal(envNumber("X", 0.5, 0, 1, { X: "" }), 0.5);
    assert.equal(warnings.length, 0);
  });

  test("Whitespace-only → Fallback OHNE Warnung", () => {
    assert.equal(envNumber("X", 0.5, 0, 1, { X: "   " }), 0.5);
    assert.equal(warnings.length, 0);
  });

  test("gültiger Wert in Bounds → Wert OHNE Warnung", () => {
    assert.equal(envNumber("X", 0.5, 0, 1, { X: "0.25" }), 0.25);
    assert.equal(warnings.length, 0, "ein gültiger Wert darf keine Korrektur-Warnung auslösen");
  });

  test("Grenzwerte bleiben unverändert (inklusive Bounds, keine Warnung)", () => {
    assert.equal(envNumber("X", 0.5, 0.1, 0.9, { X: "0.1" }), 0.1);
    assert.equal(envNumber("X", 0.5, 0.1, 0.9, { X: "0.9" }), 0.9);
    assert.equal(warnings.length, 0);
  });
});

describe("envNumber: fail-laut bei Korrektur", () => {
  test("nicht-numerischer Wert → Fallback MIT Warnung", () => {
    const value = envNumber("MAKER_FEE", 0.001, 0, 0.01, { MAKER_FEE: "abc" });
    assert.equal(value, 0.001, "bei Müll muss der sichere Default gelten");
    assert.equal(warnings.length, 1, "jede Korrektur muss genau einmal gewarnt werden");
    assert.ok(warnings[0].includes("MAKER_FEE"), "die Warnung muss den Variablennamen nennen");
  });

  test("NaN/Infinity → Fallback MIT Warnung", () => {
    assert.equal(envNumber("X", 2, 0, 5, { X: "NaN" }), 2);
    assert.equal(envNumber("X", 2, 0, 5, { X: "Infinity" }), 2);
    assert.equal(warnings.length, 2, "beide Korrekturen müssen laut sein");
  });

  test("Wert unter min → Clamp auf min MIT Warnung", () => {
    const value = envNumber("X", 0.5, 0.1, 0.9, { X: "0.0001" });
    assert.equal(value, 0.1, "untere Bound muss erzwungen werden");
    assert.equal(warnings.length, 1);
  });

  test("Wert über max → Clamp auf max MIT Warnung", () => {
    const value = envNumber("X", 0.5, 0.1, 0.9, { X: "5" });
    assert.equal(value, 0.9, "obere Bound muss erzwungen werden");
    assert.equal(warnings.length, 1);
  });

  test("negative Fees bleiben in Bounds erlaubt (Kalibrierung unter Null ist legal)", () => {
    // Rebates: negative Maker-Gebühren sind real; Bounds entscheiden, nicht das Vorzeichen.
    assert.equal(envNumber("X", 0, -0.01, 0.01, { X: "-0.005" }), -0.005);
    assert.equal(warnings.length, 0);
  });
});

describe("envInt vs. envNumber: Konsistenz der Schutzgarantie", () => {
  test("beide Funktionen liefern für dieselbe Müll-Eingabe endliche Werte", () => {
    const env = { A: "abc", B: "", C: "NaN", D: "Infinity" };
    for (const name of ["A", "B", "C", "D"] as const) {
      assert.ok(Number.isFinite(envInt(name, 7, 1, 10, env)), `envInt(${name}) muss endlich sein`);
      assert.ok(Number.isFinite(envNumber(name, 7, 1, 10, env)), `envNumber(${name}) muss endlich sein`);
    }
  });
});
