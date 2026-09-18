/**
 * Funding-Accrual für Perpetual-Positionen im Paper-Betrieb (GAP-02, v1.42.0).
 *
 * Lücke laut Audit 2026-09-18 (docs/audits/2026-09-18-feature-gap/): Der
 * Fill-Simulator bildet Gebühren, Spread, Slippage und Partial Fills ab, aber
 * **Perpetual-Funding fließt nicht ins Paper-PnL** — Funding existierte nur als
 * Scanner-Ranking-Faktor. Gerade bei längeren Haltedauern frisst Funding real
 * die Edge; Paper-Ergebnisse waren damit systematisch zu optimistisch.
 *
 * Bausteine (alle deterministisch, Clock/nowMs injizierbar):
 *
 *   - `loadFundingConfig`      Env-Flags mit Bounds + sicherem Default.
 *   - `FundingRateProvider`    Erweiterungspunkt für echte Funding-Raten
 *                              (Netzwerk-Anbindung bewusst NICHT Teil dieses
 *                              PR — Quellen gestuft: Provider → statischer
 *                              Default).
 *   - `computeFunding`         Reine Formel (kein IO, keine Clock).
 *   - `FundingPeriodTracker`   Periodenwechsel-Erkennung (Default: 8h-Marke
 *                              UTC), monoton, erste Sichtung zahlt nichts nach.
 *   - `FundingAccrualEngine`   Ein Monitor-Tick → fällige Accruals (rein).
 *   - `runFundingAccrual`      Buchung: Ledger (PaperBroker) → DB (positions.
 *                              funding_paid) → audit_log (Muster R6:
 *                              „funding:SYMBOL:+0.42“), mit Rollback des
 *                              Ledgers, wenn die Persistenz scheitert.
 *
 * ── Vorzeichenkonvention (verbindlich, auch in docs/PAPER_TRADING.md) ────────
 *
 *   Formel:   funding_zahlung = fundingRate · |notional| · direction
 *             direction: LONG = +1, SHORT = −1
 *             → funding_zahlung > 0 = die Position ZAHLT (LONG bei positiver
 *               Rate), < 0 = die Position ERHÄLT.
 *
 *   Konto-/Cashflow-Sicht (diese Sicht gilt für ALLE Felder und Events):
 *             funding = −funding_zahlung
 *             → funding < 0 = gezahlt (Cash-Abfluss, Equity sinkt),
 *               funding > 0 = erhalten (Cash-Zufluss, Equity steigt).
 *
 *   `positions.funding_paid` (DB) und `PaperBroker`-Positionen speichern die
 *   kumulierte KONTOSICHT (negativ = gezahlt). Damit gilt exakt:
 *   „equity nach Accrual = equity vorher + Σ fundingPaid“.
 *
 * Determinismus (Baseline-Regel): Die Engine bekommt `nowMs` als Parameter
 * (injizierbare Clock, Muster src/cycle/clock.ts) und nutzt weder Date.now()
 * noch Math.random() — gleiche (Zeit, Zeilen, Rate) → gleiche Accruals.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { positions as positionsTable } from "../db/schema";
import { writeAuditRecord } from "./auditSink";
import { envNumber } from "./env";
import type { PaperBroker } from "./broker";

/** Env-Namen (zentral, für Doku/Tests). */
export const FUNDING_ENV = {
  INTERVAL_HOURS: "PAPER_FUNDING_INTERVAL_HOURS",
  RATE_PCT_PER_8H: "PAPER_FUNDING_RATE_PCT_PER_8H",
} as const;

/** Bounds der Funding-Parameter (Clamp + Warnung, siehe envNumber). */
export const FUNDING_BOUNDS = {
  /** Accrual-Intervall in Stunden: mindestens stündlich, höchstens täglich. */
  intervalHours: { min: 1, max: 24 },
  /**
   * Statische Funding-Rate in PROZENT je 8h. ±1 %/8h ist bereits extrem
   * (real: typischerweise ±0,01–0,1 %/8h) — alles darüber ist ein
   * Konfigurationsfehler und wird geklemmt.
   */
  ratePctPer8h: { min: -1, max: 1 },
} as const;

/** Sichere Defaults: 8h-Takt (UTC-Marke) und Rate 0 = neutral. */
export const FUNDING_DEFAULTS = {
  intervalHours: 8,
  ratePctPer8h: 0,
} as const;

export interface FundingConfig {
  /** Accrual-Intervall in Stunden (Default 8 = 8h-Marken 00/08/16 UTC). */
  intervalHours: number;
  /**
   * Statische Default-Rate in PROZENT je 8h (0.01 = 0,01 %/8h).
   * Default 0 = neutral: kein Accrual, bestehende Tests/Installationen
   * verhalten sich unverändert (GAP-02-Anforderung).
   */
  ratePctPer8h: number;
}

