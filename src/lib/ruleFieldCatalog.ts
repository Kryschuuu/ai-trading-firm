/**
 * Whitelist der Regel-Felder (VBF-P2-02).
 *
 * Getrennt von `ruleEngine`, damit die Workshop-Oberfläche die Liste
 * importieren kann, ohne die Ausführungsschicht in den Client zu ziehen.
 * `ruleEngine` re-exportiert `RULE_FIELDS` — das bleibt die einzige
 * Allowlist für `sanitizeRuleSpec`.
 */

export const RULE_FIELDS = {
  price: "number",
  rsi14: "number",
  ema9: "number",
  ema21: "number",
  ema50: "number",
  atrPct: "number",
  volume: "number",
  volumeMa20: "number",
  volumeRatio: "number",
  changePct24h: "number",
  priceVsEma21Pct: "number",
  priceVsEma50Pct: "number",
  trend: "trend",
  /** Wilder-ADX(14). null im Snapshot, solange weniger als 29 Kerzen da sind. */
  adx14: "number",
  /**
   * Bollinger-Bandbreite in Prozent (5 = 5 %). Nicht der Bruch aus
   * `bollingerBandWidthPct` und nicht der Dashboard-Key `adp.bbwHighPct`.
   */
  bbwPct: "number",
  /** MACD-Linie (12/26), Preiseinheiten. */
  macd: "number",
  /** Signal-Linie (EMA 9 der MACD-Linie). */
  macdSignal: "number",
  /** Histogramm = MACD − Signal. */
  macdHist: "number",
} as const;

export const RULE_FIELD_LABELS: Record<keyof typeof RULE_FIELDS, string> = {
  price: "Letzter Kurs",
  rsi14: "RSI (14)",
  ema9: "EMA 9",
  ema21: "EMA 21",
  ema50: "EMA 50",
  atrPct: "ATR in Prozent des Kurses",
  volume: "Volumen der letzten Kerze",
  volumeMa20: "Volumen-Schnitt (20)",
  volumeRatio: "Volumen / 20er-Schnitt",
  changePct24h: "Änderung über 24 Kerzen, Prozent",
  priceVsEma21Pct: "Kurs vs. EMA 21, Prozent",
  priceVsEma50Pct: "Kurs vs. EMA 50, Prozent",
  trend: "Trend (UP, DOWN, FLAT)",
  adx14: "ADX (14), 0–100",
  bbwPct: "Bollinger-Breite, Prozent (5 = 5 %)",
  macd: "MACD-Linie (12/26)",
  macdSignal: "MACD-Signal (9)",
  macdHist: "MACD-Histogramm",
};
