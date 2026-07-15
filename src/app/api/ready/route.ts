import { NextResponse } from "next/server";

import { checkRuntimeDependencies } from "@/platform/runtime/dependencies";

export const dynamic = "force-dynamic";

export async function GET() {
  const readiness = await checkRuntimeDependencies();
  return NextResponse.json(readiness, { status: readiness.status === "ready" ? 200 : 503 });
}
