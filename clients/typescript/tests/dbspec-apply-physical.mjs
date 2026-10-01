// dbspec plan apply on MySQL, PostgreSQL and SQLite (docs/plans.md "Apply"):
// the chain of create-from-empty and rename-table-and-column of
// tests/dbspec/plans.json with its history and a second apply, drift, the
// lock of a second session, rollback after a stop, an unlock that released
// nothing on PostgreSQL, a verify failure and the MySQL recovery after a
// stop before and after a statement, through the TypeScript client's
// applyPlans and recoverPlans. Each run uses an empty database, schema or
// file named after the language, the pid and the run.
//
// Usage: ORM_TEST_MYSQL_DSN=... ORM_TEST_POSTGRES_DSN=... node --test clients/typescript/tests/dbspec-apply-physical.mjs (after the build)
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { DbspecApplyError, applyPlans, dbspecManifest, introspectDbspec, parsePlan, recoverPlans } from '../dist/dbspec/index.js';

const root = new URL('../../../', import.meta.url);
const TIMEOUT = 60000;
// 모든 client가 새 connection에서 실행하는 문장이다(tests/dialects connectionRules).
const CONNECTION_RULES = {
  mysql: ["SET time_zone = '+00:00'"],
  postgres: ["SET TimeZone = 'UTC'"],
  sqlite: ['PRAGMA foreign_keys = ON'],
};

const mysqlDSN = process.env.ORM_TEST_MYSQL_DSN;
const postgresDSN = process.env.ORM_TEST_POSTGRES_DSN;
if (!mysqlDSN || !postgresDSN) throw new Error('ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV');

const fixedNow = () => new Date(Date.UTC(2026, 9, 1, 0, 0, 0));

// plans는 plans.json의 create-from-empty와 그 target에서 시작하는 rename-table-and-column이다.
const plans = JSON.parse(readFileSync(new URL('tests/dbspec/plans.json', root), 'utf8'))
  .cases.filter(c => c.id === 'create-from-empty' || c.id === 'rename-table-and-column')
  .map(c => {
    const parsed = parsePlan(c.plan.join('\n') + '\n');
    assert.deepEqual(parsed.diagnostics, [], `${c.id} diagnostics`);
    return parsed.plan;
  });
assert(plans.length === 2 && plans[1].from === plans[0].to, 'plans.json does not chain create-from-empty and rename-table-and-column');
const target = dbspecManifest([plans[1].schema]).manifest.schemaText;

// vector runs one case with its own deadline and reports its start, result
// and elapsed time.
function vector(name, body) {
  test(name, { timeout: TIMEOUT }, async () => {
    const started = performance.now();
    console.log(`start ${name}`);
    try {
      await body();
    } catch (error) {
      console.log(`result ${name}: FAIL after ${(performance.now() - started).toFixed(1)} ms`);
      throw error;
    }
    console.log(`result ${name}: PASS after ${(performance.now() - started).toFixed(1)} ms`);
  });
}

function mysqlOptions(database) {
  const url = new URL(mysqlDSN);
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    socketPath: url.searchParams.get('socket') ?? undefined,
    host: url.hostname || undefined,
    port: url.port ? Number(url.port) : undefined,
    database,
  };
}

const run = `ts${process.pid}`;
const sqliteDirectory = mkdtempSync(join(tmpdir(), `dbspec-apply-${run}-`));
process.on('exit', () => rmSync(sqliteDirectory, { recursive: true, force: true }));
let probes = 0;

// session은 statement를 실행하고 query의 첫 값을 text로 읽는 connection이다.
function mysqlSession(connection) {
  return {
    connection,
    exec: sql => connection.query(sql),
    rows: async sql => (await connection.query({ sql, rowsAsArray: true }))[0],
    close: () => connection.end(),
  };
}

function postgresSession(client) {
  return {
    connection: client,
    exec: sql => client.query(sql),
    rows: async sql => (await client.query({ text: sql, rowMode: 'array' })).rows,
    close: () => client.end(),
  };
}

function sqliteSession(db) {
  return {
    connection: db,
    exec: async sql => db.exec(sql),
    rows: async sql => {
      const statement = db.prepare(sql);
      statement.setReturnArrays(true);
      return statement.all();
    },
    close: async () => db.close(),
  };
}

