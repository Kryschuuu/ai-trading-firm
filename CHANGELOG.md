# Changelog — Autonome KI-Trading-Firma

> ## ⚠️ BETA-PHASE (v0.x.x)
>
> Dieses Projekt befindet sich in der **Beta-Phase** und ist **nicht produktionsreif**.
> Es ist für **Bildungszwecke und private Nutzung auf eigene Gefahr** konzipiert.
> Der Autor lehnt jegliche Haftung für finanzielle Verluste, technische Fehler,
> Datenverlust oder Schäden ab. Trading und Investitionen beinhalten erhebliche
> Risiken — nutze diesen Code nur nach vollständiger rechtlicher Prüfung.
>
> **Versionsschema:** Ab sofort wird das Projekt nach dem öffentlichen
> **v0.x.x-Schema** (SemVer, 0.x = Beta) versioniert. Die bis 2026-09-23 intern
> verwendete Zählung `v1.x.x` war die fortlaufende Nummer der **Beta-Entwicklung**
> und gehört nicht zum öffentlichen Schema. Die vollständige, unveränderte
> Historie unter der alten Zählung ist archiviert unter
> [`docs/archive/CHANGELOG-legacy-v1.md`](docs/archive/CHANGELOG-legacy-v1.md)
> und dort als Meilenstein-Referenz zu lesen (dortige `v1.73.1` ≙ hier `v0.1.0`).

