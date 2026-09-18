# Architecture Decision Records (ADR)

> **Stand:** 2026-09-18 · **Code-Version:** 1.40.0  
> **Verantwortlich:** `docs/roadmap/DECISIONS.md`

Dieses Dokument dokumentiert die verbindlichen architektonischen Entscheidungen, Annahmen und Invarianten des Gesamtsystems.

---

## ADR-001: Strikte Trennung von Interpretation, Berechnung und Risiko-Autorität

- **Status:** Angenommen & Verbindlich
- **Kontext:** LLMs neigen bei numerischen Aufgaben zu Halluzinationen und Nicht-Determinismus. Ein Trading-System erfordert jedoch absolute mathematische Reproduzierbarkeit und strikte Risikoeinhaltung.
- **Entscheidung:**
  1. **LLM = Interpretation:** LLMs generieren Thesen, analysieren Text/Sentiment und schlagen Setups vor (`isProposal: true`).
  2. **Mathematik = Berechnung:** Alle Kennzahlen (RSI, ATR, EMA, Renditen, Volatilität, Sharpe, Sortino, Drawdown, Portfoliogewichte) werden in reinem TypeScript/Mathematik berechnet.
  3. **Risk Engine = Autorität:** Die `riskGuard` und der Portfolio-Optimizer haben Vetorecht und kappen/blockieren jede Aktion, die Limits verletzt.
  4. **Code-Sicherheit:** Unbekannte Felder werden in Schemas strikt verworfen; externe Daten werden vor der Übergabe an LLMs als `untrusted_external_data` gewrappt.

---

## ADR-002: Deterministischer Scanner ohne Netzwerk- und Datenbank-I/O

- **Status:** Angenommen & Verbindlich
- **Kontext:** Das Scannen von 10.000+ Instrumenten darf weder externe APIs überlasten noch durch Netzwerkfluktuationen instabil werden.
- **Entscheidung:**
  - `src/scanner/` ist eine reine Funktionsbibliothek ohne Netzwerk-, DB- oder Uhrzeitabhängigkeit.
  - Alle Marktdaten werden vorab durch den `MarketDataSyncService` lokal synchronisiert (`data/universe/instruments.ndjson` und `data/history/candles.ndjson`).
  - Ein CI-Architekturtest (`tests/scanner.architecture.test.ts`) erzwingt die Importfreiheit von Netzwerk- und DB-Modulen.

---

## ADR-003: Atomare Mehrprozess-Order-Reservierung (`submitAtomic`)

- **Status:** Angenommen & Verbindlich
- **Kontext:** Bei parallelen Node.js-Prozessen (Next.js-Worker + Standalone Micro-Executor) bestand das Risiko von Race Conditions und doppelten Positionseröffnungen (Befund H2).
- **Entscheidung:**
  - Alle Order-Eröffnungen laufen über `PaperBroker.submitAtomic()` bzw. `withAccountLock`.
  - Verwendung von PostgreSQL `pg_advisory_xact_lock(hashtext(account))` zur Kontoserialisierung.
  - Vorab-Prüfung der echten DB-Wahrheit in `positions` (`status = 'OPEN'`).
  - DB-seitige Reservierung in `order_intents` mit partiellem Unique-Index (`UNIQUE (symbol) WHERE status = 'RESERVED'`).
  - Bei Unique-Konflikt erfolgt ein automatischer Rollback des In-Memory-Ledgers (Fail-Closed).

---

## ADR-004: Zentrale Singleton-Verwaltung über `stateRegistry.ts`

- **Status:** Angenommen & Verbindlich
- **Kontext:** Verstreute `globalThis`-Definitionen führten zu unübersichtlichen Zustandsdrifts und erschwerten saubere Test-Resets (Befund S2).
- **Entscheidung:**
  - Sämtliche prozessweiten Singletons und RAM-Caches sind typisiert in `src/lib/stateRegistry.ts` unter dem Namensraum `__AITF_STATE_REGISTRY__` gebündelt.
  - Tests nutzen ausschließlich `__resetAllSingletonsForTests()`, um den Urzustand deterministisch wiederherzustellen.

---

## ADR-005: 4-faches Live-Trading-Gate mit Single Point of Enforcement

- **Status:** Angenommen & Verbindlich
- **Kontext:** Versehentliches oder unberechtigtes Senden von Live-Orders an echte Börsen muss mit absoluter Sicherheit ausgeschlossen sein.
- **Entscheidung:**
  - `src/live-gate/enforcer.ts` (`assertLiveOrderAllowed`) ist der einzige Wächter vor jeder echten Order.
  - Vierfache Bedingung:
    1. Persistierter State-Machine-Zustand = `LIVE_ENABLED`
    2. Plattform-Flag `LIVE_TRADING_ENABLED=true`
    3. Venue-Flag `BITUNIX_LIVE_ENABLED=true`
    4. Human-Approval erfüllt (`REQUIRE_HUMAN_APPROVAL=false` oder Human-Gate passiert)
  - Zusätzlich: Gültiger CI-Security-Suite-Stamp (`passed: true`), aktiver Control-Plane-Zustand und inaktiver Kill-Switch (In-Memory + Disk-Failsafe).

---

## ADR-006: Schema-Version v2 für historische Kerzendaten mit Timeframe-Pflicht

- **Status:** Angenommen & Verbindlich
- **Kontext:** Im Legacy-Schema v1 fehlte die explizite Timeframe-Zuordnung in den Kerzenzeilen, was zum Mischen verschiedener Auflösungen in Analyse-Reihen führen konnte.
- **Entscheidung:**
  - `HistoricalStore` (`data/history/candles.ndjson`) nutzt Schema-Version **v2** mit Pflichtfeld `timeframe` aus der Allowlist (`1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `1d`, `5d`).
  - Logischer Primärschlüssel ist `instrumentId + timeframe + ts`.
  - Automatische Kompaktierung (`compact()`) auf max. 5.000 Kerzen je Reihe beim Batch-Append.
