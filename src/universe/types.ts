/**
 * Datenmodell des Instrument-Universums (Task 01).
 *
 * Kernidee: **Symbol ≠ Markt.** Ein ökonomisches Underlying (z. B. BTC) kann an
 * mehreren Venues und in mehreren Markttypen handelbar sein
 * (`BINANCE:BTCUSDT` Spot, `KRAKEN:BTC/USD` Spot, `BITUNIX:BTCUSDT` Perpetual).
 * Das sind drei **Instrumente**, ein **Asset** und ein **Underlying**.
 *
 * Dieses Modul ist rein deterministisch: keine Netzwerk-Calls, kein LLM,
 * keine Broker-SDKs. Der Kern kennt nur dieses Schema und Capability-Flags.
 */

/** Anlageklasse eines Instruments. */
export type AssetClass = "crypto" | "equity" | "etf" | "fx" | "commodity" | "index" | "other";

/** Markttyp — bestimmt Kontraktmechanik (Hebel, Funding, Verfall). */
export type MarketType = "spot" | "perpetual" | "future" | "option" | "cfd";

/** Handelbarkeitszustand aus Sicht der Registry. */
export type InstrumentStatus = "active" | "halted" | "delisted" | "preview";

/** Alle gültigen Werte je Enum-Feld — Single Source of Truth für Validierung und Doku. */
export const ASSET_CLASSES: readonly AssetClass[] = [
  "crypto",
  "equity",
  "etf",
  "fx",
  "commodity",
  "index",
  "other",
];

/** Alle gültigen Markttypen. */
export const MARKET_TYPES: readonly MarketType[] = ["spot", "perpetual", "future", "option", "cfd"];

/** Alle gültigen Status-Werte. */
export const INSTRUMENT_STATUSES: readonly InstrumentStatus[] = [
  "active",
  "halted",
  "delisted",
  "preview",
];

/**
 * Venues, die das Projekt heute kennt (Doku/Seed).
 *
 * BEWUSST keine Union im Typ `MarketInstrument.venue`: Broker-Unabhängigkeit
 * bedeutet, dass eine neue Venue (z. B. `BITUNIX`) ohne Code-Änderung im Kern
 * aufgenommen werden kann. Validiert wird nur das *Format* (siehe `VENUE_RE`).
 */
export const KNOWN_VENUES = [
  "PAPER",
  "ALPACA",
  "IBKR",
  "BINANCE",
  "KRAKEN",
  "DYDX",
  "BITUNIX",
] as const;

/** Typ-Alias für die bekannten Venues (nur Komfort, keine Schranke). */
export type KnownVenue = (typeof KNOWN_VENUES)[number];

/**
 * Ein handelbares Instrument an genau einer Venue — der zentrale Contract.
 *
 * `id` ist immer `"<VENUE>:<SYMBOL>"` und damit stabil sortierbar und
 * venue-übergreifend eindeutig.
 */
