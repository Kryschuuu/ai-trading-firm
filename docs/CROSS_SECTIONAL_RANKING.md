# Point-in-Time Cross-Sectional Momentum Ranking (RMA-P2-04, v1.63.0)

Das Cross-Sectional-Ranking beantwortet genau eine Frage: **Wo steht ein
Instrument im Universum, gemessen an seiner universumsweiten Momentum-
Rendite — zum Entscheidungszeitpunkt, mit nur dem, was dann verfügbar war?**
Die Antwort ist eine reine Funktion aus (Kandidaten, Kerzen, as-of, Config,
Code-Version): deterministisch, versioniert und vollständig nachvollziehbar
(Snapshot-ID, Hashes, Exclusions, Survivorship-Note). Kein LLM, kein
Netzwerk, keine Orders.

Befund: [audits/2026-09-20-roadmap-audit/findings/RMA-P2-04-cross-sectional-ranking.md](audits/2026-09-20-roadmap-audit/findings/RMA-P2-04-cross-sectional-ranking.md).
Tracking: [audits/2026-09-20-roadmap-audit/remediation/TRACKING.md](audits/2026-09-20-roadmap-audit/remediation/TRACKING.md).

## 1. Architektur

```text
Registry (Kandidaten) + HistoricalStore (Kerzen)
  → src/crossSectional/universe.ts   (Eligibility + Exclusions, deterministisch)
  → src/crossSectional/momentum.ts   (Renditen je Horizon, cutoff-sichtbar)
  → src/crossSectional/rank.ts       (Winsorize → z → Composite → Rang/Perzentil)
  → src/crossSectional/snapshot.ts   (Snapshot bauen, Provenance/Hashes, Note)
  → src/crossSectional/store.ts      (DB: persist/idempotent/PIT-Load/Prune)
  → src/crossSectional/artifact.ts   (Datei-Artefakt: Cross-Prozess-Medium)
  → src/scanner/factors/crossSectionalMomentum.ts  (Diagnose-Faktor, Gewicht 0)
CLI:   npm run research:cross-sectional   (scripts/run-cross-sectional.ts)
API:   GET /api/research/cross-sectional  (read-only, PIT über ?asOf)
```

Zwei Persistenzformen mit identischen Daten:

| Form | Zweck |
| --- | --- |
| **DB** (`cross_sectional_snapshots` + `cross_sectional_rankings`) | Idempotente, PIT-lesbare Historie; Retention/Pruning; Stabilitäts-Vergleich gegen Vorgänger |
| **Artefakt** (`artifacts/cross-sectional/YYYY-MM-DD/<snapshotId>.json`) | Cross-Prozess-Medium der Scanner-Integration (Web-Prozess liest das jüngste Artefakt, Staleness-begrenzt); deterministisch/atomar, nicht in Git |

## 2. Zeitsemantik (Point-in-Time, kein Look-ahead)

| Begriff | Bedeutung |
| --- | --- |
| `ts` (event_time) | Kerzen-Öffnung (Store-Konvention) |
| `barEnd` | `ts + timeframeMs` — geschlossene Bar, wenn `barEnd ≤ asOf` |
| `fetchedAt` (availableAt) | Ab wann die Kerze im Store **ingested** war |
| `asOf` | Gemeinsamer Cutoff des Snapshots (eine Zahl für das ganze Universum) |
| `computedAt` | Reine Protokollzeit (nie Entscheidungsgrundlage, nie im Idempotenz-Key) |

Verfügbarkeits-Policy **`ingested`** (Default, einziger produktiver Modus):
eine Kerze fließt nur ein, wenn sie geschlossen **und** zu ihrem
Ingestionszeitpunkt verfügbar war (`barEnd ≤ asOf` **und**
`fetchedAt ≤ asOf`). Eine Kerze, die erst später nachgeliefert wird
(Late Backfill, `fetchedAt > asOf`), ist für **alle** früheren as-of-Zeitpunkte
strukturell unsichtbar — der historische Snapshot ändert sich durch spätere
Daten **nie** (getestet: `tests/crossSectional.unit.test.ts`,
„Look-ahead“-Fall). `computedAt` und der Idempotenz-Key sind davon getrennt.

## 3. Universum & Eligibility

Kandidaten kommen aus der Registry (alle Instrumente); optional schränkt
`eligibility.assetClasses` auf Assetklassen ein. Jedes Instrument erhält
genau einen Status mit einem geschlossenen Grund (beides im Snapshot
persistiert — die Mitgliedschaft zum as-of ist nachvollziehbar, nicht nur
das Ergebnis):

