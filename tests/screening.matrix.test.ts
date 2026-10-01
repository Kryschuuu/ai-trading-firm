/**
 * STX-05-02 — Tests des Matrix-Builders (`src/screening/matrix.ts`).
 *
 * Deckt die Akzeptanzkriterien ab:
 *  - 6 Templates × 20 Instrumente × 3 Timeframes ⇒ erwartete Zellenzahl,
 *    keine Duplikate, kein `NaN` in Metriken oder Prioritäten.
 *  - Zellen-Explosion ⇒ `{ok:false}` mit exakter Meldung, **kein** stilles
 *    Kürzen — und der Guard läuft vor jedem injizierten Datenzugriff.
 *  - Stabile, deterministische Sortierung (priority desc, dann templateId,
 *    instrumentId, timeframe) auch bei identischen Prioritäten.
 *  - warmup-Gate: zu wenige Kerzen ⇒ Zelle `BLOCKED` mit Grund (nicht
 *    still übersprungen); unbekannte Kerzenzahl fail-closed.
 *  - `tf ∉ template.supportedTimeframes` ⇒ keine Zelle.
 *  - Scan-Gating (Ablehnung/nicht ausgewertet ⇒ BLOCKED) und Verhalten
 *    ohne Scan (nur Frühstatus).
 *  - Cross-Sectional-Rang speist `strategyFit`; fehlend/futur ⇒ Neutral 0.5.
 *  - Fail-closed Validierung aller Grenzen und Eingaben.
 *  - Skalierungstest: 500 Instrumente × 6 Templates × 3 Timeframes < 5 s.
 *
 * Alles rein und deterministisch: keine DB, kein Netzwerk, injizierte Uhr.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { CrossSectionalRankContext } from "../src/crossSectional/types";
import type { SupportedTimeframe } from "../src/lib/marketdata/historicalStore";
import { RULE_BACKTEST_MIN_BARS } from "../src/lib/ruleBacktest";
import { scanUniverse } from "../src/scanner/pipeline";
import { STRATEGY_TEMPLATES } from "../src/strategies/catalog";
import type { StrategyTemplate } from "../src/strategies/types";
import type { MarketInstrument } from "../src/universe/types";
import type { ScreeningPriorityConfig } from "../src/screening/config";
import {
  DEFAULT_MATRIX_LIMITS,
  MAX_MATRIX_CELLS,
  MAX_MATRIX_INSTRUMENTS,
  MAX_MATRIX_TEMPLATES,
  MAX_MATRIX_TIMEFRAMES_PER_TEMPLATE,
  buildCandidateMatrix,
  requiredWarmupCandles,
  type MatrixInput,
} from "../src/screening/matrix";
import { healthyCandles, instrument } from "./fixtures/scannerFixtures";

// ── Fixtures ───────────────────────────────────────────────────────────────

/** Fester Auswertungszeitpunkt (injizierte Uhr, nie `Date.now()`). */
const NOW = Date.parse("2026-09-01T12:00:00.000Z");

/** Drei Timeframes je Template — 6 × 20 × 3 = 360 Zellen in der Basis. */
const TFS = ["15m", "1h", "4h"] as const;

const INSTRUMENTS: readonly MarketInstrument[] = Array.from({ length: 20 }, (_, i) =>
  instrument({ symbol: `MSC${String(i).padStart(3, "0")}`, base: `MSC${i}` }),
);

/** Sechs Katalog-Templates, jeweils auf drei Timeframes gesetzt. */
const TEMPLATES: readonly StrategyTemplate[] = STRATEGY_TEMPLATES.map((t) => ({
  ...t,
  supportedTimeframes: TFS,
}));

function matrixInput(overrides: Partial<MatrixInput> = {}): MatrixInput {
  return {
    instruments: INSTRUMENTS,
    templates: TEMPLATES,
    dataQuality: () => ({ score: 0.9, candles: 5_000 }),
    liquidity: () => ({ score: 0.8, spreadPct: 0.0004, bookDepthUsd: 2_000_000 }),
    freshness: () => 0.85,
    correlation: () => 0.3,
    volatilityOpportunity: () => 0.7,
    now: NOW,
    limits: { ...DEFAULT_MATRIX_LIMITS },
    ...overrides,
  };
}

