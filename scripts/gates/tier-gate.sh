#!/bin/sh
# Tier 승격 기계 강제 게이트 (commit-msg 훅에서 실행. 2026-07-24 결정 — pivot 메모 §6 검증기록 ③)
#
# collaboration.md 는 auth·credential·order·migration·money 산술 경로를 건드리는 diff 를
# "판단 없이 최상위 tier 로 자동 승격"한다고 규정하지만, T2-b(돈 원장 영속화)에서
# blind test-authorship 과 Standards 축 리뷰가 조용히 누락된 채 커밋됐다 (2026-07-24 독립 검증에서 발견).
# 선언만 있는 규정은 하한이 아니다 — 이 게이트가 승격을 기계적으로 강제한다.
#
# 동작: 스테이지된 diff 가 아래 guarded 경로를 건드리면, 커밋 메시지에 tier 선언 트레일러를 요구한다.
#   Tier: top (adversarial=<기록 위치|pending>, blind=<기록 위치|pending|waived:사유>, standards=<기록 위치|pending>)
# 게이트는 선언의 "존재"를 강제할 뿐 진위는 검증하지 않는다 — 진위 검증은 리뷰/메인 판단의 몫.
# pending/waived 도 통과한다: 목적은 의무를 조용히 지나치지 못하게 하는 것이다.
#
# 의도적 우회 (문서 성격 수정이 guarded 파일을 스치는 경우 등): SKIP_TIER_GATE=1 git commit ...
# ponytail: 경로 목록은 하드코딩 — Stage 3 컷(identity 삭제) 때 이 목록도 함께 갱신할 것.

[ "$SKIP_TIER_GATE" = "1" ] && exit 0

MSG_FILE="$1"
if [ -z "$MSG_FILE" ] || [ ! -f "$MSG_FILE" ]; then
  echo "tier-gate: 커밋 메시지 파일을 받지 못함 (훅 배선 오류)" >&2
  exit 1
fi

GUARDED='^src/modules/paper-trading/|^db/migrations/|^src/platform/persistence/|^src/platform/credential-vault/|^src/modules/actual-portfolio/calculation/|^src/modules/identity/'
TOUCHED=$(git diff --cached --name-only | grep -E "$GUARDED" || true)
[ -z "$TOUCHED" ] && exit 0

if grep -qE '^Tier: top \(.*adversarial=.*blind=.*standards=.*\)' "$MSG_FILE"; then
  exit 0
fi

cat >&2 <<EOF
tier-gate: 이 커밋은 최상위 tier 자동 승격 경로를 건드린다:
$(printf '%s\n' "$TOUCHED" | sed 's/^/  - /')

커밋 메시지에 tier 선언 트레일러가 없다. 다음 형식의 줄을 추가하라:

  Tier: top (adversarial=<기록 위치|pending>, blind=<기록 위치|pending|waived:사유>, standards=<기록 위치|pending>)

예:
  Tier: top (adversarial=progress/stage2-persistence.md, blind=pending, standards=pending)

pending 은 허용된다 — 의무를 인지하고 있음을 기록하는 것이 목적이다.
guarded 파일을 스치기만 하는 커밋이면: SKIP_TIER_GATE=1 git commit ...
EOF
exit 1
