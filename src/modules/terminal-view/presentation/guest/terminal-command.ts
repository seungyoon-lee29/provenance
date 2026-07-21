/**
 * 명령창 입력 해석 (ticket 37). `/api/market`의 심볼 allowlist와 **같은 경계**를 쓴다 — 라우트가
 * 유일한 방어층이면 UI는 거절 사유를 알 수 없고, 사용자는 "왜 안 되는지" 없이 실패만 본다.
 */
export type TerminalCommand =
  | Readonly<{ kind: "symbol"; symbol: string }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "invalid" }>;

const SYMBOL_PATTERN = /^[A-Za-z0-9.]{1,12}$/;

export function parseTerminalCommand(input: string): TerminalCommand {
  const text = input.trim();
  if (text.length === 0) return { kind: "empty" };
  if (!SYMBOL_PATTERN.test(text)) return { kind: "invalid" };
  // 대문자 정규화: kospi와 KOSPI는 같은 조회다. 숫자 코드(005930)는 그대로 남는다.
  return { kind: "symbol", symbol: text.toUpperCase() };
}