Alle für Nutzer sichtbaren Änderungen werden in dieser Datei dokumentiert.
Format: [Keep a Changelog 1.1.0](https://keepachangelog.com/de/1.1.0/) ·
Versionierung: [SemVer](https://semver.org/lang/de/) (0.x: Breaking Changes sind
erlaubt, solange sie hier dokumentiert sind).

> **Status-Header:** **Beta** · Dokumentationsstand **2026-10-05** · Code-Version **0.17.2** ·
> Kanonische Quelle der Version: `package.json` (siehe [`VERSION.md`](VERSION.md)).

## [0.17.2] — TASK 03/04/05/07: Integrationspfade und PIT-Härtung (2026-10-05)

### Added

- **TASK 05:** `riskStep.ts` richtet die Risk-freigegebenen Kursreihen auf gemeinsamen Zeitstempeln aus und berechnet guarded Risk-Parity-Gewichte. Research hängt diese Gewichte erst nach der Modell-Validierung an die Proposal-Ausgabe an, filtert nicht freigegebene Setups und renormalisiert bei einer engeren Shortlist. Die Gewichte bleiben relative Vorschläge; absolute RiskGuard-/Order-Gates ändern sich nicht.
- **TASK 07:** `trade_rules`-NOTIFY-Trigger-Migration und verbindender `RuleCache`-Registry-/Listener-Pfad mit exponentiellem Reconnect-Backoff.
- **TASK 03:** Bitunix-Perp-Fixture-End-to-End-Test erfasst Funding-Historie, Snapshot-Queries und credential-freie Requests.

### Fixed

- **TASK 03:** Funding-Snapshot wird im dokumentierten Dezimalformat übernommen; fehlerhafte Division durch 100.000 entfernt. Asymmetrische Funding-Grenzen verwenden das Maximum der absoluten Limits. Bitunix Open Interest und Liquidationen werden als `UNSUPPORTED` behandelt, nicht als fehlende Implementierung oder Nullmessung verschleiert.
- **TASK 04:** Makro-Risikofaktor liest nun das tatsächliche Cycle-Artefakt-Root/Index. Maßgeblich ist der jüngste indexierte Lauf, nicht ein älterer erfolgreicher Snapshot: ein neuerer fehlgeschlagener/unvollständiger Lauf sowie fehlende, stale, zukünftige, fehlerhafte oder übersprungene Ausgaben bleiben neutral. `LOW` erhöht das Risiko nicht.
- **TASK 05:** Risk- und Research-Schritte können nicht mehr über Modell- oder `context.input`-Listen Deterministik-Freigaben umgehen. Analytics, Referenzkerzen und Backtest filtern sowohl Event-Zeit als auch `fetchedAt` gegen `asOf`.
- **TASK 07:** RuleCache-Ladevorgänge sind single-flight und generation-safe. Nach einer NOTIFY bleibt der Cache bei fehlgeschlagenem Reload fail-closed, bis ein aktueller Snapshot geladen ist; fehlgeschlagene reguläre Polls können dagegen den letzten gültigen Snapshot weiterverwenden. Der Listener behandelt sowohl Socket-Fehler als auch unerwartetes Session-Ende mit begrenztem Backoff und sendet bei sauberem Shutdown `UNLISTEN`, bevor die Pool-Verbindung freigegeben wird. Es gibt keinen unbeschränkten sofortigen Retry-Sturm; Polling bleibt der Fallback.
- **Roadmap/Version:** Veraltete Aussagen in `docs/roadmap/STATUS.md` und der Integrationsdokumentation korrigiert; Versionsdrift zwischen README, `VERSION.md`, Changelog und Package-Metadaten bereinigt. `eslint-config-next` an Next.js `16.3.8` angeglichen.

### Verifikation und Betriebsgrenzen

- **Grün:** `npm run typecheck`, `npm run lint`, `npm run docs:validate`; gezielte Offline-/Unit-Läufe: 190/190 Tests bestanden. Embedded-Postgres-Läufe: Perp-Store + `trade_rules`-Trigger 9/9; separate Trade-Attribution 7/7 und Broker-Contracts mit Schema-/Migrationstest 42/42.
- **Vollsuite ohne externes PostgreSQL:** letzter `npm test`-Lauf: 4.722 bestanden, 2 fehlgeschlagen, 36 übersprungen (4.760 insgesamt). Beide Fehler sind die PAPER-Broker-Contract-Tests, die eine erreichbare Datenbank benötigen (`ECONNREFUSED 0.0.0.0:5432`); dieselbe Contract-Datei besteht 42/42 mit temporärem Embedded PostgreSQL und den erforderlichen Schema-/H2-Migrationen. Die gesamte Suite wurde daher nicht als vollständig grün verifiziert.
- **Dependency-Audit:** Produktionsabhängigkeiten: 0 bekannte Schwachstellen. Vollständiger npm-Audit meldet 5 High-Befunde ausschließlich im Dev-Lint-Zweig `eslint-config-next → fast-glob → micromatch → braces@3.0.3`; zum Prüfzeitpunkt war kein kompatibles `braces`-Patchrelease verfügbar. `npm audit fix --force` schlägt einen Downgrade auf Next 14 vor und wurde nicht angewendet.
- **Live-Bitunix:** Fetch war in der Sandbox netzwerkbedingt nicht verfügbar. Produktiver Funding-Sync erfordert `PERP_DATA_SYNC_ENABLED=true`, `BITUNIX_ENABLED=true`, `PERP_DATA_VENUES`-Freigabe, BITUNIX-Perpetual-Instrumente in der Universe-Registry und Netzwerkzugriff.
- `SIM` bleibt ein deterministischer Fixture-Provider und liefert keine Live-Daten. PostgreSQL-Trigger-Migration ist manuell anzuwenden; `drizzle-kit push` erstellt keine Trigger.

## [0.17.1] — Vorbereitende TASK-03-07-Infrastruktur (2026-10-05)

- **TASK 03:** Perp-Datenmodell, Fixture-Adapter, Derivative-Cache und Scanner-Faktoren waren vorhanden. Bitunix unterstützte im Perp-Pfad nur Funding; der Market-Data-Open-Interest-Hook lieferte `null`. Live-Abdeckung war nicht validiert; Bitunix OI/Liquidationen hatten keine öffentliche Quelle.
- **TASK 04:** Ein Makro-Faktor war zwar aufgerufen, las aber `data/cycle/02-macro-analyst.json`, das der Cycle-Artefakt-Writer nicht erzeugt — daher keine verlässliche Kopplung.
- **TASK 05:** `riskStep.ts` berechnete nur Equal-Weight-Zahlen; der Optimizer war nicht integriert und das Gewicht wurde nicht an Research-Proposals weitergegeben. TASK 05 war damit nicht abgeschlossen.
- **TASK 06:** Attribution-Aggregation (`aggregateTradeAttributions`) und Execution-Quality (`executionQuality/`) vorhanden; API-Endpunkte vorhanden.
- **TASK 07:** LISTEN-Grundgerüst war gestartet, aber nicht mit dem RAM-RuleCache verbunden; Trigger-Migration, sicherer Reload und Reconnect-Verhalten fehlten.

## [0.17.0] — ADR-003 + ADR-004: Atomare Mehrprozess-Order-Reservierung und zentrale Singleton-Verwaltung (2026-10-05)

Dieses Release setzt **ADR-003** (Atomare Mehrprozess-Order-Reservierung via `submitAtomic`)
und **ADR-004** (Zentrale Singleton-Verwaltung via `stateRegistry.ts`) aus
[`docs/roadmap/DECISIONS.md`](docs/roadmap/DECISIONS.md) verbindlich um. Beide
Entscheidungen schließen Race Conditions zwischen Next.js-Workern und dem
eigenständigen Mikro-Executor-Prozess aus (Befund H2) und beseitigen die
verstreuten `globalThis`-Definitionen, die Zustandsdrifts und unvorhersehbare
Test-Resets verursachten (Befund S2).

### Added

- **`PaperBroker.submitAtomic()` + `withAccountLock()`** (Bestandteil des
  Ledgers seit v1.36.19, jetzt der EINZIGE Order-Pfad für den Produktivbetrieb):
  eine Transaktion, eine Kontosperre, eine DB-Wahrheit.
- **Neues Modul `src/lib/brokerHydration.ts`:** die Broker-Wiederherstellung
  (Positionen/Cash/Kill-Switch aus PostgreSQL) liegt jetzt in einem
  LLM-freien Modul, das sowohl von der Web-App (`engine.ts`) als auch vom
  Mikro-Executor (`scripts/micro-executor.ts`) genutzt wird — kein
  doppeltes Hydrations-Code mehr.
- **Zwei weitere Accessoren in `stateRegistry`** (`firmSchedulerStarted`,
  `microLimitsLoadedAt`) — die vorher direkt auf `globalThis` saßen.
- **Konformitätstest-Suite `tests/adr003_adr004.test.ts`** (12 Tests), die
  die zentralen ADR-Invarianten gegen den Code festnagelt:
  - Adapter nutzen `submitAtomic` (kein synchroner `submit()` auf dem
    Singleton-Ledger).
  - Keine konkurrierenden `new PaperBroker(…)`-Instanzen im
    Mehrprozess-Pfad.
  - Keine veralteten Session-Locks (`pg_advisory_lock`) mehr.
  - `brokerHydration.ts` ist und bleibt LLM-frei.
  - `__resetAllSingletonsForTests()` deckt die neu registrierten
    Singletons mit ab.

### Fixed — H2 (Race Conditions Mehrprozess-Betrieb)

- **KRITISCH:** `PaperBrokerAdapter.placeOrder()` (der PAPER-Broker-Adapter
  in `src/brokers/paper.ts`) rief bisher den **synchronen** `submit()`
  auf und umging damit die gesamte `submitAtomic`-Schleuse
  (Kontosperre, `order_intents`-Reservierung, DB-Wahrheits-Prüfung).
  Ein API-Aufruf auf `/api/firm/...` und ein gleichzeitig feuernder
  Mikro-Executor konnten damit dieselbe Position doppelt eröffnen
  oder gemeinsam das Cash überziehen. Der Adapter geht jetzt durch
  `submitAtomic` und persistiert die Position in derselben Transaktion.
- **KRITISCH:** `createPaperRuleAdapter()` im Mikro-Executor erzeugte
  bei JEDEM Aufruf ein **neues** `new PaperBroker(…)` statt den
  Singleton-Ledger aus `paperBrokerLedger()` zu verwenden. Die lokale
  Instanz war unhydriert (leeres Startkapital) und hatte ein eigenes,
  handgerolltes `pg_advisory_lock('rule:'+symbol)` — ein Session-Lock
  (Lock-Leck bei Crash), der auf einem anderen Key als
  `withAccountLock` operierte und diesen **nicht** ersetzen konnte.
  Der Adapter nutzt jetzt den Factory-Singleton; die gesamte Lock-
  /Wahrheits-/Reservierungslogik liegt ausschließlich bei `submitAtomic`.
- Doppelter Hydrations-Code entfernt: Engine und Mikro-Executor teilen
  sich jetzt `ensurePaperBrokerHydrated()` (Single-Flight + Backoff).
- Manuelle DB-Client-Verwaltung (`getPool().connect()`) im Regel-
  Ausführungspfad entfernt — veraltete Positions- und Kill-Switch-
  Abfragen waren redundant zu `submitAtomic`.

### Changed

- `scripts/micro-executor.ts` übergibt `ensureHydrated` an
  `createPaperRuleAdapter()` und startet die Hydration bereits beim
  Prozessstart (Single-Flight über `stateRegistry`).
- `src/lib/engine.ts` importiert die Hydration aus dem neuen
  `brokerHydration.ts`-Modul statt sie file-lokal zu halten.
- `src/instrumentation.ts` und `src/lib/microExecutor.ts` nutzen für
  ihre bisher rohen `globalThis`-Flags (`__firmSchedulerStarted`,
  `__microLimitsLoadedAt`) jetzt die zentralen Accessors aus
  `stateRegistry`.
- `docs/roadmap/DECISIONS.md` (ADR-003/ADR-004) sind jetzt Code-geworden
  — siehe Konformitätstests.

### Migration

- **Keine Schema-Migration notwendig:** `order_intents` mit partiellem
  UNIQUE-Index auf `(symbol) WHERE status='RESERVED'` existieren seit
  `drizzle/2026-09-04_h2_order_intents.sql` (v1.36.19).
- **Keine Konfigurationsänderung.**

### Tests

- `tests/adr003_adr004.test.ts` (12 Tests, statisch, keine DB).
- `npm run typecheck` und die nicht-DB-gebundenen Test-Suiten
  (Broker-Factory, Risk-Guard, AdrVocabulary, ADR-003/004) laufen grün.

## [0.16.1] — Dashboard-Reiter schalten den sichtbaren Bereich um (2026-10-04)

### Fixed

- **Reiter im Dashboard hatten keine Funktion:** Firm Overview, Reports, Protokoll, Agents & Orchestrator, Workshop, Operations Center, Brokers & Venues, Risk & Guardrails und Design & Guide wurden nach dem Laden alle untereinander gerendert. Ein Klick setzte nur `aria-selected`; der Inhalt blieb stehen.
- `TabPanel` verlangt jetzt `active`. Inaktive Panels tragen `hidden`, `inert` und `display: none` und nehmen keinen Platz ein. Zustand (Formulare, bereits geladene Listen) bleibt erhalten, `aria-controls` zeigt weiter auf ein vorhandenes Panel.
- Dieselbe Lücke in den fünf Workshop-Schritten ist geschlossen: dort ist ebenfalls nur der gewählte Schritt sichtbar.
- Unbekannte Sprungziele („Tab öffnen“ mit einer ID, die kein Reiter ist) lassen den aktuellen Bereich stehen, statt eine leere Fläche zu zeigen.
- Nach einem Wechsel wird der gewählte Bereich in den Sichtbereich geholt, damit ein Klick weiter unten auf der zuvor langen Seite nicht im Leerraum landet.

### Tests

- `tests/ui/Tabs.test.tsx` prüft die Auswahlfunktion, das ausgeblendete Markup für alle neun IDs und die `active`-Bindung in Dashboard und Workshop.

## [0.16.0] — Historischer Marktdaten-Backfill und längere Reihen (2026-10-04)

### Added

- **CLI-Datumsbereiche:** `market:sync` akzeptiert inklusive `--from`-/`--to`-Grenzen als UTC-Datum (`YYYY-MM-DD`) oder ISO-8601-Zeitstempel mit Zeitzone. Bereiche umgehen den inkrementellen „aktuelle Kerze vorhanden“-Skip; das Kerzenlimit wird aus der benötigten Range und dem feinsten Timeframe abgeleitet.
- **Venue-spezifischer historischer Abruf:** Binance und Bitunix paginieren Klines rückwärts; Kraken verwendet `since`, bleibt aber auf die jüngsten 720 OHLC-Einträge begrenzt. Yahoo fragt begrenzte `period1`/`period2`-Fenster ab.
- **Getrennte Backfill-Metriken:** Sync-Ergebnisse unterscheiden tatsächliche `getCandles`-Adapteraufrufe, valide abgerufene Bars, neu gespeicherte Bars und deduplizierte Bars; der Ziel-Nenner zählt auch bei Strict-Abbruch nur wirklich gestartete Reihen.

### Changed

- Der Sync-Default steigt von 150 auf **201 Kerzen** (CTI-EMA-200-Warmup); der unabhängige Scanner-Warmup bleibt bei 61.
- Historische Seriengrenze und Store-Retention werden auf **100.000 Bars je Instrument/Timeframe** angehoben. Ein Sync-Lauf ist auf **1.000.000 angeforderte Bars** und 1.000 Seiten je Reihe begrenzt.
- Bitunix Public Market-Sync wird auf 4 Requests/s begrenzt (unter dem dokumentierten 10-req/s-IP-Limit); 429-`Retry-After` kühlt den geteilten Token-Bucket. Das Perp-Datenlimit bleibt separat bei 3 req/s.
- Bitunix-Kline-Antworten werden mit venue-konformer Seitengröße geladen; der HTTP-Transport kappt übergroße Antworten während des Streams.

### Fixed

- Kerzen außerhalb eines angeforderten `--from`/`--to`-Fensters werden selbst dann nicht gespeichert, wenn ein Adapter die Grenzen nicht beachtet.
- Wiederholte Historien-Läufe unterscheiden nun sauber zwischen abgerufen, neu gespeichert und dedupliziert, statt geringe Store-Neuzugänge mit geringer API-Abdeckung gleichzusetzen.

### Tests

- Regressionen für Bitunix-Seiten (200/200/5), Binance (1000/1), Kraken (720er-Seitengrenze), inklusive Range-Filterung, Datumvalidierung, Serien-/Lauflimits und Sync-Zähler.

## [0.15.1] — Reports-UI bleibt bei abgelaufener Session erreichbar (2026-10-04)

### Fixed

- **401-Regression nach dem UI-Update behoben:** `GET /api/firm/report` darf
  einen Authentifizierungsfehler nicht mehr als Report-Daten in den React-State
  schreiben. Der Fehlerbody enthielt keine `summary`-Liste; die anschließende
  Darstellung griff auf `undefined.length` zu und ließ die gesamte Seite mit
  „This page couldn’t load“ abbrechen.
- **Expliziter Laufzeitvertrag für Reports:** Erfolgsantworten werden vor dem
  Rendern validiert. 401/403-Antworten zeigen stattdessen einen verständlichen
  Hinweis und öffnen den bestehenden Session-Loginpfad; fehlerhafte oder
  unvollständige Antworten bleiben lokal unsichtbar.
- **Regressionstest ergänzt:** `tests/reportResponse.test.ts` deckt gültige,
  nicht autorisierte und unvollständige Report-Antworten ab.

## [0.15.0] — UI-Überarbeitung: volle Bildschirmbreite überall, ein Layout-System für alle Seiten, responsive Tabellen & Reiter (2026-10-04)

### Changed — Volle Breite und ein gemeinsames Layout-System (2026-10-04)

Bis v0.14.0 nutzte **nur** der Doku-Viewer die volle Bildschirmbreite; Dashboard
und Broker-Seite endeten bei `mx-auto max-w-7xl` (1280 px). Auf 27"–34"-Monitoren
blieben mehrere hundert Pixel ungenutzt, obwohl genau dort die datendichten
Tabellen (offene Positionen mit 10 Spalten, Risikofelder, Coverage-Matrix,
Monatsrenditen) und die Equity-Kurve stehen. Jede Seite entschied Breite,
Kartenstil, Tabellenverhalten und Reiter-Navigation für sich — die Stile
drifteten entsprechend.

1. **Ein Layout-System** (`src/components/ui/layout.ts`): `PAGE_GUTTER`
   (`px-3 sm:px-5 lg:px-8 2xl:px-10 3xl:px-12`), `PAGE_GUTTER_BLEED` für
   randlos klebende Leisten, `PANEL`/`PANEL_PADDED`/`PANEL_HEADER`,
   `SECTION_TITLE`, `LABEL`, `PROSE_MEASURE`, `MUTED_TEXT`, `BUTTON_*` und die
   inhaltsangepassten Raster `AUTO_FIT_CARDS` (17 rem), `AUTO_FIT_PANELS`
   (22 rem) und `AUTO_FIT_WIDE` (30 rem). Alle Seiten und Panels beziehen ihre
   Rahmen-, Karten- und Textklassen von hier; `PageShell` bündelt die
   Seitenhülle inklusive einheitlichem Kopf (Überzeile, Titel, Untertitel,
   Aktionen, Toolbar).
2. **Zwei zusätzliche Breakpoints** (`3xl` = 120 rem/1920 px, `4xl` =
   160 rem/2560 px) in `src/app/globals.css`. Statt fester Spaltenzahlen wachsen
   Statusleiste (bis 7 Spalten), Report-Kennzahlen (bis 6), Agentenkarten (bis
   4), Doku-Katalogkarten (bis 5) und das Guide (zweispaltig) mit dem Monitor —
   auf Mobile bleibt es bei einer bzw. zwei Spalten.
3. **Ein Tabellen-Baustein** (`DataTable`): echte `<table>`-Semantik,
   Spaltenköpfe als `scope="col"`, optional sticky mit `maxHeight`, Zahlen
   rechtsbündig. Der Scrollbereich ist per Tastatur fokussierbar und benannt
   (`role="region"`, `aria-label`, `tabIndex=0`, sichtbarer Fokusring) — dieselbe
   Mechanik wie im Doku-Viewer. Unterhalb `sm` stapelt `.fs-table-stack` jede
   Zeile zu einer **beschrifteten** Karte (`data-label` +
   `td::before { content: attr(data-label) }`), statt Spalten aus dem Viewport
   laufen zu lassen. Für Konfigurationsmatrizen mit Eingabefeldern bleibt mit
   `stack={false}` das horizontale Scrollen (Feld und Bedeutung bleiben
   zusammen). Die alten Einzel-Tabellen (`Table`, `Stat`, `KpiTile`, fünf rohe
   `<table>`-Blöcke) sind ersetzt.
4. **Eine Reiter-Navigation** (`TabBar`/`TabPanel`): `role="tablist"`,
   `aria-selected`, `aria-controls`, Roving Tabindex, Pfeiltasten/`Home`/`End`,
   Zähler-Badges (offene Positionen, Agenten, Audit-Einträge, Venues), auf
   Mobile horizontal scrollbar statt mehrzeilig, sticky unter dem Fensterrand.
   Der Doku-Viewer behält seine eigene Navigation, nutzt aber denselben
   Seitenrand.
5. **Kein Null-Blitz beim Start:** Statusleiste und aktiver Reiter existieren
   schon vor `GET /api/firm`. Statt irreführender Nullen („Paper-Equity 0 $“,
   „Drawdown 0 %“) zeigt `MetricTile` mit `loading` einen pulsierenden
   Platzhalter, während Label und InfoTip stehen bleiben; der aktive Bereich
   trägt ein Skelett im Raster der echten Panels (und `aria-controls` zeigt
   nicht mehr ins Leere).
6. **Konsolidierung der Flächen und Texte:** Der Kartenrahmen
   (`rounded-xl border border-slate-800 …`) stand 37-mal wörtlich in 20 Dateien,
   die Abschnittsfläche 7-mal in zwei Varianten. Beide liegen jetzt als
   `PANEL`/`PANEL_PADDED`/`PANEL_LARGE` in `layout.ts`; die Opazitäts- und
   Radius-Varianten (`/40`, `/60`, `/70`, `rounded-2xl`) sind darauf
   zusammengeführt. Ebenso wurde der Mikro-Text auf eine gemeinsame Skala
   gehoben (`text-[10px]` → `text-[11px]`, `text-[11px]`/`text-[11.5px]` → `text-xs`,
   246 Stellen in 33 Dateien) — kein Fließtext unter 11 px, Tabellenlabels und
   Badges 12 px. Lange Absätze laufen nicht mehr über die volle Ultrawide-Breite
   (`PROSE_MEASURE` = 90 ch je Textblock, Guide zweispaltig), Zahlen bleiben
   tabellarisch (`tabular-nums`).
7. **Doku-Viewer und Broker-Seite** teilen jetzt dieselben Rand-Konstanten wie
   das Dashboard; die Doku-Katalogkarten und die Sprungleiste nutzen
   `3xl`/`4xl` bzw. `PAGE_GUTTER_BLEED` statt eigener Zwischenwerte
   (`min-[1900px]`).

### Added — Layout-Vertrag als Test (2026-10-04)

`tests/ui/Layout.test.tsx` (17 Tests, `renderToStaticMarkup` — kein Browser,
kein Netz) sichert den Vertrag ab: volle Breite ohne `max-w-7xl`-Hülle (inkl.
Quelltext-Scan über `src/**`), Seitenkopf, Tabellen-Rollen/`data-label`/
Leerzustand, Reiter-ARIA-Muster und Roving Tabindex, Kennzahl-/Chip-/Button-
Zustände, der Ladezustand ohne Falschwerte samt verknüpftem aktivem Reiter, die
`3xl`/`4xl`-Rasterstufen der Seiten sowie die `globals.css`-Regeln für
Breakpoints, Stapelung und Druck.
Für den Umbau verifiziert: `npx next build` erzeugt die Raster-, Spalten- und
Tabellen-Klassen (CSS-Audit der Build-Chunks), `npm test` und
`npm run docs:validate` sind grün.

### Fixed — beim Umbau gefundene Fehler (2026-10-04)

- **Tailwind v4 erzeugte kein CSS für `autoFit("22rem")`:** Die Rasterklasse
  wurde zur Laufzeit zusammengesetzt; da Tailwind Kandidaten **statisch** aus
  dem Quelltext liest, enthielten die Build-Chunks **null** `repeat(auto-fit…)`
  — die Kacheln blieben einspaltig. Jetzt stehen die vollständigen Klassennamen
  als `AUTO_FIT_*`-Literale in `layout.ts`; ein Test verbietet Rückfälle.
- **Doppelte Komponente:** `src/components/workshop/InfoTip.tsx` war eine
  Zweitimplementierung von `src/components/ui/InfoTip.tsx` (unterschiedliche
  Props, driftende Darstellung) — gelöscht, alle Aufrufer nutzen die Kit-Version.
- **Doppelte/verwaiste JSDoc-Blöcke:** `ThemeSwitcher.tsx` trug seinen
  Modulkommentar vierfach, `FirmDashboard.tsx` mehrfach, elf Panels je einen
  leeren Doppelblock nach `"use client";` — zusammengeführt.
- **Doppelter Import:** `OperationsCenterPanel.tsx` importierte
  `AUTO_FIT_PANELS` zweimal.
- **Toter Code:** Die Duplikate `Stat`, `Table` und `KpiTile` in
  `FirmDashboard.tsx` sowie ein ungenutztes `badAgents` sind entfernt; die
  Aufgaben liegen bei `MetricTile`/`DataTable`.
- **Reiter-Vertrag:** Die Workshop-Schritte deklarierten `hint:`, das
  `TabDef`-Type kannte nur `title:` (Typfehler bzw. unsichtbare Beschreibung) —
  vereinheitlicht auf `title` mit sichtbarer Hinweiszeile.
- **Verschwundener Hinweis im Risiko-Tab:** Der Statusblock
  (`msg && …`, Rückmeldung nach dem Speichern eines Limits) fehlte im Markup —
  wiederhergestellt.
- **Monatsrenditen-Heatmap:** Der Scrollbereich der 14-spaltigen Matrix hatte
  weder Namen noch Tastaturzugang → `role="region"` + `aria-label` +
  `tabIndex=0` wie bei allen Tabellen.

## [0.14.0] — Doku-Viewer: volle Breite, themensortierte Navigation, scrollbare Tabellen & Indikatoren-Katalog (2026-10-04)

### Changed — Doku-Viewer: volle Breite, themensortierte Navigation, Tabellen scrollen (2026-10-04)

Die Doku-Ansicht (`/docs`) war eine flache Liste von ~80 Einträgen in einer
schmalen Spalte (`max-w-7xl`), jede Dokuseite auf `max-w-4xl` begrenzt. Breite
Tabellen (bis 11 Spalten, z. B. `DAILY_WEEKLY_RESEARCH.md`) liefen aus dem
Artikel heraus bis unter das Inhaltsverzeichnis bzw. hinter den Viewport-Rand.
Das ist behoben — und die Navigation ist jetzt thematisch sortiert.

1. **Volle Bildschirmbreite.** Beide Doku-Seiten nutzen die gesamte Breite
   (nur responsives Rand-Padding); das Inhaltsverzeichnis bleibt rechts, die
   Artikelspalte ist `minmax(0,1fr)` und kann nicht mehr überlaufen.
2. **Themensortierte Navigation** (`src/lib/docsNav.ts`): 82 Katalogeinträge in
   **9 Abschnitten** (Einstieg, Architektur & Datenfundament, Indikatoren &
   Signale, Strategie/Backtest/Research, Risiko & Ausführung, Broker/Venues,
   Missionen & Betrieb, Audits & Security, Archiv). Gruppe des offenen
   Dokuments ist automatisch offen; ein Test erzwingt, dass **jeder** Slug
   genau einen Abschnitt hat.
3. **Übersicht als Katalog-Hub.** Suche (Titel, Untertitel, Pfad, Abschnitt),
   Schnellzugriff-Chips, sticky Sprungleiste, Abschnitts-Raster
   (1 → 2 → 3 → 4 Spalten je Breakpoint) und ein **aufklappbarer Dateibaum**
   über alle 342 Markdown-Dateien — inklusive der 260 Dateien, die nicht im
   Katalog stehen und vorher über den Viewer gar nicht erreichbar waren
   (`GET /api/docs?tree=1`, `src/lib/docsTree.ts`).
4. **Dokuseite.** Sticky-Kopf mit Breadcrumb (Thema › Dokument), Sidebar mit
   derselben Navigation (sticky, ab `lg`; darunter als Drawer mit Esc/Overlay),
   mobil aufklappbares Inhaltsverzeichnis, „Vorher/Weiter“ im Katalog,
   `generateMetadata` je Dokument (Titel/Beschreibung im Tab).
5. **Inhalt serverseitig gerendert.** Katalog **und** Markdown kommen jetzt mit
   dem Server-HTML (`src/lib/docsRenderServer.ts`, `/api/docs` und Seite teilen
   sich dieselbe Implementierung). Kein „Lade Dokument…“-Flackern mehr,
   Anker-Deeplinks funktionieren nach der Hydration wie vorher, und die Seite
   ist ohne JavaScript lesbar/druckbar.
6. **Tabellen scrollen statt überzuragen.** Jede Tabelle sitzt im
   Scroll-Container `.docs-table-scroll` (`overflow-x:auto`, per Tastatur
   scrollbar, `role="region"`): volle Breite, wenn sie passt — sonst
   horizontal scrollbar, nie über die Nachbarspalte hinaus. Zebra-Streifen,
   Hover, umbruchfähiger Code in Zellen und eine Druckregel (Papier kennt kein
   horizontales Scrollen) inklusive.
7. **Barrierefreiheit & Icons.** Inline-SVG-Icons statt Unicode-Glyphen,
   `aria-expanded`/`aria-controls`/`aria-current`, Fokusringe, `print:hidden`
   für alle Bedienelemente.

### Added — Indikatoren-Dokumentation (Engine, CTI, Scanner) (2026-10-04)

- **Neu: [`docs/DOCS_VIEWER.md`](docs/DOCS_VIEWER.md)** — Aufbau und
  Pflegeanleitung des Viewers: Katalog vs. Dateibaum, Komponenten-Tabelle,
  Überlauf-Regeln für Tabellen, „neues Dokument in drei Schritten“ (Datei,
  Katalog, Abschnitt), Whitelist/Traversal-Schranke und die bewussten Grenzen.
- **Neu: [`docs/INDICATORS.md`](docs/INDICATORS.md)** — der zentrale
  Indikatoren-Katalog: Landkarte aller Rechenkerne, alle 16 Funktionen aus
  `src/lib/indicators.ts` mit Formel, Default, Rückgabe bei zu wenig Daten und
  kanonischen Fenstern (`BOLLINGER_PERIOD`/`DONCHIAN_*`), die 25 Regelfelder
  nach Gruppen, das **CTI-Kompendium** (8 Komponenten → 4 Dimensionen, alle
  Parameter und Grenzen, Stops, Parität Backtest ↔ Live, CLI, Tests), die 15
  Scanner-Faktoren mit Gewichten, das adaptive Risiko, die Trusted Indicators,
  Konventionen (Prozent vs. Bruch, Aufwärmbedarf, `null` statt 0,
  `changePct24h` ist nicht 24 h) und ein Prüfpfad.
- **„Claude Indicator“ im Research-Ranking ergänzt:**
  [`docs/research/INDICATOR_RANKING_CRYPTO_DAYTRADING.md`](docs/research/INDICATOR_RANKING_CRYPTO_DAYTRADING.md)
  ordnet den auf Rang 3 der Fremd-Auswertung stehenden „Claude Indicator“ jetzt
  konkret dem portierten **CTI** zu (Mechanik übernommen, Renditebehauptung
  ausdrücklich nicht) und verlinkt Katalog, Fachdokument und Kostenvorbehalt.
- **Katalognachtrag:** [`docs/EQUITY_CURVE.md`](docs/EQUITY_CURVE.md) stand in
  `docs/README.md` und `CHANGELOG.md`, fehlte aber im Doku-Katalog — jetzt
  samt Abschnitt registriert. `GET /api/docs` liefert zusätzlich `sections` und
  `quickAccess` (keine zweite Wahrheit über die Reihenfolge im Client).

### Fixed — Aktualität der Dokumentation (2026-10-04)

- **`node="[object Object]"` aus dem Doku-Renderer entfernt:** react-markdown
  reichte den mdast-Knoten als DOM-Prop durch — Links und Tabellen trugen ein
  ungültiges Attribut (React-Warnung, verworfen). Regressionstest ergänzt.
- **Next.js-Stand:** Die Doku nannte „16.3.4“ als gepinnten Stand, das Lockfile
  führt `16.3.8` (SEC-03-Mindeststand bleibt 16.3.3) — `README.md`,
  `INSTALL.md`, `docs/INSTALL.md`, `docs/INSTALL-WINDOWS.md`,
  `docs/security/README.md` und `docs/README.md` nachgezogen.
- **Scanner-Konfigurationsversion:** `DAILY_WEEKLY_RESEARCH.md` nannte
  `version: 1`, `src/scanner/scanner.config.json` steht auf `version: 2`.
- **`docs/README.md`:** veraltete `VERSION.md`-Zeile (v0.8.0) korrigiert,
  Indikatoren-Absatz auf den neuen Katalog umgestellt, `research/` in die
  Verzeichnisübersicht aufgenommen.
- **Regressionstests:** `tests/docsNav.test.ts` (Abschnitte vollständig/
  eindeutig, Schnellzugriff, Gruppen der Indikator-Dokumente, Suchfilter),
  `tests/ui/DocsMarkdown.test.tsx` (Scroll-Container, kein `node`-Attribut).

## [0.13.0] — Reports-Tab: Benchmark, TWR, Drawdown-Episoden, Heatmap, Druck, Alarme, Log-Achse & Zeitraumvergleich (2026-10-04)

### Added — Equity-Analytik: Benchmark, TWR, Episoden, Heatmap, Log-Achse, Zeitraumvergleich, Druck & Alarme (2026-10-04)

Die acht Ausbaupunkte aus der Review des Reports-Tabs. Alle Kennzahlen liegen in
reinen Funktionen (`src/lib/equityAnalytics.ts`, `src/lib/equityBenchmark.ts`)
und sind in `tests/equityAnalytics.test.ts`, `tests/equityAlerts.test.ts` und
`tests/ui/EquityCurveChart.test.tsx` festgehalten; Definitionen, Formeln und
Grenzen stehen in [`docs/EQUITY_CURVE.md`](docs/EQUITY_CURVE.md) §5–§7.

1. **Referenz-Vergleichslinie (Benchmark).** `GET /api/firm/equity?compare=BTC|ETH|SPY|QQQ`
   liefert eine Buy-and-Hold-Linie **aus dem `HistoricalStore`**
   (`src/lib/equityBenchmark.ts`: Registry mit Instrument-Kandidaten und
   Timeframes 1 d → 4 h → 1 h, Skalierung auf den Kontostand am Fensterstart).
   Es werden **keine** Kurse aus dem Netz geholt oder erfunden: ohne Historie
   (`npm run market:sync`) ist `benchmark` `null` und die UI sagt „keine Daten“.
2. **Zeitgewichtete Rendite (TWR).** `timeWeightedReturn()` verkettet
   Tagesrenditen und bereinigt Kapitalzu-/abflüsse (`basis = Vortagesschluss +
   Zufluss`). Die Antwort enthält `twr` mit `twrPct`, `simplePct`, `days`,
   `flows {count,total,applied}`, `bestDayPct`, `worstDayPct`; der Report liefert
   `kpis.twrPct`/`twrSimplePct`/`twrDays`/`twrCashflowApplied`. **Ehrlich
   gekennzeichnet:** Das Paper-Konto führt keine persistierte Cashflow-Spur,
   `flows.applied` bleibt daher `false` und die UI weist die Kennzahl als „ohne
   Cashflow-Spur“ aus, statt eine Bereinigung zu behaupten.
3. **Drawdown-Episoden mit Erholungszeiten.** `drawdownEpisodes(points, {topN, minPct})`
   liefert Peak, Tief, Tiefe, `recoveredAt`, Abstiegs-, Erholungs- und
   Gesamtdauer sowie `open`. Die API liefert die Top 5 (ab 0,1 %), der Report
   zusätzlich `drawdownEpisodes` als Anzahl; das Panel zeigt eine Tabelle mit
   deutschen Dauerangaben („5 h 20 min“, „3 T 4 h“), offene Episoden als
   „noch offen“. Liegt der Peak **vor** dem Fenster, ist `peakTs` `null` —
   kein erfundenes Datum.
4. **Monatsrendite-Heatmap.** `readMonthlyEquity()` aggregiert in SQL über die
   **gesamte** Aufbewahrung (erster/letzter Stand je Berliner Monat,
   `max(equity)` als Referenz), `finalizeMonthlyReturns()` macht daraus
   Rendite + Anschnitt-Flag (`partial`, 24-h-Toleranz an den Rändern) und
   `monthlySummary()` die Fußnote (x positiv / y negativ, bester/schlechtester
   Monat). Das Panel zeigt Monate als Zellen mit Intensität, Jahre als Zeilen,
   dazu die verkettete Jahresrendite.
5. **Druck-/PDF-Report.** Button „Druck / PDF“ (`window.print()`), Report-Kopf
   `hidden print:block`, Bedienelemente `print:hidden`. `globals.css` erzwingt
   unter `@media print` die **Light-Palette** (unabhängig vom gewählten Theme —
   ein Midnight-Theme druckte sonst schwarze Seiten), entfernt Schatten, hält
   Tabellen/SVG/`.print-break-avoid`-Blöcke zusammen und setzt
   `@page { margin: 12mm }`.
6. **Equity-Alarme im Monitor.** Der 60-s-Tick prüft zusätzlich neue Höchststände
   (`equity:new-high`, Default ab +0,5 %) und Drawdown-Schwellen
   (`equity:drawdown-5`/`-10`/`-20` als `info`/`warning`/`critical`) über die
   bestehenden Alert-Senken. Schwellen ratschen (Reset bei Erholung/neuem Hoch)
   und kleine Anstiege heben den Peak still nach, damit kein Alarm-Flood
   entsteht; Fehler der Senke landen fail-soft in der Fehlerliste des Ticks.
   Neue Flags: `EQUITY_ALERTS_ENABLED`, `EQUITY_ALERT_DRAWDOWN_PCT`,
   `EQUITY_ALERT_PEAK_MIN_PCT` ([`CONFIGURATION.md`](CONFIGURATION.md)).
7. **Logarithmische y-Achse.** Schalter „linear/log“: Skalierung linear in
   `log₁₀(equity)` mit 1/2/5-Ticks je Zehnerpotenz (`niceLogTicks`), nur bei
   strikt positiven Werten (sonst linear statt unbrauchbarer Achse). Der Rand
   ist multiplikativ, das Label „· log“ erscheint erst ab einer vollen
   Zehnerpotenz Spanne — darunter sind log und linear deckungsgleich.
8. **Zwei Zeiträume vergleichen.** „Vorperiode“ und „Ø der letzten 3“ laden das
   vorgehende Fenster über die neuen Parameter `?from`/`?until` (ISO; ersetzt
   `range`, damit der Server kein zweites Zeitraum-Vokabular braucht) und
   zeichnen die Reihen indexiert auf 100 auf der Zeitachse der aktuellen Kurve
   (fehlende Stützstellen linear interpoliert, nicht fortgeschrieben).

**Außerdem:** Die API liefert `calendarSince` (Anfang des Kalenderfensters aus
`range` — bei `?from`/`?until` unabhängig vom effektiven `since`, das Panel nutzt
es für die Fußnote) und
`?compare=off|none|keine` schaltet den Benchmark explizit ab; der CSV-Export
enthält bei aktivem Vergleich eine Referenzspalte.

### Added — Equity-Kurve: Zeiträume, Drawdown, Achsen & Tooltips (2026-10-03)

Der Reports-Tab zeigte eine nackte SVG-Linie ohne Achsenbeschriftung, mit
„Heute / Woche / Monat“ als einzigem Zoom, ohne Drawdown und ohne Export. Der
Report-KPI „Max Drawdown“ stand praktisch immer auf **0 %** — er wurde aus der
Summe der realisierten P&L gerechnet (Reihe beginnt bei 0, `if (peak > 0)`
greift nie) statt aus dem Kontostand. Beides ist behoben, die Definitionen
stehen in [`docs/EQUITY_CURVE.md`](docs/EQUITY_CURVE.md).

* **Drawdown wird berechnet — Peak-to-Trough.** `GET /api/firm/report` liest
  jetzt dieselbe Equity-Kurve wie das Chart und liefert `maxDrawdownPct`,
  `maxDrawdownAbs`, `currentDrawdownPct`, `maxDrawdownFrom`, `maxDrawdownTo`
  und `recoveredAt`. Der Höchststand aus der Zeit **vor** dem Zeitraum zählt
  mit (Referenz-Peak), sonst begänne ein Fenster im Drawdown bei 0 %.
* **Neue Kennzahlen im Report:** Bruttogewinn/-verlust, Ø Gewinn, Ø Verlust,
  Erwartungswert je Trade, Gewinn/Verlust-Verhältnis, längste Gewinn-/
  Verlustserie und durchschnittliche Haltedauer. Report-Zeiträume um Quartal,
  Halbjahr und Jahr erweitert (Berliner Kalendergrenzen).
* **Mehr Zeiträume im Chart:** 1 T · 1 W · 1 M · 3 M · 6 M · 1 J · Max
  (`/api/firm/equity?range=…`, Aliase wie `1d/7d/3m/1y/max`). Die API liefert
  Auflösung, effektive Bucket-Breite, Aufbewahrungsgrenze und eine ehrliche
  Kennzeichnung, wenn der Zeitraum über die Historie hinausreicht.
* **Lange Historien ohne Datenmüll:** Die Retention löscht ältere Rohdaten
  nicht mehr, sondern verdichtet sie in SQL auf zwei Punkte je Berliner
  Kalendertag (Tiefstand + Tagesschluss) — Drawdown-Extrema bleiben erhalten.
  Neue Flags `EQUITY_RAW_RETENTION_DAYS` (Default 90) und
  `EQUITY_RETENTION_DAYS` (Default 730). Die Kurve liest in SQL-Buckets mit
  Extremwert-Erhalt statt „jeder n-te Punkt“.
* **Achsen & Beschriftung:** y-Achse mit „schönen“ 1/2/5-Ticks in Kontowährung
  (umschaltbar auf Index „Start = 100“), x-Achse auf **echter Zeitachse** mit
  Berliner Labels (Uhrzeit → Datum → Monat/Jahr), Basislinie auf dem
  Zeitraumstart, Achsentitel „Equity (USD)“ und „Zeit (Europe/Berlin)“.
* **Hover & Tastatur:** Tooltip je Punkt (Zeit, Equity, Abstand zum
  Zeitraumstart, Drawdown in Prozent und absolut, Höchststand,
  Snapshot-Auslöser), Unterwasser-Kurve für den Drawdown-Verlauf,
  Max-Drawdown-Band (Peak → Tief), Trade-Marker (▲ Einstieg, ● Ausstieg mit
  P&L), CSV-Export. Bedienbar per Maus/Touch, `←`/`→` (mit `Shift` in
  10er-Schritten), `Pos1`/`Ende`, `Esc`; `aria-live`-Text und `aria-label`
  für Screenreader.
* **Beschreibungen statt nackter Zahlen:** Jede Kennzahl im Reports-Tab (und
  die Statusleiste im Overview) trägt eine Kurzdefinition als InfoTip —
  insbesondere die Unterscheidung „Drawdown gegenüber Startkapital“ (Risiko-
  Limit) vs. „Drawdown vom Höchststand“ (Kurve).
* **Sicherheit:** `GET /api/firm/equity` verlangt jetzt `firm.read` vor dem
  ersten DB-Zugriff und antwortet `Cache-Control: private, no-store`
  (SEC-02-Klasse: Portfolio- und P&L-Daten). Der SEC-02-Test deckt die Route ab.
* **Beim Verifizieren gegen echte Daten gefunden und behoben** (die
  Unit-Tests sahen die gemappten Felder nicht):
  - Die Bucket-Abfrage lieferte `ts_first`/`eq_min` in snake_case, die
    JS-Seite las `tsFirst`/`eqMin` → `undefined` in `new Date(...)`
    (`RangeError: Invalid time value`). Die Zeilen werden jetzt explizit
    gemappt, Zeitstempel als Epoch-Millisekunden aus SQL.
  - Der Filter in `bucketsToPoints` ließ nur aufsteigende Zeitstempel in
    Einfüge-Reihenfolge durch. Da das Bucket-Maximum erst nach dem Tief
    eingefügt wird, verschwand es — der Hochpunkt fehlte in der Kurve und der
    Drawdown fiel zu groß aus. Jetzt: erst sortieren, dann exakte Duplikate
    verwerfen (Regressionstest in `tests/equityAnalytics.test.ts`).
  - Fehlender `maxPoints`-Parameter wurde als `0` gelesen und auf 20 geklemmt
    — die Kurve war ohne Angabe unnötig grob.
  - Die Drawdown-Achse beschriftete 0,43 %/0,86 % als „0 %“/„1 %“; kleine
    Prozentwerte bekommen jetzt Nachkommastellen (`formatPercentTick`).

* **Refactor:** `readStartingEquity()` liegt einmal in `src/lib/startingEquity.ts`
  (vorher dreimal kopiert); Perioden-/Zeitachsen-Helfer und die reine
  Kurvenmathematik (`src/lib/equityAnalytics.ts`, `src/lib/equityRange.ts`)
  sind ohne DB, Uhr und Zufall und durch `tests/equityAnalytics.test.ts`,
  `tests/equityRange.test.ts`, `tests/time.test.ts` sowie
  `tests/ui/EquityCurveChart.test.tsx` abgedeckt.

### Fixed — Doku-Rendering & Docs-Links (2026-10-03)

Der Doku-Viewer (`/docs/…`) hat relative Links nur über den **Dateinamen**
aufgelöst und Überschriften ohne `id` gerendert. Gemessener Ausgangsbefund:
99 Überschriften ohne `id`, 1447 relative `.md`-Links, davon 878 in der App
tot und 101 auf dem falschen Dokument (Kollisionen wie `README.md`, das es 31×
im Baum gibt).

* **Kapitel-Sprünge funktionieren wieder.** `rehype-slug` vergibt
  GitHub-kompatible Anker-IDs (Umlaute bleiben erhalten), `DocsView` holt den
  Sprung nach, nachdem der per `fetch` geladene Inhalt im DOM steht. Zusätzlich
  zeigt ein Inhaltsverzeichnis mit Scroll-Spy das aktive Kapitel.
* **Die kanonische URL trägt jetzt den Pfad** innerhalb von `docs/`
  (`/docs/audits/2026-09-18-feature-gap/README.md`) statt nur den Dateinamen.
  Markdown direkt im Repo-Root liegt unter `/docs/root/` (`/docs/root/CHANGELOG.md`),
  weil sonst Root- und `docs/`-Dateien gleichen Namens kollidieren.
  Route ist `src/app/docs/[...path]` statt `src/app/docs/[name]`.
* **Namenskollisionen aufgelöst.** `audits/README.md` liefert nicht mehr
  lautlos `docs/README.md`. Eine Anfrage mit Verzeichnisanteil, die nicht
  auflöst, wird abgewiesen statt geraten.
* **Link-Auflösung doc-bewusst.** Relative Ziele werden gegenüber dem
  Verzeichnis der Quelldatei gelöst — wie auf GitHub. Verzeichnis-Links gehen
  auf ihr `README.md`.
* **Ziele außerhalb der Doku** (`../src/db/schema.ts`, `../drizzle/*.sql`,
  `*.pdf`, `*.csv`, `*.json`) werden als nicht klickbarer Code-Text gerendert
  statt als toter Link. Der Viewer bleibt damit kein Repo-File-Reader:
  ausgeliefert wird ausschließlich Markdown unter `docs/` bzw. im Root.
* **Katalog vervollständigt:** 25 `docs/*.md` standen in keiner Navigation und
  waren nur über einen Fallback erreichbar (u. a. `CROSS_SECTIONAL_RANKING`,
  `MONTE_CARLO`, `SENTIMENT`, `TWAP_EXECUTION`).
* **`npm run docs:validate` verschärft:** neuer Check `App-Link-Check`
  simuliert die Auflösung des Viewers und vergleicht sie mit der GitHub-Sicht
  — genau die Prüfung, die den Ausgangsbefund gefunden hätte. Der Anker-Check
  benutzt jetzt `github-slugger` statt eines Nachbaus (der entfernte Umlaute),
  prüft auch In-Page-Anker und zusätzlich die Markdown-Dateien im Repo-Root
  (`CHANGELOG.md`, `CONFIGURATION.md`, …).
* Drei veraltete In-Page-Anker und ein toter Link in `CONFIGURATION.md`
  korrigiert (waren vorher unsichtbar, weil der Check den falschen
  Slug-Algorithmus benutzte).

## [0.12.0] — Claude Trading Indicator (CTI) + Signalstrategien im Backtest (2026-10-03)

> **Status: Beta.** Minor-Release. Neues Modul `src/signals/`: die
> 1:1-Portierung des Pine-Script-v6-Indikators „Claude Trading Indicator"
> (shorttitle `CTI`) samt Anbindung an die Multi-Asset-Backtest-Engine und
> eine IO-freie Trading-Engine. Dabei wurde ein Vorzeichenfehler in der
> Kassenführung von Leerverkäufen im Backtest-Portfolio behoben.

### Added

* **Pine-Primitiven** [`src/signals/pine.ts`](src/signals/pine.ts): `ta.sma`,
  `ta.ema`, `ta.rma`, `ta.stdev`, `ta.highest`/`ta.lowest`, `ta.change`,
  `ta.tr`, `ta.atr`, `ta.rsi`, `ta.macd`, `ta.stoch`, `ta.obv`,
  `ta.supertrend`, `ta.dmi` und Bollinger-Bänder als **Streaming-Akkumulatoren**
  mit Pine-treuer `na`-Semantik (`null` ist nie eine stille 0). Keine neue
  Laufzeit-Abhängigkeit — keine TA-Bibliothek.
* **CTI-Rechenkern** [`src/signals/cti/runtime.ts`](src/signals/cti/runtime.ts):
  inkrementeller Zustandsautomat (`CtiRuntime.push(candle) → CtiBar`) mit
  Zwei-Stufen-Konsens über Trend / Momentum / Volatilität / Volumen,
  Persistenzfilter (`persistBars`, Gleichheitsprüfung wie in Pine),
  Sperrfrist (`minBarsBetween`, ohne Nachholen) und eingefrorenen ATR-Stops.
  `computeCtiSeries()` ist eine reine Faltung über denselben Automaten —
  **eine** Implementierung für Backtest, Live und CLI.
* **Parameter & Aufwärmbedarf** [`src/signals/cti/params.ts`](src/signals/cti/params.ts):
  nur die im Skript einstellbaren Inputs, alle Komponenten-Perioden als
  interne Konstanten; `resolveCtiParams()` klemmt sichtbar (`clamped[]`),
  `ctiWarmupBars()` liefert den Bedarf (Default **201** Kerzen, EMA 200).
* **Dashboard/Alerts** [`src/signals/cti/dashboard.ts`](src/signals/cti/dashboard.ts):
  Tabellenzeilen und Alert-Wortlaute wortgleich zum Skript.
* **Signalstrategien in der Backtest-Engine**
  ([`src/backtest/types.ts`](src/backtest/types.ts),
  [`src/backtest/engine.ts`](src/backtest/engine.ts)): dritter Strategietyp
  `{ type: "signal" }` mit `BacktestSignalBar` (genau **eine** geschlossene
  Kerze, keine Reihe) und `BacktestSignalDecision`
  (`LONG`/`SHORT`/`FLAT`, Stop, Ziel, Risikobudget, `closeOpposite`).
  `event_replay` lehnt Signalstrategien fail-closed ab.
* **CTI-Backtest-Adapter** [`src/signals/cti/backtest.ts`](src/signals/cti/backtest.ts):
  `createCtiSignalStrategy()`, `ctiStrategyItem()`, `runCtiBacktest()`
  (Default: Paper-Ausführung, `warmupBars ≥ ctiWarmupBars()`, Shorts gemäß
  `tradeShorts`) inklusive getrennter Signal-Statistik je Symbol.
* **CTI-Trading-Engine** [`src/signals/cti/engine.ts`](src/signals/cti/engine.ts):
  `CtiTradingEngine` erzeugt Absichten (`ENTER` / `EXIT` / `ADJUST_STOP`) mit
  Gründen `SIGNAL`, `OPPOSITE_SIGNAL`, `STOP_LOSS`, `REARM_STOP`; Schutz vor
  Signal, Stop erst ab der Folgekerze, Zustandswechsel **nur** nach Freigabe
  durch den injizierten `CtiExecutionPort` (werfender Port = Ablehnung).
  IO-frei: kein DB-, Broker- oder LLM-Import.
* **CLI** `npm run cti` ([`scripts/run-cti.ts`](scripts/run-cti.ts)):
  Dashboard + Signalliste aus dem HistoricalStore, optional Backtest
  (`--mode=backtest`) und JSON-Report (`--out=`). Schreibt nicht in die
  Datenbank und löst keine Order aus.
* **Doku** [`docs/CLAUDE_TRADING_INDICATOR.md`](docs/CLAUDE_TRADING_INDICATOR.md)
  (Konsensmodell, Parameter, Stops, Aufwärmphase, Backtest-Vertrag,
  Trading-Engine, CLI, bewusste Abweichungen vom Original).

### Fixed

* **Leerverkäufe im Backtest-Portfolio vorzeichenrichtig verbucht**
  ([`src/backtest/portfolio.ts`](src/backtest/portfolio.ts)): Bisher wurde
  **jede** Position wie ein Kauf gebucht (Cash − Notional beim Öffnen,
  + Notional beim Schließen). Für Shorts lief die Equity-Kurve damit
  gegenläufig zum geloggten Trade-PnL — ein gewinnender Short senkte das
  Eigenkapital. Jetzt bucht ein Short beim Öffnen nur Gebühren (die
  Sicherheit bleibt im Cash), wird über `unrealizedPnl` bewertet und beim
  Schließen mit dem realisierten Ergebnis verrechnet. Es gilt wieder
  `endingEquity − startingEquity = Σ trades.pnl`. Long-Läufe sind
  arithmetisch unverändert. Betroffen war u. a. die Zyklus-Verifikation
  (`src/cycle/steps/backtestStep.ts`, `enableShorts: true`).

### Tests

* `tests/signals.pine.test.ts` (21): Primitiven gegen unabhängige
  Referenzformeln, `na`-Verhalten, Supertrend-Aufwärmspur, fail-closed
  Perioden.
* `tests/cti.indicator.test.ts` (35): Konsens-Invarianten über die gesamte
  Reihe, Persistenz/Sperrfrist, Präfix-Gleichheit (kein Look-ahead),
  Streaming == Batch, Stops, Eingabeprüfung, Parameter-Klemmung,
  Dashboard/Alerts.
* `tests/cti.backtest.test.ts` (19): Vertrag `BacktestSignalBar`, kein
  Look-ahead, Determinismus (auch Paper-Pfad), Signal ⇒ Trade, Stop- und
  Umkehr-Ausstiege, Guardrails (`enableShorts`, `maxOpenPositions`,
  `closeOpposite`), Kostenwirkung, `Equity-Delta == Σ Trade-PnL`.
* `tests/cti.engine.test.ts` (17): Absichten und ihre Reihenfolge,
  Port-Ablehnung/-Fehler, Reconciliation, Parität Live ↔ Backtest,
  IO-Freiheit des Moduls.
* `tests/backtest.unit.test.ts`: Regression „bucht Leerverkäufe
  vorzeichenrichtig (Cash-Bewegung == Trade-PnL)".

### Notes

* **Bewusst nicht portiert:** Intrabar-Repainting (der Port arbeitet
  ausschließlich auf Bar-Schluss) und die reinen Visuals des Skripts.
  Dashboard-Texte und Alert-Wortlaute sind wortgleich übernommen.
* **Kein Kursziel:** Das Skript definiert keines; `takeProfit` bleibt `null`,
  sofern der Aufrufer nicht ausdrücklich `takeProfitRR` setzt.

## [0.11.1] — `LOCAL_FREE`-Endpunkt durchgesetzt (STX-08-05 / STX-21) (2026-10-03)

> **Status: Beta.** Patch-Release. `LOCAL_FREE` sendet den Validator-Report nur
> noch an Endpunkte, die literal als lokal klassifiziert sind. Das
> Default-Verhalten bleibt unverändert — die Defaults
> `http://127.0.0.1:11434` (`ollama`) und `http://127.0.0.1:8080/v1` (`openai`)
> sind lokal; erst ein Cloud-Override über `LLM_BASE_URL`/`OLLAMA_BASE_URL`
> fällt sichtbar aus der Kandidatenliste.

### Added

* **Lokalitäts-Klassifikation** [`src/routing/localEndpoint.ts`](src/routing/localEndpoint.ts)
  (STX-21): reine, deterministische Prüfung eines Basis-URLs **ohne DNS-Lookup**
  — lokal sind Loopback `127.0.0.0/8`, IPv6 `::1` (auch ausgeschrieben und
  IPv4-gemappt), `localhost`/`*.localhost` sowie die öffentlich nicht
  auflösbaren RFC-6761-Namensräume `.test`/`.invalid`; alles andere (öffentliche
  Domains, private Netze, Container-Kurznamen, Credentials in der URL,
  Fremdschemata, Unparsebares) ist fail-closed **nicht** lokal.
* **Zähler** `validator_agent_provider_excluded_total{policy,provider}`
  (Labels geschlossen: `LOCAL_FREE`/`OPENCODE_FREE` und `LlmProviderName` — nie
  eine Basis-URL, ein Hostname oder ein Modellname), exponiert über
  `prometheusMetrics()`.

### Changed

* **`allowedProviderOrder()`** ([`src/strategies/validator/agent.ts`](src/strategies/validator/agent.ts))
  prüft jeden lokalen Kandidaten (`ollama`, `openai`) gegen seinen
  **effektiven** Basis-URL (`providerConfigFromEnv()`: Env-Override oder Default)
  und entfernt nicht-lokale Einträge sichtbar statt still. `opencode` bleibt als
  ausdrücklicher Cloud-Opt-in von `OPENCODE_FREE` ungeprüft; die lokalen
  Fallbacks dieser Policy unterliegen derselben Prüfung.
* **Modulkopf + [`docs/STRATEGY_VALIDATION.md`](docs/STRATEGY_VALIDATION.md) §31**
  benennen die Garantie ausdrücklich: `LOCAL_FREE` ist keine
  Namenskonvention mehr, sondern eine durchgesetzte Eigenschaft des
  konfigurierten Endpunkts.
* Unverändert: `result`, `gates[]`, `assumptions` und der deterministische
  Report; eine leere Kandidatenliste beantwortet der Agent weiterhin mit
  `{ unavailable: true }`. Kein Ausweichen auf einen Cloud-Provider. Ebenfalls
  unverändert: `DEFAULT_BASE_URLS`, `API_KEY_ENV`, die Provider-Liste in
  `src/lib/llmProvider.ts` und `src/routing/policy.ts`.

### Tests

* `tests/routing.localEndpoint.test.ts` (6 Tests): Loopback-IPv4/-IPv6
  (inkl. `127.0.0.2`, `[::1]`, gemappter Form), `localhost`/`*.localhost`,
  `.test`/`.invalid`, öffentliche Domains, private Netze, Kurznamen,
  Credentials, Fremdschemata und Unparsebares.
* `tests/strategyValidation.agent.test.ts` (13 Tests, 5 neu): Cloud-`LLM_BASE_URL`
  ⇒ `openai` fällt aus, Zähler `excluded{policy="LOCAL_FREE",provider="openai"} 1`,
  und ein Fetch-Spy weist jeden nicht-lokalen Host zurück (es wird nur
  `127.0.0.1:11434` angefragt); Loopback-Override ⇒ `openai` bleibt nutzbar;
  beide Endpunkte cloud ⇒ `{ unavailable: true }` ohne Modellaufruf und mit
  byte-identischem Report; eine Toggle-Sperre zählt **nicht** als
  Endpunkt-Ausschluss.
* Die Bestandstests `LOCAL_FREE läuft ohne Cloud-Credentials …` (`:143`) und
  `LOCAL_FREE durchläuft den echten Ollama-Client ohne Cloud-Schlüssel` (`:186`)
  bleiben unverändert und grün.

### Notes

* **Vorbestehender Flake behoben (gefunden im geforderten vollen `npm test`):**
  `tests/benchBacktest.test.ts` erwartete in der Matrix-Kostenprüfung die
  Reihenfolge `rule > multiAsset`. Diese Aussage stammt aus der Baseline vor
  STX-12 und ist seit 08-04 (`v0.11.0`) überholt — `backtestRule()` nutzt
  denselben Indicator-Cache wie der Engine-Pfad. Bei den Spielzeuggrößen der
  Suite (200/400 Bars, zwei Wiederholungen) dominieren JIT-/Startkosten, die
  Reihenfolge kippte in 4 von 5 lokalen Läufen. Der Test prüft jetzt den
  Protokoll-Vertrag (jeder Pfad liefert positive Zell-/Kernstunden-Kosten) und
  überlässt die vergleichende Aussage der Baseline
  [`BENCH-BASELINE.md`](docs/audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md).
  Der PR #221 hatte die volle Suite ausdrücklich übersprungen; hier wurde sie
  ausgeführt und der rote Bestandstest sichtbar gemacht.
* **Gewählter Weg:** durchsetzen statt umbenennen (Weg 1 der Prompt-Vorlage) —
  `OPENCODE_FREE` bleibt der einzige Cloud-Pfad, `LOCAL_FREE` bleibt eine
  Zusage. Abweichung zur Prompt-Skizze: `.test`/`.invalid` gelten als lokal
  („nicht öffentlich auflösbar"), sonst hätte die bestehende gemockte
  Ollama-Testreihe (`http://ollama.test:11434`) gesperrt werden müssen.
  Container-/Intranet-Kurznamen (`http://ollama:11434`) und private Netze gelten
  bewusst nicht als lokal — der Ausschluss ist am Zähler sichtbar.

## [0.11.0] — Indicator-Cache für `backtestRule()` (STX-08-04) + Copy-Engine (PR #221, 2026-10-03)

> **Status: Beta.** Minor-Release. Die vor der Cache-Umstellung eingefrorenen
> Golden-Hashes für sechs Symbol-/Timeframe-Kombinationen bleiben unverändert.

### Added

* **Copy-Engine (07-03, PR #215; Changelog-Nachtrag 08-01):** `src/copy/engine.ts`
  orchestriert Leader-Tor, Policy, Sizing und persistente Dedupe über
  `copy_order_links` (im `--write`-Modus). Bitunix-WebSocket-Order-Frames werden
  zu `NormalizedLeaderTrade` normalisiert und ausschließlich als
  `SIMULATE_ONLY` auf dem Paper-Ledger verarbeitet — kein `BrokerAdapter`, keine
  Venue-Order.
* **CLI `npm run copy:paper`:** `--dry-run` ist Default; `--write` aktiviert
  Persistenz, `--no-write` ist ein Alias für `--dry-run`, `--replay` spielt
  offline Frames ab und erzwingt `--dry-run`. Ohne Baseline blockiert
  `NO_BASELINE`; bei fehlendem Heartbeat pausiert die Engine mit
  `PAUSED_NO_HEARTBEAT`.
* **Additive Migration** `drizzle/2026-10-04_copy_engine_gates.sql`: ergänzt
  `NO_BASELINE` und fügt `follower_notional` zu `copy_order_links` hinzu.

### Changed

* **`backtestRule()` (`src/lib/ruleEngine.ts`)** baut den vorhandenen
  `IndicatorCache` genau einmal vor der Bar-Schleife und liest jeden Snapshot
  über `snapshotFromCache()` — kein wachsendes `candles.slice(0, i + 1)` mehr.
  Handelslogik, `executionModel`-Default (`legacy`), `RULE_FIELDS`,
  `sanitizeRuleSpec` und `RuleAction` bleiben unverändert.
* **ATR-Nullsemantik im Cache:** `atrPct` ist bei ATR = 0/ungültig jetzt
  `null`, wie im bestehenden Direktpfad (`atrPct()` → `atr()`). Das behebt die
  zuvor nachgewiesene Abweichung `null` vs. `0`; auf dem gemeinsam genutzten
  Cache-Pfad blockiert damit auch `atrPct eq 0` bei flachen Kerzen fail-closed.
  Das ist eine enge Korrektur am Engine-Snapshot, keine Änderung am
  Screening-Code.
* **Benchmark:** Auf einer deterministischen synthetischen 17 520-Bar-Reihe
  lief der alte Direktpfad im Median **20 253,6 ms**, der Cache-Pfad **64,5 ms**
  (314,1× auf derselben Reihe; Ergebnisobjekte identisch). Diese ergänzende
  Messung ersetzt nicht die historische echte `HistoricalStore`-Baseline — die
  dafür verwendete Datenreihe lag in diesem Checkout nicht vor. Details und
  Rohwerte: [`BENCH-BASELINE.md`](docs/audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md).

### Tests

* `tests/ruleBacktest.cacheGolden.test.ts`: sechs vor der Codeänderung
  eingefrorene SHA-256-Goldenläufe über Trades, Kennzahlen und vollständige
  Direkt-Snapshots; alle Hashes bleiben gleich.
* `tests/ruleEngine.indicatorCacheParity.test.ts`: jedes `RULE_FIELDS`-Feld
  Bar für Bar über 3 Symbole × 2 Timeframes sowie explizite Nullfälle für ATR,
  VWAP, Spread, Buch-Tiefe, Donchian und Bollinger.
* Fokussierter Lauf der sechs Backtest-/Engine-/Template-Testdateien: **144 Tests bestanden**.
* `tests/copy.engine.test.ts` deckt den Paper-only-Copy-Pfad ab (20 lokale Tests aus 07-03).
* Die vollständige `npm test`-Suite wurde in diesem Patchlauf auf ausdrückliche Nutzeranweisung nicht ausgeführt; sie wird nicht als grün behauptet.

## [0.10.9] — Strategie-Klassen in `signalDecay*` aus der SSoT (STX-08-03) (2026-10-03)

> **Status: Beta.** Patch-Release (STX-02-Rest, Altlast 1 aus OP-6). Die vier
> Klassenwerte des Signal-Decay-Pfads werden aus der Single Source of Truth
> [`STRATEGY_CLASSES`](src/lib/marketRegime.ts) (`ADR-008`) abgeleitet; es gibt
> **keinen Verhaltenswechsel** — gleiche Werte, gleiche Reihenfolge, gleiche
> Typen, gleiche Schwellen. Eine per neuem ADR ergänzte Strategieklasse muss
> künftig nur noch im ADR und in der SSoT eingetragen werden.

### Changed

* **`STRATEGY_CLASS_KEYS` (`src/lib/signalDecay.ts`)** leitet sich jetzt aus
  `STRATEGY_CLASSES` ab: `[...STRATEGY_CLASSES, "unclassified"]`. Der
  exportierte Typ `StrategyClassKey` und die Reihenfolge
  (`mean-reversion`, `trend`, `breakout`, `unclassified`) bleiben unverändert.
* **Validierung ohne Literalvergleiche:** `isStrategyClassKey()` prüft über
  einen Lookup gegen `STRATEGY_CLASS_KEYS`; die lokale Closure `classOf()`
  (Risk-Config-Overrides `sdc.<klasse>.<feld>`) nutzt dieselbe Prüfung. Der
  Token-Alias `mean_reversion` → `mean-reversion` bleibt erhalten (Token-Format,
  kein Vokabular).
* **`metricClass()` (`src/lib/signalDecayRuntime.ts`)** nutzt denselben Lookup;
  unbekannte Werte fallen weiterhin auf `unclassified`.

### Tests

* Neuer Quelltext-Wächter in `tests/adrVocabulary.test.ts`: in
  `src/lib/signalDecay.ts` und `src/lib/signalDecayRuntime.ts` darf kein
  Klassenname mehr als Vergleichs- oder Listenliteral stehen. Die Namen werden
  aus der SSoT aufgebaut — eine per ADR ergänzte fünfte Klasse ist damit sofort
  mitgeprüft. Gegenprobe dokumentiert: Literal-Vergleich (alt) und fünfte
  Klasse `momentum` (ADR-Simulation) werden rot; danach zurückgenommen.
* `tests/adrVocabulary.test.ts` (37 Tests) und `tests/strategyLifecycle.test.ts`
  grün; `npm run typecheck`, `npm run lint` und `npm test` (4.490 Tests,
  4.454 grün, 0 rot, 36 skipped) ebenso.

### Notes

* **Keine** neue Klasse, kein `momentum`; `unclassified` bleibt die
  Nicht-Klasse (ADR-008). `DEFAULT_CLASS_POLICIES`-Inhalte, Env-Namen
  (`SIGNAL_DECAY_CLASS_*`), Schwellen und Decay-Logik sind unverändert.
* Verbleibende, dokumentierte Literalstelle sind allein die **append-only**
  DB-CHECKs `positions_strategy_class_check` und
  `signal_decay_events_class_check` in
  [`drizzle/2026-09-22_signal_decay.sql`](drizzle/2026-09-22_signal_decay.sql);
  sie bleiben unangetastet.

## [0.10.8] — Doku-Viewer: `docs/architecture/` + `docs/roadmap/` (STX-08-02) (2026-10-03)

> **Status: Beta.** Patch-Release (Altlast 3 aus OP-6, Finding ohne STX-Nummer).
> Der Browser-Doku-Viewer löst die Single-Source-of-Truth-Dokumente des
> Strategie-Stacks jetzt auf — kein neues Sicherheitsmodell, keine
> Laufzeit-Dependency, keine Schema-Änderung.
>
> **Hinweis zur Versionsnummer:** `0.10.7` bleibt frei. Prompt 08-01 wurde am
> 2026-10-03 bewusst als `[Unreleased]`-Nachtrag **ohne** Projekt-Bump
> nachgereicht (Audit-Entscheidung „Form A“); der Release-Plan in
> [`docs/audits/2026-09-29-strategy-template-ausbau/VERSIONING.md`](docs/audits/2026-09-29-strategy-template-ausbau/VERSIONING.md)
> führt 08-02 unter `v0.10.8`.

### Fixed

* **Doku-Viewer (`resolveDoc()` in `src/lib/docsCatalog.ts`):** Der
  Existenz-Fallback sucht zusätzlich in `docs/architecture/${safeBase}` und
  `docs/roadmap/${safeBase}` — in der Reihenfolge nach `docs/security/` und vor
  `docs/archive/`, ohne bestehende Prioritäten zu verschieben. Im
  Browser-Viewer (`/docs/<Datei>.md`, `GET /api/docs?name=…`) sind damit
  [`STRATEGY_STACK.md`](docs/architecture/STRATEGY_STACK.md),
  [`PIPELINE_MAP.md`](docs/architecture/PIPELINE_MAP.md),
  [`DB_SCHEMA.md`](docs/architecture/DB_SCHEMA.md),
  [`INTEGRATION_POINTS.md`](docs/architecture/INTEGRATION_POINTS.md) und der
  ADR-Log [`DECISIONS.md`](docs/roadmap/DECISIONS.md) (ADR-008…ADR-010) lesbar;
  `STATUS.md` fällt unter denselben Suchpfad.
* **Pfadabwehr unverändert:** Der Pfad entsteht weiterhin ausschließlich aus
  `basename()` + fester Ordnerliste (kein `docs/**`-Walk, kein
  Pfad-Parameter). Zusätzlich weist der Existenz-Fallback Parent-Referenzen
  (`../…`, `..\\…`) ab — `resolveDoc("../architecture/STRATEGY_STACK.md")` und
  `resolveDoc("architecture/STRATEGY_STACK")` bleiben `null`. Bewusst **keine**
  neuen `DOCS_CATALOG`-Einträge: Ein Katalogeintrag würde das
  Dateiname-Matching (Schritt 2) für diese Dateien öffnen und genau diese
  Negativfälle auflösen; der Fallback reicht für die Anzeige. Bestehende
  Auflösungen (`audits/README.md`, `security/README.md`, `CHANGELOG.md`) sind
  unverändert.

### Tests

* `tests/docsCatalog.test.ts` (neu, 8 Tests): Auflösbarkeit der sechs
  `architecture/`-/`roadmap/`-Dokumente inkl. `canonicalPath`,
  Suchpfad-Reihenfolge, Traversal-Negativfälle (`..`, `\`, `.md`-lose Namen),
  Containment des aufgelösten Pfads und Regression der bestehenden Auflösungen.

### Docs

* `docs/audits/2026-09-29-strategy-template-ausbau/`: Phase-8-Tabelle
  (`TRACKING.md`, `ROADMAP.md`, `prompts/README.md`) markiert 08-02 als
  erledigt, Altlast 3 ist im Abschnitt „Bekannte Code-Altlasten“ als behoben
  geführt (OP-6 teilweise abgeräumt); `VERSIONING.md` erhält den
  Release-Plan-Eintrag und den Historieneintrag (`v1.2.2`).

## [0.10.6] — Copy-Policy-Engine + Order-Links (STX-07-02) (2026-10-03)

> **Status: Beta.** Versionierte fail-closed Copy-Risikogrenzen und eine
> minimale, idempotente Order-Link-Persistenz. Kein Adapter, kein eigener
> Reconciler, keine eigene Intent-/Receipt-Tabelle und kein Live-Pfad.
> `SIMULATE_ONLY` bleibt auf Datenbankebene festgeschrieben.

### Added

* **Versionierte Policy-Konfiguration** (`src/copy/config.ts`, `policy.ts`):
  `cpl1:<sha256>`-Versionen für gespeichertes `policy_json`, strikte
  Validierung und `evaluatePolicy()` mit Fail-Closed-Entscheidungen
  (`HALTED`, Notional/Day-Limits, erwarteter Spread, Positionen, Tagesverlust,
  Hebel, Mapping). Die Bps-Prüfung nutzt vor dem Submit den erwarteten Spread
  (`RuleSnapshot.spreadPct` bzw. Scanner-`spread`), niemals einen bereits
  realisierten Fill. Copy-Caps sind an `LIMIT_CEILINGS` gebunden oder strenger.
* **Zwei additive Copy-Tabellen** (`drizzle/2026-10-03_copy_subscriptions.sql`):
  `copy_subscriptions` mit `enabled=false` und DB-CHECK `mode='SIMULATE_ONLY'`;
  `copy_order_links` mit `UNIQUE (leader_event_id, follower_intent_id)` und
  `UNIQUE (follower_intent_id)`, Status-/Policy-CHECKs und FK auf die bestehende
  `execution_quality_intents`-Tabelle. Keine weiteren Phase-7-Tabellen.
* **Order-Link-Store** (`src/copy/store.ts`): `createIntent()` ist
  insert-or-return-existing, Transitionen laufen über Zeilensperren nur
  vorwärts, `FILLED`-Retries sind No-Ops und `DIVERGED` ist terminal. Die
  beobachtete Fill-Abweichung wird gespeichert, nicht gegen das Pre-Submit-
  Limit geprüft und löst keinen Cancel aus. Geschlossene Metriklabels plus
  `COPY_ORDER_LINK_TRANSITION`-Audit.
* **Explizite Modulgrenze** (`src/copy/index.ts`, `docs/COPY_TRADING.md`):
  Execution-Quality-Intents, Receipts und Reconciliation bleiben vollständig
  bei `src/executionQuality/` und `src/brokers/reconciliation.ts`.

### Tests

* `tests/copy.policy.test.ts` und `tests/copy.db.test.ts`: Version/Bounds,
  fail-closed Gating, Spread-Units, DB-Migration/Constraints, parallele
  Idempotenz, FK, Transitionen, terminale Zustände und Fill-No-Op.

### Compatibility note

* Das Ticket verlangte für `execution_quality_intent_id` den Typ UUID. Die
  vorhandene `execution_quality_intents.id`-Spalte ist im Repository jedoch
  TEXT (`eq-…`). Die neue FK-Spalte ist deshalb TEXT, damit PostgreSQL die
  Referenz tatsächlich erzwingen kann; die Execution-Quality-Tabelle bleibt
  unberührt.

## [0.10.5] — Copy-Domänenmodell, Symbol-Mapping, Sizing (STX-07-01) (2026-10-02)

> **Status: Beta.** Reines Domänenmodell des Copy-Tradings (Phase 7 · Paket
> 00-02). Keine IO, keine DB, kein Netz, kein Leader-Adapter, keine
> Policy-Engine — bewusst auf die fachliche Form beschränkt. STX-16: der
> einzige Copy-Modus ist `SIMULATE_ONLY` (kein Live-Pfad).

### Added

* **STX-07-01 — Copy-Domänenmodell (rein):** `src/copy/types.ts`,
  `src/copy/mapping.ts`, `src/copy/sizing.ts` (barrel `src/copy/index.ts`).
  - `NormalizedLeaderTrade` normalisiert auf die **Handlungsabsicht**
    `action: OPEN | INCREASE | DECREASE | CLOSE` (nicht auf Order-Übertragung).
  - `CopyMode = "SIMULATE_ONLY"` — Enum mit **genau einem Wert** (STX-16,
    organisatorisch hoch); kein Env-Flag, kein Schalter, kein Live-Pfad.
  - `mapLeaderSymbol(venue, raw)` nutzt die SSoT `tryNormalizeVenueSymbol`
    (`@/symbols/normalize`) und leitet die **venue-übergreifende** ID ab
    (Stablecoin-Quote ≡ USD). Kein `String.replace` auf den Roh-Input;
    unauflösbar ⇒ `{ok:false}` mit Grund, **kein** Fallback.
  - `computeFollowerNotional` mit `FIXED_AMOUNT` / `FIXED_RATIO` /
    `EQUITY_RATIO` — fail-closed, **kein** stiller Moduswechsel
    (EQUITY_RATIO ohne `leaderEquity` ⇒ `{ok:false}`). `CLOSE` ⇒ Notional 0,
    Intent bleibt bestehen.
  - `applyLeveragePolicy` (`FOLLOW_LEADER` klemmt auf `cap` statt abzulehnen,
    `CAP`, `IGNORE`, `RISK_NORMALIZED`).

### Tests

* **STX-07-01:** `tests/copy.domain.test.ts` (rein, keine DB) deckt
  EQUITY_RATIO-Prozentrechnung, `leaderEquity: 0`/`null`, CLOSE-Intent,
  FOLLOW_LEADER-Clamp (10×→3×), Mapping der vier Schreibweisen auf dieselbe
  cross-venue-ID sowie unauflösbares Symbol ab.

## [0.10.4] — Validator-Agent: erklärende Shadow-Auswertung (STX-06-05) (2026-10-02)

> **Status: Beta.** Der Service aus 04-02 (Strategie-Katalog + Lifecycle-Bridging)
> ist gemergt und baut auf dem Schema aus `v0.8.0` auf; er ist Registry, **kein**
> Executor und keine Live-Freigabe. Optional bleibt Feature-Store-Parität 02-04.

### Added

* **STX-05-03 — Screening-Persistenz + Idempotenz:** additive, idempotente
  Migration `drizzle/2026-10-01_strategy_screening.sql` und deckungsgleiches
  Drizzle-Schema für `strategy_screening_runs`/`strategy_market_results`.
  Run-Config (Gewichte + Limits), gemeinsamer PIT-Cutoff und Provenienz bleiben
  reproduzierbar; jede Zelle benötigt einen `strategy_versions`-FK und darf
  ohne Backtest existieren. Bestehende Backtest-/Versions-/Lifecycle-Tabellen
  bleiben unverändert (STX-07).
* **Screening-Store und Keys:** `ssr1:`-/`ssm1:`-Hashes verwenden das gemeinsame
  `canonicalJson`. Transaktionales Create-or-get, atomare Insert-only-Chunks,
  zeilengesperrter monotoner Fortschritt und bounded Result-Reads (max. 200).
  Kein DELETE-Pfad, keine Prioritäts-/Ergebnis-Überschreibung bei Retries.
* **Screening-Tests und Runbook:** echte PostgreSQL-Tests einschließlich
  Drizzle-Push-/SQL-Schema-Parität, paralleler Retries, FK-/Config-Constraints,
  Chunk-Rollback und Fortschritts-/Paging-Grenzen; reine Key-/Bounds-Wächter.
  Bedienung und Rollback in [`docs/STRATEGY_SCREENING.md`](docs/STRATEGY_SCREENING.md).
* **Validator-Agent (STX-06-05):** `runValidatorAgent()` liefert eine separate,
  strikt schema-geprüfte Interpretation des deterministischen Reports. Nur eine
  explizite Allowlist aggregierter Werte wird zum Provider gesendet; `notes`,
  Roh-Kerzen und Trade-Logs bleiben ausgeschlossen. Der Prompt bleibt unter
  8 KiB. Erkannte Boundary-Overrides werden als `INJECTION_ATTEMPT` geblockt;
  Provider- und Schema-Ausfälle liefern `{ unavailable: true }` ohne Freitext-Fallback.
  `LOCAL_FREE` nutzt ausschließlich lokale Provider; `OPENCODE_FREE` ist opt-in
  und Best-Effort. Shadow-Modus ist standardmäßig aktiv, Telemetrie-Labels sind
  begrenzt. Acht fokussierte Tests sichern die Grenzen ab.

### Fixed

* **Zwei rote Wächter aus 04-02 behoben** (die Suite auf `main` war dadurch rot,
  `typecheck`/`lint`/`docs:validate` blieben grün und haben es nicht gezeigt):
  * `src/strategies/service.ts` führte die Strategieklassen erneut als Literalliste
    (`["mean-reversion", "trend", "breakout"]`) und verletzte damit ADR-008
    (`tests/adrVocabulary.test.ts`, Guard für `src/strategies/`). Der Service liest
    jetzt `STRATEGY_CLASSES` aus `src/lib/marketRegime.ts`; `unclassified` und
    Fremdwerte werden weiterhin **vor** dem Insert abgelehnt — Verhalten unverändert,
    nur die Quelle der Werte ist wieder einfach vorhanden.
  * Das Audit-Event `STRATEGY_VERSION_CREATED` hatte keine Beschreibung im
    UI-Katalog (`tests/auditView.test.ts`) und wäre im Dashboard als
    „nicht hinterlegt“ gelandet. Es ist jetzt in `AUDIT_EVENT_CATALOG` beschrieben
    (Template, Version-ID, Fingerprint, Ersteller) und ausdrücklich als
    **Registrierung ohne Promotion oder Live-Freigabe** erklärt.
* **Flaky Test in `tests/sessionRenewal.test.ts`** („renewSession braucht Double-Submit“):
  der Negativfall „falscher CSRF-Header“ bildete den Wert als `csrf.slice(0, 63) + "0"`.
  Der Token ist zufällig; endet er selbst auf `0` (1 von 16 Läufen), war der „falsche“
  Wert der gültige, die Verlängerung gelang und die Suite schlug zufällig fehl. Die
  letzte Stelle weicht jetzt garantiert ab (`assert.notEqual` prüft die Prämisse), und
  ein neuer Test geht **alle 16** Hex-Endungen mit signierten Fixtures durch, statt auf
  den Zufall zu warten. Nur Testcode: `src/lib/authSession.ts` und die Refresh-Route
  bleiben unverändert.

### Documentation

* **Bekannte Code-Altlasten im Audit-Tracking** (`remediation/TRACKING.md`, Audit `v1.1.14`):
  die drei mit `0.6.1` dokumentierten Altlasten (Klassenwerte als Literale, dreifaches
  `VolatilityRegime`, `resolveDoc` ohne `docs/architecture/` und `docs/roadmap/`) stehen
  jetzt dort, wo offene Arbeit geplant wird, und warten als **OP-6** auf die Entscheidung,
  ob und wann sie als eigene Prompts folgen. Alle drei wurden gegen den aktuellen Stand
  erneut geprüft; der in 04-02 hinzugekommene vierte Fall ist bereits behoben (siehe oben).
  ADR-008 nennt genauer, wo die Klassenwerte stehen: auch der CHECK von `positions`
  (`positions_strategy_class_check`) trägt sie, nicht nur der von `signal_decay_events`.
* **Audit-Stand nachgezogen** (`v1.1.14`): `PR_SUMMARY.md` ist als Schnappschuss der
  Audit-Übergabe gekennzeichnet und verweist auf Tracking und ADR-008…010; `report.md` §6
  nennt die Phase-0-Fragen nicht mehr „offen“; die Audit-Indizes in `docs/README.md` und
  `docs/audits/README.md` standen noch auf `v1.1.1`/`v1.1.2` und zeigen jetzt den
  tatsächlichen Stand.
* **Tote Anker repariert:** die beiden Verweise „Versions-Zuordnung“ im Eintrag `0.1.0`
  und im Abschnitt „v0 — Beta-Meilensteine“ zeigten auf `#versionszuordnung-…` statt auf
  die Überschrift `Versions-Zuordnung: v0.x.x ↔ v1.x.x` (`#versions-zuordnung-v0xx--v1xx`).

* **STX-06-05 dokumentiert und versioniert:** `docs/STRATEGY_VALIDATION.md` beschreibt
  Prompt-Grenzen, Routing, Shadow-Default und bounded Telemetrie. Der Agent gibt die
  Interpretation nur by-value zurück; `persist.ts` blieb unberührt, daher ist keine
  automatische Speicherung in `detail jsonb` oder Workflow-Verdrahtung enthalten.
  Audit-Roadmap, Tracking, Finding STX-13 und kanonische Versionsmetadaten stehen auf
  `v0.10.4` (`v1.1.20` im audit-internen Schema).

## [0.10.3] — Validator: Report, Gate-Kette & Evidenz (STX-06-04) (2026-10-02)

> **Status: Beta, nicht produktionsreif.** Die vierte deterministische
> Validator-Stufe (06-04) führt Annahmen-Audit (06-01), Overfit-Auswertung
> (06-02) und Cost-Stress (06-03) in **einem** Urteil zusammen und legt es als
> Evidenz ab: `result` kennt genau `PASS | FAIL | INCONCLUSIVE` — kein Score,
> keine Gewichtung, kein „knapp bestanden". Der Validator promoviert nie; er
> schreibt ausschließlich über `recordEvidence()`. Nur der Validator-Agent
> (06-05) bleibt offen.

### Added

* **Report + achtstufige Gate-Kette** (`src/strategies/validator/report.ts`,
  STX-06-04): `buildValidationReport()` ist rein (keine Uhr, keine DB, kein
  Zufall) und liefert `StrategyValidationReport` mit `result`, Identität
  (`strategyKey`/`strategyVersion`/`strategyVersionId`/`templateId`/
  `templateVersion`/`class`), `metrics` (Sharpe, Sortino, Drawdown, Win-Rate,
  Profit-Faktor, Erwartungswert, Trades, Netto-PnL), `robustness`,
  `overfitting`, `assumptions`, `regimes`, `notes`, `evidenceHash`,
  `policyVersion`/`codeVersion`/`dataVersion` und der Zeit-Trias
  `eventTime ≤ availableAt ≤ computedAt`. Die Kette läuft in fester
  Reihenfolge `ASSUMPTIONS → HOLDOUT_INTEGRITY → DATA_SUFFICIENCY →
  OOS_POLICY_GATES → TRAIN_OOS_GAP_AND_PLATEAU → COST_STRESS →
  MULTIPLE_TESTING → FINAL`: die erste Stufe ohne `PASS` entscheidet, alle
  späteren stehen als `SKIPPED` im `gates[]`-Protokoll; `PASS` gibt es nur,
  wenn alle sieben Prüfstufen bestanden sind. Fehlende Vorstufen (`null`) sind
  immer `INCONCLUSIVE`, nie stilles `PASS`; ein `INCONCLUSIVE` wird nicht
  durch einen späteren `FAIL` überstimmt. Schwellen kommen unverändert aus der
  SSoT (`evaluateBacktestGate()`/`DEFAULT_PROMOTION_POLICY`,
  `MC_MIN_SAMPLE_TRADES`, `trainOosGap()`/`plateauMetrics()`,
  `DEFAULT_STRESS_VERDICT_THRESHOLDS`, `multipleTestingWarning()`).
  `assertReportHashIntegrity()` prüft beide Hashfelder fail-closed.
* **Regime-Aggregation (ADR-009/ADR-E2)** (`aggregateRegimeTrades()`): ordnet
  jeden Trade point-in-time dem letzten bestätigten `regime_snapshots`-Eintrag
  mit `asOf <= Entry` zu (deterministisch sortiert nach
  `(asOf, featureVersion, modelVersion)`), liest ausschließlich
  `REGIME_EVAL_LABELS` ohne `UNKNOWN` und schließt `UNKNOWN`-Snapshots sowie
  Trades ohne Snapshot **gezählt** aus (kein `RANGE`-Fallback). `sharpe` ist
  `null` statt `0`, solange eine Zelle unter `minSampleTrades` (Default 30,
  kleinster Wert 2) liegt oder keine Streuung hat; `regimeStability` und die
  Feature-/Modellversionen der verwendeten Snapshots stehen im Report.
  `evaluateRegimeOos` (Marktvermessung) bleibt unverändert.
* **Evidence-Writer** (`src/strategies/validator/persist.ts`):
  `writeValidationEvidence()`/`writeValidationEvidenceDetailed()` rufen
  ausschließlich `recordEvidence()` aus `@/strategyLifecycle` auf —
  idempotent über `sle1:`-`content_hash`/`slei1:`-`idempotency_key` (UNIQUE,
  Retry und parallele Läufe liefern genau eine Zeile), mit Report-Hash-Prüfung
  vor jedem Schreibversuch. **Kein `requestTransition`**, keine eigene
  Hashfunktion, kein direkter DB-Zugriff.
* **CLI + npm-Skript** (`scripts/run-validate-strategy.ts`,
  `npm run validate:strategy`): `--strategy-version-id` XOR `--create`,
  `--template/--symbol/--timeframe`, `--params=<json>` (Objekt oder
  Nachbarschafts-Array ≤ 5), `--from/--to` (Pflicht), `--max-runs`,
  `--holdout-days`, `--embargo-hours`, `--out=<pfad>`, `--no-write`, `--help`;
  Exit 0 nur bei `PASS`, 1 bei `FAIL`/`INCONCLUSIVE`/Laufzeitfehler, 2 bei
  Bedienfehlern.
* **Barrel + Doku:** `src/strategies/validator/index.ts` (fünf Module, eine
  Richtung); Teil 4 in [`docs/STRATEGY_VALIDATION.md`](docs/STRATEGY_VALIDATION.md)
  (Report-Felder, Gate-Kette, Grenzen, Regime-Aggregation, CLI) und §1.10 in
  [`docs/architecture/STRATEGY_STACK.md`](docs/architecture/STRATEGY_STACK.md).
* **Tests:** `tests/strategyValidation.report.test.ts` (32 Fälle — eine Regel
  je Gate, `INCONCLUSIVE`-schlägt-`FAIL`, Skip-Semantik, ADR-009-Regimefälle,
  Hash-/IO-Wächter) und `tests/strategyValidation.persist.test.ts` (6 Fälle auf
  echtem PostgreSQL — genau eine Zeile je Inhalt, Retry/Parallel-Dedupe,
  Zeitsemantik-CHECK, keine Transition-/State-Zeile).

### Changed

* **`PROMOTION_POLICY_BOUNDS.validationMinPlateauShare = [0, 1]`**
  (`src/strategyLifecycle/policies.ts`): Der Gültigkeitsbereich der
  Plateau-Grenze gehört zur Policy, der Default (`0.5`) bleibt am Gate
  (`DEFAULT_VALIDATION_GATE_BOUNDS`); `resolveValidationGateBounds()` wirft
  außerhalb des Rahmens fail-closed. Dies ist die **einzige** Änderung an
  `src/strategyLifecycle/**` in diesem Release.

### Docs

* **Audit-Stand `v1.1.19`:** STX-17 geschlossen, STX-03 abgeschlossen
  (Regime-Naht); `ROADMAP.md`, `VERSIONING.md`, `README.md` und
  `remediation/TRACKING.md` nachgezogen.

## [0.10.2] — Validator: Cost- & Slippage-Stress-Runner (STX-06-03) (2026-10-02)

> **Status: Beta, nicht produktionsreif.** Die dritte deterministische
> Validator-Stufe (06-03) schließt Finding **STX-11** ohne drittes
> Kostenmodell: `COST_STRESS_SCENARIOS` (`base`, `double`, `triple`) prüft, ob
> eine Strategie bei 2×/3× Gebühren und 5/10/20 bp Slippage überlebt —
> zweischichtig über einen echten In-Engine-Sweep (`runInEngineStress`,
> `summarizeStressSweep`) und einen dünnen Post-hoc-Monte-Carlo-Wrapper
> (`runPostHocStress`). Beide Schichten liegen im Report strikt getrennt.
> Report + CLI (06-04) und der Validator-Agent (06-05) bleiben offen.

### Added

* **Versionierte Stress-Szenarien** (`src/strategies/validator/stress.ts`,
  STX-06-03, `COST_STRESS_VERSION = "stx-06-03-cost-stress@1"`):
  `COST_STRESS_SCENARIOS` exportiert `base` (`feeMultiplier: 1`,
  `slippageBps: 5`, `"Basis"`), `double` (`feeMultiplier: 2`,
  `slippageBps: 10`, `"2× Kosten"`) und `triple` (`feeMultiplier: 3`,
  `slippageBps: 20`, `"3× Kosten"`). Im JSDoc ist dokumentiert, dass die
  Bps-Werte normative Stress-Annahmen sind (keine Messwerte); die
  tatsächlichen Kosten im Basislauf werden in 06-01 (`FEE_NONZERO`,
  `SLIPPAGE_NONZERO`, `COST_NONZERO`) geprüft.
* **Schicht 1 — In-Engine-Stress (`runInEngineStress`, `summarizeStressSweep`):**
  Pro Szenario genau ein Walk-Forward-Lauf mit angepasstem
  `BacktestEngineConfig` (`feeModel.{makerFee,takerFee}` skaliert,
  `slippageModel: "fixed"`, `fixedSlippageBps`; `executionModel` bleibt der
  des Referenzlaufs: `"legacy" | "paper" | "event_replay"`). `base` ist
  byte-identisch zum Referenzlauf (`JSON.stringify`-geprüft inkl.
  `configHash`/`captureHash`). `slippageModel: "none"` (oder 0-Kosten) im
  Referenzlauf liefert `{ ok: false, errors: [...] }` ohne stilles
  Hochrechnen. `summarizeStressSweep()` berechnet `degradationRatio =
  OOS-Sharpe(triple) / OOS-Sharpe(base)`, interpoliert `breakevenMultiplier`
  linear zwischen den Szenarien (`null` bei `triple.netPnl > 0` ⇒ „hält
  mindestens 3×") und vergibt das Verdikt `COST_ROBUST`
  (`degradationRatio >= 0.6` **und** `triple.netPnl > 0`), `COST_SENSITIVE`
  (`degradationRatio ∈ [0.3, 0.6)` oder `>= 0.6` bei unprofitabler `triple`)
  bzw. `COST_DEPENDENT` (`< 0.3` oder unprofitabler `base`).
* **Schicht 2 — Post-hoc-Stress (`runPostHocStress`, `buildStressReport`):**
  Dünner Wrapper um `runMonteCarloSimulation()` mit `stress: { feeMultiplier,
  slippageMultiplier }` (keine eigene MC-Implementierung; `1×/1×` wird auf
  `stress: null` normalisiert). In `StressSweepOk` und `StressReport` liegen
  `inEngine` und `postHoc` strikt in getrennten Feldern.
* **Harte Laufzeit-Bounds (`maxRuns` & `--max-runs`):**
  `DEFAULT_MAX_STRESS_RUNS = 45` (`3 Szenarien × 3 Fenster × 5 Kandidaten`),
  `maxRuns` als hartes Argument (Überschreitung bricht vor dem ersten
  Runner-Aufruf mit `{ ok: false, errors }` ab) sowie CLI-Parser
  `parseMaxRunsFlag(argv)` für `--max-runs` / `--max-runs=<n>`.
* **22 Tests in 7 Suiten** (`tests/strategyValidation.stress.test.ts`):
  Szenario-Katalog, echte Byte-Identität von `base` gegen `runWalkForward`,
  Fail-Closed bei `slippageModel: "none"` und `maxRuns`-Überschreitung,
  Erhalt von `executionModel` (`legacy`/`paper`/`event_replay`),
  `summarizeStressSweep` (Ratio, Breakeven-Interpolation, `null` ⇒ „mindestens
  3×", Verdikt-Schwellen), `runPostHocStress`-Weiterleitung an
  `runMonteCarloSimulation` und getrennte Report-Sektionen.

### Documentation

* **[`docs/STRATEGY_VALIDATION.md`](docs/STRATEGY_VALIDATION.md) Teil 3 (§16–§23):**
  Zweischicht-Architektur (In-Engine vs. Post-hoc), `COST_STRESS_SCENARIOS`,
  `runInEngineStress`-Vertrag, `summarizeStressSweep`-Formeln (inkl.
  Klarstellung der Ratio-Richtung `OOS-Sharpe(triple) / OOS-Sharpe(base)`),
  `runPostHocStress` & Report-Trennung, Laufzeitbudget und Abgrenzung zu
  06-04/06-05.
* **Architektur, Pilot & Audit-Tracking (`v1.1.18`):**
  [`docs/architecture/STRATEGY_STACK.md`](docs/architecture/STRATEGY_STACK.md)
  (§1, §1.7, §1.9), Laufzeitbudget (`Zeit pro Lauf × Runs`) in
  [`SCREENING-PILOT.md`](docs/audits/2026-09-29-strategy-template-ausbau/remediation/SCREENING-PILOT.md),
  Finding [`STX-11`](docs/audits/2026-09-29-strategy-template-ausbau/findings/STX-11-cost-stress-existiert.md)
  auf `FIXED — STX-06-03 (2026-10-02, v0.10.2)` gesetzt sowie `ROADMAP.md`,
  `TRACKING.md`, `VERSIONING.md` und `README.md` des Audits aktualisiert.

## [0.10.1] — Validator: Overfit- & Robustheitsauswertung (STX-06-02) (2026-10-02)

> **Status: Beta, nicht produktionsreif.** Die zweite deterministische
> Validator-Stufe (06-02): `robustShare` misst das **Plateau** des
> Kandidatenraums statt des Optimum-Punkts, die IS/OOS-Lücke wird gegen
> konfigurierbare Grenzen geprüft, der Kandidatenraum wird auf Multiplizität
> (Multiple Testing) geprüft, und die Holdout-Integrität wird dreifach
> verifiziert. Reine Funktionen über vorhandene Strukturen: keine IO, keine
> Uhr, keine neue Kandidatengenerierung, keine LLM-Auswertung.
> Cost-Stress (06-03), Report + CLI (06-04) und der Validator-Agent (06-05)
> bleiben offen.

### Added

* **Plateau statt Optimum** (`src/strategies/validator/overfit.ts`, STX-06-02):
  `plateauMetrics()` wertet die `CandidateScoreRow`-Tabellen eines
  Walk-Forward-Laufs als Nachbarschafts-Scan aus — `robustShare` (Anteil der
  Kandidaten mit `passedGates` in **allen** Fenstern), `neverShare`,
  `stableCount` sowie Median-Rang und Stabilität des gewählten Kandidaten.
  „19 von 20 Varianten funktionieren“ ist ein Plateaubefund; „19 von 20 sind
  ein Ausreißer, den 1 nicht“ ist Fragilität — die Zahl macht den Unterschied
  maschinenlesbar. Der Prompt-Shape bleibt enthalten; additive Felder
  (`candidateCount`, `windowCount`, `status`, `summary`) tragen den Grund.
* **IS/OOS-Lücke mit konfigurierbaren Grenzen:** `trainOosGap({ is, oos })`
  liefert `{ isSharpe, oosSharpe, gap, verdict }` mit den Defaults
  `gap > 0.5 ⇒ SUSPECT` und `oosSharpe <= 0 ⇒ BROKEN` (beide konfigurierbar,
  harte Bounds, fail-closed). **`isSharpe` allein entscheidet nie** — ein
  brillantes IS heilt keine kaputte OOS; ein Aggregat ohne Fenster liefert
  `UNKNOWN` (nie „OK aus 0 Werten“).
* **Multiple-Testing-Warnung:** `multipleTestingWarning(n)` — `n <= 5` ohne
  Zuschlag, `6…20 ⇒ WARNING` im Report, `n > 20 ⇒ BLOCKING`. Die Begründung
  steht im Doc-Kommentar (Familienfehler 1 − 0.95ⁿ, erwarteter Bestwert unter
  der Null ≈ √(2·ln n) Standardfehler) und ist bewusst nicht
  „wegoptimierbar“: Bei 50 Kandidaten ist der beste per Zufall gut.
* **Holdout-Integrität:** `holdoutIntegrity(holdout, freeze, reference?)`
  prüft `holdout.from >= freeze.oosTo`, `holdout.candidateId ===
  freeze.selectedCandidateId` und `freeze.dataManifest.candlesHash`
  (Existenz, sha256-Form, Referenzvergleich) ⇒
  `CLEAN | CONTAMINATED | UNKNOWN`; `CONTAMINATED` ⇒ `INCONCLUSIVE`, `CLEAN`
  bleibt ausdrücklich **kein** `PASS`. Ohne Referenz ist „unverändert“ nicht
  beweisbar: der Befund ist dann `UNVERIFIED`, nicht still sauber.
* **39 Tests** (`tests/strategyValidation.overfit.test.ts`): die drei
  Plateau-Fixtures 1/5, 19/20, 20/20 (drei unterscheidbare Ergebnisse), die
  strikte „in ALLEN Fenstern“-Semantik, `BROKEN` trotz brilliantem IS,
  `BLOCKING` ab 21 Kandidaten, Kontamination durch überlappenden Holdout und
  Hash-Abweichung, `UNKNOWN`-Pfade inklusive fehlender Score-Tabelle sowie der
  statische IO-Wächter (keine Wert-Importe, keine Kandidatengenerierung).

### Documentation

* **`docs/STRATEGY_VALIDATION.md`** um Teil 2 („Overfit & Robustheit“)
  erweitert: die vier Auswertungen mit Formeln und Grenzen, die
  `UNKNOWN`-Regel, die dokumentierten Abweichungen von der Prompt-Skizze
  (u. a. flache Tabelle = ein Fenster, optionaler `reference`-Hash) und die
  Testabnahme.
* **Audit-Tracking** (`v1.1.17`): 06-02 ist ☑, STX-17 bleibt bis 06-04 in
  Arbeit; Release-Plan nachgezogen (06-02 als eigenes Release `v0.10.1`,
  Stress 06-03 ⇒ `v0.10.2`, Report 06-04 ⇒ `v0.10.3`, Validator-Agent 06-05 ⇒
  `v0.10.4`) und Versionshistorie ergänzt.

### Unverändert (Sperren des Prompts)

* `src/backtest/walkforward.ts` — nur gelesen (`CandidateScoreRow`,
  `FreezeArtifact`, `HoldoutReport`, `WalkForwardAggregate` als Typen); keine
  Änderung, keine zweite Sortier-/Selektions-Wahrheit außer der dokumentierten
  Rangfolge-Spiegelung `compareScoreRows`.
* Keine Kandidatengenerierung (bleibt `runWalkForward`), keine MC-/Cost-Stress-
  Auswertung (06-03), keine LLM-Auswertung (06-05).

## [0.10.0] — Validator: deterministischer Annahmen-Audit (STX-06-01) (2026-10-02)

> **Status: Beta, nicht produktionsreif.** Phase 6 (Validator) ist eröffnet:
> `v0.10.0` liefert die **erste** der vier deterministischen Validator-Stufen
> (06-01). Overfit-/Robustheits-Messung (06-02), Cost-Stress (06-03) und der
> Report mit CLI (06-04) bleiben offen — für die vollständige Phase-6-Abnahme
> sind sie erforderlich. Keine Metrik-Auswertung, kein LLM, kein Live-Pfad.

### Added

* **Deterministischer Annahmen-Audit** (`src/strategies/validator/assumptions.ts`,
  STX-06-01): `auditAssumptions()` prüft, ob die deklarierten Annahmen eines
  Templates (`StrategyTemplate.assumptions`) im konkreten Lauf **belegt** sind —
  nicht, ob sie sinnvoll sind. Reine Funktion: keine IO, keine Uhr, keine DB,
  ausschließlich injizierte `*Facts` (`BacktestRunFacts`, `CandleFacts`,
  `RunConfigFacts`). Fehlende Fakten sind `UNKNOWN`, nie `HOLDS`.
* **Elf Prüfungen mit fester Reihenfolge:** `FEE_NONZERO`, `SLIPPAGE_NONZERO`,
  `SPREAD_MEASURED`, `DEPTH_SUFFICIENT`, `WARMUP_MET`, `TRADES_SUFFICIENT`,
  `CAPS_RESPECTED`, `LEAKAGE_PROTECTED`, `INTRADAY_ONLY`,
  `CHANGE_PCT_SEMANTICS` (die zehn Pflichtprüfungen des Prompts) plus
  `FILLS_MODELLED` als begründete Ergänzung — die §3.4-Checkliste nennt
  „instant fills", und ohne sie bliebe die Kategorie `EXECUTION` (bei vier der
  sechs Templates **kritisch**) ungeprüft. Jede `evidence` enthält immer eine
  Zahl, nie ein „vielleicht".
* **`UNKNOWN` ist ein Ergebnis:** `TRADES_SUFFICIENT` liefert unter
  `MC_MIN_SAMPLE_TRADES` (30) `UNKNOWN` und **niemals** `VIOLATED` — zu wenig
  Stichprobe ist kein Gegenbeweis. Dasselbe gilt für jedes fehlende Faktum.
* **`critical`-Regel und Drei-Werte-Urteil:** Eine kritische Template-Annahme
  mit `VIOLATED` **oder** `UNKNOWN` macht das Gesamtergebnis zu `INCONCLUSIVE`
  — ausdrücklich nicht zu `FAIL`. *Ein nicht prüfbarer Lauf ist kein Beweis
  gegen die Strategie.* `FAIL` bleibt dem Fall vorbehalten, in dem eine
  `BLOCKING`-Prüfung verletzt ist, ohne dass eine kritische Annahme betroffen
  ist. Kritische Annahmen ohne Prüfungsbezug (heute: `REGIME`) stehen als Fakt
  in `uncoveredCritical`, ohne den Status zu ändern.
* **Metrik-Gate `assumptionGate()`:** drückt die Reihenfolge-Vorschrift des
  Prompts in Code — 06-02/06-03/06-04 dürfen Metriken nur auswerten, wenn der
  Audit `PASS` liefert. Ein Lauf mit verletzter Gebührenannahme hat keinen
  informativen Sharpe.
* **Konfigurierbare Schwellen mit harten Bounds**
  (`maxMissingSpreadPct`/`maxMissingBookDepthPct` 20 %,
  `minDepthToNotionalRatio` 1): Werte außerhalb werden **geworfen**, nicht
  still geklemmt. Die übrigen Grenzen sind gelesene Code-Fakten statt zweiter
  Wahrheiten (`MC_MIN_SAMPLE_TRADES`, `RULE_BACKTEST_TRADE_CAP` 200,
  `RULE_BACKTEST_EQUITY_CAP` 120, `SUPPORTED_TIMEFRAME_MS`, `RULE_FIELD_LABELS`).
* **38 Tests** (`tests/strategyValidation.assumptions.test.ts`): 1 HOLDS-Pfad,
  17 `VIOLATED`-Pfade, 6 `UNKNOWN`-Pfade, die Verdict-/Mapping-Regeln,
  Determinismus, Eingabe-Treue, Schwellen-Override und -Ablehnung, das Gate und
  ein statischer IO-Wächter über den Modulquelltext. Keine DB, kein Netz, keine
  Zeitabhängigkeit.

### Documentation

* **`docs/STRATEGY_VALIDATION.md`** (neu, im Doku-Index und im Katalog
  `GET /api/docs` registriert): Auftrag, Fakten-Herkunft, Prüftabelle,
  Verdict-Regeln, Schwellen, bewusst **nicht** geprüfte Annahmen (Funding,
  Survivorship, Regime) und die fünf dokumentierten Abweichungen vom Prompt —
  darunter `CAPS_RESPECTED` (der Prompt schreibt `CAPS_RESpected`) und
  `INTRADAY_ONLY` auf `1h` als `WARNING` (`VWAP_PCT_RELIABLE_TIMEFRAMES` zählt
  `1h` zur Intraday-Menge, der UTC-Anker trägt dort aber erst ab der zweiten
  Kerze des Tages, STX-01).
* **STX-14 bekommt seine Prüfung:** `changePct24h` in `requiredFields` oder in
  der Regel ist jetzt ein `VIOLATED` mit `WARNING` — die periodenbasierte
  Semantik (97 Perioden, nicht 24 h) wird aus `RULE_FIELD_LABELS` zitiert statt
  nacherzählt. Keine Umrechnung, wie das Finding es verlangt.
* **Audit-Tracking** (`v1.1.16`): 06-01 ist ☑, STX-14 hat seine Prüfung,
  STX-17 bleibt bis 06-04 offen; Release-Plan und Versionshistorie nachgezogen.

### Unverändert (Sperren des Prompts)

* `montecarlo.ts`, `walkforward.ts`, `marketRegime.ts` — höchstens gelesen.
* Keine LLM-Auswertung (06-05), keine Metrik-Auswertung (06-02/06-03).
* Keine Erzeugung von Annahmen: geprüft werden ausschließlich die deklarierten.

## [0.9.0] — Screening: Matrix wird zu Jobs (STX-05-04) (2026-10-02)

> **Status: Beta, nicht produktionsreif.** Die Matrix aus 05-01…03 bekommt
> einen Läufer, eine Engine-Anbindung und eine CLI. Kein Live-Pfad, keine
> Lifecycle-Promotion, keine Änderung an `backtestRule()`,
> `runMultiAssetBacktest()` oder der Engine selbst.

### Added

* **Screening-Runner** (`src/screening/runner.ts`): `runScreening()` fährt
  `createOrGetRun()` → je Zelle `upsertCells()` → optionaler Backtest →
  Metriken. `maxCells` ist **hart** — eine Überschreitung bricht mit
  `matrix too large: n > limit` ab, ohne einen Store-Zugriff und ohne stilles
  Kürzen. I/O-Nebenläufigkeit 4 (max 8), die Engine strikt seriell; **keine**
  `worker_threads`.
* **Backtest-Job-Adapter** (`src/screening/backtestAdapter.ts`): ruft
  ausschließlich `runMultiAssetBacktest()` auf
  (`SCREENING_BACKTEST_PATH = "multiAsset"` — Entscheidung aus
  [`BENCH-BASELINE.md`](docs/audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md)
  §6: O(n) statt O(n²), 121,7× schneller, 7 500 Zellen in 0,44 Kernstunden).
  Kerzen werden punkt-in-zeit gefiltert (`ts ≤ asOf`), je Reihe einmal gelesen
  und hart auf `SCREENING_MAX_CANDLES_PER_CELL` (20 000) begrenzt.
  `compileTemplate()` bleibt der einzige Sanitize-Pfad und bekommt das
  venue-native Symbol.
* **Caps statt Kappung:** `checkScreeningCaps()` prüft gegen die Hülle des
  Regel-Backtest-Pfads (`RULE_BACKTEST_MIN_BARS` 100, `RULE_BACKTEST_TRADE_CAP`
  200, `RULE_BACKTEST_EQUITY_CAP` 120). Ein Verstoß macht die Zelle `BLOCKED`
  mit Grund `caps exceeded` und **leeren Metriken** — ein gekapptes Ergebnis
  gibt es nicht. Unbekannte Größen (`null`) sind fail-closed ein Verstoß.
* **CLI `npm run screening`** (`scripts/run-screening.ts`): `--dry-run` ist der
  Default, `--execute` der einzige Weg zu einem echten Lauf; dazu
  `--templates`, `--timeframes`, `--max-instruments` (500), `--max-cells`
  (5000), `--limit-cells`, `--concurrency` (4), `--as-of`, `--run-id` und die
  Kostenbremse `--max-candles`. Ausgabe: Tabelle
  `priority · template · instrument · tf · status · reasons` plus
  Zusammenfassung je Ergebnis-Token, `BLOCKED`-Gründen und Cap-Zählern.
  SIGINT/SIGTERM lassen den Lauf als `ABORTED` stehen — fortsetzbar mit
  `--run-id`.
* **Telemetrie** `screening_cells_total{result}` mit dem **geschlossenen**
  Vokabular `discovered/backtested/blocked/capped/failed/skipped` — kein
  Instrument, kein Template, keine Priorität im Label.
* **Tests** `tests/screening.runner.test.ts` (27) und
  `tests/screening.backtestAdapter.test.ts` (11): harte `maxCells`, Caps ⇒
  `BLOCKED` statt Kappung, 50 Zellen mit Stub << 30 s, bounded Concurrency,
  bounded Labels, Abbruch ⇒ `ABORTED` mit konsistentem `cells_done` +
  Fortsetzung, idempotentes Replay. Store und Backtest sind injizierte Ports,
  es läuft **keine** Engine und **keine** Datenbank.
* **Pilot-Runbook**
  [`SCREENING-PILOT.md`](docs/audits/2026-09-29-strategy-template-ausbau/remediation/SCREENING-PILOT.md):
  `npm run screening -- --limit-cells=50 --execute` ist nach dem Merge
  verbindlich. Über eine Kernstunde für 50 Zellen wird 05-04 abgelehnt und
  STX-12 (`backtestRule()` O(n²)) bekommt Vorrang.

### Changed

* **Projektversion `v0.9.0`** und die kanonischen Versions-/Projektstatus-
  Dokumente wurden aktualisiert.
* **Doku:** [`docs/STRATEGY_SCREENING.md`](docs/STRATEGY_SCREENING.md) um den
  Abschnitt „Runner, CLI und Backtest-Pfad" erweitert;
  [`docs/architecture/STRATEGY_STACK.md`](docs/architecture/STRATEGY_STACK.md)
  §1.6 ergänzt und die Lücken-Tabelle aktualisiert (Runner/CLI existieren).
* **Audit-Tracking:** 05-04 ist umgesetzt und testbelegt; die Annahme steht
  unter dem Vorbehalt des Pilots.

### Notes

* **`backtest_run_id` bleibt in 05-04 `null`.** `persistBacktestRun()` erwartet
  einen vollständigen `WalkForwardReport`; aus einem Einzelzellen-Engine-Lauf
  einen solchen Report zu bauen wäre eine zweite Wahrheit über Läufe. Die
  Spalte ist nullable (05-03), die Zellen bleiben gültig; der optionale
  `persist`-Hook im Adapter ist die dokumentierte Naht für einen späteren
  Prompt.
* **`crossSectional` bleibt im CLI ungesetzt:** der Scanner-Faktor
  `crossSectionalMomentum` ist kein Point-in-Time-Snapshot und hat keine
  `snapshotId` — ein daraus gebauter `CrossSectionalRankContext` wäre erfundene
  Provenienz. Der Matrix-Bauer setzt seinen dokumentierten Neutralwert 0,5.
* **Die Equity-Cap wird auf echten Zellen greifen.** Die Equity-Kurve wächst
  mit den verarbeiteten Kerzen (`RULE_BACKTEST_EQUITY_CAP` = 120); der Pilot
  muss berichten, wie viele Zellen daran hängen, damit über die
  Vergleichbarkeitshülle entschieden werden kann.
* Keine neue Runtime-Dependency, kein neues Env-Flag, keine Migration.

## [0.8.0] — Strategie-Persistenz: Schemafundament (STX-04-01) (2026-10-01)

> **Status: Beta, nicht produktionsreif.** Dieses Release ergänzt ausschließlich
> die additive Datenbank-Grundlage für rekonstruierbare Strategie-Versionen.
> Es gibt keinen Backfill und noch keinen Service-Schreibpfad.

### Added

* **Migration `drizzle/2026-10-01_strategy_catalog.sql`** legt
  `strategy_definitions` und `strategy_versions` append-only und idempotent an.
  Template-Slug, Strategieklasse, Version, System-Timeframe-Allowlist und
  `stv1:`-Content-Hash werden per CHECK validiert; Definition/Version,
  Fingerprint und Content-Hash sind eindeutig. Der Content-Hash verhindert
  doppelte Persistenz bei Retry/Replay.
* **Drizzle-SSoT `src/db/schema.ts`** erhält deckungsgleiche Tabellen- und
  Constraint-Definitionen. `template_id` bleibt ohne FK auf den code-owned
  Template-Katalog.
* **DB-Tests `tests/strategyCatalog.db.test.ts`** decken doppelte Migration,
  Roundtrip, Constraints, Eindeutigkeit, Lifecycle-Kompatibilität und den
  kommentierten Rollback auf einer Wegwerf-DB ab.

### Changed

* **Projektversion `v0.8.0`** (Schemafundament für Phase 4) und die kanonischen
  Versions-/Projektstatus-Dokumente wurden aktualisiert.
* **Audit-Tracking STX-06:** 04-01 ist abgeschlossen; der Befund bleibt bis zum
  04-02-Service in Arbeit, weil noch kein Anwendungs-Schreib-/Lesepfad besteht.

### Notes

* **Bootstrap: LEER starten.** Es werden weder Strategie-Artefakte backgefüllt
  noch Lifecycle-Zeilen verändert. Der optionale Lifecycle-FK wurde wegen des
  ausdrücklichen Lifecycle-Table-Locks ausgelassen; eine erneute Prüfung braucht
  einen separat abgestimmten Scope.
* Die Migration ist ausführbar als SQL und über `drizzle-kit push`. Die neuen
  Tabellen wurden isoliert gegen beide Schema-Pfade verglichen.

## [0.7.6] — Template-Vertragstests + Katalog-Vollständigkeit (STX-03-10, Abschluss Phase 3) (2026-10-01)

> **Status: Beta, nicht produktionsreif.** Die **Phase-3-Abnahme** ist
> geschlossen: Sechs versionierte Strategie-Artefakte existieren, kompilieren
> über den **unveränderten** Sicherheitspfad (`buildRule(params)` →
> `sanitizeRuleSpec()` → `RuleSpec`, 03-09) und sind gegen die Engine
> vertraglich abgesichert. **Kein Produktivcode geändert:** Der Release besteht
> ausschließlich aus Tests, dem Doku-Generator
> `scripts/gen-strategy-templates-doc.ts`, der daraus erzeugten
> `docs/STRATEGY_TEMPLATES.md` und den Versions-/Doku-Dateien.
> `ruleEngine.ts`, `sanitizeRuleSpec`, `RULE_FIELDS`, `RULE_CEILINGS`,
> `indicators.ts` und `indicatorCache.ts` bleiben unangetastet; es gibt
> **keine** Fehlerkorrektur am Produktivcode. Die Engine-↔-Cache-Parität aus
> Phase 2 (02-02/02-03) ist grün — **kein** Folge-Prompt nötig. Ohne 04-01
> bleibt jede Version weiterhin nur ein Katalogeintrag im Code; erst die
> Persistenz macht sie rekonstruierbar.

### Added

* **Template-Vertragstests `tests/strategies.templates.test.ts`** (STX-03-10,
  Finding STX-18; 60 Tests über **alle sechs** Templates, DB-/LLM-/netzfrei,
  Fixtures aus `tests/`, Muster `tests/backtest.unit.test.ts`):
  * **Struktur-Invarianten:** `validateTemplate(t) === []`, Params
    `min ≤ default ≤ max` **und** `default` auf dem `step`-Raster,
    `requiredFields`/`mapsTo` ⊆ `RULE_FIELDS`, `class ∈ STRATEGY_CLASS_KEYS`
    und ≠ `unclassified` (ADR-008), `supportedTimeframes` nicht leer,
    duplikatfrei, ⊆ `SUPPORTED_TIMEFRAMES`, `expectedRegimes` = fünf
    `MarketRegime`-Werte **ohne** `UNKNOWN` (ADR-009), Kontrakt-Invariante
    `regimeGateFactor(regime, class)` für alle fünf Regimes +
    `DEFAULT_CLASS_POLICIES[class]`, eindeutige Annahmen-IDs und mindestens
    eine `critical: true` je Template.
  * **Compiler-Parität:** Defaults kompilieren `{ok:true}` **ohne** `clamped`,
    derselbe Aufruf liefert denselben `stc1:`-Fingerprint, `symbol` kommt
    ausschließlich vom Aufrufer (`buildRule` liefert kein Symbol, das Symbol
    steckt im Fingerprint), `sourceRole` ist immer `RESEARCH`.
  * **Snapshot-Kompatibilität** je Template und **jedem** unterstützten
    Timeframe: deterministische Positiv-Fixture (mindestens ein Entry — kein
    totes Template, inkl. Long-only- und Trade-Zählungs-Invarianten) und
    Kurzhistorie-Fixture, in der ein tragendes Feld `null` ist — jede bewertete
    Kerze bleibt fail-closed, `backtestRule` erzeugt keinen Entry; der
    Kontroll-Snapshot zeigt, dass nur die fehlenden Lesewerte blockieren.
  * **Negativ-Fixtures:** Jede einzelne Bedingung ist tragend (ein um ein Feld
    verletzter Snapshot feuert nicht), jedes nullable Bedingungsfeld blockiert
    als `null` fail-closed, der Schwellwert am **Raster-Extremwert** blockiert
    am Serien-Fixture (`adxMin = 35`, `bbwMaxPct = 2`, `rsiOversold = 15`,
    `breakoutMinPct = 3`, `volumeRatioMin = 2.5`), und eine durchgängig
    verletzte Einzelbedingung (fallendes Volumen bzw. gespiegelte
    Abwärtsbewegung) erzeugt keinen Entry.
  * **Katalog-Integrität:** genau die sechs erwarteten IDs in
    `STRATEGY_TEMPLATE_IDS`/`STRATEGY_TEMPLATES`, keine Duplikate,
    `assertTemplatesValid()` läuft beim Import und beim Aufruf,
    `getTemplate("nicht-vorhanden") → null` (kein Wurf),
    `templateByField("bbZScore") → ["bollinger-squeeze"]`,
    `templateByField("donchianBreakoutPct") → ["donchian-breakout"]`.
  * **Engine ↔ Cache (Phase-2-Regression festgenagelt):** Für
    `bollinger-squeeze` und `donchian-breakout` liefern
    `buildSnapshotFromCandles` und `snapshotFromCache(buildIndicatorCache(...))`
    auf identischen Fixture-Kerzen **exakt gleiche** Werte für `bbZScore`,
    `priceVsUpperBbPct`, `priceVsLowerBbPct` und `donchianBreakoutPct` — ohne
    Toleranz; zusätzlich die Null-Semantik bei zu wenig Historie.
  * **Zeitrahmen-Disziplin (STX-01):** Templates mit `vwapPct` in
    `requiredFields` unterstützen weder `1d` noch `5d` und bleiben auf den
    VWAP-tauglichen Takten (`VWAP_PCT_RELIABLE_TIMEFRAMES`).
* **`scripts/gen-strategy-templates-doc.ts` + `npm run docs:templates`:** Der
  Generator projiziert `STRATEGY_TEMPLATES` (Klasse, Timeframes, Regimes,
  Version, Pflichtfelder, Bedingung, Parameterraster, Annahmen) in die Doku —
  reine Projektion, kein Netz, keine DB, kein `sanitizeRuleSpec`-Umweg.
* **`docs/STRATEGY_TEMPLATES.md` (generiert, 6 Templates):** Die Tabelle ist
  keine handgepflegte Kopie; der Vertragstest vergleicht sie **byteweise** mit
  der Renderer-Ausgabe, damit Doku und Katalog nicht auseinanderlaufen.

### Changed

* **Version `v0.7.6`** (Phase-3-Abschluss): `package.json`,
  `VERSION.md`, `README.md`, `docs/README.md`, `docs/CHANGELOG.md`-Stub und
  der Audit-Stand ziehen mit; die Phase-3-Abnahme ist damit ein eigener,
  einzeln rollbackbarer Release-Punkt.

### Notes

* **Keine neuen Templates, keine neue Fachlogik, keine Migration.** Die
  sechs Artefakte, ihre Bedingungen und ihre Raster bleiben unverändert; die
  Tests prüfen sie nur. Ein rotes Ergebnis wäre ein Template- oder
  Engine-Befund gewesen, kein Testfehler — es gab keinen.
* Damit ist Gate **G3** („03-10 grün: 6 Templates vertraglich abgesichert“)
  erfüllt; als Nächstes folgt Phase 4 mit 04-01 (Persistenz).

## [0.7.5] — Compiler: Template + Params → RuleSpec, mit Sanitize-Nachweis (STX-03-09) (2026-10-01)

> **Status: Beta, nicht produktionsreif.** Der sicherheitskritische Übergang der
> Phase 3 ist geschlossen: `src/strategies/compiler.ts` ist der **einzige**
> Aufrufer von `buildRule()` und leitet jede Rohform zwingend durch
> `sanitizeRuleSpec()`. **Keine** Änderung an `ruleEngine.ts`, `sanitizeRuleSpec`,
> `compileRuleSpec`, `RULE_CEILINGS` oder `RULE_FIELDS`; **keine** Migration,
> **kein** DB-Schreibpfad (Persistenz ist 04-02), keine LLM-/Prompt-Logik. Die
> Auslieferung erfolgt als eigenes Release, obwohl `VERSIONING.md` 03-09
> ursprünglich in ein Template-Release falten wollte: Der Übergang ist
> sicherheitskritisch genug für einen eigenen, einzeln rollbackbaren
> Release-Punkt. Phase-3-Abnahme über 03-10 bleibt offen.

### Added

* **Strategie-Compiler `src/strategies/compiler.ts`** (STX-03-09, Finding STX-05):
  `compileTemplate({ templateId, symbol, timeframe, params?, codeVersion? })`
  liefert `{ ok: true; spec; strategyClass; fingerprint; clamped; warnings }`
  oder `{ ok: false; errors; clamped }` — Fehler sind **Strings**, nie Würfe.
  * **Die Reihenfolge ist Teil des Vertrags** (Schritte 1–10 des Prompts, keiner
    zusammengefasst): Template via `getTemplate(id)` auflösen (unbekannt ⇒
    Fehler) → `class === "unclassified"` ablehnen (ADR-008) → `timeframe ∈
    template.supportedTimeframes` → Parametervalidierung → `buildRule(params)` im
    `try` → Builder-Ausgabe erneut prüfen → Aufrufer-Werte einsetzen →
    **`sanitizeRuleSpec()`** → `sourceRole` (nie `MANUAL`) →
    `ruleWithinRuntimeLimits()`.
  * **Kein Rückfall auf die Rohform:** Ist das Sanitize-Ergebnis `{ok:false}`,
    gibt der Compiler `{ok:false}` zurück — es gibt keine zweite
    Konstruktionsstelle einer `RuleSpec`. Ein Test ersetzt den Sanitizer durch
    einen Sentinel und beweist, dass genau dessen `spec`-Objekt zurückkommt.
  * **`clamped: string[]`** macht die Klemmung sichtbar („`action.stopLossPct:
    999 → 20`“, Feld, Rohwert, Klemmwert) statt eines stillen Erfolgs; erfasst
    `stopLossPct`, `takeProfitRR`, `riskBudgetPct`, `maxPositionPct`,
    `maxExecutionsPerDay`, `cooldownMinutes`, `volumeWindow` und `riskScore`.
    03-10 und 06-01 können daran erkennen, ob ein Template dauerhaft klemmt.
  * **`fingerprint`** = `stc1:<sha256>` über
    `canonicalJson({ templateId, version, params, timeframe, symbol, codeVersion })`
    (Muster: `strategyLifecycle/evidence.ts`): sortierte Keys, kein `Date.now()`,
    kein Zufall — stabil über Prozessgrenzen, der Schlüssel für Idempotenz (04-02)
    und Cache (05-04). Parameter-Reihenfolge ist bedeutungslos, `codeVersion`
    (Default `APP_VERSION`) nicht.
  * **`strategyClass` ist immer `template.class`** (ADR-008) — genau eine
    Klassenquelle; `unclassified` wird zur Laufzeit abgelehnt. Getestet für alle
    sechs Templates inkl. `regimeGateFactor(regime, class)` über alle fünf Regime
    und `DEFAULT_CLASS_POLICIES[class]`.
  * **`exportTemplates(symbol?)`** kompiliert alle Katalog-Templates mit
    Default-Params über alle `supportedTimeframes` zu einer flachen Liste
    (Template × Takt) — ohne DB, ohne Netz, ohne Mutation.
  * **Laufzeit-Limits sind Warnungen, keine Compile-Fehler.** `getLimits()` liefert
    marktabhängige Limits (Basis-Limit × Regime-/VolTarget-/Drawdown-Faktor); sie
    dürfen das Ergebnis nicht bestimmen, sonst wäre der Fingerprint nicht
    prozessstabil und die Werkseinstellung (`takeProfitRR = 1.5` bei
    Template-Defaults bis 2,5) würde fünf der sechs Templates dauerhaft
    blockieren. Die Einhaltung wird deshalb als `warnings` ausgewiesen und im
    Ausführungspfad erzwungen (`riskGateRule` im Makro-Zyklus, Sizing/
    `validateOrder` bei der Order).
  * **`requiredFields`-Deckung mit abgeleiteter Dokumentations-Ausnahme:**
    Pflichtfelder müssen im Builder-Ergebnis als Bedingungsfeld vorkommen; die
    Felder, die **kein** Katalog-Template filtert (`atrPct`, Risikodoku für
    Stop/Ziel), sind ausgenommen — abgeleitet aus dem Katalog, nicht hartcodiert.
* **Pflicht-Beweis `tests/strategies.compiler.security.test.ts`** (26 Tests):
  Sanitize-Aufruf per Spy + Sentinel-Identität + Fehlerrückgabe; Klemmung
  `stopLossPct: 999` ⇒ Ceiling und gefülltes `clamped`; unbekanntes Feld
  (`field: "oracle"`) ⇒ `{ok:false}`; fremder Operator (`op: "exec"`) ⇒
  `{ok:false}`; `action.side: "SHORT"` ⇒ `{ok:false}`; entferntes `adx14` ⇒
  `{ok:false}` mit `requiredFields`-Fehler; Fingerprint-Stabilität inkl.
  Reihenfolge-Unabhängigkeit und „andere `APP_VERSION` ⇒ anderer Fingerprint“;
  ROLLOUT: `exportTemplates()` ⇒ 6 Templates über alle Takte, alle `ok:true`,
  alle ohne `clamped`; `{ok:false}`-Fälle (fremde ID, `unclassified`, fremder
  Takt, unbekannter Parameter, werfender Builder, ungültiges Symbol) liefern
  Fehlerstrings statt Exceptions; `sourceRole` „CEO“ bleibt, `MANUAL` wird
  `RESEARCH`.

### Changed

* **Doku:** [`docs/architecture/STRATEGY_STACK.md`](docs/architecture/STRATEGY_STACK.md)
  beschreibt die Compiler-Kette als §1.2 und führt `src/strategies/compiler.ts`
  nicht mehr als Lücke; `docs:validate` prüft die Versions-Konsistenz
  (`package.json` ↔ Changelog ↔ Status-Header ↔ `docs/README.md`).

### Ausdrücklich nicht geändert

* `src/lib/ruleEngine.ts` ist **unverändert** (Diff leer) — `sanitizeRuleSpec`,
  `compileRuleSpec`, `RULE_CEILINGS` und `RULE_FIELDS` bleiben die alleinige
  Sicherheitsgrenze. Der Compiler liest sie nur.
* Kein Schreiben in die Datenbank, kein Netzwerkzugriff: `exportTemplates()`
  läuft DB-frei (der `ruleService`-Import zieht wegen dessen Lazy-DB-Init
  keine Verbindung).
* Die sechs Templates und ihre Parametergrenzen bleiben unangetastet; der
  Compiler ändert kein Artefakt, er liest es durch den Sicherheitspfad.

## [0.7.4] — Templates Bollinger Squeeze, VWAP-Bias & Donchian Breakout (STX-03-06/03-07/03-08) (2026-10-01)

> **Status: Beta, nicht produktionsreif.** Drei additive Strategie-Artefakte mit
> je eigenem Test; **keine** Migration, keine Änderung an `ruleEngine.ts`,
> `RULE_CEILINGS`, `RULE_FIELDS`, `marketRegime.ts`, `indicators.ts` oder am
> Indikator-Cache. Die sechs geplanten Templates sind damit vollständig gebaut;
> die Abnahme über Compiler (03-09) und Template-Vertragstests (03-10) bleibt
> offen. Geplant waren je Template eigene Releases (`v0.7.4`/`v0.7.5`/`v0.7.6`);
> ausgeliefert werden sie als **ein** Release, weil ein Versions-Bump pro PR
> gilt und die drei Artefakte zusammen abgenommen werden — die unabhängige
> Prüfbarkeit bleibt über die je eigene Testdatei erhalten.

### Added

* **Viertes Strategie-Template: Bollinger Squeeze Breakout** (STX-03-06,
  `src/strategies/templates/bollinger-squeeze.ts`) — `class: "breakout"`,
  `version: 1`, `scope: "SINGLE_SYMBOL"`, Timeframes `1h`/`4h`, erwartete Regime
  `RANGE`/`TREND_UP`; einmalig an vierter Stelle im import-validierten Katalog.
  * `logic: "all"`: `bbwPct lte bbwMaxPct`, `bbZScore gte bbZScoreMin`,
    `adx14 gte adxMin`, `volumeRatio gte volumeRatioMin`. Sechs Parameter,
    Defaults 6 % / 0,5 σ / 22 / 1,2× / 4 % Stop / 2,5× Chance/Risiko;
    der ganze Parameterraum liegt innerhalb der bestehenden Risiko-Deckel.
  * **Kalibrierung ausstehend:** `bbwMaxPct` ist markt-, timeframe- und
    regimeabhängig. Die 6 % sind ein vorläufiger Research-Startwert, keine
    behauptete Messung. 06-01/06-02 prüft die 20. Perzentile über 200 geschlossene
    Kerzen gegen den Store, `1h` und `4h` getrennt, vor Live-Einsatz.
  * **σ-Rechnung korrigiert gegenüber dem Auftrag:** Im bestehenden Feld gilt
    `z = (close − middle) / σ`; an `upper = middle + 2·σ` ist `z = 2`, nicht
    ungefähr 1,4. Der gewünschte Default 0,5 bleibt erhalten und bedeutet ein
    frühes Setup über der **Bandmitte**, keinen bestätigten oberen Kantenbruch.
    Kein zusätzlicher oder stiller Ersatzfilter auf `priceVsUpperBbPct`.
  * Sieben explizite Annahmen einschließlich Kontraktion/Expansion,
    Bandbreiten-Kalibrierung, Schlusskurs-/Live-Latenz, Kosten und bewusster
    **Snapshot-Vereinfachung** (alle Filter auf derselben Kerze, kein
    „vorher eng, jetzt weit“-Sequenznachweis).
  * `tests/strategies.bollingerSqueeze.test.ts` prüft Vertrag, Registrierung,
    `bbZScoreMin < 2`, die lebende σ-Rechnung, alle Parameter-Rasterpunkte und
    Grenzkombinationen ohne Sanitizer-Klemmung, inklusive Filtergrenzen und
    Fail-closed bei fehlenden Parametern, Warm-up oder σ = 0.
  * Keine Änderungen an Indikatoren, Cache, `RULE_FIELDS`, `RULE_CEILINGS` oder
    Regel-DSL; keine Migration oder neue Dependency.

* **Fünftes Strategie-Template: VWAP-Bias (Snapshot)** (STX-03-07,
  `src/strategies/templates/vwap-pullback.ts`) — trotz der stabilen ID
  `vwap-pullback` ausdrücklich **kein** Pullback/Reclaim, sondern ein
  zustandsloser Tages-Bias long; `class: "trend"`, `version: 1`,
  `scope: "SINGLE_SYMBOL"`, Timeframes `5m`/`15m`/`1h`,
  `expectedRegimes: ["TREND_UP"]`; einmalig an fünfter Stelle im
  import-validierten Katalog.
  * `logic: "all"`: `trend eq "UP"`, `vwapPct gte vwapMinPct` (0,10),
    `priceVsEma21Pct gte ema21BufferPct` (0,10), `volumeRatio gte volumeRatioMin`
    (1,1). Fenster `15m`, 3 Ausführungen/Tag, 120 Minuten Cooldown; Stop 3 %, Ziel
    2× Chance/Risiko. Fünf Parameter, der gesamte Bereich liegt innerhalb
    `RULE_CEILINGS`.
  * **`4h`/`1d` sind ausgeschlossen:** `vwapPct` hängt am UTC-Tagesanker
    (`utcDayAnchorMs`); auf `1d` enthält der Anker exakt eine Kerze (Wert `null`,
    nie 0), auf `4h` sind es pro UTC-Tag zu wenige, stark an den UTC-Grenzen
    hängende Beobachtungen. Die Eignungsmenge steht als
    `VWAP_PCT_RELIABLE_TIMEFRAMES` im Modul; die unterstützten Takte sind per
    Test eine Teilmenge davon.
  * **Der echte Pullback bleibt offen:** Er bräuchte die Sequenz
    „unter dem VWAP → zurück über dem VWAP" und damit Zustand im `MicroExecutor`
    (Lebensdauer, Stops, Cooldowns, `maxExecutionsPerDay`) — eigener Audit
    (STX-18), bewusst **kein** `RuleTrigger`/`CROSS`/`RECLAIM`.
  * Fünf Annahmen (DATA/MARKET/EXECUTION/COST) einschließlich
    UTC-Tag-statt-Börsensession, historischer VWAP ≠ Ausführungskurs,
    Intraday-Kosten und Snapshot-statt-Reclaim.
  * `tests/strategies.vwapPullback.test.ts` prüft Vertrag, Registrierung (fünfter
    Platz), die Timeframe-Teilmenge, das Parameterraster, die unveränderte
    Sanitize-Kette und die Fenster-/Risikowerte.
  * Keine Änderung an `sessionVwap`, `utcDayAnchorMs` oder der
    `vwapPct`-Berechnung; kein Zustand im `MicroExecutor`, keine Sequenz-Trigger.

* **Sechstes und letztes Strategie-Template: Donchian Breakout** (STX-03-08,
  `src/strategies/templates/donchian-breakout.ts`) — `class: "breakout"`,
  `version: 1`, `scope: "SINGLE_SYMBOL"`, `supportedTimeframes: ["1h", "4h"]`
  (Higher-Timeframe-only), `expectedRegimes: ["TREND_UP", "RANGE"]`; einmalig an
  sechster Stelle im import-validierten Katalog — `STRATEGY_TEMPLATES` führt
  damit alle sechs geplanten Templates.
  * `logic: "all"`: `donchianBreakoutPct gte breakoutMinPct`, `adx14 gte adxMin`,
    `volumeRatio gte volumeRatioMin`. Fünf Parameter, Defaults 0,3 % / 20 / 1,2× /
    5 % Stop / 2× Chance/Risiko; der gesamte Parameterraum liegt innerhalb der
    bestehenden Risiko-Deckel. `takeProfitRR` hat kein eigenes Regelfeld
    (`mapsTo: atrPct`, nur Risikodoku).
  * **Lookahead-Schutz aus 02-01/02-03 bleibt unangetastet:** `upper` stammt aus
    den **vorigen** 20 Kerzen (`DONCHIAN_ENTRY_PERIOD = 20`). `entryPeriod` ist
    kein Regelfeld und kein Template-Parameter — der Snapshot rechnet mit dem
    kanonischen Default aus 02-03. Will 06-02 eine andere Periode testen, braucht
    es dafür dann ein zusätzliches Feld; das ist als bewusste, dokumentierte
    Grenze festgehalten, nicht als stiller Parameter gebaut.
  * **Strukturkosten statt Parameterfehler:** Der Einstieg zum Schlusskurs nach
    dem Ausbruch kauft typischerweise am lokalen Hoch. Deshalb
    `maxExecutionsPerDay: 1` (dasselbe Breakout-Charset darf nicht mehrfach
    kaufen) und `cooldownMinutes: 720`; `window.timeframe: "1h"`.
    Präzisierung zum Auftrag: Das Raster setzt `takeProfitRR` mit 2 auf denselben
    Wert wie 03-03/03-04 — die strukturelle Aussage verbietet ein Anheben über
    die Trend-Werte, behauptet aber keine Differenz; 06-02 muss die realisierte
    Ausführung (Fill vs. Signalkurs) messen.
  * Sieben explizite Annahmen (MARKET/EXECUTION/DATA/COST) einschließlich
    Regime-Wechsel-These, lokaler-Hoch-Einstieg, Vor-Kerzen-Lookahead-Schutz,
    Spread am lokalen Hoch, ein Ausbruch pro Tag, entryPeriod-Grenze und
    fail-closed-Warm-up.
  * `tests/strategies.donchianBreakout.test.ts` prüft Vertrag, Registrierung
    (sechster Platz, sechs Templates), Higher-Timeframe-Beschränkung, das
    vollständige Parameterraster inklusive aller Rasterpunkte und 32
    Eckkombinationen ohne Sanitizer-Klemmung, die Annahmen, die
    Lookahead-Invariante (ein Intrabar-Spike der Signalkerze löst die Regel nicht
    aus) und fail-closed bei `null`-Readings.
  * Keine Änderung an `donchianChannel`/`donchianBreakoutPct`, `RULE_FIELDS`,
    `RULE_CEILINGS`, `ruleEngine.ts` oder `indicators.ts`; kein
    `entryPeriod`-Regelfeld, keine Short-Variante, keine Migration.

## [0.7.3] — Template RSI Mean-Reversion (STX-03-05) (2026-10-01)

> **Status: Beta, nicht produktionsreif.** Ein additives Strategie-Artefakt mit
> eigenem Test; **keine** Migration, keine Änderung an `ruleEngine.ts`,
> `RULE_CEILINGS`, `RULE_FIELDS`, `marketRegime.ts` oder `indicators.ts`.

### Added

* **Drittes Strategie-Template: RSI Mean-Reversion** (`src/strategies/templates/rsi-mean-reversion.ts`,
  STX-03-05, Phase 3) — das **erste Artefakt mit `class: "mean-reversion"`** und damit der
  Testfall, ob ADR-E1 (ADR-008) trägt: Erst diese Klasse wird im Regime-Gate tatsächlich
  gedämpft (`TREND_UP`/`TREND_DOWN` Faktor **0.5**, `RANGE` **1** — gelesen aus
  `DEFAULT_MARKET_REGIME_CONFIG.gateFactors`, nicht gesetzt). Auch dieses Template braucht
  nichts Neues: `rsi14`, `priceVsEma21Pct`, `adx14`, `volumeRatio` und `atrPct` stehen
  längst im Snapshot.
  * `buildRsiMeanReversion()` liefert ein `StrategyTemplate` (`class: "mean-reversion"`,
    `version: 1`, `scope: "SINGLE_SYMBOL"`, `supportedTimeframes: ["15m", "1h", "4h"]`,
    `expectedRegimes: ["RANGE"]`); `STRATEGY_TEMPLATES` führt den Eintrag an dritter
    Stelle (Roadmap-Reihenfolge) und validiert ihn **beim Import**.
  * Die Regel: `condition.logic = "all"` über vier Bedingungen — `rsi14 lte rsiOversold`,
    `priceVsEma21Pct lte -ema21GapPct`, **`adx14 lte adxMax`** und `volumeRatio gte
    volumeRatioMin`. Action und Fenster wie 03-03/03-04 (`side LONG` über
    `RULE_ALLOWED_SIDE`, `riskBudgetPct 0.01`, `maxPositionPct 0.15`, `1h`, 2
    Ausführungen/Tag, 240 min Abklingzeit), dazu `sourceRole: "RESEARCH"`,
    `missionId: null`, `riskScore: 0.5` und ein deutschsprachiges, parametergeprägtes
    `rationale`.
  * **`adx14` ist hier ein Deckel (`lte`), kein Boden** — der load-bearing Unterschied zur
    Trendfolge: Ohne diesen Filter ist das Template kein Mean-Reversion-, sondern ein
    „Catching the falling knife"-System (in einer monoton fallenden Reihe stehen RSI(14)
    bei ~0 und der Kurs weit unter dem EMA 21 — nur der ADX hält die Regel zurück). Der
    Test hält den Operator über das **ganze** Raster fest und kontrastiert ihn mit
    `gte` in 03-03/03-04.
  * Sechs Parameter mit `step` als Sensitivitätsraster (06-02): `rsiOversold` 30
    (15…40, Schritt 1), `ema21GapPct` 1.0 (0.3…5, Schritt 0.1 — in der Regel negiert,
    weil `priceVsEma21Pct` das Vorzeichen trägt), `adxMax` 20 (10…30, Schritt 1),
    `volumeRatioMin` 1.1 (0.8…2.5, Schritt 0.05), `stopLossPct` 5 (1…15, Schritt 0.5),
    `takeProfitRR` **1.5** (1…4, Schritt 0.25). Der **gesamte** Bereich liegt innerhalb
    `RULE_CEILINGS` — kein Rasterpunkt wird je geklemmt.
  * Warum `takeProfitRR` hier **1.5** statt 2 ist: Mean-Reversion hat das begrenzte Ziel
    (Rückkehr zum Mittel) und die schlechtere Trefferquote; das kleinere
    Chance/Risiko-Verhältnis kompensiert das Odds-Ratio. Dasselbe Argument trägt die
    eigene Decay-Policy der Klasse (Halbwertszeit 4 h statt 24 h bei `trend`).
  * Sieben `assumptions` (06-01), drei davon `critical: true`: REGIME „funktioniert in
    RANGE; in TREND_UP/TREND_DOWN greift nur das Regime-Gate", COST „höhere
    Turnover-Rate ⇒ Gebühren-/Slippage-Annahme besonders lastend", DATA „RSI(14) braucht
    15 Schlusskurse" — plus MARKET („überverkauft ist keine Bodenbildung", EMA 21 als
    Mittel), DATA (ADX-Warm-up 29 Kerzen) und EXECUTION (Fill in der Signalkerze,
    adverse Selection).
  * **Bewusst nicht getan** (Sperren des Prompts): **kein `bbZScore`** — der Z-Score ist
    normalisiert und damit die bessere Überdehnungs-Metrik, braucht aber
    `bollingerBands` (STX-02-02); dieses Template ist so gebaut, dass es **vor** 02-02
    funktioniert, und das Bollinger-Template 03-06 ist der Ort der Lage-Metrik (die
    Reihenfolge-Abhängigkeit steht im Kopf, eine Nachrüstung wäre eine
    **Versionserhöhung**). Kein `SHORT` (Mean-Reversion wäre short-seitig die
    natürlichere Variante — eigener Audit), **keine Regime-Gate-Änderung** (das Template
    nutzt es nur), keine Änderung an `rsi` in `indicators.ts` — und unverändert:
    `ruleEngine.ts`, `RULE_CEILINGS`, `RULE_FIELDS`, `marketRegime.ts`.
  * **Tests:** `tests/strategies.rsiMeanReversion.test.ts` (66 Fälle) — Vertrag,
    Prompt-Treue Zeile für Zeile, Klemmfreiheit über **jedem** Rasterpunkt
    (`validateTemplate` + `sanitizeRuleSpec` im Verbund), der ADX-Operator-Grep über
    Builder-Output **und** Quelltext (mit Kontrast zu 03-03/03-04), die
    ADR-008-Invarianten (`class !== "unclassified"`,
    `regimeGateFactor("TREND_UP", …) < 1`, `regimeGateFactor("RANGE", …) === 1`,
    Gate-Faktoren vor/nach jedem Aufruf unverändert) und die Semantik über den echten
    Snapshot-Pfad: Range-Abverkauf löst aus, die monoton fallende Reihe **nicht** (nur
    der ADX-Filter bremst — mit `adx14 = 15` auf demselben Snapshot würde sie
    auslösen), flache Range nicht. Dazu die RSI-Warm-up-Falle: `rsi()` liefert unter 15
    Schlusskursen nicht `null`, sondern **50** — der gesamte `rsiOversold`-Bereich
    (≤ 40) liegt darunter, die Regel kann also nie auf dem Ersatzwert handeln.

## [0.7.2] — Template MACD Momentum (STX-03-04) (2026-10-01)

> **Status: Beta, nicht produktionsreif.** Ein additives Strategie-Artefakt mit
> eigenem Test; **keine** Migration, keine Engine-Änderung.

### Added

* **Zweites Strategie-Template: MACD Momentum** (`src/strategies/templates/macd-momentum.ts`,
  STX-03-04, Phase 3) — das **Referenztemplate für 06-02 (Overfit)**: die
  wenigsten Parameter (vier) und die klarste Ökonomie. Auch dieses Artefakt
  braucht nichts Neues — `macdHist`, `priceVsEma50Pct` und `adx14` stehen längst
  im Snapshot.
  * `buildMacdMomentum()` liefert ein `StrategyTemplate` (`class: "trend"` nach
    ADR-008, `version: 1`, `scope: "SINGLE_SYMBOL"`, `supportedTimeframes:
    ["1h", "4h"]`, `requiredFields: macdHist | priceVsEma50Pct | adx14 | atrPct`);
    `STRATEGY_TEMPLATES` führt den Eintrag an zweiter Stelle (Roadmap-Reihenfolge)
    und validiert ihn **beim Import**.
  * Die Regel: `condition.logic = "all"` über drei Bedingungen — `macdHist gt 0`,
    `priceVsEma50Pct gt ema50BufferPct` (strikt: „über EMA 50“, nicht „auf
    EMA 50“), `adx14 gte adxMin`. Action und Fenster wie 03-03 (`side LONG` über
    `RULE_ALLOWED_SIDE`, `stopLossPct`, `takeProfitRR`, `riskBudgetPct 0.01`,
    `maxPositionPct 0.15`, `1h`, 2 Ausführungen/Tag, 240 min Abklingzeit), dazu
    `sourceRole: "RESEARCH"`, `missionId: null`, `riskScore: 0.5` und ein
    deutschsprachiges, parametergeprägtes `rationale`.
  * **Keine Magnitude-Bedingung auf `macdHist`** — die wichtigste Aussage des
    Files: `macdHist` ist `macd − signal` in **Preiseinheiten**, ein Schwellwert
    `macdHist > X` mit `X > 0` ist deshalb **nicht** marktübergreifend (dieselbe
    `0.5` bedeutet für BTC etwas anderes als für einen 5-stelligen Aktienkurs —
    die Verwechslung von Momentum und Volatilität, die die Analyse prüft). Die
    einzige Bedingung auf dem Feld ist `gt 0` (das Vorzeichen ist skalenfrei);
    der skalenfreie Ersatz für jede Stärkefrage ist `priceVsEma50Pct` (Prozent).
    Ein Test greppt den Builder-Output über das **ganze** Parameterraster: genau
    eine `macdHist`-Bedingung, und sie ist `gt 0`.
  * Vier Parameter mit `step` als Sensitivitätsraster (06-02): `adxMin` 20
    (14…35, Schritt 1), `ema50BufferPct` 0.0 (−1…3, Schritt 0.1 — `min` bewusst
    negativ, damit 06-02 den frühen Impuls auch **unter** dem EMA 50 messen
    kann), `stopLossPct` 4 (1…12, Schritt 0.5), `takeProfitRR` 2 (1…4,
    Schritt 0.25). Der **gesamte** Bereich liegt innerhalb `RULE_CEILINGS`
    (`stopLossPct [0.5, 20]`, `takeProfitRR [0.5, 5]`, aus `LIMIT_CEILINGS`
    abgeleitet) — kein Rasterpunkt wird je geklemmt.
  * Sechs `assumptions` (06-01) mit `category` und `critical`: MARKET „das
    Histogramm-Vorzeichen dreht vor dem Trend“ (nicht kritisch); MARKET
    **kritisch** „`macdHist` wird ausdrücklich nicht als Stärke-Metrik
    verwendet“ (Preiseinheiten, nicht skalenfrei); DATA **kritisch**
    „MACD(12/26/9) braucht 35 Schlusskurse, darunter `null`“ (`slow 26 + signal 9`);
    COST „häufige Histogramm-Wechsel werden durch Cooldown und Tageslimit
    gedämpft“; dazu REGIME (`TREND_UP`) und eine zweite DATA-Annahme zur
    EMA-50-Warm-up-Falle. `expectedRegimes: ["TREND_UP"]` — ohne `UNKNOWN`
    (ADR-009).
  * **Bewusst nicht getan** (Sperren des Prompts): kein `SHORT` (die negative
    MACD-Variante bräuchte einen `side`-Wert, den die Engine nicht kennt), keine
    Bedingung auf `macd`/`macdSignal` (dieselbe Preiseinheiten-Falle), kein
    `bbZScore` (03-06), keine Sequenz-/Reclaim-Logik, kein Backtest-Lauf (03-10)
    — und unverändert: `indicators.ts`, `ruleEngine.ts`, `RULE_CEILINGS`,
    `RULE_FIELDS`.
  * **Tests:** `tests/strategies.macdMomentum.test.ts` (56 Fälle) — Vertrag,
    Prompt-Treue Zeile für Zeile, Klemmfreiheit über **jedem** Rasterpunkt
    (`validateTemplate` + `sanitizeRuleSpec` im Verbund), der Magnitude-Grep über
    Builder-Output **und** Quelltext, Reinheit/Determinismus und die Semantik
    über den echten Snapshot-Pfad: Aufwärtstrend ab 35 Kerzen löst aus, bei 34
    Kerzen schweigt die Regel (`macdHist = null`, fail-closed — obwohl ADX und
    EMA-50-Abstand längst erfüllt wären), Seitwärtsphase nicht (Histogramm exakt
    0, `gt` nicht `gte`), und in der fallenden Reihe trägt allein
    `priceVsEma50Pct` die Ablehnung. Dazu die neuen Kopf-Invarianten:
    `histogram = macd − signal` (Preiseinheiten) und `macdHist` im Snapshot
    unskaliert (nur auf 6 Stellen gerundet).

## [0.7.1] — Template EMA/ADX Trend (STX-03-03) (2026-10-01)

> **Status: Beta, nicht produktionsreif.** Das erste Artefakt im neuen Katalog;
> additiv, **keine** Migration, keine Engine-Änderung. Die Abnahme über den
> Compiler (03-09) und die Template-Tests (03-10) folgt.

### Added

* **Erstes Strategie-Template: EMA/ADX Trend** (`src/strategies/templates/ema-adx-trend.ts`,
  STX-03-03, Phase 3) — der Katalog ist keine leere Registry mehr. Das Artefakt
  braucht genau nichts Neues: keine Felder, keine Indikatoren, keine
  Engine-Änderung. Damit ist STX-18 auch praktisch beantwortet (bestätigt:
  `RuleSpec` trägt Templates).
  * `buildEmaAdxTrend()` liefert ein `StrategyTemplate` (`class: "trend"` nach
    ADR-008, `version: 1`, `scope: "SINGLE_SYMBOL"`, `supportedTimeframes:
    ["1h", "4h"]`, `requiredFields: trend | priceVsEma50Pct | adx14 |
    volumeRatio | atrPct`); `STRATEGY_TEMPLATES` nimmt den Eintrag auf und
    validiert ihn **beim Import** (`assertTemplatesValid()`).
  * Die Regel: `condition.logic = "all"` über vier Bedingungen — `trend eq "UP"`,
    `priceVsEma50Pct gte ema50BufferPct`, `adx14 gte adxMin`, `volumeRatio gte
    volumeRatioMin`. Action: `side LONG` (über `RULE_ALLOWED_SIDE`, nicht als
    abgeschriebenes Literal), `stopLossPct`, `takeProfitRR`, `riskBudgetPct
    0.01`, `maxPositionPct 0.15`, `positionSizeMode "risk"`. Fenster: `1h`, 2
    Ausführungen/Tag, 240 min Abklingzeit, 20-Kerzen-Volumenfenster. Dazu
    `sourceRole: "RESEARCH"`, `missionId: null`, `riskScore: 0.5` und ein
    deutschsprachiges, parametergeprägtes `rationale`.
  * **`symbol` ist Pflicht des Aufrufers, nicht des Builders**: Die Rohform hat
    bewusst kein Symbol; der Compiler (03-09) setzt es vor `sanitizeRuleSpec()`.
    Ohne Symbol bleibt die Rohform eine Rohform — `sanitizeRuleSpec` lehnt ab,
    statt einen Markt zu erfinden.
  * Fünf Parameter mit `step` als Sensitivitätsraster (06-02): `adxMin` 22
    (15…35, Schritt 1), `ema50BufferPct` 0.2 (0…3, Schritt 0.1), `volumeRatioMin`
    1.0 (0.8…2.0, Schritt 0.05), `stopLossPct` 4 (1…12, Schritt 0.5),
    `takeProfitRR` 2 (1…4, Schritt 0.25). Der **gesamte** Bereich liegt innerhalb
    `RULE_CEILINGS` (`stopLossPct [0.5, 20]`, `takeProfitRR [0.5, 5]`, aus
    `LIMIT_CEILINGS` abgeleitet) — kein Rasterpunkt wird je geklemmt, sonst
    messen die Sweeps die Klemmung statt der Edge.
  * Zwei fachliche Grenzen im Kopf der Datei, beide am Code festgemacht:
    `1m`/`5m` sind ausgeschlossen, weil `adx()` 29 Kerzen verlangt
    (`2 * period + 1`) und eine Trendreihenfolge über 29 Fünf-Minuten-Kerzen ein
    anderes Maß ist als über 29 Stunden; `ema50BufferPct` muss über der
    `trend`-Hysterese liegen (`|EMA9 − EMA21| / price ≥ 0.001`, also 0,1 % —
    sonst filtert die Bedingung nichts, was `trend` nicht schon gefiltert hätte).
    Der Default (0,2 %) ist die Invariante, `min: 0` bleibt messbar.
  * Fünf `assumptions` (06-01) mit `category` und `critical`: MARKET, DATA
    (**kritisch**: ohne ADX kein Trend — `adx14` ist `null`, die Bedingung
    scheitert fail-closed), COST, REGIME (`TREND_UP`; in RANGE degradiert die
    ADX-Bedingung) und eine zweite DATA-Annahme zur EMA-50-Warm-up-Falle
    (`buildSnapshotFromCandles` rechnet `min(50, Kerzenzahl)`).
    `expectedRegimes: ["TREND_UP"]` — ohne `UNKNOWN` (ADR-009).
  * **Bewusst nicht getan** (Sperren des Prompts): kein `SHORT`, kein `vwapPct`
    (Tagesanker auf `1h` nicht belastbar, STX-01), keine Sequenz-/Reclaim-Logik,
    kein ATR-skalierter Stop, kein Backtest-Lauf (03-10) — und unverändert:
    `ruleEngine.ts`, `RULE_CEILINGS`, `indicators.ts`.
* **Tests:** `tests/strategies.emaAdxTrend.test.ts` (47 Fälle) — Vertrag,
  Prompt-Treue Zeile für Zeile, Klemmfreiheit über **jedem** Rasterpunkt
  (`validateTemplate` + `sanitizeRuleSpec` im Verbund), der Nachweis, dass
  `adxMin: 99` in `validateTemplate` scheitert und den Sanitizer
  **unbehelligt** ließe (kein Deckel auf `adx14`), Reinheit/Determinismus,
  Statik-Wächter für die Doku-Pflichten und die Sperren. Dazu Semantik über den
  echten Snapshot-Pfad: Aufwärtstrend löst aus, unter 29 Kerzen nicht
  (`adx14 = null`, fail-closed), Seitwärtsphase nicht, Volumenschwäche nicht, und
  die Margin-Kerze zwischen 0 und 0,2 % genau dann, wenn der Buffer auf `min`
  steht.
* `tests/strategies.catalog.test.ts`: Die Registry-Prüfung vergleicht
  `STRATEGY_TEMPLATES` jetzt mit dem Verzeichnis
  `src/strategies/templates/` statt eine leere Liste zu erwarten — eine fehlende
  oder doppelte Registrierung ist damit ein Testfehler, und 03-04 … 03-08 ziehen
  den Test nicht mehr nach.

## [0.7.0] — Template-Vertrag und Katalog (STX-03-01/03-02) (2026-10-01)

> **Status: Beta, nicht produktionsreif.** Neue, additive Domäne
> `src/strategies/` (reine Typen + Registry mit Import-Zeit-Validierung);
> **keine** Migration, keine Änderung an `ruleEngine.ts` oder `RULE_FIELDS`.

### Added

* **Template-Vertrag** (`src/strategies/types.ts`, STX-03-01, Phase 3) — die
  verbindliche Form eines Strategie-Artefakts: `StrategyTemplate` mit `id`,
  `name`, `description`, `version`, `class` (Pflicht, aus dem **bestehenden**
  `StrategyClassKey`, ADR-008), `scope` (nur `SINGLE_SYMBOL`, ADR-010),
  `supportedTimeframes` (aus `SUPPORTED_TIMEFRAMES`), `requiredFields`
  (Whitelist `RULE_FIELDS`), `params` (`ParamSpec` mit `min ≤ default ≤ max`,
  `step` als Sensitivitätsraster und `mapsTo`), `buildRule(params) =>
  RuleSpecInput` als **reine Funktion der Parameter** (STX-05: kein `ctx`, kein
  Marktdatenzugriff), `assumptions` (`StrategyAssumption` mit `category` und
  `critical`) und `expectedRegimes` (bestehendes `MarketRegime`-Vokabular, ohne
  `UNKNOWN`, ADR-009). Reine Typen: ausschließlich `import type`, keine Logik,
  keine IO, kein DB-Import — das Modul erzeugt zur Laufzeit null Bytes.

* **Template-Katalog + Registry-Validierung** (`src/strategies/catalog.ts`,
  STX-03-02, Phase 3) — der Katalog prüft Templates **beim Import**, nicht erst
  beim Backtest. Der gesamte Sicherheitswert hängt daran, dass eine kaputte
  Strategie früher stirbt als eine kaputte Order.
  * `STRATEGY_TEMPLATE_IDS` als **geschlossene Union** der sechs geplanten IDs
    (`ema-adx-trend`, `macd-momentum`, `rsi-mean-reversion`,
    `bollinger-squeeze`, `vwap-pullback`, `donchian-breakout`) plus
    `StrategyTemplateId`, `isStrategyTemplateId()` und
    `STRATEGY_TEMPLATE_ID_RE`. Die Templates selbst kommen in 03-03 … 03-08;
    `STRATEGY_TEMPLATES` ist hier noch leer, aber bereits validiert.
  * `validateTemplate(t)` liefert **fail-closed** eine Fehlerliste (leer =
    gültig) über: ID-Format, Version (Ganzzahl ≥ 1), Klasse (in
    `STRATEGY_CLASS_KEYS` **und** ungleich `unclassified`, ADR-008), Timeframes
    (Allowlist, nicht leer, eindeutig), `requiredFields` (Whitelist), Params
    (`min ≤ default ≤ max`, `step > 0`, eindeutiger `key`), `mapsTo`,
    Assumptions (eindeutige ID, nicht leerer `statement`) und
    `expectedRegimes` (genau die fünf `MarketRegime`, **ohne `UNKNOWN`** —
    ADR-009).
  * Der Builder wird als **reine Funktion der Parameter** geprüft (STX-05):
    zweimal `buildRule(defaults)` muss tiefengleich sein, die Rückgabe ein
    Objekt, jedes Bedingungs-`field` in `RULE_FIELDS`, `action.side`
    ausschließlich `LONG` und **kein** Zahlenwert außerhalb `RULE_CEILINGS`.
    Der Katalog liest die Deckel, er erweitert sie nicht — und er sanitized
    nichts: `sanitizeRuleSpec()` (03-09) bleibt Pflicht.
  * Lese-Helfer `getTemplate()`, `listTemplates()` und `templateByField()`
    („welches Template nutzt `bbwPct`?“) — eine SSoT für Workshop-UI, CLI und
    Tests.
  * **Import-Zeit-Wächter:** `assertTemplatesValid()` läuft beim Modul-Import
    und wirft bei einem ungültigen Template; ein kaputtes Template lässt den
    Prozess nicht starten. Zusätzlich eine Canary gegen einen absichtlich
    kaputten `__fixtures`-Fall — der Validator muss ihn beanstanden (sonst ist
    er fail-open) und die gültige Fixture durchlassen (sonst überstreng).
  * **Tests:** `tests/strategies.catalog.test.ts` mit 41 Negativfällen, je
    genau einem erwarteten Fehler, plus Deckel-Grenztests gegen die **lebenden**
    `RULE_CEILINGS` und Strukturwächtern (Fixtures nicht exportiert, kein
    zweites Klassen-/Regime-Vokabular, kein LLM-/DB-Pfad).

### Fixed

* **ADR-010-Wächter** (`tests/adrVocabulary.test.ts`): Der Guard „keine
  `MultiAssetStrategySpec` in `src/` und `scripts/`“ schlug seit 03-01 fehl —
  ausgelöst von einem **Doc-Kommentar** in `src/strategies/types.ts`, der die
  verworfene Spec beim Namen nannte. Der Kommentar verweist jetzt auf ADR-E3
  (ADR-010) statt auf das Token; der Wächter selbst ist unverändert
  vollstreng. `npm test` ist damit wieder grün.

## [0.6.5] — Donchian-Regelfeld (STX-02-03) (2026-09-30)

> **Status: Beta, nicht produktionsreif.** Ein additives Regel-Feld und ein rein
> additiv gepflegter Indikator-Cache; **keine** Migration, keine Änderung an
> bestehenden Feldern, Labels oder Werten, kein neues Verhalten ohne
> Donchian-Feld.

### Added

* **Regel-Feld `donchianBreakoutPct`** (`src/lib/ruleFieldCatalog.ts`,
  `src/lib/ruleEngine.ts`) — der letzte der sieben Strategie-Vorschläge, der
  ohne neues Feld nicht ausdrückbar war:
  * `(close / upper − 1) · 100`, wobei `upper` das **Donchian-Kanalhoch der
    vorigen 20 Kerzen** ist (`DONCHIAN_ENTRY_PERIOD`, ausdrücklich ohne die
    aktuelle Signalkerze — kein Look-ahead, STX-02-01). `> 0` = Ausbruch über
    den vorher bekannten Kanal; marktneutral, weil relativ.
  * Deutsche Labels mit Einheit im Text; der LLM-Hinweis in
    `RULE_FIELD_SCHEMA_HINTS` nennt Bezug, typische Werte und die
    `null`-Semantik (`Object.keys(RULE_FIELDS)` bleibt das Schema-`enum`).
  * `null` — nie eine erfundene 0 — unter 21 Kerzen (kein Kanal) oder bei
    `upper <= 0`. Eine echte `0` bleibt möglich und heißt „Schlusskurs exakt
    auf dem Kanalhoch“.
  * Die Fensterlänge ist **kein Regelfeld**: Sie gehört als Parameter in das
    Donchian-Template (03-08), nicht in den Snapshot — sonst bedeutete
    derselbe Feldwert je Strategie etwas anderes.
* **`donchianBreakoutPct(close, upper)`** in `src/lib/indicators.ts`: Formel und
  `null`-Semantik an genau einer Stelle, von beiden Snapshot-Pfaden genutzt.
  Dazu die kanonischen Fenster `DONCHIAN_ENTRY_PERIOD = 20` /
  `DONCHIAN_EXIT_PERIOD = 10` als Defaults von `donchianChannel` (Werte
  unverändert, nur benannt).
* **`indicatorCache`** wächst rein additiv um `donchianUpper`:
  `donchianUpperArray()` rechnet das laufende Kanalhoch mit einer monotonen
  Deque in **O(n)** vor (jeder Index wird einmal eingefügt und höchstens einmal
  entfernt) — bewusst **kein** `Math.max(...slice)` je Bar, das wäre O(n·20) und
  damit die STX-12-Regression im Backtest-Pfad. `snapshotFromCache` rundet auf
  dieselben 4 Dezimalstellen wie `buildSnapshotFromCandles`.
* **Tests:** Lookahead-Test (streng steigende Reihe: Wert erst ab der Kerze nach
  dem Kanalhoch, vorher `null`, nie 0), Ausbruchskerze gegen den vorigen Kanal,
  Bar-für-Bar-Parität Cache ↔ Direktpfad über drei Symbole, Engine-Parität
  Single-Rule ↔ Multi-Asset, `null`-Fälle, statischer O(n)-Beleg und Accessor/
  fail-closed-Prüfung (`tests/ruleEngine.test.ts`, `tests/indicators.test.ts`,
  `tests/backtest.multiAsset.test.ts`).

### Unverändert

* Bestehende Felder, Labels, Werte und Ceilings — der Golden-Test
  (`tests/backtest.multiAsset.test.ts`) belegt, dass Läufe ohne Donchian-Feld
  weiter byte-identisch sind (`fnv1a` `0uz3hqb`).

## [0.6.4] — Bollinger-Regelfelder (STX-02-02) (2026-09-30)

> **Status: Beta, nicht produktionsreif.** Additive Regel-Felder und ein additiv
> gepflegter Indikator-Cache; **keine** Migration, keine Änderung an bestehenden
> Feldern, Labels oder Werten, kein neues Verhalten ohne Bollinger-Feld.

### Added

* **Drei neue Regel-Felder** (`src/lib/ruleFieldCatalog.ts`, `src/lib/ruleEngine.ts`),
  alle marktneutral und damit über Kursniveaus hinweg vergleichbar:
  * `bbZScore` = `(close − middle) / σ` — Lage zur Bandmitte in
    Standardabweichungen (0 = Mitte, ±2 = Kante, typisch ±3).
  * `priceVsUpperBbPct` = `(close − upper) / close · 100` — Abstand zur oberen
    Kante in Prozent des Kurses; `> 0` ist der Ausbruch über die Kante.
  * `priceVsLowerBbPct` = `(close − lower) / close · 100` — Abstand zur unteren
    Kante; `< 0` ist der Ausbruch darunter.
  Bandparameter sind fest 20 Schlusskurse / 2 σ (Population), identisch zu `bbwPct`
  (`BOLLINGER_PERIOD`/`BOLLINGER_MULT`) — die Periode bleibt Snapshot-Definition,
  kein Regelfeld. Deutsche Labels mit Einheit im Text; `RULE_FIELD_SCHEMA_HINTS`
  liefert Einheiten und typische Werte für die `field`-Beschreibung im
  `RULE_LLM_SCHEMA` (Enum weiterhin `Object.keys(RULE_FIELDS)`).
* **`bollingerPosition(close, reading, mult)`** in `src/lib/indicators.ts`: die drei
  Werte an genau einer Stelle. σ wird aus der Bandgeometrie gelesen
  (`upper = middle + mult·σ`) statt zweimal aus der Varianz gerechnet.
* **`buildSnapshotFromCandles`** befüllt die Felder aus `bollingerBands(closes)`,
  gerundet auf die 4. Dezimalstelle wie `bbwPct`.
* **`indicatorCache`** wächst rein additiv um `bbZScore`, `priceVsUpperBbPct` und
  `priceVsLowerBbPct`: `bollingerPositionArrays()` rechnet sie in O(n) vor
  (festes 20er-Fenster je Bar), `snapshotFromCache` rundet wie der Direktpfad.
  Gemessen: +17 ms für 17 520 Stundenkerzen — der Cache bleibt linear.

### Fixed

* **STX-02-02 / STX-18 (Bollinger-Teil):** „Preis bricht die obere Bandkante“ ist
  regelformulierbar, ohne absolute Preise zu vergleichen. Vorher gab es nur
  `bbwPct` (Bandbreite) — die Lage im Band existierte im Regel-Vokabular nicht.
  Die Multi-Asset-Engine (liest aus dem Indikator-Cache) und der Single-Rule-Pfad
  (`buildSnapshotFromCandles`) liefern jetzt **identische** Feldwerte; vorher wäre
  ein nur im Direktpfad gepflegtes Feld im Portfolio-Backtest `null`/`undefined`
  gewesen.

### Documentation

* `docs/BACKTESTING.md` §1.2: Einheiten, `null`-Fälle und der Beispiel-Workflow
  **„Squeeze → Breakout“** inklusive der gemessenen Grenze, dass der Ausbruch das
  Band selbst weiter aufzieht (Squeeze-Schwelle mitdenken) und dass der
  Regel-Dialekt bewusst zustandslos bleibt (keine Sequenzen).
* `docs/ARCHITECTURE.md` §2.2 (Feld-Whitelist), `docs/MISSIONS.md` §4
  (Workshop-Dropdown + Beispielregel), `docs/architecture/STRATEGY_STACK.md`
  (Ist-Zustand) und die Audit-Doku auf 02-02 nachgezogen.

### Tests

* **Paritätstest** in `tests/backtest.multiAsset.test.ts`: Bar-für-Bar-Vergleich
  der drei Felder zwischen `buildSnapshotFromCandles` und `snapshotFromCache` über
  drei Symbole; eine `bbZScore`-Regel liefert über `backtestRule` und
  `runMultiAssetBacktest` dieselben Signal-Kerzen (18/18 Einstiege identisch).
* **Byte-Identität**: Golden-Hash (FNV-1a, 22 415 Zeichen) eines
  Multi-Asset-Laufs **ohne** Bollinger-Feld — unverändert gegenüber `v0.6.3`.
* **`null`-Fälle** in `tests/ruleEngine.test.ts` (zu wenig Kerzen, flache Reihe
  σ == 0, nicht-positive Mitte), Whitelist (unbekannte Felder wie `bbUpper`
  fliegen weiter), `sanitizeRuleSpec`-Akzeptanz + `RULE_CEILINGS`-Klemmung und
  Formel-/Geometrietests in `tests/indicators.test.ts`. Kein bestehender Test
  wurde angepasst, um grün zu werden; nur Snapshot-Fixtures wuchsen um die drei
  Pflichtfelder.

## [0.6.3] — Indikator-Grundlage (STX-02-01) (2026-09-30)

> **Status: Beta, nicht produktionsreif.** Additive pure Funktionen aus Phase 2;
> keine Rule-Felder, Cache-/Snapshot-Änderung, Migration oder ausführbaren Templates.

### Added

* `bollingerBands(closes, period = 20, mult = 2)` liefert `upper`, `middle`, `lower`,
  `width` und `bandwidthPct`. Bandbreite ist ein **Bruch** (0.05 = 5 %), Populations-σ
  und SMA wie bei der unveränderten Funktion `bollingerBandWidthPct`; fünf Fixtures
  beweisen exakte Parität. Die mathematisch äquivalente Formel `2·mult·σ/SMA` vermeidet
  Rundungsabweichung durch explizite Subtraktion der Bandlevel.
* `donchianChannel(candles, entryPeriod = 20, exitPeriod = 10)` liefert das Hoch der
  vorigen Entry-Kerzen und das Tief der vorigen Exit-Kerzen sowie deren Mitte.
  Die aktuelle Kerze wird **ausgeschlossen** (Lookahead-Schutz). Template 03-08
  muss einen Mindest-Timeframe für diese Higher-Timeframe-Logik festlegen.
* Parametergrenzen für LLM-Vorschläge: Bollinger 5…200/1…4, Donchian 5…200/3…100
  (Exit höchstens Entry); `null` bei unzureichenden oder nicht-berechenbaren Daten.
  Tests decken Randfälle, Klemmung, exakte BBW-Parität und steigenden Breakout ab.

### Fixed

* **Security-Audit:** transitive `brace-expansion`-Versionen im Lockfile auf
  `1.1.21` (über ESLint/minimatch) und `5.0.12` (über typescript-eslint/minimatch)
  aktualisiert. Damit sind die gemeldeten High-DoS-Advisories behoben;
  `npm audit --audit-level=high` meldet keine Schwachstellen. Keine Änderung
  an direkten Abhängigkeiten oder am Laufzeitcode.

### Documentation

* Version/Strategie-Stack, Root-/Docs-README und Audit-Tracking auf 02-01 nachgezogen.
  Die bislang bestehende BBW-Funktion sowie sämtliche bisherigen Indikatoren bleiben
  unverändert. Rule-Felder und IndicatorCache-Parität folgen erst in 02-02/02-03.

## [0.6.2] — Timeframe-Angleichung (STX-01) (2026-09-29)

> **Status: Beta — und bleibt Beta.** Prompt **01-01** der Strategie-Roadmap (Finding **STX-01**,
> Gate **G1**): Der Regel-Pfad trägt jetzt alle zehn `SUPPORTED_TIMEFRAMES` (`1m … 5d`), und der
> Mikro-Executor weist Regeln jenseits seines Ausführungsintervalls **fail-closed und sichtbar**
> ab. Regeln mit `1m … 1h` bleiben **byte-identisch** (Golden-Test gegen die Sanitize-Ausgabe des
> Stands `v0.6.1`, zusätzlich ein Differenzlauf über Snapshots und Backtests). Es gibt keine
> Migration und keine Schema-Änderung; `RULE_FIELDS`, `RuleAction`, `RULE_CEILINGS` und
> `RULE_ALLOWED_SIDE` sind unverändert — Shorts bleiben global gesperrt. `package.json` folgt dem
> Release-Plan [`VERSIONING.md`](docs/audits/2026-09-29-strategy-template-ausbau/VERSIONING.md) §2.

### Added

* **`src/lib/marketdata/timeframes.ts`:** das Timeframe-Vokabular (`SUPPORTED_TIMEFRAMES`,
  `SupportedTimeframe`, `SUPPORTED_TIMEFRAME_MS`, `isSupportedTimeframe`) als reine, client-sichere
  Datei ohne Imports. Der Historical Store re-exportiert alles unverändert — alle bestehenden Importe
  aus `historicalStore.ts` bleiben gültig. Grund für die eigene Datei: Regel-Engine und Workshop-UI
  dürfen `node:fs` (Store-Persistenz) nicht in ihren Import-Graphen ziehen (die Workshop-Komponenten
  liegen im Client-Bundle; `next build` ist grün).
* **`RULE_ALLOWED_TIMEFRAMES`** (`ruleEngine.ts`): aus `SUPPORTED_TIMEFRAMES` abgeleitet — kein zweites
  Vokabular. `sanitizeRuleSpec` und `RULE_LLM_SCHEMA` lesen genau diese Liste (ersetzt das private
  `ALLOWED_TIMEFRAMES` und das handgepflegte Enum im LLM-Schema).
* **Timeframe-Guard im Mikro-Executor (fail-closed, sichtbar):** Der Executor wertet eine Regel
  gegen den Snapshot ihres Timeframes inklusive der noch laufenden Kerze aus; für `2h`/`4h`/`1d`/`5d`
  wäre das ein teilweise abgelaufener Snapshot. Neu: `MicroExecutorOptions.executionInterval` (Default
  `1h` = bisheriges Maximum, `MICRO_EXECUTION_INTERVAL_DEFAULT`) und die reine Funktion
  `ruleTimeframeBlockReason` (`timeframe_exceeds_interval` | `timeframe_unsupported`). Eine
  abgewiesene Regel bekommt keine Serie und löst nie eine Order aus; das „Nein“ ist sichtbar:
  Counter `micro_executor_rule_blocked_total{reason,timeframe}` (Labels ohne Symbol/Regel-ID,
  Kardinalitätsregel), strukturiertes Log `micro_executor_rule_blocked` (je Regel einmal beim Start,
  nicht je Tick) und `ruleGuard` im Status des Executors (`GET /api/firm/micro` →
  `microProcess.ruleGuard`).
* **30 Tests, rein additiv (kein bestehender Test angepasst):**
  `tests/ruleEngine.test.ts` (+14: `4h`/`1d` akzeptiert, Fail-closed-Tabelle, **Golden-Test** für
  `1m|5m|15m|30m|1h`, Schema-Ableitung, Ceilings/LONG/Felder unverändert, `vwapPct === null` auf
  `1d`/`5d` und bei < 2 Kerzen am UTC-Tag, Engine-Pfad-Parität, `volumeWindow` auf `1d`, Guard-Test
  „`1d`-Regel auf 1m-Intervall → keine Order, genau ein Counter“),
  `tests/microExecutor.test.ts` (+11: 10×10-Matrix des Guards, Fail-closed bei unbekanntem Timeframe,
  Serien-Periode je Timeframe = kanonische Dauer, `3m`-Regression, Status, Konfiguration),
  `tests/marketdata/timeframes.test.ts` (4: Invarianten, Re-Export, Client-Sicherheit),
  `tests/ui/RuleBacktestPanel.test.tsx` (1: Workshop-Auswahl = Allowlist).

### Changed

* **`RuleWindow.timeframe` ist ein `SupportedTimeframe`** (vorher eine Union aus fünf Werten).
  `sanitizeRuleSpec` nimmt jeden der zehn Werte an und bleibt sonst unverändert fail-safe: Die
  Schreibweise wird kleingeschrieben (`"1H"` → `"1h"`), alles außerhalb der Allowlist (`"2h "`,
  `"7d"`, `""`, `null`) fällt auf den sicheren Default `15m` — nie wird ein Rohwert durchgereicht.
* **`RollingTimeframeSeries`** rechnet mit der kanonischen Periodentabelle
  (`SUPPORTED_TIMEFRAME_MS`) statt mit einer zweiten, unvollständigen. `MicroExecutor.addSymbol` wirft
  einen `RangeError` für Timeframes oberhalb des Ausführungsintervalls oder außerhalb des Vokabulars;
  der Konstruktor von `MicroExecutor` wirft bei unbekanntem `executionInterval`.
* **`MicroStatus`** hat ein zusätzliches Feld `ruleGuard` (`executionInterval`, `blocked[]`; additiv).
* **Workshop-Schritt 5 (`RuleBacktestPanel`):** Die Auswahl „Fenster“ bietet alle zehn Timeframes
  (aus `SUPPORTED_TIMEFRAMES`, nicht handgepflegt). Die Vorgabe „Workshop-Panel mitziehen“ stammt aus
  dem `1m`-Präzedenzfall (`2026-09-24-internal-adapter-daytrading`).
* **`scripts/bench-backtest.ts`:** der Cast nach der Sanitize-Kette in `buildBenchSpec` entfällt wie
  angekündigt („fällt mit 01-01 ersatzlos weg“) — der gemessene Timeframe läuft durch die Kette selbst.
* **Audit-Doku auf `v1.1.2`:** STX-01 behoben (`FIXED`), Gate **G1** erfüllt, Phase 1 abgeschlossen;
  `ROADMAP.md`, `remediation/TRACKING.md`, Findings-Index und Prompt-Index nachgezogen.

### Fixed

* **Stiller 15m-Fallback im Mikro-Executor:** `TIMEFRAME_MS[tf] ?? TIMEFRAME_MS["15m"]` kannte nur
  `1m…1h`. Mit der erweiterten Allowlist hätten `3m`/`2h`/`4h`/`1d`/`5d`-Regeln still auf
  15-Minuten-Kerzen gelaufen — auf einem anderen Takt, als sie unterschrieben haben (derselbe Fehler,
  der bei der Einführung von `1m` schon einmal auftrat, CYCLE-DAYTRADE-01). Die Serie nutzt jetzt die
  kanonische Tabelle (`3m` aggregiert exakt auf 3 Minuten) und wirft bei einem unbekannten Timeframe
  laut, statt zu fallen; bei Werten oberhalb des Ausführungsintervalls greift der Guard.

### Documentation

* **Tabelle „Rule-Timeframe ↔ unterstützte Felder“** in `docs/BACKTESTING.md` §1.1 (Kerzen je UTC-Tag,
  `vwapPct`, `volumeWindow` in Zeit, `changePct24h`-Spanne, Live-Ausführbarkeit, Kostenmodell) samt
  Begründung, warum `RULE_CEILINGS.volumeWindow` (5…200) unverändert bleibt; Verweise in
  `docs/MISSIONS.md` (Workshop), `docs/ARCHITECTURE.md`, `docs/architecture/STRATEGY_STACK.md`
  (SSoT-Zeile „Rule-Timeframes“), `docs/HISTORY.md`, `docs/architecture/PIPELINE_MAP.md`,
  `docs/HANDBUCH.md` (Glossar „Rolling-Serie“/„Ausführungsintervall“, §15.3),
  `docs/OBSERVABILITY.md` (Counter und Log) und `docs/REPOSITORY_STRUCTURE.md` (`ruleEngine` mit
  Timeframe-Hinweis).
* **Befundkorrekturen an STX-01:** (1) `sessionVwap` war auf `1d` bereits fail-closed — bei weniger
  als zwei Kerzen am UTC-Tag liefert es `null` (nie `0`), ein VWAP über eine Einzelkerze entstand nie.
  Es war kein Code-Fix nötig; die Eigenschaft ist jetzt per Test und Tabelle belegt. (2)
  `sanitizeRuleSpec` „verwirft“ einen unbekannten Timeframe nicht, sondern fällt auf `15m` und
  kleinschreibt vorher — der Prompt nennt `"1H"` als verworfen, real wird es zu `"1h"`. Die Semantik ist
  vom Prompt als gesperrt markiert und bleibt; getestet ist das Ist-Verhalten.
* **Bekannte Altlasten, bewusst unverändert** (kein Teil dieses Releases, beim Fixen beobachtet):
  das Kosten-Fallback-Modell des Paper-Backtests (`paperExecution.ts`) ist für `3m`, `2h`, `5d` nicht
  kalibriert (`3m` rechnet mit 4 bp/1 bp und ist damit optimistisch gegenüber `1m`/`5m`); die
  `RollingTimeframeSeries.touch()`-Aggregation addiert das kumulierte 1m-Volumen bei jedem Tick erneut
  (`volume` wächst statt 1, 2, 3 als 1, 3, 6 — live überhöht `volumeRatio`); und Serien entstehen nur
  beim Start bzw. für `MICRO_SYMBOLS` (`5m`/`15m`): eine später aktivierte Regel mit neuer
  Symbol-/Timeframe-Kombination wird erst nach einem Neustart ausgewertet, obwohl das Handbuch „kein
  Neustart nötig“ sagt. Jeder dieser Punkte ändert bestehende Ergebnisse und braucht ein eigenes
  Versionsereignis.

## [0.6.1] — Strategie-Stack-SSoT & Vokabular-ADRs (2026-09-29)

> **Status: Beta — und bleibt Beta.** Dieser Release bündelt die Prompts **00-02**
> (Strategie-Stack-SSoT — mit PR #182 ohne Changelog, Version und Tracking gemergt und hier
> nachträglich versioniert) und **00-03** (drei Vokabular-ADRs). Er ändert **kein**
> Laufzeitverhalten: kein Eintrag in `src/`, `scripts/` oder `drizzle/` wurde angefasst, es
> gibt keine Migration und keine Schema-Änderung. `package.json` folgt dem Release-Plan
> [`VERSIONING.md`](docs/audits/2026-09-29-strategy-template-ausbau/VERSIONING.md) §2; Gate
> **G0** der Strategie-Roadmap ist erfüllt, Phase 1 darf starten.

### Added

* **ADR-008, ADR-009, ADR-010** in [`docs/roadmap/DECISIONS.md`](docs/roadmap/DECISIONS.md)
  (Prompt 00-03, Findings STX-02/03/04). Jeder Eintrag folgt dem Schema Status · Kontext ·
  Optionen (Verworfenes mit Begründung) · Entscheidung · Konsequenzen · Auswirkung auf die Roadmap:
  * **ADR-008 (ADR-E1) Strategie-Klassifikation:** `StrategyTemplate.class` ist ein Pflichtfeld
    vom Typ `StrategyClassKey` (aus `STRATEGY_CLASS_KEYS`, kein eigener Union-Typ);
    `unclassified` ist kein Template-Status, sondern ein Fehler; **keine neue Klasse** —
    MACD → `trend`, RSI → `mean-reversion`; Zuordnung aller sechs Templates.
  * **ADR-009 (ADR-E2) Regime-Vokabular:** `MarketRegime` (5) + `UNKNOWN`, persistiert in
    `regime_snapshots`; die 7er-Taxonomie des Ausbaudokuments ist **verworfen**; `UNKNOWN` wird
    fail-closed ausgeschlossen; High-/Low-Volume ist der Scanner-Faktor `volumeRatio`, kein Regime.
  * **ADR-010 (ADR-E3) Universe-Strategie:** **keine** `MultiAssetStrategySpec`; eine
    `PortfolioConstruction`-Schicht (`EQUAL_WEIGHT`/`INVERSE_VOLATILITY`) liest den
    `CrossSectionalConfig`-Snapshot, die Exposure bleibt über `VOLATILITY_TARGETING_BOUNDS`
    geklemmt, Rebalance-Frequenz = `CrossSectionalConfig.timeframe`; die Schicht selbst ist
    bewusst **nicht** Teil der 32 Prompts.
* **`docs/architecture/STRATEGY_STACK.md`** (Prompt 00-02, PR #182 — nachträglich versioniert):
  Single-Source-of-Truth-Karte „welcher Baustein ist wofür zuständig“, explizite Lücken
  (`src/strategies/`, `src/screening/`, `src/copy/`) und 5-zeilige Einordnungsregel.
* **`tests/adrVocabulary.test.ts` (neu, nur lesend, 36 Tests):** nagelt die ADRs statisch fest —
  Form (Schema, genau eine Entscheidung, jede Alternative „verworfen“ mit Begründung, keine
  Vorbehalte), Code-Fakten (Klassenliste, Gate-Faktoren je Regime × Klasse, `regime_snapshots`-CHECK,
  `evaluateRegimeOos`-Verhalten, `UNIVERSE_CAP`, Vol-Targeting-Bounds, `AUTHORITY_CHAIN`),
  Guards für künftigen Code (keine eigene Klassenliste in `src/strategies/`, keine
  `MultiAssetStrategySpec`) und die Verweise in Roadmap, Tracking und Prompts.
* **`tests/docsVersioning.test.ts`:** neuer Test, dass `VERSION.md` und das Root-`README.md`
  dieselbe Version wie `package.json` nennen (die Bump-Checkliste, die bei PR #182 fehlte).

### Changed

* **Strategie-Audit nachgezogen** (`docs/audits/2026-09-29-strategy-template-ausbau/`): Audit-Version
  `v1.1.1`; Phase 0 abgeschlossen (00-01 `v0.6.0`, 00-02/00-03 `v0.6.1`), Gate **G0** erfüllt,
  OP-2 beantwortet; STX-02/03 in Arbeit (Entscheidung gefallen, Umsetzung in Phase 3/6), STX-04 und
  STX-15 behoben, STX-10/11 dokumentiert. `ROADMAP.md` nennt die ADR-Nummer in jeder Phase, die ein
  Vokabular berührt (Phasen 0, 1, 3, 4, 5, 6, 7) und führt `MultiAssetStrategySpec`, die 7er-Taxonomie
  und neue Klassen als verworfen.
* **Prompts an die Entscheidungen angeglichen:** 03-01/03-02/03-10 (`expectedRegimes` ist
  `readonly MarketRegime[]`, `UNKNOWN` ist ein Validierungsfehler; `scope` leitet sich aus
  `MissionScope` ab), 03-05 (Wirkungsgrenze der Klasse), 03-09 (`CompileResult.strategyClass`),
  06-04 (Aggregator „Strategie je Regime“ statt `evaluateRegimeOos`), 01-01 (Cross-Sectional-Rebalance
  ist nicht blockiert).
* **Doku-Indizes und Verweise** (`docs/README.md`, `docs/audits/README.md`,
  `docs/REPOSITORY_STRUCTURE.md`, `docs/architecture/PIPELINE_MAP.md`, `README.md`):
  `STRATEGY_STACK.md` und der ADR-Log sind auffindbar; `docs/REGIME_GATE.md`, `docs/SIGNAL_DECAY.md`,
  `docs/CROSS_SECTIONAL_RANKING.md` und `docs/VOLATILITY_TARGETING.md` verweisen auf ihre ADR.

### Documentation

* **Korrekturen an `STRATEGY_STACK.md`** (gegen den Code verifiziert): `evaluateRule` existiert nicht
  (`CompiledRule.evaluate` via `compileRuleSpec`); Bollinger gibt es nur als Bandbreite
  (`bollingerBandWidthPct`), `bollingerBands`/`donchianChannel` liefert erst 02-01;
  `BacktestEngineConfig.feeModel` hat kein `feeMode`; die Funktion heißt `normalizeVenueSymbol`
  (nicht `normalizeSymbol`); `src/scanner/factors/` hat 17 Dateien (15 Faktormodule + `helpers.ts` +
  `index.ts`); Eligibility gibt es in drei Stufen (Registry-Policy, Scanner-Trichter,
  Snapshot-Membership), nicht als „zentralen Vertrag“.
* **Faktenkorrekturen in Indizes und Glossar:** `README.md` nennt die **14 aktiven** Scanner-Faktoren
  (statt „15+“, STX-15); das Glossar in `docs/ARCHITECTURE.md` trennt „Volatilitäts-Regime“
  (NORMAL/ELEVATED/EXTREME, Risikofaktor) von „Markt-Regime“ (`MarketRegime`) und führt
  Strategieklasse und Cross-Sectional-Snapshot auf; der Severity-Zähler im Audit-README war
  inkonsistent (INFO-Zeile) und ist korrigiert.
* **Präzisierungen an den Befunden STX-01…STX-04** (Details: ADR-008 bis ADR-010):
  `evaluateRegimeOos` misst **Markt**-Forward-Returns und weist `UNKNOWN` als eigenen Bucket aus
  (der Befund-Test „schließt `UNKNOWN` aus“ gilt dem künftigen Aggregator); `selection.topN` ist durch
  `maxUniverseSize` **nicht** gedeckt (`UNIVERSE_CAP` kappt nach Volumen); die Bounds in
  `volatilityTargeting.ts` begrenzen den Risiko-Multiplikator, keine Gewichte; Regeln tragen keine
  Strategieklasse (Ableitung über das Mission-Template), und der Backtest wendet kein Regime-Gate an;
  der Cross-Sectional-Rebalance hängt nicht an `RuleWindow.timeframe` (der Hinweis zu STX-01 im
  Eintrag `0.6.0` gilt nur für regelbasierte Strategien).
* **Bekannte Altlasten, bewusst unverändert** (kein Code in diesem Release): die vier Klassenwerte
  stehen zusätzlich als Literale in `signalDecay.ts`, `signalDecayRuntime.ts` und im CHECK von
  `signal_decay_events`; `VolatilityRegime` ist in `adaptiveRisk.ts`, `src/portfolio/types.ts` und
  `src/scanner/types.ts` dreifach definiert. Neuer Code importiert die bestehenden Konstanten.
  Außerdem löst der In-App-Doku-Viewer (`/docs/<Datei>.md`, `GET /api/docs`) über `resolveDoc`
  (`src/lib/docsCatalog.ts`) weder `docs/architecture/` noch `docs/roadmap/` auf — das betrifft auch
  `STRATEGY_STACK.md` und den ADR-Log (im Repo und auf GitHub lesbar, im Browser-Viewer nicht).
  Die Behebung wäre eine Code-Änderung (zwei Suchpfade) und ist nicht Teil dieses Doku-Release.

## [0.6.0] — Backtest-Performance-Baseline (2026-09-29)

> **Status: Beta — und bleibt Beta.** Dieser Release bündelt die mit PR #180 gemergte
> Audit-/Beta-Dokumentation und den ersten umgesetzten Roadmap-Prompt **00-01**
> (Backtest-Performance-Baseline). Es ändert **kein** Laufzeitverhalten: die
> gemessenen Pfade (`src/lib/ruleEngine.ts` `backtestRule()`, `src/backtest/engine.ts`,
> `src/backtest/indicatorCache.ts`) bleiben unverändert, es gibt keine Migration und
> keine Schema-Änderung. `package.json` folgt dem Release-Plan
> [`VERSIONING.md`](docs/audits/2026-09-29-strategy-template-ausbau/VERSIONING.md) §2
> (`v0.5.1` ist in `v0.6.0` gefaltet; alle Releases liegen in `0.x`).

### Added

* **Audit 2026-09-29 — Strategie-Template-Ausbau** (`docs/audits/2026-09-29-strategy-template-ausbau/`):
  Code-verifizierende Prüfung eines externen Ausbaudokuments gegen `main` @ `e3509fd`.
  **19 Findings** (0 CRITICAL, 5 HIGH, 7 MEDIUM, 4 LOW, 3 INFO) und eine **Roadmap aus
  32 kopierfertigen Prompts** in 8 Phasen mit Abhängigkeitsgraph, Gates (G0–G8) und
  globalen Gesperrt-Klauseln. Siehe [`report.md`](docs/audits/2026-09-29-strategy-template-ausbau/report.md).
* **`docs/BETA_STATUS.md` (neu, kanonisch):** verbindliche Beta-Zusage. Kriterien
  `B1…B8` für einen Beta-Exit (Out-of-Sample über 12 Monate Live-Paper, Regime-Abdeckung,
  Live-Readiness-Audit, Security, Compliance, Betriebsreife, **unabhängige**
  Drittprüfung, bewusste Haftungsentscheidung), verbotene Handlungen, Review-Kadenz
  und die Zuordnung Roadmap → Kriterien.
* **`docs/audits/2026-09-29-strategy-template-ausbau/VERSIONING.md` (neu):**
  Audit-Versionsschema (`audit-2026-09-29`, aktuell `v1.1.0`) mit Bump-Regeln und
  **Release-Plan `v0.6.0` … `v0.11.2`** — ein Minor-Release je Phase bzw. Template,
  sämtlich in `0.x`. Enthält außerdem die drei erwarteten Bruchstellen in `0.x`
  (Timeframe-Erweiterung, Snapshot-Wachstum, neues Copy-Modul) und die
  Abwärtskompatibilitätsregeln.

* **`scripts/bench-backtest.ts` + `npm run bench:backtest` (neu, Prompt 00-01 / STX-12):**
  Messprotokoll der Backtest-Performance-Baseline. Misst auf **einer** echten,
  aus dem `HistoricalStore` gelesenen Reihe (keine synthetischen Bars) drei Pfade —
  `backtestRule()` (Single-Rule), `runMultiAssetBacktest()` (Engine) und
  `buildIndicatorCache()` + `snapshotFromCache()` (Indikator-Pfad) — bei
  n ∈ {1 000, 5 000, 17 520} Kerzen, je 1 ungemessenem Warmlauf + 3 Läufen (Median),
  inklusive `ms/1000 Kerzen`, log-log-Fit-Exponent und der „1 Zelle Matrix"-Rechnung
  (7 500 Zellen → Kernstunden seriell). Braucht **keine** Datenbank und kein Netz,
  schreibt nur nach `data/bench/` (gitignoriert).
* **`scripts/import-history-csv.ts` + `npm run history:import-csv` (neu):** netzfreier
  CSV-Import in den `HistoricalStore` (Kopfzeilen-Aliasing, Zeit in Sekunden/ms/ISO,
  `--from`/`--to`-Fenster, `--max-bars`, Dry-Run als Default mit Exit 2, `--apply`).
  Dedup und Validierung bleiben beim Store — verworfene und doppelte Zeilen werden
  gemeldet, nie still ersetzt.
* **`docs/audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md` (neu):**
  Messprotokoll mit allen Rohwerten. Kernergebnis: `backtestRule()` wächst mit
  Exponent **1,99** und kostet bei 17 520 Stundenkerzen **25 986 ms je Zelle**
  (7 500 Zellen = **54,14 Kernstunden** seriell), `runMultiAssetBacktest()` mit
  Exponent **1,01** und **213,5 ms** je Zelle (**0,44 Kernstunden** für die volle
  Matrix) — **121,7×** bzw. **360,1×** schneller als der Single-Rule-Pfad.

### Changed

* **Beta-Positionierung in `README.md` und `VERSION.md` verstärkt und
  operationalisiert:** beide nennen jetzt explizit, dass die vollständige Umsetzung
  der Strategie-Roadmap die Beta-Phase **nicht** beendet. In `VERSION.md` als
  eigene Zeile `Beta-Zusage` in der Metadatentabelle, in `README.md` als Zeile
  `Beta-Exit` in der Versions-Status-Tabelle plus ein hervorgehobener Hinweis.
* **Doku-Indizes ergänzt** (`docs/README.md`, `docs/audits/README.md`): neuer
  Eintrag für das Audit 2026-09-29 und Verweis auf `BETA_STATUS.md`.

* **Entscheidung aus der Messung (Gate G5 erfüllt):** Screening, Template-Compiler-Tests
  und Validator-Läufe fahren über `runMultiAssetBacktest()` (bzw. direkt über den
  Indikator-Cache); `backtestRule()` bleibt der Einzel-/Referenzpfad. STX-12 ist damit
  von „Blocker der Matrix" auf **Patch-Task mit Paritätstest** herabgestuft, `worker_threads`
  ist keine Voraussetzung für 05-04. Die Audit-Doku wurde nachgezogen (STX-12, Roadmap,
  Tracking, Audit-Version `v1.1.0`).

### Findings (Auszug, Details je Datei unter `findings/`)

* **STX-01 (HIGH)** — `RuleWindow.timeframe` ist auf `1m|5m|15m|30m|1h` begrenzt,
  während `SUPPORTED_TIMEFRAMES` bis `5d` reicht. Ohne Angleichung sind sämtliche
  Screening- und Cross-Sectional-Ziele **nicht ausdrückbar**.
* **STX-05 (HIGH)** — der vorgeschlagene `buildRule(ctx)`-Builder erzeugt zur Laufzeit
  eine fertige `RuleSpec` und würde damit `sanitizeRuleSpec()` und `RULE_CEILINGS`
  umgehen — also genau die Kette, die das Sicherheitsmodell „Code entscheidet" trägt.
  Korrektur: pure Funktion der **Parameter**, Rückgabetyp `RuleSpecInput`.
* **STX-02/03/04 (HIGH)** — `StrategyClass`, `MarketRegime` und `CrossSectionalConfig`
  existieren bereits; das Ausbaudokument hätte dafür je ein zweites Vokabular
  angelegt. Kein neues Klassifikations-, Regime- oder Eligibility-Modell.
* **STX-08 (MEDIUM)** — `src/brokers/alpaca/` enthält **keinen** WebSocket; der
  Alpaca-Adapter ist REST-only. Alpaca ist deshalb **nicht** Teil der Copy-Roadmap.
* **STX-12 (MEDIUM)** — `backtestRule()` ist O(n²) (`ruleEngine.ts:787`); nur die
  Multi-Asset-Engine nutzt `IndicatorCache`. Bestimmt, ob eine Matrix mit Tausenden
  Zellen überhaupt lauffähig ist → Benchmark ist Phase 0.
  **Gemessen in diesem Release:** Exponent **1,99** (O(n²)) für `backtestRule()`
  gegen **1,01** (O(n)) für die Engine; siehe
  [`BENCH-BASELINE.md`](docs/audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md).
* **STX-16 (LOW, organisatorisch hoch)** — Copy-Trading verschiebt das
  Haftungsprofil. Deshalb `CopyMode` als Enum mit **genau einem** Wert
  (`SIMULATE_ONLY`) und DB-CHECK, kein Env-Flag.

### Documentation

* **Faktenkorrektur im Umfeld:** Der Scanner hat **14** aktive Faktoren
  (`src/scanner/scanner.config.json`), nicht „15+". Das Audit dokumentiert die
  SSoT-Verweise statt Dateizahlen.

## [Unreleased]

> **Status: Beta.** Offen für den nächsten Zyklus (aus den Audits): `IAD-T-07`
> Limit-/Stop-Markt/OCO am Broker (`src/execution`), `IAD-T-08` Session-VWAP
> mit börsenlokaler Tagesgrenze (Exchange-Kalender), Shorts
> (`RULE_ALLOWED_SIDE=LONG`) bleiben Risikoentscheidung.

## [Unreleased] — ALPACA-Datenpfad, OpenCode Zen & Laufzeit-Schalter (2026-09-25)

> **Status: Beta.** Quelle: Arena-Auftrag 2026-09-25 („nur 2 Symbole",
> Alpaca-Integration, Remote-Check-Frage, OpenCode-Free-Modelle per UI).

### Added

* **OpenCode Zen als LLM-Provider** (`opencode`, `src/lib/llmProvider.ts`):
  OpenAI-kompatibler Cloud-Provider mit kostenlosen Modellen
  (`OPENCODE_API_KEY`, `OPENCODE_BASE_URL` → `https://opencode.ai/zen/v1`,
  `OPENCODE_MODEL`, Default `big-pickle`). Free-Model-Snapshot
  (`OPENCODE_FREE_MODELS`, `isOpenCodeFreeModel`), Kosten 0
  (`LLM_COST_OPENCODE_*` für bezahlte Modelle), Token-Deckel
  `ROUTING_BUDGET_OPENCODE_TOKENS` (Policy-Default 250 000/Tag), letzte
  Präferenz in `MODEL_C`. Doku: `docs/PROVIDER_INTEGRATION.md` §4b.
* **Laufzeit-Schalter (UI)** — `GET|PUT /api/ops/toggles` + Panel
  `src/components/ops/RuntimeTogglesPanel.tsx`:
  * je LLM-Provider `provider.<id>.enabled` (ein-/ausschalten ohne Neustart),
  * `broker.healthcheck.remote` für die Broker-Remote-Checks.
  Persistenz `data/runtime/flags.json` (`src/lib/runtimeFlags.ts`, nur
  Bool-Werte, chmod 600, atomar, fail-soft). Admin-Guard + CSRF, Audit-Event
  `RUNTIME_FLAG_CHANGED` (Katalog-Eintrag in `src/lib/auditView.ts`).
* **Env-Sperrliste** `ROUTING_DISABLED_PROVIDERS`, effektiv per
  `isProviderEnabled()`/`resolveProviderChain()`: gesperrte Provider werden nie
  gewählt, nie als Fallback genutzt und **nie abgefragt** (auch kein
  Health-Ping). `/api/providers` liefert `enabled`/`toggleSource`/`toggleKey`.
* **ALPACA-Datenpfad dokumentiert und im Hinweis sichtbar:**
  `docs/ALPACA.md` §1a/§1b (Sync über Yahoo, Aktivierungs-Checkliste,
  Health-Semantik); `.env.example` dokumentiert `ALPACA_ENABLED` und den
  Venue-Sync.

### Changed

* **Sync-Hinweis ist venue-bewusst** (`buildReadinessHint`,
  `syncCommandsFor`, `offenderVenues` in `src/ops/collectMarketData.ts`): Der
  Hinweis nennt die Venues der worst offenders (`npm run market:sync --
  --venue=ALPACA …`, ein Kommando je Venue) plus den Flag-Hinweis
  (`<VENUE>_ENABLED=true`), wenn eine Venue noch nie synchronisiert wurde —
  vorher stand dort pauschal BITUNIX.
* **Broker-Remote-Check** ist ohne Neustart umschaltbar; die Auflösung
  (Runtime-Flag → Env → Default aus) ist als `source` in `/api/brokers` und
  `/api/brokers/{venue}/health` sichtbar. ALPACA/IBKR prüfen credential-frei
  ihre Sync-Quelle (Yahoo) und melden NIE `online` ohne Keys/Gateway: der
  Status bleibt `degraded`, `syncSourceReachable` trägt die Zusatzinformation.
* **LLM-Operations-Sektion** weist gesperrte Provider und deren Begründung aus
  (Metrik „Provider freigegeben", Hinweiszeile).

### Fixed

* `.env.example` dokumentierte `ALPACA_ENABLED` nicht — die Venue ließ sich
  damit nur durch Raten freischalten; Sync und Adapter waren für ALPACA
  faktisch nicht erreichbar (`0/61 Kerzen`).

## [0.5.0] — 2026-09-26 · Multi-Venue-Warmup und datenbewusster Missionskontext

> **Status: Beta.** Scan-Missionen erhalten belastbaren Multi-Kandidatenkontext,
> rotierenden Fokus und handeln nur Kandidaten mit ausreichend Kerzen.

### Hinzugefügt

- **Mission-Venue-Warmup** (`npm run market:sync:mission-venues`): führt die
  bestehenden public-only Syncs für IBKR, PAPER, BINANCE und KRAKEN aus,
  setzt keine Sicherheits-/Env-Gates außer Kraft und versucht nach Venue-Fehlern
  die restlichen Läufe trotzdem. Der Gesamtstatus ist nicht-null, wenn mindestens
  ein Venue nicht warm wurde.
- **Top-5 Multi-Kandidaten-Snapshots** im Missionsprompt: je Kandidat Preis,
  RSI(14), Trend und ATR%; Kandidaten ohne mindestens 25 verwertbare Kerzen
  werden aus dem Mandat entfernt. Ist kein Kandidat warm, wird HOLD angewiesen
  und die Engine blockiert eine Trade-Entscheidung fail-closed.
- **Deterministische Fokusrotation** je UTC-15-Minuten-Zyklus mit
  missionsspezifischem Offset. Ein aktueller (max. 48 h), READY-Scanner-Snapshot
  sortiert Kandidaten nach Scanner-Score; volumenbasiertes Ranking bleibt der
  robuste Fallback.
- Gezielte Tests für Fokusrotation und Scanner-Score-Ranking.

### Geändert

- Versionsstand auf `v0.5.0` angehoben; Setup- und Marktdaten-Dokumentation um
  Venue-Gates, Warmup-Ablauf und Mandatssemantik ergänzt.

## [0.4.0] — 2026-09-24 · bookDepthUsd + Orderbuch-Qualitätsgrenze je Venue

> **Status: Beta.** Logische Fortsetzung von `spreadPct` (IAD-T-06): Die
> Orderbuch-**Tiefe** wird zum Regelfeld, abgesichert durch eine
> **Qualitätsgrenze je Venue** — ein Feld auf dünnen Büchern wäre eine
> Fehlentscheidungs-Maschine. Quelle: Arena-Auftrag 2026-09-24.

### Hinzugefügt

- **`bookDepthUsd` als Regelfeld** (`IAD-T-06`): Orderbuch-Tiefe der
  abriegelnden Seite `min(Σ bid×qty, Σ ask×qty)` in Quote-Währung. Verfügbar in
  `MarketInstrument.bookDepthUsd` (Registry + sync-Upsert + Spread-/Depth-Cache
  `data/spread-cache.json`, abwärtskompatibel), `RuleSnapshot`, `RULE_FIELDS`,
  `buildSnapshotFromCandles`/`snapshotFromCache`, `microExecutor.updateBook`
  (Live-Buch aus dem Binance-`@depth5`-Stream), `TrustedReading.bookDepthUsd`.
  `null` blockiert die Bedingung (fail-closed) — eine 0 wäre eine erfundene Tiefe.
- **Orderbuch-Qualitätsgrenze je Venue** (`src/lib/bookDepthProvenance.ts`):
  Nur `depth`-Venues (BINANCE/BITUNIX/KRAKEN) liefern `VERIFIED`-Tiefe
  (≥ 3 Levels je Seite, Snapshot ≤ 5 s alt). `top`-Venues (YAHOO — Preise ohne
  Lotgröße) und `none` (PAPER-Presets) bleiben `UNQUALIFIED`. Unbekannte Venues
  fallen auf `none` (nie auf `depth`).
- **`src/lib/bookDepth.ts`**: deterministische Tiefenberechnung
  (`computeBookDepth`), Rohlevel-Sanitisierung mit harter Kappung
  (Security) und ordnungsunabhängigem Best-Bid/Ask.

### Geändert

- `MarketInstrument` + `INSTRUMENT_FIELDS` + Normalisierung/Validierung um
  `bookDepthUsd` (NULL-Metrik-Semantik wie `volume24h`/`spread`).
- `enrichWithOrderBooks` misst Tiefe aus denselben Depth-Levels (kein Extra-Request).
- `formatSyncLog` führt bei Messungen die Zählerzeile `book depth measured`.
- Tech-Debt/Kosmetik: 6 ungenutzte `eslint-disable`-Directiven entfernt
  (`lint` jetzt 0 warnings), redundanter Seitenfilter in der Tiefenberechnung
  gestrichen.
- Execution-Quality-Golden-Pin neu gesetzt: der Evidence-Hash deckt jetzt
  `bookDepthUsd` als Entscheidungsinput ab.

## [0.3.0] — 2026-09-24 · Paper n≥100, Kostenmodell feine Takte, 6 rote Tests grün, spreadPct

> **Status: Beta.** Umsetzung der 4 Prioritäten vor Kosmetik:
> 1. Paper lange genug für n ≥ 100, 2. Kostenmodell auf den feinen Takten,
> 3. die 6 vorbestehenden roten Tests, 4. `spreadPct` für Daytrading.
> Quelle: Arena-Auftrag 2026-09-24.

### Hinzugefügt

- **Regelfeld `spreadPct`** (`DAYTRADING-SPREAD-01`): Relativer Spread in Prozent
  (`instrument.spread` = (ask-bid)/mid ×100, `null` ohne Orderbuch). Quelle:
  `MarketInstrument.spread` (Orderbook-Top-Level, Plausibilität ≤50 %), gemessen
  im `market-sync` via `spreadCache` (6 h TTL, `data/spread-cache.json`),
  verfügbar im `RuleSnapshot`, `RULE_FIELDS`, Mikro-Executor (`updateSpread`),
  Trusted-Indicators (`spreadPct` im Reading) und Workshop-Katalog. Für Daytrading
  die zentrale Kosten-/Liquiditätsgröße — hoher Spread frisst die Edge pro Trade.
- **Indikator-Cache für die Backtest-Engine** (`PERF-CACHE-01`,
  `src/backtest/indicatorCache.ts`): EMA9/21/50, RSI14, ATR/ATR-Pct, ADX14, BBW-Pct,
  MACD/Signal/Hist, VolumeMa20 und VWAP werden einmal pro Symbol in O(n)
  vor-gerechnet, danach O(1)-Lookup je Bar. Macht aus O(n²) → O(n): 2 Jahre
  Stundenkerzen (17 520 Bars) von 17–21 s auf 0,6–0,8 s (Performance-Deckel <10 s
  im Test `tests/backtest.replay.test.ts`).
- **Timeframe-abhängiges Kostenmodell** (`COST-TIMEFRAME-01`,
  `src/backtest/paperExecution.ts`): `timeframeToSpreadFallbackBps` und
  `timeframeToSlippageBaseBps` — 1m 15 bp / 3 bp, 5m 10/2, 15m 8/1.5, 30m 6/1,
  1h 4/1, 4h 3/0.5, 1d 2/0.5. `createPaperExecutionRuntime` skaliert
  `syntheticSpreadBps` und `slippageBpsBase` nach Timeframe, wenn kein expliziter
  Simulator übergeben wurde. `runMultiAssetBacktest` führt den Timeframe in den
  Paper-Optionen mit (`paper.timeframe`), Event-Replay nutzt denselben Fallback.
  Feiner Takt = höhere Kosten = ehrlichere Edge.

### Geändert

- **Paper lange genug für n ≥ 100** (`SAMPLE-N100-01`):
  `RULE_BACKTEST_MIN_BARS` 40 → 100, `JOURNAL_DEFAULTS.minTrades` 20 → 100,
  `POLICY_BODY.backtestMinTrades` 30 → 100, `paperMinTrades` 20 → 100,
  `driftMinSample` 20 → 100. Begründung: <20 Trades = Münzwurf, n≥100 =
  statistisch belastbar (Wilson, Profit-Faktor). Tests angepasst
  (`tests/ruleBacktest.test.ts`: `oneDip` 70 → 130 Bars, `tests/tradeJournal.test.ts`,
  `tests/strategyLifecycle.*`).
- **Backtest-Engine nutzt Cache**: `src/backtest/engine.ts` baut pro Symbol einen
  `IndicatorCache` und nutzt `snapshotFromCache` mit Spread aus dem Instrument
  (Paper-Pfad). Fallback auf `buildSnapshotFromCandles` wenn kein Cache.
- **Mikro-Executor kennt Spread**: `RollingTimeframeSeries.snapshot(spread)` und
  `MicroExecutor.updateSpread(symbol, spread)` + `spreads`-Map — Spread aus dem
  Orderbook kann jetzt in den Hot-Path fließen.
- **Trusted-Indicators mit spreadPct**: `TrustedReading.spreadPct` + Param in
  `readingFromCandles(spread)`, Payload enthält das Feld (LLM sieht es als
  Messwert, nicht als erfundene Zahl).
- **Sentiment-API fail-soft**: `listSentimentForecasts` fängt DB-Fehler und liefert
  `[]` statt 500 — Route bleibt lesbar ohne DB (Test `sentiment.api.test.ts`).
- **Audit-Reliability Fake-DB**: `tests/auditReliability.test.ts` behandelt
  `promptArtifacts` korrekt (select → [], insert → valides Artefakt), damit
  `missedAuditCount` nicht doppelt zählt (2 → 1 bzw. 1 → 0).
- **Mission-Template-Test**: `guardrail-stress-test` liegt bewusst an den Deckeln
  (0,05/0,5) und löst 75-%-Warnung aus — Test erlaubt jetzt Deckel-Warnungen nur
  für dieses Template.

### Behoben

- **6 rote Tests grün** (Vollsuite `npm test` 3605 Tests: 3569 pass, 0 fail, 36 skipped):
  - `auditReliability`: Prompt-Update trotz Totalverlust (missed count 2→1) und
    Spool-Reserve (1→0) — Fake-DB fix.
  - `missionTemplates`: guardrail-stress-test mit erlaubter Deckel-Warnung.
  - `sentiment.api`: 500 → 200 mit leerer Liste ohne DB.
  - `backtest.replay`: Performance-Deckel 15–20 s → 0,6 s via Cache.
  - `ruleBacktest` (5 Tests) und `tradeJournal`/`strategyLifecycle` nach
    n≥100-Anhebung.
  - `monitor.exits` DB-Skip: `skipWithoutDb` return + early return statt
    weiterlaufen nach `t.skip()` (verhinderte „not ok # SKIP“).

### Nicht gebaut (bewusst, Begründung im Audit 2026-09-24)

Shorts (`RULE_ALLOWED_SIDE = "LONG"` bleibt Risikoentscheidung), 1m-Backfill als
Sync-Default (Request-Sturm), `bookDepthUsd` als Regelfeld (Orderbuch-Qualität je
Venue noch ohne belastbare Grenze), Limit-/Stop-Markt/OCO am Broker (gehört in
`src/execution`).

## [0.2.0] — 2026-09-23 · Adapter-Prüfung, Prompt-Budget, vwapPct, 1m-Timeframe

> **Status: Beta.** Prüfung aus
> [Adapter, Parallelität, Daytrading 2026-09-24](docs/audits/2026-09-24-internal-adapter-daytrading/README.md).
> `backtestRule` bleibt unverändert, der Engine-Default bleibt `"legacy"`,
> keine neue API-Route, keine neuen Datenadapter (Begründung im Audit).

### Hinzugefügt

- **Prompt-Budget-Planung der Analysten** (`CYCLE-BATCH-01`,
  `src/cycle/promptBudget.ts`): der Technical Step misst seinen Prompt mit
  derselben Baufunktion, die der Agent-Port sendet, und zerfällt bei Bedarf in
  deterministisch gepackte Batches. Der Grund ist Korrektheit, nicht
  Geschwindigkeit: Bei 40 Kandidaten mass der Einzelaufruf **92 449 Zeichen
  (~25 700 Tokens) gegen `OLLAMA_NUM_CTX=4096` und `LLM_MAX_TOKENS=512`** —
  Antwort abgeschnitten, JSON unvollständig, der Lauf endete mit
  `NEUTRAL`/Score 50 für **alle** 40 Kandidaten. Jetzt: 10 Aufrufe
  à ≤ 1 650 Tokens und ≤ 4 Analysen, Merge in Eingabereihenfolge.
- **News-Schritt genauso geplant** (`05-news-analyst`): 40 Instrumente mit
  120 Headlines bauten **31 594 Zeichen ≈ 8 800 Tokens** gegen ein 4 096er
  Fenster — dieselbe Abschneide-Kette, Ergebnis war ABSTAIN für alle („ruhige
  Nachrichtenlage"). Headline ohne Symbolbezug steht jetzt in JEDEM Batch
  (sonst übersieht ein Batch die Markt-Krise), das systemische Risiko wird über
  die Batches nach **Schwere** gemerged (MAX, nicht Mehrheitsvotum), und die
  Injection-Hülle ist unverändert: der fremde Text bleibt in `untrustedData`
  (Nachweis im Test).
- **Nebenläufigkeit mit Sinn** (`CYCLE_ANALYST_CONCURRENCY`): Default 1 bei
  lokaler Inferenz (ein Slot — Parallelität wäre nur Warteschlange), 2 bei
  `openai`/`gemini`/`anthropic`; `mapBounded` hält die Ergebnisreihenfolge und
  das Limit ein.
- **Regelfeld `vwapPct`** (`CYCLE-DAYTRADE-01`): Kurs gegen den Tages-VWAP in
  Prozent (`sessionVwap`, UTC-Tagesanker, `null` ohne Volumen ⇒ Bedingung
  feuert nicht). Die Referenzgröße des Daytradens fehlte komplett — alle
  bestehenden Felder vergleichen mit Zeitmitteln (EMA), keiner mit dem
  Volumenmittel. Workshop-Feldauswahl übernimmt es automatisch aus dem Katalog.
- **`1m` als Regel-Timeframe**: Whitelist, JSON-Schema,
  `TIMEFRAME_MS` im Mikro-Executor, Workshop-Port. Vorher hätte
  `?? TIMEFRAME_MS["15m"]` eine 1m-Regel **still auf 15 Minuten
  aggregiert** — die Regel wäre auf einem anderen Takt gelaufen, als sie
  unterschrieben hat.
- **Flags** `CYCLE_PROMPT_RESERVE_TOKENS`,
  `CYCLE_PROMPT_INPUT_BUDGET_TOKENS`, `CYCLE_ANALYST_BATCH_SIZE`,
  `CYCLE_ANALYST_CONCURRENCY` (`CONFIGURATION.md`, `.env.example`).

### Geändert

- **Kein stilles Neutral mehr:** Fällt ein Batch aus, überdeckt nur DIESER
  Batch sich selbst, und der Schritt meldet `promptFit.failedBatches` /
  `fallbackInstruments` / `incomplete` im Artefakt statt 40 Nichtaussagen als
  Analyse auszuliefern.
- **Redundanz-Hebel vor Aufteilung:** die Voll-Snapshots der MTF-Konfluenz
  waren 64 % des Prompts und duplicated die kompakte Zeilenform. Sie fliegen
  je Batch einzeln raus (nur wenn DAS Fenster zu klein ist) — im Artefakt
  stehen sie weiterhin vollständig, die Autorität bleibt bei der
  serverseitigen Anhängung.
- **`validateTechnicalOutput` lässt `confluenceMeta` und `promptFit` durch**
  (sanitized, keine Fremdschlüssel). Vorher schluckte die Validierung beide
  Meta-Blöcke im Engine-Handoff — `confluenceMeta` erreichte Research-Schritt
  und Tages-Artefakt nie.

### Gefunden, nicht geändert

- **`changePct24h` ist keine 24-Stunden-Größe.** Die Snapshot-Rechnung bezieht
  die Kerze vor **97 Perioden** — auf `1h` ~4 Tage, auf `5m` ~8 Stunden, auf
  `1m` ~1,6 Stunden. Label und Code-Kommentar sagen das jetzt; die Rechnung
  bleibt, weil jede Korrektur bestehende Regeln und ihre Backtests still
  umwerten würde. Das gehört in eine dokumentierte Snapshot-/Formelversion,
  nicht in einen Nebenbefund (Audit §7.4).

### Nicht gebaut (bewusst, Begründung im Audit)

Yahoo-Adapter (produktiv vorhanden: ALPACA/IBKR/PAPER via
`src/marketdata/adapters/yahoo.ts`), Polygon- und FRED-Adapter,
`RULE_FIELDS`-Erweiterung um ADX/BBW/MACD (seit v0.2.0 da), MACD in
`indicators.ts` (da), Pre-Compute im Technical Step (ist als strengere
Variante da: Code **überschreibt** Modellzahlen), Binomialtest (Wilson reicht),
Shorts im Regelwerk (`RULE_ALLOWED_SIDE = "LONG"` ist eine
Risikoentscheidung, keine Zeile Code).

## [0.2.0] — 2026-09-23 · Kostenwahrheit im Regel-Backtest, Workshop-Schritt 5, Trusted-Indikatoren

> **Status: Beta.** Additiver Schnitt aus dem Audit
> [Verbesserungen 2026-09-23](docs/audits/2026-09-23-verbesserungen-fahrplan/README.md).
> `backtestRule` bleibt byte-identisch. Der Default von `runMultiAssetBacktest`
> bleibt `"legacy"`. Keine neue API-Route.

### Hinzugefügt

- **Paper-Default auf der bestehenden Regel-Backtest-Route**
  (`POST /api/firm/rules/[id]/backtest`): Gebühren, Spread, Slippage und
  Funding über den Fill-Simulator, Kerzen nur aus dem Historical Store.
  Fehlende Historie ist 422, ohne stilles Yahoo. `model=reference` behält
  den gebührenfreien Altpfad (VBF-P1-01).
- **Workshop-Schritt 5** prüft eine Regel und speichert sie nur als `DRAFT`.
  `activate` wird nicht gesendet (VBF-P1-02).
- **Trusted-Block:** RSI(14), ATR(14) und MACD kommen aus
  `src/lib/indicators.ts` und überschreiben Modellzahlen. Ist die Konfluenz
  aus, bleibt die Herkunft `trusted-indicators@1` (VBF-P2-01).
- **Regelfelder** `macd`, `macdSignal`, `macdHist` plus `adx14` und `bbwPct`
  in der Whitelist, mit Ceiling (VBF-P2-02).
- **Wilson-95-%-Intervall** der Trefferquote (`src/lib/stats.ts`) und
  Warnung ab 2000 Prompt-Zeichen. Speichern bleibt bis 8000 möglich
  (VBF-P2-03).
- **Warnung** ab 75 % des Positionsdeckels. Abgelehnt wird nur der Deckel
  selbst (VBF-P3-02).
- **Rohantwort in den Prompt-Editor**, ohne automatisches Speichern
  (VBF-P3-03).
- **Paritätstest** `detectExit` gegen `detectExitTrigger`. Die Funktionen
  werden nicht zusammengelegt (VBF-P3-01).

### Behoben

- **Regel-Backtest findet Store-Reihen.** Das Regel-Symbol (`BTC/USDT`) ist nicht
  die Store-ID (`BITUNIX:BTCUSDT`). Der Paper-Pfad nimmt eine explizite
  `instrumentId` oder genau eine passende Reihe. Mehrdeutigkeit ist 422, kein
  stiller Tausch und kein Yahoo.

### Geändert

- Handbuch (Kapitel 2.3, 6, 15.4, 19.1), `docs/MISSIONS.md`,
  `docs/BACKTESTING.md` und `docs/help/workshop.help.json` beschreiben die
  fünf Workshop-Schritte und den Paper-Default der bestehenden Route.

### Nicht enthalten

- Kein K-Fold, kein Ulcer-Index, kein Regime-Regelfeld, kein Binomialtest,
  keine Prompt-Historie, keine neuen Daten-Adapter (Polygon, FRED, Finnhub,
  Alpha Vantage), kein stilles Yahoo auf dem Paper-Pfad, kein Wechsel des
  Engine-Defaults, kein Ersatz von `detectExit`.

## [0.1.0] — 2026-09-23 · Beta-Baseline: Re-Versionierung, Struktur-Reorganisation, Dokumentationskonsolidierung

> **Status: Beta.** Erstes öffentliches Release unter dem v0.x.x-Schema.
> Enthält den vollständigen Funktionsstand der bisherigen Beta-Entwicklung
> (interne Zählung bis v1.73.1) plus die nachfolgende Überarbeitung.

### Hinzugefügt

- **`VERSION.md`:** kanonische Versions-Metadaten (Version, Datum, Status Beta,
  Komponenten- und API-Übersicht, Versionsregel).
- **`CONTRIBUTING.md`:** Beitrags-Leitfaden (Pflicht-Checks, Konventionen,
  Audit-/Doku-Sync-Pflichten, Beta-Hinweise).
- **Prominenter Beta-Disclaimer im Root-`README.md`** (erste Zeile, vor allem
  übrigen Inhalt) sowie in `package.json`, `VERSION.md` und diesem Changelog.
- **Header-Kommentare in allen Quelldateien** (`src/`, `scripts/`): Zweck,
  Verantwortung und Abhängigkeiten je Datei; JSDoc-Ergänzungen in den
  kernkritischen Modulen (Execution, Risk, Live-Gate, Scanner, Portfolio,
  Market Data).

### Geändert

- **Versionierung neu etabliert:** `package.json` auf `0.1.0` (Beta-Baseline);
  alle „aktuellen“ Versionsverweise in der Dokumentation auf `v0.1.0`
  umgestellt. Historische Verweise auf die alte Zählung `v1.x.x` bleiben in
  Archiv-/Audit-Dokumenten erhalten und werden über die
  [Versions-Zuordnung](#versions-zuordnung-v0xx--v1xx) lesbar gemacht.
- **Repository-Struktur konsolidiert:**
  - Doppeltes Testverzeichnis `test/` in `tests/` **zusammengeführt**
    (`tests/marketdata/`, `tests/integration/`, `tests/ops/`, `tests/ui/`,
    `tests/fixtures/bitunix/`); npm-Test-Skripte angepasst.
  - Veraltetes Template-File `.ignore` entfernt (kontradiktorisch zu
    `.gitignore`: es ignorierte versionierte Verzeichnisse wie `tests/`
    und `scripts/`).
  - Kanonische Root-Dokumente unverändert: `README.md`, `CHANGELOG.md`,
    `INSTALL.md` (Wrapper), `CONFIGURATION.md` (Flag-Referenz).
- **Altes Changelog archiviert:** die detaillierte Historie der
  Beta-Entwicklung (v1.40.0–v1.73.1) liegt jetzt unter
  [`docs/archive/CHANGELOG-legacy-v1.md`](docs/archive/CHANGELOG-legacy-v1.md)
  (unverändert, mit Archiv-Header).

### Behoben

- **Dokumentationsinkonsistenzen:** `docs/REPOSITORY_STRUCTURE.md` beschreibt
  jetzt die konsolidierte Struktur (einzige `tests/`-Datei-Quelle, keine
  `.ignore`); der Docs-Index (`docs/README.md`) dokumentiert das
  v0.x.x-Versionschema und die Zuordnung zur Legacy-Zählung.
- **README-Dokumentationsstand:** alle Status-Header zeigen jetzt `v0.1.0 (Beta)`.

### Kompatibilität

- **Keine Änderung des Laufzeitverhaltens** durch dieses Release: es betrifft
  Versionierung, Struktur (Testpfade) und Dokumentation. Alle Features der
  Beta-Entwicklung (Meilensteine unten) bleiben unverändert.
- Testpfade: Skripte in `package.json` referenzieren jetzt ausschließlich
  `tests/**`; eigene CI-/Befehlszeilen-Aufrufe, die `test/…` nutzten, sind
  entsprechend anzupassen.

---

## v0 — Beta-Meilensteine

Zusammenfassung der Beta-Entwicklung. Die **vollständigen, detailgetreuen
Einträge** (mit Formeln, Migrations- und Rollback-Runbooks, Testmatrizen) stehen
im Archiv: [`docs/archive/CHANGELOG-legacy-v1.md`](docs/archive/CHANGELOG-legacy-v1.md).
Klammer: interne Legacy-Nummer, auf die sich ältere Dokumente und Audit-Reports
beziehen (siehe [Versions-Zuordnung](#versions-zuordnung-v0xx--v1xx)).

### Phase 1 — Fundament, Agenten-Zyklus & Paper-Trading (Frühe Beta, v1.0.0–v1.39.x)

- Autonome **Agenten-Firma**: CEO, Research, Technical-, News- und
  Macro-Analyst, Risk Manager, Portfolio Engine, Approver und Executor als
  getrennte, versionierte Schritte des Daily-/Weekly-Cycle (`src/cycle/`).
- **Deterministischer Market Scanner** (Liquidität/Volatilität/Korrelation,
  15+ Faktoren) mit Market-Universe-Registry (354 Preset-Instrumente) und
  point-in-time Historical Store (append-only OHLCV, `src/marketdata/`).
- **Paper-Broker mit realistischer Execution-Simulation** (Gebühren, Spread,
  Slippage, Partial Fills) und serverseitigem Exit-Management (Stop-Loss,
  Take-Profit, Trailing-Stop, Time-Stop, OCO-Exklusivität, Funding-Accrual).
- **Portfolio-Engine & Analytics** (Task 05, `src/portfolio/`): Formelkatalog
  (Sharpe/Sortino/Drawdown/Kalmar), Kovarianz-/Korrelations-Cluster,
  Optimizer mit Guard-Kette — Details in `docs/PORTFOLIO_ANALYTICS.md`.
- **Abstrakte LLM-Provider-Schicht** (Ollama, OpenAI-kompatible Endpunkte,
  Gemini, Claude) mit Model-Router, Routing-Overrides, Turn-Budgets und
  Prompt-Versionierung (`src/routing/`, `src/promptPerformance/`).
- **PostgreSQL als institutionelles Gedächtnis** (Drizzle, append-only
  Migrations), Audit-Trail mit Retry/Spool (sicherheitskritische Schreibvorgänge
  at-least-once, fail-closed), RBAC (Admin/Operator/Viewer), Session-Login.
- **Security-Härtung (Legacy v1.36.x):** Auth-Modus `local-open` /
  `token-required` mit Boot-Guard, unabhängiger `FIRM_SESSION_SECRET`
  (SEC-01), geschützte Dashboard-Reads (SEC-02), gepinnte Next.js/ws-Versionen
  (SEC-03/SEC-04), Rule-Governance mit RBAC (SEC-05/06), Environment-/
  Credential-Hygiene (SEC-07/09), Session-Revocation (SEC-08),
  Rate-Limits ohne Client-Header-Identität, Kill-Switch mit
  admin-only + CSRF + single-use-Nonce-Disarm, Live-Gate als harte
  Freigabeschicht für jeden Live-Pfad.

### Phase 2 — Backtesting, Forschung & Datenqualität (v1.40.0–v1.53.0)

- **Market-Sync-Fixes & Multi-Venue-Sync** (alle 6 Venues: Bitunix, Binance,
  Kraken, Alpaca, IBKR, Paper; gemeinsame `SyncHttpClient` mit
  Fehlerklassifizierung) *(v1.40.0, v1.59.0)*.
- **Feature-Gap-Audit 2026-09-18** (GAP-01…GAP-10) als Audit-Zyklus mit
  ausführbarer Prompt-Serie *(v1.41.0)*.
- **Multi-Asset Event-Driven Backtest-Engine** mit Walk-Forward-Fenstern,
  Kostenmodellen und persistierten Runs *(v1.42.0)*; Funding-Kosten im
  Paper-PnL + kalibrierbare Execution-Simulation *(v1.42.0)*.
- **Trade-Journal mit Agenten-Attribution** (append-only, MAE/MFE, begrenzte
  Gewichts-Rückführung, Default off) *(v1.43.0)*.
- **Server-seitiges Exit-Management** (Trailing/Time-Stop, OCO-Exklusivität
  als atomarer DB-Claim) *(v1.44.0)*.
- **Observability:** Firmen-Metriken, Auto-Circuit-Breaker (Drawdown/
  Tagesverlust/Verlustserie), Alert-Sinks, Heartbeat & Watchdog *(v1.45.0)*.
- **Markt-Regime-Klassifikator + Regime-Gate** für Strategie-Gewichtung
  (deterministisch, monitor-first) *(v1.46.0)*.
- **Datenqualitäts-Layer** (Gap/Outlier/Invalid/Duplicate/Cross-Check,
  deterministische Multi-TF-Aggregation, Stale-Guards) *(v1.47.0)*.
- **ATR-/Vol-basiertes Position-Sizing** + Korrelations-Cluster-Exposure-
  Limits im Order-Pfad (Fractional-Kelly-Deckel, monitor-first) *(v1.48.0)*.
- **LLM-Plausibilitäts-Schicht**, Prompt-Eval-Harness, Turn-Budget-Hartdeckel
  *(v1.49.0)*; **Reconciliation-Job** mit Differenz-Klassifikation und
  idempotenten Order-IDs *(v1.50.0)*.
- **Regelbasierte Backtesting-Engine** (GAP-01: Walk-Forward, Paper-Ausführung
  durch dieselbe `FillSimulator`-Klasse, fail-closed statt synthetischer
  Fallback) *(v1.51.0)*; Test- und Audit-Nachträge *(v1.51.1–v1.51.3)*.
- **25-Punkte-Roadmap-Audit 2026-09-20** mit 21 Remediation-Prompts
  *(v1.51.3)*; **persistente Backtest-Trades** als Trade-Level-Wahrheitsquelle
  *(v1.52.0)*; **Point-in-Time Feature Store** *(v1.53.0)*.

### Phase 3 — Perpetual-Daten, Forecasts, Attribution (v1.54.0–v1.59.0)

- **Historische Perpetual-Daten** (Funding, Open Interest, Liquidationen;
  as-of-Queries, Qualitäts-Layer, Sync-CLI) *(v1.54.0)*.
- **Forecast-Ledger** mit Brier-Score, Kalibrierung und idempotentem Resolver
  *(v1.55.0)*.
- **Venueübergreifendes Execution-Benchmarking** (append-only Quality-Ledger,
  echte Fill-Fakten, bounded Read-API) *(v1.56.0)*.
- **Deterministische Trade-PnL-Attribution** (Quellenbeiträge + Kosten +
  Residual = realisiertes Netto-PnL; immutable Entry-Snapshots v2) *(v1.57.0)*.
- **Event-Replay mit realistischen Friktionen** (Latenz, Depth, Impact,
  Funding, kein Look-ahead) *(v1.58.0)*.

### Phase 4 — Walk-Forward, Regime & Konfluenz (v1.60.0–v1.64.0)

- **Train-Select-Freeze-Test Walk-Forward** (Candidate-Vertrag, IS-Selektor,
  Freeze-Artefakte, Leakage-Protection, Holdout) *(v1.60.0)*.
- **Mehrdimensionale Regime-Erkennung** (point-in-time-sicher, Persistenz,
  Evaluation) *(v1.61.0)*.
- **Deterministische Multi-Timeframe-Konfluenz** (15m/1h/4h, fail-closed,
  Trusted-Data für die Analysten) *(v1.62.0)*.
- **Point-in-Time Cross-Sectional Momentum Ranking** *(v1.63.0)*.
- **Kalibrierbare strukturierte Sentiment-Outputs** (NEUTRAL vs. ABSTAIN,
  Syndikations-Deduplikation, Forecast-Envelope) *(v1.64.0)*.

### Phase 5 — Research, Execution & Risiko-Tiefen (v1.65.0–v1.73.1)

- **Prompt-Performance & Version-Metrikvergleich** (Brier/LogLoss/ECE/
  Attribution, gated Version-Vergleiche) *(v1.65.0)*.
- **Strukturierter Devil’s-Advocate-Agent** (adversale Falsifikation,
  fail-closed Abstention, nur defensive Risiko-Wirkung) *(v1.66.0)*.
- **Portfolio-Volatility-Targeting** (as-of-sichere Forecast-Volatilität,
  Multiplikator hart ≤ 1, Live & Backtest teilen den pure Kern) *(v1.67.0)*.
- **Hysteretisches Drawdown-Risk-Scaling** (Cashflow-bereinigter HWM,
  Sofort-Degradation, bestätigte Erholung, PAUSE-Veto) *(v1.68.0)*.
- **Versionierte Signal-Decay-Exits** (Entry-Snapshot vs. Current-Signal,
  default-off je Klasse, Safety-Exits vorrangig) *(v1.69.0)*.
- **Post-Only-Ausführung mit Market-Fallback** (versionierte Maker-Policy,
  bounded Repricing, idempotente Workflow-Keys, Paper-Simulation) *(v1.70.0)*.
- **TWAP- und Depth-aware Execution** (Parent/Child-Scheduler, Depth-Gates,
  kein Market-Chase) *(v1.71.0)*.
- **Reproduzierbare Monte-Carlo-/Trade-Resampling-Analyse** (IID/Block/
  Stationary-Bootstrap, Kostenstress, Ruin-Wahrscheinlichkeit) *(v1.72.0)*.
- **Strategy-Lifecycle mit Driftgates** (9-Zustands-Machine, immutables
  Evidence, Backtest↔Paper↔Live, Order-Gate) *(v1.73.0)*.
- **Roadmap-Audit-Closure:** 25-Punkte-Audit vollständig abgeschlossen
  (4 VERIFIED + 21 FIXED, 0 OPEN) *(v1.73.1)*.

---

## Versions-Zuordnung: v0.x.x ↔ v1.x.x

Das öffentliche v0.x.x-Schema beginnt am **2026-09-23** mit `v0.1.0`, das den
vollständigen Stand der internen Zählung `v1.73.1` (einschließlich aller
davor dokumentierten Beta-Releases) überträgt. Ältere Dokumente, Audit-Reports
und Archiv-Einträge nennen weiterhin die Legacy-Nummern; sie sind über diese
Zuordnung lesbar:

| Öffentlich (v0.x.x) | Intern (Legacy, v1.x.x) | Datum | Bedeutung |
| --- | --- | --- | --- |
| **v0.2.0** (Beta) | — | 2026-09-23 | Regel-Backtest mit Paper-Kosten, Workshop-Schritt 5, Trusted-Indikatoren |
| **v0.1.0** (Beta) | v1.73.1 | 2026-09-23 | Beta-Baseline: vollständiger Funktionsstand + Re-Versionierung/Struktur/Doku |

Legacy-Verweise auf `v1.40.0` … `v1.73.0` in Audits, Peers-Reviews und der
Dokumentation bezeichnen die jeweiligen Beta-Stände der Tabelle oben
(detailliert im Archiv-Changelog). Es gibt **keine** öffentliche Version `1.x` —
die Legacy-Zählung ist rein historisch.
