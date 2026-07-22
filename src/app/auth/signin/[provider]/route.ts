import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { identityServer } from "@/composition/identity-server";
import { clientProofFrom } from "@/composition/session-cookie";
import type { InternalRoute } from "@/modules/identity/contracts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RETURN_ROUTE: InternalRoute = { kind: "InternalRoute", path: "/" };

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider } = await context.params;
  if (provider !== "google" && provider !== "github") {
    return NextResponse.redirect(new URL("/signin?error=1", request.url));
  }
  try {
    // The transient state/PKCE/nonce is held server-side by the service; the browser only carries state.
    const intent = identityServer().identity.beginFederatedSignIn(
      { provider, returnRoute: RETURN_ROUTE },
      clientProofFrom(request),
    );
    return NextResponse.redirect(intent.authorizationUrl, { status: 302 });
  } catch {
    return NextResponse.redirect(new URL("/signin?error=1", request.url), { status: 302 });
  }
}
