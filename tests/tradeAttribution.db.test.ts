/**
 * Trade-PnL-Attribution — Postgres-Persistenztests (RMA-P1-06, v1.57.0).
 *
 * Deckt die Zusicherungen, die nur die Datenbank geben kann:
 *   - Roundtrip Kopf + Posten (Transaktion, Werte exakt)
 *   - Idempotenz: Retry erzeugt keine zweite Kopf-/Postenzeile
 *     (UNIQUE journal_id + method_version / attribution_id + source_type + source_id)
 *   - Methodenwechsel: neue Methodenversion schreibt NEUE Zeilen, alte
 *     Ergebnisse bleiben unverändert
 *   - Backfill: v1-Snapshots ⇒ UNATTRIBUTABLE (sichtbar, nicht geraten);
 *     wiederholte Läufe sind leer (Restart-Sicherheit)
 *   - API-Aggregate reconciligen gegen die Detailzeilen (Δ ≤ 1e-6) + Coverage
 *   - Produktions-Wiring: completeJournalRow attribuiert beim Close
 *     (ENABLED-Default), Fail-safe bei Disable
 *   - SQL-Migration: idempotent (zweifach) und blockiert UPDATE/DELETE/TRUNCATE
 *     (append-only-Vertrag auf DB-Ebene)
 *
 * Repo-Konvention (wie tests/tradeJournal.test.ts): DB-gated — ohne
 * erreichbare PostgreSQL-Test-DB (npm test DATABASE_URL) überspringt sich die
 * Suite sauber. Symbole/Zeitfenster sind pro Lauf eindeutig, damit parallele
 * Suites sich nicht vermischen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { db } from "../src/db";
import {
  auditLog,
  positions,
  tradeAttributionEntries,
  tradeAttributions,
  tradeJournal,
} from "../src/db/schema";
import { and, eq, sql } from "drizzle-orm";

import { ATTRIBUTION_ENV, loadAttributionConfig } from "../src/attribution/config";
import {
  aggregateTradeAttributions,
  backfillTradeAttributions,
  queryTradeAttributions,
  recordTradeAttribution,
  type RecordAttributionResult,
} from "../src/attribution/store";
import { AttributionError } from "../src/attribution/types";
import { completeJournalRow, recordJournalOpen, type DecisionSnapshot } from "../src/lib/journal";

// ── DB-Gate (Repo-Konvention) ───────────────────────────────────────────────

async function dbReachable(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1 FROM trade_attributions LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

const T0 = new Date("2026-09-01T10:00:00.000Z");

/** v2-Proposal-Snapshot mit richtungsbelegten Stimmen (deterministisch). */
function testSnapshot(): DecisionSnapshot {
  return {
    schemaVersion: 2,
    attribution: "PROPOSAL",
    proposalId: "p-" + randomUUID(),
    ruleId: null,
    votes: [
      {
        name: "ATTR-CEO",
        role: "CEO",
        vote: "TRADE",
        confidence: 0.8,
        riskScore: 0.3,
        at: "2026-09-01T09:50:00.000Z",
        symbol: null,
        side: "LONG",
        model: "test-model",
      },
      {
        name: "ATTR-RISK",
        role: "RISK_MANAGER",
        vote: "TRADE",
        confidence: 0.9,
        riskScore: 0.6,
        at: "2026-09-01T09:59:00.000Z",
        symbol: null,
        side: "SHORT",
        model: "test-model",
      },
    ],
    proposer: { name: "ATTR-CEO", role: "CEO" },
    regime: "NORMAL",
    rationaleHash: "attr-test",
    source: "ENGINE",
    versions: {
      promptVersion: 3,
      agentVersions: { "ATTR-CEO": 3, "ATTR-RISK": 4 },
      ruleVersion: null,
      ruleKey: null,
      policyVersion: "rp1:test",
      dataFingerprint: "df1:test",
    },
    snapshotHash: "js2:test",
  };
}

interface SeededTrade {
  positionId: string;
  journalId: string;
  symbol: string;
}

