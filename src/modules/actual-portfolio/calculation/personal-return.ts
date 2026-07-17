import type { ReportingMoney } from "./contracts";

export type PersonalFlow = Readonly<{ at: string; amount: ReportingMoney }>;

/**
 * The caller composes the flow list (external flows plus the terminal
 * valuation as a final inflow) in the reporting currency; the solver only
 * establishes uniqueness and solves.
 */
export type PersonalReturnInput = Readonly<{ flows: readonly PersonalFlow[] }>;

export type PersonalReturnResult =
  | Readonly<{ status: "covered"; annualizedRate: number }>
  | Readonly<{
      status: "unavailable";
      reason: "insufficient_flows" | "no_sign_change" | "no_unique_solution" | "mixed_currency";
    }>;

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

/**
 * Personal Return = XIRR with a UNIQUE solution (spec §8): solve
 * Σ cf_i·(1+r)^(−t_i) = 0 over r > −1, t_i in years (days/365) from the first
 * flow. Uniqueness is established by Descartes' rule for generalized
 * polynomials: with exactly one sign change in the time-ordered flows there is
 * at most one root, and the boundary limits (latest flow dominates r→−1⁺, the
 * t=0 flow dominates r→∞) guarantee one exists. More than one sign change
 * cannot establish uniqueness — the result is unavailable, never "a" root
 * (the AT-05 two-root fixture has real roots at both 20% and 30%).
 */
export function computePersonalReturn(input: PersonalReturnInput): PersonalReturnResult {
  const currency = input.flows[0]?.amount.currency;
  if (currency !== undefined && input.flows.some((flow) => flow.amount.currency !== currency)) {
    return { status: "unavailable", reason: "mixed_currency" };
  }

  const totals = new Map<number, number>();
  for (const flow of input.flows) {
    const atMs = Date.parse(flow.at);
    totals.set(atMs, (totals.get(atMs) ?? 0) + flow.amount.amount);
  }
  const ordered = [...totals.entries()]
    .filter(([, amount]) => amount !== 0)
    .sort(([left], [right]) => left - right);
  if (ordered.length < 2) return { status: "unavailable", reason: "insufficient_flows" };

  const firstMs = ordered[0]?.[0] ?? 0;
  const flows = ordered.map(([atMs, amount]) => ({ t: (atMs - firstMs) / MS_PER_YEAR, amount }));

  let signChanges = 0;
  for (let index = 1; index < flows.length; index += 1) {
    const previous = flows[index - 1]?.amount ?? 0;
    const current = flows[index]?.amount ?? 0;
    if (Math.sign(previous) !== Math.sign(current)) signChanges += 1;
  }
  if (signChanges === 0) return { status: "unavailable", reason: "no_sign_change" };
  if (signChanges > 1) return { status: "unavailable", reason: "no_unique_solution" };

  const npv = (rate: number): number => {
    let total = 0;
    for (const flow of flows) total += flow.amount * (1 + rate) ** -flow.t;
    return total;
  };

  // Bracket the single root: near −1 the latest flow dominates, at large r the
  // first flow does — opposite signs by the one-sign-change shape.
  let lo = -1 + 1e-9;
  let hi = 1;
  const loSign = Math.sign(npv(lo));
  let expansions = 0;
  while (Math.sign(npv(hi)) === loSign) {
    hi = hi * 2 + 1;
    expansions += 1;
    if (expansions > 200) return { status: "unavailable", reason: "no_unique_solution" };
  }

  for (let iteration = 0; iteration < 200 && hi - lo > 1e-13; iteration += 1) {
    const mid = (lo + hi) / 2;
    if (Math.sign(npv(mid)) === loSign) lo = mid;
    else hi = mid;
  }

  return { status: "covered", annualizedRate: (lo + hi) / 2 };
}
