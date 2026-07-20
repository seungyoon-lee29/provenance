import { describe, expect, it } from "vitest";

import { EmailChallengeService } from "../src/modules/identity/email-challenge";
import { IdentitySessionStore } from "../src/modules/identity/session-store";
import type { AccountEmailCommand, ClientProof } from "../src/modules/identity/contracts";
import { IdentityTestClock, SequenceEntropy } from "./harness/identity-harness";

// SYNTHETIC TEST DATA
const POST: ClientProof = { kind: "ClientProof", requestId: "r", method: "POST", sameOrigin: true, origin: "https://app.test" };
const GET: ClientProof = { ...POST, method: "GET" };
const CROSS_ORIGIN: ClientProof = { ...POST, sameOrigin: false };

function harness(clock = new IdentityTestClock()) {
  const store = new IdentitySessionStore(clock, new SequenceEntropy("s"));
  const challenge = new EmailChallengeService(store, clock, new SequenceEntropy("c"));
  return { store, challenge, clock };
}

function cmd(purpose: AccountEmailCommand["purpose"], email: string): AccountEmailCommand {
  return { kind: "AccountEmailCommand", purpose, email };
}

describe("email challenge (SEC-02)", () => {
  it("is enumeration-safe: unknown vs known sign-in return the same status but only the eligible one creates a target", async () => {
    const { store, challenge } = harness();
    await store.ensureEmailAccount("real@example.com"); // verified active account

    const unknown = await challenge.request(cmd("sign_in", "ghost@example.com"), { idempotencyKey: "k1" }, POST);
    expect(unknown.status).toBe("challenge_issued");
    expect(challenge.drainOutbox()).toHaveLength(0); // no target, no action material for a non-account

    const known = await challenge.request(cmd("sign_in", "real@example.com"), { idempotencyKey: "k2" }, POST);
    expect(known.status).toBe("challenge_issued");
    expect(challenge.drainOutbox()).toHaveLength(1);

    // The response BODY must not distinguish existence: no account-derived field (e.g. revision),
    // and the two outcomes are identical apart from the opaque receiptId.
    expect(unknown.revision).toBeUndefined();
    expect(known.revision).toBeUndefined();
    expect({ ...unknown, receiptId: "" }).toEqual({ ...known, receiptId: "" });
  });

  it("verify_email creates a pending account and a code consume issues a session + verifies the address", async () => {
    const { store, challenge } = harness();
    await challenge.request(cmd("verify_email", "new@example.com"), { idempotencyKey: "k" }, POST);
    const [draft] = challenge.drainOutbox();
    if (draft === undefined) throw new Error("expected a delivery draft");
    expect(draft.targetKind).toBe("pending");

    const result = await challenge.consume({ kind: "manual_code", proof: draft.code }, POST);
    expect(result.status).toBe("issued");
    if (result.sessionProof === undefined) throw new Error("expected a session proof");
    expect((await store.resolve(result.sessionProof)).kind).toBe("workspace");
    expect((await store.findEmailAccount("new@example.com"))?.emailVerified).toBe(true);
  });

  it("consumes the link proof of the family", async () => {
    const { store, challenge } = harness();
    await store.ensureEmailAccount("real@example.com");
    await challenge.request(cmd("sign_in", "real@example.com"), { idempotencyKey: "k" }, POST);
    const [draft] = challenge.drainOutbox();
    if (draft === undefined) throw new Error("expected draft");

    const result = await challenge.consume({ kind: "link", proof: draft.linkToken }, POST);
    expect(result.status).toBe("issued");
  });

  it("does not consume on GET/prefetch — the code still works afterward via POST", async () => {
    const { challenge } = harness();
    await challenge.request(cmd("verify_email", "a@example.com"), { idempotencyKey: "k" }, POST);
    const [draft] = challenge.drainOutbox();
    if (draft === undefined) throw new Error("expected draft");

    expect((await challenge.consume({ kind: "manual_code", proof: draft.code }, GET)).status).toBe("rejected");
    expect((await challenge.consume({ kind: "manual_code", proof: draft.code }, POST)).status).toBe("issued");
  });

  it("rejects a replayed consume (concurrent POST session max 1)", async () => {
    const { challenge } = harness();
    await challenge.request(cmd("verify_email", "a@example.com"), { idempotencyKey: "k" }, POST);
    const [draft] = challenge.drainOutbox();
    if (draft === undefined) throw new Error("expected draft");

    expect((await challenge.consume({ kind: "manual_code", proof: draft.code }, POST)).status).toBe("issued");
    expect((await challenge.consume({ kind: "manual_code", proof: draft.code }, POST)).status).toBe("rejected");
  });

  it("expires both proofs after 10 minutes", async () => {
    const clock = new IdentityTestClock();
    const { challenge } = harness(clock);
    await challenge.request(cmd("verify_email", "a@example.com"), { idempotencyKey: "k" }, POST);
    const [draft] = challenge.drainOutbox();
    if (draft === undefined) throw new Error("expected draft");

    clock.advanceBy(10 * 60 * 1000 + 1);
    expect((await challenge.consume({ kind: "manual_code", proof: draft.code }, POST)).status).toBe("expired");
    expect((await challenge.consume({ kind: "link", proof: draft.linkToken }, POST)).status).toBe("expired");
  });

  it("locks the family after 5 failed code attempts, invalidating both proofs", async () => {
    const { challenge } = harness();
    await challenge.request(cmd("verify_email", "a@example.com"), { idempotencyKey: "k" }, POST);
    const [draft] = challenge.drainOutbox();
    if (draft === undefined) throw new Error("expected draft");
    const wrong = draft.code.slice(0, 4) + "XXXXXX"; // right locator, wrong secret

    for (let i = 0; i < 4; i += 1) expect((await challenge.consume({ kind: "manual_code", proof: wrong }, POST)).status).toBe("denied");
    expect((await challenge.consume({ kind: "manual_code", proof: wrong }, POST)).status).toBe("locked");
    // both real proofs are now dead
    expect((await challenge.consume({ kind: "manual_code", proof: draft.code }, POST)).status).toBe("locked");
    expect((await challenge.consume({ kind: "link", proof: draft.linkToken }, POST)).status).toBe("locked");
  });

  it("applies idempotency: same key+request reuses the receipt (one challenge), different request conflicts", async () => {
    const { challenge } = harness();
    const first = await challenge.request(cmd("verify_email", "a@example.com"), { idempotencyKey: "k" }, POST);
    const repeat = await challenge.request(cmd("verify_email", "a@example.com"), { idempotencyKey: "k" }, POST);
    expect(repeat.status).toBe("challenge_issued");
    expect(repeat.receiptId).toBe(first.receiptId);
    expect(challenge.drainOutbox()).toHaveLength(1); // not duplicated

    const conflict = await challenge.request(cmd("verify_email", "other@example.com"), { idempotencyKey: "k" }, POST);
    expect(conflict.status).toBe("conflict");
    expect(challenge.drainOutbox()).toHaveLength(0);
  });

  it("rejects a cross-origin request (CSRF)", async () => {
    const { challenge } = harness();
    expect((await challenge.request(cmd("verify_email", "a@example.com"), { idempotencyKey: "k" }, CROSS_ORIGIN)).status).toBe("rejected");
  });
});
