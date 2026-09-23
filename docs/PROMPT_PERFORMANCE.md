# Prompt-Performance & Version-Metrikvergleich (RMA-P3-02, v1.65.0)

> **Status-Header:** **Implementiert** · **v0.1.0 (Beta)** · **2026-09-23** · Branch `arena/01a0c912-ai-trading-firm`  
> Basis: Roadmap-Audit [PROMPT-P3-02](audits/2026-09-20-roadmap-audit/prompts/PROMPT-P3-02-prompt-performance.md) (v1.64.0, `df3163e`)

Dieses Dokument ist die kanonische Referenz für die Prompt-Performance-Pipeline: von der **immutable Prompt-Version** bis zur **fairen Metrik-Gegenüberstellung** hinter Human-Gate.

---

## 1. Architektur (ein Satz)

Agenten schreiben **nie** direkt ins Modell-Log — jeder LLM-Aufruf wird als **Prompt-Artefakt** (immutable, hash-gebunden) + **Provenanz-Run** (Provider/Modell/Params/Timing/Tokens/Cost/Success, ohne Secrets) persistiert; Outcomes (P3.1 `forecast_resolutions` + P1.6 `trade_attributions`) werden **PIT-korrekt** je `promptVersion` aggregiert, und ein Vergleich legt **identische Filter** über zwei Versionen — Ergebnis ist `GATED` und nur Empfehlung.

## 2. Prompt-Artefakt: Kanonisierung, immutability, Version, Hash, Rolle, Template-Schema

### 2.1 Kanonisierung

- `canonicalizePrompt(raw)` in [`src/promptPerformance/canonical.ts`](../src/promptPerformance/canonical.ts): **nur LF-Normalisierung** (`\r\n`→`\n`, `\r`→`\n`), sonst **byte-identisch** (kein Trim, keine Unicode-NFKC, keine Leerzeichenkompression). Grund: deterministischer Hash trotz Plattform-Zeilenenden, aber keine stillen Inhaltsänderungen.
- Länge geklemmt auf `PROMPT_PERF_LIMITS.maxPromptTextLength` (12 000) vor Kanonisierung — darüber wird geschnitten (bounded, nie unbegrenzt).
- Pflicht-Tests: LF-Stabilität (`\r\n`/`\r`/`\n` ⇒ identischer `promptHash`), jede inhaltliche Änderung ⇒ anderer `promptHash`.

### 2.2 Hash & Version

- `promptHash = pp1:<sha256(canonical)>` (`pp1:`-Präfix = Schema v1, 64 hex). Einzige Hash-Definition im Repo.
- Version kommt **ausschließlich** aus `agents.version` (DB-Integer ≥ 1). Ein Artefakt ist `(agentId, version)` **oder** `(agentId, promptHash)` **unique** (`prompt_artifacts_agent_version_unique`, `prompt_artifacts_agent_hash_unique`). Dieselbe Versionszahl mit anderem Inhalt ⇒ `VERSION_CONFLICT` (fail-closed, nie still überschrieben). Derselbe Inhalt mit anderer Versionszahl ⇒ vorhandenes Artefakt (Warnung `prompt_artifact_duplicate_content`, **bounded Label**, kein zweiter Insert).
- `UNKNOWN` = historische Lücke (kein Artefakt, z. B. Altbestand). In Metriken/APIs explizit `promptVersion: null`, `promptHash: "UNKNOWN"`, `versionLabel: "UNKNOWN"` — nie als `0`.

### 2.3 Rolle & Template-Schema

- Jedes Artefakt trägt `role` (Agentenrolle, bounded, ≤64) und `templateSchemaVersion` (Default `"1"`, ≤16). `role` ist Metrik-/Filter-Label (nie Prompt-Text). Änderungen am Template-Schema ⇒ neue Prompt-Version (Hash ändert sich).

### 2.4 Persistenz

- Tabelle `prompt_artifacts` via [`src/db/schema.ts`](../src/db/schema.ts) (`promptArtifacts`) **und** idempotente SQL-Datei [`drizzle/2026-09-22_prompt_performance.sql`](../drizzle/2026-09-22_prompt_performance.sql) (beides identisch, beide `IF NOT EXISTS`). **`npx drizzle-kit push`** oder `psql "$DATABASE_URL" -f drizzle/…` — beide gültig.
- Append-only-Trigger (wie `feature_store`/`perpdata`): `UPDATE`/`DELETE`/`TRUNCATE` auf `prompt_artifacts` und `agent_prompt_runs` **werfen** (gemanagte Tabellen nie mutiert).
- Migrations-/Rollback-Runbook siehe §9.

