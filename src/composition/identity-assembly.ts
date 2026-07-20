import type { Pool } from "pg";

import {
  PersonalCacheStore,
  personalCacheErasureParticipant,
  type PersonalCacheRepository,
} from "../modules/financial-information/data/personal-cache";
import { PgPersonalCache } from "../modules/financial-information/data/personal-cache.pg";
import type { EntropySource, IdentityClock } from "../modules/identity/contracts";
import type { ErasureParticipant } from "../modules/identity/identity-service";
import { IdentitySessionStore, type IdentityStore } from "../modules/identity/session-store";
import { PgIdentityStore } from "../modules/identity/session-store.pg";

export type IdentityPersistence = "memory" | "postgres";

export type IdentityStores = Readonly<{
  store: IdentityStore;
  personalCache: PersonalCacheRepository<string>;
  participants: readonly ErasureParticipant[];
}>;

/**
 * Selects the identity persistence backend and wires the SEC-09 erasure participants (ticket 23
 * slice 3b-vi). This is the composition seam codex flagged: the running stack was assembling the
 * in-memory store with an EMPTY participant list, so neither persistence nor the erasure cascade
 * reached the app.
 *
 * - postgres: PgIdentityStore + PgPersonalCache on ONE shared pool, so an account erase commits the
 *   identity deletion fence AND the personal-cache shred in a single transaction — no personal data
 *   ever survives physically behind an already-committed fence.
 * - memory: the network-off in-memory stores (unit + network-off lanes stay unchanged).
 *
 * NotificationCenter erasure is deliberately NOT wired here yet: its stores are in-memory (a crash
 * loses them — zero durable/backup residue) and it is not composed on this root, so wiring its full
 * dependency graph would be out of proportion to the SEC-09 durability concern. Tracked as residual.
 */
export function assembleIdentityStores(
  backend: IdentityPersistence,
  deps: Readonly<{ pool?: Pool; clock: IdentityClock; entropy: EntropySource }>,
): IdentityStores {
  if (backend === "postgres") {
    if (deps.pool === undefined) throw new Error("postgres identity persistence requires a database pool");
    const store = new PgIdentityStore(deps.pool, deps.clock, deps.entropy);
    const personalCache = new PgPersonalCache(deps.pool);
    return { store, personalCache, participants: [personalCacheErasureParticipant("personal-cache", personalCache)] };
  }
  const store = new IdentitySessionStore(deps.clock, deps.entropy);
  const personalCache = new PersonalCacheStore<string>();
  return { store, personalCache, participants: [personalCacheErasureParticipant("personal-cache", personalCache)] };
}
