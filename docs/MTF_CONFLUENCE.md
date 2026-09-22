# Deterministische Multi-Timeframe-Konfluenz (RMA-P2-03, v1.62.0)

Die Konfluenz beantwortet genau eine Frage: **Zeigen die konfigurierten
Timeframes zum Entscheidungszeitpunkt in dieselbe Richtung?** Die Antwort ist
eine reine Funktion aus (Kerzen, as-of, Config) — kein LLM, keine Uhr, kein
Zufall. Gleiche Eingabe ergibt byte-identische Snapshots.

Befund:
[audits/2026-09-20-roadmap-audit/findings/RMA-P2-03-multi-timeframe-confluence.md](audits/2026-09-20-roadmap-audit/findings/RMA-P2-03-multi-timeframe-confluence.md).
Tracking:
[audits/2026-09-20-roadmap-audit/remediation/TRACKING.md](audits/2026-09-20-roadmap-audit/remediation/TRACKING.md).

## 1. Architektur

```text
HistoricalStore / getCandles() / Backtest-Reihen
  → src/confluence/adapters.ts   (Anbindung: Store-Batch, Market-, Lib-Kerzen)
  → src/confluence/confluence.ts (EINZIGE Formel: computeConfluence)
  → technischer Step (trustedData + Artefakt 04-technical-analyst.json)
  → Analyst (Promptblock + agentMessages.meta.confluence)
```

Zyklus-Step, Analyst, Scanner und Backtest teilen dieselbe pure Funktion
(`computeConfluence`). Adapter enthalten keine Formel — sie lesen, gruppieren
und protokollieren nur. Die Backtest-/Live-Parität ist getestet: derselbe
Kerzen-Snapshot ergibt über Store- und Kerzen-Adapter identische Outputs.

## 2. Zeitsemantik (Point-in-Time, kein Look-ahead)

| Begriff | Bedeutung |
| --- | --- |
| `event_time` | Kerzen-Öffnung `ts` (Venue-Konvention: Binance/Bitunix-`time` ist die Perioden-ÖFFNUNG; der Store persistiert sie als `ts`) |
| `barEnd` | `ts + timeframeMs` (erwartetes Periodenende) |
| `availableAt` | Ab wann die Kerze bekannt war (Store: `fetchedAt`; Live: als verfügbar; Backtest: injiziert) |
| `asOf` | Gemeinsamer Entscheidungszeitpunkt (injiziert, je Reihe identisch) |
| `computedAt` | Reine Protokollzeit (nie Entscheidungsgrundlage) |

Eine Kerze fließt nur ein, wenn sie **geschlossen** (`barEnd ≤ asOf`) **und**
**verfügbar** (`availableAt ≤ asOf`) ist. Die noch offene — insbesondere die
höhere-Timeframe — Kerze ist damit strukturell ausgeschlossen. Ein späterer
Backfill (`fetchedAt > asOf`) bleibt in der as-of-Sicht unsichtbar.

## 3. Features je Timeframe (bounded, warmup-geprüft)

Alle drei Merkmale sind normalisiert und gerundet (10 Dezimalen,
Half-away-from-zero, Scanner-Konvention):

| Merkmal | Bereich | Formel (Defaults) |
| --- | --- | --- |
| `trend` | [-1, 1] | `(EMA8 − EMA21) / EMA21 / 0.02`, geklemmt |
| `momentum` | [-1, 1] | gewichtete Rate-of-Change (Fenster 3/8/21, Gewichte 0.2/0.3/0.5) `/ 0.03`, geklemmt |
| `volatility` | [0, 1] | `ATR(14, Wilder) / Close / 0.05`, geklemmt |

Warmup-Bedarf (einzige Quelle: `requiredWarmupBars`):
`max(emaSlow, max(momentumLookbacks) + 1, atrPeriod + 1)` = **22 Bars**
bei Defaults. Darunter meldet der Timeframe `warmup` (fail-closed).

Die Timeframe-Richtung ist der gewichtete Mix
`0.5 × trend + 0.5 × momentum` (geklammert auf [-1, 1]).
Die Volatilität dreht die Richtung nie — sie dämpft nur die Confidence.

## 4. Aggregation (versioniert, erklärt)

- **Coverage** = Gewichtsanteil der verfügbaren Timeframes (Defaultgewichte
  15m/1h/4h → 0.2/0.3/0.5, Summe 1). Unter `minCoverage` (Default 0.5) gilt
  Status `ABSTAIN`: `direction`/`strength`/`bias` sind `null` (nicht `0`!),
  `confidence` ist `0`. `null` ist kein neutrales Signal.
- **Re-Normalisierung** oberhalb der Mindestcoverage über die verfügbaren
  Timeframes; fehlende Timeframes senken Coverage und Confidence — sie
  erhöhen sie nie.
- **Konflikt** = gewichtete mittlere absolute Abweichung der
  Timeframe-Richtungen vom gewichteten Mittel (0 = voll einig, ≤ 1).
  Über `conflictThreshold` (Default 0.5) gilt `DEGRADED` + Grund
  `conflict-high` — der Dissens bleibt sichtbar.
