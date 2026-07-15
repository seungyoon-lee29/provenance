import { describe, expect, it } from "vitest";

import { FederatedSignInService } from "../src/modules/identity/federated";
import type { FederatedConfig, FederatedExchangeResult, FederatedProvider } from "../src/modules/identity/federated";
import { IdentitySessionStore } from "../src/modules/identity/session-store";
import type { ClientProof, FederatedCallbackProof, InternalRoute } from "../src/modules/identity/contracts";
import { IdentityTestClock, SequenceEntropy, mintIdToken } from "./harness/identity-harness";

// SYNTHETIC TEST DATA
const PROOF: ClientProof = { kind: "ClientProof", requestId: "r", method: "GET", sameOrigin: true, origin: "https://app.test" };
const ROUTE: InternalRoute = { kind: "InternalRoute", path: "/workspace" };
const TRUSTED_KEY = "trusted-issuer-key";
const ISSUER = "https://issuer.test";

const CONFIG: FederatedConfig = {
  publicOrigin: "https://app.test",
  google: { clientId: "gid", callbackPath: "/auth/callback/google", authorizationEndpoint: "https://accounts.google.test/authorize", issuer: ISSUER, signingKey: TRUSTED_KEY },
  github: { clientId: "ghid", callbackPath: "/auth/callback/github", authorizationEndpoint: "https://github.test/authorize" },
};

function build(googleExchange: () => Promise<FederatedExchangeResult>, clock = new IdentityTestClock(1_000_000)) {
  const store = new IdentitySessionStore(clock, new SequenceEntropy("s"));
  const adapters: Record<FederatedProvider, { exchange: () => Promise<FederatedExchangeResult> }> = {
    google: { exchange: googleExchange },
    github: { exchange: async () => ({ kind: "subject", issuer: "github", subject: "gh-42" }) },
  };
  return { store, service: new FederatedSignInService(store, clock, new SequenceEntropy("f"), CONFIG, adapters) };
}

function callback(state: string, extra: Partial<FederatedCallbackProof> = {}): FederatedCallbackProof {
  return { kind: "FederatedCallbackProof", state, code: "auth-code", callbackOrigin: "https://app.test", ...extra };
}

function validGoogleToken(nonce: string | undefined, nowMs: number, overrides: Record<string, unknown> = {}, opts?: { key?: string; alg?: string; tamperSig?: boolean }) {
  const claims = { iss: ISSUER, sub: "google-user-1", aud: "gid", nonce, exp: Math.floor(nowMs / 1000) + 300, iat: Math.floor(nowMs / 1000), ...overrides };
  return mintIdToken(claims, { key: opts?.key ?? TRUSTED_KEY, ...(opts?.alg ? { alg: opts.alg } : {}), ...(opts?.tamperSig ? { tamperSig: true } : {}) });
}

