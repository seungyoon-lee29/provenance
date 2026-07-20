import { describe, expect, it } from "vitest";

import type { PersonalCacheRepository } from "../../src/modules/financial-information/data/personal-cache";

/**
 * Behavioral contract every PersonalCacheRepository implementation (in-memory,
 * pg) must satisfy identically. ticket 23: the pg impl runs this SAME suite so
 * its null/ordering/constraint semantics cannot silently diverge from in-memory.
 * `makeRepo` returns a fresh empty repository each call (async so the pg impl
 * can truncate its tables between cases).
 */
export function personalCacheContract(label: string, makeRepo: () => Promise<PersonalCacheRepository<string>>): void {
  describe(`PersonalCacheRepository contract [${label}]`, () => {
    it("writes then reads within a workspace", async () => {
      const repo = await makeRepo();
      expect(await repo.write("ws-a", "quote:AAA", "101.25", 1)).toBe(true);
      expect(await repo.read("ws-a", "quote:AAA")).toBe("101.25");
      expect(await repo.size("ws-a")).toBe(1);
      expect(await repo.read("ws-a", "missing")).toBeUndefined();
    });

    it("shreds behind the fence and suppresses late/restore writes (SEC-09)", async () => {
      const repo = await makeRepo();
      await repo.write("ws-a", "quote:AAA", "101.25", 1);
      await repo.write("ws-a", "research:r1", "summary", 1);
      const receipt = await repo.eraseWorkspace("ws-a", 5);
      expect(receipt.shredded).toBe(2);
      expect(await repo.read("ws-a", "quote:AAA")).toBeUndefined();
      expect(await repo.isErased("ws-a", 5)).toBe(true);
      // late worker result / backup restore at an old epoch → suppressed.
      expect(await repo.write("ws-a", "quote:AAA", "101.25", 3)).toBe(false);
      // a genuinely new post-erasure authorized epoch may write again.
      expect(await repo.write("ws-a", "quote:BBB", "9.9", 6)).toBe(true);
    });

    it("fence is monotonic: a lower erase fence never lowers the watermark", async () => {
      const repo = await makeRepo();
      await repo.eraseWorkspace("ws-a", 9);
      await repo.eraseWorkspace("ws-a", 4); // stale/lower erase must not roll the fence back
      expect(await repo.fenceOf("ws-a")).toBe(9);
      expect(await repo.write("ws-a", "k", "v", 5)).toBe(false); // still fenced at 9
    });

    it("isolates workspaces: erasing A does not fence B", async () => {
      const repo = await makeRepo();
      await repo.write("ws-a", "k", "va", 1);
      await repo.write("ws-b", "k", "vb", 1);
      await repo.eraseWorkspace("ws-a", 9);
      expect(await repo.read("ws-a", "k")).toBeUndefined();
      expect(await repo.read("ws-b", "k")).toBe("vb");
      expect(await repo.isErased("ws-b", 1)).toBe(false);
    });
  });
}
