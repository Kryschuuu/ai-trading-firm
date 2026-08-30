/**
 * Integrationstest OPS-010: vollständiger Pipeline-Durchlauf (Registry-Upsert
 * + Historical-Store-Backfill, wie `MarketDataSyncService.syncVenue` sie
 * persistiert) → `GET /api/ops` → der ausgelieferte
 * `MarketDataReadinessReport` muss konsistent mit dem tatsächlichen
 * Registry-/HistoricalStore-Zustand sein — bei unverändertem Funnel-Format.
 *
 * Hermetisch: Registry und Historical Store liegen in temporären
 * Verzeichnissen; Scanner-Service und Readiness-Store werden über die
 * Test-Hooks injiziert. Kein Netzwerk, keine echte venue, keine Repo-Daten.
 *
 * Prozess-Isolation: node --test führt jede Datei in einem eigenen Prozess —
 * das Seeden der globalen Registry ist hier nebenwirkungsfrei.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { scanTextForSecrets } from "../src/brokers/control-plane/secretScan";
import { HistoricalStore } from "../src/lib/marketdata/historicalStore";
import { OPS_SECTION_IDS } from "../src/ops/types";
import type { MarketDataReadinessReport } from "../src/ops/marketDataReadiness";
import { setMarketDataReadinessStoreForTests } from "../src/ops/marketDataReadiness";
import { loadScannerConfig } from "../src/scanner/config";
import { historicalStoreProvider, ScannerService, setScannerServiceForTests } from "../src/scanner/service";
import { getRegistry, resetRegistryForTests } from "../src/universe";
import { candlesFromCloses, instrument } from "./fixtures/scannerFixtures";

const SYNCED = [
  instrument({
    venue: "BITUNIX",
    symbol: "BTCUSDT",
    marketType: "perpetual",
    volume24h: 2_840_000_000,
    spread: 0.0002,
    lastSeen: new Date().toISOString(),
  }),
  instrument({
    venue: "BITUNIX",
    symbol: "ETHUSDT",
    base: "ETH",
    marketType: "perpetual",
    volume24h: 1_210_000_000,
    spread: 0.0003,
    lastSeen: new Date().toISOString(),
  }),
  instrument({
    venue: "BITUNIX",
    symbol: "SOLUSDT",
    base: "SOL",
    marketType: "perpetual",
    volume24h: 430_000_000,
    spread: 0.0004,
    lastSeen: new Date().toISOString(),
  }),
];
const CANDLES_PER_INSTRUMENT = 150;

let GET_OPS: (req: Request) => Promise<Response>;
let workDir: string;
let store: HistoricalStore;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "ops-readiness-"));

  // 1) Registry wie nach einem Sync: 26 Seed-Instrumente (Auto-Seed beim
  //    ersten Zugriff) + 3 frisch synchronisierte BITUNIX-Instrumente.
  resetRegistryForTests();
  const registry = getRegistry({ dir: path.join(workDir, "universe") });
  assert.equal(registry.size, 26, "Auto-Seed erwartet (26 Instrumente)");
  const upsert = registry.upsertMany(SYNCED, "test:sync");
  assert.equal(upsert.rejected.length, 0, `Upsert abgelehnt: ${JSON.stringify(upsert.rejected)}`);
  assert.equal(registry.size, 29);

  // 2) Backfill wie der Sync: 150 × 1h-Kerzen je BITUNIX-Instrument.
  store = new HistoricalStore(path.join(workDir, "history"));
  const config = loadScannerConfig();
  for (const target of SYNCED) {
    const candles = candlesFromCloses(Array.from({ length: CANDLES_PER_INSTRUMENT }, () => 100));
    const result = store.append(candles, target.id, { venue: target.venue, feed: "BITUNIX:rest" }, "1h", new Date());
    assert.equal(result.written, CANDLES_PER_INSTRUMENT);
  }

  // 3) Scanner-Service + Readiness-Store auf den simulierten Zustand zeigen lassen.
  setScannerServiceForTests(
    new ScannerService({
      instruments: () => SYNCED.concat(
        // Scan deckt die gesamte Registry ab (Seeds + gesyncte Instrumente).
        getRegistry().query({ page: 1, pageSize: 500 }).items.filter((i) => !SYNCED.some((s) => s.id === i.id)),
      ),
      data: historicalStoreProvider(store, config.factors.correlation.benchmarkInstrumentId),
      config,
      dataErrors: () => new Map(), // kein Sync-Fehler-Manifest in diesem Szenario
    }),
  );
  setMarketDataReadinessStoreForTests(store);

  ({ GET: GET_OPS } = await import("../src/app/api/ops/route"));
});

after(() => {
  setScannerServiceForTests(null);
  setMarketDataReadinessStoreForTests(null);
  resetRegistryForTests();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test("GET /api/ops: Readiness-Report konsistent mit Registry-/HistoricalStore-Zustand", async () => {
  const res = await GET_OPS(new Request("http://localhost/api/ops"));
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text) as {
    ok: boolean;
    sections: { id: string; status: string; metrics: { label: string; value: string }[] }[];
    marketDataReadiness: MarketDataReadinessReport | null;
    eligibilityDiagnostics: {
      total: number;
      truncated: boolean;
      items: {
        instrument: string;
        eligibility: {
          status: string;
          rule: string;
          dataQuality: boolean;
          data: { candles: number; volume24h: number | null; spread: number | null };
        };
      }[];
    } | null;
  };

  assert.equal(body.ok, true);

  // ── Breaking-Change-Wache: Sektionen/Funnel unverändert ──
  assert.equal(body.sections.length, 10);
  assert.deepEqual(
    body.sections.map((s) => s.id).sort(),
    [...OPS_SECTION_IDS].sort(),
  );
  const scanner = body.sections.find((s) => s.id === "scanner");
  assert.ok(scanner, "Scanner-Sektion fehlt");
  const labels = scanner.metrics.map((m) => m.label);
  for (const label of ["Gescannt", "Eligible", "Interesting", "Daily-Rotation", "Deep-Dive"]) {
    assert.ok(labels.includes(label), `Funnel-Metrik '${label}' fehlt (Breaking Change?)`);
  }
  const metric = (label: string) => scanner.metrics.find((m) => m.label === label)?.value;
  assert.equal(metric("Gescannt"), "29"); // 26 Seeds + 3 gesyncte
  assert.equal(metric("Eligible"), "3"); // die 3 vollständig daten-bereiten

  // ── Additive Erweiterung: Readiness-Report == tatsächlicher Zustand ──
  const report = body.marketDataReadiness;
  assert.ok(report, "marketDataReadiness fehlt im Payload");
  assert.equal(report.venue, "ALL"); // gemischte Venues (Seeds + BITUNIX)
  assert.equal(report.registryCount, 29);
  // Seeds tragen lastSeen 2026-08-27 (SEED_TIMESTAMP) — älter als das
  // 24h-Fenster; nur die 3 frisch gesyncten zählen als discovered.
  assert.equal(report.discoveredCount, 3);
  assert.equal(report.dataReadyCount, 3);
  assert.equal(report.warmingCount, 26);
  assert.equal(report.candlesLoaded, 3 * CANDLES_PER_INSTRUMENT); // 450
  assert.equal(report.candlesRequired, 61);
  assert.equal(report.tickerReadyCount, 3);
  assert.equal(report.spreadReadyCount, 3);
  assert.equal(report.scannerReady, true);

  // ── Eligibility-Diagnose: Seeds scheitern an min-candles (Data-Quality) ──
  const diagnostics = body.eligibilityDiagnostics;
  assert.ok(diagnostics, "eligibilityDiagnostics fehlt im Payload");
  assert.equal(diagnostics.total, 26);
  assert.equal(diagnostics.truncated, false);
  assert.equal(diagnostics.items.length, 26);
  for (const item of diagnostics.items) {
    assert.equal(item.eligibility.status, "rejected");
    assert.equal(item.eligibility.rule, "min-candles");
    assert.equal(item.eligibility.dataQuality, true);
    assert.equal(item.eligibility.data.candles, 0);
    assert.equal(item.eligibility.data.volume24h, null);
    assert.equal(item.eligibility.data.spread, null);
  }

  // ── Security: keine sensiblen Details im gesamten Payload ──
  assert.deepEqual(scanTextForSecrets(text), []);
  assert.ok(!text.includes("api-key") && !text.includes("BITUNIX_API_KEY"));

  // ── Idempotenz: zweiter Aufruf liefert denselben Report (gecachter Scan) ──
  const res2 = await GET_OPS(new Request("http://localhost/api/ops"));
  const body2 = (await res2.json()) as { marketDataReadiness: MarketDataReadinessReport | null };
  assert.deepEqual(body2.marketDataReadiness, report);
});
