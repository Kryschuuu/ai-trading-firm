# Portfolio-Volatility-Targeting (RMA-P5-01, v1.67.0)

Kontinuierliches Portfolio-Volatilitäts-Targeting als **zweite, kontinuierliche
Risikoschicht** neben der diskreten Regime-Maschine (`src/lib/adaptiveRisk.ts`).
Das System misst die annualisierte Portfolio-Volatilität aus as-of-sicheren
Returns, vergleicht sie mit einem konfigurierten Ziel und skaliert das
Risikobudget `maxRiskPerTrade` multiplikativ — **nur senkend** (Faktor ≤ 1).

- Finding: [`docs/audits/2026-09-20-roadmap-audit/findings/RMA-P5-01-volatility-targeting.md`](audits/2026-09-20-roadmap-audit/findings/RMA-P5-01-volatility-targeting.md)
- Kern (pure, geteilt von Live & Backtest): `src/portfolio/volatilityTargeting.ts`
- Live-Orchestrator: `src/lib/volatilityTargeting.ts`
- Backtest-Integration: `src/backtest/engine.ts` (Opt-in via `config.volatilityTargeting`)
- Persistenz: `volatility_targeting_snapshots` (`drizzle/2026-09-22_volatility_targeting.sql`)
- API: `GET /api/firm/risk/volatility-targeting` (Status), `POST /api/firm/risk/volatility-targeting` (Forced-Update), `GET /api/firm/risk/volatility` (erweitert)

---

## 1. Ziel & Grenzen

**Ziel:** Das Portfolio soll über die Zeit eine Zielvolatilität
(`targetAnnualizedVolPct`, Default 30 % p. a.) anstreben, indem das
Risikobudget bei hoher Forecast-Volatilität reduziert wird.

**Ausdrücklich NICHT Bestandteil (Scope-Grenzen):**

- Keine Hebel-Erhöhung über die bestehenden Limits (Faktor ist hart ≤ 1).
- Keine Erwartungsrendite-Optimierung (nur Volatilität, keine Return-Schätzung).
- Kein Ersatz für Kill-Switches, Authority-Chains oder Live-Gates — das
  Volatility-Targeting wirkt **innerhalb** der bestehenden Sandbox.

## 2. Betriebsmodi (Feature-Flag `PORTFOLIO_VOL_TARGETING_MODE`)

| Modus | Forecast + Persistenz | Ordergrößenwirkung | Verwendung |
| --- | --- | --- | --- |
| `monitor` (Default) | Ja | **Nein** | Rollout-Start; Soll-Ist-Monitoring (realisierte Vol + Target-Error) ohne jede Eingriffswirkung |
| `active` | Ja | **Ja** (Faktor ≤ 1 auf `maxRiskPerTrade`) | Begrenzte Anwendung nach Monitoring-Phase |
| `off` | Nein | Faktor wird zurückgenommen (Rollback) | Sofort-Abschaltung |

Zusätzlich `vtp.enabled` in `risk_config` (Master-Schalter, Default 1) und
`PORTFOLIO_VOL_TARGETING_TIMEFRAME` (Default `1h`, erlaubte: `5m 15m 30m 1h 4h 1d`).
Unbekannte Werte fallen auf `monitor` bzw. `1h` zurück (kein Stillversagen).

**Rollout-Pfad:** `monitor` (Default) ≥ 1–2 Wochen beobachten (Target-Error,
Fallback-Häufigkeit) → `active` → bei Problem sofort `off` oder `monitor`
(keine Datenbereinigung nötig, Zeilen bleiben lesbar).

## 3. Mathematik

### 3.1 Forecast

Aus as-of-sicheren Log-Returns `r_t` (geschlossene Kerzen, Event-Zeit =
Schließzeit der Kerze) wird die Stichprobenkovarianz pro Periode
(`ddof = 1`) geschätzt und regularisiert:

```
Σ* = (1 − κ)·Σ + κ·μ·I        κ = shrinkage (Default 0.1), μ = tr(Σ)/n
```

Annualisierte Portfolio-Volatilität mit Zielgewichten `w` (Long-only,
Σw = 1) und Asset-spezifischer Annualisierung `A_i` (Perioden/Jahr):

```
σ̂_a = √( wᵀ Σ^A w ),    Σ^A_ij = Σ*_ij · √(A_i·A_j)
```

Bei einheitlichem `A_i = A` reduziert sich das auf die klassische
√A-Skalierung: `σ̂_a = A · √(w Σ* w)`. Die √(A_i·A_j)-Form annualisiert
jeden Paarbeitrag mit der Jahreslänge seiner Asset-Klassen (Krypto 365 d,
Aktien 252 d); die Korrelationsstruktur bleibt unverändert (dokumentierte
Annahme).