// withDatabase creates an empty database, schema or file named after the
// language, the pid and the run, gives body a session on it and a function
// that opens another session on the same database, and drops the database
// and checks that nothing remains.
async function withDatabase(dialect, body) {
  const name = `apply_${run}_${String(probes++).padStart(3, '0')}`;
  switch (dialect) {
    case 'mysql': {
      const admin = await mysql.createConnection(mysqlOptions(undefined));
      try {
        await admin.query(`CREATE DATABASE \`${name}\``);
        try {
          const open = async () => mysqlSession(await mysql.createConnection(mysqlOptions(name)));
          const session = await open();
          try {
            await body(session, open);
          } finally {
            await session.close();
          }
        } finally {
          await admin.query(`DROP DATABASE \`${name}\``);
          const [rows] = await admin.query('SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [name]);
          assert.equal(Number(rows[0].n), 0, `database ${name} remains after cleanup`);
        }
      } finally {
        await admin.end();
      }
      return;
    }
    case 'postgres': {
      const admin = new pg.Client({ connectionString: postgresDSN });
      await admin.connect();
      try {
        await admin.query(`CREATE SCHEMA "${name}"`);
        try {
          const open = async () => {
            const client = new pg.Client({ connectionString: postgresDSN });
            await client.connect();
            await client.query('SET client_min_messages = warning');
            await client.query(`SET search_path TO "${name}"`);
            return postgresSession(client);
          };
          const session = await open();
          try {
            await body(session, open);
          } finally {
            await session.close();
          }
        } finally {
          await admin.query(`DROP SCHEMA "${name}" CASCADE`);
          const { rows } = await admin.query('SELECT COUNT(*)::int AS n FROM pg_namespace WHERE nspname = $1', [name]);
          assert.equal(rows[0].n, 0, `schema ${name} remains after cleanup`);
        }
      } finally {
        await admin.end();
      }
      return;
    }
    case 'sqlite': {
      const path = join(sqliteDirectory, `${name}.sqlite`);
      assert(!existsSync(path), `SQLite file ${path} already exists`);
      const session = sqliteSession(new DatabaseSync(path));
      try {
        await body(session, async () => sqliteSession(new DatabaseSync(path)));
      } finally {
        await session.close();
        for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(path + suffix, { force: true });
        assert(!existsSync(path), `${path} remains after cleanup`);
      }
      return;
    }
  }
  throw new Error(`unknown dialect ${dialect}`);
}

// firstValue gives the first column of the first row as text.
async function firstValue(session, sql) {
  const rows = await session.rows(sql);
  assert(rows.length > 0, `${sql}: no row`);
  return String(rows[0][0]);
}

// schemaIs requires the introspected schema text to be want ('' for an empty database).
async function schemaIs(session, dialect, want) {
  const { document, unsupported } = await introspectDbspec(session.connection, dialect, 'x');
  assert.deepEqual(unsupported, [], 'unsupported objects');
  const got = document.tables.length > 0 ? dbspecManifest([document]).manifest.schemaText : '';
  assert.equal(got, want, 'introspected schema text');
}

// applyCode gives the code of an apply error; any other rejection fails.
async function applyCode(promise) {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof DbspecApplyError, `not an apply error: ${error}`);
    return error.code;
  }
  return 'none';
}

const historyTable = dialect => (dialect === 'mysql' ? '`dbspec$plans`' : '"dbspec$plans"');

