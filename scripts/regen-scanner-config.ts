#!/usr/bin/env tsx
/**
 * Pflegeskript: schreibt `src/scanner/scanner.config.json` als exakten Spiegel
 * von `DEFAULT_SCANNER_CONFIG` (`src/scanner/config.ts`).
 *
 * Hintergrund: ein Test erzwingt tiefengleiche Gleichheit zwischen der JSON-
 * Datei und dem programmatischen Default. Bei jeder Default-Änderung dieses
 * Skript ausführen, statt die JSON per Hand zu bearbeiten (Vergessene Felder
 * lassen den Spiegeltest sonst fehlschlagen):
 *
 *   npm run scanner:regenerate-config
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SCANNER_CONFIG } from "../src/scanner/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "..", "src", "scanner", "scanner.config.json");

// ACHTUNG: Keine Kommentar-/Meta-Felder (`_comment` o. Ä.) — der Spiegeltest
// erzwingt tiefengleiche Gleichheit mit DEFAULT_SCANNER_CONFIG. Die
// Erläuterungen leben hier im Skriptkopf und in config.ts.
writeFileSync(target, JSON.stringify(DEFAULT_SCANNER_CONFIG, null, 2) + "\n");
console.log(
  `scanner.config.json aus DEFAULT_SCANNER_CONFIG neu erzeugt: ${target}`,
);