export interface MarketInstrument {
  /** Kanonische ID `"<VENUE>:<SYMBOL>"`, z. B. `"BINANCE:BTCUSDT"`. */
  id: string;
  /** Handelsplatz in Großbuchstaben, z. B. `"BINANCE"`, `"KRAKEN"`, `"PAPER"`. */
  venue: string;
  /** Venue-natives Symbol, z. B. `"BTCUSDT"`, `"BTC/USD"`, `"SPY"`. */
  symbol: string;
  /** Basis-Asset bei Paaren (`"BTC"`), sonst `null`. */
  base: string | null;
  /** Quote-/Abrechnungswährung, z. B. `"USDT"`, `"USD"`. */
  quote: string;
  /** Anlageklasse. */
  assetClass: AssetClass;
  /** Markttyp (Spot, Perpetual, …). */
  marketType: MarketType;
  /** Handelbarkeitszustand. */
  status: InstrumentStatus;
  /** Kleinste handelbare Menge (> 0). */
  minQuantity: number;
  /** Preis-Tick (> 0). */
  priceStep: number;
  /** Mengen-Tick (> 0). */
  quantityStep: number;
  /** Maker-Gebühr als Dezimalanteil (0.001 = 0,1 %). */
  makerFee: number;
  /** Taker-Gebühr als Dezimalanteil. */
  takerFee: number;
  /** Hebel an dieser Venue für dieses Instrument verfügbar? */
  leverageAvailable: boolean;
  /** Short-Verkauf möglich? */
  shortAvailable: boolean;
  /** Im Paper-Modus handelbar (Kurse/Simulation vorhanden)? */
  paperAvailable: boolean;
  /**
   * Live handelbar an dieser Venue (reine FÄHIGKEITS-Angabe des Instruments —
   * das Instrument ist beim Broker für reale Orders zulässig). BEWUSST getrennt von:
   *   - `adapterCapabilities.live`  (Broker-Adapter kann Live-Orders serialisieren)
   *   - `venueControl.liveEnabled`  (globale Freigabe durch die Control Plane)
   *   - `liveGate.state`            (persistierter Gate-Zustand, öffnet erst die Ausführung)
   * `liveTradable=true` bedeutet NICHT, dass Live-Orders aktuell erlaubt sind.
   */
  liveTradable: boolean;
  /**
   * @deprecated Mehrdeutig (Fähigkeit vs. Freigabe). Behalte Feld für
   * Abwärtskompatibilität; neue Verwendungen sollen `liveTradable` nutzen.
   * Gibt NICHT an, ob Live-Trading freigegeben ist (das entscheidet `liveGate.state`
   * + `venueControl.liveEnabled`), sondern nur, ob das Instrument grundsätzlich
   * live-gehandelt werden kann. Wird von der Normalisierung aus `liveTradable`
   * (bzw. Eingabe) synchron gehalten.
   */
  liveAvailable: boolean;
  /** 24-h-Volumen in Quote-Währung; `null` bis ein späterer Task es füllt. */
  volume24h: number | null;
  /** Relativer Spread (0.0004 = 4 bp); `null` bis befüllt. */
  spread: number | null;
  /** Annualisierte Volatilität als Dezimalanteil; `null` bis befüllt. */
  volatility: number | null;
  /** Zeitpunkt der letzten Bestätigung durch eine Quelle, ISO-8601 UTC. */
  lastSeen: string;
}

/** Feldnamen des Contracts in kanonischer Reihenfolge (Doku, Validierung, Tests). */
export const INSTRUMENT_FIELDS: readonly (keyof MarketInstrument)[] = [
  "id",
  "venue",
  "symbol",
  "base",
  "quote",
  "assetClass",
  "marketType",
  "status",
  "minQuantity",
  "priceStep",
  "quantityStep",
  "makerFee",
  "takerFee",
  "leverageAvailable",
  "shortAvailable",
  "paperAvailable",
  "liveTradable",
  "liveAvailable",
  "volume24h",
  "spread",
  "volatility",
  "lastSeen",
];

/**
 * Ein ökonomisches Asset (venue-unabhängig), z. B. `BTC`, `SPY`, `EUR`.
 * Aus einem Instrument ableitbar — nie separat persistiert.
 */
export interface Asset {
  /** Kanonische Asset-ID (= `symbol`). */
  id: string;
  /** Ticker in Großbuchstaben, z. B. `"BTC"`. */
  symbol: string;
  /** Anlageklasse des Assets. */
  assetClass: AssetClass;
}

/**
 * Das ökonomische Underlying eines Instruments: die Exposure, die man beim
 * Handel eingeht. `BINANCE:BTCUSDT`, `KRAKEN:BTC/USD` und `BITUNIX:BTCUSDT`
 * (Perp) haben alle das Underlying `BTC`.
 */
export interface Underlying {
  /** Kanonische Underlying-ID, z. B. `"BTC"`. */
  id: string;
  /** Zugehöriges Asset. */
  assetId: string;
  /** Anlageklasse. */
  assetClass: AssetClass;
}

