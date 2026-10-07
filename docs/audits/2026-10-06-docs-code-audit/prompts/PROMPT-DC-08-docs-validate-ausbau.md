# PROMPT DC-08 — `docs:validate` um fünf Prüfungen erweitern

```text
TASK: Schließe die fünf Check-Lücken, durch die der Docs↔Code-Audit vom
2026-10-06 (DC-01…DC-07) unentdeckt bleiben konnte.

BEFUND (Audit docs/audits/2026-10-06-docs-code-audit/findings/DC-08-ci-waechter-luecken.md):
npm run docs:validate (9 Checks) ist grün, obwohl existierten:
  L1 4 dokumentierte Env-Flags ohne echten Read (DC-05)
  L2 diverse Code-Mengen ohne Doku (52 Tabellen; eine Route)
  L3 41 Versions-Header mit falschem Stand (DC-04)
  L4 dokumentierte Symbole/Pfade, die es nicht gibt (DC-06)
  L5 die Test-Suite läuft in keinem Workflow; tests/brokerContracts.test.ts
     scheitert ohne DB (2 Tests) statt zu skippen.
Der Env-Check prüft heute den QUELLTEXT mit Suffix-Whitelist
(_URL|_KEY|_TOKEN|_ENABLED|_DIR|_MS|_CTX|_PORT|_BASE|_PATH|_DATA|_AUDIT|_MODEL|
_PROVIDER|_BUDGET|_FLAG) statt echte Reads; _DAYS/_WEEKS/_VERSION/_PCT/_TYPE
fehlen darin.

VORBEDINGUNG: DC-04…DC-07 sind umgesetzt. Andernfalls NICHT starten — sonst
wird der verschärfte Wächter sofort rot.

DO (jeweils mit Unit-Test für den Check selbst, tests/docsValidate*.test.ts):
1. L1 — envReadsFromCode(): sammle Reads über die im Repo tatsächlich genutzten
   Idiome (process.env.X, process.env["X"], envInt/envNumber/env("X",
   readEnv/requireEnv, Konstante + env[CONST]). In CONFIGURATION.md/INSTALL.md/
   docs/CONFIGURATION.md genanntes Flag ohne Read => Fehler (Altpfad-Whitelist
   im Skript, mit Begründung).
2. L2 — Gegenrichtung als WARNUNG (nicht blockierend, damit der Check landen
   kann): (a) process.env.X ohne Erwähnung in CONFIGURATION.md oder .env.example;
   (b) Route unter src/app/api ohne Nennung in docs/**.
   Schwellenwert/Ausgabeliste begrenzen (z. B. erste 25).
3. L3 — Versions-Check auf alle docs/**/*.md außer archive/, audits/,
   peer-reviews/ erweitern: "Code-Version" muss package.json entsprechen.
   Header "Dokument-Version" ist explizit erlaubt und wird NICHT geprüft.
4. L4 — Symbol-/Pfad-Check: Backtick-Pfade `src/...`/`scripts/...` müssen
   existieren; Muster "`datei.ts` (`Sym1`, `Sym2`)" => jedes Symbol muss in der
   Datei als export vorkommen. Altpfad-Whitelist wie L1.
5. L5 — ENTSCHEIDUNG und Umsetzung (im Prompt-Output begründen):
   Variante A (empfohlen): tests/brokerContracts.test.ts bekommt das übliche
   DB-Skip-Muster der .db.test.ts-Dateien; dann "npm test" als Schritt in
   .github/workflows/main.yml aufnehmen (Quelle docs/ci/docs-validate.workflow.yml
   mitändern, danach Spiegel-Sync-Schritt per diff verifizieren).
   Variante B: Suite bleibt lokal; dann in CONTRIBUTING.md und docs/ci/README.md
   unmissverständlich festhalten, dass npm test NICHT CI-verpflichtend ist und
   welche Tests ohne DB scheitern.
6. Doku: docs/ci/README.md + Workflow-Kopfkommentar um die neuen Checks
   ergänzen (Zweck, Fehlerklasse, Whitelist-Logik).

AKZEPTANZ:
- `npm run docs:validate` grün; die vier neuen Checks erscheinen in der Ausgabe
  ("[docs-validate] OK — alle Docs-Checks gruen.").
- Gegenprobe je Check dokumentiert: künstlicher Bruch (z. B. Flag in
  CONFIGURATION.md erfinden) => Check wird rot; Bruch zurücksetzen.
- `diff -u docs/ci/docs-validate.workflow.yml .github/workflows/main.yml` und
  dieselbe Prüfung für security-live-gate: 0 (byte-identisch).
- Wenn Variante A: `npm test` läuft mit temporärem Embedded-PostgreSQL grün
  (42/42 in brokerContracts) und die Suite ist als Required-Check eingetragen
  bzw. dokumentiert, wie das in der Branch-Protection erfolgt.
```

## Hinweise für die ausführende Session

- Die Checks müssen **deterministisch und offline** laufen (CI ohne DB-Erwartung)
  — Ausnahme ist nur der optionale Test-Schritt aus L5-Variante A, der eine
  temporäre DB startet.
- Keine Prüfung darf bei einem frischen Clone mit fehlenden optionalen Ordnern
  crashen (existsSync-Guards, wie im bestehenden Skript).
- Die Whitelists (Altpfade) sind Code, nicht Doku-Text: Kommentar mit Begründung
  an jede ausgenommene Zeile.
