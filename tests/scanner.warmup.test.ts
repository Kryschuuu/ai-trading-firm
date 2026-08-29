/**
 * Tests des abgeleiteten Warmup-Bedarfs (OPS-009).
 *
 * Kernaussage: `requiredWarmupCandles` ist die **einzige** Quelle der
 * Warmup-Wahrheit und wird aus der Faktor-Konfiguration abgeleitet — nie
 * hartcodiert. Die Tests beweisen die Herleitung, die Reaktion auf
 * Konfigurationsänderungen und die Sicherheitskappe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SCANNER_CONFIG, resolveScannerConfig } from "../src/scanner/config";
import { MAX_WARMUP_CANDLES, requiredWarmupCandles } from "../src/scanner/warmup";

test("scanner requires enough history for configured factor set", () => {
  assert.ok(requiredWarmupCandles(DEFAULT_SCANNER_CONFIG) >= 61);
});

test("requiredWarmupCandles is exactly 61 for the default configuration", () => {
  // max(slow 50, momentum 60, drawdown 60, volatility 30+1, volumeRatio 20) + 1
  assert.equal(requiredWarmupCandles(DEFAULT_SCANNER_CONFIG), 61);
});

test("requiredWarmupCandles reacts to configuration changes", () => {
  const cfg = resolveScannerConfig({
    factors: { momentum: { lookbacks: [5, 20, 120], lookbackWeights: [0.2, 0.3, 0.5] } },
  });
  // 120er-Lookback braucht 121 Kerzen (n + 1). Beweist: nicht hartcodiert.
  assert.ok(requiredWarmupCandles(cfg) >= 121);
  assert.equal(requiredWarmupCandles(cfg), 121);
});

test("requiredWarmupCandles is the max over all factor requirements", () => {
  // Je ein dominierender Faktor; der jeweils erhöhte Lookback muss +1 gewinnen.
  const cases: Array<{ name: string; overrides: Parameters<typeof resolveScannerConfig>[0]; expected: number }> = [
    { name: "trend.slowPeriod", overrides: { factors: { trend: { slowPeriod: 200 } } }, expected: 201 },
    {
      name: "momentum.lookbacks",
      overrides: { factors: { momentum: { lookbacks: [5, 20, 150], lookbackWeights: [0.2, 0.3, 0.5] } } },
      expected: 151,
    },
    { name: "drawdown.lookback", overrides: { factors: { drawdown: { lookback: 180 } } }, expected: 181 },
    { name: "volatility.lookback", overrides: { factors: { volatility: { lookback: 200 } } }, expected: 202 },
    { name: "volumeRatio.basePeriods", overrides: { factors: { volumeRatio: { basePeriods: 190 } } }, expected: 191 },
  ];
  for (const { name, overrides, expected } of cases) {
    assert.equal(requiredWarmupCandles(resolveScannerConfig(overrides)), expected, `dominierender Faktor: ${name}`);
  }
});

test("volatility contributes lookback + 1 (returns need one candle more than prices)", () => {
  // volatility.lookback = 300 dominiert klar; Bedarf = (300 + 1) + 1 = 302.
  const cfg = resolveScannerConfig({ factors: { volatility: { lookback: 300 } } });
  assert.equal(requiredWarmupCandles(cfg), 302);
});

test("requiredWarmupCandles is capped at MAX_WARMUP_CANDLES (no mass fetching)", () => {
  const cfg = resolveScannerConfig({ factors: { drawdown: { lookback: 5000 } } });
  assert.equal(requiredWarmupCandles(cfg), MAX_WARMUP_CANDLES);
});

test("requiredWarmupCandles does not mutate the config it reads", () => {
  const cfg = resolveScannerConfig();
  const before = JSON.stringify(cfg);
  requiredWarmupCandles(cfg);
  assert.equal(JSON.stringify(cfg), before);
});
