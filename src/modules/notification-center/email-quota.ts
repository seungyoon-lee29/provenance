/**
 * F5 Resend email quota reserve (spec §12 line 335). The base plan is 100/day
 * and 3000/month. Security email is protected by a 25/day, 750/month reserve,
 * enforced structurally by capping optional financial email at the complement
 * (75/day, 2250/month) plus a per-user 5/day, 60/month cap. Because financial
 * can never exceed 75/day, at least 25/day always remains for security.
 * Reservation happens before dispatch so concurrent sends cannot oversend.
 */
export type EmailCategory = "security" | "financial";

export const EMAIL_QUOTA = {
  totalDay: 100,
  totalMonth: 3000,
  financialDay: 75,
  financialMonth: 2250,
  userDay: 5,
  userMonth: 60,
} as const;

export type EmailQuotaUsage = Readonly<{
  totalDay: number;
  totalMonth: number;
  financialDay: number;
  financialMonth: number;
  userDay: number;
  userMonth: number;
}>;

export type EmailQuotaReservation =
  | Readonly<{ granted: true }>
  | Readonly<{ granted: false; reason: "daily_quota" | "monthly_quota" | "user_daily" | "user_monthly" }>;

export function reserveEmailQuota(category: EmailCategory, usage: EmailQuotaUsage): EmailQuotaReservation {
  // Monthly is reported before daily because a monthly exhaustion suppresses/expires
  // rather than waits for a daily reset (spec §12 line 348).
  if (usage.totalMonth >= EMAIL_QUOTA.totalMonth) return { granted: false, reason: "monthly_quota" };
  if (usage.totalDay >= EMAIL_QUOTA.totalDay) return { granted: false, reason: "daily_quota" };
  if (category === "financial") {
    if (usage.financialMonth >= EMAIL_QUOTA.financialMonth) return { granted: false, reason: "monthly_quota" };
    if (usage.financialDay >= EMAIL_QUOTA.financialDay) return { granted: false, reason: "daily_quota" };
    if (usage.userMonth >= EMAIL_QUOTA.userMonth) return { granted: false, reason: "user_monthly" };
    if (usage.userDay >= EMAIL_QUOTA.userDay) return { granted: false, reason: "user_daily" };
  }
  return { granted: true };
}
