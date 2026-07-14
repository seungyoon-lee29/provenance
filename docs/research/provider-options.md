# 금융 데이터·연동 공급자 조사

조사 기준일: 2026-07-14  
대상: 한국어 금융 터미널의 시장 데이터, 공시, 뉴스, AI 요약, Broker Connection  
조사 원칙: 공급자·거래소·규제기관의 공식 문서만 사용했다. 가격과 이용 한도는 바뀔 수 있으므로 계약 직전에 다시 확인해야 한다.

## 결론

초기 제품에는 다음 조합이 가장 현실적이다.

| 기능 | 내부 프로토타입 / Paper Trading | 공개 프로덕션 |
| --- | --- | --- |
| 미국 주식·ETF | Alpaca Basic의 실시간 IEX + 15분 지난 SIP 이력 | Massive 또는 Twelve Data의 **Business** 계약, 또는 Alpaca Broker API 계약 |
| 미국 지수·옵션 | Massive/Alpaca 무료·개인 플랜으로 개발 | 지수 제공자·OPRA 권리를 포함한 Business 계약 |
| 금리 | 미국 재무부 XML/CSV + FRED | 동일하되 원천 시리즈별 권리와 FRED 고지 준수 |
| 원자재·FX | Alpha Vantage/Twelve Data 소수 심볼, ECB 참조환율 | Twelve Data/Massive Business; 선물은 CME 권리 포함 여부 확인 |
| 한국 주식 | KRX 일별 Open API + 사용자 자신의 KIS Open API | 실시간·지연 시세 공개 표시는 KRX/코스콤 또는 승인된 벤더 계약 |
| 미국·한국 공시 | SEC EDGAR + Open DART | 그대로 사용하되 속도 제한, 출처, 원문 링크 유지 |
| 뉴스 | Alpaca/Benzinga 또는 News API 개발 플랜으로 평가 | Benzinga/News API 유료 라이선스; 기사 전문은 별도 권리 없이는 저장·재게시 금지 |
| 재무·실적 | SEC XBRL + DART를 정본으로 사용, Alpha Vantage는 정규화 보조 | 정본 보존 + 정규화 공급자 상업 계약 |
| AI | Gemini Developer API 무료 티어로 비민감 샘플 평가 | 유료 티어 + 서버 측 Auth key/Secret Manager; 무료 티어에 고객 데이터를 보내지 않음 |
| 주문 | 앱 자체 Paper Trading을 기본값으로 유지 | Live Trading 송신은 계속 비활성화하고 Alpaca/IBKR/KIS 어댑터·계좌 조회까지만 구현 |

