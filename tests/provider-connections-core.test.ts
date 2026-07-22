import { describe, expect, it } from "vitest";

import type {
  ProviderConnectionReference,
  VaultKeyVersion,
  WorkspaceReference,
  AccountReference,
  SessionReference,
  SessionGeneration,
  AccountAuthorizationEpoch,
  MembershipRevision,
  Revision,
} from "../src/shared";
import { brandReference } from "../src/shared/contracts/brands";
import { CredentialKeyring, CredentialVault, type VaultKey } from "../src/platform/credential-vault";
import type { MutationControl } from "../src/shared/contracts/mutation-control";
import type {
  GuestViewerContext,
  WorkspaceViewerContext,
} from "../src/shared/contracts/viewer-context";
import { createProviderConnectionsCore } from "../src/modules/provider-connections/core/provider-connections-core";
import type {
  SaveProviderConnectionCommand,
  RevokeProviderConnectionCommand,
  VerifyProviderConnectionCommand,
} from "../src/modules/provider-connections/core/contracts";

// SYNTHETIC TEST DATA — none of these credentials are real.
const SECRET = "SYNTHETIC-kis-key-PKABCD1234EFGH5678";
const SECRET_2 = "SYNTHETIC-kis-key-PKZZZZ9999WWWW0000";

function version(value: string): VaultKeyVersion {
  return brandReference<string, "VaultKeyVersion">(value);
}

function vaultFixture(): CredentialVault {
  const key: VaultKey = { version: version("v1"), key: Buffer.alloc(32, 7), status: "active" };
  return new CredentialVault(new CredentialKeyring([key]));
}

function workspaceViewer(workspace = "workspace-1"): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "req-1",
    workspaceReference: brandReference<string, "WorkspaceReference">(workspace) as WorkspaceReference,
    accountReference: brandReference<string, "AccountReference">("account-1") as AccountReference,
    sessionReference: brandReference<string, "SessionReference">("session-1") as SessionReference,
    sessionGeneration: brandReference<string, "SessionGeneration">("sg-1") as SessionGeneration,
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("ae-1") as AccountAuthorizationEpoch,
    membershipRevision: brandReference<string, "MembershipRevision">("mr-1") as MembershipRevision,
  };
}

const guestViewer: GuestViewerContext = { kind: "guest", requestId: "req-guest" };

function control(idempotencyKey: string, expectedRevision: string): MutationControl {
  return { idempotencyKey, expectedRevision: brandReference<string, "Revision">(expectedRevision) as Revision };
}

function saveCommand(overrides: Partial<SaveProviderConnectionCommand> = {}): SaveProviderConnectionCommand {
  return {
    kind: "SaveProviderConnection",
    connectionReference: null,
    provider: "kis",
    environment: "paper",
    capability: "paper_trading",
    credentialType: "paper-api-key",
    secret: SECRET,
    ...overrides,
  };
}

function core() {
  let seq = 0;
  return createProviderConnectionsCore({
    vault: vaultFixture(),
    now: () => 1_700_000_000_000,
    newConnectionReference: () => brandReference<string, "ProviderConnectionReference">(`connection-${++seq}`) as ProviderConnectionReference,
  });
}

