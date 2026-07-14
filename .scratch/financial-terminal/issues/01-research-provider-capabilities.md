# 01 - 공급자 지원 범위 조사

Type: research
Status: resolved
Depends on: None
Blocked by: None

## Question

미국·한국 시장, 뉴스, 공시, 실적, 옵션, 금리, 원자재, 환율, Gemini와 브로커 연결에 사용할 공식 공급자 조합은 무엇이며, 각 공급자의 키·지연·재배포·운영 제한은 무엇인가?

## Answer

- 공공 정본은 SEC EDGAR, Open DART, 미국 재무부와 ECB를 우선 연결한다. 각 요청 제한과 출처 표기를 지키고 서버에서 캐시한다.
- 내부 개발과 Paper Trading은 Alpaca Basic의 실시간 IEX 및 15분 지난 SIP 이력으로 시작한다. IEX를 미국 전체 시장 실시간 가격으로 표시하지 않는다.
- 한국 시장은 KRX 일별 Open API를 EOD 정본으로 사용한다. KIS는 사용자 결정상 구독비 USD 0의 `free_personal` 공급자로 취급해 본인 목적의 국내·해외 주식/ETF 시세·호가·차트·순위·재무/일정·뉴스 제목과 계좌·손익·모의투자 capability를 manifest에 등록한다. 엔드포인트별 실전/모의 지원과 지연 수준은 contract smoke로 확인하며, 공용 시세나 다른 사용자 cache로 재배포하지 않는다.
- 현재 공급자 구독 예산은 USD 0이다. 공개 프로덕션의 미국 전시장 시세·지수·옵션, 한국 실시간·지연 시세와 유료 뉴스는 보류하고 `api_required` 또는 `license_restricted`로 표시한다. 이후 Massive·Twelve Data Business, KRX·코스콤 또는 승인 벤더 계약이 확인된 경우에만 활성화한다.
- 뉴스는 제목, 허용된 짧은 snippet, 매체, 발행 시각과 원문 링크만 저장한다. 기사 전문과 이미지는 별도 권리 없이 복제하지 않는다.
- 재무·실적은 SEC XBRL과 DART를 정본으로 보존하고 정규화 공급자는 보조로만 사용한다.
- Gemini 무료 티어는 시장·뉴스·SEC/DART 공시·실적·옵션·ETF·환율·금리·원자재·차트, Actual/Paper Portfolio와 주문 문맥을 포함한 모든 지원 자료 유형의 기본 AI adapter로 사용할 수 있다. 자료 유형이나 민감/비민감 분류만으로 차단하지 않는다. Viewer Context가 허용한 최소 필드만 보내고 Provider Credential, session/auth token, 원문 계좌번호, 주문 실행 비밀과 직접 식별자는 제거한다. 원천의 외부 모델 처리·파생물 권리는 별도 License Scope로 판정하고 유료 tier는 보류한다.
- Alpaca Basic의 무료 IEX 실시간, 15분 지난 주식 이력, indicative option과 Paper Trading을 개인 개발·개인 Workspace에 사용한다. Alpaca News는 runtime entitlement probe가 성공한 개인 연결에서만 활성화한다. Alpaca·IBKR·KIS는 계좌 및 보유 종목 조회 어댑터를 제공하되 초기 릴리스에서 Live Trading 주문 실행 경로는 비활성화한다.
- 모든 데이터 레코드는 공급자, feed/venue, 기준 시각, 수신 시각, Data Freshness와 License Scope를 포함한다.

전체 근거와 공식 문서 링크는 [공급자 조사 보고서](../../../docs/research/provider-options.md)에 기록했다.

2026-07-14 사용자 정책 변경으로 Gemini의 자료 유형 제한과 KIS·Alpaca 무료 capability 범위를 위 내용으로 갱신했다. 무료 비용은 공개 표시·재배포 권리를 뜻하지 않는다.
