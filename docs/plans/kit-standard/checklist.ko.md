<!-- doc-id: checklist-kit-standard -->
<!-- source-sha256: f14d153319a90e817ebeaf5ce5694c67219814b0463ec427e6206b6073f0a5a4 -->
# kit 표준 체크리스트

| ID | Task | Deliverables | Verification | State |
|---|---|---|---|---|
| KSTD | 이 저장소는 kit 표준 0.0.54를 따른다 | the layout, plans, pins and lint fixes of the rollout | `make layout-check`, `make lint-ts` | [!] 원인: 이 계획의 parity, 문서, Go lint 항목은 CI 실행을 기다린다; 재시도: 이 계획의 항목이 차례로 끝난 뒤 |
| KSTD-2 | config/parity.json의 모든 unit은 모든 구현에서 성립하고, test가 이름으로 적은 spec requirement를 인용한다 (kit K273, K275, K276) | config/parity.json, docs/spec, the tests of every implementation | `make parity-declarations-check` | [~] |
| KSTD-2-2 | 문서가 PHP extension을 구현으로 세고 나열한다(KSTD-2에 이어). 원인: config/parity.json의 구현을 언어 집합으로 삼자 docs-rules-check가 docs.implementation-count 69건을 보고한다: client N개를 세는 문장 43, PHP extension 열이 없는 표 13, 나열된 집합 11, PHP extension 행이 없는 protocol.md와 protocol.ko.md 4절 | docs/spec, docs/operations and their Korean twins | `make docs-rules-check` | [ ] |
| KSTD-2-3 | logical contract가 모든 rule에 php-extension native를 둔다(KSTD-2에 이어). 원인: S10에 따라 extension이 PHP library 전체를 구현하는데 tests/interfaces/contracts/validate.go와 contracts/interfaces.json의 native contract 표에 php-extension 항목이 없어 TestLogicalContractRejectsNativeDrift가 Model.connect missing php-extension으로 실패한다 | contracts/interfaces.json, tests/interfaces/contracts/validate.go, packages/php-ext | `go test ./tests/interfaces/contracts/ -run TestLogicalContractRejectsNativeDrift` | [ ] |
