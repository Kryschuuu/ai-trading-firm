import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyRuntimeLimits,
  getLimits,
  missionSizedNotional,
  requireFinitePositive,
  resetRuntimeLimits,
  RiskValidationError,
  riskValidationReason,
  RISK_LIMITS,
  validateOrder,
} from "../src/lib/riskGuard";
import { PaperBroker } from "../src/lib/broker";

test("Ceilings: über dem Code-Maximum wird geklemmt", () => {
  const before = getLimits().maxPositionPct;
  applyRuntimeLimits({ maxPositionPct: 0.9 });
  assert.equal(getLimits().maxPositionPct, 0.5, "0.9 muss auf 0.5 geklemmt werden");
  applyRuntimeLimits({ maxPositionPct: before });
});

test("Ceilings: unter dem Code-Minimum wird angehoben", () => {
  applyRuntimeLimits({ maxRiskPerTrade: 0.0001 });
  assert.equal(getLimits().maxRiskPerTrade, 0.002);
  applyRuntimeLimits({ maxRiskPerTrade: 0.02 });
});

test("requireStopLoss ist nicht abschaltbar", () => {
  applyRuntimeLimits({ requireStopLoss: false } as any);
  assert.equal(getLimits().requireStopLoss, true);
});

test("RISK_LIMITS-Proxy liest die aktuellen Laufzeitwerte", () => {
  const before = getLimits().maxConcurrentPositions;
  applyRuntimeLimits({ maxConcurrentPositions: 2 });
  assert.equal(RISK_LIMITS.maxConcurrentPositions, 2);
  applyRuntimeLimits({ maxConcurrentPositions: before });
});

test("validateOrder blockt Positionsgröße über Limit", () => {
  resetRuntimeLimits();
  const r = validateOrder({
    notional: 5000, equity: 10000, openPositions: 0,
    side: "LONG", leverage: 1, hasStopLoss: true, symbol: "BTC",
  });
  assert.equal(r.allowed, false);
  assert.ok(r.blockedBy.some((b) => b.startsWith("position-size")));
});

test("validateOrder lässt saubere Order durch und blockt fehlenden Stop", () => {
  resetRuntimeLimits();
  const ok = validateOrder({
    notional: 2000, equity: 10000, openPositions: 0,
    side: "LONG", leverage: 1, hasStopLoss: true, symbol: "BTC",
  });
  assert.equal(ok.allowed, true);

  const noStop = validateOrder({
    notional: 2000, equity: 10000, openPositions: 0,
    side: "LONG", leverage: 1, hasStopLoss: false, symbol: "BTC",
  });
  assert.equal(noStop.allowed, false);
  assert.ok(noStop.blockedBy.includes("stop-loss:mandatory"));
});

test("allowShort=false blockt Shorts; freigeschaltet laufen sie durch", () => {
  resetRuntimeLimits();
  const short = validateOrder({
    notional: 1000, equity: 10000, openPositions: 0,
    side: "SHORT", leverage: 1, hasStopLoss: true, symbol: "ETH",
  });
  assert.equal(short.allowed, false);

  applyRuntimeLimits({ allowShort: true });
  const shortOk = validateOrder({
    notional: 1000, equity: 10000, openPositions: 0,
    side: "SHORT", leverage: 1, hasStopLoss: true, symbol: "ETH",
  });
  assert.equal(shortOk.allowed, true);
  applyRuntimeLimits({ allowShort: false });
});

// ── Mission-spezifische Positionsgröße (v1.5.3) ─────────────────────────────

