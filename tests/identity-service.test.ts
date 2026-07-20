import { describe, expect, it } from "vitest";

import { EmailChallengeService } from "../src/modules/identity/email-challenge";
import { FederatedSignInService, type FederatedConfig, type FederatedExchangeResult, type FederatedProvider } from "../src/modules/identity/federated";
import { IdentityService, type ErasureParticipant } from "../src/modules/identity/identity-service";
import { IdentitySessionStore } from "../src/modules/identity/session-store";
import type { MutationControl } from "../src/shared/contracts/mutation-control";
import { IdentityTestClock, SequenceEntropy } from "./harness/identity-harness";

// SYNTHETIC TEST DATA
const CONFIG: FederatedConfig = {
  publicOrigin: "https://app.test",
  google: { clientId: "gid", callbackPath: "/auth/callback/google", authorizationEndpoint: "https://accounts.google.test/authorize", issuer: "https://issuer.test", signingKey: "k" },
  github: { clientId: "ghid", callbackPath: "/auth/callback/github", authorizationEndpoint: "https://github.test/authorize" },
};

function build(clock = new IdentityTestClock(), participants: readonly ErasureParticipant[] = []) {
  const store = new IdentitySessionStore(clock, new SequenceEntropy("s"));
  const challenge = new EmailChallengeService(store, clock, new SequenceEntropy("c"));
  const idle: Record<FederatedProvider, { exchange: () => Promise<FederatedExchangeResult> }> = {
    google: { exchange: async () => ({ kind: "untrusted", reason: "x" }) },
    github: { exchange: async () => ({ kind: "untrusted", reason: "x" }) },
  };
  const federated = new FederatedSignInService(store, clock, new SequenceEntropy("f"), CONFIG, idle);
  const svc = new IdentityService(store, clock, new SequenceEntropy("i"), challenge, federated, participants);
  return { store, svc };
}

function control(idempotencyKey: string, expectedRevision: number): MutationControl {
  return { idempotencyKey, expectedRevision: String(expectedRevision) as unknown as MutationControl["expectedRevision"] };
}

describe("identity service — revoke (SEC-08)", () => {
  it("current revoke ends only that session and requires the expected revision", async () => {
    const { store, svc } = build();
    const account = await store.ensureEmailAccount("a@example.com");
    const ws = await store.primaryWorkspace(account);
    const first = await store.issueSession(account.accountReference, ws);
    const second = await store.issueSession(account.accountReference, ws);
    const rev = await store.accountSecurityRevision(account.accountReference);

    const outcome = await svc.revokeSession({ scope: "current" }, control("k1", rev), first.proof);
    expect(outcome.status).toBe("revoked");
    expect((await svc.resolve(first.proof)).kind).toBe("guest");
    expect((await svc.resolve(second.proof)).kind).toBe("workspace");
  });

  it("rejects a stale expected revision with the current revision and no effect", async () => {
    const { store, svc } = build();
    const account = await store.ensureEmailAccount("a@example.com");
    const issued = await store.issueSession(account.accountReference, await store.primaryWorkspace(account));

    const outcome = await svc.revokeSession({ scope: "all" }, control("k", 999), issued.proof);
    expect(outcome.status).toBe("rejected");
    expect((await svc.resolve(issued.proof)).kind).toBe("workspace"); // untouched
  });

  it("is idempotent on the key and conflicts on same-key/different-scope", async () => {
    const { store, svc } = build();
    const account = await store.ensureEmailAccount("a@example.com");
    const ws = await store.primaryWorkspace(account);
    const a = await store.issueSession(account.accountReference, ws);
    const b = await store.issueSession(account.accountReference, ws);
    const rev = await store.accountSecurityRevision(account.accountReference);

    const first = await svc.revokeSession({ scope: "current" }, control("dup", rev), a.proof);
    const replay = await svc.revokeSession({ scope: "current" }, control("dup", rev), a.proof);
    expect(replay).toEqual(first); // same receipt, no double effect
    expect((await svc.resolve(b.proof)).kind).toBe("workspace"); // "all" was never applied

    // same proof + same key + different scope → side-effect-free conflict
    const conflict = await svc.revokeSession({ scope: "all" }, control("dup", rev), a.proof);
    expect(conflict.status).toBe("conflict");
    expect((await svc.resolve(b.proof)).kind).toBe("workspace"); // "all" still never applied
  });

  it("does not collide revoke receipts across accounts reusing the same idempotency key", async () => {
    const { store, svc } = build();
    const a = await store.ensureEmailAccount("a@example.com");
    const b = await store.ensureEmailAccount("b@example.com");
    const sa = await store.issueSession(a.accountReference, await store.primaryWorkspace(a));
    const sb = await store.issueSession(b.accountReference, await store.primaryWorkspace(b));

    const outA = await svc.revokeSession({ scope: "current" }, control("shared-key", await store.accountSecurityRevision(a.accountReference)), sa.proof);
    const outB = await svc.revokeSession({ scope: "current" }, control("shared-key", await store.accountSecurityRevision(b.accountReference)), sb.proof);
    expect(outA.status).toBe("revoked");
    expect(outB.status).toBe("revoked"); // B is not a false idempotent replay of A's receipt
    expect((await svc.resolve(sa.proof)).kind).toBe("guest");
    expect((await svc.resolve(sb.proof)).kind).toBe("guest"); // B was actually revoked, not skipped
  });
});

