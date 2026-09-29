# STX-01-01 — Rule-Timeframes an `SUPPORTED_TIMEFRAMES` angleichen

- **Phase:** 1 · **Paket:** 00-03 · **Finding:** STX-01 (Härtester Blocker der Roadmap)
- **Risiko:** mittel (betrifft das Sicherheitsmodell der Rule-Engine)

## Zweck

`RuleWindow.timeframe` ist heute auf `1m|5m|15m|30m|1h` beschränkt, der Historical Store
unterstützt `1m…5d`. Damit sind **alle** Screening-Ziele (Multi-Timeframe) und jede
regelbasierte Strategie jenseits von 1 h **technisch nicht ausdrückbar**. Dieser Prompt hebt den
Blocker. *(Der Tages-Rebalance des Cross-Sectional-Moduls ist davon nicht betroffen:
`CrossSectionalConfig.timeframe` akzeptiert bereits alle `SUPPORTED_TIMEFRAMES` — [ADR-010](../../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3).)*

## Kontext

```ts
// src/lib/ruleEngine.ts:87
timeframe: "1m" | "5m" | "15m" | "30m" | "1h";
// :205
const ALLOWED_TIMEFRAMES = new Set<RuleWindow["timeframe"]>(["1m","5m","15m","30m","1h"]);
// :883 (JSON-Schema für LLM-Vorschläge)
timeframe: { type: "string", enum: ["1m","5m","15m","30m","1h"] },
```

```ts
// src/lib/marketdata/historicalStore.ts:45
export const SUPPORTED_TIMEFRAMES = ["1m","3m","5m","15m","30m","1h","2h","4h","1d","5d"] as const;
```

## Auftrag

1. **Single Source of Truth herstellen.** `RULE_ALLOWED_TIMEFRAMES` wird aus
   `SUPPORTED_TIMEFRAMES` **abgeleitet** — kein zweites Vokabular:

   ```ts
   export const RULE_ALLOWED_TIMEFRAMES: readonly SupportedTimeframe[] = SUPPORTED_TIMEFRAMES;
   ```

   `RuleWindow["timeframe"]` wird `SupportedTimeframe`. `ALLOWED_TIMEFRAMES` entfällt
   zugunsten der abgeleiteten Menge.
   *Begründung:* Zwei Vokabulare sind genau der Fehler, den 00-03 (ADR-008 bis ADR-010) bei den
   Strategie- und Regimeklassen verhindert — er darf nicht neu entstehen.

2. **Fail-closed für `vwapPct` auf hohen Timeframes.** `sessionVwap` verankert am
   UTC-Kalendertag (`indicators.ts:151 utcDayAnchorMs`). Auf `1d` ist das **eine** Kerze
   ⇒ der Wert ist bedeutungslos. `buildSnapshotFromCandles` muss `vwapPct` dann `null`
   liefern — **nicht** 0. Ein Template, das `vwapPct` nutzt, ist damit automatisch auf
   Intraday beschränkt; das ist korrekt und gewollt.
   Gleiches gilt sinngemäß für `volumeRatio` mit sehr kleinen `volumeWindow`-Werten —
   prüfe, ob `RULE_CEILINGS.volumeWindow` auf einem Tag noch sinnvoll ist, und **lasse es
   unverändert**, wenn ja.

3. **Micro-Executor-Takt absichern.** `src/lib/microExecutor.ts` läuft auf einem
   Intraday-Intervall. Er darf ein Feld **nicht** auswerten, dessen Kerze noch nicht
   geschlossen ist. Ergänze einen **fail-closed Guard**: Ist
   `spec.window.timeframe` länger als das Ausführungsintervall, dann
   * keine Position aus dieser Regel eröffnen (kein „ teilweise abgelaufener Snapshot"),
   * Telemetrie-Counter + strukturiertes Audit-Log.
   Beachte: Das ist **kein** stilles Abschalten — es ist ein sichtbares, begründetes Nein.

4. **JSON-Schema angleichen** (`ruleEngine.ts:883`) — enum aus der abgeleiteten Menge,
   nicht handgepflegt. Sonst driften Schema und Sanitize auseinander.

5. **Tests** in `tests/ruleEngine.test.ts`:
   - `sanitizeRuleSpec` akzeptiert `4h` und `1d`
   - `sanitizeRuleSpec` verwirft weiterhin `"2h "`, `"1H"`, `"7d"`, `""`, `null`
   - Golden-Test: für `1m|5m|15m|30m|1h` ist die Sanitize-Ausgabe **byte-identisch** zu vor
     diesem Prompt (Snapshot-Vergleich, nicht nur Feld-Vergleich)
   - `vwapPct === null` auf `1d` mit < 2 Kerzen am UTC-Tag
   - Micro-Executor-Guard: `1d`-Regel auf einem 1-min-Intervall erzeugt **keine** Order
     und genau einen Telemetrie-Counter

## Akzeptanzkriterien

- [ ] `RULE_FIELDS` unverändert
- [ ] `RuleAction`, `RULE_CEILINGS`, `RULE_ALLOWED_SIDE` unverändert
- [ ] `sanitizeRuleSpec` weiterhin fail-closed für alles außerhalb der abgeleiteten Menge
- [ ] Kein bestehender Test angepasst, um grün zu werden (Golden-Test beweist das)
- [ ] `npm run typecheck && npm run lint && npm test` grün
- [ ] Kein Template existiert, das `vwapPct` auf `>= 1h` voraussetzt (kommt in 03-07)

## Dokumentation

- `docs/BACKTESTING.md` / `docs/MISSIONS.md`: ergänze eine Tabelle
  „Rule-Timeframe ↔ unterstützte Felder" mit der `vwapPct`-Einschränkung.
- `docs/REPOSITORY_STRUCTURE.md` Zeile zu `ruleEngine` um den Timeframe-Hinweis ergänzen.

## Gesperrt

- **Kein** `RuleTrigger`/`CROSS`/`RECLAIM` (STX-18, eigener Audit).
- **Keine** `RuleAction.side`-Erweiterung. Shorts bleiben global gesperrt.
- **Keine** Änderung an `sanitizeRuleSpec`-Semantik, Ceilings oder Whitelist.
- Kein Einbau in den Micro-Executor-Loop über `vwapPct` hinaus.
