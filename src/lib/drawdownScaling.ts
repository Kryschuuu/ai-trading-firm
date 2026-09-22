/**
 * LIVE-Orchestrator des hysteretischen Drawdown-Risk-Scalings (RMA-P5-04, v1.68.0).
 *
 * Verdrahtet die PURE Policy (`src/portfolio/drawdownScaling.ts`) an den
 * Produktionspfad:
 *
 *   reconciled Equity (DB-Snapshot, Fallback Paper-Ledger)
 *     + kumulierte Trading-PnL (realisiert + unrealisiert)
 *     + Reconciliation-Gate (Broker ↔ DB)
 *       → evaluateDrawdownScaling (pure, deterministisch)
 *       → Persistenz: `drawdown_scaling_snapshots` (append-only, idempotent)
 *         + `risk_config` (`dsp.activeFactor`/`dsp.activeAt`/`dsp.pause` für den
 *         Mikro-Executor, wie `adp.*`/`vtp.*`)
 *       → Anwendung: `applyDrawdownScaling` (nur im Modus `active`)
 *       → Audit-Event `RISK_DRAWDOWN_SCALING` + bounded Metriken
 *
 * ── Betriebsmodi (Feature-Flag `DRAWDOWN_SCALING_MODE`) ────────────────────
 *   - `monitor` (Default): Bewertung + Persistenz + Reporting, aber KEINE
 *     Größenänderung und kein PAUSE-Block. Der Rollout-Startzustand.
 *   - `active`: Faktor wirkt auf `maxRiskPerTrade` (multiplikativ, nur
 *     senkend) und die PAUSE-Stufe blockiert neue Einstiege.
 *   - `off`: System inaktiv, ein gesetzter Faktor wird zurückgenommen.
 *
 * Zusätzlich `dsp.enabled` in `risk_config` (Master-Schalter, Default 1).
 *
 * ── Equityquelle (autoritativ) ──────────────────────────────────────────────
 *  1. jüngster `equity_snapshots`-Eintrag (persistiert, überlebt Neustarts,
 *     wird vom Monitor/Engine bei jedem Tick bzw. Trade geschrieben);
 *  2. Fallback: Paper-Ledger im Prozess (`state.paperBrokerLedger`), wenn die
 *     DB (noch) keinen Snapshot hat (frische Installation);
 *  3. sonst: `unavailable` ⇒ fail-closed (NO_EQUITY ⇒ `minFactor`).
 *
 * Snapshot-Frequenz: der Monitor-Tick ruft diese Funktion alle 60 s auf
 * (`DRAWDOWN_SCALING_UPDATE_MIN_INTERVAL_MS`, Single-Flight). Die Frische der
 * Equity wird gegen `dsp.maxEquityStalenessMinutes` (Default 15 min) geprüft —
 * ältere Werte führen zu `STALE_EQUITY` (fail-closed).
 *
 * ── Zeitsemantik (drei getrennte Zeitachsen) ────────────────────────────────
 *   equityAvailableAt = Verfügbarkeitszeit der Equity (Snapshot-Zeit `ts`);
 *                       darf nie in der Zukunft liegen (Look-ahead-Guard).
 *   asOf              = Entscheidungszeitpunkt (Monitor-Tick).
 *   computedAt        = Berechnungszeit; immer ≥ asOf (DB-CHECK).
 *
 * ── Idempotenz & Neustart ──────────────────────────────────────────────────
 * Snapshot-Identität `dsc1:<sha256>(Minute(computedAt)|policyVersion|dataHash)`
 * mit `ON CONFLICT DO NOTHING` auf dem UNIQUE-Index `snapshot_id`: Retries und
 * Restarts in derselben Minute mit identischer Eingabe erzeugen keine zweite
 * Zeile. Der Policy-ZUSTAND (High-Water-Mark, Faktor, kumulierter Cashflow,
 * Hysterese) wird beim ersten Lauf nach einem Neustart aus der jüngsten
 * Snapshot-Zeile rekonstruiert — ein Deployment setzt den High-Water-Mark
 * NICHT zurück.
 *
 * ── Grenzen ────────────────────────────────────────────────────────────────
 * Der Faktor multipliziert NUR das konfigurierte Basis-Risikobudget
 * (`maxRiskPerTrade`) und ist hart ≤ 1. Risk-Ceilings, Kill-Switches (inkl.
 * `maxEquityDrawdownPct`/`dailyLossLimitPct`), Authority Chains und Live-Gates
 * bleiben unverändert — das Drawdown-Scaling wirkt INNERHALB der bestehenden
 * Sandbox, nie darüber. Automatischer Kapitaltransfer findet nicht statt.
 */

import { readFileSync } from "node:fs";

import { desc } from "drizzle-orm";

import { db } from "@/db";
import { drawdownScalingSnapshots, equitySnapshots, positions, riskConfig } from "@/db/schema";
import {
  buildDrawdownScalingIdempotencyKey,
  DEFAULT_DRAWDOWN_SCALING_CONFIG,
  DRAWDOWN_SCALING_BOUNDS,
  DRAWDOWN_SCALING_MODES,
  drawdownStateFromRow,
  EMPTY_DRAWDOWN_SCALING_STATE,
  evaluateDrawdownScaling,
  hashDrawdownScalingData,
  resolveDrawdownScalingConfig,
  type DrawdownCashflowInfo,
  type DrawdownScalingConfigInput,
  type DrawdownEquityObservation,
  type DrawdownReconciliationGate,
  type DrawdownScalingConfig,
  type DrawdownScalingEvaluation,
  type DrawdownScalingMode,
  type DrawdownScalingReasonCode,
  type DrawdownScalingState,
  type DrawdownScalingStatusKind,
  type DrawdownStage,
  type DrawdownTransition,
} from "@/portfolio/drawdownScaling";
import { resolveRuntimePath } from "./appPaths";
import { auditWrite } from "./auditSink";
import { structuredLog } from "./logger";
import { applyDrawdownScaling, getBaseLimits, getLimits } from "./riskGuard";
import { state } from "./stateRegistry";
import { telemetry } from "./telemetry";