/** Lädt die Funding-Konfiguration aus Env (Bounds-Clamp mit Warnung). */
export function loadFundingConfig(
  env: Record<string, string | undefined> = process.env
): FundingConfig {
  return {
    intervalHours: envNumber(
      FUNDING_ENV.INTERVAL_HOURS,
      FUNDING_DEFAULTS.intervalHours,
      FUNDING_BOUNDS.intervalHours.min,
      FUNDING_BOUNDS.intervalHours.max,
      env
    ),
    ratePctPer8h: envNumber(
      FUNDING_ENV.RATE_PCT_PER_8H,
      FUNDING_DEFAULTS.ratePctPer8h,
      FUNDING_BOUNDS.ratePctPer8h.min,
      FUNDING_BOUNDS.ratePctPer8h.max,
      env
    ),
  };
}

/**
 * Erweiterungspunkt für echte Funding-Raten (GAP-02, Stufe b).
 *
 * Ein Provider liefert die signierte Rate je 8h als Dezimalanteil
 * (0.0001 = 0,01 %/8h; positiv = Longs zahlen). Gibt er `null` oder keine
 * endliche Zahl zurück, fällt die Engine auf die statische Default-Rate
 * (`PAPER_FUNDING_RATE_PCT_PER_8H`) zurück. Netzwerk-Anbindung ist bewusst
 * NICHT Teil dieses PR — das Interface hält nur den Austauschpunkt offen.
 */
export interface FundingRateProvider {
  getFundingRate(symbol: string): number | null;
}

/** Runden auf 8 Nachkommastellen (numeric-Spalte, keine Float-Rests). */
function round8(n: number): number {
  return Number(n.toFixed(8));
}

/** „+0.42“/„-0.42“ — Vorzeichen immer explizit (Audit-Muster R6). */
function formatSigned(n: number): string {
  const abs = Math.abs(n).toFixed(4);
  return `${n >= 0 ? "+" : "-"}${abs}`;
}

/**
 * Reine Funding-Formel für EINE Position und EINEN Accrual-Zeitraum.
 *
 *   funding_zahlung = ratePer8h · (intervalHours / 8) · |qty · price| · direction
 *   funding (Kontosicht) = −funding_zahlung
 *
 * Die Rate wird vom 8h-Standard auf das konfigurierte Intervall skaliert
 * (4h-Takt ⇒ halbe Rate je Accrual, gleiche annualisierte Last).
 * Gibt `null` zurück, wenn qty/price/rate keine endlichen positiven Zahlen
 * sind — kaputte Zeilen erzeugen keine erfundenen Kosten (fail-safe).
 */
export function computeFunding(
  input: { side: "LONG" | "SHORT"; qty: number; price: number },
  config: Pick<FundingConfig, "intervalHours">,
  ratePer8h: number
): { ratePerInterval: number; notional: number; funding: number } | null {
  if (
    !Number.isFinite(input.qty) || input.qty <= 0 ||
    !Number.isFinite(input.price) || input.price <= 0 ||
    !Number.isFinite(ratePer8h)
  ) {
    return null;
  }
  const direction = input.side === "LONG" ? 1 : -1;
  const notional = Math.abs(input.qty * input.price);
  const ratePerInterval = ratePer8h * (config.intervalHours / 8);
  // Zahlungs-Sicht: positiv = Position zahlt (LONG bei positiver Rate).
  const paidByPosition = ratePerInterval * notional * direction;
  return { ratePerInterval, notional, funding: -paidByPosition };
}

/** Ergebnis eines Periodenwechsel-Checks. */
export interface FundingPeriodSwitch {
  /** Absolute Periodennummer (floor(nowMs / Intervall)). */
  periodIndex: number;
  /** Überstandene Marken seit dem letzten Accrual (≥ 1; > 1 nach Prozess-Standby). */
  periods: number;
}

/**
 * Periodenwechsel-Erkennung (Default: 8h-Marken UTC). Deterministisch über
 * `floor(nowMs / intervalMs)` — keine Wanduhr-Arithmetik, keine Zeitzonen.
 *
 *   - Erste Sichtung initialisiert nur (kein rückwirkender Accrual — nach
 *     einem Prozessneustart würde sonst blind nachberechnet, obwohl der
 *     Vorgängerprozess die Marke ggf. schon gebucht hat).
 *   - Monoton: eine rückwärts laufende Clock löst nichts aus.
 *   - Standby über mehrere Marken: ein Wechsel mit `periods > 1` — die
 *     Engine bucht dann anteilig `periods`-fach (aktuelle Rate, dokumentierte
 *     Näherung), statt die Haltekosten still verschwinden zu lassen.
 */