const METRIC_FIELDS = [
  "dataQuality",
  "liquidity",
  "freshness",
  "strategyFit",
  "volatilityOpportunity",
  "correlationPenalty",
] as const;

// ── Basis ──────────────────────────────────────────────────────────────────

test("Basis: 6 Templates × 20 Instrumente × 3 Timeframes ⇒ 360 Zellen, keine Duplikate, kein NaN", () => {
  const result = buildCandidateMatrix(matrixInput());
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.deepEqual(result.errors, []);
  assert.equal(result.cells.length, 360, "6 × 20 × 3");

  const keys = new Set<string>();
  for (const cell of result.cells) {
    const key = `${cell.templateId}|${cell.instrumentId}|${cell.timeframe}`;
    assert.equal(keys.has(key), false, `doppelte Zelle: ${key}`);
    keys.add(key);

    if (cell.priority !== null) {
      assert.ok(
        Number.isFinite(cell.priority) && cell.priority >= 0 && cell.priority <= 1,
        `priority außerhalb [0,1] oder NaN: ${String(cell.priority)}`,
      );
    }
    for (const field of METRIC_FIELDS) {
      const value = cell[field];
      assert.ok(
        value === null || (Number.isFinite(value) && value >= 0 && value <= 1),
        `${field} ist NaN/außerhalb [0,1]: ${String(value)}`,
      );
    }
    // Ohne Cross-Sectional-Rang ⇒ Neutralwert 0.5 (nie 0), Schwellen passen.
    assert.equal(cell.strategyFit, 0.5);
    assert.equal(cell.status, "DISCOVERED");
  }

  assert.deepEqual(result.stats, {
    instruments: 20,
    templates: 6,
    timeframes: 3,
    cells: 360,
    blockedByReason: {},
  });
  assert.deepEqual(DEFAULT_MATRIX_LIMITS, {
    maxInstruments: 500,
    maxTemplates: 16,
    maxTimeframesPerTemplate: 3,
    maxCells: 5_000,
  });
  assert.equal(MAX_MATRIX_INSTRUMENTS, 500);
  assert.equal(MAX_MATRIX_TEMPLATES, 16);
  assert.equal(MAX_MATRIX_TIMEFRAMES_PER_TEMPLATE, 3);
  assert.equal(MAX_MATRIX_CELLS, 5_000);
});

test("Reinheit: eingefrorene Eingaben werden nicht mutiert, zwei Läufe sind identisch", () => {
  const frozenInstruments = Object.freeze(
    INSTRUMENTS.map((i) => Object.freeze({ ...i })),
  );
  const frozenTemplates = Object.freeze(
    TEMPLATES.map((t) =>
      Object.freeze({
        ...t,
        supportedTimeframes: Object.freeze([...t.supportedTimeframes]),
      }),
    ),
  );
  const a = buildCandidateMatrix(
    matrixInput({ instruments: frozenInstruments, templates: frozenTemplates }),
  );
  const b = buildCandidateMatrix(
    matrixInput({ instruments: frozenInstruments, templates: frozenTemplates }),
  );
  assert.equal(a.ok, true, a.errors.join("; "));
  assert.deepEqual(a, b, "gleiche Eingabe ⇒ byte-identische Zellen");
});

// ── Sortierung ─────────────────────────────────────────────────────────────

test("Sortierung: identische Prioritäten ⇒ templateId, instrumentId, timeframe aufsteigend", () => {
  const result = buildCandidateMatrix(matrixInput());
  assert.equal(result.ok, true);
  assert.equal(
    new Set(result.cells.map((c) => c.priority)).size,
    1,
    "Prämisse: alle Prioritäten identisch",
  );

  const expected: string[] = [];
  for (const templateId of TEMPLATES.map((t) => t.id).sort()) {
    for (const instrumentId of INSTRUMENTS.map((i) => i.id).sort()) {
      for (const tf of TFS) expected.push(`${templateId}|${instrumentId}|${tf}`);
    }
  }
  const actual = result.cells.map(
    (c) => `${c.templateId}|${c.instrumentId}|${c.timeframe}`,
  );
  assert.deepEqual(actual, expected);
});

