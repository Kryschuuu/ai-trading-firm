/**
 * Copy-Trading — Symbol-Mapping (Phase 7 · Paket 00-02 · STX-07-01).
 *
 * **Rein**, keine IO/DB/Netz. Nutzt ausschließlich die SSoT
 * `tryNormalizeVenueSymbol` aus `@/symbols/normalize` für die
 * venue-aware Kanonisierung. Es gibt **kein** `String.replace` auf das rohe
 * Leader-Symbol — die SSoT ist der einzige Ort für Symbol-Semantik.
 *
 * Kernpunkt: `BTC/USD`, `BTCUSDT`, `BTC-PERP` (und weitere native
 * Schreibweisen) sind nicht dasselbe Symbol auf derselben Venue, aber
 * **dieselbe venue-übergreifende ID**. Diese wird hier abgeleitet, indem die
 * SSoT das Symbol venue-aware kanonisiert und wir anschließend die
 * Quote-Leg-Äquivalenz (USD-gepegte Stablecoins ≡ USD) anwenden. Das ist ein
 * **Währungs-Äquivalenz-Lookup auf der bereits kanonisierten Form** —
 * kein Raten, kein String-Ersatz auf dem Roh-Input.
 *
 * Unauflösbar ⇒ `{ok:false}` mit Grund. Kein Fallback, kein
 * „nächstbestes Symbol". Eine falsche Zuordnung ist schlimmer als eine
 * ausgelassene.
 */

import type { BrokerVenueId } from "@/contracts/broker";
import {
  tryNormalizeVenueSymbol,
  type CanonicalSymbol,
} from "@/symbols/normalize";

/**
 * Ergebnis der Leader-Symbol-Auflösung.
 *
 * `instrumentId` ist hier die **venue-übergreifende** ID (z. B. `BTC/USD`) —
 * der Schlüssel, gegen den Follower unabhängig von der Leader-Venue matchen.
 * `venue` ist die Venue, auf der der Leader tatsächlich handelte, und
 * `resolved` die vollständige SSoT-Auflösung (native Schreibweise, kanonisches
 * Paar, Asset-Klasse) — darüber unterscheiden sich die Venue-Auflösungen
 * voneinander, während `instrumentId` gleich bleibt.
 */
export type SymbolMapping =
  | {
      ok: true;
      instrumentId: string;
      venue: string;
      resolved: CanonicalSymbol;
    }
  | {
      ok: false;
      reason: string;
    };

/**
 * USD-gepegte Stablecoins. In cross-venue-Termen äquivalent zu USD: eine
 * `BTC/USDT`-Position ist für den Copy-Zweck dieselbe wie `BTC/USD`. BTC/ETH
 * als Quote werden bewusst NICHT gemappt (Krypto-Krypto, nicht USD-denominiert).
 *
 * Bewusst deckungsgleich mit der vom SSoT erkannten Menge pegged Quotes
 * (`USDT|USDC|TUSD|FDUSD|BUSD`) plus `DAI`/`USDP`/`USDE`/`PYUSD` als weitere
 * klar USD-pegged Stablecoins.
 */
const USD_PEGGED_STABLECOINS: ReadonlySet<string> = new Set([
  "USDT",
  "USDC",
  "BUSD",
  "TUSD",
  "FDUSD",
  "DAI",
  "USDP",
  "USDE",
  "PYUSD",
]);

/**
 * Leitet die venue-übergreifende ID aus der SSoT-Kanonicalform ab.
 *
 * Regel: nur die **Quote-Leg** eines Paares wird ggf. auf `USD` gemappt
 * (Stablecoin-Äquivalenz). Single-Ticker (Aktien/ETF) und nicht-pegged Quotes
 * bleiben unverändert. Operiert auf der bereits validierten Kanonicalform —
 * kein `String.replace` auf dem Roh-Input.
 */
export function toCrossVenueId(canonical: string): string {
  const slash = canonical.indexOf("/");
  if (slash < 0) return canonical; // kein Paar → unverändert durchreichen
  const base = canonical.slice(0, slash);
  const quote = canonical.slice(slash + 1);
  if (USD_PEGGED_STABLECOINS.has(quote)) {
    return `${base}/USD`;
  }
  return canonical;
}

/**
 * Löst ein rohes Leader-Symbol gegen die SSoT auf und liefert die
 * venue-übergreifende Instrument-ID.
 *
 * @param venue  Venue des Leaders (BrokerVenueId).
 * @param raw    Roh-Symbol-Schreibweise des Leaders (z. B. `BTCUSDT`, `XBTUSD`).
 * @returns      `{ok:true, instrumentId, venue, resolved}` oder `{ok:false, reason}`.
 *
 * Unauflösbar ⇒ `{ok:false}` — niemals ein Fallback.
 */
export function mapLeaderSymbol(
  venue: BrokerVenueId,
  raw: string
): SymbolMapping {
  const resolvedNorm = tryNormalizeVenueSymbol(venue, raw, {});
  if (!resolvedNorm.ok) {
    return { ok: false, reason: resolvedNorm.reason };
  }
  const crossVenueId = toCrossVenueId(resolvedNorm.value.canonical);
  return {
    ok: true,
    instrumentId: crossVenueId,
    venue: resolvedNorm.value.venue,
    resolved: resolvedNorm.value,
  };
}
