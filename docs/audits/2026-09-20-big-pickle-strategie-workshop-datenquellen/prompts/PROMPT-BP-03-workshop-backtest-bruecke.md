# PROMPT-BP-03 — Workshop-Schritt „5 · Regel-Backtest“ + Export in `trade_rules`

## Auftrag

Erweitere den Workshop im Repository `Kryschuuu/ai-trading-firm` um einen
fünften Schritt, der eine iterierte Mission/einen Agent-Output in ein
**RuleSpec-Skelett** überführt, gegen den **HistoricalStore** backtestet und
das Ergebnis — nach Guardrail-Prüfung — als **aktive Regel** exportieren kann.
Der Prompt ist eigenständig: prüfe zuerst den aktuellen Stand; Audit-Basis war
`7d8b07b` (`v1.51.3`). Bei Abweichung adaptiere minimal und dokumentiere sie.

Zugehöriger Befund: [`../findings/BP-03-workshop-backtest-bruecke.md`](../findings/BP-03-workshop-backtest-bruecke.md)
Priorität/Schwere: **HIGH**
Schätzung des Restaufwands: **5–8 PT**
Abhängigkeiten: sinnvoll nach **PROMPT-BP-06** (Kostenmodell) und
**PROMPT-BP-08** (Yahoo-Historik als Datenbasis).

## Verifizierter Ausgangszustand

- Workshop-UI: `src/components/workshop/` (4 Schritte, `WorkshopTab.tsx`);
  reine Logik in `src/lib/workshop.ts`.
- Backtest-Infrastruktur existiert: `src/backtest/engine.ts`
  (`runMultiAssetBacktest`), `src/app/api/firm/backtest`,
  `src/app/api/firm/rules/[id]/backtest` (nutzt `backtestRule`()),
  `src/backtest/runStore.ts` (persistierte Runs).
- Regel-Persistenz: `src/lib/ruleService.ts::upsertRuleSpec()`,
  `src/lib/ruleEngine.ts::sanitizeRuleSpec()`; DB `trade_rules`
  (`src/db/schema.ts:104-161`, mit UNIQUE-Indizes `trade_rules_active_*`).
- HistoricalStore: `src/lib/marketdata/historicalStore.ts`
  (Zeitframes 1m–5d, Dedup, inkrementeller Sync).

## Zielzustand

Im Workshop-Tab existiert ein Schritt „5 · Regel-Backtest“: Der Nutzer wählt
eine Mission (bzw. Agent-Ausgabe), ein RuleSpec-Skelett entsteht daraus, der
Backtest läuft gegen die Historik, Metriken (inkl. Kosten und Benchmark, wenn
BP-06 vorhanden) werden angezeigt, und ein „Als Regel aktivieren“-Button exportiert
die Regel über den gesicherten Persistenzpfad.

## Vor Beginn gezielt prüfen

- `src/components/workshop/` (WorkshopTab, MissionTemplatePicker, AgentRunPanel)
- `src/lib/workshop.ts`, `src/lib/missionTemplates.ts`
- `src/app/api/firm/rules/[id]/backtest/route.ts`, `src/backtest/runStore.ts`
- `src/lib/ruleService.ts`, `src/lib/ruleEngine.ts` (sanitize/ceiling)
- `src/lib/marketdata/historicalStore.ts`, `src/backtest/engine.ts`
- bestehende Tests: `tests/workshop*.test.ts`, `test/ui/*.tsx`, Backtest-Tests

## Verbindlicher Implementierungsumfang

1. **Mission → RuleSpec-Skelett:** reine Funktionen in `src/lib/workshop.ts`
   (Skop → `symbol`/`segment`; Risiko-/Budgets aus der Mission; `window` aus
   Missions-Einstellungen). Bedingungen initial leer → Nutzer kann sie im UI
   bearbeiten (Konstanten, kein Freitext-Regel-Compiler).
2. **Backtest-Orchestrierung:** additiver API-Slice (kein POST auf
   `/api/firm/backtests` — dort bewusst read-only). Nutzung von
   `runMultiAssetBacktest` bzw. `backtestRule` mit festen, dokumentierten
   Config-Defaults; Run-Persistenz via `runStore`, wenn geeignet.
