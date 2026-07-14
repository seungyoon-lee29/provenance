# 공급자 환경변수와 보안 경계

## 현재 로컬 준비 상태

2026-07-14 기준 `.env.local`에는 `GEMINI_API_KEY`, `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`, `KIS_APP_KEY`, `KIS_APP_SECRET`, `KIS_REST_BASE`, `DART_API_KEY`, `KRX_API_KEY` assignment 이름과 안전 기본값 `APP_ENVIRONMENT=development`, `APP_PUBLIC_ORIGIN=http://localhost:3000`, `PROVIDER_BILLING_MODE=free_only`, `LOCAL_PROVIDER_CREDENTIAL_MODE=contract_only`, `CREDENTIAL_VAULT_PROVIDER=disabled`, `DELIVERY_KEYRING_PROVIDER=disabled`, `ALPACA_ENVIRONMENT=paper`, `ALPACA_DATA_FEED=iex`, `KIS_ENVIRONMENT=paper`, `EMAIL_DELIVERY_PROVIDER=disabled`가 구성돼 있다. secret 값, 형식, 인증 성공, quota와 endpoint별 entitlement는 읽거나 검증하지 않았으므로 opt-in contract 결과 전에는 `configured_unverified`다. `.env.local`은 Git에서 제외되고 로컬 파일 권한은 소유자 전용이어야 한다.

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
| `GEMINI_API_KEY` | server-only secret | 모든 지원 자료 유형의 Gemini adapter. 누락 시 지원 local rule 또는 `api_required`. |
| `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` | server-only secret | 개인 Alpaca Basic data와 Paper contract. |
| `ALPACA_ENVIRONMENT=paper` | 비밀 아님, 필수 | 초기 릴리스에서 live trading host/route를 거절한다. |
| `ALPACA_DATA_FEED=iex` | 비밀 아님, 필수 | IEX를 SIP 전 시장 시세로 오표기하지 않는다. |
| `KIS_APP_KEY`, `KIS_APP_SECRET` | server-only secret | 개인 KIS data와 모의투자 contract. |
| `KIS_ENVIRONMENT=paper` | 비밀 아님, 필수 | 등록된 모의 endpoint allowlist만 허용한다. |
| `KIS_REST_BASE` | server-only config | 사용자 입력 URL처럼 신뢰하지 않고 `KIS_ENVIRONMENT`의 고정 allowlist와 일치시킨다. |
| `DART_API_KEY` | server-only secret | Open DART의 canonical 프로젝트 변수명. |
| `KRX_API_KEY` | server-only secret | KRX Open API. key 존재와 API별 활용·공개 목적 승인은 별도다. |

Google/GitHub 각각 `*_IDENTITY_ENABLED=false`이면 client ID/secret은 비어 있어야 한다. `true`이면 client ID, client secret과 exact callback path가 모두 있어야 하며 누락·부분 설정·다른 callback path는 startup에서 해당 adapter와 entry 등록을 거절한다. callback URL은 `APP_PUBLIC_ORIGIN`과 고정 path로만 만들고 `Host`, `Forwarded`, provider 응답 또는 사용자 입력을 사용하지 않는다. 일반 PR은 scripted Identity adapter만 쓰고 실제 provider smoke는 각각 `RUN_GOOGLE_IDENTITY_CONTRACT=1`, `RUN_GITHUB_IDENTITY_CONTRACT=1`인 opt-in job에서만 수행한다.

Alpaca·KIS의 process-global 개인 key는 로컬 또는 예약된 opt-in contract job에서만 사용한다. interactive single-owner development에서 쓰려면 `LOCAL_PROVIDER_CREDENTIAL_MODE=single_owner`와 변경 불가능한 `LOCAL_PROVIDER_OWNER_WORKSPACE_ID`를 함께 구성하고, 요청 Viewer Context가 정확히 일치할 때만 adapter를 연다. 다중 사용자 staging/production은 이 모드를 시작 단계에서 거절하며, 사용자별 Provider Connection/OAuth와 envelope-encrypted secret만 허용한다. 공용 feed, 다른 workspace cache 또는 제3자 표시로 승격하지 않는다.

