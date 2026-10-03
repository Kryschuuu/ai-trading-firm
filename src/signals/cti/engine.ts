/**
 * Claude Trading Indicator (CTI) — Trading-Engine (Live-/Paper-Pfad).
 *
 * Die Engine macht aus Indikator-Signalen **Handlungsabsichten** (Intents)
 * und hält nach, in welcher Richtung sie gerade steht. Sie ist bewusst
 * IO-frei: kein DB-, Broker-, LLM- oder Netzwerk-Import. Ausgeführt wird
 * über einen injizierten {@link CtiExecutionPort} — dieselbe Trennung wie
 * zwischen `MicroExecutor` und `RuleExecutionAdapter`
 * (`src/lib/microExecutor.ts`). Damit gilt für diese Datei dieselbe
 * Garantie wie für den Mikro-Zyklus: Sie kann prinzipbedingt keine Order
 * auslösen, die der Ausführungs-Adapter nicht freigibt.
 *
 * ── Ablauf je geschlossener Kerze ──────────────────────────────────────────
 *   1. Kerze in den {@link CtiRuntime} (derselbe Automat wie im Backtest).
 *   2. **Schutz zuerst:** Hat der Kurs den aktiven Stop durchhandelt
 *      (`low <= stop` long, `high >= stop` short), entsteht ein `EXIT` mit
 *      Grund `STOP_LOSS` — noch bevor ein neues Signal gelesen wird.
 *   3. Signal auswerten:
 *      - Gegenrichtung offen ⇒ `EXIT` (`OPPOSITE_SIGNAL`), dann `ENTER`.
 *      - Flach ⇒ `ENTER` mit dem eingefrorenen ATR-Stop des Signalbars.
 *      - Gleiche Richtung offen ⇒ `ADJUST_STOP` (das Skript setzt
 *        `activeLongStop` bei jedem Signal neu; die Position wird NICHT
 *        aufgestockt — eine Pyramide steht nicht im Skript).
 *   4. Intents an den Port; der interne Positionszustand wird **erst nach
 *      Bestätigung** fortgeschrieben (`ok: true`). Lehnt der Port ab, bleibt
 *      die Engine bei ihrer bisherigen Sicht und meldet `rejected` — nie ein
 *      stiller Zustandswechsel.
 *
 * ── Unterschied zur Chart-Darstellung ──────────────────────────────────────
 * Pine prüft den Stop auch auf dem Signalbar selbst (dort endet die Linie).
 * Eine Position entsteht aber erst MIT dem Schlusskurs dieses Bars — ein
 * Tief, das vorher lag, kann sie nicht treffen. Die Engine prüft den Stop
 * deshalb ab der Folgekerze. Der Indikator meldet `stopHit` unverändert
 * (`CtiBar.stopHit`), damit Chart und Log vergleichbar bleiben.
 */

import { ctiWarmupBars, resolveCtiParams, type CtiParams } from "./params";
import { CtiRuntime } from "./runtime";
import type { CtiBar, CtiCandle, CtiSignalKind } from "./types";

/** Richtung einer Position. */
export type CtiSide = "LONG" | "SHORT";

/** Warum eine Absicht entstanden ist (geschlossenes Vokabular für Logs/Metriken). */
export type CtiIntentReason =
  | "SIGNAL"
  | "OPPOSITE_SIGNAL"
  | "STOP_LOSS"
  | "REARM_STOP";

/** Eine Handlungsabsicht der Engine. */
export interface CtiIntent {
  kind: "ENTER" | "EXIT" | "ADJUST_STOP";
  symbol: string;
  side: CtiSide;
  /** Referenzkurs: Schlusskurs der Kerze bzw. Stop-Preis beim Stop-Ausstieg. */
  price: number;
  /** Stop-Preis der Position (`ENTER`/`ADJUST_STOP`; `null` = kein ATR). */
  stopLoss: number | null;
  reason: CtiIntentReason;
  /** Zeitstempel der auslösenden Kerze (Epoch-ms). */
  time: number;
  /** Bar-Index innerhalb der Engine-Reihe dieses Symbols. */
  barIndex: number;
}

/** Position, wie die Engine sie SIEHT (die Wahrheit liegt beim Broker). */
export interface CtiPosition {
  symbol: string;
  side: CtiSide;
  entryPrice: number;
  stopLoss: number | null;
  entryTime: number;
  entryBarIndex: number;
}

