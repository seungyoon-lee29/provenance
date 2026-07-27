#!/bin/sh
# 음성 대조군 — 각 게이트가 "알려진 나쁜 입력"에서 실제로 red 가 되는지 매 CI 에서 실증한다.
#
# 계기 (2026-07-27, arch-2 B 그룹): 이 저장소의 게이트 결함 4건은 전부 같은 변주였다 —
# 게이트의 통과 조건이 검사 대상과 같은 아티팩트 위에 정의돼 있어서 "통과"와 "검사를 못 함"이
# 구분되지 않는다. 그 결함은 구조적으로 무증상이다: 초록이 정상 상태이므로 작동하는 게이트와
# 영원히 통과하는 게이트는 출력이 완전히 동일하다. 유일한 신호는 "이 게이트는 한 번도 빨간
# 적이 없다" 인데, 그걸 추적하는 게 저장소에 없었다.
#
# 여기가 그 추적이다. 게이트마다 반드시 실패해야 하는 입력을 먹여 red 를 확인한다.
# 이것은 배선의 실행 증명이기도 하다 — 원장의 `grep` 은 문자열이 있다는 것만 말하지만,
# 나쁜 입력에 red 가 나왔다는 것은 그 게이트가 **돌았고 판별력이 있다**는 뜻이다.
# 문자열 존재는 증거가 아니고, 실패할 수 있음이 증거다.
#
# 규율 두 가지:
#   · red 만으로는 부족하다. 게이트가 엉뚱한 이유로 죽어도 red 다 — 그게 바로
#     verify-network-off 가 앓던 병(catch-all 이 아무 예외나 "차단됨"으로 읽음)이다.
#     그래서 기대 메시지 조각까지 맞아야 통과로 친다.
#   · 양성 대조군을 같이 돈다. 무엇에나 red 를 내는 하네스는 무엇도 증명하지 않는다.
#
# TS 함수 형태의 술어(blockedReason·releaseGitLane)는 여기가 아니라
# tests/gate-negative-control.test.ts 에 있다 — 같은 목적, 싼 쪽 도구.
#
# 네트워크·도커 없이 돈다.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
LEDGER="$ROOT/scripts/gates/gate-ledger.txt"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

PASSED=0
FAILED=0

# 게이트를 돌려 종료코드·출력을 잡는다. `set -e` 에 걸리지 않도록 조건문 형태로 받는다.
run() {
  OUT=$("$@" 2>&1) && RC=0 || RC=$?
}

# expect_red <라벨> <기대 메시지 조각> <명령...>
expect_red() {
  label=$1
  want=$2
  shift 2
  run "$@"
  if [ "$RC" -eq 0 ]; then
    printf 'FAIL  %s — 나쁜 입력인데 통과했다 (exit 0)\n' "$label" >&2
    FAILED=$((FAILED + 1))
  elif ! printf '%s' "$OUT" | grep -qF "$want"; then
    printf 'FAIL  %s — red 이긴 하나 이유가 다르다. 기대 조각: %s\n--- 실제 출력 ---\n%s\n' \
      "$label" "$want" "$OUT" >&2
    FAILED=$((FAILED + 1))
  else
    printf 'ok    %s — red (%s)\n' "$label" "$want"
    PASSED=$((PASSED + 1))
  fi
}

# expect_green <라벨> <명령...> — 양성 대조군. 하네스가 무엇에나 red 를 내면 여기서 잡힌다.
expect_green() {
  label=$1
  shift
  run "$@"
  if [ "$RC" -ne 0 ]; then
    printf 'FAIL  %s — 정상 입력인데 red (exit %s)\n--- 실제 출력 ---\n%s\n' "$label" "$RC" "$OUT" >&2
    FAILED=$((FAILED + 1))
  else
    printf 'ok    %s — green\n' "$label"
    PASSED=$((PASSED + 1))
  fi
}