// ─────────────────────────────────────────────────────────────────────────────
// Feature-Flag
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Feature-Flag des Betriebsmodus.
 *
 * `DRAWDOWN_SCALING_MODE` ∈ `off` | `monitor` | `active`.
 * Default (und bei unbekannten Werten): `monitor` — risikoneutraler
 * Rollout-Start. Nur exakt `active` wendet den Faktor an; `off` nimmt einen
 * gesetzten Faktor zurück (Rollback-Pfad).
 */
export function resolveDrawdownScalingMode(
  env: NodeJS.ProcessEnv = process.env
): DrawdownScalingMode {
  const raw = (env.DRAWDOWN_SCALING_MODE ?? "").trim().toLowerCase();
  return (DRAWDOWN_SCALING_MODES as readonly string[]).includes(raw)
    ? (raw as DrawdownScalingMode)
    : "monitor";
}

/** Mindest-Abstand zwischen zwei Neubewertungen (Monitor-Tick = 60 s). */
export const DRAWDOWN_SCALING_UPDATE_MIN_INTERVAL_MS = 60_000;

/** Reconciliation-Report-Datei (identisch zum Reconciliation-Job). */
export const DRAWDOWN_SCALING_RECON_REPORT_FILE = "data/reconciliation/last-report.json";

/** Startkapital-Default (identisch zum Paper-Ledger, `STARTING_EQUITY`). */
function readStartingEquity(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.STARTING_EQUITY);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Konfiguration (risk_config `dsp.*`, geklemmt)
// ─────────────────────────────────────────────────────────────────────────────

/** DB-Key ↔ Config-Feld (`risk_config.value` ist NUMERIC). */
const DSP_DB_KEY_BY_FIELD: Record<string, keyof DrawdownScalingConfig> = {
  "dsp.enabled": "enabled",
  "dsp.softThresholdPct": "softThresholdPct",
  "dsp.hardThresholdPct": "hardThresholdPct",
  "dsp.minFactor": "minFactor",
  "dsp.pauseThresholdPct": "pauseThresholdPct",
  "dsp.maxEquityStalenessMinutes": "maxEquityStalenessMs", // Minuten → ms
  "dsp.requireReconciliation": "requireReconciliation",
  "dsp.reconciliationMaxAgeMinutes": "reconciliationMaxAgeMs", // Minuten → ms
  "dsp.recoveryCooldownMinutes": "recoveryCooldownMs", // Minuten → ms
  "dsp.recoveryConfirmations": "recoveryConfirmations",
  "dsp.recoveryStep": "recoveryStep",
  "dsp.cashflowToleranceAbs": "cashflowToleranceAbs",
  "dsp.cashflowTolerancePct": "cashflowTolerancePct",
  "dsp.bootstrapFromBaseline": "bootstrapFromBaseline",
};

/** Felder, deren DB-Wert in Minuten geführt wird (→ ms umgerechnet). */
const DSP_MINUTE_FIELDS: ReadonlySet<keyof DrawdownScalingConfig> = new Set([
  "maxEquityStalenessMs",
  "reconciliationMaxAgeMs",
  "recoveryCooldownMs",
]);

/** Felder, deren DB-Wert 0/1 ist (→ Boolean). */
const DSP_BOOL_FIELDS: ReadonlySet<keyof DrawdownScalingConfig> = new Set([
  "enabled",
  "requireReconciliation",
  "bootstrapFromBaseline",
]);

