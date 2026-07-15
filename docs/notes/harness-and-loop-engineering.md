# 하네스 & 루프 엔지니어링 — 학습 메모

_2026-07-16 세션 정리. 나중에 다시 보고 공부용._

## 한 줄 요약

- **하네스 엔지니어링** = 모델 *바깥*(도구·컨텍스트·메모리·게이트·스킬·서브에이전트)을 설계.
- **루프 엔지니어링** = 에이전트의 *반복 제어 흐름*(관찰→행동→관찰→종료·재계획·하위루프)을 설계.
- 모델이 고정되면 에이전트 품질의 대부분이 여기서 나온다. **레버리지는 제품 코드보다 한 층 위**.

## 하네스 vs 루프

- 하네스 = 정적 무대·소품. 루프 = 시간에 따른 안무(dynamics). 겹치지만 축이 다르다.
- LLM 에이전트에선 **루프가 별도 코드가 아니라 하네스 안의 자연어 규칙으로 존재**할 수 있다. 규칙 doc을 고치면(=하네스 편집) 그 *내용*이 루프 설계일 수 있다 → **매체(하네스) vs 내용(루프)**.
- **둘이 분리되는 지점 = 루프를 코드로 짤 때** (Workflow의 `while`/`parallel`/`pipeline`, hooks). 이게 "순수 루프 엔지니어링".

## 프로즈 → 머시너리 사다리 (아래로 갈수록 진짜 제어 흐름)

1. **프로즈 in 하네스** — 규칙 doc이 루프를 서술, 모델이 실행. (가장 부드러움)
2. **`/loop` · cron · schedule** — 에이전트를 간격/자기속도로 재호출. per-iteration은 여전히 모델 판단.
3. **Ralph Loop** — "끝날 때까지" 자율 반복 패턴(플러그인).
4. **hooks** — 이벤트(PostToolUse·Stop 등)에 결정론적으로 걸림(반복보다 반응).
5. **Workflow** — `while`/`parallel`/`pipeline`을 코드로. 모델은 잎(leaf)만 채움. ← 가장 순수.

## Workflow 실전

**실행**: 직접 치는 런치 명령 없음. 에이전트에게 "이런 워크플로 돌려줘" → Workflow 도구로 백그라운드 실행 → 완료 알림. 관전은 `/workflows`. 반복은 저장된 `.js` 편집 → `{scriptPath, resumeFromRunId}` 재실행(안 바뀐 에이전트는 캐시 즉시 반환).

**언제 쓰나**: 여러 에이전트의 제어 흐름을 코드로 박고 싶을 때 — 팬아웃(N개 동시)·파이프라인(항목별 단계)·loop-until. 광범위 리뷰/감사, 마이그레이션(N곳 변환), 리서치 스윕, "N개 점검".
**안 쓸 때(대부분)**: 인라인·서브에이전트 1개면 충분. 팬아웃은 **비용×N**이라 병렬·구조가 실제로 값을 할 때만.

**핵심 primitive**:
- `agent(prompt, {schema, model, label, phase})` — 서브에이전트. `schema` 주면 검증된 객체 반환.
- `parallel([thunks])` — 배리어 팬아웃(전부 기다림).
- `pipeline(items, s1, s2, …)` — 항목별 독립 파이프라인, 단계 사이 배리어 없음(기본값).
- `while` + `budget` — 조건/토큰 예산까지 반복.
- `model: 'haiku'|'sonnet'|'opus'` — 잎마다 모델 티어링(비용 튜닝).

**비용 교훈**: `parallel`은 wall-clock↓지만 토큰×N. → 읽기전용·기계적 잎엔 싼 모델, 비싼 판단(verify/judge)에만 opus.

## 이 세션에서 실제로 한 것

1. **하네스 편집**: `docs/agents/collaboration.md`에 검증 방법 신설 — prevent→detect→contain, **decorrelation ∝ 되돌릴 수 없음 × blast radius**, tier·반증 산출물·믿기 전 측정. → 루프 설계를 **프로즈로** 인코딩.
2. **코드 루프**: invariant-check Workflow(`parallel` 3-way 팬아웃) 작성·실행 → 실제 제어 흐름 머시너리.
3. **결과**: 도메인 불변식 3개(no-live-route·egress-off·actual-paper) **3/3 성립(high)**, 위반 0. 226k 토큰/136초(팬아웃 비용 실측).
4. **스냅샷 vs 상시**: one-shot 워크플로는 *스냅샷*. no-live·actual-paper는 F6–F10 미구현이라 위반할 코드가 아직 없어 **provisional** — 지어지면 재점검 필수. 진짜 값은 **standing 화**(매 변경 재실행).

## 교습 런(pipeline + 모델 티어링)에서 배운 것

같은 3 불변식을 `pipeline(find→verify)`로 재실행 — find=haiku, verify=opus 적대적 반증. 0 반증(전부 생존)이지만 **평가 방법 자체**에 대한 교훈이 컸다:

- **적대 verify가 flat find가 놓친 걸 잡았다.** 첫 `parallel` 런은 actual-paper를 high로 통과시켰는데, verify(opus 적대)는 **medium**으로 낮추고 발견: (a) 불변식이 부분적으로 **vacuous**(위반 모듈 미구현), (b) 문구 "shared calc 없음"이 **설계 보장보다 과함**(issue 04는 순수 계산 재사용 허용). → decorrelation·adversarial verify가 값을 한다는 산 증거.
- **verify는 더 센 oracle을 쓴다.** find는 grep/read였지만 verify(no-live)는 **실제로 코드를 tsx로 실행**해 config 우회를 확인 — 정적 읽기보다 강함.
- **비용 정정(정직)**: "haiku 쓰니 지난 226k보다 쌀 것"이라 예측했으나 **틀림 — 390k(더 비쌈).** find(haiku)는 40~51k로 쌌지만 verify(opus)가 65~97k로 무겁고 단계가 하나 늘어 6 에이전트. **교훈: 모델 티어링은 잎을 싸게 하지만, 무거운 단계를 추가하면 총비용은 오히려 는다.** 비용 동인 = 단계 수 × 각 단계의 깊이, 잎 모델만이 아님.

## 다음 목적지

one-shot workflow → **standing property test**(fast-check) + **mutation testing**(스위트 adequacy 측정) = ticket 21의 실제 산출물. 워크플로는 루프의 *프로토타입 도구*, 지속형은 테스트 스위트 안의 코드.

## 포인터

- 규칙: `docs/agents/collaboration.md` §"검증 깊이와 blast radius"
- backlog: `.scratch/financial-terminal/issues/21-verify-invariant-adequacy.md`
- 예시 스크립트: `~/.claude/projects/.../workflows/scripts/check-domain-invariants-*.js`
