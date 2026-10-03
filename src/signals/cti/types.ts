/**
 * Claude Trading Indicator (CTI) — Datentypen eines ausgewerteten Bars.
 *
 * Reine Typen, keine Logik, keine IO. Der Zustand eines Bars ist bewusst
 * VOLLSTÄNDIG abgebildet (Komponentenwerte, Komponenten-Voten,
 * Dimensions-Voten, Verdikt, Streaks, Signal, Stops): Ein Signal, dessen
 * Zustandekommen man nicht nachlesen kann, ist im Zweifel nicht belegbar —
 * und genau diese Felder rendert das Dashboard, der Backtest-Report und das
 * Live-Log.
 */

/**
 * Strukturelle Kerze für den CTI. Kompatibel zu `CandleLike`
 * (`src/lib/ruleEngine`) und `Candle` (`src/lib/marketData`), ohne sie zu
 * importieren — der Signal-Kern bleibt frei von Engine-Abhängigkeiten.
 * `open` wird vom Indikator nicht gelesen und deshalb nicht verlangt.
 */
export interface CtiCandle {
  /** Eröffnungszeit der Kerze in Epoch-Millisekunden (streng aufsteigend). */
  readonly time: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** Votum einer Komponente/Dimension: `1` bullisch, `-1` bärisch, `0` neutral. */
export type CtiVote = -1 | 0 | 1;

/** Zwei-Stufen-Konsens über alle AKTIVEN Dimensionen. */
export type CtiVerdict = "BULL" | "BEAR" | "NONE";

/** Ausgelöstes Signal eines Bars. */
export type CtiSignalKind = "BUY" | "SELL";

/** Voten der acht Komponenten-Indikatoren (Tier 1). */
export interface CtiComponentVotes {
  /** `close` gegen `ta.ema(close, 200)`. */
  ema: CtiVote;
  /** `ta.supertrend(3, 10)`-Richtung (`-1` = Aufwärtstrend ⇒ bullisch). */
  supertrend: CtiVote;
  /** `close` gegen die Bollinger-Basis `ta.sma(close, 20)`. */
  bollinger: CtiVote;
  /** MACD-Linie gegen ihre Signallinie. */
  macd: CtiVote;
  /** `ta.rsi(close, 14)` gegen 50. */
  rsi: CtiVote;
  /** `%K` gegen `%D`. */
  stoch: CtiVote;
  /** `+DI` gegen `−DI` (nur wenn `ADX >= 20`, sonst neutral). */
  dmi: CtiVote;
  /** OBV gegen `ta.sma(obv, 10)`. */
  obv: CtiVote;
}

/** Voten der vier Marktdimensionen (Tier 2 — je einstimmig aus Tier 1). */
export interface CtiDimensionVotes {
  trend: CtiVote;
  momentum: CtiVote;
  volatility: CtiVote;
  volume: CtiVote;
}

/** Rohwerte aller Komponenten eines Bars (`null` = `na`, nie eine erfundene 0). */
export interface CtiReadings {
  ema: number | null;
  supertrendLine: number | null;
  /** `-1` = Aufwärtstrend, `1` = Abwärtstrend (Pine-Konvention). */
  supertrendDirection: -1 | 1;
  bollingerUpper: number | null;
  bollingerBasis: number | null;
  bollingerLower: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  rsi: number | null;
  stochK: number | null;
  stochD: number | null;
  diPlus: number | null;
  diMinus: number | null;
  adx: number | null;
  obv: number | null;
  obvMa: number | null;
  /** `ta.atr(atrLength)` — Grundlage der Stop-Distanz. */
  atr: number | null;
}

/** Vollständig ausgewerteter Bar. */
export interface CtiBar {
  /** 0-basierter Bar-Index innerhalb der gefütterten Reihe (Pines `bar_index`). */
  index: number;
  /** Kerzenzeit in Epoch-ms. */
  time: number;
  /** Schlusskurs dieser Kerze. */
  close: number;
  readings: CtiReadings;
  votes: CtiComponentVotes;
  dimensions: CtiDimensionVotes;
  /** Anzahl eingeschalteter Dimensionen (`enabledCount` im Dashboard). */
  enabledCount: number;
  /** Eingeschaltete Dimensionen mit bullischem Votum. */
  bullCount: number;
  /** Eingeschaltete Dimensionen mit bärischem Votum. */
  bearCount: number;
  /** Einstimmiges Verdikt über alle aktiven Dimensionen. */
  verdict: CtiVerdict;
  /** Aufeinanderfolgende Bars mit `verdict === "BULL"` (inkl. diesem). */
  bullStreak: number;
  /** Aufeinanderfolgende Bars mit `verdict === "BEAR"` (inkl. diesem). */
  bearStreak: number;
  /** Signal dieses Bars (`null` = keines). */
  signal: CtiSignalKind | null;
  /**
   * Bars seit dem VORHERIGEN Signal (`null` = es gab bisher keines). Auf
   * einem Signalbar steht hier der Abstand zum letzten Signal — also exakt
   * die Zahl, die Pines Sperrfrist (`minBarsBetween`) geprüft hat.
   */
  barsSinceSignal: number | null;
  /** `close − atr · atrMultiplier` (Stop eines Long-Signals auf diesem Bar). */
  longStop: number | null;
  /** `close + atr · atrMultiplier` (Stop eines Short-Signals auf diesem Bar). */
  shortStop: number | null;
  /** Aktiver Long-Stop der laufenden Signalstrecke. */
  activeLongStop: number | null;
  /** Aktiver Short-Stop der laufenden Signalstrecke. */
  activeShortStop: number | null;
  /** Long-Strecke läuft noch (Kurs hat den Stop nicht durchhandelt). */
  inLongTrade: boolean;
  /** Short-Strecke läuft noch. */
  inShortTrade: boolean;
  /**
   * Der Kurs hat den aktiven Stop AUF DIESEM BAR durchhandelt
   * (`low <= activeLongStop` bzw. `high >= activeShortStop`). Pine beendet
   * damit die Stop-Linie; die Trading-Engine macht daraus den Ausstieg.
   */
  stopHit: "LONG" | "SHORT" | null;
}

/** Fehler bei unbrauchbaren Eingabedaten — fail-closed statt stiller Rechnung. */
export class CtiInputError extends Error {
  constructor(
    readonly code:
      | "INVALID_CANDLE"
      | "NON_MONOTONIC_TIME"
      | "DUPLICATE_BAR",
    message: string,
  ) {
    super(message);
    this.name = "CtiInputError";
  }
}
