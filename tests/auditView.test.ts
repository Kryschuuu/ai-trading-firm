import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeAuditEntry,
  describeAuditTrail,
  formatNumber,
  formatRelative,
  formatTimestampUtc,
  parseCeoVerdict,
  summarizeAuditTrail,
  summarizeProtocolEntry,
  firstSentence,
  type AuditEntryDto,
} from "../src/lib/auditView";

/** Zeitstempel aus dem gemeldeten Audit-Trail (fixiert, damit Tests stabil sind). */
const AT = "2026-08-27T14:56:14.249Z";
const NOW = new Date("2026-08-27T15:00:00.000Z");

function entry(event: string, level: string, detail: unknown, overrides: Partial<AuditEntryDto> = {}): AuditEntryDto {
  return {
    id: `${event}-${Math.random().toString(36).slice(2)}`,
    createdAt: AT,
    event,
    level,
    detail,
    ...overrides,
  };
}

test("Zeitstempel: eindeutig in UTC statt lokaler Browserzeit", () => {
  assert.equal(formatTimestampUtc(AT, NOW), "27.08.2026, 14:56:14 UTC");
  assert.equal(formatTimestampUtc("kaputt", NOW), "Zeitstempel fehlt");
  assert.equal(formatRelative(AT, NOW), "vor 4 Minuten");
  assert.equal(formatNumber(1234.5678), "1.234,57");
});

test("AGENT_DECISION: deutsche Zusammenfassung mit Rolle, Modell und Quelle", () => {
  const view = describeAuditEntry(
    entry("AGENT_DECISION", "INFO", {
      role: "SCOUT",
      model: "qwen2.5:3b-instruct-q4_K_M",
      source: "ollama",
      latencyMs: 1340,
      decision: { type: "TRADE", symbol: "BTC", side: "LONG", stopLossPct: 5, reason: "Trend bestätigt." },
    }),
    NOW
  );

  assert.equal(view.eventLabel, "Agent-Entscheidung");
  assert.equal(view.levelLabel, "Information");
  assert.equal(view.tone, "info");
  assert.match(view.headline, /SCOUT entscheidet TRADE für BTC/);

  const flat = view.sections.flatMap((section) => section.facts);
  const label = (name: string) => flat.find((fact) => fact.label === name)?.value;
  assert.match(label("Rolle") ?? "", /Scout \(Penny-Screener\)/);
  assert.match(label("Quelle") ?? "", /Lokales LLM \(Ollama\)/);
  assert.equal(label("Antwortzeit"), "1,3 s");
  assert.match(label("KI-Modell") ?? "", /3 Mrd\. Parameter/);
  assert.match(label("Entscheidungstyp") ?? "", /TRADE — handeln/);
  assert.match(label("Stop-Loss \(%\)") ?? "", /5 %/);
  // Keine Felder gehen verloren — der Rohdaten-Reiter enthält alles.
  assert.match(view.raw, /"latencyMs": 1340/);
});

test("AGENT_DECISION: TRADE einer Rolle ohne Mandat wird eingeordnet, nicht als Fehler", () => {
  const view = describeAuditEntry(
    entry("AGENT_DECISION", "INFO", { role: "SCOUT", source: "ollama", decision: { type: "TRADE", symbol: "BTC" } }),
    NOW
  );
  const issue = view.issues.find((item) => item.title.includes("darf nicht handeln"));
  assert.ok(issue, "Erwartete Einordnung für SCOUT");
  assert.equal(issue.severity, "info");
  assert.match(issue.detail, /ausschließlich Research und Executor/);
});

test("ORDER_REJECTED: SCOUT ist korrektes Rollen-Mandat (kein logischer Fehler)", () => {
  const view = describeAuditEntry(
    entry("ORDER_REJECTED", "WARN", { role: "SCOUT", reason: "ROLE_NOT_ALLOWED_TO_TRADE" }),
    NOW
  );

  assert.equal(view.eventLabel, "Order abgelehnt");
  assert.equal(view.tone, "warn");
  assert.match(view.headline, /Rolle ohne Handelsmandat — ausgelöst von SCOUT/);
  assert.match(view.explanation, /Nur Research und Executor dürfen Orders auslösen/);

  const info = view.issues.find((item) => item.severity === "info");
  assert.ok(info, "Erwartete Info-Einordnung");
  assert.match(info.title, /Korrekt nach Rollen-Mandat/);
  assert.equal(view.issues.some((item) => item.severity === "error"), false);
});

