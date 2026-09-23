# Monte-Carlo-/Trade-Resampling (RMA-P6-02)

> **Version:** `v0.1.0 (Beta)` · **Status:** produktiv (CLI + Read-API) · **Finding:**
> [RMA-P6-02](audits/2026-09-20-roadmap-audit/findings/RMA-P6-02-monte-carlo.md)

Reproduzierbare Monte-Carlo-Analyse über die Trades eines Walk-Forward-Runs:
IID- und blockweises Resampling plus explizite Kostenstressszenarien, mit
robusten Quantilen (p05/p50/p95) für **End-Equity, Max Drawdown, Ruin, Sharpe
und Losing Streak** sowie Exceedance-Wahrscheinlichkeiten.

**Abgrenzung (bewusst):** Kein Ersatz für echtes OOS/Walk-Forward, kein
Preisprozess-/Optionsmodell und **keine Live-Risikofreigabe** — kein Ergebnis
dieser Analyse fließt in Risk-Ceilings, Kill-Switches, Authority Chains oder
Live-Gates. Quantile sind Schätzer, conditional auf Stichprobe, Methode und
Annahmen — keine Garantien.

## 1. Architektur & Produktionspfad

| Schicht | Datei | Rolle |
|---|---|---|
| Simulation (rein) | `src/backtest/montecarlo.ts` | PRNG-Resampling, Pfadmetriken, Quantile, Hashes — ohne IO testbar |
| Quelle + Persistenz | `src/backtest/monteCarloStore.ts` | Lädt verifiziertes Trade-Ledger, persistiert idempotent |
| CLI | `scripts/run-montecarlo.ts` (`npm run montecarlo`) | Einziger Schreibpfad; Artefakte unter `data/montecarlo/` |
| API (nur lesend) | `GET /api/firm/montecarlo`, `GET /api/firm/montecarlo/[id]` | bounded Liste/Detail inkl. Config-Export |
| DB | `backtest_monte_carlo_runs` (Migration `drizzle/2026-09-23_monte_carlo.sql`) | EINE Zeile je Analyse, append-only |

End-to-End: **Ledger-Zeilen (`backtest_trades`) → Eligibility-Gates → reine
Simulation → idempotente Summary-Zeile → Read-API/Artefakte.** Es gibt
bewusst keinen POST-Endpunkt — Analysen entstehen nur über die CLI
(dasselbe Muster wie `backtest_runs`).

## 2. Eingabe & Eligibility (fail-closed)

Quelle ist ein unveränderlicher Walk-Forward-Run mit **RECONCILED**
Trade-Ledger (`persistBacktestRun`, RMA-P1-04). Alt-Runs vor v1.52.0
(`reconciliationStatus`/`tradeCount` NULL) werden abgelehnt: NULL heißt
„kein Ledger“, nicht „0 Trades“.

Gates vor jedem Write:

| Gate | Fehlercode | Bedeutung |
|---|---|---|
| Run existiert | `mc:run-not-found` | unbekannte UUID |
| Ledger vorhanden | `mc:ledger-unavailable` | Alt-Run ohne RECONCILED-Ledger |
| Zeilenzahl/`seq` konsistent | `mc:ledger-inconsistent` | `trade_count` ≠ Zeilen oder `seq` nicht kontiguierlich (nur Segment `ALL`) |
| Segment nicht leer | `mc:empty-sample` | Filter ohne Treffer |
| Mindeststichprobe 30 Trades | `mc:insufficient-sample` | Bootstrap-Quantile wären Scheingenauigkeit |
| ein Symbol je Analyse | `mc:mixed-symbols` | keine Mischung inkompatibler Instrumente ohne Normalisierung |
| Zahlen endlich, `notional` > 0, `fees`/`slippage` ≥ 0, `exitTs ≥ entryTs` | `mc:invalid-trades` | invalide Zeilen |
| positive realisierte Quell-Equity | `mc:source-ruined` | relative Renditen nicht mehr definiert |
| Spanne > 0, Annualisierung in [1, 200 000] Trades/Jahr | `mc:span-not-derivable` | Ereigniszeiten unplausibel |

