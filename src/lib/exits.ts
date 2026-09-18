/**
 * Server-seitiges Exit-Management (GAP-05): Trailing-Stop, Time-Stop und die
 * OCO/Bracket-Exklusivität.
 *
 * Diese Datei ist bewusst **frei von Seiteneffekten** (keine DB, kein
 * Marktdaten-Zugriff, kein Broker): Sie enthält
 *
 *   1. die Konfiguration (env-basiert, Bounds-Clamp, sichere Defaults) und
 *   2. die rein deterministische Exit-Entscheidungslogik (`decideExit`),
 *
 * damit beides gezielt und ohne Infrastruktur testbar ist.
 *
 * Die **atomare Ausführung** (Conditional-UPDATE … WHERE status = 'OPEN' als
 * OCO-Guarantee) und das revisionssichere Audit leben im Monitor
 * (`src/lib/monitor.ts`), weil sie den Broker-Ledger, das Trade-Journal und das
 * Equity-Snapshot koordinieren müssen.
 *
 * Grundregeln aus dem Prompt: Paper-only, fail-closed, keine neuen
 * Runtime-Dependencies, Schwellen mit Bounds + sicherem Default (= heutiges
 * Verhalten, wenn alle Flags „aus“).
 */

/** Maschinenlesbare Exit-Gründe (Taxonomie, ergänzt in `src/db/schema.ts`). */
export type ExitReason =
  | "STOP_LOSS"
  | "TAKE_PROFIT"
  | "TRAILING_STOP"
  | "TIME_STOP";

/** Exit-Konfiguration — alle Schwellen mit sicherem Default. */
export type ExitConfig = {
  /** Trailing-Stop aktiv? Default `false` → kein Verhaltensbruch. */
  trailingEnabled: boolean;
  /** Gewinn in % ab dem der Trailing-Stop bewaffnet wird. Bounds [0.1, 20]. */
  trailingActivationPct: number;
  /** Rückgabeweg (Retracement) in % vom Kurs, den der Trailing-Stop hält. Bounds [0.1, 10]. */
  trailingReturnPct: number;
  /** Max. Haltedauer in Stunden; `0` = aus. Bounds [0, 24*30]. */
  timeStopHours: number;
};

/** Verhaltensneutrale Defaults: alles „aus“, nur SL/TP wie bisher. */
export const DEFAULT_EXIT_CONFIG: ExitConfig = {
  trailingEnabled: false,
  trailingActivationPct: 1.0,
  trailingReturnPct: 0.5,
  timeStopHours: 0,
};

/** Harte Bounds (untere/obere Schranke) je Schwellenwert. */
export const EXIT_CONFIG_BOUNDS = {
  trailingActivationPct: [0.1, 20] as const,
  trailingReturnPct: [0.1, 10] as const,
  timeStopHours: [0, 24 * 30] as const,
};

const HOUR_MS = 3_600_000;

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min; // ungültig → untere Schranke (sicher)
  return Math.min(Math.max(value, min), max);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  switch (String(value).trim().toLowerCase()) {
    case "true":
    case "1":
    case "yes":
    case "on":
      return true;
    case "false":
    case "0":
    case "no":
    case "off":
      return false;
    default:
      return fallback;
  }
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Lädt die Exit-Konfiguration aus der Umgebung, klemmt auf die Bounds und
 * wendet sichere Defaults an. Jeder Wert ist per Default so gesetzt, dass sich
 * das **heutige Verhalten nicht ändert** (Trailing/Time-Stop aus, nur SL/TP).
 *
 * `overrides` (z. B. aus Tests) überschreibt die env-Werte und wird ebenfalls
 * auf die Bounds geklemmt — so bleiben die Invarianten auch unter Tests garantiert.
 */
export function loadExitConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  overrides: Partial<ExitConfig> = {},
): ExitConfig {
  const merged: ExitConfig = {
    trailingEnabled: parseBoolean(env.RISK_TRAILING_ENABLED, DEFAULT_EXIT_CONFIG.trailingEnabled),
    trailingActivationPct: parseNumber(
      env.RISK_TRAILING_ACTIVATION_PCT,
      DEFAULT_EXIT_CONFIG.trailingActivationPct,
    ),
    trailingReturnPct: parseNumber(env.RISK_TRAILING_RETURN_PCT, DEFAULT_EXIT_CONFIG.trailingReturnPct),
    timeStopHours: parseNumber(env.RISK_TIME_STOP_HOURS, DEFAULT_EXIT_CONFIG.timeStopHours),
    ...overrides,
  };
  // Invarianten wahren: am Ende immer auf die Bounds klemmen.
  return {
    trailingEnabled: merged.trailingEnabled,
    trailingActivationPct: clampNumber(
      merged.trailingActivationPct,
      EXIT_CONFIG_BOUNDS.trailingActivationPct[0],
      EXIT_CONFIG_BOUNDS.trailingActivationPct[1],
    ),
    trailingReturnPct: clampNumber(
      merged.trailingReturnPct,
      EXIT_CONFIG_BOUNDS.trailingReturnPct[0],
      EXIT_CONFIG_BOUNDS.trailingReturnPct[1],
    ),
    timeStopHours: clampNumber(
      merged.timeStopHours,
      EXIT_CONFIG_BOUNDS.timeStopHours[0],
      EXIT_CONFIG_BOUNDS.timeStopHours[1],
    ),
  };
}

