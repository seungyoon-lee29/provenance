import type { ActualAccountReference } from "../baseline/contracts";
import type { PortfolioTransfer } from "../journal/contracts";
import type { ExternalFlow, PerformanceInput, PerformanceWindow, PortfolioReturnResult } from "./contracts";
import { computePortfolioReturn } from "./performance";

export type TransferClassification =
  | Readonly<{ status: "internal" }>
  | Readonly<{ status: "external_flow"; flow: ExternalFlow }>
  | Readonly<{ status: "unavailable"; reason: "missing_fair_value" }>;

/**
 * A transfer between two in-scope accounts is NOT an external flow (§8) — it
 * never touches the return. A scope-boundary transfer becomes a return flow
 * only with an evidence-based fair value; without one there is no number to
 * use and the classification fails closed.
 */
export function classifyTransfer(
  transfer: PortfolioTransfer,
  scopeAccounts: ReadonlySet<string>,
): TransferClassification {
  const internal =
    transfer.counterparty.kind === "internal"
    && scopeAccounts.has(String(transfer.counterparty.account))
    && scopeAccounts.has(String(transfer.account));
  if (internal) return { status: "internal" };
  if (transfer.fairValue === undefined) return { status: "unavailable", reason: "missing_fair_value" };
  const signed = transfer.direction === "in" ? transfer.fairValue.amount : -transfer.fairValue.amount;
  return {
    status: "external_flow",
    flow: { at: transfer.occurredAt, amount: { amount: signed, currency: transfer.fairValue.currency } },
  };
}

export type MembershipChange = Readonly<{
  at: string;
  change: "added" | "removed" | "disconnected";
  account: ActualAccountReference;
}>;

export type ScopeAwareReturnResult =
  | PortfolioReturnResult
  | Readonly<{ status: "scope_break"; segments: readonly Readonly<{ window: PerformanceWindow; result: PortfolioReturnResult }>[] }>
  | Readonly<{ status: "unavailable"; reason: "flow_at_scope_break" }>;

/**
 * Scope membership changes are series breaks (AT-06): the result TYPE for a
 * window crossing one has per-segment returns and no combined number at all —
 * segments cannot be silently chain-linked. A flow exactly at a break instant
 * belongs to neither segment and fails closed instead of being dropped.
 */
export function computeScopeAwareReturn(
  input: PerformanceInput,
  changes: readonly MembershipChange[],
): ScopeAwareReturnResult {
  const fromMs = Date.parse(input.window.from);
  const toMs = Date.parse(input.window.to);
  const changeInstants = changes.map((change) => Date.parse(change.at));
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || changeInstants.some(Number.isNaN)) {
    return { status: "unavailable", reason: "invalid_timestamp" };
  }
  // Instants are compared in normalized ms, matching the TWR engine — a break
  // written with different ISO precision still collides with an equal flow.
  const breaks = [...new Set(changeInstants.filter((at) => at > fromMs && at < toMs))].sort((left, right) => left - right);
  if (breaks.length === 0) return computePortfolioReturn(input);
  if (input.externalFlows.some((flow) => breaks.includes(Date.parse(flow.at)))) {
    return { status: "unavailable", reason: "flow_at_scope_break" };
  }

  const cuts = [input.window.from, ...breaks.map((at) => new Date(at).toISOString()), input.window.to];
  const segments: Array<Readonly<{ window: PerformanceWindow; result: PortfolioReturnResult }>> = [];
  for (let index = 0; index < cuts.length - 1; index += 1) {
    const from = cuts[index];
    const to = cuts[index + 1];
    if (from === undefined || to === undefined) continue;
    const window = { from, to };
    const externalFlows = input.externalFlows.filter((flow) => flow.at > from && flow.at < to);
    segments.push({ window, result: computePortfolioReturn({ window, valuations: input.valuations, externalFlows }) });
  }
  return { status: "scope_break", segments };
}
