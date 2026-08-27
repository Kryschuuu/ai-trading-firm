/**
 * Injizierbare Uhr und Zeitfunktionen für die Agenten-Zyklen.
 *
 * Ermöglicht vollständige deterministische Tests im Zeitraffer
 * ohne echte Wartezeiten.
 */

import type { Clock } from "./types";

/**
 * Standard-Uhr basierend auf der realen Systemzeit.
 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  nowMs(): number {
    return Date.now();
  }

  toISOString(): string {
    return new Date().toISOString();
  }
}

/**
 * Simulierbare Uhr für Tests und deterministische Zeitraffer-Läufe.
 */
export class SimulatedClock implements Clock {
  private currentMs: number;

  constructor(initial: Date | string | number = new Date("2026-08-27T00:00:00.000Z")) {
    this.currentMs = typeof initial === "number" ? initial : new Date(initial).getTime();
    if (!Number.isFinite(this.currentMs)) {
      throw new Error(`Ungültige Initialzeit für SimulatedClock: ${String(initial)}`);
    }
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  nowMs(): number {
    return this.currentMs;
  }

  toISOString(): string {
    return new Date(this.currentMs).toISOString();
  }

  /** Setzt die Zeit auf einen absoluten Wert */
  setTime(time: Date | string | number): void {
    const ms = typeof time === "number" ? time : new Date(time).getTime();
    if (!Number.isFinite(ms)) {
      throw new Error(`Ungültige Zeit für setTime: ${String(time)}`);
    }
    this.currentMs = ms;
  }

  /** Spult die Zeit um Millisekunden vor */
  advanceMs(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`advanceMs erwartet nicht-negative Zahl, erhalten: ${ms}`);
    }
    this.currentMs += ms;
  }

  /** Spult die Zeit um Minuten vor */
  advanceMinutes(minutes: number): void {
    this.advanceMs(minutes * 60_000);
  }

  /** Spult die Zeit um Stunden vor */
  advanceHours(hours: number): void {
    this.advanceMs(hours * 3_600_000);
  }

  /** Spult die Zeit um Tage vor */
  advanceDays(days: number): void {
    this.advanceMs(days * 86_400_000);
  }
}

/** Formatiert ein Datum als YYYY-MM-DD */
export function formatDateYYYYMMDD(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Berechnet den ISO-8601-Wochenstring (z. B. "2026-W35").
 * Gemäß ISO-Standard ist Woche 1 die Woche mit dem 4. Januar bzw. dem ersten Donnerstag.
 */
export function getIsoWeekString(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * Prüft, ob eine Uhrzeit (z. B. "06:15") in einem Fenster "06:00-07:00" liegt.
 * Grenzwert start ist inklusive, end exklusiv.
 */
export function isInTimeWindow(currentTimeHHMM: string, window: string): boolean {
  const [start, end] = window.split("-").map((s) => s.trim());
  if (!start || !end) return true;
  if (start <= end) {
    return currentTimeHHMM >= start && currentTimeHHMM < end;
  }
  // Über Mitternacht (z. B. 23:00-02:00)
  return currentTimeHHMM >= start || currentTimeHHMM < end;
}

/** Extrahiert "HH:MM" aus einem Date in UTC */
export function formatHHMM(date: Date): string {
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