/** Ergebnis einer Port-Ausführung. */
export interface CtiExecutionResult {
  /** `false` ⇒ die Engine übernimmt den Zustandswechsel NICHT. */
  ok: boolean;
  /** Klassifizierter Grund (z. B. `KILL_SWITCH_ARMED`) — kein Freitext mit IDs. */
  reason?: string;
  /** Optionale Order-Referenz des Adapters. */
  orderId?: string;
  /** Tatsächlicher Ausführungskurs, falls der Adapter einen kennt. */
  fillPrice?: number;
}

/**
 * Ausführungs-Adapter. Implementierungen dürfen (und sollen) alles prüfen,
 * was der Code sonst auch prüft: Kill-Switch, Live-Gate, Risk-Limits,
 * Positionsgrenzen. Die Engine akzeptiert jedes `ok: false` wortlos.
 */
export interface CtiExecutionPort {
  readonly name: string;
  apply(intent: CtiIntent): Promise<CtiExecutionResult> | CtiExecutionResult;
}

/** Konfiguration der Trading-Engine. */
export interface CtiEngineOptions {
  /** CTI-Parameter (werden geklemmt, siehe `resolveCtiParams`). */
  params?: Partial<CtiParams> | null;
  /**
   * `SELL` als Short handeln (Default `true`). `false` = Long-only: Ein
   * Verkaufssignal schließt eine Long-Position, eröffnet aber nichts.
   */
  tradeShorts?: boolean;
  /** Timeframe-Label für Logs/Alerts (z. B. `"1h"`). Rein beschreibend. */
  timeframe?: string;
  /** Ausführungs-Adapter. Fehlt er, arbeitet die Engine im Trockenlauf. */
  port?: CtiExecutionPort | null;
}

/** Auswertung einer Kerze: Indikator-Bar + daraus folgende Absichten. */
export interface CtiEvaluation {
  symbol: string;
  bar: CtiBar;
  intents: CtiIntent[];
}

/** Ergebnis eines vollständigen Schritts inklusive Ausführung. */
export interface CtiStepResult extends CtiEvaluation {
  /** Ausgeführte (vom Port bestätigte) Absichten. */
  applied: CtiIntent[];
  /** Vom Port abgelehnte Absichten mit Begründung. */
  rejected: { intent: CtiIntent; reason: string }[];
  /** Position NACH dem Schritt (`null` = flach). */
  position: CtiPosition | null;
}

/** Status eines Symbols (Observability). */
export interface CtiSymbolStatus {
  symbol: string;
  bars: number;
  warmupBars: number;
  /** `true`, sobald genügend Bars für ein mögliches Signal verarbeitet sind. */
  warm: boolean;
  lastTime: number | null;
  verdict: CtiBar["verdict"] | null;
  bullStreak: number;
  bearStreak: number;
  lastSignal: CtiSignalKind | null;
  lastSignalAt: number | null;
  position: CtiPosition | null;
  intents: number;
  rejected: number;
}

/** Status der Engine insgesamt. */
export interface CtiEngineStatus {
  params: Readonly<CtiParams>;
  clamped: readonly string[];
  tradeShorts: boolean;
  timeframe: string | null;
  port: string | null;
  symbols: CtiSymbolStatus[];
}

interface SymbolState {
  symbol: string;
  runtime: CtiRuntime;
  position: CtiPosition | null;
  lastSignal: CtiSignalKind | null;
  lastSignalAt: number | null;
  intents: number;
  rejected: number;
}

/**
 * Deterministische, IO-freie CTI-Trading-Engine.
 *
 * Mehrere Symbole teilen sich eine Instanz; jedes Symbol hat seinen eigenen
 * Automaten und seine eigene Positionssicht. Die Engine verwaltet KEIN
 * Kapital und keine Stückzahl — Sizing, Risikobudget und Guardrails gehören
 * in den Ausführungs-Adapter, wo der Rest des Systems sie bereits
 * implementiert hat.
 */
export class CtiTradingEngine {
  readonly params: Readonly<CtiParams>;
  readonly clamped: readonly string[];
  readonly warmupBars: number;
  private readonly tradeShorts: boolean;
  private readonly timeframe: string | null;
  private readonly port: CtiExecutionPort | null;
  private readonly states = new Map<string, SymbolState>();