**Einheiten & Zeitsemantik:** `pnlNet`/`fees`/`slippage`/`notional` in
Kontowährung (Quote-Währung des Instruments); `pnlNet` ist netto (Brutto −
Gebühren + Funding, Kontosicht: Funding negativ = gezahlt). `entryTs`/`exitTs`
sind **Ereigniszeiten** aus dem Ledger; `created_at` der Analyse-Zeile ist die
**Berechnungszeit**. Die Simulation liest ausschließlich den append-only
Ledger — später geschriebene Daten sind strukturell unsichtbar, Look-ahead
ist ausgeschlossen. Die Ereigniszeiten dienen nur der
Annualisierungsskalierung des Sharpe (siehe §5).

## 3. Modell & Formeln

### 3.1 Renditebasis (Exposure-/Positionsbasis)

Trade *i* (kanonische `seq`-Reihenfolge) trägt die Equity-Rendite

```
r_i = pnlNet_i / E_{i-1}
```

mit realisierter Quell-Equity `E_0 = initialEquity`,
`E_k = E_0 + Σ_{j≤k} pnlNet_j` (Teleskop: `Π(1 + r_i)` reproduziert den
Quellpfad exakt). **Dokumentierte Näherung:** Die Backtest-Engine sizingt
live auf aktueller Equity inkl. unrealisiertem PnL offener Positionen; die
realisierte Basis ist die beste aus dem Ledger rekonstruierbare Approximation
— der Fehler ist bei begrenzter Gleichzeitigkeit (`maxOpenPositions`) klein,
aber nicht null. `initialEquity` ist Teil der Config (Default 10 000 =
Engine-Default) und des Idempotenz-Keys.

### 3.2 Resampling-Methoden

Horizont je Pfad = Stichprobengröße *n* (gleiche Trade-Anzahl wie die Quelle).

| Methode | Semantik | Validierung |
|---|---|---|
| `iid` | Uniform mit Zurücklegen; jede Ziehung ein Trade | `blockLength` verboten |
| `moving_block` | Überlappende Blöcke fester Länge *L*, Start uniform in `[0, n−L]`, Konkatenation auf *n* abgeschnitten | `2 ≤ L ≤ n` |
| `stationary_block` | Politis/Romano: Restart-Wahrscheinlichkeit `1/L`, sonst Fortsetzung (zirkulär) | `2 ≤ L ≤ n` |

Blocklängen ≤ 1 degenerieren zu IID und werden abgelehnt; Blocklängen > n
sind unzulässig. Block-Bootstrap erhält serielle Abhängigkeiten der
Trade-Sequenz (z. B. Regime-Cluster), IID vernichtet sie — die Wahl ist Teil
der Annahme und landet in `summary.caveats`.

### 3.3 Kostenstress (explizites Szenario, keine Magie)

```
pnl'_i = pnlNet_i − fees_i·(feeMultiplier − 1) − slippage_i·(slippageMultiplier − 1)
r'_i  = pnl'_i / E_{i-1}        (gleiche Quell-Exposurbasis)
```

Beide Multiplikatoren ∈ [1, 100], mindestens einer > 1 (No-Op-Stress wird
abgelehnt). Der Stress ist eine **First-Order-Approximation auf fester
Trade-Sequenz und fester Exposurbasis**: kein Re-Sizing, keine
Re-Signalisierung, keine anderen Stops — das kann nur ein echter
Stress-Backtest. Da `fees`, `slippage` ≥ 0 und Multiplikatoren ≥ 1, gilt
pfadweise `r'_i ≤ r_i` ⇒ End-Equity-Quantile und beobachtetes Nettoergebnis
verschlechtern sich **monoton** nicht-überschreitend, die
Ruin-Wahrscheinlichkeit wächst monoton (gleicher Seed ⇒ identische Ziehungen;
per Test gesichert).

### 3.4 Equity-Pfad, Ruin, Wipe

```
E'_k = E'_{k-1} · (1 + r_{σ(k)}),   E'_0 = initialEquity
```

