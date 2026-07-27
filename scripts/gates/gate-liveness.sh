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

  # 3b) wired: 로 선언한 게이트가 그 파일에서 실제로 **호출**되는가 (배선이 끊기면 잡힌다)
  #
  # 판정은 `npm run <script>` 호출 형태여야 한다. 단순 substring 이던 판정이
  # 세 가지를 통과시켰다 (2026-07-27):
  #   · 자기참조 — `check:pr wired:package.json` 은 package.json 안의 자기 **정의**
  #     `"check:pr": "..."` 에 매칭돼 영원히 통과했다. 정의는 배선의 증거가 아니다.
  #   · 접두사 충돌 — `check` 가 `check:pr`·`check:f1` 에 매칭된다.
  #   · 주석 — 파일 주석에 이름만 적어도 통과했다. `.husky/pre-commit` 은 이 구멍을
  #     알고 "주석에 스크립트 이름을 쓰지 않는다" 는 규율로 피하고 있었다. 규율로
  #     지키는 불변식은 게이트가 아니므로 아래 주석 제외로 기계화했다.
  # compose.yaml 의 `command: ["npm", "run", "x"]` 도 같은 규칙으로 보기 위해
  # 따옴표·쉼표·대괄호를 제거해 `npm run x` 로 정규화한 뒤 본다.
  wired_call() {
    tr -d '",[]' < "$2" | grep -v '^[[:space:]]*#' | grep -qE "npm run $1([^A-Za-z0-9:_-]|$)"
  }
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    script=$(printf '%s' "$line" | awk '{print $1}')
    target=$(printf '%s' "$line" | awk '{print $2}')
    # 경로 형태의 1열은 테스트 skip 레인 선언이다 — 검사 5 가 본다.
    case "$script" in */*) continue ;; esac
    case "$target" in
      wired:*|advisory:*) ;;
      *) continue ;;
    esac
    file=${target#*:}
    if [ ! -f "$file" ]; then
      fail "$script 가 $file 에 배선됐다고 선언했으나 그 파일이 없다"
    elif ! wired_call "$script" "$file"; then
      fail "$script 의 배선이 끊겼다 — $file 에 \`npm run $script\` 호출이 없다 (주석·자기정의는 배선이 아니다)"
    fi
  done < "$LEDGER"

  # 3c) 훅·CI 가 실제로 부르는 스크립트는 전부 원장에 있어야 한다.
  # 3a 는 이름 접두사(test/verify/check)로만 훑기 때문에 그 밖의 이름을 가진 진짜
  # 게이트를 통째로 놓친다 — `compose:verify` 가 CI 의 PR-integration 레인 전체를
  # 돌리면서 원장에 없었던 것이 실례다. "무엇이 게이트인가" 는 이름이 아니라
  # 무엇이 자동으로 실행되는가로 정해진다.
  for src in .husky/pre-commit .husky/commit-msg .husky/pre-push .github/workflows/ci.yml; do
    [ -f "$src" ] || continue
    # shellcheck disable=SC2013
    for script in $(grep -v '^[[:space:]]*#' "$src" | grep -oE 'npm run [a-z][a-z0-9:-]*' | sed 's/^npm run //' | sort -u); do
      if ! grep -q "^$script[[:space:]]" "$LEDGER"; then
        fail "$src 가 $script 를 실행하는데 $LEDGER 에 없다 — 실행되는 것은 전부 원장에 선언하라"
      fi
    done
  done
fi

# ── 4) scripts/gates/*.sh 자신이 훅·CI 에서 불리는가 ──────────────────────────────────
# 1~3 은 전부 **npm 스크립트**의 배선만 본다. 게이트 스크립트 자체는 npm 을 거치지 않고
# `sh scripts/gates/<name>.sh` 로 직접 불리므로 그 층 전체가 사각지대였다 —
# negative-control.sh 를 CI 에서 조용히 빼도 아무 검사도 red 가 되지 않는다.
# 이 저장소가 반복해서 앓은 결함("게이트가 실제로 도는지를 아무도 안 본다")의 또 다른 변주라
# 같은 방식으로 닫는다. 여기서도 판정은 주석 줄을 제외한 실제 호출 형태다.
# GATE_DIR override 는 GATE_LEDGER 와 같은 목적이다 — 이 검사가 실제로 red 를 낼 수
# 있는지 negative-control.sh 가 위조 디렉터리로 실증한다.
for gate in "${GATE_DIR:-$(dirname -- "$0")}"/*.sh; do
  [ -f "$gate" ] || continue
  name=$(basename "$gate")
  # `.sh` 의 점이 정규식의 임의 문자로 읽히지 않게 이스케이프한다.
  pattern=$(printf '%s' "$name" | sed 's/\./\\./g')
  found=0
  for src in .husky/pre-commit .husky/commit-msg .husky/pre-push .github/workflows/ci.yml; do
    [ -f "$src" ] || continue
    if grep -v '^[[:space:]]*#' "$src" | grep -qE "scripts/gates/$pattern([^A-Za-z0-9._-]|$)"; then
      found=1
      break
    fi
  done
  [ "$found" -eq 1 ] || fail "scripts/gates/$name 이 훅·CI 어디에서도 불리지 않는다 — 안 도는 게이트다"
done

# ── 5) 조건부 skip 이 걸린 테스트 파일이 원장에 선언돼 있는가 ─────────────────────────
# 계기 (2026-07-27): 원장은 **npm 스크립트**를 열거한다. PG 레인은 npm 스크립트라서
# 원장 항목 + 검사 2 를 받았지만, 어떤 스크립트에도 안 속한 skip 파일은 통째로 사각이었다.
# 실측: provider contract 5파일이 `*_CONTRACT=1` 로 게이팅돼 있는데 그 변수를 켜는 곳이
# compose·CI·package.json·Dockerfile·*.sh 어디에도 없었다(TREASURY_CONTRACT 는 자기
# 테스트 파일 밖 어디에도 없었다). 즉 한 번도 안 돈 테스트가 5개 있었고 출력은 초록이었다.
# 이것은 결함 3("skip 을 pass 로 집계")이 원장이 못 보는 층에 그대로 남아 있던 것이다.
#
# 원장은 게이트를 열거하지 skip 을 열거하지 않았다 — 그래서 skip 도 열거하게 만든다.
# 형식 (3열, 1열이 경로면 skip 레인 선언):
#   <테스트 파일>  wired:<그 조건을 켜는 파일>   <게이트 토큰>
#   <테스트 파일>  unwired:<이유>                <게이트 토큰>
# wired: 면 그 파일에 토큰이 **실제로** 나와야 한다 — 선언이 아니라 대조다.
SKIP_DECLARED=""
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  path=$(printf '%s' "$line" | awk '{print $1}')
  case "$path" in */*) ;; *) continue ;; esac
  target=$(printf '%s' "$line" | awk '{print $2}')
  token=$(printf '%s' "$line" | awk '{print $3}')
  SKIP_DECLARED="$SKIP_DECLARED $path"
  [ -f "$path" ] || { fail "$LEDGER 가 없는 테스트 파일을 선언했다: $path"; continue; }
  [ -n "$token" ] || fail "$path 선언에 게이트 토큰(3열)이 없다 — 무엇이 이 파일을 켜는지 적어라"
  case "$target" in
    wired:*)
      f=${target#wired:}
      if [ ! -f "$f" ]; then
        fail "$path 가 $f 에서 켜진다고 선언했으나 그 파일이 없다"
      elif ! grep -qF "$token" "$f"; then
        fail "$path 의 게이트 토큰 $token 이 $f 에 없다 — 아무도 이 파일을 켜지 않는다"
      fi
      ;;
    unwired:*) ;; # 부채 기록. 차단하지 않는다 — 목적은 조용히 지나가는 것만 막는 것이다.
    *) fail "$path 선언의 2열은 wired: 또는 unwired: 여야 한다: $target" ;;
  esac
