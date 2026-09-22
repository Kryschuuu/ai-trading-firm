# Hysteretisches Drawdown-Risk-Scaling (RMA-P5-04, v1.68.0)

Autoritative Vertrauensskalierung: Die **reconcilte Equity** wird gegen den
**persistierten High-Water-Mark (HWM)** bewertet; aus dem Drawdown folgt über
eine versionierte, monoton nicht-steigende Kurve ein Risikofaktor, der das
Risikobudget `maxRiskPerTrade` multiplikativ **nur senkend** skaliert (Faktor
hart ≤ 1). Degradation wirkt sofort, Erholung nur nach Cooldown **und**
bestätigter Erholung — das verhindert Flapping um die Schwellen. Optional
blockiert die Stufe **PAUSE** neue Einstiege vollständig (Veto, kein
Multiplikator).

- Finding: [`docs/audits/2026-09-20-roadmap-audit/findings/RMA-P5-04-drawdown-scaling.md`](audits/2026-09-20-roadmap-audit/findings/RMA-P5-04-drawdown-scaling.md)
- Kern (pure, deterministisch, uhrfrei): `src/portfolio/drawdownScaling.ts`
- Live-Orchestrator: `src/lib/drawdownScaling.ts`
- Risk-Guard-Composition: `src/lib/riskGuard.ts` (`applyDrawdownScaling`, `drawdownPauseState`, `combinedMarketFactor`)
- Persistenz: `drawdown_scaling_snapshots` (`drizzle/2026-09-22_drawdown_scaling.sql`)
- API: `GET /api/firm/risk/drawdown-scaling` (Status), `POST` (Forced-Update), `GET /api/firm/risk/volatility` und `GET /api/firm/risk` (erweitert)

---

## 1. Ziel & Grenzen

**Ziel:** Ein Konto, das von seinem Höchststand zurückfällt, soll sein
Risikobudget automatisch reduzieren — proportional zum Drawdown, mit
Hysterese statt Flapping und ohne dass Ein-/Auszahlungen die Performance
verfälschen.

**Ausdrücklich NICHT Bestandteil (Scope-Grenzen):**

- Kein automatischer Kapitaltransfer (kein Nachschuss, keine Glattstellung).
- Kein HWM-Reset durch Deployment/Neustart — der HWM kommt aus der DB.
- Kein Ersatz für Kill-Switches (`maxEquityDrawdownPct`, `dailyLossLimitPct`)
  oder Authority-Chains: das Drawdown-Scaling wirkt **innerhalb** der
  bestehenden Sandbox, die Not-Halt-Instanzen bleiben unverändert und greifen
  weiterhin zusätzlich.
- Keine risikosteigernde Wirkung: Der Faktor ist hart ≤ 1; die Schwellen
  liegen bewusst **unter** dem Kill-Switch-Default (15 %), damit die
  Entschärfung vor dem Not-Halt greift.

## 2. Betriebsmodi (Feature-Flag `DRAWDOWN_SCALING_MODE`)

| Modus | Bewertung + Persistenz | Ordergrößenwirkung | PAUSE | Verwendung |
| --- | --- | --- | --- | --- |
| `monitor` (Default) | Ja | **Nein** | Nein | Rollout-Start; Beobachtung von Stufe/Faktor ohne Eingriff |
| `active` | Ja | **Ja** (Faktor ≤ 1 auf `maxRiskPerTrade`) | **Ja** (blockiert neue Einstiege) | Begrenzte Anwendung nach Monitoring-Phase |
| `off` | Nein | Faktor wird zurückgenommen (Rollback) | wird aufgehoben | Sofort-Abschaltung |

Zusätzlich `dsp.enabled` in `risk_config` (Master-Schalter, Default 1).
Unbekannte Werte fallen auf `monitor` zurück (kein Stillversagen).

**Rollout-Pfad:** `monitor` (Default) beobachten (Stufe, Faktor, Grund-Codes,
Reconciliation-Gate) → `active` → bei Problemen sofort `monitor`/`off`
(keine Datenbereinigung nötig, Zeilen bleiben lesbar).

## 3. Policy-Kurve (versioniert, monoton)

Konfiguration in Prozent-Punkten (Default):

| Feld | Default | Fenster | Bedeutung |
| --- | --- | --- | --- |
| `softThresholdPct` | 5 | 0.1 … 50 | Ab hier beginnt die Reduktion |
| `hardThresholdPct` | 12 | 1 … 80 | Hier ist der Bodenfaktor erreicht |
| `minFactor` | 0.25 | 0.05 … 1 | Untergrenze des Faktors |
| `pauseThresholdPct` | 0 (aus) | 0 … 100 | Ab hier Stufe PAUSE (≥ Hard-Schwelle normalisiert) |