## 3. Run-Provenanz je Agentenaufruf

### 3.1 Wo

[`src/promptPerformance/provenance.ts`](../src/promptPerformance/provenance.ts): `resolveArtifactIdempotent()` + `emitAgentRun()`; aufgerufen aus [`src/lib/engine.ts`](../src/lib/engine.ts) (`runAgentTurn`) **vor** `parseDecision` — jeder `localReason`-Aufruf ist gebunden, egal ob Erfolg oder `fallback`.

### 3.2 Was

`agent_prompt_runs` enthält **genau ein** Artefakt (oder `artifactId = null` ⇒ `UNKNOWN`), dazu:

| Feld | Einheit / Wertebereich | Herkunft |
|---|---|---|
| `role`, `promptHash`, `promptVersion`, `agentId`, `artifactId` | bounded Label; Hash `pp1:<sha256>` oder `UNKNOWN`; Version `int ≥1` oder `NULL` | Artefakt |
| `provider` | `ollama\|openai\|gemini\|anthropic\|fallback\|unknown` | `localReason`/`ReasonResult.provider` |
| `model` | `≤200`, `unknown` fallback | `ReasonResult.model` |
| `temperature`, `maxTokens`, `toolSchemaVersion` | `numeric\|int\|text(32)`, `NULL` wenn nicht gemeldet | `ReasonResult`/Request |
| `startedAt`, `endedAt`, `latencyMs` | ISO-8601 `timestamptz`, `latencyMs = ms` | `promptStartedAt/promptEndedAt` |
| `promptTokens`, `completionTokens`, `totalTokens` | `count` (int), `NULL` = unbekannt (nie `0` erfunden) | `ReasonResult.usage` |
| `costUsd`, `costStatus` | USD (`numeric`), `billed\|free\|unknown` | `ReasonResult.costUsd` (`null` ⇒ `unknown`) |
| `success`, `errorCode` | `bool`, `≤64` | `localReason`-Exception / `fallback` |
| `idempotencyKey` | `pr1:<sha256(json({ph,aid,ts,model,att}))>` | stabil für Retries |

### 3.3 Was **nicht**

Keine Secrets (kein `apiKey`, kein Authorization-Header), keine Rohtranskripte (`brain.raw` bleibt nur in `agentMessages.meta.rawResponse`, nie in `agent_prompt_runs`), keine Agenten-Namen/Instrument-IDs als Metriklabel.

### 3.4 Idempotenz & Robustheit

- `idempotencyKey` ist **UNIQUE**. Ein Retry/Neustart mit identischem Key liefert die **bestehende** Zeile (`created: false`) — kein zweiter Run. Concurrency ⇒ `23505`⇒ Re-Read.
- `emitAgentRun` fängt `PROMPT_PERFORMANCE_ENABLED=false` (`DISABLED`) und jeden `DB_WRITE_FAILED` **lokal** und loggt `prompt_provenance_failed` — der Agenten-Turn läuft **immer** weiter (Provenanz ist fehlertolerant, aber **fail-closed** beim Artefakt-Konflikt).
- `PROMPT_PERFORMANCE_ENABLED=false` unterdrückt `ensurePromptArtifact` **und** `recordPromptRun` (beide werfen `DISABLED`, sofort gefangen) — beste Zeilen bleiben lesbar.

## 4. Outcome-Join: Forecasts → Resolutions + Trades → Attribution

### 4.1 Forecasts → P3.1 Resolutions

Metriken lesen **nur** aus `forecasts` + jüngste `forecast_resolutions` je Forecast (`resolutionVersion desc`, erste je `forecastId`). Eine zusätzliche `getEffectiveResolution`-Ableitung ist damit äquivalent (jüngste Version = effektiver Status).

- `RESOLVED` → `outcomeBinary` 0/1 (gehört in Brier/ECE/HitRate).
- `VOID` → zählt in **Coverage**, nie in Scores (siehe §5.2).
- `PENDING` (= keine Resolution) → zählt in **Coverage** als fehlend, nie in Scores — **missing outcomes ≠ win/loss** (P3.1-§3.1-Invariant, explizit getestet).

