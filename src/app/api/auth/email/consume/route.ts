import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { identityServer } from "@/composition/identity-server";
import { clientProofFrom, setSessionCookie } from "@/composition/session-cookie";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  kind: z.enum(["link", "manual_code"]),
  proof: z.string().min(1).max(512),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const outcome = await identityServer().identity.consumeAccountChallenge(
    { kind: parsed.data.kind, proof: parsed.data.proof },
    clientProofFrom(request),
  );
  // Return status only — the session value stays server-side and rides in the HttpOnly cookie.
  const response = NextResponse.json({ status: outcome.status });
  if (outcome.status === "issued" && outcome.sessionProof !== undefined) {
    setSessionCookie(response, outcome.sessionProof.value);
  }
  return response;
}
