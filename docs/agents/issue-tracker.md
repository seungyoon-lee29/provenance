# Issue tracker: Local Markdown

스펙과 티켓은 `.scratch/`에 저장한다.

- 스펙: `.scratch/<feature>/spec.md`
- 티켓: `.scratch/<feature>/issues/<NN>-<slug>.md`
- 티켓은 의존성 순서로 번호를 매긴다.
- 상태와 댓글은 각 파일 안에 기록한다.
- Wayfinder 지도는 `.scratch/<effort>/map.md`에 저장한다.
- Wayfinder 티켓은 `Type`, `Status`, `Blocked by` 필드를 사용한다.

## Wayfinding operations

- **Map**: `.scratch/<effort>/map.md`
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`
- **Blocking**: `Blocked by: NN, NN`으로 기록한다.
- **Frontier**: 열려 있고, 차단되지 않았으며, 아직 claim되지 않은 첫 번호의 티켓이다.
- **Claim**: 작업 전에 `Status: claimed`로 변경한다.
- **Resolve**: 답을 `## Answer` 아래에 기록하고 `Status: resolved`로 변경한 뒤 지도에 링크를 추가한다.
