/**
 * Unit Tests für `src/lib/appPaths.ts` — pfadsichere Auflösung von
 * Laufzeit-Datenverzeichnissen (Path-Traversal-Verteidigung).
 *
 * Die aufgelösten Pfade stammen teilweise aus Env-Variablen und HTTP-
 * konfigurierten Werten. Diese Tests sichern die Sicherheitsgarantien:
 *
 *   - relativer `..`-Ausbruch aus dem Projektstamm → PathTraversalError
 *   - absolute Pfade bleiben erlaubt (Operator-Entscheidung)
 *   - Fehlermeldungen leaken keine Host-Pfade (Redaktion + Längen-Cap)
 *   - `resolveStoredPath` erlaubt `..` (legitime externe Volumes)
 *   - `joinRuntimePath` prüft JEDES Segment einzeln
 *   - `resolveRuntimePathSafe` fällt niemals auf den Ausbruchspfad zurück
 *
 * Rein deterministisch: alle Funktionen sind rein (nur `process.cwd()`).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  PathTraversalError,
  joinRuntimePath,
  resolveRuntimePath,
  resolveRuntimePathSafe,
  resolveStoredPath,
} from "../src/lib/appPaths";

const CWD = path.normalize(process.cwd());

describe("resolveRuntimePath: gültige Eingaben", () => {
  test("relativer Pfad wird unter dem Projektstamm verankert", () => {
    assert.equal(
      resolveRuntimePath("data/universe"),
      path.join(CWD, "data", "universe"),
      "relative Pfade müssen unter process.cwd() aufgelöst werden"
    );
  });

  test("absoluter Pfad wird normalisiert übernommen (Operator-Entscheidung)", () => {
    assert.equal(
      resolveRuntimePath("/srv/ai/universe"),
      path.normalize("/srv/ai/universe"),
      "absolute Pfade sind explizite Operator-Entscheidung und bleiben erlaubt"
    );
  });

  test("absoluter Pfad mit `..` innerhalb des Ziels wird normalisiert", () => {
    assert.equal(
      resolveRuntimePath("/srv/ai/../ai/universe"),
      path.normalize("/srv/ai/universe"),
      "Normalisierung darf den Operator-Pfad nicht verfälschen"
    );
  });

  test("leerer String → Projektstamm (Default-Verhalten)", () => {
    assert.equal(resolveRuntimePath(""), CWD, "leere Eingabe muss auf den Projektstamm fallen");
  });

  test("nur Whitespace → Projektstamm (getrimmt vor Prüfung)", () => {
    assert.equal(resolveRuntimePath("   "), CWD, "Whitespace-only muss wie leer behandelt werden");
  });

  test("nur Punkte (`.`) → Projektstamm", () => {
    assert.equal(resolveRuntimePath("."), CWD);
    assert.equal(resolveRuntimePath("./."), CWD);
  });

  test("inneres `a/../b` bleibt im Stamm (Ausbruch zählt, nicht bloßes Vorkommen von ..)", () => {
    assert.equal(
      resolveRuntimePath("data/universe/../spreads"),
      path.join(CWD, "data", "spreads"),
      "ein .., das durch ein Segment gedeckt ist, darf kein Ausbruch sein"
    );
  });

  test("Backslash-Separatoren werden wie Slash behandelt", () => {
    assert.equal(
      resolveRuntimePath("data\\universe"),
      path.join(CWD, "data", "universe"),
      "Windows-artige Eingaben müssen dieselbe Auflösung liefern"
    );
  });
});

describe("resolveRuntimePath: Path-Traversal (fail-closed)", () => {
  test("einfacher Ausbruch `../etc/passwd` → PathTraversalError", () => {
    assert.throws(
      () => resolveRuntimePath("../etc/passwd"),
      PathTraversalError,
      "ein .. ohne deckendes Segment muss den Ausbruch-Schutz auslösen"
    );
  });

  test("getarnter Ausbruch `data/../..` → PathTraversalError", () => {
    assert.throws(
      () => resolveRuntimePath("data/../.."),
      PathTraversalError,
      "..-Segmente müssen ZÄHLEND aufgelöst werden (data/.. hebt sich auf, das zweite .. bricht aus)"
    );
  });

  test("Backslash-Ausbruch `..\\..\\windows` → PathTraversalError", () => {
    assert.throws(
      () => resolveRuntimePath("..\\..\\windows"),
      PathTraversalError,
      "der Ausbruch-Check darf nicht durch Backslash-Separatoren umgangen werden"
    );
  });

  test("tiefer Ausbruch `a/b/../../..` → PathTraversalError", () => {
    assert.throws(() => resolveRuntimePath("a/b/../../.."), PathTraversalError);
  });

  test("Fehler trägt den Code PATH_TRAVERSAL (maschinenlesbar)", () => {
    try {
      resolveRuntimePath("../ausbruch");
      assert.fail("erwarteter PathTraversalError blieb aus");
    } catch (err) {
      assert.ok(err instanceof PathTraversalError, "es muss ein PathTraversalError sein");
      assert.equal((err as PathTraversalError).code, "PATH_TRAVERSAL");
    }
  });

  test("Fehlermeldung ist redigiert: kein absoluter Host-Pfad, max. 200 Zeichen", () => {
    const longInput = `../${"x".repeat(500)}`;
    try {
      resolveRuntimePath(longInput);
      assert.fail("erwarteter PathTraversalError blieb aus");
    } catch (err) {
      const message = (err as Error).message;
      assert.ok(!message.includes(CWD), "die Fehlermeldung darf den Projektstamm nicht leaken");
      assert.ok(message.length <= 250, "die Fehlermeldung muss gekappt sein (kein Memory-/Log-DoS)");
    }
  });

  test("nicht druckbare Zeichen werden aus der Fehlermeldung entfernt", () => {
    try {
      resolveRuntimePath("../\u0000\u0001evil");
      assert.fail("erwarteter PathTraversalError blieb aus");
    } catch (err) {
      assert.ok(!/\u0000|\u0001/.test((err as Error).message), "Steuerzeichen dürfen nicht in Logs landen");
    }
  });
});

describe("resolveStoredPath: persisterte Manifest-Einträge", () => {
  test("`..` ist hier legal (externe Volumes erzeugen ../../../-Einträge)", () => {
    assert.equal(
      resolveStoredPath("../../../srv/artifacts/index.json"),
      path.normalize(path.join(CWD, "../../../srv/artifacts/index.json")),
      "gespeicherte relative Pfade dürfen den Stamm verlassen (nur Programm-geschrieben)"
    );
  });

  test("absoluter gespeicherter Pfad bleibt erhalten", () => {
    assert.equal(resolveStoredPath("/var/lib/firm/index.json"), path.normalize("/var/lib/firm/index.json"));
  });

  test("leerer Eintrag → Projektstamm", () => {
    assert.equal(resolveStoredPath(""), CWD);
  });
});

describe("joinRuntimePath: Segment-Prüfung", () => {
  test("verknüpft Basis und Segmente unter dem Projektstamm", () => {
    assert.equal(
      joinRuntimePath("data", "universe", "instruments.ndjson"),
      path.join(CWD, "data", "universe", "instruments.ndjson")
    );
  });

  test("absolute Basis wird respektiert", () => {
    assert.equal(
      joinRuntimePath("/tmp/firm", "report.json"),
      path.join("/tmp/firm", "report.json")
    );
  });

  test("leere Segmente werden übersprungen", () => {
    assert.equal(joinRuntimePath("data", "", "  ", "x"), path.join(CWD, "data", "x"));
  });

  test("kein Segment → nur die aufgelöste Basis", () => {
    assert.equal(joinRuntimePath("data"), path.join(CWD, "data"));
  });

  test("absolutes Segment → PathTraversalError (kein Überschreiben der Basis)", () => {
    assert.throws(
      () => joinRuntimePath("data", "/etc/passwd"),
      PathTraversalError,
      "ein absolutes Segment würde die Basis ignorieren und muss abgelehnt werden"
    );
  });

  test("Segment mit `..`-Ausbruch aus der Basis → PathTraversalError", () => {
    assert.throws(
      () => joinRuntimePath("data", "..", "..", "etc"),
      PathTraversalError,
      "Segmente werden einzeln geprüft — .. darf nicht durch die Hintertür ausbrechen"
    );
  });

  test("verschachtelter Ausbruch in EINEM Segment (`a/../../x`) → PathTraversalError", () => {
    assert.throws(() => joinRuntimePath("data", "a/../../x"), PathTraversalError);
  });

  test("inneres `..` mit Deckung bleibt erlaubt", () => {
    assert.equal(
      joinRuntimePath("data", "a/../b"),
      path.join(CWD, "data", "b"),
      "a/.. hebt sich auf — das ist kein Ausbruch"
    );
  });
});

describe("resolveRuntimePathSafe: fehlertolerante Variante", () => {
  test("gültige Eingabe wird normal aufgelöst", () => {
    assert.equal(
      resolveRuntimePathSafe("data/cache", "data/fallback"),
      path.join(CWD, "data", "cache")
    );
  });

  test("Ausbruch fällt auf den Fallback zurück — niemals auf den Ausbruchspfad", () => {
    const result = resolveRuntimePathSafe("../../etc/passwd", "data/fallback");
    assert.equal(result, path.join(CWD, "data", "fallback"), "der Fallback muss gewonnen werden");
    assert.ok(!result.includes("etc"), "der Ausbruchspfad darf nie im Ergebnis auftauchen");
  });

  test("Fallback wird selbst aufgelöst (relativ → Projektstamm)", () => {
    assert.equal(resolveRuntimePathSafe("../böse", "artifacts"), path.join(CWD, "artifacts"));
  });
});
