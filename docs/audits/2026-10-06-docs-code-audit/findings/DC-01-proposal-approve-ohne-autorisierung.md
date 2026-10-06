# DC-01 — Proposal-Freigabe ohne Autorisierung

- **ID:** DC-01
- **Severity:** HIGH (Sicherheit)
- **Bereich:** API-AuthZ / Approval-Chain
- **Entdeckt:** 2026-10-06, Docs↔Code-Audit `v0.17.2` (Mengenabgleich „welche Firm-Route hat keinen Guard?")
- **Status:** ☑ **FIXED** (2026-10-06, diese Session)
- **Datei(en):** `src/app/api/firm/proposals/[id]/approve/route.ts`, `tests/proposalApprove.auth.test.ts` (neu), `tests/routes.asyncParams.test.ts` (angepasst)

## Beschreibung

`POST /api/firm/proposals/[id]/approve` setzt ein `PENDING`-Proposal auf
`APPROVED` — laut H6 (v1.36.7) die **einzige** Freigabe, nach der der Executor
überhaupt handeln darf (`executeApprovedProposal` verlangt `status === "APPROVED"`).

Der Handler prüfte bis 2026-10-06 **weder** `requirePermission(...)` **noch**
`guardWrite(...)`/`checkApiToken(...)` **noch** CSRF. Er war damit die einzige
schreibende Route unter `src/app/api/firm/**` ohne Autorisierung:

| Route | Guard | Methoden |
|-------|-------|----------|
| `firm/devils-advocate`, `firm/micro`, `firm/risk` | keiner | nur `GET` (lesend) |
| **`firm/proposals/[id]/approve`** | **keiner** | **`POST` (schreibend)** |
| alle übrigen 42 Firm-Routen | `requirePermission` und/oder `guardWrite`/`checkRateLimit` | teils schreibend |

Die Ursache ist historisch: SEC-02 (FIXED v1.36.31, Commit `d900a71`) hat die
im Finding gelisteten **Lese**-Endpunkte auf `firm.read` umgestellt; dieser
Schreibpfad stand nicht auf der Liste und wurde beim H6-Fix (`4e762e4`) ohne
Guard angelegt. `tests/routes.asyncParams.test.ts` deckte nur die
Signatur-/`params`-Regression ab.

## Wirkung

In `AUTH_MODE=token-required` (Produktion) konnte **jeder anonyme Aufrufer** ein
fremdes bzw. agentengeneriertes Proposal freigeben — die menschliche Freigabe
der Approval-Chain war wirkungslos. In `local-open` (Dev) war der Effekt
geringer, weil nicht authentifizierte Requests ohnehin als `admin` gelten; der
Pfad blieb aber auch dort ohne Rate-Limit und ohne CSRF-Schutz.

Die Doku trug das mit: `docs/security/README.md` (Zeile 307) nennt die
Proposal-Freigabe explizit als sicherheitskritischen Pfad, prüft dort aber nur
die **Audit-Durabilität** (503 statt Freigabe ohne Beleg) — nicht die Identität.
Die aggregierte Sicht meldete „keine offenen Critical/High-Findings".

## Fix

```ts
// src/app/api/firm/proposals/[id]/approve/route.ts
const denied = requirePermission(request, "firm.write") ?? checkCsrfGuard(request);
if (denied) return denied;
const actor = actorAuditId(request);
```

- **Reihenfolge bewusst wie `/api/firm/kill` und `/api/firm/lifecycle`:**
  `firm.write` **vor** CSRF, CSRF **vor** DB-Zugriff (kein Existenz-Orakel für
  Anonyme, keine Rate-Limit-Umgehung).
- `approvedBy` bleibt Vertragsbestandteil (Anzeigename im Audit-`detail`);
  die belastbare Identität kommt zusätzlich aus `actorAuditId(request)`:
  Audit-Einträge (`PRECHECK`/`APPLIED`) und Response tragen jetzt
  `authenticatedActor`.
- `operator` (hat `firm.write` per Rollenmatrix) bleibt handlungsfähig;
  `viewer` erhält 403, ein Token allein genügt nicht mehr ohne CSRF-Header.

## Verifikation

- `tests/proposalApprove.auth.test.ts` (neu, 7 Tests):
  anonym ⇒ 401 `UNAUTHORIZED`; gefälschte Header (`x-firm-token`,
  `Authorization: Bearer`, `x-forwarded-for`) ⇒ 401; Viewer (`firm.read`)
  ⇒ 403 `FORBIDDEN`; Operator ohne `x-csrf-token` ⇒ 403 `CSRF_INVALID`;
  Operator mit Permission + CSRF ⇒ Guard passiert (200/404/500 je nach DB-Lage,
  nie Auth-Fehler); `local-open` verlangt weiterhin CSRF; Quell-Drift-Schutz
  (Import + Guard-Reihenfolge).
- `tests/routes.asyncParams.test.ts` sendet nun den CSRF-Header mit dem
  Offen-Betrieb-Wert (`CSRF_LOCAL_VALUE`) und bleibt auf sein eigentliches Ziel
  (ID-Auflösung, 400 bei fehlendem Actor) gerichtet.
- `npm run typecheck`, `npm run lint`: grün.

## Nachtrag (nach dem Fix zu prüfen)

- Ist der Approve-Pfad in der **UI** erreichbar? Es gibt aktuell keinen Aufrufer
  in `src/components/**`/`src/lib/apiClient.ts`; der Endpunkt wird per
  curl/CLI/Agent genutzt. Ein UI-Client müsste `x-csrf-token` senden
  (Double-Submit aus `firm_csrf`, siehe `src/lib/apiClient.ts`).
- `docs/security/README.md` sollte den Pfad in der Guard-Matrix führen —
  erledigt mit DC-03 (Abschnitt „Schreibpfade mit Guard").
