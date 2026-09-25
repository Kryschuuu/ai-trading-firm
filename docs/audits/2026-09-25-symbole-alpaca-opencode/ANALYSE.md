# Analyse 2026-09-25 — „nur 2 Symbole", ALPACA-Integration, Remote-Check, OpenCode-Free-Modelle

> **Status:** umgesetzt (Code) · **Version:** v0.4.x (Beta) · **Branch:**
> `arena/01a0d82c-ai-trading-firm` · **Kontext:** Arena-Auftrag 2026-09-25 —
> Beobachtungen aus dem Operations Center plus zwei Ausbauwünsche.
>
> **Kurzfassung:** Der Eindruck „nur 2 Symbole" ist **kein Bug, sondern eine
> Daten- und Prompt-Konsequenz**. Die ALPACA-Lücke war eine fehlende
> Aktivierung/Dokumentation des Datenpfads (Flag + Sync) — jetzt implementiert
> und messbar. Der Remote-Check ist per Default aus, weil er der einzige
> Netzwerkverkehr des Broker-Moduls ist (Sicherheits-Regel 4) — jetzt ohne
> Neustart per UI schaltbar, inkl. credential-freier Prüfung des
> Alpaca-Datenpfads. OpenCode Zen (kostenlose Cloud-Modelle) ist als Provider
> vollständig integriert und per UI-Schalter ein-/ausschaltbar.

---

## 1. Befund „irgendwie werden nur 2 Symbole gehandelt"

**Beobachtung (Control Pane):** Scanner-Funnel findet 34 Instrumente in der
Tagesrotation, 20 im Deep-Dive — aber es entstehen kaum Trades, und faktisch
laufen nur 1–2 Symbole (Muster: `BTC` aus dem Einzel-Mandat, `SPY`/`ETH`).
Warmup: 251/615 Instrumente data-ready, 207 ohne vollständige Datenbasis,
ALPACA „nie" synchronisiert mit 0/61 Kerzen.

**Ursachenkette (Code-belegt, keine Vermutung):**

