# Handbuch — Autonome KI-Trading-Firma

Bedienung, Beispiele und Notfallabläufe. Geschrieben für **Variante A** (alles auf dem
N150) und **Variante B** (N150 + Desktop als Modellserver). Unterschiede sind mit
`[A]` bzw. `[B]` markiert; alles Übrige gilt für beide.

**Voraussetzung:** Die Installation aus [INSTALL.md](INSTALL.md) ist abgeschlossen.

---

## Inhaltsverzeichnis

1. [Die Firma verstehen](#1-die-firma-verstehen)
2. [Das Dashboard](#2-das-dashboard)
3. [Erste Sitzung — geführtes Beispiel](#3-erste-sitzung--geführtes-beispiel)
4. [Steuerung über die API](#4-steuerung-über-die-api)
5. [Missionen schreiben](#5-missionen-schreiben)
6. [Prompts iterieren](#6-prompts-iterieren)
7. [Modelle wählen und wechseln](#7-modelle-wählen-und-wechseln)
8. [Broker anbinden](#8-broker-anbinden)
9. [Guardrails ändern](#9-guardrails-ändern)
10. [Notfall-Runbooks](#10-notfall-runbooks)
11. [Sicherheits-Checkliste vor echtem Geld](#11-sicherheits-checkliste-vor-echtem-geld)
12. [Diagnose und Leistungsmessung](#12-diagnose-und-leistungsmessung)
13. [Fragen, die du dir stellen solltest](#13-fragen-die-du-dir-stellen-solltest)
14. [Glossar](#14-glossar)

---

## 1. Die Firma verstehen

### 1.1 Die sechs Rollen

| Rolle | Name | Darf handeln? | Aufgabe |
| --- | --- | --- | --- |
| `CEO` | Lex | **nein** | legt Strategie fest, delegiert, gibt die Richtung vor |
| `RESEARCH` | Rhea | ja | liefert konkrete Setups mit Stop-Loss und Risikoscore |
| `BACKTEST` | Milo | nein | prüft Strategien; in der Paper-Phase nicht blockierend |
| `RISK_MANAGER` | Rigel | nein | unabhängige Zweitmeinung, darf ablehnen |
| `APPROVER` | Vega | nein | Stellvertreter des Menschen, gibt frei |
| `EXECUTOR` | Nova | ja | wandelt Freigaben in Orders |

Dass nur `RESEARCH` und `EXECUTOR` Orders auslösen dürfen, ist **im Code erzwungen**
(`engine.ts`), nicht bloß im Prompt formuliert. Ein CEO-Modell, das eine `TRADE`-Antwort
halluziniert, wird abgewiesen:

```
ORDER_REJECTED  ROLE_NOT_ALLOWED_TO_TRADE  {"role":"CEO"}
```

### 1.2 Der Weg einer Entscheidung

```
  Agenten-Turn
      │
      ├─ 0. Drawdown-Prüfung ........... > 15 %?  → Kill-Switch automatisch
      ├─ 1. Prompt an das Modell ....... System-Prompt + Missionskontext, JSON erzwungen
      ├─ 2. Antwort parsen ............. unlesbar → HOLD (nie raten!)
      ├─ 3. Protokollieren ............. agent_messages + audit_log
      │
      └─ bei type = "TRADE":
           ├─ Rolle darf handeln? ...... sonst BLOCKED
           ├─ Kill-Switch aus? ......... sonst BLOCKED
           ├─ Kurs vorhanden? .......... sonst BLOCKED
           ├─ Größe berechnen .......... riskAdjustedSize(), nicht das Modell!
           ├─ Vorschlag speichern ...... proposals (PENDING oder APPROVED)
           ├─ Guardrails ............... riskGuard.validateOrder()
           ├─ Broker-Schleuse .......... prüft alles erneut, unabhängig
           └─ Position + Audit-Eintrag
```

**Das Wichtigste:** Die **Positionsgröße bestimmt niemals das Modell.** Das Modell liefert
nur Richtung und Stop-Abstand; die Stückzahl rechnet `riskAdjustedSize()` aus Kapital,
Stop-Abstand und Risikobudget. Damit kann kein Zahlendreher im Modell-Output das Depot leeren.

### 1.3 Institutionelles Gedächtnis

| Tabelle | Inhalt | typische Frage |
| --- | --- | --- |
| `agent_messages` | jede Agentenäußerung mit Metadaten | „Was hat Rhea gestern begründet?" |
| `audit_log` | jede Entscheidung, jedes Guardrail-Urteil | „Warum wurde die Order abgelehnt?" |
| `proposals` | Ordervorschläge und ihr Freigabestatus | „Was wartet auf Freigabe?" |
| `positions` | offene und geschlossene Positionen | „Was liegt im Depot?" |
| `kill_switches` | Historie aller Not-Halte | „Wann und warum stand die Firma still?" |

Nach jedem Neustart lädt `getBroker()` offene Positionen und den Kill-Switch-Zustand aus
der Datenbank. Der Prozess ist zustandslos, die Firma nicht.

---

## 2. Das Dashboard

`http://localhost:3369`

### 2.1 Statusleiste

| Kachel | Bedeutung | Wann sie rot wird |
| --- | --- | --- |
| Paper-Equity | Cash + Marktwert der Positionen | – |
| Freies Cash | noch investierbar | – |
| Drawdown | Verlust gegenüber Startkapital | ab `maxEquityDrawdownPct` (15 %) |
| Offene Positionen | aktuell im Markt | – |
| Not-Halt | Kill-Switch-Zustand | wenn aktiv |
| Lokales LLM | Modellserver | wenn nur die Regel-Engine läuft |

> **„Regel-Engine" statt „Ollama"** heißt: Es antwortet gerade **kein Modell**. Das System
> arbeitet mit festen, konservativen Regeln weiter. Nützlich zum Testen — aber du testest
> dann die Pipeline, nicht die KI.

### 2.2 Die Knöpfe

* **▶▶ Ganze Pipeline** — lässt alle sechs Agenten der Reihe nach laufen; stoppt beim
  ersten `EXECUTED` oder `KILLED`. Der normale Weg.
* **▶ Run one turn** (im Tab *Agents*) — genau ein Agent. Der Weg zum Prompt-Debuggen.
* **Seed / Reset** — legt Team und Missionen an, wenn sie fehlen. Löscht nichts.
* **🛑 Not-Halt** — zieht den Kill-Switch **und stellt alle Positionen glatt**.

### 2.3 Die Reiter

* **Firm Overview** — Missionen, Positionen, Freigabe-Warteschlange, Audit-Verlauf.
* **Agents** — je Agent Rolle, Modell, Status, System-Prompt, Einzelstart.
* **🛠 Workshop** — Missionen anlegen/bearbeiten, einen Agenten einzeln ausführen,
  Prompt iterieren, Trefferquote messen. Das UI-Pendant zu Kapitel 5 und 6 —
  alle vier Schritte ohne Terminal. Jedes Feld hat ein **i**-Symbol mit Kurz-
  Erklärung (auch per Tastatur erreichbar).
* **Risk & Guardrails** — die harten Limits, LLM-Status, Not-Halt-Historie.
* **Design Decisions** — die Architekturbegründungen in Kurzform.

---

## 3. Erste Sitzung — geführtes Beispiel

Ein kompletter Durchlauf mit erwarteten Ausgaben. Rechne bei Variante A mit einigen
Minuten Wartezeit, bei Variante B mit unter einer Minute.

### Schritt 1 — Grundzustand prüfen

```bash
curl -s localhost:3369/api/firm | jq '{
  equity: .account.equity,
  cash: .account.freeCash,
  positionen: .account.openPositions,
  notHalt: .killSwitchArmed,
  llm: {provider: .ollama.provider, da: .ollama.available}
}'
```

```json
{
  "equity": 10000,
  "cash": 10000,
  "positionen": 0,
  "notHalt": false,
  "llm": { "provider": "ollama", "da": true }
}
```

### Schritt 2 — Mission auswählen

```bash
curl -s localhost:3369/api/firm | jq -r '.missions[] | "\(.id)  \(.status)  \(.title)"'
```

```
7f3a…  PENDING  Erste Paper-Mission: BTC Long-Only
b21c…  PENDING  Beobachtungsmandat: SPY
```

```bash
MISSION=$(curl -s localhost:3369/api/firm | jq -r '.missions[0].id')
```

### Schritt 3 — Pipeline starten

```bash
curl -s -X POST localhost:3369/api/firm/run \
  -H 'Content-Type: application/json' \
  -d "{\"missionId\":\"$MISSION\",\"pipeline\":true}" \
| jq '.pipeline[] | {rolle: .role, status: .result.status, quelle: .result.source, ms: .result.latencyMs, grund: .result.decision.reason}'
```

```json
{
  "rolle": "CEO",
  "status": "REPORT",
  "quelle": "ollama",
  "ms": 5120,
  "grund": "Strategie bestätigt: nur Long in BTC, Stop-Loss verpflichtend."
}
{
  "rolle": "RESEARCH",
  "status": "EXECUTED",
  "quelle": "ollama",
  "ms": 4830,
  "grund": "BTC über gleitendem Durchschnitt, Volumen bestätigt. Setup mit 5 % Stop."
}
```

### Schritt 4 — Was ist rechnerisch passiert?

```bash
curl -s localhost:3369/api/firm | jq '.account'
```

```json
{
  "equity": 9997.5,
  "freeCash": 7497.53,
  "drawdownPct": 0.02,
  "openPositions": 1,
  "livePositions": [
    {
      "symbol": "BTC",
      "side": "LONG",
      "qty": 0.037313,
      "entryPrice": 67067,
      "stopLoss": 63650,
      "lastPrice": 67000,
      "unrealizedPnl": -2.5
    }
  ]
}
```

Nachgerechnet — jede Zahl lässt sich von Hand prüfen:

```
Risikobudget der Mission ....... 2 % von 10.000 $  = 200 $ maximaler Verlust
Stop-Abstand des Modells ....... 5 %
Rechnerische Größe ............. 200 $ ÷ 0,05      = 4.000 $
Positionsobergrenze ............ 25 % von 10.000 $ = 2.500 $   ← greift
Tatsächliches Notional ......... 2.500 $
Stückzahl ...................... 2.500 $ ÷ 67.000 $ = 0,037313 BTC
Ausführungskurs ................ 67.000 $ × 1,001  = 67.067 $  (0,1 % Slippage)
Bezahlt ........................ 0,037313 × 67.067 = 2.502,47 $
Freies Cash .................... 10.000 − 2.502,47 = 7.497,53 $
Marktwert der Position ......... 0,037313 × 67.000 = 2.499,97 $
Equity ......................... 7.497,53 + 2.499,97 = 9.997,50 $
Stop-Loss ...................... 67.067 $ × 0,95   = 63.650 $
```

Der Verlust von 2,50 $ ist reiner Slippage — genau das, was ein Paper-Broker abbilden soll.

Der Guardrail hat den Vorschlag also **von 4.000 auf 2.500 $ gedeckelt** — ohne dass ein
Agent davon wusste oder zustimmen musste.

### Schritt 5 — Protokoll lesen

```bash
curl -s localhost:3369/api/firm | jq -r '.auditLog[] | "\(.level)  \(.event)"' | head -8
```

```
INFO  ORDER_SENT
INFO  AGENT_DECISION
INFO  AGENT_DECISION
```

### Schritt 6 — Guardrails bewusst auslösen

**6a — Die Mission fordert 90 % Risiko.** Ein Auftrag darf alles Mögliche verlangen; der
Code begrenzt es trotzdem.

```bash
psql "$DATABASE_URL" -c "UPDATE missions SET risk_budget='0.90' WHERE id='$MISSION';"

# Position erst schließen, sonst greift die Nachkaufsperre aus 6b
psql "$DATABASE_URL" -c "UPDATE positions SET status='CLOSED' WHERE status='OPEN';"
sudo systemctl restart ai-trading-firm    # oder Dienst neu starten

curl -s -X POST localhost:3369/api/firm/run \
  -H 'Content-Type: application/json' \
  -d "{\"missionId\":\"$MISSION\",\"pipeline\":true}" >/dev/null

curl -s localhost:3369/api/firm | jq '.account.livePositions[0] | {qty, entryPrice}'
```

Ergebnis: **exakt dieselbe Positionsgröße wie vorher** (0,037313 BTC). Die Mission durfte
90 % verlangen — `riskAdjustedSize()` hat auf die harten 25 % gedeckelt, bevor überhaupt
eine Order entstand. Nachzulesen in `src/lib/riskGuard.ts`:

```ts
const size   = (equity * riskBudgetPct) / riskPerUnit;   // 89.977 $ gewünscht
const sizeCap = equity * RISK_LIMITS.maxPositionPct;     //  2.499 $ erlaubt
return Math.min(size, sizeCap);                          //  ← Deckel greift
```

Zurücksetzen:

```bash
psql "$DATABASE_URL" -c "UPDATE missions SET risk_budget='0.02' WHERE id='$MISSION';"
```

**6b — Zweimal dieselbe Position eröffnen.** Lass die Pipeline direkt ein zweites Mal laufen:

```bash
curl -s -X POST localhost:3369/api/firm/run \
  -H 'Content-Type: application/json' \
  -d "{\"missionId\":\"$MISSION\",\"pipeline\":true}" \
| jq '.pipeline[] | {rolle: .role, status: .result.status, grund: .result.guardrail}'
```

```json
{ "rolle": "CEO",          "status": "REPORT",  "grund": null }
{ "rolle": "RESEARCH",     "status": "BLOCKED", "grund": "POSITION_ALREADY_OPEN:BTC (kein Nachkauf erlaubt)" }
{ "rolle": "BACKTEST",     "status": "REPORT",  "grund": null }
{ "rolle": "RISK_MANAGER", "status": "REPORT",  "grund": null }
{ "rolle": "APPROVER",     "status": "REPORT",  "grund": null }
{ "rolle": "EXECUTOR",     "status": "BLOCKED", "grund": "POSITION_ALREADY_OPEN:BTC (kein Nachkauf erlaubt)" }
```

Hier siehst du zwei Dinge auf einmal:

* Die Pipeline **bricht bei `BLOCKED` nicht ab** — sie läuft weiter und lässt auch den
  Executor gegen dieselbe Wand laufen. Abgebrochen wird nur bei `EXECUTED` (Ziel erreicht)
  oder `KILLED` (Not-Halt). So siehst du im Protokoll, welche Agenten dieselbe Fehleinschätzung
  teilen.
* Ohne die Nachkaufsperre würde jeder Durchlauf die Position aufstocken und schleichend
  das ganze Konto binden — ein klassischer Fehler bei Agenten, die im Minutentakt
  dieselbe Idee haben.

Position schließen, um wieder handelsfähig zu werden:

```bash
psql "$DATABASE_URL" -c "UPDATE positions SET status='CLOSED' WHERE status='OPEN';"
sudo systemctl restart ai-trading-firm
```

**6c — Eine Rolle, die nicht handeln darf.** Lass den CEO einzeln laufen und provoziere
eine Handelsentscheidung:

```bash
CEO=$(curl -s localhost:3369/api/firm | jq -r '.agents[] | select(.role=="CEO") | .id')
curl -s -X POST localhost:3369/api/firm/run \
  -H 'Content-Type: application/json' \
  -d "{\"agentId\":\"$CEO\",\"missionId\":\"$MISSION\"}" | jq '.result.guardrail'
```

Sobald das CEO-Modell `type: "TRADE"` liefert, erscheint:

```
"Rolle CEO darf keine Orders auslösen"
```

**Das Muster hinter allen drei Fällen:** Die Grenze steht nicht im Prompt, sondern im Code.
Ein Modellwechsel, ein neuer Prompt oder ein manipulierter Missionstext ändern daran nichts.

### Schritt 7 — Not-Halt üben

```bash
curl -s -X POST localhost:3369/api/firm/kill \
  -H 'Content-Type: application/json' \
  -d '{"arm":true,"flatten":true,"reason":"Übung"}' | jq
```

```json
{ "ok": true, "killSwitchArmed": true, "closedPositions": 1 }
```

Jeder weitere Versuch:

```json
{ "status": "BLOCKED", "guardrail": "KILL_SWITCH_ARMED" }
```

Entschärfen:

```bash
curl -s -X POST localhost:3369/api/firm/kill \
  -H 'Content-Type: application/json' -d '{"arm":false}' | jq
```

---

## 4. Steuerung über die API

### 4.1 Übersicht

| Methode | Pfad | Nutzlast | Antwort |
| --- | --- | --- | --- |
| `GET` | `/api/health` | – | Statusobjekt |
| `GET` | `/api/firm` | – | kompletter Firmenzustand |
| `POST` | `/api/seed` | – | `{ok, seeded}` |
| `POST` | `/api/firm/run` | `{agentId, missionId}` | `{ok, result}` |
| `POST` | `/api/firm/run` | `{missionId, pipeline:true}` | `{ok, pipeline:[…]}` |
| `POST` | `/api/firm/kill` | `{arm, flatten?, reason?}` | `{ok, killSwitchArmed}` |
| `GET` | `/api/firm/missions` | – | `{ok, missions, symbols, limits}` |
| `POST` | `/api/firm/missions` | `{title, objective, symbol, riskBudget, maxPositionPct, status?}` | `{ok, mission, warnings?}` |
| `PUT` | `/api/firm/missions` | `{id, …felder wie POST}` | `{ok, mission, warnings?}` |
| `PUT` | `/api/firm/agents` | `{agentId, systemPrompt}` | `{ok, agent, warnings?}` |
| `GET` | `/api/docs?name=…` | – | `{content}` (Markdown) |

> **Workshop-Endpunkte:** Die drei Missions-/Agenten-Routen sind die Grundlage
> des Workshop-Tabs. `riskBudget`/`maxPositionPct` werden gegen die
> Code-Grenzen (`LIMIT_CEILINGS`) validiert — 90 % Risiko wird mit 400
> abgelehnt, nicht erst vom Broker blockiert. `PUT /api/firm/agents` ändert
> **nur** den Prompt: Guardrails bleiben über die API unantastbar.

### 4.2 Nützliche Abfragen

**Nur die Agentenliste mit Modellen:**

```bash
curl -s localhost:3369/api/firm | jq -r '.agents[] | "\(.role)\t\(.model)\t\(.status)"' | column -t
```

**Einzelnen Agenten starten (zum Prompt-Debuggen):**

```bash
AGENT=$(curl -s localhost:3369/api/firm | jq -r '.agents[] | select(.role=="RESEARCH") | .id')
MISSION=$(curl -s localhost:3369/api/firm | jq -r '.missions[0].id')

curl -s -X POST localhost:3369/api/firm/run \
  -H 'Content-Type: application/json' \
  -d "{\"agentId\":\"$AGENT\",\"missionId\":\"$MISSION\"}" | jq '.result'
```

**Wie lange braucht welche Rolle?**

```bash
psql "$DATABASE_URL" -A -F$'\t' -c "
SELECT a.role,
       count(*)                                        AS turns,
       round(avg((m.meta->>'latencyMs')::numeric)/1000, 1) AS avg_sek,
       count(*) FILTER (WHERE m.meta->>'source' = 'fallback') AS regel_engine
FROM agent_messages m JOIN agents a ON a.id = m.agent_id
GROUP BY a.role ORDER BY avg_sek DESC;"
```

Beispielausgabe Variante A:

```
role           turns  avg_sek  regel_engine
CEO            12     41.2     0
RESEARCH       12     38.7     0
RISK_MANAGER   9      35.1     1
```

Über 60 Sekunden pro Turn heißt: Modell eine Stufe kleiner wählen oder auf Variante B gehen.

**Alle Ablehnungen der letzten 24 Stunden:**

```bash
psql "$DATABASE_URL" -c "
SELECT created_at::time(0), event, detail->>'reason' AS grund
FROM audit_log
WHERE level IN ('WARN','CRITICAL') AND created_at > now() - interval '24 hours'
ORDER BY created_at DESC;"
```

**Offene Vorschläge (bei aktivem Freigabezwang):**

```bash
psql "$DATABASE_URL" -c "
SELECT id, detail->>'symbol' AS symbol, risk_score, status, created_at::time(0)
FROM proposals WHERE status='PENDING' ORDER BY created_at DESC;"
```

---

## 5. Missionen schreiben

Eine Mission ist der Auftrag an die Firma. Sie ist der wichtigste Hebel, den du hast — **noch
vor** der Modellwahl.

> **Der Weg über die UI (empfohlen):** Dashboard → Reiter **🛠 Workshop** →
> *1 · Mission anlegen*. Formular ausfüllen, speichern, fertig — das i-Symbol
> an jedem Feld erklärt Bedeutung und erlaubte Werte. Das Terminal braucht es
> dafür nicht mehr.

### 5.1 Anlegen

**Über die Oberfläche (Workshop):** Titel, Ziel, Symbol (Autocomplete aus der
Broker-Liste), Risikobudget in Prozent und maximale Positionsgröße in Prozent
eingeben und „Mission anlegen“ klicken. Der Server prüft alles noch einmal:
ungültige Symbole, Budgets außerhalb der Code-Grenzen und leere Titel werden
mit einer klaren Fehlermeldung zurückgewiesen, vage Zieltexte („Maximiere …“)
mindestens markiert. Bearbeiten geht über „Bearbeiten“ in der Missionsliste —
Speichern läuft dann als `PUT` auf denselben Eintrag.

**Alternative über das Terminal:**

```bash
psql "$DATABASE_URL" <<'SQL'
INSERT INTO missions (title, objective, symbol, risk_budget, max_position_pct, status)
VALUES (
  'ETH Trendfolge, defensiv',
  'Nur Long in ETH und nur bei klarem Aufwärtstrend. Stop-Loss zwischen 4 und 7 Prozent. '
  'Keine Nachkäufe. Bei unklarer Lage HOLD antworten statt zu handeln. '
  'Ziel ist Prozesstreue, nicht Rendite.',
  'ETH', 0.01, 0.15, 'PENDING'
);
SQL
```

### 5.2 Was eine gute Mission ausmacht

Die Beispieltabelle steht auch direkt im Workshop neben dem Formular — dort
samt Faustregel als Nachschlagkasten mit Hover-Erklärungen.

| Schlecht | Warum | Besser |
| --- | --- | --- |
| „Maximiere den Gewinn" | kein Abbruchkriterium, lädt zum Zocken ein | „Maximal ein Trade pro Tag, Stop 5 %" |
| „Handle clever" | nicht überprüfbar | „Nur Long, nur wenn Kurs über 20-Tage-Linie" |
| „Nutze alle Mittel" | widerspricht den Guardrails | „Maximal 15 % des Kapitals" |
| „Sei vorsichtig" | Interpretationssache | „Bei Unsicherheit HOLD antworten" |

Faustregel: **Wenn du nicht in einer SQL-Abfrage prüfen kannst, ob die Mission erfüllt
wurde, ist sie zu vage formuliert.**

### 5.3 Verfügbare Symbole

Der Paper-Broker kennt: `BTC`, `ETH`, `SOL`, `SPY`, `QQQ`, `NVDA`, `AAPL`, `MSFT`.
Das Workshop-Formular bezieht seine Autocomplete-Liste direkt vom Server
(`GET /api/firm/missions` → `symbols`) und akzeptiert nur diese Symbole.
Weitere Symbole in `STATIC_PRICES` (`src/lib/marketData.ts`, dort liegt die
Paper-Preisliste) ergänzen — nach dem Neu bauen kennt sie die UI automatisch.

**Abkürzung zum Nachschlagen über das Terminal:**

```bash
curl -s localhost:3369/api/firm/missions | jq -r '.symbols[]'
```

---

## 6. Prompts iterieren

Der Rat aus dem Video — *präzise Instruktionen statt Vertrauen in die KI* — ist hier die
zentrale Arbeit. So gehst du systematisch vor.

> **Der Weg über die UI (empfohlen):** Der Reiter **🛠 Workshop** bildet die
> komplette Schleife aus 6.1 als vier Schritte ab — *Agent ausführen* (6.2),
> *Prompt iterieren* (6.3), *Trefferquote* (6.4). Die Reihenfolge bleibt
> gleich: **ein Agent pro Test, eine Änderung pro Iteration.**

### 6.1 Die Schleife

```
1. EINEN Agenten einzeln laufen lassen         ← nie die ganze Pipeline zum Debuggen
2. Antwort im Protokoll ansehen
3. GENAU EINE Sache am Prompt ändern
4. Zehnmal wiederholen, Trefferquote zählen
5. Erst dann weiter zum nächsten Agenten
```

### 6.2 Rohantwort eines Agenten ansehen

**Über die Oberfläche (Workshop → „2 · Agent ausführen“):** Agent und Mission
auswählen, „Turn starten“ klicken. Rechts erscheinen die **letzten drei
Agenten-Nachrichten** mit Name, Rolle, Quelle („Modell“ bzw. „Regel-Engine“)
und Latenz; aufklappbar bis zur Roherentwort des Modells. Links steht die
geparste Entscheidung mit Hover-Erklärungen zu `type`, `side`, `stopLossPct`,
`riskScore` — plus der kompletten Guardrail-Kette des Turns.

**Alternative über das Terminal:**

```bash
psql "$DATABASE_URL" -c "
SELECT a.name, m.content, m.meta->>'source' AS quelle, m.meta->>'latencyMs' AS ms
FROM agent_messages m JOIN agents a ON a.id = m.agent_id
ORDER BY m.created_at DESC LIMIT 3;"
```

### 6.3 Prompt ändern

**Über die Oberfläche (Workshop → „3 · Prompt iterieren“):** Agent auswählen —
der Editor lädt den aktuellen `system_prompt` aus der Datenbank. Der Kasten
rechts zeigt das Soll-JSON-Format mit vollständigem Beispiel und
Feld-für-Feld-Erklärungen (`type`, `side`, `stopLossPct`, `riskScore` …); per
Knopf hängt du das Beispiel an den Prompt an. Nach dem Speichern bestätigt ein
grüner Kasten den Datenbankstand — und der Server warnt, wenn der Prompt
„JSON“ oder ein Beispiel-Objekt nicht mehr erwähnt.

**Alternative über das Terminal:**

```bash
psql "$DATABASE_URL" <<'SQL'
UPDATE agents SET system_prompt =
'Du bist Marktanalystin einer Trading-Firma.

ANTWORTFORMAT — ausschließlich dieses JSON, kein Fließtext, keine Code-Fences:
{"type":"TRADE"|"HOLD","symbol":"<SYMBOL>","side":"LONG","stopLossPct":<2-10>,"reason":"<max 20 Wörter>","riskScore":<0.0-1.0>}

REGELN:
- side ist immer "LONG". Shorts sind gesperrt.
- stopLossPct liegt zwischen 2 und 10.
- Bei unklarer Lage: {"type":"HOLD","reason":"..."}.
- Erfinde niemals Kurse oder Kennzahlen.
- Keine Erklärung außerhalb des JSON.'
WHERE role = 'RESEARCH';
SQL
```

Änderungen wirken **sofort** — kein Neubau nötig, weil Prompts in der Datenbank stehen.
(Guardrails dagegen brauchen einen Neubau. Das ist der Unterschied zwischen weicher und
harter Schicht. Genau deshalb bietet der Workshop bewusst **nur** den Prompt-Editor und
keine Guardrail-Regler.)

### 6.4 Trefferquote messen

**Über die Oberfläche (Workshop → „4 · Trefferquote“):** Agent und Mission
auswählen, Durchläufe (1–20, Standard 10) einstellen, starten. Die Schleife
läuft sequenziell — jeder Turn wird sofort klassifiziert und das
Balkendiagramm (**TRADE / HOLD / HOLD · kaputtes JSON / ERROR / ANDERE**)
aktualisiert sich live. Taucht „kaputtes JSON“ gehäuft auf (ab 2 Fällen und
mindestens 20 %), blendet das Panel automatisch die vier Debug-Tipps von unten
ein; fehlgeschlagene Läufe stehen rot markiert in der Liste darunter und
verlinken ins Protokoll-Tab.

**Alternative über das Terminal:**

```bash
for i in $(seq 1 10); do
  curl -s -X POST localhost:3369/api/firm/run \
    -H 'Content-Type: application/json' \
    -d "{\"agentId\":\"$AGENT\",\"missionId\":\"$MISSION\"}" \
  | jq -r '.result.decision.type'
done | sort | uniq -c
```

```
      8 TRADE
      2 HOLD
```

> **Hinweis zum Rate-Limit:** Schreib-Requests sind auf 60/60 s begrenzt
> (`FIRM_RATE_LIMIT`). 20 Läufe plus ein paar Speicherungen passen in ein
> Fenster; wer mehr messen will, erhöht das Limit oder misst in Etappen.

Erscheint häufig `HOLD` mit der Begründung *„Antwort des Modells war kein gültiges JSON"*,
liefert dein Modell kaputtes JSON. Dann:

1. **Format erzwingen** — passiert bereits automatisch (`format: "json"` bzw.
   `response_format`), aber nur, wenn der Server es unterstützt.
2. **Prompt kürzen** — kleine Modelle verlieren bei langen System-Prompts die Struktur.
3. **Beispiel mitgeben** — ein einziges vollständiges JSON-Beispiel wirkt Wunder.
4. **Modell wechseln** — `qwen2.5` ist bei JSON verlässlicher als die meisten 3B-Alternativen.

### 6.5 Erfahrungswerte

| Modellgröße | JSON-Trefferquote (mit erzwungenem Format) | Einschätzung |
| --- | --- | --- |
| 1,5B Q4 | 70–85 % | nur für Formattests |
| 3B Q4 | 90–96 % | brauchbar für feste Aufgaben `[A]` |
| 7B Q4 | 96–99 % | Arbeitspferd `[B]` |
| 14B Q4 | ~99 % | CEO-Rolle, längere Begründungen `[B]` |

Restfehler sind unkritisch: nicht parsebare Antworten werden zu `HOLD`, nie zu einem Trade.

---

## 7. Modelle wählen und wechseln

### 7.1 Wechsel im laufenden Betrieb

```bash
# Modell für eine einzelne Rolle ändern
psql "$DATABASE_URL" -c "UPDATE agents SET model='qwen2.5:7b-instruct-q4_K_M' WHERE role='CEO';"

# Modell für alle Rollen
psql "$DATABASE_URL" -c "UPDATE agents SET model='qwen2.5:3b-instruct-q4_K_M';"
```

Kein Neustart nötig — beim nächsten Turn gilt das neue Modell.

> **Provider wechseln (v1.3.0).** Neben Ollama unterstützt die Provider-Schicht jeden
> OpenAI-kompatiblen Endpunkt (`LLM_PROVIDER=openai`), Google Gemini
> (`LLM_PROVIDER=gemini` + `GEMINI_API_KEY`) und Anthropic Claude
> (`LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`). Optional mit Fallback-Kette
> `LLM_FALLBACK_PROVIDERS=gemini,anthropic`. Details, Retries und Kostenrechnung:
> **[PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md)**.

### 7.2 Empfehlung nach Rolle

| Rolle | `[A]` Solo-Node | `[B]` Split-Node | Begründung |
| --- | --- | --- | --- |
| CEO | `qwen2.5:3b-instruct-q4_K_M` | `qwen2.5:14b-instruct-q4_K_M` | koordiniert, braucht die meiste Nuance |
| Research | `qwen2.5:3b-instruct-q4_K_M` | `qwen2.5:7b-instruct-q4_K_M` | häufigste Rolle → Tempo zählt |
| Backtest | `qwen2.5:3b-instruct-q4_K_M` | `qwen2.5-coder:7b` | schreibt Code, kein Fließtext |
| Risk | `qwen2.5:3b-instruct-q4_K_M` | `qwen2.5:7b-instruct-q4_K_M` | Prüfaufgabe, Format wichtiger als Kreativität |
| Approver | `qwen2.5:3b-instruct-q4_K_M` | `qwen2.5:7b-instruct-q4_K_M` | binäre Entscheidung |
| Executor | `qwen2.5:1.5b-instruct-q4_K_M` | `qwen2.5:7b-instruct-q4_K_M` | reine Formatumwandlung, darf klein sein |

### 7.3 Warum DeepSeek Coder nicht orchestrieren sollte

Coder-Modelle sind auf Code-Vervollständigung optimiert. In Entscheidungsketten zeigen sie
typischerweise:

* Neigung, Code auszugeben, wo eine Entscheidung gefragt war,
* schwächere Befolgung mehrstufiger Regeln in Prosa,
* mehr Erfindungen bei fehlendem Kontext („plausibler Code" statt „ich weiß es nicht").

Einsatz also: **Backtest-Agent** (Testskripte, Adaptercode) — dort ist ein Coder-Modell
tatsächlich die bessere Wahl. Für CEO, Risk und Approver gehören Instruct-Modelle hin.

### 7.4 Auswirkung der Quantisierung

| Stufe | Größe (7B) | Qualität für dieses System | Empfehlung |
| --- | --- | --- | --- |
| Q8_0 | ~7,6 GB | minimal besser als Q5 | nicht lohnend `[A]` |
| Q5_K_M | ~5,4 GB | leicht bessere Begründungen | für den CEO `[B]` |
| **Q4_K_M** | ~4,4 GB | für strukturierte Aufgaben praktisch gleichwertig | **Standard** |
| Q3_K_M | ~3,5 GB | Formatfehler nehmen spürbar zu | nur im Notfall |

Der Grund, warum Q4 hier ausreicht: Die Agenten treffen **keine** feinsinnigen Werturteile.
Sie füllen ein enges JSON-Schema aus, und die eigentliche Rechenarbeit (Positionsgröße,
Limits) passiert ohnehin im Code. Quantisierungsverluste treffen vor allem freie,
nuancenreiche Textgenerierung — hier also den unkritischsten Teil.

### 7.5 Hybrid mit Cloud-Fallback (bewusste Entscheidung)

Technisch vorbereitet, standardmäßig **aus**. Für eine reine Paper-Phase ist er unnötig.

```ini
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.deinanbieter.example/v1
LLM_API_KEY=sk-…
LLM_MODEL=ein-großes-modell
```

Abwägung:

| Kriterium | Rein lokal | Hybrid |
| --- | --- | --- |
| Latenz | 4–40 s `[A]`, 1–5 s `[B]` | 1–3 s |
| Kosten | 0 € | pro Turn, summiert sich bei Dauerbetrieb |
| Datenabfluss | keiner | Strategie + Kontostand verlassen das Haus |
| Verfügbarkeit | unabhängig | fremde API, fremde Ausfälle, fremde Ratenlimits |
| Komplexität | eine Fehlerquelle | zwei Codepfade, zwei Fehlerbilder |

**Empfehlung:** Solange du Paper handelst, bleib lokal. Wenn du Cloud einsetzt, dann für
eine seltene Rolle (etwa eine wöchentliche Strategieprüfung) — nicht für den Executor,
der am häufigsten läuft und am wenigsten Intelligenz braucht.

---

## 8. Broker anbinden

Der Auslieferungszustand nutzt den internen Paper-Broker mit statischem Kursbuch. Für
realistischere Tests brauchst du echte Kurse.

### 8.1 Vergleich

| Broker | Anlagen | Paper-Konto | Aufwand | Bewertung für dieses Projekt |
| --- | --- | --- | --- | --- |
| **Alpaca** | US-Aktien, ETFs, Krypto | ja, kostenlos, unbegrenzt | gering | **Erste Wahl.** REST + Market Data, Paper und Live identisch. |
| **Interactive Brokers** | global, alles | ja | hoch | Vollbroker, aber TWS/IB-Gateway muss dauerhaft laufen — auf dem N150 spürbar. |
| **Kraken** | Krypto | Futures-Demo | mittel | EU-freundlich, gut über `ccxt` erreichbar. |
| **Binance** | Krypto | Testnet | mittel | Größte Liquidität, regulatorisch in der EU prüfen. |
| **dYdX v4** | Perpetuals, dezentral | nein | hoch | Vollständig Open Source und self-custody — passt zur Philosophie, aber Perps bedeuten Hebel, und Hebel widerspricht `maxLeverage = 1`. |

**Empfehlung:** Alpaca Paper zuerst. Kostenlos, keine Einzahlung, echte Kurse, und der
Wechsel auf Live ist später nur ein anderer Endpunkt — was zugleich die Gefahr ist, also
siehe Kapitel 11.

### 8.2 Nur Kurse holen (kleinster sinnvoller Schritt)

Ersetze in `src/lib/broker.ts` das statische Kursbuch durch echte Quotes:

```ts
// src/lib/quotes.ts  (neu anlegen)
const cache = new Map<string, { price: number; ts: number }>();

export async function liveQuote(symbol: string): Promise<number | null> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.ts < 60_000) return hit.price;   // 1 Minute Cache

  const res = await fetch(
    `https://data.alpaca.markets/v2/stocks/${symbol}/quotes/latest`,
    {
      headers: {
        "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID ?? "",
        "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY ?? "",
      },
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const price = data?.quote?.ap ?? null;          // Ask-Preis
  if (price) cache.set(symbol, { price, ts: Date.now() });
  return price;
}
```

Der Cache ist wichtig: Ohne ihn fragt jeder Agenten-Turn erneut ab und du läufst in
Ratenlimits.

### 8.3 Echte Paper-Orders (erst wenn 8.2 stabil läuft)

Ein Adapter muss **dasselbe Interface** wie `PaperBroker` bedienen — insbesondere die
Reihenfolge Kill-Switch → `validateOrder()` → Ausführung. Kopiere die Struktur aus
`submit()` und tausche nur den letzten Block:

```ts
// Skizze
async submit(order: Order): Promise<Fill> {
  if (killSwitch.isArmed()) return reject(order, "KILL_SWITCH_ARMED");

  const guard = validateOrder({ /* … identisch zum PaperBroker … */ });
  if (!guard.allowed) return reject(order, guard.reason);

  const res = await fetch("https://paper-api.alpaca.markets/v2/orders", {
    method: "POST",
    headers: { /* Keys aus process.env */ },
    body: JSON.stringify({
      symbol: order.symbol,
      qty: order.qty,
      side: "buy",
      type: "market",
      time_in_force: "day",
      order_class: "bracket",
      stop_loss: { stop_price: order.stopLoss },   // Stop serverseitig platzieren!
    }),
  });
  // … Antwort in Fill übersetzen …
}
```

> **Wichtigster Punkt:** Der Stop-Loss gehört **zum Broker**, nicht in die eigene Logik.
> Wenn dein Dienst abstürzt, muss der Stop trotzdem greifen. Deshalb `order_class:
> "bracket"` — der Stop lebt dann beim Broker, unabhängig von deinem N150.

Nötige Umgebungsvariablen:

```ini
ALPACA_KEY_ID=…
ALPACA_SECRET_KEY=…
ALPACA_BASE_URL=https://paper-api.alpaca.markets     # niemals versehentlich live!
```

---

## 9. Guardrails ändern

Die harten Limits stehen in `src/lib/riskGuard.ts`.

```ts
export const RISK_LIMITS = {
  maxPositionPct: 0.25,
  maxRiskPerTrade: 0.02,
  maxNotionalPerOrder: 0,        // 0 = aus; sonst harte Obergrenze in Kontowährung
  maxConcurrentPositions: 5,
  allowShort: false,
  maxLeverage: 1,
  requireStopLoss: true,
  defaultStopLossPct: 0.05,
  maxEquityDrawdownPct: 0.15,
} as const;
```

Ablauf einer Änderung:

```bash
nano src/lib/riskGuard.ts
npm run build
sudo systemctl restart ai-trading-firm

# Nachprüfen, dass wirklich der neue Wert gilt
curl -s localhost:3369/api/firm | jq '.riskLimits'
```

**Dass ein Neubau nötig ist, ist das Merkmal, nicht der Fehler.** Eine Risikogrenze, die
sich zur Laufzeit per Klick oder SQL ändern lässt, kann auch von einem fehlgeleiteten
Prozess geändert werden. Der Kompilierschritt ist deine Zwangspause zum Nachdenken.

### 9.1 Sinnvolle Verschärfungen für den Anfang

```ts
maxPositionPct: 0.10,          // statt 25 % nur 10 %
maxConcurrentPositions: 2,     // überschaubar bleiben
maxNotionalPerOrder: 500,      // harte Obergrenze pro Order
maxEquityDrawdownPct: 0.05,    // früher Not-Halt
```

### 9.2 Menschliche Freigabe erzwingen

```ini
REQUIRE_HUMAN_APPROVAL=true
```

Danach führt **kein** Agent mehr selbst aus. Jeder Trade landet als `PENDING` in
`proposals`, und der Turn endet mit:

```json
{ "status": "BLOCKED", "guardrail": "Wartet auf menschliche Freigabe (REQUIRE_HUMAN_APPROVAL=true)" }
```

Freigabe von Hand:

```bash
psql "$DATABASE_URL" -c "
UPDATE proposals SET status='APPROVED', reviewed_at=now()
WHERE id='<proposal-id>';"
```

Für den Einstieg ist dieser Modus die ehrlichste Variante: Du siehst eine Woche lang, was
die Firma *tun würde*, ohne dass sie es tut.

---

## 10. Notfall-Runbooks

### 10.1 Sofortstopp

```bash
curl -s -X POST localhost:3369/api/firm/kill \
  -H 'Content-Type: application/json' \
  -d '{"arm":true,"flatten":true,"reason":"Notfall"}'
```

Falls der Dienst nicht mehr antwortet:

```bash
sudo systemctl stop ai-trading-firm
```

Der Kill-Switch-Zustand liegt in der Datenbank — nach einem Neustart bleibt er aktiv.

### 10.2 Ein Agent dreht durch

Symptom: derselbe Agent erzeugt in Folge unsinnige Entscheidungen.

```bash
# 1. Agenten stilllegen (er wird von der Pipeline übersprungen)
psql "$DATABASE_URL" -c "UPDATE agents SET status='STOPPED' WHERE name='Rhea (Research)';"

# 2. Letzte Antworten ansehen
psql "$DATABASE_URL" -c "
SELECT m.created_at::time(0), m.content, m.meta->>'source'
FROM agent_messages m JOIN agents a ON a.id=m.agent_id
WHERE a.name='Rhea (Research)' ORDER BY m.created_at DESC LIMIT 5;"

# 3. Prompt schärfen (Kapitel 6), dann reaktivieren
psql "$DATABASE_URL" -c "UPDATE agents SET status='IDLE' WHERE name='Rhea (Research)';"
```

### 10.3 Modellserver ausgefallen `[B]`

Erwartetes Verhalten: Statusleiste zeigt „Regel-Engine", Audit-Log meldet
`"source":"fallback"`, die Firma handelt konservativ weiter.

```bash
# Auf dem Server prüfen
curl -s --max-time 3 http://192.168.1.50:11434/api/tags || echo "Desktop nicht erreichbar"

# Auf dem Desktop
sudo systemctl restart ollama
```

Wenn du in dieser Zeit gar nicht handeln willst — was vertretbar ist:

```bash
curl -s -X POST localhost:3369/api/firm/kill \
  -H 'Content-Type: application/json' -d '{"arm":true,"reason":"LLM offline"}'
```

### 10.4 Datenbank voll oder langsam

```bash
psql "$DATABASE_URL" -c "
SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC;"

# Protokoll älter als 90 Tage archivieren und löschen
psql "$DATABASE_URL" -c "
DELETE FROM audit_log WHERE created_at < now() - interval '90 days';"
VACUUM ANALYZE;
```

### 10.5 Kompletter Neustart mit sauberem Depot

```bash
psql "$DATABASE_URL" <<'SQL'
UPDATE positions SET status='CLOSED' WHERE status='OPEN';
INSERT INTO kill_switches (reason, triggered_by, armed) VALUES ('RESET','OPERATOR',false);
UPDATE missions SET status='PENDING' WHERE status IN ('KILLED','ACTIVE');
SQL

sudo systemctl restart ai-trading-firm
```

### 10.6 PostgreSQL-Cluster defekt — `global/pg_filenode.map` fehlt

**Symptom (Kettenreaktion):**

```
psql: FATAL:  could not open file "global/pg_filenode.map": No such file or directory
```

danach im Dienst-Log (`journalctl -u ai-trading-firm`) laufend:

```
[scheduler] Tick fehlgeschlagen: Failed query: select … from "positions" …
[getBroker] Hydration fehlgeschlagen: Failed query: …
```

und im Dashboard die Seite **„Setup erforderlich"**. `npx drizzle-kit push`
scheitert zusätzlich mit `ECONNREFUSED 127.0.0.1:5432`.

**Ursache:** Das Datenverzeichnis `/var/lib/postgres/data` ist unvollständig —
initdb wurde abgebrochen oder lief, während `postgresql.service` schon lief bzw.
in einer Restart-Schleife hing. Der Server startet dann scheinbar normal
(`systemctl` meldet *active*), crasht aber bei jeder Abfrage in Recovery.
**Ein `npx drizzle-kit push` kann das nicht heilen — der Server selbst ist kaputt.**

**Diagnose (30 Sekunden):**

```bash
systemctl is-active postgresql                 # meldet fälschlich 'active'
sudo journalctl -u postgresql -n 20 --no-pager # zeigt die FATAL-Zeile oben
ls /var/lib/postgres/data/global/pg_filenode.map  # → Datei fehlt
```

**Reparatur (Datenverzeichnis neu initialisieren — Trading-Daten gehen dabei
verloren, die Firma ist danach über „Seed / Reset" sofort wieder einsatzfähig):**

```bash
sudo systemctl stop postgresql
sudo rm -rf /var/lib/postgres/data
sudo -u postgres initdb -D /var/lib/postgres/data --locale=C.UTF-8 --encoding=UTF8 \
  --data-checksums --auth-local=peer --auth-host=scram-sha-256
sudo systemctl enable --now postgresql

# Warten bis wirklich bereit — NICHT blind 'sleep' (seit v1.5.2 macht das
# setup-cachyos.sh automatisch):
pg_isready          # wiederholt aufrufen, bis: 'accepting connections'

# Benutzer + Datenbank neu anlegen (Passwort wie in .env!)
sudo -u postgres psql -v ON_ERROR_STOP=1 \
  -v db_user=trader -v db_name=trading_firm -v db_pass='DEIN_PASSWORT' <<'SQL'
CREATE USER :"db_user" WITH PASSWORD :'db_pass';
CREATE DATABASE :"db_name" OWNER :"db_user";
GRANT ALL PRIVILEGES ON DATABASE :"db_name" TO :"db_user";
SQL

# Schema anlegen und Dienst neu starten
npx drizzle-kit push
sudo systemctl restart ai-trading-firm
```

Alternativ einfach `./scripts/setup-cachyos.sh --variant a` erneut ausführen —
seit v1.5.2 erkennt es genau diesen defekten Zustand, stoppt den Dienst,
initialisiert neu und wartet mit `pg_isready` auf echte Bereitschaft, bevor es
weitermacht.

---

## 11. Sicherheits-Checkliste vor echtem Geld

Arbeite diese Liste **vollständig** ab, bevor irgendein Live-Endpunkt konfiguriert wird.

**Guardrails**
- [ ] Ich kann aus dem Kopf sagen, was `maxPositionPct` und `maxRiskPerTrade` bedeuten.
- [ ] Ich habe eine Order gesehen, die von jedem einzelnen Guardrail abgelehnt wurde.
- [ ] `maxNotionalPerOrder` ist auf einen Betrag gesetzt, dessen Totalverlust ich verkraften kann.
- [ ] Der Stop-Loss wird **beim Broker** platziert, nicht nur in meiner Anwendung.

**Not-Halt**
- [ ] Ich habe den Not-Halt mindestens dreimal geübt, inklusive Glattstellen.
- [ ] Der Kill-Switch überlebt einen Neustart (getestet, nicht angenommen).
- [ ] Der automatische Drawdown-Halt hat mindestens einmal ausgelöst (Startkapital testweise senken).

**Betrieb**
- [ ] Der Dienst läuft seit mindestens 7 Tagen ohne Absturz.
- [ ] Es gibt tägliche Datenbanksicherungen und ich habe eine Wiederherstellung geübt.
- [ ] Der Dienst ist **nicht** aus dem Internet erreichbar.
- [ ] API-Schlüssel stehen in `.env`, nicht im Code, und `.env` ist in `.gitignore`.

**Verständnis**
- [ ] Ich habe 30 Tage Paper-Trading protokolliert und ausgewertet.
- [ ] Ich kann für jeden Trade der letzten Woche die Begründung im Audit-Log finden.
- [ ] Ich habe mindestens einen Monat lang mit `REQUIRE_HUMAN_APPROVAL=true` gearbeitet.
- [ ] Ich weiß, welchen Betrag ich verlieren kann, ohne dass es mein Leben ändert.

**Falls ein Punkt offen ist: weiter Paper handeln.** Das kostet nichts außer Zeit.

---

## 12. Diagnose und Leistungsmessung

### 12.1 Wo klemmt es?

```bash
# Läuft der Dienst?
systemctl status ai-trading-firm --no-pager
journalctl -u ai-trading-firm -n 50 --no-pager

# Antwortet die Datenbank?
psql "$DATABASE_URL" -c "SELECT 1;"

# Antwortet das Modell?  [A]
curl -s --max-time 5 http://127.0.0.1:11434/api/tags | jq '.models | length'
# [B]
curl -s --max-time 5 http://192.168.1.50:11434/api/tags | jq '.models | length'

# Was sagt die Anwendung selbst?
curl -s localhost:3369/api/firm | jq '{llm: .ollama, konto: .account}'
```

### 12.2 Modellgeschwindigkeit messen

```bash
# Ollama: welche Modelle sind geladen und wie viel RAM belegen sie?
ollama ps

# Rohe Geschwindigkeit
ollama run qwen2.5:3b-instruct-q4_K_M --verbose 'Zähle von 1 bis 20.'
```

Achte in der Ausgabe auf `eval rate` (Token pro Sekunde bei der Generierung) und
`prompt eval rate`. Ein Agenten-Turn braucht typischerweise 150–400 Ausgabetoken:

```
Turn-Dauer ≈ Ladezeit + (Prompt-Token ÷ prompt eval rate) + (300 ÷ eval rate)
```

### 12.3 Wann wird die Hardware zum Engpass?

| Beobachtung | Bedeutung | Maßnahme |
| --- | --- | --- |
| Turn dauert > 60 s | Modell zu groß für die CPU | eine Stufe kleiner, oder Variante B |
| `ollama ps` zeigt ständiges Nachladen | zu viele verschiedene Modelle | alle Rollen auf ein Modell setzen; `OLLAMA_KEEP_ALIVE=30m` |
| `free -h` zeigt Swap-Nutzung | RAM erschöpft | kleineres Modell, `OLLAMA_MAX_LOADED_MODELS=1` |
| Antworten werden abgeschnitten | Kontextfenster überschritten | `OLLAMA_NUM_CTX` erhöhen (kostet RAM) oder Prompt kürzen |
| `source: fallback` häuft sich | Timeouts | `LLM_TIMEOUT_MS` erhöhen oder Modell verkleinern |
| Dashboard ruckelt | Datenbank groß geworden | alte `audit_log`-Zeilen löschen (10.4) |

### 12.4 Wöchentlicher Gesundheitsbericht

```bash
psql "$DATABASE_URL" -c "
SELECT
  (SELECT count(*) FROM audit_log WHERE created_at > now()-interval '7 days')                        AS ereignisse,
  (SELECT count(*) FROM audit_log WHERE event='ORDER_SENT'     AND created_at > now()-interval '7 days') AS orders,
  (SELECT count(*) FROM audit_log WHERE event='ORDER_REJECTED' AND created_at > now()-interval '7 days') AS abgelehnt,
  (SELECT count(*) FROM audit_log WHERE event='KILL_SWITCH'    AND created_at > now()-interval '7 days') AS not_halte,
  (SELECT count(*) FROM agent_messages WHERE meta->>'source'='fallback' AND created_at > now()-interval '7 days') AS regel_engine;"
```

Ein gesundes Bild in der Lernphase: **mehr Ablehnungen als Orders.** Das heißt, die
Guardrails arbeiten und die Agenten testen ihre Grenzen aus — nicht umgekehrt.

---

## 13. Fragen, die du dir stellen solltest

Bevor du weiter ausbaust, beantworte diese Fragen schriftlich. Sie entscheiden mehr über
den Erfolg als jede Modellwahl.

### Risikotoleranz
1. Welchen Betrag kann ich vollständig verlieren, ohne dass es meinen Alltag verändert?
   Dieser Betrag — nicht mehr — ist später dein Startkapital.
2. Bei welchem Drawdown in Prozent will ich, dass sich das System **selbst** abschaltet?
   Trage genau diesen Wert in `maxEquityDrawdownPct` ein.
3. Was ist schlimmer für mich: ein verpasster Gewinn oder ein vermeidbarer Verlust?
   Bei „Verlust" gehören alle Limits halbiert.
4. Möchte ich überhaupt jemals ohne menschliche Freigabe handeln lassen — oder ist
   `REQUIRE_HUMAN_APPROVAL=true` mein Dauerzustand? Beides ist eine legitime Antwort.

### Zeit und Pflege
5. Wie viele Stunden pro Woche kann ich realistisch für Prompt-Pflege und Log-Durchsicht
   aufwenden? Unter zwei Stunden: bleib bei zwei Agenten und Variante A.
6. Wer schaut nach dem System, wenn ich zwei Wochen im Urlaub bin? Wenn niemand:
   Dienst vor der Abreise stoppen.
7. Bin ich bereit, ein Update zu prüfen, bevor ich es einspiele? Wenn nein: Version einfrieren.

### Genauigkeitsanspruch
8. Reicht mir „das Setup wäre plausibel gewesen", oder brauche ich belastbare Statistik?
   Bei Letzterem führt kein Weg an echtem Backtesting mit sauberen Daten vorbei — und das
   ist bewusst **nicht** Teil dieses Projekts.
9. Wie viele Paper-Trades will ich sehen, bevor ich einer Strategie glaube? Unter 100 ist
   die Aussagekraft gering.
10. Wie unterscheide ich Glück von Können in meinen Ergebnissen? Wenn du darauf keine
    Antwort hast, ist es zu früh für echtes Geld.

### Technische Ausrichtung
11. Aktien (→ Alpaca) oder Krypto (→ ccxt/Kraken)? Die Antwort bestimmt den Adapter und
    die Handelszeiten — Krypto läuft 24/7, das ändert den Betriebsrhythmus grundlegend.
12. Reicht mir ein Durchlauf pro Stunde, oder brauche ich Minutentakt? Bei Minutentakt
    ist Variante A raus.
13. Bin ich bereit, für die RX 480 zwei Stunden in einen Vulkan-Build zu stecken, oder
    sind mir 8 tok/s auf der CPU genug? Beides ist vertretbar.
14. Will ich wirklich sechs Agenten — oder reichen Research und Executor? **Fang mit zwei
    an.** Jeder weitere Agent kostet Latenz und bringt eine neue Fehlerquelle.

---

## 14. Glossar

| Begriff | Bedeutung |
| --- | --- |
| **Agenten-Turn** | Ein einzelner Durchlauf: Prompt → Modell → Entscheidung → Validierung |
| **Pipeline** | Alle Agenten nacheinander in fester Reihenfolge |
| **Guardrail** | Im Code verankerte Grenze, die kein Modell umgehen kann |
| **Kill-Switch** | Globaler Not-Aus; blockiert jede Order, überlebt Neustarts |
| **Flatten** | Alle offenen Positionen sofort schließen |
| **Notional** | Gegenwert einer Position in Kontowährung (Stückzahl × Kurs) |
| **Drawdown** | Rückgang vom höchsten Kontostand, hier gegenüber dem Startkapital |
| **Quantisierung** | Kompression der Modellgewichte (Q4 = 4 Bit) für weniger RAM |
| **Kontextfenster** | Wie viele Token das Modell gleichzeitig „sieht" (`OLLAMA_NUM_CTX`) |
| **tok/s** | Token pro Sekunde — das praktische Tempomaß |
| **Regel-Engine** | Deterministischer Ersatz, wenn kein Modell erreichbar ist |
| **gfx803** | AMD-Architekturkürzel der RX 480 (Polaris); ROCm-Support eingestellt |
| **Bracket-Order** | Order mit serverseitig hinterlegtem Stop-Loss beim Broker |
