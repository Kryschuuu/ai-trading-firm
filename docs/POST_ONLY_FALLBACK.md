# Post-Only-Ausführung mit Market-Fallback (RMA-P4-02)

**Version:** `v1.70.0` · **Status:** produktiv, schreibende Pfade hinter
`EXECUTION_POLICY_ENABLED=true` · **Modul:** `src/execution/`

Der Execution-Policy-Controller platziert Maker-Limits (Post-Only) mit
begrenzter Lebensdauer, repriced bounded nach Maker-Reject oder Timeout und
füllt einen Rest — nur per Opt-in und nur nach bestätigtem Cancel — per Market
nach. Jeder Schritt ist auditiert, idempotent und fail-closed: Unklarheit
stoppt, statt zu raten.

## 1. Policy (versioniert, bounded)

Die Policy ist das einzige Steuerungsobjekt. Alle numerischen Felder sind
hart begrenzt; Werte außerhalb werfen `ExecutionPolicyError` (kein stilles
Klemmen).

| Feld | Default | Bounds | Bedeutung |
|---|---|---|---|
| `postOnly` | `true` | — | Maker-Limit verlangen |
| `postOnlyFallback` | `"fail"` | `fail \| limit` | Alternative, wenn das Venue kein Post-Only kann |
| `ttlMs` | `30_000` | 1 000 … 3 600 000 | Lebensdauer je Limit-Attempt |
| `maxReprices` | `2` | 0 … 10 | Repricing-Versuche nach Maker-Reject/Timeout |
| `priceOffsetBps` | `5` | 0 … 500 | Limit-Abstand vom Mid (Maker-Seite) |
| `fallbackAllowed` | `false` | — | Opt-in für den Market-Fallback |
| `maxSpreadBps` | `50` | 1 … 5000 | Maximaler Spread für Submit/Reprice/Fallback |
| `maxSlippageBps` | `30` | 1 … 5000 | Maximale Fallback-Slippage (halber Spread) |
| `maxNotional` | `0` | 0 … 1 000 000 | Policy-Notional-Cap (`0` = nur Risk-Guard) |
| `maxQuoteAgeMs` | `5_000` | 100 … 60 000 | Maximales Quote-Alter |
| `cancelConfirmTimeoutMs` | `10_000` | 1 000 … 120 000 | Wartezeit auf Cancel-Bestätigung |
| `maxCancelAttempts` | `3` | 1 … 5 | Cancel-/Verify-Wiederholungen |

Jede Policy trägt eine Version `eop1:<64 Hexzeichen>` (SHA-256 über die
kanonischen Felder). Gleicher Inhalt ⇒ gleiche Version; ein Feld anders ⇒
andere Version. **Ein Key, eine Policy:** Start mit anderer Policy unter
demselbem Key wirft `POLICY_MISMATCH`.

Repricing ist deterministisch: Versuch `n` nutzt
`priceOffsetBps + 10 bp × n` (tiefer auf der Maker-Seite), das Limit wird vor
jedem Submit auf den Venue-Tick gerundet.

## 2. State-Machine

```text
NEW → SUBMITTED → ACK ─┬─→ PARTIAL ─→ CANCEL_PENDING ─→ CANCELLED ─┬─→ DONE
                        │                                           │
        (Maker-Reject)  │   (voll gefüllt)                          ├─→ FALLBACK_SUBMITTED ─→ DONE
        REJECTED ───────┘   DONE                                    │
                                                                    └─→ SUBMITTED (Reprice, bounded)
```

Endzustände: `DONE`, `FAILED`. Harte Kanten-Regeln:

- `FALLBACK_SUBMITTED` ist **nur** aus `CANCELLED` erreichbar — nie aus
  `PARTIAL`, `ACK` oder `CANCEL_PENDING`.
- Aus `CANCEL_PENDING` führt kein Weg zum Fallback (unklarer Cancel-Status
  blockiert, bounded, dann `FAILED`/`CANCEL_UNRESOLVED`).
- `REJECTED → SUBMITTED` und `CANCELLED → SUBMITTED` existieren nur für
  bounded Reprices (`repricesUsed < maxReprices`).
- Maker-Rejects (`POST_ONLY_WOULD_TAKE`) sind von sonstigen Rejects
  unterscheidbar (`MAKER_REJECT` vs. klassifizierter Code).

Jede Transition schreibt genau ein Event (`eoe1:<64 Hexzeichen>`, Sequenz pro
Workflow) und erhöht die Workflow-Version (Optimistic Locking).

## 3. Idempotenz-Keys

| Key | Format | Ableitung |
|---|---|---|
| Workflow | `eow1:<64 Hexzeichen>` | Venue, Modus, Symbol, Seite, Zielmenge, Seed |
| Event | `eoe1:<64 Hexzeichen>` | Workflow-Id, Sequenz, Zielzustand, Reason, Order, Zeit |
| Client-Order-Basis | `eoc1:<16 Hexzeichen>` | Workflow-Key (Attempt-Suffixe: `L0…`, `M0…`) |

