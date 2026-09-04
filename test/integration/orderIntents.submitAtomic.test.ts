/**
 * H2 (order_intents atomare Reservierung) — Integrationstest.
 *
 * Ziel des Audit-Fundes: "Nicht-atomare Risk-/Positionsprüfung über mehrere
 * Prozesse". Zwei unabhängige `PaperBroker`-Instanzen (jede simuliert einen
 * eigenen Node.js-Prozess mit eigenem In-Memory-Zustand — genau der
 * Angriffsfall aus dem Audit, bei dem der In-Memory-Guard eines einzelnen
 * Prozesses keine Sichtbarkeit auf die Reservierung eines anderen Prozesses
 * hat) senden gleichzeitig `submitAtomic()` für DASSELBE Symbol. Ohne die
 * DB-seitige Reservierung (order_intents, partieller UNIQUE-Index) würden
 * BEIDE Prozesse ihre lokale Guard-Prüfung bestehen (jeder sieht "keine
 * offene Position") und beide einen Fill verbuchen — das ist exakt der Bug.
 *
 * Verhält sich wie `tests/controlPlane.persistence.test.ts`: pingt die DB
 * zuerst; ist keine PostgreSQL erreichbar (CI/Sandbox ohne DB), wird der
 * Test übersprungen statt fehlzuschlagen — DB-Tests dürfen laut
 * Repo-Konvention nie eine lokale DB voraussetzen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db } from "../../src/db";
import { orderIntents, positions } from "../../src/db/schema";
import { sql, eq, and } from "drizzle-orm";
import { PaperBroker, OrderIntentConflictError, type Fill, type Tx } from "../../src/lib/broker";
import { killSwitch, resetRuntimeLimits } from "../../src/lib/riskGuard";

/**
 * Persistiert den Fill in `positions`, wie es die echten Aufrufer
 * (Engine, Mikro-Executor) über den `persistPosition`-Callback von
 * `submitAtomic` tun. Ohne diesen Schritt bliebe `positions` leer und der
 * DB-Wahrheits-Check in `submitAtomic` (Schritt 2, siehe `src/lib/broker.ts`)
 * hätte nichts zu sehen — genau der Callback, den jeder Produktionsaufrufer
 * bereitstellen MUSS, damit H2 wirkt.
 */
async function persistPositionForTest(broker: string, tx: Tx, fill: Fill) {
  await tx.insert(positions).values({
    symbol: fill.symbol,
    side: fill.side,
    qty: String(fill.qty),
    entryPrice: String(fill.fillPrice),
    currentPrice: String(fill.fillPrice),
    stopLoss: fill.stopLoss === null ? null : String(fill.stopLoss),
    takeProfit: fill.takeProfit === null ? null : String(fill.takeProfit),
    broker,
    status: "OPEN",
  });
}

