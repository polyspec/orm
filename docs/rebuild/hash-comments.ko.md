<!-- doc-id: rebuild-hash-comments -->
<!-- source-sha256: 890c5f272c7e4ea3605e7b20dcd4d91a0d1d30ee022f08fbc0ccaa359fdbdad7 -->
# 재구현 기록: hash 주석 lexer

주석 언어 검사는 저장소의 Makefile, shell script, TOML, INI, YAML과 m4 파일의 주석을 읽는다. 이 파일들은 `#`으로
주석을 쓴다. PRINCIPLES.md의 S1은 각 생태계의 도구를 먼저 쓰라고 한다. 이 기록은 어떤 도구도 맞지 않는 이유를 적는다.

## 요구

이 파일들의 모든 `#` 주석을 줄과 열, 텍스트와 함께 얻는다. 문자열 안의 `#`은 주석이 아니며, Makefile에서 `\#`은
문자 그대로의 문자다.

## 찾아본 도구

- `make`: Makefile을 파싱하고 실행하지만 주석을 보관하지 않으며 token stream을 출력하지 않는다. `make -p`는 주석이
  없는 database를 출력한다.
- `sh -n`과 `bash -n`: shell script의 문법을 검사할 뿐 token에 대해 아무것도 출력하지 않는다.
- `tomllib`(Python): TOML을 읽고 주석을 버린다.
- YAML library: 선언된 YAML parser는 돌려주는 data에서 주석을 버린다. 주석을 보존하는 library는 저장소가 선언하지
  않았다.
- `m4`: macro를 확장한 결과를 출력하며 token을 출력하지 않는다.

## 맞지 않는 이유

선언된 도구 중 이 형식들의 주석을 위치와 함께 돌려주는 것이 없으므로, 검사는 자체 lexer
`scripts/comments/own-lexer.mts`를 `HASH` 문법으로 써서 주석을 읽는다. 앞에 backslash가 없는 `#`이 주석을 시작하며,
작은따옴표와 큰따옴표 문자열은 건너뛴다. 단위 case는 `scripts/comments/check.test.mts`에 있다. 선언된 도구가 이
주석들을 돌려주게 되면 이 기록은 그 도구로 대체된다.
