/**
 * Claude Trading Indicator (CTI) — Textausgaben.
 *
 * Das Pine-Skript zeichnet eine Dashboard-Tabelle und definiert zwei
 * Alert-Texte. Beides ist hier als reine Funktion über einen {@link CtiBar}
 * abgebildet — gleiche Beschriftungen, gleiche Reihenfolge, gleiche
 * Alert-Wortlaute, damit Chart, CLI und Log dieselbe Sprache sprechen.
 *
 * Keine Farben, kein Layout-Zustand: Darstellung ist Sache des Aufrufers
 * (CLI, Report, UI). Diese Datei hat keine IO und keinen Zustand.
 */

import type { CtiParams } from "./params";
import type { CtiBar, CtiVote } from "./types";

/** Pines `voteLabel(v)` — „Bullish" / „Bearish" / „Neutral". */
export function ctiVoteLabel(vote: CtiVote): "Bullish" | "Bearish" | "Neutral" {
  return vote === 1 ? "Bullish" : vote === -1 ? "Bearish" : "Neutral";
}

/** Pines Verdikt-Text der letzten Dashboard-Zeile. */
export function ctiVerdictLabel(bar: CtiBar): "BUY ZONE" | "SELL ZONE" | "No Consensus" {
  return bar.verdict === "BULL" ? "BUY ZONE" : bar.verdict === "BEAR" ? "SELL ZONE" : "No Consensus";
}

/** Eine Zeile der Dashboard-Tabelle. */
export interface CtiDashboardRow {
  label: string;
  value: string;
}

/**
 * Die Dashboard-Tabelle des Skripts als Datenzeilen (Kopf + vier
 * Dimensionen + Verdikt). Abgeschaltete Dimensionen zeigen „Off" — exakt
 * wie `useTrend ? voteLabel(trendVote) : "Off"` im Original.
 */
export function ctiDashboardRows(bar: CtiBar, params: Readonly<CtiParams>): CtiDashboardRow[] {
  return [
    {
      label: "CLAUDE TRADING INDICATOR",
      value: `${bar.bullCount}B / ${bar.bearCount}S / ${bar.enabledCount}`,
    },
    { label: "Trend", value: params.useTrend ? ctiVoteLabel(bar.dimensions.trend) : "Off" },
    { label: "Momentum", value: params.useMomentum ? ctiVoteLabel(bar.dimensions.momentum) : "Off" },
    { label: "Volatility", value: params.useVolatility ? ctiVoteLabel(bar.dimensions.volatility) : "Off" },
    { label: "Volume", value: params.useVolume ? ctiVoteLabel(bar.dimensions.volume) : "Off" },
    { label: "Verdict", value: ctiVerdictLabel(bar) },
  ];
}

/** Rendert {@link ctiDashboardRows} als monospace-Block für CLI/Logs. */
export function renderCtiDashboard(bar: CtiBar, params: Readonly<CtiParams>): string {
  const rows = ctiDashboardRows(bar, params);
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const valueWidth = Math.max(...rows.map((row) => row.value.length));
  const line = `+-${"-".repeat(labelWidth)}-+-${"-".repeat(valueWidth)}-+`;
  const body = rows.map((row) => `| ${row.label.padEnd(labelWidth)} | ${row.value.padEnd(valueWidth)} |`);
  return [line, body[0], line, ...body.slice(1), line].join("\n");
}

/**
 * Die Alert-Nachricht des Skripts:
 * `Claude Trading Indicator: BUY signal on {{ticker}} ({{interval}})`.
 *
 * `null`, wenn der Bar kein Signal trägt — der Aufrufer soll nicht raten
 * müssen, ob eine leere Zeichenkette „kein Signal" bedeutet.
 */
export function ctiAlertMessage(
  bar: CtiBar,
  context: { ticker: string; interval: string },
): string | null {
  if (bar.signal === null) return null;
  return `Claude Trading Indicator: ${bar.signal} signal on ${context.ticker} (${context.interval})`;
}
