# Security-Audit & Peer-Review — Autonome KI-Trading-Firma

**Audit-Stand:** 2026-08-25 · **Release:** v1.4.0 (enthält v1.1.0–v1.3.0)
**Scope:** gesamter Quellcode (`src/`, `scripts/`, `deploy/`, Konfiguration),
**Methode:** manuelle Code-Review + `npm audit` + statische Analyse (TS strict, ESLint)
+ Regressionstests.

---

## 1. Scoringsystem

| Schweregrad | Definition | Beispiele |
| --- | --- | --- |
| **Critical** | Geldfolge möglich, Guardrail umgehbar | — |
| **High** | Zustands-/Geldwerte gehen verloren, harte Sicherheitsschranke fehlt | S-01 |
| **Medium** | Funktionsfehler mit Sicherheitsbezug, Race, falsche HTTP-Semantik | S-02…S-08 |
| **Low** | Robustheit, Hygiene, DX | S-09…S-14 |
| **Info** | geprüft, kein Handlungsbedarf | I-01…I-04 |

---

## 2. Findings

| ID | Severity | Datei (Funktion) | Problem | Status |
| --- | --- | --- | --- | --- |
| S-01 | **High** | `src/lib/engine.ts` → `getBroker()` + `src/lib/broker.ts` → `hydrate()` | Nach Prozess-Neustart wurde Cash als `STARTING_EQUITY − Σ(entry·qty)` rekonstruiert; realisierte P&L geschlossener Trades gingen verloren (10.200 € → 10.000 €) | ✅ gefixt (v1.1.0) |
| S-02 | Medium | `src/lib/engine.ts` → `runAgentTurn()` | Tagesverlust-Fenster nutzte `setHours(0,0,0,0)` (Server-Localtime); systemd-UTC-Server zählten den Tag falsch, inkonsistent zum Monitor | ✅ gefixt (v1.1.0) |
| S-03 | Medium | `src/app/api/firm/tick/route.ts` → `GET()` | GET rief `POST` auf → Browser-Prefetch/Link-Checker lösten Kurs-Refresh und **SL/TP-Schließungen** aus (Zustands-Mutation per lesender Methode) | ✅ gefixt (v1.1.0) |
| S-04 | Medium | `src/lib/seed.ts` → `checkSchema()` + `scripts/setup-cachyos.sh` | `equity_snapshots` fehlte in der Pflichtliste → Healthcheck meldete `schemaReady:true`, obwohl Monitor-Snapshots/Equity-Kurve unbenutzbar waren; Setup prüfte 8 statt 9 Tabellen | ✅ gefixt (v1.1.0) |
| S-05 | Medium | `src/lib/monitor.ts` → `tick()`; `src/lib/engine.ts` → `runPipeline()` | Kein Single-Flight-Schutz: Scheduler + manueller `POST`/Doppelklick liefen parallel → doppelte Snapshots, doppelte Vorschläge/Audit-Einträge | ✅ gefixt (v1.1.0) |
| S-06 | Medium | `next.config.ts`, alle Seiten | Keine Security-Header (CSP, `X-Frame-Options`, `nosniff`) — lokale UI einbettbar (Clickjacking), fehlerhafte MIME-Interpretation | ✅ gefixt (v1.1.0) |
| S-07 | Medium | `src/lib/marketData.ts` (`getQuote`/`getCandles`), `src/lib/broker.ts` → `submit()`, `src/lib/engine.ts` → `runAgentTurn()` | Symbol aus Modell-Output/DB floss **ungeprüft** in externe URLs (Binance-Query), Prompts und JSONB — Query-Parameter-Injection/Injection über Prompt-Grenze möglich | ✅ gefixt (v1.1.0) |
| S-08 | Low | `src/app/api/firm/log/route.ts` | `limit=NaN` bzw. negativ → `limit(NaN)`/`LIMIT -5` → SQL-Fehler (500) | ✅ gefixt (v1.1.0) |
| S-09 | Low | `src/lib/engine.ts` → `runAgentTurn()` (Stop-Loss) | `stopLossPct:"abc"` → NaN-Position → Order pauschal geblockt statt ATR/Default-Fallback (kleines Modell liefert gern String-Werte) | ✅ gefixt (v1.1.0) |
| S-10 | Low | `src/lib/engine.ts` (Proposal-Insert) | `riskScore` ohne Validierung → Objekt/String aus Modell-Output konnte `numeric`-Insert sprengen (500) | ✅ gefixt (v1.1.0) |
| S-11 | Low | `scripts/drizzle.config.json` | Veraltete Konfiguration mit hardcodierten DB-Zugangsdaten im Repo; Fehlerquelle beim Schema-Push | ✅ entfernt (v1.1.0) |
| S-12 | Low | `scripts/smoke-test.sh` | Prüfte Health-Feld `status`/`SCHEMA_MISSING`, das die API nie liefert → Setup-Fehlerzweig tot | ✅ gefixt (v1.1.0) |
| S-13 | Low | `src/components/FirmDashboard.tsx`, `src/app/docs/page.tsx` | 10 Lint-Fehler (unescaped Entitäten, setState im Effekt) — Qualitäts-/Wartbarkeitsrisiko | ✅ gefixt (v1.1.0) |
| S-14 | Low | `src/instrumentation.ts` | Analysten-Slot-Key in Server-Localtime → Doppelstart-Schutz auf UTC-Servern unzuverlässig | ✅ gefixt (v1.1.0) |
| S-21 | Medium | `src/app/api/firm/run/route.ts`, `src/app/api/firm/tick/route.ts` | Rohe Fehlermeldungen in catch-Blöcken an Client zurückgegeben — DB-Connection-Strings und interne Stack-Traces konnten in HTTP-Responses landen | ✅ gefixt (v1.5.1) |
| S-22 | Low | `src/app/api/firm/route.ts` → `GET()` | Kein try/catch um die DB-Queries — unhandled exception bei DB-Ausfall mit potenziellem Stack-Trace-Leak | ✅ gefixt (v1.5.1) |
| S-23 | Low | `src/db/index.ts` → `new Pool(...)` | Connection-Pool ohne `max`-Grenze und Timeouts — potenzieller Ressourcenverbrauch unter Last | ✅ gefixt (v1.5.1) |
| H1 | **CRITICAL** | `src/lib/broker.ts` → `PaperBroker.submit`, `src/brokers/bitunix/paper.ts`, `src/brokers/alpaca/paper.ts`, `src/brokers/bitunix/execution.ts`, `src/brokers/alpaca/execution.ts` — `Order.riskNotional` als vertrauenswürdige Eingabe | `validateOrder({ notional: riskNotional })` + Cash-Guard `riskNotional > cash` vs. Abbuchung `qty*Fillpreis+Gebühren` (LONG `price*1.001` + Simulator-Fees/Slippage) — manipuliertes `riskNotional=1` bei `qty=1000` umgeht Guard, Kosten um Größenordnungen höher (Bsp. 2500 +0.1% Slippage + Gebühren) | ✅ gefixt (v1.36.2): server-seitig `estimatedNotional = qty*price` (finite>0), Guard + Cash-Guard nutzen ausschließlich `estimatedNotional`, `requiredCash = Notional+Gebühren+Slippage`, exakter Check `cost = filledQty*fillPrice+fees > cash` (Simulator) bzw. `qty*fillPrice` (Legacy) → `INSUFFICIENT_CASH`; Live-Engines idem gegen echte Venue-Cash (fail-closed) |
| I-01 | Info | `package-lock.json` | `npm audit`: **0 Vulnerabilities** (prod + dev) | ✅ geprüft |
| I-02 | Info | `src/lib/apiAuth.ts` | Timing-sicherer Token-Vergleich (`crypto.timingSafeEqual`), leere Token ≠ aktiv | ✅ geprüft |
| I-03 | Info | gesamte `src/` | Kein `eval`, kein `child_process`/`exec`/`spawn`, kein `dangerouslySetInnerHTML`; SQL nur via Drizzle (parametrisiert) | ✅ geprüft |
| I-04 | Info | `src/lib/ollama.ts` → `fallbackReason()` | Regel-Engine reagiert nur auf expliziten `[[REQUEST_KILL]]`-Marker, nicht auf Prompt-Texte (kein Keyword-Injection-Pfad) | ✅ geprüft |

---

## 3. Peer-Review der Fixes (selbstkritisch, je Fix)

**S-01 Hydration**
* Warum: Die DB enthält `equity_snapshots.cash` als einziges persistentes Cash-Artefakt; `hydrate()` hatte keinen Zugriff darauf.
* Was: `hydrate(rows, {cashHint})`; `getBroker()` liest den neuesten Snapshot; Fallback alte Logik.
* Review: Fallback nur bei fehlendem/ungültigem Snapshot — korrekt für Erststart. Kaputte Zeilen (qty ≤ 0, NaN, Preis ≤ 0) werden jetzt gefiltert. **Gegencheck** durch Test „Regression v1.1.0" (Cash 10200 bleibt 10200; Equity = cash + Marktwert). Side-/Positions-Zählung identisch; keine Seiteneffekte auf `close`/`submit`.

**S-02 Berlin-Tag**
* Warum: „Tag" ist im Handbuch explizit Europe/Berlin; zwei Rechenpfade widersprachen sich.
* Was: `startOfBerlinDay()` auch in `runAgentTurn()`.
* Review: `startOfBerlinDay` ist DST-getestet (bestehende `tests/time.test.ts`); dieselbe Funktion nutzt bereits Monitor/Equity. Kein neuer Codepfad.

**S-03 GET-Tick**
* Warum: HTTP-Semantik verletzt; Prefetch/Monitoring darf nie Trades auslösen.
* Was: GET → 405 mit Erklärung; POST unverändert.
* Review: Der Scheduler nutzt intern `tick()` direkt (kein HTTP-GET) — kein Bruch. Smoke-Test nutzt `curl` ohne Methode (GET) für `/?`; `smoke-test.sh` ruft `/api/firm/tick` **nicht** auf (Check: nur `report`, `equity`, `log`). ✓ keine Regression.

**S-05 Races**
* Warum: Zwei unabhängige Einstiegspunkte (Scheduler + API) teilen sich den Zustand.
* Was: `tick()` single-flight (Promise-Lock), `runPipeline()` Guard → 409.
* Review: Lock ist prozess-lokal; Multi-Prozess/Node bräuchte DB-Locks — als Backlog dokumentiert (Single-Node-Deployment). Deadlock-Risiko: `tick()` wird nie rekursiv aufgerufen; Lock wird in `finally` geräumt. Ein wartender Aufrufer erhält das laufende Ergebnis (kein Stau, keine Duplikate).

**S-06 Header**
* Warum: Browser-Angriffsfläche (Clickjacking, MIME-Sniffing, Referrer-Leak).
* Was: Header-Block in `next.config.ts`, nur `NODE_ENV === "production"`.
* Review: CSP erlaubt `'self'` + `'unsafe-inline'` (Next.js-Inline-Hydration, Styles) — keine externen Fonts/Skripte. `frame-ancestors 'none'` + `DENY` doppelt abgesichert. Dev unverändert (HMR/ws). Build-getestet (s. u.).

**S-07 Symbol-Whitelist**
* Warum: Modell-Output ist die einzige nicht-trustwürdige Eingabe mit Wirkung auf URLs/DB/Prompts.
* Was: `sanitizeSymbol()` (Whitelist-Regex), Anwendung in Marktdaten-Pfaden, `PaperBroker.submit` (INVALID_SYMBOL), Engine (BLOCKED + Audit + Trace).
* Review: Erlaubt `BRK.B`, `EURUSD=X`; blockt `$`, `&`, Quotes, Whitespace, >12 Zeichen. `getQuote` wirft bei ungültig → alle Aufrufer fangen bereits (Engine, Monitor, refreshQuotes). Parser-Tests decken Injection-Bytes ab. Kein Verhaltenstest-Bruch: alle Watchlist-Symbole sind gültig.

**S-08…S-10 Numerik**
* Was: Limit-Klemme, `Number.isFinite`-Guards, riskScore-Normalisierung.
* Review: Keine Verhaltensänderung bei gültigen Werten; Regressionstests für NaN/negativ/Objekt-Fälle. `clamp` bleibt für Zahlen.

**S-11 drizzle.config.json**
* Review: Keine Referenz im aktiven Tooling (Setup übergibt `DATABASE_URL` direkt); historische Erwähnungen in INSTALL.md bleiben als Warnung sinnvoll.

**S-12 Smoke-Test**
* Review: Feld `schemaReady` existiert in beiden Health-Zweigen; `// "UNKNOWN"`-Fallback bleibt sicher.

**S-13 Lint**
* Review: Entitäten gemäß React-Rule ersetzt; Effekt-Ladevorgänge via `useCallback` + verschobener Start — kein synchrones setState, keine Behavior-Änderung.

