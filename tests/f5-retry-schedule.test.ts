import { describe, expect, it } from "vitest";

import { nextRetry } from "../src/modules/notification-center/retry-schedule";

const FIRST = 1_000_000; // arbitrary epoch ms
const HOUR = 3_600_000;

describe("nextRetry — financial schedule (spec §12 line 348)", () => {
  const farDeadline = FIRST + 100 * HOUR;
  it("sends attempt 0 immediately", () => {
    expect(nextRetry("financial", 0, FIRST, farDeadline)).toEqual({ action: "send", atMs: FIRST });
  });
  it("follows immediate/30s/2m/10m/30m/90m", () => {
    const delays = [0, 30_000, 120_000, 600_000, 1_800_000, 5_400_000];
    delays.forEach((d, attempt) => {
      expect(nextRetry("financial", attempt, FIRST, farDeadline)).toEqual({ action: "send", atMs: FIRST + d });
    });
  });
  it("stops after 6 attempts", () => {
    expect(nextRetry("financial", 6, FIRST, farDeadline)).toEqual({ action: "stop", reason: "max_attempts" });
  });
  it("stops when the scheduled time is past the deadline (TTL or 2h, earlier)", () => {
    // deadline 1h in: the 90m attempt is past it.
    const deadline = FIRST + HOUR;
    expect(nextRetry("financial", 4, FIRST, deadline)).toEqual({ action: "send", atMs: FIRST + 1_800_000 });
    expect(nextRetry("financial", 5, FIRST, deadline)).toEqual({ action: "stop", reason: "deadline" });
  });
  it("caps at 2h even if the TTL is later", () => {
    const deadline = FIRST + 5 * HOUR; // TTL far, but 2h cap applies
    // 90m (attempt 5) is within 2h so it sends; there is no attempt 6 anyway.
    expect(nextRetry("financial", 5, FIRST, deadline)).toEqual({ action: "send", atMs: FIRST + 5_400_000 });
  });
});

describe("nextRetry — account schedule (spec §12 line 348)", () => {
  const farDeadline = FIRST + 100 * HOUR;
  it("follows immediate/5s/30s/2m/10m/30m/2h/6h", () => {
    const delays = [0, 5_000, 30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000];
    delays.forEach((d, attempt) => {
      expect(nextRetry("account", attempt, FIRST, farDeadline)).toEqual({ action: "send", atMs: FIRST + d });
    });
  });
  it("stops after 8 attempts", () => {
    expect(nextRetry("account", 8, FIRST, farDeadline)).toEqual({ action: "stop", reason: "max_attempts" });
  });
});

describe("nextRetry — 429 Retry-After override", () => {
  it("does not send before the Retry-After instant even if the schedule is earlier", () => {
    const farDeadline = FIRST + 100 * HOUR;
    const notBefore = FIRST + 45_000; // provider asked to wait 45s from the first attempt
    // attempt 1 is scheduled at +30s but Retry-After pushes it to +45s.
    expect(nextRetry("financial", 1, FIRST, farDeadline, notBefore)).toEqual({ action: "send", atMs: notBefore });
  });
  it("keeps the schedule when it is already later than Retry-After", () => {
    const farDeadline = FIRST + 100 * HOUR;
    const notBefore = FIRST + 10_000;
    expect(nextRetry("financial", 1, FIRST, farDeadline, notBefore)).toEqual({ action: "send", atMs: FIRST + 30_000 });
  });
  it("still stops if the Retry-After instant is past the deadline", () => {
    const deadline = FIRST + 20_000;
    const notBefore = FIRST + 60_000;
    expect(nextRetry("financial", 1, FIRST, deadline, notBefore)).toEqual({ action: "stop", reason: "deadline" });
  });
});