test("Regression v1.5.3: missionsspezifisches maxPositionPct wird durchgesetzt", () => {
  resetRuntimeLimits();
  // 10.000 €, 5 % Stop, 2 % Risiko → Risikoformel will 4.000 € Notional,
  // globales Code-Maximum (25 %) kappt auf 2.500 €. Die PENNY-Mission mit
  // maxPositionPct=0.05 muss trotzdem auf 500 € begrenzt bleiben.
  const equity = 10_000;
  const withoutMissionCap = missionSizedNotional(equity, 0.05, 0.02, undefined, 0.5);
  assert.equal(withoutMissionCap, 2_500, "ohne Missions-Cap zählt Risikoformel + globales Maximum");

  const penny = missionSizedNotional(equity, 0.05, 0.02, 0.05, 0.5);
  assert.equal(penny, equity * 0.05, "Missions-Cap 5 % muss die Obergrenze sein (500 €)");

  const wideMission = missionSizedNotional(equity, 0.05, 0.02, 0.9, 0.5);
  assert.equal(wideMission, 2_500, "Mission über Code-Ceiling wird auf das Code-Maximum geklemmt");

  const broken = missionSizedNotional(equity, 0.05, 0.02, Number.NaN, 0.5);
  assert.equal(broken, 2_500, "NaN-Cap fällt auf das globale Maximum zurück");
});

test("Regression v1.5.3: Riskformel kann die Mission überschreiten, Mission gewinnt", () => {
  resetRuntimeLimits();
  // 5 % Risiko + 5 % Stop → 10.000 € Notional; aber Missions-Cap 0.2 und
  // globales Maximum 0.25 → effektiv 2.000 € (Mission gewinnt, Code bleibt Sandbox).
  const n = missionSizedNotional(10_000, 0.05, 0.05, 0.2, 0.5);
  assert.equal(n, 2_000);
});

// ── H9 (HIGH): Fail-closed Numerik-Validierung — unbekannt => BLOCK ──────────

/** Gültiger Basiskontext; einzelne Felder werden in den Tests verbogen. */
function validCtx(overrides: Record<string, unknown> = {}) {
  return {
    notional: 1000,
    equity: 10000,
    openPositions: 0,
    side: "LONG" as const,
    leverage: 1,
    hasStopLoss: true,
    symbol: "BTC",
    ...overrides,
  };
}

test("H9: requireFinitePositive akzeptiert nur endliche positive Zahlen", () => {
  assert.equal(requireFinitePositive(1, "x"), 1);
  assert.equal(requireFinitePositive(0.0001, "x"), 0.0001);
  assert.equal(requireFinitePositive("42", "x"), 42, "numerischer String wird umgewandelt");

  for (const bad of [NaN, Infinity, -Infinity, 0, -1, -0.001, undefined, null, "", "abc", {}]) {
    assert.throws(
      () => requireFinitePositive(bad, "equity"),
      (e: unknown) => e instanceof RiskValidationError && (e as RiskValidationError).field === "equity",
      `Wert ${String(bad)} muss RiskValidationError('equity') werfen`
    );
  }
});

test("H9: RiskValidationError trägt Code RISK_VALIDATION und den Feldnamen", () => {
  try {
    requireFinitePositive(NaN, "equity");
    assert.fail("muss werfen");
  } catch (e) {
    assert.ok(e instanceof RiskValidationError);
    assert.equal((e as RiskValidationError).code, "RISK_VALIDATION");
    assert.equal((e as RiskValidationError).field, "equity");
    assert.equal((e as Error).name, "RiskValidationError");
  }
});

test("H9: riskValidationReason mappt Feldnamen auf stabile REJECTED-Codes", () => {
  assert.equal(riskValidationReason(new RiskValidationError("equity")), "INVALID_EQUITY");
  assert.equal(riskValidationReason(new RiskValidationError("leverage")), "INVALID_LEVERAGE");
  assert.equal(riskValidationReason(new RiskValidationError("notional")), "INVALID_NOTIONAL");
  assert.equal(riskValidationReason(new RiskValidationError("openPositions")), "RISK_VALIDATION:openPositions");
  assert.equal(riskValidationReason(new Error("boom")), "boom");
  assert.equal(riskValidationReason("kaputt"), "RISK_VALIDATION");
});

test("H9: validateOrder wirft bei equity=NaN (kein stiller Clamp auf 1)", () => {
  resetRuntimeLimits();
  assert.throws(
    () => validateOrder(validCtx({ equity: NaN }) as never),
    /RISK_VALIDATION/
  );
});

