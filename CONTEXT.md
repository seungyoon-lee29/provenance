# 한국어 금융 터미널

미국 주식 투자자가 미국 및 한국 금융시장 정보, 공시, 뉴스, 포트폴리오와 거래 시뮬레이션을 한 화면에서 이해하고 조작하기 위한 도메인이다.

## Language

**Paper Trading**:
실제 자금이나 실제 브로커 주문을 사용하지 않는 모의 거래 모드. 모든 주문 화면의 기본 모드다.
_Avoid_: 모의 주문, 가상 실주문

**Live Trading**:
사용자가 설정에서 명시적으로 활성화하고 이중 확인을 통과한 뒤 실제 브로커로 전송되는 거래 모드. 초기 산출물에서는 주문 전송이 비활성화된다.
_Avoid_: 실제 모드, 일반 주문

**Paper Blotter**:
Paper Trading 주문의 접수, 체결, 취소와 거절 이력을 시간순으로 보여주는 기록. Live Trading 주문은 포함하지 않는다.
_Avoid_: 주문 내역, 거래 로그

**Broker Connection**:
Provider Connection 중 외부 증권사의 계좌, 보유 종목과 주문 기능을 연결하는 사용자별 연결 정보.
_Avoid_: 브로커 계정, 증권사 로그인

**Data Freshness**:
사용 가능한 시장 데이터가 `실시간`, `지연`, `오래됨` 중 어떤 상태인지 나타내며 출처와 기준 시각을 포함하는 품질 정보. `API 필요`, `데이터 없음`과 공급자 실패는 Information Outcome으로 구분한다.
_Avoid_: 데이터 상태, 업데이트 상태

**License Scope**:
Market Observation 또는 뉴스 콘텐츠를 내부 개발, 사용자 개인 조회, 공개 화면 표시, 재배포 중 어디까지 사용할 수 있는지와 보존, 외부 모델 전송·처리, 번역·요약 같은 파생물 생성을 허용하는지를 요청 목적별로 나타내는 공급자 권리 범위.
_Avoid_: API 권한, 데이터 플랜

**Market Observation**:
특정 시점과 출처에서 관측된 가격, 거래량, 금리, 환율 또는 지표 값. 항상 Data Freshness와 License Scope를 함께 제공한다.
_Avoid_: 시세 숫자, 현재가 데이터

**Evidence**:
출처, 기준 시각, License Scope를 추적할 수 있는 Market Observation, 뉴스 원문 또는 공시. AI 번역, 요약과 분석은 사용한 Evidence를 인용한다.
_Avoid_: AI 자료, 참고 데이터

**Evidence Reference**:
Evidence 원문 대신 전달하는 불투명한 참조. 해석할 때마다 Viewer Context, 요청 목적, Data Freshness와 License Scope를 다시 확인하며 Provider Credential이나 원문을 포함하지 않는다.
_Avoid_: 원문 ID, 데이터 URL

**Information Outcome**:
정보 요청의 결과를 `available`, `unavailable`, `failed`로 구분하는 공통 상태. 실제 값은 `available`에만 존재하고, `unavailable`은 `API 필요`, `데이터 없음`, `표시 권한 없음`을, `failed`는 공급자 장애, 제한 초과 또는 잘못된 응답을 나타낸다. 오래된 캐시를 사용할 수 있으면 `available`과 `오래됨` Data Freshness 및 장애 경고를 함께 제공한다.
_Avoid_: 빈 데이터, 임시 값

**Provider Degradation**:
공급자 또는 feed가 정상 결과를 제공하지 못한 원인, 발생 시각, 재시도 가능 여부와 안전한 진단 참조를 담는 정규화된 운영 정보. 원시 공급자 오류나 Provider Credential은 포함하지 않는다.
_Avoid_: API 에러, 예외 메시지

**Provider Credential**:
데이터, AI 또는 브로커 공급자에 접근하기 위한 서버 공용 또는 사용자별 비밀 정보. 사용자별 값은 암호화되어 저장되고 원문은 브라우저로 반환되지 않는다.
_Avoid_: API 설정, 인증 토큰

**Provider Connection**:
데이터, AI 또는 브로커 공급자에 대한 사용자별 연결로, 공급자 종류, Paper 또는 Live 환경, 허용된 용도와 검증 상태를 포함한다. Provider Credential 원문은 연결 정보에 노출하지 않는다.
_Avoid_: API 키, 외부 계정

**Viewer Context**:
요청자가 비로그인 방문자인지 로그인 사용자이며 어떤 User Workspace에 접근할 수 있는지를 나타내는 신뢰된 실행 문맥. Identity만 생성하고 불변의 인증 epoch에 묶으며, 클라이언트가 임의의 사용자 ID로 대체할 수 없다. 로그인, 로그아웃 또는 User Workspace 전환은 기존 문맥을 폐기한다.
_Avoid_: userId, 로그인 여부

**User Workspace**:
로그인한 사용자의 포트폴리오, 관심종목, 레이아웃, 알림과 Provider Credential을 함께 소유하는 개인화 영역.
_Avoid_: 사용자 설정, 내 계정
