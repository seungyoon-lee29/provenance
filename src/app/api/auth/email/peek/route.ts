import { NextResponse } from "next/server";

import { identityServer } from "@/composition/identity-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function devOrTest(): boolean {
  const environment = process.env.APP_ENVIRONMENT;
  return environment === "development" || environment === "test";
}

/**
 * Mailpit-equivalent seam: drains the challenge outbox so the browser smoke can read the "email".
 * MUST 404 outside development/test — the plaintext code/link never leaves the server in prod.
 */
export async function GET(): Promise<NextResponse> {
  if (!devOrTest()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const drafts = identityServer().challenge.drainOutbox();
  return NextResponse.json({
    drafts: drafts.map((draft) => ({ code: draft.code, linkToken: draft.linkToken })),
  });
}
