# Stage 3 — 원장이 못 보던 층 닫기 (skip 레인 · advisory · pending)

## Blast radius / 검증 tier 선언 (착수 전, AGENTS.md 하한)

- **검증 tier: 최상위.** guarded 경로를 건드린다 — `paper-trading/`(journal·blotter·contracts·service·simulator·backtest), `actual-portfolio/calculation/`(transfers·corporate-actions), `modules/identity/`, `platform/runtime/`. 대부분 `exactOptionalPropertyTypes` 도입에 따른 키 보존 수정이지만, 돈 원장 파일이 포함되므로 판단 없이 자동 승격이다.
- **되돌릴 수 없음**: 낮다. 런타임 동작 변경은 3건뿐이고(worker unhandled rejection, backtest 타입 좁힘, property 테스트 await) 나머지는 타입 수준 또는 게이트 스크립트다. 게이트 변경은 잘못되면 **거짓 red** 를 내지 거짓 green 을 내지 않는 방향으로 설계했다.
- **Contain**: 게이트 변경은 전부 `negative-control.sh` 에 대조군을 동반한다 — 판별력을 실행으로 증명하지 못하면 그 게이트는 안 넣는다.

## 무엇을 닫았나

1. **gate-liveness 검사 5 (조건부 skip 레인)** — 원장이 npm 스크립트만 열거해서, 어떤 스크립트에도 안 속한 skip 파일이 통째로 사각이었다. 실측: provider contract 5파일이 한 번도 안 돈 채 초록. `skipIf`/`skip` 걸린 테스트 16개를 3열(`<파일> wired:<켜는 곳> <토큰>`)로 등록하게 하고, `wired:` 면 토큰이 그 파일에 실제로 있는지 대조한다.
2. **gate-liveness 검사 6 (advisory)** — `test:browser`·`test:performance` 가 원장엔 `wired:` 인데 실제로는 `continue-on-error: true` job 이라 아무것도 못 막았다. `advisory:` 를 3번째 상태로 넣고 ci.yml 의 실제 플래그와 대조한다(양방향).
3. **tier-gate pending 2층** — 커밋된 `Tier: top` 28건 중 11건에 pending 이 남아 있었고 해소를 보는 코드가 없었다. 로컬 커밋은 통과(작업 중 미완은 정상), PR 범위(`--range`)에서만 red.
4. **contract 테스트 실행 경로** — `npm run test:contract`. vitest 가 `.env` 를 로드하지 않는다는 것이 근인이었다(실증: 테스트 프로세스에서 `DART_API_KEY` 미설정). 게이트 변수는 `.env.local` 이 아니라 스크립트에서 켠다 — 파일에 적으면 다른 레인이 실 API 를 우연히 켜서 network-off 전제가 조용히 깨진다.

`negative-control.sh`: 21 → **29 케이스, 0 fail**. 신설 8건 전부 red 를 실증했고 양성 대조군을 동반한다.

## 발견 — 이 커밋이 **못** 고친 것 (다음 작업)

- **트레일러 축 값이 검증되지 않는다.** 실증: `Tier: top (adversarial=ㅁ, blind=ㅁ, standards=ㅁ, prior-decisions=ㅁ)` → rc=0. **빈 값도 rc=0.** 따라서 위 3번의 pending 검사는 `standards=x` 한 글자로 우회된다. 이 커밋이 넣은 게이트의 알려진 천장이며, 숨기지 않고 여기 적는다.
  → 다음: 축 값을 ① 실재하는 경로 ② `waived:<비공백 사유>` ③ `none-found`(prior-decisions 전용) 셋으로 제한. 그 하나가 garbage·빈값·pending 우회·허위 위치를 동시에 닫는다.
- **`main...origin/main [ahead 25]`** — 25커밋이 CI 를 안 거쳤다. "CI 가 두 번째 층"이라는 주장의 실제 커버리지는 마지막 push 시점까지다. push 는 사람 소유라 여기서 처리하지 않는다.
- **`nightly-mutation` 은 실행 이력이 0이다.** 이 커밋으로 처음 올라간다. "이미 배선돼 있다"고 말하지 말 것 — 파일에 있는 것과 돈 것은 다르다.
- **`performance-report.ts` mutation 27.92%** (no-coverage mutant 379개 = 파일의 80%). mutation 을 적대 축의 대체재로 쓰려면 여기가 먼저다. 단 **nightly 가 한 번이라도 돈 뒤**에 논할 문제다.

## 과대 서술 정정 기록

이 세션에서 내가 쓴 것 중 사용자 지적으로 기각된 것:

- "정밀도 property test 가 없다" → **틀렸다.** `tests/t8-relief-2653.test.ts` 가 이미 2^53 basis drift 를 고정하고 있다. codex 가 잡은 것 중 oracle 로 안 옮겨진 것은 0건이다.
- "`adversarial=` 축의 정의를 바꾸면 반증 기록을 강제할 수 있다" → **틀렸다.** 값을 검사하는 게 없어서 정의 변경은 미검증 문자열을 하나 더 늘릴 뿐이다. 내가 고치던 결함을 내 계획이 재생산하고 있었다.
- "mutation 은 이미 배선돼 있다" → 파일엔 있으나 실행 이력 0. 배선과 실행을 구분해 적을 것.

## 남은 게이트 (최상위 tier 요구)

- [ ] 축 값 검증(위 발견 1) — 이게 되기 전까지 pending 게이트는 반쪽이다
- [ ] blind test-authorship — 이 커밋의 게이트 변경은 `negative-control.sh` 29케이스의 실행 실증으로 갈음했다. 별도 blind 저자는 없다
- [ ] 채택한 지적의 2라운드 재공격
