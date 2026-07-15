import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { brandReference } from "@/shared/contracts/brands";
import type { ProviderConnectionReference } from "@/shared/contracts/brands";
import type { MutationControl } from "@/shared/contracts/mutation-control";
import { identityServer } from "@/composition/identity-server";
import { clientProofFrom, viewerFrom } from "@/composition/session-cookie";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const reference = z.string().min(1).max(200);

const saveSchema = z.object({
  action: z.literal("save"),
  connectionReference: reference.nullable().default(null),
  provider: z.string().min(1).max(64),
  environment: z.enum(["paper", "live"]),
  capability: z.string().min(1).max(64),
  credentialType: z.string().min(1).max(64),
  secret: z.string().min(1).max(4096),
  expectedRevision: z.string().min(1).default("0"),
});
const verifySchema = z.object({
  action: z.literal("verify"),
  connectionReference: reference,
  result: z.enum(["verified", "failed"]),
  expectedRevision: z.string().min(1),
});
const revokeSchema = z.object({
  action: z.literal("revoke"),
  connectionReference: reference,
  expectedRevision: z.string().min(1),
});
const bodySchema = z.discriminatedUnion("action", [saveSchema, verifySchema, revokeSchema]);

export async function GET(request: NextRequest): Promise<NextResponse> {
  const viewer = viewerFrom(request);
  if (viewer === undefined || viewer.kind !== "workspace") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const views = await identityServer().connections.list(viewer);
  // Views are masked (last-4 hint only); safe to serialize to the browser.
  return NextResponse.json({ connections: views });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const clientProof = clientProofFrom(request);
  if (!clientProof.sameOrigin) return NextResponse.json({ error: "rejected" }, { status: 403 });

  const viewer = viewerFrom(request);
  if (viewer === undefined || viewer.kind !== "workspace") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const body = parsed.data;

  const server = identityServer();
  if (body.action === "save" && server.vaultDisabled) {
    // Spec §13.1: no vault configured → surface configuration_required, never touch the store.
    return NextResponse.json({ status: "configuration_required" }, { status: 409 });
  }

  const control: MutationControl = {
    idempotencyKey: randomUUID(),
    expectedRevision: brandReference<string, "Revision">(body.expectedRevision),
  };

  let receipt;
  if (body.action === "save") {
    receipt = await server.connections.save(
      {
        kind: "SaveProviderConnection",
        connectionReference:
          body.connectionReference === null
            ? null
            : (brandReference<string, "ProviderConnectionReference">(body.connectionReference) as ProviderConnectionReference),
        provider: body.provider,
        environment: body.environment,
        capability: body.capability,
        credentialType: body.credentialType,
        secret: body.secret,
      },
      control,
      viewer,
    );
  } else if (body.action === "verify") {
    receipt = await server.connections.verify(
      {
        kind: "VerifyProviderConnection",
        connectionReference: brandReference<string, "ProviderConnectionReference">(body.connectionReference) as ProviderConnectionReference,
        result: body.result,
      },
      control,
      viewer,
    );
  } else {
    receipt = await server.connections.revoke(
      {
        kind: "RevokeProviderConnection",
        connectionReference: brandReference<string, "ProviderConnectionReference">(body.connectionReference) as ProviderConnectionReference,
      },
      control,
      viewer,
    );
  }
  // Receipt carries only a masked view (or a rejection reason) — no secret ever crosses this boundary.
  return NextResponse.json(receipt);
}
