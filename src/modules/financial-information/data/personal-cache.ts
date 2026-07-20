import type { ErasureParticipant } from "../../identity/identity-service";

/**
 * Fence-guarded personal store shared by F4's personal FinancialInformation
 * follow-cache and ResearchAssistant result/job cache (SEC-09). Every workspace
 * has a monotonic deletion fence. A write carries the epoch it belongs to; a
 * write at or below the current fence is SUPPRESSED — this is what stops a late
 * worker result or a backup restore from re-creating personal data after
 * administrative erasure.
 *
 * The async interface is the persistence seam (ticket 23): the in-memory
 * `PersonalCacheStore` and the pg impl satisfy this SAME contract identically.
 */
export interface PersonalCacheRepository<T> {
  fenceOf(workspace: string): Promise<number>;
  /** Returns false (suppressed) when the write belongs to an epoch at or below the deletion fence. */
  write(workspace: string, key: string, value: T, atEpoch: number): Promise<boolean>;
  read(workspace: string, key: string): Promise<T | undefined>;
  size(workspace: string): Promise<number>;
  /** Bump the fence past `fence` and shred every entry. Returns how many were shredded (the receipt count). */
  eraseWorkspace(workspace: string, fence: number): Promise<Readonly<{ shredded: number }>>;
  /** True when the given epoch is fenced out (a restore at this epoch would be suppressed). */
  isErased(workspace: string, atEpoch: number): Promise<boolean>;
}

export class PersonalCacheStore<T> implements PersonalCacheRepository<T> {
  readonly #entries = new Map<string, Map<string, T>>();
  readonly #fence = new Map<string, number>();

  #fenceOf(workspace: string): number {
    return this.#fence.get(workspace) ?? 0;
  }

  #size(workspace: string): number {
    return this.#entries.get(workspace)?.size ?? 0;
  }

  fenceOf(workspace: string): Promise<number> {
    return Promise.resolve(this.#fenceOf(workspace));
  }

  write(workspace: string, key: string, value: T, atEpoch: number): Promise<boolean> {
    if (atEpoch <= this.#fenceOf(workspace)) return Promise.resolve(false);
    let bucket = this.#entries.get(workspace);
    if (!bucket) {
      bucket = new Map<string, T>();
      this.#entries.set(workspace, bucket);
    }
    bucket.set(key, value);
    return Promise.resolve(true);
  }

  read(workspace: string, key: string): Promise<T | undefined> {
    return Promise.resolve(this.#entries.get(workspace)?.get(key));
  }

  size(workspace: string): Promise<number> {
    return Promise.resolve(this.#size(workspace));
  }

  eraseWorkspace(workspace: string, fence: number): Promise<Readonly<{ shredded: number }>> {
    const shredded = this.#size(workspace);
    this.#fence.set(workspace, Math.max(this.#fenceOf(workspace), fence));
    this.#entries.delete(workspace);
    return Promise.resolve({ shredded });
  }

  isErased(workspace: string, atEpoch: number): Promise<boolean> {
    return Promise.resolve(atEpoch <= this.#fenceOf(workspace));
  }
}

/**
 * Adapts a personal cache store to the Identity erasure coordinator. On erase it
 * shreds the workspace behind the fence and records a receipt; restore
 * suppression is enforced by the store's fence on subsequent writes.
 */
export function personalCacheErasureParticipant(
  label: string,
  store: PersonalCacheRepository<unknown>,
  receipts: Array<Readonly<{ label: string; workspace: string; shredded: number; fence: number }>> = [],
): ErasureParticipant & { readonly receipts: typeof receipts } {
  return {
    receipts,
    async erase(context) {
      const { shredded } = await store.eraseWorkspace(context.workspaceReference, context.fence);
      receipts.push({ label, workspace: context.workspaceReference, shredded, fence: context.fence });
    },
  };
}
