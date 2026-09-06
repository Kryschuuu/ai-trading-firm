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
 *
 * Struktur-Update 2026-09-05:
 *   - CHANGELOG.md kanonisch im Root, docs/CHANGELOG.md ist Stub
 *   - SECURITY_AUDIT.md nach docs/security/SECURITY_AUDIT.md
 *   - AUDIT_REMEDIATION_2026-09.md nach docs/audits/2026-09-03-peer-review/
 *   - PEER_REVIEW Dateien nach docs/peer-reviews/ Unterordner review.md
 *   - task- Dateien nach docs/archive/task-plans/
 *   - Neue Katalog-Eintraege fuer audits/, peer-reviews/, security/, archive/
 */
import { existsSync } from "node:fs";
import path from "node:path";

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
    subtitle: "Überblick, Architektur und Schnellstart — neue Struktur 2026-09-05",
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
  missions: {
    file: "docs/MISSIONS.md",
    title: "Missionen, Markt-Scans & Vorlagen",
    subtitle: "Missions-Typen (Einzel-Symbol / Markt-Scan), Segmente, 18 Vorlagen, Mandatsprüfung (v1.35.0)",
  },
  changelog: {
    file: "CHANGELOG.md",
    title: "Changelog",
    subtitle: "Versionen, Bugfixes und Änderungen je Release — kanonisch im Root (Keep a Changelog)",
  },
  configuration: {
    file: "CONFIGURATION.md",
    title: "Konfiguration & Env-Flags",
    subtitle: "Alle Env-Flags mit sicheren Defaults — verbindliche Flag-Referenz (ehemals Root INSTALL.md)",
  },
  security: {
    file: "docs/security/SECURITY_AUDIT.md",
    title: "Security-Audit",
    subtitle: "Findings, Schweregrad, Fixes und Peer-Review — konsolidiert in security/",
  },
  securityOverview: {
    file: "docs/security/README.md",
    title: "Security-Übersicht",
    subtitle: "Aggregierte Critical/High Findings, Auth-Modell, RBAC, Rate-Limit, Kill-Switch",
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
  alpaca: {
    file: "docs/ALPACA.md",
    title: "Alpaca-Adapter",
    subtitle: "8. Venue, US-Aktien/ETFs/Crypto, Testnet = Paper-API, Bracket-Orders (v1.36.0)",
  },
  arenaTasks: {
    file: "docs/ARENA_TASKS.md",
    title: "Arena-Tasks (01–11)",
    subtitle: "Übersicht aller Tasks mit Versionen, Umfang und Merge-Status",
  },
  // Neue Struktur 2026-09-05
  audits: {
    file: "docs/audits/README.md",
    title: "Audits — Zentrale Verwaltung",
    subtitle: "Alle Code-Reviews, Security-Audits chronologisch, skalierbares Schema für wiederkehrende Audits",
  },
  auditPeerReview: {
    file: "docs/audits/2026-09-03-peer-review/README.md",
    title: "Audit: Senior Peer-Review 2026-09-03",
    subtitle: "Befunde H1–H10, C1–C4, B1/B2, W1/W2, S1/S2 — CLOSED, alle gefixt v1.36.2–v1.36.24",
  },
  auditSecurityGpt01: {
    file: "docs/audits/2026-09-05-security-review-gpt01/README.md",
    title: "Security-Audit: GPT_01 2026-09-05",
    subtitle: "SEC-01/SEC-03 behoben; SEC-02, SEC-04 und weitere Findings offen",
  },
  peerReviews: {
    file: "docs/peer-reviews/README.md",
    title: "Peer-Review-Patches — Zentrale Sammlung",
    subtitle: "Patch-Vorschläge aus Peer-Reviews gesammelt, nachvollziehbar zugeordnet, bidirektional verlinkt",
  },
  peerReviewLive: {
    file: "docs/peer-reviews/2026-08-26-live-trading-readiness/README.md",
    title: "Peer-Review: Live-Trading-Readiness",
    subtitle: "Bottlenecks, Makro/Mikro, DB-Locks — CLOSED",
  },
  peerReviewBitunix: {
    file: "docs/peer-reviews/2026-08-26-bitunix-execution/README.md",
    title: "Peer-Review: Bitunix-Execution",
    subtitle: "Paper/Broker getrennt, ExecutionPort — CLOSED, v1.20.0",
  },
  peerReviewRouting: {
    file: "docs/peer-reviews/2026-08-26-routing-overrides/README.md",
    title: "Peer-Review: Routing-Overrides",
    subtitle: "Provider/Modell-Overrides, Audit-Härtung, Test-Isolation — CLOSED, v1.22",
  },
  installWindows: {
    file: "docs/INSTALL-WINDOWS.md",
    title: "Windows-Installation",
    subtitle: "PowerShell-One-Liner, PostgreSQL, Ollama und Workarounds",
  },
  paperTrading: {
    file: "docs/PAPER_TRADING.md",
    title: "Paper-Market-Data",
    subtitle: "Modi A/B/C, deterministischer Fill-Simulator, Failover-Kette, Replay (v1.26.2)",
  },
  archive: {
    file: "docs/archive/README.md",
    title: "Archiv — Historische Dokumente",
    subtitle: "Veraltete Task-Pläne, alte Audit-Reports — nicht Teil des aktiven Katalogs",
  },
};

