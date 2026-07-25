#!/bin/sh
# 게이트 생존성 검사 — "선언만 있고 안 도는 게이트"와 "돌 수 없는 레인 등록"을 커밋 레벨에서 잡는다.
#
# 계기 (2026-07-26, arch-1): 세 가지가 같은 뿌리였다.
#   · stryker 가 스스로를 regression gate 라 부르면서 CI·훅 어디에도 없었다
#   · test:persistence-pg 가 이름 변경 후 나흘간 실행 불가였는데 아무도 몰랐다
#   · 실행해볼 수 없는 레인에 테스트 파일이 등록됐다 (그 파일의 케이스는 켜도 무조건 실패였다)
# 공통점은 "게이트가 실제로 도는지를 아무도 안 본다" 이고, 그건 사람이 아니라 기계가 볼 일이다.
#
# 이 검사는 네트워크·도커 없이 돈다. pre-commit 에서 싼 축에 속한다.
set -eu

# GATE_LEDGER override 는 이 게이트 자신의 판별력을 실증하기 위한 것이다 — 위조 원장으로
# 돌려 실제로 red 가 되는지 확인할 수 있어야 통과가 의미를 갖는다.
LEDGER="${GATE_LEDGER:-scripts/gates/gate-ledger.txt}"
FAIL=0

fail() {
  echo "gate-liveness: $1" >&2
  FAIL=1
}

# ── 1) 훅·CI 가 부르는 npm 스크립트가 실제로 존재하는가 (stale reference) ────────────
# `npm run <name>` 형태만 본다 — 존재하지 않는 스크립트를 부르는 훅/CI 는 조용히 no-op 이 아니라
# 실패하지만, 실패가 다른 이유로 읽히기 쉽다. 이름이 사라진 순간 여기서 잡는다.
for src in .husky/pre-commit .husky/commit-msg .husky/pre-push .github/workflows/ci.yml; do
  [ -f "$src" ] || continue
  # shellcheck disable=SC2013
  for script in $(grep -oE 'npm run [a-z][a-z0-9:-]*' "$src" | sed 's/^npm run //' | sort -u); do
    if ! grep -q "\"$script\":" package.json; then
      fail "$src 가 존재하지 않는 npm 스크립트를 부른다: $script"
    fi
  done
done

# ── 2) PG 레인에 등록된 파일이 존재하고 실제로 PG 게이팅돼 있는가 ─────────────────────
# 게이팅 없는 파일이 이 레인에 들어오면 기본 레인에서 이미 돌던 것을 중복 실행하거나,
# 반대로 PG 없이는 통과 불가능한 케이스가 조용히 skip 된 채 "커버됨" 으로 읽힌다.
PG_LANE=$(grep -o '"test:persistence-pg": "[^"]*"' package.json | sed 's/.*vitest run //; s/"$//')
for f in $PG_LANE; do
  case "$f" in
    tests/*) ;;
    *) continue ;;
  esac
  if [ ! -f "$f" ]; then
    fail "test:persistence-pg 가 없는 파일을 등록했다: $f"
  elif ! grep -q 'PG_INTEGRATION' "$f"; then
    fail "$f 는 PG_INTEGRATION 게이팅이 없는데 PG 레인에 등록됐다 (기본 레인 중복 또는 영구 skip)"
  fi
done

# ── 3) 게이트 배선 원장과 실제 배선이 일치하는가 ──────────────────────────────────────
if [ ! -f "$LEDGER" ]; then
  fail "$LEDGER 이 없다 — 게이트 원장 없이는 배선 드리프트를 볼 수 없다"
else
  # 3a) package.json 의 게이트성 스크립트가 전부 원장에 있는가 (새 게이트 몰래 들이기 방지)
  for script in $(grep -oE '"(test|verify|check):[a-z0-9:-]*"' package.json | tr -d '"' | sort -u); do
    if ! grep -q "^$script[[:space:]]" "$LEDGER"; then
      fail "$script 가 $LEDGER 에 없다 — wired:<파일> 또는 unwired:<이유> 로 선언하라"
    fi
  done
  # `check` 는 접두사 규칙에 안 걸리는 이름이라 따로 확인한다 (가장 중요한 게이트다)
  grep -q '^check[[:space:]]' "$LEDGER" || fail "check 가 $LEDGER 에 없다"

  # 3b) wired: 로 선언한 게이트가 그 파일에서 실제로 참조되는가 (배선이 끊기면 잡힌다)
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    script=$(printf '%s' "$line" | awk '{print $1}')
    target=$(printf '%s' "$line" | awk '{print $2}')
    case "$target" in
      wired:*) ;;
      *) continue ;;
    esac
    file=${target#wired:}
    if [ ! -f "$file" ]; then
      fail "$script 가 $file 에 배선됐다고 선언했으나 그 파일이 없다"
    elif ! grep -q "$script" "$file"; then
      fail "$script 의 배선이 끊겼다 — $file 에서 참조가 사라졌다 (원장을 고치거나 배선을 복구하라)"
    fi
  done < "$LEDGER"
fi

[ "$FAIL" -eq 0 ] || {
  echo "" >&2
  echo "게이트가 실행되지 않으면 그건 게이트가 아니다. 배선을 고치거나, 못 고치면" >&2
  echo "$LEDGER 에 unwired:<이유> 로 부채를 남겨라 — 조용히 지나가는 것만 막는다." >&2
  exit 1
}
