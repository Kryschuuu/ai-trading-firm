/**
 * `GET /api/marketdata/snapshot?instrument=…` (Task 03) — read-only.
 *
 * Liefert einen normalisierten Markt-Snapshot (Bid/Ask/Last + Provenienz) für
 * ein Instrument (ID `PAPER:BTC` oder Symbol `BTC`). Der Kurs läuft durch die
 * Failover-Kette des konfigurierten Paper-Modus und wird im Historical Store
 * append-only gespeichert.
 *
 * Antwort 200:
 * ```json
 * {
 *   "ok": true,
 *   "snapshot": {
 *     "instrumentId": "PAPER:BTC", "symbol": "BTC", "base": "BTC", "quote": "USD",
 *     "bid": 67450.1, "ask": 67453.3, "last": 67451.2, "ts": 1750000000000,
 *     "source": "binance", "venue": "BINANCE", "feed": "broker:PAPER",
 *     "spread": 0.000047, "volume24h": 123456789
 *   },
 *   "paperMode": "broker-market-data"
 * }
 * ```
 * Fehler-Contract: `{ ok:false, error, message }` (400 unbekanntes Instrument,
 * 502 Feed-Kette fehlgeschlagen, 500 intern).
 */
import { publicErrorMessage } from "@/lib/secrets";
import { MarketDataError } from "@/lib/marketdata";
import { getProductionMarketDataManager } from "@/lib/marketdata/production";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const instrument = new URL(req.url).searchParams.get("instrument") ?? "";
  if (!instrument.trim()) {
    return Response.json(
      { ok: false, error: "VALIDATION_ERROR", message: "Parameter 'instrument' fehlt." },
      { status: 400 }
    );
  }
  const manager = getProductionMarketDataManager();
  try {
    const snapshot = await manager.getSnapshot(instrument.trim());
    return Response.json({
      ok: true,
      snapshot,
      paperMode: manager.config.paperMode,
      activeSource: manager.status().activeSource,
    });
  } catch (e) {
    if (e instanceof MarketDataError) {
      const status = e.code === "UNKNOWN_INSTRUMENT" ? 400 : 502;
      return Response.json(
        { ok: false, error: e.code, message: e.message },
        { status }
      );
    }
    return Response.json(
      { ok: false, error: "INTERNAL_ERROR", message: publicErrorMessage(e) },
      { status: 500 }
    );
  }
}
