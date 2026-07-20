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
  const status = async (): Promise<{ applied: string[]; pending: string[] }> =>
    JSON.parse(await runMigration("status", smokeUrl.toString())) as { applied: string[]; pending: string[] };
  try {
    await runMigration("up", smokeUrl.toString());
    const first = await status();
    if (first.pending.length !== 0 || first.applied.length < 1) throw new Error("fresh migration did not apply cleanly");
    const total = first.applied.length;

    await runMigration("up", smokeUrl.toString());
    const second = await status();
    if (second.applied.length !== total || second.pending.length !== 0) throw new Error("migration reapply was not idempotent");

    await runMigration("down", smokeUrl.toString());
    const rolledBack = await status();
    if (rolledBack.applied.length !== total - 1 || rolledBack.pending.length !== 1) throw new Error("rollback did not roll back exactly the latest migration");

    // Re-applying the rolled-back migration must succeed — which it only does if
    // `down` fully dropped its objects (a plain CREATE TABLE would otherwise conflict).
    await runMigration("up", smokeUrl.toString());
    const restored = await status();
    if (restored.applied.length !== total || restored.pending.length !== 0) throw new Error("re-apply after rollback failed (incomplete down migration)");
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
