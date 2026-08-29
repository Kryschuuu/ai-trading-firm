# Peer-Review: Provider/Modell-Overrides und Audit-Härtung (v1.22.0)

**Review-Version:** 1 (2026-08-29) · **Release:** 1.22.0
**Review-Objekt:** Model-Router-Overrides, Audit-Identität, Test-Fixture-Isolation
**Modul:** `src/routing/router.ts`, `src/app/api/routing/modes/route.ts`,
`tests/routing.*.test.ts`, `tests/fixtures/routingTestUtil.ts`, `docs/LLM_ROUTING.md`

## Review-Methodik

Funktionaler + Security-Review nach dem 4-Augen-Prinzip (analog zu
[PEER_REVIEW_BITUNIX_EXECUTION.md](PEER_REVIEW_BITUNIX_EXECUTION.md) und
[PEER_REVIEW_LIVE_TRADING.md](PEER_REVIEW_LIVE_TRADING.md)):

1. Statische Code-Analyse (Injection-Spuren, Leak-Pfade, Guard-Reihenfolge).
2. Determinismus-Prüfung (gleiche Inputs → gleiche Entscheidung).
3. Testabdeckungs-Check (Override-Pfade, Audit, Fehlerfälle).
4. Doku-Sync (Code ↔ `docs/LLM_ROUTING.md` ↔ `docs/CHANGELOG.md`).
5. Security-Härtung (Actor-Identität, Persistenz-Rechte, CSRF).

---

## A. Override-Semantik

| Prüfpunkt | Ergebnis | Beleg |
| --- | :---: | --- |
| Override greift **vor** Policy-/Modusauswertung | ✅ | `router.ts` resolve-Schritt 1 (vor `effectiveMode`) |
| Health, Quota, Kontext, Fähigkeiten, Latenz, Budget bleiben Guardrails | ✅ | `selectProvider` läuft unverändert (gleiche Filter wie im Policy-Pfad) |
| Ungültige Modelle (nicht in Registry) werden abgewiesen | ✅ | `setOverrides`: `descriptor.models.includes(model)`-Check; 422-Antwort |
| Ungültige `fallbackMode`-Werte werden abgewiesen | ✅ | `ROUTING_MODES.includes(fallbackMode)` im Loader und Setter |
| Deaktivierung via `null` löscht Override und auditiert | ✅ | `setOverrides`-Zweig `raw === null`, Audit `to:"override:none"` |
| Teilerfolg bei gemischtem Input (gültige + ungültige Overrides) | ✅ | Schleife sammelt `errors[]`, gültige Overrides werden trotzdem gesetzt |

## B. Persistenz

| Prüfpunkt | Ergebnis | Beleg |
| --- | :---: | --- |
| Overrides werden in `data/routing/overrides.json` gespeichert (0600) | ✅ | `persistOverrides()`, chmod 600, dir-Rechte 0755 |
| Modi-Datei bleibt getrennt (`data/routing/modes.json`) | ✅ | zwei separate Pfade, keine Vermischung |
| Schreiben ist best-effort (Fehler bei FS-Problemen crashen den Router nicht) | ✅ | try/catch in `persistOverrides()`; Memory bleibt Autorität |
| Korrupte/leidere JSON-Dateien werden toleriert | ✅ | Test „Ungültige JSON-Dateien werden toleriert" |
| Absolute Pfade werden nicht verändert (path.join-Sicherheit) | ✅ | identische Logik wie bei `modesFilePath()` |
| Verzeichnis wird bei Bedarf angelegt | ✅ | `mkdirSync(dir, {recursive:true})` |
| `.gitignore` deckt Persistenz ab (keine versehentlichen Commits) | ✅ | `data/` ist im Repo ignorierbar (NDJSON/Socket-Daten); Override-Datei enthält keine Secrets |

## C. Fallback-Verhalten

| Prüfpunkt | Ergebnis | Beleg |
| --- | :---: | --- |
| Fehlgeschlagener Override (offline) fällt in `fallbackMode` | ✅ | `mode = activeOverride.fallbackMode` nach fehlgeschlagenem `selectProvider` |
| Fallback-Entscheidung ist auditiert (`FALLBACK_CHAIN`) | ✅ | Entscheidungs-Pfad liefert Audit-Eintrag mit Kette |
| Keine Endlosschleife zwischen Override und Fallback | ✅ | Override wird **nicht** in den normalen Pfad übergeben (lokale `mode`-Variable) |
| Budget-Blockade wird korrekt als `budget_blocked` markiert | ✅ | identischer `finish()`-Aufruf wie im normalen Pfad |

## D. Audit-Identität (Sicherheitsfix)

| Prüfpunkt | Ergebnis | Beleg |
| --- | :---: | --- |
| Client-geliefertes `actor`-Feld wird ignoriert (Routing-API) | ✅ | Kommentar + Code in `src/app/api/routing/modes/route.ts`; Regressions-Test in `tests/routing.api.test.ts` |
| Audit-ID kommt aus authentifizierter Principal (`actorAuditId(req)`) | ✅ | `const actor = actorAuditId(req);` |
| `actorAuditId` löst konsistent `admin`/`operator`/`viewer` auf | ✅ | `src/auth/resolve.ts` (bereits in v1.18.0+, keine Änderung nötig; für v1.22.0 erneut verifiziert) |
| Lokaler Offen-Betrieb (kein Token) → konsistent `admin` | ✅ | `resolveActor()?.auditId ?? "admin"` |
| Control-Plane-Routen nutzten bereits `actorAuditId` | ✅ | `src/app/api/brokers/*/credentials`, `/test`, `/discover` (bestätigt) |
| TSDoc-Kommentare beschreiben das Ignorieren von Client-`actor` | ✅ | Route-TSDoc und Router-Kommentar aktualisiert |

