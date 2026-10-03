/**
 * `npm run copy:paper` — der erste lauffähige Copy-Loop (STX-07-03).
 *
 *   npm run copy:paper -- --leader-account=main-account
 *   npm run copy:paper -- --leader-account=main --symbols=BTCUSDT --duration=5m
 *   npm run copy:paper -- --leader-account=main --policy=./copy-policy.json --write
 *   npm run copy:paper -- --replay=frames.jsonl --leader-account=rehearsal
 *
 * ## Defaults, die absichtlich sicher sind
 *
 * - **`--dry-run` ist der Default.** Nichts wird persistiert: kein
 *   `copy_order_links`, kein `execution_quality_intents`, kein Audit-Eintrag.
 *   Der Loop läuft vollständig (Mapping → Sizing → Policy → Simulation), aber
 *   nur im Speicher. Schreiben erfordert das explizite `--write`.
 * - **Kein Live-Pfad.** Der Follower ist `SIMULATE_ONLY`; dieses Skript kennt
 *   keinen Venue-Order-Aufruf.
 * - **Kein Polling.** Der Leader kommt aus dem privaten Bitunix-WebSocket
 *   (`src/brokers/bitunix/ws.ts`). Ohne WS-Quelle gibt es keine Subscription
 *   (STX-08): `connect()` wirft, bevor irgendetwas kopiert wird.
 * - **Baseline zuerst.** Ohne Baseline-Snapshot startet der Loop nicht.
 *
 * ## Exit-Codes
 *
 * - `0` Lauf beendet (auch wenn alles geblockt wurde — Blockaden sind
 *   Ergebnisse, keine Abstürze).
 * - `1` Laufzeit-/Policy-Fehler (Policy-Datei ungültig, Dauer unsinnig, …).
 * - `2` Setup-Fehler (fehlende Credentials, fehlende Datenbank, Leader ohne
 *   Baseline). fail-closed: es wurde nichts kopiert.
 */
import { readFileSync } from "node:fs";

import { loadBitunixConfig } from "../src/brokers/bitunix/config";
import {
  createDefaultBitunixSecretStore,
  loadBitunixCredentials,
} from "../src/brokers/bitunix/secrets";
import { BitunixPrivateClient } from "../src/brokers/bitunix/privateClient";
import { paperBrokerLedger } from "../src/brokers/factory";
import {
  BitunixLeaderAdapter,
  BitunixOrderFrameSource,
  BitunixPrivateSnapshotReader,
  type LeaderFrameSocket,
  type LeaderFrameSource,
  type LeaderSnapshotReader,
} from "../src/copy/leader/bitunix";
import { SimulatedFollower, createNoopQualityStore } from "../src/copy/follower/simulated";
import { CopyEngine, createInMemoryCopyLinkStore } from "../src/copy/engine";
import { CopyStore } from "../src/copy/store";
import { DEFAULT_COPY_POLICY_CONFIG, loadCopyPolicyConfig } from "../src/copy/config";
import { ExecutionQualityStore } from "../src/executionQuality/store";
import { calibrateSimulatorConfig, loadSimulatorConfig } from "../src/lib/marketdata/config";
import { telemetry } from "../src/lib/telemetry";

// ─────────────────────────────────────────────────────────────────────────────
// Flag-Parsing
// ─────────────────────────────────────────────────────────────────────────────

interface Flags {
  /** Pflicht-Flag; `""` bis `--leader-account` geparst ist. */
  leaderAccount: string;
  symbols: string[];
  durationMs: number;
  maxEvents: number | null;
  policyFile: string | null;
  dryRun: boolean;
  replayFile: string | null;
  sizingMode: "FIXED_AMOUNT" | "FIXED_RATIO" | "EQUITY_RATIO";
  fixedAmount: number;
  ratio: number;
}

const DEFAULT_DURATION_MS = 60_000;
/** Audit-/Scope-Label des Follower-Kontos (der Paper-Ledger der Firma). */
const FOLLOWER_ACCOUNT = "copy-paper";
/** Rehearsal: Pause zwischen zwei Frames, damit jeder Lauf sauber durchläuft. */
const REPLAY_FRAME_DELAY_MS = 25;

