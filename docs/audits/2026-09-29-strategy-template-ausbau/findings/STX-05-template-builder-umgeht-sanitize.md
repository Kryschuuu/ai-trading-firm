# STX-05 — `buildRule(ctx)` als Runtime-Builder umgeht „Code entscheidet"

- **ID:** STX-05
- **Severity:** HIGH
- **Bereich:** Sicherheit / Handelslogik
- **Quelle:** Ausbaudokument §1.2
- **Status:** FIXED (03-09, `v0.7.5`) — 03-01 legte den `params`-Builder fest, 03-09 schloss die Kette nachweislich
- **Datei(en):** `src/lib/ruleEngine.ts`, `src/lib/ruleService.ts`, `src/strategies/compiler.ts` (neu, 03-09)

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

- [x] `StrategyTemplate` hat **kein** `StrategyContext`/`ctx` im Builder — 03-01
      (`v0.7.0`, `src/strategies/types.ts`: `buildRule(params: Readonly<Record<string, number>>): RuleSpecInput`)
- [x] Rückgabetyp ist `RuleSpecInput`, nicht `RuleSpec` — 03-01, mit Begründung im
      Vertrag (ein `RuleSpec`-Rückgabetyp würde den Sanitizer überspringbar machen)
- [x] Test: ein Builder-Output mit `stopLossPct: 999` wird auf das Ceiling geklemmt —
      03-09 (`v0.7.5`), `tests/strategies.compiler.security.test.ts`: Ergebnis hat den
      Ceiling-Wert und `clamped` nennt „`action.stopLossPct: 999 → 20`"
- [ ] Jedes erzeugte Spec wird persistiert, bevor es gehandelt wird — **offen
      (04-02)**: Der Compiler schreibt bewusst nichts in die DB; die Persistenz
      liefert der Strategie-Service, der `compileTemplate()` aufruft und den
      `fingerprint` als Idempotenz-Schlüssel nutzt.

## Behoben durch 03-09 (`v0.7.5`)

`src/strategies/compiler.ts` ist der **einzige** Aufrufer von `buildRule()` und
führt jede Rohform zwingend durch `sanitizeRuleSpec()`:

- Schritt 8 der Kette ist Pflicht; ein Sanitize-Fehler ist `{ok:false}` mit
  Fehlerstrings — **kein** Rückfall auf die Rohform (Test ersetzt den Sanitizer
  durch einen Sentinel und beweist, dass genau dessen `spec` zurückkommt).
- Klemmungen werden als `clamped: string[]` sichtbar gemacht, statt als stiller
  Erfolg zu gelten.
- `strategyClass` stammt ausschließlich aus `template.class` (ADR-008).
- `ruleEngine.ts` bleibt **unverändert** — der Compiler liest `RULE_CEILINGS` und
  `RULE_FIELDS`, er erweitert sie nicht.

## Versions-Hinweis

Major (Sicherheitsgrenze — betrifft die Designentscheidung, nicht den Codebestand).
