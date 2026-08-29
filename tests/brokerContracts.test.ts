/**
 * Contract-Tests (Task 02/07): ALLE 7 Adapter gegen EINE gemeinsame
 * Interface-Suite.
 *
 * Abgedeckt:
 *   - Struktur-Contract: id, mode, capabilities (Form + Vollständigkeit)
 *   - healthCheck-Contract: Status-Enum, latencyMs, details-Objekt
 *   - Capability-Gating der Adapter-Methoden: capability=false ⇒
 *     NotSupportedCapabilityError (sicher UND informativ: Venue + Capability
 *     + Methode in der Meldung)
 *   - „Trading wirft sicher und informativ“: Trading-Methoden werfen bei
 *     capability=false deterministisch; PAPER liefert echte Fills
 *   - Leaking-Schutz: keine Meldung enthält Credential-/Infrastruktur-Pattern
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createAdapter } from "../src/brokers/factory";
import { PaperBrokerAdapter } from "../src/brokers/paper";
import { StubBrokerAdapter } from "../src/brokers/stubs";
import { BitunixBrokerAdapter } from "../src/brokers/bitunix";
import { BitunixDisabledError } from "../src/brokers/bitunix/errors";
import { MarketDataFetchError } from "../src/lib/marketDataErrors";
import {
  BROKER_VENUE_IDS,
  NotSupportedCapabilityError,
  type BrokerAdapter,
  type BrokerCapabilities,
} from "../src/contracts/broker";
import { killSwitch, resetRuntimeLimits } from "../src/lib/riskGuard";

beforeEach(() => {
  resetRuntimeLimits();
  killSwitch.disarm();
});

/**
 * Offline-Schutz: der Markt-Daten-Pfad (getQuote/Candles) darf in der
 * Suite nie echte Netz-Requests stellen — fetch wird gestubt, der
 * Fallback auf das statische Kursbuch ist deterministisch.
 */
const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});
globalThis.fetch = (async () => {
  throw new Error("offline-test: kein Netzwerk in der Contract-Suite");
}) as typeof fetch;

function isCapabilities(caps: unknown): caps is BrokerCapabilities {
  if (!caps || typeof caps !== "object") return false;
  const c = caps as Record<string, unknown>;
  for (const k of ["discovery", "marketData", "trading", "paper", "testnet", "live", "stopAtVenue"]) {
    if (typeof c[k] !== "boolean") return false;
  }
  const it = c.instrumentTypes as Record<string, unknown> | undefined;
  if (!it) return false;
  return ["spot", "perpetual", "future", "option"].every((k) => typeof it[k] === "boolean");
}

const LEAK_PATTERN =
  /secret|token|passwort|password|postgresql:|api[_-]?key|x-firm-token|bearer\s/i;

function assertNoLeak(message: string): void {
  assert.ok(
    !LEAK_PATTERN.test(message),
    `Meldung leackt potenzielle Infrastruktur-/Credential-Details: ${message}`
  );
}

async function expectNse(
  p: Promise<unknown>,
  venue: string,
  capability: string
): Promise<void> {
  await assert.rejects(
    p,
    (e: unknown) => {
      assert.ok(e instanceof NotSupportedCapabilityError, `${venue}: NSE erwartet, got ${e}`);
      assert.equal((e as NotSupportedCapabilityError).venue, venue);
      assert.equal((e as NotSupportedCapabilityError).capability, capability);
      assert.equal((e as NotSupportedCapabilityError).code, "NOT_SUPPORTED_CAPABILITY");
      const msg = (e as Error).message;
      assert.ok(msg.includes(venue), "Meldung enthält das Venue");
      assert.ok(msg.includes(capability), "Meldung enthält die Capability");
      assertNoLeak(msg);
      return true;
    }
  );
}

