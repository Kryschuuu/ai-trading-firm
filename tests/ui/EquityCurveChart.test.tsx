/**
 * Render-Tests der Equity-Kurve (`src/components/report/EquityCurveChart.tsx`)
 * — die echte Komponente, gerendert ohne Browser und ohne Netz.
 *
 * Geprüft werden die Dinge, die vorher fehlten und die der Nutzer benannt hat:
 * beschriftete Achsen (x = Zeit, y = Equity mit Einheit), Drawdown-Darstellung,
 * Trade-Marker, Legende, Tooltip-Grundlage (Titel/ARIA) und der ehrliche
 * Leerzustand. Zusätzlich: die Index-Ansicht („Start = 100“) und das
 * Abschalten der Drawdown-Kurve.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import EquityCurveChart from "../../src/components/report/EquityCurveChart";
import { withDrawdown, type EquityMarker } from "../../src/lib/equityAnalytics";

const POINTS = withDrawdown([
  { ts: "2026-09-01T08:00:00.000Z", equity: 10_000, trigger: "TICK" },
  { ts: "2026-09-01T09:00:00.000Z", equity: 10_500, trigger: "TICK" },
  { ts: "2026-09-01T10:00:00.000Z", equity: 10_200, trigger: "TRADE" },
  { ts: "2026-09-01T11:00:00.000Z", equity: 9_800, trigger: "CLOSE" },
  { ts: "2026-09-01T12:00:00.000Z", equity: 10_400, trigger: "TICK" },
]);

const MARKERS: EquityMarker[] = [
  { id: "p1:entry", kind: "ENTRY", ts: "2026-09-01T09:00:00.000Z", symbol: "BTCUSDT", side: "LONG", price: 60_000 },
  {
    id: "p1:exit",
    kind: "EXIT",
    ts: "2026-09-01T11:00:00.000Z",
    symbol: "BTCUSDT",
    side: "LONG",
    price: 59_000,
    pnl: -120.5,
    exitReason: "STOP_LOSS",
  },
];

function render(props: Partial<Parameters<typeof EquityCurveChart>[0]> = {}): string {
  return renderToStaticMarkup(createElement(EquityCurveChart, { points: POINTS, markers: MARKERS, ...props }));
}

test("Achsen sind beschriftet: y = Equity mit Einheit, x = Zeit mit Zeitzone", () => {
  const html = render();
  assert.match(html, /Equity \(USD\)/);
  assert.match(html, /Zeit \(Europe\/Berlin\)/);
  assert.match(html, /Drawdown vom Höchststand/);
  // y-Achse: „schöne“ Ticks mit deutscher Tausender-Trennung.
  assert.match(html, /9\.800/);
  // x-Achse: Berliner Uhrzeiten (10:00 Uhr UTC = 12:00 MESZ).
  assert.match(html, /12:00/);
});

test("Kennzahlen der Kurve werden als ARIA-Beschreibung mitgeliefert", () => {
  const html = render({ maxDrawdown: { fromTs: POINTS[1].ts, toTs: POINTS[3].ts, pct: 6.67 } });
  assert.match(html, /aria-label="Equity-Kurve von /);
  assert.match(html, /maximaler Drawdown \u22126,67 %/);
  // Der markierte Max-Drawdown-Bereich ist auch sichtbar erklärt.
  assert.match(html, /Max\. Drawdown \u22126,67 % markiert/);
});

test("Legende erklärt Linie, Basislinie, Marker und Unterwasser-Kurve", () => {
  const html = render();
  assert.match(html, /Equity<\/span>/);
  assert.match(html, /Zeitraumstart/);
  assert.match(html, /Einstieg/);
  assert.match(html, /Ausstieg/);
  assert.match(html, /Drawdown \(unter Wasser\)/);
});

test("Trade-Marker tragen einen erklärenden Titel (Hover-Beschreibung)", () => {
  const html = render();
  assert.match(html, /Einstieg BTCUSDT LONG am /);
  assert.match(html, /Ausstieg BTCUSDT LONG am /);
  // `&` wird im Markup escaped — der Titel ist trotzdem vollständig lesbar.
  assert.match(html, /P&amp;L \u2212\$120,50/);
});

test("Index-Ansicht beschriftet die y-Achse als Index (Start = 100)", () => {
  const absolute = render({ mode: "absolute" });
  assert.doesNotMatch(absolute, /Index \(Start = 100\)/);

  const percent = render({ mode: "percent" });
  assert.match(percent, /Index \(Start = 100\)/);
  assert.match(percent, /Start = 100/);
});

test("Drawdown-Kurve lässt sich abschalten (dann keine Unterwasser-Achse)", () => {
  const without = render({ showDrawdown: false });
  assert.doesNotMatch(without, /Drawdown vom Höchststand/);
  assert.doesNotMatch(without, /unter Wasser/);
});

test("Drawdown-Achse beschriftet kleine Prozentwerte mit Nachkommastellen", () => {
  // Bei max. Drawdown 0,86 % wären „0 % / 0 % / 1 %“ zwei identische Labels
  // gewesen — die Achse muss die Auflösung mitliefern.
  const html = render({ points: withDrawdown([
    { ts: "2026-09-01T08:00:00.000Z", equity: 10_000 },
    { ts: "2026-09-01T09:00:00.000Z", equity: 10_000 },
    { ts: "2026-09-01T10:00:00.000Z", equity: 9_914 },
  ]) });
  assert.match(html, /0,43 %/);
  assert.match(html, /0,86 %/);
});

test("Log-Achse wird beschriftet und nutzt das 1/2/5-Raster (mit Hinweis)", () => {
  // Innerhalb einer Dekade sind log und linear deckungsgleich → kein „log“-Label.
  const narrow = render({ logScale: true });
  assert.doesNotMatch(narrow, /Equity \(USD\) · log/);

  // Über mehrere Dekaden (1 000 → 100 000) wird die Achse als log ausgewiesen
  // und die Ticks kommen aus dem 1/2/5-Raster der Zehnerpotenzen.
  const wide = withDrawdown([
    { ts: "2026-09-01T08:00:00.000Z", equity: 1_000 },
    { ts: "2026-09-01T09:00:00.000Z", equity: 4_000 },
    { ts: "2026-09-01T10:00:00.000Z", equity: 12_000 },
    { ts: "2026-09-01T11:00:00.000Z", equity: 60_000 },
    { ts: "2026-09-01T12:00:00.000Z", equity: 100_000 },
  ]);
  const html = render({ logScale: true, points: wide });
  assert.match(html, /Equity \(USD\) · log/);
  assert.match(html, /2\.000/);
  assert.match(html, /50,0 Tsd\./);
  assert.doesNotMatch(render({ logScale: false, points: wide }), /· log/);
});

test("Referenzlinie und Vorperioden-Vergleich erscheinen in Kurve und Legende", () => {
  const benchmark = {
    label: "Bitcoin (BTC/USDT)",
    points: [
      { ts: POINTS[0].ts, value: 10_000 },
      { ts: POINTS[2].ts, value: 10_300 },
      { ts: POINTS[4].ts, value: 11_100 },
    ],
    returnPct: 11,
  };
  const compare = {
    label: "Vorperiode",
    points: [
      { ts: POINTS[0].ts, value: 10_000 },
      { ts: POINTS[2].ts, value: 9_700 },
      { ts: POINTS[4].ts, value: 9_900 },
    ],
  };
  const html = render({ benchmark, compare });
  assert.match(html, /Referenz Bitcoin \(BTC\/USDT\)/); // im aria-label
  assert.match(html, /stroke-slate-300\/80/); // Benchmark-Linie (gestrichelt, hell)
  assert.match(html, /stroke-sky-400\/80/); // Vergleichslinie (gepunktet, blau)
  // Beide Linien stehen in der Legende — mit Namen, nicht als „irgendeine Linie“.
  assert.match(html, /Bitcoin \(BTC\/USDT\)<\/span>/);
  assert.match(html, /Vorperiode<\/span>/);
});

test("Ohne Referenz/Vergleich bleibt die Zeichenfläche unverändert (kein Geisterpfad)", () => {
  const html = render();
  assert.doesNotMatch(html, /stroke-slate-300\/80/);
  assert.doesNotMatch(html, /stroke-sky-400\/80/);
  assert.doesNotMatch(html, /Vorperiode/);
});

test("Zu wenig Historie: ehrlicher Hinweis statt leerer Achsen", () => {
  const html = render({ points: [POINTS[0]] });
  assert.match(html, /Noch zu wenig Historie/);
  assert.doesNotMatch(html, /Equity \(USD\)/);
});
