# Triage Labels

새 open/claimed 티켓은 `Triage:` 필드에 아래 값 하나를 기록한다. `Status`는 작업 수명주기이고 `Triage`는 다음 행동 주체이므로 서로 대체하지 않는다.

| 역할 | 실제 상태명 |
| --- | --- |
| `needs-triage` | `needs-triage` |
| `needs-info` | `needs-info` |
| `ready-for-agent` | `ready-for-agent` |
| `ready-for-human` | `ready-for-human` |
| `wontfix` | `wontfix` |

- 새 티켓은 기본 `needs-triage`다.
- 범위, 의존성과 합격 기준이 명확하면 `ready-for-agent`로 바꾼다.
- 저장소에서 확인할 수 없는 사용자 결정이 필요하면 `needs-info`, 권한·계약·운영 승인이 필요하면 `ready-for-human`을 사용한다.
- `wontfix`는 이유와 영향을 티켓에 기록한 뒤 사용한다.
- claim은 `ready-for-agent`에서만 가능하다. 해결 시 기존 triage 값을 보존해 어떤 경로로 작업됐는지 남긴다.
