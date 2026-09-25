/**
 * Render-Smoke-Test des RuntimeTogglesPanel (v0.5.0).
 *
 * Die Komponente holt ihre Daten per `fetch` (Client-Effekt) — im SSR-Render
 * läuft der Effekt nicht. Der Test beweist daher genau das, was ohne Browser
 * beweisbar ist:
 *   1. Beide Gruppen rendern ohne Fehler (Provider-Schalter, Broker-Remote).
 *   2. Die Überschriften und die Sicherheits-Erklärung stehen im Markup
 *      („Aus = keine Anfragen …").
 *   3. Der Render erzeugt keinen Netzwerkzugriff.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import RuntimeTogglesPanel from "../../src/components/ops/RuntimeTogglesPanel";

test("Providers-Panel rendert ohne Netzwerk und erklärt die Semantik", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const html = renderToStaticMarkup(
      createElement(RuntimeTogglesPanel, { group: "providers" as const })
    );
    assert.match(html, /LLM-Provider-Schalter/);
    assert.match(html, /sofort wirksam/);
    assert.match(html, /keine Anfragen, keine Kosten, kein Datenabfluss/);
    assert.equal(fetchCalls, 0, "SSR-Render darf keinen Request auslösen");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Broker-Panel rendert ohne Netzwerk und nennt den Default AUS", () => {
  const html = renderToStaticMarkup(
    createElement(RuntimeTogglesPanel, { group: "broker" as const })
  );
  assert.match(html, /Broker-Remote-Checks/);
  assert.match(html, /keine Credentials, keine Orders/);
  assert.match(html, /Aus \(Default\)/);
});