function usage(error: string): never {
  console.error(`[copy:paper] ${error}`);
  console.error(
    [
      "",
      "Verwendung:",
      "  npm run copy:paper -- --leader-account=<id> [Optionen]",
      "",
      "Optionen:",
      "  --leader-account=<id>   Leader-Konto (Audit-Label, Pflicht)",
      "  --symbols=a,b           Native Symbol-Allowlist (Default: alle)",
      "  --duration=60s|5m|30000 Laufzeit (Default 60s)",
      "  --max-events=<n>        Stopp nach n Leader-Events",
      "  --policy=<datei>        Copy-Policy-JSON (Default: code-versionsaktuelle Policy)",
      "  --dry-run               NICHTS persistieren (Default)",
      "  --write                 Links + execution_quality_intents schreiben",
      "  --no-write              Alias für --dry-run",
      "  --replay=<datei>        Offline-Rehearsal aus einer JSONLFrame-Datei (erzwingt --dry-run)",
      "  --sizing=<modus>        FIXED_AMOUNT (Default) | FIXED_RATIO | EQUITY_RATIO",
      "  --fixed-amount=<n>      Follower-Notional je Event (Default 100)",
      "  --ratio=<n>             Multiplikator für FIXED_RATIO (Default 0.01)",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function parseDuration(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw.trim());
  if (!match) usage(`--duration="${raw}" ist keine Dauer (z. B. 30s, 5m, 250).`);
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) usage(`--duration="${raw}" muss > 0 sein.`);
  const unit = match[2] ?? "ms";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.floor(value * factor);
}

/** Liest die Policy-JSON-Datei; ein ungültiges Dokument bricht den Lauf ab. */
function readPolicyFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    usage(`--policy="${path}" nicht lesbar: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    usage(
      `--policy="${path}" ist kein gültiges JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {
    leaderAccount: "",
    symbols: [],
    durationMs: DEFAULT_DURATION_MS,
    maxEvents: null,
    policyFile: null,
    dryRun: true,
    replayFile: null,
    sizingMode: "FIXED_AMOUNT",
    fixedAmount: 100,
    ratio: 0.01,
  };
  let explicitWrite = false;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") usage("Hilfe");
    if (!arg.startsWith("--")) usage(`Unbekanntes Argument "${arg}".`);
    const [key, value = ""] = arg.slice(2).split("=");
    switch (key) {
      case "leader-account":
        flags.leaderAccount = value.trim();
        break;
      case "symbols":
        flags.symbols = value
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter((s) => s.length > 0);
        break;
      case "duration":
        flags.durationMs = parseDuration(value);
        break;
      case "max-events": {
        const n = Number(value);
        if (!Number.isSafeInteger(n) || n <= 0) usage(`--max-events="${value}" muss > 0 sein.`);
        flags.maxEvents = n;
        break;
      }
      case "policy":
        flags.policyFile = value || null;
        break;
      case "write":
        explicitWrite = true;
        flags.dryRun = false;
        break;
      case "dry-run":
      case "no-write":
        flags.dryRun = true;
        explicitWrite = false;
        break;
      case "replay":
        flags.replayFile = value || null;
        break;
      case "sizing": {
        const mode = value.trim().toUpperCase();
        if (mode !== "FIXED_AMOUNT" && mode !== "FIXED_RATIO" && mode !== "EQUITY_RATIO") {
          usage(`--sizing="${value}" ist kein bekannter Sizing-Modus.`);
        }
        flags.sizingMode = mode;
        break;
      }
      case "fixed-amount": {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) usage(`--fixed-amount="${value}" muss > 0 sein.`);
        flags.fixedAmount = n;
        break;
      }
      case "ratio": {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) usage(`--ratio="${value}" muss > 0 sein.`);
        flags.ratio = n;
        break;
      }
      default:
        usage(`Unbekannte Option "--${key}".`);
    }
  }
  void explicitWrite;
  if (flags.replayFile) flags.dryRun = true;
  if (flags.leaderAccount.length === 0) usage("--leader-account ist Pflicht.");
  return flags;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rehearsal-Frame-Quelle (offline, kein Netz)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spielt aufgezeichnete Roh-Frames aus einer JSONL-Datei über denselben
 * Decoder-Pfad wie der echte WS-Strom. Bewusst ein **Rehearsal**-Werkzeug:
 * es beweist die Loop-Logik (Mapping → Sizing → Policy → Simulation), ohne
 * ein Leader-Konto zu berühren. Es ist kein Polling und kein Live-Pfad.
 *
 * Die Frames werden eingespeist, **nachdem** `connect()` die komplette Kette
 * verdrahtet hat (Frame-Quelle → Leader-Adapter → Engine). `close()` bricht die
 * Wiedergabe ab.
 */
