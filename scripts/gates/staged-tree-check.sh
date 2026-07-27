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
# CI 대응물 (2026-07-27, OF-5): 훅은 로컬 산물이라 `--no-verify`·훅 미설치 클론·웹 UI
# 커밋은 이 게이트를 통째로 지나친다. tier-gate 가 같은 이유로 `--range` 를 받은 것과
# 같은 결함이고 같은 방식으로 닫는다 — 범위의 **각 커밋**을 꺼내 typecheck·lint 를 돈다.
# 로컬 모드가 "이 커밋의 트리"를 보는 것을 원격에서는 "들어오는 모든 커밋의 트리"로 넓힌다.
#
# 사용:
#   sh scripts/gates/staged-tree-check.sh                 # 인덱스를 꺼내 검사
#   sh scripts/gates/staged-tree-check.sh --range A..B    # 범위의 각 커밋 트리를 검사 (CI)
#   sh scripts/gates/staged-tree-check.sh --tree-dir DIR  # 준비된 트리를 검사 (음성 대조군용 seam)
set -eu

REPO=$(git rev-parse --show-toplevel)

# 트리 하나를 검사한다. 이 함수가 이 게이트의 전부이며 세 모드가 전부 이것을 부른다.
check_tree() { # check_tree <디렉터리> <라벨>
  _dir=$1
  _label=$2
  [ -e "$_dir/node_modules" ] || ln -s "$REPO/node_modules" "$_dir/node_modules"
  _rc=0
  if ! (cd "$_dir" && npx tsc --noEmit); then
    echo "staged-tree-check: $_label 이 typecheck 를 통과하지 못한다" >&2
    _rc=1
  fi
  if ! (cd "$_dir" && npx eslint .); then
    echo "staged-tree-check: $_label 이 lint 를 통과하지 못한다" >&2
    _rc=1
  fi
  return "$_rc"
}

if [ "${1:-}" = "--range" ]; then
  RANGE="${2:-}"
  if [ -z "$RANGE" ]; then
    echo "staged-tree-check: --range 에 커밋 범위가 필요하다" >&2
    exit 1
  fi
  # 나쁜 입력에 fail-open 하지 않는다 — tier-gate 가 codex #4 로 배운 것과 같은 규율.
  if ! SHAS=$(git rev-list --reverse "$RANGE" 2>&1); then
    echo "staged-tree-check: --range '$RANGE' 를 해석할 수 없다 — 범위를 못 읽으면 통과시키지 않는다" >&2
    echo "$SHAS" >&2
    exit 1
  fi
  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT INT TERM
  RC=0
  CHECKED=0
  MAX=20
  for sha in $SHAS; do
    # 정적 층에 영향을 줄 수 없는 커밋은 건너뛴다. 문서·셸 스크립트만 바꾼 커밋의 트리는
    # 앞 커밋의 트리와 typecheck·lint 관점에서 동일하다. 무엇을 건너뛰었는지는 찍는다 —
    # 조용한 축소는 "전부 검사했다"로 읽힌다.
    touched=$(git diff-tree --no-commit-id --name-only -r "$sha" \
      | grep -E '\.(ts|tsx|mjs|cjs|js|json)$|^tsconfig|^eslint\.config' || true)
    if [ -z "$touched" ]; then
      echo "staged-tree-check: $sha — 정적 층에 영향 없는 변경(건너뜀)"
      continue
    fi
    CHECKED=$((CHECKED + 1))
    if [ "$CHECKED" -gt "$MAX" ]; then
      echo "staged-tree-check: 검사 대상 커밋이 $MAX 개를 넘었다 — 범위를 좁혀서 다시 돌려라." >&2
      echo "  조용히 자르지 않는다: 자르면 '전부 검사했다'로 읽힌다." >&2
      exit 1
    fi
    dir="$WORK/$sha"
    mkdir -p "$dir"
    git archive "$sha" | tar -x -C "$dir"
    if ! check_tree "$dir" "$sha"; then RC=1; fi
    rm -rf "$dir"
  done
  echo "staged-tree-check: $CHECKED 개 커밋 트리 검사 (범위 $RANGE)"
  exit "$RC"
fi

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
RC=0
check_tree "$TREE_DIR" "스테이지된 트리" || RC=1

if [ "$RC" -ne 0 ]; then
  echo "" >&2
  echo "고치는 법: 빠진 대응까지 stage 하거나, 그 대응을 요구하는 변경(설정 플래그 등)을 뒤 커밋으로 미룬다." >&2
  exit 1
fi
echo "staged-tree-check: 스테이지된 트리 typecheck·lint 통과"
