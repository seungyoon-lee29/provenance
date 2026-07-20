import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { identityServer } from "@/composition/identity-server";
import { clientProofFrom } from "@/composition/session-cookie";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  purpose: z.enum(["verify_email", "recover", "sign_in"]),
  email: z.string().email().max(320),
  idempotencyKey: z.string().min(1).max(200),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const { purpose, email, idempotencyKey } = parsed.data;
  const outcome = await identityServer().identity.requestAccountEmail(
    { kind: "AccountEmailCommand", purpose, email },
    { idempotencyKey },
    clientProofFrom(request),
  );
  // Pass the outcome through as-is: enumeration-safe status never leaks account existence.
  return NextResponse.json({ status: outcome.status, receiptId: outcome.receiptId });
}