test("Sortierung: priority absteigend, unbekannte Priorität ganz am Ende", () => {
  const result = buildCandidateMatrix(
    matrixInput({
      // Frische als einziges variierendes Instrument ⇒ streng steigende Prioritäten.
      freshness: (inst) => {
        const i = Number(inst.symbol.slice(3));
        return i === 19 ? 0.9 : (i + 1) / 100;
      },
      // Instrument 19 ohne Liquiditäts-Score ⇒ priority null (fail-closed).
      liquidity: (inst) =>
        Number(inst.symbol.slice(3)) === 19
          ? { score: null, spreadPct: null, bookDepthUsd: null }
          : { score: 0.8, spreadPct: 0.0004, bookDepthUsd: 2_000_000 },
    }),
  );
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.cells.length, 360);

  // Prioritäten absteigend (nicht-null).
  for (let i = 1; i < 342; i++) {
    const prev = result.cells[i - 1].priority;
    const curr = result.cells[i].priority;
    assert.ok(prev !== null && curr !== null);
    assert.ok(prev >= curr, `Priorität steigt: ${String(prev)} → ${String(curr)}`);
  }
  // Höchste Priorität zuerst: MSC018 (Frische 0.19), dann absteigend.
  assert.equal(result.cells[0].instrumentId, "BINANCE:MSC018");
  assert.equal(result.cells[17].instrumentId, "BINANCE:MSC018");
  assert.equal(result.cells[18].instrumentId, "BINANCE:MSC017");

  // Die 18 Zellen ohne Priorität stehen vollständig am Ende.
  const tail = result.cells.slice(-18);
  assert.equal(tail.length, 18);
  for (const cell of tail) {
    assert.equal(cell.priority, null);
    assert.equal(cell.instrumentId, "BINANCE:MSC019");
    assert.equal(cell.status, "BLOCKED");
  }
  // Fail-closed: unbekannte Liquidität blockiert mit benanntem Grund.
  const blocked = result.stats.blockedByReason;
  assert.equal(
    blocked["liquidity: unbekannt; der konfigurierte Mindestwert 0.5 kann nicht geprüft werden"],
    18,
  );
  assert.equal(blocked["priority: liquidity: unbekannt (null)"], 18);
});

// ── DoS-Guard + Skalierung ─────────────────────────────────────────────────

