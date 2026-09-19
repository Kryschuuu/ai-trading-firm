/**
 * Positions- und Marktdaten-Monitor.
 *
 * Der `tick()` wird vom Scheduler (instrumentation.ts) alle 60 s aufgerufen
 * (oder manuell via POST /api/firm/tick):
 *
 *   1. Kurse der Watchlist + aller offenen Positionen aktualisieren
 *   2. SL/TP/Trailing-Stop/Time-Stop je offener Position prüfen (GAP-05) →
 *      ggf. schließen; OCO-Exklusivität über atomaren DB-Claim (genau ein
 *      Exit je Position, auch bei parallelen Ticks/Instanzen)
 *   3. currentPrice/realizedPnl in der DB nachführen
 *   4. Tagesverlust-Limit prüfen → Auto-Kill für den Rest des Tages
 *   5. Periodisch einen Multi-Market-Scan ins Gedächtnis schreiben
 *
 * Wichtig: Der Monitor läuft AUCH bei gezogenem Kill-Switch weiter — das
 * Schließen von Positionen darf nie blockiert werden.
 */
import { db } from "@/db";
import { agentMessages, positions } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getBroker, logAudit } from "./engine";
import type { PaperBroker, Fill } from "./broker";
import { decideExit, loadExitConfig, type ExitReason } from "./exits";
import { getLimits, killSwitch } from "./riskGuard";
import { checkCircuitBreaker, type CircuitBreakerOutcome } from "./circuitBreaker";
import { state } from "./stateRegistry";
import type { AdaptiveRegime } from "./riskGuard";
import { DEFAULT_WATCHLIST, getQuote, refreshQuotes, getCandles } from "./marketData";
import { MarketDataFetchError } from "./marketDataErrors";
import { snapshot, snapshotLine } from "./indicators";
import { refreshRuntimeLimits } from "./riskConfigService";
import { updateAdaptiveRisk } from "./adaptiveRisk";
import { refreshInstrumentRegimes } from "./marketRegime";
import { realizedPnlToday, writeEquitySnapshot, pruneEquitySnapshots } from "./equity";
import { FundingAccrualEngine, loadFundingConfig, runFundingAccrual } from "./funding";
import { completeJournalRow } from "./journal";
import { getProductionMarketDataManager } from "./marketdata/production";

const GLOBAL = globalThis as typeof globalThis & {
  __lastTickAt?: number;
  __tickCount?: number;
  __scanCount?: number;
  /** Single-Flight-Schutz: verhindert überlappende Monitor-Zyklen. */
  __tickLock?: Promise<TickResult> | null;
  /** GAP-02: Accrual-Engine (Periodenwechsel-Zustand) — pro Prozess einmal. */
  __fundingEngine?: FundingAccrualEngine;
};

const SCAN_EVERY_TICKS = 15; // alle 15 Minuten ein Marktbericht
const PRUNE_EVERY_TICKS = 240; // Retention ~alle 4 Stunden prüfen

export type TickResult = {
  at: string;
  quotesRefreshed: number;
  stopsTriggered: { symbol: string; reason: string; pnl: number }[];
  /**
   * GAP-02 (v1.42.0): in diesem Tick gebuchte Funding-Accruals (nur bei
   * Periodenwechsel nicht-leer; `funding` = Cashflow aus Kontosicht,
   * negativ = gezahlt). Default-Konfiguration (Rate 0) → immer leer.
   */
  fundingAccruals: { symbol: string; funding: number; fundingPaid: number }[];
  dailyLossKill: boolean;
  /**
   * GAP-10 (v1.45.0): Zustand des Auto-Circuit-Breakers nach diesem Tick.
   * `engaged` = in DIESEM Tick ausgeloest, `latched` = Brecher ist (weiterhin)
   * gesperrt; `null` = Pruefung nicht moeglich (z. B. Flag aus oder Fehler).
   */
  circuitBreaker: {
    engaged: boolean;
    latched: boolean;
    reason: string | null;
    metric: string | null;
    value: number | null;
    limit: number | null;
  } | null;
  marketScan: boolean;
  errors: string[];
  /** Zustand des adaptiven Risk-Systems nach diesem Tick (v1.7.0). */
  adaptiveRisk: {
    regime: AdaptiveRegime;
    factor: number;
    baseMaxRiskPerTrade: number;
    effectiveMaxRiskPerTrade: number;
    reason: string;
  } | null;
  /**
   * GAP-06 (v1.46.0): Markt-Regime der offenen Positionen nach diesem Tick
   * (best-effort; leer bei injizierten Test-Kursen oder ohne Positionen).
   */
  marketRegimes: { symbol: string; regime: string }[];
};