/** Metadaten für Dashboard/Doku (analog `VTP_CONFIG_KEYS`/`VOLATILITY_KEYS`). */
export const DSP_CONFIG_KEYS: {
  key: string;
  field: keyof DrawdownScalingConfig;
  label: string;
  unit: "%" | "x" | "count" | "min" | "bool" | "idx";
  description: string;
}[] = [
  { key: "dsp.enabled", field: "enabled", label: "Drawdown-Scaling", unit: "bool", description: "Master-Schalter (0/1). Der Modus kommt aus DRAWDOWN_SCALING_MODE." },
  { key: "dsp.softThresholdPct", field: "softThresholdPct", label: "Soft-Schwelle (%)", unit: "%", description: "Drawdown, ab dem die Risikoreduktion beginnt. Standard 5 (5 %)." },
  { key: "dsp.hardThresholdPct", field: "hardThresholdPct", label: "Hard-Schwelle (%)", unit: "%", description: "Drawdown, ab dem der Bodenfaktor erreicht ist. Standard 12 (12 %)." },
  { key: "dsp.minFactor", field: "minFactor", label: "Faktor-Boden", unit: "x", description: "Untergrenze des Risikofaktors (> 0, ≤ 1). Standard 0.25." },
  { key: "dsp.pauseThresholdPct", field: "pauseThresholdPct", label: "PAUSE-Schwelle (%)", unit: "%", description: "Ab diesem Drawdown werden neue Einstiege blockiert (0 = aus). Wird auf ≥ Hard-Schwelle normalisiert." },
  { key: "dsp.maxEquityStalenessMinutes", field: "maxEquityStalenessMs", label: "Max. Equity-Alter (min)", unit: "min", description: "Ältere Equity führt zum konservativen Faktor. Standard 15." },
  { key: "dsp.requireReconciliation", field: "requireReconciliation", label: "Reconciliation-Pflicht", unit: "bool", description: "1 = ohne aktuellen, sauberen Reconciliation-Bericht gilt der konservative Faktor." },
  { key: "dsp.reconciliationMaxAgeMinutes", field: "reconciliationMaxAgeMs", label: "Max. Recon-Alter (min)", unit: "min", description: "Maximal erlaubtes Alter des letzten Reconciliation-Berichts. Standard 360." },
  { key: "dsp.recoveryCooldownMinutes", field: "recoveryCooldownMs", label: "Recovery-Cooldown (min)", unit: "min", description: "Wartezeit nach einer Degradation, bevor der Faktor steigen darf. Standard 360." },
  { key: "dsp.recoveryConfirmations", field: "recoveryConfirmations", label: "Recovery-Bestätigungen", unit: "count", description: "Anzahl bestätigter Erholungsbewertungen vor dem ersten Recovery-Schritt. Standard 3." },
  { key: "dsp.recoveryStep", field: "recoveryStep", label: "Recovery-Schritt (x)", unit: "x", description: "Maximaler Faktorzuwachs je bestätigtem Schritt. Standard 0.05." },
  { key: "dsp.cashflowToleranceAbs", field: "cashflowToleranceAbs", label: "Cashflow-Toleranz (abs)", unit: "x", description: "Absolute Toleranz der Cashflow-Erkennung in Kontowährung. Standard 0.05." },
  { key: "dsp.cashflowTolerancePct", field: "cashflowTolerancePct", label: "Cashflow-Toleranz (%)", unit: "x", description: "Relative Toleranz der Cashflow-Erkennung (Anteil der Equity). Standard 0.001." },
  { key: "dsp.bootstrapFromBaseline", field: "bootstrapFromBaseline", label: "Bootstrap ab Startkapital", unit: "bool", description: "1 = beim ersten Lauf ist der HWM ≥ Startkapital (kein Reset durch Deployment)." },
];

/**
 * Lädt die `dsp.*`-Konfiguration aus risk_config und löst sie geklemmt auf.
 * DB-Fehler → bestehende/Default-Konfiguration bleibt (Fail-Safe, wie `vtp.*`).
 */
async function loadDspConfig(
  current: DrawdownScalingConfig,
  dbRef: DdsDbLike
): Promise<DrawdownScalingConfig> {
  try {
    const rows = await dbRef.select().from(riskConfig);
    const raw: Partial<Record<keyof DrawdownScalingConfig, number | boolean>> = {};
    for (const r of rows) {
      const key = typeof r.key === "string" ? r.key : null;
      if (key === null) continue;
      const field = DSP_DB_KEY_BY_FIELD[key];
      if (!field) continue;
      const n = Number(r.value);
      if (!Number.isFinite(n)) continue;
      if (DSP_BOOL_FIELDS.has(field)) raw[field] = n >= 0.5;
      else if (DSP_MINUTE_FIELDS.has(field)) (raw[field] as number) = n * 60_000; // Minuten → ms
      else (raw[field] as number) = n;
    }
    return resolveDrawdownScalingConfig(raw, current);
  } catch {
    return current;
  }
}

/**
 * Aktuelle (geklemmte) Drawdown-Policy — RAM-Projektion der `dsp.*`-Werte.
 * Die DB ist die Wahrheit; diese Lesefunktion ist für Dashboard/API.
 */
export function currentDrawdownScalingPolicy(): DrawdownScalingConfig {
  return { ...ramState().config };
}

/**
 * Setzt Policy-Felder geklemmt (Runtime-Konfiguration/Dashboard). Es wird NUR
 * der RAM-Overlay geändert — die Persistenz macht der Aufrufer (riskConfigService)
 * über `risk_config`, damit es genau EINEN Schreibpfad gibt.
 */
export function applyDrawdownScalingPolicy(
  partial: DrawdownScalingConfigInput
): DrawdownScalingConfig {
  const s = ramState();
  s.config = resolveDrawdownScalingConfig(partial, s.config);
  return s.config;
}

// ─────────────────────────────────────────────────────────────────────────────
// Datenprovider (injizierbar für Tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimales DB-Interface des Persistenzpfads (strukturell erfüllt vom echten
 * Drizzle-Client; Test-Fakes brauchen nur diese beiden Methodenketten).
 */
export interface DdsDbLike {
  select(): { from(_t: unknown): Promise<Record<string, unknown>[]> };
  insert(_t: unknown): {
    values(v: Record<string, unknown>): {
      onConflictDoNothing(o?: unknown): { returning(f?: unknown): Promise<Record<string, unknown>[]> };
      onConflictDoUpdate(o?: unknown): Promise<unknown>;
    };
  };
}

export interface DrawdownScalingDeps {
  /** Uhr (Default: Date.now) — für Tests. */
  now?: () => number;
  /** Datenbank-Instanz für Persistenz (Default: @/db). */
  db?: DdsDbLike;
  /** Equity-Beobachtung (Default: DB-Snapshot → Paper-Ledger). */
  readEquity?: () => Promise<DrawdownEquityObservation | null>;
  /** Reconciliation-Gate (Default: RAM-Report → Report-Datei). */
  readReconciliation?: () => Promise<DrawdownReconciliationGate | null>;
  /** Persistierten Policy-Zustand laden (Default: jüngste Snapshot-Zeile). */
  readState?: () => Promise<DrawdownScalingState | null>;
}

