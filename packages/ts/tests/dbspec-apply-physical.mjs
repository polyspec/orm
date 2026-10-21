// dbspec plan apply on MySQL, PostgreSQL and SQLite (docs/spec/plans.md "Apply"):
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
// Usage: ORM_TEST_MYSQL_SERVER_DSN=... ORM_TEST_POSTGRES_SERVER_DSN=... ORM_TEST_PGBOUNCER_DSN=... node --test packages/ts/tests/dbspec-apply-physical.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mts';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { DbspecApplyError, applyPlans, dbspecManifest, finalizePlans, introspectDbspec, parsePlan, planSteps, recoverPlans, rollbackPlans } from '../dist/dbspec/index.js';

const root = new URL('../../../', import.meta.url);
// TIMEOUT is the deadline (ms) of one case. One apply scenario creates one database, applies, stops, recovers, and rolls back the plan chain, then drops it.
const TIMEOUT = 60000;
// The statements that every client runs on a new connection (packages/go/internal/dialects connectionRules).
const CONNECTION_RULES = {
  mysql: ["SET time_zone = '+00:00'"],
  postgres: ["SET TimeZone = 'UTC'"],
  sqlite: ['PRAGMA foreign_keys = ON'],
};

// The scenario checks the lock and session settings on the server, so it uses the server DSN, not the pooler.
const mysqlDSN = process.env.ORM_TEST_MYSQL_SERVER_DSN;
const postgresDSN = process.env.ORM_TEST_POSTGRES_SERVER_DSN;
if (!mysqlDSN || !postgresDSN) throw new Error('ORM_TEST_MYSQL_SERVER_DSN and ORM_TEST_POSTGRES_SERVER_DSN are required; pass TEST_ENV');

// tool clock: 2026-10-01T00:00:00.123456789Z truncated to microseconds (microseconds since the epoch).
const fixedNow = () => Date.UTC(2026, 9, 1, 0, 0, 0) * 1000 + 123456;

const cases = new Map(JSON.parse(readFileSync(new URL('tests/dbspec/plans.json', root), 'utf8')).cases.map(c => [c.id, c]));
function parse(id, text) {
  const parsed = parsePlan(text);
  assert.deepEqual(parsed.diagnostics, [], `${id} diagnostics`);
  return parsed.plan;
}
// plans is create-from-empty from plans.json and rename-table-and-column, which starts from its target.
const plans = ['create-from-empty', 'rename-table-and-column'].map(id => parse(id, cases.get(id).plan.join('\n') + '\n'));
assert(plans[1].from === plans[0].to, 'plans.json does not chain create-from-empty and rename-table-and-column');
// caseChain is a chain made of the first plan base that creates the case's source, and the case's plan.
function caseChain(id) {
  const c = cases.get(id);
  const base = parse(id, `dbplan 1 base\nfrom empty\n\n${c.source.join('\n')}\n`);
  const plan = parse(id, c.plan.join('\n') + '\n');
  assert.equal(plan.from, base.to, `the source of ${id} does not start its plan`);
  return [base, plan];
}
const schemaText = plan => dbspecManifest([plan.schema]).manifest.schemaText;
// counts is, for each dialect, the chain plan's [number of steps, number of steps before finalize].
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
  caseTest(name, TIMEOUT, body);
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

// session is a connection that runs a statement and reads the first value of a query as text.
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
// The lock name and key of docs/spec/plans.md "Apply".
const MYSQL_APPLY_LOCK = "CONCAT('dbspec$plans$', LEFT(SHA2(DATABASE(), 256), 51))";
const POSTGRES_APPLY_LOCK = "hashtext('dbspec$plans'), hashtext(current_schema())";
// The number of tables and columns whose name starts with dbspec$, excluding history tables.
const HIDDEN_LEFT = {
  mysql: "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE 'dbspec$%' OR COLUMN_NAME LIKE 'dbspec$%') AND TABLE_NAME <> 'dbspec$plans'",
  postgres:
    "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND (c.relname LIKE 'dbspec$%' OR a.attname LIKE 'dbspec$%') AND c.relname <> 'dbspec$plans'",
  sqlite: "SELECT COUNT(*) FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND (m.name LIKE 'dbspec$%' OR p.name LIKE 'dbspec$%') AND m.name <> 'dbspec$plans'",
};

