# STX-03-09 — Compiler: Template + Params → `RuleSpec`, mit Sanitize-Nachweis

- **Phase:** 3 · **Paket:** 03-03…03-08 · **Finding:** STX-05
- **Risiko:** hoch (der sicherheitskritische Übergang)

## Zweck

Dieser Prompt beweist, dass die von 03-01 festgelegte Kette
`Template → buildRule(params) → sanitizeRuleSpec() → persistierbarer RuleSpec`
tatsächlich **geschlossen** ist — insbesondere, dass der Template-Weg die
Sicherheitsmechanismen des Repos **nicht** umgeht.

## Kontext

`ruleEngine.ts:7-12` formuliert das Sicherheitsmodell. `sanitizeRuleSpec()` ist der
einzige Ort, an dem unbekannte Felder fallen, Operatoren begrenzt und Zahlen gegen
`RULE_CEILINGS` geklemmt werden. Ein Template-Pfad, der `sanitizeRuleSpec()` umgeht,
macht dieses Modul wertlos.

Die Beweisführung ist der eigentliche Deliverable — nicht der Compiler selbst
(der ist ~100 Zeilen).

## Auftrag

Lege `src/strategies/compiler.ts` an.

1. **`compileTemplate(input): CompileResult`**

   ```ts
   type CompileResult =
     | { ok: true; spec: RuleSpec; fingerprint: string }
     | { ok: false; errors: string[] };
   ```

   Schritte, **in dieser Reihenfolge** — und der Compiler darf keine zusammenfassen:
   1. Template via `getTemplate(id)` auflösen → Fehler, wenn unbekannt
   2. `class === "unclassified"` ablehnen (ADR-E1)
   3. `timeframe ∈ template.supportedTimeframes` prüfen
   4. **Parameter validieren**: jeder Default muss im `[min,max]`-Raster liegen;
      unbekannte Parameter-Keys ablehnen; `params` **fehlende** Schlüssel ⇒ Default
   5. `buildRule(params)` aufrufen — **in einem `try`**, Hashfehler ⇒ `{ok:false}`
   6. `validateTemplate`-Teile erneut prüfen (der Builder darf nicht außerhalb der
      Template-Bounds Parameter erzeugen)
   7. `symbol` einsetzen (vom Aufrufer, **nicht** aus dem Template)
   8. **`sanitizeRuleSpec(raw)` aufrufen** ← der Pflichtschritt
   9. `spec.sourceRole` auf `"RESEARCH"` forcieren, wenn das Template nicht
      ausdrücklich etwas anderes verlangt (Templates sind nie `MANUAL`)
  10. `ruleWithinRuntimeLimits(spec)` prüfen (existiert in `ruleService.ts`)

   **Punkt 8 ist der Kern.** Wenn `sanitizeRuleSpec` einen Fehler liefert, ist das
   `{ok:false, errors}` — **kein** Fallback auf die Rohform.

2. **Klemm-Differenz explizit machen.** `CompileResult` enthält zusätzlich
   `clamped: string[]` (Feld-Name, roher Wert, geklemmter Wert), damit 03-10 und 06-01
   sehen können, wenn ein Template „lief" nur, weil es geklemmt wurde. Ein Template,
   das **ständig** klemmt, ist kaputt.

3. **`fingerprint`** = `sha256` über `canonicalJson({ templateId, version, params,
   timeframe, symbol, codeVersion })`. Muster: `strategyLifecycle/evidence.ts`
   (`canonicalJson`, `evidenceContentHash`). **Der Fingerprint ist der Schlüssel für
   Idempotenz (04-02) und Cache (05-04)** — er muss stabil sein.

4. **`exportTemplates()`-Testhelper**: kompiliert alle Templates des Katalogs mit
   Default-Params über alle `supportedTimeframes` und liefert eine flache Liste.

## Der Pflicht-Beweis (`tests/strategies.compiler.security.test.ts`)

| Test | Aussage |
|---|---|
| `sanitizeRuleSpec` wurde aufgerufen | Monkey-Patch/Instrumentierung: Compiler ohne Sanitize ⇒ Test schlägt fehl |
| Clamping | Template mit `stopLossPct: 999` (per `as any` in den Builder) ⇒ Ergebnis hat den **Ceiling**-Wert, `clamped` ist gefüllt |
| Unbekanntes Feld | Builder liefert `condition.field: "oracle"` ⇒ `{ok:false}`, **nicht** durchgelassen |
| Fremder Operator | `op: "exec"` ⇒ `{ok:false}` |
| `SHORT` | `action.side: "SHORT"` ⇒ `{ok:false}` |
| Fehlendes Pflichtfeld | `adx14` aus `condition` entfernt (per `as any`) ⇒ der Builder darf das, aber die Strategie ist dann ungültig: `{ok:false}` mit `requiredFields`-Fehler |
| Fingerprint-Stabilität | Gleiche Eingabe ⇒ gleicher Fingerprint; andere `APP_VERSION` ⇒ **anderer** |
| ROLLOUT | `exportTemplates()` ⇒ **6** Templates, alle `ok:true`, alle ohne `clamped` |

## Akzeptanzkriterien

- [ ] Kein Pfad im Compiler erzeugt eine `RuleSpec` **ohne** vorherigen
      `sanitizeRuleSpec()`-Aufruf
- [ ] `{ok:false}`-Fälle geben **Fehlerstrings** zurück, werfen nicht
- [ ] `fingerprint` ist über Prozessgrenzen stabil (kein `Date.now()`, keine Objekt-Reihenfolge)
- [ ] `exportTemplates()` läuft ohne DB und ohne Netz
- [ ] `npm run typecheck && npm run lint && npm test` grün
- [ ] `ruleEngine.ts` **unverändert** (Diff beweist es)

## Gesperrt

- **Keine** Änderung an `sanitizeRuleSpec`, `compileRuleSpec`, `RULE_CEILINGS`.
- **Kein** Schreiben in die DB (Persistenz ist 04-02).
- **Keine** Rückfallroute auf die Rohform bei Sanitize-Fehlern.
- Keine LLM-/Prompt-Logik.
