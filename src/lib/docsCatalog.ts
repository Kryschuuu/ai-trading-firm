/**
 * Dokumentationskatalog (GET /api/docs, `/docs`, `/docs/<Datei>.md`) —
 * Single Source of Truth.
 *
 * Die Whitelist liegt hier (statt direkt in der Route), damit auch andere
 * Server-Module — z. B. die Help-Sektion des Operations Centers
 * (`src/ops/collect.ts`) — dieselbe Liste lesen können, ohne sie zu duplizieren.
 *
 * SICHERHEIT: Nur diese Dateien sind über den Katalog adressierbar. Zusätzlich
 * darf der Renderer Dateien unter `docs/` und `audit-remediation/` lesen
 * (`src/lib/docsContent.ts`) — immer pfadnormalisiert, nie per Client-Pfad.
 * Path-Traversal ist damit strukturell ausgeschlossen.
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
  installWindows: {
    file: "docs/INSTALL-WINDOWS.md",
    title: "Installation (Windows)",
    subtitle: "PowerShell-One-Liner, PostgreSQL, Ollama und Workarounds",
  },
  handbuch: {
    file: "docs/HANDBUCH.md",
    title: "Handbuch",
    subtitle: "Bedienung, Beispiele, Runbooks und Troubleshooting",
  },
  missions: {
    file: "docs/MISSIONS.md",
    title: "Missionen, Markt-Scans & Vorlagen",
    subtitle: "Missions-Typen (Einzel-Symbol / Markt-Scan), Segmente, 18 Vorlagen, Mandatsprüfung (v1.35.0)",
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
  auditRemediation: {
    file: "docs/AUDIT_REMEDIATION_2026-09.md",
    title: "Audit-Remediation 2026-09",
    subtitle: "Senior-Peer-Review: Befunde H1–H10, C1–C4, B1/B2, W1/W2, S1/S2",
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
  setupbugs: {
    file: "docs/SETUP_BUGS.md",
    title: "Setup-Bug-Register",
    subtitle: "Befunde und Fixes des Setup-Pfads: PostgreSQL, Seed, Adapter, Build, Validierung (v1.30.0)",
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
  operations: {
    file: "docs/OPERATIONS.md",
    title: "Operations: Runbook „Funnel ist leer“",
    subtitle: "Entscheidungsbaum + Sektion „Market Data“ oberhalb des Funnels (v1.33)",
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
  bitunixReview: {
    file: "docs/PEER_REVIEW_BITUNIX_EXECUTION.md",
    title: "Peer-Review: Bitunix-Ausführung",
    subtitle: "Paper/Broker getrennt, ExecutionPort, Live-Gate (v1.20)",
  },
  routingReview: {
    file: "docs/PEER_REVIEW_ROUTING_OVERRIDES.md",
    title: "Peer-Review: Routing-Overrides",
    subtitle: "Provider/Modell-Overrides, Audit-Härtung, Test-Isolation (v1.22)",
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
  arenaTasks: {
    file: "docs/ARENA_TASKS.md",
    title: "Arena-Tasks",
    subtitle: "Übersicht aller Arena-Tasks mit Versionen, Umfang und Merge-Status",
  },
  bitunix: {
    file: "docs/BITUNIX.md",
    title: "Bitunix-Adapter",
    subtitle: "7. Venue — Public REST/WS, Signing, Paper-Modus B, Live-Gate (v1.15)",
  },
  alpaca: {
    file: "docs/ALPACA.md",
    title: "Alpaca-Adapter",
    subtitle: "8. Venue — US-Aktien/ETFs/Crypto, Paper-API, Bracket-Orders (v1.36.0)",
  },
  paperTrading: {
    file: "docs/PAPER_TRADING.md",
    title: "Paper-Trading",
    subtitle: "Modi A/B/C, Fill-Simulator, Failover, Replay, Historical Store (Task 03)",
  },
  routing: {
    file: "docs/LLM_ROUTING.md",
    title: "LLM-Modell-Routing (MODEL_ROUTER)",
    subtitle: "Deterministische Modellwahl, Eskalations-Policy, Budget-Deckel, Audit (v1.17)",
  },
  frontendControlPlane: {
    file: "docs/FRONTEND_CONTROL_PLANE.md",
    title: "Frontend Control Plane",
    subtitle: "Brokers & Venues, Credential-Fluss, Zustandsmodell, Secret-Isolation (Task 08)",
  },
  task10plan: {
    file: "docs/task-10-IMPLEMENTATION_PLAN.md",
    title: "Task 10 — Operations Center + RBAC",
    subtitle: "Rollen, Phase-Plan (Stand v1.18.0; Nachtrag v1.23.0)",
  },
};

export type DocsListItem = { slug: string; title: string; subtitle: string; href: string };

/** Pfad unter `/docs/…` (ohne führenden Slash-Segment `docs/`). */
export function docPublicPath(file: string): string {
  const normalized = file.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.startsWith("docs/")) return normalized.slice("docs/".length);
  return normalized;
}

/** Kanonische Browser-URL eines Katalog- oder Dateipfads. */
export function docsHrefForFile(file: string): string {
  return `/docs/${docPublicPath(file)}`;
}

export function docsHrefForSlug(slug: string): string | null {
  const entry = DOCS_CATALOG[slug];
  if (!entry) return null;
  return docsHrefForFile(entry.file);
}

/**
 * Normalisiert eine Dokument-Referenz aus URL, Query oder Markdown-Link.
 * Kein Dateisystem — Edge-/Middleware-tauglich.
 */
export function normalizeDocRef(input: string): string {
  let s = input.trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    /* unkodierte Pfade bleiben */
  }
  s = s.replace(/\\/g, "/");
  const q = s.indexOf("?");
  if (q >= 0) s = s.slice(0, q);
  while (s.startsWith("./")) s = s.slice(2);
  while (s.startsWith("/")) s = s.slice(1);
  return s;
}

/** Katalogtreffer über Slug, Dateiname oder `docs/`-Pfad (ohne I/O). */
export function lookupCatalog(ref: string): { slug: string; entry: DocsEntry } | null {
  const s = normalizeDocRef(ref);
  if (!s) return null;
  if (DOCS_CATALOG[s]) return { slug: s, entry: DOCS_CATALOG[s] };
  const lower = s.toLowerCase();
  const base = lower.split("/").pop() ?? "";
  for (const [slug, entry] of Object.entries(DOCS_CATALOG)) {
    const file = entry.file.replace(/\\/g, "/");
    const fileLower = file.toLowerCase();
    const fileBase = (file.split("/").pop() ?? "").toLowerCase();
    if (
      fileLower === lower ||
      fileLower === `docs/${lower}` ||
      fileBase === base ||
      fileBase === lower ||
      slug.toLowerCase() === lower
    ) {
      return { slug, entry };
    }
  }
  return null;
}

/** Alle Einträge in Katalogreihenfolge (für Listen und die Help-Sektion). */
export function listDocs(): DocsListItem[] {
  return Object.entries(DOCS_CATALOG).map(([slug, d]) => ({
    slug,
    title: d.title,
    subtitle: d.subtitle,
    href: docsHrefForFile(d.file),
  }));
}