/** Position + geschlossene Journal-Zeile seeden (unique Symbol pro Lauf). */
async function seedClosedTrade(args: {
  symbol: string;
  snapshot: unknown;
  pnl: number;
  closedAt?: Date;
  fundingPaid?: number;
}): Promise<SeededTrade> {
  const positionId = randomUUID();
  await db.insert(positions).values({
    id: positionId,
    symbol: args.symbol,
    side: "LONG",
    qty: "0.1",
    entryPrice: "100",
    currentPrice: "100",
    exitPrice: "110",
    realizedPnl: String(args.pnl),
    fundingPaid: String(args.fundingPaid ?? 0),
    broker: "PAPER",
    status: "CLOSED",
    exitReason: "TAKE_PROFIT",
  });
  const closedAt = args.closedAt ?? T0;
  const [journal] = await db
    .insert(tradeJournal)
    .values({
      positionId,
      symbol: args.symbol,
      side: "LONG",
      openedAt: new Date(closedAt.getTime() - 3_600_000),
      closedAt,
      missionId: null,
      ruleId: null,
      decisionSnapshot: args.snapshot as object,
      regime: (args.snapshot as { regime?: string })?.regime ?? "UNKNOWN",
      pnl: String(args.pnl),
      exitReason: "TAKE_PROFIT",
      quality: "OK",
    })
    .returning({ id: tradeJournal.id });
  return { positionId, journalId: journal.id, symbol: args.symbol };
}

/**
 * Best-effort-Cleanup: Kinder zuerst (Posten → Köpfe → Journal → Position).
 * Die Append-only-Trigger existieren auf der geteilten Test-DB bewusst NICHT
 * (nie installiert — der Trigger-Test läuft auf einer eigenen Wegwerf-Instanz);
 * die Löschreihenfolge respektiert die FK-Kette.
 */
async function cleanupJournal(positionId: string): Promise<void> {
  for (const fn of [
    () =>
      db.delete(tradeAttributionEntries).where(
        sql`${tradeAttributionEntries.attributionId} IN (SELECT id FROM trade_attributions WHERE position_id = ${positionId})`
      ),
    () => db.delete(tradeAttributions).where(eq(tradeAttributions.positionId, positionId)),
    () => db.delete(tradeJournal).where(eq(tradeJournal.positionId, positionId)),
    () => db.delete(positions).where(eq(positions.id, positionId)),
  ]) {
    try {
      await fn();
    } catch {
      /* FK-Reihenfolge best-effort — Scratch-DB, random UUIDs (Repo-Konvention) */
    }
  }
}

/** Einmaliger Zeitanker pro Lauf: weit in der Vergangenheit, Kollisionssicher gegen parallele/vorherige Läufe. */
function uniquePastDate(): Date {
  const minutes = parseInt(randomUUID().slice(0, 8), 16) % (20 * 365 * 24 * 60); // ≤ 20 Jahre
  return new Date(Date.UTC(1971, 0, 1) + minutes * 60_000);
}

async function recordFor(trade: SeededTrade, overrides: Partial<Parameters<typeof recordTradeAttribution>[0]> = {}) {
  return recordTradeAttribution({
    journalId: trade.journalId,
    positionId: trade.positionId,
    closedAt: T0,
    symbol: trade.symbol,
    side: "LONG",
    regime: "NORMAL",
    grossPnl: 100,
    fees: 5,
    funding: -2,
    snapshot: testSnapshot(),
    ...overrides,
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("Attribution-DB: Roundtrip — Kopf + Posten atomar, Werte exakt, Audit sichtbar", async (t) => {
  if (!(await dbReachable())) {
    t.skip("Keine PostgreSQL erreichbar (trade_attributions) — DB-Test übersprungen (Repo-Konvention)");
    return;
  }
  const symbol = "ATTRT-" + randomUUID().slice(0, 8);
  const trade = await seedClosedTrade({ symbol, snapshot: testSnapshot(), pnl: 100 });
  try {
    const res = await recordFor(trade);
    assert.equal(res.created, true);
    assert.equal(res.status, "ATTRIBUTED");
    assert.equal(res.methodVersion, 1);

    const [header] = await db
      .select()
      .from(tradeAttributions)
      .where(eq(tradeAttributions.id, res.attributionId as string));
    assert.ok(header, "Kopfzeile persistiert");
    assert.equal(header.journalId, trade.journalId);
    assert.equal(header.methodVersion, 1);
    assert.equal(header.status, "ATTRIBUTED");
    assert.equal(Number(header.pnlGross), 100);
    assert.equal(Number(header.fees), 5);
    assert.equal(Number(header.funding), -2);
    assert.equal(Number(header.pnlNet), 93, "Netto = 100 − 5 − 2");
    assert.deepEqual(header.unknownCosts, []);
    assert.equal(header.participants, 2);
    assert.equal(header.abstentions, 0);
    assert.ok(header.snapshotHash.startsWith("js:"), "Snapshot-Fingerprint persistiert");

    const entries = await db
      .select()
      .from(tradeAttributionEntries)
      .where(eq(tradeAttributionEntries.attributionId, header.id));
    // 2 Agenten (CEO +1, RISK −1) + 2 Kosten (FEES, FUNDING)
    assert.equal(entries.length, 4);
    const ceo = entries.find((e) => e.sourceId === "ATTR-CEO");
    const risk = entries.find((e) => e.sourceId === "ATTR-RISK");
    const fees = entries.find((e) => e.sourceId === "FEES");
    const funding = entries.find((e) => e.sourceId === "FUNDING");
    assert.ok(ceo && risk && fees && funding, "ALLE Posten vorhanden");
    assert.equal(ceo.sourceType, "AGENT");
    assert.equal(ceo.sourceVersion, "3", "Promptversion des Agenten");
    assert.equal(ceo.alignment, 1);
    assert.ok(Math.abs(Number(ceo.contribution) - (100 * 0.8) / 1.7) < 1e-6);
    assert.equal(risk.alignment, -1);
    assert.ok(Math.abs(Number(risk.contribution) + (100 * 0.9) / 1.7) < 1e-6);
    assert.equal(fees.sourceType, "COST");
    assert.equal(Number(fees.contribution), -5);
    assert.equal(Number(funding.contribution), -2);
    // Invariante in der DB: Quellen + Kosten + Residual = Netto (± 1e-6).
    const sum =
      entries.reduce((s, e) => s + Number(e.contribution), 0) + Number(header.residual);
    assert.ok(Math.abs(sum - Number(header.pnlNet)) <= 1e-6, `DB-Reconciliation: ${sum}`);

    // Audit-Event sichtbar (JOURNAL_ATTRIBUTED mit Journal-Bezug).
    const audits = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.event, "JOURNAL_ATTRIBUTED"),
          sql`${auditLog.detail} ->> 'journalId' = ${trade.journalId}`
        )
      );
    assert.equal(audits.length, 1, "genau ein Attribution-Audit");
  } finally {
    await cleanupJournal(trade.positionId);
  }
});

