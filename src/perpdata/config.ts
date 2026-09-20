/**
 * Konfiguration und Feature-Gates der Perpetual-Daten (RMA-P2-02, v1.54.0).
 *
 * ── Fail-closed-Defaults ───────────────────────────────────────────────────
 * Beide Schalter stehen **aus**. Das ist kein Zögern, sondern die Regel:
 *
 *   * `PERP_DATA_ENABLED=false` — Konsumenten (Scanner-Kontext, Funding-Replay,
 *     Analystensnapshot) verhalten sich exakt wie vor v1.54.0. Bestehende
 *     Paper-/Backtest-Results bleiben damit bitstabil, bis der Betrieb die
 *     Quelle ausdrücklich freigibt (Baseline-Regel 9).
 *   * `PERP_DATA_SYNC_ENABLED=false` — ohne Freigabe geht **kein** einziger
 *     Netzwerk-Request ab. Zusätzlich gilt pro Venue das bestehende
 *     `<VENUE>_ENABLED`-Gate (Bitunix: `BITUNIX_ENABLED=true`).
 *
 * Der Lese-/API-Pfad ist davon unabhängig immer betretbar: ohne Daten liefert
 * er `MISSING`/`UNAVAILABLE` mit Grund, nie erfundene Werte.
 *
 * ── Flag-Übersicht ───────────────────────────────────────────────────────────
 * | Flag                                   | Default      | Wirkung                        |
 * | -------------------------------------- | ------------ | ------------------------------ |
 * | `PERP_DATA_ENABLED`                    | `false`      | Konsumenten an/a              |
 * | `PERP_DATA_SYNC_ENABLED`               | `false`      | Netz-Ingestion an/a           |
 * | `PERP_DATA_VENUES`                     | alle         | Venue-Allowlist des Sync       |
 * | `PERP_DATA_AVAILABILITY`               | `ingested`   | `availableAt`-Politik          |
 * | `PERP_DATA_QUALITY_MODE`               | `log`        | `log`/`strict` (fail-closed)   |
 * | `PERP_DATA_BACKFILL_DAYS`              | `30`         | Erstbefüllung je Reihe         |
 * | `PERP_DATA_FUNDING_INTERVAL_HOURS`     | `8`          | erwartetes Funding-Raster      |
 * | `PERP_DATA_OI_INTERVAL_MINUTES`        | `60`         | erwartetes OI-Raster           |
 * | `PERP_DATA_MAX_STALE_FUNDING_HOURS`    | `24`         | Staleness Funding              |
 * | `PERP_DATA_MAX_STALE_OI_HOURS`         | `4`          | Staleness Open Interest        |
 * | `PERP_DATA_MAX_ABS_FUNDING_RATE`       | `0.0075`     | Outlier-Bound je Intervall     |
 * | `PERP_DATA_MAX_OI_CHANGE`              | `0.5`        | Outlier-Bound relative Änderung|
 * | `PERP_DATA_CONCURRENCY`                | `4`          | parallele Reihen (hart ≤ 8)   |
 * | `PERP_DATA_SAFETY_LAG_MS`              | `60000`      | Fenster-Nachlauf (settlement)  |
 *
 * Referenz: `CONFIGURATION.md` (Flag-Tabelle), `docs/PERPETUAL_DATA.md`
 * (Vertrag von Schema, Sync, Qualität und Konsumenten).
 */
import { envInt, envNumber } from "../lib/env";
import type {
  PerpAvailabilityPolicy,
  PerpSeriesKind,
} from "./types";
import { PERP_AVAILABILITY_POLICIES } from "./types";

/** Env-artige Map (injizierbar für Tests — mutiert nie `process.env`). */
export type PerpEnvLike = Record<string, string | undefined>;

/** Env-Namen (zentral, für Doku/Tests). */
export const PERP_ENV = {
  ENABLED: "PERP_DATA_ENABLED",
  SYNC_ENABLED: "PERP_DATA_SYNC_ENABLED",
  VENUES: "PERP_DATA_VENUES",
  AVAILABILITY: "PERP_DATA_AVAILABILITY",
  QUALITY_MODE: "PERP_DATA_QUALITY_MODE",
  BACKFILL_DAYS: "PERP_DATA_BACKFILL_DAYS",
  FUNDING_INTERVAL_HOURS: "PERP_DATA_FUNDING_INTERVAL_HOURS",
  OI_INTERVAL_MINUTES: "PERP_DATA_OI_INTERVAL_MINUTES",
  MAX_STALE_FUNDING_HOURS: "PERP_DATA_MAX_STALE_FUNDING_HOURS",
  MAX_STALE_OI_HOURS: "PERP_DATA_MAX_STALE_OI_HOURS",
  MAX_ABS_FUNDING_RATE: "PERP_DATA_MAX_ABS_FUNDING_RATE",
  MAX_OI_CHANGE: "PERP_DATA_MAX_OI_CHANGE",
  CONCURRENCY: "PERP_DATA_CONCURRENCY",
  SAFETY_LAG_MS: "PERP_DATA_SAFETY_LAG_MS",
  CROSSCHECK_VENUE: "PERP_DATA_CROSSCHECK_VENUE",
} as const;

