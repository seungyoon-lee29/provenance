import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { brandReference } from "../../shared/contracts/brands";
import type {
  ClientProof,
  EntropySource,
  FederatedCallbackProof,
  FederatedSignInIntent,
  IdentityClock,
  InternalRoute,
  SessionOutcome,
} from "./contracts";
import type { IdentityStore } from "./session-store";

const INTENT_TTL_MS = 10 * 60 * 1000; // SEC-07: ≤10 minute expiry
const CLOCK_SKEW_MS = 60 * 1000;

export type FederatedProvider = "google" | "github";

/** Transport seam: exchanges the callback code at an allowlisted endpoint. Identity owns all trust checks. */
export type FederatedExchangeResult =
  | { kind: "oidc"; idToken: string }
  | { kind: "subject"; issuer: string; subject: string }
  | { kind: "untrusted"; reason: string };

export interface FederatedProviderAdapter {
  exchange(params: Readonly<{ code: string; codeVerifier: string; redirectUri: string }>): Promise<FederatedExchangeResult>;
}

export type OidcProviderConfig = Readonly<{
  clientId: string;
  callbackPath: string;
  authorizationEndpoint: string;
  issuer: string;
  signingKey: string; // scripted symmetric verification key (test issuer JWK stand-in)
}>;

export type OAuthProviderConfig = Readonly<{
  clientId: string;
  callbackPath: string;
  authorizationEndpoint: string;
}>;

export type FederatedConfig = Readonly<{
  publicOrigin: string;
  google?: OidcProviderConfig;
  github?: OAuthProviderConfig;
}>;

type IntentRecord = {
  state: string;
  provider: FederatedProvider;
  codeVerifier: string;
  codeChallenge: string;
  nonce?: string;
  returnRoute: string;
  expiresAtMs: number;
  consumed: boolean;
};

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function s256(input: string): string {
  return base64url(createHash("sha256").update(input).digest());
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function denied(): SessionOutcome {
  return { kind: "SessionOutcome", status: "denied" };
}

/** Verify a scripted OIDC id_token. Returns `issuer|subject` or null (never leaks the raw token). */
function verifyOidcAssertion(idToken: string, config: OidcProviderConfig, nonce: string | undefined, nowMs: number): string | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: { alg?: unknown };
  let payload: { iss?: unknown; sub?: unknown; aud?: unknown; azp?: unknown; nonce?: unknown; exp?: unknown; iat?: unknown };
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as typeof header;
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as typeof payload;
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null; // reject "none" and algorithm confusion
  const expected = base64url(createHmac("sha256", config.signingKey).update(`${headerPart}.${payloadPart}`).digest());
  if (!safeEqualHex(signaturePart, expected)) return null; // forged signature
  if (payload.iss !== config.issuer) return null; // wrong issuer
  const audience = payload.aud;
  const authorizedParty = payload.azp;
  if (audience !== config.clientId && authorizedParty !== config.clientId) return null; // wrong audience
  if (nonce !== undefined && payload.nonce !== nonce) return null; // nonce mismatch / replay
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) return null; // expired
  if (typeof payload.iat !== "number" || payload.iat * 1000 > nowMs + CLOCK_SKEW_MS) return null; // future-dated
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
  return `${config.issuer}|${payload.sub}`;
}

function isInternalRoute(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") && !/^\/+\w+:/.test(path);
}

export class FederatedSignInService {
  readonly #intents = new Map<string, IntentRecord>();

  constructor(
    private readonly store: IdentityStore,
    private readonly clock: IdentityClock,
    private readonly entropy: EntropySource,
    private readonly config: FederatedConfig,
    private readonly adapters: Readonly<Record<FederatedProvider, FederatedProviderAdapter>>,
  ) {}

  begin(command: Readonly<{ provider: FederatedProvider; returnRoute: InternalRoute }>, _clientProof: ClientProof): FederatedSignInIntent {
    const providerConfig = command.provider === "google" ? this.config.google : this.config.github;
    if (providerConfig === undefined) throw new Error(`${command.provider} identity is not configured`);
    if (!isInternalRoute(command.returnRoute.path)) throw new Error("return route must be an internal path");

    const state = this.entropy.token(32);
    const codeVerifier = this.entropy.token(32);
    const codeChallenge = s256(codeVerifier);
    const nonce = command.provider === "google" ? this.entropy.token(16) : undefined;
    const expiresAtMs = this.clock.now() + INTENT_TTL_MS;
    this.#intents.set(state, {
      state,
      provider: command.provider,
      codeVerifier,
      codeChallenge,
      returnRoute: command.returnRoute.path,
      expiresAtMs,
      consumed: false,
      ...(nonce === undefined ? {} : { nonce }),
    });

    const redirectUri = this.config.publicOrigin + providerConfig.callbackPath;
    const params = new URLSearchParams({
      client_id: providerConfig.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      ...(nonce === undefined ? {} : { nonce }),
    });
    return {
      kind: "FederatedSignInIntent",
      provider: command.provider,
      authorizationUrl: `${providerConfig.authorizationEndpoint}?${params.toString()}`,
      state,
      pkceChallenge: codeChallenge,
      expiresAtMs,
      ...(nonce === undefined ? {} : { nonce }),
    };
  }

  async consume(command: Readonly<{ provider: FederatedProvider; callbackProof: FederatedCallbackProof }>, _clientProof: ClientProof): Promise<SessionOutcome> {
    const intent = this.#intents.get(command.callbackProof.state);
    if (intent === undefined) return denied(); // unknown/forged state (CSRF)
    if (intent.consumed) return denied(); // replay
    intent.consumed = true; // one-time, before any exchange
    if (this.clock.now() > intent.expiresAtMs) return denied();
    if (intent.provider !== command.provider) return denied(); // cross-provider callback
    if (command.callbackProof.callbackOrigin !== this.config.publicOrigin) return denied(); // exact callback origin only

    const providerConfig = command.provider === "google" ? this.config.google : this.config.github;
    if (providerConfig === undefined) return denied();
    const redirectUri = this.config.publicOrigin + providerConfig.callbackPath;

    let result: FederatedExchangeResult;
    try {
      result = await this.adapters[command.provider].exchange({ code: command.callbackProof.code, codeVerifier: intent.codeVerifier, redirectUri });
    } catch {
      return denied();
    }

    let identityKey: string | null = null;
    if (result.kind === "oidc" && command.provider === "google" && this.config.google !== undefined) {
      identityKey = verifyOidcAssertion(result.idToken, this.config.google, intent.nonce, this.clock.now());
    } else if (result.kind === "subject" && command.provider === "github") {
      identityKey = `github|${result.subject}`;
    }
    if (identityKey === null) return denied(); // untrusted / forged / malformed → 0 session

    // identity key is issuer+subject; a matching email never auto-merges into another account.
    const account = await this.store.ensureFederatedAccount(identityKey);
    if (account.state !== "active" || (await this.store.isErasedAccount(account.accountReference))) return denied(); // erased tombstone stays suppressed
    const issued = await this.store.issueSession(account.accountReference, await this.store.primaryWorkspace(account));
    return {
      kind: "SessionOutcome",
      status: "issued",
      sessionProof: issued.proof,
      viewer: issued.viewer,
      revision: brandReference<string, "Revision">(String(await this.store.bumpSecurityRevision(account.accountReference))),
    };
  }
}
