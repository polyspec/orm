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

0.1까지 npm과 Composer package는 registry에 없다. GitHub Release마다 `polyspec-orm-<version>.tgz`, `polyspec-orm-<version>.zip`, `polyspec-orm-dbspec-<version>.zip`이 있다. packed manifest는 다른 polyspec package를 모두 그 release의 정확한 version으로 선언하므로, project는 필요한 release asset을 내려받아 함께 설치한다. `make package-check`는 현재 commit의 asset을 저장소 밖의 directory에서 이렇게 설치한다.

- npm: orm tarball과 그것이 의존하는 polyspec package의 tarball(packed `package.json`이 적은 version의 ordered-json release에 있는 `@polyspec/ordered-json`)을 모두 `file:` dependency로 나열한다:

  ```json
  {
    "dependencies": {
      "@polyspec/orm": "file:vendor/polyspec-orm-<version>.tgz",
      "@polyspec/ordered-json": "file:vendor/polyspec-ordered-json-0.0.2.tgz"
    }
  }
  ```

- Composer: `artifact` repository는 내려받은 zip의 directory다. Composer는 zip마다 그 `composer.json`에서 이름, version, 요구 사항을 읽는다. `composer.json`에 `version`이 없는 zip(ordered-json 0.0.2)은 대신 `package` repository 항목으로 준다: 그 `composer.json`에 `version`과 zip의 `dist`를 더한 것이며, Composer는 package 항목을 zip의 file 대신 읽기 때문이다.

  ```json
  {
    "require": { "polyspec/orm": "<version>" },
    "repositories": [
      { "type": "artifact", "url": "vendor/polyspec" },
      { "type": "package", "package": {
        "name": "polyspec/ordered-json", "version": "0.0.2", "type": "library",
        "require": { "php": ">=8.2", "ext-json": "*", "ext-pcre": "*" },
        "autoload": { "files": ["src/OrderedJson.php"] },
        "dist": { "type": "zip", "url": "vendor/polyspec-ordered-json-0.0.2.zip" }
      } }
    ]
  }
  ```

  `polyspec/orm-dbspec`는 type `php-ext`다: PIE가 build하고 설치하며, Composer는 설치하지 않는다.
