/**
 * B2 — Positionsseite vom Venue: validieren statt raten.
 *
 * Alter Zustand: `getPositions()` bildete JEDEN von "SHORT" verschiedenen
 * `side`-Rohwert (auch "", null, "WEIRD") auf "LONG" ab — eine korrumpierte
 * Antwort war damit unsichtbar und eine Short-Position erschien im lokalen View
 * als Long (falsches uPnL-Vorzeichen, falsche SL/TP-Geometrie, falsche
 * Seitenlogik).
 *
 * Acceptance (audit-remediation/B2-side-fallback.md):
 *   - `side=""` / `side="WEIRD"` / fehlende Seite → Zeile wird verworfen,
 *     NICHT als LONG gemappt, und wird gezählt (Audit-Ring + Zähler + Log).
 *   - legitime `LONG`/`SHORT`-Zeilen bleiben unverändert erhalten.
 *   - geschlossene/0-qty-Zeilen (vom Venue oft ohne `side`) scheiden bereits
 *     über die `qty`-Prüfung aus und zählen deshalb NICHT als Anomalie.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { BitunixFixtureServer } from "./fixtures/bitunixFixtureServer";
import { loadBitunixConfig } from "../src/brokers/bitunix/config";
import {
  BitunixPrivateClient,
  parseBitunixPositionSide,
} from "../src/brokers/bitunix/privateClient";
import {
  clearBitunixPositionAnomaliesForTests,
  readBitunixPositionAnomalies,
  readBitunixPositionAnomalyCount,
} from "../src/brokers/bitunix/audit";

const servers: BitunixFixtureServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.stop()));
});

interface Harness {
  client: BitunixPrivateClient;
  fx: BitunixFixtureServer;
  warnings: string[];
}

/**
 * Hermetischer Client gegen den Fixture-Server mit frei wählbaren
 * Positions-Zeilen. Der Logger wird abgefangen, damit die B2-Warnung prüfbar
 * ist (und nichts auf der echten Konsole landet).
 */
async function started(positionRows: Record<string, unknown>[] | null): Promise<Harness> {
  const fx = new BitunixFixtureServer();
  fx.positionRows = positionRows;
  const base = await fx.start();
  servers.push(fx);
  const warnings: string[] = [];
  const client = new BitunixPrivateClient({
    config: loadBitunixConfig({
      BITUNIX_ENABLED: "true",
      BITUNIX_ALLOW_INSECURE_HTTP: "true",
      BITUNIX_BASE_URL: base,
      BITUNIX_RETRY_MAX: "1",
    }),
    credentials: { apiKey: fx.apiKey, apiSecret: fx.apiSecret },
    logger: {
      info: () => {},
      warn: (m) => warnings.push(m),
      error: (m) => warnings.push(m),
    },
  });
  return { client, fx, warnings };
}

const row = (over: Record<string, unknown>): Record<string, unknown> => ({
  symbol: "BTCUSDT",
  qty: "0.01",
  side: "LONG",
  avgOpenPrice: "65000",
  unrealizedPNL: "12.5",
  ...over,
});

// ---------------------------------------------------------------------------
// 1) Pure Unit-Validierung der Seiten-Normalisierung
// ---------------------------------------------------------------------------

test("B2: parseBitunixPositionSide akzeptiert nur LONG/SHORT (case-/whitespace-tolerant)", () => {
  assert.equal(parseBitunixPositionSide("LONG"), "LONG");
  assert.equal(parseBitunixPositionSide("SHORT"), "SHORT");
  assert.equal(parseBitunixPositionSide(" short "), "SHORT");
  assert.equal(parseBitunixPositionSide("Long"), "LONG");
});

test("B2: parseBitunixPositionSide rät nicht — leer/null/Müll → null", () => {
  for (const bad of ["", "   ", null, undefined, "WEIRD", "0", "both", "N/A"]) {
    assert.equal(parseBitunixPositionSide(bad), null, `side=${JSON.stringify(bad)} darf keine Richtung haben`);
  }
  // Order-seitige Rohwerte (BUY/SELL) gehören NICHT in die Positionsantwort;
  // sie sind hier ebenfalls kein LONG/SHORT-Beweis.
  assert.equal(parseBitunixPositionSide("BUY"), null);
  assert.equal(parseBitunixPositionSide("SELL"), null);
});

// ---------------------------------------------------------------------------
// 2) Venue-Pfad: unbekannte Seiten werden verworfen und gezählt
// ---------------------------------------------------------------------------

