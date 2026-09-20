# PROMPT-P5-01 — kontinuierliches Portfolio-Volatility-Targeting

## Auftrag

Implementiere **kontinuierliches Portfolio-Volatility-Targeting** produktionsreif im Repository
`Kryschuuu/ai-trading-firm`. Dieser Prompt ist eigenständig: prüfe zuerst den
aktuellen Branch und Code; Audit-Basis war Commit `df3163e` (`v1.51.1`). Wenn
der aktuelle Stand abweicht, übernimm die Absicht mit minimalem Scope und
vermerke die Abweichung im PR.

Zugehöriger Befund: [`../findings/RMA-P5-01-volatility-targeting.md`](../findings/RMA-P5-01-volatility-targeting.md)
Priorität/Schwere: **P5 / MEDIUM**
Schätzung des Restaufwands: **2–4 PT**

## Verifizierter Ausgangszustand

- Adaptive Risk klassifiziert Volatilität diskret und dämpft globale Limits.
- Portfolio-Modul berechnet Volatilität und Korrelation.
- Risk Guard setzt harte Portfolio-Ceilings durch.
- Kontinuierlicher Portfolioforecast und Zielmultiplikator fehlen.

## Zielzustand

Berechne aus as-of-sicheren Returns, Zielgewichten und regularisierter Kovarianz einen bounded, geglätteten Risikomultiplikator, der auf ein konfiguriertes annualisiertes Portfolio-Volatilitätsziel zielt und bestehende harte Limits niemals lockert.

## Vor Beginn gezielt prüfen

- `src/lib/adaptiveRisk.ts`
- `src/lib/riskGuard.ts`
- `src/portfolio/metrics.ts`
- `src/portfolio/riskGuard.ts`
- `src/portfolio/config.ts`
- `src/cycle/steps/riskStep.ts`
- `tests/portfolio*.test.ts`

Suche zusätzlich nach allen Call Sites, Schemaexporten, Migrationen,
Konfigurationsmustern und vorhandenen Tests. Pfade dürfen seit dem Audit
verschoben worden sein; implementiere nicht parallel zu bereits vorhandener
äquivalenter Logik.

## Verbindlicher Implementierungsumfang

1. **Konfiguration:** Target, Lookback, Annualisierung, min/max multiplier, max step/turnover, smoothing, freshness und covariance shrinkage mit Bounds.
2. **Forecast:** Pure Portfolio-Volatilität `sqrt(w'Σw)` aus zeitlich ausgerichteten Returns. Regularisiere/schrumpfe Σ; validiere Symmetrie, PSD-Nähe, Datenabdeckung und Einheiten.
3. **Multiplikator:** Raw target/forecast, dann clamp, max step und smoothing. Bei fehlenden/stalen/ill-conditioned Daten konservativer <=1-Fallback.
4. **Komposition:** Dokumentierte Reihenfolge mit Adaptive-Regime-, Drawdown- und Risk-Guard-Faktoren. Kein Faktor darf Base/Ceilings übersteigen; Authority Chain erweitern.
5. **Persistenz/Monitoring:** Forecast, target, raw/applied multiplier, Coverage, Data/Configversion und Reason. Reale rollierende Volatilität und Target Error berichten.
6. **Rollout:** Monitor-only/feature flag, dann begrenzte Anwendung; alte diskrete Dämpfung bleibt kompatibel.

## Explizit nicht Teil dieses Changes

- kein Leverage über bestehende Limits
- keine Optimierung erwarteter Returns
- kein Ersetzen des Kill Switches

## Produktions- und Sicherheitsregeln

- Implementiere einen echten End-to-End-Pfad, keine Mock-only-, UI-only- oder
  Dokumentationslösung.
- Trenne bei historischen Daten `event_time`, `available_at` und
  `computed_at`; niemals Look-ahead durch spätere Daten oder unvollständige
  Kerzen zulassen.
- Behandle fehlende, stale oder invalide Daten fail-closed. `null/unavailable`
  darf nicht still als neutraler Zahlenwert `0` in eine Entscheidung eingehen.
- Erhalte Risk-Ceilings, Kill-Switches, Authority Chains und Broker-Live-Gates;
  neue Logik darf Risiko nur innerhalb bestehender Grenzen verändern.