  constructor(options: CtiEngineOptions = {}) {
    const resolved = resolveCtiParams(options.params ?? null);
    this.params = Object.freeze({ ...resolved.params });
    this.clamped = Object.freeze([...resolved.clamped]);
    this.warmupBars = ctiWarmupBars(resolved.params);
    this.tradeShorts = options.tradeShorts !== false;
    this.timeframe = options.timeframe ?? null;
    this.port = options.port ?? null;
  }

  /** Symbol registrieren (idempotent) und optional mit Historie aufwärmen. */
  register(symbol: string, history: readonly CtiCandle[] = []): void {
    const state = this.stateOf(symbol);
    for (const candle of history) state.runtime.push(candle);
  }

  /**
   * Übernimmt eine bestehende Position als Ausgangslage (Reconciliation mit
   * dem Broker nach einem Neustart). Erzeugt KEINE Order und verändert den
   * Indikator nicht.
   */
  adoptPosition(position: CtiPosition | null, symbol?: string): void {
    const key = position ? position.symbol : symbol;
    if (!key) throw new Error("CTI-Engine: adoptPosition braucht ein Symbol.");
    this.stateOf(key).position = position;
  }

  /** Aktuelle Positionssicht (`null` = flach). */
  positionOf(symbol: string): CtiPosition | null {
    return this.states.get(symbol)?.position ?? null;
  }

  /** Letzter ausgewerteter Bar eines Symbols. */
  lastBarOf(symbol: string): CtiBar | null {
    return this.states.get(symbol)?.runtime.last ?? null;
  }

  /**
   * Wertet eine geschlossene Kerze aus, OHNE Positionen fortzuschreiben.
   *
   * Reine Sicht auf „was wäre zu tun": Der Indikator konsumiert die Kerze
   * (das ist der Sinn der Übung), die Positionssicht bleibt unberührt, bis
   * {@link commit} oder {@link onClosedCandle} sie bestätigt.
   */
  evaluate(symbol: string, candle: CtiCandle): CtiEvaluation {
    const state = this.stateOf(symbol);
    const bar = state.runtime.push(candle);
    const intents: CtiIntent[] = [];
    const position = state.position;

    // 1. Schutz zuerst: Stop der laufenden Position gegen DIESE Kerze.
    //    Die Einstiegskerze selbst ist ausgenommen — die Position entsteht
    //    erst mit ihrem Schlusskurs.
    if (position && position.stopLoss !== null && position.entryBarIndex < bar.index) {
      const hit =
        position.side === "LONG" ? candle.low <= position.stopLoss : candle.high >= position.stopLoss;
      if (hit) {
        intents.push({
          kind: "EXIT",
          symbol,
          side: position.side,
          price: position.stopLoss,
          stopLoss: position.stopLoss,
          reason: "STOP_LOSS",
          time: candle.time,
          barIndex: bar.index,
        });
      }
    }

    // 2. Signal auswerten. `stoppedOut` ist die Sicht NACH Schritt 1 — ein
    //    Stop-Ausstieg und ein Umkehrsignal auf derselben Kerze ergeben
    //    keinen doppelten Ausstieg.
    if (bar.signal !== null) {
      const stoppedOut = intents.some((intent) => intent.kind === "EXIT");
      const held = stoppedOut ? null : position;
      const wanted: CtiSide = bar.signal === "BUY" ? "LONG" : "SHORT";
      const stopLoss = bar.signal === "BUY" ? bar.activeLongStop : bar.activeShortStop;

      if (held && held.side !== wanted) {
        intents.push({
          kind: "EXIT",
          symbol,
          side: held.side,
          price: candle.close,
          stopLoss: held.stopLoss,
          reason: "OPPOSITE_SIGNAL",
          time: candle.time,
          barIndex: bar.index,
        });
      }

      const canEnter = wanted === "LONG" || this.tradeShorts;
      if (canEnter) {
        if (held && held.side === wanted) {
          // Pine setzt `activeLongStop` bei jedem Signal neu — kein Nachkauf.
          if (stopLoss !== null && stopLoss !== held.stopLoss) {
            intents.push({
              kind: "ADJUST_STOP",
              symbol,
              side: wanted,
              price: candle.close,
              stopLoss,
              reason: "REARM_STOP",
              time: candle.time,
              barIndex: bar.index,
            });
          }
        } else {
          intents.push({
            kind: "ENTER",
            symbol,
            side: wanted,
            price: candle.close,
            stopLoss,
            reason: "SIGNAL",
            time: candle.time,
            barIndex: bar.index,
          });
        }
      }
    }

    return { symbol, bar, intents };
  }