# ── gate-liveness ────────────────────────────────────────────────────────────
# 원장 전체를 위조하면 여러 검사가 동시에 터져 어느 검사가 살아 있는지 알 수 없다.
# 진짜 원장에서 **한 줄만** 어긋내 검사별 판별력을 하나씩 분리해 본다.
liveness() { ( cd "$ROOT" && env GATE_LEDGER="$1" sh scripts/gates/gate-liveness.sh ); }

# 3b 자기참조: check:pr 을 자기 정의 파일(package.json)에 배선됐다고 선언 —
# 2026-07-27 전까지 단순 substring 판정이 이걸 영원히 통과시켰다.
awk '/^check:pr[ \t]/ { print "check:pr\twired:package.json"; next } { print }' \
  "$LEDGER" > "$WORK/ledger-selfref.txt"
expect_red "gate-liveness 3b 자기참조" "check:pr 의 배선이 끊겼다" liveness "$WORK/ledger-selfref.txt"

# 3b 배선 대상 파일 소멸
awk '/^build[ \t]/ { print "build\twired:NoSuchFile"; next } { print }' \
  "$LEDGER" > "$WORK/ledger-nofile.txt"
expect_red "gate-liveness 3b 배선 파일 없음" "그 파일이 없다" liveness "$WORK/ledger-nofile.txt"

# 3a 원장 밖 게이트 (새 게이트 몰래 들이기)
grep -v '^test:browser[[:space:]]' "$LEDGER" > "$WORK/ledger-missing.txt"
expect_red "gate-liveness 3a 원장 누락" "로 선언하라" liveness "$WORK/ledger-missing.txt"

# 4 게이트 스크립트 자신이 안 불림 — 위조 게이트 디렉터리로 실증
mkdir -p "$WORK/gates"
: > "$WORK/gates/zz-never-called.sh"
expect_red "gate-liveness 4 안 불리는 게이트 스크립트" "훅·CI 어디에서도 불리지 않는다" \
  sh -c 'cd "$1" && GATE_DIR="$2" sh scripts/gates/gate-liveness.sh' _ "$ROOT" "$WORK/gates"

# 5 조건부 skip 파일이 원장에 없음 — 영구 skip 이 조용히 들어오는 경로
grep -v '^tests/treasury-market-information' "$LEDGER" > "$WORK/ledger-noskip.txt"
expect_red "gate-liveness 5 미선언 skip 파일" "조건부 skip 인데" liveness "$WORK/ledger-noskip.txt"

# 5 wired 로 선언했는데 토큰이 그 파일에 없음 — "켠다"는 주장이 거짓인 경우
awk '/^tests\/persistence\/paper-journal/ { print "tests/persistence/paper-journal.pg.test.ts\twired:compose.yaml\tNOSUCH_TOKEN"; next } { print }' \
  "$LEDGER" > "$WORK/ledger-badtoken.txt"
expect_red "gate-liveness 5 토큰 미대조" "아무도 이 파일을 켜지 않는다" liveness "$WORK/ledger-badtoken.txt"

# 5 토큰(3열) 누락 — 무엇이 켜는지 안 적고 넘어가는 경로
awk '/^tests\/persistence\/paper-cli/ { print "tests/persistence/paper-cli.pg.test.ts\twired:compose.yaml"; next } { print }' \
  "$LEDGER" > "$WORK/ledger-notoken.txt"
expect_red "gate-liveness 5 토큰 누락" "게이트 토큰(3열)이 없다" liveness "$WORK/ledger-notoken.txt"

# 6 continue-on-error job 의 게이트를 wired 로 선언 — 원장만 읽으면 집행되는 것으로 읽힌다
awk '/^test:browser[ \t]/ { print "test:browser\twired:.github/workflows/ci.yml"; next } { print }' \
  "$LEDGER" > "$WORK/ledger-fakewired.txt"
expect_red "gate-liveness 6 비차단 job 을 wired 로" "원장의 wired: 는 거짓이다" liveness "$WORK/ledger-fakewired.txt"