/**
 * Optionen für einen Monitor-Zyklus (v1.44.0) — primär für deterministische
 * Tests (Fake-Clock, injizierte Kurse, Scan-Unterdrückung) gedacht, ohne das
 * Produktivverhalten zu verändern.
 */
export type TickOptions = {
  /** Fester Zeitstempel (ms, epoch) — für die Haltedauer-/Time-Stop-Prüfung und alle `updatedAt`. */
  now?: number;
  /** Vorab bekannte Kurse (Symbol → Preis); umgeht den Netzwerk-Quote im Test. */
  quotes?: Record<string, number>;
  /** Marktscan unterdrücken (Tests, um Netzwerk-Zugriff zu vermeiden). */
  skipScan?: boolean;
};

/**
 * Ein voller Monitor-Zyklus. Idempotent und gegen Doppelstart geschützt.
 *
 * KORRIGIERT (v1.1.0): Single-Flight-Schutz. Läuft ein Zyklus (Scheduler +
 * manueller POST /tick überlappen z. B.), bekommt der zweite Aufrufer das
 * Ergebnis des laufenden Zyklus, statt einen zweiten parallel zu starten
 * (doppelte Snapshots, konkurrierende DB-Updates). Der zweite, echte Schutz
 * gegen Doppel-Exits wirkt DB-seitig (atomarer Claim in `applyExit`, GAP-05)
 * und gilt damit auch über Prozessgrenzen hinweg.
 */
export function tick(forceScan = false, opts: TickOptions = {}): Promise<TickResult> {
  if (GLOBAL.__tickLock) return GLOBAL.__tickLock;
  const run = doTick(forceScan, opts).finally(() => {
    GLOBAL.__tickLock = null;
  });
  GLOBAL.__tickLock = run;
  return run;
}

