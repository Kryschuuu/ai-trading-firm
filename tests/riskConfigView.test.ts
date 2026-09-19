/**
 * Unit Tests für `src/lib/riskConfigService.ts` — die Lese-/View-Schicht der
 * Runtime-Risikokonfiguration (Dashboard + API /api/firm/risk).
 *
 * Getestet wird der DB-FREIE Teil des Moduls:
 *   - `CONFIG_KEYS` als stabiler Metadaten-Vertrag (Vollständigkeit,
 *     Eindeutigkeit, Verankerung in LIMIT_CEILINGS/DEFAULT_LIMITS)
 *   - `effectiveConfigView()`: beide Namensräume (limits + volatility),
 *     Werte innerhalb der Code-Ceilings, Locked-Flag nur bei requireStopLoss
 *   - Zusammenspiel mit `applyRuntimeLimits`: effektive Werte erscheinen im
 *     View, Ausreißer werden an den Ceilings geklemmt (Code entscheidet)
 *
 * Die DB-pflichtigen Funktionen (refreshRuntimeLimits, setConfigValue) sind
 * bewusst ausgelagert — sie gehören in DB-gegatede Integrationstests.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_KEYS, effectiveConfigView } from "../src/lib/riskConfigService";
import {
  DEFAULT_LIMITS,
  LIMIT_CEILINGS,
  applyRuntimeLimits,
  getLimits,
  resetRuntimeLimits,
  type RiskLimits,
} from "../src/lib/riskGuard";
import {
  DEFAULT_VOLATILITY_CONFIG,
  VOLATILITY_CONFIG_BOUNDS,
  VOLATILITY_KEYS,
} from "../src/lib/adaptiveRisk";

// Isolation: Limits sind prozess-weite Singletons (stateRegistry).
beforeEach(() => {
  resetRuntimeLimits();
});

afterEach(() => {
  resetRuntimeLimits();
});

describe("CONFIG_KEYS: Metadaten-Vertrag", () => {
  test("jede Schlüssel-Deklaration ist in Ceilings UND Defaults verankert", () => {
    for (const { key } of CONFIG_KEYS) {
      assert.ok(key in LIMIT_CEILINGS, `CONFIG_KEYS-Schlüssel ${key} fehlt in LIMIT_CEILINGS`);
      assert.ok(key in DEFAULT_LIMITS, `CONFIG_KEYS-Schlüssel ${key} fehlt in DEFAULT_LIMITS`);
    }
  });

  test("Schlüssel sind eindeutig (kein doppeltes Dashboard-Feld)", () => {
    const keys = CONFIG_KEYS.map((k) => k.key);
    assert.equal(new Set(keys).size, keys.length, "doppelte Keys würden zwei Regler auf denselben Wert legen");
  });

  test("Label und Beschreibung sind je Eintrag gesetzt (Anzeigepflicht)", () => {
    for (const entry of CONFIG_KEYS) {
      assert.ok(entry.label.trim().length > 0, `${entry.key}: Label darf nicht leer sein`);
      assert.ok(entry.description.trim().length > 0, `${entry.key}: Beschreibung darf nicht leer sein`);
    }
  });

  test("Default des Dashboard-Sets liegt selbst im Ceiling-Fenster", () => {
    for (const { key } of CONFIG_KEYS) {
      const [min, max] = LIMIT_CEILINGS[key];
      const value = Number(DEFAULT_LIMITS[key]);
      assert.ok(value >= min && value <= max,
        `${key}: Default ${value} liegt außerhalb des Fensters [${min}, ${max}]`);
    }
  });
});

describe("effectiveConfigView: Limits-Namensraum", () => {
  test("liefert einen Eintrag je CONFIG_KEYS-Schlüssel", () => {
    const view = effectiveConfigView();
    assert.equal(view.limits.length, CONFIG_KEYS.length, "der View muss alle Risk-Limits zeigen");
    const keys = view.limits.map((e) => e.key);
    for (const { key } of CONFIG_KEYS) {
      assert.ok(keys.includes(key), `${key} fehlt im Limits-View`);
    }
  });

  test("im Auslieferungszustand gilt der Code-Default", () => {
    const view = effectiveConfigView();
    for (const entry of view.limits) {
      assert.equal(entry.value, DEFAULT_LIMITS[entry.key as keyof RiskLimits],
        `${entry.key}: ohne Operator-Eingriff muss der Default wirksam sein`);
      assert.equal(entry.defaultValue, DEFAULT_LIMITS[entry.key as keyof RiskLimits],
        `${entry.key}: defaultValue muss der dokumentierte Default sein`);
    }
  });

  test("min/max des Views sind die unantastbaren Code-Ceilings", () => {
    const view = effectiveConfigView();
    for (const entry of view.limits) {
      const [min, max] = LIMIT_CEILINGS[entry.key as keyof RiskLimits];
      assert.equal(entry.min, min, `${entry.key}: min muss das Code-Ceiling sein`);
      assert.equal(entry.max, max, `${entry.key}: max muss das Code-Ceiling sein`);
    }
  });

  test("kein Limits-Eintrag ist gelockt (requireStopLoss ist gleich ganz entzogen)", () => {
    const view = effectiveConfigView();
    for (const entry of view.limits) {
      assert.equal(entry.locked, false, `${entry.key}: im Limits-View ist nichts gelockt`);
    }
  });

  test("requireStopLoss fehlt bewusst im View (Pflicht ist nicht konfigurierbar)", () => {
    // Die Pflicht zum Stop-Loss ist dem Dashboard komplett entzogen —
    // kein Regler, kein API-Key. Das ist stärker als jedes Locked-Flag.
    const view = effectiveConfigView();
    assert.ok(
      !view.limits.some((e) => e.key === "requireStopLoss"),
      "requireStopLoss darf niemals im konfigurierbaren View auftauchen"
    );
  });

  test("Operator-Änderung erscheint als effektiver Wert im View", () => {
    applyRuntimeLimits({ maxPositionPct: 0.3 });
    const view = effectiveConfigView();
    const entry = view.limits.find((e) => e.key === "maxPositionPct");
    assert.ok(entry, "maxPositionPct muss im View existieren");
    assert.equal(entry.value, 0.3, "der View muss die wirksame Operator-Einstellung zeigen");
  });

  test("Ausreißer über dem Ceiling wird geklemmt, nicht übernommen (Code entscheidet)", () => {
    applyRuntimeLimits({ maxPositionPct: 0.9 }); // Ceiling max = 0.5
    const view = effectiveConfigView();
    const entry = view.limits.find((e) => e.key === "maxPositionPct");
    assert.ok(entry, "maxPositionPct muss im View existieren");
    assert.equal(entry.value, LIMIT_CEILINGS.maxPositionPct[1],
      "ein Wert über dem Ceiling muss auf das Ceiling geklemmt werden");
  });

  test("requireStopLoss bleibt auch nach Abschalt-Versuch true (Code entscheidet)", () => {
    // Der Angriff läuft über applyRuntimeLimits (denselben Pfad wie das
    // Dashboard) — die wirksamen Limits müssen die Pflicht trotzdem tragen.
    applyRuntimeLimits({ requireStopLoss: false } as Partial<RiskLimits>);
    assert.equal(getLimits().requireStopLoss, true, "requireStopLoss darf niemals abschaltbar sein");
  });
});

describe("effectiveConfigView: Volatility-Namensraum (adp.*)", () => {
  test("liefert einen Eintrag je VOLATILITY_KEYS-Schlüssel", () => {
    const view = effectiveConfigView();
    assert.equal(view.volatility.length, VOLATILITY_KEYS.length, "der View muss alle adp.*-Keys zeigen");
    const keys = view.volatility.map((e) => e.key);
    for (const { key } of VOLATILITY_KEYS) {
      assert.ok(keys.includes(key), `${key} fehlt im Volatility-View`);
    }
  });

  test("Keys tragen das adp.*-Präfix und sind vom Limits-Namensraum getrennt", () => {
    const view = effectiveConfigView();
    for (const entry of view.volatility) {
      assert.ok(entry.key.startsWith("adp."), `${entry.key} muss das adp.*-Präfix tragen`);
    }
    const limitKeys = new Set(view.limits.map((e) => e.key));
    for (const entry of view.volatility) {
      assert.ok(!limitKeys.has(entry.key), `${entry.key} darf nicht in beiden Namensräumen stehen`);
    }
  });

  test("Defaults liegen im Bounds-Fenster und werden als Wert + Default gezeigt", () => {
    const view = effectiveConfigView();
    for (const entry of view.volatility) {
      const meta = VOLATILITY_KEYS.find((k) => k.key === entry.key);
      assert.ok(meta, `${entry.key} braucht einen VOLATILITY_KEYS-Eintrag`);
      const [min, max] = VOLATILITY_CONFIG_BOUNDS[meta.field];
      assert.equal(entry.min, min, `${entry.key}: min muss das Bounds-Fenster spiegeln`);
      assert.equal(entry.max, max, `${entry.key}: max muss das Bounds-Fenster spiegeln`);
      assert.equal(entry.defaultValue, DEFAULT_VOLATILITY_CONFIG[meta.field],
        `${entry.key}: defaultValue muss der Konfigurations-Default sein`);
      const value = Number(entry.value);
      assert.ok(value >= min && value <= max,
        `${entry.key}: effektiver Wert ${value} liegt außerhalb [${min}, ${max}]`);
    }
  });

  test("kein Volatility-Eintrag ist gelockt (alles ist Operator-justierbar)", () => {
    const view = effectiveConfigView();
    for (const entry of view.volatility) {
      assert.equal(entry.locked, false, `${entry.key} darf nicht gelockt sein`);
    }
  });
});