/** Harte Bounds der konfigurierbaren Werte (Clamp + Warnung). */
export const PERP_BOUNDS = {
  backfillDays: { min: 1, max: 400 },
  fundingIntervalHours: { min: 1, max: 24 },
  oiIntervalMinutes: { min: 1, max: 1440 },
  maxStaleFundingHours: { min: 1, max: 168 },
  maxStaleOiHours: { min: 1, max: 72 },
  /**
   * 0.75 % je Intervall ist bereits extrem (real typisch 0,001–0,1 %/8h);
   * die obere Grenze 0.3 entspricht der von Bitunix dokumentierten
   * `maxFundingRate` (30 % ist dort der Kappe des Venues, nicht der Realität).
   */
  maxAbsFundingRate: { min: 0.0001, max: 0.3 },
  maxOiChange: { min: 0.01, max: 5 },
  concurrency: { min: 1, max: 8 },
  safetyLagMs: { min: 0, max: 6 * 3_600_000 },
} as const;

/** Sichere Defaults (ohne Netz, ohne Risikoerhöhung). */
export const PERP_DEFAULTS = {
  backfillDays: 30,
  fundingIntervalHours: 8,
  oiIntervalMinutes: 60,
  maxStaleFundingHours: 24,
  maxStaleOiHours: 4,
  maxAbsFundingRate: 0.0075,
  maxOiChange: 0.5,
  concurrency: 4,
  safetyLagMs: 60_000,
  availability: "ingested" as PerpAvailabilityPolicy,
  qualityMode: "log" as PerpQualityMode,
} as const;

/** Qualitätsmodus des Perp-Layers (wie `MARKETDATA_QUALITY_MODE`). */
export type PerpQualityMode = "log" | "strict";
export const PERP_QUALITY_MODES: readonly PerpQualityMode[] = ["log", "strict"] as const;

/** Vollständige, validierte Konfiguration. */
export interface PerpConfig {
  /** Master-Schalter der Konsumenten (`PERP_DATA_ENABLED`, Default `false`). */
  enabled: boolean;
  /** Netz-Ingestion (`PERP_DATA_SYNC_ENABLED`, Default `false`). */
  syncEnabled: boolean;
  /** Venue-Allowlist (`null` = alle bekannten Venues). */
  venues: readonly string[] | null;
  availabilityPolicy: PerpAvailabilityPolicy;
  qualityMode: PerpQualityMode;
  backfillDays: number;
  fundingIntervalHours: number;
  oiIntervalMinutes: number;
  /** Staleness-Grenzen je Art; Liquidationen sind **kein** Staleness-Kriterium. */
  maxStaleMs: Record<PerpSeriesKind, number>;
  maxAbsFundingRate: number;
  maxOiChange: number;
  concurrency: number;
  /** Nachlauf des Zeitfensters: ein Settlement, das noch nicht abgeschlossen
   *  sein kann, wird nicht angefragt (kein halbvollständiger Satz). */
  safetyLagMs: number;
  /** Optionale Zweitvenue für den Cross-Check (Default: aus). */
  crosscheckVenue: string | null;
}

/** `PERP_DATA_ENABLED === "true"` — nur der exakte Wert schaltet an. */
export function perpDataEnabled(env: PerpEnvLike = process.env): boolean {
  return env[PERP_ENV.ENABLED] === "true";
}

/** `PERP_DATA_SYNC_ENABLED === "true"` — nur der exakte Wert schaltet an. */
export function perpDataSyncEnabled(env: PerpEnvLike = process.env): boolean {
  return env[PERP_ENV.SYNC_ENABLED] === "true";
}

/** Venue-Allowlist aus `PERP_DATA_VENUES` (Großbuchstaben, dedupliziert). */
export function perpDataVenueAllowlist(env: PerpEnvLike = process.env): string[] | null {
  const raw = (env[PERP_ENV.VENUES] ?? "").trim();
  if (!raw) return null;
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const venue = part.trim().toUpperCase();
    if (!venue || !/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(venue) || out.includes(venue)) continue;
    out.push(venue);
  }
  return out.length > 0 ? out : null;
}

function pickEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  name: string
): T {
  const value = (raw ?? "").trim().toUpperCase();
  if (value === "") return fallback;
  const hit = allowed.find((entry) => entry.toUpperCase() === value);
  if (!hit) {
    console.warn(
      `[perpdata] ${name}="${(raw ?? "").slice(0, 24)}" ist ungültig → sicherer Default "${fallback}".`
    );
    return fallback;
  }
  return hit;
}

