/**
 * Verträge der deterministischen Multi-Timeframe-Konfluenz (RMA-P2-03).
 *
 * Die Konfluenz beantwortet genau eine Frage: **Zeigen die konfigurierten
 * Timeframes zum Entscheidungszeitpunkt in dieselbe Richtung?** Die Antwort
 * ist eine reine Funktion aus (Kerzen, as-of, Config) — kein LLM, keine Uhr,
 * kein Zufall. Gleiche Eingabe ⇒ byte-identischer Snapshot.
 *
 * Zeitsemantik (Point-in-Time, kein Look-ahead):
 *
 *   - `event_time`  — Kerzen-Öffnung `ts` (Venue-Konvention: Binance/Bitunix
 *     `time` ist die Perioden-ÖFFNUNG; der Store persistiert sie als `ts`).
 *   - `barEnd`      — `ts + timeframeMs` (erwartetes Periodenende).
 *   - `availableAt` — ab wann die Kerze dem Entscheider bekannt war
 *     (Store: `fetchedAt`; Live/Backtest: Injektion, sonst als verfügbar).
 *   - `asOf`        — gemeinsamer Entscheidungszeitpunkt (injiziert).
 *   - `computedAt`  — reine Protokollzeit (nie Entscheidungsgrundlage).
 *
 * Eine Kerze fließt nur ein, wenn sie **geschlossen** (`barEnd ≤ asOf`) **und**
 * **verfügbar** (`availableAt ≤ asOf`) ist. Die noch offene (insbesondere
 * höhere-Timeframe-)Kerze ist damit strukturell ausgeschlossen.
 *
 * Fail-closed: `direction`/`strength` sind `null` (nicht `0`!), sobald die
 * Coverage unter `minCoverage` liegt (Status `ABSTAIN`). Fehlende Timeframes
 * senken Coverage und Confidence — sie erhöhen sie nie.
 *
 * @packageDocumentation
 */

import type { SupportedTimeframe } from "@/lib/marketdata/historicalStore";

/**
 * Formelversion des Konfluenzsnapshots (erscheint in jedem Artefakt).
 * Eine Änderung der Gewichtung, Features oder Rundung erfordert einen Bump.
 */
export const CONFLUENCE_FORMULA_VERSION = "mtf-confluence@1" as const;

/** Config-Schema-Version (erscheint in jedem Artefakt). */
export const CONFLUENCE_CONFIG_VERSION = 1 as const;

/** Harte Obergrenze der Timeframes je Snapshot (DoS-/Komplexitätsschutz). */
export const MAX_CONFLUENCE_TIMEFRAMES = 5 as const;

/** Quellen-Kennungen für Telemetrie/Logs (geschlossenes Vokabular). */
export const CONFLUENCE_SOURCES = ["cycle", "analyst", "backtest", "scanner", "api"] as const;

/** Quelle einer Konfluenzberechnung (geschlossen, kein Freitext). */
export type ConfluenceSource = (typeof CONFLUENCE_SOURCES)[number];

/** Prüft einen Wert gegen die geschlossenen Quellen-Kennungen. */
export function isConfluenceSource(value: unknown): value is ConfluenceSource {
  return typeof value === "string" && (CONFLUENCE_SOURCES as readonly string[]).includes(value);
}

/** Status eines Konfluenzsnapshots (geschlossen). */
export const CONFLUENCE_STATUSES = ["OK", "DEGRADED", "ABSTAIN"] as const;

/**
 * Status eines Konfluenzsnapshots:
 *   - `OK`       — alle Timeframes verfügbar, Konflikt unter der Schwelle.
 *   - `DEGRADED` — Signal vorhanden, aber Timeframes fehlen ODER Konflikt
 *     über der Schwelle (Confidence entsprechend reduziert).
 *   - `ABSTAIN`  — Coverage unter `minCoverage`: KEIN Signal
 *     (`direction`/`strength`/`bias` sind `null`, `confidence` ist `0`).
 */
export type ConfluenceStatus = (typeof CONFLUENCE_STATUSES)[number];

/** Prüft einen Wert gegen die geschlossenen Status. */
export function isConfluenceStatus(value: unknown): value is ConfluenceStatus {
  return typeof value === "string" && (CONFLUENCE_STATUSES as readonly string[]).includes(value);
}

