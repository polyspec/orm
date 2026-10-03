// case 하나가 쓰는 자기 database. 이름은 orm_case_<pid>_<counter>이고, MySQL과 PostgreSQL에서는
// ORM_TEST_MYSQL_DSN, ORM_TEST_POSTGRES_DSN을 admin 연결로만 써서 그 server에 database를 만든다.
// admin 연결의 database에는 아무것도 만들지 않는다. SQLite는 OS temp directory의
// orm-case-<pid>-<counter>.sqlite file이다. case는 끝날 때, 실패한 뒤에도 그 database를 지운다.
// PostgreSQL도 schema가 아니라 database를 받는다: schema().empty()는 public이 아닌 schema를
// 내용으로 세므로 공유 database 안의 schema로는 빈 database를 확인할 수 없다.
import { rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(new URL('../package.json', import.meta.url));
let counter = 0;

/** 이 process에서 아직 쓰지 않은 case 이름 orm_case_<pid>_<counter>다. */
export function caseName() {
  counter++;
  return `orm_case_${process.pid}_${counter}`;
}

/** dsn의 path(database 이름)를 name으로 바꾼 DSN이다. query는 그대로 둔다. */
export function relatedDsn(dsn, name) {
  const url = new URL(dsn);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * DSN의 user, password, socket, host, port로 연 mysql2 연결이다. database를 주지 않으면 DSN의
 * database를 열고, null이면 database 없이 연다. undefined를 넘기면 기본값이 쓰이므로 database
 * 없는 연결은 undefined가 아니라 null로 요청한다.
 */
export function mysqlConnection(dsn, database = new URL(dsn).pathname.slice(1)) {
  const url = new URL(dsn);
  return require('mysql2/promise').createConnection({
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    socketPath: url.searchParams.get('socket') ?? undefined, host: url.hostname,
    port: url.port ? Number(url.port) : undefined, database: database ?? undefined,
  });
}

/** DSN의 host, port, database, user, password로 만든 pg client다. 연결은 호출자가 연다. */
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

/** admin DSN으로 statement 하나를 실행한다. MySQL 연결은 database 없이 연다. */
async function admin(dialect, statement) {
  const dsn = process.env[adminEnv[dialect]];
  if (!dsn) throw new Error(`${adminEnv[dialect]} is required; database tests never skip`);
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
 * dialect의 새 case database를 만들고 { dialect, name, dsn, path, drop(report) }을 돌려준다. step(text)은
 * 실행 중인 case의 STEP 줄을 출력한다. drop(report)은 database(SQLite는 file과 -wal, -shm, -journal)를
 * 지우고 그 단계를 report(생략하면 만든 case의 step)로 출력하며, 실패하면 database 이름을 담은
 * error를 던진다. 다른 case가 지울 때는 그 case의 step을 넘긴다.
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
        } catch (error) { throw new Error(`remove database file ${path}: ${error.message}`); }
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
      } catch (error) { throw new Error(`drop database ${name}: ${error.message}`); }
      report(`database ${name} dropped`);
    },
  };
}

/**
 * 새 case database로 body(database)를 실행하고, body가 실패해도 database를 지운다. 지우기가
 * 실패하면 case가 실패한다. body와 지우기가 함께 실패하면 두 이유를 모두 담는다.
 */
export async function withCaseDatabase(dialect, step, body) {
  const database = await createCaseDatabase(dialect, step);
  let failure = null;
  try {
    return await body(database);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await database.drop(); } catch (error) {
      if (failure === null) throw error;
      failure.message = `${failure.message}; and ${error.message}`;
    }
  }
}