# 6 반대 방향 — 실제로는 차단인데 advisory 로 낮춰 적기 (선언이 낡는 경로)
awk '/^test:mutation[ \t]/ { print "test:mutation\tadvisory:.github/workflows/ci.yml"; next } { print }' \
  "$LEDGER" > "$WORK/ledger-fakeadv.txt"
expect_red "gate-liveness 6 차단 job 을 advisory 로" "실제로는 차단 job" liveness "$WORK/ledger-fakeadv.txt"

expect_green "gate-liveness 진짜 원장 (양성 대조군)" liveness "$LEDGER"

# ── content-gates / tier-gate ────────────────────────────────────────────────
# 둘 다 git 인덱스·히스토리를 읽으므로 일회용 저장소를 만들어 먹인다.
# 이 저장소의 인덱스는 건드리지 않는다 (다른 세션의 작업일 수 있다).
REPO="$WORK/repo"
git init -q "$REPO"
git -C "$REPO" config user.email gate@example.invalid
git -C "$REPO" config user.name "negative control"
git -C "$REPO" config commit.gpgsign false
git -C "$REPO" config core.hooksPath /dev/null
: > "$REPO/base.txt"
git -C "$REPO" add base.txt
git -C "$REPO" commit -q -m "base"

in_repo() { ( cd "$REPO" && "$@" ); }
content_gates() { in_repo sh "$ROOT/scripts/gates/content-gates.sh" "$@"; }
tier_gate() { in_repo sh "$ROOT/scripts/gates/tier-gate.sh" "$@"; }

stage() { # stage <파일> — 내용은 stdin
  mkdir -p "$(dirname "$REPO/$1")"
  cat > "$REPO/$1"
  git -C "$REPO" add -- "$1"
}

printf 'trailing space here \n' | stage dirty.txt
expect_red "content-gates whitespace" "trailing whitespace" content_gates --cached
git -C "$REPO" rm -q --cached dirty.txt

# credential 리터럴을 이 파일에 그대로 적으면 이 파일 자신의 커밋이 content-gates 에
# 걸린다. 조각으로 조립한다 — 합치지 말 것.
FAKE_TOKEN="$(printf 'sk-%s' 'ant')-0123456789abcdef"
printf 'const token = "%s";\n' "$FAKE_TOKEN" | stage leak.ts
expect_red "content-gates credential 패턴" "credential 패턴 발견" content_gates --cached
git -C "$REPO" rm -q --cached leak.ts

printf 'const ok = 1;\n' | stage clean.ts
expect_green "content-gates 정상 diff (양성 대조군)" content_gates --cached
git -C "$REPO" commit -q -m "clean"

# tier-gate: guarded 경로(money)를 건드리는데 트레일러가 없는 커밋
printf 'export const x = 1;\n' | stage src/modules/paper-trading/internal/probe.ts
git -C "$REPO" commit -q -m "touch money path without trailer"
expect_red "tier-gate --range 트레일러 없음" "Tier 트레일러가 없다" tier_gate --range HEAD^..HEAD

# 로컬 탈출구가 원격 대응물까지 끄지 못하는지 — 4번 결함("강제자가 피강제자 손에 있음")의
# 핵심이다. SKIP_TIER_GATE 는 커밋에 흔적이 안 남으므로 range 모드에서 통하면 안 된다.
expect_red "tier-gate --range 는 SKIP_TIER_GATE 로 안 꺼진다" "Tier 트레일러가 없다" \
  in_repo env SKIP_TIER_GATE=1 sh "$ROOT/scripts/gates/tier-gate.sh" --range HEAD^..HEAD

# 사유 없는 면제는 거부돼야 한다 (정규식이 `.+` 를 요구하는지)
printf 'export const y = 2;\n' | stage src/modules/paper-trading/internal/probe2.ts
git -C "$REPO" commit -q -m "touch money path

