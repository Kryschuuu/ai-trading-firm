# Screening-Pilot — STX-05-04 (v0.9.0)

> **Status:** verbindlich · **Stand:** 2026-10-02 · **Code-Version:** v0.9.0 (Beta)
> **Modul:** STX-05-04 (Runner + CLI) · **Pflicht** nach dem Merge von 05-04
> **Quelle des Auftrags:** [`prompts/PROMPT-STX-05-04-screening-cli.md`](../prompts/PROMPT-STX-05-04-screening-cli.md)

## Warum dieser Pilot existiert

Der Prompt 05-04 liefert die Maschine. Ob sie sich **lohnt**, entscheidet eine
Messung, nicht eine Schätzung: der Pilot fährt 50 Zellen durch die
`multiAsset`-Engine und stoppt die Uhr. Übersteigt der Lauf **eine Kernstunde**,
ist 05-04 abzulehnen und **STX-12** (`backtestRule()` O(n²)) bekommt Vorrang vor
jedem weiteren Screening-Ausbau.

Die Messlatte stammt aus der Baseline
[`BENCH-BASELINE.md`](BENCH-BASELINE.md) §6: `runMultiAssetBacktest()` misst
213,5 ms/Zelle bei 17 520 1h-Kerzen (Exponent 1,01), `backtestRule()` 26,0 s/Zelle
(Exponent 1,99). 50 Zellen × 213,5 ms ≈ **10,7 s**. Eine Kernstunde wäre das
**336-fache** — der Pilot trennt also „Pfad stimmt" von „Pfad ist falsch
verkabelt" (z. B. durch den seriellen Fallback oder eine ungecachte Store-Lese).

## Voraussetzungen

| Voraussetzung | Prüfung |
|---|---|
| PostgreSQL erreichbar | `psql "$DATABASE_URL" -c 'select 1'` |
| Screening-Schema vorhanden | `psql "$DATABASE_URL" -c '\d strategy_screening_runs'` (Migration aus 05-03: `drizzle/2026-10-01_strategy_screening.sql`) |
| Strategiekatalog-Schema vorhanden | `psql "$DATABASE_URL" -c '\d strategy_versions'` (04-01) |
| Universe-Registry gefüllt | `wc -l data/universe/instruments.ndjson` |
| Kerzen im Historical Store | `wc -l data/history/candles.ndjson` (Screening liest **ausschließlich** hier, kein Netz) |
| Spread-/Orderbuch-Daten | der Scan-Gate `max-spread` braucht `data/spread-cache.json` — sonst ist jede Zelle `BLOCKED` |

Der Pilot läuft **nur lokal und netzfrei**. Kein Live-Broker, keine Freigabe.

## Ablauf

### 1. Dry-Run (Default, keine DB)

```bash
npm run screening -- --limit-cells=50
```

Baut die Matrix, zeigt Tabelle und Zusammenfassung, schreibt **nichts**. Dient
der Sichtprüfung: Wie viele Zellen sind offen, wie viele blockt der Scan, wie
viele blockt die Warmup-Grenze (`RULE_BACKTEST_MIN_BARS` = 100)?

### 2. Echter Pilotlauf (50 Zellen)

```bash
date -u +%s > /tmp/screening-pilot.start
npm run screening -- --limit-cells=50 --execute
date -u +%s > /tmp/screening-pilot.end
echo "Wall-Clock: $(( $(cat /tmp/screening-pilot.end) - $(cat /tmp/screening-pilot.start) )) s"
```

Was der Lauf tut (in dieser Reihenfolge):

1. Instrumente aus der Registry laden (harte Grenze `--max-instruments=500`).
2. `scanUniverse()` netzfrei über den Historical Store — Bewertung **und**
   Scan-Gate.
3. `buildCandidateMatrix()` mit den gemappten Metriken (Tabelle in
   [`docs/STRATEGY_SCREENING.md`](../../../STRATEGY_SCREENING.md) § Runner).
4. `--limit-cells=50` schneidet die **ersten 50** der stabil sortierten Matrix
   ab — sichtbare Kürzung, eigene Run-Identität im `ssr1:`-Hash.
