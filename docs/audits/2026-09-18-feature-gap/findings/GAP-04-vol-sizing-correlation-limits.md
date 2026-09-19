# GAP-04 — Volatilitätsbasiertes Position-Sizing + Korrelations-Exposure-Limits

**Nutzen:** ★★★★★ · **Aufwand (Co-Audit):** 🔧🔧🔧 · **Aufwand (verifiziert):** 🔧🔧🔧
**Kategorie:** Rendite/Risiko · **Prompt:** [`PROMPT-04`](../prompts/PROMPT-04-vol-sizing-correlation-limits.md)

## Befund (Co-Audit)

Größter Einzelhebel auf risikoadjustierte Rendite; verhindert, dass 5
„unabhängige“ Trades in Wahrheit ein BTC-Beta-Trade sind. Vol-Schätzer
versagen bei Regime-Brüchen → Fail-closed nötig.

## Verifizierter Ist-Stand (2026-09-18, v1.40.0)

- `src/portfolio/correlation.ts`: Pearson/Spearman, `correlationMatrix`,
  `covarianceMatrix`, `correlationClusters`, `clusterAnalysis` — inklusive
  Tests; `/api/portfolio/correlation` exponiert die Matrix.
- `riskGuard` begrenzt `maxPositionPct` **fix** (LIMIT_CEILINGS-Konvention);
  `adaptiveRisk` skaliert per Vol-Regime. **Aber:** kein ATR-basiertes Sizing,
  kein Fractional-Kelly-Deckel, Cluster-Mathematik ist **nicht** als
  Guardrail verdrahtet (keine Cluster-Exposure-Ablehnung im Order-Pfad).

## Delta

1. ATR-/Vol-basiertes Sizing (Risiko-Budget / ATR-Distanz → qty) mit
   Fractional-Kelly als Obergrenze; alles an `LIMIT_CEILINGS` geklemmt;
   ATR nicht verfügbar → konservative Fallback-Größe (UNKNOWN-Muster wie
   adaptiveRisk v1.36.21).
2. Cluster-Exposure-Guardrail (Schicht 3, `riskGuard`): max. Cluster,
   max. Positionen je Cluster, Korrelationsschwelle; maschinenlesbarer
   Ablehnungsgrund `cluster-exposure:…`; Audit-Eintrag.
3. Korrelations-Cache mit TTL + Stale-Policy (alte Daten → konservativ
   ablehnen, nicht raten).

## Akzeptanzkriterien (kurz)

Sizing-Mathe-Tests, Clamp-Tests, Cluster-Ablehnungstest, Stale-Policy-Test,
keine neuen Runtime-Dependencies.

## Umsetzung (v1.48.0, 2026-09-19, Branch `arena/01a0b953-ai-trading-firm`)

**D1 — ATR-/Vol-Sizing** (`src/lib/positionSizing.ts`):
Reine Funktion `computePositionSize()` mit
`qty = (equity · riskPerTradePct) / |entry − stop|`; Stop-Auflösung
EXPLICIT → ATR-Fallback (`RISK_ATR_STOP_MULT`, Default 2, Bounds [0.5, 6]) →
UNKNOWN-Fallback auf die Basis-Größe (`defaultStopLossPct`) mit Kennzeichnung
`unknown = true` + Audit-Notiz (Muster adaptiveRisk v1.36.21; kein Block,
kein stiller Wert). Fractional-Kelly-Deckel
(`RISK_KELLY_FRACTION`, Default 0 = aus, Bounds [0, 1]):
`maxNotional = equity · fraction · f*` mit `f* = (b·p − (1−p))/b` aus
Trefferquote/Payoff des Trade-Journals (GAP-03, Mindest-Stichprobe
`JOURNAL_MIN_TRADES`); ohne verfügbare Statistiken **wirkungslos**
(dokumentiert, kein stiller Zwangswert), `f* ≤ 0` → keine Größe
(`kelly:no-positive-edge`). Ergebnis immer an die bestehenden Grenzen
geklemmt (maxRiskPerTrade vor der Formel, maxPositionPct/Missions-Cap
danach) — Sizing verschärft, lockert nie; `equity`/`entry ≤ 0` →
`RiskValidationError`. Verdrahtet in `src/lib/engine.ts` +
`src/lib/microExecutor.ts` (beide Order-Pfade); mit Defaults byte-identische
Notional-Werte wie vorher, nur 0-Stop-Regeln erhalten jetzt einen echten
ATR-Fallback-Stop statt eines Stops am Entry. `atr()` (absolute, in
Preiseinheiten) neu in `src/lib/indicators.ts`.