describe("ProviderConnections core", () => {
  it("seals the secret and never exposes plaintext on save/list/view", async () => {
    const pc = core();
    const outcome = await pc.save(saveCommand(), control("k1", "0"), workspaceViewer());
    expect(outcome.disposition).toBe("accepted");
    if (outcome.disposition !== "accepted") throw new Error("expected accepted");

    // View is masked: provider/environment/capability/generation/version/revision + last-4 hint only.
    expect(outcome.view.provider).toBe("kis");
    expect(outcome.view.environment).toBe("paper");
    expect(outcome.view.capability).toBe("paper_trading");
    expect(outcome.view.maskedHint).toBe("5678");
    expect(outcome.view.verification).toBe("unverified");

    const list = await pc.list(workspaceViewer());
    expect(list).toHaveLength(1);

    // No-plaintext-getter: nothing serialized carries the secret substring.
    const serialized = JSON.stringify({ outcome, list });
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("PKABCD1234EFGH5678");
  });

  it("proves AES round-trip: stored value is a CredentialEnvelope only the vault can open", async () => {
    const vault = vaultFixture();
    let seq = 0;
    const pc = createProviderConnectionsCore({
      vault,
      now: () => 1_700_000_000_000,
      newConnectionReference: () => brandReference<string, "ProviderConnectionReference">(`connection-${++seq}`) as ProviderConnectionReference,
    });
    const outcome = await pc.save(saveCommand(), control("k1", "0"), workspaceViewer());
    if (outcome.disposition !== "accepted") throw new Error("expected accepted");

    const envelope = pc.debugSealedEnvelope(outcome.view.connectionReference);
    if (envelope === undefined) throw new Error("expected an envelope");
    expect(envelope.algorithm).toBe("A256GCM");
    // ciphertext !== plaintext
    expect(Buffer.from(envelope.ciphertextBase64, "base64").toString("utf8")).not.toBe(SECRET);
    // only the vault can open it, and it round-trips to the original secret
    const opened = vault.open(envelope, {
      purpose: "provider_credential",
      workspaceReference: workspaceViewer().workspaceReference,
      providerConnectionReference: outcome.view.connectionReference,
      provider: "kis",
      credentialType: "paper-api-key",
      environment: "paper",
    });
    expect(Buffer.from(opened).toString("utf8")).toBe(SECRET);
  });

  it("returns the identical receipt with no generation bump on same key + same payload (idempotent)", async () => {
    const pc = core();
    const first = await pc.save(saveCommand(), control("k1", "0"), workspaceViewer());
    const again = await pc.save(saveCommand(), control("k1", "0"), workspaceViewer());
    if (first.disposition !== "accepted" || again.disposition !== "accepted") throw new Error("expected accepted");
    expect(again.view.connectionReference).toBe(first.view.connectionReference);
    expect(again.view.credentialGeneration).toBe(first.view.credentialGeneration);
    expect(again.view.revision).toBe(first.view.revision);
    expect((await pc.list(workspaceViewer()))).toHaveLength(1);
  });

  it("returns a side-effect-free conflict on same key + different payload", async () => {
    const pc = core();
    const first = await pc.save(saveCommand(), control("k1", "0"), workspaceViewer());
    if (first.disposition !== "accepted") throw new Error("expected accepted");
    const conflict = await pc.save(saveCommand({ secret: SECRET_2 }), control("k1", "0"), workspaceViewer());
    expect(conflict.disposition).toBe("conflict");
    // no new side effect: still one connection, generation unchanged, original secret intact
    const list = await pc.list(workspaceViewer());
    expect(list).toHaveLength(1);
    expect(list[0]!.credentialGeneration).toBe(first.view.credentialGeneration);
  });

  it("rejects a stale expectedRevision and reports the current revision, with no mutation", async () => {
    const pc = core();
    const first = await pc.save(saveCommand(), control("k1", "0"), workspaceViewer());
    if (first.disposition !== "accepted") throw new Error("expected accepted");
    // revision is now first.view.revision; a rotate against stale "0" must be rejected
    const ref = first.view.connectionReference;
    const rejected = await pc.save(
      saveCommand({ connectionReference: ref, secret: SECRET_2 }),
      control("k2", "0"),
      workspaceViewer(),
    );
    expect(rejected.disposition).toBe("rejected");
    if (rejected.disposition !== "rejected") throw new Error("expected rejected");
    expect(rejected.currentRevision).toBe(first.view.revision);
    const list = await pc.list(workspaceViewer());
    expect(list[0]!.credentialGeneration).toBe(first.view.credentialGeneration);
  });

  it("revoke bumps generation + fence FIRST, then the old generation cannot authorize", async () => {
    const pc = core();
    const saved = await pc.save(saveCommand(), control("k1", "0"), workspaceViewer());
    if (saved.disposition !== "accepted") throw new Error("expected accepted");
    const ref = saved.view.connectionReference;
    const genBefore = saved.view.credentialGeneration;
    const fenceBefore = saved.view.lifecycleFence;

    // old generation authorizes fine before revoke
    expect(pc.authorizeSnapshot(ref, genBefore, workspaceViewer())).toBe(true);

    const revoke: RevokeProviderConnectionCommand = { kind: "RevokeProviderConnection", connectionReference: ref };
    const revoked = await pc.revoke(revoke, control("k9", saved.view.revision), workspaceViewer());
    expect(revoked.disposition).toBe("accepted");
    if (revoked.disposition !== "accepted") throw new Error("expected accepted");

    // generation-first: both advanced
    expect(Number(revoked.view.credentialGeneration)).toBeGreaterThan(Number(genBefore));
    expect(Number(revoked.view.lifecycleFence)).toBeGreaterThan(Number(fenceBefore));
    expect(revoked.view.verification).toBe("revoked");

    // old generation can no longer authorize; new generation has no secret either
    expect(pc.authorizeSnapshot(ref, genBefore, workspaceViewer())).toBe(false);
    expect(pc.authorizeSnapshot(ref, revoked.view.credentialGeneration, workspaceViewer())).toBe(false);
    // sealed secret dropped
    expect(pc.debugSealedEnvelope(ref)).toBeUndefined();
    // already-dispatched paper call becomes submission uncertainty
    expect(revoked.submissionUncertainty).toBe(true);
  });

  it("rejects a guest viewer with zero secret call and zero store change", async () => {
    const pc = core();
    const outcome = await pc.save(saveCommand(), control("k1", "0"), guestViewer);
    expect(outcome.disposition).toBe("rejected");
    expect(await pc.list(workspaceViewer())).toHaveLength(0);
  });

  it("rejects a cross-workspace viewer with zero mutation (isolation)", async () => {
    const pc = core();
    const saved = await pc.save(saveCommand(), control("k1", "0"), workspaceViewer("workspace-1"));
    if (saved.disposition !== "accepted") throw new Error("expected accepted");
    const ref = saved.view.connectionReference;

    const revoke: RevokeProviderConnectionCommand = { kind: "RevokeProviderConnection", connectionReference: ref };
    const foreign = await pc.revoke(revoke, control("k2", saved.view.revision), workspaceViewer("workspace-2"));
    expect(foreign.disposition).toBe("rejected");
    // untouched: workspace-1 still sees an unrevoked connection with the same generation
    const owner = await pc.list(workspaceViewer("workspace-1"));
    expect(owner).toHaveLength(1);
    expect(owner[0]!.verification).not.toBe("revoked");
    expect(owner[0]!.credentialGeneration).toBe(saved.view.credentialGeneration);
    // workspace-2 sees nothing (isolation)
    expect(await pc.list(workspaceViewer("workspace-2"))).toHaveLength(0);
  });

  it("verify flips verification state without a generation bump", async () => {
    const pc = core();
    const saved = await pc.save(saveCommand(), control("k1", "0"), workspaceViewer());
    if (saved.disposition !== "accepted") throw new Error("expected accepted");
    const ref = saved.view.connectionReference;
    const cmd: VerifyProviderConnectionCommand = { kind: "VerifyProviderConnection", connectionReference: ref, result: "verified" };
    const verified = await pc.verify(cmd, control("k2", saved.view.revision), workspaceViewer());
    if (verified.disposition !== "accepted") throw new Error("expected accepted");
    expect(verified.view.verification).toBe("verified");
    expect(verified.view.credentialGeneration).toBe(saved.view.credentialGeneration);
    expect(Number(verified.view.revision)).toBeGreaterThan(Number(saved.view.revision));
  });
});
