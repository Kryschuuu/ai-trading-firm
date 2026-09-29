# STX-04-02 — Strategy-Catalog-Service + Lifecycle-Bridging

- **Phase:** 4 · **Paket:** 04-01, 00-02 · **Finding:** STX-06, STX-17
- **Risiko:** mittel

## Zweck

Templates aus dem Code in **unveränderliche, referenzierbare Versionen** überführen und
sie so mit dem Lifecycle verbinden, dass `BACKTEST_PENDING` eine **auflösbare**
`(strategy_key, strategy_version)` bekommt — statt eines Freitext-Labels.

## Kontext

`src/strategyLifecycle/` exportiert bereits alles Nötige:
`normalizeStrategyKey`, `normalizeStrategyVersion`, `canonicalJson`,
`evidenceContentHash`, `evidenceIdempotencyKey`, `ensureLifecycleDraft`,
`recordEvidence`, `evaluatePromotionGate`.

`strategy_lifecycle_evidence.result` ist per CHECK auf
`('PASS','FAIL','INCONCLUSIVE')` beschränkt — das ist exakt das Zielvokabular des
Validators (06-04). **Kein Schema-Umbau nötig.**

## Auftrag

Lege `src/strategies/service.ts` an. Muster: `src/strategyLifecycle/service.ts` und
`src/lib/ruleService.ts` (Transaktionen, `writeAuditRecord`, `telemetry`).

1. **`ensureDefinition(input)`** — legt eine `strategy_definitions`-Zeile an oder gibt
   die bestehende zurück. Idempotenz über `(template_id, name)`.

2. **`createVersion(input): Promise<{versionId, version, fingerprint}>`**
   - Template + Params + Timeframe ⇒ `compileTemplate()` (03-09)
   - bei `{ok:false}` ⇒ **wirf** (dies ist ein Programmierfehler, kein Laufzeitfall)
   - `fingerprint` prüfen: existiert ⇒ **bestehende Zeile zurückgeben** (Idempotenz)
   - sonst `INSERT` in `strategy_versions`
   - **`INSERT` und `INSERT` in `strategy_lifecycle_states` (`ensureLifecycleDraft`)
     in EINER Transaktion**
   - `writeAuditRecord({ action: "strategy_version_created", … })` mit
     `versionId`, `fingerprint`, `templateId` — **ohne** Params-Inhalte im Log
     (Bounded-Label-Regel; vollständige Daten stehen in der Tabelle)
   - Telemetrie: `strategy_versions_total{result}`

3. **`strategyKeyFor(versionRow)`** — deterministische Brücke zum Lifecycle:
   ```
   `<template_id>@v<version>`   // z. B. "ema-adx-trend@v3"
   ```
   über `normalizeStrategyKey` aus `strategyLifecycle/evidence.ts` normalisiert.
   *Kein* Freitext vom Aufrufer — der Key ist **abgeleitet**, damit er nicht
   auseinanderlaufen kann.

4. **`getVersionByFingerprint(fp)`**, **`listVersions(definitionId)`**,
   **`resolveStrategyKey(versionId)`**.

5. **Drift-Wächter (der eigentliche Mehrwert):** `checkTemplateDrift(versionId)` —
   vergleicht `template_version` + `code_version` der gespeicherten Version mit dem
   **aktuellen** Katalog. Ergebnis: `CURRENT` | `TEMPLATE_ADVANCED` | `CODE_ADVANCED`.
   *Nichts automatisch ändern* — nur **melden**. Eine Version 1 mit `template_version: 1`
   bleibt auch bei Katalog-Version 2 rekonstruierbar (Parameter + `rule_spec_json`
   sind gespeichert).

6. **Kein** automatisches `ensureLifecycleDraft` bei jedem Lesen — nur beim Anlegen.

## Akzeptanzkriterien

- [ ] `createVersion` mit gleichen Params ⇒ **kein** zweiter `INSERT`, gleicher `versionId`
- [ ] `createVersion` läuft bei Compile-Fehlern in einen Rollback, keine Teilpersistenz
- [ ] `strategyKeyFor` ist stabil und passt durch `normalizeStrategyKey`
- [ ] `checkTemplateDrift` erkennt einen Katalog-Sprung, **ändert** aber nichts
- [ ] `strategy_lifecycle_states`-Zeile existiert nach `createVersion` mit Zustand `DRAFT`
- [ ] Audit-Eintrag + Telemetrie mit **bounded** Labels (keine Params im Label)
- [ ] `tests/strategyCatalog.service.test.ts` grün
- [ ] `npm run typecheck && npm run lint && npm test` grün

## Tests

- Idempotenz: 3× `createVersion` mit identischen Params ⇒ 1 Zeile
- Transaktion: Compile-Error ⇒ 0 Zeilen in **beiden** Tabellen
- Drift: Katalog-Version manuell erhöhen ⇒ `TEMPLATE_ADVANCED`
- `strategyKeyFor` gegen `normalizeStrategyKey` für alle 6 Template-IDs
- Versions-Kette: `v1` → `v2` erzeugen; `v1` bleibt unverändert lesbar

## Gesperrt

- **Keine** Änderung an `src/strategyLifecycle/**` (der Service **ruft** ihn auf).
- **Keine** automatische Promotion, kein `requestTransition` aus diesem Service.
- **Kein** Update/Delete auf `strategy_versions`.
- Kein Lesen von `rule_spec_json` für Ausführung — die **Live-Ausführung** bleibt beim
  bestehenden `trade_rules`-Pfad. Dieser Service ist Registry, nicht Executor.