const scenarios = [
  ['chain_history_and_again', ['mysql', 'postgres', 'sqlite'], async (session, dialect) => {
    let events = [];
    const record = event => {
      events.push(event.kind);
    };
    await applyPlans(session.connection, dialect, plans, fixedNow, record);
    await schemaIs(session, dialect, target);
    assert.equal(await firstValue(session, `SELECT COUNT(*) FROM ${historyTable(dialect)} WHERE state = 'done'`), '2');
    const counts = {};
    for (const kind of events) counts[kind] = (counts[kind] ?? 0) + 1;
    assert.equal(counts.plan, 2, 'plan events');
    assert.equal(counts.verified, 2, 'verified events');
    assert.equal(counts.done, 2, 'done events');
    assert(counts.statement > 0 && counts.statement === counts.applied, `statement and applied events ${JSON.stringify(counts)}`);
    events = [];
    await applyPlans(session.connection, dialect, plans, fixedNow, record);
    assert.deepEqual(events, [], 'events of a second apply');
  }],
  ['drift', ['mysql', 'postgres', 'sqlite'], async (session, dialect) => {
    await applyPlans(session.connection, dialect, plans.slice(0, 1), fixedNow, null);
    await session.exec('CREATE TABLE extra (id integer PRIMARY KEY)');
    assert.equal(await applyCode(applyPlans(session.connection, dialect, plans, fixedNow, null)), 'drift');
  }],
  ['lock', ['mysql', 'postgres', 'sqlite'], async (session, dialect, open) => {
    const other = await open();
    try {
      const hold = { mysql: "SELECT GET_LOCK('dbspec$plans', 0)", postgres: "SELECT pg_advisory_lock(hashtext('dbspec$plans'))", sqlite: 'BEGIN IMMEDIATE' }[dialect];
      await other.exec(hold);
      assert.equal(await applyCode(applyPlans(session.connection, dialect, plans, fixedNow, null)), 'locked');
      if (dialect === 'sqlite') await other.exec('ROLLBACK');
    } finally {
      await other.close();
    }
  }],
  ['rollback_on_failure', ['postgres', 'sqlite'], async (session, dialect) => {
    const stop = new Error('stop');
    const fail = event => {
      if (event.kind === 'applied' && event.step === 1) throw stop;
    };
    await assert.rejects(applyPlans(session.connection, dialect, plans, fixedNow, fail), error => error === stop);
    await schemaIs(session, dialect, '');
    await applyPlans(session.connection, dialect, plans, fixedNow, null);
    await schemaIs(session, dialect, target);
  }],
  ['unlock_not_held', ['postgres'], async (session, dialect) => {
    // event에서 advisory lock을 먼저 풀면 apply 끝의 unlock은 아무것도 풀지 않는다.
    const release = async event => {
      if (event.kind === 'plan' && event.plan === plans[0].name) await session.exec("SELECT pg_advisory_unlock(hashtext('dbspec$plans'))");
    };
    await assert.rejects(applyPlans(session.connection, dialect, plans, fixedNow, release), {
      message: 'the advisory lock of dbspec$plans was not held at unlock',
    });
  }],
  ['verify_failure', ['mysql', 'postgres', 'sqlite'], async (session, dialect) => {
    // 마지막 statement 뒤에 plan 밖의 table을 만들면 검증이 실패한다.
    const sneak = async event => {
      if (event.kind === 'applied' && event.plan === plans[0].name && event.step === event.steps - 1) {
        await session.exec('CREATE TABLE sneak (id integer PRIMARY KEY)');
      }
    };
    assert.equal(await applyCode(applyPlans(session.connection, dialect, plans, fixedNow, sneak)), 'verify');
    if (dialect === 'mysql') assert.equal(await firstValue(session, 'SELECT state FROM `dbspec$plans`'), 'running');
    else await schemaIs(session, dialect, '');
  }],
];
// MySQL recovery: statement이 commit된 뒤 기록 전에 멈춘 경우와 실행 전에 멈춘 경우.
for (const kind of ['applied', 'statement']) {
  scenarios.push([`recover_after_${kind}`, ['mysql'], async (session, dialect) => {
    const stop = new Error('stop');
    const fail = event => {
      if (event.kind === kind && event.plan === plans[1].name && event.step === 1) throw stop;
    };
    await assert.rejects(applyPlans(session.connection, dialect, plans, fixedNow, fail), error => error === stop);
    assert.equal(await firstValue(session, `SELECT CONCAT(state, ' ', step) FROM \`dbspec$plans\` WHERE name = '${plans[1].name}'`), 'running 1');
    assert.equal(await applyCode(applyPlans(session.connection, dialect, plans, fixedNow, null)), 'interrupted');
    await recoverPlans(session.connection, dialect, plans, fixedNow, null);
    await schemaIs(session, dialect, target);
    assert.equal(await firstValue(session, "SELECT COUNT(*) FROM `dbspec$plans` WHERE state = 'done'"), '2');
    await recoverPlans(session.connection, dialect, plans, fixedNow, null);
  }]);
}

let runs = 0;
let expected = 0;
for (const [name, dialects, body] of scenarios) {
  for (const dialect of dialects) {
    expected++;
    vector(`${dialect}.apply.${name}`, async () => {
      await withDatabase(dialect, async (session, open) => {
        for (const sql of CONNECTION_RULES[dialect]) await session.exec(sql);
        await body(session, dialect, open);
      });
      runs++;
    });
  }
}

vector('every apply scenario runs on its dialects', () => {
  assert.equal(runs, expected);
  assert.equal(runs, 17);
  console.log(`apply runs: ${runs}`);
});
