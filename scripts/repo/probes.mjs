// 연결 probe 검사. client는 schema와 type을 manifest에서 읽고, 연결할 때 server에 무엇을 묻는
// statement를 보내지 않는다. SQLite version은 각 driver가 link한 library에서 읽고(Go
// `RegisterSQLiteVersion`, PHP `PDO::ATTR_SERVER_VERSION`, TypeScript `process.versions.sqlite`, Rust
// `libsqlite3_sys::SQLITE_VERSION`), TypeScript의 연결 확인은 statement 없이 연결 하나를 연다.

// runtimeSource는 client runtime의 source file이다. test와 dbspec introspection, 생성 code는 뺀다.
export const runtimeSource = path =>
  (/^clients\/go\/orm\/(?:[^/]+|sqlite\/[^/]+|pg\/[^/]+)\.go$/.test(path) && !path.endsWith('_test.go')) ||
  /^clients\/php\/src\/[^/]+\.php$/.test(path) ||
  /^clients\/typescript\/src\/[^/]+\.ts$/.test(path) ||
  (/^clients\/rust\/orm\/src\/[^/]+\.rs$/.test(path) && !path.endsWith('_tests.rs'));

// connectProbeErrors는 files({path: text})의 runtime source가 연결 probe statement를 적는 줄마다 오류
// 하나를 돌려준다: SQL `sqlite_version()`과 TypeScript의 `'SELECT 1'`. 주석 줄은 제외한다.
export function connectProbeErrors(files) {
  const errors = [];
  for (const [path, text] of Object.entries(files)) {
    if (!runtimeSource(path)) continue;
    text.split('\n').forEach((line, index) => {
      if (/^\s*(\/\/|#|\*|\/\*)/.test(line)) return;
      if (/sqlite_version\(\)/i.test(line)) errors.push(`${path}:${index + 1} asks the server for the SQLite version; read the library version from the driver`);
      else if (path.startsWith('clients/typescript/src/') && /['"`]SELECT 1['"`]/.test(line)) errors.push(`${path}:${index + 1} sends SELECT 1 to check the connection; open a connection without a statement`);
    });
  }
  return errors;
}
