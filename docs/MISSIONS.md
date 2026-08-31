# Missionen, Markt-Scans und Vorlagen

> **Version:** v1.35.0 · **Module:** `src/lib/missionTemplates.ts`,
> `src/lib/missionUniverse.ts`, `src/lib/workshop.ts`, `src/lib/seed.ts` ·
> **UI:** Dashboard → Reiter **🛠 Workshop** → *1 · Mission anlegen*

Eine Mission ist der Auftrag an die Firma — der wichtigste Hebel, noch vor der
Modellwahl ([HANDBUCH.md](HANDBUCH.md), Kapitel 5). Seit v1.35.0 gibt es dafür
einen Baukasten aus drei Bausteinen:

| Baustein | Frage | Wo |
| --- | --- | --- |
| **Missions-Typ** (`scope`) | Handelt die Firma **ein Symbol** oder scannt sie ein **Marktsegment**? | `missions.scope` |
| **Marktsegment** (`segment`) | *Welcher* Teil des Universums wird gescannt — alle Märkte, nur Indizes, nur Penny Stocks? | `missions.segment` |
| **Vorlage** (`templateId`) | Wiederverwendbare Blaupause mit fertigem Zieltext und passenden Budgets | `src/lib/missionTemplates.ts` |

---

## 1. Missions-Typen: ein Symbol oder ein Markt-Scan

Vor v1.35.0 hatte jede Mission genau ein Symbol. Aufträge wie „scanne alle
Märkte“ oder „handele nur Indizes“ ließen sich nicht ausdrücken — die beiden
Multi-Asset-Mandate des Seeds standen mit `symbol = NULL` in der Datenbank und
die Engine musste raten (`mission.symbol ?? "SPY"`).

Jetzt:

| `scope` | Pflichtfeld | Verhalten |
| --- | --- | --- |
| `SINGLE_SYMBOL` | `symbol` | Ein Instrument, z. B. `BTC`. Verhalten exakt wie vor v1.35.0. |
| `SCAN_UNIVERSE` | `segment` | Die Mission scannt ein Marktsegment. Kandidaten bestimmt die Instrument-Registry **zur Laufzeit**, nicht eine kopierte Liste. |

