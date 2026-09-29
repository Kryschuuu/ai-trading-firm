# STX-05-01 — `src/screening/types.ts` + Prioritätsscoring

- **Phase:** 5 · **Paket:** 00-01, 03-01 · **Findings:** STX-07, L4 des Reports
- **Risiko:** niedrig (reine Funktionen, keine IO)

## Zweck

`StrategyMarketCandidate` wird das Objekt, das die Matrix-Zelle beschreibt, und die
Prioritätsfunktion das Objekt, das entscheidet, **welche Jobs zuerst gerechnet werden**.
Beides muss deterministisch und **konfigurierbar** sein — nicht mit Magic Numbers.

## Kontext

Das Ausbaudokument schlägt vor:

```
priority = 0.30·dataQuality + 0.25·liquidity + 0.20·freshness
         + 0.15·strategyFit + 0.10·volatilityOpportunity − correlationPenalty
```

**Das ist eine Magic-Number-Konstante.** Sie gehört in eine versionierte Config
(Muster `src/scanner/config.ts` + `scanner.config.json`), damit sie später
kalibrierbar ist, ohne Code anzufassen — und damit 06-02 die Gewichte überhaupt
verändern kann.

## Auftrag

Lege `src/screening/types.ts` und `src/screening/priority.ts` an.

### `types.ts`

```ts
export type CandidateStatus =
  | "DISCOVERED" | "READY" | "BACKTEST" | "VALIDATED" | "PAPER" | "BLOCKED";

export interface StrategyMarketCandidate {
  templateId: StrategyTemplateId;
  templateVersion: number;
  strategyClass: StrategyClassKey;

  instrumentId: string;        // SSoT: @/universe
  venue: BrokerVenueId;
  timeframe: SupportedTimeframe;

  /** Datenqualität [0,1]; null = unbekannt (nie 0!). */
  dataQuality: number | null;
  /** Liquidität [0,1]; null = unbekannt. */
  liquidity: number | null;
  /** Frische [0,1]; null = unbekannt. */
  freshness: number | null;
  /** Passung Strategie↔Marktsegment [0,1]; null = unbekannt. */
  strategyFit: number | null;
  /** Volatilitäts-Chancenklasse [0,1]; null = unbekannt. */
  volatilityOpportunity: number | null;
  /** Cluster-/Korrelationzuschlag [0,1]; 0 = kein Zuschlag. */
  correlationPenalty: number | null;

  priority: number | null;     // Ergebnis von scoreCandidate()
  status: CandidateStatus;
  /** Warum BLOCKED/READY — Fail-closed-Begründung, nie still 0. */
  reasons: readonly string[];
}
```

### `priority.ts`

1. **`SCREENING_PRIORITY_CONFIG`** (in `src/screening/config.ts`, Muster `scanner/config.ts`):
   Gewichte + `correlationPenaltyWeight`, jeweils mit Default **und** Bounds.
   Defaults aus dem Ausbaudokument, **aber** mit Begründung im Doc-Kommentar:
   > „Datenqualität zuerst, weil ein Backtest auf unvollständigen Daten keine Aussage
   > hat; Liquidität an zweiter Stelle, weil sie bestimmt, ob der spätere Live-Einstieg
   > überhaupt möglich ist (Spread frisst die Edge). Die Werte sind **Startwerte**, keine
   > Optima — die Kalibrierung gegen echte Screening-Läufe ist ein späterer Vorgang."

2. **`scoreCandidate(c: StrategyMarketCandidate, cfg): ScoreResult`**
   ```ts
   type ScoreResult =
     | { ok: true; priority: number; contributions: Record<string, number> }
     | { ok: false; errors: string[] };
   ```
   - **Jedes `null`-Feld ⇒ `{ok:false}` mit benanntem Grund.** Kein Default 0, kein
     „neutral 0.5". Das ist die Repo-Konvention (`regimeEvaluation.ts`:
     *„niemals mit 0 ersetzt"*) und wird hier konsequent angewandt.
   - `correlationPenalty: null` ist **erlaubt** und wird als 0 gewertet — die
     Abwesenheit einer Korrelationsbewertung ist kein Datenmangel, sondern eine
     nicht durchgeführte Zusatzanalyse. **Diese Asymmetrie muss im Doc-Kommentar
     begründet stehen**, sonst liest sie sich wie ein Fehler.
   - Rückgabe in `[0,1]`, klemmen.
   - `contributions` macht jeden Term **sichtbar** — Grundlage für 06-01 („welcher Term
     dominiert die Auswahl?").

3. **`classifyStatus(c, cfg): CandidateStatus`** — rein aus Datenlage:
   - `BLOCKED`, wenn Datenqualität/Liquidität unter den Config-Schwellen liegen
     (mit `reasons`-Eintrag)
   - `DISCOVERED` bei fehlender Strategie-Persistenz (04-02)
   - `READY` sonst
   *Keine* Backtest-/Validierungslogik — die Statusmaschine ist 05-02.

4. **Fixture-basierte Invarianz-Test** (in `tests/screening.priority.test.ts`, sofort
   mitliefern):
   - `null` in jedem Pflichtfeld ⇒ `{ok:false}` mit passendem Grund
   - Gewicht 0 ⇒ Term fällt aus der Summe, **nicht** aus der Fehlerliste
   - Umordnung der Terme ändert das Ergebnis **nicht** (kein Reihenfolge-Einfluss)
   - `correlationPenalty: null` ⇒ identisch zu `0`
   - Konfig-Änderung ⇒ andere Priorität (der Kalibrierungspfad funktioniert)

## Akzeptanzkriterien

- [ ] Keine Gewichtungskonstante außerhalb `SCREENING_PRIORITY_CONFIG`
- [ ] `scoreCandidate` ist **pure** (keine IO, keine Uhr)
- [ ] Kein `null` → 0 (außer dem dokumentierten `correlationPenalty`-Fall)
- [ ] `npm run typecheck && npm run lint && npm test` grün
- [ ] **Kein** Matrix-Builder (05-02), **keine** DB (05-03)

## Gesperrt

- Kein Zugriff auf Scanner-/Store-/Registry-Daten in `priority.ts` (nur Typen-Imports).
- Keine Änderung an `src/scanner/config.ts`.
- **Kein** Persistenz- oder Scheduler-Code.
