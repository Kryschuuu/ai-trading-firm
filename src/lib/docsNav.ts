/**
 * Themen-Struktur der Dokumentation — **reines** Modul ohne Node-Import.
 *
 * Warum ein eigenes Modul:
 *   `src/lib/docsCatalog.ts` liest das Dateisystem (`node:fs`) und ist damit
 *   server-only. Der Viewer braucht die Gruppierung aber auch im Browser
 *   (Sidebar, Filter, Katalog-Raster). Deshalb liegt die reine Zuordnung
 *   „Abschnitt ↔ Dokument“ hier und wird über `GET /api/docs` mitgeliefert.
 *
 * Warum keine Zuordnung in den Katalogeinträgen selbst:
 *   Der Katalog ist nach Dateien sortiert (Lesbarkeit, Diff-Stabilität), die
 *   Navigation dagegen nach **Themen**. Eine explizite Tabelle in einem Stück
 *   ist leichter zu prüfen als 80 verstreute Felder — und `tests/docsNav.test.ts`
 *   erzwingt, dass jeder Katalog-Slug genau einen Abschnitt hat und umgekehrt
 *   kein Abschnitt auf einen unbekannten Slug zeigt.
 *
 * Die Reihenfolge von {@link DOCS_SECTIONS} ist die Reihenfolge in der
 * Oberfläche: erst der Einstieg, dann das System, dann Referenz/Betrieb,
 * zuletzt Historie.
 */

export type DocsSectionId =
  | "einstieg"
  | "architektur"
  | "indikatoren"
  | "strategie"
  | "ausfuehrung"
  | "broker"
  | "betrieb"
  | "audits"
  | "archiv";

export type DocsSection = {
  id: DocsSectionId;
  /** Überschrift in der Navigation. */
  label: string;
  /** Ein Satz darunter (Katalog-Raster, Tooltip). */
  description: string;
  /** Sehr kurze Form für Filter-Chips. */
  short: string;
};

export const DOCS_SECTIONS: readonly DocsSection[] = [
  {
    id: "einstieg",
    label: "Einstieg, Betrieb & Referenz",
    description: "Installation, Handbuch, Update-Weg und die verbindliche Konfigurations-Referenz.",
    short: "Einstieg",
  },
  {
    id: "architektur",
    label: "Architektur & Datenfundament",
    description: "Zyklen, Marktuniversum, Symbole, Marktdaten-Pipeline, Historie und Repository-Struktur.",
    short: "Architektur",
  },
  {
    id: "indikatoren",
    label: "Indikatoren & Signale",
    description:
      "Formelkatalog der Engine, Claude Trading Indicator (CTI), Feature Store, Sentiment und Ranking.",
    short: "Indikatoren",
  },
  {
    id: "strategie",
    label: "Strategie, Backtest & Research",
    description: "Regeln, Templates, Screening, Validierung, Backtest-Engine und Walk-Forward.",
    short: "Strategie",
  },
  {
    id: "ausfuehrung",
    label: "Risiko & Ausführung",
    description: "Portfolio-Kennzahlen, Drawdown/Volatilität, Exits und die Ausführungspfade.",
    short: "Risiko",
  },
  {
    id: "broker",
    label: "Broker, Venues & Live-Gate",
    description: "Capability-Modell, Adapter (Bitunix, Alpaca), Live-Trading-Gate und Control Plane.",
    short: "Broker",
  },
  {
    id: "betrieb",
    label: "Missionen, Operations & Projektstand",
    description:
      "Missionen, Operations Center, Runbooks, Task-Übersicht, Beta-Zusage und Doku-Code-Sync.",
    short: "Betrieb",
  },
  {
    id: "audits",
    label: "Audits, Security & Peer-Reviews",
    description: "Chronologische Audit-Verwaltung, Security-Befunde und Review-Patches.",
    short: "Audits",
  },
  {
    id: "archiv",
    label: "Archiv & Weiterleitungen",
    description: "Historische Dokumente und Stubs, die nur alte Links am Leben halten.",
    short: "Archiv",
  },
] as const;

/** Schnellzugriff oben auf der Übersicht (Katalog-Slugs, Reihenfolge = Anzeige). */
export const DOCS_QUICK_ACCESS: readonly string[] = [
  "readme",
  "install",
  "handbuch",
  "missions",
  "configuration",
  "changelog",
] as const;

/**
 * Themen-Zuordnung der Katalog-Slugs.
 *
 * Vollständigkeit (jeder Slug genau einmal) wird von `tests/docsNav.test.ts`
 * gegen `DOCS_CATALOG` geprüft — ein neuer Eintrag ohne Abschnitt lässt die
 * Suite rot werden statt still im Archiv zu landen.
 */