Kurve mit `dd ∈ [0, 1]`, `s = soft/100`, `h = hard/100`:

```
f(dd) = 1                                        für dd ≤ s
f(dd) = 1 − (1 − minFactor)·(dd − s)/(h − s)     für s < dd < h
f(dd) = minFactor                                für dd ≥ h
```

Eigenschaften (getestet): monoton **nicht-steigend**, stetig an beiden
Schwellen, beschränkt auf `[minFactor, 1]`, unendliche/`NaN`-Eingaben ⇒
`minFactor` (fail-closed, nicht neutral). Stufen: `NORMAL` (≤ soft), `SOFT`
(dazwischen), `DEEP` (≥ hard), `PAUSE` (≥ `pauseThresholdPct`, nur wenn > 0).

**Versionierung:** Jede Policy hat eine Fingerprint-Version
`ddp1:<sha256>` über die geklemmten, wirksamen Werte (Betriebsmodus
ausgenommen: er ist Deployment-, keine Policy-Eigenschaft). Jede
Persistenz-Zeile trägt die Version, mit der sie bewertet wurde —
Policyänderungen legen **neue** Zeilen an und interpretieren Historie nie um.

## 4. Hysterese (Degradation sofort, Recovery bestätigt)

| Richtung | Regel |
| --- | --- |
| **Degradation** | Sofort im selben Bewertungsschritt auf den Kurvenwert (auch über die harte Schwelle hinweg) — die sichere Richtung wartet nie. Setzt `lastDegradeAt` und die Bestätigungszählung (`recoveryStreak = 0`). |
| **Erholung** | Nur wenn (a) der Cooldown `recoveryCooldownMs` (Default 6 h) seit der letzten Degradation vollständig abgelaufen ist **und** (b) `recoveryConfirmations` (Default 3) aufeinanderfolgende Erholungsbewertungen **nach** dem Cooldown vorliegen. Bewertungen *während* des Cooldowns zählen nicht. Pro bestätigtem Schritt maximal `recoveryStep` (Default 0.05) **und** höchstens bis zum Kurvenwert. |
| **Unterbrechung** | Kehrt der Drawdown zurück oder fällt die Equity unter den HWM-Stand zurück (Ziel = Vorstufe), beginnt die Zählung von vorn. |

Damit ist die Erholung garantiert **mindestens so konservativ wie die
Degradation** (Zeit + Anzahl + Schrittgröße) und ein Flapping um die Schwellen
ist ausgeschlossen.

## 5. Equityquelle, Zeitsemantik, Cashflows

**Autoritative Equity (Reihenfolge):**

1. jüngster `equity_snapshots`-Eintrag (`db-snapshot:<trigger>`, wird vom
   Monitor/Engine bei Tick/Trade geschrieben — überlebt Neustarts),
2. Fallback Paper-Ledger im Prozess (`state.paperBrokerLedger`, frische
   Installation ohne DB-Snapshot),
3. sonst `unavailable` ⇒ **fail-closed** (`NO_EQUITY` ⇒ `minFactor`), nie
   eine stille 0.

**Reconciliation-Gate:** Ist `dsp.requireReconciliation = 1` (Default), muss
ein letzter Reconciliation-Bericht existieren (`RECONCILIATION_MISSING`),
ohne kritische Diskrepanz sein (`RECONCILIATION_FAILED`) und jünger als
`reconciliationMaxAgeMinutes` (Default 360) sein (`RECONCILIATION_STALE`) —
sonst gilt der konservative Faktor.

**Zeitsemantik (drei getrennte Achsen, kein Look-ahead):**

| Achse | Quelle | Regel |
| --- | --- | --- |
| `equityAvailableAt` | Snapshot-Zeit `ts` | nie in der Zukunft (`FUTURE_EQUITY`), jünger als `maxEquityStalenessMinutes` (Default 15) sonst `STALE_EQUITY` |
| `asOf` | Monitor-Tick | Entscheidungszeitpunkt |
| `computedAt` | Tick | immer ≥ `asOf` (DB-CHECK) |

