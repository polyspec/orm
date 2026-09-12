# 문서 빌드와 배포

온라인 문서는 [polyspec.github.io/orm](https://polyspec.github.io/orm/)에서 제공한다. VitePress는 `docs/*.md`와 하위 Markdown 파일을 직접 읽는다. 별도의 문서 복사본은 사용하지 않는다. 구성요소 도표는 `contracts/interfaces.json`에서 생성한다.

## 로컬 실행

Node.js 22.12 이상과 npm을 사용한다. 도구 버전은 `package-lock.json`으로 고정한다.

```sh
npm ci
npx playwright install chromium
make docs-dev
```

개발 서버의 `/orm/`에서 문서를 확인한다. Mermaid 블록을 변경한 후 서버를 다시 시작해 SVG를 생성한다.

## 정적 빌드와 검사

```sh
make docs-check
VITEPRESS_BASE=/orm/ make docs-static-check
make docs-verify-idempotent
```

`docs-check`는 Mermaid를 SVG로 렌더링하고 사이트를 빌드한 후 정적 검사를 실행한다. `docs-static-check`는 기존 `docs/.vitepress/dist`를 검사한다. `docs-verify-idempotent`는 같은 입력으로 두 번 빌드하고 모든 출력 바이트를 비교한다.

정적 검사는 일반 파일 서버에서 각 HTML 파일을 연다. 내부 링크, 앵커, 이미지·스크립트 경로, JavaScript 없이 표시되는 본문과 도표, 검색, 모바일 메뉴를 검사한다. 존재하지 않는 경로는 오류이며 다른 앱 경로를 제공하지 않는다. 저장소 소스와 오류 목록 링크는 실제 GitHub 파일에 연결된다.

결과는 `docs/.vitepress/dist`에 생성한다. HTML, CSS, JavaScript, 검색 인덱스, SVG를 배포한다. 서버 애플리케이션과 실행 시 Mermaid 서비스는 필요하지 않다. 본문과 도표는 JavaScript 없이 읽을 수 있다. 검색, 테마, 모바일 메뉴는 JavaScript를 사용한다.

기본 경로는 `/orm/`이다. 도메인 루트에 호스팅할 때는 빌드와 검사를 같은 경로 설정으로 실행한다.

```sh
VITEPRESS_BASE=/ make docs-check
```

## GitHub Pages

[문서 배포 workflow](../.github/workflows/docs-pages.yml)는 `main` push와 수동 실행에서 정적 검사를 통과한 결과를 Pages에 게시한다. Pull request에서도 같은 빌드와 검사를 실행한다. Pages 빌드 방식은 **GitHub Actions**다.

`build` 작업은 `docs/.vitepress/dist`를 Pages 아티팩트로 업로드하고 `deploy` 작업은 `github-pages` 환경에 게시한다. 배포 주소와 실행 결과는 [Actions](https://github.com/polyspec/orm/actions/workflows/docs-pages.yml)에서 확인한다.

## 명세 변경 후 동기화

명세를 변경하면 [자동 검사 안내](../tests/interfaces/README.md)에 따라 네이티브 코드, 심볼, 생성 도표를 갱신한다. 사용법, 구현 대조표, 체크리스트를 갱신한 후 `make docs-check`로 링크와 정적 출력을 검사한다. Markdown, 설정, 검사기는 커밋한다. `dist`, 중간 SVG, 캐시는 커밋하지 않는다.
