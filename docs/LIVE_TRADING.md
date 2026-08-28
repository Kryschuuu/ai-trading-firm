# Live-Trading-Gate — auditierte State-Machine (Task 11)

**Stand:** v1.19.0 · **Modul:** `src/live-gate/**` ·
**API:** `GET /api/live/state`, `POST /api/live/transition`, `POST /api/live/kill` ·
**CLI:** `npm run live:kill` · **CI:** Job `security-live-gate`

> ## ⚠️ Dieser Task aktiviert KEIN Live-Trading
>
> Nach dem Merge dieses Tasks bleibt Live **OFF** — genau wie vorher:
> kein State-File existiert (`DISCONNECTED`), `LIVE_TRADING_ENABLED=false`,
> `BITUNIX_LIVE_ENABLED=false`, kein Security-Suite-Stamp im Betrieb, kein
> registrierter Test-Order-Provider. **Jede Live-Order wird weiterhin mit
> `LiveTradingGateError` verweigert.** Was dieser Task liefert, ist der
> EINZIGE ordnungsgemäße, auditierbare Weg, Live *jemals* freizuschalten —
> durch Menschen, Checks und eine grüne Security-Suite, nie durch Flags allein.

---

## 1. Zustands-Diagramm (9 Zustände, 8 legale Übergänge)

```
 DISCONNECTED ──1──▶ CONNECTED ──2──▶ MARKET_DATA_OK ──3──▶ ACCOUNT_READ_OK
                                                                  │
                                                                    4
                                                                    ▼
 HUMAN_APPROVED ◀──7── LIVE_PENDING ◀──6── PAPER_APPROVED ◀──5── ORDER_TEST_OK
      │
      8
      ▼
 LIVE_ENABLED
```

Explizite **Downgrade-Aktionen** (keine Matrix-Übergänge, immer auditiert):
`disable` (Admin, jeder Zustand außer DISCONNECTED → DISCONNECTED) und
`kill` (Kill-Switch: **jeder** Zustand → DISCONNECTED + persistente Sperre).

## 2. Bedingungen je Übergang

| # | Übergang | Bedingung (objektiv verifiziert) | Wer prüft |
| --- | --- | --- | --- |
| 1 | DISCONNECTED → CONNECTED | Verbindungstest: Adapter-Health des Venues `online` (lokal, read-only) | Check `connectivity` (BrokerGatePort) |
| 2 | CONNECTED → MARKET_DATA_OK | Read-Only-Market-Data: ein Public-Ticker des Venues erfolgreich gelesen | Check `marketData` |
| 3 | MARKET_DATA_OK → ACCOUNT_READ_OK | Read-Only-Account-Read: Control-Plane konfiguriert + verbunden (Probe status-only) | Check `accountRead` |
| 4 | ACCOUNT_READ_OK → ORDER_TEST_OK | Testnet-/Test-Order-Prüfung **nur simuliert/Mock** — Default-Port verweigert (kein Bitunix-Testnet dokumentiert); ein Venue-Testnet-Provider muss explizit registriert sein | Check `orderTest` |
| 5 | ORDER_TEST_OK → PAPER_APPROVED | ≥ `LIVE_GATE_PAPER_MIN_ORDERS` (Default 50) fehlerfreie Paper-Orders aus einer registrierten Statistikquelle | Check `paperCriteria` |
| 6 | PAPER_APPROVED → LIVE_PENDING | Admin-Antrag: Grund (Pflicht, ≥ 8 Zeichen) → startet Cooldown-Timer (`livePendingAt`) | Service-Policy |
| 7 | LIVE_PENDING → HUMAN_APPROVED | **Human Gate**: Admin + `confirm:true` + Grund + Approver-Name; Cooldown `LIVE_GATE_COOLDOWN_MS` (Default 24 h) abgelaufen; optional 4-Augen (`LIVE_GATE_FOUR_EYES=true`: zwei *verschiedene* Approver) | Service-Policy |
| 8 | HUMAN_APPROVED → LIVE_ENABLED | `confirm:true` + Grund + `BITUNIX_ENABLED` + `LIVE_TRADING_ENABLED` + `BITUNIX_LIVE_ENABLED` + Capability `live` + gültiger Security-Suite-Stamp + Control-Plane-Venue aktiv | Enforcer-Prerequisites |

Jede andere (from, to)-Kombination — Sprünge, Rückwärts, Selbst-Übergänge,
unbekannte Zustände — wird mit `ILLEGAL_TRANSITION` bzw. `UNKNOWN_STATE`
abgelehnt **und auditiert**. Die Matrix selbst ist kanonisch im Code
(`LIVE_GATE_TRANSITIONS`, genau 8 Einträge) und durch Tests fixiert
(81 Kombinationen → 8 erlaubt, 73 abgelehnt, 0 Durchlässe).

