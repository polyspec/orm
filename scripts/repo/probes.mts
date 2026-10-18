// Connection probe check. The client reads the schema and types from the manifest and, on connecting, sends the server no
// statement asking anything. The SQLite version is read from the library each driver links (Go
// `RegisterSQLiteVersion`, PHP `PDO::ATTR_SERVER_VERSION`, TypeScript `process.versions.sqlite`, Rust
// `libsqlite3_sys::SQLITE_VERSION`), and TypeScript's connection check opens one connection without a statement.

// runtimeSource is the source file of the client runtime. Tests, dbspec introspection and generated code are excluded.
export const runtimeSource = (path: string) =>
  (/^packages\/go\/orm\/(?:[^/]+|sqlite\/[^/]+|pg\/[^/]+)\.go$/.test(path) && !path.endsWith('_test.go')) ||
  /^packages\/php\/src\/[^/]+\.php$/.test(path) ||
  /^packages\/ts\/src\/[^/]+\.ts$/.test(path) ||
  (/^packages\/rust\/orm\/src\/[^/]+\.rs$/.test(path) && !path.endsWith('_tests.rs'));

// connectProbeErrors returns one error for each line of the runtime source in files ({path: text}) that writes a connection probe statement:
// SQL `sqlite_version()` and TypeScript's `'SELECT 1'`. Comment lines are excluded.
export function connectProbeErrors(files: Record<string, string>) {
  const errors: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (!runtimeSource(path)) continue;
    text.split('\n').forEach((line: string, index) => {
      if (/^\s*(\/\/|#|\*|\/\*)/.test(line)) return;
      if (/sqlite_version\(\)/i.test(line)) errors.push(`${path}:${index + 1} asks the server for the SQLite version; read the library version from the driver`);
      else if (path.startsWith('packages/ts/src/') && /['"`]SELECT 1['"`]/.test(line)) errors.push(`${path}:${index + 1} sends SELECT 1 to check the connection; open a connection without a statement`);
    });
  }
  return errors;
}
