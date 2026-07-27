import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

/**
 * 정적 층 — A 그룹(조용히 틀린 값)을 타입 인지 린트로 잡는다.
 *
 * 2026-07-27 (arch-2) 이전에는 @typescript-eslint 규칙이 **0개**였다. next/core-web-vitals
 * 는 React·접근성 규칙이라 "런타임에 조용히 틀린 값이 흐른다"는 계열을 하나도 보지 않는다.
 *
 * 과대 서술 금지: 여기 켠 규칙 중 **A1~A4 를 소급해서 잡았을 것은 없다.** 이 층이 하는 일은
 * 같은 *형태*(순서·연결·소진되지 않은 유니언·사라진 비동기)가 새로 들어오는 것을 막는 것이다.
 * 실제로 도입 즉시 세 건을 잡았다 — 미await 된 돈 보존 property, 워커의 미처리 rejection,
 * `Array.isArray` 가 `any[]` 로 좁혀 타입 검사가 무력화된 백테스트 Act 루프.
 *
 * 프리셋(strictTypeChecked) 통째로 켜지 않는다 — 수백 건이 나오고 그 다음 수순은 항상
 * 일괄 disable 이며, 그건 게이트가 아니라 연극이다. 이 저장소가 실제로 앓은 실패 형태에
 * 대응하는 규칙만 켜고, 켠 것은 전부 error 로 집행한다.
 */
export default defineConfig([
  ...nextVitals,
  globalIgnores([
    ".next/**",
    "coverage/**",
    "dist/**",
    "playwright-report/**",
    "test-results/**",
    // 고의로 나쁜 코드 — 규칙이 실제로 걸리는지 실증하는 음성 대조군 픽스처다.
    // scripts/gates/negative-control.sh 가 `--no-ignore` 로 집어 본다.
    "tests/fixtures/lint-negative-control.fixture.ts",
  ]),
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── 조용히 틀린 값이 흐르는 자리 ──────────────────────────────────────
      // `[3, 20, 100].sort()` 는 사전순이다. A1/A2 가 앓은 것과 같은 병(시간·수치를
      // 문자열 순서로 비교)이 배열 정렬 쪽에 나 있는 형태.
      "@typescript-eslint/require-array-sort-compare": "error",
      // `"total: " + count` 류의 조용한 문자열 결합.
      // `allowNumberAndString` 기본값이 **true** 라 옵션 없이 켜면 이 형태를 안 잡는다.
      // 저장소 전체 발견 0건이라 눈치챌 수 없었고, 음성 대조군 픽스처가 잡았다
      // (2026-07-27) — "규칙을 켰다"와 "규칙이 그 일을 한다"는 다르다.
      "@typescript-eslint/restrict-plus-operands": ["error", { allowNumberAndString: false }],
      // `${obj}` 가 "[object Object]" 로 새는 것 — 로그·에러 메시지에서 특히.
      "@typescript-eslint/no-base-to-string": "error",
      // 유니언에 멤버가 늘었는데 switch 가 안 따라온 드리프트. coverage 유니언
      // (unavailable 계열)을 쓰는 저장소라 직접적이다.
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // no-unnecessary-condition 은 **의도적으로 켜지 않았다**. 실측(2026-07-27) 22건 중
      // 상당수가 죽은 가드가 아니라 **신뢰 경계의 런타임 백스톱**이었다:
      //   · credential-vault.ts:38 `envelope.schemaVersion !== 1` — envelope 는 영속
      //     저장소에서 오는데 타입은 리터럴 1 이라고 주장한다. 타입이 거짓말한다.
      //   · journal.ts:556 — 주석이 "Runtime backstop for untyped callers" 라고 명시.
      // 이 상태로 error 를 켜면 규칙이 시키는 일은 "진짜 검증을 지워라" 다. 그건 이 저장소가
      // 고치고 있는 병(검사를 못 하는 상태를 통과로 읽음)을 정적 층에 새로 만드는 것이다.
      // 진짜 수정은 규칙이 아니라 타입이다 — 영속·외부 입력을 `unknown` 으로 받아 파싱하면
      // 가드가 필요해지고 규칙도 조용해진다(parse, don't assert). 그때 켠다.
      // 부채: src 16건 / tests 6건, 2026-07-27 실측. 후속 티켓.

      // ── 조용히 사라지는 비동기 ────────────────────────────────────────────
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    // ── any 를 통해 타입 검사가 무력화되는 자리 ─────────────────────────────
    // 프로덕션 코드에만 집행한다. 실측 (2026-07-27): src 19건 / tests+scripts 192건.
    // 테스트·스크립트의 192건은 대부분 JSON·프로세스 출력을 파싱해 단언하는 자리라
    // 성격이 다르다 — 여기서 같이 켜면 남는 수순은 일괄 disable 이고, 그건 규칙이
    // 있다는 외관만 만든다. 좁게 켜서 실제로 집행되는 쪽을 택했다.
    // 부채: 테스트의 any 경계는 `as` → shoehorn 마이그레이션과 함께 다룰 별건.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
    },
  },
]);
