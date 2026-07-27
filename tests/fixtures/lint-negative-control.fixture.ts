/**
 * 린트 게이트의 음성 대조군 픽스처 — 고의로 나쁜 코드다. 고치지 말 것.
 *
 * eslint.config.mjs 가 켠 타입 인지 규칙 중 넷은 저장소 전체에서 **발견 0건**이다.
 * 그건 좋은 소식일 수도 있고, 규칙이 아예 안 돌고 있다는 뜻일 수도 있다 — 둘의 출력은
 * 완전히 같다. 이 저장소가 고치고 있는 결함(통과와 '검사를 못 함'의 미구분)이 정적 층에
 * 그대로 재현되는 자리라, 여기 알려진 나쁜 입력을 두고 실제로 걸리는지 확인한다.
 * 검증: scripts/gates/negative-control.sh.
 *
 * 규율: **타입은 유효하고 린트만 틀려야 한다.** tsconfig 의 include 가 이 파일도 잡으므로
 * 타입 오류를 넣으면 게이트가 아니라 저장소가 빨개진다.
 * `eslint .` 에서는 globalIgnores 로 빠져 있고, 대조군만 `--no-ignore` 로 집어 본다.
 */

/** require-array-sort-compare — 비교자 없는 sort 는 사전순이다: [100, 20, 3] */
export function sortsWithoutComparator(): number[] {
  return [3, 20, 100].sort();
}

/** restrict-plus-operands — 숫자와 문자열의 조용한 결합 */
export function concatenatesNumberAndString(count: number): string {
  return "total: " + count;
}

/** no-base-to-string — "[object Object]" 로 새는 자리 */
export function stringifiesAnObject(value: { amount: number }): string {
  return `value=${value}`;
}

/** switch-exhaustiveness-check — 유니언에 멤버가 늘었는데 switch 가 안 따라온 드리프트 */
type Coverage = Readonly<{ kind: "covered" }> | Readonly<{ kind: "unavailable" }>;
export function missesAUnionMember(coverage: Coverage): string {
  switch (coverage.kind) {
    case "covered":
      return "ok";
  }
  return "unhandled";
}

/** no-floating-promises — 아무도 안 받는 Promise (실패가 조용히 사라진다) */
export function dropsAPromise(): void {
  Promise.resolve(1);
}

/** await-thenable — Promise 가 아닌 값에 대한 await */
export async function awaitsANonPromise(): Promise<number> {
  return await 1;
}

/** no-misused-promises — void 를 기대하는 자리에 async 콜백 */
export function passesAsyncWhereVoidExpected(items: readonly number[]): void {
  items.forEach(async (item) => {
    await Promise.resolve(item);
  });
}

/** no-unused-vars — 지워진 코드가 남긴 죽은 import·지역 심볼.
 * 2026-07-27 라운드 5 가 실물로 잡았다: 집계 검사를 공유 함수로 옮기면서 그 검사의
 * 유일한 사용처였던 import 가 남았고 `npm run check` 는 초록이었다. */
import { isExactMinor } from "../../src/modules/paper-trading/internal/contracts";

export function leavesDeadLocals(value: number): number {
  const neverRead = value * 2;
  return value;
}
