# Foundation runtime

## Start

Docker가 실행 중인 개발 환경에서 다음 한 명령으로 app, worker, PostgreSQL, Redis와 migration을 시작한다.

```sh
npm run compose:up
```

provider secret은 필요하지 않다. app, worker와 dependency는 외부 egress가 없는 internal network에 남고, `local` profile의 고정 TCP ingress만 host용 network에 연결된다. ingress는 provider/runtime 환경변수를 받지 않고 `127.0.0.1`에만 bind하며 app과 worker의 health port만 전달한다. 호스트에서 app은 `http://127.0.0.1:3000`, worker는 `http://127.0.0.1:3001`로 확인한다.

```sh
curl --fail http://127.0.0.1:3000/api/health
curl --fail http://127.0.0.1:3000/api/ready
curl --fail http://127.0.0.1:3001/health
curl --fail http://127.0.0.1:3001/ready
```

기본 host port가 이미 사용 중이면 같은 명령에서 포트만 재지정한다.

```sh
APP_HOST_PORT=3100 WORKER_HOST_PORT=3101 npm run compose:up
```

종료는 `npm run compose:down`을 사용한다.

## Verification

호스트의 정적·단위 계약은 `npm run check`로 빠르게 실행한다. PR 통합 gate는 `npm run check:pr` 하나이며 정적·단위 검사 자체부터 secret 없는 internal Docker network에서 실행한 뒤 app, worker, PostgreSQL, Redis, migration과 외부 egress 거절을 모두 검증하고 종료 시 stack을 정리한다. 실제 PostgreSQL migration apply/reapply/rollback과 Docker network-off 검증만 개별 재실행할 때는 runtime을 시작한 뒤 아래 명령을 사용한다.

```sh
docker compose --profile verify run --rm migration-smoke
docker compose --profile verify run --rm network-off
```

`network-off`는 app/worker readiness가 선언된 Docker service origin에서 성공하고 외부 hostname fixture는 policy와 internal network 양쪽에서 실패해야 통과한다.

로컬 delivery keyring은 `.secrets` 아래 mode `0600`인 64 KiB 이하 JSON 파일이어야 한다. `schemaVersion: 1`, 유일한 `active` entry와 일치하는 `activeVersion`, version별 `status`, `secrets`, previous entry의 `notAfter`를 사용한다. Resend를 활성화할 때 active `secrets`에는 `resendApiKey`와 `resendWebhookSigningSecret`이 모두 있어야 하며, 실제 값은 문서나 저장소에 기록하지 않는다.