export class FundingPeriodTracker {
  private lastPeriod: number | null = null;

  constructor(private readonly intervalHours: number) {}

  /** Absolute Periodennummer eines Zeitstempels (UTC-epoch-basiert). */
  periodIndex(nowMs: number): number {
    return Math.floor(nowMs / (this.intervalHours * 3_600_000));
  }

  /** true genau einmal je überschrittener Marke; `null` = kein Wechsel. */
  enterNewPeriod(nowMs: number): FundingPeriodSwitch | null {
    const idx = this.periodIndex(nowMs);
    if (this.lastPeriod === null) {
      this.lastPeriod = idx;
      return null;
    }
    if (idx <= this.lastPeriod) return null;
    const periods = idx - this.lastPeriod;
    this.lastPeriod = idx;
    return { periodIndex: idx, periods };
  }
}

/** Offene Position, wie sie der Monitor übergibt (DB-Zeile angereichert). */
export interface FundingPositionRow {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  /** Referenzpreis für das Notional (aktueller Kurs, Fallback Entry). */
  price: number;
  /**
   * Nur Perpetuals zahlen Funding. `true` = als Perpetual erkannt;
   * alles andere (auch `undefined`) wird NICHT belastet — nur eindeutig
   * erkannte Perpetuals erzeugen Kosten (fail-safe gegen erfundene Lasten).
   */
  isPerpetual?: boolean;
}

/** Ein fälliger Accrual (Beträge, noch nicht gebucht). */
export interface FundingAccrual {
  symbol: string;
  side: "LONG" | "SHORT";
  /** Wirksame Rate je 8h (Dezimalanteil, 0.0001 = 0,01 %) — Provider oder Default. */
  ratePer8h: number;
  /** Rate je Accrual-Intervall (auf intervalHours skaliert). */
  ratePerInterval: number;
  /** Überstandene Perioden seit dem letzten Accrual (≥ 1). */
  periods: number;
  /** Notional (|qty · price|) in Kontowährung. */
  notional: number;
  /** Cashflow aus Kontosicht: negativ = gezahlt, positiv = erhalten. */
  funding: number;
}

/**
 * Accrual-Engine: verbindet Periodenwechsel-Erkennung und Formel. Rein —
 * keine DB, kein Broker, keine Clock (alles via Parameter injizierbar).
 */
export class FundingAccrualEngine {
  private readonly tracker: FundingPeriodTracker;

  constructor(
    private readonly config: FundingConfig,
    private readonly opts: { rateProvider?: FundingRateProvider } = {}
  ) {
    this.tracker = new FundingPeriodTracker(config.intervalHours);
  }

  get intervalHours(): number {
    return this.config.intervalHours;
  }

  /**
   * Ein Monitor-Tick: prüft den Periodenwechsel und berechnet die fälligen
   * Accruals. Bei Rate 0 (Default) oder ohne Perpetual-Positionen ist das
   * Ergebnis leer — kein Event, keine Buchung, kein Audit (neutral).
   */
  dueAccruals(rows: FundingPositionRow[], nowMs: number): FundingAccrual[] {
    const switchMark = this.tracker.enterNewPeriod(nowMs);
    if (!switchMark) return [];
    const out: FundingAccrual[] = [];
    for (const row of rows) {
      if (row.isPerpetual !== true) continue;
      const symbol = row.symbol.toUpperCase();
      // Quelle gestuft: Provider (Stufe b) vor statischem Default (Stufe a).
      const provided = this.opts.rateProvider?.getFundingRate(symbol) ?? null;
      const ratePer8h =
        provided !== null && Number.isFinite(provided)
          ? provided
          : this.config.ratePctPer8h / 100;
      if (ratePer8h === 0) continue; // neutral (Default) — nichts zu buchen.
      const computed = computeFunding(row, this.config, ratePer8h);
      if (!computed) {
        console.warn(
          `[funding] ${symbol}: ungültige Zeile (qty=${row.qty}, price=${row.price}) — kein Accrual gebucht`
        );
        continue;
      }
      out.push({
        symbol,
        side: row.side,
        ratePer8h,
        ratePerInterval: computed.ratePerInterval,
        periods: switchMark.periods,
        notional: computed.notional,
        funding: round8(computed.funding * switchMark.periods),
      });
    }
    return out;
  }
}

