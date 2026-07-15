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
  it("is enumeration-safe: unknown vs known sign-in return the same status but only the eligible one creates a target", () => {
    const { store, challenge } = harness();
    store.ensureEmailAccount("real@example.com"); // verified active account

    const unknown = challenge.request(cmd("sign_in", "ghost@example.com"), { idempotencyKey: "k1" }, POST);
    expect(unknown.status).toBe("challenge_issued");
    expect(challenge.drainOutbox()).toHaveLength(0); // no target, no action material for a non-account

    const known = challenge.request(cmd("sign_in", "real@example.com"), { idempotencyKey: "k2" }, POST);
    expect(known.status).toBe("challenge_issued");
    expect(challenge.drainOutbox()).toHaveLength(1);

    // The response BODY must not distinguish existence: no account-derived field (e.g. revision),
    // and the two outcomes are identical apart from the opaque receiptId.
    expect(unknown.revision).toBeUndefined();
    expect(known.revision).toBeUndefined();
    expect({ ...unknown, receiptId: "" }).toEqual({ ...known, receiptId: "" });
  });

  it("verify_email creates a pending account and a code consume issues a session + verifies the address", () => {
    const { store, challenge } = harness();
    challenge.request(cmd("verify_email", "new@example.com"), { idempotencyKey: "k" }, POST);
    const [draft] = challenge.drainOutbox();
    if (draft === undefined) throw new Error("expected a delivery draft");
    expect(draft.targetKind).toBe("pending");

    const result = challenge.consume({ kind: "manual_code", proof: draft.code }, POST);
    expect(result.status).toBe("issued");
    if (result.sessionProof === undefined) throw new Error("expected a session proof");
    expect(store.resolve(result.sessionProof).kind).toBe("workspace");
    expect(store.findEmailAccount("new@example.com")?.emailVerified).toBe(true);
  });

  it("consumes the link proof of the family", () => {
    const { store, challenge } = harness();
    store.ensureEmailAccount("real@example.com");
    challenge.request(cmd("sign_in", "real@example.com"), { idempotencyKey: "k" }, POST);
    const [draft] = challenge.drainOutbox();
    if (draft === undefined) throw new Error("expected draft");

    const result = challenge.consume({ kind: "link", proof: draft.linkToken }, POST);
    expect(result.status).toBe("issued");
  });

  it("does not consume on GET/prefetch — the code still works afterward via POST", () => {
    const { challenge } = harness();
    challenge.request(cmd("verify_email", "a@example.com"), { idempotencyKey: "k" }, POST);
    const [draft] = challenge.drainOutbox();
    if (draft === undefined) throw new Error("expected draft");

    expect(challenge.consume({ kind: "manual_code", proof: draft.code }, GET).status).toBe("rejected");
    expect(challenge.consume({ kind: "manual_code", proof: draft.code }, POST).status).toBe("issued");
  });

  it("rejects a replayed consume (concurrent POST session max 1)", () => {
    const { challenge } = harness();
    challenge.request(cmd("verify_email", "a@example.com"), { idempotencyKey: "k" }, POST);
    const [draft] = challenge.drainOutbox();
    if (draft === undefined) throw new Error("expected draft");

    expect(challenge.consume({ kind: "manual_code", proof: draft.code }, POST).status).toBe("issued");
    expect(challenge.consume({ kind: "manual_code", proof: draft.code }, POST).status).toBe("rejected");
  });

  it("expires both proofs after 10 minutes", () => {
    const clock = new IdentityTestClock();
    const { challenge } = harness(clock);
    challenge.request(cmd("verify_email", "a@example.com"), { idempotencyKey: "k" }, POST);
    const [draft] = challenge.drainOutbox();
    if (draft === undefined) throw new Error("expected draft");

    clock.advanceBy(10 * 60 * 1000 + 1);
    expect(challenge.consume({ kind: "manual_code", proof: draft.code }, POST).status).toBe("expired");
    expect(challenge.consume({ kind: "link", proof: draft.linkToken }, POST).status).toBe("expired");
  });

  it("locks the family after 5 failed code attempts, invalidating both proofs", () => {
    const { challenge } = harness();
    challenge.request(cmd("verify_email", "a@example.com"), { idempotencyKey: "k" }, POST);
    const [draft] = challenge.drainOutbox();
    if (draft === undefined) throw new Error("expected draft");
    const wrong = draft.code.slice(0, 4) + "XXXXXX"; // right locator, wrong secret

    for (let i = 0; i < 4; i += 1) expect(challenge.consume({ kind: "manual_code", proof: wrong }, POST).status).toBe("denied");
    expect(challenge.consume({ kind: "manual_code", proof: wrong }, POST).status).toBe("locked");
    // both real proofs are now dead
    expect(challenge.consume({ kind: "manual_code", proof: draft.code }, POST).status).toBe("locked");
    expect(challenge.consume({ kind: "link", proof: draft.linkToken }, POST).status).toBe("locked");
  });

  it("applies idempotency: same key+request reuses the receipt (one challenge), different request conflicts", () => {
    const { challenge } = harness();
    const first = challenge.request(cmd("verify_email", "a@example.com"), { idempotencyKey: "k" }, POST);
    const repeat = challenge.request(cmd("verify_email", "a@example.com"), { idempotencyKey: "k" }, POST);
    expect(repeat.status).toBe("challenge_issued");
    expect(repeat.receiptId).toBe(first.receiptId);
    expect(challenge.drainOutbox()).toHaveLength(1); // not duplicated

    const conflict = challenge.request(cmd("verify_email", "other@example.com"), { idempotencyKey: "k" }, POST);
    expect(conflict.status).toBe("conflict");
    expect(challenge.drainOutbox()).toHaveLength(0);
  });

  it("rejects a cross-origin request (CSRF)", () => {
    const { challenge } = harness();
    expect(challenge.request(cmd("verify_email", "a@example.com"), { idempotencyKey: "k" }, CROSS_ORIGIN).status).toBe("rejected");
  });
});
