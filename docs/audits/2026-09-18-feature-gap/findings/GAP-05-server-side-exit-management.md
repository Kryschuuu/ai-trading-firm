# GAP-05 — Server-seitiges Exit-Management (SL/TP/Trailing, OCO/Bracket, Time-Stop)

**Nutzen:** ★★★★★ · **Aufwand (Co-Audit):** 🔧🔧🔧 · **Aufwand (verifiziert):** 🔧🔧
**Kategorie:** Schutz · **Prompt:** [`PROMPT-05`](../prompts/PROMPT-05-server-side-exit-management.md)

## Befund (Co-Audit)

Der wichtigste Schutz gegen Tail-Risk; Exits dürfen nie von LLM-Latenz oder
Provider-Ausfall abhängen. Contra: Stop-Hunting bei zu engen Stops; Order-Typ-
Mapping (Conditional, Reduce-Only) korrekt halten.

## Verifizierter Ist-Stand (2026-09-18, v1.40.0)

- `src/lib/monitor.ts` `tick()`: serverseitiger Watcher, prüft je offener
  Position SL/TP unabhängig von LLM-Turns; `stopsTriggered` im Ergebnis;
  `exitReason`-Taxonomie (STOP_LOSS | TAKE_PROFIT | MANUAL_FLATTEN |
  AGENT_CLOSE | RULE_EXECUTION) in `positions`.
- **Aber:** kein Trailing-Stop, kein Time-Stop (max. Haltedauer), OCO-
  Exklusivität (genau ein Exit bei parallelen Ticks) nicht explizit belegt,
  Stop-Parametrisierung (Trailing-Activation/Return) nicht konfigurierbar.

## Delta

1. Trailing-Stop (Activation-Gewinn %, Rückgabeweg %), Zustand crash-safe in
   der DB (kein Memory-Only), Update im Monitor-Tick.
2. Time-Stop (max. Haltedauer je Position, konfigurierbar, Default aus),
   neue `exitReason`-Werte dokumentiert.
3. OCO/Bracket-Semantik: SL/TP komplementär, **genau ein** Exit auch bei
   Race (idempotente Ticks), Audit je Trigger.
4. Alle Schwellen über Konfiguration mit Bounds; Live-Gate/Order-Mapping
   wird nicht angetastet (Paper-only-Fokus).

## Akzeptanzkriterien (kurz)

Trailing-Aktivierung/Nachzug/Restart-Persistenz-Tests, Time-Stop-Test,
Race-Test (2 parallele Ticks → genau 1 Exit), Audit-Assertions.

## Umsetzung (v1.44.0, 2026-09-18)

Umsetzung im Rahmen von [PROMPT-05](../prompts/PROMPT-05-server-side-exit-management.md)
(Arena-Session, Branch `arena/01a0b5f8-ai-trading-firm`, PR
[#138](https://github.com/Kryschuuu/ai-trading-firm/pull/138)). **Ist-Stand abweichend
zum Audit:** OCO-Exklusivität war nicht nur „nicht belegt“, sondern existierte
gar nicht — der alte Monitor-Pfad schloss Ledger (`broker.close`) und DB ohne
bedingten Claim, zwei überlappende Zyklen auf **verschiedenen Prozessen**
hätten beide PnL buchen können. Die Single-Flight-Sperre von `tick()` deckt
nur denselben Prozess ab — genau deshalb ist der DB-Claim nötig. Das Delta
wurde entsprechend vollständig umgesetzt.

- **D1 Trailing-Stop:** `src/lib/exits.ts` (`decideExit`, reine Funktion,
  clock-unabhängig) + Monitor-Ausführung. Bewaffnung ab
  `RISK_TRAILING_ACTIVATION_PCT` % Gewinn (seitenrichtig LONG/SHORT),
  Stop = Kurs − `RISK_TRAILING_RETURN_PCT` % Rückgabeweg, Ratchet nur in
  Schutzrichtung (LONG hebt, SHORT senkt — nie automatische Verengung).
  Trigger → Close mit `exitReason = TRAILING_STOP`. Zustand persistiert in
  `positions.trailing_armed`/`positions.trailing_stop` (append-only
  `drizzle/2026-09-18_exit_management.sql`); `PaperBroker.hydrate` +
  `engine.getBroker()` spiegeln ihn ins Ledger — Restart verliert keinen Stop
  (getestet).
- **D2 Time-Stop:** `RISK_TIME_STOP_HOURS` (Default 0 = aus, Bounds
  [0, 720]); Ablauf → Close `exitReason = TIME_STOP` + Audit.
- **D3 OCO-Exklusivität:** atomarer DB-Claim je Exit
  (`UPDATE … WHERE id = … AND status = 'OPEN'` RETURNING, `applyExit()`),
  Verlierer = sauberer no-op (kein Doppel-Fill/P&L/Audit). Priorität
  SL → TP → Trailing → Time; SL+TP gleichzeitig → Stop zuerst wie bisher.
  Jeder Exit schreibt genau ein Audit mit maschinenlesbarem Code
  `exit:SYMBOL:grund` (`*_HIT`-Events inkl. neuer `TRAILING_STOP_HIT`/
  `TIME_STOP_HIT` im Audit-Katalog).
- **D4 Konfiguration:** `loadExitConfig()` im `loadFundingConfig`-Muster
  (Env + Bounds-Clamp + sicherer Default) — bewusst **kein** Dashboard-
  Namensraum in `riskConfigService`: dieselbe Begründung wie GAP-02
  (Hot-Path-Schwellen gehören nicht in die kompromittierbare DB-
  Beschreibungsebene; `risk_config` bleibt beschreibend). Alle Defaults
  aus → Verhalten byte-identisch zum bisherigen Watcher.
- **Tests:** `tests/monitor.exits.test.ts` — 17 Tests (Lifecycle LONG/SHORT,
  Restart-Persistenz, Time-Stop an/aus, Promise.all-Race auf `tick()` und auf
  `applyExit`, Multi-Instanz-Race über zwei Postgres-Verbindungen,
  Defaults-Neutralität, genau-ein-Audit). Determinismus: neue
  `tick(forceScan, { now, quotes, skipScan })`-Optionen + Fake-Clock; ohne
  erreichbare DB überspringen die Tick-Tests sauber (Suite-Konvention).
- **Docs:** `docs/PAPER_TRADING.md` §3.3 (Taxonomie + Flag-Tabelle),
  `CONFIGURATION.md` (Abschnitt „Exit-Management“), `.env.example`,
  Schema-/Migrationstexte, CHANGELOG 1.44.0.

**Offene Punkte (bewusst nicht in diesem Release):** Stop-Hunting-Guard
(mindestens x Ticks über dem Stop, bevor ratcheted wird) — aktuell allein
durch die Rückgabeweg-Bound [0.1, 10] begrenzt; OCO-Mapping an echte Venues
(Conditional/Reduce-Only) — obliegt dem Live-Gate und ist hier Paper-only;
Trailing-Parametrisierung je Mission/Regime statt global.