test("ORDER_REJECTED: EXECUTOR mit Rollen-Ablehnung ist ein Widerspruch", () => {
  const view = describeAuditEntry(
    entry("ORDER_REJECTED", "WARN", { role: "EXECUTOR", reason: "ROLE_NOT_ALLOWED_TO_TRADE" }),
    NOW
  );
  const error = view.issues.find((item) => item.severity === "error");
  assert.ok(error, "Erwarteter Widerspruch für EXECUTOR");
  assert.match(error.title, /Widerspruch/);
  assert.match(error.detail, /Rollen-Prüfung/);
});

test("ORDER_REJECTED: unbekannter Grund wird als Lücke im Katalog gekennzeichnet", () => {
  const view = describeAuditEntry(entry("ORDER_REJECTED", "WARN", { reason: "SOMETHING_NEW" }), NOW);
  const warn = view.issues.find((item) => item.severity === "warn");
  assert.ok(warn);
  assert.match(warn.title, /Unbekannter Ablehnungsgrund SOMETHING_NEW/);
});

test("ORDER_REJECTED: Fill-Details werden vollständig und beschriftet angezeigt", () => {
  const view = describeAuditEntry(
    entry("ORDER_REJECTED", "WARN", {
      fill: {
        orderId: "ord-1",
        symbol: "SOL",
        side: "LONG",
        qty: 14.367645,
        fillPrice: 104.2,
        stopLoss: 99.1,
        takeProfit: 110.5,
        status: "REJECTED",
        reason: "POSITION_ALREADY_OPEN",
      },
    }),
    NOW
  );

  const flat = view.sections.flatMap((section) => section.facts);
  const label = (name: string) => flat.find((fact) => fact.label === name)?.value;
  assert.match(label("Menge") ?? "", /14,367645 Stück/);
  assert.match(label("Richtung") ?? "", /LONG — Kaufposition/);
  assert.match(label("Status") ?? "", /Abgelehnt/);
  assert.match(label("Ablehnungsgrund") ?? "", /Position im Symbol bereits offen/);
  assert.match(view.explanation, /Nachkäufe sind gesperrt/);
});

test("ORDER_SENT: gefüllte Order zeigt Menge, Richtung, Symbol und Preis", () => {
  const view = describeAuditEntry(
    entry("ORDER_SENT", "INFO", {
      order: { symbol: "SOL", side: "LONG", qty: 14.34402, riskNotional: 1497.4, stopLoss: 99.2, takeProfit: 112.4 },
      fill: {
        orderId: "ord-2",
        symbol: "SOL",
        side: "LONG",
        qty: 14.34402,
        fillPrice: 104.36,
        stopLoss: 99.2,
        takeProfit: 112.4,
        status: "FILLED",
      },
    }),
    NOW
  );

  assert.equal(view.eventLabel, "Order ausgeführt");
  assert.match(view.headline, /LONG 14,34402 SOL @ 104,36 USD/);
  assert.equal(view.issues.length, 0);
  const flat = view.sections.flatMap((section) => section.facts);
  assert.match(
    flat.find((fact) => fact.label === "Take-Profit (Kurs)")?.value ?? "",
    /112,4 USD/
  );
});

test("ORDER_SENT: Fill-Status REJECTED ist ein Widerspruch zum Event-Namen", () => {
  const view = describeAuditEntry(
    entry("ORDER_SENT", "INFO", {
      fill: { symbol: "SOL", side: "LONG", qty: 1, fillPrice: 1, stopLoss: 0.9, takeProfit: 1.1, status: "REJECTED" },
    }),
    NOW
  );
  const error = view.issues.find((item) => item.severity === "error");
  assert.ok(error);
  assert.match(error.title, /Widerspruch: Event meldet Ausführung/);
});