async function doTick(forceScan: boolean, opts: TickOptions = {}): Promise<TickResult> {
  await refreshRuntimeLimits();
  // Einheitlicher, deterministischer Zeitstempel für diesen Zyklus.
  const now = typeof opts.now === "number" ? new Date(opts.now) : new Date();
  const errors: string[] = [];

  // Adaptives Risk-Limit: Volatilität bewerten und maxRiskPerTrade ggf.
  // senken — vor der Positions-Prüfung, damit offene Orders gegen das
  // frisch reduzierte Limit laufen. Fehler bleiben lokal (Fail-Safe).
  let adaptiveRisk: TickResult["adaptiveRisk"] = null;
  try {
    const st = await updateAdaptiveRisk();
    adaptiveRisk = {
      regime: st.regime,
      factor: st.factor,
      baseMaxRiskPerTrade: st.baseMaxRiskPerTrade,
      effectiveMaxRiskPerTrade: st.effectiveMaxRiskPerTrade,
      reason: st.reason,
    };
  } catch (e) {
    errors.push(`Adaptives-Risiko fehlgeschlagen: ${e instanceof Error ? e.message : e}`);
  }

  const limits = getLimits();
  const broker = await getBroker();
  const stopsTriggered: TickResult["stopsTriggered"] = [];
  const fundingAccruals: TickResult["fundingAccruals"] = [];

  // --- 1) Kurse: offene Positionen zuerst, dann Watchlist ---
  const openRows = await db.select().from(positions).where(eq(positions.status, "OPEN"));
  const symbols = [
    ...openRows.map((p) => p.symbol),
    ...DEFAULT_WATCHLIST,
  ];
  let priceOf: Map<string, number>;
  if (opts.quotes) {
    // Test/Injektion: vorab bekannte Kurse (umgeht den Netzwerk-Quote).
    priceOf = new Map(Object.entries(opts.quotes).map(([k, v]) => [k.toUpperCase(), v]));
  } else {
    const quotes = await refreshQuotes(symbols);
    priceOf = new Map(quotes.map((q) => [q.symbol, q.price]));
  }

  // --- 1b) Markt-Regime je offener Position (GAP-06, v1.46.0) ---
  // Best-effort + fail-soft: versorgt Ops-Center, Cycle-Artefakte und das
  // Regime-Gate mit aktuellen Ständen. Bewusst NUR ohne injizierte Kurse
  // (opts.quotes = Test-/Determinismus-Pfad) — dort gibt es keine Kerzen.
  // Fehler je Symbol bleiben lokal; der Tick läuft immer weiter.
  let marketRegimes: TickResult["marketRegimes"] = [];
  if (!opts.quotes) {
    try {
      const snaps = await refreshInstrumentRegimes(openRows.map((p) => p.symbol), { now: now.getTime() });
      marketRegimes = snaps.map((s) => ({ symbol: s.symbol, regime: s.regime }));
    } catch (e) {
      errors.push(`Markt-Regime fehlgeschlagen: ${e instanceof Error ? e.message : e}`);
    }
  }

  // --- 2) SL/TP/Trailing/Time-Stop je Position prüfen (server-seitig, OCO) ---

  const closedThisTick = new Set<string>();
  const exitConfig = loadExitConfig();
  for (const row of openRows) {
    const price = priceOf.get(row.symbol.toUpperCase()) ?? Number(row.currentPrice ?? row.entryPrice);
    if (!Number.isFinite(price)) continue;

    const entry = Number(row.entryPrice);
    const side: "LONG" | "SHORT" = row.side === "SHORT" ? "SHORT" : "LONG";
    const sl = row.stopLoss != null ? Number(row.stopLoss) : null;
    const tp = row.takeProfit != null ? Number(row.takeProfit) : null;

    // currentPrice immer fortschreiben (auch ohne Exit)
    await db
      .update(positions)
      .set({ currentPrice: String(price), updatedAt: now })
      .where(eq(positions.id, row.id));

    // Reine, deterministische Exit-Entscheidung (SL/TP/Trailing/Time-Stop).
    const decision = decideExit(
      {
        side,
        entryPrice: entry,
        price,
        stopLoss: sl,
        takeProfit: tp,
        trailingStop: row.trailingStop != null ? Number(row.trailingStop) : null,
        trailingArmed: row.trailingArmed === true,
        createdAtMs: new Date(row.createdAt).getTime(),
        nowMs: now.getTime(),
      },
      exitConfig,
    );

    // Trailing-Zustand persistieren, wenn er sich geändert hat (Ratchet → nur
    // erweitern, nie verengen — konservativ, siehe src/lib/exits.ts).
    if (decision.trailingChanged) {
      await db
        .update(positions)
        .set({
          trailingArmed: decision.trailingArmed,
          trailingStop: decision.trailingStop == null ? null : String(decision.trailingStop),
          updatedAt: now,
        })
        .where(eq(positions.id, row.id));

      // Zustand ist eine Mutation → Audit, aber NUR je Bewaffnung einmal
      // (false→true): reine Ratchet-Anhebungen sind Zustandspflege und
      // würden den Audit-Log pro Tick fluten. Der Exit selbst auditiert
      // separat mit Trigger-Preis (applyExit).
      if (decision.trailingArmed && row.trailingArmed !== true) {
        await logAudit("TRAILING_STOP_ARMED", "INFO", {
          symbol: row.symbol,
          entry,
          price,
          trailingStop: decision.trailingStop,
          activationPct: exitConfig.trailingActivationPct,
          returnPct: exitConfig.trailingReturnPct,
          code: `trailing-arm:${row.symbol}`,
        });
      }
    }

    if (decision.reason == null) continue;
    if (decision.bothHit) {
      // Beide (SL+TP) im selben Intervall berührt → konservativ: Stop zuerst.
      errors.push(`${row.symbol}: SL+TP gleichzeitig berührt — Stop hat Vorrang`);
    }

    // Atomarer, OCO-garantierter Exit: genau ein Close je Position, auch bei
    // parallelen Ticks/Prozessen. applyExit liefert `closed: false`, wenn ein
    // anderer Tick/Prozess die Position bereits geschlossen hat (sauberer no-op).
    const res = await applyExit({
      broker,
      positionId: row.id,
      symbol: row.symbol,
      side,
      qty: Number(row.qty),
      entryPrice: entry,
      reason: decision.reason,
      missionId: row.missionId,
      ruleId: row.ruleId,
      createdAt: row.createdAt,
      now,
      triggerPrice: price,
      onError: (m) => errors.push(m),
    });
    if (res.closed) {
      closedThisTick.add(row.id);
      stopsTriggered.push({
        symbol: row.symbol,
        reason: decision.reason,
        pnl: res.fill?.realizedPnl ?? 0,
      });
    }
  }

  // --- 2b) Funding-Accrual (GAP-02, v1.42.0) ------------------------------
  // Perpetual-Haltekosten bei Periodenwechsel (Default: 8h-Marke UTC). Nur
  // Positionen, die diesen Tick noch offen sind (SL/TP zuerst), nur als
  // Perpetual erkannte Instrumente, Rate 0 (Default) ⇒ kein Event. Die
  // Buchung läuft über src/lib/funding.ts: Ledger → DB → audit_log, mit
  // Ledger-Rollback, falls die Persistenz scheitert (fail-closed).
  try {
    const fundingRows = openRows
      .filter((row) => !closedThisTick.has(row.id))
      .map((row) => ({
        id: row.id,
        missionId: row.missionId ?? null,
        symbol: row.symbol,
        side: row.side === "SHORT" ? ("SHORT" as const) : ("LONG" as const),
        qty: Number(row.qty),
        price: priceOf.get(row.symbol.toUpperCase()) ?? Number(row.currentPrice ?? row.entryPrice),
        isPerpetual: isPerpetualSymbol(row.symbol),
      }));
    const events = await runFundingAccrual({
      broker,
      rows: fundingRows,
      nowMs: now.getTime(),
      engine: getFundingEngine(),
    });
    for (const ev of events) {
      fundingAccruals.push({ symbol: ev.symbol, funding: ev.funding, fundingPaid: ev.fundingPaid });
    }
  } catch (e) {
    // Fail-laut: Funding bleibt aus, wenn es nicht sicher gebucht werden
    // kann — aber der Tick bricht nicht ab (SL/TP-Wachstum läuft weiter).
    errors.push(`Funding-Accrual fehlgeschlagen: ${e instanceof Error ? e.message : e}`);
  }

  // --- 3) Harte Grenzen: Auto-Circuit-Breaker (GAP-10) ---
  // Basis ist der PERSISTENTE Tages-P&L aus der DB; Drawdown und offene
  // Positionen kommen aus dem Ledger. Der Brecher prueft DREI Ausloeser
  // (Drawdown, Tagesverlust, Verlustserie) und nutzt den BESTEHENDEN
  // Kill-Switch-Pfad — Latching, kein Auto-Re-Arm.
  const equity = broker.accountEquity;
  const dayPnlNow = await realizedPnlToday();
  const dayPnlPct = broker.startingEquity > 0 ? dayPnlNow / broker.startingEquity : 0;
  let dailyLossKill = false;
  let circuitBreaker: TickResult["circuitBreaker"] = null;
  try {
    const breaker: CircuitBreakerOutcome = await checkCircuitBreaker({
      drawdownPct: broker.drawdownPct,
      maxEquityDrawdownPct: limits.maxEquityDrawdownPct,
      dailyLossPct: -dayPnlPct,
      dailyLossLimitPct: limits.dailyLossLimitPct,
      // Verlustserie + Schwelle liest der Brecher selbst (begrenzte
      // DB-Abfrage, nur wenn Ausloeser a/b nicht ohnehin greifen).
    });
    circuitBreaker = {
      engaged: breaker.engaged,
      latched: breaker.latched,
      reason: breaker.reason,
      metric: breaker.trigger?.metric ?? null,
      value: breaker.trigger?.value ?? null,
      limit: breaker.trigger?.limit ?? null,
    };
    dailyLossKill = breaker.engaged && breaker.trigger?.metric === "dailyLoss";
    for (const message of breaker.errors) errors.push(`Circuit-Breaker: ${message}`);
  } catch (e) {
    // Beobachtungsfehler darf den Tick nicht abbrechen (SL/TP laufen weiter);
    // der Fehler ist sichtbar, nicht still.
    errors.push(`Circuit-Breaker fehlgeschlagen: ${e instanceof Error ? e.message : e}`);
  }

  // Snapshot für die Equity-Kurve — bei jedem Tick.
  try {
    await writeEquitySnapshot(equity, broker.freeCash, broker.openPositions, "TICK");
  } catch (e) {
    errors.push(`Snapshot fehlgeschlagen: ${e instanceof Error ? e.message : e}`);
  }

  // --- 4) Multi-Market-Scan ins institutionelle Gedächtnis ---
  GLOBAL.__tickCount = (GLOBAL.__tickCount ?? 0) + 1;
  if (GLOBAL.__tickCount % PRUNE_EVERY_TICKS === 0) {
    try {
      const removed = await pruneEquitySnapshots(90);
      if (removed > 0) console.log(`[monitor] Retention: ${removed} alte Equity-Snapshots gelöscht`);
    } catch (e) {
      errors.push(`Retention fehlgeschlagen: ${e instanceof Error ? e.message : e}`);
    }
  }
  const doScan = (!opts.skipScan) && (forceScan || GLOBAL.__tickCount % SCAN_EVERY_TICKS === 1);
  let marketScan = false;
  if (doScan) {
    try {
      const lines: string[] = [];
      for (const s of DEFAULT_WATCHLIST) {
        try {
          const candles = await getCandles(s, isCryptoLike(s) ? "15m" : "15m", 120);
          const snap = snapshot(s, candles);
          lines.push(snap ? snapshotLine(snap) : `${s}: keine Daten`);
        } catch (e) {
          // Ein einzelnes Symbol mit Fetch-/Infrastrukturfehler darf den
          // Marktscan nicht abbrechen. Der Fehler bleibt über Telemetrie und
          // strukturiertes Log sichtbar; hier wird die Ursache explizit in
          // den Monitor-Errors übernommen (nie als „keine Daten“).
          const reason = e instanceof MarketDataFetchError ? e.reason : "UNKNOWN";
          errors.push(`Marktscan-Datenfehler ${s}: ${reason}`);
          lines.push(`${s}: Datenfehler (${reason})`);
        }
      }
      await db.insert(agentMessages).values({
        type: "MARKET_SCAN",
        content: `[MARKTSCAN ${new Date().toISOString()}]\n${lines.join("\n")}`,
        // Explizite System-Attribution statt agentId=null ohne Kontext. Der
        // Protokoll-Normalisierer kann historische Markt-Scans damit lesbar
        // von Agenten-Turns unterscheiden.
        meta: {
          actor: { name: "Marktmonitor", role: "SYSTEM" },
          source: "monitor",
          watchlist: DEFAULT_WATCHLIST,
        },
      });
      marketScan = true;
      GLOBAL.__scanCount = (GLOBAL.__scanCount ?? 0) + 1;
    } catch (e) {
      errors.push(`Marktscan fehlgeschlagen: ${e instanceof Error ? e.message : e}`);
    }
  }

  // GAP-10 (D4): Heartbeat-Quelle fuer /api/health + Watchdog.
  GLOBAL.__lastTickAt = Date.now();
  state.monitorLastTickAt.set(GLOBAL.__lastTickAt);
  return {
    at: new Date().toISOString(),
    quotesRefreshed: priceOf.size,
    stopsTriggered,
    fundingAccruals,
    dailyLossKill,
    circuitBreaker,
    marketScan,
    errors,
    adaptiveRisk,
    marketRegimes,
  };
}

