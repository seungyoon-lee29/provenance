# 01 - 공급자 지원 범위 조사

Type: research
Status: resolved
Blocked by: None

## Question

미국·한국 시장, 뉴스, 공시, 실적, 옵션, 금리, 원자재, 환율, Gemini와 브로커 연결에 사용할 공식 공급자 조합은 무엇이며, 각 공급자의 키·지연·재배포·운영 제한은 무엇인가?

## Answer

- 공공 정본은 SEC EDGAR, Open DART, 미국 재무부와 ECB를 우선 연결한다. 각 요청 제한과 출처 표기를 지키고 서버에서 캐시한다.
- 내부 개발과 Paper Trading은 Alpaca Basic의 실시간 IEX 및 15분 지난 SIP 이력으로 시작한다. IEX를 미국 전체 시장 실시간 가격으로 표시하지 않는다.
- 한국 시장은 KRX 일별 Open API를 EOD 정본으로 사용하고 KIS는 공용 시세가 아닌 사용자별 Broker Connection과 모의 계좌 조회에 사용한다.
- 공개 프로덕션의 미국 전시장 시세·지수·옵션은 Massive 또는 Twelve Data Business 계약, 한국 실시간·지연 시세는 KRX/코스콤 또는 승인 벤더 계약이 확인된 경우에만 활성화한다.
- 뉴스는 제목, 허용된 짧은 snippet, 매체, 발행 시각과 원문 링크만 저장한다. 기사 전문과 이미지는 별도 권리 없이 복제하지 않는다.
- 재무·실적은 SEC XBRL과 DART를 정본으로 보존하고 정규화 공급자는 보조로만 사용한다.
- Gemini는 서버 측 유료 티어를 운영 기본으로 하며 Provider Credential이 없으면 로컬 규칙 기반 요약으로 폴백한다. 개인정보, 계좌번호와 주문 비밀은 프롬프트에 포함하지 않는다.
- Alpaca·IBKR·KIS는 계좌 및 보유 종목 조회 어댑터를 제공하되 초기 릴리스에서 Live Trading 주문 실행 경로는 비활성화한다.
- 모든 데이터 레코드는 공급자, feed/venue, 기준 시각, 수신 시각, Data Freshness와 License Scope를 포함한다.

전체 근거와 공식 문서 링크는 [공급자 조사 보고서](../../../docs/research/provider-options.md)에 기록했다.
