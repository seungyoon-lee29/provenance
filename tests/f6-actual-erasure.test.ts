import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import { ActualJournal } from "../src/modules/actual-portfolio/baseline/journal";
import { ActualPortfolioErasure } from "../src/modules/actual-portfolio/baseline/actual-erasure";
import { ActualPortfolioService } from "../src/modules/actual-portfolio/baseline/portfolio-load";
import type { ActualAccountReference, ActualPortfolioCommand } from "../src/modules/actual-portfolio/baseline/contracts";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";

import { EmailChallengeService } from "../src/modules/identity/email-challenge";
import { FederatedSignInService, type FederatedConfig, type FederatedExchangeResult, type FederatedProvider } from "../src/modules/identity/federated";
import { IdentityService } from "../src/modules/identity/identity-service";
import { IdentitySessionStore } from "../src/modules/identity/session-store";
import type { MutationControl } from "../src/shared/contracts/mutation-control";
import { IdentityTestClock, SequenceEntropy } from "./harness/identity-harness";

const NOW = "2026-07-17T06:00:00.000Z";
const WS = "workspace:w1";
const ACCOUNT = brandReference<string, "ActualAccountReference">("actual-account:a1") as ActualAccountReference;
const ACCOUNT_B = brandReference<string, "ActualAccountReference">("actual-account:b1") as ActualAccountReference;

function openingCommand(account: ActualAccountReference = ACCOUNT, symbol = "AAPL"): ActualPortfolioCommand {
  return {
    kind: "record_opening_position",
    account,
    position: {
      instrument: brandReference<string, "ActualInstrumentReference">(`instr:${symbol}`),
      signedQuantity: 10,
      currency: "KRW",
      asOf: "2026-07-01",
      source: brandReference<string, "ActualSourceReference">(`source:manual:${symbol}`),
    },
  };
}

const control = (key: string, revision: number) => ({ idempotencyKey: key, expectedRevision: String(revision) });

function populated() {
  const journal = new ActualJournal(() => NOW);
  journal.append(WS, openingCommand(), control("k1", 0));
  journal.append(WS, openingCommand(ACCOUNT_B, "MSFT"), control("k1", 0));
  journal.append("workspace:w2", openingCommand(brandReference<string, "ActualAccountReference">("actual-account:other") as ActualAccountReference), control("k1", 0));
  const erasure = new ActualPortfolioErasure({ journal, stores: [] });
  return { journal, erasure };
}

describe("ActualPortfolio administrative erasure (SEC-09)", () => {
  it("one fence shreds journal, receipts and account ownership; the receipt reports the sweep", async () => {
    const { journal, erasure } = populated();
    await erasure.erase({ accountReference: "account:a", workspaceReference: WS, scope: "account", fence: 5 });

    expect(journal.list(WS, ACCOUNT)).toHaveLength(0);
    expect(journal.list(WS, ACCOUNT_B)).toHaveLength(0);
    expect(journal.accounts(WS)).toHaveLength(0);
    const receipt = erasure.receiptFor(WS);
    expect(receipt?.fence).toBe(5);
    expect(receipt?.lines).toEqual([{ label: "actual-journal", shredded: 2 }]);
    // Another workspace is untouched.
    expect(journal.accounts("workspace:w2")).toHaveLength(1);
  });

  it("after erasure nothing regenerates: replayed commands, restores and reads stay empty", async () => {
    const { journal, erasure } = populated();
    await erasure.erase({ accountReference: "account:a", workspaceReference: WS, scope: "account", fence: 5 });

    // A replayed pre-erasure command finds no receipt and its write is fenced.
    expect(journal.append(WS, openingCommand(), control("k1", 0))).toEqual({ status: "suppressed" });
    // A backup restore writing at a pre-erasure epoch is fenced too.
    expect(journal.append(WS, openingCommand(ACCOUNT, "TSLA"), control("k9", 0))).toEqual({ status: "suppressed" });
    expect(journal.list(WS, ACCOUNT)).toHaveLength(0);
    expect(journal.accounts(WS)).toHaveLength(0);
  });

  it("the freed account name can be claimed by another workspace as a fresh lineage", async () => {
    const { journal, erasure } = populated();
    await erasure.erase({ accountReference: "account:a", workspaceReference: WS, scope: "account", fence: 5 });
    const fresh = journal.append("workspace:w3", openingCommand(), control("k1", 0));
    expect(fresh).toMatchObject({ status: "applied", revision: 1 });
    expect(journal.ownerOf(ACCOUNT)).toBe("workspace:w3");
  });

  it("replaying the sweep at the same fence keeps the original receipt", async () => {
    const { journal, erasure } = populated();
    await erasure.erase({ accountReference: "account:a", workspaceReference: WS, scope: "account", fence: 5 });
    const receipt = erasure.receiptFor(WS);
    await erasure.erase({ accountReference: "account:a", workspaceReference: WS, scope: "account", fence: 5 });
    expect(erasure.receiptFor(WS)).toEqual(receipt);
  });
});

