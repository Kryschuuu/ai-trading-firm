/**
 * Scheduler für Daily/Weekly-Zyklen (Task 06).
 *
 * Verwaltet Ausführungspläne mit injizierbarer Uhr (Clock):
 *   - Tagesroutine: 00:00 bis ca. 11:00 UTC
 *   - Weekly Universe Review: 1× wöchentlich an konfigurierbarem Wochentag
 *   - Vollständig zeitraffer-fähig für Tests ohne echte Wartezeit
 */

import { formatDateYYYYMMDD, getIsoWeekString } from "./clock";
import { executeCycle } from "./engine";
import { createDefaultPorts } from "./ports";
import type { Clock, CyclePorts, CycleRunRecord, StepDefinition } from "./types";
import { SystemClock } from "./clock";

export interface SchedulerConfig {
  /** Tag der wöchentlichen Überprüfung: 0 = Sonntag, 1 = Montag, ..., 6 = Samstag (Default: 0 = Sonntag) */
  weeklyReviewDay?: number;
  /** Stunde (0-23) für den wöchentlichen Start in UTC (Default: 0) */
  weeklyReviewHourUtc?: number;
  /** Stunde (0-23) für den täglichen Start in UTC (Default: 0) */
  dailyStartHourUtc?: number;
}

export class CycleScheduler {
  private clock: Clock;
  private ports: CyclePorts;
  private config: Required<SchedulerConfig>;
  private dailyStepsFactory: () => StepDefinition[] = () => [];
  private weeklyStepsFactory: () => StepDefinition[] = () => [];
  private lastDailyRunDate: string | null = null;
  private lastWeeklyRunWeek: string | null = null;

  constructor(
    options: {
      clock?: Clock;
      ports?: CyclePorts;
      config?: SchedulerConfig;
      dailyStepsFactory?: () => StepDefinition[];
      weeklyStepsFactory?: () => StepDefinition[];
    } = {}
  ) {
    this.clock = options.clock ?? new SystemClock();
    this.ports = options.ports ?? createDefaultPorts();
    this.config = {
      weeklyReviewDay: options.config?.weeklyReviewDay ?? 0, // Sonntag
      weeklyReviewHourUtc: options.config?.weeklyReviewHourUtc ?? 0,
      dailyStartHourUtc: options.config?.dailyStartHourUtc ?? 0,
    };
    if (options.dailyStepsFactory) this.dailyStepsFactory = options.dailyStepsFactory;
    if (options.weeklyStepsFactory) this.weeklyStepsFactory = options.weeklyStepsFactory;
  }

  setDailyStepsFactory(factory: () => StepDefinition[]): void {
    this.dailyStepsFactory = factory;
  }

  setWeeklyStepsFactory(factory: () => StepDefinition[]): void {
    this.weeklyStepsFactory = factory;
  }

  getClock(): Clock {
    return this.clock;
  }

  getPorts(): CyclePorts {
    return this.ports;
  }

  /**
   * Führt die tägliche Pipeline für ein gegebenes Datum aus.
   */
  async runDaily(asOf?: Date): Promise<CycleRunRecord> {
    const targetDate = asOf ?? this.clock.now();
    const dateStr = formatDateYYYYMMDD(targetDate);
    const cycleId = `daily-${dateStr}-${this.clock.nowMs()}`;

    const steps = this.dailyStepsFactory();
    const record = await executeCycle({
      cycleId,
      type: "daily",
      date: dateStr,
      steps,
      ports: this.ports,
      clock: this.clock,
    });

    if (record.status === "COMPLETED") {
      this.lastDailyRunDate = dateStr;
    }

    return record;
  }

  /**
   * Führt das wöchentliche Universe-Review für eine gegebene Kalenderwoche aus.
   */
  async runWeekly(asOf?: Date): Promise<CycleRunRecord> {
    const targetDate = asOf ?? this.clock.now();
    const dateStr = formatDateYYYYMMDD(targetDate);
    const weekStr = getIsoWeekString(targetDate);
    const cycleId = `weekly-${weekStr}-${this.clock.nowMs()}`;

    const steps = this.weeklyStepsFactory();
    const record = await executeCycle({
      cycleId,
      type: "weekly",
      date: dateStr,
      week: weekStr,
      steps,
      ports: this.ports,
      clock: this.clock,
    });

    if (record.status === "COMPLETED") {
      this.lastWeeklyRunWeek = weekStr;
    }

    return record;
  }

  /**
   * Prüft, ob ein geplanter Lauf gemäß Uhrzeit/Wochentag fällig ist,
   * und führt ihn gegebenenfalls aus.
   */
  async tick(): Promise<{ ranDaily: boolean; ranWeekly: boolean; dailyRecord?: CycleRunRecord; weeklyRecord?: CycleRunRecord }> {
    const now = this.clock.now();
    const dateStr = formatDateYYYYMMDD(now);
    const weekStr = getIsoWeekString(now);
    const hour = now.getUTCHours();
    const dayOfWeek = now.getUTCDay();

    let ranDaily = false;
    let ranWeekly = false;
    let dailyRecord: CycleRunRecord | undefined;
    let weeklyRecord: CycleRunRecord | undefined;

    // Daily prüfen
    if (hour >= this.config.dailyStartHourUtc && this.lastDailyRunDate !== dateStr) {
      dailyRecord = await this.runDaily(now);
      ranDaily = true;
    }

    // Weekly prüfen
    if (
      dayOfWeek === this.config.weeklyReviewDay &&
      hour >= this.config.weeklyReviewHourUtc &&
      this.lastWeeklyRunWeek !== weekStr
    ) {
      weeklyRecord = await this.runWeekly(now);
      ranWeekly = true;
    }

    return { ranDaily, ranWeekly, dailyRecord, weeklyRecord };
  }
}
