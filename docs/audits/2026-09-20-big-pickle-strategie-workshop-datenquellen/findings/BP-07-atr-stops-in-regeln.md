# BP-07: Regeln können keinen ATR-basierten Stop formulieren

- **Antwort:** Offen
- **Tracking-Status:** `OPEN`
- **Severity:** `MEDIUM`
- **Quick Estimate Restaufwand:** **2–3 PT**
- **Umsetzungs-Prompt:** [`PROMPT-BP-07`](../prompts/PROMPT-BP-07-atr-stops-in-regeln.md)

## Verifizierte Fundstellen

- `src/lib/ruleEngine.ts:89-96` — `RuleAction` erzwingt `stopLossPct` (Klemmung
  `:358`, Default 5). Kein Feld für ATR-basierte Distanz.
- `src/lib/positionSizing.ts` — Fallback-Stop via `RISK_ATR_STOP_MULT`
  (Bounds [0.5, 6]) existiert im Sizing-Pfad, ist aber **nicht** pro Regel
  einstellbar.
- `src/lib/riskGuard.ts` — `RiskLimits.atrStopMultiplier` vorhanden; fließt in
  keine Regel-Action.
- `src/db/schema.ts:117` — `trade_rules.action` ist `jsonb`: ein neues
  optionales Action-Feld braucht **keine** DB-Migration; der `signature`-Hash
  (`:121`) deckt das Feld automatisch ab.

## Bewertung und Abgrenzung

Feste Prozent-Stops sind in Volatilitätsregimen zu eng oder zu weit; der Code
kennt ATR-Stops bereits an zwei Stellen (Sizing-Fallback, RiskLimits), aber die
Regel-Sprache kann sie nicht ausdrücken. Ergebnis: Regeln tragen in
Squeeze-/Expansionsphasen ein implizit schwankendes Risiko-Rendite-Profil.

## Konkretes Delta

- `RuleAction.atrStopK` (optional, Bounds [0.5, 6]) in `RuleAction`,
  `sanitizeRuleSpec`, `RULE_CEILINGS`, `RULE_LLM_SCHEMA`.
- `positionSizing.ts`: atrStopK-Pfad vor dem dokumentierten Fallback; expliziter
  Vorrang: wenn `stopLossPct` und `atrStopK` beide gesetzt, gewinnt `stopLossPct`.

## Akzeptanzkriterien für `FIXED`

- [ ] `atrStopK` ist geklemmt, validiert und im LLM-Schema dokumentiert.
- [ ] beide Felder zusammen verhalten sich deterministisch (Vorrang getestet).
- [ ] DB-Roundtrip (jsonb action) und `signature`-Hash unverändert stabil.
- [ ] alte Regeln ohne `atrStopK` bleiben byte-identisch (Abwärtskompatibilität).
- [ ] Pflichtgates grün.

## Review-Evidenz

- Audit-Basis: Commit `7d8b07b`, Produktversion `v1.51.3`.
- Methode: Schema- und Sizing-Pfadprüfung.