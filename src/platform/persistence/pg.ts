import "server-only";
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

/**
 * Opaque unit-of-work handle threaded through the atomic erase boundary (ticket 23 slice 3b-vi).
 * The pg store impls carry the enclosing transaction's PoolClient; the in-memory impls pass
 * `undefined`. Callers never inspect it — they only relay it to the participating store methods so
 * the identity deletion fence and the participant cache shred commit (or roll back) as one.
 */
export type Executor = unknown;

/** Run `fn` on an injected transaction client when present, else in a fresh one-shot transaction. */
export function withExecutor<T>(pool: Pool, tx: Executor, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return tx === undefined ? withTransaction(pool, fn) : fn(tx as PoolClient);
}
