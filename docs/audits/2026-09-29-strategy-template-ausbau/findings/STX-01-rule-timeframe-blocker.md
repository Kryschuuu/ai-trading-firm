# STX-01 — `RuleWindow.timeframe` blockiert 2h/4h/1d/5d

- **ID:** STX-01
- **Severity:** HIGH
- **Bereich:** Handelslogik / Rule-Engine
- **Quelle:** Ausbaudokument §1.9, §4.2 (nicht erwähnt)
- **Status:** FIXED — 01-01, [`v0.6.2`](../../../../CHANGELOG.md) (Audit `v1.1.2`)
- **Datei(en):** `src/lib/ruleEngine.ts`, `src/lib/marketdata/historicalStore.ts` (seit `v0.6.2`: `src/lib/marketdata/timeframes.ts`), `src/lib/microExecutor.ts`

## Beschreibung

Das Ausbaudokument schlägt eine Candidate Matrix über „500 Instrumente × 5 Strategien ×
3 Timeframes", `rebalance.timeframe: "1d"` für Cross-Sectional-Rebalance und einen
Multi-Timeframe-Vergleich vor. **Keiner dieser Vorschläge ist mit der heutigen `RuleSpec`
ausdrückbar.**

`RuleWindow.timeframe` ist eine geschlossene Union aus fünf Intraday-Werten. Der
Historical Store unterstützt zehn Werte einschließlich `2h`, `4h`, `1d`, `5d`.

> **Korrektur ([ADR-010](../../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3), `v0.6.1`):** Der Cross-Sectional-Rebalance hängt **nicht** an
> `RuleWindow.timeframe` — `CrossSectionalConfig.timeframe` akzeptiert bereits alle zehn
> `SUPPORTED_TIMEFRAMES` (Default `1h`). Blockiert sind Einzel-Symbol-Regeln und die Candidate Matrix
> (`4h`/`1d`), nicht die Universe-Strategie.

## Beweis (Stand `v0.6.1`, vor 01-01)

```ts
// src/lib/ruleEngine.ts:87
timeframe: "1m" | "5m" | "15m" | "30m" | "1h";
// src/lib/ruleEngine.ts:205
const ALLOWED_TIMEFRAMES = new Set<RuleWindow["timeframe"]>(["1m","5m","15m","30m","1h"]);
// src/lib/ruleEngine.ts:883 (JSON-Schema)
timeframe: { type: "string", enum: ["1m","5m","15m","30m","1h"] },
```

```ts
// src/lib/marketdata/historicalStore.ts:45-56
export const SUPPORTED_TIMEFRAMES = ["1m","3m","5m","15m","30m","1h","2h","4h","1d","5d"] as const;
```

`ALLOWED_TIMEFRAMES` ist bewusst eine **eigere** Menge, nicht aus `SUPPORTED_TIMEFRAMES`
abgeleitet — das ist ein Design-Hinweis, kein Versehen: der Rule-Pfad war als Intraday-only
gedacht.

## Remediation

1. `RULE_ALLOWED_TIMEFRAMES` **aus** `SUPPORTED_TIMEFRAMES` ableiten (kein zweites Vokabular). — ✅ `v0.6.2`
2. `RuleWindow["timeframe"]` auf `SupportedTimeframe` umstellen. — ✅ `v0.6.2`
3. `buildSnapshotFromCandles` ist timeframe-agnostisch; `sessionVwap` **nicht** — der
   UTC-Tagesanker ergibt auf `1d` einen VWAP über exakt eine Kerze. Für `1d`+ muss
   `vwapPct` `null` liefern (fail-closed), nicht 0. — ✅ belegt, **kein Code-Fix nötig** (siehe Korrektur unten)
4. Micro-Executor-Takt: `src/lib/microExecutor.ts` läuft auf einem Intraday-Intervall.
   Ein `4h`-/`1d`-Feld **darf nicht** im Intraday-Loop ausgewertet werden. — ✅ `v0.6.2` (Timeframe-Guard)

## Akzeptanzkriterien