function createReplayFrameSource(
  frames: readonly unknown[],
  delayMs: number,
  shouldStop: () => boolean,
): LeaderFrameSource {
  let stopped = false;
  return {
    async start(onFrame: (raw: unknown) => void): Promise<LeaderFrameSocket> {
      for (const frame of frames) {
        if (stopped || shouldStop()) break;
        onFrame(frame);
        await sleep(delayMs);
      }
      return {
        close: (): void => {
          stopped = true;
        },
        ingest: (raw: unknown): void => onFrame(raw),
      };
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readReplayFrames(path: string): unknown[] {
  const text = readFileSync(path, "utf8");
  const frames: unknown[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      frames.push(JSON.parse(trimmed));
    } catch (error) {
      usage(
        `--replay="${path}" Zeile ${index + 1} ist kein JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return frames;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hauptlauf
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const config = loadBitunixConfig();

  /** Spät gebunden: der Engine-Zähler steht erst nach dem Bau der Engine. */
  let processedEvents = (): number => 0;

  // 1) Policy — versioniert validiert, fail-closed.
  const policyConfig = flags.policyFile
    ? loadCopyPolicyConfig(readPolicyFile(flags.policyFile))
    : DEFAULT_COPY_POLICY_CONFIG;

  // 2) Follower: der EINE Paper-Ledger der Firma (Prozess-Singleton).
  const paperBroker = paperBrokerLedger();
  // Der Follower ist das Paper-Konto der Firma selbst: es gibt genau EINEN
  // Paper-Ledger (Prozess-Singleton der Factory), keine zweite Buchhaltung.
  // `followerAccount` ist deshalb ein Audit-/Scope-Label, kein zweites Konto.
  const followerAccount = FOLLOWER_ACCOUNT;
  const follower = new SimulatedFollower({
    paperBroker,
    qualityStore: flags.dryRun ? createNoopQualityStore() : new ExecutionQualityStore(),
    scope: "copy-paper",
  });

  // 3) Store: dry-run arbeitet speicherresident (Neustart-Simulation möglich),
  //    --write nutzt den persistenten CopyStore.
  const store = flags.dryRun ? createInMemoryCopyLinkStore() : new CopyStore();

  // 4) Erwarteter Spread: dieselbe kalibrierte Konfiguration, mit der der
  //    Paper-Pfad ausführt. Kein zweiter Spread-Wert.
  const simulator = calibrateSimulatorConfig(loadSimulatorConfig());
  const spreadPct = simulator.syntheticSpreadBps / 100;

  // 5) Leader: erst Baseline, dann Frame-Strom.
  let snapshot: LeaderSnapshotReader;
  let frameSource: LeaderFrameSource;
  let replayFrames: unknown[] = [];

  if (flags.replayFile) {
    replayFrames = readReplayFrames(flags.replayFile);
    snapshot = {
      async read() {
        // Rehearsal ohne Leader-Konto: die Baseline ist leer. Alles, was der
        // Replay zeigt, wird deshalb als OPEN gewertet — genau wie ein echter
        // Leader, der vor dem Connect flach stand.
        return { at: Date.now(), positions: [], equity: null };
      },
    };
    frameSource = createReplayFrameSource(
      replayFrames,
      REPLAY_FRAME_DELAY_MS,
      // `--max-events` gilt auch im Rehearsal: die Wiedergabe bricht ab, sobald
      // die Engine genug Events verarbeitet hat.
      () => flags.maxEvents !== null && processedEvents() >= flags.maxEvents,
    );
    console.log(
      `[copy:paper] Rehearsal aus ${flags.replayFile} (${replayFrames.length} Frames, dry-run).`,
    );
  } else {
    const secretStore = createDefaultBitunixSecretStore();
    const credentials = await loadBitunixCredentials(secretStore);
    if (!credentials) {
      console.error(
        "[copy:paper] SETUP: keine Bitunix-Credentials. Ohne API-Key gibt es " +
          "weder Baseline noch privaten WS-Kanal — fail-closed, kein Copy.",
      );
      return 2;
    }
    const privateClient = new BitunixPrivateClient({ credentials, config });
    snapshot = new BitunixPrivateSnapshotReader(privateClient);
    frameSource = new BitunixOrderFrameSource({ config, credentials });
  }

  const leader = new BitunixLeaderAdapter({
    config,
    snapshot,
    frameSource,
    leaderAccount: flags.leaderAccount,
    symbols: flags.symbols,
    // dry-run: auch der Leader schreibt keinen Audit-Eintrag.
    ...(flags.dryRun ? { auditWriter: async () => ({ durable: false }) } : {}),
  });

  const engine = new CopyEngine({
    store,
    leader,
    follower,
    policy: policyConfig.policy,
    policyVersion: policyConfig.policyVersion,
    followerAccount,
    sizing: {
      mode: flags.sizingMode,
      fixedAmount: flags.fixedAmount,
      ratio: flags.ratio,
      multiplier: 1,
      leveragePolicy: "CAP",
      leverageCap: policyConfig.policy.maxLeverage,
    },
    equity: {
      leaderEquity: leader.leaderEquity,
      followerEquity: paperBroker.accountEquity,
    },
    async environment({ followerInstrumentId }) {
      const dayNotional = store.dayNotional ? await store.dayNotional() : 0;
      return {
        referencePrice: paperBroker.quote(followerInstrumentId),
        dayNotional,
        openPositions: paperBroker.openPositions,
        equityAtDayStart: paperBroker.startingEquity,
        currentEquity: paperBroker.accountEquity,
        ruleSnapshot: { spreadPct },
        scannerSpread: null,
      };
    },
    // dry-run: der Audit-Writer ist ein No-Op. Es verlässt nichts diesen Lauf.
    ...(flags.dryRun ? { auditWriter: async () => ({ durable: false }) } : {}),
  });
  processedEvents = () => engine.processedEvents;

  console.log(
    [
      `[copy:paper] Leader-Konto: ${flags.leaderAccount}`,
      `[copy:paper] Modus: ${flags.dryRun ? "DRY-RUN (nichts persistiert)" : "WRITE (copy_order_links + execution_quality_intents)"}`,
      `[copy:paper] Policy: ${policyConfig.policyVersion}`,
      `[copy:paper] Sizing: ${flags.sizingMode} (fixedAmount=${flags.fixedAmount}, ratio=${flags.ratio})`,
      `[copy:paper] Symbole: ${flags.symbols.length > 0 ? flags.symbols.join(", ") : "alle"}`,
      `[copy:paper] Dauer: ${flags.durationMs} ms, max-events: ${flags.maxEvents ?? "∞"}`,
    ].join("\n"),
  );

  try {
    await engine.start();
  } catch (error) {
    const status = leader.getStatus();
    console.error(
      `[copy:paper] SETUP: Leader nicht verbunden (${status.state}${status.pauseReason ? `/${status.pauseReason}` : ""}). ` +
        `Ohne Baseline kein Copy. ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }

  // Lauf bis Dauer/Max-Events/Strg-C (im Rehearsal-Modus ist die Wiedergabe
  // bereits in connect() erfolgt; hier zählt nur die Nachlaufzeit).
  const deadline = Date.now() + flags.durationMs;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (Date.now() >= deadline) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (flags.maxEvents !== null && engine.processedEvents >= flags.maxEvents) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
    process.once("SIGINT", () => {
      clearInterval(timer);
      resolve();
    });
  });

  await engine.drain();
  await engine.stop();

  const status = leader.getStatus();
  console.log(
    [
      "",
      "[copy:paper] ── Zusammenfassung ─────────────────────────────",
      `  Leader-Zustand : ${status.state}${status.pauseReason ? ` (${status.pauseReason})` : ""}`,
      `  Frames         : ${status.frames} (verworfen: ${status.dropped})`,
      `  Leader-Events  : ${status.events}`,
      `  Engine-Events  : ${engine.processedEvents}`,
      `  Ergebnisse     : ${JSON.stringify(telemetry.copy.events.byLabel())}`,
      `  Latenz-Buckets : ${JSON.stringify(telemetry.copy.latency.byLabel())}`,
      `  Leader-Zähler  : ${JSON.stringify(telemetry.copy.leader.byLabel())}`,
      "─────────────────────────────────────────────────────────",
    ].join("\n"),
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[copy:paper] FEHLER: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
