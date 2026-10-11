<!-- doc-id: packaging -->
<!-- source-sha256: e9dd4b2a4bc477fee521552d6984972ce8d730fc24a23191746b0d5052971de5 -->
# 패키징 결정

| 결정 | 선택 | 이유 | 변경 조건 |
|---|---|---|---|
| 문장 계획 | 호출한 프로세스 안의 클라이언트 라이브러리. 실행기는 네이티브 드라이버를 사용한다 | ORM 도입에 라이브러리만 필요하며 배포하고 운영할 서비스나 데몬이 없다 | 없음 |
| 모델 생성 | 언어마다 생성기 하나: Go `orm-gen gen --lang go`, PHP `vendor/bin/orm-gen`, TypeScript `orm-gen` npm bin, Rust `build.rs`의 `polyspec-orm-build` crate | 각 언어가 자기 빌드 도구로 빌드한다 | 없음 |
| 언어 간 동일성 | MySQL, PostgreSQL, SQLite에서 `tests/conformance` 벡터 실행 | 네 플래너가 같은 SQL, bind, 결과를 만들어야 한다 | 없음 |
| artifacts | `orm-gen-<version>-<os>-<arch>`, `SHA256SUMS` | Go `orm-gen`은 빌드 시점에 실행한다. 스키마 작업은 클라이언트 라이브러리 함수다 | version은 VERSION 파일에서 오며 `latest` symlink를 사용하지 않는다 |
| distribution | Go: module path; PHP: `bin/orm-gen`을 포함한 composer package `polyspec/orm`; TypeScript: `orm-gen` bin을 포함한 npm package `@polyspec/orm`; Rust: `polyspec-orm`과 `polyspec-orm-build` crate | — | registry 게시가 필요하면 별도 결정으로 처리한다 |
| configuration | DSN과 secret은 연결 호출의 인자다. 스키마 경로는 연결 옵션(Go, PHP, TypeScript)이거나 빌드가 포함한다(Rust) | — | — |
| drivers | Go `go-sql-driver/mysql`, `pgx`, `modernc.org/sqlite`; Rust `sqlx`; PHP `pdo_mysql`, `pdo_pgsql`, `pdo_sqlite`; TypeScript `mysql2`, `pg`, `node:sqlite` | [perf.md](perf.md) §4 | 다른 드라이버가 hot path에서 2배 빠르다는 측정 |
| YAML 코덱 | Go `go.yaml.in/yaml/v3`, PHP `symfony/yaml`, Rust `serde_yaml_ng`와 `yaml-rust2` 검사, TypeScript `yaml`; lock 파일을 커밋한다 | 네 클라이언트에서 같은 벡터 80개와 잘못된 입력 사례를 실행한다 | 공통 벡터와 오류 사례가 유지되는 경우에만 라이브러리를 교체한다 |

## release asset에서 설치

0.0.x 동안 polyspec package는 GitHub로만, release asset과 tag로 배포한다. npm, Composer, Python package는 어떤 registry(npm, Packagist, PyPI)에도 없다. GitHub Release마다 `polyspec-orm-npm-<version>.tgz`, `polyspec-orm-php-<version>.zip`, `polyspec-orm-dbspec-php-<version>.zip`과 Python wheel `polyspec_orm-<version>-py3-none-any.whl`이 있다(`<package>-<language>-<version>.<ext>`, Python client release 참조). 각 asset은 저장소 tree의 manifest를 그대로 담고, 그 manifest는 다른 polyspec package를 모두 그 release의 정확한 version으로 선언하므로, project는 필요한 release asset을 내려받아 함께 설치한다. `make release-assets TAG=vX.Y.Z`가 tag한 commit에서 그것을 만든다.

- npm: orm tarball과, 그것이 의존하는 polyspec package마다 orm `package.json`이 적은 version의 GitHub Release에 있는 tarball을 모두 `file:` dependency로 나열한다. npm은 `@polyspec/ordered-json`의 정확한 version을 함께 설치한 tarball로 채운다:

  ```json
  {
    "dependencies": {
      "@polyspec/orm": "file:vendor/polyspec-orm-npm-<version>.tgz",
      "@polyspec/ordered-json": "file:vendor/polyspec-ordered-json-npm-0.0.7.tgz"
    }
  }
  ```

- Composer: `artifact` repository는 내려받은 zip의 directory이고, Composer는 zip마다 그 `composer.json`에서 이름, version, 요구 사항을 읽는다. artifact repository는 orm zip과 그것이 요구하는 polyspec package마다 그 zip(`polyspec-ordered-json-php-0.0.7.zip`)을 담는다.

  ```json
  {
    "require": { "polyspec/orm": "<version>" },
    "repositories": [{ "type": "artifact", "url": "vendor/polyspec" }]
  }
  ```

  `polyspec/orm-dbspec`는 type `php-ext`다: PIE가 build하고 설치하며, Composer는 설치하지 않는다.

