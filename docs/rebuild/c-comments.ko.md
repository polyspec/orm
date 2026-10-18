<!-- doc-id: rebuild-c-comments -->
<!-- source-sha256: 715b9d31479f773bfd6cad885b78a62307aad542a8f5debe3f2a4d1037626b31 -->
# 재구현 기록: C 주석 lexer

주석 언어 검사는 추적되는 C와 C++ 소스(`.c`, `.h`, `.cpp`, `.hpp`), 곧 PHP 확장의 소스의 주석을 읽는다. PRINCIPLES.md의
S1은 각 생태계의 도구를 먼저 쓰라고 한다. 이 기록은 어떤 도구도 맞지 않는 이유를 적는다.

## 요구

C 소스의 모든 주석을 줄과 열, 텍스트와 함께 얻는다. 문자열 literal과 문자 literal은 code다. block 주석은 하나의
주석이며 중첩되지 않는다.

## 찾아본 도구

- C 전처리기(`cc -E`, `phpize`와 확장 build가 쓰는 compiler): 주석을 지우고 token stream을 출력하지 않으므로
  돌려줄 수 없다.
- `clang`과 libclang: tokenizer가 있으나 `config/toolchain.json`이 clang을 선언하지 않고, 확장 build는 플랫폼
  compiler를 쓴다. clang을 요구하면 저장소가 고정하지 않은 toolchain이 추가된다.
- `tree-sitter`(C 문법): 선언되어 있지 않고 저장소의 lock에도 없다.

## 맞지 않는 이유

저장소의 선언된 도구 중 위치가 있는 C 주석 token을 돌려주는 것이 없으므로, 검사는 자체 lexer
`scripts/comments/own-lexer.mts`를 `C` 문법으로 써서 주석을 읽는다. 문자열과 문자 literal은 건너뛰며, `//`와
`/* */`를 주석으로 본다. 단위 case는 `scripts/comments/check.test.mts`에 있다. C tokenizer가 선언된 도구가 되면 이
기록은 그 도구로 대체된다.
