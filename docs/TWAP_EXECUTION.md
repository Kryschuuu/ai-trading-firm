# TWAP- und Depth-aware Execution (RMA-P4-03, v1.71.0)

Der Scheduler zerlegt ein Eltern-Intent in zeitlich gestaffelte Maker-Kinder.
Kinder laufen ausschließlich über den Execution-Policy-Controller (P4.2) mit
`fallbackAllowed=false` und `maxReprices=0`. Es gibt keinen zweiten Order-Pfad
und keinen Market-Chase außerhalb des Eltern-Limits.

**Flag:** `TWAP_EXECUTION_ENABLED` (Default `false`) · **Modul:** `src/execution/twap/` · **API:** `/api/firm/execution/twap`

Abweichung von der Audit-Basis: der Befund wurde gegen `df3163e` / v1.51.1
geschrieben. Diese Umsetzung sitzt auf v1.70.0 (P4.2 ist vorhanden) und ändert
den P4.2-Pfad nur um `cancelOpen` — ein bestätigter Cancel ohne Market-Fallback.

## Was das Modul nicht ist

Kein Sub-Sekunden-Scheduler (`sliceIntervalMs >= 1000`). Kein Multi-Venue-POV.
Keine Garantie, dass die Zielmenge gefüllt wird, wenn Tiefe, Participation,
Impact oder das Eltern-Limit das verbieten. Was nicht legal passt, bleibt
`unscheduledQty` und wird nicht als Mini-Order erzwungen.

## Einheiten und Zeit

| Größe | Einheit | Unbekannt |
| --- | --- | --- |
| Mengen | Basiseinheit, Step der Venue | — |
| `minNotional` | Quote-Währung | `0` = keine zusätzliche Grenze |
| `maxParticipation` | Anteil, `0.1` = 10 % des Intervallvolumens | — |
| `maxImpactBps`, `priceOffsetBps` | Basispunkte | — |
| `observedVolume` | Basiseinheit im Slice-Intervall | `null` ≠ `0` ≠ unbegrenzt |
| `impactBps`, `depthQty`, `participationCap` | gemessen oder `null` | `null` wird nie als 0 gelesen |
| Zeiten | Millisekunden seit Epoch | `eventTime` ≤ `availableAt` ≤ `computedAt` |

`startAt` und `deadlineAt` sind Ereigniszeiten. Ein Slice darf nur starten, wenn
`scheduledAt <= now < deadlineAt`. Die Deadline ist exklusiv: ein Start genau
auf der Deadline existiert nicht.

## Plan

`planTwap` verteilt die Zielmenge auf das Raster `startAt + i * sliceIntervalMs`,
solange der Start vor der Deadline liegt. Mengen liegen auf `quantityStep`.
Der Rundungsrest landet im letzten erlaubten Slice. Ein Slice unter
`minSliceQty`, `minQuantity` oder `minNotional` wird nicht erzeugt.

Jitter (Menge und Zeit) kommt nur aus dem persistierten Seed. Dieselbe Policy
und derselbe Seed erzeugen denselben Plan. `planVersion` geht nicht in den
Jitter ein. Ohne Seed ist Jitter verboten (`JITTER_SEED_REQUIRED`).

## Tiefe und Participation

`assessDepth` entscheidet nur `submit` oder `pause`.

- Fehlendes, zukünftiges oder stales Buch (`now - availableAt > maxBookAgeMs`) pausiert (`DEPTH_MISSING` / `DEPTH_FUTURE` / `DEPTH_STALE`).
- `observedVolume = null` pausiert (`VOLUME_UNKNOWN`). Es ist nicht „unbegrenzt“.
- `observedVolume = 0` ergibt einen Cap von 0 und pausiert, wenn das unter dem Mindestslice liegt.
- Der Cap ist `floor(maxParticipation * volume)` auf den Step. Kein Slice überschreitet ihn.
- Impact ist der Walk der Gegenseite bis `maxImpactBps`, nur Levels innerhalb des Eltern-Limits. Nicht gemessen bleibt `null`.
- Das Maker-Limit liegt für LONG strikt unter dem Ask und nicht über dem Eltern-Limit, für SHORT strikt über dem Bid und nicht unter dem Eltern-Limit. Ist das nicht möglich, pausiert der Slice (`LIMIT_UNPRICEABLE`). Der Preis wird nicht nachgejagt.

`staleDepthAction=conservative` ist der einzige explizite Fallback. Er verlangt
`conservativeSliceQty` und ein Eltern-Limit. Impact bleibt dann `null` — er wird
nicht erfunden. Ohne diese beiden Felder pausiert auch der konservative Pfad.

## Scheduler

