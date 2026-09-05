# Task 06 — Implementierungsplan: Daily/Weekly Agent Cycle & Orchestrierung

**Umfang:** Scheduler mit injizierbarer Clock · Step-Engine mit Retry-Policy & kontrolliertem Abbruch ·
8-stufige Tagesroutine mit harten Top-40-Code-Limits · Weekly Universe Review (CORE/ROTATION/DISCOVERY/EXCLUDED) ·
Versionierte Artefakte (`artifacts/YYYY-MM-DD/daily/`, `artifacts/YYYY-Www/weekly/`, `artifacts/index.json`) mit konfigurierbarer Retention ·
`MODEL_ESCALATION_REQUEST`-Event · Read-only API `/api/analysis/*` · Prompt-Injection-Schutz · Security-Audit · Docs.

---

## 1. RECON-Ergebnis & Pfadmapping

| Anforderung / Erwartung | Realität im Repository | Architektur-Entscheidung (Task 06) |
| --- | --- | --- |
| Task-04 (Market Scanner) | Gemerged in `src/scanner/` | `ScannerPort` delegiert direkt an `src/scanner/pipeline.ts` / `service.ts`; Stub-Implementierung für isolierte Tests vorhanden. |
| Task-05 (Portfolio Analytics) | Gemerged in `src/portfolio/` | `AnalyticsPort` nutzt `computeCorrelation`, `computeAllMetrics`, `optimizeWithGuard`; Stub für isolierte Tests vorhanden. |
| LLM-Provider | `src/lib/llmProvider.ts` (`chatLlm`) | `AnalysisAgentPort` abstrahiert Agenten-Aufrufe mit Schema-Validierung, Injection-Schutz und `MODEL_ESCALATION_REQUEST`-Handling. Fake-Port für deterministische Offline-Tests. |
| Branch `feature/task-06-daily-weekly-cycle` | Session fest gebunden auf `arena/01a044b9-ai-trading-firm` | Arbeit erfolgt auf dem Arena-Branch; Commits mit `(task-06)`; PR von Arena-Branch. |
| Neues Modul | Noch kein Zyklus-Modul vorhanden | **`src/cycle/`** als Orchestrierungs-Schicht; Endpunkte unter `src/app/api/analysis/`. |

---

## 2. Tages- und Wochen-Pipeline (Step-Übersicht)

| # | Step | Rolle | Zeitfenster | LLM? | Shortlist-Limit | Input / Output |
|---|---|---|---|---|---|---|
| 1 | **Market Scanner** | `MARKET_SCANNER` | 00:00–06:00 | **NEIN** (0) | Trichter 10k→2k→500→100→40 | In: Universe + Candles; Out: `ScanResult` (Daily Top 100, Deep Top 40) |
| 2 | **Macro Analyst** | `MACRO_ANALYST` | 06:00–07:00 | JA | 7 Assets | In: BTC, ETH, DXY, SPX, Nasdaq, Gold, Bonds + Volatilität; Out: Regime, Sentiment, Thesis |
| 3 | **Market Selection** | `MARKET_SELECTION` | 07:00–08:00 | JA | max. 40 Kandidaten | In: Daily/Deep Scan + Macro-Regime; Out: `DailyCandidateList` (Ranked Top-N, max 40) |
| 4 | **Technical Analyst** | `TECHNICAL_ANALYST` | 08:00–09:00 | JA | **NUR Top-40 (Code-Limit)** | In: Daily Candidate List (hart geklemmt auf ≤ 40); Out: Multi-Timeframe TA, Indikatoren, Setups |
| 5 | **News Analyst** | `NEWS_ANALYST` | 09:00–10:00 | JA | **NUR Top-40 (Code-Limit)** | In: Top-40 + Systemische Nachrichten (als reine Daten-Payloads); Out: Sentiment, Risk-Flags |
| 6 | **Risk Manager** | `RISK_MANAGER` | 10:00–11:00 | JA | max. 40 Kandidaten | In: Top-40 TA + News + Korrelationsmatrix + Portfolio Exposure; Out: Risk Assessment, Allocations |
| 7 | **Research** | `RESEARCH` | nach 10:00 | JA | gefilterte Setups | In: Valider Risk-Output; Out: Konkrete Setups (Entry/SL/TP/Thesis) — **NUR VORSCHLÄGE, KEINE ORDERS** |
| 8 | **Backtest-Verifikation** | `BACKTEST_VERIFICATION`| nach Research | **NEIN** (0) | Setups | In: Research-Setups + Historische Kerzen; Out: Sharpe, Sortino, MaxDD, Profit Factor, Robustness |
| W | **Weekly Universe Review**| `WEEKLY_REVIEW` | 1×/Woche | JA (Synthese) | Volles Universum | In: Changes (Listings, Fees, Liquidity, Regimes, Clusters); Out: CORE / ROTATION / DISCOVERY / EXCLUDED |

---

## 3. Ports & Schnittstellen

