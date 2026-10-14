<!-- doc-id: security -->
<!-- source-sha256: 97e5ac78b37b35c02415a3783f74c7a8df5343ceb98c84fc1eb22e0a444953f2 -->
# 보안 정책

## 신고 방법

보안 문제로 의심되는 내용을 공개 issue로 등록하기 전에 저장소 소유자에게 비공개로 신고한다. 영향받은 version, database driver, client language, 재현 절차, 영향 범위를 포함한다. 실제 credential과 운영 data는 포함하지 않는다.

## 지원 version

개발 version은 `0.0.14`이다. 보안 수정은 현재 source tree를 기준으로 검토한다.

## 범위

SQL 생성, parameter binding, compiler transport validation, encryption과 key rotation, migration 실행, generated client code를 신고할 수 있다. database driver 또는 dependency 취약점은 영향받은 dependency version도 포함한다.
