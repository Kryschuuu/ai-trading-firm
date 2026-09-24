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
  /**
   * Kurs gegen den Session-VWAP in Prozent (1.5 = 1,5 % über dem
   * volumen-gewichteten Tagesdurchschnitt). Tagesanker ist der
   * UTC-Kalendertag der letzten Kerze — die Referenz des Daytradings,
   * bewusst relativ (über/unter VWAP), damit eine Regel über Märkte mit
   * verschiedenen Kursniveaus läuft.
   */
  vwapPct: "number",
  /**
   * Relativer Spread in Prozent (0.04 = 0,04 % = 4 bp). Orderbuch-Top-Level
   * (ask-bid)/mid. null = kein Orderbuch gemessen. Für Daytrading die
   * zentrale Kosten-/Liquiditätsgröße — hoher Spread frisst die Edge.
   */
  spreadPct: "number",
  /**
   * Orderbuch-Tiefe der abriegelnden Seite in Quote-Währung (USDT/USD):
   * min(Σ bid×qty, Σ ask×qty). null = keine belastbare Tiefe (kein Buch,
   * zu dünn, unter der Venue-Qualitätsgrenze). Zusammen mit `spreadPct` die
   * Liquiditätsprüfung des Daytradings — ein enger Spread ohne Tiefe ist
   * trotzdem teuer, sobald man größenordnungsmäßig handelt.
   */
  bookDepthUsd: "number",
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
  // Der Name ist historisch, die Rechnung nicht: bezogen wird die Kerze vor
  // 97 Perioden — auf `1h` also ~4 Tage, auf `5m` ~8 Stunden, auf `1m` ~1,6 h.
  // Label und Doku sagen das jetzt; die Rechnung bleibt (eine Korrektur würde
  // bestehende Regeln und ihre Backtests still umwerten — Versionssache, kein
  // Nebenprodukt dieses Zyklus, siehe Audit „Offene Punkte“).
  changePct24h: "Änderung ggü. der Kerze vor 97 Perioden, Prozent (nicht 24 h)",
  priceVsEma21Pct: "Kurs vs. EMA 21, Prozent",
  priceVsEma50Pct: "Kurs vs. EMA 50, Prozent",
  trend: "Trend (UP, DOWN, FLAT)",
  adx14: "ADX (14), 0–100",
  bbwPct: "Bollinger-Breite, Prozent (5 = 5 %)",
  macd: "MACD-Linie (12/26)",
  macdSignal: "MACD-Signal (9)",
  macdHist: "MACD-Histogramm",
  vwapPct: "Kurs vs. Tages-VWAP, Prozent (positiv = über dem VWAP)",
  spreadPct: "Spread in Prozent (0,04 = 0,04 % = 4 bp, null = kein Orderbuch)",
  bookDepthUsd: "Orderbuch-Tiefe der schwächeren Seite in USD (null = keine belastbare Tiefe)",
};