/** Normalisierte Eingabe für die Exit-Entscheidung (alle Werte serverseitig). */
export type ExitDecisionInput = {
  side: "LONG" | "SHORT";
  entryPrice: number;
  /** Aktueller Kurs (vom Monitor/Quote geliefert). */
  price: number;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Bisheriger Trailing-Stop (DB-Zustand) oder `null`. */
  trailingStop: number | null;
  /** Ist der Trailing-Stop bereits bewaffnet (DB-Zustand)? */
  trailingArmed: boolean;
  /** Eröffnungszeitpunkt der Position in ms. */
  createdAtMs: number;
  /** Aktueller Zeitstempel in ms (für die Haltedauer-Prüfung). */
  nowMs: number;
};

/** Ergebnis der Exit-Entscheidung — inkl. zu persistierendem Trailing-Zustand. */
export type ExitDecision = {
  /** Grund für den Exit, oder `null` wenn keine Bedingung greift. */
  reason: ExitReason | null;
  /** Neuer Bewaffnet-Status (für DB-Persistenz). */
  trailingArmed: boolean;
  /** Neuer Trailing-Stop-Level (für DB-Persistenz) oder `null`. */
  trailingStop: number | null;
  /** Hat sich der Trailing-Zustand gegenüber der Eingabe geändert (Persistenz nötig)? */
  trailingChanged: boolean;
  /** SL und TP wurden im selben Tick gleichzeitig berührt (SL hat Vorrang). */
  bothHit: boolean;
};

/**
 * Rein deterministische Exit-Entscheidung für EINE Position.
 *
 * Logik (LONG; SHORT gespiegelt):
 *   - SL/TP wie bisher (komplementär). Bei gleichzeitigem SL+TP gilt SL zuerst.
 *   - Trailing-Stop (nur wenn `config.trailingEnabled`):
 *       * Gewinn ≥ Activation% → bewaffnet; Stop = Kurs − Rückgabeweg.
 *       * Bewaffnet: Stop = Kurs − Rückgabeweg; **Ratchet** = Stop steigt nur,
 *         nie sinkt er (SHORT gespiegelt: Stop fällt nur, nie steigt).
 *       * Kurs ≤ Stop (LONG) bzw. ≥ Stop (SHORT) → Auslösung (TRAILING_STOP).
 *   - Time-Stop (nur wenn `config.timeStopHours > 0`): Haltedauer ≥ Limit → TIME_STOP.
 *
 * Priorität der Auslöser: SL → TP → Trailing → Time-Stop (preisbasiert vor
 * Zeit). Es wird **höchstens ein** Grund geliefert — das ist die OCO-
 * Semantik auf Entscheidungsebene; die echte Atomarität (zwei parallele Ticks)
 * liegt im Conditional-UPDATE des Monitors.
 */
export function decideExit(input: ExitDecisionInput, config: ExitConfig): ExitDecision {
  const {
    side,
    entryPrice,
    price,
    stopLoss,
    takeProfit,
    trailingStop,
    trailingArmed,
    createdAtMs,
    nowMs,
  } = input;
  const long = side === "LONG";

  const slHit =
    stopLoss != null && ((long && price <= stopLoss) || (!long && price >= stopLoss));
  const tpHit =
    takeProfit != null && ((long && price >= takeProfit) || (!long && price <= takeProfit));

  let armed = trailingArmed;
  let stop: number | null = trailingStop;
  let trailingHit = false;

  const priceValid = Number.isFinite(price) && price > 0;
  const entryValid = Number.isFinite(entryPrice) && entryPrice > 0;
  if (config.trailingEnabled && priceValid && entryValid) {
    const profitPct = (((price - entryPrice) / entryPrice) * 100) * (long ? 1 : -1);
    if (!armed && profitPct >= config.trailingActivationPct) {
      // Bewaffnung in diesem Tick — Stop wird erstmals gesetzt (unter dem Kurs).
      armed = true;
      stop = long
        ? price * (1 - config.trailingReturnPct / 100)
        : price * (1 + config.trailingReturnPct / 100);
    } else if (armed) {
      // Ratchet: Stop nur erweitern (LONG: nach oben, SHORT: nach unten).
      const newStop = long
        ? price * (1 - config.trailingReturnPct / 100)
        : price * (1 + config.trailingReturnPct / 100);
      if (stop == null || (long ? newStop > stop : newStop < stop)) {
        stop = newStop;
      }
      trailingHit = long ? price <= (stop as number) : price >= (stop as number);
    }
  }

  const ageHours = (nowMs - createdAtMs) / HOUR_MS;
  const timeStopHit = config.timeStopHours > 0 && ageHours >= config.timeStopHours;

  let reason: ExitReason | null = null;
  if (slHit) reason = "STOP_LOSS";
  else if (tpHit) reason = "TAKE_PROFIT";
  else if (trailingHit) reason = "TRAILING_STOP";
  else if (timeStopHit) reason = "TIME_STOP";

  const trailingChanged =
    armed !== trailingArmed || (stop ?? null) !== (trailingStop ?? null);

  return {
    reason,
    trailingArmed: armed,
    trailingStop: stop ?? null,
    trailingChanged,
    bothHit: slHit && tpHit,
  };
}
