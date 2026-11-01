// dbspec rendered statements, physical run (tests/dbspec/ddl.json "behavior" steps): every case with
// behavior steps applies its rendered statements to a fresh MySQL database, PostgreSQL schema and SQLite
// file, then runs the steps of the vector. Requirement: DIA-113 (check-recipes CR16-1).
//
// Usage: ORM_TEST_MYSQL_SERVER_DSN=... ORM_TEST_POSTGRES_SERVER_DSN=... node --test packages/ts/tests/dbspec-render-physical.mjs
// Each DSN is required; the run fails naming the variable that is unset.
import { caseTest } from '../../../tests/testcase.mts';
import { vectorRegistrar } from '../../../tests/vector-registrar.mjs';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDbspecPhysicalDatabase } from './dbspec-physical-database.mjs';

const root = new URL('../../../', import.meta.url);
const ddl = JSON.parse(readFileSync(new URL('tests/dbspec/ddl.json', root), 'utf8'));
// TIMEOUT is the deadline (ms) of one case: one database per dialect, its statements, and its steps.
const TIMEOUT = 60000;
// The statements that every client runs on a new connection (packages/go/internal/dialects connectionRules).
const CONNECTION_RULES = {
  mysql: ["SET time_zone = '+00:00'"],
  postgres: ["SET TimeZone = 'UTC'"],
  sqlite: ['PRAGMA foreign_keys = ON'],
};
const DIALECTS = ['mysql', 'postgres', 'sqlite'];

const mysqlDSN = process.env.ORM_TEST_MYSQL_SERVER_DSN;
const postgresDSN = process.env.ORM_TEST_POSTGRES_SERVER_DSN;
for (const [name, value] of [['ORM_TEST_MYSQL_SERVER_DSN', mysqlDSN], ['ORM_TEST_POSTGRES_SERVER_DSN', postgresDSN]]) {
  if (!value) throw new Error(`${name} is required for the physical run of the rendered statements; pass TEST_ENV`);
}

const sqliteDirectory = mkdtempSync(join(tmpdir(), 'dbspec-render-'));
after(() => rmSync(sqliteDirectory, { recursive: true, force: true }));
const vector = vectorRegistrar(caseTest, TIMEOUT);

// runSteps runs one vector's behavior steps on one dialect; a step with dialects limits it.
async function runSteps(session, dialect, steps) {
  for (const step of steps) {
    if (step.dialects && !step.dialects.includes(dialect)) continue;
    if (step.sql !== undefined) {
      if (step.fails) {
        await assert.rejects(session.exec(step.sql), undefined, `${dialect}: ${step.sql} must fail`);
      } else {
        await session.exec(step.sql);
      }
      continue;
    }
    const rows = await session.rows(step.query);
    assert.equal(String(rows[0][0]), step.want, `${dialect}: ${step.query}`);
  }
}

for (const c of ddl.cases) {
  if (!c.behavior || c.behavior.length === 0) continue;
  vector(c.id, async () => {
    for (const dialect of DIALECTS) {
      await withDbspecPhysicalDatabase({
        dialect,
        name: `render_${c.id.replace(/[^a-z0-9]/gi, '_')}_${process.pid}`,
        mysqlDSN,
        postgresDSN,
        sqliteDirectory,
        body: async session => {
          for (const rule of CONNECTION_RULES[dialect]) await session.exec(rule);
          for (const statement of c.statements[dialect]) await session.exec(statement);
          await runSteps(session, dialect, c.behavior);
        },
      });
    }
  });
}