describe("identity service — administrative erasure (SEC-09)", () => {
  it("requires reauthentication, commits the fence first, then collects module receipts", async () => {
    const seenFence: boolean[] = [];
    const participant: ErasureParticipant = {
      erase: async ({ accountReference, fence }) => {
        // the durable fence must already be committed when a module receipt runs
        seenFence.push(await store.isErasedAccount(accountReference) && fence > 0);
      },
    };
    const { store, svc } = build(new IdentityTestClock(), [participant]);
    const account = await store.ensureEmailAccount("a@example.com");
    const ws = await store.primaryWorkspace(account);
    const primary = await store.issueSession(account.accountReference, ws);
    const secondary = await store.issueSession(account.accountReference, ws);

    const proof = await svc.beginReauthentication(primary.proof);
    if (proof === undefined) throw new Error("expected reauth proof");
    const rev = await store.accountSecurityRevision(account.accountReference);
    const outcome = await svc.requestAdministrativeErasure({ scope: "account", confirmationProof: proof }, control("e1", rev), primary.proof);

    expect(outcome.status).toBe("accepted");
    expect(outcome.fence).toBeDefined();
    expect(outcome.erasureReference).toBeDefined();
    expect(seenFence).toEqual([true]);
    // every session of the account is now dead
    expect((await svc.resolve(primary.proof)).kind).toBe("guest");
    expect((await svc.resolve(secondary.proof)).kind).toBe("guest");
  });

  it("account-scope erasure cascades the fence to EVERY workspace of the account (SEC-09)", async () => {
    const erasedWorkspaces: string[] = [];
    const participant: ErasureParticipant = {
      erase: async ({ workspaceReference }) => { erasedWorkspaces.push(workspaceReference); },
    };
    const { store, svc } = build(new IdentityTestClock(), [participant]);
    const account = await store.ensureEmailAccount("a@example.com");
    const primaryWs = await store.primaryWorkspace(account);
    const secondWs = "workspace:second";
    await store.addWorkspace(account.accountReference, secondWs);
    const primary = await store.issueSession(account.accountReference, primaryWs);

    const proof = await svc.beginReauthentication(primary.proof);
    if (proof === undefined) throw new Error("expected reauth proof");
    const rev = await store.accountSecurityRevision(account.accountReference);
    await svc.requestAdministrativeErasure({ scope: "account", confirmationProof: proof }, control("e", rev), primary.proof);

    // A multi-workspace account's personal data lives in every workspace; erasing the
    // account must fence them all, not just the viewer's current workspace.
    expect([...erasedWorkspaces].sort()).toEqual([primaryWs, secondWs].sort());
  });

  it("denies erasure without a valid reauthentication proof", async () => {
    const { store, svc } = build();
    const account = await store.ensureEmailAccount("a@example.com");
    const issued = await store.issueSession(account.accountReference, await store.primaryWorkspace(account));
    const rev = await store.accountSecurityRevision(account.accountReference);

    const outcome = await svc.requestAdministrativeErasure(
      { scope: "account", confirmationProof: { kind: "ReauthenticationProof", value: "forged" } },
      control("e", rev),
      issued.proof,
    );
    expect(outcome.status).toBe("denied");
    expect((await svc.resolve(issued.proof)).kind).toBe("workspace"); // untouched
  });

  it("suppresses restore: a backup re-activating the account row is overridden by the fence", async () => {
    const { store, svc } = build();
    const account = await store.ensureEmailAccount("a@example.com");
    const issued = await store.issueSession(account.accountReference, await store.primaryWorkspace(account));
    const proof = await svc.beginReauthentication(issued.proof);
    if (proof === undefined) throw new Error("expected reauth proof");
    const rev = await store.accountSecurityRevision(account.accountReference);
    await svc.requestAdministrativeErasure({ scope: "account", confirmationProof: proof }, control("e", rev), issued.proof);

    // simulate a stale backup restore flipping the account row back to active
    await store.setAccountState(account.accountReference, "active");
    expect(await store.accountState(account.accountReference)).toBe("active");
    // the monotonic fence still overrides it — the old session never resolves
    expect((await svc.resolve(issued.proof)).kind).toBe("guest");
    expect(await store.isErasedAccount(account.accountReference)).toBe(true);
  });
});
