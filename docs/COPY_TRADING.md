# Copy-Trading — Domänenmodell, Policy & Order-Links

**Phase 7 · Pakete 07-01/07-02 · Findings STX-09, STX-16**

Copy Trading kopiert eine normalisierte **Handlungsabsicht**, keine Leader-Order
1:1. Das Modul berechnet daraus einen Follower-Intent, begrenzt ihn vor der
Ausführung mit einer versionierten Policy und speichert eine idempotente
Zuordnung zum bestehenden Follower-Pfad.

> **Sicherheitsgrenze (STX-16):** Copy-Abonnements sind in der Datenbank
> `SIMULATE_ONLY` und standardmäßig deaktiviert (`enabled = false`). Es gibt
> keinen Env-Schalter zum Aufheben des Modus und keinen Live-Order-Pfad in
> `src/copy/`. Die DB-CHECK-Constraint bleibt auch dann wirksam, wenn ein
> Aufrufer einen anderen Modus sendet.

## Module (`src/copy/`)

| Datei | Zweck | IO |
| --- | --- | --- |
| `types.ts` | Copy-Modell, Handlungsabsicht, Sizing-/Hebeltypen | nein |
| `mapping.ts` | Venue-übergreifende Symbol-ID, SSoT-gestützt | nein |
| `sizing.ts` | `FIXED_AMOUNT`, `FIXED_RATIO`, `EQUITY_RATIO`, Hebel-Policy | nein |
| `config.ts` | Validierung, Limits, content-versionierte Policy-Konfiguration | nein |
| `policy.ts` | Reine, fail-closed `evaluatePolicy()`-Entscheidung | nein |
| `store.ts` | `copy_order_links` anlegen und Status vorwärts fortschreiben | PostgreSQL, Audit, Telemetrie |
| `index.ts` | Barrel und Modulgrenzen | — |

## Policy — vor dem Submit

`loadCopyPolicyConfig(policyJson, policyVersion)` validiert die Konfiguration
und prüft die gespeicherte `policy_version` gegen den SHA-256-Inhaltshash
(`cpl1:<sha256>`). Die aktive Code-Default-Policy ist selbst versioniert;
Abweichende JSON-Werte ohne passende Version werden nicht still akzeptiert.

`evaluatePolicy(intent, policy, context)` gibt ausschließlich `allowed: true`
oder eine geschlossene Ablehnung zurück. Eine ungültige Policy, ein fehlender
Pflichtwert oder ein Laufzeitfehler ergibt `HALTED`.

| Feld | Default | harte Obergrenze / Herkunft |
| --- | ---: | --- |
| `maxNotionalPerEvent` | 1 000 | `LIMIT_CEILINGS.maxNotionalPerOrder[1]` (1 000 000) |
| `maxNotionalPerDay` | 5 000 | höchstens die harte Einzelorder-Obergrenze (strenger als wiederholte Orders) |
| `maxSlippageBps` | 10 bp | Copy-spezifisches Maximum 20 bp; `riskGuard` hat kein Slippage-Bps-Feld |
| `maxOpenPositions` | 3 | `LIMIT_CEILINGS.maxConcurrentPositions[1]` (10) |
| `maxLossPerDayPct` | 0,02 | Anteil des Start-Equity; höchstens `LIMIT_CEILINGS.dailyLossLimitPct[1]` (0,25) |
| `maxLeverage` | 1× | `LIMIT_CEILINGS.maxLeverage[1]` (3×) |
| `halted` | `false` | unabhängiger Kill-Switch; `true` blockiert immer |

Die Copy-Policy kann die Broker-/Risk-Guardrails somit nur **verschärfen**,
niemals aufweiten. `maxOpenPositions` muss ganzzahlig sein. Ein einzelnes
Event-Limit darf das Tageslimit nicht überschreiten.

`maxSlippageBps` wird **vor** dem Submit mit dem erwarteten Spread verglichen,
nicht mit einem Fill:

- `RuleSnapshot.spreadPct`: Prozentwert, z. B. `0.04` = 0,04 % = 4 bp; die
  Umrechnung ist `spreadPct × 100`.
- Scanner-`spread`: rohe relative Spanne, z. B. `0.0004` = 4 bp; die
  Umrechnung ist `spread × 10 000`.
- Fehlt eine belastbare Spread-Beobachtung, wird fail-closed mit
  `MAX_SLIPPAGE` abgelehnt. Sind beide Quellen vorhanden, gilt konservativ der
  größere Wert.

`observedDeviationBps` in `copy_order_links` wird **nach** dem Fill als Messwert
persistiert. Es ist weder ein Gate noch ein Trigger für Cancel oder Status-
Rückstufung. Execution-Quality kann diese Messung nutzen, um **künftige**
Entscheidungen zu drosseln; ein ausgeführter Fill wird nicht nachträglich
„storniert“.

Entscheidungscodes: `HALTED`, `MAX_EVENT_NOTIONAL`, `MAX_DAY_NOTIONAL`,
`MAX_SLIPPAGE`, `MAX_POSITIONS`, `MAX_DAILY_LOSS`, `MAX_LEVERAGE`, `NO_MAPPING`.
Die Metriken verwenden ausschließlich geschlossene Ergebnis-/Zustandslabels,
keine Konten-, Event-, Intent- oder Instrument-IDs.

