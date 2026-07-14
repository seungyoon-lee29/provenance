# 공개 운영 데이터·뉴스 공급자 예산과 계약 게이트

- 조사 기준일: 2026-07-14
- 대상: 비로그인 사용자가 있는 한국어 금융 터미널의 시장 데이터와 미국 뉴스
- 역할: [`provider-options.md`](./provider-options.md)의 후보 조사를 대체하지 않고, 단계별 계약과 월 예산 결정을 보충한다.

## 현재 적용 결정

2026-07-14 사용자 결정에 따라 외부 데이터·뉴스·AI 공급자 구독비는 **USD 0/월**로 고정하고 모든 유료 도입을 보류한다. Alpaca Basic의 IEX·주식 이력·indicative option·Paper Trading과 KIS의 개인 시세·차트·계좌·모의투자 capability를 개인 개발과 사용자 자신의 연결에서 적극 사용하되 비로그인 공용 feed로 전환하지 않는다. Gemini 무료 key는 시장·뉴스·공시·차트·Actual/Paper Portfolio와 주문 문맥을 포함한 모든 지원 자료 유형에 사용할 수 있다. 자료 유형만으로 차단하지 않지만 Viewer Context, 원천의 외부 모델 처리·파생물 License Scope, 최소화와 비밀 redaction은 독립적으로 적용한다. 공개 화면은 SEC EDGAR, Open DART, 미국 재무부, ECB와 승인 범위가 확인된 KRX EOD 같은 무료 정본만 활성화한다. 무료로 표시권을 충족할 수 없는 미국 실시간 시세·지수·옵션·뉴스와 한국 실시간 시세는 `API 필요` 또는 `표시 권한 없음`을 반환한다.

아래 가격과 계약 조합은 유료 전환을 다시 결정할 때 참고할 보류 자료다. 현재 구현·배포의 활성 provider 목록이나 구매 계획이 아니다.

## 유료 전환 시 결론

초기 공개 운영에는 **Twelve Data Business Venture + Benzinga 직접 뉴스·한국어 번역 계약 + 공공 원천 데이터**를 권한다. News API Business는 링크형 뉴스 발견의 비용 절감 대안일 뿐, 원문·이미지·한국어 번역 요구를 충족하지 못한다. 다음 기능은 각각의 주문서에서 명시적으로 허용돼야 한다.

- 한국 실시간·지연 시세 공개
- 실제 미국 지수 값과 실시간 옵션 거래·호가
- 뉴스 기사 전문, 이미지, 한국어 번역·요약과 장기 보관
- 사용자가 내려받거나 다른 시스템이 호출하는 데이터 API

