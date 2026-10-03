# STX-14 — `changePct24h` misst 97 Perioden, nicht 24 Stunden

- **ID:** STX-14
- **Severity:** LOW
- **Bereich:** Handelslogik / Semantik
- **Quelle:** Ausbaudokument (nicht erwähnt)
- **Status:** PARTIAL — Abgleich 2026-10-03: Semantik-Prüfung im Validator vorhanden (06-01, `v0.10.0`); Feld-Deprekation offen
- **Datei(en):** `src/lib/ruleEngine.ts`, `src/lib/ruleFieldCatalog.ts`

## Abgleich 2026-10-03

- **Geprüfter Stand:** `main` @ `3d13161` · Code-Version `0.10.6` (Beta)
- **Eingestuft:** `◐` **PARTIAL** — von `OPEN` korrigiert: die Prüfung existiert, die Deprekation nicht
- **Abgleich-Bericht:** [`../remediation/RECONCILE-2026-10-03.md`](../remediation/RECONCILE-2026-10-03.md)

**Nachweise**

- Prüfung vorhanden: `src/strategies/validator/assumptions.ts:156` (`CHANGE_PCT_SEMANTICS` in der Prüfungsliste), `:181` (Kategorie `DATA`), `:208` (Severity `WARNING`), `:903-920` (Implementierung), `:968` (Registrierung); Semantik-Text aus `RULE_FIELD_LABELS`
- Test `tests/strategyValidation.assumptions.test.ts:536` („genutztes Feld ⇒ VIOLATED (WARNING, STX-14)"), ausgeführt und **grün**
- **Keine** stille Umrechnung: `src/lib/ruleEngine.ts:700-706` — 97-Perioden-Rechnung unverändert, mit erklärendem Kommentar
- **Offen:** `changePctBars` existiert nicht (`grep -rn "changePctBars" src/` → 0 Treffer)
- **Einordnung:** keines der sechs Templates nutzt `changePct24h` (`grep` in `src/strategies/` findet nur die Validator-Prüfung). Die Deprekation ist damit ohne aktuellen Konsumenten — bewusst zurückgestellt, siehe [`../ROADMAP.md`](../ROADMAP.md) §„Zurückgestellt — warum jetzt nicht sinnvoll"

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
