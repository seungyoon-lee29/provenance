import { describe, expect, it } from "vitest";

import { parseTerminalCommand } from "../src/modules/terminal-view/presentation/guest/terminal-command";

// Ticket 37 — 명령창은 지금까지 문구만 세팅하는 stub이었다. 입력 해석은 순수 함수로 떼어
// network-off로 고정한다: 전송 전에 거절할 것은 여기서 거절해야 라우트가 방어의 유일한 층이 아니다.

describe("parseTerminalCommand (37)", () => {
  it("uppercases a ticker so kospi와 KOSPI가 같은 조회가 된다", () => {
    expect(parseTerminalCommand(" kospi ")).toEqual({ kind: "symbol", symbol: "KOSPI" });
  });

  it("keeps a numeric KRX code as typed", () => {
    expect(parseTerminalCommand("005930")).toEqual({ kind: "symbol", symbol: "005930" });
  });

  it("treats an empty input as nothing to do (조회를 만들지 않는다)", () => {
    expect(parseTerminalCommand("   ")).toEqual({ kind: "empty" });
  });

  it("rejects anything the market route would reject — 경계 밖 문자·길이", () => {
    expect(parseTerminalCommand("005930; drop")).toEqual({ kind: "invalid" });
    expect(parseTerminalCommand("../etc/passwd")).toEqual({ kind: "invalid" });
    expect(parseTerminalCommand("A".repeat(13))).toEqual({ kind: "invalid" });
  });

  it("accepts the route's full allowlist (12자·점 포함)", () => {
    expect(parseTerminalCommand("brk.b")).toEqual({ kind: "symbol", symbol: "BRK.B" });
    expect(parseTerminalCommand("a".repeat(12))).toEqual({ kind: "symbol", symbol: "A".repeat(12) });
  });
});