test("H9: validateOrder wirft bei leverage=NaN (NaN > max === false-Bypass geschlossen)", () => {
  resetRuntimeLimits();
  // Früher: NaN > maxLeverage ist false → die Leverage-Schranke wurde still
  // übergangen. Jetzt: fail-closed Wurf.
  assert.throws(
    () => validateOrder(validCtx({ leverage: NaN }) as never),
    (e: unknown) => e instanceof RiskValidationError && (e as RiskValidationError).field === "leverage"
  );
});

test("H9: validateOrder wirft bei notional=NaN / notional<=0 / Infinity", () => {
  resetRuntimeLimits();
  for (const bad of [NaN, Infinity, 0, -100]) {
    assert.throws(
      () => validateOrder(validCtx({ notional: bad }) as never),
      (e: unknown) => e instanceof RiskValidationError && (e as RiskValidationError).field === "notional",
      `notional=${String(bad)} muss werfen`
    );
  }
});

test("H9: insolvente/negative equity wird hart blockiert, nicht auf 1 geklemmt", () => {
  resetRuntimeLimits();
  // Früher: Math.max(-5, 1) = 1 → positionPct = 1000/1 = 100000 %; die Order
  // wurde dann ggf. über andere Schranken geblockt, ein leicht negatives
  // Equity konnte aber still toleriert werden. Jetzt: Wurf.
  for (const bad of [-5, -0.01, 0]) {
    assert.throws(
      () => validateOrder(validCtx({ equity: bad }) as never),
      (e: unknown) => e instanceof RiskValidationError && (e as RiskValidationError).field === "equity",
      `equity=${bad} muss RiskValidationError werfen`
    );
  }
});

test("H9: equity=Infinity und leverage=Infinity werfen (kein Bypass)", () => {
  resetRuntimeLimits();
  assert.throws(() => validateOrder(validCtx({ equity: Infinity }) as never), /equity/);
  // Infinity-Leverage ist > maxLeverage und würde ohnehin blocken — aber der
  // Eingangs-Check muss konsistent werfen (fail-closed vor jedem Vergleich).
  assert.throws(
    () => validateOrder(validCtx({ leverage: Infinity }) as never),
    (e: unknown) => e instanceof RiskValidationError
  );
});

test("H9: nur endliche positive Werte passieren die Eingangsprüfung", () => {
  resetRuntimeLimits();
  // Kleines Notional (5 % der Equity), alles sauber → allowed.
  const ok = validateOrder(validCtx({ notional: 500 }));
  assert.equal(ok.allowed, true, ok.reason);

  // Negatives Leverage ist ungültig (falscher Wertebereich) → Wurf.
  assert.throws(
    () => validateOrder(validCtx({ leverage: -1 }) as never),
    (e: unknown) => e instanceof RiskValidationError && (e as RiskValidationError).field === "leverage"
  );
});

test("H9: PaperBroker.submit übersetzt RiskValidationError in einen REJECTED-Fill (INVALID_EQUITY)", () => {
  resetRuntimeLimits();
  const b = new PaperBroker(10000);
  // Normaler Auftrag füllt sauber.
  const good = b.submit({
    symbol: "BTC", side: "LONG", qty: 0.01, riskNotional: 670,
    stopLoss: 60000, takeProfit: 75000,
  });
  assert.equal(good.status, "FILLED", good.reason);

  // Ein insolventer Broker (Equity 0/negativ) darf keine Order mehr füllen:
  // validateOrder wirft RiskValidationError('equity') → REJECTED/INVALID_EQUITY.
  const broke = new PaperBroker(0);
  const fill = broke.submit({
    symbol: "ETH", side: "LONG", qty: 0.01, riskNotional: 100,
    stopLoss: 2000, takeProfit: 4000,
  });
  assert.equal(fill.status, "REJECTED");
  assert.equal(fill.reason, "INVALID_EQUITY");
});
