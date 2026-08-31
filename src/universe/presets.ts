/**
 * Standardisierte Markt-Presets des Instrument-Universums (v1.30.0).
 *
 * ── Zweck ──────────────────────────────────────────────────────────────────
 * Der eingebaute Seed (`src/universe/seed.ts`) migriert die historische
 * 9-Symbole-Watchlist — 26 Instrumente. Für einen brauchbaren Scanner-Trichter
 * (Liquidität/Volatilität/Korrelation) ist das zu dünn: mit drei Kryptos und
 * fünf Aktien gibt es keine Korrelationsstruktur und kein Ranking.
 *
 * Dieses Modul ergänzt deshalb vier **kuratierte, deterministische** Presets:
 *
 *   | Preset        | Anzahl | Venue(s)        | marketType |
 *   | ------------- | -----: | --------------- | ---------- |
 *   | Aktien        |     50 | ALPACA, IBKR    | spot       |
 *   | Indizes       |     50 | IBKR            | cfd        |
 *   | Rohstoffe     |     22 | IBKR            | future     |
 *   | Kryptowährungen|    30 | BINANCE         | spot       |
 *
 * Zusätzlich erhält jedes Preset-Asset ein `PAPER`-Spiegelinstrument, damit der
 * Paper-Trading-Pfad (Produktstandard dieser Plattform) das komplette Universum
 * handeln kann — dasselbe Muster wie im Legacy-Seed.
 *
 * ── Design-Regeln (identisch zu `seed.ts`) ─────────────────────────────────
 *   * **Deterministisch:** fester `lastSeen`-Zeitstempel ⇒ wiederholte Läufe
 *     erzeugen eine byte-identische NDJSON-Datei.
 *   * **Kein Netzwerk, keine Credentials, keine Datenbank.**
 *   * **Kein `liveAvailable`:** Das Feld ist Laufzeitprojektion (CAP-008) und im
 *     Seed verboten — `assertSeedRecordHasNoLiveAvailable()` prüft es.
 *   * **`liveTradable`** ist die fachliche Produktentscheidung: PAPER = false,
 *     reale Venues = true. Es sagt NICHT, dass ein Adapter existiert.
 *   * **Metriken starten auf `null`** (`volume24h`, `spread`, `volatility`) —
 *     die Registry erfindet keine Marktdaten; gefüllt werden sie von
 *     `npm run market:sync` (MDSYNC-001).
 *   * **Kein Hebel-Versprechen:** `leverageAvailable` ist nur dort true, wo das
 *     Produkt es tatsächlich anbietet (Futures/CFD/FX), nie bei Spot.
 *
 * ── Short-Selling ──────────────────────────────────────────────────────────
 * `shortAvailable` ist eine **Beschreibung der Venue-Fähigkeit**, keine
 * Freigabe. Die operative Freigabe ist `riskLimits.allowShort`
 * (`src/lib/riskGuard.ts`, zur Laufzeit über `/api/firm/config` änderbar).
 *
 *   * ALPACA/IBKR-Aktien, IBKR-Index-CFDs, IBKR-Rohstoff-Futures, IBKR-FX,
 *     PAPER-Spiegel ⇒ `shortAvailable: true`
 *   * BINANCE-Spot ⇒ `shortAvailable: false` (Spot kann nicht leer verkauft
 *     werden; Short ginge nur über Margin/Futures, die hier nicht modelliert
 *     sind — bewusst keine falsche Zusage).
 *
 * ── Symbol-Notation ────────────────────────────────────────────────────────
 * Gespeichert wird die **venue-native** Schreibweise (SYM-007). Indizes tragen
 * kein `^` (das Registry-Speichermuster `STORAGE_SYMBOL_RE` erlaubt nur
 * `A-Z0-9` plus `/ . - _ =`), also `SPX` statt `^GSPC`.
 */

import { assertSeedRecordHasNoLiveAvailable } from "./capabilityProjection";
import type { InstrumentInput } from "./types";

/**
 * Fester Zeitstempel der Presets. Deterministisch, damit wiederholte Seed-Läufe
 * eine byte-identische `instruments.ndjson` erzeugen (Git-Diff-freundlich).
 */
