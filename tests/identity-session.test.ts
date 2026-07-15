import { describe, expect, it } from "vitest";

import { IdentitySessionStore } from "../src/modules/identity/session-store";
import type { SessionProof } from "../src/modules/identity/contracts";
import { IdentityTestClock, SequenceEntropy } from "./harness/identity-harness";

function store(clock = new IdentityTestClock()): IdentitySessionStore {
  return new IdentitySessionStore(clock, new SequenceEntropy());
}

function forged(value: string): SessionProof {
  return { kind: "SessionProof", value };
}

describe("identity session store", () => {
  it("issues a workspace viewer that resolves back with matching account/workspace", () => {
    const s = store();
    const account = s.ensureEmailAccount("trader@example.com");
    const workspace = s.primaryWorkspace(account);
    const { proof, viewer } = s.issueSession(account.accountReference, workspace);

    expect(viewer.kind).toBe("workspace");
    const resolved = s.resolve(proof);
    expect(resolved.kind).toBe("workspace");
    if (resolved.kind !== "workspace") throw new Error("expected workspace");
    expect(resolved.accountReference).toBe(viewer.accountReference);
    expect(resolved.workspaceReference).toBe(viewer.workspaceReference);
  });

  it("resolves an unknown / forged proof as guest (SEC-01: no client-asserted identity)", () => {
    const s = store();
    expect(s.resolve(forged("not-a-real-proof")).kind).toBe("guest");
  });

  it("current-scope revoke kills only that session, other sessions stay valid (SEC-08)", () => {
    const s = store();
    const account = s.ensureEmailAccount("a@example.com");
    const ws = s.primaryWorkspace(account);
    const first = s.issueSession(account.accountReference, ws);
    const second = s.issueSession(account.accountReference, ws);

    expect(s.revokeCurrent(first.proof)).toBe(true);
    expect(s.resolve(first.proof).kind).toBe("guest");
    expect(s.resolve(second.proof).kind).toBe("workspace");
  });

  it("all-scope revoke bumps the account epoch so every session resolves guest (SEC-08)", () => {
    const s = store();
    const account = s.ensureEmailAccount("a@example.com");
    const ws = s.primaryWorkspace(account);
    const first = s.issueSession(account.accountReference, ws);
    const second = s.issueSession(account.accountReference, ws);

    s.revokeAll(account.accountReference);
    expect(s.resolve(first.proof).kind).toBe("guest");
    expect(s.resolve(second.proof).kind).toBe("guest");
  });

  it("workspace switch rotates the proof and swaps the current workspace (UF-03)", () => {
    const s = store();
    const account = s.ensureEmailAccount("a@example.com");
    const ws1 = s.primaryWorkspace(account);
    const ws2 = "workspace:second";
    s.addWorkspace(account.accountReference, ws2);
    const issued = s.issueSession(account.accountReference, ws1);

    const switched = s.switchWorkspace(issued.proof, ws2);
    if (switched === undefined) throw new Error("expected switch");
    expect(switched.viewer.workspaceReference).toBe(ws2);
    // old proof is retired, new proof resolves to the new workspace
    expect(s.resolve(issued.proof).kind).toBe("guest");
    const resolved = s.resolve(switched.proof);
    if (resolved.kind !== "workspace") throw new Error("expected workspace");
    expect(resolved.workspaceReference).toBe(ws2);
  });

  it("expires a session past its absolute and idle windows", () => {
    const clock = new IdentityTestClock();
    const s = store(clock);
    const account = s.ensureEmailAccount("a@example.com");
    const ws = s.primaryWorkspace(account);

    const idle = s.issueSession(account.accountReference, ws);
    clock.advanceBy(31 * 60 * 1000); // 31 min idle > 30 min window
    expect(s.resolve(idle.proof).kind).toBe("guest");

    const fresh = s.issueSession(account.accountReference, ws);
    // sliding idle keeps it alive across sub-window gaps...
    clock.advanceBy(20 * 60 * 1000);
    expect(s.resolve(fresh.proof).kind).toBe("workspace");
    clock.advanceBy(20 * 60 * 1000);
    expect(s.resolve(fresh.proof).kind).toBe("workspace");
    // ...but the absolute 12h ceiling still expires it
    clock.advanceBy(12 * 60 * 60 * 1000);
    expect(s.resolve(fresh.proof).kind).toBe("guest");
  });
});
