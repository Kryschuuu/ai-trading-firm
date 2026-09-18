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

## Umsetzung (v1.42.0, 2026-09-18)

Umgesetzt in Branch `arena/01a0b48a-ai-trading-firm` (PROMPT-02, Start der
Serie). Ist-Stand vorab verifiziert — er entsprach exakt dem Audit: Simulator
mit Gebühren/Spread/Slippage/Partial-Fills vorhanden, Funding nur als
Scanner-Faktor, keine Abweichung zu dokumentieren.

- **D1 Funding-Accrual:** Neues Modul `src/lib/funding.ts` (Formel, Perioden-
  Tracker, Engine, Buchung), aufgerufen im Monitor-Tick
  (`src/lib/monitor.ts`, Abschnitt 2b) bei Periodenwechsel (Default 8h-Marke
  UTC, `PAPER_FUNDING_INTERVAL_HOURS`, Bounds [1, 24]). Rate-Quelle gestuft:
  statisch `PAPER_FUNDING_RATE_PCT_PER_8H` (Default 0 = neutral) vor
  `FundingRateProvider`-Interface (Erweiterungspunkt, ohne Netzwerk in diesem
  Release). Neue Spalte `positions.funding_paid` (append-only-Migration
  `drizzle/2026-09-18_positions_funding.sql`). Accrual-Ereignis revisionssicher
  im `audit_log` (`FUNDING_ACCRUAL`, Muster `funding:SYMBOL:+0.42`); Clock
  injizierbar (`nowMs`-Parameter, kein `Date.now()` in der Engine).
- **D2 Equity & Ausweis:** Funding wirkt als Cashflow auf Cash/Equity (wie
  Gebühren beim Fill, keine Doppelzählung); `accrueFunding`/`totalFundingPaid`
  im PaperBroker, Restore hydratiert `funding_paid`; `GET /api/firm` zeigt
  `fundingPaid` je Position + `account.fundingPaid`/`fundingPaidOpen`.
- **D3 Kalibrierung:** `PAPER_MAKER_FEE_PCT`, `PAPER_TAKER_FEE_PCT`,
  `PAPER_SLIPPAGE_BPS`, `PAPER_SPREAD_FALLBACK_BPS` als Overlay über die
  `PAPER_SIM_*`-Basis in `createPaperExecution`
  (`calibrateSimulatorConfig`); Defaults = heutige Werte (kein Bruch),
  Bounds-Clamp mit Log-Warnung (`envNumber`, `src/lib/env.ts`).
- **D4 Determinismus:** Engine rein (injizierbare Zeit, kein Random);
  Determinismus-Test: identische Quote-Folge ⇒ SHA-256-identische Fills.
- **Tests:** `tests/paper.funding.test.ts` (15 Tests) deckt jede Anforderung
  ab; alle bestehenden Broker-/Marketdata-Tests unverändert grün.
- **Docs:** `docs/PAPER_TRADING.md` §3.1/§3.2 (inkl. Vorzeichenkonvention),
  `CONFIGURATION.md`, `.env.example`, CHANGELOG 1.42.0.

**Offene Punkte (bewusst nicht in diesem Release):** echte Funding-Raten-
Anbindung (z. B. Bitunix REST) hinter dem Provider-Interface; Funding-Drift
bei Crash zwischen DB-Update und Equity-Snapshot (selbstheilend mit dem
nächsten Tick, Paper-modus-akzeptabel); ausgefallene Marken während eines
Prozess-Stillstands werden beim Wiederkommen mit aktueller Rate nachgebucht
(Näherung dokumentiert).
