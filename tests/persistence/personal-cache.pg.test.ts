import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PgPersonalCache } from "../../src/modules/financial-information/data/personal-cache.pg";
import { personalCacheContract } from "./personal-cache-contract";

// Runs only in the compose persistence-integration profile (real postgres +
// migrated schema). The network-off unit lane has no DB, so PG_INTEGRATION is
// unset there and the whole block skips.
const PG = process.env.PG_INTEGRATION === "1";

describe.skipIf(!PG)("PgPersonalCache (real postgres)", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  // Same contract as the in-memory oracle; TRUNCATE gives each case a clean slate.
  personalCacheContract("pg", async () => {
    await pool.query("TRUNCATE personal_cache_entry, personal_cache_fence");
    return new PgPersonalCache(pool);
  });

  it("closes the fence-first TOCTOU: a write racing an erase never survives below the fence", async () => {
    const repo = new PgPersonalCache(pool);
    for (let i = 0; i < 25; i++) {
      await pool.query("TRUNCATE personal_cache_entry, personal_cache_fence");
      const key = `k${i}`;
      // race a low-epoch write against an erase to a higher fence, both orders.
      await Promise.all([repo.write("ws-race", key, "v", 1), repo.eraseWorkspace("ws-race", 5)]);
      // fence is now >= 5 and the write epoch (1) is below it → entry must be absent.
      expect(await repo.read("ws-race", key)).toBeUndefined();
    }
  });
});