Ein Tick hält ein Lease (`leaseOwner` + Token + `leaseUntil`) und sendet
höchstens ein Kind. Die Slice-Menge wird vor `start` eingefroren. Der
Kind-Schlüssel ist `etc1(parentKey, sliceIndex)` und hängt nicht von der Menge
ab. Der Controller-Workflow-Key hängt von Venue, Modus, Symbol, Seite, Menge
und Seed ab. Ein Restart mit derselben eingefrorenen Menge trifft denselben
Workflow und legt keine zweite Order an.

Ein lebender Slice (SUBMITTED/PARTIAL) blockiert den nächsten Submit. Am
Slot-Ende wird er gecancelt. Erst ein bestätigter Cancel (Controller-Zustand
DONE/FAILED/REJECTED; `CANCELLED` ist nicht terminal und wird weiter gepollt)
gibt den Slot frei. Der Rest wird innerhalb des ursprünglichen Fensters neu
geplant. Was nicht mehr hineinpasst, wird `unscheduledQty`, nicht eine Order
unter dem Mindestlos.

| Lage | Verhalten |
| --- | --- |
| Kill-Switch | Kinder `cancelOpen`, Parent `CANCELLED` nur wenn alle Cancels bestätigt sind, sonst `PAUSED` / `KILL_SWITCH_UNCONFIRMED` |
| Deadline | wie Kill, Zielstatus `EXPIRED` (oder `COMPLETED`, wenn die Menge voll ist) |
| Disconnect / Markt unbekannt | `PAUSED`, kein Cancel-Versuch |
| Markt geschlossen | Pause und Cancel der lebenden Kinder |
| Gate-Reject / stale Tiefe | Pause, kein Submit |
| Resume | nur aus `PAUSED`, und nur explizit |

Der Parent-Status wird aus den Kind- und Fill-Zeilen abgeleitet
(`reconcileParent`). Überfüllung ist `FAILED` / `OVERFILL`. Ein gebrochener
Mengeninvariant ist `FAILED` / `INVARIANT_BROKEN`.

## Benchmark

Jede Evaluation vergleicht die TWAP-Fills mit einer Sofort-Baseline über
dieselbe Funktion `cost()` wie die Execution-Quality-Erfassung (P4.1).
Shortfall in bp ist `null`, wenn Arrival oder Fills fehlen — nie ein
erfundenes 0. Gespeichert werden Completion, Duration, Coverage und der
Shortfall gegen die Sofort-Baseline. Der Eval-Key ist der Inhalt
`(parent, asOf, filled, status)`; ein Retry schreibt keine zweite Zeile.

Die Arrival-Referenz ist nur verwendbar, wenn das Buch vor `startAt` bekannt
war und nicht älter als `maxBookAgeMs` ist. Das Qualitätsmodul hat ein eigenes
Arrival-Fenster (5 s) und wird hier nicht still überschrieben.

## Persistenz

Migration `drizzle/2026-09-23_twap_execution.sql`, Spiegel in `src/db/schema.ts`.

- `execution_twap_parents` — Intent, Policy-Snapshot, Lease, Cursor
- `execution_twap_slices` — Kind-Zustand, eingefrorene Menge, `depth_qty`, `impact_bps`, `participation_cap`, `limit_price` (NULL wenn unbekannt)
- `execution_twap_events` — append-only
- `execution_twap_evaluations` — append-only, idempotent über `etv1`

Kein FK-Cascade. Die Migration ist zweimal einspielbar und ändert keine
bestehende Tabelle.

```bash
psql "$DATABASE_URL" -f drizzle/2026-09-23_twap_execution.sql
```

## API

`GET /api/firm/execution/twap?key=etp1:…` oder `?id=…` verlangt `firm.read` und
ist immer lesbar. `POST` verlangt `firm.write` und das Flag.

| `action` | Wirkung |
| --- | --- |
| `start` | Parent anlegen (idempotent über den Parent-Key) |
| `tick` | ein Lease, höchstens ein Kind |
| `cancel` | offene Kinder canceln |
| `resume` | nur aus `PAUSED` |
| `recover` | offene Parents ticken; Fehler eines Parents stoppen die anderen nicht |

Antworten sind `private, no-store` und enthalten kein Lease-Token.

## Rollback

1. `TWAP_EXECUTION_ENABLED=false` (Default). Schreibende Pfade antworten 503.
   Lesen bleibt möglich. Es wird nichts mehr gesendet.
2. Tabellen nur droppen, wenn kein v1.71.0-Code mehr läuft. Die Befehle stehen
   im Kopf der Migration. Events und Evaluationen sind absichtlich nicht
   update- oder delete-bar, solange die Trigger existieren.