describe("federated sign-in (SEC-07)", () => {
  it("completes a Google OIDC flow and issues a session without leaking the raw token", async () => {
    const clock = new IdentityTestClock(1_000_000);
    let token = "";
    const { store, service } = build(async () => ({ kind: "oidc", idToken: token }), clock);
    const intent = service.begin({ provider: "google", returnRoute: ROUTE }, PROOF);
    expect(intent.nonce).toBeDefined();
    expect(intent.pkceChallenge).toHaveLength(43); // base64url SHA-256
    token = validGoogleToken(intent.nonce, clock.now());

    const result = await service.consume({ provider: "google", callbackProof: callback(intent.state) }, PROOF);
    expect(result.status).toBe("issued");
    if (result.sessionProof === undefined) throw new Error("expected session");
    expect(store.resolve(result.sessionProof).kind).toBe("workspace");
    expect(JSON.stringify(result)).not.toContain(token); // no raw provider token artifact
  });

  it("completes a GitHub flow on a verified stable subject", async () => {
    const { store, service } = build(async () => ({ kind: "untrusted", reason: "unused" }));
    const intent = service.begin({ provider: "github", returnRoute: ROUTE }, PROOF);
    expect(intent.nonce).toBeUndefined(); // no OIDC nonce for GitHub
    const result = await service.consume({ provider: "github", callbackProof: callback(intent.state) }, PROOF);
    expect(result.status).toBe("issued");
    if (result.sessionProof === undefined) throw new Error("expected session");
    expect(store.resolve(result.sessionProof).kind).toBe("workspace");
  });

  it("rejects a forged/unknown state (CSRF) with no session", async () => {
    const { service } = build(async () => ({ kind: "oidc", idToken: "x" }));
    service.begin({ provider: "google", returnRoute: ROUTE }, PROOF);
    expect((await service.consume({ provider: "google", callbackProof: callback("forged-state") }, PROOF)).status).toBe("denied");
  });

  it("rejects a replayed callback (one-time state)", async () => {
    const clock = new IdentityTestClock(1_000_000);
    let token = "";
    const { service } = build(async () => ({ kind: "oidc", idToken: token }), clock);
    const intent = service.begin({ provider: "google", returnRoute: ROUTE }, PROOF);
    token = validGoogleToken(intent.nonce, clock.now());
    expect((await service.consume({ provider: "google", callbackProof: callback(intent.state) }, PROOF)).status).toBe("issued");
    expect((await service.consume({ provider: "google", callbackProof: callback(intent.state) }, PROOF)).status).toBe("denied");
  });

  it("rejects an expired intent", async () => {
    const clock = new IdentityTestClock(1_000_000);
    let token = "";
    const { service } = build(async () => ({ kind: "oidc", idToken: token }), clock);
    const intent = service.begin({ provider: "google", returnRoute: ROUTE }, PROOF);
    clock.advanceBy(10 * 60 * 1000 + 1);
    token = validGoogleToken(intent.nonce, clock.now());
    expect((await service.consume({ provider: "google", callbackProof: callback(intent.state) }, PROOF)).status).toBe("denied");
  });

  it("rejects a callback delivered to a non-canonical origin", async () => {
    const clock = new IdentityTestClock(1_000_000);
    let token = "";
    const { service } = build(async () => ({ kind: "oidc", idToken: token }), clock);
    const intent = service.begin({ provider: "google", returnRoute: ROUTE }, PROOF);
    token = validGoogleToken(intent.nonce, clock.now());
    const result = await service.consume({ provider: "google", callbackProof: callback(intent.state, { callbackOrigin: "https://evil.test" }) }, PROOF);
    expect(result.status).toBe("denied");
  });

  it("rejects a cross-provider callback", async () => {
    const clock = new IdentityTestClock(1_000_000);
    let token = "";
    const { service } = build(async () => ({ kind: "oidc", idToken: token }), clock);
    const intent = service.begin({ provider: "google", returnRoute: ROUTE }, PROOF);
    token = validGoogleToken(intent.nonce, clock.now());
    expect((await service.consume({ provider: "github", callbackProof: callback(intent.state) }, PROOF)).status).toBe("denied");
  });

  it("rejects forged signature, alg=none, wrong issuer/audience/nonce, and expired assertions", async () => {
    const forgeries: Array<(nonce: string | undefined, now: number) => string> = [
      (n, now) => validGoogleToken(n, now, {}, { tamperSig: true }),
      (n, now) => validGoogleToken(n, now, {}, { alg: "none" }),
      (n, now) => validGoogleToken(n, now, { iss: "https://evil.test" }),
      (n, now) => validGoogleToken(n, now, { aud: "someone-else", azp: "someone-else" }),
      (_n, now) => validGoogleToken("mismatched-nonce", now),
      (n, now) => validGoogleToken(n, now, { exp: Math.floor(now / 1000) - 10 }),
      (n, now) => validGoogleToken(n, now, {}, { key: "attacker-key" }),
    ];
    for (const forge of forgeries) {
      const clock = new IdentityTestClock(1_000_000);
      let token = "";
      const { service } = build(async () => ({ kind: "oidc", idToken: token }), clock);
      const intent = service.begin({ provider: "google", returnRoute: ROUTE }, PROOF);
      token = forge(intent.nonce, clock.now());
      const result = await service.consume({ provider: "google", callbackProof: callback(intent.state) }, PROOF);
      expect(result.status).toBe("denied");
    }
  });

  it("keeps the same subject on different issuers as distinct accounts (issuer+subject key)", async () => {
    const clock = new IdentityTestClock(1_000_000);
    let token = "";
    const { store, service } = build(async () => ({ kind: "oidc", idToken: token }), clock);
    // github subject "42" (the default github adapter) vs google subject "google-user-1"
    const gh = service.begin({ provider: "github", returnRoute: ROUTE }, PROOF);
    const ghResult = await service.consume({ provider: "github", callbackProof: callback(gh.state) }, PROOF);
    const gg = service.begin({ provider: "google", returnRoute: ROUTE }, PROOF);
    token = validGoogleToken(gg.nonce, clock.now());
    const ggResult = await service.consume({ provider: "google", callbackProof: callback(gg.state) }, PROOF);

    expect(ghResult.status).toBe("issued");
    expect(ggResult.status).toBe("issued");
    expect(ghResult.viewer?.accountReference).not.toBe(ggResult.viewer?.accountReference);
    // and the two proofs resolve to two different workspaces
    if (ghResult.sessionProof === undefined || ggResult.sessionProof === undefined) throw new Error("expected sessions");
    const ghViewer = store.resolve(ghResult.sessionProof);
    const ggViewer = store.resolve(ggResult.sessionProof);
    if (ghViewer.kind !== "workspace" || ggViewer.kind !== "workspace") throw new Error("expected workspaces");
    expect(ghViewer.accountReference).not.toBe(ggViewer.accountReference);
  });

  it("keys identity on issuer+subject and never auto-merges a matching email account", async () => {
    const clock = new IdentityTestClock(1_000_000);
    let token = "";
    const { store, service } = build(async () => ({ kind: "oidc", idToken: token }), clock);
    const emailAccount = store.ensureEmailAccount("shared@example.com");
    const intent = service.begin({ provider: "google", returnRoute: ROUTE }, PROOF);
    token = validGoogleToken(intent.nonce, clock.now(), { email: "shared@example.com" });

    const result = await service.consume({ provider: "google", callbackProof: callback(intent.state) }, PROOF);
    expect(result.status).toBe("issued");
    expect(result.viewer?.accountReference).not.toBe(emailAccount.accountReference);
  });
});
