/**
 * ADR-003 + ADR-004 — Konformitätstests.
 *
 * Diese Test-Datei hält die Architektur-Entscheidungen aus
 * `docs/roadmap/DECISIONS.md` (ADR-003 Atomare Mehrprozess-Order-
 * Reservierung / ADR-004 Zentrale Singleton-Verwaltung) gegen den Code
 * fest. Jede Verletzung (vergessener Singleton, Umgehung von
 * `submitAtomic`, direkter `new PaperBroker(…)` im Mehrprozess-Pfad) soll
 * hier als roter Test auftauchen, statt als Race-Condition im Betrieb.
 *
 * Keine DB-Abhängigkeit — rein statische Code-Kontrakte.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// ADR-003: Papier-Broker-Adapter nutzt submitAtomic (nie submit)
// ─────────────────────────────────────────────────────────────────────────────

test("ADR-003: brokers/paper.ts executeOrder nutzt submitAtomic (H2-Schutz)", () => {
  const src = readSrc("src/brokers/paper.ts");
  assert.match(
    src,
    /submitAtomic\s*\(/,
    "src/brokers/paper.ts muss this.paperBroker.submitAtomic(...) aufrufen, " +
      "nicht den synchronen submit() — sonst wird der Mehrprozess-Schutz umgangen."
  );
});

test("ADR-003: brokers/paper.ts ruft NICHT mehr .submit( im synchronen Pfad auf", () => {
  const src = readSrc("src/brokers/paper.ts");
  // Die Klasse PaperBroker selbst deklariert submit() — das ist zulässig.
  // Was verboten ist: this.paperBroker.submit(order) im Adapter.
  const lines = src.split("\n");
  const bad = lines.findIndex((l, i) =>
    /this\.paperBroker\.submit\(/.test(l) && !/submitAtomic/.test(lines[i] ?? "")
  );
  assert.equal(
    bad,
    -1,
    `src/brokers/paper.ts darf den synchronen submit()-Pfad des Ledgers nicht im Adapter aufrufen (Zeile ${bad + 1}).`
  );
});

test("ADR-003: microExecutor nutzt paperBrokerLedger() statt eigenem new PaperBroker", () => {
  const src = readSrc("src/lib/microExecutor.ts");
  assert.match(
    src,
    /paperBrokerLedger\s*\(/,
    "src/lib/microExecutor.ts muss paperBrokerLedger() aus der Factory nutzen, " +
      "statt selbst einen isolierten PaperBroker zu erzeugen."
  );
  // Die CREATE-Form des PAPER-Adapters darf nicht mehr `new PaperBroker(`
  // direkt verwenden (das erzeugt eine konkurrierende Instanz).
  const adapterSection = src.slice(
    src.indexOf("createPaperRuleAdapter"),
    src.indexOf("// ──", src.indexOf("createPaperRuleAdapter") + 100)
  );
  assert.doesNotMatch(
    adapterSection,
    /=\s*new\s+PaperBroker\s*\(/,
    "createPaperRuleAdapter() darf KEIN `new PaperBroker(...)` mehr erzeugen."
  );
});

test("ADR-003: microExecutor nutzt kein eigenes pg_advisory_lock auf Symbol-Key mehr (Lock-Leck + Doppel-Lock)", () => {
  const src = readSrc("src/lib/microExecutor.ts");
  // Zulässige Erwähnungen: Kommentare (Zeile beginnt mit `//` oder `*`) und
  // `pg_advisory_xact_lock` (transaktional, nur in Dokumentation erwähnt).
  // Verboten ist echte Code-Invasion von pg_advisory_lock (Session-Lock),
  // also ein Aufruf, der nicht in einem Kommentar steht.
  const codeLines = src
    .split("\n")
    .filter((l) => !/^\s*(?:\/\/|\*|\* )/.test(l))
    .join("\n");
  assert.doesNotMatch(
    codeLines,
    /pg_advisory_lock\s*\(/,
    "microExecutor.ts darf kein pg_advisory_lock (Session-Lock) im Code mehr nutzen — " +
      "nutze withAccountLock (transaktional, pro Konto) im PaperBroker."
  );
  // Auch client.getPool Connect / client.release / client.query aus dem
  // alten Lock-Pfad dürfen nicht mehr auftauchen.
  assert.doesNotMatch(
    codeLines,
    /getPool\s*\(\)\s*\.\s*connect/,
    "microExecutor.ts darf nicht mehr manuell einen DB-Client für den Lock-Pfad holen."
  );
});

test("ADR-003: broker.ts exportiert withAccountLock mit pg_advisory_xact_lock", () => {
  const src = readSrc("src/lib/broker.ts");
  assert.match(
    src,
    /pg_advisory_xact_lock\s*\(\s*hashtext/,
    "withAccountLock muss pg_advisory_xact_lock(hashtext(account)) benutzen " +
      "(automatischer Release bei Commit/Rollback, prozessübergreifend)."
  );
  assert.match(
    src,
    /export\s+async\s+function\s+withAccountLock/,
    "withAccountLock muss exportiert werden, damit andere Schreibpfade " +
      "(z. B. künftige Live-Adapter) dieselbe Sperre nutzen können."
  );
});

test("ADR-003: Migration stellt order_intents-Reservierung UND rollbackInMemoryFill sicher", () => {
  const src = readSrc("src/lib/broker.ts");
  assert.match(src, /order_intents/i, "submitAtomic muss order_intents zur DB-Reservierung nutzen.");
  assert.match(
    src,
    /rollbackInMemoryFill/,
    "Bei Unique-Konflikt auf order_intents muss rollbackInMemoryFill den In-Memory-Fill zurücknehmen."
  );
});

test("ADR-003: H2-Migration drizzle-Script enthält partiellen UNIQUE-Index", () => {
  const sql = readSrc("drizzle/2026-09-04_h2_order_intents.sql");
  assert.match(
    sql,
    /CREATE UNIQUE INDEX[\s\S]*WHERE\s+"status"\s*=\s*'RESERVED'/i,
    "H2-Migration muss partiellen UNIQUE-Index auf order_intents(symbol) WHERE status='RESERVED' anlegen."
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-004: Zentrales stateRegistry + gemeinsame Broker-Hydration
// ─────────────────────────────────────────────────────────────────────────────

test("ADR-004: stateRegistry exportiert __resetAllSingletonsForTests", async () => {
  const mod = await import("../src/lib/stateRegistry");
  assert.equal(typeof mod.__resetAllSingletonsForTests, "function");
});

test("ADR-004: stateRegistry bündelt alle dokumentierten Kern-Singletons", () => {
  const src = readSrc("src/lib/stateRegistry.ts");
  // Pflichtfelder, die ADR-004 ausdrücklich nennt / die zum Produktionspfad gehören:
  const requiredKeys = [
    "firmHydrated",
    "firmHydration",
    "controlPlaneStates",
    "killSwitchArmed",
    "brokerAdapters",
    "paperBrokerLedger",
    "rateLimiterHits",
    "revokedSessions",
  ];
  for (const k of requiredKeys) {
    assert.match(
      src,
      new RegExp(`\\b${k}\\s*:`),
      `state.state muss den Accessor '${k}' deklarieren.`
    );
  }
});

test("ADR-004: gemeinsame Broker-Hydration lebt in brokerHydration.ts (ADR-003+004)", () => {
  const src = readSrc("src/lib/brokerHydration.ts");
  assert.match(
    src,
    /ensurePaperBrokerHydrated/,
    "brokerHydration.ts muss ensurePaperBrokerHydrated exportieren."
  );
  assert.match(
    src,
    /restorePaperBrokerState/,
    "brokerHydration.ts muss die eigentliche Restore-Funktion enthalten."
  );
  assert.doesNotMatch(
    src,
    /from\s+["']\.\.\/\.\.?\/(ollama|analysts|llmProvider|engine)["']/,
    "brokerHydration.ts darf KEINE LLM-/Analysten-/Engine-Importe ziehen — der " +
      "Mikro-Executor-Prozess muss ihn ohne Modell-Code importieren können."
  );
});

test("ADR-004: engine.ts nutzt die gemeinsame ensurePaperBrokerHydration", () => {
  const src = readSrc("src/lib/engine.ts");
  assert.match(
    src,
    /ensurePaperBrokerHydrated/,
    "engine.ts/getBroker() muss die gemeinsame Hydration aus brokerHydration.ts nutzen."
  );
});

test("ADR-004: micro-Executor-Script nutzt ensurePaperBrokerHydrated mit Singleton-Ledger", () => {
  const src = readSrc("scripts/micro-executor.ts");
  assert.match(src, /ensurePaperBrokerHydrated/, "micro-executor muss ensurePaperBrokerHydrated aufrufen.");
  assert.match(src, /paperBrokerLedger\s*\(/, "micro-executor muss den Singleton-Ledger beziehen.");
});
