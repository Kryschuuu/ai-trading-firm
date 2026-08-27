/**
 * CycleService — Singleton-Service für die Agenten-Zyklen (Task 06).
 *
 * Verwaltet den Scheduler, führt Daily/Weekly-Läufe aus, speichert Artefakte
 * und liefert Daten für die read-only API-Routen.
 */

import { CycleScheduler } from "./scheduler";
import { createDailySteps } from "./daily";
import { createWeeklySteps } from "./weekly";
import {
  getLatestDailyArtifact,
  getDailyArtifactByDate,
  getLatestWeeklyArtifact,
  getArtifactIndex,
  saveDailyCycleArtifacts,
  saveWeeklyCycleArtifacts,
  type DailyRunIndexEntry,
  type WeeklyRunIndexEntry,
} from "./artifacts";
import { createDefaultPorts } from "./ports";
import { SystemClock } from "./clock";
import type { Clock, CyclePorts, CycleRunRecord } from "./types";
import type { WeeklyReview } from "@/scanner/weekly";

export class CycleService {
  private scheduler: CycleScheduler;
  private ports: CyclePorts;
  private clock: Clock;

  constructor(options?: { ports?: CyclePorts; clock?: Clock }) {
    this.ports = options?.ports ?? createDefaultPorts();
    this.clock = options?.clock ?? new SystemClock();
    this.scheduler = new CycleScheduler({
      ports: this.ports,
      clock: this.clock,
      dailyStepsFactory: createDailySteps,
      weeklyStepsFactory: createWeeklySteps,
    });
  }

  getScheduler(): CycleScheduler {
    return this.scheduler;
  }

  getPorts(): CyclePorts {
    return this.ports;
  }

  getClock(): Clock {
    return this.clock;
  }

  /** Für Tests: Erlaubt das Überschreiben der Ports */
  setPortsForTests(ports: CyclePorts): void {
    this.ports = ports;
    this.scheduler = new CycleScheduler({
      ports: this.ports,
      clock: this.clock,
      dailyStepsFactory: createDailySteps,
      weeklyStepsFactory: createWeeklySteps,
    });
  }

  /** Für Tests: Erlaubt das Überschreiben der Clock */
  setClockForTests(clock: Clock): void {
    this.clock = clock;
    this.scheduler = new CycleScheduler({
      ports: this.ports,
      clock: this.clock,
      dailyStepsFactory: createDailySteps,
      weeklyStepsFactory: createWeeklySteps,
    });
  }

  /**
   * Führt die tägliche Pipeline aus und speichert versionierte Artefakte.
   */
  async runDaily(asOf?: Date): Promise<{ record: CycleRunRecord; artifactsDir: string; filesWritten: string[] }> {
    const targetDate = asOf ?? this.clock.now();
    const record = await this.scheduler.runDaily(targetDate);

    // Outputs aus dem Lauf aggregieren
    const stepOutputs: Record<string, unknown> = {};
    const saved = saveDailyCycleArtifacts(record, stepOutputs);

    return {
      record,
      artifactsDir: saved.artifactsDir,
      filesWritten: saved.filesWritten,
    };
  }

  /**
   * Führt das wöchentliche Universe-Review aus und speichert Artefakte.
   */
  async runWeekly(asOf?: Date): Promise<{ record: CycleRunRecord; artifactsDir: string; filesWritten: string[] }> {
    const targetDate = asOf ?? this.clock.now();
    const record = await this.scheduler.runWeekly(targetDate);

    // Dummy review falls im Step ausgeführt
    const emptyReview: WeeklyReview = {
      schemaVersion: 1,
      configVersion: 1,
      asOf: targetDate.toISOString(),
      entries: [],
      summary: { CORE: 0, ROTATION: 0, DISCOVERY: 0, EXCLUDED: 0 },
      changes: {
        newListings: [],
        delistings: [],
        liquidityDrops: [],
        feeIncreases: [],
        brokerUnavailable: [],
        regimeShifts: [],
        correlationClusters: [],
      },
      context: {
        regimeByInstrument: {},
        volume24hByInstrument: {},
        takerFeeByInstrument: {},
        paperAvailableByInstrument: {},
        persistence: {},
      },
    };

    const saved = saveWeeklyCycleArtifacts(record, { review: emptyReview });
    return {
      record,
      artifactsDir: saved.artifactsDir,
      filesWritten: saved.filesWritten,
    };
  }

  /**
   * Liest den jüngsten Tageslauf.
   */
  getDailyLatest(): Record<string, unknown> | null {
    return getLatestDailyArtifact();
  }

  /**
   * Liest einen Tageslauf nach Datum.
   */
  getDailyByDate(date: string): Record<string, unknown> | null {
    return getDailyArtifactByDate(date);
  }

  /**
   * Liest das jüngste wöchentliche Universe Review.
   */
  getWeeklyLatest(): WeeklyReview | null {
    return getLatestWeeklyArtifact();
  }

  /**
   * Liest alle Läufe mit Paginierung und Filterung.
   */
  getRuns(options: {
    type?: "daily" | "weekly" | "all";
    status?: string;
    page?: number;
    pageSize?: number;
  } = {}): {
    items: Array<DailyRunIndexEntry | WeeklyRunIndexEntry>;
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
  } {
    const index = getArtifactIndex();
    const type = options.type ?? "all";
    const status = options.status?.toUpperCase();
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));

    let all: Array<DailyRunIndexEntry | WeeklyRunIndexEntry> = [];
    if (type === "daily" || type === "all") {
      all = all.concat(index.dailyRuns);
    }
    if (type === "weekly" || type === "all") {
      all = all.concat(index.weeklyRuns);
    }

    if (status) {
      all = all.filter((r) => r.status.toUpperCase() === status);
    }

    // Sortieren nach startedAt absteigend
    all.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

    const total = all.length;
    const start = (page - 1) * pageSize;
    const items = all.slice(start, start + pageSize);

    return {
      items,
      page,
      pageSize,
      total,
      hasMore: start + items.length < total,
    };
  }
}

// Singleton-Instanz
let instance: CycleService | null = null;

export function getCycleService(): CycleService {
  if (!instance) {
    instance = new CycleService();
  }
  return instance;
}

export function resetCycleServiceForTests(service?: CycleService): void {
  instance = service ?? null;
}
