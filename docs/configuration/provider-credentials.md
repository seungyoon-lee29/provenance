# 공급자 환경변수와 보안 경계

## 현재 로컬 준비 상태

2026-07-14 기준 `.env.local`에는 `KIS_APP_KEY`, `KIS_APP_SECRET`, `KIS_REST_BASE`, `DART_API_KEY` assignment 이름과 안전 기본값 `APP_ENVIRONMENT=development`, `APP_PUBLIC_ORIGIN=http://localhost:3000`, `PROVIDER_BILLING_MODE=free_only`, `LOCAL_PROVIDER_CREDENTIAL_MODE=contract_only`, `CREDENTIAL_VAULT_PROVIDER=disabled`가 구성돼 있다. secret 값, 형식, 인증 성공, quota와 endpoint별 entitlement는 읽거나 검증하지 않았으므로 opt-in contract 결과 전에는 `configured_unverified`다. `.env.local`은 Git에서 제외되고 로컬 파일 권한은 소유자 전용이어야 한다.

공개 템플릿은 [`.env.example`](../../.env.example)을 사용한다. 실제 값은 채팅, 문서, Git, 브라우저 번들, 로그, 오류 추적 또는 Gemini prompt에 넣지 않는다.

## 변수 계약

| 변수 | 성격 | 적용 범위 |
| --- | --- | --- |
| `APP_ENVIRONMENT` | 비밀 아님, 필수 | `development`, `test`, `staging`, `production` allowlist. 환경별 provider와 안전 정책을 고정한다. |
| `APP_PUBLIC_ORIGIN` | 비밀 아님, 필수 | deep link, magic link와 Web Push의 canonical origin. production은 앱이 소유한 HTTPS origin만 허용한다. |
| `PROVIDER_BILLING_MODE=free_only` | 비밀 아님, 필수 | paid adapter·route·schedule을 startup에서 거절한다. |
| `LOCAL_PROVIDER_CREDENTIAL_MODE` | 비밀 아님, 필수 | 기본 `contract_only`. process-global 개인 key는 명시적 contract job에만 허용한다. |
| `LOCAL_PROVIDER_OWNER_WORKSPACE_ID` | 비밀 아님, 선택 | 단일 소유자 development에서만 env key를 고정 workspace에 바인딩한다. production에서는 금지한다. |
| `CREDENTIAL_VAULT_PROVIDER` | 비밀 아님, 필수 | 기본 `disabled`, development/test의 `local`, production의 `kms`/`secret_manager` allowlist. production에서 local을 거절한다. |
| `CREDENTIAL_LOCAL_KEYRING_FILE` | server-only config | development/test 전용 versioned local keyring 파일. `.secrets/` 아래 owner-only regular file만 허용한다. |
| `CREDENTIAL_VAULT_KMS_KEY_REF` | server-only config | production의 versioned KMS/Secret Manager key reference. 사용자 입력 URI로 해석하지 않는다. |
| `GOOGLE_IDENTITY_ENABLED`, `GITHUB_IDENTITY_ENABLED` | 비밀 아님, 필수 | 기본 `false`. `true`일 때만 해당 federated Identity adapter와 로그인 entry를 등록한다. |
| `GOOGLE_IDENTITY_CLIENT_ID`, `GITHUB_IDENTITY_CLIENT_ID` | server-only config | provider application의 canonical client ID. 브라우저 runtime config나 analytics로 export하지 않는다. |
| `GOOGLE_IDENTITY_CLIENT_SECRET`, `GITHUB_IDENTITY_CLIENT_SECRET` | server-only secret | callback의 server-side code exchange에만 사용하고 로그·artifact·ProviderConnections에 넣지 않는다. |
| `GOOGLE_IDENTITY_CALLBACK_PATH`, `GITHUB_IDENTITY_CALLBACK_PATH` | 비밀 아님, 필수 | 각각 exact `/auth/callback/google`, `/auth/callback/github`만 허용하며 `APP_PUBLIC_ORIGIN`과 결합한 canonical callback 외 URL을 거절한다. |
| `KIS_APP_KEY`, `KIS_APP_SECRET` | server-only secret | 개인 KIS data와 모의투자 contract. |
| `KIS_REST_BASE` | server-only config | 사용자 입력 URL처럼 신뢰하지 않고 고정 KIS REST origin allowlist와 일치시킨다. |
| `DART_API_KEY` | server-only secret | Open DART의 canonical 프로젝트 변수명. |