| # | Ursache | Beleg im Code |
| --- | --- | --- |
| 1 | **Nur eine Venue hat Daten.** `npm run market:sync` lief ausschließlich für BITUNIX (250 Perps). ALPACA/IBKR/PAPER/BINANCE/KRAKEN = „nie synchronisiert" ⇒ für alle Aktien-, Index-, ETF-, Rohstoff- und FX-Mandate gibt es null Kerzen. | `scripts/market-sync.ts` (`--venue` genau eine Venue), `src/marketdata/syncStatus.ts` |
| 2 | **Der Agent sieht Marktdaten nur für EIN Symbol je Mission** (`focusSymbol` = Kandidat #1 nach 24h-Volumen). Alle weiteren Kandidaten stehen nur als Namen im Prompt. Ohne Daten ⇒ „keine Kerzendaten" ⇒ `HOLD`. | `src/lib/engine.ts` (`getCandles(symbolHint…)`), `src/lib/missionUniverse.ts` (`focusSymbolFor`) |
| 3 | **Scanner ≠ Handelsentscheidung.** Die Tagesrotation aus dem 14-Faktoren-Scan ist reine Anzeige/Diagnose; die Engine kennt nur das Missions-Universum (Registry-Segment, 8–12 Kandidaten). Es gibt **keinen Pfad**, der Scanner-Scores in Kandidaten oder Trades übersetzt. | `src/lib/engine.ts` importiert `src/scanner/**` nicht; Consumer von `getScan()` sind nur APIs/Ops |
| 4 | **Prompt-Kandidatenliste ist gedeckelt und volumen-sortiert** (`maxCandidates` 8–12). Instrumente ohne `volume24h` (ALPACA nach dem Enrichment-Ausfall) fallen ans Ende und werden abgeschnitten. | `src/lib/missionUniverse.ts` (`rankCandidateSymbols`) |
| 5 | **Risiko-Deckel begrenzen ohnehin auf wenige Positionen** (max. 5 parallel, 2 % Risiko, Cooldown nach 3 Verlusten, 1 Order je Agentenlauf). | `src/lib/riskGuard.ts`, `src/lib/engine.ts` |

**Fazit:** Es ist keine „2-Symbole-Sperre" im Code. Es ist die Kombination aus
**Datenlage** (nur Krypto hat Kerzen) + **Prompt-Design** (pro Mission wird genau
ein Instrument mit Indikatoren versorgt) + **Demomandaten** (BTC/SPY/ETH als
Einzel-Mandate). Wer mehr Instrumente handeln will, muss zuerst Daten schaffen —
genau der ALPACA-Punkt unten.

**Empfohlene nächste Schritte (nicht in diesem Auftrag umgesetzt):**

1. **Daten zuerst:** `npm run market:sync -- --venue=ALPACA|IBKR|PAPER --timeframes=15m,1h,1d`
   (Venue-Freigaben beachten). Erst wenn `--status` „data-ready" meldet, sind
   Aktien-Mandate überhaupt handelbar.
2. **Multi-Kandidat-Kontext:** Statt nur `focusSymbol` die Top-3–5 Kandidaten mit
   Mini-Snapshot (Preis, RSI, Trend, ATR%) in den Prompt schreiben (Kosten:
   zusätzliche `getCandles`-Aufrufe je Lauf, gedeckelt und gecacht).
3. **Fokus rotieren:** `focusSymbol` deterministisch je Zyklus über die
   Kandidaten rotieren (Round-Robin über den Zeitindex), damit eine Mission
   nicht dauerhaft dasselbe Instrument bewertet.
4. **Scanner → Mission (optional):** `SCAN_UNIVERSE`-Kandidaten zusätzlich nach
   Scanner-Score statt nur nach 24h-Volumen sortieren (Brücke
   `src/scanner/artifacts.ts` → `src/lib/missionUniverse.ts`).

---

## 2. ALPACA — was fehlte, was jetzt läuft

**Befund:** Der Broker-Adapter (`src/brokers/alpaca/**`) ist vollständig, die
Sync-Venue ist registriert (`src/marketdata/registerAdapters.ts`), das
Instrument-Preset (52 Werte) existiert — aber:

1. `.env.example` dokumentierte `ALPACA_ENABLED` **nicht** (nur Key/Secret/BaseURL).
   Ohne dieses Flag überspringt `registerAdapters()` die Venue komplett
   (`SkippedAdapter: FLAG_OFF`) — es entstehen **nie** Kerzen.
2. Der Handlungshinweis im Operations Center sagte pauschal
   `npm run market:sync -- --venue=BITUNIX`, auch wenn die worst offenders
   `ALPACA:…` waren — ein irreführender Behebungstext.
3. Der Health-Status `degraded/CREDENTIALS_REQUIRED` sagte nichts darüber, ob
   der **Datenpfad** (Yahoo) überhaupt funktioniert.

**Umgesetzt:**

* `.env.example`: vollständiger ALPACA-Block (Aktivierung, Paper-API,
  Sync-Kommando, Retry/HTTP-Optionen) + Hinweis in der Market-Data-Sektion.
* `docs/ALPACA.md` §1a: Datenversorgung inkl. Aktivierungsreihenfolge und
  Flag-Hinweis; §1b: Health-Semantik (was `syncSourceReachable` bedeutet).
* Venue-bewusster Sync-Hinweis (`buildReadinessHint`): nennt die Venues der
  worst offenders, ein Kommando je Venue (`--venue` nimmt genau eine), plus
  `<VENUE>_ENABLED=true`-Hinweis, wenn die Venue noch nie synchronisiert wurde.
* Remote-Check für ALPACA/IBKR (nur bei aktivem Remote-Schalter): credential-freie
  Probe der Sync-Quelle. Ergebnis **nie** `online` — Status bleibt `degraded`,
  `syncSourceReachable` ist der eigentliche Fakt, `syncSourceScope =
  "market-data-source"` macht den Prüfgegenstand unmissverständlich.

**Der Betriebs-Schritt bleibt beim Operator** (bewusst kein Auto-Sync):
`ALPACA_ENABLED=true` setzen und `npm run market:sync -- --venue=ALPACA` fahren.
Das ist in `.env.example`, `docs/ALPACA.md` und im UI-Hinweis dokumentiert.

---

## 3. Broker-Remote-Check — warum Default aus?

**Antwort aus dem Code** (`src/brokers/health.ts`): Der Remote-Check ist der
**einzige** Netzwerkzugriff des Broker-Moduls. Das Repo-Prinzip „kein
Netzwerk-I/O ohne ausdrückliche Betreiber-Entscheidung" (Regel 4, identisch
zum Market-Data-Sync-Gate) führt deshalb zu Default **AUS**. Zusätzlich ist der
lokale Health-Status vollständig: Remote-Checks liefern Zusatzinformationen
(Erreichbarkeit öffentlicher Endpunkte), keine Handelsfähigkeit.