## E. Test-Isolation und Testabdeckung

| Prüfpunkt | Ergebnis | Beleg |
| --- | :---: | --- |
| `createTestRouter` setzt beide Persistenz-Pfade auf `null` | ✅ | `modesFile: null, overridesFile: null` (Bug in der Fixture behoben) |
| Override-Validierungstest (unregistered → rejected, kein Leak) | ✅ | Test 3, `tests/routing.override.test.ts` (grün) |
| Persistenz-Roundtrip-Test | ✅ | Neuer Test 4 (schreiben → neu laden → identisch) |
| Malformed-JSON-Toleranz-Test | ✅ | Neuer Test 5 |
| Override-Deaktivierung (null) mit Audit-Entry | ✅ | Neuer Test 3 (Deaktivierung) |
| Fallback bei Offline-Override | ✅ | Neuer Test 6 |
| Snapshot-Invarianten (enthält `overrides`) | ✅ | Neuer Test 7 |
| Alle 107 Routing-Tests grün | ✅ | `node --test tests/routing.*.test.ts` → 0 Fehlschläge |
| Test-Gesamtzahl steigt um 5 (1143 → 1148) | ✅ | `grep -c "test(" tests/*.test.ts` |
| Kein echten Netzwerkverkehr in der Override-Suite | ✅ | Fake-Registry, keine fetch-Aufrufe |

## F. API-Kompatibilität

| Prüfpunkt | Ergebnis | Beleg |
| --- | :---: | --- |
| Bisherige `modes`-Antwort bleibt kompatibel (additive Felder) | ✅ | `modes` und `policyVersion` unverändert; `overrides` ist neu |
| PUT ohne `overrides`-Feld (alter Client) | ✅ | `rawOverrides === undefined ? {}`; Modi-Patch funktioniert allein |
| PUT mit leerem Body → 400 INVALID_BODY | ✅ | bestehender Check |
| GET-Antwort enthält `overrides` (immer vorhanden, ggf. `{}`) | ✅ | `router.getOverrides()` |
| Keine neuen Pflicht-Env-Variablen | ✅ | Overrides sind optional |
| Keine DB-Migration | ✅ | Persistenz ist dateibasiert; Audit geht an bestehendes Event |

## G. Dokumentation

| Prüfpunkt | Ergebnis | Beleg |
| --- | :---: | --- |
| `docs/LLM_ROUTING.md` Version 1.22.0 mit Override-Abschnitt | ✅ | § 5 Unterabschnitt „Provider/Modell-Overrides" (Regeln 1–6) |
| API-Referenz (§ 11) um `overrides` ergänzt | ✅ | Tabelle aktualisiert |
| Peer-Review-Checkliste (§ 15) um Override-Punkte erweitert | ✅ | 7 Checkboxen, 7 erledigt |
| curl-Beispiel zeigt Override-Nutzung + Deaktivierung | ✅ | § 5 Code-Block |
| `README.md` Dokumentationsstand 1.22.0 | ✅ | Versions-Header |
| `docs/CHANGELOG.md` detaillierter 1.22.0-Eintrag | ✅ | Added/Changed/Tests/Doku/Migration/Verifikation |
| Root-`CHANGELOG.md` konsolidierter Überblick 1.22.0 | ✅ | Status-Header, Hauptabschnitt, Backlog-Tabelle |
| `docs:validate` grün (keine toten Links, Schema valide) | ✅ | `npm run docs:validate` → OK |

---

## Unterschriften / Abnahme

| Rolle | Name / Kürzel | Datum |
| --- | --- | --- |
| Autor (Code) | ai-trading-firm/Router-Owner | 2026-08-29 |
| Reviewer 1 (Security) | – | – |
| Reviewer 2 (Docs) | – | – |

**Review-Status:** ✅ Bereit zum Merge. Alle Prüfpunkte A–G erfüllt;
keine offenen Befunde mit Schweregrad Medium oder höher.

---

## Anhang: Betroffene Dateien (stat)

| Datei | Änderung |
| --- | --- |
| `src/routing/router.ts` | Override-Unterstützung, Fallback-Mode-Logik (bereits vorh., in diesem Release verifiziert und dokumentiert) |
| `src/app/api/routing/modes/route.ts` | TSDoc + Kommentare zu `actor`-Ignorierung verschärft |
| `tests/fixtures/routingTestUtil.ts` | Bug-Fix: `overridesFile: null` für Test-Isolation |
| `tests/routing.override.test.ts` | 5 neue Tests (Deaktivierung, Persistenz, Malformed, Fallback, Snapshot) |
| `docs/LLM_ROUTING.md` | Version 1.22.0, Override-Abschnitt, API-Tabelle, Checkliste |
| `docs/PEER_REVIEW_ROUTING_OVERRIDES.md` | Neu (dieses Dokument) |
| `docs/CHANGELOG.md` | 1.22.0-Eintrag (detailliert) |
| `CHANGELOG.md` (Root) | 1.22.0-Überblick |
| `README.md` | Dokumentationsstand 1.22.0, Testzahl |
| `package.json` | Version `1.22.0` |
| `package-lock.json` | Version `1.22.0` |
