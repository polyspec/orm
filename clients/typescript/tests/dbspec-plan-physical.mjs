// dbspec schema plans on MySQL, PostgreSQL and SQLite (docs/plans.md
// "Verification"). Every case of tests/dbspec/plans.json is applied to an
// empty database, schema or file: the source rendered by renderDbspec, the
// before steps and the planSteps steps before finalize (SQLite with foreign
// keys off, then PRAGMA foreign_key_check returns no row), after which
// introspectDbspec reads the plan's target with nothing unsupported; without
// an irreversible step the rollback statements return to the source schema
// text and the steps run again; then the after steps and the finalize steps
// run, the target is read again and no dbspec$ table or column remains.
//
// Usage: ORM_TEST_MYSQL_DSN=... ORM_TEST_POSTGRES_DSN=... node --test clients/typescript/tests/dbspec-plan-physical.mjs (after the build)
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { dbspecManifest, introspectDbspec, parseDbspec, parsePlan, planSteps, renderDbspec } from '../dist/dbspec/index.js';

const root = new URL('../../../', import.meta.url);
const TIMEOUT = 60000;
const DIALECTS = ['mysql', 'postgres', 'sqlite'];
// 모든 client가 새 connection에서 실행하는 문장이다(tests/dialects connectionRules).
const CONNECTION_RULES = {
  mysql: ["SET time_zone = '+00:00'"],
  postgres: ["SET TimeZone = 'UTC'"],
  sqlite: ['PRAGMA foreign_keys = ON'],
};

const mysqlDSN = process.env.ORM_TEST_MYSQL_DSN;
const postgresDSN = process.env.ORM_TEST_POSTGRES_DSN;
if (!mysqlDSN || !postgresDSN) throw new Error('ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV');

const text = lines => lines.join('\n') + '\n';

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
const sqliteDirectory = mkdtempSync(join(tmpdir(), `dbspec-plan-${run}-`));
process.on('exit', () => rmSync(sqliteDirectory, { recursive: true, force: true }));
let probes = 0;