test("TAKE_PROFIT_HIT: Long-Gewinn wird nachvollziehbar erklärt", () => {
  const view = describeAuditEntry(
    entry("TAKE_PROFIT_HIT", "INFO", {
      symbol: "SOL",
      entry: 104.36426,
      exit: 106.67,
      qty: "14.34402",
      side: "LONG",
      realizedPnl: 33.08,
      triggerPrice: 106.7,
    }),
    NOW
  );

  assert.equal(view.eventLabel, "Take-Profit erreicht");
  assert.match(view.headline, /LONG · SOL · 104,36426 → 106,67 · \+33,08 USD/);
  assert.equal(view.issues.length, 0);
  const flat = view.sections.flatMap((section) => section.facts);
  assert.equal(flat.find((fact) => fact.label === "Realisierter Gewinn/Verlust")?.tone, "good");
});

test("TAKE_PROFIT_HIT: Ausstieg unter Einstieg bei Long ist ein Widerspruch", () => {
  const view = describeAuditEntry(
    entry("TAKE_PROFIT_HIT", "INFO", { symbol: "SOL", entry: 104.36, exit: 100.1, qty: 1, side: "LONG", realizedPnl: -4 }),
    NOW
  );
  const error = view.issues.find((item) => item.severity === "error");
  assert.ok(error);
  assert.match(error.title, /Take-Profit unter Einstieg/);
});

test("MISSION_CREATED/UPDATED: Titel bleibt ungekürzt, Quelle wird benannt", () => {
  const created = describeAuditEntry(
    entry("MISSION_CREATED", "INFO", {
      via: "workshop-ui",
      title: "ETH Trendfolge Down- / uptrend daytrade",
      symbol: "ETH",
      riskBudget: 0.02,
      maxPositionPct: 0.25,
    }),
    NOW
  );

  assert.equal(created.eventLabel, "Mission erstellt");
  assert.ok(created.headline.includes("ETH Trendfolge Down- / uptrend daytrade"));
  assert.match(created.headline, /Quelle: Workshop \(manuelle Eingabe\)/);

  const flat = created.sections.flatMap((section) => section.facts);
  assert.equal(flat.find((fact) => fact.label === "Risikobudget")?.value, "2 %");
  assert.equal(flat.find((fact) => fact.label === "Max. Positionsgröße")?.value, "25 %");

  const updated = describeAuditEntry(
    entry("MISSION_UPDATED", "INFO", { via: "workshop-ui", title: "BTC Trendfolge" }),
    NOW
  );
  assert.equal(updated.eventLabel, "Mission aktualisiert");
});

test("RULE_MACRO_REJECTED: abgeschnittene CEO-Antwort wird trotzdem ausgewertet", () => {
  // Exakt die Form aus dem gemeldeten Audit-Trail: nur die ersten 500 Zeichen.
  const raw = '{"verdict":"REJECT","rule":null,"reason":"Rational';
  const parsed = parseCeoVerdict(raw);
  assert.equal(parsed.verdict, "REJECT");
  assert.equal(parsed.reason, "Rational");
  assert.equal(parsed.parseable, false);
  assert.equal(parsed.truncated, true);

  const view = describeAuditEntry(entry("RULE_MACRO_REJECTED", "WARN", { symbol: "BTC", reason: "Rational", ceoRaw: raw }), NOW);
  assert.equal(view.eventLabel, "Makro-Regel abgelehnt");
  assert.match(view.headline, /CEO lehnt Regel für BTC \(Verdikt: REJECT\)/);
  assert.match(view.explanation, /Begründung des CEO: Rational/);

  const flat = view.sections.flatMap((section) => section.facts);
  assert.match(flat.find((fact) => fact.label === "CEO-Verdikt")?.value ?? "", /REJECT — Regel abgelehnt/);
  assert.match(
    flat.find((fact) => fact.label === "Auswertbarkeit der CEO-Antwort")?.value ?? "",
    /gekürzt gespeichert/
  );

  const info = view.issues.find((item) => item.severity === "info");
  assert.ok(info);
  assert.match(info.title, /Antwort gekürzt protokolliert/);
  assert.equal(view.issues.some((item) => item.severity === "error"), false);
});

test("RULE_MACRO_REJECTED: Verdikt APPROVE im Event ist ein Widerspruch", () => {
  const view = describeAuditEntry(
    entry("RULE_MACRO_REJECTED", "WARN", { ceoRaw: '{"verdict":"APPROVE","rule":null,"reason":"ok"}' }),
    NOW
  );
  const error = view.issues.find((item) => item.severity === "error");
  assert.ok(error);
  assert.match(error.title, /Widerspruch: Verdikt APPROVE/);
});