export const PRESET_TIMESTAMP = "2026-08-31T00:00:00.000Z";

/** Ein kuratierter Preset-Eintrag (Quelle: öffentliche Ticker-Referenzen). */
export interface PresetEntry {
  /** Venue-natives Symbol an der Leit-Venue (z. B. `AAPL`, `SPX`, `GC`, `BTCUSDT`). */
  readonly symbol: string;
  /** Menschlicher Name — nur für Doku/Audit, wird NICHT persistiert. */
  readonly name: string;
  /** Basis-Asset (`BTC` bei Paaren), `null` bei Einzelwerten. */
  readonly base: string | null;
  /** Abrechnungswährung. */
  readonly quote: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) Aktien — 50 liquide US-Large-Caps (ALPACA + IBKR)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 50 standardisierte US-Aktien. Auswahlkriterien: dauerhaft hohe Liquidität,
 * breite Sektor-Abdeckung (Technologie, Finanzen, Gesundheit, Energie,
 * Industrie, Konsum, Grundstoffe, Versorger), keine gehebelten/hebelbaren
 * Sonderprodukte.
 */
export const PRESET_EQUITIES: readonly PresetEntry[] = [
  { symbol: "AAPL", name: "Apple", base: null, quote: "USD" },
  { symbol: "MSFT", name: "Microsoft", base: null, quote: "USD" },
  { symbol: "NVDA", name: "NVIDIA", base: null, quote: "USD" },
  { symbol: "AMZN", name: "Amazon", base: null, quote: "USD" },
  { symbol: "GOOGL", name: "Alphabet A", base: null, quote: "USD" },
  { symbol: "META", name: "Meta Platforms", base: null, quote: "USD" },
  { symbol: "TSLA", name: "Tesla", base: null, quote: "USD" },
  { symbol: "AVGO", name: "Broadcom", base: null, quote: "USD" },
  { symbol: "AMD", name: "Advanced Micro Devices", base: null, quote: "USD" },
  { symbol: "INTC", name: "Intel", base: null, quote: "USD" },
  { symbol: "CRM", name: "Salesforce", base: null, quote: "USD" },
  { symbol: "ORCL", name: "Oracle", base: null, quote: "USD" },
  { symbol: "ADBE", name: "Adobe", base: null, quote: "USD" },
  { symbol: "CSCO", name: "Cisco Systems", base: null, quote: "USD" },
  { symbol: "QCOM", name: "Qualcomm", base: null, quote: "USD" },
  { symbol: "TXN", name: "Texas Instruments", base: null, quote: "USD" },
  { symbol: "IBM", name: "IBM", base: null, quote: "USD" },
  { symbol: "NOW", name: "ServiceNow", base: null, quote: "USD" },
  { symbol: "INTU", name: "Intuit", base: null, quote: "USD" },
  { symbol: "UBER", name: "Uber Technologies", base: null, quote: "USD" },
  { symbol: "JPM", name: "JPMorgan Chase", base: null, quote: "USD" },
  { symbol: "BAC", name: "Bank of America", base: null, quote: "USD" },
  { symbol: "WFC", name: "Wells Fargo", base: null, quote: "USD" },
  { symbol: "GS", name: "Goldman Sachs", base: null, quote: "USD" },
  { symbol: "MS", name: "Morgan Stanley", base: null, quote: "USD" },
  { symbol: "C", name: "Citigroup", base: null, quote: "USD" },
  { symbol: "V", name: "Visa", base: null, quote: "USD" },
  { symbol: "MA", name: "Mastercard", base: null, quote: "USD" },
  { symbol: "BRK.B", name: "Berkshire Hathaway B", base: null, quote: "USD" },
  { symbol: "UNH", name: "UnitedHealth Group", base: null, quote: "USD" },
  { symbol: "JNJ", name: "Johnson & Johnson", base: null, quote: "USD" },
  { symbol: "LLY", name: "Eli Lilly", base: null, quote: "USD" },
  { symbol: "PFE", name: "Pfizer", base: null, quote: "USD" },
  { symbol: "MRK", name: "Merck & Co", base: null, quote: "USD" },
  { symbol: "ABBV", name: "AbbVie", base: null, quote: "USD" },
  { symbol: "TMO", name: "Thermo Fisher Scientific", base: null, quote: "USD" },
  { symbol: "XOM", name: "Exxon Mobil", base: null, quote: "USD" },
  { symbol: "CVX", name: "Chevron", base: null, quote: "USD" },
  { symbol: "COP", name: "ConocoPhillips", base: null, quote: "USD" },
  { symbol: "SLB", name: "Schlumberger", base: null, quote: "USD" },
  { symbol: "CAT", name: "Caterpillar", base: null, quote: "USD" },
  { symbol: "BA", name: "Boeing", base: null, quote: "USD" },
  { symbol: "GE", name: "General Electric", base: null, quote: "USD" },
  { symbol: "HON", name: "Honeywell", base: null, quote: "USD" },
  { symbol: "UPS", name: "United Parcel Service", base: null, quote: "USD" },
  { symbol: "WMT", name: "Walmart", base: null, quote: "USD" },
  { symbol: "COST", name: "Costco Wholesale", base: null, quote: "USD" },
  { symbol: "HD", name: "Home Depot", base: null, quote: "USD" },
  { symbol: "MCD", name: "McDonald's", base: null, quote: "USD" },
  { symbol: "NKE", name: "Nike", base: null, quote: "USD" },
];