**Kein stiller 0-Mid-Price-Fallback:** Resolver verlangt eine Kerze mit `fetchedAt ≤ availabilityDeadline`; fehlende Kerze ⇒ `VOID(MISSING_DATA)` (getestet).

### 4.2 Trades → P1.6 Attribution (`ta1`)

Je `promptVersion` wird `trade_attributions.method_version=1, status=ATTRIBUTED` + `trade_attribution_entries WHERE source_type='AGENT' AND source_version='<promptVersion>'` summiert (bounded, ≤2000 Attributionen, chunked 250). Ergebnis:

- `attributedPnl` = Σ `contribution` (EUR/USD-neutral, wie im Ledger), `tradeCount` = Anzahl beitragender Einträge, `avgContribution` = Mittel.
- `maxDrawdown` = **kumulierter Drawdown** der je-Attribution-P&L-Kurve in `closedAt`-Reihenfolge: `cum += contrib; peak = max(cum); dd = min(cum − peak)` (negativ oder 0). Bei nur einem beitragenden Trade ist `maxDrawdown = 0`; ohne Trades `null`. Einheiten: **USD/พนL**, nicht normiert.

`UNKNOWN`-Prompt-Version ⇒ Attribution `null` (sichtbare Lücke, kein Raten).

## 5. Metriken je Prompt-Version (bounded, mit Unsicherheit & Segmentierung)

### 5.1 Aufruf

Pure Funktion [`src/promptPerformance/metrics.ts:getPromptVersionMetrics(filter)`](../src/promptPerformance/metrics.ts):

```ts
{ promptVersion?: number | null, agentRole?, horizonId?, entityId?, regime?, fromAsOf?, toAsOf?, minSample?, limit? }
```

- `promptVersion: null` ⇒ **UNKNOWN-Gruppe** (nur `UNKNOWN`-Runs, 0 Forecast-Zeilen — keine Leckage).
- Limits: Forecasts ≤ `PROMPT_PERF_LIMITS.maxMetricsForecasts` (20 000), Runs ≤ `maxRunsPerQuery` (5 000); `minSample` ∈ [5, 1000] (Default 30).

### 5.2 Formeln & Semantik

| Metrik | Formel / Einheit | Menge | Notiz |
|---|---|---|---|
| **Brier** | `mean((p−y)²)`, p = `forecasts.probability`, y ∈ {0,1} aus `outcomeBinary`, ∈ [0,1] | nur `RESOLVED`, n = `forecastsResolved` | `se = sqrt(Brier·(1−Brier)/n)`, CI `Brier ±1.96·se` (wie `forecasts/scoring.ts`) |
| **BSS** | `1 − Brier/0.25` (Referenz-Brier einer konstanten 0.5-Prognose) | nur `RESOLVED` | `null` falls keine Stichprobe |
| **LogLoss** | `mean(−[y·log p + (1−y)·log(1−p)])`, p in [1e-6, 0.999999] | nur `RESOLVED` | Einheit nats |
| **HitRate** | `hits/n`, hit = `(p≥0.5)==y` | nur `RESOLVED` | Wilson 95 % `wilson95(hits,n)`, z=1.96 |
| **ECE** | Σ `|meanForecast_bucket − observedRate_bucket|·(count/n)`, 10 Buckets `[i·0.1, (i+1)·0.1)` | nur `RESOLVED` | ∈ [0,1], 0 = kalibriert |
| **Reliability** | je Bucket `(index, count, meanForecast, observedRate, wilson95)` | nur `RESOLVED` | leere Buckets `null`-Werte |
| **Brier-Uncertainty** | `{se, lower, upper}` | nur `RESOLVED`, n≥2 | sonst `null` |
| **Abstention** | `null` (P3.1 hat kein abstention-Flag) | — | sichtbar vorbereitet, **nie erfunden** |
| **Coverage** | `(resolvedCount + voidCount) / total` ∈ [0,1] oder `null` bei 0 Forecasts | alle Forecasts | `PENDING` senkt Coverage |
| **Latency** | `latencyMs` in **ms**, `avgMs`, `p50Ms`, `p95Ms` (lineare Interpolation) | alle Runs | `count` = Runs |
| **Tokens** | `prompt / completion / total` in **count**, `avgPerRun` | alle Runs | `NULL`-Tokens ⇒ 0 in Summen, `avgPerRun = total/count` |
| **Kosten** | `costUsd` in **USD**, `totalUsd`, `avgUsd`, `billedRuns`, `freeRuns` | alle Runs | `costStatus=billed` summenwirksam, `free` gezählt, `unknown` sichtbar 0-summenwirksam |
| **Attribution** | siehe §4.2 | per Attribution, `closedAt`-sortiert | `maxDrawdown ≤0` |