test("RISK_ADAPTIVE: Faktor 1 bei NORMAL ist korrekt, bei ELEVATED auffällig, > 1 ein Fehler", () => {
  const normal = describeAuditEntry(
    entry("RISK_ADAPTIVE", "INFO", {
      at: AT,
      factor: 1,
      reason: "Alle Indikatoren ruhig",
      regime: "NORMAL",
      prevRegime: "NORMAL",
      baseMaxRiskPerTrade: 0.02,
      effectiveMaxRiskPerTrade: 0.02,
      triggered: [],
    }),
    NOW
  );
  assert.equal(normal.eventLabel, "Risiko angepasst");
  assert.equal(normal.issues.length, 0);
  assert.match(normal.headline, /Regime NORMAL/);
  const normalFacts = normal.sections.flatMap((section) => section.facts);
  assert.match(normalFacts.find((fact) => fact.label === "Risiko-Multiplikator")?.value ?? "", /volles Risiko/);
  assert.equal(normalFacts.find((fact) => fact.label === "Basis-Risiko pro Trade")?.value, "2 %");

  const elevated = describeAuditEntry(
    entry("RISK_ADAPTIVE", "WARN", { factor: 1, regime: "ELEVATED", prevRegime: "NORMAL", triggered: [] }),
    NOW
  );
  assert.ok(elevated.issues.some((issue) => issue.severity === "warn" && /keine Reduktion/.test(issue.title)));

  const broken = describeAuditEntry(
    entry("RISK_ADAPTIVE", "WARN", { factor: 1.5, regime: "EXTREME", prevRegime: "NORMAL", triggered: [] }),
    NOW
  );
  assert.ok(broken.issues.some((issue) => issue.severity === "error" && /Risiko erhöht/.test(issue.title)));
});

test("Unbekanntes Event: alle Felder bleiben lesbar erhalten", () => {
  const view = describeAuditEntry(
    entry("BRAND_NEW_EVENT", "INFO", { someValue: 42, nestedThing: { innerKey: "wert" } }),
    NOW
  );
  assert.match(view.eventDescription, /nicht hinterlegt/);
  const flat = view.sections.flatMap((section) => section.facts);
  assert.equal(flat.find((fact) => fact.label === "Some Value")?.value, "42");
  assert.equal(
    view.sections.find((section) => section.title.includes("nestedThing"))?.facts[0]?.value,
    "wert"
  );
  assert.match(view.raw, /"someValue": 42/);
});

test("Audit ohne Detail: fehlender Payload wird gemeldet statt still geschluckt", () => {
  const view = describeAuditEntry(entry("AGENT_DECISION", "INFO", null), NOW);
  assert.ok(view.issues.some((issue) => /Keine Detaildaten/.test(issue.title)));
});

test("Muster: drei gleiche Ablehnungen in kurzer Folge werden einmal gemeldet", () => {
  const entries: AuditEntryDto[] = [
    entry("ORDER_REJECTED", "WARN", { role: "SCOUT", reason: "ROLE_NOT_ALLOWED_TO_TRADE" }, { id: "r3", createdAt: "2026-08-27T14:56:00.000Z" }),
    entry("ORDER_REJECTED", "WARN", { role: "SCOUT", reason: "ROLE_NOT_ALLOWED_TO_TRADE" }, { id: "r2", createdAt: "2026-08-27T14:54:00.000Z" }),
    entry("ORDER_REJECTED", "WARN", { role: "SCOUT", reason: "ROLE_NOT_ALLOWED_TO_TRADE" }, { id: "r1", createdAt: "2026-08-27T14:52:00.000Z" }),
    // Älter als das 10-Minuten-Fenster → zählt nicht mit.
    entry("ORDER_REJECTED", "WARN", { role: "SCOUT", reason: "ROLE_NOT_ALLOWED_TO_TRADE" }, { id: "r0", createdAt: "2026-08-27T12:00:00.000Z" }),
  ];

  const views = describeAuditTrail(entries, NOW);
  const patterns = views.flatMap((view) => view.issues.filter((issue) => issue.title.startsWith("Muster")));
  assert.equal(patterns.length, 1);
  assert.match(patterns[0].title, /3× gleiche Ablehnung/);
  assert.equal(views.find((view) => view.id === "r3")?.issues.some((issue) => issue.title.startsWith("Muster")), true);
});