// ─────────────────────────────────────────────────────────────────────────────
// 2) Indizes — 50 globale Aktien-/Volatilitätsindizes (IBKR-CFDs)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 50 standardisierte Indizes (US, Europa, UK, Asien, Amerika, ANZ) plus die
 * beiden gebräuchlichsten Volatilitätsindizes. Notation ohne `^`
 * (Registry-Speichermuster). Als IBKR-CFDs geführt — Indizes selbst sind nicht
 * direkt handelbar; der CFD ist der handelbare Kontrakt.
 */
export const PRESET_INDICES: readonly PresetEntry[] = [
  // USA
  { symbol: "SPX", name: "S&P 500", base: null, quote: "USD" },
  { symbol: "NDX", name: "Nasdaq-100", base: null, quote: "USD" },
  { symbol: "DJI", name: "Dow Jones Industrial Average", base: null, quote: "USD" },
  { symbol: "IXIC", name: "Nasdaq Composite", base: null, quote: "USD" },
  { symbol: "RUT", name: "Russell 2000", base: null, quote: "USD" },
  { symbol: "RUI", name: "Russell 1000", base: null, quote: "USD" },
  { symbol: "RUA", name: "Russell 3000", base: null, quote: "USD" },
  { symbol: "OEX", name: "S&P 100", base: null, quote: "USD" },
  { symbol: "MID", name: "S&P MidCap 400", base: null, quote: "USD" },
  { symbol: "SML", name: "S&P SmallCap 600", base: null, quote: "USD" },
  { symbol: "DJT", name: "Dow Jones Transportation", base: null, quote: "USD" },
  { symbol: "DJU", name: "Dow Jones Utility", base: null, quote: "USD" },
  { symbol: "NYA", name: "NYSE Composite", base: null, quote: "USD" },
  { symbol: "SOX", name: "PHLX Semiconductor", base: null, quote: "USD" },
  { symbol: "NBI", name: "Nasdaq Biotechnology", base: null, quote: "USD" },
  { symbol: "XAU", name: "PHLX Gold/Silver", base: null, quote: "USD" },
  { symbol: "OSX", name: "PHLX Oil Service", base: null, quote: "USD" },
  { symbol: "BKX", name: "KBW Nasdaq Bank", base: null, quote: "USD" },
  { symbol: "VIX", name: "CBOE Volatility Index", base: null, quote: "USD" },
  { symbol: "VXN", name: "CBOE Nasdaq Volatility", base: null, quote: "USD" },
  // Europa
  { symbol: "GDAXI", name: "DAX 40", base: null, quote: "EUR" },
  { symbol: "MDAXI", name: "MDAX", base: null, quote: "EUR" },
  { symbol: "TECDAXI", name: "TecDAX", base: null, quote: "EUR" },
  { symbol: "FCHI", name: "CAC 40", base: null, quote: "EUR" },
  { symbol: "AEX", name: "AEX Amsterdam", base: null, quote: "EUR" },
  { symbol: "BEL20", name: "BEL 20 Brüssel", base: null, quote: "EUR" },
  { symbol: "SSMI", name: "Swiss Market Index", base: null, quote: "CHF" },
  { symbol: "FTMIB", name: "FTSE MIB Mailand", base: null, quote: "EUR" },
  { symbol: "IBEX", name: "IBEX 35 Madrid", base: null, quote: "EUR" },
  { symbol: "OMXS30", name: "OMX Stockholm 30", base: null, quote: "SEK" },
  { symbol: "OMXC25", name: "OMX Copenhagen 25", base: null, quote: "DKK" },
  { symbol: "WIG20", name: "WIG 20 Warschau", base: null, quote: "PLN" },
  { symbol: "ATX", name: "ATX Wien", base: null, quote: "EUR" },
  // UK
  { symbol: "UKX", name: "FTSE 100", base: null, quote: "GBP" },
  { symbol: "MCX", name: "FTSE 250", base: null, quote: "GBP" },
  // Asien
  { symbol: "NKY", name: "Nikkei 225", base: null, quote: "JPY" },
  { symbol: "TOPIX", name: "TOPIX", base: null, quote: "JPY" },
  { symbol: "HSI", name: "Hang Seng", base: null, quote: "HKD" },
  { symbol: "HSCEI", name: "Hang Seng China Enterprises", base: null, quote: "HKD" },
  { symbol: "KOSPI", name: "KOSPI", base: null, quote: "KRW" },
  { symbol: "TWII", name: "Taiwan Weighted", base: null, quote: "TWD" },
  { symbol: "STI", name: "Straits Times Index", base: null, quote: "SGD" },
  { symbol: "SENSEX", name: "BSE Sensex", base: null, quote: "INR" },
  { symbol: "NIFTY", name: "Nifty 50", base: null, quote: "INR" },
  // Amerika (ohne USA)
  { symbol: "TSX", name: "S&P/TSX Composite", base: null, quote: "CAD" },
  { symbol: "TX60", name: "S&P/TSX 60", base: null, quote: "CAD" },
  { symbol: "MXX", name: "IPC Mexiko", base: null, quote: "MXN" },
  { symbol: "BVSP", name: "Ibovespa", base: null, quote: "BRL" },
  // Australien / Neuseeland
  { symbol: "XJO", name: "S&P/ASX 200", base: null, quote: "AUD" },
  { symbol: "NZ50", name: "NZX 50", base: null, quote: "NZD" },
];