/**
 * Kumulierte Trading-PnL (realisiert + unrealisiert) aus `positions`.
 *
 * Liefert `{ realized: null, unrealized: null }`, wenn auch nur EIN
 * benötigter Wert fehlt/unplausibel ist — `null` ist NICHT `0`: eine
 * unvollständige Attribution darf nicht als „kein PnL“ in die
 * Cashflow-Erkennung eingehen (sie wird dort als `unverified` behandelt).
 */
async function readTradingPnl(): Promise<{ realized: number | null; unrealized: number | null }> {
  try {
    const rows = await db
      .select({
        status: positions.status,
        side: positions.side,
        qty: positions.qty,
        entryPrice: positions.entryPrice,
        currentPrice: positions.currentPrice,
        realizedPnl: positions.realizedPnl,
      })
      .from(positions);
    let realized = 0;
    let unrealized = 0;
    for (const r of rows) {
      if (r.status === "CLOSED") {
        const pnl = Number(r.realizedPnl ?? 0);
        if (!Number.isFinite(pnl)) return { realized: null, unrealized: null };
        realized += pnl;
        continue;
      }
      if (r.status !== "OPEN") continue;
      const qty = Number(r.qty);
      const entry = Number(r.entryPrice);
      const current = r.currentPrice === null ? null : Number(r.currentPrice);
      if (!Number.isFinite(qty) || !Number.isFinite(entry)) return { realized: null, unrealized: null };
      // Ohne aktuellen Kurs ist die Bewertung unbekannt (nicht 0) ⇒ unattributierbar.
      if (current === null || !Number.isFinite(current)) return { realized: null, unrealized: null };
      unrealized += (r.side === "SHORT" ? entry - current : current - entry) * qty;
    }
    return { realized, unrealized };
  } catch {
    return { realized: null, unrealized: null };
  }
}

/**
 * Autoritative Equity-Beobachtung: jüngster DB-Snapshot, sonst Paper-Ledger.
 *
 * Fehler/leere Quellen ⇒ `null` (fail-closed: `NO_EQUITY` ⇒ `minFactor`), nie
 * eine stille 0.
 */
export async function readDrawdownEquityObservation(
  nowMs: number = Date.now()
): Promise<DrawdownEquityObservation | null> {
  try {
    const rows = await db
      .select({
        equity: equitySnapshots.equity,
        ts: equitySnapshots.ts,
        trigger: equitySnapshots.trigger,
      })
      .from(equitySnapshots)
      .orderBy(desc(equitySnapshots.ts))
      .limit(1);
    const row = rows[0];
    const equity = row ? Number(row.equity) : Number.NaN;
    if (row && Number.isFinite(equity) && equity > 0) {
      const ledger = state.paperBrokerLedger.get();
      return {
        equity,
        availableAt: row.ts.getTime(),
        baselineEquity: ledger?.startingEquity ?? readStartingEquity(),
        tradingPnl: await readTradingPnl(),
        source: `db-snapshot:${row.trigger}`,
      };
    }
  } catch {
    // DB nicht erreichbar ⇒ Fallback Pfad (Paper-Ledger) — sonst fail-closed.
  }

  const ledger = state.paperBrokerLedger.get();
  if (ledger) {
    return {
      equity: ledger.accountEquity,
      availableAt: nowMs,
      baselineEquity: ledger.startingEquity,
      tradingPnl: await readTradingPnl(),
      source: "paper-ledger",
    };
  }
  return null;
}

/**
 * Reconciliation-Gate: RAM-Report des laufenden Jobs, sonst die persistierte
 * Report-Datei (`data/reconciliation/last-report.json`). Beides fehlend ⇒
 * `{ at: null, clean: null }` — bei `dsp.requireReconciliation` (Default)
 * fail-closed.
 *
 * Es werden AUSSCHLIESSLICH die Zeit-Metadaten gelesen (`ts`, `clean`,
 * `paused`) — keine Broker-Payloads, keine Symbole (Security/Privacy).
 */
export async function readDrawdownReconciliationGate(): Promise<DrawdownReconciliationGate> {
  const ram = state.reconciliationLastReport.get();
  if (ram) {
    const at = Date.parse(ram.ts);
    return {
      at: Number.isFinite(at) ? at : null,
      clean: ram.clean === true,
    };
  }
  try {
    const raw = readFileSync(resolveRuntimePath(DRAWDOWN_SCALING_RECON_REPORT_FILE), "utf8");
    const parsed = JSON.parse(raw) as { ts?: unknown; clean?: unknown };
    const at = typeof parsed.ts === "string" ? Date.parse(parsed.ts) : Number.NaN;
    return {
      at: Number.isFinite(at) ? at : null,
      clean: parsed.clean === true,
    };
  } catch {
    return { at: null, clean: null };
  }
}

