/**
 * Workshop-Schritt 5 (`RuleBacktestPanel`): Die Auswahl „Fenster“ ist kein eigenes
 * Vokabular, sondern die Timeframe-Allowlist des Systems (STX-01, v0.6.2). Sie
 * kommt aus dem client-sicheren Modul `marketdata/timeframes` — dieselbe Liste,
 * aus der sich `RULE_ALLOWED_TIMEFRAMES` (Regel-Pfad) ableitet. Eine handgepflegte
 * Teilmenge würde 2h/4h/1d/5d im Workshop unausdrückbar machen, obwohl
 * `sanitizeRuleSpec` und der Backtest sie tragen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import RuleBacktestPanel from "../../src/components/workshop/RuleBacktestPanel";
import { SUPPORTED_TIMEFRAMES } from "../../src/lib/marketdata/timeframes";
import { RULE_ALLOWED_TIMEFRAMES } from "../../src/lib/ruleEngine";

function windowOptions(): string[] {
  const html = renderToStaticMarkup(createElement(RuleBacktestPanel, { onUnauthorized: () => undefined }));
  const selects = [...html.matchAll(/<select[^>]*>([\s\S]*?)<\/select>/g)];
  const windowSelect = selects.find((match) => match[1].includes('value="15m"'));
  assert.ok(windowSelect, "die Fenster-Auswahl muss gerendert werden");
  return [...windowSelect[1].matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]);
}

test("RuleBacktestPanel: die Fenster-Auswahl bietet genau die Regel-Timeframes an — in Allowlist-Reihenfolge", () => {
  const options = windowOptions();
  assert.deepEqual([...options], [...RULE_ALLOWED_TIMEFRAMES]);
  assert.deepEqual([...options], [...SUPPORTED_TIMEFRAMES]);
  for (const timeframe of ["3m", "2h", "4h", "1d", "5d"]) {
    assert.ok(options.includes(timeframe), `${timeframe} muss im Workshop wählbar sein`);
  }
});