test("Muster: doppelt angelegte Missionen werden gekennzeichnet", () => {
  const views = describeAuditTrail(
    [
      entry("MISSION_CREATED", "INFO", { title: "BTC Trendfolge Down- / uptrend daytrade" }, { id: "m1", createdAt: "2026-08-27T14:00:00.000Z" }),
      entry("MISSION_CREATED", "INFO", { title: "BTC Trendfolge Down- / uptrend daytrade" }, { id: "m2", createdAt: "2026-08-27T14:30:00.000Z" }),
      entry("MISSION_CREATED", "INFO", { title: "ETH Trendfolge" }, { id: "m3", createdAt: "2026-08-27T14:31:00.000Z" }),
    ],
    NOW
  );
  const duplicates = views.flatMap((view) => view.issues.filter((issue) => /Missionstitel/.test(issue.title)));
  assert.equal(duplicates.length, 1);
  assert.match(duplicates[0].detail, /2× vergeben|2×/);
});

test("Zusammenfassung zählt Stufen und Befunde für die Kopfzeile", () => {
  const views = describeAuditTrail(
    [
      entry("AGENT_DECISION", "INFO", { role: "CEO", decision: { type: "HOLD" }, source: "ollama" }, { id: "a1" }),
      entry("ORDER_REJECTED", "WARN", { role: "EXECUTOR", reason: "ROLE_NOT_ALLOWED_TO_TRADE" }, { id: "a2" }),
      entry("KILL_SWITCH", "CRITICAL", { reason: "DAILY_LOSS_LIMIT" }, { id: "a3" }),
    ],
    NOW
  );
  const summary = summarizeAuditTrail(views);
  assert.equal(summary.total, 3);
  assert.equal(summary.info, 1);
  assert.equal(summary.warn, 1);
  assert.equal(summary.critical, 1);
  assert.equal(summary.contradictions, 1);
  assert.ok(summary.issues >= 1);
});

test("Protokoll: Kurzfassung für Turn und Analystenbericht", () => {
  const turn = summarizeProtocolEntry({
    id: "t1",
    at: AT,
    kind: "turn",
    messageType: "REPORT",
    actor: { name: "Rhea (Research)", role: "RESEARCH" },
    content: "Trend bestätigt.",
    decision: { type: "TRADE", symbol: "BTC", side: "LONG", stopLossPct: 5, reason: "Trend bestätigt." },
    trace: { source: "ollama", model: "qwen2.5:3b", latencyMs: 1200 },
  });
  assert.match(turn, /TRADE — handeln · BTC · LONG · Stop-Loss 5 %/);

  const analysis = summarizeProtocolEntry({
    id: "a1",
    at: AT,
    kind: "analysis",
    messageType: "ANALYSIS",
    actor: { name: "Cassini (Macro)", role: "MACRO_ANALYST" },
    content: "[MACRO] NEUTRAL: Gemischte Datenlage.",
    analysis: { view: "NEUTRAL", confidence: 0.65, thesis: "Gemischte Datenlage." },
    trace: null,
  });
  assert.match(analysis, /Einstufung NEUTRAL · Konfidenz 65 %/);
});

test("Lesbarkeit: Kürzung passiert an Wortgrenzen, nie mitten im Wort", () => {
  assert.equal(firstSentence("kurzer Text"), "kurzer Text");
  const long = "Wort ".repeat(60).trim();
  const cut = firstSentence(long, 40);
  assert.ok(cut.length <= 42);
  assert.ok(cut.endsWith("…"));
  assert.ok(!cut.slice(0, -2).endsWith("Wor"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Regressionsschutz: Jedes Event, das der Code schreibt, muss im UI-Katalog
// stehen. Sonst landet es in der generischen Ansicht ("nicht hinterlegt").
// ─────────────────────────────────────────────────────────────────────────────

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_EVENT_CATALOG } from "../src/lib/auditView";

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectSourceFiles(full));
    else if (full.endsWith(".ts") && !full.endsWith("auditView.ts")) out.push(full);
  }
  return out;
}

