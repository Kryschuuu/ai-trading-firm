# Evidence — Prüfnachweise des Audit-Zyklus 2026-10-06

Alle Angaben reproduzierbar mit dem Stand `v0.17.2` (Prüfbasis `main` @ `104aaef`,
Audit-Session 2026-10-06, Node v22.22.3). Die vollständigen Log-Rohdateien der
Audit-Session (Typecheck/Lint/docs:validate/Testlauf, zusammen ca. 2 MB) liegen
**nicht** im Repo; die auswertbaren Kennzahlen stehen hier und in
[`../../../DOCS_CODE_AUDIT_2026-10-06.md`](../../../../DOCS_CODE_AUDIT_2026-10-06.md) §0.1.

| Prüfung | Kommando | Ergebnis (2026-10-06) |
|---------|----------|----------------------|
| Typecheck | `npm run typecheck` | exit 0, keine Ausgabe |
| Lint | `npm run lint` | exit 0, keine Ausgabe |
| Docs-Wächter | `npm run docs:validate` | „OK — alle Docs-Checks gruen." (9 Checks, 10 Hilfe-Dateien) |
| Volle Suite (vor den Fixes) | `npm test` | 4.760 Tests · 4.722 pass · **2 fail** · 36 skip · 237 s |
| Volle Suite (nach DC-01/DC-02/DC-03) | `npm test` | 4.769 Tests · 4.731 pass · **2 fail** · 36 skip · 229 s — (Δ = 9 neue Regressionstests, dieselben 2 DB-bedingten Fehler; die Logdatei selbst ist per `.gitignore` nicht versioniert) |
| Neue Regression DC-01 | `node --import tsx --test tests/proposalApprove.auth.test.ts` | 7/7 grün |
| Neue Regression DC-02 | `node --import tsx --test tests/firmHumanApproval.parity.test.ts` | 2/2 grün |
| Angepasst | `node --import tsx --test tests/routes.asyncParams.test.ts` | 6/6 grün |

**Die 2 Fehler sind Umgebungsartefakte, keine Produktfehler:** beide in
`tests/brokerContracts.test.ts` (`:154` `PaperBroker.submitAtomic`, `:284`
Fehlermeldungs-Konsistenz), beide `ECONNREFUSED 0.0.0.0:5432` — es läuft kein
PostgreSQL in der Sandbox. Mit temporärem Embedded-PostgreSQL besteht die Datei
laut `CHANGELOG.md` 42/42. Genau diesen Zustand adressiert Prompt
[DC-08](../../prompts/PROMPT-DC-08-docs-validate-ausbau.md) (L5).

## Mengen-Kennzahlen des Abgleichs

| Metrik | Wert | Quelle |
|--------|------|--------|
| `docs/`-Markdown-Dateien | 338 (≈ 54.800 Zeilen) | `find docs -name '*.md'`, `cat` |
| Geroutete API-Endpunkte | 87 `route.ts` in 16 Namespaces | `find src/app/api -name route.ts` |
| Routen ohne Doku-Pfad vor DC-03 | 1 (`/api/firm/execution-quality`) | Doku-Mengenabgleich |
| Firm-Routen ohne Guard vor DC-01 | 4 (3× nur `GET`, 1× `POST`) | Guard-Scan |
| Drizzle-Tabellen | 67 `pgTable`, 0 `pgEnum` | `src/db/schema.ts` |
| Migrationen | 34 | `drizzle/*.sql` |
| Versions-Header auf Code-Stand | 4 von 45 (vor DC-04) | Header-Regex |
| Dokumentierte Symbole ohne Code | 10 | rekursive `grep` in `src/`+`scripts/` |
| Env-Flags ohne echten Read | 4 (+1 falscher Name) | `process.env`-Idiom-Scan |
