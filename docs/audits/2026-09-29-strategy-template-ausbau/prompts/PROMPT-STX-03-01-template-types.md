# STX-03-01 — `src/strategies/types.ts`: Der Template-Vertrag

- **Phase:** 3 · **Paket:** 01-01, 00-03 (ADR-E1/E2/E3) · **Finding:** STX-05 (Korrektur)
- **Risiko:** hoch (Design-Entscheidung für die ganze Phase 3)

## Zweck

Eine **Strategie** soll ein versioniertes, technisches Artefakt sein — kein Prompt-Text.
Dieser Prompt definiert den Vertrag. Er ist die wichtigste Datei der Roadmap, weil
**jede** spätere Datei davon abhängt.

## Kontext — der entscheidende Designfehler im Ausbaudokument

Vorgeschlagen war:

```ts
buildRule?: (ctx: StrategyContext) => RuleSpec;                        // ❌
buildUniverseStrategy?: (ctx: StrategyContext) => MultiAssetStrategySpec; // ❌
```

`ctx` enthält Marktdaten. Ein Builder, der zur Laufzeit aus Marktdaten eine fertige
`RuleSpec` erzeugt, umgeht `sanitizeRuleSpec()`, die `RULE_CEILINGS` und die
Persistenz — also genau die Kette, die `ruleEngine.ts:7-12` als Sicherheitsmodell
beschreibt. Zusätzlich ist das Ergebnis **nicht reproduzierbar** und **nicht auditierbar**.

**Korrektur:** Der Builder ist eine **pure Funktion der Parameter**, und der Rückgabetyp
ist die **Rohform**, damit `sanitizeRuleSpec()` immer läuft.

## Auftrag

Lege `src/strategies/types.ts` an. Reine Typen, keine Logik, keine IO, kein DB-Import
(gleiche Regel wie `src/lib/missionTemplates.ts`).

```ts
/** Strategieklasse — BEWIESEN das bestehende Vokabular (ADR-E1). */
import type { StrategyClassKey } from "@/lib/signalDecay";
import type { SupportedTimeframe } from "@/lib/marketdata/historicalStore";
import type { RuleSpecInput } from "@/lib/ruleEngine";
import type { MarketRegime } from "@/lib/marketRegime";
import type { MissionScope } from "@/lib/missionTemplates";

/** Eine abstrahierte, versionierte Annahme einer Strategie. */
export interface StrategyAssumption {
  id: string;                    // stabil, ^[a-z0-9-]{1,64}$
  statement: string;             // deutscher Klartext
  category:
    | "MARKET"        // z. B. „Trend-Phasen sind häufiger als Seitwärtsphasen"
    | "COST"          // z. B. „Gebühren bleiben auf dem Niveau des Backtests"
    | "LIQUIDITY"     // z. B. „Orderbuch ist mindestens so tief wie die Position"
    | "DATA"          // z. B. „Keine Lücken > 2 Bars im Fenster"
    | "REGIME"        // z. B. „Funktioniert nur in TREND_UP/TREND_DOWN"
    | "EXECUTION";    // z. B. „Fills innerhalb eines Bars"
  /** true = ohne diese Annahme ist das Ergebnis wertlos. */
  critical: boolean;
}

export type ParamKind = "threshold" | "period" | "ratio";

export interface ParamSpec {
  key: string;                   // ^[a-zA-Z][a-zA-Z0-9]{0,31}$
  kind: ParamKind;
  label: string;                 // deutsch
  unit: string;                  // z. B. "%" | "Bars" | "ratio"
  default: number;
  min: number;
  max: number;
  step: number;                  // Raster für die Sensitivitätsanalyse (06-02)
  /** Regel-Feld, das dieser Parameter speist (Doku-Zweck, keine Auswertung). */
  mapsTo: RuleField;
}

/** Ein versioniertes, parametrisiertes Strategie-Artefakt. */
export interface StrategyTemplate {
  /** stabil, schema-validiert: ^[a-z0-9-]{3,64}$ */
  id: string;
  /** Anzeigename (deutsch). */
  name: string;
  description: string;
  /** Monoton steigend bei Semantikänderung. Teil des Artefakt-Hashs. */
  version: number;

  /** ADR-E1: Pflicht, aus dem BESTEHENDEN Vokabular. */
  class: StrategyClassKey;

  /** 03-xx: nur SINGLE_SYMBOL, abgeleitet aus dem bestehenden `MissionScope`. Ein UNIVERSE-Scope entfällt (ADR-010, ADR-E3). */
  scope: Extract<MissionScope, "SINGLE_SYMBOL">;

  /** Aus `SUPPORTED_TIMEFRAMES` abgeleitet, nie eigenes Vokabular. */
  supportedTimeframes: readonly SupportedTimeframe[];

  /** Felder, die das Template auswertet — Teil von `RULE_FIELDS`. */
  requiredFields: readonly RuleField[];

  params: Readonly<Record<string, ParamSpec>>;

  /**
   * PURE Funktion der Parameter. KEIN ctx, KEIN Marktdatenzugriff.
   * Rückgabe ist die ROHFORM — `sanitizeRuleSpec()` ist Pflicht im Aufrufer.
   */
  buildRule(params: Readonly<Record<string, number>>): RuleSpecInput;

  /** Was diese Strategie annimmt — wird 06-01 auditiert. */
  assumptions: readonly StrategyAssumption[];

  /** Regime, in denen die Strategie plausibel ist (ADR-009, ADR-E2: bestehendes Vokabular, ohne `UNKNOWN`). */
  expectedRegimes: readonly MarketRegime[];
}
```

## Entscheidungen, die du treffen und im Doc-Kommentar begründen musst

1. **`StrategyClassKey` vs. `StrategyClass`.** `signalDecay` exportiert
   `StrategyClassKey = StrategyClass | "unclassified"`. Nach ADR-E1 darf **kein**
   Template `unclassified` sein. Typisiert trotzdem gegen `StrategyClassKey` (ADR-E1) und
   lass `class: "unclassified"` zur Laufzeit **ablehnen** (03-02).
2. **Warum `RuleSpecInput` und nicht `RuleSpec`.** Schreibe die Begründung als
   Doc-Kommentar an `buildRule` — sie ist der Grund, warum dieses Repo sicher ist.
3. **Warum kein `buildUniverseStrategy`.** ADR-E3: `src/crossSectional/` besitzt das
   bereits. Verweise darauf.

## Akzeptanzkriterien

- [ ] Keine Runtime-Dependency außer Typ-Importen
- [ ] `npm run typecheck` grün
- [ ] Modul-Importe: `type` only, keine Wertausdrücke
- [ ] Jedes `mapsTo` verweist auf ein **existierendes** `RULE_FIELDS`-Feld
      (nach 02-02/02-03: `bbZScore`, `donchianBreakoutPct` …)
- [ ] Kein `StrategyContext`, kein `ctx`, kein Marktdatenparameter in irgendeiner Signatur
- [ ] Kein eigener Klassen-/Regime-/Timeframe-Typ definiert
- [ ] `expectedRegimes` ist `readonly MarketRegime[]` (kein `UNKNOWN`, ADR-009); `scope` leitet sich aus `MissionScope` ab (ADR-010)

## Gesperrt

- **Kein** `src/strategies/catalog.ts` (03-02), **keine** Templates (03-03…03-08),
  **kein** `compiler.ts` (03-09).
- **Keine** Änderung an `ruleEngine.ts`, `ruleFieldCatalog.ts`, `signalDecay.ts`.
- **Kein** `MultiAssetStrategySpec` (ADR-E3).