/**
 * Lädt die Konfiguration (rein, deterministisch, bounds-geklemmt).
 *
 * Ungültige Einzelwerte werden **laut** auf den sicheren Default gesetzt
 * (`envNumber` warnt bei Clamp/Ersetzung) — ein still ignorierter Flag wäre
 * Betriebsblindsinn.
 */
export function loadPerpConfig(env: PerpEnvLike = process.env): PerpConfig {
  const fundingIntervalHours = envInt(
    PERP_ENV.FUNDING_INTERVAL_HOURS,
    PERP_DEFAULTS.fundingIntervalHours,
    PERP_BOUNDS.fundingIntervalHours.min,
    PERP_BOUNDS.fundingIntervalHours.max,
    env
  );
  const oiIntervalMs =
    envInt(
      PERP_ENV.OI_INTERVAL_MINUTES,
      PERP_DEFAULTS.oiIntervalMinutes,
      PERP_BOUNDS.oiIntervalMinutes.min,
      PERP_BOUNDS.oiIntervalMinutes.max,
      env
    ) * 60_000;
  const crosscheckRaw = (env[PERP_ENV.CROSSCHECK_VENUE] ?? "").trim().toUpperCase();
  return {
    enabled: perpDataEnabled(env),
    syncEnabled: perpDataSyncEnabled(env),
    venues: perpDataVenueAllowlist(env),
    availabilityPolicy: pickEnum(
      env[PERP_ENV.AVAILABILITY],
      PERP_AVAILABILITY_POLICIES,
      PERP_DEFAULTS.availability,
      PERP_ENV.AVAILABILITY
    ),
    qualityMode: pickEnum(
      env[PERP_ENV.QUALITY_MODE],
      PERP_QUALITY_MODES,
      PERP_DEFAULTS.qualityMode,
      PERP_ENV.QUALITY_MODE
    ),
    backfillDays: envInt(
      PERP_ENV.BACKFILL_DAYS,
      PERP_DEFAULTS.backfillDays,
      PERP_BOUNDS.backfillDays.min,
      PERP_BOUNDS.backfillDays.max,
      env
    ),
    fundingIntervalHours,
    oiIntervalMinutes: Math.round(oiIntervalMs / 60_000),
    maxStaleMs: {
      funding:
        envInt(
          PERP_ENV.MAX_STALE_FUNDING_HOURS,
          PERP_DEFAULTS.maxStaleFundingHours,
          PERP_BOUNDS.maxStaleFundingHours.min,
          PERP_BOUNDS.maxStaleFundingHours.max,
          env
        ) * 3_600_000,
      openInterest:
        envInt(
          PERP_ENV.MAX_STALE_OI_HOURS,
          PERP_DEFAULTS.maxStaleOiHours,
          PERP_BOUNDS.maxStaleOiHours.min,
          PERP_BOUNDS.maxStaleOiHours.max,
          env
        ) * 3_600_000,
      // Liquidationen sind ein Ereignisstrom: „keine Liquidation“ ist ein
      // legitimer, häufiger Normalzustand und kein Datenalter. Deshalb hier
      // `Number.POSITIVE_INFINITY` und **nicht** 0 — die As-of-Prüfung nutzt
      // denselben Code-Pfad für alle drei Arten und darf bei Liquidationen
      // nie `STALE` melden (sonst würde ein ruhiger Markt „unavailable“).
      liquidations: Number.POSITIVE_INFINITY,
    },
    maxAbsFundingRate: envNumber(
      PERP_ENV.MAX_ABS_FUNDING_RATE,
      PERP_DEFAULTS.maxAbsFundingRate,
      PERP_BOUNDS.maxAbsFundingRate.min,
      PERP_BOUNDS.maxAbsFundingRate.max,
      env
    ),
    maxOiChange: envNumber(
      PERP_ENV.MAX_OI_CHANGE,
      PERP_DEFAULTS.maxOiChange,
      PERP_BOUNDS.maxOiChange.min,
      PERP_BOUNDS.maxOiChange.max,
      env
    ),
    concurrency: envInt(
      PERP_ENV.CONCURRENCY,
      PERP_DEFAULTS.concurrency,
      PERP_BOUNDS.concurrency.min,
      PERP_BOUNDS.concurrency.max,
      env
    ),
    safetyLagMs: envInt(
      PERP_ENV.SAFETY_LAG_MS,
      PERP_DEFAULTS.safetyLagMs,
      PERP_BOUNDS.safetyLagMs.min,
      PERP_BOUNDS.safetyLagMs.max,
      env
    ),
    crosscheckVenue:
      crosscheckRaw && /^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(crosscheckRaw) ? crosscheckRaw : null,
  };
}

/** Hilfsmaß: Stunden → Millisekunden (ganzzahlig, für Zeitfenster). */
export function hoursToMs(hours: number): number {
  return Math.round(hours * 3_600_000);
}

/** Tage → Millisekunden (UTC-Tagschritte für Backfill-Fenster). */
export function daysToMs(days: number): number {
  return Math.round(days * 86_400_000);
}
