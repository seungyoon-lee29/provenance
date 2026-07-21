import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // `server-only`는 클라이언트 번들 유입을 막는 빌드 가드일 뿐 런타임 동작이 없다. 노드 테스트에서는
  // 빈 모듈로 갈음해 composition·registry 같은 server-only 모듈도 단위 테스트할 수 있게 한다.
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./tests/setup/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup/fast-check.ts"],
    restoreMocks: true,
  },
});
