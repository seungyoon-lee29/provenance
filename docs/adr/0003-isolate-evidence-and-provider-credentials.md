# Evidence와 Provider Credential 격리

시장 정보와 뉴스·공시는 FinancialInformation이 Evidence로 정규화하고 ResearchAssistant에는 원문 묶음 대신 Evidence Reference만 전달한다. ResearchAssistant가 Evidence를 해석할 때는 Viewer Context와 함께 표시, 보존, 외부 모델 전송·처리와 파생물 생성 목적을 명시하고 License Scope를 다시 확인한다. 데이터·AI·브로커 adapter는 Provider Credential을 직접 읽지 않고 ProviderConnections가 Viewer Context, 연결, 공급자, 환경, capability, 허용 route와 만료에 묶어 발급한 AuthorizedTransport만 사용하며 임의 origin, 인증 header와 cross-origin redirect는 금지한다. 이 결정은 provider SDK를 직접 연결하는 구현보다 seam이 늘지만 사용자 권한, 콘텐츠 권리와 비밀 유출을 한 경계에서 막을 수 있다.
