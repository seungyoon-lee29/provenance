# 모든 지원 자료에 Gemini 사용

사용자가 Gemini를 선택하고 무료 key가 구성돼 있으면 ResearchAssistant는 시장·뉴스·SEC/DART 공시·실적·옵션·ETF·환율·금리·원자재·차트, Actual/Paper Portfolio와 주문 문맥을 포함한 모든 지원 자료 유형에 Gemini를 기본 AI adapter로 사용할 수 있다. 자료 유형이나 민감/비민감 분류만으로 차단하지 않는다.

호출 전에는 Viewer Context와 원천 License Scope를 확인하고 최소화된 AI Material Envelope를 만든다. Provider Credential, session/auth token, 원문 계좌번호, 주문 실행 비밀과 직접 식별자는 제거한다. 파생물 생성이 금지된 원천은 Gemini와 로컬 규칙을 모두 차단하고, 외부 모델 처리만 금지된 경우에는 지원 가능한 로컬 규칙만 사용한다.

개인 포트폴리오·주문 문맥처럼 workspace 자료를 보낼 때는 workspace별 `AI Processing Consent`가 추가로 필요하다. 이 동의는 provider와 tier, 무료 tier의 데이터 처리 고지 및 약관 버전, 동의 시각·출처, revocation epoch를 보존한다. enqueue와 실제 dispatch 직전에 다시 확인하고, 해지되면 대기 작업을 취소하며 해당 epoch에서 만든 개인화 cache와 결과 접근권을 무효화한다. 이 절차는 자료 유형 금지가 아니라 사용자 선택과 처리 고지를 감사 가능하게 만드는 경계다.

Gemini key 부재, quota, timeout 또는 upstream 장애는 원인별 Information Outcome과 로컬 폴백으로 처리한다. 결과 provenance는 입력한 source-owned AI Material Reference와 그 자료가 인용한 Evidence Reference, workspace/auth/consent epoch, 모델·정책 버전과 생성 시각을 함께 보존한다. 개인 reference는 원래 User Workspace 안에서만 해석하고 입력의 표시·재배포 권리를 넓히지 않는다.