**Cashflow-Behandlung (Ein-/Auszahlungen sind keine Performance):** Aus
Equity-Δ und Trading-PnL-Δ (realisiert + unrealisiert) wird das Residuum
gebildet; liegt es außerhalb der Toleranz
(`max(cashflowToleranceAbs, cashflowTolerancePct·equity)`, Default 0.05 bzw.
0.1 %), gilt es als **externer Netto-Cashflow** und wird als
`cumulativeNetFlow` geführt. Der HWM wird auf der **cashflow-bereinigten**
Equity (`equity − cumulativeNetFlow`) gebildet: eine Einzahlung hebt ihn
nicht, eine Auszahlung erzeugt keinen Drawdown. Ohne verifizierbare
Attribution (fehlende/`null`-PnL oder zu alte Vorbewertung) wird **nichts**
neutralisiert — ein nicht erkannter Zufluss erhöht dann den HWM und wirkt
ausschließlich risikosenkend (konservativer Bias statt Raten).

## 6. Fail-closed-Matrix

| Situation | Status | Faktor | `drawdownPct` |
| --- | --- | --- | --- |
| keine/`NaN` Equity | `CONSERVATIVE` (`NO_EQUITY`) | `minFactor` | `null` |
| Equity ≤ 0 | `CONSERVATIVE` (`INVALID_EQUITY`) | `minFactor` | `null` |
| Equity-Zeit fehlt | `CONSERVATIVE` (`NO_EQUITY`) | `minFactor` | `null` |
| Equity-Zeit in der Zukunft | `CONSERVATIVE` (`FUTURE_EQUITY`) | `minFactor` | `null` |
| Equity älter als Staleness | `CONSERVATIVE` (`STALE_EQUITY`) | `minFactor` | `null` |
| Reconciliation fehlt/kritisch/stale | `CONSERVATIVE` (`RECONCILIATION_*`) | `minFactor` | `null` |
| erste Bewertung | `BOOTSTRAP` | Kurvenwert | gemessen |
| normaler Lauf | `OK` | Hysterese | gemessen |

`unbekannt ≠ 0`: In allen `CONSERVATIVE`-Fällen bleibt `drawdownPct` `null` und
`hwm` erhalten; der HWM wird nie gelöscht oder zurückgesetzt. Die
`CONSERVATIVE`-Stufe behauptet **keine** PAUSE (kein Dauerblock ohne Messung),
blockiert also nicht dauerhaft — sie senkt nur das Budget auf den Boden.

## 7. Persistenz & Idempotenz

`drawdown_scaling_snapshots` (append-only, eine Zeile je Bewertung):

- **Idempotency-Key** `snapshot_id = dsc1:<sha256>` über
  `(Minute(computedAt) | policyVersion | dataHash)`, UNIQUE +
  `ON CONFLICT DO NOTHING` — Retry/Restart in derselben Minute mit identischer
  Eingabe ⇒ keine doppelte Zeile.
- **Reproduktions-Hashes:** `policy_version = ddp1:<sha256>` (Policy) und
  `data_hash = dd1:<sha256>` (Beobachtung inkl. Zeitachsen, Konfiguration).
- Persistiert werden: Modus, Status, Reason-Code/-Text, Equity +
  Verfügbarkeitszeit, cashflow-bereinigte Equity, HWM, Drawdown, Ziel- und
  angewendeter Faktor (Vorstufe), Stufe + PAUSE, Transition, Cashflow
  (erkannt/kumuliert/verification), Reconciliation-Zeit/-Status/-Alter,
  Equity-Quelle/-Alter sowie die **Zustandsprojektion** (`last_equity`,
  `last_observation_at`, `last_trading_pnl`, `last_degrade_at`,
  `last_transition_at`, `recovery_streak`, `stage`, `policy_version`).
- **Neustart-Rekonstruktion:** Der Prozess liest die jüngste Zeile
  (`readPersistedDrawdownScalingState`) und rekonstruiert daraus HWM, Faktor,
  Cashflow-Basis, Cooldown-Basis und Stufe — ein Deployment setzt den
  High-Water-Mark **nicht** zurück. Die Zustandsprojektion ist bewusst
  getrennt von der Beobachtung: eine `CONSERVATIVE`-Zeile verändert die
  Cashflow-Basis nicht.
- **Aktivwerte** zusätzlich in `risk_config` (`dsp.activeFactor`,
  `dsp.activeAt` Epoche-Sekunden, `dsp.pause`) — nur im `active`-Modus, damit
  der **separate Mikro-Executor-Prozess** (ohne Marktzugriff) die Reduktion
  übernehmen kann. Er wendet sie nur an, wenn sein eigener Modus `active` und
  der Faktor jünger als `ADAPTIVE_STATE_MAX_AGE_MS` ist; sonst hebt er die
  Reduktion auf. Beim Wechsel auf `monitor`/`off` wird `dsp.pause` sofort
  zurückgeschrieben (ein Block überlebt den Zustand, der ihn erzeugt hat,
  nie).
