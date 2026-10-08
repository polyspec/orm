<!-- doc-id: execution-checklist -->
# 실행 체크리스트

| ID | 작업 | 검증 | 상태 |
|---|---|---|---|
| T1 | parser를 작성한다 | `make test` | [o] |
| T1-1 | union을 `a \| b`로 출력한다 | `make test` | [ ] |
| T2 | 이전 runner를 제거한다 | `make test` | [!] 원인: 막힘; 재시도: T1 완료 |
