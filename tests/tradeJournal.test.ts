/**
 * Trade-Journal — Tests (GAP-03, v1.43.0).
 *
 * Deckung (Definition of Done):
 *   1. MAE/MFE hand-calculated reference values (LONG + SHORT, identisches
 *      P&L-Vorzeichen: MAE = P&L am ungünstigsten Kurs, MFE = P&L am
 *      günstigsten Kurs), Zeitmaske [open, close], Lücken → null + Flag
 *      CANDLE_GAP (nie schätzen), leeres Fenster → NO_DATA.
 *   2. Bayes-Glättung (Beta(2,2)): 2/3 bleibt nahe am Prior, 20/30 wirkt
 *      empirisch; n=0 → Prior-Mittelwert 0.5.
 *   3. Gewichts-Bounds + maxDelta: Clamping, schrittweise Multi-Zyklus-
 *      Annäherung (nie Sprung), audit_log-Einträge im korrekten Modus.
 *   4. E2E-Attribution (DB-gegated, Repo-Konvention: ping → skip):
 *      executeApprovedProposal → Journal-Zeile mit korrektem
 *      Decision-Snapshot (Proposal, Stimmen, rationaleHash); Close via
 *      completeJournalRow → Metriken; fehlende Zeile → UNKNOWN-Backfill
 *      (sichtbare Lücke, kein Rat); idempotente Öffnung (1 Zeile).
 *   5. Auswertung: insufficient-sample unterhalb JOURNAL_MIN_TRADES wird
 *      NIEMALS als Faktor verwendet; ab minTrades: Vorschlag +
 *      Modus-Verhalten off/monitor/enforce (off/monitor lassen den
 *      Entscheidungspfad unverändert — keine Gewichtszeilen, keine
 *      wirksamen Gewichte).
 *   6. Quellmuster-Wiring: alle Schreibpfade (Engine ×2, Mikro-Executor,
 *      Monitor, Flatten) + Zyklus-Artefakte + Read-API (firm.read).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { db } from "../src/db";
import {
  agents,
  agentMessages,
  auditLog,
  missions,
  positions,
  proposals,
  tradeJournal,
  journalAgentWeights,
} from "../src/db/schema";
import { eq, sql, type SQL } from "drizzle-orm";
import type { Column } from "drizzle-orm";

/** IN-Liste ohne drizzle-inList (Versions-Compat): `col IN (${ids})`. */
function inSql(col: Column, ids: string[]) {
  return sql`${col} IN ${sql.join(ids.map((i) => sql`${i}`), sql`, `)}`;
}

/**
 * RMA-P1-06 (v1.57.0): Attribution-Posten/-Köpfe entfernen, BEVOR Journal-
 * Zeilen gelöscht werden (FK `trade_attributions.journal_id` ohne CASCADE —
 * Kinder zuerst). Best-effort: Auf nicht migrierten DBs (Tabellen fehlen)
 * ist das ein No-op, der Test bleibt grün.
 */
async function deleteAttributionRows(journalWhere: SQL): Promise<void> {
  try {
    await db.execute(
      sql`DELETE FROM trade_attribution_entries WHERE attribution_id IN
          (SELECT id FROM trade_attributions WHERE journal_id IN
            (SELECT id FROM trade_journal WHERE ${journalWhere}))`
    );
    await db.execute(
      sql`DELETE FROM trade_attributions WHERE journal_id IN
          (SELECT id FROM trade_journal WHERE ${journalWhere})`
    );
  } catch {
    /* Tabellen fehlen (unmigrierte DB) — kein FK, Löschung unnötig. */
  }
}
import { computeMaeMfe } from "../src/lib/journalMetrics";
import {
  computeJournalSummary,
  evaluateJournalFeedback,
  formatJournalWeightsContext,
  getEffectiveWeights,
  nextWeight,
  smoothedWinRate,
  targetWeight,
} from "../src/lib/journalAnalytics";
import { JOURNAL_ENV, JOURNAL_BETA_PRIOR, loadJournalConfig } from "../src/lib/journalConfig";
import { completeJournalRow, recordJournalOpen, unknownSnapshot } from "../src/lib/journal";

// ── DB-Gate (Repo-Konvention: DB-Tests setzen keine lokale DB voraus) ──────

