<!-- doc-id: rebuild-php-sqlite-cancellation -->
<!-- source-sha256: 0a7b970f5ca615c6eae1a6cc27249a5e9cba6e303020679c5b3dfc1fdd7f423f -->
# PHP SQLite 취소

`Pdo\Sqlite::loadExtension()`은 PDO connection에
`sqlite3_progress_handler()`를 설치하는 작은 SQLite loadable extension을 불러온다.
PDO에는 progress handler나 interrupt method가 없다. 이 handler는 SQLite가 virtual
machine instruction을 실행하는 동안 1 byte 취소 상태 파일을 읽고, token이 active이며
취소된 경우에만 `SQLITE_INTERRUPT`를 반환한다. PHP는 mode 0600 상태 파일을 만들고,
소유 process가 token을 해제할 때 파일을 지운다. runtime은 공개 PDO API로 extension을
불러오며 request 실행 중 native code를 compile하지 않는다.

Composer archive에는 `bin/orm-sqlite-cancel-build.php`와 C source가 포함된다.
PHP package를 설치한 뒤 consumer는 `vendor/bin/orm-sqlite-cancel-build.php`를 명시적으로
실행해 helper를 build한다. `make php-cancel-helper-build`는 checkout에서 같은 builder를
실행한다. 명령은 해당 platform SQLite build에 쓰인 platform C compiler,
`pkg-config`, SQLite development header를 사용한다. helper는 설치 package 안의
`src/native/bin/<os>-<architecture>/orm_cancel`에 platform suffix로 원자 게시된다.
PHP는 `Composer\InstalledVersions`로 설치 package 경로를 찾아 완성된 artifact를
불러온다. builder는 destination 옆에서 compile하고 private file mode를 설정한 뒤
rename하며, helper는 package를 제거하거나 다시 build할 때까지 설치 상태를 유지한다.
Composer package를 설치하거나 업그레이드하면 build command를 다시 실행해야 한다.
PHP unit case는 실행 중인 statement 안에서 collation callback이 취소 source를 호출하는
recursive SQLite query를 실행하고, `CANCELED`, transaction rollback, root PDO connection
재사용을 확인한다. MySQL과 PostgreSQL은 protocol control connection으로 active server
connection을 종료하고 root handle을 다시 연결한다.

PHP와 driver 조사에서 SQLite PDO virtual machine에 progress callback을 등록하거나
interrupt할 공개 PDO operation을 찾지 못했다. SQLite가 실행 중인 statement를 멈추지
않으므로 PHP callback에서 예외를 던지는 것만으로는 취소할 수 없다. 따라서 PDO 내부
구조에 접근하지 않고 공개 SQLite loadable-extension API를 통합 지점으로 선택했다.
