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
   * Misst die BREITE des Bandes — die Position des Kurses darin liefern
   * `bbZScore`, `priceVsUpperBbPct` und `priceVsLowerBbPct` (STX-02-02).
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
  /**
   * Position des Kurses im Bollinger-Band (20 Kerzen, 2 σ) in
   * Standardabweichungen: `(close − middle) / σ`. Dimensionslos, typisch
   * ±0…3; 0 = Bandmitte, ±2 = Bandkante. null bei zu wenig Historie,
   * `middle <= 0` oder σ == 0 (flache Kerzenreihe ⇒ keine Lage im Band).
   * Marktübergreifend, weil kein absoluter Kurs verglichen wird — das
   * Regelwerk bleibt „Messwert gegen Schwelle".
   */
  bbZScore: "number",
  /**
   * Abstand des Kurses zur OBEREN Bollinger-Kante (20 Kerzen, 2 σ) in Prozent
   * des Kurses: `(close − upper) / close · 100`. Typisch ≤ 0 (unterhalb der
   * Kante); > 0 heißt „Kurs bricht die obere Kante". null bei zu wenig
   * Historie oder `middle <= 0`.
   */
  priceVsUpperBbPct: "number",
  /**
   * Abstand des Kurses zur UNTEREN Bollinger-Kante (20 Kerzen, 2 σ) in Prozent
   * des Kurses: `(close − lower) / close · 100`. Typisch ≥ 0 (oberhalb der
   * Kante); < 0 heißt „Kurs bricht die untere Kante". null bei zu wenig
   * Historie oder `middle <= 0`.
   */
  priceVsLowerBbPct: "number",
  /**
   * Abstand des Schlusskurses zum Donchian-Kanalhoch in Prozent des Kurses:
   * `(close / upper − 1) · 100`. Bezug ist das Hoch der **vorigen** 20 Kerzen
   * (`DONCHIAN_ENTRY_PERIOD`, ohne die aktuelle Signalkerze) — > 0 heißt
   * „Ausbruch über den vorher bekannten Kanal“, kein Look-ahead.
   * null bei zu wenig Historie (unter 21 Kerzen ⇒ kein Kanal) oder
   * `upper <= 0` — nie eine 0 als Ersatz. Eine echte 0 = Kurs exakt am
   * Kanalhoch. Die Fensterlänge ist KEIN Regelfeld: sie gehört als Parameter
   * in das Donchian-Template (03-08), nicht in den Snapshot (STX-02-03).
   */
  donchianBreakoutPct: "number",
} as const;

/**
 * Einheit + typische Werte je Feld für das LLM-Schema (`RULE_LLM_SCHEMA`).
 *
 * Bewusst nur für Felder, deren Einheit sich nicht von selbst liest — die
 * Aufzählung selbst bleibt `Object.keys(RULE_FIELDS)`. Der Text steht hier
 * neben dem UI-Label, damit Einheit, Label und LLM-Hinweis nicht auseinander
 * laufen (SSoT des Feldkatalogs); die Workshop-Oberfläche und das Schema lesen
 * beide aus dieser Datei.
 */
export const RULE_FIELD_SCHEMA_HINTS: Partial<Record<keyof typeof RULE_FIELDS, string>> = {
  bbZScore:
    "Kurs minus 20er-Mitte in Standardabweichungen (0 = Mitte, 2 = obere Kante, −2 = untere Kante; typisch −3…3)",
  priceVsUpperBbPct:
    "Kurs minus obere Bollinger-Kante in Prozent des Kurses (0 = genau auf der Kante, 0.4 = 0,4 % darüber; typisch −5…1)",
  priceVsLowerBbPct:
    "Kurs minus untere Bollinger-Kante in Prozent des Kurses (0 = genau auf der Kante, −0.4 = 0,4 % darunter; typisch −1…5)",
  donchianBreakoutPct:
    "Kurs gegen das Hoch der VORIGEN 20 Kerzen (Donchian-Kanal ohne Signalkerze) in Prozent des Kurses (0 = genau am Kanalhoch, 1 = 1 % darüber; typisch −10…5); positiv = Ausbruch über den vorher bekannten Kanal, null unter 21 Kerzen",
};

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
  bbZScore: "Kurs vs. Bollinger-Mitte (20/2σ), Standardabweichungen (0 = Mitte, 2 = obere Kante)",
  priceVsUpperBbPct: "Kurs vs. obere Bollinger-Kante, Prozent (positiv = über der Kante)",
  priceVsLowerBbPct: "Kurs vs. untere Bollinger-Kante, Prozent (negativ = unter der Kante)",
  donchianBreakoutPct:
    "Kurs vs. Hoch der vorigen 20 Kerzen (Donchian), Prozent (positiv = Ausbruch darüber)",
};
