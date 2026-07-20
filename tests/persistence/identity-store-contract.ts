import { describe, expect, it } from "vitest";

import type { EntropySource, IdentityClock, SessionProof } from "../../src/modules/identity/contracts";
import { ABSOLUTE_EXPIRY_MS, IDLE_EXPIRY_MS, type IdentityStore } from "../../src/modules/identity/session-store";
import { IdentityTestClock, SequenceEntropy } from "../harness/identity-harness";

/**
 * Behavioral contract every IdentityStore implementation (in-memory, pg) must satisfy identically
 * (ticket 23). The pg impl runs this SAME suite so its null/ordering/fence/expiry semantics cannot
 * silently diverge from in-memory — the class of "passes locally, fails in the container" bug that
 * the PersonalCache contract already caught. `makeStore` gets an injected clock + entropy so expiry
 * is deterministic (SEC: no SQL now()) and the caller can truncate/rebuild between cases.
 */
export type MakeIdentityStore = (clock: IdentityClock, entropy: EntropySource) => Promise<IdentityStore>;

export function identityStoreContract(label: string, makeStore: MakeIdentityStore): void {
  describe(`IdentityStore contract [${label}]`, () => {
    async function fresh() {
      const clock = new IdentityTestClock(1_000_000);
      const store = await makeStore(clock, new SequenceEntropy(label));
      return { clock, store };
    }
    const bogus: SessionProof = { kind: "SessionProof", value: "bogus" };

    it("issues a session that resolves to its workspace viewer; an unknown proof is guest", async () => {
      const { store } = await fresh();
      const account = await store.ensureEmailAccount("a@example.com");
      const ws = await store.primaryWorkspace(account);
      const issued = await store.issueSession(account.accountReference, ws);
      const viewer = await store.resolve(issued.proof);
      expect(viewer.kind).toBe("workspace");
      if (viewer.kind === "workspace") {
        expect(String(viewer.accountReference)).toBe(account.accountReference);
        expect(String(viewer.workspaceReference)).toBe(ws);
      }
      expect((await store.resolve(bogus)).kind).toBe("guest");
    });

    it("revokeCurrent ends only that session; siblings survive", async () => {
      const { store } = await fresh();
      const account = await store.ensureEmailAccount("a@example.com");
      const ws = await store.primaryWorkspace(account);
      const a = await store.issueSession(account.accountReference, ws);
      const b = await store.issueSession(account.accountReference, ws);
      expect(await store.revokeCurrent(a.proof)).toBe(true);
      expect((await store.resolve(a.proof)).kind).toBe("guest");
      expect((await store.resolve(b.proof)).kind).toBe("workspace");
    });

    it("revokeAll bumps the authorization epoch so every session dies", async () => {
      const { store } = await fresh();
      const account = await store.ensureEmailAccount("a@example.com");
      const ws = await store.primaryWorkspace(account);
      const a = await store.issueSession(account.accountReference, ws);
      const b = await store.issueSession(account.accountReference, ws);
      await store.revokeAll(account.accountReference);
      expect((await store.resolve(a.proof)).kind).toBe("guest");
      expect((await store.resolve(b.proof)).kind).toBe("guest");
    });

    it("erase commits a monotonic fence, shreds sessions, closes the account, and blocks new sessions (SEC-09)", async () => {
      const { store } = await fresh();
      const account = await store.ensureEmailAccount("a@example.com");
      const ws = await store.primaryWorkspace(account);
      const s = await store.issueSession(account.accountReference, ws);
      const fence = await store.erase(account.accountReference);
      expect(fence).toBeGreaterThan(0);
      expect(await store.isErasedAccount(account.accountReference)).toBe(true);
      expect(await store.fenceFor(account.accountReference)).toBe(fence);
      expect(await store.accountState(account.accountReference)).toBe("closed");
      expect((await store.resolve(s.proof)).kind).toBe("guest"); // session shredded
      await expect(store.issueSession(account.accountReference, ws)).rejects.toThrow();
    });

    it("the fence dominates a stale-backup restore: re-activating the account row still resolves guest", async () => {
      const { store } = await fresh();
      const account = await store.ensureEmailAccount("a@example.com");
      const ws = await store.primaryWorkspace(account);
      const s = await store.issueSession(account.accountReference, ws);
      const fence = await store.erase(account.accountReference);
      // simulate a pre-erase backup restore flipping the account row back to active
      await store.setAccountState(account.accountReference, "active");
      expect(await store.accountState(account.accountReference)).toBe("active");
      expect(await store.isErasedAccount(account.accountReference)).toBe(true); // fence outlives the restore
      expect(await store.fenceFor(account.accountReference)).toBe(fence); // never lowered
      expect((await store.resolve(s.proof)).kind).toBe("guest"); // the erased session is never resurrected
    });

    it("email accounts are keyed by normalized email; a pending account flips to verified", async () => {
      const { store } = await fresh();
      const first = await store.ensureEmailAccount("a@example.com");
      const again = await store.ensureEmailAccount("A@Example.com"); // case-insensitive
      expect(again.accountReference).toBe(first.accountReference);
      expect((await store.findEmailAccount("a@example.com"))?.accountReference).toBe(first.accountReference);

      const pending = await store.createPendingEmailAccount("p@example.com");
      expect(pending.emailVerified).toBe(false);
      await store.markEmailVerified(pending.accountReference);
      expect((await store.findEmailAccount("p@example.com"))?.emailVerified).toBe(true);
    });

    it("a federated erase leaves a tombstone: re-auth returns the same closed account, not a fresh one", async () => {
      const { store } = await fresh();
      const account = await store.ensureFederatedAccount("issuer|subject");
      await store.erase(account.accountReference);
      const again = await store.ensureFederatedAccount("issuer|subject");
      expect(again.accountReference).toBe(account.accountReference); // suppressed tombstone, never a new account
      expect(await store.isErasedAccount(again.accountReference)).toBe(true);
      const ws = await store.primaryWorkspace(again);
      await expect(store.issueSession(again.accountReference, ws)).rejects.toThrow();
    });

    it("sessions expire on the injected clock — absolute and idle windows", async () => {
      const { clock, store } = await fresh();
      const account = await store.ensureEmailAccount("a@example.com");
      const ws = await store.primaryWorkspace(account);

      const s1 = await store.issueSession(account.accountReference, ws);
      clock.advanceBy(ABSOLUTE_EXPIRY_MS + 1);
      expect((await store.resolve(s1.proof)).kind).toBe("guest"); // past absolute lifetime

      const s2 = await store.issueSession(account.accountReference, ws);
      clock.advanceBy(IDLE_EXPIRY_MS + 1);
      expect((await store.resolve(s2.proof)).kind).toBe("guest"); // untouched past the idle window
    });

    it("adds workspaces and rotates the session on switch; workspacesOf lists them all", async () => {
      const { store } = await fresh();
      const account = await store.ensureEmailAccount("a@example.com");
      const ws1 = await store.primaryWorkspace(account);
      const ws2 = "workspace:second";
      await store.addWorkspace(account.accountReference, ws2);
      expect((await store.workspacesOf(account.accountReference)).sort()).toEqual([ws1, ws2].sort());

      const s = await store.issueSession(account.accountReference, ws1);
      const rotated = await store.switchWorkspace(s.proof, ws2);
      expect(rotated).toBeDefined();
      expect((await store.resolve(s.proof)).kind).toBe("guest"); // the pre-switch proof is retired
      if (rotated !== undefined) {
        const viewer = await store.resolve(rotated.proof);
        expect(viewer.kind).toBe("workspace");
        if (viewer.kind === "workspace") expect(String(viewer.workspaceReference)).toBe(ws2);
      }
    });

    it("security revision is monotonic", async () => {
      const { store } = await fresh();
      const account = await store.ensureEmailAccount("a@example.com");
      const base = await store.accountSecurityRevision(account.accountReference);
      const next = await store.bumpSecurityRevision(account.accountReference);
      expect(next).toBe(base + 1);
      expect(await store.accountSecurityRevision(account.accountReference)).toBe(next);
    });

    it("persists command receipts keyed by (kind, proofHash, idempotencyKey); other coordinates are isolated", async () => {
      const { store } = await fresh();
      expect(await store.getReceipt("revoke", "proofX", "k1")).toBeUndefined();
      await store.putReceipt("revoke", "proofX", "k1", "payloadA", { kind: "SessionOutcome", status: "revoked" });
      expect(await store.getReceipt("revoke", "proofX", "k1")).toEqual({
        payloadHash: "payloadA",
        outcome: { kind: "SessionOutcome", status: "revoked" },
      });
      // A receipt is bound to all three coordinates — a different kind, key, or proof never replays it.
      expect(await store.getReceipt("erase", "proofX", "k1")).toBeUndefined();
      expect(await store.getReceipt("revoke", "proofX", "k2")).toBeUndefined();
      expect(await store.getReceipt("revoke", "proofY", "k1")).toBeUndefined();
    });

    it("receipt writes are first-writer-wins: a re-put on the same key never overwrites (no double-insert)", async () => {
      const { store } = await fresh();
      await store.putReceipt("erase", "proofX", "k1", "payloadA", { status: "accepted", n: 1 });
      await store.putReceipt("erase", "proofX", "k1", "payloadB", { status: "accepted", n: 2 }); // ignored
      expect(await store.getReceipt("erase", "proofX", "k1")).toEqual({
        payloadHash: "payloadA",
        outcome: { status: "accepted", n: 1 },
      });
    });
  });
}
