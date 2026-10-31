<!-- doc-id: packaging -->
<!-- source-sha256: ea55c0714f6437cfd0f52f694e3f926f6d9bb4a601e20af2df1d6811a41de9c9 -->
# 패키징 결정

| 결정 | 선택 | 이유 | 변경 조건 |
|---|---|---|---|
| 문장 계획 | 호출한 프로세스 안의 클라이언트 라이브러리. 실행기는 네이티브 드라이버를 사용한다 | ORM 도입에 라이브러리만 필요하며 배포하고 운영할 서비스나 데몬이 없다 | 없음 |
| 모델 생성 | 언어마다 생성기 하나: Go `orm-gen gen --lang go`, PHP `vendor/bin/orm-gen`, TypeScript `orm-gen` npm bin, Rust `build.rs`의 `polyspec-orm-build` crate, Python package의 `orm-gen` script. 각 생성기는 document set을 set 파일 `dbspec-set.json`으로만 받는다([문서 집합](../spec/dbspec.ko.md#document-sets)) | 각 언어가 자기 빌드 도구로 빌드하고, set 파일 하나가 모두에게 set을 선언한다 | 없음 |
| 언어 간 동일성 | MySQL, PostgreSQL, SQLite에서 `tests/conformance` 벡터 실행 | Go, PHP, PHP extension, TypeScript, Python, Rust의 여섯 declared implementation은 SQL, bind, 결과의 공통 contract를 따른다. 완료된 실행 coverage는 따로 기록한다 | 없음 |
| artifacts | `orm-gen-<version>-<os>-<arch>`, `SHA256SUMS` | Go `orm-gen`은 빌드 시점에 실행한다. 스키마 작업은 클라이언트 라이브러리 함수다 | version은 VERSION 파일에서 오며 `latest` symlink를 사용하지 않는다 |
| distribution | Go: module path; PHP: `bin/orm-gen`을 포함한 composer package `polyspec/orm`; TypeScript: `orm-gen` bin을 포함한 npm package `@polyspec/orm`; Rust: `polyspec-orm`과 `polyspec-orm-build` crate | — | registry 게시가 필요하면 별도 결정으로 처리한다 |
| configuration | DSN과 secret은 연결 호출의 인자다. 스키마 경로는 연결 옵션(Go, PHP, TypeScript)이거나, 생성된 스키마가 `Db.connect_schema`의 인자이거나(Python), 빌드가 포함한다(Rust) | — | — |
| drivers | Go `go-sql-driver/mysql`, `pgx`, `modernc.org/sqlite`; Rust `sqlx`; PHP `pdo_mysql`, `pdo_pgsql`, `pdo_sqlite`; TypeScript `mysql2`, `pg`, `node:sqlite` | [perf.md](perf.md) §4 | 다른 드라이버가 hot path에서 2배 빠르다는 측정 |
| YAML 코덱 | Go `github.com/goccy/go-yaml`(읽기, U+0085를 내용으로 읽는다)와 `go.yaml.in/yaml/v3`(쓰기), Python `rapidyaml`(읽기)와 `ruamel.yaml`(쓰기), PHP `purrphp/yaml`(읽기)와 `symfony/yaml`(쓰기), Rust `saphyr-parser`(읽기)와 `serde-saphyr`(쓰기), TypeScript `yaml`; lock 파일을 커밋한다. PHP extension은 현재 PHP library 호출로 YAML에 접근하며 native codec 이전은 T182-2에서 열려 있다. | 80개 vector와 잘못된 입력 사례는 Go, PHP, PHP extension, TypeScript, Python, Rust의 공통 기대값이다. 이는 contract이며 native codec coverage가 완료됐다는 뜻은 아니다. | 공통 벡터와 오류 사례가 유지되는 경우에만 라이브러리를 교체한다 |

## release asset에서 설치

0.0.x 동안 polyspec package는 GitHub로만, release asset과 tag로 배포한다. npm, Composer, Python package는 어떤 registry(npm, Packagist, PyPI)에도 없다. GitHub Release마다 `polyspec-orm-npm-<version>.tgz`, `polyspec-orm-php-<version>.zip`, `polyspec-orm-gen-php-<version>.zip`, `polyspec-orm-php-ext-php-<version>.zip`과 Python wheel `polyspec_orm-<version>-py3-none-any.whl`이 있다(`<package>-<language>-<version>.<ext>`, Python client release 참조). 각 asset은 저장소 tree의 manifest를 그대로 담고, 그 manifest는 다른 polyspec package를 모두 그 release의 정확한 version으로 선언하므로, project는 필요한 release asset을 내려받아 함께 설치한다. `make release-assets TAG=vX.Y.Z`가 tag한 commit에서 그것을 만든다.

- npm: orm tarball과, 그것이 의존하는 polyspec package마다 orm `package.json`이 적은 version의 GitHub Release에 있는 tarball을 모두 `file:` dependency로 나열한다. npm은 `@polyspec/ordered-json`의 정확한 version을 함께 설치한 tarball로 채운다:

  ```json
  {
    "dependencies": {
      "@polyspec/orm": "file:vendor/polyspec-orm-npm-<version>.tgz",
      "@polyspec/ordered-json": "file:vendor/polyspec-ordered-json-npm-0.0.14.tgz"
    }
  }
  ```

- Composer: release마다 `packages.json` asset을 게시한다. 이는 package의 `composer.json`과 그 zip의 URL·sha1을 담은 `composer` repository이고, Composer는 거기서 이름, version, 요구 사항을 읽는다(kit K865). Composer는 project의 root manifest에서만 `repositories`를 읽으므로, consumer는 orm release와 그것이 요구하는 polyspec package(ordered-json `0.0.14`)마다 그 `packages.json`을 선언한다. orm의 `packages.json`은 orm 0.0.19부터 있다.

  ```json
  {
    "require": { "polyspec/orm": "<version>" },
    "repositories": [
      { "type": "composer", "url": "https://github.com/polyspec/orm/releases/download/v<version>/packages.json" },
      { "type": "composer", "url": "https://github.com/polyspec/ordered-json/releases/download/v0.0.14/packages.json" },
      { "type": "vcs", "url": "https://github.com/min-0-max/yaml", "no-api": true }
    ]
  }
  ```

  client는 `purrphp/yaml` `1.0.0-p1`을 요구한다. 이는 fork https://github.com/min-0-max/yaml 의 release로, plain scalar를 YAML 1.2.2의 core schema(10.3.2절)로 읽는다. upstream 1.0.0 release는 그렇게 읽지 않는다. Composer는 `repositories`를 project의 root manifest에서만 읽고 의존성의 manifest에서는 읽지 않으므로, orm package는 이 source를 consumer에게 전달할 수 없다: consumer가 위처럼 `vcs` repository를 직접 선언한다. `no-api`는 Composer가 GitHub API에 묻지 않고 공개 repository를 HTTPS로 clone하게 한다. 그렇지 않으면 API의 익명 rate limit(HTTP 403)이 Composer가 key가 필요한 SSH clone으로 넘어간다.

  `polyspec/orm-php-ext`는 type `php-ext`다: PIE가 build하고 설치하며, Composer는 설치하지 않는다.

## Python client release

Python client인 `packages/python/pyproject.toml`(배포 이름 `polyspec-orm`)은 PEP 427 wheel `polyspec_orm-<version>-py3-none-any.whl`로 release되며, GitHub Release의 asset으로 npm과 Composer archive 곁에 놓인다. `make release-assets TAG=vX.Y.Z`가 tag된 commit에서 `uv build`로 wheel을 만들고, build backend는 pyproject.toml의 `build-system.requires`(`setuptools==84.0.0`)에서 가져온다. wheel은 `<package>-<language>-<version>.<ext>` 형식의 archive가 아니므로 PEP 427 이름을 유지한다.

wheel의 `Requires-Dist`는 registry package이면 정확한 `name==version`이고, polyspec package이면 asset의 sha256을 붙인 direct reference다(kit K49): `polyspec-ordered-json @ https://github.com/polyspec/ordered-json/releases/download/v0.0.14/polyspec_ordered_json-0.0.14-py3-none-any.whl#sha256=bd2f…0f4b`. ordered-json은 어떤 package index에도 없고 참조가 그 release asset을 가리키므로, lock 없는 pip install도 GitHub에서 받으며 package index에 그 이름을 묻지 않는다. Python client의 lock인 `packages/python/uv.lock`은 transitive를 포함한 모든 의존성을 file마다 hash와 함께 담고, ordered-json은 그 release asset의 URL과 sha256으로 담는다. `make orm-python-lock`이 `packages/python/pyproject.toml`에서 `uv lock`으로 그것을 쓴다. `make orm-install-python`은 `uv sync --locked --no-editable --group test`로 그것에서 client를 non-editable로 설치하며, uv가 각 파일을 lock의 hash로 검사한다. wheel은 Python 3.14와 CPython만 지원한다: `requires-python`은 `>=3.14`이며, CI가 test하는 `mise.toml` Python의 minor release이고 그보다 오래된 release는 아니다. 의존성 `polyspec-ordered-json==0.0.9`이 3.14를 요구하기 때문이다. `packages/python/tests/test_requires_python.py`가 둘을 비교한다. orm의 toolchain은 python-build-standalone의 CPython이며, package는 classifier `Programming Language :: Python :: Implementation :: CPython`을 선언한다. 그래서 `psycopg-binary==3.3.6` 의존성은 다른 구현을 위한 marker 없이 psycopg의 binary build를 직접 이름 붙인다.

psycopg의 binary extra는 그것이 펼쳐지는 두 plain requirement `psycopg==3.3.6`과 `psycopg-binary==3.3.6`으로 적는다. 그 extra는 PyPy를 제외하는데 plain requirement로는 그것을 나타낼 수 없으므로, PyPy에서도 `psycopg-binary`를 요구한다.

## 개발 배치

release하는 manifest는 packages/ts/package.json, packages/php/composer.json, packages/php-ext/composer.json이다. 그것들은 다른 저장소의 polyspec package를 정확한 version으로 받고 repository를 선언하지 않는다. release하지 않는 두 private root manifest가 이 저장소에서 그 version을 푼다:

- 저장소 root의 package.json은 `workspaces`에 `packages/*`를 두고, 그 `overrides`는 `@polyspec/ordered-json`을 GitHub Release의 tarball URL(release tag를 적는다)에서 받고, vitepress의 최신 release가 advisory가 있는 `vite` 5에 의존하므로 `vite` 7을 받는다. root의 `npm ci`가 workspace를 설치하고. root의 package-lock.json이 유일한 npm lockfile이다.
- 저장소 root의 composer.json은 packages/php를 `path` repository에서, polyspec/ordered-json을 `dist`가 GitHub Release의 zip URL과 그 shasum인 `package` repository에서 설치한다. URL이 release tag를 적는다. purrphp/yaml은 fork min-0-max/yaml의 `vcs` repository에서 설치한다. development dependency인 opis/json-schema `2.6.0-p1`은 fork min-0-max/json-schema의 `vcs` repository(`no-api`)에서 설치한다. 이 release는 모든 error를 모으는 mode에서 모든 거부를 보고하며 PHP vector runner(tests/dbspec/vectors.php)가 쓴다. 공개되는 manifest는 이를 요구하지 않으므로 consumer는 아무것도 선언하지 않는다. 그 `vendor-dir`은 vendor-php다. root의 vendor는 Go module의 vendor directory이기 때문이다. `config.platform.php`는 client의 가장 낮은 PHP인 `8.4.0`이다. root의 composer.lock이 유일한 Composer lockfile이고, PHP test는 vendor-php/autoload.php를 load한다.

## 생성되는 error code source

client의 error code source는 `orm-gen errors --lang <lang>`이 docs/spec/errors.yaml에서 생성한다. packages/go/orm/codes.go와 packages/rust/orm/src/codes.rs는 추적된다(config/generated.json의 `tracked`). go.mod나 Cargo.toml consumer는 generator를 실행하지 않고 tag의 tree를 설치하기 때문이다. packages/ts/src/codes.ts, packages/php/src/Code.php, packages/python/src/polyspec/orm/codes.py는 build 산출물이며 추적되지 않는다(config/generated.json의 `paths`). `make orm-codes-typescript`, `make orm-codes-php`, `make orm-codes-python`이 mise.toml의 Go로 이를 쓰며, 각 파일을 rename으로 publish한다. 파일을 읽는 모든 make target은 맞는 target을 prerequisite로 직접 또는 php-vendor-check나 python-venv-check를 거쳐 가지므로, make는 recipe가 읽기 전에 파일을 쓴다. recipe가 파일을 읽으면서 그 prerequisite가 없는 target은 `make repo-check`가 실패시킨다. release는 이를 build된 대로 담는다. TypeScript package는 typescript-build가 compile한 dist를 담고, PHP archive와 Python wheel은 config/release.json의 make entry orm-codes-php와 orm-codes-python에서 파일을 받는다. 각 client의 code-catalog test(packages/go/orm/codes_test.go, packages/php/tests/CodeCatalogTest.php, packages/rust/orm/tests/code_catalog.rs, packages/ts/tests/code-catalog.mjs, packages/python/tests/test_code_catalog.py)가 파일을 docs/spec/errors.yaml과 같게 유지하며, error-codes feature가 이를 다시 생성해 검사한다.
