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
 *   backtest_run_persist_total persistierte Backtest-Runs je result/reason
 *                              (RMA-P1-04: created | replayed | failed)
 *   backtest_replay_runs_total Event-Replay-Läufe je result/degraded
 *                              (RMA-P1-01: ok × none | degraded)
 *   backtest_replay_degraded_total degradierte Replay-Annahmen je reason
 *                              (geschlossenes Vokabular ReplayDegradedReason)
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
  /** Execution-quality outcomes only; never free-form identifiers. */
  executionQuality: new LabelCounter("execution_quality_total"),
  /**
   * Trade-PnL-Attribution (RMA-P1-06, v1.57.0). Labels sind ausschließlich
   * Code-konstante Ergebniswerte (`result`: attributed | unattributable |
   * duplicate | failed bzw. ok | invalid | unavailable) — KEINE Agentennamen,
   * Journal-/Trade-/Positions-IDs oder Instrumente als Labels (begrenzte
   * Kardinalität).
   */
  attribution: {
    /** Attributionsschreibungen je Ergebnis. */
    captures: new LabelCounter("trade_attribution_captures_total"),
    /** Backfill-Läufe je Ergebnis. */
    backfills: new LabelCounter("trade_attribution_backfills_total"),
    /** Read-API-Abfragen je Ergebnis. */
    queries: new LabelCounter("trade_attribution_queries_total"),
    /** alle Zähler der Sektion zurücksetzen (nur Tests). */
    reset(): void {
      telemetry.attribution.captures.reset();
      telemetry.attribution.backfills.reset();
      telemetry.attribution.queries.reset();
    },
  },
  marketData: {
    /** Fehlgeschlagene Kerzenabrufe nach Ursache (MDERR-006). */
    fetchFailures: new LabelCounter("market_data_fetch_failures_total"),
    /**
     * Datenqualitäts-Befunde des Qualitäts-Layers (GAP-07, v1.47.0).
     * Label `class` ist die geschlossene Qualitäts-Klasse
     * (GAP/OUTLIER/INVALID/DUPLICATE/CROSSCHECK) — kein Symbol, kein TF
     * (Kardinalität wie beim Fetch-Counter).
     */
    qualityFindings: new LabelCounter("market_data_quality_findings_total"),
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
  /**
   * Backtest-Persistenz (RMA-P1-04, v1.52.0).
   *
   * `result` = created | replayed | failed, `reason` = `ok` oder ein
   * Code-konstanter Fehlercode (`ledger:*`, `persist:*`). Keine Run-IDs,
   * Instrumente oder Trade-IDs als Label (Kardinalitätsregel oben) — die
   * stehen im Audit-Event `BACKTEST_RUN_PERSISTED`.
   */
  backtest: {
    runPersist: new LabelCounter("backtest_run_persist_total"),
    /**
     * Event-Replay-Läufe (RMA-P1-01, v1.58.0): `result` = ok,
     * `degraded` = none | degraded (Lauf enthält degradierte Annahmen).
     * Keine Instrument-/Run-IDs als Label (Kardinalitätsregel oben).
     */
    replayRuns: new LabelCounter("backtest_replay_runs_total"),
    /**
     * Degradierte Replay-Annahmen je Grund — `reason` stammt aus dem
     * GESCHLOSSENEN Vokabular `ReplayDegradedReason` (bounded, kein Freitext).
     */
    replayDegraded: new LabelCounter("backtest_replay_degraded_total"),
    reset(): void {
      telemetry.backtest.runPersist.reset();
      telemetry.backtest.replayRuns.reset();
      telemetry.backtest.replayDegraded.reset();
    },
  },
  /**
   * Point-in-Time Feature Store (RMA-P6-01, v1.53.0).
   *
   * Labels sind Code-konstante Kategorien:
   *   * `result`  = written | null_value | duplicate | revision | created |
   *                 skipped | failed | ok | noop | dry_run | match | divergent
   *   * `reason`  = `metricLabel`-normalisierter Grund bzw. Fehlercode
   *   * `mode`    = INCREMENTAL | BACKFILL
   *
   * **Keine** Entity-/Instrument-IDs und keine Trade-IDs als Label
   * (Kardinalitätsregel wie oben); Feature-IDs stammen aus der geschlossenen
   * Registry und erscheinen deshalb nur dort, wo die Menge durch die Registry
   * begrenzt ist.
   */
  features: {
    /** Geschriebene Wertzeilen je Ergebnis und Grund/Feature. */
    materializationValues: new LabelCounter("feature_materialization_values_total"),
    /** Materialisierungsläufe je Ergebnis und Modus. */
    materializationRuns: new LabelCounter("feature_materialization_runs_total"),
    /** PIT-Abfragen je Ergebnis (ok | invalid | unavailable | truncated). */
    pitQueries: new LabelCounter("feature_pit_queries_total"),
    /** PIT-Antworten je Status (ok | null_value | missing | stale). */
    pitOutcomes: new LabelCounter("feature_pit_outcomes_total"),
    /** Paritätsvergleiche je Ergebnis (match | divergent). */
    parityChecks: new LabelCounter("feature_parity_checks_total"),
    /** alle Zähler der Feature-Sektion zurücksetzen (nur Tests) */
    reset(): void {
      telemetry.features.materializationValues.reset();
      telemetry.features.materializationRuns.reset();
      telemetry.features.pitQueries.reset();
      telemetry.features.pitOutcomes.reset();
      telemetry.features.parityChecks.reset();
    },
  },
  /**
   * Historische Perpetual-Daten (RMA-P2-02, v1.54.0).
   *
   * Labels sind ausschließlich Code-konstante Kategorien
   * (`kind` = funding | openInterest | liquidations, `result`, `class`,
   * `mode`, `stage`) — keine Instrument-IDs, keine Symbol-/Venue-Freitexte
   * (Kardinalitätsregel wie oben). Das Venue steht in den Audit-Events und im
   * Sync-Manifest, nicht im Label.
   */
  perp: {
    /** Sync-Läufe je Ergebnis und Modus. */
    syncRuns: new LabelCounter("perp_sync_runs_total"),
    /** Geschriebene Zeilen je Reihe und Ergebnis (written | duplicate | rejected). */
    syncRows: new LabelCounter("perp_sync_rows_total"),
    /** Qualitätsbefunde je Klasse (GAP | OUTLIER | INVALID | DUPLICATE | CROSSCHECK | STALE). */
    qualityFindings: new LabelCounter("perp_data_quality_findings_total"),
    /** Abweichende Sätze zum selben Schlüssel je Reihe (nicht überschrieben). */
    revisions: new LabelCounter("perp_data_revisions_total"),
    /** as-of-Abfragen je Verfügbarkeit (AVAILABLE | MISSING | STALE | UNSUPPORTED | UNAVAILABLE). */
    asOfQueries: new LabelCounter("perp_data_asof_queries_total"),
    /** alle Counter der Perp-Sektion zurücksetzen (nur Tests) */
    reset(): void {
      telemetry.perp.syncRuns.reset();
      telemetry.perp.syncRows.reset();
      telemetry.perp.qualityFindings.reset();
      telemetry.perp.revisions.reset();
      telemetry.perp.asOfQueries.reset();
    },
  },
  /**
   * Multidimensionale Regime-Erkennung (RMA-P2-01, v1.61.0).
   *
   * Labels sind ausschließlich Code-konstant (`result`) — keine Symbol-,
   * Order- oder Trade-IDs (Kardinalitätsregel wie überall).
   */
  regime: {
    /** Snapshot-Persistenz je Ergebnis (written | duplicate | skipped | error). */
    persist: new LabelCounter("regime_snapshot_persist_total"),
    /** Gate-Boost-Entscheidungen je Ergebnis (applied | blocked). */
    boosts: new LabelCounter("regime_gate_boost_total"),
    /** alle Counter der Regime-Sektion zurücksetzen (nur Tests) */
    reset(): void {
      telemetry.regime.persist.reset();
      telemetry.regime.boosts.reset();
    },
  },
  /**
   * Forecast-Ledger und Kalibrierung (RMA-P3-01, v1.55.0).
   *
   * Labels sind ausschließlich Code-konstante Kategorien (`result`,
   * `reason`-Klassen, `mode`, `status`) — keine Forecast-, Entity- oder
   * Agenten-IDs als Label (Kardinalitätsregel wie oben); IDs stehen in den
   * Audit-Events (`FORECAST_RECORDED`, `FORECAST_RESOLVED`, …) und im
   * Outcome-Manifest.
   */
  forecasts: {
    /** Capture-Versuche je Ergebnis (captured | skipped) und Skip-Grund. */
    captures: new LabelCounter("forecast_captures_total"),
    /** Auflösungen je Ergebnis (resolved | void | re_resolved | duplicate | failed). */
    resolutions: new LabelCounter("forecast_resolutions_total"),
    /** Resolver-Läufe je Ergebnis und Modus. */
    runs: new LabelCounter("forecast_resolution_runs_total"),
    /** Feed-Phase-Abrufe je Ergebnis (ok | failed). */
    feeds: new LabelCounter("forecast_feed_total"),
    /** Score-/List-API-Abfragen je Ergebnis (ok | invalid | unavailable | truncated). */
    queries: new LabelCounter("forecast_score_queries_total"),
    /** alle Zähler der Forecast-Sektion zurücksetzen (nur Tests) */
    reset(): void {
      telemetry.forecasts.captures.reset();
      telemetry.forecasts.resolutions.reset();
      telemetry.forecasts.runs.reset();
      telemetry.forecasts.feeds.reset();
      telemetry.forecasts.queries.reset();
    },
  },
  /**
   * Deterministische Multi-Timeframe-Konfluenz (RMA-P2-03, v1.62.0).
   *
   * Labels sind ausschließlich Code-konstant (`result` = ok | degraded |
   * abstain, `source` = cycle | analyst | backtest | scanner | api) — keine
   * Instrument-, Order- oder Trade-IDs als Label (Kardinalitätsregel wie
   * oben); IDs stehen im strukturierten Audit-Event `confluence_computed`.
   */
  confluence: {
    /** Snapshot-Berechnungen je Ergebnis und Quelle. */
    runs: new LabelCounter("confluence_runs_total"),
    /** alle Zähler der Konfluenz-Sektion zurücksetzen (nur Tests) */
    reset(): void {
      telemetry.confluence.runs.reset();
    },
  },
  /**
   * Point-in-Time Cross-Sectional Momentum Ranking (RMA-P2-04, v1.63.0).
   *
   * Labels sind ausschließlich Code-konstante Ergebniswerte
   * (`result`: ok | empty | error | store-error, `outcome`: persisted |
   * idempotent | pruned, `persist`: written | duplicate | pruned) —
   * KEINE Instrument-/Snapshot-IDs als Label (Kardinalitätsregel wie oben);
   * IDs stehen im strukturierten Audit-Event
   * `cross_sectional_snapshot_persisted`.
   */
  crossSectional: {
    /** Snapshot-Läufe je Ergebnis/Ausgang. */
    runs: new LabelCounter("cross_sectional_runs_total"),
    /** Persistenzschreibungen (written | duplicate | pruned). */
    persist: new LabelCounter("cross_sectional_persist_total"),
    /** Abweichende Mitglieder-Zeilen (fail-closed protokolliert). */
    rankConflicts: new LabelCounter("cross_sectional_rank_conflicts_total"),
    /** alle Zähler der Cross-Sectional-Sektion zurücksetzen (nur Tests) */
    reset(): void {
      telemetry.crossSectional.runs.reset();
      telemetry.crossSectional.persist.reset();
      telemetry.crossSectional.rankConflicts.reset();
    },
  },
  /**
   * Kalibrierbare strukturierte Sentiment-Outputs (RMA-P2-05, v1.64.0).
   *
   * Labels sind ausschließlich Code-konstante Ergebniswerte
   * (`status`: ACTIVE | ABSTAIN, `direction`: BULLISH | BEARISH | NEUTRAL | none,
   * `horizon`: 4h | 24h | 72h, `result`: captured | duplicate | skipped | unique | syndicated_duplicate) —
   * KEINE Instrument- oder Headline-IDs als Labels.
   */
  sentiment: {
    /** Sentiment-Auswertungen je Status, Richtung und Horizont. */
    evaluations: new LabelCounter("sentiment_evaluations_total"),
    /** Persistierte Sentiment-Forecasts je Ergebnis. */
    captures: new LabelCounter("sentiment_captures_total"),
    /** Syndikations-Deduplikationen je Ausgang (unique | syndicated_duplicate). */
    deduplications: new LabelCounter("sentiment_deduplications_total"),
    /** alle Zähler der Sentiment-Sektion zurücksetzen (nur Tests) */
    reset(): void {
      telemetry.sentiment.evaluations.reset();
      telemetry.sentiment.captures.reset();
      telemetry.sentiment.deduplications.reset();
    },
  },
  /**
   * Prompt-Version-Metrikvergleich (RMA-P3-02, v1.65.0).
   *
   * Labels sind ausschließlich Code-konstante Kategorien (`result`,
   * `role`, `status`) — keine Prompt-IDs, Texte oder Instrumente als Label
   * (Kardinalitätsregel wie oben). IDs stehen im strukturierten Audit-Event.
   */
  prompt: {
    /** Prompt-Artefakte je Ergebnis (created | duplicate). */
    artifacts: new LabelCounter("prompt_artifacts_total"),
    /** Agent-Runs (Provenanz) je Ergebnis (ok | error) und Provider. */
    runs: new LabelCounter("prompt_runs_total"),
    /** Metriken-/Vergleichs-Abfragen je Ergebnis (ok | invalid | unavailable | truncated). */
    queries: new LabelCounter("prompt_metrics_queries_total"),
    /** alle Zähler der Prompt-Sektion zurücksetzen (nur Tests) */
    reset(): void {
      telemetry.prompt.artifacts.reset();
      telemetry.prompt.runs.reset();
      telemetry.prompt.queries.reset();
    },
  },
  /**
   * Portfolio-Volatility-Targeting (RMA-P5-01, v1.67.0).
   *
   * Labels sind ausschließlich Code-konstante Kategorien:
   *   * `result` = ok | fallback | no_exposure | disabled | error
   *   * `reason` = geschlossener `VolatilityTargetingReasonCode` (bounded)
   *   * `mode`   = monitor | active
   *
   * Keine Instrument-/Trade-/Order-IDs als Label (Kardinalitätsregel wie
   * oben); Symbole stehen im Audit-Event und in der Snapshot-Tabelle.
   */
  volatilityTargeting: {
    /** Neubewertungs-Läufe je Ergebnis und Modus. */
    updates: new LabelCounter("volatility_targeting_updates_total"),
    /** Fallbacks je geschlossener Grund (stale_data, low_coverage, …). */
    fallbacks: new LabelCounter("volatility_targeting_fallbacks_total"),
    /** Persistierte Snapshots je Ergebnis (written | duplicate | failed). */
    snapshots: new LabelCounter("volatility_targeting_snapshots_total"),
    /** alle Zähler der VolTarget-Sektion zurücksetzen (nur Tests) */
    reset(): void {
      telemetry.volatilityTargeting.updates.reset();
      telemetry.volatilityTargeting.fallbacks.reset();
      telemetry.volatilityTargeting.snapshots.reset();
    },
  },
  /**
   * Hysteretisches Drawdown-Risk-Scaling (RMA-P5-04, v1.68.0).
   *
   * Labels sind ausschließlich Code-konstante Kategorien:
   *   * `result`     = bootstrap | ok | conservative | disabled
   *   * `mode`       = monitor | active
   *   * `stage`      = normal | soft | deep | pause
   *   * `transition` = none | degrade | recover | bootstrap
   *   * `reason`     = geschlossener `DrawdownScalingReasonCode` (bounded)
   *
   * Keine Instrument-/Trade-/Order-IDs und keine Konto-IDs als Label
   * (Kardinalitätsregel wie oben); Equity/HWM stehen in der Snapshot-Tabelle
   * und im Audit-Event, nicht in Metriken.
   */
  drawdownScaling: {
    /** Bewertungs-Läufe je Ergebnis und Modus. */
    updates: new LabelCounter("drawdown_scaling_updates_total"),
    /** Faktor-/Stufenwechsel je Transition und Stufe. */
    transitions: new LabelCounter("drawdown_scaling_transitions_total"),
    /** Fail-closed-Bewertungen je geschlossenem Reason-Code. */
    conservative: new LabelCounter("drawdown_scaling_conservative_total"),
    /** Persistierte Snapshots je Ergebnis (written | duplicate | failed). */
    snapshots: new LabelCounter("drawdown_scaling_snapshots_total"),
    /** alle Zähler der Drawdown-Scaling-Sektion zurücksetzen (nur Tests) */
    reset(): void {
      telemetry.drawdownScaling.updates.reset();
      telemetry.drawdownScaling.transitions.reset();
      telemetry.drawdownScaling.conservative.reset();
      telemetry.drawdownScaling.snapshots.reset();
    },
  },
  /**
   * Signal-Decay-Exits (RMA-P5-05, v1.69.0).
   *
   * Labels sind ausschließlich Code-Konstanten:
   *   * `result`         = would_exit | hold | skipped | suppressed | conflict | written | duplicate | failed
   *   * `mode`           = monitor | active
   *   * `strategy_class` = mean-reversion | trend | breakout | unclassified
   *
   * Keine Instrument-, Trade- oder Order-IDs als Label. Scores und
   * Positionen stehen im Audit-Event und in `signal_decay_events`.
   */
  signalDecay: {
    evaluations: new LabelCounter("signal_decay_evaluations_total"),
    events: new LabelCounter("signal_decay_events_total"),
    reset(): void {
      telemetry.signalDecay.evaluations.reset();
      telemetry.signalDecay.events.reset();
    },
  },
  /**
   * Execution-Policy-Controller (RMA-P4-02, v1.70.0).
   *
   * Labels sind ausschließlich Code-Konstanten:
   *   * `from`/`to` = Workflow-Zustände (geschlossene Liste)
   *   * `reason`    = geschlossene Reason-Codes (kein Venue-Freitext)
   *   * `venue`     = Venue-ID (7 Werte)
   *   * `code`      = geschlossene Reject-Codes
   *   * `outcome`   = SUBMITTED | BLOCKED | FILLED | FAILED
   *
   * Keine Instrument-, Trade- oder Order-IDs als Label — die stehen im
   * Audit-Event `EXECUTION_POLICY_TRANSITION` und in den Workflow-Tabellen.
   */
  executionPolicy: {
    /** Zustandswechsel je Kante und Reason. */
    transitions: new LabelCounter("execution_policy_transitions_total"),
    /** Venue-Rejects je Venue und geschlossenem Code. */
    rejects: new LabelCounter("execution_policy_rejects_total"),
    /** Market-Fallbacks je Venue und Outcome. */
    fallbacks: new LabelCounter("execution_policy_fallback_total"),
    /** Überfüllungs-Befunde je Venue (sollte immer 0 bleiben). */
    overfills: new LabelCounter("execution_policy_overfill_total"),
    reset(): void {
      telemetry.executionPolicy.transitions.reset();
      telemetry.executionPolicy.rejects.reset();
      telemetry.executionPolicy.fallbacks.reset();
      telemetry.executionPolicy.overfills.reset();
    },
  },
  /**
   * TWAP-/Depth-Scheduler (RMA-P4-03, v1.71.0).
   *
   * Labels sind Code-Konstanten (`outcome`, `kind`, `reason`) — keine
   * Parent-Keys, Slice-Indizes oder Instrumente.
   */
  twap: {
    ticks: new LabelCounter("twap_ticks_total"),
    events: new LabelCounter("twap_events_total"),
    reset(): void {
      telemetry.twap.ticks.reset();
      telemetry.twap.events.reset();
    },
  },
  /**
   * Monte-Carlo-/Trade-Resampling (RMA-P6-02, v1.72.0). Labels sind
   * ausschließlich Code-konstante Werte: `result` = created | replayed |
   * failed, `reason` = `metricLabel`-normalisierter Fehlercode, `method` =
   * iid | moving_block | stationary_block (geschlossene Menge) — KEINE Run-/
   * Instrument-/Trade-IDs als Labels (Kardinalitätsregel).
   */
  monteCarlo: {
    runs: new LabelCounter("monte_carlo_runs_total"),
    queries: new LabelCounter("monte_carlo_queries_total"),
    reset(): void {
      telemetry.monteCarlo.runs.reset();
      telemetry.monteCarlo.queries.reset();
    },
  },
  /**
   * Strategy-Lifecycle / Drift-Gates (RMA-P1-05, v1.73.0).
   *
   * Labels ausschließlich Code-konstant (`result`, `to`, `kind`, `verdict`,
   * `action`, `code` via metricLabel) — KEINE Strategie-Keys, Order-/Trade-IDs
   * oder Instrumente (Kardinalitätsregel).
   */
  strategyLifecycle: {
    /** Zustandsübergänge je Ergebnis und Zielzustand. */
    transitions: new LabelCounter("strategy_lifecycle_transitions_total"),
    /** Evidence-Schreibungen je Art und Ergebnis. */
    evidence: new LabelCounter("strategy_lifecycle_evidence_total"),
    /** Drift-Bewertungen je Verdict und empfohlener Aktion. */
    driftChecks: new LabelCounter("strategy_lifecycle_drift_checks_total"),
    /** Order-Gate-Entscheidungen je Result und bounded Reason-Code. */
    gateDecisions: new LabelCounter("strategy_lifecycle_gate_decisions_total"),
    reset(): void {
      telemetry.strategyLifecycle.transitions.reset();
      telemetry.strategyLifecycle.evidence.reset();
      telemetry.strategyLifecycle.driftChecks.reset();
      telemetry.strategyLifecycle.gateDecisions.reset();
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
    telemetry.marketData.qualityFindings.exposition(),
    telemetry.audit.writeFailures.exposition(),
    telemetry.audit.spooled.exposition(),
    telemetry.audit.spoolDrained.exposition(),
    telemetry.audit.missed.exposition(),
    telemetry.backtest.runPersist.exposition(),
    telemetry.backtest.replayRuns.exposition(),
    telemetry.backtest.replayDegraded.exposition(),
    telemetry.monteCarlo.runs.exposition(),
    telemetry.monteCarlo.queries.exposition(),
    telemetry.strategyLifecycle.transitions.exposition(),
    telemetry.strategyLifecycle.evidence.exposition(),
    telemetry.strategyLifecycle.driftChecks.exposition(),
    telemetry.strategyLifecycle.gateDecisions.exposition(),
    telemetry.executionQuality.exposition(),
    telemetry.features.materializationValues.exposition(),
    telemetry.features.materializationRuns.exposition(),
    telemetry.features.pitQueries.exposition(),
    telemetry.features.pitOutcomes.exposition(),
    telemetry.features.parityChecks.exposition(),
    telemetry.perp.syncRuns.exposition(),
    telemetry.perp.syncRows.exposition(),
    telemetry.perp.qualityFindings.exposition(),
    telemetry.perp.revisions.exposition(),
    telemetry.perp.asOfQueries.exposition(),
    telemetry.regime.persist.exposition(),
    telemetry.regime.boosts.exposition(),
    telemetry.confluence.runs.exposition(),
    telemetry.crossSectional.runs.exposition(),
    telemetry.crossSectional.persist.exposition(),
    telemetry.crossSectional.rankConflicts.exposition(),
    telemetry.sentiment.evaluations.exposition(),
    telemetry.sentiment.captures.exposition(),
    telemetry.sentiment.deduplications.exposition(),
    telemetry.forecasts.captures.exposition(),
    telemetry.forecasts.resolutions.exposition(),
    telemetry.forecasts.runs.exposition(),
    telemetry.forecasts.feeds.exposition(),
    telemetry.forecasts.queries.exposition(),
    telemetry.prompt.artifacts.exposition(),
    telemetry.prompt.runs.exposition(),
    telemetry.prompt.queries.exposition(),
    telemetry.volatilityTargeting.updates.exposition(),
    telemetry.volatilityTargeting.fallbacks.exposition(),
    telemetry.volatilityTargeting.snapshots.exposition(),
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
    telemetry.backtest.runPersist.exposition(),
    telemetry.executionQuality.exposition(),
  );

  return lines.join("\n");
}

/** Nur für Tests: alle Counter zurücksetzen. */
export function resetTelemetryForTests(): void {
  telemetry.marketData.fetchFailures.reset();
  telemetry.marketData.qualityFindings.reset();
  telemetry.audit.reset();
  telemetry.firm.reset();
  telemetry.backtest.reset();
  telemetry.confluence.reset();
  telemetry.crossSectional.reset();
  telemetry.sentiment.reset();
  telemetry.forecasts.reset();
  telemetry.prompt.reset();
  telemetry.volatilityTargeting.reset();
  telemetry.executionPolicy.reset();
  telemetry.twap.reset();
  telemetry.monteCarlo.reset();
  telemetry.strategyLifecycle.reset();
}
