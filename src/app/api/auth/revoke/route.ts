import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { brandReference } from "@/shared/contracts/brands";
import { identityServer } from "@/composition/identity-server";
import { clearSessionCookie, clientProofFrom, sessionCookieValue } from "@/composition/session-cookie";
import type { SessionProof } from "@/modules/identity/contracts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const clientProof = clientProofFrom(request);
  // CSRF gate: a state-changing POST with a foreign/missing Origin never revokes.
  if (!clientProof.sameOrigin) return NextResponse.json({ status: "rejected" }, { status: 403 });

  const value = sessionCookieValue(request);
  if (value === undefined) return NextResponse.json({ status: "revoked" });

  const server = identityServer();
  const proof: SessionProof = { kind: "SessionProof", value };
  const viewer = await server.identity.resolve(proof);
  const response = NextResponse.json({ status: "revoked" });
  clearSessionCookie(response);
  if (viewer.kind !== "workspace") return response;

  const expectedRevision = String(await server.store.accountSecurityRevision(String(viewer.accountReference)));
  await server.identity.revokeSession(
    { scope: "current" },
    { idempotencyKey: randomUUID(), expectedRevision: brandReference<string, "Revision">(expectedRevision) },
    proof,
  );
  return response;
}
