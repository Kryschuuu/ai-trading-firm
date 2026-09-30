# Versionierung — Audit 2026-09-29 & Roadmap

> Verbindliche Versionierungs-Planung für dieses Audit und die daraus folgende
> Umsetzung. **Alle Zielversionen liegen in `0.x` — das Projekt bleibt Beta.**

## 1. Version des Audits

| Feld | Wert |
| --- | --- |
| **Audit-Version** | `audit-2026-09-29 v1.1.3` |
| **Schema** | `MAJOR.MINOR.PATCH` für den **Audit-Inhalt**, unabhängig von der Projekt-Version |
| **Gültig ab** | Commit `d734fe1` (Erstfassung), fortgeführt in diesem PR |
| **Projekt-Version bei Erstellung** | `v0.5.0` (Beta) |
| **Status** | `OPEN` — 19 Findings, davon 5 HIGH; Phase 0 umgesetzt (00-01 `v0.6.0`, 00-02/00-03 `v0.6.1`), Phase 1 umgesetzt (01-01 `v0.6.2`, STX-01 behoben), Phase 2 fortgeschritten (02-01 `v0.6.3`, 02-02 `v0.6.4`) |

### 1.1 Audit-Versionsregeln

| Änderung am Audit | Bump | Beispiel |
| --- | --- | --- |
| Neuer Befund gegen neuen Code-Stand | MINOR | `v1.1.0` — „STX-20 nach v0.6.0" |
| Neue Phase in der Roadmap | MINOR | `v1.1.0` — „Phase 8 ergänzt" |
| Ein Finding wird behoben (`☐` → `☑`) | PATCH | `v1.0.1` |
| Formulierung, Tippfehler, Linkfix | PATCH | `v1.0.1` |
| Befund zurückgenommen (FALSE_POSITIVE) | MAJOR | `v2.0.0` — „STX-04 war falsch" |
| Grundsatzänderung der Roadmap-Reihenfolge | MAJOR | `v2.0.0` |

### 1.2 Versionshistorie

| Version | Datum | Änderung |
| --- | --- | --- |
| `v1.0.0` | 2026-09-29 | Erstfassung: 19 Findings, 32 Prompts, 8 Phasen |
| `v1.1.0` | 2026-09-29 | 00-01 gemessen (`v0.6.0`, [BENCH-BASELINE](remediation/BENCH-BASELINE.md)); Release-Plan verzahnt: `v0.6.0` = Benchmark, `v0.6.1` = SSoT + ADRs, 0.6.x-Folge nachgezogen; STX-12 auf „Patch mit Paritätstest“ herabgestuft |
| `v1.1.1` | 2026-09-29 | 00-02/00-03 umgesetzt (`v0.6.1`): ADR-008…010, Gate G0 erfüllt; STX-04/15 behoben, STX-02/03/10/11 in Arbeit; Präzisierungen an STX-01…04 (Findings, Prompts, `report.md`); Severity-Tabelle im Audit-README korrigiert |
| `v1.1.2` | 2026-09-29 | 01-01 umgesetzt (`v0.6.2`): STX-01 behoben, Gate G1 erfüllt; Befundkorrekturen an STX-01 (`sessionVwap` war auf `1d` bereits fail-closed; `sanitizeRuleSpec` fällt auf `15m` statt zu „verwerfen“ und kleinschreibt `"1H"`); OP-1 mit Default beantwortet |
| `v1.1.3` | 2026-09-30 | 02-01 umgesetzt (`v0.6.3`): reine Bollinger-/Donchian-Formeln, Rule-Felder/Cache weiter offen; kein Finding geschlossen |
| `v1.1.4` | 2026-09-30 | 02-02 umgesetzt (`v0.6.4`): Bollinger-Regelfelder + Paritäts-/Golden-Test; STX-18 zur Hälfte erledigt (Donchian folgt 02-03) |

## 2. Release-Plan der Roadmap

Die Roadmap wird in **kleinen Minor-Releases** umgesetzt. Jede Phase bzw. jedes
Prompt-Paket ist ein eigener Release. **Kein Release überschreitet `0.x`.**