test("Attribution-DB: Retry/Restart erzeugt keine zweite Zeile (Idempotenz)", async (t) => {
  if (!(await dbReachable())) {
    t.skip("Keine PostgreSQL erreichbar — DB-Test übersprungen (Repo-Konvention)");
    return;
  }
  const symbol = "ATTRT-" + randomUUID().slice(0, 8);
  const trade = await seedClosedTrade({ symbol, snapshot: testSnapshot(), pnl: 100 });
  try {
    const first: RecordAttributionResult = await recordFor(trade);
    assert.equal(first.created, true);
    const second = await recordFor(trade);
    assert.equal(second.created, false, "Retry schreibt nichts");
    assert.equal(second.duplicate, true);
    assert.equal(second.attributionId, first.attributionId, "liefert die bestehende Zeile");

    const headers = await db
      .select({ id: tradeAttributions.id })
      .from(tradeAttributions)
      .where(eq(tradeAttributions.journalId, trade.journalId));
    assert.equal(headers.length, 1, "genau EINE Kopfzeile");
    const entries = await db
      .select({ id: tradeAttributionEntries.id })
      .from(tradeAttributionEntries)
      .where(eq(tradeAttributionEntries.attributionId, first.attributionId as string));
    assert.equal(entries.length, 4, "genau die 4 Posten — keine Duplikate");
  } finally {
    await cleanupJournal(trade.positionId);
  }
});

test("Attribution-DB: Methodenwechsel schreibt NEUE Zeilen, alte bleiben unverändert", async (t) => {
  if (!(await dbReachable())) {
    t.skip("Keine PostgreSQL erreichbar — DB-Test übersprungen (Repo-Konvention)");
    return;
  }
  const symbol = "ATTRT-" + randomUUID().slice(0, 8);
  const trade = await seedClosedTrade({ symbol, snapshot: testSnapshot(), pnl: 100 });
  try {
    const v1 = await recordFor(trade);
    assert.equal(v1.created, true);
    const [before] = await db
      .select()
      .from(tradeAttributions)
      .where(eq(tradeAttributions.id, v1.attributionId as string));
    const entriesBefore = await db
      .select()
      .from(tradeAttributionEntries)
      .where(eq(tradeAttributionEntries.attributionId, v1.attributionId as string));

    // Simuliert eine KÜNFTIGE Methode ta2: direkte Kopfzeile (der Store lehnt
    // nicht implementierte Versionen fail-closed ab — das ist der nächste Assert).
    await db.insert(tradeAttributions).values({
      journalId: trade.journalId,
      positionId: trade.positionId,
      methodVersion: 2,
      status: "ATTRIBUTED",
      snapshotHash: "js:simulated-ta2",
      snapshotSchemaVersion: 2,
      symbol: trade.symbol,
      side: "LONG",
      regime: "NORMAL",
      closedAt: T0,
      pnlGross: "100",
      fees: "5",
      funding: "-2",
      pnlNet: "93",
      sourcesSum: "50",
      costsSum: "-7",
      residual: "50",
      unknownCosts: [],
      participants: 1,
      abstentions: 0,
    });

    // Store: nicht implementierte Methodenversion ⇒ fail-closed.
    await assert.rejects(
      recordFor(trade, { methodVersion: 2 }),
      (e: unknown) => e instanceof AttributionError && e.code === "unsupported-method-version"
    );

    const [after] = await db
      .select()
      .from(tradeAttributions)
      .where(eq(tradeAttributions.id, v1.attributionId as string));
    const entriesAfter = await db
      .select()
      .from(tradeAttributionEntries)
      .where(eq(tradeAttributionEntries.attributionId, v1.attributionId as string));
    assert.deepEqual(after, before, "v1-Kopfzeile unverändert");
    assert.deepEqual(entriesAfter, entriesBefore, "v1-Posten unverändert");

    const all = await db
      .select({ mv: tradeAttributions.methodVersion })
      .from(tradeAttributions)
      .where(eq(tradeAttributions.journalId, trade.journalId));
    assert.equal(all.length, 2, "beide Methodenversionen koexistieren append-only");

    // Erneuter v1-Record bleibt idempotent (kein Überschreiben durch ta2).
    const again = await recordFor(trade);
    assert.equal(again.duplicate, true);
  } finally {
    await cleanupJournal(trade.positionId);
  }
});

