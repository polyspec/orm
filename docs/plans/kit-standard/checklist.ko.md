<!-- doc-id: checklist-kit-standard -->
<!-- source-sha256: f73cfd4dd05ad1251cb528edb594a08251352604bb8deac617526b1711b11fdd -->
# kit 표준 체크리스트

| ID | Task | Deliverables | Verification | State |
|---|---|---|---|---|
| KSTD | 이 저장소는 kit 표준 0.0.54를 따른다 | the layout, plans, pins and lint fixes of the rollout | `make layout-check`, `make lint-ts` | [!] 원인: 이 계획의 parity, 문서, Go lint 항목은 CI 실행을 기다린다; 재시도: 이 계획의 항목이 차례로 끝난 뒤 |
| KSTD-2 | config/parity.json의 모든 unit은 모든 구현에서 성립하고, test가 이름으로 적은 spec requirement를 인용한다 (kit K273, K275, K276) | config/parity.json, docs/spec, the tests of every implementation | `make parity-declarations-check` | [!] 원인: 선언이 아직 profile, native 전용 symbol이나 exclusion, 또는 명명된 requirement가 없는 unit을 담고 있다; 각 구현의 누락된 feature와 test는 red-first로 작성되어야 한다; 재시도: kit 0.0.55를 make kit-sync로 설치한 후 |
