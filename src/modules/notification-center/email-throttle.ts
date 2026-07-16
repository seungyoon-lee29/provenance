import type { EmailCategory } from "./email-quota";

/**
 * F5 email throttles (spec §12 line 347): a 30-minute cooldown for the same
 * financial alert rule/instrument, a 5 rps Resend token bucket, and Quiet Hours
 * that hold ONLY the financial channel — account security mail and the in-app
 * inbox are never held.
 */
export const FINANCIAL_EMAIL_COOLDOWN_MS = 30 * 60_000;

export function financialCooldownActive(lastSentAtMs: number | undefined, now: number): boolean {
  return lastSentAtMs !== undefined && now - lastSentAtMs < FINANCIAL_EMAIL_COOLDOWN_MS;
}

export function quietHoursHoldsFinancial(category: EmailCategory, inQuietHours: boolean): boolean {
  return category === "financial" && inQuietHours;
}

/** A simple 5 rps token bucket for the Resend dispatch loop (fixed-clock deterministic). */
export class TokenBucket {
  #tokens: number;
  #lastRefillMs: number;

  constructor(
    private readonly capacity: number = 5,
    private readonly refillPerSecond: number = 5,
    startMs = 0,
  ) {
    this.#tokens = capacity;
    this.#lastRefillMs = startMs;
  }

  tryTake(now: number): boolean {
    const elapsedSeconds = Math.max(0, (now - this.#lastRefillMs) / 1000);
    this.#tokens = Math.min(this.capacity, this.#tokens + elapsedSeconds * this.refillPerSecond);
    this.#lastRefillMs = now;
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return true;
    }
    return false;
  }
}
