import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describeAuditTrail, summarizeAuditTrail, type AuditEntryDto } from "../src/lib/auditView";
import { AuditTrailList } from "../src/components/common/AuditTrailList";
import { Pager, usePagination } from "../src/components/common/Pager";
import { ProtocolList } from "../src/components/common/ProtocolList";
import type { ProtocolEntryDto } from "../src/lib/types";

/**
 * Render-Test der tatsächlichen UI-Komponenten (nicht einer Nachbildung):
 * Er beweist, dass die lesbaren Listen und das Paging wirklich gerendert werden
 * und dass keine Daten abgeschnitten ankommen.
 */

const AT = "2026-08-27T14:56:14.249Z";

/** Originalgetreue Stichprobe aus dem gemeldeten Audit-Trail. */
const SAMPLE: AuditEntryDto[] = [
  {
    id: "a1",
    createdAt: AT,
    event: "RISK_ADAPTIVE",
    level: "INFO",
    detail: { at: AT, factor: 1, reason: "Alle Indikatoren ruhig", regime: "NORMAL", prevRegime: "NORMAL", triggered: [] },
  },
  {
    id: "a2",
    createdAt: AT,
    event: "ORDER_REJECTED",
    level: "WARN",
    detail: { role: "SCOUT", reason: "ROLE_NOT_ALLOWED_TO_TRADE" },
  },
  {
    id: "a3",
    createdAt: AT,
    event: "ORDER_SENT",
    level: "INFO",
    detail: {
      order: { symbol: "SOL", side: "LONG", qty: 14.34402, riskNotional: 1497.4, stopLoss: 99.2, takeProfit: 112.4 },
      fill: {
        orderId: "ord-1",
        symbol: "SOL",
        side: "LONG",
        qty: 14.34402,
        fillPrice: 104.36426,
        stopLoss: 99.2,
        takeProfit: 112.4,
        status: "FILLED",
      },
    },
  },
  {
    id: "a4",
    createdAt: AT,
    event: "RULE_MACRO_REJECTED",
    level: "WARN",
    detail: { symbol: "BTC", reason: "Rational", ceoRaw: '{"verdict":"REJECT","rule":null,"reason":"Rational' },
  },
  {
    id: "a5",
    createdAt: AT,
    event: "ORDER_REJECTED",
    level: "WARN",
    detail: { role: "EXECUTOR", reason: "ROLE_NOT_ALLOWED_TO_TRADE" },
  },
];

test("Audit-Liste rendert deutsche Titel, Stufen und ungekürzte Werte", () => {
  const views = describeAuditTrail(SAMPLE);
  const markup = renderToStaticMarkup(
    createElement(AuditTrailList, {
      views,
      summary: summarizeAuditTrail(views),
      // Alle aufklappen → auch Details und Rohdaten müssen im Markup stehen.
      initialOpen: SAMPLE.map((entry) => entry.id),
    })
  );

  // Deutsche Event-Titel statt technischer Codes in der Kopfzeile.
  for (const expected of [
    "Risiko angepasst",
    "Order abgelehnt",
    "Order ausgeführt",
    "Makro-Regel abgelehnt",
  ]) {
    assert.ok(markup.includes(expected), `Fehlender Titel: ${expected}`);
  }
  assert.ok(markup.includes("Information") && markup.includes("Warnung"), "Stufen fehlen");

  // Werte werden vollständig angezeigt — keine 70-Zeichen-Kürzung, kein Runden.
  // (Deutsche Zahlendarstellung: Komma als Dezimaltrenner.)
  assert.ok(markup.includes("14,34402 Stück"), "Menge wurde abgeschnitten");
  assert.ok(markup.includes("104,36426 USD"), "Füllpreis wurde abgeschnitten");
  assert.ok(markup.includes("ROLE_NOT_ALLOWED_TO_TRADE"), "Roh-Grund fehlt");

  // Beschriftete Felder statt technischer Schlüssel.
  assert.ok(markup.includes("Richtung"), "Feldlabel 'Richtung' fehlt");
  assert.ok(markup.includes("Orderausführung (fill)"), "Fill-Sektion fehlt");
  assert.ok(markup.includes("CEO-Verdikt"), "CEO-Feld fehlt");

  // Logische Bewertung sichtbar: Widerspruch (EXECUTOR) vs. korrektes Mandat (SCOUT).
  assert.ok(markup.includes("Widerspruch"), "Widerspruch wird nicht gekennzeichnet");
  assert.ok(markup.includes("Korrekt nach Rollen-Mandat"), "Korrekte Ablehnung wird nicht eingeordnet");

  // Antwort auf die Kernfrage des Nutzers: Fehler oder korrektes Systemverhalten?
  assert.ok(
    markup.includes("Nur Research und Executor dürfen Orders auslösen"),
    "Erklärung des Rollen-Mandats fehlt"
  );
  assert.ok(
    markup.includes("kein Fehler, sondern gelebtes Rollen-Mandat"),
    "Einordnung 'korrektes Systemverhalten' fehlt"
  );
});