test("Attribution-DB: Backfill — v1-Snapshots UNATTRIBUTABLE, Restart-leer, Dry-Run", async (t) => {
  if (!(await dbReachable())) {
    t.skip("Keine PostgreSQL erreichbar — DB-Test übersprungen (Repo-Konvention)");
    return;
  }
  // Zeitfenster weit in der Vergangenheit + einmalig pro Lauf: Backfill ist
  // idempotent, aber ein fixes Fenster würde unattribuierte Leaks früherer
  // (fehlgeschlagener) Läufe mitzählen. Der einzigartige Anker isoliert.
  const closedAt = uniquePastDate();
  const from = new Date(closedAt.getTime() - 24 * 3_600_000);
  const to = new Date(closedAt.getTime() + 24 * 3_600_000);
  const symbol = "ATTRB-" + randomUUID().slice(0, 8);

  const v1Snapshot = {
    schemaVersion: 1,
    attribution: "PROPOSAL",
    proposalId: "p-old",
    ruleId: null,
    votes: [{ name: "OLD", role: "RESEARCH", vote: "TRADE", confidence: 0.8, riskScore: null, at: "2020-06-15T11:00:00.000Z" }],
    proposer: { name: "OLD-CEO", role: "CEO" },
    regime: "NORMAL",
    rationaleHash: "old",
    source: "ENGINE",
  };
  const legacy = await seedClosedTrade({ symbol, snapshot: v1Snapshot, pnl: 12.5, closedAt });
  const fresh = await seedClosedTrade({ symbol, snapshot: testSnapshot(), pnl: -7.25, closedAt });
  try {
    // Dry-Run: klassifiziert, schreibt nichts.
    const dry = await backfillTradeAttributions({ from, to, dryRun: true, batchLimit: 10 });
    assert.equal(dry.dryRun, true);
    assert.ok(dry.considered >= 2, `mindestens die zwei Seed-Zeilen (war ${dry.considered})`);

    const counts = await backfillTradeAttributions({ from, to, batchLimit: 10 });
    assert.ok(counts.attributed >= 1 && counts.unattributable >= 1, "v2 attribuiert, v1 UNATTRIBUTABLE");

    const [legacyHeader] = await db
      .select()
      .from(tradeAttributions)
      .where(eq(tradeAttributions.journalId, legacy.journalId));
    assert.ok(legacyHeader, "UNATTRIBUTABLE-Zeile ist persistiert (sichtbare Lücke)");
    assert.equal(legacyHeader.status, "UNATTRIBUTABLE");
    assert.equal(legacyHeader.unattributableReason, "SNAPSHOT_SCHEMA_V1");
    assert.equal(legacyHeader.sourcesSum, "0");
    assert.equal(Number(legacyHeader.residual), 12.5, "alles im Residual");
    const legacyEntries = await db
      .select()
      .from(tradeAttributionEntries)
      .where(eq(tradeAttributionEntries.attributionId, legacyHeader.id));
    // KEINE geschätzten Quellen: nur der belegte Funding-Posten (0, aus
    // positions.funding_paid) — keine AGENT-/RULE-Posten erfunden.
    assert.equal(legacyEntries.filter((e) => e.sourceType !== "COST").length, 0, "keine geschätzten Quellen");
    assert.deepEqual(
      legacyEntries.map((e) => e.sourceId),
      ["FUNDING"]
    );

    const [freshHeader] = await db
      .select()
      .from(tradeAttributions)
      .where(eq(tradeAttributions.journalId, fresh.journalId));
    assert.ok(freshHeader, "v2-Zeile attribuiert");
    assert.equal(freshHeader.status, "ATTRIBUTED");

    // Restart-Sicherheit: zweiter Lauf im selben Fenster findet nichts Neues
    // (Idempotenz-Schlüssel schließt bereits attribuierte Zeilen aus).
    const second = await backfillTradeAttributions({ from, to, batchLimit: 10 });
    assert.equal(second.attributed, 0, "keine zweiten Attributionen");
    assert.equal(second.unattributable, 0);
  } finally {
    await cleanupJournal(legacy.positionId);
    await cleanupJournal(fresh.positionId);
  }
});