// ─────────────────────────────────────────────────────────────────────────────
// 3) Rohstoffe — Standardset (CME/NYMEX/COMEX/CBOT Continuous Futures)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rohstoff-Standardset: 5 Energie, 5 Metalle, 12 Agrar. Ticksize/Gebühren sind
 * konservative Startwerte aus den öffentlichen Venue-Tabellen und werden von
 * späteren Discovery-Läufen überschrieben.
 */
export interface CommodityPresetEntry extends PresetEntry {
  /** Kleinste handelbare Menge. */
  readonly minQuantity: number;
  /** Preis-Tick. */
  readonly priceStep: number;
}

export const PRESET_COMMODITIES: readonly CommodityPresetEntry[] = [
  // Energie
  { symbol: "CL", name: "WTI Crude Oil", base: null, quote: "USD", minQuantity: 1, priceStep: 0.01 },
  { symbol: "BZ", name: "Brent Crude Oil", base: null, quote: "USD", minQuantity: 1, priceStep: 0.01 },
  { symbol: "NG", name: "Natural Gas", base: null, quote: "USD", minQuantity: 1, priceStep: 0.001 },
  { symbol: "RB", name: "RBOB Gasoline", base: null, quote: "USD", minQuantity: 1, priceStep: 0.0001 },
  { symbol: "HO", name: "Heating Oil", base: null, quote: "USD", minQuantity: 1, priceStep: 0.0001 },
  // Metalle
  { symbol: "GC", name: "Gold", base: null, quote: "USD", minQuantity: 1, priceStep: 0.1 },
  { symbol: "SI", name: "Silver", base: null, quote: "USD", minQuantity: 1, priceStep: 0.005 },
  { symbol: "PL", name: "Platinum", base: null, quote: "USD", minQuantity: 1, priceStep: 0.1 },
  { symbol: "PA", name: "Palladium", base: null, quote: "USD", minQuantity: 1, priceStep: 0.1 },
  { symbol: "HG", name: "Copper", base: null, quote: "USD", minQuantity: 1, priceStep: 0.0005 },
  // Agrar
  { symbol: "ZC", name: "Corn", base: null, quote: "USX", minQuantity: 1, priceStep: 0.25 },
  { symbol: "ZW", name: "Wheat", base: null, quote: "USX", minQuantity: 1, priceStep: 0.25 },
  { symbol: "ZS", name: "Soybeans", base: null, quote: "USX", minQuantity: 1, priceStep: 0.25 },
  { symbol: "ZM", name: "Soybean Meal", base: null, quote: "USD", minQuantity: 1, priceStep: 0.1 },
  { symbol: "ZL", name: "Soybean Oil", base: null, quote: "USX", minQuantity: 1, priceStep: 0.01 },
  { symbol: "KC", name: "Coffee", base: null, quote: "USX", minQuantity: 1, priceStep: 0.05 },
  { symbol: "CC", name: "Cocoa", base: null, quote: "USD", minQuantity: 1, priceStep: 1 },
  { symbol: "SB", name: "Sugar No. 11", base: null, quote: "USX", minQuantity: 1, priceStep: 0.01 },
  { symbol: "CT", name: "Cotton No. 2", base: null, quote: "USX", minQuantity: 1, priceStep: 0.01 },
  { symbol: "OJ", name: "Orange Juice", base: null, quote: "USX", minQuantity: 1, priceStep: 0.05 },
  { symbol: "LE", name: "Live Cattle", base: null, quote: "USX", minQuantity: 1, priceStep: 0.025 },
  { symbol: "HE", name: "Lean Hogs", base: null, quote: "USX", minQuantity: 1, priceStep: 0.025 },
];

