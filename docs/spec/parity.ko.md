<!-- doc-id: parity-spec -->
<!-- source-sha256: b1dbdf38d73f326df17efde4568f24291ff40a75538580a2796c4c02ca4ff0c6 -->
# 언어 parity

## 구현 내부 test

구현 내부 test는 그 구현 자신의 구조를 검사한다. 공유 사례에 대응하는 항목이 없으므로 단일 구현 profile에 묶인다.

PHP의 SQLite case는 sqlite 경로가 MySQL dialect class를 load하지 않는다는 것만 증명한다. method 호출과 상수에 대해서는 아무것도 증명하지 않는다.

## 비교 directory

비교 directory는 공용 비교와 생성 runner가 호출하는 program을 담으므로, 그 안의 test는 어떤 구현에도 속하지 않는다. 각 directory는 실행하는 호출자와 함께 적는다:

- `tests/conformance`: `runner.php`와 `result_php_helpers.php`는 PHP conformance runner와 그 결과 helper이며, `tests/conformance/check/main.mts`가 호출한다.
- `tests/dbspec`: dbspec 비교의 PHP driver와 그곳의 TypeScript binding이다. `apply/php.php`, `apply/php-extension.php`는 `packages/go/internal/dialects/apply_clients_physical_test.go`가 호출하고; `compare/php.php`, `compare/php-extension.php`, `compare/php-interface.php`는 `tests/dbspec/compare/runners.mts`가 호출하며; `introspect/php.php`, `introspect/php-extension.php`는 `packages/go/internal/dialects/introspect_compare_physical_test.go`가 호출한다. `cases.php`, `input.php`, `vectors.php`는 그 driver가 쓰는 dbspec vector file을 읽는 reader다. TypeScript 파일은 자기 declaration을 유지한다.
- `tests/interfaces`: `php.php`는 `tests/interfaces/check/extract.mts`가 호출하는 PHP reflection extractor다.
