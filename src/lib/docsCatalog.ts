/**
 * Dokumentationskatalog (GET /api/docs) — Single Source of Truth.
 *
 * Die Whitelist liegt hier (statt direkt in der Route), damit auch andere
 * Server-Module — z. B. die Help-Sektion des Operations Centers
 * (`src/ops/collect.ts`) — dieselbe Liste lesen können, ohne sie zu duplizieren.
 *
 * URL-SCHEMA (Doku-Rendering-Fix, 2026-10-03)
 * -------------------------------------------
 * Die Doku ist für **GitHub** geschrieben: relative Links wie
 * `[Kapitel](audits/2026-09-18-feature-gap/README.md)` lösen gegenüber dem
 * Verzeichnis der Quelldatei auf. Der Browser-Viewer muss dasselbe tun.
 * Deshalb trägt die kanonische URL den **Pfad innerhalb von `docs/`**:
 *
 *   docs/README.md                             → /docs/README.md
 *   docs/security/README.md                    → /docs/security/README.md
 *   docs/audits/2026-09-18-feature-gap/README.md
 *                                              → /docs/audits/2026-09-18-feature-gap/README.md
 *   CHANGELOG.md (Repo-Root)                   → /docs/root/CHANGELOG.md
 *
 * Der Pfad ist damit eindeutig. Vorher wurde nur der **Dateiname** benutzt;
 * bei ~31 `README.md` im Baum lieferte `/docs/README.md` je nach Aufrufer
 * lautlos das falsche Dokument (Befund B5).
 *
 * Repo-Root-Dateien (`CHANGELOG.md`, `CONFIGURATION.md`, …) stehen unter dem
 * reservierten Segment `root/`, weil sie sonst mit gleichnamigen Dateien unter
 * `docs/` kollidieren (`docs/CHANGELOG.md` ist ein Weiterleitungs-Stub,
 * `docs/INSTALL.md` die CachyOS-Anleitung — beide existieren auch im Root).
 *
 * SICHERHEIT — Path-Traversal
 * ---------------------------
 * Auflösbar sind **ausschließlich** Dateien, die
 *   1. unter `docs/` liegen (`docs/**`), oder
 *   2. eine Markdown-Datei direkt im Repo-Root sind (`<Name>.md`, kein `/`).
 * Alles andere wird abgewiesen. Zusätzlich bleibt die Altlast-Regel bestehen:
 * eine Eingabe, die ein `..`-Segment enthält, wird komplett abgewiesen, auch
 * wenn der normalisierte Pfad wieder innerhalb von `docs/` landen würde
 * (Verteidigung in der Tiefe — die Abnahme verlangt genau das).
 * Damit ist der Viewer kein File-Reader für das gesamte Repository: Ziele
 * außerhalb von `docs/` (z. B. `../src/db/schema.ts`, `../drizzle/*.sql`)
 * werden gar nicht erst in eine URL übersetzt (Befund B7).
 *
 * Struktur-Update 2026-09-05:
 *   - CHANGELOG.md kanonisch im Root, docs/CHANGELOG.md ist Stub
 *   - SECURITY_AUDIT.md nach docs/security/SECURITY_AUDIT.md
 *   - AUDIT_REMEDIATION_2026-09.md nach docs/audits/2026-09-03-peer-review/
 *   - PEER_REVIEW Dateien nach docs/peer-reviews/ Unterordner review.md
 *   - task- Dateien nach docs/archive/task-plans/
 *   - Neue Katalog-Eintraege fuer audits/, peer-reviews/, security/, archive/
 */
import { existsSync, statSync } from "node:fs";

import { resolveRuntimePath } from "./appPaths";
import {
  ROOT_DOC_SEGMENT,
  basename,
  decodePathSegment,
  canonicalPathForFile,
  fileFromCanonicalPath,
  hasParentRef,
  isServableDocFile,
  normalizeSlashes,
} from "./docsLinks";

