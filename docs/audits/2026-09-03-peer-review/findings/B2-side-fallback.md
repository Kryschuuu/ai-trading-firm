# B2 — Ungültige Venue-Positionsseite wird still als LONG interpretiert

- **Severity:** MEDIUM
- **Bereich:** Brokers & Venues
- **Status (validiert):** ✅ **Gefixt (v1.36.12)** — Befund war valide (Audit 2026-09-03); Fix in
  `src/brokers/bitunix/privateClient.ts` (`getPositions` + neues `parseBitunixPositionSide`) und
  `src/brokers/bitunix/audit.ts` (Anomalie-Ring + Zähler); Tests in
  `tests/bitunix.positions.test.ts`. Doku: `docs/BITUNIX.md` §5.3.
- **Datei(en):** `src/brokers/bitunix/privateClient.ts` (`getPositions`), `src/brokers/bitunix/audit.ts`

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

## Beweis (Code vor dem Fix)

`src/brokers/bitunix/privateClient.ts` in `getPositions` (Zeile 141 zum Audit-Zeitpunkt):

```ts
const side = String(r.side ?? "").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
```

Jeder andere Rohwert (`""`, `null`, `"SELL"`, abgeschnittener Müll) wurde zu `LONG` — ohne Log, ohne
Zähler, ohne Möglichkeit, die korrumpierte Antwort zu bemerken.

## Fix-Spezifikation (umgesetzt v1.36.12)

Zwei-Gate-Filterung pro Zeile, Reihenfolge fest:

1. `qty` muss endlich und `> 0` sein — geschlossene/Null-Mengen-Zeilen (bei denen Bitunix die `side`
   regelmäßig weglässt) scheiden hier aus und zählen **nicht** als Anomalie.
2. `side` muss `LONG` oder `SHORT` sein (`parseBitunixPositionSide`, getrimmt + case-insensitiv).
   Sonst: Zeile verwerfen, im Anomalie-Ring zählen, pro Call eine zusammengefasste, redaktierte
   Warnung. **Nie** auf `LONG` fallen.

`BUY`/`SELL` sind Order-Seiten desselben Venues und werden in der Positionsantwort bewusst nicht
umgedeutet (Positionsseite ist dort `LONG`/`SHORT` dokumentiert).

## Akzeptanzkriterien / Tests

- [x] `side=""` / `side="WEIRD"` / fehlende Seite → Position wird ausgelassen (nicht LONG).
- [x] `LONG`/`SHORT` bleiben erhalten (inkl. Vorzeichen des uPnL bei SHORT).
- [x] Übersprungene Zeilen werden gezählt (Ring + kumulativer Zähler) und pro Call geloggt.
- [x] `qty<=0` ohne `side` → über `qty` gefiltert, keine Anomalie (Reihenfolge geprüft).
- [x] Saubere Antwort erzeugt keine Anomalie (Regression).

Tests: `tests/bitunix.positions.test.ts` (7 Fälle, gegen `BitunixFixtureServer` mit einstellbaren
`positionRows`). `npm run typecheck`, `npm run lint`, `npm run docs:validate` grün;
`npm test` = **1609/1609**.

## Changelog-Blurb

`B2 (MEDIUM): Ungültige Positionsseite still als LONG — explizite Validierung; unbekannte Seite wird
ausgelassen + gezählt statt maskiert.`

## Versions-Hinweis

PATCH (**1.36.12** — umgesetzt) — Validierungs-Härtung, keine API-Änderung.

## Nachtrag (bewusst außer Scope)

`src/brokers/alpaca/mapping.ts` (`mapPosition` → `raw.side === "long" ? "LONG" : "SHORT"`) zeigt
dieselbe binäre Form, dort ist die Alpaca-Semantik aber zweiwertig (`long`/`short`) dokumentiert, und
`qty`/`entry`-Guard (Zeile 217) filtert Leerbereiche vor. Kein Auditauftrag — Beobachtung für ein
allfälliges Folgeticket zur einheitlichen Seitenvalidierung über alle Venues.