**S-14 Scheduler**
* Review: `berlinDayKey()` + `nowBerlin` ergeben stabilen 30-Min-Slot auch bei UTC-Servern; Double-Run-Schutz wirkt. **Nachtrag v1.4.0 (S-18):** der Slot-Key war minutengranular — Analysten liefen jede Minute. Fix: Zeitstempel-Abstand `ANALYST_INTERVAL_MIN`.

**S-15 Gemini-Key**
* Warum: Query-Parameter stehen in Access-Logs, Browser-History, `Referer`, manchen Error-Objekten.
* Was: `x-goog-api-key` Header; `listModels` ohne `?key=`.
* Review: Offizielle Gemini-API akzeptiert den Header. Tests prüfen, dass die Chat-URL kein `key=` enthält. Keys in Headers können weiterhin in Debug-Dumps landen — `redactSecrets` greift in Logs/Health.

**S-18 Analysten-Intervall**
* Review: Erstlauf nach ≤60 s (setInterval), danach echter Abstand ≥10 min. Penny/Swing-Pfad unverändert (Berlin-Stunde). `analystIntervalMs` war zuvor tot (nur Log-String).

**S-20 parseDecision-Allowlist**
* Review: Analysten dürfen Extra-Felder **nicht** verlieren — deshalb `extractJsonObject` als eigene API, `runOneAnalyst` umgestellt. Engine-Pfad sieht nur Allowlist. Prototype-Keys werden verworfen. Gegentest in `hardening.test.ts` + bestehender Pollution-Test.

**S-19 Slippage-Cash**
* Review: Nur der Fill-Zweig; Reject-Pfad unverändert. Bestehende Fill-Tests (0.1 BTC / 0.5 ETH) haben genug Cash-Puffer — keine Regression. Extremer Rand (Cash ≈ Notional) kann jetzt `INSUFFICIENT_CASH` statt leicht negativem Cash liefern — gewollt konservativ.