- DB-CHECKs erzwingen die Invarianten: `mode ∈ {monitor, active}`,
  `status ∈ {BOOTSTRAP, OK, CONSERVATIVE}`,
  `stage/transition/cashflow_verification`-Enums, `applied_factor ∈ (0,1]`,
  `prev_factor ∈ (0,1]`, `target/drawdown ∈ [0,1]` (oder NULL),
  `computed_at ≥ as_of`, `paused = (stage = 'PAUSE')`, Hash-Regexe,
  `recovery_streak ≥ 0`.

## 8. Observability

- **API:** `GET /api/firm/risk/drawdown-scaling` — Modus, Stufe, Status,
  Reason-Code/-Text, Equity, HWM, Drawdown, Faktor (Ziel/vorherig/angewendet),
  Cashflow-Attribution, Policyversion, Transition, Freshness,
  Reconciliation-Gate, Konfiguration + Bounds sowie
  `riskBudget { base, effective }` (`firm.read`); `POST` (mit `firm.write`)
  erzwingt einen Lauf. `GET /api/firm/risk/volatility` trägt zusätzlich
  `drawdownScaling: <status|null>`.
- **Monitor-Tick:** `updateDrawdownScaling()` läuft vor `getLimits()` im
  Tick (Min-Interval 60 s, Single-Flight; Fehler landen in
  `TickResult.errors`/Status, brechen den Tick nie ab), Ergebnis zusätzlich in
  `TickResult.drawdownScaling`.
- **Metriken (bounded, keine Instrument-/Order-/Trade-IDs als Labels):**
  `telemetry.drawdownScaling.updates{result,mode}`,
  `transitions{transition,stage}`,
  `conservative{reason}`,
  `snapshots{result: written|duplicate|failed}`.
- **Audit:** `RISK_DRAWDOWN_SCALING` (INFO; Degradation/`CONSERVATIVE` als
  WARN + `auditClass: "security"`) mit Equity-Snapshot, HWM, Drawdown,
  alter/neuer Stufe, Transition, Cashflow-Attribution, Policyversion und
  Grund — jede Faktoränderung ist ohne Rekonstruktion nachvollziehbar.
  Renderer: `src/lib/auditView.ts` (`RISK_DRAWDOWN_SCALING`).
- **Kaskaden-Status:** `GET /api/firm/risk` meldet je Faktor
  `volTargetFactor`, `drawdownFactor`, `drawdownStage`, `drawdownPaused` und
  `drawdownPolicyVersion` neben Basis- und wirksamem Limit — jede
  Sizingentscheidung kann den angewendeten Drawdown-Faktor referenzieren.

## 9. Composition (Authority Chain)

```
Code-Ceilings → Basis-Limit (risk_config)
  → Regime-Faktor × VolTarget-Faktor × Drawdown-Faktor
  → Code-Boden (LIMIT_CEILINGS.maxRiskPerTrade[0]);  PAUSE blockiert ganz
```

- Multiplikativ, jeder Faktor hart auf (0, 1] geklemmt ⇒ das Produkt ist ≤ 1
  (getestet, inkl. Reihenfolge-Symmetrie und Boden).
- `recomputeCurrent()` rechnet **immer** aus dem frischen Basiswert: neue
  Faktoren oder DB-Neuladungen kumulieren nicht.
- Spätere Stufen können eine frühere nie aufweiten; der Boden bleibt das
  Code-Minimum.
- `drawdownPauseState()` liefert `{ blocked, stage, reason }`; `validateOrder`
  nimmt bei `blocked` den stabilen Guardrail
  `drawdown-pause:new-entries-blocked` auf (blockiert **neue** Einstiege;
  Exits laufen über die Schließ-Logik und sind nie blockiert).
- Ein widersprüchlicher Zustand (`paused` ohne Stufe `PAUSE`) wird beim
  Anwenden verworfen und blockiert nie still.

## 10. Migration, Deployment, Rollback

**Migration (append-only, idempotent):**

```
npx drizzle-kit push        # oder: psql "$DATABASE_URL" -f drizzle/2026-09-22_drawdown_scaling.sql
```

Neue Tabelle `drawdown_scaling_snapshots` + UNIQUE/Indizes + 16
CHECK-Constraints. Keine bestehende Tabelle wird verändert, kein Backfill,
keine neuen FKs auf Bestandsdaten. Die Migration ist zweifach ausführbar
(`IF NOT EXISTS` + guarded `ALTER TABLE ... ADD CONSTRAINT`).

