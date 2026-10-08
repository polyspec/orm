<!-- doc-id: docs-development -->
<!-- source-sha256: 6b30e9c43d788ba8829b0d81a8efaf94d58d4e2628cc4d9d05165df6397e28d0 -->
# 문서 빌드와 배포

온라인 문서는 [polyspec.github.io/orm](https://polyspec.github.io/orm/)에서 제공한다. VitePress는 `docs/*.md`와 하위 Markdown 파일을 직접 읽는다. 별도의 문서 복사본은 사용하지 않는다. 구성요소 도표는 `contracts/interfaces.json`에서 생성한다.

## 로컬 실행

`.node-version`의 Node.js release(26.8.1)와 npm을 사용한다. 로컬 검사와 모든 GitHub Actions workflow가 이 release 하나로 실행하며, 다른 release에서는 `make repo-check`가 실패한다. 도구 버전은 `package-lock.json`으로 고정한다. TypeScript client는 `package.json` `engines.node`의 최저 release(22.16.0)를 지원하고, `make ts-min-check`가 그 release에서 test를 실행한다.

```sh
make install
make docs-dev
```

개발 서버의 `/orm/`에서 문서를 확인한다. 변경한 Mermaid 블록은 page를 다시 불러오면 보인다.

## 정적 빌드와 검사

```sh
make docs-check
make docs-verify-idempotent
```

`docs-check`는 사이트를 빌드한 후 결과를 검사한다. `docs-verify-idempotent`는 같은 입력으로 두 번 빌드하고 모든 출력 바이트를 비교한다. 빌드와 검사는 Node.js만으로 실행하며 브라우저가 필요하지 않다.

검사는 결과의 각 HTML 파일을 읽는다. 모든 Markdown 페이지에 HTML 페이지가 있고, 모든 내부 링크, stylesheet, 이미지, 스크립트 경로가 결과의 파일을 가리키며, 모든 앵커가 그 페이지의 id를 가리키고, Mermaid 블록이 소스로 페이지에 들어 있다. 존재하지 않는 경로나 앵커는 오류다. 저장소 소스와 오류 목록 링크는 실제 GitHub 파일에 연결된다.

결과는 `docs/.vitepress/dist`에 생성한다. HTML, CSS, JavaScript, 검색 인덱스를 배포한다. 서버 프로그램은 필요하지 않다. 각 Mermaid 블록은 소스로 게시하고, 테마가 읽는 이의 브라우저에서 `mermaid`로 SVG를 그린다. 본문과 Mermaid 소스는 JavaScript 없이 읽을 수 있다. 도표, 검색, 테마, 모바일 메뉴는 JavaScript를 사용한다.

기본 경로는 `/orm/`이다. 도메인 루트에 호스팅할 때는 빌드와 검사를 같은 경로 설정으로 실행한다.

```sh
VITEPRESS_BASE=/ make docs-check
```

## GitHub Pages

[문서 배포 workflow](../.github/workflows/docs-pages.yml)는 `main` push와 수동 실행에서 정적 결과를 빌드해 Pages에 게시한다. 문서 검사(`make docs-ci`: idempotence 검사와 `docs-check`)는 모든 pull request와 merge group에서 [CI workflow](../.github/workflows/ci.yml)의 `docs` job이 실행하고, `main`은 그 검사를 요구한다. Pages 빌드 방식은 **GitHub Actions**다.

`build` 작업은 `docs/.vitepress/dist`를 Pages 아티팩트로 업로드하고 `deploy` 작업은 `github-pages` 환경에 게시한다. 배포 주소와 실행 결과는 [Actions](https://github.com/polyspec/orm/actions/workflows/docs-pages.yml)에서 확인한다.

## 명세 변경 후 동기화

명세를 변경하면 [자동 검사 안내](../tests/interfaces/README.md)에 따라 네이티브 코드, 심볼, 생성 도표를 갱신한다. 사용법, 구현 대조표, 체크리스트를 갱신한 후 `make docs-check`로 링크와 정적 출력을 검사한다. Markdown, 설정, 검사기는 커밋한다. `dist`와 캐시는 커밋하지 않는다.