KIS 계좌번호·상품 코드는 process-global server env에 넣지 않고 사용자별 Provider Credential로 envelope encryption한다. credential data key의 authoritative AAD는 `workspace + provider connection + provider + credential type + paper/live environment`이고 KMS/Secret Manager의 key-encryption key로 감싼다. `disabled`에서는 공개 데이터가 계속 동작하지만 Provider Connection 생성·저장 UI와 API는 `configuration_required`이고 plaintext fallback은 없다. local vault는 development/test에서만 `CREDENTIAL_LOCAL_KEYRING_FILE`의 versioned 32-byte KEK를 사용하고 production은 시작 단계에서 거절한다. rotation은 active version으로 새 write, active+previous로 read, 중단 가능한 transactional rewrap, backfill 완료 뒤 이전 key 폐기 순서다. 실전·모의 자격증명은 저장·배포 단위에서도 분리하며 Live Trading 주문 전송 경로는 초기 릴리스에 존재하지 않는다.

local credential keyring JSON은 `schemaVersion`, `activeVersion`, `keys[version].kekBase64/status/notAfter`만 허용한다. local delivery keyring은 `schemaVersion`, 목적별 `activeVersions`와 versioned Resend API/webhook secret, VAPID pair/subject, endpoint-fingerprint HMAC, domain-separated erasure-tombstone HMAC, endpoint/action-material KEK, `status/notAfter`를 가진다. 두 파일은 64 KiB 이하, owner mode `0600`, symlink가 아닌 regular file이어야 하고 `.secrets/`에서 Git 제외한다. unknown field/version, active key 누락, duplicate version, 잘못된 base64/길이와 expired active key는 startup reject다.

## 선택형 알림 변수

`EMAIL_DELIVERY_PROVIDER` 기본값은 `disabled`다. `DeliveryKeyring.loadActive(purpose)/loadUnexpiredPrevious(purpose)`가 delivery secret의 유일한 런타임 계약이다. `resend`는 active Resend API key와 webhook secret/version, 검증된 `EMAIL_FROM_ADDRESS`와 production HTTPS `APP_PUBLIC_ORIGIN`이 모두 있을 때만 준비 상태가 된다. 일부만 있으면 email adapter와 worker schedule을 만들지 않고 UI에 `설정 필요`를 표시한다. `mailpit`은 development/test에서만 허용하고 staging/production 선택은 시작 단계에서 거절한다. app container가 쓰는 `MAILPIT_API_BASE_URL`과 사람이 여는 `MAILPIT_UI_URL`을 구분하고 둘 다 외부 recipient로 전달하지 않는다.

Web Push의 active `VAPID_PUBLIC_KEY`와 version은 인증된 server bootstrap endpoint가 동적으로 제공한다. 빌드 시 고정되는 `NEXT_PUBLIC_*` secret/config를 쓰지 않는다. `VAPID_PRIVATE_KEY`와 `VAPID_SUBJECT`는 server-only다. active version·public/private/subject는 전부 있거나 전부 없어야 하며 일부 설정이면 startup validation이 push adapter, 구독 UI, Intent 생성과 외부 호출을 모두 비활성화하고 `configuration_required`를 노출한다. production은 `VAPID_SUBJECT`의 `mailto:`/`https:` 형식, public/private key pair와 HTTPS `APP_PUBLIC_ORIGIN`을 검증한다. push endpoint와 subscription key도 사용자별 암호화 저장하며 로그에는 keyed-HMAC fingerprint만 남긴다.