test("Paging-Leiste bietet 20/50/100/200 und zeigt den Seitenstand", () => {
  function Harness() {
    const pagination = usePagination(137);
    return createElement(Pager, { pagination, label: "Ereignisse" });
  }

  const markup = renderToStaticMarkup(createElement(Harness));
  for (const option of ["20", "50", "100", "200"]) {
    assert.ok(markup.includes(`value="${option}"`), `Seitengröße ${option} fehlt`);
  }
  assert.ok(markup.includes("Seite 1 von 7"), "Seitenstand fehlt");
  assert.ok(markup.includes("Ereignisse 1–20 von 137"), "Anzeigefenster fehlt");
  // Default 20: erste Seite ist aktiv, Zurück deaktiviert.
  assert.ok(markup.includes("disabled=\"\""), "Zurück müsste auf Seite 1 deaktiviert sein");
});

test("Protokoll-Liste rendert Kurzfassung, Details und Rohdaten", () => {
  const entries: ProtocolEntryDto[] = [
    {
      id: "p1",
      at: AT,
      kind: "turn",
      messageType: "REPORT",
      missionId: null,
      actor: { name: "Rhea (Research)", role: "RESEARCH", source: "agent" },
      content: "Trend bestätigt, Einstieg im Pullback.",
      decision: { type: "TRADE", symbol: "BTC", side: "LONG", stopLossPct: 5, reason: "Trend bestätigt." },
      trace: {
        source: "ollama",
        model: "qwen2.5:3b-instruct-q4_K_M",
        latencyMs: 1340,
        prompt: "vollständiger Prompt",
        rawResponse: '{"type":"TRADE"}',
        provider: "ollama",
        usage: null,
        costUsd: null,
      },
      raw: {
        id: "p1",
        createdAt: AT,
        agentId: "agent-1",
        missionId: null,
        type: "REPORT",
        content: "Trend bestätigt, Einstieg im Pullback.",
        meta: { decision: { type: "TRADE", symbol: "BTC" }, source: "ollama" },
      },
    },
    {
      id: "p2",
      at: AT,
      kind: "analysis",
      messageType: "ANALYSIS",
      missionId: null,
      actor: { name: "Cassini (Macro)", role: "MACRO_ANALYST", source: "agent" },
      content: "[MACRO] NEUTRAL: Gemischte Datenlage.",
      analysis: { view: "NEUTRAL", confidence: 0.65, thesis: "Gemischte Datenlage." },
      trace: { source: null, model: null, latencyMs: null, prompt: null, rawResponse: null, provider: null, usage: null, costUsd: null },
    },
  ];

  const markup = renderToStaticMarkup(
    createElement(ProtocolList, { entries, initialOpen: entries.map((entry) => entry.id) })
  );
  assert.ok(markup.includes("Rhea (Research)"), "Akteur fehlt");
  assert.ok(markup.includes("RESEARCH — Research (Marktanalyse)"), "Rollenbeschreibung fehlt");
  assert.ok(markup.includes("TRADE"), "Entscheidungs-Badge fehlt");
  assert.ok(markup.includes("Trend bestätigt, Einstieg im Pullback."), "Inhalt fehlt oder ist gekürzt");
  assert.ok(markup.includes("Einstufung NEUTRAL"), "Analystenbericht fehlt");
  assert.ok(markup.includes("Rohdaten (DB-Eintrag)"), "Rohdaten-Reiter fehlt");
  assert.ok(markup.includes("27.08.2026, 14:56:14 UTC"), "UTC-Zeitstempel fehlt");
});
