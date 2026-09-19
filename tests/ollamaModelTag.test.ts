/**
 * Unit Tests für `resolveModelTag` aus `src/lib/ollama.ts` — Auflösung des
 * konfigurierten LLM-Modells gegen die lokal verfügbaren Modelle.
 *
 * Warum wichtig: Ein falsch aufgelöstes Tag bedeutet „Modell nicht gefunden“
 * im LLM-Pfad — der gesamte Agenten-Zyklus fällt dann auf den deterministi-
 * schen Fallback zurück. Die Familien-Heuristik (`llama3` → `llama3:8b`)
 * darf dabei NIEMALS in eine falsche Familie matchen (z. B. `llama32`),
 * sonst läuft das System still mit dem falschen Modell.
 *
 * Rein deterministisch: reine Funktion über zwei Arrays.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveModelTag } from "../src/lib/ollama";

const MODELS = ["llama3:8b", "llama3:70b", "mistral:7b", "qwen2.5-coder:14b", "llama3"];

describe("resolveModelTag: exakte Treffer", () => {
  test("exakt verfügbares Tag wird 1:1 übernommen", () => {
    assert.equal(resolveModelTag(MODELS, "mistral:7b"), "mistral:7b");
  });

  test("exakter Treffer gewinnt vor der Familien-Heuristik", () => {
    // „llama3“ steht selbst in der Liste — es muss EXAKT zurückkommen,
    // nicht das erste Familienmitglied llama3:8b.
    assert.equal(resolveModelTag(MODELS, "llama3"), "llama3");
  });
});

describe("resolveModelTag: Familien-Heuristik", () => {
  test("angefragte Familie ohne Tag → erstes verfügbares Familienmitglied", () => {
    const models = ["llama3:8b", "llama3:70b"];
    assert.equal(resolveModelTag(models, "llama3"), "llama3:8b");
  });

  test("angefragtes Tag nicht da, Familie schon → Ersatz aus derselben Familie", () => {
    assert.equal(
      resolveModelTag(MODELS, "llama3:13b"),
      "llama3:8b",
      "fehlendes 13b-Tag muss auf ein verfügbares llama3-Tag fallen"
    );
  });

  test("Modellnamen mit Punkten/Bindestrichen bleiben Familie-treu", () => {
    assert.equal(resolveModelTag(MODELS, "qwen2.5-coder:32b"), "qwen2.5-coder:14b");
  });
});

describe("resolveModelTag: falsche Familie und Nicht-Treffer (fail-closed)", () => {
  test("ähnlicher Familienname darf NICHT matchen (llama3 ≠ llama32)", () => {
    const models = ["llama32:3b"];
    assert.equal(
      resolveModelTag(models, "llama3"),
      null,
      "Präfix-Verwechslung würde still das falsche Modell aktivieren"
    );
  });

  test("umgekehrt: llama32-Anfrage matcht kein llama3-Modell", () => {
    assert.equal(resolveModelTag(["llama3:8b"], "llama32:3b"), null);
  });

  test("komplett fremde Familie → null (Fallback-Pfad der Engine)", () => {
    assert.equal(resolveModelTag(MODELS, "phi4:14b"), null);
  });

  test("leere Modellliste → null (Ollama ohne Modelle)", () => {
    assert.equal(resolveModelTag([], "llama3:8b"), null);
  });

  test("Groß-/Kleinschreibung ist relevant (Tags sind case-sensitive)", () => {
    assert.equal(
      resolveModelTag(MODELS, "Llama3:8b"),
      null,
      "Ollama-Tags sind case-sensitive — die Auflösung darf nicht falten"
    );
  });
});