// --- coordinator integration (real IdentityService, fence-first) ----------------

const FEDERATED_CONFIG: FederatedConfig = {
  publicOrigin: "https://app.test",
  google: { clientId: "gid", callbackPath: "/auth/callback/google", authorizationEndpoint: "https://accounts.google.test/authorize", issuer: "https://issuer.test", signingKey: "k" },
  github: { clientId: "ghid", callbackPath: "/auth/callback/github", authorizationEndpoint: "https://github.test/authorize" },
};

function buildIdentity(participants: ConstructorParameters<typeof IdentityService>[5]) {
  const clock = new IdentityTestClock();
  const store = new IdentitySessionStore(clock, new SequenceEntropy("s"));
  const challenge = new EmailChallengeService(store, clock, new SequenceEntropy("c"));
  const idle: Record<FederatedProvider, { exchange: () => Promise<FederatedExchangeResult> }> = {
    google: { exchange: async () => ({ kind: "untrusted", reason: "x" }) },
    github: { exchange: async () => ({ kind: "untrusted", reason: "x" }) },
  };
  const federated = new FederatedSignInService(store, clock, new SequenceEntropy("f"), FEDERATED_CONFIG, idle);
  const svc = new IdentityService(store, clock, new SequenceEntropy("i"), challenge, federated, participants);
  return { store, svc };
}

const mutation = (idempotencyKey: string, expectedRevision: number): MutationControl =>
  ({ idempotencyKey, expectedRevision: String(expectedRevision) as unknown as MutationControl["expectedRevision"] });

describe("AT-11-style coordinator integration for ActualPortfolio", () => {
  it("fence-first erasure through the real Identity coordinator: receipt matches the public fence and the module goes dark", async () => {
    const journal = new ActualJournal(() => NOW);
    const erasure = new ActualPortfolioErasure({ journal, stores: [] });
    const { store, svc } = buildIdentity([erasure]);
    const account = await store.ensureEmailAccount("erase-actual@example.com");
    const workspaceReference = await store.primaryWorkspace(account);
    const subject = String(workspaceReference);
    journal.append(subject, openingCommand(), control("k1", 0));

    const session = await store.issueSession(account.accountReference, workspaceReference);
    const proof = await svc.beginReauthentication(session.proof);
    if (proof === undefined) throw new Error("expected reauth proof");
    const revision = await store.accountSecurityRevision(account.accountReference);
    const outcome = await svc.requestAdministrativeErasure({ scope: "account", confirmationProof: proof }, mutation("e-actual", revision), session.proof);
    expect(outcome.status).toBe("accepted");
    if (outcome.status !== "accepted") throw new Error("unreachable");

    const receipt = erasure.receiptFor(subject);
    expect(String(receipt?.fence)).toBe(String(outcome.fence));
    expect(journal.list(subject, ACCOUNT)).toHaveLength(0);

    // The public service surface is dark for the erased workspace: the revoked
    // session resolves to guest and even a forged workspace viewer reads nothing.
    const service = new ActualPortfolioService({
      journal,
      port: { quote: () => ({ available: false }), fxRate: () => ({ available: false }) },
      identity: { currentAuthorizationEpoch: () => "epoch:1" },
      policyVersion: "policy:f6-1",
      now: () => NOW,
      updateId: () => "update:1",
    });
    const forged: WorkspaceViewerContext = {
      kind: "workspace",
      requestId: "req-x",
      workspaceReference: brandReference<string, "WorkspaceReference">(subject),
      accountReference: brandReference<string, "AccountReference">(String(account.accountReference)),
      sessionReference: brandReference<string, "SessionReference">("session:sx"),
      sessionGeneration: brandReference<string, "SessionGeneration">("gen:x"),
      accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:1"),
      membershipRevision: brandReference<string, "MembershipRevision">("mem:1"),
    };
    const load = service.open({ sections: ["positions"], requestRevision: "r1" }, forged);
    const initial = await load.initial;
    if (initial.status === "ready") expect(initial.positions).toHaveLength(0);
    expect(service.change(openingCommand(), control("k1", 0), forged)).toEqual({ status: "suppressed" });
  });
});