**D2 — Cluster-Exposure-Guardrail (Schicht 3)**
(`src/lib/clusterExposure.ts`):
`correlationMatrix` + `correlationClusters` **aus `src/portfolio`
importiert** (Wiederverwendung, keine Duplikation); log-Renditen über
gemeinsame Zeitstempel aus dem lokalen HistoricalStore (1h-Reihe, Fenster
`RISK_CORR_WINDOW_CANDLES` 90, Bounds [30, 365]); Single-Linkage
`|ρ| ≥ RISK_CORR_THRESHOLD` (0.7, Bounds [0.3, 0.99]);
`RISK_MAX_PER_CLUSTER` (3, Bounds [1, 10]) offene Positionen je Cluster →
`cluster-exposure:max-per-cluster:N`. Berechnung nur je Order-Prüfung mit
TTL-Cache (`RISK_CORR_CACHE_TTL_MS` 900000, Bounds [60000, 3600000];
Key = Symbol-Menge + Fenster + Schwelle) — kein Hintergrund-Job.
**Stale-Policy fail-closed:** keine/zu alten Kerzen (> 24 h), < 20 gemeinsame
Renditen oder nicht auflösbares Symbol → enforce lehnt ab
(`cluster-exposure:correlation-stale`), statt zu raten; keine offenen
Positionen → keine Prüfung (immer erlaubt).
`RISK_CLUSTER_LIMITS_MODE`: **monitor (Default)** = Entscheidung unverändert,
Würde-Prüfung nur als Audit-Notiz + Log (`CLUSTER_EXPOSURE_MONITOR`,
`wouldBlock: true`); **enforce** = echte Ablehnung
(`CLUSTER_EXPOSURE_BLOCKED`). Unbekannter Wert → monitor + Warnung.
Je Guardrail-Entscheidung revisionssicherer audit_log-Eintrag
(security-Klasse, at-least-once via auditSink).

**D3 — Transparenz:** `GET /api/firm/risk` zeigt effektive Sizing- und
Cluster-Parameter (inkl. Bounds), Kelly-Edge-Status (`off`/`ok`/
`unavailable` + Statistik), Korrelations-Cache, offene Positionen, aktuelle
Cluster und die UNKNOWN-Zustände (`unknown.correlationUnavailable`).

**Tests:** `tests/positionSizing.test.ts` (14: Sizing-Mathe Standard/Short,
ATR-Fallback, Kelly nur mit Statistiken, Clamp an LIMIT_CEILINGS,
UNKNOWN-Pfad, Determinismus), `tests/riskGuard.cluster.test.ts`
(14: enforce-Ablehnung, monitor ändert Entscheidung nicht, stale →
konservative Ablehnung, Cache-TTL mit Fake-Clock, Schwelle-Grenzfälle
0.699 vs 0.7, Single-Linkage-Kette, Bounds-Parsing). Bestehende
riskGuard-/portfolio-/microExecutor-/indicators-Tests unverändert grün.

**Abweichungen vom Prompt (dokumentiert):**
- Kelly-Edge-Quelle: Trade-Journal (GAP-03 bereits umgesetzt) —
  `ruleExecutions` als Fallback-Quelle ist dokumentiert, aber ohne Wirkung,
  weil die Tabelle kein P&L trägt (kein Payoff möglich).
- Kerzen-Quelle für Korrelationen: HistoricalStore (`data/history`, 1h)
  statt `getCandles` (Venue-REST) — lokal, deterministisch, kein Netzwerk im
  Order-Pfad; leere Historie wird fail-closed als stale gewertet (enforce
  blockt dann Aufstockungen — siehe HANDBUCH §9.5, `npm run market:sync`
  hält den Store frisch).
- Keine Schema-Änderung, keine neuen Runtime-Dependencies.

## Nachtrag (v1.51.1, 2026-09-19, PR [#146](https://github.com/Kryschuuu/ai-trading-firm/pull/146)) — Audit-Katalog

**Befund des Status-Reviews** ([`../remediation/STATUS-REVIEW-2026-09-19.md`](../remediation/STATUS-REVIEW-2026-09-19.md)):
Die vier mit v1.48.0 eingeführten Audit-Events hatten **keinen Eintrag** im
`AUDIT_EVENT_CATALOG` (`src/lib/auditView.ts`):

| Event | Schreibpfad | Wirkung der Lücke |
|-------|-------------|-------------------|
| `POSITION_SIZING` | `src/lib/engine.ts` (`logAudit`) | Katalog-Wächter `tests/auditView.test.ts` **rot auf `main`** seit PR #142 |
| `POSITION_SIZING_UNKNOWN` | `src/lib/microExecutor.ts` (`ruleAudit`) | dito |
| `CLUSTER_EXPOSURE_MONITOR` | `src/lib/clusterExposure.ts` (`auditWrite(event, …)`) | vom Wächter-Regex nicht erfasst (Variable statt Literal), aber ebenso unbeschrieben |
| `CLUSTER_EXPOSURE_BLOCKED` | dito | dito |

Im Audit-Viewer fielen alle vier auf den `UNKNOWN_EVENT_SPEC`-Fallback zurück —
die Guardrail-Entscheidungen, die R6 „revisionssicher“ verlangt, waren für
Menschen ohne Label, Kategorie und Erklärung. Ursache: PR #142 hatte `npm test`
nicht ausgeführt („läuft in der CI“) — die CI führt die Suite aber nicht aus;
PRs #143/#145 haben den Failure regelkonform (R11) nur notiert.

**Fix (v1.51.1):** Vier Katalog-Einträge (Kategorie `risk`, erwartete Stufe
`WARN`) mit Headline/Erklärung/Fakten — Sizing: Instrument, Code
`sizing:atr-unknown:SYMBOL`, Notiz (+ Regel-ID); Cluster-Exposure: Urteil
VIOLATION/STALE, Code, Würde-blockieren-Flag, offene Positionen, Cluster +
Zählung gegen `RISK_MAX_PER_CLUSTER`, Schwelle/Fenster, Datenstand
(fehlend ⇒ „fail-closed“). Render-Test „GAP-04-Events (v1.51.1-Nachtrag)“ in
`tests/auditView.test.ts` (26/26 grün). Status in
[`../remediation/TRACKING.md`](../remediation/TRACKING.md): **FIXED**.
