import type { Pool, PoolClient } from "pg";

/**
 * Run `fn` inside one BEGIN/COMMIT (ROLLBACK on throw) on a dedicated client.
 * The seed of the ticket-23 Unit-of-work: the atomic boundary the "한 account
 * transaction" contract needs once multiple repositories write together.
 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