가장 중요한 전제는 **API 접근권과 최종 사용자에게 데이터를 표시·재배포할 권리가 다르다**는 점이다. Alpaca는 API 데이터 재배포를 허용하지 않는다고 명시하며, Twelve Data 개인 플랜도 제3자 표시·재배포를 허용하지 않는다. KRX 실시간·지연 시세를 수익사업이나 재배포 프로그램에 쓰려면 별도 계약이 필요하다. 따라서 개발용 개인 키로 공개 터미널을 운영하면 안 된다. [Alpaca 재배포 안내](https://alpaca.markets/support/redistribute-alpaca-api), [Twelve Data 상업/개인 이용](https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage), [KRX 데이터 수신방법](https://openapi.krx.co.kr/contents/OPP/DATA/OPPDATA003.jsp)

## 후보별 평가

### 1. 미국 주식·ETF

#### Alpaca Market Data

- 인증: 대부분의 시장 데이터는 API key/secret이 필요하다. REST와 WebSocket을 모두 제공한다.
- 무료 상태: Basic은 미국 주식·ETF의 **실시간 IEX 단일 거래소** 데이터, WebSocket 30심볼, 분당 200회, 2016년 이후 이력을 제공한다. SIP 이력은 최신 15분을 제외하고 조회할 수 있다. `delayed_sip` WebSocket은 15분 지연이다.
- 유료 상태: Algo Trader Plus는 전 거래소 SIP, 최근 구간, 더 높은 REST 한도와 무제한 심볼 스트림을 제공한다.
- 실무 판단: 개인 개발 및 Paper Trading에는 매우 좋지만 IEX 가격을 “미국 시장 전체 실시간 가격”으로 표시하면 안 된다. 공개 제품 재배포에는 별도 권리가 필요하다. [Alpaca Market Data 플랜](https://docs.alpaca.markets/us/docs/about-market-data-api), [IEX와 SIP 차이](https://docs.alpaca.markets/us/docs/market-data-faq), [실시간 주식 WebSocket](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data)

#### Massive (구 Polygon.io)

- 인증: API key가 필요하며 REST, WebSocket, S3 호환 Flat Files를 제공한다.
- 범위: 미국 전 거래소·FINRA를 포함한 SIP 기반 주식, ETF, 지수, 옵션, FX, 선물, 뉴스/대체데이터를 한 스키마로 묶을 수 있다.
- 시점: 플랜에 따라 EOD, 15분 지연, 실시간이 갈린다. 지연 WebSocket과 실시간 WebSocket 주소도 분리된다.
- 라이선스: 개인 플랜은 개인·비상업 용도다. 사업용 약관은 제3자 데이터 계약과 표시/재배포 범위를 Order Form에 의존시키므로, 공개 터미널은 판매팀과 명시적으로 display/redistribution 권리를 계약해야 한다.
- 실무 판단: 미국 주식·ETF·지수·옵션을 하나의 프로덕션 공급자로 통합할 때 가장 강한 후보이나 무료 플랜을 공개 제품에 사용할 수는 없다. [주식 REST 개요](https://massive.com/docs/rest/stocks/overview), [WebSocket quickstart](https://massive.com/docs/websocket/quickstart), [개인 이용약관](https://massive.com/individuals-terms-of-service), [사업자 이용약관](https://massive.com/legal/businesses-terms-of-service)

#### Twelve Data

- 인증: API key가 필요하고 REST와 WebSocket을 제공한다.
- 무료 상태: Basic은 분당 8 credits, 하루 800 credits, 3개 시장, WebSocket 시험 심볼 8개 수준이다. 완전한 WebSocket 사용은 Pro부터다.
- 시점: REST 완성 캔들은 일반적으로 종가 후 0.3~2분, WebSocket tick은 상품에 따라 약 170ms까지로 안내한다.
- 라이선스: Basic/Grow/Pro/Ultra 개인 플랜은 재배포와 제3자 상업 표시를 허용하지 않는다. Business 플랜도 거래소 승인이나 별도 재배포 계약이 필요할 수 있다.
- 실무 판단: 여러 자산을 소수 심볼로 검증하기 좋고, 공개 제품은 Venture 이상 및 권리 확인이 필요하다. [API 문서](https://twelvedata.com/docs), [개인 플랜 가격](https://twelvedata.com/pricing), [데이터 지연](https://support.twelvedata.com/en/articles/5203307-data-delays), [상업/개인 이용](https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage)

### 2. 미국 지수

Massive가 가장 직접적인 후보다. 10,000개 이상의 지수를 REST, WebSocket, Flat Files로 제공하고 S&P, Nasdaq, Dow Jones, MSCI, FTSE Russell 등을 포괄한다. 그러나 지수 값은 주식 가격과 별도의 지식재산·표시 라이선스를 갖는 경우가 많다. 무료/개인 플랜의 존재가 상업 표시 권리를 뜻하지 않으며 Business 계약에서 지수군별 권리를 확인해야 한다. 지수를 추적하는 ETF 가격은 대체물이지만 실제 지수 값으로 표기해서는 안 된다. [Massive 지수 개요](https://massive.com/docs/rest/indices/overview), [Massive 지수 WebSocket](https://massive.com/docs/websocket/indices)

### 3. 금리

#### 미국 재무부

- 인증: 불필요하다.
- 제공: Daily Treasury Par Yield Curve, bill rates, real yield curve 등을 CSV와 XML feed로 공개한다.
- 시점/전송: 일별 공표 자료이며 실시간 채권 호가가 아니다. WebSocket은 없다.
- 실무 판단: 수익률 곡선 화면의 1차 정본으로 적합하다. 서버에서 일 1회 수집·캐시한다. [미국 재무부 일별 금리](https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve), [XML feed 명세](https://home.treasury.gov/treasury-daily-interest-rate-xml-feed)

#### FRED

- 인증: 등록된 32자리 API key가 필요하고 REST JSON/XML을 제공한다. WebSocket은 없다.
- 범위: 정책금리, 국채, SOFR, 경기·물가와 원자재 거시 시계열을 한 API에서 탐색하기 좋다.
- 라이선스: FRED 자체 약관 외에 각 시리즈 원소유자의 저작권·제약이 그대로 적용된다. 사용자 대상 앱에는 FRED API 사용 고지와 약관 링크가 필요하다.
- 실무 판단: 거시 시계열과 vintage 분석에는 최선이지만 “실시간 시장 데이터”가 아니다. [FRED API 개요](https://fred.stlouisfed.org/docs/api/fred/overview.html), [series observations](https://fred.stlouisfed.org/docs/api/fred/series_observations.html), [FRED API 약관](https://fred.stlouisfed.org/docs/api/terms_of_use.html)

### 4. 원자재

- Alpha Vantage: REST key 하나로 금·은 spot, 원유, 천연가스, 구리, 농산물과 거시 원자재 지수를 제공한다. 무료 한도는 하루 25회여서 화면 갱신용으로는 부족하다. 일부 원자재는 일·주·월 자료이며 실시간이 아니다. [Alpha Vantage 문서](https://www.alphavantage.co/documentation/), [무료 한도](https://www.alphavantage.co/support/)
- Twelve Data: 원자재·귀금속과 FX를 REST/WebSocket으로 함께 다룰 수 있지만 무료 WebSocket은 시험용이며 공개 표시는 Business 권리가 필요하다.
- Massive Futures: CME 계열 선물의 거래·호가·참조를 REST/WebSocket/Flat Files로 제공하는 통합 후보다. 선물 실시간과 외부 표시는 CME 라이선스가 핵심이므로 계약서에서 거래소 비용과 non-pro/pro 구분을 확인해야 한다. [Massive REST 자산 목록](https://massive.com/docs/rest)

추천은 초기에는 FRED/Alpha Vantage의 일별 원자재와 금·은만 제공하고, 실시간 선물은 프로덕션 데이터 계약 뒤 추가하는 것이다.

### 5. FX

- ECB Data Portal: SDMX 2.1 REST로 공식 유로 참조환율을 제공하며 공개 ESCB 통계는 출처 표기와 비변조 조건으로 상업·비상업 재사용이 가능하다. API key와 WebSocket은 없고, 참조환율은 거래 가능한 실시간 bid/ask가 아니다. [ECB API 개요](https://data.ecb.europa.eu/help/api/overview), [ESCB 통계 재사용 정책](https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html)
- Twelve Data Forex v2: key 기반 REST/WebSocket, 1,500개 이상 통화쌍, WebSocket mid-price 분 단위 업데이트를 제공한다. API 형태의 재배포에는 별도 계약이 필요하다. [Forex API v2](https://support.twelvedata.com/en/articles/12520817-forex-api-v2)
- Alpha Vantage: key 기반 REST 실시간 환율 endpoint가 있지만 무료 25회/일은 개발 확인용이다. [Alpha Vantage FX 문서](https://www.alphavantage.co/documentation/#currency-exchange)

### 6. 한국 주식

#### KRX Data Marketplace Open API

- 인증: 회원가입, 인증키 신청과 관리자 승인, 개별 API 활용 승인이 필요하다. REST JSON/XML이며 주요 Open API는 2010년 이후 **일별** 통계다.
- 범위: KOSPI/KOSDAQ 지수, 종목 일별 매매, ETF/ETN, 채권, 파생상품 등.
- 시점: 일반 Open API는 실시간 feed 대체물이 아니다. 실시간·20분 지연·종가 시세의 사업적 이용은 별도 데이터 상품/계약 영역이다.
- 라이선스: 개인의 단순 참고가 아닌 재배포 프로그램·수익사업은 별도 계약이 필요하고, 전문 사업자는 코스콤과 계약한다. 제3자가 저장·가공·재배포할 수 있는 API 제공은 특히 엄격히 제한된다.
- 실무 판단: 일별 시세와 종목 마스터의 공식 정본으로 사용하고, 공개 실시간 화면에는 사용하지 않는다. [KRX Open API 이용방법](https://openapi.krx.co.kr/contents/OPP/INFO/OPPINFO003.jsp), [서비스 목록](https://openapi.krx.co.kr/contents/OPP/INFO/service/OPPINFO004.cmd), [KRX 데이터 수신방법](https://openapi.krx.co.kr/contents/OPP/DATA/OPPDATA003.jsp), [정보 이용정책](https://data.krx.co.kr/inc/datasale/Market%20Data%20Usage%20Polices_ko.pdf)

#### 한국투자증권 KIS Open API

- 인증: 한국투자증권 계좌와 서비스 신청 후 실전·모의 App Key/App Secret을 따로 발급한다. REST는 access token, WebSocket은 접속키를 사용한다.
- 범위: 국내·해외 주식, ETF/ETN, 채권, 국내·해외 선물옵션의 시세·주문·잔고. REST와 WebSocket 공식 샘플이 있다.
- 한도: 2026-04-20 안내 기준 REST 실전은 계좌당 초당 18건, 모의는 초당 1건, token 발급은 초당 1건이다. WebSocket은 앱키당 1세션, 전체 상품 합산 41건 등록이다.
- 실무 판단: **연결한 사용자 자신의 계좌 화면과 주문 어댑터**에는 적합하다. 서비스 전체 사용자에게 한국 시세를 재배포하는 공용 feed로 간주하지 말고 제휴·시세 이용 권리를 별도로 확인한다. [KIS 포털](https://apiportal.koreainvestment.com/intro), [공식 샘플 저장소](https://github.com/koreainvestment/open-trading-api), [호출 유량 안내](https://apiportal.koreainvestment.com/community/10000000-0000-0011-0000-000000000001/post/d0d1a83f-6f8d-4437-9700-6d26702fd989)

### 7. SEC EDGAR

- 인증: `data.sec.gov`의 submissions 및 XBRL API는 API key 없이 REST JSON으로 접근한다.
- 시점: submissions는 보통 1초 미만, XBRL은 보통 1분 미만 지연으로 갱신된다. 대량 자료는 nightly ZIP이 더 효율적이다.
- 제약: CORS를 지원하지 않으므로 백엔드에서 호출한다. SEC는 전체 시스템 합산 초당 10회 이하를 요구하며, 조직과 연락처를 식별하는 User-Agent와 backoff/cache가 필요하다.
- 실무 판단: 미국 공시와 표준 재무 수치의 무료 정본이다. 문서 원문 URL, accession number, filed/accepted 시각을 보존한다. [SEC EDGAR API](https://www.sec.gov/search-filings/edgar-application-programming-interfaces), [SEC rate control](https://www.sec.gov/filergroup/announcements-old/new-rate-control-limits), [SEC Webmaster FAQ](https://www.sec.gov/about/webmaster-frequently-asked-questions)

### 8. Open DART

- 인증: 회원가입 후 40자리 인증키가 필요하다. REST GET으로 JSON/XML과 원문 ZIP을 제공한다.
- 범위: 공시 목록·원문, 주요 공시, 정기보고서 주요정보, 단일/다중회사 재무제표·지표, 지분공시.
- 요금/한도: 원칙적으로 무료이며 일반적으로 일 20,000건 이상 요청 시 제한 오류가 발생하지만 API별 제한은 다를 수 있다.
- 라이선스/보안: 약관은 ID·비밀번호·인증키의 제3자 이용과 고의 유출을 금지하며, 허용량과 서비스 내용은 변경될 수 있다.
- 실무 판단: 한국 공시·재무의 정본이다. corp code 파일을 주기적으로 동기화하고 보고서 번호·접수일·원문 링크를 유지한다. [Open DART 소개](https://opendart.fss.or.kr/intro/main.do), [개발가이드 예시](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS004&apiId=2019021), [이용약관](https://opendart.fss.or.kr/intro/terms.do)

### 9. 뉴스

#### Alpaca News / Benzinga

Alpaca는 Benzinga 원천의 과거 뉴스 REST와 실시간 뉴스 WebSocket(`v1beta1/news`)을 제공한다. 주식 심볼 연결이 쉬워 개인 프로토타입에 유리하지만 Alpaca 데이터 재배포 금지와 Benzinga 콘텐츠 권리가 함께 적용될 수 있다. 프로덕션에서는 Benzinga와 직접 라이선스를 협의하는 편이 명확하다. Benzinga는 REST와 실시간 WebSocket/TCP를 제공하고 시작 단계에서 licensing 팀 접촉을 요구한다. [Alpaca 과거 뉴스](https://docs.alpaca.markets/us/docs/historical-news-data), [Alpaca 실시간 뉴스](https://docs.alpaca.markets/us/docs/streaming-real-time-news), [Benzinga WebSocket](https://docs.benzinga.com/ws-reference/overview), [Benzinga 시작 안내](https://docs.benzinga.com/introduction/introduction)

#### News API

- 인증/프로토콜: API key 기반 REST JSON. WebSocket은 없다.
- 무료 상태: Developer는 24시간 지연, 하루 100회이며 localhost 개발·테스트에만 쓸 수 있고 staging/production도 금지된다.
- 프로덕션: Business는 실시간 기사 메타데이터와 월 quota를 제공하지만 기사 전문은 제공하지 않는다.
- 저작권: 원출처·저작권 표기를 유지하고, 권리 없이 저작물을 재게시하거나 경쟁 뉴스 DB를 만들 수 없다.
- 실무 판단: 소스 탐색과 헤드라인 링크 UI 평가에는 좋지만, 한국어 금융 뉴스 품질과 상업권은 계약 전 샘플 평가가 필요하다. [News API 가격](https://newsapi.org/pricing), [Top headlines 문서](https://newsapi.org/docs/endpoints/top-headlines), [News API 약관](https://newsapi.org/terms)

제품에는 제목, 매체, 발행시각, 원문 링크, 짧은 허용 snippet만 저장하고 기사 전문·이미지는 명시적 권리 없이는 복제하지 않는다. AI 요약도 원문 취득권과 파생물 조건을 면제하지 않는다.

### 10. 옵션

- Alpaca Basic: 옵션 계약/체인과 indicative feed, REST 및 WebSocket을 제공한다. 유료 플랜은 OPRA 실시간·최근 15분 제한 해제를 제공한다. Paper Trading 옵션도 가능하다.
- Massive: OPRA 직결 전 시장 옵션 trades/quotes/aggregates, 체인, Greeks/IV/OI, REST/WebSocket/Flat Files를 제공한다. 개인 실시간 플랜은 OPRA의 non-professional 분류를 요구하고 사업자는 Business 계약이 필요하다.
- 실무 판단: 개발은 Alpaca indicative 또는 15분 지연, 공개 실시간 옵션판은 OPRA 권리를 포함한 Massive/Alpaca 사업 계약 후 활성화한다. 옵션 가격에는 반드시 `indicative`, `15분 지연`, `OPRA 실시간` 배지를 표시한다. [Alpaca 옵션 데이터 플랜](https://docs.alpaca.markets/us/docs/about-market-data-api), [Alpaca 옵션 WebSocket](https://docs.alpaca.markets/us/docs/real-time-option-data), [Massive 옵션 REST](https://massive.com/docs/rest/options/overview), [Massive 옵션 WebSocket](https://massive.com/docs/websocket/options/overview), [OPRA pro/non-pro 분류](https://massive.com/knowledge-base/article/what-are-pro-and-non-pro-classifications-for-massives-options-date)

### 11. 재무·실적

1차 정본은 미국 SEC XBRL `companyfacts`와 한국 DART 재무제표다. 둘 다 보고 회사가 제출한 사실을 추적할 수 있어 감사 가능성이 높다. 공급자별 정규화 데이터는 taxonomy mapping, TTM 계산, 통화·분할 처리에서 차이가 날 수 있으므로 정본 accession/report number를 함께 저장해야 한다.

Alpha Vantage는 회사 overview, 손익/대차대조표/현금흐름, earnings, earnings calendar를 단일 REST key로 제공하고 재무 데이터가 일반적으로 회사 발표 당일 갱신된다고 안내한다. 그러나 무료 25회/일은 온디맨드 터미널에 부족하고 실시간·15분 지연 미국 시세와 상업 이용은 별도 유료 권리가 필요하다. 따라서 초기에는 야간 정규화 보조로만 쓰고, 화면의 핵심 수치는 SEC/DART와 대조한다. [Alpha Vantage 문서](https://www.alphavantage.co/documentation/), [Alpha Vantage 가격/무료 한도](https://www.alphavantage.co/premium/)

### 12. Gemini API

- 접근: Google AI Studio/Cloud project에서 key를 발급하고 REST 또는 공식 SDK로 호출한다. 스트리밍 응답과 별도의 Live API WebSocket이 있다.
- 무료 티어: 모델별 제한 안에서 무료지만 입력/출력이 Google 제품 개선에 사용될 수 있다.
- 유료 티어: 더 높은 production limit을 제공하며 입력/출력을 제품 개선에 사용하지 않는다고 가격표에 명시한다. 실제 한도는 model·project·usage tier별로 AI Studio에서 확인한다.
- 2026 보안 변화: 새 키는 서비스 계정에 묶인 Auth key가 기본이며, unrestricted standard key는 거부되고 2026년 9월 standard key 전체 종료가 예정돼 있다.
- 실무 판단: 뉴스·공시 요약은 서버에서 유료 티어를 사용하고, 계좌번호·주문 토큰·API secret·불필요한 개인정보는 프롬프트에 넣지 않는다. 모델 결과에는 근거 공시/뉴스 링크와 생성 시각을 붙이고 투자 조언으로 단정하지 않는다. [Gemini 가격](https://ai.google.dev/gemini-api/docs/pricing), [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [API key 보안](https://ai.google.dev/gemini-api/docs/api-key)

## Broker Connection 평가

### Alpaca

- Paper Trading은 전 세계 이메일 가입이 가능하고 무료 실시간 IEX를 쓰며, live와 별도 key·도메인(`paper-api`)을 사용한다. 주문은 실제 거래소로 라우팅되지 않고 시장충격·queue position·규제비용·배당 등을 시뮬레이션하지 않는다.
- 본인 계좌 자동화는 key/secret, 다중 사용자 연결은 OAuth 2.0 Connect API가 맞다. live trading을 다른 사용자에게 제공하려면 Alpaca 승인과 상업 앱 공개가 필요하다.
- REST 주문/계좌와 WebSocket trade updates를 제공한다. OAuth `state`, 정확한 redirect URI, 최소 scope를 사용하고 refresh/access token은 서버에서 암호화 보관한다.
- 적합성: 미국 주식 Paper Trading 첫 연동에 가장 단순하다. [Paper Trading](https://docs.alpaca.markets/us/docs/paper-trading), [Connect API](https://docs.alpaca.markets/us/docs/about-connect-api), [OAuth 연동](https://docs.alpaca.markets/us/docs/using-oauth2-and-trading-api), [주문 WebSocket](https://docs.alpaca.markets/us/docs/websocket-streaming)

### Interactive Brokers

- Web API는 REST와 WebSocket으로 계좌·포트폴리오·시장 데이터·주문을 제공한다. 개인 사용은 개설·funded 상태의 IBKR Pro live 계좌가 필요하고, 데모 계좌는 데이터 구독을 할 수 없다.
- 시장 데이터는 상품별 유료 구독·거래 권한·brokerage session이 필요하다. 기본 동시 market data lines는 100이며, forex/crypto 외 대부분은 Level 1 구독이 필요하다.
- 개인 Client Portal Gateway는 로컬 Java gateway와 재인증/2FA, 한 사용자당 하나의 brokerage session 제약이 있다. OAuth 기반 제3자 앱은 IBKR Compliance 승인과 사업체·공개 제품 정보가 필요하다.
- 2026-04-14 변경으로 Web API의 `smd` WebSocket 요청은 10분 뒤 종료되므로 재구독 설계가 필요하다.
- 적합성: 다자산·글로벌 사용자에게 강하지만 인증·세션·권한 복잡도가 높아 두 번째 어댑터가 적절하다. [IBKR Web API v1](https://ibkrcampus.com/campus/ibkr-api-page/cpapi-v1/), [통합 Web API 문서](https://ibkrcampus.com/campus/ibkr-api-page/webapi-doc/), [시장 데이터 구독](https://ibkrcampus.com/campus/ibkr-api-page/market-data-subscriptions/), [2026 changelog](https://ibkrcampus.com/campus/ibkr-api-page/web-api-changelog/)

### 한국투자증권

KIS는 한국 거주 사용자의 국내·해외 자산 계좌 조회와 주문에 가장 직접적이다. 실전/모의 app key를 물리적으로 분리하고, REST token·WebSocket approval key·계좌번호를 사용자별 암호화 저장한다. 계좌당 낮은 호출 한도 때문에 polling보다 WebSocket을 우선하고, token을 호출마다 새로 발급하지 않는다. 공용 시세 공급자와 사용자별 Broker Connection을 같은 자격증명으로 합치지 않는다. 공식 샘플은 `kis_devlp.yaml`에 개인정보 입력이 필요하다고 명시하므로 이를 저장소에 복사하지 말고 운영 secret store로 대체한다. [KIS 공식 저장소](https://github.com/koreainvestment/open-trading-api), [KIS 포털](https://apiportal.koreainvestment.com/intro)

## 프로덕션 보안·운영 체크리스트

1. 모든 공급자 호출은 백엔드에서 수행한다. SEC처럼 CORS가 없는 API뿐 아니라, key가 있는 모든 API를 브라우저에서 직접 호출하지 않는다.
2. 개발·staging·production과 Paper Trading·Live Trading의 자격증명을 각각 분리한다. live key가 paper 프로세스에 로드되지 않게 배포 단위에서 차단한다.
3. secret은 KMS/Secret Manager에 저장하고 로그, 오류 추적, 분석 이벤트, LLM 프롬프트에서 마스킹한다. 회전·폐기·유출 감지 절차를 둔다.
4. 데이터 레코드에 `provider`, `feed`, `venue`, `asOf`, `receivedAt`, `delayClass`, `licenseScope`를 저장한다. UI에는 실시간/지연/EOD와 IEX/SIP/OPRA/KRX 출처를 표시한다.
5. rate limit은 공급자별 token bucket, 지수 backoff, jitter, circuit breaker, 서버 캐시로 지킨다. SEC는 전체 초당 10회 미만, KIS는 계좌별 한도를 하드코딩하지 말고 설정값으로 관리한다.
6. 뉴스 전문과 시장 tick 원본의 보관 기간·다운로드·재전송 범위를 계약서와 일치시킨다. 데이터 export/API 기능은 화면 표시 권리보다 넓은 재배포로 판단될 수 있다.
7. 주문 API는 idempotency key, 금액/수량 상한, 가격 stale 검사, 시장 상태 검사, kill switch, 감사 로그, 사용자 이중 확인을 갖춘다. 초기 릴리스에서는 Live Trading 주문 전송 코드를 feature flag만으로 숨기지 말고 실행 경로 자체를 비활성화한다.
8. 공급자 장애·권리 만료 시 fallback은 더 오래된 데이터를 “실시간”처럼 보여주지 않고 명시적으로 stale 처리한다.

## 권장 도입 순서

1. SEC EDGAR, Open DART, 미국 재무부, ECB처럼 권리가 명확한 공공 정본을 먼저 연결한다.
2. Alpaca Paper Trading + Basic IEX로 미국 주식 UX와 주문 상태 모델을 검증한다.
3. KRX 일별 Open API로 한국 종목·EOD를 넣고, KIS 모의 계좌는 사용자별 Broker Connection으로 분리한다.
4. Gemini 유료 티어를 서버 측에 연결해 공시 요약을 추가한다. 요약은 항상 정본 링크를 포함한다.
5. 공개 베타 전에 Massive/Twelve Data, KRX/코스콤, 뉴스 공급자와 display/redistribution 계약을 체결한다.
6. 계약된 feed만 실시간으로 활성화하고 옵션·선물·Live Trading은 별도의 안전성 및 규제 검토 뒤 진행한다.
