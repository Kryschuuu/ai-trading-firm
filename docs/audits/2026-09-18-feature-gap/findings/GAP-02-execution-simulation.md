# GAP-02 — Realistische Execution-Simulation im PaperBroker

**Nutzen:** ★★★★★ · **Aufwand (Co-Audit):** 🔧🔧 · **Aufwand (verifiziert):** 🔧
**Kategorie:** Ehrlichkeit · **Prompt:** [`PROMPT-02`](../prompts/PROMPT-02-execution-simulation.md)

## Befund (Co-Audit)

Ohne Slippage/Gebühren/Funding/Teil-Fills/Latenz ist jede Paper-Performance
systematisch zu optimistisch — gerade bei Shorts auf Perpetuals frisst Funding
oft die Edge. Modelle müssen kalibrierbar sein (Env/Config).

## Verifizierter Ist-Stand (2026-09-18, v1.40.0)

- `PaperExecutionAdapter` (Task 03, `src/lib/broker.ts`) + Implementierung
  `createPaperExecution` (`src/lib/marketdata/production.ts`): deterministischer
  Fill-Simulator mit **Gebühren, Spread, Slippage, Partial Fills**;
  `Fill.fees`/`Fill.partial` ausgezeichnet; Vorab-Cash-Guard rechnet geschätzte
  Slippage + Gebühren konservativ ein.
- **Funding-Raten fehlen im PnL:** Funding existiert nur als Scanner-Ranking-
  Faktor (`src/scanner/factors/funding.ts`) — keine Accrual auf offene
  Perpetual-Positionen, kein Ausweis im Equity-/Positionsstand.
- Kalibrierbarkeit der Simulationsparameter (Gebührenprofil je Venue,
  Slippage-Koeffizienten) über Env/Config ist begrenzt/nicht dokumentiert.

## Delta

1. Funding-Accrual je Perpetual-Position im PaperBroker (periode, Vorzeichen-
   konvention long zahlt bei positiver Rate), Quelle konfigurierbar
   (Konstante/Env; echter Adapter optional), kumulierter Ausweis je Position
   + Equity.
2. Kalibrierbare Parameter (Maker/Taker-Gebühren, Slippage-Modell, Spread-
   Fallback) über Env/Config mit Bounds und sicheren Defaults, dokumentiert in
   `CONFIGURATION.md`/`.env.example`.
3. Determinismus-Eigenschaft erhalten: gleiche Quotes → gleiche Fills (Test).

## Akzeptanzkriterien (kurz)

Funding-Richtung/Betrag-Tests, Bounds-Tests, Determinismus-Test, Equity inkl.
Funding, Docs/Flags/Changelog.
