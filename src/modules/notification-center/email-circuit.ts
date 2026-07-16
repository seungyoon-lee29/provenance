/**
 * F5 optional email quality circuit (spec §12 line 350). Over a 7-day rolling
 * sample of provider-accepted external email, a hard-bounce rate ≥3% or a
 * complaint rate ≥0.05% opens the circuit once the sample is statistically
 * meaningful (≥200). Below 200 a single complaint is a warning + manual review
 * only, never an automatic open. Recovery is by manual approval or a half-open
 * probe 24h after opening. Address-level state is separate: a hard bounce stops
 * all email to that address until re-verification, and a complaint suppresses it
 * (provider suppression is never auto-cleared).
 */
export const EMAIL_CIRCUIT = {
  minSample: 200,
  hardBounceRate: 0.03,
  complaintRate: 0.0005,
  halfOpenAfterMs: 24 * 3_600_000,
} as const;

export type EmailCircuitMetrics = Readonly<{ sampleSize: number; hardBounces: number; complaints: number }>;

export type EmailCircuitState =
  | Readonly<{ state: "closed" }>
  | Readonly<{ state: "warning"; reason: "complaint_manual_review" }>
  | Readonly<{ state: "open"; reason: "hard_bounce" | "complaint" }>;

export function evaluateEmailCircuit(metrics: EmailCircuitMetrics): EmailCircuitState {
  if (metrics.sampleSize >= EMAIL_CIRCUIT.minSample) {
    if (metrics.hardBounces / metrics.sampleSize >= EMAIL_CIRCUIT.hardBounceRate) return { state: "open", reason: "hard_bounce" };
    if (metrics.complaints / metrics.sampleSize >= EMAIL_CIRCUIT.complaintRate) return { state: "open", reason: "complaint" };
    return { state: "closed" };
  }
  if (metrics.complaints >= 1) return { state: "warning", reason: "complaint_manual_review" };
  return { state: "closed" };
}

export type EmailCircuitProbe = "open" | "half_open" | "closed";

/** An open circuit reopens as a half-open probe 24h after opening, or closes on manual approval. */
export function emailCircuitProbe(openedAtMs: number, now: number, manualApproval: boolean): EmailCircuitProbe {
  if (manualApproval) return "closed";
  return now - openedAtMs >= EMAIL_CIRCUIT.halfOpenAfterMs ? "half_open" : "open";
}

export type EmailAddressState = Readonly<{ hardBounced: boolean; reVerified: boolean; complained: boolean }>;

/** A hard-bounced address is blocked until re-verified; a complained address stays suppressed. */
export function isEmailAddressBlocked(state: EmailAddressState): boolean {
  if (state.hardBounced && !state.reVerified) return true;
  if (state.complained) return true;
  return false;
}
