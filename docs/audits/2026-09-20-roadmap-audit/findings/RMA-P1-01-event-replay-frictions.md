# RMA-P1-01: Event-Replay mit realistischen Friktionen

- **Antwort:** Ja (seit v1.58.0)
- **Tracking-Status:** `FIXED`
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **0 PT** (Audit-Schätzung war 5–8 PT)
- **Umsetzungs-Prompt:** [`PROMPT-P1-01`](../prompts/PROMPT-P1-01-event-replay-frictions.md)

## Verifizierte Fundstellen

- `src/backtest/replayEvents.ts` — kanonischer Eventvertrag: diskriminierte Input-Union `MARKET_BAR | MARKET_QUOTE | MARKET_DEPTH | FUNDING_DUE` (getrennte `eventTime`/`availableAt`), Order-Lifecycle-Output-Union, stabile Sortierung `sortReplayEvents` (eventTime → Typ-Priorität → Symbol → Einfüge-Reihenfolge), fail-closed Validierung (`validateReplayInputEvent`, `EventReplayError`), Friktionskonfiguration + Modellversion `er1`, geschlossenes Degraded-Vokabular, Manifest-/Coverage-/Evidenz-Typen.
- `src/backtest/replayExecution.ts::createEventReplayRuntime()` — deterministische Order-Lifecycle-Engine: Latenzmodell (`decisionTime → submitTime → arrivalTime → fillTime(s)`), Fills aus historischer Depth mit Staleness-Deckel, konservativer Bar-Volumen-Fallback, ohne Liquiditätsdaten KEIN Fill, size-abhängiger Impact, Gebühren/Slippage nur auf gefüllte Mengen, Partial-Fill-Restmengen mit TTL-Cancel, punktgenaues `FUNDING_DUE`-Settlement nur für offene Perp-Positionen (`computeFunding`, dieselbe Formel/Vorzeichenkonvention wie Paper).
- `src/backtest/replayFunding.ts::perpFundingRowsToReplayEvents()` — Übersetzung kanonischer `perp_funding_rates`-Zeilen (as-of `available_at`) in `FUNDING_DUE`-Ereignisse; ungeeignete Zeilen werden gezählt, nie still verworfen.
- `src/backtest/portfolio.ts::increasePosition()/applyPartialExit()/finalizeReplayPosition()` — Exit-Restmengen halten die Position offen (Kern-Delta des Audits), Fillmenge nie > offene Restmenge, Exit-Preis = Fill-VWAP.
- `src/backtest/engine.ts` + `src/backtest/types.ts` — `executionModel: "event_replay"` als drittes, explizites Opt-in (`legacy` bleibt Default, `paper` byte-identisch); `result.replay` mit Datenmanifest (sha256), aufgelöster Konfiguration inkl. Seed, Event-Coverage, degradierten Annahmen und gedeckeltem Eventlog.
- `src/backtest/walkforward.ts` / `runStore.ts` / `tradeLedger.ts` — `report.replayEvidence` + `costProfile.frictionModelVersion` (geht via `costProfile` in `backtestRunIdempotencyKey` ein), Persistenz additiv in `params_json.replayEvidence` und `provenance_json.replay` je Trade (Fill-/Funding-/Impact-Detail, max. 64 Fills, `truncated`-Flag); keine Migration nötig, Alt-Runs unverändert.
- `scripts/run-backtest.ts` — `--execution-model=event_replay`, `--replay-latency-ms`, `--replay-seed`; `FUNDING_DUE` aus der Perp-Historie; Replay-Evidenz in Konsole + MD-Artefakt.
- `src/lib/telemetry.ts` — bounded Metriken `backtest_replay_runs_total{result,degraded}` und `backtest_replay_degraded_total{reason}` (geschlossene Label-Vokabulare).

## Bewertung und Abgrenzung

