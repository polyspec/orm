<!-- doc-id: rebuild-rust-comments -->
<!-- source-sha256: 0dcfa0d09e33e6bf37f97256650734cd5e7da4d4fc54e32681d8aab0b8d44760 -->
# 재구현 기록: Rust 주석 lexer

주석 언어 검사(`scripts/comments/`)는 추적되는 모든 Rust 파일(`.rs`)의 주석을 읽어야 한다. PRINCIPLES.md의 S1은
각 생태계의 도구를 먼저 쓰라고 하므로, 이 기록은 Rust toolchain이나 저장소 의존성의 어떤 도구도 주석 token을
돌려주지 않는 이유를 적는다.

## 요구

`.rs` 파일의 모든 주석을 줄과 열, 텍스트와 함께 얻는다. 문자열 literal, raw string(`r#"..."#`)과 lifetime(`'a`)은
code이며 주석이 아니다. 중첩된 block 주석(`/* /* */ */`)은 하나의 주석이다.

## 찾아본 도구

- `proc_macro2::TokenStream`(`syn`의 의존성이며 `Cargo.lock`에 있다): token stream은 주석을 버리므로 돌려줄 수 없다.
- `syn`(`Cargo.lock`에 있다): 문법 tree를 만드는 parser다. 주석은 tree의 일부가 아니므로 돌려줄 수 없다.
- `rustfmt`: 주석을 보존하며 format하지만 token stream을 출력하지 않는다.
- `rustc_lexer`(컴파일러의 lexer, `Comment` token): 이 저장소의 의존성이 아니다. 추가하려면 새 lock 항목과
  의존성 정책 검토가 필요하며, 이 검사만으로는 그것을 정당화할 수 없다.

## 맞지 않는 이유

저장소의 toolchain과 의존성 어디에도 위치가 있는 주석 token을 돌려주는 도구가 없으므로, 검사는 자체 lexer
`scripts/comments/own-lexer.mts`를 `RUST` 문법으로 써서 주석을 읽는다. 이 lexer는 문자열과 raw string을 건너뛰고,
뒤에 문자 literal이 없으면 `'`를 lifetime으로 보며, block 주석을 중첩으로 센다. 단위 case는
`scripts/comments/check.test.mts`에 있다. `rustc_lexer` 등 다른 lexer가 선언된 의존성이 되면 이 기록은 그
의존성의 tokenizer로 대체된다.
