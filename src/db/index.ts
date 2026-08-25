import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required. Copy .env.example to .env and configure it."
  );
}

/**
 * Connection-pool-Härtung:
 *   - max:               begrenzt parallele Connections (verhindert pg-Overload).
 *   - connectionTimeoutMillis: kein ewiges Warten auf eine Verbindung.
 *   - idleTimeoutMillis:  idle Connections werden geschlossen (Speicher).
 *   - ssl:               'rejectUnauthorized: false' nur bei lokaler PG nicht
 *                        nötig; für Cloud-Datenbanken sollte ein CA-Zertifikat
 *                        verwendet werden (PGSSLMODE=verify-full).
 */
const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);
