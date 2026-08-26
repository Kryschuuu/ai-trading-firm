import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/**
 * Datenbank-Zugang (Lazy-Init).
 *
 * KORRIGIERT (v1.5.2): Pool und Drizzle-Client werden erst beim ERSTEN Zugriff
 * erzeugt, nicht mehr beim Modul-Import. Vorher hat ein fehlendes DATABASE_URL
 * den Import sofort geworfen — und damit `next build` während der
 * Page-Data-Collection abgeschossen, sobald eine Route `@/db` importierte.
 * Konsequenz war: frischer Clone ohne .env → Build kaputt.
 *
 * Jetzt gilt:
 *   - Import ohne .env ist harmlos (kein Throw beim Laden → Build läuft).
 *   - Die erste echte Nutzung ohne DATABASE_URL wirft eine präzise,
 *     actionable Fehlermeldung ("Setup erforderlich").
 *   - Der Pool bleibt pro Prozess ein Singleton (auch über Next.js-HMR hinweg).
 *
 * Connection-Pool-Härtung:
 *   - max:               begrenzt parallele Connections (verhindert pg-Overload).
 *   - connectionTimeoutMillis: kein ewiges Warten auf eine Verbindung.
 *   - idleTimeoutMillis:  idle Connections werden geschlossen (Speicher).
 *   - ssl:               für lokale PG nicht nötig; Cloud-Datenbanken sollten
 *                        ein CA-Zertifikat verwenden (PGSSLMODE=verify-full).
 */

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL ist nicht gesetzt. .env im Projektstamm anlegen " +
        "(Vorlage: .env.example) oder beim Start exportieren — " +
        "siehe docs/HANDBUCH.md, Kapitel 12 (Diagnose).",
    );
  }
  return url;
}

function createPool(): Pool {
  const pool = new Pool({
    connectionString: requireDatabaseUrl(),
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
  });
  // KORRIGIERT (v1.5.2): Ohne 'error'-Listener am Pool wird ein Fehler eines
  // IDLE Clients (z. B. PostgreSQL-Neustart/SIGTERM → 57P01) zum
  // uncaughtException-Kandidaten — inkl. riesigem Objekt-Dump im Journal und
  // potenziellem Prozess-Exit. Der Handler loggt kompakt; die App erholt sich,
  // sobald die Datenbank wieder da ist (Pool verbindet pro Query neu).
  pool.on("error", (err) => {
    console.warn("[db] Pool-Fehler (idle client):", err.message);
  });
  return pool;
}

type Db = NodePgDatabase<Record<string, never>>;

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
  __arenaNextJsPostgresqlDb?: Db;
};

export function getPool(): Pool {
  globalForDb.__arenaNextJsPostgresqlPool ??= createPool();
  return globalForDb.__arenaNextJsPostgresqlPool;
}

export function getDb(): Db {
  globalForDb.__arenaNextJsPostgresqlDb ??= drizzle(getPool());
  return globalForDb.__arenaNextJsPostgresqlDb;
}

/**
 * Lazy Facaden: die exports `pool` und `db` verhalten sich exakt wie die
 * echten Instanzen, erzeugen sie aber erst beim ersten Eigenschaftszugriff.
 * Methoden werden an die reale Instanz gebunden (this-sicher).
 */
function lazy<T extends object>(create: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const real = create();
      const value = Reflect.get(real, prop, real);
      return typeof value === "function" ? value.bind(real) : value;
    },
    has(_target, prop) {
      return Reflect.has(create(), prop);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(create());
    },
  });
}

export const pool: Pool = lazy(getPool);
export const db: Db = lazy(getDb);