## 3. Human-Gate-Flow (Cooldown, 4-Augen)

```
PAPER_APPROVED ──(Admin: Antrag + Grund)──▶ LIVE_PENDING
                                                │  Cooldown läuft (Default 24 h,
                                                │  LIVE_GATE_COOLDOWN_MS, 0 = aus)
                                                ▼  (Freigabe vorher → 409 COOLDOWN_ACTIVE + retryAt)
LIVE_PENDING ──(Admin: confirm:true + Grund + approver)──▶ HUMAN_APPROVED
     │  wenn LIVE_GATE_FOUR_EYES=true:
     └─ 1. Bestätigung (approver A) → FOUR_EYES_PENDING (kein Zustandswechsel,
           auditiert als four-eyes-first)
        2. Bestätigung (approver B ≠ A) → Übergang; gleicher Name → deny
```

- `REQUIRE_HUMAN_APPROVAL=true` (Default) erzwingt diesen Schritt **strukturell**:
  Die Matrix hat keine Kante, die das Human-Gate überspringt.
- Der Approver-Name ist Pflicht (≥ 3 Zeichen) und landet im Audit. Der
  4-Augen-Modus vergleicht Namen — echte Zwei-Personen-Integrität über zwei
  Admin-Token ist mit dem Task-10-Rollenmodell (ein Admin-Token) noch nicht
  erzwingbar und als Aufgabe für Task 12 dokumentiert (siehe Peer-Review).

## 4. Enforcement — Single Point of Enforcement

`assertLiveOrderAllowed(venue)` / `evaluateLiveOrder(venue)` in
`src/live-gate/enforcer.ts` ist der **einzige** Torwächter vor jeder
Venue-Order-Schnittstelle. Aufrufer:

1. **Broker-Factory** `getBroker(venue, "live")` (`src/brokers/factory.ts`)
2. **Bitunix-Adapter** in jedem Live-Pfad (`placeOrder`, `getAccount`,
   `getPositions` — Schutz auch bei Direktkonstruktion ohne Factory)
3. **Control-Plane-Anzeige** `readGateState(venue)` (reine Projektion)
4. **Ops-Center** `aggregateLiveGateStatus()` (aggregierte Anzeige)

Prüfreihenfolge (jeder Deny hat einen maschinenlesbaren Code, **bei jedem
Zweifel deny + Audit**):

| # | Prüfung | Deny-Code |
| --- | --- | --- |
| 1 | Venue in der Whitelist | `UNKNOWN_VENUE` |
| 2 | Adapter-Capability `live` (PAPER: false → kann nie live) | `VENUE_NOT_LIVE_CAPABLE` |
| 3 | Kill-Switch: prozesslokal + persistente Failsafe-Datei | `KILL_SWITCH_ACTIVE` |
| 4 | Machine-State = `LIVE_ENABLED` (persistiert) | `STATE_NOT_LIVE_ENABLED` |
| 5 | `{VENUE}_ENABLED=true` | `VENUE_FLAG_MISSING` |
| 6 | `LIVE_TRADING_ENABLED=true` | `PLATFORM_FLAG_MISSING` |
| 7 | `{VENUE}_LIVE_ENABLED=true` | `VENUE_LIVE_FLAG_MISSING` |
| 8 | `REQUIRE_HUMAN_APPROVAL=false` **oder** State ≥ HUMAN_APPROVED | `HUMAN_APPROVAL_REQUIRED` |
| 9 | Security-Suite-Stamp gültig (passed + runId + Max-Alter) | `SECURITY_SUITE_INVALID` |
| 10 | Control-Plane-Venue aktiv (Readiness-Provider) | `CONTROL_PLANE_UNKNOWN` / `CONTROL_PLANE_INACTIVE` |

Alle zehn Bedingungen müssen gleichzeitig erfüllt sein — die Test-Matrix
(9 States × 16 Flag-Kombinationen × Suite × Control Plane gegen ein
Referenz-Oracle) beweist: nur die exakt erlaubte Konstellation lässt durch.

**Kein UI-/Prompt-Bypass:** Zustandsänderungen gibt es ausschließlich über die
State-Machine-API (admin-guarded, CSRF, Rate-Limit) bzw. CLI. Der Enforcer
liest nur persistierte Quellen (State-Files, Env-Flags, Suite-Stamp,
Kill-Datei) — niemals UI-Flags oder Agenten-Aussagen.

## 5. Kill-Switch

- **Auslöser:** UI-Button (Confirm-Dialog mit getippter Phrase `KILL`),
  `POST /api/live/kill` (Admin + Phrase) oder CLI
  `npm run live:kill -- --venue=BITUNIX [--scope=all] [--reason=…]` (Notfall,
  ohne HTTP).