**S-21 Error-Leakage in API-Routen**
* Warum: Datenbankfehler (z.B. `pg` Connection-String in `err.message`) flossen 1:1 in HTTP-Responses. Ein Angreifer mit API-Zugang könnte so interne Infrastruktur-Details erfahren.
* Was: `publicErrorMessage(e)` in allen catch-Blöcken von `firm/run`, `firm/tick` und `firm` (GET).
* Review: `publicErrorMessage` nutzt `redactSecrets()` (Regex-basierte Pattern-Erkennung für postgresql://, Bearer, API-Keys) und kürzt auf 240 Zeichen. Audit-Log speichert weiterhin den vollen Fehler für Debugging. Bestehende Tests prüfen `redactSecrets` und `publicErrorMessage`.

**S-22 GET /api/firm ohne Fehlerbehandlung**
* Warum: 7 parallele DB-Queries ohne try/catch. Bei DB-Ausfall wirft Next.js einen 500 mit potenziell sensitivem Stack-Trace.
* Was: try/catch um den gesamten GET-Handler mit 503 und redacted Error.
* Review: Konsistent mit den anderen Routen (`missions/route.ts`, `agents/route.ts`), die bereits `publicErrorMessage` nutzen.

**S-23 DB-Pool-Konfiguration**
* Warum: Standard-pg-Pool hat max=20 Connections ohne Timeout. Unter Last (parallele Dashboard-Requests + Scheduler) könnten alle Pool-Slots belegt werden und der Service blockiert.
* Was: `max: 10`, `connectionTimeoutMillis: 5000`, `idleTimeoutMillis: 30000`.
* Review: 10 Connections reichen für Single-Node-Betrieb (max 4-5 parallele Queries). 5s Timeout verhindert ewiges Warten. Neue Tests prüfen die Konfiguration.

---

## 4. Testabdeckung nach Fixes

| Bereich | Tests | Status |
| --- | --- | --- |
| Indikatoren (RSI, EMA, ATR, Snapshot) | 6 | ✅ |
| Risiko-Guardrails & Ceilings | 7 | ✅ |
| `parseDecision` (inkl. Injection/Pollution) | 9 | ✅ |
| Berliner Zeit & DST | 8 | ✅ |
| **Broker** Hydration, Guardrails, Validierung | 10 | ✅ |
| **LLM-Provider** Builder/Parser/Retry/Kosten/Chain | 21 | ✅ |
| **Security** Symbole, Fallback, Kette | 6 | ✅ |
| **Härte** Secrets, Token, Rate-Limit, Intervalle, Allowlist | 18 | ✅ |
| **DB-Konfiguration (Neu v1.5.1)** Pool, Config, Header, Error-Leaks | 12 | ✅ |
| **Gesamt** | **116** | ✅ 116/116 |

Zusätzliche Verifikation (jede Release): `npm run typecheck` ✅ · `npm run lint` ✅ (0 Fehler) ·
`npm run build` ✅ · `npm audit` → 0 Vulnerabilities ✅.

---

## 5. Empfehlungen (Backlog)

1. **`FIRM_API_TOKEN` aktivieren**, sobald der Dienst außerhalb von 127.0.0.1 erreichbar ist (LAN/Cloud) — der Token-Schutz existiert, ist aber nur optional.
2. **Regelmäßiges `npm audit`** in die Deploy-Checkliste aufnehmen (`CI`-Job empfohlen).
3. **Live-Broker erst nach** Sicherheits-Checkliste (HANDBUCH Kapitel 11); kein Adapter im Auslieferungszustand.
4. **Rate-Limiting** ist seit v1.4.0 prozess-lokal aktiv (60/min). *Nachtrag v1.36.14:* Die Warnung „`x-forwarded-for` hinter einem Proxy nicht als Sicherheitsgrenze behandeln" ist umgesetzt — Befund C2 des Senior-Peer-Reviews (`AUDIT_REMEDIATION_2026-09.md`) behoben. `src/lib/clientIp.ts` (`resolveClientIp`) ist die einzige Quelle der Rate-Limit-Identität für Firm- und Credential-Limit: `x-forwarded-for` zählt nur bei konfigurierten `TRUSTED_PROXY_IPS` **und** verifiziertem Socket-Peer (rightmost-untrusted), `x-real-ip` nie, bevorzugt wird der proxy-gesetzte Header `x-verified-ip`. Ohne Proxy-Vertrauen gilt die Socket-Adresse, sonst der gemeinsame Bucket `local` (fail-closed). Dazu globaler IP-unabhängiger Credential-Deckel (20/min) und exponentieller Backoff ab dem 3. Fehlversuch.
5. **DB-gestützte Scheduler-Locks** bei Multi-Node-Betrieb (aktuell Single-Node; der Mikro-Executor nutzt bereits Advisory-Locks pro Symbol).

---

## 6. Audit-Ergänzung v1.6: Regelwerk (Makro/Mikro)

**Neue Angriffsfläche:** LLM-generierte Regeln (`trade_rules.condition`) sind
Daten, die die Ausführungsebene (Mikro-Zyklus) interpretiert. Bewertung:

| Prinzip | Umsetzung | Status |
| --- | --- | --- |
| Whitelist statt Interpreter | `RULE_FIELDS`/`RULE_OPS` in `ruleEngine.ts` — nur 13 Felder, 7 Operatoren; unbekannte Keys werden **verworfen** (auch `__proto__`, `constructor`) | ✅ |
| Klemmung statt Ermessen | `RULE_CEILINGS` = abgeleitet aus `LIMIT_CEILINGS` (Code) — eine Regel kann nie mehr Risiko fordern als die Guardrails | ✅ |
| Kein dynamischer Code | Regeln werden zu **Closures kompiliert** (Zahlenvergleiche), kein `eval`, kein SQL aus Regelfeldern; `symbol` läuft durch die Symbol-Regex | ✅ |
| Auditierter Lebenszyklus | DRAFT → ACTIVE → SUPERSEDED/…, jede Transition in `audit_log`; Rollback atomar | ✅ |
| Review-Pflicht | Backtest-API + Review-Checkliste (HANDBUCH Kap. 18); `REQUIRE_HUMAN_APPROVAL=true` hält Regeln im DRAFT | ✅ |
| Ausführungs-Härtung | Advisory-Lock pro Symbol, DB-Wahrheitsprüfung im Lock (Kill-Switch/Position/Mission), Guardrails + Broker-Schleuse als letzte Instanz | ✅ |
| LLM-Freiheit | Import-Graph-Guard-Test: `ruleEngine`/`microExecutor`/`ruleService`/`scripts/micro-executor` dürfen `ollama`/`llmProvider`/`engine`/`analysts` **nicht importieren** | ✅ |

**Verbleibende Restrisiken (dokumentiert, bewusst):** (1) Der interne
`PaperBroker` ist ein In-Memory-Ledger → im Paper-Modus genau **eine**
Executor-Instanz; (2) Makro-Prompts verarbeiten Marktdaten — die
Anti-Injection-Zeile ist ein weicher Schutz, die harte Grenze bleibt die
Whitelist; (3) `REQUIRE_HUMAN_APPROVAL=false` aktiviert Regeln automatisch
— erst nach Backtest + Paper-Phase umstellen.


---

## Security Audit — Task 01 (Market Universe, v1.8.0)

**Audit-Stand:** 2026-08-27 · **Scope:** `src/universe/**`,
`src/app/api/markets/**`, `scripts/seed-universe.ts`, `data/universe/**`,
Änderung an `src/lib/marketData.ts` (Deprecation der Watchlist).
**Methode:** manuelle Code-Review, Threat-Walkthrough der neuen Eingabepfade,
`npm audit`, TS-strict + ESLint, 301 Tests inkl. Injection-Fällen.

### Checkliste

- [x] **Input-Validierung** — Venue (`^[A-Z][A-Z0-9_]{1,15}$`), Symbol
  (`^[A-Z0-9]{1,20}(?:[/.\-_=][A-Z0-9]{1,10}){0,2}$`), ID-Konsistenz
  (`VENUE:SYMBOL`), Enum-Whitelists für `assetClass`/`marketType`/`status`,
  Zahlenbereiche für alle Handelsbedingungen und Metriken, ISO-8601-Prüfung für
  `lastSeen`. Fremdfelder werden verworfen, nicht durchgereicht.
- [x] **Größen-/Mengenlimits** — Batch ≤ 5000 Sätze, Seitengröße ≤ 500,
  Query-Parameter ≤ 200 Zeichen, ≤ 20 Werte je Mehrfachparameter,
  Freitextsuche ≤ 64 Zeichen, Policy ≤ 50 Regeln à ≤ 120 Zeichen.
- [x] **Parametrisierte Queries** — kein SQL im neuen Code; die optionale
  DB-Audit-Senke nutzt ausschließlich Drizzle-Inserts (parametrisiert).
  Die Freitextsuche ist ein `String.includes` auf der ID, **kein** Regex aus
  Benutzereingabe.
- [x] **Audit-Log** — jede Mutation (`UPSERT`, `BATCH_UPSERT`, `SEED`, `REMOVE`)
  erzeugt genau einen Eintrag mit `actor=system`, `source`, geänderter Anzahl und
  UTC-Zeitstempel; Dateisenke immer, DB-Senke (`audit_log`, Event
  `UNIVERSE_MUTATION`) über `UNIVERSE_AUDIT_DB=1`.
- [x] **Keine Secrets** — kein Credential, kein Token, kein API-Key in Code,
  Config, Seed-Daten oder Logs. Audit-Einträge enthalten nur IDs und Zähler;
  HTTP-Fehler laufen durch `publicErrorMessage()` (Redaktion).
- [x] **Neue Dependencies geprüft** — **keine** hinzugefügt (0 neue Pakete);
  `npm audit`: 0 Vulnerabilities. Nur Node-Kernmodule (`fs`, `path`, `os`).
- [x] **Keine Live-Trading-Funktion** — `liveAvailable` ist ein reines
  Datenfeld; es existiert kein Codepfad, der daraus eine Order ableitet.
  `riskGuard.ts` und `PaperBroker` sind unverändert.
- [x] **Kein Netzwerk, kein LLM im Kern** — die Registry nutzt ausschließlich
  lokale Dateien; Tests laufen offline mit committeten Fixtures.

### Befunde

| ID | Severity | Datei (Funktion) | Problem | Status |
| --- | --- | --- | --- | --- |
| U-01 | Medium | `src/universe/policy.ts` → `loadPolicy()` | Reguläre Ausdrücke aus einer Override-Datei (`UNIVERSE_POLICY_FILE`) könnten katastrophales Backtracking verursachen (ReDoS) | ✅ mitigiert: Muster nur aus Betreiber-Config (nie HTTP), ≤ 50 Regeln, ≤ 120 Zeichen, Kompilierung einmalig, Auswertung nur gegen validierte Symbole ≤ 32 Zeichen; Restrisiko akzeptiert und dokumentiert |
| U-02 | Medium | `src/universe/registry.ts` → `upsertMany()` | Unbegrenzte Batches könnten Speicher und Dateigröße sprengen | ✅ gefixt: harte Grenze `MAX_BATCH_SIZE = 5000`, Verstoß wirft `UniverseValidationError` |
| U-03 | Medium | `src/app/api/markets/route.ts` → `GET()` | Unbegrenzte `pageSize` hätte das gesamte Universum in eine Antwort gezogen | ✅ gefixt: Klemmung auf 500 (Registry-seitig, nicht nur in der Route) |
| U-04 | Low | `src/universe/store.ts` → `save()` | Absturz während des Schreibens hätte eine halbe NDJSON-Datei hinterlassen | ✅ gefixt: atomarer Write (`tmp` + `rename`), Audit-Datei mit Modus `0600` |
| U-05 | Low | `src/universe/store.ts` → `load()` | Manipulierte/kaputte Zeilen in der Datendatei | ✅ gefixt: jede Zeile durchläuft `validateInstrument()`; ungültige Zeilen werden gezählt (`skippedLines`), nie geladen |
| U-06 | Low | `src/app/api/markets/[venue]/[symbol]/route.ts` | Pfadparameter könnten Traversal-Zeichen enthalten | ✅ gefixt: Decodierung + Muster-Validierung vor jedem Zugriff; die ID ist ein Map-Key, kein Dateipfad |
| U-07 | Low | `src/universe/audit.ts` → `sanitizeSource()` | Freie `source`-Angaben könnten Log-Injection/Flooding erlauben | ✅ gefixt: Whitelist-Zeichen, max. 40 Zeichen, Default `unknown` |
| U-08 | Info | `src/universe/audit.ts` → `writeDbAudit()` | DB-Senke standardmäßig aus; Ausfall darf Mutation nicht abbrechen | ✅ geprüft: dynamischer Import, `try/catch`, redigierte Warnung |
| U-09 | Info | `data/universe/*` | Versionierte Instrumentendatei im Repo | ✅ geprüft: enthält ausschließlich öffentliche Marktmetadaten; das Audit-Log ist per `.gitignore` ausgeschlossen |
| U-10 | Info | `src/lib/marketData.ts` | Deprecation der `DEFAULT_WATCHLIST` | ✅ geprüft: identische Werte/Reihenfolge, keine Verhaltensänderung für Monitor, Broker und Workshop |

Fazit: **kein High/Critical-Befund.** Der neue Code erweitert keine
Vertrauensgrenze — er liest und schreibt ausschließlich lokale, validierte
Konfigurationsdaten und stellt zwei rein lesende Endpunkte bereit.

---

## Security Audit — Task 02 (Broker Capability-Modell, v1.10.0)

**Audit-Stand:** 2026-08-27 · **Scope:** src/contracts/broker.ts,
src/brokers/**, src/lib/broker.ts, src/lib/engine.ts,
src/app/api/brokers/**, 66 neue Tests (400 gesamt, alle grün).
**Methode:** Code-Review, Threat-Walkthrough der neuen Pfade,
Testauswertung (Offline-Suite mit simuliertem fetch), npm audit.

### Nachweise (Pflichtkriterien Task 02)
- **1. Kein erreichbarer Live-Pfad:** `getBroker(venue, "live")` wirft
  für alle 6 Venues `LiveTradingGateError` (24er-Matrix + reproduzierbar
  getestet); Stubs verweigern Trading im live-Kontext zusätzlich (Defense
  in Depth, getestet). Kein Codepfad leitet aus Capability-Flags, Credentials
  oder Env-Variablen eine reale Order ab. `riskGuard.ts` und `PaperBroker`
  sind unverändert (alle 334 Bestands-Tests bytekompatibel).

- **2. Fehlermeldungen ohne Leaks:** Alle Fehlerklassen tragen nur
  Venue/Method/Capability/Code; Fremd-Venues werden auf 40 Zeichen
  gekürzt (Injection-Versuch getestet). HTTP-Antworten laufen durch
  `publicErrorMessage` (Redaktion). Remote-Fehlermeldungen werden mit
  simuliertem fetch gegen Credential-Pattern geprüft (postgresql://,
  User:Pass, Hosts, Keys) — kein Treffer.

- **3. Audit-Log vollständig:** Jeder Factory-Aufruf mit
  `mode != "paper"` erzeugt genau einen Eintrag (Venue, Modus,
  Ergebnis, UTC-Zeitstempel) — in der Matrix sind das 18 von 18
  (6x LGTE, 11x NSE, 1x OK). Unknown-Venue-Ablehnungen werden
  auditiert (Vollständigkeit). Senken: In-Memory-Ring (200, immer)
  + best-effort `audit_log` (Event `BROKER_FACTORY`) — DB-Ausfall
  bricht den Pfad nie ab (Fail-Safe, Test: Factory wirft korrekt,
  Ring bleibt wahr).

- **4. Remote-Health default OFF:** `BROKER_HEALTHCHECK_REMOTE`
  ist false, wenn nicht exakt "true". Remote-Checks sind read-only,
  credential-frei (Public-Endpunkte: Binance ping, Kraken Time, 4 s
  Timeout). ALPACA/IBKR/DYDX stellen ohne Credentials/Gateway
  keinerlei Netzwerk-Request (getestet: 0 fetch-Calls).

### Befunde

| ID | Severity | Datei (Funktion) | Problem | Status |
| --- | --- | --- | --- | --- |
| B-01 | Info | src/brokers/audit.ts → recordBrokerFactoryCall() | DB-Senke ist best-effort (dynamischer Import, try/catch); ohne PostgreSQL wird nur der In-Memory-Ring geführt | ✅ by design (Muster des Universe-Audits); der Pfad bleibt korrekt und auditierbar im Ring |
| B-02 | Info | src/app/api/brokers/** | Health-Endpunkte sind read-only ohne Token | ✅ konsistent mit den übrigen GET-Endpunkten; keine Zustandsmutation, kein Schreibpfad |

Fazit: **kein High/Critical-Befund.** Task 02 macht das Capability-Modell
ausführbar, ohne die Vertrauensgrenze zu verschieben: Der Live-Pfad ist
hart und reproduzierbar gesperrt, Fehlermeldungen sind leak-frei, das
Audit ist vollständig, und Remote-Checks sind default OFF. Der Paper-
Betrieb bleibt unverändert (334 Bestands-Tests grün); 66 neue Tests
sichern das Modell. 0 neue Dependencies, `npm audit` ohne Befund.

---

## Security Audit — Task 03 (Paper Market Data & Execution-Simulation, v1.11.0)

**Scope:** `src/lib/marketdata/` (Feeds, Normalisierung, Historical Store,
Failover, Simulator, Manager, http, config, production),
`src/app/api/marketdata/` (snapshot, status), Integration in `broker.ts` /
`engine.ts`.

### Checkliste (Pflichtkriterien)

| Kriterium | Status | Nachweis |
| --- | --- | --- |
| **SSRF-Allowlist** | ✅ | `http.ts` → `assertHostAllowed()`: Jeder Feed-Request wird vor dem Absenden gegen die Allowlist geprüft (Default `api.binance.com`, Yahoo-Hosts; konfigurierbar via `PAPER_FEED_ALLOWED_HOSTS`). Fremde Hosts → `FeedHttpError(BLOCKED)`, kein Request. Test: `marketdata.integration.test.ts` + Fixture-Allowlist. |
| **Timeout Pflicht** | ✅ | `httpGetJson` erzwingt `timeoutMs` (Default 8000) via AbortController; `redirect: "error"` (kein Redirect-Abfluss an Fremd-Hosts). |
| **Retry nur mit Backoff + hartem Limit** | ✅ | `maxRetries` (Default 2, Env `PAPER_FEED_RETRY_MAX`, geklemmt 1–6) mit exponentiellem Backoff (`baseBackoffMs * 2^attempt`). Kein ungebremster Retry. |
| **Feeds read-only** | ✅ | Nur `GET` mit `cache: "no-store"`; keine Zustandsmutation außerhalb des deterministischen Local-Simulators/Stores. |
| **Audit-Log-Failover** | ✅ | Jeder Feed-Wechsel → `FEED_FAILOVER`, jede verworfene Anomalie → `ANOMALOUS_SNAPSHOT` in `audit_log` + In-Memory-Ring (best-effort, Fail-Safe). `failover.ts`. |
| **Kein stiller Kursquellwechsel** | ✅ | Synthetic nur bei `PAPER_ALLOW_SYNTHETIC_FALLBACK=true`; statisches Preisbuch nur bei `PAPER_STATIC_FALLBACK=true` (Default aus). Ohne erlaubten Fallback → `NO_QUOTE`-Ablehnung, nie raten. |
| **Kein Secret-Bedarf** | ✅ | Feeds sind Public-Endpunkte (kein API-Key); nirgends Credentials. Kein neuer Netzwerk-Import in Unit-/CI-Tests (Fixture-Server, `127.0.0.1`). |
| **Kein LLM-Zugriff** | ✅ | Market-Data-Schicht ist rein deterministisch; kein Import von `ollama`/`llmProvider` (Import-Graph frei davon). |
| **Live unangetastet** | ✅ | Live-Pfad weiterhin hart gesperrt (`LiveTradingGateError`); Modus C ist heute nicht wählbar (klarer `PaperConfigError`). |
| **Anomalie-Normalisierung** | ✅ | `normalization.ts`: NaN/≤0, Sprung > `PAPER_ANOMALY_MAX_JUMP_PCT`, staler Timestamp, kaputter Spread → verworfen + loggt, nie gehandelt. |

### Befunde

| ID | Severity | Datei (Funktion) | Problem | Status |
| --- | --- | --- | --- | --- |
| P-01 | Info | `src/lib/marketdata/failover.ts` → `recordFailover()` | DB-Senke ist best-effort (dynamischer Import, try/catch); ohne PostgreSQL nur In-Memory-Ring | ✅ by design (Muster des Universe-/Broker-Audits); der Ring bleibt Wahrheit und wird im Audit-Log gespiegelt, sobald die DB steht |
| P-02 | Info | `src/lib/marketdata/manager.ts` → `getSnapshot()` | `Date.now()` für Cache-TTL/`ts` — nicht Teil des deterministischen Replay-/Backtest-Pfads (der nutzt Store-Timestamps); für Modus B realtime gewollt | ✅ by design; Determinismus gilt für Simulator/Replay/Synthetic |
| P-03 | Info | `src/app/api/marketdata/**` | Read-only-Endpunkte ohne Token | ✅ konsistent mit den übrigen GET-Endpunkten; keine Zustandsmutation, kein Schreibpfad |

Fazit: **kein High/Critical-Befund.** Die Marktdaten-Schicht erweitert das
System um echte Kurse, ohne die Vertrauensgrenze zu verschieben: Feeds sind
read-only und SSRF-geschützt, Failover ist laut und auditiert, anomale Kurse
werden nie gehandelt, und der Live-Pfad bleibt gesperrt. 0 neue Dependencies,
`npm audit` ohne Befund; 53 neue Tests, Coverage der neuen Module **95,6 %**
(Zeilen), kein echter Netzwerkverkehr in der CI-Suite.

---

## Security Audit — Task 04 (Markt-Scanner, Market Score & Trichter, v1.12.0)

**Scope:** `src/scanner/**` (19 Dateien), `src/app/api/universe/**` (3 Routen),
`scripts/run-scan.ts`, `src/scanner/scanner.config.json`.
**Methode:** manuelle Review + statischer Architektur-Import-Scan als Test
(`tests/scanner.architecture.test.ts`) + TS strict + ESLint + 123 Modultests.
**Vertrauensgrenze:** Der Scanner ist eine **read-only Analyseschicht**. Er
konsumiert Registry (Task 01) und Historical Store (Task 03) und schreibt
ausschließlich Artefakt-Dateien. Kein Ordner-, Order-, Ledger- oder Live-Pfad
wird berührt.

### Checkliste (Pflichtkriterien)

| Kriterium | Status | Nachweis |
| --- | --- | --- |
| **Kein LLM im Scanner** | ✅ | Architekturtest scannt jede Datei unter `src/scanner/**` und `src/app/api/universe/**` gegen Import-Regex für Ollama/OpenAI/Gemini/Claude/`llmProvider`/Prompts/Analysten. Das News-Risiko ist eine reine Zählheuristik (`factors/news.ts`). |
| **Kein Netzwerk** | ✅ | Verbotene Muster `fetch(`, `node:http(s)`, `ws`, Broker-SDKs — im Test erzwungen. Daten kommen ausschließlich über injizierte Provider. |
| **Kein ungeseedeter Zufall** | ✅ | `Math.random` im Scanner verboten (Test). Synthetische Benchmark-Daten nutzen `createRng()` (mulberry32) mit festem Seed. |
| **Zeit injizierbar** | ✅ | `Date.now()` ist im Kern verboten, `new Date()` nur in `service.ts` erlaubt (Test). `scanUniverse()` bekommt `asOf` übergeben ⇒ reproduzierbare Läufe. |
| **Byte-identische Reproduzierbarkeit** | ✅ | Alle Ausgabewerte gerundet, stabile Sortierung (Score desc, `instrumentId` asc), JSON mit fester Formatierung. Test vergleicht zwei Läufe byte-genau. |
| **Schreibpfade minimiert** | ✅ | `writeFileSync`/`renameSync`/`rmSync` nur in `artifacts.ts` (Test). Schreiben atomar über tmp + rename, Modus 0644, Zielverzeichnis über `SCANNER_ARTIFACTS_DIR`, Datumsordner gegen `ARTIFACT_DATE_RE` validiert ⇒ kein Path-Traversal. |
| **API read-only** | ✅ | Nur `GET`-Handler, keine Mutation, `dynamic = "force-dynamic"`. Konsistent mit den übrigen GET-Routen ohne Token-Pflicht (P-03 aus Task 03). |
| **DoS-Grenzen** | ✅ | `pageSize` max. **200** (Default 50), `page` max. 100.000, `class`-Filter max. 100 Zeichen/4 Werte, `instrumentId` max. 64 Zeichen, `MAX_SCAN_INSTRUMENTS = 250.000`, `MAX_SERVICE_INSTRUMENTS = 50.000`. Ungültige Parameter ⇒ `400 VALIDATION_ERROR`, nie Silent-Clamping auf teure Werte. |
| **Keine Fehler-Leaks** | ✅ | Alle 500er laufen durch `publicErrorMessage()`; Ablehnungsgründe enthalten nur Regel-ID und Schwellwert, keine Rohdaten. |
| **Keine Secrets / keine DB** | ✅ | Kein Credential, kein `process.env` außer `SCANNER_CONFIG_FILE` und `SCANNER_ARTIFACTS_DIR` (Test-Whitelist); kein `drizzle`/`pg`-Import. |
| **Kein Live-Trading-Bezug** | ✅ | Keine Order-, Broker- oder Ledger-Aufrufe; `liveAvailable` wird nicht einmal gelesen. Der Trichter verlangt umgekehrt `paperAvailable`. |
| **Konfiguration validiert** | ✅ | `loadScannerConfig()` prüft Typen, Bereiche, Reihenfolge der Schwellen und die Gewichtssumme (1.0 ± 1e-9); Override-Dateien laufen durch dieselbe Validierung. Fehlerhafte Konfiguration ⇒ Abbruch, nie stille Defaults. |
| **Unwissen wird nicht belohnt** | ✅ | Fehlende Werte ⇒ `available: false` mit dokumentiertem Neutralwert (i. d. R. 0); fehlender Spread/Volumen führt zur Ablehnung im Trichter statt zu einem guten Score. |

### Befunde

| ID | Severity | Datei (Funktion) | Problem | Status |
| --- | --- | --- | --- | --- |
| Q-01 | Info | `src/app/api/universe/**` | Read-only-Endpunkte ohne Token, wie alle GET-Routen | ✅ by design; keine Mutation, harte Query-Limits, redigierte Fehler |
| Q-02 | Info | `src/scanner/service.ts` → `ScannerService` | `new Date()` und ein prozessweiter Cache; einziger nichtdeterministischer Punkt | ✅ by design und bewusst isoliert — Kern und Tests injizieren `asOf`; Architekturtest hält die Ausnahme auf diese Datei begrenzt |
| Q-03 | Info | `src/scanner/factors/correlation.ts` | Korrelationsmathematik liegt lokal statt in einem geteilten Analytics-Modul | ✅ akzeptiert: Task 05 (Portfolio Analytics) existiert im Repo nicht; Umzug ist im TSDoc als Folgeschritt markiert |
| Q-04 | Info | `artifacts/` | Tagesartefakte enthalten vollständige Score-Breakdowns und liegen unversioniert auf der Platte | ✅ by design: keine personenbezogenen Daten, keine Secrets, jederzeit aus Registry + Historie reproduzierbar; `.gitignore` verhindert versehentliches Committen |
| Q-05 | Low | `factors/news.ts` | Heuristik bewertet nur Ereignis*zahlen*; ein einzelnes schweres Ereignis kann unterschätzt werden | ⚠️ bekannt und dokumentiert (Hilfetext „risiko", Doku Abschnitt 3); der Faktor trägt bewusst nur 5 % Gewicht |

Fazit: **kein Critical/High/Medium-Befund.** Der Scanner vergrößert die
Angriffsfläche praktisch nicht: keine neue Dependency, kein Netzwerk, keine
Datenbank, keine Secrets, kein Schreibpfad außerhalb des Artefaktordners. Die
einzige Zustandsänderung des Systems sind reproduzierbare JSON-Dateien. Die
neuen HTTP-Endpunkte sind lesend und gegen unbegrenzte Ergebnismengen
abgesichert; der Live-Pfad bleibt unangetastet und gesperrt.

---

## Security Audit — Task 05 (Portfolio-Analytics, Optimizer & Risk-Guard-Kette, v1.13.0)

**Scope:** `src/portfolio/**` (12 Dateien), `src/app/api/portfolio/**`
(3 Routen + Parser), `tests/portfolio.*.test.ts` (7 Suiten).
**Methode:** manuelle Review + statischer Architektur-Scan als Test
(`tests/portfolio.architecture.test.ts`: Import-, Dateisystem-, Uhr-, Zufalls- und
Env-Verbote) + TS strict + ESLint + 130 Modultests (8 Suiten) + Coverage-Messung.
**Vertrauensgrenze:** Das Portfolio-Modul ist eine **reine Analyseschicht**. Es
erzeugt Kennzahlen, Matrizen und Gewichte **plus Risk-Guard-Report** und verändert
**keinen** Portfolio-, Positions-, Order-, Ledger- oder Live-Zustand. Der einzige
optionale Schreibpfad ist die append-only Audit-Datei.

### Checkliste (Pflichtkriterien)

| Kriterium | Status | Nachweis |
| --- | --- | --- |
| **Read-only** | ✅ | Alle drei Routen exportieren `POST` und ein `GET`, das `405` liefert (Architekturtest prüft beides je Route). Keine Order-, Positions-, Ledger- oder Broker-Aufrufe im Modul (Scan). `optimizeWithGuard()` ist der einzige öffentliche Weg zu Gewichten; die Route ruft den rohen Optimizer nicht. |
| **Größenlimits / DoS-Schutz** | ✅ | `PORTFOLIO_LIMITS`: max. **1000 Serien** (Spezifikationsdefault), max. 2000 Punkte je Serie, max. **400.000** Stichproben (`Serien × Länge`, bremst `O(T·n²)`), Body ≤ **16 MiB**. Überschreitung ⇒ `413 LIMIT_EXCEEDED` **vor** jeder Berechnung (getestet mit 501 × 800). Keine Rekursion über Nutzereingaben, keine regulären Ausdrücke auf Nutzertext. |
| **Determinismus** | ✅ | Kein `Math.random`, kein `Date.now`, kein `new Date()` im Kern (Architekturtest). Solver-Starts sind fest (`1/n`, gleichverteilt, drei fixe Starts bei `max_sharpe`), Ausgabe auf 12 Dezimalen gerundet, `Σw` exakt 1. Zeitstempel kommen ausschließlich per injizierter `now()`-Funktion in Audit-Ereignisse. Test „identische Anfragen ⇒ identische Antworten" vergleicht zwei Antworten byte-genau. |
| **Kein LLM-Import** | ✅ | Architekturtest scannt jede Datei unter `src/portfolio/**` und `src/app/api/portfolio/**` gegen Import-/`require`-/dynamische `import()`-Regex für Ollama, OpenAI, Anthropic/Claude, Gemini, `llmProvider`, Prompts, Analysten, Langchain. `getAnalysisContext()` liefert nur fertige Ergebnisse und enthält keine Gewichte. |
| **Kein Netzwerk / keine DB** | ✅ | `fetch(`, `node:http(s)`, `node:net`, `node:child_process`, `ws`, Broker-SDKs und `drizzle`/`@/db` sind im Modul verboten (Test). `dbAuditSink` ist vorbereitet, aber nicht aktiv — das Modul läuft ohne Datenbank. |
| **Numerische Robustheit** | ✅ | `NaN`/`±Infinity` in Eingaben ⇒ definierter Fehler (`INVALID_INPUT`, `NUMERIC_FAILURE`, `DIVISION_BY_ZERO`, `NOT_POSITIVE_DEFINITE`); `JSON.parse("1e999")` ⇒ `Infinity` wird abgelehnt (getestet). Singuläre Kovarianz ⇒ `SINGULAR_MATRIX` oder **konfigurierbare** `ridge`/`pseudo-inverse`, Ergebnis immer in `diagnostics.regularization` dokumentiert. Nullvarianz in der Korrelation ⇒ definiert 0, nie `NaN`. |
| **Kein stiller Fallback** | ✅ | Cholesky erklärt Pivots unter `1e-12 · max(diag)` für singulär (zwei perfekt korrelierte Assets liefern sonst ein Pivot ~1e-19 und danach Unsinn). Nichtkonvergenz ⇒ `converged: false` **und** `notes: ["NOT_CONVERGED:iterations=…"]`. Bounds-Projektion ⇒ `BOUNDS_PROJECTED:violations=n`. |
| **Autoritätskette erzwungen** | ✅ | `AUTHORITY_CHAIN` als Konstante, `assertAuthorityChain()` prüft Präfix **und** Vollständigkeit (`!rejected` ⇒ alle vier Stationen). `applyRiskGuard` lehnt Eingaben ohne `authority = "portfolio-optimizer"` ab (`INVALID_INPUT`). Architekturtest verankert beide Muster im Quelltext. |
| **Audit je Entscheidung** | ✅ | Invariante `auditEvents.length === decisions.length + 1` (je Entscheidung ein Eintrag plus Summary), in `optimizeWithGuard` zusätzlich das Optimizer-Ereignis ⇒ `audit.length === 2 + decisions.length`. Tests zählen die Einträge bei Kappung, Verwurf und unverändertem Portfolio (0 Entscheidungen ⇒ genau ein `RISK_GUARD_PASS`). |
| **Keine Secrets** | ✅ | Kein Credential im Code, keine Secrets in Antworten; `publicErrorMessage`-Muster der übrigen Routen übernommen, 500er ohne interne Details. `process.env` nur für `PORTFOLIO_AUDIT`, `PORTFOLIO_AUDIT_DIR`, `PORTFOLIO_AUDIT_DB` (Test-Whitelist). |
| **Keine Datenflut ins Audit** | ✅ | Audit-Ereignisse führen max. 25 Symbole (`maxSymbolsPerAuditEvent`) und keine Renditereihen — nur Zahlenwerte und Gründe. |
| **Path-Traversal** | ✅ | Der Audit-Dateiname wird gegen `^[A-Za-z0-9._-]{1,64}$` validiert (`AUDIT_FILE_RE`), Verzeichnisse werden nicht aus dem Request übernommen; Schreiben atomar über tmp + `rename`, Modus 0644 (getestet, inkl. Ablehnung von `../../etc/passwd`). |
| **Log-Injection** | ✅ | Symbole werden getrimmt, uppercased und gegen `^[A-Z0-9][A-Z0-9:./\-_=]{0,63}$` geprüft — kein Zeilenumbruch, kein Leerzeichen, kein Steuerzeichen in Log- oder Audit-Zeilen. |
| **Eingabevalidierung** | ✅ | Typisierte Parser für Body, Symbol, Serie, Kerzen (`high ≥ low`), Modi, Kovarianz-Methode, Bounds und Limits; Bereichs- und Ganzzahligkeitsprüfungen; fehlende Datenquelle ⇒ `400`; Kerzenanzahl/Periodenlänge gegen `PORTFOLIO_LIMITS`. |
| **Konfiguration validiert** | ✅ | `resolveSolverOptions`/`resolveGuardConfig` prüfen jeden Wert einzeln; fehlerhafte Konfiguration ⇒ `INVALID_CONFIG` (nicht `INVALID_INPUT`), niemals stille Defaults. |
| **Kein Live-Trading-Bezug** | ✅ | Keine Order- oder Broker-Aufrufe, kein `killSwitch`, keine Positionsmutation. Die Order-Guardrails (`src/lib/riskGuard.ts`) bleiben unangetastet. |

### Befunde

| ID | Severity | Datei (Funktion) | Problem | Status |
| --- | --- | --- | --- | --- |
| R-01 | Info | `src/app/api/portfolio/**` | Read-only-Endpunkte ohne Token, wie alle übrigen API-Routen des Projekts | ✅ by design (vgl. P-03/Q-01): keine Zustandsmutation, harte Größenlimits, redigierte Fehler. Die Datei-Audit-Senke ist opt-in und schreibt append-only. |
| R-02 | Info | `src/portfolio/auditFile.ts` → `now()` in der Route | Audit-Zeitstempel entstehen per `() => new Date()` in der **Route**, nicht im Kern | ✅ by design: Der Kern bleibt deterministisch (Architekturtest verbietet `new Date()` unter `src/portfolio/**`); Audit-Zeit ist notwendigerweise Echtzeit. |
| R-03 | Info | `src/portfolio/optimize.ts` → `max_sharpe` | Drei deterministische Starts statt garantierter Globaloptimum-Suche; die Zielfunktion ist unter Bounds nicht konvex | ✅ dokumentiert (PORTFOLIO_ANALYTICS.md §2): bestes der drei Ergebnisse gewinnt, Konvergenz wird berichtet. Kein Zufall, damit reproduzierbar. |
| R-04 | Low | `src/portfolio/correlation.ts` → `covarianceMatrix` | Sample-Kovarianz ohne Shrinkage ist für `n ≫ T` schlecht konditioniert; `ridge`/`pseudo-inverse` sind Notlösungen | ⚠️ bekannt und dokumentiert (§9): Ledoit-Wolf ist der richtige nächste Schritt, aber bewusst nicht Teil dieses Tasks. Ohne Konfiguration wird ein Fehler geworfen, nie ein still falsches Ergebnis. |
| R-05 | Low | `src/portfolio/riskGuard.ts` → Cluster | Single-Linkage-Clustering ist transitiv; A~B und B~C verbindet A und C auch bei moderatem `ρ_AC` | ✅ bewusste Entscheidung: größere Cluster ⇒ strengere Limits (konservativ). Schwelle konfigurierbar. |
| R-06 | Info | `src/app/api/portfolio/parse.ts` → `statusForCode` | Enthält einen `INVALID_JSON`-Zweig, der aktuell nie geworfen wird (Parse-Fehler laufen als `INVALID_INPUT`) | ✅ harmlos; bleibt als Mapping-Vollständigkeit, getestet über `statusForCode`. |
| R-07 | Info | `src/scanner/factors/correlation.ts` | Zweite Pearson/Spearman-Implementierung außerhalb des Portfolio-Moduls | ✅ bekannt (Q-03 aus Task 04): Task 05 existiert jetzt; der Umzug ist als Folgeschritt dokumentiert, der Scanner bleibt unverändert lauffähig. |
| R-08 | Low | `src/app/api/portfolio/parse.ts` → `errorResponse()` | Ursprünglich wurde die Meldung **jeder** Ausnahme (redigiert) an den Client geschickt — interne Fehlerdetails (Pfade, Treiber-Meldungen) wären sichtbar geworden | ✅ **behoben** in diesem Task: nur `PortfolioError`-Meldungen werden ausgegeben, sonst „Interner Fehler"; Test „Fehlerantwort enthält nie interne Details" |
| R-09 | Low | `src/portfolio/numeric.ts` → `regularizeCovariance()` | Der Fehlercode `NOT_POSITIVE_DEFINITE` war im Mapping der API definiert, wurde aber nirgends geworfen — eine negative Varianz erschien als `SINGULAR_MATRIX` | ✅ **behoben**: negative Diagonalelemente werfen jetzt `NOT_POSITIVE_DEFINITE` (`422`), der Code ist im Typ `PortfolioErrorCode` verankert und getestet |

### Fazit

**Kein Critical/High/Medium-Befund.** Das Portfolio-Modul vergrößert die
Angriffsfläche minimal: 0 neue Dependencies, kein Netzwerk, keine Datenbank, keine
Secrets, kein Zufall, keine Uhr im Kern und genau ein opt-in Schreibpfad
(append-only Audit-Datei mit validiertem Namen). Die entscheidende Sicherheit
ist architektonisch, nicht prozedural: **Gewichte entstehen ausschließlich im
Optimizer, jedes Ergebnis läuft durch die Risk Guard, und jede Entscheidung ist
auditiert.** Ein manipuliertes LLM kann diese Kette nicht umgehen — es bekommt
fertige Zahlen und kann sie nur interpretieren. 113 Tests, Coverage der Bibliothek
**96,41 %** Zeilen / 91,60 % Branches / 95,91 % Funktionen
(`npm run test:coverage:portfolio`), Benchmark 500 × 750 in 5,8 s von 30 s Budget
(unter Coverage-Instrumentierung 60 s — das Budget wird dort bewusst um Faktor 20
skaliert, weil sonst die Instrumentierung gemessen würde, nicht die Bibliothek).

---

## Security Audit — Task 06: Daily & Weekly Agent Cycle

**Stand:** 2026-08-27 · **Modul:** `src/cycle/` · **API:** `/api/analysis/*`
**Status:** Audit der Agenten-Orchestrierung und Sicherheitsgrenzen (Task 6 von 12)

### Sicherheits-Leitlinien & Selbstaudit

| Kriterium | Status | Implementierung & Nachweis |
| --- | :---: | --- |
| **Keine Order-Pfade** | ✅ | Der gesamte Zyklus platziert **keine Orders** und ändert **keine Broker-/Gate-Zustände**. Research-Setups tragen verbindlich `isProposal: true` und den Disclaimer `PROPOSAL_ONLY_NO_ORDERS_PLACED`. Statisch geprüft in `tests/cycle.architecture.test.ts` (Import- und Call-Scan auf `placeOrder`, `executeOrder`, `createOrder`, etc.). |
| **Shortlist-Limits im Code** | ✅ | Das Limit von maximal **40 Instrumenten** für rechenintensive LLM-Schritte (`TECHNICAL_ANALYST`, `NEWS_ANALYST`) ist im Code verankert (`assertShortlistLimit`). Ein 41. Instrument führt ausnahmslos zu einem `ShortlistLimitExceededError`. Geprüft in `tests/cycle.shortlist.test.ts`. |
| **Output-Validierung & Prompt-Injection** | ✅ | Externe Nachrichtentexte werden strikt als Daten im `untrustedData`-Container transportiert (`wrapUntrustedData`). Alle Modellausgaben werden über Typprüfer (`validateMacroOutput`, `validateSelectionOutput`, `validateTechnicalOutput`, `validateNewsOutput`, etc.) validiert. Bösartige Ausgaben (z. B. Injektionen wie `{"hack": true}`) werden verworfen und neutral ersetzt. Geprüft in `tests/cycle.injection.test.ts`. |
| **Audit pro Lauf** | ✅ | Jeder Zyklusstart (`CYCLE_STARTED`), jeder Schrittstart (`CYCLE_STEP_STARTED`), jeder Retry (`CYCLE_STEP_RETRY`), jeder Schrittabschluss (`CYCLE_STEP_COMPLETED`), jeder Teilschritt-Fehler (`CYCLE_STEP_FAILED`) und jeder Zyklusabschluss (`CYCLE_COMPLETED` / `CYCLE_FAILED`) wird über den `CycleAuditPort` protokolliert (DB-Tabelle `audit_log` und Datei `data/cycle/audit.ndjson`). |
| **Null-LLM im Scanner** | ✅ | `src/cycle/steps/scannerStep.ts` ist vollständig frei von LLM-Modulen. Die Step-Engine blockiert zur Laufzeit (`createGuardedAgentPort`) jegliche LLM-Aufrufe in Schritten mit `llmAllowed: false`. Geprüft via Unit- und Architektur-Test. |
| **Kontrollierter Abbruch** | ✅ | Ein unlösbarer Schritt-Fehler bricht den Zyklus geordnet ab (`status: "FAILED"`). Bereits erzeugte Artefakte vorheriger Schritte bleiben uneingeschränkt intakt und lesbar. |
| **Atomare Artefakte & Pfadsicherheit** | ✅ | Artefakte werden atomar über temporäre Dateien (`.tmp`) und `renameSync` geschrieben. Pfad-Traversal wird durch strikte Datums- und Wochenregex (`^\d{4}-\d{2}-\d{2}$`, `^\d{4}-W\d{2}$`) ausgeschlossen. |

### Befunde

| ID | Severity | Datei (Funktion) | Problem | Status |
| --- | --- | --- | --- | --- |
| S-01 | Info | `src/app/api/analysis/**` | Read-only API-Endpunkte ohne Authentifizierungs-Token | ✅ by design: Einheitlich mit `/api/universe/*` und `/api/portfolio/*`; keine Schreibpfade, keine Secrets, DoS-Schutz durch Paginierungs-Limits (max. 100 Einträge). |
| S-02 | Info | `src/cycle/engine.ts` → `emitEscalation` | `MODEL_ESCALATION_REQUEST`-Event ohne bestehenden Model-Router (Task 09) | ✅ Vorgabe erfüllt: Event wird auditiert und in Artefakten persistiert; das System nutzt transparent die bestehende Provider-Fallback-Kette (`chatLlm`), kein Absturz. |
| S-03 | Low | `src/cycle/security.ts` → `safeExtractJson` | Markdown-Codefences oder unvollständiges JSON könnten Parser verwirren | ✅ Behoben: `safeExtractJson` prüft nacheinander Direkt-Parse, Markdown-Codeblock-Extraktion und Brace-Substring-Matching; fängt alle Exceptions sicher ab. |
| S-04 | Low | `src/cycle/steps/newsStep.ts` | News-Headlines könnten Delimiter wie `"""` oder `SYSTEM:` enthalten | ✅ Behoben: `sanitizeExternalText` filtert Nullbytes, Kontrollzeichen und maskiert Markdown-Codefences (`'''`); `wrapUntrustedData` setzt unmissverständliche Security-Hinweise. |
| S-05 | Info | `src/cycle/artifacts.ts` → `pruneArtifacts` | Automatisches Löschen alter Artefakt-Ordner | ✅ Geschützt: Löscht nur Ordner, die exakt `YYYY-MM-DD` oder `YYYY-Www` matchen und deren Zeitstempel älter als `retentionDays` bzw. `retentionWeeks` ist. |

### Fazit

**Keine kritischen oder hohen Sicherheitsbefunde.** Das Cycle-Modul setzt das Prinzip der minimalen Privilegien strikt um: LLM-Aufrufe sind auf freigegebene Schritte und maximal 40 Instrumente beschränkt; Scanner und Backtest-Verifikation laufen ohne Sprachmodelle. Externe Einflüsse werden isoliert behandelt. Die Code-Coverage liegt bei **> 93 %** der neuen Module.

---

## Security Audit — Task 07: Bitunix-Adapter (v1.15.0)

**Stand:** 2026-08-27 · **Modul:** `src/brokers/bitunix/` · **API:** unverändert read-only `/api/brokers*`
**Status:** 7. Venue hinter `BrokerAdapter`. Public REST/WS und Paper (Modus B).
Live-Ausführung **immer** `LiveTradingGateError` (`TODO(task-11)`).

### Checkliste

| Kriterium | Status | Nachweis |
| --- | :---: | --- |
| **Kein erreichbarer Live-Pfad** | ✅ | `assertLiveOrderAllowed` wirft in allen 16 Flag-Kombinationen, auch wenn Flags vollständig wären. Factory `getBroker(_, "live")` bleibt LGTE. Adapter-`placeOrder("live")` serialisiert, sendet nie. |
| **Keine Private-Calls im Paper-Pfad** | ✅ | Paper-E2E gegen Fixture: `privateCalls === 0`, keine `sign`-Header. Credentials dürfen gesetzt sein. |
| **Secrets nie loggen / nie Frontend** | ✅ | Redactor (Header-Muster, Hex ≥ 32, Klartext-Secrets). `credentialStatus()` ohne Key. Audit `BITUNIX_PRIVATE_CALL` nur method/path/outcome/errorCode. Secret-Scan der Quellen. |
| **SSRF-Allowlist + TLS** | ✅ | `assertUrlAllowed` / WS-URL: Host-Allowlist, kein Userinfo, `https`/`wss` Pflicht, Loopback-http nur mit explizitem Flag. `redirect: "error"`. |
| **Signing golden-testbar** | ✅ | Fünf Goldens inkl. offiziellem Doku-Beispiel; Verifikation timing-safe. |
| **Gate-Defaults sicher** | ✅ | `BITUNIX_ENABLED`/`BITUNIX_LIVE_ENABLED`/`LIVE_TRADING_ENABLED` nur bei exakt `"true"`. Human-Approval fehlend = true. |
| **Kein Testnet-Fake** | ✅ | `testnet=false` mit dokumentierter Begründung; Modus testnet → NSE. |
| **Kein LLM** | ✅ | Adapter-Tree importiert keine Provider. |

### Befunde

| ID | Severity | Datei | Problem | Status |
| --- | --- | --- | --- | --- |
| X-01 | Info | `src/brokers/bitunix/audit.ts` | DB-Senke best-effort | ✅ by design (Muster Factory/Universe) |
| X-02 | Info | `src/brokers/bitunix/secrets.ts` | Env-Klartext bis task-08 | ✅ dokumentiert; Dateirechte 600 in `.env.example` |
| X-03 | Info | `mapping.ts` Fees | API liefert keine Fees → VIP0-Defaults statt `null` | ✅ `MarketInstrument` erlaubt kein null; Abweichung in BITUNIX.md |

Fazit: **kein High/Critical-Befund.** Der Adapter erweitert Public-Marktdaten und
eine lokale Paper-Simulation. Die Vertrauensgrenze Live bleibt geschlossen.

## Security Audit — Task 08 (Broker Control Plane, v1.16.0)

**Stand:** 2026-08-28 · **Modul:** `src/brokers/control-plane/**` ·
**API:** neu `/api/brokers/{venue}/(credentials|status|test|discover)` ·
**UI:** „Brokers & Venues" (Dashboard-Tab + `/brokers`).
**Status:** ERHÖHT (Secrets-Handling, WebApp-Härtung) — Threat Model +
Red-Team-Checkliste + Scanner-Ergebnis.

### Threat Model

| # | Bedrohung | Angriffsweg | Gegenmaßnahme | Restrisiko |
| --- | --- | --- | --- | --- |
| T1 | Secret-Leak via API | Credential-Endpoint antwortet mit Secret/Maskierung | Status-only-Vertrag (kein `secret`, kein `keyHint`, keine `****`-Replik); Contract-Test + Response-Scanner über ALLE Broker-API-Responses | None (Scanner in CI) |
| T2 | Secret-Leak via Bundle | Secret-Literal/Muster im Client-Bundle oder Sourcemap | Frontend kennt keine Secret-Werte; Bundle-Scanner (`npm run scan:secrets`) über `.next/static` — Ergebnis leer | Framework-Rauschen (Scanner unit-getestet) |
| T3 | Secret-Leak via Logs | Error-Stack/Env in Antwort oder Audit | `publicErrorMessage` (Redaktion), SAFE-Probe-Meldungen, Audit ohne Secret-Felder (nur actor/venue/action/result/errorCode) | DB-Fehlermeldungen (redigiert) |
| T4 | Secret im Storage (at rest) | DB-/Datei-Dump | AES-256-GCM, AAD=Venue, Auth-Tag; Datei-Backend chmod 600 + gitignored | Key in Env (dokumentiert; KMS-Hook vorbereitet) |
| T5 | CSRF | Cross-Site-Formular gegen lokale API | Custom-Header `x-csrf-token` Pflicht auf allen mutierenden CP-Endpoints; API ohne Cookies | Lokaler Offen-Betrieb akzeptiert `local` (Single-User, 127.0.0.1) |
| T6 | RBAC-Umgehung | Unauthentifizierter Credential-Zugriff | Admin-Guard (`FIRM_ADMIN_TOKEN` → 403), Fallback Operator-Token (401); timing-sicher | Bis task-10 kein zentrales Rollenmodell (TODO markiert) |
| T7 | Rate-Limit (Brute-Force/Flood) | Massenhaft Credential-Versuche | Eigener Bucket 5/min pro Client-Identität → 429 + Retry-After; unabhängig vom Firm-Schreib-Limit. *v1.36.14 (C2):* Identität nicht mehr aus spoofbaren Headern, zusätzlich globales IP-unabhängiges Limit (20/min) und exponentieller Backoff ab dem 3. Fehlversuch | Single-Node-InMemory (Prozess-lokal, wie Bestand); globaler Deckel wirkt nur pro Instanz |
| T8 | Tampering (Ciphertext/Key) | Datensatz manipulieren, falscher Key | Auth-Tag-Prüfung; AAD-Bindung (fremde Venue → AUTH_FAILED); generische Fehlermeldung (kein Padding-Orakel) | None (Unit-getestet) |
| T9 | Live-Freigabe via Backdoor | Flag/Env/Parameter setzt `liveEnabled` | Kein Schalter existiert; `readGateState()` IMMER false (task-11); Live-Ebene nie ≠ off; Audit-Katalog prüft `live=active` als Widerspruch | None bis Gate-Task |
| T10 | XSS in der CP-UI | Fremddaten via innerHTML | Kein `dangerouslySetInnerHTML`/`innerHTML` in `src/components/control-plane` (Statik-Test); CSP bleibt aktiv | None |
| T11 | Zustands-Missbrauch | Übergang außerhalb save/test/discover/disable | Zustandsmaschinen-Light: StateTransitionError → 409/422 mit klarem Code | None (Unit-getestet) |

### Red-Team-Checkliste (je Punkt geprüft)

| Kriterium | Status | Nachweis |
| --- | :---: | --- |
| **Kein Secret in API-Responsen** | ✅ | `tests/controlPlane.security.test.ts`: Response-Scanner über 15+ Antworten (Erfolg + Fehler) → 0 Funde; Textsuche auf eingereichte Secrets → 0 Treffer. |
| **Kein Secret im Bundle** | ✅ | `npm run scan:secrets` nach `next build` → leer; Test überspringt nur ohne Bundle, CI erzwingt via `BROKER_REQUIRE_BUNDLE=1`. |
| **Kein keyHint/Maskierung** | ✅ | Contract-Test: erlaubte Top-Level-Felder enum-meriert; `keyHint`/`****` explizit negiert. |
| **CSRF abgelehnt** | ✅ | POST/DELETE ohne `x-csrf-token` → 403 `CSRF_INVALID` (auch bei korrektem Admin-Token). |
| **RBAC abgelehnt** | ✅ | `FIRM_ADMIN_TOKEN` gesetzt: ohne/falscher Token → 403 `FORBIDDEN`; Operator-Fallback → 401. |
| **Rate-Limit greift** | ✅ | 6. Versuch in 60 s → 429 `RATE_LIMITED` + `Retry-After` (Limit 5/min pro Identität). Seit v1.36.14 zusätzlich: rotierende `X-Forwarded-For`-Header kaufen keine Versuche (`tests/clientIp.test.ts`), globales Limit und Backoff greifen (`tests/controlPlane.bruteforce.test.ts`). |
| **Tampering/Wrong-Key** | ✅ | `tests/secretStore.test.ts`: Bit-Flip im Ciphertext, falscher Key, fremde Venue (AAD) → `AUTH_FAILED`. |
| **Memory-Hygiene** | ✅ | `zeroize()`-Pfad + Test; Probe verwirft Credential (`disposeCredential`); kein Client-Speicher (Statik-Test: kein `localStorage.setItem`). |
| **Live nirgends setzbar** | ✅ | Kein Flag/Env/Parameter; `readGateState()` konstant false; E2E + States-Tests; Audit-Katalog-Widerspruchsprüfung. |
| **Audit je Ereignis ohne Secrets** | ✅ | Integration/E2E: saved/changed/deleted/test/probe/transition im Ring + `audit_log`; Scanner über Audit-JSON leer. |
| **Zustands-Missbrauch 409/422** | ✅ | ALREADY_CONNECTED/NOT_CONFIGURED/CONNECTION_REQUIRED/NO_CREDENTIALS/PROBE_MISSING/UNKNOWN_ACTION getestet. |
| **Kein Netzwerk mit echten Brokern** | ✅ | Probe = PAPER-Ledger (in-process) bzw. Mock-Client; Discovery non-PAPER → 422 DISCOVERY_NOT_IMPLEMENTED. |

### Scanner-Ergebnis (verbindlich)

| Scan | Umfang | Ergebnis |
| --- | --- | --- |
| Response-Scanner (Test) | ALLE Broker-API-Responsen (list, health, status, credentials, test, discover, Fehlerpfade) | **0 Funde** |
| Bundle-Scanner (CI) | `.next/static` nach `next build` (`npm run scan:secrets`) | **0 Funde** |
| Audit-Scanner | Control-Plane-Audit-Ring (Integration + E2E) | **0 Funde** |

### Befunde

| ID | Severity | Datei | Problem | Status |
| --- | --- | --- | --- | --- |
| CP-01 | Info | `guard.ts` | RBAC-Platzhalter (Token, kein Rollenmodell) | ✅ Task 10: Fassade über `src/auth` (`broker.credentials`) |
| CP-02 | Info | `probe.ts` | Mock-API-Client für nicht implementierte Adapter | ✅ Unabhängigkeitsklausel; PAPER real; Doku |
| CP-03 | Info | `secretStore.ts` | Env-Key statt KMS | ✅ KMS-Hook vorbereitet; fail-closed bei Endpoint |
| CP-04 | Info | `guard.ts` | Rate-Limit in-memory (Single-Node) | ✅ konsistent mit Bestands-Limiter; 0 = aus dokumentiert |

Fazit: **kein High/Critical-Befund.** Secrets existieren außerhalb des
Backend-Speichers nicht; die einzige echte Trust-Grenze (Live) bleibt
geschlossen; alle Pflicht-Scanner sind grün und in CI verankert.

---

## Security Audit — Task 09 (Model Router, v1.17.0)

**Stand:** 2026-08-28 · **Modul:** `src/routing/**` ·
**API:** neu `/api/providers`, `/api/routing`, `/api/routing/modes` ·
**Integration:** `src/cycle/ports.ts` (DefaultAnalysisAgentPort),
`src/cycle/steps/macroStep.ts`.
**Status:** ERHÖHT (Governance, Injection-Resistenz, Budget-Deckel) — Threat
Model + Red-Team-Checkliste + Coverage-Nachweis.

### Threat Model

| # | Bedrohung | Angriffsweg | Gegenmaßnahme | Restrisiko |
| --- | --- | --- | --- | --- |
| T1 | Agent wählt selbst das teure Modell | Prompt/Code des Agenten setzt Modell | Einziger Weg ist `router.resolve()`/`requestEscalation()`; `MODEL_*`-Env wird im Agentenpfad ignoriert; Architekturtest belegt Routing-Pflicht | `localReason()` (Legacy-Pfad, engine/analysts) bleibt ungeroutet — dokumentiert, Follow-up |
| T2 | Injection erzwingt Eskalation | News-Headline/Modell-Output enthält „escalate to MODEL_C" | `toRoutingContext()`-Whitelist verwirft Freitext; Trigger nur Runtime-Metriken; `reason` wird protokolliert, nie ausgewertet; 6 Payloads × 5 Szenarien getestet | Keins (nur strukturierte Eingaben wirken) |
| T3 | Kostenexplosion / unbegrenzte Cloud | Dauerhafte Höherstufung, Retry-Loops | Budget-Deckel je Provider/Agent/Tag, Eskalations-Tageslimit (12), `classCeiling`, `allowCloud`; Policy-Validierung erzwingt Cloud-Deckel > 0 | Zähler prozess-lokal (Single-Node) |
| T4 | Policy-Manipulation | Policy-Datei/Modi ohne Autorisierung ändern | Schema-Validierung mit Startverweigerung; `PUT /api/routing/modes` nur mit Admin-Token (timing-safe) + CSRF; Modi-Datei chmod 600; jede Änderung auditiert (`outcome: admin`) | Bis task-10 kein Rollenmodell (Token-Platzhalter, TODO markiert) |
| T5 | Audit-Lücke | Wechsel ohne Protokoll (z. B. in-class Provider-Tausch) | `finish()` auditiert jeden Wechsel (Klasse/Provider/Modell) sowie Fallback/Budget; seitwärts/rückwärts ⇒ `outcome: fallback`; Assertion-Test: 100 % der Wechsel haben Audit-Eintrag | DB-Senke best-effort (Ring + Datei bleiben Wahrheit) |
| T6 | Secret-Leak über die Provider-API | `/api/providers` spiegelt Registry inkl. Keys/URLs | Antwort enthält nur Status/Modell/Kosten/Zähler — keine Keys, keine Basis-URLs; Secret-Scanner über die Response im Test | None (Scanner in CI) |
| T7 | Cloud-Nutzung trotz lokalem Gebot | Agent mit `allowCloud:false` landet in der Cloud | Doppelte Sperre: `allowCloud` je Agent **und** `classes[*].deployment: local`; Testmatrix prüft 108 Fälle gegen Cloud-Verstoss | None |
| T8 | Fallback-Kette als Schleichweg in die Cloud | Quota-/Timeout-Kette überschreibt die Agenten-Freigabe | `fallbackChainFor()` filtert Cloud bei `allowCloud:false`; Kette ist konfigurierbar und auditiert | None (Unit-getestet) |
| T9 | Router als Trading-Agent missverstanden | Router erzeugt Entscheidungen/Orders | Router ist read-only bzgl. Markt/Orders: kein DB-Schreibzugriff ausser Audit, kein Broker-Import, keine Symbol-Logik (Statik-Test) | None |
| T10 | Health-Prüfung als SSRF/DoT | Manipulierte Basis-URL/Timeout | Nur `http(s)`-URLs aus `providerConfigFromEnv` (bestehender Sanitizer), hartes Abort-Timeout (1500 ms), read-only Modelllisten, Fehler → `offline` | Lokale URLs aus `.env` (Operator-vertrauenswürdig) |

### Red-Team-Checkliste (je Punkt geprüft)

| Kriterium | Status | Nachweis |
| --- | :---: | --- |
| **Kein Agenten-Selbstwechsel** | ✅ | `tests/routing.integration.test.ts`: `MODEL_RESEARCH=evil-model` wird ignoriert; Modell kommt aus der Routing-Entscheidung. `tests/routing.injection.test.ts`: Felder wie `model`/`force`/`requestedClass` im Kontext bleiben wirkungslos. |
| **Injection-Resistenz** | ✅ | 6 bösartige Payloads × Prompt/Kontext/Eskalations-Reason/Modell-Output/untrustedData ⇒ identische Entscheidungen; `toRoutingContext()` reduziert auf die 9 Whitelist-Felder. |
| **Budget-Deckel** | ✅ | Provider-/Agenten-/Tagesdeckel erzwungen; Zwangsrückstufung + `budget_blocked`-Audit; Deckel greift auch im `manual`-Modus; `budgetExempt` nur als auditierte Admin-Ausnahme. |
| **Admin-Guard für Policy/Modi** | ✅ | `PUT /api/routing/modes`: ohne Admin-Token → 403 `FORBIDDEN`; ohne CSRF → 403 `CSRF_INVALID`; ungültige Modi → 422 `INVALID_MODES`; Änderung ⇒ Audit-Eintrag mit Actor. |
| **Audit-Vollständigkeit** | ✅ | Assertion-Test über 6 Wechsel-Szenarien: jeder Wechsel hat einen Eintrag mit korrektem `to`, Pflichtfeldern und Policy-Version; Wiederholung ohne Wechsel erzeugt keinen Eintrag (kein Spam). |
| **Fallback-Ketten** | ✅ | Ollama-Timeout → Gemini, Gemini-Quota 4 % → Ollama, Anthropic offline → Ollama, Komplettausfall → Regel-Engine; je ein Audit-Eintrag (`fallback`). |
| **Cloud-Deckel erzwungen** | ✅ | Policy-Validierung: `budgets.providers.{gemini,anthropic}.tokensPerDay <= 0` ⇒ Policy ungültig ⇒ Startverweigerung. |
| **Keine Secrets in der API** | ✅ | `scanTextForSecrets()` über alle `/api/providers`- und `/api/routing`-Responsen → 0 Funde. |
| **Kein Cloud-Zwang ohne Freigabe** | ✅ | 108-Fall-Matrix: kein Agent mit `allowCloud:false` erhält einen Cloud-Provider. |
| **Determinismus** | ✅ | 108-Fall-Matrix ruft jeden Fall zweimal auf ⇒ byte-identische Entscheidungen. |

### Statik-Prüfungen (Architektur)

| Prüfung | Ergebnis |
| --- | --- |
| `src/routing/**` importiert keine Markt-/Broker-/Order-Module | ✅ (kein Import von `src/brokers/**`, `src/portfolio/**`, `src/scanner/**`) |
| Router schreibt nie Orders/Positionen | ✅ (DB-Zugriff ausschliesslich `audit_log`, best-effort) |
| Kein `Math.random()`/`Date.now()` im Entscheidungspfad | ✅ (Uhr injiziert; `grep`-geprüft) |
| Kein `dangerouslySetInnerHTML`/`innerHTML` in Routing-Code | ✅ (kein UI-Code im Modul) |

### Coverage

`npm run test:coverage:routing` → **96,1 % Zeilen / 85,3 % Branches** über
`src/routing/**`, `src/app/api/providers/**`, `src/app/api/routing/**`
(79 Tests, alle grün; Gesamtsuite 944 Tests grün).

### Befunde

| ID | Severity | Datei | Problem | Status |
| --- | --- | --- | --- | --- |
| RT-01 | Medium | `src/lib/ollama.ts` (`localReason`) | Legacy-Pfad (engine/macroCycle/analysts) ruft weiterhin direkt `chatLlm()` ohne Router | ✅ Offen dokumentiert: Router-Pflicht gilt für die Agenten-Laufzeit (`src/cycle/ports.ts`); Migration des Legacy-Pfads ist Folgeaufgabe |
| RT-02 | Info | `src/routing/registry.ts` | Cloud-Health ohne `ROUTING_HEALTH_PROBE=all` key-basiert | ✅ Dokumentiert + Fallback-Kette fängt Fehlannahmen ab |
| RT-03 | Info | `src/routing/budget.ts` | Zähler prozess-lokal (Single-Node) | ✅ konsistent mit dem bestehenden Rate-Limiter; Mehrinstanzen-Betrieb braucht geteilte Zustandsquelle |
| RT-04 | Info | `src/app/api/routing/modes/route.ts` | Admin-Guard ist token-basiert (kein Rollenmodell) | ✅ `TODO(task-10)`, timing-safe, auditiert |
| RT-05 | Info | `src/routing/audit.ts` | DB-Senke best-effort | ✅ Ring + NDJSON-Datei bleiben Wahrheit; Audit-Pfad wirft nie |

Fazit: **kein High/Critical-Befund.** Die drei Governance-Ziele sind erreicht und
messbar belegt: kein Agenten-Selbstwechsel, keine Injection-basierte Eskalation,
keine ungedeckelte Cloud-Nutzung.

---

## Security Audit — Task 10 (Operations Center + RBAC, v1.18.0, Phase 1)

> **Nachtrag v1.23.0 (2026-08-29):** Das Operations Center aggregiert jetzt zehn
> Sektionen (`src/ops/`, Katalog in `src/auth/ops.ts`) statt sieben Karten mit
> fünf Platzhaltern. Nachaudit: **kein neuer Befund.** Die Aggregation ist
> strikt lesend (kein Schreibpfad, kein Order-Pfad, kein Secret im Payload),
> jeder Fehlerzustand ist fail-soft und fail-closed (`unavailable` statt grünem
> Wert). T3/T4 unten gelten unverändert auch für den erweiterten Payload;
> der Secret-Scanner läuft über die vollständige Antwort
> (`tests/ops.api.test.ts`).

**Stand:** 2026-08-28 · **Modul:** `src/auth/` ·
**API:** neu `GET /api/auth/me`, `GET /api/ops` ·
**UI:** Dashboard-Tab Operations Center.
**Status:** ERHÖHT (Rollen, Token-Mapping) — Threat Model + Checkliste.

### Threat Model

| # | Bedrohung | Angriffsweg | Gegenmaßnahme | Restrisiko |
| --- | --- | --- | --- | --- |
| T1 | Operator schreibt Broker-Secrets | x-firm-token gegen Credential-API | `broker.credentials` nur Admin; wenn Admin-Token gesetzt, Operator → 403 | Single-Admin (kein Admin-Token) erbt bewusst |
| T2 | Viewer mutiert | Viewer-Token auf POST | Viewer-Permissions ohne write; Firm-Routen weiter `guardWrite` (Operator-Token) | Firm-APIs noch nicht auf RBAC umgestellt (Phase 4) |
| T3 | Token-Echo | `/api/auth/me` / `/api/ops` | PublicActor ohne Token-Werte; Secret-Scanner in Tests | None |
| T4 | Live-Freigabe über Rolle | Permission `live.gate` | In keiner Rolle; `requirePermission("live.gate")` immer 403; `/api/ops.liveEnabled` hart false | None bis Task 11 |
| T5 | Timing-Oracle | Token-Vergleich | `tokenEquals` (Längen-Padding, timing-safe) | None |
| T6 | CSRF | Cross-Site gegen Credentials | unverändert: `x-csrf-token` Pflicht | Offen-Betrieb akzeptiert `local` (Single-User) |

### Checkliste

| Kriterium | Status | Nachweis |
| --- | :---: | --- |
| **Kein live.gate** | ✅ | Matrix-Test + `liveGateGranted` |
| **401/403-Kompatibilität** | ✅ | Bestand `tests/controlPlane.api.test.ts` |
| **Kein Token in Responses** | ✅ | `tests/ops.api.test.ts` Secret-Scanner |
| **GET ohne Token ladbar** | ✅ | `/api/ops` 200 im Offen-Betrieb |
| **Architecture-Tab ohne Framework-Essay** | ✅ | `tests/task10.architecture.test.ts` |
| **Bitunix-Store an Control Plane** | ✅ | Default `createDefaultBitunixSecretStore`, Env-Fallback |

### Befunde

| ID | Severity | Datei | Problem | Status |
| --- | --- | --- | --- | --- |
| RB-01 | Info | `src/lib/apiAuth.ts` | Firm-Schreib-APIs noch `FIRM_API_TOKEN` statt Permission-Guard | ✅ Phase 4; Operator-Token bleibt wirksam |
| RB-02 | Info | `src/auth/resolve.ts` | Keine Sessions | ✅ Phase 4 |
| CP-01 | Info | `guard.ts` | war RBAC-Platzhalter | ✅ behoben: Fassade über `src/auth` |
| RT-04 | Info | `routing/modes` | war Token-Platzhalter | ✅ derselbe Admin-Guard, jetzt RBAC |

Fazit: **kein High/Critical-Befund.** Phase 1 verschiebt die Trust-Grenze nicht:
Live bleibt zu, Secrets bleiben im Store, neue Endpunkte sind lesend und leak-frei.

---

## Security Audit — Task 11 (Live Trading Gate, v1.19.0)

**Stand:** 2026-08-28 · **Modul:** `src/live-gate/**` ·
**API:** `GET /api/live/state`, `POST /api/live/transition`, `POST /api/live/kill` ·
**Integration:** Broker-Factory, Bitunix-Gates, Control-Plane-`readGateState`,
RBAC (`live.gate`), Ops-Center · **CI:** Job `security-live-gate`
(merge-blockierend, Coverage-Tor ≥ 95 % Zeilen auf `src/live-gate/**`).
**Status:** ERHÖHT — der Live-Pfad ist jetzt eine auditierte, mehrfach
gesicherte State-Machine statt eines blinden Throws. **Live bleibt OFF.**

### Architektur-Kurzbeschreibung

9 Zustände (`DISCONNECTED → … → LIVE_ENABLED`), exakt 8 legale Übergänge
mit objektiven Checks (`BrokerGatePort`, read-only/simuliert), Human-Gate
mit Cooldown (24 h) und optionalem 4-Augen-Modus, Single-Point-Enforcer mit
10-stufiger Fail-Safe-Prüfung, Kill-Switch mit persistenter Failsafe-Datei,
append-only Audit mit SHA-256-Hash-Kette, CI-Suite-Stamp als Enforcer-
Bedingung. Details: [LIVE_TRADING.md](LIVE_TRADING.md).

### Threat Model

| # | Bedrohung | Angriffsweg | Gegenmaßnahme | Restrisiko |
| --- | --- | --- | --- | --- |
| T1 | **Zustands-Sprung** (Human-Gate umgehen) | `PAPER_APPROVED → LIVE_ENABLED` direkt anfragen; State-File manuell auf `LIVE_ENABLED` setzen | Matrix erlaubt nur die 8 Kanten (81 Kombinationen getestet, 0 Durchlässe); LIVE_ENABLED-Übergang verlangt Flags+Suite+Control Plane; jedes Öffnen ist Admin-Aktion mit Grund + Audit | State-File-Manipulation allein würde genügen, WENN Flags+Suite+CP zusätzlich stimmen — physischer/FS-Zugriff vorausgesetzt; Kill-Datei dominiert (getestet); Hash-Kette macht Manipulation sichtbar |
| T2 | **Flag-Missbrauch** | Alle Env-Flags auf true drehen (ohne Machine-Durchlauf) | Enforcer verlangt State=LIVE_ENABLED **und** Flags **und** Suite **und** CP; Testmatrix 9 States × 16 Flag-Kombis: 0 falsche Allows; Flags sind read-only im Code (Architekturtest) | Keins (Flags allein öffnen nichts) |
| T3 | **UI-/Prompt-Bypass** | Agent/UI behauptet „live erlaubt"; UI-Flag setzen | Zustandsänderungen nur über `POST /api/live/*` (Permission `live.gate`, CSRF, Rate-Limit) bzw. CLI; Enforcer liest ausschließlich persistierte Quellen, nie UI/Agent-Aussagen (Architekturtest: keine UI-Imports) | Keins |
| T4 | **Audit-Manipulation** | Audit-Log nachträglich editieren/einfügen/kürzen | SHA-256-Hash-Kette (jeder Eintrag enthält Vorgänger-Hash); `verifyAuditChain` erkennt Verändern/Einfügen/Entfernen; Truncation über Kettenkopf im State-File; `GET /api/live/state` zeigt Integrität | Angreifer mit FS-Zugriff könnte Kette komplett neu berechnen — dann stimmen aber State-File-Köpfe nicht mehr; Offline-Verifikation gegen Kopie empfohlen (Betriebshandbuch) |
| T5 | **Crash-Inkonsistenz** | Absturz mitten in einer Transition → halboffener Zustand | Intent-Protokoll (pendingTransition persistiert); Lese-Pfad verwirft Intents und auditiert `crash-recovery/ABORTED`; atomare Writes (tmp+fsync+rename); korrupte Files → DISCONNECTED | Keins (getestet inkl. Restart-Simulation) |
| T6 | **Kill-Switch versagt** | DB/Netz/Store ausgefallen, Notfall-Kill nötig | Kill wirkt über Memory (sofort) + lokale Datei (persistent, ohne Infrastruktur); Reihenfolge Datei-VOR-State-Reset; Kill-Drill aus allen 9 Zuständen inkl. read-only-Dir | Keins im Single-Node; Multi-Instanz bräuchte gemeinsame Ablage (dokumentiert) |
| T7 | **Enforcer-Umgehung** (Adapter direkt, ohne Factory) | `new BitunixBrokerAdapter("live")` + `placeOrder` | Adapter ruft `assertLiveOrderAllowed` in jedem Live-Pfad selbst (Architekturtest + Red-Team-Test); `placeSerializedOrder` existiert nur im Adapter | Keins für Bitunix; künftige Live-Adapter MÜSSEN das Muster übernehmen (Peer-Review-Checkliste) |
| T8 | **Self-Approval / Cooldown umgehen** | Admin bestätigt sofort selbst; zweiter Account = derselbe Mensch | Cooldown serverseitig erzwungen (retryAt im Deny); Begründungs-, Confirm- und Approver-Pflicht; 4-Augen-Modus vergleicht Approver-Namen | 4-Augen identifiziert keine Token-Identität (ein Admin-Token im RBAC) — Task-12-Follow-up dokumentiert |
| T9 | **CI-Suite umgehen** | PR mergen, obwohl Security-Suite rot | Required Check `security-live-gate` (Branch Protection) + Enforcer verlangt Suite-Stamp (passed, runId, Max-Alter 7 d) | Branch Protection muss einmalig vom Repo-Admin eingerichtet werden (im PR beschrieben); Stamp-Datei ist Deployment-Artefakt |
| T10 | **Secret-Leak über Live-Gate-API** | Token/Credentials in State-/Audit-/Status-Ausgaben | Audit enthält nur strukturierte Felder; API zeigt gekürzte Hashes (Secret-Scanner über Responses grün); keine Credentials im Modul | Keins (Scanner in CI) |
| T11 | **DoS über Gate-API** | Transition/Kill flooden | Derselbe Sliding-Window-Limiter wie Credentials (5/min pro Client-Identität, Identität seit C2/v1.36.14 nicht client-setzbar) + CSRF + Permission-Guard; Deny-Audit ist schlank (Ring 500). Bewusst **ohne** globales Credential-Limit und **ohne** Backoff: ein Flood auf die Credential-API darf den Kill-Switch nicht blockieren | Prozess-lokaler Limiter (Single-Node, dokumentiert) |
| T12 | **PAPER als Live-Venue missbraucht** | `getBroker("PAPER","live")` | Capability `live=false` → `VENUE_NOT_LIVE_CAPABLE` vor allen Flags (getestet) | Keins |

### Red-Team-Checkliste (je Punkt geprüft)

| Kriterium | ✓ | Nachweis |
| --- | :---: | --- |
| Transitionsmatrix komplett, 0 Durchlässe | ✅ | `tests/liveGate.states.test.ts`: 8 legale Übergänge grün; alle 73 illegalen Kombinationen `ILLEGAL_TRANSITION` + Audit-DENY |
| Sprung LIVE_PENDING → LIVE_ENABLED | ✅ | deny + Zustand unverändert (Red-Team-Test) |
| Flag-Manipulation (Flags an, kein State) | ✅ | `STATE_NOT_LIVE_ENABLED` deny + Audit (`liveGate.enforcement.test.ts`) |
| Enforcement-Matrix vs. Oracle | ✅ | 9 States × 16 Flag-Kombis × Suite × CP: 0 falseAllows, 0 falseDenies |
| Nur exakt erlaubte Konstellation erlaubt | ✅ | `allowEnv` + LIVE_ENABLED + Suite + CP = einziger Allow-Pfad; Assert + Evaluate konsistent |
| Adapter-Order ohne Factory | ✅ | direkt konstruierter Live-Adapter wirft in placeOrder/getAccount/getPositions |
| Audit-Manipulation erkannt | ✅ | Verändern (Hash-Abweichung seq 2), Entfernen (seq-Bruch 3), Einfügen (prevHash-Bruch), Truncation (head-Abgleich) |
| Kill-Drill aus allen 9 Zuständen | ✅ | je Zustand: Memory+Datei+DISCONNECTED+KILLED-Audit; Live-Order danach verweigert |
| Kill bei Store-Ausfall | ✅ | read-only-Dir: `failsafeFileWritten:false` gemeldet, Memory-Sperre verweigert weiter |
| Kill nicht „rückgängig" ohne Neudurchlauf | ✅ | nach Clear: LIVE_ENABLED-Sofortversuch → `ILLEGAL_TRANSITION` |
| Cooldown vor Ablauf | ✅ | `COOLDOWN_ACTIVE` + retryAt; Zustand unverändert; Deny auditiert |
| 4-Augen | ✅ | erste Bestätigung `FOUR_EYES_PENDING` (auditiert), gleicher Approver deny, anderer Approver Übergang |
| Crash/Neustart-Konsistenz | ✅ | Persistenz über Runtime-Neustart; halboffene Transition → `crash-recovery/ABORTED` |
| Keine echten Orders in CI | ✅ | alle Venue-Zugriffe über zählende Mock-Ports (`liveGateTestUtil`), Architekturtest verbietet Credentials in Suite; Default-Port `placeTestOrder` verweigert immer |
| Secret-Scan negativ | ✅ | `scripts/scan-live-gate-secrets.ts` (27 Dateien, 0 Funde) + Response-Scanner-Tests |
| Admin-Guard/CSRF/Rate-Limit | ✅ | `tests/liveGate.api.test.ts`: 403/401, `CSRF_INVALID`, 429, Kill-Phrase-Contract |
| Single-Point-Enforcement statisch | ✅ | `tests/liveGate.architecture.test.ts` (Factory-Routing, Adapter-Live-Pfade, kein zweiter Order-Pfad, keine Flag-Writes, keine UI-Imports) |

### Ergebnisprotokoll (Ausführung 2026-08-28)

| Suite | Ergebnis |
| --- | --- |
| `npm test` (Gesamt) | **1065/1065 grün** (987 Bestand + 78 neu) |
| `npm run security:live-gate` | **78 Tests grün**, Coverage **95,81 % Zeilen** auf `src/live-gate/**` (Tor 95 %), Exit 0 |
| `npm run typecheck` / `npm run lint` | grün / 0 Fehler |
| `node --import tsx scripts/scan-live-gate-secrets.ts` | 27 Dateien, **0 Funde** |
| Live-Status nach Merge | **OFF** (kein State-File, Flags false, kein Suite-Stamp im Betrieb) |

### Befunde

| ID | Severity | Datei | Problem | Status |
| --- | --- | --- | --- | --- |
| LG-01 | Info | `src/live-gate/service.ts` (4-Augen) | Approver-Vergleich über Namen, nicht Token-Identität (ein Admin-Token im RBAC-Kern) | ✅ dokumentiert; echte 2-Personen-Identität → Task 12 |
| LG-02 | Info | `src/live-gate/checks.ts` | ORDER_TEST_OK/PAPER_APPROVED ohne registrierte Provider unerreichbar (bewusst fail-closed) | ✅ gewollt; Venue-Testnet-Anbindung ist Folgeaufgabe |
| LG-03 | Info | CI-Job-Installation | Job-Quelle liegt bei `docs/ci/security-live-gate.workflow.yml`; Kopie nach `.github/workflows/` + Branch-Protection (Required Check) muss der Repo-Owner einmalig einrichten (Arena-Bot darf keine Workflow-Dateien schreiben) | ✅ im PR + LIVE_TRADING.md (Abschnitt CI) beschrieben; Enforcer verlangt zusätzlich Suite-Stamp |
| LG-04 | Info | `package.json` (security:live-gate) | Coverage-Tor auf Zeilen ≥ 95 % (Funktionendeckung unter tsx durch Phantom-CJS/ESM-Duplikate verzerrt) | ✅ dokumentiert; Branches/Funktionen werden berichtet |

Fazit: **kein High/Critical-Befund.** Die Trust-Grenze Live ist jetzt eine
prozessual erzwingbare, auditierbare Kette: Checks → Paper-Evidence →
Antrag → 24 h Bedenkzeit → menschliche Freigabe → CI-Suite → Flags →
Control Plane — und ein Kill-Switch, der aus jedem Zustand sofort greift.

---

## Security Audit — Task 12 (Dokumentation, v1.19.0)

**Scope:** Alle Docs-Änderungen des Task 12: `docs/help/*.help.json`,
`docs/help/help.schema.json`, Root-Docs (`README.md`, `INSTALL.md`,
`CHANGELOG.md`), `docs/DOCS_SYNC_AUDIT.md`, `docs/ARENA_TASKS.md`,
`docs/ARCHITECTURE.md`, `docs/SECURITY_AUDIT.md`, `docs/ci/docs-validate.workflow.yml`,
`scripts/docs-validate.ts`, `package.json` (npm-Skript `docs:validate`).
**Keine funktionalen Code-Änderungen** (nur neues Validator-Skript + npm-Skript).

### Checkliste

| Pflicht | Status | Nachweis |
| --- | --- | --- |
| Secret-Scan über Docs (0 Funde) | ✅ | `npm run docs:validate` → Secret-Scan; Skript `scripts/docs-validate.ts` |
| Keine internen Hostnamen / keine PPI in Docs | ✅ | manueller Review + Secret-Scan-Patterns (interne IPs/PPI) |
| Sicherheitsbeschreibungen korrekt (Mechanismen, nie Zugangsdaten) | ✅ | alle Beispiele nutzen Platzhalter/Env-Refs (`$FIRM_ADMIN_TOKEN`, `sk-…`, `bitte-hier-aendern`) |
| Keine echten Keys/Secrets in Docs | ✅ | keine Treffer für API-Key-/Token-/PrivKey-Patterns |
| Konsistenz-Checks gegen Code | ✅ | Env-Flags, API-Routen, Live-State-Enum (Validator) |
| Hilfe-Systematik 3-Ebenen schema-konform | ✅ | alle 9 `*.help.json` gegen `help.schema.json` |
| kein nicht-implementiertes Feature als fertig beschrieben | ✅ | Status-Header `Implementiert/Teilweise/Geplant + Task NN`; Features ohne Codebefund als „Geplant“ |

### Befunde

| ID | Severity | Problem | Status |
| --- | --- | --- | --- |
| D-01 | Info | `docs/help/help.schema.json` fehlte, obwohl Hilfe-Dateien darauf verwiesen (`https://ai-trading-firm.local/schemas/help-3-ebenen.json`) | ✅ behoben: Schema neu erstellt, `$schema`-Referenzen vereinheitlicht |
| D-02 | Info | `live-gate.help.json` `version` als String (`"v1.19.0"`) statt Zahl | ✅ behoben |
| D-03 | Info | 21 Hilfe-Felder (brokers 8, live-gate 12, ops 1) ohne `risiko`-Ebene — Verstoß gegen 3-Ebenen-Systematik | ✅ behoben: `risiko` ergänzt |
| D-04 | Info | 3 Markdown-Trailing-Whitespace-Stellen | ✅ behoben |
| D-05 | Info | Root `README.md`/`INSTALL.md`/`CHANGELOG.md` fehlten (nur in `docs/`) | ✅ behoben |

Fazit: **keine Secrets, keine internen Hostnamen, keine PPI** in den Docs.
Alle Befunde sind Dokumentations-Fehler (Severity Info) und behoben. Der
CI-Job `docs-validate` erzwingt künftig die Docs-as-Code-Regeln
(Schema, Links, Lint, Secret-Scan, Konsistenz) merge-blockierend.

## Konsolidierung der Task-Audit-Kapitel 1–12

Alle Sicherheits-Audits je Task sind als eigene Kapitel oben in dieser Datei
vorhanden und werden hier gebündelt verlinkt:

| Task | Kapitel | Niveau |
| --- | --- | --- |
| 01 Market Universe | [Security Audit — Task 01](#security-audit--task-01-market-universe-v180) | Standard |
| 02 Broker-Capability-Modell | [Security Audit — Task 02](#security-audit--task-02-broker-capability-modell-v1100) | Standard |
| 03 Paper Market Data | [Security Audit — Task 03](#security-audit--task-03-paper-market-data--execution-simulation-v1110) | Standard |
| 04 Markt-Scanner | [Security Audit — Task 04](#security-audit--task-04-markt-scanner-market-score--trichter-v1120) | Standard |
| 05 Portfolio-Analytics | [Security Audit — Task 05](#security-audit--task-05-portfolio-analytics-optimizer--risk-guard-kette-v1130) | Standard |
| 06 Daily & Weekly Agent Cycle | [Security Audit — Task 06](#security-audit--task-06-daily--weekly-agent-cycle) | Standard |
| 07 Bitunix-Adapter | [Security Audit — Task 07](#security-audit--task-07-bitunix-adapter-v1150) | Erhöht |
| 08 Broker Control Plane | [Security Audit — Task 08](#security-audit--task-08-broker-control-plane-v1160) | Erhöht |
| 09 Model Router | [Security Audit — Task 09](#security-audit--task-09-model-router-v1170) | Erhöht |
| 10 Operations Center + RBAC | [Security Audit — Task 10](#security-audit--task-10-operations-center--rbac-v1180-phase-1) | Erhöht |
| 11 Live-Trading-Gate | [Security Audit — Task 11](#security-audit--task-11-live-trading-gate-v1190) | Maximal |
| 12 Dokumentation | [Security Audit — Task 12](#security-audit--task-12-dokumentation-v1190) | Standard |
