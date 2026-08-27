/**
 * Seed-/Regenerationsskript für das Instrument-Universum.
 *
 *   npm run universe:seed
 *
 * Schreibt die 26 Seed-Instrumente (Migration der 9 Watchlist-Symbole) nach
 * `data/universe/instruments.ndjson`. Deterministisch: wiederholte Läufe
 * erzeugen eine byte-identische Datei (fester `lastSeen`-Zeitstempel).
 *
 * Kein Netzwerk, keine Credentials, keine Datenbank nötig.
 */
import { InstrumentRegistry } from "../src/universe/registry";
import { SEED_INSTRUMENTS } from "../src/universe/seed";

const registry = new InstrumentRegistry();
registry.load();
const result = registry.upsertMany([...SEED_INSTRUMENTS], "seed:script", "SEED");
registry.save();

console.log(
  `[universe] Seed abgeschlossen — neu: ${result.created}, aktualisiert: ${result.updated}, ` +
    `unverändert: ${result.unchanged}, abgelehnt: ${result.rejected.length}, gesamt: ${registry.size}`,
);
for (const r of result.rejected) console.warn(`  abgelehnt ${r.ref}: ${r.code} — ${r.message}`);