```text
               ┌────────────────────────┐
               │    Scheduler (Clock)   │ (injizierbar: SystemClock / SimulatedClock)
               └───────────┬────────────┘
                           ▼
               ┌────────────────────────┐
               │      Step-Engine       │ (Retry-Policy, Failure Abort, Escalation Event)
               └───────────┬────────────┘
                           │
      ┌────────────────────┼───────────────────┬─────────────────────┐
      ▼                    ▼                   ▼                     ▼
┌─────────────┐    ┌───────────────┐   ┌───────────────┐     ┌───────────────┐
│ ScannerPort │    │ AnalyticsPort │   │ AgentPort     │     │   AuditPort   │
│ (task-04)   │    │ (task-05)     │   │ (llmProvider) │     │ (DB + NDJSON) │
└─────────────┘    └───────────────┘   └───────────────┘     └───────────────┘
```

- **`ScannerPort`**: `runScan(asOf: Date): Promise<DailyUniverseArtifact | ScanResultSummary>`
- **`AnalyticsPort`**: `computeRiskAndExposure(symbols, returns, options): Promise<RiskAssessment>`
- **`AnalysisAgentPort`**: `invokeAgent<T>(spec: AgentInvocationSpec): Promise<AgentInvocationResult<T>>`
  - Behandelt Prompt-Injection-Schutz, JSON-Schema-Validierung, Schema-Fehlertoleranz (neutraler Fallback).
  - Emittiert bei Bedarf `MODEL_ESCALATION_REQUEST` { agent, reason, complexity, confidence }.
- **`CycleAuditPort`**: `logEvent(event: CycleAuditEvent): Promise<void>` (DB `audit_log` + dateibasierter Fallback).

---

## 4. Artefakt- und Speicher-Schema

```text
artifacts/
├── index.json                             Index aller Tages- und Wochenläufe (Manifest)
├── 2026-08-27/
│   └── daily/
│       ├── 01-market-scanner.json         ScanResult & Trichter
│       ├── 02-macro-analyst.json          Macro Regime & Cross-Market Snapshot
│       ├── 03-market-selection.json       Daily Candidate List
│       ├── 04-technical-analyst.json      Multi-Timeframe TA (max. 40 Instrumente)
│       ├── 05-news-analyst.json           News & Systemic Risk (max. 40 Instrumente)
│       ├── 06-risk-manager.json           Korrelationen, Exposure & Limits
│       ├── 07-research.json               Konkrete Setups (nur Vorschläge)
│       ├── 08-backtest-verification.json  Kennzahlen: Sharpe, Sortino, MaxDD, Profit Factor
│       └── daily-summary.json             Aggregierter Tageslauf mit Status & Metadaten
└── 2026-W35/
    └── weekly/
        ├── weekly-review.json             Vollständiger Review mit Changes & Context
        └── universe-classification.json   Klassifikation CORE / ROTATION / DISCOVERY / EXCLUDED
```

- **Atomare Writes**: `.tmp` + `renameSync`, JSON `null, 2`.
- **Retention**: Konfigurierbar (`retentionDays`, `retentionWeeks`), Pruning alter Verzeichnisse via `pruneArtifacts()`.

---

## 5. API-Schnittstelle (Read-only)

- `GET /api/analysis/daily/latest` — Letzter erfolgreicher oder aktueller Tageslauf inkl. Summary & Steps.
- `GET /api/analysis/daily/{date}` — Tageslauf für `YYYY-MM-DD` (404 bei Nicht-Existenz, 400 bei falschem Format).
- `GET /api/analysis/weekly/latest` — Jüngster Weekly Universe Review.
- `GET /api/analysis/runs` — Liste aller Durchläufe mit Paging (`page`, `pageSize`), Filter (`type=daily|weekly`, `status`), Laufzeit und Schritt-Status.

---

## 6. Harte Sicherheits- und Architektur-Garantien

1. **Keine Orders**: Kein Pfad im Zyklus importiert oder ruft Order-Funktionen auf (`placeOrder`, `executeOrder`). Setups sind rein informativ (`isProposal: true`).
2. **Shortlist-Limit**: Code-Prüfung `assertShortlistLimit(items, 40)`. Bei 41+ Instrumenten wird das 41. Instrument strikt abgewiesen bzw. ein Fehler geworfen.
3. **LLM-Freiheit des Scanners**: `src/cycle/steps/scannerStep.ts` importiert kein LLM-Modul (geprüft durch Architektur-Test).
4. **Prompt-Injection-Schutz**: News- und Broker-Texte werden strikt als Datenfelder im JSON serialisiert, niemals als Prompt-Anweisungen interpoliert. Agenten-Outputs werden gegen Zod/JSON-Schemas validiert; kaputte Outputs werden verworfen und neutral ersetzt.
5. **Eskalations-Event**: `MODEL_ESCALATION_REQUEST` wird erfasst und protokolliert; ohne Task-09 fällt das System transparent auf die Provider-Kette zurück.
6. **Fehlertoleranz**: Controlled Abort bei Step-Fehlern; bereits geschriebene Artefakte bleiben integer; Audit-Eintrag für Start, Ende, Step-Fehler.
7. **Coverage**: ≥ 90 % Zeilenabdeckung auf neuem Code (`tests/cycle.*.test.ts`).