## Schema und Idempotenz

Migration: [`../drizzle/2026-10-03_copy_subscriptions.sql`](../drizzle/2026-10-03_copy_subscriptions.sql)
(nach der Migration für `execution_quality_intents` anwenden). Sie legt genau
zwei Tabellen an:

- **`copy_subscriptions`** — Leader/Follower-Zuordnung, nullable
  `follower_instrument_id` bis das Mapping abgeschlossen ist, Sizing,
  versionierte `policy_json` + `policy_version`. Der Modus-CHECK erlaubt exakt
  `SIMULATE_ONLY`; `enabled` ist `false`.
- **`copy_order_links`** — Link von `leader_event_id` auf eine stabile
  `follower_intent_id`, optionaler FK auf den bestehenden
  `execution_quality_intents`-Datensatz, Zustandsprojektion und optionale
  Fill-Abweichungsmessung. Beide verlangten Eindeutigkeiten gelten:
  `(leader_event_id, follower_intent_id)` und `follower_intent_id`.

**FK-Typ-Hinweis:** Der Auftrag nennt `execution_quality_intent_id uuid`, die
bestehende Tabelle `execution_quality_intents` hat in diesem Repository aber
`id text` (der echte Schlüssel wird als `eq-…` gebildet). PostgreSQL kann keine
UUID-Spalte als FK auf diese TEXT-Spalte binden. Deshalb ist die FK-Spalte
korrekt als `text REFERENCES execution_quality_intents(id)` modelliert; die
bestehende Execution-Quality-Tabelle bleibt unverändert.

`createIntent()` legt nur den Link `PENDING` an — keine eigene Intent-Tabelle.
Wiederholungen mit derselben stabilen `follower_intent_id` liefern den
bestehenden Datensatz zurück. Der Aufrufer muss diese ID deterministisch aus
Leader-Event und Follower-Zuordnung bilden; ein neues Intent pro Retry wäre
kein Idempotenz-Retry. Der FK auf Execution-Quality wird nur gesetzt, wenn der
bestehende Intent bereits identifiziert ist.

`store.ts` serialisiert konkurrierende Statuswechsel per Zeilensperre. Erlaubte
Kanten:

```text
PENDING → SENT → PARTIAL → FILLED
   ├──────────────→ FAILED
   └──────────────→ DIVERGED (terminal)
SENT → FILLED | FAILED | DIVERGED
PARTIAL → FILLED | FAILED | DIVERGED
```

`FILLED`, `FAILED` und `DIVERGED` sind terminal. Ein erneutes `markFilled()`
bei `FILLED` ist ein echter No-Op: weder Zeitstempel noch Fill-Messung werden
überschrieben. Ein verspätetes `markSent()` nach `PARTIAL` kann den Zustand
nicht zurücksetzen. `markFailed()` speichert einen `PolicyCode` nur bei einer
Policy-Ablehnung; andere Fehler können ohne Code protokolliert werden.

**Minimalität:** keine `copy_trade_events` (Leader-Ereignisse sind Quellereignisse),
keine `copy_positions` (Projektion aus `positions`), keine
`copy_risk_limits` (in `policy_json`), und keine eigene Intent-/Receipt-Tabelle.

## Abgrenzung zu Execution-Quality und Reconciliation (STX-09)

Der Copy-Store ist **kein Reconciler**. Der bestehende Follower-Pfad erzeugt
`execution_quality_intents`; die Order-/Fill-Evidenz und der Read-only-Abgleich
bleiben bei [`src/executionQuality/`](../src/executionQuality/README.md) und
[`src/brokers/reconciliation.ts`](../src/brokers/reconciliation.ts). `copy_order_links`
enthält nur den FK-Verweis auf diese vorhandene Quelle und die notwendige
Idempotenz-/Statusklammer. Es entsteht keine zweite Intent-, Receipt- oder
Reconciliation-Pipeline.

## Tests und Betrieb

- `tests/copy.domain.test.ts` — bestehendes reines Mapping-/Sizing-Modell.
- `tests/copy.policy.test.ts` — Policy-Version, Grenzen, Spread-Umrechnung,
  Kill-Switch und fail-closed Negativpfade.
- `tests/copy.db.test.ts` — Migration, DB-CHECKs, konkurrierende Idempotenz,
  FK, vorwärts gerichtete Übergänge, terminale Zustände und Fill-No-Op.
- Migration wiederholt ausführen ist idempotent. Rollback nach Export/Stop:
  `DROP TABLE copy_order_links; DROP TABLE copy_subscriptions;`.

Es gibt in diesem Schritt keinen Leader-/Follower-Adapter (07-03), keinen
Reconciler, keinen Slippage-Cancel, keine neue Umgebungsvariable und keinen
Live-Pfad. `SIMULATE_ONLY` kann weder durch Policy-JSON noch durch ein Flag
aufgehoben werden.