/** Richtung eines Snapshots / einer Timeframe-Komponente. */
export type ConfluenceBias = "BULLISH" | "BEARISH" | "NEUTRAL";

/** Geschlossene Gründe, warum ein Timeframe fehlt (kein Freitext). */
export const CONFLUENCE_MISSING_REASONS = [
  "no-closed-bars",
  "warmup",
  "stale",
  "invalid",
  "unavailable",
] as const;

/**
 * Grund, warum ein Timeframe nicht in den Snapshot einfloss:
 *   - `no-closed-bars` — keine einzige geschlossene+verfügbare Kerze ≤ asOf.
 *   - `warmup`         — zu wenige geschlossene Kerzen für die Features.
 *   - `stale`          — jüngstes Bar-Ende älter als die Stale-Schwelle.
 *   - `invalid`        — strukturell ungültige Kerzen im Rechenfenster.
 *   - `unavailable`    — Reihe gar nicht geliefert (z. B. Sync-Lücke).
 */
export type ConfluenceMissingReason = (typeof CONFLUENCE_MISSING_REASONS)[number];

/** Prüft einen Wert gegen die geschlossenen Missing-Gründe. */
export function isConfluenceMissingReason(value: unknown): value is ConfluenceMissingReason {
  return (
    typeof value === "string" && (CONFLUENCE_MISSING_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Eine Eingabekerze für die Konfluenz (minimales, venue-neutrales Format).
 * `time` ist die Perioden-ÖFFNUNG in Epoch-ms (Store-`ts`). `availableAtMs`
 * ist optional: fehlt es, gilt die Kerze als zum asOf-Zeitpunkt verfügbar
 * (Live-Pfad); Backtest-/Replay-Pfade injizieren die echte Verfügbarkeit,
 * damit später bekannte Korrekturen kein Look-ahead erzeugen.
 */
export interface ConfluenceCandle {
  /** Perioden-Öffnung (Epoch-ms, ganzzahlig, > 0). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Ab wann die Kerze bekannt war (Epoch-ms); `undefined` = verfügbar. */
  availableAtMs?: number;
}

/**
 * Eine Eingabereihe: alle (ggf. ungefilterten) Kerzen EINES Timeframes.
 * Die as-of-Ausrichtung (nur geschlossene+verfügbare Bars) übernimmt die
 * reine Funktion — der Aufrufer muss nicht vorfiltern (aber er darf).
 */
export interface ConfluenceSeriesInput {
  timeframe: SupportedTimeframe;
  candles: readonly ConfluenceCandle[];
}

/**
 * Vollständige Eingabe der reinen Funktion — alles injiziert, nichts implizit.
 * Die Reihenfolge der Reihen ist irrelevant (kanonische Sortierung innen).
 */
export interface ConfluenceInput {
  /** Instrument-ID (nur Protokoll/Schlüssel, nie Metrik-Label). */
  instrumentId: string;
  /** Gemeinsamer Entscheidungszeitpunkt (Epoch-ms, injizierte Uhr). */
  asOfMs: number;
  /** Eingabereihen (idealerweise alle konfigurierten Timeframes). */
  series: readonly ConfluenceSeriesInput[];
}

/** Normalisierte Features EINES Timeframes (alle gerundet, bounded). */
export interface TimeframeFeatures {
  /**
   * Trend ∈ [-1, 1]: normalisierte EMA-Lücke `(emaFast − emaSlow)/emaSlow`
   * durch `trendScale`, geklemmt. +1 = stark aufwärts gestaffelt.
   */
  trend: number;
  /**
   * Momentum ∈ [-1, 1]: gewichtete Rate-of-Change über die konfigurierten
   * Fenster durch `momentumScale`, geklemmt. +1 = starke Aufwärtsdynamik.
   */
  momentum: number;
  /**
   * Volatilität ∈ [0, 1]: ATR(14)/Close durch `volScale`, geklemmt.
   * Reine Streckungsanzeige — hohe Werte dämpfen die Confidence, sie drehen
   * die Richtung nie um.
   */
  volatility: number;
}

/** Beitrag EINES Timeframes zum Snapshot (Erklärung, kein Blackbox-Wert). */
export interface TimeframeContribution {
  timeframe: SupportedTimeframe;
  /** Konfiguriertes Gewicht (Anteil an 1.0, vor Re-Normalisierung). */
  weight: number;
  /**
   * Effektives Gewicht nach Re-Normalisierung über die verfügbaren
   * Timeframes (`0` bei fehlenden Timeframes).
   */
  effectiveWeight: number;
  /** Richtungskomponente ∈ [-1, 1] (`trend`/`momentum`-Mix). */
  direction: number;
  /** Überzeugungsstärke ∈ [0, 1] (`|direction|`). */
  strength: number;
  /** Die drei normalisierten Features (bounded, warmup-geprüft). */
  features: TimeframeFeatures;
  /** Verwendetes jüngstes Bar-Ende (Epoch-ms, geschlossen ≤ asOf). */
  barEndMs: number;
  /** Verwendetes jüngstes Bar-Ende (ISO-UTC, menschenlesbar). */
  barEnd: string;
  /** Anzahl geschlossener Bars, die in die Features einflossen. */
  barsUsed: number;
}

/** Ausweis EINES fehlenden Timeframes (sichtbar, fail-closed). */
export interface TimeframeMissing {
  timeframe: SupportedTimeframe;
  /** Konfiguriertes Gewicht (verlorener Coverage-Anteil). */
  weight: number;
  /** Geschlossener Grund (kein Freitext). */
  reason: ConfluenceMissingReason;
  /** Stabile, einzeilige Detailangabe (Zahlen, keine Fremdtexte). */
  detail: string;
}

/**
 * Deterministischer Multi-Timeframe-Konfluenzsnapshot.
 *
 * Jede Outputzahl ist auf Timeframebeiträge (`contributions`), Barzeiten
 * (`barEndMs`) und Gründe (`missing`) zurückführbar. Der Snapshot ist
 * JSON-serialisierbar und byte-identisch für gleiche Eingaben.
 */
export interface ConfluenceSnapshot {
  /** Formelversion (`mtf-confluence@1`), immer gesetzt. */
  formulaVersion: typeof CONFLUENCE_FORMULA_VERSION;
  /** Config-Schema-Version (aus der validierten Config). */
  configVersion: number;
  /** Instrument-ID (Protokoll, nie Metrik-Label). */
  instrumentId: string;
  /** Gemeinsamer Entscheidungszeitpunkt (ISO-UTC). */
  asOf: string;
  /** Gemeinsamer Entscheidungszeitpunkt (Epoch-ms). */
  asOfMs: number;
  /** Protokollzeit der Berechnung (ISO-UTC, nie Entscheidungsgrundlage). */
  computedAt: string;
  /**
   * Stabile Idempotency-/Dedup-Kennung:
   * `mtf1:<sha256(instrumentId|asOfMs|barEnds|configVersion|formula)>` (16 Hex).
   * Retries/Restarts erzeugen denselben Schlüssel — keine doppelten Writes.
   */
  snapshotKey: string;
  /** Status (`ABSTAIN` ⇒ `direction`/`strength`/`bias` sind `null`). */
  status: ConfluenceStatus;
  /**
   * Gewichtete Richtung ∈ [-1, 1] (`null` bei `ABSTAIN` — fail-closed,
   * `null` ist NICHT `0`/neutral).
   */
  direction: number | null;
  /** Gewichtete Stärke ∈ [0, 1] (`null` bei `ABSTAIN`). */
  strength: number | null;
  /** Richtungslabel (`null` bei `ABSTAIN`). */
  bias: ConfluenceBias | null;
  /**
   * Confidence ∈ [0, 1]: `coverage × (1 − conflict) × volFactor`.
   * Fehlende Timeframes senken sie über `coverage` — sie erhöhen sie nie.
   * Bei `ABSTAIN` exakt `0`.
   */
  confidence: number;
  /** Coverage ∈ [0, 1]: Gewichtsanteil der verfügbaren Timeframes. */
  coverage: number;
  /** Konflikt ∈ [0, 1]: gewichtete mittlere Abweichung der Richtungen. */
  conflict: number;
  /** Beiträge je verfügbarem Timeframe (kanonisch sortiert). */
  contributions: TimeframeContribution[];
  /** Fehlende Timeframes mit geschlossenem Grund (kanonisch sortiert). */
  missing: TimeframeMissing[];
  /** Maschinenlesbare Hinweise (`conflict-high`, `timeframe-missing:<tf>:<grund>`). */
  reasons: string[];
}