Der Default der Spalte ist `SINGLE_SYMBOL`; Alt-Installationen laufen nach
`npx drizzle-kit push` unverändert weiter (siehe [7. Migration](#7-migration-und-abwärtskompatibilität)).

### 1.1 Was eine Scan-Mission zur Laufzeit tut

`src/lib/missionUniverse.ts` beantwortet bei jedem Agenten-Lauf drei Fragen:

1. **Welche Märkte gehören zum Segment?** — `InstrumentRegistry.query()` mit dem
   Filter des Segments (`status=active`, `paperAvailable=true` plus
   Segment-Filter), danach Verdichtung auf eindeutige Symbole: der
   **PAPER-Spiegel** gewinnt, sortiert nach 24h-Volumen, gekürzt auf
   `maxCandidates` (8–12).
2. **Woran orientiert sich der Agent?** — das liquideste Segment-Mitglied wird
   das Fokus-Symbol für die Indikatoren (`EMA`, `RSI`, `ATR`).
3. **Darf das gewünschte Symbol gehandelt werden?** — ein `TRADE` auf ein Symbol
   außerhalb der Kandidatenliste wird von der Engine blockiert und auditiert:

| Audit-Grund | Bedeutung |
| --- | --- |
| `MISSION_SCOPE_VIOLATION` | Das Symbol liegt außerhalb des Mandats (z. B. `BTC` in einer Indizes-Mission). |
| `MISSION_SCOPE_EMPTY` | Das Segment liefert keine Kandidaten — dann wird **nichts** gehandelt (fail-closed). |

Beide Fälle stehen als `ORDER_REJECTED` im `audit_log` und erscheinen im Trace
des Laufs als Schritt **MISSIONS-MANDAT**.

> **Ausnahme (Legacy):** Eine `SINGLE_SYMBOL`-Mission *ohne* Symbol — also eine
> vor v1.35.0 angelegte Zeile, die zu keiner Vorlage passt — behält ihr altes
> Verhalten: Fokus `SPY`, keine Mandatsprüfung. Der Kontext meldet das als
> Warnung, damit der Zustand sichtbar bleibt.

Der Agenten-Prompt erhält bei Scan-Missionen vier zusätzliche Zeilen:

```text
UNIVERSUM: Indizes & ETFs — 2 Instrumente.
SEGMENT-REGEL: assetClass ∈ {index, etf} — Index-CFDs, Index-Futures und Index-ETFs der Registry.
KANDIDATEN: QQQ, SPY
Ein TRADE ist nur auf ein Symbol aus KANDIDATEN erlaubt; jedes andere Symbol wird von der Engine blockiert.
```

---

## 2. Marktsegmente

Neun Segmente stehen zur Auswahl. Die Spalte „Instrumente“ ist die Zahl, die
`GET /api/firm/missions` pro Segment live aus der Registry meldet — **0 heißt
„Daten fehlen“**, nicht „keine Chance“.

| ID | Name | Filter (Quelle: Instrument-Registry) | Vorschlag Risiko / Position |
| --- | --- | --- | --- |
| `ALL` | Alle Märkte | alle Anlageklassen, `status=active`, `paperAvailable=true` | 1 % / 10 % |
| `INDICES` | Indizes & ETFs | `assetClass ∈ {index, etf}` | 1 % / 20 % |
| `CRYPTO` | Krypto 24/7 | `assetClass = crypto` | 1,5 % / 15 % |
| `EQUITIES` | US-Aktien | `assetClass = equity` | 1 % / 20 % |
| `FX` | Devisen | `assetClass = fx` | 0,8 % / 15 % |
| `COMMODITIES` | Rohstoffe | `assetClass = commodity` | 0,8 % / 10 % |
| `PENNY` | Penny Stocks (< 5 USD) | `assetClass = equity`, Spot, Venue ≠ IBKR; **Kurs < 5 USD prüft der Screener** | 0,5 % / 5 % |
| `VOLATILE` | Hochvolatilität | beliebige Klasse, `volatility ≥ 0,60` | 0,6 % / 8 % |
| `LIQUID` | Top-Liquidität | `volume24h ≥ 10.000.000` | 1 % / 20 % |

Die Vorschlagswerte sind **Vorschläge**: Sie liegen immer innerhalb der
Code-Deckel `LIMIT_CEILINGS` (`src/lib/riskGuard.ts`) und werden beim Anlegen
ins Formular eingetragen — erzwingen tut sie `validateMissionInput()`.

### 2.1 Leere Segmente: die zwei Datenquellen

| Segment leer | Ursache | Abhilfe |
| --- | --- | --- |
| `INDICES`, `COMMODITIES`, `EQUITIES` (wenige Treffer) | Presets nicht geseedet — die mitgelieferte Registry enthält 26 Zeilen (Krypto, Aktien, ETFs, FX), also 15 eindeutige Symbole | `npm run universe:seed:markets` (354 Preset-Instrumente aus 50 Aktien, 50 Indizes, 22 Rohstoffen, 30 Kryptos inkl. Venue-/PAPER-Spiegeln; Upsert ergänzt die 26 des Basis-Seeds) |
| `VOLATILE`, `LIQUID` | Metriken `volatility` / `volume24h` sind `null` | `npm run market:sync` (Discovery + Enrichment, siehe [MARKET_DATA_PIPELINE.md](MARKET_DATA_PIPELINE.md)) |

Die UI zeigt beides direkt am Segment als Warnung mit dem passenden Befehl;
`GET /api/firm/missions` liefert die Zahlen als `segments[].instrumentCount`.
Gezählt werden **eindeutige Symbole**, nicht Registry-Zeilen: Dasselbe Asset auf
ALPACA, IBKR und PAPER zählt einmal. Die Segment-Auswahl im Workshop zeigt
deshalb exakt die Zahl, die später im Prompt als `UNIVERSUM: … — N
Instrumente` steht.

### 2.2 Penny Stocks: warum die Preisgrenze nicht in der Registry steht

Die Instrument-Registry führt **keine Kurse** (bewusst: keine Marktdaten in den
Stammdaten, siehe [MARKET_UNIVERSE.md](MARKET_UNIVERSE.md)). Die Grenze
„unter 5 USD“ prüft deshalb der Penny-Screener zur Laufzeit
(`src/lib/analysts.ts` → `runPennyScout`/`runPennyDiligence`, täglich nach
US-Schluss aus den Yahoo-Screenern `day_gainers`/`most_actives`). Das Segment
liefert die Grundmenge (US-Aktien, Spot, ohne IBKR-Futures), der Screener die
tatsächlichen Kandidaten. Der Hinweis steht als `runtimeFilterNote` im Tooltip.

---

## 3. Vorlagen: wiederverwendbare Blaupausen

18 Vorlagen liegen in `src/lib/missionTemplates.ts`; **14** davon werden bei der
Installation angelegt (`seeded: true`). Eine Vorlage enthält:

* Titel und **prüfbaren** Zieltext (Handbuch 5.2: „nicht in SQL prüfbar → zu vage“),
* Missions-Typ, Symbol bzw. Segment,
* Risikobudget und maximale Positionsgröße (immer innerhalb der Code-Deckel),
* Risikoprofil (`MINIMAL`, `DEFENSIV`, `AUSGEWOGEN`, `OFFENSIV`, `STRESS`),
* `successCriteria` — die SQL-Abfrage, mit der sich der Erfolg prüfen lässt,
* Drei-Ebenen-Hilfe (`kurzinfo` / `technischeInfo` / `risiko`).

**Vorlagen sind Blaupausen, keine laufenden Aufträge.** „In Formular übernehmen“
füllt das Formular; gespeichert wird erst durch „Mission anlegen“. Jedes Feld
bleibt editierbar, und `POST /api/firm/missions` akzeptiert eine Vorlage auch
direkt:

```bash
# Vollständige Mission aus einer Vorlage anlegen (leere Felder werden gefüllt):
curl -s -X POST localhost:3369/api/firm/missions \
  -H 'content-type: application/json' \
  -d '{"templateId":"indices-trend-follow"}'

# Vorlage mit eigenen Werten kombinieren — eigene Angaben gewinnen:
curl -s -X POST localhost:3369/api/firm/missions \
  -H 'content-type: application/json' \
  -d '{"templateId":"scan-all-markets","title":"Alle Märkte, nur 2 Setups","riskBudget":0.005}'
```

### 3.1 Die 14 Standard-Missionen

| # | Vorlage | Typ | Auftrag in einem Satz |
| --- | --- | --- | --- |
| 1 | `paper-btc-long-only` | Einzel-Symbol `BTC` | Pipeline validieren: nur Long, harte Grenzen. |
| 2 | `watch-spy` | Einzel-Symbol `SPY` | Referenzmarkt beobachten, nur bei klarem Trend handeln. |
| 3 | `swing-multi-asset` | Scan `ALL` | Swing-Setups über alle Märkte, 3–15 Handelstage, max. 3 Positionen. |
| 4 | `penny-desk-mini` | Scan `PENNY` | Spekulativ, aber eingehegt: 5 % Position, 0,5 % Risiko, Freigabepflicht. |
| 5 | `scan-all-markets` | Scan `ALL` | **Alle Märkte scannen**, höchstens 3 Setups pro Tag. |
| 6 | `indices-trend-follow` | Scan `INDICES` | **Nur Indizes/ETFs**, nur über der 50-Tage-Linie. |
| 7 | `crypto-momentum-247` | Scan `CRYPTO` | Krypto rund um die Uhr, gestaffelter Trend, ATR-Stop. |
| 8 | `equity-largecap-quality` | Scan `EQUITIES` | US-Large-Caps, höchstens ein Trade pro Tag. |
| 9 | `fx-mean-reversion` | Scan `FX` | Währungspaare nur an RSI-Extremen. |
| 10 | `commodities-trend` | Scan `COMMODITIES` | Rohstoffe mit halbiertem Risiko. |
| 11 | `volatile-half-risk` | Scan `VOLATILE` | Nur hochvolatile Märkte, 0,6 % Risiko, eine Position. |
| 12 | `liquidity-mandate` | Scan `LIQUID` | Nur Top-Liquidität, keine Metrik → kein Handel. |
| 13 | `eth-trend-defensive` | Einzel-Symbol `ETH` | Das Handbuch-Beispiel als Vorlage. |
| 14 | `baseline-hold` | Einzel-Symbol `SPY` | **Diagnose:** immer `HOLD` — misst JSON- und Prompt-Qualität. |

### 3.2 Vier Zusatzvorlagen (nicht Teil des Seeds)

| Vorlage | Zweck |
| --- | --- |
| `guardrail-stress-test` | Bewusst an den Code-Obergrenzen (5 % Risiko, 50 % Position) — beweist, dass `riskGuard`, Engine-Validierung und Broker-Schleuse blockieren. Nur Paper, nur mit geschlossenem Live-Gate. |
| `shortlist-only` | Research ohne Ausführung: Kandidaten als `REPORT`, niemals Orders. |
| `news-event-shield` | Keine Eröffnungen rund um Makro-Termine (Zins, CPI, Arbeitsmarkt). |
| `correlation-guard` | Maximal zwei offene Positionen, keine zwei mit Korrelation > 0,8. |

---

## 4. Workshop: der Weg über die UI

Dashboard → **🛠 Workshop** → *1 · Mission anlegen*:

1. **Vorlage wählen** — gruppiert nach Einstieg, Markt-Scans, Strategien,
   Diagnose; der Schalter „nur mitinstallierte“ zeigt die 14 Standard-Missionen.
2. **In Formular übernehmen** — Titel, Ziel, Missions-Typ, Symbol/Segment und
   Budgets werden eingetragen (nichts wird gespeichert).
3. **Missions-Typ prüfen** — Radiogruppe *Einzel-Symbol* / *Markt-Scan
   (Segment)*. Das Formular zeigt genau das Feld, das der Typ braucht.
4. **Segment prüfen** — bei Markt-Scans: Kandidatenzahl, Filterregel,
   Vorschlagsbudgets, Laufzeithinweis und die Drei-Ebenen-Hilfe. Bei `0`
   Instrumenten erscheint die Abhilfe (`universe:seed:markets` / `market:sync`).
5. **Speichern** — `POST` (neu) bzw. `PUT` (bearbeiten). Der Server validiert
   erneut; Budgets außerhalb der Code-Deckel werden abgelehnt.

Jedes Feld trägt ein **i**-Symbol: Hover oder Tastatur-Focus zeigt die Erklärung
(`src/components/workshop/InfoTip.tsx`), zusätzlich hängt der Text als
`sr-only`-Element im DOM und im nativen `title` — Screen Reader lesen ihn
unabhängig vom Hover-Zustand. Die ausführlichen Begriffserklärungen im
Drei-Ebenen-Schema stehen in [`docs/help/workshop.help.json`](help/workshop.help.json)
(Kurzinfo · technische Info · Risiko) und werden im Operations Center
(Sektion **Hilfe**) gezählt.

---

## 5. API

| Aufruf | Zweck |
| --- | --- |
| `GET /api/firm/missions` | Missionen + `symbols` + `limits` + `scopes` + `segments` (inkl. `instrumentCount`) + `templates` |
| `POST /api/firm/missions` | Anlegen; optional `templateId` zum Vorausfüllen |
| `PUT /api/firm/missions` | Bearbeiten (`id` = UUID der Mission) |
| `POST /api/seed` | Standard-Team + die 14 Missionen idempotent anlegen (meldet `missionsMigrated`) |

Beispielantwort (Auszug):

```bash
curl -s localhost:3369/api/firm/missions | jq '{scopes, segments: [.segments[] | {id, instrumentCount}], templates: (.templates | length)}'
```

```json
{
  "scopes": [
    { "id": "SINGLE_SYMBOL", "label": "Einzel-Symbol" },
    { "id": "SCAN_UNIVERSE", "label": "Markt-Scan (Segment)" }
  ],
  "segments": [
    { "id": "ALL", "instrumentCount": 15 },
    { "id": "INDICES", "instrumentCount": 2 },
    { "id": "COMMODITIES", "instrumentCount": 0 }
  ],
  "templates": 18
}
```

Validierungsregeln (identisch für UI, `curl` und Vorlagen):

* `scope` ∈ `SINGLE_SYMBOL | SCAN_UNIVERSE` (Default `SINGLE_SYMBOL`).
* `SINGLE_SYMBOL` → `symbol` Pflicht und in der Paper-Broker-Liste.
* `SCAN_UNIVERSE` → `segment` Pflicht, `symbol` muss leer sein.
* `riskBudget` ∈ [0,002 ; 0,05], `maxPositionPct` ∈ [0,01 ; 0,5] (Bruchteile).
* `templateId` muss im Katalog existieren.
* Weiche Warnungen (blockieren nicht): vager Zieltext, Scan-Zieltext ohne Zahl.

---

## 6. Datenmodell

```sql
-- src/db/schema.ts (Auszug)
scope        text NOT NULL DEFAULT 'SINGLE_SYMBOL',  -- SINGLE_SYMBOL | SCAN_UNIVERSE
segment      text,                                   -- ALL | INDICES | PENNY | … (nur bei SCAN_UNIVERSE)
template_id  text                                    -- Herkunftsvorlage (ohne FK, Katalog lebt im Code)
```

Bewusst **keine** FK-Beziehung auf einen Vorlagen-Tabellen: Der Katalog ist
Code (prüfbar, versioniert, testbar), nicht Daten. `template_id` ist reine
Herkunftsinformation.

---

## 7. Migration und Abwärtskompatibilität

```bash
git pull
npm ci
npx drizzle-kit push     # ergänzt missions.scope / .segment / .template_id
npm run build
sudo systemctl restart ai-trading-firm
```

* Bestehende Zeilen bekommen `scope = 'SINGLE_SYMBOL'` und `segment = NULL` —
  Einzel-Symbol-Missionen verhalten sich unverändert.
* `POST /api/seed` (bzw. „Seed / Reset“ im Dashboard) trägt bei Alt-Mandaten mit
  `symbol IS NULL` den Missions-Typ nach: `scope = 'SCAN_UNIVERSE'` plus das zur
  Vorlage gehörende Segment. Idempotent, eng gefasst (nur Titel einer
  Scan-Vorlage), und Budgets/Zieltexte bleiben unangetastet. Die Anzahl meldet
  die Antwort als `missionsMigrated`.
* Die vier historischen Missions-Titel bleiben unverändert — der Seed erkennt
  bestehende Installationen am Titel und legt nichts doppelt an.
* Inhaltlich geändert wurde nur der Zieltext der Vorlage
  `swing-multi-asset` (prüfbare Regeln ergänzt: Haltedauer 3–15 Handelstage,
  max. 3 offene Positionen, Stop 5–9 %). Bestehende Zeilen behalten ihre Fassung.

**Verhaltensänderung:** Ein `TRADE` auf ein Symbol außerhalb des Mandats wird
jetzt blockiert (`MISSION_SCOPE_VIOLATION`). Vor v1.35.0 hätte die Engine das
Symbol gehandelt, obwohl es nicht zur Mission gehörte.

---

## 8. Eigene Vorlagen hinzufügen

Eine neue Standard-Mission entsteht an **einer** Stelle — Seed, API, UI und
Doku ziehen automatisch nach:

```ts
// src/lib/missionTemplates.ts → MISSION_TEMPLATES
{
  id: "dax-momentum",                       // Slug, eindeutig, 3–64 Zeichen
  name: "DAX-Momentum",
  category: "MARKT_SCAN",
  scope: "SCAN_UNIVERSE",
  segment: "INDICES",
  symbol: null,
  title: "DAX & Co: Momentum nur mit Volumen",  // eindeutig (Seed-Idempotenz!)
  objective: "Nur Long auf Indizes, höchstens 2 Setups pro Tag, Stop 4–7 %, Einstieg nur mit 1,5-fachem Durchschnittsvolumen. Sonst HOLD.",
  riskBudget: 0.01,
  maxPositionPct: 0.15,
  riskProfile: "DEFENSIV",
  seeded: true,                              // true → Teil der Installation
  why: "…",
  successCriteria: "SELECT count(*) FROM positions WHERE mission_id = ? AND created_at >= date_trunc('day', now()) → ≤ 2",
  help: { kurzinfo: "…", technischeInfo: "…", risiko: "…" },
}
```

Danach: `npm run typecheck && npx tsx --test tests/missionTemplates.test.ts`
(prüft Eindeutigkeit, Deckel, Hilfe-Ebenen und dass die API-Validierung die
Vorlage akzeptiert) sowie `tests/missions.seed.test.ts` (prüft den
Installationszustand).

Ein **neues Segment** entsteht in `MISSION_SEGMENTS` derselben Datei: `id` in
`MISSION_SEGMENT_IDS` ergänzen, `universeQuery` (und optional `filter`) setzen,
`rule` als Klartext formulieren, Hilfe-Ebenen ausfüllen. Die Kandidaten liefert
dann automatisch die Registry.

---

## 9. Fehlerbilder

| Symptom | Ursache | Abhilfe |
| --- | --- | --- |
| `ORDER_REJECTED` / `MISSION_SCOPE_EMPTY` | Segment liefert keine Kandidaten | `npm run universe:seed:markets`, `npm run market:sync`; Segment im Workshop prüfen (Kandidatenzahl) |
| `ORDER_REJECTED` / `MISSION_SCOPE_VIOLATION` | Modell schlägt ein Symbol außerhalb des Mandats vor | Zieltext präzisieren; Prompt iterieren (Workshop Schritt 3) |
| `400 Markt-Scan braucht ein Segment` | `segment` fehlt oder unbekannt | `GET /api/firm/missions` → `segmentIds` |
| `400 Markt-Scan: Bitte kein Einzel-Symbol setzen` | Formular sendet `symbol` und `segment` | Missions-Typ sauber umschalten (das Formular leert das jeweils andere Feld) |
| `400 Vorlage „x“ ist unbekannt` | Tippfehler im Slug | `GET /api/firm/missions` → `templates[].id` |
| Scan-Mission findet „immer dasselbe“ | Segment zu breit (`ALL`) oder Metriken fehlen | Segment verengen (`LIQUID`, `INDICES`) bzw. `market:sync` laufen lassen |

---

## 10. Tests

| Datei | Deckt ab |
| --- | --- |
| `tests/missionTemplates.test.ts` | Katalog-Integrität: 14 Seed-Vorlagen, eindeutige IDs/Titel, Budgets innerhalb `LIMIT_CEILINGS`, Hilfe-Ebenen ≥ 20 Zeichen, DTOs, `applyMissionTemplate` |
| `tests/missionUniverse.test.ts` | Kandidaten-Ranking, Segment-Filter gegen eine echte Registry (Temp-Verzeichnis), Kontext-Auflösung, fail-closed bei leerem Segment |
| `tests/missions.seed.test.ts` | `defaultMissions()`: 14 Zeilen, eindeutige Titel, API-Validierung, historische Mandate |
| `tests/missions.api.test.ts` | Route-Contract: Vorlagen-Pfad, 400-Fälle, UUID-Pflicht, redaktierter 503 |
| `tests/missionsUi.render.test.ts` | Echte Komponenten: Vorlagen-Auswahl, Radiogruppe Missions-Typ, Segment-Badges, Tooltip-Texte im DOM |
| `tests/workshop.test.ts` | `validateMissionInput` inkl. Scope-/Segment-/Vorlagen-Regeln |

---

**Siehe auch:** [HANDBUCH.md](HANDBUCH.md) (Kapitel 5–6),
[MARKET_UNIVERSE.md](MARKET_UNIVERSE.md) (Instrument-Registry),
[CAPABILITIES.md](CAPABILITIES.md) (Handelbarkeit),
[ARCHITECTURE.md](ARCHITECTURE.md) (Makro-/Mikro-Zyklus),
[CHANGELOG.md](CHANGELOG.md) (v1.35.0).
