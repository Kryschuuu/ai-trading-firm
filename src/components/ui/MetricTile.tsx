/**
 * Kennzahl-Kachel (`MetricTile`) — die eine Kachel für alle Zahlen (v0.15.0).
 *
 * Vorher gab es zwei fast identische Kacheln: `Stat` (Statusleiste) und
 * `KpiTile` (Reports). Beide rendern jetzt diese Komponente; Unterschiede
 * sind über Props (`tone`, `sub`, `emphasis`) ausgedrückt statt dupliziert.
 *
 * Darstellung: Label mit optionalem InfoTip, großer tabellarischer Wert,
 * optionale Unterzeile. `tone` färbt den Wert (gut/schlecht/neutral).
 */

import { cx } from "./cx";
import { LABEL, PANEL_PADDED } from "./layout";
import InfoTip from "./InfoTip";

export type MetricTone = "neutral" | "good" | "bad" | "warn";

const TONE_CLASS: Record<MetricTone, string> = {
  neutral: "text-slate-100",
  good: "text-emerald-400",
  bad: "text-red-400",
  warn: "text-amber-300",
};

export default function MetricTile({
  label,
  value,
  hint,
  sub,
  tone = "neutral",
  /** Rot umrandete Kachel — für Zustände, die sofort auffallen müssen (Not-Halt). */
  alarm = false,
  /**
   * Ladezustand: Der **Wert** wird zum Platzhalterbalken, Label und InfoTip
   * bleiben sichtbar. Wichtig ist genau das: Eine „0“ während des Ladens wäre
   * eine Falschaussage (Paper-Equity 0 $, Drawdown 0 %), die Kennzahl-Bezeichnung
   * dagegen hilft beim Einordnen, sobald der Wert eintrifft.
   */
  loading = false,
  className,
}: {
  label: string;
  value: string;
  /** Kurzdefinition für Hover/InfoTip — Kennzahlen ohne Erklärung sind im Betrieb wertlos. */
  hint?: string;
  sub?: string;
  tone?: MetricTone;
  alarm?: boolean;
  loading?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cx(
        PANEL_PADDED,
        "min-w-0",
        alarm ? "border-red-700 bg-red-950/40" : undefined,
        className
      )}
    >
      <p className={cx("flex items-center", LABEL)}>
        <span className="min-w-0 truncate" title={label}>
          {label}
        </span>
        {hint && <InfoTip label={label} text={hint} />}
      </p>
      <p
        className={cx(
          "mt-1 text-lg font-bold tabular-nums",
          alarm ? "text-red-400" : TONE_CLASS[tone]
        )}
      >
        {loading ? (
          <span
            className="inline-block h-5 w-16 animate-pulse rounded bg-slate-800"
            aria-hidden="true"
          />
        ) : (
          value
        )}
      </p>
      {sub && <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{sub}</p>}
    </div>
  );
}
