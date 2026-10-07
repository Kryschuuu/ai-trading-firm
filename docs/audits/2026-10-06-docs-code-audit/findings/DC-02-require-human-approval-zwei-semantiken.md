# DC-02 — `REQUIRE_HUMAN_APPROVAL`: zwei Semantiken im selben Repo

- **ID:** DC-02
- **Severity:** HIGH (falsches Operator-Signal in einem Sicherheits-Flag)
- **Bereich:** Live-Gate / Broker-Gates / Dashboard-Anzeige
- **Entdeckt:** 2026-10-06, Docs↔Code-Audit `v0.17.2` (Symbol-/Env-Abgleich `REQUIRE_HUMAN_APPROVAL`)
- **Status:** ☑ **FIXED** (2026-10-06, diese Session)
- **Datei(en):** `src/app/api/firm/route.ts`, `tests/firmHumanApproval.parity.test.ts` (neu)

## Beschreibung

Das Flag `REQUIRE_HUMAN_APPROVAL` wird an vier Stellen ausgewertet — mit **zwei
verschiedenen Semantiken**:

| Ort | Ausdruck | Bedeutung bei ungesetzter Variable |
|-----|----------|-----------------------------------|
| `src/live-gate/config.ts:134` | `env.REQUIRE_HUMAN_APPROVAL !== "false"` | **true** (Freigabe verlangt) |
| `src/brokers/alpaca/config.ts:75` | `env.REQUIRE_HUMAN_APPROVAL !== "false"` | **true** |
| `src/brokers/bitunix/config.ts:48` | `env.REQUIRE_HUMAN_APPROVAL !== "false"` | **true** |
| `src/app/api/firm/route.ts:124` (Anzeige) | `process.env.REQUIRE_HUMAN_APPROVAL === "true"` | **false** (Anzeige!) |

Die drei Enforcement-Stellen sind fail-closed und entsprechen der Doku
(`CONFIGURATION.md:457`: „Nur exakt `\"false\"` hebt die Human-Gate-Bedingung
auf"; `BITUNIX.md:457`, `ARCHITECTURE.md:237`). Die Anzeige behauptete dagegen
im Standardfall (`Variable nicht gesetzt`, Dev wie Prod), die menschliche
Freigabe sei **nicht** erforderlich — genau das Gegenteil des Gate-Verhaltens.

## Wirkung

`GET /api/firm` speist das Dashboard-Feld `requireHumanApproval`. Ein Operator,
der sich darauf verlässt, liest „Freigabe aus", während Live-Gate, ALPACA- und
BITUNIX-Gates die Freigabe verlangen (bzw. der Downgrade-Pfad im Enforcer
verweigert). Umgekehrt blieb ein absichtliches
`REQUIRE_HUMAN_APPROVAL=false` in der Anzeige korrekt — nur der Default war
falsch, also genau der Fall, den niemand explizit prüft.

## Fix

`src/app/api/firm/route.ts` importiert und nutzt die zentrale Funktion:

```ts
import { humanApprovalRequired } from "@/live-gate/config";
// ...
requireHumanApproval: humanApprovalRequired(process.env),
```

Damit gibt es **eine** Semantik (fail-closed, nur exakt `"false"` schaltet ab)
und **eine** Implementierung; die Anzeige kann nicht mehr von den Gates
abweichen.

## Verifikation

- `tests/firmHumanApproval.parity.test.ts` (neu):
  Paritätstabelle über live-gate/ALPACA/BITUNIX für
  `undefined`, `""`, `"true"`, `"TRUE"`, `"yes"`, `"0"`, `"false"`, `"FALSE"`,
  `" false"` — nur exakt `"false"` liefert `false`.
- Quell-Drift-Schutz: `src/app/api/firm/route.ts` muss
  `humanApprovalRequired(process.env)` verwenden; das alte
  `process.env.REQUIRE_HUMAN_APPROVAL === "true"` darf nicht zurückkehren.
- `npm run typecheck`, `npm run lint`: grün.

## Offener Folgepunkt (LOW, nicht in dieser Session)

`CONFIGURATION.md` dokumentiert das Flag korrekt; `docs/security/README.md`
nennt es in der Guard-Matrix nicht. Empfehlung: bei DC-03-artigen
Doku-Nachträgen mitführen (kein eigener Prompt nötig).
