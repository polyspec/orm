<!-- doc-id: checklist-kit-standard -->
<!-- source-sha256: f14d153319a90e817ebeaf5ce5694c67219814b0463ec427e6206b6073f0a5a4 -->
# kit 표준 체크리스트

| ID | Task | Deliverables | Verification | State |
|---|---|---|---|---|
| KSTD | 이 저장소는 kit 표준 0.0.54를 따른다 | the layout, plans, pins and lint fixes of the rollout | `make layout-check`, `make lint-ts` | [!] 원인: 이 계획의 parity, 문서, Go lint 항목은 CI 실행을 기다린다; 재시도: 이 계획의 항목이 차례로 끝난 뒤 |
| KSTD-2 | config/parity.json의 모든 unit은 모든 구현에서 성립하고, test가 이름으로 적은 spec requirement를 인용한다 (kit K273, K275, K276) | config/parity.json, docs/spec, the tests of every implementation | `make parity-declarations-check` | [~] |