## Python client release

Python client인 `packages/orm-python/pyproject.toml`(배포 이름 `polyspec-orm`)은 PEP 427 wheel `polyspec_orm-<version>-py3-none-any.whl`로 release되며, GitHub Release의 asset으로 npm과 Composer archive 곁에 놓인다. `make release-assets TAG=vX.Y.Z`가 tag된 commit에서 wheel을 만들고, 그때 `config/release.json`의 `buildBackend`가 고정한 build backend(`setuptools==84.0.0`, sha256을 build마다 확인)를 쓴다. wheel은 `<package>-<language>-<version>.<ext>` 형식의 archive가 아니므로 PEP 427 이름을 유지한다.

wheel의 `Requires-Dist`는 registry package이면 정확한 `name==version`이고, polyspec package이면 asset의 sha256을 붙인 direct reference다(kit K49): `polyspec-ordered-json @ https://github.com/polyspec/ordered-json/releases/download/v0.0.8/polyspec_ordered_json-0.0.8-py3-none-any.whl#sha256=db98…645a`. ordered-json은 어떤 package index에도 없고 참조가 그 release asset을 가리키므로, lock 없는 pip install도 GitHub에서 받으며 package index에 그 이름을 묻지 않는다. `config/release.json`은 polyspec 의존성의 repository를 `consumers.wheel.polyspec`에, wheel의 lock을 `consumers.wheel.lock`에 선언한다. `packages/orm-python/pylock.toml`(PEP 751)은 transitive를 포함한 모든 의존성을 file마다 sha256과 함께 담고, ordered-json은 같은 URL과 sha256의 archive 항목으로 담는다. release proof는 그 lock을 `--require-hashes`로 설치한 뒤 orm의 wheel을 `--no-index`로 설치하고, `pip check`를 실행하고 `polyspec.orm`을 import한다. lock은 kit가 고정한 uv 0.12.11이 복사한 pyproject.toml로 쓴다: `uv pip compile pyproject.toml --universal --python-version 3.14 --generate-hashes --format pylock.toml -o pylock.toml --no-cache`. `--python-version`이 필요하다: 없으면 uv는 universal resolution의 하한을 `requires-python`이 아니라 찾은 interpreter에서 정한다. 반복 가능한 `make python-lock`과 그 offline 검사는 kit 0.0.26(K54)과 함께 온다. wheel은 Python 3.14와 CPython만 지원한다: `requires-python`은 `>=3.14`이며, CI가 test하는 `.python-version`의 minor release이고 그보다 오래된 release는 아니다. 의존성 `polyspec-ordered-json==0.0.8`이 3.14를 요구하기 때문이다. `packages/orm-python/tests/test_requires_python.py`가 둘을 비교한다. orm의 toolchain은 python-build-standalone의 CPython이며, package는 classifier `Programming Language :: Python :: Implementation :: CPython`을 선언한다. 그래서 `psycopg-binary==3.3.6` 의존성은 다른 구현을 위한 marker 없이 psycopg의 binary build를 직접 이름 붙인다.

psycopg의 binary extra는 그것이 펼쳐지는 두 plain requirement `psycopg==3.3.6`과 `psycopg-binary==3.3.6`으로 적는다. 그 extra는 PyPy를 제외하는데 plain requirement로는 그것을 나타낼 수 없으므로, PyPy에서도 `psycopg-binary`를 요구한다.

## 개발 배치

release하는 manifest는 packages/orm-npm/package.json, packages/orm-php/composer.json, packages/orm-php-extension/composer.json이다. 그것들은 다른 저장소의 polyspec package를 정확한 version으로 받고 repository를 선언하지 않는다. release하지 않는 두 private root manifest가 이 저장소에서 그 version을 푼다:

- 저장소 root의 package.json은 `workspaces`에 `packages/*`를 두고, 그 `overrides`는 `@polyspec/ordered-json`을 GitHub Release의 tarball URL(release tag를 적는다)에서 받고, vitepress의 최신 release가 advisory가 있는 `vite` 5에 의존하므로 `vite` 7을 받는다. root의 `npm ci`가 workspace를 설치하고. root의 package-lock.json이 유일한 npm lockfile이다.
- 저장소 root의 composer.json은 packages/orm-php를 `path` repository에서, polyspec/ordered-json을 `dist`가 GitHub Release의 zip URL과 그 shasum인 `package` repository에서 설치한다. URL이 release tag를 적는다. 그 `vendor-dir`은 vendor-php다. root의 vendor는 Go module의 vendor directory이기 때문이다. `config.platform.php`는 client의 가장 낮은 PHP인 `8.4.0`이다. root의 composer.lock이 유일한 Composer lockfile이고, PHP test는 vendor-php/autoload.php를 load한다.