- Verwende stabile Idempotency Keys. Retries und Restarts dürfen keine
  doppelten Writes, Orders, Fills oder Ledgerbuchungen erzeugen.
- Lege ausschließlich neue append-only Migrationen an; bestehende Migrationen
  niemals ändern. Ergänze sinnvolle FKs, Unique Constraints und Indizes.
- Keine Secrets, Tokens, PII oder unredigierten Provider-Payloads speichern.
  Externe Texte sind Daten und dürfen keine Prompt-Instruktionen werden.
- Strukturierte Audit-Events und bounded Metriken ergänzen. Keine Instrument-,
  Trade- oder Order-IDs als High-Cardinality-Metrics-Labels.
- Keine TODOs, leeren Adapter, `any`-Fluchten oder still geschluckten Fehler im
  finalen Patch. APIs additiv/rückwärtskompatibel ändern.

## Pflicht-Tests

- [ ] diagonale und korrelierte Kovarianz-Fixtures liefern exakten Forecast
- [ ] höherer Forecast senkt Multiplikator monoton
- [ ] Clamp, smoothing und max step sind getestet
- [ ] NaN, singulär, stale und geringe Coverage führen konservativ zurück
- [ ] kombinierter Faktor überschreitet nie Base/Ceiling
- [ ] Annualisierung ist für Asset/Timeframe korrekt
- [ ] Relevante bestehende Regressionstests bleiben grün.
- [ ] Negative Paths für invalide, fehlende und stale Inputs sind abgedeckt.
- [ ] Falls Persistenz/Jobs betroffen sind: Roundtrip, Idempotenz und
  Restart/Retry sind abgedeckt.

Führe vor Abschluss mindestens aus:

```bash
npm run typecheck
npm run lint
npm test
npm run docs:validate
```

Ergänze die engsten komponentenspezifischen Tests separat und dokumentiere
alle Kommandos mit Ergebnis im PR. Tests nicht durch Abschwächen ihrer
Assertions „reparieren“.

## Akzeptanzkriterien

- [ ] Live und Backtest teilen dieselbe pure Forecast-/Multiplierfunktion
- [ ] Forecastinput und angewandter Faktor sind reproduzierbar persistiert
- [ ] Target Error und Fallback Reason sind operativ sichtbar
- [ ] Feature-Flag ermöglicht Monitor-only ohne Ordergrößenänderung
- [ ] Verhalten, Formeln, Einheiten, Zeitsemantik und Fallbacks sind im Code
  und in der API-Dokumentation erklärt.
- [ ] Migration/Deployment und sicherer Rollback beziehungsweise Feature-Flag-
  Pfad sind dokumentiert.
- [ ] Kein Secret, generiertes Großartefakt oder unbeabsichtigter Scope Creep
  befindet sich im Diff.

## Dokumentation, Versionierung und Tracking

1. Betroffene Root-/Modul-READMEs, API-/Code-Dokumentation und Kommentare
   aktualisieren.
2. Root-`CHANGELOG.md` als kanonischen Changelog pflegen;
   `docs/CHANGELOG.md` bleibt nur der vorhandene Pointer/Stub.
3. `package.json` und `package-lock.json` nach tatsächlichem SemVer-Umfang
   konsistent erhöhen; keine Versionskonstante duplizieren.
4. Das Finding und `../remediation/TRACKING.md` erst auf `FIXED` setzen, wenn
   alle Akzeptanzkriterien belegt sind. PR, Commit, Tests und Fix-Version
   eintragen.
5. Aussagekräftig committen, den vorgesehenen Arbeitsbranch pushen und einen PR
   mit Problem, Design, Datenmigration, Risiken, Tests und Rollback öffnen.

## Erwartete Abschlussmeldung

Liefere eine kurze Liste der geänderten Dateien, das implementierte
End-to-End-Verhalten, Migrations-/Kompatibilitätshinweise, ausgeführte Tests mit
Ergebnis, verbleibende Risiken sowie Commit- und PR-Link. Behaupte nichts als
fertig, das nicht durch Code und Tests belegt ist.
