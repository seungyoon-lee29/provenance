import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import type { MarketQuery } from "@/modules/financial-information/data/contracts";
import { marketServer } from "@/composition/market-server";
import { clientProofFrom, viewerFrom } from "@/composition/session-cookie";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// KRX tickers are up to 6 digits; keep it a tight allowlist (also defends the upstream query string).
const symbolSchema = z.string().regex(/^[A-Za-z0-9.]{1,12}$/);

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Same-origin gate (matches the connections route): a cross-site top-level GET carries the Lax
  // session cookie and would otherwise use the owner's KIS key on a foreign page's behalf (CSRF).
  if (!clientProofFrom(request).sameOrigin) return NextResponse.json({ error: "rejected" }, { status: 403 });

  const symbol = symbolSchema.safeParse(new URL(request.url).searchParams.get("symbol") ?? undefined);
  if (!symbol.success) return NextResponse.json({ error: "invalid_symbol" }, { status: 400 });

  // The adapter's scope guard enforces owner-only/personal_display; a guest/non-owner viewer resolves
  // to a value-free api_required outcome without ever touching the personal key.
  const viewer = (await viewerFrom(request)) ?? { kind: "guest" as const, requestId: randomUUID() };
  const query: MarketQuery = { kind: "FinancialQuery", symbol: symbol.data, purpose: "personal_display", requestRevision: "r0" };

  // The outcome is an InformationOutcome — value + provenance or a typed unavailable/failed. No secret,
  // token, or raw provider text ever crosses this boundary (SEC-05, enforced by the adapter).
  const outcome = await marketServer().provider.read(query, viewer).result;
  return NextResponse.json(outcome);
}