| Exclusion-Grund | Bedingung |
| --- | --- |
| `INACTIVE` | Status ≠ `active` |
| `NOT_IN_ASSET_CLASSES` | Assetklasse nicht in der (optionalen) Allowlist |
| `NO_LIQUIDITY_DATA` | kein `volume24h` bekannt |
| `BELOW_MIN_VOLUME` | `volume24h < minVolume24h` (Default 100 000) |
| `UNIVERSE_CAP` | Sortierung nach Liquidität, dann ID; > `maxUniverseSize` (Default 500) fällt ab |
| `NO_BARS_AT_CUTOFF` | keine cutoff-sichtbaren Kerzen |
| `STALE_DATA` | letzte sichtbare Bar älter als `maxStaleBars` Perioden |
| `INSUFFICIENT_HISTORY` | < `minCandles` (Default 168) sichtbare Kerzen |
| `INSUFFICIENT_HORIZON_COVERAGE` | Sichtbarer Anteil der Horizonte < `minHorizonCoverage` (0.5) |
| `CROSS_SECTION_DEGENERATE` | Querschnitt nicht berechenbar (σ undefined, z. B. < 2 rankbare Mitglieder) |
| `INVALID_INPUT` | inkonsistente Eingabedaten (fail-closed) |

**Coverage** = `rankedCount / universeSize` (persistiert, CHECK ≤ 1).
Die Persistierung trägt eine **Survivorship-Note**: das Universum stammt aus
der aktuellen Registry — delistete Instrumente sind strukturell nicht
rekonstruierbar (dokumentierte Lücke, siehe §8).

## 4. Momentum (versionierte Horizonte)

Jeder Horizon `h` = `{ id, lookback, skip, weight }` (Default:
`h72`/`h168`/`h336` auf dem 1h-Raster, Gewichte 0.2/0.3/0.5, Summe 1):

- **Total-Rendite** `total = close_end / close_start − 1` über die letzten
  `lookback` **geschlossenen, cutoff-sichtbaren** Kerzen; `skip > 0` lässt
  die letzten `skip` Kerzen aus (Reversal-Fenster, Default 0).
- **Volatilitäts-Adjustierung** `volAdjusted = total / (σ · √span)` mit
  σ über die bar-weisen Log-Renditen im Fenster; bei < `minVolReturns`
  (Default 3) beobachteten Kerzen oder σ = 0 bleibt der Wert
  **explizit `null`** (nie 0 — fail-closed).
- `valueMode: "total"` (Default) verwendet die Total-Renditen für den
  Querschnitt; `volAdjusted` bleibt als Rohwert im Snapshot nachvollziehbar.

Ein Horizont, der nicht genug sichtbare Daten hat, ist für dieses
Instrument **nicht berechenbar** (explizite `null` pro Horizon) und zählt
gegen `horizonCoverage` — er wird niemals als 0 behandelt.

## 5. Querschnitt (gleiche Kohorte, gleiche Skala)

Nur innerhalb **eines** Snapshots (gleiche Kohorte, gleicher Cutoff):

1. **Winsorize** je Horizon auf [`winsorLower`, `winsorUpper`]
   (Default [0.01, 0.99]-Quantile) — Outlier begrenzen, ohne Werte zu erfinden.
2. **Standardisierung** (z-Score) je Horizon über die rankbaren Mitglieder;
   σ < `minZStd` ⇒ Querschnitt degeneriert (§3, `CROSS_SECTION_DEGENERATE`).
3. **Composite** = gewichtete Summe der z-Scores (Gewichte der Horizonte).
4. **Rang** absteigend nach Composite; **Tie-Break: kanonische
   Instrument-ID** (deterministisch, unabhängig von der Eingabe-Reihenfolge —
   Permutationsinvarianz getestet).
5. **Perzentil** = `(n − rank + 1) / n` ∈ (0, 1] — Anteil des Universums mit
   gleichem oder schlechterem Rang.

Fehlende Horizonte verdringen ein Instrument nicht: Es wird über die
vorhandenen berechnet, solange `horizonCoverage ≥ minHorizonCoverage`.

## 6. Identität, Persistenz, Idempotenz

**Snapshot-ID** (deterministisch, `xs1:` + SHA-256):

```text
xs1:<sha256("v1|timeframe|asOfMs|universeHash|dataHash|configHash|codeVersion")>
```

- `universeHash` (`xu1:`) — Mitgliedschaft + Auschlüsse (sortiert, kanonisch)
- `dataHash` (`xd1:`) — cutoff-sichtbare Kerzen (sortiert, gerundet)
- `configHash` (`xc1:`) — validierte Config
- `codeVersion` — `cross-sectional@1` (Formel-/Reihenfolge-Änderungen bumpen)

**Idempotenz-Key** = derselbe Hex-String (64). Dieselbe fachliche Eingabe
schreibt **nie** eine zweite Zeile; ein Retry (auch nach Neustart, auch mit
anderem `computedAt`) ist ein sichtbarer No-Op (`written: false`).
`asOf`/Config/Universum ändern ⇒ neue ID ⇒ neuer Snapshot (getestet).

