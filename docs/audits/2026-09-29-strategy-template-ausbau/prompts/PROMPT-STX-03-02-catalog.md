# STX-03-02 — Template-Katalog + Registry-Validierung

- **Phase:** 3 · **Paket:** 03-01 · **Findings:** STX-02, STX-05
- **Risiko:** niedrig

## Zweck

Ein Katalog, der Templates **beim Import prüft**, nicht erst beim Backtest. Der
gesamte Sicherheitswert des Projekts hängt daran, dass eine kaputte Strategie
**früher** stirbt als eine kaputte Order.

## Kontext

`src/lib/missionTemplates.ts` zeigt die Repo-Konvention: *„Reine Daten, keine
Nebenwirkungen … Kein Drift zwischen Formular, Seed und Doku."* Der Katalog ist die
SSoT, aus der später Workshop-UI, CLI und Tests lesen — es darf nur **eine** geben.

## Auftrag

Lege `src/strategies/catalog.ts` an:

1. **`STRATEGY_TEMPLATE_IDS`** — geschlossene Union der geplanten IDs:
   `"ema-adx-trend" | "macd-momentum" | "rsi-mean-reversion" | "bollinger-squeeze" |
   "vwap-pullback" | "donchian-breakout"`
   *(Die Templates selbst kommen in 03-03…03-08 — dieser Prompt liefert den leeren,
   aber validierten Katalog.)*

2. **Validierungsfunktion `validateTemplate(t: StrategyTemplate): string[]`**, die
   **fail-closed** eine Liste von Fehlern liefert (leer = gültig). Prüfe:

   | Prüfung | Regel |
   |---|---|
   | ID-Format | `^[a-z0-9-]{3,64}$` |
   | Version | Ganzzahl ≥ 1 |
   | Klasse | in `STRATEGY_CLASS_KEYS` **und** ≠ `"unclassified"` (ADR-E1) |
   | Timeframes | nicht leer, jeder in `SUPPORTED_TIMEFRAMES`, **keine** Duplikate |
   | `requiredFields` | jeder Wert ein Schlüssel von `RULE_FIELDS`; jeder ist **kein** unbekannter Feldname |
   | Params | jede `ParamSpec` hat `min ≤ default ≤ max`, `step > 0`, eindeutigen `key` |
   | `mapsTo` | verweist auf existierendes `RULE_FIELDS`-Feld |
   | Builder | deterministisch: zweimal `buildRule(defaults)` ⇒ **tiefengleich** |
   | Builder | Rückgabe ist ein **Objekt**; kein `undefined`, kein Array |
   | Builder | jeder Bedingungs-`field` in der Rückgabe steht in `RULE_FIELDS` |
   | Builder | **kein** `action.side` ≠ `"LONG"` |
   | Builder | **kein** Zahlenwert außerhalb `RULE_CEILINGS` (ohne sanitize wäre das ein Bug) |
   | Assumptions | jede `id` eindeutig, `statement` nicht leer |
   | `expectedRegimes` | jedes Element ein gültiges `MarketRegimeLabel` |

3. **`STRATEGY_TEMPLATES: readonly StrategyTemplate[]`** — zunächst leer.
   Ergänze einen **eingebauten Negativfall**: ein absichtlich kaputtes Template im
   `__fixtures`-Bereich (nicht exportiert), damit `validateTemplate` im Test etwas zu
   beanstanden hat.

4. **Helper:**
   - `getTemplate(id: StrategyTemplateId): StrategyTemplate | null`
   - `listTemplates(): readonly StrategyTemplate[]`
   - `templateByField(field: RuleField): readonly StrategyTemplate[]` — hilft später bei
     „welches Template nutzt `bbwPct`?"

5. **Ein `assertTemplatesValid()`-Aufruf beim Modul-Import** — wirft bei einem
   ungültigen Template. Das ist der Punkt: ein kaputtes Template darf den Prozess
   **nicht** starten.

## Akzeptanzkriterien

- [ ] `tests/strategies.catalog.test.ts`: ≥ 10 Negativfälle, je ein erwarteter Fehler
- [ ] `assertTemplatesValid()` wirft beim Negativ-Template
- [ ] Ein Template mit `class: "unclassified"` wird abgelehnt
- [ ] Ein Builder mit `stopLossPct: 999` wird abgelehnt
- [ ] Ein Builder mit `action.side: "SHORT"` wird abgelehnt
- [ ] Ein Builder, der ein Feld außerhalb `RULE_FIELDS` nutzt, wird abgelehnt
- [ ] `npm run typecheck && npm run lint && npm test` grün
- [ ] Kein Template implementiert (kommt in 03-03…03-08)

## Gesperrt

- **Keine** Templates in diesem Prompt.
- **Keine** Änderung an `RULE_CEILINGS` — der Katalog **liest** sie, erweitert sie nicht.
- **Keine** LLM-/Prompt-Logik. Der Katalog ist deterministisch.