/** Gemeinsame Interface-Suite für alle 7 Adapter. */
for (const venue of BROKER_VENUE_IDS) {
  const adapter: BrokerAdapter = createAdapter(venue, "paper");

  test(`Contract ${venue}: Adapter-Struktur (id, mode, capabilities)`, () => {
    assert.equal(adapter.id, venue);
    assert.equal(adapter.mode, "paper");
    assert.ok(isCapabilities(adapter.capabilities), `${venue}: capabilities-Form`);
    if (venue === "PAPER") {
      assert.ok(adapter instanceof PaperBrokerAdapter, "PAPER-Adapter-Typ");
    } else if (venue === "BITUNIX") {
      assert.ok(adapter instanceof BitunixBrokerAdapter, "Bitunix-Adapter-Typ");
    } else {
      assert.ok(adapter instanceof StubBrokerAdapter, "Stub-Adapter-Typ");
    }
  });

  test(`Contract ${venue}: healthCheck liefert gültige Struktur`, async () => {
    const h = await adapter.healthCheck();
    assert.ok(["online", "degraded", "offline"].includes(h.status), `${venue}: status-Enum`);
    assert.equal(typeof h.latencyMs, "number");
    assert.ok(Number.isFinite(h.latencyMs) && h.latencyMs >= 0, `${venue}: latencyMs`);
    assert.ok(h.details && typeof h.details === "object", `${venue}: details-Objekt`);
    assertNoLeak(JSON.stringify(h.details));
  });

  test(`Contract ${venue}: Trading wirft sicher und informativ (capability=${adapter.capabilities.trading})`, async () => {
    const req = {
      symbol: "BTC",
      side: "LONG" as const,
      qty: 0.1,
      riskNotional: 1000,
      stopLoss: 60000,
      takeProfit: 70000,
    };
    if (!adapter.capabilities.trading) {
      // Stub: deterministische, informative Verweigerung.
      await expectNse(Promise.resolve().then(() => adapter.placeOrder!(req)), venue, "trading");
      await expectNse(adapter.getAccount!(), venue, "trading");
      await expectNse(adapter.getPositions!(), venue, "trading");
      return;
    }
    if (venue === "BITUNIX") {
      // Flag Default OFF → BitunixDisabledError (kein Netz, kein Fill).
      await assert.rejects(() => adapter.placeOrder!(req), BitunixDisabledError);
      await assert.rejects(() => adapter.getAccount!(), BitunixDisabledError);
      await assert.rejects(() => adapter.getPositions!(), BitunixDisabledError);
      return;
    }
    // PAPER: echte simulierte Ausführung (Guardrails bleiben wirksam).
    const res = await adapter.placeOrder!(req);
    assert.equal(res.status, "FILLED");
    assert.ok(res.fillPrice > 0);
    assert.ok(res.orderId.length > 0);
    // Optionale Felder (limitPrice/stopLoss/takeProfit) fließen durch
    // (LONG, da allowShort standardmäßig aus ist):
    const res2 = await adapter.placeOrder!({
      symbol: "ETH",
      side: "LONG" as const,
      qty: 0.5,
      limitPrice: 3300,
      riskNotional: 1600,
      stopLoss: 3000,
      takeProfit: 3500,
    });
    assert.equal(res2.status, "FILLED");
    assert.equal(res2.stopLoss, 3000, "stopLoss wird übergeben");
    assert.equal(res2.takeProfit, 3500, "takeProfit wird übergeben");
    const account = await adapter.getAccount!();
    assert.ok(account.equity > 9000 && account.equity < 10001, `equity plausibel: ${account.equity}`);
    assert.equal(account.openPositions, 2, "zwei offene Positionen (BTC + ETH)");
    const positions = await adapter.getPositions!();
    assert.equal(positions.length, 2);
    assert.deepEqual(positions.map((p) => p.symbol).sort(), ["BTC", "ETH"]);
    // Cleanup: nicht in andere Tests/Datei-Zustände tragen.
    (adapter as PaperBrokerAdapter).paperBroker.close("BTC", "TEST_CLEANUP");
    (adapter as PaperBrokerAdapter).paperBroker.close("ETH", "TEST_CLEANUP");
  });

  test(`Contract ${venue}: MarketData-Methoden (capability=${adapter.capabilities.marketData})`, async () => {
    if (!adapter.capabilities.marketData) {
      await expectNse(adapter.getTicker!("BTC"), venue, "marketData");
      await expectNse(adapter.getCandles!("BTC", "15m"), venue, "marketData");
      return;
    }
    if (venue === "BITUNIX") {
      await assert.rejects(() => adapter.getTicker!("BTCUSDT"), BitunixDisabledError);
      await assert.rejects(() => adapter.getCandles!("BTCUSDT", "15m"), BitunixDisabledError);
      return;
    }
    // PAPER: offline über das statische Fallback-Buch (fetch gestubt).
    const t = await adapter.getTicker!("BTC");
    assert.equal(t.symbol, "BTC");
    assert.ok(t.price > 0, "Kurs positiv (Fallback-Buch)");
    assert.ok(typeof t.source === "string" && t.source.length > 0);
    // MDERR-006: Kerzen-Abruf wirft typisiert, wenn kein Cache existiert
    // (kein stilles []) — der Paper-Betrieb darf nur über den expliziten,
    // stale-markierten Fallback degradieren.
    try {
      const candles = await adapter.getCandles!("BTC", "15m");
      assert.ok(Array.isArray(candles), "Kerzen als Array");
    } catch (e) {
      assert.ok(e instanceof MarketDataFetchError, `PAPER/getCandles: MarketDataFetchError erwartet, got ${e}`);
      assert.ok((e as MarketDataFetchError).reason.length > 0);
      assert.ok(typeof (e as MarketDataFetchError).retryable === "boolean");
      assertNoLeak((e as Error).message);
    }
  });

  test(`Contract ${venue}: Discovery (capability=${adapter.capabilities.discovery})`, async () => {
    if (!adapter.capabilities.discovery) {
      await assert.rejects(adapter.discoverInstruments!(), (e: unknown) => {
        assert.ok(e instanceof NotSupportedCapabilityError, `${venue}: NSE erwartet`);
        const msg = (e as Error).message;
        // Klar markiertes TODO mit Contract-Referenz (Task-Planung):
        assert.ok(msg.includes("TODO(task-02/07)"), "TODO(task-02/07) in der Meldung");
        assert.ok(msg.includes("src/contracts/broker.ts"), "Contract-Referenz in der Meldung");
        assertNoLeak(msg);
        return true;
      });
      return;
    }
    if (venue === "BITUNIX") {
      await assert.rejects(() => adapter.discoverInstruments!(), BitunixDisabledError);
      return;
    }
    // PAPER: Discovery aus der lokalen Universe-Registry (offline, deterministisch).
    const items = await adapter.discoverInstruments!();
    assert.ok(items.length >= 1, "mindestens ein PAPER-Instrument");
    for (const it of items) {
      assert.equal(it.venue, "PAPER");
      assert.ok(it.id.startsWith("PAPER:"), `ID-Format: ${it.id}`);
    }
  });

  test(`Contract ${venue}: Fehlermeldungen sind konsistent informativ`, async () => {
    // Unabhängig von der Capability-Menge: JEDE Methode, die wirft, wirft
    // mit Code + Venue + Capability — und ohne Leaks.
    const probes: [string, () => Promise<unknown>, string][] = [
      ["placeOrder", () => adapter.placeOrder!({ symbol: "BTC", side: "LONG", qty: 1, riskNotional: 100 }), "trading"],
      ["getAccount", () => adapter.getAccount!(), "trading"],
      ["getPositions", () => adapter.getPositions!(), "trading"],
      ["getTicker", () => adapter.getTicker!("BTC"), "marketData"],
      ["getCandles", () => adapter.getCandles!("BTC", "15m"), "marketData"],
      ["discoverInstruments", () => adapter.discoverInstruments!(), "discovery"],
    ];
    let threw = 0;
    for (const [method, call, cap] of probes) {
      try {
        await call();
      } catch (e) {
        threw++;
        if (venue === "BITUNIX") {
          assert.ok(e instanceof BitunixDisabledError, `${venue}/${method}: BitunixDisabledError, got ${e}`);
          assertNoLeak((e as Error).message);
          continue;
        }
        // MDERR-006: PAPER nutzt die explizite Stale-Fallback-API; ohne
        // Cache wird der typisierte Marktdatenfehler geworfen (nie ein
        // stilles leeres Array).
        if (e instanceof MarketDataFetchError) {
          assert.equal(venue, "PAPER", `${venue}/${method}: MarketDataFetchError nur für PAPER erwartet`);
          assert.ok((e as MarketDataFetchError).reason.length > 0, `${venue}/${method}: reason gesetzt`);
          assertNoLeak((e as Error).message);
          continue;
        }
        assert.ok(e instanceof NotSupportedCapabilityError, `${venue}/${method}: NSE erwartet, got ${e}`);
        assert.equal((e as NotSupportedCapabilityError).capability, cap, `${venue}/${method}: capability=${cap}`);
        assertNoLeak((e as Error).message);
      }
    }
    if (!adapter.capabilities.trading) {
      assert.ok(threw >= 3, `${venue}: Trading-Methoden verweigern deterministisch (${threw})`);
    }
  });
}
