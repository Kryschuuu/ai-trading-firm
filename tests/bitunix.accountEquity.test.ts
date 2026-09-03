/**
 * H8 — Bitunix-Equity aus den KORREKTEN Venue-Feldern (walletBalance + uPnL),
 * nicht aus `available + uPnL`.
 *
 * `available` ist FREIE MARGIN (freies Cash), nicht Equity. Bei offenen
 * Positionen ist Margin gebunden (usedMargin>0) — die gebundene Margin gehört
 * weiter zum Gesamtkapital. Acceptance: Für ein Konto mit usedMargin>0 gilt
 * equity != available; equity = walletBalance + unrealizedPnl; cash bleibt die
 * freie Margin (Cash-Guard).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { BitunixFixtureServer } from "./fixtures/bitunixFixtureServer";
import { loadBitunixConfig } from "../src/brokers/bitunix/config";
import { BitunixPrivateClient } from "../src/brokers/bitunix/privateClient";

const servers: BitunixFixtureServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.stop()));
});

async function started(accountRow: Record<string, string> | null): Promise<{
  client: BitunixPrivateClient;
  fx: BitunixFixtureServer;
}> {
  const fx = new BitunixFixtureServer();
  fx.accountRow = accountRow;
  const base = await fx.start();
  servers.push(fx);
  const client = new BitunixPrivateClient({
    config: loadBitunixConfig({
      BITUNIX_ENABLED: "true",
      BITUNIX_ALLOW_INSECURE_HTTP: "true",
      BITUNIX_BASE_URL: base,
      BITUNIX_RETRY_MAX: "1",
    }),
    credentials: { apiKey: fx.apiKey, apiSecret: fx.apiSecret },
  });
  return { client, fx };
}

test("H8: Equity = walletBalance + uPnL, cash = available (usedMargin>0 ⇒ equity != cash)", async () => {
  // Venue-Zeile mit offener Position: 1.500 gebundene Margin, 200 Order-Margin,
  // 300 unrealisiertes PnL (250 cross + 50 isoliert), walletBalance 9.700.
  const { client } = await started({
    marginCoin: "USDT",
    available: "8000",
    frozen: "200",
    margin: "1500",
    walletBalance: "9700",
    crossUnrealizedPNL: "250",
    isolationUnrealizedPNL: "50",
  });
  const acct = await client.getAccount();

  assert.equal(acct.cash, 8000, "cash = freie Margin (available) — Cash-Guard");
  assert.equal(acct.availableCash, 8000, "availableCash = available");
  assert.equal(acct.walletBalance, 9700, "walletBalance kommt aus dem Venue-Feld");
  assert.equal(acct.unrealizedPnl, 300, "uPnL = cross + isolation");
  assert.equal(acct.usedMargin, 1500, "usedMargin = Positions-Margin");
  assert.equal(acct.equity, 10_000, "equity = walletBalance + uPnL (9700 + 300)");
  assert.notEqual(acct.equity, acct.cash, "usedMargin>0 ⇒ equity != available (Risk-Denominator korrekt)");
  assert.equal(acct.maintenanceMargin, 0, "maintenanceMargin: Feld absent ⇒ 0 (dokumentierter Fallback)");
});

test("H8: walletBalance-Feld absent ⇒ Zerlegung aus available+frozen+margin (nie equity aus available allein)", async () => {
  // Bitunix-Doku-Antwort (Get Single Account) führt walletBalance nicht —
  // Fallback NUR bei genuin fehlendem Feld, aus den venue-eigenen Komponenten.
  const { client } = await started({
    marginCoin: "USDT",
    available: "8000",
    frozen: "200",
    margin: "1500",
    crossUnrealizedPNL: "250",
    isolationUnrealizedPNL: "50",
  });
  const acct = await client.getAccount();

  assert.equal(acct.walletBalance, 9700, "walletBalance = available + frozen + margin (8000+200+1500)");
  assert.equal(acct.equity, 10_000, "equity = walletBalance(zerlegt) + uPnL");
  assert.notEqual(acct.equity, acct.availableCash, "equity darf nie = available sein, wenn Margin gebunden ist");
  assert.equal(acct.usedMargin, 1500, "usedMargin = row.margin, wenn usedMargin absent");
});

test("H8: Leeres Konto (keine Positionen) ⇒ equity == available (Regression: alte Default-Zeile)", async () => {
  const { client } = await started(null);
  const acct = await client.getAccount();
  assert.equal(acct.cash, 10_000);
  assert.equal(acct.equity, 10_000, "ohne Positionen sind equity und available identisch");
  assert.equal(acct.walletBalance, 10_000);
  assert.equal(acct.usedMargin, 0);
  assert.equal(acct.unrealizedPnl, 0);
  assert.equal(acct.availableCash, acct.cash);
});

test("H8: realizedPnl/maintenanceMargin/usedMargin als explizite Venue-Felder werden addiert", async () => {
  const { client } = await started({
    marginCoin: "USDT",
    available: "7000",
    frozen: "0",
    margin: "2000",
    walletBalance: "9000",
    usedMargin: "2050",
    maintenanceMargin: "300",
    realizedPnl: "-100",
    crossUnrealizedPNL: "1000",
    isolationUnrealizedPNL: "0",
  });
  const acct = await client.getAccount();
  assert.equal(acct.usedMargin, 2050, "explizites usedMargin schlägt row.margin");
  assert.equal(acct.maintenanceMargin, 300);
  assert.equal(acct.unrealizedPnl, 1000);
  assert.equal(acct.equity, 9900, "equity = walletBalance + realizedPnl + unrealizedPnl (9000 − 100 + 1000)");
  assert.equal(acct.cash, 7000);
});

test("H8: Leere/genuin fehlende Felder ⇒ fail-closed 0 (nie aus available allein synthetisiert)", async () => {
  const { client } = await started({ marginCoin: "USDT" });
  const acct = await client.getAccount();
  assert.equal(acct.equity, 0, "keine Felder ⇒ equity 0 (H9 blockiert Orders fail-closed)");
  assert.equal(acct.cash, 0);
  assert.equal(acct.walletBalance, 0);
  assert.equal(acct.availableCash, 0);
  assert.equal(acct.unrealizedPnl, 0);
});