따라서 제한 베타에서 확정 가능한 공개 **플랫폼 구독 기준선**은 Twelve Data Venture의 **USD 149~499/월 + 세금**뿐이다. Twelve Data US Equities/Redistribution Rights Add-On, Benzinga 뉴스·한국어 번역, 한국 시세는 모두 **영업 견적 필요**라서 실제 공개 출시 총액은 아직 확정할 수 없다. News API Business `USD 449/월`을 링크형 메타데이터 대안으로 선택하면 알려진 플랫폼 비용은 `USD 598~948/월`이 되지만, 이것만으로 번역·요약 권리가 생기지는 않는다. [Twelve Data Business 가격](https://twelvedata.com/pricing-business), [미국 주식 권리 안내](https://support.twelvedata.com/en/articles/9935903-us-equities-market-data), [News API 가격](https://newsapi.org/pricing)

추천 계약 주체는 개인이 아니라 **서비스 운영 법인**이다. 개인용 Alpaca·KIS·Alpha Vantage 키는 본인 개발과 계좌 연결에만 사용하고, 비로그인 화면의 공용 feed로 사용하지 않는다.

## API 접근권과 표시권은 별개다

| 공급자/원천 | API 접근 | 공개 화면 표시 | 재배포·파생물 주의 |
| --- | --- | --- | --- |
| Alpaca Trading API | 개인 개발자는 Basic `USD 0/월`, Algo Trader Plus `USD 99/월` | 개인 API 데이터의 재배포는 허용되지 않음 | 공개 앱은 Broker API/사업 계약을 별도 협의해야 함. [플랜](https://docs.alpaca.markets/us/docs/about-market-data-api), [재배포 안내](https://alpaca.markets/support/redistribute-alpaca-api) |
| Twelve Data Business | Basic은 내부 비표시 시험, Venture부터 외부 표시 | Venture는 client-facing 외부 표시, Enterprise는 외부 distribution을 명시 | 익명 웹과 backend→browser 전달이 기본 display인지 redistribution인지 서면 확인한다. 미국 주식 외부 제공에는 별도 Rights Add-On이 필요할 수 있고 미국 외 가격 데이터도 추가 승인이 필요하다. [가격](https://twelvedata.com/pricing-business), [상업 이용](https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage), [미국 주식 권리](https://support.twelvedata.com/en/articles/9935903-us-equities-market-data) |
| News API | Developer `USD 0`, Business `USD 449/월` | Developer는 localhost 개발 전용이고 staging도 금지, Business는 프로덕션 가능 | 기사 전문은 제공하지 않으며 제3자 저작권을 부여하지 않는다. 번역·요약 권리는 원출처 또는 뉴스 공급자와 별도 확인해야 함. [가격](https://newsapi.org/pricing), [약관](https://newsapi.org/terms) |
| KIS Open API | 사용자 결정상 구독비 `USD 0`의 개인 실전·모의 REST/WebSocket; 공식 가격표는 미확인 | 개인 시세는 본인 자산 투자 목적만 가능하고 제3자 제공 불가 | 시세·차트·계좌·모의투자를 개인 연결에 사용한다. 제휴법인도 화면 표출 전에 KRX·코스콤 시세 계약이 필요하다. [이용 대상](https://apiportal.koreainvestment.com/about-open-api), [API 카탈로그](https://apiportal.koreainvestment.com/apiservice-category) |
| KRX Open API | 인증키와 API별 활용 승인 필요 | 승인된 신청 목적 안에서만 사용 | 일별 통계 중심이며 공개 실시간 feed가 아니다. 외부 베타는 신청서에 이용자·화면·과금 여부를 적고 서면 승인을 받아야 한다. [신청 절차](https://openapi.krx.co.kr/contents/OPP/INFO/OPPINFO003.jsp), [서비스 목록](https://openapi.krx.co.kr/contents/OPP/INFO/service/OPPINFO004.cmd), [약관](https://openapi.krx.co.kr/contents/OPP/INFO/OPPINFO002.jsp) |
| FRED API | 무료 키 발급 가능 | 시리즈 소유자 권리가 각각 다름 | 현행 약관은 FRED 콘텐츠의 캐시·보관과 AI/ML 사용을 제한한다. 프로덕션 정본으로 일괄 사용하지 말고 원기관 API를 우선한다. [현행 FRED 약관](https://fred.stlouisfed.org/legal/terms/), [API key](https://fred.stlouisfed.org/docs/api/api_key.html) |

`API 호출 성공`은 `License Scope가 공개 표시를 허용함`을 뜻하지 않는다. 서버는 요청 목적별로 `내부 개발`, `사용자 개인 조회`, `공개 표시`, `재배포`, `외부 모델 처리`, `번역·요약`을 따로 판정해야 한다.

## 단계별 권장 조합

### 1. 개발·비공개 테스트

공급자 구독 예산: **USD 0/월**. 현재 활성 AI 경로도 사용자가 제공한 Gemini 무료 tier만 사용하며 paid Gemini 전환은 보류한다. 자체 호스팅 인프라 비용은 이 문서의 공급자 구독 예산 범위 밖이다.

| 자산 | 권장 원천 | 표시 방식과 제한 |
| --- | --- | --- |
| 미국 주식·ETF | 기존 Alpaca Basic | 실제 IEX 실시간 값으로 표시하되 `IEX` 배지 사용. 미국 전체 SIP로 표현하지 않고 외부 사용자에게 재배포하지 않음 |
| 미국 지수 | 권리가 확인된 feed가 없으면 연결하지 않음 | SPY·QQQ 같은 ETF는 `지수 대용`이 아니라 별도 ETF로 표시. 실제 지수 패널은 `API 필요` |
| 미국 옵션 | Alpaca Basic indicative feed | `indicative` 배지 필수. OPRA 실시간으로 표현하지 않음 |
| 한국 주식 | KIS 개인 시세·차트·계좌·모의투자 + 승인된 KRX Open API | KIS는 개발자 본인 범위에서 endpoint별 지연 배지, KRX는 일별 통계만 `EOD`로 표시 |
| 금리 | 미국 재무부 일별 수익률 | API key 없이 원기관 데이터를 수집하고 `일별`로 표시. [미국 재무부 금리](https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve) |
| FX | ECB 유로 참조환율 | 무료 재사용 정책을 따르고 `참조환율·일별`로 표시. 거래 가능한 실시간 bid/ask가 아님. [ECB 재사용 정책](https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html) |
| 원자재 | Alpha Vantage 무료 또는 Twelve Data 시험 | Alpha Vantage 무료는 25회/일이며 개인·비상업 평가만. 공개 상업 이용은 영업 계약 필요. [문서](https://www.alphavantage.co/documentation/), [약관](https://www.alphavantage.co/terms_of_service/) |
| 미국 뉴스 | News API Developer 또는 entitlement probe가 성공한 개인 Alpaca News | 로컬·개인 개발만. News API Developer는 24시간 지연·100회/일이고 staging/production도 금지. Alpaca News도 재배포하지 않고 기사 전문을 공용 저장하지 않음. [News API 가격·제약](https://newsapi.org/pricing), [Alpaca 뉴스](https://docs.alpaca.markets/us/docs/historical-news-data) |

### 2. 제한 베타(유료 전환 시)

초대 사용자라도 제3자에게 보이면 `외부 표시`다. 개인 플랜을 쓰지 않는다.

| 자산 | 권장 조합 | 공개 가격 | 계약 게이트 |
| --- | --- | --- | --- |
| 미국 주식·ETF, FX, 일부 금리·원자재 | Twelve Data Business Venture | 610 API + 500 WS `USD 149/월`, 1,597 + 1,500 `USD 299/월`, 2,584 + 2,500 `USD 499/월`; US Equities Rights Add-On은 영업 견적 | 외부 display가 표기돼도 익명 웹, backend→browser 전달, 캐시, attribution과 Add-On 적용을 서면 승인받음. 기본 미국 실시간 feed는 전체 거래량 약 5%의 비통합 feed이므로 `전 시장 SIP`로 표시하지 않음. FX v2 WebSocket도 1분 단위 mid-price이므로 거래 가능한 bid/ask로 표현하지 않음. [가격](https://twelvedata.com/pricing-business), [미국 주식 피드](https://support.twelvedata.com/en/articles/9935903-us-equities-market-data), [FX v2](https://support.twelvedata.com/en/articles/12520817-forex-api-v2) |
| 미국 지수 | Twelve Data에 필요한 지수 심볼의 display 권리 견적 요청 | 영업 견적 필요 / 별도 지수 비용 가능 | 권리 확인 전 실제 지수 값 비활성. ETF를 지수로 표기하지 않음. [상업 이용](https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage) |
| 미국 옵션 | 계약 전 비활성 | 영업 견적 필요 / OPRA 비용 가능 | 체인·Greeks·거래·호가별 entitlement를 분리. `데이터 없음` 또는 `API 필요` 표시. [OPRA 문서](https://www.opraplan.com/document-library) |
| 한국 주식 | 승인된 KRX 일별 통계 | 공개 금액 없음 | 신청 목적에 외부 베타를 명시하고 승인된 범위만 `EOD`로 표시. KIS 개인 키는 사용 금지. [KRX 신청 절차](https://openapi.krx.co.kr/contents/OPP/INFO/OPPINFO003.jsp), [KIS 이용 대상](https://apiportal.koreainvestment.com/about-open-api) |
| 금리·공식 FX | 미국 재무부 + ECB | `USD 0` | 공표 주기와 원출처를 표시. FRED를 캐시·AI 경로의 정본으로 사용하지 않음. [Treasury XML](https://home.treasury.gov/treasury-daily-interest-rate-xml-feed), [ECB 재사용 정책](https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html) |
| 미국 뉴스·한국어 번역 | Benzinga 평가 key + 명시적 베타 display/translation 라이선스 | 영업 견적 필요 | `Stock News API + Korean Translation Engine`을 함께 견적. 평가 key만으로 공개하지 않고, Gemini 전송·요약·감성·보존은 별도 명시. [뉴스 상품](https://www.benzinga.com/apis/in/cloud-product/stock-news-api/), [한국어 번역](https://www.benzinga.com/apis/cloud-product/korean-translation-engine/) |
| 링크형 뉴스 대안 | News API Business | `USD 449/월`, 250,000회/월, 초과 `USD 0.0018/회` | 제목·매체·시각·허용 snippet·원문 링크 중심. 기사 전문은 없음. 한국어 번역·요약은 별도 권리 확인 전 비활성. [가격](https://newsapi.org/pricing), [약관](https://newsapi.org/terms) |

확정 가능한 플랫폼 비용은 **USD 149~499/월 + 세금**이다. 링크형 News API를 선택하면 **USD 598~948/월**이지만, 어느 경우에도 Twelve Data US Equities/Redistribution Rights Add-On, 한국 실시간 시세, 실제 지수·옵션과 Benzinga 번역 뉴스 계약은 포함되지 않는다. 따라서 이 숫자만 승인하고 외부 베타를 열면 안 된다.

### 3. 공개 프로덕션(유료 전환 시)

#### 권장: 표시 전용의 작은 공개 서비스

- Twelve Data Venture 표준 `USD 499/월`을 유지하되 US Equities/Redistribution Rights Add-On을 별도 견적받는다. 익명 브라우저 표시, 서버 캐시와 attribution 위치를 주문서에 명시하고 사용자에게 원시 데이터 다운로드/API를 제공하지 않는다. [가격](https://twelvedata.com/pricing-business), [미국 주식 권리](https://support.twelvedata.com/en/articles/9935903-us-equities-market-data)
- SLA, 더 큰 credit, 외부 distribution이 필요하면 Enterprise `USD 1,099/월` 또는 연 `USD 10,992`로 올린다. 단, `Enterprise`도 모든 거래소 권리를 자동 포함한다는 뜻은 아니다. [Twelve Data Business 가격](https://twelvedata.com/pricing-business)
- Benzinga `Stock News API + Korean Translation Engine`을 직접 계약한다. 공식 상품은 기사 전체·이미지·실시간 뉴스와 한국어 금융 번역을 제공한다고 안내하지만 가격, 쿼터, 공개 사용자 수, 캐시와 파생 권리는 모두 영업 계약 대상이다. Gemini로 자체 분석할 때는 외부 모델 전송·no-training·파생 결과 공개 권리도 넣는다. [Stock News API](https://www.benzinga.com/apis/in/cloud-product/stock-news-api/), [한국어 번역](https://www.benzinga.com/apis/cloud-product/korean-translation-engine/), [AI·LLM 데이터 상품](https://www.benzinga.com/apis/datasets-for-training-llms-and-ai-applications/)
- News API Business `USD 449/월`은 Benzinga 계약 전 링크형 뉴스 발견이 꼭 필요할 때만 사용한다. 기사 전문·이미지·번역·Gemini 요약은 비활성화한다. [가격](https://newsapi.org/pricing), [약관](https://newsapi.org/terms)
- 한국 공개 시세는 운영 법인이 코스콤과 KRX 정보이용계약을 체결한다. 비로그인 체결가 화면은 `웹사이트 체결가서비스`, 로그인 개인 화면과 실시간 파생 계산은 각각 소매사업·비조회형 이용 범위를 견적서에 넣는다. 현재 공식 공개 가격표는 없어 **영업 견적 필요**다. [KRX/Koscom 정보이용정책](https://data.krx.co.kr/inc/datasale/Market%20Data%20Usage%20Polices_ko.pdf), [코스콤 계약 절차](https://koscom.gitbook.io/open-api/how-to-use/procedure)
- 한국의 KRX와 NXT 체결을 모두 다루면 NEXTRADE 정보이용계약과 전송 비용을 별도 견적한다. [NXT 데이터 상품](https://portal.nextrade.co.kr/mdclient/member/custom/productOutline.do?menuId=ProdOut), [계약 절차](https://portal.nextrade.co.kr/mdclient/member/cntrct/procedure.do?menuId=ducprocess)

공개 가격으로 확정 가능한 **시장 데이터 플랫폼 기준선**은 Venture라면 **USD 149~499/월**, Enterprise라면 **USD 1,099/월**이다. 링크형 News API를 추가할 때만 각각 `USD 598~948/월`, `USD 1,548/월`이 된다. 어느 숫자도 Twelve Data의 별도 Rights Add-On, 한국 실시간, Benzinga 뉴스·번역 권리, 실제 지수와 옵션을 포함하지 않으므로 공개 출시 총액으로 쓰지 않는다.

#### 확장: 실제 미국 지수·옵션

먼저 Twelve Data에 필요한 심볼의 상업 표시 권리와 거래소 add-on을 한 번에 견적받는다. 권리나 품질이 부족하면 Massive를 자산별로 추가한다.

| Massive 사업 상품 | 공식 월 가격 | 포함과 한계 |
| --- | --- | --- |
| Indices Business | `USD 2,500/월` | 실제 지수 값. 지수군별 최종 License Scope는 주문서 확인. [공식 상품](https://massive.com/business-indices) |
| Options Business | `USD 1,999/월` | 실시간 proprietary FMV, Greeks/IV, EOD trades/quotes. 실제 OPRA 거래·호가는 별도 expansion. [공식 가격](https://massive.com/business-options) |
| Options Full Market Delayed | `USD 499/월` 추가 | 전 시장 거래·호가 15분 지연 |
| Options Full Market | `USD 1,999/월` 추가 | 전 시장 실시간 거래·호가 |
| Stocks Business | `USD 1,999/월` | 실시간 proprietary FMV 기반 상품. 실제 SIP trades/quotes와 같지 않음. [공식 상품](https://massive.com/business-stocks) |
| Stocks Full Market Delayed | `USD 499/월` 추가 | 전 시장 실제 trades/quotes 15분 지연 |
| Stocks Full Market | `USD 1,999/월` 추가 | 전 시장 실시간 trades/BBO |
| Currencies Business | `USD 999/월` | 실시간 FX·crypto 사업 상품. [공식 가격](https://massive.com/business-currencies) |
| Futures Business | CME·CBOT·NYMEX·COMEX 각 `USD 999/월`; 4개 `USD 3,996/월` | 사업용 공급자 가격과 별도로 거래소 계약·비용이 붙을 수 있다. Order Form에서 공개 display, AI/non-display와 보존을 확인. [공식 선물 상품](https://massive.com/business-futures), [사업 약관](https://massive.com/legal/businesses-terms-of-service) |

Twelve Data 표준 `USD 499`를 유지하며 Massive 지수와 옵션을 추가하면 알려진 공급자 비용은 뉴스 제외 시 **USD 5,497/월**(옵션 15분 지연) 또는 **USD 6,997/월**(옵션 실시간)이다. 링크형 News API Business까지 포함하면 각각 **USD 5,946/월**, **USD 7,446/월**이다. 이는 한국 시세, Benzinga 번역·파생물 권리, 세금과 별도 거래소 비용을 포함하지 않은 비교 기준일 뿐이다.

Massive만으로 주식·옵션·지수를 모두 구성한 공개 카탈로그 단순 합계는 주식·옵션 15분 지연이 **USD 7,496/월**, 두 시장 모두 전 시장 실시간이면 **USD 10,496/월**이다. 이 값도 익명 표시, 한국 사용자, 지수 제공자, 보존·파생지표와 거래소 비용을 확정한 최종 견적이 아니다.

OPRA와 직접 Vendor 계약을 하는 경로는 초기 제품에 권하지 않는다. 공식 Fee Schedule에는 기본 재배포료 `USD 1,500/월`, query-only `USD 650/월`, non-professional 사용자 최대 75,000명 구간 `USD 1.25/가입자/월`, professional display `USD 31.50/device 또는 적격 User ID/월`가 공개돼 있다. 자동 갱신 터미널은 요청 시에만 표시하고 auto-refresh가 없어야 하는 query-only 조건에 맞지 않을 가능성이 높다. 지연 데이터도 외부 배포 주체의 Vendor 의무가 남으며 화면에 최소 15분 지연임을 표시해야 한다. [OPRA Fee Schedule](https://cdn.opraplan.com/documents/OPRA_Fee_Schedule.pdf), [Vendor Agreement](https://cdn.opraplan.com/documents/OPRA_Vendor_Agreement.pdf), [Hosted Solution 정책](https://cdn.opraplan.com/documents/OPRA_Policy_With_Respect_To_Hosted_Solutions.pdf)

옵션 MVP는 OPRA 승인 upstream vendor의 15분 지연 Hosted Solution/display 라이선스를 먼저 견적받는다. 익명 실시간 옵션은 열지 않고, 이후 로그인 사용자에게만 professional/non-professional 자격 분류와 계약·월별 reporting을 구현한 뒤 활성화한다. 옵션을 AI 분석, 포트폴리오 평가나 주문 검증에 쓰면 display 외 `Non-Display Use`가 될 수 있으므로 서면 확인한다.

CME 선물은 더 비싸다. 2026년 공식 fee list에는 거래소별 실시간 distribution `USD 29,280/년`, delayed distribution `USD 21,840/년`, historical distribution `USD 35,220/년`, Public Website `USD 487/월/site`가 공개돼 있다. Public Website 방식은 실시간 스트림이 아니라 매시 스냅샷을 최소 10분 지연해 게시하는 제한형이고 machine-readable download와 AI/ML 입력도 제한된다. 4개 거래소의 delayed distribution + website만 단순 합산해도 `USD 110,736/년`, Massive의 4개 사업 feed까지 더하면 `USD 158,688/년`부터이므로 수요가 검증될 때까지 선물 패널은 `API 필요`로 둔다. [CME 2026 fee list](https://www.cmegroup.com/market-data/files/june-2026-market-data-fee-list.pdf), [Schedule 5](https://www.cmegroup.com/market-data/files/schedule-5-to-the-ila-june-2026.pdf)

## 무료 단계에서 사용자가 할 일

비밀 값은 채팅에 보내지 말고 발급 후 로컬 secret 파일 또는 운영 Secret Manager에 넣는다.

- [x] KRX Open API와 Open DART 변수 이름을 로컬 `.env.local`에 구성했다. 값·유효성과 KRX API별 활용·공개 목적 승인은 아직 contract test 전이므로 별도 상태로 관리한다. [KRX 인증키·활용 신청](https://openapi.krx.co.kr/contents/OPP/INFO/OPPINFO003.jsp), [Open DART](https://opendart.fss.or.kr/intro/main.do)
- [ ] 링크형 공급자 비교가 필요할 때만 News API Developer key를 로컬 뉴스 UI 평가용으로 발급한다. 외부 staging에 넣지 않고 Business를 미리 결제하지 않는다. [키 발급](https://newsapi.org/register)

이미 있는 Alpaca, KIS, Gemini, Open DART와 KRX 변수 이름은 새로 입력할 필요가 없다. Alpaca·KIS는 개인 개발, 본인 시세·차트·계좌와 Paper Trading에 사용하고 공용 시장 feed로 전환하지 않는다. 실제 값, 인증 성공과 entitlement는 opt-in contract에서 확인한다.

## 유료 전환 때만 다시 여는 항목

- 공개 계약 주체가 될 운영 법인 또는 사업자 결정
- Twelve Data의 익명 웹 display·US Equities/Redistribution Rights Add-On 견적
- Benzinga 뉴스·한국어 번역·AI 파생물 권리 견적
- 코스콤·KRX·NXT 실시간 표시와 비조회형 이용 계약
- 실제 미국 지수·OPRA 옵션·CME 선물 범위와 예산 결정

## 계약 전 활성화하면 안 되는 기능

- 개인 Alpaca·KIS·Alpha Vantage key를 사용한 비로그인 공용 시세
- KIS 시세의 공용 캐시, 스트림 또는 다른 사용자 제공
- 권리 확인 없는 미국 실제 지수 값, OPRA 옵션 거래·호가와 CME 선물 실시간 값
- 코스콤/KRX 계약 없는 한국 실시간·지연 시세와 그 시세로 계산한 공개 기술지표
- News API 결과 또는 웹 스크래핑으로 얻은 기사 전문·이미지의 재게시
- 원출처/공급자가 허용하지 않은 뉴스 한국어 번역, AI 요약·감성, 장기 보관
- 시장 데이터 다운로드, CSV export, 고객용 API 또는 원시 WebSocket 재전송
- FRED API 콘텐츠의 서버 캐시, 아카이브 또는 AI/ML 경로 전달

UI는 이 상태를 빈 숫자나 샘플 숫자로 대신하지 않고 `API 필요`, `표시 권한 없음`, `지연 데이터`, `데이터 없음`으로 구분한다.

## 견적서에 반드시 넣을 권리 항목

1. 자산·거래소·심볼 범위와 `실시간/지연/EOD` 구분
2. 비로그인 웹, 로그인 웹, 모바일 앱별 display 권리
3. 가입자·기기·동시접속 수와 professional/non-professional 분류
4. 원본 tick·bar·뉴스의 캐시, 보존, 백업과 삭제 의무
5. 차트, 기술지표, 포트폴리오 평가, 감성처럼 만든 derivative data의 생성·표시·소유권
6. Gemini 등 외부 모델로의 전송·처리와 한국어 번역·요약 권리
7. CSV/export, 고객 API, 알림 메시지와 스크린샷 공유 범위
8. 개발·staging·production 환경과 장애 시 stale cache 사용 범위
9. 출처 표기, audit, 가입자 신고, 계약 종료 후 데이터 처리
10. 공급자 요금과 거래소·지수·OPRA·CME·KRX·NXT 비용의 분리

## 제한 사항과 재검증 시점

- 공개 가격은 공급자 웹사이트의 2026-07-14 표시값이며 세금, 환율, 카드 수수료와 협상 할인을 제외했다.
- `영업 견적 필요` 항목은 공개 근거가 없어 숫자를 추정하지 않았다.
- Twelve Data의 `from` 가격과 표준 구성 가격이 함께 표시되므로 실제 credit 구성은 결제 전에 확인해야 한다.
- 공급자 구독이 제3자 거래소·뉴스 저작권자의 권리를 항상 포함하지는 않는다. 최종 Order Form과 데이터 부속계약이 웹 가격표보다 우선한다.
- 가입자 수, 표시 화면, 저장 기간, AI 처리 또는 export 기능이 바뀌면 계약 범위를 다시 검토한다.
- 프로덕션 계약 체결 직전과 매 갱신 시점에 가격, License Scope와 정보이용정책을 다시 확인한다.
