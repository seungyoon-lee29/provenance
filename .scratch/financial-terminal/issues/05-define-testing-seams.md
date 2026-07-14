# 05 - 테스트 seam과 성능 예산 결정

Type: grilling
Status: open
Blocked by: 02, 03, 04

## Question

공급자 장애, 기간·인터벌 차트 변경, 사용자별 저장, 포트폴리오 회계·주문·동기화 안전 경계, 초기 로딩과 반응형 레이아웃을 어떤 상위 seam에서 검증하며 성능 합격 기준을 무엇으로 정할 것인가?

## Inputs from ticket 04

- Portfolio Scope의 흐름 경계, 현물 이전 fair value, TWR·XIRR sign/root와 incomplete coverage worked example
- raw·adjusted Price Basis, 기업행동의 exactly-once 처리, GTC 주문·Paper Reservation 동시 변환
- 다중 통화 및 gross·net·수수료·세금·Source Realized P&L reconciliation
- cancellation rejection, submission·execution·cancellation 축 조합, stream·poll 중복, delayed observation clock의 state-machine/property test
- provider/feed별 stale threshold·hard expiry와 Simulated Fill의 volume participation·slippage fixture
- transactional outbox crash, lookup-before-retry, idempotency horizon과 revoke 직전 route-call race의 fault injection
- lease 만료 중첩 worker, cursor reset·late event·correction/reversal 순서, multi-page partial snapshot, reconnect·삭제·projection gap race
- Alpaca Paper와 KIS 모의투자 자격증명으로 실제 지원 가능한 계좌 조회, 주문 유형, 취소, 체결·정정·재연결 범위를 sandbox contract test로 기록하되 외부 공개 시장 feed 권리로 간주하지 않음