- **Ruin:** `E'` fällt strikt unter `ruinThresholdPct` % des Startkapitals
  (Default 50 %, Bereich (0, 100]). Erstdurchbruch zählt.
- **Wipe:** `E' ≤ 0` ⇒ Equity wird auf 0 geklemmt und bleibt 0 (Margin-Call-
  Semantik); MaxDD des Pfads = 100 %, Ruin ist sicher (Schwelle > 0).
- **Losing Streak / Sharpe** werden über die VOLLSTÄNDIG gezogene Sequenz
  gemessen (auch nach Wipe — die gezogenen Trade-Ergebnisse bleiben definiert);
  MaxDD/Ruin/End-Equity laufen auf der Equity-Kurve.

### 3.5 Trennung der Ebenen im Ergebnis

`summary` trennt explizit:

1. **`observed`** — empirische Beobachtung: Original-Sequenz mit den
   TATSÄCHLICHEN Netto-Trades des Ledgers (immer ungestresst,
   seed-unabhängig).
2. **`observedStressed`** — nur bei Szenario `stress`: derselbe
   First-Order-Kostenstress auf der Original-Sequenz (kein Resampling) —
   Anker für den Vergleich.
3. **`resampled`** — Verteilungen unter der Resampling-Annahme UND dem
   Szenario (`stats.scenario`: `baseline` | `stress`, `stats.stress`: die
   Multiplikatoren).
4. **`caveats`** — konstante Hinweise (kein Freitext), u. a.
   `not-a-live-risk-release` und bei Stress
   `stress:first-order-cost-only-fixed-sequence-and-exposure`.

## 4. Quantile, Exceedance, Statistikhinweise

- **Quantile** sind Nearest-Rank (Typ 1, invertierte empirische CDF:
  `sorted[ceil(p·N) − 1]`, keine Interpolation) für p05/p50/p95 + arithmetisches
  Mittel. Damit sind sie ohne FP-Interpolationsfreiheitsgrade reproduzierbar.
- **Exceedance:** `ruinProbability` P(Pfad ruiniert),
  `endBelowStartProbability` P(End < Start) und
  `maxDrawdownGtePct` für die festen Schwellen 10/20/30/50 % MaxDD
  (bounded Menge, keine konfigurierbaren High-Cardinality-Schwellen).
- **Monte-Carlo-Standardfehler:** binomialer MCSE `√(p̂(1−p̂)/runs)` für die
  beiden Wahrscheinlichkeiten (bei deterministischem Ereignis 0).
- **Statistik-Hinweise** (`stats`): Stichprobengröße, Horizont, Runzahl,
  gezogene Blöcke (`blocksDrawn`), distinkte Strategien, Symbole (immer 1),
  Annualisierungsfaktor, Szenario, Seed, PRNG-/Algorithmusversion.

## 5. Sharpe & Annualisierung

Trade-Level-Sharpe über denselben Kernel wie Portfolio/Backtest
(`sharpeRatio`, `src/portfolio/metrics.ts`, rf = 0, ddof = 1), annualisiert
mit

```
tradesPerYear = n / (Spanne_ms / ms_per_Jahr),  ms_per_Jahr = 365·24 h (24/7-Krypto)
```

Spanne = `max(exitTs) − min(entryTs)` der Stichprobe. Außerhalb [1, 200 000]
Trades/Jahr wird **abgelehnt** (fail-closed, kein Klemmen — Kernel-Bound).
Konstante Renditen ⇒ Volatilität 0 ⇒ Sharpe 0 (Kernel-Konvention).

## 6. Determinismus & Idempotenz

- **PRNG:** Repository-Kernel `mulberry32` (`src/lib/marketdata/prng.ts`),
  Version `mulberry32-v1`, EIN sequenzieller Stream pro Simulation
  (Ziehungsreihenfolge: Pfad für Pfad, Trade für Trade). Same
  (Trades, Config, Seed) ⇒ **byte-identische Summary** (per Test gesichert).
- **Seed:** uint32 ∈ [0, 4294967295], Default 1 — wird mit jedem Lauf
  persistiert.
