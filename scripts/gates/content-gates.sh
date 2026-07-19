#!/bin/sh
# 공유 콘텐츠 게이트 — pre-commit 훅과 CI가 '한 소스'로 호출한다(ticket 22, 드리프트 금지).
# credential 패턴·secret 파일·whitespace 규칙은 여기 한 곳에만 정의한다.
#
# Usage:
#   scripts/gates/content-gates.sh --cached          # pre-commit: staged diff
#   scripts/gates/content-gates.sh <base>...HEAD     # CI: push/PR 범위
set -eu

RANGE="${1:---cached}"

# 1) whitespace / conflict marker (싼 검사부터 — fail fast)
git diff "$RANGE" --check || exit 1

# 2) 알려진 credential 포맷만 매칭 — 'secret' 같은 단어는 이 repo(vault 코드)에 정상 존재.
# ponytail: 포맷 기반 스캔, 일반 엔트로피 탐지가 필요해지면 gitleaks로 승격.
if git diff "$RANGE" -U0 | grep -E '^\+' | grep -nE '(sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{24,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[bap]-[A-Za-z0-9-]{10,}|whsec_[A-Za-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY)'; then
  echo "content-gates: diff에 credential 패턴 발견 — 차단" >&2
  exit 1
fi

# 3) .env.local/.secrets가 추적되지 않았는지 확인 (SEC-05 하한)
if git ls-files -- .env.local '.secrets/*' | grep -q .; then
  echo "content-gates: .env.local/.secrets가 git에 추적됨 — 차단" >&2
  exit 1
fi
