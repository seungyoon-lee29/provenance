import { describe, expect, it } from "vitest";

import { withRequestSpacing } from "../src/modules/financial-information/data/kis-market-information";
import type { KisClock, KisHttp, KisHttpRequest } from "../src/modules/financial-information/data/kis-market-information";

// Ticket 34 — KIS 모의 API는 초당 호출 수를 제한한다(실측: 3심볼 동시 요청 → 1건 upstream 실패).
// 모든 KIS 호출은 주입된 KisHttp 하나를 통과하므로, 호출부마다가 아니라 그 경계에서 간격을 준다.

/** Fake clock: sleep advances `now` so the spacing is deterministic and the suite stays network-off. */
function fakeClock(): KisClock & { readonly elapsed: () => number } {
  let now = 1_000;
  return {
    now: () => now,
    sleep: async (durationMs: number) => {
      now += durationMs;
    },
    elapsed: () => now - 1_000,
  };
}

function request(url: string): KisHttpRequest {
  return { method: "GET", url, headers: {} };
}

describe("withRequestSpacing (34)", () => {
  it("spaces concurrent calls by at least the minimum interval", async () => {
    const clock = fakeClock();
    const calledAt: number[] = [];
    const inner: KisHttp = async (req) => {
      calledAt.push(clock.now());
      return { status: 200, json: { url: req.url } };
    };
    const spaced = withRequestSpacing(inner, { minIntervalMs: 500, clock });

    const responses = await Promise.all([spaced(request("/a")), spaced(request("/b")), spaced(request("/c"))]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(calledAt.length).toBe(3);
    expect(calledAt[1]! - calledAt[0]!).toBeGreaterThanOrEqual(500);
    expect(calledAt[2]! - calledAt[1]!).toBeGreaterThanOrEqual(500);
  });

  it("keeps request order (first submitted, first sent)", async () => {
    const clock = fakeClock();
    const seen: string[] = [];
    const inner: KisHttp = async (req) => {
      seen.push(req.url);
      return { status: 200, json: {} };
    };
    const spaced = withRequestSpacing(inner, { minIntervalMs: 400, clock });

    await Promise.all([spaced(request("/1")), spaced(request("/2")), spaced(request("/3"))]);

    expect(seen).toEqual(["/1", "/2", "/3"]);
  });

  it("does not wait when calls are already further apart than the interval", async () => {
    const clock = fakeClock();
    const inner: KisHttp = async () => ({ status: 200, json: {} });
    const spaced = withRequestSpacing(inner, { minIntervalMs: 500, clock });

    await spaced(request("/a"));
    await clock.sleep(900); // caller idles longer than the interval
    const before = clock.now();
    await spaced(request("/b"));

    expect(clock.now()).toBe(before); // no artificial delay was added
  });

  it("a rejected call does not wedge the queue", async () => {
    const clock = fakeClock();
    const seen: string[] = [];
    const inner: KisHttp = async (req) => {
      seen.push(req.url);
      if (req.url === "/boom") throw new Error("socket closed");
      return { status: 200, json: {} };
    };
    const spaced = withRequestSpacing(inner, { minIntervalMs: 300, clock });

    const failing = spaced(request("/boom"));
    const following = spaced(request("/after"));

    await expect(failing).rejects.toThrow("socket closed");
    await expect(following).resolves.toEqual({ status: 200, json: {} });
    expect(seen).toEqual(["/boom", "/after"]);
  });

  it("keeps the whole fan-out inside the data deadline for a full panel of symbols", async () => {
    const clock = fakeClock();
    const inner: KisHttp = async () => ({ status: 200, json: {} });
    const spaced = withRequestSpacing(inner, { minIntervalMs: 500, clock });

    await Promise.all(Array.from({ length: 8 }, (_, index) => spaced(request(`/s${index}`))));

    expect(clock.elapsed()).toBeLessThan(10_000); // §11.3 10s self-guarantee
  });
});