- [x] Bestehende Regeln mit `1m…1h` verhalten sich **byte-identisch** — Golden-Test (`tests/ruleEngine.test.ts`) gegen die Sanitize-Ausgabe von `v0.6.1`; zusätzlich ein Differenzlauf Original ↔ geänderter Baum über Sanitize, Signatur, Snapshots und `backtestRule` (28 397 Byte, identisch)
- [x] `sanitizeRuleSpec` bleibt fail-closed außerhalb der Allowlist (nie ein Rohwert; Semantik siehe Korrektur)
- [x] `vwapPct === null` für `timeframe >= "1h"` wenn < 2 Kerzen am UTC-Tag — `1d`/`5d` immer, `1h`/`2h`/`4h` bis zur zweiten Kerze des Tages
- [x] Test: kein Micro-Executor-Schedule < Timeframe-Dauer (`tests/microExecutor.test.ts`: jede Rolling-Serie aggregiert exakt auf `SUPPORTED_TIMEFRAME_MS`; 10×10-Matrix des Guards)

## Umsetzung (`v0.6.2`, Prompt 01-01)

- **Ein Vokabular:** `src/lib/marketdata/timeframes.ts` (reine Daten, client-sicher) ist die Heimat von
  `SUPPORTED_TIMEFRAMES`/`SUPPORTED_TIMEFRAME_MS`/`isSupportedTimeframe`; der Historical Store
  re-exportiert sie. `RULE_ALLOWED_TIMEFRAMES`, das LLM-Schema und die Workshop-Auswahl lesen dieselbe
  Liste; der Mikro-Executor nutzt dieselbe Periodentabelle (vorher eine zweite, unvollständige).
- **Guard:** `MicroExecutorOptions.executionInterval` (Default `1h`); Regeln mit längerem oder
  unbekanntem Timeframe bekommen keine Serie und lösen nie aus — Counter
  `micro_executor_rule_blocked_total`, Log `micro_executor_rule_blocked`, `status().ruleGuard`.
- **Unverändert (Sperren des Prompts):** `RULE_FIELDS`, `RuleAction`, `RULE_CEILINGS`,
  `RULE_ALLOWED_SIDE` (Shorts bleiben global gesperrt), `sanitizeRuleSpec`-Semantik.
  `RULE_CEILINGS.volumeWindow` (5…200) bleibt: Das Fenster zählt Kerzen — auf `1d` sind das eine Woche
  bis 200 Tage. Tabelle: [`BACKTESTING.md` §1.1](../../../BACKTESTING.md#11-rule-timeframe--unterstützte-felder-stx-01-v062).

### Korrekturen am Befund

- **`vwapPct` auf `1d`:** Der Befund nahm an, der UTC-Tagesanker liefere dort einen VWAP über eine
  Einzelkerze. Tatsächlich liefert `sessionVwap` bei < 2 Kerzen am UTC-Tag bereits `null` (nie `0`) —
  `vwapPct` ist auf `1d`/`5d` seit jeher `null`, im Snapshot-Builder wie im Indikator-Cache der Engine.
  Gefehlt hatte der Nachweis, nicht der Code.
- **„`sanitizeRuleSpec` verwirft unbekannte Timeframes“:** Real fällt ein Wert außerhalb der Allowlist auf
  den sicheren Default `15m` (Test „Unbekanntes fällt auf 15m“), und die Schreibweise wird vorher
  kleingeschrieben (`"1H"` → `"1h"`). Der Prompt nennt `"1H"` als verworfen; die Semantik ist dort als
  gesperrt markiert und blieb unverändert.

### Beim Beheben gefunden

- **Stiller 15m-Fallback im Mikro-Executor** (`TIMEFRAME_MS[tf] ?? TIMEFRAME_MS["15m"]`): hätte
  `3m`/`2h`/`4h`/`1d`/`5d`-Regeln still auf 15-Minuten-Kerzen ausgewertet — derselbe Fehler wie einst bei
  `1m`. Behoben (kanonische Tabelle, laute Ablehnung unbekannter Werte).
- **Workshop-Auswahl „Fenster“** und der Cast in `scripts/bench-backtest.ts` waren weitere
  handgepflegte Stände des alten Vokabulars; beide folgen jetzt der Allowlist.

### Bleibt offen (bewusst nicht in 01-01)

- Das Kosten-Fallback des Paper-Backtests ist für `3m`, `2h`, `5d` nicht kalibriert (`3m` optimistisch).
- **[OP-1](../remediation/TRACKING.md#offene-punkte-für-den-reviewer):** Der Default des Live-Executors ist
  Intraday-only (`1h`); `4h`+ gilt für Backtest/Screening. Eine Anhebung von `executionInterval` ist eine
  Policy-Entscheidung, keine reine Konfiguration — der Loop bewertet die laufende Kerze.

## Versions-Hinweis

Minor (neue Felder im Vokabular). Die `RuleAction`-/`RULE_CEILINGS`-Semantik bleibt unberührt.