// rowsAre compares every row of the query, as a|b with the row's values joined by commas, against want.
async function rowsAre(session, sql, want) {
  const rows = await session.rows(sql);
  assert.equal(rows.map(r => r.map(v => (v === null ? 'NULL' : String(v))).join('|')).join(','), want, sql);
}
const historyIs = (session, dialect, want) => rowsAre(session, `SELECT name, state, step FROM ${historyTable(dialect)} ORDER BY name`, want);
// stopAfter is an event handler that runs the plan's statement of the given step, then stops the command before the step is recorded.
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
    // applied_at is the tool clock's UTC time, as text truncated to six decimal places.
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
    // While the apply of the first database holds the lock, the same chain is applied to a second database, schema, or file
    // The lock covers only one database, so the second is not locked.
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
    // A chain with no plan applies nothing to a database with no tables.
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
    // If the advisory lock is released first in an event, the unlock at the end of the command releases nothing.
    const release = async event => {
      if (event.kind === 'plan' && event.plan === plans[0].name) await session.exec(`SELECT pg_advisory_unlock(${POSTGRES_APPLY_LOCK})`);
    };
    await assert.rejects(applyPlans(session.connection, dialect, plans, fixedNow, release), {
      message: 'the advisory lock of dbspec$plans was not held at unlock',
    });
  }],
  ['verify_failure', ALL, async (session, dialect) => {
    // If a table outside the plan is created after the last statement, verification fails and the row
    // stays as applying, with all steps recorded.
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
    // Rows written under the applied plan remain after rollback, and the values and defaults of the dropped columns come back,
    // and applying again brings back the values of the added column. A rollback after finalize cannot be undone.
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
    // If a NULL row appears in between in a hidden column with no non-null default, rollback does not change anything
    // and stops with a nulls error that states the number of rows.
    const c = requiredCounts[dialect];
    await applyPlans(session.connection, dialect, required, fixedNow, null);
    await session.exec("INSERT INTO t (a) VALUES ('y')");
    await assert.rejects(rollbackPlans(session.connection, dialect, required, fixedNow, null), error => error instanceof DbspecApplyError && error.code === 'nulls' && error.message.includes('has 1 NULL rows'));
    await schemaIs(session, dialect, requiredTarget);
    await historyIs(session, dialect, `base|applied|${c[0][1]},drop_required_column|applied|${c[1][1]}`);
  }],
];
// For each step k of the representative plan: stop the apply after the statement, roll back, stop again,
// recover, stop the rollback of the applied plan after the rollback statement of step k, and
// continue the rollback.
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

// Requirements: PLN-93, PLN-95, PLN-96.
vector('every apply scenario runs on its dialects', () => {
  assert.equal(runs, expected);
  assert.equal(runs, 25 + ALL.reduce((n, dialect) => n + repCounts[dialect][1][1], 0));
  console.log(`apply runs: ${runs}`);
});

// apply needs one server session that is not shared with other clients from start to end (docs/spec/plans.md
// "Apply"). PgBouncer's transaction pooling picks a server connection again for each statement, so
// apply checks the server session at the lock and at each step, and stops on a session error. Each scenario
// creates its own database on the server and connects to that database through PgBouncer. PgBouncer reuses idle server
// connections in LIFO order (server_round_robin = 0), so the order below is fixed.
const poolerScenarios = {
  // apply takes over a server connection on which another client holds a session advisory lock.
  lock_shared: async (apply, other) => {
    await other.query(`SELECT pg_advisory_lock(${POSTGRES_APPLY_LOCK})`);
    return applyPlans(apply, 'postgres', plans, fixedNow, null);
  },
  // Before the first step, another client takes apply's server connection in a transaction, so apply's
  // next statement runs on a different server connection.
  session_changed: async (apply, other) => {
    let held = false;
    try {
      return await applyPlans(apply, 'postgres', plans, fixedNow, async event => {
        if (event.kind !== 'statement' || held) return;
        held = true;
        await other.query('BEGIN');
        await other.query('SELECT 1');
      });
    } finally {
      if (held) await other.query('ROLLBACK');
    }
  },
};
for (const [name, scenario] of Object.entries(poolerScenarios)) {
  caseTest(`postgres.apply.pooler.${name}`, TIMEOUT, async () => {
    const serverDSN = process.env.ORM_TEST_POSTGRES_SERVER_DSN;
    const poolerDSN = process.env.ORM_TEST_PGBOUNCER_DSN;
    if (!serverDSN || !poolerDSN) throw new Error('ORM_TEST_POSTGRES_SERVER_DSN and ORM_TEST_PGBOUNCER_DSN are required; pass TEST_ENV');
    const database = `orm_case_${process.pid}_pooler_${name}`;
    const admin = new pg.Client({ connectionString: serverDSN });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${database}"`);
      try {
        const url = new URL(poolerDSN);
        url.pathname = `/${database}`;
        const apply = new pg.Client({ connectionString: url.toString() });
        const other = new pg.Client({ connectionString: url.toString() });
        await apply.connect();
        await other.connect();
        try {
          // If the cleanup step has an error (an unlock run on another server connection), the first error of the AggregateError is the failure.
          await assert.rejects(scenario(apply, other), error => {
            const failure = error instanceof AggregateError ? error.errors[0] : error;
            assert(failure instanceof DbspecApplyError, `${error}`);
            assert.equal(failure.code, 'session', `${error}`);
            assert.match(failure.detail, /a direct or session-pooled connection/);
            return true;
          });
        } finally {
          await apply.end();
          await other.end();
        }
      } finally {
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      }
    } finally {
      await admin.end();
    }
  });
}
