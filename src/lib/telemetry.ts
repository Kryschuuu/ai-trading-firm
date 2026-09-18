/**
 * Telemetrie / Metriken des Marktdaten-Pfads (MDERR-006) und der Firma
 * als Ganzes (GAP-10, v1.45.0).
 *
 * Es gibt keine externe Metrics-Infrastruktur (kein prom-client) — der
 * Betrieb läuft lokal-first. Deshalb: kleiner, prozessweiter In-Memory-Counter
 * mit stabilen Label-Namen plus optionaler Prometheus-Text-Exposition, damit
 * ein späterer Scraper die Werte ohne Code-Änderung abgreifen kann.
 *
 * Kardinalitäts-Regel (Security): `symbol` ist **kein** Label. Ein
 * symbol-labelser Counter würde bei 50 000 Instrumenten × Timeframes ins
 * Unendliche wachsen (Speicher-DoS). Labels sind `venue`, `timeframe`,
 * `reason`; das Symbol steht nur im strukturierten Log. Dieselbe Regel gilt
 * für die Firmen-Metriken: Labels sind Code-konstante Kategorien
 * (`kind`, `reason`-Klassen, `provider`), niemals freie Fremdtexte —
 * `metricLabel()` erzwingt das.
 *
 * Der Counter ist prozesslokal (Next.js-App bzw. MicroExecutor-Prozess).
 * Für Sync-Fehler aus separaten Prozessen existiert zusätzlich das
 * persistente Datenfehler-Manifest (`src/marketdata/dataErrors.ts`),
 * das das Operations Center mit einbezieht.
 *
 * ── Firmen-Metriken (GAP-10, D1) ────────────────────────────────────────────
 *
 * `prometheusMetrics()` liefert zusätzlich Kennzahlen, die **ausschließlich
 * aus bestehenden Stores** gelesen werden (Paper-Ledger, DB, In-Memory-
 * Counter) — es wird keine neue Messlogik erfunden:
 *
 *   firm_equity                Kontostand (Paper-Ledger, mark-to-market)
 *   firm_drawdown_pct          Drawdown ggü. Startkapital (0.12 = 12 %)
 *   firm_open_positions        offene Positionen
 *   firm_realized_pnl_today    realisiertes P&L des laufenden Berliner Tages
 *   firm_order_fills_total     Fills je `kind`/`reason`
 *   firm_order_rejects_total   abgelehnte Orders je Grund-Klasse
 *   llm_calls_total            LLM-Aufrufe je Provider/Ergebnis
 *   llm_latency_ms_sum         Summe der LLM-Latenzen je Provider (ms)
 *
 * Fehlertoleranz (Betriebsregel): Ist der Firmenzustand nicht lesbar
 * (z. B. DB weg, Ledger noch nicht hydratisiert), werden die betroffenen
 * Metriken **weggelassen** und mit einem `# HELP … degraded:`-Kommentar
 * markiert. Die Funktion wirft nie und hängt nie — ein Scrape darf den
 * Handelspfad nicht blockieren.
 *
 * ── Client-Bundle-Grenze (wichtig für den Build) ────────────────────────────
 * Diese Datei liegt (über `marketData.ts` → `workshop.ts`) im Import-Graph von
 * Client-Komponenten. Sie darf deshalb **kein** `@/db`/`pg` und kein
 * `./equity` importieren — genau daran scheiterte der Produktions-Build
 * („Can't resolve 'tls'“). Der DB-Zugriff lebt in `src/lib/firmState.ts`
 * (server-only) und wird hier über `setFirmMetricStateReader()` registriert.
 */
import type { MarketDataErrorReason } from "./marketDataErrors";
import { state } from "./stateRegistry";

/** Labels des Counters `market_data_fetch_failures_total` (bewusst ohne symbol). */
export interface FetchFailureLabels {
  venue: string;
  timeframe: string;
  reason: MarketDataErrorReason;
}

/** Momentaufnahme eines Label-Counters. */
export interface CounterSnapshot {
  name: string;
  total: number;
  byLabel: Record<string, number>;
}

export interface FetchFailuresSnapshot {
  total: number;
  byReason: Record<string, number>;
  byVenue: Record<string, number>;
  byTimeframe: Record<string, number>;
  byLabel: Record<string, number>;
}

/** Erlaubte Label-Zeichen: Code-konstante Werte, keine Fremdinhalte/Secrets. */
const SAFE_LABEL = /^[A-Za-z0-9_.:-]{1,40}$/;

