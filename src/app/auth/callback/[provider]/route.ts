import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { identityServer } from "@/composition/identity-server";
import { clientProofFrom, setSessionCookie } from "@/composition/session-cookie";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider } = await context.params;
  const failure = NextResponse.redirect(new URL("/signin?error=1", request.url), { status: 302 });
  if (provider !== "google" && provider !== "github") return failure;

  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  if (state === null || code === null) return failure;

  const outcome = await identityServer().identity.consumeFederatedSignIn(
    {
      provider,
      callbackProof: {
        kind: "FederatedCallbackProof",
        state,
        code,
        // Exact callback origin the service verifies against; never the raw code/token.
        callbackOrigin: process.env.APP_PUBLIC_ORIGIN ?? "",
      },
    },
    clientProofFrom(request),
  );
  if (outcome.status !== "issued" || outcome.sessionProof === undefined) return failure;

  const response = NextResponse.redirect(new URL("/workspace", request.url), { status: 302 });
  setSessionCookie(response, outcome.sessionProof.value);
  return response;
}