/** Monitor-Zeile inkl. Persistenz-Kontext (DB-ID, Mission fürs Audit). */
export interface FundingApplyRow extends FundingPositionRow {
  /** DB-Primärschlüssel der positions-Zeile (ohne id: nur Ledger-Buchung). */
  id?: string;
  missionId?: string | null;
}

/** Erfolgreich gebuchter Accrual (Ledger + DB aktualisiert, Audit geschrieben). */
export interface AppliedFundingAccrual extends FundingAccrual {
  /** Kumuliertes Funding der Position NACH diesem Accrual (Kontosicht). */
  fundingPaid: number;
}

/**
 * Buchung eines Accrual-Durchlaufs (vom Monitor-Tick aufgerufen):
 *
 *   1. Ledger: `broker.accrueFunding` (Cash + fundingPaid je Position).
 *      Position existiert im Ledger nicht mehr (z. B. im selben Tick per SL
 *      geschlossen) → kein Event, keine DB-, keine Audit-Zeile.
 *   2. Persistenz: `positions.funding_paid` fortschreiben (Standard-
 *      implementierung; injizierbar für Tests). Schlägt sie fehl, wird die
 *      Ledger-Mutation zurückgerollt und der Fehler weitergeworfen — kein
 *      Zustand, in dem der Speicher Kosten zeigt, die die DB nie bestätigt
 *      hat (Muster: rollbackInMemoryFill in submitAtomic).
 *   3. Audit: `FUNDING_ACCRUAL` mit Muster `funding:SYMBOL:+0.42` (R6),
 *      revisionssicher über die Audit-Senke (Retry + Spool). Ein Audit-
 *      Fehlschlag rollt die Buchung NICHT zurück — er wird über den
 *      Audit-Sink-Signalweg laut (nie still), die Zahlen in Ledger/DB sind
 *      die Wahrheit.
 */
export async function runFundingAccrual(args: {
  broker: PaperBroker;
  rows: FundingApplyRow[];
  nowMs: number;
  engine: FundingAccrualEngine;
  persist?: (accrual: AppliedFundingAccrual, row: FundingApplyRow) => Promise<void>;
  audit?: (accrual: AppliedFundingAccrual, row: FundingApplyRow) => Promise<void>;
}): Promise<AppliedFundingAccrual[]> {
  const due = args.engine.dueAccruals(args.rows, args.nowMs);
  if (due.length === 0) return [];
  const rowsBySymbol = new Map(args.rows.map((r) => [r.symbol.toUpperCase(), r]));

  const persist =
    args.persist ??
    (async (accrual, row) => {
      if (!row.id) return; // ohne DB-Zeile (reiner Ledger-Betrieb) nichts zu persistieren.
      await db
        .update(positionsTable)
        .set({ fundingPaid: String(round8(accrual.fundingPaid)), updatedAt: new Date() })
        .where(eq(positionsTable.id, row.id));
    });

  const audit =
    args.audit ??
    (async (accrual, row) => {
      const outcome = await writeAuditRecord({
        event: "FUNDING_ACCRUAL",
        level: "INFO",
        detail: {
          message: `funding:${accrual.symbol}:${formatSigned(accrual.funding)}`,
          symbol: accrual.symbol,
          side: accrual.side,
          ratePer8h: accrual.ratePer8h,
          ratePerInterval: accrual.ratePerInterval,
          periods: accrual.periods,
          notional: accrual.notional,
          funding: accrual.funding,
          fundingPaid: accrual.fundingPaid,
          intervalHours: args.engine.intervalHours,
        },
        ...(row.missionId ? { missionId: row.missionId } : {}),
        auditClass: "security",
      });
      if (!outcome.durable) {
        console.warn(
          `[funding] Audit für ${accrual.symbol} nicht durable (${outcome.target}${outcome.degraded ? ", im Spool" : ""}) — Zahlen in Ledger/DB sind führend`
        );
      }
    });

  const applied: AppliedFundingAccrual[] = [];
  for (const accrual of due) {
    const row = rowsBySymbol.get(accrual.symbol);
    if (!row) continue;
    const booked = args.broker.accrueFunding(accrual.symbol, accrual.funding);
    if (!booked) continue; // Ledger hat die Position nicht mehr → nichts buchen.
    const event: AppliedFundingAccrual = { ...accrual, fundingPaid: booked.fundingPaid };
    try {
      await persist(event, row);
    } catch (e) {
      // Ledger-Mutation zurücknehmen — die DB ist die persistente Wahrheit,
      // ein unbestätigter Cash-Abfluss darf im Speicher nicht hängen bleiben.
      args.broker.accrueFunding(accrual.symbol, -booked.funding);
      throw e;
    }
    await audit(event, row);
    applied.push(event);
  }
  return applied;
}
