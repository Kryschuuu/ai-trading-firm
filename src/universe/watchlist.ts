/**
 * UI-Watchlist — **reine Präferenzschicht**, keine Marktdefinition mehr.
 *
 * Vor Task 01 war `DEFAULT_WATCHLIST` in `src/lib/marketData.ts` die faktische
 * Definition des handelbaren Universums (9 Symbole). Seit Task 01 ist die
 * **Instrument-Registry** die Quelle der Wahrheit; die Watchlist ist nur noch
 * eine geordnete Liste von *Referenzen auf Instrument-IDs*, die das Dashboard
 * standardmäßig anzeigt.
 *
 * Faustregel: Wer wissen will, **was handelbar ist**, fragt die Registry.
 * Wer wissen will, **was zuerst angezeigt wird**, liest diese Datei.
 */

/** Ein Eintrag der Standard-Watchlist. */
export interface WatchlistEntry {
  /** Referenz auf ein Instrument der Registry (`VENUE:SYMBOL`). */
  instrumentId: string;
  /** Kurzform für die Anzeige und für Legacy-Pfade (Paper-Broker, Kursquelle). */
  displaySymbol: string;
  /** Kurzbeschreibung für Tooltips. */
  label: string;
}

/**
 * Standard-Anzeigeliste des Dashboards. Alle Einträge zeigen auf
 * PAPER-Instrumente, weil der Auslieferungszustand reines Paper-Trading ist —
 * die gleichen Underlyings existieren in der Registry zusätzlich an den
 * Live-Venues (BINANCE/KRAKEN/ALPACA/IBKR).
 */
export const UI_WATCHLIST_PREFERENCE: readonly WatchlistEntry[] = [
  { instrumentId: "PAPER:BTC", displaySymbol: "BTC", label: "Bitcoin (Paper)" },
  { instrumentId: "PAPER:ETH", displaySymbol: "ETH", label: "Ethereum (Paper)" },
  { instrumentId: "PAPER:SOL", displaySymbol: "SOL", label: "Solana (Paper)" },
  { instrumentId: "PAPER:SPY", displaySymbol: "SPY", label: "S&P-500-ETF (Paper)" },
  { instrumentId: "PAPER:QQQ", displaySymbol: "QQQ", label: "Nasdaq-100-ETF (Paper)" },
  { instrumentId: "PAPER:NVDA", displaySymbol: "NVDA", label: "NVIDIA (Paper)" },
  { instrumentId: "PAPER:AAPL", displaySymbol: "AAPL", label: "Apple (Paper)" },
  { instrumentId: "PAPER:MSFT", displaySymbol: "MSFT", label: "Microsoft (Paper)" },
  { instrumentId: "PAPER:EURUSD=X", displaySymbol: "EURUSD=X", label: "EUR/USD (Paper)" },
];

/** Die Anzeige-Symbole der Watchlist in Reihenfolge (Legacy-Kompatibilität). */
export const WATCHLIST_DISPLAY_SYMBOLS: readonly string[] = UI_WATCHLIST_PREFERENCE.map(
  (e) => e.displaySymbol,
);

/** Die referenzierten Instrument-IDs in Reihenfolge. */
export const WATCHLIST_INSTRUMENT_IDS: readonly string[] = UI_WATCHLIST_PREFERENCE.map(
  (e) => e.instrumentId,
);