test("Attribution-DB: Aggregate reconciligen gegen Details; Coverage & Filter", async (t) => {
  if (!(await dbReachable())) {
    t.skip("Keine PostgreSQL erreichbar — DB-Test übersprungen (Repo-Konvention)");
    return;
  }
  const symbol = "ATTRA-" + randomUUID().slice(0, 8);
  // Einmaliges Zeitfenster pro Lauf: Die Coverage zählt ALLE geschlossenen
  // Journal-Zeilen im Fenster (Semantik wie journalAnalytics) — ein fixes
  // Fenster würde Zeilen früherer Läufe mitzählen. Der einzigartige Anker
  // isoliert den Lauf deterministisch.
  const anchor = uniquePastDate();
  const from = new Date(anchor.getTime() - 24 * 3_600_000);
  const to = new Date(anchor.getTime() + 24 * 3_600_000);
  const closedAt = anchor;

  const trades: SeededTrade[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const trade = await seedClosedTrade({
        symbol,
        snapshot: testSnapshot(),
        pnl: i === 0 ? 100 : -40,
        closedAt,
      });
      trades.push(trade);
      const res = await recordFor(trade, { grossPnl: i === 0 ? 100 : -40, closedAt });
      assert.equal(res.status, "ATTRIBUTED");
    }
    // Eine dritte, UNATTRIBUTABLE Zeile (v1-Snapshot) für die Coverage-Quote.
    const legacySnapshot = {
      schemaVersion: 1,
      attribution: "PROPOSAL",
      proposalId: null,
      ruleId: null,
      votes: [],
      proposer: null,
      regime: "NORMAL",
      rationaleHash: "x",
      source: "ENGINE",
    };
    const legacy = await seedClosedTrade({
      symbol,
      snapshot: legacySnapshot,
      pnl: 7,
      closedAt,
    });
    trades.push(legacy);
    const legacyRes = await recordFor(legacy, {
      grossPnl: 7,
      closedAt,
      snapshot: legacySnapshot,
      fees: null,
      funding: 0,
    });
    assert.equal(legacyRes.status, "UNATTRIBUTABLE");

    const filter = { symbol, from, to };
    const detail = await queryTradeAttributions(filter, 200, true);
    assert.equal(detail.rows.length, 3, "drei Attributionen im Fenster");
    assert.equal(detail.truncated, false);
    const detailNet = detail.rows.reduce((s, r) => s + r.pnlNet, 0);
    const detailResidual = detail.rows.reduce((s, r) => s + r.residual, 0);
    const detailCosts = detail.rows.reduce((s, r) => s + r.costsSum, 0);
    const detailSources = detail.rows.reduce((s, r) => s + r.sourcesSum, 0);

    const agg = await aggregateTradeAttributions("agent", filter);
    assert.equal(agg.totals.attributions, 3);
    assert.equal(agg.totals.attributed, 2);
    assert.equal(agg.totals.unattributable, 1);
    assert.ok(Math.abs(agg.totals.netSum - detailNet) < 1e-6, "Aggregat-Netto == Detail-Netto");
    assert.ok(Math.abs(agg.totals.residualSum - detailResidual) < 1e-6);
    assert.ok(Math.abs(agg.totals.costsSum - detailCosts) < 1e-6);
    assert.ok(Math.abs(agg.totals.sourcesSum - detailSources) < 1e-6);
    assert.equal(agg.reconciliation.ok, true, "Reconciliation serverseitig geprüft");
    assert.ok(Math.abs(agg.reconciliation.delta) <= 1e-6);
    // Agent-Gruppen: CEO (2 Trades), RISK (2 Trades).
    const ceo = agg.groups.find((g) => g.key === "ATTR-CEO");
    const risk = agg.groups.find((g) => g.key === "ATTR-RISK");
    assert.ok(ceo && risk, "beide Agenten gruppiert");
    assert.equal(ceo.trades, 2);
    const groupSum = agg.groups.reduce((s, g) => s + g.contributionSum, 0);
    assert.ok(Math.abs(groupSum - detailSources) < 1e-6, "Σ Gruppenbeiträge == Σ Detail-Quellen");

    // Coverage: 3 geschlossene Journal-Zeilen im Fenster, 2 attribuiert.
    assert.equal(agg.coverage.closedTrades, 3);
    assert.equal(agg.coverage.attributedTrades, 2);
    assert.ok(Math.abs((agg.coverage.share as number) - 2 / 3) < 1e-9);

    // Kosten-Dimension: FEES/FUNDING Posten aggregieren auf die Kostensumme.
    // (2 attribuierte Trades mit fees 5/funding −2; die UNATTRIBUTABLE-Zeile
    // hat fees=null und funding=0 aus positions.funding_paid.)
    const costAgg = await aggregateTradeAttributions("cost", filter);
    const feesGroup = costAgg.groups.find((g) => g.key === "FEES");
    const fundingGroup = costAgg.groups.find((g) => g.key === "FUNDING");
    assert.ok(feesGroup && fundingGroup);
    assert.ok(Math.abs(feesGroup.contributionSum - -10) < 1e-6, "2 × (−5) Gebühren");
    assert.ok(Math.abs(fundingGroup.contributionSum - -4) < 1e-6, "2 × (−2) + 1 × 0 Funding");

    // Regime-Dimension und Status-Filter.
    const regimeAgg = await aggregateTradeAttributions("regime", filter);
    assert.ok(regimeAgg.groups.some((g) => g.key === "NORMAL"));
    const onlyUnattr = await queryTradeAttributions({ ...filter, status: "UNATTRIBUTABLE" }, 200, false);
    assert.equal(onlyUnattr.rows.length, 1);
    assert.equal(onlyUnattr.rows[0].unattributableReason, "SNAPSHOT_SCHEMA_V1");

    // Limit/Truncation.
    const limited = await queryTradeAttributions(filter, 2, false);
    assert.equal(limited.rows.length, 2);
    assert.equal(limited.truncated, true, "Grenze erreicht wird laut markiert");
  } finally {
    for (const trade of trades) await cleanupJournal(trade.positionId);
  }
});

