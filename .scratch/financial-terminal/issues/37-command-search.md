# 37 - 명령·티커 검색 실작동

Type: implementation
Status: resolved
Triage: ready-for-agent
Depends on: 36
Blocked by: None
Owner: main
Claimed at: 2026-07-21T11:00:00Z
Last heartbeat: 2026-07-21T11:25:00Z

## Resolution (2026-07-21)

### Answer

① `parseTerminalCommand` — 입력 해석을 순수 함수로 분리하고 **`/api/market`과 같은 심볼 경계**를
쓴다. 라우트가 유일한 방어층이면 UI는 거절 사유를 모른 채 실패만 보여준다. 소문자 티커는 대문자로
정규화(kospi = KOSPI), 숫자 코드는 그대로.
② `SymbolLookup` — 조회 결과가 관심종목 패널에 쌓인다. **검색과 관심목록이 같은 기계**라 별도
저장소 없이 조회 이력이 곧 목록이 된다. `/api/market` 계약 타입을 그대로 소비(컴파일러가 프론트↔
백엔드 일치 강제), 값은 available일 때만.
③ ⌘K/Ctrl+K가 실제로 명령창에 포커스한다(지금까지 헤더에 표시만 돼 있었다).

### 조회가 임의 심볼을 열자마자 드러난 불변식 위반 (이 티켓의 진짜 수확)

없는 종목 `ZZZZ`를 실 KIS에 물으면 **`rt_cd=0` + 가격 `"0"`** 이 온다. 엄격 십진 파서는 `"0"`을
정상 숫자로 받으므로 그대로 통과 → **없는 종목에 `available` 0원짜리 시세**가 생겼다. 이 프로젝트가
절대 하지 않기로 한 바로 그것(값을 모르면 만들지 않는다)이고, 지금까지는 고정 4심볼만 조회해서
도달하지 않았을 뿐이다. 검색이 그 문을 연다.

→ KRX 시세·지수는 0이 될 수 없으므로 0은 값이 아니라 **관측값 없음(`no_data`)** 으로 막았다.
빈 문자열 같은 형식 오류는 계속 `invalid_response`로 구분한다(증거의 성격이 다르다: `""`는 숫자가
아예 아니고 `"0"`은 가격일 수 없는 숫자다).

### Changed files

`terminal-command.ts`(신규 파서), `symbol-lookup.tsx`(신규 결과 목록), `guest-terminal-shell.tsx`
(명령 실행·⌘K·패널 배선), `kis-market-information.ts`(0 가격 게이트),
`tests/terminal-command.test.ts`(5), `tests/kis-market-information.test.ts`(+3),
`tests/browser/guest-shell.spec.ts`(stub 기대치 → 실동작 계약).

### Validation

- `npm run check` 전 레인 green(1,375). 브라우저·a11y 레인 86 green.
- **실 KIS 라이브**: 로그인 상태에서 `000660` → 1,836,000 KRW(+4.08%), `kospi` → 6,747.95
  (소문자 정규화 확인), `bad;symbol` → 전송 없이 즉시 거절 안내.
- **0원 위조 재현→해소 실측**: 수정 전 `ZZZZ` = `available, last: 0` → 수정 후 `unavailable/no_data`,
  같은 요청에서 `005930`은 259,000 그대로.

### Residual risks

- 조회 목록은 새로고침하면 사라진다(세션 저장 없음). 사용자별 관심목록 영속은 후속.
- 티커→회사명 해석이 없어 "삼성전자"로는 못 찾는다(심볼만). 종목 마스터가 필요하다.
- 차트는 여전히 조회 심볼을 따라가지 않는다(F2 차트 데이터 소스 별개).

## Context

사용자 QA(2026-07-21): "종목검색도 안 되고".

사실이다. `guest-terminal-shell.tsx:99-102`의 `handleCommand`는 submit을 가로채 "명령 실행은
다음 단계에서 제공됩니다"라는 문구만 세팅한다. 터미널의 핵심 동작(티커를 쳐서 종목을 본다)이
통째로 stub이다.

## Owned scope

- 셸 명령창 + 종목 화면(라우트/패널), 심볼 해석
- `tests/`

## Acceptance

- 티커 입력 → 해당 종목의 시세(+차트)가 실제로 표시된다(로그인 시 KIS 실값).
- 알 수 없는 심볼은 정직하게 "찾을 수 없음"이며, 값을 만들어내지 않는다.
- 비로그인은 로그인 유도로 끝나고 개인 데이터 경로를 건드리지 않는다.
- 키보드(⌘K·Enter)와 스크린리더 안내가 동작한다.
