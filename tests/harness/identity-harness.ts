import { createHmac } from "node:crypto";

import type { EntropySource, IdentityClock } from "../../src/modules/identity/contracts";

/** Deterministic, collision-free entropy for identity tests (never real randomness). */
export class SequenceEntropy implements EntropySource {
  #counter = 0;
  constructor(private readonly label = "e") {}
  token(byteLength = 16): string {
    this.#counter += 1;
    return `${this.label}-${byteLength}-${this.#counter}`;
  }
}

/** Manual clock exposing an absolute millisecond timeline for expiry oracles. */
export class IdentityTestClock implements IdentityClock {
  constructor(private currentMs = 0) {}
  now(): number {
    return this.currentMs;
  }
  advanceBy(ms: number): void {
    this.currentMs += ms;
  }
  set(ms: number): void {
    this.currentMs = ms;
  }
}

function b64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

/** Mint a scripted OIDC id_token for federated tests. Supports forgery: alg "none", wrong key, tampered sig. */
export function mintIdToken(
  claims: Readonly<Record<string, unknown>>,
  opts: Readonly<{ key: string; alg?: string; tamperSig?: boolean }>,
): string {
  const alg = opts.alg ?? "HS256";
  const header = b64url(JSON.stringify({ alg, typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  if (alg === "none") return `${header}.${payload}.`;
  let signature = createHmac("sha256", opts.key).update(`${header}.${payload}`).digest("base64url");
  if (opts.tamperSig) signature = `${signature.slice(0, -2)}AA`;
  return `${header}.${payload}.${signature}`;
}