/**
 * Begrenzt einen Wert auf ein sicheres Label (Kardinalität + Secret-Schutz).
 *
 * Alles, was nicht dem konservativen Zeichensatz entspricht oder länger als
 * 40 Zeichen ist, wird durch `fallback` ersetzt. Damit kann kein Fremdtext
 * (Symbol, Fehlermeldung, Token) in ein Label und damit in eine Exposition
 * gelangen — der Ursprungswert bleibt im strukturierten Log.
 */
export function metricLabel(value: unknown, fallback = "OTHER"): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return SAFE_LABEL.test(raw) ? raw : fallback;
}

/** Kleiner Label-Counter (kein Map-Leak: nur statische Label-Kombinationen). */
export class LabelCounter {
  private values = new Map<string, number>();

  constructor(readonly name: string) {}

  inc(labels: Record<string, string>, by = 1): void {
    const key = Object.keys(labels)
      .sort()
      .map((k) => `${k}=${String(labels[k])}`)
      .join(",");
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  total(): number {
    let sum = 0;
    for (const v of this.values.values()) sum += v;
    return sum;
  }

  byDimension(dimension: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, value] of this.values) {
      const part = key
        .split(",")
        .map((p) => p.split("="))
        .find(([k]) => k === dimension);
      if (part) out[part[1]] = (out[part[1]] ?? 0) + value;
    }
    return out;
  }

  byLabel(): Record<string, number> {
    return Object.fromEntries(this.values);
  }

  snapshot(): CounterSnapshot {
    return { name: this.name, total: this.total(), byLabel: this.byLabel() };
  }

  reset(): void {
    this.values.clear();
  }

  /** Prometheus-Textformat: `name{label="…",…} value`. */
  exposition(): string {
    const lines: string[] = [];
    for (const [key, value] of [...this.values.entries()].sort()) {
      const labels = key
        .split(",")
        .map((p) => {
          const [k, v] = p.split("=");
          return `${k}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
        })
        .join(",");
      lines.push(`${this.name}{${labels}} ${value}`);
    }
    if (lines.length === 0) lines.push(`${this.name} 0`);
    return lines.join("\n");
  }
}

/** Zentrales Telemetrie-Objekt. */
export const telemetry = {
  marketData: {
    /** Fehlgeschlagene Kerzenabrufe nach Ursache (MDERR-006). */
    fetchFailures: new LabelCounter("market_data_fetch_failures_total"),
  },
  /**
   * Audit-Zuverlässigkeit (S1, v1.36.18).
   *
   * Labels sind ausschließlich Code-konstant (`auditClass`, `stage`, `kind`,
   * `result`) — kein Event-Name als Label: fremde Event-Codes wären ein
   * Kardinalitätsrisiko (dieselbe Regel wie beim symbol-Label oben).
   */
  audit: {
    /** fehlgeschlagene Audit-Schreibversuche: stage = db | spool | lost */
    writeFailures: new LabelCounter("audit_write_failures_total"),
    /** security-Audits, die im persistenten Spool auf den Nachzug warten */
    spooled: new LabelCounter("audit_spooled_total"),
    /** Nachzüge aus dem Spool: result = ok | error | corrupt */
    spoolDrained: new LabelCounter("audit_spool_drained_total"),
    /** Audit-Lücken: kind = dropped (verloren) | flagged (gemeldet, Trade-off) */
    missed: new LabelCounter("audit_missed_total"),
    /** alle Counter der Audit-Sektion zurücksetzen (nur Tests) */
    reset(): void {
      telemetry.audit.writeFailures.reset();
      telemetry.audit.spooled.reset();
      telemetry.audit.spoolDrained.reset();
      telemetry.audit.missed.reset();
    },
  },
  /**
   * Firmen-Metriken (GAP-10, v1.45.0).
   *
   * Alle Counter werden an der Stelle erhöht, an der das Ereignis ohnehin
   * anfällt (Order-Pfad `src/lib/broker.ts`, Routing `src/routing/adapter.ts`)
   * — keine zusätzliche Messschleife. Labels sind klassifizierte Codes
   * (`metricLabel`), niemals Symbole oder Freitext.
   */
  firm: {
    /** Ausgeführte Fills: kind = OPEN | CLOSE, reason = Klassen-Code. */
    orderFills: new LabelCounter("firm_order_fills_total"),
    /** Abgelehnte Orders: reason = Grund-Klasse (z. B. INSUFFICIENT_CASH). */
    orderRejects: new LabelCounter("firm_order_rejects_total"),
    /** LLM-Aufrufe: provider + outcome = ok | error. */
    llmCalls: new LabelCounter("llm_calls_total"),
    /** Summe der LLM-Latenzen in ms je Provider (für Mittelwerte). */
    llmLatencyMs: new LabelCounter("llm_latency_ms_sum"),
    /** alle Counter der Firmen-Sektion zurücksetzen (nur Tests) */
    reset(): void {
      telemetry.firm.orderFills.reset();
      telemetry.firm.orderRejects.reset();
      telemetry.firm.llmCalls.reset();
      telemetry.firm.llmLatencyMs.reset();
    },
  },
};

/** Snapshot für Ops/UI (inkl. Aufschlüsselung nach venue/timeframe/reason). */
export function marketDataFailureSnapshot(): FetchFailuresSnapshot {
  const c = telemetry.marketData.fetchFailures;
  return {
    total: c.total(),
    byReason: c.byDimension("reason"),
    byVenue: c.byDimension("venue"),
    byTimeframe: c.byDimension("timeframe"),
    byLabel: c.byLabel(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Firmen-Metriken (GAP-10, D1)
// ─────────────────────────────────────────────────────────────────────────────

/** Woher der Firmenzustand gelesen wurde (Label `source`). */
export type FirmMetricSource = "paper-broker" | "db-snapshot";

/** Momentaufnahme des Firmenzustands — Zahlen, keine Secrets. */
export interface FirmMetricState {
  equity: number;
  startingEquity: number;
  /** 0.12 = 12 % unter Startkapital (Definition wie `PaperBroker.drawdownPct`). */
  drawdownPct: number;
  openPositions: number;
  /** `null` = nicht lesbar (DB weg) → Metrik wird weggelassen. */
  realizedPnlToday: number | null;
  source: FirmMetricSource;
}

/**
 * Leser für den Firmenzustand (Injektion aus einem Server-Modul).
 *
 * `src/lib/firmState.ts` implementiert den Ledger-/DB-Zugriff und registriert
 * sich beim Import selbst. `telemetry.ts` bleibt bewusst **DB-frei**: dieses
 * Modul liegt im Import-Graph von Client-Komponenten (`marketData.ts` →
 * `workshop.ts` → `HitRatePanel.tsx`), und ein `@/db`-Import bricht den
 * Produktions-Build mit „Module not found: Can't resolve 'tls'“ (pg →
 * Node-Builtins, die es im Browser nicht gibt).
 */
export type FirmMetricStateReader = () => Promise<FirmMetricState>;

let firmMetricStateReader: FirmMetricStateReader | null = null;

/**
 * Registriert den Server-Leser für den Firmenzustand.
 *
 * Der Import von `./firmState` erledigt das automatisch; ein Aufrufer kann
 * hier auch einen eigenen Leser (z. B. Test-Double) setzen. `null` entfernt
 * die Registrierung.
 */
export function setFirmMetricStateReader(reader: FirmMetricStateReader | null): void {
  firmMetricStateReader = reader;
}

/** Nur für Tests: Registrierung entfernen. */
export function resetFirmMetricStateReaderForTests(): void {
  firmMetricStateReader = null;
}

/**
 * DB-freier Fallback: der prozesslokale Paper-Ledger (RAM) — dieselbe Quelle,
 * die der Monitor-Tick für Equity/Drawdown nutzt, ohne zweite Rechnung.
 *
 * Ohne Ledger (z. B. reiner CLI-Prozess) gibt es hier nichts zu lesen; die
 * Exposition degradiert dann sauber. Das Tages-P&L stammt aus der DB und
 * bleibt ohne DB-Zugriff unbelegt (eigene `degraded`-Markierung statt 0).
 */
function readLedgerFirmMetricState(): FirmMetricState | null {
  const broker = state.paperBrokerLedger.get();
  if (!broker) return null;
  return {
    equity: broker.accountEquity,
    startingEquity: broker.startingEquity,
    drawdownPct: broker.drawdownPct,
    openPositions: broker.openPositions,
    realizedPnlToday: null,
    source: "paper-broker",
  };
}

/** Prometheus-Zahl: endlich, ohne Float-Rauschen, sonst `null`. */
function gaugeValue(value: number, digits = 6): string | null {
  if (!Number.isFinite(value)) return null;
  return String(Number(value.toFixed(digits)));
}

function gaugeLines(
  help: string,
  type: "gauge" | "counter",
  samples: Array<{ name: string; labels?: Record<string, string>; value: number }>,
  degradedReason?: string,
): string[] {
  if (degradedReason) {
    // Metrik weglassen, Grund sichtbar machen: ein Scrape erkennt den
    // degradierten Betrieb am HELP-Kommentar, statt einen erfundenen 0-Wert
    // zu lesen (0 wäre eine falsche Aussage über den Kontostand).
    return [`# HELP ${samples[0]?.name ?? help} ${help} degraded: ${degradedReason}`];
  }
  const lines = [`# HELP ${samples[0]?.name ?? help} ${help}`, `# TYPE ${samples[0]?.name ?? help} ${type}`];
  for (const sample of samples) {
    const value = gaugeValue(sample.value);
    if (value === null) continue;
    const labels = sample.labels
      ? `{${Object.entries(sample.labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(",")}}`
      : "";
    lines.push(`${sample.name}${labels} ${value}`);
  }
  return lines;
}

export interface PrometheusMetricsOptions {
  /**
   * Vorab gelesener Firmenzustand (Tests/Injektion). `undefined` = selbst
   * lesen (registrierter Server-Leser, sonst prozesslokaler Ledger),
   * `null` = Zustand bewusst nicht verfügbar (Degradations-Zweig).
   */
  firmState?: FirmMetricState | null;
}

/**
 * Prometheus-Text-Exposition (für späteres Scraping).
 *
 * Enthält die Marktdaten-/Audit-Counter (prozesslokal, immer lesbar) und die
 * Firmen-Metriken (GAP-10). Der Firmenzustand wird aus bestehenden Stores
 * gelesen; schlägt das fehl, bleiben die Counter erhalten und die
 * Firmen-Metriken erscheinen als `degraded`-Kommentar ohne Sample — nie ein
 * Throw, nie ein Hänger, keine Secrets (nur numerische Werte und
 * klassifizierte Labels).
 */
export async function prometheusMetrics(opts: PrometheusMetricsOptions = {}): Promise<string> {
  const lines: string[] = [
    telemetry.marketData.fetchFailures.exposition(),
    telemetry.audit.writeFailures.exposition(),
    telemetry.audit.spooled.exposition(),
    telemetry.audit.spoolDrained.exposition(),
    telemetry.audit.missed.exposition(),
  ];

  let firm: FirmMetricState | null;
  try {
    if (opts.firmState !== undefined) {
      firm = opts.firmState;
    } else if (firmMetricStateReader) {
      firm = await firmMetricStateReader();
    } else {
      // Kein Server-Modul geladen (z. B. Browser/CLI ohne Ledger) — der
      // RAM-Ledger bleibt als letzte DB-freie Quelle.
      firm = readLedgerFirmMetricState();
    }
  } catch (e) {
    // Betriebsregel: degradieren, nicht werfen. Der Grund steht im Log.
    firm = null;
    const { structuredLog } = await import("./logger");
    structuredLog("warn", "firm_metrics_degraded", {
      reason: e instanceof Error ? e.message : "Firmenzustand nicht lesbar",
    });
  }

  const degraded = "Firmenzustand nicht lesbar (Paper-Ledger/DB nicht verfügbar)";
  lines.push(
    ...gaugeLines(
      "Kontostand der Firma (Paper-Ledger, mark-to-market).",
      "gauge",
      [{ name: "firm_equity", value: firm?.equity ?? NaN }],
      firm ? undefined : degraded,
    ),
  );
  lines.push(
    ...gaugeLines(
      "Drawdown gegenüber Startkapital (0.12 = 12 % unter Start).",
      "gauge",
      [{ name: "firm_drawdown_pct", value: firm?.drawdownPct ?? NaN }],
      firm ? undefined : degraded,
    ),
  );
  lines.push(
    ...gaugeLines(
      "Offene Positionen der Firma (Paper-Ledger).",
      "gauge",
      [{ name: "firm_open_positions", value: firm?.openPositions ?? NaN }],
      firm ? undefined : degraded,
    ),
  );
  lines.push(
    ...gaugeLines(
      "Realisiertes P&L des laufenden Berliner Tages.",
      "gauge",
      [{ name: "firm_realized_pnl_today", value: firm?.realizedPnlToday ?? NaN }],
      firm
        ? firm.realizedPnlToday === null
          ? "Tages-P&L nicht lesbar (DB nicht verfügbar)"
          : undefined
        : degraded,
    ),
  );
  if (firm) {
    lines.push(
      ...gaugeLines(
        "Quelle des gelesenen Firmenzustands (1 = aktiv).",
        "gauge",
        [{ name: "firm_metric_source", labels: { source: firm.source }, value: 1 }],
      ),
    );
  }

  lines.push(
    telemetry.firm.orderFills.exposition(),
    telemetry.firm.orderRejects.exposition(),
    telemetry.firm.llmCalls.exposition(),
    telemetry.firm.llmLatencyMs.exposition(),
  );

  return lines.join("\n");
}

/** Nur für Tests: alle Counter zurücksetzen. */
export function resetTelemetryForTests(): void {
  telemetry.marketData.fetchFailures.reset();
  telemetry.audit.reset();
  telemetry.firm.reset();
}