Google/GitHub 각각 `*_IDENTITY_ENABLED=false`이면 client ID/secret은 비어 있어야 한다. `true`이면 client ID, client secret과 exact callback path가 모두 있어야 하며 누락·부분 설정·다른 callback path는 startup에서 해당 adapter와 entry 등록을 거절한다. callback URL은 `APP_PUBLIC_ORIGIN`과 고정 path로만 만들고 `Host`, `Forwarded`, provider 응답 또는 사용자 입력을 사용하지 않는다. 일반 PR은 scripted Identity adapter만 쓰고 실제 provider smoke는 각각 `RUN_GOOGLE_IDENTITY_CONTRACT=1`, `RUN_GITHUB_IDENTITY_CONTRACT=1`인 opt-in job에서만 수행한다.

KIS의 process-global 개인 key는 로컬 또는 예약된 opt-in contract job에서만 사용한다. interactive single-owner development에서 쓰려면 `LOCAL_PROVIDER_CREDENTIAL_MODE=single_owner`와 변경 불가능한 `LOCAL_PROVIDER_OWNER_WORKSPACE_ID`를 함께 구성하고, 요청 Viewer Context가 정확히 일치할 때만 adapter를 연다. 다중 사용자 staging/production은 이 모드를 시작 단계에서 거절하며, 사용자별 Provider Connection/OAuth와 envelope-encrypted secret만 허용한다. 공용 feed, 다른 workspace cache 또는 제3자 표시로 승격하지 않는다.

KIS 계좌번호·상품 코드는 process-global server env에 넣지 않고 사용자별 Provider Credential로 envelope encryption한다. credential data key의 authoritative AAD는 `workspace + provider connection + provider + credential type + paper/live environment`이고 KMS/Secret Manager의 key-encryption key로 감싼다. `disabled`에서는 공개 데이터가 계속 동작하지만 Provider Connection 생성·저장 UI와 API는 `configuration_required`이고 plaintext fallback은 없다. local vault는 development/test에서만 `CREDENTIAL_LOCAL_KEYRING_FILE`의 versioned 32-byte KEK를 사용하고 production은 시작 단계에서 거절한다. rotation은 active version으로 새 write, active+previous로 read, 중단 가능한 transactional rewrap, backfill 완료 뒤 이전 key 폐기 순서다. 실전·모의 자격증명은 저장·배포 단위에서도 분리하며 Live Trading 주문 전송 경로는 초기 릴리스에 존재하지 않는다.

local credential keyring JSON은 `schemaVersion`, `activeVersion`, `keys[version].kekBase64/status/notAfter`만 허용한다. 이 파일은 64 KiB 이하, owner mode `0600`, symlink가 아닌 regular file이어야 하고 `.secrets/`에서 Git 제외한다. unknown field/version, active key 누락, duplicate version, 잘못된 base64/길이와 expired active key는 startup reject다.

> 알림·외부 전달(email/Web Push/delivery keyring) 변수는 Stage 2 T3에서 제거됐다 — `notification-center`
> 모듈이 도달 UI 없는 죽은 코드였다. identity 이메일 로그인은 인메모리 outbox+peek를 쓰므로 무관하다.
> `EMAIL_*`·`MAILPIT_*`·`DELIVERY_KEYRING_*`·`VAPID_*`를 지금 설정해도 런타임은 이를 검증하지 않고 무시한다.

`APP_PUBLIC_ORIGIN`은 설정값 하나만 신뢰한다. `Host`, `Forwarded` 또는 사용자 입력 URL로 링크를 조립하지 않고, deep-link route는 내부 allowlist에만 매핑하며 외부 redirect를 허용하지 않는다.

## 검증 원칙

- 일반 PR은 provider secret을 주입하지 않고 외부 egress를 차단한다.
- 실제 key contract는 명시적인 opt-in 환경변수로만 실행하고 성공·미지원·권리 부족을 서로 다른 artifact로 기록한다.
- production은 process-global KIS 개인 key가 있으면 해당 adapter를 fail closed하고 audit event를 남긴다.
- key가 있어도 public display, 재배포, 외부 모델 처리 또는 파생물 권리가 자동으로 생기지 않는다.
- 원시 secret, 계좌번호, 인증 header와 provider raw error가 테스트 artifact나 스크린샷에 남지 않게 redaction scan을 통과해야 한다.
