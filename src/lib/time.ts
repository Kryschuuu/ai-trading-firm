/**
 * Zeitgrenzen in Europe/Berlin.
 *
 * Der Tagesverlust-Limit und alle Reports rechnen in Berliner Tagen — nicht in
 * UTC (sonst wechselt der "Tag" um 2 Uhr morgens Ortszeit) und nicht in Server-
 * Localtime (systemd läuft oft mit UTC).
 *
 * DST-sicher über die tatsächliche Offset-Berechnung; der Grenzfall
 * Umschlungennacht wird durch Nachjustieren abgefangen.
 */

const TZ = "Europe/Berlin";

/** Offset von TZ zu UTC in Minuten für einen Zeitpunkt (z. B. 120 = CEST). */
export function tzOffsetMinutes(at: Date, timeZone: string = TZ): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(at)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour % 24, parts.minute, parts.second
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** YYYY-MM-DD des Berliner Kalendertags. */
export function berlinDayKey(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}

/** UTC-Instant der Berliner Mitternachtsgrenze des Tages, zu dem `at` gehört. */
export function startOfBerlinDay(at: Date = new Date()): Date {
  let offset = tzOffsetMinutes(at);
  let midnight = shiftToMidnight(at, offset);
  // DST-Kante: Wenn die Mitternacht selbst einen anderen Offset hat, neu rechnen.
  const offsetAtMidnight = tzOffsetMinutes(midnight);
  if (offsetAtMidnight !== offset) {
    offset = offsetAtMidnight;
    midnight = shiftToMidnight(at, offset);
  }
  return midnight;
}

function shiftToMidnight(at: Date, offsetMinutes: number): Date {
  const shifted = new Date(at.getTime() + offsetMinutes * 60_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offsetMinutes * 60_000);
}

/** UTC-Instant des Montags 00:00 Berliner Zeit der Woche von `at` (ISO-Woche). */
export function startOfBerlinWeek(at: Date = new Date()): Date {
  // Wochentag muss in BERLIN gelesen werden — der UTC-Instant der Berliner
  // Mitternacht liegt oft noch am Vortag!
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short",
  }).format(at); // "Mon".."Sun"
  const idx: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const daysBack = (idx[weekday] + 6) % 7; // Mo=0 … So=6
  // Über den Tages-Key gehen statt über Millisekunden-Subtraktion (DST-sicher).
  const [y, m, d] = berlinDayKey(at).split("-").map(Number);
  const noonUtcOfTargetDay = new Date(Date.UTC(y, m - 1, d - daysBack, 12));
  return startOfBerlinDay(noonUtcOfTargetDay);
}

/** UTC-Instant des 1. des Monats 00:00 Berliner Zeit. */
export function startOfBerlinMonth(at: Date = new Date()): Date {
  const dayKey = berlinDayKey(at);
  const [y, m] = dayKey.split("-").map(Number);
  // Erster des Monats per Key → dann dessen Mitternachtsinstant bestimmen.
  const firstApprox = new Date(`${y}-${String(m).padStart(2, "0")}-01T12:00:00Z`);
  return startOfBerlinDay(firstApprox);
}

export type Period = "day" | "week" | "month";

export function periodStart(period: Period, at: Date = new Date()): Date {
  switch (period) {
    case "day": return startOfBerlinDay(at);
    case "week": return startOfBerlinWeek(at);
    case "month": return startOfBerlinMonth(at);
  }
}
