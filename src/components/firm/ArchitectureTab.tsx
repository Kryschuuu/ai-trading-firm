"use client";

import DataTable from "../ui/DataTable";
import { PANEL_LARGE } from "../ui/layout";

/**
 * Design-/Guide-Tab: Der Inhalt ist Lesetext, kein Datenraster. Auf großen
 * Monitoren läuft er deshalb in **zwei Spalten** (ab `3xl`), statt als eine
 * 3000 px breite Zeile auseinanderzufallen; die Karten bleiben dabei
 * ungeteilt (`break-inside-avoid`).
 */
export default function ArchitectureTab() {
  return (
    <div className="prose prose-invert max-w-none">
      <Guide />
    </div>
  );
}

function Guide() {
  return (
    <div className="columns-1 gap-6 text-slate-300 3xl:columns-2 [&>section]:mb-6 [&>section]:break-inside-avoid [&>section]:not-prose">
      <section className={PANEL_LARGE}>
        <h2 className="mb-1 text-lg font-bold text-slate-50">1 · Grundprinzip (Ist-Stand)</h2>
        <p className="mb-3 text-sm text-slate-400">
          Die KI schlägt vor — der Code entscheidet. Orchestrierung ist ein
          eigener Engine-Layer (`src/lib/engine.ts`, `src/cycle/`) mit harten
          Grenzen in kompiliertem TypeScript — keine fremde Agenten-Runtime.
        </p>
        <ul className="ml-5 list-disc space-y-2 text-sm">
          <li><b className="text-emerald-400">Makro-Zyklus</b> — CEO + Research, LLM im Hintergrund, erzeugt versionierte Regeln (`trade_rules`).</li>
          <li><b className="text-emerald-400">Mikro-Zyklus</b> — eigener Prozess (`npm run micro`), kein LLM, WebSocket-Tick → kompilierte Regel → Paper-Fill.</li>
          <li><b className="text-emerald-400">Workshop-Pipeline</b> — sequenziell CEO → Research → Backtest → Risk → Approver → Executor; Race-Conditions an der Brokerschicht werden so vermieden.</li>
          <li><b className="text-emerald-400">MODEL_ROUTER</b> — kein Agent wählt sein Modell selbst (Task 09). Eskalationen nur als Antrag.</li>
        </ul>
      </section>

      <section className={PANEL_LARGE}>
        <h2 className="mb-1 text-lg font-bold text-slate-50">2 · 12-Aufgaben-Programm</h2>
        <p className="mb-3 text-sm text-slate-400">Was bereits im Code liegt — nicht was irgendwann geplant war:</p>
        <DataTable
          label="12-Aufgaben-Programm"
          stack={false}
          head={["Task", "Thema", "Status"]}
          rows={[
            ["01–06", "Universum, Broker-Contract, Paper-Market-Data, Scanner, Portfolio, Zyklus", "geliefert"],
            ["07–09", "Bitunix, Control Plane, MODEL_ROUTER", "geliefert"],
            ["10", "Operations Center + RBAC (dieser Stand: Kern + leerer Tab)", "in Arbeit"],
            ["11", "Live-Trading-Gate", <span key="gate">gesperrt — <code>LiveTradingGateError</code></span>],
          ]}
        />
      </section>

      <section className={PANEL_LARGE}>
        <h2 className="mb-1 text-lg font-bold text-slate-50">3 · Sicherheit &amp; Risikokontrolle</h2>
        <p className="mb-3 text-sm text-slate-400">Defense-in-Depth — mehrschichtig, in Code verankert:</p>
        <ol className="ml-5 list-decimal space-y-2 text-sm">
          <li><b>Guardrails:</b> Engine validiert, dann <code className="font-mono">riskGuard.ts</code> (hart), dann Broker-Schleuse nochmal. Ein Agent-Output kann keine Schicht ändern.</li>
          <li><b>RBAC (Task 10):</b> Rollen viewer / operator / admin. Credentials und Routing-Modi nur Admin. Permission <code className="font-mono">live.gate</code> hat niemand.</li>
          <li><b>Kill-Switch:</b> Circuit-Breaker, DB-persistent. Jede Order in <code className="font-mono">submit</code> wird abgelehnt, sobald er scharf ist.</li>
          <li><b>Secrets:</b> Control Plane AES-256-GCM (AAD = Venue-ID). Das Frontend sieht nur Status, nie Keys.</li>
        </ol>
      </section>

      <section className={PANEL_LARGE}>
        <h2 className="mb-1 text-lg font-bold text-slate-50">4 · Paper-Trading (Ist)</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm">
          <li><b>Default-Modus B</b> (<code className="font-mono">broker-market-data</code>): echte Kurse (Broker-Feed → Binance/Yahoo), Fills lokal im Simulator. Kein statisches Kursbuch — das ist nur noch <code className="font-mono">PAPER_STATIC_FALLBACK=true</code>.</li>
          <li><b>Modus A</b> (<code className="font-mono">synthetic</code>): seeded, deterministisch, für Tests.</li>
          <li><b>Modus C</b> (Broker-Paper-API): nur mit Venue-Capability + Flag; heute nicht wählbar (klarer Fehler, kein stiller Fallback).</li>
          <li><b>Live</b> bleibt unabhängig von Flags <code className="font-mono">LiveTradingGateError</code> (Task 11).</li>
        </ul>
      </section>

      <section className={PANEL_LARGE}>
        <h2 className="mb-1 text-lg font-bold text-slate-50">5 · Hardware (Variante A / B)</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm">
          <li><b>Variante A — Solo-Node:</b> N150, 16 GB, alles lokal. 3B-Q4, Pipeline 2–6 min. Empfohlener Start.</li>
          <li><b>Variante B — Split-Node:</b> N150 24/7 + Desktop als Inferenz. 7B–14B, Pipeline 20–60 s.</li>
          <li><b>Quantisierung:</b> Q4_K_M ist der Standard — die Agenten füllen JSON, die Rechenarbeit liegt im Code. Q5 nur für den CEO, wenn Latenz es hergibt.</li>
          <li>Messen: <code className="font-mono">ollama ps</code> (RAM, tok/s). Zwei Modelle gleichzeitig auf 16 GB sind die harte Grenze — deshalb bleibt die Pipeline sequenziell.</li>
        </ul>
      </section>

      <section className={PANEL_LARGE}>
        <h2 className="mb-1 text-lg font-bold text-slate-50">6 · Broker (Ist)</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm">
          <li><b>7 Venues registriert</b> hinter <code className="font-mono">BrokerAdapter</code>: PAPER (interner Simulator, vollständig), BITUNIX (Public REST/WS + Paper-Modus B), ALPACA/IBKR/BINANCE/KRAKEN/DYDX als ehrliche Stubs. <b>Registriert ≠ abgedeckt:</b> das Operations Center trennt registrierte Venues von tatsächlicher Discovery-/Market-Data-/Paper-/Testnet-/Live-Coverage (<code className="font-mono">GET /api/brokers/coverage</code>).</li>
          <li><b>Coverage (extern):</b> 1 Venue mit vollständiger Discovery, 1 Venue mit Paper-Market-Data, 0 Venues mit aktiviertem Live-Trading — differenziert im Coverage-Dashboard des Brokers-Tabs.</li>
          <li><b>Control Plane:</b> Credentials einmal Form → AES-256-GCM-Store. Frontend erhält nur Status (configured / connected / permissions / liveEnabled:false).</li>
          <li><b>Factory:</b> <code className="font-mono">getBroker(venue, &quot;live&quot;)</code> wirft immer <code className="font-mono">LiveTradingGateError</code>. Kein stiller Fallback auf Paper.</li>
          <li><b>Paper vereinheitlicht:</b> Der Bitunix-Paper-Ledger nutzt denselben zentralen <code className="font-mono">FillSimulator</code> wie die generische Paper-Execution (Spread, Slippage, Gebühren, Latenz, Partial Fills) — keine separate Simulationslogik mehr.</li>
        </ul>
      </section>

      {/* Questions to ask */}
      <section className="rounded-2xl border border-emerald-700/40 bg-emerald-950/20 p-6">
        <h2 className="mb-2 text-lg font-bold text-emerald-300">Fragen, die du dir vor dem Start stellen solltest</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm text-emerald-100/90">
          <li>Welche maximale Drawdown-Toleranz hast du, bevor der Kill-Switch automatisch zieht? (Wert in % setzen)</li>
          <li>Wie viel Zeit kannst du realistisch pro Woche für Prompt-/Template-Wartung aufwenden? (beeinflusst Komplexität des Orchestrators)</li>
          <li>Welche Genauigkeit brauchst du bei Backtests, bevor du einem Setup vertraust? (das hier ist bewusst nur minimal)</li>
          <li>Stimmst du dem &quot;small round-trips, no shorts, no leverage&quot;-Start zu, oder willst du schon early Trades mit Margin?</li>
          <li>Welche Assets willst du wirklich handeln — Equities (→ Alpaca) oder Crypto (→ ccxt/Binance)?</li>
          <li>Hältst du einen hybriden Fallback sicher genug, um in Produktion je eine Cloud-API zu erlauben? (für Paper-Trading unnötig)</li>
        </ul>
      </section>
    </div>
  );
}
