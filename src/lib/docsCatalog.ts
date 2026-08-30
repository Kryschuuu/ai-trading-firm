/**
 * Dokumentationskatalog (GET /api/docs) — Single Source of Truth.
 *
 * Die Whitelist liegt hier (statt direkt in der Route), damit auch andere
 * Server-Module — z. B. die Help-Sektion des Operations Centers
 * (`src/ops/collect.ts`) — dieselbe Liste lesen können, ohne sie zu duplizieren.
 *
 * SICHERHEIT: Nur diese Dateien sind lesbar. Es gibt bewusst keine
 * Pfadübergabe von außen — der Schlüssel ist ein fester Slug, kein Pfad.
 * Damit ist Path-Traversal strukturell ausgeschlossen.
 */
export type DocsEntry = {
  /** Dateipfad relativ zum Projektstamm. */
  file: string;
  title: string;
  subtitle: string;
};

export const DOCS_CATALOG: Record<string, DocsEntry> = {
  readme: {
    file: "docs/README.md",
    title: "README",
    subtitle: "Überblick, Architektur und Schnellstart",
  },
  install: {
    file: "docs/INSTALL.md",
    title: "Installation",
    subtitle: "Schritt für Schritt auf CachyOS — Variante A und B",
  },
  handbuch: {
    file: "docs/HANDBUCH.md",
    title: "Handbuch",
    subtitle: "Bedienung, Beispiele, Runbooks und Troubleshooting",
  },
  changelog: {
    file: "docs/CHANGELOG.md",
    title: "Changelog",
    subtitle: "Versionen, Bugfixes und Änderungen je Release",
  },
  security: {
    file: "docs/SECURITY_AUDIT.md",
    title: "Security-Audit",
    subtitle: "Findings, Schweregrad, Fixes und Peer-Review",
  },
  provider: {
    file: "docs/PROVIDER_INTEGRATION.md",
    title: "LLM-Provider",
    subtitle: "Ollama · OpenAI · Gemini · Claude — Konfiguration und Kosten",
  },
  pgsetup: {
    file: "docs/SETUP_PG_TROUBLESHOOTING.md",
    title: "PostgreSQL-Setup-Hilfe",
    subtitle: "Sofort-Hilfe & Fehlersuche für Setup-Schritt 2 (v1.5.4)",
  },
  architecture: {
    file: "docs/ARCHITECTURE.md",
    title: "Architektur: Makro/Mikro-Zyklen",
    subtitle: "Event-Driven-Blaupause — Regeln, Latenz, Skalierung, Security (v1.6)",
  },
  universe: {
    file: "docs/MARKET_UNIVERSE.md",
    title: "Market Universe",
    subtitle: "Broker-unabhängige Instrumenten-Registry — Datenmodell, Normalisierung, API (v1.8)",
  },
  symbols: {
    file: "docs/SYMBOLS.md",
    title: "Symbol-Normalisierung (SYM-007)",
    subtitle: "Zentrale venue-aware Symbol-SSoT — Kanon ↔ Nativ, Profile, ID-Migration (v1.28)",
  },
  capabilities: {
    file: "docs/CAPABILITIES.md",
    title: "Capabilities & Instrument-Projektion",
    subtitle: "SSoT für discovery, marketData, trading; liveAvailable-Laufzeitprojektion (v1.28.1)",
  },
  marketPipeline: {
    file: "docs/MARKET_DATA_PIPELINE.md",
    title: "Market-Data-Pipeline",
    subtitle: "Discovery, Enrichment und Candle-Backfill vor dem deterministischen Scanner (v1.24)",
  },
  operationsCenter: {
    file: "docs/OPERATIONS_CENTER.md",
    title: "Operations Center",
    subtitle: "Market-Data-Readiness-Diagnose: leerer Scanner-Funnel Schritt für Schritt eingrenzen (v1.27)",
  },
  observability: {
    file: "docs/OBSERVABILITY.md",
    title: "Observability: Marktdaten-Fehler",
    subtitle: "Typisierte Fehler, Metriken, strukturierte Logs und Alerting (v1.26.3)",
  },
  marketDataErrorHandling: {
    file: "docs/ERROR_HANDLING_MARKETDATA.md",
    title: "Fehlerbehandlung Marktdaten (Entscheidungsbaum)",
    subtitle: "Werfen vs. Cache vs. DATA_UNAVAILABLE — Fehlertaxonomie, Sync- und Ops-Behandlung (v1.26.3)",
  },
  history: {
    file: "docs/HISTORY.md",
    title: "Historical Store",
    subtitle: "Kerzen-Schema v2, Timeframe-Schlüssel, Dedup und v1→v2-Migration (v1.26)",
  },
  historyMigration: {
    file: "docs/MIGRATION_TIMEFRAME_FIELD.md",
    title: "Runbook: Timeframe-Migration (v1 → v2)",
    subtitle: "Backup, Dry-Run/--apply, Neuaufbau statt Inline-Migration, Validierung, Rollback (v1.26.2)",
  },
  scanner: {
    file: "docs/DAILY_WEEKLY_RESEARCH.md",
    title: "Daily & Weekly Research",
    subtitle: "Deterministischer Markt-Scanner — 14 Faktoren, Market Score, Trichter, API (v1.12)",
  },
  portfolio: {
    file: "docs/PORTFOLIO_ANALYTICS.md",
    title: "Portfolio-Analytics & Risk Guard",
    subtitle: "Kennzahlen, Kovarianz, drei Optimizer-Modi, Risk-Guard-Kette, API (v1.13)",
  },
  liveReview: {
    file: "docs/PEER_REVIEW_LIVE_TRADING.md",
    title: "Peer-Review: Live-/Paper-Trading",
    subtitle: "Bottlenecks der 6-Agenten-Pipeline, Code-Review, Tests und Handlungsplan",
  },
  brokers: {
    file: "docs/BROKER_ARCHITECTURE.md",
    title: "Broker-Architektur",
    subtitle: "Capabilities, Execution-Modi, Control Plane und Live-Sperre (v1.15)",
  },
  liveTrading: {
    file: "docs/LIVE_TRADING.md",
    title: "Live-Trading-Gate (Task 11)",
    subtitle: "Auditierte State-Machine, Enforcement, Kill-Switch, Audit-Kette, CI (v1.19)",
  },
  bitunix: {
    file: "docs/BITUNIX.md",
    title: "Bitunix-Adapter",
    subtitle: "7. Venue — Public REST/WS, Signing, Paper-Modus B, Live-Gate (v1.15)",
  },
  routing: {
    file: "docs/LLM_ROUTING.md",
    title: "LLM-Modell-Routing (MODEL_ROUTER)",
    subtitle: "Deterministische Modellwahl, Eskalations-Policy, Budget-Deckel, Audit (v1.17)",
  },
};

export type DocsListItem = { slug: string; title: string; subtitle: string };

/** Alle Einträge in Katalogreihenfolge (für Listen und die Help-Sektion). */
export function listDocs(): DocsListItem[] {
  return Object.entries(DOCS_CATALOG).map(([slug, d]) => ({ slug, title: d.title, subtitle: d.subtitle }));
}
