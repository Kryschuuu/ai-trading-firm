# STX-06 — Kein versioniertes Strategie-Artefakt im Anwendungsdienst persistiert

- **ID:** STX-06
- **Severity:** MEDIUM
- **Bereich:** Persistenz / Strategy-Lifecycle
- **Quelle:** Ausbaudokument §7
- **Status:** FIXED — Abgleich 2026-10-03: Schema 04-01 (`v0.8.0`) **und** Service 04-02 (`v0.10.4`, `66be0c6` PR #202, Fix `9d73aeb` PR #203) vorhanden
- **Datei(en):** `drizzle/2026-10-01_strategy_catalog.sql`, `src/db/schema.ts`, `tests/strategyCatalog.db.test.ts`

## Abgleich 2026-10-03

- **Geprüfter Stand:** `main` @ `3d13161` · Code-Version `0.10.6` (Beta)
- **Eingestuft:** `☑` **FIXED** — von `IN ARBEIT` hochgestuft; Idempotenz-Nachweis **nicht verifizierbar**
- **Abgleich-Bericht:** [`../remediation/RECONCILE-2026-10-03.md`](../remediation/RECONCILE-2026-10-03.md)

**Nachweise**

- `src/strategies/service.ts` — `calculateVersionContentHash()` `:95-113` (`stv1:<sha256>` über `canonicalJson`), `ensureDefinition()` `:147`, `getVersionByFingerprint()` `:260`, `createVersion()` `:328`, `checkTemplateDrift()` `:492`
- Modulkopf `service.ts:10-13` — kein Update/Delete auf `strategy_versions`, kein `requestTransition`, Live-Ausführung bleibt beim `trade_rules`-Pfad
- `STRATEGY_CLASSES` wird aus der SSoT `src/lib/marketRegime.ts` gelesen (Import `service.ts:30`) — der vierte Altlast-Fall aus 00-03 ist behoben
- Aufrufer: `scripts/run-screening.ts:671-694`, `scripts/run-validate-strategy.ts:461-484`
- **Nicht verifizierbar:** `tests/strategyCatalog.service.test.ts` und `tests/strategyCatalog.db.test.ts` benötigen PostgreSQL, das in der Abgleich-Umgebung nicht installiert ist (`pg_isready` fehlt). Die Abnahmekriterien „gleiche fachliche Eingabe ⇒ dieselbe Version" und „Rekonstruktion über den Service" sind deshalb **code-seitig benannt, laufzeitseitig ungeprüft**.

## Beschreibung

Die zentrale Diagnose war bestätigt: `strategy_lifecycle_states` trug
`strategy_key` (Freitext) und `strategy_version` (Integer ≥ 1), aber kein
rekonstruierbares Artefakt. 04-01 ergänzt nun `strategy_definitions` und
`strategy_versions` als persistierbares Schema. **Noch fehlt** der Dienst, der
kompilierte Templates dort idempotent speichert und wieder ausliest; daher ist
die Diagnose erst teilweise behoben und STX-06 bleibt bis 04-02 in Arbeit.

## Beweis / aktueller Stand

```sql
strategy_definitions (id, template_id, strategy_class, name, description, ...)
strategy_versions (
  id, definition_id, version, params_json, rule_spec_json, timeframe,
  fingerprint, content_hash, code_version, template_version, ...
)
```

Die Tabellen sind leer zu bootstrappen. `template_id` ist ein code-owned Katalog-Slug,
kein FK. `content_hash` und `fingerprint` sind UNIQUE; Versionen sind je Definition
eindeutig. Bestehende `strategy_lifecycle_states`-Zeilen bleiben unverändert gültig.
Ein Anwendungs-Schreib-/Lesepfad und die Zuordnung einer Lifecycle-Zeile zu
`strategy_versions.id` gehören, falls umgesetzt, in 04-02.

## Remediation

1. **Erledigt in 04-01 (`v0.8.0`):** Append-only, idempotente Migration für
   `strategy_definitions` und `strategy_versions`, Drizzle-Spiegel und DB-Tests.
2. **Erledigt in 04-01:** `UNIQUE (definition_id, version)`, `UNIQUE (fingerprint)`
   und `UNIQUE (content_hash)`; der Content-Hash ist der Retry-/Replay-Anker.
3. **Noch offen in 04-02:** Service für deterministische Persistenz und Rekonstruktion
   aus den versionierten Spalten. Der optionale nullable FK `strategy_version_id`
   auf `strategy_lifecycle_states` ist wegen des expliziten Locks auf
   `strategy_lifecycle_*` bewusst ausgeschlossen; eine erneute Prüfung erfordert
   einen separat abgestimmten Scope.

## Akzeptanzkriterien

- [x] Append-only; keine Änderung bestehender Migrationen
- [x] `content_hash` ist eindeutig und formatvalidiert
- [x] Bestehende Lifecycle-Zeilen bleiben gültig; kein Backfill
- [ ] Idempotenter App-Service: gleiche fachliche Eingabe ⇒ dieselbe Version
- [ ] Versionierte Artefakte können über den Service rekonstruiert werden

## Versions-Hinweis

`v0.8.0` liefert die additive Schema-Grundlage (04-01). STX-06 bleibt bis zum
Schreib-/Leseservice aus 04-02 **in Arbeit**.
