#!/bin/sh
# Tier 승격 기계 강제 게이트 (commit-msg 훅에서 실행. 2026-07-24 결정 — pivot 메모 §6 검증기록 ③)
#
# collaboration.md 는 auth·credential·order·migration·money 산술 경로를 건드리는 diff 를
# "판단 없이 최상위 tier 로 자동 승격"한다고 규정하지만, T2-b(돈 원장 영속화)에서
# blind test-authorship 과 Standards 축 리뷰가 조용히 누락된 채 커밋됐다 (2026-07-24 독립 검증에서 발견).
# 선언만 있는 규정은 하한이 아니다 — 이 게이트가 승격을 기계적으로 강제한다.
#
# 동작: 스테이지된 diff 가 아래 guarded 경로를 건드리면, 커밋 메시지에 tier 선언 트레일러를 요구한다.
#   Tier: top (adversarial=<기록 위치|pending>, blind=<기록 위치|pending|waived:사유>,
#              standards=<기록 위치|pending>, prior-decisions=<기록 위치|none-found>)
# 게이트는 선언의 "존재"를 강제할 뿐 진위는 검증하지 않는다 — 진위 검증은 리뷰/메인 판단의 몫.
#
# pending 은 **두 층**이다 (2026-07-27):
#   · 로컬 커밋(commit-msg 훅): 통과. 작업 중 축이 안 끝난 것은 정상이고, 기록하는 것이 목적이다.
#   · PR 범위(--range): red. pending 은 "나중에 한다"인데 그 나중이 없으면 그냥 안 한 것이다.
# 실측이 계기다 — 커밋된 `Tier: top` 28건 중 세 축이 전부 실제 기록인 것은 8건뿐이었고,
# pending 을 해소했는지 보는 코드는 저장소 어디에도 없었다.
# `waived:사유` 는 양쪽 다 통과한다: 사유가 붙은 의도적 면제는 미룸이 아니다.
#
# prior-decisions 추가 (2026-07-26, arch-1): 이 저장소는 기각한 안을 "기각 (기록)" 으로 남기는데,
# arch-1 의 설계 인터뷰가 t8-backtest-engine.md:118 에서 이미 기각된 안(공용 synthetic-viewer 헬퍼)을
# 그 기록을 안 읽고 다시 추천했다. 적대 리뷰가 잡았다. 기각 이력은 쌓일수록 가치가 커지는데
# 아무도 안 읽으면 0 이므로, 착수 전 조회를 트레일러로 강제한다. 조회 결과 없으면 none-found 로 적는다.
#
# 의도적 우회 (문서 성격 수정이 guarded 파일을 스치는 경우 등): SKIP_TIER_GATE=1 git commit ...
# ponytail: 경로 목록은 하드코딩 — Stage 3 컷(identity 삭제) 때 이 목록도 함께 갱신할 것.

GUARDED='^src/modules/paper-trading/|^db/migrations/|^src/platform/persistence/|^src/platform/credential-vault/|^src/modules/actual-portfolio/calculation/|^src/modules/identity/'
# 트레일러 두 형태를 받는다: 의무 선언(top) 또는 사유를 남긴 면제(skip).
# `skip` 의 사유는 공백만으로 채울 수 없다 — `.+` 는 공백 하나도 받아서 "사유를 요구한다"는
# 주장이 거짓이었다 (codex 적대 리뷰 #8). 최소 한 글자의 비공백을 요구하고 행 끝까지 anchor 한다.
TRAILER='^Tier: (top \(.*adversarial=.*blind=.*standards=.*prior-decisions=.*\)|skip \([[:space:]]*[^[:space:])][^)]*\))[[:space:]]*$'

