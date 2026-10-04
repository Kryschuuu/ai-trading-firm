/**
 * Dashboard-Reiter — die eine ID-Liste für Leiste, Panels und Sprünge.
 *
 * Reihenfolge = Arbeitsablauf der Firma. `TAB_DEFS` in `FirmDashboard`
 * muss dieselben IDs in derselben Reihenfolge tragen (Test).
 */

export const DASHBOARD_TAB_IDS = [
  "overview",
  "reports",
  "protocol",
  "agents",
  "workshop",
  "ops",
  "brokers",
  "risk",
  "architecture",
] as const;

export type DashboardTab = (typeof DASHBOARD_TAB_IDS)[number];

/** `true` nur für eine der neun Reiter-IDs — unbekannte Sprünge bleiben wirkungslos. */
export function isDashboardTab(value: string): value is DashboardTab {
  return (DASHBOARD_TAB_IDS as readonly string[]).includes(value);
}

/**
 * Klick oder Tastatur auf der Reiterleiste.
 * Eine unbekannte ID lässt den aktuellen Bereich stehen, statt ein Panel
 * zu wählen, das es nicht gibt (dann wäre die Fläche leer).
 */
export function selectDashboardTab(current: DashboardTab, requested: string): DashboardTab {
  return isDashboardTab(requested) ? requested : current;
}
