import type { ActualAccountReference, PortfolioTransfer } from "./actual-refs";
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
  const flows = input.externalFlows.map((flow) => ({ flow, at: Date.parse(flow.at) }));
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || changeInstants.some(Number.isNaN) || flows.some(({ at }) => Number.isNaN(at))) {
    return { status: "unavailable", reason: "invalid_timestamp" };
  }
  // Instants are compared in normalized ms, matching the TWR engine — a break
  // written with different ISO precision still collides with an equal flow.
  const breaks = [...new Set(changeInstants.filter((at) => at > fromMs && at < toMs))].sort((left, right) => left - right);
  if (breaks.length === 0) return computePortfolioReturn(input);
  if (flows.some(({ at }) => breaks.includes(at))) {
    return { status: "unavailable", reason: "flow_at_scope_break" };
  }
  // Segmenting must not turn a fatal input into a passing one: the unsegmented
  // path refuses a flow at/outside the window boundary (`flow_outside_window`),
  // so the segmented path refuses it too instead of dropping it into no segment.
  if (flows.some(({ at }) => at <= fromMs || at >= toMs)) {
    return { status: "unavailable", reason: "flow_outside_window" };
  }

  // Cut INSTANTS drive segment assignment so it uses the same normalized
  // comparison as the break detection above — the echoed window keeps the
  // caller's original boundary strings (an offset form comes back unchanged).
  // Comparing the raw strings here was the bug: `cuts` mixes caller-supplied
  // precision with `toISOString()`, and lexicographic order is not time order
  // across offsets ("…T00:00+09:00" sorts after "…T15:00Z", the same instant).
  const cutInstants = [fromMs, ...breaks, toMs];
  const cutLabels = [input.window.from, ...breaks.map((at) => new Date(at).toISOString()), input.window.to];
  const segments: Array<Readonly<{ window: PerformanceWindow; result: PortfolioReturnResult }>> = [];
  for (let index = 0; index < cutInstants.length - 1; index += 1) {
    const fromCut = cutInstants[index];
    const toCut = cutInstants[index + 1];
    const from = cutLabels[index];
    const to = cutLabels[index + 1];
    if (fromCut === undefined || toCut === undefined || from === undefined || to === undefined) continue;
    const window = { from, to };
    const externalFlows = flows.filter(({ at }) => at > fromCut && at < toCut).map(({ flow }) => flow);
    segments.push({ window, result: computePortfolioReturn({ window, valuations: input.valuations, externalFlows }) });
  }
  return { status: "scope_break", segments };
}
