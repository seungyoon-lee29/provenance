import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import type { MarketQuery } from "@/modules/financial-information/data/contracts";
import { publicMarketServer } from "@/composition/public-market-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Public-track read (ticket 28-b): no session, no cookie, no same-origin gate — this route serves
// public-domain data to anyone, so there is no CSRF surface and no owner to protect. The symbol
// allowlist stays (defends the upstream query string).
const symbolSchema = z.string().regex(/^[A-Za-z0-9.]{1,12}$/);

export async function GET(request: NextRequest): Promise<NextResponse> {
  const symbol = symbolSchema.safeParse(new URL(request.url).searchParams.get("symbol") ?? undefined);
  if (!symbol.success) return NextResponse.json({ error: "invalid_symbol" }, { status: 400 });

  const query: MarketQuery = { kind: "FinancialQuery", symbol: symbol.data, purpose: "public_display", requestRevision: "r0" };

  // The outcome is an InformationOutcome — value + provenance or a typed unavailable/failed. Every
  // observation this adapter emits carries licenseScope.audience "public" (redistribution is the point).
  const outcome = await publicMarketServer().read(query, { kind: "guest", requestId: randomUUID() }).result;
  return NextResponse.json(outcome);
}