- **Algorithmusversion:** Konstante `mc1`; sie geht in den Idempotenz-Key
  ein — eine Änderung der Simulationsmathematik erzeugt neue Keys statt
  stiller Altdaten-Mischung.
- **Idempotenz-Key:** `mcs1:<sha256>` über Quell-Run, Segment, Methode, Seed,
  PRNG-Version, Runzahl, Blocklänge, Equity-Basis, Ruin-Schwelle, Stress und
  den SHA-256-**Eingabe-Hash** der kanonischen Stichprobe. Der Key ist im Code
  **nicht überschreibbar**. Retry/Restart (auch mit neuer UUID) liefert die
  bestehende Zeile (`created: false`), nie eine Dublette (UNIQUE-Index +
  expliziter Vorab-Lookup + Race-Handling).
- **Replay:** Aus `GET /api/firm/montecarlo/[id]` (`analysis.config`) oder dem
  Artefakt `data/montecarlo/<id>.json` lässt sich der Lauf exakt
  nachstellen — CLI mit derselben Config/Seed liefert byte-identische
  Quantile (per DB-Test gesichert).

## 7. Persistenz & API

### 7.1 Tabelle `backtest_monte_carlo_runs` (append-only)

EINE Zeile je Analyse: `source_run_id` (FK `backtest_runs`, ohne Cascade),
`idempotency_key` (UNIQUE), `method`, `segment`, `scenario`, `seed`,
`seed_algorithm`, `runs`, `block_length`, `sample_trades`,
`input_trades_hash`, `config_json` (vollständige resolved Config),
`summary_json` (bounded), `code_version`, `created_at`.
CHECK-Constraints spiegeln alle Code-Bounds (Enum-Werte, Seed-Bereich,
Run-Bereich, Blocklänge ≥ 2, Hash-Formate). Migration
`drizzle/2026-09-23_monte_carlo.sql` ist idempotent und append-only.

**Rohpfade werden NICHT persistiert** (bis zu `runs × n` Equity-Punkte) —
sie sind aus Seed + Config + Ledger deterministisch reproduzierbar. Die
Summary ist strukturell bounded (feste Felder, ~2 KB).

### 7.2 API (additiv, nur lesend, SEC-02-Muster)

- `GET /api/firm/montecarlo?run=<uuid>&limit=1..100` — Liste, jüngste zuerst,
  optional nach Quell-Run gefiltert. `firm.read`, `no-store`.
- `GET /api/firm/montecarlo/[id]` — Detail inkl. vollständiger Config
  (Replay-Export) und Summary. 400 ungültige UUID/Query, 404 unbekannt, 503
  DB nicht erreichbar.

Es gibt keinen POST — Schreibpfad ist ausschließlich die CLI.

## 8. CLI-Referenz

```bash
node --import tsx scripts/run-montecarlo.ts --run=<uuid> \
  [--method=iid|moving_block|stationary_block] [--seed=1] [--runs=1000] \
  [--block-length=8] [--segment=OOS] [--initial-equity=10000] \
  [--ruin-threshold-pct=50] [--stress-fee-mult=2] [--stress-slip-mult=3] \
  [--skip-db] [--json]
```

- `--segment` Default `OOS` (empfohlene Basis: nur Out-of-Sample-Trades);
  `IS`/`ALL` möglich.
- `--stress-fee-mult`/`--stress-slip-mult`: sobald einer gesetzt ist, läuft
  das Szenario `stress`; der andere Defaults auf 1; mindestens einer muss > 1
  sein.
- `--skip-db`: keine Analysenzeile schreiben (die Quelle wird trotzdem aus
  der DB gelesen); Artefakte werden immer geschrieben.
- `--json`: maschinenlesbares Vollresultat auf stdout (inkl. Config).
- Artefakte: `data/montecarlo/<analysisId>.json` + `.md`
  (gitignore, reproduzierbar).

Beispiel:

```bash
npm run montecarlo -- --run=$RUN_ID --method=stationary_block --block-length=8 \
  --seed=42 --runs=2000 --stress-fee-mult=2
```

## 9. Observability & Sicherheit

