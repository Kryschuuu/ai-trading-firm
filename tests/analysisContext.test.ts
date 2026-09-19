/**
 * Unit Tests für `src/portfolio/context.ts` — der fertige Analyse-Kontext
 * für die LLM-Interpretationsebene.
 *
 * Kerngarantien dieses Moduls (Task 05): Das LLM bekommt ausschließlich
 * VORBERECHNETE Zahlen und ein explizites Regelwerk, was es darf und was
 * nicht — Gewichte stehen nie im Kontext. Diese Tests sichern:
 *
 *   - Struktur + Vollständigkeit des Kontexts (Metriken, beide
 *     Korrelationsverfahren, Cluster, Limits, Autoritätskette)
 *   - bekannte Korrelations-Signale (perfekt korreliert / anti-korreliert)
 *   - alle PortfolioError-Pfade (INVALID_INPUT, LENGTH_MISMATCH × 2)
 *   - die LLM-Leitplanken (llmMay/llmMustNot) als stabilen Vertrag
 *   - summarize-/Prompt-Helfer (Kappung, Rundung, keine Mutation)
 *
 * Rein deterministisch: alle Funktionen sind reine Arithmetik.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  clustersForPrompt,
  correlationForPrompt,
  getAnalysisContext,
  summarizeAnalysisContext,
} from "../src/portfolio/context";
import { PortfolioError } from "../src/portfolio/errors";
import { DEFAULT_CLUSTER_THRESHOLD } from "../src/portfolio/config";

/** Deterministische Pseudozufalls-Reihe (fest, keine Zufallsquelle). */
function series(seed: number, length = 60): number[] {
  const out: number[] = [];
  let x = seed;
  for (let i = 0; i < length; i++) {
    // Einfacher LCG — reproduzierbar, hinreichend „rauschig“ für Korrelation.
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push((x / 2147483648 - 0.5) * 0.04);
  }
  return out;
}

describe("getAnalysisContext: Struktur und Vollständigkeit", () => {
  const symbols = ["AAA", "BBB", "CCC"];
  const returns = [series(1), series(2), series(3)];

  test("liefert alle dokumentierten Abschnitte", () => {
    const ctx = getAnalysisContext(returns, symbols);
    assert.deepEqual(ctx.symbols, symbols, "Symbole müssen in Eingabereihenfolge übernommen werden");
    assert.equal(ctx.observations, 60, "Beobachtungszahl muss der Serienlänge entsprechen");
    assert.equal(ctx.metrics.length, 3, "je Symbol muss ein MetricSet existieren");
    assert.equal(ctx.correlation.method, "pearson", "Primärkorrelation ist Pearson");
    assert.equal(ctx.rankCorrelation.method, "spearman", "Rangkorrelation ist Spearman");
    assert.ok(ctx.clusters.threshold > 0, "Cluster-Schwelle muss gesetzt sein");
    assert.ok(ctx.limits.maxWeightPerInstrument > 0, "Informations-Limits müssen gefüllt sein");
    assert.ok(ctx.authority.chain.length >= 2, "die Autoritätskette muss die Stufen nennen");
    assert.ok(ctx.interpretation.llmMay.length > 0, "llmMay-Leitplanken dürfen nicht leer sein");
    assert.ok(ctx.interpretation.llmMustNot.length > 0, "llmMustNot-Leitplanken dürfen nicht leer sein");
  });

  test("enthält KEINE Gewichte (Autoritätskette bleibt gewahrt)", () => {
    const ctx = getAnalysisContext(returns, symbols);
    // „weightsComputedBy“/„maxWeightPerInstrument“ sind Namen/Info-Limits —
    // ein echtes `weights`-Feld (Array/Objekt) darf es niemals geben.
    assert.ok(!/"weights"\s*:/.test(JSON.stringify(ctx)),
      "der Kontext darf kein weights-Feld enthalten — Gewichte erzeugt nur optimize+riskGuard");
    assert.ok(!("weights" in ctx), "auch als Top-Level-Property dürfen Gewichte nicht existieren");
    assert.ok(ctx.authority.notice.includes("keine Gewichte"),
      "der Notice muss explizit festhalten, dass der Kontext keine Gewichte enthält");
  });

  test("Symbole werden kopiert übergeben (keine Alias-Mutation)", () => {
    const input = ["AAA", "BBB"];
    const ctx = getAnalysisContext([series(1), series(2)], input);
    input[0] = "MUTIERT";
    assert.equal(ctx.symbols[0], "AAA", "der Kontext darf nicht durch Mutation der Eingabe kippen");
  });

  test("Metriken tragen das zugehörige Symbol und endliche Werte", () => {
    const ctx = getAnalysisContext(returns, symbols);
    ctx.metrics.forEach((m, i) => {
      assert.equal(m.symbol, symbols[i], `Metrik ${i} muss Symbol ${symbols[i]} tragen`);
      assert.ok(Number.isFinite(m.volatility), "Volatilität muss endlich sein");
    });
  });
});