/**
 * GAP-05 (v1.44.0): atomarer, OCO-garantierter Exit einer Position.
 *
 * Kritischer Pfad: zwei parallele Ticks (oder zwei Prozesse) entscheiden
 * unabhängig, dieselbe Position zu schließen. Statt Check-then-Act im Speicher
 * wird der Close durch ein **bedingtes UPDATE … WHERE status = 'OPEN'**
 * atomar beansprucht — genau EINE Transaktion bekommt eine betroffene Zeile
 * (die andere sieht die Position bereits als CLOSED und macht einen sauberen
 * no-op: kein zweiter Fill, kein zweites Audit, kein Doppel-P&L). Das ist die
 * OCO/Bracket-Exklusivität auf DB-Ebene (mehrprozess-sicher, nicht nur im
 * Prozessspeicher).
 *
 * Danach (nur der Gewinner) wird der In-Memory-Ledger glattgestellt, der
 * Exit-Preis/PnL nachgetragen und revisionssicher ins `audit_log` geschrieben
 * (maschinenlesbarer Grund `exit:SYMBOL:grund`).
 */
export async function applyExit(params: {
  broker: PaperBroker;
  positionId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  reason: ExitReason;
  missionId?: string | null;
  ruleId?: string | null;
  createdAt: Date;
  now: Date;
  triggerPrice?: number;
  /** Fehler-Sammler (z. B. Monitor-`errors`) — bei direktem Testaufruf weglassbar. */
  onError?: (msg: string) => void;
}): Promise<{ closed: boolean; fill?: Fill & { realizedPnl: number } }> {
  // 1) Atomarer Claim: nur wer die Position noch als OPEN vorfindet, darf sie
  //    schließen. RETURNING liefert genau eine Zeile bei Erfolg (andernfalls []).
  const claimed = await db
    .update(positions)
    .set({ status: "CLOSED", exitReason: params.reason, updatedAt: params.now })
    .where(and(eq(positions.id, params.positionId), eq(positions.status, "OPEN")))
    .returning({ id: positions.id });

  if (claimed.length === 0) {
    // Ein anderer Tick/Prozess war schneller → sauberer no-op (kein Doppel-Fill/Audit).
    return { closed: false };
  }

  // 2) In-Memory-Ledger glattstellen (nur der Gewinner) — liefert Fill + PnL.
  const fill = params.broker.close(params.symbol, params.reason);
  const exitPrice = fill ? fill.fillPrice : params.triggerPrice ?? params.entryPrice;
  const realizedPnl = fill ? fill.realizedPnl : 0;

  // 3) Exit-Preis/PnL nachtragen (Position ist jetzt CLOSED; nur der Gewinner schreibt).
  await db
    .update(positions)
    .set({ exitPrice: String(exitPrice), realizedPnl: String(realizedPnl) })
    .where(eq(positions.id, params.positionId));

  // 4) Revisionssicheres Audit — maschinenlesbarer Grund für JEDEN Exit.
  //    Die Anordnung der Zweige ist kein Stilfehler: Der Katalog-Wächter
  //    (tests/auditView.test.ts) erwartet das Literal-Paar TAKE_PROFIT_HIT/
  //    STOP_LOSS_HIT direkt am Aufruf — die Legacy-Events stehen deshalb
  //    zuletzt als benachbarte Zweige, die neuen (GAP-05) vorne.
  await logAudit(
    params.reason === "TRAILING_STOP" ? "TRAILING_STOP_HIT"
    : params.reason === "TIME_STOP" ? "TIME_STOP_HIT"
    : params.reason === "TAKE_PROFIT" ? "TAKE_PROFIT_HIT"
    : "STOP_LOSS_HIT",
    "INFO",
    {
      symbol: params.symbol,
      entry: params.entryPrice,
      exit: exitPrice,
      qty: params.qty,
      side: params.side,
      realizedPnl,
      triggerPrice: params.triggerPrice ?? exitPrice,
      // Maschinenlesbarer Grund (OCO-Audit): "exit:SYMBOL:grund".
      code: `exit:${params.symbol}:${params.reason}`,
    },
    params.missionId ?? undefined,
  );

  // 5) Trade-Journal + Equity-Snapshot (fehlertolerant, wie der bisherige Pfad).
  try {
    await completeJournalRow({
      positionId: params.positionId,
      symbol: params.symbol,
      side: params.side,
      openedAt: params.createdAt,
      entryPrice: params.entryPrice,
      exitPrice,
      realizedPnl,
      exitReason: params.reason,
      closedAt: params.now,
      missionId: params.missionId ?? null,
      ruleId: params.ruleId ?? null,
    });
  } catch (e) {
    params.onError?.(`Journal ${params.symbol}: ${e instanceof Error ? e.message : e}`);
  }
  try {
    await writeEquitySnapshot(
      params.broker.accountEquity,
      params.broker.freeCash,
      params.broker.openPositions,
      "CLOSE",
    );
  } catch {
    /* Kurvenpunkt optional */
  }

  return { closed: true, fill: fill ?? undefined };
}

