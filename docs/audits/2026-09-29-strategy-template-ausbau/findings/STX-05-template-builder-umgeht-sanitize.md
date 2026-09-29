# STX-05 — `buildRule(ctx)` als Runtime-Builder umgeht „Code entscheidet"

- **ID:** STX-05
- **Severity:** HIGH
- **Bereich:** Sicherheit / Handelslogik
- **Quelle:** Ausbaudokument §1.2
- **Status:** OPEN
- **Datei(en):** `src/lib/ruleEngine.ts`, `src/lib/ruleService.ts`

## Beschreibung

Der Entwurf schlägt vor:

```ts
buildRule?: (ctx: StrategyContext) => RuleSpec;         // ❌
buildUniverseStrategy?: (ctx: StrategyContext) => MultiAssetStrategySpec;  // ❌
```

`ctx` ist zur Laufzeit verfügbar. Damit existiert ein zweiter Weg von
(marktdatenabhängigem) Input zu einer handelbaren Regel, der an Whitelist,
`RULE_CEILINGS` und Persistenz vorbeiläuft.

## Beweis / Begründung

Das Sicherheitsmodell des Repos ist explizit formuliert (`ruleEngine.ts:7-12`):

> „Der Makro-Zyklus (LLM) liefert nur einen *Vorschlag* (RuleSpecInput). `sanitizeRuleSpec()`
> baut daraus ein NORMALISIERTES Objekt … Jeder numerische Wert wird gegen `RULE_CEILINGS`
> geklemmt, die aus `LIMIT_CEILINGS` (`riskGuard.ts`) abgeleitet sind. **Eine bösartige oder
> halluzinierte Regel kann NIE mehr Risiko fordern, als der Code zulässt.**"

Ein `ctx`-Builder bricht diese Kette: das erzeugte `RuleSpec` ist bereits „fertig" und
muss nicht mehr durch `sanitizeRuleSpec()`. Ein LLM, das `ctx` kontrolliert, könnte
`stopLossPct`/`maxPositionPct` wählen, die nie geklemmt wurden.

Zusätzlich: `RuleSpec` wird **persistiert** (`trade_rules`, `ruleService.upsertRuleSpec`).
Ein flüchtiger Runtime-Builder erzeugt eine nicht-reproduzierbare, nicht-auditierbare Regel.

## Remediation

Templates sind **Parameterraster**, der Builder eine **pure Funktion der Parameter**:

```ts
buildRule(params: Record<string, number>): RuleSpecInput;   // ✅ kein ctx
```

- Rückgabetyp `RuleSpecInput` (Rohform), damit `sanitizeRuleSpec()` **immer** läuft.
- Der Compiler-Kontrakt (STX-03 des Dokuments) lautet: `buildRule(params)` →
  `sanitizeRuleSpec()` → **persistieren** → `backtestRule()`/`MicroExecutor`.
- Feature-Zugriff ausschließlich über `RULE_FIELDS` (kein Feld-gegen-Feld-Ausdruck).

## Akzeptanzkriterien

- [ ] `StrategyTemplate` hat **kein** `StrategyContext`/`ctx` im Builder
- [ ] Rückgabetyp ist `RuleSpecInput`, nicht `RuleSpec`
- [ ] Test: ein Builder-Output mit `stopLossPct: 999` wird auf das Ceiling geklemmt
- [ ] Jedes erzeugte Spec wird persistiert, bevor es gehandelt wird

## Versions-Hinweis

Major (Sicherheitsgrenze — betrifft die Designentscheidung, nicht den Codebestand).
