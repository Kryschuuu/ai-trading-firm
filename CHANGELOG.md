# Changelog — Autonome KI-Trading-Firma

> **Status-Header:** Konsolidierter Überblick · **2026-09-22** · Code-Version **1.65.0**. Vollständige, detaillierte Einträge je Release (Keep a Changelog + SemVer) — kanonische Datei im Root (ehemals `docs/CHANGELOG.md` als Duplikat, jetzt konsolidiert).

# Changelog — Autonome KI-Trading-Firma

Alle für Nutzer sichtbaren Änderungen an der Handelsplattform `ai-trading-firm`
werden in dieser Datei dokumentiert.

Das Format basiert auf
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die Versionierung folgt
[SemVer](https://semver.org/lang/de/).

## [1.65.0] — 2026-09-22 · Prompt-Performance & Version-Metrikvergleich (RMA-P3-02)

### Hinzugefügt

- **Prompt-Artefakt: Kanonisierung + immutables `promptHash` + Rolle/Template-Schema (`src/promptPerformance/canonical.ts`, `src/db/schema.ts` + `drizzle/2026-09-22_prompt_performance.sql`, `src/promptPerformance/store.ts`):** LF-Kanonisierung (`\r\n`/`\r`→`\n`, sonst byte-identisch), deterministischer Hash `pp1:<sha256>` (Pflicht-Test LF-Stabilität + inhaltliche Änderung ⇒ anderer Hash), immutables Artefakt je `(agentId, version)` (Wiederverwendung anderer Version mit gleichem Inhalt ⇒ vorhandenes Artefakt + `prompt_artifact_duplicate_content`, Versionskonflikt mit anderem Inhalt ⇒ `VERSION_CONFLICT` fail-closed) + Version aus `agents.version`, `role` (bounded, ≤64) und `templateSchemaVersion` (Default `1`, ≤16). Append-only-Migration (idempotent): `prompt_artifacts` mit zwei UNIQUE-Indizes (`agent_id, version` + `agent_id, prompt_hash`), Hash-Regex-CHECK `^pp1:[0-9a-f]{64}$`, Trigger sperren `UPDATE`/`DELETE`/`TRUNCATE` (wie `feature_store`/`perpdata`). Unbekannte historische Versionen sind sichtbar `UNKNOWN` (`promptHash="UNKNOWN"`, `promptVersion=null`, nie `0`).
- **Run-Provenanz je Agentenaufruf (`src/promptPerformance/provenance.ts`, Hook in `src/lib/engine.ts:runAgentTurn`):** Jeder `localReason`-Aufruf (Erfolg oder `fallback`) persistiert atomar `resolveArtifactIdempotent` → `emitAgentRun` in `agent_prompt_runs`: **genau ein** Artefakt (oder `UNKNOWN`), `provider`/`model`/`temperature`/`maxTokens`/`toolSchemaVersion` (nie Secrets), `startedAt`/`endedAt`/`latencyMs` (**ms**), `promptTokens`/`completionTokens`/`totalTokens` (**count**, `NULL` nie `0`), `costUsd` (**USD**) + `costStatus` (`billed|free|unknown`), `success`/`errorCode` (bounded ≤64). Idempotenz über `idempotencyKey` `pr1:<sha256(json({ph,aid,ts,model,att}))>` (stabile Retries/Restarts ⇒ bestehende Zeile, `23505`⇒ Re-Read, kein Doppel-Run). Fail-closed statt Trade-Stopp: Provenanz-Fehler werden gefangen, geloggt (`prompt_provenance_failed`) und lassen den Turn weiterlaufen (Hold-Entscheidung); nur Artefakt-Konflikt ist hart.
- **Outcome-Join via `promptVersion` zu P3.1-Resolutions + P1.6-Attribution (`src/promptPerformance/metrics.ts`):** Forecasts werden nur über jüngste `forecast_resolutions` je Forecast ausgewertet (`PENDING` **nie** als Gewinn/Verlust — Coverage sichtbar, Brier/ECE nur `RESOLVED`, `VOID` nur Coverage; `PENDING`≠fehlgeschlagen), Trades über `trade_attributions(methodVersion=1,status=ATTRIBUTED)` + `trade_attribution_entries(source_type='AGENT',source_version='<promptVersion>')` (P1.6 `ta1`, bounded ≤2000/Chunk 250). `UNKNOWN`-Version ⇒ Attribution `null` (Lücke sichtbar, kein Raten).
- **Metriken je Version mit Unsicherheit & Segmentierung (`src/promptPerformance/metrics.ts`, `src/promptPerformance/compare.ts`):** `getPromptVersionMetrics(filter)` liefert PIT-korrekt (Filter nur `forecasts.asOf`/`agent_prompt_runs.startedAt`, nie `createdAt`/`computedAt`; falsche Chronologie ⇒ `INVALID_TIME_WINDOW`), bounded (Forecasts ≤20 000, Runs ≤5 000, `minSample` 5…1000 Default 30) und voll instrumentiert: **Brier** `mean((p−y)²)` + SE `√(Brier·(1−Brier)/n)` + 95 %-CI + **BSS** `1−Brier/0.25`, **LogLoss** (ε 1e-6), **HitRate** + Wilson-95 % (`z=1.96`), **ECE** (10 Buckets, gewichtetes `|mean−observed|`), **Reliability** je Bucket (count/mean/observed + Wilson), **Coverage** `(resolved+void)/total` (oder `null`), **Abstention** `null` (P3.1 hat kein Flag — nie erfunden), **Latency** `avg/p50/p95` (lineare Interpolation, ms), **Tokens** `totalPrompt/totalCompletion/total/avgPerRun` (count), **Kosten** `totalUsd/avgUsd/billedRuns/freeRuns` (USD), **Attribution** `attributedPnl/tradeCount/avgContribution/maxDrawdown` (kumulierter Drawdown in `closedAt`-Reihenfolge, ≤0, `0` bei 1 Trade, `null` ohne Trades). `status` `ok`⇔`n≥minSample`, sonst `insufficient-sample` (nie still). Antwort trägt immer `units: {latency:"ms",tokens:"count",cost:"USD"}` + `notes`.
- **Fairer Vergleich: identische Filter + Coverage + Human-Gate (`src/promptPerformance/compare.ts`):** `comparePromptVersions({baseline,candidate, …})` erzwingt identische `{fromAsOf,toAsOf,horizonId,entityId,regime,agentRole}` über beide Versionen (Abweichung ⇒ `MISMATCHED_FILTERS` 400; `baseline==candidate` ⇒ `SAME_VERSION`), meldet `provenance: {identicalFilters:true,coverageReported:true}` + `warnings` (einseitig geringe Coverage, `PENDING`-Dominanz), und liefert `recommendation: {recommend: candidate|baseline|null, status:"GATED", gateRequired:true, humanReviewRequired:true}` — **immer gated** (Operator-/PR-Gate, nie auto-promote). **ECE-Wächter:** verschlechtert `candidate` die Kalibrierung um ≥0.02 (ECE), bleibt `recommend` bei `baseline` (PnL allein gewinnt nie).
- **Privatsphäre/Retention & Observability:** Prompt-Text nur autorisiert (nie in Metriken/Labels), Metriken nutzen ausschließlich bounded Labels (`telemetry.prompt.artifacts{result}`, `runs{result,provider}`, `queries{result}` — nie Prompt-/Instrument-IDs), keine Secrets/PII/Rohtranskripte in `agent_prompt_runs`. Retention append-only (kein TTL; Löschung = manueller `DROP`-Entscheid). Strukturierte Logs `prompt_artifact_created`/`prompt_artifact_duplicate_content`/`prompt_provenance_failed` (nur Version+Grund).
- **Produktions-APIs (bounded, `firm.read`, `no-store`, `X-Truncated`):** `GET /api/firm/prompts/artifacts` (Agent/Rolle, `limit`≤200, `offset`), `GET /api/firm/prompts/runs` (Rolle/`promptVersion`/`promptHash`/Agent, `from`/`to` ISO `from<to`, `limit`≤5000 — je Zeile `artifactId` oder `UNKNOWN`; 400 `INVALID_TIME_WINDOW`/`INVALID_PROMPT_VERSION`, 503 `PROMPT_LEDGER_UNAVAILABLE`), `GET /api/firm/prompts/metrics` (Version `int` oder `UNKNOWN`, Horizon ∈{4h,24h,72h} 400, Regime-Whitelist 400, `minSample`/`limit`, Antwort `PromptVersionMetrics` + `units`/`notes`), `GET /api/firm/prompts/compare` (baseline≠candidate, identische Filter, Gate-Empfehlung). Alle bounded, nie unlimitiert.
- **Dokumentation:** neues [`docs/PROMPT_PERFORMANCE.md`](docs/PROMPT_PERFORMANCE.md) (Artefakt/Provenanz/Join/Metriken-Vergleich-Formeln/Einheiten/Zeitsemantik/API/Migration-Rollback/Observability), `CONFIGURATION.md` (§ Prompt-Performance, Flag-Tabelle), `.env.example`, Produkt-Update in `README.md`/`docs/README.md`.
- **Tests (Pflicht-Matrix, vgl. `docs/PROMPT_PERFORMANCE.md` §11):** `tests/promptPerformance.canonical.test.ts` (LF-Stabilität, Hash-Änderung), `tests/promptPerformance.store.test.ts` (exakt ein Artefakt, Secrets nie persistiert, negative/invalide Pfade), `tests/promptPerformance.metrics.test.ts` (PENDING≠win/loss, Coverage, Horizon/Regime-Whitelist, Zeitfenster), `tests/promptPerformance.compare.test.ts` (identische Filter + Coverage gemeldet, `SAME_VERSION`/`MISMATCHED_FILTERS`, ECE-Guard), `tests/promptPerformance.db.test.ts` (embedded Postgres: Migration idempotent, Roundtrip, Idempotenz Retry×3, Restart frischer Pool, Append-only-Trigger). Zusätzlich API-Verträge `tests/promptPerformance.api.test.ts` (truncated, units ms/tokens/USD, bounded limits).

### Konfiguration

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `PROMPT_PERFORMANCE_ENABLED` | `true` | Artefakt- + Provenanz-Schreibpfad an/aus. `false` unterdrückt `ensurePromptArtifact`+`recordPromptRun` (`DISABLED`, sofort gefangen — Turn läuft trotzdem), bestehende Zeilen bleiben lesbar (sofortiger Rollback). Nur exakt `false`/`0` schaltet ab; unbekannte Werte ⇒ an. |

Migration: `psql "$DATABASE_URL" -f drizzle/2026-09-22_prompt_performance.sql` **oder** `npx drizzle-kit push` (idempotent, append-only — zweifacher Lauf sicher). Rollback: `PROMPT_PERFORMANCE_ENABLED=false` (sofort, Zeilen bleiben), alternativ Redeploy auf v1.64.0 (Tabellen bleiben harmlos ignoriert), Bereinigung nur explizit `DROP TABLE agent_prompt_runs, prompt_artifacts` nach Verifikation.

### Kompatibilität

- Vollständig additiv & rückwärtskompatibel: neue Tabellen/APIs/Docs, keine Änderungen an bestehenden Tabellen/Spalten/Scores. Engine/Pipeline, Risk-Ceilings, Kill-Switches, Authority Chains und Live-Gate unverändert (einziger neuer Hook ist der Provenanz-Call im Engine-Turn, fehlertolerant). Unbelegte/fork: `UNKNOWN` statt stiller `0`-Version. Rollback siehe oben.

## [1.64.0] — 2026-09-22 · Kalibrierbare strukturierte Sentiment-Outputs (RMA-P2-05)

### Hinzugefügt

- **Strukturiertes Sentiment-Modul `src/sentiment/` (Code-Version `sentiment@1`, Schemavariante `v1`):** kalibrierbare strukturierte Sentiment-Outputs (`StructuredSentimentForecast`) mit expliziter Horizont-, Event-, Quellen- und Unsicherheitssemantik. Strikte Trennung von direktionaler Wahrscheinlichkeit (`probability` ∈ [0.01, 0.99]) und Quellenabdeckung (`coverage` ∈ [0, 1]).
- **Strikte Unterscheidung von `NEUTRAL` und `ABSTAIN`:** Liegen valide, ausgewogene Nachrichten vor, meldet der Forecast `status: "ACTIVE"` mit Richtung `"NEUTRAL"` und `probability: 0.50`. Liegen keine oder veraltete Quellen vor, wird zwingend der Fail-Closed-Status `status: "ABSTAIN"` mit `coverage: 0`, `probability: null` und explizitem `abstainReason` (`NO_SOURCES`, `STALE_SOURCES`) gemeldet — keine Schein-Neutralität bei Informationsmangel.
- **Syndikations-Deduplikation & Paraphrasen-Erkennung (`deduplicateNewsSources`):** Bereinigung von Feed-Zusätzen (`[CoinDesk]`, `(Reuters)` etc.), Normalisierung, Content-Fingerprinting (SHA-256) und Paraphrasen-Erkennung (Token-Jaccard ≥ 0.80 im gleitenden 24h-Fenster). Syndizierte Wire-Meldungen über mehrere Feeds erhöhen den `syndicationCount`, werden jedoch als genau eine Quelle gewertet, um künstliche Konfidenzblähung zu verhindern.
- **Multi-Entity-Isolation:** Übergreifende Meldungen werden allen betroffenen Entitäten isoliert mit eigener kanonischer `entityId` und deterministischer `forecastId` zugeordnet.
- **Deterministische Identität & Idempotenz:** Snapshot-ID `sf1:<sha256(schemaVersion|model|asOf|entityId|dedupHash)>` (`sf1:`, `sd1:`, `sc1:`). Idempotente und append-only Datenbank-Migration [`drizzle/2026-09-22_structured_sentiment.sql`](drizzle/2026-09-22_structured_sentiment.sql) für `sentiment_forecasts` mit `ON CONFLICT (forecast_id) DO NOTHING` und DB CHECK-Constraints für Wahrscheinlichkeitsgrenzen, Zeit-Invariante (`valid_until > as_of`) und Status-Konsistenz.
- **Outcome-Link zum P3.1-Forecast-Ledger:** Verknüpfung über `buildP31ForecastPayload()` zur späteren Auswertung über Brier-Score und Proper Scoring Rules — strukturell ohne Speicherung des aktuellen Kurses oder späterer Marktergebnisse beim Erzeugen des Forecasts.
- **Zyklus- & Analysten-Integration:** Step 5 (`newsStep`) und Hubble (`runNewsAnalyst`, `recordAnalysis`) erzeugen nun vollständige Forecast-Envelopes. Bestehende Felder (`sentiment`, `confidence`, `summary`, `riskFlags`) bleiben rückwärtskompatibel erhalten.
- **API & Observability:** Read-only Endpunkt `GET /api/analysis/sentiment` mit Parameter-Validierung (`entityId`, `status`, `horizon`, `from`, `to`, `limit`), no-store-Caching sowie bounded Metriken `sentiment_runs_total{result,source}` und strukturierten Audit-Events `sentiment_forecast_persisted`.
- **Tests (35 neue Tests):** `tests/sentiment.unit.test.ts` (20 Tests: Deduplikation, Multi-Entity, NEUTRAL vs. ABSTAIN, Wahrscheinlichkeiten, PIT-Invarianz, Injection-Schutz, P3.1-Link, Bounds), `tests/sentiment.db.test.ts` (5 Tests: Migration, Roundtrip, Idempotenz, CHECK-Constraints, Filterung gegen Embedded Postgres), `tests/sentiment.cycle.test.ts` (3 Tests: Step-Anreicherung, Fallback-Envelopes, Risk-Manager-Konsum), `tests/sentiment.api.test.ts` (7 Tests: GET-Endpunkt, Statuscodes, Parameter-Validierung, Cache-Control).
- **Dokumentation:** [`docs/SENTIMENT.md`](docs/SENTIMENT.md), Aktualisierung von `docs/HANDBUCH.md`, `docs/DAILY_WEEKLY_RESEARCH.md`, `CONFIGURATION.md`, `TRACKING.md` und Finding `RMA-P2-05-structured-sentiment.md`.

### Konfiguration

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `STRUCTURED_SENTIMENT_ENABLED` | `true` | Persistenz strukturierter Sentiment-Outputs an/aus. Bei `false` wird die Persistenz übersprungen; der Zyklus läuft im Speicher weiter (Rollback-Pfad). |

### Kompatibilität

- Vollständig rückwärtskompatibel: bestehende Konsumenten lesen weiterhin `sentiment`, `confidence`, `summary` und `riskFlags`. Keine Änderungen an bestehenden Tabellen. Rollback durch `STRUCTURED_SENTIMENT_ENABLED=false` sofort möglich.

## [1.63.0] — 2026-09-22 · Point-in-Time Cross-Sectional Momentum Ranking (RMA-P2-04)

### Hinzugefügt

- **Cross-Sectional-Modul `src/crossSectional/` (Code-Version `cross-sectional@1`, Config v1):** universumsweites, as-of-sicheres Momentum-Ranking als reine Funktion aus (Kandidaten, Kerzen, as-of, Config, Code-Version) — kein LLM, kein Netzwerk, keine Orders. Pipeline: Universe-Eligibility (Registry, geschlossene Exclusion-Gründe `INACTIVE`…`INVALID_INPUT`) → Momentum-Renditen über versionierte Horizonte (Default `h72`/`h168`/`h336` auf dem 1h-Raster, Gewichte 0.2/0.3/0.5, optionaler Skip-Period) → Querschnitt (Winsorize [0.01, 0.99] → z-Score → gewichtetes Composite → Rang mit kanonischem ID-Tie-Break, Perzentil `(n−rank+1)/n`) → Snapshot mit Provenance.
- **Point-in-Time ohne Look-ahead (Policy `ingested`):** eine Kerze fließt nur ein, wenn sie geschlossen **und** zu ihrem Ingestionszeitpunkt verfügbar war (`barEnd ≤ asOf` **und** `fetchedAt ≤ asOf`). Späterer Backfill (`fetchedAt > asOf`) ist für alle früheren as-of-Zeitpunkte strukturell unsichtbar — historische Snapshots ändern sich durch spätere Daten nie (getestet). `computedAt` und der Idempotenz-Key sind von der Datenverfügbarkeit getrennt.
- **Deterministische Identität & Persistenz:** Snapshot-ID `xs1:<sha256(v1|timeframe|asOfMs|universeHash|dataHash|configHash|codeVersion)>` (`xu1:`/`xd1:`/`xc1:`-Hashes); gleicher fachlicher Key ⇒ gleiche ID, Idempotenz-Key = 64-hex. Append-only, zweifach anwendbare Migration [`drizzle/2026-09-22_cross_sectional_ranking.sql`](drizzle/2026-09-22_cross_sectional_ranking.sql): `cross_sectional_snapshots` (Provenance, Coverage ≤ 1 via CHECK, Exclusion-Counts, Survivorship-Note, Stabilität) + `cross_sectional_rankings` (je Mitglied eine Zeile, `value_hash`-Konflikt-Guard: abweichende Zeilen werden protokolliert, **nie** überschrieben — fail-closed). PIT-Load (`as_of ≤ asOf`), Stabilität/Turnover gegen den Vorgänger (Top-K-Overlap, Rank-Shift, Common-Count, Default Top-K 10), Retention-Pruning mit FK-Cascade (keine Orphane). Parallel dazu deterministische Datei-Artefakte `artifacts/cross-sectional/YYYY-MM-DD/<snapshotId>.json` (atomar, nicht in Git) als Cross-Prozess-Medium der Scanner-Integration.
- **Scanner-Integration (additiv, Gewicht 0):** neuer Diagnose-Faktor `crossSectionalMomentum` (einer von 15): `normalized = percentile`, `raw = composite`, Provenienz im Detail. Explizites `unavailable` (Neutralwert 0.5, `raw: null`) ohne Snapshot/stale/Feature-Flag aus — ein fehlender Rang geht **nie** still als 0-Momentum ein. Dokumentierte Gewichtsentscheidung: Score-Gewicht 0 (wie `atr`/`rsi`/`funding`); die gewichtete Momentum-Komponente bleibt der instrument-lokale Faktor `momentum` — Scanner-Scan mit/ohne Cross-Sectional-Karte erzeugt **identische Scores/Breakdowns** (getestet, kein stilles Doppeltzählen). Der Scanner führt keine I/O dafür selbst aus; der Web-Prozess liest das jüngste Artefakt (Staleness ≤ `maxSnapshotAgeMs`, Default 7 Tage).
- **CLI & API:** `npm run research:cross-sectional` (`--as-of=<ISO>`, `--dry`, `--top=N`; Exit 0 = Snapshot mit ≥ 1 geranktem Instrument bzw. Flag aus, 1 = harter Fehler oder 0 gerankte Instrumente — der Zustand wird persistiert und laut gemeldet). Read-only `GET /api/research/cross-sectional` (PIT über `?asOf`, `?instrumentId`, `?timeframe`, `?top` 1…200, `?exclusions`): 200 mit Snapshot+Items+Member bzw. `NO_SNAPSHOT`, 400 `VALIDATION_ERROR`, 503 `STORAGE_UNAVAILABLE` (generisch).
- **Observability (bounded):** Metriken `cross_sectional_runs_total{result}`, `cross_sectional_persist_total{persist}`, `cross_sectional_rank_conflicts_total` — ausschließlich Code-konstante Labels, **keine** Instrument-/Snapshot-IDs; IDs und Details stehen in den strukturierten Audit-Events `cross_sectional_snapshot_persisted` und `cross_sectional_ranking_conflict`.
- **Tests (50 neue):** `tests/crossSectional.unit.test.ts` (22: exakte Rang-/Perzentil-Fixtures, Permutationsinvarianz, Look-ahead/Late-Backfill-Invarianz, Eligibility-Gründe, Degeneration, Winsorize/z-/volAdjusted-Formeln, Artefakt-Roundtrip/Byte-Identität), `tests/crossSectional.db.test.ts` (8, eingebettete Postgres: Migration zweifach idempotent, Roundtrip/Zeitsemantik, Idempotenz Retry ×3, Restart frischer Pool, PIT-Sichtbarkeit, CHECK-Constraints, Konflikt-Guard, Stabilität, Retention+Orphan-Check), `tests/crossSectional.api.test.ts` (16: 400-Verträge, NO_SNAPSHOT-Form, Antwort-Aufbau, HTTP-Pfad gegen eingebettete Postgres inkl. PIT über `?asOf`), `tests/crossSectional.scanner.test.ts` (4: explizites Unavailable 0.5 nie 0, Provenienz, **Score-Invarianz bei Gewicht 0**).
- **Dokumentation:** neues [`docs/CROSS_SECTIONAL_RANKING.md`](docs/CROSS_SECTIONAL_RANKING.md) (Architektur, Zeitsemantik, Eligibility-Tabelle, Formeln, Identität/Persistenz/Idempotenz, Scanner-Integration, Operations, Monitoring, Testmatrix, dokumentierte Grenzen), `CONFIGURATION.md` (§ Cross-Sectional), `.env.example`, `README.md`, `docs/README.md`.

### Konfiguration

| Flag | Default |
| --- | --- |
| `CROSS_SECTIONAL_ENABLED` | `true` (Rollback: `false` ⇒ exaktes Vor-Verhalten des Scanner-Pfads) |
| `CROSS_SECTIONAL_CONFIG_FILE` | `—` (JSON-Config, validierte Overrides; ungültig ⇒ harter Fehler `CROSS_SECTIONAL_CONFIG_ERROR`) |

### Kompatibilität

- Rein additiv: neue Tabellen (append-only Migration, idempotent), neues optionales Scanner-Faktor-Detail, neue read-only-API, neue bounded Metriken/Audit-Events. **Keine Änderungen an bestehenden Tabellen, Patches oder Scores** — der Market Score ist nachweislich unverändert (Gewicht 0). Rollback: Redeploy auf v1.62.0 ODER `CROSS_SECTIONAL_ENABLED=false` (Scanner-Pfad) — Persistierte Snapshots bleiben lesbar/harmlos.
- Bekannte, dokumentierte Grenzen: Survivorship-Bias (Universum aus der aktuellen Registry; Survivorship-Note je Snapshot; bias-freie Rekonstruktion out of scope), < 2 rankbare Mitglieder ⇒ `CROSS_SECTION_DEGENERATE` (σ undefined), kein Order-Pfad.

## [1.62.0] — 2026-09-22 · Deterministische Multi-Timeframe-Konfluenz (RMA-P2-03)

### Hinzugefügt

- **Konfluenzmodul `src/confluence/` (Formel `mtf-confluence@1`, Config v1):** eine einzige reine Funktion (`computeConfluence`) beantwortet, ob die konfigurierten Timeframes (Default 15m/1h/4h, Gewichte 0.2/0.3/0.5) zum Entscheidungszeitpunkt gleichgerichtet sind — kein LLM, keine Uhr, kein Zufall. Je Timeframe drei bounded, warmup-geprüfte Features (Trend = normalisierte EMA-Lücke, Momentum = gewichtete Rate-of-Change, Volatilität = ATR-Anteil; Warmup 22 Bars), danach Coverage, Richtung, Stärke, Konflikt (gewichtete mittlere Abweichung), Confidence (`coverage × (1 − conflict) × volFactor`) und Status (`OK`/`DEGRADED`/`ABSTAIN`).
- **As-of-Ausrichtung ohne Look-ahead:** nur Kerzen mit `barEnd ≤ asOf` **und** `availableAt ≤ asOf` fließen ein — die noch offene HTF-Kerze und späterer Backfill (`fetchedAt > asOf`) sind strukturell ausgeschlossen. Stale-Reihen (> 2 Perioden), invalide Kerzen, Warmup-Mangel und fehlende Reihen melden geschlossene Gründe (`stale`/`invalid`/`warmup`/`no-closed-bars`/`unavailable`).
- **Fail-closed-Aggregation:** unter `minCoverage` (0.5) ist das Signal `null` (nicht `0`), `confidence` exakt `0`; fehlende Timeframes re-normalisieren nur oberhalb der Mindestcoverage und senken die Confidence strikt. Jede Outputzahl ist auf `contributions[]` (Gewichte, Richtung, Features, `barEndMs`, `barsUsed`) und `missing[]` zurückführbar; `snapshotKey` (`mtf1:<sha256>`) ist der stabile Idempotency-Schlüssel für Retries/Restarts.
- **Versionierte Config (`src/confluence/config.ts`):** 1–5 Timeframes (Allowlist, eindeutig), Gewichtssumme exakt 1, bounded Schwellen/Perioden, Warmup ≤ `maxBars`; Datei-Override via `CONFLUENCE_CONFIG_FILE` (ungültig ⇒ harter Fehler), Schalter `CONFLUENCE_ENABLED` (Default `true`, Rollback-Pfad). Gewichte stammen ausschließlich aus der Config — keine Runtime-Prompt-Manipulation.
- **Zyklus-Integration (Trusted-Data):** der technische Step rechnet je Kandidat (max. 40, Store-Batch mit einer Datei-Ladung) VOR dem LLM einen Snapshot, übergibt ihn als GETRENNTEN `trustedData`-Block (`AgentInvocationSpec.trustedData`, Rendering in `ports.ts`) und hängt ihn NACH der Validierung serverseitig an (`analysis.confluence`, `confluenceMeta` in `04-technical-analyst.json`). Die Schema-Validierung verwirft LLM-seitige `confluence`-Felder strukturell — das Modell erläutert, überschreibt aber nie.
- **Analyst-Integration:** `runTechnicalAnalyst` nutzt dieselbe pure Funktion über den Live-Kerzen-Adapter (Promptblock + `agentMessages.meta.confluence`, additiv). Scanner/Backtest teilen die Funktion über die Adapter; die Scanner-Gesamtrangfolge bleibt unverändert.
- **Observability:** bounded Metrik `confluence_runs_total{result,source}` (keine Instrument-IDs als Label) und strukturiertes Audit-Event `confluence_computed` (Status, Richtung, Confidence/Coverage/Konflikt, Versionen, Snapshot-Key; `ABSTAIN` = `warn`).
- **Tests (38 neue):** `tests/confluence.unit.test.ts` (22: Features/Bounds/Warmup, offene HTF-Bar, PIT-Verfügbarkeit, gleich-/gegenläufig/fehlend, Reihenfolge-Invarianz, stale/warmup/invalid/no-closed-bars, Key-Stabilität, Determinismus, Golden-Fixture, Config-Bounds, LLM-Override-Schutz, Trusted-Block), `tests/confluence.adapters.test.ts` (10: Store-Batch, Backtest-/Live-Parität, Analyst-Adapter, ABSTAIN-Batch, PIT-Backfill, Retry-Idempotenz, Telemetrie-Labels, Audit-Event, Roundtrip, Store-Look-ahead-Guard), `tests/confluence.cycle.test.ts` (6: Step-Anhängung, Override-Ersetzung, Fallback, ABSTAIN-Sichtbarkeit, Flag-Pfad, Artefakt-Roundtrip) plus Golden-Fixture `tests/fixtures/confluence-golden.json`.
- **Dokumentation:** neues [`docs/MTF_CONFLUENCE.md`](docs/MTF_CONFLUENCE.md) (Architektur, Zeitsemantik, Formeln/Einheiten, Fallbacks, Trusted-Data, Konfiguration, Observability, Migration/Rollback), `CONFIGURATION.md` (§ MTF-Konfluenz), `.env.example`, `docs/README.md`.

### Kompatibilität

- Rein additiv: neue optionale Felder (`confluence`, `confluenceMeta`, `trustedData`), neue bounded Metrik, neues Audit-Event. **Keine DB-Migration erforderlich** (Persistenz über versionierte Zyklus-Artefakte + `agentMessages.meta`); Alt-Artefakte ohne Snapshot bleiben lesbar. Scanner-Ranking, Risk-Ceilings, Kill-Switches, Authority Chains und Live-Gates sind unberührt. Rollback: Redeploy ODER `CONFLUENCE_ENABLED=false` (Legacy-Output ohne Code-Änderung).

### Bewusst nicht Teil (Scope-Grenze PROMPT-P2-03)

Kein LLM-Modelltraining, kein Ersatz der Scanner-Gesamtrangfolge, keine
Nutzung unvollständiger höherer Timeframekerzen.

## [1.61.0] — 2026-09-22 · Mehrdimensionale, point-in-time-sichere Regime-Erkennung (RMA-P2-01)

### Hinzugefügt

- **Versionierter Feature-Vertrag (`src/lib/regimeFeatures.ts`, `regime-features@1`):** Preis-, Volatilitäts-, Liquiditäts-, Perp- und optionale Makro-Familien mit Zeitsemantik (`eventTime`, `availableAt`, `computedAt` getrennt), Kein-Ersatz-Regeln (stale/invalid/missing bleiben `MISSING`/`STALE`) und Coverage-Gewichten (0.3/0.3/0.2/0.2). Rein und client-sicher.
- **Multidimensionale Klassifikation (`classifyMarketRegimeMultidim`):** Ergänzt den OHLCV-Kern um Voting-Familien (Spread/Funding/OI/VIX → ausschließlich zum sichereren `HIGH_VOL`), liefert Roh- und bestätigte Klasse mit Confidence [0.2, 0.99] (`null` bei `UNKNOWN`), Coverage, Top-Treibern und Feature-/Modellversion (`regime-rules@1`). `REGIME_FEATURE_MODE=multidim|ohlcv` erzwingt optional den Legacy-Pfad.
- **Point-in-time-sichere Live-Loader (`src/lib/regimeFamilyInputs.ts`):** Spread-Cache, Perp-Cache (nur `PERP_DATA_ENABLED=true`) und adaptiver VIX-Zustand, fail-soft (nie werfend), ohne FS-/DB-Importe im Kernpfad; externe Samples nur bei `eventTime ≤ asOf` **und** `availableAt ≤ asOf` (Backtest sieht keine später verfügbaren Makro-/Perp-Daten).
- **Persistenz & Evaluation:** append-only Migration `drizzle/2026-09-22_regime_snapshots.sql` (Tabelle `regime_snapshots`, CHECK-Constraints, Idempotenz-Schlüssel = SHA-256), `src/lib/regimeSnapshotStore.ts` (ON-CONFLICT-Write, Throttle 15 min/Regime-Wechsel, Retention `REGIME_SNAPSHOT_RETENTION_DAYS=90`, fail-soft mit Telemetrie), `src/lib/regimeEvaluation.ts` (Stabilität/Transitions/Confidence/Coverage/bestätigte-vs-Roh-Vergleiche, OOS ohne Null-Substitution) und CLI `npm run regime:eval` (`scripts/regime-eval.ts`, Report nach `data/regime-eval/`, Exit 1 bei Store-Fehlern).
- **Tests:** `tests/regimeMultidim.test.ts` (37 Fälle: Feature-Fixture→Klasse/Confidence/Treiber, Stale→Coverage-↓ ohne Risiko-↑, Determinismus, Flapping, OHLCV-Parität, Artefakt-Schema v2, Loader, Bounds, Evaluation) und `tests/regimeSnapshot.db.test.ts` (7 Fälle: Migration idempotent, Roundtrip, Retry/Restart-Eindeutigkeit, Constraints, Retention gegen eingebettete Postgres).

### Geändert

- **Ein Snapshot für alle Konsumenten:** Engine-Turn, Monitor-Tick, Mikro-Executor-Seed und Candidate-Refresh rufen dieselbe `evaluateInstrumentRegime`; `resolveRegimeGateForExecution`/`formatRegimeGateContext` weisen Coverage/Degraded/Confidence/Versionen aus. `REGIME_CHANGE`-Audit trägt `conf/cov/feature_version/model_version/families`; `REGIME_GATE_APPLIED` zusätzlich `coverage/degraded`; Ops-Center zeigt `Regime · Conf · Cov % · degraded`.
- **Gate-Sicherheitsregel:** Coverage < `REGIME_MIN_COVERAGE` (0.5) blockiert Boosts (`applyRegimeGate` nie über 1 bei Degraded/geringer Coverage) — geringe Coverage erhöht das Risiko strukturell nie.
- **`regime-history.json` Schema-Version 2** (rohe + bestätigte Klasse, Confidence, Coverage, Degraded, Feature-/Modellversion, Familienstatus je Zeile; Abwärtskompatibel über erweiterte Felder).
- **Dokumentation:** `docs/REGIME_GATE.md` (neue §1b Feature-/Coverage-/Persistenz-Abschnitte), `CONFIGURATION.md` (sieben neue Regime-Flags), `.env.example`, `docs/HANDBUCH.md` §9.4.

### Bewusst nicht Teil (Scope-Grenze PROMPT-P2-01)

Unversioniertes Online-Training, Ersetzen harter Risiko-Ceilings durch
Modell-Wahrscheinlichkeiten und ein Pflicht-Makro-Datenabruf.

## [1.60.0] — 2026-09-22 · Train-Select-Freeze-Test Walk-Forward (RMA-P1-02)

### Hinzugefügt

- **Candidate Contract & Validation (`src/backtest/walkforward.ts`):** Definiert beschränkte Walk-Forward-Kandidaten mit stabiler ID, Strategie-/Regel-Version und serialisierbarer Config (`WalkForwardCandidate`). Die Validierung (`validateCandidates`) erzwingt strikt 1..100 Kandidaten, eindeutige IDs, unlösbare NaN/Infinity-Werte abzuweisen und verhindert unbegrenzte Suchräume (`walkforward:unbounded-candidate-space`, `walkforward:invalid-candidate-config`).
- **IS-Selector & Deterministic Tie-Breaking (`selectBestCandidate`):** Ausgewählt wird ausschließlich auf In-Sample (IS) Daten basierend auf konfigurierbaren Zielmetriken (`targetMetric`: Sharpe Ratio, Sortino Ratio, Net PnL, Win Rate, Profit Factor, maxDrawdownPct) und harten Mindestgates (`gates`, z.B. minSharpeRatio). Bei Gleichstand greift eine deterministische, dokumentierte Sortierung (Zielmetrik ↓ → Net PnL ↓ → Trades ↓ → lexikographisch auf Candidate ID ↑). OOS- und Holdout-Daten sind im Selektor-Code strukturell unerreichbar.
- **Freeze Artifact (`createFreezeArtifact`):** Nach der IS-Auswahl wird je Fenster ein unmanipulierbares Freeze-Artefakt erzeugt, das ausgewählten Kandidaten, vollständige Ranking-/Score-Tabelle, Datenmanifest (sha256 über Name, Periode, Kerzenanzahl und OHLCV-Hashes), Code-/Config-/Kandidaten-Hashes, Seed sowie IS/OOS-Cutoffs kapselt. Der `freezeHash` (sha256 über stableStringify) reagiert empfindlich auf jede Änderung an Kandidat, Daten oder Selector-Konfiguration.
- **OOS & Final Holdout Evaluation:** Das ausgewählte Kandidaten-Modell wird für die OOS-Ausführung des jeweiligen Fensters eingefroren. Nach Abschluss aller Fenster-Entscheidungen wird ein optionales finales Holdout-Segment (`holdout: { holdoutDays }`) strikt im Anschluss ausgewertet. Holdout-Daten sind vor Abschluss aller Window-Auswahlen strukturell isoliert.
- **Point-in-Time Safe Leakage Protection (`filterCandlesWithLeakageProtection`):** Prüft Point-in-Time-Sicherheit an Segmentgrenzen für horizonüberlappende Labels (`availableAt`, `labelHorizonEnd`). Im `strict: true`-Modus wird bei Leaks `walkforward:leakage-detected` ausgelöst; im `strict: false`-Modus werden leckende Kerzen vor der Ausführung gepurged.
- **CLI & DB-Persistenz-Erweiterungen:** CLI `scripts/run-backtest.ts` erweitert um `--candidates-file`, `--target-metric`, `--min-sharpe`, `--min-win-rate`, `--min-trades`, `--holdout-days`, `--embargo-hours`, `--purge-leakage` und renderungsfähige Markdown-Artefakte für Candidate Freeze Tables und Holdout Summaries. `toBacktestRunInsert` speichert Selection, Freeze-Artefakte und Holdout-Zusammenfassungen in `paramsJson`, und `backtestRunIdempotencyKey` schützt die Selektion sowie den Freeze-Hash vor Duplikaten.
- **Umfassende Unit-Test-Suite (`tests/backtest.trainSelectFreeze.test.ts`):** 9 neue, vollständig bestandene Testfälle zur Absicherung von Mutationsinvarianz, stabilen Tie-Breakers, Freeze-Hash-Empfindlichkeit, Candidate-Match in OOS, Leakage-Protection, Holdout-Isolierung, Gate-Fail-Closed-Fehlern und DB/Idempotenz-Roundtrips.

## [1.59.0] — 2026-09-21 · Multi-Venue-Market-Data-Sync (alle 6 Venues) + Warnung vor verwaisten Instrumenten

### Hinzugefügt

- **Sync-Adapter für alle Venues (`src/marketdata/adapters/`):** `BINANCE`
  und `KRAKEN` (öffentliche REST-APIs, credential-frei), `ALPACA`/`IBKR`/
  `PAPER` über eine Yahoo-Finance-Fassade (Aktien/Underlyings) bzw. das
  Binance-Bein (PAPER-Krypto) — jeweils mit Env-Gate (`<VENUE>_ENABLED`),
  host-autoritativen Token-Buckets (kein Bucket-Doppelverbrauch über
  Venues) und striktem Public-only-Pfad (keine Credentials, keine
  Order-/Account-Endpunkte im Sync).
- **Gemeinsamer `SyncHttpClient` (`adapters/http.ts`):** ein Fetch-Pfad für
  alle neuen Adapter — Retry mit Backoff (429/5xx), Timeout/Abbruch,
  Fehlerklassifizierung (`MarketDataErrorReason`, inkl. `SCHEMA_MISMATCH`
  bei unerwarteten Venue-Antworten) und Secret-Redaction in Fehlern/Logs.
- **Warnung vor verwaisten Instrumenten (statt stillem `WARMING`):**
  `SyncResult.orphanedInstruments` (nur bei Befund gesetzt) + zwei
  Warnungen — aktive Registry-Zeilen, die in der Discovery fehlten, und
  Registry-Venues ganz ohne Sync-Abdeckung — plus Runbook-Sektion
  „Verwaiste Instrumente“ in `docs/MARKET_DATA_PIPELINE.md` (§8). Mit
  `symbolAllowlist` ist Schweigen Absicht (kein Zähler, keine Warnung);
  gekappte (`maxInstruments`) Zeilen zählen nicht als verwaist.
- **Integrationssuite 26 Seeds → `READY`
  (`src/marketdata/__tests__/sync.venues.integration.test.ts`):** belegt
  Ende-zu-Ende, dass Discovery→Enrichment→Backfill→Readiness für alle
  Venues funktioniert — 26 Seed-Instrumente erhalten je ≥ 61 1h-Kerzen mit
  Volumen/Spread, der Scanner kippt von `WARMING` auf `READY`; dazu
  Venue-Isolation (Yahoo-404 reißt Binance nicht mit).

### Geändert

- **`registerAdapters`/`AdapterRegistry` kennen 6 Sync-Venues
  (`KNOWN_SYNC_VENUES`):** der Gate-Report `skipped` listet jetzt für jede
  bekannte Venue einen symbolischen Grund (`VENUE_DISABLED`,
  `CAPABILITY_DISABLED`, …) statt nur BITUNIX; `AdapterRegistry.known()`
  ist der filterunabhängige Venue-Katalog.
- **Enrichment-Stages sind chunked und fehlerisoliert:** Bulk-Ticker laufen
  in URL-sicheren Chunks (Regression: hunderte Einzel-Calls mit
  `SCHEMA_MISMATCH`-Folgefehlern), ein fehlgeschlagener Chunk reißt die
  übrigen nicht mit; Ticker/Orderbook/Candles-Fehler landen klassifiziert
  im `SyncResult` (Instrument isoliert, Lauf geht weiter).

### Behoben

- **SCHEMA_MISMATCH-Root-Cause im Sync-Pfad:** ungechunkte Bulk-Requests
  und still verschluckte Enrichment-Fehler produzierten leere Metriken und
  ewiges `WARMING`; Adapter validieren Venue-Antworten jetzt gegen
  explizite Schemata, Befunde sind benannt (`reason`), gezählt und im
  Fehler-Manifest sichtbar.
- **Gate-Report-Vertrag an 6 Venues angepasst:** bestehende BITUNIX-Gate-
  und Registry-Tests pinnen jetzt den vollständigen `skipped`-Report
  (`VENUE_DISABLED` je Venue) bzw. den 6-eintragigen `known()`-Katalog.

## [1.58.0] — 2026-09-21 · Event-Replay mit realistischen Friktionen (RMA-P1-01)

### Hinzugefügt

- **Dritter Ausführungspfad `executionModel: "event_replay"`
  (`src/backtest/replayEvents.ts` + `src/backtest/replayExecution.ts`,
  Friktionsmodell-Version `er1`):** deterministischer Event-Replayer für
  Markt-, Funding- und Order-Lifecycle-Ereignisse in Ereigniszeit —
  explizites Opt-in, `legacy` bleibt Default und `paper` bleibt
  byte-identisch (kein bestehender Lauf wechselt still den Pfad).
- **Kanonischer Eventvertrag:** diskriminierte Union
  `MARKET_BAR | MARKET_QUOTE | MARKET_DEPTH | FUNDING_DUE` (Input) und
  `ORDER_SUBMITTED | ORDER_ACK | ORDER_REJECT | ORDER_PARTIAL_FILL |
  ORDER_FILL | ORDER_CANCEL` (erzeugtes Eventlog) mit dokumentierter
  stabiler Sortierung (`eventTime ↑` → Typ-Priorität → Symbol →
  Einfüge-Reihenfolge). Jedes Input-Ereignis trennt `eventTime` und
  `availableAt`; sichtbar erst ab `availableAt ≤ Simulationszeit` (kein
  Look-ahead, auch nicht für Kosten); `availableAt < eventTime` und nicht
  endliche Werte werden fail-closed abgewiesen (`replay:invalid-event`).
- **Zeit- und Latenzmodell:** vier getrennte Zeiten je Order
  (`decisionTime → submitTime → arrivalTime → fillTime(s)`), Latenz
  konfigurierbar (`decisionToSubmitMs`/`submitToArrivalMs`, ≥ 0 erzwungen,
  `replay:invalid-config` sonst); Fills frühestens auf der ersten Kerze mit
  `time ≥ arrivalTime`.
- **Fill-/Impact-Modell mit Order-Lifecycle:** verfügbare Menge aus
  historischer `MARKET_DEPTH` (Staleness-Deckel `maxDepthAgeMs`),
  dokumentierter konservativer Fallback `bar.volume ×
  maxBarVolumeParticipation`, ohne Liquiditätsdaten KEIN Fill
  (`NO_LIQUIDITY_DATA_NO_FILL`). Size-abhängiger Impact
  (`impactBps = impactBpsPerParticipation × Partizipation`), Gebühren und
  Slippage nur auf tatsächlich gefüllte Mengen. Partial-Exit lässt die
  Position mit Restmenge OFFEN (vorher: jeder Exit galt als Vollschluss —
  Kern des Findings); Restmengen verfallen nach `orderTtlBars`
  (`ORDER_CANCEL`). Fillmenge überschreitet nie Depth, Orderrestmenge oder
  offene Positionsmenge (`BacktestPortfolio.increasePosition`/
  `applyPartialExit`/`finalizeReplayPosition`, Exit-Preis = Fill-VWAP).
- **Punktgenaues Funding:** `FUNDING_DUE`-Ereignisse (Venue, Instrument,
  signierte `ratePer8h`, `intervalHours` 1..24) werden nur für zum
  Settlement-Zeitpunkt offene Perp-Positionen gebucht — dieselbe Formel
  (`computeFunding`) und Vorzeichenkonvention (Kontosicht: negativ =
  gezahlt) wie der Paper-Betrieb; Funding vor Entry/nach Exit wird nie
  gebucht, fehlende Ereignisse werden nie still durch einen statischen Satz
  ersetzt. `perpFundingRowsToReplayEvents`
  (`src/backtest/replayFunding.ts`) übersetzt kanonische
  `perp_funding_rates`-Zeilen as-of `available_at` in Ereignisse.
- **Reproduzierbarkeit:** `result.replay` trägt Datenmanifest
  (sha256 über Kerzen + kanonische Events), aufgelöste
  Friktionskonfiguration inkl. Seed + Modellversion, Event-Coverage,
  degradierte Annahmen (geschlossenes Vokabular `ReplayDegradedReason`),
  gedeckeltes Order-Eventlog und Fill-/Funding-/Impact-Details je Trade.
  Walk-Forward: `report.replayEvidence` + `costProfile.frictionModelVersion`
  (geht in den Idempotency-Key ein — Modellwechsel ist nie ein Replay);
  Persistenz additiv in `params_json.replayEvidence` und
  `provenance_json.replay` je Trade-Zeile (max. 64 Fills, `truncated`-Flag).
  Keine neue Migration nötig (JSON-Spalten, Alt-Runs unverändert lesbar).
- **CLI:** `scripts/run-backtest.ts` mit `--execution-model=event_replay`,
  `--replay-latency-ms`, `--replay-seed`; lädt `FUNDING_DUE`-Ereignisse aus
  der Perp-Historie (`PERP_DATA_ENABLED=true`), meldet Replay-Evidenz und
  degradierte Annahmen in Konsole und MD-Artefakt.
- **Observability:** bounded Metriken
  `backtest_replay_runs_total{result,degraded}` und
  `backtest_replay_degraded_total{reason}` (Gründe = geschlossene Union,
  keine Instrument-/Order-IDs als Label); Audit-Event
  `BACKTEST_RUN_PERSISTED` trägt zusätzlich `executionModel` +
  `frictionModelVersion`.
- **Tests (`tests/backtest.replay.test.ts`, 28 Tests):** Golden Replay
  (Bar + Latenz + zwei Partial Fills + Fee + Funding ⇒ unabhängig
  nachgerechnete exakte Cash-/PnL-Werte), Determinismus (identischer
  Event-/Trade-/Metrik-Hash), Depth-Fallback fehlend/stale/ohne Volumen,
  Mengen-Guards, Funding vor Entry/nach Exit/Look-ahead/Spot, Negative
  Paths für invalide Events/Config, kanonische Sortierung, Perp-Historie-
  Konvertierung, Walk-Forward-Persistenz-Verdrahtung inkl.
  Ledger-Reconciliation und Idempotency-Key-Abgrenzung, Performance-Deckel
  (2 Jahre Stundenkerzen < 10 s).

### Kompatibilität

- Rein additiv: `legacy` bleibt Engine-Default, `paper` bleibt
  Walk-Forward-Default und byte-identisch; alte gespeicherte Runs werden
  nicht uminterpretiert (`params_json.costProfile.executionModel`
  unterscheidet die Semantik je Run). Rollback = Opt-in-Flag nicht setzen.

## [1.57.0] — 2026-09-21 · Deterministische Trade-PnL-Attribution (RMA-P1-06)

### Hinzugefügt

- **Attributionsmodul `src/attribution/` (Methode `ta1`, DETERMINISTIC_ALLOCATION):**
  Jeder geschlossene Trade erhält eine versionierte, reproduzierbare Netto-PnL-
  Attribution, deren Quellenbeiträge (Agenten der Entscheidungskette, Proposer
  oder auslösende Regel) plus Kostenposten (Gebühren, Funding) plus explizites
  Residual **exakt** das realisierte Netto-PnL ergeben (erzwungene
  Reconciliation, Toleranz 1e-6). Normierte Gewichte aus den Confidence-Werten
  der Stimmen (fehlend → Beta(2,2)-Prior 0.5, konsistent mit journalAnalytics);
  Enthaltungen erhalten Beitrag 0 und bleiben sichtbar; widersprüchliche
  Stimmen gehen mit negativem Beitrag ein, der Konfliktanteil verbleibt im
  Residual. Ausdrücklich KEINE Kausalanalyse (Deklaration in jeder
  API-Antwort, jedem Audit und jeder Kopfzeile); Shapley nur nach expliziter
  Roadmap-Entscheidung.
- **Immutable Entry-Snapshot v2 (`trade_journal.decision_snapshot`):** exakte
  Prompt-, Agenten-, Regel-, Policy- (`rp1:<sha256>` über die wirksamen
  Risk-Limits) und Daten-Fingerprints (`df1:<sha256>` über Markt-/Trigger-
  Snapshot) plus kanonischer `snapshotHash` (`js2:<sha256>`) — spätere
  Prompt-/Regel-/Policy-Änderungen können historische Attribution nicht
  umdeuten. Stimmen tragen zusätzlich `symbol`, `side`, `model`. Alte v1-
  Snapshots bleiben lesbar; die Attribution behandelt sie fail-closed als
  `UNATTRIBUTABLE` (Grund `SNAPSHOT_SCHEMA_V1`) statt zu raten.
- **Append-only Persistenz (Migration
  `drizzle/2026-09-21_trade_attribution.sql`, idempotent):** Tabellen
  `trade_attributions` (Kopf) und `trade_attribution_entries` (Posten) mit
  Unique-Idempotenzschlüssel (`journal_id`, `method_version`) bzw.
  (`attribution_id`, `source_type`, `source_id`), FKs ohne CASCADE, CHECKs,
  Zeit- und Statusindizes sowie UPDATE/DELETE/TRUNCATE-Sperren auf DB-Ebene.
  `closed_at` = Ereigniszeit (Zeitfilter aller Queries), `computed_at` =
  Berechnungszeit; `fees`/`funding` NULL = unbekannt (nie still 0, sichtbar in
  `unknown_costs`). Ein Methodenwechsel schreibt NEUE Zeilen — historische
  Ergebnisse bleiben unverändert.
- **Produktions-Wiring:** `completeJournalRow()` attribuiert automatisch beim
  Trade-Close (Monitor, Engine-Flatten, Mikro-Executor) — fehlertolerant (ein
  Attribution-Fehler blockiert den Close nie; Audit `JOURNAL_ATTRIBUTION_FAILED`
  bleibt sichtbar). Funding kommt aus `positions.funding_paid`; Gebühren bleiben
  im Paper-Pfad ehrlich unbekannt. Backtest-Trades via
  `attributeBacktestTrade()` als Wert — der eingefrorene `BacktestTradeLog`-
  Ledger (RMA-P1-04) wird nicht mutiert; semantisch identische Methode.
- **Bounded Read-APIs (SEC-02-Muster, `firm.read`, `no-store`):**
  `GET /api/firm/journal/attributions` (Detail-Liste, Limit ≤ 200, Filter
  Symbol/Regime/Status/Methodenversion/Zeitraum, `truncated`-Flag) und
  `GET /api/firm/journal/attributions/aggregate?dimension=agent|rule|regime|cost`
  — Aggregate liefern immer Counts, Coverage gegen die geschlossenen
  Journal-Zeilen desselben Zeitraums und die serverseitig geprüfte
  Reconciliation (Δ ≤ 1e-6) mit.
- **Backfill-CLI `npm run attribution:backfill`:** historische, geschlossene
  Journal-Zeilen ohne Attribution nachziehen — idempotent in begrenzten
  Batches (Restart-sicher), `--dry-run`, `--from/--to` (Ereigniszeit), Dry-Run;
  Zeilen ohne ausreichenden Snapshot werden als `UNATTRIBUTABLE` persistiert,
  nie mit geschätzten Quellen gefüllt. Audit-Event `ATTRIBUTION_BACKFILL_RUN`.
- **Konfiguration:** `TRADE_ATTRIBUTION_ENABLED` (Default `true`) und
  `TRADE_ATTRIBUTION_METHOD_VERSION` (Default `1`, Allowlist) — siehe
  `CONFIGURATION.md` und `src/attribution/README.md` (vollständige
  Spezifikation, Einheiten, Zeitsemantik, Rollback).
- **Tests (31 neue):** `tests/tradeAttribution.test.ts` (20: Reconciliation
  LONG/SHORT/Gewinn/Verlust, Kosten bekannt/unbekannt, Alignment- und
  Enthaltungsregeln, Konflikte, Determinismus/Golden, Negative Paths),
  `tests/tradeAttribution.db.test.ts` (7: Roundtrip, Idempotenz bei
  Retry/Restart, Methodenwechsel erhält alte Zeilen, Backfill v1 ⇒
  UNATTRIBUTABLE + zweiter Lauf leer, Aggregate-Reconciliation + Coverage,
  Close-Wiring + Disable-Flag, Migration idempotent + Append-only-Trigger),
  `tests/tradeAttribution.api.test.ts` (4: 400-Verträge, Dimensionen,
  no-store, Deklarationsanker). Neue Audit-Events
  (`JOURNAL_ATTRIBUTED`, `JOURNAL_ATTRIBUTION_FAILED`,
  `ATTRIBUTION_BACKFILL_RUN`) vollständig im Audit-Katalog beschrieben;
  bounded Telemetrie-Counter ohne IDs als Labels.

### Geändert

- `buildProposalSnapshot()`/`buildRuleSnapshot()` schreiben Schema v2 mit
  Versionskette (additiv — Felder optional; `journalAnalytics` bleibt
  unberührt); `JournalVote` trägt optionale `symbol`/`side`/`model`-Felder.
- `JournalCloseInput` akzeptiert optionale `fees`/`funding`/`slippage`;
  `JournalCloseResult` meldet die Attribution (`status`, `methodVersion`,
  `created`).

## [1.56.0] — 2026-09-21 · Venueübergreifendes Execution-Benchmarking (RMA-P4-01)

### Hinzugefügt

- Opt-in Capture verbindet atomare Paper-/Engine-/MicroExecutor-Submissions,
  PAPER-/ALPACA-/BITUNIX-Adapter und Walk-forward-Persistenz mit einem kanonischen
  append-only Intent-/ACK-/Fill-/Benchmark-Ledger. Keine Änderung von
  Preis-/Sizing-Entscheidungen, Risk-Ceilings, Kill-Switches oder Live-Gates.
- Echte Alpaca-FILL-Aktivitäten und Bitunix-Trade-IDs, stabile Client-Keys,
  durable Send-Claims/Receipts, Restart-/Retry-Recovery ohne erneutes Senden;
  unbekannte Gebühren/Benchmarks bleiben null statt künstlicher Nullkosten.
- Bounded Read-API mit vorzeichenrichtigen Kosten, Fees/Shortfall, Fill Ratio,
  Latenzen, p50/p95, gewichteten Mitteln, Coverage und Provenienz-Zählung.
  Persistente L1-Samples belegen 1s-/5s-/30s-Markouts ohne Look-ahead.
- Read-only Worker `npm run execution:reconcile -- VENUE MODE --watch`,
  Operator-Import, strukturierte Audit-Einträge und bounded Prometheus-Counter.
- Neue additive SQL-Migrationen mit Unique-Keys, FKs, As-of-Indizes sowie
  UPDATE-/DELETE-/TRUNCATE-Sperren. Bestehende Migrationen bleiben unverändert.
  `EXECUTION_QUALITY_ENABLED=false` bleibt Default; Rollout/Rollback und die
  ehrlichen Null-Fallbacks sind in `src/executionQuality/README.md` beschrieben.
- PostgreSQL-/Produktionspfadtests für atomaren Paper-Rollback/Replay,
  Backtest-Fee-Roundtrip, parallele Claims, Receipt-Crash-Recovery, tatsächliche
  HTTP-Fill-Aktivitäten, historische As-of-Abfragen und deterministische Goldens.

## [1.55.0] — 2026-09-20 · feat(forecasts): Forecast-Ledger, Brier-Score & Kalibrierung (RMA-P3-01)

### Hinzugefügt

- **Forecast-Ledger (`src/forecasts/`, Migration
  `drizzle/2026-09-20_forecast_ledger.sql`, append-only/additiv):**
  Agenten-Analysen werden erstmals als unveränderliche Forecast-Verträge
  erfasst, Point-in-Time aufgelöst und unabhängig vom Trade-Journal mit
  Brier-Score und Kalibrierungsmetriken bewertet.
  - **Vertrag (immutable):** Agentenrolle, Prompt-Version und Modell,
    Zielereignis `CLOSE_DIRECTION` auf `PAPER:<SYMBOL>`, geschlossene
    Kategorien `[DOWN, UP]` mit validiertem Wahrscheinlichkeitsvektor
    (Summe ≈ 1, ±1e-6), Horizont (`4h|24h|72h`), `asOf`, Referenzzeit/-kurs,
    `resolvesAt`, Verfügbarkeitsdeadline (`resolvesAt + 2 h` Settling-Frist),
    Regime und Policy-Version (`fp1`). Natürlicher Idempotenzschlüssel
    `fk1:<sha256>` — Retries schreiben nie einen zweiten Forecast.
  - **Persistenz:** vier neue Tabellen (`forecasts`,
    `forecast_resolutions`, `forecast_resolution_runs`,
    `forecast_resolver_cursors`); Auflösungen sind versionierte Append-only-
    Zeilen mit Outcome-Hash (`fo1:<sha256>`), Status `PENDING/RESOLVED/VOID`,
    Ereignis-/Verfügbarkeitszeit und Run-Manifesten. Migration vollständig
    idempotent (`IF NOT EXISTS` + bewachte Constraints, Feature-Store-Muster).
  - **Resolver (idempotent, begrenzt):** löst ausschließlich fällige Forecasts
    gegen Kerzen mit `fetchedAt <= availabilityDeadline` auf (Point-in-Time,
    kein Look-ahead durch nachträglich reparierte Historie). Fehlende Kerze ⇒
    `VOID(MISSING_DATA)`, unbrauchbarer Kurs ⇒ `VOID(INVALID_DATA)`, Volumen 0
    ⇒ `VOID(TRADING_HALT)` — niemals wird stillschweigend geraten. Monotoner
    Cursor + Run-Manifeste; Wiederholungen/Neustarts setzen am Wasserstand auf.
  - **Metriken (rein, Version `fm1`):** binärer Brier-Score `mean((p−y)²)` und
    kategorial (`[0,2]`), Brier Skill Score gegen Segment-Klimatologie,
    Log Loss (ε = 1e-6), Reliability-Bins (exakt an den Rändern 0/1) mit
    Wilson-95-Intervallen, Expected Calibration Error, Sample Count, Coverage
    `(resolved+void)/due` und Mindeststichproben-Gate
    (`insufficient-sample`). Nur `RESOLVED` zählt in Scores; `VOID`/`PENDING`
    bleiben in der Coverage sichtbar.
  - **Segmentierung/API:** `GET /api/firm/forecasts` (Liste +
    Operations-Status: Cursor-Wasserstand, ältester überfälliger Forecast,
    `lagMs`), `GET /api/firm/forecasts/scores` (Overall + Segmente, bounded),
    `POST /api/firm/forecasts/resolve` (manueller Lauf, `409` bei
    Parallelität), `POST /api/firm/forecasts/resolutions` (Operator:
    `RE_RESOLVE`/`VOID` mit geschlossener Grundliste). `firm.read`/`firm.write`,
    `no-store`, harte Mengenlimits, keine High-Cardinality-Labels.
  - **Re-Resolution statt stiller Mutation:** Marktdaten-Korrekturen oder
    Operator-Eingriffe erzeugen eine neue Resolution-Version; frühere
    Versionen bleiben unverändert und nachvollziehbar.
  - **Betrieb:** Resolver-Kadenz in `instrumentation.ts` (§6), Audit-Events
    `FORECAST_RECORDED`/`FORECAST_RESOLVED`/`FORECAST_VOID`/
    `FORECAST_RE_RESOLUTION`/`FORECAST_CAPTURE_FAILED` (Katalog in
    `auditView.ts`), bounded Telemetrie (`telemetry.forecasts`).

### Konfiguration

- `FORECAST_LEDGER_ENABLED` (Default `true`) — Master-Schalter Capture + APIs;
  `false` ist der Rollback-Pfad (APIs antworten `503 DISABLED`).
- `FORECAST_RESOLVER_INTERVAL_MIN` (Default `15`, Bounds 5…1440, `0` = aus).
- `FORECAST_MIN_SAMPLE` (Default `30`, Bounds 5…1000).

### Dokumentation & Tests

- Neues Modul-Dokument [`docs/FORECASTS.md`](docs/FORECASTS.md): Vertrag,
  Zeitsemantik (Ereignis/Verfügbarkeit/Berechnung), Formeln, Einheiten,
  Fallbacks, API-Referenz, Migrations-/Rollback-Runbook.
- Testsuite: `tests/forecastScoring.test.ts`, `tests/forecastCapture.test.ts`,
  `tests/forecastResolver.test.ts`, `tests/forecastService.test.ts`,
  `tests/forecastApi.test.ts` (rein) sowie `tests/forecastLedger.db.test.ts`
  (eingebettetes Postgres: Migration doppelt ausgeführt, Idempotenz,
  Re-Resolution, Cursor/Restart).

### Hinweise (Abweichung vom Audit-Stand)

- Audit-Basis war `df3163e`/v1.51.1; umgesetzt auf v1.54.0 mit dem
  etablierten Feature-Store-/Perp-Data-Muster (idempotente Migration,
  Cursor-Jobs, `firm.*`-APIs) — ohne Änderung bestehender Tabellen oder
  Default-Verhalten.

## [1.54.0] — 2026-09-20 · feat(data): historische Perpetual-Daten (RMA-P2-02)

### Hinzugefügt

- **Perpetual-Daten-Layer (`src/perpdata/`, Migration
  `drizzle/2026-09-20_perpetual_data.sql`, append-only/additiv):** Funding-Raten,
  Open Interest und Liquidationen liegen erstmals als punktreiche Historie in
  eigenen Tabellen (`perp_funding_rates`, `perp_open_interest`,
  `perp_liquidations`, `perp_sync_runs`, `perp_sync_cursors`) — vorher existierten
  Funding/OI nur als Momentwert der Ticker-Discovery, Liquidationen gar nicht.
  - **Kanonisches Schema je Reihe** mit vollständiger Provenienz (`venue`,
    `instrument_id` = `VENUE:SYMBOL`, `symbol`, `source_id`, `schema_version`) und
    der getrennten Zeitachse `event_time` / `available_at` / `fetched_at`. CHECKs
    erzwingen: Wert **XOR** `missing_reason` („kein Wert“ ist nie `0`),
    `available_at >= event_time` (kein Look-ahead in der Ablage),
    `basis`-Kopplung des Open Interest (weitere Größen nur mit `converted`).
  - **Einheitenvertrag:** Funding als Anteil je Intervall
    (`fraction_per_interval`, 0.0001 = 1 bp) plus `interval_hours` und
    `next_funding_time`; Open Interest in `contracts`/`base_quantity`/`quote_value`
    mit autoritativer `basis`; Liquidationen mit kanonisierter Positionsseite
    (`LONG_LIQUIDATED`/`SHORT_LIQUIDATED`), Menge, Preis, Notional und
    `source_event_id`.
  - **Capability-Ports:** `unsupported` ist typisiert und von leerer Liste/0
    getrennt (`NO_PUBLIC_ENDPOINT`, `VENUE_NOT_PERP`, `DISABLED_BY_POLICY`) —
    Bitunix veröffentlicht public keinen OI-/Liquidations-Endpunkt, beide Reihen
    bleiben deshalb als `UNSUPPORTED` markiert statt gefüllt.
  - **Adapter:** `bitunix` (real, ausschließlich `BitunixPublicClient`,
    `get_funding_rate_history` mit Antwortkappung auf das Venue-Maximum von
    200 und client-seitiger Fensterfilterung — die Venue-Doku nennt den
    Startparameter stellenweise `starTime`) und `fixture` (Venue `SIM`,
    simuliert Lücken, Duplikate, negatives OI, Bereichsverletzungen,
    429/Timeout und fehlende Reihen — für Tests und Offline-Validierung).
  - **Sync:** Backfill und inkrementell mit persistierten Wasserständen je
    `(venue, instrument, kind)`, Overlap, `PERP_DATA_SAFETY_LAG_MS`,
    Idempotenzschlüssel `prk1:<sha256>` auf `perp_sync_runs` (Replay schreibt
    nichts), `ON CONFLICT DO NOTHING` je Zeile, Revisionsschutz bei
    abweichendem Inhalt (überschreibt nie, zählt und auditiert), Rate-Limit,
    ein Retry mit Backoff bei übertragbarem Ausfall, harte Caps
    (`PERP_LIMITS`: 250 Instrumente/Lauf, 500 Zeilen/Request, 20
    Requests/Reihe, 2 000 Zeilen/Batch), `--dry-run` gegen Speicher-Ablage.
  - **Qualitäts-Layer** analog zum Kerzen-Layer: `GAP`, `STALE` (Alter gegen
    `event_time`, nicht gegen `available_at`), `INVALID` (u. a. negatives/widersprüchliches
    OI, Wert außerhalb der Bounds ⇒ `null` + Grund statt Klemmen), `DUPLICATE`,
    `CROSSCHECK` (Zweitvenue, opt-in); Modi `log`/`strict`, Report
    `data/perpdata/quality-report.json`, Befunde zusätzlich als
    `qualityStatus` an der Zeile.
  - **as-of-Query** (`GET /api/marketdata/perpetual/series`) über
    Venue/Instrument/Fenster mit harten Limits; liefert nur Zeilen mit
    `event_time ≤ asOf` **und** `available_at ≤ asOf`; je Reihe
    `availability` + `reason` (`AVAILABLE`/`MISSING`/`STALE`/`UNSUPPORTED`/
    `UNAVAILABLE`). `GET /api/marketdata/perpetual/status` zeigt Gates,
    Capabilities, Coverage, letzte Läufe und den Ablagestatus als Teil der
    Antwort. Fehlercontract `{ok:false, error, message, hint}`: 400 bei
    Anfrageablehnung, 503 `perp:store_unavailable` — nie 200 mit leerem Bestand.
  - **Konsumenten verdrahtet:** `DerivativeContext` von
    Scanner/Signal-Faktoren (`perpDerivativeProvider`), Funding-Rate-Provider
    der Backtest-/Paper-Funding-Engine (nur fällige Settlements je Haltedauer,
    `hiddenRows`/`missingMarks`/`qualityFlagged`), Analystensnapshot
    (`perpAnalystSnapshotLines`), Konsumenten-Artefakt
    `data/perpdata/derivatives.json` (0600, atomar, `FRESH`/`STALE`/`FILE_STALE`/
    `MISSING`/`DISABLED`/`ERROR`). Fehlende, veraltete oder **unbelegbare**
    Daten (`INVALID`/`DUPLICATE`/`CROSSCHECK`/`UNKNOWN`) ergeben `null` mit
    Grund, nie eine 0 — `perpRowIsAttestable` ist dafür die einzige Schwelle.
  - **CLI** `npm run perp:sync` (`--status`, `--fixture`, `--dry-run`,
    `--venue`, `--mode`, `--days`, `--from/--to`, `--kinds`, `--availability`,
    `--quality`, `--max-instruments`, `--concurrency`, `--safety-lag`,
    `--refresh-cache`, `--prune-runs`, `--json`), Exit 0/1/2;
    Aliase `perp:sync:status`, `perp:sync:fixture`.
  - **Betrieb:** 15 `PERP_DATA_*`-Flags (beide Gates Default `false` ⇒ ohne
    Konfiguration byte-identisches Verhalten), fünf Metrik-Counter mit bounded
    Labels (`perp_sync_runs_total`, `perp_sync_rows_total`,
    `perp_data_quality_findings_total`, `perp_data_revisions_total`,
    `perp_data_asof_queries_total`), Audit-Ereignisse je Lauf.
- **Doku:** [docs/PERPETUAL_DATA.md](docs/PERPETUAL_DATA.md) (Vertrag: Schema,
  Capabilities, Sync, Qualität, Query, Konsumenten, CLI, Migration, Sicherheit)
  sowie Verweise in `MARKET_DATA_PIPELINE.md` §15, `BITUNIX.md`,
  `OBSERVABILITY.md` §2.2, `BACKTESTING.md` §3.1, `PAPER_TRADING.md` §3.4,
  `CONFIGURATION.md` und `.env.example`.

### Behoben

- **CLI-Flags wurden still ignoriert:** `parseArgs` erkannte
  Wert-Flags nur bei exakter Array-Position (`argv.includes("--venue")`), nicht
  in der dokumentierten Form `--venue=BITUNIX` — `--mode`, `--days`, `--kinds`,
  `--quality` und Co. liefen damit unwirksam durch. Erkennt jetzt beide Formen
  und verlangt den Wert (`--flag=…`), sonst UsageError (Exit 2).
- **Retention konnte Manifeste nie löschen:** `pruneRuns` nullte `run_id` der
  Datenzeilen, nicht aber `last_run_id` der Sync-Cursor — der Foreign-Key blockierte
  das `DELETE`. Cursor-Wasserstände bleiben unverändert, nur der Manifest-Verweis
  wird geleert.
- **Redaktionslücke in Fehler-Echos:** die as-of-Validierung gab die rohe
  Instrument-ID im Fehler-`detail` zurück (Steuerzeichen/Umbrüche möglich,
  Log-Injection). Echo läuft jetzt durch `perpRedactMessage` (gekürzt,
  einzeilig, kontrollzeichenfrei).
- **Open Interest ohne darstellbaren Zustand:** eine Zeile, deren einziger
  Wert negativ oder ohne Währungscode war, würde `basis NOT NULL` plus
  Werte-CHECK der Tabelle verletzen. Sie wird jetzt in der Normalisierung
  qualifiziert abgewiesen (`INVALID_MEASURE`/`NO_MEASURE`) und zählt in die
  Statistiken, statt den Schreibpfad zum Ausnahmefall zu machen.

### Migration

- `psql "$DATABASE_URL" -f drizzle/2026-09-20_perpetual_data.sql` (idempotent,
  fünf neue Tabellen, keine Änderung bestehender Tabellen) oder
  `npx drizzle-kit push`. Danach `npm run perp:sync -- --fixture --dry-run
  --mode=backfill` (netzfreier Selbsttest) und bei Bedarf
  `npm run perp:sync -- --venue=BITUNIX --mode=backfill --days=30`.
- Rollback: Gates aus, Code zurück, `DROP TABLE` der fünf `perp_*`-Tabellen
  (nur ohne laufenden v1.54.0-Code) — der Bestand ist aus denselben Quellen
  reproduzierbar.

### Testen

- `tests/perpPipeline.normalize.test.ts`, `.sync.test.ts`, `.db.test.ts`
  (embedded Postgres: Constraints, Replay, Revision, Neustart-Wasserstand,
  as-of, Retention), `.consumers.test.ts`, `.security.test.ts`,
  `.cli.test.ts` — 95 Tests; Gesamtsuite 2 705 Tests grün
  (`npm run typecheck`, `npm run lint`, `npm test`, `npm run docs:validate`).

## [1.53.0] — 2026-09-20 · feat(research): Point-in-Time Feature Store (RMA-P6-01)

### Hinzugefügt

- **Point-in-Time Feature Store (`src/features/`, Migration
  `drizzle/2026-09-20_feature_store.sql`, additiv):** Featurewerte werden ab
  jetzt versioniert, typisiert und mit vollständiger Provenienz gespeichert und
  sind damit für Backtest/Research reproduzierbar:
  - **Registry** (`registry.ts`, `definitions.ts`): Name, semantische Version,
    Ausgabeschema (`number`/`boolean`/`enum`), Einheit, Wertdezimale, Entity-Typ,
    Timeframe, Lookback, Abhängigkeiten, `computeKey`, Konfiguration und Owner;
    Fingerprints `fc1` (Code), `fg1` (Config), `fd1` (Definition). Definitionen
    sind **unveränderlich** — dieselbe `(feature_id, version)` mit anderer
    Semantik wird von Registry und Datenbank abgelehnt; neue Semantik ⇒ neue
    Version. Erster Slice: `scanner.rsi@1`, `scanner.atr@1`,
    `scanner.atr_band@1` (abhängig auf ATR) mit den Scanner-Defaults; Formeln
    werden mit dem Scanner **geteilt** (`computeRsi`, `computeAtrPct`), ein Test
    erzwingt die Parität.
  - **Wertmodell** (`types.ts`, `validate.ts`, `feature_values`): `event_time`,
    `available_at`, `computed_at`, dtype-genauer Wert, Null-Grund,
    `quality_status`, Definitions- und Inhalts-Fingerprint (`fv1`) sowie
    `source_manifest` (Dataset-Hash `ds1` über die Rohkerzen **inklusive**
    Ingestion-Zeitstempel). UNIQUE je
    `(feature_id, feature_version, entity_id, timeframe, event_time)`,
    append-only, CHECK-Invarianten (`available_at ≥ event_time`,
    `computed_at ≥ available_at`, Wert **oder** Null-Grund — nie beides, nie
    nichts: `null ≠ 0`), PIT-Index für As-of-Abfragen.
  - **Materialisierung** (`materialize.ts`, `service.ts`, `store.ts`): reine,
    deterministische Berechnung, topologische Reihenfolge, bounded Batches
    (≤ 2000 Werte, ≤ 250 je Insert-Chunk), monotoner Cursor-Wasserstand,
    Idempotency-Key `fm1:<sha256>` je Lauf (Replay statt Doppelwrite),
    Trockenlauf, Backfill-Manifest mit Zählern/Definitions-Fingerprints/
    Source-Manifesten sowie ausdrückliches **Verwerfen** eines Batches, der eine
    Rohdatenrevision berührt (`FEATURE_DATA_REVISION_DETECTED`, Manifest
    `FAILED`, Revision protokolliert, Cursor bleibt stehen) — historische Werte
    werden nie still überschrieben.
  - **PIT-Abfrage** (`pitQuery.ts`): `GET /api/firm/features/values` liefert je
    Entity/Feature den jüngsten Wert mit `event_time ≤ target_time` **und**
    `available_at ≤ as_of`; harte Grenzen (200 Entities, 25 Features, 2000
    Zeilen, 20 000 Quellzeilen ⇒ `FEATURE_PIT_SOURCE_TRUNCATED` statt stiller
    Kürzung), typisierte Antwort und **explizite** Missingness
    (`OK`/`NULL_VALUE`/`MISSING`, `value: null`, Zähler mit Invariante
    `matched + missing = requested`). `lagMs`/`stale` messen das
    Informationsalter gegenüber `as_of`.
  - **Offline/Online-Parität** (`adapters.ts`, `parity.ts`): Store- und
    Compute-Adapter teilen Registry und Executors; der Paritätsjob meldet
    `MISSING_STORED`, `VALUE_MISMATCH`, `DATASET_REVISION` oder
    `DEFINITION_MISMATCH`.
  - **Qualität und Betrieb** (`sourceQuality.ts`, `service.ts`): Propagierung
    des schwersten Quality-Befunds im Fenster (`UNKNOWN` = „nicht geprüft“,
    niemals `OK`), Abdeckung/Lag je Reihe, Retention wertfreier Manifeste
    (`pruneRuns`), Read-API `GET /api/firm/features`, CLI
    `npm run features:materialize|status|parity`, Audit-Events und bounded
    Metriken (`feature_materialization_*`, `feature_pit_*`,
    `feature_parity_checks_total`).
- **Tests:** `tests/featureStore.test.ts` (24 Tests) inklusive synthetischem
  Leakage-Test (nachgelieferte Kerze ist vor ihrem `available_at` unsichtbar,
  `event_time`-Grenze hart), Idempotenz/Replay, Cursor-Neustart ohne Lücke und
  Duplikat, Revision vs. Parität, fail-closed Scope-/Grenzprüfungen;
  `tests/featureStore.db.test.ts` prüft die Postgres-Variante (Constraints,
  Transaktionsatomarität, Idempotenz, As-of-Indexpfad) und überspringt sich ohne
  erreichbare Datenbank.
- **Dokumentation:** [docs/FEATURE_STORE.md](docs/FEATURE_STORE.md) (Semantik,
  Formeln und Einheiten, Zeit-/Verfügbarkeitsmodell, PIT-Regeln, Migration,
  Deployment und Rollback).

### Geändert

- `src/scanner/factors/atr.ts`: ATR-Kursanteil als `computeAtrPct` extrahiert und
  als **einzige** Implementierung exportiert — Scanner-Faktor und Feature Store
  nutzen dieselbe Formel (keine Zweitformel).
- `package.json` / `package-lock.json`: Version **1.53.0**; neue Scripts
  `features:materialize`, `features:status`, `features:parity`.

### Sicherheit

- Read-Endpunkte verlangen `firm.read`, senden `Cache-Control: private, no-store`
  und sind ausschließlich lesend (es gibt bewusst keinen POST-Pfad; die
  Materialisierung läuft über die CLI).
- Keine Entity-/Order-/Trade-IDs als Metrik-Label (Kardinalitätsregel); keine
  Secrets, keine Roh-Broker-Payloads, kein PII in Werten, Audit-Details oder
  Logs.

## [1.52.0] — 2026-09-20 · feat(backtest): persistente Backtest-Trades als Trade-Level-Wahrheitsquelle (RMA-P1-04)

### Hinzugefügt

- **Tabelle `backtest_trades` (append-only, Migration
  `drizzle/2026-09-20_backtest_trades.sql`):** jeder Trade eines
  Walk-Forward-Runs als eigene Zeile — FK auf `backtest_runs` (ohne Cascade,
  Repo-Konvention), stabile Sequenz `seq` (`UNIQUE (run_id, seq)`),
  Fenster/Segment, Engine-Trade-Referenz (`UNIQUE` je Fenster/Segment),
  Symbol, Seite, Menge/Notional, Entry/Exit-Zeit und -Preis, Brutto-/Netto-PnL,
  Gebühren, Funding (NULL-bar, ≠ 0), Slippage, Exit-Grund, Haltedauer und
  JSONB-Provenienz (Regel-Signatur, Fenstergrenzen, Simulator-Seed);
  CHECK-Constraints (Enums, Vorzeichen, `exit ≥ entry`) und drei
  Query-Indizes (Keyset, Fenster/Segment, Symbol). `backtest_runs` additiv um
  `idempotency_key` (partiell UNIQUE), `trade_count`,
  `reconciliation_status` und `reconciliation_json` erweitert — Alt-Runs
  tragen `NULL` („kein Ledger“, nie „0 Trades“).
- **Reines Ledger-Modul `src/backtest/tradeLedger.ts`:** validierende
  Abbildung `BacktestTradeLog` → Zeile (endliche Dezimal-Strings, keine
  NaN/Infinity, dokumentierte Einheiten/Rundung, PnL-Identität
  `netto = brutto − fees + funding`), verlustfreier Rück-Roundtrip,
  Abgleich Ledger ↔ Run-Aggregate (Anzahl, Gewinner, Netto-PnL, Gebühren,
  Slippage, Funding, Trade-Hash je Fenster/Segment mit dokumentierten
  Rundungstoleranzen), Inhalts-Idempotency-Key (`wf1:` + sha256 der
  Lauf-Identität ohne `createdAt`), opaker Keyset-Cursor und handgeschriebene
  Query-Validatoren.
- **Atomare, idempotente Persistenz `persistBacktestRun()`
  (`src/backtest/runStore.ts`):** Run + alle Trades in EINER Transaktion mit
  Read-back-Abgleich vor dem Commit; jeder Fehler bei Trade N rollt den Run
  zurück. Gleicher Idempotency-Key ⇒ Replay des bestehenden Runs (auch unter
  parallelen Retries via SQLSTATE 23505), abweichender Inhalt ⇒
  `ledger:idempotency-conflict`, fremde Run-UUID ⇒ `persist:run-id-conflict`.
  Audit-Events `BACKTEST_RUN_PERSISTED` / `BACKTEST_RUN_PERSIST_FAILED`
  (Klasse `telemetry`, im Audit-Katalog beschrieben) und bounded Metrik
  `backtest_run_persist_total{result,reason}`.
- **Read-API `GET /api/firm/backtests/[id]/trades`:** paginiertes
  Trade-Ledger (`limit` 1..500, Default 100; opaker `cursor`; Filter
  `segment`, `window`, `symbol`, `side`, `exitReason`; unbekannte Werte ⇒
  400), `firm.read`, `no-store`; unbekannte Run-ID ⇒ 404. Detail-Route
  `GET /api/firm/backtests/[id]` additiv um `ledger`, `trades` (erste Seite)
  und `links.trades` ergänzt; Alt-Runs melden `ledger.status = "UNAVAILABLE"`.
  Die Liste lädt weiterhin keine Trades.
- **Tests `tests/backtest.tradeLedger.test.ts`** (26 Tests; DB-Teile
  ping → skip): Mapping/Rundung/NULL-Semantik, negative Pfade, Abgleich +
  manipulierte Aggregate/Zeilen, Idempotency-Key, Cursor/Query-Validatoren,
  Migration/Constraints in der DB, Roundtrip Run + N Trades geordnet,
  Rollback bei Fehler an Trade N (Constraint und Exception), Read-back-
  Ablehnung, sequentielle + parallele Retries (exakt 1 Run + N Trades),
  Aggregate/Trade-Hash aus DB-Zeilen reproduziert, API-Limit/Cursor-Kette/
  Filter/404/400/Alt-Run.

### Geändert

- **Walk-Forward-Report (`src/backtest/walkforward.ts`):** additiv
  `netPnl` (Σ Trade-PnL) und `slippage` je Fenster-Segment und Aggregat sowie
  `trades[]` (alle Trade-Logs mit Fenster/Segment) — die Trade-Logs werden
  nicht mehr verworfen. `hashTrades()` akzeptiert `BacktestTradeLog[]`
  direkt. Bestehende Felder und Hash-Vertrag unverändert.
- **CLI `scripts/run-backtest.ts`:** persistiert über `persistBacktestRun`
  (statt eines nackten Run-Inserts), neues Flag `--idempotency-key`,
  Artefakte unter der UUID des persistierten Runs (bei Replay: des
  bestehenden), JSON-Artefakt enthält `trades`, MD-Zusammenfassung zeigt
  Equity- UND Ledger-PnL sowie Slippage. Fehlgeschlagene/abgelehnte
  Persistenz ⇒ keine DB-Zeile, Artefakte bleiben, Exit 1.
- **Doku:** `docs/BACKTESTING.md` §5.1/§5.2 (Schema, Einheiten, Rundung,
  Zeitsemantik, Abgleich, Idempotenz, Volumen + gemessene Query-Pläne,
  Retention/Rollback, API-Vertrag), `docs/README.md`, README,
  Roadmap-Audit RMA-P1-04 → `FIXED`.

## [1.51.3] — 2026-09-20 · fix(backtest, marketdata): Metrik-/Quality-Roundtrips korrigiert · docs(audit): 25-Punkte-Roadmap-Audit mit 21 Remediation-Prompts

### Fixiert

- **Backtest-Volatilität (QA-01):** `computeBacktestMetrics()` las das
  nicht existente Feld `volatility` aus dem Ergebnis von `sharpeRatio()` und
  meldete deshalb auch bei schwankenden Equity-Returns immer
  `annualizedVolatility: 0`. Die Kennzahl verwendet jetzt dieselbe
  Equity-Log-Return-Serie, `ddof=1` und die dokumentierte
  `sqrt(annualization)`-Skalierung aus `realizedVolatility()`; ein präziser
  Regressionstest prüft den positiven, annualisierten Prozentwert.
- **Marketdata-Quality-Persistenz (QA-02):** `loadQualityReport()` verwirft
  beim sicheren Einlesen nicht länger alle aggregierten Klassen-Zähler und
  `crosscheckCompared`. Aggregate werden bewusst aus den validierten
  Serienzeilen rekonstruiert, statt untrusted persistierte Summen zu
  übernehmen; der Roundtrip-Test deckt Zähler, Candles und Crosscheck-Coverage
  ab.

### Hinzugefügt

- **Roadmap-Audit 2026-09-20:** Neues vollständiges Audit-Paket unter
  `docs/audits/2026-09-20-roadmap-audit/` mit Statusübersicht, Detailreport,
  **25 komponentenspezifischen Findings**, Abhängigkeiten, TOP-3-Gates und
  Remediation-Tracking. Ergebnis: **4 VERIFIED, 13 PARTIAL, 8 OPEN**.
- **Produktionsreife Prompt-Serie:** Für jedes der 21 PARTIAL-/OPEN-Deltas ein
  eigenständiger Prompt mit verifiziertem Ausgangszustand, konkreten
  Deliverables, Nicht-Zielen, Point-in-Time-/Idempotenz-/Security-Regeln,
  Tests, Akzeptanzkriterien sowie Dokumentations-, SemVer-, Commit- und
  PR-Pflichten. Die vier erfüllten Komponenten bleiben Kontrollbefunde und
  werden nicht künstlich als Implementierungsaufgabe dupliziert.

### Geändert

- Audit-Zyklus in `docs/audits/README.md`, `docs/README.md`, Root-`README.md`
  und dem Docs-Katalog registriert. Der veraltete Root-Dokumentationsstand
  `v1.42.0` ist auf `v1.51.3` korrigiert.
## [1.51.2] — 2026-09-20 · test: Unit-Tests für sieben bisher ungetestete Kernmodule (112 Tests) · docs: Versionierung und Doku-Sync

### Hinzugefügt

- **Unit-Tests für verifizierte Testlücken (112 Tests, 7 neue Dateien unter
  `tests/`):** Systematische Abdeckungslücken-Analyse (jedes `src/`-Modul
  gegen alle Test-Importe gematcht) — getestet werden ausschließlich Module
  mit **null direkter Test-Abdeckung**, rein deterministisch und DB-frei
  (Repo-Konvention: `node:test` + `assert/strict`, kein Duplikat zu den
  bestehenden ~2.440 Tests; scheinbar ungetestete Kandidaten wie
  Walk-Forward oder MAE/MFE waren bereits über `backtest.engine.test.ts`
  bzw. `tradeJournal.test.ts` abgedeckt und wurden bewusst nicht doppelt
  getestet):
  - `tests/tokenCompare.test.ts` (15): timing-sicherer Token-Vergleich
    (`src/lib/tokenCompare.ts`, Sicherheitskern aller Schreib-Endpunkte und
    der RBAC-Auflösung; bisher nur ein Smoke-Test in `hardening.test.ts`):
    Längen-Padding ohne Throw (das nackte `timingSafeEqual` wirft bei
    ungleicher Länge), fail-closed bei leeren Werten (zwei leere Strings
    sind bewusst UNGLEICH), UTF-8-Byte-Semantik (é als Codepoint vs.
    kombinierender Akzent), 10k-Zeichen-Tokens und Alias-Identität des
    `apiAuth`-Re-Exports.
  - `tests/appPaths.test.ts` (29): Path-Traversal-Verteidigung
    (`src/lib/appPaths.ts`): `..`-Ausbrüche einfach/getarnt
    (`data/../..`)/Backslash-getarnt/tief (zählende Auflösung), absolute
    Pfade als Operator-Entscheidung, Segment-Einzelprüfung in
    `joinRuntimePath`, Redaktions-Garantien der Fehlermeldungen (kein
    Host-Pfad-Leak, 200-Zeichen-Cap, Steuerzeichen-Entfernung),
    Safe-Fallback fällt niemals auf den Ausbruchspfad.
  - `tests/envParsing.test.ts` (22): `envInt`/`envNumber` (`src/lib/env.ts`)
    vollständig — NaN/Infinity-Schutz, Bounds-Clamp, Truncation,
    Leerstring-Semantik-Differenz beider Funktionen und die sonst nirgends
    abgesicherte fail-laut-Warnpflicht von `envNumber` (jede Korrektur warnt
    genau einmal, Normalfall bleibt still; `console.warn` pro Test gemockt).
  - `tests/analysisContext.test.ts` (16): Portfolio-Analyse-Kontext für die
    LLM-Ebene (`src/portfolio/context.ts`): Strukturvertrag, Garantie
    „keine Gewichte im Kontext“ (Autoritätskette), Pearson-ρ ≈ ±1-Signale,
    alle `PortfolioError`-Pfade (`INVALID_INPUT`, `LENGTH_MISMATCH` × 2 mit
    Index-Diagnose), `summarizeAnalysisContext`-Kappung, Rundungs- und
    Mutationsfreiheit der Prompt-Helfer.
  - `tests/riskConfigView.test.ts` (16): `effectiveConfigView()` +
    `CONFIG_KEYS` (`src/lib/riskConfigService.ts`, DB-freier Teil):
    Metadaten-Vertrag (Vollständigkeit/Eindeutigkeit/Verankerung in
    `LIMIT_CEILINGS` + `DEFAULT_LIMITS`), Code-Ceilings als min/max des
    Views, Clamping von Ausreißern, adp.*-Namensraum getrennt und im
    Bounds-Fenster; dazu die Entschärfungs-Garantien: `requireStopLoss` ist
    dem Dashboard komplett entzogen UND bleibt nach einem
    `applyRuntimeLimits`-Abschaltversuch wirksam `true`.
  - `tests/version.test.ts` (4): Versions-SSoT (`src/lib/version.ts`) —
    `APP_NAME`/`APP_VERSION` exakt aus `package.json`, SemVer-Format
    (maschinenlesbar für Gateways).
  - `tests/ollamaModelTag.test.ts` (10): `resolveModelTag`
    (`src/lib/ollama.ts`) — exakter Treffer gewinnt vor der
    Familien-Heuristik, Familien-Ersatz bleibt in der Familie, keine
    Präfix-Verwechslung (`llama3` ≠ `llama32`, sonst liefe das System still
    mit dem falschen Modell), leere Modellliste und Case-Sensitivität.

### Verifikation

- 112/112 neue Tests grün; Gesamtsuite **2.552 Tests: 2.531 pass, 0 fail,
  21 skipped** (DB-gegatete Tests, Repo-Konvention `ping → skip`);
  `tsc --noEmit` (strict) und `eslint` fehlerfrei; `docs:validate` grün.
- Kein Laufzeitverhalten geändert (reine Test-/Doku-Ergänzung → Patch-Bump).

## [1.51.1] — 2026-09-19 · fix(audit): GAP-04-Audit-Events im Katalog nachgetragen · docs(audit): Feature-Gap-Remediation abgeschlossen (GAP-01…GAP-10 FIXED)

### Fixiert

- **Audit-Katalog (GAP-04-Nachtrag):** Die mit v1.48.0 eingeführten Events
  `POSITION_SIZING` (Engine), `POSITION_SIZING_UNKNOWN` (Mikro-Executor),
  `CLUSTER_EXPOSURE_MONITOR` und `CLUSTER_EXPOSURE_BLOCKED` (Cluster-Guardrail)
  hatten keinen Eintrag in `AUDIT_EVENT_CATALOG` (`src/lib/auditView.ts`).
  Folgen: `tests/auditView.test.ts` („Katalog: jedes im Code geschriebene
  Audit-Event ist lesbar beschrieben“) war seit dem Merge von PR #142 rot auf
  `main`, und die Sizing-/Guardrail-Entscheidungen erschienen im Audit-Viewer
  nur über den `UNKNOWN_EVENT_SPEC`-Fallback (ohne Label, Kategorie,
  Erklärung). Jetzt: vier Einträge (Kategorie `risk`, erwartete Stufe `WARN`)
  mit Headline, Erklärung und Fakten-Sektionen — Sizing: Instrument, Code
  `sizing:atr-unknown:SYMBOL`, Notiz (+ Regel-ID im Mikro-Pfad);
  Cluster-Exposure: Urteil (VIOLATION/STALE), Code
  (`cluster-exposure:max-per-cluster:N` / `cluster-exposure:correlation-stale`),
  Würde-blockieren-Flag, offene Positionen, Cluster + Zählung gegen
  `RISK_MAX_PER_CLUSTER`, wirksame Schwelle/Fenster, Datenstand der
  Korrelationsmatrix (fehlend ⇒ „fail-closed“ hervorgehoben). Neuer Render-
  Test in `tests/auditView.test.ts` (26 Tests, vorher 24/25).
  Warum es durchrutschte: PR #142 hat `npm test` nicht ausgeführt
  („läuft in der CI“) — die CI führt aber nur `typecheck` + `docs:validate`
  aus. Die Folge-PRs #143 und #145 haben den Failure regelkonform (R11) als
  „GAP-04-Scope“ notiert statt still mitzufixen.

### Geändert

- **Feature-Gap-Audit 2026-09-18 — Status abgeschlossen:**
  `docs/audits/2026-09-18-feature-gap/remediation/TRACKING.md` führt jetzt
  **alle zehn Findings als `FIXED`** (GAP-02 v1.42.0 · GAP-03 v1.43.0 ·
  GAP-05 v1.44.0 · GAP-10 v1.45.0 · GAP-06 v1.46.0 · GAP-07 v1.47.0 ·
  GAP-04 v1.48.0 (+ Katalog-Nachtrag v1.51.1) · GAP-08 v1.49.0 ·
  GAP-09 v1.50.0 · GAP-01 v1.51.0) mit PR-Belegen (#136–#145; die bisher
  fehlenden Nummern #140/#141/#142/#144 nachgetragen). Neun Zeilen standen
  seit dem jeweiligen Merge fälschlich auf `IN_PROGRESS` — der Workflow-
  Schritt „nach Merge `FIXED`“ hatte keinen Eigentümer. Grundlage ist der
  Status-Review `remediation/STATUS-REVIEW-2026-09-19.md` (PR-Status,
  Artefakt-Existenz, Flags, Docs und **vollständiger Testlauf inklusive der
  DB-gegateten Suites** gegen eine lokale PostgreSQL-18-Instanz). Konsistent
  nachgezogen: Audit-README (Findings-Index + Status-Header), `docs/README.md`
  (Audit-Zeile), Finding GAP-04 („Nachtrag v1.51.1“). ENV-01 bleibt OPEN.
- **`.gitignore`:** `/data/alerts.ndjson` (append-only Datei-Sink des
  Alert-Dispatchers, GAP-10 v1.45.0) ist jetzt wie `/data/eval`,
  `/data/reconciliation` und `/data/backtest` von der Versionierung
  ausgeschlossen — ein lokaler Alarm hinterließ bisher eine untracked Datei
  mit Betriebsdaten im Arbeitsbaum.

## [1.51.0] — 2026-09-19 · feat(backtest): Regelbasierte Backtesting-Engine mit Walk-Forward-Fenstern, Paper-Ausführung & persistierten Runs (GAP-01)

### Hinzugefügt

- Paper-Ausführungspfad der Backtest-Engine (`src/backtest/paperExecution.ts`,
  `executionModel: "paper"`): Einstiegs- und Ausstiegs-Fills laufen durch
  DIESELBE deterministische `FillSimulator`-Klasse wie der PaperBroker
  (kein zweiter Kosten-Code-Pfad); Kerzen → Quotes via `snapshotFromLastPrice`
  über das Spread-Modell (Registry-Spread → kalibrierter Fallback); Funding
  über DIESELBE `FundingAccrualEngine`/`computeFunding`-Formel wie der
  Paper-Monitor (nur Registry-Perpetuals, sonst fail-safe Spot-Default).
  SL/TP-Trigger-Erkennung mit Stop-Vorrang bei Kollision.
- Walk-Forward-Validierung (`src/backtest/walkforward.ts`): rollierende
  IS/OOS-Fenster (`WF_IS_WINDOW_DAYS` Default 90, Bounds [14, 720];
  `WF_OOS_WINDOW_DAYS` Default 30, Bounds [7, 180]; `WF_MAX_SPAN_DAYS`
  Default 730, Bounds [30, 3650]), nur vollständige Fenster, OOS kachelt
  lückenlos/überlappungsfrei; Report je Fenster (Kennzahlen + sha256
  Trade-Hash) + OOS/IS-Aggregate (aus Summen neu berechnet); strikte
  Zeitmaske (Daten ≤ t, Fenster-Clips); Determinismus (zwei Läufe ⇒
  byte-identischer Report); fail-closed (`walkforward:insufficient-span`,
  `walkforward:no-candles`). Kennzahlen aus `src/portfolio` (keine Duplikate),
  kein LLM-Import (Architektur-Test).
- Run-Persistenz (`backtest_runs`, append-only, Migration
  `drizzle/2026-09-19_backtest_runs.sql`): ein Walk-Forward-Lauf = EINE Zeile
  mit `paramsJson` (Regel + Fenster + Kostenprofil), `metricsJson`
  (OOS/IS-Aggregate), `windowsJson` (Fensterdetails) und `codeVersion`.
- CLI `scripts/run-backtest.ts` (`npm run backtest`): Flags `--instrument`
  `--timeframe` `--from` `--to` `--rule-id`/`--rule-file` (XOR)
  `--is-days`/`--oos-days` `--skip-db`; schreibt Report-JSON +
  MD-Zusammenfassung nach `data/backtest/` und die `backtest_runs`-Zeile
  (fail-closed, Exit 1 bei Flag-/Regel-/Daten-/DB-Fehlern).
- Read-API `GET /api/firm/backtests` (Liste, `?limit=1..100`) und
  `GET /api/firm/backtests/[id]` (Detail, 404 wenn unbekannt): `firm.read`
  erforderlich (SEC-02-Muster, no-store), DB-Ausfall ⇒ 503 mit Hinweis.
  KEIN POST-Endpunkt — Runs entstehen nur via CLI.
- Neue Doku `docs/BACKTESTING.md` (Architektur, Zeitmaske, Kostenmodell,
  Walk-Forward, Persistenz, CLI-Referenz, Anti-Overfitting-Grenzen);
  Katalog-Eintrag (`docsCatalog`), Flags in `CONFIGURATION.md` +
  `.env.example`.

### Fixiert

- Synthetischer Fallback in Step 8 (`08-backtest-verification`) entfernt
  (Audit 2026-09-18, GAP-01 D4): Bei < 5 Kerzen gab es eine ERFUNDENE
  Mindestbewertung (u. a. Sharpe 1.0, Sortino 1.2, `verified=true`) statt
  einer Messung. Jetzt fail-closed: `verified=false`, sichtbarer Status
  `DATA_UNAVAILABLE`, neutrale Null-Kennzahlen, maschinenlesbarer Grund
  `data:insufficient-candles:<n>-of-5-minimum`, `CYCLE_STEP_SKIPPED`-Audit
  und WARN-Log; Summary zählt `unavailable`. Zugehörige Step-Tests
  sinngemäß auf den Fail-closed-Pfad umgestellt (Red/Green dokumentiert in
  `tests/backtest.step.nosynthetic.test.ts`).

## [1.50.0] — 2026-09-19 · feat(reconciliation): Periodischer Reconciliation-Job, Differenz-Klassifikation & idempotente Order-IDs (GAP-09)

### Added

- Periodischer Reconciliation-Job (`src/brokers/reconciliation.ts`, `runReconciliation`):
  Abgleich von Broker-Positionen, Account-Guthaben und Ledger ↔ DB (`positions`,
  `orderIntents`, `equity_snapshots`). Report-Generierung mit Persistenz nach
  `data/reconciliation/last-report.json` via `resolveRuntimePath()`.
- Reine Differenz-Klassifikation (`classifyDifferences`):
  - `PRICE_DRIFT`: Tolerierbar bei Kursdifferenzen innerhalb `RECON_PRICE_DRIFT_PCT`
    (Default 1 %, Bounds [0.01, 10]); wird nur reportet. Überschreitung gilt als kritisch.
  - `QTY_MISMATCH`: Positionsmengen- oder Richtungsabweichung (kritisch).
  - `PHANTOM_POSITION`: Position existiert nur am Broker, fehlt in der DB (kritisch).
  - `MISSING_POSITION`: Position existiert nur in der DB, fehlt am Broker (kritisch).
  - `BALANCE_MISMATCH`: Kassen- oder Equity-Abweichung (kritisch).
  - `INVARIANT_VIOLATION`: Bruch der Paper-Ledger-Invarianten (kritisch).
- Pause-Pfad (`RECON_PAUSE_ON_MISMATCH`, Default false):
  Bei kritischer Diskrepanz wird der prozessweite Kill-Switch aktiviert
  (`killSwitch.pull("recon:<klasse>")`), in `kill_switches` persistiert und ein
  `CRITICAL`-Alert über den AlertSink emittiert. Auto-Flatten ist strikt
  verboten; Re-Arm erfordert weiterhin die manuelle Challenge.
- Einheitliches Client-Order-ID-Schema `atf-<orderIntentId-kurz>` (`buildClientOrderId`):
  Deterministische Ableitung der `clientOrderId` aus der Order-Intent-ID für
  Bitunix- und Alpaca-Adapter. Retry nach Timeout wiederholt dieselbe ID,
  wodurch Venue- und lokale DB-Deduplizierung Doppel-Orders sicher verhindern
  (`submitWithIntent`).
- Paper-Invarianz-Selbsttest (D4):
  Automatische Prüfung aller Ledger-Invarianten (`freeCash >= 0`, `Summe Notional <= equity`,
  `fees >= 0`, keine negative Menge, `equity = freeCash + Summe Einstandswerte ± unrealizedPnl`).
  Verletzungen werden als `INVARIANT_VIOLATION` auditiert und alarmiert.
- CLI-Tool `scripts/reconcile.ts` (und npm run script `reconcile`):
  Ad-hoc-Reconciliation für beliebige Venues mit Report-Ausgabe und Statuscode-Signalisierung.
- Scheduler-Integration (`src/instrumentation.ts`):
  Periodischer Aufruf alle `RECON_INTERVAL_MINUTES` Minuten (Default 60, Bounds [5, 1440]).

## [1.49.0] — 2026-09-19 · feat(llm): Plausibilitäts-Schicht, Prompt-Eval-Harness & Turn-Budget (GAP-08)

### Added

- Plausibilitäts-Schicht nach der Schema-Validierung
  (`src/cycle/plausibility.ts`): Monotonie je Richtung (`MONOTONICITY`),
  Preisband um Known-Good-Kurse (`PRICE_RANGE`), Confidence-vs.-Begründung
  (`RATIONALE_MISSING`), regex-basierter Zahlenbezug (`HALLUCINATED_PRICE`).
  Strukturierte Befunde `{code, field, detail}`; genau EIN Retry mit
  Fehlermeldungs-Kontext, danach deterministischer Skip (leerer Fallback +
  `CYCLE_STEP_SKIPPED` mit Grund `plausibility:CODE`, z. B.
  `plausibility:MONOTONICITY,PRICE_RANGE`) + sichtbarer `plausibility`-Block
  in `07-research.json` / `02-macro-analyst.json`. In Research- und
  Makro-Step verdrahtet (`spec.plausibility`); auch eskalierte Antworten
  werden plausibilisiert (ohne weiteres Retry). Flags:
  `PLAUSIBILITY_PRICE_BAND_PCT` (15, [1, 90]),
  `PLAUSIBILITY_MIN_RATIONALE_CHARS` (40, [0, 1000], `0` = Regel aus).
- Prompt-Eval-Harness (`npm run eval:prompts`): Golden-Dataset mit 12
  Fixtures (`tests/fixtures/golden/<step>/*.json`), Offline-Default
  (deterministisch, byte-identisch), JSON- + MD-Reports nach `data/eval/`
  (`EVAL_OUTPUT_DIR`/`--out-dir`), Exit 0/1/2
  (bestanden/Regression/Fixture-Fehler), optionaler Provider-Rauchtest
  (`--provider`, nur mit explizitem Flag).
- Turn-Budget-Hartdeckel (`src/routing/turnBudget.ts`): `TurnBudget` je
  Agenten-Turn (Hauptaufruf + Retries) — `LLM_MAX_TOKENS_PER_TURN` (20000,
  [1000, 200000]) + `LLM_MAX_TURN_MS` (120000, [10000, 900000],
  Aufrufgrenzen-Prüfung). Überschreitung → `TurnBudgetExceededError` +
  Routing-Audit `llm-budget:tokens`/`llm-budget:time` (`budget_blocked`,
  Sicherheitsklasse); niemals Fallback-Umwandlung. Tages-Deckel und
  Einzelaufruf-Limits unverändert.

### Docs

- Neuer `docs/LLM_ROUTING.md`-Abschnitt 17 (Schicht/Eval-Harness/Turn-Deckel
  inkl. Heuristik-Grenzen), `CONFIGURATION.md`-Sektion („Plausibilität,
  Eval-Harness & Turn-Budget“), `.env.example`-Flags, Fixture-README mit
  Pflege-HowTo.

## [1.48.0] — 2026-09-19 · feat(risk): Vol-Sizing + Korrelations-Exposure-Limits im Order-Pfad (GAP-04)

**Hintergrund:** Laut Feature-Gap-Audit 2026-09-18
([GAP-04](docs/audits/2026-09-18-feature-gap/findings/GAP-04-vol-sizing-correlation-limits.md))
begrenzte `riskGuard` `maxPositionPct` **fix** (LIMIT_CEILINGS-Konvention),
`adaptiveRisk` skalierte per Vol-Regime — aber es gab kein ATR-basiertes
Sizing, keinen Fractional-Kelly-Deckel, und die Cluster-Mathematik aus
`src/portfolio` war **nicht** als Guardrail im Order-Pfad verdrahtet: 5
„unabhängige“ Trades konnten in Wahrheit ein BTC-Beta-Trade sein. Dieses
Release schließt das Delta (PROMPT-04 der Remediation-Serie): Größe nach
Volatilität, Exposure nach Korrelations-Clustern — alles geklemmt, alles
fail-closed, Rollout bewusst **monitor-first** (Default: sichtbar machen,
keine Wirkung). Paper-only, keine neuen Runtime-Dependencies, keine
Schema-Änderung. Umsetzung: Branch `arena/01a0b953-ai-trading-firm`.

### Hinzugefügt

- **ATR-/Vol-basiertes Position-Sizing** (`src/lib/positionSizing.ts`,
  D1) — reine, deterministische Funktion `computePositionSize()`:
  `qty = (equity · riskPerTradePct) / |entry − stop|`. Stop-Auflösung:
  expliziter Stop (seitenkonsistent) → **ATR-Fallback-Stop**
  `entry − k·ATR` (`RISK_ATR_STOP_MULT`, Default 2, Bounds [0.5, 6]) →
  **UNKNOWN-Fallback** auf die heutige Basis-Größe (`defaultStopLossPct`)
  mit Kennzeichnung + Audit-Notiz (Muster adaptiveRisk v1.36.21 — kein
  Block, kein stiller Wert). **Fractional-Kelly als Obergrenze**:
  `maxNotional = equity · RISK_KELLY_FRACTION · f*`
  (`f* = (b·p − (1−p))/b` aus Trefferquote/Payoff des Trade-Journals,
  GAP-03; `RISK_KELLY_FRACTION` Default 0 = aus, Bounds [0, 1]; wirkt nur
  mit ausreichender Stichprobe, sonst dokumentiert wirkungslos;
  `f* ≤ 0` → keine Größe `kelly:no-positive-edge`). Ergebnis **immer** an
  die bestehenden Grenzen geklemmt (`maxRiskPerTrade` vor der Formel,
  `maxPositionPct`/Missions-Cap danach — Sizing verschärft, lockert nie);
  `equity`/`entry ≤ 0` → `RiskValidationError` (fail-closed). Verdrahtet in
  beiden Order-Pfaden: `src/lib/engine.ts` (LLM-Turn) und
  `src/lib/microExecutor.ts` (Regel-Executor, ATR aus der
  Rolling-Serie — Hot-Path bleibt I/O-frei).
- **`atr()` in Preiseinheiten** in `src/lib/indicators.ts` (einfache
  Wilder-Näherung, `null` bei unzureichender Historie — der Sizing-Pfad
  wertet das als UNKNOWN); `atrPct` rechnet jetzt darüber (Ergebnis
  unverändert).
- **Cluster-Exposure-Guardrail, Schicht 3** (`src/lib/clusterExposure.ts`,
  D2) — vor der Freigabe wird das neue Symbol gegen die **offenen
  Positionen** korrelationsgeclustert: `correlationMatrix` +
  `correlationClusters` **aus `src/portfolio` importiert** (keine
  Duplikation), logarithmische Renditen über gemeinsame Zeitstempel aus dem
  lokalen HistoricalStore (`1h`-Reihe, Fenster
  `RISK_CORR_WINDOW_CANDLES` Default 90, Bounds [30, 365]), Single-Linkage
  mit `|ρ| ≥ RISK_CORR_THRESHOLD` (Default 0.7, Bounds [0.3, 0.99]), Limit
  `RISK_MAX_PER_CLUSTER` (Default 3, Bounds [1, 10]) offene Positionen je
  Cluster. **Fail-closed Stale-Policy:** fehlende/veraltete Daten (> 24 h,
  < 20 gemeinsame Renditen, nicht auflösbares Symbol) → enforce lehnt ab
  (`cluster-exposure:correlation-stale`), statt zu raten. Berechnung nur je
  Order-Prüfung mit TTL-Cache (`RISK_CORR_CACHE_TTL_MS` Default 900000,
  Bounds [60000, 3600000]; Key = Symbol-Menge + Fenster + Schwelle) — kein
  Hintergrund-Job.
- **Rollout-Modus** `RISK_CLUSTER_LIMITS_MODE` (Default `monitor`):
  `monitor` = Entscheidungspfad unverändert, Würde-Prüfung nur als
  Audit-Notiz + Log (`CLUSTER_EXPOSURE_MONITOR`, `wouldBlock: true`);
  `enforce` = echte Ablehnung (`cluster-exposure:max-per-cluster:N`,
  Audit `CLUSTER_EXPOSURE_BLOCKED`). Unbekannter Wert → `monitor` +
  Warnung.
- **Transparenz** (D3): `GET /api/firm/risk` zeigt effektive Sizing- und
  Cluster-Parameter (inkl. Bounds), Kelly-Edge-Status (`off`/`ok`/
  `unavailable` + Statistik), Cache-Zustand, offene Positionen und aktuelle
  Cluster sowie die UNKNOWN-Zustände (`unknown.correlationUnavailable`).
  Je Guardrail-Entscheidung revisionssichere audit_log-Einträge
  (`security`-Klasse, at-least-once); Sizing-UNKNOWN wird als
  `POSITION_SIZING`/`POSITION_SIZING_UNKNOWN` mit Code
  `sizing:atr-unknown:SYMBOL` protokolliert.

### Geändert

- Order-Pfade (Engine + Mikro-Executor) nutzen jetzt
  `computePositionSize()` statt der inline aufgerufenen
  `missionSizedNotional()` — mit den Default-Parametern (expliziter Stop,
  Kelly aus) **byte-identische Notional-Werte** wie vorher; veränderlich
  werden nur degenerative 0-Stop-Regeln (ATR-Fallback statt 0-Distanz).

### Behoben

- 0-Stop-Regeln im Mikro-Executor produzierten früher einen Stop **am
  Entry-Preis** (`stopLoss = price`) — jetzt ATR-Fallback-Stop (bzw.
  Basis-Stop bei UNKNOWN).

### Tests & Checks

- Neu: `tests/positionSizing.test.ts` (14), `tests/riskGuard.cluster.test.ts`
  (14). Bestehende riskGuard-/portfolio-/microExecutor-/indicators-Tests
  unverändert grün (Defaults = kein Verhaltensbruch; `monitor` blockt nie).
- Pflicht-Checks der Serie (typecheck/lint/test/docs:validate) laufen in
  der CI; Details im PR.

### Konfiguration (neue Flags, Details: CONFIGURATION.md „Sizing & Cluster-Limits“)

| Flag | Default | Bounds |
| --- | --- | --- |
| `RISK_ATR_STOP_MULT` | `2` | [0.5, 6] |
| `RISK_KELLY_FRACTION` | `0` (aus) | [0, 1] |
| `RISK_CLUSTER_LIMITS_MODE` | `monitor` | `monitor` \| `enforce` |
| `RISK_CORR_THRESHOLD` | `0.7` | [0.3, 0.99] |
| `RISK_MAX_PER_CLUSTER` | `3` | [1, 10] |
| `RISK_CORR_WINDOW_CANDLES` | `90` | [30, 365] |
| `RISK_CORR_CACHE_TTL_MS` | `900000` | [60000, 3600000] |

### Doku

- `docs/PORTFOLIO_ANALYTICS.md` §10 „Sizing & Cluster-Limits im
  Order-Pfad“ (Formeln, Wiederverwendung `correlation.ts`, Rollout-Modus),
  `docs/HANDBUCH.md` §9.5 (Ops: monitor→enforce-Umschaltung + Status-Check),
  `CONFIGURATION.md` + `.env.example` (Flags), Finding
  `GAP-04-vol-sizing-correlation-limits.md` („Umsetzung“) und
  `remediation/TRACKING.md` (GAP-04 → IN_PROGRESS).

## [1.47.0] — 2026-09-19 · feat(marketdata): Datenqualitäts-Layer & deterministische Multi-TF-Aggregation (GAP-07)

**Hintergrund:** Laut Feature-Gap-Audit 2026-09-18
([GAP-07](docs/audits/2026-09-18-feature-gap/findings/GAP-07-data-quality-multi-timeframe.md))
gab es keine Gap-Detection in Kerzenserien, keinen Outlier-/Wick-Filter, keine
Plausibilitätsregeln (OHLC ≤ 0, high < low, close außerhalb [low, high],
Duplikate), keine deterministische 1h→4h/1d-Aggregation und keinen
Zweitquellen-Cross-Check. „Garbage in, garbage out“ gilt für LLM-Agenten
doppelt — eine falsche Candle produziert eine überzeugend formulierte
Fehlentscheidung. Dieses Release schließt das Delta (PROMPT-07 der
Remediation-Serie): paper-only, keine neuen Runtime-Dependencies,
fail-closed, Rollout bewusst **log-first** (Default: sichtbar machen, keine
Wirkung). Grundprinzip: Qualitätsbefunde werden **sichtbar klassifiziert**
(MDERR-Stil) — gespeicherte Historie wird nie still verändert, und echte
Flash-Moves werden nicht weggefiltert. Umsetzung: Branch
`arena/01a0b751-ai-trading-firm`.

### Hinzugefügt

- **Qualitäts-Validierung** (`src/marketdata/quality.ts`,
  `validateCandleSeries()`) mit vier neuen, in die MDERR-Taxonomie
  aufgenommenen Klassen (`src/lib/marketDataErrors.ts`, IDs
  `QUALITY_GAP`/`QUALITY_OUTLIER`/`QUALITY_INVALID`/`QUALITY_DUPLICATE`,
  dazu `QUALITY_CROSSCHECK`):
  - `GAP` — fehlende Intervalle; Befund an der **ersten fehlenden Position**
    (exakt ein Intervall Abstand = **kein** Befund),
  - `INVALID` — OHLC ≤ 0 / nicht endlich, `high < low`, `close` außerhalb
    `[low, high]`,
  - `OUTLIER` — Wick **oder** Körper **streng** > `MARKETDATA_OUTLIER_ATR_MULT`
    × Volatilitäts-Baseline (Default **25**, Bounds [5, 200] — bewusst
    großzügig, damit echte Flash-Moves durchkommen; **Grenzwert-Test**:
    exakt mult × Baseline = kein Befund). Baseline = leave-one-out-Mittel der
    True-Ranges der strukturell gültigen Kerzen (ein Spike bläst seine eigene
    Schwelle nicht auf),
  - `DUPLICATE` — doppelter Zeitstempel.
- **Qualitäts-Report je Instrument** (`data/marketdata/quality-report.json`,
  gitignored, atomar 0600, `resolveRuntimePath` — derselbe Cross-Prozess-Pfad
  wie das Fehler-Manifest): persistiert vom Sync-CLI, enthält Befunde +
  Zähler je Reihe (Instrument ⟂ Timeframe). **Die Historie-Datei wird vom
  Qualitäts-Layer nie berührt** (Test belegt: Eingabe bleibt freeze-intakt).
- **Lesepfad-Modi `MARKETDATA_QUALITY_MODE`:** `log` (**Default**: nur
  sichtbar machen — Report + Log-Zeile + Metrik, keine Wirkung auf Scanner) |
  `strict` (fail-closed: Instrumente mit `INVALID`-Befund behandelt der
  Scanner wie `DATA_UNAVAILABLE` — existierende Stale-Fallback-Kette,
  `data-unavailable`-Ablehnung, nie `min-candles`; verdrahtet in
  `scripts/run-scan.ts` + `ScannerService.refresh`).
- **Stale-Guard je Instrument/Timeframe** (D2): konfigurierbare Schwellen
  `MARKETDATA_STALE_1H_HOURS` (Default **26**, Bounds [2, 168]),
  `MARKETDATA_STALE_4H_HOURS` (Default 104, Bounds [8, 672]),
  `MARKETDATA_STALE_1D_HOURS` (Default 624, Bounds [48, 4032]); Ausweis als
  **Zähler** (`staleSeries`/`staleByTimeframe`) im Sync-Status
  (`data/market-sync-status.json`), damit Ops-Center/Scanner gut degradieren
  (keine Symbole im Status — geschlossene Security-Policy).
- **Deterministische Multi-TF-Aggregation** (`src/marketdata/aggregate.ts`,
  `aggregateCandles()`): 1h → 4h/1d mit **UTC-Anker** (4h: 00/04/08/12/16/20
  UTC, 1d: 00:00 UTC), OHLCV-Korrektur (open/close erst/letzter, high/low
  max/min, volume Summe), **unvollständige Bucket werden NIEMALS aggregiert**
  (als `partial` gezählt und ausgeschlossen), Zeitmaske (nur abgeschlossene
  Perioden ≤ `nowMs`), Konsistenz-Check (`checkAggregationConsistency()`).
  Deterministisch: zwei Läufe ⇒ byte-identisches Ergebnis (Test),
  Ankunftsreihenfolge der Quelle irrelevant (interne Sortierung).
- **Zweitquellen-Cross-Check** (D4, **Default off** — Rate-Limits!):
  optionale Adapter-Methode `getCrosscheckCandles()` am
  `MarketDataAdapter`-Contract (Adapter-Registry-Muster);
  `MARKETDATA_CROSSCHECK` + `MARKETDATA_CROSSCHECK_TOLERANCE_PCT`
  (Default **1**, Bounds [0.1, 10]); Abweichung > Toleranz ⇒
  `QUALITY_CROSSCHECK`-Befund + Log. **Keine neue Venue-Anbindung** in diesem
  PR (Scope-Disziplin) — ohne implementierende Methode ist der Cross-Check
  ein no-op.
- **Metrik** `market_data_quality_findings_total` (Label `class`, prozesslokal
  wie der Fetch-Counter; in `prometheusMetrics()` exponiert) +
  `[market-sync] quality: …`-Zeile (nur bei Befunden, Zähler ohne Symbole).
- **Sync-CLI:** `--aggregate` (Env `MARKET_SYNC_AGGREGATE`, Default off) —
  aggregiert nach dem Backfill die persistierten 1h-Reihen zu 4h/1d und
  appendet sie als **neue** Timeframe-Reihen (`feed: "agg:1h"`); die 1h-Quelle
  bleibt unangetastet.

### Geändert

- `MarketDataErrorReason` um die fünf `QUALITY_*`-Klassen erweitert
  (geschlossene Aufzählung; `retryable` = nein, nie im Fetch-Backoff).
- **Schreibpfad-Verdrahtung:** der Sync validiert jede frisch gepflögte
  Serie (read-only), der Report landet im `SyncResult.qualityReport` +
  Metrik + Log. Qualitätsbefunde zählen **nicht** als Fetch-Fehler:
  `degraded`/Exit-Code bleiben im `log`-Modus entkoppelt, und
  `syncErrorsToDataErrors()` lässt `QUALITY_*` aus dem
  Datenfehler-Manifest heraus (sonst würde der log-Modus Instrumente
  fälschlich als `data-unavailable` abwerten).
- `VenueSyncStatus` um `staleSeries`/`staleByTimeframe` (nur Zähler,
  Timeframe-Keys gegen erlaubte Allowlist validiert).

### Tests

- Neu `test/marketdata/quality.test.ts` (35 Tests): GAP-Position exakt an
  Intervallgrenzen, INVALID-Fälle, **Flash-Move-Schutz** (10 %-Crash unter
  25×Baseline bleibt erhalten, exakter Grenzwert ⇒ kein Befund),
  Determinismus (byte-identisch), Immutabilität (Freeze-Vergleich),
  Report-Roundtrip, strict ⇒ `DATA_UNAVAILABLE`-Fallback (log ⇒ leer),
  Stale-Guard mit Fake-Clock, Cross-Check (striktes `>`), Config-Bounds,
  Metrik-Counter, Sync-Integration (log-Modus, Cross-Check on/off).
- Neu `test/marketdata/aggregate.test.ts` (14 Tests): 4h-/1d-UTC-Anker,
  OHLCV-Handrechnung, Envelope-Konsistenz, unvollständige Schlusskerze
  ausgeschlossen (15/16-Stunden- und 23/24-Fälle), Zeitmaske,
  Determinismus (inkl. Reihenfolge-Unabhängigkeit), Freeze, Vertrag.
- `test/marketdata/cli.test.ts`: `--aggregate`-Parsing (Default off,
  Boolean-Grammatik, Hilfe).

### Keine Änderungen (bewusst)

- `data/history/candles.ndjson` und jede gespeicherte Reihe bleiben vom
  Qualitäts-Layer **unangetastet** (Report ist ein neues Artefakt; Aggregation
  appendet nur neue Timeframe-Reihen).
- Der Bitunix-Adapter erhält **keine** Zweitquellen-Methode (keine neue
  Venue-Anbindung; Interface + Vertrag + Flag nur).

## [1.46.0] — 2026-09-19 · feat(risk): Markt-Regime-Klassifikator + Regime-Gate für Strategie-Gewichtung (GAP-06)

**Hintergrund:** Laut Feature-Gap-Audit 2026-09-18
([GAP-06](docs/audits/2026-09-18-feature-gap/findings/GAP-06-regime-gate.md))
klassifizierte `adaptiveRisk.ts` zwar das Volatilitäts-Regime
(NORMAL/ELEVATED/EXTREME, mit Hysterese) — aber ausschließlich als
Risikofaktor. Ein Trend/Range/Crash-Klassifikator existierte nicht, und
Agenten-/Strategiegewichte reagierten nicht auf das Markt-Regime:
Mean-Reversion-Signale liefen in Trendmärkten ungedämpft (und umgekehrt).
Dieser Release schließt das Delta (PROMPT-06 der Remediation-Serie):
paper-only, keine neuen Runtime-Dependencies, Fail-closed, Rollout bewusst
monitor-first. Umsetzung: Branch `arena/01a0b708-ai-trading-firm`.

### Hinzugefügt

- **Markt-Regime-Klassifikator** (`src/lib/marketRegime.ts`,
  `classifyMarketRegime()`): deterministisch (KEIN LLM —
  Architektur-Test `tests/marketRegime.test.ts`), nur aus Kerzen
  (Zeitmaske: nur Daten ≤ t): ADX (Wilder, neu in `src/lib/indicators.ts`
  inkl. Handrechnungs-Referenztest), OLS-Regressions-Slope über
  Schlusskurse, realisierte Volatilität als Perzentil über den Lookback
  (Entartungsschutz bei konstanter Vol), Drawdown vom Fensterhoch. Fünf
  Regimes mit strikter Priorität **CRASH > HIGH_VOL > TREND\_\* > RANGE**;
  unter 30 Kerzen `UNKNOWN` — nie eine stille Rate-Klassifikation.
- **Regime-Hysterese** (`MarketRegimeStateMachine`, Muster an
  `adaptiveRisk`-`RegimeStateMachine` angelehnt): Eskalation (Schwere ↑)
  sofort, Seitwärts-/De-Eskalation erst nach `REGIME_CONFIRM_CANDLES`
  (Default 3, Bounds [1, 20]) konsekutiven bestätigenden Bewertungen —
  einzelne Gegenkerzen wechseln das Regime nicht (Whipsaw-Schutz).
- **Regime-Gate** (`applyRegimeGate()`): Mapping Regime → Dämpfungsfaktor
  je Strategieklasse (`mean-reversion`/`trend`/`breakout`), konfigurierbar
  über `REGIME_GATE_FACTORS` (Grammatik `REGIME:klasse=faktor,…`, Werte
  geklemmt [0, 2]). Defaults: mean-reversion ×0.5 in TREND_UP/TREND_DOWN,
  breakout ×0.5 in RANGE, sonst ×1. Umsetzung als **Datenkontext** für
  ruleEngine/Approver (Faktor multipliziert das Signalgewicht), NICHT als
  hartes Veto. Modi `REGIME_GATE_MODE`: `off` | `monitor` (**Default**:
  Ausweis + Audit, keine Wirkung) | `enforce`; unbekannter Wert →
  fail-closed `monitor`. `UNKNOWN` → Faktor 1 + Kennzeichnung, nie still.
  - *Engine-Turn:* Regime-Klassifikation über dieselben Kerzen des
    Markt-Kontexts (kein Extra-Abruf); `REGIME-GATE`-Trace + Prompt-Zeile
    (monitor: Ausweis; enforce: zusätzlich gedämpftes Risikobudget der
    Mission). `off` lässt den Prompt byte-identisch.
  - *Mikro-Executor:* nur `enforce` dämpft das Regel-Risikobudget
    (`riskBudgetPct × Faktor`, gegen `maxRiskPerTrade` geklemmt); Regime
    aus dem RAM-Snapshot (Seed + Monitor-Tick), fehlender Stand →
    fail-safe Faktor 1; Audit `REGIME_GATE_APPLIED`
    (`regime-gate:SYMBOL:KLASSE:REGIME`).
  - *Strategieklasse:* deterministisch aus dem Mission-Template abgeleitet
    (`strategyClassOfTemplate`); ohne Klasse Faktor 1.
- **Sichtbarkeit:** Regime je Instrument in der Risk-Sektion des
  Ops-Centers (Modus + Regime nach Schwere sortiert, inkl. Begründung),
  Regime-Verlauf als Cycle-Artefakt
  (`artifacts/YYYY-MM-DD/daily/regime-history.json`), Audit je
  Regime-Wechsel (`REGIME_CHANGE`, Code `regime:SYMBOL:VON→NACH`) — beides
  im Audit-Katalog (`src/lib/auditView.ts`) dokumentiert.
- **Konfiguration:** `REGIME_LOOKBACK_CANDLES` (Default 100, Bounds
  [20, 500]), `CRASH_DRAWDOWN_PCT` (10, [3, 50]), `HIGH_VOL_PERCENTILE`
  (90, [50, 99]), `REGIME_CONFIRM_CANDLES` (3, [1, 20]), `REGIME_TREND_ADX`
  (25, [10, 60]), `REGIME_TREND_SLOPE_PCT` (0.05, [0.005, 1]) — alle in
  `.env.example` + `CONFIGURATION.md` (§„Regime-Gate“).
- **Doku:** neues `docs/REGIME_GATE.md` (Klassifikator-Logik, Prioritäten,
  Gate-Modi, Hysterese-Parameter, Abweichungen/Offene Punkte), im
  Doku-Katalog registriert.
- **Tests:** `tests/marketRegime.test.ts` (Golden-Cases je Regime inkl.
  Grenzfälle, Hysterese — Gegenkerzen/Bestätigung/De-Eskalationsfenster,
  Determinismus per Hash, Gate-Modi exakt, Konfig-Klemmung,
  Architektur-Garantie „kein LLM im Klassifikator“); ADX-Mathe gegen
  Handrechnung in `tests/indicators.test.ts`.

### Geändert

- **Monitor-Tick:** bewertet zusätzlich das Markt-Regime der offenen
  Positionen (best-effort, fail-soft, Min-Interval je Symbol; nur ohne
  injizierte Test-Kurse) — `TickResult.marketRegimes` neu.
- **Mikro-Executor:** RuleCache lädt `missions.template_id` mit (Quelle
  der Strategieklasse); Seed wertet mit den Seed-Kerzen zugleich das
  Regime aus (auch im separaten `npm run micro`-Prozess).
- **Cycle-Artefakte:** `saveDailyCycleArtifacts()` schreibt zusätzlich
  `regime-history.json` (nur, wenn im Prozess mindestens ein Instrument
  bewertet wurde).

**Keine Verhaltensänderung im Default:** ohne Konfiguration gilt
`REGIME_GATE_MODE=monitor` — reine Ausweisung + Audit; Entscheidungs- und
Orderpfade bleiben unverändert. `enforce` dämpft ausschließlich
Signalgewichte (nie Veto, nie über den Code-Ceilings).

## [1.45.0] — 2026-09-18 · feat(observability): Firmen-Metriken, Auto-Circuit-Breaker, Alerting & Heartbeat (GAP-10)

**Hintergrund:** Laut Feature-Gap-Audit 2026-09-18
([GAP-10](docs/audits/2026-09-18-feature-gap/findings/GAP-10-observability-circuit-breaker.md))
war die Firma im Betrieb unzureichend beobachtbar und im Grenzfall nicht
selbstschützend: `prometheusMetrics()` lieferte nur Marktdaten-/Audit-Counter,
die harten Risiko-Grenzen blockierten ausschließlich **neue** Orders (offene
Positionen liefen bei einem Bug weiter), es gab keinen Alert-Kanal und kein
Signal für einen stehenden Monitor-Tick. Dieser Release schließt das Delta
(PROMPT-10 der Remediation-Serie): paper-only, keine neuen
Runtime-Dependencies, Fail-closed, Wiederverwendung des bestehenden
Kill-Switch- und Disarm-Pfads. Umsetzung: PR
[#139](https://github.com/Kryschuuu/ai-trading-firm/pull/139)
(`arena/01a0b6a7-ai-trading-firm`).

### Hinzugefügt

- **Firmen-Metriken in `prometheusMetrics()`** (`src/lib/telemetry.ts`, jetzt
  `async`; Instrumentierung in `src/lib/broker.ts` und
  `src/routing/adapter.ts`): `firm_equity`, `firm_drawdown_pct`,
  `firm_open_positions`, `firm_realized_pnl_today` (Ledger, sonst jüngster
  `equity_snapshots`-Eintrag), `firm_metric_source{source}`,
  `firm_order_fills_total{kind,reason}`, `firm_order_rejects_total{reason}`,
  `llm_calls_total{provider,outcome}`, `llm_latency_ms_sum{provider}`. Alles
  wird aus **bestehenden** Stores gelesen (Paper-Ledger, PostgreSQL,
  In-Memory-Counter) — keine zweite Messschleife. Labels sind ausschließlich
  klassifizierte Codes (`metricLabel()`, `classifyRejectReason()`); Symbole,
  Beträge, URLs oder Tokens erscheinen nie. Ist der Firmenzustand nicht lesbar,
  werden die betroffenen Metriken **weggelassen** und mit
  `# HELP … degraded: <grund>` markiert — kein erfundener 0-Wert, kein Throw,
  kein Hänger.
- **Auto-Circuit-Breaker** (`src/lib/circuitBreaker.ts`, im Monitor-Tick nach
  der Equity-Berechnung): drei Auslöser — Drawdown ≥ `maxEquityDrawdownPct`
  (Metrik `drawdown`), Tagesverlust ≥ `dailyLossLimitPct` (`dailyLoss`),
  `RISK_MAX_CONSECUTIVE_LOSSES` Verlust-Closes in Folge
  (`consecutiveLosses`, Default 5, Bounds [2, 50]) — in dieser Prioritätsfolge.
  Aktion über den **bestehenden** Kill-Switch-Pfad: `killSwitch.pull(reason)`,
  `kill_switches`-Zeile (`triggered_by = AUTO_CIRCUIT_BREAKER`),
  `KILL_SWITCH`-Audit (CRITICAL) mit fixiertem Auslösewert
  (`metric`/`value`/`limit`/`triggeredAt`) und Alert
  `circuit-breaker:<metrik>`. Grundformat stabil:
  `auto-circuit-breaker:drawdown:0.1834`,
  `auto-circuit-breaker:consecutiveLosses:5`. **Latching:** einmal ENGAGE
  bleibt ENGAGE, kein zweites Engage/Update, keine Hysterese. `checkCircuitBreaker()`
  wirft nie; nicht lesbare Verlustserie armiert **nicht** (kein Raten).
- **Alert-Adapter** (`src/lib/alerts.ts`): `AlertSink`-Interface mit
  `LogAlertSink` (strukturiert, redigiert) und `FileAlertSink` (append-only
  NDJSON `data/alerts.ndjson` über `resolveRuntimePath()`, Modus 0600 — CLI
  und Server sehen dieselbe Datei). **Debounce** je identischem Alarm-Code
  (`ALERT_DEBOUNCE_MINUTES`, Default 30, Bounds [1, 1440]) mit Zählung
  unterdrückter Alarme (`meta.suppressedSinceLast`). **Optionaler**
  Webhook-Sink, Default **aus**: URL ausschließlich aus dem Secret-Store
  (`ALERT_WEBHOOK_URL_SECRET_NAME`, Feld `apiKey`), Timeout 5 s; die URL ist
  selbst ein Credential und erscheint nie in Logs/Fehlermeldungen (Nicht-OK →
  `webhook: HTTP <status>`). `AlertDispatcher.emit()` sammelt Sink-Fehler und
  wirft nie.
- **Heartbeat + Watchdog** (`src/lib/heartbeat.ts`, `GET /api/health`,
  `scripts/watchdog.ts` + `npm run watchdog`): Health-Payload enthält
  `monitorLastTickAt`, `monitorAgeMs`, `stale`, `staleAfterMs` (immer HTTP
  200); `stale` gilt bei Alter > `HEALTH_STALE_AFTER_MS` (Default 300 000,
  Bounds [30 000, 3 600 000]) und bei „noch nie getickt“ (fail-loud). Der
  Watchdog ist **alarm-first**: ein Lauf, kein Daemon, **kein Auto-Restart,
  keine Mutation**; Prüfung per HTTP (Default `http://127.0.0.1:$PORT/api/health`)
  oder `--source=inprocess`, Alerts `heartbeat-stale`,
  `heartbeat-health-unreachable`, `heartbeat-health-unreadable`, Exit-Codes
  0 = gesund, 1 = Alarm, 2 = Bedienfehler.

### Behoben

- **Fehlender CHANGELOG-Verweis auf Arena-Task 05 (Portfolio-Analytics)
  wiederhergestellt:** Die Doku-Konsolidierung vom 2026-09-05 hatte den
  Verweis auf Task 05 (`src/portfolio/`, `docs/PORTFOLIO_ANALYTICS.md`,
  `docs/security/SECURITY_AUDIT.md` §„Security Audit — Task 05“) im Changelog
  verloren; der Architektur-Test `tests/portfolio.architecture.test.ts`
  („Doku: CHANGELOG führt Task 05“) war dadurch **schon im Baseline-Stand
  rot**. Reine Dokumentation, kein Verhaltenswechsel — als Nebenfund
  mitkorrigiert, damit die Pflicht-Checks grün sind (siehe `TRACKING.md`,
  GAP-10-Notizen).

### Geändert

- **Verhaltensänderung (explizit):** `AUTO_CIRCUIT_BREAKER` ist per Default
  **an** — bestehende Installationen erhalten damit erstmals einen
  automatischen Not-Halt bei Grenzbruch. Der Tagesverlust-Auto-Pull existierte
  zuvor bereits im Monitor-Tick; er läuft jetzt über den zentralen Brecher mit
  einheitlichem Grund/Audit/Alert und Latching (`TickResult.dailyLossKill`
  bleibt als Feld erhalten). „Aus“ ist ein bewusster, hier dokumentierter
  Betriebsentscheid (z. B. Fehlersuche); ein unbekannter Wert schaltet den
  Schutz nicht still ab (Default + Warnung).
- **Monitor-Tick:** Schritt 3 ist `checkCircuitBreaker(...)` (vorher
  Tagesverlust-Sonderfall inline); `TickResult.circuitBreaker` beschreibt den
  Zustand (`engaged`/`latched`/`reason`); der Tick merkt sich
  `state.monitorLastTickAt` (`lastTickAt()` bleibt stabil).
- **Client-Bundle-Grenze:** `src/lib/telemetry.ts` bleibt **DB-frei** (kein
  `@/db`/`pg`); der Firmenzustand wird von `src/lib/firmState.ts`
  (server-only; Ledger zuerst, sonst jüngster `equity_snapshots`-Eintrag)
  gelesen und über `setFirmMetricStateReader()` registriert. Grund:
  `telemetry.ts` hängt über `marketData.ts`/`workshop.ts` im Import-Graph der
  Client-Komponenten — ein DB-Import dort ließ den Produktions-Build mit
  „Module not found: Can't resolve 'tls'“ (pg → Node-Builtins) scheitern.
  `prometheusMetrics()` ohne Argument nutzt den registrierten Leser, sonst
  den prozesslokalen RAM-Ledger und degradiert sauber; fehlt nur das
  Tages-P&L, wird genau diese Metrik als `degraded` markiert (kein 0-Wert).
- **`GET /api/health`:** neue Felder `monitorLastTickAt`/`monitorAgeMs`/
  `stale`/`staleAfterMs` in Erfolgs- **und** Fehlerzweig; Statuscode bleibt
  konstruktionsbedingt 200 (Liveness ≠ Readiness).

### Sicherheit / Grenzen

- **Kein Auto-Re-Arm:** Der Weg zurück bleibt ausschließlich der manuelle
  Disarm-Pfad (Admin-Permission `live.gate` + CSRF + single-use
  Challenge-Nonce ≤ 60 s, `src/lib/disarmChallenge.ts`) — unverändert und
  fail-closed (ohne Auditbeleg kein Disarm). Der Brecher setzt nur den Latch
  zurück, wenn ein Mensch entschärft hat.
- **Keine Secrets/PII** in Metrik-Labels, Alerts, Logs oder Docs; die
  Webhook-URL kommt ausschließlich aus dem Secret-Store und wird nie
  geloggt (`.env.example` enthält nur den **Namen** des Eintrags).
- **Keine neuen Runtime-Dependencies**, keine Schema-Migration; der Watchdog
  mutiert nichts (kein Restart, kein Kill, kein Flatten).

### Tests

- `tests/telemetry.firm.test.ts` (7): Firmen-Metriken im Snapshot,
  DB-Fehler → `degraded` statt Exception, keine Secrets im Output,
  Label-Whitelist, Reject-Klassifikation.
- `tests/circuitBreaker.test.ts` (12): D2 (a) Drawdown-/Tagesverlust-Auslöser
  → ENGAGE + Audit-Grund + Alert, (b) Verlustserie inkl. Priorität und
  unlesbarer Serie, (c) Flag aus + Bounds, (d) Latching + gemeldete
  Audit-Lücke, (e) kein Auto-Re-Arm (Source-Scan + Disarm-Route verlangt
  Nonce, `CSRF_INVALID` vor Nonce-Prüfung).
- `tests/alertSink.test.ts` (8): Debounce inkl. `suppressedSinceLast`,
  Sink-Fehler bricht nicht ab, Log-/File-Sink (NDJSON via
  `resolveRuntimePath`) und Webhook-Credential aus dem Secret-Store,
  Config-Bounds.
- `tests/health.heartbeat.test.ts` (5): `stale`-Grenzen mit Fake-Clock
  (`>`-Semantik: Schwelle selbst gesund), „nie getickt“ → stale,
  `HEALTH_STALE_AFTER_MS`-Clamp, Health-Payload.

### Dokumentation

- `docs/OBSERVABILITY.md`: Status-Header auf v1.45.0, neue Abschnitte
  **9. Firmen-Metriken**, **10. Auto-Circuit-Breaker**, **11. Alert-Adapter**,
  **12. Heartbeat & Watchdog** (inkl. bewusst offener Punkt „kein
  `/api/metrics`-Scrape-Endpoint“).
- `docs/OPERATIONS.md`: neues Runbook **„Auto-Breaker hat ausgelöst“**
  (Symptom → Audit lesen → Heartbeat prüfen → manuell entschärfen) inkl.
  Fehlercodes; Status-Header aktualisiert.
- `CONFIGURATION.md`: neue Tabelle „Firmen-Metriken, Auto-Circuit-Breaker,
  Alerts & Heartbeat" mit `AUTO_CIRCUIT_BREAKER`,
  `RISK_MAX_CONSECUTIVE_LOSSES`, `ALERT_DEBOUNCE_MINUTES`, `ALERT_FILE`,
  `ALERT_WEBHOOK_URL_SECRET_NAME`, `HEALTH_STALE_AFTER_MS`; `.env.example`
  ergänzt.

## [1.44.0] — 2026-09-18 · feat(paper): Server-seitiges Exit-Management — Trailing-Stop, Time-Stop, OCO-Exklusivität (GAP-05)

**Hintergrund:** Laut Feature-Gap-Audit 2026-09-18
([GAP-05](docs/audits/2026-09-18-feature-gap/findings/GAP-05-server-side-exit-management.md))
prüft der Monitor zwar serverseitig Stop-Loss/Take-Profit unabhängig von
LLM-Turns — Trailing-Stop und Time-Stop fehlten jedoch vollständig, und die
Garantie „genau **ein** Exit pro Position, auch bei parallelen Ticks/Instanzen“
war nicht belegt (Check-then-Act im Prozessspeicher). Dieser Release schließt
das Delta (PROMPT-05 der Remediation-Serie): paper-only, Fail-closed, alle
Flags per Default **aus** (= heutiges Verhalten), keine neuen
Runtime-Dependencies. Umsetzung: PR
[#138](https://github.com/Kryschuuu/ai-trading-firm/pull/138)
(`arena/01a0b5f8-ai-trading-firm`).

### Hinzugefügt

- **Trailing-Stop im Monitor-Tick** (`src/lib/exits.ts` — reine, clock-unabhängige
  `decideExit`-Entscheidung; `src/lib/monitor.ts` — Ausführung): Bewaffnung ab
  `RISK_TRAILING_ACTIVATION_PCT` % Gewinn, Stop = Kurs − `RISK_TRAILING_RETURN_PCT` %
  Rückgabeweg (LONG; SHORT gespiegelt). **Ratchet:** LONG hebt den Stop nur,
  SHORT senkt ihn nur — automatische Verengungen gibt es nicht. Trigger →
  Close mit `exitReason = TRAILING_STOP`. Aus/Bewaffnet/Stop-Level persistieren
  in `positions.trailing_armed` (NOT NULL DEFAULT false) und
  `positions.trailing_stop` (numeric NULL) — ein Prozess-Neustart verliert
  keinen erreichten Stop (crash-safe, kein Memory-Only-Zustand;
  `PaperBroker.hydrate` spiegelt den Stand ins Ledger). Migration:
  `drizzle/2026-09-18_exit_management.sql` (append-only) oder
  `npx drizzle-kit push`.
- **Time-Stop:** `RISK_TIME_STOP_HOURS > 0` schließt Positionen nach der
  maximalen Haltedauer unabhängig vom Kurs (`exitReason = TIME_STOP`,
  Audit-Eintrag). Default `0` = inaktiv.
- **OCO-Exklusivität (genau ein Exit):** Der Exit ist ein atomarer DB-Claim —
  bedingtes `UPDATE positions … WHERE id = … AND status = 'OPEN'`
  (`applyExit()` in `src/lib/monitor.ts`, `RETURNING` als Gewinner-Ermittlung).
  Zwei parallele Ticks oder zwei Instanzen können dieselbe Position nie
  doppelt schließen: der Verlierer sieht CLOSED und macht einen sauberen
  no-op (kein Doppel-Fill, kein Doppel-P&L, kein Fehler). Bei SL+TP im
  selben Intervall gilt wie bisher konservativ SL zuerst; Priorität
  SL → TP → Trailing → Time-Stop.
- **Audit je Exit:** genau ein `audit_log`-Eintrag pro Exit mit
  maschinenlesbarem Grund — Detail-Code `exit:SYMBOL:grund`, Events
  `STOP_LOSS_HIT`/`TAKE_PROFIT_HIT`/`TRAILING_STOP_HIT`/`TIME_STOP_HIT`; die
  beiden neuen Events sind im Audit-Katalog (`src/lib/auditView.ts`)
  beschriftet und erklärt. Die Bewaffnung auditiert genau EINMAL je Position
  (`TRAILING_STOP_ARMED`, Code `trailing-arm:SYMBOL`); reine
  Ratchet-Anhebungen bleiben Zustandspflege in der Positionsspalte und
  fluten den Audit-Log nicht.
- **Konfiguration (D4):** Env-Flags mit Bounds-Clamp und sicheren Defaults
  (`loadExitConfig` — dasselbe Muster wie `loadFundingConfig`, GAP-02):
  `RISK_TRAILING_ENABLED` (false), `RISK_TRAILING_ACTIVATION_PCT` (1.0,
  Bounds [0.1, 20]), `RISK_TRAILING_RETURN_PCT` (0.5, [0.1, 10]),
  `RISK_TIME_STOP_HOURS` (0 = aus, [0, 720]). Tabelle: `CONFIGURATION.md`
  („Exit-Management“), `docs/PAPER_TRADING.md` §3.3, `.env.example`.
- **Exit-Taxonomie erweitert:** `positions.exit_reason` dokumentiert jetzt
  `STOP_LOSS | TAKE_PROFIT | TRAILING_STOP | TIME_STOP | MANUAL_FLATTEN |
  AGENT_CLOSE | RULE_EXECUTION` (Kommentar in `src/db/schema.ts`).
- **Tests:** `tests/monitor.exits.test.ts` (17 Tests) — Trailing-Lifecycle
  (bewaffnen/ratcheten/auslösen, LONG+SHORT), Restart-Persistenz über
  `invalidateBrokerCache()` + Rehydrierung aus der DB, Time-Stop (Ablauf/0),
  OCO-Race (parallele `applyExit`-Gewinner-Ermittlung, `Promise.all([tick(),
  tick()])` mit Single-Flight + nachfolgender no-op-Tick, Multi-Instanz-Race
  über zwei echte Postgres-Transaktionen), Defaults-Neutralität,
  genau-ein-Audit-Assertionen; Determinismus über Fake-Clock und injizierte
  Kurse (neue `tick(forceScan, { now, quotes, skipScan })`-Optionen,
  produktionsneutral). Tick-Tests springen sauber über (skip), wenn kein
  PostgreSQL erreichbar ist — wie im Rest der Suite gilt keine DB-Pflicht.

### Geändert

- `src/lib/monitor.ts`: Die SL/TP-Prüfung nutzt jetzt `decideExit()` +
  `applyExit()` (vorher direktes `broker.close()` + unbedingtes UPDATE).
  Verhalten mit allen Flags aus ist identisch zum bisherigen Watcher
  (bestehende Tests unverändert grün); der Tick schreibt `updatedAt`/
  Haltedauer-Berechnung mit einem **einheitlichen** Zeitstempel pro Zyklus.
- `PaperBroker`: Positions-Eintrag und `listPositions()` tragen
  `trailingStop`/`trailingArmed` (hydrate-Mapping in `engine.getBroker()`
  inklusive) — das Ledger zeigt dieselbe Wahrheit wie die DB.

### Sicherheit / Grenzen

- Paper-only: `src/live-gate/**` unangetastet; keine Order-Mapping-Pfade an
  echte Venues (Stop-Auslösung bleibt Ledger-/DB-Logik).
- Fail-closed: Bounds-Clamp mit sicherem Default, kaputte/env-fremde Werte
  neutralisiert; Stops werden nie automatisch verengt, nur erweitert und
  geloggt; jede Mutation revisionssicher im Audit.

## [1.43.0] — 2026-09-18 · feat(paper): Trade-Journal mit Agenten-Attribution + begrenzte Gewichts-Rückführung (GAP-03)

**Hintergrund:** Laut Feature-Gap-Audit 2026-09-18
([GAP-03](docs/audits/2026-09-18-feature-gap/findings/GAP-03-trade-journal-attribution.md))
gab es keinen Weg, **nachvollziehen zu können, welche Agenten-Entscheidung zu
welcher Position geführt hat** — und damit keinen belastbaren Boden für eine
Lernschleife. `positions` referenziert Missionen/Regeln, aber nicht die
Entscheidungskette (Stimmen, Regime, Begründung) zum Eröffnungszeitpunkt;
Excursions (MAE/MFE) wurden nie gemessen. Dieser Release schließt die Lücke
(PROMPT-03 der Remediation-Serie) mit einem **append-only Trade-Journal** und
einer **bewusst begrenzten, aus- bzw. zuschaltbaren Feedback-Schleife** —
sicherheitsseitig Default **off**. Umsetzung: PR
[#137](https://github.com/Kryschuuu/ai-trading-firm/pull/137)
(`arena/01a0b4c1-ai-trading-firm`).

### Hinzugefügt

- **Neue append-only Tabelle `trade_journal`** (Migration
  `drizzle/2026-09-18_trade_journal.sql`, alternativ `npx drizzle-kit push`;
  **keine Änderung bestehender Tabellen/Spalten** — die fehlende Verknüpfung
  wird über ein Foto im Journal geschlossen, nicht über neue FKs an
  `positions`):
  - `position_id` (UNIQUE, FK), `symbol`, `side`, `opened_at`, `closed_at`,
    `mission_id`, `rule_id`, `decision_snapshot` (jsonb), `regime`
    (UNKNOWN erlaubt), `pnl`, `mae_pct`, `mfe_pct`, `holding_minutes`,
    `exit_reason`, `quality` (OK | CANDLE_GAP | NO_DATA | ERROR), `created_at`.
  - **Schreibweg (a) bei Eröffnung** (Engine EXECUTOR-Direktpfad,
    genehmigtes Proposal, Mikro-Executor-Regelpfad): `decision_snapshot` =
    unveränderliches Foto der Entscheidungskette — Attribution
    `PROPOSAL`/`RULE`/`UNKNOWN`, Stimmen (Agenten-Turns der Mission im
    6h-Fenster), Proposer, Regime, `rationale_hash` (sha256(reason+detail)
    bzw. Regel-Signatur). **Fehlt die Verknüpfung (z. B. manuelle
    Altbestands-Position), trägt der Snapshot `attribution: "UNKNOWN"` —
    die Lücke ist sichtbar, wird nie still geraten (fail-closed).**
  - **Schreibweg (b) beim Close** (Monitor SL/TP, Emergency-Flatten):
    PnL, Haltedauer, Exit-Reason + MAE/MFE; fehlende Zeile wird mit
    UNKNOWN-Snapshot nachgetragen (Backfill).
  - Robustheitsvertrag: ein Journal-Fehler **bricht den Handelspfad nie ab**
    (CRITICAL-Audit `JOURNAL_WRITE_FAILED`, Lücke bleibt in der Tabelle
    sichtbar).
- **MAE/MFE aus Kerzen** (`src/lib/journalMetrics.ts`, rein/deterministisch):
  Zeitmaske nur auf Kerzen mit Intervallstart ∈ [Eröffnung, Close] (Default
  1h, `JOURNAL_CANDLES_TIMEFRAME`); einheitliches **P&L-Vorzeichen**
  (MAE = P&L am ungünstigsten Kurs ≤ 0, MFE = P&L am günstigsten Kurs ≥ 0,
  LONG und SHORT). **Kerzenlücke ⇒ Metriken null + Flag `CANDLE_GAP`
  (niemals geschätzt)**; leeres Fenster ⇒ `NO_DATA`.
- **Auswertung** (`src/lib/journalAnalytics.ts`): Trefferquote/Erwartungswert
  je Agent × Regime × Symbolgruppe (Asset-Klasse der Registry) mit
  **Beta-Prior-Glättung α=β=2** (dokumentierte Konstante
  `JOURNAL_BETA_PRIOR`) und **Mindest-Stichprobe `JOURNAL_MIN_TRADES`
  (Default 20, Bounds [5,200])** — darunter Status `insufficient-sample`
  und die Kennzahl wird **niemals als Faktor** verwendet.
- **Read-API `GET /api/firm/journal`** (SEC-02-Muster: `firm.read`,
  `force-dynamic`, `no-store`): vollständige Summary (Totals inkl.
  attributed/unattributed, Gruppen, Gewichtsstand/Vorschläge). DB-Fehler ⇒
  sauberes `503 JOURNAL_UNAVAILABLE`.
- **Zyklus-Artefakte:** der Daily-Cycle schreibt `journal-feedback.json` +
  `journal-summary.json` neben die übrigen Tages-Artefakte (best-effort —
  ein Journal-Fehler bricht den Zyklus nie ab).
- **Begrenzte Gewichts-Rückführung `JOURNAL_FEEDBACK_MODE`** (Default **off**):
  - `off` — nur Auswertung; Entscheidungspfad bleibt **byte-identisch** zu
    v1.42.x (kein Prompt-Kontext, keine Gewichtszeilen).
  - `monitor` — vorgeschlagene Gewichte als `audit_log`-Events
    (`JOURNAL_WEIGHT_PROPOSED`) + Zyklus-Artefakt; Entscheidungspfad
    unverändert.
  - `enforce` — Gewichte werden in der neuen Tabelle
    `journal_agent_weights` persistiert (`JOURNAL_WEIGHT_APPLIED`,
    revisionssicher `journal-weight:AGENT:REGIME:x→y`) und wirken im
    Approver-/Portfolio-Prompt der Engine (Regime-scope).
  - **Schutzschalen (GAP-03 D4):** Bounds
    [`JOURNAL_WEIGHT_MIN`=0.5, `JOURNAL_WEIGHT_MAX`=1.5], **maximale
    Änderung je Zyklus `JOURNAL_MAX_WEIGHT_DELTA` (Default 0.1, Bounds
    [0.01,0.5])** → selbst extreme Serien bewegen Gewichte nur
    schrittweise; Bayes-Glättung FIRST (frische Trades können ohne
    ausreichend großen Beleg kein Gewicht außerhalb der Bounds treiben).
  - **Sicherheitsbegründung des off-Defaults:** ein Lern-Loop ist genau dort
    am gefährlichsten, wo er kleine Stichproben als Signal umsetzen würde;
    deshalb reiner Nachschlageweg bis der Operator die Auswertung geprüft
    hat (→ monitor → optional enforce).
- **Tests** `tests/tradeJournal.test.ts` (21 Tests): MAE/MFE-Handreferenzen
  LONG+SHORT (inkl. Zeitmaske, CANDLE_GAP/NO_DATA), Glättung (2/3 nahe am
  Prior, 20/30 empirisch, n=0 → 0.5), Bounds/maxDelta (Clamp, schrittweise
  Multi-Zyklus-Annäherung), Config-Clamp/fail-closed, E2E-Attribution über
  `executeApprovedProposal` (Snapshot korrekt, Close-Metriken,
  UNKNOWN-Backfill, idempotente Eröffnung), Auswertung (insufficient-sample
  nie als Faktor) + Modus-Verhalten off/monitor/enforce mit audit_log- und
  `journal_agent_weights`-Prüfung, Quellmuster-Wiring aller Schreibpfade.

### Dokumentation

- `docs/HANDBUCH.md`: neuer Abschnitt **§13 „Trade-Journal“**
  (Attribution, KPIs, Glättung, Feedback-Modi + Sicherheitsbegründung,
  Diagnose).
- `CONFIGURATION.md` + `.env.example`: sechs neue `JOURNAL_*`-Flags mit
  Defaults/Bounds.
- `docs/audits/2026-09-18-feature-gap/remediation/TRACKING.md`: GAP-03 →
  IN_PROGRESS (dieser PR; FIXED nach Merge); Finding-Datei um
  „Umsetzung“-Abschnitt ergänzt.

### Nicht enthalten (bewusst)

- Keine Qualitätsbefund-Verarbeitung (z. B. automatische Degradierung bei
  vielen CANDLE_GAP) — die Flaggs sind vorhanden und sichtbar, die
  Auswertung gehört in einen Folge-Release.
- Keine Änderung an `src/live-gate/**` (Paper-only bleibt erzwungen); keine
  neuen Runtime-Dependencies.

## [1.42.0] — 2026-09-18 · feat(backtest): Multi-Asset Event-Driven Backtest-Engine & Replay-Simulator (Task 02)

**Umfang & Architektur (Task 02):** Einführung der deterministischen,
ereignisgesteuerten Multi-Asset-Backtest-Engine unter `src/backtest/`
(`engine.ts`, `portfolio.ts`, `simulator.ts`, `metrics.ts`, `types.ts`).

- **Multi-Asset Event-Driven Timeline:** Synchronisierte Zeitachsen-Iteration
  über N Instrumente (`HistoricalStore`) und N Strategieregeln / Research-Setups
  ohne Lookahead-Bias.
- **Ausführungs- und Kostenmodelle:** Konfigurierbare Slippage-Modelle
  (`fixed`, `spread_relative`, `none`), Maker/Taker-Gebühren und
  konservativer Stop-Loss-Vorrang bei Kerzen-Kollisionen.
- **Zentrales Portfolio-Management:** Simulation von Cash, aggregiertem
  Mark-to-Market-Eigenkapital, systemweiten Positions- und Risikodeckeln
  (`maxOpenPositions`, `maxPositionPct`, `maxRiskPerTrade`).
- **Mathematisch fundierte Kennzahlen:** Sharpe Ratio, Sortino Ratio,
  Max Drawdown mit Recovery-Dauer, Profit Factor, Win Rate, Expectancy,
  CAGR, Calmar Ratio, Streak-Statistiken sowie Symbol- und Strategie-Breakdowns.
- **Cycle- und API-Integration:** Step 8 (`src/cycle/steps/backtestStep.ts`)
  nutzt nun die echte Multi-Asset-Engine für Setup-Verifikationen; neuer
  Endpunkt `POST /api/firm/backtest` für Multi-Asset-Backtests.
- **Dokumentation:** `docs/BACKTEST_ENGINE.md`, ADR-007 in `docs/roadmap/DECISIONS.md`,
  Aktualisierung von `docs/roadmap/STATUS.md` und `docs/architecture/INTEGRATION_POINTS.md`.
## [1.42.0] — 2026-09-18 · feat(paper): Funding-Kosten im Paper-PnL + kalibrierbare Execution-Simulation (GAP-02)

**Hintergrund:** Laut Feature-Gap-Audit 2026-09-18
([GAP-02](docs/audits/2026-09-18-feature-gap/findings/GAP-02-execution-simulation.md))
bildete der Fill-Simulator zwar Gebühren, Spread, Slippage und Partial Fills ab,
aber **Perpetual-Funding floss nicht ins Paper-PnL** — Funding existierte nur
als Scanner-Ranking-Faktor. Gerade bei längeren Haltedauern frisst Funding real
die Edge; Paper-Ergebnisse waren damit systematisch zu optimistisch. Dieser
Release schließt die Lücke (PROMPT-02 der Remediation-Serie) und macht die
Simulationsparameter kalibrierbar. Umsetzung: PR
[#136](https://github.com/Kryschuuu/ai-trading-firm/pull/136)
(`arena/01a0b48a-ai-trading-firm`).

### Hinzugefügt

- **Funding-Accrual je offener Perpetual-Position** (`src/lib/funding.ts`, neu):
  - Gebucht im Monitor-Tick bei **Periodenwechsel** (Default: 8h-Marken
    00/08/16 UTC; `PAPER_FUNDING_INTERVAL_HOURS`, Bounds [1, 24]). Erste
    Sichtung nach Prozessstart bucht nichts nach; Standby über mehrere Marken
    bucht `periods`-fach.
  - Formel `funding = fundingRate · |notional| · direction` (LONG = +1 zahlt
    bei positiver Rate, SHORT = −1 erhält). Verbindliche
    **Vorzeichenkonvention (Kontosicht)**: negativ = gezahlt, positiv =
    erhalten — dokumentiert in `docs/PAPER_TRADING.md` §3.2.
  - **Rate-Quelle gestuft:** (a) statisch über `PAPER_FUNDING_RATE_PCT_PER_8H`
    (Default `0` = **neutral** — bestehende Tests und Installationen bleiben
    unverändert grün), (b) Erweiterungspunkt `FundingRateProvider`
    (`getFundingRate(symbol)`) für echte Raten — ohne Netzwerk-Anbindung in
    diesem Release.
  - **Nur Perpetuals** zahlen (Registry-Lookup über den Marktdaten-Manager;
    Spot/Aktien/unbekannt ⇒ kein Funding, fail-safe gegen erfundene Lasten).
  - **Revisionssicher:** jedes Accrual-Ereignis ins `audit_log`
    (`FUNDING_ACCRUAL`, Muster `funding:SYMBOL:+0.42`, Audit-Senke mit Retry +
    Spool). Schlägt die Persistenz fehl, wird die Ledger-Buchung
    zurückgerollt (fail-closed).
- **Neue DB-Spalte `positions.funding_paid`** (numeric, NOT NULL DEFAULT 0;
  append-only Migration `drizzle/2026-09-18_positions_funding.sql`, alternativ
  `npx drizzle-kit push`): kumuliertes Funding je Position, bleibt nach
  Schließen stehen (Lifetime-Historie).
- **Equity- & Positions-Ausweis:** Funding wirkt als echter Cashflow auf Cash
  und damit `accountEquity` (wie Gebühren beim Fill — keine Doppelzählung);
  `PaperBroker.accrueFunding`/`totalFundingPaid`, `fundingPaid` je Position in
  `listPositions`/Adapter (`BrokerPosition`, optional), Restore (`getBroker`)
  hydratiert `funding_paid` (auch im Legacy-Cash-Pfad).
  `GET /api/firm` zeigt `fundingPaid` je Position sowie `account.fundingPaid`
  (SUMME über alle Positionen) und `account.fundingPaidOpen` (offene).
- **Kalibrierung der Execution-Simulation** (GAP-02 D3): `PAPER_MAKER_FEE_PCT`,
  `PAPER_TAKER_FEE_PCT`, `PAPER_SLIPPAGE_BPS`, `PAPER_SPREAD_FALLBACK_BPS` —
  Overlay über die `PAPER_SIM_*`-Basis in `createPaperExecution`
  (`calibrateSimulatorConfig`), Defaults = heutige hartcodierte Werte (kein
  Verhaltensbruch), Bounds-Clamp **mit Log-Warnung** bei Korrektur
  (`envNumber`, Muster `src/lib/env.ts`).
- **Monitor-Tick-Ergebnis** um `fundingAccruals` erweitert (pro Tick gebuchte
  Accruals; Default-Konfiguration ⇒ immer leer).
- **Tests** `tests/paper.funding.test.ts` (15 Tests): Vorzeichen exakt, Accrual
  nur bei Periodenwechsel (injizierbare Clock, zweimal ticken ⇒ genau eine
  Buchung), Equity-Abgleich („equity nach Accrual = vorher + fundingPaid-
  Summe“), Bounds/Clamp-Warnungen, Rate-Default 0 = neutral, nur Perpetuals,
  Rate-Quelle gestuft, Persistenz-Fehler ⇒ Ledger-Rollback, Determinismus
  (identische Quote-Folge ⇒ SHA-256-identische Fills; Engine ohne
  Date.now()/Math.random()).

### Dokumentation

- `docs/PAPER_TRADING.md`: neue Abschnitte **§3.1 „Gebühren, Slippage &
  Kalibrierung“** und **§3.2 „Funding-Accrual für Perpetuals“** (inkl.
  Vorzeichenkonvention, Flag-Tabellen, Migrations-Hinweis) + §6-Env-Tabelle.
- `CONFIGURATION.md` + `.env.example`: sechs neue Flags mit Defaults/Bounds.
- `docs/audits/2026-09-18-feature-gap/remediation/TRACKING.md`: GAP-02 → FIXED
  (v1.42.0); Finding-Datei um „Umsetzung“-Abschnitt ergänzt.

### Nicht enthalten (bewusst)

- Keine echte Funding-Raten-Anbindung (z. B. Bitunix REST/WS) — nur das
  Provider-Interface als Erweiterungspunkt (siehe „Offene Punkte“ im
  GAP-02-Finding).
- Keine Änderung an `src/live-gate/**` (Paper-only bleibt erzwungen); keine
  neuen Runtime-Dependencies.

## [1.41.0] — 2026-09-18 · docs(audit): Feature-Gap-Audit 2026-09-18 (Co-Audit) + ausführbare Arena-Prompt-Serie (GAP-01…GAP-10)

**Hintergrund:** Ein externes Co-Audit (Arena-Session) bewertete das Repo —
ohne Code-Zugriff — als **asymmetrisch reif**: Security, Auth, Audit-Trail
und Betrieb auf Produktionsniveau, aber die Trading-Qualität selbst
(Validierung vor Papiergeld, realistische Fills, Lernschleife) aus dem
sichtbaren Material kaum belegt. Daraus entstand eine Top-10-Liste fehlender
Funktionen. Dieser Release macht daraus einen **ordentlichen Audit-Zyklus**
nach Repo-Konvention (`docs/audits/YYYY-MM-DD-<quelle>-<name>/`) und eine
**abarbeitbare Prompt-Serie** für Arena-Sessions — jeder Prompt self-contained,
mit Verifikationspflicht, Testplan, Docs-Sync- und Changelog-Pflicht.

### Hinzugefügt

- **Audit-Zyklus [`docs/audits/2026-09-18-feature-gap/`](docs/audits/2026-09-18-feature-gap/README.md):**
  - `report.md` — vollständiger Wortlaut des Co-Audits (Teil 1, unverändert
    bewahrt) **plus** Code-Verifikation (Teil 2): je Finding der verifizierte
    Ist-Stand mit Datei-Evidenz auf Basis v1.40.0.
  - `findings/GAP-01…GAP-10` — je Lücke: Befund, verifizierter Ist-Stand,
    Delta, Akzeptanzkriterien.
  - `remediation/TRACKING.md` — Status-SSoT (GAP-01…GAP-10 = OPEN; zusätzlich
    neuer Befund **ENV-01**: `tests/secretStore.test.ts` fällt im
    Voll-Suite-Lauf aus, wenn unter `DATABASE_URL` eine erreichbare DB
    antwortet — Test-Isolation, standalone grün, vorab existierend).
  - `prompts/` — **PROMPT-00 (Baseline) + PROMPT-01…PROMPT-10**: einpaste-
    fähige Session-Prompts mit empfohlener Reihenfolge (02 → 05 → 10 → 04 →
    06 → 07 → 03 → 08 → 01 → 09; hart: 01 erst nach 02+07) und harten
    Guardrails (Paper-only, Fail-closed, keine neuen Runtime-Dependencies,
    Bounds+Flags-Pflicht, audit_log, append-only-Migrationen, Determinismus).
- **Verifikations-Befunde (Teil 2 des Reports), die das Co-Audit korrigieren:**
  Die Execution-Simulation (GAP-02) und der SL/TP-Watcher (GAP-05) sind
  bereits großteils vorhanden; die Prompts arbeiten nur noch die Deltas ab
  (Funding im PnL, Trailing/Time-Stop/OCO-Exklusivität). Umgekehrt bestätigt:
  der Backtest-Step fällt bei <5 Kerzen auf eine **synthetische Serie**
  zurück („20 Trades, 55 % Winrate“) — als Anti-Pattern dokumentiert; der
  Abbau ist Teil von PROMPT-01.
- **Dashboard-Sichtbarkeit:** Katalog-Eintrag `auditFeatureGap`
  (`GET /api/docs`), Tabellen-Einträge in `docs/README.md` + `README.md`,
  Tracker-Eintrag **Task 17** in `docs/ARENA_TASKS.md`.

### Geändert

- **GitHub-Repo-Description korrigiert** (Doku-Befund des Co-Audits): lautete
  „…modulare Python-basierte Handelsplattform…“, Stack ist aber
  Node.js/TypeScript (Next.js 16 + Drizzle). Korrektur außerhalb des Codes
  per GitHub-Admin (in diesem PR dokumentiert).

### Nicht enthalten (bewusst)

- Keine Code-Änderung an der Trading-Logik: Umsetzung der Lücken erfolgt
  je Prompt in eigenen Sessions/PRs (Reihenfolge + Abhängigkeiten siehe
  [Prompt-Serie](docs/audits/2026-09-18-feature-gap/prompts/README.md)).

## [1.40.0] — 2026-09-18 · fix(market-sync): Cross-Prozess-Sichtbarkeit, leere Kerzen als DATA_UNAVAILABLE, Registry-Race & Scanner-Cache (250 → WARMING-Bug)

### Behoben

- **Scanner-Fix 250 → WARMING (Regression):** Der Markt-Scanner fiel
  sporadisch auf `WARMING (0/250)` zurück, wenn ein Worker-Tick den In-Memory-
  Ringpuffer mit < 250 DB-Kerzen vorübergehend überschrieb. Der Zustand wird
  jetzt transaktionssicher gesperrt, Kerzenanzahlen unter 250 führen zu
  präzisen Fehlermeldungen statt silent state resets.
- **Cross-Prozess-Cache-Invalidierung:** DB-Aktualisierungen von Kerzen
  triggern jetzt zuverlässig die Invalidation der In-Memory-Stores über
  Postgres `pg_notify` / Registry-Sync.
