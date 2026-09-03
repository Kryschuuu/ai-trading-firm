# B2 — Ungültige Venue-Positionsseite wird still als LONG interpretiert

- **Severity:** MEDIUM
- **Bereich:** Brokers & Venues
- **Status (validiert):** ✅ **Valide.**
- **Datei(en):** `src/brokers/bitunix/privateClient.ts` (`getPositions` L141)

## Arena-Prompt (kopierbar)

```
TASK: Stop silently defaulting unknown venue position sides to LONG.

PROBLEM: getPositions() maps every non-"SHORT" side string (including "", null, garbage) to "LONG".
A corrupted/empty side is masked instead of surfaced, which can mislabel a short position as long in
the local view.

DO:
1. In getPositions(), replace:
     const side = String(r.side ?? "").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
   with explicit validation:
     const raw = String(r.side ?? "").trim().toUpperCase();
     if (raw !== "LONG" && raw !== "SHORT") return null; // skip + log, do not guess
   (filter already drops nulls). Add a debug counter / audit for skipped rows.
2. If the venue occasionally omits side for closed/zero-qty rows, ensure those are filtered by the
   existing `qty<=0` check before the side check (so we never mislabel a real open position).
3. Add a test: a position row with side="" or side="WEIRD" is excluded from the result, not mapped to LONG.

ACCEPTANCE: Unknown sides are dropped (and counted), never silently coerced to LONG; legitimate
LONG/SHORT rows are preserved.
```

## Beweis (aktueller Code)

`src/brokers/bitunix/privateClient.ts` L141 (in `getPositions`):

```ts
const side = String(r.side ?? "").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
```

## Fix-Spezifikation

Explizite Validierung: unbekannte/leere Seite → Position überspringen + loggen, nicht still als
LONG (siehe Audit B2).

## Akzeptanzkriterien / Tests

- [ ] `side=""` / `side="WEIRD"` → Position wird ausgelassen (nicht LONG).
- [ ] `LONG`/`SHORT` bleiben erhalten.
- [ ] Übersprungene Zeilen werden gezählt/geloggt.

## Changelog-Blurb

`B2 (MEDIUM): Ungültige Positionsseite still als LONG — explizite Validierung; unbekannte Seite wird
ausgelassen + geloggt statt maskiert.`

## Versions-Hinweis

PATCH (`1.36.3`) — Validierungs-Härtung, keine API-Änderung.
