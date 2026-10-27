# BP-03: Workshop endet bei der Trefferquote — keine Backtest-/Export-Brücke

- **Antwort:** Offen
- **Tracking-Status:** `OPEN`
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **5–8 PT**
- **Umsetzungs-Prompt:** [`PROMPT-BP-03`](../prompts/PROMPT-BP-03-workshop-backtest-bruecke.md)

## Verifizierte Fundstellen

- `src/components/workshop/` — `WorkshopTab.tsx` (4 Schritte), `AgentRunPanel`,
  `PromptPanel`, `HitRatePanel`, `MissionsPanel`, `MissionTemplatePicker`;
  **kein Backtest-Verweis** (grep über das Verzeichnis ohne Treffer).
- `src/lib/workshop.ts` — reine Funktionen für Missionen, Trefferquote,
  JSON-Debug-Tipps (ab 2 Fällen / ≥20 % INVALID_JSON).
- Vorhandene, aber nicht angebundene Infrastruktur: `src/backtest/engine.ts`
  (`runMultiAssetBacktest`), `src/app/api/firm/backtest` und
  `/api/firm/rules/[id]/backtest` (nutzt `backtestRule()`), `src/lib/ruleService
  .ts::upsertRuleSpec()`, `ruleEngine.sanitizeRuleSpec()`.

## Bewertung und Abgrenzung

Schritt 4 misst, ob das Modell *sagt*, dass es handeln würde (Rohantwort-
Trefferquote), nicht ob die entstehende Regel im Backtest Geld verdient. Damit
endet der wichtigste Lernpfad des Repos ohne Strategie-Rückkopplung und ohne
Weg, ein iteriertes Ergebnis in `trade_rules` zu aktivieren. Die Engine- und
Regel-Persistenz existiert bereits; es fehlt die Orchestrierung
(Mission/RuleSpec-Skelett → Replay → Metriken → Export) plus UI-Schritt.

## Konkretes Delta

- Neuer Workshop-Schritt „5 · Regel-Backtest“: Mission → `RuleSpec`-Skelett →
  `runMultiAssetBacktest`/`backtestRule` → Metriken-Ansicht → „Als Regel
  aktivieren“ (via `sanitizeRuleSpec` + `upsertRuleSpec`).
- Reine Mapping-Funktionen in `src/lib/workshop.ts`; API-Slice additiv
  (kein POST auf `/api/firm/backtests` — dort bewusst read-only).
- Guardrail-Vertrag: Export nur über `sanitizeRuleSpec`; aktive Regeln bleiben
  hinter den UNIQUE-Indizes `trade_rules_active_*`.

## Akzeptanzkriterien für `FIXED`

- [ ] Mission-loses → RuleSpec-Roundtrip erfüllt `RULE_CEILINGS` (Klemmung).
- [ ] Backtest-Ergebnis wird ausschließlich gegen den `HistoricalStore`
      gerechnet (kein Look-ahead).
- [ ] „Als Regel aktivieren“ läuft durch `sanitizeRuleSpec`/`upsertRuleSpec`
      und ist idempotent (keine Duplikate bei Retries).
- [ ] UI zeigt Metriken + Fehlerzustände (leerer Store, Degraded).
- [ ] Pflichtgates grün; neue `ruleTests` abgedeckt.

## Review-Evidenz

- Audit-Basis: Commit `7d8b07b`, Produktversion `v1.51.3`.
- Methode: Verzeichnis- und API-Routen-Pfadprüfung.