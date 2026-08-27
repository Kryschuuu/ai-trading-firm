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
4. **Rate-Limiting** ist seit v1.4.0 prozess-lokal aktiv (60/min); hinter einem Proxy `x-forwarded-for` nicht als Sicherheitsgrenze behandeln.
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