5. `createOrGetRun()` (idempotent auf `(candidateSetHash, codeVersion)`), dann
   je Zelle `upsertCells()` → Engine → `metrics`.
6. Fortschritt alle 25 Zellen (`SCREENING_PROGRESS_EVERY`) als `RUNNING`
   persistiert; Ende als `DONE`.

### 3. Kerne der Zeitmessung

Der Prozess ist ein einziger Node-Prozess mit I/O-Nebenläufigkeit 4 und
**serieller** Engine. Für einen 4-Kern-Rechner:

```
Kernzeit ≈ Wall-Clock × 1   (Engine seriell, I/O wartet)
```

Der Pilot akzeptiert jede Maschine; verglichen wird der **Durchsatz**
(`Zellen/s`, die CLI gibt ihn aus), nicht die Wall-Clock.

## Auswertung — was gemessen wird

| Zahl | Quelle | Bedeutung |
|---|---|---|
| `Zellen/s` | CLI-Ausgabe | Der eigentliche Pfad-Test |
| `capped` | Zusammenfassung der CLI | Zellen, die an `min_bars`/`trade_cap`/`equity_cap` scheiterten |
| `BLOCKED-Gruende` | Zusammenfassung der CLI | Welches Gate wie viele Zellen abweist |
| `blockedByReason` | `ScreeningRunResult` | identisch, maschinenlesbar |
| `caps.byCap` | `ScreeningRunResult` | je Cap-Token (`min_bars`/`trade_cap`/`equity_cap`) |
| `cells_done`/`cells_total` | `strategy_screening_runs` | Fortschritt, muss identisch sein |

### Entscheidung

| Beobachtung | Konsequenz |
|---|---|
| ≤ 1 Kernstunde für 50 Zellen | 05-04 annehmen; nächster Schritt: Ausbau der Matrix-Breite, `backtest_run_id` bleibt die dokumentierte offene Naht |
| > 1 Kernstunde für 50 Zellen | **05-04 ablehnen.** Ursache suchen (ungewollter serieller Fallback? Store wird je Zelle komplett gelesen? Engine-Pfad nicht `multiAsset`?), STX-12 wird Patch-Task und bekommt Vorrang |

### Meldepflicht des Equity-Caps

`RULE_BACKTEST_EQUITY_CAP` = 120. Die Equity-Kurve wächst mit den verarbeiteten
Kerzen, deshalb wird der Cap auf **echten** Zellen mit mehr als ~120 gültigen
Kerzen fast immer greifen. Der Pilot muss berichten, **wie viele** Zellen daran
hängen — nicht als Fehler, sondern als Entscheidungsvorlage: ob die
Vergleichbarkeitshülle geweitet wird oder die Metrik auf ein Downsampling
(`downsampleSeries()` aus `src/lib/ruleBacktest.ts`) umgestellt wird. Ein
gekapptes Ergebnis darf dabei **nie** entstehen; die Zelle bleibt `BLOCKED`
mit Grund `caps exceeded`.

## Fortsetzung nach Abbruch

```bash
# Lauf abgebrochen (SIGINT, Store-Fehler, Deckel) — der Stand steht:
npm run screening -- --run-id=<uuid> --limit-cells=50 --execute
```

Der Runner erkennt denselben Inhalt am `ssr1:`-Hash, überspringt den erledigten
Prefix und fährt dort fort. Ein **anderer** Inhalt (anderer Cutoff, andere
Limits) ist ein neuer Lauf — nie ein Overwrite. `--limit-cells` muss gleich
bleiben, sonst ist es ein anderer Inhalt.

## Kein zweiter Wahrheitsort

Der Pilot verändert **nichts**: kein `backtestRule()`, kein `runMultiAssetBacktest()`,
keine Engine-Datei, keine Migration. Gemessen wird, was 05-04 zusammenschaltet.
Ergebnisse und Laufzeiten gehören in den Audit-Tracker
[`TRACKING.md`](TRACKING.md) (Phase 5, 05-04).