- **Wirkung aus JEDEM Zustand, sofort** (Failsafe-Kaskade in dieser Reihenfolge):
  1. prozesslokale Memory-Sperre (wirkt unverzüglich, auch wenn alles andere versagt),
  2. persistente Sperrdatei `data/live-gate/kill-switch.json` (wirkt über
     Neustarts und bei DB-/Netz-Ausfall — lokale Datei, keine Infrastruktur),
  3. State-Reset aller betroffenen Venues auf DISCONNECTED (best-effort),
  4. Audit-Eintrag `kill`/`KILLED` (Ring hält ihn auch bei Datei-/DB-Fehler).
- **Scope:** `*` (systemweit, alle Venues) oder einzelnes Venue.
- **Nicht rückgängig zu machen ohne vollständigen Neudurchlauf:**
  `action:"clear"` + Phrase `CLEAR_KILL` entfernt die Sperre (auditiert),
  der Zustand bleibt aber DISCONNECTED — alle 8 Übergänge inkl. Human-Gate
  mit Cooldown sind erneut nötig, bevor Live wieder aktiv werden kann.
- Der Enforcer prüft die Kill-Datei bei **jeder** Order-Entscheidung; sie
  dominiert selbst ein manipuliertes State-File (Defense in Depth, getestet).

## 6. Persistenz & Crash-Recovery

Ablage (alles atomar via tmp+fsync+rename; `LIVE_GATE_DATA_DIR` übersteuerbar):

| Datei | Inhalt |
| --- | --- |
| `venue-{VENUE}.json` | State, `pendingTransition` (Intent), `livePendingAt` (Cooldown-Basis), `pendingApproval` (4-Augen), Kill-Marker, History-Zähler, Audit-Kettenkopf |
| `audit-log.ndjson` | Hash-Kette aller Gate-Ereignisse (append-only) |
| `kill-switch.json` | Kill-Failsafe-Einträge (NDJSON) |
| `security-suite.json` | CI-Stamp der Security-Suite (Deployment-Artefakt) |

Crash-Semantik: Ein Übergang schreibt erst den **Intent** (`pendingTransition`),
führt die Checks aus und committet dann atomar. Findet der Lese-Pfad nach einem
Crash einen Intent ohne Commit, wird er verworfen und als
`crash-recovery/ABORTED` auditiert — der Zustand bleibt beim `from`,
halboffene Übergänge gelten als **fehlgeschlagen**. Korrupte State-Files führen
fail-safe zu DISCONNECTED (Kopie wird als `.corrupt-<ts>` konserviert).

## 7. Audit-Format + Hash-Kette

Jeder Übergang, jeder Deny, jeder Kill, jeder Enforce-Entscheid:

```json
{"seq":7,"ts":"2026-08-28T12:00:00.000Z","actor":"admin","venue":"BITUNIX",
 "from":"LIVE_PENDING","to":"HUMAN_APPROVED","action":"advance","result":"OK",
 "reason":"…","policyVersion":"live-gate-policy/1",
 "prevHash":"<sha256 des Vorgängers>","hash":"<sha256 über kanonisches JSON>"}
```

- Kanonisch: JSON-Array der Felder in fester Reihenfolge (`AUDIT_FIELDS`),
  `hash = sha256(seq…prevHash)`, Genesis `prevHash` = 64 Nullen.
- `verifyAuditChain()` erkennt: veränderte Einträge (Hash-Abweichung),
  eingefügte/entfernte Einträge (Seq-/prevHash-Bruch), kaputte Zeilen und —
  über den im State-File dokumentierten Kettenkopf — Truncation am Dateiende.
- Sichtbarkeit: `GET /api/live/state` (Kettenkopf + Integrität + letzte
  Einträge, Hashes gekürzt), DB `audit_log` (Event `LIVE_GATE`, best-effort),
  UI-Katalog `LIVE_GATE` (Task-08-Audit-View).

## 8. Security-Suite & CI (merge-blockierend)

- Job **`security-live-gate`** läuft auf jedem PR und Push: typecheck, lint,
  `npm run security:live-gate` (Transitionsmatrix, Enforcement-Matrix,
  Kill-Drill aus allen 9 Zuständen, Red-Team-Regressionen, Crash-/Persistenz-,
  Audit-Ketten- und E2E-Tests; Coverage-Tor **≥ 95 % Zeilen** auf
  `src/live-gate/**`), Secret-Scan, Suite-Stamp-Artefakt.
- **Installation (einmalig, Repo-Owner):** Die Job-Quelle liegt als
  `docs/ci/security-live-gate.workflow.yml` im Repo (das Arena-Bot-Token darf
  keine `.github/workflows/`-Dateien schreiben — GitHub-App-Beschränkung).
  Nach dem Merge: `cp docs/ci/security-live-gate.workflow.yml .github/workflows/security-live-gate.yml`
  committen — fertig. `npm run security:live-gate` läuft identisch lokal.
