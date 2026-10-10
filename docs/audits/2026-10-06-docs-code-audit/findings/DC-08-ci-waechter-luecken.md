# DC-08 — `docs:validate` sieht die Drift nicht (fünf Check-Lücken)

- **ID:** DC-08
- **Severity:** MEDIUM
- **Bereich:** CI / Docs-as-Code
- **Quelle:** Docs↔Code-Audit `v0.17.2`, Abgleich der gefundenen Drift gegen die Check-Matrix
- **Status:** ☑ **FIXED** (2026-10-10) — Umsetzung und Counterprobe-Belege unten
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

## Umsetzung und Entscheidungen (2026-10-10)

**L1–L4 sind umgesetzt** in `scripts/docs-validate-checks.ts` und verdrahtet in
`scripts/docs-validate.ts`. Die Checks sind statische/offline-fähige
Prüfungen. L1 löst dokumentierte Env-Namen über TypeScript-AST auf, einschließlich
Injected-Env-Maps, `env[name]`, einschließlich `this.env[name]` in den Broker-
Secret-Stores (statischer Schlüssel über `get(KEY_NAME)`), Helpern, Konstanten
und benannten/`export *`-Barrels. L2 bleibt ausdrücklich **nicht blockierend** und begrenzt seine Ausgabe.
L3 prüft aktive Doku-Header gegen `package.json`, ohne `Dokument-Version` zu
koppeln. L4 prüft konkrete `src/`-/`scripts/`-Pfade und benannte Exporte mit
begründeten Altpfad-Ausnahmen.

Die fünf initialen L2-Treffer wurden bewertet und dokumentiert statt
wegzuwhitelisten: `ALPACA_ALLOWED_HOSTS`, `ALPACA_DATA_BASE_URL`,
`ALPACA_TRADE_BASE_URL` und `CAPABILITY_STRICT` sind in der Konfigurations-
und Fachdoku erklärt; `SCREENING_PRIORITY_CONFIG_FILE` ist als Loader-API-
Einstieg dokumentiert. Die Doku hält ausdrücklich fest, dass das aktuelle
`scripts/run-screening.ts` diesen Loader noch nicht aufruft und weiterhin die
Default-Config injiziert. L2 meldet damit auf dem geprüften Stand 0 Warnungen;
neue Drift bleibt dennoch non-blocking sichtbar. Die Env-Semantik wurde zusätzlich
gegen die Implementierung geprüft: `CAPABILITY_STRICT` kann strict in Produktion
nicht mit `false` abschalten; `ALPACA_RETRY_MAX` hat Default 3, Bounds [1, 5]
und zählt Gesamtversuche inklusive Erstrequest. HTTP 429 darf für jede Methode
wiederholt werden; Timeout-, Netzwerk- und 5xx-Retries sind auf idempotente
Requests begrenzt (standardmäßig GET).

**L5: Variante A gewählt und umgesetzt.** `tests/brokerContracts.test.ts`
startet ein isoliertes temporäres Embedded-PostgreSQL und legt ein minimales
Schema für den echten `PaperBrokerAdapter.submitAtomic()`-Pfad an. Bei lokal
nicht startbarer optionaler DB-Infrastruktur skippen nur die zwei betroffenen
PAPER-Probes; Schema-/Query-Fehler sind Testfehler. Der Workflow setzt
`BROKER_CONTRACTS_REQUIRE_DB=true`, wodurch ein Startup-Ausfall in CI fehlschlägt.
`npm test` ist ein Schritt im Workflow-Job `docs-validate`; Branch Protection
muss exakt den Required Status Check **`docs-validate`** enthalten (zusätzlich
zum separat geführten `security-live-gate`). Die Laufzeitgrenze des Jobs wurde
auf 30 Minuten erweitert. Canonical/Mirror-Dateien bleiben byte-identisch;
`security-live-gate` wurde nicht geändert.

Kein Versions-Bump: `package.json` bleibt `0.17.2`; Release-/Versionsautomatisierung
gehört bewusst zu DC-09.

## Counterprobe-Evidenz

`tests/docsValidateChecks.test.ts` enthält vier Break-and-reset-Counterprobes:

| Check | Absichtlich gebrochen | Erwarteter Befund | Reset / Ergebnis |
| --- | --- | --- | --- |
| L1 | dokumentiertes Flag bleibt nur als Kommentar; echter `env[key]`-Read entfernt | dokumentiertes Env-Flag ohne Runtime-Read | Read wiederhergestellt; separater `this.env[name]`/`get(KEY_NAME)`-Fall und L1 grün |
| L2 | undokumentierter `process.env`-Read und neue API-Route ergänzt | beide werden als Warnung gefunden | Doku-Nennung ergänzt; Warnungen verschwinden |
| L3 | `Code-Version` von `0.17.2` auf `0.17.1` geändert | Paketversions-Drift wird gefunden | korrekte Code-Version bleibt grün; `Dokument-Version` allein ist erlaubt |
| L4 | ein fehlender `src/`-Pfad und ein nicht exportiertes Symbol dokumentiert | beide Referenzen werden gefunden | realer Pfad/Export wiederhergestellt; L4 grün |

Ausgeführt: `node --import tsx --test tests/docsValidateChecks.test.ts` — **4/4**.

## Verifikation nach Umsetzung (2026-10-10)

| Prüfung | Ergebnis |
| --- | --- |
| `npm run typecheck` | grün |
| `npm run lint` | grün |
| `npm run docs:validate` | grün: 12 Checks, 10 Hilfe-Dateien; L1–L4 sichtbar, L2 0 Warnungen |
| `tests/docsValidateChecks.test.ts` | 4 bestanden, 0 fehlgeschlagen |
| Normales `npm ci` (mit Install-Scripts) + PAPER-Contract-Lauf | Embedded-PostgreSQL-Linux-Binaries/Symlinks wurden regulär hydriert; **42 bestanden** |
| `tests/brokerContracts.test.ts` mit `BROKER_CONTRACTS_REQUIRE_DB=true` | **42 bestanden, 0 fehlgeschlagen, 0 übersprungen** |
| `BROKER_CONTRACTS_REQUIRE_DB=true npm test` | **4.790 Tests: 4.754 bestanden, 0 fehlgeschlagen, 36 optionale DB-Skips** |
| `diff -u docs/ci/docs-validate.workflow.yml .github/workflows/main.yml` | byte-identisch |
| `diff -u docs/ci/security-live-gate.workflow.yml .github/workflows/security-live-gate.yml` | byte-identisch; Security-Workflow unverändert |