3. **Metriken-Ansicht:** Rendite, Profit-Factor, MDD, Trades; leer-/Degraded-
   Zustände (kein Store/keine Daten) sichtbar, nie stille 0-Werte.
4. **Export „Als Regel aktivieren“:** ausschließlich über
   `sanitizeRuleSpec(…, "MANUAL")` + `upsertRuleSpec()`; kein Weg an der
   Guardrail-Prüfung vorbei; Fehler aus Transaktionen (z. B. UNIQUE-Konflikt)
   verständlich anzeigen.
5. **UI-Schritt:** `WorkshopTab` um den fünften Schritt erweitern; reset-lose
   Navigation; Zustand über existierende Firm-Props, keine neue Global-State-
   Engine.

## Explizit nicht Teil dieses Changes

- keine Änderung an `backtestRule()`-Kostenlogik (siehe PROMPT-BP-06)
- kein Regel-Editor mit freiem Bedingungs-Compiler (nur vordefinierte Felder
  aus `RULE_FIELDS`)
- keine Automatisierung „jeden Tag neue Regeln“

## Produktions- und Sicherheitsregeln

- Echter End-to-End-Pfad: Mission → Skelett → Replay → Metriken → Persistenz.
- Look-ahead-Verbot: Backtest nur gegen bis zum Analysezeitpunkt geschlossene
  Kerzen; den Replay-Code der Engine nicht duplizieren.
- Aktivierte Regeln bleiben hinter `RULE_CEILINGS`; `RULE_ALLOWED_SIDE` und
  Live-Gates unangetastet.
- Idempotenz: wiederholtes Aktivieren derselben Regel erzeugt keine
  Duplikate/Doppel-Active (Bestehende UNIQUE-Indizes und ruleService-Logik
  nutzen).
- Keine Secrets/PII im Payload; Audit-Events strukturiert.
- Keine TODOs, `any`-Fluchten, still geschluckten Fehler.

## Pflicht-Tests

- [ ] Mission→RuleSpec-Roundtrip: klemmt Budgets auf die Ceilings
- [ ] leerer Store/Degraded ⇒ sichtbarer Leerzustand, keine 0-Metriken
- [ ] Aktivieren via `upsertRuleSpec` ist idempotent (Retry- kein Duplikat)
- [ ] kein Look-ahead: Kerzen nach `validUntil` fließen nicht ein
- [ ] UI-Rendering inkl. Fehler- und Leerzustand (`test/ui/`)
- [ ] bestehende Workshop-/Backtest-Regressionen grün

Führe vor Abschluss mindestens aus:

```bash
npm run typecheck
npm run lint
npm test
npm run docs:validate
```

## Akzeptanzkriterien

- [ ] Ein Nutzer kann im UI eine Mission backtesten und das Ergebnis als
      DRAFT/ACTIVE-Regel anlegen; die Regel taucht im Regel-Tab auf.
- [ ] Metriken und Fehlerzustände sind dokumentiert und getestet.
- [ ] Kein Verhaltensbruch der bestehenden 4 Workshop-Schritte.
- [ ] kein Secret/Artefakt im Diff.

## Dokumentation, Versionierung und Tracking

1. `docs/MISSIONS.md` und Handbuch-Kapitel zur Workshop-Struktur um Schritt 5
   erweitern; API-Routen-Doku ergänzen.
2. Root-`CHANGELOG.md` pflegen.
3. `package.json`/`package-lock.json` nach SemVer konsistent erhöhen.
4. Finding + `../remediation/TRACKING.md` erst bei belegter DoD auf `FIXED`.
5. Aussagekräftig committen, `arena/*`-Branch pushen, PR öffnen.

## Erwartete Abschlussmeldung

Geänderte Dateien, End-to-End-Verhalten des neuen Schritts, Migrations-/
Kompatibilitätshinweise, ausgeführte Tests mit Ergebnis, verbleibende Risiken
sowie Commit-/PR-Link.