### 3.2 Multiplikator

```
raw      = target / σ̂_a
clamped  = clamp(raw, minMultiplier, maxMultiplier)      maxMultiplier hart ≤ 1
smoothed = α·clamped + (1 − α)·prev                      α = smoothingAlpha
applied  = clamp(smoothed, prev − maxStep, prev + maxStep)  finaler Clamp
```

- `prev = null` (erster Lauf) ⇒ `prev = maxMultiplier` (neutraler Start).
- **Fallback-Short-Circuit:** bei jedem Validierungsfehler springt `applied`
  SOFORT auf `minMultiplier` (bypassed Smoothing + Max-Step — die sichere
  Richtung ist sofort, gleiche Konvention wie die Regime-Maschine).
- `applied` ist immer endlich und in `[minMultiplier, maxMultiplier]`.

### 3.3 Komposition in der Risk-Guard-Kaskade

```
Code-Ceilings (LIMIT_CEILINGS)
  └─ Basis-Limit (risk_config / Dashboard)
       └─ × Regime-Faktor (diskret, adaptiveRisk.ts)
            └─ × VolTarget-Faktor (kontinuierlich, volatilityTargeting.ts)
                 └─ Code-Boden (LIMIT_CEILINGS.maxRiskPerTrade[0])
```

Multiplikativ: beide Faktoren ≤ 1 ⇒ Produkt ≤ 1 ⇒ das Ergebnis kann das
konfigurierte Basis-Limit **niemals überschreiten**. Die Faktoren sind
unabhängig (Regime = Markt-Furcht, VolTarget = Portfolio-Volatilitätsziel)
und stacken. `src/lib/riskGuard.ts` klemmt zusätzlich hart auf (0, 1].

## 4. Fail-closed-Verhalten (verbindlich)

Fehlende, stale oder invalide Daten führen **nie** still zu „neutral“:

| Ursache | Reason-Code | Effekt |
| --- | --- | --- |
| keine Serien / alle unbrauchbar | `NO_SERIES` | Fallback → `minMultiplier` |
| ungültige Gewichte (negativ/NaN) | `INVALID_WEIGHTS` | Fallback |
| keine Exposure (alle Gewichte 0) | `ZERO_EXPOSURE` | **neutral** (1) — Cash hat kein Risiko zu dämpfen |
| T < minObservations | `INSUFFICIENT_DATA` | Fallback (Wärmeauflauf) |
| unterschiedliche Serienlängen | `LENGTH_MISMATCH` | Fallback |
| Event-Zeiten in der Zukunft (Look-ahead) | `INVALID_EVENT_TIMES` | **harter** Fallback |
| Daten älter als maxStaleness | `STALE_DATA` | Fallback |
| gewichtete Abdeckung < minCoverage | `LOW_COVERAGE` | Fallback |
| Kovarianz nicht symmetrisch | `SYMMETRY_VIOLATION` | Fallback |
| Kovarianz nicht PSD (auch nach Ridge) | `ILL_CONDITIONED` | Fallback |
| ungültiges Ziel | `CONFIG_INVALID` | Fallback |
| Forecast OK | `OK` | Normalpfad |

Dabei gilt:

- **Per-Serie-Verwendbarkeit:** eine Serie mit NaN/±∞-Returns, fehlenden
  Event-Zeiten oder unzulässiger Annualisierung wird **ausgeschlossen** und
  zählt in die gewichtete Abdeckung — eine einzige defekte Quelle tötet das
  Targeting nicht (außer die Abdeckung sinkt unter `minCoverage`).
- **`forecastAnnualizedVol = null` bei Fallback** (nie 0 — 0 wäre
  „kein Risiko“, eine andere Aussage).
- **Event-Zeiten in der Zukunft** sind ein Strukturverstoß (Look-ahead) und
  scheitern hart.
- **Ridge-Fallback** (1e-6) bei singulärer Kovarianz (z. B. ρ = 1): der
  Forecast bleibt endlich und konservativ, `regularization: "ridge"` wird
  persistiert.

## 5. Zeitsemantik (drei getrennte Zeitachsen)

| Zeitstempel | Bedeutung |
| --- | --- |
| `eventTime` | Verfügbarkeitszeit des Returns (Schließzeit der geschlossenen Kerze) |
| `asOf` | Entscheidungszeitpunkt |
| `computedAt` | Berechnungszeit (im Live-Pfad ≈ `now`), immer ≥ `asOf` (DB-CHECK) |