export type DocsListItem = { slug: string; title: string; subtitle: string; path: string };

/** Alle Einträge in Katalogreihenfolge (für Listen und die Help-Sektion). */
export function listDocs(): DocsListItem[] {
  return Object.entries(DOCS_CATALOG).map(([slug, d]) => ({
    slug,
    title: d.title,
    subtitle: d.subtitle,
    path: docCanonicalPath(slug) ?? `/docs/${basename(d.file)}`,
  }));
}

/** Letztes Pfadsegment einer Datei (`docs/ARCHITECTURE.md` → `ARCHITECTURE.md`). */
function basename(file: string): string {
  return file.split("/").pop() ?? file;
}

/** Kanonischer URL-Pfad eines Dokuments (`/docs/ARCHITECTURE.md`). */
export function docCanonicalPath(slugOrFile: string): string | null {
  const entry = DOCS_CATALOG[slugOrFile];
  const file = entry ? entry.file : slugOrFile;
  // Unterstützt sowohl docs/ als auch Root-Dateien (CHANGELOG.md, CONFIGURATION.md)
  if (!file.endsWith(".md")) return null;
  if (file.startsWith("docs/")) return `/docs/${basename(file)}`;
  // Root-Dateien wie CHANGELOG.md, CONFIGURATION.md
  if (!file.includes("/")) return `/docs/${basename(file)}`;
  return null;
}

export type ResolvedDoc = {
  slug: string;
  entry: DocsEntry;
  /** Dateipfad relativ zum Projektstamm (z. B. `docs/ARCHITECTURE.md`). */
  file: string;
  /** Kanonische Browser-URL (z. B. `/docs/ARCHITECTURE.md`). */
  canonicalPath: string;
};

/**
 * Löst einen Namen (Slug ODER Dateiname mit/ohne `.md`) zu einem Dokument auf.
 *
 * Zuerst die Whitelist (`DOCS_CATALOG`), danach ein Existenz-Fallback innerhalb
 * von `docs/` + `.md`, damit auch nicht katalogisierte Doku-Dateien (z. B.
 * `audits/README.md` oder `security/README.md`) lokal ohne 404
 * gerendert werden. Der Pfad wird ausschließlich über ein bereinigtes
 * Basename konstruiert — Path-Traversal bleibt strukturell ausgeschlossen.
 */
export function resolveDoc(name: string): ResolvedDoc | null {
  const raw = (name ?? "").trim();
  if (!raw) return null;

  // 1) Katalog: exakter Slug.
  if (DOCS_CATALOG[raw]) {
    const entry = DOCS_CATALOG[raw];
    return { slug: raw, entry, file: entry.file, canonicalPath: docCanonicalPath(raw)! };
  }

  // Bereinigtes Basename (nur Dateiname, keine Pfadkomponenten).
  const safeBase = basename(raw).replace(/\\/g, "/").split("/").pop() ?? "";

  // 2) Katalog: Dateiname (mit oder ohne `.md`), case-insensitiv.
  for (const [slug, entry] of Object.entries(DOCS_CATALOG)) {
    const file = basename(entry.file);
    if (file.toLowerCase() === safeBase.toLowerCase() || file.replace(/\.md$/i, "").toLowerCase() === safeBase.replace(/\.md$/i, "").toLowerCase()) {
      return { slug, entry, file: entry.file, canonicalPath: docCanonicalPath(slug)! };
    }
  }

  // 3) Existenz-Fallback: echte Datei unter docs/ oder Unterordnern (z. B. audits/, peer-reviews/, security/)
  // Nur .md, keine Trenner außerhalb docs/
  if (!safeBase.endsWith(".md") || safeBase.includes("/") || safeBase.includes("\\") || safeBase === "..") return null;
  // Suche in bekannten Unterordnern
  const searchPaths = [
    `docs/${safeBase}`,
    `docs/audits/${safeBase}`,
    `docs/peer-reviews/${safeBase}`,
    `docs/security/${safeBase}`,
    `docs/archive/${safeBase}`,
    safeBase, // Root-Dateien wie CHANGELOG.md, CONFIGURATION.md
  ];
  for (const file of searchPaths) {
    if (existsSync(path.join(process.cwd(), file))) {
      const entry: DocsEntry = { file, title: safeBase.replace(/\.md$/, ""), subtitle: "" };
      return { slug: safeBase.replace(/\.md$/, "").toLowerCase(), entry, file, canonicalPath: `/docs/${safeBase}` };
    }
  }
  // Fallback: docs/* rekursiv? Nur wenn explizit erlaubt — hier nur docs/
  const file = `docs/${safeBase}`;
  if (!existsSync(path.join(process.cwd(), file))) return null;
  const entry: DocsEntry = { file, title: safeBase.replace(/\.md$/, ""), subtitle: "" };
  return { slug: safeBase.replace(/\.md$/, "").toLowerCase(), entry, file, canonicalPath: `/docs/${safeBase}` };
}
