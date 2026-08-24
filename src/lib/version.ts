/**
 * Versions-Informationen der App.
 *
 * Ein einziger Wahrheitsort: package.json (SemVer). Wird u. a. von
 * /api/health und /api/firm angezeigt, damit ein laufender Dienst eindeutig
 * einem Release zugeordnet werden kann (siehe docs/CHANGELOG.md).
 */
import pkg from "../../package.json";

export const APP_NAME: string = pkg.name ?? "ai-trading-firm";
export const APP_VERSION: string = pkg.version ?? "0.0.0";