Tier: skip ()"
expect_red "tier-gate 사유 없는 skip" "Tier 트레일러가 없다" tier_gate --range HEAD^..HEAD

printf 'export const z = 3;\n' | stage src/modules/paper-trading/internal/probe3.ts
git -C "$REPO" commit -q -m "touch money path

Tier: skip (음성 대조군 픽스처 — 실행 경로 무변경)"
expect_green "tier-gate 사유 있는 skip (양성 대조군)" tier_gate --range HEAD^..HEAD

# 미해소 pending — 로컬에서는 허용이지만 PR 범위에서는 red 여야 한다. pending 은 공식
# 탈출구인데 이후 층이 없으면 SKIP_TIER_GATE 와 같은 병이다 (실측: 28건 중 11건이 pending).
printf 'export const p = 4;\n' | stage src/modules/paper-trading/internal/probe4.ts
git -C "$REPO" commit -q -m "touch money path

Tier: top (adversarial=progress/x.md, blind=tests/x.test.ts, standards=pending, prior-decisions=none-found)"
expect_red "tier-gate --range 미해소 pending" "미해소 pending 이 남아 있다" tier_gate --range HEAD^..HEAD

# 같은 트레일러에서 pending 만 해소하면 통과 — 게이트가 pending 만 보는지 확인한다.
printf 'export const q = 5;\n' | stage src/modules/paper-trading/internal/probe5.ts
git -C "$REPO" commit -q -m "touch money path

Tier: top (adversarial=progress/x.md, blind=tests/x.test.ts, standards=waived:설정-only, prior-decisions=none-found)"
expect_green "tier-gate --range pending 해소 (양성 대조군)" tier_gate --range HEAD^..HEAD

# 두 층 설계의 아래층 — 로컬 commit-msg 모드에서는 pending 이 통과해야 한다.
# 여기까지 red 로 만들면 작업 중 커밋이 막혀 사람들이 게이트를 우회하게 되고, 그러면
# 게이트가 아니라 회피 습관을 만든다. 위층(--range)만 강제한다.
printf 'export const r = 6;\n' | stage src/modules/paper-trading/internal/probe6.ts
printf 'touch money path\n\nTier: top (adversarial=pending, blind=pending, standards=pending, prior-decisions=none-found)\n' \
  > "$WORK/msg-pending.txt"
expect_green "tier-gate 로컬 모드는 pending 통과 (양성 대조군)" tier_gate "$WORK/msg-pending.txt"
git -C "$REPO" commit -q -m "touch money path

Tier: top (adversarial=x, blind=x, standards=waived:픽스처, prior-decisions=none-found)"

printf '# not a guarded path\n' | stage README.md
git -C "$REPO" commit -q -m "docs only"
expect_green "tier-gate guarded 경로 무관 커밋 (양성 대조군)" tier_gate --range HEAD^..HEAD

# ── 린트 (정적 층) ───────────────────────────────────────────────────────────
# 켠 타입 인지 규칙 중 넷은 저장소 전체에서 발견 0건이다. 안 도는 규칙과 잡을 게 없는
# 규칙은 출력이 같으므로, 고의로 나쁜 픽스처를 집어 실제로 걸리는지 본다.
FIXTURE=tests/fixtures/lint-negative-control.fixture.ts
LINT_OUT=$( (cd "$ROOT" && npx eslint --no-ignore "$FIXTURE" 2>&1) || true )
for rule in require-array-sort-compare restrict-plus-operands no-base-to-string \
            switch-exhaustiveness-check no-floating-promises no-misused-promises await-thenable; do
  if printf '%s' "$LINT_OUT" | grep -qF "@typescript-eslint/$rule"; then
    printf 'ok    eslint %s — 픽스처에서 걸린다\n' "$rule"
    PASSED=$((PASSED + 1))
  else
    printf 'FAIL  eslint %s — 나쁜 픽스처인데 안 걸린다 (규칙이 안 돌고 있다)\n' "$rule" >&2
    FAILED=$((FAILED + 1))
  fi