export const SLUG_SECTION: Record<string, DocsSectionId> = {
  // ── Einstieg, Betrieb & Referenz ─────────────────────────────────────────
  readme: "einstieg",
  install: "einstieg",
  installWindows: "einstieg",
  handbuch: "einstieg",
  configuration: "einstieg",
  docsViewer: "einstieg",
  changelog: "einstieg",
  howtoUpdate: "einstieg",
  howtoLanSession: "einstieg",
  pgsetup: "einstieg",
  setupbugs: "einstieg",
  provider: "einstieg",

  // ── Architektur & Datenfundament ─────────────────────────────────────────
  architecture: "architektur",
  repositoryStructure: "architektur",
  universe: "architektur",
  symbols: "architektur",
  capabilities: "architektur",
  marketPipeline: "architektur",
  history: "architektur",
  historyMigration: "architektur",
  paperTrading: "architektur",
  observability: "architektur",
  marketDataErrorHandling: "architektur",
  perpetualData: "architektur",
  equityCurve: "architektur",

  // ── Indikatoren & Signale ────────────────────────────────────────────────
  indicators: "indikatoren",
  claudeTradingIndicator: "indikatoren",
  indicatorRanking: "indikatoren",
  featureStore: "indikatoren",
  sentiment: "indikatoren",
  mtfConfluence: "indikatoren",
  crossSectionalRanking: "indikatoren",
  regimeGate: "indikatoren",

  // ── Strategie, Backtest & Research ───────────────────────────────────────
  backtestEngine: "strategie",
  backtesting: "strategie",
  scanner: "strategie",
  strategyTemplates: "strategie",
  strategyScreening: "strategie",
  strategyValidation: "strategie",
  strategyLifecycle: "strategie",
  monteCarlo: "strategie",
  promptPerformance: "strategie",
  forecasts: "strategie",

  // ── Risiko & Ausführung ──────────────────────────────────────────────────
  portfolio: "ausfuehrung",
  drawdownScaling: "ausfuehrung",
  volatilityTargeting: "ausfuehrung",
  signalDecay: "ausfuehrung",
  postOnlyFallback: "ausfuehrung",
  twapExecution: "ausfuehrung",
  copyTrading: "ausfuehrung",
  devilsAdvocate: "ausfuehrung",

  // ── Broker, Venues & Live-Gate ───────────────────────────────────────────
  brokers: "broker",
  liveTrading: "broker",
  bitunix: "broker",
  alpaca: "broker",
  howToBitunixSync: "broker",
  frontendControlPlane: "broker",
  routing: "broker",

  // ── Missionen, Operations & Auditpfad ────────────────────────────────────
  missions: "betrieb",
  operationsCenter: "betrieb",
  operations: "betrieb",
  arenaTasks: "betrieb",
  docsSyncAudit: "betrieb",
  betaStatus: "betrieb",

  // ── Audits, Security & Peer-Reviews ──────────────────────────────────────
  security: "audits",
  securityOverview: "audits",
  audits: "audits",
  auditPeerReview: "audits",
  auditSecurityGpt01: "audits",
  auditFeatureGap: "audits",
  auditRoadmap20260920: "audits",
  auditVerbesserungen20260923: "audits",
  auditStrategyTemplate20260929: "audits",
  peerReviews: "audits",
  peerReviewLive: "audits",
  peerReviewBitunix: "audits",
  peerReviewRouting: "audits",

  // ── Archiv & Weiterleitungen ─────────────────────────────────────────────
  archive: "archiv",
  auditRemediation202609: "archiv",
  peerReviewBitunixExecutionLegacy: "archiv",
  peerReviewLiveTradingLegacy: "archiv",
  peerReviewRoutingOverridesLegacy: "archiv",
};

/** Fallback: ein (noch) nicht zugeordneter Slug landet sichtbar im Archiv. */
export const FALLBACK_SECTION: DocsSectionId = "archiv";

export function sectionForSlug(slug: string): DocsSectionId {
  return SLUG_SECTION[slug] ?? FALLBACK_SECTION;
}

const SECTION_BY_ID = new Map<string, DocsSection>(DOCS_SECTIONS.map((s) => [s.id, s]));

export function docsSection(id: string): DocsSection | null {
  return SECTION_BY_ID.get(id) ?? null;
}

export function isDocsSectionId(value: string): value is DocsSectionId {
  return SECTION_BY_ID.has(value);
}

/** Ein Eintrag der Navigation — die von `GET /api/docs` gelieferte Form. */
export type DocsNavItem = {
  slug: string;
  title: string;
  subtitle: string;
  path: string;
  section: DocsSectionId;
};