  /**
   * Schreibt eine bestätigte Absicht in die Positionssicht fort.
   * Nur aufrufen, wenn der Ausführungs-Adapter sie angenommen hat.
   */
  commit(intent: CtiIntent, fillPrice?: number): void {
    const state = this.stateOf(intent.symbol);
    const price = Number.isFinite(fillPrice) ? (fillPrice as number) : intent.price;
    switch (intent.kind) {
      case "EXIT":
        state.position = null;
        return;
      case "ENTER":
        state.position = {
          symbol: intent.symbol,
          side: intent.side,
          entryPrice: price,
          stopLoss: intent.stopLoss,
          entryTime: intent.time,
          entryBarIndex: intent.barIndex,
        };
        return;
      case "ADJUST_STOP":
        if (state.position) state.position = { ...state.position, stopLoss: intent.stopLoss };
        return;
    }
  }

  /**
   * Vollständiger Schritt: auswerten, ausführen, Zustand fortschreiben.
   *
   * Ohne Port (Trockenlauf) gilt jede Absicht als ausgeführt — damit ist der
   * Ablauf identisch zur Simulation und in Tests prüfbar. Mit Port zählt
   * ausschließlich dessen `ok`.
   */
  async onClosedCandle(symbol: string, candle: CtiCandle): Promise<CtiStepResult> {
    const state = this.stateOf(symbol);
    const evaluation = this.evaluate(symbol, candle);
    const applied: CtiIntent[] = [];
    const rejected: { intent: CtiIntent; reason: string }[] = [];

    for (const intent of evaluation.intents) {
      state.intents += 1;
      if (!this.port) {
        this.commit(intent);
        applied.push(intent);
        continue;
      }
      let outcome: CtiExecutionResult;
      try {
        outcome = await this.port.apply(intent);
      } catch (error) {
        outcome = {
          ok: false,
          reason: error instanceof Error ? `PORT_ERROR:${error.name}` : "PORT_ERROR",
        };
      }
      if (outcome.ok) {
        this.commit(intent, outcome.fillPrice);
        applied.push(intent);
      } else {
        state.rejected += 1;
        rejected.push({ intent, reason: outcome.reason ?? "REJECTED" });
      }
    }

    if (evaluation.bar.signal !== null) {
      state.lastSignal = evaluation.bar.signal;
      state.lastSignalAt = evaluation.bar.time;
    }

    return { ...evaluation, applied, rejected, position: state.position };
  }

  /** Status aller registrierten Symbole (stabil nach Symbol sortiert). */
  status(): CtiEngineStatus {
    const symbols = Array.from(this.states.keys()).sort();
    return {
      params: this.params,
      clamped: this.clamped,
      tradeShorts: this.tradeShorts,
      timeframe: this.timeframe,
      port: this.port?.name ?? null,
      symbols: symbols.map((symbol) => {
        const state = this.states.get(symbol) as SymbolState;
        const last = state.runtime.last;
        return {
          symbol,
          bars: state.runtime.bars,
          warmupBars: this.warmupBars,
          warm: state.runtime.bars >= this.warmupBars,
          lastTime: last ? last.time : null,
          verdict: last ? last.verdict : null,
          bullStreak: last ? last.bullStreak : 0,
          bearStreak: last ? last.bearStreak : 0,
          lastSignal: state.lastSignal,
          lastSignalAt: state.lastSignalAt,
          position: state.position,
          intents: state.intents,
          rejected: state.rejected,
        };
      }),
    };
  }

  private stateOf(symbol: string): SymbolState {
    const key = typeof symbol === "string" ? symbol.trim() : "";
    if (!key) throw new Error("CTI-Engine: Symbol darf nicht leer sein.");
    let state = this.states.get(key);
    if (!state) {
      state = {
        symbol: key,
        runtime: new CtiRuntime(this.params),
        position: null,
        lastSignal: null,
        lastSignalAt: null,
        intents: 0,
        rejected: 0,
      };
      this.states.set(key, state);
    }
    return state;
  }
}
