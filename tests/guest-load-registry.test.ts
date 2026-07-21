import { describe, expect, it } from "vitest";

import {
  registerGuestTerminalLoad,
  takeGuestTerminalLoad,
} from "../src/modules/terminal-view/presentation/guest/guest-load-registry";
import type { GuestTerminalLoad } from "../src/modules/terminal-view/presentation/guest/contracts";

// Ticket 36 — 로그인 화면의 패널 값은 개인(KIS) 데이터다. 그 값이 흐르는 update 핸드오프는
// 더 이상 "UUID를 아는 누구나"가 아니라 **그 세션의 계정**만 집어갈 수 있어야 한다(map line 16).

function stubLoad(): GuestTerminalLoad {
  return {
    kind: "TerminalLoad",
    initial: Promise.resolve({ requestRevision: "r1", safetyDeadlineAfterMs: 10_000, panels: [], access: [] }),
    updates: { async *[Symbol.asyncIterator]() { return; } },
    resumeIdentity: "resume-1",
    cancel() {},
  } as unknown as GuestTerminalLoad;
}

describe("guest load handoff ownership (36)", () => {
  it("hands a public load to any claimer (게스트 화면은 그대로 동작한다)", () => {
    registerGuestTerminalLoad("req-public", "rev-1", stubLoad());
    expect(takeGuestTerminalLoad("req-public", "rev-1")).toBeDefined();
  });

  it("hands a personal load only to the same account", () => {
    registerGuestTerminalLoad("req-personal", "rev-1", stubLoad(), "account:owner");
    expect(takeGuestTerminalLoad("req-personal", "rev-1", "account:owner")).toBeDefined();
  });

  it("refuses a personal load to a different account and keeps it claimable by the owner", () => {
    registerGuestTerminalLoad("req-guarded", "rev-1", stubLoad(), "account:owner");

    expect(takeGuestTerminalLoad("req-guarded", "rev-1", "account:intruder")).toBeUndefined();
    expect(takeGuestTerminalLoad("req-guarded", "rev-1")).toBeUndefined(); // 세션 없는 요청도 거절
    // 거절이 핸드오프를 소모하면 안 된다 — 정당한 소유자가 여전히 집어갈 수 있어야 한다.
    expect(takeGuestTerminalLoad("req-guarded", "rev-1", "account:owner")).toBeDefined();
  });
});