done

# any 계열은 src 에만 집행한다(eslint.config.mjs 참조). 그 스코프 자체가 의도대로
# 해석되는지는 실행된 설정으로 확인한다 — 설정 파일을 읽는 것은 증거가 아니다.
# `--print-config` 는 **해석된** 설정을 찍는다 — 설정 파일을 읽는 것과 달리 스코프가
# 실제로 어떻게 적용됐는지의 증거가 된다. 공백을 지워 형태 의존을 줄인다.
resolved_severity() { ( cd "$ROOT" && npx eslint --print-config "$1" 2>/dev/null | tr -d ' \n' ); }
if resolved_severity src/worker/main.ts | grep -qF '"@typescript-eslint/no-unsafe-member-access":[2'; then
  printf 'ok    eslint no-unsafe-* — src 에서 error 로 해석된다\n'
  PASSED=$((PASSED + 1))
else
  printf 'FAIL  eslint no-unsafe-* — src 에서 error 가 아니다 (스코프가 의도와 다르다)\n' >&2
  FAILED=$((FAILED + 1))
fi

# ── staged-tree-check ────────────────────────────────────────────────────────
# 이 게이트가 잡아야 하는 것은 "훅이 초록인데 커밋될 트리는 빨강"이다. 그 상황을 실제
# 트리로 만들어 먹인다 — 저장소 설정(tsconfig·eslint.config)을 그대로 쓰되 파일 하나만
# 어긋내므로, red 가 나오면 그것은 이 게이트가 트리를 정말로 컴파일했다는 뜻이다.
STC_BAD="$WORK/stc-bad"
mkdir -p "$STC_BAD/src"
cp "$ROOT/tsconfig.json" "$ROOT/eslint.config.mjs" "$ROOT/package.json" "$STC_BAD/"
# exactOptionalPropertyTypes 위반 — 2026-07-27 에 실제로 놓친 것과 같은 형태다.
cat > "$STC_BAD/src/stc-negative-control.ts" <<'STCEOF'
type Slot = { readonly key?: string };
// 파라미터여야 한다 — `const` 는 초기화값으로 CFA 좁힘이 걸려 union 이 유지되지 않는다.
export function put(maybe: string | undefined): Slot {
  return { key: maybe };
}
STCEOF
expect_red "staged-tree-check 타입 위반" "typecheck 를 통과하지 못한다" \
  sh "$ROOT/scripts/gates/staged-tree-check.sh" --tree-dir "$STC_BAD"

# 양성 대조군 — 같은 트리에서 위반만 걷어내면 통과해야 한다. 무엇에나 red 를 내면 여기서 잡힌다.
STC_OK="$WORK/stc-ok"
mkdir -p "$STC_OK/src"
cp "$ROOT/tsconfig.json" "$ROOT/eslint.config.mjs" "$ROOT/package.json" "$STC_OK/"
cat > "$STC_OK/src/stc-negative-control.ts" <<'STCEOF'
type Slot = { readonly key?: string | undefined };
export function put(maybe: string | undefined): Slot {
  return { key: maybe };
}
STCEOF
expect_green "staged-tree-check 정상 트리" \
  sh "$ROOT/scripts/gates/staged-tree-check.sh" --tree-dir "$STC_OK"

# ── 집계 ─────────────────────────────────────────────────────────────────────
printf '\nnegative-control: %s ok / %s fail\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ] || {
  echo "" >&2
  echo "게이트가 나쁜 입력에서 red 가 되지 못했다. 그 게이트의 통과는 아무것도 증명하지" >&2
  echo "않는다 — 통과와 '검사를 못 함'이 구분되지 않는 상태다. 게이트를 고치거나, 대조군이" >&2
  echo "낡았으면 여기 기대 메시지를 갱신하라." >&2
  exit 1
}