`DELIVERY_KEYRING_PROVIDER=disabled`는 email과 Web Push가 모두 꺼진 기본값이며 이때 keyring이나 외부 adapter를 만들지 않는다. `local`은 development/test에서만 `DELIVERY_LOCAL_KEYRING_FILE`을 읽고 production은 시작 단계에서 거절한다. production은 `secret_manager`와 versioned `DELIVERY_KEYRING_REF`만 허용한다. `DeliveryKeyring.loadActive(purpose)/loadUnexpiredPrevious(purpose)` 외 secret source나 precedence는 없다. keyring은 active와 목적별 모든 unexpired previous Resend API/webhook secret, VAPID pair, endpoint-fingerprint HMAC key, `ERASURE_TOMBSTONE_HMAC` key와 channel-endpoint/action-material encryption key를 version별로 제공한다. webhook은 허용된 rotation window에서 active+previous 서명을 검증하고, VAPID bootstrap은 active public key+version만 제공한다. subscription은 사용한 VAPID version을 보존해 재등록을 유도한다. fingerprint 회전은 old/new dual lookup과 transactional backfill 뒤에만 old key를 폐기한다. erasure-tombstone key는 raw provider id를 보존하지 않으므로 해당 version으로 만든 마지막 tombstone의 최장 TTL까지 read-only previous로 유지하며, tombstone row는 key version을 저장하고 lookup은 active와 모든 unexpired previous digest를 확인한다. 필요한 previous key가 누락되면 webhook raw storage를 fail closed한다.

WorkspaceFinancialEmailEndpoint, WorkspaceSecurityEmailEndpoint, WorkspaceWebPushEndpoint, PendingAccountEmailTarget과 DeliveryActionMaterial은 delivery keyring의 분리된 envelope key namespace로 암호화한다. AAD는 financial email endpoint에 `workspace + endpoint + email/financial_alert + membership + financial-consent epoch + verified-address revision`, security email endpoint에 `workspace + endpoint + email/security_account + membership/account-state revision + security-notice epoch + verified-address revision`, Web Push에 `workspace + device/endpoint + web_push + device-binding auth epoch`, pending target에 `pending identity + cause + purpose + request security epoch`, AccountChallengeMaterial에 `cause + purpose + expiry + (pending identity + request security epoch | workspace + security endpoint + account authorization epoch)`, unsubscribe material에 `workspace + endpoint + topic + consent lineage + delivery intent`를 사용하고 ciphertext에 key version을 기록한다. financial과 security email variant는 같은 주소라도 상호 대체하거나 다른 purpose에서 복호화하지 않는다. active key로 새 write, active+previous로 read, transactional rewrap 뒤 이전 key 폐기 순서를 따른다. VAPID previous version은 keyring metadata의 `notAfter`를 넘겨 보존하지 않으며 긴급 revoke 시 즉시 폐기하고 해당 subscription을 비활성화해 재-opt-in을 요구한다. 휴면 subscription 때문에 compromised private key를 무기한 보존하지 않는다.

`APP_PUBLIC_ORIGIN`은 설정값 하나만 신뢰한다. `Host`, `Forwarded` 또는 사용자 입력 URL로 링크를 조립하지 않고, deep-link route는 내부 allowlist에만 매핑하며 외부 redirect를 허용하지 않는다.

## 검증 원칙

- 일반 PR은 provider secret을 주입하지 않고 외부 egress를 차단한다.
- 실제 key contract는 명시적인 opt-in 환경변수로만 실행하고 성공·미지원·권리 부족을 서로 다른 artifact로 기록한다.
- production은 process-global Alpaca/KIS 개인 key가 있으면 해당 adapter를 fail closed하고 audit event를 남긴다.
- key가 있어도 public display, 재배포, 외부 모델 처리 또는 파생물 권리가 자동으로 생기지 않는다.
- 원시 secret, 계좌번호, 인증 header와 provider raw error가 테스트 artifact나 스크린샷에 남지 않게 redaction scan을 통과해야 한다.