test("Katalog: jedes im Code geschriebene Audit-Event ist lesbar beschrieben", () => {
  const source = collectSourceFiles(join(process.cwd(), "src"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  const written = new Set<string>();
  // 1) logAudit("EVENT", …) / ruleAudit("EVENT", …) / writeAudit("EVENT", …)
  for (const match of source.matchAll(/(?:logAudit|ruleAudit|writeAudit)\(\s*\n?\s*"([A-Z][A-Z0-9_]+)"/g)) {
    written.add(match[1]);
  }
  // 2) Bedingte Events direkt am Audit-Aufruf, z. B.
  //    logAudit(fill.status === "FILLED" ? "ORDER_SENT" : "ORDER_REJECTED", …)
  for (const match of source.matchAll(
    /(?:logAudit|ruleAudit|writeAudit)\([\s\S]{0,200}?\?\s*"([A-Z][A-Z0-9_]+)"\s*:\s*"([A-Z][A-Z0-9_]+)"/g
  )) {
    written.add(match[1]);
    written.add(match[2]);
  }
  // 3) Direkte Inserts: db.insert(auditLog).values({ event: "EVENT", … })
  for (const match of source.matchAll(/insert\(auditLog\)\s*\.\s*values\(\{[^}]*?event:\s*"([A-Z][A-Z0-9_]+)"/g)) {
    written.add(match[1]);
  }

  // Sanity-Check: Die Muster müssen die bekannten Kern-Events finden, sonst
  // wurde der Quellcode umgestellt und der Test wäre wirkungslos.
  for (const expected of ["AGENT_DECISION", "ORDER_SENT", "TAKE_PROFIT_HIT", "RISK_ADAPTIVE", "ERROR"]) {
    assert.ok(written.has(expected), `Muster findet ${expected} nicht mehr`);
  }
  assert.ok(written.size >= 25, `Zu wenige Events gefunden (${written.size}) — Muster passt nicht mehr.`);

  const missing = [...written].filter((event) => !AUDIT_EVENT_CATALOG[event]).sort();
  assert.deepEqual(missing, [], `Diese Audit-Events haben keine deutsche Beschreibung: ${missing.join(", ")}`);
});

test("KILL_SWITCH: Tagesverlust-Limit wird erklärt, Equity ohne Vorzeichen", () => {
  const view = describeAuditEntry(
    entry(
      "KILL_SWITCH",
      "CRITICAL",
      { reason: "DAILY_LOSS_LIMIT", realizedToday: -230.5, equity: 9769.5, dailyLossLimitPct: 0.02 },
      { id: "k1" }
    ),
    NOW
  );

  assert.equal(view.eventLabel, "Not-Halt ausgelöst");
  assert.equal(view.tone, "critical");
  assert.match(view.headline, /Tagesverlust-Limit erreicht/);
  assert.match(view.explanation, /Neueröffnungen sind bis zum nächsten Tag gestoppt/);

  const facts = view.sections.flatMap((section) => section.facts);
  assert.equal(facts.find((fact) => fact.label === "Kontostand (Equity)")?.value, "9.769,5 USD");
  assert.equal(facts.find((fact) => fact.label === "Realisierter Tages-P&L")?.value, "−230,5 USD");
  assert.equal(facts.find((fact) => fact.label === "Tagesverlust-Limit")?.value, "2 %");
});

test("FLATTEN_ALL: geschlossene Positionen zeigen realisiertes Ergebnis", () => {
  const view = describeAuditEntry(
    entry("FLATTEN_ALL", "CRITICAL", {
      reason: "MANUAL_FLATTEN",
      closed: 1,
      fills: [{ orderId: "o9", symbol: "BTC", side: "LONG", qty: 0.05, fillPrice: 61000, status: "FILLED", realizedPnl: -12.4 }],
    }, { id: "f1" }),
    NOW
  );

  assert.equal(view.eventLabel, "Alle Positionen glattgestellt");
  const flattenSection = view.sections.find((section) => section.title.startsWith("Geschlossene Position 1"));
  assert.ok(flattenSection, "Fill-Sektion fehlt");
  assert.equal(
    flattenSection.facts.find((fact) => fact.label === "Realisierter Gewinn/Verlust")?.value,
    "−12,4 USD"
  );
});