Nur **geschlossene** Kerzen: eine Kerze ist geschlossen, wenn
`time + timeframeMs ≤ computedAt`. Der Kern prüft
`computedAt − min(jüngste EventTime der verwandten Serien) ≤ maxStalenessMs`
— unvollständige oder zu alte Kerzen führen zu `STALE_DATA`. Die Backtest-
Engine nutzt ihre etablierte Verfügbarkeitskonvention (Kerze mit
`time ≤ currentTime` ist verfügbar); as-of = `currentTime`. Look-ahead ist
strukturell ausgeschlossen und wird von Tests belegt.

## 6. Annualisierung

`annualizationForTimeframe(timeframe, assetClass)`:

- Krypto: 365 Tage (24/7), Aktien/ETFs/Indizes/Commodities/FX: 252 Tage
  (gleiche Konvention wie `src/portfolio/config.ts`; unbekannte Klasse → 252).
- 1h ⇒ 24 Perioden/Tag ⇒ Krypto 8760, Aktien 6048. 5m-Krypto = 105.120.
- Gültigkeitsfenster: 1…200.000 Perioden/Jahr (`validateAnnualization`).
- Backtest: einheitliche `annualization` über alle Serien (Default 24/7:
  `msPerYear / timeframeMs`), überschreibbar via
  `config.volatilityTargeting.annualization`.

## 7. Persistenz & Idempotenz

`volatility_targeting_snapshots` (append-only, eine Zeile je Snapshot):

- **Idempotency-Key** `snapshot_id = vt1:<sha256>` über
  `(Minute(computedAt) | configHash | dataHash)`, UNIQUE,
  `ON CONFLICT DO NOTHING` — Retry/Restart in derselben Minute mit
  identischer Eingabe ⇒ **keine doppelte Zeile**.
- **Reproduktions-Hashes:** `config_hash = cfg1:<sha256>` (resolvede
  Konfiguration), `data_hash = data1:<sha256>` (Serien + Gewichte +
  Event-Zeiten + asOf/computedAt). Aus den Hashes + Schema lässt sich jeder
  Snapshot nachvollziehen.
- Persistiert werden: Status, Reason-Code/-Text, Ziel, Forecast,
  **realisierte Volatilität + Target-Error**, **raw/applied Multiplikator**,
  Coverage, Beobachtungen, Annualisierung, Shrinkage, Regularisierung,
  Normalgewichte (JSONB), drei Zeitstempel, Modus.
- **Aktiver Faktor** zusätzlich in `risk_config` (`vtp.activeFactor`,
  `vtp.activeAt`) — nur im `active`-Modus, damit der **separate
  Mikro-Executor-Prozess** (ohne Marktzugriff) die Reduktion übernehmen kann
  (analog `adp.activeFactor`). Der Mikro-Executor wendet sie nur an, wenn
  der Modus `active` und der Faktor jünger als `ADAPTIVE_STATE_MAX_AGE_MS`
  ist.
- DB-CHECKs erzwingen die Invarianten: `applied_multiplier ∈ (0, 1]`,
  `monitor_only = (mode = 'monitor')`, `computed_at ≥ as_of`, Hash-Formate,
  `coverage ∈ [0, 1]`.

## 8. Observability

- **API:** `GET /api/firm/risk/volatility-targeting` — Modus, Forecast,
  raw/applied Multiplikator, realisierte Vol, Target-Error, Coverage,
  Konfiguration + Bounds; `POST` (mit `firm.write`) erzwingt einen Update.
  `GET /api/firm/risk/volatility` trägt zusätzlich
  `volatilityTargeting: <status|null>`.
- **Monitor-Tick:** `updateVolatilityTargeting()` läuft nach
  `updateAdaptiveRisk()` (Min-Interval 5 min, Single-Flight; Fehler landen in
  `TickResult.errors` und im Status, nie im Unbehandelten).
- **Metriken (bounded, keine Instrument-/Order-IDs als Labels):**
  `telemetry.volatilityTargeting.updates{result,mode}`,
  `fallbacks{reason}`, `snapshots{result: written|duplicate|failed}`.
- **Audit:** `RISK_VOL_TARGETING` (INFO; Fallbacks als WARN +
  `auditClass: "security"`), Detail mit allen Soll-Ist-Werten.
- **Soll-Ist-Monitoring:** `realizedAnnualizedVol` (gleiche Gewichte, OHNE
  Shrinkage) und `targetError = realized − target` werden je Snapshot
  persistiert und im Status gemeldet.

## 9. Backtest-Integration

`runMultiAssetBacktest({ config: { volatilityTargeting: { config?, annualization? } } })`:

- `undefined` (Default) ⇒ Feature **inaktiv**, Byte-identische Läufe wie vor
  v1.67.0, kein Summary-Feld im Ergebnis.