**Neu:** Der Schalter ist ohne Prozess-Neustart umschaltbar
(Operations Center → „Broker Operations" → „Broker-Remote-Checks",
`PUT /api/ops/toggles`, Admin + CSRF, Audit `RUNTIME_FLAG_CHANGED`,
Persistenz `data/runtime/flags.json`). Priorität:
**UI-Flag → `BROKER_HEALTHCHECK_REMOTE` → Default aus**; die effektive Quelle
steht in `/api/brokers` und `/api/brokers/{venue}/health` als `source`.

---

## 4. OpenCode Zen (kostenlose Cloud-Modelle) — Umsetzung

* Neuer Provider `opencode` in `LlmProviderName` **und** `ProviderId`
  (Router kennt sonst keinen Provider): OpenAI-kompatibler Transport
  (`POST /chat/completions`, Bearer, `response_format`), Basis-URL
  `https://opencode.ai/zen/v1`, Key `OPENCODE_API_KEY`, Modell
  `OPENCODE_MODEL` (Default `big-pickle`).
* **Free-Modelle:** `OPENCODE_FREE_MODELS` als dokumentarischer Snapshot
  (promotional, ändert sich) + `isOpenCodeFreeModel()` für Anzeige/Diagnose —
  bewusst **kein** Filter (sonst würde ein Listen-Update Modelle still
  aussperren).
* **Kosten/Deckel:** 0 USD je 1M Token (`LLM_COST_OPENCODE_*` für bezahlte
  Zen-Modelle), Tagesdeckel `ROUTING_BUDGET_OPENCODE_TOKENS` (Policy 250 000) —
  Regel 3 gilt auch für gratis nutzbare Cloud-Provider.
* **Policy:** letzte Präferenz in `MODEL_C` + eigene Fallback-Ketten
  (`offline|timeout|quota:opencode`). Ohne Key ist die Karte `offline` ⇒
  **kein Verhaltenswechsel für bestehende Installationen**.
* **UI:** Panel „LLM-Provider-Schalter" (Operations Center → „LLM Operations")
  mit Schalter je Provider, Quelle (UI/.env/Default), Zeitstempel und Actor,
  plus „auf Default"-Reset. Aus = keine Aufrufe, kein Fallback, **kein
  Health-Ping** (vierfach durchgesetzt: Registry-Projektion, Router-Auswahl,
  Fallback-Kette, Health-Poller; `resolveProviderChain()` filtert zusätzlich
  den Direktpfad).

---

## 5. Verifikation

* `npm run typecheck`, `npm run lint`, `npm run build`, `npm run docs:validate` — grün.
* Testsuite: `npm test` (3660 Tests) — die drei initialen Roten sind behoben
  (`auditView`-Katalog für `RUNTIME_FLAG_CHANGED`, `brokerApi`-Erwartung für die
  Datenquellen-Prüfung, `brokerHealth`-Erwartungen).
* Neue/erweiterte Tests: `tests/runtimeFlags.test.ts` (14),
  `tests/ops.toggles.test.ts` (8), `tests/ui/RuntimeTogglesPanel.test.tsx` (2),
  `tests/llmProvider.test.ts` (+4 OpenCode), `tests/ops/collectMarketData.test.ts`
  (+2 Venue-Hinweis), `tests/brokerHealth.test.ts` (+3 Datenquelle),
  `tests/brokerApi.test.ts` (angepasst), `tests/routing.*` (Provider-Zahl 5).