// withDatabase creates an empty database, schema or file named after the
// language, the pid and the probe, gives body a session that executes a
// statement and reads the first value of a query, and drops the database
// and checks that nothing remains.
async function withDatabase(dialect, body) {
  const name = `plan_${run}_${String(probes++).padStart(3, '0')}`;
  switch (dialect) {
    case 'mysql': {
      const admin = await mysql.createConnection(mysqlOptions(undefined));
      try {
        await admin.query(`CREATE DATABASE \`${name}\``);
        try {
          const connection = await mysql.createConnection(mysqlOptions(name));
          try {
            await body({
              connection,
              exec: sql => connection.query(sql),
              value: async sql => (await connection.query({ sql, rowsAsArray: true }))[0],
            });
          } finally {
            await connection.end();
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
          const client = new pg.Client({ connectionString: postgresDSN });
          await client.connect();
          try {
            await client.query('SET client_min_messages = warning');
            await client.query(`SET search_path TO "${name}"`);
            await body({
              connection: client,
              exec: sql => client.query(sql),
              value: async sql => (await client.query({ text: sql, rowMode: 'array' })).rows,
            });
          } finally {
            await client.end();
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
      const db = new DatabaseSync(path);
      try {
        await body({
          connection: db,
          exec: async sql => db.exec(sql),
          value: async sql => {
            const statement = db.prepare(sql);
            statement.setReturnArrays(true);
            return statement.all();
          },
        });
      } finally {
        db.close();
        for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(path + suffix, { force: true });
        assert(!existsSync(path), `${path} remains after cleanup`);
      }
      return;
    }
  }
  throw new Error(`unknown dialect ${dialect}`);
}

// firstValue gives the first column of the first row as text; SQL NULL is NULL.
async function firstValue(session, sql) {
  const rows = await session.value(sql);
  assert(rows.length > 0, `${sql}: no row`);
  const value = rows[0][0];
  return value === null ? 'NULL' : String(value);
}

// runSteps runs the steps of a case that apply to the dialect: a query
// compares its first value, a failing statement must fail, any other
// statement must succeed.
async function runSteps(session, dialect, steps) {
  for (const step of steps) {
    if (step.dialects && !step.dialects.includes(dialect)) continue;
    if (step.query) assert.equal(await firstValue(session, step.query), step.want, step.query);
    else if (step.fails) await assert.rejects(session.exec(step.sql), `${step.sql}: succeeded; want an error`);
    else await session.exec(step.sql);
  }
}

const cases = JSON.parse(readFileSync(new URL('tests/dbspec/plans.json', root), 'utf8')).cases;
assert(cases.length > 0, 'plan cases');
let runs = 0;

for (const c of cases) {
  for (const dialect of DIALECTS) {
    vector(`${dialect}.plan.${c.id}`, async () => {
      const parsed = parsePlan(text(c.plan));
      assert.deepEqual(parsed.diagnostics, [], 'plan diagnostics');
      const target = dbspecManifest([parsed.plan.schema]).manifest.schemaText;
      let source = null;
      let setup = [];
      if (c.source !== null) {
        const document = parseDbspec(text(c.source), {});
        assert.deepEqual(document.diagnostics, [], 'source diagnostics');
        source = document.document;
        const rendered = renderDbspec([source], dialect);
        assert.deepEqual(rendered.diagnostics, [], 'source render diagnostics');
        setup = rendered.statements;
      }
      const planned = planSteps(source, parsed.plan, dialect);
      assert.deepEqual(planned.diagnostics, [], 'plan step diagnostics');
      const steps = planned.steps;
      const reversible = steps.every(s => s.finalize || s.rollback !== '');
      const sourceText = source === null ? '' : dbspecManifest([source]).manifest.schemaText;
      console.log(`${dialect}.plan.${c.id}: ${steps.length} steps, reversible ${reversible}`);
      await withDatabase(dialect, async session => {
        const schemaIs = async (what, want) => {
          const { document, unsupported } = await introspectDbspec(session.connection, dialect, 'introspected');
          assert.deepEqual(unsupported, [], `${what}: unsupported objects`);
          const got = document.tables.length > 0 ? dbspecManifest([document]).manifest.schemaText : '';
          assert.equal(got, want, `${what}: introspected schema text`);
        };
        // forward는 finalize 앞의 step을 실행한다. restore이면 restore statement가 있는 step은
        // 그것을 실행한다(rollback이 숨긴 더한 column이 있다).
        const forward = async restore => {
          for (const s of steps) {
            if (s.finalize) break;
            await session.exec(restore && s.restore !== '' ? s.restore : s.statement);
          }
          if (dialect === 'sqlite') assert.equal(await firstValue(session, 'SELECT COUNT(*) FROM pragma_foreign_key_check'), '0', 'foreign key check');
        };
        for (const sql of [...CONNECTION_RULES[dialect], ...setup]) await session.exec(sql);
        await runSteps(session, dialect, c.before ?? []);
        // SQLite는 table을 다시 만드는 동안 foreign key를 끄고, 끝난 뒤 검사한다.
        if (dialect === 'sqlite') {
          await session.exec('PRAGMA foreign_keys = OFF');
          await session.exec('PRAGMA legacy_alter_table = OFF');
        }
        await forward(false);
        await schemaIs('applied', target);
        if (reversible) {
          // 끝까지 되돌리는 rollback은 옛 table을 숨긴 더한 column과 함께 다시 만든다.
          for (const s of [...steps].reverse()) if (!s.finalize) await session.exec(s.rollbackRestore !== '' ? s.rollbackRestore : s.rollback);
          if (dialect === 'sqlite') assert.equal(await firstValue(session, 'SELECT COUNT(*) FROM pragma_foreign_key_check'), '0', 'foreign key check after rollback');
          await schemaIs('rolled back', sourceText);
          await forward(true);
          await schemaIs('applied again', target);
        }
        if (dialect === 'sqlite') await session.exec('PRAGMA foreign_keys = ON');
        await runSteps(session, dialect, c.after ?? []);
        // finalize도 apply처럼 SQLite foreign key를 끄고 실행한다.
        if (dialect === 'sqlite') await session.exec('PRAGMA foreign_keys = OFF');
        for (const s of steps) if (s.finalize) await session.exec(s.statement);
        if (dialect === 'sqlite') await session.exec('PRAGMA foreign_keys = ON');
        await schemaIs('finalized', target);
        const hidden = {
          mysql: "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE 'dbspec$%' OR COLUMN_NAME LIKE 'dbspec$%')",
          postgres:
            "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND (c.relname LIKE 'dbspec$%' OR a.attname LIKE 'dbspec$%')",
          sqlite: "SELECT COUNT(*) FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND (m.name LIKE 'dbspec$%' OR p.name LIKE 'dbspec$%')",
        }[dialect];
        assert.equal(await firstValue(session, hidden), '0', 'hidden tables and columns after finalize');
      });
      runs++;
    });
  }
}

vector('every plan case runs on every dialect', () => {
  assert.equal(runs, cases.length * DIALECTS.length);
  console.log(`plan runs: ${runs} (${cases.length} cases on ${DIALECTS.length} dialects)`);
});