**Tabellen** (append-only Migration
[`drizzle/2026-09-22_cross_sectional_ranking.sql`](../drizzle/2026-09-22_cross_sectional_ranking.sql),
zweifach anwendbar):

- `cross_sectional_snapshots` — Kopfzeile: ID, Key, as_of/computed_at,
  Versionen/Hashes, Zeitfenster, Zählungen, Coverage (CHECK ≤ 1),
  Exclusion-Counts, Survivorship-Note, Stabilität (JSONB).
- `cross_sectional_rankings` — je Mitglied eine Zeile: Status (RANKED |
  EXCLUDED), Rang, Perzentil, Composite, Rohwerte/z-Scores/Winsorized
  (JSONB), Horizon-Coverage, Exclusionsgrund, `value_hash` (Konflikt-Guard).

**Konflikt-Guard (fail-closed):** weicht eine existierende Mitglieder-Zeile
vom deterministisch erwarteten `value_hash` ab, wird sie **nie
überschrieben**, sondern protokolliert (`conflicts` + Audit-Event
`cross_sectional_ranking_conflict` + Metrik `cross_sectional_rank_conflicts_total`).

**Stabilität/Turnover:** `persistCrossSectionalSnapshotWithStability`
vergleicht Top-K (Default `stabilityTopK` 10) gegen den unmittelbar
vorausgehenden Snapshot desselben Timeframes: `prevSnapshotId`, `topKOverlap`,
`rankShiftMean`, `commonCount` — bounded Felder, keine IDs-Kardinalität.

**PIT-Load:** `loadLatestSnapshot({ asOfMs, timeframe? })` liefert die
jüngste Zeile mit `as_of ≤ asOfMs` — spätere Snapshots sind für frühere
Zeitpunkte unsichtbar. **Retention:** `pruneCrossSectionalSnapshots`
entfernt überfällige Kopfzeilen; Mitglieder-Zeilen fallen per FK-Cascade weg
(keine Orphane, getestet).

## 7. Scanner-Integration (additiv, Gewicht 0)

Der neue Diagnose-Faktor **`crossSectionalMomentum`** (einer von 15) liest
den injizierten Kontext (`FactorInput.crossSectional`) und liefert
`normalized = percentile`, `raw = composite`, Provenienz im Detail.

- **Explizites Unavailable (fail-closed):** ohne Karte (kein Artefakt,
  stale, `CROSS_SECTIONAL_ENABLED=false`, kaputter Kontext) ⇒
  `available: false`, `raw: null`, `normalized = 0.5` (Median des
  Querschnitts). Ein fehlender Rang geht **nie** still als 0-Momentum in
  eine Entscheidung ein.
- **Kein Doppeltzählen (dokumentierte Gewichtsentscheidung):** Der Faktor
  ist ein **Diagnose-Faktor ohne Score-Gewicht** (wie `atr`, `rsi`,
  `funding`, …). Die gewichtete Momentum-Komponente des Market Scores bleibt
  der instrument-lokale Faktor `momentum`. Ein kompletter
  `scanUniverse`-Lauf mit und ohne Cross-Sectional-Karte erzeugt für jedes
  Instrument **identischen Score und identischen Breakdown** (getestet:
  `tests/crossSectional.scanner.test.ts`). Eine spätere Gewichtung ist eine
  bewusste, versionierte Config-Änderung — keine stillschweigende.

Der Scanner führt dafür **keine I/O selbst aus**: Der Web-Prozess liest das
jüngste Artefakt (Staleness ≤ `maxSnapshotAgeMs`, Default 7 Tage);
`CROSS_SECTIONAL_ENABLED=false` stellt das exakte Vor-Verhalten her
(Rollback-Pfad).

## 8. Operations

```bash
npm run research:cross-sectional                     # as-of = jetzt
npm run research:cross-sectional -- --as-of=2026-09-22T00:00:00.000Z
npm run research:cross-sectional -- --dry            # nur rechnen
npm run research:cross-sectional -- --top=10
```

Exit-Codes: `0` = Snapshot berechnet (≥ 1 geranktes Instrument) bzw.
Feature-Flag aus; `1` = harter Fehler **oder** 0 gerankte Instrumente
(Datenproblem — der Snapshot wird persistiert, damit der Zustand sichtbar
ist, der Lauf meldet es laut).

**API** (read-only, ohne Token, keine Mutation):

```text
GET /api/research/cross-sectional                    # jüngster Snapshot
GET /api/research/cross-sectional?asOf=<ISO-Zeit>    # PIT: jüngster mit as_of ≤ asOf
GET /api/research/cross-sectional?instrumentId=BINANCE:BTCUSDT
GET /api/research/cross-sectional?timeframe=1h&top=10&exclusions=false
```