// Re-Export: das URL-Schema liegt bewusst im reinen Modul `docsLinks`
// (Client-Bundle darf kein `node:fs` enthalten). Katalog-Konsumenten
// (`src/auth/ops.ts`, API-Route, Tests) importieren weiter von hier.
export {
  ROOT_DOC_SEGMENT,
  basename,
  canonicalPathForFile,
  fileFromCanonicalPath,
  isServableDocFile,
};

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
  howtoLanSession: {
    file: "docs/HOWTO_LAN_SESSION.md",
    title: "How-to: LAN und Sitzung nach Update",
    subtitle: "EADDRINUSE/127.0.0.1-Listener plus „Sitzung abgelaufen“ statt Datenbankfehler (v1.36.41)",
  },
  howtoUpdate: {
    file: "docs/HOWTO_UPDATE.md",
    title: "How-to: Update einer laufenden Firma",
    subtitle: "git pull → Stop-Reihenfolge → npm ci → Schema → Build → Start → Verifikation (v1.39.2)",
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
    subtitle: "Deterministischer Markt-Scanner — 15 Faktoren, Market Score, Trichter, API (v1.12)",
  },
  portfolio: {
    file: "docs/PORTFOLIO_ANALYTICS.md",
    title: "Portfolio-Analytics & Risk Guard",
    subtitle: "Kennzahlen, Kovarianz, drei Optimizer-Modi, Risk-Guard-Kette, API (v1.13)",
  },
  backtestEngine: {
    file: "docs/BACKTEST_ENGINE.md",
    title: "Multi-Asset Backtest-Engine",
    subtitle: "Synchronisierter Event-Driven Replay Simulator, Slippage/Fee-Modelle, Portfolio-Kennzahlen (v1.41.0)",
  },
  backtesting: {
    file: "docs/BACKTESTING.md",
    title: "Walk-Forward-Backtesting",
    subtitle: "Zeitmaske, Paper-Ausführung, IS/OOS-Fenster, persistierte Runs, CLI (GAP-01, v1.51.0)",
  },
  regimeGate: {
    file: "docs/REGIME_GATE.md",
    title: "Regime-Gate (Markt-Regime-Klassifikator)",
    subtitle: "Trend/Range/Crash-Klassifikation, Gate-Modi off/monitor/enforce, Hysterese (GAP-06, v1.46.0)",
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
    subtitle: "SEC-01/SEC-02/SEC-03/SEC-04/SEC-10 behoben; weitere Findings offen",
  },
  auditFeatureGap: {
    file: "docs/audits/2026-09-18-feature-gap/README.md",
    title: "Feature-Gap-Audit 2026-09-18 (Co-Audit)",
    subtitle: "10 Feature-Lücken (GAP-01…GAP-10) — Remediation abgeschlossen mit v1.51.1",
  },
  auditRoadmap20260920: {
    file: "docs/audits/2026-09-20-roadmap-audit/README.md",
    title: "Roadmap-Audit 2026-09-20",
    subtitle: "25 Komponenten: 4 VERIFIED, 21 FIXED — Remediation abgeschlossen (v1.73.0)",
  },
  auditVerbesserungen20260923: {
    file: "docs/audits/2026-09-23-verbesserungen-fahrplan/README.md",
    title: "Audit: Verbesserungen 2026-09-23",
    subtitle: "Regel-Backtest mit Paper-Kosten, Workshop-Schritt 5, Trusted-Indikatoren — CLOSED v0.2.0",
  },
  auditStrategyTemplate20260929: {
    file: "docs/audits/2026-09-29-strategy-template-ausbau/README.md",
    title: "Audit: Strategie-Template-Ausbau 2026-09-29",
    subtitle:
      "19 Findings + 32 Prompts in 8 Phasen, Release-Plan v0.6.0 bis v0.11.2 — " +
      "bleibt ausdruecklich Beta (BETA_STATUS.md)",
  },
  betaStatus: {
    file: "docs/BETA_STATUS.md",
    title: "Beta-Status und Exit-Kriterien",
    subtitle:
      "Verbindliche Beta-Zusage: Kriterien B1 bis B8, verbotene Handlungen, " +
      "Review-Kadenz — kein Roadmap-Exit",
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
  strategyLifecycle: {
    file: "docs/STRATEGY_LIFECYCLE.md",
    title: "Strategy-Lifecycle & Driftgates",
    subtitle: "9-Zustands-Promotion Backtest↔Paper↔Live, immutable Evidence, Degrationsleiter, Order-Gate (RMA-P1-05, v1.73.0)",
  },
  copyTrading: {
    file: "docs/COPY_TRADING.md",
    title: "Copy-Trading — Policy & Order-Links",
    subtitle: "Versionierte fail-closed Limits, SIMULATE_ONLY-DB-Zwang, idempotente Order-Links und Abgrenzung zur Execution-Quality-Reconciliation (STX-07-02)",
  },
  strategyValidation: {
    file: "docs/STRATEGY_VALIDATION.md",
    title: "Strategie-Validierung: Annahmen-Audit",
    subtitle: "Elf deterministische Prüfungen vor jeder Metrik: UNKNOWN statt Scheingenauigkeit, critical ⇒ INCONCLUSIVE statt FAIL, Gate assumptionGate() (STX-06-01, v0.10.0)",
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

  // ── Kataloglücken geschlossen (Befund B6, 2026-10-03) ────────────────────
  // Diese docs/*.md existieren, tauchten aber in keiner Navigation auf: sie
  // waren nur über den Basename-Fallback erreichbar. Jetzt regulär geführt.
  auditRemediation202609: {
    file: "docs/AUDIT_REMEDIATION_2026-09.md",
    title: "Audit-Remediation 2026-09 — Weiterleitung",
    subtitle: "Weiterleitung; aktueller Stand unter audits/2026-09-03-peer-review/",
  },
  crossSectionalRanking: {
    file: "docs/CROSS_SECTIONAL_RANKING.md",
    title: "Point-in-Time Cross-Sectional Momentum Ranking (RMA-P2-04, v1.63.0)",
    subtitle: "Wo steht ein Symbol im Querschnitt — Rangbildung, Point-in-Time-Freeze, API",
  },
  devilsAdvocate: {
    file: "docs/DEVILS_ADVOCATE.md",
    title: "Devil’s Advocate (Strukturierte Falsifikationsrolle)",
    subtitle: "Adversariale Kontrollinstanz vor dem finalen Risikocommit",
  },
  docsSyncAudit: {
    file: "docs/DOCS_SYNC_AUDIT.md",
    title: "Docs-Code-Sync-Audit (Task 12)",
    subtitle: "Geprüfte Dokumentations-Behauptungen gegen den Code",
  },
  drawdownScaling: {
    file: "docs/DRAWDOWN_SCALING.md",
    title: "Hysteretisches Drawdown-Risk-Scaling (RMA-P5-04, v1.68.0)",
    subtitle: "Autoritative Vertrauensskalierung auf Basis der reconcilten Equity",
  },
  featureStore: {
    file: "docs/FEATURE_STORE.md",
    title: "Point-in-Time Feature Store",
    subtitle: "Stabil reproduzierbare Scanner-Features, versioniert und point-in-time",
  },
  forecasts: {
    file: "docs/FORECASTS.md",
    title: "Forecast-Ledger & Kalibrierung (RMA-P3-01, v1.55.0)",
    subtitle: "Unveränderliche Forecast-Verträge und Kalibrierungsauswertung",
  },
  frontendControlPlane: {
    file: "docs/FRONTEND_CONTROL_PLANE.md",
    title: "Broker Control Plane — Frontend & Credential-Manager (Task 08)",
    subtitle: "API-Fläche, Credential-Manager und Freigabe-Fläche je Venue",
  },
  howToBitunixSync: {
    file: "docs/HOW_TO_BITUNIX_SYNC.md",
    title: "How-to: BITUNIX freischalten und Kerzen-Warmup nachziehen",
    subtitle: "Vier Gates für BITUNIX_ENABLED und das Warmup bei laufender Firma",
  },
  monteCarlo: {
    file: "docs/MONTE_CARLO.md",
    title: "Monte-Carlo-/Trade-Resampling (RMA-P6-02)",
    subtitle: "Reproduzierbare Monte-Carlo-Analyse über die Trades eines Walk-Forward-Runs",
  },
  mtfConfluence: {
    file: "docs/MTF_CONFLUENCE.md",
    title: "Deterministische Multi-Timeframe-Konfluenz (RMA-P2-03, v1.62.0)",
    subtitle: "Zeigen die konfigurierten Timeframes dasselbe? — Konfluenz-Score und API",
  },
  peerReviewBitunixExecutionLegacy: {
    file: "docs/PEER_REVIEW_BITUNIX_EXECUTION.md",
    title: "Peer-Review: Bitunix-Execution — Weiterleitung",
    subtitle: "Weiterleitung; neuer Stand unter peer-reviews/2026-08-26-bitunix-execution/",
  },
  peerReviewLiveTradingLegacy: {
    file: "docs/PEER_REVIEW_LIVE_TRADING.md",
    title: "Peer-Review: Live-Trading — Weiterleitung",
    subtitle: "Weiterleitung; neuer Stand unter peer-reviews/2026-08-26-live-trading-readiness/",
  },
  peerReviewRoutingOverridesLegacy: {
    file: "docs/PEER_REVIEW_ROUTING_OVERRIDES.md",
    title: "Peer-Review: Routing-Overrides — Weiterleitung",
    subtitle: "Weiterleitung; neuer Stand unter peer-reviews/2026-08-26-routing-overrides/",
  },
  perpetualData: {
    file: "docs/PERPETUAL_DATA.md",
    title: "Perpetual-Daten — Funding, Open Interest, Liquidationen",
    subtitle: "Historische, point-in-time Derivate-Wahrheit für Backtest und Research",
  },
  postOnlyFallback: {
    file: "docs/POST_ONLY_FALLBACK.md",
    title: "Post-Only-Ausführung mit Market-Fallback (RMA-P4-02)",
    subtitle: "Maker-First-Ausführung mit deterministischem Fallback-Pfad",
  },
  promptPerformance: {
    file: "docs/PROMPT_PERFORMANCE.md",
    title: "Prompt-Performance & Version-Metrikvergleich (RMA-P3-02, v1.65.0)",
    subtitle: "Immutable Prompt-Versionen und fairer Metrik-Vergleich",
  },
  repositoryStructure: {
    file: "docs/REPOSITORY_STRUCTURE.md",
    title: "Repository-Struktur — Übersicht & Pflegeanleitung",
    subtitle: "Logische, wartbare, selbsterklärende Verzeichnisstruktur",
  },
  sentiment: {
    file: "docs/SENTIMENT.md",
    title: "Kalibrierbare strukturierte Sentiment-Outputs (RMA-P2-05)",
    subtitle: "Strukturierte, kalibrierbare Sentiment-Signale aus Nachrichten und Kommentaren",
  },
  signalDecay: {
    file: "docs/SIGNAL_DECAY.md",
    title: "Signal-Decay-Exits (RMA-P5-05, v1.69.0)",
    subtitle: "Versionierte, deterministische Exits bei abklingendem Entry-Signal",
  },
  strategyTemplates: {
    file: "docs/STRATEGY_TEMPLATES.md",
    title: "Strategie-Templates — Katalog (aus dem Code generiert)",
    subtitle: "Versionierte Strategie-Artefakte incl. Parameter und Abnahmekriterien",
  },
  twapExecution: {
    file: "docs/TWAP_EXECUTION.md",
    title: "TWAP- und Depth-aware Execution (RMA-P4-03, v1.71.0)",
    subtitle: "Zeitlich gestaffelte Maker-Kinder mit Orderbuch-Tiefen-Logik",
  },
  volatilityTargeting: {
    file: "docs/VOLATILITY_TARGETING.md",
    title: "Portfolio-Volatility-Targeting (RMA-P5-01, v1.67.0)",
    subtitle: "Kontinuierliches Volatilitäts-Targeting als zweite Risikoebene",
  },
  claudeTradingIndicator: {
    file: "docs/CLAUDE_TRADING_INDICATOR.md",
    title: "Claude Trading Indicator (CTI)",
    subtitle: "Signalschicht `src/signals/`, CLI `npm run cti`",
  },
  strategyScreening: {
    file: "docs/STRATEGY_SCREENING.md",
    title: "Strategie×Markt-Screening — Persistenz und Idempotenz",
    subtitle: "Candidate Matrix, Persistenz und Idempotenz des Screenings (STX-05-03/05-04)",
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

// ---------------------------------------------------------------------------
// Pfad- und URL-Helfer
// ---------------------------------------------------------------------------

/**
 * Kanonischer URL-Pfad eines Dokuments — akzeptiert einen Katalog-Slug oder
 * einen Dateipfad (`docs/audits/…/README.md`, `CHANGELOG.md`).
 */
export function docCanonicalPath(slugOrFile: string): string | null {
  const raw = (slugOrFile ?? "").trim();
  if (!raw) return null;
  const entry = DOCS_CATALOG[raw];
  return canonicalPathForFile(entry ? entry.file : raw);
}

/** Katalog-Slug zu einer Datei (falls katalogisiert). */
export function slugForFile(file: string): string | null {
  for (const [slug, entry] of Object.entries(DOCS_CATALOG)) {
    if (normalizeSlashes(entry.file) === normalizeSlashes(file)) return slug;
  }
  return null;
}

/**
 * Slug für nicht katalogisierte Dateien: `docs/roadmap/STATUS.md` →
 * `roadmap-status`, `CHANGELOG.md` → `root-changelog`.
 *
 * Kollidiert das Ergebnis mit einem echten Katalog-Slug (möglich bei
 * gleichnamigen Dateien, z. B. `docs/CHANGELOG.md` vs. Katalog-Slug
 * `changelog` → Root-Datei), bekommt es das Präfix `docs-`. Zwei verschiedene
 * Dateien dürfen nie denselben Slug tragen.
 */
function fallbackSlug(file: string): string {
  const p = normalizeSlashes(file);
  const rel = p.startsWith("docs/") ? p.slice(5) : `${ROOT_DOC_SEGMENT}-${p}`;
  const slug = rel.replace(/\.md$/i, "").replace(/\//g, "-").toLowerCase();
  const clash = DOCS_CATALOG[slug];
  if (clash && normalizeSlashes(clash.file) !== p) return `docs-${slug}`;
  return slug;
}

function entryFor(file: string): DocsEntry {
  return { file, title: basename(file).replace(/\.md$/i, ""), subtitle: "" };
}

export type ResolvedDoc = {
  slug: string;
  entry: DocsEntry;
  /** Dateipfad relativ zum Projektstamm (z. B. `docs/ARCHITECTURE.md`). */
  file: string;
  /** Kanonische Browser-URL (z. B. `/docs/security/README.md`). */
  canonicalPath: string;
};

function build(file: string): ResolvedDoc | null {
  const canonicalPath = canonicalPathForFile(file);
  if (!canonicalPath) return null;
  const slug = slugForFile(file) ?? fallbackSlug(file);
  return { slug, entry: DOCS_CATALOG[slug] ?? entryFor(file), file, canonicalPath };
}

/**
 * Wie {@link resolveDoc}, akzeptiert zusätzlich eine kanonische URL
 * (`/docs/root/CHANGELOG.md`) — die Form, in der `DocsView` und die API-Route
 * ein Dokument anfordern. Der URL-Präfix wird vor der Auflösung entfernt;
 * die Traversal-Schranke aus {@link resolveDoc} bleibt unverändert wirksam.
 */
export function resolveDocRequest(name: string): ResolvedDoc | null {
  const raw = (name ?? "").trim();
  const stripped = raw.startsWith("/docs/") ? raw.slice("/docs/".length) : raw;
  // Next.js reicht URL-Segmente teils kodiert durch (`Security%20Review.md`).
  // Erst der Rohwert, dann segmentweise dekodiert probieren — ein kodiertes
  // `/` bleibt dabei innerhalb seines Segments.
  const decoded = stripped.split("/").map(decodePathSegment).join("/");
  return resolveDoc(stripped) ?? (decoded === stripped ? null : resolveDoc(decoded));
}

function existsFile(file: string): boolean {
  try {
    return existsSync(resolveRuntimePath(file)) && statSync(resolveRuntimePath(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Löst eine Anfrage zu einem Dokument auf.
 *
 * Eingaben (in dieser Reihenfolge):
 *   1. Katalog-Slug                    `security`, `auditFeatureGap`
 *   2. Pfad innerhalb von `docs/`      `audits/2026-09-18-feature-gap/README.md`
 *      (auch mit vorangestelltem `docs/`)
 *   3. Root-Datei                      `CHANGELOG.md` oder `root/CHANGELOG.md`
 *   4. Altlast-Fallback per Basename   `README.md`, `STATUS.md` (bekannte Unterordner)
 *
 * Schritt 4 existiert nur für alte Lesezeichen und handgetippte URLs. Er darf
 * **nie** vor Schritt 2 greifen — sonst liefert `audits/README.md` wieder
 * `docs/README.md` (Befund B5).
 */
export function resolveDoc(name: string): ResolvedDoc | null {
  const raw = (name ?? "").trim();
  if (!raw) return null;

  // 1) Katalog: exakter Slug.
  if (DOCS_CATALOG[raw]) {
    const entry = DOCS_CATALOG[raw];
    return build(entry.file);
  }

  // Altlast-Regel: `..`-Segmente werden grundsätzlich abgewiesen — auch dann,
  // wenn der normalisierte Pfad wieder innerhalb von docs/ landen würde.
  if (hasParentRef(raw)) return null;

  const normalized = normalizeSlashes(raw);
  const candidates: string[] = [];

  if (normalized.startsWith("docs/")) {
    candidates.push(normalized);
  } else if (normalized.startsWith(`${ROOT_DOC_SEGMENT}/`)) {
    // /docs/root/CHANGELOG.md → CHANGELOG.md
    candidates.push(normalized.slice(ROOT_DOC_SEGMENT.length + 1));
  } else if (normalized.includes("/")) {
    // 2) Pfad innerhalb von docs/
    candidates.push(`docs/${normalized}`);
  } else {
    // 3) Nackter Dateiname: docs/ zuerst, dann Repo-Root.
    candidates.push(`docs/${normalized}`, normalized);
  }

  for (const candidate of candidates) {
    if (!isServableDocFile(candidate)) continue;
    if (!existsFile(candidate)) continue;
    const resolved = build(candidate);
    if (resolved) return resolved;
  }

  // 4) Altlast-Fallback: nur der **nackte** Dateiname, gesucht in bekannten
  //    Unterordnern (Reihenfolge = Priorität; siehe tests/docsCatalog.test.ts).
  //    Enthielt die Anfrage einen Verzeichnisanteil, der nicht aufgelöst werden
  //    konnte, wird abgewiesen statt geraten: `tests/fixtures/golden/README.md`
  //    darf nicht lautlos `docs/README.md` liefern (Befund B5).
  if (normalized.includes("/")) return null;

  const safeBase = basename(normalized);
  if (!safeBase.endsWith(".md") || safeBase.includes("/") || safeBase === "..") return null;
  const searchPaths = [
    `docs/${safeBase}`,
    `docs/audits/${safeBase}`,
    `docs/peer-reviews/${safeBase}`,
    `docs/security/${safeBase}`,
    `docs/architecture/${safeBase}`,
    `docs/roadmap/${safeBase}`,
    `docs/archive/${safeBase}`,
    safeBase, // Root-Dateien wie CHANGELOG.md, CONFIGURATION.md
  ];
  for (const file of searchPaths) {
    if (!isServableDocFile(file)) continue;
    if (!existsFile(file)) continue;
    const resolved = build(file);
    if (resolved) return resolved;
  }

  return null;
}
