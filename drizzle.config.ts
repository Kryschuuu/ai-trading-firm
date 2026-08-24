import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * Drizzle-Konfiguration.
 *
 * Liest DATABASE_URL aus der .env — damit zeigt `npx drizzle-kit push`
 * immer auf die richtige Datenbank, unabhängig davon, auf welchem Rechner
 * das Skript läuft (N150 oder Desktop bei Variante B).
 *
 * Kein hardcodierter Verbindungsstring mehr → kein „push auf die falsche DB".
 */
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL fehlt. .env im Projektstamm anlegen (Vorlage: .env.example)."
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
