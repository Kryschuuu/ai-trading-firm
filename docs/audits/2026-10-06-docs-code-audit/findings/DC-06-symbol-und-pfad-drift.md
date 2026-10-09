# DC-06 — Symbol- und Pfad-Drift in der Architektur-Doku

- **ID:** DC-06
- **Severity:** MEDIUM (Doku als Einstiegspunkt unbrauchbar)
- **Bereich:** Architektur-Dokumentation vs. Code
- **Quelle:** Docs↔Code-Audit `v0.17.2`, Mengenabgleich dokumentierter Symbole/Dateien gegen `src/` + `scripts/`
- **Status:** ☑ **FIXED** (2026-10-09) — Umsetzung siehe unten
- **Prompt:** [`../prompts/PROMPT-DC-06-symbol-pfad-abgleich.md`](../prompts/PROMPT-DC-06-symbol-pfad-abgleich.md)
- **Datei(en):** `docs/architecture/PIPELINE_MAP.md`, `docs/architecture/INTEGRATION_POINTS.md`, `docs/MISSIONS.md`, `docs/DOCS_SYNC_AUDIT.md`, `docs/security/SECURITY_AUDIT.md`, `docs/MARKET_DATA_PIPELINE.md`

## Beschreibung

Recursive Suche in `src/` + `scripts/` ergibt **0 Treffer** für folgende, in der
Architekturkarte als Export/Datei behauptete Symbole:

