# STX-01 — `RuleWindow.timeframe` blockiert 2h/4h/1d/5d

- **ID:** STX-01
- **Severity:** HIGH
- **Bereich:** Handelslogik / Rule-Engine
- **Quelle:** Ausbaudokument §1.9, §4.2 (nicht erwähnt)
- **Status:** OPEN
- **Datei(en):** `src/lib/ruleEngine.ts`, `src/lib/marketdata/historicalStore.ts`

## Beschreibung

Das Ausbaudokument schlägt eine Candidate Matrix über „500 Instrumente × 5 Strategien ×
3 Timeframes", `rebalance.timeframe: "1d"` für Cross-Sectional-Rebalance und einen
Multi-Timeframe-Vergleich vor. **Keiner dieser Vorschläge ist mit der heutigen `RuleSpec`
ausdrückbar.**

`RuleWindow.timeframe` ist eine geschlossene Union aus fünf Intraday-Werten. Der
Historical Store unterstützt zehn Werte einschließlich `2h`, `4h`, `1d`, `5d`.

## Beweis

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

1. `RULE_ALLOWED_TIMEFRAMES` **aus** `SUPPORTED_TIMEFRAMES` ableiten (kein zweites Vokabular).
2. `RuleWindow["timeframe"]` auf `SupportedTimeframe` umstellen.
3. `buildSnapshotFromCandles` ist timeframe-agnostisch; `sessionVwap` **nicht** — der
   UTC-Tagesanker ergibt auf `1d` einen VWAP über exakt eine Kerze. Für `1d`+ muss
   `vwapPct` `null` liefern (fail-closed), nicht 0.
4. Micro-Executor-Takt: `src/lib/microExecutor.ts` läuft auf einem Intraday-Intervall.
   Ein `4h`-/`1d`-Feld **darf nicht** im Intraday-Loop ausgewertet werden.

## Akzeptanzkriterien

- [ ] Bestehende Regeln mit `1m…1h` verhalten sich **byte-identisch**
- [ ] `sanitizeRuleSpec` verwirft weiterhin unbekannte Timeframes
- [ ] `vwapPct === null` für `timeframe >= "1h"` wenn < 2 Kerzen am UTC-Tag
- [ ] Test: kein Micro-Executor-Schedule < Timeframe-Dauer

## Versions-Hinweis

Minor (neue Felder im Vokabular). Die `RuleAction`-/`RULE_CEILINGS`-Semantik bleibt unberührt.