done < "$LEDGER"

for t in $(find tests -name '*.test.ts' | sort); do
  grep -qE '(describe|it|test)\.(skipIf|runIf|skip)\(' "$t" || continue
  case " $SKIP_DECLARED " in
    *" $t "*) ;;
    *) fail "$t 는 조건부 skip 인데 $LEDGER 에 없다 — 누가 이 조건을 켜는지(또는 아무도 안 켠다는 것을) 선언하라" ;;
  esac
done

# ── 6) 비차단(continue-on-error) job 의 게이트를 wired: 로 선언하지 않았는가 ──────────
# 계기 (2026-07-27): `test:browser`·`test:performance` 는 원장에 wired: 로 적혀 있어
# 원장만 읽으면 집행되는 게이트로 읽히지만, 실제로는 `continue-on-error: true` job 안이라
# 빨개져도 아무것도 막지 못한다. ci.yml 의 nightly-mutation 주석이 스스로 거부한 바로 그
# 형태인데 원장에는 그것을 구분할 어휘가 없었다. `advisory:` 를 3번째 상태로 추가하고,
# **선언이 아니라 ci.yml 의 실제 플래그와 대조**한다.
CI=.github/workflows/ci.yml
if [ -f "$CI" ]; then
  CI_MAP=$(mktemp)
  trap 'rm -f "$CI_MAP"' EXIT INT TERM
  # job 별로 (advisory 여부, 그 job 이 부르는 npm 스크립트) 를 뽑는다.
  grep -v '^[[:space:]]*#' "$CI" | awk '
    /^jobs:/ { injobs = 1; next }
    /^[A-Za-z]/ { injobs = 0 }
    !injobs { next }
    /^  [A-Za-z0-9_-]+:/ { job = $1; sub(/:$/, "", job); next }
    /continue-on-error:[[:space:]]*true/ { adv[job] = 1; next }
    {
      line = $0
      while (match(line, /npm run [a-z][a-z0-9:-]*/)) {
        s = substr(line, RSTART + 8, RLENGTH - 8)
        seen[job "\t" s] = 1
        line = substr(line, RSTART + RLENGTH)
      }
    }
    END { for (k in seen) { split(k, p, "\t"); print (adv[p[1]] ? "advisory" : "blocking") "\t" p[2] } }
  ' > "$CI_MAP"
  # 파이프로 읽으면 서브셸이라 FAIL 이 안 올라온다 — 리다이렉션으로 받는다.
  while IFS=$(printf '\t') read -r kind script; do
    [ -n "${script:-}" ] || continue
    decl=$(grep "^$script[[:space:]]" "$LEDGER" | awk '{print $2}' | head -1)
    case "$kind:$decl" in
      advisory:wired:*)
        fail "$script 는 $CI 의 continue-on-error job 에서만 돈다 — 원장의 wired: 는 거짓이다. advisory: 로 선언하라"
        ;;
      blocking:advisory:*)
        fail "$script 는 원장에 advisory: 인데 $CI 에서 실제로는 차단 job 이다 — 선언이 낡았다"
        ;;
    esac
  done < "$CI_MAP"
fi

[ "$FAIL" -eq 0 ] || {
  echo "" >&2
  echo "게이트가 실행되지 않으면 그건 게이트가 아니다. 배선을 고치거나, 못 고치면" >&2
  echo "$LEDGER 에 unwired:<이유> 로 부채를 남겨라 — 조용히 지나가는 것만 막는다." >&2
  exit 1
}