// ─────────────────────────────────────────────────────────────────────────────
// 4) Kryptowährungen — 30 Assets (BINANCE Spot, USDT-Quote)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 30 standardisierte Kryptowährungen (ohne Stablecoins). Reihenfolge folgt der
 * etablierten Market-Cap-Rangliste; bewusst aufgenommen sind nur Assets mit
 * dauerhafter Spot-Liquidität an der Leit-Venue.
 */
export interface CryptoPresetEntry extends PresetEntry {
  /** Kleinste handelbare Menge (Lot-Size der Venue). */
  readonly minQuantity: number;
  /** Preis-Tick. */
  readonly priceStep: number;
}

export const PRESET_CRYPTO: readonly CryptoPresetEntry[] = [
  { symbol: "BTCUSDT", name: "Bitcoin", base: "BTC", quote: "USDT", minQuantity: 0.00001, priceStep: 0.01 },
  { symbol: "ETHUSDT", name: "Ethereum", base: "ETH", quote: "USDT", minQuantity: 0.0001, priceStep: 0.01 },
  { symbol: "BNBUSDT", name: "BNB", base: "BNB", quote: "USDT", minQuantity: 0.001, priceStep: 0.01 },
  { symbol: "SOLUSDT", name: "Solana", base: "SOL", quote: "USDT", minQuantity: 0.01, priceStep: 0.001 },
  { symbol: "XRPUSDT", name: "XRP", base: "XRP", quote: "USDT", minQuantity: 1, priceStep: 0.0001 },
  { symbol: "ADAUSDT", name: "Cardano", base: "ADA", quote: "USDT", minQuantity: 1, priceStep: 0.0001 },
  { symbol: "DOGEUSDT", name: "Dogecoin", base: "DOGE", quote: "USDT", minQuantity: 1, priceStep: 0.00001 },
  { symbol: "AVAXUSDT", name: "Avalanche", base: "AVAX", quote: "USDT", minQuantity: 0.01, priceStep: 0.001 },
  { symbol: "TRXUSDT", name: "TRON", base: "TRX", quote: "USDT", minQuantity: 1, priceStep: 0.00001 },
  { symbol: "DOTUSDT", name: "Polkadot", base: "DOT", quote: "USDT", minQuantity: 0.01, priceStep: 0.001 },
  { symbol: "LINKUSDT", name: "Chainlink", base: "LINK", quote: "USDT", minQuantity: 0.01, priceStep: 0.001 },
  { symbol: "TONUSDT", name: "Toncoin", base: "TON", quote: "USDT", minQuantity: 0.01, priceStep: 0.001 },
  { symbol: "SHIBUSDT", name: "Shiba Inu", base: "SHIB", quote: "USDT", minQuantity: 1, priceStep: 0.00000001 },
  { symbol: "LTCUSDT", name: "Litecoin", base: "LTC", quote: "USDT", minQuantity: 0.001, priceStep: 0.01 },
  { symbol: "BCHUSDT", name: "Bitcoin Cash", base: "BCH", quote: "USDT", minQuantity: 0.001, priceStep: 0.01 },
  { symbol: "UNIUSDT", name: "Uniswap", base: "UNI", quote: "USDT", minQuantity: 0.01, priceStep: 0.001 },
  { symbol: "ATOMUSDT", name: "Cosmos", base: "ATOM", quote: "USDT", minQuantity: 0.01, priceStep: 0.001 },
  { symbol: "XLMUSDT", name: "Stellar", base: "XLM", quote: "USDT", minQuantity: 1, priceStep: 0.00001 },
  { symbol: "ETCUSDT", name: "Ethereum Classic", base: "ETC", quote: "USDT", minQuantity: 0.01, priceStep: 0.001 },
  { symbol: "FILUSDT", name: "Filecoin", base: "FIL", quote: "USDT", minQuantity: 0.01, priceStep: 0.001 },
  { symbol: "APTUSDT", name: "Aptos", base: "APT", quote: "USDT", minQuantity: 0.01, priceStep: 0.001 },
  { symbol: "ARBUSDT", name: "Arbitrum", base: "ARB", quote: "USDT", minQuantity: 0.01, priceStep: 0.0001 },
  { symbol: "OPUSDT", name: "Optimism", base: "OP", quote: "USDT", minQuantity: 0.01, priceStep: 0.0001 },
  { symbol: "NEARUSDT", name: "NEAR Protocol", base: "NEAR", quote: "USDT", minQuantity: 0.01, priceStep: 0.001 },
  { symbol: "INJUSDT", name: "Injective", base: "INJ", quote: "USDT", minQuantity: 0.01, priceStep: 0.001 },
  { symbol: "ALGOUSDT", name: "Algorand", base: "ALGO", quote: "USDT", minQuantity: 0.1, priceStep: 0.0001 },
  { symbol: "VETUSDT", name: "VeChain", base: "VET", quote: "USDT", minQuantity: 1, priceStep: 0.00001 },
  { symbol: "ICPUSDT", name: "Internet Computer", base: "ICP", quote: "USDT", minQuantity: 0.01, priceStep: 0.001 },
  { symbol: "HBARUSDT", name: "Hedera", base: "HBAR", quote: "USDT", minQuantity: 1, priceStep: 0.00001 },
  { symbol: "AAVEUSDT", name: "Aave", base: "AAVE", quote: "USDT", minQuantity: 0.001, priceStep: 0.01 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Vertrags-Prüfung: die dokumentierten Anzahlen sind Teil des Preset-Vertrags
// ─────────────────────────────────────────────────────────────────────────────

/** Erwartete Preset-Größen (README/INSTALL dokumentieren genau diese Zahlen). */
export const PRESET_COUNTS = {
  equities: 50,
  indices: 50,
  commodities: 22,
  crypto: 30,
} as const;

/**
 * Prüft die Preset-Listen gegen {@link PRESET_COUNTS} und gegen
 * Duplikatfreiheit. Läuft beim Seed und in den Tests — ein versehentlich
 * gekürztes Preset soll laut scheitern, nicht still ein dünneres Universum
 * erzeugen.
 *
 * @throws Error mit der konkreten Abweichung.
 */
export function assertPresetContract(): void {
  const actual = {
    equities: PRESET_EQUITIES.length,
    indices: PRESET_INDICES.length,
    commodities: PRESET_COMMODITIES.length,
    crypto: PRESET_CRYPTO.length,
  };
  for (const key of Object.keys(PRESET_COUNTS) as (keyof typeof PRESET_COUNTS)[]) {
    if (actual[key] !== PRESET_COUNTS[key]) {
      throw new Error(
        `Preset-Vertrag verletzt: ${key} hat ${actual[key]} Einträge, erwartet ${PRESET_COUNTS[key]}.`,
      );
    }
  }
  for (const [label, list] of [
    ["equities", PRESET_EQUITIES],
    ["indices", PRESET_INDICES],
    ["commodities", PRESET_COMMODITIES],
    ["crypto", PRESET_CRYPTO],
  ] as const) {
    const seen = new Set<string>();
    for (const entry of list) {
      if (seen.has(entry.symbol)) {
        throw new Error(`Preset-Vertrag verletzt: Duplikat ${entry.symbol} in ${label}.`);
      }
      seen.add(entry.symbol);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Instrument-Aufbau
// ─────────────────────────────────────────────────────────────────────────────

/** Optionen des Preset-Aufbaus. */
export interface PresetBuildOptions {
  /**
   * Zusätzlich je Asset ein `PAPER`-Spiegelinstrument anlegen (Default: true).
   * Ohne Spiegel ist das Universum im reinen Paper-Betrieb nicht handelbar.
   */
  readonly withPaperMirror?: boolean;
  /**
   * `shortAvailable` der PAPER-Spiegel (Default: true). Der Paper-Fill-Simulator
   * beherrscht LONG und SHORT; die operative Freigabe bleibt
   * `riskLimits.allowShort`.
   */
  readonly paperShortAvailable?: boolean;
}

/** Gemeinsamer Rumpf aller Preset-Instrumente. */
function presetBase(
  venue: string,
  symbol: string,
  base: string | null,
  quote: string,
  assetClass: InstrumentInput["assetClass"],
  marketType: InstrumentInput["marketType"],
  liveTradable: boolean,
  shortAvailable: boolean,
  leverageAvailable: boolean,
): InstrumentInput {
  return {
    venue,
    symbol,
    base,
    quote,
    assetClass,
    marketType,
    status: "active",
    minQuantity: 1,
    priceStep: 0.01,
    quantityStep: 1,
    makerFee: 0,
    takerFee: 0,
    leverageAvailable,
    shortAvailable,
    paperAvailable: true,
    liveTradable,
    // Metriken bleiben bewusst `null` — die Registry erfindet keine Marktdaten.
    volume24h: null,
    spread: null,
    volatility: null,
    lastSeen: PRESET_TIMESTAMP,
  };
}

/** PAPER-Spiegel: bare Ticker, damit der Paper-Broker-Pfad unverändert läuft. */
function paperMirror(
  entry: PresetEntry,
  assetClass: InstrumentInput["assetClass"],
  symbol: string,
  shortAvailable: boolean,
): InstrumentInput {
  const instrument = presetBase("PAPER", symbol, entry.base, "USD", assetClass, "spot", false, shortAvailable, false);
  return { ...instrument, minQuantity: 0.0001, priceStep: 0.01, quantityStep: 0.0001 };
}

/**
 * Erzeugt die vollständige Preset-Instrumentliste.
 *
 * Anzahl (Default-Optionen):
 *   50 Aktien × (ALPACA, IBKR, PAPER)  = 150
 *   50 Indizes × (IBKR, PAPER)         = 100
 *   22 Rohstoffe × (IBKR, PAPER)       =  44
 *   30 Kryptos × (BINANCE, PAPER)      =  60
 *   ─────────────────────────────────────────
 *   gesamt                             = 354
 *
 * Bestehende Instrumente werden per Upsert aktualisiert, nie gelöscht — die
 * Funktion ist idempotent (fester `lastSeen`-Zeitstempel).
 *
 * @throws Error wenn der Preset-Vertrag verletzt ist ({@link assertPresetContract}).
 */
export function buildPresetInstruments(options: PresetBuildOptions = {}): InstrumentInput[] {
  assertPresetContract();
  const withMirror = options.withPaperMirror !== false;
  const paperShort = options.paperShortAvailable !== false;
  const out: InstrumentInput[] = [];

  // ── 1) Aktien: ALPACA (fractional, gebührenfrei) + IBKR (1 Stück, 5 bp) ──
  for (const entry of PRESET_EQUITIES) {
    out.push({
      ...presetBase("ALPACA", entry.symbol, entry.base, entry.quote, "equity", "spot", true, true, false),
      minQuantity: 0.001,
      quantityStep: 0.001,
      priceStep: 0.01,
      takerFee: 0,
    });
    out.push({
      ...presetBase("IBKR", entry.symbol, entry.base, entry.quote, "equity", "spot", true, true, false),
      minQuantity: 1,
      quantityStep: 1,
      priceStep: 0.01,
      takerFee: 0.0005,
    });
    if (withMirror) out.push(paperMirror(entry, "equity", entry.symbol, paperShort));
  }

  // ── 2) Indizes: IBKR-CFD (Hebel + Short real verfügbar) ──
  for (const entry of PRESET_INDICES) {
    out.push({
      ...presetBase("IBKR", entry.symbol, entry.base, entry.quote, "index", "cfd", true, true, true),
      minQuantity: 1,
      quantityStep: 1,
      priceStep: 0.1,
      takerFee: 0.0002,
    });
    if (withMirror) out.push(paperMirror(entry, "index", entry.symbol, paperShort));
  }

  // ── 3) Rohstoffe: IBKR Continuous Futures ──
  for (const entry of PRESET_COMMODITIES) {
    out.push({
      ...presetBase("IBKR", entry.symbol, entry.base, entry.quote, "commodity", "future", true, true, true),
      minQuantity: entry.minQuantity,
      quantityStep: entry.minQuantity,
      priceStep: entry.priceStep,
      takerFee: 0.0002,
    });
    if (withMirror) out.push(paperMirror(entry, "commodity", entry.symbol, paperShort));
  }

  // ── 4) Krypto: BINANCE Spot (kein Short — Spot, kein Margin modelliert) ──
  for (const entry of PRESET_CRYPTO) {
    out.push({
      ...presetBase("BINANCE", entry.symbol, entry.base, entry.quote, "crypto", "spot", true, false, false),
      minQuantity: entry.minQuantity,
      quantityStep: entry.minQuantity,
      priceStep: entry.priceStep,
      makerFee: 0.001,
      takerFee: 0.001,
    });
    if (withMirror) {
      const base = entry.base ?? entry.symbol;
      out.push(paperMirror(entry, "crypto", base, paperShort));
    }
  }

  // Seed-Invariante: `liveAvailable` ist Laufzeitprojektion und im Seed verboten.
  for (const record of out) assertSeedRecordHasNoLiveAvailable(record);
  return out;
}

/** Preset-Instrumente als Konstante (deterministisch, keine Seiteneffekte). */
export const PRESET_INSTRUMENTS: readonly InstrumentInput[] = buildPresetInstruments();

/**
 * Preset-Zusammenfassung für Logs/Reports (keine Persistenz).
 */
export function presetSummary(): {
  equities: number;
  indices: number;
  commodities: number;
  crypto: number;
  instruments: number;
} {
  return {
    equities: PRESET_EQUITIES.length,
    indices: PRESET_INDICES.length,
    commodities: PRESET_COMMODITIES.length,
    crypto: PRESET_CRYPTO.length,
    instruments: PRESET_INSTRUMENTS.length,
  };
}