Der Workflow-Key enthält bewusst **keine** Policy (siehe `POLICY_MISMATCH`).
Client-Order-Ids sind pro Attempt stabil: Wiederholungen und Restarts lösen
per Client-Key auf, statt doppelt zu senden. Attempts sind begrenzt
(`maxReprices + 1` Limits, genau ein Market-Fallback).

## 4. Venue-Fähigkeiten (kein stilles Dropping)

| Venue | Post-Only | Cancel einzeln | Atomares Cancel/Replace |
|---|---|---|---|
| PAPER | ja | ja | ja (Simulation) |
| BITUNIX | ja (`effect: POST_ONLY`) | ja | nein (Cancel+Replace) |
| ALPACA | **nein** | ja | ja |

Regeln:

- Fehlende Capability-Methode am Adapter ⇒ alles-falsch (fail-closed).
- `postOnly=true` auf einer Venue ohne Post-Only ⇒ `POST_ONLY_UNSUPPORTED`,
  außer `postOnlyFallback: "limit"` wählt explizit ein normales Limit
  (auditiert als `SUBMIT_LIMIT_FALLBACK`).
- Der Bitunix-Serializer verlangt für Post-Only ein Limit und sendet sonst
  `GTC`; der Alpaca-Serializer wirft bei Post-Only, statt das Flag zu
  verwerfen.
- Client-Order-Ids für Bitunix sind auf 32 Zeichen gekürzt
  (Venue-Längenregel), für Alpaca ungekürzt.

## 5. Gates (hart, vor jedem Submit und vor dem Fallback)

Submit-Gates (Erst-Submit, Reprice, Fallback-Submit):

1. Kill-Switch (`KILL_SWITCH_ARMED`)
2. Lifecycle (`LIFECYCLE_BLOCK`, nur aktive Phasen)
3. Risk-Guard (`RISK_GUARD_BLOCK`, inkl. Stop-Loss-Pflicht)
4. Live-Gate im Live-Modus (`LIVE_GATE_DENY`, fail-closed ohne Prüfung)
5. Quote vorhanden, nicht zukünftig, frisch
   (`QUOTE_MISSING`, `QUOTE_FUTURE`, `QUOTE_STALE`)
6. Spread bekannt und eng genug (`SPREAD_UNKNOWN`, `SPREAD_TOO_WIDE`)
7. Konto bekannt (`ACCOUNT_UNAVAILABLE`)
8. Notional unter Risk-Guard-Limit (`NOTIONAL_GUARD_CAP`) und Policy-Cap
   (`NOTIONAL_POLICY_CAP`)
9. Menge ≥ Minimum und auf dem Step (`QTY_BELOW_MINIMUM`,
   `QTY_STEP_VIOLATION`)

Fallback-Gates (zusätzlich): Opt-in (`FALLBACK_DISABLED`), bestätigter Cancel
(`FALLBACK_NO_CONFIRMED_CANCEL`), Slippage-Schätzung ≤ Cap
(`SLIPPAGE_TOO_HIGH`, `null` = unbekannt = blockiert), Restmenge ≥ ein Step
(Staub ⇒ `DONE`/`DUST_REMAINDER`, kein Market-Dust).

## 6. Fills und Restmenge

- Die Restmenge ist `Ziel − Σ Fills`, abgerundet auf den Venue-Step (floor,
  nie auf).
- Überfüllung (`Σ Fills > Ziel`) ist terminal (`OVERFILL_DETECTED`), kein
  Clamp — im Speicher-Store wie in Postgres (atomar, ohne Teilzustand).
- Gebühren: `null`, sobald ein Fill die Gebühr nicht kennt (unbekannt ≠ 0).
- Fills gleichen Order-/Client-Keys werden dedupliziert; Venue-Fills mit
  Duplikat-Ids werden genau einmal gezählt.
- Preise werden auf den Venue-Tick, Mengen auf den Step gerundet; ein Fill
  während `CANCEL_PENDING` komplettiert (`FILLED_DURING_CANCEL`) statt einen
  Fallback zu starten.

## 7. Paper-Simulation (deterministisch)

Der `PaperVenuePort` simuliert Post-Only ehrlich: ein Limit, das sofort nehmen
würde, wird als `POST_ONLY_WOULD_TAKE` abgelehnt; `applyTrade` füllt nach
Preis-Zeit-Priorität; Cancels sind idempotent; unbekannte Orders melden
`UNKNOWN`. Gleicher Seed + gleiche Trades ⇒ byte-identische Event-/Fill-Sequenz
(Golden-Test in `tests/executionPolicy.controller.test.ts`).

Single-Price-Prämisse: Der Simulations-Kurs ist ein Mid; der Spread kommt aus
der Universe-Registry und ist `0`, wenn die Registry keinen Spread kennt.
Fallback-Slippage ist dann `0` — dokumentiert, nicht geraten.

## 8. API

Basis: `/api/firm/execution/policy` (Next.js-Route, `no-store`).

