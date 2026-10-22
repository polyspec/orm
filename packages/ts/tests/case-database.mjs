// The database that one case uses. The name is orm_case_<pid>_<counter>, and on MySQL and PostgreSQL
// it creates the database on that server, using ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN only as admin connections.
// Nothing is created in the database of the admin connection. SQLite uses a file in the OS temp directory,
// orm-case-<pid>-<counter>.sqlite. The case drops that database when it ends, and also after a failure.
// PostgreSQL also takes a database rather than a schema: schema().empty() counts the non-public schemas
// by their content, so an empty database cannot be verified with a schema inside a shared database.
import { rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(new URL('../package.json', import.meta.url));
let counter = 0;

/** The case name orm_case_<pid>_<counter> not yet used in this process. */
export function caseName() {
  counter++;
  return `orm_case_${process.pid}_${counter}`;
}

/** The DSN with the path (database name) of dsn replaced by name. The query is kept as is. */
export function relatedDsn(dsn, name) {
  const url = new URL(dsn);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * A mysql2 connection opened with the user, password, socket, host, and port of the DSN. Without a database, the DSN's
 * database is opened, and null opens it without a database. Passing undefined uses the default, so
 * a connection with no database is requested as null, not undefined.
 */
export function mysqlConnection(dsn, database = new URL(dsn).pathname.slice(1)) {
  const url = new URL(dsn);
  return require('mysql2/promise').createConnection({
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    socketPath: url.searchParams.get('socket') ?? undefined, host: url.hostname,
    port: url.port ? Number(url.port) : undefined, database: database ?? undefined,
  });
}

/** A pg client built from the host, port, database, user, and password of the DSN. The caller opens the connection. */
export function postgresClient(dsn) {
  const url = new URL(dsn);
  const { Client } = require('pg');
  return new Client({
    host: url.searchParams.get('host') ?? url.hostname, port: url.port ? Number(url.port) : undefined,
    database: url.pathname.slice(1), user: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  });
}

const adminEnv = { mysql: 'ORM_TEST_MYSQL_DSN', postgres: 'ORM_TEST_POSTGRES_DSN' };

/** Runs one statement with the admin DSN. The MySQL connection opens without a database. */
async function admin(dialect, statement) {
  const dsn = process.env[adminEnv[dialect]];
  if (!dsn) throw new Error(`${adminEnv[dialect]} is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers`);
  if (dialect === 'mysql') {
    const conn = await mysqlConnection(dsn, null);
    try { await conn.query(statement); } finally { await conn.end(); }
    return dsn;
  }
  const client = postgresClient(dsn);
  await client.connect();
  try { await client.query(statement); } finally { await client.end(); }
  return dsn;
}

/**
 * Creates a new case database for the dialect and returns { dialect, name, dsn, path, drop(report) }. step(text)
 * prints a STEP line for the running case. drop(report) removes the database (for SQLite, the file and its -wal, -shm, -journal)
 * and prints that step to report (by default, the step of the case that created it). On failure, it throws an
 * error that includes the database name. When another case drops it, that case's step is passed.
 */
export async function createCaseDatabase(dialect, step) {
  const name = caseName();
  if (dialect === 'sqlite') {
    const path = join(tmpdir(), name.replaceAll('_', '-') + '.sqlite');
    await writeFile(path, '', { flag: 'wx' });
    step(`database file ${path} created`);
    return {
      dialect, name, path, dsn: `sqlite://${path}`,
      async drop(report = step) {
        try {
          for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(path + suffix, { force: true });
        } catch (error) { throw new Error(`remove database file ${path}: ${error.message}`, { cause: error }); }
        report(`database file ${path} removed`);
      },
    };
  }
  if (!(dialect in adminEnv)) throw new Error(`unknown dialect ${dialect}`);
  const base = await admin(dialect, dialect === 'mysql' ? `CREATE DATABASE \`${name}\`` : `CREATE DATABASE "${name}"`);
  step(`database ${name} created`);
  return {
    dialect, name, path: null, dsn: relatedDsn(base, name),
    async drop(report = step) {
      try {
        await admin(dialect, dialect === 'mysql' ? `DROP DATABASE \`${name}\`` : `DROP DATABASE "${name}" WITH (FORCE)`);
      } catch (error) { throw new Error(`drop database ${name}: ${error.message}`, { cause: error }); }
      report(`database ${name} dropped`);
    },
  };
}

/**
 * Runs body(database) on a new case database and drops the database even when body fails. If the drop
 * fails, the case fails. If body and the drop both fail, the error carries both reasons.
 */
export async function withCaseDatabase(dialect, step, body) {
  const database = await createCaseDatabase(dialect, step);
  let failure = null;
  let result;
  try {
    result = await body(database);
  } catch (error) {
    failure = error;
  }
  try { await database.drop(); } catch (error) {
    if (failure === null) throw error;
    failure.message = `${failure.message}; and ${error.message}`;
  }
  if (failure !== null) throw failure;
  return result;
}
