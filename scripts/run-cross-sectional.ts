/**
 * Cross-Sectional Momentum Ranking — Operations-Lauf (RMA-P2-04, v1.63.0).
 *
 *   npm run research:cross-sectional                  # As-of = jetzt
 *   npm run research:cross-sectional -- --as-of=2026-09-22T00:00:00.000Z
 *   npm run research:cross-sectional -- --dry         # nur rechnen, nichts schreiben
 *   npm run research:cross-sectional -- --top=10      # Top-N-Anzeige
 *
 * Der Lauf ist **rein lokal** (Registry + Historical Store, kein Netzwerk,
 * kein LLM) und berechnet am EINEN gemeinsamen As-of-Cutoff das
 * universumsweite Momentum-Ranking:
 *
 *   1. Kandidaten aus der Registry (alle Instrumente),
 *   2. cutoff-sichtbare Kerzen des konfigurierten Timeframes
 *      (`barEnd ≤ asOf` UND bei Policy `ingested`: `fetchedAt ≤ asOf` —
 *      spätere Daten sind strukturell ausgeschlossen, kein Look-ahead),
 *   3. Eligibility (Status/Assetklasse/Liquidität/Historie) mit geschlossenen
 *      Exclusion-Gründen,
 *   4. Momentum-Renditen über die versionierten Horizonte,
 *   5. Querschnitt (Winsorize → z → Composite → Rang/Perzentil,
 *      Tie-Break: kanonische Instrument-ID),
 *   6. Persistenz: DB (idempotent über den deterministischen
 *      Idempotenz-Key) + Artefakt `artifacts/cross-sectional/…` (Cross-
 *      Prozess-Medium der Scanner-Integration).
 *
 * **Fail-closed:** unzureichende Datenlage wird im Snapshot mit Gründen
 * ausgewiesen (kein stiller 0-Score). Exit-Codes:
 *   0 = Snapshot berechnet (≥ 1 geranktes Instrument) bzw. Feature-Flag aus;
 *   1 = harter Fehler (Config/DB/Persistenz) ODER 0 gerankte Instrumente
 *       (Datenproblem — der Snapshot wird persistiert, damit der Zustand
 *       sichtbar ist, aber der Lauf meldet es laut).
 */
import { HistoricalStore, SUPPORTED_TIMEFRAME_MS } from "../src/lib/marketdata/historicalStore";
import { getRegistry } from "../src/universe";
import { loadCrossSectionalConfig, isCrossSectionalEnabled } from "../src/crossSectional/config";
import { buildCrossSectionalSnapshot } from "../src/crossSectional/snapshot";
import { persistCrossSectionalSnapshotWithStability } from "../src/crossSectional/store";
import { writeCrossSectionalArtifact } from "../src/crossSectional/artifact";
import type { MomentumCandle } from "../src/crossSectional/types";

interface CliArgs {
  /** Expliziter As-of (ISO); `null` = Default (jüngste geschlossene Periode). */
  asOfMs: number | null;
  dry: boolean;
  top: number;
}

/** Parst die CLI-Argumente (fail-loud bei unbekanntem Flag). */
function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { asOfMs: null, dry: false, top: 10 };
  for (const arg of argv) {
    if (arg === "--dry") {
      args.dry = true;
      continue;
    }
    if (arg.startsWith("--as-of=")) {
      const raw = arg.slice("--as-of=".length);
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) {
        throw new Error(`--as-of erwartet ISO-8601 (ist "${raw}")`);
      }
      args.asOfMs = ms;
      continue;
    }
    if (arg.startsWith("--top=")) {
      const n = Number(arg.slice("--top=".length));
      if (!Number.isInteger(n) || n < 1 || n > 200) {
        throw new Error("--top erwartet eine Ganzzahl 1…200");
      }
      args.top = n;
      continue;
    }
    throw new Error(`unbekanntes Argument: ${arg} (erlaubt: --as-of=ISO, --dry, --top=N)`);
  }
  return args;
}

