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

---

## 4. Testabdeckung nach Fixes

| Bereich | Tests | Status |
| --- | --- | --- |
| Indikatoren (RSI, EMA, ATR, Snapshot) | 6 | ✅ |
| Risiko-Guardrails & Ceilings | 7 | ✅ |
| `parseDecision` (inkl. Injection/Pollution) | 9 | ✅ |
| Berliner Zeit & DST | 8 | ✅ |
| **Broker (Neu)** Hydration, Guardrails, Validierung | 10 | ✅ |
| **LLM-Provider (Neu)** Builder/Parser/Retry/Kosten/Chain | 21 | ✅ |
| **Security (Neu)** Symbole, Fallback, Kette | 6 | ✅ |
| **Härte v1.4.0** Secrets, Token, Rate-Limit, Intervalle, Allowlist | 18 | ✅ |
| **Gesamt** | **85** | ✅ 85/85 |

Zusätzliche Verifikation (jede Release): `npm run typecheck` ✅ · `npm run lint` ✅ (0 Fehler) ·
`npm run build` ✅ · `npm audit` → 0 Vulnerabilities ✅.

---

## 5. Empfehlungen (Backlog)

1. **`FIRM_API_TOKEN` aktivieren**, sobald der Dienst außerhalb von 127.0.0.1 erreichbar ist (LAN/Cloud) — der Token-Schutz existiert, ist aber nur optional.
2. **Regelmäßiges `npm audit`** in die Deploy-Checkliste aufnehmen (`CI`-Job empfohlen).
3. **Live-Broker erst nach** Sicherheits-Checkliste (HANDBUCH Kapitel 11); kein Adapter im Auslieferungszustand.
4. **Rate-Limiting** ist seit v1.4.0 prozess-lokal aktiv (60/min); hinter einem Proxy `x-forwarded-for` nicht als Sicherheitsgrenze behandeln.
5. **DB-gestützte Scheduler-Locks** bei Multi-Node-Betrieb (aktuell Single-Node).