| Release | Inhalt | Prompts | Typ | Status Beta |
| --- | --- | --- | --- | --- |
| `v0.5.1` | Audit + Roadmap (PR #180) — **in `v0.6.0` gefaltet**, kein eigener Release | — | Doku | **Beta** |
| `v0.6.0` | **Backtest-Performance-Baseline** (00-01) + Audit-Doku aus PR #180 | 00-01 | Doku + Mess-Skript | **Beta** |
| `v0.6.1` | Strategie-Stack-SSoT + 3 ADRs (ausgeliefert 2026-09-29) | 00-02, 00-03 | Doku (+ lesender ADR-Test) | **Beta** |
| `v0.6.2` | **Timeframe-Angleichung** (STX-01, ausgeliefert 2026-09-29) | 01-01 | Minor (neue Felder im Vokabular) | **Beta** |
| `v0.6.3` | Indikatoren: `bollingerBands`, `donchianChannel` (ausgeliefert 2026-09-30) | 02-01 | Minor (additive pure Funktionen) | **Beta** |
| `v0.6.4` | Bollinger-Regelfelder + Parität (ausgeliefert 2026-09-30) | 02-02 | Minor (3 Felder) | **Beta** |
| `v0.6.5` | Donchian-Regelfeld + Parität | 02-03 | Minor (1 Feld) | **Beta** |
| `v0.7.0` | **Template-Vertrag** (`types.ts`, Katalog, Validierung) | 03-01, 03-02 | Minor (neue Domäne) | **Beta** |
| `v0.7.1` | Template EMA/ADX + Compiler + Tests | 03-03, 03-09*, 03-10* | Minor | **Beta** |
| `v0.7.2` | Template MACD | 03-04 | Minor | **Beta** |
| `v0.7.3` | Template RSI Mean-Reversion | 03-05 | Minor | **Beta** |
| `v0.7.4` | Template Bollinger Squeeze | 03-06 | Minor | **Beta** |
| `v0.7.5` | Template VWAP (Snapshot) | 03-07 | Minor | **Beta** |
| `v0.7.6` | Template Donchian Breakout | 03-08 | Minor | **Beta** |
| `v0.8.0` | `strategy_definitions` + `strategy_versions` (Migration + Service) | 04-01, 04-02 | Minor (additive Migration) | **Beta** |
| `v0.9.0` | Screening: Typen, Priorität, Matrix, Persistenz, CLI | 05-01…05-04 | Minor | **Beta** |
| `v0.10.0` | Validator deterministisch: Annahmen, Overfit, Stress, Report + CLI | 06-01…06-04 | Minor | **Beta** |
| `v0.10.1` | Validator-Agent (Shadow-Mode, erklärt nur) | 06-05 | Minor | **Beta** |
| `v0.11.0` | Copy-Domänenmodell (rein) | 07-01 | Minor | **Beta** |
| `v0.11.1` | Copy-Policy + Order-Links (`SIMULATE_ONLY`) | 07-02 | Minor | **Beta** |
| `v0.11.2` | Bitunix-Leader + Simulate-only-Follower | 07-03 | Minor | **Beta** |
| *(optional)* | Feature-Store-Slice `rule.*` | 02-04 | Minor | **Beta** |

\* 03-09/03-10 werden technisch benötigt, um 03-03 abzunehmen; sie werden im selben
Release ausgeliefert. Alternativ 03-03 in ein eigenes „Draft"-Release, wenn die
Abnahme strenger getrennt sein soll — das ist eine Prozess-, keine Code-Entscheidung.

### 2.1 Warum eigene Releases je Template

Jedes Template ist ein **eigenständig prüfbares Artefakt** mit eigener
Annahme-Kette. Ein Release je Template bedeutet:

- ein Rollback-Punkt pro Strategie
- ein Changelog-Eintrag, der eine fachliche Aussage macht
- eine getrennte Sichtbarkeit: „wir haben 3 von 6 geprüft" ist eine ehrliche
  Zwischenmeldung, „wir haben 6" erst nach dem sechsten

### 2.2 Was **kein** Release dieses Plans auslöst

| Ereignis | Folge |
| --- | --- |
| Alle 32 Prompts `☑` | **Kein** Beta-Exit. Siehe [`BETA_STATUS.md`](../../BETA_STATUS.md). |
| Alle 6 Templates `PASS` im Validator | **Kein** Beta-Exit. Ein `PASS` ist ein Filterergebnis, kein Nachweis. |
| `v0.11.2` erreicht | **Kein** Beta-Exit. `SIMULATE_ONLY` bleibt `SIMULATE_ONLY`. |
| Sicherheitsaudit ohne offene Findings | **Kein** Beta-Exit. Erfüllt allein `B4`. |

## 3. Versionsregeln für die Umsetzung

1. **Jeder Release beginnt mit `CHANGELOG.md` unter `[Unreleased]`.**
2. **Migrationen sind append-only** und folgen `drizzle/YYYY-MM-DD_kurzname.sql`.
3. **Bestehende Backtest-Ergebnisse bleiben byte-identisch**, außer der Release
   ändert das ausdrücklich im Changelog. `executionModel` defaultet weiter auf
   `"legacy"`.
4. **Kein Release entfernt eine `RULE_FIELDS`-Option.** Felder werden addiert;
   ihr Wegfallen ist ein MAJOR-Bruch und braucht eine Migrationsstrategie für
   `trade_rules`.
5. **Pflicht-Checks** vor jedem Release:
   `npm run typecheck && npm run lint && npm test && npm run docs:validate`.
6. **`VERSION.md` und `README.md`** werden im selben Commit wie der Versions-Bump
   aktualisiert (Status-Header + Komponentenliste), weil `docs:validate` die
   Versions-Konsistenz über `package.json` ↔ `CHANGELOG.md` ↔ Status-Header prüft.

## 4. Abwärtskompatibilität in `0.x`

SemVer erlaubt in `0.x` Breaking Changes, wenn sie dokumentiert sind. Für diese
Roadmap sind drei echte Bruchstellen vorgesehen — alle drei bewusst:

| Bruchstelle | Release | Was bricht | Migrationspfad |
| --- | --- | --- | --- |
| `RuleWindow.timeframe` wird von 5 auf 10 Werte erweitert | `v0.6.2` (umgesetzt) | Code, der `ALLOWED_TIMEFRAMES` als geschlossene Menge behandelt | `RULE_ALLOWED_TIMEFRAMES` ist jetzt exportiert und aus `SUPPORTED_TIMEFRAMES` abgeleitet; der Mikro-Executor wertet weiter nur bis `1h` aus (Timeframe-Guard) |
| `RuleSnapshot` und `IndicatorCache` wachsen um 4 Felder | `v0.6.4`/`v0.6.5` | Code, der `RuleSnapshot` als geschlossene Union typisiert | Felder sind additiv, aber die **Parität** beider Snapshot-Pfade wird jetzt getestet |
| `COPY_MODE`-Enum existiert | `v0.11.0` | Kein bestehender Code (Modul ist neu) | keine |

## 5. Offene Versionsfragen

| # | Frage | Entscheidung |
| --- | --- | --- |
| V1 | Muss ein Templates-Release auch eine `v1`-Version der Strategie-Bibliothek tragen? | Empfehlung: **nein** — `templateVersion` im Artefakt-Hash genügt (04-01). |
| V2 | Wann wird `0.x` verlassen? | **Nicht durch diese Roadmap planbar.** Erst wenn `B1…B8` belegt sind, siehe [`BETA_STATUS.md`](../../BETA_STATUS.md). |
| V3 | Braucht Phase 7 ein eigenes Release-Train? | Empfehlung: **nein**, sie folgt `v0.11.0–v0.11.2`, weil sie organisatorisch abhängig (`B5`) ist. |
| V4 | Muss `v0.5.1` existieren, wenn nur Doku geändert wurde? | **Nein** — die Audit-Doku aus PR #180 wurde ohne eigenen Bump gemergt und ist in `v0.6.0` gefaltet (siehe `CHANGELOG.md`); so bleibt „ein Release = ein prüfbares Paket“ gewahrt. |

---

## Verwandte Dokumente

- [`README.md`](README.md) — Audit-Index
- [`ROADMAP.md`](ROADMAP.md) — Phasen, Gates, Abhängigkeiten
- [`../../../VERSION.md`](../../../VERSION.md) — Projekt-Versions-Metadaten
- [`../../BETA_STATUS.md`](../../BETA_STATUS.md) — Beta-Zusage und Exit-Kriterien
- [`../../../CHANGELOG.md`](../../../CHANGELOG.md) — Changelog
- [`../../../docs/README.md`](../../../docs/README.md) — Doku-Index
