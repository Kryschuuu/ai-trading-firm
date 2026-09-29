# STX-14 — `changePct24h` misst 97 Perioden, nicht 24 Stunden

- **ID:** STX-14
- **Severity:** LOW
- **Bereich:** Handelslogik / Semantik
- **Quelle:** Ausbaudokument (nicht erwähnt)
- **Status:** OPEN
- **Datei(en):** `src/lib/ruleEngine.ts`, `src/lib/ruleFieldCatalog.ts`

## Beschreibung

Das Feld heißt `changePct24h`, misst aber den Abstand zur Kerze **97 Perioden** zurück.
Das ist im Code vollständig dokumentiert — und für Tages-/Swing-Strategien eine Falle.

## Beweis

```ts
// ruleEngine.ts (buildSnapshotFromCandles)
const changeBase = candles.length > 1 ? closes[Math.max(0, closes.length - 97)] : price;
```

Label-Doku:

> „Der Name ist historisch, die Rechnung nicht: bezogen wird die Kerze vor 97 Perioden —
> auf `1h` also ~4 Tage, auf `5m` ~8 Stunden, auf `1m` ~1,6 h. Label und Doku sagen das jetzt;
> die Rechnung bleibt (eine Korrektur würde bestehende Regeln und ihre Backtests still
> umwerten — das Versionssache, kein Nebenprodukt dieses Zyklus)."

## Remediation

**Keine Umrechnung.** Jedes neue Template, das `changePct24h` verwendet, muss die
**periodenbasierte** Semantik dokumentieren (und bei `4h`/`1d` ist der Wert noch
sinnloser). STX-01 weitet die Timeframes aus — erst dann wird dieses Feld fachlich relevant.

Option (später, als eigenes Versionsereignis): `changePctBars { n }` als neues Feld
einführen, `changePct24h` **deprekieren** aber nicht entfernen.

## Akzeptanzkriterien

- [ ] Kein Template nutzt `changePct24h` ohne Semantik-Hinweis
- [ ] Keine stille Umrechnung

## Versions-Hinweis

N/A (Doku-Hinweis im Template).
