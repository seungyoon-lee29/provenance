/**
 * F5 delivery retry schedules (spec §12 line 348). Financial deliveries (alert
 * push/email) and account challenges (email) use fixed backoff ladders bounded
 * by a deadline — the earlier of the message TTL / token expiry and a category
 * cap. A 429 Retry-After can only push a send LATER, never earlier, and never
 * past the deadline. The schedule is pure so circuit/quota tests are
 * deterministic against a fixed clock.
 */
export type RetryCategory = "financial" | "account";

// attempt index 0 is the immediate first send; delays[n] is the offset of the
// n-th send from the first attempt. Length is the maximum attempt count.
const SCHEDULES: Record<RetryCategory, Readonly<{ delaysMs: readonly number[]; capMs: number }>> = {
  financial: { delaysMs: [0, 30_000, 120_000, 600_000, 1_800_000, 5_400_000], capMs: 2 * 3_600_000 },
  account: { delaysMs: [0, 5_000, 30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000], capMs: 24 * 3_600_000 },
};

export type RetryDecision =
  | Readonly<{ action: "send"; atMs: number }>
  | Readonly<{ action: "stop"; reason: "max_attempts" | "deadline" }>;

/**
 * @param deadlineAtMs the message TTL / token expiry instant; the effective
 *   deadline is the earlier of this and the category cap past the first attempt.
 * @param notBeforeMs a 429 Retry-After instant that a send may not precede.
 */
export function nextRetry(
  category: RetryCategory,
  attempt: number,
  firstAttemptAtMs: number,
  deadlineAtMs: number,
  notBeforeMs?: number,
): RetryDecision {
  const { delaysMs, capMs } = SCHEDULES[category];
  const delay = delaysMs[attempt];
  if (delay === undefined) return { action: "stop", reason: "max_attempts" };
  const scheduled = firstAttemptAtMs + delay;
  const atMs = notBeforeMs === undefined ? scheduled : Math.max(scheduled, notBeforeMs);
  const deadline = Math.min(deadlineAtMs, firstAttemptAtMs + capMs);
  if (atMs > deadline) return { action: "stop", reason: "deadline" };
  return { action: "send", atMs };
}
