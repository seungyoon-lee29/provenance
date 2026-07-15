import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Client } from "pg";

import { DEFAULT_DATABASE_URL } from "../src/platform/runtime/defaults";

const execute = promisify(execFile);
const baseUrl = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
const smokeDatabase = "fakebloomberg_migration_smoke";

async function runMigration(command: "up" | "down" | "status", databaseUrl: string): Promise<string> {
  const result = await execute(process.execPath, ["--import", "tsx", "scripts/migrate.ts", command], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  return result.stdout;
}

async function main(): Promise<void> {
  const admin = new Client({ connectionString: baseUrl.toString() });
  await admin.connect();
  try {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [smokeDatabase]);
    await admin.query(`DROP DATABASE IF EXISTS ${smokeDatabase}`);
    await admin.query(`CREATE DATABASE ${smokeDatabase}`);
  } finally {
    await admin.end();
  }

  const smokeUrl = new URL(baseUrl);
  smokeUrl.pathname = `/${smokeDatabase}`;
  try {
    await runMigration("up", smokeUrl.toString());
    const firstStatus = JSON.parse(await runMigration("status", smokeUrl.toString())) as { applied: string[]; pending: string[] };
    if (firstStatus.applied.length !== 1 || firstStatus.pending.length !== 0) throw new Error("fresh migration did not apply exactly once");
    await runMigration("up", smokeUrl.toString());
    const secondStatus = JSON.parse(await runMigration("status", smokeUrl.toString())) as { applied: string[]; pending: string[] };
    if (secondStatus.applied.length !== 1 || secondStatus.pending.length !== 0) throw new Error("migration reapply was not idempotent");
    await runMigration("down", smokeUrl.toString());
    const smoke = new Client({ connectionString: smokeUrl.toString() });
    await smoke.connect();
    const rollback = await smoke.query<{ relation: string | null }>("SELECT to_regclass('public.runtime_components') AS relation");
    await smoke.end();
    if (rollback.rows[0]?.relation !== null) throw new Error("migration rollback left foundation table behind");
    await runMigration("up", smokeUrl.toString());
  } finally {
    const cleanup = new Client({ connectionString: baseUrl.toString() });
    await cleanup.connect();
    await cleanup.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [smokeDatabase]);
    await cleanup.query(`DROP DATABASE IF EXISTS ${smokeDatabase}`);
    await cleanup.end();
  }
  process.stdout.write("migration smoke passed\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "migration smoke failed"}\n`);
  process.exitCode = 1;
});
