import { describe, expect, it } from "vitest";

import { blockedReason } from "../scripts/verify-network-off";
import { releaseGitLane } from "./release/git-lane";

/**
 * 음성 대조군 — TS 술어 형태의 게이트 편 (셸 게이트 편은 scripts/gates/negative-control.sh).
 *
 * 이 두 술어는 arch-2 B 그룹의 2번·3번 결함이 살던 자리다. 고쳐지긴 했지만 판별력 실증이
 * 손으로 한 번 돌려본 일회성 프로브로만 남아 있었다 — 즉 **회귀를 잡을 것이 없었다.**
 * 나중에 누가 catch-all 로 되돌리면 두 게이트는 조용히 다시 "무엇이든 통과"가 된다.
 *
 * 여기서 고정하는 성질은 하나다: **차단의 증거가 되는 실패만 차단으로 센다.**
 * 반증 케이스(TLS 실패·URL 오타·프로그래밍 오류)가 통과로 읽히기 시작하면 red.
 */

describe("blockedReason — egress 차단의 증거가 되는 실패만 인정한다", () => {
  // 차단된 런타임이 실제로 내는 형태. fetch 는 진짜 실패를 `cause` 로 감싸고,
  // 여러 주소를 시도하면 AggregateError 로 묶는다.
  const dnsRefused = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND example.com"), { code: "ENOTFOUND" }),
  });
  const routeRefused = Object.assign(new TypeError("fetch failed"), {
    cause: new AggregateError(
      [Object.assign(new Error("connect ECONNREFUSED 93.184.216.34:443"), { code: "ECONNREFUSED" })],
      "",
    ),
  });
  const aborted = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

  it.each([
    ["DNS 미해결 (ENOTFOUND)", dnsRefused],
    ["연결 거부 (AggregateError 안의 ECONNREFUSED)", routeRefused],
    ["경로 드롭 → abort", aborted],
  ])("%s 는 차단으로 인정한다", (_label, error) => {
    expect(blockedReason(error)).toBeDefined();
  });

  // 아래는 전부 **완전히 열린 네트워크에서도 똑같이 일어나는** 실패다. 이것들이 차단으로
  // 읽히면 게이트는 무엇도 증명하지 못한다 — 하네스가 오타로 죽어도 초록이 된다.
  it.each([
    ["TLS 검증 실패", Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
    })],
    ["URL 오타 (파싱 실패)", new TypeError("Failed to parse URL from htp://example.com/x")],
    ["하네스 자신의 프로그래밍 오류", new ReferenceError("harness is not defined")],
    ["문자열 throw", "boom"],
    ["undefined throw", undefined],
  ])("%s 는 차단의 증거가 아니다", (_label, error) => {
    expect(blockedReason(error)).toBeUndefined();
  });
});

describe("releaseGitLane — 커버리지 축소는 선언돼야 하고 조용히 일어나면 안 된다", () => {
  const withoutGit = <T>(env: Record<string, string | undefined>, run: () => T): T => {
    const savedPath = process.env.PATH;
    const savedDeclaration = process.env.RELEASE_LANE_WITHOUT_GIT;
    process.env.PATH = "/nonexistent-so-git-cannot-resolve";
    if (env.RELEASE_LANE_WITHOUT_GIT === undefined) delete process.env.RELEASE_LANE_WITHOUT_GIT;
    else process.env.RELEASE_LANE_WITHOUT_GIT = env.RELEASE_LANE_WITHOUT_GIT;
    try {
      return run();
    } finally {
      process.env.PATH = savedPath;
      if (savedDeclaration === undefined) delete process.env.RELEASE_LANE_WITHOUT_GIT;
      else process.env.RELEASE_LANE_WITHOUT_GIT = savedDeclaration;
    }
  };

  // 이 케이스의 전제는 이름 그대로 "git 이 있으면" 이다. `.git` 이 빠진 이미지에서
  // 도는 레인(compose pr-check)은 그 전제를 만족하지 않고, 자기 부재를 이미
  // RELEASE_LANE_WITHOUT_GIT 로 선언해 둔다 — 그 선언을 여기서도 존중한다.
  // 조용한 skip 이 아니다: 선언이 없는데 git 도 없으면 아래 두 케이스가 시끄럽게 잡는다.
  it.skipIf(process.env.RELEASE_LANE_WITHOUT_GIT === "1")("git 이 있으면 릴리스 스위트를 돌린다", () => {
    expect(releaseGitLane()).toBe(true);
  });

  it("git 이 없는데 선언도 없으면 시끄럽게 실패한다 (조용한 skip 금지)", () => {
    expect(() => withoutGit({ RELEASE_LANE_WITHOUT_GIT: undefined }, releaseGitLane))
      .toThrow(/RELEASE_LANE_WITHOUT_GIT/);
  });

  it("선언된 레인에서만 축소를 허용한다", () => {
    expect(withoutGit({ RELEASE_LANE_WITHOUT_GIT: "1" }, releaseGitLane)).toBe(false);
  });
});