/**
 * Instrument inklusive abgeleiteter Beziehungen (Asset/Underlying).
 * Wird von der Registry auf Wunsch geliefert, aber nicht persistiert —
 * die Ableitung ist deterministisch (siehe `normalization.ts`).
 */
export interface Instrument extends MarketInstrument {
  /** ID des zugehörigen Assets. */
  assetId: string;
  /** ID des ökonomischen Underlyings. */
  underlyingId: string;
}

/** Eingabeform für Upserts: Metriken und Defaults sind optional. */
export type InstrumentInput = Partial<MarketInstrument> & {
  venue: string;
  symbol: string;
};

/** Filter für `registry.query()`. Alle Felder sind optional (UND-verknüpft). */
export interface InstrumentQuery {
  /** Eine oder mehrere Venues. */
  venue?: string | string[];
  /** Eine oder mehrere Anlageklassen. */
  assetClass?: AssetClass | AssetClass[];
  /** Ein oder mehrere Markttypen. */
  marketType?: MarketType | MarketType[];
  /** Ein oder mehrere Status-Werte. */
  status?: InstrumentStatus | InstrumentStatus[];
  /** Nur Instrumente mit `paperAvailable === true|false`. */
  paperAvailable?: boolean;
  /** Nur Instrumente mit `liveTradable === true|false` (Fähigkeit am Broker). */
  liveTradable?: boolean;
  /** Nur Instrumente mit `liveAvailable === true|false` (Kompatibilitäts-Spiegel). */
  liveAvailable?: boolean;
  /** Nur Instrumente mit Hebel-Verfügbarkeit. */
  leverageAvailable?: boolean;
  /** Nur Instrumente mit Short-Verfügbarkeit. */
  shortAvailable?: boolean;
  /** Basis-Asset, z. B. `"BTC"`. */
  base?: string;
  /** Quote-Währung, z. B. `"USD"`. */
  quote?: string;
  /** Underlying-ID, z. B. `"BTC"` (matcht über alle Venues/Typen). */
  underlying?: string;
  /** Mindest-24h-Volumen; Instrumente mit `null` werden ausgeschlossen. */
  minVolume24h?: number;
  /** Maximaler Spread; Instrumente mit `null` werden ausgeschlossen. */
  maxSpread?: number;
  /** Maximale Volatilität; Instrumente mit `null` werden ausgeschlossen. */
  maxVolatility?: number;
  /** Freitext-Teilstring auf `id` (case-insensitive, kein Regex). */
  search?: string;
  /** 1-basierte Seite. */
  page?: number;
  /** Seitengröße, hart geklemmt auf `MAX_PAGE_SIZE` (500). */
  pageSize?: number;
}

/** Ergebnis einer Query inklusive Pagination-Metadaten. */
export interface QueryResult {
  /** Treffer der aktuellen Seite, stabil nach `id` sortiert. */
  items: MarketInstrument[];
  /** Gesamttrefferzahl über alle Seiten. */
  total: number;
  /** 1-basierte Seite. */
  page: number;
  /** Effektive Seitengröße nach Klemmung. */
  pageSize: number;
  /** true, wenn weitere Seiten existieren. */
  hasMore: boolean;
}

/** Rückmeldung eines abgelehnten Upserts (Validierung oder Policy). */
export interface RejectedInstrument {
  /** Kennung des Eingabesatzes (best effort, gekürzt). */
  ref: string;
  /** Maschinenlesbarer Code, z. B. `VALIDATION_ERROR`, `POLICY_EXCLUDED`. */
  code: string;
  /** Menschenlesbare Begründung ohne Secrets. */
  message: string;
}

/** Ergebnis eines (Batch-)Upserts. */
export interface UpsertResult {
  /** Neu angelegte Instrumente. */
  created: number;
  /** Aktualisierte Instrumente. */
  updated: number;
  /** Unverändert (identischer Inhalt). */
  unchanged: number;
  /** Abgelehnte Eingaben mit Begründung. */
  rejected: RejectedInstrument[];
  /** IDs der akzeptierten Instrumente, sortiert. */
  ids: string[];
}
