# 문서 빌드와 배포

온라인 문서 주소는 [polyspec.github.io/orm](https://polyspec.github.io/orm/)이에요. 저장소의 `docs/*.md`와 하위 Markdown을 VitePress가 직접 읽으며, 본문을 복사한 별도 문서 원본은 두지 않아요. 공통 도표인 `interfaces-model.md`는 `contracts/interfaces.json`에서 생성해요.

## 로컬 실행

Node.js 22.12 이상과 npm을 사용해요. `package-lock.json`으로 도구 버전을 고정해요.

```sh
npm ci
npx playwright install chromium
make docs-dev
```

개발 서버의 `/orm/`에서 문서를 확인할 수 있어요. Mermaid 블록을 바꾸면 개발 서버를 다시 시작해서 SVG를 생성해요.

## 정적 빌드와 검사

```sh
make docs-check
VITEPRESS_BASE=/orm/ make docs-static-check
make docs-verify-idempotent
```

`docs-check`는 Mermaid를 SVG로 렌더링하고 사이트를 빌드한 뒤 정적 검사를 실행해요. `docs-static-check`는 이미 만든 `docs/.vitepress/dist`를 검사해요. `docs-verify-idempotent`는 같은 원본으로 두 번 빌드하고 모든 출력 파일의 바이트가 같은지 비교해요.

정적 검사는 일반 파일 서버에서 개별 HTML을 직접 열어요. 내부 링크·앵커·이미지·스크립트 경로, 자바스크립트를 끈 본문과 도표, 검색과 모바일 메뉴를 확인해요. 존재하지 않는 주소를 앱의 첫 페이지로 돌려주는 서버 기능에 의존하지 않아요. 저장소 소스와 오류 카탈로그 링크는 GitHub의 실제 파일 경로로 연결해요.

결과는 `docs/.vitepress/dist`예요. HTML·CSS·자바스크립트·검색 인덱스·SVG만 배포하며, 서버 애플리케이션이나 런타임 Mermaid 서비스는 필요하지 않아요. 본문과 도표는 자바스크립트 없이 읽을 수 있고, 검색·테마·모바일 메뉴는 자바스크립트를 사용해요.

기본 경로는 `/orm/`이에요. 도메인의 루트에 호스팅할 때는 빌드와 검사를 모두 같은 경로로 실행해요.

```sh
VITEPRESS_BASE=/ make docs-check
```

## GitHub Pages

[문서 배포 workflow](../.github/workflows/docs-pages.yml)는 `main` push와 수동 실행에서 정적 검사를 거친 결과를 Pages로 배포해요. Pull request에서는 같은 빌드·검사까지 실행해요. Pages 설정의 빌드 방식은 **GitHub Actions**예요.

`build` 작업이 `docs/.vitepress/dist`를 Pages 아티팩트로 올리고, `deploy` 작업이 `github-pages` 환경에 배포해요. 배포 주소와 실행 결과는 [Actions](https://github.com/polyspec/orm/actions/workflows/docs-pages.yml)에서 확인할 수 있어요.

## 명세 변경 시 동기화

계약을 바꾸면 [자동 검사 안내](../tests/interfaces/README.md)에 따라 네이티브 코드·심볼·생성 도표를 함께 갱신해요. 사용법과 구현 대조표, 체크리스트도 검증한 상태로 맞춘 뒤 `make docs-check`로 사이트의 링크와 정적 출력을 확인해요. 원본 Markdown·설정·검사기는 커밋하고 `dist`, SVG 중간 산출물과 캐시는 커밋하지 않아요.