describe("getAnalysisContext: bekannte Korrelations-Signale", () => {
  test("perfekt korrelierte Serien landen in EINEM Cluster", () => {
    const base = series(7);
    const doubled = base.map((v) => v * 2); // ρ = 1 (lineare Transformation)
    const ctx = getAnalysisContext([base, doubled], ["BASE", "DBL"], { clusterThreshold: 0.8 });
    assert.ok(
      Math.abs(ctx.correlation.matrix[0][1] - 1) < 1e-9,
      "lineare Transformation muss Pearson-ρ ≈ 1 liefern"
    );
    const big = ctx.clusters.clusters.filter((c) => c.symbols.length === 2);
    assert.equal(big.length, 1, "beide Serien müssen in genau einem gemeinsamen Cluster landen");
  });

  test("anti-korrelierte Serien: ρ ≈ −1", () => {
    const base = series(11);
    const inv = base.map((v) => -v);
    const ctx = getAnalysisContext([base, inv], ["BASE", "INV"]);
    assert.ok(Math.abs(ctx.correlation.matrix[0][1] + 1) < 1e-9, "Negation muss ρ ≈ −1 liefern");
  });

  test("Options-Overrides (Schwelle, Limits) werden übernommen", () => {
    const ctx = getAnalysisContext([series(1), series(2)], ["A", "B"], {
      clusterThreshold: 0.95,
      maxWeightPerInstrument: 0.3,
      maxClusterExposure: 0.7,
    });
    assert.equal(ctx.clusters.threshold, 0.95);
    assert.equal(ctx.limits.maxWeightPerInstrument, 0.3);
    assert.equal(ctx.limits.maxClusterExposure, 0.7);
  });

  test("Default-Schwelle ist die dokumentierte Konstante", () => {
    const ctx = getAnalysisContext([series(1), series(2)], ["A", "B"]);
    assert.equal(ctx.clusters.threshold, DEFAULT_CLUSTER_THRESHOLD);
  });
});

describe("getAnalysisContext: Fehlerpfade (fail-loud, nie raten)", () => {
  test("leere Serienliste → INVALID_INPUT", () => {
    assert.throws(
      () => getAnalysisContext([], []),
      (err: unknown) => err instanceof PortfolioError && err.code === "INVALID_INPUT",
      "ohne Serien muss INVALID_INPUT geworfen werden"
    );
  });

  test("Symbolanzahl ≠ Serienanzahl → LENGTH_MISMATCH (field symbols)", () => {
    assert.throws(
      () => getAnalysisContext([series(1), series(2)], ["NUR_EINS"]),
      (err: unknown) =>
        err instanceof PortfolioError && err.code === "LENGTH_MISMATCH" && err.field === "symbols",
      "die Diskrepanz muss als LENGTH_MISMATCH auf field=symbols gemeldet werden"
    );
  });

  test("Serien unterschiedlicher Länge → LENGTH_MISMATCH mit Index-Diagnose", () => {
    assert.throws(
      () => getAnalysisContext([series(1, 60), series(2, 30)], ["A", "B"]),
      (err: unknown) =>
        err instanceof PortfolioError &&
        err.code === "LENGTH_MISMATCH" &&
        err.details?.index === 1,
      "der Index der defekten Serie muss in details stehen (Diagnose ohne Daten-Dump)"
    );
  });
});

describe("summarizeAnalysisContext: Textprojektion", () => {
  test("enthält Kennzeilen, Limits-Hinweis und die Gewichte-Belehrung", () => {
    const ctx = getAnalysisContext([series(1), series(2)], ["AAA", "BBB"]);
    const text = summarizeAnalysisContext(ctx);
    assert.ok(text.includes("AAA"), "jede Symbol-Kennzeile muss auftauchen");
    assert.ok(text.includes("BBB"));
    assert.ok(/Limits:/.test(text), "die Limits müssen zusammengefasst werden");
    assert.ok(text.includes("Gewichte berechnet ausschließlich die mathematische Schicht"),
      "die Autoritäts-Belehrung muss im Prompt-Landestrang stehen");
  });

  test("mehr Symbole als maxSymbols → Kappung mit Zähler", () => {
    const many = Array.from({ length: 5 }, (_, i) => series(i + 1));
    const names = many.map((_, i) => `S${i}`);
    const text = summarizeAnalysisContext(getAnalysisContext(many, names), 3);
    assert.ok(text.includes("2 weitere Symbole"), "die Anzahl gekappter Symbole muss sichtbar sein");
    assert.ok(!text.includes("- S3:") && !text.includes("- S4:"),
      "gekappe Symbole dürfen keine Kennzeile bekommen");
  });
});

describe("correlationForPrompt / clustersForPrompt", () => {
  test("correlationForPrompt rundet auf 4 Stellen und mutiert die Quelle nicht", () => {
    const ctx = getAnalysisContext([series(1), series(2)], ["A", "B"]);
    const before = JSON.stringify(ctx.correlation.matrix);
    const rounded = correlationForPrompt(ctx.correlation);
    assert.equal(JSON.stringify(ctx.correlation.matrix), before, "die Quellmatrix darf nicht mutiert werden");
    for (const row of rounded) {
      for (const cell of row) {
        assert.equal(cell, Number(cell.toFixed(4)), "jede Zelle muss auf 4 Stellen gerundet sein");
      }
    }
  });

  test("Diagonale bleibt exakt 1 (auch nach Rundung)", () => {
    const ctx = getAnalysisContext([series(3), series(4), series(5)], ["A", "B", "C"]);
    const rounded = correlationForPrompt(ctx.correlation);
    for (let i = 0; i < rounded.length; i++) {
      assert.equal(rounded[i][i], 1, `Diagonalelement (${i},${i}) muss 1 sein`);
    }
  });

  test("clustersForPrompt gruppiert perfekt korrelierte Paare", () => {
    const base = series(9);
    const groups = clustersForPrompt([base, base.map((v) => v * 3), series(20)], ["X", "Y", "Z"], 0.99);
    const pair = groups.find((g) => g.includes("X") && g.includes("Y"));
    assert.ok(pair, "X und Y (ρ=1) müssen bei Schwelle 0.99 gemeinsam geclustert werden");
    assert.ok(!pair.includes("Z"), "unabhängiges Z darf nicht im Paar-Cluster landen");
  });
});
