#!/bin/sh
# 스테이지된 트리 검증 — 훅이 통과시킨 것이 정말 "이 커밋"인지 본다. (2026-07-27)
#
# 계기 (실측): `.husky/pre-commit` 의 `npm run check` 는 **워크트리**를 검사한다. 워크트리와
# 인덱스가 같으면 그것이 곧 커밋될 트리지만, 다르면 초록 배지가 커밋과 무관한 상태에 붙는다.
# 이 저장소는 AGENTS.md 하한으로 "커밋은 파일 allowlist 로 stage 한다"를 요구하므로
# **부분 stage 가 예외가 아니라 표준 절차**다 — 즉 이 구멍은 드문 사고가 아니라 상시다.
#
# 2026-07-27 에 dirty 워크트리 62파일을 3커밋으로 쪼개다가 두 번 걸렸다:
#   · exactOptionalPropertyTypes 를 켠 커밋이 그 대응(journal.ts·f8 테스트)을 빼놓아
#     단독 트리에서 TS2375/TS2379 6건 — 훅은 초록이었다.
#   · 타입 인지 린트를 켠 커밋이 f8-blind-acceptance 의 await-thenable 10건을 빼놓아
#     단독 트리에서 lint red — 훅은 초록이었다.
# 둘 다 격리 worktree 에서 손으로 tsc/eslint 를 돌려서야 발견했다. 손으로 하는 검증은
# 다음 사람이 안 한다. 여기가 그 손을 대신한다.
#
# 왜 typecheck·lint 만인가: 위 두 사고를 **둘 다** 잡는 가장 싼 조합이다. 테스트까지
# 돌리면 부분 stage 커밋마다 20초가 더 붙는데, 실제로 놓친 것은 전부 정적 층이 잡는
# 종류였다. 필요해지면 그때 늘린다.
# ponytail: 인덱스가 워크트리와 같으면 통째로 건너뛴다 — 그 경우 npm run check 가 이미 정답이다.
#
# 사용:
#   sh scripts/gates/staged-tree-check.sh                 # 인덱스를 꺼내 검사
#   sh scripts/gates/staged-tree-check.sh --tree-dir DIR  # 준비된 트리를 검사 (음성 대조군용 seam)
set -eu

REPO=$(git rev-parse --show-toplevel)
TREE_DIR=""
if [ "${1:-}" = "--tree-dir" ]; then
  TREE_DIR="${2:-}"
  if [ -z "$TREE_DIR" ] || [ ! -d "$TREE_DIR" ]; then
    echo "staged-tree-check: --tree-dir 에 존재하는 디렉터리가 필요하다" >&2
    exit 1
  fi
fi

if [ -z "$TREE_DIR" ]; then
  # 인덱스 == 워크트리면 방금 돈 `npm run check` 가 곧 이 커밋의 트리다. 두 번 돌리지 않는다.
  if git diff --quiet; then
    echo "staged-tree-check: 인덱스 == 워크트리 — npm run check 가 곧 이 커밋의 트리다. 건너뛴다."
    exit 0
  fi
  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT INT TERM
  TREE_DIR="$WORK/tree"
  mkdir -p "$TREE_DIR"
  # 인덱스에 있는 것만 꺼낸다 — stage 안 된 워크트리 변경도, stage 안 된 신규 파일도
  # 이 커밋에 없으므로 여기에도 없어야 한다. 그게 이 게이트의 존재 이유다.
  git checkout-index -a -f --prefix="$TREE_DIR/"
  echo "staged-tree-check: 인덱스 != 워크트리 — 스테이지된 트리를 따로 검사한다."
fi

# node_modules 는 설치본을 빌려 쓴다(수십 초를 아낀다). 의존성 자체의 변경은 이 게이트의
# 대상이 아니다 — package.json 변경은 워크트리 쪽 `npm run check` 가 이미 본다.
[ -e "$TREE_DIR/node_modules" ] || ln -s "$REPO/node_modules" "$TREE_DIR/node_modules"

RC=0
if ! (cd "$TREE_DIR" && npx tsc --noEmit); then
  echo "staged-tree-check: 스테이지된 트리가 typecheck 를 통과하지 못한다 — 워크트리는 초록이어도 이 커밋은 아니다" >&2
  RC=1
fi
if ! (cd "$TREE_DIR" && npx eslint .); then
  echo "staged-tree-check: 스테이지된 트리가 lint 를 통과하지 못한다 — 워크트리는 초록이어도 이 커밋은 아니다" >&2
  RC=1
fi

if [ "$RC" -ne 0 ]; then
  echo "" >&2
  echo "고치는 법: 빠진 대응까지 stage 하거나, 그 대응을 요구하는 변경(설정 플래그 등)을 뒤 커밋으로 미룬다." >&2
  exit 1
fi
echo "staged-tree-check: 스테이지된 트리 typecheck·lint 통과"
