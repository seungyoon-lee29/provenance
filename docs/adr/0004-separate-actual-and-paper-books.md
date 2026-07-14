# Actual Portfolio와 Paper Trading 원장 격리

Actual Portfolio와 Paper Trading은 하나의 mode 기반 portfolio나 범용 주문 interface를 공유하지 않고 별도 `ActualPortfolio`와 `PaperTrading` module, branded account type, journal과 projection을 사용한다. 중복 계산 규칙을 내부에서 재사용하는 비용보다 실제 자산과 모의 자산의 합산, 잘못된 계좌 주문과 Live Trading 경로 유입을 타입·capability·transport route·저장소에서 함께 막는 안전성이 더 중요하다. Live Trading을 도입하려면 adapter 하나를 추가하는 방식이 아니라 별도 module, capability, route, 위험 검토와 새 ADR을 요구한다.
