import type { NextRequest } from "next/server";
import { z } from "zod";

import { takeGuestTerminalLoad } from "@/modules/terminal-view/presentation/guest/guest-load-registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const querySchema = z.object({
  requestId: z.uuid(),
  revision: z.string().regex(/^guest-[0-9a-f-]{36}$/i),
}).strict();

const encoder = new TextEncoder();

function event(name: string, payload: unknown): Uint8Array {
  return encoder.encode(`${name === "message" ? "" : `event: ${name}\n`}data: ${JSON.stringify(payload)}\n\n`);
}

export async function GET(request: NextRequest): Promise<Response> {
  const parsed = querySchema.safeParse({
    requestId: request.nextUrl.searchParams.get("requestId"),
    revision: request.nextUrl.searchParams.get("revision"),
  });
  if (!parsed.success) {
    return Response.json({ error: "invalid guest update request" }, { status: 400 });
  }

  const load = takeGuestTerminalLoad(parsed.data.requestId, parsed.data.revision);
  if (!load) {
    return Response.json({ error: "guest update load expired or already claimed" }, { status: 410 });
  }
  request.signal.addEventListener("abort", () => load.cancel(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const update of load.updates) {
          controller.enqueue(event("message", update));
        }
        controller.enqueue(event("complete", { resumeIdentity: load.resumeIdentity }));
      } catch {
        if (!request.signal.aborted) controller.enqueue(event("stream-error", { retryable: true }));
      } finally {
        load.cancel();
        controller.close();
      }
    },
    cancel() {
      load.cancel();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-store",
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
