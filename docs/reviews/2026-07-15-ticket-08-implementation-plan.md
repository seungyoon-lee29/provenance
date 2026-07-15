# 티켓 08 MVP 구현 계획 검수

- 검수일: 2026-07-15
- 범위: 승인 spec F0~F11의 issue 09~20 dependency, blocker, ownership, interface, acceptance와 외부 gate
- 결과: Critical 없음. 모든 High와 Medium finding을 수정하고 affected-scope re-review에서 잔여 0을 확인했다.

## 검수 방식

메인 에이전트가 issue 08과 implementation ticket만 편집하고, 두 읽기 전용 reviewer가 dependency/ownership과 acceptance/traceability를 독립 검토했다. 1차 결과를 반영한 뒤 같은 reviewer가 생성된 issue 파일의 affected scope만 다시 확인했다.

## 해결한 finding

- spec prose의 edge 없는 `F4→F11` critical path를 F0~F3 contract spine, dependency-depth 최장 경로와 F11 release join으로 정정했다.
- F0/F1 composition root 경계, F9/F10의 ProviderConnections paper/read transport subtree와 F0/main shared-owner stewardship를 명시했다.
- 무소유였던 CredentialVault와 generic ProviderAuthorization/AuthorizedTransport primitive는 F0, ProviderConnections core CRUD/vault orchestration은 F3, data/AI route registry는 F4에 배정했다.
- F4의 Actual/Paper 자료는 contract fixture resolver→F6/F8 real resolver→F11 integration의 단계적 acceptance로 분리했다.
- Identity·ProviderConnections, FinancialInformation·ResearchAssistant, NotificationCenter, ActualPortfolio, PaperTrading과 broker subtree의 administrative erasure receipt, late-work fence와 backup restore suppression을 lane별로 배정했다.
- Internal Paper의 GTC `5주 @ $110 → 10주 @ $55` 기업행동 transaction과 Broker Paper의 네 canonical fault point·정확한 mutation opt-in flag를 복원했다.

## 최종 결과

| 관점 | 확인 결과 |
| --- | --- |
| dependency/ownership | acyclic, issue 09 단일 frontier, `Blocked by` 일치, P1~P3 ownership 비중첩, Critical 0 / High 0 / Medium 0 |
| acceptance/traceability | F0~F11 requirement/interface/oracle/out-of-scope와 scripted/opt-in gate 완결, Critical 0 / High 0 / Medium 0 |

issue 08 resolved 직후 유일한 첫 implementation frontier는 [issue 09](../../.scratch/financial-terminal/issues/09-build-foundation-contracts.md)다. 후속 ticket은 blocker가 해소될 때 `Blocked by`만 갱신하고 `Depends on` 이력을 유지한다.