test("Zellen-Explosion: 500 × 6 × 3 = 9000 > 5000 ⇒ ok:false, exakte Meldung, kein Datenzugriff", () => {
  let qualityCalls = 0;
  let liquidityCalls = 0;
  const result = buildCandidateMatrix(
    matrixInput({
      instruments: Array.from({ length: 500 }, (_, i) =>
        instrument({ symbol: `BIG${String(i).padStart(4, "0")}`, base: `BIG${i}` }),
      ),
      dataQuality: () => {
        qualityCalls += 1;
        return { score: 0.9, candles: 5_000 };
      },
      liquidity: () => {
        liquidityCalls += 1;
        return { score: 0.8, spreadPct: 0.0004, bookDepthUsd: 1 };
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["matrix too large: 9000 > 5000"]);
  assert.deepEqual(result.cells, []);
  assert.deepEqual(result.stats, {
    instruments: 0,
    templates: 0,
    timeframes: 0,
    cells: 0,
    blockedByReason: {},
  });
  assert.equal(qualityCalls, 0, "Guard greift VOR jeder injizierten Datenanbindung");
  assert.equal(liquidityCalls, 0, "Guard greift VOR jeder injizierten Datenanbindung");
});

test("Skalierung: 500 Instrumente × 6 Templates × 3 Timeframes bauen in < 5 s (maxCells-Override)", () => {
  const instruments = Array.from({ length: 500 }, (_, i) =>
    instrument({ symbol: `SCL${String(i).padStart(4, "0")}`, base: `SCL${i}` }),
  );
  const started = performance.now();
  const result = buildCandidateMatrix(
    matrixInput({
      instruments,
      limits: { ...DEFAULT_MATRIX_LIMITS, maxCells: 10_000 },
    }),
  );
  const elapsedMs = performance.now() - started;
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.cells.length, 9_000, "reine Matrix-Bildung, kein stilles Kürzen");
  assert.equal(result.stats.instruments, 500);
  assert.equal(result.stats.timeframes, 3);
  assert.ok(elapsedMs < 5_000, `Dauer ${elapsedMs.toFixed(0)} ms ≥ 5000 ms`);
});

// ── Zeitzustand (warmup) ───────────────────────────────────────────────────

test("Zeitzustand: zu wenige Kerzen ⇒ Zelle BLOCKED mit warmup-Grund, nicht übersprungen", () => {
  const short = "BINANCE:MSC007";
  const result = buildCandidateMatrix(
    matrixInput({
      dataQuality: (inst) => ({
        score: 0.9,
        candles: inst.id === short ? 29 : 5_000,
      }),
    }),
  );
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.cells.length, 360, "auch geblockte Zellen werden erzeugt");

  const required = requiredWarmupCandles("1h");
  assert.equal(required, RULE_BACKTEST_MIN_BARS, "L12: RULE_BACKTEST_MIN_BARS ist die Quelle");

  const cell1h = result.cells.find(
    (c) => c.instrumentId === short && c.timeframe === "1h",
  );
  assert.ok(cell1h);
  assert.equal(cell1h.status, "BLOCKED");
  assert.ok(
    cell1h.reasons.includes(`warmup: 29 < ${required}`),
    `Grund fehlt: ${cell1h.reasons.join(" | ")}`,
  );

  // Alle 18 Zellen (6 Templates × 3 Timeframes) des Instruments sind geblockt.
  const blockedShort = result.cells.filter(
    (c) => c.instrumentId === short && c.status === "BLOCKED",
  );
  assert.equal(blockedShort.length, 18);
  // Der Bedarf ist bar-basiert ⇒ derselbe Grundstring für alle Timeframes.
  assert.equal(result.stats.blockedByReason[`warmup: 29 < ${required}`], 18);
  // Alle anderen Instrumente bleiben DISCOVERED.
  assert.equal(
    result.cells.filter((c) => c.instrumentId !== short && c.status !== "DISCOVERED")
      .length,
    0,
  );
});

test("Zeitzustand: nicht-finite Kerzenzahl fällt fail-closed in den warmup-Gate", () => {
  const result = buildCandidateMatrix(
    matrixInput({
      dataQuality: (inst) => ({
        score: 0.9,
        candles: inst.id === "BINANCE:MSC008" ? Number.NaN : 5_000,
      }),
    }),
  );
  assert.equal(result.ok, true);
  const cell = result.cells.find(
    (c) => c.instrumentId === "BINANCE:MSC008" && c.timeframe === "1h",
  );
  assert.ok(cell);
  assert.equal(cell.status, "BLOCKED");
  assert.ok(
    cell.reasons.some((r) => r.startsWith("warmup: NaN < ")),
    `erwarteter warmup-Grund: ${cell.reasons.join(" | ")}`,
  );
});

// ── Timeframe-Filter ───────────────────────────────────────────────────────

test("Timeframe-Filter: nur tf ∈ template.supportedTimeframes erzeugt Zellen", () => {
  const oneTf: readonly StrategyTemplate[] = TEMPLATES.map((t, index) =>
    index === 0 ? { ...t, supportedTimeframes: ["1h"] as const } : t,
  );
  const result = buildCandidateMatrix(matrixInput({ templates: oneTf }));
  assert.equal(result.ok, true, result.errors.join("; "));
  // 1 Template × 20 × 1 tf + 5 Templates × 20 × 3 tfs = 320
  assert.equal(result.cells.length, 320);

  const filtered = result.cells.filter((c) => c.templateId === oneTf[0].id);
  assert.equal(filtered.length, 20, "nur eine Zelle je Instrument");
  for (const cell of filtered) {
    assert.equal(cell.timeframe, "1h");
  }
  assert.equal(
    result.cells.some(
      (c) => c.templateId === oneTf[0].id && c.timeframe !== "1h",
    ),
    false,
    "keine Zelle für ein nicht unterstütztes Timeframe",
  );
});

// ── Scan-Gating ────────────────────────────────────────────────────────────

test("Scan-Gating: Scan-Ablehnung ⇒ BLOCKED mit Grund; ohne Scan nur Frühstatus", () => {
  // Scan über 19 Instrumente; MSC000 ist gehalten ⇒ Eignungsfilter lehnt ab.
  const scanned = INSTRUMENTS.slice(0, 19).map((inst, i) =>
    i === 0 ? { ...inst, status: "halted" as const } : inst,
  );
  const scan = scanUniverse({
    instruments: scanned,
    data: { candles: () => healthyCandles(80) },
    asOf: NOW,
  });
  assert.deepEqual(
    scan.rejections.map((r) => ({ id: r.instrumentId, rule: r.ruleId })),
    [{ id: "BINANCE:MSC000", rule: "status-active" }],
    "Prämisse: genau eine fachliche Scan-Ablehnung",
  );

  const withScan = buildCandidateMatrix(matrixInput({ scan }));
  assert.equal(withScan.ok, true, withScan.errors.join("; "));
  assert.equal(withScan.cells.length, 360);

  const rejected = withScan.cells.filter((c) => c.instrumentId === "BINANCE:MSC000");
  assert.equal(rejected.length, 18);
  for (const cell of rejected) {
    assert.equal(cell.status, "BLOCKED");
    assert.ok(
      cell.reasons.some((r) => r.startsWith("scan status-active: ")),
      `Scan-Grund fehlt: ${cell.reasons.join(" | ")}`,
    );
  }
  const notScanned = withScan.cells.filter((c) => c.instrumentId === "BINANCE:MSC019");
  assert.equal(notScanned.length, 18);
  for (const cell of notScanned) {
    assert.equal(cell.status, "BLOCKED");
    assert.ok(cell.reasons.includes("scan: nicht im Scan-Ergebnis"));
  }
  // Die gescannten, nicht abgelehnten Instrumente bleiben Frühstatus.
  assert.ok(
    withScan.cells
      .filter((c) => c.instrumentId === "BINANCE:MSC001")
      .every((c) => c.status === "DISCOVERED"),
  );
  // Zähler der blockedByReason-Gründe: 18 Zellen je betroffenem Instrument.
  const blockedCounts = withScan.stats.blockedByReason;
  const scanRejectionKey = Object.keys(blockedCounts).find((k) =>
    k.startsWith("scan status-active: "),
  );
  assert.ok(scanRejectionKey, `Grund fehlt: ${Object.keys(blockedCounts).join(" | ")}`);
  assert.equal(blockedCounts[scanRejectionKey], 18);
  assert.equal(blockedCounts["scan: nicht im Scan-Ergebnis"], 18);

  // Ohne Scan kennt der Builder keine Scan-Ablehnungen — nur Frühstatus.
  const withoutScan = buildCandidateMatrix(matrixInput());
  assert.equal(withoutScan.ok, true);
  assert.ok(
    withoutScan.cells
      .filter(
        (c) =>
          c.instrumentId === "BINANCE:MSC000" || c.instrumentId === "BINANCE:MSC019",
      )
      .every((c) => c.status === "DISCOVERED"),
    "ohne Scan nur READY/DISCOVERED-Frühstatus (hier DISCOVERED ohne Persistenz-ID)",
  );
});

// ── Cross-Sectional-Rang ───────────────────────────────────────────────────

test("Cross-Sectional-Rang speist strategyFit; fehlend/futur ⇒ Neutralwert 0.5", () => {
  const ctx: CrossSectionalRankContext = {
    instrumentId: "BINANCE:MSC000",
    snapshotId: "snap-test-1",
    asOf: NOW - 60_000,
    rank: 3,
    percentile: 0.9,
    composite: 1.25,
  };
  const withRank = buildCandidateMatrix(
    matrixInput({ crossSectional: (id) => (id === ctx.instrumentId ? ctx : null) }),
  );
  assert.equal(withRank.ok, true, withRank.errors.join("; "));

  const ranked = withRank.cells.find((c) => c.instrumentId === ctx.instrumentId);
  const neutral = withRank.cells.find((c) => c.instrumentId === "BINANCE:MSC001");
  assert.ok(ranked && neutral);
  assert.equal(ranked.strategyFit, 0.9);
  assert.equal(neutral.strategyFit, 0.5);
  assert.ok(
    (ranked.priority ?? 0) > (neutral.priority ?? 0),
    "höheres Perzentil ⇒ höhere Priorität (Gewicht 0.15)",
  );
  assert.equal(withRank.cells[0].instrumentId, ctx.instrumentId);

  // PIT: Snapshot aus der Zukunft ⇒ kein Lookahead ⇒ Neutralwert.
  const future = buildCandidateMatrix(
    matrixInput({ crossSectional: () => ({ ...ctx, asOf: NOW + 1 }) }),
  );
  const futureCell = future.cells.find((c) => c.instrumentId === ctx.instrumentId);
  assert.ok(futureCell);
  assert.equal(futureCell.strategyFit, 0.5, "asOf > now darf nicht in die Zelle fließen");
  assert.equal(futureCell.priority, neutral.priority);
});

test("Ungültige injizierte Metrik ⇒ priority null (kein NaN) mit sichtbarem Grund", () => {
  const result = buildCandidateMatrix(matrixInput({ freshness: () => Number.NaN }));
  assert.equal(result.ok, true);
  assert.equal(result.cells.length, 360);
  for (const cell of result.cells) {
    assert.equal(cell.priority, null, "NaN darf nie als Priorität durchrutschen");
    assert.ok(
      cell.reasons.some((r) => r.includes("freshness")),
      `Grund fehlt: ${cell.reasons.join(" | ")}`,
    );
    // 05-01 klassifiziert nur dataQuality/liquidity als Blockgrund.
    assert.equal(cell.status, "DISCOVERED");
  }
  assert.deepEqual(result.stats.blockedByReason, {});
});

// ── Fail-closed Validierung ────────────────────────────────────────────────

test("Fail-closed Validierung: leere/defekte/überschreitende Eingaben ⇒ ok:false mit benanntem Fehler", () => {
  const cases: [Partial<MatrixInput>, string][] = [
    [{ instruments: [] }, "instruments: keine Instrumente übergeben"],
    [{ templates: [] }, "templates: keine Templates übergeben"],
    [{ now: Number.NaN }, "now: muss eine endliche Zahl"],
    [
      { limits: { ...DEFAULT_MATRIX_LIMITS, maxCells: 0 } },
      "limits.maxCells: muss eine positive Ganzzahl sein",
    ],
    [{ limits: { ...DEFAULT_MATRIX_LIMITS, maxCells: 100 } }, "matrix too large: 360 > 100"],
    [
      { limits: { ...DEFAULT_MATRIX_LIMITS, maxTimeframesPerTemplate: 2 } },
      "überschreiten das Limit",
    ],
    [
      { limits: { ...DEFAULT_MATRIX_LIMITS, maxInstruments: 19 } },
      "zu viele Instrumente: 20 > 19",
    ],
    [
      {
        templates: [
          ...TEMPLATES,
          ...Array.from({ length: 11 }, (_, i) => TEMPLATES[i % TEMPLATES.length]),
        ],
      },
      "zu viele Templates: 17 > 16",
    ],
    [{ instruments: [...INSTRUMENTS, INSTRUMENTS[0]] }, "doppelte Instrument-ID"],
    [{ templates: [...TEMPLATES, TEMPLATES[0]] }, "doppelte Template-ID"],
    [
      { templates: [{ ...TEMPLATES[0], id: "custom-seven" }] },
      "unbekannte Template-ID",
    ],
    [
      { templates: [{ ...TEMPLATES[0], supportedTimeframes: [] }] },
      "supportedTimeframes darf nicht leer sein",
    ],
    [
      {
        templates: [
          {
            ...TEMPLATES[0],
            supportedTimeframes: ["2d"] as unknown as readonly SupportedTimeframe[],
          },
        ],
      },
      "unbekannter Timeframe",
    ],
    [
      { instruments: [instrument({ venue: "BYBIT", symbol: "NOPE1" })] },
      "ist keine BrokerVenueId",
    ],
  ];

  for (const [overrides, needle] of cases) {
    const result = buildCandidateMatrix(matrixInput(overrides));
    assert.equal(result.ok, false, `erwarteter Fehler: ${needle}`);
    assert.ok(
      result.errors.some((e) => e.includes(needle)),
      `Fehler „${needle}“ fehlt in: ${result.errors.join(" | ")}`,
    );
    assert.deepEqual(result.cells, [], "kein Teil-Ergebnis bei Fehler");
    assert.equal(result.stats.cells, 0);
  }
});

test("Ungültige Prioritäts-Config ⇒ ok:false, bevor eine Zelle gebaut wird", () => {
  const broken = { version: 0 } as unknown as ScreeningPriorityConfig;
  const result = buildCandidateMatrix(matrixInput({ config: broken }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.cells, []);
  assert.ok(
    result.errors.some((e) => e.startsWith("config.")),
    `Config-Fehler erwartet: ${result.errors.join(" | ")}`,
  );
});