Antwort: `snapshot` (Provenance, Coverage, Exclusion-Counts, Stabilität,
Survivorship-Note) + `items` (RANKED, nach Rang) + `member`. Ohne Snapshot:
`{ ok: true, snapshot: null, reason: "NO_SNAPSHOT" }` (200, kein Fehler).
Ungültige Parameter ⇒ 400 `VALIDATION_ERROR`; DB-Fehler ⇒ 503
`STORAGE_UNAVAILABLE` (generische Meldung, keine Interna).

**Env-Flags** (Details in [`CONFIGURATION.md`](../CONFIGURATION.md)):

| Flag | Default | Bedeutung |
| --- | --- | --- |
| `CROSS_SECTIONAL_ENABLED` | `true` | Feature-Flag: Scanner-Artefakt-Lesepfad an/aus; CLI-Lauf bleibt möglich. Nur `false`/`0`/`off`/`no` schaltet ab; unbekannte Werte warnen und lassen die Funktion an (fail-laut). |
| `CROSS_SECTIONAL_CONFIG_FILE` | `—` | Pfad einer JSON-Config (Defaults + validierte Overrides). Unlesbar/ungültig ⇒ harter Fehler mit `CROSS_SECTIONAL_CONFIG_ERROR` (kein still schwächeres Verhalten). |

## 9. Monitoring (bounded)

Metriken mit ausschließlich Code-konstanten Labels (Kardinalitätsregel:
**keine** Instrument-/Snapshot-IDs als Label):

| Metrik | Labels |
| --- | --- |
| `cross_sectional_runs_total` | `result`: ok \| empty \| error \| store-error |
| `cross_sectional_persist_total` | `persist`: written \| duplicate \| pruned |
| `cross_sectional_rank_conflicts_total` | — |

Strukturierte Audit-Events (IDs und Details stehen **hier**, nicht in
Metrik-Labels): `cross_sectional_snapshot_persisted` (Snapshot-ID, asOf,
universe/ranked/coverage, Exclusion-Top-Gründe) und
`cross_sectional_ranking_conflict` (Snapshot-ID, Instrument, erwartet vs.
gefunden). Turnover/Stabilität ist als bounded JSONB-Feld pro Snapshot
persistiert (kein High-Cardinality-Zeitrahl-Problem).

## 10. Tests

| Suite | Abdeckung |
| --- | --- |
| `tests/crossSectional.unit.test.ts` | exakte Rang-/Perzentil-Fixtures, Permutationsinvarianz, Look-ahead (Late Backfill ändert historische Snapshots nicht), Eligibility-Gründe, Degenerationsfälle, Winsorize/z-Formel, volAdjusted-Formel, Artefakt-Roundtrip/Byte-Identität |
| `tests/crossSectional.db.test.ts` | Migration idempotent (zweifach), Roundtrip + Zeitsemantik, Idempotenz (Retry ×3, anderer computedAt), Restart (frischer Pool), PIT-Sichtbarkeit, CHECK-Constraints (Coverage/Zählungen/ID-Formate), Konflikt-Guard, Stabilität gegen Vorgänger, Retention + FK-Cascade (Orphan-Check) |
| `tests/crossSectional.api.test.ts` | Query-Validierung (400), NO_SNAPSHOT-Form, Antwort-Aufbau (Top-Limit, Exclusions-Schalter, Member-Lookup), HTTP-Pfad gegen eingebettete Postgres (200, PIT über `?asOf`, Timeframe-Filter) |
| `tests/crossSectional.scanner.test.ts` | explizites Unavailable (0.5, nie 0), gültiger Kontext (raw/normalized/Provenienz), **Score-Invarianz bei Gewicht 0** (identische Scores/Breakdowns mit/ohne Karte) |

## 11. Bekannte Grenzen (bewusst, dokumentiert)

- **Survivorship Bias:** das Universum wird aus der **aktuellen** Registry
  gebildet; delistete Instrumente sind für historische as-of-Zeitpunkte nicht
  rekonstruierbar. Die Persistierung trägt daher eine Survivorship-Note je
  Snapshot, und die Rekonstruktion survivorship-bias-freier Universen ist
  **ausdrücklich out of scope** (RMA-P2-04).
- **Einzelmitglieder-Querschnitt:** mit < 2 rankbaren Mitgliedern ist σ
  undefined ⇒ `CROSS_SECTION_DEGENERATE` (by design, nicht stumm 0).
- **Kein Order-Pfad:** das Ranking ist Forschungs-/Diagnose-Eingabe; es
  erzeugt keine impliziten Orders und ersetzt nicht den Scanner-Ranker.
