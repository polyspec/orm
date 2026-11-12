// mysqlTestOptions adapts a test MySQL DSN to the connection options shared by the dbspec physical fixtures.
export function mysqlTestOptions(dsn, database) {
  const url = new URL(dsn);
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    socketPath: url.searchParams.get('socket') ?? undefined,
    host: url.hostname || undefined,
    port: url.port ? Number(url.port) : undefined,
    database,
  };
}