- **Branch Protection (Einrichtung nötig, Admin):** `main` →
  *Require status checks to pass* → Check **`security-live-gate`**.
  Danach blockiert GitHub den Merge jedes PRs, dessen Security-Suite rot ist —
  inklusive jedes PRs, der Live-Trading-Code verändert.
- Der Enforcer verlangt einen gültigen **Suite-Stamp** (`passed:true`, `runId`,
  Alter ≤ `LIVE_GATE_SUITE_MAX_AGE_MS`, Default 7 Tage). Der Stamp ist ein
  Deployment-Artefakt aus CI (`actions/upload-artifact`), kein Repo-File;
  manuelles Stempeln (`--source=manual`) ist im Stamp und Audit sichtbar.
- Coverage-Metrik-Hinweis: Unter `tsx` zaehlen Phantom-Module (CJS/ESM-
  Duplikate) in die Funktionendeckung — das CI-Tor ist daher Zeilendeckung
  ≥ 95 % (Funktionen/Branches werden berichtet).

## 9. API-/CLI-Referenz

| Endpoint | Guard | Beschreibung |
| --- | --- | --- |
| `GET /api/live/state` | — (read-only) | Zustand je Venue (9 States), Flags, Cooldown-Rest, Suite-Stamp, Kill-Status, Audit-Kettenkopf + Integrität |
| `POST /api/live/transition` | Permission `live.gate` (Admin) + CSRF + 5/min/IP | Body `{venue, to, reason?, confirm?, approvedBy?}` → 200 bei legalem Übergang; 409 Matrix/Cooldown/Flags; 422 Validierung |
| `POST /api/live/kill` | Permission `live.gate` + CSRF + Rate-Limit | Body `{venue?|scope?, reason, confirm:"KILL"}` oder `{action:"clear", scope?, reason, confirm:"CLEAR_KILL"}` |

```bash
# Kill (Notfall, ohne HTTP):
npm run live:kill -- --venue=BITUNIX --reason="Notfall: anomale Orders"
npm run live:kill -- --scope=all --reason="Incident 4711"
npm run live:kill -- --clear --scope=all --reason="Fehler entwirrt"
```

Runbook „Live freischalten" (nur für Menschen, niemals automatisiert):
State-Dateien und Flags prüfen → Übergänge 1–5 über die Transition-API
(Checks laufen automatisch) → Antrag (6) → 24 h bedenken → Freigabe (7) →
Flags + Suite-Stamp bereitstellen → Enable (8) → Live-Orders laufen durch den
Enforcer. Jeder Schritt ist in `audit-log.ndjson` nachvollziehbar.

## 10. Konfiguration

| Env | Default | Bedeutung |
| --- | --- | --- |
| `LIVE_GATE_DATA_DIR` | `data/live-gate` | Ablage (gitignored) |
| `LIVE_GATE_COOLDOWN_MS` | `86400000` | Cooldown Human-Gate (0 = aus, max 30 d) |
| `LIVE_GATE_FOUR_EYES` | `false` | zweite, unterschiedliche Approver-Bestätigung |
| `LIVE_GATE_PAPER_MIN_ORDERS` | `50` | Paper-Kriterien für `PAPER_APPROVED` |
| `LIVE_GATE_SUITE_MAX_AGE_MS` | `604800000` | Max-Alter des Suite-Stamps (0 = unbegrenzt) |

Wirksam bleibt außerdem: `BITUNIX_ENABLED`, `BITUNIX_LIVE_ENABLED`,
`LIVE_TRADING_ENABLED`, `REQUIRE_HUMAN_APPROVAL` (allein wirkungslos — siehe
Enforcer-Tabelle) sowie `FIRM_ADMIN_TOKEN` (Admin-Rolle für `live.gate`).

## 11. Bekannte Grenzen (ehrlich)

- **4-Augen über Namen, nicht über zweite Token-Identität:** Solange das
  RBAC-Kern nur ein Admin-Token kennt (Task 10), vergleicht der 4-Augen-Modus
  Approver-Namen. Echte Zwei-Personen-Enforcement-Identität → Task 12.
- **Default-Ports sind bewusst restriktiv:** Ohne registrierten Test-Order-
  Provider und Paper-Statistikquelle sind `ORDER_TEST_OK`/`PAPER_APPROVED`
  unerreichbar (fail-closed). Ein echter Live-Betrieb braucht venue-seitige
  Testnet-Anbindung (heute für Bitunix nicht dokumentiert).
- **Single-Node:** State-Files und Kill-Datei sind lokal; Multi-Instanz-Betrieb
  bräuchte eine gemeinsame Ablage (konsistent mit dem Rest der Plattform).
