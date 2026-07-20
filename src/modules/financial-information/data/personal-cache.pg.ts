import type { Pool } from "pg";

import { withTransaction } from "../../../platform/persistence/pg";
import type { PersonalCacheRepository } from "./personal-cache";

/**
 * PostgreSQL implementation of PersonalCacheRepository (ticket 23). Passes the
 * SAME contract suite as the in-memory store. Two invariants need care in SQL:
 *
 * - fence-first is a TOCTOU without a lock. Both `write` and `eraseWorkspace`
 *   take `SELECT … FOR UPDATE` on the workspace fence row BEFORE touching
 *   entries, so a write racing an erase serializes on that row and can never
 *   land an entry below the committed fence (design decision #1).
 * - the fence is monotonic: erase raises it with GREATEST, never lowers it.
 */
export class PgPersonalCache implements PersonalCacheRepository<string> {
  constructor(private readonly pool: Pool) {}

  async fenceOf(workspace: string): Promise<number> {
    const result = await this.pool.query<{ fence: string }>("SELECT fence FROM personal_cache_fence WHERE workspace = $1", [workspace]);
    return result.rows[0] ? Number(result.rows[0].fence) : 0;
  }

  write(workspace: string, key: string, value: string, atEpoch: number): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      // Ensure a lockable fence row exists, then lock it: serializes with erase.
      await client.query("INSERT INTO personal_cache_fence (workspace, fence) VALUES ($1, 0) ON CONFLICT (workspace) DO NOTHING", [workspace]);
      const locked = await client.query<{ fence: string }>("SELECT fence FROM personal_cache_fence WHERE workspace = $1 FOR UPDATE", [workspace]);
      const fence = locked.rows[0] ? Number(locked.rows[0].fence) : 0;
      if (atEpoch <= fence) return false; // suppressed at/below the deletion fence
      await client.query(
        "INSERT INTO personal_cache_entry (workspace, key, value) VALUES ($1, $2, $3) ON CONFLICT (workspace, key) DO UPDATE SET value = EXCLUDED.value",
        [workspace, key, value],
      );
      return true;
    });
  }

  async read(workspace: string, key: string): Promise<string | undefined> {
    const result = await this.pool.query<{ value: string }>("SELECT value FROM personal_cache_entry WHERE workspace = $1 AND key = $2", [workspace, key]);
    return result.rows[0]?.value;
  }

  async size(workspace: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM personal_cache_entry WHERE workspace = $1", [workspace]);
    return Number(result.rows[0]?.count ?? "0");
  }

  eraseWorkspace(workspace: string, fence: number): Promise<Readonly<{ shredded: number }>> {
    return withTransaction(this.pool, async (client) => {
      // Lock the fence row FIRST (before deleting entries) so a concurrent write
      // either lands before the lock (and is then shredded here) or reads the
      // raised fence after and is suppressed — never survives below the fence.
      await client.query("INSERT INTO personal_cache_fence (workspace, fence) VALUES ($1, 0) ON CONFLICT (workspace) DO NOTHING", [workspace]);
      await client.query("SELECT fence FROM personal_cache_fence WHERE workspace = $1 FOR UPDATE", [workspace]);
      const deleted = await client.query("DELETE FROM personal_cache_entry WHERE workspace = $1", [workspace]);
      await client.query("UPDATE personal_cache_fence SET fence = GREATEST(fence, $2) WHERE workspace = $1", [workspace, fence]);
      return { shredded: deleted.rowCount ?? 0 };
    });
  }

  async isErased(workspace: string, atEpoch: number): Promise<boolean> {
    return atEpoch <= (await this.fenceOf(workspace));
  }
}
