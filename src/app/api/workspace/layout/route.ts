import { NextResponse } from "next/server";
import { z } from "zod";

import { brandReference } from "@/shared/contracts/brands";
import type { MutationControl } from "@/shared/contracts/mutation-control";
import type { ChangeWorkspaceLayoutCommand } from "@/modules/terminal-view/layout/contracts";
import { changeWorkspaceLayout, devWorkspaceProof, isDevWorkspaceMode } from "@/modules/terminal-view/presentation/workspace/workspace-server";

const operationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("move"), widgetId: z.string().min(1), x: z.number().int(), y: z.number().int() }),
  z.object({ type: z.literal("resize"), widgetId: z.string().min(1), w: z.number().int(), h: z.number().int() }),
  z.object({ type: z.literal("divider"), left: z.number().int(), right: z.number().int() }),
  z.object({ type: z.literal("split"), widgetId: z.string().min(1), panes: z.number().int() }),
]);

const bodySchema = z.object({
  operation: operationSchema,
  expectedRevision: z.string().min(1),
  idempotencyKey: z.string().min(1).max(200),
});

export async function POST(request: Request): Promise<NextResponse> {
  if (!isDevWorkspaceMode()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const command: ChangeWorkspaceLayoutCommand = { kind: "ChangeWorkspaceLayout", operation: parsed.data.operation };
  const control: MutationControl = {
    idempotencyKey: parsed.data.idempotencyKey,
    expectedRevision: brandReference<string, "Revision">(parsed.data.expectedRevision),
  };
  const outcome = await changeWorkspaceLayout(command, control, await devWorkspaceProof());
  return NextResponse.json({ status: outcome.status, revision: String(outcome.revision), layout: outcome.layout });
}