async function dbReachable(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1 FROM trade_journal LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

const H = 3_600_000;

// ── 1) MAE/MFE — Rechenreferenzen (rein, deterministisch) ──────────────────

test("MAE/MFE LONG: Hand-Referenz, Zeitmaske [open, close] inklusive", () => {
  const o = 1_700_000_000_000;
  // Kerzen im Fenster: 99..101, 97..105, 98..104 → worst 97, best 105.
  // Die zwei Außen-Kerzen (t=o−1h low 50 / t=o+3h high 200) müssen IGNORIERT
  // werden — sonst wäre die Excursion erfunden.
  const res = computeMaeMfe({
    candles: [
      { ts: o - H, high: 10, low: 5 },
      { ts: o, high: 101, low: 99 },
      { ts: o + H, high: 105, low: 97 },
      { ts: o + 2 * H, high: 104, low: 98 },
      { ts: o + 3 * H, high: 200, low: 190 },
    ],
    side: "LONG",
    entryPrice: 100,
    openedAtMs: o,
    closedAtMs: o + 2 * H,
    timeframeMs: H,
  });
  assert.equal(res.quality, "OK");
  assert.equal(res.candlesUsed, 3);
  assert.equal(res.maePct, -0.03, "LONG MAE = (97−100)/100");
  assert.equal(res.mfePct, 0.05, "LONG MFE = (105−100)/100");
});

test("MAE/MFE SHORT: gespiegelt, einheitliches P&L-Vorzeichen", () => {
  const o = 1_700_000_000_000;
  // Gleicher Kurspfad wie der LONG-Test (Rise bis 105, Fall bis 97):
  // Short verliert am Hohen (105 → −5 %), gewinnt am Niedrigen (97 → +3 %).
  const res = computeMaeMfe({
    candles: [
      { ts: o, high: 101, low: 99 },
      { ts: o + H, high: 105, low: 97 },
      { ts: o + 2 * H, high: 104, low: 98 },
    ],
    side: "SHORT",
    entryPrice: 100,
    openedAtMs: o,
    closedAtMs: o + 2 * H,
    timeframeMs: H,
  });
  assert.equal(res.quality, "OK");
  assert.equal(res.maePct, -0.05, "SHORT MAE = (100−105)/100 (Verlust am höchsten Kurs)");
  assert.equal(res.mfePct, 0.03, "SHORT MFE = (100−97)/100 (Gewinn am niedrigsten Kurs)");
});

test("MAE/MFE: Lücke im Kerzenpfad → null + CANDLE_GAP (nie schätzen)", () => {
  const o = 1_700_000_000_000;
  const res = computeMaeMfe({
    candles: [
      { ts: o, high: 101, low: 99 },
      { ts: o + 3 * H, high: 102, low: 100 }, // 2h Lücke bei 1h-Kerzen
    ],
    side: "LONG",
    entryPrice: 100,
    openedAtMs: o,
    closedAtMs: o + 3 * H,
    timeframeMs: H,
  });
  assert.equal(res.quality, "CANDLE_GAP");
  assert.equal(res.maePct, null, "bei Lücke bleibt MAE null");
  assert.equal(res.mfePct, null, "bei Lücke bleibt MFE null");
});

test("MAE/MFE: keine Kerzen im Fenster → NO_DATA + null", () => {
  const o = 1_700_000_000_000;
  const empty = computeMaeMfe({
    candles: [],
    side: "LONG",
    entryPrice: 100,
    openedAtMs: o,
    closedAtMs: o + H,
    timeframeMs: H,
  });
  assert.equal(empty.quality, "NO_DATA");
  assert.equal(empty.maePct, null);

  // Nur Kerzen außerhalb des Fensters → ebenfalls NO_DATA.
  const outside = computeMaeMfe({
    candles: [
      { ts: o - H, high: 101, low: 99 },
      { ts: o + 2 * H, high: 101, low: 99 },
    ],
    side: "LONG",
    entryPrice: 100,
    openedAtMs: o,
    closedAtMs: o + H,
    timeframeMs: H,
  });
  assert.equal(outside.quality, "NO_DATA");
});

test("MAE/MFE: strukturell ungültige Eingabe wirft (fail-loud)", () => {
  assert.throws(() =>
    computeMaeMfe({
      candles: [],
      side: "LONG",
      entryPrice: 0,
      openedAtMs: 1,
      closedAtMs: 2,
      timeframeMs: H,
    })
  );
  assert.throws(() =>
    computeMaeMfe({
      candles: [],
      side: "LONG",
      entryPrice: 100,
      openedAtMs: 2,
      closedAtMs: 1, // umgekehrtes Fenster
      timeframeMs: H,
    })
  );
});

// ── 2) Bayes-Glättung (Beta(2,2)) ──────────────────────────────────────────

test("Glättung: kleine Stichprobe bleibt nahe am Prior (Rausch-Schutz)", () => {
  // 2/3 empirisch = 0.667, geglättet 4/7 ≈ 0.571 — näher am Prior 0.5 als an
  // der rohen Quote. Genau das ist der Rausch-Schutz für frische Trades.
  const p = smoothedWinRate(2, 3);
  assert.ok(Math.abs(p - 4 / 7) < 1e-12, `erwartet 4/7, bekam ${p}`);
  assert.ok(Math.abs(p - 0.5) < Math.abs(2 / 3 - 0.5), "geglättete Quote näher am Prior als die rohe");
});

test("Glättung: große Stichprobe wirkt empirisch", () => {
  const p = smoothedWinRate(20, 30);
  assert.ok(Math.abs(p - 22 / 34) < 1e-12, `erwartet 22/34, bekam ${p}`);
  assert.ok(Math.abs(p - 20 / 30) < 0.03, "nahe der empirischen Quote 0.667");
});

test("Glättung: n=0 → Prior-Mittelwert 0.5 (keine Evidenz, keine Aussage)", () => {
  assert.equal(smoothedWinRate(0, 0), 0.5);
});

test("Glättung: dokumentierte Prior-Konstante α=β=2", () => {
  assert.equal(JOURNAL_BETA_PRIOR.alpha, 2);
  assert.equal(JOURNAL_BETA_PRIOR.beta, 2);
});

// ── 3) Gewichte: Bounds + maxDelta (rein) ──────────────────────────────────

const BOUNDS = { weightMin: 0.5, weightMax: 1.5, maxWeightDelta: 0.1 };

test("Zielgewicht: p=0.5 → 1.0 (neutral), Extremwerte auf Bounds geklemmt", () => {
  assert.equal(targetWeight(0.5, BOUNDS), 1.0);
  assert.equal(targetWeight(1.0, BOUNDS), 1.5, "p=1.0 → obere Bound");
  assert.equal(targetWeight(0.0, BOUNDS), 0.5, "p=0.0 → untere Bound");
  assert.equal(targetWeight(0.9, BOUNDS), 1.4);
});

test("nextWeight: maximal Δ je Zyklus, immer innerhalb der Bounds", () => {
  const closeTo = (a: number, b: number) => Math.abs(a - b) < 1e-12;
  assert.ok(closeTo(nextWeight(1.0, 1.5, BOUNDS), 1.1), "Sprung 0.5 wird auf Δ=0.1 geklemmt");
  assert.ok(closeTo(nextWeight(1.45, 0.5, BOUNDS), 1.35), "Annäherung nach unten ebenfalls gedeckelt");
  assert.ok(closeTo(nextWeight(1.5, 0.5, BOUNDS), 1.4), "aus der oberen Bound nach innen");
  // Bound-Clamp: bei weightMin=0.5 und Δ=0.1 kann das Ergebnis nie < 0.5 sein.
  const tight = { ...BOUNDS, weightMin: 0.9 };
  assert.ok(closeTo(nextWeight(0.95, 0.5, tight), 0.9), "untere Bound (0.9) dominiert");
});

test("Multi-Zyklus: schrittweise Annäherung, kein Sprung (5 Zyklen → Bound)", () => {
  let w = 1.0;
  for (let i = 0; i < 5; i++) {
    const before = w;
    w = nextWeight(w, targetWeight(1.0, BOUNDS), BOUNDS);
    assert.ok(Math.abs(w - before) <= 0.1 + 1e-9, "je Zyklus maximal Δ");
  }
  assert.ok(Math.abs(w - 1.5) < 1e-9, "nach 5 Zyklen an der oberen Bound angekommen");
});

// ── 3b) Konfiguration: Defaults + Bounds-Clamp (rein, Env injiziert) ───────

test("Journal-Config: Defaults (off, 100, [0.5,1.5], Δ=0.1, 1h)", () => {
  const cfg = loadJournalConfig({});
  assert.equal(cfg.feedbackMode, "off");
  assert.equal(cfg.minTrades, 100);
  assert.equal(cfg.weightMin, 0.5);
  assert.equal(cfg.weightMax, 1.5);
  assert.equal(cfg.maxWeightDelta, 0.1);
  assert.equal(cfg.candlesTimeframe, "1h");
});

test("Journal-Config: Bounds-Clamp + fail-closed (unbekannt → sicher)", () => {
  const cfg = loadJournalConfig({
    [JOURNAL_ENV.MIN_TRADES]: "2", // < 5 → clamp 5
    [JOURNAL_ENV.WEIGHT_MIN]: "0.05", // < 0.1 → clamp 0.1
    [JOURNAL_ENV.WEIGHT_MAX]: "9", // > 3.0 → clamp 3.0
    [JOURNAL_ENV.MAX_WEIGHT_DELTA]: "0", // < 0.01 → clamp 0.01
    [JOURNAL_ENV.FEEDBACK_MODE]: "aggressiv", // unbekannt → off (fail-closed)
    [JOURNAL_ENV.CANDLES_TIMEFRAME]: "15x", // ungültig → 1h
  });
  assert.equal(cfg.minTrades, 5);
  assert.equal(cfg.weightMin, 0.1);
  assert.equal(cfg.weightMax, 3.0);
  assert.equal(cfg.maxWeightDelta, 0.01);
  assert.equal(cfg.feedbackMode, "off");
  assert.equal(cfg.candlesTimeframe, "1h");
});

// ── 4/5) DB-Tests (ping → skip) ────────────────────────────────────────────

/** Eindeutiges Regime-Tag je Testlauf (isoliert die Gruppe in der DB). */
const REGIME_TAG = `JOURTEST_${randomUUID().slice(0, 8).toUpperCase()}`;

/**
 * Setzt Env für die Journal-Feedback-Tests und stellt sie danach wieder her
 * (node:test läuft dieses File in einem eigenen Prozess — der Leak wäre auf
 * dieses File beschränkt, die Wiederherhaltung ist trotzdem sauber).
 */
function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

test("E2E: executeApprovedProposal → Journal-Zeile mit Decision-Snapshot; Close → Metriken", async (t) => {
  if (!(await dbReachable())) {
    t.skip("Keine PostgreSQL erreichbar (trade_journal) — DB-Test übersprungen (Repo-Konvention)");
    return;
  }

  const { executeApprovedProposal } = await import("../src/lib/engine");
  const { setProductionMarketDataManagerForTests } = await import("../src/lib/marketdata/production");
  const { MarketDataManager } = await import("../src/lib/marketdata/manager");
  const { getRegistry } = await import("../src/universe");
  const { testConfig, tempStore, FixtureBrokerAdapter } = await import("./fixtures/marketdataTestUtil");
  const { killSwitch, resetRuntimeLimits } = await import("../src/lib/riskGuard");
  const { orderIntents, equitySnapshots } = await import("../src/db/schema");

  resetRuntimeLimits();
  killSwitch.disarm();

  // Symbol-Isolation: bewusst ETH — BTC gehört dem H2-Integrationstest
  // (orderIntents), der Positions je Symbol löscht; eine BTC-Position mit
  // trade_journal-FK aus diesem Test würde dessen Cleanup brechen (FK).
  // ETH persistiert kein anderer Test (getestet). Vorlauf-Reste reinigen
  // (Attribution-Kinder zuerst, RMA-P1-06-FK):
  await deleteAttributionRows(sql`${tradeJournal.symbol} = 'ETH'`);
  await db.delete(tradeJournal).where(eq(tradeJournal.symbol, "ETH"));
  await db.delete(positions).where(eq(positions.symbol, "ETH"));
  await db.delete(orderIntents).where(sql`${orderIntents.symbol} = 'ETH'`);

  // Der Broker hydratisiert einmalig pro Prozess aus dem Shared-DB-Zustand
  // (letzte Equity-Snapshots + offene Positionen). Ein frischer Snapshot mit
  // vollem Startkapital stellt sicher, dass die Sizing-Guardrails
  // (Notional ≤ 25 % Equity) deterministisch passieren — und wird danach
  // wieder entfernt (additiv, berührt keine fremden Zeilen).
  const [equitySnap] = await db
    .insert(equitySnapshots)
    .values({
      ts: new Date(),
      equity: "10000",
      cash: "10000",
      openPositions: 0,
      trigger: "TICK",
    })
    .returning({ id: equitySnapshots.id });

  const agentId = randomUUID();
  const missionId = randomUUID();
  const researchId = randomUUID();
  const agentName = `journal-e2e-${randomUUID().slice(0, 8)}`;
  const researchName = `journal-research-${randomUUID().slice(0, 8)}`;
  const detail = {
    symbol: "ETH",
    side: "LONG",
    qty: 0.05,
    riskNotional: 160,
    stopLoss: 2800,
    takeProfit: 3600,
  };
  const reason = "journal e2e: genehmigter Vorschlag";

  // Seed: Agent (EXECUTOR), RESEARCH-Agent (Stimme in der Kette), Mission,
  // APPROVED-Proposal, Analysten-Turn mit meta.decision (Entscheidungskette).
  await db.insert(agents).values({
    id: agentId,
    name: agentName,
    role: "EXECUTOR",
    model: "test-model",
    status: "IDLE",
    systemPrompt: "Journal-E2E-Test",
  });
  await db.insert(agents).values({
    id: researchId,
    name: researchName,
    role: "RESEARCH",
    model: "test-model",
    status: "IDLE",
    systemPrompt: "Journal-E2E-Test (Stimme)",
  });
  await db.insert(missions).values({
    id: missionId,
    title: "journal-e2e",
    objective: "Journal-Attribution E2E-Test",
    symbol: "ETH",
    scope: "SINGLE_SYMBOL",
    riskBudget: "0.02",
    maxPositionPct: "0.25",
    status: "PENDING",
  });
  const proposalId = randomUUID();
  await db.insert(proposals).values({
    id: proposalId,
    missionId,
    agentId,
    action: "OPEN",
    proposedDetail: detail,
    status: "APPROVED",
    reason,
  });
  await db.insert(agentMessages).values({
    agentId: researchId,
    missionId,
    type: "DECISION",
    content: "BTC Long empfohlen",
    meta: {
      decision: { type: "TRADE", riskScore: 0.3 },
      actor: { name: researchName, role: "RESEARCH" },
      confidence: 0.8,
    },
  });

  // Kursquelle: Fixture-Broker (ETH = 3200) statt Netzwerk.
  setProductionMarketDataManagerForTests(
    new MarketDataManager({
      config: testConfig("http://127.0.0.1:1/", "http://127.0.0.1:1/"),
      registry: getRegistry(),
      store: tempStore(),
      brokerAdapter: new FixtureBrokerAdapter({ ETH: 3200 }),
    })
  );

  let positionId: string | null = null;
  // Vor dem Exec lesen: (1) jsonb sortiert Schlüssel — der rationaleHash
  // wird über dieselbe DB-Repräsentation berechnet wie die Engine;
  // (2) die Engine überschreibt `reason` nach der Ausführung.
  const [propRow] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
  const dbDetail = propRow.proposedDetail;
  const dbReason = propRow.reason ?? "";

  try {
    const res = await executeApprovedProposal(proposalId, agentId);
    assert.equal(res.status, "EXECUTED", `Vorschlag muss ausgeführt werden (war ${res.status}: ${res.guardrail ?? ""})`);

    const [pos] = await db.select().from(positions).where(eq(positions.missionId, missionId)).limit(1);
    assert.ok(pos, "Positions-Zeile existiert");
    positionId = pos.id;

    // (a) Journal-Zeile bei der Eröffnung: Snapshot aus Proposal + Kette.
    const [row] = await db.select().from(tradeJournal).where(eq(tradeJournal.positionId, pos.id)).limit(1);
    assert.ok(row, "Journal-Zeile existiert direkt nach der Eröffnung");
    const snap = row.decisionSnapshot as Record<string, unknown>;
    // RMA-P1-06 (v1.57.0): Schema v2 — Versionskette + kanonischer Hash.
    assert.equal(snap.schemaVersion, 2);
    assert.equal(snap.attribution, "PROPOSAL");
    assert.equal(snap.proposalId, proposalId);
    assert.equal(snap.source, "ENGINE");
    assert.equal(row.regime, snap.regime, "Regime-Spalte spiegelt den Snapshot");
    assert.equal(snap.rationaleHash, createHash("sha256").update(JSON.stringify({ reason: dbReason, detail: dbDetail })).digest("hex"), "rationaleHash = sha256(reason+detail)");
    assert.ok(
      typeof snap.snapshotHash === "string" && snap.snapshotHash.startsWith("js2:"),
      "kanonischer Snapshot-Fingerprint (js2:<sha256>)"
    );
    const versions = snap.versions as Record<string, unknown>;
    assert.ok(versions, "Versionskette (v2) vorhanden");
    assert.equal(versions.promptVersion, 1, "Promptversion des Proposers (agents.version Default 1)");
    const agentVersions = versions.agentVersions as Record<string, number>;
    assert.ok(Number.isFinite(agentVersions[researchName]), "Promptversion der Kettenstimme erfasst");
    assert.equal(versions.ruleKey, null, "Proposal-Pfad: keine Regelversion");
    assert.equal(versions.ruleVersion, null);
    assert.ok(typeof versions.policyVersion === "string" && versions.policyVersion.startsWith("rp1:"), "Policy-Fingerprint der wirksamen Limits");
    const votes = snap.votes as Array<Record<string, unknown>>;
    assert.equal(votes.length, 1, "genau die eine Kettenstimme (RESEARCH) im Snapshot");
    assert.equal(votes[0].role, "RESEARCH");
    assert.equal(votes[0].vote, "TRADE");
    assert.equal(votes[0].confidence, 0.8);
    // v2: Richtungsbeleg der Stimme — hier bewusst unbelegt (kein symbol/side
    // in der Seed-Entscheidung) ⇒ Attribution behandelt sie als Enthaltung.
    assert.equal(votes[0].symbol, null);
    assert.equal(votes[0].side, null);
    assert.equal((snap.proposer as { name?: string })?.name, agentName, "Proposer = der Vorschlags-Agent");

    // (b) Close: Metriken aus injizierten 1h-Kerzen (Rechenwert = Referenz).
    // Der Fill-Simulator (Modus B) fügt der Fixture-Quote deterministischen
    // Spread hinzu — die Referenzwerte werden deshalb RELATIV zum tatsächlichen
    // Entry aus der DB berechnet (keine Kursannahme).
    const openedAtMs = pos.createdAt.getTime();
    const entry = Number(pos.entryPrice);
    assert.ok(Number.isFinite(entry) && entry > 0, "Entry aus dem Fill");
    const closedAt = new Date(openedAtMs + 3 * H);
    const close = await completeJournalRow({
      positionId: pos.id,
      symbol: "ETH",
      side: "LONG",
      openedAt: pos.createdAt,
      entryPrice: entry,
      exitPrice: entry + 300,
      realizedPnl: 15,
      exitReason: "TAKE_PROFIT",
      closedAt,
      missionId,
      ruleId: null,
      timeframe: "1h",
      candles: [
        { ts: openedAtMs, high: entry + 100, low: entry - 250 },
        { ts: openedAtMs + H, high: entry + 400, low: entry + 100 },
        { ts: openedAtMs + 2 * H, high: entry + 300, low: entry - 150 },
      ],
    });
    assert.equal(close.closed, true, `Close muss gelingen (quality=${close.quality})`);
    assert.equal(close.backfilled, false, "Zeile existierte — kein Backfill");
    assert.equal(close.quality, "OK");
    // Referenz: worst = entry−250, best = entry+400.
    assert.ok(Math.abs((close.maePct as number) - (-250 / entry)) < 1e-12, "MAE-Referenzwert");
    assert.ok(Math.abs((close.mfePct as number) - (400 / entry)) < 1e-12, "MFE-Referenzwert");

    const [closedRow] = await db.select().from(tradeJournal).where(eq(tradeJournal.positionId, pos.id)).limit(1);
    assert.equal(Number(closedRow.pnl), 15);
    assert.equal(closedRow.exitReason, "TAKE_PROFIT");
    assert.equal(closedRow.holdingMinutes, 180, "3h Haltedauer");
    assert.equal(closedRow.quality, "OK");
  } finally {
    // Kinder zuerst (FK-tolerant, best-effort).
    const journalPosId = positionId ?? "00000000-0000-0000-0000-000000000000";
    await deleteAttributionRows(sql`${tradeJournal.positionId} = ${journalPosId}`);
    for (const fn of [
      () => db.delete(tradeJournal).where(sql`${tradeJournal.positionId} = ${journalPosId}`),
      () => db.delete(positions).where(eq(positions.missionId, missionId)),
      () => db.delete(agentMessages).where(eq(agentMessages.missionId, missionId)),
      () => db.delete(proposals).where(eq(proposals.id, proposalId)),
      () => db.delete(missions).where(eq(missions.id, missionId)),
      () => db.delete(auditLog).where(eq(auditLog.missionId, missionId)),
      () => db.delete(agents).where(inSql(agents.id, [agentId, researchId])),
      () => db.delete(equitySnapshots).where(eq(equitySnapshots.id, equitySnap.id)),
    ]) {
      try {
        await fn();
      } catch {
        /* Test-DB-Toleranz */
      }
    }
    killSwitch.disarm();
  }
});

test("Journal: Backfill bei fehlender Zeile → UNKNOWN-Snapshot (sichtbare Lücke)", async (t) => {
  if (!(await dbReachable())) {
    t.skip("Keine PostgreSQL erreichbar (trade_journal) — DB-Test übersprungen (Repo-Konvention)");
    return;
  }

  // "Manuelle" Position ohne Eröffnungshook (Altbestand): direkt in
  // `positions`, keine Journal-Zeile (explizite ID → Journal-FK passt).
  const positionId = randomUUID();
  const openedAt = new Date();
  await db.insert(positions).values({
    id: positionId,
    symbol: "ETH",
    side: "SHORT",
    qty: "0.1",
    entryPrice: "3200",
    currentPrice: "3200",
    broker: "PAPER",
    status: "OPEN",
  });

  try {
    const res = await completeJournalRow({
      positionId,
      symbol: "ETH",
      side: "SHORT",
      openedAt,
      entryPrice: 3200,
      exitPrice: 3100,
      realizedPnl: 10,
      exitReason: "MANUAL_FLATTEN",
      closedAt: new Date(openedAt.getTime() + 2 * H),
      missionId: null,
      ruleId: null,
      timeframe: "1h",
      candles: [
        { ts: openedAt.getTime(), high: 3250, low: 3190 },
        { ts: openedAt.getTime() + H, high: 3180, low: 3090 },
      ],
    });
    assert.equal(res.backfilled, true, "fehlende Zeile wird beim Close angelegt");
    assert.equal(res.closed, true);
    // SHORT-Referenz: worst am Hohen 3250 → (3200−3250)/3200; best am Niedrigen 3090 → (3200−3090)/3200.
    assert.ok(Math.abs((res.maePct as number) - (3200 - 3250) / 3200) < 1e-12, "SHORT MAE (Backfill)");
    assert.ok(Math.abs((res.mfePct as number) - (3200 - 3090) / 3200) < 1e-12, "SHORT MFE (Backfill)");

    const [row] = await db.select().from(tradeJournal).where(eq(tradeJournal.positionId, positionId)).limit(1);
    const snap = row.decisionSnapshot as Record<string, unknown>;
    assert.equal(snap.attribution, "UNKNOWN", "Lücke ist sichtbar (attribution UNKNOWN)");
    assert.equal(snap.rationaleHash, "unknown", "kein erfundener Rationale-Hash");
    assert.deepEqual(snap.votes, [], "keine erfundenen Stimmen");
    assert.equal(row.regime, "UNKNOWN");
  } finally {
    await deleteAttributionRows(sql`${tradeJournal.positionId} = ${positionId}`);
    for (const fn of [
      () => db.delete(tradeJournal).where(eq(tradeJournal.positionId, positionId)),
      () => db.delete(positions).where(eq(positions.id, positionId)),
    ]) {
      try {
        await fn();
      } catch {
        /* best-effort */
      }
    }
  }
});

test("Journal: idempotente Eröffnung (UNIQUE position_id → genau 1 Zeile)", async (t) => {
  if (!(await dbReachable())) {
    t.skip("Keine PostgreSQL erreichbar (trade_journal) — DB-Test übersprungen (Repo-Konvention)");
    return;
  }

  const positionId = randomUUID();
  await db.insert(positions).values({
    id: positionId,
    symbol: "ETH",
    side: "LONG",
    qty: "0.05",
    entryPrice: "3200",
    currentPrice: "3200",
    broker: "PAPER",
    status: "OPEN",
  });

  const snap = unknownSnapshot("ENGINE");
  try {
    const first = await recordJournalOpen({
      positionId,
      symbol: "ETH",
      side: "LONG",
      openedAt: new Date(),
      missionId: null,
      ruleId: null,
      snapshot: snap,
    });
    assert.equal(first.written, true);
    // Zweiter Aufruf (z. B. Doppel-Trigger): kein Duplikat, kein Fehler.
    const second = await recordJournalOpen({
      positionId,
      symbol: "ETH",
      side: "LONG",
      openedAt: new Date(),
      missionId: null,
      ruleId: null,
      snapshot: snap,
    });
    assert.equal(second.written, true, "Konflikt wird verschluckt (onConflictDoNothing)");
    const rows = await db.select().from(tradeJournal).where(eq(tradeJournal.positionId, positionId));
    assert.equal(rows.length, 1, "genau eine Journal-Zeile pro Position");
  } finally {
    await deleteAttributionRows(sql`${tradeJournal.positionId} = ${positionId}`);
    for (const fn of [
      () => db.delete(tradeJournal).where(eq(tradeJournal.positionId, positionId)),
      () => db.delete(positions).where(eq(positions.id, positionId)),
    ]) {
      try {
        await fn();
      } catch {
        /* best-effort */
      }
    }
  }
});

test("Auswertung + Feedback: insufficient-sample, Modi off/monitor/enforce, schrittweise Gewichte", async (t) => {
  if (!(await dbReachable())) {
    t.skip("Keine PostgreSQL erreichbar (trade_journal) — DB-Test übersprungen (Repo-Konvention)");
    return;
  }

  // 5 geschlossene, attributierte Trades einer Gruppe (RESEARCH @ TAG-Regime),
  // alle Gewinn → bei minTrades=5: ausreichende Stichprobe, p_glättet = 7/9.
  const jobPosIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const posId = randomUUID();
    jobPosIds.push(posId);
    await db.insert(positions).values({
      id: posId,
      symbol: "ETH",
      side: "LONG",
      qty: "0.05",
      entryPrice: "3200",
      currentPrice: "3200",
      broker: "PAPER",
      status: "CLOSED",
      exitReason: "TAKE_PROFIT",
    });
    await db.insert(tradeJournal).values({
      positionId: posId,
      symbol: "ETH",
      side: "LONG",
      openedAt: new Date(Date.now() - (i + 2) * 24 * H),
      closedAt: new Date(Date.now() - (i + 1) * 24 * H),
      decisionSnapshot: {
        schemaVersion: 1,
        attribution: "PROPOSAL",
        proposalId: null,
        ruleId: null,
        votes: [{ name: "job-agent", role: "RESEARCH", vote: "TRADE", confidence: 0.9, riskScore: 0.3, at: new Date().toISOString() }],
        proposer: { name: "job-agent", role: "RESEARCH" },
        regime: REGIME_TAG,
        rationaleHash: "job",
        source: "ENGINE",
      },
      regime: REGIME_TAG,
      pnl: String(10 + i),
      maePct: "-0.01",
      mfePct: "0.02",
      holdingMinutes: 120,
      exitReason: "TAKE_PROFIT",
      quality: "OK",
    });
  }

  const labelPrefix = `journal-weight:RESEARCH:${REGIME_TAG}:`;
  const cleanup = async () => {
    await deleteAttributionRows(sql`${tradeJournal.positionId} IN ${sql.join(jobPosIds.map((i) => sql`${i}`), sql`, `)}`);
    for (const fn of [
      () => db.delete(journalAgentWeights).where(eq(journalAgentWeights.regime, REGIME_TAG)),
      () =>
        db
          .delete(auditLog)
          .where(sql`${auditLog.event} IN ('JOURNAL_WEIGHT_PROPOSED', 'JOURNAL_WEIGHT_APPLIED') AND ${auditLog.detail}->>'label' LIKE ${labelPrefix + "%"}`),
      () => db.delete(tradeJournal).where(inSql(tradeJournal.positionId, jobPosIds)),
      () => db.delete(positions).where(inSql(positions.id, jobPosIds)),
    ]) {
      try {
        await fn();
      } catch {
        /* best-effort */
      }
    }
  };

  try {
    // ── off (Default): reine Auswertung, nichts wird geschrieben ──
    await withEnv({ [JOURNAL_ENV.FEEDBACK_MODE]: "off", [JOURNAL_ENV.MIN_TRADES]: "5" }, async () => {
      const offRes = await evaluateJournalFeedback();
      assert.equal(offRes.evaluated, false, "off: keine Auswertung im Feedback-Lauf");
      assert.equal(offRes.changes.length, 0);

      const summary = await computeJournalSummary({ symbolGroupOf: () => "crypto" });
      const group = summary.byAgentRegime.find((g) => g.agent === "RESEARCH" && g.regime === REGIME_TAG);
      assert.ok(group, "Gruppe RESEARCH×TAG in der Auswertung");
      assert.equal(group.trades, 5);
      assert.equal(group.wins, 5);
      assert.equal(group.sufficientSample, true);
      assert.equal(group.status, "ok");
      assert.equal(group.proposedWeight, null, "off: KEIN Gewichtsvorschlag (Auswertung nur)");
      assert.equal(summary.weights.mode, "off");
      assert.equal(summary.weights.proposed.length, 0, "off: keine Vorschläge");

      // Totals: attributed vs. unattributed (Backfill-Zeilen zählen als Lücke).
      assert.ok(summary.totals.attributedTrades >= 5, "attributierte Trades gezählt");
    });

    // ── insufficient-sample: unterhalb minTrades NIEMALS als Faktor ──
    await withEnv({ [JOURNAL_ENV.FEEDBACK_MODE]: "monitor", [JOURNAL_ENV.MIN_TRADES]: "20" }, async () => {
      const summary = await computeJournalSummary({ symbolGroupOf: () => "crypto" });
      const group = summary.byAgentRegime.find((g) => g.agent === "RESEARCH" && g.regime === REGIME_TAG);
      assert.ok(group);
      assert.equal(group.sufficientSample, false, "5 < 20 → insufziente Stichprobe");
      assert.equal(group.status, "insufficient-sample");
      assert.equal(group.proposedWeight, null, "insufficient-sample ist NIEMALS ein Faktor");
      assert.equal(summary.weights.proposed.filter((p) => p.regime === REGIME_TAG).length, 0);
    });

    // ── monitor: Vorschlag als Audit + Artefakt, ABER keine Gewichtszeilen ──
    await withEnv({ [JOURNAL_ENV.FEEDBACK_MODE]: "monitor", [JOURNAL_ENV.MIN_TRADES]: "5" }, async () => {
      const monRes = await evaluateJournalFeedback();
      assert.equal(monRes.evaluated, true);
      const monChange = monRes.changes.find((c) => c.regime === REGIME_TAG);
      assert.ok(monChange, "monitor: Vorschlag für die Gruppe existiert");
      assert.equal(monChange.from, 1.0, "aktuelles Gewicht 1.0 (keine Zeile)");
      // p_glättet = 7/9 → Ziel = 1 + (7/9 − 0.5) = 1.2777… → Δ=0.1 → 1.1
      assert.ok(Math.abs(monChange.to - 1.1) < 1e-9, `erwartet 1.1, bekam ${monChange.to}`);
      assert.ok(monChange.label.startsWith(labelPrefix), "audit-Label journal-weight:AGENT:REGIME:x→y");

      const audit = await db
        .select()
        .from(auditLog)
        .where(sql`${auditLog.event} = 'JOURNAL_WEIGHT_PROPOSED' AND ${auditLog.detail}->>'label' LIKE ${labelPrefix + "%"}`);
      assert.ok(audit.length >= 1, "monitor: JOURNAL_WEIGHT_PROPOSED im audit_log");

      const weights = await db.select().from(journalAgentWeights).where(eq(journalAgentWeights.regime, REGIME_TAG));
      assert.equal(weights.length, 0, "monitor: journal_agent_weights bleibt UNBERÜHRT");
      const effective = await getEffectiveWeights(REGIME_TAG);
      assert.deepEqual(effective, [], "monitor: keine wirksamen Gewichte im Entscheidungspfad");
    });

    // ── enforce: Persistenz + wirksame Gewichte + schrittweise Annäherung ──
    await withEnv({ [JOURNAL_ENV.FEEDBACK_MODE]: "enforce", [JOURNAL_ENV.MIN_TRADES]: "5" }, async () => {
      const enRes = await evaluateJournalFeedback();
      const enChange = enRes.changes.find((c) => c.regime === REGIME_TAG);
      assert.ok(enChange, "enforce: Änderung für die Gruppe");
      assert.equal(enChange.to, 1.1);

      let [w] = await db.select().from(journalAgentWeights).where(eq(journalAgentWeights.regime, REGIME_TAG));
      assert.ok(w, "enforce: Gewichtszeile persistiert");
      assert.equal(w.agentRole, "RESEARCH");
      assert.ok(Math.abs(Number(w.weight) - 1.1) < 1e-9);
      assert.equal(w.trades, 5);

      const applied = await db
        .select()
        .from(auditLog)
        .where(sql`${auditLog.event} = 'JOURNAL_WEIGHT_APPLIED' AND ${auditLog.detail}->>'label' LIKE ${labelPrefix + "%"}`);
      assert.ok(applied.length >= 1, "enforce: JOURNAL_WEIGHT_APPLIED im audit_log (revisionssicher)");

      // Zyklus 2: 1.1 → 1.2 (schrittweise, nie Sprung auf 1.2777).
      const enRes2 = await evaluateJournalFeedback();
      const enChange2 = enRes2.changes.find((c) => c.regime === REGIME_TAG);
      assert.ok(enChange2, "Zyklus 2: weitere Annäherung");
      assert.equal(enChange2.from, 1.1);
      assert.ok(Math.abs(enChange2.to - 1.2) < 1e-9, `Zyklus 2 → 1.2, bekam ${enChange2.to}`);

      // Wirksame Gewichte NUR im enforce-Modus; Prompt-Format deterministisch.
      const effective = await getEffectiveWeights(REGIME_TAG);
      assert.equal(effective.length, 1);
      assert.equal(effective[0].agent, "RESEARCH");
      assert.ok(Math.abs(effective[0].weight - 1.2) < 1e-9);
      const ctx = formatJournalWeightsContext(effective, REGIME_TAG);
      assert.match(ctx, /RESEARCH: 1\.20/);
      assert.match(ctx, new RegExp(`Regime ${REGIME_TAG}`));
      assert.equal(formatJournalWeightsContext([], REGIME_TAG), "", "leer → keine Prompt-Zeile");
    });

    // enforce → off: wirksame Gewichte verschwinden (Modus-Gate), Zeilen bleiben.
    await withEnv({ [JOURNAL_ENV.FEEDBACK_MODE]: "off" }, async () => {
      const effective = await getEffectiveWeights(REGIME_TAG);
      assert.deepEqual(effective, [], "off: Gewichte wirken NICHT im Entscheidungspfad");
    });
  } finally {
    await cleanup();
  }
});

