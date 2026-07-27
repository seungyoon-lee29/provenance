#!/bin/sh
# provider contract 테스트 수동 레인 — 실제 외부 API 를 때린다.
#
# 계기 (2026-07-27): `.env.local` 에 KIS·DART 키가 들어 있는데도 contract 테스트 5개가
# 한 번도 안 돌았다. 3중으로 막혀 있었다:
#   1. **vitest 는 .env 파일을 로드하지 않는다.** Vite 가 .env 를 읽어도 VITE_ 접두사만
#      다루고 process.env 에는 안 넣으며, 이 저장소엔 dotenv 의존성이 없다.
#      실증: 테스트 프로세스에서 DART_API_KEY·KIS_APP_KEY 가 전부 미설정.
#   2. 게이트 변수 `*_CONTRACT` 는 .env.local 에도 없다. 거기 있는 RUN_KIS_PAPER_READ_CONTRACT
#      는 src/composition/runtime-policy.ts 의 **런타임 플래그**로 이름만 비슷한 다른 것이다.
#   3. 그리고 아무 게이트도 이 사실을 말하지 않았다 — 출력은 초록이었다.
# 1·2 를 이 스크립트가 닫고, 3 은 gate-ledger.txt 의 skip 레인 선언(검사 5)이 닫는다.
#
# CI 에는 배선하지 않는다 — 모든 CI job 은 provider secret 없이 도는 것이 정책(SEC-05)이고
# 외부 egress 부재는 network-off 하네스가 증명한다. 여기는 사람이 손으로 켜는 레인이다.
#
# 사용: npm run test:contract [-- <vitest 인자>]
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE="$ROOT/.env.local"

[ -f "$ENV_FILE" ] || {
  echo "test:contract: $ENV_FILE 이 없다 — provider 키 없이는 실 API 계약을 볼 수 없다." >&2
  echo "  .env.example 를 복사해 키를 채운 뒤 다시 실행하라." >&2
  exit 1
}

# 값은 셸 환경으로만 흘리고 어디에도 출력하지 않는다.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# 게이트 변수는 .env.local 이 아니라 여기서 켠다. 파일에 적어 두면 다른 레인이 실 API 를
# 우연히 켜게 되고, 그건 network-off 결정론 전제를 조용히 깨뜨린다.
DART_CONTRACT=1 ECB_CONTRACT=1 KIS_CONTRACT=1 TREASURY_CONTRACT=1 \
  exec npx vitest run "$ROOT"/tests/*.contract.test.ts "$@"
