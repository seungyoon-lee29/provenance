import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { Pool, type PoolClient } from "pg";

import { DEFAULT_DATABASE_URL } from "../src/platform/runtime/defaults";

type Direction = "up" | "down";
type Migration = Readonly<{ version: string; upPath: string; downPath: string }>;

const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

async function discoverMigrations(): Promise<Migration[]> {
  const names = await readdir(migrationsDirectory);
  const versions = names.filter((name) => name.endsWith(".up.sql")).map((name) => name.slice(0, -".up.sql".length)).sort();
  return versions.map((version) => ({
    version,
    upPath: path.join(migrationsDirectory, `${version}.up.sql`),
    downPath: path.join(migrationsDirectory, `${version}.down.sql`),
  }));
}

async function ensureRegistry(client: PoolClient): Promise<void> {
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
}

async function appliedVersions(client: PoolClient): Promise<Set<string>> {
  const result = await client.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
  return new Set(result.rows.map((row) => row.version));
}

async function applyMigration(client: PoolClient, migration: Migration): Promise<void> {
  const sql = await readFile(migration.upPath, "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function rollbackMigration(client: PoolClient, migration: Migration): Promise<void> {
  const sql = await readFile(migration.downPath, "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("DELETE FROM schema_migrations WHERE version = $1", [migration.version]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function run(direction: Direction | "status"): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [730091]);
    await ensureRegistry(client);
    const migrations = await discoverMigrations();
    const applied = await appliedVersions(client);

    if (direction === "status") {
      process.stdout.write(`${JSON.stringify({ applied: [...applied], pending: migrations.filter((migration) => !applied.has(migration.version)).map((migration) => migration.version) })}\n`);
      return;
    }
    if (direction === "up") {
      for (const migration of migrations) {
        if (!applied.has(migration.version)) await applyMigration(client, migration);
      }
      return;
    }
    const latest = migrations.filter((migration) => applied.has(migration.version)).at(-1);
    if (latest) await rollbackMigration(client, latest);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [730091]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

const command = process.argv[2];
if (command === "--help" || command === "-h") {
  process.stdout.write("usage: tsx scripts/migrate.ts <up|down|status>\n");
} else if (command !== "up" && command !== "down" && command !== "status") {
  process.stderr.write("usage: tsx scripts/migrate.ts <up|down|status>\n");
  process.exitCode = 2;
} else {
  run(command).catch((error: unknown) => {
    process.stderr.write(`migration failed: ${error instanceof Error ? error.message : "unknown failure"}\n`);
    process.exitCode = 1;
  });
}