test("Attribution-DB: completeJournalRow attribuiert beim Close (Wiring + Disable-Flag)", async (t) => {
  if (!(await dbReachable())) {
    t.skip("Keine PostgreSQL erreichbar — DB-Test übersprungen (Repo-Konvention)");
    return;
  }
  assert.equal(loadAttributionConfig().enabled, true, "Default: Attribution aktiv (additiv)");

  // (a) Aktiv: Close erzeugt die Attribution aus dem Entry-Snapshot + Funding
  //     aus positions.funding_paid; Gebühren bleiben unbekannt (Paper-Pfad).
  const symbol = "ATTRW-" + randomUUID().slice(0, 8);
  const positionId = randomUUID();
  await db.insert(positions).values({
    id: positionId,
    symbol,
    side: "LONG",
    qty: "0.1",
    entryPrice: "100",
    currentPrice: "100",
    fundingPaid: "-1.5",
    broker: "PAPER",
    status: "OPEN",
  });
  await recordJournalOpen({
    positionId,
    symbol,
    side: "LONG",
    openedAt: T0,
    missionId: null,
    ruleId: null,
    snapshot: testSnapshot(),
  });
  try {
    const close = await completeJournalRow({
      positionId,
      symbol,
      side: "LONG",
      openedAt: T0,
      entryPrice: 100,
      exitPrice: 125,
      realizedPnl: 25,
      exitReason: "TAKE_PROFIT",
      closedAt: new Date(T0.getTime() + 3_600_000),
      missionId: null,
      ruleId: null,
      candles: [],
    });
    assert.equal(close.closed, true);
    assert.ok(close.attribution, "Close-Ergebnis trägt die Attribution");
    assert.equal(close.attribution?.status, "ATTRIBUTED");
    assert.equal(close.attribution?.methodVersion, 1);

    const [header] = await db
      .select()
      .from(tradeAttributions)
      .where(eq(tradeAttributions.positionId, positionId));
    assert.ok(header, "Kopfzeile beim Close geschrieben");
    // Netto = 25 (Brutto) − 0 (Gebühren unbekannt) + (−1.5) (Funding) = 23.5.
    assert.equal(Number(header.pnlNet), 23.5);
    assert.deepEqual(header.unknownCosts, ["FEES"], "Gebühren im Paper-Pfad unbekannt, sichtbar");
    const entries = await db
      .select()
      .from(tradeAttributionEntries)
      .where(eq(tradeAttributionEntries.attributionId, header.id));
    const funding = entries.find((e) => e.sourceId === "FUNDING");
    assert.ok(funding, "Funding-Posten aus positions.funding_paid");
    assert.equal(Number(funding.contribution), -1.5);

    // Erneuter Close (Doppel-Tick): idempotent, keine zweite Zeile.
    const again = await completeJournalRow({
      positionId,
      symbol,
      side: "LONG",
      openedAt: T0,
      entryPrice: 100,
      exitPrice: 125,
      realizedPnl: 25,
      exitReason: "TAKE_PROFIT",
      closedAt: new Date(T0.getTime() + 3_600_000),
      missionId: null,
      ruleId: null,
      candles: [],
    });
    assert.equal(again.attribution?.status, "ATTRIBUTED");
    const count = await db
      .select({ id: tradeAttributions.id })
      .from(tradeAttributions)
      .where(eq(tradeAttributions.positionId, positionId));
    assert.equal(count.length, 1, "keine zweite Attribution beim Doppel-Close");
  } finally {
    await cleanupJournal(positionId);
  }

  // (b) Deaktiviert: kein Write, Close bleibt vollständig funktionsfähig.
  const prev = process.env[ATTRIBUTION_ENV.ENABLED];
  process.env[ATTRIBUTION_ENV.ENABLED] = "false";
  try {
    const symbol2 = "ATTRW-" + randomUUID().slice(0, 8);
    const positionId2 = randomUUID();
    await db.insert(positions).values({
      id: positionId2,
      symbol: symbol2,
      side: "LONG",
      qty: "0.1",
      entryPrice: "100",
      currentPrice: "100",
      broker: "PAPER",
      status: "OPEN",
    });
    await recordJournalOpen({
      positionId: positionId2,
      symbol: symbol2,
      side: "LONG",
      openedAt: T0,
      missionId: null,
      ruleId: null,
      snapshot: testSnapshot(),
    });
    try {
      const close = await completeJournalRow({
        positionId: positionId2,
        symbol: symbol2,
        side: "LONG",
        openedAt: T0,
        entryPrice: 100,
        exitPrice: 90,
        realizedPnl: -10,
        exitReason: "STOP_LOSS",
        closedAt: new Date(T0.getTime() + 3_600_000),
        missionId: null,
        ruleId: null,
        candles: [],
      });
      assert.equal(close.closed, true, "Close funktioniert weiter");
      assert.equal(close.attribution, undefined, "Attribution deaktiviert ⇒ kein Ergebnis");
      const rows = await db
        .select({ id: tradeAttributions.id })
        .from(tradeAttributions)
        .where(eq(tradeAttributions.positionId, positionId2));
      assert.equal(rows.length, 0, "keine Zeile geschrieben");
    } finally {
      await cleanupJournal(positionId2);
    }
  } finally {
    if (prev === undefined) delete process.env[ATTRIBUTION_ENV.ENABLED];
    else process.env[ATTRIBUTION_ENV.ENABLED] = prev;
  }
});