/** Jüngste persistierte Snapshot-Zeile als Policy-Zustand (Neustart-Rekonstruktion). */
export async function readPersistedDrawdownScalingState(): Promise<DrawdownScalingState | null> {
  try {
    const rows = await db
      .select({
        hwm: drawdownScalingSnapshots.hwm,
        appliedFactor: drawdownScalingSnapshots.appliedFactor,
        cumulativeNetFlow: drawdownScalingSnapshots.cumulativeNetFlow,
        lastEquity: drawdownScalingSnapshots.lastEquity,
        lastObservationAt: drawdownScalingSnapshots.lastObservationAt,
        lastTradingPnl: drawdownScalingSnapshots.lastTradingPnl,
        lastDegradeAt: drawdownScalingSnapshots.lastDegradeAt,
        lastTransitionAt: drawdownScalingSnapshots.lastTransitionAt,
        recoveryStreak: drawdownScalingSnapshots.recoveryStreak,
        stage: drawdownScalingSnapshots.stage,
        policyVersion: drawdownScalingSnapshots.policyVersion,
      })
      .from(drawdownScalingSnapshots)
      .orderBy(desc(drawdownScalingSnapshots.asOf), desc(drawdownScalingSnapshots.createdAt))
      .limit(1);
    const row = rows[0];
    return row ? drawdownStateFromRow(row) : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Laufzeit-Zustand (globalThis: überlebt Next.js-HMR wie der Rest der Firma)
// ─────────────────────────────────────────────────────────────────────────────

type DdsState = {
  config: DrawdownScalingConfig;
  configLoadedAt: number;
  /** Rekonstruierter Policy-Zustand (Wahrheit: DB). */
  policyState: DrawdownScalingState | null;
  lastResult: DrawdownScalingEvaluation | null;
  lastApplied: number | null;
  lastUpdateAt: number | null;
  lastError: string | null;
  updating: Promise<DrawdownScalingStatus> | null;
  lastReconciliation: DrawdownReconciliationGate | null;
};

const G = globalThis as typeof globalThis & { __drawdownScaling?: DdsState };

function ramState(): DdsState {
  G.__drawdownScaling ??= {
    config: { ...DEFAULT_DRAWDOWN_SCALING_CONFIG },
    configLoadedAt: 0,
    policyState: null,
    lastResult: null,
    lastApplied: null,
    lastUpdateAt: null,
    lastError: null,
    updating: null,
    lastReconciliation: null,
  };
  return G.__drawdownScaling;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

export interface DrawdownScalingStatus {
  /** Effektiv wirksamer Modus (Env × dsp.enabled). */
  mode: DrawdownScalingMode;
  /** true wenn Mode = active (Faktor und PAUSE wirken). */
  active: boolean;
  /** true = neue Einstiege blockiert (nur in `active` wirksam). */
  paused: boolean;
  stage: DrawdownStage;
  /** Status der letzten Bewertung (null = noch kein Lauf). */
  status: DrawdownScalingStatusKind | null;
  reasonCode: DrawdownScalingReasonCode | null;
  reason: string | null;
  /** Beobachtete Equity der letzten Bewertung (null = nicht beobachtbar). */
  equity: number | null;
  /** Cashflow-bereinigter High-Water-Mark (persistiert, neustartfest). */
  hwm: number | null;
  /** Drawdown ∈ [0,1] (null = unbekannt — nie still 0). */
  drawdownPct: number | null;
  /** Letzter angewendeter Faktor (1 = neutral). */
  appliedFactor: number;
  prevFactor: number | null;
  /** Kurvenwert vor der Hysterese (null = nicht berechenbar). */
  targetFactor: number | null;
  /** Cashflow-Attribution der letzten Bewertung. */
  cashflow: DrawdownCashflowInfo | null;
  /** Policyversion `ddp1:<sha256>` (Wechsel ⇒ neue Zeilen, keine Uminterpretation). */
  policyVersion: string | null;
  /** Letzte Transition (BOOTSTRAP | NONE | DEGRADE | RECOVER). */
  lastTransition: DrawdownTransition | null;
  /** Zeitpunkt der letzten Degradation (ISO) oder null. */
  lastDegradeAt: string | null;
  /** Letzter Lauf (ISO) oder null. */
  lastUpdate: string | null;
  /** Letzter Fehler (null = letzter Lauf OK). */
  lastError: string | null;
  /** true wenn die letzte Bewertung > 15 min zurückliegt. */
  stale: boolean;
  /** Reconciliation-Gate des letzten Laufs. */
  reconciliation: { at: string | null; clean: boolean | null } | null;
  /** Aktive Konfiguration (geklemmt). */
  config: DrawdownScalingConfig;
  /** Erlaubtes Fenster (Dashboard/Validierung). */
  bounds: typeof DRAWDOWN_SCALING_BOUNDS;
  /**
   * Wirksames Risikobudget nach der vollen Kaskade
   * (`Basis → Regime × VolTarget × Drawdown → Code-Boden`) — additiv, damit
   * jede Sizingentscheidung den angewendeten Drawdownfaktor referenzieren kann.
   */
  riskBudget: { base: number; effective: number };
}

/** Synchroner Status-Snapshot für Agenten/Monitoring/API (null = noch kein Lauf). */
export function getDrawdownScalingStatus(): DrawdownScalingStatus | null {
  const s = ramState();
  if (s.lastUpdateAt == null && s.lastResult == null) return null;
  return buildStatus(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistenz
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persistiert einen Snapshot (idempotent über `snapshot_id`).
 *
 * `insert(...).onConflictDoNothing().returning(...)` — Retry/Restart mit
 * gleichem Key ⇒ dieselbe Zeile, keine doppelte Buchung. Liefert `true` wenn
 * eine neue Zeile geschrieben wurde.
 */
async function persistSnapshot(
  dbRef: DdsDbLike,
  input: {
    mode: DrawdownScalingMode;
    result: DrawdownScalingEvaluation;
    observation: DrawdownEquityObservation;
    asOf: number;
    computedAt: number;
    config: DrawdownScalingConfig;
  }
): Promise<boolean> {
  const { result, observation } = input;
  const dataHash = hashDrawdownScalingData({
    observation,
    asOf: input.asOf,
    computedAt: input.computedAt,
  });
  const snapshotId = buildDrawdownScalingIdempotencyKey(input.computedAt, result.policyVersion, dataHash);
  const next = result.nextState;
  const nullableDate = (ms: number | null): Date | null => (ms !== null && Number.isFinite(ms) ? new Date(ms) : null);
  const nullableNum = (v: number | null): string | null => (v !== null && Number.isFinite(v) ? String(v) : null);

  const row = {
    snapshotId,
    mode: input.mode,
    status: result.status,
    reasonCode: result.reasonCode,
    reason: result.reason,
    asOf: new Date(input.asOf),
    computedAt: new Date(input.computedAt),
    equityAvailableAt: nullableDate(Number.isFinite(observation.availableAt) ? observation.availableAt : null),
    equity: nullableNum(result.equity),
    adjustedEquity: nullableNum(result.adjustedEquity),
    hwm: nullableNum(result.hwm),
    drawdownPct: nullableNum(result.drawdownPct),
    targetFactor: nullableNum(result.targetFactor),
    prevFactor: String(result.prevFactor),
    appliedFactor: String(result.appliedFactor),
    stage: result.stage,
    paused: result.paused,
    transition: result.transition,
    prevStage: result.prevStage,
    policyVersion: result.policyVersion,
    dataHash,
    cumulativeNetFlow: String(result.cashflow.cumulative),
    cashflowDetected: String(result.cashflow.detected),
    cashflowVerification: result.cashflow.verification,
    reconciliationAt: nullableDate(observation.reconciliation?.at ?? null),
    reconciliationClean: observation.reconciliation?.clean ?? null,
    reconciliationAgeMs: nullableNum(result.reconciliationAgeMs),
    equitySource: result.equitySource,
    equityAgeMs: nullableNum(result.equityAgeMs),
    lastEquity: nullableNum(next.lastEquity),
    lastObservationAt: nullableDate(next.lastObservationAt),
    lastTradingPnl: nullableNum(next.lastTradingPnl),
    lastDegradeAt: nullableDate(next.lastDegradeAt),
    lastTransitionAt: nullableDate(next.lastTransitionAt),
    recoveryStreak: next.recoveryStreak,
  };

  const inserted = await dbRef
    .insert(drawdownScalingSnapshots)
    .values(row)
    .onConflictDoNothing({ target: drawdownScalingSnapshots.snapshotId })
    .returning({ id: drawdownScalingSnapshots.id });

  return inserted.length > 0;
}

/**
 * Persistiert den aktiven Faktor + PAUSE-Flag in `risk_config`, damit der
 * SEPARATE Mikro-Executor-Prozess die Reduktion ohne eigenen Marktzugriff
 * übernehmen kann (analog `adp.activeFactor`/`vtp.activeFactor`).
 */
async function persistActiveState(
  dbRef: DdsDbLike,
  factor: number,
  atMs: number,
  paused: boolean
): Promise<void> {
  const atSec = Math.floor(atMs / 1000);
  for (const [key, value, description] of [
    ["dsp.activeFactor", factor, "Aktiver Drawdown-Risikofaktor (vom Monitor geschrieben)"],
    ["dsp.activeAt", atSec, "Epoch-Sekunden der letzten Drawdown-Scaling-Bewertung"],
    ["dsp.pause", paused ? 1 : 0, "1 = Drawdown-PAUSE aktiv (neue Einstiege blockiert)"],
  ] as const) {
    await dbRef
      .insert(riskConfig)
      .values({ key, value: String(value), description })
      .onConflictDoUpdate({
        target: riskConfig.key,
        set: { value: String(value), updatedAt: new Date() },
      });
  }
}

/**
 * Nimmt einen persistierten PAUSE-Block zurück (Modus `monitor`/`off`).
 * Ein Block darf den Zustand, der ihn erzeugt hat, nie überleben; der Faktor
 * selbst wird im Mikro-Executor zusätzlich über den Modus und das Alter
 * gegated (siehe `src/lib/microExecutor.ts`).
 */
async function withdrawPersistedPause(dbRef: DdsDbLike): Promise<void> {
  await dbRef
    .insert(riskConfig)
    .values({
      key: "dsp.pause",
      value: "0",
      description: "1 = Drawdown-PAUSE aktiv (neue Einstiege blockiert)",
    })
    .onConflictDoUpdate({ target: riskConfig.key, set: { value: "0", updatedAt: new Date() } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Update-Lauf
// ─────────────────────────────────────────────────────────────────────────────

export type UpdateDrawdownScalingOptions = {
  /** Umgeht Single-Flight und Min-Interval (API-POST, Konfigurationsänderung). */
  force?: boolean;
  /** Min-Interval-Override (Tests). */
  minIntervalMs?: number;
  /** Injizierte Dependencies (Tests). */
  deps?: DrawdownScalingDeps;
  /** Volle Konfiguration statt DB-Lade (Tests/Overrides). */
  config?: DrawdownScalingConfig;
};

/**
 * Führt einen vollständigen Bewertungsdurchlauf aus:
 * Konfiguration → Equity + Reconciliation → pure Policy → Persistenz →
 * Anwendung (nur `active`) → Audit + Metriken.
 *
 * Single-Flight (kein paralleles Re-Entry) + Min-Interval. Fehler machen den
 * Durchlauf NIE abbrechen — sie werden lokal gefangen, im Status gemeldet und
 * fail-closed behandelt (kein risikosteigerndes Verhalten).
 */
export async function updateDrawdownScaling(
  opts: UpdateDrawdownScalingOptions = {}
): Promise<DrawdownScalingStatus> {
  const s = ramState();

  if (s.updating && !opts.force) return s.updating;
  if (
    !opts.force &&
    s.lastUpdateAt != null &&
    Date.now() - s.lastUpdateAt < (opts.minIntervalMs ?? DRAWDOWN_SCALING_UPDATE_MIN_INTERVAL_MS)
  ) {
    return buildStatus(s);
  }

  const deps = opts.deps ?? {};
  const nowFn = deps.now ?? Date.now;
  const dbRef: DdsDbLike = deps.db ?? (db as unknown as DdsDbLike);

  const run = (async (): Promise<DrawdownScalingStatus> => {
    // Fehler dieses Durchlaufs werden zu Beginn geleert — der Status zeigt
    // damit NUR den letzten Lauf (kein „ewiger“ Fehler aus einem Vorlauf).
    s.lastError = null;
    const mode = resolveDrawdownScalingMode();
    const enabled = s.config.enabled;
    const effectiveMode: DrawdownScalingMode = !enabled ? "off" : mode;

    // 1) Konfiguration laden (außer explizit übergeben).
    if (opts.config) {
      s.config = resolveDrawdownScalingConfig(opts.config, s.config);
      s.configLoadedAt = nowFn();
    } else if (nowFn() - s.configLoadedAt >= 10_000) {
      s.config = await loadDspConfig(s.config, dbRef);
      s.configLoadedAt = nowFn();
    }
    const cfg = s.config;

    // 2) Modus `off`: System inaktiv, gesetzten Faktor zurücknehmen.
    if (effectiveMode === "off") {
      applyDrawdownScaling(null);
      try {
        await withdrawPersistedPause(dbRef);
      } catch {
        /* Persistenz-Fehler blockiert den Rollback nicht (RAM ist bereits zurückgenommen). */
      }
      s.lastApplied = null;
      s.lastUpdateAt = nowFn();
      telemetry.drawdownScaling.updates.inc({ result: "disabled", mode: "off" });
      return buildStatus(s);
    }

    // 3) Zustand rekonstruieren (RAM-Projektion, sonst DB = Neustart-Pfad).
    const readStateFn = deps.readState ?? readPersistedDrawdownScalingState;
    if (s.policyState === null) {
      try {
        s.policyState = (await readStateFn()) ?? { ...EMPTY_DRAWDOWN_SCALING_STATE };
      } catch (e) {
        // Ohne rekonstruierbaren Zustand bootet die Policy neu — der HWM wird
        // dabei NICHT geraten; der Bootstrap ist dokumentiert (kein Reset durch
        // Deployment, weil die DB-Zeile gelesen wird, sobald sie existiert).
        s.lastError = `Zustands-Rekonstruktion fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`;
        s.policyState = { ...EMPTY_DRAWDOWN_SCALING_STATE };
      }
    }

    // 4) Beobachtung: Equity + Reconciliation-Gate (fail-closed bei Fehlern).
    const nowMs = nowFn();
    const readEquityFn = deps.readEquity ?? (() => readDrawdownEquityObservation(nowMs));
    let observation: DrawdownEquityObservation | null = null;
    try {
      observation = await readEquityFn();
    } catch (e) {
      s.lastError = `Equity-Lese fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`;
    }
    const readReconFn = deps.readReconciliation ?? readDrawdownReconciliationGate;
    let reconciliation: DrawdownReconciliationGate | null = null;
    try {
      reconciliation = await readReconFn();
    } catch {
      reconciliation = { at: null, clean: null };
    }
    s.lastReconciliation = reconciliation;

    const effectiveObservation: DrawdownEquityObservation = observation
      ? { ...observation, reconciliation }
      : {
          // Nicht beobachtbar: NaN ist hier der explizite "unavailable"-Marker
          // (fail-closed ⇒ NO_EQUITY ⇒ minFactor), NICHT eine stille 0-Equity.
          equity: Number.NaN,
          availableAt: Number.NaN,
          baselineEquity: null,
          tradingPnl: null,
          source: null,
          reconciliation,
        };

    // 5) Pure Policy (gemeinsam mit Tests/Replay, ohne I/O).
    const result = evaluateDrawdownScaling({
      observation: effectiveObservation,
      state: s.policyState,
      asOf: nowMs,
      computedAt: nowMs,
      config: cfg,
    });

    // 6) Persistenz (Snapshot immer; Aktivfaktor nur im `active`-Modus).
    let snapshotWritten = false;
    try {
      snapshotWritten = await persistSnapshot(dbRef, {
        mode: effectiveMode,
        result,
        observation: effectiveObservation,
        asOf: nowMs,
        computedAt: nowMs,
        config: cfg,
      });
      telemetry.drawdownScaling.snapshots.inc({ result: snapshotWritten ? "written" : "duplicate" });
      if (effectiveMode === "active") {
        await persistActiveState(dbRef, result.appliedFactor, nowMs, result.paused);
      } else {
        await withdrawPersistedPause(dbRef);
      }
    } catch (e) {
      s.lastError = `Persistenz fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`;
      telemetry.drawdownScaling.snapshots.inc({ result: "failed" });
      // Persistenz-Fehler bricht den Lauf nicht ab (Fail-Safe): die RAM-Projektion
      // bleibt konsistent, der nächste Tick schreibt erneut.
    }

    // 7) Anwendung (nur im `active`-Modus).
    if (effectiveMode === "active") {
      applyDrawdownScaling({
        factor: result.appliedFactor,
        stage: result.stage,
        paused: result.paused,
        drawdownPct: result.drawdownPct,
        hwm: result.hwm,
        policyVersion: result.policyVersion,
        at: new Date(nowMs).toISOString(),
        asOf: new Date(nowMs).toISOString(),
        reason: result.reason,
        mode: "active",
      });
    } else {
      applyDrawdownScaling(null);
    }

    // 8) Zustand aktualisieren (Persistenz-Projektion → RAM).
    s.policyState = result.nextState;
    s.lastResult = result;
    s.lastApplied = result.appliedFactor;
    s.lastUpdateAt = nowMs;
    // Konservativ gilt auch dann als Fehler, wenn (noch) kein spezifischer
    // Laufzeitfehler vorliegt; spezifische Fehler (Persistenz, Provider)
    // bleiben erhalten, damit die Diagnose nicht verloren geht.
    if (result.status === "CONSERVATIVE") s.lastError = s.lastError ?? result.reason;

    // 9) Metriken + Audit.
    telemetry.drawdownScaling.updates.inc({
      result: result.status.toLowerCase(),
      mode: effectiveMode,
    });
    telemetry.drawdownScaling.transitions.inc({
      transition: result.transition.toLowerCase(),
      stage: result.stage.toLowerCase(),
    });
    if (result.status === "CONSERVATIVE") {
      telemetry.drawdownScaling.conservative.inc({
        reason: result.reasonCode.toLowerCase(),
      });
    }
    await logDdsEvent(effectiveMode, result, nowMs);

    return buildStatus(s);
  })();

  s.updating = run;
  try {
    return await run;
  } finally {
    s.updating = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Audit-Event je Bewertung. Jede Faktor-/Stufenänderung trägt Equity-Snapshot,
 * HWM, Drawdown, alte/neue Stufe und den Grund — nachvollziehbar ohne
 * Rekonstruktion. Keine Secrets, keine Broker-Payloads; `equitySource` ist eine
 * Code-Konstante (kein Symbol, kein Konto).
 */
async function logDdsEvent(
  mode: DrawdownScalingMode,
  result: DrawdownScalingEvaluation,
  computedAt: number
): Promise<void> {
  const alarm = result.status === "CONSERVATIVE" || result.transition === "DEGRADE";
  const detail = {
    mode,
    status: result.status,
    reasonCode: result.reasonCode,
    reason: result.reason,
    stage: result.stage,
    prevStage: result.prevStage,
    transition: result.transition,
    paused: result.paused,
    equity: result.equity,
    adjustedEquity: result.adjustedEquity,
    hwm: result.hwm,
    drawdownPct: result.drawdownPct,
    targetFactor: result.targetFactor,
    prevFactor: result.prevFactor,
    appliedFactor: result.appliedFactor,
    factorDelta: result.factorDelta,
    equitySource: result.equitySource,
    equityAgeMs: result.equityAgeMs,
    reconciliationAgeMs: result.reconciliationAgeMs,
    cashflowDetected: result.cashflow.detected,
    cumulativeNetFlow: result.cashflow.cumulative,
    cashflowVerification: result.cashflow.verification,
    recoveryStreak: result.recoveryStreak,
    policyVersion: result.policyVersion,
    computedAt: new Date(computedAt).toISOString(),
  };
  try {
    await auditWrite("RISK_DRAWDOWN_SCALING", alarm ? "WARN" : "INFO", detail, {
      auditClass: alarm ? "security" : "telemetry",
    });
  } catch (e) {
    // Audit-Fehler brechen den Lauf nicht ab (best-effort, gezählt in
    // audit_write_failures_total) — aber nie still: strukturiertes Log.
    structuredLog("warn", "drawdown_scaling_audit_failed", {
      reason: e instanceof Error ? e.message : String(e),
      status: result.status,
      reasonCode: result.reasonCode,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status-Aufbau
// ─────────────────────────────────────────────────────────────────────────────

function buildStatus(s: DdsState): DrawdownScalingStatus {
  const mode = resolveDrawdownScalingMode();
  const enabled = s.config.enabled;
  const effectiveMode: DrawdownScalingMode = !enabled ? "off" : mode;
  const r = s.lastResult;
  const policyState = s.policyState;
  const limits = getLimits();
  const base = getBaseLimits();
  const factor = r?.appliedFactor ?? s.lastApplied ?? 1;
  return {
    mode: effectiveMode,
    active: effectiveMode === "active",
    paused: effectiveMode === "active" ? (r?.paused ?? false) : false,
    stage: r?.stage ?? policyState?.stage ?? "NORMAL",
    status: r?.status ?? null,
    reasonCode: r?.reasonCode ?? null,
    reason: r?.reason ?? null,
    equity: r?.equity ?? policyState?.lastEquity ?? null,
    hwm: r?.hwm ?? policyState?.hwm ?? null,
    drawdownPct: r?.drawdownPct ?? null,
    appliedFactor: factor,
    prevFactor: r?.prevFactor ?? null,
    targetFactor: r?.targetFactor ?? null,
    cashflow: r?.cashflow ?? null,
    policyVersion: r?.policyVersion ?? policyState?.policyVersion ?? null,
    lastTransition: r?.transition ?? null,
    lastDegradeAt: policyState?.lastDegradeAt != null ? new Date(policyState.lastDegradeAt).toISOString() : null,
    lastUpdate: s.lastUpdateAt ? new Date(s.lastUpdateAt).toISOString() : null,
    lastError: s.lastError,
    stale: s.lastUpdateAt == null || Date.now() - s.lastUpdateAt > 15 * 60_000,
    reconciliation: s.lastReconciliation
      ? {
          at: s.lastReconciliation.at !== null ? new Date(s.lastReconciliation.at).toISOString() : null,
          clean: s.lastReconciliation.clean,
        }
      : null,
    config: { ...s.config },
    bounds: { ...DRAWDOWN_SCALING_BOUNDS },
    riskBudget: { base: base.maxRiskPerTrade, effective: limits.maxRiskPerTrade },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test-Helfer
// ─────────────────────────────────────────────────────────────────────────────

/** Leert den kompletten Laufzeit-Zustand (nur für Tests). */
export function __resetDrawdownScalingForTests(): void {
  delete G.__drawdownScaling;
}