- **Metriken (bounded):** `monte_carlo_runs_total` (Labels `result` =
  created|replayed|failed, `reason` = Fehlercode via `metricLabel`, `method`
  aus geschlossener Menge) und `monte_carlo_queries_total` (`result`, `route`).
  Keine Run-/Instrument-/Trade-IDs als Labels.
- **Audit:** `MONTE_CARLO_RUN_PERSISTED` (INFO, mit Quelle, Seed, Methode,
  Szenario, Stichprobengröße, Key) und `MONTE_CARLO_RUN_PERSIST_FAILED`
  (WARN, mit klassifiziertem Code) — Klasse `telemetry`.
- **Secrets/PII:** Die Analyse speichert ausschließlich Zahlen der eigenen
  Backtest-Trades plus Config — keine Broker-Payloads, Secrets oder PII.
- **Risikogrenzen:** Es werden keine bestehenden Ceilings/Kill-Switches
  geändert; die Analyse ist bewusst NICHT mit dem Risikosystem verdrahtet.

## 10. Migration, Rollout & Rollback

- **Migration:** `drizzle/2026-09-23_monte_carlo.sql` — neue Tabelle, keine
  bestehende Tabelle geändert, idempotent (`IF NOT EXISTS` + DO-Blocks für
  Constraints). Ausführen wie üblich:
  `psql "$DATABASE_URL" -f drizzle/2026-09-23_monte_carlo.sql` oder
  `npx drizzle-kit push` (Schema-Spiegel `src/db/schema.ts`).
- **Rollout:** rein additiv; kein Feature-Flag nötig (opt-in über CLI-Aufruf,
  kein Live-/Paper-Pfad berührt). Read-API greift erst nach Migration; vorher
  antwortet sie 503 (`MONTE_CARLO_UNAVAILABLE`).
- **Rollback (nur wenn kein v1.72.0-Code mehr läuft):**
  `DROP TABLE IF EXISTS backtest_monte_carlo_runs;` stellt den v1.71.x-Stand
  vollständig her. Quell-Runs und Trades bleiben unberührt (FK ohne Cascade:
  ein Quell-Run mit Analysen ist nicht still löschbar — erst Analysen, dann
  Run).

## 11. Grenzen (bewusst dokumentiert)

- Resampling-Verteilungen sind **conditional** auf die beobachtete
  Stichprobe: sie können Regime enthalten, die sich nicht wiederholen (und
  umgekehrt). Keine Aussage über Tail-Risiken jenseits der Stichprobe.
- Das Kostenstress-Modell ist first-order (feste Sequenz/Exposure) — kein
  vollständiger Stress-Backtest.
- IID vernichtet serielle Abhängigkeit; Block-Bootstrap erhält sie nur
  innerhalb der Blocklänge. Die Blocklänge ist eine Annahme (validiert, aber
  nicht „richtig“).
- Kein Ersatz für Walk-Forward/OOS, kein Preisprozessmodell, keine
  Live-Risikofreigabe.

## 12. Tests

- `tests/backtest.montecarlo.test.ts` (25): Determinismus/Seed-Semantik,
  analytische Fixtures (Ruin/MaxDD/Streak/End-Equity exakt), Block-Erhalt
  (b=n ⇒ Identität; b=2 ⇒ Paarprodukte), Eligibility/Bounds, monotone
  Kostenverschärfung, Input-Immutabilität, Negative Paths, Hash-/Key-Stabilität.
- `tests/backtest.montecarlo.db.test.ts` (9, eingebettete Postgres): Migration
  zweifach idempotent, Roundtrip über den echten Persistenzpfad, Idempotenz
  bei Retry/Restart, fail-closed Quell-Pfade, CHECK-Constraints + FK ohne
  Cascade, Read-API, Replay-Vertrag (persistierte Config ⇒ byte-identische
  Summary), HTTP-Vertrag (401/400/404/200).

Verwandte Dokumente: [BACKTESTING.md](BACKTESTING.md) (Walk-Forward-Engine,
Trade-Ledger), [PORTFOLIO_ANALYTICS.md](PORTFOLIO_ANALYTICS.md) (Metrik-Kernel),
[CHANGELOG.md](../CHANGELOG.md).