- `GET ?key=eow1:…` oder `?id=…` (`firm.read`, immer lesbar): Workflow,
  Events (max. 200), Fills (max. 500), `truncated`-Flag.
- `POST { action: "start", venue, mode, symbol, side, targetQty, policy?,
  seed, limitPrice?, hasStopLoss? }` (`firm.write`, Flag-pflichtig).
- `POST { action: "poll", id, venue?, mode? }` (`firm.write`,
  Flag-pflichtig): genau ein Poll-Schritt.
- `POST { action: "recover" }` (`firm.write`, Flag-pflichtig):
  Neustart-Rekonstruktion über alle offenen Workflows; Live-Venues
  best-effort (ohne Credentials melden Live-Workflows `PORT_UNKNOWN` im
  `errors`-Array, PAPER läuft trotzdem).

Antworten sind bounded und tragen klassifizierte Codes; Roh-Payloads und
Secrets verlassen den Server nie. Ohne Flag antworten schreibende Aktionen
`503`/`EXECUTION_POLICY_DISABLED`.

Beispiel Start (PowerShell):

```powershell
$body = @{
  action = "start"; venue = "PAPER"; mode = "paper"; symbol = "BTC"
  side = "LONG"; targetQty = 0.5; seed = "desk-2026-09-22-001"
  hasStopLoss = $true
  policy = @{
    postOnly = $true; postOnlyFallback = "fail"; ttlMs = 30000
    maxReprices = 2; priceOffsetBps = 5; fallbackAllowed = $false
    maxSpreadBps = 50; maxSlippageBps = 30; maxNotional = 0
    maxQuoteAgeMs = 5000; cancelConfirmTimeoutMs = 10000
    maxCancelAttempts = 3
  }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "http://localhost:3000/api/firm/execution/policy" `
  -Method Post -Body $body -ContentType "application/json" -Headers $headers
```

Voraussetzungen für PAPER: Universe ist geseedet (`npm run universe:seed`),
sonst antwortet der Start `INSTRUMENT_UNKNOWN`; der Start verlangt
`hasStopLoss: true` (hartes Risk-Guard-Ceiling).

## 9. Betrieb

- Flag: `EXECUTION_POLICY_ENABLED=true` (Default `false`; unbekannte Werte
  werfen). Siehe auch [CONFIGURATION.md](../CONFIGURATION.md).
- Restart: `POST { action: "recover" }` oder Controller-`recover()` liest
  offene Workflows aus Postgres und pollt sie — vor jeder externen Aktion
  wird der Zustand rekonstruiert (kein Doppel-Submit).
- Kill-Switch und Lifecycle werden bei jedem Poll neu geprüft; ein bewaffneter
  Switch stoppt auch den Fallback (`FAILED`/`KILL_SWITCH_ARMED`).
- Audit: jede Transition schreibt `EXECUTION_POLICY_TRANSITION`
  (Security-Klasse) mit Key, Venue, Modus, Kante, Reason, Policy-Version,
  Attempt und Füllstand.
- Metriken: `executionPolicy.transitions{from,to,reason}`,
  `executionPolicy.rejects{venue,code}`,
  `executionPolicy.fallbacks{venue,outcome}`,
  `executionPolicy.overfills{venue}`.
- Persistenz: `execution_workflows`, `execution_workflow_events`,
  `execution_workflow_fills` (Migration
  `drizzle/2026-09-22_post_only_fallback.sql`, idempotent, append-only).
  DB-CHECKs erzwingen Zustände, Key-Formate, `filled ≤ Ziel` und die
  Zeit-Semantik (`event_time ≤ available_at ≤ computed_at`).

## 10. Nicht-Ziele (Out of Scope)

- Kein TWAP-Scheduler (ein Workflow = ein Versuch mit bounded Reprices).
- Kein aggressiver Fallback bei unklarem Cancel-Status — Unklarheit blockiert.
- Kein Umgehen von Venue-Tick-, Step- oder Minimum-Regeln.
- Kein automatischer Live-Betrieb: Live-Modus verlangt zusätzlich das
  zentrale Live-Gate (siehe [LIVE_TRADING.md](LIVE_TRADING.md)).

## 11. Tests

- `tests/executionPolicy.unit.test.ts` — Policy, State-Machine, Mengen,
  Gates, Capabilities, Paper-Port (35 Tests).
- `tests/executionPolicy.controller.test.ts` — Controller-E2E über
  In-Memory-Store: Erfolg, Maker-Reject, Timeout, Partial Fill, Fallback,
  Cancel-Races, Restart/Retry, Safety-Gates, Negative Paths, Golden (24 Tests).
- `tests/executionPolicy.db.test.ts` — Postgres über eingebettete DB:
  Migration, Roundtrip, Idempotenz, Restart, Locking, Constraints, Overfill
  (7 Tests).

```bash
npm run typecheck && npm run lint
npx tsx --test tests/executionPolicy.unit.test.ts \
  tests/executionPolicy.controller.test.ts tests/executionPolicy.db.test.ts
npm run docs:validate
```