test("Attribution-Migration: idempotent + Append-only-Trigger (eigene Wegwerf-Postgres)", async (t) => {
  // Die Unveränderlichkeits-Trigger dürfen die geteilte npm-test-DB NICHT
  // dauerhaft installieren (sie würde die Cleanups aller Journal-Suiten
  // blockieren). Deshalb läuft dieser Test — wie die Forecast-Ledger-DB-Suite
  // — auf einer eigenen, wegwerfbaren embedded-postgres-Instanz mit einem
  // minimalen trade_journal-Ständer für den FK. Skip statt Rot nur bei
  // Startproblemen; Assertions selbst schlagen laut fehl.
  const { createServer } = await import("node:net");
  const findPort = async (candidates: number[]): Promise<number | null> => {
    for (const port of candidates) {
      const free = await new Promise<boolean>((resolve) => {
        const s = createServer();
        s.once("error", () => resolve(false));
        s.once("listening", () => s.close(() => resolve(true)));
        s.listen(port, "127.0.0.1");
      });
      if (free) return port;
    }
    return null;
  };
  const port = await findPort([55_435, 55_436, 55_437, 55_438, 55_439]);
  if (port === null) {
    t.skip("kein freier Port für die Wegwerf-Postgres");
    return;
  }

  // ── Startphase (Fehler ⇒ sauberer Skip) ─────────────────────────────────
  type Started = {
    pg: import("embedded-postgres").default;
    pool: import("pg").Pool;
    attributionId: string;
  };
  let started: Started | null = null;
  try {
    const EmbeddedPostgres = (await import("embedded-postgres")).default;
    const dir = (await import("node:fs")).mkdtempSync(
      (await import("node:os")).tmpdir() + "/attribution-pg-"
    );
    const instance = new EmbeddedPostgres({
      databaseDir: dir,
      user: "postgres",
      password: "postgres",
      port,
      persistent: false,
    });
    await instance.initialise();
    await instance.start();
    await instance.createDatabase("attribution_test");
    const localPool = new (await import("pg")).Pool({
      host: "127.0.0.1",
      port,
      user: "postgres",
      password: "postgres",
      database: "attribution_test",
      max: 4,
    });
    // Minimaler trade_journal-Ständer (FK-Ziel; Produktions-Schema entsteht
    // per drizzle push — hier zählt nur der Migrationsvertrag selbst).
    await localPool.query(`
      CREATE TABLE trade_journal (
        id uuid PRIMARY KEY,
        position_id uuid NOT NULL,
        symbol text NOT NULL,
        side text NOT NULL,
        regime text NOT NULL,
        closed_at timestamptz,
        pnl numeric,
        decision_snapshot jsonb NOT NULL
      )
    `);
    const migration = readFileSync(
      resolve(process.cwd(), "drizzle/2026-09-21_trade_attribution.sql"),
      "utf8"
    );
    // Migration zweifach anwenden (idempotent — Produktionspfad psql).
    await localPool.query(migration);
    await localPool.query(migration);

    // Zeile anlegen (rohes SQL — kein Drizzle-Setup nötig).
    const journalId = randomUUID();
    const positionId = randomUUID();
    await localPool.query(
      `INSERT INTO trade_journal (id, position_id, symbol, side, regime, closed_at, pnl, decision_snapshot)
       VALUES ($1, $2, 'BTC', 'LONG', 'NORMAL', now(), 5, '{}')`,
      [journalId, positionId]
    );
    const inserted = await localPool.query(
      `INSERT INTO trade_attributions (journal_id, position_id, method_version, status, snapshot_hash,
        snapshot_schema_version, symbol, side, regime, closed_at, pnl_gross, fees, funding, pnl_net,
        sources_sum, costs_sum, residual, unknown_costs, participants, abstentions)
       VALUES ($1, $2, 1, 'ATTRIBUTED', 'js:x', 2, 'BTC', 'LONG', 'NORMAL', now(), 5, 0, 0, 5, 5, 0, 0, '{}', 1, 0)
       RETURNING id`,
      [journalId, positionId]
    );
    const attributionId = inserted.rows[0].id as string;
    await localPool.query(
      `INSERT INTO trade_attribution_entries (attribution_id, source_type, source_id, source_version, role, alignment, weight, contribution)
       VALUES ($1, 'COST', 'FEES', 'ta1', NULL, 0, NULL, 0)`,
      [attributionId]
    );
    started = { pg: instance, pool: localPool, attributionId };
  } catch (e) {
    t.skip(
      `eingebettete Postgres nicht verfügbar: ${e instanceof Error ? e.message : String(e)}`
    );
    return;
  }

  // ── Assertions (Fehler schlagen laut, kein Skip) ────────────────────────
  const { pg, pool, attributionId } = started;
  try {
    // UPDATE/DELETE werden von den Triggern abgelehnt.
    await assert.rejects(
      pool.query("UPDATE trade_attributions SET residual = 999 WHERE id = $1", [attributionId]),
      (e: unknown) => /append-only/i.test(e instanceof Error ? e.message : String(e))
    );
    await assert.rejects(
      pool.query("DELETE FROM trade_attributions WHERE id = $1", [attributionId]),
      (e: unknown) => /append-only/i.test(e instanceof Error ? e.message : String(e))
    );
    await assert.rejects(
      pool.query(
        "UPDATE trade_attribution_entries SET contribution = 1 WHERE attribution_id = $1",
        [attributionId]
      ),
      (e: unknown) => /append-only/i.test(e instanceof Error ? e.message : String(e))
    );
    await assert.rejects(
      pool.query("DELETE FROM trade_attribution_entries WHERE attribution_id = $1", [attributionId]),
      (e: unknown) => /append-only/i.test(e instanceof Error ? e.message : String(e))
    );
    // TRUNCATE: Beide Tabellen gemeinsam, damit die FK-Prüfung besteht und
    // der TRIGGER der Grund der Ablehnung ist (einzelnes TRUNCATE würde
    // vorher schon am FK scheitern — auch sicher, aber nicht Trigger-Beweis).
    await assert.rejects(
      pool.query("TRUNCATE TABLE trade_attributions, trade_attribution_entries"),
      (e: unknown) => /append-only/i.test(e instanceof Error ? e.message : String(e))
    );

    // Zeile unangetastet.
    const header = await pool.query(
      "SELECT pnl_gross::float8 AS g FROM trade_attributions WHERE id = $1",
      [attributionId]
    );
    assert.equal(header.rows[0].g, 5);
  } finally {
    await pool.end().catch(() => undefined);
    await pg.stop().catch(() => undefined);
  }
});