/**
 * GAP-02: Accrual-Engine als Prozess-Singleton — der Periodenwechsel-Zustand
 * (letzte gebuchte Intervall-Marke) muss über Ticks hinweg erhalten bleiben.
 * Konfiguration wird beim ersten Zugriff gelesen (Bounds + Default, siehe
 * src/lib/funding.ts); `loadFundingConfig` klemmt mit Warnung.
 */
function getFundingEngine(): FundingAccrualEngine {
  if (!GLOBAL.__fundingEngine) {
    GLOBAL.__fundingEngine = new FundingAccrualEngine(loadFundingConfig());
  }
  return GLOBAL.__fundingEngine;
}

/**
 * GAP-02: Ist ein Symbol ein Perpetual? Quelle ist die Instrument-Registry
 * über den Produktions-Marktdaten-Manager (derselbe Auflaufpfad wie beim
 * Fill — Modus B lehnt unbekannte Instrumente ab, gefüllte Paper-Positionen
 * sind also dort registriert). Nicht eindeutig als Perpetual erkannt
 * (unbekannt, Spot, Aktie, Fehler) ⇒ KEIN Funding — nur eindeutig erkannte
 * Perpetuals erzeugen Kosten (fail-safe gegen erfundene Lasten).
 */
function isPerpetualSymbol(symbol: string): boolean {
  try {
    const manager = getProductionMarketDataManager();
    return manager.resolveInstrument(symbol)?.marketType === "perpetual";
  } catch {
    return false;
  }
}

function isCryptoLike(symbol: string): boolean {
  return /^(BTC|ETH|SOL|XRP|BNB|ADA|DOGE|AVAX|LINK|DOT)$/i.test(symbol);
}

/** Letzter Tick-Zeitpunkt fürs Dashboard/Healthcheck. */
export function lastTickAt(): string | null {
  return GLOBAL.__lastTickAt ? new Date(GLOBAL.__lastTickAt).toISOString() : null;
}

/** Einmaliger Kursabgleich für ein Symbol (z. B. vor Orderberechnung). */
export async function ensureQuote(symbol: string): Promise<number | null> {
  try {
    return (await getQuote(symbol)).price;
  } catch {
    return null;
  }
}