| Dokumentierte Angabe | Fundstelle | Realität |
|----------------------|-----------|----------|
| `FunnelStageResult` als Export von `src/scanner/types.ts` | `PIPELINE_MAP.md:167` | `FunnelResult` existiert — aber in `src/scanner/funnel.ts:22` |
| `getAdaptiveRiskFactor`, `evaluateMarketRegime` als Exporte von `src/lib/adaptiveRisk.ts` | `PIPELINE_MAP.md:296`, `INTEGRATION_POINTS.md:122` | reale Exporte: `updateAdaptiveRisk`, `getAdaptiveRiskStatus`, `RegimeStateMachine`; `applyAdaptiveRisk` liegt in `src/lib/riskGuard.ts` |
| `guardPortfolioAllocations`, `enforcePositionLimits`, `enforceCorrelationLimits` | `PIPELINE_MAP.md:327` | `src/portfolio/riskGuard.ts` exportiert `resolveGuardConfig`, `applyRiskGuard`, `assertAuthorityChain`, `capFor` |
| `matchRule` | `PIPELINE_MAP.md:386` | `src/lib/ruleService.ts` exportiert `listRules`, `getActiveRules`, `upsertRuleSpec`, `rowToSpec` |
| `RuleMatchResult`, `RuleExecutionRecord` | `PIPELINE_MAP.md:394` | existieren nicht |
| `HISTORICAL_DATA_DIR` | `PIPELINE_MAP.md:119,466` | existiert nicht (Speicherort ist konfigurationsfrei `data/history` über die Store-Pfade) |
| `executeWeeklyReview` | `PIPELINE_MAP.md:193` | real: `weeklyReviewStep` (`src/cycle/weekly.ts:44`) |
| `src/components/workshop/InfoTip.tsx` | `MISSIONS.md:242`, `DOCS_SYNC_AUDIT.md:139` | real: `src/components/ui/InfoTip.tsx` |
| `src/perpdata/consumer.ts` | `INTEGRATION_POINTS.md:149` | real: `src/perpdata/consumers.ts` (Plural) |
| `scripts/drizzle.config.json` | `security/SECURITY_AUDIT.md:36` | historischer Befund (S-11, „entfernt v1.1.0") — **kein** Fehler, nur als Altpfad gekennzeichnet lassen |

Zusätzlich verwechselt die Doku zwei real existierende Module mit ähnlichem
Namen: `src/lib/riskGuard.ts` (Firm-Risk-Limits) und
`src/portfolio/riskGuard.ts` (Portfolio-Guards) werden in
`PIPELINE_MAP.md`/`INTEGRATION_POINTS.md` teils vertauscht referenziert.

**Gegenprobe (bewusst NICHT gemeldet):** `PIPELINE_MAP.md:295`
(`src/lib/riskGuard.ts` mit `validateOrder`, `killSwitch`, `RISK_LIMITS`,
`LIMIT_CEILINGS`) ist korrekt; `src/scanner/historicalStore.ts`
(`MARKET_DATA_PIPELINE.md:47`) und `scripts/drizzle.config.json` sind
dokumentierte Migrations-/Altpfade in Audit-/Migrationstabellen.

## Wirkung

`PIPELINE_MAP.md` und `INTEGRATION_POINTS.md` sind als „Master-Architekturkarte"
bzw. „verbindliche Referenz" ausgewiesen. Wer den dokumentierten Symbolen folgt
(Refactoring, Onboarding, Audit-Arbeit), landet bei nicht existierenden
Funktionen und verliert Vertrauen in die Karte — genau die Rolle, die sie laut
eigenem Anspruch hat.

## Lösungsvorschlag (Prompt DC-06)

1. **Ist-Exporte einsammeln:** für jede in der Karte genannte Datei die realen
   Exporte aus dem Code ziehen (`grep -n "^export" <datei>`) und die Karte
   dagegen abgleichen — pro Zeile „Fundstelle → realer Export".
2. **Umschreiben statt löschen:** die Absicht der Karte erhalten (welcher
   Baustein wofür zuständig ist), aber mit realen Namen und korrekten
   Modulgrenzen; wo Symbole fehlen, den tatsächlichen Einstiegspunkt nennen
   (z. B. Rule-Matching: `RuleCache.match()` bzw. Executor statt `matchRule`).
3. **Modulgrenzen schärfen:** einen kurzen Absatz „Zwei Risk-Guards, zwei
   Zwecke" (Firm-Limits vs. Portfolio-Guards) mit korrekten Pfaden.
4. Automatisierten Check als Teil von DC-08 aufnehmen: dokumentierte
   `src/…`-Pfade und Backtick-Symbole, die wie Exporte aussehen, müssen
   existieren (Whitelist für Altpfade).

## Verifikation nach Umsetzung

```bash
# Alle in Architektur-Docs referenzierten src-Pfade existieren:
python3 - <<'PY'
import os,re
pat=re.compile(r'`((?:src|scripts)/[A-Za-z0-9_\-./\[\]]+\.(?:ts|tsx|json))`')
bad=[]
for dp,dn,fn in os.walk("docs/architecture"):
    for f in fn:
        p=os.path.join(dp,f); t=open(p,encoding="utf-8").read()
        for m in pat.finditer(t):
            path=m.group(1)
            # von der Doku aus ggf. ohne Präfix notiert
            if not os.path.exists(path): bad.append((p,t[:m.start()].count("\n")+1,path))
print(len(bad),"tote Pfade"); [print(" ",*b) for b in bad]
PY
# Erwartung: nur bekannte Altpfad-Treffer (bewusst whitelisted).
```

## Umsetzung (2026-10-09)

Vorgehen: pro in der Karte genannter Datei die realen Exporte eingesammelt
(`grep -n "^export" <datei>`), zusätzlich zwei maschinelle Scans über
`docs/architecture/*.md` — (a) jeder Backtick-Pfad `src/…`/`scripts/…` gegen den
Dateibaum, (b) jedes export-artige Backtick-Symbol wortgenau gegen `src/` +
`scripts/`, sowie (c) ein Attributions-Scan „`datei` (`symbol`)" → ist das Symbol
wirklich ein Top-Level-Export **dieser** Datei. Scan (c) hat über den Befund
hinaus weitere Vertauschungen geliefert (siehe Zeilen 15–27).

### Symbol-Tabelle (Fundstelle | dokumentiert | real | Korrektur)

| # | Fundstelle | dokumentiert | real | Korrektur |
|---|-----------|--------------|------|-----------|
| 1 | `PIPELINE_MAP.md:167` (Stufe 3) | `FunnelStageResult` als Export von `src/scanner/types.ts` | `FunnelResult` in `src/scanner/funnel.ts:22`; Stufen sind `InstrumentScore[]`-Felder | Datei + Typ korrigiert, Stufen-Typ ersatzlos gestrichen, reale Felder (`scanned`, `droppedByCap`, `diversificationRelaxed`, `deepPerAssetClass`) genannt |
| 2 | `PIPELINE_MAP.md:167` (Stufe 3, Config) | `funnel.eligible.maxCount` u. ä. | `funnel.eligibleMax`, `funnel.interestingMax`, `funnel.interestingMinScore`, `funnel.dailyMax`, `funnel.deepMin`/`deepMax`, `funnel.maxPerAssetClass` | Schlüssel auf `FunnelConfig`/`scanner.config.json` (Version 2) korrigiert |
| 3 | `PIPELINE_MAP.md:119` (Stufe 1) | `HISTORICAL_DATA_DIR` (Default `data/history`) | kein Env-Read; `new HistoricalStore(dir?)` mit Default `data/history`, Datei `candles.ndjson`, Auflösung über `resolveRuntimePath()` (`src/lib/appPaths.ts`) | Flag gestrichen, reale Pfadauflösung genannt |
| 4 | `PIPELINE_MAP.md:466` (§ 4.2) | `HISTORICAL_DATA_DIR`; `maxBarsPerSeries` **5.000** | wie #3; `DEFAULT_MAX_BARS_PER_SERIES` = `MAX_CANDLES_PER_SERIES` = **100.000** (`src/lib/marketdata/limits.ts`) | Pfadkonstanten des Stores genannt, Retention-Wert auf 100.000 (wie `DB_SCHEMA.md` seit DC-03) |
| 5 | `PIPELINE_MAP.md:149` (Stufe 2) | `writeDailyUniverseArtifact` | `writeDailyArtifact`, `writeWeeklyArtifact`, `DAILY_FILE` (`src/scanner/artifacts.ts`) | korrigiert |
| 6 | `PIPELINE_MAP.md:191` (Stufe 4) | `createGuardedAgentPort` als Export | modulinterne Funktion in `src/cycle/engine.ts:39` | als „modulintern" gekennzeichnet (Aussage bleibt: `llmAllowed: false` wirft) |
| 7 | `PIPELINE_MAP.md:193` (Stufe 4) | `executeWeeklyReview`, `classifyWeekly` in `src/cycle/weekly.ts` | `weeklyReviewStep` (`src/cycle/weekly.ts:44`), `createWeeklySteps`; `classifyWeekly` + `WeeklyReview` in `src/scanner/weekly.ts` | korrigiert und Modulgrenze Zyklus ↔ Scanner eingezogen |
| 8 | `PIPELINE_MAP.md:195` (Stufe 4) | `writeCycleArtifact` | `saveDailyCycleArtifacts`, `saveWeeklyCycleArtifacts`, `updateArtifactIndex`, `pruneArtifacts`, `getLatestDailyArtifact`, `getLatestWeeklyArtifact` | korrigiert |
| 9 | `PIPELINE_MAP.md:208` (Stufe 4) | Ausgabetyp `DailyCycleArtifacts` | Writer geben `{ artifactsDir, filesWritten }` zurück | Typ gestrichen, reale Rückgabe genannt |
| 10 | `PIPELINE_MAP.md:296`, `INTEGRATION_POINTS.md:122` | `getAdaptiveRiskFactor`, `evaluateMarketRegime` (`src/lib/adaptiveRisk.ts`) | `updateAdaptiveRisk`, `getAdaptiveRiskStatus`, `assessRegime`, `RegimeStateMachine`, `readMarketReadings`, `fetchVix`; **Anwendung** des Faktors: `applyAdaptiveRisk` in `src/lib/riskGuard.ts` | korrigiert + Zuständigkeit getrennt (Berechnung vs. Limit-Anwendung) |
| 11 | `PIPELINE_MAP.md:300` (Stufe 7) | `OrderValidationParams` | `ValidateContext` (`src/lib/riskGuard.ts:469`) | korrigiert (Feldliste war bereits richtig) |
| 12 | `PIPELINE_MAP.md:301` (Stufe 7) | `ValidationResult` (`allowed`, `reason?`, `adjustedSize?`) | `GuardrailResult` (`allowed`, `reason`, `blockedBy`); Sizing separat über `riskAdjustedSize`/`missionSizedNotional` | korrigiert |
| 13 | `PIPELINE_MAP.md:302` (Stufe 7) | `RiskStepOutput` mit `rejectedCandidates: { symbol, reason }[]`, `clusterWarnings` | `rejectedCandidates: { instrumentId, reason }[]`, `correlationWarnings`, `maxPositionPct`, `riskBudgetPerTrade`, `rationale`, `portfolioAllocation?` (`src/cycle/schemas.ts:590`) | korrigiert |
| 14 | `PIPELINE_MAP.md:307` (Stufe 7) | Audit-Event `RISK_REJECTED` | `ORDER_REJECTED` (mit `reason`), `KILL_SWITCH` (CRITICAL), `KILL_SWITCH_DISARMED` | korrigiert |
| 15 | `PIPELINE_MAP.md:311–314` (Stufe 7) | `FIRM_MAX_RISK_PER_TRADE`, `FIRM_MAX_OPEN_POSITIONS`, `FIRM_MAX_DRAWDOWN_STOP`, `FIRM_DAILY_LOSS_LIMIT` | **keine** Env-Reads; Limits sind Code-Felder `DEFAULT_LIMITS.maxRiskPerTrade` (0.02), `.maxConcurrentPositions` (5), `.maxEquityDrawdownPct` (**0.15**, nicht 0.10), `.dailyLossLimitPct` (0.05), Laufzeit-Tuning via `risk_config` innerhalb `LIMIT_CEILINGS`; reale Flags: `STARTING_EQUITY`, `AUTO_CIRCUIT_BREAKER`, `RISK_MAX_CONSECUTIVE_LOSSES` | Flags gestrichen, reale Quelle + Defaults genannt; `risk_config` von „informative Anzeige" auf „Laufzeit-Tuning innerhalb der Code-Deckel" korrigiert |
| 16 | `PIPELINE_MAP.md:326`, `INTEGRATION_POINTS.md:169` | `optimizeWithGuard`, `optimizeWeights` in `src/portfolio/optimize.ts` | `optimizeWithGuard` in `src/portfolio/pipeline.ts:152`; in `optimize.ts`: `optimizePortfolio`, `resolveBounds`, `convergenceWarning` | Datei-Zuordnung und Name korrigiert |
| 17 | `PIPELINE_MAP.md:327` (Stufe 8) | `guardPortfolioAllocations`, `enforcePositionLimits`, `enforceCorrelationLimits` | `applyRiskGuard`, `resolveGuardConfig`, `assertAuthorityChain`, `capFor` (`src/portfolio/riskGuard.ts`) | korrigiert + neuer Absatz **„Zwei Risk-Guards, zwei Zwecke"** (Firm-Limits vs. Portfolio-Guards, je ein Satz Zuständigkeit + Merksatz) |
| 18 | `PIPELINE_MAP.md:328` (Stufe 8) | `computeSeriesMetrics` | `computeMetrics` | korrigiert |
| 19 | `PIPELINE_MAP.md:329` (Stufe 8) | `computeCorrelationMatrix`, `clusterAssets` | `correlationMatrix`, `covarianceMatrix`, `correlationClusters`, `clusterAnalysis` | korrigiert |
| 20 | `PIPELINE_MAP.md:331` (Stufe 8) | `OptimizationResult`, `PortfolioGuardReport` | `RawOptimizationResult`, `RiskGuardResult`, `GuardedPortfolio` (`src/portfolio/types.ts`), `PortfolioOptimizationResult` (`src/portfolio/pipeline.ts`) | Typen ersetzt, Eingabe `PortfolioRequest` vs. `OptimizationRequest` getrennt |
| 21 | `PIPELINE_MAP.md:370` (Stufe 9) | `GateTransitionResult` | `LiveGateTransitionResult` (`src/live-gate/service.ts:60`) | korrigiert |
| 22 | `PIPELINE_MAP.md:371` (Stufe 9) | `FIRM_OPERATOR_TOKEN` | `FIRM_API_TOKEN` (`OPERATOR_TOKEN_FLAG`, `src/auth/authMode.ts:43`); ergänzt `FIRM_VIEWER_TOKEN` | korrigiert |
| 23 | `PIPELINE_MAP.md:386` (Stufe 10) | `matchRule`, `evaluateRule` (`src/lib/ruleEngine.ts`) | `compileRuleSpec` → `CompiledRule.evaluate(snap)`; Einstieg des Hot-Path ist `RuleCache.match(snap, now?, timeframe?)` (`src/lib/microExecutor.ts:622`), Rückgabe `CachedRule[]` | korrigiert; neuer Unterpunkt „Regel-Matching — der reale Einstieg" mit dem Verhalten bei erschöpftem `maxExecutionsPerDay`: **still übersprungen** (`continue`, `src/lib/microExecutor.ts:634`) ohne `rule_executions`-Zeile, Log oder Counter; sichtbar nur über `RuleCache.status()`/`listRuleExecutions`; ein sichtbares „Nein" gibt es allein beim Timeframe-Guard (`micro_executor_rule_blocked`) |
| 24 | `PIPELINE_MAP.md:387` (Stufe 10) | `listActiveRules`, `recordRuleExecution` | `getActiveRules`, `listRules`, `rowToSpec`, `listRuleExecutions` (`src/lib/ruleService.ts`); Schreibpfad ist `createPaperRuleAdapter` (`db.insert(ruleExecutions)`, `src/lib/microExecutor.ts:1218`) | korrigiert |
| 25 | `PIPELINE_MAP.md:391` (Stufe 10) | `PriceTick` (`symbol`, `price`, `volume`, `timestamp`) | `FeedTick` (Union `trade` \| `candle` \| `book`), `CandleLike`, `RuleSnapshot`, `ExecuteContext` | korrigiert |
| 26 | `PIPELINE_MAP.md:394–395` (Stufe 10) | `RuleMatchResult`, `RuleExecutionRecord` | `CachedRule[]`, `ExecutionOutcome` (`status`, `ruleId`, `symbol`, `reason?`, `orderId?`, `fill?`, `totalMicros?`, `at`), persistierte Zeile in `rule_executions` | Typen ersetzt (kein Ersatztyp erfunden) |
| 27 | `PIPELINE_MAP.md:384` (Stufe 10) | `MICRO_SYMBOLS` Default `BTCUSDT,ETHUSDT` | Default `BTC` (`scripts/micro-executor.ts:36`), `.env.example`-Beispiel `BTC,ETH` | korrigiert, Bounds von `MICRO_RULE_REFRESH_MS`/`MICRO_HEALTH_PORT` ergänzt |
| 28 | `PIPELINE_MAP.md:434` (Stufe 11) | `ORDER_PLACED`, `ORDER_FILLED` | `ORDER_SENT` bzw. `ORDER_REJECTED` (`src/lib/engine.ts:1102`), `BROKER_FACTORY` (`src/brokers/audit.ts`), `RECONCILIATION_DISCREPANCY`, `TRAILING_STOP_ARMED`, `FLATTEN_ALL` | korrigiert |
| 29 | `INTEGRATION_POINTS.md:36` (§ 1) | `backtestRuleOnCandles` | `backtestRule(spec, candles, opts?)` mit `BacktestResult`/`BacktestTrade` (`src/lib/ruleEngine.ts:837`) | korrigiert (Dateiliste **und** Fließtext) |
| 30 | `INTEGRATION_POINTS.md:133` (§ 3) | „nur ein frischer Lauf darf `src/lib/adaptiveRisk.ts` drosseln" | Leser `readLatestMacroVolatilityFactor` (`src/lib/macroRegimeContext.ts`), Faktor-Bildung in `updateAdaptiveRisk`, **Drosselung** in `applyAdaptiveRisk` (`src/lib/riskGuard.ts`) | Modulgrenze korrigiert (Vertauschung Berechnung ↔ Anwendung) |
| 31 | `INTEGRATION_POINTS.md:149` (§ 4) | `src/perpdata/consumer.ts` | `src/perpdata/consumers.ts` (`buildPerpDerivativeSnapshots`, `perpDerivativeProvider`, `createPerpFundingRateProvider`, `perpAnalystSnapshotLines`) | Pfad korrigiert (einziger toter Pfad-Treffer des Verifikations-Skripts) |
| 32 | `INTEGRATION_POINTS.md:153` (§ 4) | Discovery „über `MARKET_SYNC`" | `MARKET_SYNC_ENABLED`/`MARKET_SYNC_VENUES`, `npm run market:sync` | auf reale Flags/CLI konkretisiert |
| 33 | `INTEGRATION_POINTS.md:229–230` (§ 8) | `src/lib/engine.ts` (`restoreFirmState`), `state.paperBrokerLedger` in `broker.ts` | `restorePaperBrokerState`, `ensurePaperBrokerHydrated`, `invalidatePaperBrokerHydration`, `FIRM_HYDRATION_RETRY_MS` in `src/lib/brokerHydration.ts`; `state.paperBrokerLedger` ist Registry-Eintrag (`src/lib/stateRegistry.ts:279`), befüllt von `paperBrokerLedger()` (`src/brokers/factory.ts:47`); `src/lib/engine.ts` delegiert via `getBroker` | korrigiert, `brokerHydration.ts` in Dateiliste und Übersichtszeile 8 ergänzt |
| 34 | `MISSIONS.md:242`, `DOCS_SYNC_AUDIT.md:139` | `src/components/workshop/InfoTip.tsx` | `src/components/ui/InfoTip.tsx` (seit v0.15.0 im UI-Kit) | Pfad korrigiert, in `MISSIONS.md` mit dem Umzugshinweis |

### Bewusst unverändert (Gegenprobe)

| Fundstelle | Angabe | Grund |
|-----------|--------|-------|
| `PIPELINE_MAP.md:295` | `src/lib/riskGuard.ts` mit `validateOrder`, `killSwitch`, `RISK_LIMITS`, `LIMIT_CEILINGS` | korrekt — um `DEFAULT_LIMITS`, `applyRuntimeLimits`, `riskAdjustedSize` und die vier nur-senkenden Überlagerungen ergänzt |
| `security/SECURITY_AUDIT.md:36` | `scripts/drizzle.config.json` | historischer Befund S-11 („entfernt v1.1.0") — Altpfad |
| `MARKET_DATA_PIPELINE.md:47` | `src/scanner/historicalStore.ts` | Migrationstabelle — Altpfad |
| `PIPELINE_MAP.md` Stufe 8 | `allowShortSelling` | bewusste „existiert nicht"-Aussage aus DC-03 |
| `INTEGRATION_POINTS.md:23,170` | `src/portfolio/riskGuard.ts` | Prüfung ergab **keine** Vertauschung — beide Stellen meinen korrekt die Portfolio-Guards; § 5 nennt jetzt zusätzlich die realen Exporte und verweist auf den Trenn-Absatz der Karte |

### Zusätzliche Aussagen der Karte (nicht nur Namen)

- **Neuer Absatz „Zwei Risk-Guards, zwei Zwecke"** in `PIPELINE_MAP.md` (Stufe 8):
  Tabelle Modul → Zuständigkeit → reale Einstiegssymbole plus Merksatz
  (`src/lib/riskGuard.ts` entscheidet über die Order, `src/portfolio/riskGuard.ts`
  über die Gewichte); `INTEGRATION_POINTS.md` § 5 verlinkt ihn.
- **Neuer Abschnitt „8. Pflege dieser Karte"** in `PIPELINE_MAP.md`: Quelle ist der
  Code; Symbole nur mit realem Export (bzw. nachweisbarer Methode/Tabelle) nennen;
  umschreiben statt erfinden; Altpfade nur als solche (mit Verweis auf die beiden
  Fundstellen); automatischer Wächter folgt in DC-08.
- **Status-Header** beider Architekturdoks: „Vollabgleich offen" → „Symbol-/Pfad-
  abgleich gegen `src/` + `scripts/` erledigt (DC-06, 2026-10-09)".
- **Offene Meldung (kein Baustein fehlt ganz):** Alle dokumentierten Bausteine
  existieren fachlich, nur unter anderem Namen/Modul. Einzige echte Lücke: die vier
  `FIRM_MAX_*`-Env-Flags hatten **nie** einen Code-Read — sie wurden nicht still
  gelöscht, sondern durch die reale Quelle (`DEFAULT_LIMITS` + `risk_config` +
  `LIMIT_CEILINGS`) ersetzt. `CONFIGURATION.md`/`.env.example` führten sie nicht
  (keine Folgeaktion); der Drawdown-Default wurde dabei von dokumentierten 10 %
  auf reale 15 % berichtigt.

### Regressionsschutz

`tests/docsArchitectureSymbols.test.ts` (9 Tests) — statisch, ohne DB/LLM:
tote Pfade in `docs/architecture/*.md` (mit verrottungsgeschützter Altpfad-
Whitelist), Abwesenheit der DC-06-Totsymbole in den vier Doks, reale Exporte der
jetzt genannten Einstiegssymbole (Funnel, Weekly, Adaptive Risk, beide Risk-Guards,
Regel-Pfad inkl. `RuleCache.match` + still übersprungenem Tageslimit),
Env-Flag-Freiheit des Kerzen-Speichers und Vorhandensein von Trenn-Absatz +
Pflege-Abschnitt. Der generische Wächter in `npm run docs:validate` bleibt DC-08.

### Verifikation (2026-10-09)

| Prüfung | Ergebnis |
|---------|----------|
| Verifikations-Skript dieses Findings (Backtick-`src/…`-Pfade in `docs/architecture/*.md`) | **2 Treffer, beide whitelisted** (`scripts/drizzle.config.json`, `src/scanner/historicalStore.ts` — im Pflege-Abschnitt als Altpfade zitiert) |
| `grep -rn "getAdaptiveRiskFactor\|enforcePositionLimits\|matchRule\|FunnelStageResult\|executeWeeklyReview" docs/architecture docs/MISSIONS.md docs/DOCS_SYNC_AUDIT.md` | **0 Treffer** |
| Symbol-Scan (wortgenau, `src/` + `scripts/`) über beide Architekturdoks | **0 Treffer** außer der bewussten DC-03-Aussage zu `allowShortSelling` |
| Attributions-Scan „`datei` (`symbol`)" → Top-Level-Export | **0 Fehlzuordnungen** (übrig bleiben deutsche Prosa-Klammerzusätze und Tabellen-Referenzen) |
| `node --import tsx --test tests/docsArchitectureSymbols.test.ts` | 9/9 grün |
| `npm run typecheck` · `npx eslint tests/docsArchitectureSymbols.test.ts` · `npm run docs:validate` | grün · grün · grün (9 Checks, Link-/Anker-Check inkl. der neuen Querverweise) |
| `tests/docsLinks`, `docsCatalog`, `docsNav`, `docsVersioning` | 37/37 grün |