// ── 6) Quellmuster-Wiring (statisch — Laufzeitpfade sind DB/Netz-kopplung) ─

function srcOf(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

test("Wiring: Engine schreibt Journal auf BEIDEN Eröffnungspfaden + Flatten-Close", () => {
  const s = srcOf("src/lib/engine.ts");
  // Eröffnung (EXECUTOR-Direktpfad + genehmigtes Proposal).
  const snapshotCalls = s.match(/buildProposalSnapshot\(/g) ?? [];
  assert.ok(snapshotCalls.length >= 2, `mindestens 2 Eröffnungspfade bauen den Proposal-Snapshot (${snapshotCalls.length})`);
  const openCalls = s.match(/recordJournalOpen\(/g) ?? [];
  assert.ok(openCalls.length >= 2, `mindestens 2 recordJournalOpen-Aufrufe (${openCalls.length})`);
  // Close: Flatten.
  assert.match(s, /completeJournalRow\(/, "flattenAll schließt die Journal-Zeile");
  // Enforce-Gate im Prompt (off/monitor bleiben prompt-identisch).
  assert.match(s, /JOURNAL_FEEDBACK_MODE === "enforce"/, "Journal-Prompt-Kontext nur im enforce-Modus");
  assert.match(s, /getEffectiveWeights\(/, "wirksame Gewichte aus der Journal-Tabelle");
});

test("Wiring: Mikro-Executor (RULE-Snapshot) und Monitor (Close) verbunden", () => {
  const micro = srcOf("src/lib/microExecutor.ts");
  assert.match(micro, /buildRuleSnapshot\(/, "Mikro-Executor baut den RULE-Snapshot");
  assert.match(micro, /recordJournalOpen\(/, "Mikro-Executor schreibt die Journal-Zeile");
  const monitor = srcOf("src/lib/monitor.ts");
  assert.match(monitor, /completeJournalRow\(/, "Monitor schließt die Journal-Zeile (SL/TP)");
});

test("Wiring: Daily-Cycle schreibt Artefakte; Read-API hinter firm.read", () => {
  const cycle = srcOf("src/cycle/service.ts");
  assert.match(cycle, /evaluateJournalFeedback\(\)/, "Cycle: Feedback-Lauf");
  assert.match(cycle, /journal-feedback\.json/, "Cycle: Feedback-Artefakt");
  assert.match(cycle, /journal-summary\.json/, "Cycle: Summary-Artefakt");
  const route = srcOf("src/app/api/firm/journal/route.ts");
  assert.match(route, /requirePermission\(req, "firm\.read"\)/, "Read-API verlangt firm.read");
  assert.match(route, /computeJournalSummary\(/, "Read-API liefert die Auswertung");
});