**Deployment:** `git pull` → `rm -rf .next node_modules/.cache` → `npm ci` →
`npx drizzle-kit push` → `npm run build` → `systemctl restart ai-trading-firm`.
Der Default-Modus ist `monitor` — nach dem Deploy passiert **nichts** an
Ordergrößen; ein gesetzter HWM/Faktor wird beim ersten Lauf aus der DB
rekonstruiert (kein Bootstrap-Reset).

**Rollback (keine Datenbereinigung nötig):**

1. `DRAWDOWN_SCALING_MODE=monitor` oder `=off` (+ optional `dsp.enabled=0`) +
   Restart — der Faktor wird sofort zurückgenommen, ein PAUSE-Block
   aufgehoben; bestehende Zeilen bleiben als Monitoring-Historie lesbar.
2. Reversible Bereinigung (nur wenn kein v1.68.0-Code mehr läuft):
   `DROP TABLE IF EXISTS "drawdown_scaling_snapshots" CASCADE;`
   `DELETE FROM "risk_config" WHERE "key" LIKE 'dsp.%';`

## 11. Test-Matrix (Nachweis)

| Pflicht | Test-Datei |
| --- | --- |
| wachsender Drawdown erhöht den Faktor nie (Kurve exakt, monoton, stetig) | `tests/portfolio.drawdownScaling.test.ts` |
| Recovery folgt Hysterese/Cooldown (kein Flapping, begrenzte Schritte) | dito |
| Ein-/Auszahlungs-Fixture verfälscht Drawdown/HWM nicht | dito + `tests/drawdownScaling.engine.test.ts` |
| unverifizierte Attribution neutralisiert nicht (konservativer Bias) | `tests/portfolio.drawdownScaling.test.ts` |
| stale/unreconcilede/invalide Equity ⇒ konservativer Faktor | dito + `tests/drawdownScaling.engine.test.ts` |
| Bootstrap + bestehendes Konto (kein Reset durch Deployment) | dito |
| PAUSE-Veto blockiert neue Einstiege, Widerspruch blockiert nie | `tests/riskGuard.drawdownScaling.test.ts` |
| Composition überschreitet Basis/Ceilings nie, Boden hält | dito |
| Determinismus, Policyversion, Idempotency-Key, Zustands-Roundtrip | `tests/portfolio.drawdownScaling.test.ts` |
| Live-Engine: Modi, Fail-closed, Min-Interval, Persistenz-Fail-Safe, Status | `tests/drawdownScaling.engine.test.ts` |
| Neustart rekonstruiert identischen HWM/Faktor (RAM + echter DB-Lesepfad) | dito + `tests/drawdownScaling.db.test.ts` |
| DB: Migration idempotent, Roundtrip, Retry-Idempotenz, CHECKs | `tests/drawdownScaling.db.test.ts` (embedded Postgres) |
| bestehende Regressionen (Risk-Guard, Mikro-Executor, Architektur) | `npm test` (vollständiger Satz) |

## 12. Offenlegung der Annahmen

1. **Cashflow-Attribution ist diskret:** Ein-/Auszahlungen werden aus dem
   Residuum zwischen Equity-Δ und PnL-Δ zwischen zwei Bewertungen erkannt.
   Fallen Transaktion und Performance in dasselbe Intervall oder ist die
   PnL-Messung unvollständig, kann das Residuum ungenau sein — die
   Toleranzen begrenzen den Effekt, und die Richtung bleibt bevorzugt
   risikosenkend (unverifiziert ⇒ keine Neutralisierung).
2. **PnL umfasst alle Positionen:** realisierte PnL geschlossener Positionen
   plus Mark-to-Market offener Positionen (Short invertiert). Fehlt ein
   Kurs, gilt die Attribution als unverifiziert (`null` ≠ 0).
3. **HWM ist ein PnL-Niveau** in Kontowährung (cashflow-bereinigt), kein
   NAV-per-Unit; er wird nie gesenkt und nie durch Deployment zurückgesetzt.
4. **Snapshot-Frequenz** ist der Monitor-Tick (Min-Interval 60 s); innerhalb
   einer Minute ist der Zustand über den Idempotency-Key stabil. Ein
   Zwischenzustand zwischen zwei Ticks ist nicht persistiert.
5. **Der Mikro-Executor** leitet nur `PAUSE`/`NORMAL`/`DEEP` aus den
   persistierten Werten ab (`policyVersion: "persisted"`); die autoritative
   Stufe/Version führt die Hauptprozess-Zeile. Ein DB-Read im heißen Pfad des
   separaten Prozesses ist bewusst vermieden.
6. **Kontowährung:** Alle Beträge sind in der Kontowährung des Brokers
   (Paper: Startkapital `STARTING_EQUITY`); keine FX-Umrechnung.
