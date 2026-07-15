import "server-only";

import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import type { ClientProof } from "@/modules/identity/contracts";
import { identityServer } from "./identity-server";

export const SESSION_COOKIE = "ft_session";

function secureCookie(): boolean {
  const environment = process.env.APP_ENVIRONMENT;
  return environment === "staging" || environment === "production";
}

/** Set the opaque session value in an HttpOnly cookie (never readable by JS/HTML). */
export function setSessionCookie(response: NextResponse, value: string): void {
  response.cookies.set(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: secureCookie(),
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: secureCookie(),
    maxAge: 0,
  });
}

export function sessionCookieValue(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE)?.value;
}

/**
 * Build the CSRF-bearing ClientProof from the request. A state-changing POST with a foreign or
 * missing Origin is `sameOrigin: false` — the module logic then rejects it. Same-origin is proven
 * by an exact Origin match, or by `Sec-Fetch-Site: same-origin` (browser-attested navigations).
 */
export function clientProofFrom(request: NextRequest): ClientProof {
  const method = request.method === "POST" ? "POST" : "GET";
  const origin = request.headers.get("origin") ?? "";
  const fetchSite = request.headers.get("sec-fetch-site");
  const publicOrigin = process.env.APP_PUBLIC_ORIGIN ?? "";
  const sameOrigin = (origin !== "" && origin === publicOrigin) || fetchSite === "same-origin";
  return { kind: "ClientProof", requestId: randomUUID(), method, sameOrigin, origin };
}

/** Resolve the current viewer from the session cookie (guest if absent/invalid). */
export function viewerFrom(request: NextRequest) {
  const value = sessionCookieValue(request);
  return value === undefined ? undefined : identityServer().resolve(value);
}