- `status: "ok"` ⇔ `n ≥ minSample`, sonst `"insufficient-sample"` — nie still `null`.
- Alle Bound-Tests: `minSample` clamp, `limit` clamp, Horizon/Regime-Whitelist, Zeitfenster-Validierung.

### 5.3 Zeitsemantik (PIT)

- **Ereigniszeit**: `forecasts.asOf` (Forecast gilt ab diesem Zeitpunkt).
- **Verfügbarkeitszeit**: `forecasts.availabilityDeadline = resolvesAt + 2 h` (Resolver darf nur Kerzen mit `fetchedAt ≤ deadline` nutzen). **Keine** Auswertung nutzt `createdAt` als Zulässigkeitskriterium.
- **Metrik-Filter** (`fromAsOf`/`toAsOf`): ausschließlich `forecasts.asOf` bzw. `agent_prompt_runs.startedAt` — nie `computedAt`/`createdAt`. Falsche Chronologie (`from ≥ to`) ⇒ `INVALID_TIME_WINDOW` (400).

### 5.4 Einheiten & Boundedness

Jede API-Antwort trägt `units: { latency:"ms", tokens:"count", cost:"USD" }` und ein `note`-Feld, das die Semantik wiederholt. Keine Endpoint liefert unlimitierte Listen: `limit` hart geklemmt, `truncated`/`X-Truncated` signalisiert Kappung, CIs/Samples immer sichtbar (Unsicherheit nie verschwiegen).

## 6. Fairer Vergleich & Promotion als Empfehlung

### 6.1 Identische Filter

[`src/promptPerformance/compare.ts:comparePromptVersions({ baseline, candidate, … })`](../src/promptPerformance/compare.ts) erzwingt **identische** `{fromAsOf, toAsOf, horizonId, entityId, regime, agentRole}` über beide Metriken. Abweichung ⇒ `MISMATCHED_FILTERS` (früher Fehler, kein Vergleich). `baseline == candidate` ⇒ `SAME_VERSION`.

### 6.2 Ergebnis

`PromptComparisonReport` enthält beide `PromptVersionMetrics`, Delta-Coverage/-Abstention, `warnings` (einseitig geringe Coverage, `PENDING`-Dominanz) und:

- `recommendation.recommend = candidate|baseline` (besserer `brierSkillScore`; bei Gleichstand/beliebig fehlend `null`).
- `recommendation.status = "GATED"` — **immer**. Operator-Mode = **Human-Review**: nie auto-promoten.
- **ECE-Wächter**: liegt der `candidate` in ECE um ≥ 0.02 über `baseline`, bleibt `recommend` bei `baseline` (bzw. Kandidateneinheit blockiert) — **schlechter kalibrierte Variante darf nicht allein wegen PnL gewinnen**.

Provenance-Anhang: `{ identicalFilters: true, coverageReported: true }` — dokumentiert, dass der Vergleich fair und coverage-bewusst war.

## 7. Privatsphäre & Retention

- **Prompt-Text nie als Metriklabel**: Listen (`/artifacts`, `/runs`) geben **nur** Metadaten (`hash`/`role`/`version`/`createdAt`) zurück; der kanonische Text ist nur über berechtigten Detail-Pfad abrufbar (gesichert, nicht als ID in `telemetry`).
- **Metriken nutzen bounded Labels** (`telemetry.prompt.artifacts{result: created|duplicate}`, `telemetry.prompt.runs{result, provider}`, `telemetry.prompt.queries{result}`) — nie Prompt-/Instrument-IDs (Kardinalitätsregel).
- **Keine Secrets** in `agent_prompt_runs` (nur `temperature`/`maxTokens`/`toolSchemaVersion`; keine Keys/Tokens/Rohtranskripte).
- Retention: Append-only-Tabellen ohne TTL. Löschung = manuellen `DROP`-Entscheid (Rollback-Runbook: Daten ignorieren oder `DROP TABLE agent_prompt_runs`/`prompt_artifacts` **erst** nach Verifikation, keine Cascade auf andere Tabellen — siehe §9).

