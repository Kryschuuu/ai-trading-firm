# DC-08 — `docs:validate` sieht die Drift nicht (fünf Check-Lücken)

- **ID:** DC-08
- **Severity:** MEDIUM
- **Bereich:** CI / Docs-as-Code
- **Quelle:** Docs↔Code-Audit `v0.17.2`, Abgleich der gefundenen Drift gegen die Check-Matrix
- **Status:** ☐ **OPEN**
- **Prompt:** [`../prompts/PROMPT-DC-08-docs-validate-ausbau.md`](../prompts/PROMPT-DC-08-docs-validate-ausbau.md)
- **Datei(en):** `scripts/docs-validate.ts`, `.github/workflows/main.yml` + `security-live-gate.yml` (bzw. `docs/ci/*.workflow.yml`), `tests/brokerContracts.test.ts`

## Beschreibung

`npm run docs:validate` (9 Checks) ist grün — und trotzdem existierten alle
Befunde DC-01…DC-07 unbemerkt. Der Grund ist strukturell: jeder Befund liegt in
einer Lücke der Check-Matrix.

| # | Lücke | Was fehlt | Belegt durch |
|---|-------|-----------|--------------|
| L1 | **Env-Check prüft den Quelltext, nicht `process.env`** | Doku-Flag muss einen echten Read besitzen; Suffix-Whitelist `_DAYS/_WEEKS/_VERSION/_PCT/_TYPE` fehlt | DC-05 (4 Flags ohne Read bleiben grün) |
| L2 | **Keine Gegenrichtung Code → Doku** | Flags/Routen/Tabellen im Code ohne Doku-Erwähnung | DC-05 Teil B, DC-07 (52 Tabellen), `GET /api/firm/execution-quality` (vor DC-03) |
| L3 | **Versions-Check nur für 2 Dateien** | `Code-Version`-Header **aller** Dokumente gegen `package.json` | DC-04 (41 Header driften ungestört) |
| L4 | **Symbol-Check fehlt vollständig** | Dokumentierte Backtick-Symbole/`src`-Pfade müssen existieren (mit Altpfad-Whitelist) | DC-06 (`matchRule`, `FunnelStageResult`, `workshop/InfoTip.tsx` …) |
| L5 | **Test-Suite ist in keinem Workflow** | `npm test` läuft weder in `main.yml` noch in `security-live-gate.yml`; zwei PAPER-Contract-Tests scheitern ohne DB **statt zu skippen** — die Zusage „DB-gegatete Tests überspringen sich" gilt nur für die übrigen Dateien | Reproduzierter Lauf 2026-10-06: 4.760 Tests, 4.722 pass, **2 fail**, 36 skip (`ECONNREFUSED 0.0.0.0:5432`); nach den DC-01/02-Fixes 4.769/4.731/2/36 — dieselben zwei Fehler (Zahlen in `remediation/evidence/README.md`) |

Zum Vergleich: Die Checks, die es gibt (Links, App-Links, Markdown-Lint,
Secrets, Env-Flags Doku→Code, Routen Doku→Code, Live-Gate-States,
Versions-Konsistenz für `CHANGELOG`/`docs/README.md`) haben den Audit an ihren
Zuständigkeitsgrenzen bestätigt — die Lücken sind präzise benannt, nicht diffus.

## Wirkung

Der Wächter erzeugt ein falsches Sicherheitsgefühl: „docs:validate grün" heißt
heute „Links, Lint, Secrets und vier Stichproben stimmen" — nicht „Doku
entspricht dem Code". Die Drift aus DC-04…DC-07 kann sich damit beliebig
fortsetzen, ohne dass ein PR rot wird.

## Lösungsvorschlag (Prompt DC-08)

1. **L1** — Env-Check ersetzen: Reads per AST/Regex auf `process.env.X`,
   `envInt("X")`, `envNumber("X")`, `env[…]`-Idiome sammeln; Doku-Flag ist
   Fehler, wenn kein Read existiert (bestehende Altpfade als Whitelist führen).
2. **L2** — Gegenrichtung als **Warnung** starten (nicht blockierend):
   `process.env.X` ohne Erwähnung in `CONFIGURATION.md`/`.env.example`;
   zusätzlich Route im Code ohne Erwähnung in `docs/**`.
3. **L3** — Versions-Check auf alle `docs/**/*.md` (ohne `archive/`, `audits/`,
   `peer-reviews/`) erweitern: `Code-Version`-Header muss `package.json`
   entsprechen; „Dokument-Version" ist ein anderer, erlaubter Header.
4. **L4** — Symbol-/Pfad-Check: Backtick-`src/…`-Pfade müssen existieren;
   Symbole in „`datei.ts` (`Sym1`, `Sym2`)"-Formen müssen in der Datei als
   Export vorkommen; Altpfad-Whitelist im Skript dokumentieren.
5. **L5** — Zwei Wege, bewusst entscheiden: (a) `brokerContracts.test.ts` sauber
   DB-gaten (Skip-Pattern wie `tests/*.db.test.ts`), dann `npm test` in
   `main.yml` aufnehmen; **oder** (b) Test-Suite bleibt lokal und der Skip-Pfad
   wird nur korrekt dokumentiert (DC-03 hat das getan) — dann ist (a) mittelfristig
   trotzdem zu empfehlen. Der Prompt muss die Entscheidung explizit festhalten;
   `docs/ci/*.workflow.yml` und `.github/workflows/*` müssen byte-identisch
   bleiben (Spiegel-Sync-Schritt).

## Verifikation nach Umsetzung

```bash
npm run docs:validate                 # neue Checks grün
diff -u docs/ci/docs-validate.workflow.yml .github/workflows/main.yml
# Gegenprobe: je Befund ein künstlicher Bruch, der rot werden MUSS (im Prompt-Output dokumentieren)
```
