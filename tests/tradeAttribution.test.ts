/**
 * Trade-PnL-Attribution — reine Modelltests (RMA-P1-06, v1.57.0).
 *
 * Deckung (Definition of Done):
 *   1. Reconciliation: Quellen + Kosten + Residual = Netto-PnL EXAKT (≤ 1e-6)
 *      für LONG/SHORT, Gewinn/Verlust, mit/ohne Kosten, bekannte/unbekannte
 *      Kostenkomponenten.
 *   2. Alignment: gleichgerichtete/entgegengesetzte TRADE-Stimmen, Enthaltung
 *      (HOLD, TRADE ohne Seite, fremdes Symbol), Proposer-Bindung, letzte
 *      Stimme gewinnt, Confidence-Clamping + Default 0.5.
 *   3. Negative Paths: NaN-PnL, negative Gebühren, ungültige Seite, nicht
 *      implementierte Methodenversion ⇒ AttributionError (fail-closed).
 *   4. UNATTRIBUTABLE: fehlender / v1- / beschädigter Snapshot, keine Quelle —
 *      bekannte Kosten bleiben trotzdem ausgewiesen, Rest = Residual.
 *   5. Determinismus: identische Eingabe ⇒ identisches Ergebnis (Golden),
 *      unabhängig von der Stimmenreihenfolge.
 *   6. Backtest-Adapter: Strategie als einzige Quelle, Kosten separat,
 *      semantisch identisch zum Journal-Pfad.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ATTRIBUTION_DEFAULT_CONFIDENCE,
  ATTRIBUTION_RECONCILIATION_TOLERANCE,
  AttributionError,
  type TradeAttributionInput,
} from "../src/attribution/types";
import {
  attributeBacktestTrade,
  computeTradeAttribution,
  effectiveConfidence,
  voteAlignment,
} from "../src/attribution/model";
import { canonicalJson } from "../src/attribution/hashes";

// ── Fixtures ────────────────────────────────────────────────────────────────

const T0 = "2026-09-01T10:00:00.000Z";

function vote(overrides: Record<string, unknown> = {}) {
  return {
    name: "AGENT-A",
    role: "RESEARCH",
    vote: "TRADE",
    confidence: null,
    riskScore: null,
    at: T0,
    symbol: null,
    side: null,
    model: null,
    ...overrides,
  };
}

function snapshotV2(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    attribution: "PROPOSAL",
    proposalId: "p-1",
    ruleId: null,
    votes: [],
    proposer: { name: "CEO-AGENT", role: "CEO" },
    regime: "NORMAL",
    rationaleHash: "abc",
    source: "ENGINE",
    versions: {
      promptVersion: 3,
      agentVersions: { "CEO-AGENT": 3, "AGENT-A": 2, "AGENT-B": 1, "AGENT-R": 4 },
      ruleVersion: null,
      ruleKey: null,
      policyVersion: "rp1:deadbeef",
      dataFingerprint: "df1:cafebabe",
    },
    snapshotHash: "js2:0000",
    ...overrides,
  };
}

function baseInput(overrides: Partial<TradeAttributionInput> = {}): TradeAttributionInput {
  return {
    methodVersion: 1,
    symbol: "BTC",
    side: "LONG",
    grossPnl: 100,
    fees: null,
    funding: null,
    snapshot: snapshotV2(),
    ...overrides,
  };
}

function assertReconciled(result: {
  sourcesSum: number;
  costsSum: number;
  residual: number;
  netPnl: number;
}): void {
  const delta = Math.abs(result.sourcesSum + result.costsSum + result.residual - result.netPnl);
  assert.ok(
    delta <= ATTRIBUTION_RECONCILIATION_TOLERANCE,
    `Reconciliation verletzt: Δ=${delta} (Quellen ${result.sourcesSum} + Kosten ${result.costsSum} + Residual ${result.residual} vs. Netto ${result.netPnl})`
  );
}

function agentEntry(result: ReturnType<typeof computeTradeAttribution>, name: string) {
  const hit = result.entries.find((e) => e.sourceType === "AGENT" && e.sourceId === name);
  assert.ok(hit, `AGENT-Posten für ${name} fehlt`);
  return hit;
}

// ── 1) Reconciliation & Gewichte ────────────────────────────────────────────

test("LONG-Gewinn: Quellen + Kosten + Residual = Netto exakt; Konfliktlandet im Residual", () => {
  const result = computeTradeAttribution(
    baseInput({
      grossPnl: 100,
      fees: 10,
      funding: -5,
      snapshot: snapshotV2({
        votes: [
          vote({ name: "CEO-AGENT", role: "CEO", vote: "TRADE", side: "LONG", symbol: "BTC", confidence: 0.8, at: "2026-09-01T09:50:00.000Z" }),
          vote({ name: "AGENT-A", role: "RESEARCH", vote: "TRADE", side: "LONG", symbol: "BTC", confidence: 0.6, at: "2026-09-01T09:55:00.000Z" }),
          vote({ name: "AGENT-B", role: "EXECUTOR", vote: "APPROVE", confidence: 0.9, at: "2026-09-01T09:58:00.000Z" }),
          vote({ name: "AGENT-R", role: "RISK_MANAGER", vote: "TRADE", side: "SHORT", symbol: "BTC", confidence: 0.9, at: "2026-09-01T09:59:00.000Z" }),
        ],
      }),
    })
  );

  assert.equal(result.status, "ATTRIBUTED");
  assert.equal(result.declaration, "DETERMINISTIC_ALLOCATION");
  // Netto = 100 − 10 + (−5) = 85; Kosten = −10 + (−5) = −15.
  assert.equal(result.netPnl, 85);
  assert.equal(result.costsSum, -15);
  // Teilnehmer: CEO 0.8 (+), RESEARCH 0.6 (+), RISK 0.9 (−) → W = 2.3.
  const ceo = agentEntry(result, "CEO-AGENT");
  const research = agentEntry(result, "AGENT-A");
  const risk = agentEntry(result, "AGENT-R");
  assert.equal(ceo.alignment, 1);
  assert.equal(risk.alignment, -1, "Gegenstimme erhält negatives Alignment");
  assert.ok(Math.abs(ceo.contribution - (100 * 0.8) / 2.3) < 1e-6, `CEO-Beitrag ${ceo.contribution}`);
  assert.ok(Math.abs(research.contribution - (100 * 0.6) / 2.3) < 1e-6);
  assert.ok(Math.abs(risk.contribution + (100 * 0.9) / 2.3) < 1e-6, "Gegenstimme: negativer Beitrag beim Gewinn");
  // Quellen teilen das Brutto (100): Σ = 100 × (0.8 + 0.6 − 0.9)/2.3.
  assert.ok(Math.abs(result.sourcesSum - (100 * 0.5) / 2.3) < 1e-6);
  // Enthaltung: Beitrag exakt 0, sichtbare Zeile.
  const executor = agentEntry(result, "AGENT-B");
  assert.equal(executor.alignment, 0);
  assert.equal(executor.contribution, 0);
  assert.equal(result.abstentions, 1);
  assert.equal(result.participants, 3);
  // Konfliktanteil (2 × 0.9/2.3 × 100) verbleibt im Residual.
  assert.ok(Math.abs(result.residual - (100 * (1 - 0.5 / 2.3))) < 1e-6, `Residual ${result.residual}`);
  assertReconciled(result);
  assert.deepEqual(result.unknownCosts, []);
});

test("SHORT-Verlust: Vorzeichen drehen; Gegenstimme verdient; unbekanntes Funding bleibt sichtbar", () => {
  const result = computeTradeAttribution(
    baseInput({
      side: "SHORT",
      grossPnl: -50,
      fees: 2,
      funding: null,
      snapshot: snapshotV2({
        votes: [
          vote({ name: "CEO-AGENT", role: "CEO", vote: "TRADE", side: "SHORT", symbol: "BTC", confidence: 0.8, at: "2026-09-01T09:50:00.000Z" }),
          vote({ name: "AGENT-R", role: "RISK_MANAGER", vote: "TRADE", side: "LONG", symbol: "BTC", confidence: 0.9, at: "2026-09-01T09:59:00.000Z" }),
        ],
      }),
    })
  );
  assert.equal(result.status, "ATTRIBUTED");
  // Netto = −50 − 2 (Funding unbekannt, NICHT 0) = −52.
  assert.equal(result.netPnl, -52);
  assert.deepEqual(result.unknownCosts, ["FUNDING"]);
  const ceo = agentEntry(result, "CEO-AGENT");
  const risk = agentEntry(result, "AGENT-R");
  // Quellen teilen das Brutto (−50): CEO −50×0.8/1.7, RISK +50×0.9/1.7.
  assert.ok(Math.abs(ceo.contribution - (-50 * 0.8) / 1.7) < 1e-6, "Short-Verlust: Verlustbeitrag");
  assert.ok(Math.abs(risk.contribution - (50 * 0.9) / 1.7) < 1e-6, "Gegenstimme verdient am Verlust");
  assertReconciled(result);
});

test("Volle Einigung: Residual exakt 0; unbekannte Kosten werden geflaggt, nicht 0 gesetzt", () => {
  const result = computeTradeAttribution(
    baseInput({
      grossPnl: 33.33,
      fees: null,
      funding: null,
      snapshot: snapshotV2({ votes: [] }), // nur der Proposer
    })
  );
  assert.equal(result.status, "ATTRIBUTED");
  assert.equal(result.participants, 1);
  const ceo = agentEntry(result, "CEO-AGENT");
  // Proposer ohne Confidence → Default 0.5, alleiniger Teilnehmer ⇒ voller Anteil.
  assert.equal(ceo.weight, 1);
  assert.ok(Math.abs(ceo.contribution - 33.33) < 1e-6);
  assert.equal(result.sourcesSum, result.grossPnl);
  assert.equal(result.costsSum, 0);
  assert.equal(result.residual, 0, "Kein Konflikt, keine Rundung ⇒ Residual exakt 0");
  assert.deepEqual(result.unknownCosts, ["FEES", "FUNDING"], "unbekannte Kosten bleiben sichtbar");
  assertReconciled(result);
});

test("Bekannte Kosten: Quellen teilen das Brutto; Netto = Brutto − Gebühren + Funding", () => {
  const result = computeTradeAttribution(
    baseInput({
      grossPnl: 200,
      fees: 12.5,
      funding: 3.5,
      snapshot: snapshotV2({ votes: [] }),
    })
  );
  assert.equal(result.netPnl, 191);
  assert.equal(result.costsSum, -12.5 + 3.5);
  assert.ok(Math.abs(result.sourcesSum - 200) < 1e-6, "Quellen teilen das Brutto-PnL");
  assert.ok(Math.abs(result.residual) < 1e-6);
  assertReconciled(result);
});

// ── 2) Alignment-Regeln ─────────────────────────────────────────────────────

test("voteAlignment: Richtung, fehlende Seite, fremdes Symbol, Nicht-TRADE", () => {
  const trade = { symbol: "BTC", side: "LONG" as const };
  assert.equal(voteAlignment(vote({ side: "LONG", symbol: "BTC" }), trade), 1);
  assert.equal(voteAlignment(vote({ side: "LONG", symbol: null }), trade), 1, "Symbol fehlt ⇒ zählt für das Trade-Instrument");
  assert.equal(voteAlignment(vote({ side: "SHORT", symbol: "BTC" }), trade), -1);
  assert.equal(voteAlignment(vote({ side: null }), trade), 0, "TRADE ohne Seite = Enthaltung");
  assert.equal(voteAlignment(vote({ side: "LONG", symbol: "ETH" }), trade), 0, "fremdes Instrument = Enthaltung");
  assert.equal(voteAlignment(vote({ vote: "HOLD", side: "LONG" }), trade), 0);
  assert.equal(voteAlignment(vote({ vote: "REJECT", side: "LONG" }), trade), 0, "REJECT ohne Proposal-Bindung wird nicht spekulativ gewertet");
  assert.equal(voteAlignment(vote({ vote: "KILL" }), trade), 0);
});

test("Letzte Stimme je Agent gewinnt (chronologisch nach Zeitstempel)", () => {
  const result = computeTradeAttribution(
    baseInput({
      snapshot: snapshotV2({
        votes: [
          vote({ name: "AGENT-A", vote: "TRADE", side: "LONG", symbol: "BTC", confidence: 0.9, at: "2026-09-01T09:00:00.000Z" }),
          vote({ name: "AGENT-A", vote: "TRADE", side: "SHORT", symbol: "BTC", confidence: 0.7, at: "2026-09-01T09:30:00.000Z" }),
        ],
        proposer: null,
      }),
    })
  );
  const a = agentEntry(result, "AGENT-A");
  assert.equal(a.alignment, -1, "spätere Gegenstimme ersetzt die frühere Zustimmung");
  assert.ok(a.contribution < 0);
  assertReconciled(result);
});

test("Confidence: Clamp [0,1]; fehlende ⇒ 0.5 (Beta(2,2)-Prior)", () => {
  assert.equal(effectiveConfidence(null), ATTRIBUTION_DEFAULT_CONFIDENCE);
  assert.equal(effectiveConfidence(5), 1);
  assert.equal(effectiveConfidence(-2), 0);
  assert.equal(effectiveConfidence(0.7), 0.7);
});

test("Confidence 0 bei allen Teilnehmern: Richtung bleibt, Masse 0 ⇒ alles im Residual", () => {
  const result = computeTradeAttribution(
    baseInput({
      snapshot: snapshotV2({
        votes: [vote({ name: "AGENT-A", vote: "TRADE", side: "LONG", symbol: "BTC", confidence: 0, at: T0 })],
        proposer: null,
      }),
    })
  );
  assert.equal(result.status, "ATTRIBUTED");
  const a = agentEntry(result, "AGENT-A");
  assert.equal(a.alignment, 1);
  assert.equal(a.weight, 0);
  assert.equal(a.contribution, 0);
  assert.equal(result.sourcesSum, 0);
  assert.equal(result.residual, result.netPnl);
  assertReconciled(result);
});

test("Proposer-Bindung schlägt die Turn-Auswertung (Alignment +1 ohne eigene Stimme)", () => {
  const result = computeTradeAttribution(
    baseInput({
      snapshot: snapshotV2({
        votes: [
          vote({ name: "AGENT-A", vote: "TRADE", side: "SHORT", symbol: "BTC", confidence: 0.9, at: T0 }),
        ],
      }),
    })
  );
  // Proposer (CEO-AGENT) hat KEINE Stimme, ist aber über proposalId gebunden.
  const ceo = agentEntry(result, "CEO-AGENT");
  assert.equal(ceo.alignment, 1);
  assert.ok(ceo.contribution > 0);
  // AGENT-A bleibt Gegenstimme mit eigenem Gewicht.
  const a = agentEntry(result, "AGENT-A");
  assert.equal(a.alignment, -1);
  assertReconciled(result);
});

// ── 3) Regel-Trades ─────────────────────────────────────────────────────────

test("RULE-Snapshot: Regel ist einzige Quelle, volle Brutto-Zuteilung, Residual 0", () => {
  const result = computeTradeAttribution(
    baseInput({
      grossPnl: -17.25,
      fees: 1,
      funding: -0.5,
      snapshot: snapshotV2({
        attribution: "RULE",
        proposalId: null,
        proposer: { name: "RESEARCH", role: "RESEARCH" },
        votes: [
          // Würde Doppel-Zuteilung verursachen, wenn Stimmen ausgewertet
          // würden — bei REGEL-Trades sind Stimmen bewusst nicht Teil der Kette.
          vote({ name: "AGENT-A", vote: "TRADE", side: "LONG", symbol: "BTC", confidence: 0.9, at: T0 }),
        ],
        versions: {
          promptVersion: null,
          agentVersions: {},
          ruleVersion: 4,
          ruleKey: "11111111-2222-3333-4444-555555555555",
          policyVersion: "rp1:x",
          dataFingerprint: null,
        },
      }),
    })
  );
  assert.equal(result.status, "ATTRIBUTED");
  const rule = result.entries.find((e) => e.sourceType === "RULE");
  assert.ok(rule, "RULE-Posten vorhanden");
  assert.equal(rule.sourceId, "11111111-2222-3333-4444-555555555555");
  assert.equal(rule.sourceVersion, "4");
  assert.ok(Math.abs(rule.contribution - -17.25) < 1e-6);
  assert.equal(result.entries.filter((e) => e.sourceType === "AGENT").length, 0, "keine erfundenen Agentenstimmen");
  assert.equal(result.netPnl, -17.25 - 1 - 0.5);
  assert.ok(Math.abs(result.residual) < 1e-6);
  assertReconciled(result);
});

// ── 4) UNATTRIBUTABLE & Negative Paths ──────────────────────────────────────

test("Fehlender Snapshot ⇒ UNATTRIBUTABLE (SNAPSHOT_MISSING); bekannte Kosten bleiben ausgewiesen", () => {
  const result = computeTradeAttribution(
    baseInput({ snapshot: null, grossPnl: 40, fees: 4, funding: 1 })
  );
  assert.equal(result.status, "UNATTRIBUTABLE");
  assert.equal(result.unattributableReason, "SNAPSHOT_MISSING");
  assert.equal(result.sourcesSum, 0);
  assert.equal(result.costsSum, -4 + 1);
  assert.equal(result.netPnl, 37);
  assert.equal(result.residual, 37 - (-3), "Residual = Netto − Kosten");
  assertReconciled(result);
  const feesEntry = result.entries.find((e) => e.sourceId === "FEES");
  assert.ok(feesEntry, "Kosten bleiben auch bei UNATTRIBUTABLE sichtbar");
});

test("v1-Snapshot (Altbestand) ⇒ UNATTRIBUTABLE (SNAPSHOT_SCHEMA_V1), nichts geraten", () => {
  const v1 = {
    schemaVersion: 1,
    attribution: "PROPOSAL",
    proposalId: "p-1",
    ruleId: null,
    votes: [vote({ name: "AGENT-A", vote: "TRADE", confidence: 0.8 })],
    proposer: { name: "CEO-AGENT", role: "CEO" },
    regime: "NORMAL",
    rationaleHash: "abc",
    source: "ENGINE",
  };
  const result = computeTradeAttribution(baseInput({ snapshot: v1 }));
  assert.equal(result.status, "UNATTRIBUTABLE");
  assert.equal(result.unattributableReason, "SNAPSHOT_SCHEMA_V1");
  assert.equal(result.snapshotSchemaVersion, 1);
  assert.equal(result.sourcesSum, 0);
  assert.equal(result.residual, result.netPnl);
  assertReconciled(result);
});

test("Beschädigter Snapshot ⇒ UNATTRIBUTABLE (SNAPSHOT_INVALID)", () => {
  const result = computeTradeAttribution(baseInput({ snapshot: "kein objekt" }));
  assert.equal(result.status, "UNATTRIBUTABLE");
  assert.equal(result.unattributableReason, "SNAPSHOT_INVALID");
});

test("v2 ohne Quelle (kein Proposer, keine Regel, nur Enthaltungen) ⇒ NO_SOURCES", () => {
  const result = computeTradeAttribution(
    baseInput({
      snapshot: snapshotV2({
        attribution: "PROPOSAL",
        proposer: null,
        votes: [vote({ name: "AGENT-A", vote: "HOLD", confidence: 0.9, at: T0 })],
      }),
    })
  );
  assert.equal(result.status, "UNATTRIBUTABLE");
  assert.equal(result.unattributableReason, "NO_SOURCES");
  assert.equal(result.sourcesSum, 0);
  assertReconciled(result);
});

test("Negative Paths werfen AttributionError (fail-closed, kein stilles Korrigieren)", () => {
  assert.throws(() => computeTradeAttribution(baseInput({ grossPnl: Number.NaN })), AttributionError);
  assert.throws(() => computeTradeAttribution(baseInput({ grossPnl: Number.POSITIVE_INFINITY })), AttributionError);
  assert.throws(() => computeTradeAttribution(baseInput({ fees: -1 })), AttributionError);
  assert.throws(
    () => computeTradeAttribution(baseInput({ funding: Number.NaN })),
    AttributionError
  );
  assert.throws(() => computeTradeAttribution(baseInput({ slippage: -3 })), AttributionError);
  assert.throws(
    () => computeTradeAttribution(baseInput({ side: "SIDEWAYS" as "LONG" })),
    AttributionError
  );
  assert.throws(() => computeTradeAttribution(baseInput({ symbol: "" })), AttributionError);
  assert.throws(
    () => computeTradeAttribution(baseInput({ methodVersion: 2 })),
    (e: unknown) => e instanceof AttributionError && e.code === "unsupported-method-version"
  );
});

// ── 5) Determinismus / Golden ───────────────────────────────────────────────

test("Determinismus: identische Eingabe ⇒ byte-identisches Ergebnis (Golden)", () => {
  const input = baseInput({
    fees: 3,
    funding: -1.25,
    snapshot: snapshotV2({
      votes: [
        vote({ name: "CEO-AGENT", vote: "TRADE", side: "LONG", symbol: "BTC", confidence: 0.8, at: "2026-09-01T09:50:00.000Z" }),
        vote({ name: "AGENT-A", vote: "TRADE", side: "SHORT", symbol: "BTC", confidence: 0.9, at: "2026-09-01T09:55:00.000Z" }),
      ],
    }),
  });
  const a = computeTradeAttribution(input);
  const b = computeTradeAttribution(JSON.parse(JSON.stringify(input)));
  assert.deepEqual(a, b, "Ergebnis ist rein deterministisch");
  // Goldener Kanonisierungs-Hash: stabil über Schlüsselreihenfolge hinweg.
  assert.equal(
    canonicalJson({ b: 1, a: [{ z: 1, y: 2 }] }),
    canonicalJson({ a: [{ y: 2, z: 1 }], b: 1 })
  );
});

test("Determinismus: Stimmenreihenfolge (bei eindeutigen Zeitstempeln) ändert die Beiträge nicht", () => {
  const votes = [
    vote({ name: "AGENT-A", vote: "TRADE", side: "LONG", symbol: "BTC", confidence: 0.6, at: "2026-09-01T09:10:00.000Z" }),
    vote({ name: "AGENT-B", vote: "TRADE", side: "LONG", symbol: "BTC", confidence: 0.4, at: "2026-09-01T09:20:00.000Z" }),
    vote({ name: "AGENT-R", vote: "TRADE", side: "SHORT", symbol: "BTC", confidence: 0.5, at: "2026-09-01T09:30:00.000Z" }),
  ];
  const forward = computeTradeAttribution(baseInput({ snapshot: snapshotV2({ votes, proposer: null }) }));
  const backward = computeTradeAttribution(
    baseInput({ snapshot: snapshotV2({ votes: [...votes].reverse(), proposer: null }) })
  );
  // Beiträge, Gewichte, Summen und Status sind identisch; der snapshotHash
  // ist ein Inhalts-Fingerprint (Reihenfolge der Stimmen ist Inhalt) und
  // darf sich unterscheiden — das Journal speichert chronologisch.
  const { snapshotHash: _f, ...semanticForward } = forward;
  const { snapshotHash: _b, ...semanticBackward } = backward;
  assert.deepEqual(semanticForward, semanticBackward);
  void _f;
  void _b;
});

test("Snapshot-Hash ist unabhängig von der JSON-Schlüsselreihenfolge", () => {
  const one = computeTradeAttribution(baseInput({ snapshot: snapshotV2() }));
  const reordered = JSON.parse(
    JSON.stringify(snapshotV2(), (key, value) => value)
  );
  // Schlüsselreihenfolge im votes/versions-Objekt drehen.
  reordered.versions = {
    dataFingerprint: reordered.versions.dataFingerprint,
    policyVersion: reordered.versions.policyVersion,
    ruleKey: reordered.versions.ruleKey,
    ruleVersion: reordered.versions.ruleVersion,
    agentVersions: reordered.versions.agentVersions,
    promptVersion: reordered.versions.promptVersion,
  };
  const two = computeTradeAttribution(baseInput({ snapshot: reordered }));
  assert.equal(one.snapshotHash, two.snapshotHash, "kanonischer Fingerprint");
});

// ── 6) Backtest-Adapter ─────────────────────────────────────────────────────

test("attributeBacktestTrade: Strategie = einzige Quelle; Netto = Brutto − Fees + Funding", () => {
  const result = attributeBacktestTrade({
    strategyId: "rule-btc-breakout@v2",
    symbol: "BTC",
    side: "SHORT",
    pnl: -80,
    fees: 6,
    funding: -2.5,
    slippage: 1.75,
  });
  assert.equal(result.status, "ATTRIBUTED");
  assert.equal(result.symbol, "BTC");
  assert.equal(result.side, "SHORT");
  assert.equal(result.netPnl, -80 - 6 - 2.5);
  const rule = result.entries.find((e) => e.sourceType === "RULE");
  assert.ok(rule);
  assert.equal(rule.sourceId, "rule-btc-breakout@v2");
  assert.ok(Math.abs(rule.contribution - -80) < 1e-6, "Strategie trägt das Brutto");
  assert.equal(result.slippageMemo, 1.75, "Slippage nur Memo (bereits in Fill-Preisen)");
  assert.ok(Math.abs(result.residual) < 1e-6, "keine Konflikte ⇒ kein Residual");
  assertReconciled(result);
});

test("attributeBacktestTrade ohne Funding-Ausweis: FUNDING bleibt unbekannt, kein 0-Ersatz", () => {
  const result = attributeBacktestTrade({
    strategyId: "s",
    symbol: "ETH",
    side: "LONG",
    pnl: 10,
    fees: 0.5,
    slippage: 0,
  });
  assert.equal(result.funding, null);
  assert.deepEqual(result.unknownCosts, ["FUNDING"]);
  assert.equal(result.netPnl, 9.5);
  assertReconciled(result);
});
