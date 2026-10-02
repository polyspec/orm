// dbspec plan apply on MySQL, PostgreSQL and SQLite (docs/plans.md "Apply"):
// the chain of create-from-empty and rename-table-and-column of
// tests/dbspec/plans.json with its history and a second apply, drift, the
// lock of a second session, an apply to a second database, schema or file
// while the first holds its lock, the empty chain, an unlock that released
// nothing on PostgreSQL, a verify failure, for every step of the
// representative case a stop after its statement followed by rollback, a
// stop followed by recover and a stopped rollback that continues, rows
// written between apply, rollback and a second apply, the null check of a
// dropped required column and finalize, through the TypeScript client's
// applyPlans, recoverPlans, rollbackPlans and finalizePlans. Each run uses an empty database, schema or
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
import { DbspecApplyError, applyPlans, dbspecManifest, finalizePlans, introspectDbspec, parsePlan, planSteps, recoverPlans, rollbackPlans } from '../dist/dbspec/index.js';

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

// tool clock: 2026-10-01T00:00:00.123456789Z를 microsecond로 자른 값(epoch 이후 microsecond)이다.
const fixedNow = () => Date.UTC(2026, 9, 1, 0, 0, 0) * 1000 + 123456;

const cases = new Map(JSON.parse(readFileSync(new URL('tests/dbspec/plans.json', root), 'utf8')).cases.map(c => [c.id, c]));
function parse(id, text) {
  const parsed = parsePlan(text);
  assert.deepEqual(parsed.diagnostics, [], `${id} diagnostics`);
  return parsed.plan;
}
// plans는 plans.json의 create-from-empty와 그 target에서 시작하는 rename-table-and-column이다.
const plans = ['create-from-empty', 'rename-table-and-column'].map(id => parse(id, cases.get(id).plan.join('\n') + '\n'));
assert(plans[1].from === plans[0].to, 'plans.json does not chain create-from-empty and rename-table-and-column');
// caseChain은 case의 source를 만드는 첫 plan base와 case의 plan으로 된 chain이다.
function caseChain(id) {
  const c = cases.get(id);
  const base = parse(id, `dbplan 1 base\nfrom empty\n\n${c.source.join('\n')}\n`);
  const plan = parse(id, c.plan.join('\n') + '\n');
  assert.equal(plan.from, base.to, `the source of ${id} does not start its plan`);
  return [base, plan];
}
const schemaText = plan => dbspecManifest([plan.schema]).manifest.schemaText;
// counts는 dialect마다 chain plan의 [step 수, finalize 앞 step 수]다.
function counts(chain) {
  const out = {};
  for (const dialect of ['mysql', 'postgres', 'sqlite']) {
    out[dialect] = chain.map((p, i) => {
      const steps = planSteps(i > 0 ? chain[i - 1].schema : null, p, dialect).steps;
      const end = steps.findIndex(s => s.finalize);
      return [steps.length, end < 0 ? steps.length : end];
    });
  }
  return out;
}
const target = schemaText(plans[1]);
const planCounts = counts(plans);
const representative = caseChain('representative');
const repSource = schemaText(representative[0]);
const repTarget = schemaText(representative[1]);
const repCounts = counts(representative);
const required = caseChain('drop-required-column');
const requiredTarget = schemaText(required[1]);
const requiredCounts = counts(required);

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
// docs/plans.md "Apply"의 lock 이름과 key다.
const MYSQL_APPLY_LOCK = "CONCAT('dbspec$plans$', LEFT(SHA2(DATABASE(), 256), 51))";
const POSTGRES_APPLY_LOCK = "hashtext('dbspec$plans'), hashtext(current_schema())";
// 이름이 dbspec$로 시작하는 table과 column 중 history table이 아닌 것의 수다.
const HIDDEN_LEFT = {
  mysql: "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE 'dbspec$%' OR COLUMN_NAME LIKE 'dbspec$%') AND TABLE_NAME <> 'dbspec$plans'",
  postgres:
    "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND (c.relname LIKE 'dbspec$%' OR a.attname LIKE 'dbspec$%') AND c.relname <> 'dbspec$plans'",
  sqlite: "SELECT COUNT(*) FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND (m.name LIKE 'dbspec$%' OR p.name LIKE 'dbspec$%') AND m.name <> 'dbspec$plans'",
};