Das im Audit benannte Delta ist vollständig geschlossen: punktgenaue historische Funding-Ereignisse je Instrument/Intervall, Latenz als explizite Order-Zeiten statt statischer Kostenannahme, vollständiger Partial-Fill-Lifecycle mit Exit-Restmenge/Open-Order-Zustand/Cancel, Depth-basierter size-abhängiger Impact mit dokumentiertem deterministischem Fallback und persistierte Friktionsdaten + Modellversion je Fill. Out-of-scope bleibt bewusst: Live-Order-Scheduler (P4.2/P4.3), synthetische Erfindung fehlender Orderbücher (fehlende Depth ⇒ konservativer Fallback oder kein Fill, sichtbar degradiert), Umbau der Portfolio-Strategielogik. Der Paper-`FillSimulator` bleibt ein getrennter, unveränderter Pfad.

## Konkretes Delta — umgesetzt

- punktgenaue historische Funding-Rates pro Instrument und Funding-Intervall — `FUNDING_DUE`-Events, gebucht nur für zum Settlement offene Perp-Positionen, nie vor Entry/nach Exit, nie als stiller statischer Ersatzsatz
- Latenz als explizite Order-/Marktdatenereignisse statt nur statischer Kostenannahme — vier getrennte Zeiten je Order, Fills frühestens ab `arrivalTime`, `availableAt`-Sichtbarkeitsschranke ohne Look-ahead
- vollständiger Partial-Fill-Lifecycle mit Exit-Restmenge, Open-Order-Zustand und Cancel im Replay — `ORDER_SUBMITTED/ACK/PARTIAL_FILL/FILL/CANCEL`, TTL-Verfall, Entry-Rest-Cancel bei Exit-Beginn
- Orderbuchtiefe beziehungsweise Size-abhängiger Impact mit deterministischem Fallback — Depth-Menge (Staleness-Deckel) → Bar-Volumen-Partizipation → kein Fill; `impactBps = impactBpsPerParticipation × Partizipation`
- Persistenz der verwendeten Friktionsdaten und Modellversion je Fill — `provenance_json.replay` (Fills mit Zeitpunkten, Liquiditätsquelle, Impact, Fees), `params_json.replayEvidence`, `frictionModelVersion` im Idempotency-Key

## Akzeptanzkriterien für `FIXED`

- [x] identischer Seed und identische Eingangsdaten erzeugen byte-stabile Trades/Metriken — Determinismus-Tests (Engine-Doppellauf mit identischem `stableStringify`-Hash über Events/Trades/Metriken; Walk-Forward-Doppellauf byte-identisch) in `tests/backtest.replay.test.ts`.
- [x] Funding wird nur an tatsächlich erreichten Funding-Zeitpunkten gebucht — Tests: kein Funding vor Entry/nach Exit, `availableAt` in der Zukunft wird nicht vorgezogen, Spot wird nie belastet; Skips sichtbar in `coverage.fundingSkipped`.
- [x] fehlende Depth-/Funding-Daten werden sichtbar markiert und nicht still als Null interpretiert — geschlossenes `ReplayDegradedReason`-Vokabular in `result.replay.degradedReasons` + Metriken; ohne Liquiditätsdaten kein Fill (`NO_LIQUIDITY_DATA_NO_FILL`), fehlendes Funding = fehlend.
- [x] Partial-Fill-, Latenz- und Gebührenpfade sind durch Golden Tests belegt — Golden Replay (Bar + Latenz + 2 Partial Fills + Fee + Funding ⇒ unabhängig nachgerechnete exakte Cash-/PnL-Werte: PnL 11.0915, Endkasse 10011.0915) inkl. vollständiger Lifecycle-Sequenz und Fill-Zeitpunkten.

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`; Umsetzung auf `84a7328` (v1.57.0) — `df3163e` ist im Repository nicht auflösbar (bereits in PR #151 dokumentierte Basis-Abweichung).
- Testevidenz: 28 neue Tests (`tests/backtest.replay.test.ts`: Golden Replay, Determinismus, Depth-Fallbacks fehlend/stale/ohne Volumen, Mengen-Guards, Funding-Fenster inkl. Look-ahead + Spot, Negative Paths + kanonische Sortierung, Perp-Historie-Konvertierung, Walk-Forward-Persistenz inkl. Ledger-Reconciliation + Idempotency-Key-Abgrenzung, Performance-Deckel 2 Jahre Stundenkerzen < 10 s); Legacy-/Paper-Regressionen unverändert grün; `npm run typecheck`, `npm run lint` (0 Errors), `npm test` (2851 pass / 0 fail), `npm run docs:validate` grün.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