test("B2: side=\"\" / \"WEIRD\" / fehlende side → verworfen (kein LONG), LONG/SHORT bleiben", async () => {
  clearBitunixPositionAnomaliesForTests();
  const { client } = await started([
    row({ symbol: "BTCUSDT", side: "LONG" }),
    row({ symbol: "ETHUSDT", side: "SHORT", qty: "0.5", avgOpenPrice: "3200", unrealizedPNL: "-20" }),
    row({ symbol: "SOLUSDT", side: "" }),
    row({ symbol: "XRPUSDT", side: "WEIRD" }),
    { symbol: "ADAUSDT", qty: "2", avgOpenPrice: "0.8", unrealizedPNL: "1" },
  ]);

  const positions = await client.getPositions();

  assert.equal(positions.length, 2, "nur die beiden Zeilen mit verwertbarer Seite");
  assert.deepEqual(
    positions.map((p) => [p.symbol, p.side]),
    [
      ["BTCUSDT", "LONG"],
      ["ETHUSDT", "SHORT"],
    ],
    "legitime LONG/SHORT-Zeilen bleiben unverändert erhalten"
  );
  const short = positions[1]!;
  assert.equal(short.qty, 0.5);
  assert.equal(short.entryPrice, 3200);
  assert.equal(short.unrealizedPnl, -20, "uPnL einer echten SHORT-Position bleibt negativ");

  // Zähler/Ring: 3 verworfene Zeilen (leer, Müll, fehlend) — die guten nicht.
  assert.equal(readBitunixPositionAnomalyCount(), 3, "jede unbekannte Seite zählt");
  const anomalies = readBitunixPositionAnomalies(10);
  assert.equal(anomalies.length, 3);
  assert.deepEqual(
    anomalies.map((a) => a.symbol).sort(),
    ["ADAUSDT", "SOLUSDT", "XRPUSDT"],
    "betroffene Symbole sind im Audit erkennbar"
  );
  assert.ok(anomalies.every((a) => a.reason === "UNKNOWN_SIDE"));
});

test("B2: Verwerfung wird laut dokumentiert (Warnung pro Call, mit Anzahl)", async () => {
  clearBitunixPositionAnomaliesForTests();
  const { client, warnings } = await started([
    row({ symbol: "BTCUSDT", side: "LONG" }),
    row({ symbol: "SOLUSDT", side: "" }),
    row({ symbol: "XRPUSDT", side: "KRAK" }),
  ]);
  const positions = await client.getPositions();
  assert.equal(positions.length, 1);
  const note = warnings.find((w) => w.includes("getPositions"));
  assert.ok(note, "der Call muss eine Betriebswarnung absetzen");
  assert.match(note!, /2 Positionszeile\(n\)/, "Anzahl verworfener Zeilen im Log");
  assert.match(note!, /kein LONG-Fallback/);
  assert.ok(!positions.some((p) => p.symbol === "SOLUSDT"), "SOL bleibt trotz Warnung draußen");
});

test("B2: Zähler kumuliert über Calls und ist test-seitig rücksetzbar", async () => {
  clearBitunixPositionAnomaliesForTests();
  assert.equal(readBitunixPositionAnomalyCount(), 0);
  const { client } = await started([row({ symbol: "BTCUSDT", side: "" })]);
  await client.getPositions();
  assert.equal(readBitunixPositionAnomalyCount(), 1);
  await client.getPositions();
  assert.equal(readBitunixPositionAnomalyCount(), 2, "zweiter Call zählt weiter");
  clearBitunixPositionAnomaliesForTests();
  assert.equal(readBitunixPositionAnomalyCount(), 0);
  assert.equal(readBitunixPositionAnomalies().length, 0);
});

// ---------------------------------------------------------------------------
// 3) Reihenfolge der Prüfungen: 0-qty zuerst (DO 2)
// ---------------------------------------------------------------------------

test("B2: geschlossene/0-qty-Zeilen ohne side scheiden über qty aus — keine Anomalie", async () => {
  clearBitunixPositionAnomaliesForTests();
  const { client } = await started([
    // Vom Venue für flat gewordene Zeilen: keine Menge, oft auch keine Seite.
    row({ symbol: "DOGEUSDT", qty: "0", side: "" }),
    row({ symbol: "DOTUSDT", qty: "-1", side: undefined }),
    row({ symbol: "AVAXUSDT", qty: "abc", side: "LONG" }),
    // echte offene Position, aber ohne verwertbare Seite → sehr wohl Anomalie
    row({ symbol: "LINKUSDT", qty: "3", side: "" }),
  ]);

  const positions = await client.getPositions();
  assert.equal(positions.length, 0, "keine der Zeilen ist eine übernehmbare offene Position");
  assert.equal(readBitunixPositionAnomalyCount(), 1, "nur die offene Zeile ohne Seite zählt als Anomalie");
  assert.deepEqual(readBitunixPositionAnomalies(5).map((a) => a.symbol), ["LINKUSDT"]);
});

test("B2: Default-Zeile des Fixtures (LONG) bleibt unverändert — Regression des Pfade", async () => {
  clearBitunixPositionAnomaliesForTests();
  const { client } = await started(null);
  const positions = await client.getPositions();
  assert.equal(positions.length, 1);
  assert.equal(positions[0]?.symbol, "BTCUSDT");
  assert.equal(positions[0]?.side, "LONG");
  assert.equal(readBitunixPositionAnomalyCount(), 0, "saubere Antwort erzeugt keine Anomalie");
});