## 8. Betriebsmodi & Feature-Flag

| Flag | Default | Wirkung |
|---|---|---|
| `PROMPT_PERFORMANCE_ENABLED` | `true` (implizit an) | `false` ⇒ `ensurePromptArtifact`+`recordPromptRun` werfen `DISABLED` (sofort gefangen), Pipeline läuft weiter. Trunkierung/Reading bleibt möglich. Nur `false` schaltet Schreibpfad ab; unbekannte Werte ⇒ an. |

Kein Scheduler, kein Sync-Job — `instrumentation.ts` bleibt unverändert (einziger neuer Hook ist im Engine-Turn).

## 9. Migration, Kompatibilität & Rollback

### 9.1 Additive Migration (idempotent)

```bash
# Variante A (ORM)
npx drizzle-kit push

# Variante B (SQL, ohne Node)
psql "$DATABASE_URL" -f drizzle/2026-09-22_prompt_performance.sql
# zweifacher Lauf ist sicher: IF NOT EXISTS + Index-Guards + DO $$ guards
```

Neue Objekte **nur** ins bestehende Schema additiv:

- `prompt_artifacts` mit CHECKs (`version≥1`, Hash-Regex, `role`/`template` nicht leer) + 4 Indizes (zwei UNIQUE).
- `agent_prompt_runs` mit FKs auf `prompt_artifacts`/`agents`, `prompt_version` NULL-bar (historische Lücke), Indizes auf Rolle/Version/Hash/Label, `cost_status` CHECK, Zeitindizes.
- Zwei `DO $$`-Trigger, die `UPDATE`/`DELETE`/`TRUNCATE` auf beiden Tabellen verwehren (append-only, wie `feature_store`/`perpdata`).

Keine bestehende Tabelle/Spalte wird verändert — die Forecasts tragen ihr `prompt_version` bereits (`forecasts.prompt_version`), und `trade_attributions` verwahrt die P1.6-Bindung.

### 9.2 Beobachtung nach Migration

```sql
-- Artefakte vorhanden?
SELECT count(*) FROM prompt_artifacts;

-- Läufe idempotent?
SELECT count(*) FROM agent_prompt_runs WHERE idempotency_key = 'pr1:<hex>';

-- Append-only bewahrt?
UPDATE prompt_artifacts SET role='x' WHERE id='<uuid>'; -- muss werfen
```

### 9.3 Rollback

Der Prompt-Performance-Pfad ist **vollständig additiv**; keine Gate berührt ihn.

1. **Sofort (ohne Code):** `PROMPT_PERFORMANCE_ENABLED=false` in `.env` ⇒ alle neuen Schreibpfade gedämpft, bestehende Zeilen lesbar, Betrieb normal.
2. **Temporär (Code):** Redeploy auf `v1.64.0` — die beiden Tabellen bleiben **harmlos ignoriert** (kein Code liest sie mehr).
3. **Bereinigung (nur nach Verifikation):**

   ```sql
   DROP TABLE IF EXISTS agent_prompt_runs;
   DROP TABLE IF EXISTS prompt_artifacts;
   ```

   Erst **nach** Abgleich, dass keine andere Instanz `v1.65.0` mehr schreibt und historische Befunde exportiert sind — sonst kein Downgrade vollzogen.

## 10. APIs (bounded, `firm.read`, `no-store`)

| Methode | Pfad | Filter | Bounded | Fehler |
|---|---|---|---|---|
| `GET` | `/api/firm/prompts/artifacts` | `agentId`, `role`, `limit` ≤200, `offset` | `X-Truncated`, `truncated` | Tabelle fehlt ⇒ `503 PROMPT_LEDGER_UNAVAILABLE` |
| `GET` | `/api/firm/prompts/runs` | `role`, `promptVersion` (oder `UNKNOWN`), `promptHash`, `agentId`, `from`/`to` (ISO, `from<to`), `limit` ≤5000, `offset` | `units: {ms,tokens,USD}` je Zeile `artifactId` oder `UNKNOWN` | Falsches Fenster ⇒ `400 INVALID_TIME_WINDOW`, ungültiges `promptVersion` ⇒ `400`, fehlende Tabelle ⇒ `503` |
| `GET` | `/api/firm/prompts/metrics` | `promptVersion` (int oder `UNKNOWN`), `agentRole`, `horizonId`∈{4h,24h,72h}, `entityId`, `regime` (closed), `from`, `toAsOf`, `minSample`, `limit` | `units` + `notes` (`PENDING` nie win/loss) | Horizon/Regime falsch ⇒ `400 INVALID_TIME_WINDOW`, fehlende Tabelle ⇒ `503` |
| `GET` | `/api/firm/prompts/compare` | `baseline`, `candidate` (distinct int), dieselben Filter wie `/metrics` **identisch** | `provenance:{identicalFilters,coverageReported}` + `notes`, Recommendation `gateRequired` | `baseline==candidate` ⇒ `400 SAME_VERSION`, Filter nicht identisch ⇒ `400 MISMATCHED_FILTERS`, Horizon/Regime falsch ⇒ `400` |