async function dbReachable(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1 FROM order_intents LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

function order(overrides: Partial<{
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  riskNotional: number;
  stopLoss: number;
  takeProfit: number;
}> = {}) {
  // BTC 67000 * 0.015 ≈ 1005 < 2500 (25% von 10k Startkapital) — passiert den Guard.
  return {
    symbol: "BTC",
    side: "LONG" as const,
    qty: 0.015,
    riskNotional: 1005,
    stopLoss: 60000,
    takeProfit: 70000,
    ...overrides,
  };
}

test("H2: zwei Prozesse (zwei PaperBroker-Instanzen) racen auf dasselbe Symbol — nur EIN Fill, DB entscheidet", async (t) => {
  resetRuntimeLimits();
  killSwitch.disarm();

  if (!(await dbReachable())) {
    t.skip("Keine PostgreSQL erreichbar (order_intents) — DB-Test übersprungen (Repo-Konvention)");
    return;
  }

  // Eindeutiges Symbol pro Testlauf: verhindert Interferenz mit anderen
  // (parallel laufenden) Tests/Läufen, die denselben partiellen UNIQUE-Index
  // treffen könnten. Ein synthetisches, aber gültiges Symbol ist genug, weil
  // `submitAtomic` nur eine Kursquelle braucht (STATIC_PRICES-Fallback via BTC-Alias reicht nicht,
  // also nutzen wir das reale BTC-Symbol und säubern danach explizit).
  const account = `TEST_${randomUUID().slice(0, 8)}`;

  // Sicherstellen, dass keine Altlast aus einem abgebrochenen Vorlauf existiert.
  await db.delete(orderIntents).where(eq(orderIntents.account, account));
  await db
    .delete(orderIntents)
    .where(sql`${orderIntents.symbol} = 'BTC' AND ${orderIntents.status} = 'RESERVED'`);
  await db.delete(positions).where(eq(positions.symbol, "BTC"));

  try {
    // Zwei UNABHÄNGIGE Broker-Instanzen = zwei Prozess-Speicher. Jede startet
    // mit demselben Kapital und OHNE Kenntnis der jeweils anderen — simuliert
    // exakt den Multi-Prozess-Fall aus dem Audit. `persistPosition` schreibt
    // in dieselbe Tabelle, die Schritt 2 von `submitAtomic` als DB-Wahrheit
    // abfragt (siehe `src/lib/broker.ts`) — ohne das wäre dieser Test ein
    // Blindflug (kein anderer Prozess hätte je etwas Sichtbares committet).
    const brokerA = new PaperBroker(10_000);
    const brokerB = new PaperBroker(10_000);

    const [fillA, fillB] = await Promise.all([
      brokerA.submitAtomic(order(), {
        account,
        persistPosition: (tx, fill) => persistPositionForTest(brokerA.name, tx, fill),
      }),
      brokerB.submitAtomic(order(), {
        account,
        persistPosition: (tx, fill) => persistPositionForTest(brokerB.name, tx, fill),
      }),
    ]);

    const fills = [fillA, fillB];
    const filled = fills.filter((f) => f.status === "FILLED");
    const rejected = fills.filter((f) => f.status !== "FILLED");

    assert.equal(filled.length, 1, `Genau ein Fill erwartet, bekam: ${JSON.stringify(fills)}`);
    assert.equal(rejected.length, 1, `Genau eine Ablehnung erwartet, bekam: ${JSON.stringify(fills)}`);
    assert.ok(
      rejected[0].reason?.includes("POSITION_ALREADY_OPEN"),
      `Ablehnungsgrund sollte POSITION_ALREADY_OPEN sein, war: ${rejected[0].reason}`
    );

    // Die DB muss GENAU eine order_intents-Zeile mit Status FILLED für dieses
    // Konto/Symbol zeigen — die DB ist die Quelle der Wahrheit (H2-Kern).
    const rows = await db
      .select()
      .from(orderIntents)
      .where(eq(orderIntents.account, account));
    const filledRows = rows.filter((r) => r.status === "FILLED");
    const rejectedRows = rows.filter((r) => r.status === "REJECTED");
    assert.equal(filledRows.length, 1, `Genau eine FILLED-Zeile in der DB erwartet: ${JSON.stringify(rows)}`);
    assert.ok(rejectedRows.length >= 1, `Mindestens eine REJECTED-Audit-Zeile erwartet: ${JSON.stringify(rows)}`);

    // Der Broker, dessen In-Memory-Guard "FILLED" sagte, aber dessen DB-Reservierung
    // verlor, muss die In-Memory-Mutation zurückgenommen haben (kein Phantom-Bestand).
    const winner = fillA.status === "FILLED" ? brokerA : brokerB;
    const loser = fillA.status === "FILLED" ? brokerB : brokerA;
    assert.equal(winner.openPositions, 1, "Gewinner-Broker zeigt die reservierte Position");
    assert.equal(
      loser.openPositions,
      0,
      "Verlierer-Broker darf KEINE Phantom-Position im Speicher behalten (Rollback bei DB-Konflikt)"
    );
    assert.equal(loser.freeCash, 10_000, "Verlierer-Broker muss das reservierte Cash zurückerhalten haben");

    // Auch die DB darf nur EINE offene BTC-Position zeigen — kein doppeltes
    // `persistPosition` durch den Verlierer.
    const openPositions = await db
      .select()
      .from(positions)
      .where(and(eq(positions.symbol, "BTC"), eq(positions.status, "OPEN")));
    assert.equal(openPositions.length, 1, `Genau eine offene BTC-Position erwartet: ${JSON.stringify(openPositions)}`);
  } finally {
    await db.delete(orderIntents).where(eq(orderIntents.account, account));
    await db.delete(positions).where(eq(positions.symbol, "BTC"));
  }
});

test("H2: Guard-Ablehnung (kein Cash/keine offene Reservierung) schreibt REJECTED ohne Reservierungs-Race", async (t) => {
  resetRuntimeLimits();
  killSwitch.disarm();

  if (!(await dbReachable())) {
    t.skip("Keine PostgreSQL erreichbar (order_intents) — DB-Test übersprungen (Repo-Konvention)");
    return;
  }

  const account = `TEST_${randomUUID().slice(0, 8)}`;
  await db.delete(orderIntents).where(eq(orderIntents.account, account));

  try {
    const broker = new PaperBroker(10_000);
    // Kill-Switch aktiv → submit() lehnt VOR jeder Reservierung ab.
    killSwitch.pull("h2-test");
    const fill = await broker.submitAtomic(order(), { account });
    killSwitch.disarm();

    assert.equal(fill.status, "REJECTED");
    assert.equal(fill.reason, "KILL_SWITCH_ARMED");

    const rows = await db.select().from(orderIntents).where(eq(orderIntents.account, account));
    assert.equal(rows.length, 1, "Genau eine Audit-Zeile für die abgelehnte Order");
    assert.equal(rows[0].status, "REJECTED");
    assert.equal(rows[0].reason, "KILL_SWITCH_ARMED");
  } finally {
    killSwitch.disarm();
    await db.delete(orderIntents).where(eq(orderIntents.account, account));
  }
});

test("H2: withAccountLock serialisiert zwei Aufrufe auf dasselbe Konto (kein Interleaving)", async (t) => {
  if (!(await dbReachable())) {
    t.skip("Keine PostgreSQL erreichbar (order_intents) — DB-Test übersprungen (Repo-Konvention)");
    return;
  }

  const { withAccountLock } = await import("../../src/lib/broker");
  const account = `TEST_LOCK_${randomUUID().slice(0, 8)}`;
  const events: string[] = [];

  const first = withAccountLock(account, async () => {
    events.push("first:start");
    await new Promise((r) => setTimeout(r, 150));
    events.push("first:end");
  });
  // Kurze Verzögerung, damit `first` garantiert zuerst die Sperre nimmt.
  await new Promise((r) => setTimeout(r, 20));
  const second = withAccountLock(account, async () => {
    events.push("second:start");
    events.push("second:end");
  });

  await Promise.all([first, second]);

  // Ohne Serialisierung könnte "second:start" zwischen "first:start" und
  // "first:end" landen. Mit dem Advisory-Lock muss "first:end" IMMER vor
  // "second:start" liegen.
  const firstEndIdx = events.indexOf("first:end");
  const secondStartIdx = events.indexOf("second:start");
  assert.ok(firstEndIdx < secondStartIdx, `Erwartete Serialisierung, bekam: ${events.join(",")}`);
});

void OrderIntentConflictError; // Re-Export-Kompatibilität wird durch den Broker-Import geprüft (tsc).