// rowsAre는 query의 모든 row를 a|b로, row를 쉼표로 이어 want와 비교한다.
async function rowsAre(session, sql, want) {
  const rows = await session.rows(sql);
  assert.equal(rows.map(r => r.map(v => (v === null ? 'NULL' : String(v))).join('|')).join(','), want, sql);
}
const historyIs = (session, dialect, want) => rowsAre(session, `SELECT name, state, step FROM ${historyTable(dialect)} ORDER BY name`, want);
// stopAfter는 plan의 step 번째 statement를 실행한 뒤, step을 기록하기 전에 명령을 멈추는 event handler다.
const stopAfter = (plan, step, stop) => event => {
  if (event.kind === 'applied' && event.plan === plan && event.step === step) throw stop;
};
async function stopped(promise, stop) {
  await assert.rejects(promise, error => error === stop);
}

const ALL = ['mysql', 'postgres', 'sqlite'];
const scenarios = [
  ['chain_history_and_again', ALL, async (session, dialect) => {
    let events = [];
    const record = event => {
      events.push(event.kind);
    };
    await applyPlans(session.connection, dialect, plans, fixedNow, record);
    await schemaIs(session, dialect, target);
    const c = planCounts[dialect];
    await historyIs(session, dialect, `create_from_empty|applied|${c[0][1]},rename_table_and_column|applied|${c[1][1]}`);
    // applied_at은 tool clock의 UTC 시각을 소수 여섯 자리로 자른 text다.
    assert.equal(await firstValue(session, `SELECT COUNT(*) FROM ${historyTable(dialect)} WHERE applied_at = '2026-10-01T00:00:00.123456Z'`), '2');
    const kinds = {};
    for (const kind of events) kinds[kind] = (kinds[kind] ?? 0) + 1;
    assert.equal(kinds.plan, 2, 'plan events');
    assert.equal(kinds.verified, 2, 'verified events');
    assert.equal(kinds.done, 2, 'done events');
    assert(kinds.statement === c[0][1] + c[1][1] && kinds.statement === kinds.applied, `statement and applied events ${JSON.stringify(kinds)}`);
    events = [];
    await applyPlans(session.connection, dialect, plans, fixedNow, record);
    assert.deepEqual(events, [], 'events of a second apply');
  }],
  ['drift', ALL, async (session, dialect) => {
    await applyPlans(session.connection, dialect, plans.slice(0, 1), fixedNow, null);
    await session.exec('CREATE TABLE extra (id integer PRIMARY KEY)');
    assert.equal(await applyCode(applyPlans(session.connection, dialect, plans, fixedNow, null)), 'drift');
  }],
  ['lock', ALL, async (session, dialect, open) => {
    const other = await open();
    try {
      const hold = { mysql: `SELECT GET_LOCK(${MYSQL_APPLY_LOCK}, 0)`, postgres: `SELECT pg_advisory_lock(${POSTGRES_APPLY_LOCK})`, sqlite: 'BEGIN IMMEDIATE' }[dialect];
      await other.exec(hold);
      assert.equal(await applyCode(applyPlans(session.connection, dialect, plans, fixedNow, null)), 'locked');
      if (dialect === 'sqlite') await other.exec('ROLLBACK');
    } finally {
      await other.close();
    }
  }],
  ['other_database', ALL, async (session, dialect) => {
    // 첫 database의 apply가 lock을 잡은 동안 두 번째 database, schema 또는 file에
    // 같은 chain을 적용한다. lock은 database 하나만 덮으므로 locked가 아니다.
    await withDatabase(dialect, async second => {
      for (const sql of CONNECTION_RULES[dialect]) await second.exec(sql);
      let applied = false;
      const during = async event => {
        if (event.kind === 'plan' && event.plan === plans[0].name && !applied) {
          applied = true;
          await applyPlans(second.connection, dialect, plans, fixedNow, null);
        }
      };
      await applyPlans(session.connection, dialect, plans, fixedNow, during);
      assert(applied, 'the second apply did not run');
      await schemaIs(session, dialect, target);
      await schemaIs(second, dialect, target);
    });
  }],
  ['empty_chain', ALL, async (session, dialect) => {
    // plan이 없는 chain은 table이 없는 database에 아무것도 적용하지 않는다.
    const events = [];
    const record = event => {
      events.push(event.kind);
    };
    await applyPlans(session.connection, dialect, [], fixedNow, record);
    await recoverPlans(session.connection, dialect, [], fixedNow, record);
    await rollbackPlans(session.connection, dialect, [], fixedNow, record);
    await finalizePlans(session.connection, dialect, [], fixedNow, record);
    assert.deepEqual(events, [], 'events of the empty chain');
    await schemaIs(session, dialect, '');
    assert.equal(await firstValue(session, `SELECT COUNT(*) FROM ${historyTable(dialect)}`), '0');
    await session.exec('CREATE TABLE extra (id integer PRIMARY KEY)');
    assert.equal(await applyCode(applyPlans(session.connection, dialect, [], fixedNow, null)), 'drift');
  }],
  ['unlock_not_held', ['postgres'], async (session, dialect) => {
    // event에서 advisory lock을 먼저 풀면 명령 끝의 unlock은 아무것도 풀지 않는다.
    const release = async event => {
      if (event.kind === 'plan' && event.plan === plans[0].name) await session.exec(`SELECT pg_advisory_unlock(${POSTGRES_APPLY_LOCK})`);
    };
    await assert.rejects(applyPlans(session.connection, dialect, plans, fixedNow, release), {
      message: 'the advisory lock of dbspec$plans was not held at unlock',
    });
  }],
  ['verify_failure', ALL, async (session, dialect) => {
    // 마지막 statement 뒤에 plan 밖의 table을 만들면 검증이 실패하고 row는 모든 step을
    // 기록한 채 applying으로 남는다.
    const n = planCounts[dialect][0][1];
    const sneak = async event => {
      if (event.kind === 'applied' && event.plan === plans[0].name && event.step === n - 1) {
        await session.exec('CREATE TABLE sneak (id integer PRIMARY KEY)');
      }
    };
    assert.equal(await applyCode(applyPlans(session.connection, dialect, plans, fixedNow, sneak)), 'verify');
    await historyIs(session, dialect, `${plans[0].name}|applying|${n}`);
  }],
  ['rows_between', ALL, async (session, dialect) => {
    // 적용한 plan에 쓴 row는 rollback 뒤에도 남고 지운 column의 값과 default가 돌아오며,
    // 다시 적용하면 더한 column의 값이 돌아온다. finalize 뒤 rollback은 되돌릴 수 없다.
    const c = repCounts[dialect];
    await applyPlans(session.connection, dialect, representative.slice(0, 1), fixedNow, null);
    await session.exec("INSERT INTO users (mail, legacy_code, age, nick) VALUES ('a@x', 7, 3, 'n1')");
    await applyPlans(session.connection, dialect, representative, fixedNow, null);
    await session.exec("INSERT INTO clients (email, age) VALUES ('b@x', 5)");
    await session.exec("UPDATE clients SET status = 'vip' WHERE email = 'a@x'");
    await rollbackPlans(session.connection, dialect, representative, fixedNow, null);
    await schemaIs(session, dialect, repSource);
    await historyIs(session, dialect, `base|applied|${c[0][1]}`);
    await rowsAre(session, 'SELECT mail, legacy_code, nick FROM users ORDER BY mail', 'a@x|7|n1,b@x|0|x');
    await applyPlans(session.connection, dialect, representative, fixedNow, null);
    await schemaIs(session, dialect, repTarget);
    await rowsAre(session, 'SELECT email, status FROM clients ORDER BY email', 'a@x|vip,b@x|new');
    await historyIs(session, dialect, `base|applied|${c[0][1]},representative|applied|${c[1][1]}`);
    await finalizePlans(session.connection, dialect, representative, fixedNow, null);
    await historyIs(session, dialect, `base|done|${c[0][0]},representative|done|${c[1][0]}`);
    assert.equal(await firstValue(session, HIDDEN_LEFT[dialect]), '0');
    await schemaIs(session, dialect, repTarget);
    assert.equal(await applyCode(rollbackPlans(session.connection, dialect, representative, fixedNow, null)), 'irreversible');
    await schemaIs(session, dialect, repTarget);
  }],
  ['nulls', ALL, async (session, dialect) => {
    // 숨긴 non-null default 없는 column에 그사이 NULL row가 생기면 rollback은 아무것도
    // 바꾸지 않고 row 수를 적은 nulls error로 멈춘다.
    const c = requiredCounts[dialect];
    await applyPlans(session.connection, dialect, required, fixedNow, null);
    await session.exec("INSERT INTO t (a) VALUES ('y')");
    await assert.rejects(rollbackPlans(session.connection, dialect, required, fixedNow, null), error => error instanceof DbspecApplyError && error.code === 'nulls' && error.message.includes('has 1 NULL rows'));
    await schemaIs(session, dialect, requiredTarget);
    await historyIs(session, dialect, `base|applied|${c[0][1]},drop_required_column|applied|${c[1][1]}`);
  }],
];
// representative plan의 step k마다: apply를 statement 뒤에 멈추고 rollback하고, 다시 멈추고
// recover하고, 적용한 plan의 rollback을 step k의 rollback statement 뒤에 멈추고 rollback을
// 이어 간다.
for (const dialect of ALL) {
  const c = repCounts[dialect];
  const baseRow = `base|applied|${c[0][1]}`;
  for (let k = 0; k < c[1][1]; k++) {
    scenarios.push([`interrupt_${String(k).padStart(2, '0')}`, [dialect], async (session, dialect) => {
      const stop = new Error('stop');
      const name = representative[1].name;
      const connection = session.connection;
      await applyPlans(connection, dialect, representative.slice(0, 1), fixedNow, null);
      await stopped(applyPlans(connection, dialect, representative, fixedNow, stopAfter(name, k, stop)), stop);
      await historyIs(session, dialect, `${baseRow},representative|applying|${k}`);
      assert.equal(await applyCode(applyPlans(connection, dialect, representative, fixedNow, null)), 'interrupted');
      await rollbackPlans(connection, dialect, representative, fixedNow, null);
      await schemaIs(session, dialect, repSource);
      await historyIs(session, dialect, baseRow);
      await stopped(applyPlans(connection, dialect, representative, fixedNow, stopAfter(name, k, stop)), stop);
      await recoverPlans(connection, dialect, representative, fixedNow, null);
      await schemaIs(session, dialect, repTarget);
      await historyIs(session, dialect, `${baseRow},representative|applied|${c[1][1]}`);
      await stopped(rollbackPlans(connection, dialect, representative, fixedNow, stopAfter(name, k, stop)), stop);
      await historyIs(session, dialect, `${baseRow},representative|rolling_back|${k + 1}`);
      await rollbackPlans(connection, dialect, representative, fixedNow, null);
      await schemaIs(session, dialect, repSource);
      await historyIs(session, dialect, baseRow);
    }]);
  }
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
  assert.equal(runs, 25 + ALL.reduce((n, dialect) => n + repCounts[dialect][1][1], 0));
  console.log(`apply runs: ${runs}`);
});