Alle Antworten: `Cache-Control: no-store` (+ `X-Truncated:1` bei Kappung). Auth: `requirePermission(req, "firm.read")` (SEC-02, wie `/firm/forecasts/scores`).

## 11. Tests (Pflicht-Matrix)

| Pfad | Pflicht | Beleg |
|---|---|---|
| `canonicalizePrompt` | LF-Stabilität | `promptPerformance.canonical.test.ts`: `\r\n`/`\r`/`\n` ⇒ gleicher Hash |
| `canonicalizePrompt` | inhaltliche Änderung ⇒ anderer Hash | `promptPerformance.canonical.test.ts` |
| `recordPromptRun` | exakt **ein** Artefakt je Run (oder `UNKNOWN`) | `store.test.ts`: FK/Idempotenz, Auslesen ergibt genau einen |
| `getPromptVersionMetrics` | `PENDING` nie als Gewinn/Verlust | `metrics.test.ts`: PENDING zählt nicht in `brierCount`, nur in `pendingCount`/`coverage` |
| `*` | Secrets nie persistiert | `store.test.ts`: `apiKey`/`Authorization`/`rawResponse` im Insert verworfen |
| `metrics`/`compare` | negative/invalide/stale Pfade: Horizon/Regime-Whitelist, Zeitraum-Chronologie, `SAME_VERSION`, `MISMATCHED_FILTERS` | `metrics.test.ts`, `compare.test.ts` |
| `metrics`/`compare` | Vergleich identische Filter + Coverage gemeldet | `compare.test.ts` |
| `store` | Roundtrip/Idempotenz/Restart (gleicher Key unter Retry ×3 / neuem Pool) | `store.db.test.ts` (embedded Postgres) |
| `store` | Append-only Trigger (`UPDATE`/`DELETE`/`TRUNCATE` werfen) | `store.db.test.ts` |
| `telemetry` | Bounded Queries: `X-Truncated`, `units` (ms/tokens/USD), keine Prompt-/Instrument-IDs als Label | `api.test.ts` |

## 12. Observability (bounded)

- `telemetry.prompt.artifacts{result: created|duplicate}` — Artefaktanlage.
- `telemetry.prompt.runs{result: ok|error, provider: ollama|openai|gemini|anthropic|fallback|unknown}` — jede provenance-Emission.
- `telemetry.prompt.queries{result: ok|truncated|invalid|unavailable|error}` — jede List/Metrik/Compare-Abfrage (Status, nie IDs).
- Strukturierte `info`/`warn`-Logs: `prompt_artifact_created`, `prompt_artifact_duplicate_content`, `prompt_provenance_failed`, `prompt_metrics_attribution_failed` (nur promptVersion+Grund, nie Inhalte).

## 13. Grenzen & bekanntes Verhalten

- `abstentionRate` ist derzeit `null` (kein `forecasts.abstained`-Flag in P3.1). Coverage ist dafür explizit (resolved+void vs total).
- Drawdown misst nur Agenten-Beiträge (P1.6 `source_type='AGENT'`), ohne Kosten-Residual; `maxDrawdown` ist damit die **bestätigte** Agenten-P&L-Kurve, nicht der Depot-Drawdown.
- Artefakt-Dedup loggt Warnung statt Exception (halber Pfad statt hartem Konflikt) — beabsichtigt, weil derselbe Inhalt mit neuer Versionszahl ein Operator-Fehler ist, nicht ein Datenverlust.
- Keine neue Scheduler-Kadenz — Metriken sind **on-demand** (keine Pre-Aggregation, keine stale-Artefakte).
