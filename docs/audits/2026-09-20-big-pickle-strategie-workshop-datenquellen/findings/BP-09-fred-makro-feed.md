# BP-09: Kein Makro-/Kalenderdaten-Feed (FRED); Regime ohne Makro-Input

- **Antwort:** Offen
- **Tracking-Status:** `OPEN`
- **Severity:** `LOW–MEDIUM`
- **Quick Estimate Restaufwand:** **2–4 PT**
- **Umsetzungs-Prompt:** [`PROMPT-BP-09`](../prompts/PROMPT-BP-09-fred-makro-feed.md)

## Verifizierte Fundstellen

- `src/lib/marketRegime.ts` — Regime-Erkennung wird **ausschließlich aus
  Kerzen** abgeleitet (ADX, BBW, StdDev; Architektur-Test in
  `tests/marketRegime.test.ts`). Kein makroökonomischer Input.
- `src/cycle/steps/newsStep.ts` — externer Nachrichten-Strom (RSS/Finviz,
  Headlines) vorhanden, aber keine Kalender-/Makro-Serie.
- `src/cycle/steps/macroStep.ts` — Makro-Prompt ohne externe Makrozeitreihen.
- Vorhandene Vorlage `news-event-shield` (Missionen-Katalog) setzt
  terminkritische Wochen voraus, erhält dafür aber keine Kalenderdaten.

## Bewertung und Abgrenzung

Das Regime nutzt nur intrinsische Volatilitäts-/Trendgrößen. Ein kostenloser
Makro-Feed (FRED: CPI, Leitzins, VIX-Anker; optional Wirtschaftskalender bei
Finnhub) kann den Makro-Kontext und die `news-event-shield`-Logik mit
fundierten Kontextzeilen versorgen — als eigenständiges, kleines vertikales
Slice, das die bestehende Feed-Architektur (SSRF-Allowlist, Fail-soft) wiederverwendet.
Synergie mit RMA-P2-01 (Regime-Erkennung): dieser Befund liefert nur den
externen Datenpfad, keine neue Regime-Logik.

## Konkretes Delta

- FRED-Reader (keylos bzw. optionaler Env-Key) für zentrale Serien; Host
  `api.stlouisfed.org` in `PAPER_FEED_ALLOWED_HOSTS`.
- Kontextzeilen im Makro-Zyklus (Regime-Envelope) und optional für
  `news-event-shield`-Missionen; fehlende Serien = Fail-soft (kein Prompt-Fill).

## Akzeptanzkriterien für `FIXED`

- [ ] FRED-Serie wird korrekt umgesetzt (Zeitreihe, Einheiten dokumentiert).
- [ ] fehlende/stale Serien erzeugen keinen Halluzinationsraum (Fail-soft-Test).
- [ ] Externe Werte landen ausschließlich als strukturierte Daten im
      untrustedData-Pfad (Anti-Injection).
- [ ] Pflichtgates grün.

## Review-Evidenz

- Audit-Basis: Commit `7d8b07b`, Produktversion `v1.51.3`.
- Methode: Regime- und Cycle-Step-Pfadprüfung.