# ── CI 대응물 (2026-07-27, arch-2 B) ──────────────────────────────────────────
# 이 게이트는 commit-msg 훅에만 있었다. 훅은 로컬 산물이라 `--no-verify`, `prepare` 를
# 안 돈 클론, 웹 UI 커밋, 훅을 안 거치는 도구로 만든 커밋은 전부 무검사로 들어온다.
# content-gates·gate-liveness 는 이미 CI 에서 한 번 더 도는데 이것만 빠져 있었다 —
# "money 경로 승격을 기계가 강제한다" 는 주장의 실제 커버리지가 로컬뿐이었다는 뜻이다.
#   sh scripts/gates/tier-gate.sh --range <base>..<head>
# SKIP_TIER_GATE 는 로컬 탈출구라 커밋에 흔적이 남지 않으므로 range 모드에서는 통하지
# 않는다. 원격까지 넘기려면 사유를 커밋 메시지에 `Tier: skip (사유)` 로 남겨야 한다.
if [ "${1:-}" = "--range" ]; then
  RANGE="${2:-}"
  if [ -z "$RANGE" ]; then
    echo "tier-gate: --range 에 커밋 범위가 필요하다 (예: --range base..HEAD)" >&2
    exit 1
  fi
  # 나쁜 입력에 fail-open 하지 않는다: `git rev-list` 가 실패하면 for 루프가 빈 목록으로
  # 접혀 exit 0 이 됐다 — 게이트 입력 오류가 green 이라는 뜻이고, 이 게이트가 고치려는
  # 바로 그 병이다 (codex 적대 리뷰 #4, 2026-07-27. 재현: --range not-a-ref..HEAD → rc=0).
  if ! SHAS=$(git rev-list "$RANGE" 2>&1); then
    echo "tier-gate: --range '$RANGE' 를 해석할 수 없다 — 범위를 못 읽으면 통과시키지 않는다" >&2
    echo "$SHAS" >&2
    exit 1
  fi
  RC=0
  for sha in $SHAS; do
    # 머지 커밋은 -m 없이는 빈 diff 라 자연히 건너뛴다 (도입 변경이 없다).
    touched=$(git diff-tree --no-commit-id --name-only -r "$sha" | grep -E "$GUARDED" || true)
    [ -z "$touched" ] && continue
    if git log -1 --format=%B "$sha" | grep -qE "$TRAILER"; then
      # 트레일러는 있다. 여기가 `pending` 의 **이후 층**이다 (2026-07-27).
      # 실측 계기: 커밋된 `Tier: top` 28건 중 11건에 pending 이 남아 있었고, 그것을 나중에
      # 해소했는지 검사하는 코드가 저장소 어디에도 없었다. 즉 pending 은 공식 탈출구인데
      # 이후 층이 없어서 영구 통과였다 — SKIP_TIER_GATE 에서 닫은 결함("강제자가 피강제자
      # 손에 있다")이 더 부드러운 형태로 그대로 남아 있던 것이다.
      # 로컬 커밋에서는 계속 허용한다: pending 의 원래 목적(의무 인지를 기록)은 옳고,
      # 작업 중에 축이 아직 안 끝나는 것은 정상이다. 강제하는 시점은 PR 범위다.
      # `waived:사유` 는 통과시킨다 — 사유가 붙은 의도적 면제는 미룸이 아니다.
      unresolved=$(git log -1 --format=%B "$sha" \
        | grep -oE '(adversarial|blind|standards|prior-decisions)=pending' || true)
      if [ -n "$unresolved" ]; then
        echo "tier-gate: $sha 의 Tier 트레일러에 미해소 pending 이 남아 있다:" >&2
        printf '%s\n' "$unresolved" | sed 's/^/  - /' >&2
        echo "  → 축을 실제로 돌리고 기록 위치로 바꾸거나, 안 할 거면 waived:<사유> 로 적어라." >&2
        RC=1
      fi
      continue
    fi
    echo "tier-gate: $sha 가 최상위 tier 승격 경로를 건드리는데 Tier 트레일러가 없다:" >&2
    printf '%s\n' "$touched" | sed 's/^/  - /' >&2
    RC=1
  done
  [ "$RC" -eq 0 ] || echo "tier-gate: 로컬 SKIP_TIER_GATE 는 원격에서 통하지 않는다 — 사유는 커밋 메시지에 'Tier: skip (사유)' 로 남겨라" >&2
  exit "$RC"
fi

[ "$SKIP_TIER_GATE" = "1" ] && exit 0

MSG_FILE="$1"
if [ -z "$MSG_FILE" ] || [ ! -f "$MSG_FILE" ]; then
  echo "tier-gate: 커밋 메시지 파일을 받지 못함 (훅 배선 오류)" >&2
  exit 1
fi

TOUCHED=$(git diff --cached --name-only | grep -E "$GUARDED" || true)
[ -z "$TOUCHED" ] && exit 0

if grep -qE "$TRAILER" "$MSG_FILE"; then
  exit 0
fi

cat >&2 <<EOF
tier-gate: 이 커밋은 최상위 tier 자동 승격 경로를 건드린다:
$(printf '%s\n' "$TOUCHED" | sed 's/^/  - /')

커밋 메시지에 tier 선언 트레일러가 없다. 다음 형식의 줄을 추가하라:

  Tier: top (adversarial=<기록 위치|pending>, blind=<기록 위치|pending|waived:사유>, standards=<기록 위치|pending>, prior-decisions=<기록 위치|none-found>)

예:
  Tier: top (adversarial=progress/stage2-persistence.md, blind=pending, standards=pending, prior-decisions=none-found)

guarded 파일을 스치기만 하는 커밋이면 사유를 남겨라 (로컬 SKIP 과 달리 원격까지 유효):

  Tier: skip (<왜 최상위가 아닌지 — 예: 주석 오타 수정, 실행 경로 무변경>)

pending 은 이 로컬 커밋에서는 허용된다 — 의무를 인지하고 있음을 기록하는 것이 목적이다.
다만 PR 범위(CI 의 --range)에서는 미해소 pending 이 red 다. 축을 돌린 뒤 기록 위치로
바꾸거나, 안 할 거면 waived:<사유> 로 적어라. "나중에" 가 없으면 그냥 안 한 것이다.
prior-decisions 는 착수 전 .scratch/**/progress/*.md 와 docs/adr/ 에서 이 범위에 걸리는
"기각 (기록)" 항목을 조회한 결과다. 없으면 none-found, 있으면 어디서 무엇을 봤는지 적는다.
거스르기로 했다면 그 사유를 반박한 위치를 적는다 — 기각 이력은 읽히지 않으면 가치가 0 이다.
guarded 파일을 스치기만 하는 커밋이면: SKIP_TIER_GATE=1 git commit ...
EOF
exit 1
