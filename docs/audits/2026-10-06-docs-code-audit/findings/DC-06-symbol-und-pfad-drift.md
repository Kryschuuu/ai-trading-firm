# DC-06 — Symbol- und Pfad-Drift in der Architektur-Doku

- **ID:** DC-06
- **Severity:** MEDIUM (Doku als Einstiegspunkt unbrauchbar)
- **Bereich:** Architektur-Dokumentation vs. Code
- **Quelle:** Docs↔Code-Audit `v0.17.2`, Mengenabgleich dokumentierter Symbole/Dateien gegen `src/` + `scripts/`
- **Status:** ☐ **OPEN**
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
