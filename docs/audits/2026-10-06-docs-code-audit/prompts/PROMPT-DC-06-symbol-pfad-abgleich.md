# PROMPT DC-06 — Symbol- und Pfad-Drift in der Architektur-Doku beheben

```text
TASK: Korrigiere alle Symbole/Dateipfade in der Architektur-Doku, die es im Code
nicht (mehr) gibt — ohne die Aussageabsicht der Dokumente zu verlieren.

BEFUND (Audit docs/audits/2026-10-06-docs-code-audit/findings/DC-06-symbol-und-pfad-drift.md):
Recursive Suche über src/ + scripts/ ergibt 0 Treffer für:
  - FunnelStageResult           (PIPELINE_MAP.md:167; real: FunnelResult in src/scanner/funnel.ts:22)
  - getAdaptiveRiskFactor, evaluateMarketRegime
      (PIPELINE_MAP.md:296, INTEGRATION_POINTS.md:122; real in src/lib/adaptiveRisk.ts:
       updateAdaptiveRisk, getAdaptiveRiskStatus, RegimeStateMachine; applyAdaptiveRisk liegt
       in src/lib/riskGuard.ts)
  - guardPortfolioAllocations, enforcePositionLimits, enforceCorrelationLimits
      (PIPELINE_MAP.md:327; real in src/portfolio/riskGuard.ts: resolveGuardConfig,
       applyRiskGuard, assertAuthorityChain, capFor)
  - matchRule                    (PIPELINE_MAP.md:386; real: src/lib/ruleService.ts mit
                                  listRules/getActiveRules/upsertRuleSpec)
  - RuleMatchResult, RuleExecutionRecord (PIPELINE_MAP.md:394)
  - HISTORICAL_DATA_DIR          (PIPELINE_MAP.md:119,466)
  - executeWeeklyReview          (PIPELINE_MAP.md:193; real: weeklyReviewStep, src/cycle/weekly.ts:44)
  - src/components/workshop/InfoTip.tsx  (MISSIONS.md:242, DOCS_SYNC_AUDIT.md:139)
      real: src/components/ui/InfoTip.tsx
  - src/perpdata/consumer.ts     (INTEGRATION_POINTS.md:149; real: src/perpdata/consumers.ts)
Bewusst NICHT ändern (Altpfade in Audit-/Migrationstabellen):
  scripts/drizzle.config.json (SECURITY_AUDIT.md:36, historischer Befund S-11) und
  src/scanner/historicalStore.ts (MARKET_DATA_PIPELINE.md:47, Migrationstabelle).
Ebenfalls korrekt und unverändert lassen: PIPELINE_MAP.md:295
(src/lib/riskGuard.ts mit validateOrder/killSwitch/RISK_LIMITS/LIMIT_CEILINGS).

DO:
1. Sammle pro genannter Datei die REALEN Exporte ein
   (`grep -n "^export" <datei>`), trage sie als Tabelle in den Prompt-Output ein
   (Fundstelle | dokumentiert | real | Korrektur) und arbeite die Korrekturen ab.
2. Ersetze nicht nur den Namen, sondern stelle die Aussage sicher:
   - Rule-Matching: den tatsächlichen Einstieg nennen (RuleCache.match bzw. der
     Executor-Pfad) und erklären, was passiert, wenn maxExecutionsPerDay
     erschöpft ist (Kandidat wird still übersprungen — siehe Finding-Kontext der
     Hauptaudit-Liste). Wenn die Karte eine Typbeschreibung braucht: realen Typ
     verwenden oder ersatzlos streichen.
   - Risk-Guards: Absatz "Zwei Risk-Guards, zwei Zwecke" (Firm-Limits
     src/lib/riskGuard.ts vs. Portfolio-Guards src/portfolio/riskGuard.ts) mit
     korrekten Pfaden und je einem Satz Zuständigkeit.
   - HISTORICAL_DATA_DIR: entweder streichen oder auf die realen Pfadkonstanten
     des HistoricalStore verweisen.
3. Prüfe danach beide Dokumente auf weitere Vertauschungen der beiden
   riskGuard-Module und korrigiere sie (INTEGRATION_POINTS.md:23,170 prüfen).
4. Ergänze in PIPELINE_MAP.md am Ende einen kurzen Abschnitt
   "Pflege dieser Karte": Quelle ist der Code; Symbole nur mit realem Export
   nennen; Check folgt in DC-08.

AKZEPTANZ:
- Das Verifikations-Skript aus dem Finding (alle `src/…`-Backtick-Pfade in
  docs/architecture/*.md existieren) meldet nur noch die bewusst whitelisted
  Altpfade.
- `grep -rn "getAdaptiveRiskFactor\|enforcePositionLimits\|matchRule\|FunnelStageResult\|executeWeeklyReview" docs/architecture docs/MISSIONS.md docs/DOCS_SYNC_AUDIT.md`
  findet 0 Treffer.
- `npm run docs:validate` grün (Link-Check leidet nicht unter umbenannten
  Pfaden — Pfade in Backticks sind Text, Pfade in Links müssen stimmen).
- Prompt-Output enthält die Symbol-Tabelle.
```

## Hinweise für die ausführende Session

- Wenn beim Nachschlagen auffällt, dass ein dokumentierter Baustein **gar nicht
  existiert** (nicht nur anders heißt), nicht stillschweigend löschen: Absatz
  auf „nicht vorhanden" setzen und im Prompt-Output als offene Frage melden.
- Reihenfolge nach DC-05; vor DC-08 (der Wächter soll danach greifen).
