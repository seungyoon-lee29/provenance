import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assembleIdentityStores } from "../../src/composition/identity-assembly";
import { EmailChallengeService } from "../../src/modules/identity/email-challenge";
import {
  FederatedSignInService,
  type FederatedConfig,
  type FederatedExchangeResult,
  type FederatedProvider,
} from "../../src/modules/identity/federated";
import { IdentityService } from "../../src/modules/identity/identity-service";
import type { MutationControl } from "../../src/shared/contracts/mutation-control";
import { IdentityTestClock, SequenceEntropy } from "../harness/identity-harness";

// Runs only in the compose persistence-integration profile (real postgres + migrated schema).
const PG = process.env.PG_INTEGRATION === "1";

// SYNTHETIC TEST DATA — mirrors the identity-service unit harness so the wired service behaves the same.
const CONFIG: FederatedConfig = {
  publicOrigin: "https://app.test",
  google: { clientId: "gid", callbackPath: "/auth/callback/google", authorizationEndpoint: "https://accounts.google.test/authorize", issuer: "https://issuer.test", signingKey: "k" },
  github: { clientId: "ghid", callbackPath: "/auth/callback/github", authorizationEndpoint: "https://github.test/authorize" },
};
const idleAdapters: Record<FederatedProvider, { exchange: () => Promise<FederatedExchangeResult> }> = {
  google: { exchange: async () => ({ kind: "untrusted", reason: "x" }) },
  github: { exchange: async () => ({ kind: "untrusted", reason: "x" }) },
};

function control(idempotencyKey: string, expectedRevision: number): MutationControl {
  return { idempotencyKey, expectedRevision: String(expectedRevision) as unknown as MutationControl["expectedRevision"] };
}

// Assemble the SAME way the composition root (identity-server.ts) does: postgres stores + wired
// participants, then the challenge/federated/identity services around them.
function assemble(pool: Pool, clock: IdentityTestClock, seed: string) {
  const { store, personalCache, participants } = assembleIdentityStores("postgres", { pool, clock, entropy: new SequenceEntropy(`${seed}-s`) });
  const challenge = new EmailChallengeService(store, clock, new SequenceEntropy(`${seed}-c`));
  const federated = new FederatedSignInService(store, clock, new SequenceEntropy(`${seed}-f`), CONFIG, idleAdapters);
  const svc = new IdentityService(store, clock, new SequenceEntropy(`${seed}-i`), challenge, federated, participants);
  return { store, personalCache, svc };
}

async function reset(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE identity_receipt, identity_session, identity_account_fence, identity_account_workspace, identity_account CASCADE");
  await pool.query("ALTER SEQUENCE identity_fence_seq RESTART WITH 1");
  await pool.query("TRUNCATE personal_cache_entry, personal_cache_fence");
}

// Ticket 23 slice 3b-vi: the composition root now wires pg + the personal-cache erasure participant.
// This proves the wired stack (not a hand-rolled store) persists across a restart AND that an account
// erase cascades to the personal cache atomically — the gap codex flagged (participants = []).
describe.skipIf(!PG)("identity composition (postgres, wired participants)", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it("an account erase through the wired service shreds the personal cache and survives a restart", async () => {
    await reset(pool);
    const clock = new IdentityTestClock(1_000_000);
    const app = assemble(pool, clock, "app");

    const account = await app.store.ensureEmailAccount("wired@example.com");
    const ws = await app.store.primaryWorkspace(account);
    const session = await app.store.issueSession(account.accountReference, ws);
    // The wired participant wraps THIS personalCache — seed personal data in the account's workspace.
    await app.personalCache.write(ws, "secret", "pii", 1);
    expect(await app.personalCache.size(ws)).toBe(1);

    // Drive the real erasure command: reauth → account-scope erase.
    const reauth = await app.svc.beginReauthentication(session.proof);
    expect(reauth).toBeDefined();
    const rev = await app.store.accountSecurityRevision(account.accountReference);
    const outcome = await app.svc.requestAdministrativeErasure(
      { scope: "account", confirmationProof: reauth! },
      control("erase-1", rev),
      session.proof,
    );
    expect(outcome.status).toBe("accepted");

    // The cascade reached the wired cache and committed: session suppressed, personal data shredded.
    expect((await app.svc.resolve(session.proof)).kind).toBe("guest");
    expect(await app.personalCache.size(ws)).toBe(0);

    // A fresh assembly on the same pool (proxy for a process restart) sees the erased state durably.
    const rebooted = assemble(pool, clock, "reboot");
    expect((await rebooted.svc.resolve(session.proof)).kind).toBe("guest");
    expect(await rebooted.store.isErasedAccount(account.accountReference)).toBe(true);
    // Restore suppression: a re-seed at the old epoch stays fenced out on the rebooted cache.
    expect(await rebooted.personalCache.write(ws, "resurrect", "pii", 1)).toBe(false);
  });

  it("account-scope erase shreds EVERY owned workspace's cache, read inside the fenced transaction", async () => {
    await reset(pool);
    const clock = new IdentityTestClock(1_000_000);
    const app = assemble(pool, clock, "multi");

    const account = await app.store.ensureEmailAccount("multi@example.com");
    const primaryWs = await app.store.primaryWorkspace(account);
    const secondWs = "workspace:second";
    await app.store.addWorkspace(account.accountReference, secondWs);
    await app.personalCache.write(primaryWs, "a", "pii-a", 1);
    await app.personalCache.write(secondWs, "b", "pii-b", 1);

    const session = await app.store.issueSession(account.accountReference, primaryWs);
    const reauth = await app.svc.beginReauthentication(session.proof);
    const rev = await app.store.accountSecurityRevision(account.accountReference);
    const outcome = await app.svc.requestAdministrativeErasure(
      { scope: "account", confirmationProof: reauth! },
      control("erase-multi", rev),
      session.proof,
    );
    expect(outcome.status).toBe("accepted");

    // Both workspaces — not just the viewer's — are shredded and stay fenced against restore.
    expect(await app.personalCache.size(primaryWs)).toBe(0);
    expect(await app.personalCache.size(secondWs)).toBe(0);
    expect(await app.personalCache.write(secondWs, "resurrect", "pii", 1)).toBe(false);
  });
});