- Opt-in ⇒ in jedem Bar-Schritt derselbe pure Kern wie Live
  (`computeVolatilityTargetingFromInput`); Faktor skaliert das
  Risikobudget des Einstiegs (`budget × factor`, ≤ 1).
- Ergebnis: `result.volatilityTargeting` mit
  `factorByBar` (Index = barStep − 1, 1 = neutral), `updates`, `fallbacks`,
  `fallbacksByReason`, `noExposureSteps`, `lastAppliedMultiplier`.
- Deterministisch: gleicher Input ⇒ bit-identischer Faktor-Verlauf.

## 10. Migration, Deployment, Rollback

**Migration (append-only, idempotent):**

```
npx drizzle-kit push        # oder: psql "$DATABASE_URL" -f drizzle/2026-09-22_volatility_targeting.sql
```

Neue Tabelle `volatility_targeting_snapshots` + UNIQUE/Indizes + 12
CHECK-Constraints. Keine bestehende Tabelle wird verändert, kein Backfill.
Die Migration ist zweifach ausführbar (`IF NOT EXISTS` + guarded
`ALTER TABLE ... ADD CONSTRAINT`).

**Deployment:** `git pull` → `rm -rf .next node_modules/.cache` → `npm ci` →
`npx drizzle-kit push` → `npm run build` → `systemctl restart ai-trading-firm`.
Der Default-Modus ist `monitor` — nach dem Deploy passiert **nichts** an den
Ordergrößen, bis `PORTFOLIO_VOL_TARGETING_MODE=active` gesetzt wird.

**Rollback (keine Datenbereinigung nötig):**

1. `PORTFOLIO_VOL_TARGETING_MODE=off` (oder `monitor`) + Restart — der
   Faktor wird sofort zurückgenommen (Monitor: `applyVolatilityTargeting(null)`;
   `off`: vor jedem Lauf). Bestehende Snapshots bleiben als
   Monitoring-Historie lesbar.
2. Reversible Bereinigung (nur wenn kein v1.67.0-Code mehr läuft):
   `DROP TABLE IF EXISTS "volatility_targeting_snapshots" CASCADE;`
   `risk_config`-Keys `vtp.*` optional per `DELETE`.

## 11. Test-Matrix (Nachweis)

| Pflicht | Test-Datei |
| --- | --- |
| exakte Forecast-Formel (diagonal & korreliert, closed-form) | `tests/portfolio.volatilityTargeting.test.ts` |
| höherer Forecast ⇒ monoton niedrigerer Multiplikator | dito |
| Clamp / Smoothing / Max-Step | dito |
| NaN / singulär / stale / geringe Coverage ⇒ konservativer Fallback | dito |
| Combined-Faktor überschreitet Basis/Ceilings nie | `tests/riskGuard.volTargeting.test.ts` |
| Annualisierung Asset/Timeframe (inkl. 5m-Krypto-Regression) | `tests/portfolio.volatilityTargeting.test.ts` |
| Realisierte Vol + Target-Error | dito |
| Look-ahead/As-of (Future-Event-Zeiten, spätere Kerzen ändern nichts) | dito + `tests/backtest.volatilityTargeting.test.ts` |
| Determinismus + Idempotency-Key | dito |
| Live-Engine: Modi, Fail-closed, Single-Flight, Status | `tests/volatilityTargeting.engine.test.ts` |
| DB: Migration idempotent, Roundtrip, Retry-Idempotenz, CHECKs | `tests/volatilityTargeting.db.test.ts` (embedded Postgres) |
| Backtest: Byte-Identität off, Determinismus, Sizing, kein Look-ahead | `tests/backtest.volatilityTargeting.test.ts` |
| bestehende Regressionen | `npm test` (vollständiger Satz) |

## 12. Offenlegung der Annahmen

1. Log-Returns aus **geschlossenen** Kerzen; offene Kerzen werden nie
   verwendet (kein Look-ahead, keine Intraday-Einstreuung).
2. Zielgewichte = aktuelle Notional-Anteile offener Positionen
   (Long-only Total-Exposure, Shorts per Absolutbetrag — konservativ).
3. Shrinkage ist konstant (kein adaptiver Schätzer); Ridge 1e-6 nur als
   PSD-Sicherheitsnetz.
4. Die Backtest-Engine kennt keine Asset-Klassenzuordnung ⇒ einheitliche
   Annualisierung je Lauf (Dokumentation §6).
5. Minuten-basierte Idempotenz: ein forced Retry innerhalb derselben Minute
   übernimmt den bereits persistierten Snapshot (Kein doppeltes Schreiben);
   der RAM-Faktor kann sich durch die Max-Step-Kettung davon unterscheiden
   (bewusste, dokumentierte Abstufung).
