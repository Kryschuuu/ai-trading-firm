# Copy-Trading — Domänenmodell, Policy, Order-Links & Copy-Loop

> **Status-Header:** **Bestandsdokument** · **Stand:** nicht datiert · **Code-Version:** v0.17.2 (Beta) · Vollabgleich offen — [DC-06](audits/2026-10-06-docs-code-audit/findings/DC-06-symbol-und-pfad-drift.md)

**Phase 7 · Pakete 07-01/07-02/07-03 · Findings STX-08, STX-09, STX-16**

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
| `leader/bitunix.ts` | Leader-Adapter: Baseline, Frame-Strom, Heartbeat, Normalisierung | Bitunix-WS (nur lesen), Audit, Telemetrie |
| `follower/simulated.ts` | `SIMULATE_ONLY`-Follower auf dem Paper-Ledger | Paper-Ledger, Execution-Quality, Audit |
| `engine.ts` | Orchestrierung, Dedupe, Gates, Latenz-Protokoll | Store, Leader, Follower, Audit, Telemetrie |
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

Zusätzlich kennt die **Engine** (`engine.ts`) Gate-Codes, die keine Zeile in
`copy_order_links` hinterlassen: `NO_BASELINE` (ohne Baseline-Snapshot wird
nichts kopiert), `INVALID_EVENT`, `SIZING_REJECTED`, `FOLLOWER_REJECTED` und
`STORE_ERROR`. Ein `NO_BASELINE` ist bewusst **kein** Policy-Code: es gibt
keinen Intent, der eine Policy verletzen könnte — es gibt schlicht nichts zu
entscheiden. Ein stilles No-Op („ich kopiere den aktuellen Stand") ist
ausgeschlossen.

## Schema und Idempotenz

Migrationen:
[`../drizzle/2026-10-03_copy_subscriptions.sql`](../drizzle/2026-10-03_copy_subscriptions.sql)
(nach der Migration für `execution_quality_intents` anwenden) und
[`../drizzle/2026-10-04_copy_engine_gates.sql`](../drizzle/2026-10-04_copy_engine_gates.sql)
(additiv: neuer Policy-Code `NO_BASELINE` in der CHECK-Constraint und die
Fill-Messspalte `follower_notional`). Es bleiben genau **zwei** Tabellen:

- **`copy_subscriptions`** — Leader/Follower-Zuordnung, nullable
  `follower_instrument_id` bis das Mapping abgeschlossen ist, Sizing,
  versionierte `policy_json` + `policy_version`. Der Modus-CHECK erlaubt exakt
  `SIMULATE_ONLY`; `enabled` ist `false`.
- **`copy_order_links`** — Link von `leader_event_id` auf eine stabile
  `follower_intent_id`, optionaler FK auf den bestehenden
  `execution_quality_intents`-Datensatz, Zustandsprojektion, die gemessene
  `follower_notional` und die optionale Fill-Abweichungsmessung. Beide
  verlangten Eindeutigkeiten gelten: `(leader_event_id, follower_intent_id)`
  und `follower_intent_id`. Diese Eindeutigkeiten sind die **persistente**
  Dedupe-Basis des Loops — nicht ein Speicher-Set im Prozess.

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
- `tests/copy.engine.test.ts` — der erste lauffähige Loop: injizierte
  WS-Frames, **kein Netzwerk**, Baseline-Reihenfolge, Heartbeat-Pause,
  Doppelzustellung inkl. simuliertem Neustart, `HALTED`-Blockade,
  Grep-Prüfung „kein `submit()` gegen eine echte Venue" und Secret-Scan.
- Migration wiederholt ausführen ist idempotent. Rollback nach Export/Stop:
  `DROP TABLE copy_order_links; DROP TABLE copy_subscriptions;`.

## Der erste lauffähige Loop (07-03)

```bash
npm run copy:paper -- --leader-account=main-account                  # dry-run (Default)
npm run copy:paper -- --leader-account=main --symbols=BTCUSDT --duration=5m
npm run copy:paper -- --leader-account=main --policy=./policy.json --write
npm run copy:paper -- --replay=frames.jsonl --leader-account=rehearsal
```

`--dry-run` ist der Default: es wird **nichts** persistiert — kein Link, kein
Execution-Quality-Intent, kein Audit-Eintrag. Schreiben erfordert `--write`.
`--replay` ist eine Offline-Rehearsal über denselben Decoder-Pfad und erzwingt
den Dry-Run. Der Loop braucht Bitunix-Credentials (eigenes API-Key/Secret des
Leader-Kontos); ohne sie endet er mit Exit-Code 2, **bevor** etwas kopiert wird.

Ablauf pro Leader-Event (`src/copy/engine.ts`):

```text
Leader-Frame ─▶ parseLeaderFrame ─▶ deriveLeaderAction ─▶ NormalizedLeaderTrade
      │                                                          │
      │                                          Leader-Tor: LIVE + Baseline
      ▼                                                          ▼
 followerIntentIdFor(leader_event_id) ────▶ Dedupe (copy_order_links)
      │                                          │ Treffer ⇒ DUPLICATE
      ▼                                          ▼
 mapLeaderSymbol (SSoT) ──▶ computeFollowerNotional ──▶ evaluatePolicy
      │                                                  │ Block ⇒ markFailed(code)
      ▼                                                  ▼
 follower.simulate() ──▶ markSent / markPartial / markFilled
```

Jeder Schritt ist fail-closed: ein Fehler erzeugt **keinen** Intent, sondern
einen Audit-Eintrag und einen Telemetrie-Zähler. Die Latenz
(`leader.occurredAt` → `follower.createdAt`) wird protokolliert; das
Überschreiten des Schwellwerts ist ein **Finding**, kein Abbruch — ein
langsamer Copy ist ein Messwert, kein Grund, den Fill zu verwerfen.

### Abgrenzung — was Copy-Trading hier ist und was nicht

Copy-Trading in diesem Repository bedeutet:

- Das **eigene** Leader-Konto wird über **eigene** API-Credentials gelesen
  (`secrets.ts`); es gibt keinen Pfad, der ein fremdes Konto ohne dessen
  Schlüssel ausliest.
- Es werden ausschließlich **Order-/Fill-Ereignisse** eines authentifizierten
  WebSocket-Kanals normalisiert — keine Positions-Snapshots, keine Orderbücher,
  keine Kontostände Dritter.
- Das Ergebnis ist ein **Follower-Intent im Paper-Ledger** der Firma. Es gibt
  keine Ausführung an einer echten Venue.

Copy-Trading in diesem Repository ist **ausdrücklich nicht**:

- **kein Scraping** — kein Auslesen fremder Webseiten, Signal-Feeds,
  sozialer Profile oder Order-Historien ohne autorisierte API;
- **keine Fremdplattform-Automation** — keine UI-Automation, kein
  Browser-/Fernsteuerungs-Zugriff auf eine Handelsplattform, kein Nachbau
  einer Plattform-Session, kein Cookie- oder Token-Replay;
- **kein Live-Pfad** — keine Live-Follower-Order, kein Venue-`submit()`, keine
  Kapitalverwaltung für Dritte, keine Vergütung, kein Handel auf Rechnung
  anderer;
- **kein Polling-Leader** — STX-08: Polling ist kein Ersatz für die
  WS-Quelle;
- **kein Reconciler** — der Copy-Loop ist kein Abstimmungssystem; das bleibt
  bei [`../src/brokers/reconciliation.ts`](../src/brokers/reconciliation.ts).

### Warum Alpaca nicht enthalten ist (STX-08)

Der Alpaca-Adapter in `src/brokers/alpaca/` ist **REST-only**: es gibt dort
kein `ws.ts`, keinen `WebSocket`-Import und keine `wss://`-Adresse — der
Adapter kann also keinen `trade_updates`-Stream liefern. Bitunix bringt
dagegen `ws.ts` mit gehärtetem Transport (Versions-Guard, Host-Allowlist,
Backoff, Reconnect) mit; genau dieser Client wird wiederverwendet.

Polling wäre **kein** Ersatz, und zwar aus drei unabhängigen Gründen:

1. `getOrderUpdates` ist **paginiert** — über eine Seitengrenze hinweg können
   Ereignisse unbemerkt ausfallen; ein Copy-Loop, der ein Fill verpasst, hat
   eine divergente Position und weiß es nicht.
2. `events/orders/status` hat **Sekundenlatenz** — ein Leader-Fill, der
   Minuten alt ist, wird zu einem Follower-Einstieg zum dann aktuellen Kurs.
3. Polling-Raten kollidieren mit den Rate-Limit-Budgets des Adapters; die
   Retry-/Idempotenz-Logik in `http.ts` existiert bereits für genau diese
   Fälle.

Konsequenz: ein Alpaca-Leader bräuchte einen **eigenen** Adapter-Audit mit
neuem `ws.ts` (Reconnect, Heartbeat, Backfill). Dieser Audit ist explizit
**nicht** Teil der Copy-Roadmap. Akzeptanzkriterien von STX-08 bleiben
deshalb: Kopplung nur mit WS-Quelle, kein stilles Polling, und ohne
WS-Provider **keine** Leader-Subscription (fail-closed, kein „letzter
bekannter Stand"). Der dritte Punkt ist im Code sichtbar: `connect()` wirft
`BASELINE_UNAVAILABLE`, bevor der Frame-Strom startet, und ohne Baseline
bleibt der Zustand nicht `LIVE`.

### `SIMULATE_ONLY` und die organisatorische Einordnung (STX-16)

`CopyMode` ist ein Union-Typ mit **genau einem** Wert; `COPY_MODES` ist
`["SIMULATE_ONLY"]`. Es gibt kein Env-Flag, kein Policy-Feld und keinen
Code-Pfad, der diesen Modus aufweitet — auch der Datenbank-CHECK-Constraint
erlaubt ausschließlich diesen Wert und überlebt einen Aufrufer, der etwas
anderes sendet. Der Follower ruft strukturell nur den In-Process-Paper-Ledger
(`PaperBroker.submit()` / `PaperBroker.close()`); es gibt keinen
`BrokerAdapter`, keinen Venue-Order-Pfad und keine transaktionale
Order-Schleuse. Das ist in `tests/copy.engine.test.ts` als Grep-Prüfung
verdrahtet, damit ein künftiger „kleiner" Venue-Aufruf sofort auffällt.

Organisatorisch ist dieses Modul ein **Forschungs-/Simulationswerkzeug
innerhalb eines Paper-Trading-Projekts**. Es verändert den Charakter der
Software: nicht mehr „die Firma handelt für sich", sondern „die Firma handelt
für Dritte". Dieser Sprung hat ein Rechts- und Haftungsprofil
(Verwaltung fremden Vermögens, Vermarktung von Signalen, Aufsicht, Steuer),
das **nicht** in diesem Repository entschieden werden kann. Jeder Ausbau in
Richtung Live-Copy erfordert deshalb eine **separate** Rechts- und
Compliance-Prüfung außerhalb dieses Repos (offener Punkt **B5** in
[`../docs/BETA_STATUS.md`](../docs/BETA_STATUS.md)). Solange sie nicht
vorliegt, gibt es keinen Live-Pfad — und diese Roadmap plant auch keinen.

### Symbol-Mapping, Leverage-Policy, Partial-Fills, Slippage

- **Symbol-Mapping:** Die SSoT bleibt `src/symbols/normalize.ts`. Der Leader
  liefert die Venue-Schreibweise (`BTCUSDT`), die Engine löst darüber die
  kanonische Instrument-ID auf. Gibt es keinen Treffer, endet das Event in
  `NO_MAPPING` — es gibt **keinen** Fallback, kein „nächstbestes Symbol" und
  keine geratene ID. `follower_instrument_id` in `copy_subscriptions` bleibt
  genau deshalb solange nullable, bis das Mapping abgeschlossen ist.
- **Leverage-Policy:** `maxLeverage` steht Default auf **1×** und wird durch
  `LIMIT_CEILINGS.maxLeverage[1]` (3×) hart begrenzt. Die Copy-Policy kann die
  Broker-/Risk-Guardrails nur **verschärfen**, niemals aufweiten. Der
  Follower übernimmt den Leader-Hebel nicht blind, sondern kappt ihn an der
  eigenen Hebel-Policy.
- **Partial-Fills:** Ein Leader-`PART_FILLED` ist ein Fill-Ereignis mit
  `fillRatio`; der Follower rechnet mit der **gefüllten** Menge, nicht mit der
  beauftragten. Der Link läuft `SENT → PARTIAL → FILLED`. Ein Leader-`CLOSE`
  schließt über `PaperBroker.close()`. Ein Leader-`DECREASE` wird **benannt**
  abgelehnt (`PAPER_LEDGER_HAS_NO_PARTIAL_REDUCE`), statt einen Fill zu
  erfinden: der Paper-Ledger kennt keinen Teilausstieg, und eine erfundene
  Menge wäre schlimmer als eine ehrliche Ablehnung.
- **Slippage:** Es gibt zwei verschiedene Größen, und sie dürfen nicht
  verwechselt werden. `maxSlippageBps` vergleicht **vor** der Ausführung den
  *erwarteten* Spread (`ruleSnapshot.spreadPct` bzw. `scanner.spread`, im
  Zweifel der größere Wert); fehlt eine belastbare Beobachtung, wird
  fail-closed mit `MAX_SLIPPAGE` abgelehnt. `observedDeviationBps` wird
  **nach** dem Fill **gemessen** und in `copy_order_links` persistiert. Diese
  Messung ist weder ein Gate noch ein Trigger für Cancel oder
  Status-Rückstufung: ein ausgeführter Fill wird nicht nachträglich
  „storniert". Slippage drosselt höchstens **künftige** Entscheidungen.

### Referenzmodelle, die nicht nachgebaut wurden

Diese Produkte und Muster dienten ausschließlich als **Referenzmodell** für
die Fragen „wie löst man das grundsätzlich?". Keines davon wurde in diesem
Repository nachgebaut, und aus keinem wurde Code übernommen:

| Referenz | Was daraus übernommen wurde | Was **nicht** nachgebaut wurde |
| --- | --- | --- |
| Social-Copy-Plattformen (eToro, Bitget/Bybit Copy-Trading) | die Erkenntnis, dass Leader-Ereignisse als *Absicht* und nicht als rohe Order zu modellieren sind | Lead-Trader-Programm, Profit-Sharing-Abrechnung, sozialer Graph, Ranking, Performance-Feed |
| Signal-Marktplätze (3Commas & Verwandte) | die Idee der versionierten Policy als reproduzierbare Entscheidungsgrundlage | Marktplatz, Signalanbieter-Registry, Bezahl- und Quota-Logik |
| Webhook-/UI-Automation (TradingView-Alerts, Browser-Automation) | nichts — dieser Weg ist ausdrücklich gesperrt | Webhook-Ingestion, UI-Automation, Scraping |
| ZuluTrade-ähnliche Vermittler | nichts — Vermittlung fremden Kapitals ist nicht Gegenstand dieses Repos | Kontenaggregation, Mandatsverwaltung, Gebührenabrechnung |
| Vorhandene Module (`src/executionQuality/`, `src/brokers/reconciliation.ts`) | direkte Wiederverwendung über FK bzw. Aufruf | **keine** zweite Intent-, Receipt- oder Reconciliation-Pipeline |

Der letzte Zeilenpunkt ist der wichtigste: alles, was es in diesem Repository
schon gibt, wird **benutzt**, nicht dupliziert. Genau deshalb bleiben es zwei
Tabellen und genau deshalb gibt es keinen eigenen Reconciler.