/** Hauptlauf (async wegen DB-Persistenz). */
async function main(): Promise<number> {
  if (!isCrossSectionalEnabled()) {
    console.log("[cross-sectional] CROSS_SECTIONAL_ENABLED=false — Lauf übersprungen (Feature-Flag aus).");
    return 0;
  }

  const args = parseArgs(process.argv.slice(2));
  const config = loadCrossSectionalConfig();
  const tfMs = SUPPORTED_TIMEFRAME_MS[config.timeframe];
  // Default-As-of: die jüngste vollständig geschlossene Periode des
  // konfigurierten Timeframes (kein offenes Partial als Cutoff — das würde
  // eine unvollständige Kerze als „bekannt“ behandeln).
  const asOfMs = args.asOfMs ?? Math.floor(Date.now() / tfMs) * tfMs;

  // 1) Kandidaten aus der Registry (stabile Reihenfolge nach id).
  const registry = getRegistry();
  const pageSize = 500;
  const instruments = [];
  for (let page = 1; ; page++) {
    const result = registry.query({ page, pageSize });
    instruments.push(...result.items);
    if (!result.hasMore) break;
  }
  if (instruments.length === 0) {
    console.error("[cross-sectional] Registry ist leer — kein Universum, kein Snapshot. Führe zuerst `npm run market:sync` aus.");
    return 1;
  }

  // 2) Cutoff-sichtbare Kerzen (einer Zeitreihe = konfigurierter Timeframe;
  //    keine Timeframe-Mischung — Regel des Historical Store).
  const store = new HistoricalStore();
  const candlesById = new Map<string, MomentumCandle[]>();
  for (const entry of store.readAll()) {
    if (entry.timeframe !== config.timeframe) continue;
    const list = candlesById.get(entry.instrumentId) ?? [];
    list.push({
      ts: entry.ts,
      close: entry.close,
      fetchedAtMs: Date.parse(entry.fetchedAt),
    });
    candlesById.set(entry.instrumentId, list);
  }

  // 3) Snapshot bauen (pure, deterministisch; asOf = Cutoff, computedAt = jetzt).
  const input = {
    asOf: asOfMs,
    computedAt: Date.now(),
    instruments: instruments.map((i) => ({
      id: i.id,
      status: i.status,
      assetClass: i.assetClass,
      volume24h: i.volume24h,
    })),
    candles: candlesById,
    config,
  };
  const snapshot = buildCrossSectionalSnapshot(input);

  // 4) Persistenz (IDEMPOTENT: gleicher fachlicher Stand ⇒ No-Op).
  if (!args.dry) {
    try {
      const result = await persistCrossSectionalSnapshotWithStability(snapshot);
      console.log(
        `[cross-sectional] DB: ${result.written ? "geschrieben" : "idempotenter No-Op"} ` +
          `(${result.memberRows} Mitglieder, ${result.conflicts} Konflikte)`,
      );
    } catch (error) {
      console.error(
        `[cross-sectional] DB-Persistenz fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Artefakt bleibt schreibbar (Scanner-Pfad); der Lauf meldet sich mit Exit 1.
      return 1;
    }
    try {
      const file = writeCrossSectionalArtifact(snapshot);
      console.log(`[cross-sectional] Artefakt: ${file}`);
    } catch (error) {
      console.error(
        `[cross-sectional] Artefakt-Schreiben fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  } else {
    console.log("[cross-sectional] --dry: kein DB-/Artefakt-Write.");
  }

  // 5) Zusammenfassung (bounded; keine Secrets, keine PII).
  const topMembers = snapshot.members
    .filter((m) => m.status === "RANKED")
    .sort((a, b) => (a.rank as number) - (b.rank as number))
    .slice(0, args.top);
  const summary = {
    snapshotId: snapshot.provenance.snapshotId,
    asOf: new Date(snapshot.asOf).toISOString(),
    computedAt: new Date(snapshot.computedAt).toISOString(),
    timeframe: snapshot.timeframe,
    availabilityPolicy: snapshot.availabilityPolicy,
    codeVersion: snapshot.provenance.codeVersion,
    configVersion: snapshot.config.version,
    universeSize: snapshot.universeSize,
    rankedCount: snapshot.rankedCount,
    excludedCount: snapshot.excludedCount,
    coverage: snapshot.coverage,
    exclusionCounts: Object.fromEntries(
      Object.entries(snapshot.exclusionCounts).filter(([, v]) => v > 0),
    ),
    stability: snapshot.stability,
    top: topMembers.map((m) => ({
      rank: m.rank,
      instrumentId: m.instrumentId,
      percentile: m.percentile,
      composite: m.composite,
    })),
  };
  console.log(JSON.stringify(summary, null, 2));

  if (snapshot.rankedCount === 0) {
    console.error(
      `[cross-sectional] KEIN geranktes Instrument (universeSize=${snapshot.universeSize}) — ` +
        "Datenproblem (Historie/Liquidität); der Snapshot dokumentiert die Gründe.",
    );
    return 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(
      `[cross-sectional] Lauf fehlgeschlagen: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