- **Confidence** = `coverage × (1 − conflict) × volFactor`; `volFactor`
  halbiert maximal bei extremer Streckung (`volHigh`, Default 0.8).
- **Bias**: `direction > 0.15` ⇒ BULLISH, `< −0.15` ⇒ BEARISH, sonst NEUTRAL
  (`biasThreshold`, Default 0.15).

Jede Outputzahl ist zurückführbar: `contributions[]` (Gewichte, Richtung,
Features, `barEndMs`, `barsUsed`), `missing[]` (geschlossener Grund +
Detail), `reasons[]` (maschinenlesbar). Formelversion `mtf-confluence@1` und
Config-Version stehen in jedem Snapshot.

Missing-Gründe (geschlossen): `no-closed-bars`, `warmup`, `stale`
(`asOf − letztesBarEnde > stalePeriods × Periode`, Default 2 Perioden),
`invalid` (OHLC-Regel im Rechenfenster verletzt), `unavailable`
(Reihe nicht geliefert).

## 5. Integration (Trusted-Data, kein Override)

- **Tageszyklus** (`src/cycle/steps/technicalStep.ts`): Der Step rechnet je
  Kandidat (max. 40) VOR dem LLM einen Snapshot (Store-Batch, eine
  Datei-Ladung). Der Snapshot läuft als GETRENNTER `trustedData`-Block in den
  Prompt (erklären, nicht überschreiben) und wird NACH der Validierung
  serverseitig angehängt (`analysis.confluence`, `confluenceMeta`). Die
  Schema-Validierung verwirft `confluence`-Felder der LLM-Antwort strukturell.
- **Analyst** (`src/lib/analysts.ts`, `runTechnicalAnalyst`): derselbe
  Snapshot über den Live-Kerzen-Adapter, als Promptblock plus
  `agentMessages.meta.confluence` (additiv).
- **Scanner/Backtest**: teilen die pure Funktion über die Adapter; die
  Scanner-Gesamtrangfolge bleibt unverändert (kein Ersatz, kein neues Training).

Idempotenz: `snapshotKey` (`mtf1:<sha256>`) ist stabil über
(Instrument, asOf, Bar-Enden, Config, Formel) — Retries/Restarts erzeugen
keine doppelten Writes.

## 6. Konfiguration

Quelle der Wahrheit: `DEFAULT_CONFLUENCE_CONFIG`
(`src/confluence/config.ts`, Version 1). Datei-Override via
`CONFLUENCE_CONFIG_FILE` (JSON, validiert — kaputte Config bricht laut ab).
Bounds: 1–5 Timeframes (Allowlist, eindeutig), Gewichte je [0, 1] mit Summe
exakt 1, `minCoverage` [0.1, 1], Schwellen [0, 1], Perioden ganzzahlig,
Warmup ≤ `maxBars`. Gewichte stammen ausschließlich aus der Config —
Prompts können sie weder setzen noch umdeuten.

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `CONFLUENCE_ENABLED` | `true` | `false` schaltet die Step-Anhängung ab (Legacy-Output, additiv kompatibel). Nur `false`/`0`/`off`/`no` schalten ab; unbekannte Werte warnen und lassen an. |
| `CONFLUENCE_CONFIG_FILE` | — | Pfad einer JSON-Config (Defaults + validierte Overrides). Unlesbar/ungültig ⇒ harter Fehler. |

Details in [../CONFIGURATION.md](../CONFIGURATION.md) (§ MTF-Konfluenz).

## 7. Observability und Operationen

- Metrik `confluence_runs_total{result,source}` (`result` = ok/degraded/
  abstain, `source` = cycle/analyst/backtest/scanner/api) — bounded Labels,
  keine Instrument-IDs (siehe [OBSERVABILITY.md](OBSERVABILITY.md)).
- Audit-Event `confluence_computed` (strukturiertes Log): Instrument, Status,
  Richtung/Stärke/Bias, Confidence/Coverage/Konflikt, Versionen, Snapshot-Key,
  Missing-Zähler. `ABSTAIN` loggt `warn`, sonst `info`. Keine Secrets,
  keine Roh-Payloads.
- Artefakte: `artifacts/YYYY-MM-DD/daily/04-technical-analyst.json`
  (Snapshots + `confluenceMeta`), Analystenberichte in `agentMessages`.

## 8. Migration, Deployment, Rollback

- **Keine DB-Migration erforderlich**: Persistenz über versionierte
  Zyklus-Artefakte (JSON) und `agentMessages.meta` (additive Felder).
  Alt-Artefakte ohne `confluence` bleiben lesbar; neue Konsumenten behandeln
  fehlende Felder als „kein Snapshot" (nie als neutral).
- **Deployment**: Standard-Release (Minor). Bestehende Paper-/Backtest-
  Defaults ändern ihr Verhalten nicht (Scanner-Ranking, Risk-Ceilings,
  Kill-Switches, Authority Chains, Live-Gates unberührt).
- **Rollback**: Redeploy der Vorversion ODER `CONFLUENCE_ENABLED=false`
  (sofortiger Legacy-Output ohne Snapshot, ohne Code-Änderung).
  Unbeabsichtigte Config-Dateien entfernen (`CONFLUENCE_CONFIG_FILE` unset
  ⇒ Defaults).
